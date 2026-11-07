// GY-R83 #1030：**帖子级媒体挂载**（`public.post_media_attachments`）的单元判据。
//
// 为什么需要本文件：`real` 模式下「每帖 ≤3 张图」过去只能靠「同一 owner 名下存活记录数」近似，
// 那是**生命周期累计**口径（`services/api/src/media/service.ts:835-838` 明文禁止：累计数会让用户
// 传满 3 张后永久锁死，且「先数后写」之间有 TOCTOU）。本片把上限搬到**结构约束**：发帖事务里按
// `media_ids` 的数组顺序 `INSERT … ordinal = row_number()`；第 4 张先撞 `0022` 的
// `community_posts_media_ids_max`（数组长度 ≤3），绕过数组列直插挂载行时才撞 `CHECK (ordinal BETWEEN 1 AND 3)`。
// 于是「认领」这件事本身必须先被钉住，否则集成测试绿了也只说明跑通过一次。
//
// 本文件钉四件事（都不需要真 PG）：
//   1. 认领**按数组顺序**、`ordinal` 从 1 开始（SQL 走 `unnest(...) WITH ORDINALITY` + `row_number()`，
//      且 uuid 只走**绑定参数**，不拼字面量）；
//   2. 第 4 张（`23514` = CHECK 违反）与同帖重复（`23505` = 唯一键）都必须映射成**既有的 400 信封**
//      `INVALID_REQUEST` + `details[0].code = 'post_image_limit'`——⛔ 不新造 `POST_IMAGE_LIMIT` 这个
//      ErrorCode（`services/api/src/contract.ts:14-31` 的 `ERROR_STATUS_MAP` 里没有它）；
//   3. 「挂不上」（不存在／非本人／已挂别帖）不许静默少挂一张：整笔失败，details 码是 `media_not_attachable`；
//   4. 计数口：**没有 post 上下文时仍然返回 `null`**（继续 `unwired` 503 fail-closed），只有装配层真的给了
//      能判定待用池的持久化端口才切到 `postgres` 计数器；`42P01`（0056 未 apply）必须折叠成 `null`，
//      ⛔ 不得降级成 0（降级成 0 就是放行）。
//
// 负控制（改坏任一处，本文件必须失败）：
//   - 把认领改回「先查 count 再写」⇒ 用例 1 的语句序列多出一条 SELECT；
//   - 去掉认领前的 `pg_advisory_xact_lock` ⇒ 用例 1 的语句序列少一条（集成并发探针同时会红：
//     同一张图能同时挂在两个存活帖上，PK/UNIQUE 都不跨帖）；
//   - 把空数组也照发一条认领语句 ⇒ 用例 1 断言 `business.length === 3` 失败（既有契约测试同理判红）；
//   - 把 23514／23505 映射成 503 或新错误码 ⇒ 用例 2／3 失败；
//   - 把「挂不上」改成静默跳过 ⇒ 用例 4 失败；
//   - 让 `unwired` 计数器改口返回 0（放行）⇒ 用例 5 失败；
//   - 让 `42P01` 折叠成 0 ⇒ 用例 6 失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPostgresCommunityStore } from '../../services/api/src/community/store-pg.ts';
import { createPostgresMediaStore } from '../../services/api/src/media/store-pg.ts';
import { createS3CompatibleObjectStore } from '../../services/api/src/media/object-store.ts';
import {
  approveRealMediaWiring,
  createAppMediaService,
  createUnwiredAttachmentCounter,
} from '../../services/api/src/media/service.ts';

const POST_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const AUTHOR = '11111111-1111-4111-8111-111111111111';
const MEDIA_A = 'bbbbbbbb-1111-4111-8111-111111111111';
const MEDIA_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const MEDIA_C = 'bbbbbbbb-3333-4333-8333-333333333333';
const MEDIA_D = 'bbbbbbbb-4444-4444-8444-444444444444';
const CREATED_AT = 1_700_000_000_000;
const UPDATED_AT = 1_700_000_100_000;

const TRANSACTION_CONTROL = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', "SET LOCAL lock_timeout = '4s'"]);
const flat = (text) => String(text).replace(/\s+/g, ' ').trim();

/**
 * 记录型假池：`script[i]` 是第 i 条**业务**语句的回答（行数组 / 函数 / Error）。
 * 事务控制语句自动回空行但仍被记录 ⇒「事务里发了几条语句」照样可断言；脚本用尽即抛。
 */
