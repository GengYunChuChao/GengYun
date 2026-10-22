/**
 * GY-R28-W1 · 普通话录音转写（ASR）真实适配器接线 · 注入式端口。
 *
 * 形状**照抄样板** `services/api/src/tts/live-ports.ts`（同一套「默认关闭」机制）：
 * 真实调用所需的全部向外能力（预算闸门、授权串、被校验配置快照、凭据三元组、
 * **音频字节来源**、fetch、时钟）都收进 `RealAsrPorts`，字段**全部必填**、没有默认实现；
 * 缺任一字段即构造失败 ⇒ 应用装配路径**不可能**不经意地打开真实外呼。
 *
 * 为什么 ASR 需要「字节来源」端口：`SpeechProvider.transcribe({jobId, mediaId, mediaRevision})`
 * 只带引用、不带录音字节（服务层媒体端口只回 `{ok, revision}`）。字节必须由**注入的端口**给，
 * 而不是让适配器读 ambient env / 磁盘 / 对象存储的隐式默认。产品装配当前注入**明确未接线**的来源
 * （对象存储属媒体域，本片未接线）⇒ 仍然 fail-closed。
 *
 * ⛔ 本文件不含任何网络实现、不含任何凭据值、不读环境变量、不写台账。
 */
import type { ProviderCallState, LiveObservationErrorCode, LiveTc3Credentials, LiveCallGate } from '../tts/live-ports.ts';

/** 允许进入真实调用闸门的能力（与样板同一闭集；ASR 只用 `'asr'`）。 */
export type { LiveCapability } from '../tts/live-ports.ts';
export {
  LIVE_GATE_ERROR_CODES,
  LIVE_GATE_REFUSALS,
  LIVE_OBSERVATION_ERROR_CODES,
  LiveGateRefusedError,
  liveGateRefusalToErrorCode,
  PROVIDER_CALL_STATES,
  type LiveCallGate,
  type LiveCallOutcome,
  type LiveCallTicket,
  type LiveGateErrorCode,
  type LiveGateRefusal,
  type LiveObservationErrorCode,
  type ProviderCallState,
} from '../tts/live-ports.ts';

/**
 * TC3 凭据三元组（**只在内存**；绝不入账本、绝不打印、绝不序列化）。
 * ASR 允许**专用子账号对**（`TENCENTCLOUD_ASR_SECRET_ID/KEY`），也允许回退共享对；
 * 具体用了哪一对由 `config.ts` 在同源配对前提下决定，适配器只认这份快照。
 */
export type LiveAsrCredentials = LiveTc3Credentials;

/** **被校验过的配置快照**（`configurationIssues(config,'asr')` 零 issue 才允许构造）。 */
export interface LiveAsrProfile {
  readonly endpoint: string;
  readonly action: string;
  readonly apiVersion: string;
  /** 恒为 `ap-shanghai`（取自被校验配置，不取调用方入参）。 */
  readonly region: string;
  /** 1000..20000，取自被校验配置；**不采用调用方传入的超时**。 */
  readonly timeoutMs: number;
  /** 必须为 0：任何重发都是一次新的预留。 */
  readonly maxRetries: number;
  /** 恒为 `16k_zh`。 */
  readonly model: '16k_zh';
  /** 恒为 `wav`。 */
  readonly voiceFormat: 'wav';
  /** 恒为 16000。 */
  readonly sampleRate: 16000;
  /** 恒为 1（单声道）。 */
  readonly channels: 1;
  /** 供应商侧时长上限（秒）；超限 **fail-closed 不裁剪**。 */
  readonly maxAudioSeconds: number;
  /** base64 后的字节上限。 */
  readonly maxAudioBase64Bytes: number;
}

/**
 * 私有录音字节来源（注入式）。**只读**：拿不到字节就返回 `null`，绝不用占位音频冒充。
 * `null` ⇒ 适配器按「取不到待转写录音」fail-closed（未发包、不占预算）。
 */
export interface AudioSource {
  readonly kind: 'wired' | 'unwired';
  /** 供证据／诊断引用的如实标注（不含任何录音内容或私有引用）。 */
  readonly note: string;
  read(input: { jobId: string; mediaId: string; mediaRevision: number }): Promise<Uint8Array | null>;
}

/** 真实 ASR 的全部向外能力。字段**全部必填**（除 fetch/now），缺一即无法构造 ⇒ 默认关闭。 */
export interface RealAsrPorts {
  readonly liveGate: LiveCallGate;
  readonly authorization: string;
  readonly profile: LiveAsrProfile;
  readonly credentials: LiveAsrCredentials;
  /** 录音字节来源（见 `AudioSource`）：**必填**，没有它就拿不到要转写的音频。 */
  readonly audioSource: AudioSource;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly onObservation?: (observation: LiveAsrObservation) => void;
}

/**
 * 一次真实调用的**安全观测**（**不含凭据、请求头值、签名、音频字节或转写正文**）。
 * 这是适配器解析结果的唯一真源，取证工具不得另写一份解析逻辑。
 */
export interface LiveAsrObservation {
  readonly capability: 'asr';
  readonly state: ProviderCallState;
  readonly errorCode: LiveObservationErrorCode | null;
  readonly providerErrorCode: string | null;
  readonly httpStatus: number | null;
  readonly requestId: string | null;
  /** 送入请求的音频字节数；未发送/未取得字节时为 `null`。 */
  readonly audioBytes: number | null;
  /** 音频时长（毫秒，由本地 WAV 头算出）；未发送时为 `null`。 */
  readonly audioDurationMs: number | null;
  /** 转写文本的**码点数**（不含正文本身）。 */
  readonly transcriptCharacters: number | null;
  /** `AudioDuration` 回显（毫秒；供应商未给时 `null`）——**只用于对账，不当质量证据**。 */
  readonly providerAudioDurationMs: number | null;
  readonly resultMayHaveBeenProcessed: boolean;
  readonly elapsedMs: number;
  readonly endpointAsserted: boolean;
  readonly sendAttempts: number;
}

/** 本地入参拒绝（音频超时长/超字节/格式非法/取不到字节）：**未发包、不占预算**。 */
export class AsrLocalInputError extends Error {
  readonly code: 'INVALID_REQUEST' | 'OBJECT_UNAVAILABLE';

  constructor(code: 'INVALID_REQUEST' | 'OBJECT_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'AsrLocalInputError';
    this.code = code;
  }
}

/** 端口/配置自身不合法（构造期 fail-closed；绝不带着坏配置发包）。 */
export class AsrWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsrWiringError';
  }
}
