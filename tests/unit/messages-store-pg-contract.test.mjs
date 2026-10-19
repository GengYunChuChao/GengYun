/**
 * GY-I17（#17）· 消息域 PostgreSQL store 的语句形状契约（不连真库）。
 *
 * 这里不读源码文本猜实现，而是**记录型假池**逐条抓 `(text, values)`，用语句形状反证派单的
 * 三条硬约束：
 *   1. `insertMessage` 的重复判定必须由数据库唯一约束给出 —— 冲突路径上只能有**一条**
 *      `INSERT ... ON CONFLICT DO NOTHING ... RETURNING`，⛔ 不许先 SELECT 再 INSERT；
 *   2. `markReadIfUnread` 必须是**单条** `UPDATE ... WHERE ... read_at IS NULL RETURNING` ——
 *      转换成功路径上总共只能发出**一条**语句（没有"先查后更新"，也没有显式行锁）；
 *   3. `countUnread` 必须是派生 `count(*)` —— 没有任何计数器列的读改写。
 * 另加红线：除"按 id 取单条"（接口无 owner 形参，归属判定在服务层）与幂等台账（scope 已编码主体）
 * 之外，每条语句都必须带 `owner_id` 谓词。
 *
 * 真库行为（唯一约束、并发收敛、分页游标）见 `tests/integration/messages-pg.mjs`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMessagesDatabaseError,
  createPostgresMessagesStore,
  messageRecordFromRow,
} from '../../services/api/src/messages/store-pg.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const CREATED_AT = '2026-10-18T02:00:00.000Z';
const READ_AT = '2026-10-18T03:00:00.000Z';
const EVENT_KEY = 'like:post-1';
const KEY_HASH = 'ab'.repeat(32);
const SCOPE = `${OWNER}\nPUT\n/messages/${MESSAGE_ID}/read`;

/** 与 `pg` 返回同形的行（timestamptz 给 Date，jsonb 给对象），用来覆盖取数转换。 */
const row = (overrides = {}) => ({
  id: MESSAGE_ID,
  revision: 1,
  owner_id: OWNER,
  type: 'like',
  target_ref: { type: 'post', id: 'post-1', revision: 2 },
  read_at: null,
  created_at: new Date(CREATED_AT),
  event_key: EVENT_KEY,
  ...overrides,
});

const record = (overrides = {}) => ({
  id: MESSAGE_ID,
  revision: 1,
  owner_id: OWNER,
  type: 'like',
  target_ref: { type: 'post', id: 'post-1', revision: 2 },
  read_at: null,
  created_at: CREATED_AT,
  event_key: EVENT_KEY,
  ...overrides,
});

/**
 * 记录型假池：`script[i]` 是第 i 次查询的回答（行数组 / 函数 / Error）。
 * 脚本用尽即抛 ⇒ 任何"内部多查了一次"的实现都会在这里立刻炸出来。
 */
function fakePool(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      const step = script[index];
      index += 1;
      if (step === undefined) {
        throw new Error(`假池脚本已用尽（第 ${index} 次查询）：${text.replace(/\s+/g, ' ').trim()}`);
      }
      const response = typeof step === 'function' ? step({ text, values }) : step;
      if (response instanceof Error) throw response;
      return { rows: response };
    },
  };
}

/** 只用于形状断言：抹平缩进换行，避免断言被排版牵着走。 */
const flat = (text) => text.replace(/\s+/g, ' ').trim();
const statements = (pool) => pool.calls.map((call) => flat(call.text));

test('store 声明自己是持久化实现（app.ts 依赖此标志，real 下不得回落到内存语义）', () => {
  const store = createPostgresMessagesStore({ pool: fakePool([]) });
  assert.equal(store.persistent, true);
});

test('insertMessage：首次写入只发一条 INSERT ... ON CONFLICT DO NOTHING RETURNING，返回 inserted', async () => {
  const pool = fakePool([[{ id: MESSAGE_ID }]]);
  const store = createPostgresMessagesStore({ pool });

  const result = await store.insertMessage(record());

  assert.equal(result, 'inserted');
  assert.equal(pool.calls.length, 1, '插入路径只允许一条语句');
  const sql = flat(pool.calls[0].text);
  assert.equal(sql.startsWith('INSERT INTO public.messages'), true);
  assert.equal(sql.includes('ON CONFLICT DO NOTHING RETURNING id'), true, '重复判定必须交给唯一约束');
  assert.equal(/select/i.test(sql), false, '写入前不许先查');
  const values = pool.calls[0].values;
  assert.equal(values.length, 8);
  assert.equal(values[0], MESSAGE_ID);
  assert.equal(values[1], OWNER);
  assert.equal(values[4], null, '未读必须写 NULL，而不是占位时刻');
  assert.equal(values[7], EVENT_KEY);
  assert.equal(values[3], JSON.stringify(record().target_ref), 'jsonb 列按文本传，保证形状不被驱动改写');
});

