/**
 * GY-I17（#17）阶段 1 · 消息域输入校验（契约 = 唯一权威）。
 *
 * 逐项对照 `packages/contracts/openapi.json`（契约 1.0.0）：
 *   - 参数 `Limit`：整数 1..50，默认 20 ⇒ 越界/非整数 400 `INVALID_REQUEST`；
 *   - 参数 `Cursor`：字符串 `maxLength:2048`（内容由服务层验签）⇒ 格式非法 400 `INVALID_REQUEST`；
 *   - 参数 `Idempotency-Key`（`markMessageRead` required，8..128）⇒ 缺失/越界 400 `IDEMPOTENCY_KEY_REQUIRED`；
 *   - 参数 `If-Match`（`markMessageRead` required，`^"[1-9][0-9]*"$`，不允许 `*`）
 *     ⇒ 缺失 428 `REVISION_REQUIRED`；格式非法 400 `INVALID_REQUEST`；
 *     与目标当前版本不符 409 `REVISION_CONFLICT`（由服务层比对）；
 *   - 路径参数 `id`：`format: uuid` ⇒ 非法 400 `INVALID_REQUEST`；
 *   - 内部创建口入参：`owner_id` uuid、`type` 闭集、`target_ref` 形状、`event_key` 1..200，
 *     **未知字段一律拒绝**（`additionalProperties:false` 纪律，不"顺手丢弃"多余字段）。
 *
 * 校验纪律（沿用仓库既有口径）：一律**先判 `typeof` 再判值**
 * （`undefined` 不会被 `includes` 悄悄放过）；错误 `details` 逐条结构化、≤30 条。
 *
 * 说明：本文件与 `services/api/src/community/validate.ts`（#15，只读参考）**同口径但是
 * 独立实现** —— 仓库既有分层是"特征域不互相 import，只依赖 `auth/` 基础设施"
 * （对照：`ocr/service.ts`、`speech/service.ts`、`tts/service.ts` 各自定义了自己的
 * `UUID_PATTERN`/`requireIdempotencyKey`）。这样 #17 的契约参数校验不会被 #15 的重构牵动。
 */
import { isPositiveInteger } from '../auth/tokens.ts';
import { ApiError } from '../errors.ts';
import {
  MESSAGE_TYPES,
  TARGET_REF_TYPES,
  type AppendMessageInput,
  type MessageType,
  type MessagesActor,
  type TargetRef,
  type TargetRefType,
} from './types.ts';

/** 通用 uuid（openapi `format: uuid`）。 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PAGE_LIMIT_MAX = 50;
export const PAGE_LIMIT_DEFAULT = 20;
export const CURSOR_MAX = 2048;
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 128;
export const TARGET_ID_MAX = 80;
export const EVENT_KEY_MAX = 200;

/** 契约 `FieldError`（field 1..80、code 1..80）：把拒绝原因逐条结构化回传。 */
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
 * - 缺 userId／authEpoch／role ⇒ 401 `SESSION_REQUIRED`；
 * - 后台会话（role !== 'user'）⇒ 403 `SCOPE_DENIED`（消息属用户会话域）。
 */
export function requireUserActor(actor: unknown): MessagesActor {
  if (!isPlainObject(actor)) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  const { userId, authEpoch, role } = actor;
  if (typeof userId !== 'string' || userId.length === 0) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  if (!isPositiveInteger(authEpoch)) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  if (role !== 'user' && role !== 'admin') throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  if (role !== 'user') throw new ApiError('SCOPE_DENIED', '消息读取需要用户会话，后台会话不得代替');
  return { userId, authEpoch, role };
}

/** 路径参数 `id`（`format: uuid`）⇒ 非法 400 `INVALID_REQUEST`。 */
export function requireUuidParam(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalid(`${field} 必须是 uuid`, [{ field, code: 'INVALID_UUID' }]);
  }
  return value;
}

/** `Idempotency-Key` 头（required，8..128）⇒ 缺失/越界 400 `IDEMPOTENCY_KEY_REQUIRED`。 */
export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < IDEMPOTENCY_KEY_MIN || value.length > IDEMPOTENCY_KEY_MAX) {
    throw new ApiError(
      'IDEMPOTENCY_KEY_REQUIRED',
      `需要 ${IDEMPOTENCY_KEY_MIN}..${IDEMPOTENCY_KEY_MAX} 字符的 Idempotency-Key`,
    );
  }
  return value;
}

/**
 * `If-Match` 头（required，`^"[1-9][0-9]*"$`，不允许 `*`）。
 * 只负责"存在且格式合法"并返回原始串（幂等摘要需要包含原始 If-Match）；
 * 与目标当前版本是否相符由服务层在 CAS 处比对（409 `REVISION_CONFLICT`）。
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

/** `limit` 查询参数：整数 1..50，默认 20；越界/非整数 ⇒ 400 `INVALID_REQUEST`。 */
export function parseLimit(value: unknown): number {
  if (value === undefined || value === null) return PAGE_LIMIT_DEFAULT;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > PAGE_LIMIT_MAX) {
    throw invalid(`limit 必须是 1..${PAGE_LIMIT_MAX} 的整数`, [{ field: 'limit', code: 'OUT_OF_RANGE' }]);
  }
  return value;
}

