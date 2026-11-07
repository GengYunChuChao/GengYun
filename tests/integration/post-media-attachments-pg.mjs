/**
 * GY-R83（#1030）· 帖子级媒体挂载 `public.post_media_attachments` 的**真库**集成测试（PostgreSQL 17）。
 *
 * 为什么必须真库：`services/api/src/media/service.ts:826-839` 明令「每帖 ≤3 张」不许用
 * 「同一 owner 名下存活记录数」顶替（生命周期累计口径会让用户传满 3 张后永久锁死，且"先数后写"
 * 存在 TOCTOU）。本片把上限交给**结构约束**（`UNIQUE (post_id, ordinal)` + `CHECK (ordinal BETWEEN 1 AND 3)`），
 * 这些是否真的能裁决，只有数据库能证明——假池只能证明语句长什么样。
 *
 * 与 `tests/unit/post-media-attachments.test.mjs` 的分工：
 *   - 单元测锁语句形状与错误码映射（23514/23505/少挂 ⇒ 哪一类 400、事务必须整笔 ROLLBACK）；
 *   - 本脚本锁**只有 PG 能证明**的十一件事（①–⑨ 是 #1037 原有的，⑩/⑪ 是 #1030 这两节）：
 *     ① 挂 3 张成功且 ordinal 从 1 起按 media_ids 顺序；第 4 张被拒（`post_image_limit`）且整笔回滚；
 *     ② 删帖（`visibility='deleted'`）后同一 media 可被另一帖挂载（"删帖即释放"）；
 *     ③ 同一 media 不能同时挂在两个**存活**帖子上（认领谓词），同一帖内重复由 PK 裁决；
 *     ④ 跨用户：A 名下的 media 不能挂到 B 的帖子上（认领谓词按 owner 判）。
 *     ⑤ **直插探针**（PR #1037 审查 P1）：不经 `community_posts.media_ids` 的数组 CHECK，直接
 *        `INSERT INTO public.post_media_attachments` —— ordinal=4 撞 23514、两个 ordinal=1 撞 23505、
 *        同一 `(post_id, media_id)` 两次撞 23505 主键。为什么必须有这条：此前只有单元测对迁移**全文**
 *        做 `assert.match`，而 0056 的头注释里就写着那两串字 ⇒ 注释掉 `UNIQUE (post_id, ordinal)`、
 *        把 CHECK 放宽成 1..4，单测 13/13 与集成 8/8 仍全绿，真库却能直插 4 行同帖。
 *     ⑥ 非法 uuid 不许被静默少挂：`insertPost([合法 media, 'not-a-uuid'])` 必须整笔失败
 *        （`media_not_attachable`），不能「只挂上一张也建帖成功」。
 *     ⑦ 并发：另一事务先取同一 `media_id` 的 `pg_advisory_xact_lock` 并插行（未提交）时，本实现的
 *        认领必须**阻塞在锁上**，对方提交后抛 `media_not_attachable` —— 同一张图永远只有一条存活挂载。
 *     ⑧ **旧帖数组引用**（PR #1037 审查 P2）：0056 不回填，直接 `INSERT INTO community_posts` 造一条
 *        只把图放进 `media_ids` 的老帖（没有任何挂载行）⇒ 新帖再认领同一张图必须失败
 *        （`media_not_attachable`）且不静默少挂；老帖 `visibility='deleted'` 后释放。
 *     ⑨ **注销同事务清理挂载行**（PR #1037 审查 P1）：注销清 `media_ids` 的两处（有 PII 的帖、
 *        只有图片的帖）必须同时删掉 `post_media_attachments` 的本帖行；安全正文（title/body）
 *        按原口径保留（media-only 分支不推进 revision）。
 *     ⑩ **同帖并发挂两张不同的图**（#1030）：两笔 `commitPostIfCurrent` 都带 `expected.revision=1`，
 *        必须恰好 1 笔成功、输的那笔是 `{ ok: false, reason: 'REVISION_CHANGED' }`；事后该帖挂载行=1、
 *        `media_ids` 长度=1、输家的图零挂载行。per-media advisory lock 只按 media_id 串行化（两把锁
 *        不同 ⇒ 互不阻塞），挡不住这一条 —— 帖子级 `SELECT … FOR UPDATE` + revision CAS 才是唯一互斥。
 *     ⑪ **计数事实源的 owner_id / state 过滤**（#1030，行为级负控制）：走真实上传配额判定
 *        （`initiateUpload`），别人名下的 ready 媒体与 `state='deleted'` 的媒体都不许占本 owner 的名额；
 *        删掉任一过滤 ⇒ 第 `COMMUNITY_MAX_IMAGES_PER_POST` 张就会被错拒成 400 `post_image_limit`。
 *        单测的五条 SQL 文本正则抓不到这两条（见第 14 节注释）。
 *   ⚠️ ⑩/⑪ 目前**没有 CI 计数闸门覆盖**：`.github/workflows/real-pg-integration.yml` 的读数闸门仍是
 *   `readings < 13`，而本文件现在真跑产出 19 条 `PASS n:` —— 把这两节整段删掉，step 照样绿（16 ≥ 13）。
 *   另加一条计数口径的实证：挂载后待用池为 0、删帖后回到 3，而 `liveCommunityImageCount`（owner 累计）
 *   始终是 3 —— 这条差就是本 issue 的全部理由。
 *
 * 运行（专用测试库必须是**空库**，脚本会先断言 public 下没有任何表）：
 *   createdb gengyun_post_media_test
 *   POST_MEDIA_PG_TEST_URL=postgres://postgres@127.0.0.1:55400/gengyun_post_media_test \
 *     node tests/integration/post-media-attachments-pg.mjs
 * 未设置 `POST_MEDIA_PG_TEST_URL` ⇒ 打印 `SKIP` 并以 **77** 退出（POSIX「skipped」）：本次运行**没有**验证真库。
 * 本机明知无真库、只想看跳过原因时可显式加 `--allow-skip`（或 `GY_ALLOW_SKIP=1`）取 0 —— ⛔ 不得用于门禁。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../../services/api/src/db/pool.ts';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { createPostgresCommunityStore } from '../../services/api/src/community/store-pg.ts';
import { createPostgresMediaStore } from '../../services/api/src/media/store-pg.ts';
import { COMMUNITY_MAX_IMAGES_PER_POST } from '../../packages/media/constants.mjs';

const ENV = 'POST_MEDIA_PG_TEST_URL';
const rawUrl = process.env[ENV];
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
if (rawUrl === undefined || rawUrl.trim() === '') {
  console.log(
    `SKIP real PG17: ${ENV} 未设置 —— 本次运行没有验证真库的帖子级媒体挂载（不是通过，也不是失败）。`,
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
assert.equal(url.pathname, '/gengyun_post_media_test', '只允许专用测试库 gengyun_post_media_test');

let passed = 0;
const say = (message) => {
  passed += 1;
  console.log(`PASS ${passed}: ${message}`);
};

const CREATED = '2026-11-07T02:00:00.000Z';
const LATER = '2026-11-07T02:30:00.000Z';

/** `PostRecord` 的完整形状（与 `community-pg.mjs` 的 `postRecord` 同源；字段缺一个都会被 store 拒）。 */
const postRecord = (id, authorId, mediaIds, overrides = {}) => ({
  id,
  revision: 1,
  author_id: authorId,
  title: '春小麦田除草记录',
  body: '拔节期，看麦娘为主，人工拔除后补喷。',
  crop_id: 'crop-wheat',
  region_code: '330100',
  media_ids: [...mediaIds],
  linked_knowledge_ref: { type: 'species', id: 'spc-1', revision: 2 },
  visibility: 'published',
  audit_state: 'approved',
  created_at: CREATED,
  updated_at: CREATED,
  ...overrides,
});

