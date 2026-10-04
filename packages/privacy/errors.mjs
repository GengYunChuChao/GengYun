/**
 * GY-I27 隐私模块 · 契约错误封套。
 *
 * 授权相关错误码遵循 packages/contracts/states.json 的 error_status_map 口径：
 *   - 403 CONSENT_REQUIRED  未授予用途授权
 *   - 403 SCOPE_DENIED      用途与资料类型不匹配（错用途）
 *   - 403 ACCOUNT_INACTIVE  账号非活跃（注销/停用/待删除）
 *   - 409 OBJECT_UNAVAILABLE 撤回/注销/取消后对象不可用（旧结果回写阻断）
 *   - 409 REVISION_CONFLICT  版本冲突（需 If-Match）
 *   - 428 REVISION_REQUIRED  缺版本头
 *
 * 错误封套 shape 与 services/api/src/errors.ts 的 ErrorEnvelope 一致，
 * 供后端直接映射、前端统一解析，保证前后端一致。
 */
import { statusForErrorCode } from './constants.mjs';

/** 业务错误：携带契约错误码；HTTP 状态由错误码映射决定（不接受调用方自定义）。 */
export class PrivacyError extends Error {
  /**
   * @param {string} code 契约错误码（必须存在于 ERROR_STATUS_MAP）
   * @param {string} message 面向用户/日志的说明（不含敏感原文）
   * @param {{ retryable?: boolean, details?: Array<{field:string, code:string}> }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'PrivacyError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? [];
  }

  get status() {
    return statusForErrorCode(this.code);
  }
}

/**
 * 将错误封装为契约错误封套（error + meta）。
 * @param {PrivacyError|Error} error
 * @param {{ request_id?: string, execution_mode?: string }} [meta]
 */
export function toErrorEnvelope(error, meta = {}) {
  if (error instanceof PrivacyError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      },
      meta: {
        request_id: meta.request_id ?? null,
        contract_version: '1.0.0',
        execution_mode: meta.execution_mode ?? 'real',
      },
    };
  }
  // 非契约错误不伪造错误码；如实透出 message（调用方负责脱敏）。
  return {
    error: {
      message: String(error?.message ?? error),
      retryable: false,
      details: [],
    },
    meta: {
      request_id: meta.request_id ?? null,
      contract_version: '1.0.0',
      execution_mode: meta.execution_mode ?? 'real',
    },
  };
}
