/**
 * R59 · 后台帖子读面服务（`listAdminPosts` / `getAdminPost`）。
 *
 * ## 为什么需要这个读面
 * 契约里 `/admin/posts` 原本只有一条 `hidePost`：管理员能**处置**帖子，却看不到
 * "有哪些帖子、某条帖子长什么样"。社区的口径是「先审后发」，因此后台必须先能读到
 * 待审队列与已处置内容，否则审核无从落地。
 *
 * ## 后台读面与管理视角的可见性谓词**与用户读面不同**（本文件存在的核心理由）
 * - 用户读面（`community/service.ts` 的 `listPosts`/`readablePost`，`scope: 'public'`）：
 *   「对外可见 ⟺ `visibility === 'published'` 且 `audit_state === 'approved'`」——
 *   `hidden` / `deleted` / 待审 / 拒审一律读不到（`readablePost` 对 `deleted` 直接 404）。
 * - 后台读面（`scope: 'admin'`）：`hidden` / `deleted` / 待审 / 拒审的帖子**都要看得到**，
 *   否则管理员看不到自己要处置、要复查的那一行，"先审后发"根本没法落地。
 * ⇒ 本服务**不**复用 `readablePost` / `effectiveState()` 的生效态重算，只把**库内存储值**原样给出。
 * `visibility` / `audit_state` 是库里的列值，不是公开读面按规则版本重算后的生效值——两者语义
 * 不同，混用会把"库里还是 published、但已按规则降级"的行掩盖掉。
 *
 * 这**不是**绕过权限：入口先过后台会话 + `sources:read`（13 项后台 scope 闭集里与内容读面
 * 同族的最高权限；闭集里没有 `content:read`，下架写面用的就是同族的 `sources:write`）。
 *
 * ## 顺序（与 `admin/audit/service.ts`、`admin/ops/service.ts` 一致）
 * 鉴权/权限（401/403）→ 端口接线（503）→ 入参闭集（400）→ 分页（400/`INVALID_CURSOR`）。
 * 未接线优先于入参非法：读不到就是读不到，先给 503 才是如实；⛔ 不返回空页
 * （空页会被读成"库里没有帖子"，那是伪造读数）。
 */
import { ApiError } from '../../errors.ts';
import type { ExecutionMode } from '../../contract.ts';
import type { PostRecord } from '../../community/store.ts';
import type { AuditState, Visibility } from '../../community/types.ts';
import type { AdminCallContext, ServiceResponse } from '../types.ts';
import { createCursorCodec, CURSOR_TTL_MS, type CursorCodec } from '../cursor.ts';
import {
  normalizeIdParam,
  pageResponse,
  parseClosedSetParam,
  parseCursorParam,
  parseLimit,
  resolveContext,
  singleResponse,
  etagOf,
  type ResolvedContext,
} from '../identity.ts';
import { MAX_FIELD_ERRORS } from '../fields.ts';
import { createAdminPostReadAdapter, type AdminPostReadAdapter } from '../ops/community-posts.ts';
import type { CommunityPostReadPort } from '../ops/types.ts';
import { adminPostsValidator } from './fields.ts';

/**
 * 后台帖子读面的 scope：`sources:read`。
 *
 * 13 项后台 scope 闭集（`admin/scopes.ts` 的 `ADMIN_SCOPES`）里**没有** `content:read`；
 * 社区帖子的读权与"资料内容"同族：四族读面（sources/knowledge/registrations/restrictions）
 * 的读门就是 `sources:read`，而下架写面 `hidePost` 用的是同族写门 `sources:write`。
 * 读写分立在同族内自洽 ⇒ 读面取 `sources:read`，**不自创 scope**。
 */
export const ADMIN_POST_READ_SCOPE = 'sources:read';

export const ADMIN_POST_READ_OPERATION_IDS: readonly string[] = Object.freeze([
  'listAdminPosts',
  'getAdminPost',
]);

/** 游标家族：与其它家族（`flag_audit` / `admin_audit_logs` …）一样，游标不可跨读面复用。 */
const ADMIN_POST_CURSOR_FAMILY = 'community_posts';

/** 契约 `Visibility` / `AuditState` 的运行时取值（`satisfies` 保证与类型定义不漂移）。 */
const VISIBILITY_STATES = ['private', 'published', 'hidden', 'deleted'] as const satisfies readonly Visibility[];
const AUDIT_STATES = ['pending', 'approved', 'rejected', 'quarantined'] as const satisfies readonly AuditState[];

