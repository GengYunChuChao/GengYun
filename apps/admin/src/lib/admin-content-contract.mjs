/**
 * 后台「资料来源 / 科普内容 / 分类」管理面契约常量与形状校验——纯 ESM，无 Vue／DOM 依赖。
 *
 * 事实来源（逐条可核，`packages/contracts/openapi.json`）：
 * - `/admin/sources`：GET `listAdminSources`（:7290，scope `sources:read`，200 `SourceDraftPageEnvelope`）、
 *   POST `createSourceDraft`（:7376，201 `SourceDraftEnvelope`，仅 `Idempotency-Key`）。
 * - `/admin/sources/{id}`：GET `getAdminSource`（:7471）、PATCH `editSourceDraft`（:7560，
 *   `Idempotency-Key` + `If-Match`，200 `SourceDraftEnvelope`）。
 * - `/admin/sources/{id}/publish`：POST `publishSource`（:7667），请求体 `SourcePublishInput`（:14022），
 *   200 `SourcePublicationOutcomeEnvelope`（同族出参 + 回执字段 `changed`）。
 * - `/admin/sources/{id}/withdraw`：POST `withdrawSource`（:7774），请求体 `ReasonInput`，
 *   200 `SourcePublicationOutcomeEnvelope`。
 * - `/admin/knowledge` 与 `/admin/knowledge/{id}…`：`listAdminKnowledge`（:7881）、`createKnowledgeDraft`（:7967）、
 *   `getAdminKnowledge`（:8062）、`editKnowledgeDraft`（:8151）、`publishKnowledge`（:8258，请求体同样是
 *   `SourcePublishInput`）、`withdrawKnowledge`（:8365）；列表/创建/详情/编辑用 `KnowledgeDraftPageEnvelope`／
 *   `KnowledgeDraftEnvelope`，publish/withdraw 用 `KnowledgePublicationOutcomeEnvelope`（同族出参 + 回执字段 `changed`）。
 * - `/admin/categories`：GET `listAdminCategories`（scope `sources:read`）、PATCH `/admin/categories/{id}`
 *   `editCategory`（scope `sources:write`，`Idempotency-Key` + `If-Match`，`CategoryInput` :14359）。
 *   **路径就是 `/admin/categories`**，不存在 `/admin/admin-categories`。
 * - `components/parameters`（:10875 起）：`IdempotencyKey` 8..128 字符；`If-Match` 必填、
 *   pattern `^"[1-9][0-9]*"$`（缺 428、非法 400、不匹配 409）；`Cursor` ≤2048；`Limit` 1..50 默认 20。
 * - 枚举：`Visibility` :10967、`SourceKind` :10976、`EvidenceKind` :10984、`Conditions` :11206、
 *   `SourceRef` :11420、`SourceDraftInput` :13928、`SourceDraft` :13996、`KnowledgeDraftInput` :14042、
 *   `KnowledgeDraft` :14106、`Category` :14316、`CategoryInput` :14359、`AuditEvent` :14474。
 *
 * 注册资料／限制资料两族（行号按 `git show <sha>:packages/contracts/openapi.json` 实测，均带前缀计数）：
 * - `/admin/registrations`：GET `listAdminRegistration` :8638、POST `createRegistrationDraft` :8724；
 *   `/admin/registrations/{id}`：GET `getAdminRegistration` :8819、PATCH `editRegistrationDraft` :8908；
 *   `/admin/registrations/{id}/publish` `publishRegistration` :9015、`/withdraw` `withdrawRegistration` :9122。
 * - `/admin/restrictions`：GET `listAdminRestriction` :9229、POST `createRestrictionDraft` :9315；
 *   详情 :9410 `getAdminRestriction`、:9499 `editRestrictionDraft`；发布 :9606、撤回 :9713。
 * - 形状：`Conditions` :12177（**required: crop_id + region_code**）、`Ingredient` :12461、
 *   `FormulationInput` :12527、`RegistrationDraftInput` :15112、`RegistrationDraft` :15158、
 *   `RestrictionInput` :15189、`Restriction` :15256、`RegistrationDraftPage` :17360、
 *   `RegistrationDraftPageEnvelope` :17389、`RegistrationDraftEnvelope` :17405、
 *   `RestrictionPage` :17421、`RestrictionPageEnvelope` :17450、`RestrictionEnvelope` :17466。
 * - **两族读面都没有 `visibility`**（与 sources／knowledge 不同）：`RegistrationDraft`／`Restriction`
 *   只有 `{id, revision, content, review_status}`，即**读面看不出草稿／已发布／已撤回**，
 *   也没有 `changed` 字段。页面据此**不推断生命周期**（见 `admin-content-view-model.mjs` 的族说明）。
 *
 * 本模块只做**形状校验与表单 → 请求体的转换**：不发请求、不碰存储、不写日志、不猜权限。
 */

import { CURSOR_MAX_LENGTH, ERROR_CODES, LIMIT_MAX, isPlainObject } from './admin-contract.mjs';

/** 四类资料里的四族管理面路径（相对 API 基地址）。 */
export const SOURCES_PATH = '/admin/sources';
export const KNOWLEDGE_PATH = '/admin/knowledge';
export const REGISTRATIONS_PATH = '/admin/registrations';
export const RESTRICTIONS_PATH = '/admin/restrictions';
export const CATEGORIES_PATH = '/admin/categories';
export const AUDIT_EVENTS_PATH = '/admin/audit-events';

/** scope（契约 `x-scope`）：读面与分类共用 `sources:read`，写面 `sources:write`；审计台账 `audit:read`。 */
export const SOURCES_READ_SCOPE = 'sources:read';
export const SOURCES_WRITE_SCOPE = 'sources:write';
export const AUDIT_READ_SCOPE = 'audit:read';

/** `SourceKind` / `EvidenceKind` / `KnowledgeDraftInput.type` / `Visibility` / `review_status` / `Category.type`。 */
export const SOURCE_KINDS = Object.freeze(['database', 'verified_seed', 'simulation']);
export const EVIDENCE_KINDS = Object.freeze(['research', 'experience', 'mixed']);
export const KNOWLEDGE_TYPES = Object.freeze(['species', 'herbicide', 'scheme', 'static_region']);
export const VISIBILITIES = Object.freeze(['private', 'published', 'hidden', 'deleted']);
export const REVIEW_STATUSES = Object.freeze(['unverified', 'verified', 'rejected']);
export const CATEGORY_TYPES = Object.freeze(['crop', 'species']);
export const SOURCE_VALIDITIES = Object.freeze(['valid', 'expired', 'conflicting', 'unknown', 'withdrawn']);

