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

const API = '/api/v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * **注入式接缝**（唯一不走产品装配的一段）。
 *
 * 产品装配 `app.ts` 只传 `{ guards }`（零端口注入）——这本身是**默认关闭**的安全属性，
 * 但也意味着"真实登记库未接线 ⇒ unavailable"这一分支**无法**经产品装配构造
 * （real 模式下提供者先 fail-closed，HTTP 上根本走不到登记库那一步）。
 * 因此该分支用**路由插件自身的 `deps` 接缝**在本测试内最小化装配；
 * 组 8 已用产品装配的**结构断言**钉住"产品路径不暴露该注入面"。
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
    assert.ok(
      appText.includes('registerOcrRoutes(app, config, { guards })'),
      '产品装配必须**零端口注入**（只传 guards）；若失败说明装配点被塞入了 provider/store/端口',
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

  console.log(`PASS ${results.length} 组：经真实装配的 app（buildApp）+ 本机回环 HTTP；合成身份/替身提供者/内存 store；未联网、未连库、未调真实供应商`);
  console.log('NOTE 未覆盖（如实声明）：小程序 identify 页标签模式与打包白名单、真实 OCR 供应商、真实登记库/用量来源、标签类真实样本 0 ⇒ 不声称任何准确率、真机、PG 持久化');
  console.log('NOTE 唯一非产品装配的一段：组 3d「登记库未接线 ⇒ unavailable」用路由插件 deps 接缝构造（产品装配刻意零端口注入，故该分支无法经产品装配构造）');
} finally {
  await Promise.allSettled([stubApp.close(), realApp.close(), seamApp.close()]);
}
