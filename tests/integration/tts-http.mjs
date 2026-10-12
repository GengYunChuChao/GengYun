// GY-I13 阶段 2a · TTS 合成的**真实本机回环 HTTP** 集成证据
//   —— 合成身份（真实 stub 登录管道 / 直接播种会话）+ 替身提供者 + 内存 store + 真实 127.0.0.1 套接字。
//
// 被测对象：`services/api/src/routes/synthesis.ts`（阶段 2a 新增的路由插件）。
// 装配方式：**测试内自建应用** —— 复用生产装配 `buildApp`（错误封套 / notFoundHandler /
//   `removeAdditional:false` / 请求身份槽位），再注册本域路由插件；**不触碰 `app.ts`**。
//
// 口径：
//  - 纯回环：只连 `127.0.0.1:<随机端口>`，**不发出任何对外/付费请求**；不发凭据、不读 `.env`。
//  - 提供者与产物都是**明确标注的替身**：产物是明文标注的**非音频**占位，不落盘、不写对象存储。
//  - 契约里该域**只有 POST**：读 JobState 的平台级 `GET /jobs/{id}` 未装配 ⇒ 任务终态**只能**经
//    注入的 store 观察（本脚本显式标注这一点，不冒充 HTTP 读面）。
//  - 真实 TTS 样本为 0 ⇒ 本脚本**不产生也不声称**任何音色/自然度/听感或能力结论。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';
import { createAuthGuards } from '../../services/api/src/auth/middleware.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createWechatIdentityProvider, STUB_LOOKUP_KEY } from '../../services/api/src/auth/wechat.ts';
import { registerSynthesisRoutes } from '../../services/api/src/routes/synthesis.ts';
import { createMemorySynthesisStore } from '../../services/api/src/tts/store.ts';
import { createMemoryCheckedContentPort } from '../../services/api/src/tts/content.ts';
import { SUBSTITUTE_ARTIFACT_CONTENT_TYPE, createStubTtsProvider } from '../../services/api/src/tts/provider.ts';
import { createSubstituteMediaPort } from '../../services/api/src/tts/media.ts';
import { TtsLocalInputError } from '../../services/api/src/tts/live-ports.ts';

const SYNTHESIS_URL = '/api/v1/speech/synthesis';
const LOGIN_URL = '/api/v1/auth/wechat';
const REF = { type: 'answer', id: 'answer-http-approved', revision: 3 };
const TEXT = '合成用例文本：稻田稗草三到五叶期，每亩用 25% 制剂 40 毫升。';
const LONG_TEXT = '药'.repeat(101);

/** 真实模式所需的合成环境（不落盘、不外发；只用于驱动本域 provider 选择与 meta）。 */
const REAL_ENV = {
  DATABASE_URL: 'postgres://synthetic-local/db',
  SESSION_SIGNING_KEY: 'synthetic-signing-key-000000000001',
  DELETION_LEDGER_KEY: 'synthetic-ledger-key-000000000001',
  WECHAT_APP_ID: 'wx-synthetic-local',
  WECHAT_APP_SECRET: 'synthetic-wechat-secret',
  OBJECT_STORAGE_ENDPOINT: 'https://storage.synthetic.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-secret-key',
};

// ---------------------------------------------------------------- 夹具与计数器

const entries = [
  { type: 'answer', id: 'answer-http-approved', revision: 3, auditState: 'approved', text: TEXT },
  { type: 'answer', id: 'answer-http-alt', revision: 4, auditState: 'approved', text: '另一份已核对内容。' },
  { type: 'answer', id: 'answer-http-long', revision: 1, auditState: 'approved', text: LONG_TEXT },
  { type: 'answer', id: 'answer-http-pending', revision: 1, auditState: 'pending', text: '未核对文本（绝不得朗读）' },
  { type: 'answer', id: 'answer-http-rejected', revision: 2, auditState: 'rejected', text: '已驳回文本' },
  { type: 'answer', id: 'answer-http-quarantined', revision: 1, auditState: 'quarantined', text: '已隔离文本' },
  { type: 'answer', id: 'answer-http-unknown', revision: 1, auditState: 'some_new_state', text: '状态不明文本' },
  { type: 'answer', id: 'answer-http-foreign', revision: 1, auditState: 'approved', ownerUserId: null, text: '他人内容' },
  { type: 'answer', id: 'answer-http-notext', revision: 1, auditState: 'approved', text: '' },
];
const foreignEntry = entries.find((entry) => entry.id === 'answer-http-foreign');

