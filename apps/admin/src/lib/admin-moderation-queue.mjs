/**
 * 后台「社区审核队列」读面 + 审帖动作客户端 —— 纯 ESM，无 Vue／DOM 依赖，可用假 fetch 注入测试。
 *
 * ## 契约事实（`packages/contracts/openapi.json`，逐条给行号；R68-A05 净删 540 行后已按符号复核）
 * - `GET /admin/posts`（:11434）operationId `listAdminPosts`（:11436）、`x-scope: sources:read`（:11527）；
 *   参数 `Cursor`（:11449）／`Limit`（:11452）／`state`（:11455，`$ref Visibility`，「按 `visibility` 精确筛选」）／
 *   `audit_state`（:11463，`$ref AuditState`）；**无请求体**；200 `AdminPostPageEnvelope`（:11477）。
 *   ⚠ 参数名就是 `state` 与 `audit_state`（snake）；**没有** `entity`／`entity_type`／作者／来源维度。
 * - `GET /admin/posts/{id}`（:11532）`getAdminPost`（:11534）、`x-scope: sources:read`（:11612）；
 *   path `id`（uuid，:11547-11552）；200 `AdminPostEnvelope`（:11562）+ `ETag`（:11567-11571，描述原文
 *   「资源revision强ETag；列表无此头」）；不存在 404（:11536 原文「不用 403，避免泄露存在性」）。
 * - `POST /admin/posts/{id}/approve`（:11727）`approvePost`（:11729）、`x-scope: sources:write`（:11822）；
 *   参数 `IdempotencyKey`（:11751）＋`IfMatch`（:11754）；**没有 requestBody**；200
 *   `PostReviewOutcomeEnvelope`（:11763）。可见性语义以服务端实现为准（`admin/ops/community-posts.ts`
 *   的 `review()`）：通过写 `audit_state=approved`，并把 `private` 帖一并推到 `published`；硬规则明确否决 422。
 * - `POST /admin/posts/{id}/reject`（:11827）`rejectPost`（:11829）、`x-scope: sources:write`（:11922）；
 *   请求体 `PostRejectionInput`（schema :16364：`reason_code` 闭集 10 值、必填、`additionalProperties:false`）；
 *   200 `PostReviewOutcomeEnvelope`（:11863）。描述（:11831）：`audit_state=rejected` **且** `visibility=hidden`，并通知作者。
 * - 幂等语义：`PostReviewOutcome`（schema :16389，8 个必填字段含 `changed`／`notified`）——重复动作返回
 *   `changed:false`。本模块**不把 `changed:false` 当成功**：页面显示「已是该状态」（见 `describeReviewOutcome`）。
 * - 响应码不是四个 op 一套（R68-A05 收窄后实测）：两个 GET 为 `200/400/401/403/404/409/422/429/500/503/504`
 *   （GET 不解析请求体 ⇒ 无 413/415；无前置条件头 ⇒ 无 428）；两个 POST（approve／reject）另含 `413/415/428`。
 *
 * ## 服务层事实（只读核对，`services/api/src/admin/ops/service.ts`）
 * - `:1297` 只在 `changed` 时记审计并回新 ETag；`:1275-1294` 错误映射：`NOT_FOUND`→404、
 *   `DELETED`→409 `OBJECT_UNAVAILABLE`（已删除内容不复活）、`REVISION_CONFLICT`→409、
 *   `RULE_VETOED`→422 `INPUT_UNCERTAIN`（:1281-1283 原文「硬规则已明确否决…不允许人工通过」）；
 * - `:1247` `approvePost` 带请求体 ⇒ 400 `INVALID_REQUEST`（契约里 approve **无请求体**）；
 * - `:1355` 注释：`hidden`／`deleted` 不被通过动作翻案（单向门），命中时幂等返回当前状态、`changed:false`。
 *
 * ## 复用（**不复制**）
 * - `admin-contract.mjs`：`readErrorEnvelope`／`readPageEnvelope`／`isPlainObject`／`ERROR_CODES`／边界常量；
 * - `admin-api.mjs`：`normalizeBaseUrl`／`clampLimit`／`emptyCollection`／`appendPage`（含按 id 去重与
 *   「服务端把本次 cursor 原样回传」的成环判断）；
 * - `post-takedown-api.mjs`：`If-Match` 生成与校验、幂等键生成/复用、POST 失败分类
 *   （同一个「POST + If-Match + Idempotency-Key」语义，没有第二套实现）。
 *
 * 本模块不记录、不回传 access token；不与 `review-state.mjs`（人审工作流空态）互相引用。
 */

import {
  CURSOR_MAX_LENGTH,
  ERROR_CODES,
  isPlainObject,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  readErrorEnvelope,
  readPageEnvelope,
} from './admin-contract.mjs';
import { appendPage, clampLimit, emptyCollection, normalizeBaseUrl } from './admin-api.mjs';
import {
  buildIfMatch,
  classifyHideFailure,
  normalizeIdempotencyKey,
  normalizePostId,
  POSTS_PATH,
  readHideErrorEnvelope,
  SOURCES_WRITE_SCOPE,
  validateRevision,
} from './post-takedown-api.mjs';

// ------------------------------------------------------------------ 契约常量

/** 读面路径（与下架面同一个 `/admin/posts` 家族；`POSTS_PATH` 复用，不另写字面量）。 */
export const MODERATION_QUEUE_PATH = POSTS_PATH;

/** 两个读面的 scope（契约 `x-scope` 原文 :11527 / :11612）。 */
export const MODERATION_READ_SCOPE = 'sources:read';

/** 两个动作的 scope（契约 `x-scope` 原文 :11822 / :11922）。 */
export const MODERATION_WRITE_SCOPE = SOURCES_WRITE_SCOPE;

export const LIST_OPERATION_ID = 'listAdminPosts';
export const DETAIL_OPERATION_ID = 'getAdminPost';
export const APPROVE_OPERATION_ID = 'approvePost';
export const REJECT_OPERATION_ID = 'rejectPost';

/** 契约 `Visibility` 闭集（schema :12351 / 亦见 :11457 的筛选描述）。 */
export const VISIBILITY_STATES = Object.freeze(['private', 'published', 'hidden', 'deleted']);

export const VISIBILITY_LABELS = Object.freeze({
  private: 'private（未公开）',
  published: 'published（已公开）',
  hidden: 'hidden（已隐藏）',
  deleted: 'deleted（已删除）',
});

/** 契约 `AuditState` 闭集（schema :12342）。 */
export const AUDIT_STATES = Object.freeze(['pending', 'approved', 'rejected', 'quarantined']);

export const AUDIT_STATE_LABELS = Object.freeze({
  pending: 'pending（待审）',
  // 不写「AI 筛查通过」也不写「人工通过」：`audit_state` 只记状态，不记是谁审的（审核人只落在审计台账）。
  approved: 'approved（已通过）',
  rejected: 'rejected（已驳回）',
  quarantined: 'quarantined（隔离待查）',
});

/** 审帖动作闭集（= 契约里两个 POST 的路径段 :11727 / :11827）。 */
export const REVIEW_DECISIONS = Object.freeze(['approve', 'reject']);

/**
 * 契约 `PostRejectionInput.reason_code` 闭集（schema :16364）。
 * 单一来源：`services/api/src/admin/ops/types.ts` 的 `POST_REVIEW_REASON_CODES`。
 */
