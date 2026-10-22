/**
 * GY-I15（#15）阶段 1 · 社区域输入校验（契约 = 唯一权威）。
 *
 * 逐项对照 `packages/contracts/openapi.json`（契约 1.0.0）：
 *   - `PostInput`：`additionalProperties:false`；required `title`/`body`/`media_ids`；
 *     `title` 1..120、`body` 1..8000、`crop_id` 1..80、`region_code` `^33[0-9]{4}$`、
 *     `media_ids` 每项 uuid、`maxItems:3`、`uniqueItems:true`、
 *     `linked_knowledge_ref` ∈ {KnowledgeTarget, null}（KnowledgeTarget.type ∈ {species,herbicide,scheme}）。
 *   - `CommentInput`：required `body` 1..4000。
 *   - `ReportInput`：required `target_ref`（`ReportTarget`：type ∈ {post,comment}，id 1..80，
 *     revision ≥1 整数）、`reason_code` ∈ {dangerous,privacy,advertising,misleading,other}，
 *     可选 `detail` 1..1000。
 *   - 参数：`Idempotency-Key` 8..128（required）；`If-Match` 匹配 `^"[1-9][0-9]*"$`（required，
 *     不允许 `*`；缺失 428）；`limit` 整数 1..50 默认 20；`cursor` ≤2048。
 *   - 举报**处置**入参（R31-S1，**内部操作、契约里没有对应 op**）：`action` ∈
 *     {triage,resolve,reject}、`expected_revision` ≥1 整数，未知字段拒绝。见文件末尾
 *     `validateReportDispositionInput`。
 *
 * 校验纪律：一律**先判 `typeof` 再判值**（`undefined` 不会被 `includes` 悄悄放过），
 * 未知字段一律拒绝（`additionalProperties:false`），不"顺手丢弃"多余字段。
 */
import { ApiError } from '../errors.ts';
import { isPositiveInteger } from '../auth/tokens.ts';
import { REPORT_ACTIONS, type ReportAction } from './report-state.ts';
import type {
  CommunityActor,
  CommentInput,
  KnowledgeTarget,
  PostInput,
  ReportInput,
  ReportReasonCode,
  ReportTarget,
} from './types.ts';

/** 通用 uuid（openapi `format: uuid`；与 consent-pg/staging-intake 同口径）。 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REGION_CODE_PATTERN = /^33[0-9]{4}$/;
export const POST_TITLE_MAX = 120;
export const POST_BODY_MAX = 8000;
export const COMMENT_BODY_MAX = 4000;
export const REPORT_DETAIL_MAX = 1000;
export const MEDIA_IDS_MAX = 3;
export const PAGE_LIMIT_MAX = 50;
export const PAGE_LIMIT_DEFAULT = 20;
export const CURSOR_MAX = 2048;
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 128;
const CROP_ID_MAX = 80;
const TARGET_ID_MAX = 80;
const REPORT_REASON_CODES: readonly ReportReasonCode[] = ['dangerous', 'privacy', 'advertising', 'misleading', 'other'];
const KNOWLEDGE_TARGET_TYPES = ['species', 'herbicide', 'scheme'] as const;

/** 契约 `FieldError`（field 1..80、code 1..80）：用于把拒绝原因逐条结构化回传。 */
export interface ValidationDetail {
  field: string;
  code: string;
}

