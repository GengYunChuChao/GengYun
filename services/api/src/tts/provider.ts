/**
 * GY-I13 普通话 TTS 合成域 · 提供者适配层（接口 + 执行模式实现）。
 *
 * 硬约束（派单 §2.5、§2.7）：
 * - `stub` / `preset_demo`：确定性的**明确标注替身**，**绝不冒充真实 TTS**；
 *   产物 `contentType` 是非音频的标注类型，`substitute=true`，正文是明文的「不可播放」标注，
 *   **不产生任何音频字节**，也不声称任何合成质量／音色／自然度结论。
 * - `real`：缺凭据一律 **fail-closed**（`available=false` ⇒ 受理前 503 `PROVIDER_UNAVAILABLE`）；
 *   **应用装配路径**（`createRealTtsProvider` / `createTtsProvider`）**没有注入端口的位置**，
 *   因此即便凭据齐备，`synthesize` 仍返回 `PROVIDER_UNAVAILABLE`（任务落 `failed`），
 *   行为与接线前**逐字节相同**；**严禁静默回退替身**。
 * - 真实发送**只**能经 `createLiveTtsProvider(ports)` 触达：端口字段全部必填、没有默认实现
 *   （见 `live-ports.ts` 的「默认关闭」机制）。端口由独立手工验证工具构造；
 *   应用装配路径永不提供该对象。真实适配器的调用顺序、签名、端点断言、超时与零重试、
 *   错误码映射见下方 `sendLiveTtsOnce` 与 `createLiveTtsProvider` 的注释。
 * - 提供者错误按契约映射：超时 → `PROVIDER_TIMEOUT`（任务 `timed_out`），
 *   配额 → `PROVIDER_QUOTA_EXCEEDED`，结果未知 → `PROVIDER_OUTCOME_UNKNOWN`，
 *   不可用 → `PROVIDER_UNAVAILABLE`。**不得**把提供者失败写成 `succeeded`。
 *
 * **证据口径（不得越界声称）**：真实 TTS 样本为 **0**
 * （`docs/evaluation/sample-gap-register.md` 的 `tts` 要求 30 段、实际 0），
 * 因此本文件与全域**不产生、不声称任何合成质量、音色、自然度或听感结论**；
 * 替身产物不是音频，不能播放，也不能当作任何语音证据。真实适配器接线**不改变**这条口径：
 * 一次可达性调用既不构成样本，也不构成任何质量结论。
 */
import type { ExecutionMode } from '../contract.ts';
import type { ErrorCode } from '../contract.ts';
import {
  liveGateRefusalToErrorCode,
  TtsLocalInputError,
  TtsWiringError,
  type LiveCallTicket,
  type LiveGateErrorCode,
  type LiveTtsCredentials,
  type LiveTtsObservation,
  type LiveTtsProfile,
  type ProviderCallState,
  type RealTtsPorts,
} from './live-ports.ts';
import { hasMpegAudioHeader } from './media.ts';
import { sha256Hex, signTc3Request } from './tc3.ts';

/**
 * 真实分支的错误类型随提供者一起导出：调用方（service / 手工装置）需要按类型区分
 * 「本地入参拒绝」（**未发包、不占预算**，落契约入参错误码）与「提供者故障」（落失败码闭集）。
 */
export { LiveGateRefusedError, TtsLocalInputError, TtsWiringError } from './live-ports.ts';

/** 提供者失败码：必须是契约 ErrorCode 闭集成员。 */
export const PROVIDER_FAILURE_CODES = [
  'PROVIDER_TIMEOUT',
  'PROVIDER_QUOTA_EXCEEDED',
  'PROVIDER_OUTCOME_UNKNOWN',
  'PROVIDER_UNAVAILABLE',
] as const;
export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];

