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
 * **`#18` S2 PR-3 起为空，此后一直是空数组**：PR-2 当时 `scopes:write` 属 PR-3、明令不得有
 * 写端点，`operations.json` 里自然没有引用它的 operation，所以这里补过一项，好让 ③ 的「代码闭集」
 * 与契约 enum 对得上。PR-3 落地 `grantAdministratorScope` / `revokeAdministratorScope` 后
 * `operations.json` **真的**引用了 `scopes:write` ⇒ 那一项被**移出**（不是删常量、不是放宽断言）。
 *
 * ⛔ 「把它从集合里移出去」本身**不构成修好**：清空之后，辨别"某个 scope 到底有没有端点"的能力
 * 必须落在别处，否则 ③ 就从"抓差集"退化成"永远绿"。判别力今天由 ③ 的三条合成：
 *   1. `DECLARED_ONLY_SCOPES` 必须为空（补丁位不许再被填回来，否则 ③ 变成用手写补丁抹平差集）；
 *   2. **门集合对拍**：`operations.json` 引用的每个后台 scope，routes 层都必须真的有一处以它为
 *      实参的 `requireScope` 门（见 `scanRouteScopeGates`）；
 *   3. **逐处门计数 + 逐 operationId 对拍**（B1）：光有集合只证明"出现过一次"，把 `scopes:write`
 *      的四处写面门（`grantAdministratorScope` / `revokeAdministratorScope` /
 *      `disableAdministratorAccount` / `enableAdministratorAccount`）摘掉一处，第 2 条照样绿。
 *      所以 ③ 还数未去重的调用条数、并逐 operationId 要求源码里仍有那处
 *      `requireScope(OPS_SCOPES.<operationId>)` —— 变异记录在 ③ 的注释里。
 *
 * 判据不是本测试自造集合，而是应用层唯一的闭集常量 `ADMIN_SCOPES`（`admin/scopes.ts`）。
 */
const DECLARED_ONLY_SCOPES = Object.freeze([]);

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
      // R59：`routes/admin.ts` 用导出的常量 `ADMIN_POST_READ_SCOPE`（='sources:read'）守两条帖子读面，
      // 与 `AUDIT_LOG_SCOPE` 同形——常量本身仍要经 `admin/scopes.ts` 的闭集核对，不是绕过。
      if (/^(?:descriptor\.(?:readScope|writeScope)|OPS_SCOPES\.\w+|AUDIT_LOG_SCOPE|ADMIN_POST_READ_SCOPE)$/.test(arg)) {
        constantRefs += 1;
        continue;
      }
      assert.fail(`routes/${name} 出现未纳入推导的 requireScope 实参：${arg}（请扩展本测试的闭集推导）`);
    }
  }
  assert.ok(calls > 0, 'routes 层未发现任何 requireScope 调用点，闭集推导口径已失效');
  return { literals: [...literals].sort(), calls, literalCalls, constantRefs };
}

/**
 * routes 层每处 `requireScope(...)` 实参 → **scope 真值**（两份视图）。
 *
 * 与 `scanRouteRequireScopeArgs` 的分工：那个只做"分类统计"（字面量 / 常量引用 / 未归类即红），
 * 这个把实参**解析成它真正的字符串**，并返回 `gates`（去重集合：有没有这个门）与 `calls`
 * （未去重：每处调用是谁，用来数"四处写面门是不是都还在"，见 ③a-1/③a-2）。只有集合的话，
 * 摘掉四处写面门里的一处仍然全绿——那是 B1，⛔ 别把 `calls` 删回去。存在的理由：`scopes:write`
 * 曾靠一份手写的"只声明、无端点"清单
 * 豁免掉这层对拍（那份清单已清空），所以这里解析不出来的实参一律判红 —— ⛔ 不当成"已覆盖"。
 */
