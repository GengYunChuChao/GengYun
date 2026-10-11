/**
 * GY-I14 确定性硬规则审核层 · 契约常量。
 *
 * 只读消费 packages/contracts（states.json 的 AuditState 闭集、openapi.json 的 Moderation /
 * TargetRef 结构），**不修改契约、不新增枚举值**。
 * 与契约的一致性由 tests/moderation/contract.test.mjs 逐项比对 states.json / openapi.json；
 * 一旦契约改动而本模块没跟上，该用例即失败（避免静默漂移）。
 */

/** packages/contracts/states.json -> contract_version */
export const CONTRACT_VERSION = '1.0.0';

/**
 * states.AuditState —— **闭集 4 值，不得新增**。
 * 本模块任何判定结果只能是这 4 个值之一；无法判定时用 `quarantined` 或 `pending`，
 * **绝不**回落到 `approved`。
 */
export const AUDIT_STATES = Object.freeze(['pending', 'approved', 'rejected', 'quarantined']);

/** 决策常量（避免各处硬编码字符串）。 */
export const DECISION_PENDING = 'pending';
export const DECISION_APPROVED = 'approved';
export const DECISION_REJECTED = 'rejected';
export const DECISION_QUARANTINED = 'quarantined';

/** openapi.json -> components.schemas.TargetRef.properties.type.enum */
export const TARGET_TYPES = Object.freeze([
  'species',
  'herbicide',
  'scheme',
  'static_region',
  'recognition',
  'ocr',
  'transcription',
  'answer',
  'post',
  'comment',
  'conversation',
  'dose_card',
  'media',
  'synthesis',
  'job',
  'source',
]);

/**
 * 本片规则层**声明覆盖**的 target type（可审核文本内容的那部分）。
 *
 * 依据：
 *   - 本 PR 是"确定性硬规则审核层"第一片，只对**文本**做确定性判定；
 *   - 未在此集合内的 target type 一律**不得** `approved`（`TARGET_TYPE_NOT_COVERED`），
 *     因为"没跑该类型的硬规则"不等于"通过"。
 *
 * 该集合是**显式审计点**：后续 API 接线／模型层增量若要扩大覆盖，必须显式修改这里并补充用例，
 * 不允许通过"隐式默认为真"的方式放行。
 */
export const COVERED_TARGET_TYPES = Object.freeze([
  'post',
  'comment',
  'answer',
  'conversation',
  'transcription',
  'ocr',
  'dose_card',
  'synthesis',
]);

/** Moderation.reason_codes 契约上限：maxItems 30。 */
export const REASON_CODES_MAX_ITEMS = 30;
/** Moderation.reason_codes[].minLength 1。 */
export const REASON_CODE_MIN_LENGTH = 1;
/** Moderation.reason_codes[].maxLength 80。 */
export const REASON_CODE_MAX_LENGTH = 80;
/** TargetRef.id: minLength 1。 */
export const TARGET_ID_MIN_LENGTH = 1;
/** TargetRef.id: maxLength 80。 */
export const TARGET_ID_MAX_LENGTH = 80;
/** TargetRef.revision: integer, minimum 1。 */
export const TARGET_REVISION_MIN = 1;
/** Moderation.rule_version / model_version / prompt_version: maxLength 80。 */
export const VERSION_MAX_LENGTH = 80;

/**
 * 本片交付的字段（规则层产出）。
 * 与 MODEL_LAYER_FIELDS 严格分开，不允许互相冒充。
 */
export const RULE_LAYER_FIELDS = Object.freeze([
  'decision',
  'reason_codes',
  'hard_rule_passed',
  'rule_version',
]);

/**
 * 契约 Moderation 中**由后续模型层增量补齐**的字段。
 * 本片**不产出**这些值：不写占位字符串、不写 `unknown`/`tbd`/`pending` 假装已填。
 */
export const MODEL_LAYER_FIELDS = Object.freeze(['model_version', 'prompt_version']);

/** 契约 Moderation 中由持久层生成的字段（本片同样不产出）。 */
export const PERSISTENCE_LAYER_FIELDS = Object.freeze(['id']);

/**
 * 契约 Moderation 中由**调用方提供**、规则层校验后原样回填的绑定字段。
 * 规则层不"生成"它，但也不允许缺省——缺省即 fail-closed。
 */
export const TARGET_BINDING_FIELDS = Object.freeze(['target_ref']);

/**
 * 契约 Moderation 必填字段的四层归属（供测试与文档逐项核对，避免任何字段被"顺手假装填了"）。
 * 四层并集必须恰好等于 openapi.json 的 `Moderation.required`。
 */
export const MODERATION_FIELD_LAYERS = Object.freeze({
  rule_layer: RULE_LAYER_FIELDS,
  target_binding: TARGET_BINDING_FIELDS,
  model_layer: MODEL_LAYER_FIELDS,
  persistence_layer: PERSISTENCE_LAYER_FIELDS,
});

