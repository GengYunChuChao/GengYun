/**
 * GY-I18 阶段 2 · 后台路由的**结构性钉子**（`node --test`，用 `app.inject`，不占端口）。
 *
 * 两条钉子，都是"防未来静默翻转"：
 *
 * 1. **两层分工**（本项目已定口径）：**HTTP 层判格式**（非 uuid 路径 id ⇒ `400 INVALID_REQUEST`），
 *    **服务层判存在性与归属**（⇒ `404 NOT_FOUND`）。格式错误**不得**被并进"同形 404"组 ——
 *    否则将来一次"统一成 404"的翻新会把"客户端把 id 写坏了"伪装成"目标不存在"，
 *    既误导调用方，也让"越权与不存在同形"这条安全口径被污染。
 *    **与 #10/#106 的钉子同一口径**（那两处钉的也是"层级职责不许悄悄换位"）。
 *
 * 2. **44 个 operationId 的方法/路径必须与契约逐条一致**：直接读 `openapi.json`，
 *    对每个 operationId 取出契约的 `method` 与 `path`（`{id}`/`{key}` → `:id`/`:key`），
 *    断言装配后的 app 上**确实**存在这条路由。任何"少注册/路径写错/方法写错"都会失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { ADMIN_HTTP_OPERATION_IDS } from '../../services/api/src/routes/admin.ts';

const API = '/api/v1';
const CONTRACT = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));

/** 装配一个带后台会话的 app（全内存、inject 驱动、不监听端口）。 */
async function makeApp() {
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: authStore,
  });
  const adminId = await authStore.createAdmin({
    loginName: 'nail-admin',
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes: ['sources:read', 'sources:write', 'audit:read', 'accounts:read', 'accounts:suspend', 'jobs:read', 'jobs:cancel', 'flags:read', 'flags:write'],
  });
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: adminId, tokenHashHex: hashToken(token), authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600 * 1000), audience: 'admin',
  });
  return { app, token };
}

function get(app, token, url) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

test('钉子 1：两层分工 —— 非法 uuid ⇒ 400 INVALID_REQUEST，合法但不存在 ⇒ 404 NOT_FOUND，不得混同（与 #10/#106 同一口径）', async () => {
  const { app, token } = await makeApp();
  try {
    // (a) HTTP 层判格式：非 uuid 路径 id ⇒ **400**，且错误码是 INVALID_REQUEST。
    for (const bad of ['not-a-uuid', '123', 'a-b-c', '00000000-0000-4000-b000-00000000000', '00000000-0000-4000-b000-0000000000000']) {
      for (const url of [
        `${API}/admin/sources/${bad}`,
        `${API}/admin/knowledge/${bad}`,
        `${API}/admin/registrations/${bad}`,
        `${API}/admin/restrictions/${bad}`,
        `${API}/admin/accounts/${bad}/suspend`,
        `${API}/admin/jobs/${bad}/cancel`,
        `${API}/admin/posts/${bad}/hide`,
      ]) {
        const isWrite = /(publish|withdraw|suspend|cancel|hide|approve|reject)$/.test(url);
        const res = isWrite
          ? await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'nail-key-0001', 'if-match': '"1"', 'content-type': 'application/json' }, payload: { reason: 'r' } })
          : await get(app, token, url);
        assert.equal(res.statusCode, 400, `${url} 非法 uuid 必须是 400，实际 ${res.statusCode}`);
        assert.equal(res.json().error.code, 'INVALID_REQUEST');
        assert.notEqual(res.statusCode, 404, '格式错误不得被当作"不存在"');
      }
    }

    // (b) 服务层判存在性：**合法 uuid 但不存在** ⇒ 404 NOT_FOUND。
    const missingUuid = '00000000-0000-4000-b000-00000000ffff';
    const missing = await get(app, token, `${API}/admin/sources/${missingUuid}`);
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'NOT_FOUND');

    // (c) 两者必须**可区分**：同一个错误码闭集里 400 与 404 不同、错误码也不同。
    assert.notEqual(400, 404);

    // (d) 分类 id 是**不透明字符串**（契约 `minLength:1, maxLength:80`，不是 uuid）：
    //     合法形状但不存在 ⇒ 404（不是 400）；超长 ⇒ 400。这两条钉住"按契约各自的形状判定"。
    const body = { name: 'n', description: 'd', active: true };
    const patch = (id) => app.inject({
      method: 'PATCH', url: `${API}/admin/categories/${id}`,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'nail-key-0002', 'if-match': '"1"', 'content-type': 'application/json' },
      payload: body,
    });
    const opaqueMissing = await patch('definitely-missing');
    assert.equal(opaqueMissing.statusCode, 404, '不透明字符串 id 的"不存在"是 404');
    assert.equal(opaqueMissing.json().error.code, 'NOT_FOUND');
    const opaqueTooLong = await patch('x'.repeat(81));
    assert.equal(opaqueTooLong.statusCode, 400, '超长违反契约长度 ⇒ 400');
    assert.equal(opaqueTooLong.json().error.code, 'INVALID_REQUEST');
  } finally {
    await app.close();
  }
});

