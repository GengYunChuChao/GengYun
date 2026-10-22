/**
 * GY-I11 普通话录音与转写域 · 服务层单元回归（Refs #11）。
 *
 * 走**真实服务链路**（内存 store + 替身/脚本提供者 + 替身媒体端口），覆盖契约 4 个 operationId
 * 的 fail-closed 语义：越权、revision 冲突、多余字段、提供者失败不得写成功、
 * `raw_text` 与 `confirmed_text` 严格分离、`uncertain_spans` 如实、超长与空转写 fail-closed、
 * 幂等原子占位与并发收敛、占位失败释放。
 *
 * 每条「应当拒绝 / 应当不确定」的情形都是**一条可单独指出的用例**（矩阵条数本身不证明 fail-closed）。
 * 断言一律先判 `typeof` / `Array.isArray` 再判值；不使用「只要不抛错就算过」的写法。
 *
 * **证据口径**：真实 ASR 样本为 **0**（`docs/evaluation/sample-gap-register.md` 的
 * `asr_utterances` / `asr_speakers` 均为 0），本文件**不产生也不声称任何准确率或转写质量结论**；
 * 脚本提供者返回的是合成文本，只用于证明契约行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STUB_IDEMPOTENCY_HMAC_KEY } from '../../services/api/src/auth/service.ts';
import { createSpeechService, stateForProviderFailure, toJob, toTranscription } from '../../services/api/src/speech/service.ts';
import { createMemorySpeechStore } from '../../services/api/src/speech/store.ts';
import {
  STUB_BUCKETS,
  STUB_SPAN_LIMIT,
  STUB_TOO_LONG_CODE_POINTS,
  createRealSpeechProvider,
  createSpeechProvider,
  createStubSpeechProvider,
} from '../../services/api/src/speech/provider.ts';
import {
  createSpeechMediaPort,
  createSubstituteMediaPort,
  createUnwiredMediaPort,
} from '../../services/api/src/speech/media.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HMAC_KEY = STUB_IDEMPOTENCY_HMAC_KEY ?? 'gengyun-stub-idempotency-hmac-key';
const USER = 'user-owner-0001';
const OTHER_USER = 'user-other-0002';

// ---------------------------------------------------------------- 辅助

function assertString(value, label) {
  assert.equal(typeof value, 'string', `${label} 必须是 string，实际是 ${typeof value}`);
}

function assertArray(value, label) {
  assert.ok(Array.isArray(value), `${label} 必须是数组，实际是 ${typeof value}`);
  return value;
}

function assertObject(value, label) {
  assert.equal(typeof value, 'object', `${label} 必须是 object，实际是 ${typeof value}`);
  assert.notEqual(value, null, `${label} 不得为 null`);
  assert.equal(Array.isArray(value), false, `${label} 不得是数组`);
}

/** 断言抛出指定契约错误码的 ApiError。 */
async function assertApiError(operation, code, label) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.name, 'ApiError', `${label} 应抛 ApiError，实际 ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `${label} 错误码应为 ${code}，实际 ${error.code}`);
    return true;
  });
}

/** 捕获并断言错误，返回该错误对象（用于比对「越权与不存在同形」等）。 */
async function captureApiError(operation, code, label) {
  try {
    await operation();
  } catch (error) {
    assert.equal(error.name, 'ApiError', `${label} 应抛 ApiError，实际 ${error.name}: ${error.message}`);
    assert.equal(error.code, code, `${label} 错误码应为 ${code}，实际 ${error.code}`);
    return error;
  }
  assert.fail(`${label} 应当抛错，但成功返回了`);
}

let keyCounter = 0;
function nextKey() {
  keyCounter += 1;
  return `speech-test-key-${String(keyCounter).padStart(6, '0')}`;
}

/** 与提供者 `bucketOf` 同一口径：sha256(media_id) 首字节对 6 取模。 */
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

/** 组装一个按执行模式接线的服务（可覆盖提供者 / 媒体端口 / store / 时钟）。 */
function boot(executionMode = 'stub', overrides = {}) {
  const store = overrides.store ?? createMemorySpeechStore();
  const provider = overrides.provider ?? createSpeechProvider({ executionMode });
  const service = createSpeechService({
    store,
    provider,
    media: overrides.media ?? createSpeechMediaPort(executionMode),
    idempotencyHmacKey: HMAC_KEY,
    jobDeadlineMs: overrides.jobDeadlineMs ?? 30 * 1000,
    idempotencyWaitMs: overrides.idempotencyWaitMs ?? 300,
    now: overrides.now,
    idFactory: overrides.idFactory,
  });
  return { store, service, provider };
}

/**
 * **测试脚本提供者**：直接给出提供者结局（completed / uncertain / failed），或用函数延迟决定。
 * 这是测试夹具，不是生产替身；生产装配只有 `createSpeechProvider` 一条路径。
 */
function scriptedProvider(script, options = {}) {
  const state = { calls: 0 };
  const provider = {
    executionMode: options.executionMode ?? 'stub',
    modelVersion: options.modelVersion ?? 'stub-scripted-v1',
    note: '测试脚本提供者（非生产替身；合成文本，不构成任何准确率证据）',
    available: options.available ?? true,
    unavailableReason: options.unavailableReason ?? null,
    async transcribe(input) {
      state.calls += 1;
      if (typeof script === 'function') return script(input, state);
      return script;
    },
  };
  return { state, provider };
}

/** 包一层计数，用于断言「提供者恰好被调用一次」。 */
function withCallCounter(inner) {
  const state = { calls: 0 };
  return {
    state,
    provider: {
      executionMode: inner.executionMode,
      modelVersion: inner.modelVersion,
      note: inner.note,
      available: inner.available,
      unavailableReason: inner.unavailableReason,
      async transcribe(input) {
        state.calls += 1;
        return inner.transcribe(input);
      },
    },
  };
}

/**
 * 包一层可观测计数：`insertedJobs` = 真正落库的任务数（证明「同键只建 1 个任务」），
 * `recordCommits` / `committedRawTexts` = 实际写入的转写记录（证明「失败不写记录、不写截断文本」）。
 */
function withStoreSpy(inner) {
  const state = { insertedJobs: 0, recordCommits: 0, committedRawTexts: [], committedSpans: [] };
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
        state.committedSpans.push(transcription.uncertainSpans);
      }
      return inner.commitTerminal(jobId, expectedRevision, terminal, transcription, at);
    },
  };
  return { state, store };
}

/** 受理一个转写任务并等它落定，返回 job / settled / transcription 投影。 */
async function createAndSettle(service, userId, options = {}) {
  const mediaId = options.mediaId ?? mediaIdForBucket(options.bucket ?? STUB_BUCKETS.normal);
  const { job } = await service.createTranscription({
    userId,
    body: { media_id: mediaId, media_revision: 1 },
    idempotencyKey: options.idempotencyKey ?? nextKey(),
  });
  await service.settle();
  const settled = await service.getJob({ userId, jobId: job.id });
  const transcription = settled.result === null ? null : settled.result.value;
  return { job, settled, transcription };
}

/** 正常完成结局的脚本结局（合成文本 + 2 个不确定区间）。 */
function normalOutcome() {
  return {
    kind: 'completed',
    transcript: {
      text: '合成用例文本：稻田稗草三到五叶期，请问题用什么药。',
      uncertain_spans: [
        { start: 0, end: 6, reason: '合成用例·开头为固定前缀' },
        { start: 20, end: 23, reason: '合成用例·生育期表述可能识别偏差' },
      ],
    },
  };
}

// ---------------------------------------------------------------- 范围与契约投影

test('范围·speech 域只服务层：不注册任何 HTTP 路由、不引入 app.ts / routes/**', () => {
  for (const name of ['state.ts', 'provider.ts', 'store.ts', 'media.ts', 'service.ts']) {
    const text = readFileSync(resolve(root, 'services/api/src/speech', name), 'utf8');
    assert.equal(/fastify/i.test(text), false, `${name} 不得引入 fastify（阶段 1 不注册路由）`);
    assert.equal(/routes\//.test(text), false, `${name} 不得引入 routes/**`);
    assert.equal(/from '\.\.\/app\.ts'/.test(text), false, `${name} 不得引入 app.ts`);
  }
});

test('范围·本片不实现 POST /speech/synthesis（属 #13 TTS），只暴露 4 个 operationId 的实现', async () => {
  const { service } = boot();
  for (const name of ['createTranscription', 'getTranscription', 'deleteTranscription', 'confirmTranscription']) {
    assert.equal(typeof service[name], 'function', `service.${name} 必须是函数`);
  }
  assert.equal(service.synthesize, undefined, '不得暴露 TTS 合成入口');
  assert.equal(service.createSynthesis, undefined, '不得暴露 TTS 合成入口');
  // 提供者失败码 → 终态的映射必须严格非 succeeded。
  assert.equal(stateForProviderFailure('PROVIDER_TIMEOUT'), 'timed_out');
  for (const code of ['PROVIDER_UNAVAILABLE', 'PROVIDER_OUTCOME_UNKNOWN', 'PROVIDER_QUOTA_EXCEEDED']) {
    assert.equal(stateForProviderFailure(code), 'failed', `${code} 必须落 failed`);
  }
});

test('createTranscription·受理即返回 202 语义（state=queued、result=null、kind=transcription）', async () => {
  const { service } = boot();
  const { job } = await service.createTranscription({
    userId: USER,
    body: { media_id: mediaIdForBucket(STUB_BUCKETS.normal), media_revision: 1 },
    idempotencyKey: nextKey(),
  });
  assert.equal(job.kind, 'transcription');
  assert.equal(job.state, 'queued');
  assert.equal(job.result, null, '受理时不得带出结果');
  assert.equal(typeof job.revision, 'number');
  assert.equal(job.revision, 1);
  assertObject(job.target_ref, 'target_ref');
  assert.equal(job.target_ref.type, 'transcription');
  assertString(job.target_ref.id, 'target_ref.id');
  assertString(job.deadline_at, 'deadline_at');
  assertString(job.created_at, 'created_at');
  assert.equal(job.error_code, null);
  assert.deepEqual(
    Object.keys(job).sort(),
    ['created_at', 'deadline_at', 'error_code', 'id', 'kind', 'result', 'revision', 'state', 'target_ref'],
  );
  await service.settle();
});

test('getTranscription·成功产出 Transcription 七字段，confirmed_text / confirmed_at 为 null 且键集合恰为契约七字段', async () => {
  const { service } = boot();
  const { settled, transcription } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'succeeded');
  assert.equal(settled.error_code, null);
  assert.equal(settled.result.kind, 'transcription');
  assert.notEqual(transcription, null, '成功任务必须产出转写记录');
  assertString(transcription.id, 'transcription.id');
  assert.equal(typeof transcription.revision, 'number');
  assert.equal(transcription.revision, 1);
  assertString(transcription.raw_text, 'transcription.raw_text');
  assertArray(transcription.uncertain_spans, 'transcription.uncertain_spans');
  assert.equal(transcription.confirmed_text, null, '未经用户核对必须为 null');
  assert.equal(transcription.confirmed_at, null, '未经用户核对必须为 null');
  assertString(transcription.model_version, 'transcription.model_version');
  // additionalProperties:false：不得多出契约外字段。
  assert.deepEqual(
    Object.keys(transcription).sort(),
    ['confirmed_at', 'confirmed_text', 'id', 'model_version', 'raw_text', 'revision', 'uncertain_spans'],
  );
});

test('getTranscription·uncertain_spans 如实透传（数量、内容、顺序与提供者所报一致，不删改不补造）', async () => {
  const reported = [
    { start: 3, end: 7, reason: '合成用例·第一个不确定区间' },
    { start: 11, end: 12, reason: '合成用例·第二个不确定区间' },
    { start: 30, end: 44, reason: '合成用例·第三个不确定区间' },
  ];
  const scripted = scriptedProvider({
    kind: 'completed',
    transcript: { text: `${'甲'.repeat(60)}合成用例文本`, uncertain_spans: reported },
  });
  const spy = withStoreSpy(createMemorySpeechStore());
  const { service } = boot('stub', { provider: scripted.provider, store: spy.store });
  const { transcription } = await createAndSettle(service, USER);
  assert.deepEqual(transcription.uncertain_spans, reported, '不确定区间必须逐项如实透传');
  assert.equal(spy.state.committedSpans.length, 1);
  assert.deepEqual(spy.state.committedSpans[0], reported, '落库的区间不得被裁剪或补造');
  // 提供者未上报任何不确定区间 ⇒ 空数组（不是缺字段，也不得补造一条）。
  const confident = scriptedProvider({
    kind: 'completed',
    transcript: { text: '合成用例·全置信文本', uncertain_spans: [] },
  });
  const second = boot('stub', { provider: confident.provider });
  const result = await createAndSettle(second.service, USER);
  assert.deepEqual(result.transcription.uncertain_spans, []);
});

test('反例·uncertain_spans 恰好 100 条与 raw_text 恰好 8000 码点都被接受（边界必须放行）', async () => {
  const text = '药'.repeat(8000);
  const spans = Array.from({ length: STUB_SPAN_LIMIT }, (_, index) => ({
    start: index * 2,
    end: index * 2 + 1,
    reason: `合成用例·上限第 ${index + 1} 条`,
  }));
  const scripted = scriptedProvider({ kind: 'completed', transcript: { text, uncertain_spans: spans } });
  const { service } = boot('stub', { provider: scripted.provider });
  const { settled, transcription } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'succeeded');
  assert.equal(transcription.raw_text.length, 8000);
  assert.equal(transcription.raw_text, text, '8000 码点文本必须原样保留');
  assert.equal(transcription.uncertain_spans.length, STUB_SPAN_LIMIT);
  assert.deepEqual(transcription.uncertain_spans, spans, '100 条区间必须逐项原样保留');
});

// ---------------------------------------------------------------- 空转写 / 超长 / 畸形（fail-closed）

test('反例·空转写不得成功：job 落 uncertain + INPUT_UNCERTAIN，且不产生转写记录（GET 如实 404）', async () => {
  const spy = withStoreSpy(createMemorySpeechStore());
  const scripted = scriptedProvider({ kind: 'completed', transcript: { text: '', uncertain_spans: [] } });
  const { service } = boot('stub', { provider: scripted.provider, store: spy.store });
  const { job, settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'uncertain');
  assert.equal(settled.error_code, 'INPUT_UNCERTAIN');
  assert.equal(settled.result, null, '不得把空转写当成结果下发');
  assert.equal(spy.state.recordCommits, 0, '不得产出「看起来成功」的空记录');
  await assertApiError(
    () => service.getTranscription({ userId: USER, transcriptionId: job.target_ref.id }),
    'NOT_FOUND',
    '空转写后的 GET',
  );
});

test('反例·纯空白转写同样不得成功（全角空格 / 换行 / 制表符都算空白）', async () => {
  for (const text of ['   ', '\u3000\u3000', '\n\t', '\r\n']) {
    const scripted = scriptedProvider({ kind: 'completed', transcript: { text, uncertain_spans: [] } });
    const spy = withStoreSpy(createMemorySpeechStore());
    const { service } = boot('stub', { provider: scripted.provider, store: spy.store });
    const { settled } = await createAndSettle(service, USER);
    assert.equal(settled.state, 'uncertain', `文本 ${JSON.stringify(text)} 必须落 uncertain`);
    assert.equal(settled.error_code, 'INPUT_UNCERTAIN');
    assert.equal(spy.state.recordCommits, 0);
  }
});

test('反例·提供者明确无法判定 ⇒ uncertain 终态 + INPUT_UNCERTAIN，不写记录、不编造文本', async () => {
  const spy = withStoreSpy(createMemorySpeechStore());
  const scripted = scriptedProvider({ kind: 'uncertain', reason: '有效语音不足，无法判定文本' });
  const { service } = boot('stub', { provider: scripted.provider, store: spy.store });
  const { job, settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'uncertain');
  assert.equal(settled.error_code, 'INPUT_UNCERTAIN');
  assert.equal(settled.result, null);
  assert.equal(spy.state.recordCommits, 0, '无法判定时不得写记录');
  await assertApiError(
    () => service.getTranscription({ userId: USER, transcriptionId: job.target_ref.id }),
    'NOT_FOUND',
    '无法判定后的 GET',
  );
});

test('反例·raw_text 超长（8001 码点）⇒ failed + PROVIDER_OUTCOME_UNKNOWN，不写记录且不存在截断文本', async () => {
  const spy = withStoreSpy(createMemorySpeechStore());
  const scripted = scriptedProvider({
    kind: 'completed',
    transcript: { text: '药'.repeat(STUB_TOO_LONG_CODE_POINTS), uncertain_spans: [] },
  });
  const { service } = boot('stub', { provider: scripted.provider, store: spy.store });
  const { job, settled } = await createAndSettle(service, USER);
  assert.equal(STUB_TOO_LONG_CODE_POINTS, 8001);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(settled.result, null);
  assert.equal(spy.state.recordCommits, 0, '超长不得写记录');
  // 关键：不得有任何「截断到 8000」的文本被写入。
  for (const committed of spy.state.committedRawTexts) {
    assert.notEqual([...committed].length, 8000, '不得把截断到 8000 的文本当成功');
  }
  await assertApiError(
    () => service.getTranscription({ userId: USER, transcriptionId: job.target_ref.id }),
    'NOT_FOUND',
    '超长后的 GET',
  );
});

test('反例·uncertain_spans 畸形（start>=end）⇒ failed + PROVIDER_OUTCOME_UNKNOWN，不写记录', async () => {
  const spy = withStoreSpy(createMemorySpeechStore());
  const scripted = scriptedProvider({
    kind: 'completed',
    transcript: { text: '合成用例·畸形区间文本', uncertain_spans: [{ start: 9, end: 4, reason: '倒置' }] },
  });
  const { service } = boot('stub', { provider: scripted.provider, store: spy.store });
  const { settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(spy.state.recordCommits, 0);
});

test('反例·uncertain_spans 缺 reason / reason 超 80 / 含多余字段一律 fail-closed', async () => {
  const cases = [
    { label: '缺 reason', spans: [{ start: 0, end: 4 }] },
    { label: 'reason 超 80', spans: [{ start: 0, end: 4, reason: 'x'.repeat(81) }] },
    { label: '多余字段', spans: [{ start: 0, end: 4, reason: 'ok', confidence: 0.9 }] },
    { label: 'start 为负', spans: [{ start: -1, end: 4, reason: 'ok' }] },
  ];
  for (const item of cases) {
    const spy = withStoreSpy(createMemorySpeechStore());
    const scripted = scriptedProvider({
      kind: 'completed',
      transcript: { text: '合成用例·畸形区间文本', uncertain_spans: item.spans },
    });
    const { service } = boot('stub', { provider: scripted.provider, store: spy.store });
    const { settled } = await createAndSettle(service, USER);
    assert.equal(settled.state, 'failed', `${item.label} 必须落 failed`);
    assert.equal(settled.error_code, 'PROVIDER_OUTCOME_UNKNOWN', `${item.label} 错误码`);
    assert.equal(spy.state.recordCommits, 0, `${item.label} 不得写记录`);
  }
});

test('反例·uncertain_spans 超过 100 条 ⇒ failed，不得截断成 100 条后当成功', async () => {
  const spans = Array.from({ length: STUB_SPAN_LIMIT + 1 }, (_, index) => ({
    start: index * 2,
    end: index * 2 + 1,
    reason: `合成用例·第 ${index + 1} 条`,
  }));
  const spy = withStoreSpy(createMemorySpeechStore());
  const scripted = scriptedProvider({
    kind: 'completed',
    transcript: { text: '合成用例·超限区间文本', uncertain_spans: spans },
  });
  const { service } = boot('stub', { provider: scripted.provider, store: spy.store });
  const { settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(spy.state.recordCommits, 0);
  assert.equal(spy.state.committedSpans.length, 0, '不得写入被截断的 100 条区间');
});

test('反例·提供者载荷缺 uncertain_spans 或含多余字段 / text 类型不符一律 fail-closed', async () => {
  const payloads = [
    { label: '缺 uncertain_spans', transcript: { text: '只有文本' } },
    { label: '多余字段', transcript: { text: '文本', uncertain_spans: [], confidence: 0.9 } },
    { label: 'text 非字符串', transcript: { text: 123, uncertain_spans: [] } },
    { label: '载荷非对象', transcript: '文本' },
  ];
  for (const item of payloads) {
    const spy = withStoreSpy(createMemorySpeechStore());
    const scripted = scriptedProvider({ kind: 'completed', transcript: item.transcript });
    const { service } = boot('stub', { provider: scripted.provider, store: spy.store });
    const { settled } = await createAndSettle(service, USER);
    assert.equal(settled.state, 'failed', `${item.label} 必须落 failed`);
    assert.equal(settled.error_code, 'PROVIDER_OUTCOME_UNKNOWN', `${item.label} 错误码`);
    assert.equal(spy.state.recordCommits, 0, `${item.label} 不得写记录`);
  }
});

// ---------------------------------------------------------------- 提供者失败不得写成功

test('反例·real 缺凭据 ⇒ 受理前 PROVIDER_UNAVAILABLE（不建任务、不调提供者、不回退替身）', async () => {
  const spy = withStoreSpy(createMemorySpeechStore());
  const counter = withCallCounter(createRealSpeechProvider());
  const { service } = boot('real', { provider: counter.provider, store: spy.store });
  assert.equal(counter.provider.available, false);
  assert.equal(counter.provider.modelVersion, 'real-unconfigured');
  assert.notEqual(counter.provider.modelVersion, 'stub-v1', '不得静默回退替身');
  assert.equal(service.describe().executionMode, 'real');
  const provided = await captureApiError(
    () =>
      service.createTranscription({
        userId: USER,
        body: { media_id: mediaIdForBucket(STUB_BUCKETS.normal), media_revision: 1 },
        idempotencyKey: nextKey(),
      }),
    'PROVIDER_UNAVAILABLE',
    'real 缺凭据的受理',
  );
  assertString(provided.message, 'PROVIDER_UNAVAILABLE 的 message');
  assert.equal(spy.state.insertedJobs, 0, '受理前 fail-closed 不得建任务');
  assert.equal(counter.state.calls, 0, '不得调用提供者');
  assert.equal(spy.state.recordCommits, 0);
});

test('反例·real 有凭据但无已审适配器 ⇒ 任务 failed + PROVIDER_UNAVAILABLE，绝不 succeeded', async () => {
  const spy = withStoreSpy(createMemorySpeechStore());
  // 只替换媒体端口：媒体 HTTP 层在 real 下未接线，本用例单独隔离「受理后提供者不可用」这条路径。
  const provider = createRealSpeechProvider({ endpoint: 'https://example.invalid/asr', apiKey: 'not-a-real-key' });
  assert.equal(provider.available, true, '凭据齐备时进入受理，但适配器仍未接入');
  const { service } = boot('real', { provider, store: spy.store, media: createSubstituteMediaPort() });
  const { job, settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(settled.result, null);
  assert.equal(spy.state.recordCommits, 0);
  await assertApiError(
    () => service.getTranscription({ userId: USER, transcriptionId: job.target_ref.id }),
    'NOT_FOUND',
    'real 失败后的 GET',
  );
});

test('反例·real 模式媒体未接线 ⇒ 受理前 OBJECT_UNAVAILABLE（不出媒体端口兜底、不建任务）', async () => {
  const spy = withStoreSpy(createMemorySpeechStore());
  const { service } = boot('real', { store: spy.store, provider: scriptedProvider(normalOutcome()).provider });
  const unwired = createUnwiredMediaPort();
  assert.equal(unwired.kind, 'unwired');
  assert.equal((await unwired.resolve({ ownerUserId: USER, mediaId: randomUUID(), mediaRevision: 1 })).ok, false);
  await assertApiError(
    () =>
      service.createTranscription({
        userId: USER,
        body: { media_id: mediaIdForBucket(STUB_BUCKETS.normal), media_revision: 1 },
        idempotencyKey: nextKey(),
      }),
    'OBJECT_UNAVAILABLE',
    '未接线媒体端口下的受理',
  );
  assert.equal(spy.state.insertedJobs, 0);
});

test('反例·提供者抛错 ⇒ failed + PROVIDER_OUTCOME_UNKNOWN（任何异常都不得变成 succeeded）', async () => {
  const spy = withStoreSpy(createMemorySpeechStore());
  const scripted = scriptedProvider(() => {
    throw new Error('模拟提供者内部异常');
  });
  const { service } = boot('stub', { provider: scripted.provider, store: spy.store });
  const { settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(settled.result, null);
  assert.equal(spy.state.recordCommits, 0);
});

test('反例·提供者超时 ⇒ timed_out + PROVIDER_TIMEOUT（不得 succeeded）', async () => {
  const scripted = scriptedProvider(() => new Promise(() => {}));
  const { service } = boot('stub', { provider: scripted.provider, jobDeadlineMs: 20 });
  const { settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'timed_out');
  assert.equal(settled.error_code, 'PROVIDER_TIMEOUT');
  assert.equal(settled.result, null);
});

test('反例·提供者配额超限 ⇒ failed + PROVIDER_QUOTA_EXCEEDED（不得 succeeded）', async () => {
  const spy = withStoreSpy(createMemorySpeechStore());
  const scripted = scriptedProvider({ kind: 'failed', code: 'PROVIDER_QUOTA_EXCEEDED' });
  const { service } = boot('stub', { provider: scripted.provider, store: spy.store });
  const { settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'PROVIDER_QUOTA_EXCEEDED');
  assert.equal(spy.state.recordCommits, 0);
});

test('反例·提供者明确不可用 ⇒ failed + PROVIDER_UNAVAILABLE（不得 succeeded）', async () => {
  const scripted = scriptedProvider({ kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
  const { service } = boot('stub', { provider: scripted.provider });
  const { settled } = await createAndSettle(service, USER);
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(settled.result, null);
});

// ---------------------------------------------------------------- 请求校验反例

test('反例·body 多余字段 ⇒ INVALID_REQUEST（additionalProperties:false）', async () => {
  const { service } = boot();
  await assertApiError(
    () =>
      service.createTranscription({
        userId: USER,
        body: { media_id: randomUUID(), media_revision: 1, extra: true },
        idempotencyKey: nextKey(),
      }),
    'INVALID_REQUEST',
    '多余字段',
  );
  await assertApiError(
    () =>
      service.createTranscription({
        userId: USER,
        body: { media_id: randomUUID(), media_revision: 1, language: 'zh-CN' },
        idempotencyKey: nextKey(),
      }),
    'INVALID_REQUEST',
    '自造 language 字段',
  );
});

test('反例·media_id 非 uuid / 缺字段 / 类型不符 ⇒ INVALID_REQUEST', async () => {
  const { service } = boot();
  const bodies = [
    { label: '非 uuid', body: { media_id: 'not-a-uuid', media_revision: 1 } },
    { label: 'media_id 非字符串', body: { media_id: 12345, media_revision: 1 } },
    { label: '缺 media_revision', body: { media_id: randomUUID() } },
    { label: 'body 非对象', body: 'media' },
  ];
  for (const item of bodies) {
    await assertApiError(
      () => service.createTranscription({ userId: USER, body: item.body, idempotencyKey: nextKey() }),
      'INVALID_REQUEST',
      item.label,
    );
  }
});

test('反例·media_revision 非法（0 / 负数 / 非整数 / 字符串）⇒ INVALID_REQUEST', async () => {
  const { service } = boot();
  for (const revision of [0, -1, 1.5, '1', null]) {
    await assertApiError(
      () =>
        service.createTranscription({
          userId: USER,
          body: { media_id: randomUUID(), media_revision: revision },
          idempotencyKey: nextKey(),
        }),
      'INVALID_REQUEST',
      `media_revision=${String(revision)}`,
    );
  }
});

test('反例·缺 Idempotency-Key 或过短 ⇒ IDEMPOTENCY_KEY_REQUIRED', async () => {
  const { service } = boot();
  for (const key of [undefined, null, '', 'short', '1234567', 12345678]) {
    await assertApiError(
      () =>
        service.createTranscription({
          userId: USER,
          body: { media_id: randomUUID(), media_revision: 1 },
          idempotencyKey: key,
        }),
      'IDEMPOTENCY_KEY_REQUIRED',
      `Idempotency-Key=${String(key)}`,
    );
  }
});

// ---------------------------------------------------------------- 越权与不存在同形

test('越权·他人转写记录 GET / 确认 / 删除一律 NOT_FOUND（与不存在同形，不泄露存在性）', async () => {
  const { service } = boot();
  const { transcription } = await createAndSettle(service, USER);
  assert.notEqual(transcription, null);

  const missingId = randomUUID();
  const transferError = await captureApiError(
    () => service.getTranscription({ userId: OTHER_USER, transcriptionId: transcription.id }),
    'NOT_FOUND',
    '他人读取',
  );
  const missingError = await captureApiError(
    () => service.getTranscription({ userId: OTHER_USER, transcriptionId: missingId }),
    'NOT_FOUND',
    '不存在的记录',
  );
  assert.equal(transferError.message, missingError.message, '越权与不存在必须同形');

  await assertApiError(
    () =>
      service.confirmTranscription({
        userId: OTHER_USER,
        transcriptionId: transcription.id,
        body: { confirmed_text: '他人试图确认', confirmation: 'checked_and_sendable' },
        ifMatch: `"${transcription.revision}"`,
        idempotencyKey: nextKey(),
      }),
    'NOT_FOUND',
    '他人确认',
  );
  await assertApiError(
    () =>
      service.deleteTranscription({
        userId: OTHER_USER,
        transcriptionId: transcription.id,
        ifMatch: `"${transcription.revision}"`,
        idempotencyKey: nextKey(),
      }),
    'NOT_FOUND',
    '他人删除',
  );
  // 归属者自身状态未被越权请求改动。
  const stillThere = await service.getTranscription({ userId: USER, transcriptionId: transcription.id });
  assert.equal(stillThere.revision, transcription.revision);
  assert.equal(stillThere.confirmed_text, null);
});

test('反例·getTranscription 不存在的 id / 非 uuid ⇒ NOT_FOUND（不是 400）', async () => {
  const { service } = boot();
  await assertApiError(
    () => service.getTranscription({ userId: USER, transcriptionId: randomUUID() }),
    'NOT_FOUND',
    '不存在的 uuid',
  );
  await assertApiError(
    () => service.getTranscription({ userId: USER, transcriptionId: 'not-a-uuid' }),
    'NOT_FOUND',
    '非 uuid',
  );
});

test('反例·getJob 他人任务 ⇒ NOT_FOUND', async () => {
  const { service } = boot();
  const { job } = await createAndSettle(service, USER);
  await assertApiError(() => service.getJob({ userId: OTHER_USER, jobId: job.id }), 'NOT_FOUND', '他人任务');
  await assertApiError(() => service.getJob({ userId: USER, jobId: randomUUID() }), 'NOT_FOUND', '不存在的任务');
});

// ---------------------------------------------------------------- 确认：只写 confirmed_text

test('confirmTranscription·只写 confirmed_text 与 confirmed_at，raw_text / uncertain_spans 逐项不变', async () => {
  const { service } = boot();
  const { transcription } = await createAndSettle(service, USER);
  const text = '这是用户核对后的文本（与模型原始输出不同，属人的判断）';
  const confirmed = await service.confirmTranscription({
    userId: USER,
    transcriptionId: transcription.id,
    body: { confirmed_text: text, confirmation: 'checked_and_sendable' },
    ifMatch: `"${transcription.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(confirmed.confirmed_text, text);
  assertString(confirmed.confirmed_at, 'confirmed_at');
  assert.notEqual(confirmed.confirmed_at, null);
  assert.equal(Number.isNaN(Date.parse(confirmed.confirmed_at)), false, 'confirmed_at 必须可解析为时间');
  assert.equal(confirmed.revision, transcription.revision + 1);
  // 关键：模型原始输出与不确定区间一个字都不能变。
  assert.equal(confirmed.raw_text, transcription.raw_text, 'raw_text 绝不得被确认覆写');
  assert.deepEqual(confirmed.uncertain_spans, transcription.uncertain_spans, 'uncertain_spans 不得被确认改动');
  assert.equal(confirmed.model_version, transcription.model_version);
  assert.equal(confirmed.id, transcription.id);
  assert.deepEqual(Object.keys(confirmed).sort(), Object.keys(transcription).sort());

  // 从存储再读一次：落库结果同样未被改动。
  const reread = await service.getTranscription({ userId: USER, transcriptionId: transcription.id });
  assert.equal(reread.raw_text, transcription.raw_text);
  assert.deepEqual(reread.uncertain_spans, transcription.uncertain_spans);
  assert.equal(reread.confirmed_text, text);
});

test('确认不得计入模型准确率·二次确认只改 confirmed_text，raw_text 始终是模型原始输出', async () => {
  const scripted = scriptedProvider(normalOutcome());
  const { service } = boot('stub', { provider: scripted.provider });
  const { transcription } = await createAndSettle(service, USER);
  const originalRawText = transcription.raw_text;

  const first = await service.confirmTranscription({
    userId: USER,
    transcriptionId: transcription.id,
    body: { confirmed_text: '第一次核对文本', confirmation: 'checked_and_sendable' },
    ifMatch: `"${transcription.revision}"`,
    idempotencyKey: nextKey(),
  });
  const second = await service.confirmTranscription({
    userId: USER,
    transcriptionId: transcription.id,
    body: { confirmed_text: '第二次核对文本（用户改了主意）', confirmation: 'checked_and_sendable' },
    ifMatch: `"${first.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.equal(first.raw_text, originalRawText);
  assert.equal(second.raw_text, originalRawText, '两次确认后 raw_text 仍是模型原始输出');
  assert.equal(second.confirmed_text, '第二次核对文本（用户改了主意）');
  assert.deepEqual(second.uncertain_spans, transcription.uncertain_spans);
  assert.equal(second.revision, transcription.revision + 2);
});

test('反例·store 拒绝任何改写 raw_text / uncertain_spans 的更新（存储层不变量，不只靠约定）', async () => {
  const { store, service } = boot();
  const { transcription } = await createAndSettle(service, USER);
  await assert.rejects(
    () => store.updateTranscription(transcription.id, transcription.revision, (row) => ({ ...row, rawText: '被改写的文本' })),
    /不可改写/,
    '改写 raw_text 的更新必须被拒绝',
  );
  await assert.rejects(
    () =>
      store.updateTranscription(transcription.id, transcription.revision, (row) => ({
        ...row,
        uncertainSpans: [{ start: 0, end: 1, reason: '补造一条' }],
      })),
    /不可改写/,
    '改写 uncertain_spans 的更新必须被拒绝',
  );
  await assert.rejects(
    () =>
      store.updateTranscription(transcription.id, transcription.revision, (row) => ({
        ...row,
        uncertainSpans: [],
      })),
    /不可改写/,
    '删除 uncertain_spans 的更新必须被拒绝',
  );
  const untouched = await store.getTranscription(transcription.id);
  assert.equal(untouched.rawText, transcription.raw_text);
  assert.deepEqual(untouched.uncertainSpans, transcription.uncertain_spans);
});

test('反例·confirm 多余字段 / confirmation 取值不符 / confirmed_text 非法一律 INVALID_REQUEST', async () => {
  const { service } = boot();
  const { transcription } = await createAndSettle(service, USER);
  const confirm = (body) =>
    service.confirmTranscription({
      userId: USER,
      transcriptionId: transcription.id,
      body,
      ifMatch: `"${transcription.revision}"`,
      idempotencyKey: nextKey(),
    });
  await assertApiError(() => confirm({ confirmed_text: '文本', confirmation: 'checked_and_sendable', note: '多余' }), 'INVALID_REQUEST', '多余字段');
  await assertApiError(() => confirm({ confirmed_text: '文本', confirmation: 'ok' }), 'INVALID_REQUEST', 'confirmation 取值不符');
  await assertApiError(() => confirm({ confirmed_text: '文本' }), 'INVALID_REQUEST', '缺 confirmation');
  await assertApiError(() => confirm({ confirmation: 'checked_and_sendable' }), 'INVALID_REQUEST', '缺 confirmed_text');
  await assertApiError(() => confirm({ confirmed_text: '', confirmation: 'checked_and_sendable' }), 'INVALID_REQUEST', '空 confirmed_text');
  await assertApiError(
    () => confirm({ confirmed_text: '药'.repeat(8001), confirmation: 'checked_and_sendable' }),
    'INVALID_REQUEST',
    'confirmed_text 超 8000（不得截断）',
  );
  await assertApiError(() => confirm({ confirmed_text: 123, confirmation: 'checked_and_sendable' }), 'INVALID_REQUEST', 'confirmed_text 非字符串');
  await assertApiError(() => confirm('文本'), 'INVALID_REQUEST', 'body 非对象');
  // 以上全部失败后，记录必须原样（revision 未动、confirmed_text 仍为 null）。
  const after = await service.getTranscription({ userId: USER, transcriptionId: transcription.id });
  assert.equal(after.revision, transcription.revision);
  assert.equal(after.confirmed_text, null);
});

test('反例·confirm 缺 If-Match ⇒ REVISION_REQUIRED；格式非法 ⇒ INVALID_REQUEST；不一致 ⇒ REVISION_CONFLICT', async () => {
  const { service } = boot();
  const { transcription } = await createAndSettle(service, USER);
  const body = { confirmed_text: '核对文本', confirmation: 'checked_and_sendable' };
  const confirm = (ifMatch, key = nextKey()) =>
    service.confirmTranscription({ userId: USER, transcriptionId: transcription.id, body, ifMatch, idempotencyKey: key });
  await assertApiError(() => confirm(undefined), 'REVISION_REQUIRED', '缺 If-Match');
  await assertApiError(() => confirm(''), 'REVISION_REQUIRED', '空 If-Match');
  await assertApiError(() => confirm('1'), 'INVALID_REQUEST', 'If-Match 缺引号');
  await assertApiError(() => confirm('*'), 'INVALID_REQUEST', 'If-Match 为 *');
  await assertApiError(() => confirm('"0"'), 'INVALID_REQUEST', 'If-Match 为非正数');
  await assertApiError(() => confirm(`"${transcription.revision + 5}"`), 'REVISION_CONFLICT', 'revision 不一致');
  const after = await service.getTranscription({ userId: USER, transcriptionId: transcription.id });
  assert.equal(after.revision, transcription.revision);
  assert.equal(after.confirmed_text, null, '冲突时不得写入确认文本');
});

// ---------------------------------------------------------------- 删除

test('deleteTranscription·软删除后返回 accepted，且记录不再可读', async () => {
  const { service } = boot();
  const { job, transcription } = await createAndSettle(service, USER);
  const ack = await service.deleteTranscription({
    userId: USER,
    transcriptionId: transcription.id,
    ifMatch: `"${transcription.revision}"`,
    idempotencyKey: nextKey(),
  });
  assert.deepEqual(ack, { accepted: true });
  await assertApiError(
    () => service.getTranscription({ userId: USER, transcriptionId: transcription.id }),
    'NOT_FOUND',
    '删除后的 GET',
  );
  const settledJob = await service.getJob({ userId: USER, jobId: job.id });
  assert.equal(settledJob.state, 'succeeded');
  assert.equal(settledJob.result, null, '已删除记录不得再作为任务结果下发');
});

test('反例·delete 缺 If-Match ⇒ REVISION_REQUIRED；revision 不一致 ⇒ REVISION_CONFLICT 且不删除', async () => {
  const { service } = boot();
  const { transcription } = await createAndSettle(service, USER);
  await assertApiError(
    () => service.deleteTranscription({ userId: USER, transcriptionId: transcription.id, ifMatch: undefined, idempotencyKey: nextKey() }),
    'REVISION_REQUIRED',
    '缺 If-Match',
  );
  await assertApiError(
    () =>
      service.deleteTranscription({
        userId: USER,
        transcriptionId: transcription.id,
        ifMatch: `"${transcription.revision + 3}"`,
        idempotencyKey: nextKey(),
      }),
    'REVISION_CONFLICT',
    'revision 不一致',
  );
  const after = await service.getTranscription({ userId: USER, transcriptionId: transcription.id });
  assert.equal(after.revision, transcription.revision, '冲突时不得删除或递增 revision');
});

// ---------------------------------------------------------------- 幂等与并发（先占位再建任务）

test('反例·同键同体**并发** createTranscription：恰好 1 个任务、恰好 1 次提供者调用、响应收敛同一任务', async () => {
  const counter = withCallCounter(createStubSpeechProvider({}));
  const spy = withStoreSpy(createMemorySpeechStore());
  const { service } = boot('stub', { provider: counter.provider, store: spy.store });
  const body = { media_id: mediaIdForBucket(STUB_BUCKETS.normal), media_revision: 1 };
  const key = nextKey();

  const results = await Promise.allSettled([
    service.createTranscription({ userId: USER, body, idempotencyKey: key }),
    service.createTranscription({ userId: USER, body, idempotencyKey: key }),
    service.createTranscription({ userId: USER, body, idempotencyKey: key }),
  ]);
  await service.settle();

  const fulfilled = results.filter((item) => item.status === 'fulfilled').map((item) => item.value);
  const rejected = results.filter((item) => item.status === 'rejected');
  const conflicts = rejected.filter((item) => item.reason.code === 'IDEMPOTENCY_CONFLICT').length;
  const inProgress = rejected.filter((item) => item.reason.code === 'REQUEST_IN_PROGRESS').length;
  const jobIds = [...new Set(fulfilled.map((item) => item.job.id))];
  const transcriptionIds = [...new Set(fulfilled.map((item) => item.job.target_ref.id))];

  console.error(
    `[并发实测·同键同体 3 次] 落库任务数=${spy.state.insertedJobs}、提供者调用数=${counter.state.calls}、` +
      `成功响应=${fulfilled.length}、不同 job id 数=${jobIds.length}、不同 target_ref.id 数=${transcriptionIds.length}、` +
      `IDEMPOTENCY_CONFLICT=${conflicts}、REQUEST_IN_PROGRESS=${inProgress}、写入记录数=${spy.state.recordCommits}`,
  );

  // 硬要求 1：恰好 1 个任务落库、恰好 1 次提供者调用（若建出 2 个任务这里会是 2）。
  assert.equal(spy.state.insertedJobs, 1, `必须恰好落库 1 个任务，实际 ${spy.state.insertedJobs}`);
  assert.equal(counter.state.calls, 1, `提供者调用次数应为 1，实际 ${counter.state.calls}`);
  assert.equal(spy.state.recordCommits, 1);
  // 硬要求 2：所有成功响应收敛到**同一**任务与同一转写记录。
  assert.equal(fulfilled.length, 3, `三个并发同键同体请求都应成功收敛，实际 ${fulfilled.length}（拒绝 ${rejected.length}）`);
  assert.equal(jobIds.length, 1, `并发同键必须收敛到同一任务，实际 ${JSON.stringify(jobIds)}`);
  assert.equal(transcriptionIds.length, 1, '必须收敛到同一转写记录');
  assert.equal(fulfilled.filter((item) => item.replayed === false).length, 1, '恰好一个请求是首次受理');
  assert.equal(rejected.length, 0, '等待预算充足时不得让同键同体请求失败');

  // 落定之后同键再请求：必须回放同一任务，且不得再次调用提供者。
  const replay = await service.createTranscription({ userId: USER, body, idempotencyKey: key });
  assert.equal(replay.replayed, true);
  assert.equal(replay.job.id, jobIds[0]);
  assert.equal(replay.job.state, 'succeeded');
  assert.notEqual(replay.job.result, null, '回放必须能读到已完成的结果');
  assert.equal(counter.state.calls, 1, '重放不得再次调用提供者');
  assert.equal(spy.state.insertedJobs, 1, '重放不得再建任务');
});

test('反例·同键不同体并发 ⇒ 一个受理、另一个 IDEMPOTENCY_CONFLICT，且不产生第二个任务', async () => {
  const spy = withStoreSpy(createMemorySpeechStore());
  const { service } = boot('stub', { store: spy.store });
  const key = nextKey();
  const results = await Promise.allSettled([
    service.createTranscription({
      userId: USER,
      body: { media_id: mediaIdForBucket(STUB_BUCKETS.normal), media_revision: 1 },
      idempotencyKey: key,
    }),
    service.createTranscription({
      userId: USER,
      body: { media_id: mediaIdForBucket(STUB_BUCKETS.confident), media_revision: 1 },
      idempotencyKey: key,
    }),
  ]);
  await service.settle();
  const fulfilled = results.filter((item) => item.status === 'fulfilled');
  const rejected = results.filter((item) => item.status === 'rejected');
  console.error(
    `[并发实测·同键异体 2 次] 落库任务数=${spy.state.insertedJobs}、成功响应=${fulfilled.length}、` +
      `IDEMPOTENCY_CONFLICT=${rejected.filter((item) => item.reason.code === 'IDEMPOTENCY_CONFLICT').length}`,
  );
  assert.equal(fulfilled.length, 1, '必须恰好一个被受理');
  assert.equal(rejected.length, 1, '另一个必须被拒');
  assert.equal(rejected[0].reason.name, 'ApiError');
  assert.equal(rejected[0].reason.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(spy.state.insertedJobs, 1, '同键异体不得产生第二个任务');
  assert.equal(spy.state.recordCommits, 1);
});

test('反例·同键异体（串行）⇒ IDEMPOTENCY_CONFLICT，不得把第二次请求当成重放', async () => {
  const spy = withStoreSpy(createMemorySpeechStore());
  const { service } = boot('stub', { store: spy.store });
  const key = nextKey();
  await service.createTranscription({
    userId: USER,
    body: { media_id: mediaIdForBucket(STUB_BUCKETS.normal), media_revision: 1 },
    idempotencyKey: key,
  });
  await service.settle();
  await assertApiError(
    () =>
      service.createTranscription({
        userId: USER,
        body: { media_id: mediaIdForBucket(STUB_BUCKETS.confident), media_revision: 1 },
        idempotencyKey: key,
      }),
    'IDEMPOTENCY_CONFLICT',
    '同键异体串行',
  );
  assert.equal(spy.state.insertedJobs, 1);
});

test('反例·同主体同键但不同路由不互相干扰（键域含方法/路径），不同主体同样隔离', async () => {
  const spy = withStoreSpy(createMemorySpeechStore());
  const { service } = boot('stub', { store: spy.store });
  const key = nextKey();
  const body = { media_id: mediaIdForBucket(STUB_BUCKETS.normal), media_revision: 1 };
  const [first, second] = await Promise.all([
    service.createTranscription({ userId: USER, body, idempotencyKey: key }),
    service.createTranscription({ userId: OTHER_USER, body, idempotencyKey: key }),
  ]);
  await service.settle();
  assert.notEqual(first.job.id, second.job.id, '不同主体的同键请求必须各自受理');
  assert.equal(spy.state.insertedJobs, 2);
});

test('反例·占位在落库失败后必须释放，同键重试可正常受理（不得留下永久 REQUEST_IN_PROGRESS）', async () => {
  const inner = createMemorySpeechStore();
  let pendingFailures = 1;
  const store = {
    ...inner,
    async insertJob(row) {
      if (pendingFailures > 0) {
        pendingFailures -= 1;
        throw new Error('模拟落库失败');
      }
      return inner.insertJob(row);
    },
  };
  const { service } = boot('stub', { store });
  const body = { media_id: mediaIdForBucket(STUB_BUCKETS.normal), media_revision: 1 };
  const key = nextKey();
  await assert.rejects(
    () => service.createTranscription({ userId: USER, body, idempotencyKey: key }),
    /模拟落库失败/,
    '首次受理应如实抛错',
  );
  // 同键重试：若占位未释放，这里会得到 REQUEST_IN_PROGRESS（永久 pending）。
  const retry = await service.createTranscription({ userId: USER, body, idempotencyKey: key });
  assert.equal(retry.replayed, false, '占位已释放，重试必须真正受理');
  await service.settle();
  const settled = await service.getJob({ userId: USER, jobId: retry.job.id });
  assert.equal(settled.state, 'succeeded');
  assert.notEqual(settled.result, null);
});

test('反例·同键并发 confirmTranscription 只写一次（revision 只 +1，两响应收敛）', async () => {
  const { service } = boot();
  const { transcription } = await createAndSettle(service, USER);
  const key = nextKey();
  const body = { confirmed_text: '并发核对文本', confirmation: 'checked_and_sendable' };
  const results = await Promise.allSettled([
    service.confirmTranscription({ userId: USER, transcriptionId: transcription.id, body, ifMatch: `"${transcription.revision}"`, idempotencyKey: key }),
    service.confirmTranscription({ userId: USER, transcriptionId: transcription.id, body, ifMatch: `"${transcription.revision}"`, idempotencyKey: key }),
  ]);
  const after = await service.getTranscription({ userId: USER, transcriptionId: transcription.id });
  assert.equal(after.revision, transcription.revision + 1, `revision 只应 +1，实际 ${after.revision}`);
  assert.equal(after.confirmed_text, '并发核对文本');
  assert.equal(after.raw_text, transcription.raw_text, 'raw_text 依旧未被触碰');
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 2, '同键并发应等待并收敛，不得重复写');
  for (const item of results) {
    assert.equal(item.status, 'fulfilled');
    assert.equal(item.value.revision, transcription.revision + 1);
    assert.equal(item.value.confirmed_text, '并发核对文本');
  }
});

test('反例·confirm 失败释放占位：同键改对 revision 重试必须成功', async () => {
  const { service } = boot();
  const { transcription } = await createAndSettle(service, USER);
  const key = nextKey();
  const body = { confirmed_text: '重试核对文本', confirmation: 'checked_and_sendable' };
  await assertApiError(
    () =>
      service.confirmTranscription({
        userId: USER,
        transcriptionId: transcription.id,
        body,
        ifMatch: '"99"',
        idempotencyKey: key,
      }),
    'REVISION_CONFLICT',
    '错误 revision 的首次确认',
  );
  const corrected = await service.confirmTranscription({
    userId: USER,
    transcriptionId: transcription.id,
    body,
    ifMatch: `"${transcription.revision}"`,
    idempotencyKey: key,
  });
  assert.equal(corrected.confirmed_text, '重试核对文本');
  assert.equal(corrected.revision, transcription.revision + 1);
});

test('反例·delete 同键并发只删一次，且成功后可回放 accepted', async () => {
  const { service } = boot();
  const { transcription } = await createAndSettle(service, USER);
  const key = nextKey();
  const results = await Promise.allSettled([
    service.deleteTranscription({ userId: USER, transcriptionId: transcription.id, ifMatch: `"${transcription.revision}"`, idempotencyKey: key }),
    service.deleteTranscription({ userId: USER, transcriptionId: transcription.id, ifMatch: `"${transcription.revision}"`, idempotencyKey: key }),
  ]);
  for (const item of results) {
    assert.equal(item.status, 'fulfilled');
    assert.deepEqual(item.value, { accepted: true });
  }
  await assertApiError(
    () => service.getTranscription({ userId: USER, transcriptionId: transcription.id }),
    'NOT_FOUND',
    '并发删除后的 GET',
  );
  const replay = await service.deleteTranscription({
    userId: USER,
    transcriptionId: transcription.id,
    ifMatch: `"${transcription.revision}"`,
    idempotencyKey: key,
  });
  assert.deepEqual(replay, { accepted: true }, '失败或已删除都不得让同键重放变成 404');
});

// ---------------------------------------------------------------- 诊断与替身标注

test('describe()·替身如实标注（modelVersion 带 stub/preset-demo 标记，note 明写非真实、不构成准确率证据）', async () => {
  const stub = boot('stub');
  const preset = boot('preset_demo');
  const real = boot('real');
  for (const [label, service, expected] of [
    ['stub', stub.service, 'stub-v1'],
    ['preset_demo', preset.service, 'preset-demo-v1'],
  ]) {
    const described = service.describe();
    assert.equal(described.executionMode, label === 'stub' ? 'stub' : 'preset_demo');
    assert.equal(described.modelVersion, expected);
    assertString(described.providerNote, `${label}.providerNote`);
    assert.ok(described.providerNote.includes('替身'), `${label} 的 note 必须明写「替身」`);
    assert.ok(described.providerNote.includes('非真实'), `${label} 的 note 必须明写「非真实」`);
    assert.equal(described.storePersistent, false, '内存 store 必须如实标注为不持久');
    assert.equal(typeof described.jobDeadlineMs, 'number');
  }
  const realDescribed = real.service.describe();
  assert.equal(realDescribed.executionMode, 'real');
  assert.equal(realDescribed.providerAvailable, false);
  assertString(realDescribed.providerUnavailableReason, 'providerUnavailableReason');
  assert.ok(realDescribed.providerUnavailableReason.includes('fail-closed'));
  // 媒体端口在替身与真实模式下的标注必须不同（不得用替身冒充真实媒体）。
  assert.equal(stub.service.describe().mediaPort, 'substitute');
  assert.equal(real.service.describe().mediaPort, 'unwired');
});

test('投影纯函数·toTranscription / toJob 不改变输入行，且未落定任务不带结果', () => {
  const at = new Date('2026-10-12T00:00:00.000Z');
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    revision: 2,
    ownerUserId: USER,
    mediaId: '22222222-2222-4222-8222-222222222222',
    mediaRevision: 1,
    rawText: '模型原始输出',
    uncertainSpans: [{ start: 0, end: 2, reason: '开头不确定' }],
    confirmedText: '用户核对文本',
    confirmedAt: at,
    modelVersion: 'stub-v1',
    createdAt: at,
    updatedAt: at,
    deleted: false,
  };
  const snapshot = structuredClone(row);
  const projected = toTranscription(row);
  assert.deepEqual(row, snapshot, '投影函数不得改动输入行');
  assert.equal(projected.raw_text, '模型原始输出');
  assert.equal(projected.confirmed_text, '用户核对文本');
  assert.equal(projected.confirmed_at, at.toISOString());
  assert.notEqual(projected.uncertain_spans, row.uncertainSpans);

  const jobRow = {
    id: '33333333-3333-4333-8333-333333333333',
    revision: 2,
    kind: 'transcription',
    ownerUserId: USER,
    transcriptionId: row.id,
    mediaId: row.mediaId,
    mediaRevision: 1,
    state: 'queued',
    deadlineAt: at,
    createdAt: at,
    updatedAt: at,
    errorCode: null,
  };
  assert.equal(toJob(jobRow, null).result, null, 'queued 不得带结果');
  assert.equal(toJob(jobRow, row).result, null, 'queued 即使有记录也不得带结果');
  const failed = toJob({ ...jobRow, state: 'failed', errorCode: 'PROVIDER_TIMEOUT' }, null);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error_code, 'PROVIDER_TIMEOUT');
  assert.equal(failed.result, null);
  const succeeded = toJob({ ...jobRow, state: 'succeeded' }, row);
  assert.equal(succeeded.result.kind, 'transcription');
  assert.equal(succeeded.result.value.raw_text, '模型原始输出');
  // 已删除记录不得作为结果下发。
  assert.equal(toJob({ ...jobRow, state: 'succeeded' }, { ...row, deleted: true }).result, null);
});

test('媒体端口·替身与未接线的标注与行为（real 一律 fail-closed，不回退替身）', async () => {
  const substitute = createSubstituteMediaPort();
  assert.equal(substitute.kind, 'substitute');
  assert.ok(substitute.note.includes('替身'));
  const ok = await substitute.resolve({ ownerUserId: USER, mediaId: randomUUID(), mediaRevision: 3 });
  assert.deepEqual(ok, { ok: true, revision: 3 });
  const badRevision = await substitute.resolve({ ownerUserId: USER, mediaId: randomUUID(), mediaRevision: 0 });
  assert.deepEqual(badRevision, { ok: false, code: 'REVISION_CONFLICT' });

  const realPort = createSpeechMediaPort('real');
  assert.equal(realPort.kind, 'unwired', 'real 模式的媒体端口必须未接线');
  assert.ok(realPort.note.includes('fail-closed'));
  assert.deepEqual(await realPort.resolve({ ownerUserId: USER, mediaId: randomUUID(), mediaRevision: 1 }), {
    ok: false,
    code: 'OBJECT_UNAVAILABLE',
  });
  for (const mode of ['stub', 'preset_demo']) {
    assert.equal(createSpeechMediaPort(mode).kind, 'substitute', `${mode} 模式使用替身端口`);
  }
});

test('替身提供者·确定性分桶逐桶给出可观测的契约行为（不是识别效果，也不构成准确率证据）', async () => {
  const provider = createStubSpeechProvider({});
  assert.equal(provider.executionMode, 'stub');
  assert.equal(provider.modelVersion, 'stub-v1');
  assert.equal(provider.available, true);

  const normal = await provider.transcribe({ jobId: randomUUID(), mediaId: mediaIdForBucket(STUB_BUCKETS.normal), mediaRevision: 1 });
  assert.equal(normal.kind, 'completed');
  assert.equal(normal.transcript.uncertain_spans.length, 2);

  const confident = await provider.transcribe({ jobId: randomUUID(), mediaId: mediaIdForBucket(STUB_BUCKETS.confident), mediaRevision: 1 });
  assert.deepEqual(confident.transcript.uncertain_spans, []);

  const silent = await provider.transcribe({ jobId: randomUUID(), mediaId: mediaIdForBucket(STUB_BUCKETS.silent), mediaRevision: 1 });
  assert.equal(silent.transcript.text, '');

  const atLimit = await provider.transcribe({ jobId: randomUUID(), mediaId: mediaIdForBucket(STUB_BUCKETS.spansAtLimit), mediaRevision: 1 });
  assert.equal(atLimit.transcript.uncertain_spans.length, STUB_SPAN_LIMIT);

  const tooLong = await provider.transcribe({ jobId: randomUUID(), mediaId: mediaIdForBucket(STUB_BUCKETS.tooLong), mediaRevision: 1 });
  assert.equal([...tooLong.transcript.text].length, STUB_TOO_LONG_CODE_POINTS);

  const malformed = await provider.transcribe({ jobId: randomUUID(), mediaId: mediaIdForBucket(STUB_BUCKETS.malformedSpan), mediaRevision: 1 });
  assert.ok(malformed.transcript.uncertain_spans[0].start >= malformed.transcript.uncertain_spans[0].end);

  // 同一 mediaId 必须永远得到同一脚本（确定性，可离线复现）。
  const again = await provider.transcribe({ jobId: randomUUID(), mediaId: mediaIdForBucket(STUB_BUCKETS.normal), mediaRevision: 1 });
  assert.deepEqual(again.transcript, normal.transcript);

  const preset = createStubSpeechProvider({ executionMode: 'preset_demo' });
  assert.equal(preset.modelVersion, 'preset-demo-v1');
  const demo = await preset.transcribe({ jobId: randomUUID(), mediaId: randomUUID(), mediaRevision: 1 });
  assert.equal(demo.kind, 'completed');
  assert.equal(demo.transcript.uncertain_spans.length, 1);

  // real 工厂在任何模式下都不得产出替身提供者。
  const real = createSpeechProvider({ executionMode: 'real' });
  assert.equal(real.executionMode, 'real');
  assert.equal(real.modelVersion, 'real-unconfigured');
  assert.notEqual(real.modelVersion, 'stub-v1');
});

// ---------------------------------------------------------------- 可重试口径（GY-R31 / #7）

/** **负臂**（独立成例，改动前后都必须绿）：确定性请求错误仍是 400 `INVALID_REQUEST` 且 `retryable:false`。 */
test('可重试口径·负臂：非法请求体 ⇒ 400 INVALID_REQUEST 仍 retryable:false（两种状态下都必须绿）', async () => {
  const { service } = boot('stub');
  await assert.rejects(
    () => service.createTranscription({
      userId: USER,
      body: { media_id: mediaIdForBucket(STUB_BUCKETS.normal), media_revision: 1, extra_field: true },
      idempotencyKey: nextKey(),
    }),
    error => {
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.equal(error.status, 400, '状态码口径不变：仍为 400');
      assert.equal(error.retryable, false, '请求体不合契约是确定性拒绝，不得谎称可重试');
      return true;
    },
  );
});

