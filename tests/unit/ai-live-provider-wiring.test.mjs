/**
 * GY-R28-W1 第二步 · TTS / OCR / ASR 真实提供者**装配接线**的离线回归。
 *
 * 覆盖两条链路，互不冒充：
 *  A. **产品装配链**：`create{Tts,Ocr,Speech}Provider({ executionMode:'real', aiProviders:<被校验快照> })`
 *     ⇒ 提供者 `available === true` 且走真实适配器；`aiProviders` 缺省/`null` ⇒ 与接线前逐字节相同。
 *     OCR/ASR 的产品链注入的是**未接线**的字节来源（对象存储属媒体域）⇒ 取不到字节时
 *     `failed PROVIDER_UNAVAILABLE`，**零发包**（`globalThis.fetch` 换成绊线，全程不触发）。
 *  B. **适配器链**：`createLiveOcrProvider` / `createLiveSpeechProvider` 注入假 `fetchImpl`
 *     ⇒ 证明 build→reserve→sign→send(恰好一次)→settle 的顺序、端点断言、零重试、
 *     错误码闭集映射、证据不足即「结果未知」，以及「本地拒绝先于预留」（不占预算、不留账）。
 *
 * **全离线**：不读凭据文件、不联网、不写任何台账；凭据与响应体都是合成占位串。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import {
  createLiveOcrProvider,
  createLiveOcrProviderFromConfig,
  createUnwiredImageSource,
  labelFieldsFromDetections,
  requireLiveOcrImage,
} from '../../services/api/src/ai/ocr-live-adapter.ts';
import {
  createLiveSpeechProvider,
  createLiveSpeechProviderFromConfig,
  createUnwiredAudioSource,
  requireLiveAsrWav,
} from '../../services/api/src/ai/asr-live-adapter.ts';
import { OcrLocalInputError, OcrWiringError } from '../../services/api/src/ai/ocr-live-ports.ts';
import { AsrLocalInputError, AsrWiringError } from '../../services/api/src/ai/asr-live-ports.ts';
import { createProcessLiveGate, PRODUCT_GATE_AUTHORIZATION } from '../../services/api/src/ai/live-gate.ts';
import { LiveGateRefusedError } from '../../services/api/src/tts/live-ports.ts';
import {
  createLiveTtsProviderFromConfig,
  createTtsProvider,
} from '../../services/api/src/tts/provider.ts';
import { createOcrProvider } from '../../services/api/src/ocr/provider.ts';
import { createSpeechProvider } from '../../services/api/src/speech/provider.ts';
import { loadConfig } from '../../services/api/src/config.ts';

// ---------------------------------------------------------------- 合成夹具

const SHARED_ID = 'synthetic-shared-secret-id-r28w1';
const SHARED_KEY = 'synthetic-shared-secret-key-r28w1';
const ASR_ID = 'synthetic-asr-secret-id-r28w1';
const ASR_KEY = 'synthetic-asr-secret-key-r28w1';

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

/** 三域凭据齐备的**被校验快照**（经 `loadConfig` 得到，不是手搓对象）。 */
const CONFIGURED = loadConfig({
  ...REAL_ENV,
  LOG_LEVEL: 'silent',
  TENCENTCLOUD_SECRET_ID: SHARED_ID,
  TENCENTCLOUD_SECRET_KEY: SHARED_KEY,
  TENCENTCLOUD_ASR_SECRET_ID: ASR_ID,
  TENCENTCLOUD_ASR_SECRET_KEY: ASR_KEY,
}).aiProviders;

const REQUEST_ID = '01234567-89ab-cdef-0123-456789abcdef';
const JOB_ID = '11111111-2222-4333-8444-555555555555';
const MEDIA_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** 最小合法 PNG 头（8 字节签名 + IHDR 长度 + 'IHDR' + 宽 + 高），24 字节。 */
const PNG = (() => {
  const buffer = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(2, 16);
  buffer.writeUInt32BE(2, 20);
  return new Uint8Array(buffer);
})();

/** 16kHz / 单声道 / 16bit PCM 的合成 WAV（时长可控，无任何真人录音）。 */
function syntheticWav(seconds = 0.5) {
  const samples = Math.round(16000 * seconds);
  const dataLength = samples * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLength, 40);
  return new Uint8Array(buffer);
}

