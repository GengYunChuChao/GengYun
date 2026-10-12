/**
 * GY-I13 真实 TTS 适配器接线 · 离线单元回归（Refs #13）。
 *
 * 目标：证明**真实能力只能经注入式端口触达**、应用装配路径行为**逐字节不变**，
 * 以及真实分支的调用顺序、签名绑定、端点断言、超时/零重试、错误码映射与证据口径。
 *
 * **全离线**：所有用例都注入假 `fetchImpl`（或注入假闸门），并把 `globalThis.fetch`
 * 换成绊线；**本文件不发出任何真实网络请求、不读任何凭据文件、不写任何账本**。
 * 真实可达性由独立手工装置 `tools/verify-provider-adapter-live.mjs` 在显式授权下取得，
 * 不在测试里发生。
 *
 * 断言一律先判 `typeof` / `Array.isArray` / `instanceof` 再判值。
 * 证据口径：真实 TTS 样本为 **0**，本文件不产生也不声称任何合成质量/音色/自然度/听感结论。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIVE_TTS_FROZEN_PROFILE,
  PROVIDER_FAILURE_CODES,
  TtsLocalInputError,
  TtsWiringError,
  assertLiveTtsProfile,
  createLiveTtsProvider,
  createRealTtsProvider,
  createTtsProvider,
  deriveLiveSessionId,
  providerErrorCodeToErrorCode,
  requireLiveTtsText,
} from '../../services/api/src/tts/provider.ts';
import {
  LIVE_GATE_ERROR_CODES,
  LIVE_GATE_REFUSALS,
  LIVE_OBSERVATION_ERROR_CODES,
  LiveGateRefusedError,
  liveGateRefusalToErrorCode,
} from '../../services/api/src/tts/live-ports.ts';
import { createSubstituteMediaPort, hasMpegAudioHeader } from '../../services/api/src/tts/media.ts';
import { createMemorySynthesisStore } from '../../services/api/src/tts/store.ts';
import { createSynthesisService } from '../../services/api/src/tts/service.ts';
import { createMemoryCheckedContentPort } from '../../services/api/src/tts/content.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const openapi = JSON.parse(readFileSync(resolve(root, 'packages/contracts/openapi.json'), 'utf8'));

const USER = 'user-owner-0001';
const REF = { type: 'answer', id: 'answer-approved', revision: 3 };
const JOB_ID = '11111111-2222-4333-8444-555555555555';
const TEXT = '你好，这是语音测试。';
const REQUEST_ID = '01234567-89ab-cdef-0123-456789abcdef';

/** 冻结剖面在测试侧**独立**写一遍（不是从被测代码取值），避免同义反复。 */
const EXPECTED_PROFILE = {
  endpoint: 'https://tts.tencentcloudapi.com',
  action: 'TextToVoice',
  apiVersion: '2019-08-23',
  region: 'ap-shanghai',
  timeoutMs: 8000,
  maxRetries: 0,
  voiceType: 101001,
  codec: 'mp3',
  sampleRate: 16000,
  maxTextCharacters: 100,
};
const CREDENTIALS = { secretId: 'synthetic-secret-id', secretKey: 'synthetic-secret-key', sessionToken: '' };

/** 真 MPEG/ID3 头（头部嗅探即可判定），以及不含任何音频头的合法 base64。 */
const MP3_ID3 = Buffer.from('49443304000000000000', 'hex');
const MP3_FRAME = Buffer.from('fffb9000', 'hex');
const NOT_AUDIO = Buffer.from('<html>not audio</html>', 'utf8');
const b64 = bytes => Buffer.from(bytes).toString('base64');

// ---------------------------------------------------------------- 辅助

function assertString(value, label) {
  assert.equal(typeof value, 'string', `${label} 必须是 string，实际是 ${typeof value}`);
  return value;
}

async function assertThrowsAsync(operation, type, label) {
  let caught = null;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert.notEqual(caught, null, `${label} 应当抛错`);
  assert.equal(caught instanceof type, true, `${label} 应抛 ${type.name}，实际 ${caught?.name}: ${caught?.message}`);
  return caught;
}