function invalid(message: string, details: ValidationDetail[]): ApiError {
  return new ApiError('INVALID_REQUEST', message, { details: details.slice(0, 30) });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lengthProblem(
  value: unknown,
  min: number,
  max: number,
): 'NOT_STRING' | 'TOO_SHORT' | 'TOO_LONG' | null {
  if (typeof value !== 'string') return 'NOT_STRING';
  if (value.length < min) return 'TOO_SHORT';
  if (value.length > max) return 'TOO_LONG';
  return null;
}

/**
 * 主体校验（契约 security: `userSession`）。
 * - 缺 userId／authEpoch／role ⇒ 401 SESSION_REQUIRED（与 auth/middleware 同口径）；
 * - 后台会话（role !== 'user'）⇒ 403 SCOPE_DENIED（用户会话才可读写社区）。
 */
export function requireUserActor(actor: unknown): CommunityActor {
  if (!isPlainObject(actor)) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  const { userId, authEpoch, role } = actor;
  if (typeof userId !== 'string' || userId.length === 0) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  if (!isPositiveInteger(authEpoch)) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  if (role !== 'user' && role !== 'admin') throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  if (role !== 'user') throw new ApiError('SCOPE_DENIED', '社区读写需要用户会话，后台会话不得代替');
  return { userId, authEpoch, role };
}

/** `Idempotency-Key` 头（required，8..128）；缺失/越界一律 400 IDEMPOTENCY_KEY_REQUIRED。 */
export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < IDEMPOTENCY_KEY_MIN || value.length > IDEMPOTENCY_KEY_MAX) {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', `需要 ${IDEMPOTENCY_KEY_MIN}..${IDEMPOTENCY_KEY_MAX} 字符的 Idempotency-Key`);
  }
  return value;
}

/**
 * `If-Match` 头（required，`^"[1-9][0-9]*"$`，不允许 `*`）。
 * 契约参数描述：缺失 428；不匹配目标当前版本 409（由调用方比对）。
 * 本函数只负责"存在且格式合法"，并返回原始串（幂等摘要需要包含原始 If-Match）。
 */
export function requireIfMatch(value: unknown): { raw: string; revision: number } {
  if (value === undefined || value === null || value === '') {
    throw new ApiError('REVISION_REQUIRED', '缺少 If-Match（目标当前强 ETag）');
  }
  if (typeof value !== 'string' || !/^"[1-9][0-9]*"$/.test(value)) {
    throw invalid('If-Match 必须是形如 "3" 的强 ETag，且不允许 *', [{ field: 'If-Match', code: 'INVALID_ETAG' }]);
  }
  return { raw: value, revision: Number(value.slice(1, -1)) };
}

/** `limit` 查询参数：整数 1..50，默认 20；越界/非整数 ⇒ 400 INVALID_REQUEST。 */
export function parseLimit(value: unknown): number {
  if (value === undefined || value === null) return PAGE_LIMIT_DEFAULT;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > PAGE_LIMIT_MAX) {
    throw invalid(`limit 必须是 1..${PAGE_LIMIT_MAX} 的整数`, [{ field: 'limit', code: 'OUT_OF_RANGE' }]);
  }
  return value;
}

/** `cursor` 查询参数：可省略；给了必须是 ≤2048 的字符串（内容由 service 验签）。 */
export function parseCursor(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > CURSOR_MAX) {
    throw invalid(`cursor 必须是 1..${CURSOR_MAX} 的字符串`, [{ field: 'cursor', code: 'INVALID_FORMAT' }]);
  }
  return value;
}

function requireKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  details: ValidationDetail[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) details.push({ field: key, code: 'UNKNOWN_FIELD' });
  }
}

function readMediaIds(value: unknown, details: ValidationDetail[]): string[] {
  if (!Array.isArray(value)) {
    details.push({ field: 'media_ids', code: 'NOT_ARRAY' });
    return [];
  }
  if (value.length > MEDIA_IDS_MAX) details.push({ field: 'media_ids', code: 'TOO_MANY_ITEMS' });
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !UUID_PATTERN.test(item)) {
      details.push({ field: 'media_ids[]', code: 'INVALID_UUID' });
      continue;
    }
    if (items.includes(item)) {
      details.push({ field: 'media_ids[]', code: 'DUPLICATE_ITEM' });
      continue;
    }
    items.push(item);
  }
  return items;
}