export type TtsProviderOutcome =
  /**
   * 提供者给出产物（**未校验**；由 service 用 `requireSynthesisArtifact` 校验形状与
   * 「替身不得伪装成真实音频」）。形状为适配层约定，不是契约字段。
   */
  | { kind: 'completed'; artifact: unknown }
  /** 提供者失败：由 service 映射为 `failed` / `timed_out`，绝不落 `succeeded`。 */
  | { kind: 'failed'; code: ProviderFailureCode };

export interface TtsProvider {
  readonly executionMode: ExecutionMode;
  /** 提供者／音色版本标识，只写入内部记录与诊断，**不进**契约 `Synthesis`（契约没有该字段）。 */
  readonly providerVersion: string;
  /** 供证据／诊断引用的如实标注（替身说明，或真实适配器缺失说明）；不含任何凭据原文。 */
  readonly note: string;
  /** false 表示「现在就不该受理」：real 缺凭据时受理直接 503，不排队、不回退替身。 */
  readonly available: boolean;
  /** 不可用原因（不含凭据原文）。 */
  readonly unavailableReason: string | null;
  synthesize(input: {
    jobId: string;
    /** **服务端**从已核对内容读出的正文；提供者不得接受任何客户端文本。 */
    text: string;
    locale: string;
    targetRef: { type: string; id: string; revision: number };
  }): Promise<TtsProviderOutcome>;
}

/** 替身产物的 MIME 类型：明确标注的**非音频**类型（不得伪装成 audio/*）。 */
export const SUBSTITUTE_ARTIFACT_CONTENT_TYPE = 'application/x-gengyun-tts-substitute';

/** 替身产物正文前缀：所有替身字节都带此前缀，避免被误读成真实音频。 */
export const SUBSTITUTE_ARTIFACT_PREFIX = '替身占位产物（非真实音频、不可播放、非真实供应商）';

/** 替身产物的固定标注正文（**不是**音频字节，没有任何 MP3/ID3 头）。 */
export function substituteArtifactBody(targetRef: { type: string; id: string; revision: number }, text: string): Uint8Array {
  const marker = [
    SUBSTITUTE_ARTIFACT_PREFIX,
    `目标：${targetRef.type}/${targetRef.id}#${targetRef.revision}`,
    `将要朗读的正文码点数：${[...text].length}`,
    '如需真实音频，必须先接线已审真实 TTS 适配器；本文件不生成音频。',
  ].join('\n');
  return new TextEncoder().encode(marker);
}

/**
 * 替身提供者（`stub` / `preset_demo`）：**确定性**地返回同一份标注产物形状，
 * 不引入随机、不读取任何真实音频、不伪造时长或音色。
 */
export function createStubTtsProvider(options: { executionMode?: 'stub' | 'preset_demo' } = {}): TtsProvider {
  const executionMode = options.executionMode ?? 'stub';
  const isDemo = executionMode === 'preset_demo';
  const providerVersion = isDemo ? 'preset-demo-tts-v1' : 'stub-tts-v1';
  const note = isDemo
    ? '预设演示替身 TTS（**非真实音频**、非真实供应商；不构成任何合成质量或听感证据）'
    : '替身 TTS（**非真实音频**、非真实供应商；不构成任何合成质量或听感证据）';

  return {
    executionMode,
    providerVersion,
    note,
    available: true,
    unavailableReason: null,
    async synthesize({ text, targetRef }) {
      return {
        kind: 'completed',
        artifact: {
          contentType: SUBSTITUTE_ARTIFACT_CONTENT_TYPE,
          body: substituteArtifactBody(targetRef, text),
          substitute: true,
        },
      };
    },
  };
}

/**
 * 真实提供者（`real`）。**fail-closed**：
 * - 缺 endpoint/apiKey → `available=false`，受理直接 503 `PROVIDER_UNAVAILABLE`；
 * - 即使凭据齐备，本片也没有已审真实 TTS 供应商适配器，`synthesize` 仍返回
 *   `PROVIDER_UNAVAILABLE`，任务落 `failed`；
 * - 任何路径都**不会**回退到 stub/preset_demo 替身（回退会让证据口径被污染）。
 */
