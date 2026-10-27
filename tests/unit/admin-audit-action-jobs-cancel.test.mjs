/**
 * `GET /admin/audit-logs?action=job.cancel` —— **审计动作闭集漂移**的回归用例（GY-R59）。
 *
 * ## 这一片修的是什么
 * `#589` 的迁移 `services/api/db/migrations/0043_admin_job_cancel_audit.sql:168-175` 已经往
 * `public.admin_audit_events` 写 `action='job.cancel'` / `scope='jobs:cancel'`，但
 * `services/api/src/admin/audit/catalog.ts` 的 `AUDIT_ACTIONS` 闭集仍只有 3 项。
 * 于是审计读面出现「**能看见、不能筛**」：全量翻页能翻到这些行，`?action=job.cancel` 一律
 * 400 `INVALID_REQUEST`。本文件钉住修复后的行为，而不是只钉住"数组长度变成 4"。
 *
 * ## 为什么用假端口而不是只读闭集
 * 只断言 `AUDIT_ACTIONS.includes('job.cancel')` 证明不了读面能用：闭集被读的地方在
 * `service.ts:121-132` 的 `parseActionParam`，而它一旦放行，值会经 `actions: [action]`
 * 下传给端口。所以这里用一个**按 SQL 语义过滤**的假端口（真库臂 `list_admin_audit_logs`
 * 的 `$4::text[]` 分支就是这个行为），正向证明「200 + 只剩该动作的行 + 入参真的是
 * `['job.cancel']`」，反向证明「未知动作仍 400，且**一次都不查库**」。
 *
 * ⛔ 反向控制（`action=not.an.action`）不是凑数：闭集如果被改成"什么都不拒"，
 * 正向用例会照样绿，只有反向用例能把它抓住。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  AUDIT_ENTITY_SCOPES,
  scopeOfAuditEntity,
} from '../../services/api/src/admin/audit/catalog.ts';
import { createAdminAuditLogService } from '../../services/api/src/admin/audit/service.ts';
import { ApiError } from '../../services/api/src/errors.ts';

const ADMIN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REQUEST_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const JOB_ID = '55555555-5555-4555-8555-555555555555';
const SIGNING_KEY = 'gy-r59-audit-action-jobs-cancel-signing-key';

/** 管理者上下文：`audit:read` 是本读面唯一的权限门（`catalog.AUDIT_LOG_SCOPE`）。 */
function adminContext() {
  return {
    identity: { userId: ADMIN_ID, authEpoch: 1, role: 'admin', scopes: ['audit:read'] },
    requestId: REQUEST_ID,
  };
}

/**
 * 一行契约 `AuditEvent`（端口出口形状，字段恰好是 `additionalProperties:false` 允许的那 12 个）。
 *
 * `job.cancel` 的 `target_ref` 用 `type:'job'`：`TargetRef.type` 的 17 项闭集里已有 `job`
 * （`packages/contracts/openapi.json` 的 `TargetRef`，与 0043 `:176` 的 `jsonb_build_object`
 * 一致），所以这一行能过服务层出口的契约镜像。
 */
function auditRow(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    action: 'set_flag',
    scope: 'flags:write',
    target_ref: null,
    target_hint: 'herbicide_output',
    reason_code: 'admin_set_flag',
    request_id: '22222222-2222-4222-8222-222222222222',
    result: 'accepted',
    created_at: '2026-10-20T10:00:00.000Z',
    actor: ADMIN_ID,
    before_value: null,
    after_value: null,
    ...overrides,
  };
}

/** `job.cancel` 的审计行（0043 `:168-181` 写出来的形状）。 */
const JOB_CANCEL_ROW = auditRow({
  id: '33333333-3333-4333-8333-333333333333',
  action: 'job.cancel',
  scope: 'jobs:cancel',
  target_ref: { type: 'job', id: JOB_ID, revision: 2 },
  target_hint: null,
  reason_code: 'admin_job_cancel',
  request_id: '44444444-4444-4444-8444-444444444444',
  created_at: '2026-10-22T08:00:00.000Z',
  before_value: null,
  after_value: null,
});

/** 另外两类的行：用来证明 `action=job.cancel` 是**真过滤**，不是"整页原样返回"。 */
const OTHER_ROWS = [
  auditRow(),
  auditRow({
    id: '66666666-6666-4666-8666-666666666666',
    action: 'account.suspend',
    scope: 'accounts:suspend',
    reason_code: 'account_suspended',
    request_id: '77777777-7777-4777-8777-777777777777',
    created_at: '2026-10-21T09:00:00.000Z',
    target_hint: 'account:demo',
  }),
];

