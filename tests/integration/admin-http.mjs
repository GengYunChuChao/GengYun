// GY-I18 阶段 2 集成回归：**经真实装配的 app**（`buildApp`）+ 本机 loopback 真实 HTTP。
//
// 运行：`node tests/integration/admin-http.mjs`（退出码 0 表示通过；断言失败以非 0 退出并打印原始断言）
//
// 覆盖契约 34 个 operationId 的 **HTTP 逐项映射**（方法/路径/状态码/错误码**均为实测**，
// 见末尾打印的映射表；每一行的 `status` 都来自本脚本真正发出的请求）。
//
// 边界（如实标注，不得外推）：
// - 只用本机回环（127.0.0.1，随机端口）；**不发起任何外网请求**、**不连接任何数据库**（全内存）。
// - 身份是**合成**的：直接按 `AuthStore` 公开 API 播种 admin / user 会话（不经过微信换取）。
// - **平台级作业端口**：默认装配实例**未接线**（读与写都 503）；另建一个注入了
//   内存参考端口的实例用于验证"已接线"路径。**不是真实平台作业面**。
// - **社区存储**：本脚本**显式注入**一份内存社区 store 供后台 `hidePost` 复用其 CAS。
//   GY-I15 阶段 2 起社区 HTTP 路由已装配，但本脚本仍用社区**服务层**在同一 store 上断言
//   "公开读不可见 / 作者仍可见"（因为注入的 store 是脚本自建的，与 app 内建的社区 store 不是同一份；
//   #15 的社区 HTTP 面由 `tests/unit/community-http.test.mjs` 覆盖）。
// - 未取得：真实 PG 持久化、真实作业端口、后台页面（`apps/admin/**` 不在本单）、
//   全局开关/账号停用与业务链路联调、真机。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createAdminOpsStore } from '../../services/api/src/admin/ops/store.ts';
import { createAdminContentStore } from '../../services/api/src/admin/store.ts';
import { createAdminRuntime } from '../../services/api/src/admin/runtime.ts';
import { createMemoryAdminJobPort } from '../../services/api/src/admin/ops/jobs.ts';
import { CONTRACT_FLAG_KEYS } from '../../services/api/src/admin/ops/flags.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { makeHarness as makeCommunityHarness, makeSyntheticPassPort, USER_A, USER_B } from '../unit/community-fixtures.mjs';

const API = '/api/v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_UUID = '00000000-0000-4000-a000-00000000ffff';

const ALL_SCOPES = [
  'sources:read', 'sources:write', 'audit:read',
  'accounts:read', 'accounts:suspend',
  'jobs:read', 'jobs:cancel',
  'flags:read', 'flags:write',
];

let keySeq = 0;
const newKey = (label) => `gyi18-http-${label}-${String((keySeq += 1)).padStart(4, '0')}`;
const uuid = (n) => `00000000-0000-4000-b000-${String(n).padStart(12, '0')}`;

// ---------------------------------------------------------------- 种子数据（合成，非真实库行）
const CATEGORY_SEED = [
  { id: 'crop-rice', revision: 1, type: 'crop', name: '水稻', description: '示例分类：水稻', active: true },
  { id: 'species-barnyardgrass', revision: 1, type: 'species', name: '稗草', description: '示例分类：稗草', active: true },
];
const ACCOUNT_SEED = [
  { id: USER_A.userId, revision: 1, state: 'active', display_name: '示例用户A' },
  { id: USER_B.userId, revision: 1, state: 'suspended', display_name: '示例用户B' },
  { id: uuid(301), revision: 1, state: 'deletion_pending', display_name: '示例用户C' },
];
const JOB_QUEUED = uuid(101);
const JOB_SUCCEEDED = uuid(103);
function jobSeed() {
  const base = {
    revision: 1, kind: 'ocr', target_ref: { type: 'ocr', id: uuid(900), revision: 1 },
    deadline_at: '2026-10-12T01:00:00.000Z', created_at: '2026-10-12T00:10:00.000Z',
    error_code: null, result: null,
  };
  return [
    { ...base, id: JOB_QUEUED, state: 'queued' },
    { ...base, id: uuid(102), state: 'running' },
    { ...base, id: JOB_SUCCEEDED, state: 'succeeded' },
    { ...base, id: uuid(104), state: 'cancelled' },
  ];
}

/** 合法的四类资料入参（契约 `SourceDraftInput` / `KnowledgeDraftInput` / …）。 */
function sourceInput(overrides = {}) {
  return {
    title: '浙江省水稻田稗草防治技术指导意见', url: 'https://example.invalid/agri/rice',
    publisher: '示例出版单位', source_kind: 'verified_seed', evidence_kind: 'research',
    version: '2026-09', content_hash: 'a'.repeat(64), locator: 'p.12 §3.2',
    valid_from: '2026-09-01T00:00:00.000Z', valid_to: null, ...overrides,
  };
}
function knowledgeInput(overrides = {}) {
  return {
    type: 'herbicide', title: '示例除草剂在水稻田的使用要点',
    body: '结构性示例正文，不含用量绑定，也不含适用性判定结论。',
    source_id: randomUUID(), source_version: '2026-09',
    conditions: { crop_id: 'rice', region_code: '330100' }, formulation_id: null, ...overrides,
  };
}
function registrationInput(overrides = {}) {
  return {
    formulation: {
      registration_number: 'PD20260001', producer: '示例农药生产企业', dosage_form: '乳油',
      ingredients: [{ name: '有效成分A', content_text: '10%', unit_text: '质量分数' }],
    },
    source_id: randomUUID(), source_version: '2026-09', registered_name: '示例登记制剂',
    valid_from: '2026-01-01T00:00:00.000Z', valid_to: null, ...overrides,
  };
}
function restrictionInput(overrides = {}) {
  return {
    source_id: randomUUID(), source_version: '2026-09', formulation_id: null,
    conditions: { crop_id: 'rice', region_code: '330100' }, effect: 'restricted',
    reason: '示例限制条件说明（结构性文本）。',
    valid_from: '2026-01-01T00:00:00.000Z', valid_to: null, ...overrides,
  };
}
const FAMILY_CASES = [
  { name: 'sources', list: 'listAdminSources', create: 'createSourceDraft', get: 'getAdminSource', edit: 'editSourceDraft', publish: 'publishSource', withdraw: 'withdrawSource', path: `${API}/admin/sources`, input: sourceInput, edited: () => sourceInput({ title: '水稻田稗草防治指导意见（第二稿）' }) },
  { name: 'knowledge', list: 'listAdminKnowledge', create: 'createKnowledgeDraft', get: 'getAdminKnowledge', edit: 'editKnowledgeDraft', publish: 'publishKnowledge', withdraw: 'withdrawKnowledge', path: `${API}/admin/knowledge`, input: knowledgeInput, edited: () => knowledgeInput({ body: '第二稿正文：仍不含用量绑定与适用性判定。' }) },
  { name: 'registrations', list: 'listAdminRegistration', create: 'createRegistrationDraft', get: 'getAdminRegistration', edit: 'editRegistrationDraft', publish: 'publishRegistration', withdraw: 'withdrawRegistration', path: `${API}/admin/registrations`, input: registrationInput, edited: () => registrationInput({ registered_name: '示例登记制剂（第二稿）' }) },
  { name: 'restrictions', list: 'listAdminRestriction', create: 'createRestrictionDraft', get: 'getAdminRestriction', edit: 'editRestrictionDraft', publish: 'publishRestriction', withdraw: 'withdrawRestriction', path: `${API}/admin/restrictions`, input: restrictionInput, edited: () => restrictionInput({ reason: '第二稿限制条件说明（结构性文本）。' }) },
];

