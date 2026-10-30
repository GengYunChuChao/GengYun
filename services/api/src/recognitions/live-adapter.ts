/**
 * GY-R70 · 拍草识别的**真实适配器**（live adapter）＋「凭据 → 端口」装配。
 *
 * 形状照抄两份既有样板（逐条对齐，不自创流程）：
 * - `services/api/src/ai/ocr-live-adapter.ts`：**build(本地) → reserve(闸门) → send(恰好一次) → settle(无论成败)**；
 *   端点再断言、`redirect:'manual'`、`AbortSignal.timeout(...)`、零重试、证据不足即「结果未知」。
 * - `services/api/src/ai/asr-live-adapter.ts`：本地拒绝**先于**预留（未发包、不占预算、不留台账）。
 *
 * ## 三条本域特有的硬约束
 * 1. **字节来自注入端口**（`RecognitionImageSource`），不来自 ambient env / 磁盘 / 对象存储的隐式
 *    默认；产品实现只读**去元数据衍生件**（见 `recognitions/image-source.ts`）。
 * 2. **只产出候选与原因，不决定任务状态**：状态仍由 `recognitions/state.ts` 的 `decideOutcome` 判定，
 *    因此本适配器**不可能**把一次失败写成 `succeeded`（无分数候选、上报分支都会落到 `uncertain`）。
 * 3. **绝不发明错误码**：本文件只会返回 `PROVIDER_FAILURE_CODES` 的四个成员
 *    （超时 / 配额 / 结果未知 / 不可用），映射表写在 `sendLiveRecognitionOnce` 与
 *    `recognize()` 的注释里，负控制逐条对应。
 *
 * ## 证据口径（不得外推）
 * 真实识别样本为 **0**（`docs/evaluation/sample-gap-register.md`），本基线也**没有**已审的识别供应商：
 * 本文件证明的是「适配器已接线、失败语义可判定、零凭据零发包」，**不证明**任何识别准确率，
 * 也不证明任何一次真实供应商调用成功。
 */
import type { ProviderOutcome, RecognitionProvider } from './provider.ts';
import {
  RECOGNITION_GATE_AUTHORIZATION,
  RecognitionLocalInputError,
  RecognitionWiringError,
  createProcessRecognitionGate,
  type LiveRecognitionCredentials,
  type LiveRecognitionObservation,
  type LiveRecognitionProfile,
  type RealRecognitionPorts,
  type RecognitionImageSource,
} from './live-ports.ts';
import { liveGateRefusalToErrorCode, type ProviderCallState } from '../tts/live-ports.ts';
import { FAILURE_BRANCHES, isFailureBranch, type FailureBranch } from './branches.ts';

/**
 * 冻结的识别调用剖面。`endpoint` 是唯一**不**冻结的字段（本基线没有已审供应商，见
 * `live-ports.ts` 的说明）：它由运维显式给出，并在构造期与**发送前**各断言一次形态。
 */
export const LIVE_RECOGNITION_FROZEN_PROFILE = Object.freeze({
  protocol: 'gy-recognition-live-v1',
  /** 与媒体域口径一致：`packages/media/constants.mjs` 的 `MEDIA_PURPOSE_MAX_BYTES.weed_recognition` = 2 MiB。 */
  maxImageBytes: 2 * 1024 * 1024,
  mediaTransport: 'inlineBase64' as const,
  /** 超时区间与 OCR/ASR 同口径（1s..20s）；默认取中位，避免把「慢供应商」与「悬挂」混为一谈。 */
  minTimeoutMs: 1000,
  maxTimeoutMs: 20000,
  defaultTimeoutMs: 15000,
  /** 候选条数上限（契约 `RecognitionResult.candidates` 至多 3 条）。 */
  maxCandidates: 3,
} as const);