export const POST_REVIEW_REASON_CODES = Object.freeze([
  'spam',
  'harassment',
  'adult_or_violent',
  'illegal_or_political',
  'privacy',
  'misleading_agronomy',
  'banned_agrochemical',
  'off_topic',
  'duplicate',
  'other',
]);

export const POST_REVIEW_REASON_LABELS = Object.freeze({
  spam: '垃圾广告/刷屏',
  harassment: '骚扰辱骂',
  adult_or_violent: '色情或暴力',
  illegal_or_political: '违法违规或政治敏感',
  privacy: '泄露他人隐私',
  misleading_agronomy: '农技信息误导',
  banned_agrochemical: '违禁农药',
  off_topic: '与本社区主题无关',
  duplicate: '重复内容',
  other: '其他',
});

/** 每页条数选项（契约 `Limit` 是 1..50，default 20）。 */
export const MODERATION_LIMIT_OPTIONS = Object.freeze(
  [LIMIT_DEFAULT, LIMIT_MAX].filter((value, index, list) => list.indexOf(value) === index),
);

/** 筛选器「全部」哨兵：不上行成 query 参数。 */
export const MODERATION_FILTER_ANY = 'all';

/** 契约字段边界（`AdminPost` schema :16735）。 */
export const POST_TITLE_MAX = 120;
export const POST_BODY_MAX = 8000;
export const POST_MEDIA_MAX = 3;
export const ANONYMIZED_REF_MAX = 64;
export const CROP_ID_MAX = 80;

/** 契约 `AdminPost.region_code` pattern（`^33[0-9]{4}$`）。 */
export const REGION_CODE_PATTERN = /^33[0-9]{4}$/;

/** 契约 `AdminPost.anonymized_author_ref` pattern（`gy-anon-<16 hex>`）。 */
export const ANONYMIZED_REF_PATTERN = /^gy-anon-[0-9a-f]{16}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 读面「值得重试」的种类闭集（其余重试同一请求不会改变结论）。 */
const RETRIABLE_KINDS = Object.freeze(['rate_limited', 'unavailable', 'network_error']);

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function charLength(value) {
  return [...value].length;
}

function isNullableString(value, min, max) {
  if (value === null) return true;
  return typeof value === 'string' && charLength(value) >= min && charLength(value) <= max;
}

// ------------------------------------------------------------------ 筛选（纯函数）

export function emptyModerationFilters() {
  return { state: MODERATION_FILTER_ANY, auditState: MODERATION_FILTER_ANY };
}

/** 归一化（trim，空串与缺失都回落到「全部」）；不校验枚举。 */
export function normalizeModerationFilters(filters) {
  const source = isPlainObject(filters) ? filters : {};
  const pick = (value) => {
    if (typeof value !== 'string') return MODERATION_FILTER_ANY;
    const trimmed = value.trim();
    return trimmed === '' ? MODERATION_FILTER_ANY : trimmed;
  };
  return { state: pick(source.state), auditState: pick(source.auditState) };
}

/** 校验枚举：不在闭集内 ⇒ `ok:false`，由页面拦下、**不发**必然 400 的请求。 */
export function validateModerationFilters(filters) {
  const normalized = normalizeModerationFilters(filters);
  const problems = [];
  if (normalized.state !== MODERATION_FILTER_ANY && !VISIBILITY_STATES.includes(normalized.state)) {
    problems.push({ field: 'state', message: `state 只能是 ${VISIBILITY_STATES.join(' / ')} 或「全部」` });
  }
  if (normalized.auditState !== MODERATION_FILTER_ANY && !AUDIT_STATES.includes(normalized.auditState)) {
    problems.push({ field: 'audit_state', message: `audit_state 只能是 ${AUDIT_STATES.join(' / ')} 或「全部」` });
  }
  return { ok: problems.length === 0, filters: normalized, problems };
}

export function hasActiveModerationFilters(filters) {
  const normalized = normalizeModerationFilters(filters);
  return normalized.state !== MODERATION_FILTER_ANY || normalized.auditState !== MODERATION_FILTER_ANY;
}

/** 人话描述（页面 pills 与证据页共用）。 */
export function describeModerationFilters(filters) {
  const normalized = normalizeModerationFilters(filters);
  const parts = [];
  parts.push(normalized.state === MODERATION_FILTER_ANY ? '全部可见性' : `visibility=${normalized.state}`);
  parts.push(normalized.auditState === MODERATION_FILTER_ANY ? '全部审核态' : `audit_state=${normalized.auditState}`);
  return parts.join(' · ');
}

/** 归一化筛选 → 契约 query 键值对（顺序固定：`state` 先、`audit_state` 后）。 */
export function filtersToQuery(filters) {
  const normalized = normalizeModerationFilters(filters);
  const pairs = [];
  if (normalized.state !== MODERATION_FILTER_ANY) pairs.push(['state', normalized.state]);
  if (normalized.auditState !== MODERATION_FILTER_ANY) pairs.push(['audit_state', normalized.auditState]);
  return pairs;
}

// ------------------------------------------------------------------ URL（纯函数）

/**
 * 拼列表 URL。`limit` 总带（夹紧 1..50），`cursor` 仅在续页带，筛选非「全部」才带。
 * 游标超过契约上限 2048、或筛选不在闭集内 ⇒ 抛错，**宁可不发请求**。
 */
export function buildModerationQueueUrl(baseUrl, options = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const params = new URLSearchParams();
  params.set('limit', String(clampLimit(options.limit ?? LIMIT_DEFAULT)));

  const cursor = options.cursor;
  if (cursor !== null && cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length === 0) throw new TypeError('cursor 必须是非空字符串');
    if (cursor.length > CURSOR_MAX_LENGTH) throw new RangeError(`cursor 超过契约上限 ${CURSOR_MAX_LENGTH} 字符`);
    params.set('cursor', cursor);
  }

  const checked = validateModerationFilters(options.filters ?? null);
  if (!checked.ok) throw new TypeError(checked.problems.map((problem) => problem.message).join('；'));
  for (const [key, value] of filtersToQuery(checked.filters)) params.set(key, value);

  return `${base}${MODERATION_QUEUE_PATH}?${params.toString()}`;
}

/** 拼详情 URL（`GET /admin/posts/{id}`）；非 uuid 直接抛错。 */
export function buildAdminPostDetailUrl(baseUrl, postId) {
  const id = normalizePostId(postId);
  if (id === null) throw new TypeError('帖子 ID 必须是 uuid（契约 path 参数 format: uuid）');
  return `${normalizeBaseUrl(baseUrl)}${MODERATION_QUEUE_PATH}/${id}`;
}

// ------------------------------------------------------------------ 响应校验（纯函数）

const ADMIN_POST_REQUIRED = Object.freeze([
  'id',
  'revision',
  'author_id',
  'anonymized_author_ref',
  'title',
  'body',
  'crop_id',
  'region_code',
  'media_ids',
  'visibility',
  'audit_state',
  'created_at',
  'updated_at',
  'linked_knowledge_ref',
]);

