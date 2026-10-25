/**
 * S4-S3 P2-a · 第三方删除真库端口（`services/api/src/privacy/third-party-deletion-pg.ts`）纯单测。
 *
 * **不用真库**：全部用假 pool（只记录 `query(text, values)` 并按需抛错），
 * 真库臂是 P1 的 `tests/integration/third-party-deletion-pg.mjs`（需 `GY_TEST_DB_URL`，与本片正交）。
 *
 * 覆盖四组：
 *   1. 写路径：SQL 文本与**七个**位置参数逐字核对；七个形参类型序列与迁移 `0044` 逐字对齐；
 *   2. 错误映射：`G0001/G0002/G0003`、`42501/42883`、`57014/55P03`、瞬时驱动码、无法归类；
 *   3. 端口层前置校验：非法 state / 缺 evidence_ref / 非 uuid / 超长 / 时刻不可解析
 *      ⇒ 必须在**任何 SQL 之前**拒绝（断言语数量为 0）；
 *   4. 读路径：八列映射与迁移 `RETURNS TABLE` 顺序一致、空结果零行、形状不符失败关闭。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createPostgresThirdPartyDeletionPort,
  mapSqlError,
  LIST_THIRD_PARTY_DELETIONS_FUNCTION,
  RECORD_THIRD_PARTY_DELETION_FUNCTION,
} from '../../services/api/src/privacy/third-party-deletion-pg.ts';
import { ApiError } from '../../services/api/src/errors.ts';

const MIGRATION_PATH = new URL('../../services/api/db/migrations/0044_third_party_deletion_persistence.sql', import.meta.url);
const MIGRATION = readFileSync(MIGRATION_PATH, 'utf8');

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const EXPORT_REF = '22222222-2222-4222-8222-222222222222';
const AT = '2026-10-26T09:30:00.000Z';

/** 写路径**唯一**一条语句：与源文件逐字一致（改源文件就必须改这里，否则本片失效）。 */
const EXPECTED_RECORD_SQL = `SELECT public.record_third_party_deletion(
  $1::uuid, $2::text, $3::uuid, $4::text, $5::text, $6::text, $7::timestamptz
) AS result`;

/** 读路径**唯一**一条语句（显式列名，列序即 `RETURNS TABLE` 契约）。 */
const EXPECTED_LIST_SQL = `SELECT recipient_id, export_ref, online_state, backup_state,
       requested_at, confirmed_at, evidence_ref, error_code
  FROM public.list_third_party_deletions($1::uuid)`;

/** 库层返回的写快照（`0044:248-258`，九个键）。 */
const WRITE_RESULT = {
  request_id: REQUEST_ID,
  recipient_id: 'recv-a',
  export_ref: EXPORT_REF,
  online_state: 'confirmed',
  backup_state: 'confirmed',
  requested_at: '2026-10-26T09:00:00.000Z',
  confirmed_at: AT,
  evidence_ref: 'evidence/ticket-1',
  error_code: null,
};

/** 读路径一行（`0044:271-280`，八列，**没有** `request_id`）。 */
const LIST_ROW = {
  recipient_id: 'recv-a',
  export_ref: EXPORT_REF,
  online_state: 'requested',
  backup_state: 'requested',
  requested_at: '2026-10-26T09:00:00.000Z',
  confirmed_at: null,
  evidence_ref: null,
  error_code: null,
};

const VALID_WRITE = {
  requestId: REQUEST_ID,
  recipientId: 'recv-a',
  exportRef: EXPORT_REF,
  state: 'confirmed',
  evidenceRef: 'evidence/ticket-1',
  errorCode: null,
  at: AT,
};

/** 假 pool：记录每条 `query(text, values)`，行为由 `respond` 决定。 */
function makePool(respond = () => ({ rows: [] })) {
  const calls = [];
  const pool = {
    async query(text, values) {
      calls.push({ text, values });
      return respond(text, values, calls.length);
    },
  };
  return { pool, calls };
}

