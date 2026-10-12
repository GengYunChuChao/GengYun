/**
 * GY-I13 真实 TTS 适配器接线 · 注入式端口（**只在本域目录内，零共享文件**）。
 *
 * 规范来源：`E:\GengYunCommander\GengYun_W10\docs\verification\provider-adapter-live-wiring.md`
 * （另一位写手交付的接线方案 §2.1–§2.7；本文件是它在 #13 TTS 上的落地）。
 *
 * **为什么端口放在 `services/api/src/tts/` 而不是规范里的 `services/api/src/live/ports.ts`**：
 * 那是一个**跨能力共享路径**，W5（OCR）、W7（ASR）、W8（TTS）三条在途分支若同时新建它会直接冲突。
 * 本域沿用「零共享文件」纪律：端口形状与规范一致，路径只在本域内。
 *
 * **「默认关闭」的机制**：真实调用所需的全部向外能力（预算闸门、显式授权令牌、被校验配置快照、
 * 凭据三元组、fetch、时钟）都收进 `RealTtsPorts`。**应用装配路径（`createTtsProvider` /
 * `createRealTtsProvider`）没有注入端口的位置**，因此 `executionMode:'real'` 的行为与今天
 * **逐字节相同**（fail-closed）；只有 `createLiveTtsProvider(ports)` 能触达真实发送，
 * 而它由独立手工验证工具构造。默认关闭**不是**一个容易忘的开关，而是**类型上没有默认实现**：
 * `ports` 无默认值、无可选缺省，缺任一字段即构造失败。
 *
 * 本文件**不含**任何网络实现、不含任何凭据值、不读环境变量、不写账本。
 */
import type { ErrorCode } from '../contract.ts';

/** 允许进入真实调用闸门的能力。本分支只实现 `tts`；`ocr` / `asr` 在各自分支。 */
export type LiveCapability = 'tts' | 'ocr' | 'asr';

/** 闸门放行凭据。**只含「已预留多少」，不含任何密钥**。 */
export interface LiveCallTicket {
  readonly capability: LiveCapability;
  readonly authorization: string;
  readonly reservedCny: number;
  readonly attemptKey: string;
}

export const LIVE_GATE_REFUSALS = [
  /** 未提供显式授权令牌，或令牌与台账不一致 ⇒ 真实分支等价于「未接线」。 */
  'AUTHORIZATION_REQUIRED',
  /** 台账文件/进程锁缺失或不可读、完整性不成立 ⇒ 拒绝（绝不「先发了再记」）。 */
  'LEDGER_UNAVAILABLE',
  /** 超出总额/总条数/每能力次数上限。 */
  'BUDGET_OR_COUNT_EXCEEDED',
  /** 同一个尝试键已预留过 ⇒ 拒绝重发（防重复计费）。 */
  'ATTEMPT_ALREADY_RESERVED',
] as const;
export type LiveGateRefusal = (typeof LIVE_GATE_REFUSALS)[number];

export class LiveGateRefusedError extends Error {
  readonly refusal: LiveGateRefusal;

  constructor(refusal: LiveGateRefusal, message: string) {
    super(message);
    this.name = 'LiveGateRefusedError';
    this.refusal = refusal;
  }
}

/**
 * 适配器内部观测态（**不是**契约字段）。`BUSINESS_RESPONSE` 之外一律不得当作成功。
 * 取值与 `tools/verify-tencent-live.mjs` 的既有台账模型同源，便于两轮证据对读。
 */
export const PROVIDER_CALL_STATES = [
  /** HTTP 2xx + 载荷与回显校验全部通过。 */
  'BUSINESS_RESPONSE',
  /** HTTP 2xx + `Response.Error.Code`（供应商业务错误）。 */
  'SERVICE_ERROR',
  /** 非 2xx（网关/传输层）。 */
  'HTTP_ERROR',
  /** 供应商确实干活了但没有给出可用证据（RequestId/SessionId 缺失或格式非法）。 */
  'RESPONSE_EVIDENCE_INCOMPLETE',
  /** 超时（`AbortSignal.timeout`）。 */
  'TIMEOUT',
  /** 结果不可判定（传输失败、载荷非法、未知错误码）。 */
  'OUTCOME_UNKNOWN',
] as const;
export type ProviderCallState = (typeof PROVIDER_CALL_STATES)[number];

