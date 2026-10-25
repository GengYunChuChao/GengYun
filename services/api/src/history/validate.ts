/**
 * GY-I16（#16）· 历史子域输入校验（契约 = 唯一权威）。
 *
 * 逐项对照 `packages/contracts/openapi.json`（契约 1.0.0）：
 *   - 参数 `Limit`：整数 1..50，默认 20；`Cursor`：1..2048 字符串（内容由服务层验签）；
 *   - `deleteHistory`：`Idempotency-Key` required（8..128）⇒ 400 `IDEMPOTENCY_KEY_REQUIRED`；
 *     `If-Match` required（`^"[1-9][0-9]*"$`，不允许 `*`）⇒ 缺失 428 `REVISION_REQUIRED`；
 *     不匹配 409 `REVISION_CONFLICT`（服务层比对）；
 *   - 路径参数 `id`：`format: uuid` ⇒ 非法 400 `INVALID_REQUEST`；
 *   - **内部创建口** `AppendHistoryInput`：`owner_id` uuid、`kind` 2 项闭集、
 *     `target_ref` 为 `TargetRef` 三字段（`type` 17 项闭集、`id` 1..80、`revision` ≥1）、
 *     `job_id` 1..80、`job_state` **7 项闭集**、`event_key` 1..200；
 *     **未知字段一律拒绝**（不允许调用方预置 `id`/`revision`/`reference_state`/`created_at`，
 *     否则等于让调用方自证可见性或自定版本）。
 *
 * 校验纪律：一律**先判 `typeof` 再判值**；错误 `details` 逐条结构化、≤30 条。
 * 本文件与 `services/api/src/messages/validate.ts`（#17，只读参考）同口径但**独立实现**。
 */
import { isPositiveInteger } from '../auth/tokens.ts';
import { ApiError } from '../errors.ts';
import { isTargetRefType, type TargetRef } from '../targetref/types.ts';
import {
  isHistoryKind,
  isJobState,
  type AppendHistoryInput,
  type HistoryActor,
  type HistoryKind,
  type JobState,
} from './types.ts';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PAGE_LIMIT_MAX = 50;
export const PAGE_LIMIT_DEFAULT = 20;
export const CURSOR_MAX = 2048;
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 128;
export const TARGET_ID_MAX = 80;
export const JOB_ID_MAX = 80;
export const EVENT_KEY_MAX = 200;

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

function lengthProblem(value: unknown, min: number, max: number): 'NOT_STRING' | 'TOO_SHORT' | 'TOO_LONG' | null {
  if (typeof value !== 'string') return 'NOT_STRING';
  if (value.length < min) return 'TOO_SHORT';
  if (value.length > max) return 'TOO_LONG';
  return null;
}

/** 主体校验（契约 `security: userSession`）。后台会话 ⇒ 403 `SCOPE_DENIED`。 */
export function requireUserActor(actor: unknown): HistoryActor {
  if (!isPlainObject(actor)) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  const { userId, authEpoch, role } = actor;
  if (typeof userId !== 'string' || userId.length === 0) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  if (!isPositiveInteger(authEpoch)) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  if (role !== 'user' && role !== 'admin') throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  if (role !== 'user') throw new ApiError('SCOPE_DENIED', '历史读写需要用户会话，后台会话不得代替');
  return { userId, authEpoch, role };
}

/** 路径参数 `id`（`format: uuid`）⇒ 非法 400 `INVALID_REQUEST`。 */
export function requireUuidParam(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalid(`${field} 必须是 uuid`, [{ field, code: 'INVALID_UUID' }]);
  }
  return value;
}

/** `Idempotency-Key` 头（required，8..128）⇒ 缺失／越界 400 `IDEMPOTENCY_KEY_REQUIRED`。 */
export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < IDEMPOTENCY_KEY_MIN || value.length > IDEMPOTENCY_KEY_MAX) {
    throw new ApiError(
      'IDEMPOTENCY_KEY_REQUIRED',
      `需要 ${IDEMPOTENCY_KEY_MIN}..${IDEMPOTENCY_KEY_MAX} 字符的 Idempotency-Key`,
    );
  }
  return value;
}

/** `If-Match` 头（required，强 ETag，不允许 `*`）。版本比对在服务层 CAS 处完成。 */
export function requireIfMatch(value: unknown): { raw: string; revision: number } {
  if (value === undefined || value === null || value === '') {
    throw new ApiError('REVISION_REQUIRED', '缺少 If-Match（目标当前强 ETag）');
  }
  if (typeof value !== 'string' || !/^"[1-9][0-9]*"$/.test(value)) {
    throw invalid('If-Match 必须是形如 "3" 的强 ETag，且不允许 *', [{ field: 'If-Match', code: 'INVALID_ETAG' }]);
  }
  return { raw: value, revision: Number(value.slice(1, -1)) };
}

/** `limit` 查询参数：整数 1..50，默认 20。 */
export function parseLimit(value: unknown): number {
  if (value === undefined || value === null) return PAGE_LIMIT_DEFAULT;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > PAGE_LIMIT_MAX) {
    throw invalid(`limit 必须是 1..${PAGE_LIMIT_MAX} 的整数`, [{ field: 'limit', code: 'OUT_OF_RANGE' }]);
  }
  return value;
}