function pgError(code, message = 'driver text that must not leak') {
  return Object.assign(new Error(message), { code });
}

// ---------------------------------------------------------------------------
// 1. 写路径：SQL 与七个位置参数逐字
// ---------------------------------------------------------------------------

test('third-party-deletion-pg/写路径：SQL 文本与七个位置参数逐字核对', async () => {
  const { pool, calls } = makePool(() => ({ rows: [{ result: WRITE_RESULT }] }));
  const port = createPostgresThirdPartyDeletionPort({ pool });

  const record = await port.subscribeThirdPartyDeletion(VALID_WRITE);

  assert.equal(calls.length, 1, '写路径必须恰好一条语句');
  assert.equal(calls[0].text, EXPECTED_RECORD_SQL, 'SQL 必须逐字一致（含七个显式转型）');
  assert.deepEqual(
    calls[0].values,
    [REQUEST_ID, 'recv-a', EXPORT_REF, 'confirmed', 'evidence/ticket-1', null, AT],
    '七个位置参数必须是 [request_id, recipient_id, export_ref, state, evidence_ref, error_code, at]',
  );
  assert.equal(calls[0].values.length, 7, '函数是七参，⛔ 不能多传也不能少传');
  assert.equal(RECORD_THIRD_PARTY_DELETION_FUNCTION, 'public.record_third_party_deletion');
  assert.deepEqual(
    record,
    {
      requestId: REQUEST_ID,
      recipientId: 'recv-a',
      exportRef: EXPORT_REF,
      onlineState: 'confirmed',
      backupState: 'confirmed',
      requestedAt: '2026-10-26T09:00:00.000Z',
      confirmedAt: AT,
      evidenceRef: 'evidence/ticket-1',
      errorCode: null,
    },
    'jsonb 九个键必须映射成驼峰记录',
  );
});

test('third-party-deletion-pg/写路径：七个形参类型序列与迁移 0044 逐字对齐（uuid/text/uuid/text/text/text/timestamptz）', () => {
  const block = MIGRATION.match(/CREATE FUNCTION public\.record_third_party_deletion\(([\s\S]*?)\) RETURNS jsonb/);
  assert.ok(block, '迁移里没找到 record_third_party_deletion 的形参块：0044 改了？');
  const migrationParams = [...block[1].matchAll(/(p_[a-z_]+)\s+(uuid|text|timestamptz)/g)].map((m) => ({
    name: m[1],
    type: m[2],
  }));
  assert.deepEqual(
    migrationParams,
    [
      { name: 'p_request_id', type: 'uuid' },
      { name: 'p_recipient_id', type: 'text' },
      { name: 'p_export_ref', type: 'uuid' },
      { name: 'p_state', type: 'text' },
      { name: 'p_evidence_ref', type: 'text' },
      { name: 'p_error_code', type: 'text' },
      { name: 'p_at', type: 'timestamptz' },
    ],
    '端口按位置传参，形参顺序/类型一变就必须同步本端口',
  );

  // 端口发出的 SQL 里的转型序列必须与上面那条形参序列**逐个**对齐。
  const casts = [...EXPECTED_RECORD_SQL.matchAll(/\$(\d)::(uuid|text|timestamptz)/g)].map((m) => ({
    position: Number(m[1]),
    type: m[2],
  }));
  assert.deepEqual(casts.map((item) => item.position), [1, 2, 3, 4, 5, 6, 7], '七个占位符必须连续且各用一次');
  assert.deepEqual(
    casts.map((item) => item.type),
    migrationParams.map((item) => item.type),
    '$1…$7 的显式转型必须与 p_request_id…p_at 的类型逐个一致',
  );
});

// ---------------------------------------------------------------------------
// 2. 错误映射：零新增错误码
// ---------------------------------------------------------------------------

