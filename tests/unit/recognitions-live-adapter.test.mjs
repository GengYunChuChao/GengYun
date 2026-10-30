// GY-R70 · 拍草识别（#9）**真实适配器 + 字节端口**接线回归（全离线：零真实供应商调用、不读任何凭据值）。
//
// 本片要关的卡点（改前读数，逐条可复核）：
//   1. `services/api/src/recognitions/provider.ts` 的 `createRealRecognitionProvider().recognize()` **恒**返回
//      `{kind:'failed', code:'PROVIDER_UNAVAILABLE'}` —— `real` 下根本没有适配器；
//   2. `services/api/src/recognitions/media.ts` 的 `createRecognitionMediaPort('real')` **恒**为
//      `createUnwiredMediaPort()` ⇒ 即使补了适配器，受理前的媒体校验也永远 409 `OBJECT_UNAVAILABLE`。
//
// 六条必须一直成立的事（删/改任一条即红，见交付回报的负控制表）：
//   A. **真实适配器存在且只吃注入端口**：`recognitions/live-adapter.ts` 的 `createLiveRecognitionProvider()`
//      没有端口对象就构造不出来；`fetchImpl` 可注入，一切发送都经它（本文件全部用例用假 fetch）；
//   B. **错误映射只用既有契约码**：超时 → `PROVIDER_TIMEOUT`、配额 → `PROVIDER_QUOTA_EXCEEDED`、
//      结果未知/协议违规 → `PROVIDER_OUTCOME_UNKNOWN`、不可用 → `PROVIDER_UNAVAILABLE`，**不发明新码**；
//   C. **字节只从去元数据衍生件来**：`recognitions/image-source.ts` 只读 `derivativeRef`，
//      原件键（`rawRef`）**一次都不读**；跨用途（label_ocr / community_image）与 non-PNG/JPEG 一律拒绝；
//   D. **零外呼可证**：不给适配器（缺凭据 / 装配失败 / 取不到字节）时 `globalThis.fetch` 调用计数 **0**；
//   E. **失败序**：无凭据 503 → 有凭据无字节端口 409 → 两者齐备才进入发包路径（本文件逐条实测）；
//   F. **等价性**：不满足真实条件时（缺凭据）与改前**逐字段相同**（`failed PROVIDER_UNAVAILABLE`、零发包）。
//
// ⚠ 诚实边界：本文件全部字节是 **24 字节合成 PNG 头**，全部候选是合成占位串，**零**真实照片、
//   **零**真实供应商响应。它证明的是「端口已接线、失败语义可判定、零凭据零发包」，
//   **不证明**识别准确率，也**不证明**任何一次真实调用成功（见证据页 §4）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { MEDIA_PURPOSE_KIND, MEDIA_PURPOSE_MIME, MEDIA_PURPOSES } from '../../packages/media/constants.mjs';

import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { ERROR_CODES } from '../../services/api/src/contract.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryMediaStore } from '../../services/api/src/media/store.ts';
import { createSubstituteObjectStore, createUnwiredObjectStore } from '../../services/api/src/media/object-store.ts';
import {
  PROVIDER_FAILURE_CODES,
  createRealRecognitionProvider,
  createRecognitionProvider,
  createStubRecognitionProvider,
} from '../../services/api/src/recognitions/provider.ts';
import {
  createRecognitionMediaPort,
  createObjectStoreRecognitionMediaPort,
  createSubstituteMediaPort,
  createUnwiredMediaPort,
} from '../../services/api/src/recognitions/media.ts';
import {
  LIVE_RECOGNITION_FROZEN_PROFILE,
  createLiveRecognitionProvider,
  createLiveRecognitionProviderFromCredentials,
  requireLiveRecognitionImage,
} from '../../services/api/src/recognitions/live-adapter.ts';
import {
  RECOGNITION_GATE_AUTHORIZATION,
  createProcessRecognitionGate,
} from '../../services/api/src/recognitions/live-ports.ts';
import {
  RECOGNITION_IMAGE_CONTENT_TYPES,
  RECOGNITION_IMAGE_FAILURE_CODES,
  RECOGNITION_IMAGE_PURPOSES,
  createObjectStoreRecognitionImageSource,
} from '../../services/api/src/recognitions/image-source.ts';

const REPO = new URL('../../', import.meta.url);
const readRepoText = (relative) => readFileSync(new URL(relative, REPO), 'utf8');

const ENDPOINT = 'https://recognition.invalid/v1/recognize';
const API_KEY = 'synthetic-recognition-key-not-real-0001';
const MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const JOB_ID = '11111111-2222-4333-8444-555555555555';
const RAW_KEY = 'media-raw/synthetic-r70-original-with-exif-0001';
const DERIVED_KEY = 'media-derived/synthetic-r70-stripped-0001';
const REQUEST_ID = 'req-0123456789abcdef';

/** 最小合法 PNG 头（24 字节）；`requireLiveRecognitionImage` 认它。**不含任何真实照片/EXIF**。 */
const PNG = (() => {
  const buffer = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(2, 16);
  buffer.writeUInt32BE(2, 20);
  return new Uint8Array(buffer);
})();

/** 合成候选（3 条、分数互异、Top1 ≥ 可信门槛 0.5 ⇒ `decideOutcome` 判 `succeeded`）。 */
const OK_BODY = Object.freeze({
  request_id: REQUEST_ID,
  candidates: [
    { species_id: 'synthetic_live_weed_a', rank: 1, model_score: 0.81 },
    { species_id: 'synthetic_live_weed_b', rank: 2, model_score: 0.42 },
    { species_id: 'synthetic_live_weed_c', rank: 3, model_score: 0.17 },
  ],
  uncertainty_reasons: [],
});

