#!/usr/bin/env node
/**
 * GY-I11 阶段 2a · 转写路由的**真实本机回环 HTTP**集成证据（Refs #11）。
 *
 * 运行：`node tests/integration/speech-http.mjs`
 *
 * 口径（不得越界声称）：
 * - **只用本机回环 HTTP**（`127.0.0.1`，Fastify `listen({port:0})` 随机端口）：**不发起任何外网请求**，
 *   不连接任何数据库（`pool: null` ⇒ 认证与转写都用内存 store）。
 * - 身份是**合成**的：直接按 `AuthStore` 公开 API 播种 user + session（不经过微信换取、不涉及真实 openid）。
 * - 提供者是**合成脚本**：只为构造契约可观测行为（正常 / 空 / 超限 / 畸形 / 配额失败 / 超时），
 *   **不是真实 ASR**；真实样本为 0 ⇒ 本文件**不产生也不声称任何准确率或转写质量**。
 * - 装配用的是**生产 HTTP 管道**：直接调用 `services/api/src/app.ts` 的 `buildApp`（真实错误封套
 *   `setErrorHandler` / `setNotFoundHandler` / `ajv.removeAdditional:false` / 鉴权守卫），再在其上
 *   只注册 `registerSpeechRoutes`（**不修改 app.ts**）。
 *
 * **未做项（阶段 2b 才做）**：`app.ts` 注册、`miniprogram/pages/identify/**` 语音模式、
 * `tools/prepare-wechat.mjs` 白名单、真实 ASR 供应商与凭据、真机、PG 持久化。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createAuthGuards } from '../../services/api/src/auth/middleware.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { registerSpeechRoutes } from '../../services/api/src/routes/speech.ts';
import { createMemorySpeechStore } from '../../services/api/src/speech/store.ts';
import { createRealSpeechProvider } from '../../services/api/src/speech/provider.ts';
import { createSubstituteMediaPort } from '../../services/api/src/speech/media.ts';

const P = '/api/v1/speech/transcriptions';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RAW = 8000;

let keySeq = 0;
const newKey = (label = 'k') => `speech-http-${label}-${String(++keySeq).padStart(4, '0')}`;

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

/** 回环 HTTP 调用；只走 127.0.0.1。 */
async function call(base, token, method, path, options = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.key !== undefined) headers['Idempotency-Key'] = options.key;
  if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body, text };
}

/** 播种合成身份与会话（不经过微信换取，不产生外网调用）。 */
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

/** 包一层可观测计数：落库任务数与实际写入的转写记录（证明「失败不写记录」。） */
function spiedSpeechStore() {
  const inner = createMemorySpeechStore();
  const state = { insertedJobs: 0, recordCommits: 0, committedRawTexts: [] };
  const store = {
    ...inner,
    async insertJob(row) {
      state.insertedJobs += 1;
      return inner.insertJob(row);
    },
    async commitTerminal(jobId, expectedRevision, terminal, transcription, at) {
      if (transcription !== null) {
        state.recordCommits += 1;
        state.committedRawTexts.push(transcription.rawText);
      }
      return inner.commitTerminal(jobId, expectedRevision, terminal, transcription, at);
    },
  };
  return { state, store };
}

/**
 * 启动一个已装配生产管道的回环 HTTP 实例，并只额外注册转写插件。
 * `configOverrides` 用于 real 模式；`providerInjection` 缺省时由插件按执行模式自建。
 */
async function startApp({ env, provider, store, media, jobDeadlineMs }) {
  const config = loadConfig({ LOG_LEVEL: 'silent', ...env });
  const authStore = createMemoryAuthStore();
  const guards = createAuthGuards({ store: authStore, now: () => new Date() });
  const app = buildApp({ config, store: authStore });
  const service = registerSpeechRoutes(app, config, {
    guards,
    provider,
    store,
    media,
    jobDeadlineMs,
  });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const tokenA = await seedSession(authStore, 'speech-http-owner');
  const tokenB = await seedSession(authStore, 'speech-http-other');
  return { app, base, service, tokenA, tokenB, config, close: () => app.close() };
}