/**
 * 假只读端口：按 `actions` / `scopes` 过滤，**语义与迁移 0033 的
 * `list_admin_audit_logs($4::text[], $5::text[])` 一致**（`null` ⇒ 该维不筛）。
 *
 * 记录每次入参：正向用例要证明下发到端口的就是 `['job.cancel']`；
 * 反向用例要证明 400 发生在**查库之前**（`calls.length === 0`）。
 */
function makeFakePort(seed = [JOB_CANCEL_ROW, ...OTHER_ROWS]) {
  const calls = [];
  return {
    persistent: true,
    calls,
    async listAuditLogs(filters) {
      calls.push(filters);
      const items = seed.filter(
        (row) =>
          (filters.actions === null || filters.actions.includes(row.action)) &&
          (filters.scopes === null || filters.scopes.includes(row.scope)),
      );
      return { items, hasMore: false, nextPosition: null };
    },
  };
}

function makeService(port) {
  return createAdminAuditLogService({ port, signingKey: SIGNING_KEY, executionMode: 'real' });
}

/** 断言 `ApiError` 的形状；**必须返回 `true`**——它同时被当作 `assert.rejects` 的校验函数用。 */
function expectApiError(error, code, status) {
  assert.ok(error instanceof ApiError, `应为 ApiError，实际 ${String(error)}`);
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status, `HTTP 状态应为 ${status}`);
  return true;
}

// ---------------------------------------------------------------------------
// (a) 闭集本身：第 4 个动作进闭集，既有 3 项顺序不变（仍是有序闭集）
// ---------------------------------------------------------------------------
test('(a) AUDIT_ACTIONS 闭集含 `job.cancel`，既有 3 项顺序不变', () => {
  // 顺序有语义：闭集是「谁在写 admin_audit_events」的镜像，历史 3 项不许被重排／改名，
  // 否则历史审计行的 `action` 列与查询参数就对不上了。
  assert.deepEqual([...AUDIT_ACTIONS].slice(0, 4), ['account.suspend', 'account.restore', 'set_flag', 'job.cancel']);
  assert.ok(AUDIT_ACTIONS.includes('job.cancel'), '`job.cancel` 必须在闭集内（0043 写入的动作）');
  // `entity=job` 映射到 0043 实际写的 `scope` 值：`jobs:cancel`，**不是** `jobs:read`。
  assert.equal(AUDIT_ENTITY_SCOPES.job, 'jobs:cancel');
  assert.equal(scopeOfAuditEntity('job'), 'jobs:cancel');
  assert.ok(AUDIT_ENTITIES.includes('job'), '`job` 必须在 entity 闭集内（否则 ?entity=job 也是 400）');
});

// (d) 长度单列一条：闭集被"顺手加一项却没写写入点"时，至少这里和契约用例会同时响。
test('(d) 前 4 项长度仍为 4（第 4 项 = 0043 的 job.cancel）；后续扩值只能追加在末位', () => {
  // GY-R64（#18 S2 PR-4）把闭集扩到 7 项（0041 的 grant/revoke + 0046 的 deny），
  // 同轮的读面闭集片再追加第 8 项 `post.hide`（0047 的下架审计）——
  // 本条钉子收敛为「前 4 项及顺序不变」：那 4 项对应的库内写入点一个字都没动。
  assert.equal([...AUDIT_ACTIONS].slice(0, 4).length, 4);
  assert.equal(AUDIT_ACTIONS[3], 'job.cancel');
  // entity 闭集同步到 6 项（读面闭集片追加 `post`；R68 追加 `admin_account`，它复用 `scopes:write`
  // 这一 scope 值，故下面排序后两个 `scopes:write` 并列）；`Object.values` 排序后逐值比对，防"改错映射值"。
  assert.deepEqual(Object.values(AUDIT_ENTITY_SCOPES).sort(), [
    'accounts:suspend',
    'flags:write',
    'jobs:cancel',
    'scopes:write',
    'scopes:write',
    'sources:write',
  ]);
});

