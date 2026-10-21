/**
 * GY-R28-W1 · 标签 OCR 真实适配器接线 · 注入式端口。
 *
 * 形状**照抄样板** `services/api/src/tts/live-ports.ts`（同一套「默认关闭」机制）：
 * 真实调用所需的全部向外能力（预算闸门、授权串、被校验配置快照、凭据三元组、
 * **图像字节来源**、fetch、时钟）都收进 `RealOcrPorts`，字段**全部必填**、没有默认实现；
 * 缺任一字段即构造失败 ⇒ 应用装配路径**不可能**不经意地打开真实外呼。
 *
 * 为什么 TTS 没有「字节来源」而 OCR 有：TTS 的正文来自服务端已核对内容，OCR 的输入是
 * **私有图片字节**，而 `OcrProvider.extract({jobId, mediaId, mediaRevision})` 只带引用、
 * 不带字节（服务层的媒体端口只回 `{ok, revision}`）。因此字节必须由**注入的端口**提供，
 * 而不是让适配器自己去读 ambient env、对象存储或本地磁盘（那会把「读哪张图」变成隐式行为）。
 * 产品装配当前注入的是**明确未接线**的来源（对象存储属媒体域，本片未接线）⇒ 仍然 fail-closed。
 *
 * ⛔ 本文件不含任何网络实现、不含任何凭据值、不读环境变量、不写台账。
 */
import type { ProviderCallState, LiveObservationErrorCode, LiveTc3Credentials, LiveCallGate } from '../tts/live-ports.ts';

/** 允许进入真实调用闸门的能力（与样板同一闭集；OCR 只用 `'ocr'`）。 */
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
 * 与 TTS 同源口径：OCR 用**共享配对** `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY`。
 */
export type LiveOcrCredentials = LiveTc3Credentials;

/**
 * **被校验过的配置快照**（`tools/ai-config.mjs` 的 `configurationIssues(config,'ocr')` 零 issue 才允许构造）。
 * 适配器在构造期再逐项断言一遍（纵深防御），任一项不符即拒绝构造。
 */
export interface LiveOcrProfile {
  /** **唯一允许**的目标端点：只能传 `AI_ENDPOINTS.ocr.endpoint`。 */
  readonly endpoint: string;
  readonly action: string;
  readonly apiVersion: string;
  /** 恒为 `ap-shanghai`（取自被校验配置，不取调用方入参）。 */
  readonly region: string;
  /** 1000..20000，取自被校验配置；**不采用调用方传入的超时**。 */
  readonly timeoutMs: number;
  /** 必须为 0：任何重发都是一次新的预留。 */
  readonly maxRetries: number;
  /** 供应商侧图片上限（字节）；超限 **fail-closed 不压缩、不裁剪**。 */
  readonly maxImageBytes: number;
  /** 恒为 `inlineBase64`（唯一允许的传输形态）。 */
  readonly mediaTransport: 'inlineBase64';
}

/**
 * 私有图片字节来源（注入式）。**只读**：拿不到字节就返回 `null`，绝不用占位图冒充。
 * `null` ⇒ 适配器按「取不到待识别图片」fail-closed（未发包、不占预算）。
 */
export interface OcrImageSource {
  readonly kind: 'wired' | 'unwired';
  /** 供证据／诊断引用的如实标注（不含任何图片内容或私有引用）。 */
  readonly note: string;
  read(input: { jobId: string; mediaId: string; mediaRevision: number }): Promise<Uint8Array | null>;
}

/** 真实 OCR 的全部向外能力。字段**全部必填**（除 fetch/now），缺一即无法构造 ⇒ 默认关闭。 */
export interface RealOcrPorts {
  /** 预算/台账闸门：没有闸门就不构造真实分支。 */
  readonly liveGate: LiveCallGate;
  /** 显式授权令牌：与闸门的授权串**逐字一致**（闸门自行复核）。 */
  readonly authorization: string;
  /** 被校验配置快照（见 `LiveOcrProfile`）。 */
  readonly profile: LiveOcrProfile;
  /** 凭据三元组（内存；见 `LiveOcrCredentials`）。 */
  readonly credentials: LiveOcrCredentials;
  /** 图片字节来源（见 `OcrImageSource`）：**必填**，没有它就拿不到要识别的图。 */
  readonly imageSource: OcrImageSource;
  /** 仅手工验证工具注入（可注入假函数以证明「走到即将发送」）；默认 `globalThis.fetch`。 */
  readonly fetchImpl?: typeof fetch;
  /** 仅可注入时钟（毫秒）；默认 `Date.now`。 */
  readonly now?: () => number;
  /** 取证钩子（**仅供手工验证工具**）：只接收 `LiveOcrObservation`，全是安全字段。 */
  readonly onObservation?: (observation: LiveOcrObservation) => void;
}

/**
 * 一次真实调用的**安全观测**（供证据文档与台账；**不含凭据、请求头值、签名、图片字节或识别正文**）。
 * 这是适配器解析结果的唯一真源，取证工具不得另写一份解析逻辑。
 */
export interface LiveOcrObservation {
  readonly capability: 'ocr';
  /** 适配器内部观测态（与样板同源取值）。 */
  readonly state: ProviderCallState;
  /** 契约错误码（仅失败时有意义；成功时为 `null`）。 */
  readonly errorCode: LiveObservationErrorCode | null;
  /** 供应商**原始**错误码（原样保留，不翻译）。 */
  readonly providerErrorCode: string | null;
  /** HTTP 状态码；未建连时为 `null`。 */
  readonly httpStatus: number | null;
  /** 供应商 RequestId（仅在格式合法时记录，否则 `null`）。 */
  readonly requestId: string | null;
  /** 检出的文本行数（`TextDetections` 长度）；未解析到时为 `null`。 */
  readonly detectionCount: number | null;
  /** 检出文本的**总字符数**（不含正文本身）：证明「确实读到了字」而不回显内容。 */
  readonly detectedCharacters: number | null;
  /** 送入请求的图片字节数；未发送/未取得字节时为 `null`。 */
  readonly imageBytes: number | null;
  /** 该次请求是否**无法排除**已被供应商处理。 */
  readonly resultMayHaveBeenProcessed: boolean;
  /** 从构造签名到响应解析完成的耗时（毫秒）。 */
  readonly elapsedMs: number;
  /** 发送前对「URL 与被校验配置端点逐字相等」的断言结果（恒应为 true）。 */
  readonly endpointAsserted: boolean;
  /** 实际发送次数（恒为 0 或 1；**零重试**由实现保证）。 */
  readonly sendAttempts: number;
}

/** 本地入参拒绝（图片超上限/格式非法/取不到字节）：映射到契约入参错误码，**未发包、不占预算**。 */
export class OcrLocalInputError extends Error {
  readonly code: 'INVALID_REQUEST' | 'OBJECT_UNAVAILABLE';

  constructor(code: 'INVALID_REQUEST' | 'OBJECT_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'OcrLocalInputError';
    this.code = code;
  }
}

/** 端口/配置自身不合法（构造期 fail-closed；绝不带着坏配置发包）。 */
export class OcrWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrWiringError';
  }
}