// ---------------------------------------------------------------------------
// 合成脚本（非真实 ASR；只为构造契约行为）
// ---------------------------------------------------------------------------
const scenario = {
  normal: randomUUID(),
  spans: randomUUID(),
  confident: randomUUID(),
  isolated: randomUUID(),
  empty: randomUUID(),
  tooLong: randomUUID(),
  malformed: randomUUID(),
  quota: randomUUID(),
  never: randomUUID(),
};
const NORMAL_TEXT = '合成用例·普通话转写文本：稻田稗草三到五叶期，请问题用什么药。';
const NORMAL_SPANS = [
  { start: 0, end: 6, reason: '合成用例·前缀不确定' },
  { start: 20, end: 23, reason: '合成用例·生育期表述不确定' },
];
const THREE_SPANS = [
  { start: 3, end: 7, reason: '合成用例·第一个不确定区间' },
  { start: 11, end: 12, reason: '合成用例·第二个不确定区间' },
  { start: 30, end: 44, reason: '合成用例·第三个不确定区间' },
];
const scripts = new Map([
  [scenario.normal, { kind: 'completed', transcript: { text: NORMAL_TEXT, uncertain_spans: NORMAL_SPANS } }],
  [scenario.spans, { kind: 'completed', transcript: { text: `${'甲'.repeat(60)}合成用例`, uncertain_spans: THREE_SPANS } }],
  [scenario.confident, { kind: 'completed', transcript: { text: '合成用例·全置信文本', uncertain_spans: [] } }],
  [scenario.isolated, { kind: 'completed', transcript: { text: '合成用例·并发隔离文本', uncertain_spans: [] } }],
  [scenario.empty, { kind: 'completed', transcript: { text: '   ', uncertain_spans: [] } }],
  [scenario.tooLong, { kind: 'completed', transcript: { text: '药'.repeat(MAX_RAW + 1), uncertain_spans: [] } }],
  [scenario.malformed, { kind: 'completed', transcript: { text: '合成用例·畸形区间', uncertain_spans: [{ start: 9, end: 4, reason: '倒置' }] } }],
  [scenario.quota, { kind: 'failed', code: 'PROVIDER_QUOTA_EXCEEDED' }],
  [scenario.never, { kind: 'never' }],
]);

const providerState = { calls: 0, byMedia: new Map() };
const scriptedProvider = {
  executionMode: 'stub',
  modelVersion: 'stub-v1',
  note: '回环 HTTP 合成脚本提供者（非真实 ASR；不构成任何准确率或转写质量证据）',
  available: true,
  unavailableReason: null,
  async transcribe({ mediaId }) {
    providerState.calls += 1;
    providerState.byMedia.set(mediaId, (providerState.byMedia.get(mediaId) ?? 0) + 1);
    const outcome = scripts.get(mediaId);
    assert.ok(outcome !== undefined, `脚本未登记该媒体：${mediaId}`);
    if (outcome.kind === 'never') return new Promise(() => {});
    return structuredClone(outcome);
  },
};

const bodyOf = (mediaId) => ({ media_id: mediaId, media_revision: 1 });
const callsFor = (mediaId) => providerState.byMedia.get(mediaId) ?? 0;

const spy = spiedSpeechStore();
const stub = await startApp({
  env: { APP_EXECUTION_MODE: 'stub' },
  provider: scriptedProvider,
  store: spy.store,
  media: createSubstituteMediaPort(),
  jobDeadlineMs: 60,
});