function validateKnowledgeTarget(value) {
  if (value === null) return { ok: true, errors: [] };
  if (!isPlainObject(value)) return { ok: false, errors: [{ path: '$.linked_knowledge_ref', problem: '必须是对象或 null' }] };
  const errors = [];
  if (!['species', 'herbicide', 'scheme'].includes(value.type)) {
    errors.push({ path: '$.linked_knowledge_ref.type', problem: '必须是 species / herbicide / scheme' });
  }
  if (typeof value.id !== 'string' || charLength(value.id) < 1 || charLength(value.id) > 80) {
    errors.push({ path: '$.linked_knowledge_ref.id', problem: '必须是 1..80 字符的字符串' });
  }
  if (!Number.isInteger(value.revision) || value.revision < 1) {
    errors.push({ path: '$.linked_knowledge_ref.revision', problem: '必须是 >= 1 的整数' });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 校验一条 `AdminPost`（schema :16735，`additionalProperties: false`）。
 *
 * 口径：**缺字段/类型不符记 error**（该行不渲染，不猜测缺字段）；多余字段记 `warnings`
 * （服务端加字段不该让整页白掉，但也不隐藏）。`extras` 原样返回供测试与证据页核对。
 */
export function validateAdminPost(value) {
  if (!isPlainObject(value)) {
    return { ok: false, post: null, errors: [{ path: '$', problem: '不是对象' }], warnings: [], extras: [] };
  }
  const errors = [];
  const warnings = [];

  for (const key of ADMIN_POST_REQUIRED) {
    if (!(key in value)) errors.push({ path: `$.${key}`, problem: '缺少契约必填字段' });
  }

  if (value.id !== undefined && !isUuid(value.id)) errors.push({ path: '$.id', problem: '必须是 uuid' });
  if (value.revision !== undefined && (!Number.isInteger(value.revision) || value.revision < 1)) {
    errors.push({ path: '$.revision', problem: '必须是 >= 1 的整数' });
  }
  if (value.author_id !== undefined && value.author_id !== null && !isUuid(value.author_id)) {
    errors.push({ path: '$.author_id', problem: '必须是 uuid 或 null（注销作者为 null）' });
  }
  if (value.anonymized_author_ref !== undefined && !isNullableString(value.anonymized_author_ref, 1, ANONYMIZED_REF_MAX)) {
    errors.push({ path: '$.anonymized_author_ref', problem: `必须是 1..${ANONYMIZED_REF_MAX} 字符或 null` });
  } else if (typeof value.anonymized_author_ref === 'string' && !ANONYMIZED_REF_PATTERN.test(value.anonymized_author_ref)) {
    warnings.push({ path: '$.anonymized_author_ref', problem: '不符合契约 pattern gy-anon-<16 hex>' });
  }
  if (value.title !== undefined && (typeof value.title !== 'string' || charLength(value.title) < 1 || charLength(value.title) > POST_TITLE_MAX)) {
    errors.push({ path: '$.title', problem: `必须是 1..${POST_TITLE_MAX} 字符` });
  }
  if (value.body !== undefined && (typeof value.body !== 'string' || charLength(value.body) < 1 || charLength(value.body) > POST_BODY_MAX)) {
    errors.push({ path: '$.body', problem: `必须是 1..${POST_BODY_MAX} 字符` });
  }
  if (value.crop_id !== undefined && !isNullableString(value.crop_id, 1, CROP_ID_MAX)) {
    errors.push({ path: '$.crop_id', problem: `必须是 1..${CROP_ID_MAX} 字符或 null` });
  }
  if (value.region_code !== undefined) {
    if (value.region_code === null) {
      // null 合法
    } else if (typeof value.region_code !== 'string' || !REGION_CODE_PATTERN.test(value.region_code)) {
      errors.push({ path: '$.region_code', problem: '必须匹配 ^33[0-9]{4}$ 或 null' });
    }
  }
  if (value.media_ids !== undefined) {
    if (!Array.isArray(value.media_ids)) {
      errors.push({ path: '$.media_ids', problem: '必须是数组' });
    } else if (value.media_ids.length > POST_MEDIA_MAX) {
      errors.push({ path: '$.media_ids', problem: `最多 ${POST_MEDIA_MAX} 个` });
    } else if (!value.media_ids.every((id) => isUuid(id))) {
      errors.push({ path: '$.media_ids', problem: '每项必须是 uuid' });
    }
  }
  if (value.visibility !== undefined && !VISIBILITY_STATES.includes(value.visibility)) {
    errors.push({ path: '$.visibility', problem: `必须是 ${VISIBILITY_STATES.join(' / ')}` });
  }
  if (value.audit_state !== undefined && !AUDIT_STATES.includes(value.audit_state)) {
    errors.push({ path: '$.audit_state', problem: `必须是 ${AUDIT_STATES.join(' / ')}` });
  }
  for (const key of ['created_at', 'updated_at']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key] === '') {
      errors.push({ path: `$.${key}`, problem: '必须是非空字符串（date-time）' });
    } else if (Number.isNaN(Date.parse(value[key]))) {
      warnings.push({ path: `$.${key}`, problem: '不是可解析的 date-time' });
    }
  }
  const knowledge = validateKnowledgeTarget(value.linked_knowledge_ref);
  errors.push(...knowledge.errors);

  const extras = Object.keys(value).filter((key) => !ADMIN_POST_REQUIRED.includes(key));
  return { ok: errors.length === 0, post: errors.length === 0 ? value : null, errors, warnings, extras };
}

/**
 * 校验 `AdminPostPage`（schema :16856）：`items` 最多 50、`next_cursor` 为 null 或 1..2048 字符串。
 * 任一 `items` 行不合规 ⇒ 整体 `ok:false`（不渲染「看起来能点但字段残缺」的行）。
 */
export function validateAdminPostPage(value) {
  if (!isPlainObject(value)) {
    return { ok: false, items: [], nextCursor: null, errors: [{ path: '$', problem: '不是对象' }], warnings: [] };
  }
  const errors = [];
  const warnings = [];
  const items = [];
  if (!Array.isArray(value.items)) {
    errors.push({ path: '$.items', problem: '必须是数组' });
  } else if (value.items.length > LIMIT_MAX) {
    errors.push({ path: '$.items', problem: `一次最多 ${LIMIT_MAX} 条（契约 maxItems）` });
  } else {
    value.items.forEach((item, index) => {
      const checked = validateAdminPost(item);
      if (!checked.ok) {
        for (const error of checked.errors) errors.push({ path: `$.items[${index}]${error.path.slice(1)}`, problem: error.problem });
      }
      for (const warning of checked.warnings) {
        warnings.push({ path: `$.items[${index}]${warning.path.slice(1)}`, problem: warning.problem });
      }
      if (checked.ok) items.push(item);
    });
  }
  const cursor = value.next_cursor;
  let nextCursor = null;
  if (cursor !== null) {
    if (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > CURSOR_MAX_LENGTH) {
      errors.push({ path: '$.next_cursor', problem: `必须为 null 或 1..${CURSOR_MAX_LENGTH} 字符的字符串` });
    } else {
      nextCursor = cursor;
    }
  }
  return { ok: errors.length === 0, items, nextCursor, errors, warnings };
}

/** 契约 `PostReviewOutcome`（schema :15966）的 8 个必填字段（顺序即契约顺序）。 */
export const POST_REVIEW_OUTCOME_FIELDS = Object.freeze([
  'id',
  'revision',
  'audit_state',
  'visibility',
  'decision',
  'changed',
  'notified',
  'reason_codes',
]);

