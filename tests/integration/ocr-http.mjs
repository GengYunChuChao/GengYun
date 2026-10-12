/**
 * GY-I10 阶段 2a · 标签 OCR 的**真实本机回环 HTTP** 集成回归。
 *
 * 形态：**合成身份 + 替身提供者 + 内存 store**，测试内自建 Fastify 应用并注册
 * `registerOcrRoutes`，然后用 `app.listen({host:'127.0.0.1', port:0})` 起真实回环端口，
 * 用全局 `fetch` 发**真实 HTTP 请求**。**不联网、不连数据库、不调任何真实供应商。**
 *
 * 复用的既有管道（不另造）：`buildApp` 的错误封套/404/`meta`、`createAuthGuards` 的
 * `requireUser`、`routes/support.ts` 的 `buildMeta`、`auth/wechat.ts` 的 stub 身份换取。
 *
 * 本脚本**不注册到 app.ts**（阶段 2b 才做），也不触碰任何既有路由文件。
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createAuthGuards } from '../../services/api/src/auth/middleware.ts';
import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import { createOcrService } from '../../services/api/src/ocr/service.ts';
import { createMemoryOcrStore } from '../../services/api/src/ocr/store.ts';
import { createOcrProvider } from '../../services/api/src/ocr/provider.ts';
import { createOcrMediaPort } from '../../services/api/src/ocr/media.ts';
import {
  createOcrDosePort,
  createOcrReferencePort,
  createSubstituteDosePort,
  createUnwiredReferencePort,
} from '../../services/api/src/ocr/reference.ts';
import { registerOcrRoutes } from '../../services/api/src/routes/ocr.ts';

// ---------------------------------------------------------------- 工具

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertString(value, label) {
  assert.equal(typeof value, 'string', `${label} 必须是 string，实际是 ${typeof value}`);
}

function assertArray(value, label) {
  assert.ok(Array.isArray(value), `${label} 必须是数组，实际是 ${typeof value}`);
  return value;
}

/** 找一个哈希分桶等于 bucket 的媒体 uuid（与替身提供者的确定性脚本一致）。 */
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

const DOSE_CONDITIONS_COMPLETE = {
  crop_id: 'rice',
  region_code: '330100',
  species_id: 'species_barnyardgrass',
  growth_stage: '3-5叶期',
  planting_method: '移栽',
  use_scene: '水稻田',
};

let keySeq = 0;
function nextKey(prefix = 'ocr-http') {
  keySeq += 1;
  return `${prefix}-${String(keySeq).padStart(6, '0')}`;
}

/** 起一个自建应用 + 真实回环端口；返回 base / 计数 / 服务实例。 */
async function startServer(overrides = {}) {
  const config = loadConfig({
    APP_EXECUTION_MODE: overrides.executionMode ?? 'stub',
    LOG_LEVEL: 'silent',
  });
  const authStore = createMemoryAuthStore();
  const guards = createAuthGuards({ store: authStore, now: () => new Date() });
  const app = buildApp({ config, pool: null, store: authStore });

  const counter = { extract: 0 };
  const inner = overrides.innerProvider ?? createOcrProvider({ executionMode: overrides.executionMode ?? 'stub' });
  const provider = {
    executionMode: inner.executionMode,
    modelVersion: inner.modelVersion,
    available: inner.available,
    unavailableReason: inner.unavailableReason,
    async extract(input) {
      counter.extract += 1;
      return inner.extract(input);
    },
  };
  const ocrService = createOcrService({
    store: createMemoryOcrStore(),
    provider,
    media: overrides.media ?? createOcrMediaPort(overrides.executionMode ?? 'stub'),
    reference: overrides.reference ?? createOcrReferencePort(overrides.executionMode ?? 'stub'),
    dose: overrides.dose ?? createOcrDosePort(overrides.executionMode ?? 'stub'),
    idempotencyHmacKey: STUB_IDEMPOTENCY_HMAC_KEY,
  });
  registerOcrRoutes(app, config, guards, ocrService);
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  return { base, counter, ocrService, config, async close() { await app.close(); } };
}