/** `RestrictionInput.effect`（契约内联枚举，:15189 起）：闭集三值，**不许**出现别的值。 */
export const RESTRICTION_EFFECTS = Object.freeze(['prohibited', 'restricted', 'unknown']);

/** `FormulationInput.ingredients` 的条数边界（契约 minItems 1 / maxItems 20）。 */
export const INGREDIENTS_MIN = 1;
export const INGREDIENTS_MAX = 20;

/** `Conditions` 里可选的三项（`crop_id`／`region_code` 之外；见 :12177）。 */
export const CONDITION_OPTIONAL_KEYS = Object.freeze(['species_id', 'growth_stage', 'planting_method', 'use_scene']);

/** `Idempotency-Key` 长度边界（契约 8..128）。 */
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 128;

/** 契约 `If-Match` pattern：必须带双引号、正整数、不允许 `*`。 */
export const IF_MATCH_PATTERN = /^"[1-9][0-9]*"$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_HASH_RE = /^[a-f0-9]{64}$/;
const REGION_CODE_RE = /^33[0-9]{4}$/;
const HTTPS_URL_RE = /^https:\/\/\S+$/;
/** RFC 3339 date-time（必须带时区，与契约 `format: date-time` 同口径）。 */
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function charLength(value) {
  return [...value].length;
}

/** 强 ETag：`"<revision>"`；非安全正整数直接抛错（宁可不发请求，也不发一个必然 428/400 的头）。 */
export function etagFor(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RangeError(`revision 必须是 >= 1 的安全整数，实际 ${String(revision)}`);
  }
  return `"${revision}"`;
}

/** 校验并规范化 `Idempotency-Key`（8..128 字符）；不合法返回 null，由调用方显示错误。 */
export function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string') return null;
  const length = charLength(value);
  if (length < IDEMPOTENCY_KEY_MIN || length > IDEMPOTENCY_KEY_MAX) return null;
  return value;
}

/**
 * 生成幂等键（>=8 字符，不含身份信息）。
 * 前缀固定 `admin-content-`，便于运维在服务端幂等记录里分辨来源。
 */
export function newIdempotencyKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `admin-content-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** RFC 3339 date-time 校验（`format: date-time`）。 */
export function isDateTime(value) {
  return typeof value === 'string' && DATE_TIME_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * `<input type="datetime-local">` 的本地值 → 契约 `date-time`（UTC `Z`）。
 * 空串返回 `null`（调用方决定是「必填缺失」还是「显式 null」）。
 */
export function dateTimeFromLocal(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** 契约 `date-time` → `<input type="datetime-local">` 的本地值（无法解析时返回空串，不猜时间）。 */
export function dateTimeToLocal(value) {
  if (typeof value !== 'string' || value === '') return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

/** 契约 `url`：`format: uri` + `pattern: ^https://`，两者都要满足。 */
export function isHttpsUrl(value) {
  if (typeof value !== 'string' || !HTTPS_URL_RE.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname !== '';
  } catch {
    return false;
  }
}

function checkString(value, path, rule, errors, warnings) {
  if (rule.nullable === true && value === null) return true;
  if (typeof value !== 'string') {
    errors.push({ path, problem: `缺少字符串 ${path.slice(2)}` });
    return false;
  }
  const length = charLength(value);
  if (rule.min !== undefined && length < rule.min) {
    errors.push({ path, problem: `${path.slice(2)} 长度 ${length} 小于契约下限 ${rule.min}` });
    return false;
  }
  if (rule.max !== undefined && length > rule.max) {
    errors.push({ path, problem: `${path.slice(2)} 长度 ${length} 超出契约上限 ${rule.max}` });
    return false;
  }
  if (rule.pattern !== undefined && !rule.pattern.test(value)) {
    errors.push({ path, problem: `${path.slice(2)} 不符合契约格式` });
    return false;
  }
  if (rule.enum !== undefined && !rule.enum.includes(value)) {
    errors.push({ path, problem: `${path.slice(2)} 不在契约 enum：${value}` });
    return false;
  }
  if (rule.dateTime === true && !isDateTime(value)) {
    errors.push({ path, problem: `${path.slice(2)} 不是 RFC 3339 date-time` });
    return false;
  }
  if (rule.uuid === true && !UUID_RE.test(value)) {
    warnings.push({ path, problem: `${path.slice(2)} 不符合契约 uuid 格式` });
  }
  return true;
}

function pushExtras(value, known, path, warnings) {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) warnings.push({ path: `${path}.${key}`, problem: '契约外字段（不展示、不推断含义）' });
  }
}