/** 校验 200 的 `PostReviewOutcome`；**`changed`/`notified` 必须是布尔**，缺了就是畸形响应。 */
export function validatePostReviewOutcome(value) {
  if (!isPlainObject(value)) {
    return { ok: false, outcome: null, errors: [{ path: '$', problem: '不是对象' }], extras: [] };
  }
  const errors = [];
  for (const key of POST_REVIEW_OUTCOME_FIELDS) {
    if (!(key in value)) errors.push({ path: `$.${key}`, problem: '缺少契约必填字段' });
  }
  if (value.id !== undefined && !isUuid(value.id)) errors.push({ path: '$.id', problem: '必须是 uuid' });
  if (value.revision !== undefined && (!Number.isInteger(value.revision) || value.revision < 1)) {
    errors.push({ path: '$.revision', problem: '必须是 >= 1 的整数' });
  }
  if (value.audit_state !== undefined && !['approved', 'rejected'].includes(value.audit_state)) {
    errors.push({ path: '$.audit_state', problem: '必须是 approved / rejected' });
  }
  if (value.visibility !== undefined && !VISIBILITY_STATES.includes(value.visibility)) {
    errors.push({ path: '$.visibility', problem: `必须是 ${VISIBILITY_STATES.join(' / ')}` });
  }
  if (value.decision !== undefined && !['approved', 'rejected'].includes(value.decision)) {
    errors.push({ path: '$.decision', problem: '必须是 approved / rejected' });
  }
  for (const key of ['changed', 'notified']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      errors.push({ path: `$.${key}`, problem: '必须是布尔' });
    }
  }
  if (value.reason_codes !== undefined && !(Array.isArray(value.reason_codes) && value.reason_codes.every((code) => typeof code === 'string'))) {
    errors.push({ path: '$.reason_codes', problem: '必须是字符串数组' });
  }
  const extras = Object.keys(value).filter((key) => !POST_REVIEW_OUTCOME_FIELDS.includes(key));
  return { ok: errors.length === 0, outcome: errors.length === 0 ? value : null, errors, extras };
}

// ------------------------------------------------------------------ 分页集合（纯函数）

export function emptyModerationQueue() {
  return emptyCollection();
}

/** 应用一页（去重 + 成环判断都在 `appendPage` 里，本函数只做形状转接）。 */
export function appendModerationPage(collection, { cursor = null, page } = {}) {
  return appendPage(collection ?? emptyCollection(), { cursor, page });
}

/** 用服务端回执更新队列里的一行（`changed:false` 时不调用）。 */
export function patchModerationRow(collection, outcome) {
  const base = collection ?? emptyCollection();
  if (!isPlainObject(outcome) || typeof outcome.id !== 'string') return base;
  let touched = false;
  const items = base.items.map((item) => {
    if (item.id !== outcome.id) return item;
    touched = true;
    return { ...item, revision: outcome.revision, audit_state: outcome.audit_state, visibility: outcome.visibility };
  });
  return touched ? { ...base, items } : base;
}

/** 服务端回执 → 详情面板上的帖子（其余字段保留详情读面的值）。 */
export function patchModerationPost(post, outcome) {
  if (!isPlainObject(post) || !isPlainObject(outcome)) return post ?? null;
  if (post.id !== outcome.id) return post;
  return { ...post, revision: outcome.revision, audit_state: outcome.audit_state, visibility: outcome.visibility };
}

// ------------------------------------------------------------------ 读面：请求与失败分类

async function readJson(response) {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { ok: false, value: null };
  }
}

function failure(kind, extra = {}) {
  return {
    ok: false,
    kind,
    retriable: RETRIABLE_KINDS.includes(kind),
    serverRetryable: null,
    status: null,
    code: null,
    inContract: null,
    message: '',
    requestUrl: null,
    retryAfterSeconds: null,
    ...extra,
  };
}

/**
 * 读面失败的「重试」判据：**只认服务端声明**（`error.retryable === true`）且种类属于可重试闭集。
 * 403（缺 scope）与 401（会话）永不重试 —— 重试同一个无权会话不会变好。
 */
export function canRetryModerationFailure(result) {
  if (!isPlainObject(result) || result.ok !== false) return false;
  if (result.kind === 'forbidden' || result.kind === 'signed_out') return false;
  return result.retriable === true;
}

/** HTTP 响应 → 读面失败对象（分类口径按服务端**实际**返回，不按想象）。 */
export function classifyQueueReadFailure({ status, code = null, message = '', retryable = null, requestUrl = null, retryAfterSeconds = null } = {}) {
  const normalizedStatus = typeof status === 'number' && status > 0 ? status : 0;
  const base = {
    status: normalizedStatus,
    code,
    inContract: code === null ? false : ERROR_CODES.includes(code),
    message,
    requestUrl,
    retryAfterSeconds,
    serverRetryable: typeof retryable === 'boolean' ? retryable : null,
  };
  const mark = (kind, extra = {}) => {
    const result = failure(kind, { ...base, ...extra });
    // 服务端给了 retryable 就照它；没给才用本地闭集（503/429/网络错误）。
    if (typeof retryable === 'boolean') result.retriable = retryable;
    return result;
  };

  if (normalizedStatus === 401 || code === 'SESSION_REQUIRED' || code === 'SESSION_EXPIRED') return mark('signed_out');
  if (normalizedStatus === 403 || code === 'SCOPE_DENIED' || code === 'CONSENT_REQUIRED') return mark('forbidden');
  if (normalizedStatus === 400 && code === 'INVALID_CURSOR') return mark('invalid_cursor');
  if (normalizedStatus === 404 || code === 'NOT_FOUND') return mark('not_found');
  if (normalizedStatus === 429 || code === 'RATE_LIMITED') return mark('rate_limited');
  if (normalizedStatus === 503 || normalizedStatus === 504 || normalizedStatus >= 500) return mark('unavailable');
  return mark('http_error');
}

/**
 * 读一页队列。
 *
 * 返回 `{ok: true, status, requestUrl, page: {items, nextCursor, warnings}}` 或失败对象
 * （`classifyQueueReadFailure` 的形状）。失败**不返回空页**：调用方据此区分「空队列」与「读不到」。
 */
export async function fetchModerationQueuePage({
  fetchImpl,
  baseUrl,
  token,
  cursor = null,
  limit = LIMIT_DEFAULT,
  filters = null,
  signal,
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (typeof token !== 'string' || token.length === 0) {
    return failure('signed_out', { message: '没有后台会话令牌' });
  }

  let requestUrl;
  try {
    requestUrl = buildModerationQueueUrl(baseUrl, { cursor, limit, filters });
  } catch (error) {
    const kind = error instanceof RangeError ? 'invalid_cursor' : 'invalid_request';
    return failure(kind, { message: error instanceof Error ? error.message : '请求参数不合法' });
  }

  let response;
  try {
    response = await doFetch(requestUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      credentials: 'omit',
      signal,
    });
  } catch (error) {
    return failure('network_error', {
      message: error instanceof Error ? error.message : '网络请求失败',
      requestUrl,
    });
  }

  const status = typeof response.status === 'number' ? response.status : 0;
  const parsed = await readJson(response);

  if (response.ok === true && status >= 200 && status < 300) {
    if (!parsed.ok) return failure('invalid_response', { status, message: '响应不是合法 JSON', requestUrl });
    const data = readPageEnvelope(parsed.value);
    if (data === null) {
      return failure('invalid_response', { status, message: '响应信封缺少 data 或 meta', requestUrl });
    }
    const page = validateAdminPostPage(data);
    if (!page.ok) {
      return failure('invalid_response', {
        status,
        requestUrl,
        message: `响应形状不符合 AdminPostPage：${page.errors.map((error) => `${error.path} ${error.problem}`).join('；')}`,
      });
    }
    return { ok: true, status, requestUrl, page: { items: page.items, nextCursor: page.nextCursor, warnings: page.warnings } };
  }

  const envelope = parsed.ok ? readErrorEnvelope(parsed.value) : null;
  const retryAfter = Number(response.headers?.get?.('retry-after'));
  return classifyQueueReadFailure({
    status,
    code: envelope?.code ?? null,
    message: envelope?.message ?? '',
    retryable: envelope?.retryable ?? null,
    requestUrl,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  });
}

