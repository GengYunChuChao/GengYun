/**
 * GY-I18 / S1：当前账号「有效权限」只读展示。
 *
 * 裁定口径（D1–D5）：`role` 是会话身份域，权限闭集入契约**只作声明**；
 * S1 只展示调用者自己持有的权限，不做 assign/revoke，也不新增迁移。
 *
 * 本文件**不另立闭集常量**——闭集从真实代码逐处推导，再与两边契约逐项对齐：
 *  1) `services/api/src/routes/*.ts` 里 `requireScope(...)` 的每处实参
 *     （字面量 + 常量引用两路分类统计，出现未归类实参即红，防止新 scope 绕过推导）；
 *  2) `OPS_SCOPES` / `FAMILIES` / `AUDIT_LOG_SCOPE` / `BOOTSTRAP_ADMIN_SCOPES` 常量；
 *  3) 用户端 `user`（`services/api/src/auth/middleware.ts:103` 中 `scopes: ['user']` 硬编码）。
 * `public` / `receipt` 只是路由访问标记（`x-scope` / operations.json 的 `scope`），不是可授予权限，故排除。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';
import { hashPassword } from '../../services/api/src/auth/password.ts';
import { BOOTSTRAP_ADMIN_SCOPES, sessionInfo } from '../../services/api/src/auth/service.ts';
import { OPS_SCOPES } from '../../services/api/src/admin/ops/service.ts';
import { FAMILIES } from '../../services/api/src/admin/families.ts';
import { AUDIT_LOG_SCOPE } from '../../services/api/src/admin/audit/catalog.ts';
import { ADMIN_SCOPES } from '../../services/api/src/admin/scopes.ts';

const OPENAPI_URL = new URL('../../packages/contracts/openapi.json', import.meta.url);
const OPERATIONS_URL = new URL('../../packages/contracts/operations.json', import.meta.url);
const ROUTES_DIR_URL = new URL('../../services/api/src/routes/', import.meta.url);

const USER_SESSION_URL = '/api/v1/auth/session';
const ADMIN_SESSION_URL = '/api/v1/admin/auth/session';

/** 用户端会话权限：`services/api/src/auth/middleware.ts:103` `scopes: ['user']`。行为由 ④ 钉住。 */
const USER_SESSION_SCOPE = 'user';

/** 路由访问标记：只出现在 `x-scope` / operations.json 的 `scope`，不可授予、不属于会话权限。 */
const ACCESS_MARKERS = Object.freeze(['public', 'receipt']);

/**
 * 已声明、但**暂无 operation 引用**的后台权限。
 *
 * `scopes:write`（管理授权写面）属 PR-3：本片明令不得有写端点，`operations.json` 里自然没有
 * 引用它的 operation；但库层 CHECK（迁移 0041 的 `admin_scopes_scope_closed_set`）与契约
 * `SessionInfo.scopes.items.enum` 都已含它。若这里不补，③ 的「代码闭集」会缺一项而与契约对不上。
 * 判据不是本测试自造集合，而是应用层唯一的闭集常量 `ADMIN_SCOPES`（`admin/scopes.ts`）。
 */
const DECLARED_ONLY_SCOPES = Object.freeze(['scopes:write']);

const SESSION_INFO_KEYS = ['audience', 'expires_at', 'revision', 'scopes'];

function sorted(values) {
  return [...new Set(values)].sort();
}

function readJson(url) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** 扫描 routes 层每处 `requireScope(...)`：字面量收进集合，常量引用只计数，其余实参直接判红。 */
function scanRouteRequireScopeArgs() {
  const literals = new Set();
  let calls = 0;
  let literalCalls = 0;
  let constantRefs = 0;
  for (const name of readdirSync(ROUTES_DIR_URL)) {
    if (!name.endsWith('.ts')) continue;
    const text = readFileSync(new URL(name, ROUTES_DIR_URL), 'utf8');
    for (const match of text.matchAll(/requireScope\(([^)]*)\)/g)) {
      const arg = match[1].trim();
      calls += 1;
      const literal = /^'([^']+)'$/.exec(arg);
      if (literal) {
        literals.add(literal[1]);
        literalCalls += 1;
        continue;
      }
      if (/^(?:descriptor\.(?:readScope|writeScope)|OPS_SCOPES\.\w+|AUDIT_LOG_SCOPE)$/.test(arg)) {
        constantRefs += 1;
        continue;
      }
      assert.fail(`routes/${name} 出现未纳入推导的 requireScope 实参：${arg}（请扩展本测试的闭集推导）`);
    }
  }
  assert.ok(calls > 0, 'routes 层未发现任何 requireScope 调用点，闭集推导口径已失效');
  return { literals: [...literals].sort(), calls, literalCalls, constantRefs };
}

