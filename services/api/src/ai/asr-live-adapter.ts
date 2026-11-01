/**
 * GY-R28-W1 · 普通话录音转写（ASR）真实适配器（腾讯云 `SentenceRecognition`）+ 配置→端口装配。
 *
 * 形状照抄样板 `services/api/src/tts/provider.ts` 的 `createLiveTtsProvider()`：
 * **build(本地) → reserve(闸门) → sign(TC3) → send(恰好一次) → settle(无论成败)**。
 *
 * 本域特有的硬约束：
 * 1. **字节来自注入端口**（见 `live-ports.ts`），不来自 ambient env / 磁盘 / 对象存储隐式默认。
 * 2. **本地音频剖面校验先于预留**：`16k_zh` + `wav` + 16000Hz + 单声道 + 16bit + ≤60s +
 *    base64 后 ≤ 3145728 字节（与 `tools/ai-config.mjs:checkedWav()` 同口径）。超限**不裁剪**。
 * 3. **绝不编造转写**：供应商 `Result` 为空 ⇒ `{kind:'uncertain'}`（服务层据此落 `uncertain`
 *    终态且**不写**转写记录），绝不补一句「听起来像……」。
 * 4. 不确定区间如实为空数组：`SentenceRecognition` **不返回**逐词置信区间，
 *    因此 `uncertain_spans: []` 是「供应商没给」而不是「全都确信」；口径写在证据页。
 * 5. **格式问题 ≠ 供应商故障**（GY-R72-I11）：拿到字节但 WAV 剖面不符时，若媒体层认得出这是
 *    另一种音频容器（MP3/AAC）⇒ `failed` + `MEDIA_TYPE_UNSUPPORTED`（415，客户端换 WAV 即可）；
 *    其余情形（读不到、空字节、认不出、认出来是 WAV 只是超长/声道/位深不符）**维持**
 *    `PROVIDER_UNAVAILABLE`——字节来源没接线不该被说成「格式不支持」。
 *
 * 证据口径：真实 ASR 样本为 **0**（`docs/evaluation/sample-gap-register.md`），
 * 本文件与全域**不产生、不声称任何准确率或转写质量结论**；一次可达性调用不构成样本。
 */
import type { ProviderOutcome, SpeechProvider } from '../speech/provider.ts';
import {
  AsrLocalInputError,
  AsrWiringError,
  type AudioSource,
  type LiveAsrCredentials,
  type LiveAsrObservation,
  type LiveAsrProfile,
  type ProviderCallState,
  type RealAsrPorts,
} from './asr-live-ports.ts';
import { providerErrorCodeToErrorCode } from './error-map.ts';
import { createProcessLiveGate, LIVE_UNIT_PRICES_CNY } from './live-gate.ts';
import { liveGateRefusalToErrorCode } from '../tts/live-ports.ts';
import { sha256Hex, signTc3Request } from '../tts/tc3.ts';
import type { AsrProviderConfig } from '../config.ts';
import { detectMediaType } from '../../../../packages/media/index.mjs';

/** 冻结的 ASR 供应商剖面（口径＝`AI_ENDPOINTS.asr` + `configurationIssues()` 的音频剖面）。 */
export const LIVE_ASR_FROZEN_PROFILE = Object.freeze({
  endpoint: 'https://asr.tencentcloudapi.com',
  action: 'SentenceRecognition',
  apiVersion: '2019-06-14',
  region: 'ap-shanghai',
  model: '16k_zh' as const,
  voiceFormat: 'wav' as const,
  sampleRate: 16000 as const,
  channels: 1 as const,
  maxAudioSeconds: 60,
  maxAudioBase64Bytes: 3145728,
  minTimeoutMs: 1000,
  maxTimeoutMs: 20000,
});

