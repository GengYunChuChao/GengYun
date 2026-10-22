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
/** 业务错误：携带契约错误码，HTTP 状态由错误码映射决定（不接受调用方自定义）。 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: FieldError[];

  constructor(code: ErrorCode, message: string, options: { retryable?: boolean; details?: FieldError[] } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? [];
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
 * 1. **优先用限流器给出的剩余窗口**：若该类错误由限流器产出且能算出剩余秒数，就用它（向上取整、最小 1，
 *    仍在本函数的 `return` 里落地，⛔不在调用点各自算）。
 * 2. **拿不到就给固定 1 秒**——这是**当前**实际走的一路：本仓没有本地限流器（`auth/wechat.ts:117-127`
 *    是把上游微信 errcode 45011 映射成 `RATE_LIMITED`，上游只给错误码、不给剩余窗口；其余 429 码均来自
 *    供应商错误映射），所以第 1 路取不到值。此时任何更大的数字都是编造；1 是 openapi `minimum: 1` 的
 *    最小合法值，语义是「至少等 1 秒再试」，客户端按退避序列自增重试即可。409 `REQUEST_IN_PROGRESS`
 *    同理：同一 Key 的前一个请求通常在毫秒级完成，1 秒与本仓既有口径（#108）一致。
 */
export function retryAfterSecondsFor(error: ApiError): number | null {
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