let passed = 0;
const failures = [];
async function group(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error?.message}`);
    console.log(`FAIL ${name}: ${error?.message}`);
  }
}

/**
 * 走完全部分页取回审计台账。
 *
 * 为什么需要：`listAuditEvents` 是**分页**端点（契约 limit 1..50，默认 20），
 * 因此"读一页 items"**不等于**"读全部审计"。本片新增了编辑审计（四类资料的版本修改）
 * 与来源撤回的范围审计后，台账条数超过了默认页大小，此前把"第一页"当"全部"的断言
 * 会静默算错（差值算成 0 / 找不到事件）。这里按 `next_cursor` 翻完，
 * 让断言仍然作用于**整份**台账，而不是第一页。
 */
async function allAuditItems(fetch = http, token = adminAll.token) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const url = `${API}/admin/audit-events?limit=50${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    const body = (await fetch(url, { token })).body.data;
    items.push(...body.items);
    cursor = body.next_cursor;
    if (cursor === null) return items;
  }
  throw new Error('审计分页未收敛（超过 20 页）');
}

/** 回环 HTTP 调用（只走 127.0.0.1）。 */
function makeHttp(origin) {
  return async function http(path, options = {}) {
    const headers = {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    };
    const response = await fetch(origin + path, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return {
      status: response.status,
      body,
      text,
      etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'),
    };
  };
}

/** 播种后台会话（合成身份，不经微信换取）。 */
async function seedAdminSession(authStore, label, scopes) {
  const adminId = await authStore.createAdmin({
    loginName: `gyi18-${label}-${randomUUID().slice(0, 8)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes,
  });
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: adminId, tokenHashHex: hashToken(token), authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600 * 1000), audience: 'admin',
  });
  return { token, adminId };
}
async function seedUserSession(authStore, label) {
  const user = await authStore.createUser(`${label}-${randomUUID().replace(/-/g, '')}`);
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: user.id, tokenHashHex: hashToken(token), authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000), audience: 'user',
  });
  return { token, userId: user.id };
}

// ---------------------------------------------------------------- 装配两个实例
// A) **默认装配**（不注入任何后台端口）⇒ 平台级作业读/取消 fail-closed（503）；
//    `hidePost` 自 GY-I15 阶段 2 起接到 app 自建的**同一份**社区 store（不再是 503），
//    未知帖子因此是 404；real 模式的整域 503 由单元回归覆盖。
const defaultAuth = createMemoryAuthStore();
const defaultApp = buildApp({
  config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
  store: defaultAuth,
});
const defaultOrigin = await defaultApp.listen({ host: '127.0.0.1', port: 0 });
const defaultHttp = makeHttp(defaultOrigin);

// B) **注入装配**（内存参考端口 + 内存社区 store）⇒ 用于验证已接线路径与正控制。
// 注意：内容 store 与运营 store 必须建在**同一个 `AdminRuntime`** 上，
// 这样两个切片的写操作落在**同一份只可追加审计**里（`GET /admin/audit-events` 才看得全）。
const wiredAuth = createMemoryAuthStore();
const communityStore = createMemoryCommunityStore();
const community = makeCommunityHarness({ store: communityStore });
const adminRuntime = createAdminRuntime();
const adminContentStore = createAdminContentStore({ runtime: adminRuntime });
const adminOpsStore = createAdminOpsStore({ runtime: adminRuntime, categorySeed: CATEGORY_SEED, accountSeed: ACCOUNT_SEED });
const jobPort = createMemoryAdminJobPort(jobSeed());
const wiredApp = buildApp({
  config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
  store: wiredAuth,
  adminInjection: { contentStore: adminContentStore, opsStore: adminOpsStore, jobPort, communityStore },
  communityInjection: { store: communityStore },
});
const wiredOrigin = await wiredApp.listen({ host: '127.0.0.1', port: 0 });
const http = makeHttp(wiredOrigin);

console.log(`loopback default=${defaultOrigin} wired=${wiredOrigin}`);

// C) **默认装配（不注入任何 store）**：只给合成 pass 审核端口（stub 审核域"未结论"⇒ 隔离，
//    帖子根本落不了行 ⇒ 就没有"已知帖"可下架）。用于钉住 F1（切片①审查）：默认装配下社区 store
//    由 `app.ts` **只声明一次**，社区服务 / 后台 `hidePost` 端口 / 审核域同源权威**三方共用同一份**。
const sameSourceAuth = createMemoryAuthStore();
const sameSourceApp = buildApp({
  config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
  store: sameSourceAuth,
  moderationInjection: { ports: { tms: makeSyntheticPassPort('tms') } },
});
const sameSourceOrigin = await sameSourceApp.listen({ host: '127.0.0.1', port: 0 });
const sameSourceHttp = makeHttp(sameSourceOrigin);

const adminAll = await seedAdminSession(wiredAuth, 'all', ALL_SCOPES);
const adminReadOnly = await seedAdminSession(wiredAuth, 'readonly', ['sources:read']);
const userSession = await seedUserSession(wiredAuth, 'user');
const defaultAdminAll = await seedAdminSession(defaultAuth, 'default-all', ALL_SCOPES);
const sameSourceAdmin = await seedAdminSession(sameSourceAuth, 'same-source', ALL_SCOPES);

// ---------------------------------------------------------------- 34 项实测映射表
const mappingRows = [];
/** 发一次真实请求并把结果登记进映射表（每一行都有实测出处：本函数即出处）。 */
async function probe(operationId, method, path, options = {}) {
  const api = options.api ?? http;
  const res = await api(path, { method, token: options.token ?? adminAll.token, body: options.body, headers: options.headers });
  mappingRows.push({
    operationId, method, path: path.replace(API, ''),
    status: res.status,
    code: res.body?.error?.code ?? '—',
    note: options.note ?? '',
  });
  return res;
}

// —— 正控制：四类资料完整生命周期（create→get→edit→publish→list→withdraw） ——
const createdIds = {};
for (const family of FAMILY_CASES) {
  await group(`[正控制] ${family.name}：create→get→edit→publish→list→withdraw 全链路经 HTTP 生效`, async () => {
    const created = await probe(family.create, 'POST', family.path, { body: family.input(), headers: { 'idempotency-key': newKey(`${family.name}-create`) } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.cache, 'no-store');
    assert.equal(typeof created.etag, 'string');
    const id = created.body.data.id;
    createdIds[family.name] = id;

    const got = await probe(family.get, 'GET', `${family.path}/${id}`);
    assert.equal(got.status, 200);
    assert.equal(got.etag, '"1"');

    const edited = await probe(family.edit, 'PATCH', `${family.path}/${id}`, {
      body: family.edited(), headers: { 'idempotency-key': newKey(`${family.name}-edit`), 'if-match': '"1"' },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.data.revision, 2);
    assert.equal(edited.etag, '"2"');

    const published = await probe(family.publish, 'POST', `${family.path}/${id}/publish`, {
      body: { evidence_ref: 'EVID-2026-09-001', reason: '核验通过' },
      headers: { 'idempotency-key': newKey(`${family.name}-publish`), 'if-match': '"2"' },
    });
    assert.equal(published.status, 200, JSON.stringify(published.body));

    const listed = await probe(family.list, 'GET', family.path);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.items.length, 1);
    assert.equal(listed.etag, null, '列表响应不得带 ETag（契约：列表无此头）');

    const withdrawn = await probe(family.withdraw, 'POST', `${family.path}/${id}/withdraw`, {
      body: { reason: '来源版本已更新，撤回当前已发布修订' },
      headers: { 'idempotency-key': newKey(`${family.name}-withdraw`), 'if-match': '"2"' },
    });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  });
}

// —— 分类 ——
await group('[正控制] 分类：list 200（种子）→ edit 200（revision+1）；未知分类 404', async () => {
  const listed = await probe('listAdminCategories', 'GET', `${API}/admin/categories`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.items.length, 2);

  const edited = await probe('editCategory', 'PATCH', `${API}/admin/categories/crop-rice`, {
    body: { name: '水稻（改）', description: '示例分类：水稻（改）', active: false },
    headers: { 'idempotency-key': newKey('cat'), 'if-match': '"1"' },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.data.revision, 2);
  assert.equal(edited.body.data.type, 'crop', '契约 CategoryInput 无 type ⇒ 类型不可编辑');

  const missing = await http(`${API}/admin/categories/no-such-category`, {
    method: 'PATCH', token: adminAll.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('cat404'), 'if-match': '"1"' },
    body: JSON.stringify({ name: 'n', description: 'd', active: true }),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

// —— 账号 ——
await group('[正控制] 账号：list 200 → suspend 200；重复 suspend 幂等（不再迁移）', async () => {
  const listed = await probe('listAdminUsers', 'GET', `${API}/admin/accounts`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data.items.length, 3);
  for (const item of listed.body.data.items) {
    assert.deepEqual(Object.keys(item).sort(), ['display_name', 'id', 'revision', 'state']);
  }

  const suspended = await probe('suspendUser', 'POST', `${API}/admin/accounts/${USER_A.userId}/suspend`, {
    body: { reason: '示例：多次发布违规内容' },
    headers: { 'idempotency-key': newKey('acc'), 'if-match': '"1"' },
  });
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
  assert.equal(suspended.body.data.state, 'suspended');

  const again = await http(`${API}/admin/accounts/${USER_A.userId}/suspend`, {
    method: 'POST', token: adminAll.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('acc2'), 'if-match': '"2"' },
    body: JSON.stringify({ reason: '示例：再次停用' }),
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.revision, 2, '重复停用不得再迁移');
});

// —— 账号（GY-I22 缺陷①：无认证权威 ⇒ fail-closed；形态同作业面，`retryable` 按裁定取 false） ——
await group('[正控制] 账号：**默认装配无认证权威** ⇒ list 与 suspend 都 503（不返回空页、不伪造"账号不存在"）', async () => {
  // 接线状态先落到可核对的面上：默认装配（不注入 opsStore）≠ 有权威。
  assert.equal(defaultApp.adminOpsService.accountsWired, false, '默认装配不得声称账号权威已接线');
  assert.equal(wiredApp.adminOpsService.accountsWired, true, '注入带账号种子的 store 才是已接线');

  const listed = await probe('listAdminUsers', 'GET', `${API}/admin/accounts`, {
    api: defaultHttp, token: defaultAdminAll.token, note: '默认装配=账号权威未接线',
  });
  assert.equal(listed.status, 503, JSON.stringify(listed.body));
  assert.equal(listed.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(listed.body.error.retryable, false, '接线是运维动作：不得宣称可重试（STATE-current §40）');
  assert.equal(listed.body.data, undefined, '不得返回空页冒充"平台没有账号"');

  const suspended = await probe('suspendUser', 'POST', `${API}/admin/accounts/${UNKNOWN_UUID}/suspend`, {
    api: defaultHttp, token: defaultAdminAll.token, note: '默认装配=账号权威未接线',
    body: { reason: '示例：停用' }, headers: { 'idempotency-key': newKey('acc0'), 'if-match': '"1"' },
  });
  assert.equal(suspended.status, 503, JSON.stringify(suspended.body));
  assert.equal(suspended.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(suspended.body.error.retryable, false, '接线是运维动作：不得宣称可重试（STATE-current §40）');
  assert.equal(suspended.body.data, undefined, '不得把"没有权威"报成"账号不存在"或伪造成功');
});

await group('[反例] 账号：默认装配下**鉴权/越权/格式校验都先于 503**（不得被接线状态顶掉）', async () => {
  // 默认装配有**自己的** auth store（上面的 adminReadOnly / userSession 长在 wiredAuth 上）⇒ 本组自造会话。
  const defaultAdminReadOnly = await seedAdminSession(defaultAuth, 'default-readonly', ['sources:read']);
  const defaultUser = await seedUserSession(defaultAuth, 'default-user');

  const anon = await defaultHttp(`${API}/admin/accounts`);
  assert.equal(anon.status, 401, JSON.stringify(anon.body));
  assert.equal(anon.body.error.code, 'SESSION_REQUIRED');

  const asUser = await defaultHttp(`${API}/admin/accounts`, { token: defaultUser.token });
  assert.equal(asUser.status, 403, JSON.stringify(asUser.body));
  assert.equal(asUser.body.error.code, 'SCOPE_DENIED');

  const noRead = await defaultHttp(`${API}/admin/accounts`, { token: defaultAdminReadOnly.token });
  assert.equal(noRead.status, 403, '缺 accounts:read 仍是 403：接线状态不得顶掉越权判定');
  assert.equal(noRead.body.error.code, 'SCOPE_DENIED');

  const noSuspend = await defaultHttp(`${API}/admin/accounts/${UNKNOWN_UUID}/suspend`, {
    method: 'POST', token: defaultAdminReadOnly.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('acc-noscope'), 'if-match': '"1"' },
    body: JSON.stringify({ reason: '示例：无权限停用' }),
  });
  assert.equal(noSuspend.status, 403, JSON.stringify(noSuspend.body));
  assert.equal(noSuspend.body.error.code, 'SCOPE_DENIED');

  // 格式错误与"不存在"的分工在未接线时同样保持：非法 uuid 仍是 400（不是 503）。
  const badId = await defaultHttp(`${API}/admin/accounts/not-a-uuid/suspend`, {
    method: 'POST', token: defaultAdminAll.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('acc-badid'), 'if-match': '"1"' },
    body: JSON.stringify({ reason: '示例：停用' }),
  });
  assert.equal(badId.status, 400, JSON.stringify(badId.body));
  assert.equal(badId.body.error.code, 'INVALID_REQUEST');
});

// —— 作业 ——
await group('[正控制] 作业：**默认装配未接线** ⇒ list 与 cancel 都 503（不返回空页、不伪造状态）', async () => {
  const listed = await probe('listAdminJobs', 'GET', `${API}/admin/jobs`, { api: defaultHttp, token: defaultAdminAll.token, note: '默认装配=未接线' });
  assert.equal(listed.status, 503, JSON.stringify(listed.body));
  assert.equal(listed.body.error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(listed.body.error.retryable, false);
  assert.equal(listed.body.data, undefined, '不得返回空页冒充"平台没有作业"');

  const cancelled = await probe('cancelAdminJob', 'POST', `${API}/admin/jobs/${JOB_QUEUED}/cancel`, {
    api: defaultHttp, token: defaultAdminAll.token, note: '默认装配=未接线',
    body: { reason: '示例：作业超时' }, headers: { 'idempotency-key': newKey('job0'), 'if-match': '"1"' },
  });
  assert.equal(cancelled.status, 503);
  assert.equal(cancelled.body.error.code, 'PROVIDER_UNAVAILABLE');
});

await group('[正控制] 作业：已接线实例 ⇒ list 200（4 条）+ cancel 200；终态取消 409', async () => {
  const listed = await probe('listAdminJobs', 'GET', `${API}/admin/jobs`, { note: '注入内存参考端口' });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.data.items.length, 4);
  for (const item of listed.body.data.items) assert.equal(item.result, null, '契约 result 恒为 null');

  const cancelled = await probe('cancelAdminJob', 'POST', `${API}/admin/jobs/${JOB_QUEUED}/cancel`, {
    body: { reason: '示例：作业超时' }, headers: { 'idempotency-key': newKey('job'), 'if-match': '"1"' },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.state, 'cancelled');
  assert.equal(cancelled.body.data.revision, 2);

  const terminal = await http(`${API}/admin/jobs/${JOB_SUCCEEDED}/cancel`, {
    method: 'POST', token: adminAll.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('jobterm'), 'if-match': '"1"' },
    body: JSON.stringify({ reason: '示例：试图取消已完成' }),
  });
  assert.equal(terminal.status, 409, JSON.stringify(terminal.body));
  assert.equal(terminal.body.error.code, 'OBJECT_UNAVAILABLE');
  const after = await jobPort.get(JOB_SUCCEEDED);
  assert.equal(after.state, 'succeeded', '终态不得被改动');
});

// —— 开关 ——
await group('[正控制] 开关：list 200（契约 3 键默认 false）→ setFlag 200 → 读回一致', async () => {
  const listed = await probe('listFlags', 'GET', `${API}/admin/feature-flags`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data.items.map((f) => f.key).sort(), [...CONTRACT_FLAG_KEYS].sort());
  // 注意：本组走 **wired 实例**（测试自己注入 opsStore，未播种）⇒ 出厂默认仍是全 false。
  // 「默认关闭 + 与产出面对齐」的播种只发生在 `app.ts` **自建** store 的装配路径上；
  // 该口径由 `tests/unit/admin-flag-gate.test.mjs` E1 与 `admin-real-mode-fail-closed.test.mjs` 钉住。
  for (const flag of listed.body.data.items) assert.equal(flag.enabled, false, '注入 store 未播种 ⇒ 出厂默认（最严格一侧）');

  const set = await probe('setFlag', 'PUT', `${API}/admin/feature-flags/specific_herbicide_output_enabled`, {
    body: { enabled: true, reason: '示例：比赛演示需要展示药剂输出' },
    headers: { 'idempotency-key': newKey('flag'), 'if-match': '"1"' },
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.data.enabled, true);
  assert.equal(set.body.data.revision, 2);

  const readBack = await http(`${API}/admin/feature-flags`, { token: adminAll.token });
  assert.equal(readBack.body.data.items.find((f) => f.key === 'specific_herbicide_output_enabled').enabled, true);
});

// —— 隐藏帖子（复用社区可见性语义） ——
const communityPost = await community.service.createPost(
  USER_A,
  { title: '稗草防除经验交流', body: '今年雨水偏多，我按标签说明选择登记药剂，先看苗情再决定。', media_ids: [] },
  { idempotencyKey: 'gyi18-http-community-post' },
);

await group('[正控制] hidePost：经 HTTP 隐藏 ⇒ 社区公开读不可见、作者仍可见、审计保留', async () => {
  assert.equal((await community.service.getPost(USER_B, communityPost.id)).id, communityPost.id, '隐藏前他人可见');

  const hidden = await probe('hidePost', 'POST', `${API}/admin/posts/${communityPost.id}/hide`, {
    body: { reason: '示例：管理员隐藏违规帖子' },
    headers: { 'idempotency-key': newKey('hide'), 'if-match': `"${communityPost.revision}"` },
  });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.equal(hidden.body.data.accepted, true);

  // 社区**自己的**读口径：他人不可见（NOT_FOUND），作者仍可见（#15 既有语义）。
  let othersStatus = 200;
  try { await community.service.getPost(USER_B, communityPost.id); } catch (error) { othersStatus = error.status; }
  assert.equal(othersStatus, 404, '隐藏后他人公开读必须 NOT_FOUND');
  const authorView = await community.service.getPost(USER_A, communityPost.id);
  assert.equal(authorView.id, communityPost.id, '作者在自己的读路径仍可见（#15 既有口径，非本片缺陷）');

  const stored = await communityStore.getPost(communityPost.id);
  assert.equal(stored.visibility, 'hidden');
  assert.equal(stored.revision, communityPost.revision + 1);

  const audit = await allAuditItems();
  const hit = audit.filter((e) => e.action === 'post.hide');
  assert.equal(hit.length, 1, '隐藏恰好一条审计');
  assert.equal(hit[0].target_ref.type, 'post');
  assert.equal(hit[0].target_ref.id, communityPost.id);
});

await group('[正控制/反例] hidePost：默认装配下社区存储已接线 ⇒ 未知帖子 404，不谎报成功', async () => {
  // GY-I15（#15）阶段 2 起，`app.ts` 把**同一份**社区 store 交给后台 `hidePost`
  // （下架必须与社区读取面同源，否则"后台隐藏了帖子"在社区列表/详情侧不生效）。
  // 因此默认装配下未知帖子是 404 `NOT_FOUND`，而不是"存储未接线"的 503。
  // **real 模式仍整域 fail-closed 503**（见 tests/unit/admin-real-mode-fail-closed.test.mjs 的 34 条路由反例）。
  const res = await probe('hidePost', 'POST', `${API}/admin/posts/${UNKNOWN_UUID}/hide`, {
    api: defaultHttp, token: defaultAdminAll.token, note: '默认装配=社区已接线（未知帖子）',
    body: { reason: '示例' }, headers: { 'idempotency-key': newKey('hide0'), 'if-match': '"1"' },
  });
  assert.equal(res.status, 404, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'NOT_FOUND');
});

await group('[正控制] hidePost：默认装配（不注入任何 store）三方向源 ⇒ 已知帖 200 且审核域 withdrawn', async () => {
  // **F1 钉子**（切片①审查）：默认装配下社区 store 由 `app.ts:546` **只声明一次**，由
  // 社区服务（`:790`）、后台 `hidePost` 端口（`:805` 的回退）与审核域**同源内容权威**
  // （`:549-552`）三方共用。上面那条"未知帖子 404"钉不住它：`ops.hidePost` 在联动之前就抛
  // `NOT_FOUND` ⇒ "同源"与"两份 store 分叉"两种装配**同样是 404**。只有"**已知帖** ⇒ 200"能钉住：
  // 若日后删掉 `app.ts:805` 的 `?? withTakedownObserver(communityStore, …)` 回退，默认装配的
  // 后台帖子端口即缺线（503 `STORE_UNAVAILABLE`），或审核域权威读到另一份 store（503
  // `PROVIDER_UNAVAILABLE`），本组立刻变红。
  // 实例只注入**合成 pass 审核端口**（`tests/unit/community-fixtures.mjs` 既有写法，同
  // `tests/unit/community-http.test.mjs:72`）：审核端口不是 store，三段 store 接线保持默认。
  const post = await sameSourceApp.communityService.createPost(
    USER_A,
    { title: '稗草防除经验交流', body: '今年雨水偏多，我按标签说明选择登记药剂，先看苗情再决定。', media_ids: [] },
    { idempotencyKey: 'gyi18-http-same-source-post' },
  );
  assert.equal(post.visibility, 'published', '已知帖必须先真的公开可读（否则钉不住下架联动）');

  const hidden = await probe('hidePost', 'POST', `${API}/admin/posts/${post.id}/hide`, {
    api: sameSourceHttp, token: sameSourceAdmin.token, note: '默认装配=三方向源（已知帖子）',
    body: { reason: '示例：默认装配下架联动' },
    headers: { 'idempotency-key': newKey('hide-known'), 'if-match': `"${post.revision}"` },
  });
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.equal(hidden.body.data.accepted, true);

  // 下架联动的**审核域撤回**确实落到同一份内容上（若内容权威读到的是另一份 store，
  // 这里会以 `OBJECT_UNAVAILABLE` 抛错）；撤回标记是永久的，同一目标再撤回幂等返回 `withdrawn=true`。
  const withdrawn = await sameSourceApp.communityModerationLink.withdraw({
    actor: { userId: sameSourceAdmin.adminId, role: 'admin', authEpoch: 1 },
    target_ref: { type: 'post', id: post.id, revision: post.revision },
    reason_code: 'admin_hide',
  });
  assert.equal(withdrawn.withdrawn, true);

  // 社区读面读到的就是后台改的那一行（三方向源的社区侧证据）。
  const authorView = await sameSourceApp.communityService.getPost(USER_A, post.id);
  assert.equal(authorView.visibility, 'hidden');
  assert.equal(authorView.revision, post.revision + 1);
});

// —— 审计只读（**放在最后**：此时五类写操作都已发生） ——
await group('[正控制] listAuditEvents：五类写操作各留痕迹，且契约投影只输出合同 8 字段', async () => {
  const res = await probe('listAuditEvents', 'GET', `${API}/admin/audit-events`);
  assert.equal(res.status, 200);
  const items = res.body.data.items;
  const actions = new Set(items.map((item) => item.action));
  for (const expected of [
    'source.publish', 'source.withdraw', 'knowledge.publish', 'knowledge.withdraw',
    'registration.publish', 'restriction.publish',
    'category.update', 'account.suspend', 'job.cancel', 'flag.set', 'post.hide',
  ]) {
    assert.ok(actions.has(expected), `审计里应出现 ${expected}；实际：${[...actions].sort().join(', ')}`);
  }
  assert.ok(items.length >= 13, `审计条数应≥13，实际 ${items.length}`);
  for (const item of items) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ['action', 'created_at', 'id', 'reason_code', 'request_id', 'result', 'scope', 'target_ref'],
      '契约投影只能有合同 8 字段（内部 actor_id / target_hint 不得外泄）',
    );
  }
});

// ---------------------------------------------------------------- 反例（≥12 类）
await group('反例 1/2：无凭据 ⇒ 401；用户会话 ⇒ 403；缺 scope 的 admin 对 34 条路由一律 403', async () => {
  const anon = await http(`${API}/admin/categories`);
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, 'SESSION_REQUIRED');

  const asUser = await http(`${API}/admin/categories`, { token: userSession.token });
  assert.equal(asUser.status, 403);
  assert.equal(asUser.body.error.code, 'SCOPE_DENIED');

  const partial = await http(`${API}/admin/accounts`, { token: adminReadOnly.token });
  assert.equal(partial.status, 403);
  assert.equal(partial.body.error.code, 'SCOPE_DENIED');

  // 逐条核对：只有 sources:read 的 admin 对写路由也一律 403。
  for (const [method, path] of [
    ['POST', `${API}/admin/sources`], ['PATCH', `${API}/admin/categories/crop-rice`],
    ['POST', `${API}/admin/accounts/${USER_A.userId}/suspend`], ['GET', `${API}/admin/accounts`],
    ['GET', `${API}/admin/feature-flags`], ['POST', `${API}/admin/posts/${UNKNOWN_UUID}/hide`],
  ]) {
    const res = await http(path, {
      method, token: adminReadOnly.token,
      ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json', 'idempotency-key': newKey('partial'), 'if-match': '"1"' }, body: '{}' }),
    });
    assert.equal(res.status, 403, `${method} ${path} 应为 403`);
  }
});

await group('反例 3/4：未知 flag key ⇒ 400；安全语义 key ⇒ 400 **且留 denied 审计**', async () => {
  const unknown = await http(`${API}/admin/feature-flags/not_a_flag`, {
    method: 'PUT', token: adminAll.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('fk'), 'if-match': '"1"' },
    body: JSON.stringify({ enabled: true, reason: 'r' }),
  });
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  assert.equal(unknown.body.error.code, 'INVALID_REQUEST');

  const before = (await allAuditItems()).length;
  for (const key of ['hard_rules_enabled', 'moderation_enabled', 'auto_approve', 'allow_unverified_publish']) {
    const res = await http(`${API}/admin/feature-flags/${key}`, {
      method: 'PUT', token: adminAll.token,
      headers: { 'content-type': 'application/json', 'idempotency-key': newKey('fsafe'), 'if-match': '"1"' },
      body: JSON.stringify({ enabled: true, reason: 'r' }),
    });
    assert.equal(res.status, 400, `${key} 应为 400`);
    assert.ok(res.body.error.details.some((d) => d.code === 'SAFETY_CRITICAL_KEY'), `${key} 应给出安全语义标记`);
  }
  const after = await allAuditItems();
  const denied = after.slice(before).filter((e) => e.reason_code === 'flag_weakening_denied');
  assert.equal(denied.length, 4, '每次安全语义拒绝都必须留一条 denied 审计');
  for (const event of denied) assert.equal(event.result, 'denied');
});

await group('反例 5：注入"放宽语义"的 flag 分类表 ⇒ `buildApp` 期间即拒绝接线', async () => {
  const weakened = {
    ai_enabled: { gates: 'ai_capabilities', weakens_fail_closed: true, disables_hard_rules: false, allows_unverified_publish: false },
  };
  assert.throws(
    () => buildApp({
      config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
      store: createMemoryAuthStore(),
      adminInjection: { flagEffects: weakened },
    }),
    /不得关闭硬规则|放宽安全判定/,
    '带放宽语义的分类表必须在装配期被拒绝，服务不得带着它跑起来',
  );
  for (const bad of [
    { gates: 'x', weakens_fail_closed: false, disables_hard_rules: true, allows_unverified_publish: false },
    { gates: 'x', weakens_fail_closed: false, disables_hard_rules: false, allows_unverified_publish: true },
  ]) {
    assert.throws(
      () => buildApp({
        config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
        store: createMemoryAuthStore(),
        adminInjection: { flagEffects: { submissions_enabled: bad } },
      }),
      /不得关闭硬规则|放宽安全判定/,
    );
  }
  // 正控制：出厂分类表可以正常装配。
  assert.equal(typeof buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: createMemoryAuthStore(),
  }).adminOpsService.setFlag, 'function');
});

await group('反例 6：未知 category / account / job / post ⇒ 404 NOT_FOUND', async () => {
  const cases = [
    ['PATCH', `${API}/admin/categories/no-such`, JSON.stringify({ name: 'n', description: 'd', active: true })],
    ['POST', `${API}/admin/accounts/${UNKNOWN_UUID}/suspend`, JSON.stringify({ reason: 'r' })],
    ['POST', `${API}/admin/jobs/${UNKNOWN_UUID}/cancel`, JSON.stringify({ reason: 'r' })],
    ['POST', `${API}/admin/posts/${UNKNOWN_UUID}/hide`, JSON.stringify({ reason: 'r' })],
  ];
  for (const [method, path, body] of cases) {
    const res = await http(path, {
      method, token: adminAll.token,
      headers: { 'content-type': 'application/json', 'idempotency-key': newKey('nf'), 'if-match': '"1"' },
      body,
    });
    assert.equal(res.status, 404, `${method} ${path} 应为 404，实际 ${res.status}`);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  }
  // 通用资料的未知 id 同样 404。
  const src = await http(`${API}/admin/sources/${UNKNOWN_UUID}`, { token: adminAll.token });
  assert.equal(src.status, 404);
});

await group('反例 7（钉子）：非法 uuid ⇒ **400 INVALID_REQUEST**，不得并进"同形 404"组', async () => {
  // 这条钉住**两层分工**：HTTP 层判格式（400），服务层判存在性/归属（404）。
  // 与 #10/#106 的钉子同一口径：格式错误与"不存在"必须是**不同**的状态码与错误码，
  // 否则未来一次"统一成 404"的静默翻转会把格式错误也算成"目标不存在"。
  for (const bad of ['not-a-uuid', '123', `${UNKNOWN_UUID}x`, 'a-b-c']) {
    for (const path of [
      `${API}/admin/sources/${bad}`,
      `${API}/admin/accounts/${bad}/suspend`,
      `${API}/admin/jobs/${bad}/cancel`,
      `${API}/admin/posts/${bad}/hide`,
      `${API}/admin/knowledge/${bad}`,
    ]) {
      const method = /\/(suspend|cancel|hide)$/.test(path) ? 'POST' : 'GET';
      const res = await http(path, {
        method, token: adminAll.token,
        ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json', 'idempotency-key': newKey('bad'), 'if-match': '"1"' }, body: JSON.stringify({ reason: 'r' }) }),
      });
      assert.equal(res.status, 400, `${method} ${path} 非法 uuid 应为 400，实际 ${res.status}`);
      assert.equal(res.body.error.code, 'INVALID_REQUEST');
      assert.notEqual(res.status, 404, '格式错误不得被当成本"不存在"');
    }
  }
  // 对照：**合法 uuid 但不存在** ⇒ 404。两者必须可区分。
  const missing = await http(`${API}/admin/sources/${UNKNOWN_UUID}`, { token: adminAll.token });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  // 分类 id 是不透明字符串（不是 uuid）：合法形状但不存在 ⇒ 404（不是 400）。
  const catMissing = await http(`${API}/admin/categories/definitely-missing`, {
    method: 'PATCH', token: adminAll.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('catmiss'), 'if-match': '"1"' },
    body: JSON.stringify({ name: 'n', description: 'd', active: true }),
  });
  assert.equal(catMissing.status, 404);
  // 超长分类 id（>80）违反契约长度 ⇒ 400。
  const catTooLong = await http(`${API}/admin/categories/${'x'.repeat(81)}`, {
    method: 'PATCH', token: adminAll.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('catlong'), 'if-match': '"1"' },
    body: JSON.stringify({ name: 'n', description: 'd', active: true }),
  });
  assert.equal(catTooLong.status, 400);
});

await group('反例 8：`If-Match` 缺 ⇒ 428；非法 ⇒ 400；不匹配 ⇒ 409', async () => {
  const path = `${API}/admin/categories/crop-rice`;
  const send = (headers, body = { name: 'n', description: 'd', active: true }) =>
    http(path, { method: 'PATCH', token: adminAll.token, headers: { 'content-type': 'application/json', 'idempotency-key': newKey('im'), ...headers }, body: JSON.stringify(body) });

  const missing = await send({});
  assert.equal(missing.status, 428, JSON.stringify(missing.body));
  assert.equal(missing.body.error.code, 'REVISION_REQUIRED');

  for (const ifMatch of ['*', 'W/"1"', '"0"', '1', '"99999999999999999999999"']) {
    const res = await send({ 'if-match': ifMatch });
    assert.equal(res.status, 400, `If-Match=${ifMatch} 应为 400`);
    assert.equal(res.body.error.code, 'INVALID_REQUEST');
  }

  const stale = await send({ 'if-match': '"9"' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
});

await group('反例 9：`Idempotency-Key` 缺 ⇒ 400；过短 ⇒ 400', async () => {
  const path = `${API}/admin/sources`;
  const noKey = await http(path, {
    method: 'POST', token: adminAll.token,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(sourceInput()),
  });
  assert.equal(noKey.status, 400, JSON.stringify(noKey.body));
  assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const shortKey = await http(path, {
    method: 'POST', token: adminAll.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': 'short' }, body: JSON.stringify(sourceInput()),
  });
  assert.equal(shortKey.status, 400);
  assert.equal(shortKey.body.error.code, 'INVALID_REQUEST');
});

await group('反例 10/11：`limit` 超限 ⇒ 400；请求体多余字段 ⇒ 400（additionalProperties:false）', async () => {
  for (const limit of ['51', '0', 'abc', '1.5']) {
    const res = await http(`${API}/admin/sources?limit=${limit}`, { token: adminAll.token });
    assert.equal(res.status, 400, `limit=${limit} 应为 400`);
    assert.equal(res.body.error.code, 'INVALID_REQUEST');
  }
  const bad = await http(`${API}/admin/sources`, {
    method: 'POST', token: adminAll.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('extra') },
    body: JSON.stringify({ ...sourceInput(), unexpected_field: 1 }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_REQUEST');
  assert.ok(bad.body.error.details.some((d) => d.field === 'unexpected_field'));
  // 契约 CategoryInput 无 `type` ⇒ 想借编辑改类型也必须 400。
  const typeExtra = await http(`${API}/admin/categories/crop-rice`, {
    method: 'PATCH', token: adminAll.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('typex'), 'if-match': '"2"' },
    body: JSON.stringify({ name: 'n', description: 'd', active: true, type: 'species' }),
  });
  assert.equal(typeExtra.status, 400);
});

await group('反例 12：同键异体 ⇒ 409；同键同体并发 ⇒ 恰好一次生效 + 恰好一条审计', async () => {
  const path = `${API}/admin/sources`;
  const key = newKey('conflict');
  const bodyA = sourceInput({ title: '甲稿标题' });
  const bodyB = sourceInput({ title: '乙稿标题' });
  const first = await http(path, { method: 'POST', token: adminAll.token, headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(bodyA) });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const conflict = await http(path, { method: 'POST', token: adminAll.token, headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(bodyB) });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  // 并发同键同体：createCategory 走 editCategory（已有种子），用 edit 做并发。
  const raceKey = newKey('race');
  const before = (await allAuditItems()).length;
  const payload = JSON.stringify({ name: '并发名', description: '并发说明', active: true });
  const results = await Promise.all([1, 2, 3].map(() => http(`${API}/admin/categories/species-barnyardgrass`, {
    method: 'PATCH', token: adminAll.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': raceKey, 'if-match': '"1"' },
    body: payload,
  })));
  for (const res of results) assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(results[0].body, results[1].body, '同键同体并发必须收敛到同一响应');
  assert.equal(adminOpsStore.getCategory('species-barnyardgrass').revision, 2, '并发只能迁移一次');
  const after = await allAuditItems();
  assert.equal(after.length - before, 1, '并发只允许一条审计');
});

await group('反例 13：`hidePost` 已删除内容**不得复活**（社区 CAS 单向门 + 服务层如实拒绝）', async () => {
  const doomed = await community.service.createPost(
    USER_A, { title: '待删除帖子', body: '这条帖子会被删除，然后尝试隐藏。', media_ids: [] },
    { idempotencyKey: 'gyi18-http-doomed-post' },
  );
  const deleted = await community.service.deletePost(USER_A, doomed.id, { idempotencyKey: 'gyi18-http-delete', ifMatch: `"${doomed.revision}"` });
  assert.equal(deleted.accepted, true);
  const afterDelete = await communityStore.getPost(doomed.id);
  assert.equal(afterDelete.visibility, 'deleted');

  const res = await http(`${API}/admin/posts/${doomed.id}/hide`, {
    method: 'POST', token: adminAll.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('hide-deleted'), 'if-match': `"${afterDelete.revision}"` },
    body: JSON.stringify({ reason: '示例：试图隐藏已删除帖子' }),
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'OBJECT_UNAVAILABLE');
  const still = await communityStore.getPost(doomed.id);
  assert.equal(still.visibility, 'deleted', '已删除内容不得被复活');
  assert.equal(still.revision, afterDelete.revision, '被拒的隐藏不得改动修订');
});

await group('反例 14：越权/不存在对外**逐字节同形**（无 scope 调用方无法探测目标是否存在）', async () => {
  // 只有 sources:read 的 admin 打 accounts 路由：对"存在"和"不存在"的账号必须逐字节一致。
  const shapeOf = async (id) => {
    const res = await http(`${API}/admin/accounts/${id}/suspend`, {
      method: 'POST', token: adminReadOnly.token,
      headers: { 'content-type': 'application/json', 'idempotency-key': newKey('same'), 'if-match': '"1"' },
      body: JSON.stringify({ reason: 'r' }),
    });
    return { status: res.status, text: res.text };
  };
  const existing = await shapeOf(USER_A.userId);
  const missing = await shapeOf(UNKNOWN_UUID);
  assert.equal(existing.status, 403);
  assert.equal(missing.status, 403);
  // 两个响应体除了 meta.request_id（每个请求都不同）之外必须逐字节相同。
  const strip = (text) => text.replace(/"request_id":"[^"]+"/, '"request_id":"<id>"');
  assert.equal(strip(existing.text), strip(missing.text), '存在与不存在必须逐字节同形（防探测）');
});

await group('反例 15：出口深拷贝 —— 改响应嵌套字段动不了存储', async () => {
  const listed = await http(`${API}/admin/feature-flags`, { token: adminAll.token });
  const baseline = JSON.stringify(listed.body.data.items);
  listed.body.data.items[0].enabled = !listed.body.data.items[0].enabled;
  listed.body.data.items[0].revision = 999;
  const again = await http(`${API}/admin/feature-flags`, { token: adminAll.token });
  assert.equal(JSON.stringify(again.body.data.items), baseline, '改写响应后读回必须一致');
  const stored = adminOpsStore.listFlags();
  assert.ok(stored.every((f) => f.revision >= 1 && f.revision <= 2), '存储侧修订未被响应改写');
});

await group('反例 16：审计只可追加（无改删入口），且 `target_hint` 不外泄', async () => {
  const auditLog = wiredApp.adminOpsService.store.audit;
  assert.deepEqual(Object.keys(auditLog).sort(), ['append', 'count', 'list']);
  for (const forbidden of ['update', 'delete', 'remove', 'clear']) {
    assert.equal(auditLog[forbidden], undefined);
  }
  const fullLedger = await allAuditItems();
  for (const item of fullLedger) {
    assert.equal(Object.hasOwn(item, 'actor_id'), false);
    assert.equal(Object.hasOwn(item, 'target_hint'), false);
  }
  // 内部记录里主体与目标提示仍在（契约缺口兜底）。
  const record = auditLog.list()[0];
  assert.equal(typeof record.actor_id, 'string');
  assert.ok(record.target_hint === null || typeof record.target_hint === 'string');
});

// ---------------------------------------------------------------- 审计统一（装配缺陷回归）
// 背景（本片在集成回归里发现的**装配缺陷**）：阶段 1（资料生命周期）与阶段 1b（运营与开关）
// 各自在**服务层内**建了一个 `AdminRuntime` —— 两者单独看都对，只有把两者装配到同一个 app 时
// 才暴露「**两份审计台账**」：`GET /admin/audit-events` 是阶段 1 的操作、读内容 store 的审计流，
// 因此五类新写操作（分类/账号/作业/开关/隐藏帖子）的审计**读不到** ⇒ 审计漏记。
// 修法**只在装配层**（`app.ts` 建唯一一个 runtime 注入两个 store 工厂），**服务层代码未改**。
// 下面两条回归专门钉住它：一条按目标核对五类审计可读性，一条做**结构断言**（台账唯一）。
await group('[审计统一 · 回归] 五类新写操作的审计都必须可经 GET /admin/audit-events 读到（按目标核对）', async () => {
  const res = await probe('listAuditEvents', 'GET', `${API}/admin/audit-events`, { note: '审计统一回归' });
  assert.equal(res.status, 200);
  // 审计端点是分页的 ⇒ 断言必须作用于**整份台账**（翻完所有页），不能用第一页代替全部。
  const items = await allAuditItems();
  const actions = items.map((event) => event.action);
  for (const expected of ['category.update', 'account.suspend', 'job.cancel', 'flag.set', 'post.hide']) {
    assert.ok(
      actions.includes(expected),
      `五类新写操作的审计必须可读；缺 ${expected}（若两个 store 各有台账，这里必然读不到）`,
    );
  }
  // 不只判"有这个 action"，还要按目标核对（防串台）。
  const categoryRow = items.find((event) => event.action === 'category.update');
  assert.equal(categoryRow.scope, 'sources:write');
  assert.equal(categoryRow.target_ref, null, '契约 TargetRef.type 无 category 成员 ⇒ 合同口径为 null');
  const accountRow = items.find((event) => event.action === 'account.suspend');
  assert.equal(accountRow.scope, 'accounts:suspend');
  assert.equal(accountRow.target_ref, null);
  const jobRow = items.find((event) => event.action === 'job.cancel');
  assert.equal(jobRow.target_ref.type, 'job');
  assert.equal(jobRow.target_ref.id, JOB_QUEUED, '审计目标必须是被取消的那个作业');
  const hideRow = items.find((event) => event.action === 'post.hide');
  assert.equal(hideRow.target_ref.type, 'post');
  assert.equal(hideRow.target_ref.id, communityPost.id);
  // flag 的 `denied` 审计同样必须可读（安全语义拒绝要留痕）。
  const denied = items.filter((event) => event.reason_code === 'flag_weakening_denied');
  assert.equal(denied.length, 4, '4 次安全语义拒绝都必须可经 HTTP 读到');
  for (const event of denied) {
    assert.equal(event.result, 'denied');
    assert.equal(event.action, 'flag.set');
  }
});

await group('[审计统一 · 回归] 装配后审计台账**唯一**（结构断言 + 默认装配实跑；防将来再加一个 runtime）', async () => {
  // 结构断言：两个 store 必须共用**同一个** AuditLog 对象（对象标识，不是"内容相等"）。
  assert.equal(
    wiredApp.adminOpsService.store.runtime.audit,
    wiredApp.adminContentService.store.audit,
    '注入装配：阶段 1 与阶段 1b 必须共用同一份审计台账',
  );
  assert.equal(
    defaultApp.adminOpsService.store.runtime.audit,
    defaultApp.adminContentService.store.audit,
    '默认装配：阶段 1 与阶段 1b 必须共用同一份审计台账',
  );
  // 反证：两个独立 runtime 必然各有台账 —— 这正是本回归要防的形态。
  const independentA = createAdminRuntime();
  const independentB = createAdminRuntime();
  assert.notEqual(independentA.audit, independentB.audit, '两个独立 runtime 必然各有台账');

  // 默认装配（**未注入任何 store**）上实跑：`setFlag` 必须出现在阶段 1 的审计读端点里。
  // 本片起装配层会按 `FLAG_WIRING_BASELINE` 播种（ai_enabled 基线为 true）⇒ 这里改成
  // **真正改变取值**（true → false），否则同值设置按既有幂等语义不迁移、不记审计。
  const before = (await allAuditItems(defaultHttp, defaultAdminAll.token)).length;
  const set = await defaultHttp(`${API}/admin/feature-flags/ai_enabled`, {
    method: 'PUT', token: defaultAdminAll.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('unify'), 'if-match': '"1"' },
    body: JSON.stringify({ enabled: false, reason: '示例：审计统一回归' }),
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.data.enabled, false);
  const after = await allAuditItems(defaultHttp, defaultAdminAll.token);
  assert.equal(after.length, before + 1, '默认装配下 flag.set 必须出现在阶段 1 的审计读端点里');
  assert.ok(after.some((event) => event.action === 'flag.set'), 'flag.set 审计必须可经 HTTP 读到');

  // 再建一个**只注入端口、不注入 store**的实例：两个 store 都由 `app.ts` 自己构造，
  // 因此这一路**直接检验装配层的 runtime 共享**（上面的 wired 实例是测试自己注入的 store）。
  const portsAuth = createMemoryAuthStore();
  const portsApp = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: portsAuth,
    adminInjection: { jobPort: createMemoryAdminJobPort(jobSeed()), communityStore },
    communityInjection: { store: communityStore },
  });
  const portsOrigin = await portsApp.listen({ host: '127.0.0.1', port: 0 });
  const portsHttp = makeHttp(portsOrigin);
  const portsAdmin = await seedAdminSession(portsAuth, 'ports', ALL_SCOPES);
  assert.equal(
    portsApp.adminOpsService.store.runtime.audit,
    portsApp.adminContentService.store.audit,
    '端口注入实例：store 由 app.ts 自建，仍必须共用同一份审计台账',
  );

  // 三条**不依赖分类/账号种子**的写操作：其审计必须出现在阶段 1 的读端点里。
  // （同值设置按既有幂等语义不迁移、不记审计 ⇒ 这里对 ai_enabled 做真实取值变更。）
  const portsBefore = (await allAuditItems(portsHttp, portsAdmin.token)).length;
  const portsSet = await portsHttp(`${API}/admin/feature-flags/ai_enabled`, {
    method: 'PUT', token: portsAdmin.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('ports-flag'), 'if-match': '"1"' },
    body: JSON.stringify({ enabled: false, reason: '示例：审计统一回归' }),
  });
  assert.equal(portsSet.status, 200, JSON.stringify(portsSet.body));
  assert.equal(portsSet.body.data.enabled, false);
  const portsCancel = await portsHttp(`${API}/admin/jobs/${JOB_QUEUED}/cancel`, {
    method: 'POST', token: portsAdmin.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('ports-job'), 'if-match': '"1"' },
    body: JSON.stringify({ reason: '示例：审计统一回归' }),
  });
  assert.equal(portsCancel.status, 200, JSON.stringify(portsCancel.body));
  const portsPost = await community.service.createPost(
    USER_A, { title: '审计统一回归用帖', body: '用于审计统一回归的帖子正文。', media_ids: [] },
    { idempotencyKey: 'gyi18-http-unify-post' },
  );
  const portsHide = await portsHttp(`${API}/admin/posts/${portsPost.id}/hide`, {
    method: 'POST', token: portsAdmin.token,
    headers: { 'content-type': 'application/json', 'idempotency-key': newKey('ports-hide'), 'if-match': `"${portsPost.revision}"` },
    body: JSON.stringify({ reason: '示例：审计统一回归' }),
  });
  assert.equal(portsHide.status, 200, JSON.stringify(portsHide.body));

  const portsAfter = await allAuditItems(portsHttp, portsAdmin.token);
  const portsActions = portsAfter.map((event) => event.action);
  for (const expected of ['flag.set', 'job.cancel', 'post.hide']) {
    assert.ok(
      portsActions.includes(expected),
      `端口注入实例：${expected} 审计必须可经 HTTP 读到（store 由 app.ts 自建 ⇒ 直接检验装配层共享）`,
    );
  }
  assert.equal(portsAfter.length, portsBefore + 3, '三次写操作恰好三条新审计，且都在同一台账里');
});

// ---------------------------------------------------------------- 汇总
console.log('\n=== 34 项 HTTP 实测映射表（operationId / method / path / 实测状态码 / 错误码） ===');
const seen = new Set();
for (const row of mappingRows) {
  const dup = seen.has(row.operationId) ? ' (再次调用)' : '';
  seen.add(row.operationId);
  console.log(`${row.operationId.padEnd(28)} ${row.method.padEnd(6)} ${row.path.padEnd(38)} -> ${String(row.status).padEnd(4)} ${row.code}${row.note ? '  # ' + row.note : ''}${dup}`);
}
console.log(`\n映射表覆盖 operationId 数：${seen.size} / 34`);
const missingOps = [];
for (const id of [
  ...FAMILY_CASES.flatMap((f) => [f.list, f.create, f.get, f.edit, f.publish, f.withdraw]),
  'listAuditEvents', 'listAdminCategories', 'editCategory', 'listAdminUsers', 'suspendUser',
  'listAdminJobs', 'cancelAdminJob', 'listFlags', 'setFlag', 'hidePost',
]) {
  if (!seen.has(id)) missingOps.push(id);
}
if (missingOps.length > 0) {
  console.log(`未覆盖：${missingOps.join(', ')}`);
  failures.push(`映射表缺少 ${missingOps.length} 个 operationId：${missingOps.join(', ')}`);
}

console.log(`\nPASS 组数=${passed}，FAIL 组数=${failures.length}`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