export function createRealTtsProvider(credentials: { endpoint?: string | null; apiKey?: string | null } = {}): TtsProvider {
  const endpoint =
    typeof credentials.endpoint === 'string' && credentials.endpoint.trim() !== '' ? credentials.endpoint.trim() : null;
  const apiKey = typeof credentials.apiKey === 'string' && credentials.apiKey.trim() !== '' ? credentials.apiKey.trim() : null;
  const missing = endpoint === null || apiKey === null;
  return {
    executionMode: 'real',
    providerVersion: 'real-unconfigured',
    note: '真实 TTS 适配器尚未接入（无已审供应商适配器；缺凭据即受理前 fail-closed，不回退替身）',
    available: !missing,
    unavailableReason: missing ? '缺少真实 TTS 供应商凭据（fail-closed，不回退替身）' : null,
    async synthesize() {
      // 无已审真实适配器：不伪造音频，也不回退替身。
      return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
    },
  };
}

/** 按执行模式选择提供者；`real` 永远走 fail-closed 实现。 */
export function createTtsProvider(input: {
  executionMode: ExecutionMode;
  endpoint?: string | null;
  apiKey?: string | null;
}): TtsProvider {
  if (input.executionMode === 'real') {
    return createRealTtsProvider({ endpoint: input.endpoint ?? null, apiKey: input.apiKey ?? null });
  }
  return createStubTtsProvider({ executionMode: input.executionMode });
}

// ---------------------------------------------------------------------------
// 真实适配器（`live`）· 只能经注入式端口触达；应用装配路径无法构造
// ---------------------------------------------------------------------------

/**
 * 冻结的 TTS 供应商剖面（契约**没有**规定这些值；它们是配置侧 `configurationIssues()` 锁定的口径）。
 * 适配器在**构造期**逐项断言：任一项不符即拒绝构造 —— 绝不带着坏配置发包。
 */
export const LIVE_TTS_FROZEN_PROFILE = Object.freeze({
  endpoint: 'https://tts.tencentcloudapi.com',
  action: 'TextToVoice',
  apiVersion: '2019-08-23',
  region: 'ap-shanghai',
  voiceType: 101001,
  codec: 'mp3',
  sampleRate: 16000,
  maxTextCharacters: 100,
  minTimeoutMs: 1000,
  maxTimeoutMs: 20000,
});

/**
 * 校验端口里的被校验配置快照。**纵深防御**：配置侧已挡一层（`ENDPOINT_NOT_ALLOWLISTED` 等），
 * 适配器再挡一层。任一项不符 ⇒ `TtsWiringError`（构造期失败，不发包）。
 */
export function assertLiveTtsProfile(profile: LiveTtsProfile): LiveTtsProfile {
  const frozen = LIVE_TTS_FROZEN_PROFILE;
  const reject = (label: string): never => {
    throw new TtsWiringError(`真实 TTS 配置不合法：${label}（fail-closed，未发包）`);
  };
  if (profile === null || typeof profile !== 'object') reject('缺少被校验配置快照');
  if (profile.endpoint !== frozen.endpoint) reject('endpoint 不是白名单端点');
  if (profile.action !== frozen.action) reject('action 不是 TextToVoice');
  if (profile.apiVersion !== frozen.apiVersion) reject('apiVersion 不是 2019-08-23');
  if (profile.region !== frozen.region) reject('region 不是被校验配置的固定区域');
  if (typeof profile.timeoutMs !== 'number' || !Number.isInteger(profile.timeoutMs) || profile.timeoutMs < frozen.minTimeoutMs || profile.timeoutMs > frozen.maxTimeoutMs) {
    reject(`timeoutMs 必须是被校验配置里的 ${frozen.minTimeoutMs}..${frozen.maxTimeoutMs} 整数`);
  }
  if (profile.maxRetries !== 0) reject('maxRetries 必须为 0（任何重发都是一次新的预留）');
  if (profile.voiceType !== frozen.voiceType) reject('voiceType 不是已锁定候选');
  if (profile.codec !== frozen.codec) reject('codec 不是 mp3');
  if (profile.sampleRate !== frozen.sampleRate) reject('sampleRate 不是 16000');
  if (profile.maxTextCharacters !== frozen.maxTextCharacters) reject(`maxTextCharacters 不是 ${frozen.maxTextCharacters}`);
  return profile;
}

