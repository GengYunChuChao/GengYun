/**
 * GY-I17（#17）· 注销清理原语单测（B4 文档 §7 P0-1）。
 *
 * 覆盖两件事：
 *   ① `messages/store.ts` 的内存实现与 `messages/store-pg.ts` 的 PG 实现都真的**按主体物理删除**
 *      正文行，并在**同一事务**里清掉该主体落在共享幂等台账 `public.idempotency_keys` 的行；
 *   ② 两个行数证据只来自 `DELETE ... RETURNING` 的实际返回行数，失败如实抛出、绝不用
 *      "调用没报错"冒充"删了 N 行"。
 *
 * 声明（必须如实，不得被引用为端到端证据）：
 *   这里的消息行、台账行与数据库连接都是**合成输入**（记录型假池，非真 PG / 非 PGlite）。
 *   本文件证明的是"原语按什么 SQL、什么事务边界、什么计数口径执行"，**不是**"真库上注销已闭环"：
 *   真实库上的行为、权限是否足够、行数是否与线上一致，本文件一概不涉及。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createPostgresMessagesStore } from '../../services/api/src/messages/store-pg.ts';
import { USER_A, USER_B } from './messages-fixtures.mjs';

const OWNER = USER_A.userId;
const OTHER = USER_B.userId;
/** 幂等键哈希：形状只要求是字符串，这里用两个可区分的长串。 */
const KEY_HASH = 'a'.repeat(64);

/** 与 `auth/idempotency.ts:129-131` 的 `idempotencyScope` 逐字同形：`<主体>\n<METHOD>\n<路径>`。 */
function scopeFor(subject, method, path) {
  return `${subject}\n${method}\n${path}`;
}