function readKnowledgeTarget(value: unknown, field: string, details: ValidationDetail[]): KnowledgeTarget | null {
  if (value === null) return null;
  const local: ValidationDetail[] = [];
  if (!isPlainObject(value)) {
    details.push({ field, code: 'INVALID_TYPE' });
    return null;
  }
  requireKnownKeys(value, ['type', 'id', 'revision'], local);
  const { type, id, revision } = value;
  if (typeof type !== 'string' || !(KNOWLEDGE_TARGET_TYPES as readonly string[]).includes(type)) {
    local.push({ field: `${field}.type`, code: 'INVALID_ENUM' });
  }
  if (lengthProblem(id, 1, TARGET_ID_MAX) !== null) {
    local.push({ field: `${field}.id`, code: 'INVALID_LENGTH' });
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    local.push({ field: `${field}.revision`, code: 'INVALID_INTEGER' });
  }
  if (local.length > 0) {
    details.push(...local);
    return null;
  }
  return { type: type as KnowledgeTarget['type'], id: id as string, revision: revision as number };
}

/** 校验 `PostInput`（创建与编辑共用同一形状）。 */
export function validatePostInput(value: unknown): PostInput {
  if (!isPlainObject(value)) throw invalid('请求体必须是对象', [{ field: '(body)', code: 'NOT_OBJECT' }]);
  const details: ValidationDetail[] = [];
  requireKnownKeys(value, ['title', 'body', 'media_ids', 'crop_id', 'region_code', 'linked_knowledge_ref'], details);

  const titleProblem = lengthProblem(value['title'], 1, POST_TITLE_MAX);
  if (titleProblem !== null) details.push({ field: 'title', code: titleProblem === 'NOT_STRING' ? 'NOT_STRING' : titleProblem });
  const bodyProblem = lengthProblem(value['body'], 1, POST_BODY_MAX);
  if (bodyProblem !== null) details.push({ field: 'body', code: bodyProblem === 'NOT_STRING' ? 'NOT_STRING' : bodyProblem });

  const rawMediaIds = value['media_ids'];
  if (rawMediaIds === undefined) details.push({ field: 'media_ids', code: 'REQUIRED' });
  const mediaIds = rawMediaIds === undefined ? [] : readMediaIds(rawMediaIds, details);

  const cropId = value['crop_id'];
  if (cropId !== undefined && lengthProblem(cropId, 1, CROP_ID_MAX) !== null) {
    details.push({ field: 'crop_id', code: 'INVALID_LENGTH' });
  }
  const regionCode = value['region_code'];
  if (regionCode !== undefined && (typeof regionCode !== 'string' || !REGION_CODE_PATTERN.test(regionCode))) {
    details.push({ field: 'region_code', code: 'PATTERN_MISMATCH' });
  }

  let linked: KnowledgeTarget | null = null;
  if (value['linked_knowledge_ref'] !== undefined) {
    linked = readKnowledgeTarget(value['linked_knowledge_ref'], 'linked_knowledge_ref', details);
  }

  if (details.length > 0) throw invalid('帖子请求体不符合契约', details);

  const input: PostInput = {
    title: value['title'] as string,
    body: value['body'] as string,
    media_ids: mediaIds,
  };
  if (cropId !== undefined) input.crop_id = cropId as string;
  if (regionCode !== undefined) input.region_code = regionCode as string;
  if (value['linked_knowledge_ref'] !== undefined) input.linked_knowledge_ref = linked;
  return input;
}

/** 校验 `CommentInput`。 */
export function validateCommentInput(value: unknown): CommentInput {
  if (!isPlainObject(value)) throw invalid('请求体必须是对象', [{ field: '(body)', code: 'NOT_OBJECT' }]);
  const details: ValidationDetail[] = [];
  requireKnownKeys(value, ['body'], details);
  const bodyProblem = lengthProblem(value['body'], 1, COMMENT_BODY_MAX);
  if (bodyProblem !== null) details.push({ field: 'body', code: bodyProblem === 'NOT_STRING' ? 'NOT_STRING' : bodyProblem });
  if (details.length > 0) throw invalid('评论请求体不符合契约', details);
  return { body: value['body'] as string };
}

