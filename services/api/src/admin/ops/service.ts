/**
 * GY-I18 阶段 1b · 后台运营与开关服务层（**恰好 9 个 operationId**）。
 *
 * 本文件**只做服务端**：不注册路由、不改 `app.ts`、不改 `apps/admin/**`、不改小程序、
 * 不改 `services/api/src/community/**`（只读依赖）。
 *
 * 复用清单（关键：不是新写一套）：
 * - 身份/权限门、`If-Match`、分页参数、响应信封 ← `admin/identity.ts`（阶段 1 抽出）；
 * - 幂等占位/重放语义 ← `admin/idempotent-write.ts`（阶段 1 抽出）；
 * - 串行临界区、只可追加审计、幂等台账 ← `admin/runtime.ts`（阶段 1 抽出）；
 * - 契约字段校验 ← `admin/fields.ts` 的同一套实现（本片只换注册表）；
 * - 入口冻结 / 出口深拷贝 ← `admin/immutable.ts`（阶段 1 的不可变边界）；
 * - 社区帖子可见性 ← `community/store.ts` 的 CAS 原语（只读 import，不另写一套判定）。
 *
 * 存储是**进程内内存 store**（`execution_mode: 'stub'`），**未接真实 PostgreSQL**。
 */
import { ApiError } from '../../errors.ts';
import type { ExecutionMode } from '../../contract.ts';
import { cloneDeep } from '../immutable.ts';
import { createCursorCodec } from '../cursor.ts';
import { projectAuditEvent } from '../audit.ts';
import {
  DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  assertIfMatchMatches,
  etagOf,
  metaFor,
  normalizeIdParam,
  normalizeStringIdParam,
  parseCursorParam,
  parseIfMatchHeader,
  parseLimit,
  resolveContext,
  singleResponse,
} from '../identity.ts';
import type { MetaValue, ResolvedContext } from '../identity.ts';
import { runIdempotentWrite } from '../idempotent-write.ts';
import type { AdminCallContext, AuditResult, ServiceResponse, TargetRefValue } from '../types.ts';
import { opsValidator } from './fields.ts';
import { classifyFlagKey, DEFAULT_FLAG_EFFECTS, assertNoFlagWeakensFailClosed } from './flags.ts';
import type { FlagEffect, FlagKey } from './flags.ts';
import { createUnwiredAdminJobPort } from './jobs.ts';
import { createHidePostAdapter } from './community-posts.ts';
import { createAdminOpsStore } from './store.ts';
import type { AdminOpsStore } from './store.ts';
import type {
  AccountView,
  AdminJobPort,
  AdminJobView,
  CategoryView,
  CommunityPostPort,
  JobState,
  CancelJobOutcome,
} from './types.ts';
import { TERMINAL_JOB_STATES } from './types.ts';

// ---------------------------------------------------------------------------
// 契约信封
// ---------------------------------------------------------------------------

export interface PageEnvelope<TItem> {
  data: { items: TItem[]; next_cursor: string | null };
  meta: MetaValue;
}

export interface SingleEnvelope<TData> {
  data: TData;
  meta: MetaValue;
}

export interface PageQuery {
  cursor?: unknown;
  limit?: unknown;
}

export interface AdminOpsServiceOptions {
  /** 允许注入 store（测试用）；缺省用下面的种子新建内存 store。 */
  store?: AdminOpsStore;
  categorySeed?: readonly CategoryView[];
  accountSeed?: readonly AccountView[];
  now?: () => Date;
  /** 幂等请求摘要与游标签名用的服务端密钥；只经内存传入，不入库。 */
  signingKey: string;
  /** 内存 store 尚未接真实库，默认如实标注 `stub`。 */
  executionMode?: ExecutionMode;
  idempotencyTtlSeconds?: number;
  /** 平台级作业端口；缺省 = **未接线**（fail-closed）。 */
  jobPort?: AdminJobPort;
  /** 社区帖子存储端口（`hidePost` 用）；缺省 = **未接线**（fail-closed）。 */
  community?: CommunityPostPort;
  /** flag 语义分类表；缺省为合同 3 键的"能力门"分类。构造时会自检不得放宽 fail-closed。 */
  flagEffects?: Readonly<Record<string, FlagEffect>>;
}