/** 后台权限闭集：常量 + routes 层字面量实参（不含用户端 `user`）。 */
function codeAdminScopes() {
  const { literals, calls, literalCalls, constantRefs } = scanRouteRequireScopeArgs();
  assert.equal(calls, literalCalls + constantRefs, '每处 requireScope 调用都必须被分类统计');
  return sorted([
    ...Object.values(OPS_SCOPES),
    ...ADMIN_SCOPES,
    ...DECLARED_ONLY_SCOPES,
    ...FAMILIES.flatMap((family) => [family.readScope, family.writeScope]),
    AUDIT_LOG_SCOPE,
    ...BOOTSTRAP_ADMIN_SCOPES,
    ...literals,
  ]);
}

/** 契约声明的闭集（`SessionInfo.scopes.items.enum`）。 */
function contractClosedSet() {
  const openapi = readJson(OPENAPI_URL);
  const sessionInfoSchema = openapi.components.schemas.SessionInfo;
  const items = sessionInfoSchema.properties.scopes.items;
  assert.ok(Array.isArray(items.enum), 'SessionInfo.scopes.items 必须声明 enum 闭集（D2：闭集入契约）');
  assert.equal(sessionInfoSchema.additionalProperties, false, 'SessionInfo 必须是封闭对象（不得夹带契约外字段）');
  assert.ok(sessionInfoSchema.required.includes('scopes'), 'SessionInfo.scopes 必须是必填');
  return items.enum;
}

/** operations.json 的 scope 闭集（剔除访问标记）。 */
function manifestClosedSet() {
  const { operations } = readJson(OPERATIONS_URL);
  assert.ok(Array.isArray(operations) && operations.length > 0, 'operations.json 必须含 operations 数组');
  return sorted(operations.map((operation) => operation.scope).filter((scope) => !ACCESS_MARKERS.includes(scope)));
}

function newApp(extra = {}) {
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', ...extra });
  const store = createMemoryAuthStore();
  const app = buildApp({ config, store, idempotency: createMemoryIdempotencyStore() });
  return { app, store };
}

async function adminHarness() {
  const { app, store } = newApp({
    ADMIN_BOOTSTRAP_LOGIN_NAME: 'root',
    ADMIN_BOOTSTRAP_PASSWORD: 'bootstrap-pass-123',
  });
  await app.authService.ensureBootstrapAdmin();
  return { app, store };
}

let idempotencySeq = 0;

function nextIdempotencyKey(label) {
  idempotencySeq += 1;
  return `scopes-s1-${label}-${String(idempotencySeq).padStart(4, '0')}`;
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function loginUser(app, code) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/wechat',
    headers: { 'idempotency-key': nextIdempotencyKey('user') },
    payload: { code },
  });
  assert.equal(response.statusCode, 200, 'stub 模式合成身份登录应成功');
  return response.json().data.access_token;
}

async function loginAdmin(app, loginName, password) {
  const response = await app.inject({
    method: 'POST',
    url: ADMIN_SESSION_URL,
    headers: { 'idempotency-key': nextIdempotencyKey('admin') },
    payload: { login_name: loginName, password },
  });
  assert.equal(response.statusCode, 200, `管理员登录失败：${loginName}`);
  return response.json().data.access_token;
}

async function readSession(app, url, token) {
  const response = await app.inject({ method: 'GET', url, headers: bearer(token) });
  assert.equal(response.statusCode, 200, `读取会话失败：${url}`);
  return response.json().data;
}

