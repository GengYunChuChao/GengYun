/**
 * GY-I06 私有媒体模块 · 契约常量（只读消费 packages/contracts/*，不修改契约）。
 *
 * 枚举与错误码以 packages/contracts/states.json / openapi.json 为唯一事实来源；
 * 一致性由 tests/media/contract.test.mjs 逐项比对，避免各处硬编码导致漂移。
 *
 * 限额与状态机来源：docs/architecture/state-contract.md「媒体及 AI 任务」小节，
 * 以及 docs/implementation-requirements.md F05/F12/F15/F16 与第 6.1/6.2 节。
 */

/** packages/contracts/states.json -> contract_version */
export const CONTRACT_VERSION = '1.0.0';

/** states.MediaPurpose */
export const MEDIA_PURPOSES = Object.freeze([
  'weed_recognition',
  'label_ocr',
  'voice_question',
  'community_image',
]);

/** states.MediaState */
export const MEDIA_STATES = Object.freeze([
  'initiated',
  'uploaded',
  'processing',
  'ready',
  'rejected',
  'deleting',
  'deleted',
]);

/** 用途类别：image / audio。音频不参与社区图片槽位与每帖 3 张限制。 */
export const MEDIA_PURPOSE_KIND = Object.freeze({
  weed_recognition: 'image',
  label_ocr: 'image',
  voice_question: 'audio',
  community_image: 'image',
});

/**
 * 每种用途允许的**真实**编码（按魔数/解码核验，不信扩展名）。
 * 与 UploadInput.mime 枚举一致：image/jpeg|png|webp、audio/mpeg|wav|aac。
 */
export const MEDIA_PURPOSE_MIME = Object.freeze({
  weed_recognition: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
  label_ocr: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
  voice_question: Object.freeze(['audio/mpeg', 'audio/wav', 'audio/aac']),
  community_image: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
});

/** 1 MiB（字节）。契约以 MiB 记，非 MB。 */
export const MIB = 1048576;

/**
 * 每用途字节上限（state-contract「媒体及 AI 任务」）：
 *   - weed_recognition / label_ocr：≤2MiB（识别图片评估条件压缩上限）
 *   - voice_question：≤10MiB
 *   - community_image：每张 ≤5MiB
 */
export const MEDIA_PURPOSE_MAX_BYTES = Object.freeze({
  weed_recognition: 2 * MIB,
  label_ocr: 2 * MIB,
  voice_question: 10 * MIB,
  community_image: 5 * MIB,
});

/** 全局上限（openapi UploadInput.bytes.maximum = 10485760）。 */
export const MEDIA_MAX_BYTES = 10 * MIB;

/** 单次录音最长 60 秒（openapi UploadInput.duration_ms.maximum）。 */
export const MEDIA_MAX_DURATION_MS = 60000;

/** 社区每帖最多 3 张图片（F05 / state-contract）。 */
export const COMMUNITY_MAX_IMAGES_PER_POST = 3;

/** 初始化后未完成的可回收时限：24 小时（state-contract）。 */
export const MEDIA_INITIATED_TTL_MS = 24 * 60 * 60 * 1000;

/** 短效访问句柄最大有效期：最大 300 秒（state-contract）。 */
export const MEDIA_ACCESS_TTL_MS = 300 * 1000;

/**
 * 状态机（state-contract：媒体 initiated → uploaded → processing → ready；
 * 任一非删除状态可 rejected 或 deleting → deleted）。
 */
export const MEDIA_STATE_TRANSITIONS = Object.freeze({
  initiated: Object.freeze(['uploaded', 'rejected', 'deleting']),
  uploaded: Object.freeze(['processing', 'rejected', 'deleting']),
  processing: Object.freeze(['ready', 'rejected', 'deleting']),
  ready: Object.freeze(['rejected', 'deleting']),
  rejected: Object.freeze(['deleting']),
  deleting: Object.freeze(['deleted']),
  deleted: Object.freeze([]),
});

/**
 * error_status_map（HTTP 状态 -> 允许的错误码），与 states.json 逐项一致。
 * 媒体相关：413 MEDIA_TOO_LARGE、415 MEDIA_TYPE_UNSUPPORTED、
 * 404 NOT_FOUND（非本人统一 404）、409 OBJECT_UNAVAILABLE/REVISION_CONFLICT、
 * 428 REVISION_REQUIRED、409 IDEMPOTENCY_CONFLICT。
 */
export const ERROR_STATUS_MAP = Object.freeze({
  400: Object.freeze(['INVALID_REQUEST', 'INVALID_CURSOR', 'IDEMPOTENCY_KEY_REQUIRED']),
  401: Object.freeze(['SESSION_REQUIRED', 'SESSION_EXPIRED']),
  403: Object.freeze(['SCOPE_DENIED', 'CONSENT_REQUIRED', 'ACCOUNT_INACTIVE', 'SELF_SCOPE_GRANT_DENIED']),
  404: Object.freeze(['NOT_FOUND']),
  409: Object.freeze([
    'REVISION_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'OBJECT_UNAVAILABLE',
    'REQUEST_IN_PROGRESS',
    'LAST_SCOPE_MANAGER',
    'SELF_DISABLE_DENIED',
  ]),
  413: Object.freeze(['MEDIA_TOO_LARGE']),
  415: Object.freeze(['MEDIA_TYPE_UNSUPPORTED']),
  422: Object.freeze(['CONDITIONS_INCOMPLETE', 'SOURCE_CONFLICT', 'INPUT_UNCERTAIN']),
  428: Object.freeze(['REVISION_REQUIRED']),
  429: Object.freeze(['RATE_LIMITED', 'PROVIDER_QUOTA_EXCEEDED']),
  503: Object.freeze(['PROVIDER_UNAVAILABLE', 'PROVIDER_OUTCOME_UNKNOWN']),
  504: Object.freeze(['PROVIDER_TIMEOUT']),
});

const ERROR_CODE_STATUS = new Map(
  Object.entries(ERROR_STATUS_MAP).flatMap(([status, codes]) => codes.map((code) => [code, Number(status)])),
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

export function isMediaPurpose(value) {
  return MEDIA_PURPOSES.includes(value);
}

export function isMediaState(value) {
  return MEDIA_STATES.includes(value);
}

/** 用途类别（image / audio）；未知用途抛错。 */
export function kindOf(purpose) {
  const kind = MEDIA_PURPOSE_KIND[purpose];
  if (!kind) throw new Error(`未知媒体用途：${purpose}`);
  return kind;
}

/** 用途允许的真实 MIME 列表；未知用途抛错。 */
export function allowedMimeFor(purpose) {
  const list = MEDIA_PURPOSE_MIME[purpose];
  if (!list) throw new Error(`未知媒体用途：${purpose}`);
  return list;
}

/** 用途字节上限；未知用途抛错。 */
export function maxBytesFor(purpose) {
  const limit = MEDIA_PURPOSE_MAX_BYTES[purpose];
  if (limit === undefined) throw new Error(`未知媒体用途：${purpose}`);
  return limit;
}

/** 状态迁移是否合法。 */
export function canTransition(from, to) {
  const allowed = MEDIA_STATE_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}