function scanRouteScopeGates() {
  const gates = new Set();
  // `calls` **不去重**：每处 `requireScope` 调用留一条解析值。`gates` 只能回答"这个 scope 出现过至少
  // 一次"，回答不了"四处写面门是不是都还各自挂着"——单点摘门/降级正是从这道缝溜过去的（B1）。
  const calls = [];
  const record = (value) => {
    gates.add(value);
    calls.push(value);
  };
  let descriptorCalls = 0;
  for (const name of readdirSync(ROUTES_DIR_URL)) {
    if (!name.endsWith('.ts')) continue;
    const text = readFileSync(new URL(name, ROUTES_DIR_URL), 'utf8');
    for (const match of text.matchAll(/requireScope\(([^)]*)\)/g)) {
      const arg = match[1].trim();
      const literal = /^'([^']+)'$/.exec(arg);
      if (literal) {
        record(literal[1]);
        continue;
      }
      const opsRef = /^OPS_SCOPES\.(\w+)$/.exec(arg);
      if (opsRef) {
        const value = OPS_SCOPES[opsRef[1]];
        assert.equal(
          typeof value,
          'string',
          `routes/${name} 的 requireScope 引用了 OPS_SCOPES.${opsRef[1]}，但 OPS_SCOPES 没有这个键：`
            + '门会静默退化成 undefined（鉴权被跳过），必须先补 OPS_SCOPES',
        );
        record(value);
        continue;
      }
      if (arg === 'AUDIT_LOG_SCOPE') {
        record(AUDIT_LOG_SCOPE);
        continue;
      }
      if (arg === 'ADMIN_POST_READ_SCOPE') {
        record(declaredScopeValue('services/api/src/admin/posts/service.ts', 'ADMIN_POST_READ_SCOPE'));
        continue;
      }
      if (arg === 'descriptor.readScope' || arg === 'descriptor.writeScope') {
        // 族级门：`descriptor` 是 `FAMILIES` 的运行时形参，一族两名（读 / 写），逐个取真值。
        const key = arg === 'descriptor.readScope' ? 'readScope' : 'writeScope';
        for (const family of FAMILIES) record(family[key]);
        descriptorCalls += 1;
        continue;
      }
      assert.fail(
        `routes/${name} 出现无法解析为 scope 真值的 requireScope 实参：${arg}（请扩展 scanRouteScopeGates）`,
      );
    }
  }
  return { gates: [...gates].sort(), calls, descriptorCalls };
}

/** 从声明处读常量真值（`export const NAME = '…';`）；读不到就判红 —— ⛔ 不猜，也不在这里抄一份。 */
function declaredScopeValue(relPath, name) {
  const text = readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf8');
  const match = new RegExp(`export const ${name} = '([^']+)';`).exec(text);
  assert.ok(match, `${relPath} 里找不到 \`export const ${name} = '…';\`：门集合推导已失去真值来源`);
  return match[1];
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
  // `revision` 是停用/恢复写面的 `If-Match` 来源（目录不发 `ETag`）：它必须在目录项里，
  // 否则任何客户端都构造不出 `If-Match`。仍是**穷举相等**：字段集合多一个少一个都算失败。
  assert.deepEqual(Object.keys(view.properties).sort(), ['id', 'login_name', 'revision', 'scopes', 'state']);
  assert.deepEqual([...view.required].sort(), ['id', 'login_name', 'revision', 'scopes', 'state']);
  assert.deepEqual(view.properties.revision, { type: 'integer', minimum: 1 }, 'revision 必须是正整数（admin_accounts.revision）');
  // 出口只留 scope 字符串数组：`granted_by`/`granted_at` 连属性位都没有（不是「暂时不返回」）。
  const declared = new Set([...Object.keys(scopesView.properties), ...Object.keys(view.properties)]);
  assert.ok(!declared.has('granted_by'), '读面不得声明 granted_by');
  assert.ok(!declared.has('granted_at'), '读面不得声明 granted_at');
});

