/**
 * GY-I16（#16）· 收藏与识别历史的 **真库持久化**集成验收（PG17）。
 *
 * Destructive only in a fresh, explicit, loopback `/gengyun_favorites_history_test` database
 * （同仓既有 `tests/integration/*-pg.mjs` 口径：只碰**专用**测试库，账号/目标/内容全为合成）。
 *
 * 覆盖（全部为实测断言，不是推断）：
 *   1. `0018_favorites_history.sql` 在真库应用成功、**重复应用 no-op**、回滚脚本能整表拆干净；
 *   2. 写入 → 读回（收藏 / 历史两种行，含 `job_state` 失败终态原样保留）；
 *   3. 去重**由数据库唯一约束裁决**：同 `id`／同 `(owner,target)`／同 `(owner,event_key)` ⇒ `duplicate` 且行数不增；
 *   4. CAS 删除：版本不符 ⇒ `REVISION_CHANGED`、他人 ⇒ `OWNER_CHANGED`、不存在 ⇒ `NOT_FOUND`、命中 ⇒ 物理删除；
 *   5. 他人 id 与"不存在"在 HTTP 面**同形**（404 `NOT_FOUND`，不泄露存在性）；
 *   6. 幂等台账**真落库**（`claim/complete/release/过期清理`），且 `awaitIdempotencySettled`
 *      能被**另一条独立连接**写入的结果唤醒 ⇒ 证明它每次真读库、不是进程内 Map 假装；
 *   7. 注销清空 `deleteAllByOwner` 返回**真实删除行数**（收藏与历史各一次，他人行不受影响）；
 *   8. 进程重连（关掉连接池再新建）后数据仍在；
 *   9. 注销清空覆盖**幂等台账**（监工 P1 返修）：A 的四张表残留均 0（含未完成 claim、未过期行），
 *      B 的四张表逐表与删除前相等，证据里可见两张台账各清了几行。
 *  10. **收藏域真 HTTP + 真 SQL 对账**（R31-I16 补，2026-10-22）：新增 ⇒ 201 且 `count(*)` 0→1 且库里那行
 *      的 `id` 就是 HTTP 回给客户端的 `id`；同幂等键 + 同体重放 ⇒ 读数（`id`/`revision`/`created_at`）与
 *      行数都不变、台账恰好 1 行且 `outcome` 指向同一行；同键不同体 ⇒ 409 `IDEMPOTENCY_CONFLICT` 且**不建行**；
 *      `limit=2` 逐页翻到 `next_cursor=null`，id 序列与 `ORDER BY created_at DESC, id DESC` 的 SQL 结果
 *      **逐项相等**；删除 ⇒ 行数 −1，再用**新键**删同一 id ⇒ 404 且与"从未存在"逐字同形。
 *  11. **历史域真 HTTP + 真 SQL 对账**：`appendHistory` 内部口追加 ⇒ `created=true` 且 `count(*)` +1、
 *      HTTP 列表里出现同一 `id`；同 `(owner,event_key)` 重复（**换一个目标**）⇒ `created=false`、行数不变、
 *      第二目标未落库（证明是 event_key 这道键裁决）；游标翻页无重复无遗漏、末页 `next_cursor=null`、
 *      与 SQL 逐项相等；`DELETE /history/{id}` ⇒ 202 + `X-GY-Cascade` 披露，再删同一 id 与"从未存在"同形 404，
 *      他人 id 也同形（不泄露存在性）。
 *  12. **迁移旁证（0008）**：`0018` 回滚后本片 4 张表消失，而 `users`（0001）与 `idempotency_keys`（0008）
 *      的列定义与行内容**逐字仍在**；删掉台账行后 **REPLAY** `0018` ⇒ 4 张表再出现，两张旁证表仍逐字不变。
 *  13. **非空证明开关**（`GY_I16_FORCE_MEMORY=1`，默认关闭，⛔ 不得接门禁）：把装配换成一张"自称
 *      `persistent: true`"的**内存** store 再跑本文件 ⇒ 第 10 组「HTTP 新增后真库行数 0→1」必红
 *      （点名的是读数本身，不是夹具装配失败）。反向控制的原始输出见
 *      `docs/verification/gy-r31-i16-pg-arm-20261022.md`。
 *
 * 运行（两种入口等价，**argv 优先**，env 兜底）：
 *   `node tests/integration/favorites-history-pg.mjs postgres://postgres@127.0.0.1:55724/gengyun_favorites_history_test`
 *   `FAVORITES_HISTORY_PG_TEST_URL=postgres://…/gengyun_favorites_history_test node tests/integration/favorites-history-pg.mjs`
 * 两个入口都没给 ⇒ 打印 `SKIP` 并以 **77** 退出（POSIX「skipped」）：本次运行**没有**验证真库（不是通过）。
 *   本机明知无真库、只想看跳过原因时可显式加 `--allow-skip`（或 `GY_ALLOW_SKIP=1`）取 0 —— ⛔ 不得用于门禁。
 * `npm run test:integration:http` 不包含本文件（它需要真库），需显式运行。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../../services/api/src/db/pool.ts';
import { applyMigrations, discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createPostgresFavoritesStore } from '../../services/api/src/favorites/store-pg.ts';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createPostgresHistoryStore } from '../../services/api/src/history/store-pg.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createSubstituteMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createUserDataDeletion } from '../../services/api/src/privacy/user-data-deletion.ts';

const ENV = 'FAVORITES_HISTORY_PG_TEST_URL';
// 连接串：**argv 优先**（第一个不以 `-` 开头的参数），env 兜底（`real-pg-integration.yml` 现状走 env）。
const ARGV_URL = process.argv.slice(2).find((arg) => !arg.startsWith('-')) ?? '';
const raw = ARGV_URL !== '' ? ARGV_URL : (process.env[ENV] ?? '');
const URL_SOURCE = ARGV_URL !== '' ? 'argv[1]' : `env ${ENV}`;
// 缺真库时的出口：默认 77（未取得，不是通过）；只有显式 `--allow-skip` / `GY_ALLOW_SKIP=1` 才降级为 0。
const ALLOW_SKIP = process.argv.includes('--allow-skip') || process.env.GY_ALLOW_SKIP === '1';
/**
 * **非空证明**开关（反向控制；默认关闭）。
 *
 * 打开后只用**内存** store 冒充持久装配（并把 `persistent` 改成 `true` 以便绕开 `real` 模式的服务门禁），
 * 本文件的"真库行数"读数随即不成立 ⇒ 必须变红。这是"0 失败不是空跑"的自证手段，
 * ⛔ 不得写进任何 workflow / 门禁脚本（它与 `real-pg-integration.yml` 的绿是互斥的）。
 */
const FORCE_MEMORY = process.env.GY_I16_FORCE_MEMORY === '1';
if (raw === '') {
  // 显式跳过并打印：**不得**被当成"真库已验证"（绿），也不静默失败。
  console.log(`SKIP real PG17: 未给连接串（argv[1] 与 ${ENV} 皆空）—— 本次运行没有验证真库持久化（不是通过，也不是失败）。`);
  console.log('     运行方式：node tests/integration/favorites-history-pg.mjs postgres://postgres@127.0.0.1:55724/gengyun_favorites_history_test');
  console.log(`     或：${ENV}=postgres://postgres@127.0.0.1:55724/gengyun_favorites_history_test node tests/integration/favorites-history-pg.mjs`);
  if (ALLOW_SKIP) {
    console.log('EXITCODE=0（--allow-skip / GY_ALLOW_SKIP=1 已显式授权：仅本机开发，⛔ 不得接进门禁）。');
    process.exit(0);
  }
  console.log('EXITCODE=77 表示未取得，不是通过（POSIX 惯例 skipped；本机明知无真库时可显式加 --allow-skip 取 0）。');
  process.exit(77);
}

const url = new URL(raw);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'postgres URL only');
assert.equal(url.search, '', '不要把参数塞进连接串（测试库校验只认 pathname）');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'loopback only');
assert.equal(url.pathname, '/gengyun_favorites_history_test', 'dedicated test DB only');
console.log(`Real PostgreSQL URL source: ${URL_SOURCE} ⇒ ${url.host}${url.pathname}（库名硬钉、回环 only、不带参数）`);
if (FORCE_MEMORY) {
  console.log('REVERSE CONTROL: GY_I16_FORCE_MEMORY=1 ⇒ 装配改用内存 store（本轮的"真库行数"读数必须变红）。');
}

const sqlFile = (path) => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');
let passed = 0;
const say = (message) => {
  passed += 1;
  console.log(`PASS ${passed}: ${message}`);
};

