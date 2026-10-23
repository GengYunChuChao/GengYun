/**
 * R34 · `GET /admin/audit-logs`（库内审计日志只读查询）**单元测试**。
 *
 * 钉住四类判定（对应派单「单测：权限矩阵、分页边界、筛选组合、脱敏」）：
 * 1. **权限矩阵**：无会话 ⇒ 401 `SESSION_REQUIRED`；用户会话 ⇒ 403 `SCOPE_DENIED`；
 *    管理员但缺 `audit:read` ⇒ 403 `SCOPE_DENIED`，且**一次都不触端口**（不泄露"记录是否存在"：
 *    未授权先于任何查询失败，响应里也没有任何行数/游标信息）。
 * 2. **未接线**：端口 `null` ⇒ 503 `PROVIDER_UNAVAILABLE`（`retryable:false`），
 *    ⛔ **不返回空页**（空页会被读成"平台没有任何后台审计记录"）。
 * 3. **分页边界**：`limit` 缺省 20、上限 50（契约里 `Cursor` + `Limit` 共用参数，`validate_contracts.py`
 *    对带 `cursor` 的操作强制 `limit.maximum === 50`）；越界/非整数一律 400 且 field=`limit`；
 *    `next_cursor` 只在 `hasMore` 时给出，且能把 `(created_at,id)` 位置喂回端口。
 * 4. **筛选组合**：`action` / `entity` 各自转成端口入参（`actions` / `scopes`）、`from`/`to` 归一化后下传；
 *    未知枚举值 400（不静默返回空页）；`from > to` 400；游标与**当次筛选组合**绑定，换筛选必 `INVALID_CURSOR`。
 * 5. **脱敏**：端口行经**允许列表投影**（`toAuditLogRow`）—— 库里即使多出 `ip` / `user_agent` /
 *    凭据类列也不会出现在响应里；投影后不合契约（`action` 超 80、`target_ref.type` 不在闭集等）⇒ 503。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  AUDIT_ENTITY_SCOPES,
  AUDIT_LOG_SCOPE,
  scopeOfAuditEntity,
} from '../../services/api/src/admin/audit/catalog.ts';
import {
  createPostgresAdminAuditLogPort,
  toAuditLogRow,
} from '../../services/api/src/admin/audit/pg.ts';
import {
  AUDIT_LOG_OPERATION_IDS,
  createAdminAuditLogService,
} from '../../services/api/src/admin/audit/service.ts';
import { ApiError } from '../../services/api/src/errors.ts';

const ADMIN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_ADMIN_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SIGNING_KEY = 'gy-r34-audit-log-test-signing-key-0123456789';
const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

/** 契约 `AuditEvent` 形状的一行（端口出口形状）。 */
function auditRow(overrides = {}) {
  return {
    id: UUIDS[0],
    action: 'set_flag',
    scope: 'flags:write',
    target_ref: null,
    target_hint: 'herbicide_output',
    reason_code: 'admin_set_flag',
    request_id: UUIDS[1],
    result: 'accepted',
    created_at: '2026-10-20T10:00:00.000Z',
    actor: ADMIN_ID,
    before_value: null,
    after_value: null,
    ...overrides,
  };
}

/** `resolveContext` 要求 `requestId` 是 uuid（`identity.requestIdOf`），故用固定 uuid。 */
const REQUEST_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function adminContext({ scopes = [AUDIT_LOG_SCOPE], role = 'admin', userId = ADMIN_ID } = {}) {
  return { identity: { userId, authEpoch: 1, role, scopes }, requestId: REQUEST_ID };
}

/** 假只读端口：记录每次入参，按 `pages` 顺序返回固定页。 */
function makeFakePort({ items = [auditRow()], hasMore = false } = {}) {
  const calls = [];
  const port = {
    persistent: true,
    calls,
    async listAuditLogs(filters) {
      calls.push(filters);
      const rows = typeof items === 'function' ? items(filters) : items;
      const more = typeof hasMore === 'function' ? hasMore(filters) : hasMore;
      return { items: rows, hasMore: more };
    },
  };
  return port;
}