/** 假 fetch：记录调用并回一段可控响应（**永不联网**；端点域名是 `.invalid`，DNS 也不可达）。 */
function captureFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = typeof responder === 'function' ? responder(url, init) : responder;
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn, calls };
}

/** 绊线 fetch：任何一次调用都算失败（用来证明「零外呼」）。 */
function tripwireFetch() {
  const state = { calls: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    state.calls += 1;
    throw new Error(`绊线被触发：本测试不得发出任何真实请求（${String(url)}）`);
  };
  return {
    state,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** 固定字节来源（模拟「字节端口已接线」）。 */
function staticSource(bytes) {
  const reads = [];
  return {
    kind: 'stub-source',
    note: 'synthetic image source（测试替身，仅用于验证适配器侧契约）',
    reads,
    async read(input) {
      reads.push(input);
      return bytes;
    },
  };
}

/** 默认端口（全部可覆盖）：唯一目的是把「装配」从每个用例里抽出来。 */
function liveProvider(overrides = {}) {
  return createLiveRecognitionProvider({
    profile: {
      protocol: LIVE_RECOGNITION_FROZEN_PROFILE.protocol,
      endpoint: ENDPOINT,
      timeoutMs: LIVE_RECOGNITION_FROZEN_PROFILE.defaultTimeoutMs,
      maxRetries: 0,
      maxImageBytes: LIVE_RECOGNITION_FROZEN_PROFILE.maxImageBytes,
      mediaTransport: 'inlineBase64',
      ...(overrides.profile ?? {}),
    },
    credentials: overrides.credentials ?? { apiKey: API_KEY },
    authorization: overrides.authorization ?? RECOGNITION_GATE_AUTHORIZATION,
    imageSource: overrides.imageSource ?? staticSource(PNG),
    ...(overrides.liveGate === undefined ? {} : { liveGate: overrides.liveGate }),
    ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
    ...(overrides.onObservation === undefined ? {} : { onObservation: overrides.onObservation }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}

const RECOGNIZE_INPUT = Object.freeze({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });

// ---------------------------------------------------------------- A. 适配器契约矩阵

test('A·正控制：正常结果 → completed 候选；恰好一次发送；请求体带的是那一段字节', async () => {
  const fetched = captureFetch(OK_BODY);
  const observations = [];
  const provider = liveProvider({ fetchImpl: fetched.fn, onObservation: (o) => observations.push(o) });

  // 适配器**不**决定任务状态：它只交候选与原因，状态由 state.ts 的 decideOutcome 判定。
  assert.equal(provider.executionMode, 'real');
  assert.equal(provider.available, true);
  assert.equal(provider.unavailableReason, null);
  assert.equal(provider.modelVersion, LIVE_RECOGNITION_FROZEN_PROFILE.protocol);

  const outcome = await provider.recognize(RECOGNIZE_INPUT);
  assert.deepEqual(outcome, {
    kind: 'completed',
    candidates: OK_BODY.candidates,
    uncertainty_reasons: [],
  });

  assert.equal(fetched.calls.length, 1, '恰好一次发送（零重试）');
  const [call] = fetched.calls;
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'manual', '绝不跟随重定向（可能把凭据/字节带到别的主机）');
  assert.equal(call.init.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(call.init.headers['x-gy-protocol'], LIVE_RECOGNITION_FROZEN_PROFILE.protocol);
  const body = JSON.parse(call.init.body);
  assert.equal(body.protocol, LIVE_RECOGNITION_FROZEN_PROFILE.protocol);
  assert.equal(body.media.content_type, 'image/png');
  assert.deepEqual(new Uint8Array(Buffer.from(body.media.bytes_base64, 'base64')), PNG, '请求体里的字节必须逐字节相同');

  assert.equal(observations.length, 1);
  assert.equal(observations[0].state, 'BUSINESS_RESPONSE');
  assert.equal(observations[0].sendAttempts, 1);
  assert.equal(observations[0].candidateCount, 3);
  assert.equal(observations[0].requestId, REQUEST_ID);
  assert.equal(observations[0].resultMayHaveBeenProcessed, true);
});

test('A·失败矩阵：超时/配额/5xx/4xx/非法 JSON/缺 request_id/坏候选/坏分支 —— 码只用既有闭集', async () => {
  const timeoutError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const networkError = () => Object.assign(new Error('socket hang up'), { name: 'TypeError' });

  const cases = [
    ['超时（AbortSignal.timeout）', { fetchImpl: captureFetch(timeoutError).fn }, { kind: 'failed', code: 'PROVIDER_TIMEOUT' }],
    ['AbortError（等价超时）', { fetchImpl: captureFetch(() => Object.assign(new Error('aborted'), { name: 'AbortError' })).fn }, { kind: 'failed', code: 'PROVIDER_TIMEOUT' }],
    ['传输失败（连接重置）', { fetchImpl: captureFetch(networkError).fn }, { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' }],
    ['HTTP 429 配额', { fetchImpl: captureFetch(new Response('{}', { status: 429 })).fn }, { kind: 'failed', code: 'PROVIDER_QUOTA_EXCEEDED' }],
    ['HTTP 500 不可用', { fetchImpl: captureFetch(new Response('{}', { status: 500 })).fn }, { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' }],
    ['HTTP 503 不可用', { fetchImpl: captureFetch(new Response('{}', { status: 503 })).fn }, { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' }],
    ['HTTP 401 未授权（凭据被拒）', { fetchImpl: captureFetch(new Response('{}', { status: 401 })).fn }, { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' }],
    ['HTTP 403 禁止', { fetchImpl: captureFetch(new Response('{}', { status: 403 })).fn }, { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' }],
    ['HTTP 400 协议/入参不符', { fetchImpl: captureFetch(new Response('{}', { status: 400 })).fn }, { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' }],
    ['响应体不是 JSON', { fetchImpl: captureFetch(new Response('<html>nope</html>', { status: 200 })).fn }, { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' }],
    ['JSON 是数组而非对象', { fetchImpl: captureFetch([]).fn }, { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' }],
    ['缺 request_id（无法追溯 ⇒ 结果未知）', { fetchImpl: captureFetch({ ...OK_BODY, request_id: undefined }).fn }, { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' }],
    ['request_id 形态非法', { fetchImpl: captureFetch({ ...OK_BODY, request_id: 'x' }).fn }, { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' }],
    ['candidates 不是数组', { fetchImpl: captureFetch({ ...OK_BODY, candidates: 'nope' }).fn }, { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' }],
    ['candidates 超过 3 条', { fetchImpl: captureFetch({ ...OK_BODY, candidates: [1, 2, 3, 4] }).fn }, { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' }],
    ['branch 不在六类闭集内', { fetchImpl: captureFetch({ ...OK_BODY, branch: 'made_up_branch' }).fn }, { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' }],
  ];

  for (const [label, overrides, expected] of cases) {
    const provider = liveProvider(overrides);
    const outcome = await provider.recognize(RECOGNIZE_INPUT);
    assert.deepEqual(outcome, expected, label);
    // 负控制口径：永远不许落 succeeded，也永远不许出现闭集外的码。
    assert.notEqual(outcome.kind, 'succeeded', label);
    if (outcome.kind === 'failed') {
      assert.equal(PROVIDER_FAILURE_CODES.includes(outcome.code), true, `${label}：码必须属于既有四值闭集`);
      assert.equal(ERROR_CODES.includes(outcome.code), true, `${label}：码必须是契约 ErrorCode 闭集成员`);
    }
  }
});

test('A·分支与空候选：提供者上报分支 / 空候选都只能落 uncertain（绝不 succeeded）', async () => {
  // 空候选 = 正常调用但无结果 ⇒ 显式上报 `no_result` 分支。
  const empty = liveProvider({ fetchImpl: captureFetch({ request_id: REQUEST_ID, candidates: [] }).fn });
  assert.deepEqual(await empty.recognize(RECOGNIZE_INPUT), {
    kind: 'completed',
    candidates: [],
    uncertainty_reasons: undefined,
    branch: 'no_result',
  });

  // 提供者自述「覆盖外/低质量」⇒ 原样上报该分支（即使同时给了高分候选）。
  const branch = liveProvider({
    fetchImpl: captureFetch({ ...OK_BODY, branch: 'out_of_coverage_or_low_quality' }).fn,
  });
  const branched = await branch.recognize(RECOGNIZE_INPUT);
  assert.equal(branched.kind, 'completed');
  assert.equal(branched.branch, 'out_of_coverage_or_low_quality');

  // 有候选但无分数 ⇒ 不补造分数（decideOutcome 会判 uncertain；适配器不得替它决定）。
  const noScores = liveProvider({
    fetchImpl: captureFetch({
      request_id: REQUEST_ID,
      candidates: [{ species_id: 'synthetic_live_weed_a', rank: 1, model_score: null }],
      uncertainty_reasons: [],
    }).fn,
  });
  const scored = await noScores.recognize(RECOGNIZE_INPUT);
  assert.equal(scored.kind, 'completed');
  assert.equal(scored.candidates[0].model_score, null, '不得补造分数');
});

test('A·本地拒绝先于预留：取不到字节 / 非图片 / 超限 ⇒ 零发包、零预留', async () => {
  const cases = [
    ['取不到字节（端口返回 null）', null, 0],
    ['字节不是 PNG/JPEG', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 0],
    ['超过供应商字节上限', new Uint8Array(LIVE_RECOGNITION_FROZEN_PROFILE.maxImageBytes + 1), 0],
  ];
  for (const [label, bytes, expectedSends] of cases) {
    const fetched = captureFetch(OK_BODY);
    const gate = createProcessRecognitionGate({ authorization: RECOGNITION_GATE_AUTHORIZATION });
    const provider = liveProvider({ fetchImpl: fetched.fn, imageSource: staticSource(bytes), liveGate: gate });
    assert.deepEqual(await provider.recognize(RECOGNIZE_INPUT), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' }, label);
    assert.equal(fetched.calls.length, expectedSends, `${label}：不得发包`);
    assert.equal(gate.snapshot().entries.length, 0, `${label}：不得预留（本地拒绝先于预留）`);
  }
  // 字节来源自身抛错也按「取不到字节」处理（不把内部异常说成供应商故障）。
  const throwing = {
    kind: 'stub-source',
    note: 'throws',
    async read() {
      throw new Error('对象存储炸了');
    },
  };
  const fetched = captureFetch(OK_BODY);
  const provider = liveProvider({ fetchImpl: fetched.fn, imageSource: throwing });
  assert.deepEqual(await provider.recognize(RECOGNIZE_INPUT), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(fetched.calls.length, 0);
});

test('A·构造期 fail-closed：端点/剖面/凭据/授权串/字节端口任一不合法 ⇒ 拒绝构造（不降级成替身）', () => {
  const cases = [
    ['端点不是 https', { profile: { endpoint: 'http://recognition.invalid/v1' } }],
    ['端点内嵌凭据', { profile: { endpoint: 'https://user:pass@recognition.invalid/v1' } }],
    ['端点带查询串', { profile: { endpoint: 'https://recognition.invalid/v1?key=1' } }],
    ['端点带片段', { profile: { endpoint: 'https://recognition.invalid/v1#x' } }],
    ['端点不是 URL', { profile: { endpoint: 'not-a-url' } }],
    ['超时越界（过小）', { profile: { timeoutMs: 1 } }],
    ['超时越界（过大）', { profile: { timeoutMs: 60000 } }],
    ['超时不是整数', { profile: { timeoutMs: 1500.5 } }],
    ['maxRetries 不是 0', { profile: { maxRetries: 1 } }],
    ['字节上限不是冻结值', { profile: { maxImageBytes: 2097153 } }],
    ['传输方式不是 inlineBase64', { profile: { mediaTransport: 'url' } }],
    ['协议版本不符', { profile: { protocol: 'other-protocol' } }],
    ['缺 apiKey', { credentials: { apiKey: '   ' } }],
    ['缺授权串', { authorization: '   ' }],
    ['缺字节端口', { imageSource: { kind: 'x', note: 'x' } }],
  ];
  for (const [label, overrides] of cases) {
    assert.throws(() => liveProvider(overrides), /fail-closed|端口缺失|缺少/, label);
  }
  // `createLiveRecognitionProvider` 不接受 null 端口对象（结构性保证：零端口注入 ⇒ 构造不出真实分支）。
  assert.throws(() => createLiveRecognitionProvider(null), /端口缺失/);
});

test('A·闸门：授权串不一致 / 次数上限 / 同一次尝试重复 —— 三种拒绝都映射到既有闭集码', async () => {
  // ① 授权串不一致 ⇒ AUTHORIZATION_REQUIRED ⇒ PROVIDER_UNAVAILABLE（零发包）。
  const gateA = createProcessRecognitionGate({ authorization: RECOGNITION_GATE_AUTHORIZATION });
  const fetchedA = captureFetch(OK_BODY);
  const mismatched = liveProvider({
    fetchImpl: fetchedA.fn,
    liveGate: gateA,
    authorization: RECOGNITION_GATE_AUTHORIZATION,
  });
  // 让闸门认为适配器给的授权串不对：直接用另一串的闸门。
  const otherGate = createProcessRecognitionGate({ authorization: 'other-authorization' });
  const providerB = liveProvider({ fetchImpl: fetchedA.fn, liveGate: otherGate });
  assert.deepEqual(await providerB.recognize(RECOGNIZE_INPUT), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(fetchedA.calls.length, 0, '闸门拒绝 ⇒ 零发包');
  // 正控制：同一串的闸门放行（否则上面的红是「永远红」而不是「因为串不一致」）。
  assert.deepEqual((await mismatched.recognize(RECOGNIZE_INPUT)).kind, 'completed');
  assert.equal(fetchedA.calls.length, 1);

  // ② 次数上限 ⇒ BUDGET_OR_COUNT_EXCEEDED ⇒ PROVIDER_QUOTA_EXCEEDED。
  //    换一个 jobId（尝试键不同）才算「第二次调用」——同一尝试键会先撞上 ③ 的去重拒绝。
  const quotaGate = createProcessRecognitionGate({ authorization: RECOGNITION_GATE_AUTHORIZATION, maxCalls: 1 });
  const fetchedB = captureFetch(OK_BODY);
  const quotaProvider = liveProvider({ fetchImpl: fetchedB.fn, liveGate: quotaGate });
  assert.equal((await quotaProvider.recognize(RECOGNIZE_INPUT)).kind, 'completed');
  assert.deepEqual(
    await quotaProvider.recognize({ ...RECOGNIZE_INPUT, jobId: randomUUID() }),
    { kind: 'failed', code: 'PROVIDER_QUOTA_EXCEEDED' },
  );
  assert.equal(fetchedB.calls.length, 1, '超额那一次不得发包');

  // ③ 同一次尝试（jobId:mediaId#revision）第二次 ⇒ ATTEMPT_ALREADY_RESERVED ⇒ PROVIDER_OUTCOME_UNKNOWN（绝不重发）。
  const dedupeGate = createProcessRecognitionGate({ authorization: RECOGNITION_GATE_AUTHORIZATION });
  const fetchedC = captureFetch(OK_BODY);
  const dedupe = liveProvider({ fetchImpl: fetchedC.fn, liveGate: dedupeGate });
  assert.equal((await dedupe.recognize(RECOGNIZE_INPUT)).kind, 'completed');
  assert.deepEqual(await dedupe.recognize(RECOGNIZE_INPUT), { kind: 'failed', code: 'PROVIDER_OUTCOME_UNKNOWN' });
  assert.equal(fetchedC.calls.length, 1, '同一尝试绝不重发');

  // 闸门结算：无论成败都要落账（成功与失败各一条）。
  const snapshot = quotaGate.snapshot();
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].settled, true);
  assert.equal(snapshot.entries[0].state, 'BUSINESS_RESPONSE');
});

// ---------------------------------------------------------------- B. 字节端口（只读衍生件）

/** 假登记册：只实现本端口用到的 `getMedia`。 */
function fakeRegistry(records = new Map()) {
  const calls = [];
  return {
    calls,
    async getMedia(mediaId) {
      calls.push(mediaId);
      return records.get(mediaId) ?? null;
    },
  };
}

/** 假对象存储：记录每一次被读的键（用来证明「原件键一次都没读」）。 */
function fakeObjectStore(objects = {}) {
  const keys = [];
  return {
    kind: 'substitute',
    keys,
    async getObject(key) {
      keys.push(key);
      return objects[key] ?? null;
    },
  };
}

function weedRecord(overrides = {}) {
  return {
    id: MEDIA_ID,
    ownerId: 'owner-r70-recognition',
    revision: 1,
    purpose: 'weed_recognition',
    rawRef: RAW_KEY,
    derivativeRef: DERIVED_KEY,
    state: 'ready',
    ...overrides,
  };
}

test('B·正控制：只读去元数据衍生件；原件键一次都不读；字节逐字节返回', async () => {
  const registry = fakeRegistry(new Map([[MEDIA_ID, weedRecord()]]));
  const objectStore = fakeObjectStore({ [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } });
  const source = createObjectStoreRecognitionImageSource(() => ({ mediaRecords: registry, objectStore }));
  assert.equal(source.kind, 'wired');
  assert.equal(source.lastFailure(), null);

  const bytes = await source.read({ mediaId: MEDIA_ID, mediaRevision: 1, ownerUserId: 'owner-r70-recognition' });
  assert.deepEqual(bytes, PNG);
  assert.deepEqual(objectStore.keys, [DERIVED_KEY], '只允许读衍生件键');
  assert.equal(objectStore.keys.includes(RAW_KEY), false, '原件键（含 EXIF/GPS）一次都不许读');
  assert.equal(source.readAttempts, 1);
  assert.equal(source.lastFailure(), null);
});

test('B·失败矩阵：每条都返回 null、留下既有契约码、原因不含对象键', async () => {
  const cases = [
    ['记录不存在', { records: new Map() }, 'NOT_FOUND'],
    ['归属不是调用者（与不存在同形）', { record: { ownerId: 'someone-else' } }, 'NOT_FOUND'],
    ['版本已推进', { mediaRevision: 2 }, 'REVISION_CONFLICT'],
    ['未就绪', { record: { state: 'uploaded' } }, 'OBJECT_UNAVAILABLE'],
    ['跨用途（标签 OCR 图）', { record: { purpose: 'label_ocr' } }, 'OBJECT_UNAVAILABLE'],
    ['跨用途（社区图）', { record: { purpose: 'community_image' } }, 'OBJECT_UNAVAILABLE'],
    ['两键皆空', { record: { rawRef: null, derivativeRef: null } }, 'OBJECT_UNAVAILABLE'],
    ['只有含元数据原件', { record: { derivativeRef: null } }, 'OBJECT_UNAVAILABLE'],
    ['对象不存在', { objects: {} }, 'OBJECT_UNAVAILABLE'],
    ['对象字节为空', { objects: { [DERIVED_KEY]: { bytes: new Uint8Array(0), contentType: 'image/png' } } }, 'OBJECT_UNAVAILABLE'],
    ['Content-Type 不受支持（webp）', { objects: { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/webp' } } }, 'OBJECT_UNAVAILABLE'],
    ['Content-Type 缺失', { objects: { [DERIVED_KEY]: { bytes: PNG, contentType: '' } } }, 'OBJECT_UNAVAILABLE'],
  ];

  for (const [label, spec, expected] of cases) {
    const registry = fakeRegistry(spec.records ?? new Map([[MEDIA_ID, weedRecord(spec.record ?? {})]]));
    const objectStore = fakeObjectStore(spec.objects ?? { [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } });
    const source = createObjectStoreRecognitionImageSource(() => ({ mediaRecords: registry, objectStore }));
    const bytes = await source.read({ mediaId: MEDIA_ID, mediaRevision: spec.mediaRevision ?? 1, ownerUserId: 'owner-r70-recognition' });
    assert.equal(bytes, null, `${label}：必须返回 null（绝不返回空字节/替身图）`);
    assert.equal(source.lastFailure(), expected, `${label}：内部失败码`);
    assert.equal(RECOGNITION_IMAGE_FAILURE_CODES.includes(source.lastFailure()), true, `${label}：码必须在既有闭集内`);
    const reason = source.lastFailureReason();
    assert.equal(typeof reason, 'string', `${label}：原因必须可读`);
    assert.equal(reason.includes(DERIVED_KEY), false, `${label}：原因不得泄露对象键`);
    assert.equal(reason.includes(RAW_KEY), false, `${label}：原因不得泄露对象键`);
  }

  // 端口未配置（缺登记册 / 缺对象存储）与端口抛错：都 fail-closed。
  for (const [label, resolver] of [
    ['缺登记册', () => ({ objectStore: fakeObjectStore() })],
    ['缺对象存储', () => ({ mediaRecords: fakeRegistry() })],
    ['端口全缺', () => ({})],
    ['取值器返回 null', () => null],
    ['取值器抛错', () => { throw new Error('装配顺序错'); }],
  ]) {
    const source = createObjectStoreRecognitionImageSource(resolver);
    assert.equal(await source.read({ mediaId: MEDIA_ID, mediaRevision: 1 }), null, label);
    assert.equal(source.lastFailure(), 'PROVIDER_UNAVAILABLE', label);
  }
  const throwingStore = {
    kind: 'substitute',
    async getObject() {
      const error = new Error('未接线端口');
      error.code = 'PROVIDER_UNAVAILABLE';
      throw error;
    },
  };
  const source = createObjectStoreRecognitionImageSource(() => ({
    mediaRecords: fakeRegistry(new Map([[MEDIA_ID, weedRecord()]])),
    objectStore: throwingStore,
  }));
  assert.equal(await source.read({ mediaId: MEDIA_ID, mediaRevision: 1 }), null);
  assert.equal(source.lastFailure(), 'PROVIDER_UNAVAILABLE', '端口自带的码**原样保留**');
});

test('B·媒体引用端口：wired 分支把四个内部码收敛成三个契约码（且不泄露是端口还是对象）', async () => {
  const okPort = createObjectStoreRecognitionMediaPort(() => ({
    mediaRecords: fakeRegistry(new Map([[MEDIA_ID, weedRecord()]])),
    objectStore: fakeObjectStore({ [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } }),
  }));
  assert.equal(okPort.kind, 'wired');
  assert.deepEqual(await okPort.resolve({ ownerUserId: 'owner-r70-recognition', mediaId: MEDIA_ID, mediaRevision: 1 }), {
    ok: true,
    revision: 1,
  });

  const cases = [
    ['记录不存在', { records: new Map() }, 'NOT_FOUND'],
    ['版本不符', { mediaRevision: 3 }, 'REVISION_CONFLICT'],
    ['未接线对象存储', { objectStore: createUnwiredObjectStore() }, 'OBJECT_UNAVAILABLE'],
    ['只有原件', { record: { derivativeRef: null } }, 'OBJECT_UNAVAILABLE'],
    ['用途不符', { record: { purpose: 'label_ocr' } }, 'OBJECT_UNAVAILABLE'],
  ];
  for (const [label, spec, expected] of cases) {
    const port = createObjectStoreRecognitionMediaPort(() => ({
      mediaRecords: fakeRegistry(spec.records ?? new Map([[MEDIA_ID, weedRecord(spec.record ?? {})]])),
      objectStore: spec.objectStore ?? fakeObjectStore({ [DERIVED_KEY]: { bytes: PNG, contentType: 'image/png' } }),
    }));
    assert.deepEqual(
      await port.resolve({ ownerUserId: 'owner-r70-recognition', mediaId: MEDIA_ID, mediaRevision: spec.mediaRevision ?? 1 }),
      { ok: false, code: expected },
      label,
    );
  }

  // 兼容：不给端口取值器 ⇒ 与接线前逐字相同（unwired + 同一段 note + 恒 OBJECT_UNAVAILABLE）。
  for (const mode of ['real', 'stub', 'preset_demo']) {
    const legacy = createRecognitionMediaPort(mode);
    assert.equal(legacy.kind, mode === 'real' ? 'unwired' : 'substitute', `${mode}：缺省分支不变`);
    if (mode === 'real') {
      assert.equal(legacy.note, createUnwiredMediaPort().note, 'real 缺省 note 必须逐字不变');
      assert.deepEqual(await legacy.resolve({ ownerUserId: 'u', mediaId: MEDIA_ID, mediaRevision: 1 }), {
        ok: false,
        code: 'OBJECT_UNAVAILABLE',
      });
    }
  }
});

// ---------------------------------------------------------------- C. 零外呼绊线

test('C·零外呼：不给适配器 / 缺字节 / 闸门拒绝 ⇒ globalThis.fetch 一次都不触发', async () => {
  const tripwire = tripwireFetch();
  try {
    // ① 缺凭据：`real` 的既有 fail-closed 形态（等价性见 D）。
    const bare = createRecognitionProvider({ executionMode: 'real' });
    assert.equal(bare.available, false);
    assert.deepEqual(await bare.recognize(RECOGNIZE_INPUT), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });

    // ② 凭据齐备但**没有**字节端口 ⇒ 适配器能装配，但一个字节都拿不到。
    const noBytes = createRecognitionProvider({ executionMode: 'real', endpoint: ENDPOINT, apiKey: API_KEY });
    assert.equal(noBytes.available, true, '凭据齐备 ⇒ 可用（字节缺失不是「不可用」，是「取不到字节」）');
    assert.deepEqual(await noBytes.recognize(RECOGNIZE_INPUT), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });

    // ③ 给了字节端口但端口未配置（缺对象存储）。
    const unwiredSource = createObjectStoreRecognitionImageSource(() => ({ mediaRecords: fakeRegistry() }));
    const partial = createRecognitionProvider({
      executionMode: 'real',
      endpoint: ENDPOINT,
      apiKey: API_KEY,
      imageSource: unwiredSource,
    });
    assert.deepEqual(await partial.recognize(RECOGNIZE_INPUT), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });

    // ④ 装配失败（端点不是 https）⇒ 回落 fail-closed，**绝不**回退替身。
    const broken = createRecognitionProvider({ executionMode: 'real', endpoint: 'http://insecure.invalid', apiKey: API_KEY });
    assert.equal(broken.executionMode, 'real');
    assert.equal(broken.available, false);
    assert.equal(broken.modelVersion, 'real-unconfigured');
    assert.match(broken.unavailableReason, /装配失败/);
    assert.deepEqual(await broken.recognize(RECOGNIZE_INPUT), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
  } finally {
    tripwire.restore();
  }
  assert.equal(tripwire.state.calls, 0, '以上全部路径必须零请求');
});

// ---------------------------------------------------------------- D. 等价性（改前逐字段相同）

test('D·等价性：不满足真实条件时，行为与改前逐字段相同（`failed PROVIDER_UNAVAILABLE`、零发包）', async () => {
  const before = createRealRecognitionProvider(); // 改前的实现（本函数在 GY-R70 里只增加了一个可选参数）
  const now = createRecognitionProvider({ executionMode: 'real' });
  for (const field of ['executionMode', 'modelVersion', 'available', 'unavailableReason']) {
    assert.equal(now[field], before[field], `${field} 必须逐字段相同`);
  }
  assert.equal(now.executionMode, 'real');
  assert.equal(now.modelVersion, 'real-unconfigured');
  assert.equal(now.available, false);
  assert.equal(now.unavailableReason, '缺少真实识别供应商凭据（fail-closed，不回退替身）');
  assert.deepEqual(await now.recognize(RECOGNIZE_INPUT), await before.recognize(RECOGNIZE_INPUT));

  // 显式 null / 空串与缺省同义（不把 "空" 当成「配好了」）。
  const nullish = createRecognitionProvider({ executionMode: 'real', endpoint: '  ', apiKey: '' });
  assert.equal(nullish.available, false);
  assert.equal(nullish.unavailableReason, '缺少真实识别供应商凭据（fail-closed，不回退替身）');

  // 非 real 分支逐字未变（仍是不带真实适配器的替身）。
  for (const mode of ['stub', 'preset_demo']) {
    assert.equal(createRecognitionProvider({ executionMode: mode }).modelVersion, createStubRecognitionProvider({ executionMode: mode }).modelVersion);
  }

  // 源码钉子：`real` 的三段式解析顺序（缺凭据 → 试装配 → 回落）在装配函数里逐字可见。
  const providerSource = readRepoText('services/api/src/recognitions/provider.ts');
  assert.equal(
    providerSource.includes('imageSource: input.imageSource ?? createUnwiredRecognitionImageSource('),
    true,
    '缺字节端口时必须仍用写死的未接线来源（不是替身、不产字节）',
  );
  assert.equal(
    providerSource.includes('return createStubRecognitionProvider({ executionMode: input.executionMode });'),
    true,
    '替身只允许出现在非 real 分支',
  );
});

// ---------------------------------------------------------------- E. 失败序（产品装配，逐条实测）

/** `loadConfig` 的 real 模式必填项（全部合成占位，不连任何真实资源、不打印任何真实凭据）。 */
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

/**
 * 跑一段用例，并把两个 ambient env 键**显式**置为给定值（缺省=删除）。
 * 结束**必定**恢复原值：本文件不依赖任何未清理的环境变量（测试纪律）。
 */
async function withRecognitionEnv(env, run) {
  const keys = ['RECOGNITION_PROVIDER_URL', 'RECOGNITION_PROVIDER_KEY'];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    return await run();
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 直接签一份会话（不发登录请求、不外呼）。 */
async function seedSession(store, label = 'r70') {
  const user = await store.createUser(`${label}-${randomUUID().replace(/-/g, '')}`);
  const token = mintOpaqueToken();
  await store.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3_600_000),
    audience: 'user',
  });
  return { token, user };
}

function makeApp(options = {}) {
  const config = { ...loadConfig(REAL_ENV), executionMode: 'real' };
  return buildApp({ config, ...options });
}

async function postRecognition(app, token, mediaId, revision = 1) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/recognitions',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    payload: { media_id: mediaId, media_revision: revision },
  });
  let body = null;
  try {
    body = response.json();
  } catch {
    body = null;
  }
  return { status: response.statusCode, body };
}

test('E·失败序①：real 且无凭据 ⇒ POST 503 PROVIDER_UNAVAILABLE，零发包', async (t) => {
  await withRecognitionEnv({}, async () => {
    const authStore = createMemoryAuthStore();
    const app = makeApp({ store: authStore });
    t.after(() => app.close());
    const { token } = await seedSession(authStore);
    const tripwire = tripwireFetch();
    try {
      const r = await postRecognition(app, token, MEDIA_ID);
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(r.body.error.message, '缺少真实识别供应商凭据（fail-closed，不回退替身）');
      assert.equal(r.body.error.retryable, false);
      const described = app.recognitionService.describe();
      assert.equal(described.providerAvailable, false);
      assert.equal(described.modelVersion, 'real-unconfigured');
    } finally {
      assert.equal(tripwire.state.calls, 0, '无凭据时必须零请求');
      tripwire.restore();
    }
  });
});

test('E·失败序②：有凭据但字节端口未接线（对象存储 unwired）⇒ POST 409 OBJECT_UNAVAILABLE，零发包', async (t) => {
  await withRecognitionEnv({ RECOGNITION_PROVIDER_URL: ENDPOINT, RECOGNITION_PROVIDER_KEY: API_KEY }, async () => {
    const authStore = createMemoryAuthStore();
    const mediaStore = createMemoryMediaStore();
    const { user, token } = await seedSession(authStore);
    await mediaStore.createMedia({
      id: MEDIA_ID,
      ownerId: user.id,
      revision: 1,
      purpose: 'weed_recognition',
      mime: 'image/png',
      bytes: PNG.length,
      duration_ms: null,
      sha256: 'a'.repeat(64),
      state: 'ready',
      failure_code: null,
      rawRef: RAW_KEY,
      derivativeRef: DERIVED_KEY,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });
    // 产品默认装配：`real` ⇒ `resolveMediaObjectStore()` 拿到的是**未接线**对象存储。
    const app = makeApp({ store: authStore, mediaStore });
    t.after(() => app.close());
    const tripwire = tripwireFetch();
    try {
      assert.equal(app.mediaObjectStore.kind, 'unwired', '本用例的前提：对象存储确实未接线');
      const described = app.recognitionService.describe();
      assert.equal(described.providerAvailable, true, '凭据齐备 ⇒ 供应商可用（这一条是本片新读出来的）');
      assert.equal(described.mediaPort, 'wired', '媒体引用端口已接媒体域（取值器晚绑定）');

      const r = await postRecognition(app, token, MEDIA_ID);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.error.code, 'OBJECT_UNAVAILABLE');
      assert.equal(r.body.error.retryable, false);
    } finally {
      assert.equal(tripwire.state.calls, 0, '字节端口未接线时不得发包');
      tripwire.restore();
    }
  });
});

// ---------------------------------------------------------------- F. 两者齐备才发包（全链路，假 fetch）

test('F·两者齐备 ⇒ 受理 202、任务落 succeeded、恰好一次发送、请求体是衍生件字节', async (t) => {
  await withRecognitionEnv({ RECOGNITION_PROVIDER_URL: ENDPOINT, RECOGNITION_PROVIDER_KEY: API_KEY }, async () => {
    const authStore = createMemoryAuthStore();
    const mediaStore = createMemoryMediaStore();
    const objectStore = createSubstituteObjectStore();
    await objectStore.putObject(DERIVED_KEY, PNG, 'image/png');
    // 原件键**故意也放一份不同字节**：若有人回退读原件，请求体就会变（负控制 ③ 的判据）。
    await objectStore.putObject(RAW_KEY, new Uint8Array([9, 9, 9, 9]), 'image/png');

    const { user, token } = await seedSession(authStore);
    await mediaStore.createMedia({
      id: MEDIA_ID,
      ownerId: user.id,
      revision: 1,
      purpose: 'weed_recognition',
      mime: 'image/png',
      bytes: PNG.length,
      duration_ms: null,
      sha256: 'a'.repeat(64),
      state: 'ready',
      failure_code: null,
      rawRef: RAW_KEY,
      derivativeRef: DERIVED_KEY,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    });

    // ⚠ 顺序是硬要求：适配器在**构造期**捕获 `globalThis.fetch`，而它由 `buildApp` 构造 ⇒ 捕获型 fetch 必须**先**装好。
    const fetched = captureFetch(OK_BODY);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetched.fn;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    const app = makeApp({ store: authStore, mediaStore, mediaObjectStore: objectStore });
    t.after(() => app.close());

    const r = await postRecognition(app, token, MEDIA_ID);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const jobId = r.body.data.id;
    assert.equal(typeof jobId, 'string');

    await app.recognitionService.settle();
    const job = await app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(job.statusCode, 200, job.body);
    assert.equal(job.json().data.state, 'succeeded', '三条高分候选 ⇒ decideOutcome 判 succeeded');

    assert.equal(fetched.calls.length, 1, '恰好一次发送（受理时的字节校验不走 fetch）');
    const sent = JSON.parse(fetched.calls[0].init.body);
    assert.deepEqual(new Uint8Array(Buffer.from(sent.media.bytes_base64, 'base64')), PNG, '发出去的必须是衍生件字节');
    assert.equal(Buffer.from(sent.media.bytes_base64, 'base64').equals(Buffer.from([9, 9, 9, 9])), false, '绝不是原件字节');

    // 识别记录里的 model_version 如实是**协议版本**（本基线没有已审厂商模型）。
    const recognitionId = job.json().data.recognition_id;
    if (typeof recognitionId === 'string') {
      const rec = await app.inject({
        method: 'GET',
        url: `/api/v1/recognitions/${recognitionId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(rec.statusCode, 200, rec.body);
      assert.equal(rec.json().data.model_version, LIVE_RECOGNITION_FROZEN_PROFILE.protocol);
    }
  });
});

// ---------------------------------------------------------------- G. 装配结构 + 口径对齐

test('G·装配结构：app.ts 只转发既有媒体端口；源码自证不读 env / 不碰磁盘', () => {
  const appSource = readRepoText('services/api/src/app.ts');
  assert.match(
    appSource,
    /const recognitionMediaPorts = \(\) => \(\{ objectStore: mediaObjectStore, mediaRecords: mediaStore \}\);/,
    'app.ts 必须把既有的 mediaStore + mediaObjectStore 以取值器形式转发（与语音/OCR 两条转发行同形）',
  );
  assert.equal(
    appSource.includes('media: recognitionMedia ?? createRecognitionMediaPort(config.executionMode, recognitionMediaPorts),'),
    true,
    '识别域的媒体端口必须用同一份取值器（与 provider 的字节来源同一批实例）',
  );
  assert.equal(
    appSource.includes("endpoint: process.env['RECOGNITION_PROVIDER_URL'] ?? null,"),
    true,
    '凭据仍按既有方式从这两个 env 读（本片**未**把识别配置收进 config.ts，见证据页 §10）',
  );
  assert.equal(
    appSource.includes("apiKey: process.env['RECOGNITION_PROVIDER_KEY'] ?? null,"),
    true,
    '凭据仍按既有方式从这两个 env 读',
  );

  // 适配器与字节来源都不得自己读 ambient env / 磁盘（字节与凭据只从注入端口来）。
  for (const relative of ['services/api/src/recognitions/live-adapter.ts', 'services/api/src/recognitions/image-source.ts']) {
    const source = readRepoText(relative);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(code.includes('process.env'), false, `${relative}：不得读 ambient env`);
    assert.equal(code.includes('node:fs'), false, `${relative}：不得碰文件系统`);
    assert.equal(code.includes('process.cwd'), false, `${relative}：不得按工作目录推断路径`);
  }
  const imageSource = readRepoText('services/api/src/recognitions/image-source.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(imageSource.includes('fetch('), false, '字节来源本身不得发包（只有适配器发）');
  assert.equal(imageSource.includes('rawRef'), true, 'rawRef 只允许出现在**诊断**分支里（且不得被取值）');

  // 失败码/用途/类型与既有口径逐条对齐（两处漂移即红）。
  assert.deepEqual([...RECOGNITION_IMAGE_FAILURE_CODES].sort(), ['NOT_FOUND', 'OBJECT_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'REVISION_CONFLICT']);
  for (const code of RECOGNITION_IMAGE_FAILURE_CODES) {
    assert.equal(ERROR_CODES.includes(code), true, `内部码 ${code} 必须仍是契约 ErrorCode 闭集成员`);
  }
  for (const code of PROVIDER_FAILURE_CODES) {
    assert.equal(ERROR_CODES.includes(code), true, `提供者码 ${code} 必须仍是契约 ErrorCode 闭集成员`);
  }
  assert.equal(MEDIA_PURPOSES.includes(RECOGNITION_IMAGE_PURPOSES[0]), true, '用途必须来自媒体域闭集');
  assert.equal(MEDIA_PURPOSE_KIND[RECOGNITION_IMAGE_PURPOSES[0]], 'image');
  const allowed = MEDIA_PURPOSE_MIME[RECOGNITION_IMAGE_PURPOSES[0]];
  for (const type of RECOGNITION_IMAGE_CONTENT_TYPES) {
    assert.equal(allowed.includes(type), true, `${type} 必须是 weed_recognition 的合法上传类型`);
  }
  assert.equal(
    allowed.includes('image/webp') && !RECOGNITION_IMAGE_CONTENT_TYPES.includes('image/webp'),
    true,
    'webp 上传合法但适配器不吃 ⇒ 必须如实收窄（不是漏配）',
  );
  // 字节上限与媒体域口径一致（2 MiB）。
  assert.equal(LIVE_RECOGNITION_FROZEN_PROFILE.maxImageBytes, 2 * 1024 * 1024);
  // 头部校验只认 PNG/JPEG（与收窄后的类型集合同集合）。
  assert.deepEqual(requireLiveRecognitionImage(PNG, 2 * 1024 * 1024), PNG);
  assert.throws(() => requireLiveRecognitionImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]), 64), /PNG\/JPEG/);
});
