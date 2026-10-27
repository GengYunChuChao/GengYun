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

/**
 * **非媒体**资料维度（GY-I27 第三片 · 合成域外发账本）。
 *
 * 为什么必须有第二维度（而不是往 `MEDIA_PURPOSES` 里加成员）：
 *   - `MEDIA_PURPOSES` 是**冻结契约** `states.MediaPurpose` 的逐项镜像
 *     （`tests/privacy/contract.test.mjs:28` 与 `tests/media/contract.test.mjs:30` 的
 *     `assert.deepEqual(MEDIA_PURPOSES, states.MediaPurpose)`）⇒ 加成员会立刻打红，属改契约 ✗；
 *   - 复用媒体维度还会**多要授权**：`MEDIA_PURPOSE_REQUIRED_CONSENTS` 里每个媒体类型都要求
 *     `media_processing`，而 `voice_question` 还要求 `recording` —— 一个只授 `external_inference`
 *     的合成请求会被索要 `recording`（`CONSENT_REQUIRED`），这既非契约要求也非用户预期。
 * 因此第二维度**只声明「非媒体」资料类型**与各自的**最小必需用途集合**，与媒体维度并列
 * （不是覆盖、不是替代）：判定放行 = 媒体维 ∪ 非媒体维，任一维命中即按**该维自己的**必需集合核验。
 *
 * 边界（如实登记）：本维度**不在冻结契约内**（契约没有第二个资料类型枚举），因此不得外传为
 * 契约字段，也不得被客户端声明；它只由服务端装配层（`ledger-pg.ts` / `task-egress` 侧）在
 * 「同一后端在服务端执行的一次真实外发」上声明，用于给外发账本一个**如实的数据对象维度**。
 */
export const NON_MEDIA_DATA_TYPES = Object.freeze(['checked_content']);

/**
 * 每个**非媒体**资料类型必须同时满足的一组用途授权（与
 * `MEDIA_PURPOSE_REQUIRED_CONSENTS` 同形、同口径，但**只含该类型真正需要的用途**）。
 *
 * `checked_content`（已核对正文的朗读外发）：合成请求本身已由合成域的授权门要求
 * `external_inference`（`routes/synthesis.ts:99-100`），且执行期会**重读**已核对正文
 * （不读客户端自由文本）⇒ 必需集合就是 `['external_inference']`：
 *   - **不得**含 `recording`（合成不发麦克风录音、不采音频）；含它会让只授外发用途的用户被判 `CONSENT_REQUIRED`；
 *   - **不得**含 `media_processing`（合成目标不是媒体对象、不读照片/录音字节）。
 */
export const NON_MEDIA_REQUIRED_CONSENTS = Object.freeze({
  checked_content: Object.freeze(['external_inference']),
});

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
export const DELETION_STATES = Object.freeze(['requested', 'processing', 'blocked', 'completed', 'cancelled']);

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

/**
 * 已知资料类型（媒体维 ∪ 非媒体维）的必需用途集合；未知类型返回 `null`。
 *
 * **放行范围因此是「两维并集」，但每一维各自核验**：媒体类型仍只按
 * `MEDIA_PURPOSE_REQUIRED_CONSENTS` 判定（合成域的出现不会给任何媒体类型减一项），
 * 非媒体类型只按 `NON_MEDIA_REQUIRED_CONSENTS` 判定。
 */
export function requiredConsentsForDataType(dataType) {
  if (MEDIA_PURPOSE_REQUIRED_CONSENTS[dataType] !== undefined) {
    return MEDIA_PURPOSE_REQUIRED_CONSENTS[dataType];
  }
  if (NON_MEDIA_REQUIRED_CONSENTS[dataType] !== undefined) {
    return NON_MEDIA_REQUIRED_CONSENTS[dataType];
  }
  return null;
}

/** 资料类型是否已知（媒体维 ∪ 非媒体维）。 */
export function isKnownDataType(dataType) {
  return requiredConsentsForDataType(dataType) !== null;
}

/**
 * 外发账本 `object_type` 的**闭集**（GY-R35 写入侧改写；新常量一律追加在文件末尾，
 * 免得把上面被文档按行号引用的既有定义整体下移 —— 行号漂移会让 `tools/verify-doc-anchors.mjs`
 * 的引用变成空区间）。
 *
 * 逐字镜像契约 `TargetRef.type`（`packages/contracts/openapi.json:11551-11570`）—— 账本行会被
 * `/me/exports` 原样投影成 `Export.object_ref`（`packages/privacy/egress.mjs:397`），所以
 * `object_type` 必须**恰好**落在这 17 个值里；多一个或少一个都会让读面与契约脱节。
 *
 * 为什么补 `conversation_turn`（2026-10-25 二轮，监工 R1）：账本记的是**一次问答轮次**的外发，
 * 而轮次是契约实体 `Turn`（id / revision）。早先把类型近似成容器 `conversation`，会让
 * `object_ref` 出现「会话类型 + 轮次 id + 轮次 revision」的错配。类型、标识、revision 必须指向
 * 同一真实实体 ⇒ 契约 `TargetRef.type` 补一个成员，读面按枚举成员原样投影，不做近似映射。
 * 契约是手写的（**无生成器**）⇒ 这份常量是手抄镜像，改契约时必须同步改这里
 * （由 `tests/unit/exports-object-ref-contract.test.mjs` 双向钉住）。
 */
export const EXPORT_OBJECT_TYPES = Object.freeze([
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
  'conversation_turn',
  'dose_card',
  'media',
  'synthesis',
  'job',
  'source',
]);

/** 外发账本 `object_key` 的字符上限 = 契约 `TargetRef.id` 的 `maxLength`（同一个数，不得各自漂移）。 */
export const EXPORT_OBJECT_ID_MAX = 80;