// ---------------------------------------------------------------------------
// (b) 行为：`action=job.cancel` ⇒ 200，且只含该动作的行（修复前这里抛 400）
// ---------------------------------------------------------------------------
test('(b) `action=job.cancel` ⇒ 200，只返回该动作的行，且过滤值真的下发到端口', async () => {
  const port = makeFakePort();
  const service = makeService(port);

  const response = await service.listAuditLogs(adminContext(), { action: 'job.cancel' });

  // 修复前：`parseActionParam` 在 `!AUDIT_ACTIONS.includes('job.cancel')` 处抛 400，压根到不了端口。
  assert.equal(response.status, 200, '`job.cancel` 是闭集成员 ⇒ 必须是 200，不再是 400');
  assert.equal(port.calls.length, 1, '应恰好查询一次');

  // 筛选确实下传：不是"闭集放行但丢掉筛选条件"（那样会把全部动作都返回）。
  assert.deepEqual(port.calls[0].actions, ['job.cancel']);
  assert.equal(port.calls[0].scopes, null, '只给 action 时不得凭空加 scope 过滤');

  const { items } = response.body.data;
  assert.equal(items.length, 1, '假库里有 3 行（job.cancel / set_flag / account.suspend），只应回来 1 行');
  assert.deepEqual(
    items.map((item) => item.action),
    ['job.cancel'],
    '返回行的 action 必须全是 `job.cancel`（证明是真过滤，不是整页原样返回）',
  );
  // 0043 同时写死 scope=jobs:cancel：读面必须原样回显它，否则后台 UI 无法把行归到作业域。
  assert.equal(items[0].scope, 'jobs:cancel');
  assert.deepEqual(items[0].target_ref, { type: 'job', id: JOB_ID, revision: 2 });
  assert.equal(response.body.data.next_cursor, null);
});

test('(b2) `action=job.cancel&entity=job` ⇒ 200，两个维度都落到 `jobs:cancel`', async () => {
  const port = makeFakePort();
  const service = makeService(port);

  const response = await service.listAuditLogs(adminContext(), { action: 'job.cancel', entity: 'job' });

  assert.equal(response.status, 200);
  assert.deepEqual(port.calls[0].actions, ['job.cancel']);
  assert.deepEqual(port.calls[0].scopes, ['jobs:cancel'], 'entity=job 必须解析成 0043 写的那个 scope 值');
  assert.deepEqual(response.body.data.items.map((item) => item.action), ['job.cancel']);
});

test('(b3) 不筛 action 时 `job.cancel` 行同样在结果里（读面本来"看得见"，本片修的是"能筛"）', async () => {
  const port = makeFakePort();
  const response = await makeService(port).listAuditLogs(adminContext(), {});

  assert.equal(response.status, 200);
  assert.equal(port.calls[0].actions, null, '不筛 ⇒ 入参必须是 null，不是空数组');
  assert.deepEqual(
    response.body.data.items.map((item) => item.action).sort(),
    ['account.suspend', 'job.cancel', 'set_flag'],
  );
});

// ---------------------------------------------------------------------------
// (c) 反向控制：未知动作仍然 400，且**一次都不查库**
// ---------------------------------------------------------------------------
test('(c) 反向控制：`action=not.an.action` ⇒ 400 INVALID_REQUEST，零端口调用', async () => {
  const port = makeFakePort();
  const service = makeService(port);

  await assert.rejects(
    () => service.listAuditLogs(adminContext(), { action: 'not.an.action' }),
    (error) =>
      expectApiError(error, 'INVALID_REQUEST', 400) &&
      error.details.some((detail) => detail.field === 'action' && detail.code === 'enum'),
  );
  // 闭集是**入口**闸门：400 必须在查库之前发生（否则非法值会变成一次真查询）。
  assert.equal(port.calls.length, 0, '非法 action 不得触达端口');

  // 报错文案要把新的闭集列全：运维照文案排错时，缺 `job.cancel` 会让他们以为这个动作不存在。
  const message = await service
    .listAuditLogs(adminContext(), { action: 'job.cancel.nope' })
    .then(() => null)
    .catch((error) => error.message);
  assert.ok(message !== null, '未知动作必须抛错');
  for (const action of AUDIT_ACTIONS) {
    assert.ok(message.includes(action), `400 文案必须列出闭集成员 ${action}，实际：${message}`);
  }
  assert.equal(port.calls.length, 0);
});

test('(c2) 反向控制：`entity` 收的是域名词，原始 scope 串仍 400', async () => {
  const port = makeFakePort();
  const service = makeService(port);

  // `entity` 的闭集是「域名词」（account / flag / job），不是库内 scope 串。
  // 这条断言把本片那个设计选择钉住：提交 `jobs:cancel` 的人会得到 400，而不是一个静默空页。
  await assert.rejects(
    () => service.listAuditLogs(adminContext(), { entity: 'jobs:cancel' }),
    (error) =>
      expectApiError(error, 'INVALID_REQUEST', 400) &&
      error.details.some((detail) => detail.field === 'entity' && detail.code === 'enum'),
  );
  assert.equal(port.calls.length, 0);
});