function fakePool(script = []) {
  const calls = [];
  let index = 0;
  const handle = async (text, values) => {
    calls.push({ text, values });
    if (TRANSACTION_CONTROL.has(flat(text))) return { rows: [] };
    const step = script[index];
    index += 1;
    if (step === undefined) {
      throw new Error(`假池脚本已用尽（第 ${index} 条业务语句）：${flat(text)}`);
    }
    const response = typeof step === 'function' ? step({ text, values }) : step;
    if (response instanceof Error) throw response;
    return { rows: response };
  };
  return {
    calls,
    query: handle,
    async connect() {
      return { query: handle, release() {} };
    },
    statements: () => calls.map((call) => flat(call.text)),
    business: () => calls.map((call) => flat(call.text)).filter((sql) => !TRANSACTION_CONTROL.has(sql)),
    businessCalls: () => calls.filter((call) => !TRANSACTION_CONTROL.has(flat(call.text))),
  };
}

/** 与 `pg` 返回同形的帖子行（timestamptz 给 Date）。 */
const postRow = (overrides = {}) => ({
  id: POST_ID,
  revision: 1,
  author_id: AUTHOR,
  title: '春小麦除草',
  body: '正文',
  crop_id: 'crop-1',
  region_code: '330100',
  media_ids: [],
  linked_knowledge_type: null,
  linked_knowledge_id: null,
  linked_knowledge_revision: null,
  visibility: 'published',
  audit_state: 'approved',
  created_at: new Date(CREATED_AT),
  updated_at: new Date(UPDATED_AT),
  ...overrides,
});

const postRecord = (overrides = {}) => ({
  id: POST_ID,
  revision: 1,
  author_id: AUTHOR,
  title: '春小麦除草',
  body: '正文',
  crop_id: 'crop-1',
  region_code: '330100',
  media_ids: [],
  linked_knowledge_ref: null,
  visibility: 'published',
  audit_state: 'approved',
  created_at: CREATED_AT,
  updated_at: UPDATED_AT,
  ...overrides,
});

/** 合成 `s3_compatible` 端口：构造是纯本地计算，`externalRequestCount` 恒为 0（不发请求）。 */
function syntheticS3() {
  return createS3CompatibleObjectStore({
    endpoint: 'https://cos.ap-shanghai.myqcloud.com',
    bucket: 'gengyun-media-placeholder',
    accessKey: 'synthetic-access-key-id',
    secretKey: 'synthetic-secret-key-value',
    region: 'ap-shanghai',
    forcePathStyle: false,
  });
}

// ---------------------------------------------------------------------------
// 1. 认领映射：按 media_ids 顺序，ordinal 从 1 开始
// ---------------------------------------------------------------------------
test('insertPost：media_ids 按数组顺序认领，ordinal 由 row_number() 从 1 起（uuid 只走绑定参数）', async () => {
  const pool = fakePool([[{ id: POST_ID }], [], [{ declared: '3', claimed: '3' }]]);
  const store = createPostgresCommunityStore({ pool });
  const mediaIds = [MEDIA_C, MEDIA_A, MEDIA_B];

  assert.equal(await store.insertPost(postRecord({ media_ids: mediaIds }), null), true);

  const business = pool.business();
  assert.equal(business.length, 3, '无图之外只允许「INSERT 帖子 + 加锁 + 认领」三条业务语句（不许多查一次计数）');
  assert.ok(business[0].startsWith('INSERT INTO community_posts'), business[0].slice(0, 60));
  assert.ok(business[1].startsWith('WITH ordered AS MATERIALIZED'), business[1].slice(0, 60));
  assert.ok(business[2].startsWith('WITH input AS'), business[2].slice(0, 60));

  // 加锁必须在认领**之前**、且按 media_id 升序逐把取（否则两笔事务可能各判「没人挂」后各插一行）。
  const lock = business[1];
  assert.match(lock, /pg_advisory_xact_lock\(hashtext\(lower\(ordered\.media_id\)\)\)/, '跨帖互斥只能靠 advisory lock，且锁键必须 lower()：`::uuid` 比较不分大小写而 `hashtext` 分，一大写一小写会拿两把锁');
  assert.match(lock, /ORDER BY 1/, '必须按 media_id 定序加锁，避免两笔事务反向互等');
  assert.match(lock, /FROM ordered ORDER BY ordered\.media_id/, '外层也要显式 ORDER BY，⛔ 不靠 MATERIALIZED CTE 的扫描顺序');
  assert.match(lock, /DISTINCT/, '同一帖里重复的 media 不该取第二把锁');
  const lockCall = pool.businessCalls()[1];
  assert.deepEqual(lockCall.values, [mediaIds], '加锁语句同样只收绑定参数（数组原序交给 ORDER BY 定序）');

  const claim = business[2];
  assert.match(claim, /unnest\(\$2::text\[\]\) WITH ORDINALITY/, '顺序只能来自数组序位，不能靠 id 排序');
  assert.match(claim, /row_number\(\) OVER \(ORDER BY t\.ord\)::smallint AS ordinal/, 'ordinal 必须是 1..n 的稠密序号');
  assert.match(claim, /INSERT INTO post_media_attachments \(post_id, media_id, ordinal\)/);
  assert.match(claim, /RETURNING ordinal/);
  assert.match(
    claim,
    /SELECT coalesce\(array_length\(\$2::text\[\], 1\), 0\) AS declared/,
    'declared 必须数**传入**的数组长度，不能数正则过滤后的 input（否则非法 uuid 会被静默少挂）',
  );

  const claimCall = pool.businessCalls()[2];
  assert.deepEqual(claimCall.values, [POST_ID, mediaIds, AUTHOR], '绑定参数必须是 (postId, mediaIds 原序, ownerId)');
  assert.equal(claimCall.values[1][0], MEDIA_C, '数组顺序必须原样传给 unnest（不许排序/去重）');
  for (const id of mediaIds) {
    assert.equal(claim.includes(id), false, `认证的 uuid 不得进 SQL 文本（只能走绑定参数）：${id}`);
  }
  assert.equal(claim.includes(POST_ID), false, 'postId 同样只走绑定参数');
});