/** 落账结局。`actualChargeCny` 未知时必须是 `null`，**绝不猜一个数**。 */
export interface LiveCallOutcome {
  readonly state: ProviderCallState;
  readonly actualChargeCny: number | null;
  /** 供应商原始错误码原样保留（不翻译、不丢失）——供证据文档与对账，不是契约码。 */
  readonly providerErrorCode: string | null;
  /** true = 无法排除该次请求已被供应商处理（超时/传输失败/证据不完整）。 */
  readonly resultMayHaveBeenProcessed: boolean;
}

/**
 * 预算/台账闸门。**每次调用前必过**，且必须在任何签名与建连之前。
 * reserve-then-send：先落账（含「结果未知」），再发包——崩溃只会留下已预留记录，
 * 绝不会留下「扣了钱但没记账」的调用。
 */
export interface LiveCallGate {
  reserve(input: {
    capability: LiveCapability;
    authorization: string | null;
    attemptKey: string;
  }): Promise<LiveCallTicket>;
  /** **无论成败都必须调用**（成功、业务失败、超时、传输失败都要落账）。 */
  settle(ticket: LiveCallTicket, outcome: LiveCallOutcome): Promise<void>;
}

/**
 * 闸门拒绝**只能**产生这三个契约码（`TtsProviderOutcome.failed.code` 的失败码闭集子集）。
 * 返回值在类型上收窄，防止有人把本地闸门拒绝错映射成入参错误码。逐项对应规范 §2.6：
 * - `AUTHORIZATION_REQUIRED` / `LEDGER_UNAVAILABLE` ⇒ 503 `PROVIDER_UNAVAILABLE`（等价「未接线」，未发包、不占预算）；
 * - `BUDGET_OR_COUNT_EXCEEDED` ⇒ 429 `PROVIDER_QUOTA_EXCEEDED`（本地额度闸门，与供应商配额同语义码）；
 * - `ATTEMPT_ALREADY_RESERVED` ⇒ 503 `PROVIDER_OUTCOME_UNKNOWN`（结果不可判定，**绝不自动重发**）。
 */
export const LIVE_GATE_ERROR_CODES = [
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_QUOTA_EXCEEDED',
  'PROVIDER_OUTCOME_UNKNOWN',
] as const;
export type LiveGateErrorCode = (typeof LIVE_GATE_ERROR_CODES)[number];

/**
 * 一次真实调用**只能**产生这四个契约失败码（= `TtsProviderOutcome.failed.code` 的闭集，
 * 与 `provider.ts` 的 `PROVIDER_FAILURE_CODES` 逐项相同）。收窄类型可防止把本地拒绝
 * 错映射成入参错误码（那会把适配器缺陷或我们的入参问题推给客户端）。
 */
export const LIVE_OBSERVATION_ERROR_CODES = [...LIVE_GATE_ERROR_CODES, 'PROVIDER_TIMEOUT'] as const;
export type LiveObservationErrorCode = (typeof LIVE_OBSERVATION_ERROR_CODES)[number];

export function liveGateRefusalToErrorCode(error: unknown): LiveGateErrorCode {
  const refusal = error instanceof LiveGateRefusedError ? error.refusal : null;
  if (refusal === 'BUDGET_OR_COUNT_EXCEEDED') return 'PROVIDER_QUOTA_EXCEEDED';
  if (refusal === 'ATTEMPT_ALREADY_RESERVED') return 'PROVIDER_OUTCOME_UNKNOWN';
  // AUTHORIZATION_REQUIRED / LEDGER_UNAVAILABLE / 非闸门异常：一律按「不可用」fail-closed。
  return 'PROVIDER_UNAVAILABLE';
}

/**
 * **本地入参拒绝**（不是供应商故障）：文本超上限/为空/非字符串、端点或配置校验失败。
 * 由 service 映射为契约入参错误码（规范 §2.6：本地校验失败不入提供者失败码，
 * **未发包、不占预算**）。本域 TTS 的本地入参拒绝统一为 `INVALID_REQUEST`。
 */
export class TtsLocalInputError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'TtsLocalInputError';
    this.code = code;
  }
}

/** 端口/配置自身不合法（构造期 fail-closed；绝不带着坏配置发包）。 */
export class TtsWiringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsWiringError';
  }
}

/**
 * **被校验过的配置快照**（规范 §2.4/§2.5/§3.3）。
 * 由手工验证工具从 `docs/verification/config.local.json` 取值，且**必须先通过**
 * `tools/ai-config.mjs` 的 `configurationIssues(config,'tts')`（零 issue）才能构造；
 * 适配器在构造期再逐项断言一遍（纵深防御），任一项不符即拒绝构造。
 */
