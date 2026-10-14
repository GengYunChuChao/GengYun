/**
 * 后台共享守卫（GY-I18 阶段 1 抽出，阶段 1b 复用）。
 *
 * 抽出动机：阶段 1b 的 9 个 operationId 必须与阶段 1 **用同一套**身份/权限门、
 * `If-Match` 语义、分页参数判定与响应信封，而不是各写一份会漂移的副本。
 * 抽出是纯搬移：语义与阶段 1 逐条一致（阶段 1 的 70 条用例在本文件抽出后仍全绿）。
 */
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION } from '../contract.ts';
import type { ExecutionMode } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { isPositiveInteger } from '../auth/tokens.ts';
import { CURSOR_MAX_LENGTH } from './cursor.ts';
import type { AdminCallContext, AdminIdentity, ServiceResponse } from './types.ts';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 契约参数 If-Match：`^"[1-9][0-9]*"$`（不允许 `*`、不允许弱 ETag）。 */
export const IF_MATCH_RE = /^"[1-9][0-9]*"$/;
export const CACHE_CONTROL_NO_STORE = 'no-store';
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
/** 契约参数 Cursor/Idempotency-Key 的长度上限。 */
export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 128;
/** 普通后台回执保留 24 小时（state-contract），不延长会话或业务唯一键。 */
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** 通过权限门后的调用上下文（`requestId` 已定型，供 Meta 与审计共用同一个值）。 */
export interface ResolvedContext {
  identity: AdminIdentity;
  requestId: string;
  idempotencyKey: string | undefined;
  ifMatch: string | undefined;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 身份与权限门（与 `auth/middleware.ts` 的 `readIdentity` 语义对齐）。
 *
 * 口径（全片统一，写死在这里）：
 * - 身份字段本身缺失/非法 ⇒ `SESSION_REQUIRED`(401) / `INVALID_REQUEST`(400)；
 * - `audience !== 'admin'`（即用户会话）或缺少所需 scope ⇒ **一律 `SCOPE_DENIED`(403)**，
 *   且**不看目标是否存在**，因此不存在「靠 403/404 差异探测目标」的通道；
 * - 管辖外的目标 ⇒ `NOT_FOUND`(404)，与「目标不存在」**同形**。
 */
export function requireAdminScope(ctx: AdminCallContext, scope: string): void {
  const identity: unknown = ctx === null || ctx === undefined ? undefined : ctx.identity;
  if (!isPlainRecord(identity)) throw new ApiError('SESSION_REQUIRED', '缺少会话身份');
  if (typeof identity['userId'] !== 'string' || identity['userId'] === '') {
    throw new ApiError('SESSION_REQUIRED', '缺少会话身份');
  }
  if (identity['authEpoch'] === null || identity['authEpoch'] === undefined) {
    throw new ApiError('SESSION_REQUIRED', '缺少会话 authEpoch');
  }
  if (!isPositiveInteger(identity['authEpoch'])) {
    throw new ApiError('INVALID_REQUEST', 'authEpoch 必须为正整数');
  }
  if (identity['role'] !== 'user' && identity['role'] !== 'admin') {
    throw new ApiError('SESSION_REQUIRED', '缺少会话角色');
  }
  if (identity['role'] !== 'admin') {
    // 后台能力不接受用户会话：高权限拒绝，且不因目标差异改变。
    throw new ApiError('SCOPE_DENIED', '后台接口不接受用户会话');
  }
  const scopes = Array.isArray(identity['scopes']) ? identity['scopes'] : [];
  if (!scopes.includes(scope)) {
    throw new ApiError('SCOPE_DENIED', `缺少所需权限：${scope}`);
  }
}

export function requestIdOf(ctx: AdminCallContext): string {
  const provided: unknown = ctx?.requestId;
  if (provided === undefined || provided === null || provided === '') return randomUUID();
  if (typeof provided !== 'string' || !UUID_RE.test(provided)) {
    throw new ApiError('INVALID_REQUEST', 'request_id 必须是 uuid');
  }
  return provided.toLowerCase();
}

export function resolveContext(ctx: AdminCallContext, scope: string): ResolvedContext {
  requireAdminScope(ctx, scope);
  return {
    identity: {
      userId: (ctx.identity.userId as string).toLowerCase(),
      authEpoch: ctx.identity.authEpoch,
      role: 'admin',
      scopes: ctx.identity.scopes,
    },
    requestId: requestIdOf(ctx),
    idempotencyKey: ctx.idempotencyKey,
    ifMatch: ctx.ifMatch,
  };
}

/** 缺失 428 / 格式非法 400；不匹配由 `assertIfMatchMatches` 报 409。 */
export function parseIfMatchHeader(value: string | undefined): number {
  if (value === undefined || value === null || value === '') {
    throw new ApiError('REVISION_REQUIRED', '缺少必填请求头 If-Match');
  }
  if (typeof value !== 'string' || !IF_MATCH_RE.test(value)) {
    throw new ApiError('INVALID_REQUEST', 'If-Match 必须是形如 "12" 的强 ETag，且不允许 *', {
      details: [{ field: 'If-Match', code: 'pattern' }],
    });
  }
  const revision = Number(value.slice(1, -1));
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ApiError('INVALID_REQUEST', 'If-Match 中的 revision 不是安全正整数', {
      details: [{ field: 'If-Match', code: 'minimum' }],
    });
  }
  return revision;
}