/** 端点形态断言（构造期与发送前各一次）：只接受 https、无凭据、无查询串、无片段。 */
export function assertRecognitionEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') {
    throw new RecognitionWiringError('真实识别缺少供应商端点（fail-closed，未发包）');
  }
  const trimmed = endpoint.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new RecognitionWiringError('真实识别端点不是合法 URL（fail-closed，未发包）');
  }
  if (parsed.protocol !== 'https:') throw new RecognitionWiringError('真实识别端点必须是 https（fail-closed，未发包）');
  if (parsed.username !== '' || parsed.password !== '') {
    throw new RecognitionWiringError('真实识别端点不得内嵌凭据（fail-closed，未发包）');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new RecognitionWiringError('真实识别端点不得带查询串/片段（fail-closed，未发包）');
  }
  if (parsed.hostname === '') throw new RecognitionWiringError('真实识别端点缺少主机名（fail-closed，未发包）');
  return trimmed;
}

/** 构造期逐项校验剖面（纵深防御；端点形态另有一层）。 */
export function assertLiveRecognitionProfile(profile: LiveRecognitionProfile): LiveRecognitionProfile {
  const frozen = LIVE_RECOGNITION_FROZEN_PROFILE;
  const reject = (label: string): never => {
    throw new RecognitionWiringError(`真实识别配置不合法：${label}（fail-closed，未发包）`);
  };
  if (profile === null || typeof profile !== 'object') reject('缺少被校验配置快照');
  if (profile.protocol !== frozen.protocol) reject(`protocol 不是 ${frozen.protocol}`);
  assertRecognitionEndpoint(profile.endpoint);
  if (
    typeof profile.timeoutMs !== 'number'
    || !Number.isInteger(profile.timeoutMs)
    || profile.timeoutMs < frozen.minTimeoutMs
    || profile.timeoutMs > frozen.maxTimeoutMs
  ) {
    reject(`timeoutMs 必须是 ${frozen.minTimeoutMs}..${frozen.maxTimeoutMs} 的整数`);
  }
  if (profile.maxRetries !== 0) reject('maxRetries 必须为 0（任何重发都是一次新的预留）');
  if (profile.maxImageBytes !== frozen.maxImageBytes) reject(`maxImageBytes 不是 ${frozen.maxImageBytes}`);
  if (profile.mediaTransport !== frozen.mediaTransport) reject('mediaTransport 不是 inlineBase64');
  return profile;
}

/**
 * 本地图片校验（**先于预留**）：PNG/JPEG 头 + 字节上限。
 *
 * 头部口径与 `ai/ocr-live-adapter.ts` 的 `requireLiveOcrImage()` 逐条相同（只嗅探头部，不做完整解码，
 * 也不在这里剥 EXIF —— 剥元数据是媒体域衍生件的职责，本适配器只吃衍生件）。
 * `image/webp` 虽是 `weed_recognition` 的合法上传类型，但本适配器不解码它 ⇒ **明确拒绝**，
 * 而不是把「不受支持」推迟到供应商并说成「图片非法」。
 */