/** 构造期校验被校验配置快照（纵深防御；配置侧已挡一层）。 */
export function assertLiveAsrProfile(profile: LiveAsrProfile): LiveAsrProfile {
  const frozen = LIVE_ASR_FROZEN_PROFILE;
  const reject = (label: string): never => {
    throw new AsrWiringError(`真实 ASR 配置不合法：${label}（fail-closed，未发包）`);
  };
  if (profile === null || typeof profile !== 'object') reject('缺少被校验配置快照');
  if (profile.endpoint !== frozen.endpoint) reject('endpoint 不是白名单端点');
  if (profile.action !== frozen.action) reject('action 不是 SentenceRecognition');
  if (profile.apiVersion !== frozen.apiVersion) reject('apiVersion 不是 2019-06-14');
  if (profile.region !== frozen.region) reject('region 不是被校验配置的固定区域');
  if (typeof profile.timeoutMs !== 'number' || !Number.isInteger(profile.timeoutMs) || profile.timeoutMs < frozen.minTimeoutMs || profile.timeoutMs > frozen.maxTimeoutMs) {
    reject(`timeoutMs 必须是被校验配置里的 ${frozen.minTimeoutMs}..${frozen.maxTimeoutMs} 整数`);
  }
  if (profile.maxRetries !== 0) reject('maxRetries 必须为 0（任何重发都是一次新的预留）');
  if (profile.model !== frozen.model) reject('model 不是 16k_zh');
  if (profile.voiceFormat !== frozen.voiceFormat) reject('voiceFormat 不是 wav');
  if (profile.sampleRate !== frozen.sampleRate) reject('sampleRate 不是 16000');
  if (profile.channels !== frozen.channels) reject('channels 不是 1');
  if (profile.maxAudioSeconds !== frozen.maxAudioSeconds) reject(`maxAudioSeconds 不是 ${frozen.maxAudioSeconds}`);
  if (profile.maxAudioBase64Bytes !== frozen.maxAudioBase64Bytes) reject(`maxAudioBase64Bytes 不是 ${frozen.maxAudioBase64Bytes}`);
  return profile;
}

/**
 * 本地 WAV 剖面校验（**先于预留**）。判据逐条对齐 `tools/ai-config.mjs:checkedWav()`：
 * RIFF/WAVE 头、`size+8===length`、单一 `fmt `/`data`、PCM、单声道、16000Hz、16bit、
 * `data` 长度为偶数、时长 ≤ 上限、base64 后字节 ≤ 上限。任一不符 ⇒ `AsrLocalInputError`。
 */
export function requireLiveAsrWav(raw: unknown, profile: LiveAsrProfile): { bytes: Uint8Array; durationMs: number } {
  if (!(raw instanceof Uint8Array) || raw.length === 0) {
    throw new AsrLocalInputError('OBJECT_UNAVAILABLE', '取不到待转写录音字节（fail-closed，未发包）');
  }
  const buffer = Buffer.from(raw);
  const invalid = (label: string): never => {
    throw new AsrLocalInputError('OBJECT_UNAVAILABLE', `录音 WAV 不合法：${label}（不裁剪、不转码，fail-closed 未发包）`);
  };
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE' || buffer.readUInt32LE(4) + 8 !== buffer.length) {
    invalid('RIFF/WAVE 头或长度不一致');
  }
  if (4 * Math.ceil(buffer.length / 3) > profile.maxAudioBase64Bytes) invalid(`base64 后超过 ${profile.maxAudioBase64Bytes} 字节`);
  let fmt: Buffer | null = null;
  let dataLength: number | null = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > buffer.length) invalid('chunk 越界');
    if (id === 'fmt ') {
      if (fmt !== null || length < 16) invalid('fmt chunk 重复或过短');
      fmt = buffer.subarray(start, start + length);
    }
    if (id === 'data') {
      if (dataLength !== null) invalid('data chunk 重复');
      dataLength = length;
    }
    offset = start + length + (length % 2);
  }
  if (offset !== buffer.length || fmt === null || dataLength === null) invalid('chunk 遍历未正好结束');
  const format = fmt as Buffer;
  const data = dataLength as number;
  if (data % 2 !== 0) invalid('data 长度不是偶数（16bit 采样）');
  if (format.readUInt16LE(0) !== 1) invalid('不是 PCM');
  if (format.readUInt16LE(2) !== 1) invalid('不是单声道');
  if (format.readUInt32LE(4) !== 16000) invalid('采样率不是 16000');
  if (format.readUInt32LE(8) !== 32000) invalid('字节率不是 32000');
  if (format.readUInt16LE(12) !== 2) invalid('块对齐不是 2');
  if (format.readUInt16LE(14) !== 16) invalid('位深不是 16');
  const seconds = data / 32000;
  if (seconds > profile.maxAudioSeconds) invalid(`时长 ${seconds.toFixed(2)}s 超过 ${profile.maxAudioSeconds}s`);
  return { bytes: raw, durationMs: Math.round(seconds * 1000) };
}