/** `cursor` 查询参数：可省略；给了必须是 1..2048 的字符串（内容由服务层验签）。 */
export function parseCursor(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > CURSOR_MAX) {
    throw invalid(`cursor 必须是 1..${CURSOR_MAX} 的字符串`, [{ field: 'cursor', code: 'INVALID_FORMAT' }]);
  }
  return value;
}

/**
 * `GET /messages` 的查询参数（只有契约声明的 `cursor`/`limit`）。
 * **多余字段一律 400 `INVALID_REQUEST`**（`additionalProperties:false` 纪律；
 * `GET /messages` 契约上没有筛选参数，静默丢弃会让客户端以为筛选生效）。
 */
export function parseListMessagesQuery(query: unknown): { cursor: string | null; limit: number } {
  if (query === undefined || query === null) return { cursor: null, limit: PAGE_LIMIT_DEFAULT };
  if (!isPlainObject(query)) {
    throw invalid('查询参数必须是对象', [{ field: '(query)', code: 'NOT_OBJECT' }]);
  }
  const details: ValidationDetail[] = [];
  for (const key of Object.keys(query)) {
    if (key !== 'cursor' && key !== 'limit') details.push({ field: key, code: 'UNKNOWN_FIELD' });
  }
  if (details.length > 0) throw invalid('查询参数包含契约未声明的字段', details);
  const limit = parseLimit(query['limit']);
  const cursor = parseCursor(query['cursor']);
  return { cursor, limit };
}

/** 校验 `TargetRef`（三字段全必填、`additionalProperties:false`）。 */
export function readTargetRef(value: unknown, field: string, details: ValidationDetail[]): TargetRef | null {
  if (!isPlainObject(value)) {
    details.push({ field, code: 'INVALID_TYPE' });
    return null;
  }
  const local: ValidationDetail[] = [];
  for (const key of Object.keys(value)) {
    if (key !== 'type' && key !== 'id' && key !== 'revision') local.push({ field: `${field}.${key}`, code: 'UNKNOWN_FIELD' });
  }
  const { type, id, revision } = value;
  if (typeof type !== 'string' || !(TARGET_REF_TYPES as readonly string[]).includes(type)) {
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
  return { type: type as TargetRefType, id: id as string, revision: revision as number };
}

/**
 * 校验内部创建口入参 `AppendMessageInput`。
 *
 * 合法键**恰为** `owner_id`/`type`/`target_ref`/`event_key`；`read_at`/`id`/`revision`/
 * `reference_state` 之类由服务端决定的字段一旦传入 ⇒ 400 `UNKNOWN_FIELD`（不允许调用方
 * 预置已读状态或版本，避免"创建即已读"绕过未读一致性）。
 */
export function validateAppendMessageInput(value: unknown): AppendMessageInput {
  if (!isPlainObject(value)) throw invalid('创建口入参必须是对象', [{ field: '(body)', code: 'NOT_OBJECT' }]);
  const details: ValidationDetail[] = [];
  for (const key of Object.keys(value)) {
    if (key !== 'owner_id' && key !== 'type' && key !== 'target_ref' && key !== 'event_key') {
      details.push({ field: key, code: 'UNKNOWN_FIELD' });
    }
  }
  const ownerProblem =
    typeof value['owner_id'] !== 'string' || !UUID_PATTERN.test(value['owner_id']) ? 'INVALID_UUID' : null;
  if (ownerProblem !== null) details.push({ field: 'owner_id', code: ownerProblem });

  const type = value['type'];
  if (typeof type !== 'string' || !(MESSAGE_TYPES as readonly string[]).includes(type)) {
    details.push({ field: 'type', code: 'INVALID_ENUM' });
  }

  const eventKeyProblem = lengthProblem(value['event_key'], 1, EVENT_KEY_MAX);
  if (eventKeyProblem !== null) details.push({ field: 'event_key', code: eventKeyProblem });

  let targetRef: TargetRef | null = null;
  const rawTarget = value['target_ref'];
  if (rawTarget === undefined) {
    details.push({ field: 'target_ref', code: 'REQUIRED' });
  } else if (rawTarget !== null) {
    targetRef = readTargetRef(rawTarget, 'target_ref', details);
  }

  if (details.length > 0) throw invalid('消息创建口入参不符合契约', details);
  return {
    owner_id: value['owner_id'] as string,
    type: type as MessageType,
    target_ref: targetRef,
    event_key: value['event_key'] as string,
  };
}