const counters = { providerCalls: 0, insertJobs: 0 };

/**
 * 计数用 store：`insertJobs` = 真正落库的任务数（证明「被拒请求不建任务」）。
 */
function countingStore() {
  const base = createMemorySynthesisStore();
  return {
    ...base,
    async insertJob(row) {
      counters.insertJobs += 1;
      return base.insertJob(row);
    },
  };
}

/**
 * 计数用提供者：**替身产物**（非音频、明确标注），并复刻**真实适配器**的本地文本上限
 * （>100 码点 ⇒ `TtsLocalInputError`，**fail-closed 不截断**），用于在 HTTP 层观察该拒绝
 * 如何在任务终态呈现（受理仍是 202：上限属提供者侧口径，契约无此上限）。
 */
function countingProvider() {
  const stub = createStubTtsProvider({});
  return {
    executionMode: 'stub',
    providerVersion: 'stub-http-integration',
    note: '集成测试替身提供者（非真实音频、非真实供应商；复刻真实适配器的文本上限 fail-closed）',
    available: true,
    unavailableReason: null,
    async synthesize(input) {
      counters.providerCalls += 1;
      if ([...input.text].length > 100) {
        throw new TtsLocalInputError('INVALID_REQUEST', '待合成文本超过提供者上限（不截断，fail-closed）');
      }
      return stub.synthesize(input);
    },
  };
}

// ---------------------------------------------------------------- 应用装配

function stubConfig() {
  return loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
}

