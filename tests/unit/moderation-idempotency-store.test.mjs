/**
 * GY-R72 W41 · 审核域**持久幂等台账**的存储层判据（内存语义 + PG 形制 + 缺表 fail-closed）。
 *
 * 本文件锁三件事，一件都不能少：
 *  A. **内存实现的六条语义**（M1–M6，与 `services/api/src/moderation/idempotency-store.ts` 的
 *     `createMemoryModerationIdempotencyStore` 逐条对照）：claim 的首次/重放/异体三态、finalize
 *     落定、release 后可重 claim、过期行的清理与就地重占；
 *  B. **PG 语句形状**：五条 SQL 的六列清单与 `ON CONFLICT … DO UPDATE … WHERE
 *     public.moderation_idempotency.expires_at <= $7 RETURNING scope` —— 少了那个 `WHERE`，
 *     任何一次 claim 都会覆盖既有行（同键同体的重放变成「覆盖 + 再执行一次副作用」）；
 *  C. **缺表 fail-closed**（记录型假池，不连库）：确认未迁移 ⇒ 读类 `null` / 写类抛
 *     {@link ModerationIdempotencyTablesMissingError}（点名 `0051`、`retryable:false`）；
 *     ⛔ 绝不静默丢写、⛔ 绝不退化成内存 store；探测本身失败 ⇒ **抛**（⛔ 不得当成 `missing` 放行读）。
 *
 * ⚠ 本片**不接线**：`service.ts` / `app.ts` 没有改动，所以这里没有一条端到端 HTTP 断言 ——
 * 「取消端点真的回放」是 W42 的读数，⛔ 不在此处假装。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '../../services/api/src/errors.ts';
import {
  MODERATION_IDEMPOTENCY_SQL,
  ModerationIdempotencyTablesMissingError,
  classifyModerationIdempotencyDatabaseError,
  createMemoryModerationIdempotencyStore,
  createPgModerationIdempotencyStore,
} from '../../services/api/src/moderation/idempotency-store.ts';

const SCOPE = 'user:11111111-1111-4111-8111-111111111111\nPOST\n/moderation/jobs/42/cancel';
const KEY = 'a3f1c0d9b7e54628a3f1c0d9b7e54628a3f1c0d9b7e54628a3f1c0d9b7e54628';
const T0 = new Date('2026-11-01T04:00:00.000Z');
const EXPIRES = new Date('2026-11-01T05:00:00.000Z');

function row(overrides = {}) {
  return {
    scope: SCOPE,
    keyHash: KEY,
    requestHash: 'req-hash-1',
    payload: { job_id: '11111111-1111-4111-8111-111111111111', state: 'cancelled' },
    pending: true,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. 内存实现（M1–M6）
// ---------------------------------------------------------------------------

test('[M1] claim 首次 ⇒ claimed，并留下 pending=true 的行', async () => {
  const store = createMemoryModerationIdempotencyStore();

  assert.equal(await store.claimIdempotent(SCOPE, KEY, row(), T0), 'claimed');

  const found = await store.findIdempotent(SCOPE, KEY);
  assert.notEqual(found, null);
  assert.equal(found.pending, true);
  assert.equal(found.requestHash, 'req-hash-1');
  assert.deepEqual(found.payload, { job_id: '11111111-1111-4111-8111-111111111111', state: 'cancelled' });
  assert.equal(found.expiresAt.getTime(), EXPIRES.getTime());
});

test('[M2] 同 key 同体且未过期 ⇒ exists，且库里的 payload 一个字节都没被覆盖', async () => {
  const store = createMemoryModerationIdempotencyStore();
  await store.claimIdempotent(SCOPE, KEY, row(), T0);

  // 第二次请求：同 requestHash、但带着**不同的** payload（调用方不该这么传；传了也不许覆盖）。
  const again = await store.claimIdempotent(
    SCOPE,
    KEY,
    row({ payload: { poisoned: true }, pending: false, expiresAt: new Date('2026-11-02T00:00:00.000Z') }),
    new Date(T0.getTime() + 1_000),
  );
  assert.equal(again, 'exists');

  const found = await store.findIdempotent(SCOPE, KEY);
  assert.deepEqual(found.payload, {
    job_id: '11111111-1111-4111-8111-111111111111',
    state: 'cancelled',
  });
  assert.equal(found.pending, true, 'exists 分支不得顺手把 pending 改掉');
  assert.equal(found.expiresAt.getTime(), EXPIRES.getTime(), 'exists 分支不得续期');
});

test('[M3] 同 key 不同 requestHash ⇒ exists，并原样交回库里那行的 requestHash（409 由调用方判）', async () => {
  const store = createMemoryModerationIdempotencyStore();
  await store.claimIdempotent(SCOPE, KEY, row(), T0);

  const again = await store.claimIdempotent(
    SCOPE,
    KEY,
    row({ requestHash: 'req-hash-2' }),
    new Date(T0.getTime() + 5_000),
  );
  assert.equal(again, 'exists', 'store 不判 409 —— 它只回答"没抢到"');

  const found = await store.findIdempotent(SCOPE, KEY);
  assert.equal(found.requestHash, 'req-hash-1', '必须交回库里那行的 requestHash，供调用方与 req-hash-2 比对');
  assert.equal(found.requestHash === 'req-hash-2', false, 'store 不得把新请求的 requestHash 写进去');
});

test('[M4] finalize ⇒ pending=false 且 payload 换成落定结果', async () => {
  const store = createMemoryModerationIdempotencyStore();
  await store.claimIdempotent(SCOPE, KEY, row(), T0);

  await store.finalizeIdempotent(SCOPE, KEY, {
    job_id: '11111111-1111-4111-8111-111111111111',
    state: 'cancelled',
    revision: 7,
  });

  const found = await store.findIdempotent(SCOPE, KEY);
  assert.equal(found.pending, false);
  assert.deepEqual(found.payload, {
    job_id: '11111111-1111-4111-8111-111111111111',
    state: 'cancelled',
    revision: 7,
  });
});

test('[M5] release ⇒ 同 key 可以重新 claim（占位不留死锁）', async () => {
  const store = createMemoryModerationIdempotencyStore();
  await store.claimIdempotent(SCOPE, KEY, row(), T0);
  assert.equal(await store.claimIdempotent(SCOPE, KEY, row(), T0), 'exists');

  await store.releaseIdempotent(SCOPE, KEY);
  assert.equal(await store.findIdempotent(SCOPE, KEY), null, 'release 是整行删（不是把 pending 置 false）');

  assert.equal(
    await store.claimIdempotent(SCOPE, KEY, row({ requestHash: 'req-hash-retry' }), T0),
    'claimed',
    '释放之后同一个键必须能重新抢 —— 否则失败首请求会把该键永久占死',
  );
  assert.equal((await store.findIdempotent(SCOPE, KEY)).requestHash, 'req-hash-retry');
});

test('[M6] 过期行被 purgeIdempotent 物理删除，且 claim 可就地重占（不需要先 purge）', async () => {
  const store = createMemoryModerationIdempotencyStore();

  // 一条已过期、一条未过期：purge 只能删前者。
  await store.claimIdempotent(SCOPE, KEY, row({ expiresAt: new Date('2026-10-31T00:00:00.000Z') }), T0);
  await store.claimIdempotent(
    'user:22222222-2222-4222-8222-222222222222\nPOST\n/moderation/jobs/43/cancel',
    'other-key',
    row({ scope: 'user:22222222-2222-4222-8222-222222222222\nPOST\n/moderation/jobs/43/cancel', keyHash: 'other-key' }),
    T0,
  );

  assert.equal(await store.purgeIdempotent(T0), 1, 'purge 只删 expires_at <= now 的行');
  assert.equal(await store.findIdempotent(SCOPE, KEY), null, 'purge 是物理删除，不是标记');

  // 就地重占的另一种来路：过期行还在（没跑 purge）时，claim 也必须抢到它。
  await store.claimIdempotent(SCOPE, 'expired-key', row({ expiresAt: new Date('2026-10-30T00:00:00.000Z') }), T0);
  assert.equal(
    await store.claimIdempotent(SCOPE, 'expired-key', row({ requestHash: 'req-hash-reclaim' }), T0),
    'claimed',
    '过期行必须能被就地重占（不先删再插：那会让并发同键请求都判定"不存在"）',
  );
  assert.equal((await store.findIdempotent(SCOPE, 'expired-key')).requestHash, 'req-hash-reclaim');
});

test('[M6 补充] findIdempotent 不按过期过滤（过期判定只在 claim，读面如实交回）', async () => {
  const store = createMemoryModerationIdempotencyStore();
  await store.claimIdempotent(SCOPE, KEY, row({ expiresAt: new Date('2026-10-31T00:00:00.000Z') }), T0);

  const found = await store.findIdempotent(SCOPE, KEY);
  assert.notEqual(found, null, '过期行还在库里 ⇒ 读面读到它（与 PG 实现的 SELECT 无 WHERE 过期条件一致）');
  assert.equal(found.expiresAt.getTime(), new Date('2026-10-31T00:00:00.000Z').getTime());
});

test('[M 形状] 恰好三条到期边界：expires_at === at 算过期（与 PG 的 <= 同侧）', async () => {
  const store = createMemoryModerationIdempotencyStore();
  const boundary = new Date('2026-11-01T04:30:00.000Z');
  await store.claimIdempotent(SCOPE, KEY, row({ expiresAt: boundary }), T0);

  assert.equal(
    await store.claimIdempotent(SCOPE, KEY, row({ requestHash: 'r2' }), new Date(boundary.getTime() - 1)),
    'exists',
    '还差 1ms 到期 ⇒ 未过期 ⇒ exists',
  );
  assert.equal(
    await store.claimIdempotent(SCOPE, KEY, row({ requestHash: 'r3' }), boundary),
    'claimed',
    '恰好到期那一刻 ⇒ 已过期 ⇒ 可就地重占（PG 那条 WHERE 是 <=）',
  );
});

// ---------------------------------------------------------------------------
// B. PG 语句形状（静态：只读导出的 SQL 常量）
// ---------------------------------------------------------------------------

const SIX_COLUMNS = ['scope', 'key_hash', 'request_hash', 'payload', 'pending', 'expires_at'];

test('[SQL] 五条语句都指向 public.moderation_idempotency，且只有一份列清单', () => {
  for (const [name, sql] of Object.entries(MODERATION_IDEMPOTENCY_SQL)) {
    assert.match(sql, /public\.moderation_idempotency/, `${name} 必须全限定到 public.moderation_idempotency`);
  }

  // find：六列全列（scope/key_hash 是 WHERE 用到的列，也要读权）。
  for (const column of SIX_COLUMNS) {
    assert.match(MODERATION_IDEMPOTENCY_SQL.find, new RegExp(`\\b${column}\\b`), `find 缺 ${column}`);
  }
  // INSERT 六列：与 20-login-roles.sql 的 GRANT INSERT 是同一份清单。
  const insertList = MODERATION_IDEMPOTENCY_SQL.claim
    .match(/\(scope, key_hash, request_hash, payload, pending, expires_at\)/);
  assert.notEqual(insertList, null, 'claim 的 INSERT 列表必须是那六列（顺序与授权清单一致）');
  // UPDATE 只写四列。
  for (const column of ['request_hash', 'payload', 'pending', 'expires_at']) {
    assert.match(MODERATION_IDEMPOTENCY_SQL.claim, new RegExp(`SET[\\s\\S]*${column} = EXCLUDED\\.${column}`));
  }
});

test('[SQL] claim 的抢占条件就是那条 WHERE expires_at <= $7，且 RETURNING scope', () => {
  const claim = MODERATION_IDEMPOTENCY_SQL.claim;
  assert.match(claim, /ON CONFLICT \(scope, key_hash\) DO UPDATE/);
  assert.match(
    claim,
    /WHERE public\.moderation_idempotency\.expires_at <= \$7::timestamptz/,
    '少了这个 WHERE，任何一次 claim 都会覆盖既有行（同键重放变成"覆盖 + 再执行一次副作用"）',
  );
  assert.match(claim, /RETURNING scope/, '零行 ⇒ exists 的判据就靠它（RETURNING 也吃 SELECT 权）');
});

test('[SQL] finalize 只写 payload/pending；release 与 purge 都是整行 DELETE', () => {
  assert.match(MODERATION_IDEMPOTENCY_SQL.finalize, /SET payload = \$3::jsonb, pending = false/);
  assert.match(
    MODERATION_IDEMPOTENCY_SQL.finalize,
    /WHERE scope = \$1 AND key_hash = \$2/,
    'finalize 必须按 (scope, key_hash) 定位，不许全表改',
  );
  assert.match(MODERATION_IDEMPOTENCY_SQL.release, /^DELETE FROM public\.moderation_idempotency/);
  assert.match(MODERATION_IDEMPOTENCY_SQL.release, /WHERE scope = \$1 AND key_hash = \$2/);
  assert.match(MODERATION_IDEMPOTENCY_SQL.purge, /expires_at <= \$1::timestamptz/);
  assert.match(MODERATION_IDEMPOTENCY_SQL.purge, /RETURNING scope/);
});

// ---------------------------------------------------------------------------
// C. 缺表 fail-closed（记录型假池，不连库）
// ---------------------------------------------------------------------------

const PROBE_MARKER = 'to_regclass';

/**
 * 记录型假池（与 `ocr-store-pg-tables-missing.test.mjs` 同口径）：
 * - `script`：**业务语句**的应答序列（`Error` 实例 ⇒ 该条抛错），就绪探测**不**消耗它；
 * - `probe`：就绪探测的应答，`'ready' | 'missing' | 'unknown' | Error`（`Error` ⇒ 探测本身抛错）。
 */
