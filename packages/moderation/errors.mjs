/**
 * GY-I14 确定性硬规则审核层 · 组件内错误封套。
 *
 * 边界声明（重要）：本片**没有 HTTP 消费者**（无路由、无 app.ts 接线）。
 * 因此这里**不**伪造契约错误码——`packages/contracts/states.json` 的 `error_status_map`
 * 里没有"审核输入非法"这一类契约码，硬套 `INVALID_REQUEST` 只会让后续接线者以为已经映射过。
 * 本模块只给出**组件内错误码**，并显式携带 `http_status: null`，映射工作留给 API 接线增量。
 */

/** 组件内错误码（显式标明尚未映射到契约错误码）。 */
export const MODERATION_ERROR_CODES = Object.freeze([
  'MODERATION_INVALID_INPUT',
  'MODERATION_RULE_FAILED',
  'MODERATION_INTERNAL_ERROR',
]);

/** 基类：携带组件内错误码与（尚未映射的）HTTP 状态。 */
export class ModerationError extends Error {
  /**
   * @param {string} code 组件内错误码（必须属于 MODERATION_ERROR_CODES）
   * @param {string} message 面向日志的说明（**不得**包含原文正文／PII／坐标）
   * @param {{ retryable?: boolean, http_status?: number|null, details?: Array<object> }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ModerationError';
    this.code = code;
    // 本片不分配 HTTP 状态：没有路由可挂。接线增量再按契约 error_status_map 映射。
    this.http_status = options.http_status ?? null;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? [];
  }
}

/** 输入不合法（缺字段／类型不符／空文本／超长／编码异常／未知字段）。 */
export class ModerationInputError extends ModerationError {
  constructor(message, options = {}) {
    super('MODERATION_INVALID_INPUT', message, { retryable: false, ...options });
    this.name = 'ModerationInputError';
  }
}

/** 单条规则求值失败；**不得**被调用方吞成"未命中"。 */
export class RuleEvaluationError extends ModerationError {
  /**
   * @param {string} ruleId
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(ruleId, message, options = {}) {
    super('MODERATION_RULE_FAILED', message, { retryable: false });
    this.name = 'RuleEvaluationError';
    this.rule_id = ruleId;
    this.cause = options.cause;
  }
}

/**
 * 转成可安全打印的封套：不透出原始 message 之外的任何输入正文，
 * 也不把 `cause` 的堆栈原样外抛（可能含输入片段）。
 */
export function toErrorEnvelope(error, meta = {}) {
  if (error instanceof ModerationError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        http_status: error.http_status,
        rule_id: error.rule_id ?? null,
        details: error.details,
      },
      meta: {
        contract_version: '1.0.0',
        // 本片无 HTTP 消费者：显式标注"尚未接线"，避免被读成已上线能力。
        wired_to_http: false,
        execution_mode: meta.execution_mode ?? 'local',
      },
    };
  }
  return {
    error: {
      code: 'MODERATION_INTERNAL_ERROR',
      message: '审核组件内部错误',
      retryable: false,
      http_status: null,
      rule_id: null,
      details: [],
    },
    meta: {
      contract_version: '1.0.0',
      wired_to_http: false,
      execution_mode: meta.execution_mode ?? 'local',
      error_type: error?.name ?? (typeof error === 'string' ? 'string' : 'unknown'),
    },
  };
}
