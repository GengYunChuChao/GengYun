/**
 * GY-I06 媒体模块 · 契约错误封套。
 *
 * 错误码遵循 packages/contracts/states.json 的 error_status_map 口径：
 *   - 404 NOT_FOUND             非本人访问私有媒体统一 404（与不存在同形，不泄露存在性）
 *   - 413 MEDIA_TOO_LARGE       超过用途/全局字节上限（不信扩展名）
 *   - 415 MEDIA_TYPE_UNSUPPORTED 真实编码与用途不符（伪扩展名/错类型）
 *   - 409 OBJECT_UNAVAILABLE    对象状态不可用（未 ready / 已删除 / 过期）
 *   - 409 REVISION_CONFLICT     If-Match 版本不匹配
 *   - 409 IDEMPOTENCY_CONFLICT  同幂等键不同内容
 *   - 428 REVISION_REQUIRED     缺 If-Match
 *   - 400 IDEMPOTENCY_KEY_REQUIRED 缺幂等键
 *   - 400 INVALID_REQUEST       结构/取值非法
 *
 * 封套 shape 与 services/api/src/errors.ts 的 ErrorEnvelope 一致。
 */
import { statusForErrorCode, CONTRACT_VERSION } from './constants.mjs';

/** 业务错误：携带契约错误码；HTTP 状态由错误码映射决定（不接受调用方自定义）。 */
export class MediaError extends Error {
  /**
   * @param {string} code 契约错误码（必须存在于 ERROR_STATUS_MAP）
   * @param {string} message 面向用户/日志的说明（不含敏感原文）
   * @param {{ retryable?: boolean, details?: Array<{field:string, code:string}> }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'MediaError';
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
 * 非契约错误不透出原始 message（可能含私有媒体引用/供应商原文），只投影安全元数据。
 * @param {MediaError|Error} error
 * @param {{ request_id?: string, execution_mode?: string }} [meta]
 */
export function toErrorEnvelope(error, meta = {}) {
  if (error instanceof MediaError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      },
      meta: {
        request_id: meta.request_id ?? null,
        contract_version: CONTRACT_VERSION,
        execution_mode: meta.execution_mode ?? 'real',
      },
    };
  }
  return {
    error: {
      message: '服务器内部错误',
      retryable: false,
      details: [],
    },
    meta: {
      request_id: meta.request_id ?? null,
      contract_version: CONTRACT_VERSION,
      execution_mode: meta.execution_mode ?? 'real',
      error_type: error?.name ?? (typeof error === 'string' ? 'string' : 'unknown'),
    },
  };
}