/** 读一条帖子详情（`getAdminPost`）；404 是 `not_found`，不是 `forbidden`（契约 :11116）。 */
export async function fetchAdminPostDetail({ fetchImpl, baseUrl, token, postId, signal } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return failure('network_error', { message: '当前环境没有可用的 fetch' });
  if (typeof token !== 'string' || token.length === 0) return failure('signed_out', { message: '没有后台会话令牌' });

  let requestUrl;
  try {
    requestUrl = buildAdminPostDetailUrl(baseUrl, postId);
  } catch (error) {
    return failure('invalid_request', { message: error instanceof Error ? error.message : '帖子 ID 不合法' });
  }

  let response;
  try {
    response = await doFetch(requestUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      credentials: 'omit',
      signal,
    });
  } catch (error) {
    return failure('network_error', {
      message: error instanceof Error ? error.message : '网络请求失败',
      requestUrl,
    });
  }

  const status = typeof response.status === 'number' ? response.status : 0;
  const parsed = await readJson(response);

  if (response.ok === true && status >= 200 && status < 300) {
    if (!parsed.ok) return failure('invalid_response', { status, message: '响应不是合法 JSON', requestUrl });
    const data = readPageEnvelope(parsed.value);
    if (data === null) {
      return failure('invalid_response', { status, message: '响应信封缺少 data 或 meta', requestUrl });
    }
    const checked = validateAdminPost(data);
    if (!checked.ok) {
      return failure('invalid_response', {
        status,
        requestUrl,
        message: `响应形状不符合 AdminPost：${checked.errors.map((error) => `${error.path} ${error.problem}`).join('；')}`,
      });
    }
    const etag = response.headers?.get?.('etag');
    return {
      ok: true,
      status,
      requestUrl,
      post: checked.post,
      etag: typeof etag === 'string' && /^"[1-9][0-9]*"$/.test(etag) ? etag : null,
    };
  }

  const envelope = parsed.ok ? readErrorEnvelope(parsed.value) : null;
  return classifyQueueReadFailure({
    status,
    code: envelope?.code ?? null,
    message: envelope?.message ?? '',
    retryable: envelope?.retryable ?? null,
    requestUrl,
  });
}

// ------------------------------------------------------------------ 动作：approve / reject

/**
 * 构造一次审帖动作请求（**不发请求**）。
 *
 * - `approve`：契约里该 op **没有 requestBody** ⇒ `body` 为 `null`，也不发 `content-type`；
 * - `reject`：body `{reason_code}`，`reason_code` 必须在闭集内（否则不发必然 422 的请求）；
 * - 两个动作都必带 `Idempotency-Key`（8..128）与 `If-Match`（`"<revision>"`，**不允许 `*`**）。
 *
 * 返回 `{ok: true, request}` 或 `{ok: false, problems: [{field, message}]}`（逐字段报错）。
 */
export function buildPostReviewRequest({
  baseUrl,
  token,
  postId,
  revision,
  decision,
  reasonCode = null,
  idempotencyKey,
} = {}) {
  const problems = [];
  const normalizedId = normalizePostId(postId);
  if (normalizedId === null) problems.push({ field: 'post_id', message: '帖子 ID 必须是 uuid（契约 path 参数 format: uuid）' });
  if (!REVIEW_DECISIONS.includes(decision)) problems.push({ field: 'decision', message: `decision 只能是 ${REVIEW_DECISIONS.join(' / ')}` });

  const checkedRevision = validateRevision(revision);
  if (!checkedRevision.ok) problems.push({ field: 'revision', message: checkedRevision.problem });

  const isReject = decision === 'reject';
  if (isReject) {
    if (!POST_REVIEW_REASON_CODES.includes(reasonCode)) {
      problems.push({ field: 'reason_code', message: `reject 的 reason_code 必须在契约闭集内：${POST_REVIEW_REASON_CODES.join(' / ')}` });
    }
  } else if (reasonCode !== null && reasonCode !== undefined && reasonCode !== '') {
    // approve 没有请求体：带理由不是「多余字段」而是契约外的请求形状。
    problems.push({ field: 'reason_code', message: 'approve 不接受请求体（契约该 op 无 requestBody），不携带 reason_code' });
  }

  const key = normalizeIdempotencyKey(idempotencyKey);
  if (key === null) problems.push({ field: 'idempotency_key', message: 'Idempotency-Key 必须是 8..128 字符' });
  if (typeof token !== 'string' || token === '') problems.push({ field: 'token', message: '没有后台会话令牌' });
  if (problems.length > 0) return { ok: false, problems };

  const ifMatch = buildIfMatch(checkedRevision.revision);
  const base = normalizeBaseUrl(baseUrl);
  const url = `${base}${MODERATION_QUEUE_PATH}/${normalizedId}/${decision}`;
  const body = isReject ? { reason_code: reasonCode } : null;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'idempotency-key': key,
    'if-match': ifMatch,
  };
  if (body !== null) headers['content-type'] = 'application/json';

  return {
    ok: true,
    request: {
      url,
      method: 'POST',
      postId: normalizedId,
      decision,
      ifMatch,
      headers,
      body,
      sentHeaders: { 'idempotency-key': key, 'if-match': ifMatch },
    },
  };
}

/** 动作失败的本地兜底形状（与 `classifyHideFailure` 的输出同形，便于页面统一渲染）。 */
function reviewFailure(kind, extra = {}) {
  return {
    ok: false,
    kind,
    retriable: false,
    status: 0,
    code: null,
    inContract: null,
    message: '',
    requestUrl: null,
    requestId: null,
    sentHeaders: null,
    executionMode: null,
    maybeEffective: false,
    details: [],
    ...extra,
  };
}

/**
 * 动作失败分类：复用 `classifyHideFailure`（同一个 POST + If-Match 语义），只补一个 422 分支。
 * 422 在契约里是 `CONDITIONS_INCOMPLETE`／`SOURCE_CONFLICT`／`INPUT_UNCERTAIN`；
 * 审帖面命中它的唯一实际原因是**硬规则否决**（`RULE_VETOED`→`INPUT_UNCERTAIN`，service.ts:1281-1283）。
 */
export function classifyReviewFailure(options = {}) {
  const base = classifyHideFailure(options);
  if (options.status === 422 || ['INPUT_UNCERTAIN', 'CONDITIONS_INCOMPLETE', 'SOURCE_CONFLICT'].includes(base.code)) {
    return { ...base, kind: 'rejected_by_rules', retriable: false };
  }
  return base;
}

/**
 * 执行一次审帖动作（approve / reject）。
 *
 * 返回 `{ok: true, status, outcome, etag, requestId, requestUrl, sentHeaders}` 或失败对象
 * （`classifyReviewFailure` 的形状）。**不做任何重试**：503／网络错误原样返回，由操作员决定是否用同一幂等键重放。
 * `changed:false` 仍然是 `ok:true`（HTTP 200、契约内），但是**不是**「刚刚改动成功」—— 交给
 * `describeReviewOutcome` 如实措辞。
 */