export interface AdminOpsService {
  readonly store: AdminOpsStore;
  readonly jobPort: AdminJobPort;
  /** 本片实现的 operationId 全集（应恰好 9 个）。 */
  readonly operationIds: readonly string[];

  listAdminCategories(ctx: AdminCallContext, query?: PageQuery): Promise<ServiceResponse<PageEnvelope<CategoryView>>>;
  editCategory(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<SingleEnvelope<CategoryView>>>;

  listAdminUsers(ctx: AdminCallContext, query?: PageQuery): Promise<ServiceResponse<PageEnvelope<AccountView>>>;
  suspendUser(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<SingleEnvelope<AccountView>>>;

  listAdminJobs(ctx: AdminCallContext, query?: PageQuery): Promise<ServiceResponse<PageEnvelope<AdminJobView>>>;
  cancelAdminJob(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<SingleEnvelope<AdminJobView>>>;

  listFlags(ctx: AdminCallContext, query?: PageQuery): Promise<ServiceResponse<PageEnvelope<{ key: string; enabled: boolean; revision: number }>>>;
  setFlag(ctx: AdminCallContext, key: string, body: unknown): Promise<ServiceResponse<SingleEnvelope<{ key: string; enabled: boolean; revision: number }>>>;

  hidePost(ctx: AdminCallContext, id: string, body: unknown): Promise<ServiceResponse<SingleEnvelope<{ accepted: boolean }>>>;
}

/** 本片 9 个 operationId（机读形式，供测试断言"恰好 9 个、不越界"）。 */
export const OPS_OPERATION_IDS: readonly string[] = Object.freeze([
  'listAdminCategories',
  'editCategory',
  'listAdminUsers',
  'suspendUser',
  'listAdminJobs',
  'cancelAdminJob',
  'listFlags',
  'setFlag',
  'hidePost',
]);

/** 契约 scope（来自 `packages/contracts/operations.json`）。 */
export const OPS_SCOPES = Object.freeze({
  listAdminCategories: 'sources:read',
  editCategory: 'sources:write',
  listAdminUsers: 'accounts:read',
  suspendUser: 'accounts:suspend',
  listAdminJobs: 'jobs:read',
  cancelAdminJob: 'jobs:cancel',
  listFlags: 'flags:read',
  setFlag: 'flags:write',
  hidePost: 'sources:write',
});

interface Identified {
  id: string;
}

/** 分页游标位置：分类/账号/作业用 `id`，开关用 `key`（契约里开关没有 id）。 */
type CursorKeyOf<T> = (item: T) => string;

export function createAdminOpsService(options: AdminOpsServiceOptions): AdminOpsService {
  // 构造期自检：语义分类表里不得存在任何"放宽 fail-closed"的条目（fail-closed at wiring time）。
  const flagEffects = options.flagEffects ?? DEFAULT_FLAG_EFFECTS;
  assertNoFlagWeakensFailClosed(flagEffects);

  const store = options.store ?? createAdminOpsStore({
    categorySeed: options.categorySeed,
    accountSeed: options.accountSeed,
  });
  const now = options.now ?? (() => new Date());
  const executionMode: ExecutionMode = options.executionMode ?? 'stub';
  const idempotencyTtlSeconds = options.idempotencyTtlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  const signingKey = options.signingKey;
  if (typeof signingKey !== 'string' || [...signingKey].length < 16) {
    throw new Error('后台运营服务需要至少 16 字符的签名密钥（只经内存传入，不入库）');
  }
  const cursors = createCursorCodec(signingKey);
  const jobPort: AdminJobPort = options.jobPort ?? createUnwiredAdminJobPort();
  const hideAdapter = createHidePostAdapter(options.community, now);

  const writeDeps = { runtime: store.runtime, signingKey, ttlSeconds: idempotencyTtlSeconds, now };

  // -------------------------------------------------------------------------
  // 审计（复用阶段 1 的只可追加台账）
  // -------------------------------------------------------------------------

  function appendAudit(
    context: ResolvedContext,
    entry: {
      action: string;
      scope: string;
      targetRef: TargetRefValue | null;
      targetHint: string | null;
      reasonCode: string;
      result: AuditResult;
    },
  ): void {
    store.audit.append({
      actorId: context.identity.userId,
      action: entry.action,
      scope: entry.scope,
      targetRef: entry.targetRef,
      targetHint: entry.targetHint,
      reasonCode: entry.reasonCode,
      requestId: context.requestId,
      result: entry.result,
      createdAt: now(),
    });
  }

  // -------------------------------------------------------------------------
  // 分页（复用同一套签名游标 + watermark 规则）
  // -------------------------------------------------------------------------

  function listWithCursor<T>(
    items: readonly T[],
    query: PageQuery,
    listKey: string,
    subject: string,
    keyOf: CursorKeyOf<T>,
  ): { page: T[]; nextCursor: string | null } {
    const limit = parseLimit(query.limit);
    const rawCursor = parseCursorParam(query.cursor);
    const ids = items.map((item) => keyOf(item));
    const watermark = cursors.watermarkOf(ids);

    let afterId: string | null = null;
    if (rawCursor !== null) {
      const payload = cursors.decode(rawCursor);
      if (payload.kind !== 'content' || payload.family !== listKey || payload.subject !== subject) {
        throw new ApiError('INVALID_CURSOR', '游标不属于当前查询');
      }
      if (payload.expires <= now().getTime()) throw new ApiError('INVALID_CURSOR', '游标已过期');
      if (payload.watermark !== watermark) throw new ApiError('INVALID_CURSOR', '集合已变化，请重新开始分页');
      afterId = payload.after;
    }

    let start = 0;
    if (afterId !== null) {
      const index = ids.indexOf(afterId);
      if (index < 0) throw new ApiError('INVALID_CURSOR', '游标位置已失效');
      start = index + 1;
    }
    const page = items.slice(start, start + limit);
    const hasMore = start + limit < items.length;
    const nextCursor = hasMore
      ? cursors.encode({
          kind: 'content',
          subject,
          family: listKey,
          after: page.length === 0 ? null : keyOf(page[page.length - 1] as T),
          watermark,
          expires: now().getTime() + 15 * 60 * 1000,
        })
      : null;
    return { page, nextCursor };
  }

  function pageOf<T>(
    context: ResolvedContext,
    items: readonly T[],
    query: PageQuery,
    listKey: string,
    keyOf: CursorKeyOf<T>,
  ): ServiceResponse<PageEnvelope<T>> {
    const { page, nextCursor } = listWithCursor(items, query, listKey, context.identity.userId, keyOf);
    // 出口深拷贝（阶段 1 的不可变边界）：存储侧对象已冻结，这里保证调用方拿到自有数据。
    return {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: { data: { items: cloneDeep(page) as T[], next_cursor: nextCursor }, meta: metaFor(context, executionMode) },
    };
  }

  /** 分类/账号/作业都以 `id` 作游标位置。 */
  const byId: CursorKeyOf<Identified> = (item) => item.id;

  // -------------------------------------------------------------------------
  // 分类
  // -------------------------------------------------------------------------

  async function listAdminCategories(ctx: AdminCallContext, query: PageQuery = {}) {
    const context = resolveContext(ctx, OPS_SCOPES.listAdminCategories);
    return pageOf(context, store.listCategories(), query, 'categories', byId);
  }

  async function editCategory(ctx: AdminCallContext, id: string, body: unknown) {
    const context = resolveContext(ctx, OPS_SCOPES.editCategory);
    const expectedRevision = parseIfMatchHeader(context.ifMatch);
    // 契约 `CategoryInput`：只允许改 name/description/active（没有 type，也没有删除）。
    opsValidator.assertInput('CategoryInput', body);
    const input = body as { name: string; description: string; active: boolean };
    const normalizedId = normalizeStringIdParam(id, 80);

    return runIdempotentWrite(
      writeDeps,
      context,
      { method: 'PATCH', path: `/admin/categories/${normalizedId}`, expectedStatus: 200 },
      body,
      () => {
        const current = store.getCategory(normalizedId);
        if (current === null) throw new ApiError('NOT_FOUND', '分类不存在');
        assertIfMatchMatches(expectedRevision, current.revision);
        const result = store.commitCategoryIfCurrent(normalizedId, expectedRevision, input);
        if (!result.ok) {
          throw result.reason === 'NOT_FOUND'
            ? new ApiError('NOT_FOUND', '分类不存在')
            : new ApiError('REVISION_CONFLICT', '目标修订已变化，If-Match 与当前 ETag 不匹配');
        }
        appendAudit(context, {
          action: 'category.update',
          scope: OPS_SCOPES.editCategory,
          // 契约 `TargetRef.type` 闭集里没有 category ⇒ 合同口径为 null，标识落在内部记录。
          targetRef: null,
          targetHint: `category:${normalizedId}`,
          reasonCode: 'category_updated',
          result: 'accepted',
        });
        return singleResponse(context, executionMode, 200, result.record, etagOf(result.record.revision));
      },
    );
  }

  // -------------------------------------------------------------------------
  // 账号
  // -------------------------------------------------------------------------

  async function listAdminUsers(ctx: AdminCallContext, query: PageQuery = {}) {
    const context = resolveContext(ctx, OPS_SCOPES.listAdminUsers);
    return pageOf(context, store.listAccounts(), query, 'accounts', byId);
  }

  async function suspendUser(ctx: AdminCallContext, id: string, body: unknown) {
    const context = resolveContext(ctx, OPS_SCOPES.suspendUser);
    const expectedRevision = parseIfMatchHeader(context.ifMatch);
    opsValidator.assertInput('ReasonInput', body);
    const normalizedId = normalizeIdParam(id);

    return runIdempotentWrite(
      writeDeps,
      context,
      { method: 'POST', path: `/admin/accounts/${normalizedId}/suspend`, expectedStatus: 200 },
      body,
      () => {
        const current = store.getAccount(normalizedId);
        if (current === null) throw new ApiError('NOT_FOUND', '账号不存在');
        assertIfMatchMatches(expectedRevision, current.revision);
        // 幂等：已停用 ⇒ 不再迁移、不再记审计。
        if (current.state === 'suspended') {
          return singleResponse(context, executionMode, 200, current, etagOf(current.revision));
        }
        // 注销在途的账号已经不可用；此时"停用"是状态回退，可能干扰注销流程 ⇒ 一律拒绝。
        if (current.state === 'deletion_pending') {
          throw new ApiError('OBJECT_UNAVAILABLE', '账号注销在途，不接受停用');
        }
        const result = store.commitAccountIfCurrent(normalizedId, expectedRevision, { state: 'suspended' });
        if (!result.ok) {
          throw result.reason === 'NOT_FOUND'
            ? new ApiError('NOT_FOUND', '账号不存在')
            : new ApiError('REVISION_CONFLICT', '目标修订已变化，If-Match 与当前 ETag 不匹配');
        }
        appendAudit(context, {
          action: 'account.suspend',
          scope: OPS_SCOPES.suspendUser,
          targetRef: null,
          targetHint: `account:${normalizedId}`,
          reasonCode: 'account_suspended',
          result: 'accepted',
        });
        return singleResponse(context, executionMode, 200, result.record, etagOf(result.record.revision));
      },
    );
  }

  // -------------------------------------------------------------------------
  // 作业（平台级端口；默认未接线 ⇒ fail-closed）
  // -------------------------------------------------------------------------

  function requireWiredJobPort(): void {
    if (!jobPort.wired) {
      // 不返回空页：空页会被读成"平台当前没有作业"，那是无法确认的结论（伪造）。
      throw new ApiError('PROVIDER_UNAVAILABLE', '平台级作业读/取消面尚未接线（等共享读面工单）', { retryable: true });
    }
  }

  /**
   * 端口回传**不可信**时的统一 fail-closed 错误。
   * 503 `PROVIDER_UNAVAILABLE`（契约闭集内的码），`retryable: true`：
   * 既可能是端口暂时行为异常，也可能是接线错误；一律**不登记成功、不写审计**。
   */
  function portIntegrityFailure(message: string): ApiError {
    return new ApiError('PROVIDER_UNAVAILABLE', message, { retryable: true });
  }

  /**
   * 端口返回的作业必须先过**契约镜像**：形状不对就拒绝投影（fail-closed），
   * 而不是把一条不完全/超范围的记录当作业状态发出去——那等于伪造平台状态。
   */
  function assertJobContract(job: unknown): AdminJobView {
    const issues = opsValidator.collectIssues('AdminJob', job);
    if (issues.length > 0) {
      throw portIntegrityFailure('平台级作业端口返回了不符合契约的记录，拒绝投影');
    }
    return job as AdminJobView;
  }

  async function listAdminJobs(ctx: AdminCallContext, query: PageQuery = {}) {
    const context = resolveContext(ctx, OPS_SCOPES.listAdminJobs);
    requireWiredJobPort();
    const jobs = (await jobPort.list()).map((job) => cloneDeep(assertJobContract(job)));
    return pageOf(context, jobs, query, 'jobs', byId);
  }

  async function cancelAdminJob(ctx: AdminCallContext, id: string, body: unknown) {
    const context = resolveContext(ctx, OPS_SCOPES.cancelAdminJob);
    const expectedRevision = parseIfMatchHeader(context.ifMatch);
    opsValidator.assertInput('ReasonInput', body);
    const normalizedId = normalizeIdParam(id);

    return runIdempotentWrite(
      writeDeps,
      context,
      { method: 'POST', path: `/admin/jobs/${normalizedId}/cancel`, expectedStatus: 200 },
      body,
      async () => {
        requireWiredJobPort();
        const rawJob = await jobPort.get(normalizedId);
        if (rawJob === null) throw new ApiError('NOT_FOUND', '作业不存在');
        const current = assertJobContract(rawJob);
        assertIfMatchMatches(expectedRevision, current.revision);
        // 幂等：已取消 ⇒ 不再迁移、不再记审计。
        if (current.state === 'cancelled') {
          return singleResponse(context, executionMode, 200, cloneDeep(current), etagOf(current.revision));
        }
        // 终态不可复活（succeeded/uncertain/failed/timed_out）。
        if (TERMINAL_JOB_STATES.includes(current.state as JobState)) {
          throw new ApiError('OBJECT_UNAVAILABLE', `作业已处于终态（${current.state}），不可取消`);
        }
        const outcome: CancelJobOutcome = await jobPort.cancel(normalizedId, current.revision);
        if (!outcome.ok) {
          switch (outcome.reason) {
            case 'NOT_FOUND':
              throw new ApiError('NOT_FOUND', '作业不存在');
            case 'TERMINAL':
              throw new ApiError('OBJECT_UNAVAILABLE', '作业已处于终态，不可取消');
            case 'PORT_UNAVAILABLE':
              throw new ApiError('PROVIDER_UNAVAILABLE', '平台级作业取消面尚未接线', { retryable: true });
            default:
              throw new ApiError('REVISION_CONFLICT', '作业修订已变化，If-Match 与当前 ETag 不匹配');
          }
        }

        // ------------------------------------------------------------------
        // **先证成、后产生副作用**（返修 1 / 监工 5492234991 P1）。
        //
        // 端口回传属于「外部输入」：在**写任何 accepted 审计、写入幂等台账之前**，
        // 必须先把整条结果验完。下面四条任一不成立即 fail-closed，
        // 且**不留任何部分副作用**（审计 0 条、幂等台账无已完成行，占位由外壳释放）。
        // ------------------------------------------------------------------

        // (1) 契约形状合法：整条记录过契约镜像（含 `kind` 等必填）。
        const cancelled = assertJobContract(cloneDeep(outcome.job));

        // (2) 同一性：回传的必须是**被请求取消的那一个作业**（不得是别的作业），
        //     且 `kind` 与 `target_ref` 未被偷换。
        if (cancelled.id !== normalizedId) {
          throw portIntegrityFailure('作业端口回传的目标不是被请求取消的作业，拒绝登记取消结果');
        }
        if (
          cancelled.kind !== current.kind ||
          cancelled.target_ref.type !== current.target_ref.type ||
          cancelled.target_ref.id !== current.target_ref.id ||
          cancelled.target_ref.revision !== current.target_ref.revision
        ) {
          throw portIntegrityFailure('作业端口回传的类型/目标与取消前不一致，拒绝登记取消结果');
        }

        // (3) 后置状态：必须**确实进入已取消态**（`states.json.job_transitions` 里
        //     `queued → cancelled`、`running → cancelled` 是唯一合法路径；
        //     回传仍为 `queued`/`running` 等未取消态，或别的终态 ⇒ 拒）。
        if (cancelled.state !== 'cancelled') {
          throw portIntegrityFailure(`作业端口回传的状态不是已取消（${cancelled.state}），拒绝登记取消结果`);
        }

        // (4) 版本迁移正确：一次取消 = 一次状态迁移 = 修订号**恰好递增 1**（不增或倒退 ⇒ 拒）。
        if (cancelled.revision !== current.revision + 1) {
          throw portIntegrityFailure('作业端口回传的修订号未正确递增（应为取消前修订号 +1），拒绝登记取消结果');
        }

        // ---- 校验全部通过，才登记成功：审计 + 幂等定型（要么全做，要么全不做）----
        appendAudit(context, {
          action: 'job.cancel',
          scope: OPS_SCOPES.cancelAdminJob,
          // 契约 `TargetRef.type` 闭集**有** job 成员 ⇒ 用合同口径，且带被取消的 revision。
          targetRef: { type: 'job', id: normalizedId, revision: current.revision },
          targetHint: null,
          reasonCode: 'job_cancelled',
          result: 'accepted',
        });
        return singleResponse(context, executionMode, 200, cancelled, etagOf(cancelled.revision));
      },
    );
  }

  // -------------------------------------------------------------------------
  // 功能开关
  // -------------------------------------------------------------------------

  async function listFlags(ctx: AdminCallContext, query: PageQuery = {}) {
    const context = resolveContext(ctx, OPS_SCOPES.listFlags);
    return pageOf(context, store.listFlags(), query, 'flags', (flag) => flag.key);
  }

  async function setFlag(ctx: AdminCallContext, key: string, body: unknown) {
    const context = resolveContext(ctx, OPS_SCOPES.setFlag);
    const expectedRevision = parseIfMatchHeader(context.ifMatch);
    opsValidator.assertInput('FlagInput', body);
    const input = body as { enabled: boolean; reason: string };

    // 守卫 1：安全语义保留名一律显式拒绝，并留一条 `denied` 审计（在消耗幂等键之前）。
    const verdict = classifyFlagKey(key);
    if (!verdict.ok) {
      if (verdict.kind === 'safety_critical') {
        appendAudit(context, {
          action: 'flag.set',
          scope: OPS_SCOPES.setFlag,
          targetRef: null,
          targetHint: `flag:${verdict.matched}`,
          reasonCode: 'flag_weakening_denied',
          result: 'denied',
        });
        throw new ApiError('INVALID_REQUEST', '该开关 key 具有削弱 fail-closed 的语义，本服务一律拒绝', {
          details: [{ field: 'key', code: 'SAFETY_CRITICAL_KEY' }],
        });
      }
      // 契约 `key` 是闭集枚举：闭集外的 key 一律 INVALID_REQUEST。
      throw new ApiError('INVALID_REQUEST', '开关 key 不在契约闭集内', {
        details: [{ field: 'key', code: 'ENUM' }],
      });
    }
    const flagKey: FlagKey = verdict.key;

    return runIdempotentWrite(
      writeDeps,
      context,
      { method: 'PUT', path: `/admin/feature-flags/${flagKey}`, expectedStatus: 200 },
      body,
      () => {
        const current = store.getFlag(flagKey);
        if (current === null) throw new ApiError('NOT_FOUND', '开关不存在');
        assertIfMatchMatches(expectedRevision, current.revision);
        // 幂等：值未变 ⇒ 不再迁移、不再记审计（与 public/withdraw 同口径）。
        if (current.enabled === input.enabled) {
          return singleResponse(context, executionMode, 200, current, etagOf(current.revision));
        }
        const result = store.commitFlagIfCurrent(flagKey, expectedRevision, { enabled: input.enabled });
        if (!result.ok) {
          throw result.reason === 'NOT_FOUND'
            ? new ApiError('NOT_FOUND', '开关不存在')
            : new ApiError('REVISION_CONFLICT', '目标修订已变化，If-Match 与当前 ETag 不匹配');
        }
        appendAudit(context, {
          action: 'flag.set',
          scope: OPS_SCOPES.setFlag,
          targetRef: null,
          targetHint: `flag:${flagKey}`,
          reasonCode: 'flag_set',
          result: 'accepted',
        });
        return singleResponse(context, executionMode, 200, result.record, etagOf(result.record.revision));
      },
    );
  }

  // -------------------------------------------------------------------------
  // 隐藏帖子（复用社区可见性语义）
  // -------------------------------------------------------------------------

  async function hidePost(ctx: AdminCallContext, id: string, body: unknown) {
    const context = resolveContext(ctx, OPS_SCOPES.hidePost);
    const expectedRevision = parseIfMatchHeader(context.ifMatch);
    opsValidator.assertInput('ReasonInput', body);
    const normalizedId = normalizeIdParam(id);

    return runIdempotentWrite(
      writeDeps,
      context,
      { method: 'POST', path: `/admin/posts/${normalizedId}/hide`, expectedStatus: 200 },
      body,
      async () => {
        const outcome = await hideAdapter.hide(normalizedId, expectedRevision);
        if (!outcome.ok) {
          switch (outcome.reason) {
            case 'NOT_FOUND':
              throw new ApiError('NOT_FOUND', '帖子不存在');
            case 'DELETED':
              // 已删除是不可复活的单向门：如实拒绝，绝不谎报成功。
              throw new ApiError('OBJECT_UNAVAILABLE', '帖子已删除，不可隐藏（已删除内容不复活）');
            case 'NOT_PUBLIC':
              throw new ApiError('OBJECT_UNAVAILABLE', '帖子当前不是已发布状态，无可撤回的公开可见性');
            case 'REVISION_CONFLICT':
              throw new ApiError('REVISION_CONFLICT', '帖子修订已变化，If-Match 与当前 ETag 不匹配');
            default:
              throw new ApiError('PROVIDER_UNAVAILABLE', '社区帖子存储尚未接线', { retryable: true });
          }
        }
        if (!outcome.changed) {
          // 幂等：已隐藏 ⇒ 不再迁移、不再记审计，返回契约 `Ack`。
          return singleResponse(context, executionMode, 200, { accepted: true }, etagOf(outcome.revision));
        }
        appendAudit(context, {
          action: 'post.hide',
          scope: OPS_SCOPES.hidePost,
          // 契约 `TargetRef.type` 闭集**有** post 成员 ⇒ 用合同口径，且带被隐藏的 revision。
          targetRef: { type: 'post', id: normalizedId, revision: outcome.previousRevision },
          targetHint: null,
          reasonCode: 'post_hidden',
          result: 'accepted',
        });
        return singleResponse(context, executionMode, 200, { accepted: true }, etagOf(outcome.revision));
      },
    );
  }

  return {
    store,
    jobPort,
    operationIds: OPS_OPERATION_IDS,

    listAdminCategories,
    editCategory,
    listAdminUsers,
    suspendUser,
    listAdminJobs,
    cancelAdminJob,
    listFlags,
    setFlag,
    hidePost,
  };
}

/** 供测试/装配读取：契约允许的 flag effect 分类（只读）。 */
export { DEFAULT_FLAG_EFFECTS };
