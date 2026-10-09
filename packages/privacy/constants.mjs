/**
 * GY-I27 隐私模块 · 契约常量（只读消费 packages/contracts/states.json，不修改契约）。
 *
 * 与 packages/contracts/states.json 的一致性由 tests/privacy/contract.test.mjs 逐项比对；
 * 前后端（小程序 / services/api）都应以本模块为授权错误码与枚举的唯一事实来源，
 * 避免各处硬编码导致漂移。
 */

/** packages/contracts/states.json -> contract_version */
export const CONTRACT_VERSION = '1.0.0';

/** states.ConsentPurpose（首版无 training）。 */
export const CONSENT_PURPOSES = Object.freeze([
  'recording',
  'media_processing',
  'external_inference',
  'public_posting',
]);

/** states.MediaPurpose（资料类型 data_type）。 */
export const MEDIA_PURPOSES = Object.freeze([
  'weed_recognition',
  'label_ocr',
  'voice_question',
  'community_image',
]);

/** consent 状态（granted / withdrawn）。 */
export const CONSENT_STATES = Object.freeze(['granted', 'withdrawn']);

/** 外发账本状态。 */
export const EXPORT_STATES = Object.freeze(['reserved', 'sent', 'failed', 'outcome_unknown']);

/** states.ThirdPartyState。 */
export const THIRD_PARTY_STATES = Object.freeze([
  'not_requested',
  'requested',
  'confirmed',
  'failed',
  'unsupported',
]);

/** states.DeletionState。 */
export const DELETION_STATES = Object.freeze(['requested', 'processing', 'blocked', 'completed']);

/** 删除 handler 状态（online / backup 各自独立）。 */
export const HANDLER_STATES = Object.freeze(['pending', 'running', 'completed', 'blocked']);

/** users.state（账号状态，注销后 active 之外均阻断外发/回写）。 */
export const ACCOUNT_STATES = Object.freeze(['active', 'suspended', 'deletion_pending', 'deleted']);

/**
 * 每个资料类型（MediaPurpose）必须同时满足的一组用途授权。
 * 来源：docs/architecture/state-contract.md「媒体及 AI 任务」表。
 * 「错用途」判定依据：外发 purpose 必须属于该 data_type 的必需集合。
 */
export const MEDIA_PURPOSE_REQUIRED_CONSENTS = Object.freeze({
  weed_recognition: Object.freeze(['media_processing', 'external_inference']),
  label_ocr: Object.freeze(['media_processing', 'external_inference']),
  voice_question: Object.freeze(['recording', 'media_processing', 'external_inference']),
  community_image: Object.freeze(['media_processing', 'public_posting', 'external_inference']),
});

/**
 * states.error_status_map（HTTP 状态 -> 允许的错误码）。
 * 前后端一致的授权错误码：403 CONSENT_REQUIRED / SCOPE_DENIED / ACCOUNT_INACTIVE，
 * 409 OBJECT_UNAVAILABLE / REVISION_CONFLICT，428 REVISION_REQUIRED。
 */
export const ERROR_STATUS_MAP = Object.freeze({
  400: Object.freeze(['INVALID_REQUEST', 'INVALID_CURSOR', 'IDEMPOTENCY_KEY_REQUIRED']),
  401: Object.freeze(['SESSION_REQUIRED', 'SESSION_EXPIRED']),
  403: Object.freeze(['SCOPE_DENIED', 'CONSENT_REQUIRED', 'ACCOUNT_INACTIVE']),
  404: Object.freeze(['NOT_FOUND']),
  409: Object.freeze(['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'OBJECT_UNAVAILABLE', 'REQUEST_IN_PROGRESS']),
  413: Object.freeze(['MEDIA_TOO_LARGE']),
  415: Object.freeze(['MEDIA_TYPE_UNSUPPORTED']),
  422: Object.freeze(['CONDITIONS_INCOMPLETE', 'SOURCE_CONFLICT', 'INPUT_UNCERTAIN']),
  428: Object.freeze(['REVISION_REQUIRED']),
  429: Object.freeze(['RATE_LIMITED', 'PROVIDER_QUOTA_EXCEEDED']),
  503: Object.freeze(['PROVIDER_UNAVAILABLE', 'PROVIDER_OUTCOME_UNKNOWN']),
  504: Object.freeze(['PROVIDER_TIMEOUT']),
});

const ERROR_CODE_STATUS = new Map(
  Object.entries(ERROR_STATUS_MAP).flatMap(([status, codes]) =>
    codes.map((code) => [code, Number(status)]),
  ),
);

/** 契约错误码是否合法。 */
export function isErrorCode(value) {
  return ERROR_CODE_STATUS.has(value);
}

/** 契约错误码 -> HTTP 状态；未知错误码抛错（不跨状态复用）。 */
export function statusForErrorCode(code) {
  const status = ERROR_CODE_STATUS.get(code);
  if (status === undefined) {
    throw new Error(`契约错误码没有对应 HTTP 状态：${code}`);
  }
  return status;
}