export interface LiveTtsProfile {
  /** **唯一允许**的目标端点：调用方只能传 `AI_ENDPOINTS['tts'].endpoint`。 */
  readonly endpoint: string;
  readonly action: string;
  readonly apiVersion: string;
  /** 恒为 `ap-shanghai`（取自被校验配置，**不取调用方入参**）。 */
  readonly region: string;
  /** 1000..20000，取自被校验配置；**不采用调用方传入的超时**。 */
  readonly timeoutMs: number;
  /** 必须为 0：任何重发都是一次新的预留（新授权 + 新台账条目）。 */
  readonly maxRetries: number;
  readonly voiceType: number;
  readonly codec: string;
  readonly sampleRate: number;
  /** 供应商侧文本上限（码点）；超限 **fail-closed 不截断**。 */
  readonly maxTextCharacters: number;
}

/**
 * TC3 凭据三元组（**只在内存中存在，绝不入账本、绝不打印、绝不序列化**）。
 * 同源口径：TTS 用**共享配对** `TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY`，
 * 临时凭据只读 `TENCENTCLOUD_SESSION_TOKEN`；**不逐字段混配、不回退**。
 * 长期密钥没有临时令牌时 `sessionToken` 显式为**空串**（不继承任何其它 token）。
 */
export interface LiveTtsCredentials {
  readonly secretId: string;
  readonly secretKey: string;
  readonly sessionToken: string;
}

/** 真实 TTS 的全部向外能力。字段**全部必填**（除 fetch/now），缺一即无法构造 ⇒ 默认关闭。 */
export interface RealTtsPorts {
  /** 预算/台账闸门：没有闸门就不构造真实分支。 */
  readonly liveGate: LiveCallGate;
  /** 显式授权令牌：与台账 `authorization` 常量**逐字一致**（闸门自行复核）。 */
  readonly authorization: string;
  /** 被校验配置快照（见 `LiveTtsProfile`）。 */
  readonly profile: LiveTtsProfile;
  /** 凭据三元组（内存；见 `LiveTtsCredentials`）。 */
  readonly credentials: LiveTtsCredentials;
  /** 仅手工验证工具注入（可注入假函数以证明「走到即将发送」）；默认 `globalThis.fetch`。 */
  readonly fetchImpl?: typeof fetch;
  /** 仅可注入时钟（毫秒）；默认 `Date.now`。 */
  readonly now?: () => number;
  /**
   * 取证钩子（**仅供手工验证工具**；应用装配路径永不提供端口，因此永不触发）。
   * 只接收 `LiveTtsObservation`——**全是安全字段**：不含凭据、Authorization、签名、音频字节或正文。
   */
  readonly onObservation?: (observation: LiveTtsObservation) => void;
}

/**
 * 一次真实调用的**安全观测**（供证据文档与台账；**不含任何凭据、请求头值、签名或音频字节**）。
 * 这是适配器解析结果的唯一真源，取证工具不得另写一份解析逻辑。
 */
export interface LiveTtsObservation {
  readonly capability: 'tts';
  /** 适配器内部观测态。 */
  readonly state: ProviderCallState;
  /** 契约错误码（仅失败时有意义；成功时为 `null`）。 */
  readonly errorCode: LiveObservationErrorCode | null;
  /** 供应商**原始**错误码（原样保留，不翻译）。 */
  readonly providerErrorCode: string | null;
  /** HTTP 状态码；未建连时为 `null`。 */
  readonly httpStatus: number | null;
  /** 供应商 RequestId（仅在格式合法时记录，否则 `null`）。 */
  readonly requestId: string | null;
  /** `SessionId` 回显是否与请求逐字一致；未判到时为 `null`。 */
  readonly sessionEchoOk: boolean | null;
  /** 解出的音频字节数；未取得合法音频时为 `null`。 */
  readonly audioBytes: number | null;
  /** 解出的字节是否带 MPEG/ID3 头（硬化校验；未判到时为 `null`）。 */
  readonly hasMpegHeader: boolean | null;
  /** 该次请求是否**无法排除**已被供应商处理（超时/传输失败/证据不完整/业务响应均为 true）。 */
  readonly resultMayHaveBeenProcessed: boolean;
  /** 从构造签名到响应解析完成的耗时（毫秒）。 */
  readonly elapsedMs: number;
  /** 发送前对「URL 与被校验配置端点逐字相等」的断言结果（恒应为 true）。 */
  readonly endpointAsserted: boolean;
  /** 实际发送次数（恒为 0 或 1；**零重试**由实现保证）。 */
  readonly sendAttempts: number;
}