function fixedSource(bytes) {
  return { kind: 'wired', note: 'synthetic fixture', async read() { return bytes; } };
}

function fakeGate(options = {}) {
  const state = { reserves: 0, settles: 0, outcomes: [], tickets: [] };
  return {
    state,
    gate: {
      async reserve(input) {
        state.reserves += 1;
        if (options.refuse) throw new LiveGateRefusedError(options.refuse, 'synthetic gate refusal');
        const ticket = { capability: input.capability, authorization: input.authorization, reservedCny: 0.5, attemptKey: input.attemptKey };
        state.tickets.push(ticket);
        return ticket;
      },
      async settle(ticket, outcome) {
        state.settles += 1;
        state.outcomes.push({ ticket, outcome });
      },
    },
  };
}

function fakeFetch(responder) {
  const state = { calls: 0, urls: [], inits: [], bodies: [] };
  return {
    state,
    fn: async (url, init) => {
      state.calls += 1;
      state.urls.push(url);
      state.inits.push(init);
      state.bodies.push(init?.body);
      return responder(url, init, state.calls);
    },
  };
}

const okResponse = (Response) => ({ ok: true, status: 200, json: async () => ({ Response }) });

const OCR_PROFILE = {
  endpoint: 'https://ocr.tencentcloudapi.com',
  action: 'GeneralAccurateOCR',
  apiVersion: '2018-11-19',
  region: 'ap-shanghai',
  timeoutMs: 8000,
  maxRetries: 0,
  maxImageBytes: 2097152,
  mediaTransport: 'inlineBase64',
};
const ASR_PROFILE = {
  endpoint: 'https://asr.tencentcloudapi.com',
  action: 'SentenceRecognition',
  apiVersion: '2019-06-14',
  region: 'ap-shanghai',
  timeoutMs: 8000,
  maxRetries: 0,
  model: '16k_zh',
  voiceFormat: 'wav',
  sampleRate: 16000,
  channels: 1,
  maxAudioSeconds: 60,
  maxAudioBase64Bytes: 3145728,
};

/** 绊线：产品装配链的任何一次真实外呼都会让它变红。 */
function tripwireFetch() {
  const state = { calls: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    state.calls += 1;
    throw new Error('TRIPWIRE_NETWORK_CALL');
  };
  return { state, restore() { globalThis.fetch = original; } };
}

// ---------------------------------------------------------------- A. 产品装配链

test('产品链·TTS：有被校验快照 ⇒ 真实适配器可用（真发走注入 fetch 时逐条对账）', async () => {
  assert.notEqual(CONFIGURED.tts, null);
  const provider = createTtsProvider({ executionMode: 'real', aiProviders: CONFIGURED.tts });
  assert.equal(provider.available, true);
  assert.equal(provider.executionMode, 'real');
  assert.equal(provider.providerVersion.startsWith('tencent-tts-'), true, provider.providerVersion);
  assert.equal(provider.unavailableReason, null);

  // 产品工厂仍可用同一条装配路径把 fetch 换掉（`FromConfig` 是它内部调用的那一层）。
  const fetched = fakeFetch((url, init) =>
    okResponse({ RequestId: REQUEST_ID, SessionId: JSON.parse(init.body).SessionId, Audio: Buffer.from('49443304000000000000', 'hex').toString('base64') }),
  );
  const wired = createLiveTtsProviderFromConfig(CONFIGURED.tts, { authorization: PRODUCT_GATE_AUTHORIZATION, fetchImpl: fetched.fn });
  const result = await wired.synthesize({ jobId: JOB_ID, text: '你好，这是语音测试。', locale: 'zh-CN', targetRef: { type: 'answer', id: 'a1', revision: 1 } });
  assert.equal(result.kind, 'completed');
  assert.equal(result.artifact.contentType, 'audio/mpeg');
  assert.equal(result.artifact.substitute, false);
  assert.equal(fetched.state.calls, 1);
  assert.equal(fetched.state.urls[0], 'https://tts.tencentcloudapi.com');
  assert.equal(fetched.state.inits[0].redirect, 'manual');
  assert.equal(JSON.parse(fetched.state.bodies[0]).VoiceType, 101001);
});

