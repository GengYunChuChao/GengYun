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
 *    `next_cursor` 只在 `hasMore` 时给出，且位置必须是**微秒精度**：拿 `created_at`（毫秒）
 *    拼游标会跳过「同一毫秒内微秒更晚」的行（真库臂有正反两侧读数）。
 * 4. **筛选组合**：`action` / `entity` 各自转成端口入参（`actions` / `scopes`）、`from`/`to` 归一化后下传；
 *    未知枚举值 400（不静默返回空页）；`from > to` 400；游标与**当次筛选组合**绑定，换筛选必 `INVALID_CURSOR`。
 * 5. **脱敏**：端口行经**允许列表投影**（`toAuditLogRow`）—— 库里即使多出 `ip` / `user_agent` /
 *    凭据类列也不会出现在响应里；投影后不合契约（`action` 超 80、`target_ref.type` 不在闭集等）⇒ 503。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AUDIT_ACTION_ACCOUNT_RESTORE,
  AUDIT_ACTION_ACCOUNT_SUSPEND,
  AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE,
  AUDIT_ACTION_ADMIN_ACCOUNT_ENABLE,
  AUDIT_ACTION_ADMIN_SCOPE_DENY,
  AUDIT_ACTION_ADMIN_SCOPE_GRANT,
  AUDIT_ACTION_ADMIN_SCOPE_REVOKE,
  AUDIT_ACTION_JOB_CANCEL,
  AUDIT_ACTION_POST_HIDE,
  AUDIT_ACTION_SET_FLAG,
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  AUDIT_ENTITY_ACTION_GUARDS,
  AUDIT_ENTITY_SCOPES,
  AUDIT_LOG_SCOPE,
  actionsOfAuditEntity,
  scopeOfAuditEntity,
} from '../../services/api/src/admin/audit/catalog.ts';
import {
  AUDIT_READING_KIND,
  createPostgresAdminAuditLogPort,
  readingKindOf,
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

/** 毫秒 ISO → 六位微秒文本（`2026-10-20T10:00:01.000Z` → `…01.000000Z`）。 */
function toMicros(iso) {
  return iso.replace(/\.(\d{3})Z$/, '.$1000Z');
}

/**
 * 假只读端口：记录每次入参，返回固定页。
 *
 * `nextPosition` 默认按「本页最后一行的 `created_at` 补三位零」升到微秒；也可以显式传入，
 * 用来钉住「服务层必须用端口给的微秒位置，不许自己拿 `items[].created_at`（毫秒）拼」。
 */
function makeFakePort({ items = [auditRow()], hasMore = false, nextPosition } = {}) {
  const calls = [];
  const port = {
    persistent: true,
    calls,
    async listAuditLogs(filters) {
      calls.push(filters);
      const rows = typeof items === 'function' ? items(filters) : items;
      const more = typeof hasMore === 'function' ? hasMore(filters) : hasMore;
      const lastRow = rows[rows.length - 1];
      const position =
        nextPosition !== undefined
          ? nextPosition
          : more && lastRow !== undefined
            ? { createdAt: toMicros(lastRow.created_at), id: lastRow.id }
            : null;
      return { items: rows, hasMore: more, nextPosition: position };
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
  // 库内写入点（迁移 0017 两处 + 0020/0027 一处 + 0043 一处 + 0041 两处 + 0046 一处 + 0047 一处
  // + 0048 两处）写的 scope 就是 entity 的映射值。`admin_scope` 映射到 `scopes:write`，但 0041 的
  // 授予/撤销行把 `scope` 写成**被授/被撤的那个 scope 本身** ⇒ 这条映射只收窄命中（拒绝行全中、
  // 授予/撤销只中 `scopes:write` 那些）。取舍见 `catalog.ts` 文件头「「一变多」的 `scope` 列」。
  // `post` 追加 `sources:write`（0047 的下架行写死这个值），但**单靠它不够**：0041/0046 的
  // 权限行也把 `p_scope` 直传给 `scope` 列，所以 `post` 另配动作护栏（下一条用例专测）。
  // `admin_account` 追加 `scopes:write`（0048 的停用/恢复行写死这个值，`:286` / `:417`）⇒ 与
  // `admin_scope` **共用同一个字面量**，同样「单靠它不够」，所以它也配动作护栏（同一条用例）。
  const entityScopes = Object.values(AUDIT_ENTITY_SCOPES);
  assert.equal(entityScopes.length, 6, '六个实体各有一个 scope 映射（admin_scope 与 admin_account 共用 scopes:write）');
  assert.deepEqual([...new Set(entityScopes)].sort(), [
    'accounts:suspend',
    'flags:write',
    'jobs:cancel',
    'scopes:write',
    'sources:write',
  ]);
  assert.equal(scopeOfAuditEntity('account'), 'accounts:suspend');
  assert.equal(scopeOfAuditEntity('flag'), 'flags:write');
  // 0043 的 `record_admin_job_cancel_audit` 写的是 `jobs:cancel`（迁移 :175），不是 `jobs:read`。
  assert.equal(scopeOfAuditEntity('job'), 'jobs:cancel');
  // 0046 的 `record_admin_scope_denial` 把调用方给的 `p_scope` 直传进 `scope` 列（不是函数体字面量），
  // 今天的调用点固定申报 `scopes:write`（`scope-denial-trace.ts` 的 `ADMIN_SCOPE_DENIAL_SCOPE`）。
  assert.equal(scopeOfAuditEntity('admin_scope'), 'scopes:write');
  // 0047 的 `record_admin_post_hide_audit` 写死 `scope='sources:write'`（迁移 :192）。
  assert.equal(scopeOfAuditEntity('post'), 'sources:write');
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
    createdAt: '2026-10-20T10:00:01.000000Z',
    id: UUIDS[1],
  });
});

