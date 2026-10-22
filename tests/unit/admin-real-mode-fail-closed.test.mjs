/**
 * 监工返修 P1（PR #121）：**real 默认装配反例**。
 *
 * 缺陷：后台服务默认建**内存** store，而 `app.ts` 把 `config.executionMode` 原样交给服务层。
 * 于是在 `executionMode === 'real'` + **默认（内存）store** 下，写操作会返回**成功封套**
 * （`data` + `meta.execution_mode='real'`），而落点只是**易失内存** —— 即"真实模式"下
 * 声称成功、重启即丢。**不能**用 `contract-status=partial` 之类文档披露替代运行时拒绝。
 *
 * 本文件钉住两件事：
 * 1. **real 默认装配反例 ⇒ 35 条后台路由一律 fail-closed（503 `PROVIDER_UNAVAILABLE`）**，
 *    且**不产生任何内存副作用**（审计台账为空）、**路由保持注册**（契约面不缩水）；
 * 2. **stub 默认装配行为不变**（内存实现仍可用，且确会写内存）—— 说明改动只对外拒绝 real。
 *
 * 判定条件是 **`executionMode === 'real'` 本身**（刻意不依赖 store 自称持久化）：
 * 将来接真实持久后端时必须在 `app.ts` **显式放行**，因此本文件不需要"声明持久化即放行"的用例。
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
const UNKNOWN_UUID = '00000000-0000-4000-a000-00000000ffff';

/** 与 tests/integration/speech-http.mjs 同形的**合成占位** real 环境（非真实凭据）。 */
const REAL_ENV = {
  APP_EXECUTION_MODE: 'real',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
  SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
  WECHAT_APP_ID: 'synthetic-not-a-real-appid',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
  OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
};

const ALL_SCOPES = [
  'sources:read', 'sources:write', 'audit:read',
  'accounts:read', 'accounts:suspend',
  'jobs:read', 'jobs:cancel',
  'flags:read', 'flags:write',
];

/** 契约里 34 个 operationId 的 method + path（从 openapi.json 原文取）。 */
const CONTRACT = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
const CONTRACT_ROUTES = new Map();
for (const [path, item] of Object.entries(CONTRACT.paths)) {
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) {
    if (item[method] !== undefined) CONTRACT_ROUTES.set(item[method].operationId, { method: method.toUpperCase(), path });
  }
}

function sourceInput() {
  return {
    title: '浙江省水稻田稗草防治技术指导意见', url: 'https://example.invalid/agri/rice',
    publisher: '示例出版单位', source_kind: 'verified_seed', evidence_kind: 'research',
    version: '2026-09', content_hash: 'a'.repeat(64), locator: 'p.12 §3.2',
    valid_from: '2026-09-01T00:00:00.000Z', valid_to: null,
  };
}
function knowledgeInput() {
  return {
    type: 'herbicide', title: '示例除草剂在水稻田的使用要点',
    body: '结构性示例正文，不含用量绑定，也不含适用性判定结论。',
    source_id: UNKNOWN_UUID, source_version: '2026-09',
    conditions: { crop_id: 'rice', region_code: '330100' }, formulation_id: null,
  };
}
function registrationInput() {
  return {
    formulation: {
      registration_number: 'PD20260001', producer: '示例农药生产企业', dosage_form: '乳油',
      ingredients: [{ name: '有效成分A', content_text: '10%', unit_text: '质量分数' }],
    },
    source_id: UNKNOWN_UUID, source_version: '2026-09', registered_name: '示例登记制剂',
    valid_from: '2026-01-01T00:00:00.000Z', valid_to: null,
  };
}
function restrictionInput() {
  return {
    source_id: UNKNOWN_UUID, source_version: '2026-09', formulation_id: null,
    conditions: { crop_id: 'rice', region_code: '330100' }, effect: 'restricted',
    reason: '示例限制条件说明（结构性文本）。',
    valid_from: '2026-01-01T00:00:00.000Z', valid_to: null,
  };
}