test('third-party-deletion-pg/G0001、G0002 映射到既有 400/404', async () => {
  for (const [sqlState, code, status] of [
    ['G0001', 'INVALID_REQUEST', 400],
    ['G0002', 'NOT_FOUND', 404],
  ]) {
    const { pool } = makePool(() => {
      throw pgError(sqlState);
    });
    const port = createPostgresThirdPartyDeletionPort({ pool });
    await assert.rejects(port.subscribeThirdPartyDeletion(VALID_WRITE), (error) => {
      assert.equal(error.code, code, `${sqlState} ⇒ ${code}`);
      assert.equal(error.status, status);
      assert.equal(error.retryable, false, `${sqlState} 不可重试`);
      assert.ok(!error.message.includes('driver text'), '不得透出驱动原文');
      return true;
    });
  }
});

test('third-party-deletion-pg/G0003 是「终态不可回退」(409)，⛔ 不是并发重试', async () => {
  const { pool } = makePool(() => {
    throw pgError('G0003');
  });
  const port = createPostgresThirdPartyDeletionPort({ pool });
  await assert.rejects(port.subscribeThirdPartyDeletion(VALID_WRITE), (error) => {
    assert.equal(error.code, 'REVISION_CONFLICT');
    assert.equal(error.status, 409);
    assert.equal(error.retryable, false, 'G0003 重试永远同一个结果 ⇒ 不可重试');
    assert.match(error.message, /终态/, '文案必须说清是终态不可回退，而不是「已在受理中」或「并发重试」');
    assert.ok(!/并发|重试|受理中/.test(error.message), '不得把终态冲突说成并发/重试');
    return true;
  });
});

test('third-party-deletion-pg/42501、42883 ⇒ 503 且 retryable:false（权限/函数缺失绝不降级）', async () => {
  for (const sqlState of ['42501', '42883']) {
    const { pool } = makePool(() => {
      throw pgError(sqlState);
    });
    const port = createPostgresThirdPartyDeletionPort({ pool });
    await assert.rejects(port.subscribeThirdPartyDeletion(VALID_WRITE), (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `${sqlState} ⇒ PROVIDER_UNAVAILABLE`);
      assert.equal(error.status, 503);
      assert.equal(error.retryable, false, `${sqlState} 需运维补权限/跑迁移，重试不会好`);
      return true;
    });
  }
});

test('third-party-deletion-pg/57014、55P03 ⇒ 504 PROVIDER_TIMEOUT', async () => {
  for (const sqlState of ['57014', '55P03']) {
    const { pool } = makePool(() => {
      throw pgError(sqlState);
    });
    const port = createPostgresThirdPartyDeletionPort({ pool });
    await assert.rejects(port.subscribeThirdPartyDeletion(VALID_WRITE), (error) => {
      assert.equal(error.code, 'PROVIDER_TIMEOUT', `${sqlState} ⇒ PROVIDER_TIMEOUT`);
      assert.equal(error.status, 504);
      assert.equal(error.retryable, true, `${sqlState} 是超时类，稍后重试可能成功`);
      return true;
    });
  }
});

test('third-party-deletion-pg/瞬时类（ECONNRESET 等）⇒ 503 且 retryable:true', async () => {
  for (const driverCode of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', '40001', '40P01', '08006']) {
    const { pool } = makePool(() => {
      throw pgError(driverCode);
    });
    const port = createPostgresThirdPartyDeletionPort({ pool });
    await assert.rejects(port.subscribeThirdPartyDeletion(VALID_WRITE), (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `${driverCode} ⇒ PROVIDER_UNAVAILABLE`);
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true, `${driverCode} 是瞬时类（db/pool.ts:92 的口径）`);
      return true;
    });
  }
});

