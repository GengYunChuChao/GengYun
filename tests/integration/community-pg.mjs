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
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createPostgresMessagesStore } from '../../services/api/src/messages/store-pg.ts';
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

    const migrations = all.filter((m) => ['0001', '0019', '0022', '0028', '0030'].includes(m.version));
    assert.deepEqual(
      (await applyMigrations(owner, migrations)).applied,
      ['0001', '0019', '0022', '0028', '0030'],
      '0001（users/枚举底座）+ 0019（messages：GY-I18 admin 臂要证明"下架后消息跳转目标由 available 变 unavailable"，'
        + '该判据经消息域读取时重查，因此需要真消息表）+ 0022（本片六表）+ 0028（审核判定台账：装配层有池即注入，发布闸门会落库）'
        + ' + 0030（F13 行级作者注销引用：author_id 可空 + anonymized_author_ref）',
    );
    assert.equal((await applyMigrations(owner, migrations)).applied.length, 0, '重跑迁移必须是 no-op');
    say(`迁移 apply 可重入：${versions.length} 个迁移目录读数，本片只取 0001 + 0019 + 0022 + 0028 + 0030`);

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

    // ---- 1b. 迁移 0030（F13 行级作者注销引用）的真库结构契约 ----------------
    // 这是**只有真库能证明**的部分：两条 CHECK 的判定权在数据库，不在 JS。
    for (const table of ['community_posts', 'community_comments']) {
      const columns = (await owner.query(
        `SELECT column_name, is_nullable, data_type, character_maximum_length
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
            AND column_name IN ('author_id', 'anonymized_author_ref')
          ORDER BY column_name`,
        [table],
      )).rows;
      assert.deepEqual(
        columns.map((column) => column.column_name),
        ['anonymized_author_ref', 'author_id'],
        `${table} 必须同时有 0030 的两列`,
      );
      const [ref, author] = columns;
      assert.equal(author.is_nullable, 'YES', `${table}.author_id 必须可空（0030 的 DROP NOT NULL）`);
      assert.equal(author.data_type, 'uuid', `${table}.author_id 类型不变（⛔ 不改成 text 塞引用）`);
      assert.equal(ref.data_type, 'character varying');
      assert.equal(Number(ref.character_maximum_length), 40, `${table}.anonymized_author_ref 必须是 varchar(40)`);
    }

    const anonUser = (await owner.query('INSERT INTO users (id) VALUES (gen_random_uuid()) RETURNING id')).rows[0].id;
    const anonPost = randomUUID();
    const insertAnon = (ref) => owner.query(
      `INSERT INTO community_posts
         (id, author_id, anonymized_author_ref, revision, title, body, visibility, audit_state, created_at, updated_at)
       VALUES ($1, NULL, $2, 1, '标题', '正文', 'published', 'approved', now(), now())`,
      [anonPost, ref],
    );
    await assert.rejects(
      () => owner.query(
        `INSERT INTO community_posts (id, revision, title, body, visibility, audit_state, created_at, updated_at)
         VALUES ($1, 1, '标题', '正文', 'published', 'approved', now(), now())`,
        [randomUUID()],
      ),
      /community_posts_author_exactly_one|check constraint/i,
      '两列同空（无主行）必须被 exactly_one 拒绝（真库）',
    );
    await assert.rejects(
      () => owner.query(
        `INSERT INTO community_posts
           (id, author_id, anonymized_author_ref, revision, title, body, visibility, audit_state, created_at, updated_at)
         VALUES ($1, $2, $3, 1, '标题', '正文', 'published', 'approved', now(), now())`,
        [randomUUID(), anonUser, 'gy-anon-0123456789abcdef'],
      ),
      /community_posts_author_exactly_one|check constraint/i,
      '两列同非空（双重作者）必须被 exactly_one 拒绝（真库）',
    );
    await assert.rejects(
      () => insertAnon('gy-anon-0123456789ABCDEF'),
      /anon_ref_shape|check constraint/i,
      '大写 hex 必须被形状 CHECK 拒绝（真库）',
    );
    await assert.rejects(
      () => insertAnon('gy-anon-0123'),
      /anon_ref_shape|check constraint/i,
      '位数不足必须被形状 CHECK 拒绝（真库）',
    );
    await insertAnon('gy-anon-0123456789abcdef');
    assert.equal(
      (await owner.query(
        'SELECT author_id FROM community_posts WHERE id = $1::uuid',
        [anonPost],
      )).rows[0].author_id,
      null,
      '合法引用必须可插入（否则上面的负例可能只是"所有插入都失败"的假红）',
    );
    // 级联豁免：匿名行 author_id=NULL ⇒ DELETE FROM users 不再级联删掉应保留的内容。
    await owner.query('DELETE FROM users WHERE id = $1::uuid', [anonUser]);
    assert.equal(
      (await owner.query('SELECT count(*)::int AS n FROM community_posts WHERE id = $1::uuid', [anonPost])).rows[0].n,
      1,
      '已匿名行必须在 DELETE FROM users 之后仍然存活（F13「删除账号映射」的结构后果）',
    );
    await owner.query('DELETE FROM community_posts WHERE id = $1::uuid', [anonPost]);
    say('迁移 0030 真库契约：author_id 可空 + 引用 varchar(40)；同空/同非空与形状非法全被 CHECK 拒绝；匿名行不被 users 级联删除');

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

    // ---- 10b. 举报状态推进（R31-S1 的 PG 臂） ----------------------------
    // 语义对齐 `commitPostIfCurrent`：先版本、再状态；三种失败都不许改行。
    assert.deepEqual(
      await store.commitReportIfCurrent(reportId, { revision: 9 }, { revision: 2 }),
      { ok: false, reason: 'REVISION_CHANGED' },
      '版本不符必须是 REVISION_CHANGED（不能静默成功）',
    );
    assert.deepEqual(
      await store.commitReportIfCurrent(
        reportId,
        { revision: 1, state: 'isolated' },
        { revision: 2, state: 'closed' },
      ),
      { ok: false, reason: 'STATE_CHANGED' },
      '状态与预期不符必须是 STATE_CHANGED（路线分叉，重读也没用）',
    );
    assert.deepEqual(
      await store.commitReportIfCurrent(randomUUID(), { revision: 1 }, { revision: 2 }),
      { ok: false, reason: 'NOT_FOUND' },
    );
    assert.deepEqual(
      (await owner.query(
        'SELECT state, revision FROM community_reports WHERE id = $1::uuid',
        [reportId],
      )).rows[0],
      { state: 'received', revision: 1 },
      '失败路径不得改状态、不得升版本',
    );
    const advanced = await store.commitReportIfCurrent(
      reportId,
      { revision: 1, state: 'received' },
      { revision: 2, state: 'isolated' },
    );
    assert.equal(advanced.ok, true);
    assert.equal(advanced.record.state, 'isolated');
    assert.equal(advanced.record.revision, 2);
    assert.equal(advanced.record.detail, '改过说明', '推进状态不得顺手清掉举报人自述');
    assert.deepEqual(
      (await owner.query(
        'SELECT state, revision FROM community_reports WHERE id = $1::uuid',
        [reportId],
      )).rows[0],
      { state: 'isolated', revision: 2 },
      '状态与版本必须真落库（不是只改了返回值）',
    );
    say('举报状态推进：版本/状态/存在性三种失败逐条报因且不改行；成功后 state+revision 真落库');

    // ---- 10c. 注销清理（R31-S6 / F13 保留规则的 PG 臂） ---------------------
    // 先给 authorId 造一条自己的幂等台账行，再把他人名下的既有台账行数记成对比组。
    const authorScope = `${authorId}\nPOST\n/api/v1/reports`;
    const authorKeyHash = digest('community-pg-purge-key-1');
    assert.equal(await store.claimIdempotency(authorScope, authorKeyHash, {
      request_hash: digest('purge-request-1'),
      response_status: 201,
      expires_at: Date.now() + 60_000,
    }), true);
    const otherIdempotencyBefore = (await owner.query(
      'SELECT count(*)::int AS n FROM community_idempotency WHERE scope LIKE $1::text',
      [`${otherId}\n%`],
    )).rows[0].n;
    assert.ok(otherIdempotencyBefore >= 1, '对比组：他人名下必须有既有台账行');

    // 存量 PII 行（规则层现在会拦手机号，这里模拟"审核当时未拦住/规则外形态"的旧行）：
    // 注销必须清个人信息、不能把整条帖子删掉。
    const piiPost = randomUUID();
    const PII_BODY = '联系 13800138000，邮箱 nongyou@example.com，住址 阳光小区3栋2单元501室。';
    assert.equal(
      await store.insertPost(
        postRecord(piiPost, authorId, { body: PII_BODY, media_ids: [randomUUID()] }),
        verdict('post', piiPost, 1),
      ),
      true,
    );

    const purged = await store.purgeOwnerData(authorId);
    assert.deepEqual(
      purged,
      {
        records: 3,
        idempotency: 1,
        retained: 1,
        redacted: 1,
        hiddenMedia: 3,
        authorRefsReplaced: 2,
        authorRefsRemaining: 0,
      },
      'F13：安全帖保留（仅媒体移除）+ PII 帖脱敏 + 点赞物理删；'
        + '媒体引用：安全帖 2 + PII 帖 1；评论与举报本主体此时没有；'
        + '**作者指针替换 2 行**（post2 + piiPost，同一事务内 author_id 置 NULL + 写行内匿名引用）；'
        + '**剩余 owner 引用 0**（写入后重新测量；含软删行 —— 本夹具没有 deleted 行，'
        + '软删行覆盖见 tests/unit/community-author-ref-softdeleted.test.mjs 的 A/B/D 组）',
    );
    // 迁移 0030：行级作者指针必须真的换掉（真库行值，不是投影层的假象）。
    const anonRows = (await owner.query(
      `SELECT id, author_id, anonymized_author_ref FROM community_posts
        WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[post2, piiPost]],
    )).rows;
    assert.equal(anonRows.length, 2);
    for (const row of anonRows) {
      assert.equal(row.author_id, null, 'F13：行级 account 指针必须置空（删除账号映射）');
      assert.match(String(row.anonymized_author_ref), /^gy-anon-[0-9a-f]{16}$/, '行内必须留下形状合法的注销引用');
    }
    assert.equal(
      anonRows[0].anonymized_author_ref,
      anonRows[1].anonymized_author_ref,
      '同一注销主体的帖与评/帖必须共用**同一个**引用（逐主体独立，不逐行随机）',
    );
    assert.equal(
      (await owner.query(
        'SELECT count(*)::int AS n FROM community_posts WHERE author_id = $1::uuid',
        [authorId],
      )).rows[0].n,
      0,
      '该主体名下不得再有任何 author_id 命中的行（**含** visibility=deleted 的行 —— PR #483 [P2] 之后'
        + '软删行的作者关联同样清除；本夹具没有 deleted 行，软删行的真库/内核举证见 '
        + 'tests/unit/community-author-ref-softdeleted.test.mjs 的 D1/D2）',
    );
    const purgedPost = await store.getPost(post2);
    assert.equal(purgedPost.visibility, 'published', 'F13：安全帖子保留公开，不得软删');
    assert.equal(purgedPost.revision, 1, '仅移除媒体不改正文摘要 ⇒ 不推进 revision（否则旧审核结论查不到、安全正文消失）');
    assert.deepEqual(purgedPost.media_ids, [], '不能可靠脱敏的媒体引用被移除');
    assert.equal(purgedPost.body, '拔节期，看麦娘为主，人工拔除后补喷。', '正文原样保留');
    const purgedPii = await store.getPost(piiPost);
    assert.equal(purgedPii.body.includes('13800138000'), false, '个人信息必须清除（手机号）');
    assert.equal(purgedPii.body.includes('nongyou@example.com'), false, '个人信息必须清除（邮箱）');
    assert.equal(purgedPii.body.includes('阳光小区3栋2单元501室'), false, '个人信息必须清除（精确门牌）');
    assert.ok(purgedPii.body.includes('个人信息已清除'), '清除必须可见（占位符）');
    assert.equal(purgedPii.revision, 2, '正文改了 ⇒ revision+1（旧 ETag/旧审核摘要失效）');
    assert.deepEqual(purgedPii.media_ids, [], 'PII 行的媒体引用同样移除');
    assert.equal(await store.countLikes('post', post2), 0, '点赞是物理删（行为痕迹不留）');
    assert.deepEqual(
      (await owner.query(
        'SELECT detail FROM community_reports WHERE reporter_id = $1::uuid',
        [otherId],
      )).rows.map((row) => row.detail).sort(),
      ['改过说明', '剂量写错了'].sort(),
      '他人的举报行与其自述一字不动（注销只清本主体）',
    );
    assert.equal(await store.findIdempotency(authorScope, authorKeyHash), null, '本主体台账行被清');
    assert.equal(
      (await owner.query(
        'SELECT count(*)::int AS n FROM community_idempotency WHERE scope LIKE $1::text',
        [`${otherId}\n%`],
      )).rows[0].n,
      otherIdempotencyBefore,
      '他人台账行一行不少（LIKE 前缀没串到别人）',
    );
    say('注销清理（F13）：安全帖保留可见、PII 清除并升版本、媒体引用移除；点赞物理删；他人举报与台账一字不动');

    assert.deepEqual(
      await store.purgeOwnerData(authorId),
      {
        records: 0,
        idempotency: 0,
        retained: 0,
        redacted: 0,
        hiddenMedia: 0,
        authorRefsReplaced: 0,
        authorRefsRemaining: 0,
      },
      '重跑：改动/删除为 0，作者指针也不再替换（author_id 已置空 ⇒ 该主体名下已无行）；'
        + 'retained 因此如实为 0 —— 保留结果记录在首轮的 retained:1 与 author-refs-replaced:2 上；'
        + '剩余 owner 引用仍为 0（重放不产生新的未完成项）',
    );
    say('注销清理可重跑：第二次改动/替换全 0；主体名下已无行（author_id 已置空）⇒ retained 如实为 0，不重复抹也不报错');

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
    // 0030 的列/约束挂在 0022 的两张表上：0022 的 down 把表一起撤了，所以再 apply 必须把 0030 也补回来，
    // 否则后续走 store 的语句会因 `anonymized_author_ref` 不存在而 42703（这正是真库臂抓到的形态）。
    await owner.query(sqlFile('migrations/0030_community_author_ref.sql'));
    const afterReapply = (await owner.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )).rows.map((row) => row.tablename);
    assert.equal(
      afterReapply.filter((name) => OUR_TABLES.includes(name)).length,
      6,
      'rollback 之后必须能原地再 apply',
    );
    say('apply → rollback → 再 apply 三步在同一个库上收敛（六表 + 0030 的两列/两条 CHECK 全部恢复）');

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

    // ---- 13. 后台 real 下架（GY-I18 / #18 的 admin 臂） -------------------
    // 本段是"real 模式下后台写面真的改到真库"的**唯一**证据：
    //   能力门 = `communityPostPortForAdmin.persistent === true`（PG 社区 store，迁移 0022），
    //   real + pool ⇒ `createPostgresAccountAuthority({ pool })` 已接 ⇒ 进入能力外壳，
    //   `hidePostWired` 因此为 true；写本身不新增迁移（`20-login-roles.sql` 已有
    //   `GRANT UPDATE (…, visibility, audit_state, updated_at) ON public.community_posts`）。
    // ⛔ 本段**不**证明库内审计：`appendAudit` 仍落内存 ops store（`persistent:false`）——
    //   "库内审计未取得"在 PR 正文如实登记；下面只顺带断言该能力位确实是 false（不得被读成已落库）。
    const adminToken = mintOpaqueToken();
    const hideAdminId = await auth.createAdmin({
      loginName: 'synthetic-i18-hide-admin',
      credentialHash: 'synthetic-not-a-real-credential-hash',
      scopes: ['sources:write'], // = OPS_SCOPES.hidePost（admin/ops/service.ts）
    });
    await auth.createSession({
      userId: hideAdminId,
      tokenHashHex: hashToken(adminToken),
      authEpoch: 1,
      expiresAt: new Date(Date.now() + 3600_000),
      audience: 'admin',
    });
    const b = await account('q'); // 他人（非作者）：读列表/详情用
    const adminApp = buildApp({ config: realConfig, store: auth, pool, now: () => new Date() });
    assert.notEqual(adminApp.adminOpsService, null, 'real + pool ⇒ 后台运营服务必须存在（能力外壳）');
    assert.equal(adminApp.adminOpsService.store.persistent, false,
      '如实标注：后台审计 store 仍是内存实现（persistent:false）⇒ 本段**不**构成"审计已落库"');
    const call2 = async (token, method, path, extra = {}) => {
      const response = await adminApp.inject({
        method,
        url: path,
        headers: {
          authorization: `Bearer ${token}`,
          ...(extra.payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...(extra.headers ?? {}),
        },
        ...(extra.payload === undefined ? {} : { payload: extra.payload }),
      });
      return { status: response.statusCode, headers: response.headers, body: response.json() };
    };
    const hideOf = (id, { token = adminToken, ifMatch = '"1"', key } = {}) => call2(
      token,
      'POST',
      `/api/v1/admin/posts/${id}/hide`,
      { payload: { reason: '示例：管理员下架违规帖子（结构性文本）' }, headers: { 'if-match': ifMatch, 'idempotency-key': key } },
    );

    // 13.1 选一条**经产品写路径**产生的真库帖子（作者 = a，revision 取自 201 响应）。
    // 为什么不用 `store.insertPost(...)` 直接造：`effectiveState` 会在**读取时**核对审核结论的
    // `rule_version`（内容派生）与 `text_digest`，手造结论的摘要对不上 ⇒ 该帖本来就不公开可见，
    // 那"下架前可见"的对照臂就会变成恒真/恒假。HTTP 写路径写的是**真结论**，对照才成立。
    const hiddenPostId = httpPostId;
    const hiddenPostRevision = created.body.data.revision;
    assert.equal(hiddenPostRevision, 1, '本节假定该帖仍是首版（未被编辑过）');
    // 一条指向它的真库消息：下架前应 available、下架后应 unavailable（同一行）。
    const messagesStore = createPostgresMessagesStore({ pool });
    const probeMessageId = randomUUID();
    assert.equal(
      await messagesStore.insertMessage({
        id: probeMessageId,
        revision: 1,
        owner_id: a.user.id,
        type: 'system',
        target_ref: { type: 'post', id: hiddenPostId, revision: hiddenPostRevision },
        read_at: null,
        created_at: new Date().toISOString(),
        event_key: `gy-i18-hide:${probeMessageId}`,
      }),
      'inserted',
    );

    // 13.2 下架前：他人可读详情、列表里有、消息目标 available（三处都读**真库**）。
    const beforeDetail = await call2(b.token, 'GET', `/api/v1/posts/${hiddenPostId}`);
    assert.equal(beforeDetail.status, 200, JSON.stringify(beforeDetail.body));
    const beforeFeed = await call2(b.token, 'GET', '/api/v1/posts');
    assert.equal(beforeFeed.status, 200, JSON.stringify(beforeFeed.body));
    assert.ok(beforeFeed.body.data.items.some((item) => item.id === hiddenPostId), '下架前必须出现在公开列表里');
    const beforeMessages = await call2(a.token, 'GET', '/api/v1/messages');
    assert.equal(beforeMessages.status, 200, JSON.stringify(beforeMessages.body));
    const beforeRow = beforeMessages.body.data.items.find((item) => item.target_ref?.id === hiddenPostId);
    assert.notEqual(beforeRow, undefined, '作者必须有一条指向该帖的消息');
    assert.equal(beforeRow.reference_state, 'available', '下架前消息跳转目标必须可用');

    // 13.3 后台下架（real 模式、真库 CAS）⇒ 200 Ack + ETag 为新 revision。
    const hidden = await hideOf(hiddenPostId, { ifMatch: `"${hiddenPostRevision}"`, key: 'gy-i18-hide-pg-1' });
    assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
    assert.equal(hidden.body.data.accepted, true);
    assert.equal(hidden.headers.etag, '"2"', '下架把 revision 1→2 并回写 ETag');
    const storedRow = (await owner.query(
      'SELECT visibility, revision FROM community_posts WHERE id = $1::uuid',
      [hiddenPostId],
    )).rows[0];
    assert.deepEqual(storedRow, { visibility: 'hidden', revision: 2 }, '可见性与版本必须真落库（不是只改返回值）');
    say('real admin 臂：hidePost 经能力门放行 ⇒ 200 Ack，community_posts 行 visibility=hidden、revision 1→2 真落库');

    // 13.4 下架后：他人详情 404（同形不泄露）、列表剔除、作者仍 200（#15 既有口径）。
    const afterDetail = await call2(b.token, 'GET', `/api/v1/posts/${hiddenPostId}`);
    assert.equal(afterDetail.status, 404, JSON.stringify(afterDetail.body));
    assert.equal(afterDetail.body.error.code, 'NOT_FOUND');
    const afterFeed = await call2(b.token, 'GET', '/api/v1/posts');
    assert.equal(afterFeed.status, 200, JSON.stringify(afterFeed.body));
    assert.equal(afterFeed.body.data.items.some((item) => item.id === hiddenPostId), false, '下架的帖子必须退出公开列表');
    const authorView = await call2(a.token, 'GET', `/api/v1/posts/${hiddenPostId}`);
    assert.equal(authorView.status, 200, JSON.stringify(authorView.body));
    assert.equal(authorView.body.data.visibility, 'hidden', '作者读自己的内容仍可见，且如实显示 hidden');
    say('读时权限：下架后他人详情 404、公开列表剔除、作者仍 200 且 visibility=hidden（无缓存可让内容复活）');

    // 13.5 消息跳转目标：同一条消息、同一个 id，下架后读取即 unavailable（每页重查，不清缓存）。
    const afterMessages = await call2(a.token, 'GET', '/api/v1/messages');
    assert.equal(afterMessages.status, 200, JSON.stringify(afterMessages.body));
    const rowsForTarget = afterMessages.body.data.items.filter((item) => item.target_ref?.id === hiddenPostId);
    assert.ok(rowsForTarget.length >= 1, '同一目标的消息行必须仍在（不得因下架消失）');
    for (const row of rowsForTarget) {
      assert.equal(row.reference_state, 'unavailable', `目标已下架：消息 ${row.id} 必须 unavailable`);
      assert.equal(Object.hasOwn(row, 'reference_state'), true);
    }
    assert.equal(
      rowsForTarget.some((row) => row.id === probeMessageId),
      true,
      '下架前可用、下架后不可用的必须是**同一行**（钉住"读取时重算"而非投递时快照）',
    );
    say('消息目标：同一行 target_ref 由 available → unavailable（读取时重查社区公开判据，不清缓存/不重建行）');

    // 13.6 幂等与错误映射（同一批能力门，逐条如实）。
    const replay = await hideOf(hiddenPostId, { key: 'gy-i18-hide-pg-1' });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.data.accepted, true, '同 key 同体重放必须回放首次结果');
    assert.equal(
      (await owner.query('SELECT revision FROM community_posts WHERE id = $1::uuid', [hiddenPostId])).rows[0].revision,
      2,
      '重放不得再推进 revision',
    );
    const hideAgain = await hideOf(hiddenPostId, { ifMatch: '"2"', key: 'gy-i18-hide-pg-2' });
    assert.equal(hideAgain.status, 200, JSON.stringify(hideAgain.body));
    assert.equal(hideAgain.body.data.accepted, true, '已隐藏再下架是幂等成功（changed:false）');
    const conflict = await hideOf(hiddenPostId, { ifMatch: '"9"', key: 'gy-i18-hide-pg-3' });
    assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
    assert.equal(conflict.body.error.code, 'REVISION_CONFLICT', 'If-Match 与服务端版本不符必须是 409（写之前比对）');
    const unknownPost = await hideOf(randomUUID(), { key: 'gy-i18-hide-pg-4' });
    assert.equal(unknownPost.status, 404, JSON.stringify(unknownPost.body));
    assert.equal(unknownPost.body.error.code, 'NOT_FOUND');
    const deletedPostId = randomUUID();
    assert.equal(
      await store.insertPost(
        postRecord(deletedPostId, a.user.id, { visibility: 'deleted', audit_state: 'approved' }),
        verdict('post', deletedPostId, 1),
      ),
      true,
    );
    const deleted = await hideOf(deletedPostId, { key: 'gy-i18-hide-pg-5' });
    assert.equal(deleted.status, 409, JSON.stringify(deleted.body));
    assert.equal(deleted.body.error.code, 'OBJECT_UNAVAILABLE', '已删除是不可复活的单向门（不得谎报成功）');
    assert.deepEqual(
      (await owner.query('SELECT visibility, revision FROM community_posts WHERE id = $1::uuid', [deletedPostId])).rows[0],
      { visibility: 'deleted', revision: 1 },
      '被拒的路径不得改行',
    );
    say('错误映射与幂等：同键重放回放首次结果、已隐藏再下架 200(changed:false)、版本不符 409、未知 404、已删除 409 且不改行');
    await adminApp.close();

    // 13.7 能力门的反例（同一真库、同一装配，只换模式）：real 但无池 ⇒ 行为回到 503。
    //     与单测 `admin-hide-post-gate.test.mjs` 的"persistent:false ⇒ 503"互补：
    //     那里是能力位的注入臂，这里是**真实装配**下"没有真库就没有下架"的同一结论。
    const noPoolApp = buildApp({ config: realConfig, store: auth, pool: null, now: () => new Date() });
    const noPool = await noPoolApp.inject({
      method: 'POST',
      url: `/api/v1/admin/posts/${randomUUID()}/hide`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
        'if-match': '"1"',
        'idempotency-key': 'gy-i18-hide-pg-nopool',
      },
      payload: { reason: '示例' },
    });
    assert.equal(noPool.statusCode, 503, noPool.body);
    assert.equal(noPool.json().error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(noPool.json().error.retryable, false);
    await noPoolApp.close();
    say('负控制：real + 无连接池（内存社区 store ⇒ persistent:false）⇒ hidePost 仍 503 PROVIDER_UNAVAILABLE(retryable:false)');
  } finally {
    if (app !== null) await app.close().catch(() => {});
    if (pool !== null) await pool.end().catch(() => {});
    await owner.end().catch(() => {});
  }
}

await main();
console.log(`\n全部 ${passed} 组真库断言通过。`);