/** 34 个 operationId 的**合法形状**请求（real 下若未 fail-closed，其中一些会直接成功）。 */
function adminRequests() {
  const families = [
    { path: `${API}/admin/sources`, input: sourceInput },
    { path: `${API}/admin/knowledge`, input: knowledgeInput },
    { path: `${API}/admin/registrations`, input: registrationInput },
    { path: `${API}/admin/restrictions`, input: restrictionInput },
  ];
  const rows = [];
  for (const family of families) {
    rows.push({ op: 'list', method: 'GET', url: family.path });
    rows.push({ op: 'create', method: 'POST', url: family.path, body: family.input() });
    rows.push({ op: 'get', method: 'GET', url: `${family.path}/${UNKNOWN_UUID}` });
    rows.push({ op: 'edit', method: 'PATCH', url: `${family.path}/${UNKNOWN_UUID}`, body: family.input(), ifMatch: '"1"' });
    rows.push({ op: 'publish', method: 'POST', url: `${family.path}/${UNKNOWN_UUID}/publish`, body: { evidence_ref: 'EVID-2026-09-001', reason: '核验通过' }, ifMatch: '"1"' });
    rows.push({ op: 'withdraw', method: 'POST', url: `${family.path}/${UNKNOWN_UUID}/withdraw`, body: { reason: '撤回' }, ifMatch: '"1"' });
  }
  rows.push({ op: 'listAuditEvents', method: 'GET', url: `${API}/admin/audit-events` });
  rows.push({ op: 'listAdminCategories', method: 'GET', url: `${API}/admin/categories` });
  rows.push({ op: 'editCategory', method: 'PATCH', url: `${API}/admin/categories/crop-rice`, body: { name: 'n', description: 'd', active: true }, ifMatch: '"1"' });
  rows.push({ op: 'listAdminUsers', method: 'GET', url: `${API}/admin/accounts` });
  rows.push({ op: 'suspendUser', method: 'POST', url: `${API}/admin/accounts/${UNKNOWN_UUID}/suspend`, body: { reason: 'r' }, ifMatch: '"1"' });
  rows.push({ op: 'listAdminJobs', method: 'GET', url: `${API}/admin/jobs` });
  rows.push({ op: 'cancelAdminJob', method: 'POST', url: `${API}/admin/jobs/${UNKNOWN_UUID}/cancel`, body: { reason: 'r' }, ifMatch: '"1"' });
  rows.push({ op: 'listFlags', method: 'GET', url: `${API}/admin/feature-flags` });
  rows.push({ op: 'setFlag', method: 'PUT', url: `${API}/admin/feature-flags/ai_enabled`, body: { enabled: true, reason: 'r' }, ifMatch: '"1"' });
  rows.push({ op: 'listFlagAuditEvents', method: 'GET', url: `${API}/admin/flag-audit-events` });
  rows.push({ op: 'hidePost', method: 'POST', url: `${API}/admin/posts/${UNKNOWN_UUID}/hide`, body: { reason: 'r' }, ifMatch: '"1"' });
  return rows;
}