export function requireLiveRecognitionImage(raw: unknown, maxImageBytes: number): Uint8Array {
  if (!(raw instanceof Uint8Array) || raw.length === 0) {
    throw new RecognitionLocalInputError('PROVIDER_UNAVAILABLE', '取不到待识别图片字节（fail-closed，未发包）');
  }
  if (raw.length > maxImageBytes) {
    throw new RecognitionLocalInputError(
      'PROVIDER_UNAVAILABLE',
      `图片 ${raw.length} 字节超过供应商上限 ${maxImageBytes}（不压缩、不裁剪，fail-closed）`,
    );
  }
  const png =
    raw.length >= 24
    && Buffer.from(raw.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && Buffer.from(raw.subarray(12, 16)).toString('ascii') === 'IHDR'
    && Buffer.from(raw).readUInt32BE(16) > 0
    && Buffer.from(raw).readUInt32BE(20) > 0;
  const jpeg =
    raw.length >= 4
    && raw[0] === 0xff
    && raw[1] === 0xd8
    && raw[2] === 0xff
    && raw[raw.length - 2] === 0xff
    && raw[raw.length - 1] === 0xd9;
  if (!png && !jpeg) {
    throw new RecognitionLocalInputError('PROVIDER_UNAVAILABLE', '图片头部不是 PNG/JPEG（fail-closed，未发包）');
  }
  return raw;
}

/** 未接线的图片字节来源：恒 `null`。**它不是替身**——不产字节、不伪造图片。 */
export function createUnwiredRecognitionImageSource(reason: string): RecognitionImageSource {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed，不伪造字节）`,
    async read() {
      return null;
    },
  };
}

/**
 * **唯一**能触达真实发送的构造器：没有端口对象就构造不出来（`RealRecognitionPorts`
 * 字段全部必填，且本函数没有默认实现）。
 */
export function createLiveRecognitionProvider(ports: RealRecognitionPorts): RecognitionProvider {
  if (ports === null || typeof ports !== 'object') {
    throw new RecognitionWiringError('真实识别端口缺失：真实分支默认关闭（应用装配路径必须显式给端口）');
  }
  const profile = assertLiveRecognitionProfile(ports.profile);
  const credentials = ports.credentials;
  if (credentials === null || typeof credentials !== 'object') throw new RecognitionWiringError('真实识别缺少凭据');
  if (typeof credentials.apiKey !== 'string' || credentials.apiKey.trim() === '') {
    throw new RecognitionWiringError('真实识别缺少 apiKey（不回退、不逐字段混配）');
  }
  if (typeof ports.authorization !== 'string' || ports.authorization.trim() === '') {
    throw new RecognitionWiringError('真实识别缺少显式授权令牌（与闸门授权串逐字一致）');
  }
  const imageSource = ports.imageSource;
  if (imageSource === null || typeof imageSource !== 'object' || typeof imageSource.read !== 'function') {
    throw new RecognitionWiringError('真实识别缺少图片字节来源端口（没有它就拿不到要识别的照片）');
  }
  const liveGate = ports.liveGate ?? createProcessRecognitionGate({ authorization: ports.authorization });
  if (typeof liveGate.reserve !== 'function' || typeof liveGate.settle !== 'function') {
    throw new RecognitionWiringError('真实识别缺少预算闸门（没有闸门就不构造真实分支）');
  }
  const fetchImpl = ports.fetchImpl ?? globalThis.fetch;
  const now = ports.now ?? ((): number => Date.now());
  const onObservation = ports.onObservation;

  return {
    executionMode: 'real',
    // 本基线**没有**已审厂商模型 ⇒ 如实写协议版本，绝不写一个模型名（那会变成未经验证的能力主张）。
    modelVersion: profile.protocol,
    available: true,
    unavailableReason: null,
    async recognize({ jobId, mediaId, mediaRevision }): Promise<ProviderOutcome> {
      // ① build（本地）——必须在 reserve 之前：本地拒绝**不占预算、不留账、不建连**。
      let image: Uint8Array;
      try {
        const raw = await imageSource.read({ mediaId, mediaRevision });
        image = requireLiveRecognitionImage(raw, profile.maxImageBytes);
      } catch {
        // 取不到/图片不合法：不打供应商，也不把它说成供应商故障（码仍是既有闭集成员）。
        return { kind: 'failed', code: 'PROVIDER_UNAVAILABLE' };
      }
      const body = JSON.stringify({
        protocol: profile.protocol,
        media: {
          content_type: contentTypeOf(image),
          bytes_base64: Buffer.from(image).toString('base64'),
        },
        media_revision: mediaRevision,
      });
      const attemptKey = `${jobId}:${mediaId}#${mediaRevision}`;

      // ② reserve（闸门，必须在建连之前）：拒绝闭集由 `liveGateRefusalToErrorCode()` 映射，与 TTS/OCR 同一份。
      let ticket;
      try {
        ticket = await liveGate.reserve({ authorization: ports.authorization, attemptKey });
      } catch (error) {
        return { kind: 'failed', code: liveGateRefusalToErrorCode(error) };
      }

      // ③ send（恰好一次）④ settle（无论成败）。
      const outcome = await sendLiveRecognitionOnce({
        endpoint: profile.endpoint,
        protocol: profile.protocol,
        timeoutMs: profile.timeoutMs,
        body,
        imageBytes: image.length,
        apiKey: credentials.apiKey,
        fetchImpl,
        now,
      });
      const observed = outcome.observation;
      await liveGate.settle(ticket, {
        state: observed.state,
        // 未取得账单 ⇒ 恒为 null，绝不猜一个数（识别域在本基线没有已审单价）。
        providerErrorCode: observed.providerErrorCode,
        resultMayHaveBeenProcessed: observed.resultMayHaveBeenProcessed,
      });
      onObservation?.(observed);
      if (observed.state !== 'BUSINESS_RESPONSE' || outcome.candidates === null) {
        return { kind: 'failed', code: observed.errorCode ?? 'PROVIDER_OUTCOME_UNKNOWN' };
      }
      // 空候选是「正常调用但没结果」：显式上报 `no_result` 分支（仍由 `decideOutcome` 判 uncertain）。
      const branch: FailureBranch | undefined = outcome.branch ?? (outcome.candidates.length === 0 ? 'no_result' : undefined);
      return {
        kind: 'completed',
        candidates: outcome.candidates,
        uncertainty_reasons: outcome.uncertaintyReasons,
        ...(branch === undefined ? {} : { branch }),
      };
    },
  };
}

