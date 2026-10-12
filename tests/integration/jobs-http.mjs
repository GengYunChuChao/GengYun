// GY-I01 跨 kind 作业读面/取消面 · 隔离集成回归（本机 loopback 真实 HTTP，经**真实装配**的 app）。
//
// 运行：`node tests/integration/jobs-http.mjs`（退出码 0 表示通过；任何断言失败以非 0 退出并打印原始断言）
//
// 边界（如实标注，不得外推）：
// - 只用本机回环（127.0.0.1，随机端口）；**不发起任何外网请求**、**不连接任何数据库**（内存 store）。
// - 身份是**合成**的：stub 模式经真实 `POST /api/v1/auth/wechat`（替身身份提供者）登录，不涉及真实 openid。
// - 提供者是**明确标注的替身**（识别/转写 stub 分桶；一个悬挂包装用于构造 `running`）；**不是真实供应商**。
// - **真实样本为 0** ⇒ 本脚本不产生也不声称任何准确率或质量结论。
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import Fastify from 'fastify';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { ApiError, buildErrorEnvelope } from '../../services/api/src/errors.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createAuthGuards } from '../../services/api/src/auth/middleware.ts';
import { createMemoryRecognitionStore } from '../../services/api/src/recognitions/store.ts';
import { createStubRecognitionProvider } from '../../services/api/src/recognitions/provider.ts';
import { createRecognitionService } from '../../services/api/src/recognitions/service.ts';
import { createSubstituteMediaPort as createRecognitionMediaPort } from '../../services/api/src/recognitions/media.ts';
import { createJobRegistry } from '../../services/api/src/jobs/registry.ts';
import { createRecognitionJobSource } from '../../services/api/src/jobs/sources.ts';
import { registerJobRoutes } from '../../services/api/src/jobs/routes.ts';

const API = '/api/v1';
const JOBS = API + '/jobs';
const TERMINAL = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'];
const JOB_KEYS = ['created_at', 'deadline_at', 'error_code', 'id', 'kind', 'result', 'revision', 'state', 'target_ref'];
const observations = [];
const root = new URL('../../', import.meta.url);
const HMAC = 'gengyun-stub-idempotency-hmac-key';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

// 识别域替身的分桶/场景 id（取自 GY-I09 既有集成脚本的同口径常量）。
const RECOGNITION_OK = '11111111-1111-4111-8111-111111111111';
const RECOGNITION_UNCERTAIN = '77777777-7777-4777-8777-777777777777';
const RECOGNITION_HANG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** 与 speech/provider.ts 的 bucketOf 同口径：sha256(media_id) 首字节对 6 取模（0=正常，4=超长⇒failed）。 */
function mediaIdForBucket(bucket) {
  for (let attempt = 0; attempt < 500000; attempt += 1) {
    const candidate = randomUUID();
    if (createHash('sha256').update(candidate).digest()[0] % 6 === bucket) return candidate;
  }
  throw new Error(`未找到分桶 ${bucket} 的媒体 uuid`);
}
const SPEECH_OK = mediaIdForBucket(0);
const SPEECH_TOO_LONG = mediaIdForBucket(4);

let keySeq = 0;
const newKey = (label) => `jobs-http-${label}-${String((keySeq += 1)).padStart(4, '0')}`;