/** `UsrAudioKey`：确定性、非个人（由音频字节派生），≤120 字符。 */
export function deriveUsrAudioKey(bytes: Uint8Array): string {
  const digest = sha256Hex(Buffer.from(bytes).toString('base64'));
  return `gy28-${digest.slice(0, 24)}`;
}

/**
 * 拿到字节、WAV 剖面校验却失败时的**分流判据**（GY-R72-I11）。
 *
 * 失败路径必须分清两件事——此前它们被同一个 `catch { PROVIDER_UNAVAILABLE }` 揉成一件：
 * - **字节不可用**：端口未接线、读不到、空字节、认不出的垃圾 ⇒ 仍报 `PROVIDER_UNAVAILABLE`；
 * - **格式不合格**：媒体层认得出这是**另一种音频容器**（MP3 / AAC）⇒ `MEDIA_TYPE_UNSUPPORTED`，
 *   客户端换 WAV 就能成功，不该显示成「供应商不可用」。
 *
 * 判据复用媒体层自己的嗅探器 `packages/media/detect.mjs#detectMediaType`（也是上传期认定
 * `audio/mpeg` / `audio/aac` 合法的那一支），所以「受理期拦什么」与「转写期报什么码」看的是
 * 同一份事实，不另立魔数表。返回 `null` 的两种情形都**维持**既有 `PROVIDER_UNAVAILABLE`：
 * 认不出真实类型（`null`），或认出来就是 WAV（只是剖面不符：超长/多声道/位深不对…）。
 */
export function foreignAudioMime(raw: unknown): string | null {
  if (!(raw instanceof Uint8Array) || raw.length === 0) return null;
  const detected = detectMediaType(raw);
  if (detected === null || detected.mime === 'audio/wav') return null;
  return detected.mime;
}

/**
 * 真实 ASR 提供者。**唯一**能触达真实发送的构造器：没有端口对象就构造不出来。
 */