test('产品链·TTS：不给快照 ⇒ 与接线前逐字节相同（real-unconfigured，synthesize 仍 PROVIDER_UNAVAILABLE）', async () => {
  const provider = createTtsProvider({ executionMode: 'real' });
  assert.equal(provider.available, false);
  assert.equal(provider.providerVersion, 'real-unconfigured');
  assert.deepEqual(await provider.synthesize({ jobId: JOB_ID, text: 'x', locale: 'zh-CN', targetRef: { type: 'answer', id: 'a1', revision: 1 } }), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
  // `stub`/`preset_demo` 即使给了快照也无视（不携带真实凭据）。
  for (const mode of ['stub', 'preset_demo']) {
    const stub = createTtsProvider({ executionMode: mode, aiProviders: CONFIGURED.tts });
    assert.equal(stub.providerVersion, mode === 'stub' ? 'stub-tts-v1' : 'preset-demo-tts-v1', mode);
    assert.equal(stub.available, true);
  }
});

test('产品链·OCR/ASR：有快照 ⇒ 真实适配器可用，但字节来源未接线 ⇒ 零发包、failed PROVIDER_UNAVAILABLE', async () => {
  const tripwire = tripwireFetch();
  try {
    assert.notEqual(CONFIGURED.ocr, null);
    assert.notEqual(CONFIGURED.asr, null);
    const ocr = createOcrProvider({ executionMode: 'real', aiProviders: CONFIGURED.ocr });
    assert.equal(ocr.available, true);
    assert.equal(ocr.unavailableReason, null);
    assert.equal(ocr.modelVersion.startsWith('tencent-generalaccurateocr-'), true);
    assert.deepEqual(await ocr.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });

    const speech = createSpeechProvider({ executionMode: 'real', aiProviders: CONFIGURED.asr });
    assert.equal(speech.available, true);
    assert.equal(speech.modelVersion.startsWith('tencent-sentencerecognition-'), true);
    assert.deepEqual(await speech.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });

    assert.equal(tripwire.state.calls, 0, '取不到字节时绝不允许发出任何请求');
  } finally {
    tripwire.restore();
  }
});

test('产品链·OCR/ASR：不给快照 ⇒ 与接线前逐字节相同（real-unconfigured / 受理前不可用）', async () => {
  const ocr = createOcrProvider({ executionMode: 'real' });
  assert.equal(ocr.available, false);
  assert.equal(ocr.modelVersion, 'real-unconfigured');
  assert.deepEqual(await ocr.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });

  const speech = createSpeechProvider({ executionMode: 'real' });
  assert.equal(speech.available, false);
  assert.equal(speech.modelVersion, 'real-unconfigured');
  assert.deepEqual(await speech.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
});

