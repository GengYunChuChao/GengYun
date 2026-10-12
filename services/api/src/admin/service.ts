/**
 * 后台资料「草稿→发布→撤回」生命周期服务层（GY-I18 阶段 1）。
 *
 * 本文件**只做服务端**：不注册路由、不改 `app.ts`、不改 `apps/admin/**`、不改小程序。
 * 导出的 25 个方法名与 `packages/contracts/openapi.json` 的 operationId 一一对应。
 *
 * 核心安全语义（逐条落实，见派单第 2 节）：
 * 1. 草稿与已发布严格分离：`editXxxDraft` **只追加新修订**，永不改写已发布修订正文。
 * 2. 已发布修订不可变：发布后任何正文修改都产生更新的草稿修订，旧已发布修订保持可追溯。
 * 3. 撤回真正退出公开视图（服务层读口径 `public-view.ts`），且不删任何审计痕迹。
 * 4. 每次发布/撤回追加审计事件（含主体、动作、`TargetRef{...,revision}`、时间）；
 *    审计只可追加、不可改删（`audit.ts`）。
 * 5. 发布门槛 fail-closed：发布时对**库中当前修订内容**按契约全量复检，
 *    且提交是同步的、中间没有 await ⇒ 不存在部分发布。
 * 6. 权限：只有 `audience === 'admin'` 且持有对应 scope 可操作；
 *    越权目标与「不存在」对外同形（都 `NOT_FOUND`）。
 * 7. 幂等并发：发布/撤回先原子占位；同键同体并发恰好 1 次生效 + 恰好 1 条审计；
 *    同键异体 ⇒ `IDEMPOTENCY_CONFLICT`；重复 publish/withdraw 幂等；失败释放占位。
 * 8. `If-Match`：缺失 428 / 格式非法 400 / 不匹配 409。
 * 9. 不实现适用性判定、原文用量绑定、剂量换算（属 GY-I08 线）。
 *
 * 存储是**进程内内存 store**（`execution_mode: 'stub'`），**不是**真实 PostgreSQL 接线。
 */
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION } from '../contract.ts';
import type { ExecutionMode } from '../contract.ts';
import { ApiError } from '../errors.ts';
import type { FieldError } from '../errors.ts';
import { isPositiveInteger } from '../auth/tokens.ts';
import {
  idempotencyKeyHashHex,
  idempotencyRequestHash,
  idempotencyScope,
} from '../auth/idempotency.ts';
import { assertContractInput, collectIssues, MAX_FIELD_ERRORS } from './fields.ts';
import { projectAuditEvent } from './audit.ts';
import { createAdminContentStore } from './store.ts';
import type { AdminContentStore } from './store.ts';
import { CURSOR_MAX_LENGTH, createCursorCodec } from './cursor.ts';
import {
  FAMILIES,
  KNOWLEDGE_FAMILY,
  REGISTRATION_FAMILY,
  RESTRICTION_FAMILY,
  SOURCE_FAMILY,
  headRevision,
  isLivePublishedRevision,
  projectRevisionData,
  targetRefFor,
} from './families.ts';
import type { FamilyDescriptor } from './families.ts';
import type {
  AdminCallContext,
  AdminIdentity,
  ContentIdempotencyOutcome,
  ServiceResponse,
} from './types.ts';

/** 契约 `Meta`。 */
export interface MetaValue {
  request_id: string;
  contract_version: string;
  execution_mode: ExecutionMode;
}

/** 契约单资源信封 `{data, meta}`。 */
export interface DraftEnvelope {
  data: Record<string, unknown>;
  meta: MetaValue;
}

/** 契约分页信封 `{data:{items,next_cursor}, meta}`。 */
export interface PageEnvelope {
  data: { items: Record<string, unknown>[]; next_cursor: string | null };
  meta: MetaValue;
}

/** 列表查询参数（路由层透传；服务层按契约判定）。 */
export interface PageQuery {
  cursor?: unknown;
  limit?: unknown;
}