/** 头部嗅探（仅用于报文里的 `content_type`；不做解码，不改字节）。 */
function contentTypeOf(image: Uint8Array): 'image/png' | 'image/jpeg' {
  const png = image.length >= 8 && Buffer.from(image.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  return png ? 'image/png' : 'image/jpeg';
}

interface LiveRecognitionSendResult {
  observation: LiveRecognitionObservation;
  /** 提供者给出的候选（**只在成功时**给出；内容不进观测/台账）。 */
  candidates: unknown[] | null;
  uncertaintyReasons: unknown;
  branch: FailureBranch | null;
}

/** 供应商 RequestId 形态（不强制某家前缀：只要求是可追溯的定长 token）。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function observation(partial: Partial<LiveRecognitionObservation> & { state: ProviderCallState }): LiveRecognitionObservation {
  return {
    protocol: LIVE_RECOGNITION_FROZEN_PROFILE.protocol,
    errorCode: null,
    providerErrorCode: null,
    httpStatus: null,
    requestId: null,
    candidateCount: null,
    imageBytes: null,
    resultMayHaveBeenProcessed: true,
    elapsedMs: 0,
    endpointAsserted: false,
    sendAttempts: 0,
    ...partial,
  };
}

/**
 * **send（恰好一次）+ 解析**。返回安全观测，**永不抛错**（任何异常都落成「结果不可判定」），
 * 因此调用方总能在 `finally` 语义下完成 `settle`。
 *
 * 错误映射（**只用既有契约码**，逐条对应交付回报里的负控制）：
 * | 触发条件 | 观测态 | 契约码 |
 * | --- | --- | --- |
 * | 端点再断言失败（非 https / 带凭据 / 带查询串） | `OUTCOME_UNKNOWN` | `PROVIDER_OUTCOME_UNKNOWN`（零发包） |
 * | `AbortSignal.timeout` 触发（`TimeoutError`/`AbortError`） | `TIMEOUT` | `PROVIDER_TIMEOUT` |
 * | 其它传输失败（DNS/连接重置/TLS） | `OUTCOME_UNKNOWN` | `PROVIDER_OUTCOME_UNKNOWN`（无法排除已处理） |
 * | HTTP 429 | `HTTP_ERROR` | `PROVIDER_QUOTA_EXCEEDED` |
 * | HTTP 401 / 403 / 5xx | `HTTP_ERROR` | `PROVIDER_UNAVAILABLE` |
 * | 其它非 2xx（400/404/409/422…） | `HTTP_ERROR` | `PROVIDER_OUTCOME_UNKNOWN`（协议/入参不符，不是结果） |
 * | 响应体不是 JSON | `OUTCOME_UNKNOWN` | `PROVIDER_OUTCOME_UNKNOWN` |
 * | 缺 `request_id` / 候选不是数组 / 候选超过 3 条 / 分支不在闭集 | `RESPONSE_EVIDENCE_INCOMPLETE` | `PROVIDER_OUTCOME_UNKNOWN` |
 */
async function sendLiveRecognitionOnce(input: {
  endpoint: string;
  protocol: string;
  timeoutMs: number;
  body: string;
  imageBytes: number;
  apiKey: string;
  fetchImpl: typeof fetch;
  now: () => number;
}): Promise<LiveRecognitionSendResult> {
  const startedAt = input.now();
  const failed = (
    partial: Partial<LiveRecognitionObservation> & { state: ProviderCallState },
  ): LiveRecognitionSendResult => ({
    observation: observation(partial),
    candidates: null,
    uncertaintyReasons: undefined,
    branch: null,
  });

  // 发送前的端点再断言（纵深防御；构造期已有一层）。
  try {
    if (assertRecognitionEndpoint(input.endpoint) !== input.endpoint) {
      return failed({ state: 'OUTCOME_UNKNOWN', sendAttempts: 0, elapsedMs: input.now() - startedAt });
    }
  } catch {
    return failed({ state: 'OUTCOME_UNKNOWN', sendAttempts: 0, elapsedMs: input.now() - startedAt });
  }

  let response: Response;
  let sendAttempts = 0;
  try {
    sendAttempts = 1;
    response = await input.fetchImpl(input.endpoint, {
      method: 'POST',
      body: input.body,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${input.apiKey}`,
        'x-gy-protocol': input.protocol,
      },
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
      imageBytes: input.imageBytes,
      elapsedMs: input.now() - startedAt,
    });
  }

  if (!response.ok) {
    return failed({
      state: 'HTTP_ERROR',
      errorCode: errorCodeForStatus(response.status),
      httpStatus: response.status,
      endpointAsserted: true,
      sendAttempts,
      imageBytes: input.imageBytes,
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
      imageBytes: input.imageBytes,
      elapsedMs: input.now() - startedAt,
    });
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return failed({
      state: 'RESPONSE_EVIDENCE_INCOMPLETE',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      endpointAsserted: true,
      sendAttempts,
      imageBytes: input.imageBytes,
      elapsedMs: input.now() - startedAt,
    });
  }
  const fields = payload as Record<string, unknown>;
  const rawRequestId = fields['request_id'];
  const requestId = typeof rawRequestId === 'string' && REQUEST_ID_PATTERN.test(rawRequestId) ? rawRequestId : null;
  if (requestId === null) {
    // 供应商确实干活了（可能已计费）却没给出可追溯凭据 ⇒ 结果未知，绝不当成功。
    return failed({
      state: 'RESPONSE_EVIDENCE_INCOMPLETE',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      endpointAsserted: true,
      sendAttempts,
      imageBytes: input.imageBytes,
      elapsedMs: input.now() - startedAt,
    });
  }

  const rawCandidates = fields['candidates'];
  // 只做「有界 + 形状」这一层：候选字段的语义校验（rank 重复 / 缺字段 / 分数范围）**唯一**在
  // `recognitions/state.ts` 的 `decideOutcome` 里，避免两处各写一份。
  if (!Array.isArray(rawCandidates) || rawCandidates.length > LIVE_RECOGNITION_FROZEN_PROFILE.maxCandidates) {
    return failed({
      state: 'RESPONSE_EVIDENCE_INCOMPLETE',
      errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
      httpStatus: response.status,
      requestId,
      endpointAsserted: true,
      sendAttempts,
      imageBytes: input.imageBytes,
      elapsedMs: input.now() - startedAt,
    });
  }

  const rawBranch = fields['branch'];
  let branch: FailureBranch | null = null;
  if (rawBranch !== undefined && rawBranch !== null) {
    // 非闭集成员 = 协议违规（不得静默忽略，也不得猜一个最接近的分支）。
    if (!isFailureBranch(rawBranch)) {
      return failed({
        state: 'RESPONSE_EVIDENCE_INCOMPLETE',
        errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
        httpStatus: response.status,
        requestId,
        endpointAsserted: true,
        sendAttempts,
        imageBytes: input.imageBytes,
        elapsedMs: input.now() - startedAt,
      });
    }
    branch = rawBranch;
  }

  return {
    observation: observation({
      state: 'BUSINESS_RESPONSE',
      httpStatus: response.status,
      requestId,
      candidateCount: rawCandidates.length,
      imageBytes: input.imageBytes,
      resultMayHaveBeenProcessed: true,
      endpointAsserted: true,
      sendAttempts,
      elapsedMs: input.now() - startedAt,
    }),
    candidates: rawCandidates,
    uncertaintyReasons: fields['uncertainty_reasons'],
    branch,
  };
}

/** HTTP 状态 → 契约码（闭集四值，见 `sendLiveRecognitionOnce` 的映射表）。 */
function errorCodeForStatus(status: number): 'PROVIDER_QUOTA_EXCEEDED' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_OUTCOME_UNKNOWN' {
  if (status === 429) return 'PROVIDER_QUOTA_EXCEEDED';
  if (status === 401 || status === 403 || status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_OUTCOME_UNKNOWN';
}

/**
 * 由「显式凭据 + 显式字节来源」装配真实识别提供者。
 *
 * - 端点/剖面/凭据任一不合法 ⇒ **抛** `RecognitionWiringError`（构造期），由调用方
 *   （`recognitions/provider.ts` 的 `createRecognitionProvider`）回落到 `real` 的 fail-closed 实现，
 *   ⛔ **绝不**回退 `stub` / `preset_demo` 替身；
 * - `liveGate` 不给 ⇒ 自建进程内闸门（授权串必须与 `authorization` 逐字一致，否则每次 `reserve` 都拒）。
 */
export function createLiveRecognitionProviderFromCredentials(input: {
  endpoint: string;
  apiKey: string;
  imageSource: RecognitionImageSource;
  authorization?: string;
  liveGate?: RealRecognitionPorts['liveGate'];
  fetchImpl?: typeof fetch;
  now?: () => number;
  onObservation?: (observation: LiveRecognitionObservation) => void;
}): RecognitionProvider {
  if (input === null || typeof input !== 'object') {
    throw new RecognitionWiringError('真实识别装配缺少入参（fail-closed）');
  }
  const authorization = input.authorization ?? RECOGNITION_GATE_AUTHORIZATION;
  const profile: LiveRecognitionProfile = {
    protocol: LIVE_RECOGNITION_FROZEN_PROFILE.protocol,
    endpoint: assertRecognitionEndpoint(input.endpoint),
    timeoutMs: LIVE_RECOGNITION_FROZEN_PROFILE.defaultTimeoutMs,
    maxRetries: 0,
    maxImageBytes: LIVE_RECOGNITION_FROZEN_PROFILE.maxImageBytes,
    mediaTransport: LIVE_RECOGNITION_FROZEN_PROFILE.mediaTransport,
  };
  const credentials: LiveRecognitionCredentials = { apiKey: input.apiKey };
  return createLiveRecognitionProvider({
    profile,
    credentials,
    authorization,
    imageSource: input.imageSource,
    ...(input.liveGate === undefined ? {} : { liveGate: input.liveGate }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.onObservation === undefined ? {} : { onObservation: input.onObservation }),
  });
}

/** 分支闭集（供装配层与测试断言，避免两处各写一份清单）。 */
export const LIVE_RECOGNITION_BRANCHES: readonly FailureBranch[] = FAILURE_BRANCHES;