/**
 * 3b. **同毫秒不同微秒不得漏行**（审查发现的真缺陷的回归钉子）。
 *
 * 缺陷形态：游标位置若取 `items[last].created_at`（契约字段，毫秒 ISO），PG 的微秒会被
 * 截断成 `.123`，于是同一毫秒内 `.123001…123999` 的行全部落在「已翻过」的一侧被跳过。
 * 这里让端口故意给出「毫秒 created_at = .123 但微秒位置 = .123001」的一页：
 * 服务层必须把 `.123001` 写进游标，而不是 `.123`。
 */
test('GET /admin/audit-logs：同毫秒不同微秒 ⇒ 游标位置必须保留微秒（不得按毫秒截断）', async () => {
  const a004 = auditRow({ id: UUIDS[2], created_at: '2026-10-20T10:00:10.123Z' });
  const a001 = auditRow({ id: UUIDS[0], created_at: '2026-10-20T10:00:10.123Z' });
  const port = makeFakePort({
    items: [a004, a001],
    hasMore: true,
    // 端口从 `cursor_position` 列拿到的真实位置：微秒级，且与毫秒 `created_at` 不同。
    nextPosition: { createdAt: '2026-10-20T10:00:10.123001Z', id: UUIDS[0] },
  });
  const service = makeService(port);
  const page1 = await service.listAuditLogs(adminContext(), { limit: '2' });
  const cursor = page1.body.data.next_cursor;
  assert.ok(typeof cursor === 'string', 'hasMore ⇒ 必须给出游标');

  await service.listAuditLogs(adminContext(), { limit: '2', cursor });
  assert.deepEqual(
    port.calls[1].before,
    { createdAt: '2026-10-20T10:00:10.123001Z', id: UUIDS[0] },
    '游标位置必须来自端口的微秒位置，不得用毫秒 created_at 拼',
  );

  // 反证：毫秒位置会被服务层拒掉（fail-closed），而不是拿它去查库漏掉同一毫秒的行。
  const msPort = makeFakePort({
    items: [a004, a001],
    hasMore: true,
    nextPosition: { createdAt: '2026-10-20T10:00:10.123Z', id: UUIDS[0] },
  });
  const msService = makeService(msPort);
  const msPage = await msService.listAuditLogs(adminContext(), { limit: '2' });
  await assert.rejects(
    () => msService.listAuditLogs(adminContext(), { limit: '2', cursor: msPage.body.data.next_cursor }),
    (error) => expectApiError(error, 'INVALID_CURSOR'),
  );
  assert.equal(msPort.calls.length, 1, '毫秒位置不得进入第二次查询');

  // 端口说「还有下一页」却不给位置 ⇒ 503，绝不发一个空游标把后面的行吞掉。
  const brokenPort = makeFakePort({ items: [a004], hasMore: true, nextPosition: null });
  await assert.rejects(
    () => makeService(brokenPort).listAuditLogs(adminContext(), {}),
    (error) => expectApiError(error, 'PROVIDER_UNAVAILABLE'),
  );
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
  // 闭集外的 entity 依旧 400（⛔ 不是空页）。`post` 在 R64 闭集片里**已经进闭集**，
  // 所以这里换成 `comment`（`TargetRef.type` 里有、但审计 `entity` 维度没有）来保这条钉；
  // `entity=post` 的正例与动作护栏见下一条用例。
  await assert.rejects(
    () => service.listAuditLogs(adminContext(), { entity: 'comment' }),
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

/**
 * 4c. 动作护栏：`entity=post` 只等于 `action='post.hide'`。
 *
 * 为什么「`entity=post` ⇒ `scopes=['sources:write']`」一条不够：`sources:write` 在 `scope` 列上
 * **不专属** —— `0041`/`0046` 的权限行把 `p_scope` 直传进去，授予/撤销 `sources:write` 能力时
 * 落库的正是同一个字面量（`target_ref` 为 `NULL`、`target_hint` 是 `admin_account:<id>`）。
 * 纯 scope 映射会把「某管理员拿到这个能力」混进一个标着 post 的结果集 —— 那不是收窄，是错误命名。
 */
test('GET /admin/audit-logs：动作护栏（entity=post 只等于 post.hide；护栏外 action 400 且零端口调用）', async () => {
  const port = makeFakePort({ hasMore: false });
  const service = makeService(port);

  // ① 只给 `entity=post` ⇒ actions 取护栏清单、scopes 仍取 scope 映射。这是 200 的真页。
  const onlyEntity = await service.listAuditLogs(adminContext(), { entity: 'post' });
  assert.equal(onlyEntity.status, 200);
  assert.deepEqual(port.calls[0].actions, ['post.hide'], 'entity=post 未带 action 时必须自己补上护栏清单');
  assert.deepEqual(port.calls[0].scopes, ['sources:write']);

  // ② 显式写全与 ① 同一个读数（护栏内，放行）。
  await service.listAuditLogs(adminContext(), { entity: 'post', action: 'post.hide' });
  assert.deepEqual(port.calls[1].actions, ['post.hide']);
  assert.deepEqual(port.calls[1].scopes, ['sources:write']);

  // ③ `action=post.hide` 不带 entity ⇒ 不受护栏影响（scopes=null，只看动作维度）。
  await service.listAuditLogs(adminContext(), { action: 'post.hide' });
  assert.deepEqual(port.calls[2].actions, ['post.hide']);
  assert.equal(port.calls[2].scopes, null);

  // ④ 护栏外的**合法** action 与 `entity=post` 组合 ⇒ 400 fail-closed，且**零端口调用**。
  //    ⛔ 不是「交集为空 ⇒ 返回空页」：空页会被读成「平台从未发生过这类操作」。
  //    `admin_scope.grant` 特意入选：它在裸 SQL 下与 `scopes=['sources:write']` **有交集**
  //    （0041 把被授 scope 直传进 `scope` 列），正是这条护栏要挡的错误命名。
  for (const action of ['set_flag', 'admin_scope.grant', 'account.suspend']) {
    await assert.rejects(
      () => service.listAuditLogs(adminContext(), { entity: 'post', action }),
      (error) =>
        expectApiError(error, 'INVALID_REQUEST') &&
        error.details.some((detail) => detail.field === 'action' && detail.code === 'enum'),
      `entity=post&action=${action} 必须 400`,
    );
  }
  assert.equal(port.calls.length, 3, '护栏必须在查询之前拦下，不得触端口');

  // ⑤ 护栏表自洽：键必属 entity 闭集、值非空、每个 action 都属 action 闭集；
  //    没有护栏的实体（今天只剩 admin_scope）必须查回 null —— 「缺席即无护栏」，
  //    而「无护栏」只关掉**动作**维度，`scope` 维度照样收窄（见 4d 用例的 admin_scope 半区）。
  for (const [entity, guard] of Object.entries(AUDIT_ENTITY_ACTION_GUARDS)) {
    assert.ok(AUDIT_ENTITIES.includes(entity), `护栏键 ${entity} 不在 entity 闭集内`);
    assert.ok(Array.isArray(guard) && guard.length > 0, `护栏 ${entity} 不得为空数组（空数组 = 另一种假话：静默全量）`);
    for (const action of guard) {
      assert.ok(AUDIT_ACTIONS.includes(action), `护栏动作 ${action} 不在 action 闭集内`);
    }
    assert.deepEqual(actionsOfAuditEntity(entity), guard);
  }
  assert.deepEqual(actionsOfAuditEntity('post'), [AUDIT_ACTION_POST_HIDE]);
  // R68 · GY-R67-C07：`account` / `job` 与 `post` / `admin_account` 同层，四者都带护栏
  // （理由见 `catalog.ts` 文件头：没有一个 scope 字面量是域专属的，授权行会把 `p_scope` 直传进
  // `scope` 列，于是 `?entity=job` 会混入「授予 jobs:cancel」这类权限变更行）。
  assert.deepEqual(actionsOfAuditEntity('account'), [
    AUDIT_ACTION_ACCOUNT_SUSPEND,
    AUDIT_ACTION_ACCOUNT_RESTORE,
  ]);
  assert.deepEqual(actionsOfAuditEntity('job'), [AUDIT_ACTION_JOB_CANCEL]);
  // `flag` 与 `post` 同形：`flags:write` 也能被授权行写上（授予/撤销该 scope），
  // 故它的护栏同样只放本域动作，⛔ 不再把它当「已知串味、保持原样」的放宽。
  assert.deepEqual(actionsOfAuditEntity('flag'), [AUDIT_ACTION_SET_FLAG]);
  assert.equal(
    actionsOfAuditEntity('admin_scope'),
    null,
    'admin_scope 无护栏是**已登记**的放宽①（scope 维度仍精确匹配，不是「不过滤」），⛔ 别在这里加护栏改协议',
  );

  // ⑥ 契约同源：护栏清单必须能在契约 `action` 枚举里筛得到（否则 `entity=post` 依旧「能看不能筛」），
  //    描述里必须写明护栏语义（否则读者无从判断 400 是设计还是故障）。
  const openapi = JSON.parse(readFileSync('packages/contracts/openapi.json', 'utf8'));
  const operation = openapi.paths['/admin/audit-logs'].get;
  const actionEnum = operation.parameters.find((parameter) => parameter.name === 'action').schema.enum;
  const entityEnum = operation.parameters.find((parameter) => parameter.name === 'entity').schema.enum;
  assert.ok(actionEnum.includes(AUDIT_ACTION_POST_HIDE), '契约 action 枚举漏了 post.hide');
  assert.ok(entityEnum.includes('post'), '契约 entity 枚举漏了 post');
  assert.ok(operation.description.includes('post.hide'), '契约描述必须写明 entity=post 的动作护栏');

  // ⑦ operations.json 的 scope 仍是 `audit:read`（本片不动授权面；⛔ 该文件禁改）。
  const operations = JSON.parse(readFileSync('packages/contracts/operations.json', 'utf8'));
  const listed = operations.operations.find((candidate) => candidate.id === 'listAuditLogs');
  assert.ok(listed, 'operations.json 里找不到 listAuditLogs');
  assert.equal(listed.scope, AUDIT_LOG_SCOPE);

  // ⑧ R68：闭集扩到**十项** + 第 6 个实体 `admin_account` 自带动作护栏。
  //    这两件事是同一枚硬币的两面：`admin_account.*` 的审计行 `scope` 列写的是 `'scopes:write'`
  //    （`0048:286` / `0048:417` 的字面量），与 `admin_scope.*` 共用 ⇒ 不设护栏就会把
  //    权限授予/撤销行命名成「管理员账号被停用」。
  assert.equal(AUDIT_ACTIONS.length, 10, 'action 闭集必须恰好十项（原有 8 + admin_account.disable / .enable）');
  assert.deepEqual([...AUDIT_ENTITIES], ['account', 'flag', 'job', 'admin_scope', 'post', 'admin_account']);
  assert.deepEqual(actionsOfAuditEntity('admin_account'), [
    AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE,
    AUDIT_ACTION_ADMIN_ACCOUNT_ENABLE,
  ]);
  assert.equal(
    scopeOfAuditEntity('admin_account'),
    'scopes:write',
    'admin_account 的行 scope 列是 scopes:write（0048 函数体内写死，不是由调用方传）',
  );
  assert.ok(actionEnum.includes(AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE), '契约 action 枚举漏了 admin_account.disable');
  assert.ok(actionEnum.includes(AUDIT_ACTION_ADMIN_ACCOUNT_ENABLE), '契约 action 枚举漏了 admin_account.enable');
  assert.ok(entityEnum.includes('admin_account'), '契约 entity 枚举漏了 admin_account');
  assert.equal(actionEnum.length, 10, '契约 action 枚举必须与 AUDIT_ACTIONS 同长（十项）');
  assert.equal(entityEnum.length, 6, '契约 entity 枚举必须与 AUDIT_ENTITIES 同长（六项）');

  const callsBeforeGuard = port.calls.length;
  for (const action of ['set_flag', 'admin_scope.grant', 'post.hide']) {
    await assert.rejects(
      () => service.listAuditLogs(adminContext(), { entity: 'admin_account', action }),
      (error) =>
        expectApiError(error, 'INVALID_REQUEST') &&
        error.details.some((detail) => detail.field === 'action' && detail.code === 'enum'),
      `entity=admin_account&action=${action} 必须 400（护栏是语义边界，不静默取交集）`,
    );
  }
  // 反向：`admin_account.*` 在 `entity=post` 下同样被 post 那条护栏挡掉 —— 两条护栏互不串味。
  await assert.rejects(
    () => service.listAuditLogs(adminContext(), { entity: 'post', action: AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE }),
    (error) => expectApiError(error, 'INVALID_REQUEST'),
  );
  assert.equal(port.calls.length, callsBeforeGuard, '四条护栏外请求都必须在查询之前拦下，不得触端口');

  // 正向：`entity=admin_account` 不带 action ⇒ 端口收到护栏清单本身（恰好两个新 action）。
  await service.listAuditLogs(adminContext(), { entity: 'admin_account' });
  assert.deepEqual(
    port.calls.at(-1).actions,
    [AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE, AUDIT_ACTION_ADMIN_ACCOUNT_ENABLE],
    'entity=admin_account 未带 action 时必须自己补上护栏清单',
  );
});

/**
 * 4d. 实体筛选**不得串味**（R68 · GY-R67-C07）。
 *
 * 为什么必须自己造一个「真的按筛选入参过滤」的端口：`makeFakePort` 返回固定页，护栏被摘掉
 * 它照样「通过」—— 那正是这类缺陷能活到 R68 的原因。`?entity=X` 的语义是两个维度的 AND：
 * 「`scope` 列 === `scopeOfAuditEntity(X)`」∧（有护栏的实体）「`action` ∈ `actionsOfAuditEntity(X)`」。
 *
 * 判据来源是库里的真实形状：`0041` 把 `p_scope` 直传进 `scope` 列，所以「授予 `jobs:cancel`」
 * 的**授权行** `scope` 就是 `'jobs:cancel'` —— 与 `job.cancel` 行同一个字面量。那是权限变更，
 * ⛔ 不是作业事件；把它们算进 `?entity=job` 不是收窄，是**错误命名**。
 */
function makeFilteringPort(rows) {
  const calls = [];
  return {
    persistent: true,
    calls,
    async listAuditLogs(filters) {
      calls.push(filters);
      const matched = rows.filter(
        (row) =>
          (filters.actions === null || filters.actions.includes(row.action))
          && (filters.scopes === null || filters.scopes.includes(row.scope)),
      );
      return { items: matched.slice(0, filters.limit ?? 20), hasMore: false, nextPosition: null };
    },
  };
}

/** 一行一个自增 id（形状仍是 uuid，见 `pg.ts` 的 `UUID_RE`）。 */
function c07Row(seq, action, scope) {
  return auditRow({
    id: `c0700000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    action,
    scope,
  });
}

/**
 * 「库里长什么样」：每个实体两组行 —— 域内动作 + `scope` 恰好撞上的授权行。
 * 授权行用 `admin_scope.grant` / `.revoke` / `.deny`（R67 报告里点名的三种）。
 */
const C07_ROWS = [
  // job 族
  c07Row(1, AUDIT_ACTION_JOB_CANCEL, 'jobs:cancel'),
  c07Row(2, AUDIT_ACTION_ADMIN_SCOPE_GRANT, 'jobs:cancel'),
  c07Row(3, AUDIT_ACTION_ADMIN_SCOPE_REVOKE, 'jobs:cancel'),
  c07Row(4, AUDIT_ACTION_ADMIN_SCOPE_DENY, 'jobs:cancel'),
  // account 族
  c07Row(5, AUDIT_ACTION_ACCOUNT_SUSPEND, 'accounts:suspend'),
  c07Row(6, AUDIT_ACTION_ACCOUNT_RESTORE, 'accounts:suspend'),
  c07Row(7, AUDIT_ACTION_ADMIN_SCOPE_GRANT, 'accounts:suspend'),
  // post 族（回归）
  c07Row(8, AUDIT_ACTION_POST_HIDE, 'sources:write'),
  c07Row(9, AUDIT_ACTION_ADMIN_SCOPE_GRANT, 'sources:write'),
  // admin_account 族（回归）
  c07Row(10, AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE, 'scopes:write'),
  c07Row(11, AUDIT_ACTION_ADMIN_SCOPE_GRANT, 'scopes:write'),
  // flag 族（R68 收口：`flags:write` 与授权行共用，但 flag 也有护栏了）
  c07Row(12, AUDIT_ACTION_SET_FLAG, 'flags:write'),
  c07Row(13, AUDIT_ACTION_ADMIN_SCOPE_GRANT, 'flags:write'),
  // admin_scope 族（**无护栏** 的放宽①）：授权行本身就是这个实体的动作，必须仍然看得见
  c07Row(14, AUDIT_ACTION_ADMIN_SCOPE_REVOKE, 'scopes:write'),
  c07Row(15, AUDIT_ACTION_ADMIN_SCOPE_DENY, 'scopes:write'),
];

test('GET /admin/audit-logs：entity 筛选不串味（job/account/flag 不吞授权行；post/admin_account 回归）', async () => {
  const port = makeFilteringPort(C07_ROWS);
  const service = makeService(port);
  const actionsOf = async (entity) => {
    const response = await service.listAuditLogs(adminContext(), { entity });
    return response.body.data.items.map((item) => item.action);
  };

  // ① `?entity=job` 只含作业取消，**不含**任何 `admin_scope.*`（那三行的 scope 恰好是 jobs:cancel）。
  const jobActions = await actionsOf('job');
  assert.deepEqual(jobActions, [AUDIT_ACTION_JOB_CANCEL], 'entity=job 只该看到 job.cancel 行');
  assert.ok(
    jobActions.every((action) => !action.startsWith('admin_scope.')),
    `entity=job 的结果里混进了授权行：${JSON.stringify(jobActions)}`,
  );
  assert.deepEqual(port.calls.at(-1).actions, [AUDIT_ACTION_JOB_CANCEL]);
  assert.deepEqual(port.calls.at(-1).scopes, ['jobs:cancel'], 'scope 维度必须仍然收窄（⛔ 不是 null）');

  // ② `?entity=account` 同理：停用/恢复都在，授权行不在。
  const accountActions = await actionsOf('account');
  assert.deepEqual(accountActions, [AUDIT_ACTION_ACCOUNT_SUSPEND, AUDIT_ACTION_ACCOUNT_RESTORE]);
  assert.ok(
    accountActions.every((action) => !action.startsWith('admin_scope.')),
    `entity=account 的结果里混进了授权行：${JSON.stringify(accountActions)}`,
  );
  assert.deepEqual(port.calls.at(-1).actions, [
    AUDIT_ACTION_ACCOUNT_SUSPEND,
    AUDIT_ACTION_ACCOUNT_RESTORE,
  ]);
  assert.deepEqual(port.calls.at(-1).scopes, ['accounts:suspend']);

  // ③ 回归：post / admin_account 两条既有护栏行为不变（`scopes` 仍取映射值）。
  assert.deepEqual(await actionsOf('post'), [AUDIT_ACTION_POST_HIDE]);
  assert.deepEqual(await actionsOf('admin_account'), [AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE]);

  // ④ `?entity=flag` 也收口了：`flags:write` 与授权行共用同一个 scope 字面量，但护栏把
  //    授权行挡在外面 —— 只该看到 `set_flag`。⛔ 不许退回「只按 scope 匹配」的串味读数
  //    （那样 grant 行会跟着 `flags:write` 一起进来）。
  const flagActions = await actionsOf('flag');
  assert.deepEqual(flagActions, [AUDIT_ACTION_SET_FLAG], 'entity=flag 只该看到 set_flag 行');
  assert.ok(
    flagActions.every((action) => !action.startsWith('admin_scope.')),
    `entity=flag 的结果里混进了授权行：${JSON.stringify(flagActions)}`,
  );
  assert.deepEqual(port.calls.at(-1).actions, [AUDIT_ACTION_SET_FLAG]);
  assert.deepEqual(port.calls.at(-1).scopes, ['flags:write']);

  // ④b 收口 `flag` **没有**把授权面的可观测性一起吞掉：`?entity=admin_scope` 仍看得到
  //     grant / revoke / deny 三类授权行（它按 `scope='scopes:write'` 收窄，无护栏）。
  //     ⚠ 同一条读数里还有 `admin_account.disable` —— 那是**已登记**的放宽①（`0048` 之后
  //     `scopes:write` 被两类行共用，`admin_scope` 故意不加护栏），不是本片新增的串味。
  const adminScopeActions = await actionsOf('admin_scope');
  assert.deepEqual(
    adminScopeActions.filter((action) => action.startsWith('admin_scope.')),
    [AUDIT_ACTION_ADMIN_SCOPE_GRANT, AUDIT_ACTION_ADMIN_SCOPE_REVOKE, AUDIT_ACTION_ADMIN_SCOPE_DENY],
    'entity=admin_scope 必须仍然看得全三类授权行（收口 flag 不得牵连授权面可观测性）',
  );
  assert.deepEqual(adminScopeActions, [
    AUDIT_ACTION_ADMIN_ACCOUNT_DISABLE,
    AUDIT_ACTION_ADMIN_SCOPE_GRANT,
    AUDIT_ACTION_ADMIN_SCOPE_REVOKE,
    AUDIT_ACTION_ADMIN_SCOPE_DENY,
  ]);
  assert.ok(
    !adminScopeActions.includes(AUDIT_ACTION_SET_FLAG),
    'entity=admin_scope 与 entity=flag 互不吞行：set_flag 行不得出现在 admin_scope 的结果里',
  );
  assert.deepEqual(port.calls.at(-1).actions, null, 'admin_scope 无护栏 ⇒ actions 维度不下传');
  assert.deepEqual(port.calls.at(-1).scopes, ['scopes:write'], 'admin_scope 仍按 scope 收窄（⛔ 不是 null）');

  // ⑤ 未知 entity ⇒ 400 且**零端口调用**。⛔ 不是空页（空页会被读成「平台从未发生过」），
  //    更⛔ 不是全量 —— 它连查询都没发出去。
  const callsBefore = port.calls.length;
  await assert.rejects(
    () => service.listAuditLogs(adminContext(), { entity: 'nope' }),
    (error) =>
      expectApiError(error, 'INVALID_REQUEST')
      && error.details.some((detail) => detail.field === 'entity' && detail.code === 'enum'),
    'entity=nope 必须 400（不是空页、更不是全量）',
  );
  assert.equal(port.calls.length, callsBefore, '未知 entity 必须在查询之前拦下，不得触端口');

  // ⑥ 护栏是语义边界：`entity=job|account` 配护栏外的**合法** action ⇒ 400，
  //    而不是「交集为空 ⇒ 返回空页」（那会把 R67 的串味改写成另一种假话）。
  for (const [entity, action] of [
    ['job', AUDIT_ACTION_ADMIN_SCOPE_GRANT],
    ['account', AUDIT_ACTION_ADMIN_SCOPE_DENY],
  ]) {
    await assert.rejects(
      () => service.listAuditLogs(adminContext(), { entity, action }),
      (error) =>
        expectApiError(error, 'INVALID_REQUEST')
        && error.details.some((detail) => detail.field === 'action' && detail.code === 'enum'),
      `entity=${entity}&action=${action} 必须 400`,
    );
  }
  assert.equal(port.calls.length, callsBefore, '护栏外组合必须在查询之前拦下，不得触端口');
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
    cursor_position: '2026-10-20T10:00:00.000000Z',
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

/**
 * 5b. **读数形状按 action 分派**（P0 回归钉子：`admin_scope.grant` 整页 503）。
 *
 * 缺陷形态：读数解码曾对**每一行**无条件按 `{enabled, revision}` 严格校验，而迁移 0041 的
 * `admin_scope.grant` / `admin_scope.revoke` 行写的是 `jsonb_build_object('scopes', …, 'reason', …)`
 * （`0041_admin_scope_write_authority.sql:326-327` / `:479-480`）⇒ 结果集里只要出现一条这类行，
 * 整页 503 `PROVIDER_UNAVAILABLE`（读函数 `0033_admin_audit_log_read.sql:96-107` 没有形状过滤）。
 *
 * 期望：**非开关动作**的非 null 读数如实返回 `null`（契约 `before_value`/`after_value` 的类型是
 * `FlagReading`，`{scopes, reason}` 不在今天的读面上 —— 等「契约扩展」片再暴露），其余字段原样透出；
 * 同一响应里的 `set_flag` 行**仍然**带着 `{enabled, revision}`；`set_flag` 行形状不符**仍然 503**。
 */
test('GET /admin/audit-logs：读数按 action 分派（admin_scope.grant 如实 null，set_flag 仍严格）', async () => {
  // 端口拿到的就是**库里的原始行**（`actor_id` 列、jsonb 读数、微秒游标列）。
  const rawGrantRow = {
    id: UUIDS[0],
    actor_id: ADMIN_ID,
    action: 'admin_scope.grant',
    scope: 'scopes:write',
    target_ref: null,
    target_hint: `admin:${OTHER_ADMIN_ID}`,
    reason_code: 'admin_scope_granted',
    request_id: UUIDS[1],
    result: 'accepted',
    before_value: { scopes: [], reason: 'x' },
    after_value: { scopes: ['sources:write'], reason: 'x' },
    created_at: new Date('2026-10-24T10:00:00.000Z'),
    cursor_position: '2026-10-24T10:00:00.000000Z',
  };
  const rawFlagRow = {
    id: UUIDS[2],
    actor_id: ADMIN_ID,
    action: 'set_flag',
    scope: 'flags:write',
    target_ref: null,
    target_hint: 'community.posts.hide',
    reason_code: 'manual_takedown',
    request_id: UUIDS[1],
    result: 'accepted',
    before_value: { enabled: false, revision: 3 },
    after_value: { enabled: true, revision: 4 },
    created_at: new Date('2026-10-24T09:00:00.000Z'),
    cursor_position: '2026-10-24T09:00:00.000000Z',
  };
  const pool = {
    async query() {
      return { rows: [rawGrantRow, rawFlagRow] };
    },
  };
  const service = makeService(createPostgresAdminAuditLogPort({ pool }));
  const response = await service.listAuditLogs(adminContext());

  assert.equal(response.status, 200, '结果集里有 admin_scope.grant 行时整页必须 200（改前整页 503）');
  const [grant, flag] = response.body.data.items;
  // 该行：读数如实 null，其余字段原样透出。
  assert.deepEqual(grant, {
    id: UUIDS[0],
    action: 'admin_scope.grant',
    scope: 'scopes:write',
    target_ref: null,
    reason_code: 'admin_scope_granted',
    request_id: UUIDS[1],
    result: 'accepted',
    created_at: '2026-10-24T10:00:00.000Z',
    actor: ADMIN_ID,
    target_hint: `admin:${OTHER_ADMIN_ID}`,
    before_value: null,
    after_value: null,
  }, '非开关动作的 before_value/after_value 必须如实为 null（⛔ 不 503、⛔ 不伪造读数），其余字段原样透出');
  // 同一响应里的开关行：读数必须**仍然**在（证明不是整体抹掉）。
  assert.deepEqual(flag.before_value, { enabled: false, revision: 3 }, 'set_flag 行必须保留 before_value 读数');
  assert.deepEqual(flag.after_value, { enabled: true, revision: 4 }, 'set_flag 行必须保留 after_value 读数');

  // 负向对照：分派 ≠ 放宽 —— `set_flag` 行的读数形状不符时**仍然 503**。
  const badFlagPool = {
    async query() {
      return { rows: [{ ...rawFlagRow, before_value: { scopes: [], reason: 'x' } }] };
    },
  };
  await assert.rejects(
    () => makeService(createPostgresAdminAuditLogPort({ pool: badFlagPool })).listAuditLogs(adminContext()),
    (error) =>
      expectApiError(error, 'PROVIDER_UNAVAILABLE') &&
      error.status === 503 &&
      error.message.includes('读数形状不符'),
  );
});

/**
 * 5b. 读数语义表与动作闭集的**双向钉子**：`Object.keys(AUDIT_READING_KIND)` 必须与 `AUDIT_ACTIONS`
 * 逐项相等（值相同、顺序相同、无重复、无多余）。
 *
 * 为什么需要运行时钉子：`Record<AdminAuditAction, …>` 只保证闭集里的动作**不漏**（新增动作时 tsc 报缺项），
 * 但它挡不住「表里多出一个闭集外的键」（构造方式一旦不是字面量，excess property 检查就不生效）。
 * 将来在 `AUDIT_ACTIONS` 里加 `admin_account.disable/enable`（R68）时，
 * 这条钉子会立刻红，提醒作者补声明「这个动作有没有开关读数」。
 *
 * 2026-10-27 更新：`post.hide` 已随 #659 进闭集（第 8 值），本片为它补了 `'unexposed'` 声明；
 * 因此「多出一个闭集外的键」的牙齿改用**尚未进闭集**的 `post.approve` 作替身。
 */
test('GET /admin/audit-logs：读数语义表与动作闭集逐项相等（不漏、不多、同序）', () => {
  assert.ok(Object.isFrozen(AUDIT_READING_KIND), '映射必须是冻结对象（运行时不可被改写）');
  assert.deepEqual(
    Object.keys(AUDIT_READING_KIND),
    [...AUDIT_ACTIONS],
    'AUDIT_READING_KIND 的键必须与 AUDIT_ACTIONS 同值同序：新增动作时请在这里补一行声明',
  );

  // 牙齿：多一个闭集外的键（这里用尚未进闭集的 `post.approve` 作替身）必须被这条判据抓住。
  const withExtraKey = { ...AUDIT_READING_KIND, 'post.approve': 'unexposed' };
  assert.notDeepEqual(
    Object.keys(withExtraKey),
    [...AUDIT_ACTIONS],
    '多出一个闭集外的键时判据必须红（否则这条钉子没有牙齿）',
  );

  // 语义本身：今天只有 `set_flag` 走开关读数，其余一律 unexposed（含闭集外动作的回落）。
  assert.deepEqual(
    AUDIT_ACTIONS.filter((action) => readingKindOf(action) === 'flag_reading'),
    ['set_flag'],
    '今天只有 set_flag 带开关读数；新增动作若也写读数，必须同时改契约 FlagReading 或另开「契约扩展」片',
  );
  assert.equal(readingKindOf('post.hide'), 'unexposed', 'post.hide（0047 写 NULL）应当是 unexposed');
  assert.equal(readingKindOf('post.approve'), 'unexposed', '闭集外动作回落 unexposed（不猜形状）');
});

/** 6. PG 适配器：七参数显式转型、键集语义、hasMore 来自 limit+1。 */
test('GET /admin/audit-logs：PG 适配器（参数化 SQL、limit+1 判 hasMore、行投影）', async () => {
  const queries = [];
  const rows = [
    {
      ...auditRow({ id: UUIDS[0], created_at: new Date('2026-10-20T10:00:02.000Z') }),
      ip: '10.0.0.1',
      cursor_position: '2026-10-20T10:00:02.000123Z',
    },
    {
      ...auditRow({ id: UUIDS[1], created_at: '2026-10-20T10:00:01.000Z' }),
      cursor_position: '2026-10-20T10:00:01.000456Z',
    },
    {
      ...auditRow({ id: UUIDS[2], created_at: '2026-10-20T10:00:00.000Z' }),
      cursor_position: '2026-10-20T10:00:00.000789Z',
    },
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
    before: { createdAt: '2026-10-21T00:00:00.000000Z', id: UUIDS[2] },
  });

  assert.equal(queries.length, 1);
  const [{ text, values }] = queries;
  assert.ok(text.includes('FROM public.list_admin_audit_logs('), '只能经只读函数读，不得直接 SELECT 表');
  assert.ok(!text.includes('admin_audit_events'), '运行时不得直接查审计表');
  assert.ok(text.includes('AS cursor_position'), '必须另取微秒位置列（毫秒 created_at 不能当游标位置）');
  assert.deepEqual(values, [
    3,
    '2026-10-01T00:00:00.000Z',
    null,
    ['set_flag'],
    null,
    '2026-10-21T00:00:00.000000Z',
    UUIDS[2],
  ]);
  assert.equal(page.hasMore, true, 'limit+1 行 ⇒ hasMore');
  assert.equal(page.items.length, 2, '返回行数必须被截回 limit');
  assert.equal(page.items[0].created_at, '2026-10-20T10:00:02.000Z');
  assert.ok(!('ip' in page.items[0]));
  assert.ok(!('cursor_position' in page.items[0]), '游标位置列不得进契约条目');
  assert.deepEqual(
    page.nextPosition,
    { createdAt: '2026-10-20T10:00:01.000456Z', id: UUIDS[1] },
    'nextPosition 取「本页最后一行」的微秒位置',
  );

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

  // 库/驱动没给微秒位置列 ⇒ 503（fail-closed）：⛔ 不退化成毫秒位置继续翻页（那会漏行）。
  const noPositionPool = {
    async query() {
      return {
        rows: [
          { ...auditRow({ id: UUIDS[0], created_at: '2026-10-20T10:00:02.000Z' }) },
          { ...auditRow({ id: UUIDS[1], created_at: '2026-10-20T10:00:01.000Z' }) },
        ],
      };
    },
  };
  await assert.rejects(
    () =>
      createPostgresAdminAuditLogPort({ pool: noPositionPool }).listAuditLogs({
        limit: 1,
        from: null,
        to: null,
        actions: null,
        scopes: null,
        before: null,
      }),
    (error) => expectApiError(error, 'PROVIDER_UNAVAILABLE'),
  );
});