test('insertPost：media_ids 为空 ⇒ 一条认领语句都不发（既有语句序列契约不变）', async () => {
  const pool = fakePool([[{ id: POST_ID }]]);
  const store = createPostgresCommunityStore({ pool });

  assert.equal(await store.insertPost(postRecord(), null), true);
  assert.equal(pool.business().length, 1, '空数组时只允许 INSERT 帖子这一条');
});

// ---------------------------------------------------------------------------
// 2. 第 4 张：结构约束拒绝 ⇒ 400 post_image_limit
// ---------------------------------------------------------------------------
test('第 4 张：CHECK(ordinal BETWEEN 1 AND 3) 违反（23514）⇒ 400 INVALID_REQUEST / post_image_limit，且整笔回滚', async () => {
  const violation = Object.assign(
    new Error('new row for relation "post_media_attachments" violates check constraint "post_media_attachments_ordinal_range"'),
    { code: '23514' },
  );
  const pool = fakePool([[{ id: POST_ID }], [], violation]);
  const store = createPostgresCommunityStore({ pool });

  await assert.rejects(
    () => store.insertPost(postRecord({ media_ids: [MEDIA_A, MEDIA_B, MEDIA_C, MEDIA_D] }), null),
    (error) => {
      assert.equal(error.code, 'INVALID_REQUEST', '必须是既有的 400 信封，⛔ 不新造 POST_IMAGE_LIMIT');
      assert.equal(error.status, 400);
      assert.match(error.message, /最多 3 张/);
      assert.deepEqual(error.details, [{ field: '/media_ids', code: 'post_image_limit' }]);
      return true;
    },
  );
  // 事务必须回滚：第 4 张失败时帖子行不能留在库里（否则「帖子在、图没挂」= 假成功）。
  const statements = pool.statements();
  assert.equal(statements.filter((sql) => sql === 'ROLLBACK').length, 1, '必须恰好发一次 ROLLBACK');
  assert.equal(statements.includes('COMMIT'), false, '失败事务不得 COMMIT');
  assert.equal(statements.at(-1), 'ROLLBACK', `最后一条必须是 ROLLBACK，实际：${statements.at(-1)}`);
});