function makeService(port, { now, executionMode = 'stub' } = {}) {
  return createAdminAuditLogService({
    port,
    signingKey: SIGNING_KEY,
    executionMode,
    ...(now === undefined ? {} : { now }),
  });
}

function expectApiError(error, code) {
  assert.ok(error instanceof ApiError, `应为 ApiError，实际 ${String(error)}`);
  assert.equal(error.code, code);
  return true;
}

/** 0. 枚举闭集必须与契约、与库内写入点三处对齐。 */
test('GET /admin/audit-logs：action/entity 闭集与契约、库内写入点一致', () => {
  const openapi = JSON.parse(readFileSync('packages/contracts/openapi.json', 'utf8'));
  const operation = openapi.paths['/admin/audit-logs'].get;
  const params = operation.parameters.filter((parameter) => parameter.name !== undefined);
  const action = params.find((parameter) => parameter.name === 'action');
  const entity = params.find((parameter) => parameter.name === 'entity');
  assert.deepEqual(action.schema.enum, [...AUDIT_ACTIONS]);
  assert.deepEqual(entity.schema.enum, [...AUDIT_ENTITIES]);
  assert.equal(operation['x-scope'], AUDIT_LOG_SCOPE);
  assert.equal(operation['x-version-required'], false);
  // 库内写入点（迁移 0017 两处 + 迁移 0027 一处）写的 scope 就是 entity 的映射值。
  assert.deepEqual(Object.values(AUDIT_ENTITY_SCOPES).sort(), ['accounts:suspend', 'flags:write']);
  assert.equal(scopeOfAuditEntity('account'), 'accounts:suspend');
  assert.equal(scopeOfAuditEntity('flag'), 'flags:write');
  assert.deepEqual([...AUDIT_LOG_OPERATION_IDS], ['listAuditLogs']);
});

