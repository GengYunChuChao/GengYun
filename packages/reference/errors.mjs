/**
 * GY-I07 查询展示层 · 错误类型与封套。
 *
 * 与 `services/api` 的 ErrorEnvelope **同形**（契约 openapi.json
 * `ErrorEnvelope` / `Error` / `FieldError`），错误码取自契约 `ErrorCode` 枚举
 * 与 `error_status_map`。本模块同样**只消费**契约，不新增错误码。
 *
 * 语义要点（AC02）：
 *   - 无结果 / 条件不足 / 来源不足 **不是服务端错误**：它们以正常的 200 + `MatchState`
 *     表达（见 query.mjs），便于列表与详情一致地展示「原因」与「重筛」入口。
 *   - 只有**请求本身非法**（参数越界、游标非法、登记号格式错）才抛 `ReferenceError`。
 */

/** 契约 ErrorCode 枚举（只读子集：本域实际会产生的码）。 */
export const ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_CURSOR',
  'NOT_FOUND',
  'CONDITIONS_INCOMPLETE',
  'SOURCE_CONFLICT',
  'INPUT_UNCERTAIN',
];

/**
 * 错误码 → HTTP 状态（与契约 error_status_map 对齐的**只读子集**）。
 * 仅列出本域可能产生的码；完整映射由 services/api 消费契约持有。
 */
export const ERROR_STATUS_MAP = {
  INVALID_REQUEST: 400,
  INVALID_CURSOR: 400,
  NOT_FOUND: 404,
  CONDITIONS_INCOMPLETE: 422,
  SOURCE_CONFLICT: 422,
  INPUT_UNCERTAIN: 422,
};

/** 请求参数不合法的单字段错误（契约 FieldError：field / reason）。 */
export class FieldError {
  constructor(field, reason) {
    this.field = field;
    this.reason = reason;
  }
}

/** 查询展示层错误。code 必须属于契约 ErrorCode。 */
export class ReferenceError extends Error {
  constructor(code, message, { retryable = false, details = [] } = {}) {
    if (!ERROR_CODES.includes(code)) {
      throw new Error(`未知错误码：${code}`);
    }
    super(message);
    this.name = 'ReferenceError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.status = ERROR_STATUS_MAP[code] ?? 400;
  }
}

/** 转为契约 ErrorEnvelope 的 `error` 字段（不含 meta，meta 由调用方补）。 */
export function toErrorEnvelope(error, requestId = null) {
  const code = error instanceof ReferenceError ? error.code : 'INVALID_REQUEST';
  return {
    code,
    message: typeof error?.message === 'string' && error.message !== '' ? error.message : '请求处理失败',
    retryable: error?.retryable === true,
    details: Array.isArray(error?.details) ? error.details.map((d) => ({ field: d.field, reason: d.reason })) : [],
    ...(requestId ? { request_id: requestId } : {}),
  };
}