/** 校验 `SourceRef`（:11420）——列表行与详情共用的读面形状。 */
export function validateSourceRef(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }
  checkString(value.id, '$.id', { min: 1, uuid: true }, errors, warnings);
  checkString(value.version, '$.version', { min: 1, max: 80 }, errors, warnings);
  checkString(value.title, '$.title', { min: 1, max: 200 }, errors, warnings);
  checkString(value.url, '$.url', { min: 1, pattern: HTTPS_URL_RE }, errors, warnings);
  checkString(value.publisher, '$.publisher', { min: 1, max: 200 }, errors, warnings);
  checkString(value.source_kind, '$.source_kind', { enum: SOURCE_KINDS }, errors, warnings);
  checkString(value.evidence_kind, '$.evidence_kind', { enum: EVIDENCE_KINDS }, errors, warnings);
  checkString(value.validity, '$.validity', { enum: SOURCE_VALIDITIES }, errors, warnings);
  checkString(value.review_status, '$.review_status', { enum: REVIEW_STATUSES }, errors, warnings);
  checkString(value.updated_at, '$.updated_at', { min: 1, dateTime: true }, errors, warnings);
  pushExtras(value, ['id', 'version', 'title', 'url', 'publisher', 'source_kind', 'evidence_kind', 'validity', 'review_status', 'updated_at'], '$', warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * publish / withdraw 的 200 出参 = 同族草稿字段 + 回执字段 `changed`
 * （契约 `*PublicationOutcome`，如 `SourcePublicationOutcome`）。
 *
 * 契约把 `changed` 列进 `required`，所以这里同样按必填校验：缺它不是「未知字段」而是「不合契约」。
 * 草稿校验器不认识 `changed`，会把它记成「契约外字段」的误报 warning——那一条在这里滤掉。
 */
function validatePublicationOutcome(draftValidator, value) {
  const checked = draftValidator(value);
  const warnings = checked.warnings.filter((warning) => warning.path !== '$.changed');
  if (typeof value?.changed !== 'boolean') {
    return {
      ok: false,
      errors: [...checked.errors, { path: '$.changed', problem: '缺少布尔 changed（本次调用是否真的改变了状态）' }],
      warnings,
    };
  }
  return { ok: checked.ok, errors: checked.errors, warnings };
}

/** 校验 `SourceDraft`（:13996）：`{id, revision, source, visibility}`。 */
export function validateSourceDraft(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }
  checkString(value.id, '$.id', { min: 1, uuid: true }, errors, warnings);
  if (!Number.isInteger(value.revision) || value.revision < 1) {
    errors.push({ path: '$.revision', problem: '缺少 >= 1 的整数 revision' });
  }
  checkString(value.visibility, '$.visibility', { enum: VISIBILITIES }, errors, warnings);
  const source = validateSourceRef(value.source);
  for (const error of source.errors) errors.push({ path: `$.source${error.path.slice(1)}`, problem: error.problem });
  for (const warning of source.warnings) warnings.push({ path: `$.source${warning.path.slice(1)}`, problem: warning.problem });
  pushExtras(value, ['id', 'revision', 'source', 'visibility'], '$', warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/** 校验 `SourcePublicationOutcome`（publish / withdraw 的 200 出参）：`SourceDraft` 字段 + `changed`。 */
export function validateSourcePublicationOutcome(value) {
  return validatePublicationOutcome(validateSourceDraft, value);
}

/** 校验 `KnowledgeDraftInput`（:14042）；`conditions` 为 null 或 `Conditions`（:11206，crop_id/region_code 必填）。 */
export function validateKnowledgeInput(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }
  checkString(value.type, '$.type', { enum: KNOWLEDGE_TYPES }, errors, warnings);
  checkString(value.title, '$.title', { min: 1, max: 200 }, errors, warnings);
  checkString(value.body, '$.body', { min: 1, max: 20000 }, errors, warnings);
  checkString(value.source_id, '$.source_id', { min: 1, uuid: true }, errors, warnings);
  checkString(value.source_version, '$.source_version', { min: 1, max: 80 }, errors, warnings);
  if (value.formulation_id !== null) {
    checkString(value.formulation_id, '$.formulation_id', { min: 1, uuid: true }, errors, warnings);
  }
  if (value.conditions !== null) {
    if (!isPlainObject(value.conditions)) {
      errors.push({ path: '$.conditions', problem: 'conditions 只能是对象或 null' });
    } else {
      checkString(value.conditions.crop_id, '$.conditions.crop_id', { min: 1, max: 80 }, errors, warnings);
      checkString(value.conditions.region_code, '$.conditions.region_code', { min: 1, pattern: REGION_CODE_RE }, errors, warnings);
      for (const key of ['species_id', 'growth_stage', 'planting_method', 'use_scene']) {
        if (value.conditions[key] !== undefined) {
          checkString(value.conditions[key], `$.conditions.${key}`, { min: 1, max: 80 }, errors, warnings);
        }
      }
      pushExtras(value.conditions, ['crop_id', 'region_code', 'species_id', 'growth_stage', 'planting_method', 'use_scene'], '$.conditions', warnings);
    }
  }
  pushExtras(value, ['type', 'title', 'body', 'source_id', 'source_version', 'conditions', 'formulation_id'], '$', warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/** 校验 `KnowledgeDraft`（:14106）：`{id, revision, content, visibility, review_status}`。 */
export function validateKnowledgeDraft(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }
  checkString(value.id, '$.id', { min: 1, uuid: true }, errors, warnings);
  if (!Number.isInteger(value.revision) || value.revision < 1) {
    errors.push({ path: '$.revision', problem: '缺少 >= 1 的整数 revision' });
  }
  checkString(value.visibility, '$.visibility', { enum: VISIBILITIES }, errors, warnings);
  checkString(value.review_status, '$.review_status', { enum: REVIEW_STATUSES }, errors, warnings);
  const content = validateKnowledgeInput(value.content);
  for (const error of content.errors) errors.push({ path: `$.content${error.path.slice(1)}`, problem: error.problem });
  for (const warning of content.warnings) warnings.push({ path: `$.content${warning.path.slice(1)}`, problem: warning.problem });
  pushExtras(value, ['id', 'revision', 'content', 'visibility', 'review_status'], '$', warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/** 校验 `KnowledgePublicationOutcome`（publish / withdraw 的 200 出参）：`KnowledgeDraft` 字段 + `changed`。 */
export function validateKnowledgePublicationOutcome(value) {
  return validatePublicationOutcome(validateKnowledgeDraft, value);
}

/** 校验 `Ingredient`（:12461）：`name`／`content_text`／`unit_text` 三个 1..80 的必填字符串。 */
export function validateIngredient(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }
  for (const key of ['name', 'content_text', 'unit_text']) {
    checkString(value[key], `$.${key}`, { min: 1, max: 80 }, errors, warnings);
  }
  pushExtras(value, ['name', 'content_text', 'unit_text'], '$', warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/** 校验 `FormulationInput`（:12527）：`ingredients` 是 1..20 条 `Ingredient`。 */
export function validateFormulationInput(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }
  checkString(value.registration_number, '$.registration_number', { min: 1, max: 80 }, errors, warnings);
  checkString(value.producer, '$.producer', { min: 1, max: 200 }, errors, warnings);
  checkString(value.dosage_form, '$.dosage_form', { min: 1, max: 80 }, errors, warnings);
  if (!Array.isArray(value.ingredients)) {
    errors.push({ path: '$.ingredients', problem: '缺少数组 ingredients' });
  } else {
    if (value.ingredients.length < INGREDIENTS_MIN || value.ingredients.length > INGREDIENTS_MAX) {
      errors.push({
        path: '$.ingredients',
        problem: `ingredients 条数 ${value.ingredients.length} 不在契约范围 ${INGREDIENTS_MIN}..${INGREDIENTS_MAX}`,
      });
    }
    value.ingredients.forEach((item, index) => {
      const checked = validateIngredient(item);
      for (const error of checked.errors) errors.push({ path: `$.ingredients[${index}]${error.path.slice(1)}`, problem: error.problem });
      for (const warning of checked.warnings) warnings.push({ path: `$.ingredients[${index}]${warning.path.slice(1)}`, problem: warning.problem });
    });
  }
  pushExtras(value, ['registration_number', 'producer', 'dosage_form', 'ingredients'], '$', warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/** 校验 `Conditions`（:12177）：`crop_id` + `region_code` **必填**，其余四项可选。 */
export function validateConditions(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: 'conditions 必须是对象（契约不可为 null）' });
    return { ok: false, errors, warnings };
  }
  checkString(value.crop_id, '$.crop_id', { min: 1, max: 80 }, errors, warnings);
  checkString(value.region_code, '$.region_code', { min: 1, pattern: REGION_CODE_RE }, errors, warnings);
  for (const key of CONDITION_OPTIONAL_KEYS) {
    if (value[key] !== undefined) checkString(value[key], `$.${key}`, { min: 1, max: 80 }, errors, warnings);
  }
  pushExtras(value, ['crop_id', 'region_code', ...CONDITION_OPTIONAL_KEYS], '$', warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 校验 `RegistrationDraftInput`（:15112）：6 个必填字段，`valid_to` 可为 null。
 *
 * 与 `SourceDraftInput` 的差别是本片最容易照抄错的地方：这里**没有** `title`／`url`／`publisher`／
 * `content_hash`／`locator`／`source_kind`／`evidence_kind`，而是 `formulation` 一个嵌套对象 +
 * `registered_name`。
 */
export function validateRegistrationInput(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }
  const formulation = validateFormulationInput(value.formulation);
  for (const error of formulation.errors) errors.push({ path: `$.formulation${error.path.slice(1)}`, problem: error.problem });
  for (const warning of formulation.warnings) warnings.push({ path: `$.formulation${warning.path.slice(1)}`, problem: warning.problem });
  checkString(value.source_id, '$.source_id', { min: 1, uuid: true }, errors, warnings);
  checkString(value.source_version, '$.source_version', { min: 1, max: 80 }, errors, warnings);
  checkString(value.registered_name, '$.registered_name', { min: 1, max: 200 }, errors, warnings);
  checkString(value.valid_from, '$.valid_from', { min: 1, dateTime: true }, errors, warnings);
  checkString(value.valid_to, '$.valid_to', { min: 1, dateTime: true, nullable: true }, errors, warnings);
  pushExtras(value, ['formulation', 'source_id', 'source_version', 'registered_name', 'valid_from', 'valid_to'], '$', warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/** 校验 `RegistrationDraft`（:15158）：`{id, revision, content, review_status}`——**契约没有 visibility**。 */
export function validateRegistrationDraft(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }
  checkString(value.id, '$.id', { min: 1, uuid: true }, errors, warnings);
  if (!Number.isInteger(value.revision) || value.revision < 1) {
    errors.push({ path: '$.revision', problem: '缺少 >= 1 的整数 revision' });
  }
  checkString(value.review_status, '$.review_status', { enum: REVIEW_STATUSES }, errors, warnings);
  const content = validateRegistrationInput(value.content);
  for (const error of content.errors) errors.push({ path: `$.content${error.path.slice(1)}`, problem: error.problem });
  for (const warning of content.warnings) warnings.push({ path: `$.content${warning.path.slice(1)}`, problem: warning.problem });
  pushExtras(value, ['id', 'revision', 'content', 'review_status'], '$', warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/** 校验 `RegistrationPublicationOutcome`（publish / withdraw 的 200 出参）：`RegistrationDraft` 字段 + `changed`。 */
export function validateRegistrationPublicationOutcome(value) {
  return validatePublicationOutcome(validateRegistrationDraft, value);
}

/**
 * 校验 `RestrictionInput`（:15189）：8 个必填字段；`formulation_id`／`valid_to` 可为 null，
 * 但 `conditions` **不可为 null**（契约 `{ $ref: Conditions }`，与 `KnowledgeDraftInput` 的
 * `nullable: true` 不同）。
 */
export function validateRestrictionInput(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }
  checkString(value.source_id, '$.source_id', { min: 1, uuid: true }, errors, warnings);
  checkString(value.source_version, '$.source_version', { min: 1, max: 80 }, errors, warnings);
  checkString(value.formulation_id, '$.formulation_id', { min: 1, uuid: true, nullable: true }, errors, warnings);
  const conditions = validateConditions(value.conditions);
  for (const error of conditions.errors) errors.push({ path: `$.conditions${error.path.slice(1)}`, problem: error.problem });
  for (const warning of conditions.warnings) warnings.push({ path: `$.conditions${warning.path.slice(1)}`, problem: warning.problem });
  checkString(value.effect, '$.effect', { enum: RESTRICTION_EFFECTS }, errors, warnings);
  checkString(value.reason, '$.reason', { min: 1, max: 2000 }, errors, warnings);
  checkString(value.valid_from, '$.valid_from', { min: 1, dateTime: true }, errors, warnings);
  checkString(value.valid_to, '$.valid_to', { min: 1, dateTime: true, nullable: true }, errors, warnings);
  pushExtras(value, ['source_id', 'source_version', 'formulation_id', 'conditions', 'effect', 'reason', 'valid_from', 'valid_to'], '$', warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/** 校验 `Restriction`（:15256）：`{id, revision, content, review_status}`——**契约没有 visibility**。 */
export function validateRestrictionDraft(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }
  checkString(value.id, '$.id', { min: 1, uuid: true }, errors, warnings);
  if (!Number.isInteger(value.revision) || value.revision < 1) {
    errors.push({ path: '$.revision', problem: '缺少 >= 1 的整数 revision' });
  }
  checkString(value.review_status, '$.review_status', { enum: REVIEW_STATUSES }, errors, warnings);
  const content = validateRestrictionInput(value.content);
  for (const error of content.errors) errors.push({ path: `$.content${error.path.slice(1)}`, problem: error.problem });
  for (const warning of content.warnings) warnings.push({ path: `$.content${warning.path.slice(1)}`, problem: warning.problem });
  pushExtras(value, ['id', 'revision', 'content', 'review_status'], '$', warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/** 校验 `RestrictionPublicationOutcome`（publish / withdraw 的 200 出参）：`RestrictionDraft` 字段 + `changed`。 */
export function validateRestrictionPublicationOutcome(value) {
  return validatePublicationOutcome(validateRestrictionDraft, value);
}

/** 校验 `Category`（:14316）。 */
export function validateCategory(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }
  checkString(value.id, '$.id', { min: 1, max: 80 }, errors, warnings);
  if (!Number.isInteger(value.revision) || value.revision < 1) {
    errors.push({ path: '$.revision', problem: '缺少 >= 1 的整数 revision' });
  }
  checkString(value.type, '$.type', { enum: CATEGORY_TYPES }, errors, warnings);
  checkString(value.name, '$.name', { min: 1, max: 120 }, errors, warnings);
  checkString(value.description, '$.description', { min: 1, max: 2000 }, errors, warnings);
  if (typeof value.active !== 'boolean') errors.push({ path: '$.active', problem: '缺少布尔 active' });
  pushExtras(value, ['id', 'revision', 'type', 'name', 'description', 'active'], '$', warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/** 校验 `AuditEvent`（:14474，8 字段；`target_ref` 可为 null）。 */
export function validateAuditEvent(value) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings };
  }
  checkString(value.id, '$.id', { min: 1, uuid: true }, errors, warnings);
  checkString(value.action, '$.action', { min: 1, max: 80 }, errors, warnings);
  checkString(value.scope, '$.scope', { min: 1, max: 80 }, errors, warnings);
  checkString(value.reason_code, '$.reason_code', { min: 1, max: 80 }, errors, warnings);
  checkString(value.request_id, '$.request_id', { min: 1, uuid: true }, errors, warnings);
  checkString(value.result, '$.result', { enum: ['accepted', 'denied', 'failed'] }, errors, warnings);
  checkString(value.created_at, '$.created_at', { min: 1, dateTime: true }, errors, warnings);
  if (value.target_ref !== null && !isPlainObject(value.target_ref)) {
    errors.push({ path: '$.target_ref', problem: 'target_ref 只能是对象或 null' });
  }
  pushExtras(value, ['id', 'action', 'scope', 'target_ref', 'reason_code', 'request_id', 'result', 'created_at'], '$', warnings);
  return { ok: errors.length === 0, errors, warnings };
}

/** 通用分页校验：`{items[], next_cursor}`，逐行用 `validateRow` 验形状。 */
export function validatePage(value, validateRow) {
  const errors = [];
  const warnings = [];
  const items = [];
  let nextCursor = null;

  if (!isPlainObject(value)) {
    errors.push({ path: '$', problem: '不是对象' });
    return { ok: false, errors, warnings, items, nextCursor };
  }
  if (!Array.isArray(value.items)) {
    errors.push({ path: '$.items', problem: '缺少数组 items' });
  } else {
    if (value.items.length > LIMIT_MAX) {
      warnings.push({ path: '$.items', problem: `条目数 ${value.items.length} 超出契约 maxItems ${LIMIT_MAX}` });
    }
    value.items.forEach((item, index) => {
      const result = validateRow(item);
      for (const error of result.errors) errors.push({ path: `$.items[${index}]${error.path.slice(1)}`, problem: error.problem });
      for (const warning of result.warnings) warnings.push({ path: `$.items[${index}]${warning.path.slice(1)}`, problem: warning.problem });
      items.push(item);
    });
  }
  if (!('next_cursor' in value)) {
    errors.push({ path: '$.next_cursor', problem: '缺少 next_cursor（末页须显式为 null）' });
  } else if (value.next_cursor === null) {
    nextCursor = null;
  } else if (typeof value.next_cursor !== 'string' || value.next_cursor.length === 0) {
    errors.push({ path: '$.next_cursor', problem: 'next_cursor 只能是非空字符串或 null' });
  } else if (value.next_cursor.length > CURSOR_MAX_LENGTH) {
    errors.push({ path: '$.next_cursor', problem: `next_cursor 长度 ${value.next_cursor.length} 超出 ${CURSOR_MAX_LENGTH}` });
  } else {
    nextCursor = value.next_cursor;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'items' && key !== 'next_cursor') warnings.push({ path: `$.${key}`, problem: '契约外字段' });
  }
  return { ok: errors.length === 0, errors, warnings, items, nextCursor };
}

// ------------------------------------------------------------------ 表单 → 请求体
// 表单里全是字符串（`<input>` 的天然口径）。转换函数**逐字段**报错，不静默丢弃、
// 不把空串悄悄变成「没填这一项」，也不替用户猜 content_hash／条件值。

/** 空资料来源表单（新草稿）。 */
export function emptySourceForm() {
  return {
    title: '',
    url: '',
    publisher: '',
    source_kind: 'database',
    evidence_kind: 'research',
    version: '',
    content_hash: '',
    locator: '',
    valid_from: '',
    valid_to: '',
  };
}

/**
 * 详情 → 表单初值。
 *
 * **已知缺口（不补齐、不伪造）**：读面 `SourceRef`（:11420）不返回 `content_hash`／`locator`／
 * 有效期区间，因此编辑已存在来源时这四项只能由操作者重新填写；表单会标出这一点，不用旧值冒充。
 */
export function sourceFormFromRef(source) {
  const form = emptySourceForm();
  if (!isPlainObject(source)) return form;
  if (typeof source.title === 'string') form.title = source.title;
  if (typeof source.url === 'string') form.url = source.url;
  if (typeof source.publisher === 'string') form.publisher = source.publisher;
  if (SOURCE_KINDS.includes(source.source_kind)) form.source_kind = source.source_kind;
  if (EVIDENCE_KINDS.includes(source.evidence_kind)) form.evidence_kind = source.evidence_kind;
  if (typeof source.version === 'string') form.version = source.version;
  return form;
}

/** 表单 → `SourceDraftInput`（:13928，10 个字段全部 required，`valid_to` 可为 null）。 */
export function buildSourceInput(form) {
  const errors = [];
  const value = {
    title: typeof form?.title === 'string' ? form.title.trim() : '',
    url: typeof form?.url === 'string' ? form.url.trim() : '',
    publisher: typeof form?.publisher === 'string' ? form.publisher.trim() : '',
    source_kind: form?.source_kind,
    evidence_kind: form?.evidence_kind,
    version: typeof form?.version === 'string' ? form.version.trim() : '',
    content_hash: typeof form?.content_hash === 'string' ? form.content_hash.trim() : '',
    locator: typeof form?.locator === 'string' ? form.locator.trim() : '',
    valid_from: dateTimeFromLocal(form?.valid_from),
    valid_to: dateTimeFromLocal(form?.valid_to),
  };

  const rule = (ok, field, message) => {
    if (!ok) errors.push({ field, message });
  };
  rule(value.title !== '' && charLength(value.title) <= 200, 'title', '标题必填，且 ≤200 字');
  rule(isHttpsUrl(value.url), 'url', '链接必须是以 https:// 开头的可解析 URL');
  rule(value.publisher !== '' && charLength(value.publisher) <= 200, 'publisher', '发布方必填，且 ≤200 字');
  rule(SOURCE_KINDS.includes(value.source_kind), 'source_kind', '来源类型必须是 database／verified_seed／simulation');
  rule(EVIDENCE_KINDS.includes(value.evidence_kind), 'evidence_kind', '证据类型必须是 research／experience／mixed');
  rule(value.version !== '' && charLength(value.version) <= 80, 'version', '版本必填，且 ≤80 字');
  rule(CONTENT_HASH_RE.test(value.content_hash), 'content_hash', '内容指纹必须是 64 位小写十六进制（读面不返回它，需按原始资料重新计算）');
  rule(value.locator !== '' && charLength(value.locator) <= 200, 'locator', '定位串必填，且 ≤200 字（读面不返回它）');
  rule(value.valid_from !== null, 'valid_from', '生效时间必填（RFC 3339）');
  if (value.valid_to !== null && value.valid_from !== null && Date.parse(value.valid_to) <= Date.parse(value.valid_from)) {
    errors.push({ field: 'valid_to', message: '失效时间必须晚于生效时间' });
  }
  if (form?.valid_to !== undefined && typeof form.valid_to === 'string' && form.valid_to.trim() !== '' && value.valid_to === null) {
    errors.push({ field: 'valid_to', message: '失效时间无法解析为时间' });
  }
  return { ok: errors.length === 0, errors, value };
}

/** 空科普内容表单（新草稿）。 */
export function emptyKnowledgeForm() {
  return {
    type: 'species',
    title: '',
    body: '',
    source_id: '',
    source_version: '',
    with_conditions: false,
    crop_id: '',
    region_code: '',
    species_id: '',
    growth_stage: '',
    formulation_id: '',
  };
}

/** 详情 → 表单初值（`KnowledgeDraft.content` 是完整 `KnowledgeDraftInput`，因此可完整回填）。 */
export function knowledgeFormFromDetail(draft) {
  const form = emptyKnowledgeForm();
  const content = isPlainObject(draft) ? draft.content : null;
  if (!isPlainObject(content)) return form;
  if (KNOWLEDGE_TYPES.includes(content.type)) form.type = content.type;
  if (typeof content.title === 'string') form.title = content.title;
  if (typeof content.body === 'string') form.body = content.body;
  if (typeof content.source_id === 'string') form.source_id = content.source_id;
  if (typeof content.source_version === 'string') form.source_version = content.source_version;
  if (typeof content.formulation_id === 'string') form.formulation_id = content.formulation_id;
  if (isPlainObject(content.conditions)) {
    form.with_conditions = true;
    for (const key of ['crop_id', 'region_code', 'species_id', 'growth_stage']) {
      if (typeof content.conditions[key] === 'string') form[key] = content.conditions[key];
    }
  }
  return form;
}

/** 表单 → `KnowledgeDraftInput`（:14042）。`conditions` 仅在勾选时构造，否则显式 `null`。 */
export function buildKnowledgeInput(form) {
  const errors = [];
  const trim = (value) => (typeof value === 'string' ? value.trim() : '');
  const value = {
    type: form?.type,
    title: trim(form?.title),
    body: typeof form?.body === 'string' ? form.body : '',
    source_id: trim(form?.source_id).toLowerCase(),
    source_version: trim(form?.source_version),
    conditions: null,
    formulation_id: trim(form?.formulation_id) === '' ? null : trim(form?.formulation_id).toLowerCase(),
  };
  if (form?.with_conditions === true) {
    const conditions = { crop_id: trim(form?.crop_id), region_code: trim(form?.region_code) };
    if (trim(form?.species_id) !== '') conditions.species_id = trim(form.species_id);
    if (trim(form?.growth_stage) !== '') conditions.growth_stage = trim(form.growth_stage);
    value.conditions = conditions;
  }

  const rule = (ok, field, message) => {
    if (!ok) errors.push({ field, message });
  };
  rule(KNOWLEDGE_TYPES.includes(value.type), 'type', '类型必须是 species／herbicide／scheme／static_region');
  rule(value.title !== '' && charLength(value.title) <= 200, 'title', '标题必填，且 ≤200 字');
  rule(value.body !== '' && charLength(value.body) <= 20000, 'body', '正文必填，且 ≤20000 字');
  rule(UUID_RE.test(value.source_id), 'source_id', '来源 ID 必须是 uuid（可先用「来源」子页确认）');
  rule(value.source_version !== '' && charLength(value.source_version) <= 80, 'source_version', '来源版本必填，且 ≤80 字');
  if (value.formulation_id !== null) {
    rule(UUID_RE.test(value.formulation_id), 'formulation_id', '制剂 ID 必须是 uuid 或留空');
  }
  if (value.conditions !== null) {
    rule(value.conditions.crop_id !== '', 'crop_id', '带条件时作物 ID 必填');
    rule(REGION_CODE_RE.test(value.conditions.region_code), 'region_code', '带条件时地区码必须是 33 开头的 6 位数字');
  }
  return { ok: errors.length === 0, errors, value };
}

/** 空注册资料表单（新草稿）。`ingredients` 先给一条，因为契约 `minItems: 1`。 */
export function emptyRegistrationForm() {
  return {
    registered_name: '',
    source_id: '',
    source_version: '',
    valid_from: '',
    valid_to: '',
    // `RegistrationDraftInput.formulation`（:12527）拍平到表单键上，提交时再嵌回去。
    registration_number: '',
    producer: '',
    dosage_form: '',
    ingredients: [{ name: '', content_text: '', unit_text: '' }],
  };
}

/**
 * 详情 → 表单初值。
 *
 * `RegistrationDraft.content` 是完整 `RegistrationDraftInput`，因此这里**可以完整回填**
 * （不像 sources 读面缺 content_hash／locator）。
 */
export function registrationFormFromDetail(draft) {
  const form = emptyRegistrationForm();
  const content = isPlainObject(draft) ? draft.content : null;
  if (!isPlainObject(content)) return form;
  if (typeof content.registered_name === 'string') form.registered_name = content.registered_name;
  if (typeof content.source_id === 'string') form.source_id = content.source_id;
  if (typeof content.source_version === 'string') form.source_version = content.source_version;
  form.valid_from = dateTimeToLocal(content.valid_from);
  form.valid_to = dateTimeToLocal(content.valid_to);
  const formulation = isPlainObject(content.formulation) ? content.formulation : null;
  if (formulation !== null) {
    if (typeof formulation.registration_number === 'string') form.registration_number = formulation.registration_number;
    if (typeof formulation.producer === 'string') form.producer = formulation.producer;
    if (typeof formulation.dosage_form === 'string') form.dosage_form = formulation.dosage_form;
    if (Array.isArray(formulation.ingredients) && formulation.ingredients.length > 0) {
      form.ingredients = formulation.ingredients.map((item) => ({
        name: typeof item?.name === 'string' ? item.name : '',
        content_text: typeof item?.content_text === 'string' ? item.content_text : '',
        unit_text: typeof item?.unit_text === 'string' ? item.unit_text : '',
      }));
    }
  }
  return form;
}

/** 表单 → `RegistrationDraftInput`（:15112）。空 `valid_to` 显式转 `null`。 */
export function buildRegistrationInput(form) {
  const errors = [];
  const trim = (value) => (typeof value === 'string' ? value.trim() : '');
  const ingredientsRaw = Array.isArray(form?.ingredients) ? form.ingredients : [];
  const ingredients = ingredientsRaw.map((item) => ({
    name: trim(item?.name),
    content_text: trim(item?.content_text),
    unit_text: trim(item?.unit_text),
  }));
  const value = {
    formulation: {
      registration_number: trim(form?.registration_number),
      producer: trim(form?.producer),
      dosage_form: trim(form?.dosage_form),
      ingredients,
    },
    source_id: trim(form?.source_id).toLowerCase(),
    source_version: trim(form?.source_version),
    registered_name: trim(form?.registered_name),
    valid_from: dateTimeFromLocal(form?.valid_from),
    valid_to: dateTimeFromLocal(form?.valid_to),
  };

  const rule = (ok, field, message) => {
    if (!ok) errors.push({ field, message });
  };
  rule(value.registered_name !== '' && charLength(value.registered_name) <= 200, 'registered_name', '登记名称必填，且 ≤200 字');
  rule(UUID_RE.test(value.source_id), 'source_id', '来源 ID 必须是 uuid（可先用「来源」子页确认）');
  rule(value.source_version !== '' && charLength(value.source_version) <= 80, 'source_version', '来源版本必填，且 ≤80 字');
  rule(value.formulation.registration_number !== '' && charLength(value.formulation.registration_number) <= 80, 'registration_number', '登记证号必填，且 ≤80 字');
  rule(value.formulation.producer !== '' && charLength(value.formulation.producer) <= 200, 'producer', '生产企业必填，且 ≤200 字');
  rule(value.formulation.dosage_form !== '' && charLength(value.formulation.dosage_form) <= 80, 'dosage_form', '剂型必填，且 ≤80 字');
  rule(ingredients.length >= INGREDIENTS_MIN && ingredients.length <= INGREDIENTS_MAX, 'ingredients', `有效成分 ${INGREDIENTS_MIN}..${INGREDIENTS_MAX} 条（当前 ${ingredients.length} 条）`);
  ingredients.forEach((item, index) => {
    for (const [key, label] of [['name', '成分名'], ['content_text', '含量'], ['unit_text', '单位']]) {
      rule(item[key] !== '' && charLength(item[key]) <= 80, `ingredients[${index}].${key}`, `第 ${index + 1} 条${label}必填，且 ≤80 字`);
    }
  });
  rule(value.valid_from !== null, 'valid_from', '生效时间必填（RFC 3339）');
  if (form?.valid_to !== undefined && typeof form.valid_to === 'string' && form.valid_to.trim() !== '' && value.valid_to === null) {
    errors.push({ field: 'valid_to', message: '失效时间无法解析为时间' });
  }
  if (value.valid_to !== null && value.valid_from !== null && Date.parse(value.valid_to) <= Date.parse(value.valid_from)) {
    errors.push({ field: 'valid_to', message: '失效时间必须晚于生效时间' });
  }
  return { ok: errors.length === 0, errors, value };
}

/**
 * 空限制资料表单（新草稿）。
 *
 * `conditions` 在契约里**不可为 null**（:15189），所以 `crop_id`／`region_code` 恒为必填，
 * 不像科普内容的「可选带条件」。
 */
export function emptyRestrictionForm() {
  return {
    source_id: '',
    source_version: '',
    formulation_id: '',
    effect: 'unknown',
    reason: '',
    valid_from: '',
    valid_to: '',
    crop_id: '',
    region_code: '',
    species_id: '',
    growth_stage: '',
    planting_method: '',
    use_scene: '',
  };
}

/** 详情 → 表单初值（`Restriction.content` 是完整输入，可完整回填）。 */
export function restrictionFormFromDetail(draft) {
  const form = emptyRestrictionForm();
  const content = isPlainObject(draft) ? draft.content : null;
  if (!isPlainObject(content)) return form;
  if (typeof content.source_id === 'string') form.source_id = content.source_id;
  if (typeof content.source_version === 'string') form.source_version = content.source_version;
  if (typeof content.formulation_id === 'string') form.formulation_id = content.formulation_id;
  if (RESTRICTION_EFFECTS.includes(content.effect)) form.effect = content.effect;
  if (typeof content.reason === 'string') form.reason = content.reason;
  form.valid_from = dateTimeToLocal(content.valid_from);
  form.valid_to = dateTimeToLocal(content.valid_to);
  if (isPlainObject(content.conditions)) {
    for (const key of ['crop_id', 'region_code', ...CONDITION_OPTIONAL_KEYS]) {
      if (typeof content.conditions[key] === 'string') form[key] = content.conditions[key];
    }
  }
  return form;
}

/** 表单 → `RestrictionInput`（:15189）。可选条件项为空时**不写这个键**（契约 additionalProperties:false 但字段可选）。 */
export function buildRestrictionInput(form) {
  const errors = [];
  const trim = (value) => (typeof value === 'string' ? value.trim() : '');
  const conditions = {
    crop_id: trim(form?.crop_id),
    region_code: trim(form?.region_code),
  };
  for (const key of CONDITION_OPTIONAL_KEYS) {
    const raw = trim(form?.[key]);
    if (raw !== '') conditions[key] = raw;
  }
  const value = {
    source_id: trim(form?.source_id).toLowerCase(),
    source_version: trim(form?.source_version),
    formulation_id: trim(form?.formulation_id) === '' ? null : trim(form?.formulation_id).toLowerCase(),
    conditions,
    effect: form?.effect,
    reason: typeof form?.reason === 'string' ? form.reason.trim() : '',
    valid_from: dateTimeFromLocal(form?.valid_from),
    valid_to: dateTimeFromLocal(form?.valid_to),
  };

  const rule = (ok, field, message) => {
    if (!ok) errors.push({ field, message });
  };
  rule(UUID_RE.test(value.source_id), 'source_id', '来源 ID 必须是 uuid（可先用「来源」子页确认）');
  rule(value.source_version !== '' && charLength(value.source_version) <= 80, 'source_version', '来源版本必填，且 ≤80 字');
  if (value.formulation_id !== null) rule(UUID_RE.test(value.formulation_id), 'formulation_id', '制剂 ID 必须是 uuid 或留空');
  rule(value.conditions.crop_id !== '' && charLength(value.conditions.crop_id) <= 80, 'crop_id', '作物 ID 必填（契约 Conditions 的 required）');
  rule(REGION_CODE_RE.test(value.conditions.region_code), 'region_code', '地区码必须是 33 开头的 6 位数字');
  rule(RESTRICTION_EFFECTS.includes(value.effect), 'effect', '限制结论必须是 prohibited／restricted／unknown');
  rule(value.reason !== '' && charLength(value.reason) <= 2000, 'reason', '限制理由必填，且 ≤2000 字');
  rule(value.valid_from !== null, 'valid_from', '生效时间必填（RFC 3339）');
  if (form?.valid_to !== undefined && typeof form.valid_to === 'string' && form.valid_to.trim() !== '' && value.valid_to === null) {
    errors.push({ field: 'valid_to', message: '失效时间无法解析为时间' });
  }
  if (value.valid_to !== null && value.valid_from !== null && Date.parse(value.valid_to) <= Date.parse(value.valid_from)) {
    errors.push({ field: 'valid_to', message: '失效时间必须晚于生效时间' });
  }
  return { ok: errors.length === 0, errors, value };
}

/** `Category` → 表单初值。 */
export function categoryFormFromDetail(category) {
  const form = { name: '', description: '', active: true };
  if (!isPlainObject(category)) return form;
  if (typeof category.name === 'string') form.name = category.name;
  if (typeof category.description === 'string') form.description = category.description;
  if (typeof category.active === 'boolean') form.active = category.active;
  return form;
}

/** 表单 → `CategoryInput`（:14359；**没有 type 字段**，PATCH 不能改分类类型）。 */
export function buildCategoryInput(form) {
  const errors = [];
  const value = {
    name: typeof form?.name === 'string' ? form.name.trim() : '',
    description: typeof form?.description === 'string' ? form.description.trim() : '',
    active: form?.active === true,
  };
  if (value.name === '' || charLength(value.name) > 120) errors.push({ field: 'name', message: '名称必填，且 ≤120 字' });
  if (value.description === '' || charLength(value.description) > 2000) {
    errors.push({ field: 'description', message: '说明必填，且 ≤2000 字' });
  }
  if (typeof form?.active !== 'boolean') errors.push({ field: 'active', message: '启用状态必须是布尔值' });
  return { ok: errors.length === 0, errors, value };
}

/** 发布请求体 `SourcePublishInput`（:14022；科普内容发布复用同一形状）。 */
export function buildPublishInput({ evidenceRef, reason }) {
  const errors = [];
  const value = {
    evidence_ref: typeof evidenceRef === 'string' ? evidenceRef.trim() : '',
    reason: typeof reason === 'string' ? reason.trim() : '',
  };
  if (value.evidence_ref === '' || charLength(value.evidence_ref) > 80) {
    errors.push({ field: 'evidence_ref', message: '证据引用必填，且 ≤80 字（服务端会核对受控值）' });
  }
  if (value.reason === '' || charLength(value.reason) > 500) {
    errors.push({ field: 'reason', message: '发布理由必填，且 ≤500 字' });
  }
  return { ok: errors.length === 0, errors, value };
}

/** 下架请求体 `ReasonInput`（:14383）。 */
export function buildWithdrawInput({ reason }) {
  const errors = [];
  const value = { reason: typeof reason === 'string' ? reason.trim() : '' };
  if (value.reason === '' || charLength(value.reason) > 500) {
    errors.push({ field: 'reason', message: '下架理由必填，且 ≤500 字' });
  }
  return { ok: errors.length === 0, errors, value };
}

/** 契约错误码 → 是否契约内（未知 code 也要原样显示，只是标 `inContract: false`）。 */
export function isContractErrorCode(code) {
  return ERROR_CODES.includes(code);
}