/**
 * 本地文本校验（**build 阶段，先于任何预留**）：非字符串/空/超上限一律 `TtsLocalInputError`，
 * **fail-closed 且不截断**（截断会改变要朗读的正文含义）。
 * 码点口径与契约一致：`[...text].length`，不是 UTF-16 码元。
 */
export function requireLiveTtsText(raw: unknown, maxCodePoints: number): string {
  if (typeof raw !== 'string') throw new TtsLocalInputError('INVALID_REQUEST', '待合成文本必须是字符串');
  const codePoints = [...raw].length;
  if (codePoints === 0 || raw.trim().length === 0) {
    throw new TtsLocalInputError('INVALID_REQUEST', '待合成文本不得为空或纯空白');
  }
  if (codePoints > maxCodePoints) {
    throw new TtsLocalInputError(
      'INVALID_REQUEST',
      `待合成文本 ${codePoints} 码点超过供应商上限 ${maxCodePoints}（不截断，fail-closed）`,
    );
  }
  return raw;
}

/** `SessionId`：确定性、非个人（由任务与目标引用派生），供应商须原样回显。 */
export function deriveLiveSessionId(jobId: string, targetRef: { type: string; id: string; revision: number }): string {
  return `gy13-${sha256Hex(`${jobId}|${targetRef.type}/${targetRef.id}#${targetRef.revision}`).slice(0, 24)}`;
}

/**
 * 供应商业务错误码 → 契约 `ErrorCode`（规范 §2.6 表，逐项对应；**未发包不占预算的本地拒绝不走此表**）。
 * 供应商原始错误码由调用方**原样**写入台账，本函数只做契约映射。
 */
export function providerErrorCodeToErrorCode(code: string): LiveGateErrorCode {
  // 配额/限流类。
  if (/^(ResourceUnavailable\.ResourcePackageRunOut|UnsupportedOperation\.PkgExhausted)/.test(code)) return 'PROVIDER_QUOTA_EXCEEDED';
  if (/^(RequestLimitExceeded|LimitExceeded)/.test(code)) return 'PROVIDER_QUOTA_EXCEEDED';
  // 账号/服务/凭据不可用（对外不区分是哪一种，避免泄露账号状态）。
  if (/^(AuthFailure|UnauthorizedOperation)($|\.)/.test(code)) return 'PROVIDER_UNAVAILABLE';
  if (['InvalidCredential', 'FailedOperation.UnOpenError', 'FailedOperation.UserNotRegistered'].includes(code)) {
    return 'PROVIDER_UNAVAILABLE';
  }
  // `InvalidParameter*` / `MissingParameter`：请求体由服务端从已核对正文构造，
  // 参数错说明是**我们自己的适配器缺陷**，映射成 400 会把责任错误推给客户端 ⇒ 按「结果不可判定」处理。
  if (/^(InvalidParameter|MissingParameter)/.test(code)) return 'PROVIDER_OUTCOME_UNKNOWN';
  // `InternalError*` / `FailedOperation.ServiceIsolate` / 未知码：不声称可用，也不声称是干净失败。
  return 'PROVIDER_OUTCOME_UNKNOWN';
}

/**
 * 真实适配器（`live`）。**唯一**能触达真实发送的构造器：没有端口对象就构造不出来
 * （`RealTtsPorts` 的字段全部必填，且本函数没有默认实现）。
 *
 * 顺序是安全属性：**build(本地) → reserve(闸门) → sign(TC3) → send(恰好一次) → settle(无论成败)**。
 */