/** 契约 `AdminPost`：列表项与详情同形（见 `admin/posts/fields.ts` 的镜像表）。 */
export interface AdminPostView {
  id: string;
  revision: number;
  author_id: string | null;
  anonymized_author_ref: string | null;
  title: string;
  body: string;
  crop_id: string | null;
  region_code: string | null;
  media_ids: string[];
  visibility: Visibility;
  audit_state: AuditState;
  created_at: string;
  updated_at: string;
  linked_knowledge_ref: { type: 'species' | 'herbicide' | 'scheme'; id: string; revision: number } | null;
}

export interface AdminPostReadService {
  readonly operationIds: readonly string[];
  /** `GET /admin/posts`：游标分页 + 可选 `state` / `audit_state` 等值过滤。 */
  listAdminPosts(
    ctx: AdminCallContext,
    query?: { limit?: unknown; cursor?: unknown; state?: unknown; audit_state?: unknown },
  ): Promise<ServiceResponse<{ data: { items: AdminPostView[]; next_cursor: string | null }; meta: unknown }>>;
  /** `GET /admin/posts/{id}`：单条详情；不存在 ⇒ 404（⛔ 不用 403，避免泄露存在性）。 */
  getAdminPost(
    ctx: AdminCallContext,
    id: unknown,
  ): Promise<ServiceResponse<{ data: AdminPostView; meta: unknown }>>;
}

export interface AdminPostReadServiceOptions {
  /** 未接线（`undefined`）⇒ 两个读面都 fail-closed 503。 */
  readonly port: CommunityPostReadPort | undefined;
  readonly signingKey: string;
  readonly executionMode: ExecutionMode;
  readonly now?: () => Date;
}

/** 端口回传不可信时的统一 fail-closed 错误（与 `admin/ops/service.ts` 同口径）。 */
function portIntegrityFailure(message: string): ApiError {
  return new ApiError('PROVIDER_UNAVAILABLE', message, { retryable: false });
}