test('third-party-deletion-pg/无法归类的错误 ⇒ 503 且 retryable:false，且不透出驱动原文', async () => {
  const { pool } = makePool(() => {
    throw pgError('42P01', 'relation "third_party_deletions" does not exist');
  });
  const port = createPostgresThirdPartyDeletionPort({ pool });
  await assert.rejects(port.subscribeThirdPartyDeletion(VALID_WRITE), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.equal(error.retryable, false);
    assert.ok(!error.message.includes('does not exist'), '不得透出驱动原文');
    return true;
  });

  // 连 code 都没有的异常同样归到不可用/不可重试。
  const bare = makePool(() => {
    throw new Error('boom');
  });
  await assert.rejects(createPostgresThirdPartyDeletionPort({ pool: bare.pool }).subscribeThirdPartyDeletion(VALID_WRITE), (error) => {
    assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('third-party-deletion-pg/mapSqlError 对 ApiError 原样透传（不被二次包装）', () => {
  const already = new ApiError('REJECTED', '已被上游映射过');
  assert.throws(() => mapSqlError(already), (error) => error === already, '已映射过的错误必须原样抛出，⛔ 不二次包装');
  assert.throws(() => mapSqlError(pgError('42501')), (error) => error instanceof ApiError);
});

// ---------------------------------------------------------------------------
// 3. 端口层前置校验：任何 SQL 之前拒绝
// ---------------------------------------------------------------------------

test('third-party-deletion-pg/端口层前置校验：非法入参在任何 SQL 之前判 400（语句数为 0）', async () => {
  const cases = [
    ['state 不在闭集（not_requested 是「没有请求」，不可写）', { ...VALID_WRITE, state: 'not_requested' }],
    ['state 完全非法', { ...VALID_WRITE, state: 'deleted' }],
    ['state 非字符串', { ...VALID_WRITE, state: 7 }],
    ['confirmed 缺 evidence_ref', { ...VALID_WRITE, evidenceRef: null }],
    ['confirmed 的 evidence_ref 是空白', { ...VALID_WRITE, evidenceRef: '   ' }],
    ['非 confirmed 带 evidence_ref', { ...VALID_WRITE, state: 'requested', evidenceRef: 'evidence/x' }],
    ['failed 缺 error_code', { ...VALID_WRITE, state: 'failed', evidenceRef: null, errorCode: null }],
    ['failed 的 error_code 是空白', { ...VALID_WRITE, state: 'failed', evidenceRef: null, errorCode: '' }],
    ['request_id 不是 uuid', { ...VALID_WRITE, requestId: 'not-a-uuid' }],
    ['request_id 缺失', { ...VALID_WRITE, requestId: undefined }],
    ['export_ref 不是 uuid', { ...VALID_WRITE, exportRef: 'export-1' }],
    ['recipient_id 为空', { ...VALID_WRITE, recipientId: '  ' }],
    ['recipient_id 超过 80 字符（0044:123 同口径）', { ...VALID_WRITE, recipientId: 'r'.repeat(81) }],
    ['error_code 超过 80 字符（0044:130 同口径）', { ...VALID_WRITE, state: 'failed', evidenceRef: null, errorCode: 'e'.repeat(81) }],
    ['at 不是可解析时刻', { ...VALID_WRITE, at: 'yesterday' }],
    ['at 不是字符串', { ...VALID_WRITE, at: 1700000000000 }],
  ];

  for (const [label, input] of cases) {
    const { pool, calls } = makePool(() => ({ rows: [{ result: WRITE_RESULT }] }));
    const port = createPostgresThirdPartyDeletionPort({ pool });
    await assert.rejects(port.subscribeThirdPartyDeletion(input), (error) => {
      assert.equal(error.code, 'INVALID_REQUEST', `${label} ⇒ INVALID_REQUEST`);
      assert.equal(error.status, 400, `${label} ⇒ 400`);
      return true;
    });
    assert.equal(calls.length, 0, `${label}：必须在任何 SQL 之前拒绝（实际发了 ${calls.length} 条）`);
  }
});

test('third-party-deletion-pg/端口层前置校验：读路径非 uuid 直接 400，零 SQL', async () => {
  for (const bad of ['not-a-uuid', '', undefined, 42]) {
    const { pool, calls } = makePool(() => ({ rows: [] }));
    const port = createPostgresThirdPartyDeletionPort({ pool });
    await assert.rejects(port.listThirdPartyDeletions(bad), (error) => {
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.equal(error.status, 400);
      return true;
    });
    assert.equal(calls.length, 0, '读路径非法入参不得发出任何 SQL');
  }
});

test('third-party-deletion-pg/端口层放行库层放行的组合（不新增库层没有的拒绝规则）', async () => {
  // `unsupported` 可以带也可以不带 error_code（0044:155-157）；`confirmed` 带 error_code 时库层静默丢弃。
  for (const input of [
    { ...VALID_WRITE, state: 'unsupported', evidenceRef: null, errorCode: null },
    { ...VALID_WRITE, state: 'unsupported', evidenceRef: null, errorCode: 'NOT_SUPPORTED' },
    { ...VALID_WRITE, state: 'requested', evidenceRef: null, errorCode: null },
    { ...VALID_WRITE, state: 'failed', evidenceRef: null, errorCode: 'TIMEOUT' },
  ]) {
    const { pool, calls } = makePool(() => ({ rows: [{ result: { ...WRITE_RESULT, online_state: input.state, backup_state: input.state } }] }));
    const port = createPostgresThirdPartyDeletionPort({ pool });
    const record = await port.subscribeThirdPartyDeletion(input);
    assert.equal(calls.length, 1, `${input.state} 必须被放行到库层`);
    assert.equal(record.onlineState, input.state);
  }
});

// ---------------------------------------------------------------------------
// 4. 读路径与形状守卫
// ---------------------------------------------------------------------------

test('third-party-deletion-pg/读路径：八列映射 + 八个列名与迁移 RETURNS TABLE 顺序一致', async () => {
  const { pool, calls } = makePool(() => ({ rows: [LIST_ROW] }));
  const port = createPostgresThirdPartyDeletionPort({ pool });

  const rows = await port.listThirdPartyDeletions(REQUEST_ID);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, EXPECTED_LIST_SQL, '读路径 SQL 必须逐字一致（显式列名 + 函数调用）');
  assert.deepEqual(calls[0].values, [REQUEST_ID], '读路径只按 request_id 查');
  assert.equal(LIST_THIRD_PARTY_DELETIONS_FUNCTION, 'public.list_third_party_deletions');
  assert.deepEqual(rows, [
    {
      requestId: REQUEST_ID,
      recipientId: 'recv-a',
      exportRef: EXPORT_REF,
      onlineState: 'requested',
      backupState: 'requested',
      requestedAt: '2026-10-26T09:00:00.000Z',
      confirmedAt: null,
      evidenceRef: null,
      errorCode: null,
    },
  ]);

  const retBlock = MIGRATION.match(/CREATE FUNCTION public\.list_third_party_deletions\(p_request_id uuid\)\s*RETURNS TABLE \(([\s\S]*?)\)\s*LANGUAGE/);
  assert.ok(retBlock, '迁移里没找到 list_third_party_deletions 的 RETURNS TABLE：0044 改了？');
  const migrationColumns = [...retBlock[1].matchAll(/([a-z_]+)\s+(uuid|text)/g)].map((m) => m[1]);
  const selectedColumns = [...EXPECTED_LIST_SQL.matchAll(/^\s*(?:SELECT )?([a-z_,\s]+?),?\s*$/gm)]
    .flatMap((m) => m[1].split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
  assert.deepEqual(
    migrationColumns,
    ['recipient_id', 'export_ref', 'online_state', 'backup_state', 'requested_at', 'confirmed_at', 'evidence_ref', 'error_code'],
    'RETURNS TABLE 的八列顺序即契约',
  );
  assert.ok(selectedColumns.length > 0, '读路径 SQL 解析不出列名');
  for (const column of migrationColumns) {
    assert.ok(selectedColumns.includes(column), `读路径 SQL 缺列 ${column}`);
  }
  assert.ok(!selectedColumns.includes('request_id'), 'RETURNS TABLE 不含 request_id（用入参补齐），SQL 里也不该选它');
});

test('third-party-deletion-pg/读路径：空结果返回 []（不是 null、也不是报错）', async () => {
  const { pool } = makePool(() => ({ rows: [] }));
  const port = createPostgresThirdPartyDeletionPort({ pool });
  const rows = await port.listThirdPartyDeletions(REQUEST_ID);
  assert.deepEqual(rows, []);
  assert.ok(Array.isArray(rows));
});

test('third-party-deletion-pg/读路径：行形状不符 ⇒ 503 retryable:false（失败关闭，不把读不懂的当成空）', async () => {
  for (const [label, row] of [
    ['缺 requested_at', { ...LIST_ROW, requested_at: undefined }],
    ['requested_at 不可解析', { ...LIST_ROW, requested_at: 'not-a-time' }],
    ['recipient_id 不是字符串', { ...LIST_ROW, recipient_id: 42 }],
    ['行不是对象', 'nope'],
  ]) {
    const { pool } = makePool(() => ({ rows: [row] }));
    const port = createPostgresThirdPartyDeletionPort({ pool });
    await assert.rejects(port.listThirdPartyDeletions(REQUEST_ID), (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `${label} ⇒ PROVIDER_UNAVAILABLE`);
      assert.equal(error.status, 503);
      assert.equal(error.retryable, false, `${label} 是版本不一致的确定性缺陷，重试不会好`);
      return true;
    });
  }
});

test('third-party-deletion-pg/写路径：返回形状不符或零行 ⇒ 503 retryable:false（绝不伪造受理）', async () => {
  for (const [label, rows] of [
    ['零行', []],
    ['result 缺失', [{ ok: true }]],
    ['result 不是对象', [{ result: 'ok' }]],
    ['缺 evidence_ref 键以外的必填键', [{ result: { ...WRITE_RESULT, confirmed_at: undefined, requested_at: undefined } }]],
    ['online_state 不是字符串', [{ result: { ...WRITE_RESULT, online_state: null } }]],
  ]) {
    const { pool } = makePool(() => ({ rows }));
    const port = createPostgresThirdPartyDeletionPort({ pool });
    await assert.rejects(port.subscribeThirdPartyDeletion(VALID_WRITE), (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', `${label} ⇒ PROVIDER_UNAVAILABLE`);
      assert.equal(error.retryable, false);
      return true;
    });
  }
});

// ---------------------------------------------------------------------------
// 5. 端口形状（不含 close / 不叫 available / 不拆两个状态）
// ---------------------------------------------------------------------------

test('third-party-deletion-pg/端口形状：persistent:true、无 close()、无 available、不提供线上/备份分置入口', () => {
  const { pool } = makePool();
  const port = createPostgresThirdPartyDeletionPort({ pool });
  assert.equal(port.persistent, true, '真库端口用 persistent 标记（available 在仓内已有三层不同含义）');
  assert.deepEqual(Object.keys(port).sort(), ['listThirdPartyDeletions', 'persistent', 'subscribeThirdPartyDeletion']);
  assert.equal(port.close, undefined, '端口不持有资源，不实现 close()');
  assert.equal(port.available, undefined, '⛔ 不要用 available 命名（app.ts 等处已占用其它含义）');
});

test('third-party-deletion-pg/构造期只做形状守卫：没有 query 的 pool ⇒ 立刻抛错（不探测函数是否存在）', () => {
  for (const pool of [undefined, null, {}, { query: 'nope' }]) {
    assert.throws(() => createPostgresThirdPartyDeletionPort({ pool }), /需要 pg 连接池/);
  }
  // 构造期不得发任何 SQL（探测函数存在会把「迁移没跑」变成启动期崩溃）。
  const { pool, calls } = makePool();
  createPostgresThirdPartyDeletionPort({ pool });
  assert.equal(calls.length, 0, '构造期零 SQL');
});