test('insertMessage：同 id 或同 (owner_id,event_key) 冲突（0 行）⇒ duplicate，且仍然只有一条语句', async () => {
  const pool = fakePool([[], []]);
  const store = createPostgresMessagesStore({ pool });

  assert.equal(await store.insertMessage(record()), 'duplicate');
  assert.equal(await store.insertMessage(record({ id: OTHER_MESSAGE_ID })), 'duplicate');

  assert.equal(pool.calls.length, 2, '每次冲突判定都只有一条 INSERT，不存在"先查后写"');
  for (const sql of statements(pool)) {
    assert.equal(sql.startsWith('INSERT INTO public.messages'), true);
    assert.equal(sql.includes('ON CONFLICT DO NOTHING'), true);
  }
  assert.equal(pool.calls[1].values[1], OWNER, '唯一约束键必须落在 (owner_id, event_key) 上');
  assert.equal(pool.calls[1].values[7], EVENT_KEY);
});

test('markReadIfUnread：转换成功路径总共只有一条 UPDATE，且 WHERE 内含 read_at IS NULL 与 owner 谓词', async () => {
  const pool = fakePool([[row({ revision: 2, read_at: new Date(READ_AT) })]]);
  const store = createPostgresMessagesStore({ pool });

  const result = await store.markReadIfUnread(MESSAGE_ID, { revision: 1, owner_id: OWNER }, READ_AT);

  assert.equal(result.ok, true);
  assert.equal(result.transitioned, true);
  assert.equal(result.record.revision, 2, '首次转换推进一版');
  assert.equal(result.record.read_at, READ_AT, '出口时刻与 SQL 比较基准同精度（毫秒 ISO）');

  assert.equal(pool.calls.length, 1, '「单条 UPDATE」的直接证据：没有先查、没有事后回读');
  const sql = flat(pool.calls[0].text);
  assert.equal(sql.startsWith('UPDATE public.messages'), true);
  assert.equal(sql.includes('SET read_at = $3::timestamptz, revision = revision + 1'), true);
  assert.equal(sql.includes('AND read_at IS NULL'), true, '未读条件是 CAS 的一部分，不是应用层判断');
  assert.equal(sql.includes('owner_id = $2::uuid'), true, '他人消息不得被这次 UPDATE 命中');
  assert.equal(sql.includes('RETURNING'), true, 'CAS 判定只能靠 RETURNING（SqlRunner 没有 rowCount）');
  assert.equal(/for update/i.test(sql), false, '不靠显式行锁，靠 UPDATE ... IS NULL 的原子性');
  assert.deepEqual(pool.calls[0].values, [MESSAGE_ID, OWNER, READ_AT]);
});

test('markReadIfUnread：已读（UPDATE 0 行）⇒ 空操作，revision 与 read_at 都不动', async () => {
  const pool = fakePool([[], [row({ revision: 2, read_at: new Date(READ_AT) })]]);
  const store = createPostgresMessagesStore({ pool });

  const result = await store.markReadIfUnread(MESSAGE_ID, { revision: 2, owner_id: OWNER }, READ_AT);

  assert.equal(result.ok, true);
  assert.equal(result.transitioned, false);
  assert.equal(result.record.revision, 2);
  assert.equal(result.record.read_at, READ_AT);
  assert.equal(pool.calls.length, 2, '只有 0 行返回时才允许补一次读，用来区分「已读」与「不存在/非本人」');
  assert.equal(statements(pool)[1].startsWith('SELECT'), true);
  assert.equal(statements(pool)[1].includes('WHERE id = $1::uuid'), true);
});

test('markReadIfUnread：不存在 ⇒ NOT_FOUND；他人消息 ⇒ OWNER_CHANGED（上层折叠为同一个 404）', async () => {
  const missing = createPostgresMessagesStore({ pool: fakePool([[], []]) });
  assert.deepEqual(
    await missing.markReadIfUnread(MESSAGE_ID, { revision: 1, owner_id: OWNER }, READ_AT),
    { ok: false, reason: 'NOT_FOUND' },
  );

  const foreign = createPostgresMessagesStore({ pool: fakePool([[], [row({ owner_id: OTHER })]]) });
  assert.deepEqual(
    await foreign.markReadIfUnread(MESSAGE_ID, { revision: 1, owner_id: OWNER }, READ_AT),
    { ok: false, reason: 'OWNER_CHANGED' },
  );
});

