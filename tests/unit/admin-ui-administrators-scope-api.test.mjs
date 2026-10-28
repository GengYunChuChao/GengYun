/**
 * R68 · 管理员 scope「授权／撤销」写面（`lib/administrator-scope-api.mjs` + `lib/admin-scope-catalog.mjs`）。
 *
 * 这一层证明三件事：
 *  1. scope 闭集**派生自契约** `packages/contracts/openapi.json` 的 `AdminScope.enum`，不是手抄；
 *  2. 契约闭集外的 scope 在**本地**就被拦掉（一个字节都不发出去）；
 *  3. 请求形状（URL / method / If-Match / Idempotency-Key / body）与错误码映射和停用／恢复同一条路。
 *
 * 渲染级（「页面到底有没有真的发请求」）另见
 * `tests/unit/admin-ui-administrators-scope-write-render.test.mjs`。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_SCOPE_CONTRACT_PATH,
  ADMIN_SCOPE_LABELS,
  ADMIN_SCOPE_OPTIONS,
  ADMIN_SCOPE_SCHEMA_NAME,
  ADMIN_SCOPES,
  isKnownAdminScope,
  scopeProblem,
} from '../../apps/admin/src/lib/admin-scope-catalog.mjs';
import {
  ADMINISTRATOR_SCOPE_MODES,
  ADMINISTRATOR_SCOPE_MODE_LABELS,
  ADMINISTRATOR_SCOPE_WRITE_SCOPE,
  ADMIN_SCOPE_COUNT,
  buildAdministratorScopeGrantUrl,
  buildAdministratorScopeRevokeUrl,
  canWriteAdministratorScope,
  classifyAdministratorScopeFailure,
  describeAdministratorScopeFailure,
  grantAdministratorScope,
  revokeAdministratorScope,
  validateAdministratorScopeWriteView,
} from '../../apps/admin/src/lib/administrator-scope-api.mjs';

const BASE = '/api/v1';
const TOKEN = 'synthetic-admin-token';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const KEY = 'administrator-0123456789abcdef0123456789abcdef';
const REASON = '按排班调整值班权限';

const CONTRACT_PATH = fileURLToPath(new URL('../../packages/contracts/openapi.json', import.meta.url));
const CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
const CONTRACT_ENUM = CONTRACT.components.schemas.AdminScope.enum;

const meta = { request_id: REQUEST_ID, contract_version: '1.0.0', execution_mode: 'stub' };

function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

function brokenJsonResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => {
      throw new SyntaxError('not json');
    },
  };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init });
  };
  impl.calls = calls;
  return impl;
}

function scopeWriteView(overrides = {}) {
  return { id: ADMIN_ID, revision: 2, scopes: ['audit:read', 'scopes:read'], changed: true, ...overrides };
}

function writeEnvelope(data = scopeWriteView()) {
  return { data, meta };
}

function errorBody(code, message, retryable = false, details = []) {
  return { error: { code, message, retryable, details }, meta };
}

function grantInput(overrides = {}) {
  return {
    fetchImpl: undefined,
    baseUrl: BASE,
    token: TOKEN,
    administratorId: ADMIN_ID,
    scope: 'audit:read',
    revision: 1,
    reason: REASON,
    idempotencyKey: KEY,
    ...overrides,
  };
}

function revokeInput(overrides = {}) {
  return grantInput(overrides);
}

async function withFetch(fetchImpl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------- 闭集派生自契约

test('scope 闭集派生自契约：ADMIN_SCOPES 与 AdminScope.enum 同序逐项相等，且冻结', () => {
  assert.equal(ADMIN_SCOPE_CONTRACT_PATH, 'packages/contracts/openapi.json');
  assert.equal(ADMIN_SCOPE_SCHEMA_NAME, 'AdminScope');
  assert.ok(Array.isArray(CONTRACT_ENUM) && CONTRACT_ENUM.length > 0, '契约里必须有 AdminScope.enum');
  assert.deepEqual([...ADMIN_SCOPES], [...CONTRACT_ENUM], '本地闭集必须与契约 enum 完全一致（顺序也一致）');
  assert.equal(ADMIN_SCOPE_COUNT, CONTRACT_ENUM.length);
  assert.ok(Object.isFrozen(ADMIN_SCOPES), '闭集必须冻结，避免运行时被就地改掉');
  assert.ok(!ADMIN_SCOPES.includes(''), '闭集里不允许空串');
  assert.equal(new Set(ADMIN_SCOPES).size, ADMIN_SCOPES.length, '闭集里不允许重复项');
});

test('闭集不是手抄：目录模块按代码从契约 JSON 派生（⛔ 不许出现第二份硬编码数组）', () => {
  const catalogSource = readFileSync(
    fileURLToPath(new URL('../../apps/admin/src/lib/admin-scope-catalog.mjs', import.meta.url)),
    'utf8',
  );
  assert.match(catalogSource, /packages\/contracts\/openapi\.json/, '必须 import 契约 JSON');
  assert.match(catalogSource, /with\s*\{\s*type:\s*'json'\s*\}/, 'JSON 必须用 import attributes 载入');
  assert.match(catalogSource, /ADMIN_SCOPES\s*=\s*readAdminScopeEnum\(/, '闭集必须由 readAdminScopeEnum() 从契约算出');
  // 反向钉子：一旦有人把 13 项写回数组字面量，这条就红。
  assert.doesNotMatch(
    catalogSource,
    /\[\s*'accounts:read'\s*,\s*'accounts:suspend'/,
    '目录模块里不得再出现手抄的 scope 数组',
  );
});

test('标签覆盖闭集：一项不多、一项不少，值都是非空中文', () => {
  assert.deepEqual(Object.keys(ADMIN_SCOPE_LABELS).sort(), [...CONTRACT_ENUM].sort(), '标签必须恰好覆盖闭集');
  for (const scope of CONTRACT_ENUM) {
    const label = ADMIN_SCOPE_LABELS[scope];
    assert.equal(typeof label, 'string');
    assert.notEqual(label.trim(), '', `${scope} 必须有可读标签`);
  }
});

test('选择器选项：与契约闭集同序，每项 {value,label} 且冻结', () => {
  assert.equal(ADMIN_SCOPE_OPTIONS.length, CONTRACT_ENUM.length);
  assert.deepEqual(ADMIN_SCOPE_OPTIONS.map((option) => option.value), [...CONTRACT_ENUM]);
  for (const option of ADMIN_SCOPE_OPTIONS) {
    assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
    assert.equal(option.label, ADMIN_SCOPE_LABELS[option.value]);
    assert.ok(Object.isFrozen(option));
  }
  assert.ok(Object.isFrozen(ADMIN_SCOPE_OPTIONS));
});

test('isKnownAdminScope / scopeProblem：闭集内为 null，闭集外当场拦下并说清收到了什么', () => {
  for (const scope of CONTRACT_ENUM) {
    assert.equal(isKnownAdminScope(scope), true);
    assert.equal(scopeProblem(scope), null);
  }
  for (const value of ['', 'user', 'accounts:delete', 'ACCOUNTS:READ', ' audit:read', null, undefined, 42, {}]) {
    assert.equal(isKnownAdminScope(value), false, `${String(value)} 不该算闭集成员`);
    const problem = scopeProblem(value);
    assert.equal(typeof problem, 'string');
    assert.notEqual(problem.trim(), '');
  }
  assert.match(scopeProblem(''), /请选择一个 scope/);
  assert.match(scopeProblem('user'), /AdminScope/, '提示里要指认契约闭集');
  assert.match(scopeProblem('user'), /user/, '提示里要带上收到的值，便于定位');
});

// ---------------------------------------------------------------- URL 与行判定

test('授权 URL：{base}/admin/administrators/{id}/scopes；id 非 uuid ⇒ null（不拼错路径）', () => {
  assert.equal(buildAdministratorScopeGrantUrl(BASE, ADMIN_ID), `/api/v1/admin/administrators/${ADMIN_ID}/scopes`);
  assert.equal(buildAdministratorScopeGrantUrl(`${BASE}/`, ADMIN_ID), `/api/v1/admin/administrators/${ADMIN_ID}/scopes`);
  for (const bad of ['', 'abc', '22222222-2222-4222-8222-22222222222', null, undefined, 42]) {
    assert.equal(buildAdministratorScopeGrantUrl(BASE, bad), null);
  }
});

test('撤销 URL：scope 进路径且编码（audit:read ⇒ audit%3Aread）；闭集外 ⇒ null', () => {
  assert.equal(
    buildAdministratorScopeRevokeUrl(BASE, ADMIN_ID, 'audit:read'),
    `/api/v1/admin/administrators/${ADMIN_ID}/scopes/audit%3Aread`,
  );
  assert.equal(
    buildAdministratorScopeRevokeUrl(BASE, ADMIN_ID, 'scopes:write'),
    `/api/v1/admin/administrators/${ADMIN_ID}/scopes/scopes%3Awrite`,
  );
  assert.equal(buildAdministratorScopeRevokeUrl(BASE, ADMIN_ID, 'user'), null);
  assert.equal(buildAdministratorScopeRevokeUrl(BASE, 'abc', 'audit:read'), null);
});

test('行判定：uuid + 正整数 revision + 目标 active + 合法方向，缺一不可', () => {
  const ok = { id: ADMIN_ID, revision: 3, state: 'active' };
  assert.equal(canWriteAdministratorScope(ok, 'grant'), true);
  assert.equal(canWriteAdministratorScope(ok, 'revoke'), true);
  assert.equal(canWriteAdministratorScope(ok, 'delete'), false);
  assert.equal(canWriteAdministratorScope({ ...ok, state: 'suspended' }, 'grant'), false, '非 active 目标契约上 409');
  assert.equal(canWriteAdministratorScope({ ...ok, state: undefined }, 'grant'), false);
  assert.equal(canWriteAdministratorScope({ ...ok, revision: 0 }, 'grant'), false);
  assert.equal(canWriteAdministratorScope({ ...ok, revision: 1.5 }, 'grant'), false);
  assert.equal(canWriteAdministratorScope({ ...ok, revision: '3' }, 'grant'), false);
  assert.equal(canWriteAdministratorScope({ ...ok, id: 'abc' }, 'grant'), false);
  assert.equal(canWriteAdministratorScope(null, 'grant'), false);
  assert.equal(canWriteAdministratorScope('row', 'grant'), false);
});

test('方向与门：两个方向（grant/revoke），门沿用 scopes:write', () => {
  assert.deepEqual([...ADMINISTRATOR_SCOPE_MODES], ['grant', 'revoke']);
  assert.deepEqual({ ...ADMINISTRATOR_SCOPE_MODE_LABELS }, { grant: '授权', revoke: '撤销' });
  assert.equal(ADMINISTRATOR_SCOPE_WRITE_SCOPE, 'scopes:write');
  const operations = CONTRACT.paths['/admin/administrators/{id}/scopes'].post;
  assert.equal(operations['x-scope'], ADMINISTRATOR_SCOPE_WRITE_SCOPE);
  const revokeOp = CONTRACT.paths['/admin/administrators/{id}/scopes/{scope}'].delete;
  assert.equal(revokeOp['x-scope'], ADMINISTRATOR_SCOPE_WRITE_SCOPE);
});

// ---------------------------------------------------------------- 请求形状（逐字节）

test('授权请求逐字节：POST + If-Match "1" + Idempotency-Key + body {scope, reason}', async () => {
  const reachable = fakeFetch(() => jsonResponse(200, writeEnvelope()));
  const result = await grantAdministratorScope(grantInput({ fetchImpl: reachable }));

  assert.equal(result.ok, true);
  assert.equal(reachable.calls.length, 1, '一次点击只发一次请求');
  const call = reachable.calls[0];
  assert.equal(call.url, `/api/v1/admin/administrators/${ADMIN_ID}/scopes`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(call.init.headers.accept, 'application/json');
  assert.equal(call.init.headers['content-type'], 'application/json');
  assert.equal(call.init.headers['if-match'], '"1"');
  assert.equal(call.init.headers['idempotency-key'], KEY);
  assert.equal(call.init.body, `{"scope":"audit:read","reason":"${REASON}"}`, 'body 必须逐字节对');
  assert.equal(result.scope, 'audit:read');
  assert.equal(result.mode, 'grant');
  assert.equal(result.revision, 2);
  assert.deepEqual(result.scopes, ['audit:read', 'scopes:read']);
  assert.equal(result.requestId, REQUEST_ID);
});

test('撤销请求逐字节：DELETE + scope 进路径 + body 只有 {reason}', async () => {
  const reachable = fakeFetch(() => jsonResponse(200, writeEnvelope(scopeWriteView({ scopes: ['scopes:read'], revision: 4 }))));
  const result = await revokeAdministratorScope(revokeInput({ fetchImpl: reachable, revision: 3, scope: 'audit:read' }));

  assert.equal(result.ok, true);
  assert.equal(reachable.calls.length, 1);
  const call = reachable.calls[0];
  assert.equal(call.url, `/api/v1/admin/administrators/${ADMIN_ID}/scopes/audit%3Aread`);
  assert.equal(call.init.method, 'DELETE');
  assert.equal(call.init.headers['if-match'], '"3"');
  assert.equal(call.init.body, `{"reason":"${REASON}"}`, '撤销的 body 不该带 scope（scope 在路径里）');
  assert.equal(result.mode, 'revoke');
  assert.equal(result.revision, 4);
  assert.deepEqual(result.scopes, ['scopes:read']);
});

test('fetch 注入：不传 fetchImpl 时回落到 globalThis.fetch（页面就是这么发的）', async () => {
  const reachable = fakeFetch(() => jsonResponse(200, writeEnvelope()));
  const result = await withFetch(reachable, () => grantAdministratorScope(grantInput()));
  assert.equal(result.ok, true);
  assert.equal(reachable.calls.length, 1);
  assert.equal(reachable.calls[0].url, `/api/v1/admin/administrators/${ADMIN_ID}/scopes`);
});

// ---------------------------------------------------------------- 本地前置拦截：零请求

test('非法 scope ⇒ invalid_request 且一个字节都不发（授／撤都一样）', async () => {
  for (const scope of ['user', '', 'accounts:delete']) {
    const reachable = fakeFetch(() => jsonResponse(200, writeEnvelope()));
    const granted = await grantAdministratorScope(grantInput({ fetchImpl: reachable, scope }));
    assert.equal(granted.ok, false);
    assert.equal(granted.kind, 'invalid_request');
    assert.equal(reachable.calls.length, 0, `${scope} 不该发出请求`);

    const revoked = await revokeAdministratorScope(revokeInput({ fetchImpl: reachable, scope }));
    assert.equal(revoked.ok, false);
    assert.equal(revoked.kind, 'invalid_request');
    assert.equal(reachable.calls.length, 0, `${scope} 不该发出请求`);
  }
});

test('其余本地前置拦截矩阵：一律零请求', async () => {
  const cases = [
    ['id 非 uuid', { administratorId: 'abc' }, 'invalid_request'],
    ['没有令牌', { token: '' }, 'signed_out'],
    ['理由为空', { reason: '' }, 'invalid_request'],
    ['理由全空白', { reason: '   ' }, 'invalid_request'],
    ['理由超长', { reason: 'x'.repeat(501) }, 'invalid_request'],
    ['revision 0', { revision: 0 }, 'invalid_request'],
    ['revision 小数', { revision: 1.5 }, 'invalid_request'],
    ['revision 字符串', { revision: '3' }, 'invalid_request'],
    ['缺幂等键', { idempotencyKey: '' }, 'idempotency_key_required'],
    ['幂等键过短', { idempotencyKey: 'abc' }, 'idempotency_key_required'],
    ['幂等键超长', { idempotencyKey: 'k'.repeat(129) }, 'invalid_request'],
  ];
  for (const [label, overrides, kind] of cases) {
    const reachable = fakeFetch(() => jsonResponse(200, writeEnvelope()));
    const result = await grantAdministratorScope(grantInput({ fetchImpl: reachable, ...overrides }));
    assert.equal(result.ok, false, label);
    assert.equal(result.kind, kind, `${label} ⇒ ${kind}`);
    assert.equal(reachable.calls.length, 0, `${label} 不该发出请求`);
  }
});

test('既没有 fetchImpl 也没有 globalThis.fetch ⇒ network_error（仍然零请求）', async () => {
  const result = await withFetch(undefined, () => grantAdministratorScope(grantInput()));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'network_error');
  assert.match(result.message, /没有可用的 fetch/);
});

test('网络异常 ⇒ network_error，且提示重试要复用同一幂等键', async () => {
  const reachable = fakeFetch(() => {
    throw new TypeError('fetch failed');
  });
  const result = await grantAdministratorScope(grantInput({ fetchImpl: reachable }));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'network_error');
  assert.match(result.message, /幂等键/);
  assert.equal(reachable.calls.length, 1);
});

// ---------------------------------------------------------------- 响应解析

test('成功解析：revision 是改动后的值，ETag 回落到 revision；changed:false 也是成功', async () => {
  const reachable = fakeFetch(() =>
    jsonResponse(200, writeEnvelope(scopeWriteView({ revision: 7, changed: false })), { etag: '"7"' }),
  );
  const result = await grantAdministratorScope(grantInput({ fetchImpl: reachable }));
  assert.equal(result.ok, true);
  assert.equal(result.changed, false, '幂等重放不是错误');
  assert.equal(result.revision, 7);
  assert.equal(result.etag, '"7"');
});

test('响应不合契约 ⇒ invalid_response（不猜「大概成功了」）', async () => {
  const cases = [
    ['不是 JSON', brokenJsonResponse(200), /不是合法 JSON/],
    ['缺 meta', jsonResponse(200, { data: scopeWriteView() }), /信封/],
    ['scopes 含闭集外', jsonResponse(200, writeEnvelope(scopeWriteView({ scopes: ['user'] }))), /AdminScope 闭集/],
    ['revision 0', jsonResponse(200, writeEnvelope(scopeWriteView({ revision: 0 }))), /revision/],
    ['id 非 uuid', jsonResponse(200, writeEnvelope(scopeWriteView({ id: 'abc' }))), /uuid/],
    ['changed 缺失', jsonResponse(200, writeEnvelope({ id: ADMIN_ID, revision: 2, scopes: [] })), /changed/],
  ];
  for (const [label, response, pattern] of cases) {
    const reachable = fakeFetch(() => response);
    const result = await grantAdministratorScope(grantInput({ fetchImpl: reachable }));
    assert.equal(result.ok, false, label);
    assert.equal(result.kind, 'invalid_response', label);
    assert.match(result.message, pattern, label);
  }
});

test('视图校验：契约外字段只警告不拦（服务端多给字段不该让写面崩）', () => {
  const checked = validateAdministratorScopeWriteView({ ...scopeWriteView(), granted_by: ADMIN_ID });
  assert.equal(checked.ok, true);
  assert.equal(checked.warnings.length, 1);
  assert.match(checked.warnings[0], /granted_by/);
  const rejected = validateAdministratorScopeWriteView({ id: ADMIN_ID, revision: 2, scopes: 'audit:read', changed: true });
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join('；'), /scopes/);
});

// ---------------------------------------------------------------- 错误矩阵

test('错误码映射：401/403/404/409/428/429/503 都有可读 message 与正确的 kind', async () => {
  const cases = [
    [401, 'SESSION_REQUIRED', 'signed_out'],
    [403, 'SCOPE_DENIED', 'forbidden'],
    [403, 'SELF_SCOPE_GRANT_DENIED', 'self_scope_grant_denied'],
    [404, 'NOT_FOUND', 'not_found'],
    [409, 'REVISION_CONFLICT', 'revision_conflict'],
    [409, 'LAST_SCOPE_MANAGER', 'last_scope_manager'],
    [409, 'OBJECT_UNAVAILABLE', 'unavailable'],
    [412, null, 'revision_conflict'],
    [428, 'REVISION_REQUIRED', 'revision_required'],
    [429, 'RATE_LIMITED', 'rate_limited'],
    [500, null, 'unavailable'],
    [503, 'PROVIDER_UNAVAILABLE', 'unavailable'],
  ];
  for (const [status, code, kind] of cases) {
    const body = code === null ? { meta } : errorBody(code, `服务端说：${code}`, false);
    const reachable = fakeFetch(() => jsonResponse(status, body));
    const result = await grantAdministratorScope(grantInput({ fetchImpl: reachable }));
    assert.equal(result.ok, false, `HTTP ${status}`);
    assert.equal(result.kind, kind, `HTTP ${status} ${code}`);
    assert.equal(result.status, status);
    assert.equal(typeof result.message, 'string');
    assert.notEqual(result.message.trim(), '', `${status} 必须有可读 message`);
    assert.equal(reachable.calls.length, 1, '错误不自动重试');
  }
});

test('自锁门先于通用 403、LAST_SCOPE_MANAGER 先于通用 409（否则用户会去点错重试）', () => {
  assert.equal(classifyAdministratorScopeFailure(403, 'SELF_SCOPE_GRANT_DENIED'), 'self_scope_grant_denied');
  assert.equal(classifyAdministratorScopeFailure(403, 'SCOPE_DENIED'), 'forbidden');
  assert.equal(classifyAdministratorScopeFailure(409, 'LAST_SCOPE_MANAGER'), 'last_scope_manager');
  assert.equal(classifyAdministratorScopeFailure(409, 'REVISION_CONFLICT'), 'revision_conflict');
  assert.equal(classifyAdministratorScopeFailure(409, null), 'http_error');
});

test('Retry-After 与 INVALID_REQUEST details 不吞（都进结果、都进文案）', async () => {
  const limited = fakeFetch(() => jsonResponse(429, errorBody('RATE_LIMITED', '慢点', true), { 'retry-after': '42' }));
  const limitedResult = await grantAdministratorScope(grantInput({ fetchImpl: limited }));
  assert.equal(limitedResult.kind, 'rate_limited');
  assert.equal(limitedResult.retryAfterSeconds, 42);
  assert.equal(limitedResult.serverRetryable, true);

  const invalid = fakeFetch(() =>
    jsonResponse(400, errorBody('INVALID_REQUEST', '请求不合法', false, [{ path: '$.scope', problem: '不在闭集里' }])),
  );
  const invalidResult = await grantAdministratorScope(grantInput({ fetchImpl: invalid }));
  assert.equal(invalidResult.kind, 'invalid_request');
  assert.deepEqual(invalidResult.details, ['$.scope：不在闭集里'], 'details 必须原样带出');
  const described = describeAdministratorScopeFailure(invalidResult);
  assert.match(described.detail, /不在闭集里/, '文案里也要看得见 details');
});

test('令牌不外泄：失败文案里不出现 Bearer 令牌', async () => {
  const reachable = fakeFetch(() => jsonResponse(401, errorBody('SESSION_REQUIRED', '会话失效', false)));
  const result = await grantAdministratorScope(grantInput({ fetchImpl: reachable }));
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(describeAdministratorScopeFailure(result)).includes(TOKEN), false);
});

// ---------------------------------------------------------------- 文案映射

test('文案映射：每个 kind 都有一句话标题，关键几种说清「该怎么办」', () => {
  const titles = {
    self_scope_grant_denied: /不能给自己授权/,
    last_scope_manager: /scopes:write/,
    forbidden: /没有 scopes:write/,
    signed_out: /重新登录/,
    revision_conflict: /重新加载/,
    not_found: /不存在/,
    rate_limited: /稍后再试/,
    invalid_request: /请求不合法/,
    unavailable: /暂时不可用/,
    network_error: /网络异常/,
    invalid_response: /不符合契约/,
  };
  for (const [kind, pattern] of Object.entries(titles)) {
    const described = describeAdministratorScopeFailure({ kind, code: 'X', status: 400, details: [], retriable: false });
    assert.match(described.title, pattern, `${kind} 的标题要可读`);
    assert.equal(described.kind, kind);
    assert.equal(typeof described.detail, 'string');
  }
  assert.equal(describeAdministratorScopeFailure({ kind: 'self_scope_grant_denied', retriable: true }).canRetry, false);
  assert.equal(describeAdministratorScopeFailure({ kind: 'signed_out' }).canSignIn, true);
  assert.equal(describeAdministratorScopeFailure({ kind: 'revision_conflict' }).canReload, true);
  assert.equal(describeAdministratorScopeFailure(null).kind, 'http_error');
  const withCode = describeAdministratorScopeFailure({ kind: 'forbidden', code: 'SCOPE_DENIED', status: 403, inContract: true });
  assert.match(withCode.detail, /SCOPE_DENIED（HTTP 403）/, '错误码与状态都要上屏');
});
