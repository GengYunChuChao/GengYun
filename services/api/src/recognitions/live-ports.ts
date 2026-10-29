/**
 * GY-R70 · 识别域（拍草识别）**真实调用**的端口接口：凭据 / 被校验剖面 / 图片字节来源 /
 * 预算闸门 / 观测读数。
 *
 * 形状照抄既有样板：`services/api/src/ai/ocr-live-ports.ts`（同目录 `ocr-live-adapter.ts` 用它）
 * 与 `services/api/src/speech/live-ports.ts`。三处共用同一套**语义**（本地 build 先于预留、
 * 预留先于建连、恰好发送一次、无论成败都结算），实现各域只写一份。
 *
 * 本文件**不做任何 IO**、不读 ambient env、不 import 文件系统：它只有类型、一个授权串常量、
 * 一个进程内闸门实现与两个错误类。真正的发包在 `live-adapter.ts`。
 *
 * ## 为什么识别域的闸门不使用 `ai/live-gate.ts` 的 `LiveCapability`
 * 那份实现的 `capability` 是**跨域共用闭集**（`tts | ocr | asr`，见 `tts/live-ports.ts`），
 * 而识别域的供应商单价在本基线**没有**已审口径（`LIVE_UNIT_PRICES_CNY` 里没有识别项）。
 * 把它硬塞进那个闭集等于为「识别调用多少钱」凭空立一个数，也会改动三个域共用的类型。
 * 因此这里只复用**拒绝闭集**（`LiveGateRefusedError` + `LIVE_GATE_REFUSALS`）与到契约码的
 * 既有映射（`liveGateRefusalToErrorCode()`），不新增能力项、不新增错误码。
 */
import { LiveGateRefusedError, type LiveObservationErrorCode, type ProviderCallState } from '../tts/live-ports.ts';
import type { ErrorCode } from '../contract.ts';

/**
 * 产品路径的授权串（**不是密钥**）：只用于断言「闸门被显式接入」这件事。
 * 与 `ai/live-gate.ts` 的 `PRODUCT_GATE_AUTHORIZATION` 同一用途、不同域命名空间
 * （识别域的单价口径独立，故不复用那一串的音色/OCR 语义）。
 */
export const RECOGNITION_GATE_AUTHORIZATION = 'gy-r70-recognition-live-v1';

/** 内存凭据（**只在本进程内**；不落库、不进日志、不进任何返回值）。 */
export interface LiveRecognitionCredentials {
  readonly apiKey: string;
}

/**
 * 被校验的调用剖面。**构造期逐项断言**（`live-adapter.ts` 的 `assertLiveRecognitionProfile`），
 * 任一项不符即拒绝构造 ⇒ 上层回落 `real` 的 fail-closed 实现（绝不回退替身）。
 *
 * ⚠ 与腾讯云 OCR/ASR 的**唯一刻意差异**：本基线**没有**已审的识别供应商，因此 `endpoint`
 * 无法冻结成白名单常量，它由运维经 `RECOGNITION_PROVIDER_URL` 显式给出。剩下的字段一律冻结
 * （超时区间、重试次数 0、字节上限、传输方式、协议版本），并在发送前**再断言一次端点形态**。
 */
export interface LiveRecognitionProfile {
  /** 线上协议版本（本基线只有一个取值）；同时用作写入识别的 `model_version`。 */
  readonly protocol: string;
  /** 供应商端点（https、无凭据、无查询串、无片段）。 */
  readonly endpoint: string;
  readonly timeoutMs: number;
  /** 必须是 `0`：任何重发都是一次**新的**预留与一次新的计费。 */
  readonly maxRetries: number;
  readonly maxImageBytes: number;
  readonly mediaTransport: 'inlineBase64';
}

/**
 * 待识别图片字节来源。**字节只能从这里来**：不读 ambient env、不回退磁盘默认路径、
 * 不伪造字节。`read()` 返回 `null` ⇒ 适配器按「取不到字节」fail-closed（未发包）。
 *
 * 产品实现见 `recognitions/image-source.ts`（按 `media_id` + `revision` 从媒体登记册 +
 * 媒体域对象存储取**去元数据衍生件**）。`ownerUserId` 是**可选**的归属主体：
 * 媒体引用端口（受理前）会给，它用来拒绝越权；适配器侧只拿引用、没有主体，故不传。
 */
export interface RecognitionImageSource {
  /** `wired` = 已接真实端口；`unwired` = 未接线（恒 `null`，**不是替身**：不产字节）。 */
  readonly kind: string;
  /** 供证据文档/诊断引用的如实说明（不含任何私有媒体引用）。 */
  readonly note: string;
  read(input: { mediaId: string; mediaRevision: number; ownerUserId?: string }): Promise<Uint8Array | null>;
}

/** 闸门放行凭据。**只含「已预留多少」，不含任何密钥**。 */
export interface LiveRecognitionTicket {
  readonly attemptKey: string;
  readonly authorization: string;
  readonly reservedCny: number;
}

/** 结算输入（与 `tts/live-ports.ts` 的 `LiveCallOutcome` 同形，去掉音频专属字段）。 */
export interface LiveRecognitionSettlement {
  readonly state: ProviderCallState;
  readonly providerErrorCode: string | null;
  /** true = **无法排除**该次请求已被供应商处理（超时/传输失败/证据不完整）。 */
  readonly resultMayHaveBeenProcessed: boolean;
}

/**
 * 预算/去重闸门。**每次调用前必过**，且必须在任何建连之前：
 * 预留失败 ⇒ 零发包；同一次尝试（`jobId:mediaId#revision`）第二次一律拒绝（绝不重发）。
 */