async function seedAdmin(authStore) {
  const adminId = await authStore.createAdmin({
    loginName: `gyi18-real-${Math.random().toString(36).slice(2, 10)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes: ALL_SCOPES,
  });
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: adminId, tokenHashHex: hashToken(token), authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600 * 1000), audience: 'admin',
  });
  return token;
}

function inject(app, token, row, index) {
  return app.inject({
    method: row.method,
    url: row.url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(row.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(row.body === undefined ? {} : { 'idempotency-key': `gyi18-real-${index}-${row.op}`.slice(0, 40) }),
      ...(row.ifMatch === undefined ? {} : { 'if-match': row.ifMatch }),
    },
    ...(row.body === undefined ? {} : { payload: row.body }),
  });
}

test('real 默认装配反例：35 条后台路由一律 fail-closed（503 PROVIDER_UNAVAILABLE），零成功封套、零内存副作用', async () => {
  const authStore = createMemoryAuthStore();
  const app = buildApp({ config: loadConfig(REAL_ENV), store: authStore });
  try {
    const token = await seedAdmin(authStore);
    const rows = adminRequests();
    assert.equal(rows.length, 35, '反例必须覆盖全部 35 个 operationId');

    const succeeded = [];
    for (const [index, row] of rows.entries()) {
      const res = await inject(app, token, row, index);
      const body = res.json();
      if (res.statusCode !== 503) succeeded.push(`${row.op} ${row.method} ${row.url} -> ${res.statusCode}`);
      assert.equal(res.statusCode, 503, `${row.method} ${row.url} 在 real 默认装配下必须 503，实际 ${res.statusCode}`);
      assert.equal(body.error.code, 'PROVIDER_UNAVAILABLE', `${row.method} ${row.url}`);
      assert.equal(body.error.retryable, false, `${row.method} ${row.url} 未接线 ⇒ 需运维接线，同一请求原样重试不会成功`);
      assert.equal(body.data, undefined, `${row.method} ${row.url} 不得返回成功封套`);
    }
    assert.deepEqual(succeeded, [], `不得有任何后台操作在 real 默认装配下"成功"：${succeeded.join('; ')}`);

    // 契约面不缩水：35 条路由**仍然注册**（只是运行时一律拒绝）。
    assert.equal(ADMIN_HTTP_OPERATION_IDS.length, 35);
    for (const opId of ADMIN_HTTP_OPERATION_IDS) {
      const route = CONTRACT_ROUTES.get(opId);
      const url = `${route.path}`.replaceAll('{id}', ':id').replaceAll('{key}', ':key');
      assert.equal(app.hasRoute({ method: route.method, url: `${API}${url}` }), true, `${opId} 必须仍注册`);
    }

    // 零内存副作用：没有任何写落到内存 store（审计台账为空），且账号停用等也未发生。
    assert.equal(app.adminContentService.store.audit.list().length, 0, 'fail-closed 不得留下审计');
    assert.equal(app.adminOpsService.store.audit.list().length, 0, 'fail-closed 不得留下审计');
    assert.equal(app.adminContentService.store.persistent, false, '默认 store 是内存实现');
    assert.equal(app.adminOpsService.store.persistent, false, '默认 store 是内存实现');
    assert.equal(app.adminContentService.operationIds.length, 25);
    assert.equal(app.adminOpsService.operationIds.length, 10);
  } finally {
    await app.close();
  }
});

test('stub 默认装配行为不变（内存实现仍可用且确会写内存）——改动只对 real 拒绝', async () => {
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: authStore,
  });
  try {
    const token = await seedAdmin(authStore);

    const flags = await app.inject({ method: 'GET', url: `${API}/admin/feature-flags`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(flags.statusCode, 200, flags.body);
    assert.equal(flags.json().data.items.length, 3);
    // 本片起：装配层把 3 个开关与该输出面的**真实状态**对齐（见 `admin/ops/flag-gate.ts`
    // 的 `FLAG_WIRING_BASELINE`）——此前"列表说全关、/herbicides 照常产出"正是本片要修的
    // "开关没生效"。服务层工厂的出厂默认（全 false）仍由单测单独钉住。
    // 合并 `upstream/main`（含 #148 社区 HTTP 装配）后：投稿面也真实可用了 ⇒ 基线为开启。
    // 顺序 = `listFlags` 的 key 升序：ai_enabled / specific_herbicide_output_enabled / submissions_enabled。
    assert.deepEqual(flags.json().data.items.map((f) => f.enabled), [true, true, true], '装配基线：三个输出面当前都真实可用');

    const set = await app.inject({
      method: 'PUT', url: `${API}/admin/feature-flags/ai_enabled`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'gyi18-stub-flag-0001', 'if-match': '"1"' },
      payload: { enabled: false, reason: 'r' },
    });
    assert.equal(set.statusCode, 200, set.body);
    assert.equal(set.json().data.enabled, false);

    const created = await app.inject({
      method: 'POST', url: `${API}/admin/sources`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'gyi18-stub-source-0001' },
      payload: sourceInput(),
    });
    assert.equal(created.statusCode, 201, created.body);

    // stub 下**确有**内存写入（与 real 的"零副作用"形成对照）。
    assert.equal(app.adminOpsService.store.audit.list().length > 0, true, 'stub 下开关变更应留审计');
    assert.equal(app.adminContentService.store.audit.list().length > 0, true, 'stub 下建草稿应留审计');

    // 端口级 fail-closed 在 stub 下仍然成立（作业端口未接线 ⇒ 503），与模式级 fail-closed 是两回事。
    const jobs = await app.inject({ method: 'GET', url: `${API}/admin/jobs`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(jobs.statusCode, 503, jobs.body);
    assert.equal(jobs.json().error.code, 'PROVIDER_UNAVAILABLE');
  } finally {
    await app.close();
  }
});