test('① 管理员：返回的权限就是该账号实际持有的闭集成员（逆序播种，多一个少一个都红）', async () => {
  const { app, store } = await adminHarness();
  const held = codeAdminScopes();
  assert.equal(held.length, 13, '后台闭集应为 13 项（逐处核对后固化，变动须同步契约）');
  // 应用层闭集常量必须与「从真实代码逐处推导」的结果逐项相等：
  // 常量是出口守卫（读面返回值不在闭集内就 503）的唯一依据，⛔ 不能与推导分叉。
  assert.deepEqual([...ADMIN_SCOPES], held, 'admin/scopes.ts 的 ADMIN_SCOPES 必须等于代码推导闭集');
  // 逆序播种：输出顺序不能是播种顺序的副作用。
  await store.createAdmin({
    loginName: 'scope-full',
    credentialHash: hashPassword('scope-full-pass-123'),
    scopes: [...held].reverse(),
  });
  const token = await loginAdmin(app, 'scope-full', 'scope-full-pass-123');
  const data = await readSession(app, ADMIN_SESSION_URL, token);

  assert.deepEqual(data.scopes, held, '权限列表必须与账号实际持有集合逐项相等（顺序也钉住）');
  assert.equal(new Set(data.scopes).size, data.scopes.length, '权限列表必须去重');
  assert.deepEqual([...data.scopes].sort(), data.scopes, '权限列表必须顺序稳定（码元序）');
  // 判据有牙齿：少一个 / 多一个都必须红。
  assert.notDeepEqual(data.scopes, held.slice(1), '少一个权限不得通过');
  assert.notDeepEqual(data.scopes, sorted([...held, USER_SESSION_SCOPE]), '多一个权限不得通过');
  assert.notDeepEqual(data.scopes, [...held].reverse(), '顺序漂移不得通过');
  await app.close();
});

test('①b 初始化管理员：只拿到 BOOTSTRAP_ADMIN_SCOPES，不因 role=admin 被扩张', async () => {
  const { app } = await adminHarness();
  const token = await loginAdmin(app, 'root', 'bootstrap-pass-123');
  const data = await readSession(app, ADMIN_SESSION_URL, token);
  assert.deepEqual(data.scopes, sorted(BOOTSTRAP_ADMIN_SCOPES));
  assert.notDeepEqual(data.scopes, codeAdminScopes(), 'role 是身份域，不是权限来源（D1）');
  await app.close();
});

test('② 只读展示调用者自己：不含他人权限、不含访问标记、无契约外字段', async () => {
  const { app, store } = await adminHarness();
  // 他人权限：该账号存在但从不登录本会话。
  await store.createAdmin({
    loginName: 'scope-other',
    credentialHash: hashPassword('scope-other-pass-123'),
    scopes: ['audit:read', 'flags:write', 'jobs:cancel'],
  });
  const mine = ['session:read', 'sources:read'];
  await store.createAdmin({
    loginName: 'scope-mine',
    credentialHash: hashPassword('scope-mine-pass-123'),
    scopes: mine,
  });
  const token = await loginAdmin(app, 'scope-mine', 'scope-mine-pass-123');
  const data = await readSession(app, ADMIN_SESSION_URL, token);

  assert.deepEqual(data.scopes, mine, '只返回调用者自己持有的权限');
  for (const scope of ['audit:read', 'flags:write', 'jobs:cancel']) {
    assert.ok(!data.scopes.includes(scope), `不得泄露他人权限：${scope}`);
  }
  for (const marker of ACCESS_MARKERS) {
    assert.ok(!data.scopes.includes(marker), `访问标记 ${marker} 不是权限，不得出现在会话权限里`);
  }
  assert.ok(!data.scopes.includes(USER_SESSION_SCOPE), '后台会话不得混入用户端 scope');
  assert.equal(data.audience, 'admin', 'role/audience 仍是身份域，不被权限列表改写（D1）');
  assert.deepEqual(Object.keys(data).sort(), SESSION_INFO_KEYS, '响应不得新增契约外字段');
  await app.close();
});

test('②b 账号视图不夹带权限字段：查他人权限走独立只读端点，不混进账号视图（D3/D4）', () => {
  const openapi = readJson(OPENAPI_URL);
  const accountView = openapi.components.schemas.AdminAccountView;
  assert.ok(accountView, '契约必须仍声明 AdminAccountView');
  assert.deepEqual(Object.keys(accountView.properties).sort(), ['display_name', 'id', 'revision', 'state']);
  assert.ok(!JSON.stringify(accountView).includes('"scopes"'), '账号视图不得携带 scopes（查他人权限是独立端点，不靠加宽账号视图）');
  // 独立的读面是**另一批对象**（`admin_accounts.id`），且只看 scope 字符串：
  // ⛔ 不含 granted_by/granted_at（运行时角色对 admin_scopes 只有三列 SELECT）。
  const scopesView = openapi.components.schemas.AdminAdministratorScopesView;
  assert.ok(scopesView, '契约必须声明 AdminAdministratorScopesView');
  assert.deepEqual(Object.keys(scopesView.properties), ['scopes']);
  assert.equal(scopesView.additionalProperties, false);
  const view = openapi.components.schemas.AdminAdministratorView;
  assert.ok(view, '契约必须声明 AdminAdministratorView');
  assert.deepEqual(Object.keys(view.properties).sort(), ['id', 'login_name', 'scopes', 'state']);
  // 出口只留 scope 字符串数组：`granted_by`/`granted_at` 连属性位都没有（不是「暂时不返回」）。
  const declared = new Set([...Object.keys(scopesView.properties), ...Object.keys(view.properties)]);
  assert.ok(!declared.has('granted_by'), '读面不得声明 granted_by');
  assert.ok(!declared.has('granted_at'), '读面不得声明 granted_at');
});