test('第 4 张：迁移 0056 的结构约束原文必须是「ordinal 1..3」+「每帖序号唯一」（逐行、跳过注释）', () => {
  const migration = readFileSync(
    new URL('../../services/api/db/migrations/0056_post_media_attachments.sql', import.meta.url),
    'utf8',
  );
  // ⛔ 不能只对**全文** `assert.match`：0056 的头注释里就写着这两串字，把 DDL 那行注释掉也能绿
  // （PR #1037 审查 P1 实测：注释掉 UNIQUE、CHECK 放宽成 4，单测 13/13 + 集成 8/8 全绿）。
  // 所以先剥注释、再要求「约束名 + 定义」出现在**非注释行**上；行为面另由
  // `tests/integration/post-media-attachments-pg.mjs` 的直插探针钉（23514／23505 的真实报错）。
  // ⛔ 只剥 `--` 不够（PR #1037 第三轮审查 P1-3 实测）：`/* UNIQUE (post_id, ordinal) */` 与
  // `COMMENT ON COLUMN … IS '… UNIQUE (post_id, ordinal)'` 都能让只剥 `--` 的版本假绿，所以
  // ① 先用块注释正则整段删掉 `/* … */`（含跨行），② 再逐行剥 `--`，③ 最后禁止 `COMMENT ON`
  // （0056 全文没有 `/* */`，一行 `COMMENT ON` 就能把约束「描述」成存在）。
  // ⛔ 只剥 `--` 不够（PR #1037 第三轮审查 P1-3 实测）：`/* UNIQUE (post_id, ordinal) */` 与
  // `COMMENT ON COLUMN … IS '… UNIQUE (post_id, ordinal)'` 都能让只剥 `--` 的版本假绿，所以
  // ① 先按**嵌套深度**剥掉 SQL 注释（PG 支持 `/* /* */ */` 嵌套），② 再禁止 `COMMENT ON`
  // （0056 全文没有块注释，一行 `COMMENT ON` 就能把约束「描述」成存在）。
  // ⛔ 也不能用非贪婪正则 `/\/\*[\s\S]*?\*\//g`（PR #1037 第五轮审查 P2-a 实测）：
  // 它只吃到第一个 `*/`，把 `/* outer /* inner */ CONSTRAINT … UNIQUE … */` 的后半截当真实 DDL ⇒ 假绿；
  // PG 会把整段当注释，约束其实不存在。
  const stripSqlComments = (sql) => {
    const out = [];
    let depth = 0;
    let inString = false;
    for (let index = 0; index < sql.length; index += 1) {
      const ch = sql[index];
      const next = sql[index + 1];
      if (depth > 0) {
        if (ch === '/' && next === '*') {
          depth += 1;
          index += 1;
          continue;
        }
        if (ch === '*' && next === '/') {
          depth -= 1;
          index += 1;
          continue;
        }
        if (ch === '\n') out.push('\n');
        continue;
      }
      if (inString) {
        out.push(ch);
        if (ch === "'" && next === "'") {
          out.push(next);
          index += 1;
          continue;
        }
        if (ch === "'") inString = false;
        continue;
      }
      if (ch === "'") {
        inString = true;
        out.push(ch);
        continue;
      }
      if (ch === '-' && next === '-') {
        while (index < sql.length && sql[index] !== '\n') index += 1;
        out.push('\n');
        continue;
      }
      if (ch === '/' && next === '*') {
        depth = 1;
        index += 1;
        continue;
      }
      out.push(ch);
    }
    // 剥完还有未闭合的块注释 ⇒ 说明注释结构不合法（也别把残文当 DDL 读）
    assert.equal(depth, 0, '0056 的块注释必须闭合：⛔ 未闭合会让本判据把注释内容当成 DDL');
    return out.join('');
  };
  const ddl = stripSqlComments(migration)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

  assert.ok(
    !/COMMENT\s+ON/i.test(ddl),
    '0056 不得用 COMMENT ON 描述约束：约束必须是真 DDL，⛔ 不能只是一句注释文本',
  );
  assert.ok(
    /CONSTRAINT\s+post_media_attachments_ordinal_range\s+CHECK\s*\(\s*ordinal\s+BETWEEN\s+1\s+AND\s+3\s*\)/i.test(ddl),
    '「每帖 ≤3」的判定权在数据库，不在 JS：CHECK (ordinal BETWEEN 1 AND 3) 必须写在**非注释行**上',
  );
  assert.ok(
    /CONSTRAINT\s+post_media_attachments_post_ordinal_key\s+UNIQUE\s*\(\s*post_id\s*,\s*ordinal\s*\)/i.test(ddl),
    '序号唯一 ⇒ 同一帖的两个 ordinal=1 只能活一个（必须写在**非注释行**上）',
  );
  assert.ok(
    /CONSTRAINT\s+post_media_attachments_pkey\s+PRIMARY\s+KEY\s*\(\s*post_id\s*,\s*media_id\s*\)/i.test(ddl),
    '同一张图不许在同一帖出现两次（必须写在**非注释行**上）',
  );
  assert.equal(/REFERENCES\s+public\.media/i.test(ddl), false, '⛔ 不给 media(id) 加外键：media_ids 是引用串');
  assert.equal(/REFERENCES\s+public\.community_posts/i.test(ddl), false, '⛔ post 侧也不加外键');
});