test('markReadIfUnread：仍是未读但版本已变 ⇒ REVISION_CHANGED（不静默推进别人的 If-Match）', async () => {
  const pool = fakePool([[], [row({ revision: 5 })]]);
  const store = createPostgresMessagesStore({ pool });

  const result = await store.markReadIfUnread(MESSAGE_ID, { revision: 1, owner_id: OWNER }, READ_AT);

  assert.deepEqual(result, { ok: false, reason: 'REVISION_CHANGED' });
  assert.equal(pool.calls.length, 2, 'UPDATE 空转一次 + 回读一次，然后如实返回冲突');
});

test('markReadIfUnread：判定顺序对齐内存实现（版本不符先于「已读空操作」）', async () => {
  const pool = fakePool([[], [row({ revision: 2, read_at: new Date(READ_AT) })]]);
  const store = createPostgresMessagesStore({ pool });

  const result = await store.markReadIfUnread(MESSAGE_ID, { revision: 1, owner_id: OWNER }, READ_AT);

  assert.deepEqual(result, { ok: false, reason: 'REVISION_CHANGED' }, '与 store.ts:167-170 同序：已读不是万能放行');
});

test('countUnread：每次现算 count(*)，没有计数器列也没有写回', async () => {
  const pool = fakePool([[{ count: '3' }]]);
  const store = createPostgresMessagesStore({ pool });

  assert.equal(await store.countUnread(OWNER), 3);

  assert.equal(pool.calls.length, 1);
  const sql = flat(pool.calls[0].text);
  assert.equal(sql.includes('count(*)'), true);
  assert.equal(sql.includes('WHERE owner_id = $1::uuid AND read_at IS NULL'), true);
  assert.equal(/update|insert|delete/i.test(sql), false, '未读数不是可写状态');
  assert.deepEqual(pool.calls[0].values, [OWNER]);
});

test('listMessagesByOwner：owner 谓词 + (created_at DESC, id DESC) 稳定排序，顺序即 SQL 顺序', async () => {
  const pool = fakePool([[
    row({ id: MESSAGE_ID, created_at: new Date('2026-10-18T02:00:00.000Z') }),
    row({ id: OTHER_MESSAGE_ID, created_at: new Date('2026-10-18T01:00:00.000Z'), event_key: 'like:post-2' }),
  ]]);
  const store = createPostgresMessagesStore({ pool });

  const items = await store.listMessagesByOwner(OWNER);

  assert.deepEqual(items.map((item) => item.id), [MESSAGE_ID, OTHER_MESSAGE_ID]);
  assert.equal(items[0].created_at, '2026-10-18T02:00:00.000Z');
  const sql = flat(pool.calls[0].text);
  assert.equal(sql.includes('WHERE owner_id = $1::uuid'), true);
  assert.equal(sql.includes('ORDER BY created_at DESC, id DESC'), true, '与 compareMessagesDescending 同一排序口径');
  assert.deepEqual(pool.calls[0].values, [OWNER]);
});

test('findByEventKey：去重查询锁在 (owner_id, event_key) 上，取最新一条', async () => {
  const pool = fakePool([[row()]]);
  const store = createPostgresMessagesStore({ pool });

  const found = await store.findByEventKey(OWNER, EVENT_KEY);

  assert.equal(found.id, MESSAGE_ID);
  const sql = flat(pool.calls[0].text);
  assert.equal(sql.includes('WHERE owner_id = $1::uuid AND event_key = $2'), true);
  assert.equal(sql.includes('ORDER BY created_at DESC, id DESC LIMIT 1'), true);
  assert.deepEqual(pool.calls[0].values, [OWNER, EVENT_KEY]);

  const empty = createPostgresMessagesStore({ pool: fakePool([[]]) });
  assert.equal(await empty.findByEventKey(OWNER, EVENT_KEY), null);
});