function makeDb({ script = [], probe = 'ready' } = {}) {
  const log = [];
  const probes = [];
  let probeState = probe;
  let index = 0;

  const answerProbe = () => {
    if (probeState instanceof Error) throw probeState;
    if (probeState === 'ready') return { rows: [{ ready: true }] };
    if (probeState === 'missing') return { rows: [{ ready: false }] };
    if (probeState === 'unknown') return { rows: [] };
    throw new Error(`测试夹具错误：未知的 probe=${String(probeState)}`);
  };

  const next = async (text, values) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    if (sql.includes(PROBE_MARKER)) {
      probes.push({ sql, values });
      return answerProbe();
    }
    log.push({ sql, values });
    const response = script[index];
    index += 1;
    if (response instanceof Error) throw response;
    return { rows: response ?? [] };
  };

  const pool = { query: next };
  const sqls = () => log.map((entry) => entry.sql);
  const store = createPgModerationIdempotencyStore({ pool });
  return {
    pool,
    log,
    probes,
    sqls,
    store,
    setProbe(value) {
      probeState = value;
    },
  };
}

/** 缺表错误的形状（文案点名迁移号、`retryable:false`、`instanceof ApiError`）。 */
function assertTablesMissing(error) {
  assert.ok(error instanceof ModerationIdempotencyTablesMissingError, `实际错误：${String(error)}`);
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(error.retryable, false, '迁移未执行是部署问题，重试不会好 ⇒ retryable:false');
  assert.match(error.message, /0051_moderation_idempotency\.sql/);
  assert.match(error.message, /未迁移/);
}

