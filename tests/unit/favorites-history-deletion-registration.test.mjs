// GY-I16 阶段 2（#16）· **注销清空真的打到 PG 表上**（不是内存替身，也不只看"调用过"）。
//
// 与 `tests/unit/user-data-deletion.test.mjs` 的分工（那个文件继续锁**协议语义**，本文件只补
// 阶段 2 新增的那一层）：
//   * 那里用内存 store 证明「按主体清空、他人不受影响、证据行数、备份如实 pending」；
//   * 这里用 `buildApp` 的**生产装配**（`real` + 真 SQL 引擎的 pool）证明
//     「`app.ts` 传进注销协调器的是**同一批 PG store**」——清空后**真表**行数为 0，
//     且协调器记录的行数＝真实删除行数（`audit().onlineRemoved`）。
// 计数不是猜的：`deleteAllByOwner` 的实现是 `DELETE … RETURNING id` 计行数，行数直接进证据。
//
// PGlite 只证明 SQL 语义与装配；真库覆盖在 `tests/integration/favorites-history-pg.mjs`
// （那边是同一批 `deleteAllByOwner` 断言 + 真 PG17）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createPostgresFavoritesStore } from '../../services/api/src/favorites/store-pg.ts';
import { createPostgresHistoryStore } from '../../services/api/src/history/store-pg.ts';
import { USER_DATA_DELETION_MODULES } from '../../services/api/src/privacy/user-data-deletion.ts';
import { pglitePool } from './favorites-history-fixtures.mjs';

const realConfig = () => ({
  ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
  executionMode: 'real',
  requiresRealCredentials: true,
});

test('注销清空·装配：real + pool ⇒ 协调器拿到的是 PG store，清空后真表为 0 且行数进证据', async (t) => {
  const { db, pool } = await pglitePool(t);
  const auth = createMemoryAuthStore();
  // `requests: null` 是 `app.ts` 支持的**显式关闭**口：本用例只锁"清空接线"，不锁
  // GY-I19 的持久化受理（那条链路由 `account-deletion-*.test.mjs` 覆盖）。
  const app = buildApp({
    config: realConfig(),
    store: auth,
    pool,
    now: () => new Date(),
    userDataDeletionInjection: { requests: null },
  });
  t.after(() => app.close());

  const mine = await auth.createUser('e'.repeat(64));
  const others = await auth.createUser('f'.repeat(64));
  for (const user of [mine, others]) await db.query('INSERT INTO users (id) VALUES ($1::uuid)', [user.id]);

  // 造行用**同一个 PG 实现**（不是内存替身）：行落在 app 装配读写的同一批表上。
  const favorites = createPostgresFavoritesStore(pool);
  const history = createPostgresHistoryStore(pool);
  assert.equal(
    await favorites.insertFavorite({
      id: randomUUID(),
      revision: 1,
      owner_id: mine.id,
      target_ref: { type: 'species', id: 'spc-del-1', revision: 1 },
      created_at: new Date().toISOString(),
    }),
    'inserted',
  );
  for (const [index, kind] of ['recognition', 'ocr'].entries()) {
    assert.equal(
      await history.insertHistory({
        id: randomUUID(),
        revision: 1,
        owner_id: mine.id,
        kind,
        target_ref: { type: kind, id: `rec-del-${index}`, revision: 1 },
        job_id: `job-del-${index}`,
        job_state: index === 0 ? 'succeeded' : 'timed_out',
        created_at: new Date(Date.now() + index).toISOString(),
        event_key: `evt-del-${index}`,
      }),
      'inserted',
    );
  }
  // 他人的行：清空必须**碰不到**。
  assert.equal(
    await favorites.insertFavorite({
      id: randomUUID(),
      revision: 1,
      owner_id: others.id,
      target_ref: { type: 'species', id: 'spc-del-1', revision: 1 },
      created_at: new Date().toISOString(),
    }),
    'inserted',
  );
  assert.equal((await db.query('SELECT count(*)::int n FROM favorites')).rows[0].n, 2);
  assert.equal((await db.query('SELECT count(*)::int n FROM history')).rows[0].n, 2);

  // 模块闭集不变（本片没有偷偷加第三个模块、也没有把 favorites/history 从闭集里摘掉）。
  assert.deepEqual(app.userDataDeletion.requiredModules(), [...USER_DATA_DELETION_MODULES]);
  assert.deepEqual(app.userDataDeletion.requiredModules(), ['favorites', 'history']);

  const request = app.userDataDeletion.requestDeletionFor(mine.id);
  const requestId = String(request.id);
  assert.ok(requestId.length > 0);
  await app.userDataDeletion.executeHandlers(requestId);

  // 真表：本主体清空、他人完好（行数是**真删**的结果，不是"调用了就算"）。
  assert.equal((await db.query('SELECT count(*)::int n FROM favorites WHERE owner_id = $1', [mine.id])).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM history WHERE owner_id = $1', [mine.id])).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int n FROM favorites WHERE owner_id = $1', [others.id])).rows[0].n, 1);
  assert.equal((await favorites.listFavoritesByOwner(others.id)).length, 1);

  // 行数进证据：favorites 1 行、history 2 行（与真实删除行数逐一对上）。
  const audit = app.userDataDeletion.audit().filter((entry) => entry.requestId === requestId);
  const removed = Object.fromEntries(audit.map((entry) => [entry.module, entry.onlineRemoved]));
  assert.deepEqual(removed, { favorites: 1, history: 2 });
  assert.deepEqual(
    audit.map((entry) => entry.userId),
    [mine.id, mine.id],
    '审计只记目标主体',
  );

  // 回执：两个模块的在线行都如实 `completed`，备份仍如实 `pending`（未接线不谎称完成）。
  const receipt = app.userDataDeletion.receipt(requestId);
  const byModule = new Map(receipt.handlers.map((row) => [row.module, row]));
  for (const module of ['favorites', 'history']) {
    assert.equal(byModule.get(module).online_state, 'completed');
    assert.equal(byModule.get(module).backup_state, 'pending');
    assert.equal(byModule.get(module).error_code, null);
  }
  assert.equal(app.userDataDeletion.completionStatus(requestId).completed, false);
});

test('注销清空·再次清空：0 行也如实回 0（不省略、不当作失败）', async (t) => {
  const { db, pool } = await pglitePool(t);
  const auth = createMemoryAuthStore();
  const app = buildApp({
    config: realConfig(),
    store: auth,
    pool,
    now: () => new Date(),
    userDataDeletionInjection: { requests: null },
  });
  t.after(() => app.close());

  const user = await auth.createUser('g'.repeat(64));
  await db.query('INSERT INTO users (id) VALUES ($1::uuid)', [user.id]);

  const request = app.userDataDeletion.requestDeletionFor(user.id);
  const requestId = String(request.id);
  await app.userDataDeletion.executeHandlers(requestId);

  const audit = app.userDataDeletion.audit().filter((entry) => entry.requestId === requestId);
  const removed = Object.fromEntries(audit.map((entry) => [entry.module, entry.onlineRemoved]));
  assert.deepEqual(removed, { favorites: 0, history: 0 }, '无行时两个模块都记 0（不是缺项）');
  const receipt = app.userDataDeletion.receipt(requestId);
  for (const row of receipt.handlers) assert.equal(row.online_state, 'completed');
});