// ---------------------------------------------------------------------------
// 3. 同帖重复（23505）与「挂不上」（declared ≠ claimed）
// ---------------------------------------------------------------------------
test('同一张图在同一帖重复（23505）⇒ 400 post_image_limit（不是 409、不是新错误码）', async () => {
  const duplicate = Object.assign(
    new Error('duplicate key value violates unique constraint "post_media_attachments_pkey"'),
    { code: '23505' },
  );
  const pool = fakePool([[{ id: POST_ID }], [], duplicate]);
  const store = createPostgresCommunityStore({ pool });

  await assert.rejects(
    () => store.insertPost(postRecord({ media_ids: [MEDIA_A, MEDIA_A] }), null),
    (error) => {
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.deepEqual(error.details, [{ field: '/media_ids', code: 'post_image_limit' }]);
      return true;
    },
  );
});

test('挂不上（不存在/非本人/已挂别帖）⇒ 整笔失败 media_not_attachable，不许静默少挂一张', async () => {
  const pool = fakePool([[{ id: POST_ID }], [], [{ declared: '2', claimed: '1' }]]);
  const store = createPostgresCommunityStore({ pool });

  await assert.rejects(
    () => store.insertPost(postRecord({ media_ids: [MEDIA_A, MEDIA_B] }), null),
    (error) => {
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.deepEqual(error.details, [{ field: '/media_ids', code: 'media_not_attachable' }]);
      return true;
    },
  );
  assert.ok(pool.statements().includes('ROLLBACK'), '少挂一张也必须回滚整笔事务');
});

// ---------------------------------------------------------------------------
// 4. 改稿：只有 media_ids 真的变了才「先删旧序号 → 再认领」
// ---------------------------------------------------------------------------
test('commitPost：media_ids 变了 ⇒ UPDATE → DELETE 旧序号 → 加锁 → 重认领（先删后认领，避免 UNIQUE(post_id, ordinal) 假冲突）', async () => {
  const pool = fakePool([[postRow({ media_ids: [MEDIA_A] })], [], [], [], [{ declared: '1', claimed: '1' }]]);
  const store = createPostgresCommunityStore({ pool });

  const result = await store.commitPostIfCurrent(
    POST_ID,
    { revision: 1 },
    { revision: 2, media_ids: [MEDIA_B], updated_at: UPDATED_AT },
    null,
  );
  assert.equal(result.ok, true, JSON.stringify(result));

  const business = pool.business();
  assert.equal(business.length, 5, `语句序列必须是 SELECT → UPDATE → DELETE → 加锁 → 认领，实际：${JSON.stringify(business.map((s) => s.slice(0, 30)))}`);
  assert.ok(business[1].startsWith('UPDATE community_posts'), business[1].slice(0, 40));
  assert.ok(business[2].startsWith('DELETE FROM post_media_attachments WHERE post_id = $1::uuid'), business[2]);
  assert.ok(business[3].startsWith('WITH ordered AS MATERIALIZED'), business[3].slice(0, 40));
  assert.ok(business[4].startsWith('WITH input AS'), business[4].slice(0, 40));
  assert.deepEqual(pool.businessCalls()[4].values, [POST_ID, [MEDIA_B], AUTHOR]);
});