export interface LiveRecognitionGate {
  reserve(input: { authorization: string | null; attemptKey: string }): Promise<LiveRecognitionTicket>;
  settle(ticket: LiveRecognitionTicket, outcome: LiveRecognitionSettlement): Promise<void>;
}

/** 一次真实调用的**安全观测**（不含请求正文、不含凭据、不含图片内容）。 */
export interface LiveRecognitionObservation {
  readonly protocol: string;
  readonly state: ProviderCallState;
  readonly errorCode: LiveObservationErrorCode | null;
  readonly providerErrorCode: string | null;
  readonly httpStatus: number | null;
  readonly requestId: string | null;
  readonly candidateCount: number | null;
  readonly imageBytes: number | null;
  readonly resultMayHaveBeenProcessed: boolean;
  readonly elapsedMs: number;
  readonly endpointAsserted: boolean;
  readonly sendAttempts: number;
}

/**
 * 真实识别提供者的**全部注入端口**。每个字段都必填（`liveGate` 除外，可由装配器自建）：
 * 没有端口对象就构造不出真实分支 —— 这是「零端口注入」的结构性保证。
 */
export interface RealRecognitionPorts {
  readonly profile: LiveRecognitionProfile;
  readonly credentials: LiveRecognitionCredentials;
  readonly authorization: string;
  readonly imageSource: RecognitionImageSource;
  readonly liveGate?: LiveRecognitionGate;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly onObservation?: (observation: LiveRecognitionObservation) => void;
}

/** 端口/配置装配失败（**构造期**抛，从不进请求期）；上层据此回落 fail-closed。 */
export class RecognitionWiringError extends Error {
  readonly code: ErrorCode = 'PROVIDER_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'RecognitionWiringError';
  }
}

/** 本地入参拒绝（不是供应商故障）：未发包、不占预算，由适配器落 `PROVIDER_UNAVAILABLE`。 */
export class RecognitionLocalInputError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'RecognitionLocalInputError';
    this.code = code;
  }
}

/** 一条进程内台账（**不含任何凭据、不含请求正文**）。 */
export interface RecognitionGateEntry {
  readonly attemptKey: string;
  readonly reservedCny: number;
  readonly reservedAt: number;
  settled: boolean;
  state: string | null;
  providerErrorCode: string | null;
}

export interface ProcessRecognitionGate extends LiveRecognitionGate {
  /** 只读快照（诊断/证据用）。 */
  snapshot(): {
    readonly authorization: string;
    readonly reservedCny: number;
    readonly entries: readonly RecognitionGateEntry[];
    readonly settleMisses: number;
  };
}

/**
 * 进程内闸门（产品路径的那一份）：防重复计费 + 可选次数上限。
 *
 * **预留额恒 `0`**：识别域在本基线没有已审供应商单价，凭空写一个数是假账；次数上限
 * （`maxCalls`）仍可真实触发 `BUDGET_OR_COUNT_EXCEEDED` ⇒ `PROVIDER_QUOTA_EXCEEDED`。
 */
export function createProcessRecognitionGate(options: {
  authorization: string;
  maxCalls?: number;
  now?: () => number;
}): ProcessRecognitionGate {
  if (options === null || typeof options !== 'object') {
    throw new RecognitionWiringError('createProcessRecognitionGate 需要选项对象（没有闸门就不构造真实分支）');
  }
  if (typeof options.authorization !== 'string' || options.authorization.trim() === '') {
    throw new RecognitionWiringError('createProcessRecognitionGate 需要非空授权串（与适配器端口逐字一致）');
  }
  const authorization = options.authorization;
  const maxCalls = options.maxCalls ?? 0;
  const now = options.now ?? ((): number => Date.now());
  const entries: RecognitionGateEntry[] = [];
  let settleMisses = 0;

  return {
    async reserve(input) {
      if (typeof input?.authorization !== 'string' || input.authorization !== authorization) {
        throw new LiveGateRefusedError('AUTHORIZATION_REQUIRED', '授权串与闸门不一致（等价未接线，未发包）');
      }
      if (typeof input.attemptKey !== 'string' || input.attemptKey.trim() === '') {
        throw new LiveGateRefusedError('LEDGER_UNAVAILABLE', '缺少尝试键：无法防重复计费（未发包）');
      }
      if (entries.some((entry) => entry.attemptKey === input.attemptKey)) {
        throw new LiveGateRefusedError('ATTEMPT_ALREADY_RESERVED', '同一次尝试已预留过（绝不重发）');
      }
      if (maxCalls > 0 && entries.length >= maxCalls) {
        throw new LiveGateRefusedError('BUDGET_OR_COUNT_EXCEEDED', '超出本地预留次数上限（未发包）');
      }
      entries.push({
        attemptKey: input.attemptKey,
        reservedCny: 0,
        reservedAt: now(),
        settled: false,
        state: null,
        providerErrorCode: null,
      });
      return { attemptKey: input.attemptKey, authorization, reservedCny: 0 };
    },
    async settle(ticket, outcome) {
      // **无论成败都必须落账**；这里永不抛错（抛错会把「已发包」吞成未处理异常）。
      const entry = entries.find((item) => item.attemptKey === ticket?.attemptKey);
      if (entry === undefined) {
        settleMisses += 1;
        return;
      }
      entry.settled = true;
      entry.state = typeof outcome?.state === 'string' ? outcome.state : null;
      entry.providerErrorCode = typeof outcome?.providerErrorCode === 'string' ? outcome.providerErrorCode : null;
    },
    snapshot() {
      return {
        authorization,
        reservedCny: 0,
        entries: entries.map((entry) => ({ ...entry })),
        settleMisses,
      };
    },
  };
}