const owner = new pg.Client({ connectionString: url.href });
await owner.connect();
let pool = null;
let app = null;
try {
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  assert.match(version, /^17\./, 'requires PostgreSQL 17');
  console.log(`Real PostgreSQL patch: ${version}`);
  assert.equal(
    (await owner.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n,
    0,
    'fresh DB required（专用测试库必须是空的）',
  );

  // ---- 1. 迁移应用 / 重复应用 / 回滚 -------------------------------------
  // 0008 是为了给"回滚 0018 不得波及旁人"一个**真实旁证**：它只新增 `idempotency_keys`，
  // 且不引用 0003–0007（见 `services/api/db/migrations/0008_auth_session.sql`）⇒ 可以单独与本片同库。
  const migrations = discoverMigrations().filter((m) => ['0001', '0008', '0018'].includes(m.version));
  assert.deepEqual(
    migrations.map((m) => m.version),
    ['0001', '0008', '0018'],
    '0001（users）+ 0008（idempotency_keys 旁证）+ 0018（本片新表）',
  );
  assert.deepEqual((await applyMigrations(owner, migrations)).applied, ['0001', '0008', '0018']);
  assert.equal((await applyMigrations(owner, migrations)).applied.length, 0, '重复应用必须 no-op');
  const tables = ['favorites', 'history', 'favorites_idempotency', 'history_idempotency'];
  const present = await owner.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1) ORDER BY tablename",
    [tables],
  );
  assert.deepEqual(present.rows.map((row) => row.tablename), [...tables].sort());
  const sideTables = ['idempotency_keys', 'users'];
  assert.deepEqual(
    (
      await owner.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1) ORDER BY tablename",
        [sideTables],
      )
    ).rows.map((row) => row.tablename),
    sideTables,
    '0001 的 users 与 0008 的 idempotency_keys 同时在库（回滚断言的旁证基线）',
  );
  say('0018 在真库应用成功（4 张表）、重复应用 no-op；0001/0008 的两张旁证表同时在库');

  const ownerA = (await owner.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id;
  const ownerB = (await owner.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id;

  pool = createPool(url.href);
  assert.notEqual(pool, null);
  const favorites = createPostgresFavoritesStore(pool);
  const history = createPostgresHistoryStore(pool);
  assert.equal(favorites.persistent, true);
  assert.equal(history.persistent, true);
  say('两个 store 如实声明 persistent=true');

  // ---- 2. 写入 → 读回 ----------------------------------------------------
  const favoriteA = {
    id: randomUUID(),
    revision: 1,
    owner_id: ownerA,
    target_ref: { type: 'species', id: 'spc-pg-1', revision: 3 },
    created_at: new Date().toISOString(),
  };
  assert.equal(await favorites.insertFavorite(favoriteA), 'inserted');
  const readBack = await favorites.getFavorite(favoriteA.id);
  assert.deepEqual(readBack, favoriteA, '读回必须逐字段相等（target_ref 由列还原）');

  const historyA = {
    id: randomUUID(),
    revision: 1,
    owner_id: ownerA,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: 'rec-pg-1', revision: 2 },
    job_id: 'job-pg-1',
    job_state: 'failed',
    created_at: new Date().toISOString(),
    event_key: 'evt-pg-1',
  };
  assert.equal(await history.insertHistory(historyA), 'inserted');
  const historyBack = await history.getHistory(historyA.id);
  assert.deepEqual(historyBack, historyA);
  assert.equal(historyBack.job_state, 'failed', '失败终态原样入库，不折叠成 succeeded');
  assert.equal((await history.findByEventKey(ownerA, 'evt-pg-1')).id, historyA.id);
  say('收藏/历史写入后逐字段读回（job_state 终态不被折叠）');

  // ---- 3. 去重：唯一约束裁决，行数不增 -----------------------------------
  assert.equal(
    await favorites.insertFavorite({ ...favoriteA, id: randomUUID(), revision: 1 }),
    'duplicate',
    '同 (owner,target_type,target_id) ⇒ duplicate（唯一索引，不是先查后写）',
  );
  assert.equal(await favorites.insertFavorite({ ...favoriteA }), 'duplicate', '同 id ⇒ duplicate');
  assert.equal((await owner.query('SELECT count(*)::int n FROM favorites WHERE owner_id=$1', [ownerA])).rows[0].n, 1);

  assert.equal(await history.insertHistory({ ...historyA, id: randomUUID() }), 'duplicate', '同 event_key ⇒ duplicate');
  assert.equal(
    await history.insertHistory({ ...historyA, id: randomUUID(), event_key: 'evt-pg-other' }),
    'duplicate',
    '同 (owner,kind,target_id) ⇒ duplicate（第二道去重键）',
  );
  assert.equal(
    await history.insertHistory({ ...historyA, id: randomUUID(), job_state: 'not-a-state' }),
    'duplicate',
    '非闭集状态与内存实现一致地返回 duplicate（不写坏行）',
  );
  assert.equal((await owner.query('SELECT count(*)::int n FROM history WHERE owner_id=$1', [ownerA])).rows[0].n, 1);
  say('收藏/历史双路去重均由唯一约束裁决，行数不增');

  // ---- 归属域：同目标可以被**另一个主体**收藏（唯一性按 owner 分域）------
  const favoriteB = { ...favoriteA, id: randomUUID(), owner_id: ownerB, created_at: new Date().toISOString() };
  assert.equal(await favorites.insertFavorite(favoriteB), 'inserted');
  assert.deepEqual(await favorites.findByTarget(ownerB, 'species', 'spc-pg-1'), favoriteB);
  assert.deepEqual(await favorites.findByTarget(ownerA, 'species', 'spc-pg-1'), favoriteA);
  assert.deepEqual(
    (await favorites.listFavoritesByOwner(ownerB)).map((row) => row.id),
    [favoriteB.id],
    '只返回本主体的行',
  );
  say('同一目标不同主体各一行；列表/去重查询只按 owner_id 过滤');

  // ---- 4. CAS 删除 -------------------------------------------------------
  assert.deepEqual(await favorites.deleteFavorite(favoriteA.id, { revision: 2, owner_id: ownerA }), {
    ok: false,
    reason: 'REVISION_CHANGED',
  });
  assert.deepEqual(await favorites.deleteFavorite(favoriteA.id, { revision: 1, owner_id: ownerB }), {
    ok: false,
    reason: 'OWNER_CHANGED',
  });
  assert.deepEqual(await favorites.deleteFavorite(randomUUID(), { revision: 1 }), { ok: false, reason: 'NOT_FOUND' });
  const casFavorite = await favorites.deleteFavorite(favoriteA.id, { revision: 1, owner_id: ownerA });
  assert.equal(casFavorite.ok, true);
  assert.equal(casFavorite.record.id, favoriteA.id);
  assert.equal(await favorites.getFavorite(favoriteA.id), null, '物理删除：行不再存在');
  assert.equal((await owner.query('SELECT count(*)::int n FROM favorites WHERE owner_id=$1', [ownerB])).rows[0].n, 1, '他人行不受影响');

  assert.deepEqual(await history.deleteHistory(historyA.id, { revision: 9 }), { ok: false, reason: 'REVISION_CHANGED' });
  assert.deepEqual(await history.deleteHistory(historyA.id, { revision: 1, owner_id: ownerB }), {
    ok: false,
    reason: 'OWNER_CHANGED',
  });
  assert.deepEqual(await history.deleteHistory(randomUUID(), { revision: 1 }), { ok: false, reason: 'NOT_FOUND' });
  const casHistory = await history.deleteHistory(historyA.id, { revision: 1, owner_id: ownerA });
  assert.equal(casHistory.ok, true);
  assert.equal(await history.getHistory(historyA.id), null);
  say('CAS 删除：版本不符/他人/不存在逐条拒绝，命中即物理删除');

  // ---- 6. 幂等台账真落库 ------------------------------------------------
  const scope = `${ownerA}\nPOST\n/api/v1/favorites`;
  const keyA = 'k'.repeat(64);
  const soon = Date.now() + 60_000;
  assert.equal(
    await favorites.claimIdempotency(scope, keyA, { request_hash: 'h'.repeat(64), response_status: 201, expires_at: soon }),
    true,
  );
  assert.equal(
    await favorites.claimIdempotency(scope, keyA, { request_hash: 'h'.repeat(64), response_status: 201, expires_at: soon }),
    false,
    '已占用且未过期 ⇒ 第二次认领失败',
  );
  assert.equal(await favorites.findIdempotency(scope, keyA), null, '已认领未完成 ⇒ findViewById 与内存实现一致返回 null');
  const outcome = { kind: 'favorite', id: favoriteB.id, revision: 1 };
  assert.equal(await favorites.completeIdempotency(scope, keyA, { response_status: 201, outcome }), true);
  const settled = await favorites.findIdempotency(scope, keyA);
  assert.deepEqual(settled.outcome, outcome);
  assert.equal(settled.response_status, 201);
  assert.equal(
    await favorites.completeIdempotency(scope, keyA, { response_status: 200, outcome }),
    false,
    '已完成的结果不得被二次完成覆盖',
  );
  await favorites.releaseIdempotency(scope, keyA);
  assert.deepEqual((await favorites.findIdempotency(scope, keyA)).outcome, outcome, 'release 不得抹掉已完成的结果');

  const keyRelease = 'r'.repeat(64);
  assert.equal(
    await favorites.claimIdempotency(scope, keyRelease, { request_hash: 'x'.repeat(64), response_status: 201, expires_at: soon }),
    true,
  );
  await favorites.releaseIdempotency(scope, keyRelease);
  assert.equal(await favorites.findIdempotency(scope, keyRelease), null, 'release 只删"已认领未完成"的槽位');

  const keyExpired = 'e'.repeat(64);
  assert.equal(
    await favorites.claimIdempotency(scope, keyExpired, { request_hash: 'y'.repeat(64), response_status: 201, expires_at: Date.now() - 1000 }),
    true,
  );
  assert.equal(await favorites.findIdempotency(scope, keyExpired), null, '过期槽位 ⇒ null');
  assert.equal(
    (await owner.query('SELECT count(*)::int n FROM favorites_idempotency WHERE key_hash=$1', [keyExpired])).rows[0].n,
    0,
    '过期槽位被真删（不是内存里忽略）',
  );
  say('幂等台账真落库：claim/complete/release/过期清理逐条与内存实现同语义');

  // `awaitIdempotencySettled` 必须**真读库**：由另一条独立连接写入完成结果来唤醒它。
  const keySettle = 's'.repeat(64);
  assert.equal(await history.claimIdempotency(scope, keySettle, { request_hash: 'z'.repeat(64), response_status: 200, expires_at: soon }), true);
  assert.equal(await history.awaitIdempotencySettled(scope, keySettle, 40), 'timeout', '未完成 ⇒ 有界等待后 timeout');
  const other = new pg.Client({ connectionString: url.href });
  await other.connect();
  try {
    const waiting = history.awaitIdempotencySettled(scope, keySettle, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await other.query(
      `UPDATE history_idempotency SET outcome = $3::jsonb, response_status = 200
        WHERE scope = $1 AND key_hash = $2 AND outcome IS NULL`,
      [scope, keySettle, JSON.stringify({ kind: 'history', id: randomUUID(), revision: 1, cascade: 'unwired' })],
    );
    assert.equal(await waiting, 'settled', '另一条连接的写入必须能唤醒（证明每次真读库，不是进程内 Map）');
  } finally {
    await other.end();
  }
  say('awaitIdempotencySettled 由独立连接的写入唤醒（台账非进程内假象）');

  // ---- 5 + 8. HTTP 面：他人 id 与"不存在"同形；重连后数据仍在 -------------
  const auth = createMemoryAuthStore();
  const account = async (subject) => {
    const user = await auth.createUser(subject.repeat(64));
    const token = `synthetic-i16-pg-${subject}`;
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
  const a = await account('a');
  const b = await account('b');
  const config = {
    ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    executionMode: 'real',
    requiresRealCredentials: true,
  };
  // 反向控制（默认关闭，见文件头第 13 条）：把装配换成一张**自称 `persistent: true`** 的内存 store。
  // 只改本文件的装配入参，不改 `app.ts`；`persistent` 拔高是为了让 `real` 模式的服务门禁放行，
  // 这样红的是"真库行数"读数本身，而不是"服务被关掉"这种夹具级失败。
  const injection = FORCE_MEMORY
    ? {
        favoritesInjection: {
          store: Object.assign(createMemoryFavoritesStore({ now: () => Date.now() }), { persistent: true }),
        },
        historyInjection: {
          store: Object.assign(createMemoryHistoryStore({ now: () => Date.now() }), { persistent: true }),
        },
      }
    : {};
  app = buildApp({ config, store: auth, pool, ...injection, now: () => new Date() });
  assert.notEqual(app.favoritesService, null, 'real + 真库 pool ⇒ 服务必须开启');
  assert.notEqual(app.historyService, null);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, actor, extra = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${actor.token}`,
        ...(extra.payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...(extra.headers ?? {}),
      },
      ...(extra.payload === undefined ? {} : { body: JSON.stringify(extra.payload) }),
    });
    // 响应头一并带回：`X-GY-Cascade`（非契约披露）、`Cache-Control: no-store` 的读数要用。
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const created = await call('POST', '/api/v1/favorites', a, {
    payload: { target_ref: { type: 'species', id: 'spc-http-pg', revision: 1 } },
    headers: { 'idempotency-key': 'fav-pg-http-0001' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const listed = await call('GET', '/api/v1/favorites', a);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data.items.map((row) => row.id), [created.body.data.id]);

  const absent = '00000000-0000-4000-8f00-0000000000ff';
  const foreign = await call('DELETE', `/api/v1/favorites/${created.body.data.id}`, b, {
    headers: { 'idempotency-key': 'fav-pg-http-0002', 'if-match': '"1"' },
  });
  const missing = await call('DELETE', `/api/v1/favorites/${absent}`, b, {
    headers: { 'idempotency-key': 'fav-pg-http-0003', 'if-match': '"1"' },
  });
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(foreign.body.error.code, 'NOT_FOUND');
  assert.equal(foreign.body.error.message, missing.body.error.message, '他人资源与不存在必须同文案');
  assert.deepEqual(
    Object.keys(foreign.body.error).sort(),
    Object.keys(missing.body.error).sort(),
    '错误体键集同形（不泄露存在性）',
  );
  assert.deepEqual((await call('GET', '/api/v1/favorites', b)).body.data, { items: [], next_cursor: null });
  say('HTTP 面：real+pool 真的 201/200 落库；他人 id 与不存在同形 404');

  // =======================================================================
  // 10. 收藏域：真 HTTP + 真 SQL 对账（R31-I16 补，2026-10-22）
  // =======================================================================
  // 每条读数都同时取「HTTP 响应」与「同库 SELECT」，两边相等才算成立；只看 HTTP 脸色会漏掉
  // "回了 201 但没落库"这类假绿 —— 文件头的 `GY_I16_FORCE_MEMORY=1` 反向控制专打这一点。
  const c = await account('c');
  const scopePrefixSql = 'left(scope, char_length($1::text) + 1) = $1::text || chr(10)';
  const favRows = async (ownerId) =>
    (
      await owner.query(
        'SELECT id, revision, created_at FROM favorites WHERE owner_id = $1 ORDER BY created_at DESC, id DESC',
        [ownerId],
      )
    ).rows;
  const favCount = async (ownerId) =>
    (await owner.query('SELECT count(*)::int n FROM favorites WHERE owner_id = $1', [ownerId])).rows[0].n;
  const postFavorite = (actor, key, payload) =>
    call('POST', '/api/v1/favorites', actor, { payload, headers: { 'idempotency-key': key } });

  const firstBody = { target_ref: { type: 'species', id: 'spc-pg-c-1', revision: 4 } };
  assert.equal(await favCount(c.user.id), 0, '新主体起点必须是 0 行（否则下面的 0→1 不成立）');
  const cFirst = await postFavorite(c, 'fav-pg-c-0001', firstBody);
  assert.equal(cFirst.status, 201, JSON.stringify(cFirst.body));
  assert.equal(await favCount(c.user.id), 1, 'HTTP 新增收藏后真库 count(*) 必须 0 → 1');
  assert.deepEqual(
    (await favRows(c.user.id)).map((row) => ({ id: row.id, revision: row.revision })),
    [{ id: cFirst.body.data.id, revision: 1 }],
    '真库那一行的 id 必须就是 HTTP 回给客户端的 id（不是两条平行世界）',
  );
  say('收藏新增：HTTP 201，真库 count(*)=0→1，且库里 id 与响应 id 逐字相等');

  const cReplay = await postFavorite(c, 'fav-pg-c-0001', firstBody);
  assert.equal(cReplay.status, 201, '同键同体重放回同一状态码');
  assert.deepEqual(cReplay.body.data, cFirst.body.data, '重放必须回放同一份读数（id/revision/created_at 全等）');
  assert.equal(await favCount(c.user.id), 1, '重放不得多建行');
  assert.deepEqual(
    (await favRows(c.user.id)).map((row) => ({ id: row.id, revision: row.revision })),
    [{ id: cFirst.body.data.id, revision: 1 }],
    '重放后行集仍钉在同一行（revision 不推进）',
  );
  assert.deepEqual(
    (
      await owner.query(
        `SELECT response_status, outcome FROM favorites_idempotency WHERE ${scopePrefixSql} ORDER BY response_status`,
        [c.user.id],
      )
    ).rows,
    [{ response_status: 201, outcome: { kind: 'favorite', id: cFirst.body.data.id, revision: 1 } }],
    '同键只留 1 行台账，outcome 指向那一条收藏',
  );
  say('收藏同幂等键重放：HTTP 读数不变、真库行数不变、台账恰好 1 行且 outcome 指向同一行');

  const cConflict = await postFavorite(c, 'fav-pg-c-0001', {
    target_ref: { type: 'species', id: 'spc-pg-c-diff', revision: 4 },
  });
  assert.equal(cConflict.status, 409, JSON.stringify(cConflict.body));
  assert.equal(cConflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await favCount(c.user.id), 1, '同键异体被拒后不得建行');
  assert.equal(
    (
      await owner.query('SELECT count(*)::int n FROM favorites WHERE owner_id=$1 AND target_id=$2', [
        c.user.id,
        'spc-pg-c-diff',
      ])
    ).rows[0].n,
    0,
    '差异体那条目标从未落库',
  );
  assert.equal(
    (await owner.query(`SELECT count(*)::int n FROM favorites_idempotency WHERE ${scopePrefixSql}`, [c.user.id]))
      .rows[0].n,
    1,
    '409 不得留下第二行台账（也不得覆盖原结果）',
  );
  say('收藏同键不同体：HTTP 409 IDEMPOTENCY_CONFLICT，真库未建行、台账仍是 1 行');

  // 分页读数：5 行、limit=2 ⇒ 三页（2/2/1），末页 `next_cursor` 必须为 null（不是靠"空页"收尾）。
  for (const index of [2, 3, 4, 5]) {
    const more = await postFavorite(c, `fav-pg-c-000${index}`, {
      target_ref: { type: 'species', id: `spc-pg-c-${index}`, revision: 1 },
    });
    assert.equal(more.status, 201, JSON.stringify(more.body));
  }
  assert.equal(await favCount(c.user.id), 5, '总共 5 行（1 条 + 4 条）');

  const sqlFavoriteIds = (await favRows(c.user.id)).map((row) => row.id);
  const httpFavoriteIds = [];
  const favPageSizes = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const listedPage = await call(
      'GET',
      `/api/v1/favorites?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      c,
    );
    assert.equal(listedPage.status, 200, JSON.stringify(listedPage.body));
    assert.equal(listedPage.headers.get('cache-control'), 'no-store', '私有列表一律 no-store');
    favPageSizes.push(listedPage.body.data.items.length);
    httpFavoriteIds.push(...listedPage.body.data.items.map((row) => row.id));
    cursor = listedPage.body.data.next_cursor;
    if (cursor === null) break;
  }
  assert.deepEqual(favPageSizes, [2, 2, 1], '每页条数读数：2/2/1');
  assert.equal(cursor, null, '末页 next_cursor 必须为 null');
  assert.deepEqual(
    httpFavoriteIds,
    sqlFavoriteIds,
    'HTTP 逐页拼接的 id 序列必须与 SQL `ORDER BY created_at DESC, id DESC` 逐项相等',
  );
  assert.equal(new Set(httpFavoriteIds).size, 5, '翻页无重复');
  say('收藏列表分页：limit=2 三页 2/2/1，末页 next_cursor=null，id 序列与 SQL 逐项相等（无重复无遗漏）');

  const deletedFav = cFirst.body.data.id;
  const delOk = await call('DELETE', `/api/v1/favorites/${deletedFav}`, c, {
    headers: { 'idempotency-key': 'fav-pg-c-del-01', 'if-match': '"1"' },
  });
  assert.equal(delOk.status, 200, JSON.stringify(delOk.body));
  assert.deepEqual(delOk.body.data, { accepted: true });
  assert.equal(await favCount(c.user.id), 4, '删除后真库行数 5 → 4');
  assert.deepEqual(
    (await favRows(c.user.id)).map((row) => row.id),
    sqlFavoriteIds.filter((id) => id !== deletedFav),
    '被删行从 SQL 列表消失，其余行原序',
  );

  // 再用**新键**删同一 id：scope 里含 id、键不同 ⇒ 不是重放，必须走"不存在"路径。
  const delAgain = await call('DELETE', `/api/v1/favorites/${deletedFav}`, c, {
    headers: { 'idempotency-key': 'fav-pg-c-del-02', 'if-match': '"1"' },
  });
  const delNever = await call('DELETE', `/api/v1/favorites/${absent}`, c, {
    headers: { 'idempotency-key': 'fav-pg-c-del-03', 'if-match': '"1"' },
  });
  assert.equal(delAgain.status, 404, JSON.stringify(delAgain.body));
  assert.equal(delNever.status, 404, JSON.stringify(delNever.body));
  assert.equal(delAgain.body.error.code, 'NOT_FOUND');
  assert.equal(delAgain.body.error.message, delNever.body.error.message, '已删除的 id 与从未存在的 id 必须同一句式');
  assert.deepEqual(
    Object.keys(delAgain.body.error).sort(),
    Object.keys(delNever.body.error).sort(),
    '错误体键集同形（不含"它曾经存在过"的痕迹）',
  );
  assert.deepEqual(delAgain.body.error.details ?? [], delNever.body.error.details ?? [], 'details 也必须同形');
  assert.equal(await favCount(c.user.id), 4, '两次 404 都不得改行数');
  say('收藏删除：HTTP 200 accepted ⇒ 真库 5→4；再删同 id 与从未存在的 id 404 逐字同形、行数不变');

  // =======================================================================
  // 11. 历史域：真 HTTP + 真 SQL 对账
  // =======================================================================
  // 历史**没有** POST 路由（契约 `/history` 只有 GET／`/history/{id}` 只有 DELETE），写入走内部口
  // `appendHistory`（`services/api/src/history/service.ts:426-450`）；因此本轮读数 = 内部口写 + 真 HTTP 读 + 真 SQL 数。
  const histRows = async (ownerId) =>
    (
      await owner.query(
        'SELECT id, event_key, target_id FROM history WHERE owner_id = $1 ORDER BY created_at DESC, id DESC',
        [ownerId],
      )
    ).rows;
  const histCount = async (ownerId) =>
    (await owner.query('SELECT count(*)::int n FROM history WHERE owner_id = $1', [ownerId])).rows[0].n;
  const append = (ownerId, index) =>
    app.historyService.appendHistory({
      owner_id: ownerId,
      kind: 'recognition',
      target_ref: { type: 'recognition', id: `rec-pg-c-${index}`, revision: 1 },
      job_id: `job-pg-c-${index}`,
      job_state: 'succeeded',
      event_key: `evt-pg-c-${index}`,
    });

  assert.equal(await histCount(c.user.id), 0, '历史域新主体起点必须是 0 行');
  const h1 = await append(c.user.id, 1);
  assert.equal(h1.created, true);
  assert.equal(await histCount(c.user.id), 1, '内部口追加后真库 count(*) 必须 0 → 1');
  assert.deepEqual(
    (await histRows(c.user.id)).map((row) => ({ id: row.id, event_key: row.event_key })),
    [{ id: h1.history.id, event_key: 'evt-pg-c-1' }],
    '真库那一行就是内部口返回的那条（id/event_key 逐字相等）',
  );
  const histListed = await call('GET', '/api/v1/history', c);
  assert.equal(histListed.status, 200, JSON.stringify(histListed.body));
  assert.deepEqual(
    histListed.body.data.items.map((row) => row.id),
    [h1.history.id],
    'HTTP 列表读到的就是刚追加的那条',
  );
  say('历史追加：appendHistory created=true，真库 count(*)=0→1，HTTP 列表读回同一 id');

  // 同 `(owner,event_key)`、**换一个目标** ⇒ 仍必须判 duplicate：证明是 event_key 那道唯一索引裁决，
  // 不是"目标恰好相同"的巧合；且既有行的终态不被"重放的新体"改写。
  const h1Dup = await app.historyService.appendHistory({
    owner_id: c.user.id,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: 'rec-pg-c-99', revision: 1 },
    job_id: 'job-pg-c-99',
    job_state: 'failed',
    event_key: 'evt-pg-c-1',
  });
  assert.equal(h1Dup.created, false, '同 (owner,event_key) ⇒ duplicate');
  assert.equal(h1Dup.history.id, h1.history.id, 'duplicate 必须回既有那条，而不是新建一条');
  assert.equal(h1Dup.history.job_state, 'succeeded', '既有行的终态不被"重放的新体"改写');
  assert.equal(await histCount(c.user.id), 1, 'duplicate 不得加行');
  assert.equal(
    (
      await owner.query("SELECT count(*)::int n FROM history WHERE owner_id=$1 AND target_id='rec-pg-c-99'", [
        c.user.id,
      ])
    ).rows[0].n,
    0,
    'duplicate 的新目标从未落库',
  );
  assert.equal(
    (await owner.query('SELECT count(*)::int n FROM history WHERE owner_id=$1 AND event_key=$2', [
      c.user.id,
      'evt-pg-c-1',
    ])).rows[0].n,
    1,
    'history_owner_event_key 唯一索引下只留 1 行',
  );
  say('历史同 (owner,event_key) 重复：created=false、行数不变、第二目标未落库、既有终态不被改写');

  for (const index of [2, 3, 4, 5]) {
    const appended = await append(c.user.id, index);
    assert.equal(appended.created, true, `第 ${index} 条必须新增`);
  }
  assert.equal(await histCount(c.user.id), 5);

  const sqlHistoryIds = (await histRows(c.user.id)).map((row) => row.id);
  const httpHistoryIds = [];
  const histPageSizes = [];
  cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const listedPage = await call(
      'GET',
      `/api/v1/history?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      c,
    );
    assert.equal(listedPage.status, 200, JSON.stringify(listedPage.body));
    assert.equal(listedPage.headers.get('cache-control'), 'no-store');
    histPageSizes.push(listedPage.body.data.items.length);
    httpHistoryIds.push(...listedPage.body.data.items.map((row) => row.id));
    cursor = listedPage.body.data.next_cursor;
    if (cursor === null) break;
  }
  assert.deepEqual(histPageSizes, [2, 2, 1], '每页条数读数：2/2/1');
  assert.equal(cursor, null, '末页 next_cursor 必须为 null');
  assert.deepEqual(
    httpHistoryIds,
    sqlHistoryIds,
    'HTTP 拼接序列必须与 SQL `ORDER BY created_at DESC, id DESC` 逐项相等',
  );
  assert.equal(new Set(httpHistoryIds).size, 5, '翻页无重复');
  say('历史列表分页：limit=2 三页 2/2/1，末页 next_cursor=null，序列与 SQL 逐项相等（无重复无遗漏）');

  const delHistOk = await call('DELETE', `/api/v1/history/${h1.history.id}`, c, {
    headers: { 'idempotency-key': 'hist-pg-c-del-01', 'if-match': '"1"' },
  });
  assert.equal(delHistOk.status, 202, JSON.stringify(delHistOk.body));
  assert.deepEqual(delHistOk.body.data, { accepted: true });
  assert.ok(
    ['initiated', 'partial', 'unwired', 'failed'].includes(delHistOk.headers.get('x-gy-cascade')),
    'DELETE 必须披露级联状态（非契约头 X-GY-Cascade）',
  );
  // R33 片起生产默认装配是**已接线**的（识别/OCR 两腿）：本行 `target_ref.id` 是合成串
  // `rec-pg-c-1`（不是 uuid、库里也没有这条识别记录）⇒ 读不到 ⇒ 一项都没删成功 ⇒ `failed`。
  // 这正是裁定要的下限口径：⛔ 不得因为"端口已接线"就把它记成 `partial`。
  assert.equal(
    delHistOk.headers.get('x-gy-cascade'),
    'failed',
    '目标核不到 ⇒ 一项都没删成功 ⇒ failed（⛔ 不得记 partial、⛔ 不得仍是 unwired）',
  );
  assert.equal(await histCount(c.user.id), 4, '删除后真库行数 5 → 4');

  const delHistAgain = await call('DELETE', `/api/v1/history/${h1.history.id}`, c, {
    headers: { 'idempotency-key': 'hist-pg-c-del-02', 'if-match': '"1"' },
  });
  const delHistNever = await call('DELETE', `/api/v1/history/${absent}`, c, {
    headers: { 'idempotency-key': 'hist-pg-c-del-03', 'if-match': '"1"' },
  });
  const delHistForeign = await call('DELETE', `/api/v1/history/${sqlHistoryIds[1]}`, b, {
    headers: { 'idempotency-key': 'hist-pg-b-del-01', 'if-match': '"1"' },
  });
  assert.equal(delHistAgain.status, 404, JSON.stringify(delHistAgain.body));
  assert.equal(delHistNever.status, 404, JSON.stringify(delHistNever.body));
  assert.equal(delHistForeign.status, 404, '他人历史 id 与不存在同形（不泄露存在性）');
  for (const other of [delHistNever, delHistForeign]) {
    assert.equal(delHistAgain.body.error.code, other.body.error.code);
    assert.equal(delHistAgain.body.error.message, other.body.error.message);
    assert.deepEqual(Object.keys(delHistAgain.body.error).sort(), Object.keys(other.body.error).sort());
    assert.deepEqual(delHistAgain.body.error.details ?? [], other.body.error.details ?? []);
  }
  assert.equal(await histCount(c.user.id), 4, '404 不得改行数');
  say('历史删除：HTTP 202 accepted + X-GY-Cascade；再删同 id / 从未存在 / 他人 id 三者 404 逐字同形');

  // =======================================================================
  // 14. real 终态端口 → appendHistory（R31-I16 本片新增；监工拒关 #16 的缺口）
  // =======================================================================
  // 修正前：`services/api/src/app.ts` 的端口选择只看 `config.executionMode === 'real'` ⇒ `real` + 真库
  // 也拿 `createUnwiredRecognitionTerminalHistoryPort`（`recordTerminal()` 空实现）⇒ **生产终态不
  // `appendHistory`**（上一节的读数全部来自脚本**直调**内部口，覆盖不到这条链路）。本节把修正后的
  // 链路在**真 PG** 上走通并逐项对账：
  //   服务层受理 → 异步执行 → `store.commitTerminal` 成功 → 终态端口 `recordTerminal`
  //   → `recordHistoryTerminal` → `historyService.appendHistory({…, event_key: 'recognition:<job_id>'})`
  //   → 真表 `history` 一行。
  //
  // **装配口径（如实登记，不得读成"全量生产装配"）**：
  //   1. 本节只应用 0001/0008/0018，没有外发账本（0011）与授权策略（0003/0009）所需的表。若把**完整**
  //      连接池交给 app，`app.ts` 会按 `real` 的既有逻辑装配外发账本与授权门，于是每次派发都在
  //      "受理/执行前" fail-closed，根本走不到终态 ⇒ 本节什么也证明不了。故交给 app 的是**只有
  //      query 面**的池 —— 这正是 `app.ts` 已实现的降级装配路径（`egressPoolUsable` 只看
  //      `connect()/query()` 形状，缺 `connect()` 即"不装配账本并告警"，不抛、不静默降级为替身）。
  //   2. 识别提供者/媒体端口是**显式标注的合成替身**（零外呼）；识别 store 用内存实现（识别域的
  //      PG 持久化由 `tests/integration/recognitions-pg.mjs` 负责，不是本节的对象）。
  //   3. **历史 store 仍是真 PG**（`createPostgresHistoryStore`，与生产同一实现），行落进本节的真库。
  const syntheticRecognition = {
    executionMode: 'stub',
    modelVersion: 'synthetic-history-pg-v1',
    available: true,
    unavailableReason: null,
    async recognize() {
      return {
        kind: 'completed',
        candidates: [
          { species_id: 'synthetic_pg_weed_a', rank: 1, model_score: 0.83 },
          { species_id: 'synthetic_pg_weed_b', rank: 2, model_score: 0.41 },
          { species_id: 'synthetic_pg_weed_c', rank: 3, model_score: 0.12 },
        ],
        uncertainty_reasons: [],
      };
    },
  };
  const d = await account('d');
  const terminalApp = buildApp({
    config,
    store: auth,
    pool: { query: (text, values) => pool.query(text, values) },
    recognitionStore: createMemoryRecognitionStore(),
    recognitionProvider: syntheticRecognition,
    recognitionMedia: createSubstituteMediaPort(),
    now: () => new Date(),
  });
  let terminalAppOpen = false;
  try {
    assert.equal(terminalApp.historyService !== null, true, 'real + 真库 ⇒ 历史服务必须开启');
    assert.equal(
      terminalApp.recognitionService.describe().historyPort,
      'wired',
      'real + 真库 ⇒ 识别终态端口必须 wired（修正前这里恒 unwired ⇒ 本断言即红/绿分界）',
    );
    assert.equal(
      terminalApp.ocrService.describe().historyPort,
      'wired',
      'OCR 终态端口与识别端口共用同一判据（real + 真库 ⇒ wired）',
    );
    say('real + 真库：识别/OCR 终态端口均为 wired（修正前 real 分支恒 unwired）');

    const createdJob = await terminalApp.recognitionService.createRecognition({
      userId: d.user.id,
      body: { media_id: randomUUID(), media_revision: 1 },
      idempotencyKey: 'real-term-pg-0001',
    });
    await terminalApp.recognitionService.settle();
    const terminalJob = await terminalApp.recognitionService.getJob({
      userId: d.user.id,
      jobId: createdJob.job.id,
    });
    assert.equal(terminalJob.state, 'succeeded', '合成提供者必然给出成功终态');

    const termRows = (
      await owner.query(
        `SELECT owner_id, kind, target_type, target_id, target_revision, job_id, job_state, event_key
           FROM history WHERE owner_id = $1 ORDER BY created_at DESC, id DESC`,
        [d.user.id],
      )
    ).rows;
    assert.equal(termRows.length, 1, '终态必须落 1 行（修正前 real 分支 ⇒ 0 行：本节就是那条红/绿分界）');
    const termRow = termRows[0];
    assert.equal(termRow.owner_id, d.user.id, '归属只来自服务端会话');
    assert.equal(termRow.kind, 'recognition');
    assert.equal(termRow.job_id, createdJob.job.id);
    assert.equal(termRow.job_state, 'succeeded', '终态原样入库，不被折叠/改写');
    assert.equal(termRow.event_key, `recognition:${createdJob.job.id}`, 'event_key 确定性：<kind>:<job_id>');
    assert.equal(termRow.target_type, 'recognition');
    assert.equal(termRow.target_id, terminalJob.target_ref.id, 'target_ref 指向真实识别记录');
    say('real 终态端口 → appendHistory：真库 history 恰 1 行，owner/kind/job_id/job_state/target_ref/event_key 逐项对账');

    // 同任务**重复投递** ⇒ no-op（端口重投的形状就是同一份入参再来一次）。
    const replay = await terminalApp.historyService.appendHistory({
      owner_id: d.user.id,
      kind: 'recognition',
      target_ref: terminalJob.target_ref,
      job_id: createdJob.job.id,
      job_state: 'succeeded',
      event_key: `recognition:${createdJob.job.id}`,
    });
    assert.equal(replay.created, false, '同 (owner,event_key) 重投必须 created:false');
    assert.equal(await histCount(d.user.id), 1, '重投不得加行');
    assert.equal(
      (await owner.query('SELECT count(*)::int n FROM history WHERE owner_id = $1 AND event_key = $2', [
        d.user.id,
        `recognition:${createdJob.job.id}`,
      ])).rows[0].n,
      1,
      'history_owner_event_key 唯一索引下只留 1 行',
    );
    say('real 接线：同任务重复投递 no-op（created=false、真库行数不变、唯一索引下只留 1 行）');

    // 归属/权限：他人（b）读不到这一行（HTTP 面同形；不泄露存在性）。
    await terminalApp.listen({ host: '127.0.0.1', port: 0 });
    terminalAppOpen = true;
    const terminalBase = `http://127.0.0.1:${terminalApp.server.address().port}`;
    const terminalGet = async (path, actor) => {
      const response = await fetch(terminalBase + path, { headers: { authorization: `Bearer ${actor.token}` } });
      return { status: response.status, body: await response.json() };
    };
    const mine = await terminalGet('/api/v1/history', d);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(
      mine.body.data.items.map((row) => ({ kind: row.kind, job_state: row.job_state, id: row.id })),
      [
        {
          kind: 'recognition',
          job_state: 'succeeded',
          id: (await owner.query('SELECT id FROM history WHERE owner_id = $1', [d.user.id])).rows[0].id,
        },
      ],
      'HTTP 列表读到的就是终态端口刚落的那一行（不是脚本直调的）',
    );
    assert.deepEqual((await terminalGet('/api/v1/history', b)).body.data, { items: [], next_cursor: null }, '他人历史必须为空');
    say('real 接线：写进去的那一行经 GET /history 读回（本人可见、他人为空）');
  } finally {
    if (terminalAppOpen) await terminalApp.close().catch(() => {});
  }

  await app.close();
  app = null;

  // =======================================================================
  // 15. 删历史 ⇒ 关联识别记录被**真的软删**（R33-I16 级联接线；真库 + 真 HTTP）
  // =======================================================================
  // 授权：`.pg17/ruling-r33-i16-history-cascade-partial-20261023.md` 第 1、2 条
  // （允许新增披露值 `partial`，语义严格为「历史行已删 ＋ 至少一项关联已删 ＋ 未全部删成功」；
  //  只接 recognitions 与 ocr 两类；⛔「一项都没删成功」仍是 failed）。
  //
  // 本节覆盖（补入文件头「覆盖」清单的第 15 项）：删历史 ⇒ 关联识别记录被**真的软删**。
  //   - 走**生产默认接线**（不注入 `historyInjection.cascade`）⇒ 202 + `X-GY-Cascade: partial`；
  //   - 真库 `history` 行真的删掉（0 行）、识别 store 里那行 `deleted=true` 且 `revision+1`、
  //     `GET /recognitions/{id}` 变 404 且与"从未存在"逐字同形；
  //   - 同键重放回放同一披露且**不再删一次**；反例（目标核不到）必须披露 `failed` 而**不是** `partial`。
  //   - ⚠ **OCR 腿**在本文件里没有 app 级臂（`buildApp` 没有 OCR store 注入点，要走完整 OCR 任务链），
  //     由 `tests/unit/history-cascade-wiring.test.mjs` 的适配器级用例覆盖。
  //
  // 装配口径（如实登记，不得读成全量生产装配）：
  //   1. **不注入** `historyInjection.cascade` ⇒ 本节读数就是 `services/api/src/app.ts` 里那条
  //      生产默认值的行为（改回 `createUnwiredHistoryCascadePort()` 时本节必红）；
  //   2. 历史 store 是**真 PG**（与生产同一实现：行真的落库、`DELETE` 后真的消失）；
  //   3. 识别 store 是**内存**实现 —— 本文件只应用 0001/0008/0018，识别域 PG 表不在本库
  //      （识别域持久化由 `tests/integration/recognitions-pg.mjs` 负责）。因此本节能证明的是
  //      「真库里的历史行 → 经生产接线 → 识别域那条记录被软删」这条链路，不是"识别域也落 PG"。
  //   4. 与本文件 §14 的差别：这里必须给 app 一个**带 `connect()`** 的池 —— `DELETE /history/{id}`
  //      走 `withTransaction`（`history/store-pg.ts` 的 CAS 删除与幂等台账都在事务里），
  //      只给 `{query}` 会在 `pool.connect()` 处炸成 503 `历史数据库暂不可用`。
  //      带 `connect()` 会同时让 app 装配外发账本/授权门（构造期不查库），本节不派发任务，故无影响。
  const cascadePool = {
    query: (text, values) => pool.query(text, values),
    connect: () => pool.connect(),
  };
  const cascadeRecognitionStore = createMemoryRecognitionStore();
  const cascadeApp = buildApp({
    config,
    store: auth,
    pool: cascadePool,
    recognitionStore: cascadeRecognitionStore,
    now: () => new Date(),
  });
  let cascadeAppOpen = false;
  try {
    const e = await account('e');
    const recognitionId = randomUUID();
    const jobId = randomUUID();
    // 一条真实的（内存）识别行：`getRecognition` / `deleteRecognition` 读写的就是它。
    await cascadeRecognitionStore.insertJob({
      id: jobId,
      revision: 2,
      kind: 'recognition',
      ownerUserId: e.user.id,
      recognitionId,
      mediaId: randomUUID(),
      mediaRevision: 1,
      state: 'succeeded',
      deadlineAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      errorCode: null,
    });
    await cascadeRecognitionStore.insertRecognition({
      id: recognitionId,
      revision: 2,
      ownerUserId: e.user.id,
      mediaId: randomUUID(),
      mediaRevision: 1,
      candidates: [{ species_id: 'synthetic_cascade_weed', rank: 1, model_score: 0.77 }],
      uncertaintyReasons: [],
      selectedSpeciesId: null,
      modelVersion: 'synthetic-cascade-v1',
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    });
    const cascadeRow = await cascadeApp.historyService.appendHistory({
      owner_id: e.user.id,
      kind: 'recognition',
      target_ref: { type: 'recognition', id: recognitionId, revision: 2 },
      job_id: jobId,
      job_state: 'succeeded',
      event_key: `recognition:${jobId}`,
    });
    assert.equal(cascadeRow.created, true, '前置：历史行必须真的新建');
    assert.equal(await histCount(e.user.id), 1, '前置：历史行真的落进真库');

    await cascadeApp.listen({ host: '127.0.0.1', port: 0 });
    cascadeAppOpen = true;
    const cascadeBase = `http://127.0.0.1:${cascadeApp.server.address().port}`;
    const cascadeCall = async (method, path, extra = {}) => {
      const response = await fetch(cascadeBase + path, {
        method,
        headers: {
          authorization: `Bearer ${e.token}`,
          ...(extra.headers ?? {}),
        },
      });
      return { status: response.status, body: await response.json(), headers: response.headers };
    };

    const beforeDelete = await cascadeCall('GET', `/api/v1/recognitions/${recognitionId}`);
    assert.equal(beforeDelete.status, 200, '前置：识别记录此刻对本人可读');

    const delCascade = await cascadeCall('DELETE', `/api/v1/history/${cascadeRow.history.id}`, {
      headers: { 'idempotency-key': 'hist-pg-e-del-01', 'if-match': '"1"' },
    });
    assert.equal(delCascade.status, 202, JSON.stringify(delCascade.body));
    assert.deepEqual(delCascade.body.data, { accepted: true });
    assert.equal(
      delCascade.headers.get('x-gy-cascade'),
      'partial',
      '识别腿已删 + 媒体/外发未接 ⇒ 必须是 partial（unwired 说明接线没装上；failed 说明没删成）',
    );

    // ① 真库：历史行真的被删（不是只改了披露）。
    assert.equal(await histCount(e.user.id), 0, '真库 history 行必须 0 行（历史行已删）');
    // ② 识别域：那条记录被**真的软删**（deleted=true、revision 恰好 +1）。
    const deletedRecognition = await cascadeRecognitionStore.getRecognition(recognitionId);
    assert.equal(deletedRecognition.deleted, true, '级联必须把识别记录置 deleted=true');
    assert.equal(deletedRecognition.revision, 3, '软删按目标域自己的口径 revision 恰好 +1（2 → 3）');
    // ③ 读面：变 404，且与"从未存在"逐字同形（不泄露存在性）。
    const afterDelete = await cascadeCall('GET', `/api/v1/recognitions/${recognitionId}`);
    const neverExisted = await cascadeCall('GET', `/api/v1/recognitions/${randomUUID()}`);
    assert.equal(afterDelete.status, 404, '已软删的识别记录必须 404');
    assert.deepEqual(afterDelete.body.error, neverExisted.body.error, '已删与从未存在必须同形');
    say(
      '删历史 ⇒ 真库历史行 0 行 + 识别记录 deleted=true/revision 2→3 + GET 识别 404 同形；披露 partial',
    );

    // ④ 同键重放：回放**同一份**披露，且**不再删第二次**（revision 仍 3）。
    const replayDelete = await cascadeCall('DELETE', `/api/v1/history/${cascadeRow.history.id}`, {
      headers: { 'idempotency-key': 'hist-pg-e-del-01', 'if-match': '"1"' },
    });
    assert.equal(replayDelete.status, 202, JSON.stringify(replayDelete.body));
    assert.equal(replayDelete.headers.get('x-gy-cascade'), 'partial', '重放必须回放首次那份披露');
    assert.equal(
      (await cascadeRecognitionStore.getRecognition(recognitionId)).revision,
      3,
      '重放不得再触发一次关联删除（revision 不得再 +1）',
    );
    say('级联幂等重放：同键 ⇒ 同一份 partial 披露且不再删第二次（识别 revision 仍 3）');

    // ⑤ 反例：目标核不到（识别行不存在）⇒ 一项都没删成功 ⇒ `failed`，⛔ 不得记 `partial`。
    const missingHistory = await cascadeApp.historyService.appendHistory({
      owner_id: e.user.id,
      kind: 'recognition',
      target_ref: { type: 'recognition', id: randomUUID(), revision: 1 },
      job_id: randomUUID(),
      job_state: 'failed',
      event_key: `recognition:${randomUUID()}`,
    });
    assert.equal(missingHistory.created, true);
    const delMissing = await cascadeCall('DELETE', `/api/v1/history/${missingHistory.history.id}`, {
      headers: { 'idempotency-key': 'hist-pg-e-del-02', 'if-match': '"1"' },
    });
    assert.equal(delMissing.status, 202, JSON.stringify(delMissing.body));
    assert.equal(
      delMissing.headers.get('x-gy-cascade'),
      'failed',
      '目标核不到 ⇒ 一项都没删成功 ⇒ failed（⛔ 不得因"端口已接线"就记 partial）',
    );
    assert.equal(await histCount(e.user.id), 0, '这条历史行同样真的被删（级联失败不回滚历史行删除）');
    say('级联下限：目标核不到 ⇒ failed（不是 partial），历史行删除照常生效（不回滚）');
  } finally {
    if (cascadeAppOpen) await cascadeApp.close().catch(() => {});
  }

  // ---- 8. 进程重连 -------------------------------------------------------
  await pool.end();
  pool = createPool(url.href);
  const favorites2 = createPostgresFavoritesStore(pool);
  const history2 = createPostgresHistoryStore(pool);
  const survived = await favorites2.listFavoritesByOwner(a.user.id);
  assert.equal(survived.length, 1, '关掉连接池再新建后仍能读到同一行');
  assert.equal(survived[0].id, created.body.data.id);
  say('进程重连（新连接池）后收藏行仍在');

  // ---- 7. 注销清空返回真实行数 -------------------------------------------
  const historyRows = 2;
  for (let index = 0; index < historyRows; index += 1) {
    assert.equal(
      await history2.insertHistory({
        id: randomUUID(),
        revision: 1,
        owner_id: ownerA,
        kind: index === 0 ? 'recognition' : 'ocr',
        target_ref: { type: index === 0 ? 'recognition' : 'ocr', id: `rec-del-${index}`, revision: 1 },
        job_id: `job-del-${index}`,
        job_state: index === 0 ? 'succeeded' : 'timed_out',
        created_at: new Date(Date.now() + index).toISOString(),
        event_key: `evt-del-${index}`,
      }),
      'inserted',
    );
  }
  const timedOut = await history2.findByEventKey(ownerA, 'evt-del-1');
  assert.equal((await history2.getHistory(timedOut.id)).job_state, 'timed_out', '非成功终态原样保留');
  assert.equal(await history2.deleteAllByOwner(ownerA), historyRows, '返回真实删除行数（不是估算）');
  assert.equal(await history2.deleteAllByOwner(ownerA), 0, '再清一次 ⇒ 0（幂等）');
  assert.equal(await favorites2.deleteAllByOwner(ownerB), 1, '收藏域同样返回真实行数');
  // ⚠️ R31-I16 起本文件 §10/§11 会为另一个主体（`c`）留下真实的收藏/历史行，且那些行**不该**被本组清掉，
  // 因此这里把"历史表归零"钉在**被清主体**上（原断言是全表为空，等价且更精确）。
  assert.equal(
    (await owner.query('SELECT count(*)::int n FROM history WHERE owner_id = ANY($1)', [[ownerA, ownerB]])).rows[0].n,
    0,
    '被清主体的历史行归零',
  );
  say('注销清空 deleteAllByOwner 返回真实删除行数（两域各一次，他人行不受影响）');

  // ---- 9. 注销清空必须覆盖幂等台账（监工 P1 返修） ------------------------
  // 真库、两个全新主体：A 的正文行与台账行（含"只认领未完成"、`expires_at` 尚未到期的行）全部清空，
  // B 的四张表逐表与删除前相等（行、列、值都不变）；证据里必须看得见两张台账各清了几行。
  const purgeA = (await owner.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id;
  const purgeB = (await owner.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id;
  const scopeOf = (subject, method, path) => `${subject}\n${method}\n${path}`;
  // 24 小时后的过期时刻：`expires_at` 绝不是删除保证 —— 这行不会被"等过期"清掉。
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  const claim = (store, scope, key) =>
    store.claimIdempotency(scope, key, { request_hash: 'h'.repeat(64), response_status: 200, expires_at: expiresAt });

  for (const [subject, targetId] of [
    [purgeA, 'spc-purge-a'],
    [purgeB, 'spc-purge-b'],
  ]) {
    assert.equal(
      await favorites2.insertFavorite({
        id: randomUUID(),
        revision: 1,
        owner_id: subject,
        target_ref: { type: 'species', id: targetId, revision: 1 },
        created_at: new Date().toISOString(),
      }),
      'inserted',
    );
  }
  for (const [subject, kind, tag] of [
    [purgeA, 'recognition', 'a'],
    [purgeB, 'ocr', 'b'],
  ]) {
    assert.equal(
      await history2.insertHistory({
        id: randomUUID(),
        revision: 1,
        owner_id: subject,
        kind,
        target_ref: { type: kind, id: `rec-purge-${tag}`, revision: 1 },
        job_id: `job-purge-${tag}`,
        job_state: 'succeeded',
        created_at: new Date().toISOString(),
        event_key: `evt-purge-${tag}`,
      }),
      'inserted',
    );
  }

  // A：收藏域 2 条台账（1 已完成 + 1 只认领未完成）、历史域 1 条；B：两域各 1 条，必须原样保留。
  const purgeAFavPost = scopeOf(purgeA, 'POST', '/api/v1/favorites');
  assert.equal(await claim(favorites2, purgeAFavPost, '1'.repeat(64)), true);
  assert.equal(
    await favorites2.completeIdempotency(purgeAFavPost, '1'.repeat(64), {
      response_status: 201,
      outcome: { kind: 'favorite', id: randomUUID(), revision: 1 },
    }),
    true,
  );
  assert.equal(await claim(favorites2, scopeOf(purgeA, 'DELETE', `/api/v1/favorites/${randomUUID()}`), '2'.repeat(64)), true);
  assert.equal(await claim(history2, scopeOf(purgeA, 'DELETE', `/api/v1/history/${randomUUID()}`), '3'.repeat(64)), true);
  assert.equal(await claim(favorites2, scopeOf(purgeB, 'POST', '/api/v1/favorites'), '4'.repeat(64)), true);
  assert.equal(await claim(history2, scopeOf(purgeB, 'DELETE', `/api/v1/history/${randomUUID()}`), '5'.repeat(64)), true);

  // 主体前缀即 `scope` 第一段（uuid 定长 + 换行），不用 `LIKE`（`_`/`%` 会误伤）。
  const ownerPrefix = `left(scope, char_length($1::text) + 1) = $1::text || chr(10)`;
  const snapshotOf = async (subject) => ({
    favorites: (await owner.query('SELECT * FROM favorites WHERE owner_id = $1 ORDER BY id', [subject])).rows,
    history: (await owner.query('SELECT * FROM history WHERE owner_id = $1 ORDER BY id', [subject])).rows,
    favorites_idempotency: (
      await owner.query(`SELECT * FROM favorites_idempotency WHERE ${ownerPrefix} ORDER BY scope, key_hash`, [subject])
    ).rows,
    history_idempotency: (
      await owner.query(`SELECT * FROM history_idempotency WHERE ${ownerPrefix} ORDER BY scope, key_hash`, [subject])
    ).rows,
  });
  const beforeB = await snapshotOf(purgeB);
  assert.equal(beforeB.favorites.length, 1, 'B 的收藏行已在（下面的"逐表相等"不能对着空快照成立）');
  assert.equal(beforeB.history.length, 1);
  assert.equal(beforeB.favorites_idempotency.length, 1);
  assert.equal(beforeB.history_idempotency.length, 1);
  const beforeA = await snapshotOf(purgeA);
  assert.equal(beforeA.favorites_idempotency.length, 2);
  assert.equal(beforeA.history_idempotency.length, 1);

  // #17 消息域（C1b 起进闭集）：**本 arm 只应用 0001/0008/0018 三个迁移**（见上方 `applyMigrations`
  // 的断言），没有 `public.messages` 表；因此这里给内存实现，只用来证明「闭集里的第三项也被
  // 驱动且如实报 online_state」。消息域的**真库**清理证据在
  // `tests/unit/favorites-history-deletion-registration.test.mjs`（PGlite 真表）与
  // `tests/integration/messages-pg.mjs`。
  const messages2 = createMemoryMessagesStore({ now: () => Date.now() });
  const deletion = createUserDataDeletion({
    favoritesStore: favorites2,
    historyStore: history2,
    messagesStore: messages2,
    // 会话域（C1b-3 起进闭集）：同一理由，本 arm 没有 0013 的会话表 ⇒ 用内存实现。
    conversationsStore: createMemoryConversationStore(),
  });
  const purgeRequestId = String(deletion.requestDeletionFor(purgeA).id);
  await deletion.executeHandlers(purgeRequestId);

  const residualOf = async (subject) => ({
    favorites: (await owner.query('SELECT count(*)::int n FROM favorites WHERE owner_id = $1', [subject])).rows[0].n,
    history: (await owner.query('SELECT count(*)::int n FROM history WHERE owner_id = $1', [subject])).rows[0].n,
    favorites_idempotency: (
      await owner.query(`SELECT count(*)::int n FROM favorites_idempotency WHERE ${ownerPrefix}`, [subject])
    ).rows[0].n,
    history_idempotency: (
      await owner.query(`SELECT count(*)::int n FROM history_idempotency WHERE ${ownerPrefix}`, [subject])
    ).rows[0].n,
  });
  assert.deepEqual(
    await residualOf(purgeA),
    { favorites: 0, history: 0, favorites_idempotency: 0, history_idempotency: 0 },
    '注销后 A 的四张表残留均为 0（含未完成 claim、未过期行）',
  );
  assert.deepEqual(await snapshotOf(purgeB), beforeB, '注销 A 不得改动 B 的任何一行（四张表逐表相等）');

  const handlers = new Map(deletion.receipt(purgeRequestId).handlers.map((row) => [row.module, row]));
  assert.equal(handlers.get('favorites').online_state, 'completed');
  // 契约回执形状按 openapi 固定（不含 evidence）；证据走同源的诊断视图。
  const evidence = deletion.evidenceOf(purgeRequestId);
  assert.equal(
    evidence.favorites,
    'favorites:online-purged:1;favorites:idempotency-purged:2',
    '收藏域证据须同时含正文行数与台账行数',
  );
  assert.equal(evidence.history, 'history:online-purged:1;history:idempotency-purged:1');
  // 闭集第三项（#17 消息域）也被驱动，且如实报 0 行（本 arm 没有消息行，缺项 ≠ 0）。
  assert.equal(handlers.get('messages').online_state, 'completed', '闭集里的消息域必须被驱动');
  assert.equal(evidence.messages, 'messages:online-purged:0;messages:idempotency-purged:0');
  // 闭集第四项（#12 会话域）同样被驱动。
  assert.equal(handlers.get('conversations').online_state, 'completed', '闭集里的会话域必须被驱动');
  assert.equal(evidence.conversations, 'conversations:online-purged:0');
  say('注销清空覆盖幂等台账：A 四表残留 0、B 逐表相等、证据可见台账行数');

  // ---- 1（续）. 回滚脚本 + 旁证表 + REPLAY -------------------------------
  // 旁证：`users`（0001）与 `idempotency_keys`（0008）在回滚前后必须**逐字**不变（列定义 + 行内容）。
  // 为了不让"行内容相等"退化成"空表比空表"，先塞一条合法的 `idempotency_keys` 行（列见 0008:46-57）。
  await owner.query(
    `INSERT INTO idempotency_keys (scope, key_hash, request_hash, response_status, outcome, expires_at)
     VALUES ($1, decode(repeat('ab', 32), 'hex'), repeat('c', 64), 201,
             '{"kind":"auth","sessionId":"i16-pg-witness"}'::jsonb, now() + interval '1 hour')`,
    ['i16-pg-rollback-witness'],
  );
  const witnessOf = async () => ({
    columns: (
      await owner.query(
        `SELECT table_name, ordinal_position, column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ANY($1)
          ORDER BY table_name, ordinal_position`,
        [sideTables],
      )
    ).rows,
    usersRows: (await owner.query('SELECT * FROM users ORDER BY id')).rows,
    idempotencyRows: (
      await owner.query(
        'SELECT scope, key_hash, request_hash, response_status, outcome, expires_at FROM idempotency_keys ORDER BY scope',
      )
    ).rows,
  });
  const witnessBefore = await witnessOf();
  assert.equal(witnessBefore.idempotencyRows.length, 1, '旁证行确实在（不是空表比空表）');
  assert.equal(
    witnessBefore.columns.filter((row) => row.table_name === 'idempotency_keys').length,
    8,
    '0008 的 idempotency_keys 8 列都在',
  );

  await owner.query(sqlFile('migrations/rollback/0018_favorites_history.down.sql'));
  const gone = await owner.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1)",
    [tables],
  );
  assert.equal(gone.rows.length, 0, '回滚后 4 张表全部消失');
  assert.deepEqual(
    await witnessOf(),
    witnessBefore,
    '回滚 0018 不得动 users（0001）与 idempotency_keys（0008）：列与行必须逐字仍在',
  );
  say('回滚 0018：本片 4 张表消失，而 users（0001）/ idempotency_keys（0008）的列与行逐字仍在');

  // REPLAY：删掉台账里的 0018 行后再走迁移器（等价于"回滚后又重放同一版本"）⇒ 4 张表再出现，
  // 两张旁证表仍逐字不变（`down.sql` 本身不清 `schema_migrations`，见 rollback/0018_favorites_history.down.sql）。
  await owner.query("DELETE FROM schema_migrations WHERE version = '0018'");
  assert.deepEqual((await applyMigrations(owner, migrations)).applied, ['0018'], 'REPLAY 只重放 0018 一个版本');
  const replayed = await owner.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1) ORDER BY tablename",
    [tables],
  );
  assert.deepEqual(replayed.rows.map((row) => row.tablename), [...tables].sort(), 'REPLAY 后 4 张表全部再出现');
  assert.deepEqual(await witnessOf(), witnessBefore, 'REPLAY 同样不得动两张旁证表');
  say('REPLAY 0018（删台账行后重跑迁移器）：4 张表再出现，users / idempotency_keys 仍逐字不变');

  console.log(`\nALL PASS (${passed} groups) — real PG17 ${version}`);
} finally {
  if (app !== null) await app.close().catch(() => {});
  if (pool !== null) await pool.end().catch(() => {});
  await owner.end().catch(() => {});
}