export async function submitPostReview({
  fetchImpl,
  baseUrl,
  token,
  postId,
  revision,
  decision,
  reasonCode = null,
  idempotencyKey,
  signal,
} = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return reviewFailure('network_error', { message: '当前环境没有可用的 fetch' });

  const built = buildPostReviewRequest({ baseUrl, token, postId, revision, decision, reasonCode, idempotencyKey });
  if (!built.ok) {
    return reviewFailure('invalid_request', {
      message: built.problems.map((problem) => problem.message).join('；'),
      problems: built.problems,
    });
  }
  const { request } = built;

  let response;
  try {
    response = await doFetch(request.url, {
      method: request.method,
      headers: request.headers,
      credentials: 'omit',
      ...(request.body === null ? {} : { body: JSON.stringify(request.body) }),
      signal,
    });
  } catch (error) {
    return reviewFailure('network_error', {
      message: `网络请求失败（结果未知，勿盲目重发）：${error instanceof Error ? error.message : String(error)}`,
      requestUrl: request.url,
      sentHeaders: request.sentHeaders,
      maybeEffective: true,
    });
  }

  const status = typeof response.status === 'number' ? response.status : 0;
  const parsed = await readJson(response);

  if (response.ok === true && status >= 200 && status < 300) {
    if (!parsed.ok) {
      return reviewFailure('invalid_response', {
        status,
        message: '响应不是合法 JSON',
        requestUrl: request.url,
        sentHeaders: request.sentHeaders,
      });
    }
    const data = readPageEnvelope(parsed.value);
    if (data === null) {
      return reviewFailure('invalid_response', {
        status,
        message: '响应信封缺少 data 或 meta',
        requestUrl: request.url,
        sentHeaders: request.sentHeaders,
      });
    }
    const checked = validatePostReviewOutcome(data);
    if (!checked.ok) {
      return reviewFailure('invalid_response', {
        status,
        message: `响应形状不符合 PostReviewOutcome：${checked.errors.map((error) => `${error.path} ${error.problem}`).join('；')}`,
        requestUrl: request.url,
        sentHeaders: request.sentHeaders,
      });
    }
    const etag = response.headers?.get?.('etag');
    return {
      ok: true,
      status,
      requestUrl: request.url,
      sentHeaders: request.sentHeaders,
      outcome: checked.outcome,
      etag: typeof etag === 'string' && /^"[1-9][0-9]*"$/.test(etag) ? etag : null,
    };
  }

  const envelope = parsed.ok ? readHideErrorEnvelope(parsed.value) : null;
  return classifyReviewFailure({
    status,
    code: envelope?.code ?? null,
    message: envelope?.message ?? '',
    retryable: envelope?.retryable ?? null,
    executionMode: envelope?.executionMode ?? null,
    details: envelope?.details ?? [],
    requestUrl: request.url,
    requestId: envelope?.requestId ?? null,
    sentHeaders: request.sentHeaders,
  });
}

// ------------------------------------------------------------------ 状态机

export function initialModerationQueueState() {
  return {
    signedIn: false,
    scopes: [],
    scopeWarning: false,
    collection: emptyModerationQueue(),
    loading: false,
    loadingCursor: null,
    failure: null,
    filterFailure: null,
    appliedFilters: emptyModerationFilters(),
    draftFilters: emptyModerationFilters(),
    limit: LIMIT_DEFAULT,
    selectedId: null,
    detail: null,
    detailEtag: null,
    detailLoading: false,
    detailFailure: null,
    actionBusy: false,
    actionDecision: null,
    actionNotice: null,
    actionFailure: null,
    lastOutcome: null,
  };
}

function patchDetail(state, outcome) {
  if (state.detail === null || state.detail.id !== outcome.id) return state;
  const patched = patchModerationPost(state.detail, outcome);
  const etag = typeof outcome.revision === 'number' ? `"${outcome.revision}"` : state.detailEtag;
  return { ...state, detail: patched, detailEtag: etag };
}

/**
 * 队列状态机（纯函数）。动作名与 `AuditLogsView` 同一套拼写习惯，
 * 便于两个页面互相对照；`LOAD_OK` 的 `reset` 决定是覆盖还是续页。
 */
export function reduceModerationQueue(state, action) {
  const current = state ?? initialModerationQueueState();
  switch (action?.type) {
    case 'SIGNED_IN': {
      const scopes = Array.isArray(action.scopes) ? action.scopes : [];
      return {
        ...current,
        signedIn: true,
        scopes,
        scopeWarning: !scopes.includes(MODERATION_READ_SCOPE),
      };
    }
    case 'SIGN_OUT':
    case 'SESSION_MISSING':
      return initialModerationQueueState();
    case 'LOAD_START':
      return { ...current, loading: true, loadingCursor: action.reset === true ? null : action.cursor ?? null, failure: null, filterFailure: null };
    case 'LOAD_OK': {
      const appended = appendModerationPage(action.reset === true ? emptyModerationQueue() : current.collection, {
        cursor: action.cursor ?? null,
        page: action.page,
      });
      return { ...current, loading: false, loadingCursor: null, failure: null, collection: appended.collection };
    }
    case 'LOAD_FAIL':
      return { ...current, loading: false, loadingCursor: null, failure: action.failure ?? null };
    case 'SET_DRAFT_FILTERS':
      return { ...current, draftFilters: normalizeModerationFilters(action.filters) };
    case 'FILTERS_APPLIED':
      return {
        ...current,
        appliedFilters: normalizeModerationFilters(action.filters),
        draftFilters: normalizeModerationFilters(action.filters),
        filterFailure: null,
      };
    case 'FILTER_FAILED':
      return { ...current, filterFailure: { message: action.message ?? '筛选条件不合法' } };
    case 'SET_LIMIT':
      return { ...current, limit: clampLimit(action.limit) };
    case 'RESET_FILTERS':
      return { ...current, appliedFilters: emptyModerationFilters(), draftFilters: emptyModerationFilters(), filterFailure: null };
    case 'SELECT_ROW':
      return {
        ...current,
        selectedId: action.postId ?? null,
        detail: null,
        detailEtag: null,
        detailFailure: null,
        detailLoading: false,
        actionNotice: null,
        actionFailure: null,
        actionDecision: null,
        lastOutcome: null,
      };
    case 'DETAIL_START':
      return { ...current, detailLoading: true, detailFailure: null };
    case 'DETAIL_OK':
      return {
        ...current,
        detailLoading: false,
        detailFailure: null,
        detail: action.post ?? null,
        detailEtag: action.etag ?? null,
        selectedId: action.post?.id ?? current.selectedId,
      };
    case 'DETAIL_FAIL':
      return { ...current, detailLoading: false, detailFailure: action.failure ?? null };
    case 'REVIEW_START':
      return {
        ...current,
        actionBusy: true,
        actionDecision: action.decision ?? null,
        actionNotice: null,
        actionFailure: null,
        lastOutcome: null,
      };
    case 'REVIEW_OK': {
      const outcome = action.outcome;
      const next = {
        ...current,
        actionBusy: false,
        actionDecision: null,
        actionFailure: null,
        lastOutcome: outcome,
      };
      // `changed:false` ⇒ 服务端明说没改动：不假装修正了本地行。
      if (outcome.changed === true) {
        return patchDetail({ ...next, collection: patchModerationRow(current.collection, outcome) }, outcome);
      }
      return next;
    }
    case 'REVIEW_FAIL':
      return { ...current, actionBusy: false, actionDecision: null, actionFailure: action.failure ?? null };
    case 'DISMISS_ACTION':
      return { ...current, actionNotice: null, actionFailure: null, lastOutcome: null };
    default:
      return current;
  }
}