/** 本片**不产出**的契约字段（接线方必须知道这些还没填，不得当成完整 Moderation 落库）。 */
export const NOT_PRODUCED_BY_RULE_LAYER = Object.freeze([
  ...PERSISTENCE_LAYER_FIELDS,
  ...MODEL_LAYER_FIELDS,
]);

/** 规则严重级别：block = 命中即 `rejected`（不得发布）。 */
export const RULE_SEVERITIES = Object.freeze(['block']);

/**
 * 规则类别（集中定义处，便于审计）。
 * 前 7 类为派单 §3 要求的最低覆盖；`commerce` 对应 F05／AC16「广告、购买链接、私下交易导流不发布」。
 */
export const RULE_CATEGORIES = Object.freeze([
  'dangerous_usage',
  'label_bound_dose',
  'privacy',
  'prompt_injection',
  'authority_spoofing',
  'safety_claim',
  'commerce',
]);

/**
 * 规则命中的 reason_code 闭集口径（每项 1..80 字符）。
 * 与 fail-closed 原因码（FAIL_CLOSED_REASON_CODES）分开，便于"命中即拦截"与"未能判定"区分。
 */
export const RULE_REASON_CODES = Object.freeze([
  'DANGEROUS_MIX',
  'DOSE_UNBOUNDED',
  'DOSE_NOT_BOUND_TO_LABEL',
  'PRIVACY_PII',
  'PRIVACY_COORDS',
  'PROMPT_INJECTION',
  'FALSE_AUTHORITY',
  'ABSOLUTE_SAFETY_CLAIM',
  'COMMERCE_SOLICITATION',
  'COMMERCE_LINK',
]);

/**
 * fail-closed 原因码：表示"该判定不是通过"，且**必须**先于规则命中码出现在 reason_codes 里
 * （reason_codes 截断到契约上限 30 时，优先保留这些码）。
 */
export const FAIL_CLOSED_REASON_CODES = Object.freeze([
  'REASON_CODES_TRUNCATED',
  'ENGINE_INVARIANT_VIOLATION',
  'RULE_ENGINE_ERROR',
  'RULE_TIMEOUT',
  'RULE_CATALOG_INVALID',
  'ENGINE_OPTIONS_INVALID',
  'RULE_VERSION_UNKNOWN',
  'INPUT_NOT_OBJECT',
  'INPUT_READ_FAILED',
  'INPUT_UNKNOWN_FIELD',
  'INPUT_TARGET_REF_INVALID',
  'INPUT_TARGET_TYPE_INVALID',
  'INPUT_TARGET_ID_INVALID',
  'INPUT_TARGET_REVISION_INVALID',
  'INPUT_TEXT_MISSING',
  'INPUT_TEXT_NOT_STRING',
  'INPUT_TEXT_EMPTY',
  'INPUT_TEXT_TOO_LONG',
  'INPUT_TEXT_ENCODING_INVALID',
  'INPUT_MEDIA_MISSING',
  'INPUT_MEDIA_NOT_ARRAY',
  'TARGET_TYPE_NOT_COVERED',
  'MEDIA_NOT_EVALUATED_BY_RULE_LAYER',
  'RULE_NOT_EVALUATED',
  'REVIEW_INPUT_INVALID',
  'DECISION_INVALID',
  'DECISION_INCONSISTENT',
  'RULE_VERSION_CHANGED',
  'TARGET_REVISION_CHANGED',
  'TARGET_REF_CHANGED',
  'NOT_PUBLISHABLE',
]);

/** 全部自带原因码（校验用：每项 1..80）。 */
export const ALL_REASON_CODES = Object.freeze([
  ...RULE_REASON_CODES,
  ...FAIL_CLOSED_REASON_CODES,
]);

/** 单条规则的求值状态。 */
export const RULE_STATUSES = Object.freeze([
  'evaluated', // 实际求值且未命中
  'hit', // 实际求值且命中
  'error', // 抛错：计入"未求值"，不得当作"未命中"
  'timeout', // 预算耗尽未能求值
  'not_evaluated', // 因输入无效／类型未覆盖等原因未求值
]);

/**
 * 组件内输入约束（**不是**契约值，仅是本组件的防御性上界）。
 * 实际业务字段长度由 API 接线增量按需求定义；这里只保证"超长输入不得被当成通过"。
 */
export const MAX_TEXT_LENGTH = 20000;

/** 单次审核默认的墙钟预算（毫秒）。超出即视为超时，未求值的规则不得算通过。 */
export const DEFAULT_RULE_BUDGET_MS = 50;

/** 输入对象允许出现的顶层键（未知键一律不放行，见 validate-input.mjs）。 */
export const ALLOWED_INPUT_FIELDS = Object.freeze(['target_ref', 'text', 'media']);

/** AuditState 闭集判断（先 typeof 再判值，避免 undefined 被 includes 掉以轻心）。 */
export function isAuditState(value) {
  return typeof value === 'string' && AUDIT_STATES.includes(value);
}

/** TargetRef.type 闭集判断。 */
export function isTargetType(value) {
  return typeof value === 'string' && TARGET_TYPES.includes(value);
}