/**
 * 「同一 Idempotency-Key 的请求仍在处理中」是**时间能解决的瞬时态**（等待后重放不会重复执行副作用），
 * 且 HTTP 出口已为该码发 `Retry-After: 1`（`services/api/src/app.ts:1836-1837`）⇒ 必须 `retryable: true`。
 * 状态码仍是 409（**不变**）。
 *
 * 确定性构造：占位者已落定（`pending:false`）但其结果引用的 `job_id` 从未落库 ⇒ `createTranscription`
 * 落到 `inProgress()`。不依赖墙钟或并发，故 `code`/`status`/`retryable` 三个读数都可钉。
 */
test('可重试口径·同键占位未落定 ⇒ 409 REQUEST_IN_PROGRESS 且 retryable:true（状态码不变）', async () => {
  const base = createMemorySpeechStore();
  let claimed = null;
  const occupied = {
    ...base,
    async claimIdempotent(scope, keyHashHex, row) {
      claimed = { scope, keyHashHex, row };
      return 'exists';
    },
    async findIdempotent(scope, keyHashHex) {
      if (claimed === null || claimed.scope !== scope || claimed.keyHashHex !== keyHashHex) return null;
      return { ...claimed.row, pending: false };
    },
  };
  const { service } = boot('stub', { store: occupied });
  await assert.rejects(
    () => service.createTranscription({
      userId: USER,
      body: { media_id: mediaIdForBucket(STUB_BUCKETS.normal), media_revision: 1 },
      idempotencyKey: nextKey(),
    }),
    error => {
      assert.equal(error.name, 'ApiError');
      assert.equal(error.code, 'REQUEST_IN_PROGRESS');
      assert.equal(error.status, 409, '状态码口径不变：仍为 409');
      assert.equal(error.retryable, true, 'REQUEST_IN_PROGRESS 必须可重试（与 Retry-After: 1 一致）');
      return true;
    },
  );
});