let passed = 0;
async function group(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error?.message}`);
    throw error;
  }
}

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
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: response.status, body, text, etag: response.headers.get('etag'), cache: response.headers.get('cache-control') };
  };
}

/** 同形判定：只比 `error` 与除逐请求 `request_id` 外的 `meta`（request_id 每请求必然不同）。 */
function sameShape(a, b) {
  assert.deepEqual(a.body.error, b.body.error, 'error 封套必须逐字段相同');
  assert.deepEqual({ ...a.body.meta, request_id: 'x' }, { ...b.body.meta, request_id: 'x' }, 'meta 除 request_id 外必须相同');
}

// ---------------------------------------------------------------- 真实装配（识别域 + 转写域）
const authStore = createMemoryAuthStore();
const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' });
const baseProvider = createStubRecognitionProvider();
const orchestratedProvider = {
  ...baseProvider,
  async recognize(input) {
    if (input.mediaId === RECOGNITION_HANG) return new Promise(() => {});
    return baseProvider.recognize(input);
  },
};
const app = buildApp({
  config,
  store: authStore,
  recognitionStore: createMemoryRecognitionStore(),
  recognitionProvider: orchestratedProvider,
  recognitionMedia: createRecognitionMediaPort(),
  recognitionJobDeadlineMs: 5000,
});
const origin = await app.listen({ host: '127.0.0.1', port: 0 });
const http = makeHttp(origin);
observations.push('loopback origin=' + origin);
const speech = app.speechService;

try {
  const login = async (code) => {
    const res = await http(`${API}/auth/wechat`, { method: 'POST', headers: { 'idempotency-key': 'jobs-http-login-' + code }, body: { code } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data.access_token;
  };
  const tokenA = await login('jobs-http-synthetic-a');
  const tokenB = await login('jobs-http-synthetic-b');

  const createRecognition = async (mediaId, token = tokenA) => {
    const res = await http(`${API}/recognitions`, { method: 'POST', token, headers: { 'idempotency-key': newKey('rec-create') }, body: { media_id: mediaId, media_revision: 1 } });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    return res.body.data;
  };
  const readJob = async (jobId, token = tokenA) => http(`${JOBS}/${jobId}`, { token });
  /** 轮询直到终态（识别域：读取面本身就是被测对象）。 */
  const awaitTerminal = async (jobId, token = tokenA) => {
    let job = (await readJob(jobId, token)).body.data;
    for (let i = 0; i < 400 && !TERMINAL.includes(job.state); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      job = (await readJob(jobId, token)).body.data;
    }
    assert.ok(TERMINAL.includes(job.state), '任务未到达终态：' + job.state);
    return job;
  };

  // -------- [1] 正控制：识别域作业经共享面可读（含契约形状与头部） --------
  let recognitionOkJobId = null;
  await group('[1] 正控制·识别域：受理 → 经 `GET /jobs/{id}` 读 queued → 终态 succeeded（契约九字段 + ETag + no-store）', async () => {
    const created = await createRecognition(RECOGNITION_OK);
    recognitionOkJobId = created.id;
    // 受理响应即 `queued` 的确定性观测点（202 语义；此后读取可能已经进展，故不在此断言"仍未完成"）。
    assert.equal(created.state, 'queued', '受理响应必须是 queued（202 语义）');
    const read = await readJob(created.id);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.kind, 'recognition');
    assert.ok(TERMINAL.includes(read.body.data.state) || read.body.data.state === 'queued' || read.body.data.state === 'running');
    if (read.body.data.state === 'queued' || read.body.data.state === 'running') {
      assert.equal(read.body.data.result, null, 'queued/running 不得带 result');
    }
    assert.equal(read.etag, `"${read.body.data.revision}"`);
    assert.equal(read.cache, 'no-store');
    assert.deepEqual(Object.keys(read.body.data).sort(), JOB_KEYS);
    const done = await awaitTerminal(created.id);
    assert.equal(done.state, 'succeeded');
    assert.equal(done.error_code, null);
    assert.equal(done.result.kind, 'recognition', 'result 判别子必须与 kind 一致');
    observations.push('识别域 job=' + created.id + ' 受理=queued → ' + done.state + ' result.kind=' + done.result.kind);
  });

  // -------- [2] 正控制：转写域作业经共享面可读；并给出「改前 404 → 改后 200」对照 --------
  let transcriptionJobId = null;
  await group('[2] 正控制·转写域：受理 → settle → 经 `GET /jobs/{id}` 读到 succeeded（result.kind=transcription）', async () => {
    const created = await http(`${API}/speech/transcriptions`, { method: 'POST', token: tokenA, headers: { 'idempotency-key': newKey('sp-create') }, body: { media_id: SPEECH_OK, media_revision: 1 } });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    transcriptionJobId = created.body.data.id;
    await speech.settle();
    const read = await readJob(transcriptionJobId);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.data.kind, 'transcription');
    assert.equal(read.body.data.state, 'succeeded');
    assert.equal(read.body.data.result.kind, 'transcription');
    assert.deepEqual(Object.keys(read.body.data).sort(), JOB_KEYS);
    observations.push('转写域 job=' + transcriptionJobId + ' state=' + read.body.data.state);
  });

  await group('[3] 对照·「改前 404 → 改后 200」：同 store、同 job id，只把转写源从注册表移除', async () => {
    // 对照臂：等价于收敛前"识别域独占注册 /jobs/{id}"的装配——注册表里只有识别域源；
    // 其余管道（鉴权守卫、错误封套、Ajv 设置）与主实例同口径，故 404 形状可比。
    const beforeApp = Fastify({ logger: false, ajv: { customOptions: { removeAdditional: false } } });
    const beforeRecognitionService = createRecognitionService({
      store: createMemoryRecognitionStore(),
      provider: createStubRecognitionProvider({}),
      media: createRecognitionMediaPort(),
      idempotencyHmacKey: HMAC,
    });
    registerJobRoutes(beforeApp, config, createAuthGuards({ store: authStore, now: () => new Date() }), createJobRegistry([
      createRecognitionJobSource(beforeRecognitionService),
    ]));
    beforeApp.setNotFoundHandler((request, reply) => {
      reply.status(404).send(buildErrorEnvelope(new ApiError('NOT_FOUND', `未实现的路径：${request.method} ${request.url}`), { request_id: request.id, execution_mode: config.executionMode }));
    });
    beforeApp.setErrorHandler((error, request, reply) => {
      if (error instanceof ApiError) return reply.status(error.status).send(buildErrorEnvelope(error, { request_id: request.id, execution_mode: config.executionMode }));
      return reply.status(500).send({ error: { message: '内部错误', retryable: false, details: [] }, meta: { request_id: request.id, contract_version: '1.0.0', execution_mode: config.executionMode } });
    });
    const beforeOrigin = await beforeApp.listen({ host: '127.0.0.1', port: 0 });
    const beforeHttp = makeHttp(beforeOrigin);
    try {
      const after = await readJob(transcriptionJobId);
      const before = await beforeHttp(`${JOBS}/${transcriptionJobId}`, { token: tokenA });
      console.log(`[前后对照] 同一个转写 job id：改后（两源注册表）→ ${after.status} ${after.body?.data?.state ?? '-'}；改前等价臂（仅识别域源）→ ${before.status} ${before.body?.error?.code ?? '-'}`);
      assert.equal(after.status, 200, '收敛后：转写 job 必须可读');
      assert.equal(before.status, 404, '收敛前等价臂：转写 job 必须 404（识别域独占）');
      assert.equal(before.body.error.code, 'NOT_FOUND');
      observations.push('前后对照：转写 job 改前 404 → 改后 200');
    } finally {
      await beforeApp.close();
    }
  });

  // -------- [4] 归属与同形 404（他人 / 未知 / 非法 uuid / 未接线 kind） --------
  await group('[4] 反例·他人作业 / 未知 id / 非法 uuid / 未接线 kind 四类 GET 一律同形 404', async () => {
    const foreign = await readJob(recognitionOkJobId, tokenB);
    const unknown = await readJob(UNKNOWN_ID, tokenA);
    const malformed = await readJob('not-a-uuid', tokenA);
    // "未接线 kind"：拿转写 job 的 id 去问"只有识别域源"的注册表（等价收敛前/未接线装配）。
    const beforeRecognitionService = createRecognitionService({ store: createMemoryRecognitionStore(), provider: createStubRecognitionProvider({}), media: createRecognitionMediaPort(), idempotencyHmacKey: HMAC });
    const unwiredRegistry = createJobRegistry([createRecognitionJobSource(beforeRecognitionService)]);
    const unwired = await unwiredRegistry.get({ userId: 'u', jobId: transcriptionJobId }).then(
      () => null,
      (e) => e,
    );
    for (const [label, res] of [['他人作业', foreign], ['未知 id', unknown], ['非法 uuid', malformed]]) {
      assert.equal(res.status, 404, `${label} 应为 404`);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    }
    sameShape(foreign, unknown);
    sameShape(foreign, malformed);
    assert.equal(unwired?.code, 'NOT_FOUND', '未接线 kind 必须与"作业不存在"同形');
    assert.equal(unwired?.status, 404);
    observations.push('同形 404：他人/未知/非法 uuid（HTTP）与未接线 kind（注册表）四类一致');
  });

  await group('[5] 反例·他人取消 / 未知 id 取消 / 非法 uuid 取消 一律同形 404；无会话 401', async () => {
    const ifMatch = '"1"';
    const foreign = await http(`${JOBS}/${recognitionOkJobId}/cancel`, { method: 'POST', token: tokenB, headers: { 'if-match': ifMatch, 'idempotency-key': newKey('f') } });
    const unknown = await http(`${JOBS}/${UNKNOWN_ID}/cancel`, { method: 'POST', token: tokenA, headers: { 'if-match': ifMatch, 'idempotency-key': newKey('u') } });
    const malformed = await http(`${JOBS}/not-a-uuid/cancel`, { method: 'POST', token: tokenA, headers: { 'if-match': ifMatch, 'idempotency-key': newKey('m') } });
    for (const [label, res] of [['他人取消', foreign], ['未知 id 取消', unknown], ['非法 uuid 取消', malformed]]) {
      assert.equal(res.status, 404, `${label} 应为 404`);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    }
    sameShape(foreign, unknown);
    sameShape(foreign, malformed);
    for (const [method, path] of [['GET', `${JOBS}/${recognitionOkJobId}`], ['POST', `${JOBS}/${recognitionOkJobId}/cancel`]]) {
      const res = await http(path, { method, headers: { 'if-match': '"1"', 'idempotency-key': newKey('anon') } });
      assert.equal(res.status, 401, `${method} 无会话应为 401`);
      assert.equal(res.body.error.code, 'SESSION_REQUIRED');
    }
  });

  // -------- [6] cancel：需 If-Match 与 Idempotency-Key；复用识别域既有取消能力 --------
  let hangeJobId = null;
  await group('[6] cancel 正控制·识别域：`running` 作业 → 200 cancelled（ETag 递增）；同键原样重放回放同一结果；新键旧 If-Match ⇒ 409', async () => {
    const created = await createRecognition(RECOGNITION_HANG);
    hangeJobId = created.id;
    let job = (await readJob(created.id)).body.data;
    for (let i = 0; i < 400 && job.state !== 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      job = (await readJob(created.id)).body.data;
    }
    assert.equal(job.state, 'running', '悬挂提供者的作业应停在 running');
    const key = newKey('cancel');
    const cancelled = await http(`${JOBS}/${job.id}/cancel`, { method: 'POST', token: tokenA, headers: { 'if-match': `"${job.revision}"`, 'idempotency-key': key } });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.data.state, 'cancelled');
    assert.equal(cancelled.body.data.result, null, 'cancelled 不得带 result');
    assert.equal(cancelled.etag, `"${cancelled.body.data.revision}"`);
    const replayed = await http(`${JOBS}/${job.id}/cancel`, { method: 'POST', token: tokenA, headers: { 'if-match': `"${job.revision}"`, 'idempotency-key': key } });
    assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
    assert.equal(replayed.body.data.revision, cancelled.body.data.revision, '同键原样重放必须回放同一取消结果');
    const stale = await http(`${JOBS}/${job.id}/cancel`, { method: 'POST', token: tokenA, headers: { 'if-match': `"${job.revision}"`, 'idempotency-key': newKey('cancel-stale') } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
    observations.push('cancel：running→cancelled revision=' + cancelled.body.data.revision + '；同键重放回放；新键旧 If-Match→409');
  });

  await group('[7] 反例·cancel 缺 If-Match ⇒ 428；If-Match 非法 ⇒ 400；缺 Idempotency-Key ⇒ 400', async () => {
    const created = await createRecognition(RECOGNITION_HANG);
    const job = (await readJob(created.id)).body.data;
    const noIfMatch = await http(`${JOBS}/${job.id}/cancel`, { method: 'POST', token: tokenA, headers: { 'idempotency-key': newKey('no-if') } });
    assert.equal(noIfMatch.status, 428);
    assert.equal(noIfMatch.body.error.code, 'REVISION_REQUIRED');
    for (const bad of ['1', '*', 'abc', '"0"']) {
      const res = await http(`${JOBS}/${job.id}/cancel`, { method: 'POST', token: tokenA, headers: { 'if-match': bad, 'idempotency-key': newKey('bad-if') } });
      assert.equal(res.status, 400, `If-Match=${bad} 应为 400`);
      assert.equal(res.body.error.code, 'INVALID_REQUEST');
    }
    const noKey = await http(`${JOBS}/${job.id}/cancel`, { method: 'POST', token: tokenA, headers: { 'if-match': `"${job.revision}"` } });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    // 作业仍未被取消（上述失败不得产生副作用）
    const after = (await readJob(job.id)).body.data;
    assert.equal(after.state, 'running');
    assert.equal(after.revision, job.revision);
  });

  await group('[8] 反例·已终态作业 cancel ⇒ 拒绝（OBJECT_UNAVAILABLE）且状态/revision 不变（不复活）', async () => {
    const before = (await readJob(recognitionOkJobId)).body.data;
    assert.equal(before.state, 'succeeded');
    const rejected = await http(`${JOBS}/${recognitionOkJobId}/cancel`, { method: 'POST', token: tokenA, headers: { 'if-match': `"${before.revision}"`, 'idempotency-key': newKey('terminal') } });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, 'OBJECT_UNAVAILABLE');
    const after = (await readJob(recognitionOkJobId)).body.data;
    assert.equal(after.state, 'succeeded', '已终态不得被取消');
    assert.equal(after.revision, before.revision, '被拒的取消不得推进 revision');
  });

  await group('[9] 反例·转写域**无取消能力**：作业存在（GET 200）但 cancel ⇒ 409 OBJECT_UNAVAILABLE，且状态不被改动', async () => {
    const before = (await readJob(transcriptionJobId)).body.data;
    assert.equal(before.state, 'succeeded');
    const rejected = await http(`${JOBS}/${transcriptionJobId}/cancel`, { method: 'POST', token: tokenA, headers: { 'if-match': `"${before.revision}"`, 'idempotency-key': newKey('sp-cancel') } });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, 'OBJECT_UNAVAILABLE', '不得假装取消成功');
    const after = (await readJob(transcriptionJobId)).body.data;
    assert.equal(after.state, before.state, '不得伪造 cancelled');
    assert.equal(after.revision, before.revision);
    observations.push('转写域 cancel ⇒ 409 OBJECT_UNAVAILABLE（无取消能力，如实拒绝）');
  });

  await group('[10] cancel 并发：同键并发 ⇒ 恰好一次迁移（两次响应同一 revision）；异键并发 + 同一 If-Match ⇒ 恰好一个 200、一个 409', async () => {
    // (a) 同键并发
    const sameKeyJob = await createRecognition(RECOGNITION_HANG);
    let job = (await readJob(sameKeyJob.id)).body.data;
    for (let i = 0; i < 400 && job.state !== 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      job = (await readJob(sameKeyJob.id)).body.data;
    }
    const key = newKey('conc-same');
    const sameResults = await Promise.all([1, 2].map(() => http(`${JOBS}/${job.id}/cancel`, { method: 'POST', token: tokenA, headers: { 'if-match': `"${job.revision}"`, 'idempotency-key': key } })));
    const sameStatuses = sameResults.map((r) => r.status);
    const revisionAfter = (await readJob(job.id)).body.data.revision;
    console.log(`[并发实测·cancel 同键 2 次] statuses=${JSON.stringify(sameStatuses)} 迁移前 revision=${job.revision} → 迁移后 ${revisionAfter}`);
    for (const res of sameResults) assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(revisionAfter, job.revision + 1, '同键并发必须恰好迁移一次');
    assert.equal(sameResults[0].body.data.revision, sameResults[1].body.data.revision, '两次响应必须回放同一结果');

    // (b) 异键并发 + 同一 If-Match
    const diffKeyJob = await createRecognition(RECOGNITION_HANG);
    let job2 = (await readJob(diffKeyJob.id)).body.data;
    for (let i = 0; i < 400 && job2.state !== 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      job2 = (await readJob(diffKeyJob.id)).body.data;
    }
    const diffResults = await Promise.all([
      http(`${JOBS}/${job2.id}/cancel`, { method: 'POST', token: tokenA, headers: { 'if-match': `"${job2.revision}"`, 'idempotency-key': newKey('conc-a') } }),
      http(`${JOBS}/${job2.id}/cancel`, { method: 'POST', token: tokenA, headers: { 'if-match': `"${job2.revision}"`, 'idempotency-key': newKey('conc-b') } }),
    ]);
    const statuses = diffResults.map((r) => r.status).sort((a, b) => a - b);
    const loser = diffResults.find((r) => r.status === 409);
    const revisionAfter2 = (await readJob(job2.id)).body.data.revision;
    console.log(`[并发实测·cancel 异键 2 次同一 If-Match] statuses=${JSON.stringify(statuses)} 冲突码=${loser?.body?.error?.code} 迁移前 revision=${job2.revision} → 迁移后 ${revisionAfter2}`);
    assert.deepEqual(statuses, [200, 409], JSON.stringify(diffResults.map((r) => r.body)));
    assert.ok(['REVISION_CONFLICT', 'OBJECT_UNAVAILABLE'].includes(loser.body.error.code), '落败者必须是契约内的状态冲突码');
    assert.equal(revisionAfter2, job2.revision + 1, '异键并发同样必须恰好迁移一次');
    assert.equal((await readJob(job2.id)).body.data.state, 'cancelled');
    observations.push('cancel 并发：同键 ⇒ 恰好一次迁移；异键同 If-Match ⇒ 恰好一个 200 + 一个 409');
  });

  await group('[11] 如实性·`succeeded` 带 result 且 error_code=null；`failed` 带 error_code 且 result=null（转写域超长桶）', async () => {
    const ok = (await readJob(recognitionOkJobId)).body.data;
    assert.equal(ok.state, 'succeeded');
    assert.equal(ok.error_code, null);
    assert.notEqual(ok.result, null);
    const created = await http(`${API}/speech/transcriptions`, { method: 'POST', token: tokenA, headers: { 'idempotency-key': newKey('sp-fail') }, body: { media_id: SPEECH_TOO_LONG, media_revision: 1 } });
    assert.equal(created.status, 202);
    await speech.settle();
    const failed = await readJob(created.body.data.id);
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    assert.equal(failed.body.data.state, 'failed');
    assert.equal(failed.body.data.result, null, 'failed 不得带 result');
    assert.equal(typeof failed.body.data.error_code, 'string', 'failed 必须带契约 error_code');
    observations.push('如实性：succeeded(result≠null,error_code=null) / failed(result=null,error_code=' + failed.body.data.error_code + ')');
  });

  await group('[12] 结构·`/jobs/{id}` 与 `/jobs/{id}/cancel` 全仓**注册点各恰好 1 处**（且都在 jobs/routes.ts）', async () => {
    const srcDir = new URL('services/api/src/', root);
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith('.ts')) files.push(child);
      }
    };
    walk(srcDir);
    const hits = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/`\$\{API_PREFIX\}\/jobs\/:id[^`]*`/g)) {
        hits.push({ file: file.pathname.split('/services/api/src/')[1], pattern: match[0].replace(/`/g, '') });
      }
    }
    console.log('[注册点] ' + hits.map((h) => `${h.file} → ${h.pattern}`).join(' | '));
    assert.equal(hits.length, 2, `全仓应恰好 2 处（GET + POST），实际 ${hits.length}`);
    for (const hit of hits) assert.equal(hit.file, 'jobs/routes.ts', '注册点必须只在新共享面');
    assert.ok(hits.some((h) => h.pattern === '${API_PREFIX}/jobs/:id'), 'GET 注册存在');
    assert.ok(hits.some((h) => h.pattern === '${API_PREFIX}/jobs/:id/cancel'), 'POST cancel 注册存在');
    observations.push('单一注册：/jobs/{id} 与 /jobs/{id}/cancel 各 1 处，均在 jobs/routes.ts');
  });
} finally {
  await app.close();
}

console.log(
  `PASS ${passed} loopback HTTP groups; real assembly (recognition + transcription job sources); ` +
    'synthetic identity; stub providers (替身); loopback only, no supplier, no PG, no real sample',
);
for (const line of observations) console.log('  - ' + line);
