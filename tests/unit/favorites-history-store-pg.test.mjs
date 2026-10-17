// GY-I16 阶段 2（#16）· **PG store 逐方法语义**（PGlite＝真 SQL 引擎，不是内存替身）。
//
// 为什么与 HTTP 用例分开：HTTP 只走到 favorites 的 insert/去重/删除与 history 的 insert/列表，
// 剩下的**同一批方法**（history 的 CAS 删除、两个域的 `deleteAllByOwner` 计行数、幂等台账的
// `release`／过期清理／`awaitIdempotencySettled` 有界轮询）在 HTTP 面打不到。这些正是
// 「唯一约束去重、CAS 删除、台账真落库」三条验收里最容易写成假实现的地方（先查后写／进程内 Map），
// 因此在 store 层逐条锁死。
//
// 声明：PGlite 只证明**SQL 语义**，不构成 PG17 真机验收（真库覆盖见
// `tests/integration/favorites-history-pg.mjs`，需显式提供 `FAVORITES_HISTORY_PG_TEST_URL`）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createPostgresFavoritesStore } from '../../services/api/src/favorites/store-pg.ts';
import { createPostgresHistoryStore } from '../../services/api/src/history/store-pg.ts';
import { pglitePool } from './favorites-history-fixtures.mjs';

const NOW = Date.UTC(2026, 9, 17, 4);
const iso = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();

/** 建库 + 两个 owner（`owner_id` 有 `users(id)` 外键，必须真实存在）。 */
async function setup(t) {
  const { db, pool } = await pglitePool(t);
  const ownerA = (await db.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id;
  const ownerB = (await db.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id;
  return { db, pool, ownerA, ownerB, favorites: createPostgresFavoritesStore(pool), history: createPostgresHistoryStore(pool) };
}

function favorite(owner_id, overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    owner_id,
    target_ref: { type: 'species', id: 'spc-1', revision: 3 },
    created_at: iso(),
    ...overrides,
  };
}

function historyRow(owner_id, overrides = {}) {
  return {
    id: randomUUID(),
    revision: 1,
    owner_id,
    kind: 'recognition',
    target_ref: { type: 'recognition', id: 'rec-1', revision: 2 },
    job_id: 'job-1',
    job_state: 'succeeded',
    created_at: iso(),
    event_key: 'evt-1',
    ...overrides,
  };
}

test('PG store：如实声明 persistent，写入后逐字段读回（ISO 字符串不变形）', async (t) => {
  const { favorites, history, ownerA } = await setup(t);
  assert.equal(favorites.persistent, true);
  assert.equal(history.persistent, true);

  const row = favorite(ownerA);
  assert.equal(await favorites.insertFavorite(row), 'inserted');
  assert.deepEqual(await favorites.getFavorite(row.id), row);
  assert.equal(await favorites.getFavorite(randomUUID()), null);

  const event = historyRow(ownerA, { job_state: 'failed' });
  assert.equal(await history.insertHistory(event), 'inserted');
  assert.deepEqual(await history.getHistory(event.id), event);
  assert.equal((await history.getHistory(event.id)).job_state, 'failed', '失败终态原样保留，不折叠成 succeeded');
  assert.deepEqual(await history.findByEventKey(ownerA, 'evt-1'), event);
  assert.equal(await history.findByEventKey(ownerA, 'evt-none'), null);
});

test('PG store：去重由**唯一约束**裁决（同 id／同目标／同 event_key／非闭集状态）', async (t) => {
  const { db, favorites, history, ownerA } = await setup(t);
  const row = favorite(ownerA);
  assert.equal(await favorites.insertFavorite(row), 'inserted');
  assert.equal(await favorites.insertFavorite({ ...row }), 'duplicate', '同 id');
  assert.equal(await favorites.insertFavorite(favorite(ownerA, { id: randomUUID() })), 'duplicate', '同 (owner,target)');
  assert.equal((await db.query('SELECT count(*)::int n FROM favorites')).rows[0].n, 1, '行数不增');

  const event = historyRow(ownerA);
  assert.equal(await history.insertHistory(event), 'inserted');
  assert.equal(await history.insertHistory({ ...event, id: randomUUID() }), 'duplicate', '同 (owner,event_key)');
  assert.equal(
    await history.insertHistory({ ...event, id: randomUUID(), event_key: 'evt-other' }),
    'duplicate',
    '同 (owner,kind,target_id)（第二道去重键）',
  );
  assert.equal(
    await history.insertHistory({ ...event, id: randomUUID(), event_key: 'evt-third', job_state: 'not-a-state' }),
    'duplicate',
    '非闭集状态与内存实现一致返回 duplicate（不写坏行、不抛 500）',
  );
  assert.equal((await db.query('SELECT count(*)::int n FROM history')).rows[0].n, 1);
});

test('PG store：归属分域——同一目标两个主体各一行，查询只按 owner 过滤', async (t) => {
  const { favorites, history, ownerA, ownerB } = await setup(t);
  const a = favorite(ownerA);
  const b = favorite(ownerB);
  assert.equal(await favorites.insertFavorite(a), 'inserted');
  assert.equal(await favorites.insertFavorite(b), 'inserted', '唯一性按 owner 分域');
  assert.deepEqual(await favorites.findByTarget(ownerA, 'species', 'spc-1'), a);
  assert.deepEqual(await favorites.findByTarget(ownerB, 'species', 'spc-1'), b);
  assert.deepEqual(await favorites.listFavoritesByOwner(ownerB), [b]);
  assert.equal(await favorites.findByTarget(ownerB, 'herbicide', 'spc-1'), null);

  const ha = historyRow(ownerA);
  const hb = historyRow(ownerB);
  assert.equal(await history.insertHistory(ha), 'inserted');
  assert.equal(await history.insertHistory(hb), 'inserted');
  assert.deepEqual(await history.listHistoryByOwner(ownerA), [ha]);
  assert.deepEqual(await history.findByTarget(ownerB, 'recognition', 'rec-1'), hb);
});

test('PG store：CAS 删除四态（NOT_FOUND／OWNER_CHANGED／REVISION_CHANGED／命中即物理删除）', async (t) => {
  const { db, favorites, history, ownerA, ownerB } = await setup(t);
  const row = favorite(ownerA);
  await favorites.insertFavorite(row);
  assert.deepEqual(await favorites.deleteFavorite(randomUUID(), { revision: 1 }), { ok: false, reason: 'NOT_FOUND' });
  assert.deepEqual(
    await favorites.deleteFavorite(row.id, { revision: 1, owner_id: ownerB }),
    { ok: false, reason: 'OWNER_CHANGED' },
    '他人 id 不得删得掉',
  );
  assert.deepEqual(await favorites.deleteFavorite(row.id, { revision: 2 }), { ok: false, reason: 'REVISION_CHANGED' });
  const deleted = await favorites.deleteFavorite(row.id, { revision: 1, owner_id: ownerA });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.record.id, row.id);
  assert.equal(await favorites.getFavorite(row.id), null);
  assert.equal((await db.query('SELECT count(*)::int n FROM favorites')).rows[0].n, 0, '物理删除，不留墓碑');

  const event = historyRow(ownerA);
  await history.insertHistory(event);
  assert.deepEqual(await history.deleteHistory(randomUUID(), { revision: 1 }), { ok: false, reason: 'NOT_FOUND' });
  assert.deepEqual(await history.deleteHistory(event.id, { revision: 1, owner_id: ownerB }), { ok: false, reason: 'OWNER_CHANGED' });
  assert.deepEqual(await history.deleteHistory(event.id, { revision: 9 }), { ok: false, reason: 'REVISION_CHANGED' });
  assert.equal((await history.deleteHistory(event.id, { revision: 1, owner_id: ownerA })).ok, true);
  assert.equal(await history.getHistory(event.id), null);
});