/** 走真实 HTTP 的合成登录（stub 模式：code 派生稳定合成身份，不发起外部请求）。 */
async function login(base, code) {
  const response = await fetch(`${base}/api/v1/auth/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `login-${code}` },
    body: JSON.stringify({ code }),
  });
  assert.equal(response.status, 200, `合成登录应 200，实际 ${response.status}`);
  const payload = await response.json();
  assertString(payload.data.access_token, 'login.data.access_token');
  return payload.data.access_token;
}

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 受理后**纯靠 HTTP**轮询读回 OCR 记录（OCR 域没有 /jobs 路由，故用记录出现与否判定）。 */
async function waitForOcr(base, token, ocrId, tries = 100) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const response = await call(base, token, 'GET', `/api/v1/ocr/${ocrId}`);
    if (response.status === 200) return response.json.data;
    assert.equal(response.status, 404, `等待期间应为 404，实际 ${response.status}`);
    await sleep(5);
  }
  throw new Error(`等待 OCR 记录超时：${ocrId}`);
}

async function createOcr(base, token, mediaId, key = nextKey()) {
  const response = await call(base, token, 'POST', '/api/v1/ocr', {
    headers: { 'idempotency-key': key },
    body: { media_id: mediaId, media_revision: 1 },
  });
  return { response, key };
}

// ---------------------------------------------------------------- 主流程

const results = [];
function record(group) {
  results.push(group);
  console.log(`  PASS ${group}`);
}

const server = await startServer();
const unavailableServer = await startServer({ reference: createUnwiredReferencePort() });
// app 级 real 模式要求完整真实配置（loadConfig 强制校验），本片不提供真实凭据；
// 故 real 的 fail-closed 验证限定在**注入的 real 型 OCR 提供者**层面（应用仍为 stub，便于合成登录）。
const realProviderServer = await startServer({ innerProvider: createOcrProvider({ executionMode: 'real' }) });
const producerCallServer = await startServer();

try {
  const base = server.base;
  const tokenA = await login(base, 'synthetic-ocr-a');
  const tokenB = await login(base, 'synthetic-ocr-b');

  console.log('== GY-I10 阶段 2a 回环 HTTP 集成回归 ==');

  // ---- 1) 受理：契约状态码 + 封套形状 -------------------------------------
  {
    const before = server.counter.extract;
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    assert.equal(response.status, 202, 'createOCR 契约规定 202');
    // meta（契约 Meta：request_id/contract_version/execution_mode，additionalProperties:false）
    const meta = response.json.meta;
    assert.deepEqual(Object.keys(meta).sort(), ['contract_version', 'execution_mode', 'request_id']);
    assert.match(meta.request_id, UUID_RE, 'meta.request_id 应为 uuid');
    assert.equal(meta.contract_version, '1.0.0');
    assert.equal(meta.execution_mode, 'stub');
    // data = Job（kind=ocr，result 受理时为 null）
    const job = response.json.data;
    assert.equal(job.kind, 'ocr');
    assert.equal(job.state, 'queued');
    assert.equal(job.result, null, '受理时不得带出结果');
    assert.equal(job.error_code, null);
    assert.equal(job.target_ref.type, 'ocr');
    assert.match(job.target_ref.id, UUID_RE);
    assertString(job.deadline_at, 'job.deadline_at');
    assertString(job.created_at, 'job.created_at');
    // 契约 JobEnvelope 的 additionalProperties:false
    assert.deepEqual(Object.keys(response.json).sort(), ['data', 'meta']);
    assert.deepEqual(
      Object.keys(job).sort(),
      ['created_at', 'deadline_at', 'error_code', 'id', 'kind', 'result', 'revision', 'state', 'target_ref'],
    );
    // 私有响应头
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('etag'), `"${job.revision}"`);
    await waitForOcr(base, tokenA, job.target_ref.id);
    record('1) createOCR 202 + JobEnvelope/Job/OCRResult 形状 + meta 齐备 + no-store/ETag 头 + 提供者恰好调用 1 次（' + (server.counter.extract - before) + '）');
  }

  // ---- 9) 正控制：受理 → 完成 → 读回（含校正与复核） -----------------------
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
    assert.equal(raw.model_version, 'stub-v1', '替身必须如实标注 model_version');
    const rawRegistration = raw.raw_fields.registration_number;

    // 读回：OCREnvelope 形状 + ETag
    const reread = await call(base, tokenA, 'GET', `/api/v1/ocr/${raw.id}`);
    assert.equal(reread.status, 200);
    assert.deepEqual(reread.json.meta.contract_version, '1.0.0');
    assert.equal(reread.headers.get('etag'), '"1"');
    assert.equal(reread.headers.get('cache-control'), 'no-store');

    // 校正：只改 corrected_fields，raw 逐字段不变，revision 递增
    const corrected = await call(base, tokenA, 'PATCH', `/api/v1/ocr/${raw.id}/correction`, {
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

    // 落库后读回：校正字段已持久，raw 仍未变
    const after = await call(base, tokenA, 'GET', `/api/v1/ocr/${raw.id}`);
    assert.equal(after.json.data.revision, 2);
    assert.equal(after.json.data.corrected_fields.name, '用户手改名称');
    assert.deepEqual(after.json.data.raw_fields, raw.raw_fields);
    record('9) 正控制 受理→完成→读回→校正（raw/corrected 在 HTTP 层严格分离）→落库读回→ETag 递增');
  }

  // ---- 3) verifyOCR / 登记核对 -------------------------------------------
  {
    // 3a) missing_fields 非空 ⇒ 绝不 matched（分桶 1：替身脚本登记号为 null）
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(1));
    const ocr = await waitForOcr(base, tokenA, response.json.data.target_ref.id);
    assert.equal(ocr.verification.match_state, 'insufficient');
    assert.notEqual(ocr.verification.match_state, 'matched', 'missing_fields 非空时绝不 matched');
    assert.ok(assertArray(ocr.verification.missing_fields, 'missing_fields').length > 0);

    // 3b) verify 端点：matched，但生产替身路径 dose_cards 必须为空
    const { response: matchedCreate } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const matched = await waitForOcr(base, tokenA, matchedCreate.json.data.target_ref.id);
    assert.equal(matched.verification.match_state, 'matched');
    assert.equal(matched.verification.dose_cards.length, 0, '受理时无 conditions ⇒ dose_cards 为空');

    const verified = await call(base, tokenA, 'POST', `/api/v1/ocr/${matched.id}/verify`, {
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

    // 3c) 未命中（分桶 4）⇒ no_match，且条件齐全也不给卡
    const { response: noMatchCreate } = await createOcr(base, tokenA, mediaIdForBucket(4));
    const noMatch = await waitForOcr(base, tokenA, noMatchCreate.json.data.target_ref.id);
    assert.equal(noMatch.verification.match_state, 'no_match');
    const noMatchVerified = await call(base, tokenA, 'POST', `/api/v1/ocr/${noMatch.id}/verify`, {
      headers: { 'idempotency-key': nextKey('verify'), 'if-match': `"${noMatch.revision}"` },
      body: { fields: noMatch.raw_fields, conditions: DOSE_CONDITIONS_COMPLETE },
    });
    assert.equal(noMatchVerified.json.data.match_state, 'no_match');
    assert.equal(noMatchVerified.json.data.dose_cards.length, 0);
    record('3) missing_fields 非空 ⇒ insufficient（绝不 matched）；verify 200 形状正确；替身路径 dose_cards 恒为 []；no_match 亦不给卡');
  }

  // ---- 3d) 登记库不可用 ⇒ unavailable（不得用 no_match 掩盖） -------------
  {
    const b = unavailableServer.base;
    const token = await login(b, 'synthetic-ocr-a');
    const { response } = await createOcr(b, token, mediaIdForBucket(0));
    const ocr = await waitForOcr(b, token, response.json.data.target_ref.id);
    assert.equal(ocr.verification.match_state, 'unavailable');
    assert.notEqual(ocr.verification.match_state, 'no_match', '登记库不可用不得伪装成 no_match');
    assert.equal(ocr.verification.registration, null);
    assert.equal(ocr.verification.dose_cards.length, 0);
    record('3d) 登记库未接线 ⇒ unavailable（使用真实 HTTP，且 registration 为 null）');
  }

  // ---- 4) 归属：他人 404，且与"不存在"逐字段同形 --------------------------
  {
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const ocrId = response.json.data.target_ref.id;
    await waitForOcr(base, tokenA, ocrId);

    const forbidden = await call(base, tokenB, 'GET', `/api/v1/ocr/${ocrId}`);
    const missing = await call(base, tokenB, 'GET', `/api/v1/ocr/${randomUUID()}`);
    assert.equal(forbidden.status, 404, '他人记录必须 404');
    assert.equal(missing.status, 404, '不存在记录必须 404');
    // 除 request_id 外逐字段同形（含键集、code、message、retryable、details）
    assert.deepEqual(Object.keys(forbidden.json).sort(), ['error', 'meta']);
    assert.deepEqual(Object.keys(forbidden.json.error).sort(), Object.keys(missing.json.error).sort());
    assert.deepEqual(forbidden.json.error, missing.json.error, '越权与不存在的错误体必须逐字段同形');
    assert.deepEqual(Object.keys(forbidden.json.meta).sort(), ['contract_version', 'execution_mode', 'request_id']);
    assert.equal(forbidden.json.error.code, 'NOT_FOUND');
    assert.equal(missing.json.error.code, 'NOT_FOUND');
    assert.match(forbidden.json.meta.request_id, UUID_RE);
    assert.match(missing.json.meta.request_id, UUID_RE);
    assert.notEqual(forbidden.json.meta.request_id, missing.json.meta.request_id);

    // 他人也不能改/删
    const otherPatch = await call(base, tokenB, 'PATCH', `/api/v1/ocr/${ocrId}/correction`, {
      headers: { 'idempotency-key': nextKey('correct-b'), 'if-match': '"1"' },
      body: { corrected_fields: { registration_number: null, name: null, ingredients: [], dosage_form: null } },
    });
    assert.equal(otherPatch.status, 404);
    const otherDelete = await call(base, tokenB, 'DELETE', `/api/v1/ocr/${ocrId}`, {
      headers: { 'idempotency-key': nextKey('delete-b'), 'if-match': '"1"' },
    });
    assert.equal(otherDelete.status, 404);
    assert.deepEqual(otherPatch.json.error, missing.json.error);
    assert.deepEqual(otherDelete.json.error, missing.json.error);
    record('4) 归属：他人 GET/PATCH/DELETE 一律 404，且错误体与"不存在"逐字段同形（不泄露存在性）');
  }

  // ---- 5) If-Match 三态（契约：缺失428 / 格式非法400 / 不匹配409） ---------
  {
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const ocr = await waitForOcr(base, tokenA, response.json.data.target_ref.id);
    const fields = { registration_number: null, name: null, ingredients: [], dosage_form: null };

    const missingHeader = await call(base, tokenA, 'PATCH', `/api/v1/ocr/${ocr.id}/correction`, {
      headers: { 'idempotency-key': nextKey('im') },
      body: { corrected_fields: fields },
    });
    assert.equal(missingHeader.status, 428, '缺 If-Match 契约规定 428');
    assert.equal(missingHeader.json.error.code, 'REVISION_REQUIRED');

    const illegal = await call(base, tokenA, 'PATCH', `/api/v1/ocr/${ocr.id}/correction`, {
      headers: { 'idempotency-key': nextKey('im'), 'if-match': '*' },
      body: { corrected_fields: fields },
    });
    assert.equal(illegal.status, 400, 'If-Match 格式非法契约规定 400（且不允许 *）');
    assert.equal(illegal.json.error.code, 'INVALID_REQUEST');

    const mismatch = await call(base, tokenA, 'PATCH', `/api/v1/ocr/${ocr.id}/correction`, {
      headers: { 'idempotency-key': nextKey('im'), 'if-match': '"99"' },
      body: { corrected_fields: fields },
    });
    assert.equal(mismatch.status, 409, 'If-Match 不匹配契约规定 409');
    assert.equal(mismatch.json.error.code, 'REVISION_CONFLICT');

    // DELETE 同三态
    const deleteMissing = await call(base, tokenA, 'DELETE', `/api/v1/ocr/${ocr.id}`, {
      headers: { 'idempotency-key': nextKey('im') },
    });
    assert.equal(deleteMissing.status, 428);
    const deleteIllegal = await call(base, tokenA, 'DELETE', `/api/v1/ocr/${ocr.id}`, {
      headers: { 'idempotency-key': nextKey('im'), 'if-match': 'abc' },
    });
    assert.equal(deleteIllegal.status, 400);
    const deleteMismatch = await call(base, tokenA, 'DELETE', `/api/v1/ocr/${ocr.id}`, {
      headers: { 'idempotency-key': nextKey('im'), 'if-match': '"77"' },
    });
    assert.equal(deleteMismatch.status, 409);
    assert.equal(deleteMismatch.json.error.code, 'REVISION_CONFLICT');
    record('5) If-Match：缺失⇒428 REVISION_REQUIRED／非法(含*)⇒400 INVALID_REQUEST／不匹配⇒409 REVISION_CONFLICT（PATCH 与 DELETE 各三态）');
  }

  // ---- 5b) deleteOCR 正控制：202 + AckEnvelope --------------------------
  {
    const { response } = await createOcr(base, tokenA, mediaIdForBucket(0));
    const ocr = await waitForOcr(base, tokenA, response.json.data.target_ref.id);
    const deleted = await call(base, tokenA, 'DELETE', `/api/v1/ocr/${ocr.id}`, {
      headers: { 'idempotency-key': nextKey('del'), 'if-match': `"${ocr.revision}"` },
    });
    assert.equal(deleted.status, 202, 'deleteOCR 契约规定 202');
    assert.deepEqual(Object.keys(deleted.json).sort(), ['data', 'meta']);
    assert.deepEqual(deleted.json.data, { accepted: true }, 'Ack 只含 accepted（additionalProperties:false）');
    assert.equal(deleted.headers.get('etag'), `"${ocr.revision + 1}"`);
    const gone = await call(base, tokenA, 'GET', `/api/v1/ocr/${ocr.id}`);
    assert.equal(gone.status, 404, '删除后读取必须 404');
    record('5b) deleteOCR 202 + Ack{accepted:true} + no-store/ETag；删除后 GET 404');
  }

  // ---- 6) 幂等：重放 / 异体 / 并发 --------------------------------------
  {
    // 6a) 同键同体重放 ⇒ 同一资源
    const mediaId = mediaIdForBucket(0);
    const key = nextKey('replay');
    const first = await createOcr(base, tokenA, mediaId, key);
    const second = await createOcr(base, tokenA, mediaId, key);
    assert.equal(second.response.status, 202);
    assert.equal(second.response.json.data.id, first.response.json.data.id, '同键同体必须回放同一任务');
    assert.equal(second.response.json.data.target_ref.id, first.response.json.data.target_ref.id);

    // 6b) 同键异体 ⇒ 409 IDEMPOTENCY_CONFLICT
    const conflict = await createOcr(base, tokenA, mediaIdForBucket(1), key);
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.response.json.error.code, 'IDEMPOTENCY_CONFLICT');

    // 6c) 同键同体**并发** ⇒ 恰好 1 次提供者调用
    const before = producerCallServer.counter.extract;
    const concurrentToken = await login(producerCallServer.base, 'synthetic-ocr-concurrent');
    const concurrentKey = nextKey('concurrent');
    const concurrentMedia = mediaIdForBucket(0);
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(producerCallServer.base, concurrentToken, 'POST', '/api/v1/ocr', {
          headers: { 'idempotency-key': concurrentKey },
          body: { media_id: concurrentMedia, media_revision: 1 },
        }),
      ),
    );
    const statuses = attempts.map((item) => item.status).sort();
    const accepted = attempts.filter((item) => item.status === 202);
    const jobIds = new Set(accepted.map((item) => item.json.data.id));
    // 注意：`data.id` 是任务 id，`data.target_ref.id` 才是 OCR 记录 id（waitForOcr 要后者）。
    const ocrIds = new Set(accepted.map((item) => item.json.data.target_ref.id));
    assert.equal(jobIds.size, 1, `并发同键必须收敛到同一任务，实际 ${JSON.stringify([...jobIds])}`);
    assert.equal(ocrIds.size, 1, `并发同键必须收敛到同一 OCR 记录，实际 ${JSON.stringify([...ocrIds])}`);
    for (const attempt of attempts) {
      assert.ok(
        attempt.status === 202 || (attempt.status === 409 && attempt.json.error.code === 'REQUEST_IN_PROGRESS'),
        `并发落败者只能是 409 REQUEST_IN_PROGRESS，实际 ${attempt.status} ${JSON.stringify(attempt.json?.error?.code)}`,
      );
    }
    await waitForOcr(producerCallServer.base, concurrentToken, [...ocrIds][0]);
    const calls = producerCallServer.counter.extract - before;
    assert.equal(calls, 1, `同键同体并发必须恰好 1 次提供者调用，实际 ${calls}`);
    record(`6) 幂等：同键同体重放⇒同一资源；同键异体⇒409 IDEMPOTENCY_CONFLICT；同键同体 4 路并发⇒同一任务且提供者恰好调用 ${calls} 次（状态码 ${statuses.join('/')}）`);
  }

  // ---- 7) 请求边界 ------------------------------------------------------
  {
    const mediaId = mediaIdForBucket(0);

    const noKey = await call(base, tokenA, 'POST', '/api/v1/ocr', { body: { media_id: mediaId, media_revision: 1 } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const shortKey = await call(base, tokenA, 'POST', '/api/v1/ocr', {
      headers: { 'idempotency-key': 'short' },
      body: { media_id: mediaId, media_revision: 1 },
    });
    assert.equal(shortKey.status, 400);
    assert.equal(shortKey.json.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const extraField = await call(base, tokenA, 'POST', '/api/v1/ocr', {
      headers: { 'idempotency-key': nextKey('extra') },
      body: { media_id: mediaId, media_revision: 1, user_id: 'forged' },
    });
    assert.equal(extraField.status, 400);
    assert.equal(extraField.json.error.code, 'INVALID_REQUEST');

    const badRevision = await call(base, tokenA, 'POST', '/api/v1/ocr', {
      headers: { 'idempotency-key': nextKey('rev') },
      body: { media_id: mediaId, media_revision: 0 },
    });
    assert.equal(badRevision.status, 400);
    assert.equal(badRevision.json.error.code, 'INVALID_REQUEST');

    const badMediaId = await call(base, tokenA, 'POST', '/api/v1/ocr', {
      headers: { 'idempotency-key': nextKey('media') },
      body: { media_id: 'not-a-uuid', media_revision: 1 },
    });
    assert.equal(badMediaId.status, 400);
    assert.equal(badMediaId.json.error.code, 'INVALID_REQUEST');

    // 缺鉴权
    const noSession = await call(base, null, 'GET', `/api/v1/ocr/${randomUUID()}`);
    assert.equal(noSession.status, 401);
    assert.equal(noSession.json.error.code, 'SESSION_REQUIRED');
    record('7) 请求边界：缺/过短 Idempotency-Key⇒400 IDEMPOTENCY_KEY_REQUIRED；多余字段/非法 media_id/media_revision⇒400 INVALID_REQUEST；无会话⇒401 SESSION_REQUIRED');
  }

  // ---- 7b) 钉子用例：非 uuid 路径 id ⇒ 400 INVALID_REQUEST（钉住两层分工）----
  {
    // **这条钉住 HTTP 层与服务层的分工，防止未来去掉 params schema 后行为静默翻转。**
    //
    // 分工（指挥 2026-10-12 裁定）：
    //   - **HTTP 层负责「格式/形状」** ⇒ 路径 `id` 不满足契约 `format: uuid` 时，
    //     Fastify 的 params schema 先失败 ⇒ **400 `INVALID_REQUEST`**；
    //   - **服务层负责「存在性/归属/版本」** ⇒ 即便 id 格式合法，也会对他人或不存在返回
    //     **404 `NOT_FOUND`**（且两者同形）、对版本不符返回 **409 `REVISION_CONFLICT`**、
    //     缺失 `If-Match` 返回 **428 `REVISION_REQUIRED`**。
    //
    // 注意：阶段 1 的服务层对"非 uuid 的 id"给的是 **404**（`UUID_PATTERN` 不匹配即视为不存在，
    // 以防探测）。当前 HTTP 层在前，所以对外表现为 400；**若阶段 2b 移除 params schema，
    // 同一输入会从 400 翻成 404** —— 这条用例就是用来在翻转时立刻报警。
    for (const [method, path] of [
      ['GET', '/api/v1/ocr/not-a-uuid'],
      ['GET', '/api/v1/ocr/12345'],
      ['GET', '/api/v1/ocr/%20'],
    ]) {
      const response = await call(base, tokenA, method, path);
      assert.equal(response.status, 400, `${method} ${path} 非 uuid 路径 id 必须 400（HTTP 层格式判定），实际 ${response.status}`);
      assert.equal(response.json.error.code, 'INVALID_REQUEST', `${method} ${path} 的错误码`);
    }
    // 对照：**格式合法但不存在** ⇒ 404 NOT_FOUND（分工的另一半），证明不是"一律 400"。
    const wellFormedMissing = await call(base, tokenA, 'GET', `/api/v1/ocr/${randomUUID()}`);
    assert.equal(wellFormedMissing.status, 404);
    assert.equal(wellFormedMissing.json.error.code, 'NOT_FOUND');
    record('7b) 钉子·两层分工：非 uuid 路径 id⇒400 INVALID_REQUEST（HTTP 层判格式）；格式合法但不存在⇒404 NOT_FOUND（服务层判存在性）—— 防 2b 去掉 schema 后静默翻转');
  }

  // ---- 8) real 型提供者缺凭据 ⇒ 受理前 503，不建任务、不调提供者、不回退替身 ------
  {
    const b = realProviderServer.base;
    const token = await login(b, 'synthetic-ocr-real');
    const before = realProviderServer.counter.extract;
    const rejected = await call(b, token, 'POST', '/api/v1/ocr', {
      headers: { 'idempotency-key': nextKey('real') },
      body: { media_id: mediaIdForBucket(0), media_revision: 1 },
    });
    assert.equal(rejected.status, 503, 'real 缺凭据必须 503');
    assert.equal(rejected.json.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(realProviderServer.counter.extract - before, 0, '受理前拒绝，不得调用提供者');
    const described = realProviderServer.ocrService.describe();
    assert.equal(described.executionMode, 'real');
    assert.equal(described.providerAvailable, false);
    assertString(described.providerUnavailableReason, 'providerUnavailableReason');
    assert.equal(described.modelVersion, 'real-unconfigured', '不得静默回退替身');
    // 不建任务：同键重放也仍然 503（说明没有留下任何已受理的占位任务）
    const again = await call(b, token, 'POST', '/api/v1/ocr', {
      headers: { 'idempotency-key': nextKey('real') },
      body: { media_id: mediaIdForBucket(0), media_revision: 1 },
    });
    assert.equal(again.status, 503);
    record('8) real 型提供者缺凭据 ⇒ 受理前 503 PROVIDER_UNAVAILABLE；提供者调用 0 次；model_version=real-unconfigured（未回退替身）');
  }

  console.log(`PASS ${results.length} 组回环 HTTP 回归；合成身份/替身提供者/内存 store；真实本机回环 fetch；未联网、未连库、未调真实供应商`);
  console.log('NOTE 未覆盖（如实声明）：app.ts 注册（阶段 2b）、小程序 identify 页标签模式、打包白名单、真实 OCR 供应商、真实登记库/用量来源、标签类真实样本 0 ⇒ 不声称任何准确率、真机、PG 持久化');
} finally {
  await Promise.allSettled([server.close(), unavailableServer.close(), realProviderServer.close(), producerCallServer.close()]);
}
