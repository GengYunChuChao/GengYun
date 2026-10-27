/**
 * 契约错误码与执行模式常量。
 *
 * 来源：packages/contracts/states.json（契约 1.0.0，GY-I01 维护）。
 * 本文件只读消费契约，不修改 packages/contracts/*。
 * 与契约的一致性由 tests/contract/contract-codes.test.mjs 与事实源逐项比对。
 */

/** packages/contracts/states.json -> states.ExecutionMode */
export const EXECUTION_MODES = ['real', 'stub', 'preset_demo'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** packages/contracts/states.json -> error_status_map（HTTP 状态 -> 允许的错误码）。 */
export const ERROR_STATUS_MAP = {
  400: ['INVALID_REQUEST', 'INVALID_CURSOR', 'IDEMPOTENCY_KEY_REQUIRED'],
  401: ['SESSION_REQUIRED', 'SESSION_EXPIRED'],
  403: ['SCOPE_DENIED', 'CONSENT_REQUIRED', 'ACCOUNT_INACTIVE', 'SELF_SCOPE_GRANT_DENIED'],
  404: ['NOT_FOUND'],
  409: ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'OBJECT_UNAVAILABLE', 'REQUEST_IN_PROGRESS', 'LAST_SCOPE_MANAGER', 'SELF_DISABLE_DENIED'],
  413: ['MEDIA_TOO_LARGE'],
  415: ['MEDIA_TYPE_UNSUPPORTED'],
  422: ['CONDITIONS_INCOMPLETE', 'SOURCE_CONFLICT', 'INPUT_UNCERTAIN'],
  428: ['REVISION_REQUIRED'],
  429: ['RATE_LIMITED', 'PROVIDER_QUOTA_EXCEEDED'],
  503: ['PROVIDER_UNAVAILABLE', 'PROVIDER_OUTCOME_UNKNOWN'],
  504: ['PROVIDER_TIMEOUT'],
} as const;

export const ERROR_CODES = Object.values(ERROR_STATUS_MAP).flat();
export type ErrorCode = (typeof ERROR_CODES)[number];

/** packages/contracts/openapi.json -> components.schemas.Meta.properties.contract_version.const */
export const CONTRACT_VERSION = '1.0.0';

/**
 * packages/contracts/openapi.json -> servers[0].url。
 * 业务路由的挂载前缀；/health 属运营端点，不在该前缀下。
 */
export const API_PREFIX = '/api/v1';

/** 契约错误码 -> HTTP 状态；错误码不跨状态复用。 */
const ERROR_CODE_STATUS: ReadonlyMap<string, number> = new Map(
  Object.entries(ERROR_STATUS_MAP).flatMap(([status, codes]) =>
    codes.map((code) => [code, Number(status)] as const),
  ),
);

export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODE_STATUS.has(value);
}

export function statusForErrorCode(code: ErrorCode): number {
  const status = ERROR_CODE_STATUS.get(code);
  if (status === undefined) {
    throw new Error(`契约错误码没有对应 HTTP 状态：${code}`);
  }
  return status;
}
