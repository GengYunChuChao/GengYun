/**
 * GY-I10 阶段 2b · 标签 OCR 的**经真实装配的 app** + 本机回环真实 HTTP 集成回归。
 *
 * 与阶段 2a 的差别（本片的关键变化）：
 * - 2a 时 `app.ts` 尚未装配 OCR 路由，只能在测试内**自建应用**再注册插件；
 * - 2b 起 `app.ts` 已装配 `registerOcrRoutes(app, config, { guards })`（app.ts 只加两行），
 *   因此本脚本改为打**真实装配**：同一个 `buildApp` 同时提供鉴权、错误封套、404、
 *   `ajv removeAdditional:false` 与 OCR 路由；**测试内不再注册路由**（唯一例外见组 3d）。
 *
 * 边界（如实标注，不得外推）：
 * - 只用本机回环（127.0.0.1，随机端口）；**不发起任何外网请求**、**不连接任何数据库**（内存 store）。
 * - 身份是**合成**的：stub 模式经真实 `POST /api/v1/auth/wechat`（替身身份提供者）登录；
 *   real 模式实例按 `AuthStore` 公开 API **直接播种会话**（real 模式不允许替身登录，故不登录）。
 * - real 模式的配置用**合成占位值**（`REAL_ENV`）通过 `loadConfig` 的 real 校验；
 *   这些值**不是真实凭据**，且 `DATABASE_URL` 指向一个**永不连接**的本地地址。
 * - OCR 提供者是**明确标注的替身**（stub 分桶）或 real 的 **fail-closed** 实现；**不是真实供应商**。
 * - **标签类真实样本为 0** ⇒ 本脚本不产生、不声称任何准确率。
 *
 * 运行：`node tests/integration/ocr-http.mjs`（退出码 0 表示通过；任何断言失败以非 0 退出并打印原始断言）
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { ApiError, buildErrorEnvelope } from '../../services/api/src/errors.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createAuthGuards } from '../../services/api/src/auth/middleware.ts';
import { registerOcrRoutes } from '../../services/api/src/routes/ocr.ts';
import { createUnwiredReferencePort } from '../../services/api/src/ocr/reference.ts';
import { createJobRegistry } from '../../services/api/src/jobs/registry.ts';
import { createOcrJobSource } from '../../services/api/src/jobs/sources.ts';
import { registerJobRoutes } from '../../services/api/src/jobs/routes.ts';
import { collectResultValueIssues } from '../../services/api/src/jobs/result-shape.ts';

const API = '/api/v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 契约 `Job` 九键（`additionalProperties:false` ⇒ 键集合必须恰好是这九个）。 */
const JOB_KEYS = ['id', 'revision', 'kind', 'target_ref', 'state', 'deadline_at', 'created_at', 'error_code', 'result'];
/** 契约 `JobState` 七值闭集（逐项抄录）。 */
const JOB_STATES = ['queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];
const TERMINAL_STATES = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];
/** 识别域替身"正常"分桶的媒体 id（取自 GY-I09 既有集成脚本的同口径常量，用于"不回归"对照）。 */
const RECOGNITION_OK_MEDIA = '11111111-1111-4111-8111-111111111111';

const DOSE_CONDITIONS_COMPLETE = {
  crop_id: 'rice',
  region_code: '330100',
  species_id: 'species_barnyardgrass',
  growth_stage: '3-5叶期',
  planting_method: '移栽',
  use_scene: '水稻田',
};