test('产品链·网关拒绝：授权串不一致的闸门一律 AUTHORIZATION_REQUIRED ⇒ PROVIDER_UNAVAILABLE，零发包', async () => {
  const fetched = fakeFetch(() => okResponse({}));
  const gate = createProcessLiveGate({ authorization: 'some-other-deployment' });
  const provider = createLiveOcrProviderFromConfig(CONFIGURED.ocr, {
    authorization: PRODUCT_GATE_AUTHORIZATION,
    liveGate: gate,
    fetchImpl: fetched.fn,
    imageSource: fixedSource(PNG),
  });
  assert.deepEqual(await provider.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
  assert.equal(fetched.state.calls, 0);
});

// ---------------------------------------------------------------- B. OCR 适配器链

test('OCR 适配器·正控制：build→reserve→sign→send(恰好一次)→settle，字段保守映射且不回显正文', async () => {
  const gateBag = fakeGate();
  const observations = [];
  const detections = ['农药登记证号：PD20210001', '农药名称：合成示例草甘膦水剂', '有效成分：草甘膦 41%', '剂型：水剂'];
  const fetched = fakeFetch(() => okResponse({ RequestId: REQUEST_ID, TextDetections: detections.map((text) => ({ DetectedText: text, Confidence: 99 })) }));
  const provider = createLiveOcrProvider({
    liveGate: gateBag.gate,
    authorization: 'gy-r28-w1-offline-test',
    profile: OCR_PROFILE,
    credentials: { secretId: SHARED_ID, secretKey: SHARED_KEY, sessionToken: '' },
    imageSource: fixedSource(PNG),
    fetchImpl: fetched.fn,
    now: () => 1_700_000_000_000,
    onObservation: (observation) => observations.push(observation),
  });
  assert.equal(provider.available, true);
  const outcome = await provider.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 3 });
  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(outcome.fields, {
    registration_number: 'PD20210001',
    name: '合成示例草甘膦水剂',
    ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
    dosage_form: '水剂',
  });
  assert.equal(fetched.state.calls, 1, '恰好发送一次');
  assert.equal(fetched.state.urls[0], 'https://ocr.tencentcloudapi.com');
  assert.equal(fetched.state.inits[0].method, 'POST');
  assert.equal(fetched.state.inits[0].redirect, 'manual');
  assert.equal(fetched.state.inits[0].headers['X-TC-Action'], 'GeneralAccurateOCR');
  assert.equal(fetched.state.inits[0].headers['X-TC-Region'], 'ap-shanghai');
  assert.equal(fetched.state.inits[0].signal instanceof AbortSignal, true);
  assert.equal(typeof fetched.state.bodies[0], 'string', 'body 必须是已序列化字符串');
  assert.deepEqual(Object.keys(JSON.parse(fetched.state.bodies[0])), ['ImageBase64']);
  assert.equal(gateBag.state.reserves, 1);
  assert.equal(gateBag.state.settles, 1, 'settle 必须被调用');
  assert.equal(gateBag.state.outcomes[0].outcome.state, 'BUSINESS_RESPONSE');
  assert.equal(gateBag.state.outcomes[0].outcome.actualChargeCny, null, '未取得账单必须落 null');

  // 观测只含安全字段：不含凭据、不含检出正文。
  const serialized = JSON.stringify(observations[0]);
  for (const secret of [SHARED_ID, SHARED_KEY]) assert.equal(serialized.includes(secret), false);
  for (const line of detections) assert.equal(serialized.includes(line), false, '观测不得回显识别正文');
  assert.equal(observations[0].detectionCount, 4);
  assert.equal(observations[0].imageBytes, PNG.length);
  assert.equal(observations[0].sendAttempts, 1);
  assert.equal(observations[0].endpointAsserted, true);

  // 签名绑定实际发出的字节：独立复算 TC3 签名并逐字比对。
  const timestamp = 1_700_000_000;
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
  const scope = `2023-11-14/ocr/tc3_request`;
  const canonical = `POST\n/\n\ncontent-type:application/json\nhost:ocr.tencentcloudapi.com\n\ncontent-type;host\n${sha(fetched.state.bodies[0])}`;
  const signature = createHmac('sha256', hmac(hmac(hmac(`TC3${SHARED_KEY}`, '2023-11-14'), 'ocr'), 'tc3_request'))
    .update(`TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha(canonical)}`)
    .digest('hex');
  assert.equal(
    fetched.state.inits[0].headers.Authorization,
    `TC3-HMAC-SHA256 Credential=${SHARED_ID}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
  );
});

test('OCR 适配器·剂型闭集：长名优先，短名不得吞掉完整剂型（监工 1021-1806 [P2] 回归）', () => {
  // 回归边界：「悬浮剂」是这三个独立剂型的子串、「粉剂」是「可湿性粉剂」的子串。
  // 按字面顺序 `includes` 首命中会把它们改写成短名（reviewed_sha=5633cd1c / d5f4c2aa 的实测）。
  for (const form of ['微囊悬浮剂', '种子处理悬浮剂', '油悬浮剂', '可湿性粉剂']) {
    assert.equal(labelFieldsFromDetections([`剂型：${form}`]).dosage_form, form, `${form} 不得被改写成短名`);
    assert.equal(labelFieldsFromDetections([`剂型：${form}`, `剂型：${form}`]).dosage_form, form, `${form} 重复出现仍取完整名`);
  }
  // 正常提取：短名自身仍能取到。
  for (const form of ['悬浮剂', '粉剂', '水剂', '乳油', '悬乳剂']) {
    assert.equal(labelFieldsFromDetections([`剂型：${form}`]).dosage_form, form, `${form} 应原样取到`);
  }
  // 与其它字段同批出现时，剂型取完整名、其余字段不受影响。
  assert.deepEqual(
    labelFieldsFromDetections([
      '农药登记证号：PD20210002',
      '农药名称：合成示例微囊悬浮剂',
      '有效成分：高效氯氟氰菊酯 25%',
      '剂型：微囊悬浮剂',
    ]),
    {
      registration_number: 'PD20210002',
      name: '合成示例微囊悬浮剂',
      ingredients: [{ name: '高效氯氟氰菊酯', content_text: '25', unit_text: '%' }],
      dosage_form: '微囊悬浮剂',
    },
  );
  // 不确定就留空：两个互不覆盖的独立剂型 ⇒ 保留缺项，不改写成其中任一个。
  assert.equal(labelFieldsFromDetections(['剂型：悬浮剂', '备注：原为微囊悬浮剂']).dosage_form, null);
  // 闭集外不猜（与修复前一致）。
  assert.equal(labelFieldsFromDetections(['与剂型无关的一行字']).dosage_form, null);
});

test('OCR 适配器·本地拒绝先于预留：取不到字节 / 图片超上限 / 头部非法 ⇒ 未发包、不占预算', async () => {
  for (const [label, source] of [
    ['未接线来源（null）', createUnwiredImageSource('synthetic')],
    ['空字节', fixedSource(new Uint8Array(0))],
    ['不是 PNG/JPEG', fixedSource(new Uint8Array([1, 2, 3, 4]))],
    ['超过 2MiB', fixedSource(new Uint8Array(OCR_PROFILE.maxImageBytes + 1))],
  ]) {
    const gateBag = fakeGate();
    const fetched = fakeFetch(() => okResponse({}));
    const provider = createLiveOcrProvider({
      liveGate: gateBag.gate,
      authorization: 'gy-r28-w1-offline-test',
      profile: OCR_PROFILE,
      credentials: { secretId: SHARED_ID, secretKey: SHARED_KEY, sessionToken: '' },
      imageSource: source,
      fetchImpl: fetched.fn,
    });
    assert.deepEqual(await provider.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' }, label);
    assert.equal(gateBag.state.reserves, 0, `${label}：不得预留`);
    assert.equal(fetched.state.calls, 0, `${label}：不得发包`);
  }
  assert.throws(() => requireLiveOcrImage(new Uint8Array(3), 10), (error) => error instanceof OcrLocalInputError);
});

test('OCR 适配器·闸门拒绝映射到契约闭集，且不发包、不落账', async () => {
  const cases = [
    ['AUTHORIZATION_REQUIRED', 'PROVIDER_UNAVAILABLE'],
    ['LEDGER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE'],
    ['BUDGET_OR_COUNT_EXCEEDED', 'PROVIDER_QUOTA_EXCEEDED'],
    ['ATTEMPT_ALREADY_RESERVED', 'PROVIDER_OUTCOME_UNKNOWN'],
  ];
  for (const [refusal, expected] of cases) {
    const gateBag = fakeGate({ refuse: refusal });
    const fetched = fakeFetch(() => okResponse({}));
    const provider = createLiveOcrProvider({
      liveGate: gateBag.gate,
      authorization: 'gy-r28-w1-offline-test',
      profile: OCR_PROFILE,
      credentials: { secretId: SHARED_ID, secretKey: SHARED_KEY, sessionToken: '' },
      imageSource: fixedSource(PNG),
      fetchImpl: fetched.fn,
    });
    const outcome = await provider.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
    assert.equal(outcome.code, expected, refusal);
    assert.equal(gateBag.state.reserves, 1);
    assert.equal(gateBag.state.settles, 0, `${refusal}：未发包不落账`);
    assert.equal(fetched.state.calls, 0, `${refusal}：不得发包`);
  }
});

test('OCR 适配器·供应商业务错误 / 证据不完整 / 非 2xx / 超时 逐个映射且零重试', async () => {
  const cases = [
    ['AuthFailure.SignatureFailure', 'PROVIDER_UNAVAILABLE', 'SERVICE_ERROR'],
    ['RequestLimitExceeded', 'PROVIDER_QUOTA_EXCEEDED', 'SERVICE_ERROR'],
    ['InvalidParameterValue', 'PROVIDER_OUTCOME_UNKNOWN', 'SERVICE_ERROR'],
    [null, 'PROVIDER_OUTCOME_UNKNOWN', 'HTTP_ERROR'],
  ];
  for (const [code, expected, state] of cases) {
    const fetched = fakeFetch(() =>
      code === null
        ? { ok: false, status: 502, json: async () => ({}) }
        : okResponse({ RequestId: REQUEST_ID, Error: { Code: code, Message: 'synthetic' } }),
    );
    const gateBag = fakeGate();
    const provider = createLiveOcrProvider({
      liveGate: gateBag.gate,
      authorization: 'gy-r28-w1-offline-test',
      profile: OCR_PROFILE,
      credentials: { secretId: SHARED_ID, secretKey: SHARED_KEY, sessionToken: '' },
      imageSource: fixedSource(PNG),
      fetchImpl: fetched.fn,
    });
    const outcome = await provider.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
    assert.equal(outcome.code, expected, String(code));
    assert.equal(fetched.state.calls, 1, `${code}：只发一次`);
    assert.equal(gateBag.state.settles, 1, `${code}：必须落账`);
    assert.equal(gateBag.state.outcomes[0].outcome.state, state);
    assert.equal(gateBag.state.outcomes[0].outcome.actualChargeCny, null);
    assert.equal(JSON.stringify(gateBag.state.outcomes[0]).includes('synthetic'), false, '不得落供应商原文');
  }

  // RequestId 缺失 ⇒ 结果未知（绝不当成功）。
  const missingId = fakeFetch(() => okResponse({ TextDetections: [{ DetectedText: '某行' }] }));
  const missingGate = fakeGate();
  const missingProvider = createLiveOcrProvider({
    liveGate: missingGate.gate,
    authorization: 'gy-r28-w1-offline-test',
    profile: OCR_PROFILE,
    credentials: { secretId: SHARED_ID, secretKey: SHARED_KEY, sessionToken: '' },
    imageSource: fixedSource(PNG),
    fetchImpl: missingId.fn,
  });
  assert.equal((await missingProvider.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 })).code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(missingGate.state.outcomes[0].outcome.state, 'RESPONSE_EVIDENCE_INCOMPLETE');

  // 超时：AbortSignal 真的生效（最短 1000ms），且不重试。
  const timedOut = fakeFetch((url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')))));
  const timeoutGate = fakeGate();
  const timeoutProvider = createLiveOcrProvider({
    liveGate: timeoutGate.gate,
    authorization: 'gy-r28-w1-offline-test',
    profile: { ...OCR_PROFILE, timeoutMs: 1000 },
    credentials: { secretId: SHARED_ID, secretKey: SHARED_KEY, sessionToken: '' },
    imageSource: fixedSource(PNG),
    fetchImpl: timedOut.fn,
  });
  const started = Date.now();
  const timeoutOutcome = await timeoutProvider.extract({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
  assert.equal(timeoutOutcome.code, 'PROVIDER_TIMEOUT');
  assert.equal(timeoutGate.state.outcomes[0].outcome.state, 'TIMEOUT');
  assert.equal(timedOut.state.calls, 1);
  assert.equal(Date.now() - started >= 900, true);
});

test('OCR 适配器·构造期 fail-closed：剖面/凭据/闸门/字节来源任一不符即拒绝构造', () => {
  const base = {
    liveGate: fakeGate().gate,
    authorization: 'gy-r28-w1-offline-test',
    profile: { ...OCR_PROFILE },
    credentials: { secretId: SHARED_ID, secretKey: SHARED_KEY, sessionToken: '' },
    imageSource: fixedSource(PNG),
  };
  assert.doesNotThrow(() => createLiveOcrProvider(base));
  for (const [label, patch] of [
    ['endpoint', { profile: { ...base.profile, endpoint: 'https://ocr.example.com' } }],
    ['action', { profile: { ...base.profile, action: 'GeneralBasicOCR' } }],
    ['region', { profile: { ...base.profile, region: 'ap-beijing' } }],
    ['maxRetries', { profile: { ...base.profile, maxRetries: 1 } }],
    ['timeoutMs', { profile: { ...base.profile, timeoutMs: 20001 } }],
    ['maxImageBytes', { profile: { ...base.profile, maxImageBytes: 1024 } }],
    ['缺少 secretId', { credentials: { secretId: '', secretKey: SHARED_KEY, sessionToken: '' } }],
    ['缺少授权串', { authorization: '' }],
    ['缺少闸门', { liveGate: undefined }],
    ['缺少字节来源', { imageSource: undefined }],
  ]) {
    assert.throws(() => createLiveOcrProvider({ ...base, ...patch }), (error) => error instanceof OcrWiringError, label);
  }
  assert.throws(() => createLiveOcrProvider(null), (error) => error instanceof OcrWiringError);
  // 字段映射本身：认不出就空（不猜）。
  assert.deepEqual(labelFieldsFromDetections(['与标签无关的一行字']), {
    registration_number: null,
    name: null,
    ingredients: [],
    dosage_form: null,
  });
});

// ---------------------------------------------------------------- B. ASR 适配器链

test('ASR 适配器·正控制：发送一次、body 剖面正确、Result 原样转写且不确定区间如实为空', async () => {
  const wav = syntheticWav(0.5);
  const gateBag = fakeGate();
  const observations = [];
  const fetched = fakeFetch(() => okResponse({ RequestId: REQUEST_ID, Result: '你好，这是语音测试。', AudioDuration: 500 }));
  const provider = createLiveSpeechProvider({
    liveGate: gateBag.gate,
    authorization: 'gy-r28-w1-offline-test',
    profile: ASR_PROFILE,
    credentials: { secretId: ASR_ID, secretKey: ASR_KEY, sessionToken: '' },
    audioSource: fixedSource(wav),
    fetchImpl: fetched.fn,
    now: () => 1_700_000_000_000,
    onObservation: (observation) => observations.push(observation),
  });
  const outcome = await provider.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
  assert.equal(outcome.kind, 'completed');
  assert.deepEqual(outcome.transcript, { text: '你好，这是语音测试。', uncertain_spans: [] });
  assert.equal(fetched.state.calls, 1);
  assert.equal(fetched.state.urls[0], 'https://asr.tencentcloudapi.com');
  assert.equal(fetched.state.inits[0].headers['X-TC-Action'], 'SentenceRecognition');
  const body = JSON.parse(fetched.state.bodies[0]);
  assert.deepEqual(Object.keys(body).sort(), ['Data', 'DataLen', 'EngSerViceType', 'ProjectId', 'SourceType', 'SubServiceType', 'UsrAudioKey', 'VoiceFormat']);
  assert.equal(body.EngSerViceType, '16k_zh');
  assert.equal(body.VoiceFormat, 'wav');
  assert.equal(body.DataLen, wav.length);
  assert.equal(Buffer.from(body.Data, 'base64').length, wav.length);
  assert.match(body.UsrAudioKey, /^gy28-[a-f0-9]{24}$/);
  assert.equal(gateBag.state.settles, 1);
  assert.equal(observations[0].transcriptCharacters, [...'你好，这是语音测试。'].length);
  assert.equal(JSON.stringify(observations[0]).includes('你好，这是语音测试。'), false, '观测不得回显转写正文');
  assert.equal(observations[0].providerAudioDurationMs, 500);
});

test('ASR 适配器·供应商给空 Result ⇒ uncertain（不编造文本、不写记录）', async () => {
  const fetched = fakeFetch(() => okResponse({ RequestId: REQUEST_ID, Result: '   ', AudioDuration: 500 }));
  const provider = createLiveSpeechProvider({
    liveGate: fakeGate().gate,
    authorization: 'gy-r28-w1-offline-test',
    profile: ASR_PROFILE,
    credentials: { secretId: ASR_ID, secretKey: ASR_KEY, sessionToken: '' },
    audioSource: fixedSource(syntheticWav(0.2)),
    fetchImpl: fetched.fn,
  });
  const outcome = await provider.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
  assert.equal(outcome.kind, 'uncertain');
  assert.equal(typeof outcome.reason, 'string');
  assert.equal(fetched.state.calls, 1);
});

test('ASR 适配器·本地拒绝先于预留：取不到字节 / 非 WAV / 超 60 秒 / base64 超上限 ⇒ 未发包、不占预算', async () => {
  const cases = [
    ['未接线来源（null）', createUnwiredAudioSource('synthetic')],
    ['空字节', fixedSource(new Uint8Array(0))],
    ['不是 WAV', fixedSource(new Uint8Array(100))],
    ['超过 60 秒', fixedSource(syntheticWav(61))],
  ];
  for (const [label, source] of cases) {
    const gateBag = fakeGate();
    const fetched = fakeFetch(() => okResponse({}));
    const provider = createLiveSpeechProvider({
      liveGate: gateBag.gate,
      authorization: 'gy-r28-w1-offline-test',
      profile: ASR_PROFILE,
      credentials: { secretId: ASR_ID, secretKey: ASR_KEY, sessionToken: '' },
      audioSource: source,
      fetchImpl: fetched.fn,
    });
    assert.deepEqual(await provider.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 }), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' }, label);
    assert.equal(gateBag.state.reserves, 0, `${label}：不得预留`);
    assert.equal(fetched.state.calls, 0, `${label}：不得发包`);
  }
  assert.throws(() => requireLiveAsrWav(new Uint8Array(10), ASR_PROFILE), (error) => error instanceof AsrLocalInputError);
  // 边界：恰好 60 秒放行（时长上限是 ≤，不是 <）。
  const atLimit = requireLiveAsrWav(syntheticWav(60), ASR_PROFILE);
  assert.equal(atLimit.durationMs, 60000);
});

test('ASR 适配器·错误码映射闭集 / 零重试 / 构造期 fail-closed', async () => {
  const wav = syntheticWav(0.2);
  const base = {
    liveGate: fakeGate().gate,
    authorization: 'gy-r28-w1-offline-test',
    profile: { ...ASR_PROFILE },
    credentials: { secretId: ASR_ID, secretKey: ASR_KEY, sessionToken: '' },
    audioSource: fixedSource(wav),
  };
  assert.doesNotThrow(() => createLiveSpeechProvider(base));
  for (const [label, patch] of [
    ['endpoint', { profile: { ...base.profile, endpoint: 'https://asr.example.com' } }],
    ['model', { profile: { ...base.profile, model: '8k_zh' } }],
    ['voiceFormat', { profile: { ...base.profile, voiceFormat: 'mp3' } }],
    ['sampleRate', { profile: { ...base.profile, sampleRate: 8000 } }],
    ['缺少 secretKey', { credentials: { secretId: ASR_ID, secretKey: '  ', sessionToken: '' } }],
    ['缺少闸门', { liveGate: undefined }],
    ['缺少字节来源', { audioSource: undefined }],
  ]) {
    assert.throws(() => createLiveSpeechProvider({ ...base, ...patch }), (error) => error instanceof AsrWiringError, label);
  }
  assert.throws(() => createLiveSpeechProvider(null), (error) => error instanceof AsrWiringError);

  for (const [code, expected] of [
    ['UnsupportedOperation.PkgExhausted', 'PROVIDER_QUOTA_EXCEEDED'],
    ['AuthFailure.UnauthorizedOperation', 'PROVIDER_UNAVAILABLE'],
    ['FailedOperation.UnOpenError', 'PROVIDER_UNAVAILABLE'],
    ['InternalError', 'PROVIDER_OUTCOME_UNKNOWN'],
  ]) {
    const fetched = fakeFetch(() => okResponse({ RequestId: REQUEST_ID, Error: { Code: code } }));
    const gateBag = fakeGate();
    const provider = createLiveSpeechProvider({ ...base, liveGate: gateBag.gate, fetchImpl: fetched.fn });
    const outcome = await provider.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
    assert.equal(outcome.code, expected, code);
    assert.equal(fetched.state.calls, 1, `${code}：只发一次`);
    assert.equal(gateBag.state.settles, 1);
    assert.equal(gateBag.state.outcomes[0].outcome.providerErrorCode, code, '原始码必须原样保留');
  }
});

test('ASR 适配器·配置→端口装配：FromConfig 与产品链同一条路径，不读取 ambient env', async () => {
  const fetched = fakeFetch(() => okResponse({ RequestId: REQUEST_ID, Result: '合成转写', AudioDuration: 200 }));
  const provider = createLiveSpeechProviderFromConfig(CONFIGURED.asr, {
    authorization: PRODUCT_GATE_AUTHORIZATION,
    audioSource: fixedSource(syntheticWav(0.2)),
    fetchImpl: fetched.fn,
  });
  const outcome = await provider.transcribe({ jobId: JOB_ID, mediaId: MEDIA_ID, mediaRevision: 1 });
  assert.equal(outcome.kind, 'completed');
  assert.equal(fetched.state.inits[0].headers['X-TC-Region'], 'ap-shanghai');
  // ASR 专用子账号对进了 Authorization（Credential=<专用 SecretId>/...），共享对不出现。
  assert.equal(fetched.state.inits[0].headers.Authorization.includes(ASR_ID), true);
  assert.equal(fetched.state.inits[0].headers.Authorization.includes(SHARED_ID), false);
});