test('PG store：幂等台账真落库（认领／二次认领拒绝／完成／二次完成拒绝／释放／过期清理）', async (t) => {
  const { db, favorites, ownerA } = await setup(t);
  const scope = `${ownerA}\nPOST\n/api/v1/favorites`;
  const key = 'a'.repeat(64);
  const soon = Date.now() + 60_000;

  assert.equal(
    await favorites.claimIdempotency(scope, key, { request_hash: 'h'.repeat(64), response_status: 201, expires_at: soon }),
    true,
  );
  assert.equal(
    await favorites.claimIdempotency(scope, key, { request_hash: 'h'.repeat(64), response_status: 201, expires_at: soon }),
    false,
    '未过期且已占用 ⇒ 不得二次认领',
  );
  assert.equal(await favorites.findIdempotency(scope, key), null, '已认领未完成 ⇒ 对读面不可见（与内存实现一致）');

  const outcome = { kind: 'favorite', id: randomUUID(), revision: 1 };
  assert.equal(await favorites.completeIdempotency(scope, key, { response_status: 201, outcome }), true);
  const settled = await favorites.findIdempotency(scope, key);
  assert.deepEqual(settled.outcome, outcome);
  assert.equal(settled.response_status, 201);
  assert.equal(settled.request_hash, 'h'.repeat(64));
  assert.equal(
    await favorites.completeIdempotency(scope, key, { response_status: 200, outcome }),
    false,
    '已完成的结果不得被覆盖',
  );
  await favorites.releaseIdempotency(scope, key);
  assert.deepEqual((await favorites.findIdempotency(scope, key)).outcome, outcome, '释放只作用于"已认领未完成"');

  const releaseKey = 'b'.repeat(64);
  assert.equal(
    await favorites.claimIdempotency(scope, releaseKey, { request_hash: 'x'.repeat(64), response_status: 201, expires_at: soon }),
    true,
  );
  await favorites.releaseIdempotency(scope, releaseKey);
  assert.equal(await favorites.findIdempotency(scope, releaseKey), null);
  assert.equal((await db.query('SELECT count(*)::int n FROM favorites_idempotency WHERE key_hash = $1', [releaseKey])).rows[0].n, 0);

  const expiredKey = 'c'.repeat(64);
  assert.equal(
    await favorites.claimIdempotency(scope, expiredKey, {
      request_hash: 'y'.repeat(64),
      response_status: 201,
      expires_at: Date.now() - 1000,
    }),
    true,
  );
  assert.equal(await favorites.findIdempotency(scope, expiredKey), null, '过期槽位 ⇒ null');
  assert.equal(
    (await db.query('SELECT count(*)::int n FROM favorites_idempotency WHERE key_hash = $1', [expiredKey])).rows[0].n,
    0,
    '过期槽位被真删（不是进程内忽略）',
  );

  // 过期槽位可被重新认领（与内存实现同语义：过期即视为空位）。
  assert.equal(
    await favorites.claimIdempotency(scope, expiredKey, { request_hash: 'z'.repeat(64), response_status: 202, expires_at: soon }),
    true,
  );
});