const READERS = [
  ['findIdempotent', (store) => store.findIdempotent(SCOPE, KEY)],
  ['purgeIdempotent', (store) => store.purgeIdempotent(T0)],
];

const WRITERS = [
  ['claimIdempotent', (store) => store.claimIdempotent(SCOPE, KEY, row(), T0)],
  ['finalizeIdempotent', (store) => store.finalizeIdempotent(SCOPE, KEY, { ok: true })],
  ['releaseIdempotent', (store) => store.releaseIdempotent(SCOPE, KEY)],
];

test('[PG 缺表] 探测确认未迁移 ⇒ 读类 null/0，写类抛 PROVIDER_UNAVAILABLE 且点名 0051', async () => {
  for (const [name, call] of READERS) {
    const db = makeDb({ probe: 'missing' });
    const result = await call(db.store);
    assert.equal(result, name === 'findIdempotent' ? null : 0, `${name} 在缺表时必须退化成"没有记录"`);
    assert.deepEqual(db.sqls(), [], `${name} 不得在确认缺表后还发业务语句`);
  }

  for (const [name, call] of WRITERS) {
    const db = makeDb({ probe: 'missing' });
    await assert.rejects(call(db.store), (error) => {
      assertTablesMissing(error);
      return true;
    }, `${name} 在缺表时必须 fail-closed（⛔ 不静默丢写、⛔ 不退化成内存 store）`);
    assert.deepEqual(db.sqls(), [], `${name} 不得在确认缺表后还发业务语句`);
  }
});