/** 通过 `loadConfig` 的 real 校验所需的**合成占位**配置（非真实凭据；不连接）。 */
const REAL_ENV = {
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

function assertString(value, label) {
  assert.equal(typeof value, 'string', `${label} 必须是 string，实际是 ${typeof value}`);
}

function assertArray(value, label) {
  assert.ok(Array.isArray(value), `${label} 必须是数组，实际是 ${typeof value}`);
  return value;
}

/** 与 `ocr/provider.ts` 的 `bucketOf` 同口径：sha256(media_id) 首字节对 6 取模。 */
const bucketCache = new Map();
function mediaIdForBucket(bucket) {
  if (bucketCache.has(bucket)) return bucketCache.get(bucket);
  for (let attempt = 0; attempt < 500000; attempt += 1) {
    const candidate = randomUUID();
    if (createHash('sha256').update(candidate).digest()[0] % 6 === bucket) {
      bucketCache.set(bucket, candidate);
      return candidate;
    }
  }
  throw new Error(`未能找到分桶 ${bucket} 的媒体 uuid`);
}

let keySeq = 0;
const nextKey = (label = 'ocr-http') => `${label}-${String((keySeq += 1)).padStart(6, '0')}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 真实 HTTP 调用；返回 {status, json, headers}。 */
async function call(base, token, method, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, json: text === '' ? null : JSON.parse(text) };
}

/** 合成登录（stub 模式：code 派生稳定合成身份，不发起外部请求）。 */
async function login(base, code) {
  const response = await call(base, null, 'POST', `${API}/auth/wechat`, {
    headers: { 'idempotency-key': `ocr-http-login-${code}` },
    body: { code },
  });
  assert.equal(response.status, 200, `合成登录应 200，实际 ${response.status}`);
  assertString(response.json.data.access_token, 'login.data.access_token');
  return response.json.data.access_token;
}

/** real 模式：按 AuthStore 公开 API 直接播种会话（real 不允许替身登录）。 */
async function seedSession(authStore, label) {
  const user = await authStore.createUser(`${label}-${randomUUID().replace(/-/g, '')}`);
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'user',
  });
  return token;
}

/** **纯 HTTP** 轮询读回 OCR 记录（OCR 域无 /jobs 路由，故以记录出现与否判定完成）。 */
async function waitForOcr(base, token, ocrId, tries = 200) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const response = await call(base, token, 'GET', `${API}/ocr/${ocrId}`);
    if (response.status === 200) return response.json.data;
    assert.equal(response.status, 404, `等待期间应为 404，实际 ${response.status}`);
    await sleep(5);
  }
  throw new Error(`等待 OCR 记录超时：${ocrId}`);
}

async function createOcr(base, token, mediaId, key = nextKey()) {
  const response = await call(base, token, 'POST', `${API}/ocr`, {
    headers: { 'idempotency-key': key },
    body: { media_id: mediaId, media_revision: 1 },
  });
  return { response, key };
}

/**
 * **纯 HTTP** 轮询**作业读面**到终态（`GET /jobs/{id}`；本片新接线的读面本身就是被测对象）。
 *
 * 每一步都断言 **200**：该 kind 未接线时这里必然是 `404 NOT_FOUND`（与"作业不存在"同形）
 * ⇒ 这条断言就是"接线与否"的红绿分界（撤下 `app.ts` 的注册项 ⇒ 本函数第一轮即失败）。
 */
async function waitForTerminalJob(base, token, jobId, tries = 400) {
  let last = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const response = await call(base, token, 'GET', `${API}/jobs/${jobId}`);
    assert.equal(response.status, 200, `GET /jobs/{id} 必须 200（未接线时是 404）：${JSON.stringify(response.json)}`);
    last = response.json.data;
    if (TERMINAL_STATES.includes(last.state)) return last;
    await sleep(5);
  }
  throw new Error(`等待作业终态超时：${jobId}（最后 state=${String(last?.state)}）`);
}

/**
 * **注入式接缝（第一段）**：仅用于"登记库未接线 ⇒ unavailable"这一分支。
 *
 * 产品装配 `app.ts` 只传 `{ guards }`（零端口注入）——这本身是**默认关闭**的安全属性，
 * 但也意味着"真实登记库未接线 ⇒ unavailable"这一分支**无法**经产品装配构造
 * （real 模式下提供者先 fail-closed，HTTP 上根本走不到登记库那一步）。
 * 因此该分支用**路由插件自身的 `deps` 接缝**在本测试内最小化装配；
 * 组 8 已用产品装配的**结构断言**钉住"产品路径不暴露该注入面"。
 * （本文件的**第二段接缝**见 `buildInjectedProviderApp`，只用于构造失败/超时终态与确定性"运行中"。）
 */
function buildInjectedReferenceApp(config, authStore) {
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });
  for (const key of ['userId', 'authEpoch', 'role', 'sessionId', 'sessionExpiresAt', 'accountRevision', 'authScopes']) {
    app.decorateRequest(key, null);
  }
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.status).send(buildErrorEnvelope(error, { request_id: request.id, execution_mode: config.executionMode }));
      return;
    }
    reply.status(500).send({ error: { message: '内部错误', retryable: false, details: [] }, meta: { request_id: request.id } });
  });
  const guards = createAuthGuards({ store: authStore, now: () => new Date() });
  registerOcrRoutes(app, config, { guards, reference: createUnwiredReferencePort() });
  return app;
}

/**
 * **注入式接缝（第二段）**：只用于构造"失败/超时终态"与**确定性**的"运行中"。
 *
 * 为什么必须走接缝：产品装配对 OCR 路由**零端口注入**（只传 `guards`/`consent`/`egress`，组 8 有结构证据），
 * 而替身提供者按 `media_id` 分六个桶、**六桶全部是"已完成"**（没有失败桶）⇒ "失败态"无法经产品装配构造。
 * 本接缝**只**替换**提供者**与 **deadline**，装配件全部复用产品同一套：`registerOcrRoutes`（产品同一函数）
 * + `registerJobRoutes` + 真实注册表（含 `createOcrJobSource`）⇒ 作业读面的分派与契约校验路径与产品装配逐字相同。
 */
function buildInjectedProviderApp(config, authStore, options = {}) {
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });
  for (const key of ['userId', 'authEpoch', 'role', 'sessionId', 'sessionExpiresAt', 'accountRevision', 'authScopes']) {
    app.decorateRequest(key, null);
  }
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.status).send(buildErrorEnvelope(error, { request_id: request.id, execution_mode: config.executionMode }));
      return;
    }
    reply.status(500).send({ error: { message: '内部错误', retryable: false, details: [] }, meta: { request_id: request.id } });
  });
  const guards = createAuthGuards({ store: authStore, now: () => new Date() });
  const service = registerOcrRoutes(app, config, {
    guards,
    provider: options.provider,
    jobDeadlineMs: options.jobDeadlineMs,
  });
  registerJobRoutes(app, config, guards, createJobRegistry([createOcrJobSource(service)]));
  return app;
}

/**
 * 接缝替身提供者（**明确标注的替身**，不触达任何真实供应商）：
 * 按 `media_id` 的 sha256 分桶（与 `ocr/provider.ts` 的 `bucketOf` 同口径）
 *   - 桶 0 ⇒ **悬挂**（永不返回）⇒ 由服务端 deadline 落 `timed_out` + `PROVIDER_TIMEOUT`；
 *   - 桶 1 ⇒ **强制失败** `PROVIDER_OUTCOME_UNKNOWN` ⇒ 落 `failed` + 同一码（非超时失败，刻意与桶 0 分开）；
 *   - 其余桶 ⇒ 抛错（宁可让用例失败，也不静默给出成功）。
 */
function seamProvider() {
  return {
    executionMode: 'stub',
    modelVersion: 'stub-seam-v1',
    available: true,
    unavailableReason: null,
    async extract({ mediaId }) {
      const bucket = createHash('sha256').update(mediaId).digest()[0] % 6;
      if (bucket === 0) return new Promise(() => {});
      if (bucket === 1) return { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' };
      throw new Error(`接缝替身只支持桶 0/1，收到桶 ${bucket}`);
    },
  };
}

// ---------------------------------------------------------------- 主流程

const results = [];
function record(group) {
  results.push(group);
  console.log(`  PASS ${group}`);
}

const stubConfig = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });

// —— 实例 1：**产品装配**（stub）——绝大多数用例打在它上面 ——
const stubAuthStore = createMemoryAuthStore();
const stubApp = buildApp({ config: stubConfig, store: stubAuthStore });
const stubBase = await stubApp.listen({ host: '127.0.0.1', port: 0 });
const stubCalls = () => stubApp.ocrService.describe().providerCalls;

// —— 实例 2：**产品装配**（real，合成占位配置）——默认关闭的 app 级证据 ——
const realAuthStore = createMemoryAuthStore();
const realConfig = loadConfig({ APP_EXECUTION_MODE: 'real', LOG_LEVEL: 'silent', ...REAL_ENV });
const realApp = buildApp({ config: realConfig, store: realAuthStore });
const realBase = await realApp.listen({ host: '127.0.0.1', port: 0 });

// —— 实例 3：**注入式接缝**（仅用于"登记库未接线"这一分支）——
const seamAuthStore = createMemoryAuthStore();
const seamApp = buildInjectedReferenceApp(stubConfig, seamAuthStore);
const seamBase = await seamApp.listen({ host: '127.0.0.1', port: 0 });
const seamToken = await seedSession(seamAuthStore, 'synthetic-ocr-seam');

// —— 实例 4：**注入式接缝（第二段）**（悬挂/失败提供者 + 1s deadline；仅用于失败态与确定性"运行中"）——
const providerSeamAuthStore = createMemoryAuthStore();
const providerSeamApp = buildInjectedProviderApp(stubConfig, providerSeamAuthStore, {
  provider: seamProvider(),
  jobDeadlineMs: 1000,
});
const providerSeamBase = await providerSeamApp.listen({ host: '127.0.0.1', port: 0 });
const providerSeamToken = await seedSession(providerSeamAuthStore, 'synthetic-ocr-provider-seam');

try {
  console.log('== GY-I10 阶段 2b 真实装配 + 回环 HTTP 集成回归 ==');
  console.log(`  · 产品装配 stub  base=${stubBase}  execution_mode=${stubApp.ocrService.describe().executionMode}`);
  console.log(`  · 产品装配 real  base=${realBase}  execution_mode=${realApp.ocrService.describe().executionMode}`);

  const base = stubBase;
  const tokenA = await login(base, 'synthetic-ocr-a');
  const tokenB = await login(base, 'synthetic-ocr-b');

  // ---- 1) 受理：契约状态码 + 封套形状 + 提供者恰好 1 次调用 ------------------
  {
    const before = stubCalls();
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    assert.equal(response.status, 202, 'createOCR 契约规定 202');
    const meta = response.json.meta;
    assert.deepEqual(Object.keys(meta).sort(), ['contract_version', 'execution_mode', 'request_id']);
    assert.match(meta.request_id, UUID_RE, 'meta.request_id 应为 uuid');
    assert.equal(meta.contract_version, '1.0.0');
    assert.equal(meta.execution_mode, 'stub');
    const job = response.json.data;
    assert.equal(job.kind, 'ocr');
    assert.equal(job.state, 'queued');
    assert.equal(job.result, null, '受理时不得带出结果');
    assert.equal(job.error_code, null);
    assert.equal(job.target_ref.type, 'ocr');
    assert.match(job.target_ref.id, UUID_RE);
    assertString(job.deadline_at, 'job.deadline_at');
    assertString(job.created_at, 'job.created_at');
    assert.deepEqual(Object.keys(response.json).sort(), ['data', 'meta']);
    assert.deepEqual(
      Object.keys(job).sort(),
      ['created_at', 'deadline_at', 'error_code', 'id', 'kind', 'result', 'revision', 'state', 'target_ref'],
    );
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('etag'), `"${job.revision}"`);
    const ocr = await waitForOcr(base, tokenA, job.target_ref.id);
    assert.equal(ocr.model_version, 'stub-v1', '替身必须如实标注 model_version');
    await stubApp.ocrService.settle();
    assert.equal(stubCalls() - before, 1, '一次受理恰好 1 次提供者调用');
    record('1) createOCR 202 + JobEnvelope/Job 形状 + meta 齐备 + no-store/ETag + 提供者恰好 1 次调用（真实装配）');
  }

  // ---- 9) 正控制：受理 → 完成 → 读回 → 校正 → 落库读回 ----------------------
  {
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const job = response.json.data;
    const raw = await waitForOcr(base, tokenA, job.target_ref.id);
    assert.equal(raw.id, job.target_ref.id);
    assert.equal(raw.revision, 1);
    assert.deepEqual(
      Object.keys(raw).sort(),
      ['corrected_fields', 'id', 'model_version', 'raw_fields', 'revision', 'verification'],
    );
    const rawRegistration = raw.raw_fields.registration_number;

    const reread = await call(base, tokenA, 'GET', `${API}/ocr/${raw.id}`);
    assert.equal(reread.status, 200);
    assert.equal(reread.json.meta.contract_version, '1.0.0');
    assert.equal(reread.headers.get('etag'), '"1"');
    assert.equal(reread.headers.get('cache-control'), 'no-store');

    const corrected = await call(base, tokenA, 'PATCH', `${API}/ocr/${raw.id}/correction`, {
      headers: { 'idempotency-key': nextKey('correct'), 'if-match': `"${raw.revision}"` },
      body: {
        corrected_fields: {
          registration_number: 'PD20210002',
          name: '用户手改名称',
          ingredients: [{ name: '乙草胺', content_text: '50', unit_text: '%' }],
          dosage_form: '乳油',
        },
      },
    });
    assert.equal(corrected.status, 200, 'correctOCR 契约规定 200');
    assert.equal(corrected.json.data.revision, 2);
    assert.equal(corrected.json.data.corrected_fields.registration_number, 'PD20210002');
    assert.deepEqual(corrected.json.data.raw_fields, raw.raw_fields, 'HTTP 层 raw_fields 必须原样保留');
    assert.equal(corrected.json.data.raw_fields.registration_number, rawRegistration);
    assert.equal(corrected.headers.get('etag'), '"2"');

    const after = await call(base, tokenA, 'GET', `${API}/ocr/${raw.id}`);
    assert.equal(after.json.data.revision, 2);
    assert.equal(after.json.data.corrected_fields.name, '用户手改名称');
    assert.deepEqual(after.json.data.raw_fields, raw.raw_fields);
    record('9) 正控制 受理→完成→读回→校正（raw/corrected 在 HTTP 层严格分离）→落库读回→ETag 递增');
  }

  // ---- 3) verifyOCR / 登记核对 / dose_cards gate ---------------------------
  {
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(1));
    const ocr = await waitForOcr(base, tokenA, response.json.data.target_ref.id);
    assert.equal(ocr.verification.match_state, 'insufficient');
    assert.notEqual(ocr.verification.match_state, 'matched', 'missing_fields 非空时绝不 matched');
    assert.ok(assertArray(ocr.verification.missing_fields, 'missing_fields').length > 0);

    const { response: matchedCreate } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const matched = await waitForOcr(base, tokenA, matchedCreate.json.data.target_ref.id);
    assert.equal(matched.verification.match_state, 'matched');
    assert.equal(matched.verification.dose_cards.length, 0, '受理时无 conditions ⇒ dose_cards 为空');

    const verified = await call(base, tokenA, 'POST', `${API}/ocr/${matched.id}/verify`, {
      headers: { 'idempotency-key': nextKey('verify'), 'if-match': `"${matched.revision}"` },
      body: { fields: matched.raw_fields, conditions: DOSE_CONDITIONS_COMPLETE },
    });
    assert.equal(verified.status, 200, 'verifyOCR 契约规定 200');
    assert.deepEqual(Object.keys(verified.json).sort(), ['data', 'meta']);
    assert.deepEqual(
      Object.keys(verified.json.data).sort(),
      ['conflict_fields', 'dose_cards', 'match_state', 'missing_fields', 'registration'],
    );
    assert.equal(verified.json.data.match_state, 'matched');
    assert.equal(
      verified.json.data.dose_cards.length,
      0,
      '替身路径结构性不产卡（#7 验收第 3 条：不对模拟记录显示真实用量）',
    );
    assert.equal(verified.headers.get('etag'), '"2"', 'verify 后 ETag 应为记录的新 revision');

    const { response: noMatchCreate } = await createOcr(base, tokenA, mediaIdForBucket(4));
    const noMatch = await waitForOcr(base, tokenA, noMatchCreate.json.data.target_ref.id);
    assert.equal(noMatch.verification.match_state, 'no_match');
    const noMatchVerified = await call(base, tokenA, 'POST', `${API}/ocr/${noMatch.id}/verify`, {
      headers: { 'idempotency-key': nextKey('verify'), 'if-match': `"${noMatch.revision}"` },
      body: { fields: noMatch.raw_fields, conditions: DOSE_CONDITIONS_COMPLETE },
    });
    assert.equal(noMatchVerified.json.data.match_state, 'no_match');
    assert.equal(noMatchVerified.json.data.dose_cards.length, 0);
    record('3) missing_fields 非空 ⇒ insufficient（绝不 matched）；verify 200 形状正确；替身路径 dose_cards 恒为 []；no_match 亦不给卡');
  }

  // ---- 3d) 登记库未接线 ⇒ unavailable（**注入式接缝**，见 buildInjectedReferenceApp）----
  {
    const { response } = await createOcr(seamBase, seamToken, mediaIdForBucket(0));
    const ocr = await waitForOcr(seamBase, seamToken, response.json.data.target_ref.id);
    assert.equal(ocr.verification.match_state, 'unavailable');
    assert.notEqual(ocr.verification.match_state, 'no_match', '登记库不可用不得伪装成 no_match');
    assert.equal(ocr.verification.registration, null);
    assert.equal(ocr.verification.dose_cards.length, 0);
    record('3d) 登记库未接线 ⇒ unavailable（**经路由插件 deps 接缝**；产品装配刻意不暴露该注入面）');
  }

  // ---- 4) 归属：他人 404，且与"不存在"逐字段同形 ---------------------------
  {
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const ocrId = response.json.data.target_ref.id;
    await waitForOcr(base, tokenA, ocrId);

    const forbidden = await call(base, tokenB, 'GET', `${API}/ocr/${ocrId}`);
    const missing = await call(base, tokenB, 'GET', `${API}/ocr/${randomUUID()}`);
    assert.equal(forbidden.status, 404, '他人记录必须 404');
    assert.equal(missing.status, 404, '不存在记录必须 404');
    assert.deepEqual(Object.keys(forbidden.json).sort(), ['error', 'meta']);
    assert.deepEqual(Object.keys(forbidden.json.error).sort(), Object.keys(missing.json.error).sort());
    assert.deepEqual(forbidden.json.error, missing.json.error, '越权与不存在的错误体必须逐字段同形');
    assert.equal(forbidden.json.error.code, 'NOT_FOUND');
    assert.match(forbidden.json.meta.request_id, UUID_RE);
    assert.match(missing.json.meta.request_id, UUID_RE);
    assert.notEqual(forbidden.json.meta.request_id, missing.json.meta.request_id);

    const otherPatch = await call(base, tokenB, 'PATCH', `${API}/ocr/${ocrId}/correction`, {
      headers: { 'idempotency-key': nextKey('correct-b'), 'if-match': '"1"' },
      body: { corrected_fields: { registration_number: null, name: null, ingredients: [], dosage_form: null } },
    });
    assert.equal(otherPatch.status, 404);
    const otherDelete = await call(base, tokenB, 'DELETE', `${API}/ocr/${ocrId}`, {
      headers: { 'idempotency-key': nextKey('delete-b'), 'if-match': '"1"' },
    });
    assert.equal(otherDelete.status, 404);
    assert.deepEqual(otherPatch.json.error, missing.json.error);
    assert.deepEqual(otherDelete.json.error, missing.json.error);
    record('4) 归属：他人 GET/PATCH/DELETE 一律 404，且错误体与"不存在"同形（不泄露存在性）');
  }

  // ---- 5) If-Match 三态（契约：缺失428 / 非法400 / 不匹配409） --------------
  {
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const ocr = await waitForOcr(base, tokenA, response.json.data.target_ref.id);
    const fields = { registration_number: null, name: null, ingredients: [], dosage_form: null };

    const missingHeader = await call(base, tokenA, 'PATCH', `${API}/ocr/${ocr.id}/correction`, {
      headers: { 'idempotency-key': nextKey('im') },
      body: { corrected_fields: fields },
    });
    assert.equal(missingHeader.status, 428, '缺 If-Match 契约规定 428');
    assert.equal(missingHeader.json.error.code, 'REVISION_REQUIRED');

    const illegal = await call(base, tokenA, 'PATCH', `${API}/ocr/${ocr.id}/correction`, {
      headers: { 'idempotency-key': nextKey('im'), 'if-match': '*' },
      body: { corrected_fields: fields },
    });
    assert.equal(illegal.status, 400, 'If-Match 格式非法契约规定 400（且不允许 *）');
    assert.equal(illegal.json.error.code, 'INVALID_REQUEST');

    const mismatch = await call(base, tokenA, 'PATCH', `${API}/ocr/${ocr.id}/correction`, {
      headers: { 'idempotency-key': nextKey('im'), 'if-match': '"99"' },
      body: { corrected_fields: fields },
    });
    assert.equal(mismatch.status, 409, 'If-Match 不匹配契约规定 409');
    assert.equal(mismatch.json.error.code, 'REVISION_CONFLICT');

    const deleteMissing = await call(base, tokenA, 'DELETE', `${API}/ocr/${ocr.id}`, {
      headers: { 'idempotency-key': nextKey('im') },
    });
    assert.equal(deleteMissing.status, 428);
    const deleteIllegal = await call(base, tokenA, 'DELETE', `${API}/ocr/${ocr.id}`, {
      headers: { 'idempotency-key': nextKey('im'), 'if-match': 'abc' },
    });
    assert.equal(deleteIllegal.status, 400);
    const deleteMismatch = await call(base, tokenA, 'DELETE', `${API}/ocr/${ocr.id}`, {
      headers: { 'idempotency-key': nextKey('im'), 'if-match': '"77"' },
    });
    assert.equal(deleteMismatch.status, 409);
    assert.equal(deleteMismatch.json.error.code, 'REVISION_CONFLICT');
    record('5) If-Match：缺失⇒428／非法(含*)⇒400／不匹配⇒409（PATCH 与 DELETE 各三态）');
  }

  // ---- 5b) deleteOCR 正控制：202 + AckEnvelope --------------------------
  {
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const ocr = await waitForOcr(base, tokenA, response.json.data.target_ref.id);
    const deleted = await call(base, tokenA, 'DELETE', `${API}/ocr/${ocr.id}`, {
      headers: { 'idempotency-key': nextKey('del'), 'if-match': `"${ocr.revision}"` },
    });
    assert.equal(deleted.status, 202, 'deleteOCR 契约规定 202');
    assert.deepEqual(Object.keys(deleted.json).sort(), ['data', 'meta']);
    assert.deepEqual(deleted.json.data, { accepted: true }, 'Ack 只含 accepted（additionalProperties:false）');
    assert.equal(deleted.headers.get('etag'), `"${ocr.revision + 1}"`);
    const gone = await call(base, tokenA, 'GET', `${API}/ocr/${ocr.id}`);
    assert.equal(gone.status, 404, '删除后读取必须 404');
    record('5b) deleteOCR 202 + Ack{accepted:true} + no-store/ETag；删除后 GET 404');
  }

  // ---- 6) 幂等：重放 / 异体 / 并发（计数取自服务 describe().providerCalls） ----
  {
    const mediaId = mediaIdForBucket(0);
    const key = nextKey('replay');
    const first = await createOcr(base, tokenA, mediaId, key);
    const second = await createOcr(base, tokenA, mediaId, key);
    assert.equal(second.response.status, 202);
    assert.equal(second.response.json.data.id, first.response.json.data.id, '同键同体必须回放同一任务');
    assert.equal(second.response.json.data.target_ref.id, first.response.json.data.target_ref.id);

    const conflict = await createOcr(base, tokenA, mediaIdForBucket(1), key);
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.response.json.error.code, 'IDEMPOTENCY_CONFLICT');

    // 同键同体**并发**：恰好 1 个任务 + 恰好 1 次提供者调用
    const before = stubCalls();
    const concurrentKey = nextKey('concurrent');
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(base, tokenA, 'POST', `${API}/ocr`, {
          headers: { 'idempotency-key': concurrentKey },
          body: { media_id: mediaId, media_revision: 1 },
        }),
      ),
    );
    const accepted = attempts.filter((item) => item.status === 202);
    const jobIds = new Set(accepted.map((item) => item.json.data.id));
    const ocrIds = new Set(accepted.map((item) => item.json.data.target_ref.id));
    assert.equal(jobIds.size, 1, `并发同键必须收敛到同一任务，实际 ${JSON.stringify([...jobIds])}`);
    assert.equal(ocrIds.size, 1, `并发同键必须收敛到同一 OCR 记录，实际 ${JSON.stringify([...ocrIds])}`);
    for (const attempt of attempts) {
      assert.ok(
        attempt.status === 202 || (attempt.status === 409 && attempt.json.error.code === 'REQUEST_IN_PROGRESS'),
        `并发落败者只能是 409 REQUEST_IN_PROGRESS，实际 ${attempt.status} ${JSON.stringify(attempt.json?.error?.code)}`,
      );
    }
    await waitForOcr(base, tokenA, [...ocrIds][0]);
    await stubApp.ocrService.settle();
    const calls = stubCalls() - before;
    assert.equal(calls, 1, `同键同体并发必须恰好 1 次提供者调用，实际 ${calls}`);
    record(`6) 幂等：同键同体重放⇒同一资源；同键异体⇒409 IDEMPOTENCY_CONFLICT；同键同体 4 路并发⇒同一任务且 describe().providerCalls 恰好 +${calls}`);
  }

  // ---- 7) 请求边界 ------------------------------------------------------
  {
    const mediaId = mediaIdForBucket(0);

    const noKey = await call(base, tokenA, 'POST', `${API}/ocr`, { body: { media_id: mediaId, media_revision: 1 } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const shortKey = await call(base, tokenA, 'POST', `${API}/ocr`, {
      headers: { 'idempotency-key': 'short' },
      body: { media_id: mediaId, media_revision: 1 },
    });
    assert.equal(shortKey.status, 400);
    assert.equal(shortKey.json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const extraField = await call(base, tokenA, 'POST', `${API}/ocr`, {
      headers: { 'idempotency-key': nextKey('extra') },
      body: { media_id: mediaId, media_revision: 1, user_id: 'forged' },
    });
    assert.equal(extraField.status, 400);
    assert.equal(extraField.json.error.code, 'INVALID_REQUEST');

    const badRevision = await call(base, tokenA, 'POST', `${API}/ocr`, {
      headers: { 'idempotency-key': nextKey('rev') },
      body: { media_id: mediaId, media_revision: 0 },
    });
    assert.equal(badRevision.status, 400);
    assert.equal(badRevision.json.error.code, 'INVALID_REQUEST');

    const badMediaId = await call(base, tokenA, 'POST', `${API}/ocr`, {
      headers: { 'idempotency-key': nextKey('media') },
      body: { media_id: 'not-a-uuid', media_revision: 1 },
    });
    assert.equal(badMediaId.status, 400);
    assert.equal(badMediaId.json.error.code, 'INVALID_REQUEST');

    const noSession = await call(base, null, 'GET', `${API}/ocr/${randomUUID()}`);
    assert.equal(noSession.status, 401);
    assert.equal(noSession.json.error.code, 'SESSION_REQUIRED');
    record('7) 请求边界：缺/过短 Idempotency-Key⇒400 IDEMPOTENCY_KEY_REQUIRED；多余字段/非法 media_id/media_revision⇒400 INVALID_REQUEST；无会话⇒401 SESSION_REQUIRED');
  }

  // ---- 7b) 钉子用例：非 uuid 路径 id ⇒ 400 INVALID_REQUEST（钉住两层分工）----
  {
    // **这条钉住 HTTP 层与服务层的分工，防止未来去掉 params schema 后行为静默翻转。**
    //   分工：**HTTP 层管「格式/形状」** ⇒ 路径 id 非 uuid 时 params schema 先失败 ⇒ 400 INVALID_REQUEST；
    //         **服务层管「存在性/归属/版本」** ⇒ 格式合法但他人/不存在 ⇒ 404、版本不符 ⇒ 409、缺 If-Match ⇒ 428。
    // 阶段 1 服务层对"非 uuid id"给的是 404（UUID_PATTERN 不匹配即视为不存在，以防探测）；
    // 当前 HTTP 层在前 ⇒ 对外 400；**若日后移除 params schema，同一输入会从 400 翻成 404**。
    for (const [method, path] of [
      ['GET', `${API}/ocr/not-a-uuid`],
      ['GET', `${API}/ocr/12345`],
      ['GET', `${API}/ocr/%20`],
    ]) {
      const response = await call(base, tokenA, method, path);
      assert.equal(response.status, 400, `${method} ${path} 非 uuid 路径 id 必须 400（HTTP 层格式判定），实际 ${response.status}`);
      assert.equal(response.json.error.code, 'INVALID_REQUEST', `${method} ${path} 的错误码`);
    }
    const wellFormedMissing = await call(base, tokenA, 'GET', `${API}/ocr/${randomUUID()}`);
    assert.equal(wellFormedMissing.status, 404);
    assert.equal(wellFormedMissing.json.error.code, 'NOT_FOUND');
    record('7b) 钉子·两层分工：非 uuid 路径 id⇒400 INVALID_REQUEST（HTTP 层判格式）；格式合法但不存在⇒404 NOT_FOUND（服务层判存在性）');
  }

  // ---- 8) **产品装配 real 模式**默认关闭：503 / 0 次调用 / 不回退替身 + 结构证据 ----
  {
    const described = realApp.ocrService.describe();
    assert.equal(described.executionMode, 'real', 'real 实例必须如实标注 real');
    assert.equal(described.providerAvailable, false, 'real 缺凭据必须不可用');
    assert.equal(described.modelVersion, 'real-unconfigured');
    assert.notEqual(described.modelVersion, 'stub-v1', '不得静默回退替身');
    assert.equal(described.mediaPort, 'unwired');
    assert.equal(described.referencePort, 'unwired', 'real 下登记库必须未接线');
    assert.equal(described.referenceAvailable, false);
    assert.equal(described.dosePort, 'unwired');
    assert.equal(described.providerCalls, 0, 'real 实例受理前不得有任何提供者调用');

    const realToken = await seedSession(realAuthStore, 'synthetic-ocr-real');
    const rejected = await call(realBase, realToken, 'POST', `${API}/ocr`, {
      headers: { 'idempotency-key': nextKey('real') },
      body: { media_id: mediaIdForBucket(0), media_revision: 1 },
    });
    assert.equal(rejected.status, 503, 'real 缺凭据必须受理前 503');
    assert.equal(rejected.json.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(realApp.ocrService.describe().providerCalls, 0, '受理前 fail-closed 不得调用提供者');
    // 不建任务：换一个键再来一次仍是 503，且调用计数仍为 0。
    const again = await call(realBase, realToken, 'POST', `${API}/ocr`, {
      headers: { 'idempotency-key': nextKey('real') },
      body: { media_id: mediaIdForBucket(0), media_revision: 1 },
    });
    assert.equal(again.status, 503);
    assert.equal(realApp.ocrService.describe().providerCalls, 0);

    // —— 代码层结构证据（"默认关闭"是结构属性，不是约定）——
    const appText = readFileSync(new URL('../../services/api/src/app.ts', import.meta.url), 'utf8');
    const ocrRegistrationLine = appText
      .split(/\r?\n/)
      .find((line) => line.includes('registerOcrRoutes(app, config,'));
    assert.ok(ocrRegistrationLine !== undefined, 'app.ts 必须有 registerOcrRoutes 装配行');
    // 只允许 `guards`（鉴权守卫，本行必填）与两个**隐私域**端口（consent/egress），
    // 以及 `#181`（`b6f8c1b`）新增的 `history` 槽位；
    // 不得出现 provider/store/media/reference/service 等**适配器**端口注入。
    // ⚠ 2026-10-16（GY-I10 作业读面接线片）**既有断言修复**：本断言在基线 `cf9c3c8` 上**本就失败**
    //   （实测原始输出见交接文档）——它写于该行还是简写 `{ guards, … }` 的时代，`guards` 无冒号故不被
    //   正则计入；此后该行改为 `guards: gatedGuards`（全局开关门），`guards` 才被计入。原意（"不得塞入
    //   provider/store/媒体/登记库端口"）不变，故把必填的 `guards` 显式列入白名单，而非放宽其它项。
    // ⚠ 同轮**口径如实登记（不得含糊）**：`history` 为 `#181`（`b6f8c1b`）新增的**识别历史域写入端口**
    //   （端口定义 `app.ts:668-675`：`recordHistoryTerminal` → `appendHistory`），**不是** provider/store/media
    //   泄漏，故同列入白名单；但这使"零端口注入"这一结构属性的口径**实质变宽**——从"只允许隐私域
    //   `consent`/`egress`"变为"隐私域 + 识别历史域写入端口"。本注释**不**主张"零端口注入仍成立"。
    //   下方另补**值断言**：钉住 `guards` 槽位装的确实是 `gatedGuards`（旗标门包装）。
    const ocrInjectedKeys = [...ocrRegistrationLine.matchAll(/([A-Za-z]+):/g)].map((match) => match[1]).sort();
    assert.deepEqual(
      ocrInjectedKeys,
      ['consent', 'egress', 'guards', 'history'].sort(),
      `装配行只允许 guards 槽位、隐私域 consent/egress 端口与识别历史域 history 写入端口；若失败说明装配点被塞入了 provider/store/端口：${ocrRegistrationLine.trim()}`,
    );
    // 值断言（键存在 ≠ 值正确）：`guards` 槽位必须装**旗标门包装后的** `gatedGuards`，不是裸 `guards`
    //   （`\b` 词边界：裸 `guards` 是 `gatedGuards` 的后缀，不能只做子串判断）。
    assert.equal(/\bguards: gatedGuards\b/.test(ocrRegistrationLine), true, `装配行 guards 槽位必须装 gatedGuards（旗标门），实际：${ocrRegistrationLine.trim()}`);
    assert.equal(
      /const gatedGuards = createFlagGatedGuards\(guards, featureFlagGate\);/.test(appText),
      true,
      'app.ts 必须有 gatedGuards 绑定（createFlagGatedGuards(guards, featureFlagGate)）',
    );
    for (const forbidden of ['ocr/provider', 'ocr/store', 'ocr/media', 'ocr/reference', 'ocr/service']) {
      assert.equal(appText.includes(forbidden), false, `app.ts 不得 import ${forbidden}（装配路径不得接触适配器）`);
    }
    const providerText = readFileSync(new URL('../../services/api/src/ocr/provider.ts', import.meta.url), 'utf8');
    for (const network of ['fetch(', 'node:https', 'node:http', 'undici', 'axios', 'XMLHttpRequest']) {
      assert.equal(providerText.includes(network), false, `OCR 提供者层不得含网络调用：${network}`);
    }
    const realSlice = providerText.slice(
      providerText.indexOf('export function createRealOcrProvider'),
      providerText.indexOf('export function createOcrProvider'),
    );
    assert.ok(realSlice.length > 0, 'real 分支切片应非空');
    assert.equal(realSlice.includes('createStubOcrProvider'), false, 'real 分支不得回退替身');
    record('8) 产品装配 real：受理前 503 PROVIDER_UNAVAILABLE、providerCalls=0、不回退替身（real-unconfigured）；+ 结构证据（app.ts 零端口注入/不 import 适配器、provider.ts 无网络客户端、real 分支无替身回退）');
  }

  // ---- 10) 接线（本片）：OCR 作业经**共享作业读面**可读（此前该 kind 未接线 ⇒ 404）----
  {
    const created = await createOcr(base, tokenA, mediaIdForBucket(0));
    assert.equal(created.response.status, 202, 'createOCR 契约规定 202');
    const accepted = created.response.json.data;
    assert.equal(accepted.kind, 'ocr');
    assert.equal(accepted.state, 'queued');

    // 受理后**立刻**读作业面：本片之前这里是 404 NOT_FOUND（与"作业不存在"同形、不泄露存在性）。
    const early = await call(base, tokenA, 'GET', `${API}/jobs/${accepted.id}`);
    assert.equal(early.status, 200, `GET /jobs/{ocrJobId} 必须 200，实际 ${early.status}：${JSON.stringify(early.json)}`);
    assert.equal(early.headers.get('cache-control'), 'no-store');
    assert.equal(early.json.meta.contract_version, '1.0.0');
    assert.equal(early.json.meta.execution_mode, 'stub');
    const observed = early.json.data;
    assert.deepEqual(Object.keys(observed).sort(), [...JOB_KEYS].sort(), 'Job 键集合必须恰好九个（additionalProperties:false）');
    assert.equal(early.headers.get('etag'), `"${observed.revision}"`, 'ETag 必须是资源 revision 的强 ETag');
    assert.equal(observed.kind, 'ocr');
    assert.equal(observed.id, accepted.id);
    assert.equal(observed.target_ref.type, 'ocr');
    assert.match(observed.target_ref.id, UUID_RE);
    assert.match(observed.id, UUID_RE);
    assert.equal(Number.isNaN(Date.parse(observed.deadline_at)), false);
    assert.equal(Number.isNaN(Date.parse(observed.created_at)), false);
    // **状态可见**（不再是 404）：替身无 I/O，落定极快 ⇒ 这里如实接受"已终态"，
    // 确定性的"运行中"样本由组 12 的悬挂提供者给出；两种情形都必须**可区分**。
    assert.ok(JOB_STATES.includes(observed.state), `state 必须落在契约七值闭集内，实际 ${observed.state}`);
    if (observed.result === null) {
      assert.equal(observed.error_code, null, '非终态读取不得凭空带 error_code');
    } else {
      assert.ok(['succeeded', 'uncertain'].includes(observed.state), 'result 只允许出现在 succeeded/uncertain');
    }

    // 成功路径：经**同一个作业读面**轮询到落定，结果过契约分支镜像（不手抄契约）
    const settled = await waitForTerminalJob(base, tokenA, accepted.id);
    assert.equal(settled.state, 'succeeded', `替身分桶 0 应落 succeeded，实际 ${settled.state}`);
    assert.equal(settled.error_code, null);
    assert.deepEqual(Object.keys(settled.result).sort(), ['kind', 'value']);
    assert.equal(settled.result.kind, 'ocr');
    assert.deepEqual(collectResultValueIssues('ocr', settled.result.value), [], 'result.value 必须过 ocr 分支的契约镜像');
    assert.equal(settled.result.value.model_version, 'stub-v1', '替身必须如实标注 model_version');
    assert.equal(settled.result.value.id, accepted.target_ref.id);
    assert.equal(settled.result.value.revision, settled.target_ref.revision, '作业面 target_ref.revision 必须与记录 revision 一致');

    // 既有记录读面与作业读面对齐（`GET /ocr/{id}` 的既有行为未变）
    const record2 = await call(base, tokenA, 'GET', `${API}/ocr/${accepted.target_ref.id}`);
    assert.equal(record2.status, 200);
    assert.equal(record2.json.data.id, settled.result.value.id);
    assert.equal(record2.json.data.revision, settled.target_ref.revision);

    // 作用域：未登录 ⇒ 401；他人作业与"不存在"逐字段同形 404（不泄露存在性）
    const guestJob = await call(base, null, 'GET', `${API}/jobs/${accepted.id}`);
    assert.equal(guestJob.status, 401);
    assert.equal(guestJob.json.error.code, 'SESSION_REQUIRED');
    const foreignJob = await call(base, tokenB, 'GET', `${API}/jobs/${accepted.id}`);
    const missingJob = await call(base, tokenB, 'GET', `${API}/jobs/${randomUUID()}`);
    assert.equal(foreignJob.status, 404);
    assert.equal(missingJob.status, 404);
    assert.equal(foreignJob.json.error.code, 'NOT_FOUND');
    assert.deepEqual(foreignJob.json.error, missingJob.json.error, '他人作业与不存在必须逐字段同形');
    record(`10) 接线·OCR 作业经 \`GET /jobs/{id}\` 可读：200 + 九键 + kind=ocr + 状态可见（此前 404）；受理后立刻读到 state=${observed.state}；终态 state=${settled.state}/error_code=${String(settled.error_code)}/result.kind=${settled.result.kind} 且过 ocr 契约镜像；与 \`GET /ocr/{id}\` 对齐（revision=${settled.target_ref.revision}）；未登录 401／他人与不存在同形 404`);
  }

  // ---- 11) 不回归：识别域仍 200；OCR 无取消能力 ⇒ cancel 如实 503（不得 200/404）----
  {
    // 对照（同一次运行内）：识别域经**同一个** `/jobs/{id}` 路由仍可读 ⇒ 证明 404 的消失只来自 OCR 接线。
    const recognition = await call(base, tokenA, 'POST', `${API}/recognitions`, {
      headers: { 'idempotency-key': nextKey('recognitions-regression') },
      body: { media_id: RECOGNITION_OK_MEDIA, media_revision: 1 },
    });
    assert.equal(recognition.status, 202, JSON.stringify(recognition.json));
    const recognitionJob = await waitForTerminalJob(base, tokenA, recognition.json.data.id);
    assert.equal(recognitionJob.kind, 'recognition');
    assert.equal(recognitionJob.state, 'succeeded');

    const created = await createOcr(base, tokenA, mediaIdForBucket(0));
    assert.equal(created.response.status, 202);
    const jobId = created.response.json.data.id;
    const before = await call(base, tokenA, 'GET', `${API}/jobs/${jobId}`);
    assert.equal(before.status, 200, '取消前必须先能读到该作业');

    const cancelled = await call(base, tokenA, 'POST', `${API}/jobs/${jobId}/cancel`, {
      headers: { 'if-match': `"${before.json.data.revision}"`, 'idempotency-key': nextKey('cancel-ocr') },
    });
    assert.equal(cancelled.status, 503, `OCR 域本基线无取消能力 ⇒ 如实 503（不得 200，也不得 404）：${JSON.stringify(cancelled.json)}`);
    assert.equal(cancelled.json.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(cancelled.json.error.retryable, true, '能力未接线属可重试（接线后同一请求即可成功）');

    // 不得伪造 cancelled、不得改 revision、不得影响可读性
    const after = await call(base, tokenA, 'GET', `${API}/jobs/${jobId}`);
    assert.equal(after.status, 200);
    assert.equal(after.json.data.state, before.json.data.state, '取消能力缺失 ⇒ 状态不得被改动（没有伪造 cancelled）');
    assert.equal(after.json.data.revision, before.json.data.revision, '失败的取消不得递增 revision');

    // 缺头次序与既有 kind 逐字一致（400/428 先于 503；由共享请求头前置校验代答）
    const noKey = await call(base, tokenA, 'POST', `${API}/jobs/${jobId}/cancel`, { headers: { 'if-match': '"1"' } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    const noVersion = await call(base, tokenA, 'POST', `${API}/jobs/${jobId}/cancel`, {
      headers: { 'idempotency-key': nextKey('cancel-ocr-428') },
    });
    assert.equal(noVersion.status, 428);
    assert.equal(noVersion.json.error.code, 'REVISION_REQUIRED');

    // 越权者也不能取消他人的 OCR 作业（同形 404，而不是先告诉他"存在但不可取消"）
    const foreignCancel = await call(base, tokenB, 'POST', `${API}/jobs/${jobId}/cancel`, {
      headers: { 'if-match': '"1"', 'idempotency-key': nextKey('cancel-ocr-b') },
    });
    assert.equal(foreignCancel.status, 404);
    assert.equal(foreignCancel.json.error.code, 'NOT_FOUND');
    record(`11) 不回归·识别域仍 200 succeeded（同一 \`/jobs/{id}\` 路由）；OCR 无取消能力 ⇒ cancel 503 ${cancelled.json.error.code}(retryable=${String(cancelled.json.error.retryable)})（不得 200/404）、状态与 revision 未被改动（state=${after.json.data.state} revision=${after.json.data.revision}）、缺头仍 400/428、越权 cancel 同形 404`);
  }

  // ---- 12) 失败可区分（**注入式接缝**：悬挂 / 强制失败；见 buildInjectedProviderApp）----
  {
    // 运行中：悬挂提供者（永不返回）+ 1s deadline ⇒ 作业读面**读得到** queued/running。
    const hung = await createOcr(providerSeamBase, providerSeamToken, mediaIdForBucket(0), nextKey('seam-hang'));
    assert.equal(hung.response.status, 202, JSON.stringify(hung.response.json));
    const hungJob = hung.response.json.data;
    assert.equal(hungJob.state, 'queued');
    const runningRead = await call(providerSeamBase, providerSeamToken, 'GET', `${API}/jobs/${hungJob.id}`);
    assert.equal(runningRead.status, 200, `运行中必须可读（不得与"作业不存在"同形 404）：${JSON.stringify(runningRead.json)}`);
    const running = runningRead.json.data;
    assert.ok(['queued', 'running'].includes(running.state), `运行中状态应是 queued/running，实际 ${running.state}`);
    assert.equal(running.error_code, null, '运行中不得带 error_code');
    assert.equal(running.result, null, '运行中不得带 result');

    // 终态（超时）：同一读面读出 `timed_out` + 契约 `error_code`（悬挂 ⇒ deadline 触发）
    const timedOut = await waitForTerminalJob(providerSeamBase, providerSeamToken, hungJob.id);
    assert.equal(timedOut.state, 'timed_out');
    assert.equal(timedOut.error_code, 'PROVIDER_TIMEOUT', '超时必须带契约 error_code（不得报成无原因）');
    assert.equal(timedOut.result, null, 'timed_out 不得携带 result');
    assert.notEqual(timedOut.state, running.state, '失败/超时不得与"仍在处理"同形（这正是本片要解封的）');
    // 记录面在失败下**仍是 404**（失败不产出记录）⇒ 如实说明"为什么非有作业读面不可"
    const recordGap = await call(providerSeamBase, providerSeamToken, 'GET', `${API}/ocr/${hungJob.target_ref.id}`);
    assert.equal(recordGap.status, 404, '失败/超时在记录面上与"仍在处理"同形（既有事实，本片不改 OCR 域语义）');

    // 强制失败（非超时失败码）：`failed` + 契约 `error_code`，且与 `timed_out` 可区分
    const forced = await createOcr(providerSeamBase, providerSeamToken, mediaIdForBucket(1), nextKey('seam-failed'));
    assert.equal(forced.response.status, 202, JSON.stringify(forced.response.json));
    const failed = await waitForTerminalJob(providerSeamBase, providerSeamToken, forced.response.json.data.id);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
    assert.equal(failed.result, null);
    assert.notEqual(failed.state, timedOut.state, 'failed 与 timed_out 必须彼此可区分');
    record(`12) 失败可区分（接缝：悬挂⇒timed_out+PROVIDER_TIMEOUT／强制⇒failed+PROVIDER_OUTCOME_UNKNOWN）：同一 \`GET /jobs/{id}\` 200 且 state/error_code 可见 —— 运行中 state=${running.state}/error_code=${String(running.error_code)}；超时 state=${timedOut.state}/error_code=${String(timedOut.error_code)}；强制失败 state=${failed.state}/error_code=${String(failed.error_code)}；运行中与失败态**不再同形**；记录面在失败下仍 404（如实）`);
  }

  console.log(`PASS ${results.length} 组：经真实装配的 app（buildApp）+ 本机回环 HTTP；合成身份/替身提供者/内存 store；未联网、未连库、未调真实供应商`);
  console.log('NOTE 未覆盖（如实声明）：小程序 identify 页标签模式与打包白名单、真实 OCR 供应商、真实登记库/用量来源、标签类真实样本 0 ⇒ 不声称任何准确率、真机、PG 持久化');
  console.log('NOTE 非产品装配的两段（均为路由插件 deps 接缝，产品装配刻意零端口注入）：组 3d「登记库未接线 ⇒ unavailable」；组 12「失败/超时终态与确定性运行中」（悬挂/失败提供者 + 1s deadline）');
} finally {
  await Promise.allSettled([stubApp.close(), realApp.close(), seamApp.close(), providerSeamApp.close()]);
}
