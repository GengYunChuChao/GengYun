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