try {
  const { base, service, tokenA, tokenB } = stub;

  // -------- 覆盖项 1：POST 返回 202 + JobEnvelope 形状 --------
  await group('[1] POST 202 + JobEnvelope（data.kind/state/result=null、meta.contract_version/execution_mode/request_id、ETag、Cache-Control）', async () => {
    const res = await call(base, tokenA, 'POST', P, { body: bodyOf(scenario.normal), key: newKey('create') });
    assert.equal(res.status, 202);
    assert.equal(res.headers.get('etag'), '"1"');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(typeof res.body, 'object');
    assert.deepEqual(Object.keys(res.body).sort(), ['data', 'meta']);
    const { data, meta } = res.body;
    assert.equal(data.kind, 'transcription');
    assert.equal(data.state, 'queued');
    assert.equal(data.result, null);
    assert.equal(data.revision, 1);
    assert.equal(data.error_code, null);
    assert.equal(data.target_ref.type, 'transcription');
    assert.match(data.target_ref.id, UUID_PATTERN);
    assert.match(meta.request_id, UUID_PATTERN);
    assert.equal(meta.contract_version, '1.0.0');
    assert.equal(meta.execution_mode, 'stub');
    assert.match(data.deadline_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(data.created_at, /^\d{4}-\d{2}-\d{2}T/);
    // additionalProperties:false：Job 七键，不多不少。
    assert.deepEqual(
      Object.keys(data).sort(),
      ['created_at', 'deadline_at', 'error_code', 'id', 'kind', 'result', 'revision', 'state', 'target_ref'],
    );
    await service.settle();
  });

  // -------- 正控制 + 覆盖项 2：状态可观测性（正常 + 失败） --------
  let normalId = null;
  await group('[+] 正控制：受理 → succeeded → GET 读到转写结果（raw_text/uncertain_spans/model_version）', async () => {
    const created = await call(base, tokenA, 'POST', P, { body: bodyOf(scenario.normal), key: newKey('positive') });
    assert.equal(created.status, 202);
    await service.settle();
    normalId = created.body.data.target_ref.id;
    const res = await call(base, tokenA, 'GET', `${P}/${normalId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('etag'), '"1"');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const data = res.body.data;
    assert.equal(data.raw_text, NORMAL_TEXT);
    assert.equal(data.confirmed_text, null);
    assert.equal(data.confirmed_at, null);
    assert.deepEqual(data.uncertain_spans, NORMAL_SPANS);
    assert.equal(typeof data.model_version, 'string');
    assert.equal(data.model_version, 'stub-v1');
    assert.deepEqual(
      Object.keys(data).sort(),
      ['confirmed_at', 'confirmed_text', 'id', 'model_version', 'raw_text', 'revision', 'uncertain_spans'],
    );
  });

  await group('[2] 状态如实：queued（202 观测）/ succeeded（GET 200）/ failed·timed_out·uncertain（无记录 ⇒ GET 404）', async () => {
    // queued：受理响应本身就是观测点（上面已断言 state=queued）。
    // succeeded：见正控制。
    // failed（提供者配额）：202 受理后不产生记录 ⇒ 该记录 GET 404。
    const quota = await call(base, tokenA, 'POST', P, { body: bodyOf(scenario.quota), key: newKey('quota') });
    assert.equal(quota.status, 202);
    assert.equal(quota.body.data.state, 'queued');
    await service.settle();
    const quotaGet = await call(base, tokenA, 'GET', `${P}/${quota.body.data.target_ref.id}`);
    assert.equal(quotaGet.status, 404);
    assert.equal(quotaGet.body.error.code, 'NOT_FOUND');

    // uncertain（空转写）：同样不产生记录。
    const empty = await call(base, tokenA, 'POST', P, { body: bodyOf(scenario.empty), key: newKey('empty') });
    assert.equal(empty.status, 202);
    await service.settle();
    const emptyGet = await call(base, tokenA, 'GET', `${P}/${empty.body.data.target_ref.id}`);
    assert.equal(emptyGet.status, 404);

    // timed_out（提供者不返回，超过注入的任务截止时间 60ms）。
    const never = await call(base, tokenA, 'POST', P, { body: bodyOf(scenario.never), key: newKey('timeout') });
    assert.equal(never.status, 202);
    await service.settle();
    const neverGet = await call(base, tokenA, 'GET', `${P}/${never.body.data.target_ref.id}`);
    assert.equal(neverGet.status, 404);

    // 契约缺口（只记录、不断言未来）：`getJob` `GET /jobs/{id}` 属 GY-I01，本次未装配，
    // 因此 failed/timed_out/uncertain 的**终态本身无法经 HTTP 轮询**，只能由「无记录」体现。
    const jobId = quota.body.data.id;
    const jobProbe = await call(base, tokenA, 'GET', `/api/v1/jobs/${jobId}`);
    console.log(`[gap] GET /api/v1/jobs/{id} → ${jobProbe.status} ${jobProbe.body?.error?.code ?? '-'}（getJob 属 GY-I01，本次未装配；running/cancelled 与失败终态因此不可经 HTTP 观测）`);
    // running 类别在本阶段无契约观测点（getJob 未装配），故不在 HTTP 层断言。
  });

  // -------- 覆盖项 3：归属 --------
  await group('[3] 归属：他人 GET/DELETE/PATCH ⇒ 404，且与「不存在」响应封套同形（error 逐字段相同）', async () => {
    const foreignGet = await call(base, tokenB, 'GET', `${P}/${normalId}`);
    const missingGet = await call(base, tokenB, 'GET', `${P}/${randomUUID()}`);
    assert.equal(foreignGet.status, 404);
    assert.equal(missingGet.status, 404);
    assert.deepEqual(foreignGet.body.error, missingGet.body.error);
    assert.deepEqual(
      { ...foreignGet.body.meta, request_id: 'x' },
      { ...missingGet.body.meta, request_id: 'x' },
      '除逐请求的 request_id 外，封套必须同形',
    );

    const foreignDelete = await call(base, tokenB, 'DELETE', `${P}/${normalId}`, { ifMatch: '"1"', key: newKey('fdel') });
    const missingDelete = await call(base, tokenB, 'DELETE', `${P}/${randomUUID()}`, { ifMatch: '"1"', key: newKey('mdel') });
    assert.equal(foreignDelete.status, 404);
    assert.equal(missingDelete.status, 404);
    assert.deepEqual(foreignDelete.body.error, missingDelete.body.error);

    const confirmBody = { confirmed_text: '他人试图确认', confirmation: 'checked_and_sendable' };
    const foreignPatch = await call(base, tokenB, 'PATCH', `${P}/${normalId}/confirmation`, { body: confirmBody, ifMatch: '"1"', key: newKey('fpatch') });
    const missingPatch = await call(base, tokenB, 'PATCH', `${P}/${randomUUID()}/confirmation`, { body: confirmBody, ifMatch: '"1"', key: newKey('mpatch') });
    assert.equal(foreignPatch.status, 404);
    assert.equal(missingPatch.status, 404);
    assert.deepEqual(foreignPatch.body.error, missingPatch.body.error);

    // 越权请求不得改动归属者数据。
    const own = await call(base, tokenA, 'GET', `${P}/${normalId}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.data.revision, 1);
    assert.equal(own.body.data.confirmed_text, null);

    // 无会话：四个操作一律 401 SESSION_REQUIRED（鉴权先于任何资源判断）。
    for (const [method, path, options] of [
      ['POST', P, { body: bodyOf(scenario.normal), key: newKey('anon') }],
      ['GET', `${P}/${normalId}`, {}],
      ['DELETE', `${P}/${normalId}`, { ifMatch: '"1"', key: newKey('anon') }],
      ['PATCH', `${P}/${normalId}/confirmation`, { body: confirmBody, ifMatch: '"1"', key: newKey('anon') }],
    ]) {
      const res = await call(base, null, method, path, options);
      assert.equal(res.status, 401, `${method} 无会话应为 401`);
      assert.equal(res.body.error.code, 'SESSION_REQUIRED');
    }
  });

  // -------- 覆盖项 4：If-Match --------
  await group('[4] If-Match：缺失 ⇒ 428 REVISION_REQUIRED、格式非法 ⇒ 400 INVALID_REQUEST、不匹配 ⇒ 409 REVISION_CONFLICT', async () => {
    const body = { confirmed_text: '核对文本', confirmation: 'checked_and_sendable' };
    const patch = (ifMatch, key) => call(base, tokenA, 'PATCH', `${P}/${normalId}/confirmation`, { body, ifMatch, key });
    const del = (ifMatch, key) => call(base, tokenA, 'DELETE', `${P}/${normalId}`, { ifMatch, key });

    const noMatch = await patch(undefined, newKey('ifm'));
    assert.equal(noMatch.status, 428);
    assert.equal(noMatch.body.error.code, 'REVISION_REQUIRED');

    for (const malformed of ['1', '*', 'abc', '""', '"0"']) {
      const res = await patch(malformed, newKey('ifm'));
      assert.equal(res.status, 400, `If-Match=${malformed} 应为 400`);
      assert.equal(res.body.error.code, 'INVALID_REQUEST');
    }

    const stale = await patch('"99"', newKey('ifm'));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
    // 冲突不得写入任何东西。
    const after = await call(base, tokenA, 'GET', `${P}/${normalId}`);
    assert.equal(after.body.data.revision, 1);
    assert.equal(after.body.data.confirmed_text, null);
    assert.deepEqual(after.body.data.raw_text, NORMAL_TEXT);

    const delNoMatch = await del(undefined, newKey('ifd'));
    assert.equal(delNoMatch.status, 428);
    assert.equal(delNoMatch.body.error.code, 'REVISION_REQUIRED');
    const delBad = await del('nope', newKey('ifd'));
    assert.equal(delBad.status, 400);
    const delStale = await del('"77"', newKey('ifd'));
    assert.equal(delStale.status, 409);
    assert.equal(delStale.body.error.code, 'REVISION_CONFLICT');
  });

  // -------- 覆盖项 5：幂等 --------
  await group('[5] 幂等：同键同体重放同一 job；同键异体 409 IDEMPOTENCY_CONFLICT；同键同体并发恰好 1 任务 1 次提供者调用', async () => {
    const body = bodyOf(scenario.confident);
    const key = newKey('idem');
    const jobsBefore = spy.state.insertedJobs;
    const callsBefore = callsFor(scenario.confident);

    const first = await call(base, tokenA, 'POST', P, { body, key });
    assert.equal(first.status, 202);
    await service.settle();
    const replay = await call(base, tokenA, 'POST', P, { body, key });
    assert.equal(replay.status, 202);
    assert.equal(replay.body.data.id, first.body.data.id, '同键同体重放必须回到同一 job');
    assert.equal(replay.body.data.target_ref.id, first.body.data.target_ref.id);
    assert.equal(callsFor(scenario.confident) - callsBefore, 1, '重放不得再次调用提供者');
    assert.equal(spy.state.insertedJobs - jobsBefore, 1, '重放不得再建任务');

    // 同键异体（串行）：第二个不同请求体必须判冲突，且不产生第二个任务。
    const sameKey = newKey('conflict');
    const okBody = await call(base, tokenA, 'POST', P, { body: bodyOf(scenario.normal), key: sameKey });
    assert.equal(okBody.status, 202);
    const jobsBeforeConflict = spy.state.insertedJobs;
    const conflict = await call(base, tokenA, 'POST', P, { body: bodyOf(scenario.spans), key: sameKey });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(spy.state.insertedJobs - jobsBeforeConflict, 0, '同键异体不得产生第二个任务');

    // 同键同体**并发**（3 个）：恰好 1 个任务、恰好 1 次提供者调用、响应收敛同一 job。
    const concurrentKey = newKey('concurrent');
    const concurrentBody = bodyOf(scenario.isolated);
    const jobsBeforeConcurrent = spy.state.insertedJobs;
    const results = await Promise.all([
      call(base, tokenA, 'POST', P, { body: concurrentBody, key: concurrentKey }),
      call(base, tokenA, 'POST', P, { body: concurrentBody, key: concurrentKey }),
      call(base, tokenA, 'POST', P, { body: concurrentBody, key: concurrentKey }),
    ]);
    await service.settle();
    for (const res of results) {
      assert.equal(res.status, 202, `并发同键同体必须收敛为 202，实际 ${res.status} ${JSON.stringify(res.body?.error ?? null)}`);
    }
    const ids = [...new Set(results.map((res) => res.body.data.id))];
    const targetIds = [...new Set(results.map((res) => res.body.data.target_ref.id))];
    const taskDelta = spy.state.insertedJobs - jobsBeforeConcurrent;
    const callDelta = callsFor(scenario.isolated);
    console.log(`[并发实测·HTTP 同键同体 3 次] 落库任务数=${taskDelta}、提供者调用数=${callDelta}、不同 job id 数=${ids.length}、不同 target_ref.id 数=${targetIds.length}`);
    assert.equal(taskDelta, 1, `同键同体并发必须恰好 1 个任务，实际 ${taskDelta}`);
    assert.equal(callDelta, 1, `同键同体并发必须恰好 1 次提供者调用，实际 ${callDelta}`);
    assert.equal(ids.length, 1);
    assert.equal(targetIds.length, 1);
  });

  // -------- 覆盖项 6：确认不得改写原始输出 --------
  await group('[6] 确认只写 confirmed_text/confirmed_at：raw_text 与 uncertain_spans 逐项不变，revision +1', async () => {
    const before = (await call(base, tokenA, 'GET', `${P}/${normalId}`)).body.data;
    const text = '用户核对后的文本（与模型原始输出不同，属人的判断）';
    const patched = await call(base, tokenA, 'PATCH', `${P}/${normalId}/confirmation`, {
      body: { confirmed_text: text, confirmation: 'checked_and_sendable' },
      ifMatch: `"${before.revision}"`,
      key: newKey('confirm'),
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.headers.get('etag'), `"${before.revision + 1}"`);
    const data = patched.body.data;
    assert.equal(data.confirmed_text, text);
    assert.equal(typeof data.confirmed_at, 'string');
    assert.equal(Number.isNaN(Date.parse(data.confirmed_at)), false);
    assert.equal(data.revision, before.revision + 1);
    assert.equal(data.raw_text, before.raw_text, 'raw_text 绝不得被确认覆写');
    assert.deepEqual(data.uncertain_spans, before.uncertain_spans, 'uncertain_spans 不得被确认改动');
    assert.equal(data.model_version, before.model_version);

    const reread = (await call(base, tokenA, 'GET', `${P}/${normalId}`)).body.data;
    assert.equal(reread.raw_text, before.raw_text);
    assert.deepEqual(reread.uncertain_spans, before.uncertain_spans);
    assert.equal(reread.confirmed_text, text);
    assert.equal(reread.revision, before.revision + 1);
  });

  // -------- 覆盖项 7：uncertain_spans 如实透传 --------
  await group('[7] uncertain_spans 如实透传：数量/内容/顺序与提供者所报一致（不删改、不补造、不排序）', async () => {
    const created = await call(base, tokenA, 'POST', P, { body: bodyOf(scenario.spans), key: newKey('spans') });
    await service.settle();
    const got = await call(base, tokenA, 'GET', `${P}/${created.body.data.target_ref.id}`);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.data.uncertain_spans, THREE_SPANS);
    // 全置信（0 条）同样如实为空数组，而不是补造一条。
    const confident = await call(base, tokenA, 'POST', P, { body: bodyOf(scenario.confident), key: newKey('confident') });
    await service.settle();
    const confidentGet = await call(base, tokenA, 'GET', `${P}/${confident.body.data.target_ref.id}`);
    assert.deepEqual(confidentGet.body.data.uncertain_spans, []);
  });

  // -------- 覆盖项 8：超长不静默截断 --------
  await group('[8] raw_text > 8000 码点不静默截断：落 failed（无记录 ⇒ GET 404），且不存在 8000 码点的截断文本', async () => {
    const commitsBefore = spy.state.recordCommits;
    const created = await call(base, tokenA, 'POST', P, { body: bodyOf(scenario.tooLong), key: newKey('toolong') });
    assert.equal(created.status, 202, '受理本身是 202（异步执行）');
    await service.settle();
    const got = await call(base, tokenA, 'GET', `${P}/${created.body.data.target_ref.id}`);
    assert.equal(got.status, 404, '超长必须 fail-closed，不得产出截断后的记录');
    assert.equal(spy.state.recordCommits - commitsBefore, 0, '超长不得写入任何转写记录');
    for (const committed of spy.state.committedRawTexts) {
      assert.notEqual([...committed].length, MAX_RAW, '不得把截断到 8000 码点的文本当成功');
    }
    // 畸形区间同样 fail-closed。
    const malformed = await call(base, tokenA, 'POST', P, { body: bodyOf(scenario.malformed), key: newKey('malformed') });
    assert.equal(malformed.status, 202);
    await service.settle();
    assert.equal((await call(base, tokenA, 'GET', `${P}/${malformed.body.data.target_ref.id}`)).status, 404);
  });

  // -------- 覆盖项 10：请求边界 --------
  await group('[10] 缺/非法 Idempotency-Key、body 多余字段、非 uuid、revision 边界、未声明查询参数（limit）一律按契约拒绝', async () => {
    const noKey = await call(base, tokenA, 'POST', P, { body: bodyOf(scenario.normal) });
    assert.equal(noKey.status, 400);
    assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const shortKey = await call(base, tokenA, 'POST', P, { body: bodyOf(scenario.normal), key: 'short' });
    assert.equal(shortKey.status, 400);
    assert.equal(shortKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const extraField = await call(base, tokenA, 'POST', P, { body: { ...bodyOf(scenario.normal), language: 'zh-CN' }, key: newKey('extra') });
    assert.equal(extraField.status, 400);
    assert.equal(extraField.body.error.code, 'INVALID_REQUEST');

    const badUuid = await call(base, tokenA, 'POST', P, { body: { media_id: 'not-a-uuid', media_revision: 1 }, key: newKey('baduuid') });
    assert.equal(badUuid.status, 400);
    assert.equal(badUuid.body.error.code, 'INVALID_REQUEST');

    for (const revision of [0, -1, 1.5]) {
      const res = await call(base, tokenA, 'POST', P, { body: { media_id: randomUUID(), media_revision: revision }, key: newKey('rev') });
      assert.equal(res.status, 400, `media_revision=${revision} 应为 400`);
      assert.equal(res.body.error.code, 'INVALID_REQUEST');
    }

    // 契约未声明任何查询参数（含 limit）⇒ 显式拒绝，不静默忽略。
    const limitGet = await call(base, tokenA, 'GET', `${P}/${normalId}?limit=5`);
    assert.equal(limitGet.status, 400);
    assert.equal(limitGet.body.error.code, 'INVALID_REQUEST');
    const limitPost = await call(base, tokenA, 'POST', `${P}?limit=5`, { body: bodyOf(scenario.normal), key: newKey('limit') });
    assert.equal(limitPost.status, 400);
    assert.equal(limitPost.body.error.code, 'INVALID_REQUEST');

    const badConfirm = await call(base, tokenA, 'PATCH', `${P}/${normalId}/confirmation`, {
      body: { confirmed_text: '文本', confirmation: 'ok' },
      ifMatch: '"2"',
      key: newKey('badconf'),
    });
    assert.equal(badConfirm.status, 400);
    assert.equal(badConfirm.body.error.code, 'INVALID_REQUEST');

    const extraConfirm = await call(base, tokenA, 'PATCH', `${P}/${normalId}/confirmation`, {
      body: { confirmed_text: '文本', confirmation: 'checked_and_sendable', note: '多余' },
      ifMatch: '"2"',
      key: newKey('extraconf'),
    });
    assert.equal(extraConfirm.status, 400);
    assert.equal(extraConfirm.body.error.code, 'INVALID_REQUEST');

    const emptyText = await call(base, tokenA, 'PATCH', `${P}/${normalId}/confirmation`, {
      body: { confirmed_text: '', confirmation: 'checked_and_sendable' },
      ifMatch: '"2"',
      key: newKey('emptyconf'),
    });
    assert.equal(emptyText.status, 400);
    assert.equal(emptyText.body.error.code, 'INVALID_REQUEST');

    const noBody = await call(base, tokenA, 'POST', P, { key: newKey('nobody') });
    assert.equal(noBody.status, 400);
    assert.equal(noBody.body.error.code, 'INVALID_REQUEST');

    // 以上拒绝都不得留下副作用。
    const unchanged = (await call(base, tokenA, 'GET', `${P}/${normalId}`)).body.data;
    assert.equal(unchanged.revision, 2);
    assert.equal(unchanged.raw_text, NORMAL_TEXT);
  });
} finally {
  await stub.close();
}

// ---------------------------------------------------------------------------
// 覆盖项 9：real 模式缺凭据 ⇒ 受理前 503，且不回退替身
// ---------------------------------------------------------------------------
const REAL_ENV = {
  APP_EXECUTION_MODE: 'real',
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
const realSpy = spiedSpeechStore();
const real = await startApp({ env: REAL_ENV, store: realSpy.store });
try {
  await group('[9] real 缺凭据 ⇒ 受理前 503 PROVIDER_UNAVAILABLE（不建任务、不调提供者、不回退替身）', async () => {
    assert.equal(real.config.executionMode, 'real');
    const described = real.service.describe();
    assert.equal(described.executionMode, 'real');
    assert.equal(described.providerAvailable, false);
    assert.equal(described.modelVersion, 'real-unconfigured');
    assert.notEqual(described.modelVersion, 'stub-v1', '不得静默回退替身');
    assert.equal(described.mediaPort, 'unwired');

    const res = await call(real.base, real.tokenA, 'POST', P, { body: bodyOf(randomUUID()), key: newKey('real') });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(res.body.meta.execution_mode, 'real');
    assert.equal(realSpy.state.insertedJobs, 0, '受理前 fail-closed 不得建任务');
    assert.equal(realSpy.state.recordCommits, 0);
    assert.equal(res.text.includes('stub'), false, '响应不得出现替身标识');
    assert.equal(res.text.includes('preset-demo'), false);
  });
} finally {
  await real.close();
}

// ---------------------------------------------------------------------------
// 复用自证：阶段 1 的服务层语义未改（由门禁单独跑，本脚本不重复执行测试运行器）
//   node --test "tests/unit/speech*.test.mjs"
// ---------------------------------------------------------------------------

console.log(`PASS ${passed} loopback HTTP groups; production pipeline (buildApp) with only the speech plugin added; synthetic identity/provider; loopback only, no supplier, no PG, no real ASR sample`);