test('③ 闭集三方一致：代码实参 ↔ 契约 enum ↔ operations.json scope', () => {
  const codeClosedSet = sorted([...codeAdminScopes(), USER_SESSION_SCOPE]);
  const contract = contractClosedSet();
  const manifest = manifestClosedSet();

  assert.equal(codeClosedSet.length, 14, '闭集应为 14 项（13 个后台权限 + user）');
  assert.deepEqual(contract, codeClosedSet, '契约 enum 必须与代码闭集逐项一致');
  // operations.json 只收「有 operation 引用」的 scope：`scopes:write` 属 PR-3 写面，本片不得有端点，
  // 故补上已声明的写面权限后再对拍（补的是声明，不是放宽断言）。
  assert.deepEqual(sorted([...manifest, ...DECLARED_ONLY_SCOPES]), codeClosedSet, 'operations.json 的 scope 闭集必须与代码闭集逐项一致');
  assert.equal(new Set(contract).size, contract.length, '契约闭集不得重复');
  assert.deepEqual([...contract].sort(), contract, '契约闭集须按码元序（保证响应顺序稳定）');
  for (const marker of ACCESS_MARKERS) {
    assert.ok(!contract.includes(marker), `访问标记 ${marker} 不得进入会话权限闭集（D2）`);
  }
  assert.deepEqual(
    ['accounts:read', 'accounts:suspend', 'audit:read', 'flags:read', 'flags:write', 'jobs:cancel', 'jobs:read', 'scopes:read', 'scopes:write', 'session:logout', 'session:read', 'sources:read', 'sources:write', 'user'],
    contract,
    '闭集成员须逐项对照（此处为人工复核后的快照，改动即有意识）',
  );
});

test('③b routes 层每处 requireScope 调用都被归类（新字面量无法绕过闭集推导）', () => {
  const { literals, calls, literalCalls, constantRefs } = scanRouteRequireScopeArgs();
  assert.ok(literals.length > 0, 'routes 层应存在字面量实参的 requireScope 调用');
  assert.equal(calls, literalCalls + constantRefs);
  for (const scope of literals) {
    assert.ok(!ACCESS_MARKERS.includes(scope), `requireScope 不得使用访问标记：${scope}`);
    assert.ok(codeAdminScopes().includes(scope), `字面量实参必须落在后台闭集内：${scope}`);
  }
});

test('④ 普通账号：有效权限固定为 ["user"]（身份域与权限列表不并集，D1）', async () => {
  const { app } = newApp();
  const token = await loginUser(app, 'scopes-s1-user-0001');
  const data = await readSession(app, USER_SESSION_URL, token);

  assert.deepEqual(data.scopes, [USER_SESSION_SCOPE]);
  assert.equal(data.audience, 'user');
  assert.deepEqual(Object.keys(data).sort(), SESSION_INFO_KEYS, '响应不得新增契约外字段');
  assert.notDeepEqual(data.scopes, [], '权限列表不得为空');
  assert.ok(
    !data.scopes.some((scope) => scope.includes(':')),
    '普通账号不得凭空出现后台权限',
  );
  await app.close();
});

test('⑤ sessionInfo 边界归一化：去重 + 码元序，且不就地修改入参', () => {
  const input = ['sources:write', 'audit:read', 'sources:write', 'accounts:read'];
  const data = sessionInfo({
    audience: 'admin',
    expiresAt: new Date('2026-10-25T00:00:00.000Z'),
    scopes: input,
    revision: 3,
  });

  assert.deepEqual(data.scopes, ['accounts:read', 'audit:read', 'sources:write']);
  assert.deepEqual(input, ['sources:write', 'audit:read', 'sources:write', 'accounts:read'], '不得就地排序/去重入参');
  assert.deepEqual(Object.keys(data), ['audience', 'expires_at', 'scopes', 'revision']);
});
