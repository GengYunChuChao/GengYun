/**
 * 授权用途（`ConsentPurpose`）→ 统一作业台账 `public.jobs.kind` 的**显式映射**（#29 缺口）。
 *
 * ## 为什么需要这张表
 * `public.jobs` 没有 `purpose` 列（建表见 `services/api/db/migrations/0001_initial_schema.sql:203-231`），
 * 而撤回/注销入口只带 `purpose`（`services/api/src/privacy/consent-pg.ts:183` 的
 * `egressRevoker.onConsentWithdrawn({ userId, purpose })`）。要把「撤哪个用途」翻译成「终止哪些作业行」，
 * 必须有一张**写死、可复核**的映射；⛔ 不允许按字符串包含关系猜（例如把 `media_*` 一律当媒体作业）。
 *
 * ## 依据（逐条指向代码，不凭印象）
 * - 四个已接入台账的作业源（`services/api/src/jobs/ledger.ts:78-87` 的 `LEDGER_WIRED_SOURCES`）：
 *   `ocr` / `recognition` / `transcription` / `answer`。
 * - `external_inference` 覆盖全部四个：媒体类作业的外发口默认用途就是它
 *   （`services/api/src/privacy/task-egress.ts:71` 的 `deps.purpose ?? 'external_inference'`；
 *   问答外发口同口径见 `:322`），三条受理路由也显式要求该用途
 *   （`routes/ocr.ts:219`、`routes/recognitions.ts:78`、`routes/speech.ts:200`）。
 * - `media_processing` 覆盖 `ocr` / `recognition` / `transcription`：这三个作业对应的资料类型
 *   `label_ocr` / `weed_recognition` / `voice_question` 的必需用途集合都含 `media_processing`
 *   （`packages/privacy/constants.mjs:90-95`）；`answer` 的资料类型是 `checked_content`，不含它。
 * - `recording` 只覆盖 `transcription`：`voice_question` 是唯一要求 `recording` 的资料类型
 *   （同上 `constants.mjs:93`），它在台账里的作业 kind 是 `transcription`（语音域目录叫 speech）。
 * - `public_posting` **不产生作业行**：只有 `community_image` 要求它（`constants.mjs:94`），
 *   而社区图片发布不是 `public.jobs` 的 kind；`moderation` / `synthesis` 没有可落库的作业行
 *   （`services/api/src/jobs/ledger.ts:108-111` 的 `UNWIRED_SOURCES_REASON`）。
 * - 表外的未知用途 ⇒ 空数组：**不动任何作业行**（该用途目前不产生作业）。
 *
 * ## 边界
 * 本表只决定「哪些 `kind` 的作业行会被撤回/注销置终态」。外发账本 `public.exports` 仍按
 * `required_consents ? purpose` 精确到用途（`services/api/src/privacy/ledger-pg.ts::revokeInFlight`），
 * 两者不是同一张表、也不是同一套行数。
 */
export const PURPOSE_JOB_KINDS = Object.freeze({
  external_inference: Object.freeze(['ocr', 'recognition', 'transcription', 'answer']),
  media_processing: Object.freeze(['ocr', 'recognition', 'transcription']),
  recording: Object.freeze(['transcription']),
  // 显式登记「有用途但无作业行」：比让它落到未知分支更容易复核。
  public_posting: Object.freeze([]),
});

/** 未知用途的返回值（冻结的空数组，调用方不能借返回值改表）。 */
const NO_JOB_KINDS = Object.freeze([]);

/**
 * 把撤回/注销的 `purpose` 翻译成 `public.jobs.kind` 的过滤集合。
 *
 * - `null` / `undefined` / 空串 ⇒ `null`：**全量**（注销/全撤口径，与 `revokeInFlight` 里
 *   `if (purpose && …)` 对 exports 的既有语义同义）；
 * - 表内用途 ⇒ 该用途的 kind 数组；
 * - 表外用途 ⇒ 空数组（不动任何作业行；该用途目前不产生作业）。
 *
 * @param {string|null|undefined} purpose
 * @returns {readonly string[]|null}
 */
export function jobKindsForPurpose(purpose) {
  if (!purpose) return null;
  if (typeof purpose !== 'string') return NO_JOB_KINDS;
  return PURPOSE_JOB_KINDS[purpose] ?? NO_JOB_KINDS;
}