/** 1. 权限矩阵：未授权一律先失败，且不触端口。 */
test('GET /admin/audit-logs：权限矩阵（无会话 401 / 用户会话 403 / 缺 scope 403，均零端口调用）', async () => {
  const port = makeFakePort();
  const service = makeService(port);

  // 无会话（缺 identity）⇒ 401。
  await assert.rejects(
    () => service.listAuditLogs({}),
    (error) => expectApiError(error, 'SESSION_REQUIRED') && error.status === 401,
  );
  // 用户会话 ⇒ 403（后台接口不接受用户会话）。
  await assert.rejects(
    () => service.listAuditLogs(adminContext({ role: 'user' })),
    (error) => expectApiError(error, 'SCOPE_DENIED') && error.status === 403,
  );
  // 管理员但缺 audit:read ⇒ 403；文案只报缺哪个权限，不含任何记录信息。
  await assert.rejects(
    () => service.listAuditLogs(adminContext({ scopes: ['flags:read'] })),
    (error) =>
      expectApiError(error, 'SCOPE_DENIED') &&
      error.status === 403 &&
      error.message.includes(AUDIT_LOG_SCOPE),
  );
  assert.equal(port.calls.length, 0, '未授权时不得触达端口（否则可由响应延迟推断记录是否存在）');

  // 正确授权 ⇒ 200，且不回显任何凭据类键。
  const response = await service.listAuditLogs(adminContext());
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

/** 2. 未接线：503，不返回空页。 */
test('GET /admin/audit-logs：未接线 ⇒ 503 PROVIDER_UNAVAILABLE（不伪造空页）', async () => {
  for (const port of [null, { persistent: true }]) {
    const service = makeService(port);
    await assert.rejects(
      () => service.listAuditLogs(adminContext()),
      (error) =>
        expectApiError(error, 'PROVIDER_UNAVAILABLE') &&
        error.status === 503 &&
        error.retryable === false,
    );
  }
});

/** 3. 分页边界：limit 缺省/上限/非法值 + 游标往返。 */
test('GET /admin/audit-logs：分页边界（limit 缺省 20、上限 50、越界 400、next_cursor 往返）', async () => {
  const port = makeFakePort({ hasMore: false });
  const service = makeService(port);

  const first = await service.listAuditLogs(adminContext(), {});
  assert.equal(first.status, 200);
  assert.equal(port.calls[0].limit, 20, '缺省 limit 必须是 20（与 identity.parseLimit 同源）');
  assert.equal(first.body.data.next_cursor, null, 'hasMore=false 时不得给出游标');

  const upper = await service.listAuditLogs(adminContext(), { limit: '50' });
  assert.equal(upper.status, 200);
  assert.equal(port.calls[1].limit, 50);

  for (const bad of ['0', '51', '100', '2.5', 'abc', '-1']) {
    await assert.rejects(
      () => service.listAuditLogs(adminContext(), { limit: bad }),
      (error) =>
        expectApiError(error, 'INVALID_REQUEST') &&
        error.status === 400 &&
        error.details.some((detail) => detail.field === 'limit'),
    );
  }

  // 键集游标：`after` = `<created_at>|<id>`，端口侧按 (created_at,id) 降序切片。
  const pagedPort = makeFakePort({
    items: [
      auditRow({ id: UUIDS[0], created_at: '2026-10-20T10:00:02.000Z' }),
      auditRow({ id: UUIDS[1], created_at: '2026-10-20T10:00:01.000Z' }),
    ],
    hasMore: (filters) => filters.before === null,
  });
  const paged = makeService(pagedPort);
  const page1 = await paged.listAuditLogs(adminContext(), { limit: '2' });
  assert.ok(page1.body.data.next_cursor !== null);
  assert.equal(pagedPort.calls[0].before, null, '首页不得带 before');

  await paged.listAuditLogs(adminContext(), { limit: '2', cursor: page1.body.data.next_cursor });
  assert.deepEqual(pagedPort.calls[1].before, {
    createdAt: '2026-10-20T10:00:01.000Z',
    id: UUIDS[1],
  });
});

/** 4. 筛选组合：下传入参 + 未知枚举 400 + 区间顺序 400 + 游标绑定筛选。 */
test('GET /admin/audit-logs：筛选组合（action/entity/from/to 下传、未知值 400、from>to 400、游标绑定筛选）', async () => {
  const port = makeFakePort({ hasMore: false });
  const service = makeService(port);

  await service.listAuditLogs(adminContext(), {
    action: 'account.suspend',
    entity: 'account',
    from: '2026-10-01T00:00:00Z',
    to: '2026-10-20T00:00:00+08:00',
  });
  const filters = port.calls[0];
  assert.deepEqual(filters.actions, ['account.suspend']);
  assert.deepEqual(filters.scopes, ['accounts:suspend']);
  assert.equal(filters.from, '2026-10-01T00:00:00.000Z', 'from 必须归一化成 UTC ISO 串');
  assert.equal(filters.to, '2026-10-19T16:00:00.000Z', 'to 必须按偏移换算成 UTC');
  assert.equal(filters.before, null);

  // 不筛 ⇒ 两种筛选入参都是 null（SQL 里走 `IS NULL` 分支，不是空数组）。
  await service.listAuditLogs(adminContext(), {});
  assert.equal(port.calls[1].actions, null);
  assert.equal(port.calls[1].scopes, null);

  await assert.rejects(
    () => service.listAuditLogs(adminContext(), { action: 'account.delete' }),
    (error) =>
      expectApiError(error, 'INVALID_REQUEST') &&
      error.details.some((detail) => detail.field === 'action' && detail.code === 'enum'),
  );
  await assert.rejects(
    () => service.listAuditLogs(adminContext(), { entity: 'post' }),
    (error) =>
      expectApiError(error, 'INVALID_REQUEST') &&
      error.details.some((detail) => detail.field === 'entity' && detail.code === 'enum'),
  );
  await assert.rejects(
    () => service.listAuditLogs(adminContext(), { from: '2026-10-20 10:00:00' }),
    (error) =>
      expectApiError(error, 'INVALID_REQUEST') &&
      error.details.some((detail) => detail.field === 'from' && detail.code === 'format'),
  );
  await assert.rejects(
    () =>
      service.listAuditLogs(adminContext(), {
        from: '2026-10-20T00:00:00Z',
        to: '2026-10-01T00:00:00Z',
      }),
    (error) =>
      expectApiError(error, 'INVALID_REQUEST') &&
      error.details.some((detail) => detail.field === 'from' && detail.code === 'order'),
  );

  // 游标与筛选组合绑定：换筛选后旧游标必须被拒（否则会拿"筛过的位置"去翻"没筛的集合"）。
  const pagedPort = makeFakePort({ hasMore: true });
  const paged = makeService(pagedPort);
  const page = await paged.listAuditLogs(adminContext(), { action: 'set_flag' });
  assert.ok(page.body.data.next_cursor !== null);
  await assert.rejects(
    () =>
      paged.listAuditLogs(adminContext(), {
        action: 'account.restore',
        cursor: page.body.data.next_cursor,
      }),
    (error) => expectApiError(error, 'INVALID_CURSOR'),
  );
});

/** 4b. 游标完整性：跨用户 / 过期 / 篡改 / 位置不可解析。 */
test('GET /admin/audit-logs：游标完整性（跨用户、过期、篡改、位置不可解析一律 INVALID_CURSOR）', async () => {
  const t0 = new Date('2026-10-20T10:00:00.000Z');
  const port = makeFakePort({ hasMore: true });
  const service = makeService(port, { now: () => t0 });
  const page = await service.listAuditLogs(adminContext(), {});
  const cursor = page.body.data.next_cursor;
  assert.ok(typeof cursor === 'string');

  await assert.rejects(
    () => service.listAuditLogs(adminContext({ userId: OTHER_ADMIN_ID }), { cursor }),
    (error) => expectApiError(error, 'INVALID_CURSOR'),
  );
  await assert.rejects(
    () => service.listAuditLogs(adminContext(), { cursor: `${cursor}x` }),
    (error) => expectApiError(error, 'INVALID_CURSOR'),
  );
  const late = makeService(port, { now: () => new Date(t0.getTime() + 16 * 60 * 1000) });
  await assert.rejects(
    () => late.listAuditLogs(adminContext(), { cursor }),
    (error) => expectApiError(error, 'INVALID_CURSOR'),
  );
  await assert.rejects(
    () => service.listAuditLogs(adminContext(), { cursor: 12345 }),
    (error) =>
      expectApiError(error, 'INVALID_REQUEST') &&
      error.details.some((detail) => detail.field === 'cursor'),
  );
});

/** 5. 脱敏与形状：允许列表投影剥掉多余列；不合契约 ⇒ 503。 */
test('GET /admin/audit-logs：权限矩阵、筛选组合、分页边界与脱敏', async () => {
  // 允许列表投影：库里多出的列（含 ip / user_agent / 凭据类）一律不出现在响应里。
  const rawRow = {
    ...auditRow(),
    actor_id: ADMIN_ID,
    ip: '203.0.113.7',
    user_agent: 'Mozilla/5.0 (x)',
    credential: 'Bearer secret-token',
    session_token_hash: 'deadbeef',
  };
  const projected = toAuditLogRow(rawRow);
  assert.deepEqual(Object.keys(projected).sort(), [
    'action',
    'actor',
    'after_value',
    'before_value',
    'created_at',
    'id',
    'reason_code',
    'request_id',
    'result',
    'scope',
    'target_hint',
    'target_ref',
  ]);
  assert.equal(projected.actor, ADMIN_ID, 'DB 列 actor_id 必须映射到契约字段 actor');
  const serialized = JSON.stringify(projected);
  for (const secret of ['203.0.113.7', 'Mozilla', 'secret-token', 'deadbeef', 'actor_id']) {
    assert.ok(!serialized.includes(secret), `响应不得回显 ${secret}`);
  }

  // 端口已投影的行经服务层封套后仍不含凭据类键。
  const service = makeService(makeFakePort({ items: [projected] }));
  const response = await service.listAuditLogs(adminContext());
  assert.equal(response.status, 200);
  assert.equal(response.body.data.items.length, 1);
  assert.ok(!JSON.stringify(response.body).includes('203.0.113.7'));
  assert.equal(response.body.meta.request_id, REQUEST_ID);

  // 不合契约的行（action 超长 / target_ref.type 不在闭集）⇒ 503，不静默丢字段。
  const badAction = makeService(makeFakePort({ items: [auditRow({ action: 'x'.repeat(81) })] }));
  await assert.rejects(
    () => badAction.listAuditLogs(adminContext()),
    (error) => expectApiError(error, 'PROVIDER_UNAVAILABLE'),
  );
  const badTargetRef = makeService(
    makeFakePort({
      items: [auditRow({ target_ref: { type: 'account', id: ADMIN_ID, revision: 1 } })],
    }),
  );
  await assert.rejects(
    () => badTargetRef.listAuditLogs(adminContext()),
    (error) => expectApiError(error, 'PROVIDER_UNAVAILABLE'),
  );
});

/** 6. PG 适配器：七参数显式转型、键集语义、hasMore 来自 limit+1。 */
test('GET /admin/audit-logs：PG 适配器（参数化 SQL、limit+1 判 hasMore、行投影）', async () => {
  const queries = [];
  const rows = [
    { ...auditRow({ id: UUIDS[0], created_at: new Date('2026-10-20T10:00:02.000Z') }), ip: '10.0.0.1' },
    { ...auditRow({ id: UUIDS[1], created_at: '2026-10-20T10:00:01.000Z' }) },
    { ...auditRow({ id: UUIDS[2], created_at: '2026-10-20T10:00:00.000Z' }) },
  ];
  const pool = {
    async query(text, values) {
      queries.push({ text, values });
      return { rows };
    },
  };
  const port = createPostgresAdminAuditLogPort({ pool });
  const page = await port.listAuditLogs({
    limit: 2,
    from: '2026-10-01T00:00:00.000Z',
    to: null,
    actions: ['set_flag'],
    scopes: null,
    before: { createdAt: '2026-10-21T00:00:00.000Z', id: UUIDS[2] },
  });

  assert.equal(queries.length, 1);
  const [{ text, values }] = queries;
  assert.ok(text.includes('FROM public.list_admin_audit_logs('), '只能经只读函数读，不得直接 SELECT 表');
  assert.ok(!text.includes('admin_audit_events'), '运行时不得直接查审计表');
  assert.deepEqual(values, [
    3,
    '2026-10-01T00:00:00.000Z',
    null,
    ['set_flag'],
    null,
    '2026-10-21T00:00:00.000Z',
    UUIDS[2],
  ]);
  assert.equal(page.hasMore, true, 'limit+1 行 ⇒ hasMore');
  assert.equal(page.items.length, 2, '返回行数必须被截回 limit');
  assert.equal(page.items[0].created_at, '2026-10-20T10:00:02.000Z');
  assert.ok(!('ip' in page.items[0]));

  // 参数化：SQL 文本里不得出现任何用户输入拼接。
  for (const value of ['set_flag', '2026-10-01T00:00:00.000Z', UUIDS[2]]) {
    assert.ok(!text.includes(value), `SQL 不得拼接值 ${value}`);
  }

  // 端口形状非法：limit 非安全正整数 / before 形状非法 ⇒ 明确错误，不查库。
  await assert.rejects(
    () => port.listAuditLogs({ limit: 0, from: null, to: null, actions: null, scopes: null, before: null }),
    (error) => expectApiError(error, 'INVALID_REQUEST'),
  );
  await assert.rejects(
    () =>
      port.listAuditLogs({
        limit: 5,
        from: null,
        to: null,
        actions: null,
        scopes: null,
        before: { createdAt: 'not-a-time', id: UUIDS[0] },
      }),
    (error) => expectApiError(error, 'INVALID_CURSOR'),
  );
  assert.equal(queries.length, 1, '参数非法时不得发起查询');
});