export function createLiveTtsProvider(ports: RealTtsPorts): TtsProvider {
  if (ports === null || typeof ports !== 'object') {
    throw new TtsWiringError('真实 TTS 端口缺失：真实分支默认关闭（应用装配路径永不提供端口）');
  }
  const profile = assertLiveTtsProfile(ports.profile);
  const credentials = ports.credentials;
  if (credentials === null || typeof credentials !== 'object') throw new TtsWiringError('真实 TTS 缺少凭据三元组');
  if (typeof credentials.secretId !== 'string' || credentials.secretId.trim() === '') {
    throw new TtsWiringError('真实 TTS 缺少 secretId（同源配对，不逐字段混配、不回退）');
  }
  if (typeof credentials.secretKey !== 'string' || credentials.secretKey.trim() === '') {
    throw new TtsWiringError('真实 TTS 缺少 secretKey（同源配对，不逐字段混配、不回退）');
  }
  if (typeof credentials.sessionToken !== 'string') {
    throw new TtsWiringError('真实 TTS 临时令牌必须是字符串（长期密钥显式空串，不继承其它 token）');
  }
  if (typeof ports.authorization !== 'string' || ports.authorization.trim() === '') {
    throw new TtsWiringError('真实 TTS 缺少显式授权令牌（与台账 authorization 逐字一致）');
  }
  const liveGate = ports.liveGate;
  if (liveGate === null || typeof liveGate !== 'object' || typeof liveGate.reserve !== 'function' || typeof liveGate.settle !== 'function') {
    throw new TtsWiringError('真实 TTS 缺少预算闸门（没有闸门就不构造真实分支）');
  }
  const fetchImpl = ports.fetchImpl ?? globalThis.fetch;
  const now = ports.now ?? ((): number => Date.now());
  const onObservation = ports.onObservation;

  return {
    executionMode: 'real',
    providerVersion: `tencent-tts-${profile.apiVersion}-voicetype${profile.voiceType}`,
    note: '真实 TTS 适配器（腾讯云 TextToVoice，共享凭据对；只能经注入式端口构造，应用装配路径不可达）',
    available: true,
    unavailableReason: null,
    async synthesize({ jobId, text, targetRef }) {
      // ① build（本地）——必须在 reserve 之前：本地拒绝**不占预算、不留账**。
      const liveText = requireLiveTtsText(text, profile.maxTextCharacters);
      const sessionId = deriveLiveSessionId(jobId, targetRef);
      const payload = {
        Text: liveText,
        SessionId: sessionId,
        ModelType: 1,
        PrimaryLanguage: 1,
        VoiceType: profile.voiceType,
        SampleRate: profile.sampleRate,
        Codec: profile.codec,
        Speed: 0,
        Volume: 0,
      };
      // **只序列化一次**：同一字符串既签名又当 body（HTTP 客户端绝不二次 JSON.stringify）。
      const body = JSON.stringify(payload);
      const attemptKey = `${jobId}:${targetRef.type}/${targetRef.id}#${targetRef.revision}`;

      // ② reserve（闸门，必须在签名与建连之前）。
      let ticket: LiveCallTicket;
      try {
        ticket = await liveGate.reserve({ capability: 'tts', authorization: ports.authorization, attemptKey });
      } catch (error) {
        // 闸门拒绝：**未发包、不占预算、不落账**（由闸门自己保证不留半条记录）。
        return { kind: 'failed', code: liveGateRefusalToErrorCode(error) };
      }

      // ③ sign ④ send（恰好一次）⑤ settle（无论成败）。
      const outcome = await sendLiveTtsOnce({
        endpoint: profile.endpoint,
        action: profile.action,
        apiVersion: profile.apiVersion,
        region: profile.region,
        timeoutMs: profile.timeoutMs,
        body,
        sessionId,
        credentials,
        fetchImpl,
        now,
      });
      const observed = outcome.observation;
      await liveGate.settle(ticket, {
        state: observed.state,
        // 未取得账单 ⇒ 恒为 null，绝不猜一个数。
        actualChargeCny: null,
        providerErrorCode: observed.providerErrorCode,
        resultMayHaveBeenProcessed: observed.resultMayHaveBeenProcessed,
      });
      onObservation?.(observed);
      if (observed.state !== 'BUSINESS_RESPONSE' || outcome.audio === null) {
        return { kind: 'failed', code: observed.errorCode ?? 'PROVIDER_OUTCOME_UNKNOWN' };
      }
      return {
        kind: 'completed',
        artifact: { contentType: 'audio/mpeg', body: outcome.audio, substitute: false },
      };
    },
  };
}