test('钉子 2：44 个 operationId 的方法与路径与契约逐条一致（读 openapi.json 原文核对）', async () => {
  const { app, token } = await makeApp();
  try {
    // 现 44 条：34 + listFlagAuditEvents + listAuditLogs + R37 读面 2 个 + **R59 帖子读面 2 个
    // （`listAdminPosts` / `getAdminPost`）** + **S3 人工通过/驳回 2 个（`approvePost` / `rejectPost`）**
    // + **`#18` S2 PR-3 管理员 scope 写面 2 个（`grantAdministratorScope` / `revokeAdministratorScope`）**。
    // 这条钉子钉的是「本文件暴露的路由条数 = 清单条数」，
    // 不是权限面：每个 id 仍必须能在契约里找到对应 operation、并在 app 上注册成同方法同路径。
    assert.equal(ADMIN_HTTP_OPERATION_IDS.length, 44, '本片应恰好暴露 44 个 operationId（42 + S2 PR-3 授予/撤销 2 个）');

    // 从契约取出每个 operationId 的 method + path。
    const fromContract = new Map();
    for (const [path, item] of Object.entries(CONTRACT.paths)) {
      for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
        const operation = item[method];
        if (operation !== undefined) fromContract.set(operation.operationId, { method: method.toUpperCase(), path });
      }
    }

    for (const operationId of ADMIN_HTTP_OPERATION_IDS) {
      const contract = fromContract.get(operationId);
      assert.notEqual(contract, undefined, `契约里没有 ${operationId}`);
      // 契约路径模板 → Fastify 参数语法（`{scope}` 是 PR-3 撤销面的路径参数）。
      const url = `${API}${contract.path}`
        .replaceAll('{id}', ':id')
        .replaceAll('{key}', ':key')
        .replaceAll('{scope}', ':scope');
      assert.equal(
        app.hasRoute({ method: contract.method, url }),
        true,
        `${operationId} 未按契约注册：期望 ${contract.method} ${url}`,
      );
    }

    // 抽查两条"容易被写错"的：方法不同（POST vs PUT）与路径不同（列表 vs 单资源）。
    assert.equal(app.hasRoute({ method: 'PUT', url: `${API}/admin/feature-flags/:key` }), true);
    assert.equal(app.hasRoute({ method: 'POST', url: `${API}/admin/posts/:id/hide` }), true);
    assert.equal(app.hasRoute({ method: 'POST', url: `${API}/admin/categories` }), false, '契约没有 createCategory ⇒ 不得注册');
    assert.equal(app.hasRoute({ method: 'DELETE', url: `${API}/admin/categories/:id` }), false, '契约没有 deleteCategory ⇒ 不得注册');
    // `#18` S2 PR-3：授予与撤销**共用** `/admin/administrators/:id/scopes` 这个路径前缀，
    // 但方法必须分开注册（POST 授予、DELETE 撤销、GET 只读），否则读面会被写方法顶掉。
    assert.equal(app.hasRoute({ method: 'POST', url: `${API}/admin/administrators/:id/scopes` }), true);
    assert.equal(app.hasRoute({ method: 'DELETE', url: `${API}/admin/administrators/:id/scopes/:scope` }), true);
    assert.equal(app.hasRoute({ method: 'DELETE', url: `${API}/admin/administrators/:id/scopes` }), false, '契约的撤销面 scope 在路径里 ⇒ 不得注册无 scope 的 DELETE');

    // 列表路由必须真的可读（装配健全性）。
    const listed = await get(app, token, `${API}/admin/feature-flags`);
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().data.items.length, 3, '契约闭集 3 个 key 必须都有状态');
  } finally {
    await app.close();
  }
});

test('钉子 2b：`setFlag` 的 key **不**在 HTTP 层按闭集拦下（否则服务层的 denied 审计永远不会产生）', async () => {
  const { app, token } = await makeApp();
  try {
    // 安全语义保留名：必须**到达服务层**并被以 SAFETY_CRITICAL_KEY 拒绝（而不是被路由 schema 提前 400 掉）。
    const res = await app.inject({
      method: 'PUT', url: `${API}/admin/feature-flags/hard_rules_enabled`,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'nail-key-0003', 'if-match': '"1"', 'content-type': 'application/json' },
      payload: { enabled: true, reason: 'r' },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.error.code, 'INVALID_REQUEST');
    assert.ok(
      body.error.details.some((detail) => detail.code === 'SAFETY_CRITICAL_KEY'),
      '必须由**服务层**给出安全语义标记（路由层拦下就不会有这条 details，也不会有 denied 审计）',
    );
    // 服务层确实留了 denied 审计。
    const audit = await get(app, token, `${API}/admin/audit-events`);
    const denied = audit.json().data.items.filter((event) => event.reason_code === 'flag_weakening_denied');
    assert.equal(denied.length, 1, '安全语义拒绝必须留一条 denied 审计');
    assert.equal(denied[0].result, 'denied');
  } finally {
    await app.close();
  }
});