export function createLiveSpeechProvider(ports: RealAsrPorts): SpeechProvider {
  if (ports === null || typeof ports !== 'object') {
    throw new AsrWiringError('真实 ASR 端口缺失：真实分支默认关闭（应用装配路径必须显式给端口）');
  }
  const profile = assertLiveAsrProfile(ports.profile);
  const credentials = ports.credentials;
  if (credentials === null || typeof credentials !== 'object') throw new AsrWiringError('真实 ASR 缺少凭据三元组');
  if (typeof credentials.secretId !== 'string' || credentials.secretId.trim() === '') {
    throw new AsrWiringError('真实 ASR 缺少 secretId（同源配对，不逐字段混配、不回退）');
  }
  if (typeof credentials.secretKey !== 'string' || credentials.secretKey.trim() === '') {
    throw new AsrWiringError('真实 ASR 缺少 secretKey（同源配对，不逐字段混配、不回退）');
  }
  if (typeof credentials.sessionToken !== 'string') {
    throw new AsrWiringError('真实 ASR 临时令牌必须是字符串（长期密钥显式空串，不继承其它 token）');
  }
  if (typeof ports.authorization !== 'string' || ports.authorization.trim() === '') {
    throw new AsrWiringError('真实 ASR 缺少显式授权令牌（与闸门授权串逐字一致）');
  }
  const liveGate = ports.liveGate;
  if (liveGate === null || typeof liveGate !== 'object' || typeof liveGate.reserve !== 'function' || typeof liveGate.settle !== 'function') {
    throw new AsrWiringError('真实 ASR 缺少预算闸门（没有闸门就不构造真实分支）');
  }
  const audioSource = ports.audioSource;
  if (audioSource === null || typeof audioSource !== 'object' || typeof audioSource.read !== 'function') {
    throw new AsrWiringError('真实 ASR 缺少录音字节来源端口（没有它就拿不到要转写的音频）');
  }
  const fetchImpl = ports.fetchImpl ?? globalThis.fetch;
  const now = ports.now ?? ((): number => Date.now());
  const onObservation = ports.onObservation;

  return {
    executionMode: 'real',
    modelVersion: `tencent-sentencerecognition-${profile.apiVersion}`,
    note: '真实 ASR 适配器（腾讯云 SentenceRecognition；音频来自注入端口，不读取本地/对象存储的隐式默认）',
    available: true,
    unavailableReason: null,
    async transcribe({ jobId, mediaId, mediaRevision }) {
      // ① build（本地）——必须在 reserve 之前：本地拒绝**不占预算、不留账**。
      //
      // 取字节 与 剖面校验 刻意分两步（GY-R72-I11）：前者失败＝**字节来源不可用**，
      // 后者失败可能是**格式不合格**。全揉进一个 `catch` 就会把「请传 WAV」说成
      // 「供应商不可用」（今天 MP3 的实际表现）。
      let raw: Uint8Array | null;
      try {
        raw = await audioSource.read({ jobId, mediaId, mediaRevision });
      } catch {
        // 端口没接线/读不到：字节来源问题，**不是**格式问题，也**不是**供应商故障。
        // 口径与 `ai/asr-audio-source.ts`、`i11-audio-source-wiring` 一致，维持既有码。
        return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
      }
      if (raw === null || raw.length === 0) {
        // 空字节/没有预留：同样归「字节不可用」，不猜格式（认不出的字节不构成格式结论）。
        return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
      }
      let audio: { bytes: Uint8Array; durationMs: number };
      try {
        audio = requireLiveAsrWav(raw, profile);
      } catch {
        // 拿到了字节但剖面不符：认得出是另一种音频容器（MP3/AAC）⇒ 格式不支持；
        // 认不出、或认出来就是 WAV（只是超长/声道/位深不符）⇒ 维持 `PROVIDER_UNAVAILABLE`。
        const foreign = foreignAudioMime(raw);
        return { kind: 'failed', code: foreign === null ? 'PROVIDER_UNAVAILABLE' : 'MEDIA_TYPE_UNSUPPORTED' };
      }
      const payload = {
        ProjectId: 0,
        SubServiceType: 2,
        EngSerViceType: profile.model,
        SourceType: 1,
        VoiceFormat: profile.voiceFormat,
        Data: Buffer.from(audio.bytes).toString('base64'),
        DataLen: audio.bytes.length,
        UsrAudioKey: deriveUsrAudioKey(audio.bytes),
      };
      // **只序列化一次**：同一字符串既签名又当 body。
      const body = JSON.stringify(payload);
      const attemptKey = `${jobId}:${mediaId}#${mediaRevision}`;

      // ② reserve（闸门，必须在签名与建连之前）。
      let ticket;
      try {
        ticket = await liveGate.reserve({ capability: 'asr', authorization: ports.authorization, attemptKey });
      } catch (error) {
        return { kind: 'failed', code: liveGateRefusalToErrorCode(error) };
      }

      // ③ sign ④ send（恰好一次）⑤ settle（无论成败）。
      const outcome = await sendLiveAsrOnce({
        endpoint: profile.endpoint,
        action: profile.action,
        apiVersion: profile.apiVersion,
        region: profile.region,
        timeoutMs: profile.timeoutMs,
        body,
        audioBytes: audio.bytes.length,
        audioDurationMs: audio.durationMs,
        credentials,
        fetchImpl,
        now,
      });
      const observed = outcome.observation;
      await liveGate.settle(ticket, {
        state: observed.state,
        actualChargeCny: null,
        providerErrorCode: observed.providerErrorCode,
        resultMayHaveBeenProcessed: observed.resultMayHaveBeenProcessed,
      });
      onObservation?.(observed);
      if (observed.state !== 'BUSINESS_RESPONSE' || outcome.text === null) {
        return { kind: 'failed', code: observed.errorCode ?? 'PROVIDER_OUTCOME_UNKNOWN' };
      }
      if (outcome.text === '') {
        // 供应商确实回答「没有可读语音」：落 uncertain（服务层不写转写记录），**不编造文本**。
        return { kind: 'uncertain', reason: '供应商未返回可读文本（无有效语音），不补造转写' };
      }
      return { kind: 'completed', transcript: { text: outcome.text, uncertain_spans: [] } };
    },
  };
}

interface LiveAsrSendResult {
  observation: LiveAsrObservation;
  /** 转写正文（**只在成功时**给出；不进观测/台账）。空串表示供应商给了空结果。 */
  text: string | null;
}

const REQUEST_ID_PATTERN = /^[a-fA-F0-9-]{16,64}$/;
/** 契约 `Transcription.text` 上限（`maxLength: 8000`）：超出即判协议违规（不截断）。 */
const MAX_TRANSCRIPT_CODE_POINTS = 8000;