function flat(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

function record(overrides = {}) {
  return {
    id: '00000000-0000-4000-8100-000000000001',
    revision: 1,
    owner_id: OWNER,
    type: 'comment',
    target_ref: null,
    read_at: null,
    created_at: '2026-10-21T03:00:00.000Z',
    event_key: 'evt-1',
    ...overrides,
  };
}

/** 记录型假池：`respond(sql, values)` 决定每次事务内查询返回的行，抛错即模拟数据库拒绝。 */
function fakeTransactionalPool(respond) {
  const calls = [];
  const connection = {
    async query(text, values) {
      const sql = flat(text);
      calls.push({ sql, values });
      return { rows: respond(sql, values) ?? [] };
    },
    release() {
      calls.push({ sql: 'RELEASE', values: undefined });
    },
  };
  return {
    calls,
    async query(text, values) {
      // 事务外的查询：注销清理不该走到这里，记下来以便断言"没有绕过事务"。
      calls.push({ sql: `OUTSIDE-TX ${flat(text)}`, values });
      return { rows: [] };
    },
    async connect() {
      return connection;
    },
  };
}

const deletesOf = (calls) => calls.filter((call) => call.sql.startsWith('DELETE FROM'));

// ---------------------------------------------------------------------------
// 内存实现
// ---------------------------------------------------------------------------

test('内存实现 · 清掉本人全部消息与台账行，他人一行不动，两个行数取真实删除数', async () => {
  const store = createMemoryMessagesStore();
  await store.insertMessage(record({ id: 'm1' }));
  await store.insertMessage(record({ id: 'm2', event_key: 'evt-2' }));
  await store.insertMessage(record({ id: 'm3', event_key: 'evt-3' }));
  await store.insertMessage(record({ id: 'other-1', owner_id: OTHER, event_key: 'evt-other-1' }));
  // 一条**已读**行：清理不看读状态，已读与未读一并删。
  await store.markReadIfUnread('m2', { revision: 1, owner_id: OWNER }, '2026-10-21T04:00:00.000Z');

  const ownA = scopeFor(OWNER, 'POST', '/messages');
  const ownB = scopeFor(OWNER, 'PUT', '/messages/m1/read');
  const otherScope = scopeFor(OTHER, 'POST', '/messages');
  // 诱饵：首段只比本体 uuid 多一个字符，**不是**同一主体（证明按换行边界精确匹配，而非裸前缀）。
  const decoyScope = `${OWNER}0\nPOST\n/messages`;
  const claim = { request_hash: 'h', response_status: 201, expires_at: Date.now() + 60_000 };
  await store.claimIdempotency(ownA, KEY_HASH, claim);
  await store.completeIdempotency(ownA, KEY_HASH, {
    response_status: 201,
    outcome: { kind: 'message', id: 'm1', revision: 1 },
  });
  await store.claimIdempotency(ownB, KEY_HASH, claim);
  await store.claimIdempotency(otherScope, KEY_HASH, claim);
  await store.completeIdempotency(otherScope, KEY_HASH, {
    response_status: 201,
    outcome: { kind: 'message', id: 'other-1', revision: 1 },
  });
  await store.claimIdempotency(decoyScope, KEY_HASH, claim);
  await store.completeIdempotency(decoyScope, KEY_HASH, {
    response_status: 201,
    outcome: { kind: 'message', id: 'm1', revision: 1 },
  });

  // 3 条本人消息里 m2 已读 ⇒ 清理前未读 2 条（清理后必须归零）。
  assert.equal(await store.countUnread(OWNER), 2);

  const counts = await store.purgeOwnerData(OWNER);
  assert.deepEqual(counts, { records: 3, idempotency: 2 });

  // 正文：本人行消失（含已读行），他人的行原样在。
  assert.deepEqual(await store.listMessagesByOwner(OWNER), []);
  assert.equal(await store.getMessage('m1'), null);
  assert.equal(await store.getMessage('m2'), null);
  assert.equal(await store.countUnread(OWNER), 0);
  assert.equal((await store.listMessagesByOwner(OTHER)).length, 1);
  assert.equal((await store.getMessage('other-1')).owner_id, OTHER);

  // 台账：本人两行消失，他人行与"前缀相似"的诱饵行都还在。
  assert.equal(await store.findIdempotency(ownA, KEY_HASH), null);
  assert.equal(await store.findIdempotency(ownB, KEY_HASH), null);
  assert.notEqual(await store.findIdempotency(otherScope, KEY_HASH), null);
  assert.notEqual(await store.findIdempotency(decoyScope, KEY_HASH), null);
  // 本人的占位行是**真的没了**：同一 (scope, key_hash) 可以重新占位（否则会永远 replay 到已删消息）。
  assert.equal(await store.claimIdempotency(ownA, KEY_HASH, claim), true);
  assert.equal(await store.claimIdempotency(ownB, KEY_HASH, claim), true);

  // 事件去重索引没有留下悬空条目：同一 `event_key` 可以重新写入为**新**消息。
  assert.equal(await store.findByEventKey(OWNER, 'evt-1'), null);
  assert.equal(await store.insertMessage(record({ id: 'm4', event_key: 'evt-1' })), 'inserted');
});

test('内存实现 · 幂等可重跑：第二次返回 0/0，不重复计数', async () => {
  const store = createMemoryMessagesStore();
  await store.insertMessage(record({ id: 'm1' }));
  await store.claimIdempotency(scopeFor(OWNER, 'POST', '/messages'), KEY_HASH, {
    request_hash: 'h',
    response_status: 201,
    expires_at: Date.now() + 60_000,
  });

  assert.deepEqual(await store.purgeOwnerData(OWNER), { records: 1, idempotency: 1 });
  assert.deepEqual(await store.purgeOwnerData(OWNER), { records: 0, idempotency: 0 });
  assert.equal(await store.deleteAllByOwner(OWNER), 0);
});

test('内存实现 · deleteAllByOwner 返回的正文行数与 purgeOwnerData 的 records 一致', async () => {
  const store = createMemoryMessagesStore();
  await store.insertMessage(record({ id: 'm1' }));
  await store.insertMessage(record({ id: 'm2', event_key: 'evt-2' }));
  assert.equal(await store.deleteAllByOwner(OWNER), 2);
  assert.deepEqual(await store.purgeOwnerData(OWNER), { records: 0, idempotency: 0 });
});

// ---------------------------------------------------------------------------
// PG 实现
// ---------------------------------------------------------------------------

test('PG 实现 · 两条 DELETE 在同一事务内按主体执行，行数取自 RETURNING，值只有本主体', async () => {
  const pool = fakeTransactionalPool((sql) => {
    if (sql.startsWith('DELETE FROM public.messages')) return [{ id: 'm1' }, { id: 'm2' }];
    if (sql.startsWith('DELETE FROM public.idempotency_keys')) {
      return [{ scope: scopeFor(OWNER, 'POST', '/messages') }];
    }
    return [];
  });
  const store = createPostgresMessagesStore({ pool });

  const counts = await store.purgeOwnerData(OWNER);
  assert.deepEqual(counts, { records: 2, idempotency: 1 });

  const sqls = pool.calls.map((call) => call.sql);
  assert.equal(sqls[0], 'BEGIN');
  assert.equal(sqls[1], "SET LOCAL lock_timeout = '4s'");
  assert.equal(sqls.at(-2), 'COMMIT');
  assert.equal(sqls.at(-1), 'RELEASE');
  assert.equal(sqls.filter((sql) => sql === 'BEGIN').length, 1);
  assert.equal(sqls.filter((sql) => sql === 'COMMIT').length, 1);
  assert.equal(sqls.filter((sql) => sql === 'RELEASE').length, 1);
  // 没有绕过事务：所有语句都在事务连接上执行。
  assert.equal(sqls.filter((sql) => sql.startsWith('OUTSIDE-TX')).length, 0);
  assert.equal(sqls.filter((sql) => sql === 'ROLLBACK').length, 0);

  const deletes = deletesOf(pool.calls);
  assert.equal(deletes.length, 2, '必须是两条 DELETE，不多不少');
  assert.equal(
    deletes[0].sql,
    'DELETE FROM public.messages WHERE owner_id = $1::uuid RETURNING id',
  );
  assert.equal(
    deletes[1].sql,
    'DELETE FROM public.idempotency_keys WHERE left(scope, char_length($1::text) + 1) = '
      + '$1::text || chr(10) RETURNING scope',
  );
  // ⛔ 不用 LIKE：`_`/`%` 会被当通配符解释，语义就不再是"首段逐字符相等"。
  for (const call of deletes) {
    assert.equal(/LIKE/i.test(call.sql), false, `不应出现 LIKE：${call.sql}`);
    assert.deepEqual(call.values, [OWNER], '谓词值只有本主体，绝不出现第二个主体');
  }
});

test('PG 实现 · deleteAllByOwner 复用同一事务与同一行数口径', async () => {
  const pool = fakeTransactionalPool((sql) => {
    if (sql.startsWith('DELETE FROM public.messages')) return [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];
    return [];
  });
  const store = createPostgresMessagesStore({ pool });
  assert.equal(await store.deleteAllByOwner(OWNER), 3);
  // 台账那条 DELETE 也执行了（同一事务），只是没有行可删。
  assert.equal(deletesOf(pool.calls).length, 2);
});

test('PG 实现 · 幂等可重跑：已删过的主体再跑返回 0/0（不会重复计入证据）', async () => {
  const pool = fakeTransactionalPool(() => []);
  const store = createPostgresMessagesStore({ pool });
  assert.deepEqual(await store.purgeOwnerData(OWNER), { records: 0, idempotency: 0 });
  assert.deepEqual(await store.purgeOwnerData(OWNER), { records: 0, idempotency: 0 });
});

test('PG 实现 · 池没有事务连接 ⇒ 如实 PROVIDER_UNAVAILABLE(不可重试)，且一条 DELETE 都不发', async () => {
  const calls = [];
  const store = createPostgresMessagesStore({
    pool: {
      async query(text, values) {
        calls.push({ sql: flat(text), values });
        return { rows: [] };
      },
    },
  });

  for (const method of ['purgeOwnerData', 'deleteAllByOwner']) {
    await assert.rejects(store[method](OWNER), (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      // 缺事务连接是**装配/能力**问题，重试不会好。
      assert.equal(error.retryable, false);
      return true;
    });
  }
  assert.deepEqual(calls, [], '拿不到事务连接时不得发出任何语句（更不得退回两条独立 DELETE）');
});

test('PG 实现 · 删除失败 ⇒ ROLLBACK、不 COMMIT、仍 release，原始异常分类不被覆盖', async () => {
  const pool = fakeTransactionalPool((sql) => {
    if (sql.startsWith('DELETE FROM public.idempotency_keys')) {
      // 权限不足：真实角色缺 DELETE 时的典型形态。
      throw Object.assign(new Error('permission denied for table idempotency_keys'), { code: '42501' });
    }
    return [];
  });
  const store = createPostgresMessagesStore({ pool });

  await assert.rejects(store.purgeOwnerData(OWNER), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.retryable, false);
    return true;
  });

  const sqls = pool.calls.map((call) => call.sql);
  assert.equal(sqls.includes('ROLLBACK'), true);
  assert.equal(sqls.includes('COMMIT'), false, '回滚之后绝不能提交');
  assert.equal(sqls.filter((sql) => sql === 'RELEASE').length, 1);
});