test('[PG 缺表] 探测之后表被回滚（业务语句撞 42P01）⇒ 读类 null、写类抛，且缓存失效后重探', async () => {
  const reader = makeDb({
    probe: 'ready',
    script: [Object.assign(new Error('relation does not exist'), { code: '42P01' }), []],
  });
  assert.equal(await reader.store.findIdempotent(SCOPE, KEY), null);
  assert.equal(reader.probes.length, 1, '第一次调用只探一次（ready 进缓存）');
  assert.equal(await reader.store.findIdempotent(SCOPE, KEY), null);
  assert.equal(reader.probes.length, 2, '42P01 之后缓存必须失效 ⇒ 下一次调用重探（不是把"未知"粘成长期状态）');

  const writer = makeDb({
    probe: 'ready',
    script: [Object.assign(new Error('relation does not exist'), { code: '42P01' })],
  });
  await assert.rejects(writer.store.claimIdempotent(SCOPE, KEY, row(), T0), (error) => {
    assertTablesMissing(error);
    return true;
  });
});

test('[PG fail-closed] 探测本身失败 ⇒ 抛（⛔ 不得当成 missing 放过读类）', async () => {
  const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  const db = makeDb({ probe: timeout });
  await assert.rejects(db.store.findIdempotent(SCOPE, KEY), (error) => {
    assert.equal(error.code, 'PROVIDER_TIMEOUT', '探测失败的**分类**不能被这层吞掉');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('[PG fail-closed] 探测应答形状读不懂 ⇒ 抛 PROVIDER_UNAVAILABLE（未知 ≠ 未迁移）', async () => {
  const db = makeDb({ probe: 'unknown' });
  await assert.rejects(db.store.purgeIdempotent(T0), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.retryable, false);
    assert.match(error.message, /未知 ≠ 未迁移|就绪探测结果未知/);
    return true;
  });
});

test('[PG] 表就绪时五条语句的调用形状：claim 用 7 个参数，零行 ⇒ exists，一行 ⇒ claimed', async () => {
  const claimed = makeDb({ script: [[{ scope: SCOPE }]] });
  assert.equal(await claimed.store.claimIdempotent(SCOPE, KEY, row(), T0), 'claimed');
  const claimCall = claimed.log[0];
  assert.match(claimCall.sql, /ON CONFLICT \(scope, key_hash\) DO UPDATE/);
  assert.deepEqual(claimCall.values.slice(0, 3), [SCOPE, KEY, 'req-hash-1']);
  assert.equal(claimCall.values[4], true, '第 5 个参数是 pending');
  assert.equal(claimCall.values.length, 7, '第 7 个参数是 claim 的时刻 at（抢占条件用它比较）');

  const exists = makeDb({ script: [[]] });
  assert.equal(await exists.store.claimIdempotent(SCOPE, KEY, row(), T0), 'exists');

  const find = makeDb({ script: [[{ request_hash: 'r', payload: { a: 1 }, pending: false, expires_at: EXPIRES }]] });
  const found = await find.store.findIdempotent(SCOPE, KEY);
  assert.deepEqual(found, {
    scope: SCOPE,
    keyHash: KEY,
    requestHash: 'r',
    payload: { a: 1 },
    pending: false,
    expiresAt: EXPIRES,
  });

  const purge = makeDb({ script: [[{ scope: 'a' }, { scope: 'b' }]] });
  assert.equal(await purge.store.purgeIdempotent(T0), 2, 'purge 返回删掉的行数');
  assert.match(purge.sqls()[0], /^DELETE FROM public\.moderation_idempotency/);
});

test('[PG] 数据库故障折叠：57014 ⇒ PROVIDER_TIMEOUT，42501 ⇒ PROVIDER_UNAVAILABLE 不可重试', () => {
  assert.throws(
    () => classifyModerationIdempotencyDatabaseError(Object.assign(new Error('timeout'), { code: '57014' })),
    (error) => {
      assert.equal(error.code, 'PROVIDER_TIMEOUT');
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.throws(
    () => classifyModerationIdempotencyDatabaseError(Object.assign(new Error('denied'), { code: '42501' })),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.retryable, false, '权限不足是运维动作，重试永远不会好');
      return true;
    },
  );
  // 已经是 ApiError 的原样透出（⛔ 不二次折叠、不改写 code）。
  const original = new ApiError('PROVIDER_UNAVAILABLE', '原样', { retryable: false });
  assert.throws(() => classifyModerationIdempotencyDatabaseError(original), (error) => error === original);
});