/** 一次发送的内部结果：安全观测 + 解出的音频字节（字节**只**交给 `SynthesisArtifact`，不进观测/台账）。 */
interface LiveSendResult {
  observation: LiveTtsObservation;
  audio: Uint8Array | null;
}

/** 供应商 RequestId 的保守格式口径（与 `tools/verify-tencent-live.mjs` 一致）。 */
const REQUEST_ID_PATTERN = /^[a-fA-F0-9-]{16,64}$/;
/** base64 长度上限（约 3 MB 编码后），防止把超大/畸形载荷当音频。 */
const MAX_AUDIO_BASE64_LENGTH = 3_000_000;

function observation(
  partial: Partial<LiveTtsObservation> & { state: ProviderCallState },
): LiveTtsObservation {
  return {
    capability: 'tts',
    errorCode: null,
    providerErrorCode: null,
    httpStatus: null,
    requestId: null,
    sessionEchoOk: null,
    audioBytes: null,
    hasMpegHeader: null,
    resultMayHaveBeenProcessed: true,
    elapsedMs: 0,
    endpointAsserted: false,
    sendAttempts: 0,
    ...partial,
  };
}

/**
 * **sign + send（恰好一次）+ 解析**。返回安全观测，**永不抛错**（任何异常都落成「结果不可判定」），
 * 因此调用方总能在 `finally` 语义下完成 `settle`。
 *
 * 硬约束：
 * - `url` 与被校验配置端点**逐字相等**、host 与 service 派生结果相等、无 query/附加 path，否则**不发送**；
 * - `redirect:'manual'`：**禁止跟随重定向**（否则签过名的请求可能被送到白名单外主机）；
 * - `signal: AbortSignal.timeout(timeoutMs)`：超时取被校验配置，**不采用调用方入参**；
 * - **零重试**：本函数只调用 `fetchImpl` 一次，任何失败都是终局（重发 = 一次新的预留）。
 */