test('幂等台账：复用 0008 的 public.idempotency_keys，不新建第二张表', async () => {
  const pool = fakePool([
    [], // 清过期占位
    [{ id: 'idem-1' }], // 占位
    [{ id: 'idem-1' }], // 完成
    [], // 释放
  ]);
  const store = createPostgresMessagesStore({ pool });

  assert.equal(
    await store.claimIdempotency(SCOPE, KEY_HASH, {
      request_hash: 'f'.repeat(64),
      response_status: 200,
      expires_at: 1760000000000,
    }),
    true,
  );
  assert.equal(
    await store.completeIdempotency(SCOPE, KEY_HASH, { response_status: 200, outcome: { kind: 'message', id: MESSAGE_ID, revision: 2 } }),
    true,
  );
  await store.releaseIdempotency(SCOPE, KEY_HASH);

  const sql = statements(pool);
  assert.equal(sql.length, 4);
  assert.equal(sql[0].startsWith('DELETE FROM public.idempotency_keys'), true);
  assert.equal(sql[0].includes('expires_at <= now()'), true, '过期占位先清掉，才能重新占位');
  assert.equal(sql[1].startsWith('INSERT INTO public.idempotency_keys'), true);
  assert.equal(sql[1].includes('ON CONFLICT (scope, key_hash) DO NOTHING RETURNING id'), true);
  assert.equal(sql[2].startsWith('UPDATE public.idempotency_keys'), true);
  assert.equal(sql[2].includes('AND outcome IS NULL RETURNING id'), true, '完成只对占位中的行生效');
  assert.equal(sql[3].includes('AND outcome IS NULL'), true, '释放不许抹掉已完成的结果');
  for (const statement of sql) {
    assert.equal(statement.includes('message_idempotency'), false, '不得另立台账表');
  }
});

test('幂等台账：到期即视为不存在；未完成的占位不回放结果', async () => {
  const expired = createPostgresMessagesStore({ pool: fakePool([[]]) });
  assert.equal(await expired.findIdempotency(SCOPE, KEY_HASH), null);

  const pending = createPostgresMessagesStore({ pool: fakePool([[{
    request_hash: 'f'.repeat(64),
    response_status: 200,
    outcome: null,
    expires_at_ms: '1760000000000',
  }]]) });
  assert.equal(await pending.findIdempotency(SCOPE, KEY_HASH), null);

  const settled = createPostgresMessagesStore({ pool: fakePool([[{
    request_hash: 'f'.repeat(64),
    response_status: 200,
    outcome: { kind: 'message', id: MESSAGE_ID, revision: 2 },
    expires_at_ms: '1760000000000',
  }]]) });
  const found = await settled.findIdempotency(SCOPE, KEY_HASH);
  assert.equal(found.expires_at, 1760000000000);
  assert.equal(found.outcome.revision, 2);
});

test('红线：除按 id 取单条与幂等台账外，每条语句都带 owner 谓词', async () => {
  const pool = fakePool([
    [{ id: MESSAGE_ID }], // insert
    [row()], // list
    [row()], // findByEventKey
    [row({ revision: 2, read_at: new Date(READ_AT) })], // markRead
    [{ count: '1' }], // countUnread
  ]);
  const store = createPostgresMessagesStore({ pool });

  await store.insertMessage(record());
  await store.listMessagesByOwner(OWNER);
  await store.findByEventKey(OWNER, EVENT_KEY);
  await store.markReadIfUnread(MESSAGE_ID, { revision: 1, owner_id: OWNER }, READ_AT);
  await store.countUnread(OWNER);

  for (const sql of statements(pool)) {
    assert.equal(sql.includes('owner_id'), true, `语句缺少 owner 谓词：${sql}`);
  }
});

test('异常折叠：57014/55P03 ⇒ PROVIDER_TIMEOUT（可重试）；其余 ⇒ PROVIDER_UNAVAILABLE（不可重试）', async () => {
  for (const code of ['57014', '55P03']) {
    const store = createPostgresMessagesStore({
      pool: { query: async () => { throw Object.assign(new Error('timeout'), { code }); } },
    });
    await assert.rejects(store.countUnread(OWNER), (error) => {
      assert.equal(error.code, 'PROVIDER_TIMEOUT');
      assert.equal(error.retryable, true);
      return true;
    });
  }

  const store = createPostgresMessagesStore({
    pool: { query: async () => { throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }); } },
  });
  await assert.rejects(store.listMessagesByOwner(OWNER), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.retryable, true);
    return true;
  });

  assert.throws(() => classifyMessagesDatabaseError(new Error('boom')), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    return true;
  });
});

test('取数：闭集类型外的行按内部不变式违反处理，不静默降级成合法消息', () => {
  assert.throws(() => messageRecordFromRow(row({ type: 'promo' })), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.throws(() => messageRecordFromRow(row({ target_ref: { type: 'post' } })), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    return true;
  });
  const parsed = messageRecordFromRow(row({ target_ref: '{"type":"post","id":"post-1","revision":2}' }));
  assert.deepEqual(parsed.target_ref, { type: 'post', id: 'post-1', revision: 2 });
  assert.equal(parsed.read_at, null);
});
