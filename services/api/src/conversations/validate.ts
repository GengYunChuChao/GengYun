/**
 * GY-I12（#12）· 文字问答子域输入校验（契约 = 唯一权威）。
 *
 * 逐项对照 `packages/contracts/openapi.json`（契约 1.0.0）：
 *   - `ConversationInput`：`additionalProperties:false`，`required: []`
 *     （即 `{}` 合法）；给了 `conditions` 就必须过 `Conditions` 校验
 *     （`crop_id` / `region_code` 必填，`region_code` pattern `^33[0-9]{4}$`，
 *     六个成员一律 1..80，**未知成员拒绝**）。
 *   - `TurnInput`：`oneOf[TextTurnInput, SpeechTurnInput]`，判别子 `input_type`。
 *     `text` 1..8000；`speech` 需 `transcription_id`（uuid）+ `transcription_revision`（≥1）
 *     + `confirmed: true`（`const true`）。判别子缺失/取值不在闭集内一律 400。
 *   - 参数 `Limit`：整数 1..50，默认 20；`Cursor`：1..2048 字符串（内容由服务层验签）。
 *   - `deleteConversation` / `createTurn` / `deleteTurn`：`Idempotency-Key` required（8..128）
 *     ⇒ 400 `IDEMPOTENCY_KEY_REQUIRED`；`If-Match` required（`^"[1-9][0-9]*"$`，不允许 `*`）
 *     ⇒ 缺失 428 `REVISION_REQUIRED`；不匹配 409 `REVISION_CONFLICT`（服务层 CAS 比对）。
 *   - `createConversation`：`Idempotency-Key` required（`createTurn` 之外唯一的一个）。
 *
 * 校验纪律：一律**先判 `typeof` 再判值**；错误 `details` 逐条结构化、≤30 条。
 * 与 `services/api/src/history/validate.ts`（#16，只读参考）同口径但**独立实现**。
 */
import { isPositiveInteger } from '../auth/tokens.ts';
import { ApiError } from '../errors.ts';
import type { Conditions, ConversationActor, TurnInput } from './types.ts';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 契约 `Conditions.region_code` pattern（浙江 33 开头六位）。 */
export const REGION_CODE_PATTERN = /^33[0-9]{4}$/;
export const PAGE_LIMIT_MAX = 50;
export const PAGE_LIMIT_DEFAULT = 20;
export const CURSOR_MAX = 2048;
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 128;
export const CONDITION_FIELD_MAX = 80;
export const TEXT_MAX = 8000;

/**
 * `Conditions` 的**合法键闭集**（契约 `additionalProperties:false`）。
 * `required` 是契约里的 `['crop_id','region_code']`，其余四项可选。
 */
const CONDITION_KEYS = [
  'crop_id',
  'region_code',
  'species_id',
  'growth_stage',
  'planting_method',
  'use_scene',
] as const;
const CONDITION_REQUIRED = ['crop_id', 'region_code'] as const;

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

/** 主体校验（契约 `security: userSession`）。后台会话在 HTTP 面是 401 `SESSION_EXPIRED`；`SCOPE_DENIED` 只作服务层兜底。 */
export function requireUserActor(actor: unknown): ConversationActor {
  if (!isPlainObject(actor)) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  const { userId, authEpoch, role } = actor;
  if (typeof userId !== 'string' || userId.length === 0) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  if (!isPositiveInteger(authEpoch)) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  if (role !== 'user' && role !== 'admin') throw new ApiError('SESSION_REQUIRED', '需要用户会话');
  if (role !== 'user') throw new ApiError('SCOPE_DENIED', '问答读写需要用户会话，后台会话不得代替');
  return { userId, authEpoch, role };
}

/** 路径参数（`format: uuid`）⇒ 非法 400 `INVALID_REQUEST`。 */
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

/** `cursor` 查询参数：可省略；给了必须是 1..2048 的字符串（内容由服务层验签）。 */
export function parseCursor(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > CURSOR_MAX) {
    throw invalid(`cursor 必须是 1..${CURSOR_MAX} 的字符串`, [{ field: 'cursor', code: 'INVALID_FORMAT' }]);
  }
  return value;
}

/**
 * 两个列表 operation 的查询参数（契约上只有 `cursor`/`limit`）。
 * **多余字段一律 400**：契约没有筛选参数，静默丢弃会让客户端以为筛选生效。
 */
export function parseListQuery(query: unknown): { cursor: string | null; limit: number } {
  if (query === undefined || query === null) return { cursor: null, limit: PAGE_LIMIT_DEFAULT };
  if (!isPlainObject(query)) throw invalid('查询参数必须是对象', [{ field: '(query)', code: 'NOT_OBJECT' }]);
  const details: ValidationDetail[] = [];
  for (const key of Object.keys(query)) {
    if (key !== 'cursor' && key !== 'limit') details.push({ field: key, code: 'UNKNOWN_FIELD' });
  }
  if (details.length > 0) throw invalid('查询参数包含契约未声明的字段', details);
  return { cursor: parseCursor(query['cursor']), limit: parseLimit(query['limit']) };
}