function asrObservation(partial: Partial<LiveAsrObservation> & { state: ProviderCallState }): LiveAsrObservation {
  return {
    capability: 'asr',
    errorCode: null,
    providerErrorCode: null,
    httpStatus: null,
    requestId: null,
    audioBytes: null,
    audioDurationMs: null,
    transcriptCharacters: null,
    providerAudioDurationMs: null,
    resultMayHaveBeenProcessed: true,
    elapsedMs: 0,
    endpointAsserted: false,
    sendAttempts: 0,
    ...partial,
  };
}

/** **sign + send（恰好一次）+ 解析**。返回安全观测，**永不抛错**。 */
async function sendLiveAsrOnce(input: {
  endpoint: string;
  action: string;
  apiVersion: string;
  region: string;
  timeoutMs: number;
  body: string;
  audioBytes: number;
  audioDurationMs: number;
  credentials: LiveAsrCredentials;
  fetchImpl: typeof fetch;
  now: () => number;
}): Promise<LiveAsrSendResult> {
  const startedAt = input.now();
  const failed = (partial: Partial<LiveAsrObservation> & { state: ProviderCallState }): LiveAsrSendResult => ({
    observation: asrObservation(partial),
    text: null,
  });

  try {
    const parsed = new URL(input.endpoint);
    const expectedHost = `${parsed.hostname.split('.')[0]}.tencentcloudapi.com`;
    const allowlisted =
      input.endpoint === LIVE_ASR_FROZEN_PROFILE.endpoint &&
      parsed.host === expectedHost &&
      parsed.search === '' &&
      parsed.pathname === '/';
    if (!allowlisted) return failed({ state: 'OUTCOME_UNKNOWN', sendAttempts: 0, elapsedMs: input.now() - startedAt });
  } catch {
    return failed({ state: 'OUTCOME_UNKNOWN', sendAttempts: 0, elapsedMs: input.now() - startedAt });
  }

  const headers = signTc3Request({
    endpoint: input.endpoint,
    action: input.action,
    apiVersion: input.apiVersion,
    region: input.region,
    timestampSeconds: Math.floor(startedAt / 1000),
    body: input.body,
    credentials: input.credentials,
  });

  let response: Response;
  let sendAttempts = 0;
  try {
    sendAttempts = 1;
    response = await input.fetchImpl(input.endpoint, {
      method: 'POST',
      body: input.body,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return failed({
      state: timedOut ? 'TIMEOUT' : 'OUTCOME_UNKNOWN',
      errorCode: timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_OUTCOME_UNKNOWN',
      endpointAsserted: true,
      sendAttempts,
      audioBytes: input.audioBytes,
      audioDurationMs: input.audioDurationMs,
      elapsedMs: input.now() - startedAt,
    });
  }

  if (!response.ok) {
    return failed({
      state: 'HTTP_ERROR',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      endpointAsserted: true,
      sendAttempts,
      audioBytes: input.audioBytes,
      audioDurationMs: input.audioDurationMs,
      elapsedMs: input.now() - startedAt,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return failed({
      state: 'OUTCOME_UNKNOWN',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      endpointAsserted: true,
      sendAttempts,
      audioBytes: input.audioBytes,
      audioDurationMs: input.audioDurationMs,
      elapsedMs: input.now() - startedAt,
    });
  }
  const result = (payload as { Response?: unknown } | null)?.Response;
  if (result === null || typeof result !== 'object') {
    return failed({
      state: 'OUTCOME_UNKNOWN',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      endpointAsserted: true,
      sendAttempts,
      audioBytes: input.audioBytes,
      audioDurationMs: input.audioDurationMs,
      elapsedMs: input.now() - startedAt,
    });
  }
  const fields = result as Record<string, unknown>;
  const rawRequestId = fields['RequestId'];
  const requestId = typeof rawRequestId === 'string' && REQUEST_ID_PATTERN.test(rawRequestId) ? rawRequestId : null;

  const errorObject = fields['Error'] as { Code?: unknown } | null | undefined;
  const rawCode = errorObject?.Code;
  if (typeof rawCode === 'string' && rawCode !== '') {
    const safeCode = /^[A-Za-z0-9.]{1,100}$/.test(rawCode) ? rawCode : 'UNRECOGNIZED_ERROR';
    return failed({
      state: 'SERVICE_ERROR',
      errorCode: providerErrorCodeToErrorCode(safeCode),
      providerErrorCode: safeCode,
      httpStatus: response.status,
      requestId,
      endpointAsserted: true,
      sendAttempts,
      audioBytes: input.audioBytes,
      audioDurationMs: input.audioDurationMs,
      elapsedMs: input.now() - startedAt,
    });
  }

  if (requestId === null) {
    return failed({
      state: 'RESPONSE_EVIDENCE_INCOMPLETE',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      endpointAsserted: true,
      sendAttempts,
      audioBytes: input.audioBytes,
      audioDurationMs: input.audioDurationMs,
      elapsedMs: input.now() - startedAt,
    });
  }

  const rawResult = fields['Result'];
  // `Result` 缺失 ⇒ 证据不完整；`''`（空串）是供应商的合法回答「没有可读语音」。
  if (typeof rawResult !== 'string') {
    return failed({
      state: 'RESPONSE_EVIDENCE_INCOMPLETE',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      requestId,
      endpointAsserted: true,
      sendAttempts,
      audioBytes: input.audioBytes,
      audioDurationMs: input.audioDurationMs,
      elapsedMs: input.now() - startedAt,
    });
  }
  const text = rawResult.trim();
  const characters = [...text].length;
  if (characters > MAX_TRANSCRIPT_CODE_POINTS) {
    // 超契约上限：不截断（截断会改变语义），按证据不足处理。
    return failed({
      state: 'RESPONSE_EVIDENCE_INCOMPLETE',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      requestId,
      transcriptCharacters: characters,
      endpointAsserted: true,
      sendAttempts,
      audioBytes: input.audioBytes,
      audioDurationMs: input.audioDurationMs,
      elapsedMs: input.now() - startedAt,
    });
  }
  const rawDuration = fields['AudioDuration'];
  const providerAudioDurationMs = typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : null;

  return {
    observation: asrObservation({
      state: 'BUSINESS_RESPONSE',
      httpStatus: response.status,
      requestId,
      audioBytes: input.audioBytes,
      audioDurationMs: input.audioDurationMs,
      transcriptCharacters: characters,
      providerAudioDurationMs,
      resultMayHaveBeenProcessed: true,
      endpointAsserted: true,
      sendAttempts,
      elapsedMs: input.now() - startedAt,
    }),
    text,
  };
}

// ---------------------------------------------------------------------------
// 装配：被校验配置 → 端口。产品装配唯一入口（`createSpeechProvider` 内部调用）。
// ---------------------------------------------------------------------------

/** **明确未接线**的录音字节来源：对象存储属媒体域，本片未接线。诚实返回 `null`。 */
export function createUnwiredAudioSource(reason: string): AudioSource {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed，不伪造字节）`,
    async read() {
      return null;
    },
  };
}

/**
 * 由 `config.aiProviders.asr` 构造真实 ASR 提供者。
 * 构造失败不抛到请求期：调用方据此回落到接线前的 fail-closed 真实提供者，绝不降级成替身。
 */
export function createLiveSpeechProviderFromConfig(
  config: AsrProviderConfig,
  options: {
    audioSource: AudioSource;
    authorization: string;
    liveGate?: RealAsrPorts['liveGate'];
    fetchImpl?: typeof fetch;
    now?: () => number;
    onObservation?: (observation: LiveAsrObservation) => void;
  },
): SpeechProvider {
  return createLiveSpeechProvider({
    liveGate: options.liveGate ?? createProcessLiveGate({ authorization: options.authorization, prices: { asr: LIVE_UNIT_PRICES_CNY.asr } }),
    authorization: options.authorization,
    profile: {
      endpoint: config.endpoint,
      action: config.action,
      apiVersion: config.apiVersion,
      region: config.region,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      model: config.model,
      voiceFormat: config.voiceFormat,
      sampleRate: config.sampleRate,
      channels: config.channels,
      maxAudioSeconds: config.maxAudioSeconds,
      maxAudioBase64Bytes: config.maxAudioBase64Bytes,
    },
    credentials: config.credentials,
    audioSource: options.audioSource,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onObservation === undefined ? {} : { onObservation: options.onObservation }),
  });
}