/** `cursor` 查询参数：可省略；给了必须是 1..2048 的字符串。 */
export function parseCursor(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > CURSOR_MAX) {
    throw invalid(`cursor 必须是 1..${CURSOR_MAX} 的字符串`, [{ field: 'cursor', code: 'INVALID_FORMAT' }]);
  }
  return value;
}

/**
 * `GET /history` 的查询参数（契约上只有 `cursor`/`limit`）。
 * **多余字段一律 400**：契约没有按任务类型筛选的参数，静默丢弃会让客户端以为筛选生效。
 */
export function parseListHistoryQuery(query: unknown): { cursor: string | null; limit: number } {
  if (query === undefined || query === null) return { cursor: null, limit: PAGE_LIMIT_DEFAULT };
  if (!isPlainObject(query)) throw invalid('查询参数必须是对象', [{ field: '(query)', code: 'NOT_OBJECT' }]);
  const details: ValidationDetail[] = [];
  for (const key of Object.keys(query)) {
    if (key !== 'cursor' && key !== 'limit') details.push({ field: key, code: 'UNKNOWN_FIELD' });
  }
  if (details.length > 0) throw invalid('查询参数包含契约未声明的字段', details);
  return { cursor: parseCursor(query['cursor']), limit: parseLimit(query['limit']) };
}

/** 校验 `TargetRef`（三字段全必填、`additionalProperties:false`、`type` 17 项闭集）。 */
export function readTargetRef(value: unknown, field: string, details: ValidationDetail[]): TargetRef | null {
  if (!isPlainObject(value)) {
    details.push({ field, code: 'INVALID_TYPE' });
    return null;
  }
  const local: ValidationDetail[] = [];
  for (const key of Object.keys(value)) {
    if (key !== 'type' && key !== 'id' && key !== 'revision') {
      local.push({ field: `${field}.${key}`, code: 'UNKNOWN_FIELD' });
    }
  }
  const { type, id, revision } = value;
  if (!isTargetRefType(type)) local.push({ field: `${field}.type`, code: 'INVALID_ENUM' });
  if (lengthProblem(id, 1, TARGET_ID_MAX) !== null) local.push({ field: `${field}.id`, code: 'INVALID_LENGTH' });
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    local.push({ field: `${field}.revision`, code: 'INVALID_INTEGER' });
  }
  if (local.length > 0) {
    details.push(...local);
    return null;
  }
  return { type: type as TargetRef['type'], id: id as string, revision: revision as number };
}

/**
 * 校验**内部创建口**入参 `AppendHistoryInput`（**不是**契约 operationId，不注册路由）。
 *
 * 合法键**恰为** `owner_id`/`kind`/`target_ref`/`job_id`/`job_state`/`event_key`；
 * `id`/`revision`/`reference_state`/`created_at` 之类由服务端决定的字段一旦传入 ⇒ 400
 * （不允许调用方预置可见性或版本）。
 */
export function validateAppendHistoryInput(value: unknown): AppendHistoryInput {
  if (!isPlainObject(value)) throw invalid('历史创建口入参必须是对象', [{ field: '(body)', code: 'NOT_OBJECT' }]);
  const details: ValidationDetail[] = [];
  const allowed = ['owner_id', 'kind', 'target_ref', 'job_id', 'job_state', 'event_key'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) details.push({ field: key, code: 'UNKNOWN_FIELD' });
  }

  const ownerProblem = typeof value['owner_id'] !== 'string' || !UUID_PATTERN.test(value['owner_id']) ? 'INVALID_UUID' : null;
  if (ownerProblem !== null) details.push({ field: 'owner_id', code: ownerProblem });

  const kind = value['kind'];
  if (!isHistoryKind(kind)) details.push({ field: 'kind', code: 'INVALID_ENUM' });

  const jobIdProblem = lengthProblem(value['job_id'], 1, JOB_ID_MAX);
  if (jobIdProblem !== null) details.push({ field: 'job_id', code: jobIdProblem });

  const jobState = value['job_state'];
  if (!isJobState(jobState)) details.push({ field: 'job_state', code: 'INVALID_ENUM' });

  const eventKeyProblem = lengthProblem(value['event_key'], 1, EVENT_KEY_MAX);
  if (eventKeyProblem !== null) details.push({ field: 'event_key', code: eventKeyProblem });

  const rawTarget = value['target_ref'];
  const target = rawTarget === undefined ? null : readTargetRef(rawTarget, 'target_ref', details);
  if (rawTarget === undefined) details.push({ field: 'target_ref', code: 'REQUIRED' });

  if (details.length > 0) throw invalid('历史创建口入参不符合契约', details);
  if (target === null) throw invalid('历史创建口入参不符合契约', [{ field: 'target_ref', code: 'INVALID_TYPE' }]);
  return {
    owner_id: value['owner_id'] as string,
    kind: kind as HistoryKind,
    target_ref: target,
    job_id: value['job_id'] as string,
    job_state: jobState as JobState,
    event_key: value['event_key'] as string,
  };
}