test('PG store：awaitIdempotencySettled 有界轮询且**真读库**（另一条连接写入即唤醒）', async (t) => {
  const { db, history, ownerA } = await setup(t);
  const scope = `${ownerA}\nPOST\n/api/v1/history`;
  const key = 'd'.repeat(64);
  assert.equal(
    await history.claimIdempotency(scope, key, { request_hash: 'q'.repeat(64), response_status: 200, expires_at: Date.now() + 60_000 }),
    true,
  );
  assert.equal(await history.awaitIdempotencySettled(scope, key, 60), 'timeout', '无人完成 ⇒ 有界等待后 timeout');

  const waiting = history.awaitIdempotencySettled(scope, key, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 80));
  // 用**另一条路径**（直连 db，不经 store 对象）写入完成结果：若实现是进程内 Map 假装，这里永远不会被唤醒。
  const outcome = { kind: 'history', id: randomUUID(), revision: 1, cascade: 'unwired' };
  await db.query(
    'UPDATE history_idempotency SET outcome = $3::jsonb, response_status = 200 WHERE scope = $1 AND key_hash = $2 AND outcome IS NULL',
    [scope, key, JSON.stringify(outcome)],
  );
  assert.equal(await waiting, 'settled');
  assert.deepEqual((await history.findIdempotency(scope, key)).outcome, outcome);

  assert.equal(await history.awaitIdempotencySettled(scope, 'f'.repeat(64), 40), 'settled', '槽位不存在 ⇒ 立刻 settled');
});

test('PG store：deleteAllByOwner 返回**真实删除行数**，他人行不受影响', async (t) => {
  const { db, favorites, history, ownerA, ownerB } = await setup(t);
  await favorites.insertFavorite(favorite(ownerA));
  await favorites.insertFavorite(favorite(ownerB));
  for (const [index, kind] of ['recognition', 'ocr'].entries()) {
    await history.insertHistory(
      historyRow(ownerA, {
        kind,
        target_ref: { type: kind, id: `rec-del-${index}`, revision: 1 },
        job_id: `job-del-${index}`,
        job_state: index === 0 ? 'succeeded' : 'timed_out',
        event_key: `evt-del-${index}`,
      }),
    );
  }
  await history.insertHistory(historyRow(ownerB, { target_ref: { type: 'recognition', id: 'rec-b', revision: 1 }, job_id: 'job-b', event_key: 'evt-b' }));

  assert.equal(await history.deleteAllByOwner(ownerA), 2);
  assert.equal(await history.deleteAllByOwner(ownerA), 0, '再清一次 ⇒ 0（幂等）');
  assert.equal(await favorites.deleteAllByOwner(ownerA), 1);
  assert.equal(await favorites.deleteAllByOwner(ownerA), 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM favorites WHERE owner_id = $1', [ownerB])).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int n FROM history WHERE owner_id = $1', [ownerB])).rows[0].n, 1);
});

test('迁移 0018：回滚脚本把四张表整表拆干净（纯新增 ⇒ 不动既有表）', async (t) => {
  const { db } = await setup(t);
  const down = readFileSync(
    new URL('../../services/api/db/migrations/rollback/0018_favorites_history.down.sql', import.meta.url),
    'utf8',
  );
  await db.exec(down);
  const gone = await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)",
    [['favorites', 'history', 'favorites_idempotency', 'history_idempotency']],
  );
  assert.deepEqual(gone.rows, [], '回滚后四张表全部消失');
  const users = await db.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'");
  assert.equal(users.rows[0].n, 1, '既有 users 表不得被回滚波及');
});
