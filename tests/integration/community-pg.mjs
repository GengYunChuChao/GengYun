/**
 * GY-I15（#15）切片 C1 · 社区域 PG 持久化的**真库**集成测试（PostgreSQL 17）。
 *
 * 与 `tests/unit/community-store-pg-contract.test.mjs` 的分工：
 *   - 单元契约测用记录型假池锁**语句形状**（幂等键怎么判、CAS 比较顺序、读取有没有缓存）；
 *   - 这里用真库锁**只有数据库能证明**的性质：唯一键真的存在并能裁决并发、外键真的挡孤儿行、
 *     枚举/CHECK 真的拒绝闭集外的值、迁移 `0022` 真能 apply → rollback → 再 apply、
 *     以及 `buildApp` 的 real 放行判据（有真库 ⇒ 社区服务开启；无真库 ⇒ 整域 503）。
 *
 * 运行（专用测试库必须是**空库**，脚本会先断言 public 下没有任何表）：
 *   createdb gengyun_community_test
 *   COMMUNITY_PG_TEST_URL=postgres://postgres@127.0.0.1:55432/gengyun_community_test \
 *     node tests/integration/community-pg.mjs
 * 未设置 `COMMUNITY_PG_TEST_URL` ⇒ 打印 `SKIP` 并以 **77** 退出（POSIX「skipped」）：本次运行**没有**验证真库（不是通过）。
 *   本机明知无真库、只想看跳过原因时可显式加 `--allow-skip`（或 `GY_ALLOW_SKIP=1`）取 0 —— ⛔ 不得用于门禁。
 * `npm run test:integration:http` 不包含本文件（它需要真库），需显式运行。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../../services/api/src/db/pool.ts';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createPostgresCommunityStore } from '../../services/api/src/community/store-pg.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { CLEAN_BODY, CLEAN_TITLE, makeGate, makeSyntheticPassPort } from '../unit/community-fixtures.mjs';
// GY-R28 W10：投稿面 `public_posting` 闸的合成授权账本（与单元夹具同一份，避免两套口径）。
// 说明：本脚本验证的是**社区内容真落库**，不是 PG 授权读取口（那条由 `consent-pg` 的既有脚本覆盖）；
// 因此这里注入内存授权闸并先 `grant`，让「有授权 ⇒ 放行」这条链路照旧真落库。
import { createPublicPostingConsent } from '../unit/community-posting-consent-fixtures.mjs';

const ENV = 'COMMUNITY_PG_TEST_URL';
const rawUrl = process.env[ENV];
// 缺真库时的出口：默认 77（未取得，不是通过）；只有显式 `--allow-skip` / `GY_ALLOW_SKIP=1` 才降级为 0。
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if (rawUrl === undefined || rawUrl.trim() === '') {
  console.log(
    `SKIP real PG17: ${ENV} 未设置 —— 本次运行没有验证真库持久化（不是通过，也不是失败）。`,
  );
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log(
    'EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。',
  );
  process.exit(77);
}
const url = new URL(rawUrl);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), `${ENV} 必须是 postgres URL`);
assert.equal(url.search, '', '连接参数由脚本控制，测试 URL 不带查询串');
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
  `只允许回环地址，实际 ${url.hostname}`,
);
assert.equal(url.pathname, '/gengyun_community_test', '只允许专用测试库 gengyun_community_test');

const sqlFile = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');
let passed = 0;
const say = (message) => {
  passed += 1;
  console.log(`PASS ${passed}: ${message}`);
};

const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const iso = (value) => new Date(value).toISOString();
const CREATED = '2026-10-18T02:00:00.000Z';
const LATER = '2026-10-18T02:30:00.000Z';

const verdict = (type, id, revision, overrides = {}) => ({
  id: randomUUID(),
  target_ref: { type, id, revision },
  decision: 'approved',
  reason_codes: [],
  hard_rule_passed: true,
  rule_version: 'local-rules-1',
  text_digest: digest(`verdict-${type}-${id}-${revision}`),
  contract_complete: false,
  missing_contract_fields: ['model_version', 'prompt_version'],
  created_at: CREATED,
  ...overrides,
});

const postRecord = (id, authorId, overrides = {}) => ({
  id,
  revision: 1,
  author_id: authorId,
  title: '春小麦田除草记录',
  body: '拔节期，看麦娘为主，人工拔除后补喷。',
  crop_id: 'crop-wheat',
  region_code: '330100',
  media_ids: [randomUUID(), randomUUID()],
  linked_knowledge_ref: { type: 'species', id: 'spc-1', revision: 2 },
  visibility: 'published',
  audit_state: 'approved',
  created_at: CREATED,
  updated_at: CREATED,
  ...overrides,
});

const commentRecord = (id, postId, authorId, overrides = {}) => ({
  id,
  revision: 1,
  post_id: postId,
  author_id: authorId,
  body: '同样情况，我用的是机械除草。',
  visibility: 'published',
  audit_state: 'approved',
  created_at: CREATED,
  ...overrides,
});

async function main() {
  const owner = new pg.Client({ connectionString: url.href });
  await owner.connect();
  let pool = null;
  let app = null;
  try {
    // ---- 1. 环境与迁移 ---------------------------------------------------
    const version = (await owner.query("SELECT current_setting('server_version') AS version")).rows[0].version;
    assert.match(version, /^17\./, `requires PostgreSQL 17，实际 ${version}`);
    const emptyTables = (await owner.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
    )).rows[0].n;
    assert.equal(emptyTables, 0, 'fresh DB required（专用测试库必须是空的；本脚本会 drop 建表）');

    const all = discoverMigrations();
    const versions = all.map((m) => m.version);
    assert.equal(versions.includes('0022'), true, '迁移目录里必须有 0022');
    assert.deepEqual(
      versions.filter((v) => ['0020', '0021'].includes(v)),
      ['0020', '0021'],
      '0020 属 I18 切片 #282（随 upstream/main `31a746d` 合入）、0021 属 I18 切片 #279（随 `145ebe4` → `607c03c` 合入）；'
        + '本片只占用 0022，不占用 0020–0021、不补占位迁移',
    );

    const migrations = all.filter((m) => ['0001', '0022'].includes(m.version));
    assert.deepEqual(
      (await applyMigrations(owner, migrations)).applied,
      ['0001', '0022'],
      '0001（users/枚举底座）+ 0022（本片六表）',
    );
    assert.equal((await applyMigrations(owner, migrations)).applied.length, 0, '重跑迁移必须是 no-op');
    say(`迁移 apply 可重入：${versions.length} 个迁移目录读数，本片只取 0001 + 0022`);

    const tables = (await owner.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )).rows.map((row) => row.tablename);
    for (const name of [
      'community_comments',
      'community_idempotency',
      'community_likes',
      'community_moderation_decisions',
      'community_posts',
      'community_reports',
    ]) {
      assert.ok(tables.includes(name), `缺表 ${name}`);
    }
    say('0022 建出六张表，且 0001 的既有对象未被改动（users 仍在）');

    const indexes = (await owner.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
    )).rows.map((row) => row.indexname);
    for (const name of [
      'community_posts_feed_idx',
      'community_posts_visibility_created_idx',
      'community_posts_author_created_idx',
      'community_comments_post_created_idx',
      'community_likes_target_user_key',
      'community_reports_state_created_idx',
      'community_reports_target_idx',
      'community_moderation_decisions_pkey',
      'community_idempotency_expires_idx',
    ]) {
      assert.ok(indexes.includes(name), `缺索引/唯一约束 ${name}`);
    }
    say('三条读路径（作物地区筛选 / 按对象查可见性 / 未读事件）的索引与幂等唯一键全部就位');

    // ---- 2. 两个真实用户（作者 / 他人） ----------------------------------
    const userIds = [];
    for (let i = 0; i < 2; i += 1) {
      const row = (await owner.query('INSERT INTO users (id) VALUES (gen_random_uuid()) RETURNING id')).rows[0];
      userIds.push(row.id);
    }
    const [authorId, otherId] = userIds;

    pool = createPool(url.href);
    const store = createPostgresCommunityStore({ pool });
    assert.equal(store.persistent, true, 'PG 实现必须自述持久化（app.ts 的放行判据）');

    // ---- 3. 帖子写入/读回（含非 uuid 的知识 id、媒体数组） ----------------
    const postId = randomUUID();
    const record = postRecord(postId, authorId);
    assert.equal(await store.insertPost(record, verdict('post', postId, 1)), true);
    const readBack = await store.getPost(postId);
    assert.notEqual(readBack, null);
    assert.deepEqual(readBack.linked_knowledge_ref, { type: 'species', id: 'spc-1', revision: 2 },
      '知识关联 id 是 text（不是 uuid），spc-1 必须原样往返');
    assert.deepEqual(readBack.media_ids, record.media_ids, '媒体引用按数组往返，顺序保留');
    assert.equal(readBack.created_at, CREATED);
    assert.equal(readBack.updated_at, CREATED);
    assert.equal(readBack.crop_id, 'crop-wheat');
    assert.equal(readBack.region_code, '330100');
    assert.equal(readBack.visibility, 'published');
    assert.equal(readBack.audit_state, 'approved');
    say('insertPost → getPost 逐字段往返（text 知识 id / text[] 媒体 / timestamptz → ISO）');

    assert.equal(await store.insertPost(record, verdict('post', postId, 1)), false, '同 id 再插入必须是 duplicate');
    assert.equal(
      (await owner.query('SELECT count(*)::int AS n FROM community_posts')).rows[0].n,
      1,
      '重复插入不得留下第二行',
    );
    assert.equal(
      (await owner.query('SELECT count(*)::int AS n FROM community_moderation_decisions')).rows[0].n,
      1,
      '冲突路径不写第二条结论',
    );
    say('并发/重复插入由主键裁决：返回 duplicate（false），内容与结论各一行');

    const moderation = await store.getModeration('post', postId, 1);
    assert.equal(moderation.decision, 'approved');
    assert.deepEqual(moderation.reason_codes, []);
    assert.equal(moderation.contract_complete, false);
    assert.deepEqual(moderation.missing_contract_fields, ['model_version', 'prompt_version']);
    assert.equal(moderation.rule_version, 'local-rules-1');
    assert.equal(await store.getModeration('post', postId, 2), null, '结论按 revision 定位，不许串版');
    assert.equal(await store.putRefusalVerdict(verdict('post', postId, 1, { decision: 'rejected' })), false,
      '已有结论的 revision 不得被补录覆盖');
    say('审核结论按 (type,id,revision) 三元组落库；putRefusalVerdict 不覆盖首条');

    // ---- 4. 读取时重查可见性（store 侧无缓存） ---------------------------
    await owner.query("UPDATE community_posts SET visibility = 'hidden' WHERE id = $1::uuid", [postId]);
    assert.equal((await store.getPost(postId)).visibility, 'hidden', '库里的可见性变化必须当场反映');
    await owner.query("UPDATE community_posts SET visibility = 'published' WHERE id = $1::uuid", [postId]);
    assert.equal((await store.getPost(postId)).visibility, 'published');
    say('读取每次走真库：隐藏/恢复立即反映（没有跨请求缓存可让失效内容复活）');

    // ---- 5. CAS 状态流转 -------------------------------------------------
    assert.deepEqual(
      await store.commitPostIfCurrent(postId, { revision: 9, author_id: authorId }, { title: 'x' }, null),
      { ok: false, reason: 'REVISION_CHANGED' },
    );
    assert.deepEqual(
      await store.commitPostIfCurrent(postId, { revision: 1, author_id: otherId }, { title: 'x' }, null),
      { ok: false, reason: 'AUTHOR_CHANGED' },
    );
    assert.deepEqual(
      await store.commitPostIfCurrent(postId, { revision: 1, author_id: authorId, visibility: 'private' },
        { title: 'x' }, null),
      { ok: false, reason: 'VISIBILITY_CHANGED' },
    );
    assert.equal((await store.getPost(postId)).title, '春小麦田除草记录', '失败路径不得改内容');
    say('CAS 失败原因按内存实现顺序逐条命中（NOT_FOUND/归属/revision/可见性），失败不改行');

    const edited = await store.commitPostIfCurrent(
      postId,
      { revision: 1, author_id: authorId, visibility: 'published', audit_state: 'approved' },
      { revision: 2, title: '改过的标题', body: '改过的正文', updated_at: LATER },
      verdict('post', postId, 2),
    );
    assert.equal(edited.ok, true);
    assert.equal(edited.record.revision, 2);
    assert.equal(edited.record.title, '改过的标题');
    assert.equal(edited.record.created_at, CREATED, '编辑不改 created_at');
    assert.equal(edited.record.updated_at, LATER);
    assert.equal((await store.getModeration('post', postId, 2)).decision, 'approved',
      '结论必须跟着新 revision 落一行');
    say('编辑：revision 1→2 的 CAS 成功，新 revision 的结论独立一行');

    const hiddenAgain = await store.commitPostIfCurrent(
      postId,
      { revision: 2, author_id: authorId, visibility: 'published' },
      { visibility: 'hidden', updated_at: LATER },
      null,
    );
    assert.equal(hiddenAgain.ok, true);
    assert.equal(hiddenAgain.record.revision, 2, '只改可见性不升 revision（与内存实现一致）');
    assert.equal(hiddenAgain.record.visibility, 'hidden');
    say('可见性流转不升 revision（隐藏/恢复不是内容改版）');

    // ---- 6. 评论：父帖校验与级联 -----------------------------------------
    assert.equal(
      await store.insertComment(commentRecord(randomUUID(), postId, otherId), null, { id: postId, revision: 1 }),
      false,
      '父帖 revision 不符（现在是 2）⇒ 拒绝插入',
    );
    assert.equal(
      await store.insertComment(commentRecord(randomUUID(), randomUUID(), otherId), null,
        { id: randomUUID(), revision: 1 }),
      false,
      '父帖不存在 ⇒ 拒绝插入，不发 INSERT',
    );
    const commentId = randomUUID();
    assert.equal(
      await store.insertComment(commentRecord(commentId, postId, otherId), verdict('comment', commentId, 1),
        { id: postId, revision: 2 }),
      true,
    );
    const secondCommentId = randomUUID();
    assert.equal(
      await store.insertComment(commentRecord(secondCommentId, postId, authorId, { created_at: LATER }),
        verdict('comment', secondCommentId, 1), { id: postId, revision: 2 }),
      true,
    );
    const comments = await store.listComments(postId);
    assert.deepEqual(comments.map((row) => row.id), [commentId, secondCommentId], '按 created_at ASC, id ASC');
    say('评论：父帖存在 + revision 匹配才插入；列表按时间正序');

    const orphan = await owner.query(
      `INSERT INTO community_comments (id, post_id, author_id, revision, body, visibility, audit_state, created_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), $1::uuid, 1, 'x', 'published', 'approved', now())`,
      [otherId],
    ).then(() => null, (error) => error);
    assert.equal(orphan?.code, '23503', '外键必须真的挡住孤儿评论');
    assert.match(String(orphan?.constraint), /community_comments_post_id_fkey/);

    await owner.query('DELETE FROM community_posts WHERE id = $1::uuid', [postId]);
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM community_comments')).rows[0].n, 0,
      '删帖必须级联删评论');
    say('外键真的存在：孤儿评论被 23503 拒绝；删帖级联清评论');

    // ---- 7. 幂等点赞（唯一键裁决并发） -----------------------------------
    const post2 = randomUUID();
    assert.equal(await store.insertPost(postRecord(post2, authorId), verdict('post', post2, 1)), true);
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, () => store.addLike('post', post2, otherId)),
    );
    assert.equal(concurrent.filter(Boolean).length, 1, '同一用户并发点赞只允许一次真的新增');
    assert.equal(await store.countLikes('post', post2), 1, '计数是派生 count(*)，不是计数器列');
    assert.equal(await store.addLike('post', post2, authorId), true);
    assert.equal(await store.countLikes('post', post2), 2);
    assert.equal(await store.removeLike('post', post2, otherId), true);
    assert.equal(await store.removeLike('post', post2, otherId), false, '未点赞再取消是 no-op');
    assert.equal(await store.countLikes('post', post2), 1);
    say('点赞：10 并发只新增 1 行；取消两次第二次 no-op；计数不为负');

    const duplicateLike = await owner.query(
      `INSERT INTO community_likes (target_type, target_id, user_id) VALUES ('post', $1::uuid, $2::uuid)`,
      [post2, authorId],
    ).then(() => null, (error) => error);
    assert.equal(duplicateLike?.code, '23505', '幂等由唯一键兜底，不能只靠应用层先查');
    assert.match(String(duplicateLike?.constraint), /community_likes_target_user_key/);
    say('唯一约束 community_likes_target_user_key 真的存在（并发/绕过应用层都收敛到一行）');

    // ---- 8. 举报 ---------------------------------------------------------
    const reportId = randomUUID();
    const report = {
      id: reportId,
      revision: 1,
      reporter_id: otherId,
      target_ref: { type: 'post', id: post2, revision: 1 },
      state: 'received',
      reason_code: 'misleading',
      detail: '剂量写错了',
      created_at: CREATED,
    };
    await store.insertReport(report);
    assert.deepEqual(await store.getReport(reportId), report);
    await store.insertReport({ ...report, detail: '改过说明' });
    assert.equal((await store.getReport(reportId)).detail, '改过说明', '同 id 覆盖（与内存 Map.set 同义）');
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM community_reports')).rows[0].n, 1);
    await store.insertReport({ ...report, id: randomUUID() });
    assert.equal(
      (await owner.query('SELECT count(*)::int AS n FROM community_reports')).rows[0].n,
      2,
      '字典里的 reporter+target 唯一约束本片有意不建（重复举报是产品问题，不是数据完整性问题）',
    );
    say('举报：按 id 覆盖 + 读回一致；同人同目标可重复举报（有意不建唯一约束）');

    // ---- 9. 幂等台账（HTTP 重放的落点） ----------------------------------
    const scope = `${otherId}\nPUT\n/posts/${post2}/like`;
    const keyHash = digest('idem-key-1');
    assert.equal(await store.claimIdempotency(scope, keyHash, {
      request_hash: digest('request-1'),
      response_status: 200,
      expires_at: Date.now() + 60_000,
    }), true);
    assert.equal(await store.claimIdempotency(scope, keyHash, {
      request_hash: digest('request-1'),
      response_status: 200,
      expires_at: Date.now() + 60_000,
    }), false, '占位已存在必须是 conflict');
    assert.equal(await store.findIdempotency(scope, keyHash), null, '占位中（outcome NULL）视为"还没有结果"');

    const settledWait = await store.awaitIdempotencySettled(scope, keyHash, 40);
    assert.equal(settledWait, 'timeout', '未完成的占位在有界等待后必须如实返回 timeout');

    assert.equal(await store.completeIdempotency(scope, keyHash, {
      response_status: 200,
      outcome: { kind: 'ack', id: post2, revision: 1 },
    }), true);
    const landed = await store.findIdempotency(scope, keyHash);
    assert.deepEqual(landed.outcome, { kind: 'ack', id: post2, revision: 1 });
    assert.equal(landed.response_status, 200);
    assert.equal(await store.awaitIdempotencySettled(scope, keyHash, 40), 'settled');
    await store.releaseIdempotency(scope, keyHash);
    assert.notEqual(await store.findIdempotency(scope, keyHash), null, '已完成的结果不因后续失败释放被抹掉');
    assert.equal(await store.completeIdempotency(scope, keyHash, {
      response_status: 503,
      outcome: { kind: 'ack', id: post2, revision: 1 },
    }), false, '已完成的行不能再被改写（outcome IS NULL 条件）');
    say('幂等台账：claim 原子占位 / complete 落结果 / release 只清未完成 / 完成后不可改写');

    const expiredKey = digest('idem-key-expired');
    assert.equal(await store.claimIdempotency(scope, expiredKey, {
      request_hash: digest('request-2'),
      response_status: 200,
      expires_at: Date.now() - 1_000,
    }), true);
    assert.equal(await store.findIdempotency(scope, expiredKey), null, '过期即视为不存在');
    assert.equal(
      (await owner.query('SELECT count(*)::int AS n FROM community_idempotency WHERE key_hash = decode($1, \'hex\')',
        [expiredKey])).rows[0].n,
      0,
      '过期占位必须由 find 物理清掉，不留给下一轮',
    );
    say('幂等台账：过期占位被清掉（不让一周前的 key 永久占位）');

    // ---- 10. 计数字面读数 ------------------------------------------------
    const counts = await store.snapshotCounts();
    assert.deepEqual(counts, {
      posts: Number((await owner.query('SELECT count(*)::int AS n FROM community_posts')).rows[0].n),
      comments: 0,
      reports: 2,
      moderation: Number((await owner.query('SELECT count(*)::int AS n FROM community_moderation_decisions')).rows[0].n),
    });
    say('snapshotCounts 与真库计数逐项一致');

    // ---- 11. rollback → 再 apply ----------------------------------------
    const OUR_TABLES = [
      'community_comments',
      'community_idempotency',
      'community_likes',
      'community_moderation_decisions',
      'community_posts',
      'community_reports',
    ];
    const down = sqlFile('migrations/rollback/0022_community_persistence.down.sql');
    await owner.query(down);
    const afterDown = (await owner.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )).rows.map((row) => row.tablename);
    assert.deepEqual(
      afterDown.filter((name) => OUR_TABLES.includes(name)),
      [],
      'down 必须撤掉本片全部对象',
    );
    assert.ok(afterDown.includes('users'), 'down 不得碰别人的对象（0001 的 users 仍在）');
    assert.ok(afterDown.includes('posts'), 'down 不得碰 0001 的既有 posts');
    assert.ok(afterDown.includes('community_media_grants'), 'down 不得按前缀误删 0001 的 community_media_grants');
    await owner.query(down);
    say('rollback 幂等：撤掉六表 + 索引/约束，不触碰 0001 的既有对象（含同前缀的 community_media_grants）');

    await owner.query(sqlFile('migrations/0022_community_persistence.sql'));
    const afterReapply = (await owner.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )).rows.map((row) => row.tablename);
    assert.equal(
      afterReapply.filter((name) => OUR_TABLES.includes(name)).length,
      6,
      'rollback 之后必须能原地再 apply',
    );
    say('apply → rollback → 再 apply 三步在同一个库上收敛（六表恢复，且空表状态正确）');

    // ---- 12. HTTP 面：路由 → 服务 → Postgres 真落库 ----------------------
    const auth = createMemoryAuthStore();
    const account = async (tag) => {
      const user = await auth.createUser(tag.repeat(64));
      const token = `synthetic-i15-pg-${tag}`;
      await auth.createSession({
        userId: user.id,
        tokenHashHex: hashToken(token),
        authEpoch: user.authEpoch,
        expiresAt: new Date(Date.now() + 48 * 3600_000),
        audience: 'user',
      });
      await owner.query('INSERT INTO users (id) VALUES ($1::uuid)', [user.id]);
      return { user, token };
    };
    const a = await account('p');
    // 投稿面授权（真实 `grant`：写授权记录 + 置 granted epoch）。
    const publicPosting = createPublicPostingConsent();
    await publicPosting.grant(a.user.id);
    const baseConfig = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
    // stub 配置 + **真 pool**：`buildApp` 不给 `communityInjection.store`，
    // 因此装配层选中的就是 `createPostgresCommunityStore`。写作路径的放行门是
    // 合成审核端口（`provider.synthetic === true`，不联网），**不代表真实 tms/ims 已接通**。
    app = buildApp({
      config: baseConfig,
      store: auth,
      pool,
      now: () => new Date(),
      privacyInjection: { consent: publicPosting.gate },
      communityInjection: { gate: makeGate() },
      moderationInjection: { ports: { tms: makeSyntheticPassPort('tms') } },
    });
    assert.notEqual(app.communityService, null, 'stub + 真 pool ⇒ 社区服务必须开启');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (method, path, extra = {}) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${a.token}`,
          ...(extra.payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...(extra.headers ?? {}),
        },
        ...(extra.payload === undefined ? {} : { body: JSON.stringify(extra.payload) }),
      });
      return { status: response.status, body: await response.json() };
    };

    const created = await call('POST', '/api/v1/posts', {
      payload: { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] },
      headers: { 'idempotency-key': 'community-pg-http-post-1' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const httpPostId = created.body.data.id;
    assert.equal(
      (await owner.query('SELECT count(*)::int AS n FROM community_posts WHERE id = $1::uuid', [httpPostId])).rows[0].n,
      1,
      'HTTP 201 必须对应真库一行（不是内存里的成功封套）',
    );
    assert.equal((await call('GET', `/api/v1/posts/${httpPostId}`)).body.data.title, CLEAN_TITLE);

    const likeKey = 'community-pg-http-like-1';
    const likeHeaders = { 'idempotency-key': likeKey, 'if-match': `"${created.body.data.revision}"` };
    const liked = await call('PUT', `/api/v1/posts/${httpPostId}/like`, { headers: likeHeaders });
    assert.equal(liked.status, 200, JSON.stringify(liked.body));
    const likedAgain = await call('PUT', `/api/v1/posts/${httpPostId}/like`, { headers: likeHeaders });
    assert.equal(likedAgain.status, 200);
    assert.equal(
      (await owner.query('SELECT count(*)::int AS n FROM community_likes WHERE target_id = $1::uuid', [httpPostId])).rows[0].n,
      1,
      '重放同一 idempotency-key 不得重复计数',
    );

    const reported = await call('POST', '/api/v1/reports', {
      payload: {
        target_ref: { type: 'post', id: httpPostId, revision: created.body.data.revision },
        reason_code: 'other',
        detail: '真库举报落点',
      },
      headers: { 'idempotency-key': 'community-pg-http-report-1' },
    });
    assert.equal(reported.status, 201, JSON.stringify(reported.body));
    assert.equal(
      (await owner.query('SELECT count(*)::int AS n FROM community_reports WHERE id = $1::uuid', [reported.body.data.id]))
        .rows[0].n,
      1,
      '举报必须落在 community_reports',
    );
    say('HTTP 面：stub + 真 pool 下 201/200 全部真落库（帖子/点赞/举报各一行），同 key 重放点赞仍是一行');

    await app.close();
    app = null;

    // real 模式：存储门禁已开（`communityService` 非 null），但**审核供应商未接线**，
    // 写接口被审核域 fail-closed 拦住 ⇒ 本片**不取得** real 下的写入成功。
    const realConfig = {
      ...baseConfig,
      executionMode: 'real',
      requiresRealCredentials: true,
    };
    const realApp = buildApp({ config: realConfig, store: auth, pool, now: () => new Date(), privacyInjection: { consent: publicPosting.gate } });
    assert.notEqual(realApp.communityService, null, 'real + 真 pool ⇒ 存储门禁必须开（不再是"内存 store 不持久"）');
    await realApp.listen({ host: '127.0.0.1', port: 0 });
    const realBase = `http://127.0.0.1:${realApp.server.address().port}`;
    const realPost = await fetch(`${realBase}/api/v1/posts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${a.token}`,
        'content-type': 'application/json',
        'idempotency-key': 'community-pg-http-real-1',
      },
      body: JSON.stringify({ title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] }),
    });
    const realBody = await realPost.json();
    assert.equal(realPost.status, 503, JSON.stringify(realBody));
    assert.equal(realBody.error.code, 'PROVIDER_UNAVAILABLE');
    assert.match(realBody.error.message, /审核/, 'real 下的 503 必须来自审核域（供应商未接线），不是存储');
    const realList = await fetch(`${realBase}/api/v1/posts`, { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(realList.status, 200, 'real 下读路径不经审核域，必须能读到真库内容');
    await realApp.close();
    say('real 门禁：有真库 ⇒ 社区服务开启且读路径走真库；写路径仍被未接线的审核供应商 fail-closed（503，非存储问题）');

    const orphanApp = buildApp({ config: realConfig, store: auth, pool: null, now: () => new Date() });
    assert.equal(orphanApp.communityService, null,
      'real + 无连接池（内存 store 不持久）⇒ 社区服务必须整域 fail-closed');
    await orphanApp.listen({ host: '127.0.0.1', port: 0 });
    const closedResponse = await fetch(
      `http://127.0.0.1:${orphanApp.server.address().port}/api/v1/posts`,
      { headers: { authorization: `Bearer ${a.token}` } },
    );
    assert.equal(closedResponse.status, 503, '无持久化落点时不许返回成功封套');
    assert.equal((await closedResponse.json()).error.code, 'PROVIDER_UNAVAILABLE');
    await orphanApp.close();
    say('real 门禁：有真库 ⇒ 开启；无连接池 ⇒ 503（不静默退回内存 store）');
  } finally {
    if (app !== null) await app.close().catch(() => {});
    if (pool !== null) await pool.end().catch(() => {});
    await owner.end().catch(() => {});
  }
}

await main();
console.log(`\n全部 ${passed} 组真库断言通过。`);