async function sendLiveTtsOnce(input: {
  endpoint: string;
  action: string;
  apiVersion: string;
  region: string;
  timeoutMs: number;
  /** 已序列化的请求体：**同一字符串**既签名又当 body。 */
  body: string;
  sessionId: string;
  credentials: LiveTtsCredentials;
  fetchImpl: typeof fetch;
  now: () => number;
}): Promise<LiveSendResult> {
  const startedAt = input.now();
  /** 失败结局：只带安全观测，绝无音频字节。 */
  const failed = (partial: Partial<LiveTtsObservation> & { state: ProviderCallState }): LiveSendResult => ({
    observation: observation(partial),
    audio: null,
  });

  // 发送前的端点再断言（纵深防御；配置侧已有一层）。
  try {
    const parsed = new URL(input.endpoint);
    const expectedHost = `${parsed.hostname.split('.')[0]}.tencentcloudapi.com`;
    const allowlisted =
      input.endpoint === LIVE_TTS_FROZEN_PROFILE.endpoint &&
      parsed.host === expectedHost &&
      parsed.search === '' &&
      parsed.pathname === '/';
    if (!allowlisted) {
      return failed({ state: 'OUTCOME_UNKNOWN', sendAttempts: 0, elapsedMs: input.now() - startedAt });
    }
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
      // 已经是字符串：HTTP 客户端绝不二次 JSON.stringify。
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
      elapsedMs: input.now() - startedAt,
    });
  }

  // 非 2xx：网关/传输层异常。供应商业务错误按契约走 HTTP 200 + Response.Error，故此处不给业务码，
  // 也不解析错误页正文（避免把网关 HTML 当供应商载荷）。
  if (!response.ok) {
    return failed({
      state: 'HTTP_ERROR',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      endpointAsserted: true,
      sendAttempts,
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
      elapsedMs: input.now() - startedAt,
    });
  }
  const fields = result as Record<string, unknown>;
  const rawRequestId = fields['RequestId'];
  const requestId = typeof rawRequestId === 'string' && REQUEST_ID_PATTERN.test(rawRequestId) ? rawRequestId : null;

  if (!response.ok) {
    // 非 2xx 已在解析载荷之前返回 HTTP_ERROR；此处不可达，保留结构性防御。
    return failed({
      state: 'HTTP_ERROR',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      requestId,
      endpointAsserted: true,
      sendAttempts,
      elapsedMs: input.now() - startedAt,
    });
  }

  // 供应商业务错误：**原样保留**原始错误码（先于 RequestId 判定，避免丢掉分类）。
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
      elapsedMs: input.now() - startedAt,
    });
  }

  if (requestId === null) {
    // 供应商确实干活了（可能已计费）却没给出可追溯凭据 ⇒ 结果未知，绝不当成功。
    return failed({
      state: 'RESPONSE_EVIDENCE_INCOMPLETE',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      endpointAsserted: true,
      sendAttempts,
      elapsedMs: input.now() - startedAt,
    });
  }

  // SessionId 回显：官方接口原样返回调用方的 SessionId。
  const echoed = fields['SessionId'];
  const sessionEchoOk = typeof echoed === 'string' && echoed !== '' && echoed === input.sessionId;
  const rawAudio = fields['Audio'];
  const audioLooksBase64 =
    typeof rawAudio === 'string' &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(rawAudio) &&
    rawAudio.length < MAX_AUDIO_BASE64_LENGTH;
  if (!audioLooksBase64) {
    return failed({
      state: 'RESPONSE_EVIDENCE_INCOMPLETE',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      requestId,
      sessionEchoOk,
      endpointAsserted: true,
      sendAttempts,
      elapsedMs: input.now() - startedAt,
    });
  }
  const audio = Buffer.from(rawAudio, 'base64');
  const hasMpegHeader = audio.length > 0 ? hasMpegAudioHeader(audio) : false;
  if (audio.length === 0 || !hasMpegHeader) {
    // 空载荷，或解出来的根本不是 MPEG/ID3（避开把一段错误 JSON/HTML 当音频落库）。
    return failed({
      state: 'RESPONSE_EVIDENCE_INCOMPLETE',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      requestId,
      sessionEchoOk,
      audioBytes: audio.length,
      hasMpegHeader,
      endpointAsserted: true,
      sendAttempts,
      elapsedMs: input.now() - startedAt,
    });
  }
  if (!sessionEchoOk) {
    return failed({
      state: 'RESPONSE_EVIDENCE_INCOMPLETE',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      requestId,
      sessionEchoOk: false,
      audioBytes: audio.length,
      hasMpegHeader,
      endpointAsserted: true,
      sendAttempts,
      elapsedMs: input.now() - startedAt,
    });
  }
  return {
    observation: observation({
      state: 'BUSINESS_RESPONSE',
      errorCode: null,
      httpStatus: response.status,
      requestId,
      sessionEchoOk: true,
      audioBytes: audio.length,
      hasMpegHeader: true,
      resultMayHaveBeenProcessed: true,
      endpointAsserted: true,
      sendAttempts,
      elapsedMs: input.now() - startedAt,
    }),
    audio,
  };
}


