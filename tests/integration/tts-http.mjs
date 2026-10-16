// GY-I13 阶段 2a + 2b · TTS 合成的**真实产品装配**回环 HTTP 集成证据
//   —— `buildApp`（产品装配）+ 真实 127.0.0.1 套接字 + 合成身份 + 替身提供者（测试注入）+ 内存 store。
//
// 被测对象：
//   `services/api/src/routes/synthesis.ts`（路由插件）
//   `services/api/src/app.ts` 的接线（import + 注册各一行 + 五个可选注入项）
//   `services/api/src/tts/**`（阶段 1/接线层服务，**语义未改**）
//
// 口径：
//  - 纯回环：只连 `127.0.0.1:<随机端口>`，**不发出任何对外/付费请求**；不读凭据、不读 `.env`。
//  - 提供者与产物都是**明确标注的替身**：产物是明文标注的**非音频**占位，不落盘、不写对象存储。
//  - 契约里该域**只有 POST**：平台级 `GET /jobs/{id}` 由**共享作业面装配**（GY-I01），且 **`synthesis` kind
//    已接入该面**（作业源 `createSynthesisJobSource`，`#152` `22fb5bf`，`services/api/src/app.ts:1087` 装配）
//    ⇒ 合成任务**可经该 HTTP 读面读取**（本文件 P01/P03 已实测 202 → `GET /jobs/{id}` 200）；终态亦可经 `app.synthesisService` 观察。
//  - `real` 实例用**合成占位配置**触达 `config.ts` 的 real 校验链路；**合成占位配置不代表真实凭据可用**。
//  - 真实 TTS 样本为 0 ⇒ 本脚本**不产生也不声称**任何音色/自然度/听感或能力结论。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { buildApp, SYNTHESIS_SUBSTITUTE_CHECKED_CONTENT } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import {
  createWechatIdentityProvider,
  STUB_APP_ID,
  STUB_LOOKUP_KEY,
  STUB_OPENID_PREFIX,
  computeSubjectLookup,
} from '../../services/api/src/auth/wechat.ts';
import { createMemorySynthesisStore } from '../../services/api/src/tts/store.ts';
import { createMemoryCheckedContentPort } from '../../services/api/src/tts/content.ts';
import {
  SUBSTITUTE_ARTIFACT_CONTENT_TYPE,
  TtsWiringError,
  createLiveTtsProvider,
  createStubTtsProvider,
  createTtsProvider,
} from '../../services/api/src/tts/provider.ts';
import { createSubstituteMediaPort } from '../../services/api/src/tts/media.ts';
import { TtsLocalInputError } from '../../services/api/src/tts/live-ports.ts';

const SYNTHESIS_URL = '/api/v1/speech/synthesis';
const LOGIN_URL = '/api/v1/auth/wechat';
const JOBS_URL = '/api/v1/jobs';
const MEDIA_URL = '/api/v1/media';
const REF = { type: 'answer', id: 'answer-http-approved', revision: 3 };
const TEXT = '合成用例文本：稻田稗草三到五叶期，每亩用 25% 制剂 40 毫升。';
const LONG_TEXT = '药'.repeat(101);

/**
 * **客户端替身样本的契约目标引用**（`miniprogram/utils/voice-api.js` 的
 * `SUBSTITUTE_SPEAK_SAMPLES[0].targetRef`；该文件里的字面量与这里逐项一致，
 * 客户端侧由 `tests/unit/miniprogram-voice-playback.test.mjs` 锁定，服务端侧由本文件锁定）。
 */
const CLIENT_SAMPLE_REF = { type: 'answer', id: 'sample-i13-passed', revision: 1 };

/**
 * **合成占位配置**（`synthetic-not-a-real-*`）：只为通过 `config.ts` 的 real 校验链路。
 * 数据库指向**永不连接**的本地端口（`127.0.0.1:1`）；**绝无任何真实凭据**，仅在测试进程内存中存在。
 */
