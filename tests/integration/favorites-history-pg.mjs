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
 *   8. 进程重连（关掉连接池再新建）后数据仍在。
 *
 * 运行：`FAVORITES_HISTORY_PG_TEST_URL=postgres://…/gengyun_favorites_history_test \
 *        node tests/integration/favorites-history-pg.mjs`
 * 未配置该变量 ⇒ 打印 `SKIP` 并以 0 退出：本次运行**没有**验证真库（不是通过）。
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
import { createPostgresHistoryStore } from '../../services/api/src/history/store-pg.ts';

const ENV = 'FAVORITES_HISTORY_PG_TEST_URL';
const raw = process.env[ENV] ?? '';
if (raw === '') {
  // 显式跳过并打印：**不得**被当成"真库已验证"（绿），也不静默失败。
  console.log(`SKIP real PG17: ${ENV} 未设置 —— 本次运行没有验证真库持久化（不是通过，也不是失败）。`);
  console.log(`     运行方式：${ENV}=postgres://postgres@127.0.0.1:5432/gengyun_favorites_history_test node tests/integration/favorites-history-pg.mjs`);
  process.exit(0);
}

const url = new URL(raw);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'postgres URL only');
assert.equal(url.search, '', '不要把参数塞进连接串（测试库校验只认 pathname）');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'loopback only');
assert.equal(url.pathname, '/gengyun_favorites_history_test', 'dedicated test DB only');

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
  const migrations = discoverMigrations().filter((m) => ['0001', '0018'].includes(m.version));
  assert.deepEqual(migrations.map((m) => m.version), ['0001', '0018'], '0001（users）+ 0018（本片新表）');
  assert.deepEqual((await applyMigrations(owner, migrations)).applied, ['0001', '0018']);
  assert.equal((await applyMigrations(owner, migrations)).applied.length, 0, '重复应用必须 no-op');
  const tables = ['favorites', 'history', 'favorites_idempotency', 'history_idempotency'];
  const present = await owner.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1) ORDER BY tablename",
    [tables],
  );
  assert.deepEqual(present.rows.map((row) => row.tablename), [...tables].sort());
  say('0018 在真库应用成功（4 张表）、重复应用 no-op');

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
  app = buildApp({ config, store: auth, pool, now: () => new Date() });
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
    return { status: response.status, body: await response.json() };
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
  );  assert.deepEqual((await call('GET', '/api/v1/favorites', b)).body.data, { items: [], next_cursor: null });
  say('HTTP 面：real+pool 真的 201/200 落库；他人 id 与不存在同形 404');

  await app.close();
  app = null;

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
  assert.equal((await owner.query('SELECT count(*)::int n FROM history')).rows[0].n, 0);
  say('注销清空 deleteAllByOwner 返回真实删除行数（两域各一次，他人行不受影响）');

  // ---- 1（续）. 回滚脚本 -------------------------------------------------
  await owner.query(sqlFile('migrations/rollback/0018_favorites_history.down.sql'));
  const gone = await owner.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1)",
    [tables],
  );
  assert.equal(gone.rows.length, 0, '回滚后 4 张表全部消失');
  say('回滚脚本 0018_favorites_history.down.sql 整表拆干净');

  console.log(`\nALL PASS (${passed} groups) — real PG17 ${version}`);
} finally {
  if (app !== null) await app.close().catch(() => {});
  if (pool !== null) await pool.end().catch(() => {});
  await owner.end().catch(() => {});
}