export function canLoadMoreModeration(state) {
  const current = state ?? initialModerationQueueState();
  return current.collection.nextCursor !== null && current.collection.cycle !== true && current.loading !== true;
}

export function needsModerationRestart(state) {
  const current = state ?? initialModerationQueueState();
  return current.failure !== null && (current.failure.kind === 'invalid_cursor' || current.failure.kind === 'http_error');
}

// ------------------------------------------------------------------ 展示模型

/** 时间：UTC 稳定渲染成 `YYYY-MM-DD HH:MM:SSZ`；解析不了原样返回（不猜时区）。 */
export function formatModerationTimestamp(raw) {
  if (typeof raw !== 'string' || raw === '') return '（无时间）';
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return raw;
  return `${new Date(parsed).toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

/** 一条 `AdminPost` → 列表行视图。 */
export function moderationRowView(item) {
  if (!isPlainObject(item)) return null;
  // 不可渲染的行（缺字段/枚举外）不进行视图：宁可少一行，也不把畸形数据当帖子显示。
  if (validateAdminPost(item).ok !== true) return null;
  return {
    id: item.id,
    revision: item.revision,
    title: item.title,
    auditState: item.audit_state,
    auditStateLabel: AUDIT_STATE_LABELS[item.audit_state] ?? item.audit_state,
    visibility: item.visibility,
    visibilityLabel: VISIBILITY_LABELS[item.visibility] ?? item.visibility,
    createdAt: item.created_at,
    createdAtLabel: formatModerationTimestamp(item.created_at),
    updatedAtLabel: formatModerationTimestamp(item.updated_at),
    authorLabel: item.author_id !== null ? item.author_id : item.anonymized_author_ref ?? '（作者已注销）',
    mediaCount: Array.isArray(item.media_ids) ? item.media_ids.length : 0,
    bodyLength: typeof item.body === 'string' ? charLength(item.body) : 0,
  };
}

export function moderationQueueRows(state) {
  const current = state ?? initialModerationQueueState();
  return current.collection.items.map(moderationRowView).filter((row) => row !== null);
}

/** 读面失败 → 文案（标题/说明/是否给「重试」/是否要回第一页）。不伪造成功、不伪造空页。 */
export function describeQueueFailure(result) {
  if (!isPlainObject(result) || result.ok !== false) return null;
  const statusPart = result.status === null || result.status === undefined || result.status === 0 ? '' : `HTTP ${result.status}`;
  const codePart = result.code === null || result.code === undefined ? '' : `错误码 ${result.code}${result.inContract === false ? '（契约外码）' : ''}`;
  const tail = [result.message ?? '', codePart, statusPart].filter((part) => part !== '').join(' · ');
  const canRetry = canRetryModerationFailure(result);

  switch (result.kind) {
    case 'signed_out':
      return {
        tone: 'error',
        role: 'alert',
        title: '未登录或会话已过期',
        detail: tail || '请重新登录后台',
        canRetry: false,
        restartNeeded: false,
      };
    case 'forbidden':
      return {
        tone: 'error',
        role: 'alert',
        title: '权限不足（本页需要 scope sources:read）',
        detail: `${tail || '当前后台会话缺少本接口要求的 scope'}｜后台会话有效，只是没有 sources:read；换一个有权限的后台账号，不要原地重试`,
        canRetry: false,
        restartNeeded: false,
      };
    case 'invalid_cursor':
      return {
        tone: 'error',
        role: 'alert',
        title: '游标无效（HTTP 400 INVALID_CURSOR）',
        detail: `${tail || '服务端拒绝该游标'}｜本页从第一页重新读取，不猜测游标内容`,
        canRetry: false,
        restartNeeded: true,
      };
    case 'not_found':
      return {
        tone: 'error',
        role: 'alert',
        title: '目标不存在（HTTP 404）',
        detail: tail || '该 id 在社区存储里查不到（契约用 404 而不是 403，避免泄露存在性）',
        canRetry: false,
        restartNeeded: false,
      };
    case 'rate_limited':
      return {
        tone: 'error',
        role: 'alert',
        title: '请求过于频繁（HTTP 429）',
        detail: result.retryAfterSeconds === null ? tail : `${tail}｜约 ${result.retryAfterSeconds} 秒后再试`,
        canRetry,
        restartNeeded: false,
      };
    case 'unavailable':
      return {
        tone: 'error',
        role: 'alert',
        title: `服务暂不可用${statusPart === '' ? '' : `（${statusPart}）`}`,
        detail: canRetry
          ? `${tail}｜服务端声明可重试：稍后重试`
          : `${tail}｜服务端声明不可自动重试（retryable:false）；本页不伪造空队列`,
        canRetry,
        restartNeeded: false,
      };
    case 'network_error':
      return {
        tone: 'error',
        role: 'alert',
        title: '网络请求失败',
        detail: `${tail || '检查 API 基地址与开发代理'}｜请求没有到达服务端`,
        canRetry: true,
        restartNeeded: false,
      };
    case 'invalid_response':
      return {
        tone: 'error',
        role: 'alert',
        title: '响应不符合契约',
        detail: `${tail || '未渲染任何行（不猜测缺字段）'}`,
        canRetry: false,
        restartNeeded: false,
      };
    case 'invalid_request':
      return {
        tone: 'error',
        role: 'alert',
        title: '请求参数不合法（本地拦截）',
        detail: tail || '没有发出请求',
        canRetry: false,
        restartNeeded: false,
      };
    default:
      return { tone: 'error', role: 'alert', title: '请求失败', detail: tail || '未知错误', canRetry, restartNeeded: false };
  }
}

/** 整体状态条：区分「空队列」「筛选后为空」「读失败」「加载中」「有数据」。 */
export function describeQueueView(state) {
  const current = state ?? initialModerationQueueState();
  const rows = moderationQueueRows(current);
  const failureView = describeQueueFailure(current.failure);
  if (failureView !== null) return { ...failureView, rows };

  if (current.loading === true && rows.length === 0) {
    return { tone: 'loading', role: 'status', title: '正在读取审核队列', detail: `GET ${MODERATION_QUEUE_PATH} · ${LIST_OPERATION_ID}`, canRetry: false, restartNeeded: false, rows };
  }
  if (rows.length === 0) {
    if (hasActiveModerationFilters(current.appliedFilters)) {
      return {
        tone: 'empty_filtered',
        role: 'status',
        title: '当前筛选下没有帖子',
        detail: `筛选：${describeModerationFilters(current.appliedFilters)}｜这不是「队列为空」，换筛选或清空筛选再看`,
        canRetry: false,
        restartNeeded: false,
        rows,
      };
    }
    return {
      tone: 'empty',
      role: 'status',
      title: '审核队列为空',
      detail: '空队列，不是错误：服务端这一次返回了 0 条（items: []），没有可审核的帖子',
      canRetry: false,
      restartNeeded: false,
      rows,
    };
  }
  const parts = [`已读取 ${rows.length} 条`];
  if (current.collection.pages > 1) parts.push(`${current.collection.pages} 页`);
  if (current.collection.duplicates > 0) parts.push(`去重 ${current.collection.duplicates} 条`);
  if (current.collection.cycle === true) parts.push('游标原地踏步（已停止续页）');
  parts.push(canLoadMoreModeration(current) ? '还有下一页' : '已到最后一页');
  return {
    tone: 'ready',
    role: 'status',
    title: `审核队列就绪（${parts.join(' · ')}）`,
    detail: `GET ${MODERATION_QUEUE_PATH} · ${LIST_OPERATION_ID} · scope ${MODERATION_READ_SCOPE}`,
    canRetry: false,
    restartNeeded: false,
    rows,
  };
}

/** 动作回执 → 文案。`changed:false` 如实说「已是该状态」，不当成功。 */
export function describeReviewOutcome(outcome, decision) {
  if (!isPlainObject(outcome)) return null;
  // 畸形回执（含把失败对象当回执传进来）不产生任何成功文案：先按契约 8 个必填校验。
  if (validatePostReviewOutcome(outcome).ok !== true) return null;
  const auditLabel = AUDIT_STATE_LABELS[outcome.audit_state] ?? outcome.audit_state;
  const visibilityLabel = VISIBILITY_LABELS[outcome.visibility] ?? outcome.visibility;
  const reasons = Array.isArray(outcome.reason_codes) && outcome.reason_codes.length > 0
    ? outcome.reason_codes.map((code) => POST_REVIEW_REASON_LABELS[code] ?? code).join('、')
    : '（无）';

  if (outcome.changed !== true) {
    return {
      tone: 'warn',
      role: 'status',
      title: '服务端未做改动（changed:false）',
      detail: `该帖当前已是 ${auditLabel}，服务端没有写入新结论、也没有重复记审计`,
      advice: '这是契约的幂等语义：重复提交同一结论不会二次生效。本页不把它显示成「刚刚成功」。',
      outcome,
    };
  }

  if (decision === 'reject' || outcome.decision === 'rejected') {
    return {
      tone: 'ready',
      role: 'status',
      title: `已写入审核结论：驳回（audit_state=${outcome.audit_state}）`,
      detail: `revision ${outcome.revision} · visibility=${visibilityLabel} · 理由 ${reasons}`,
      advice: outcome.notified === true
        ? '服务端 notified:true ⇒ 已通知作者；驳回同时把 visibility 置为 hidden。'
        : '服务端 notified:false ⇒ 本次没有通知作者（照实显示，不代替服务端承诺已送达）。',
      outcome,
    };
  }

  return {
    tone: 'ready',
    role: 'status',
    title: `已写入审核结论：通过（audit_state=${outcome.audit_state}）`,
    detail: `revision ${outcome.revision} · visibility=${visibilityLabel}（通过后：private ⇒ published，其余保持原可见性）`,
    advice: outcome.notified === true
      ? '服务端 notified:true ⇒ 已通知作者。'
      : '服务端 notified:false ⇒ 本次没有通知作者（匿名帖或通知通道未送达），照实显示，不代替服务端承诺已送达。',
    outcome,
  };
}

/** 动作失败 → 文案。403 写清缺哪个 scope；409 分「修订冲突」与「对象不可用」。 */
export function describeReviewFailure(result) {
  if (!isPlainObject(result) || result.ok !== false) return null;
  const statusPart = result.status === null || result.status === undefined || result.status === 0 ? '' : `HTTP ${result.status}`;
  const codePart = result.code === null || result.code === undefined ? '' : `错误码 ${result.code}${result.inContract === false ? '（契约外码）' : ''}`;
  const tail = [result.message ?? '', codePart, statusPart].filter((part) => part !== '').join(' · ');

  switch (result.kind) {
    case 'signed_out':
      return { tone: 'error', role: 'alert', title: '未登录或会话已过期', detail: tail || '请重新登录后台', advice: '本次动作未生效。' };
    case 'forbidden':
      return {
        tone: 'error',
        role: 'alert',
        title: `权限不足（动作需要 scope ${MODERATION_WRITE_SCOPE}）`,
        detail: `后台会话有效，但 approvePost／rejectPost 要求 ${MODERATION_WRITE_SCOPE}｜${tail}`,
        advice: 'scope 由服务端判定；页面只做提示，不放行。',
      };
    case 'revision_conflict':
      return {
        tone: 'error',
        role: 'alert',
        title: '修订冲突（HTTP 409 REVISION_CONFLICT）',
        detail: `${tail || 'If-Match 与当前 ETag 不匹配'}｜说明别人刚改过这条帖子`,
        advice: '重新读取详情拿到新 revision 再操作；本页不会自动用旧 revision 重发。',
      };
    case 'object_unavailable':
      return {
        tone: 'error',
        role: 'alert',
        title: '对象不可用（HTTP 409 OBJECT_UNAVAILABLE）',
        detail: `${tail || '帖子已删除或状态不允许该动作'}｜已删除内容不复活（服务端单向门）`,
        advice: '这不是可以靠重试解决的错误，先刷新列表确认该帖当前状态。',
      };
    case 'revision_required':
      return { tone: 'error', role: 'alert', title: '服务端要求 If-Match（HTTP 428）', detail: tail, advice: '本页总会带 If-Match；出现 428 说明请求头在链路上被剥掉了。' };
    case 'rejected_by_rules':
      return {
        tone: 'error',
        role: 'alert',
        title: '硬规则已否决该内容（HTTP 422）',
        detail: `${tail || 'INPUT_UNCERTAIN：硬规则明确否决该内容，不允许人工通过'}`,
        advice: '服务层原文「硬规则已明确否决…不允许人工通过」：这是红线，不是运营权衡；改人工结论也过不去。',
      };
    case 'idempotency_conflict':
      return { tone: 'error', role: 'alert', title: '幂等键冲突（HTTP 409 IDEMPOTENCY_CONFLICT）', detail: tail, advice: '同一 Idempotency-Key 对应了不同请求体：换新键重试，但先确认上一次是否已生效。' };
    case 'request_in_progress':
      return { tone: 'error', role: 'alert', title: '同一请求正在处理中（HTTP 409 REQUEST_IN_PROGRESS）', detail: tail, advice: '稍后用**同一个**幂等键重放，不要换键。' };
    case 'not_found':
      return { tone: 'error', role: 'alert', title: '帖子不存在（HTTP 404）', detail: tail, advice: '从列表里重新选一条；本页不猜它去哪了。' };
    case 'invalid_request':
      return { tone: 'error', role: 'alert', title: '请求不符合契约（本地或服务端拒绝）', detail: tail, advice: '常见原因：id 不是 uuid、revision 不是正整数、驳回理由不在闭集内、幂等键长度不对。' };
    case 'unavailable':
      return {
        tone: 'error',
        role: 'alert',
        title: `服务暂不可用${statusPart === '' ? '' : `（${statusPart}）`}`,
        detail: tail,
        advice: result.maybeEffective === true
          ? '处置**可能已生效**：先重新读取该帖详情核对 audit_state，再决定是否用同一幂等键重放。'
          : '稍后用同一幂等键重放；本页不把失败显示成成功。',
      };
    case 'network_error':
      return { tone: 'error', role: 'alert', title: '网络请求失败（结果未知）', detail: tail, advice: '先重新读取详情核对是否已生效，再用同一幂等键重放，避免重复记审计。' };
    case 'invalid_response':
      return { tone: 'error', role: 'alert', title: '服务端回执不符合契约', detail: tail, advice: '本页不把畸形回执当成功；请核对服务端版本。' };
    default:
      return { tone: 'error', role: 'alert', title: '动作失败', detail: tail || '未知错误', advice: '本页不把失败显示成成功。' };
  }
}