test('commitPost：media_ids 没变 ⇒ 不发 DELETE、不发认领（CAS 改稿的语句序列不变）', async () => {
  const pool = fakePool([[postRow({ media_ids: [MEDIA_A] })], []]);
  const store = createPostgresCommunityStore({ pool });

  const result = await store.commitPostIfCurrent(
    POST_ID,
    { revision: 1 },
    { revision: 2, title: '换个标题', updated_at: UPDATED_AT },
    null,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(pool.business().length, 2, '只有 SELECT + UPDATE');
  assert.equal(
    pool.statements().some((sql) => sql.startsWith('DELETE FROM post_media_attachments')),
    false,
    '没换图就不该清挂载',
  );
});

// ---------------------------------------------------------------------------
// 5. 计数口：无 post 上下文仍然 null（unwired fail-closed），有持久化才查待用池
// ---------------------------------------------------------------------------
test('计数口：unwired 计数器对任何输入都返回 null（哪怕本地有 3 条存活记录）', () => {
  const counter = createUnwiredAttachmentCounter();
  assert.equal(counter.countFor({ ownerId: 'any-owner', liveCommunityImages: 3 }), null);
  assert.equal(counter.countFor({ ownerId: 'any-owner', liveCommunityImages: 0 }), null);
});

test('计数口：real 且没有持久化端口 ⇒ 仍是 unwired（今天的行为不变）', () => {
  const service = createAppMediaService({
    executionMode: 'real',
    objectStore: syntheticS3(),
    tokenSecret: 'synthetic-token-secret',
    realMediaApproval: approveRealMediaWiring({ reason: 'unit：装配自推计数器的判据' }),
  });
  assert.equal(service.attachmentCounter.kind, 'unwired');
  assert.equal(service.attachmentCounter.countFor({ ownerId: 'owner-1', liveCommunityImages: 3 }), null);
});

test('计数口：持久化端口能判定待用池 ⇒ postgres 计数器，且 null 原样透传（不降级成 0）', async () => {
  let seen = null;
  const persistence = {
    persistent: true,
    async countPendingCommunityImages(ownerId) {
      seen = ownerId;
      return pending;
    },
  };
  let pending = 2;
  const service = createAppMediaService({
    executionMode: 'real',
    objectStore: syntheticS3(),
    tokenSecret: 'synthetic-token-secret',
    realMediaApproval: approveRealMediaWiring({ reason: 'unit：装配自推计数器的判据' }),
    persistence,
  });

  assert.equal(service.attachmentCounter.kind, 'postgres');
  assert.match(service.attachmentCounter.note, /待用池/);
  assert.equal(await service.attachmentCounter.countFor({ ownerId: 'owner-1', liveCommunityImages: 99 }), 2);
  assert.equal(seen, 'owner-1', 'ownerId 必须原样传给持久化端口');

  pending = null;
  assert.equal(
    await service.attachmentCounter.countFor({ ownerId: 'owner-1', liveCommunityImages: 99 }),
    null,
    '判不了就是 null ⇒ 上层继续 503 fail-closed；⛔ 绝不能降级成 0',
  );
});

test('计数口：stub 模式不查库（仍是 substitute，按注入的 liveCommunityImages 走）', () => {
  const service = createAppMediaService({
    executionMode: 'stub',
    objectStore: syntheticS3(),
    tokenSecret: 'synthetic-token-secret',
  });
  assert.equal(service.attachmentCounter.kind, 'substitute');
  assert.equal(service.attachmentCounter.countFor({ ownerId: 'owner-1', liveCommunityImages: 2 }), 2);
});

// ---------------------------------------------------------------------------
// 6. 待用池计数 SQL：42P01（0056 未 apply）折叠成 null，不得降级成 0
// ---------------------------------------------------------------------------
test('countPendingCommunityImages：只数「24h 内未挂到未删除帖子」的在途图，42P01 ⇒ null', async () => {
  const calls = [];
  const pool = {
    async query(text, values) {
      calls.push({ text: flat(text), values });
      return { rows: [{ count: '2' }] };
    },
  };
  const store = createPostgresMediaStore({
    pool,
    cipher: { encryptObjectRef: (value) => value, decryptObjectRef: (value) => value },
  });

  assert.equal(await store.countPendingCommunityImages('owner-1'), 2);
  const sql = calls[0].text;
  assert.match(sql, /FROM public\.media m/, '待用池从 media 出发（不是从 owner 名下存活记录数出发）');
  assert.match(sql, /m\.state IN \('initiated',\s*'uploaded',\s*'processing',\s*'ready'\)/, '在途 + 已就绪未挂载都算占位');
  assert.match(sql, /interval '24 hours'/, '必须有自衰减窗口，否则「传满 3 张永久锁死」换了个样子回来');
  assert.match(sql, /NOT EXISTS \(\s*SELECT 1 FROM public\.post_media_attachments a/, '挂载即释放');
  assert.match(sql, /p\.visibility <> 'deleted'/, '删帖即释放');
  assert.deepEqual(calls[0].values, ['owner-1']);

  const missing = {
    async query() {
      throw Object.assign(new Error('relation "public.post_media_attachments" does not exist'), { code: '42P01' });
    },
  };
  const degraded = createPostgresMediaStore({
    pool: missing,
    cipher: { encryptObjectRef: (value) => value, decryptObjectRef: (value) => value },
  });
  assert.equal(
    await degraded.countPendingCommunityImages('owner-1'),
    null,
    '0056 未 apply ⇒ null（继续 503），⛔ 不是 0（0 就是放行）',
  );
});
