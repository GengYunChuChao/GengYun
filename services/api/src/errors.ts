/**
 * 契约错误封套：ErrorEnvelope（packages/contracts/openapi.json）。
 *
 * shape：{ error: { code, message, retryable, details: [{field, code}] }, meta: { rid, contract_version, execution_mode } }
 */
import { CONTRACT_VERSION, type ErrorCode, statusForErrorCode } from './contract.ts';
import type { ExecutionMode } from './contract.ts';

export interface FieldError {
  field: string;
  code: string;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details: FieldError[];
  };
  meta: {
    request_id: string;
    contract_version: typeof CONTRACT_VERSION;
    execution_mode: ExecutionMode;
  };
}

/**
 * `retryable` 的唯一口径（全仓通用，改任何一处前先读这段）：
 *
 * - `retryable = true` **仅当同一请求在无人工/运维介入下稍后重试可能成功**（瞬时故障）。
 * - **能力未装配／未接线造成的 `PROVIDER_UNAVAILABLE` 一律 `false`** —— 那需要运维改配置，不是时间能解决的。
 *
 * 推论（本仓已按此收敛）：
 * - 四个受理面的 real 缺凭据 ⇒ `PROVIDER_UNAVAILABLE`(503) 且 `retryable === false`；
 * - 作业取消面「该域没有取消能力（未接线）」同理 `false`；
 * - 只有"同一请求自己会好"的瞬时态才可以写 `true`（例：全局开关**当前**取值读不出来 ⇒ fail-closed 503）。
 *
 * 契约不裁决本字段（`Error.retryable` 只有 `{"type":"boolean"}`）⇒ 口径由本注释承载，勿在调用点各写一套。
 */
/**
 * `ApiError` 的可选参数。
 *
 * `retryAfterSeconds`：**限流器**产出该类错误时能算出的剩余窗口（秒，正整数）。它不是响应头，
 * 只是一个事实携带位——写头仍只发生在 `retryAfterSecondsFor`（`Retry-After` 的唯一出口）。
 * 其余错误码不带它（不知道就说不知道，⛔ 不猜一个好看的秒数）。
 */
export interface ApiErrorOptions {
  retryable?: boolean;
  details?: FieldError[];
  retryAfterSeconds?: number;
}

/** 业务错误：携带契约错误码，HTTP 状态由错误码映射决定（不接受调用方自定义）。 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: FieldError[];
  /** 限流器给出的剩余窗口（整数秒，`null` = 未知）；只供 `retryAfterSecondsFor` 读取。 */
  readonly retryAfterSeconds: number | null;

  constructor(code: ErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? [];
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }

  get status(): number {
    return statusForErrorCode(this.code);
  }
}

/** `Retry-After` 的缺省秒数：限流窗口拿不到时的**确定性**取值（理由见 `retryAfterSecondsFor`）。 */
const DEFAULT_RETRY_AFTER_SECONDS = 1;

/**
 * 响应头 `Retry-After`（整数秒）的**唯一口径**——全仓只有 `app.ts` 的统一错误出口调用本函数写头，
 * 调用点（例：`auth/wechat.ts` 把上游 45011 映射成 `RATE_LIMITED`）**不得**自己写该头。
 *
 * 契约要求（`docs/architecture/state-contract.md`）：
 * - `:27` 行 429（`RATE_LIMITED` / `PROVIDER_QUOTA_EXCEEDED`）**必须**带 `Retry-After`；
 * - `:34` 行「处理中 409 `REQUEST_IN_PROGRESS`」**必须**带 `Retry-After`；
 * - 503/504 未在此强制；`packages/contracts/openapi.json` 里该头对所有错误响应都是 `required: false`
 *   （`{type:"integer", minimum:1}`，描述「仅可重试 409/429/503 返回」）⇒ 其余错误码**不写**该头。
 *
 * 取值（确定性、可解释、整数秒；⛔不用 HTTP-date 形式）：
 * 1. **优先用限流器给出的剩余窗口**：`services/api/src/rate-limit/limiter.ts` 在拒绝请求时把
 *    「窗口恢复还需多少毫秒」写进 `ApiError.retryAfterSeconds`（秒，已向上取整、最小 1），
 *    这里直接采用——写头仍只发生在本函数，⛔ 调用点不各自算。
 * 2. **拿不到就给固定 1 秒**：本仓其余 `RATE_LIMITED` 来自上游映射（`auth/wechat.ts:117-127` 把微信
 *    45011 映射成 `RATE_LIMITED`，上游只给错误码、不给剩余窗口），`Provider` 侧 429 亦然；此时任何
 *    更大的数字都是编造，1 是 openapi `minimum: 1` 的最小合法值，语义是「至少等 1 秒再试」。
 *    409 `REQUEST_IN_PROGRESS` 同理：同一 Key 的前一个请求通常在毫秒级完成，1 秒与本仓既有口径（#108）一致。
 */
export function retryAfterSecondsFor(error: ApiError): number | null {
  const fromLimiter = error.retryAfterSeconds;
  if (fromLimiter !== null && Number.isFinite(fromLimiter) && fromLimiter >= 1) {
    // 已在限流器侧向上取整；这里再取整一次是防御（契约要求整数秒）。
    return Math.ceil(fromLimiter);
  }
  if (error.code === 'REQUEST_IN_PROGRESS') return DEFAULT_RETRY_AFTER_SECONDS;
  if (error.status === 429) return DEFAULT_RETRY_AFTER_SECONDS;
  return null;
}

export function buildErrorEnvelope(
  error: ApiError,
  meta: { request_id: string; execution_mode: ExecutionMode },
): ErrorEnvelope {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    },
    meta: {
      request_id: meta.request_id,
      contract_version: CONTRACT_VERSION,
      execution_mode: meta.execution_mode,
    },
  };
}