export interface PublishBody {
  evidence_ref?: unknown;
  reason?: unknown;
}

export interface WithdrawBody {
  reason?: unknown;
}

export interface AdminContentServiceOptions {
  /** 允许注入 store（测试用）；缺省新建内存 store。 */
  store?: AdminContentStore;
  now?: () => Date;
  /** 幂等请求摘要与游标签名用的服务端密钥；只经内存传入，不入库。 */
  signingKey: string;
  /** 内存 store 尚未接真实库，默认如实标注 `stub`。 */
  executionMode?: ExecutionMode;
  idempotencyTtlSeconds?: number;
}

/**
 * 后台资料服务。25 个方法名 = 契约 operationId。
 *
 * 其中 24 个（四类资料 × 6）是**同一套引擎**上的 4 份薄封装；
 * `operationsByFamily` 是同一份映射的机读形式，供测试断言「25 个 operationId 全部就位」。
 */
export interface AdminContentService {
  readonly store: AdminContentStore;
  /** 本片实现的 operationId 全集（应恰好 25 个）。 */
  readonly operationIds: readonly string[];

  listAdminSources(ctx: AdminCallContext, query?: PageQuery): Promise<ServiceResponse<PageEnvelope>>;
  createSourceDraft(ctx: AdminCallContext, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
  getAdminSource(ctx: AdminCallContext, id: string): Promise<ServiceResponse<DraftEnvelope>>;
  editSourceDraft(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
  publishSource(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
  withdrawSource(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;

  listAdminKnowledge(ctx: AdminCallContext, query?: PageQuery): Promise<ServiceResponse<PageEnvelope>>;
  createKnowledgeDraft(ctx: AdminCallContext, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
  getAdminKnowledge(ctx: AdminCallContext, id: string): Promise<ServiceResponse<DraftEnvelope>>;
  editKnowledgeDraft(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
  publishKnowledge(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
  withdrawKnowledge(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;

  listAdminRegistration(ctx: AdminCallContext, query?: PageQuery): Promise<ServiceResponse<PageEnvelope>>;
  createRegistrationDraft(ctx: AdminCallContext, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
  getAdminRegistration(ctx: AdminCallContext, id: string): Promise<ServiceResponse<DraftEnvelope>>;
  editRegistrationDraft(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
  publishRegistration(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
  withdrawRegistration(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;

  listAdminRestriction(ctx: AdminCallContext, query?: PageQuery): Promise<ServiceResponse<PageEnvelope>>;
  createRestrictionDraft(ctx: AdminCallContext, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
  getAdminRestriction(ctx: AdminCallContext, id: string): Promise<ServiceResponse<DraftEnvelope>>;
  editRestrictionDraft(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
  publishRestriction(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;
  withdrawRestriction(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<DraftEnvelope>>;

  listAuditEvents(ctx: AdminCallContext, query?: PageQuery): Promise<ServiceResponse<PageEnvelope>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 契约参数 If-Match：`^"[1-9][0-9]*"$`（不允许 `*`、不允许弱 ETag）。 */
const IF_MATCH_RE = /^"[1-9][0-9]*"$/;
const CACHE_CONTROL_NO_STORE = 'no-store';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 5 * 60;

/** 契约审计 scope 取值：本片按「实际操作所行使的权限 scope」写入。 */
const AUDIT_SCOPE_BY_ACTION = {
  publish: 'sources:write',
  withdraw: 'sources:write',
} as const;

interface ResolvedContext {
  identity: AdminIdentity;
  requestId: string;
  idempotencyKey: string | undefined;
  ifMatch: string | undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 身份与权限门（与 `auth/middleware.ts` 的 `readIdentity` 语义对齐）。
 *
 * 口径（本片统一，写死在这里）：
 * - 身份字段本身缺失/非法 ⇒ `SESSION_REQUIRED`(401) / `INVALID_REQUEST`(400)；
 * - `audience !== 'admin'`（即用户会话）或缺少所需 scope ⇒ **一律 `SCOPE_DENIED`(403)**，
 *   且**不看目标是否存在**，因此不存在「靠 403/404 差异探测目标」的通道；
 * - 管辖外的目标 ⇒ `NOT_FOUND`(404)，与「目标不存在」**同形**。
 */
function requireAdminScope(ctx: AdminCallContext, scope: string): void {
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

function requestIdOf(ctx: AdminCallContext): string {
  const provided: unknown = ctx?.requestId;
  if (provided === undefined || provided === null || provided === '') return randomUUID();
  if (typeof provided !== 'string' || !UUID_RE.test(provided)) {
    throw new ApiError('INVALID_REQUEST', 'request_id 必须是 uuid');
  }
  return provided.toLowerCase();
}

function resolveContext(ctx: AdminCallContext, scope: string): ResolvedContext {
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
function parseIfMatchHeader(value: string | undefined): number {
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

function assertIfMatchMatches(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new ApiError('REVISION_CONFLICT', '目标修订已变化，If-Match 与当前 ETag 不匹配');
  }
}

/** 路径参数按契约 `{type:"string", format:"uuid"}` 判定。 */
function normalizeIdParam(id: unknown): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new ApiError('INVALID_REQUEST', '路径参数 id 必须是 uuid', {
      details: [{ field: 'id', code: 'format' }],
    });
  }
  return id.toLowerCase();
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIMIT;
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_LIMIT) {
    throw new ApiError('INVALID_REQUEST', `limit 必须是 1..${MAX_LIMIT} 的整数`, {
      details: [{ field: 'limit', code: 'maximum' }],
    });
  }
  return numeric;
}

function parseCursorParam(raw: unknown): string | null {
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

/** 深冻结：审计台账与幂等台账里的结果引用一旦定型即不可改。 */
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      freezeDeep((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function cloneDeep<T>(value: T): T {
  return structuredClone(value);
}

function etagOf(revision: number): string {
  return `"${revision}"`;
}

function metaFor(context: ResolvedContext, executionMode: ExecutionMode): MetaValue {
  return {
    request_id: context.requestId,
    contract_version: CONTRACT_VERSION,
    execution_mode: executionMode,
  };
}

function singleResponse(
  context: ResolvedContext,
  executionMode: ExecutionMode,
  status: number,
  data: Record<string, unknown>,
  etag: string | null,
): ServiceResponse<DraftEnvelope> {
  const headers: Record<string, string> = { 'Cache-Control': CACHE_CONTROL_NO_STORE };
  // 契约：资源 revision 强 ETag；列表响应**无**此头。
  if (etag !== null) headers['ETag'] = etag;
  return { status, headers, body: { data, meta: metaFor(context, executionMode) } };
}

/**
 * 写路径的幂等外壳：**先原子占位**，再执行 `produce`，成功后定型结果，失败释放占位。
 *
 * 同键同体并发 ⇒ 只有占位者执行 produce（恰好 1 次生效 + 恰好 1 条审计），
 * 后到者命中已定型结果，**按记录原样重放**（内容不含任何凭据，重放不涉及凭据泄露）。
 * 同键异体 ⇒ `IDEMPOTENCY_CONFLICT`。
 */
async function runIdempotentWrite(
  store: AdminContentStore,
  signingKey: string,
  idempotencyTtlSeconds: number,
  now: () => Date,
  context: ResolvedContext,
  keyDomain: { method: string; path: string; expectedStatus: number },
  requestBody: unknown,
  produce: () => ServiceResponse<DraftEnvelope>,
): Promise<ServiceResponse<DraftEnvelope>> {
  const rawKey: unknown = context.idempotencyKey;
  if (rawKey === undefined || rawKey === null || rawKey === '') {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', '缺少必填请求头 Idempotency-Key');
  }
  if (typeof rawKey !== 'string' || [...rawKey].length < 8 || [...rawKey].length > 128) {
    throw new ApiError('INVALID_REQUEST', 'Idempotency-Key 必须是 8..128 字符', {
      details: [{ field: 'Idempotency-Key', code: 'length' }],
    });
  }

  const scope = idempotencyScope(context.identity.userId, keyDomain.method, keyDomain.path);
  const keyHash = idempotencyKeyHashHex(scope, rawKey);
  const requestHash = idempotencyRequestHash(requestBody, context.ifMatch, signingKey);
  const issuedAt = now();
  const expiresAt = new Date(issuedAt.getTime() + idempotencyTtlSeconds * 1000);

  return store.transaction(() => {
    const settled = store.findIdempotent(scope, keyHash);
    if (settled !== null) {
      if (settled.requestHash !== requestHash) {
        throw new ApiError('IDEMPOTENCY_CONFLICT', '同一幂等键已用于不同请求体');
      }
      return {
        status: settled.outcome.status,
        headers: cloneDeep(settled.outcome.headers),
        body: cloneDeep(settled.outcome.body) as DraftEnvelope,
      };
    }
    if (!store.claimIdempotent(scope, keyHash, { requestHash, responseStatus: keyDomain.expectedStatus, expiresAt, now: issuedAt })) {
      const row = store.peekIdempotent(scope, keyHash);
      if (row !== null && row.requestHash === requestHash) {
        throw new ApiError('REQUEST_IN_PROGRESS', '同一幂等键的请求正在处理中', { retryable: true });
      }
      throw new ApiError('IDEMPOTENCY_CONFLICT', '同一幂等键已用于不同请求体');
    }
    try {
      const response = produce();
      const outcome: ContentIdempotencyOutcome = {
        kind: 'admin_content',
        status: response.status,
        headers: { ...response.headers },
        body: cloneDeep(response.body),
      };
      freezeDeep(outcome);
      store.completeIdempotent(scope, keyHash, outcome, expiresAt);
      return response;
    } catch (error) {
      // 失败必须释放占位，否则同键重试会被自己的占位挡住。
      store.releaseIdempotent(scope, keyHash);
      throw error;
    }
  });
}

function gateDetails(issues: { field: string; code: string }[]): FieldError[] {
  return issues.slice(0, MAX_FIELD_ERRORS).map((issue) => ({
    field: issue.field === '' ? '(content)' : issue.field,
    code: issue.code,
  }));
}

export function createAdminContentService(options: AdminContentServiceOptions): AdminContentService {
  const store = options.store ?? createAdminContentStore();
  const now = options.now ?? (() => new Date());
  const executionMode: ExecutionMode = options.executionMode ?? 'stub';
  const idempotencyTtlSeconds = options.idempotencyTtlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  const signingKey = options.signingKey;
  if (typeof signingKey !== 'string' || [...signingKey].length < 16) {
    throw new Error('后台资料服务需要至少 16 字符的签名密钥（只经内存传入，不入库）');
  }
  const cursors = createCursorCodec(signingKey);

  // -------------------------------------------------------------------------
  // 权限/归属解析
  // -------------------------------------------------------------------------

  /**
   * 解析「本主体管辖的」目标。三种情况对外同形，一律 NOT_FOUND：
   * 目标不存在、目标属于别的家族、目标由别的管理主体管辖。
   */
  function resolveOwned(descriptor: FamilyDescriptor, context: ResolvedContext, rawId: unknown) {
    const id = normalizeIdParam(rawId);
    const entity = store.getEntity(id);
    if (entity === undefined || entity.family !== descriptor.family || entity.stewardId !== context.identity.userId) {
      throw new ApiError('NOT_FOUND', '资料不存在');
    }
    return entity;
  }

  // -------------------------------------------------------------------------
  // 四类资料共用的六个动作（就是「一套引擎」）
  // -------------------------------------------------------------------------

  function listFamily(
    descriptor: FamilyDescriptor,
    context: ResolvedContext,
    query: PageQuery,
  ): ServiceResponse<PageEnvelope> {
    const limit = parseLimit(query.limit);
    const rawCursor = parseCursorParam(query.cursor);
    const entities = store.listEntities(descriptor.family, context.identity.userId);
    const ids = entities.map((entity) => entity.id);
    const watermark = cursors.watermarkOf(ids);

    let afterId: string | null = null;
    if (rawCursor !== null) {
      const payload = cursors.decode(rawCursor);
      if (payload.kind !== 'content' || payload.family !== descriptor.family || payload.subject !== context.identity.userId) {
        throw new ApiError('INVALID_CURSOR', '游标不属于当前查询');
      }
      if (payload.expires <= now().getTime()) throw new ApiError('INVALID_CURSOR', '游标已过期');
      if (payload.watermark !== watermark) throw new ApiError('INVALID_CURSOR', '资料集合已变化，请重新开始分页');
      afterId = payload.after;
    }

    let start = 0;
    if (afterId !== null) {
      const index = ids.indexOf(afterId);
      if (index < 0) throw new ApiError('INVALID_CURSOR', '游标位置已失效');
      start = index + 1;
    }
    const page = entities.slice(start, start + limit);
    const hasMore = start + limit < entities.length;
    const nextCursor = hasMore
      ? cursors.encode({
          kind: 'content',
          subject: context.identity.userId,
          family: descriptor.family,
          after: page.at(-1)?.id ?? null,
          watermark,
          expires: now().getTime() + 15 * 60 * 1000,
        })
      : null;

    return {
      status: 200,
      // 契约：列表响应有 Cache-Control，**没有** ETag。
      headers: { 'Cache-Control': CACHE_CONTROL_NO_STORE },
      body: {
        data: {
          items: page.map((entity) => projectRevisionData(descriptor, entity, headRevision(entity))),
          next_cursor: nextCursor,
        },
        meta: metaFor(context, executionMode),
      },
    };
  }

  async function createDraft(
    descriptor: FamilyDescriptor,
    ctx: AdminCallContext,
    body: unknown,
  ): Promise<ServiceResponse<DraftEnvelope>> {
    const context = resolveContext(ctx, descriptor.writeScope);
    assertContractInput(descriptor.inputSchema, body);
    return runIdempotentWrite(
      store, signingKey, idempotencyTtlSeconds, now, context,
      { method: 'POST', path: descriptor.path, expectedStatus: 201 },
      body,
      () => {
        const issuedAt = now();
        const entity = store.createEntity({
          family: descriptor.family,
          stewardId: context.identity.userId,
          createdAt: issuedAt,
        });
        const revision = store.appendRevision({
          entity,
          // 存副本：调用方事后改自己的对象也动不了库里的修订内容。
          content: cloneDeep(body),
          authorId: context.identity.userId,
          createdAt: issuedAt,
          derivedFromRevision: null,
        });
        return singleResponse(context, executionMode, 201, projectRevisionData(descriptor, entity, revision), etagOf(revision.revision));
      },
    );
  }

  function getDraft(
    descriptor: FamilyDescriptor,
    ctx: AdminCallContext,
    id: string,
  ): ServiceResponse<DraftEnvelope> {
    const context = resolveContext(ctx, descriptor.readScope);
    const entity = resolveOwned(descriptor, context, id);
    const head = headRevision(entity);
    return singleResponse(context, executionMode, 200, projectRevisionData(descriptor, entity, head), etagOf(head.revision));
  }

  async function editDraft(
    descriptor: FamilyDescriptor,
    ctx: AdminCallContext,
    id: string,
    body: unknown,
  ): Promise<ServiceResponse<DraftEnvelope>> {
    const context = resolveContext(ctx, descriptor.writeScope);
    // 头部格式先判（缺 428 / 非法 400），与目标是否存在无关。
    const expectedRevision = parseIfMatchHeader(context.ifMatch);
    assertContractInput(descriptor.inputSchema, body);
    const normalizedId = normalizeIdParam(id);

    return runIdempotentWrite(
      store, signingKey, idempotencyTtlSeconds, now, context,
      { method: 'PATCH', path: `${descriptor.path}/${normalizedId}`, expectedStatus: 200 },
      body,
      () => {
        const entity = resolveOwned(descriptor, context, normalizedId);
        const head = headRevision(entity);
        assertIfMatchMatches(expectedRevision, head.revision);
        // **只追加新修订**：已发布修订的正文（以及它上面的任何修订）都不会被改写。
        const revision = store.appendRevision({
          entity,
          content: cloneDeep(body),
          authorId: context.identity.userId,
          createdAt: now(),
          derivedFromRevision: head.revision,
        });
        return singleResponse(context, executionMode, 200, projectRevisionData(descriptor, entity, revision), etagOf(revision.revision));
      },
    );
  }

  async function publishDraft(
    descriptor: FamilyDescriptor,
    ctx: AdminCallContext,
    id: string,
    body: unknown,
  ): Promise<ServiceResponse<DraftEnvelope>> {
    const context = resolveContext(ctx, descriptor.writeScope);
    const expectedRevision = parseIfMatchHeader(context.ifMatch);
    // 发布体本身按契约校验（`SourcePublishInput` 被四类资料共用）。
    assertContractInput('SourcePublishInput', body);
    const publishBody = body as { evidence_ref: string; reason: string };
    const normalizedId = normalizeIdParam(id);

    return runIdempotentWrite(
      store, signingKey, idempotencyTtlSeconds, now, context,
      { method: 'POST', path: `${descriptor.path}/${normalizedId}/publish`, expectedStatus: 200 },
      body,
      () => {
        const entity = resolveOwned(descriptor, context, normalizedId);
        const head = headRevision(entity);
        // 「revision 不一致」由 If-Match 承担：契约的发布体里没有 revision 字段。
        assertIfMatchMatches(expectedRevision, head.revision);

        // 幂等：head 已经是**当前生效的**已发布修订 ⇒ 不再迁移状态、不再记审计。
        if (isLivePublishedRevision(entity, head)) {
          return singleResponse(context, executionMode, 200, projectRevisionData(descriptor, entity, head), etagOf(head.revision));
        }

        // 发布门槛 fail-closed：对**库里当前修订内容**按契约全量复检。
        // 即便写入路径被绕过（历史数据/迁移/未来改线），这里也绝不放行。
        const issues = collectIssues(descriptor.inputSchema, head.content);
        if (issues.length > 0) {
          store.audit.append({
            actorId: context.identity.userId,
            action: `${descriptor.noun}.publish`,
            scope: AUDIT_SCOPE_BY_ACTION.publish,
            targetRef: targetRefFor(descriptor, entity, head),
            reasonCode: `publish_gate_denied:${issues[0]?.code ?? 'unknown'}`.slice(0, 80),
            requestId: context.requestId,
            result: 'denied',
            createdAt: now(),
          });
          throw new ApiError('INVALID_REQUEST', '发布门槛未通过：资料内容不符合契约', {
            details: gateDetails(issues),
          });
        }

        // 全有或全无：以下提交是同步的，中间没有 await ⇒ 不存在部分发布。
        const committedAt = now();
        entity.publishedRevision = head.revision;
        entity.lifecycle = 'published';
        entity.publishedAt = committedAt;
        entity.publishedById = context.identity.userId;
        entity.publishedEvidenceRef = publishBody.evidence_ref;
        entity.publishedReason = publishBody.reason;

        store.audit.append({
          actorId: context.identity.userId,
          action: `${descriptor.noun}.publish`,
          scope: AUDIT_SCOPE_BY_ACTION.publish,
          targetRef: targetRefFor(descriptor, entity, head),
          reasonCode: 'publish_gate_passed',
          requestId: context.requestId,
          result: 'accepted',
          createdAt: committedAt,
        });

        return singleResponse(context, executionMode, 200, projectRevisionData(descriptor, entity, head), etagOf(head.revision));
      },
    );
  }

  async function withdrawDraft(
    descriptor: FamilyDescriptor,
    ctx: AdminCallContext,
    id: string,
    body: unknown,
  ): Promise<ServiceResponse<DraftEnvelope>> {
    const context = resolveContext(ctx, descriptor.writeScope);
    const expectedRevision = parseIfMatchHeader(context.ifMatch);
    assertContractInput('ReasonInput', body);
    const withdrawBody = body as { reason: string };
    const normalizedId = normalizeIdParam(id);

    return runIdempotentWrite(
      store, signingKey, idempotencyTtlSeconds, now, context,
      { method: 'POST', path: `${descriptor.path}/${normalizedId}/withdraw`, expectedStatus: 200 },
      body,
      () => {
        const entity = resolveOwned(descriptor, context, normalizedId);
        const head = headRevision(entity);
        assertIfMatchMatches(expectedRevision, head.revision);

        // 幂等：已撤回 ⇒ 不再迁移、不再记审计、也不报错。
        if (entity.lifecycle === 'withdrawn') {
          return singleResponse(context, executionMode, 200, projectRevisionData(descriptor, entity, head), etagOf(head.revision));
        }
        const publishedRevisionNumber = entity.publishedRevision;
        const published = publishedRevisionNumber === null
          ? undefined
          : entity.revisions.find((revision) => revision.revision === publishedRevisionNumber);
        if (published === undefined) {
          // 从未发布过：没有可撤回的公开视图。契约 409 闭集里取「对象当前不可操作」。
          throw new ApiError('OBJECT_UNAVAILABLE', '资料尚未发布，没有可撤回的公开视图');
        }

        // 全有或全无：同步提交。
        const committedAt = now();
        entity.lifecycle = 'withdrawn';
        entity.withdrawnAt = committedAt;
        entity.withdrawnById = context.identity.userId;
        entity.withdrawnReason = withdrawBody.reason;

        store.audit.append({
          actorId: context.identity.userId,
          action: `${descriptor.noun}.withdraw`,
          scope: AUDIT_SCOPE_BY_ACTION.withdraw,
          // 撤回针对的是**当前生效的已发布修订**，审计保留该修订号（可追溯）。
          targetRef: targetRefFor(descriptor, entity, published),
          reasonCode: 'withdraw_executed',
          requestId: context.requestId,
          result: 'accepted',
          createdAt: committedAt,
        });

        return singleResponse(context, executionMode, 200, projectRevisionData(descriptor, entity, head), etagOf(head.revision));
      },
    );
  }

  function listAudit(context: ResolvedContext, query: PageQuery): ServiceResponse<PageEnvelope> {
    const limit = parseLimit(query.limit);
    const rawCursor = parseCursorParam(query.cursor);
    const records = store.audit.list();
    const ids = records.map((record) => record.id);
    const watermark = cursors.watermarkOf(ids);

    let afterId: string | null = null;
    if (rawCursor !== null) {
      const payload = cursors.decode(rawCursor);
      if (payload.kind !== 'audit' || payload.family !== '*' || payload.subject !== context.identity.userId) {
        throw new ApiError('INVALID_CURSOR', '游标不属于当前查询');
      }
      if (payload.expires <= now().getTime()) throw new ApiError('INVALID_CURSOR', '游标已过期');
      if (payload.watermark !== watermark) throw new ApiError('INVALID_CURSOR', '审计台账已变化，请重新开始分页');
      afterId = payload.after;
    }

    let start = 0;
    if (afterId !== null) {
      const index = ids.indexOf(afterId);
      if (index < 0) throw new ApiError('INVALID_CURSOR', '游标位置已失效');
      start = index + 1;
    }
    const page = records.slice(start, start + limit);
    const hasMore = start + limit < records.length;
    const nextCursor = hasMore
      ? cursors.encode({
          kind: 'audit',
          subject: context.identity.userId,
          family: '*',
          after: page.at(-1)?.id ?? null,
          watermark,
          expires: now().getTime() + 15 * 60 * 1000,
        })
      : null;

    return {
      status: 200,
      headers: { 'Cache-Control': CACHE_CONTROL_NO_STORE },
      body: {
        data: {
          // 契约出口：只输出 AuditEvent 的 8 个字段（内部 actor_id 在此被剥离）。
          items: page.map((record) => projectAuditEvent(record) as unknown as Record<string, unknown>),
          next_cursor: nextCursor,
        },
        meta: metaFor(context, executionMode),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 25 个 operationId → 实现
  // -------------------------------------------------------------------------

  const service: AdminContentService = {
    store,
    operationIds: Object.freeze(FAMILIES.flatMap((descriptor) => Object.values(descriptor.operations)).concat(['listAuditEvents'])),

    listAdminSources: async (ctx, query = {}) => listFamily(SOURCE_FAMILY, resolveContext(ctx, SOURCE_FAMILY.readScope), query),
    createSourceDraft: (ctx, body) => createDraft(SOURCE_FAMILY, ctx, body),
    getAdminSource: async (ctx, id) => getDraft(SOURCE_FAMILY, ctx, id),
    editSourceDraft: (ctx, id, body) => editDraft(SOURCE_FAMILY, ctx, id, body),
    publishSource: (ctx, id, body) => publishDraft(SOURCE_FAMILY, ctx, id, body),
    withdrawSource: (ctx, id, body) => withdrawDraft(SOURCE_FAMILY, ctx, id, body),

    listAdminKnowledge: async (ctx, query = {}) => listFamily(KNOWLEDGE_FAMILY, resolveContext(ctx, KNOWLEDGE_FAMILY.readScope), query),
    createKnowledgeDraft: (ctx, body) => createDraft(KNOWLEDGE_FAMILY, ctx, body),
    getAdminKnowledge: async (ctx, id) => getDraft(KNOWLEDGE_FAMILY, ctx, id),
    editKnowledgeDraft: (ctx, id, body) => editDraft(KNOWLEDGE_FAMILY, ctx, id, body),
    publishKnowledge: (ctx, id, body) => publishDraft(KNOWLEDGE_FAMILY, ctx, id, body),
    withdrawKnowledge: (ctx, id, body) => withdrawDraft(KNOWLEDGE_FAMILY, ctx, id, body),

    listAdminRegistration: async (ctx, query = {}) => listFamily(REGISTRATION_FAMILY, resolveContext(ctx, REGISTRATION_FAMILY.readScope), query),
    createRegistrationDraft: (ctx, body) => createDraft(REGISTRATION_FAMILY, ctx, body),
    getAdminRegistration: async (ctx, id) => getDraft(REGISTRATION_FAMILY, ctx, id),
    editRegistrationDraft: (ctx, id, body) => editDraft(REGISTRATION_FAMILY, ctx, id, body),
    publishRegistration: (ctx, id, body) => publishDraft(REGISTRATION_FAMILY, ctx, id, body),
    withdrawRegistration: (ctx, id, body) => withdrawDraft(REGISTRATION_FAMILY, ctx, id, body),

    listAdminRestriction: async (ctx, query = {}) => listFamily(RESTRICTION_FAMILY, resolveContext(ctx, RESTRICTION_FAMILY.readScope), query),
    createRestrictionDraft: (ctx, body) => createDraft(RESTRICTION_FAMILY, ctx, body),
    getAdminRestriction: async (ctx, id) => getDraft(RESTRICTION_FAMILY, ctx, id),
    editRestrictionDraft: (ctx, id, body) => editDraft(RESTRICTION_FAMILY, ctx, id, body),
    publishRestriction: (ctx, id, body) => publishDraft(RESTRICTION_FAMILY, ctx, id, body),
    withdrawRestriction: (ctx, id, body) => withdrawDraft(RESTRICTION_FAMILY, ctx, id, body),

    listAuditEvents: async (ctx, query = {}) => listAudit(resolveContext(ctx, 'audit:read'), query),
  };

  return service;
}

/** 供测试/装配读取的描述符表（只读）。 */
export { FAMILIES as ADMIN_FAMILY_DESCRIPTORS };