export function createAdminPostReadService(options: AdminPostReadServiceOptions): AdminPostReadService {
  const executionMode = options.executionMode;
  const now = options.now ?? ((): Date => new Date());
  const cursors: CursorCodec = createCursorCodec(options.signingKey);
  const adapter: AdminPostReadAdapter | null = createAdminPostReadAdapter(options.port);

  /** 未接线 ⇒ 503（不是空页）。 */
  function requireWired(): AdminPostReadAdapter {
    if (adapter === null) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '后台帖子读面未接线（社区存储不可用）', { retryable: false });
    }
    return adapter;
  }

  /**
   * 库里的一行 → 契约 `AdminPost`。只做投影，**不改写**可见性/审核态：
   * 后台读面的定义就是"如实给出库内存储值"（见文件头）。
   */
  function toView(record: PostRecord): AdminPostView {
    return {
      id: record.id,
      revision: record.revision,
      author_id: record.author_id,
      anonymized_author_ref: record.anonymized_author_ref,
      title: record.title,
      body: record.body,
      crop_id: record.crop_id,
      region_code: record.region_code,
      media_ids: record.media_ids,
      visibility: record.visibility,
      audit_state: record.audit_state,
      created_at: record.created_at,
      updated_at: record.updated_at,
      linked_knowledge_ref:
        record.linked_knowledge_ref === null
          ? null
          : {
              type: record.linked_knowledge_ref.type,
              id: record.linked_knowledge_ref.id,
              revision: record.linked_knowledge_ref.revision,
            },
    };
  }

  /** 出口必须过契约镜像：库内行不是"信任边界内"的数据（手工改库、旧版本行都可能）。 */
  function assertPostContract(view: AdminPostView): AdminPostView {
    const issues = adminPostsValidator.collectIssues('AdminPost', view);
    if (issues.length > 0) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '帖子读面返回了不符合契约 AdminPost 的记录，拒绝投影', {
        retryable: false,
        details: issues.slice(0, MAX_FIELD_ERRORS),
      });
    }
    return view;
  }

  /** 游标位置：`createdAt|id`（与 `admin/audit/service.ts` 的 `position|id` 同一编码）。 */
  function decodePosition(after: string | null): { createdAt: string; id: string } | null {
    if (after === null) return null;
    const separator = after.lastIndexOf('|');
    if (separator <= 0 || separator === after.length - 1) {
      throw new ApiError('INVALID_CURSOR', '游标位置不可解析');
    }
    const createdAt = after.slice(0, separator);
    const id = after.slice(separator + 1);
    if (Number.isNaN(Date.parse(createdAt)) || id === '') {
      throw new ApiError('INVALID_CURSOR', '游标位置不可解析');
    }
    return { createdAt, id };
  }

  async function listAdminPosts(
    ctx: AdminCallContext,
    query: { limit?: unknown; cursor?: unknown; state?: unknown; audit_state?: unknown } = {},
  ): Promise<ServiceResponse<{ data: { items: AdminPostView[]; next_cursor: string | null }; meta: unknown }>> {
    const context: ResolvedContext = resolveContext(ctx, ADMIN_POST_READ_SCOPE);
    const read = requireWired();

    const limit = parseLimit(query.limit);
    // 闭集判定与 `?state=` 的既有读面（`listAdminJobs`）同一套：缺省/空串不过滤，
    // 非字符串或闭集外 ⇒ 400 INVALID_REQUEST（⛔ 不静默返回空页）。
    const state = parseClosedSetParam(query.state, 'state', VISIBILITY_STATES);
    const auditState = parseClosedSetParam(query.audit_state, 'audit_state', AUDIT_STATES);

    // 筛选组合的签名：游标只能在同一组筛选下继续翻页（换筛选后翻页会跳行/重行）。
    const watermark = cursors.watermarkOf([state ?? '', auditState ?? '']);

    const rawCursor = parseCursorParam(query.cursor);
    let after: { createdAt: string; id: string } | null = null;
    if (rawCursor !== null) {
      const payload = cursors.decode(rawCursor);
      if (
        payload.kind !== 'content' ||
        payload.family !== ADMIN_POST_CURSOR_FAMILY ||
        payload.subject !== context.identity.userId
      ) {
        throw new ApiError('INVALID_CURSOR', '游标不属于当前查询');
      }
      if (payload.expires <= now().getTime()) throw new ApiError('INVALID_CURSOR', '游标已过期');
      if (payload.watermark !== watermark) {
        throw new ApiError('INVALID_CURSOR', '筛选条件已变化，请从第一页重新开始');
      }
      after = decodePosition(payload.after);
    }

    const page = await read.list({ limit, after, state, auditState });
    const items = page.items.map((record) => assertPostContract(toView(record)));
    const last = items[items.length - 1];
    const nextCursor =
      page.hasMore && last !== undefined
        ? cursors.encode({
            kind: 'content',
            subject: context.identity.userId,
            family: ADMIN_POST_CURSOR_FAMILY,
            after: `${last.created_at}|${last.id}`,
            watermark,
            expires: now().getTime() + CURSOR_TTL_MS,
          })
        : null;

    const envelope = pageResponse(context, executionMode, items, nextCursor);
    const envelopeIssues = adminPostsValidator.collectIssues('AdminPostPageEnvelope', envelope.body);
    if (envelopeIssues.length > 0) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '后台帖子列表不符合契约 AdminPostPageEnvelope', {
        retryable: false,
        details: envelopeIssues.slice(0, MAX_FIELD_ERRORS),
      });
    }
    return envelope as ServiceResponse<{ data: { items: AdminPostView[]; next_cursor: string | null }; meta: unknown }>;
  }

  async function getAdminPost(
    ctx: AdminCallContext,
    id: unknown,
  ): Promise<ServiceResponse<{ data: AdminPostView; meta: unknown }>> {
    const context: ResolvedContext = resolveContext(ctx, ADMIN_POST_READ_SCOPE);
    const read = requireWired();
    const target = normalizeIdParam(id);

    const record = await read.get(target);
    // 不存在 ⇒ 404。⛔ 不用 403：403 会泄露"这个 id 存在但你没权限"，
    // 后台读面的 scope 是**入口级**的（没有按目标的行级授权），存在性不该成为探测通道。
    if (record === null) throw new ApiError('NOT_FOUND', '帖子不存在');

    const view = assertPostContract(toView(record));
    const envelope = singleResponse(context, executionMode, 200, view, etagOf(view.revision));
    const envelopeIssues = adminPostsValidator.collectIssues('AdminPostEnvelope', envelope.body);
    if (envelopeIssues.length > 0) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '后台帖子详情不符合契约 AdminPostEnvelope', {
        retryable: false,
        details: envelopeIssues.slice(0, MAX_FIELD_ERRORS),
      });
    }
    return envelope as ServiceResponse<{ data: AdminPostView; meta: unknown }>;
  }

  return { operationIds: ADMIN_POST_READ_OPERATION_IDS, listAdminPosts, getAdminPost };
}