function assertThrowsSync(operation, type, label) {
  assert.throws(operation, (error) => {
    assert.equal(error instanceof type, true, `${label} 应抛 ${type.name}，实际 ${error?.name}: ${error?.message}`);
    return true;
  });
}

/** 记录 reserve/settle 的假闸门（不写任何账本）。 */
function fakeGate(options = {}) {
  const state = { reserves: 0, settleCalls: 0, outcomes: [], tickets: [] };
  return {
    state,
    gate: {
      async reserve(input) {
        state.reserves += 1;
        if (options.refuse) throw new LiveGateRefusedError(options.refuse, 'synthetic gate refusal');
        if (options.throwOther) throw new Error('synthetic gate failure');
        const ticket = {
          capability: 'tts',
          authorization: input.authorization,
          reservedCny: 0.003,
          attemptKey: input.attemptKey,
        };
        state.tickets.push(ticket);
        return ticket;
      },
      async settle(ticket, outcome) {
        state.settleCalls += 1;
        state.outcomes.push({ ticket, outcome });
      },
    },
  };
}

/** 记录调用并返回固定响应的假 fetch。 */
function fakeFetch(responder) {
  const state = { calls: 0, urls: [], inits: [], bodies: [] };
  const fn = async (url, init) => {
    state.calls += 1;
    state.urls.push(url);
    state.inits.push(init);
    state.bodies.push(init?.body);
    return responder(url, init, state.calls);
  };
  return { state, fn };
}

function okResponse(Response) {
  return { ok: true, status: 200, json: async () => ({ Response }) };
}

function ttsBody({ sessionId, audio, requestId = REQUEST_ID, extra = {} }) {
  return { RequestId: requestId, SessionId: sessionId, Audio: audio, ...extra };
}

/** 组装一个已接线的真实适配器（可选覆盖端口字段）。 */
function bootLive(overrides = {}) {
  const gateBag = overrides.gateBag ?? fakeGate(overrides.gateOptions ?? {});
  const fetched = overrides.fetched ?? fakeFetch(overrides.responder ?? (() => okResponse({})));
  const observations = [];
  const provider = createLiveTtsProvider({
    liveGate: gateBag.gate,
    authorization: overrides.authorization ?? 'gy-adapter-round-test-cny2',
    profile: { ...EXPECTED_PROFILE, ...(overrides.profile ?? {}) },
    credentials: overrides.credentials ?? CREDENTIALS,
    fetchImpl: fetched.fn,
    now: overrides.now ?? (() => 1_700_000_000_000),
    onObservation: (observation) => observations.push(observation),
  });
  return { provider, gateBag, fetched, observations, gateState: gateBag.state };
}

async function synthesize(provider, text = TEXT, targetRef = REF) {
  return provider.synthesize({ jobId: JOB_ID, text, locale: 'zh-CN', targetRef });
}

/**
 * **独立**复算 TC3 签名（测试里另写一份，与被测实现无关），用于证明
 * 「签名绑定的是实际发出的那串字节」。
 */