/** 校验 `ReportInput`。 */
export function validateReportInput(value: unknown): ReportInput {
  if (!isPlainObject(value)) throw invalid('请求体必须是对象', [{ field: '(body)', code: 'NOT_OBJECT' }]);
  const details: ValidationDetail[] = [];
  requireKnownKeys(value, ['target_ref', 'reason_code', 'detail'], details);

  let target: ReportTarget | null = null;
  const rawTarget = value['target_ref'];
  if (rawTarget === undefined) {
    details.push({ field: 'target_ref', code: 'REQUIRED' });
  } else if (!isPlainObject(rawTarget)) {
    details.push({ field: 'target_ref', code: 'NOT_OBJECT' });
  } else {
    const local: ValidationDetail[] = [];
    requireKnownKeys(rawTarget, ['type', 'id', 'revision'], local);
    const { type, id, revision } = rawTarget;
    if (type !== 'post' && type !== 'comment') local.push({ field: 'target_ref.type', code: 'INVALID_ENUM' });
    if (lengthProblem(id, 1, TARGET_ID_MAX) !== null) local.push({ field: 'target_ref.id', code: 'INVALID_LENGTH' });
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
      local.push({ field: 'target_ref.revision', code: 'INVALID_INTEGER' });
    }
    if (local.length > 0) details.push(...local);
    else target = { type: type as 'post' | 'comment', id: id as string, revision: revision as number };
  }

  const reasonCode = value['reason_code'];
  if (typeof reasonCode !== 'string' || !REPORT_REASON_CODES.includes(reasonCode as ReportReasonCode)) {
    details.push({ field: 'reason_code', code: 'INVALID_ENUM' });
  }

  const detail = value['detail'];
  if (detail !== undefined && lengthProblem(detail, 1, REPORT_DETAIL_MAX) !== null) {
    details.push({ field: 'detail', code: 'INVALID_LENGTH' });
  }

  if (details.length > 0 || target === null) throw invalid('举报请求体不符合契约', details);
  const input: ReportInput = { target_ref: target, reason_code: reasonCode as ReportReasonCode };
  if (detail !== undefined) input.detail = detail as string;
  return input;
}

/**
 * 举报**处置**入参（GY-I15 · R31-S1）。
 *
 * ⚠️ 这不是契约 schema：`packages/contracts/openapi.json` 里没有任何举报处置 op，
 * 所以这里**照抄不了** `additionalProperties:false` 的既有先例，只能沿用同一纪律
 * （未知字段一律拒绝、先判 `typeof` 再判值），字段名用下划线以与本服务其他内部结构一致。
 *
 * `expected_revision` 是 `If-Match` 的服务端等价物：调用方必须声明"我看到的举报是第几版"，
 * 与当前版本不符就整单拒绝（CAS），从而让"重复处置"变成可判定的失败而不是静默覆盖。
 */
export interface ReportDispositionInput {
  action: ReportAction;
  expected_revision: number;
}

/** 校验处置入参。`action` 的闭集来自状态机（`report-state.ts`），不在这里复制一份。 */
export function validateReportDispositionInput(value: unknown): ReportDispositionInput {
  if (!isPlainObject(value)) throw invalid('处置入参必须是对象', [{ field: '(input)', code: 'NOT_OBJECT' }]);
  const details: ValidationDetail[] = [];
  requireKnownKeys(value, ['action', 'expected_revision'], details);

  const action = value['action'];
  if (typeof action !== 'string' || !(REPORT_ACTIONS as readonly string[]).includes(action)) {
    details.push({ field: 'action', code: 'INVALID_ENUM' });
  }

  const expectedRevision = value['expected_revision'];
  if (
    typeof expectedRevision !== 'number'
    || !Number.isSafeInteger(expectedRevision)
    || expectedRevision < 1
  ) {
    details.push({ field: 'expected_revision', code: 'INVALID_INTEGER' });
  }

  if (details.length > 0) throw invalid('处置入参不符合状态机口径', details);
  return { action: action as ReportAction, expected_revision: expectedRevision as number };
}