const REAL_ENV = {
  DATABASE_URL: 'postgres://synthetic-not-a-real@127.0.0.1:1/never',
  SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key-0001',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key-0001',
  WECHAT_APP_ID: 'wx-synthetic-not-a-real',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-wechat-secret',
  OBJECT_STORAGE_ENDPOINT: 'https://storage.synthetic-not-a-real.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
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

/** 计数用 store：`insertJobs` = 真正落库的任务数。 */
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
 * 计数用替身提供者：复刻**真实适配器**的本地文本上限（>100 码点 ⇒ `TtsLocalInputError`，不截断）。
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

/** 计数包装（保持被包提供者的 `available`/`providerVersion`/`unavailableReason`/行为不变）。 */
function counting(inner) {
  return {
    executionMode: inner.executionMode,
    providerVersion: inner.providerVersion,
    note: inner.note,
    available: inner.available,
    unavailableReason: inner.unavailableReason,
    async synthesize(input) {
      counters.providerCalls += 1;
      return inner.synthesize(input);
    },
  };
}

// ---------------------------------------------------------------- 产品装配

function stubConfig() {
  return loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
}

/**
 * **经产品装配**（`buildApp`）启动一个回环实例。`synthesis` 为可选注入项
 * （与 `app.ts` 的 `synthesis*` 选项一一对应）；不注入即走产品默认端口。
 */
async function bootAppFor(config, overrides = {}) {
  const authStore = overrides.authStore ?? createMemoryAuthStore();
  const now = () => new Date();
  const synthesis = overrides.synthesis ?? null;
  const app = buildApp({
    config,
    store: authStore,
    idempotency: createMemoryIdempotencyStore(),
    now,
    // real 模式下必须注入替身微信提供者：本脚本**不得**触发任何真实外呼。
    ...(config.executionMode === 'real'
      ? { wechat: createWechatIdentityProvider({ executionMode: 'stub', appId: null, appSecret: null, lookupKey: STUB_LOOKUP_KEY }) }
      : {}),
    // 显式映射到 app.ts 的 `synthesis*` 注入项（**不得**把 store/provider/media/content 直接展开，
    // 那会覆盖 buildApp 既有的同名认证选项）。
    ...(synthesis === null
      ? {}
      : {
          synthesisStore: synthesis.store,
          synthesisProvider: synthesis.provider,
          synthesisMedia: synthesis.media,
          synthesisContent: synthesis.content,
          synthesisJobDeadlineMs: synthesis.jobDeadlineMs,
        }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  return { app, config, authStore, base: `http://127.0.0.1:${port}`, synthesis: synthesis ?? {} };
}

/** 直接播种合成身份 + 会话（零外呼）：返回 `Bearer` 用原始令牌。 */
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

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `tts-http-key-${String(keyCounter).padStart(6, '0')}`;
}

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
  const error = response.json?.error ?? null;
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

// ---------------------------------------------------------------- 实例

// A：产品装配 + 合成注入（替身提供者 / 内存 store / 替身产物 / 已核对内容源）
const injectedStore = countingStore();
const injectedProvider = countingProvider();
const injectedMedia = createSubstituteMediaPort();
const injectedContent = createMemoryCheckedContentPort(entries);
const appA = await bootAppFor(stubConfig(), {
  synthesis: { store: injectedStore, provider: injectedProvider, media: injectedMedia, content: injectedContent },
});
// D：**产品默认装配**（不注入任何合成端口）
const appD = await bootAppFor(stubConfig());
// P：**preset_demo 默认装配**（缩片：替身核对条目在两种替身模式下都必须生效）
const appP = await bootAppFor(loadConfig({ APP_EXECUTION_MODE: 'preset_demo', LOG_LEVEL: 'silent' }));
// B：real 实例（**合成占位配置**），默认提供者（fail-closed）+ 计数 store
const realConfig = loadConfig({ APP_EXECUTION_MODE: 'real', LOG_LEVEL: 'silent', ...REAL_ENV });
const appB = await bootAppFor(realConfig, { synthesis: { store: countingStore() } });

const failMessages = [];
try {
  const loginA = await login(appA.base, 'synthetic-http-a', 'synthetic-login-key-0001');
  assert.equal(loginA.status, 200, `合成身份登录失败：${JSON.stringify(loginA.json).slice(0, 200)}`);
  const userA = loginA.token;
  // 经真实 stub 登录建出的账号：用同一 subject 口径取回 userId，供 inspectJob 的归属校验使用。
  const userARecord = await appA.authStore.findUserBySubject(
    computeSubjectLookup(STUB_LOOKUP_KEY, STUB_APP_ID, `${STUB_OPENID_PREFIX}synthetic-http-a`),
  );
  assert.notEqual(userARecord, null, '合成身份未建用户');
  const userIdA = userARecord.id;
  const identityB = await seedSession(appA.authStore, 'b');
  foreignEntry.ownerUserId = identityB.userId;
  const identityD = await seedSession(appD.authStore, 'd');
  const identityP = await seedSession(appP.authStore, 'preset');
  const identityReal = await seedSession(appB.authStore, 'real');

  console.log(`--- 产品装配实例：A(stub+注入)=${appA.base}｜D(stub+默认)=${appD.base}｜P(preset_demo+默认)=${appP.base}｜B(real+合成占位)=${appB.base} ---`);

  // ============================== 一、产品装配回环（原 2a 的 26 组，现经 buildApp） ==============================
  await check('C01 路由范围·GET/DELETE /speech/synthesis 不存在（契约只有 POST，未自造读/删端点）', async () => {
    const get = await call(appA.base, 'GET', SYNTHESIS_URL, { token: userA });
    const del = await call(appA.base, 'DELETE', SYNTHESIS_URL, { token: userA });
    assertEnvelope(get, 404, 'NOT_FOUND');
    assertEnvelope(del, 404, 'NOT_FOUND');
    return `GET=${get.status} DELETE=${del.status}`;
  });

  await check('C02 鉴权·无令牌 ⇒ 401 SESSION_REQUIRED；非法令牌 ⇒ 401 SESSION_EXPIRED', async () => {
    const none = await call(appA.base, 'POST', SYNTHESIS_URL, { key: nextKey(), body: body(REF) });
    assertEnvelope(none, 401, 'SESSION_REQUIRED');
    const bad = await call(appA.base, 'POST', SYNTHESIS_URL, { token: 'not-a-real-token', key: nextKey(), body: body(REF) });
    assertEnvelope(bad, 401, 'SESSION_EXPIRED');
    return `none=${none.status} bad=${bad.status}`;
  });

  let positiveJobId = null;
  await check('C03 202·JobEnvelope 形状（data.kind=synthesis、meta 齐备、ETag/Cache-Control 同口径）', async () => {
    const response = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body(REF) });
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

  await check('C04 幂等·同键同体重放 ⇒ 同一 job（不新增任务/不新增提供者调用）', async () => {
    const key = nextKey();
    const before = { ...counters };
    const first = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key, body: body(REF) });
    const second = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key, body: body(REF) });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(second.json.data.id, first.json.data.id);
    assert.equal(counters.insertJobs - before.insertJobs, 1);
    await appA.app.synthesisService.settle();
    const third = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key, body: body(REF) });
    assert.equal(third.json.data.id, first.json.data.id);
    assert.equal(counters.insertJobs - before.insertJobs, 1, '重放不得新建任务');
    return `job=${first.json.data.id.slice(0, 8)}… 重放3次任务数=1`;
  });

  await check('C05 幂等·同键异体（不同 revision）⇒ 409 IDEMPOTENCY_CONFLICT，不产生第二个任务', async () => {
    const key = nextKey();
    const before = { ...counters };
    const first = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key, body: body(REF) });
    assert.equal(first.status, 202);
    const conflict = await call(appA.base, 'POST', SYNTHESIS_URL, {
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
      call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key, body: body(REF) }),
      call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key, body: body(REF) }),
    ]);
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.equal(a.json.data.id, b.json.data.id);
    assert.equal(counters.insertJobs - before.insertJobs, 1, `落库任务数应为 1，实际 ${counters.insertJobs - before.insertJobs}`);
    await appA.app.synthesisService.settle();
    assert.equal(counters.providerCalls - before.providerCalls, 1, `提供者调用应为 1，实际 ${counters.providerCalls - before.providerCalls}`);
    return `任务+${counters.insertJobs - before.insertJobs} 提供者调用+${counters.providerCalls - before.providerCalls}`;
  });

  const refusalBefore = { ...counters };
  await check('C07 反例·未核对/待审 pending ⇒ 422 INPUT_UNCERTAIN（AUDIT_PENDING）', async () => {
    const response = await call(appA.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-pending', revision: 1 }),
    });
    const error = assertEnvelope(response, 422, 'INPUT_UNCERTAIN');
    assert.equal(error.details[0]?.code, 'AUDIT_PENDING');
    return `${response.status} ${error.code}/${error.details[0]?.code}`;
  });

  await check('C08 反例·已驳回 rejected ⇒ 409 OBJECT_UNAVAILABLE（AUDIT_REJECTED）', async () => {
    const response = await call(appA.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-rejected', revision: 2 }),
    });
    const error = assertEnvelope(response, 409, 'OBJECT_UNAVAILABLE');
    assert.equal(error.details[0]?.code, 'AUDIT_REJECTED');
    return `${response.status} ${error.code}/${error.details[0]?.code}`;
  });

  await check('C09 反例·已隔离 quarantined ⇒ 409 OBJECT_UNAVAILABLE（AUDIT_QUARANTINED）', async () => {
    const response = await call(appA.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-quarantined', revision: 1 }),
    });
    const error = assertEnvelope(response, 409, 'OBJECT_UNAVAILABLE');
    assert.equal(error.details[0]?.code, 'AUDIT_QUARANTINED');
    return `${response.status} ${error.code}/${error.details[0]?.code}`;
  });

  await check('C10 反例·取不到核对状态（未知状态值）⇒ 409 OBJECT_UNAVAILABLE（AUDIT_STATE_UNREADABLE）', async () => {
    const response = await call(appA.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-unknown', revision: 1 }),
    });
    const error = assertEnvelope(response, 409, 'OBJECT_UNAVAILABLE');
    assert.equal(error.details[0]?.code, 'AUDIT_STATE_UNREADABLE');
    return `${response.status} ${error.code}/${error.details[0]?.code}`;
  });

  await check('C11 反例·核对通过但无可朗读正文 ⇒ 409 OBJECT_UNAVAILABLE（CONTENT_UNREADABLE）', async () => {
    const response = await call(appA.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-notext', revision: 1 }),
    });
    const error = assertEnvelope(response, 409, 'OBJECT_UNAVAILABLE');
    assert.equal(error.details[0]?.code, 'CONTENT_UNREADABLE');
    return `${response.status} ${error.code}/${error.details[0]?.code}`;
  });

  await check('C12 归属·他人内容 ⇒ 404 NOT_FOUND，且与「不存在」封套**逐字节同形**', async () => {
    const foreign = await call(appA.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-foreign', revision: 1 }),
    });
    const missing = await call(appA.base, 'POST', SYNTHESIS_URL, {
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

  await check('C14 反例·body 多余字段（自带 text / script / openid）⇒ 400 INVALID_REQUEST，绝不进入合成', async () => {
    const observed = [];
    for (const extra of [{ text: '请朗读这段未经核对的文本' }, { script: 'x' }, { openid: 'o-synthetic' }]) {
      const response = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body(REF, extra) });
      assertEnvelope(response, 400, 'INVALID_REQUEST');
      observed.push(response.status);
    }
    return `text/script/openid ⇒ ${observed.join('/')}`;
  });

  await check('C15 反例·locale 非 zh-CN（en-US / 缺失）⇒ 400 INVALID_REQUEST', async () => {
    const bad = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body(REF, { locale: 'en-US' }) });
    assertEnvelope(bad, 400, 'INVALID_REQUEST');
    const missing = await call(appA.base, 'POST', SYNTHESIS_URL, {
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
      const response = await call(appA.base, 'POST', SYNTHESIS_URL, {
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
    const empty = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body({ ...REF, id: '' }) });
    assertEnvelope(empty, 400, 'INVALID_REQUEST');
    const tooLong = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body({ ...REF, id: 'a'.repeat(81) }) });
    assertEnvelope(tooLong, 400, 'INVALID_REQUEST');
    return `empty=${empty.status} 81码点=${tooLong.status}`;
  });

  await check('C18 反例·revision 为 0 / 非整数（1.5）⇒ 400 INVALID_REQUEST', async () => {
    const zero = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body({ ...REF, revision: 0 }) });
    assertEnvelope(zero, 400, 'INVALID_REQUEST');
    const fractional = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body({ ...REF, revision: 1.5 }) });
    assertEnvelope(fractional, 400, 'INVALID_REQUEST');
    return `0=${zero.status} 1.5=${fractional.status}`;
  });

  await check('C19 反例·缺/非法 Idempotency-Key（缺失 / 7 字符 / 129 字符）⇒ 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const missing = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, body: body(REF) });
    assertEnvelope(missing, 400, 'IDEMPOTENCY_KEY_REQUIRED');
    const short = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key: 'short7!', body: body(REF) });
    assertEnvelope(short, 400, 'IDEMPOTENCY_KEY_REQUIRED');
    const long = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key: 'k'.repeat(129), body: body(REF) });
    assertEnvelope(long, 400, 'IDEMPOTENCY_KEY_REQUIRED');
    return `${missing.status}/${short.status}/${long.status}`;
  });

  await check('C20 契约字面·本端点未声明 If-Match（x-version-required:false）⇒ 带头照常受理（revision 绑定只在 body）', async () => {
    const response = await call(appA.base, 'POST', SYNTHESIS_URL, {
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
    const stale = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body({ ...REF, revision: 2 }) });
    const error = assertEnvelope(stale, 409, 'REVISION_CONFLICT');
    assert.equal(error.details[0]?.code, 'REVISION_MISMATCH');
    const ahead = await call(appA.base, 'POST', SYNTHESIS_URL, { token: userA, key: nextKey(), body: body({ ...REF, revision: 9 }) });
    assertEnvelope(ahead, 409, 'REVISION_CONFLICT');
    return `rev2=${stale.status} rev9=${ahead.status}`;
  });

  await check('C22 正控制·202 受理 → 完成 → Synthesis 四字段（服务层读面 `app.synthesisService.inspectJob`；HTTP 读面 `GET /jobs/{id}` 由 P01/P03 实测）', async () => {
    assert.notEqual(positiveJobId, null, 'C03 未产出任务');
    await appA.app.synthesisService.settle();
    const job = await appA.app.synthesisService.inspectJob({ userId: userIdA, jobId: positiveJobId });
    assert.equal(job.state, 'succeeded');
    assert.equal(job.error_code, null);
    assert.equal(job.result.kind, 'synthesis');
    const synthesis = job.result.value;
    assert.equal(typeof synthesis.id, 'string');
    assert.equal(synthesis.revision, 1);
    assert.deepEqual(synthesis.checked_content_ref, REF);
    assert.equal(JSON.stringify(job.target_ref), JSON.stringify(REF), '结果的 target_ref 必须与 checked_content_ref 一致');
    assert.match(synthesis.media_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    return `job=${job.state} synthesis.revision=${synthesis.revision} media_id=${synthesis.media_id.slice(0, 8)}…`;
  });

  await check('C23 产物不落盘·替身标注产物、非 audio/*、字节不落盘（内存只登记摘要）', async () => {
    const job = await appA.app.synthesisService.inspectJob({ userId: userIdA, jobId: positiveJobId });
    const object = await injectedMedia.describeObject(job.result.value.media_id);
    assert.notEqual(object, null);
    assert.equal(object.substitute, true, '必须是替身标注产物');
    assert.equal(object.contentType, SUBSTITUTE_ARTIFACT_CONTENT_TYPE);
    assert.equal(object.contentType.toLowerCase().startsWith('audio/'), false);
    assert.deepEqual(Object.keys(object).sort(), ['byteLength', 'contentType', 'note', 'substitute']);
    assert.equal(object.byteLength > 0, true);
    assert.match(object.note, /非真实音频/);
    return `contentType=${object.contentType} bytes=${object.byteLength}（无音频/无落盘）`;
  });

  await check('C24 契约字面·101 码点 ⇒ HTTP 仍 202（契约无文本上限），执行期 failed + INVALID_REQUEST 且不截断', async () => {
    const response = await call(appA.base, 'POST', SYNTHESIS_URL, {
      token: userA,
      key: nextKey(),
      body: body({ type: 'answer', id: 'answer-http-long', revision: 1 }),
    });
    assert.equal(response.status, 202, '受理层不做文本长度判断（上限属提供者侧口径，契约无此上限）');
    await appA.app.synthesisService.settle();
    const job = await appA.app.synthesisService.inspectJob({ userId: userIdA, jobId: response.json.data.id });
    assert.equal(job.state, 'failed');
    assert.equal(job.error_code, 'INVALID_REQUEST');
    assert.equal(job.result, null, '不得产出记录、不得截断后当成功');
    return `202 → ${job.state}/${job.error_code}`;
  });

  // ============================== 二、产品默认装配（不注入任何合成端口） ==============================
  await check('D01 默认装配·**非替身夹具 id** 一律 404 NOT_FOUND（默认替身核对源只含客户端替身样本，真实内容源仍未接线）', async () => {
    const response = await call(appD.base, 'POST', SYNTHESIS_URL, { token: identityD.token, key: nextKey(), body: body(REF) });
    assertEnvelope(response, 404, 'NOT_FOUND');
    return '404 NOT_FOUND（该 id 不在替身核对条目内）';
  });

  await check('D02 默认装配·鉴权/形状边界与注入实例同口径（401/400/400/404）', async () => {
    const unauthorized = await call(appD.base, 'POST', SYNTHESIS_URL, { key: nextKey(), body: body(REF) });
    assertEnvelope(unauthorized, 401, 'SESSION_REQUIRED');
    const badKey = await call(appD.base, 'POST', SYNTHESIS_URL, { token: identityD.token, body: body(REF) });
    assertEnvelope(badKey, 400, 'IDEMPOTENCY_KEY_REQUIRED');
    const badField = await call(appD.base, 'POST', SYNTHESIS_URL, { token: identityD.token, key: nextKey(), body: body(REF, { text: 'x' }) });
    assertEnvelope(badField, 400, 'INVALID_REQUEST');
    const get = await call(appD.base, 'GET', SYNTHESIS_URL, { token: identityD.token });
    assertEnvelope(get, 404, 'NOT_FOUND');
    return '401/400/400/404';
  });

  await check('D03 默认装配·服务可观测（app.synthesisService.describe）为替身/内存口径、realAudioProduced=false', async () => {
    const described = appD.app.synthesisService.describe();
    assert.equal(described.executionMode, 'stub');
    assert.equal(described.providerAvailable, true);
    assert.equal(described.providerVersion.startsWith('stub'), true);
    assert.equal(described.mediaPort, 'substitute');
    assert.equal(described.contentPort, 'substitute');
    assert.equal(described.storePersistent, false);
    assert.equal(described.realAudioProduced, false, '本片不得产生任何真实音频');
    assert.equal(described.acceptedStatus, 202);
    return `providerVersion=${described.providerVersion} media=${described.mediaPort} content=${described.contentPort}`;
  });

  // ============================== 三、real 实例（合成占位配置） ==============================
  await check('R01 real 校验链路·合成占位配置可通过 loadConfig 并得到 executionMode=real', async () => {
    assert.equal(appB.config.executionMode, 'real');
    assert.equal(appB.config.requiresRealCredentials, true);
    assert.equal(appB.config.databaseUrl, REAL_ENV.DATABASE_URL);
    assert.equal(REAL_ENV.DATABASE_URL.includes('127.0.0.1:1/never'), true, '数据库指向永不连接的本地端口');
    assert.equal(Object.values(REAL_ENV).every((value) => String(value).includes('synthetic-not-a-real')), true, '全部为显式合成占位值');
    return 'executionMode=real（合成占位配置；未使用任何真实凭据）';
  });

  await check('R02 real 默认提供者形状·providerAvailable=false、providerVersion=real-unconfigured（≠替身版本，未回退）', async () => {
    const provider = createTtsProvider({ executionMode: 'real' });
    assert.equal(provider.executionMode, 'real');
    assert.equal(provider.available, false);
    assert.equal(provider.providerVersion, 'real-unconfigured');
    assert.notEqual(provider.providerVersion, 'stub-tts-v1');
    assert.notEqual(provider.providerVersion, 'preset-demo-tts-v1');
    assert.equal(String(provider.unavailableReason).includes('fail-closed'), true);
    const outcome = await provider.synthesize({ jobId: randomUUID(), text: TEXT, locale: 'zh-CN', targetRef: REF });
    assert.deepEqual(outcome, { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
    const described = appB.app.synthesisService.describe();
    assert.equal(described.providerAvailable, false);
    assert.equal(described.providerVersion, 'real-unconfigured');
    assert.equal(described.realAudioProduced, false);
    return 'available=false version=real-unconfigured（describe 一致）';
  });

  await check('R03 real 实例·POST 受理前 503 PROVIDER_UNAVAILABLE；换键再试仍 503，且不建任务、提供者 0 次', async () => {
    const before = { ...counters };
    const first = await call(appB.base, 'POST', SYNTHESIS_URL, { token: identityReal.token, key: nextKey(), body: body(REF) });
    const error = assertEnvelope(first, 503, 'PROVIDER_UNAVAILABLE');
    assert.equal(first.json.meta.execution_mode, 'real');
    assert.equal(counters.insertJobs - before.insertJobs, 0, '不得建任务');
    assert.equal(counters.providerCalls - before.providerCalls, 0, '不得调用提供者');
    const second = await call(appB.base, 'POST', SYNTHESIS_URL, { token: identityReal.token, key: nextKey(), body: body(REF) });
    assertEnvelope(second, 503, 'PROVIDER_UNAVAILABLE');
    assert.equal(counters.insertJobs - before.insertJobs, 0, '换键再试仍不得建任务');
    assert.equal(counters.providerCalls - before.providerCalls, 0, '换键再试仍不得调用提供者');
    return `503×2 ${error.code}；任务+0 提供者调用+0（execution_mode=real）`;
  });

  await check('R04 real 实例·计数包装的默认 real 提供者：两次不同键均 503 且调用计数恒为 0（无替身回退）', async () => {
    const realCounting = await bootAppFor(realConfig, {
      synthesis: { store: countingStore(), provider: counting(createTtsProvider({ executionMode: 'real' })) },
    });
    try {
      const identity = await seedSession(realCounting.authStore, 'real2');
      const before = { ...counters };
      const a = await call(realCounting.base, 'POST', SYNTHESIS_URL, { token: identity.token, key: nextKey(), body: body(REF) });
      const b = await call(realCounting.base, 'POST', SYNTHESIS_URL, { token: identity.token, key: nextKey(), body: body(REF) });
      assertEnvelope(a, 503, 'PROVIDER_UNAVAILABLE');
      assertEnvelope(b, 503, 'PROVIDER_UNAVAILABLE');
      assert.equal(counters.providerCalls - before.providerCalls, 0, '提供者调用必须为 0 次');
      assert.equal(counters.insertJobs - before.insertJobs, 0);
      assert.equal(realCounting.app.synthesisService.describe().providerVersion, 'real-unconfigured');
      return '503×2 提供者调用+0 任务+0';
    } finally {
      await new Promise((resolve) => realCounting.app.close(resolve));
    }
  });

  // ============================== 三b、缩片（`ruling-451`）：替身模式下「受理 → 读面」打通，来源如实不可播 ==============================
  //
  // 范围（**不放开契约、不改服务端语义**）：装配层在 `stub`/`preset_demo` 下注入**明确标注的替身核对条目**，
  // 使客户端替身样本能走完「202 受理 → `GET /jobs/{id}` 读到 succeeded + media_id」；
  // 音频来源**仍不可播**（契约没有面向客户端的音频出口）⇒ 客户端只能 `SOURCE_UNAVAILABLE`（页面侧由
  // `tests/unit/miniprogram-voice-playback.test.mjs` 锁定）。real 不受替身条目影响，仍受理前 503。
  let clientSampleMediaId = null;

  await check('P00 配对·服务端装配替身条目 == 客户端替身样本的契约目标引用（id/type/revision 逐项一致）', async () => {
    assert.equal(SYNTHESIS_SUBSTITUTE_CHECKED_CONTENT.length, 1, '装配层只注入正例那一条替身条目');
    const entry = SYNTHESIS_SUBSTITUTE_CHECKED_CONTENT[0];
    assert.deepEqual(
      { type: entry.type, id: entry.id, revision: entry.revision },
      CLIENT_SAMPLE_REF,
      '服务端替身条目必须与客户端替身样本的 targetRef 逐项一致',
    );
    assert.equal(entry.auditState, 'approved');
    assert.equal(typeof entry.text, 'string');
    assert.ok(entry.text.length > 0);
    return `${entry.type}/${entry.id}#${entry.revision}（auditState=${entry.auditState}）`;
  });

  await check('P01 缩片·stub 默认装配：客户端替身样本 ⇒ 202 受理 → `GET /jobs/{id}` 读到 succeeded + media_id（改前是 404）', async () => {
    const accepted = await call(appD.base, 'POST', SYNTHESIS_URL, {
      token: identityD.token,
      key: nextKey(),
      body: body(CLIENT_SAMPLE_REF),
    });
    assert.equal(accepted.status, 202, `应 202，实际 ${accepted.status}（${accepted.text.slice(0, 200)}）`);
    assert.equal(accepted.headers.get('etag'), '"1"');
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    assert.equal(accepted.json.meta.execution_mode, 'stub');
    assert.equal(accepted.json.data.kind, 'synthesis');
    assert.equal(accepted.json.data.state, 'queued');
    assert.deepEqual(accepted.json.data.target_ref, CLIENT_SAMPLE_REF, '受理响应必须回绑客户端传的契约目标引用');
    const jobId = accepted.json.data.id;

    await appD.app.synthesisService.settle();
    const read = await call(appD.base, 'GET', `${JOBS_URL}/${jobId}`, { token: identityD.token });
    assert.equal(read.status, 200, `读面应 200，实际 ${read.status}（${read.text.slice(0, 200)}）`);
    assert.equal(read.json.data.kind, 'synthesis');
    assert.equal(read.json.data.state, 'succeeded');
    assert.equal(read.json.data.error_code, null);
    assert.equal(read.json.data.result.kind, 'synthesis');
    assert.match(read.json.data.result.value.media_id, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(read.json.data.result.value.checked_content_ref, CLIENT_SAMPLE_REF, '结果必须回绑同一个目标与 revision');
    clientSampleMediaId = read.json.data.result.value.media_id;
    return `202 → ${read.json.data.state} media_id=${clientSampleMediaId.slice(0, 8)}…`;
  });

  await check('P02 缩片·revision 绑定不放宽：同 id 传 revision+1 ⇒ 409 REVISION_CONFLICT（替身条目的 revision 被锁定）', async () => {
    const stale = await call(appD.base, 'POST', SYNTHESIS_URL, {
      token: identityD.token,
      key: nextKey(),
      body: body({ ...CLIENT_SAMPLE_REF, revision: CLIENT_SAMPLE_REF.revision + 1 }),
    });
    const error = assertEnvelope(stale, 409, 'REVISION_CONFLICT');
    assert.equal(error.details[0]?.code, 'REVISION_MISMATCH');
    return `409 ${error.code}/${error.details[0]?.code}`;
  });

  await check('P03 缩片·preset_demo 默认装配：同一条替身条目同样生效（202 → succeeded）', async () => {
    const accepted = await call(appP.base, 'POST', SYNTHESIS_URL, {
      token: identityP.token,
      key: nextKey(),
      body: body(CLIENT_SAMPLE_REF),
    });
    assert.equal(accepted.status, 202, `应 202，实际 ${accepted.status}（${accepted.text.slice(0, 200)}）`);
    assert.equal(accepted.json.meta.execution_mode, 'preset_demo');
    await appP.app.synthesisService.settle();
    const read = await call(appP.base, 'GET', `${JOBS_URL}/${accepted.json.data.id}`, { token: identityP.token });
    assert.equal(read.status, 200);
    assert.equal(read.json.data.state, 'succeeded');
    return `preset_demo 202 → ${read.json.data.state}`;
  });

  await check('P04 缩片·来源如实：既有 media 途径取不到合成产物 ⇒ `POST /media/{id}/access` 404、`GET /media/{id}/content` 无此 operation', async () => {
    assert.notEqual(clientSampleMediaId, null, 'P01 未产出 media_id');
    const grant = await call(appD.base, 'POST', `${MEDIA_URL}/${clientSampleMediaId}/access`, {
      token: identityD.token,
      key: nextKey(),
      headers: { 'if-match': '"1"' },
    });
    // 合成 `media_id` 属合成域的替身产物存储，**不在**媒体域 ⇒ 与「媒体不存在」同形 404（不是网络问题、不是登录失效）。
    assertEnvelope(grant, 404, 'NOT_FOUND');
    const content = await call(appD.base, 'GET', `${MEDIA_URL}/${clientSampleMediaId}/content`, { token: identityD.token });
    assertEnvelope(content, 404, 'NOT_FOUND');
    assert.match(content.json.error.message, /未实现的路径/, '契约里没有 owner 私有媒体字节读取 operation');
    return `access=${grant.status} content=${content.status}（客户端据此只能 SOURCE_UNAVAILABLE）`;
  });

  await check('P05 缩片·替身条目不放宽 real：real 默认装配 + 客户端替身样本 ⇒ 503 PROVIDER_UNAVAILABLE，提供者 0 次、不建任务', async () => {
    const before = { ...counters };
    const response = await call(appB.base, 'POST', SYNTHESIS_URL, {
      token: identityReal.token,
      key: nextKey(),
      body: body(CLIENT_SAMPLE_REF),
    });
    assertEnvelope(response, 503, 'PROVIDER_UNAVAILABLE');
    assert.equal(response.json.meta.execution_mode, 'real');
    assert.equal(counters.providerCalls - before.providerCalls, 0, '不得调用提供者');
    assert.equal(counters.insertJobs - before.insertJobs, 0, '不得建任务');
    return '503 PROVIDER_UNAVAILABLE；提供者调用+0 任务+0';
  });

  // ============================== 四、结构性证据（默认关闭不是开关） ==============================
  await check('S01 结构·app.ts（去注释）不 import 真实适配器端口构造器；接线恰好一处调用，且 guards 槽位装旗标门 gatedGuards', async () => {
    const source = readFileSync(new URL('../../services/api/src/app.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/createLiveTtsProvider/.test(code), false, 'app.ts 不得引用真实发送构造器');
    assert.equal(/live-ports/.test(code), false, 'app.ts 不得引用端口模块');
    assert.equal(/RealTtsPorts/.test(code), false);
    // ⚠ 2026-10-16（GY-I10 作业读面接线片）**既有断言修复**：本断言在基线 `cf9c3c8` 上**本就失败**
    //   （实测原始输出见交接文档）——它写于 `#145`（`b054dc3`）之前的精确串时代，当时第三个实参是裸
    //   `guards`；`#145` 把它换成 `gatedGuards`（同名下的旗标门包装，**槽位与签名未变**）⇒ 精确串命中数
    //   变 0。该断言的本意是"接线恰好一处"，与对象名无关，故精确串改为 `gatedGuards`；语义本身未被放宽。
    assert.equal((code.match(/registerSynthesisRoutes\(app, config, gatedGuards, synthesisService, consentGate\);/g) ?? []).length, 1);
    // 值断言（键/串存在 ≠ 值正确）：钉住第三个实参是**旗标门包装后的** `gatedGuards`，而不是裸 `guards`
    //   （`\b` 词边界：裸 `guards` 是 `gatedGuards` 的后缀，不能只做子串判断）。
    assert.match(code, /\bconst gatedGuards = createFlagGatedGuards\(guards, featureFlagGate\);/, 'app.ts 必须有 gatedGuards 绑定（createFlagGatedGuards(guards, featureFlagGate)）');
    assert.equal(/registerSynthesisRoutes\(app, config, guards,/.test(code), false, '装配不得退回裸 guards 槽位');
    assert.equal(/createTtsProvider\(\{ executionMode: config\.executionMode \}\)/.test(code), true);
    return 'app.ts 无 createLiveTtsProvider / 无 live-ports；注册恰好一处且装 gatedGuards';
  });

  await check('S02 结构·路由插件（去注释）不构造任何提供者/产物/核对源（签名只收服务）', async () => {
    const source = readFileSync(new URL('../../services/api/src/routes/synthesis.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const banned of ['createLiveTtsProvider', 'live-ports', 'createTtsProvider', 'createSynthesisService', 'createMemorySynthesisStore', 'createSynthesisMediaPort', 'createCheckedContentPort']) {
      assert.equal(code.includes(banned), false, `路由不得出现 ${banned}`);
    }
    assert.equal(/guards\.requireUser/.test(code), true);
    assert.equal(/buildMeta/.test(code), true);
    return '路由只做鉴权→形状→服务→202；零构造';
  });

  await check('S03 结构·provider.ts 无网络客户端；真实分支无默认端口（createLiveTtsProvider(undefined) 拒绝）', async () => {
    const source = readFileSync(new URL('../../services/api/src/tts/provider.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/require\('node:https?'\)/.test(code), false);
    assert.equal(/from 'node:https?'/.test(code), false);
    assert.throws(() => createLiveTtsProvider(undefined), (error) => error instanceof TtsWiringError, '真实分支不得有默认端口');
    return '无网络客户端；createLiveTtsProvider(undefined) ⇒ TtsWiringError';
  });

  // ============================== 五、终态覆盖（仅经注入 store 可观察） ==============================
  await check('T01 终态·提供者超时（注入短截止）⇒ job timed_out + PROVIDER_TIMEOUT，且 result=null', async () => {
    const timedOutApp = await bootAppFor(stubConfig(), {
      synthesis: {
        store: countingStore(),
        provider: {
          executionMode: 'stub',
          providerVersion: 'stub-never-resolves',
          note: '集成测试：永不作答的替身提供者（不产生任何音频）',
          available: true,
          unavailableReason: null,
          synthesize: () => new Promise(() => {}),
        },
        media: createSubstituteMediaPort(),
        content: createMemoryCheckedContentPort([{ type: 'answer', id: REF.id, revision: REF.revision, auditState: 'approved', text: TEXT }]),
        jobDeadlineMs: 30,
      },
    });
    try {
      const identity = await seedSession(timedOutApp.authStore, 'timeout');
      const accepted = await call(timedOutApp.base, 'POST', SYNTHESIS_URL, { token: identity.token, key: nextKey(), body: body(REF) });
      assert.equal(accepted.status, 202);
      await timedOutApp.app.synthesisService.settle();
      const job = await timedOutApp.app.synthesisService.inspectJob({ userId: identity.userId, jobId: accepted.json.data.id });
      assert.equal(job.state, 'timed_out');
      assert.equal(job.error_code, 'PROVIDER_TIMEOUT');
      assert.equal(job.result, null);
      return `${job.state}/${job.error_code}`;
    } finally {
      await new Promise((resolve) => timedOutApp.app.close(resolve));
    }
  });

  await check('T02 终态·提供者配额失败 ⇒ job failed + PROVIDER_QUOTA_EXCEEDED，且 result=null（绝不 succeeded）', async () => {
    const quotaApp = await bootAppFor(stubConfig(), {
      synthesis: {
        store: countingStore(),
        provider: {
          executionMode: 'stub',
          providerVersion: 'stub-quota-failed',
          note: '集成测试：返回配额失败的替身提供者（不产生任何音频）',
          available: true,
          unavailableReason: null,
          async synthesize() {
            return { kind: 'failed', code: 'PROVIDER_QUOTA_EXCEEDED' };
          },
        },
        media: createSubstituteMediaPort(),
        content: createMemoryCheckedContentPort([{ type: 'answer', id: REF.id, revision: REF.revision, auditState: 'approved', text: TEXT }]),
      },
    });
    try {
      const identity = await seedSession(quotaApp.authStore, 'quota');
      const accepted = await call(quotaApp.base, 'POST', SYNTHESIS_URL, { token: identity.token, key: nextKey(), body: body(REF) });
      assert.equal(accepted.status, 202);
      await quotaApp.app.synthesisService.settle();
      const job = await quotaApp.app.synthesisService.inspectJob({ userId: identity.userId, jobId: accepted.json.data.id });
      assert.equal(job.state, 'failed');
      assert.equal(job.error_code, 'PROVIDER_QUOTA_EXCEEDED');
      assert.equal(job.result, null);
      return `${job.state}/${job.error_code}`;
    } finally {
      await new Promise((resolve) => quotaApp.app.close(resolve));
    }
  });
} catch (error) {
  summary.fail += 1;
  failMessages.push(`未捕获异常：${error?.stack ?? error}`);
  console.log(`FAIL  未捕获异常 → ${error?.message ?? error}`);
} finally {
  await new Promise((resolve) => appA.app.close(resolve));
  await new Promise((resolve) => appD.app.close(resolve));
  await new Promise((resolve) => appP.app.close(resolve));
  await new Promise((resolve) => appB.app.close(resolve));
}

console.log('---');
console.log(`CHECKS pass=${summary.pass} fail=${summary.fail}`);
console.log(`SUMMARY counters: providerCalls=${counters.providerCalls} insertJobs=${counters.insertJobs}（含正控制/幂等/终态用例的正常用量）`);
if (summary.fail > 0) {
  for (const message of failMessages) console.log(message);
  console.log('RESULT=FAIL');
  process.exitCode = 1;
} else {
  console.log('RESULT=PASS 真实产品装配（buildApp）+ 本机回环 HTTP；合成身份 + 替身提供者 + 内存 store；未发出任何对外/付费请求');
  console.log('SCOPE=product_assembly_http_loopback; 共享读面 `GET /jobs/{id}` 已接入 `synthesis` kind（P01/P03 经 HTTP 实测）；');
  console.log('      缩片：stub/preset_demo 受理与读面打通；**可播放来源仍不可得**（契约无客户端音频出口，P04），real 未接线仍 503（P05）；');
  console.log('      real 实例为**合成占位配置**（不代表真实凭据可用）；真实 TTS 样本 0，不声称任何音质/自然度结论');
}
