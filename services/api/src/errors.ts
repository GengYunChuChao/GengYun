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