test('③ 闭集三方一致：代码实参 ↔ 契约 enum ↔ operations.json scope', () => {
  // 先跑门扫描器、再跑旧分类器：`scanRouteScopeGates` 里「实参解析不出即红」的兜底只有排在旧分类器
  // 之前才可达（旧分类器的接受式覆盖同类实参，先跑它，这条兜底就成死代码——两条都红，但红线要指对人）。
  const { gates, calls } = scanRouteScopeGates();
  const codeClosedSet = sorted([...codeAdminScopes(), USER_SESSION_SCOPE]);
  const contract = contractClosedSet();
  const manifest = manifestClosedSet();

  assert.equal(codeClosedSet.length, 14, '闭集应为 14 项（13 个后台权限 + user）');
  assert.deepEqual(contract, codeClosedSet, '契约 enum 必须与代码闭集逐项一致');
  // operations.json 收「有 operation 引用」的 scope。`scopes:write` 今天有 4 处写面引用它
  // （PR-3 的 `grantAdministratorScope` / `revokeAdministratorScope`，R64 的
  // `disableAdministratorAccount` / `enableAdministratorAccount`）
  // ⇒ `DECLARED_ONLY_SCOPES` 必须为空，否则下面的对拍就变成「用补丁抹平差集」。
  assert.deepEqual([...DECLARED_ONLY_SCOPES], [], '已声明但无端点的 scope 必须为空：今天每个闭集成员都有 operation');
  assert.deepEqual(sorted([...manifest, ...DECLARED_ONLY_SCOPES]), codeClosedSet, 'operations.json 的 scope 闭集必须与代码闭集逐项一致');
  assert.ok(manifest.includes('scopes:write'), 'operations.json 必须真的引用 scopes:write（PR-3 写面），而不是靠补丁');
  // ③a **逐处门对拍**（A06 收尾；B1 修好后口径才与注释一致）：manifest 说「实现了」的后台 scope，
  // routes 层必须真的有一处 `requireScope` 以它为实参。旧口径只看两份清单相不相等 —— `scopes:write`
  // 当时靠 `DECLARED_ONLY_SCOPES` 里手写的一项就豁免了这层检查；现在清单为空，差集无处藏。
  // `user` 单独排除：它是身份域取值（`sessionInfo()` 给出），用户端路由用 `x-scope: user` 访问标记，
  // 不经 `requireScope`，不是后台门。
  // 变异实测（A06，临时改 `services/api/src/routes/admin.ts`，跑完已 `git checkout` 回滚，整文件读数）：
  //   M-a 把四处写面门（`OPS_SCOPES.grantAdministratorScope` / `revokeAdministratorScope` /
  //       `disableAdministratorAccount` / `enableAdministratorAccount`）一起换成
  //       `OPS_SCOPES.listAdministratorScopes` ⇒ 红：「写面门 `scopes:write` 必须真的挂在 routes 层
  //       （pass 7 / fail 1）」；
  //   M-b 把 `OPS_SCOPES.cancelAdminJob` 换成 `OPS_SCOPES.listAdminJobs` ⇒ 红：「operations.json
  //       声明实现了「jobs:cancel」，但 routes 层没有任何一处 requireScope 以它为门」（pass 7 / fail 1）
  //       ——M-b 证明下面这条循环不是只对 `scopes:write` 生效的一次性检查。
  //   M-c/M-c' 只动**一处**写面门（B1 的反例）：把 disable 那道门换成 `OPS_SCOPES.listAdministrators`
  //       （`scopes:read`，= 把停用降级成只读），或整行摘掉只留 `guards.requireAdmin`（= 无 scope 门）
  //       ⇒ 各红在 ③a-1 的计数（`actual 3 expected 4`）。修 B1 前这两例是 8/8 全绿。
  assert.ok(gates.includes('scopes:write'), '写面门 `scopes:write` 必须真的挂在 routes 层');
  for (const scope of manifest.filter((item) => item !== USER_SESSION_SCOPE)) {
    assert.ok(
      gates.includes(scope),
      `operations.json 声明实现了「${scope}」，但 routes 层没有任何一处 requireScope 以它为门：`
        + '要么端点被删、门被改成别的 scope（声明与实现脱钩），要么这处门用了本测试解析不了的写法'
        + '（请扩展 scanRouteScopeGates，⛔ 不要把该 scope 塞回 DECLARED_ONLY_SCOPES 绕过）',
    );
  }
  // ③a-1 **按调用计数对拍**（B1）：`gates` 是去重集合，只能证明「这个 scope 出现过至少一次」——
  // 四处写面门摘掉一处，集合照样含 `scopes:write`、整文件 8/8 全绿（实测过）。所以再数一遍
  // **未去重**的 `calls`：以 `scopes:write` 为实参的 `requireScope` 调用数，必须等于 operations.json
  // 里 `scope='scopes:write'` 的 operation 条数。期望值从真源派生，⛔ 不硬编码 4（写面增删时这里跟着走）。
  const writeFaceOps = readJson(OPERATIONS_URL).operations
    .filter((operation) => operation.scope === 'scopes:write')
    .map((operation) => operation.id);
  assert.ok(writeFaceOps.length > 0, 'operations.json 必须声明至少一个 scopes:write 写面 operation');
  assert.equal(
    calls.filter((value) => value === 'scopes:write').length,
    writeFaceOps.length,
    `以 \`scopes:write\` 为实参的 requireScope 调用数必须等于 operations.json 里声称实现了它的 operation 条数`
      + `（${writeFaceOps.length}：${writeFaceOps.join(' / ')}）。少一处＝某条写面门被摘掉或降级成别的 scope，`
      + '多一处＝有未登记的门（先补 operations.json，⛔ 不要调低这个数字来变绿）',
  );
  // ③a-2 **逐 operationId 对拍**：计数相等仍不排除「一处摘门 + 另一处多挂门」互相抵消（比如把 disable
  // 端点降级成 `scopes:read`、同时把某个非写面端点的门改成 `scopes:write`）。`OPS_SCOPES` 的键就是
  // operationId，所以逐条断言 routes 源码里仍存在 `requireScope(OPS_SCOPES.<operationId>)` 这处调用。
  // ⚠️ 本断言依赖「门写成 `OPS_SCOPES.<operationId>`」这一形式；将来某条写面改用族级/字面量门，必须
  // 同步扩展这里（⛔ 不许删断言来变绿）。
  const routesText = readdirSync(ROUTES_DIR_URL)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(new URL(name, ROUTES_DIR_URL), 'utf8'))
    .join('\n');
  for (const operationId of writeFaceOps) {
    assert.equal(
      OPS_SCOPES[operationId],
      'scopes:write',
      `operations.json 说「${operationId}」是写面，但 OPS_SCOPES.${operationId} 不等于 scopes:write：门表与 manifest 各说各话`,
    );
    assert.ok(
      routesText.includes(`requireScope(OPS_SCOPES.${operationId})`),
      `写面 operation「${operationId}」的门不见了：routes 层必须仍有一处 requireScope(OPS_SCOPES.${operationId})`
        + '（换成别的 scope、或整行摘掉只留 requireAdmin，都是写面鉴权降级）',
    );
  }
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
