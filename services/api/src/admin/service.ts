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
import { ApiError } from '../errors.ts';
import type { FieldError } from '../errors.ts';
import type { ExecutionMode } from '../contract.ts';
import { assertContractInput, collectIssues, MAX_FIELD_ERRORS } from './fields.ts';
import { projectAuditEvent } from './audit.ts';
import { createAdminContentStore } from './store.ts';
import type { AdminContentStore } from './store.ts';
import { createCursorCodec } from './cursor.ts';
import {
  CACHE_CONTROL_NO_STORE,
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  assertIfMatchMatches,
  etagOf,
  metaFor,
  normalizeIdParam,
  parseCursorParam,
  parseIfMatchHeader,
  parseLimit,
  resolveContext,
  singleResponse,
} from './identity.ts';
import type { MetaValue, ResolvedContext } from './identity.ts';
import { runIdempotentWrite } from './idempotent-write.ts';
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
import type { AdminCallContext, ServiceResponse } from './types.ts';

/** 契约 `Meta` 与各信封共用；定义已抽到 `identity.ts`，此处只做转发以保持既有引用路径。 */
export type { MetaValue };

/** 契约审计 scope 取值：本片按「实际操作所行使的权限 scope」写入。 */
const AUDIT_SCOPE_BY_ACTION = {
  publish: 'sources:write',
  withdraw: 'sources:write',
} as const;

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
      { runtime: store, signingKey, ttlSeconds: idempotencyTtlSeconds, now },
      context,
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
          // 存储边界（`store.appendRevision`）自己负责深拷贝 + 深冻结：
          // 调用方事后改自己的对象、或改任何响应都动不了库里的修订内容。
          content: body,
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
      { runtime: store, signingKey, ttlSeconds: idempotencyTtlSeconds, now },
      context,
      { method: 'PATCH', path: `${descriptor.path}/${normalizedId}`, expectedStatus: 200 },
      body,
      () => {
        const entity = resolveOwned(descriptor, context, normalizedId);
        const head = headRevision(entity);
        assertIfMatchMatches(expectedRevision, head.revision);
        // **只追加新修订**：已发布修订的正文（以及它上面的任何修订）都不会被改写。
        const revision = store.appendRevision({
          entity,
          content: body,
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
      { runtime: store, signingKey, ttlSeconds: idempotencyTtlSeconds, now },
      context,
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
      { runtime: store, signingKey, ttlSeconds: idempotencyTtlSeconds, now },
      context,
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