test('PG 实现 · 语句超时 57014 ⇒ PROVIDER_TIMEOUT(可重试)，同样回滚并释放连接', async () => {
  const pool = fakeTransactionalPool((sql) => {
    if (sql.startsWith('DELETE FROM public.messages')) {
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    }
    return [];
  });
  const store = createPostgresMessagesStore({ pool });

  await assert.rejects(store.purgeOwnerData(OWNER), (error) => {
    assert.equal(error.code, 'PROVIDER_TIMEOUT');
    assert.equal(error.retryable, true);
    return true;
  });

  const sqls = pool.calls.map((call) => call.sql);
  assert.equal(sqls.includes('ROLLBACK'), true);
  assert.equal(sqls.includes('COMMIT'), false);
  // 第一条 DELETE 就失败 ⇒ 台账那条不该被发出去（同生共死）。
  assert.equal(deletesOf(pool.calls).length, 1);
  assert.equal(sqls.filter((sql) => sql === 'RELEASE').length, 1);
});

test('PG 实现 · 事务连接取失败（connect 抛错）⇒ 折叠为契约错误且不释放未取得的连接', async () => {
  const calls = [];
  const store = createPostgresMessagesStore({
    pool: {
      async query(text, values) {
        calls.push({ sql: flat(text), values });
        return { rows: [] };
      },
      async connect() {
        throw Object.assign(new Error('pool exhausted'), { code: '08006' });
      },
    },
  });

  await assert.rejects(store.purgeOwnerData(OWNER), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.deepEqual(calls, []);
});