/** 断言一段调用抛出 400 `INVALID_REQUEST` + 指定 `details[0].code`（@media 域的机器可读码）。 */
const rejectsWith = async (run, expectedCode, label) => {
  let captured = null;
  try {
    await run();
  } catch (error) {
    captured = error;
  }
  assert.notEqual(captured, null, `${label}：必须抛出，但调用成功了（结构约束没生效）`);
  assert.equal(captured.status, 400, `${label}：HTTP 面必须是 400，实际 ${captured.status}`);
  assert.equal(captured.code, 'INVALID_REQUEST', `${label}：信封码必须是 INVALID_REQUEST，实际 ${captured.code}`);
  assert.deepEqual(
    captured.details,
    [{ field: '/media_ids', code: expectedCode }],
    `${label}：details 必须是 @media 域既有机器码 ${expectedCode}`,
  );
  return captured;
};

async function main() {
  const owner = new pg.Client({ connectionString: url.href });
  await owner.connect();
  let pool = null;
  try {
    // ---- 1. 环境与迁移 ---------------------------------------------------
    const version = (await owner.query("SELECT current_setting('server_version') AS version")).rows[0].version;
    assert.match(version, /^17\./, `requires PostgreSQL 17，实际 ${version}`);
    const emptyTables = (await owner.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'",
    )).rows[0].n;
    assert.equal(emptyTables, 0, 'fresh DB required（专用测试库必须是空的）');

    const all = discoverMigrations();
    const migrations = all.filter((m) => ['0001', '0022', '0030', '0032', '0045', '0056'].includes(m.version));
    assert.deepEqual(
      (await applyMigrations(owner, migrations)).applied,
      ['0001', '0022', '0030', '0032', '0045', '0056'],
      '0001（users / media / 枚举底座）+ 0022（community_posts）+ 0030（F13：author_id 可空 + anonymized_author_ref，'
        + 'store 的 POST_COLUMNS 会读它，缺它则读帖撞 42703）+ 0032（community_reports.anonymized_author_ref）+ 0045'
        + '（community_moderation_decisions.decided_by）+ 0056（本片的 post_media_attachments）；后两支是 store 模块的'
        + '列要求，缺则 commitReport / writeModeration 撞 42703 —— 由 tests/unit/migration-subset-coverage-pins 钉住',
    );
    assert.equal((await applyMigrations(owner, migrations)).applied.length, 0, '重跑迁移必须是 no-op');
    say('迁移 apply 可重入：0001 + 0022 + 0030 + 0032 + 0045 + 0056 六段，重跑为 no-op');

    const attached = async (postId) =>
      (
        await owner.query(
          'SELECT ordinal, media_id::text AS media_id FROM public.post_media_attachments WHERE post_id = $1::uuid ORDER BY ordinal',
          [postId],
        )
      ).rows;
    const postExists = async (postId) =>
      (await owner.query('SELECT count(*)::int AS n FROM public.community_posts WHERE id = $1::uuid', [postId]))
        .rows[0].n;

    // 夹具：两个用户 + 若干条**真** media 行（跨用户判定与待用池计数都需要 owner 真存在）。
    const userA = randomUUID();
    const userB = randomUUID();
    const userC = randomUUID();
    for (const id of [userA, userB, userC]) {
      await owner.query("INSERT INTO public.users (id, state, nickname) VALUES ($1::uuid, 'active', 'gy-r83')", [id]);
    }
    const newMedia = async (ownerId, ordinalTag) => {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO public.media (id, owner_id, purpose, mime, bytes, sha256, state, object_ref_cipher)
         VALUES ($1::uuid, $2::uuid, 'community_image', 'image/jpeg', 2048, repeat('a', 64), 'ready', $3)`,
        [id, ownerId, `v1:gy-r83-${ordinalTag}`],
      );
      return id;
    };

    pool = createPool(url.href);
    assert.notEqual(pool, null, 'createPool 必须给出连接池');
    const community = createPostgresCommunityStore({ pool });
    const media = createPostgresMediaStore({
      pool,
      cipher: { encryptObjectRef: (value) => value, decryptObjectRef: (value) => value },
    });

    // ---- 2. ① 挂 3 张成功、ordinal 按数组顺序；第 4 张被拒且整笔回滚 -------------
    const m1 = await newMedia(userA, 'a1');
    const m2 = await newMedia(userA, 'a2');
    const m3 = await newMedia(userA, 'a3');
    const post1 = randomUUID();
    assert.equal(await community.insertPost(postRecord(post1, userA, [m1, m2, m3]), null), true);
    assert.deepEqual(
      await attached(post1),
      [
        { ordinal: 1, media_id: m1 },
        { ordinal: 2, media_id: m2 },
        { ordinal: 3, media_id: m3 },
      ],
      'ordinal 必须从 1 起、按 media_ids 的数组顺序落位',
    );
    say('① 一帖挂 3 张成功：ordinal 1..3 与 media_ids 顺序一致（结构约束 = UNIQUE(post_id, ordinal) + CHECK 1..3）');

    const fourA = await newMedia(userA, 'a4');
    const fourB = await newMedia(userA, 'a5');
    const fourC = await newMedia(userA, 'a6');
    const fourD = await newMedia(userA, 'a7');
    const post2 = randomUUID();
    await rejectsWith(
      () => community.insertPost(postRecord(post2, userA, [fourA, fourB, fourC, fourD]), null),
      'post_image_limit',
      '第 4 张必须被拒',
    );
    assert.equal(await postExists(post2), 0, '第 4 张被拒后整笔事务必须 ROLLBACK：帖子不得留下');
    assert.deepEqual(await attached(post2), [], '第 4 张被拒后不得残留任何挂载行');
    say('① 第 4 张 ⇒ 400 INVALID_REQUEST / details.code=post_image_limit，且帖子与挂载行都整笔回滚');

    // ---- 3. ③（结构面）同一帖内同一 media 重复 ⇒ PK 裁决 --------------------------
    const post3 = randomUUID();
    await rejectsWith(
      () => community.insertPost(postRecord(post3, userA, [fourA, fourA]), null),
      'post_image_limit',
      '同一帖重复挂同一张图',
    );
    assert.equal(await postExists(post3), 0, '重复挂载被拒后帖子不得留下');
    say('③（结构面）PRIMARY KEY (post_id, media_id) 真实存在并裁决同帖重复 ⇒ post_image_limit');

    // ---- 4. ② 删帖即释放：同一 media 可被另一帖挂载 ------------------------------
    const deleted = await community.commitPostIfCurrent(
      post1,
      { revision: 1, visibility: 'published' },
      { revision: 2, visibility: 'deleted', updated_at: LATER },
      null,
    );
    assert.equal(deleted.ok, true, `删帖 CAS 必须成功，实际 ${JSON.stringify(deleted)}`);
    const post4 = randomUUID();
    assert.equal(await community.insertPost(postRecord(post4, userA, [m1, m2]), null), true);
    assert.deepEqual(
      (await attached(post4)).map((row) => row.media_id),
      [m1, m2],
      '原帖 visibility=deleted 后，同一批 media 必须能被另一帖重新认领（删帖即释放）',
    );
    assert.deepEqual(
      (await attached(post1)).map((row) => row.media_id),
      [m1, m2, m3],
      '删帖是状态机，不是物理删除：旧帖的挂载行仍在（悬空引用语义）',
    );
    say('② 删帖（visibility=deleted）后同一 media 被另一帖挂载成功；旧帖挂载行保留（状态机语义）');

    // ---- 5. ③（谓词面）同一 media 不能同时挂在两个存活帖上 ------------------------
    const post5 = randomUUID();
    await rejectsWith(
      () => community.insertPost(postRecord(post5, userA, [fourB, m1]), null),
      'media_not_attachable',
      '同一 media 挂到第二个存活帖',
    );
    assert.equal(await postExists(post5), 0, '跨帖重复挂载被拒后帖子不得留下');
    say('③（谓词面）m1 已挂在存活帖 post4 上 ⇒ 另一帖再挂被拒（media_not_attachable）：跨帖唯一由认领谓词承担，不是 PK');

    // ---- 6. ④ 跨用户：A 的 media 不能挂到 B 的帖 ---------------------------------
    const postB = randomUUID();
    await rejectsWith(
      () => community.insertPost(postRecord(postB, userB, [m3]), null),
      'media_not_attachable',
      '跨用户挂载',
    );
    assert.equal(await postExists(postB), 0, '跨用户挂载被拒后 B 的帖子不得留下');
    say('④ 跨用户：userA 名下的 media 不能挂到 userB 的帖子（认领谓词按 owner_id 判，非 PK 兜底）');

    // ---- 7. 计数口径实证：待用池 ≠ owner 生命周期累计 ----------------------------
    const cMedia = [await newMedia(userC, 'c1'), await newMedia(userC, 'c2'), await newMedia(userC, 'c3')];
    const postC = randomUUID();
    assert.equal(await community.insertPost(postRecord(postC, userC, cMedia), null), true);
    assert.equal(await media.countPendingCommunityImages(userC), 0, '3 张已挂到存活帖 ⇒ 待用池必须是 0');
    assert.equal(await media.liveCommunityImageCount(userC), 3, 'owner 累计口径仍是 3（这正是被禁的那个口径）');
    const removed = await community.commitPostIfCurrent(
      postC,
      { revision: 1 },
      { revision: 2, visibility: 'deleted', updated_at: LATER },
      null,
    );
    assert.equal(removed.ok, true, '删帖 CAS 必须成功');
    assert.equal(await media.countPendingCommunityImages(userC), 3, '删帖即释放 ⇒ 待用池回到 3');
    assert.equal(await media.liveCommunityImageCount(userC), 3, 'owner 累计口径在删帖后仍是 3（永不衰减）');
    say('计数口径：挂载后待用池 0 / 删帖后 3，而 owner 累计恒为 3 —— 待用池会随挂载与删帖释放');

    // ---- 8. ⑤ 直插探针：绕过 community_posts 的数组 CHECK，结构约束必须自己咬住 ----
    // `post_id` 没有外键（悬空引用语义），所以这里可以给一个**根本不存在的**帖子 id 直插挂载行 ——
    // 这才是「数组 CHECK 够不着」的那条路：真实入库路径上第 4 张会先在 `0022` 的
    // `community_posts_media_ids_max` 上被拒，0056 的约束从来没有机会被检验。
    const insertAttachment = (postId, mediaId, ordinal) =>
      owner.query(
        'INSERT INTO public.post_media_attachments (post_id, media_id, ordinal) VALUES ($1::uuid, $2::uuid, $3::smallint)',
        [postId, mediaId, ordinal],
      );
    const expectPgError = async (run, expected, label) => {
      let captured = null;
      try {
        await run();
      } catch (error) {
        captured = error;
      }
      assert.notEqual(captured, null, `${label}：必须被数据库拒绝，但插进去了（结构约束没生效）`);
      assert.equal(captured.code, expected.code, `${label}：SQLSTATE 必须是 ${expected.code}，实际 ${captured.code}`);
      assert.equal(
        captured.constraint,
        expected.constraint,
        `${label}：必须由约束 ${expected.constraint} 裁决，实际 ${captured.constraint}`,
      );
      return captured;
    };

    const directPost = randomUUID();
    const directMedia = [
      await newMedia(userA, 'd1'),
      await newMedia(userA, 'd2'),
      await newMedia(userA, 'd3'),
      await newMedia(userA, 'd4'),
    ];
    for (const [index, mediaId] of directMedia.slice(0, 3).entries()) {
      await insertAttachment(directPost, mediaId, index + 1);
    }
    await expectPgError(
      () => insertAttachment(directPost, directMedia[3], 4),
      { code: '23514', constraint: 'post_media_attachments_ordinal_range' },
      '直插第 4 行（ordinal=4）',
    );
    say('⑤ 直插探针：同帖 ordinal=4 被 CHECK(post_media_attachments_ordinal_range) 以 23514 拒绝（不经 media_ids 数组 CHECK）');

    const dupOrdinalPost = randomUUID();
    const dupOrdinalMedia = [await newMedia(userA, 'd5'), await newMedia(userA, 'd6')];
    await insertAttachment(dupOrdinalPost, dupOrdinalMedia[0], 1);
    await expectPgError(
      () => insertAttachment(dupOrdinalPost, dupOrdinalMedia[1], 1),
      { code: '23505', constraint: 'post_media_attachments_post_ordinal_key' },
      '直插第二个 ordinal=1',
    );
    say('⑤ 直插探针：同一帖两个 ordinal=1 被 UNIQUE(post_media_attachments_post_ordinal_key) 以 23505 拒绝');

    const dupPkPost = randomUUID();
    const dupPkMedia = await newMedia(userA, 'd7');
    await insertAttachment(dupPkPost, dupPkMedia, 1);
    await expectPgError(
      () => insertAttachment(dupPkPost, dupPkMedia, 2),
      { code: '23505', constraint: 'post_media_attachments_pkey' },
      '同一 (post_id, media_id) 插两次',
    );
    say('⑤ 直插探针：同一 (post_id, media_id) 插两次被 PRIMARY KEY 以 23505 拒绝');
    await owner.query('DELETE FROM public.post_media_attachments WHERE post_id = ANY($1::uuid[])', [
      [directPost, dupOrdinalPost, dupPkPost],
    ]);

    // ---- 9. ⑥ 非法 uuid 不许被静默少挂（declared 数的是**传入**长度）---------------
    const badPost = randomUUID();
    const badMedia = await newMedia(userA, 'bad1');
    await rejectsWith(
      () => community.insertPost(postRecord(badPost, userA, [badMedia, 'not-a-uuid']), null),
      'media_not_attachable',
      '传入 [合法 media, not-a-uuid]',
    );
    assert.equal(await postExists(badPost), 0, '非法 uuid 导致「传入 2 张只挂上 1 张」⇒ 整笔回滚，帖子不得留下');
    assert.deepEqual(await attached(badPost), [], '回滚后不得残留挂载行');
    say('⑥ 非法 uuid：declared = array_length($2) 而非正则过滤后的行数 ⇒ 抛 media_not_attachable（⛔ 不静默少挂一张）');

    // ---- 10. ⑧ 旧帖数组引用：0056 不回填，旧帖的图仍算占用 -----------------------
    // 直接 INSERT 造「迁移前的老帖」：media_ids 里有图、`post_media_attachments` 里**没有**行
    // （不走 `claimPostMedia`，因为 0056 不回填历史）。这条正是只看挂载行时会漏掉的占用面。
    const legacyMedia = await newMedia(userA, 'legacy1');
    const legacyPost = randomUUID();
    await owner.query(
      `INSERT INTO public.community_posts
         (id, author_id, revision, title, body, media_ids, visibility, audit_state, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, 1, '迁移前的老帖', '只存在于 media_ids 数组里的图', ARRAY[$3::text], 'published', 'approved',
               $4::timestamptz, $4::timestamptz)`,
      [legacyPost, userA, legacyMedia, CREATED],
    );
    assert.deepEqual(await attached(legacyPost), [], '旧帖按定义没有挂载行（0056 不回填）');
    const stolenPost = randomUUID();
    await rejectsWith(
      () => community.insertPost(postRecord(stolenPost, userA, [legacyMedia]), null),
      'media_not_attachable',
      '旧帖 media_ids 数组里的图被另一存活帖认领',
    );
    assert.equal(await postExists(stolenPost), 0, '不得静默少挂：整笔回滚，帖子不得留下');
    assert.deepEqual(await attached(stolenPost), [], '被拒后不得残留挂载行');
    say('⑧ 旧帖数组：只存在于 community_posts.media_ids 的图仍算占用 ⇒ 新帖认领被拒（media_not_attachable），不静默少挂');

    // 反证：老帖软删后释放同一张图（与挂载行同一口径：删帖即释放，⛔ 不是永久占用）。
    await owner.query("UPDATE public.community_posts SET visibility = 'deleted' WHERE id = $1::uuid", [legacyPost]);
    const afterRelease = randomUUID();
    assert.equal(await community.insertPost(postRecord(afterRelease, userA, [legacyMedia]), null), true);
    assert.deepEqual(
      (await attached(afterRelease)).map((row) => row.media_id),
      [legacyMedia],
      '旧帖 visibility=deleted 后同一 media 必须能被认领（删帖即释放）',
    );
    say('⑧ 旧帖数组：老帖 visibility=deleted 后同一 media 可被认领（删帖即释放，与挂载行口径一致）');

    // ---- 11. ⑦ 并发：同一 media 不能同时挂两个存活帖（advisory lock 定序）----------
    const lockPost = randomUUID();
    assert.equal(await community.insertPost(postRecord(lockPost, userA, []), null), true);
    const lockMedia = await newMedia(userA, 'lock1');
    const blocker = new pg.Client({ connectionString: url.href });
    await blocker.connect();
    let competing = null;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [lockMedia]);
      await blocker.query(
        'INSERT INTO public.post_media_attachments (post_id, media_id, ordinal) VALUES ($1::uuid, $2::uuid, 1)',
        [lockPost, lockMedia],
      );
      competing = community
        .insertPost(postRecord(randomUUID(), userA, [lockMedia]), null)
        .then(() => ({ ok: true, error: null }), (error) => ({ ok: false, error }));
      let waiting = 0;
      for (let i = 0; i < 60 && waiting === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        waiting = (await owner.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock'",
        )).rows[0].n;
      }
      assert.ok(
        waiting > 0,
        '第二个认领必须**阻塞在** pg_advisory_xact_lock 上：没有锁时两笔事务的 NOT EXISTS 都判「没人挂」'
          + '（PK/UNIQUE 都不跨帖），同一张图就会同时挂上两个存活帖',
      );
      await blocker.query('COMMIT');
    } finally {
      await blocker.end();
    }
    const settled = await competing;
    assert.equal(settled.ok, false, 'A 提交后 B 必须看到「已挂到存活帖」而失败，不许两个存活帖同挂一张图');
    assert.deepEqual(settled.error.details, [{ field: '/media_ids', code: 'media_not_attachable' }]);
    const liveAttach = (await owner.query(
      `SELECT count(*)::int AS n
         FROM public.post_media_attachments a
         JOIN public.community_posts p ON p.id = a.post_id
        WHERE a.media_id = $1::uuid AND p.visibility <> 'deleted'`,
      [lockMedia],
    )).rows[0].n;
    assert.equal(liveAttach, 1, '同一张图只允许一条存活挂载（并发下也一样）');
    say('⑦ 并发：A 未提交时 B 阻塞在 advisory lock；A 提交后 B 抛 media_not_attachable，存活挂载仍只有 1 条');

    // ---- 12. ⑨ 注销：清 media_ids 的两处必须同事务删挂载行 ------------------------
    // 0056 两侧无外键：只清 `community_posts.media_ids` 不会回收挂载行，后续删 media 行也回收不到
    // ⇒ 注销后仍留着「哪张图曾挂在这帖」的关联。这里走真实的 `purgeOwnerData`（同一事务）验证两处。
    const userD = randomUUID();
    await owner.query("INSERT INTO public.users (id, state, nickname) VALUES ($1::uuid, 'active', 'gy-r83')", [userD]);
    const purgeMedia = [
      await newMedia(userD, 'p1'),
      await newMedia(userD, 'p2'),
      await newMedia(userD, 'p3'),
    ];
    const mediaOnlyPost = randomUUID();
    const piiPost = randomUUID();
    assert.equal(
      await community.insertPost(postRecord(mediaOnlyPost, userD, [purgeMedia[0], purgeMedia[1]]), null),
      true,
    );
    assert.equal(
      await community.insertPost(
        postRecord(piiPost, userD, [purgeMedia[2]], { body: '联系方式 nongyou@example.com，拔节期看麦娘。' }),
        null,
      ),
      true,
    );
    const purgeCounts = await community.purgeOwnerData(userD);
    assert.deepEqual(
      purgeCounts,
      { records: 2, idempotency: 0, retained: 1, redacted: 1, hiddenMedia: 3, authorRefsReplaced: 2, authorRefsRemaining: 0 },
      '注销读数不变：清数组不新增记录口径（hiddenMedia 仍按媒体数组长度）',
    );

    // 同一事务**外**校验：安全正文按原口径保留、两处媒体引用都已消失。
    const purgedRows = (await owner.query(
      `SELECT id, revision, title, body, media_ids, author_id::text AS author_id, anonymized_author_ref
         FROM public.community_posts
        WHERE id = ANY($1::uuid[])`,
      [[mediaOnlyPost, piiPost]],
    )).rows;
    const byId = new Map(purgedRows.map((row) => [row.id, row]));
    const mediaOnlyRow = byId.get(mediaOnlyPost);
    assert.ok(mediaOnlyRow, '只有图片的帖必须保留（注销不清安全正文）');
    assert.equal(mediaOnlyRow.title, '春小麦田除草记录', 'media-only 分支不得改标题');
    assert.equal(mediaOnlyRow.body, '拔节期，看麦娘为主，人工拔除后补喷。', 'media-only 分支不得改正文');
    assert.equal(mediaOnlyRow.revision, 1, '仅移除媒体不推进 revision（旧审核结论仍有效）');
    assert.deepEqual(mediaOnlyRow.media_ids, [], '(b) community_posts.media_ids 必须清空');
    assert.equal(mediaOnlyRow.author_id, null, '作者指针必须换成注销引用');
    assert.notEqual(mediaOnlyRow.anonymized_author_ref, null, '必须写入注销引用（0030 的 CHECK 要求恰好一个）');
    const piiRow = byId.get(piiPost);
    assert.equal(piiRow.revision, 2, '有 PII 的帖改写正文 ⇒ revision+1');
    assert.equal(String(piiRow.body).includes('nongyou@example.com'), false, 'PII 必须已脱敏');
    assert.deepEqual(piiRow.media_ids, [], '有 PII 的帖同样清空数组');
    assert.deepEqual(await attached(mediaOnlyPost), [], '(b) media-only 帖不得残留任何挂载行');
    assert.deepEqual(await attached(piiPost), [], '有 PII 的帖同样不得残留挂载行');
    say('⑨ 注销：清 media_ids 的两处都同事务删掉 post_media_attachments 行；media-only 帖的 title/body/revision 原样保留');

    // ---- 13. ⑩ 并发（帖子级）：同一帖子同时挂两张**不同**的图 ⇒ 恰好 1 笔成功 ------
    // ⚠️ **本两节（⑩/⑪）目前无 CI 计数闸门覆盖**（#1037 审查 P3）：`.github/workflows/real-pg-integration.yml`
    // 的读数闸门是 `if [ "$readings" -lt 13 ]`，基线 13；本文件现在真跑产出 19 条 `PASS n:`
    // ⇒ 把本节与第 14 节整段删掉，`readings` 仍是 16 ≥ 13，CI step 照样绿。要真覆盖，得同时改
    // workflow 的基线、`tests/unit/ci-real-pg-readings-gates.test.mjs` 的 `READING_GATE_BASELINES`
    // （守卫逐条比对表 ↔ 文件，只改一边就红）和两处注释里的数字 —— 本提交只登记，不改 CI。
    // `#1037` 的并发闸门有两道，都不是「帖子级」：
    //   * `claimPostMedia` → `lockClaimedMedia` 只按 **media_id** 取 `pg_advisory_xact_lock`
    //     （挡的是「同一张图同时挂两帖」，见第 11 节）；
    //   * 帖子行的 `SELECT … FOR UPDATE` + revision CAS（`community/store-pg.ts:619-622` / `:630`）
    //     才是「同一帖子两笔并发改稿」的唯一互斥 —— 而挂图走的就是 PATCH 改稿这条路。
    // 本用例两笔挂的是**不同 media**（两把 advisory lock 不同 ⇒ 互不阻塞），所以它只压第二道：
    // 谁把 `for update` 或 revision 比较拿掉，下面就会读到 2 笔成功、2 行挂载、media_ids 只剩后到者。
    const raceOwner = randomUUID();
    await owner.query("INSERT INTO public.users (id, state, nickname) VALUES ($1::uuid, 'active', 'gy-r87')", [raceOwner]);
    const racePost = randomUUID();
    assert.equal(
      await community.insertPost(postRecord(racePost, raceOwner, []), null),
      true,
      '并发用例的基底帖必须先落库（空 media_ids 的已发布帖）',
    );
    const raceMedia = [await newMedia(raceOwner, 'race1'), await newMedia(raceOwner, 'race2')];

    // 同步装置：blocker 先持住帖子行的 FOR SHARE，让两笔认领都读到 revision=1 之后才放行。
    // 这样「删掉帖子级保护 ⇒ 两笔都成功」是**确定性**读数，不靠调度运气
    // （plain SELECT 不被 FOR SHARE 挡，所以两笔都能先读到 revision=1 再去抢 UPDATE）。
    const raceBlocker = new pg.Client({ connectionString: url.href });
    await raceBlocker.connect();
    let raceSettled = null;
    try {
      const raceBlockerPid = (await raceBlocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await raceBlocker.query('BEGIN');
      await raceBlocker.query('SELECT 1 FROM public.community_posts WHERE id = $1::uuid FOR SHARE', [racePost]);
      // 与 `PATCH /posts/:id` 同一条生产存储调用（`community/service.ts:1257` 的 `commitPostIfCurrent`）：
      // 两笔都带 `expected.revision = 1`，都提交 revision=2 + 各自的 media_ids —— 都想当唯一赢家。
      const attemptAttach = async (mediaId) => {
        const result = await community.commitPostIfCurrent(
          racePost,
          { revision: 1 },
          { revision: 2, media_ids: [mediaId], updated_at: LATER },
          null,
        );
        return { ok: result.ok === true, reason: result.ok === true ? null : result.reason };
      };
      const inFlight = Promise.all([attemptAttach(raceMedia[0]), attemptAttach(raceMedia[1])]);
      // 等两笔都进到「在飞行中」（被行锁挡住 / 正在跑）；不计入 blocker 与本次探测连接。
      let running = 0;
      for (let i = 0; i < 100 && running < 2; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        running = (await owner.query(
          `SELECT count(*)::int AS n
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND pid <> $1::int
              AND state <> 'idle'`,
          [raceBlockerPid],
        )).rows[0].n;
      }
      await raceBlocker.query('COMMIT');
      raceSettled = await inFlight;
      assert.ok(running >= 2, `两笔认领必须同时在飞行中（实际 ${running}）：否则并发用例退化成串行，测不到帖子级互斥`);
    } finally {
      await raceBlocker.end();
    }

    const raceWins = raceSettled.filter((row) => row.ok === true);
    const raceSummary = JSON.stringify(raceSettled);
    assert.equal(raceWins.length, 1, `同一帖子并发挂两张不同的图必须恰好 1 笔成功，实际 ${raceWins.length} 笔成功（${raceSummary}）`);
    const raceLoss = raceSettled.find((row) => row.ok !== true);
    // 只判 `{ ok: false, reason: 'REVISION_CHANGED' }`：`commitPostIfCurrent` 是**返回值**型原语
    // （`services/api/src/community/store-pg.ts` 里 revision CAS 不符直接 `return { ok:false,
    // reason:'REVISION_CHANGED' }`，见 `:630`；调用方 `community/service.ts:1263` 才把它折成
    // ApiError），这条调用形状下**不会抛 ApiError** ⇒ `error.code` / `error.details` / `status === 409`
    // 三支永远取不到（#1037 审查 P3-a：那是死判据）。宽判据还有第二个坏处：失败原因漂成
    // `post_image_limit` 之类的也照样绿 —— 这里把 reason 钉死，输了就必须是 CAS 输的。
    assert.deepEqual(
      raceLoss,
      { ok: false, reason: 'REVISION_CHANGED' },
      `失败那笔必须是 revision CAS 的 REVISION_CHANGED（不是 409 / post_image_limit），实际 ${raceSummary}`,
    );
    const raceRows = await attached(racePost);
    const racePostRow = (await owner.query('SELECT revision, media_ids FROM public.community_posts WHERE id = $1::uuid', [racePost])).rows[0];
    assert.equal(raceRows.length, 1, `事后 post_media_attachments 里该帖只许有 1 行，实际 ${raceRows.length} 行`);
    assert.equal(racePostRow.revision, 2, '恰好一笔赢家推进到 revision=2（失败那笔整笔回滚，不再推进）');
    assert.equal(racePostRow.media_ids.length, 1, `事后 community_posts.media_ids 长度必须是 1，实际 ${JSON.stringify(racePostRow.media_ids)}`);
    assert.deepEqual(raceRows.map((row) => row.media_id), racePostRow.media_ids, '挂载行与 media_ids 必须是同一张图');
    assert.equal(raceRows[0].ordinal, 1, '唯一赢家的图落在 ordinal=1');
    const raceLoserMedia = raceMedia.find((mediaId) => mediaId !== racePostRow.media_ids[0]);
    assert.equal(
      (await owner.query('SELECT count(*)::int AS n FROM public.post_media_attachments WHERE media_id = $1::uuid', [raceLoserMedia]))
        .rows[0].n,
      0,
      '失败那笔必须整笔回滚：它那张图不得留下任何挂载行',
    );
    say('⑩ 同帖并发挂不同的图：两笔都带 revision=1 ⇒ 恰好 1 笔成功、1 笔 REVISION_CHANGED；挂载行=1、media_ids 长度=1（per-media 锁挡不住这个，帖子级行锁 + revision CAS 才挡得住）');

    // ---- 14. ⑪ 计数事实源的 owner_id / state 过滤：行为级负控制 -------------------
    // 现状：`tests/unit/post-media-attachments.test.mjs:562-567` 的五条 SQL 文本正则里**没有**
    // `owner_id`，`state IN (…)` 也只被正则扫过 —— 两条过滤删掉后单测仍然全绿。这里让它们各自
    // 承担一次**真实的上传配额判定**：`createAppMediaService` 的 `initiateUpload`（与
    // `POST /api/v1/media/uploads` 同一方法、同一个 `defaultAttachmentCounter` 装配）在真库上先数
    // 待用池再校验；删掉哪条过滤，下面哪一条 201 就会变成 400 `post_image_limit`。
    // ⚠️ **落点更正**（#1037 审查 `8a70cec3` 的真库全量跑实测；作者 PR 自述把落点记错了）：删 `owner_id`
    // 过滤的**首个红灯不在本节**，而在既有第 7 节 `:280` —— 那里 `countPendingCommunityImages(userC)`
    // 会读到 `actual 5, expected 0`（A 名下 5 张待用媒体被算进了 C 的池子），全量跑根本走不到本节。
    // 本节这两条 201/400 断言是**第二道**防线（把第 7 节那两条计数断言拿掉时才轮到它咬住；
    // 实测：注掉之后同一个变异改红在本节的待用池基线断言 —— `actual 25, expected 2`）。
    // ⚠️ 计数闸门：本两节目前无 CI 计数闸门覆盖（读数闸门仍是 `-lt 13`，详见第 13 节节头）。
    // 上限一律从常量派生、⛔ 不硬编码 2/3/4（#1037 审查 P3-b）：
    // `packages/media/constants.mjs:75` 的 `COMMUNITY_MAX_IMAGES_PER_POST` 是上传侧配额的唯一权威
    // （`services/api/src/media/service.ts` 也是 import 同一个常量），写死数字会在常量改动后变成
    // 「测的是旧上限，真上限早变了」的假绿。
    const maxPerPost = COMMUNITY_MAX_IMAGES_PER_POST;
    const { createAppMediaService, approveRealMediaWiring } = await import('../../services/api/src/media/service.ts');
    const { createS3CompatibleObjectStore } = await import('../../services/api/src/media/object-store.ts');
    // 上传路径要先占幂等台账 `public.idempotency_keys`（0008，只依赖 0001）：本脚本的迁移子集里没有它，
    // 这里单独补 apply；⛔ 不改上面 144-154 行对既有子集的断言（也不引入第二个「子集声明」形态）。
    const idempotencyLedger = discoverMigrations().find((migration) => migration.version === '0008');
    assert.ok(idempotencyLedger !== undefined, '迁移 0008（幂等台账 public.idempotency_keys）必须存在');
    assert.deepEqual(
      (await applyMigrations(owner, [idempotencyLedger])).applied,
      ['0008'],
      '上传路径需要 0008 的幂等台账（只依赖 0001）',
    );
    const uploadObjectStore = createS3CompatibleObjectStore({
      endpoint: 'https://cos.ap-shanghai.myqcloud.com',
      bucket: 'gengyun-media-placeholder',
      accessKey: 'synthetic-access-key-id',
      secretKey: 'synthetic-secret-key-value',
      region: 'ap-shanghai',
      forcePathStyle: false,
    });
    const uploader = createAppMediaService({
      executionMode: 'real',
      objectStore: uploadObjectStore,
      tokenSecret: 'gy-r87-integration-upload-secret',
      persistence: media,
      realMediaApproval: approveRealMediaWiring({
        reason: 'tests/integration/post-media-attachments-pg.mjs：owner_id / state 过滤的行为级负控制',
      }),
    });
    assert.equal(uploader.failClosedReason, null, `real 媒体域必须装配成功，实际 fail-closed：${uploader.failClosedReason}`);
    const uploadAs = (ownerId, idempotencyKey) =>
      uploader.initiateUpload({
        actor: { ownerId, authEpoch: 1, sessionRef: 'gy-r87-i30' },
        input: { purpose: 'community_image', mime: 'image/jpeg', bytes: 2048, sha256: 'a'.repeat(64) },
        idempotencyKey,
      });
    const rejectsUploadWithLimit = async (run, label) => {
      let captured = null;
      try {
        await run();
      } catch (error) {
        captured = error;
      }
      assert.notEqual(captured, null, `${label}：必须被拒（400 post_image_limit），但上传成功了`);
      assert.equal(captured.status, 400, `${label}：HTTP 面必须是 400，实际 ${captured.status}`);
      assert.equal(captured.code, 'INVALID_REQUEST', `${label}：信封码必须是 INVALID_REQUEST，实际 ${captured.code}`);
      assert.deepEqual(
        captured.details,
        [{ field: '/purpose', code: 'post_image_limit' }],
        `${label}：details 必须是既有的 post_image_limit`,
      );
    };
    const newMediaInState = async (ownerId, ordinalTag, state) => {
      const id = randomUUID();
      await owner.query(
        `INSERT INTO public.media (id, owner_id, purpose, mime, bytes, sha256, state, object_ref_cipher)
         VALUES ($1::uuid, $2::uuid, 'community_image', 'image/jpeg', 2048, repeat('a', 64), $3::media_state, $4)`,
        [id, ownerId, state, `v1:gy-r87-${ordinalTag}`],
      );
      return id;
    };

    // 支一（owner_id）：A 名下 `maxPerPost-1` 张待用；B 名下 `maxPerPost` 张待用。若计数不按 owner_id
    // 收口，A 一上传就会看到 `(maxPerPost-1) + maxPerPost ≥ maxPerPost` ⇒ 被错误拒；正确实现下
    // A 的第 `maxPerPost` 张必须放行、第 `maxPerPost+1` 张才该拒。
    const quotaOwner = randomUUID();
    const foreignOwner = randomUUID();
    for (const id of [quotaOwner, foreignOwner]) {
      await owner.query("INSERT INTO public.users (id, state, nickname) VALUES ($1::uuid, 'active', 'gy-r87')", [id]);
    }
    for (let i = 1; i < maxPerPost; i += 1) await newMedia(quotaOwner, `quota-a${i}`);
    for (let i = 1; i <= maxPerPost; i += 1) await newMedia(foreignOwner, `quota-b${i}`);
    assert.equal(await media.countPendingCommunityImages(quotaOwner), maxPerPost - 1, `A 的待用池基线只有自己的 ${maxPerPost - 1} 张`);
    assert.equal(await media.countPendingCommunityImages(foreignOwner), maxPerPost, `B 的待用池是自己的 ${maxPerPost} 张（都未挂载）`);
    const quotaThird = await uploadAs(quotaOwner, 'gy-r87-quota-third-1');
    assert.equal(quotaThird.status, 201, `别人名下的 ${maxPerPost} 张 ready 不得占 A 的名额：A 的第 ${maxPerPost} 张必须 201`);
    const quotaThirdRow = (await owner.query('SELECT owner_id::text AS owner_id, state FROM public.media WHERE id = $1::uuid', [quotaThird.media.id]))
      .rows[0];
    assert.equal(quotaThirdRow.owner_id, quotaOwner, '新落的媒体必须在上传者名下');
    assert.equal(quotaThirdRow.state, 'initiated', '上传只落 initiated（真库真行）');
    assert.equal(await media.countPendingCommunityImages(quotaOwner), maxPerPost, `刚落的 initiated 也占 A 的名额（待用池 ${maxPerPost}）`);
    await rejectsUploadWithLimit(() => uploadAs(quotaOwner, 'gy-r87-quota-fourth-1'), `A 的第 ${maxPerPost + 1} 张`);
    say(`⑪ owner_id：B 名下 ${maxPerPost} 张 ready 不占 A 的名额（A 第 ${maxPerPost} 张 201、第 ${maxPerPost + 1} 张 400）；删掉 owner_id 过滤 ⇒ 第 ${maxPerPost} 张即 400`);

    // 支二（state）：C 名下 `maxPerPost-1` 张 ready + 1 张 state=deleted（未挂载、且在 24h 窗口内）。
    // `deleted` 不在 `state IN ('initiated','uploaded','processing','ready')` 里 ⇒ 不占名额；
    // 删掉这条过滤，C 的第 `maxPerPost` 张就会被错误 400。
    const stateOwner = randomUUID();
    await owner.query("INSERT INTO public.users (id, state, nickname) VALUES ($1::uuid, 'active', 'gy-r87')", [stateOwner]);
    for (let i = 1; i < maxPerPost; i += 1) await newMedia(stateOwner, `state-r${i}`);
    const unusableMedia = await newMediaInState(stateOwner, 'state-deleted1', 'deleted');
    assert.equal(await media.countPendingCommunityImages(stateOwner), maxPerPost - 1, 'state=deleted 的媒体不得算进待用池');
    const stateThird = await uploadAs(stateOwner, 'gy-r87-state-third-1');
    assert.equal(stateThird.status, 201, `state=deleted 的媒体不得占名额：C 的第 ${maxPerPost} 张必须 201`);
    assert.equal(await media.countPendingCommunityImages(stateOwner), maxPerPost, `待用池 = ${maxPerPost - 1} 张 ready + 刚落的 1 张（deleted 仍不计）`);
    await rejectsUploadWithLimit(() => uploadAs(stateOwner, 'gy-r87-state-fourth-1'), `C 的第 ${maxPerPost + 1} 张`);
    const unusableRow = (await owner.query('SELECT state FROM public.media WHERE id = $1::uuid', [unusableMedia])).rows[0];
    assert.equal(unusableRow.state, 'deleted', '那条不可用媒体仍在库里（不是被物理删掉才「不计」）');
    say(`⑪ state：state=deleted 的媒体不占名额（第 ${maxPerPost} 张 201、第 ${maxPerPost + 1} 张 400）；删掉 state IN (…) ⇒ 第 ${maxPerPost} 张即 400`);

    console.log(`OK ${passed} 项真库断言全部通过（PostgreSQL ${version}）`);
  } finally {
    if (pool !== null) await pool.end();
    await owner.end();
  }
}

await main();