/** 校验契约 `Conditions`（六项键闭集；`crop_id`/`region_code` 必填；`region_code` 有 pattern）。 */
export function readConditions(value: unknown, field: string, details: ValidationDetail[]): Conditions | null {
  if (!isPlainObject(value)) {
    details.push({ field, code: 'INVALID_TYPE' });
    return null;
  }
  const local: ValidationDetail[] = [];
  for (const key of Object.keys(value)) {
    if (!(CONDITION_KEYS as readonly string[]).includes(key)) {
      local.push({ field: `${field}.${key}`, code: 'UNKNOWN_FIELD' });
    }
  }
  for (const key of CONDITION_REQUIRED) {
    if (!(key in value)) local.push({ field: `${field}.${key}`, code: 'REQUIRED' });
  }
  const parsed: Record<string, string> = {};
  for (const key of CONDITION_KEYS) {
    if (!(key in value)) continue;
    const problem = lengthProblem(value[key], 1, CONDITION_FIELD_MAX);
    if (problem !== null) local.push({ field: `${field}.${key}`, code: problem });
    else parsed[key] = value[key] as string;
  }
  if (typeof parsed['region_code'] === 'string' && !REGION_CODE_PATTERN.test(parsed['region_code'])) {
    local.push({ field: `${field}.region_code`, code: 'INVALID_FORMAT' });
  }
  if (local.length > 0) {
    details.push(...local);
    return null;
  }
  return parsed as unknown as Conditions;
}

/**
 * 校验契约 `ConversationInput`（`createConversation` 的请求体）。
 *
 * 合法键**恰为** `['conditions']`（可缺省）；`conditions` 给了就必须过 `Conditions`。
 * 未知键一律拒绝 —— 契约 `additionalProperties:false`，多给键即"契约外字段"。
 */
export function validateConversationInput(value: unknown): { conditions: Conditions | null } {
  if (value === undefined || value === null) return { conditions: null };
  if (!isPlainObject(value)) throw invalid('请求体必须是对象', [{ field: '(body)', code: 'NOT_OBJECT' }]);
  const details: ValidationDetail[] = [];
  for (const key of Object.keys(value)) {
    if (key !== 'conditions') details.push({ field: key, code: 'UNKNOWN_FIELD' });
  }
  let conditions: Conditions | null = null;
  if ('conditions' in value && value['conditions'] !== null) {
    conditions = readConditions(value['conditions'], 'conditions', details);
  }
  if (details.length > 0) throw invalid('请求体不符合契约 ConversationInput', details);
  return { conditions };
}

/**
 * 校验契约 `TurnInput`（`oneOf[TextTurnInput, SpeechTurnInput]`，判别子 `input_type`）。
 *
 * `speech` 分支**只做形状与一致性校验**：`confirmed` 必须是字面量 `true`
 * （契约 `const true`），`transcription_id` 必须是 uuid，`transcription_revision` ≥1。
 * 转写是否存在、版本是否一致、是否属于本人由服务层按 `transcription_ref` 核对
 * （本片转写读取口属既有语音域：核不到 ⇒ 422 `INPUT_UNCERTAIN`，绝不臆造）。
 */
export function validateTurnInput(value: unknown): TurnInput {
  if (!isPlainObject(value)) throw invalid('请求体必须是对象', [{ field: '(body)', code: 'NOT_OBJECT' }]);
  const inputType = value['input_type'];
  if (inputType !== 'text' && inputType !== 'speech') {
    throw invalid('input_type 必须是契约闭集 [text|speech] 的成员', [{ field: 'input_type', code: 'INVALID_ENUM' }]);
  }
  const details: ValidationDetail[] = [];
  const allowed = inputType === 'text' ? ['input_type', 'text'] : ['input_type', 'transcription_id', 'transcription_revision', 'confirmed'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) details.push({ field: key, code: 'UNKNOWN_FIELD' });
  }
  if (inputType === 'text') {
    const problem = lengthProblem(value['text'], 1, TEXT_MAX);
    if (problem !== null) details.push({ field: 'text', code: problem });
    if (details.length > 0) throw invalid('请求体不符合契约 TextTurnInput', details);
    return { input_type: 'text', text: value['text'] as string };
  }
  const uuidProblem = typeof value['transcription_id'] !== 'string' || !UUID_PATTERN.test(value['transcription_id'])
    ? 'INVALID_UUID'
    : null;
  if (uuidProblem !== null) details.push({ field: 'transcription_id', code: uuidProblem });
  const revision = value['transcription_revision'];
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    details.push({ field: 'transcription_revision', code: 'INVALID_INTEGER' });
  }
  if (value['confirmed'] !== true) details.push({ field: 'confirmed', code: 'MUST_BE_TRUE' });
  if (details.length > 0) throw invalid('请求体不符合契约 SpeechTurnInput', details);
  return {
    input_type: 'speech',
    transcription_id: value['transcription_id'] as string,
    transcription_revision: revision as number,
    confirmed: true,
  };
}
