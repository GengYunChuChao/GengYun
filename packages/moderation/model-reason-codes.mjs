/**
 * GY-I14 模型层（第二片）· 模型层**原因码**闭集。
 *
 * ⚠️ 审计点（必须显式声明，不允许含糊）：
 *   本文件新增的是**本组件 `reason_codes` 取值**，**不是**契约错误码，也**不是**错误封套码。
 *   - 契约错误码／错误封套码仍然**只有**规则层 `errors.mjs` 的 `MODERATION_ERROR_CODES`
 *     三个值（`MODERATION_INVALID_INPUT` / `MODERATION_RULE_FAILED` / `MODERATION_INTERNAL_ERROR`），
 *     本层**一个都没有新增**，也没有新增任何错误封套字段；
 *   - 契约 `Moderation.reason_codes` 只约束"字符串 / 1..80 / ≤30"，**不约束闭集**；
 *     规则层 `constants.mjs` 的 `RULE_REASON_CODES` / `FAIL_CLOSED_REASON_CODES` 是**规则层**的取值闭集，
 *     本层**不修改**它们（改它们会改变规则层既有的原因码排序语义，属派单禁止的"改动规则层既有语义"）。
 *
 * 为什么必须另立一套而不是复用规则层码：
 *   把"模型超时"报成 `RULE_TIMEOUT`、把"模型版本变化"报成 `RULE_VERSION_CHANGED`，
 *   会让原因码**说谎**（报告与事实不符），而按契约这些码是给人和下游读的唯一判别依据。
 *   派单要求"必须留下可判别的原因"，因此这里给出模型层自己的闭集，且**与规则层码零重叠**
 *   （由 tests/moderation/model-ports.test.mjs 逐项断言）。
 *
 * 全部取值只描述"事实类别"，**绝不**携带原始文本、媒体内容、PII、坐标、凭据或供应商响应体。
 */

/** 模型层原因码前缀（便于与规则层码区分，也便于下游按前缀分流）。 */
export const MODEL_REASON_CODE_PREFIX = 'MODEL_';

/**
 * 模型层原因码闭集（声明顺序 = 合流层 `reason_codes` 的次级排序依据）。
 *
 * 分组：
 *   - 接线／声明类：PORT_MISSING / PORT_INVALID / DECLARATION_MISSING / FIELD_SPOOFED / BIZTYPE_UNVERIFIED
 *   - 运行失败类（fail-closed）：TIMEOUT / QUOTA_EXCEEDED / AUTH_FAILED / PAYLOAD_INVALID /
 *     RESPONSE_SHAPE_UNKNOWN / PORT_ERROR / NOT_EVALUATED / MEDIA_UNSUPPORTED
 *   - 结论／版本类：VERSION_MISSING / VERSION_CONFLICT / BLOCKED / VERSION_CHANGED /
 *     MODEL_PROMPT_VERSION_CHANGED / VERSION_UNKNOWN / MODEL_PROMPT_VERSION_UNKNOWN
 *   - 输入类：MODEL_MERGE_INPUT_INVALID / MODEL_PROMPT_DEFINITION_INVALID
 *
 * 全部取值统一带 `MODEL_` 前缀（下游可按前缀分流，且与规则层码零重叠）。
 */
export const MODEL_REASON_CODES = Object.freeze([
  // ---- 接线与声明（缺端口/端口非法/规则层没按接口交接）----
  'MODEL_LAYER_PORT_MISSING',
  'MODEL_LAYER_PORT_INVALID',
  'MODEL_LAYER_DECLARATION_MISSING',
  'MODEL_LAYER_FIELD_SPOOFED',
  'MODEL_BIZTYPE_UNVERIFIED',
  // ---- 运行期失败（一律不得 approved）----
  'MODEL_TIMEOUT',
  'MODEL_QUOTA_EXCEEDED',
  'MODEL_AUTH_FAILED',
  'MODEL_PAYLOAD_INVALID',
  'MODEL_RESPONSE_SHAPE_UNKNOWN',
  'MODEL_PORT_ERROR',
  'MODEL_NOT_EVALUATED',
  'MODEL_MEDIA_UNSUPPORTED',
  // ---- 结论与版本绑定 ----
  'MODEL_VERSION_MISSING',
  'MODEL_VERSION_CONFLICT',
  'MODEL_BLOCKED',
  'MODEL_VERSION_CHANGED',
  'MODEL_PROMPT_VERSION_CHANGED',
  'MODEL_VERSION_UNKNOWN',
  'MODEL_PROMPT_VERSION_UNKNOWN',
  // ---- 输入绑定（返修 1 · 监工 5488195507 P1：结论必须绑定它实际检查过的输入）----
  'MODEL_LAYER_INPUT_BINDING_MISSING',
  'MODEL_LAYER_INPUT_BINDING_UNVERIFIED',
  'MODEL_LAYER_INPUT_BINDING_MISMATCH',
  // ---- 合流合法性（返修 1 · 监工 5488195507 P2：放行闸门必须校验结论自身是否合法）----
  'MODEL_LAYER_INVARIANT_VIOLATION',
  // ---- 合流输入与 prompt 定义 ----
  'MODEL_MERGE_INPUT_INVALID',
  'MODEL_PROMPT_DEFINITION_INVALID',
]);

/** 运行期失败类原因码（这些码出现即一律不得 approved）。 */
export const MODEL_FAILURE_REASON_CODES = Object.freeze([
  'MODEL_LAYER_PORT_MISSING',
  'MODEL_LAYER_PORT_INVALID',
  'MODEL_LAYER_DECLARATION_MISSING',
  'MODEL_LAYER_FIELD_SPOOFED',
  'MODEL_BIZTYPE_UNVERIFIED',
  'MODEL_TIMEOUT',
  'MODEL_QUOTA_EXCEEDED',
  'MODEL_AUTH_FAILED',
  'MODEL_PAYLOAD_INVALID',
  'MODEL_RESPONSE_SHAPE_UNKNOWN',
  'MODEL_PORT_ERROR',
  'MODEL_NOT_EVALUATED',
  'MODEL_MEDIA_UNSUPPORTED',
  'MODEL_VERSION_MISSING',
  'MODEL_VERSION_CONFLICT',
  // 输入绑定与合流合法性：与"未知/不一致"同类，出现即绝不放行（返修 1）
  'MODEL_LAYER_INPUT_BINDING_MISSING',
  'MODEL_LAYER_INPUT_BINDING_UNVERIFIED',
  'MODEL_LAYER_INPUT_BINDING_MISMATCH',
  'MODEL_LAYER_INVARIANT_VIOLATION',
]);

/**
 * 先 `typeof` 再判值的闭集判断。
 * 不用 `includes` 直接比，是为了让 `undefined` / 数字 / 对象一律返回 false 而不是靠隐式转换。
 */
export function isModelReasonCode(value) {
  return typeof value === 'string' && MODEL_REASON_CODES.includes(value);
}

/** 该码是否属于"运行期失败"（出现即绝不放行）。 */
export function isModelFailureReasonCode(value) {
  return typeof value === 'string' && MODEL_FAILURE_REASON_CODES.includes(value);
}

/** 声明顺序表（合流层排序用；导出以便测试直接复核排序输入）。 */
export function modelReasonCodeOrder() {
  return MODEL_REASON_CODES.map((code, index) => [code, index]);
}