export function assertIfMatchMatches(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new ApiError('REVISION_CONFLICT', '目标修订已变化，If-Match 与当前 ETag 不匹配');
  }
}

/** 路径参数按契约 `{type:"string", format:"uuid"}` 判定。 */
export function normalizeIdParam(id: unknown): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new ApiError('INVALID_REQUEST', '路径参数 id 必须是 uuid', {
      details: [{ field: 'id', code: 'format' }],
    });
  }
  return id.toLowerCase();
}

/**
 * 路径参数按契约**不透明字符串**判定（例如分类 id：`minLength:1, maxLength:80`，不是 uuid）。
 * 判定完全照契约的长度约束，不做额外收窄。
 */
export function normalizeStringIdParam(id: unknown, maxLength: number): string {
  if (typeof id !== 'string' || [...id].length < 1 || [...id].length > maxLength) {
    throw new ApiError('INVALID_REQUEST', `路径参数 id 必须是 1..${maxLength} 字符的字符串`, {
      details: [{ field: 'id', code: 'length' }],
    });
  }
  return id;
}

export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIMIT;
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_LIMIT) {
    throw new ApiError('INVALID_REQUEST', `limit 必须是 1..${MAX_LIMIT} 的整数`, {
      details: [{ field: 'limit', code: 'maximum' }],
    });
  }
  return numeric;
}

export function parseCursorParam(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new ApiError('INVALID_REQUEST', 'cursor 必须是字符串', { details: [{ field: 'cursor', code: 'type' }] });
  }
  if ([...raw].length > CURSOR_MAX_LENGTH) {
    // 违反契约参数 maxLength ⇒ INVALID_REQUEST；内容不可信才走 INVALID_CURSOR。
    throw new ApiError('INVALID_REQUEST', 'cursor 超出契约长度上限', {
      details: [{ field: 'cursor', code: 'max_length' }],
    });
  }
  return raw;
}

/**
 * 校验并规范化幂等键（契约参数 Idempotency-Key，所有写操作 required）。
 * 缺失 ⇒ `IDEMPOTENCY_KEY_REQUIRED`(400)；长度非法 ⇒ `INVALID_REQUEST`(400)。
 */
export function requireIdempotencyKeyValue(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', '缺少必填请求头 Idempotency-Key');
  }
  if (typeof raw !== 'string' || [...raw].length < IDEMPOTENCY_KEY_MIN || [...raw].length > IDEMPOTENCY_KEY_MAX) {
    throw new ApiError('INVALID_REQUEST', `Idempotency-Key 必须是 ${IDEMPOTENCY_KEY_MIN}..${IDEMPOTENCY_KEY_MAX} 字符`, {
      details: [{ field: 'Idempotency-Key', code: 'length' }],
    });
  }
  return raw;
}

/** 强 ETag：资源当前修订号。 */
export function etagOf(revision: number): string {
  return `"${revision}"`;
}

/** 契约 `Meta`。 */
export interface MetaValue {
  request_id: string;
  contract_version: string;
  execution_mode: ExecutionMode;
}

export function metaFor(context: ResolvedContext, executionMode: ExecutionMode): MetaValue {
  return {
    request_id: context.requestId,
    contract_version: CONTRACT_VERSION,
    execution_mode: executionMode,
  };
}

/** 单资源响应：带强 ETag 与 `Cache-Control: no-store`。 */
export function singleResponse<TData extends object>(
  context: ResolvedContext,
  executionMode: ExecutionMode,
  status: number,
  data: TData,
  etag: string | null,
): ServiceResponse<{ data: TData; meta: MetaValue }> {
  const headers: Record<string, string> = { 'Cache-Control': CACHE_CONTROL_NO_STORE };
  // 契约：资源 revision 强 ETag；列表响应**无**此头。
  if (etag !== null) headers['ETag'] = etag;
  return { status, headers, body: { data, meta: metaFor(context, executionMode) } };
}

/** 列表响应：契约给列表也声明了 ETag 头，但语义上「列表无此头」⇒ 只发 Cache-Control。 */
export function pageResponse<TItem>(
  context: ResolvedContext,
  executionMode: ExecutionMode,
  items: TItem[],
  nextCursor: string | null,
): ServiceResponse<{ data: { items: TItem[]; next_cursor: string | null }; meta: MetaValue }> {
  return {
    status: 200,
    headers: { 'Cache-Control': CACHE_CONTROL_NO_STORE },
    body: { data: { items, next_cursor: nextCursor }, meta: metaFor(context, executionMode) },
  };
}