async function bootStubApp() {
  const config = stubConfig();
  const authStore = createMemoryAuthStore();
  const now = () => new Date();
  const guards = createAuthGuards({ store: authStore, now });
  const app = buildApp({ config, store: authStore, idempotency: createMemoryIdempotencyStore(), now });
  const store = countingStore();
  const media = createSubstituteMediaPort();
  const service = registerSynthesisRoutes(app, config, null, guards, {
    store,
    provider: countingProvider(),
    media,
    content: createMemoryCheckedContentPort(entries),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  return { app, config, authStore, guards, store, media, service, base: `http://127.0.0.1:${port}` };
}

/** real 模式：本域 provider 走 fail-closed 实现；合成身份用注入的替身微信提供者（零外呼）。 */
async function bootRealApp() {
  const config = loadConfig({ APP_EXECUTION_MODE: 'real', LOG_LEVEL: 'silent', ...REAL_ENV });
  const authStore = createMemoryAuthStore();
  const now = () => new Date();
  const guards = createAuthGuards({ store: authStore, now });
  const app = buildApp({
    config,
    store: authStore,
    idempotency: createMemoryIdempotencyStore(),
    now,
    wechat: createWechatIdentityProvider({ executionMode: 'stub', appId: null, appSecret: null, lookupKey: STUB_LOOKUP_KEY }),
  });
  const store = countingStore();
  const service = registerSynthesisRoutes(app, config, null, guards, {
    store,
    // 即使**已核对内容**可用（注入已核对条目），real 模式仍必须因缺凭据而在受理前 503。
    content: createMemoryCheckedContentPort([
      { type: 'answer', id: REF.id, revision: REF.revision, auditState: 'approved', text: TEXT },
    ]),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  return { app, config, authStore, guards, store, service, base: `http://127.0.0.1:${port}` };
}

/** 直接播种合成身份 + 会话（不发任何外呼）：返回 `Bearer` 用的原始令牌。 */
async function seedSession(authStore, label) {
  const user = await authStore.createUser(`synthetic-lookup-${label}-0000000000000000`);
  const token = `synthetic-http-token-${label}-${randomUUID()}`;
  await authStore.createSession({
    userId: user.id,
    audience: 'user',
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return { userId: user.id, token };
}

// ---------------------------------------------------------------- HTTP 客户端

async function login(base, code, idempotencyKey) {
  const response = await fetch(`${base}${LOGIN_URL}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ code }),
  });
  const json = await response.json();
  return { status: response.status, token: json?.data?.access_token ?? null, json };
}

async function call(base, method, path, options = {}) {
  const headers = {};
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.key !== undefined) headers['idempotency-key'] = options.key;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  Object.assign(headers, options.headers ?? {});
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

function body(ref, overrides = {}) {
  return { checked_content_ref: { ...ref }, locale: 'zh-CN', ...overrides };
}

function errorOf(response) {
  return response.json?.error ?? null;
}

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `tts-http-key-${String(keyCounter).padStart(6, '0')}`;
}

// ---------------------------------------------------------------- 检查驱动

const summary = { pass: 0, fail: 0 };
async function check(label, fn) {
  try {
    const observed = await fn();
    summary.pass += 1;
    console.log(`PASS  ${label}${observed ? `  [${observed}]` : ''}`);
  } catch (error) {
    summary.fail += 1;
    console.log(`FAIL  ${label} → ${error?.message ?? error}`);
  }
}

function assertEnvelope(response, status, code) {
  assert.equal(response.status, status, `HTTP 状态应为 ${status}，实际 ${response.status}（${response.text.slice(0, 200)}）`);
  const error = errorOf(response);
  assert.notEqual(error, null, '契约错误封套缺失');
  assert.equal(error.code, code, `契约错误码应为 ${code}，实际 ${error.code}`);
  assert.equal(typeof error.message, 'string');
  assert.equal(typeof error.retryable, 'boolean');
  assert.ok(Array.isArray(error.details));
  assert.deepEqual(Object.keys(response.json).sort(), ['error', 'meta']);
  assert.deepEqual(Object.keys(response.json.meta).sort(), ['contract_version', 'execution_mode', 'request_id']);
  assert.equal(response.json.meta.contract_version, '1.0.0');
  return error;
}

// ---------------------------------------------------------------- 主体

const stub = await bootStubApp();
const real = await bootRealApp();
const failMessages = [];

try {
  // 合成身份：A 走**真实 stub 登录管道**；B 直接播种会话（零外呼）。
  const loginA = await login(stub.base, 'synthetic-http-a', 'synthetic-login-key-0001');
  assert.equal(loginA.status, 200, `合成身份登录失败：${JSON.stringify(loginA.json).slice(0, 200)}`);
  assert.equal(typeof loginA.token, 'string');
  const userA = loginA.token;
  const identityB = await seedSession(stub.authStore, 'b');
  const userB = identityB.token;
  const realIdentity = await seedSession(real.authStore, 'real');
  // 「他人内容」的归属：指向 B（登录后才能确定），经核对源条目引用在读取时生效。
  foreignEntry.ownerUserId = identityB.userId;

  console.log(`--- 应用：stub=${stub.base}（真实 stub 登录 + 播种会话）｜real=${real.base}（播种会话）---`);

  // ---- C01 路由范围：契约只有 POST ----
  await check('C01 路由范围·GET/DELETE /speech/synthesis 不存在（契约只有 POST，未自造读/删端点）', async () => {
    const get = await call(stub.base, 'GET', SYNTHESIS_URL, { token: userA });
    const del = await call(stub.base, 'DELETE', SYNTHESIS_URL, { token: userA });
    assertEnvelope(get, 404, 'NOT_FOUND');
    assertEnvelope(del, 404, 'NOT_FOUND');
    return `GET=${get.status} DELETE=${del.status}`;
  });

  // ---- C02 鉴权 ----
  await check('C02 鉴权·无令牌 ⇒ 401 SESSION_REQUIRED；非法令牌 ⇒ 401 SESSION_EXPIRED', async () => {
    const none = await call(stub.base, 'POST', SYNTHESIS_URL, { key: nextKey(), body: body(REF) });
    assertEnvelope(none, 401, 'SESSION_REQUIRED');
    const bad = await call(stub.base, 'POST', SYNTHESIS_URL, { token: 'not-a-real-token', key: nextKey(), body: body(REF) });
    assertEnvelope(bad, 401, 'SESSION_EXPIRED');
    return `none=${none.status} bad=${bad.status}`;
  });

  // ---- C03 202 + JobEnvelope 形状 ----
  let positiveJobId = null;
  await check('C03 202·JobEnvelope 形状（data.kind=synthesis、meta 齐备、ETag/Cache-Control 同口径）', async () => {
    const response = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body(REF) });
    assert.equal(response.status, 202, `应 202，实际 ${response.status}`);
    assert.equal(response.headers.get('etag'), '"1"');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(response.json).sort(), ['data', 'meta']);
    const meta = response.json.meta;
    assert.deepEqual(Object.keys(meta).sort(), ['contract_version', 'execution_mode', 'request_id']);
    assert.equal(meta.contract_version, '1.0.0');
    assert.equal(meta.execution_mode, 'stub');
    assert.match(meta.request_id, /^[0-9a-f-]{36}$/);
    const job = response.json.data;
    assert.deepEqual(
      Object.keys(job).sort(),
      ['created_at', 'deadline_at', 'error_code', 'id', 'kind', 'result', 'revision', 'state', 'target_ref'],
    );
    assert.equal(job.kind, 'synthesis');
    assert.equal(job.state, 'queued');
    assert.equal(job.result, null);
    assert.equal(job.error_code, null);
    assert.equal(job.revision, 1);
    assert.deepEqual(job.target_ref, REF);
    positiveJobId = job.id;
    return `202 etag=${response.headers.get('etag')} state=${job.state}`;
  });

  // ---- C04/C05/C06 幂等 ----
  await check('C04 幂等·同键同体重放 ⇒ 同一 job（不新增任务/不新增提供者调用）', async () => {
    const key = nextKey();
    const before = { ...counters };
    const first = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key, body: body(REF) });
    const second = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key, body: body(REF) });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(second.json.data.id, first.json.data.id);
    assert.equal(counters.insertJobs - before.insertJobs, 1);
    await stub.service.settle();
    const third = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key, body: body(REF) });
    assert.equal(third.json.data.id, first.json.data.id);
    assert.equal(counters.insertJobs - before.insertJobs, 1, '重放不得新建任务');
    return `job=${first.json.data.id.slice(0, 8)}… 重放3次任务数=1`;
  });

  await check('C05 幂等·同键异体（不同 revision）⇒ 409 IDEMPOTENCY_CONFLICT，不产生第二个任务', async () => {
    const key = nextKey();
    const before = { ...counters };
    const first = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key, body: body(REF) });
    assert.equal(first.status, 202);
    const conflict = await call(stub.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key,
      body: body({ type: 'answer', id: 'answer-http-alt', revision: 4 }),
    });
    assertEnvelope(conflict, 409, 'IDEMPOTENCY_CONFLICT');
    assert.equal(counters.insertJobs - before.insertJobs, 1, '同键异体不得产生第二个任务');
    return `first=202 conflict=${conflict.status}`;
  });

  await check('C06 幂等并发·同键同体两请求 ⇒ 恰好 1 个任务、恰好 1 次提供者调用、同一 job', async () => {
    const key = nextKey();
    const before = { ...counters };
    const [a, b] = await Promise.all([
      call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key, body: body(REF) }),
      call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key, body: body(REF) }),
    ]);
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.equal(a.json.data.id, b.json.data.id);
    assert.equal(counters.insertJobs - before.insertJobs, 1, `落库任务数应为 1，实际 ${counters.insertJobs - before.insertJobs}`);
    await stub.service.settle();
    assert.equal(counters.providerCalls - before.providerCalls, 1, `提供者调用应为 1，实际 ${counters.providerCalls - before.providerCalls}`);
    return `任务+${counters.insertJobs - before.insertJobs} 提供者调用+${counters.providerCalls - before.providerCalls}`;
  });

  // ---- C07..C12 只播报经核对内容（拒绝组；全程 0 任务 / 0 提供者调用）----
  const refusalBefore = { ...counters };
  await check('C07 反例·未核对/待审 pending ⇒ 422 INPUT_UNCERTAIN（AUDIT_PENDING）', async () => {
    const response = await call(stub.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-pending', revision: 1 }),
    });
    const error = assertEnvelope(response, 422, 'INPUT_UNCERTAIN');
    assert.equal(error.details[0]?.code, 'AUDIT_PENDING');
    return `${response.status} ${error.code}/${error.details[0]?.code}`;
  });

  await check('C08 反例·已驳回 rejected ⇒ 409 OBJECT_UNAVAILABLE（AUDIT_REJECTED）', async () => {
    const response = await call(stub.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-rejected', revision: 2 }),
    });
    const error = assertEnvelope(response, 409, 'OBJECT_UNAVAILABLE');
    assert.equal(error.details[0]?.code, 'AUDIT_REJECTED');
    return `${response.status} ${error.code}/${error.details[0]?.code}`;
  });

  await check('C09 反例·已隔离 quarantined ⇒ 409 OBJECT_UNAVAILABLE（AUDIT_QUARANTINED）', async () => {
    const response = await call(stub.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-quarantined', revision: 1 }),
    });
    const error = assertEnvelope(response, 409, 'OBJECT_UNAVAILABLE');
    assert.equal(error.details[0]?.code, 'AUDIT_QUARANTINED');
    return `${response.status} ${error.code}/${error.details[0]?.code}`;
  });

  await check('C10 反例·取不到核对状态（未知状态值）⇒ 409 OBJECT_UNAVAILABLE（AUDIT_STATE_UNREADABLE）', async () => {
    const response = await call(stub.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-unknown', revision: 1 }),
    });
    const error = assertEnvelope(response, 409, 'OBJECT_UNAVAILABLE');
    assert.equal(error.details[0]?.code, 'AUDIT_STATE_UNREADABLE');
    return `${response.status} ${error.code}/${error.details[0]?.code}`;
  });

  await check('C11 反例·核对通过但无可朗读正文 ⇒ 409 OBJECT_UNAVAILABLE（CONTENT_UNREADABLE）', async () => {
    const response = await call(stub.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-notext', revision: 1 }),
    });
    const error = assertEnvelope(response, 409, 'OBJECT_UNAVAILABLE');
    assert.equal(error.details[0]?.code, 'CONTENT_UNREADABLE');
    return `${response.status} ${error.code}/${error.details[0]?.code}`;
  });

  await check('C12 归属·他人内容 ⇒ 404 NOT_FOUND，且与「不存在」封套**逐字节同形**', async () => {
    const foreign = await call(stub.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-foreign', revision: 1 }),
    });
    const missing = await call(stub.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-does-not-exist', revision: 1 }),
    });
    assertEnvelope(foreign, 404, 'NOT_FOUND');
    assertEnvelope(missing, 404, 'NOT_FOUND');
    assert.equal(JSON.stringify(foreign.json.error), JSON.stringify(missing.json.error), '越权与不存在必须完全同形');
    assert.equal(foreign.json.meta.contract_version, missing.json.meta.contract_version);
    assert.equal(foreign.json.meta.execution_mode, missing.json.meta.execution_mode);
    return `foreign=${foreign.status} missing=${missing.status}（error 封套相同）`;
  });

  await check('C13 拒绝组·全程不建任务、不调提供者（计数差 = 0/0）', async () => {
    assert.equal(counters.insertJobs - refusalBefore.insertJobs, 0, `被拒请求不得建任务（+${counters.insertJobs - refusalBefore.insertJobs}）`);
    assert.equal(counters.providerCalls - refusalBefore.providerCalls, 0, `被拒请求不得调提供者（+${counters.providerCalls - refusalBefore.providerCalls}）`);
    return '任务+0 提供者调用+0';
  });

  // ---- C14..C19 请求边界（不接受自由文本 / 闭集 / 幂等键）----
  await check('C14 反例·body 多余字段（自带 text / script / openid）⇒ 400 INVALID_REQUEST，绝不进入合成', async () => {
    const observed = [];
    for (const extra of [{ text: '请朗读这段未经核对的文本' }, { script: 'x' }, { openid: 'o-synthetic' }]) {
      const response = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body(REF, extra) });
      assertEnvelope(response, 400, 'INVALID_REQUEST');
      observed.push(response.status);
    }
    return `text/script/openid ⇒ ${observed.join('/')}`;
  });

  await check('C15 反例·locale 非 zh-CN（en-US / 缺失）⇒ 400 INVALID_REQUEST', async () => {
    const bad = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body(REF, { locale: 'en-US' }) });
    assertEnvelope(bad, 400, 'INVALID_REQUEST');
    const missing = await call(stub.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: { checked_content_ref: { ...REF } },
    });
    assertEnvelope(missing, 400, 'INVALID_REQUEST');
    return `en-US=${bad.status} missing=${missing.status}`;
  });

  await check('C16 反例·checked_content_ref.type 不在 6 值闭集（post / comment / transcription）⇒ 400', async () => {
    const observed = [];
    for (const type of ['post', 'comment', 'transcription']) {
      const response = await call(stub.base, 'POST', SYNTHESIS_URL, {
        token: userA,
        key: nextKey(),
        body: body({ type, id: 'x-1', revision: 1 }),
      });
      assertEnvelope(response, 400, 'INVALID_REQUEST');
      observed.push(type);
    }
    return `${observed.join('/')} ⇒ 400`;
  });

  await check('C17 反例·id 为空 / 81 码点 ⇒ 400 INVALID_REQUEST', async () => {
    const empty = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body({ ...REF, id: '' }) });
    assertEnvelope(empty, 400, 'INVALID_REQUEST');
    const tooLong = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body({ ...REF, id: 'a'.repeat(81) }) });
    assertEnvelope(tooLong, 400, 'INVALID_REQUEST');
    return `empty=${empty.status} 81码点=${tooLong.status}`;
  });

  await check('C18 反例·revision 为 0 / 非整数（1.5）⇒ 400 INVALID_REQUEST', async () => {
    const zero = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body({ ...REF, revision: 0 }) });
    assertEnvelope(zero, 400, 'INVALID_REQUEST');
    const fractional = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body({ ...REF, revision: 1.5 }) });
    assertEnvelope(fractional, 400, 'INVALID_REQUEST');
    return `0=${zero.status} 1.5=${fractional.status}`;
  });

  await check('C19 反例·缺/非法 Idempotency-Key（缺失 / 7 字符 / 129 字符）⇒ 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const missing = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, body: body(REF) });
    assertEnvelope(missing, 400, 'IDEMPOTENCY_KEY_REQUIRED');
    const short = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key: 'short7!', body: body(REF) });
    assertEnvelope(short, 400, 'IDEMPOTENCY_KEY_REQUIRED');
    const long = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key: 'k'.repeat(129), body: body(REF) });
    assertEnvelope(long, 400, 'IDEMPOTENCY_KEY_REQUIRED');
    return `${missing.status}/${short.status}/${long.status}`;
  });

  // ---- C20 If-Match 依据 + C21 revision 绑定 ----
  await check('C20 依据说明·该端点契约未声明 If-Match（x-version-required:false）⇒ 带头照常受理（revision 绑定只在 body）', async () => {
    const response = await call(stub.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body(REF),
      headers: { 'if-match': '"3"' },
    });
    assert.equal(response.status, 202, `带未声明的 If-Match 头应仍 202（契约无该参数），实际 ${response.status}`);
    assert.equal(response.headers.get('etag'), '"1"', 'ETag 应为任务 revision');
    return 'If-Match="3" ⇒ 202（契约未声明该参数，未据此发 409/428）';
  });

  await check('C21 revision 绑定·传入 revision 与内容当前 revision 不一致 ⇒ 409 REVISION_CONFLICT', async () => {
    const stale = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body({ ...REF, revision: 2 }) });
    const error = assertEnvelope(stale, 409, 'REVISION_CONFLICT');
    assert.equal(error.details[0]?.code, 'REVISION_MISMATCH');
    const ahead = await call(stub.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body({ ...REF, revision: 9 }) });
    assertEnvelope(ahead, 409, 'REVISION_CONFLICT');
    return `rev2=${stale.status} rev9=${ahead.status}`;
  });

  // ---- C22/C23 正控制（终态只能经注入 store 观察：读面是契约缺口）----
  await check('C22 正控制·202 受理 → 完成 → Synthesis 四字段（经注入 store 观察；HTTP 读面属契约缺口）', async () => {
    assert.notEqual(positiveJobId, null, 'C03 未产出任务');
    await stub.service.settle();
    const job = await stub.store.getJob(positiveJobId);
    assert.notEqual(job, null);
    assert.equal(job.state, 'succeeded');
    assert.equal(job.errorCode, null);
    const synthesis = await stub.store.getSynthesis(job.synthesisId);
    assert.notEqual(synthesis, null);
    assert.equal(typeof synthesis.id, 'string');
    assert.equal(synthesis.revision, 1);
    assert.deepEqual({ ...synthesis.checkedContentRef }, REF);
    assert.match(synthesis.mediaId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    return `job=${job.state} synthesis.revision=${synthesis.revision} media_id=${synthesis.mediaId.slice(0, 8)}…`;
  });

  await check('C23 产物不落盘·替身标注产物、非 audio/*、字节不落盘（内存只登记摘要）', async () => {
    await stub.service.settle();
    const job = await stub.store.getJob(positiveJobId);
    const synthesis = await stub.store.getSynthesis(job.synthesisId);
    const described = await stub.media.describeObject(synthesis.mediaId);
    assert.notEqual(described, null);
    assert.equal(described.substitute, true, '必须是替身标注产物');
    assert.equal(described.contentType, SUBSTITUTE_ARTIFACT_CONTENT_TYPE);
    assert.equal(described.contentType.toLowerCase().startsWith('audio/'), false);
    assert.deepEqual(Object.keys(described).sort(), ['byteLength', 'contentType', 'note', 'substitute']);
    assert.equal(described.byteLength > 0, true);
    assert.match(described.note, /非真实音频/);
    return `contentType=${described.contentType} bytes=${described.byteLength}（无音频/无落盘）`;
  });

  // ---- C24 文本上限属提供者侧口径 ----
  await check('C24 文本上限·101 码点 ⇒ HTTP 仍 202（契约无此上限），执行期 failed + INVALID_REQUEST 且不截断', async () => {
    const response = await call(stub.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-long', revision: 1 }),
    });
    assert.equal(response.status, 202, '受理层不做文本长度判断（上限属提供者侧口径）');
    await stub.service.settle();
    const job = await stub.store.getJob(response.json.data.id);
    assert.equal(job.state, 'failed');
    assert.equal(job.errorCode, 'INVALID_REQUEST');
    const synthesis = await stub.store.getSynthesis(job.synthesisId);
    assert.equal(synthesis, null, '不得产出记录、不得截断后当成功');
    return `202 → ${job.state}/${job.errorCode}`;
  });

  // ---- C25 real 缺凭据 ----
  await check('C25 real 缺凭据 ⇒ 受理前 503 PROVIDER_UNAVAILABLE（不建任务、不调提供者、不回退替身）', async () => {
    const before = { ...counters };
    const response = await call(real.base, 'POST', SYNTHESIS_URL, {
      token: realIdentity.token,
      key: nextKey(),
      body: body(REF),
    });
    assertEnvelope(response, 503, 'PROVIDER_UNAVAILABLE');
    assert.equal(counters.insertJobs - before.insertJobs, 0, '不得排队/建任务');
    assert.equal(counters.providerCalls - before.providerCalls, 0, '不得调用提供者');
    assert.equal(response.json.meta.execution_mode, 'real');
    return `503 PROVIDER_UNAVAILABLE（已核对内容可用仍被拒） execution_mode=real`;
  });

  // ---- C26 零端口注入（源码范围）----
  await check('C26 范围·路由文件不 import createLiveTtsProvider / live-ports（应用装配路径零端口注入）', async () => {
    const source = readFileSync(new URL('../../services/api/src/routes/synthesis.ts', import.meta.url), 'utf8');
    // 只检查**代码**（先剥掉注释与文档块）：注释里出现这些名字是刻意说明，不算 import。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/createLiveTtsProvider/.test(code), false, '路由代码不得引用真实适配器的端口构造器');
    assert.equal(/live-ports/.test(code), false, '路由代码不得引用端口定义模块');
    assert.equal(/requireUser/.test(code), true);
    assert.equal(/buildMeta/.test(code), true);
    assert.equal(/createTtsProvider\(\{ executionMode: mode \}\)/.test(code), true);
    return '代码（去注释）无 createLiveTtsProvider / 无 live-ports';
  });
} catch (error) {
  summary.fail += 1;
  failMessages.push(`未捕获异常：${error?.stack ?? error}`);
  console.log(`FAIL  未捕获异常 → ${error?.message ?? error}`);
} finally {
  await new Promise((resolve) => stub.app.close(resolve));
  await new Promise((resolve) => real.app.close(resolve));
}

console.log('---');
console.log(`CHECKS pass=${summary.pass} fail=${summary.fail}`);
console.log(
  `SUMMARY counters: providerCalls=${counters.providerCalls} insertJobs=${counters.insertJobs}（含正控制与幂等用例的正常用量）`,
);
if (summary.fail > 0) {
  for (const message of failMessages) console.log(message);
  console.log('RESULT=FAIL');
  process.exitCode = 1;
} else {
  console.log('RESULT=PASS 真实本机回环 HTTP；合成身份 + 替身提供者 + 内存 store；未发出任何对外/付费请求');
  console.log('SCOPE=http_loopback_only; 读面（平台级 GET /jobs/{id}）未装配，任务终态经注入 store 观察；真实 TTS 样本 0，不声称任何质量结论');
}