function independentlySign({ endpoint, action, apiVersion, region, timestamp, body, secretId, secretKey, sessionToken }) {
  const service = new URL(endpoint).hostname.split('.')[0];
  const host = `${service}.tencentcloudapi.com`;
  const sha = value => createHash('sha256').update(value).digest('hex');
  const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/${service}/tc3_request`;
  const canonical = `POST\n/\n\ncontent-type:application/json\nhost:${host}\n\ncontent-type;host\n${sha(body)}`;
  const signingKey = hmac(hmac(hmac(`TC3${secretKey}`, date), service), 'tc3_request');
  return {
    'Content-Type': 'application/json',
    Host: host,
    Authorization:
      `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, ` +
      `SignedHeaders=content-type;host, Signature=${createHmac('sha256', signingKey).update(`TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha(canonical)}`).digest('hex')}`,
    'X-TC-Action': action,
    'X-TC-Version': apiVersion,
    'X-TC-Region': region,
    'X-TC-Timestamp': String(timestamp),
    ...(sessionToken ? { 'X-TC-Token': sessionToken } : {}),
  };
}

/** 独立固定的时间戳（注入 now 后由实现取 `Math.floor(now/1000)`）。 */
const FIXED_NOW_MS = 1_700_000_000_000;
const FIXED_TS = Math.floor(FIXED_NOW_MS / 1000);

// ---------------------------------------------------------------- 默认关闭 / 剖面

test('默认关闭·应用装配路径没有端口位置：real 分支行为与接线前逐字节相同', async () => {
  // 缺凭据：受理前 fail-closed（available=false）。
  const missing = createTtsProvider({ executionMode: 'real' });
  assert.equal(missing.executionMode, 'real');
  assert.equal(missing.available, false);
  assert.equal(missing.providerVersion, 'real-unconfigured');
  assertString(missing.unavailableReason, 'unavailableReason');
  assert.deepEqual(await synthesize(missing), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });

  // 凭据齐备：仍然 fail-closed（装配路径无法注入端口）。
  const configured = createRealTtsProvider({ endpoint: EXPECTED_PROFILE.endpoint, apiKey: 'synthetic-key' });
  assert.equal(configured.available, true);
  assert.equal(configured.providerVersion, 'real-unconfigured');
  assert.deepEqual(await synthesize(configured), { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' });
  // 真实发送入口**只**能由端口构造：没有端口就没有真实分支。
  assertThrowsSync(() => createLiveTtsProvider(null), TtsWiringError, '无端口');
  assertThrowsSync(
    () => createLiveTtsProvider({ authorization: 'a', profile: { ...EXPECTED_PROFILE }, credentials: CREDENTIALS }),
    TtsWiringError,
    '缺闸门',
  );
});

test('契约事实·冻结剖面与规范一致，且失败码闭集都在 openapi ErrorCode 内', () => {
  assert.equal(LIVE_TTS_FROZEN_PROFILE.endpoint, EXPECTED_PROFILE.endpoint);
  assert.equal(LIVE_TTS_FROZEN_PROFILE.action, EXPECTED_PROFILE.action);
  assert.equal(LIVE_TTS_FROZEN_PROFILE.apiVersion, EXPECTED_PROFILE.apiVersion);
  assert.equal(LIVE_TTS_FROZEN_PROFILE.region, EXPECTED_PROFILE.region);
  assert.equal(LIVE_TTS_FROZEN_PROFILE.voiceType, EXPECTED_PROFILE.voiceType);
  assert.equal(LIVE_TTS_FROZEN_PROFILE.codec, EXPECTED_PROFILE.codec);
  assert.equal(LIVE_TTS_FROZEN_PROFILE.sampleRate, EXPECTED_PROFILE.sampleRate);
  assert.equal(LIVE_TTS_FROZEN_PROFILE.maxTextCharacters, EXPECTED_PROFILE.maxTextCharacters);
  assert.equal(LIVE_TTS_FROZEN_PROFILE.minTimeoutMs, 1000);
  assert.equal(LIVE_TTS_FROZEN_PROFILE.maxTimeoutMs, 20000);

  const contractCodes = openapi.components.schemas.ErrorCode.enum;
  assert.deepEqual([...PROVIDER_FAILURE_CODES].sort(), [...LIVE_OBSERVATION_ERROR_CODES].sort());
  for (const code of [...PROVIDER_FAILURE_CODES, ...LIVE_GATE_ERROR_CODES]) {
    assert.equal(contractCodes.includes(code), true, `${code} 必须在契约 ErrorCode 闭集内`);
  }
  assert.equal(LIVE_GATE_REFUSALS.length, 4);
});

test('反例·剖面任一项不符即拒绝构造（端点/超时/重试/区域/音色/编码/采样率/文本上限）', () => {
  const base = { ...EXPECTED_PROFILE };
  assert.doesNotThrow(() => assertLiveTtsProfile(base));
  const cases = [
    ['endpoint', { endpoint: 'https://tts.example.com' }],
    ['action', { action: 'TextToVoices' }],
    ['apiVersion', { apiVersion: '2019-08-24' }],
    ['region', { region: 'ap-beijing' }],
    ['timeoutMs 999', { timeoutMs: 999 }],
    ['timeoutMs 20001', { timeoutMs: 20001 }],
    ['timeoutMs 非整数', { timeoutMs: 8000.5 }],
    ['maxRetries 1', { maxRetries: 1 }],
    ['voiceType', { voiceType: 101002 }],
    ['codec', { codec: 'wav' }],
    ['sampleRate', { sampleRate: 8000 }],
    ['maxTextCharacters', { maxTextCharacters: 101 }],
  ];
  for (const [label, patch] of cases) {
    assertThrowsSync(() => assertLiveTtsProfile({ ...base, ...patch }), TtsWiringError, label);
    // 端口构造同样拒绝（构造期 fail-closed，绝不带着坏配置发包）。
    assert.throws(
      () => createLiveTtsProvider({ liveGate: fakeGate().gate, authorization: 'x', profile: { ...base, ...patch }, credentials: CREDENTIALS }),
      (error) => error instanceof TtsWiringError,
      `端口构造应拒绝：${label}`,
    );
  }
  for (const [label, credentials] of [
    ['缺 secretId', { ...CREDENTIALS, secretId: '' }],
    ['缺 secretKey', { ...CREDENTIALS, secretKey: '   ' }],
    ['token 非字符串', { ...CREDENTIALS, sessionToken: null }],
  ]) {
    assert.throws(
      () => createLiveTtsProvider({ liveGate: fakeGate().gate, authorization: 'x', profile: base, credentials }),
      (error) => error instanceof TtsWiringError,
      label,
    );
  }
  assert.throws(
    () => createLiveTtsProvider({ liveGate: fakeGate().gate, authorization: '', profile: base, credentials: CREDENTIALS }),
    (error) => error instanceof TtsWiringError,
    '缺授权令牌',
  );
});

// ---------------------------------------------------------------- build 在 reserve 之前

test('反例·文本超上限（101 码点）⇒ 本地拒绝，绝不截断、绝不预留、绝不发包', async () => {
  const { provider, gateState, fetched } = bootLive();
  const tooLong = '药'.repeat(101);
  const error = await assertThrowsAsync(() => synthesize(provider, tooLong), TtsLocalInputError, '101 码点');
  assert.equal(error.code, 'INVALID_REQUEST');
  assert.equal(gateState.reserves, 0, '本地拒绝不得预留预算');
  assert.equal(gateState.settleCalls, 0);
  assert.equal(fetched.state.calls, 0, '本地拒绝不得发包');

  // 边界：恰好 100 码点放行（走完发送）。
  const atLimit = '药'.repeat(100);
  const ok = bootLive({ responder: (url, init) => okResponse(ttsBody({ sessionId: sessionOf(init), audio: b64(MP3_ID3) })) });
  const result = await synthesize(ok.provider, atLimit);
  assert.equal(result.kind, 'completed');
  assert.equal(JSON.parse(ok.fetched.state.bodies[0]).Text.length, 100);

  function sessionOf(init) {
    return JSON.parse(init.body).SessionId;
  }
});

test('反例·文本为空/纯空白/非字符串 ⇒ 本地拒绝（INVALID_REQUEST），不预留不发包', async () => {
  for (const [label, text] of [
    ['空串', ''],
    ['纯空白', '   \n\t '],
    ['非字符串', 123],
    ['null', null],
    ['undefined', undefined],
  ]) {
    const { provider, gateState, fetched } = bootLive();
    const error = await assertThrowsAsync(
      () => provider.synthesize({ jobId: JOB_ID, text, locale: 'zh-CN', targetRef: REF }),
      TtsLocalInputError,
      label,
    );
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.equal(gateState.reserves, 0, label);
    assert.equal(fetched.state.calls, 0, label);
  }
  assert.equal(requireLiveTtsText('合法文本', 100), '合法文本');
});

test('反例·闸门拒绝：4 种 refusal 各自映射到契约码，且都不发包、不落账', async () => {
  const cases = [
    ['AUTHORIZATION_REQUIRED', 'PROVIDER_UNAVAILABLE'],
    ['LEDGER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE'],
    ['BUDGET_OR_COUNT_EXCEEDED', 'PROVIDER_QUOTA_EXCEEDED'],
    ['ATTEMPT_ALREADY_RESERVED', 'PROVIDER_OUTCOME_UNKNOWN'],
  ];
  for (const [refusal, expected] of cases) {
    const { provider, gateState, fetched } = bootLive({ gateOptions: { refuse: refusal } });
    const result = await synthesize(provider);
    assert.equal(result.kind, 'failed', refusal);
    assert.equal(result.code, expected, refusal);
    assert.equal(gateState.reserves, 1, refusal);
    assert.equal(gateState.settleCalls, 0, `${refusal} 未发包不落账`);
    assert.equal(fetched.state.calls, 0, `${refusal} 不得发包`);
  }
  // 非闸门异常也按「不可用」fail-closed，不冒泡成未处理异常。
  const other = bootLive({ gateOptions: { throwOther: true } });
  const result = await synthesize(other.provider);
  assert.equal(result.kind, 'failed');
  assert.equal(result.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(other.fetched.state.calls, 0);
  assert.equal(liveGateRefusalToErrorCode(null), 'PROVIDER_UNAVAILABLE');
});

// ---------------------------------------------------------------- 正常路径与签名

test('正控制·真实分支走完 build→reserve→sign→send(恰好一次)→settle，并回绑真实字节', async () => {
  const { provider, gateState, fetched, observations } = bootLive({
    responder: (url, init) => okResponse(ttsBody({ sessionId: sessionOf(init), audio: b64(MP3_ID3) })),
  });
  const result = await synthesize(provider);
  assert.equal(result.kind, 'completed');
  assert.equal(result.artifact.contentType, 'audio/mpeg');
  assert.equal(result.artifact.substitute, false, '真实产物必须 substitute=false');
  assert.equal(result.artifact.body instanceof Uint8Array, true);
  assert.deepEqual([...result.artifact.body], [...MP3_ID3], '产物字节必须与供应商返回的一致');

  assert.equal(fetched.state.calls, 1, '必须恰好发送一次');
  assert.equal(gateState.reserves, 1);
  assert.equal(gateState.settleCalls, 1, 'settle 必须被调用');
  const settled = gateState.outcomes[0].outcome;
  assert.equal(settled.state, 'BUSINESS_RESPONSE');
  assert.equal(settled.actualChargeCny, null, '未取得账单必须落 null');
  assert.equal(settled.providerErrorCode, null);
  assert.equal(settled.resultMayHaveBeenProcessed, true);

  const init = fetched.state.inits[0];
  assert.equal(fetched.state.urls[0], EXPECTED_PROFILE.endpoint, 'URL 必须逐字等于白名单端点');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual', '禁止跟随重定向');
  assert.equal(init.signal instanceof AbortSignal, true, '必须带 AbortSignal 超时');
  assert.equal(typeof init.body, 'string', 'body 必须是已序列化的字符串（不得二次 stringify）');
  const parsed = JSON.parse(init.body);
  assert.deepEqual(Object.keys(parsed).sort(), ['Codec', 'ModelType', 'PrimaryLanguage', 'SampleRate', 'SessionId', 'Speed', 'Text', 'VoiceType', 'Volume']);
  assert.equal(parsed.Text, TEXT);
  assert.equal(parsed.VoiceType, EXPECTED_PROFILE.voiceType);
  assert.equal(parsed.Codec, EXPECTED_PROFILE.codec);
  assert.equal(parsed.SampleRate, EXPECTED_PROFILE.sampleRate);
  assert.equal(parsed.SessionId, deriveLiveSessionId(JOB_ID, REF));

  const headers = init.headers;
  assert.equal(headers['X-TC-Region'], 'ap-shanghai', '区域恒取被校验配置');
  assert.equal(headers['X-TC-Action'], 'TextToVoice');
  assert.equal(headers['X-TC-Version'], '2019-08-23');
  assert.equal(headers.Host, 'tts.tencentcloudapi.com');
  assert.equal(Object.hasOwn(headers, 'X-TC-Token'), false, '长期密钥不得带临时令牌');

  // **签名绑定实际发出的字节**：用测试侧独立实现复算，必须逐字相等。
  const recomputed = independentlySign({
    endpoint: EXPECTED_PROFILE.endpoint,
    action: EXPECTED_PROFILE.action,
    apiVersion: EXPECTED_PROFILE.apiVersion,
    region: EXPECTED_PROFILE.region,
    timestamp: FIXED_TS,
    body: init.body,
    secretId: CREDENTIALS.secretId,
    secretKey: CREDENTIALS.secretKey,
    sessionToken: '',
  });
  assert.deepEqual(headers, recomputed, '签名必须与独立复算一致（绑定实际字节）');

  // 观测只含安全字段：不含任何凭据值。
  assert.equal(observations.length, 1);
  const serialized = JSON.stringify(observations[0]);
  for (const secret of [CREDENTIALS.secretId, CREDENTIALS.secretKey]) {
    assert.equal(serialized.includes(secret), false, '观测不得含凭据值');
  }
  assert.equal(observations[0].requestId, REQUEST_ID);
  assert.equal(observations[0].sessionEchoOk, true);
  assert.equal(observations[0].hasMpegHeader, true);
  assert.equal(observations[0].audioBytes, MP3_ID3.length);
  assert.equal(observations[0].sendAttempts, 1);
  assert.equal(observations[0].endpointAsserted, true);

  function sessionOf(inner) {
    return JSON.parse(inner.body).SessionId;
  }
});

test('签名·不同请求体得到不同签名（同一时间戳），且临时令牌只随同源凭据出现', async () => {
  const first = bootLive({ responder: (url, init) => okResponse(ttsBody({ sessionId: JSON.parse(init.body).SessionId, audio: b64(MP3_ID3) })) });
  await synthesize(first.provider, TEXT);
  const second = bootLive({ responder: (url, init) => okResponse(ttsBody({ sessionId: JSON.parse(init.body).SessionId, audio: b64(MP3_ID3) })) });
  await synthesize(second.provider, '另一段合成文本。');
  assert.notEqual(first.fetched.state.inits[0].headers.Authorization, second.fetched.state.inits[0].headers.Authorization);

  const temporary = bootLive({
    credentials: { ...CREDENTIALS, sessionToken: 'synthetic-temporary-token' },
    responder: (url, init) => okResponse(ttsBody({ sessionId: JSON.parse(init.body).SessionId, audio: b64(MP3_FRAME) })),
  });
  const result = await synthesize(temporary.provider);
  assert.equal(result.kind, 'completed');
  assert.equal(temporary.fetched.state.inits[0].headers['X-TC-Token'], 'synthetic-temporary-token');
});

// ---------------------------------------------------------------- 供应商错误映射

test('映射·HTTP200 业务错误码逐个落到契约闭集，原始码原样保留且必落账', async () => {
  const cases = [
    ['AuthFailure.UnauthorizedOperation', 'PROVIDER_UNAVAILABLE'],
    ['AuthFailure.SignatureFailure', 'PROVIDER_UNAVAILABLE'],
    ['UnauthorizedOperation', 'PROVIDER_UNAVAILABLE'],
    ['InvalidCredential', 'PROVIDER_UNAVAILABLE'],
    ['FailedOperation.UnOpenError', 'PROVIDER_UNAVAILABLE'],
    ['FailedOperation.UserNotRegistered', 'PROVIDER_UNAVAILABLE'],
    ['UnsupportedOperation.PkgExhausted', 'PROVIDER_QUOTA_EXCEEDED'],
    ['ResourceUnavailable.ResourcePackageRunOut', 'PROVIDER_QUOTA_EXCEEDED'],
    ['RequestLimitExceeded', 'PROVIDER_QUOTA_EXCEEDED'],
    ['LimitExceeded.QuotaExceeded', 'PROVIDER_QUOTA_EXCEEDED'],
    ['InvalidParameterValue', 'PROVIDER_OUTCOME_UNKNOWN'],
    ['MissingParameter', 'PROVIDER_OUTCOME_UNKNOWN'],
    ['InternalError', 'PROVIDER_OUTCOME_UNKNOWN'],
    ['FailedOperation.ServiceIsolate', 'PROVIDER_OUTCOME_UNKNOWN'],
    ['SomeBrandNewError.Code', 'PROVIDER_OUTCOME_UNKNOWN'],
  ];
  for (const [code, expected] of cases) {
    assert.equal(providerErrorCodeToErrorCode(code), expected, code);
    const { provider, gateState, fetched } = bootLive({
      responder: () => okResponse({ RequestId: REQUEST_ID, Error: { Code: code, Message: 'synthetic' } }),
    });
    const result = await synthesize(provider);
    assert.equal(result.kind, 'failed', code);
    assert.equal(result.code, expected, code);
    assert.equal(fetched.state.calls, 1, `${code} 只发一次`);
    assert.equal(gateState.settleCalls, 1, `${code} 必须落账`);
    assert.equal(gateState.outcomes[0].outcome.providerErrorCode, code, `${code} 原始码必须原样保留`);
    assert.equal(gateState.outcomes[0].outcome.state, 'SERVICE_ERROR');
    assert.equal(gateState.outcomes[0].outcome.actualChargeCny, null);
    // 供应商原始 **消息** 绝不进入落账内容（只保留码）。
    assert.equal(JSON.stringify(gateState.outcomes[0]).includes('synthetic'), false, `${code} 不得落供应商原文`);
  }
});

test('反例·证据不完整与载荷非法一律「结果未知」，绝不当成功（且只发一次、必落账）', async () => {
  const cases = [
    ['RequestId 缺失', { RequestId: undefined, SessionId: 'x', Audio: b64(MP3_ID3) }],
    ['RequestId 空', { RequestId: '   ', SessionId: 'x', Audio: b64(MP3_ID3) }],
    ['RequestId 格式非法', { RequestId: 'unsafe/id', SessionId: 'x', Audio: b64(MP3_ID3) }],
    ['SessionId 不匹配', { RequestId: REQUEST_ID, SessionId: 'another-session', Audio: b64(MP3_ID3) }],
    ['SessionId 缺失', { RequestId: REQUEST_ID, SessionId: undefined, Audio: b64(MP3_ID3) }],
    ['Audio 缺失', { RequestId: REQUEST_ID, SessionId: null, Audio: undefined }],
    ['Audio 空串', { RequestId: REQUEST_ID, SessionId: null, Audio: '' }],
    ['Audio 非 base64', { RequestId: REQUEST_ID, SessionId: null, Audio: '%%%!' }],
    ['Audio 是合法 base64 但不是音频', { RequestId: REQUEST_ID, SessionId: null, Audio: b64(NOT_AUDIO) }],
  ];
  for (const [label, body] of cases) {
    const { provider, gateState, fetched } = bootLive({
      responder: (url, init) =>
        okResponse({
          ...body,
          ...(body.SessionId === null ? { SessionId: JSON.parse(init.body).SessionId } : {}),
        }),
    });
    const result = await synthesize(provider);
    assert.equal(result.kind, 'failed', label);
    assert.equal(result.code, 'PROVIDER_OUTCOME_UNKNOWN', label);
    assert.equal(fetched.state.calls, 1, label);
    assert.equal(gateState.settleCalls, 1, label);
    assert.equal(gateState.outcomes[0].outcome.actualChargeCny, null, label);
    const state = gateState.outcomes[0].outcome.state;
    assert.equal(['RESPONSE_EVIDENCE_INCOMPLETE', 'OUTCOME_UNKNOWN'].includes(state), true, `${label} → ${state}`);
  }
});

test('映射·HTTP 非 2xx / 载荷非法 / 传输失败 / 超时，逐个映射且零重试', async () => {
  const nonOk = bootLive({ responder: () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.deepEqual((await synthesize(nonOk.provider)).code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(nonOk.gateState.outcomes[0].outcome.state, 'HTTP_ERROR');
  assert.equal(nonOk.fetched.state.calls, 1);

  const badJson = bootLive({ responder: () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) });
  assert.deepEqual((await synthesize(badJson.provider)).code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(badJson.gateState.outcomes[0].outcome.state, 'OUTCOME_UNKNOWN');

  const noResponseObject = bootLive({ responder: () => okResponse(undefined) });
  assert.deepEqual((await synthesize(noResponseObject.provider)).code, 'PROVIDER_OUTCOME_UNKNOWN');

  const transport = bootLive({ responder: () => { throw new Error('ECONNRESET synthetic'); } });
  const transportResult = await synthesize(transport.provider);
  assert.equal(transportResult.code, 'PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(transport.gateState.outcomes[0].outcome.state, 'OUTCOME_UNKNOWN');
  assert.equal(transport.fetched.state.calls, 1, '传输失败不得重试');

  const timeout = bootLive({
    responder: () => {
      const error = new Error('synthetic timeout');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  const timeoutResult = await synthesize(timeout.provider);
  assert.equal(timeoutResult.code, 'PROVIDER_TIMEOUT');
  assert.equal(timeout.gateState.outcomes[0].outcome.state, 'TIMEOUT');
  assert.equal(timeout.gateState.outcomes[0].outcome.actualChargeCny, null);
  assert.equal(timeout.fetched.state.calls, 1, '超时不得重试');
  assert.equal(timeout.gateState.reserves, 1, '超时不得再次预留');
});

test('超时·AbortSignal.timeout 真的生效（最短 1000ms，端点侧未响应即 PROVIDER_TIMEOUT）', async () => {
  const { provider, gateState, fetched } = bootLive({
    profile: { ...EXPECTED_PROFILE, timeoutMs: 1000 },
    responder: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
      }),
  });
  const started = Date.now();
  const result = await synthesize(provider);
  const elapsed = Date.now() - started;
  assert.equal(result.code, 'PROVIDER_TIMEOUT');
  assert.equal(gateState.outcomes[0].outcome.state, 'TIMEOUT');
  assert.equal(fetched.state.calls, 1);
  assert.equal(gateState.reserves, 1, '恰好一次预留');
  assert.equal(elapsed >= 900, true, `超时应由 AbortSignal.timeout 触发（实际 ${elapsed}ms）`);
});

// ---------------------------------------------------------------- 媒体端口与 service 映射

test('媒体端口·替身存储拒绝真实产物（substitute=false），不把真实音频伪装成替身对象', async () => {
  const port = createSubstituteMediaPort();
  const refused = await port.put({
    ownerUserId: USER,
    synthesisId: '00000000-0000-4000-8000-000000000001',
    artifact: { contentType: 'audio/mpeg', body: MP3_ID3, substitute: false },
  });
  assert.deepEqual(refused, { ok: false, code: 'OBJECT_UNAVAILABLE' });
  // 替身标注产物仍然可以落库（既有行为不变）。
  const accepted = await port.put({
    ownerUserId: USER,
    synthesisId: '00000000-0000-4000-8000-000000000002',
    artifact: { contentType: 'application/x-gengyun-tts-substitute', body: Buffer.from('替身标注'), substitute: true },
  });
  assert.equal(accepted.ok, true);
  assert.equal(hasMpegAudioHeader(MP3_ID3), true);
  assert.equal(hasMpegAudioHeader(MP3_FRAME), true);
  assert.equal(hasMpegAudioHeader(NOT_AUDIO), false);
  assert.equal(hasMpegAudioHeader(new Uint8Array(0)), false);
});

test('service 映射·真实适配器的本地入参拒绝落 failed + INVALID_REQUEST（未发包、不占预算）', async () => {
  const store = createMemorySynthesisStore();
  let providerCalls = 0;
  const provider = {
    executionMode: 'real',
    providerVersion: 'synthetic-live-adapter',
    note: '测试用（模拟真实适配器的本地入参拒绝）',
    available: true,
    unavailableReason: null,
    async synthesize() {
      providerCalls += 1;
      throw new TtsLocalInputError('INVALID_REQUEST', '待合成文本超过供应商上限（不截断，fail-closed）');
    },
  };
  const service = createSynthesisService({
    store,
    provider,
    media: createSubstituteMediaPort(),
    content: createMemoryCheckedContentPort([
      { type: 'answer', id: REF.id, revision: REF.revision, auditState: 'approved', text: '药'.repeat(101) },
    ]),
    idempotencyHmacKey: 'gengyun-stub-idempotency-hmac-key',
    jobDeadlineMs: 30_000,
    idempotencyWaitMs: 300,
  });
  const created = await service.createSynthesis({
    userId: USER,
    body: { checked_content_ref: { ...REF }, locale: 'zh-CN' },
    idempotencyKey: 'live-adapter-test-key-0001',
  });
  assert.equal(created.status, 202);
  await service.settle();
  const settled = await service.inspectJob({ userId: USER, jobId: created.job.id });
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error_code, 'INVALID_REQUEST');
  assert.equal(settled.result, null);
  assert.equal(providerCalls, 1);
});
