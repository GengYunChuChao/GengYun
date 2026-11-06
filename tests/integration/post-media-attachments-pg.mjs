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
 *   - 本脚本锁**只有 PG 能证明**的七件事：
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

    // ---- 10. ⑦ 并发：同一 media 不能同时挂两个存活帖（advisory lock 定序）----------
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

    console.log(`OK ${passed} 项真库断言全部通过（PostgreSQL ${version}）`);
  } finally {
    if (pool !== null) await pool.end();
    await owner.end();
  }
}

await main();
