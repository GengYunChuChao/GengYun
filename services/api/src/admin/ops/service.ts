/**
 * GY-I18 阶段 1b · 后台运营与开关服务层（**恰好 12 个 operationId**）。
 * 第 10 个是本片新增的 `listFlagAuditEvents`（开关变更留痕 A→B，迁移 0027 提供读函数）。
 * 第 11、12 个是 `#18` S2 PR-2 新增的 `listAdministrators`（管理员目录）与
 * `listAdministratorScopes`（只读展示**他人**权限）；两者门都是 `scopes:read`，
 * 数据源是认证存储的既有窄读，见 `administrators.ts`。
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
 * 例外（GY-I22）：账号**停用**在注入 `accountAuthority`（`account-authority-pg.ts`）时走真实库的
 * 单事务路径，见 `suspendUser` 内的分支；未注入 ⇒ 与既有口径一致地 fail-closed。
 * 例外（GY-I18/T-R12-03）：账号**读面**在注入 `accountsDirectory`（`accounts-pg.ts`）时读真实
 * `public.users`，见 `listAdminUsers` 内的分支；未注入 ⇒ 与既有口径一致地 fail-closed。
 */
import { randomUUID } from 'node:crypto';
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
import { CONTRACT_FLAG_KEYS, classifyFlagKey, DEFAULT_FLAG_EFFECTS, assertNoFlagWeakensFailClosed } from './flags.ts';
import type { FlagEffect, FlagKey } from './flags.ts';
import { createUnwiredAdminJobPort, parseAdminJobFilter } from './jobs.ts';
import { createHidePostAdapter } from './community-posts.ts';
import type { AdminAccountAuthority } from './account-authority-pg.ts';
import type { AdminAccountsDirectory } from './accounts-pg.ts';
import type { AdminAdministratorsDirectory, AdministratorView } from './administrators.ts';
import { isAdminScope } from '../scopes.ts';
import { flagReadFailure, type FeatureFlagsPort, type FlagAuditRow } from './flags-pg.ts';
import { createAdminOpsStore } from './store.ts';
import type { AdminOpsStore } from './store.ts';
import type {
  AccountView,
  AdminJobPort,
  AdminJobView,
  CategoryView,
  CommunityPostPort,
  FlagView,
  JobState,
  CancelJobOutcome,
} from './types.ts';
import { TERMINAL_JOB_STATES } from './types.ts';
import { ACCOUNT_STATES } from './types.ts';

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
  /**
   * 仅 `listAdminJobs` 消费：契约 `listAdminJobs` 的 `state` 查询参数（闭集 `JobState`）。
   * HTTP 层只做"整包下传"，闭集判定与服务层一致地放在 `parseAdminJobFilter`（见 `jobs.ts`）。
   */
  state?: unknown;
  /** 仅 `listAdminJobs` 消费：契约 `listAdminJobs` 的 `error_code` 查询参数（闭集 `ErrorCode`）。 */
  error_code?: unknown;
}

export interface AdminOpsServiceOptions {
  /** 允许注入 store（测试用）；缺省用下面的种子新建内存 store。 */
  store?: AdminOpsStore;
  categorySeed?: readonly CategoryView[];
  /**
   * 账号权威种子（阶段 2 由 `users` 表注入）。**不给 = 账号面未接线** ⇒ `listAdminUsers` /
   * `suspendUser` 一律 503 `PROVIDER_UNAVAILABLE`、**`retryable: false`**（接线是运维动作，
   * 重试不可能成功）；不返回空页、不伪造"账号不存在"/成功。
   */
  accountSeed?: readonly AccountView[];
  /**
   * 真实账号写权威（GY-I22 接线）。给了它 ⇒ `suspendUser` 走**单事务**的真实路径
   * （`users.state` + `auth_epoch` + 会话撤销 + 审计四步原子）；保留在 `accountSeed` 之上，
   * 因为读面仍按「是否注入了真实目录」判定是否接线（见下一个字段）。
   */
  accountAuthority?: AdminAccountAuthority | null;
  /**
   * 真实账号读目录（GY-I18/T-R12-03 接线：`accounts-pg.ts` 读 `public.users`）。
   * 给了它 ⇒ `listAdminUsers` 读真实库后仍走既有 `pageOf()`（分页/游标/封套语义不变）；
   * 缺省/`null` ⇒ 维持内存种子路径（`requireWiredAccountAuthority()` + `store.listAccounts()`）。
   *
   * **残余限制（如实声明）**：真实目录是**一次全表读**（`ORDER BY created_at ASC, id ASC`），
   * 分页在服务层对内存数组切片，**不是** SQL 侧分页；账号规模上万时需要 keyset 分页（后续片）。
   */
  accountsDirectory?: AdminAccountsDirectory | null;
  /**
   * 管理员**目录与权限读面**（`#18` S2 PR-2 接线：`administrators.ts` 复用认证存储）。
   * 给了它 ⇒ `listAdministrators` 读真实 `admin_accounts`（`id` 是**管理员**账号 id）、
   * `listAdministratorScopes` 读真实 `admin_scopes`（只 `SELECT scope`），404/503 分明；
   * 缺省/`null` ⇒ 这两个操作**一律 503** `PROVIDER_UNAVAILABLE`（`retryable: false`），
   * ⛔ 不返回空数组/空页（空页会被读成"平台没有管理员"、空数组会被读成"这个人没有任何权限"，
   * 都是本进程无权下的伪造结论）。
   */
  administrators?: AdminAdministratorsDirectory | null;
  /**
   * 真实开关端口（GY-I18 接线，`flags-pg.ts`）。给了它 ⇒ `listFlags`/`setFlag` 的**读写都走库**：
   * 读面从 `public.feature_flags` 取三行（缺行/多行/闭集外 ⇒ 503 fail-closed，**不**返回三键全 false），
   * 写面经 `commitIfCurrent` 单事务 CAS + 审计。未给 ⇒ 与既有口径逐字一致地走内存 store
   * （既有单测/stub 行为不变）。
   */
  flagsPort?: FeatureFlagsPort | null;
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
  /** 账号面是否已接线到认证权威（`false` ⇒ 账号读/写面 503 fail-closed）；供测试与接线回归直接核对。 */
  readonly accountsWired: boolean;
  /** 本片实现的 operationId 全集（应恰好 11 个）。 */
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

  /**
   * 开关变更留痕（GY-I18 第一批 + 迁移 0027）：`GET /admin/flag-audit-events`。
   * 未接线 ⇒ 503 `PROVIDER_UNAVAILABLE`（`retryable: false`），**不返回空页**。
   */
  listFlagAuditEvents(ctx: AdminCallContext, query?: PageQuery): Promise<ServiceResponse<PageEnvelope<FlagAuditRow>>>;

  /**
   * 管理员目录（`#18` S2 PR-2）：`GET /admin/administrators`。
   *
   * 存在的理由不是"列表好看"，而是**写面需要 `admin_accounts.id`**：既有 `GET /admin/accounts`
   * 读的是 `public.users`（`0021_admin_accounts_read.sql`），给不出管理员账号 id，
   * 授权端点 `.../administrators/:id/scopes` 的目标就无从取得。故本列表的 `id` **必须**是
   * `admin_accounts.id`，与 `users.id` 同名不同源。
   *
   * 每项 `{id, login_name, state, scopes}`；未接线 ⇒ 503（**不返回空页**）。
   */
  listAdministrators(ctx: AdminCallContext, query?: PageQuery): Promise<ServiceResponse<PageEnvelope<AdministratorView>>>;

  /**
   * 管理员权限读面（`#18` S2 PR-2）：`GET /admin/administrators/:id/scopes`。
   *
   * - 返回体**只含 scope 字符串数组**（`data.scopes`），⛔ 无 `granted_by`/`granted_at`（见
   *   `administrators.ts` 的授权面说明），也**不发 ETag**（权限集合无独立修订号）；
   * - 目标不存在 ⇒ `NOT_FOUND`(404)；读面未接线 ⇒ `PROVIDER_UNAVAILABLE`(503, `retryable: false`)；
   * - 门是 `scopes:read`，⛔ 与 `accounts:read` 无关（裁定④）；自查继续走会话接口。
   */
  listAdministratorScopes(ctx: AdminCallContext, id: string): Promise<ServiceResponse<SingleEnvelope<{ scopes: string[] }>>>;
}

/** 本片 operationId（机读形式，供测试断言"恰好 12 个、不越界"）。 */
export const OPS_OPERATION_IDS: readonly string[] = Object.freeze([
  'listAdminCategories',
  'editCategory',
  'listAdminUsers',
  'suspendUser',
  'listAdminJobs',
  'cancelAdminJob',
  'listFlags',
  'setFlag',
  'listFlagAuditEvents',
  'hidePost',
  'listAdministrators',
  'listAdministratorScopes',
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
  listFlagAuditEvents: 'flags:read',
  hidePost: 'sources:write',
  // `#18` S2 PR-2：读他人权限。⛔ 不是 `accounts:read`（裁定④：两者是不同能力）。
  listAdministrators: 'scopes:read',
  listAdministratorScopes: 'scopes:read',
});

interface Identified {
  id: string;
}

/** 分页游标位置：分类/账号/作业用 `id`，开关用 `key`（契约里开关没有 id）。 */
type CursorKeyOf<T> = (item: T) => string;

/**
 * 开关变更留痕的键集游标参数。
 *
 * - `family` 固定 `flag_audit`，与内容审计流（`listWithCursor` 的 `audit` 家族）分开：
 *   两个读面的分页位置**没有可比性**，混用会让"下一页"指向另一条流；
 * - `watermark` 取常量而不是"当前集合指纹"：键集位置 `(created_at, id)` 本身是全序，
 *   新行插在最前面不会让位置失效（这正是键集分页相对 offset 的意义）；
 *   填常量是为了让 `CursorPayload` 的必填位有真实值，而不是伪造一个会漂移的指纹。
 */
const FLAG_AUDIT_FAMILY = 'flag_audit';
const FLAG_AUDIT_WATERMARK = 'flag_audit:keyset';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `created_at|id` 复合位置解析；不可解析一律 `INVALID_CURSOR`（不把脏串传给 SQL 的 cast）。 */
function decodeFlagAuditPosition(after: string | null): { createdAt: string; id: string } {
  if (after === null) throw new ApiError('INVALID_CURSOR', '游标缺少位置');
  const separator = after.lastIndexOf('|');
  if (separator <= 0) throw new ApiError('INVALID_CURSOR', '游标位置不可解析');
  const createdAt = after.slice(0, separator);
  const id = after.slice(separator + 1);
  if (!UUID_PATTERN.test(id) || Number.isNaN(Date.parse(createdAt))) {
    throw new ApiError('INVALID_CURSOR', '游标位置不可解析');
  }
  return { createdAt, id };
}

export function createAdminOpsService(options: AdminOpsServiceOptions): AdminOpsService {
  // 构造期自检：语义分类表里不得存在任何"放宽 fail-closed"的条目（fail-closed at wiring time）。
  const flagEffects = options.flagEffects ?? DEFAULT_FLAG_EFFECTS;
  assertNoFlagWeakensFailClosed(flagEffects);

  const store = options.store ?? createAdminOpsStore({
    categorySeed: options.categorySeed,
    accountSeed: options.accountSeed,
  });
  const accountAuthority: AdminAccountAuthority | null = options.accountAuthority ?? null;
  // 真实账号读目录（GY-I18/T-R12-03）：未注入/显式 null ⇒ 读面维持内存种子 + 既有 fail-closed。
  // 判据是**能力对象存在**（`app.ts` 只在真的构造出 `createPostgresAccountsDirectory()` 时传），
  // ⛔ 不读任何自述持久化布尔标志。
  const accountsDirectory: AdminAccountsDirectory | null = options.accountsDirectory ?? null;
  // 管理员目录/权限读面（`#18` S2 PR-2）：判据同样是**能力对象存在**（`app.ts` 只在真的构造出
  // `createAuthStoreAdministratorsDirectory()` 时传），⛔ 不读任何自述持久化布尔标志。
  const administrators: AdminAdministratorsDirectory | null = options.administrators ?? null;
  const flagsPort: FeatureFlagsPort | null = options.flagsPort ?? null;
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
    /**
     * 绑进游标 watermark 的**筛选组合**（先于 id 列表参与签名）。
     * 缺省 `[]` ⇒ 与不传过滤时的既有行为逐字相同（签名输入不变）。
     * 理由见 `admin/audit/service.ts:28`：换了筛选就必须回第一页，否则游标
     * 会把"上一组筛选里的最后一条 id"当成这组里的位置。
     */
    watermarkParts: readonly string[] = [],
  ): { page: T[]; nextCursor: string | null } {
    const limit = parseLimit(query.limit);
    const rawCursor = parseCursorParam(query.cursor);
    const ids = items.map((item) => keyOf(item));
    const watermark = cursors.watermarkOf([...watermarkParts, ...ids]);

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
    watermarkParts: readonly string[] = [],
  ): ServiceResponse<PageEnvelope<T>> {
    const { page, nextCursor } = listWithCursor(
      items,
      query,
      listKey,
      context.identity.userId,
      keyOf,
      watermarkParts,
    );
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
  // 账号（认证权威；未接线 ⇒ fail-closed）
  // -------------------------------------------------------------------------

  /**
   * 账号面**没有认证权威**时的统一 fail-closed（形态照作业面 `requireWiredJobPort`；
   * 但 `retryable` 按裁定取 `false`，见下）：
   * 503 `PROVIDER_UNAVAILABLE`（契约闭集内的码）且 **`retryable: false`** —— "能力未接线"是**运维动作**，
   * 同一请求在无运维介入下稍后重试**不可能**成功，故不得宣称可重试
   * （口径来源：指挥裁定 `STATE-current.md` §40；作业面旧形态的 `retryable: true` 由统一口径片改，本片不代改）：
   * - **不返回空页**：空页会被读成"平台当前没有账号"，那是无法确认的结论（伪造）；
   * - **不返回 404**：账号在不在，本进程根本无权回答，报"账号不存在"就是伪造否定；
   * - **不写审计、不迁移状态、不占幂等键**：本片把判断放在写外壳**之前**，故连占位都不会发生。
   *
   * 接线口径：`accountsWired` 由 store 在构造时定（今天唯一形态 = 注入了账号种子）；
   * 注入了真实目录（`accountsDirectory`）时读面**不经过**本函数——真实性由能力对象本身保证，
   * 此时本函数只守「降级到内存种子」的那条路径（两条件互斥，不会出现双路径任选其一）。
   */
  function requireWiredAccountAuthority(): void {
    if (!store.accountsWired) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '账号读/停用面尚未接线到认证权威', { retryable: false });
    }
  }

  /**
   * 真实目录是**注入的能力**而不是类型保证：出口逐行核对契约闭集。
   * 一条越界（如 `'banned'`）就让整页失败 ⇒ 503，⛔ 不静默折叠成 `active`、⛔ 不丢弃该行
   * （丢弃会让「有账号但状态未知」被读成「平台没有这个账号」）。
   */
  function assertAccountsInContract(items: readonly AccountView[]): void {
    for (const item of items) {
      if (!(ACCOUNT_STATES as readonly string[]).includes(item.state)) {
        throw new ApiError(
          'PROVIDER_UNAVAILABLE',
          `账号读面返回的 state 不在契约闭集内：${String(item.state)}`,
          { retryable: false },
        );
      }
      if (typeof item.display_name !== 'string' || item.display_name.length === 0) {
        throw new ApiError('PROVIDER_UNAVAILABLE', '账号读面返回的 display_name 为空', { retryable: false });
      }
    }
  }

  async function listAdminUsers(ctx: AdminCallContext, query: PageQuery = {}) {
    const context = resolveContext(ctx, OPS_SCOPES.listAdminUsers);
    if (accountsDirectory !== null) {
      // 真实目录（迁移 0021 的 `public.list_admin_accounts()`）：分页/游标/封套语义仍走**同一套**
      // `pageOf()`，本分支只替换数据来源。残余限制：一次全表读，无 SQL 侧分页（见选项注释）。
      const items = await accountsDirectory.list();
      assertAccountsInContract(items);
      return pageOf(context, items, query, 'accounts', byId);
    }
    requireWiredAccountAuthority();
    return pageOf(context, store.listAccounts(), query, 'accounts', byId);
  }

  /**
   * 出口守卫：库层读回来的 scope 必须落在**应用层闭集**内（`admin/scopes.ts` 的 `ADMIN_SCOPES`）。
   *
   * 一条越界（历史遗留值、手改过的行、或未来迁移先落地而应用层没跟上）就让整条读面 503：
   * ⛔ 不静默丢弃该条（丢弃会让"权限不明"被读成"没有这项权限"）、
   * ⛔ 不原样照抄给调用方（照抄会让契约 enum 被库里的脏值突破）。
   * 形态与 `assertAccountsInContract()` 同口径：注入的是**能力对象**，出口要自己守。
   */
  function assertScopesInClosedSet(scopes: readonly string[]): void {
    for (const scope of scopes) {
      if (!isAdminScope(scope)) {
        throw new ApiError(
          'PROVIDER_UNAVAILABLE',
          `管理员权限读面返回的 scope 不在闭集内：${String(scope)}`,
          { retryable: false },
        );
      }
    }
  }

  /**
   * 规范化输出：去重 + 码元序（与 `sessionInfo()` 对会话 scope 的口径**逐字相同**），
   * 使"自查接口"与"查他人接口"对同一集合给出同一个数组，而不是按存储插入序漂移。
   */
  function normalizeScopes(scopes: readonly string[]): string[] {
    assertScopesInClosedSet(scopes);
    return [...new Set(scopes)].sort();
  }

  /** `admin_state` 库层闭集（`0001_initial_schema.sql:16`）；契约枚举照此声明，越界即 503。 */
  const ADMIN_STATES: readonly string[] = Object.freeze(['active', 'suspended']);

  /**
   * 出口守卫（管理员目录）：`admin_state` 库层只有两个成员（`0001_initial_schema.sql:16`
   * `CREATE TYPE admin_state AS ENUM ('active','suspended')`），契约照库层声明 ⇒ 越界即 503，
   * ⛔ 不折叠成 `active`、⛔ 不丢行（丢行会把"有管理员但状态未知"读成"平台没有管理员"）。
   */
  function assertAdministratorsInContract(items: readonly AdministratorView[]): void {
    for (const item of items) {
      if (!ADMIN_STATES.includes(item.state)) {
        throw new ApiError(
          'PROVIDER_UNAVAILABLE',
          `管理员目录返回的 state 不在契约闭集内：${String(item.state)}`,
          { retryable: false },
        );
      }
      if (typeof item.login_name !== 'string' || item.login_name.length === 0) {
        throw new ApiError('PROVIDER_UNAVAILABLE', '管理员目录返回的 login_name 为空', { retryable: false });
      }
    }
  }

  /**
   * 管理员目录（`#18` S2 PR-2）：`GET /admin/administrators`。
   *
   * 为什么不复用 `listAdminUsers`：那个面读 `public.users`（终端用户），`id` 是 `users.id`；
   * 授权端点的目标只能来自 `admin_accounts.id`，两者同名不同源。混用会把"给某终端用户授权"
   * 当成合法请求发出去（裁定③明令禁止）。
   *
   * 残余限制（如实声明）：目录一次全表读 `admin_accounts`，再逐个 `listAdminScopes`（1+N 条
   * 窄查询）；管理员是受控初始化的少量账号，分页在服务层对数组切片，**不是** SQL 侧分页。
   */
  async function listAdministrators(ctx: AdminCallContext, query: PageQuery = {}) {
    const context = resolveContext(ctx, OPS_SCOPES.listAdministrators);
    if (administrators === null) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '管理员目录尚未接线到认证权威', { retryable: false });
    }
    const items = await administrators.list();
    assertAdministratorsInContract(items);
    const normalized = items.map((item) => ({ ...item, scopes: normalizeScopes(item.scopes) }));
    return pageOf(context, normalized, query, 'administrators', byId);
  }

  /**
   * 管理员权限**读面**（`#18` S2 PR-2）：`GET /admin/administrators/:id/scopes`。
   *
   * 与 `listAdminUsers` 的分工：那个面读**终端用户**（`public.users`，路径 `/admin/accounts`），
   * 本面读**后台管理员**（`admin_accounts` + `admin_scopes`，路径 `/admin/administrators`）。
   * 裁定③明令两者的 id 不得混用，故不复用 `/admin/accounts/{id}` 的形状。
   *
   * 门是 `scopes:read`，⛔ **不是** `accounts:read`（裁定④：持 `accounts:read` 不自动获得查看
   * 他人权限的能力）。自查继续走会话接口（`GET /admin/auth/session`），本片不另造。
   *
   * 顺序（与 `suspendUser` 的既有口径一致："形态校验先于接线状态"）：
   *   `resolveContext`（401/400/403）→ `normalizeIdParam`（400）→ 未接线 503 → 读（404/200）。
   * 校验放前面，是为了让"非法 id"在运维未接线时仍然报 400，而不是被 503 顶掉。
   *
   * 响应**不发 ETag**：`admin_scopes` 没有自己的修订号，`admin_accounts.revision` 涨落只代表
   * 账号行（state/auth_epoch）变过，拿它当权限集合的强 ETag 会把"账号行没变"说成"权限集合没变"。
   */
  async function listAdministratorScopes(ctx: AdminCallContext, id: string) {
    const context = resolveContext(ctx, OPS_SCOPES.listAdministratorScopes);
    const normalizedId = normalizeIdParam(id);
    if (administrators === null) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '管理员权限读面尚未接线到认证权威', { retryable: false });
    }
    const snapshot = await administrators.read(normalizedId);
    if (snapshot === null) {
      // 存在性由 `getAdmin()` 判定（内存 store 的 `listAdminScopes` 对未知 id 返回 `[]`，
      // 拿它判存在会把"没有这个管理员"读成"这个人没有任何权限"）。
      throw new ApiError('NOT_FOUND', '管理员不存在');
    }
    return singleResponse(context, executionMode, 200, { scopes: normalizeScopes(snapshot.scopes) }, null);
  }

  async function suspendUser(ctx: AdminCallContext, id: string, body: unknown) {
    const context = resolveContext(ctx, OPS_SCOPES.suspendUser);
    const expectedRevision = parseIfMatchHeader(context.ifMatch);
    opsValidator.assertInput('ReasonInput', body);
    const normalizedId = normalizeIdParam(id);
    // 在**任何**副作用之前（含写外壳的幂等占位）：既无真实权威、也无内存种子 ⇒ 一律 503。
    // 有真实权威时不再要求种子（写面真实性不依赖读面是否接线），读面由 `listAdminUsers` 自己守。
    if (accountAuthority === null && !store.accountsWired) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '账号停用面尚未接线到认证权威', { retryable: false });
    }

    return runIdempotentWrite(
      writeDeps,
      context,
      { method: 'POST', path: `/admin/accounts/${normalizedId}/suspend`, expectedStatus: 200 },
      body,
      async () => {
        if (accountAuthority !== null) {
          // 真实路径（GY-I22）：四步（state / auth_epoch / 撤会话 / 审计）在 `suspend_account()`
          // 内部由 PostgreSQL **同一事务**完成，任一步失败整笔回滚，本层不可能写出半成品。
          // 幂等与状态守卫由函数按当前行判定（已停用 ⇒ `changed=false`，不写审计、不递增 epoch、
          // 不撤会话），因此这里**不先读库**：读后写会把并发重复停用放大成两笔审计。
          const outcome = await accountAuthority.suspend({
            actorId: context.identity.userId,
            auditId: randomUUID(),
            userId: normalizedId,
            expectedRevision,
            requestId: context.requestId,
          });
          return singleResponse(context, executionMode, 200, outcome.account, etagOf(outcome.account.revision));
        }
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
      // 未接线／端口回传不可信 ⇒ 同一请求重试不会成功：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
      throw new ApiError('PROVIDER_UNAVAILABLE', '平台级作业读/取消面尚未接线（等共享读面工单）', { retryable: false });
    }
  }

  /**
   * 端口回传**不可信**时的统一 fail-closed 错误。
   * 503 `PROVIDER_UNAVAILABLE`（契约闭集内的码），`retryable: false`：
   * 既可能是端口暂时行为异常，也可能是接线错误；一律**不登记成功、不写审计**。
   */
  function portIntegrityFailure(message: string): ApiError {
    // 未接线／端口回传不可信 ⇒ 同一请求重试不会成功：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
    return new ApiError('PROVIDER_UNAVAILABLE', message, { retryable: false });
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

  /**
   * `listAdminJobs`：服务端过滤 + 服务端分页。
   *
   * 顺序（与 `admin/audit/service.ts` 一致）：鉴权/权限（401/403）→ 端口接线（503）→ **入参闭集（400）**。
   * 未接线优先于入参非法：端口没接线时"这个状态有没有作业"本来就无法回答，先给 503 才是如实。
   *
   * 过滤**下推到端口**（真实现是 SQL `WHERE`），⛔ 不在这一层把全量拉回来再筛：
   * 那样 200 条的硬上限会把匹配项挤掉，等于"过滤后仍看不到"。
   */
  async function listAdminJobs(ctx: AdminCallContext, query: PageQuery = {}) {
    const context = resolveContext(ctx, OPS_SCOPES.listAdminJobs);
    requireWiredJobPort();
    const filter = parseAdminJobFilter(query);
    const jobs = (await jobPort.list(filter)).map((job) => cloneDeep(assertJobContract(job)));
    return pageOf(context, jobs, query, 'jobs', byId, jobFilterWatermarkParts(filter));
  }

  /**
   * 筛选组合 → 游标 watermark 的前缀部分。
   * 不过滤时返回 `[]`（签名输入与改动前逐字相同，既有游标继续有效）；
   * 一旦带过滤，换任何一组筛选条件都会让旧游标 `INVALID_CURSOR`（回第一页），
   * 而不是把上一组筛选的位置错套到这一组上。
   */
  function jobFilterWatermarkParts(filter: ReturnType<typeof parseAdminJobFilter>): string[] {
    const parts: string[] = [];
    if (filter.state !== undefined) parts.push(`state=${filter.state}`);
    if (filter.error_code !== undefined) parts.push(`error_code=${filter.error_code}`);
    return parts;
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
              // 未接线／端口回传不可信 ⇒ 同一请求重试不会成功：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
              throw new ApiError('PROVIDER_UNAVAILABLE', '平台级作业取消面尚未接线', { retryable: false });
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

  /** 端口读失败 ⇒ 503。可重试性只认 `flags-pg.ts` 的 `flagReadFailure`（无法归类 ⇒ 不可重试，原始 code 进 `details`）。 */
  function throwFlagReadFailure(error: unknown): never {
    if (error instanceof ApiError) throw error;
    throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关读取暂不可用', flagReadFailure(error));
  }

  /** 库内数据与契约闭集不一致 ⇒ **失败关闭**（`unrecognized`），⛔ 不许伪造成「三键全 false」。 */
  function flagShapeFailure(message: string): never {
    throw new ApiError('PROVIDER_UNAVAILABLE', message, {
      retryable: false,
      details: [{ field: 'flags', code: 'FLAG_UNRECOGNIZED' }],
    });
  }

  /** 单行定义域校验：只认三个契约键、`enabled` 布尔、`revision` 正整数。 */
  function acceptFlagRow(row: unknown): FlagView {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      flagShapeFailure('全局开关行不是对象');
    }
    const record = row as Partial<FlagView>;
    const key = record.key;
    if (typeof key !== 'string' || !(CONTRACT_FLAG_KEYS as readonly string[]).includes(key)) {
      flagShapeFailure('全局开关行含契约闭集外的 key');
    }
    if (typeof record.enabled !== 'boolean') {
      flagShapeFailure(`全局开关 ${key} 的 enabled 不是布尔`);
    }
    const revision = record.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
      flagShapeFailure(`全局开关 ${key} 的 revision 不是正整数`);
    }
    return { key: key as FlagKey, enabled: record.enabled, revision };
  }

  /**
   * 读面：从库读三行并按契约声明序（`CONTRACT_FLAG_KEYS`）返回。
   * 缺任何一键都**失败关闭** —— 缺行不等于「关」，更不等于「开」；也不返回三键全 false 的假封套。
   */
  async function readFlagsFromPort(port: FeatureFlagsPort): Promise<readonly FlagView[]> {
    let rows: unknown;
    try {
      rows = await port.list();
    } catch (error) {
      throwFlagReadFailure(error);
    }
    if (!Array.isArray(rows)) flagShapeFailure('全局开关读取返回不是数组');
    const byKey = new Map<string, FlagView>();
    for (const raw of rows) {
      const row = acceptFlagRow(raw);
      if (byKey.has(row.key)) flagShapeFailure(`全局开关 ${row.key} 出现重复行`);
      byKey.set(row.key, row);
    }
    if (byKey.size !== CONTRACT_FLAG_KEYS.length) {
      flagShapeFailure('全局开关行数与契约闭集不一致');
    }
    return CONTRACT_FLAG_KEYS.map((key) => {
      const row = byKey.get(key);
      if (row === undefined) flagShapeFailure(`全局开关缺少契约键 ${key}`);
      return row;
    });
  }

  /** 写面前置读：单行不存在 ⇒ `null`（调用方据此 404），形状不符 ⇒ 503 fail-closed。 */
  async function readFlagFromPort(port: FeatureFlagsPort, key: FlagKey): Promise<FlagView | null> {
    let row: unknown;
    try {
      row = await port.get(key);
    } catch (error) {
      throwFlagReadFailure(error);
    }
    if (row === null) return null;
    return acceptFlagRow(row);
  }

  /** 写面：端口内部已完成 CAS + 审计；这里只把非 ApiError 的异常如实变成 503（不可重试）。 */
  async function commitFlagToPort(
    port: FeatureFlagsPort,
    key: FlagKey,
    expectedRevision: number,
    enabled: boolean,
    reason: string | null,
    context: ResolvedContext,
  ): Promise<{ ok: true; record: FlagView } | { ok: false; reason: string }> {
    try {
      return await port.commitIfCurrent(
        key,
        expectedRevision,
        { enabled },
        { changedBy: context.identity.userId, reason, requestId: context.requestId },
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关写入暂不可用', { retryable: false });
    }
  }

  async function listFlags(ctx: AdminCallContext, query: PageQuery = {}) {
    const context = resolveContext(ctx, OPS_SCOPES.listFlags);
    const flags = flagsPort === null ? store.listFlags() : await readFlagsFromPort(flagsPort);
    return pageOf(context, flags, query, 'flags', (flag) => flag.key);
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
      async () => {
        // 有端口 ⇒ 读/写都走库；无端口 ⇒ 与既有内存 store 路径逐字一致（单测/stub 不变）。
        const current = flagsPort === null
          ? store.getFlag(flagKey)
          : await readFlagFromPort(flagsPort, flagKey);
        if (current === null) throw new ApiError('NOT_FOUND', '开关不存在');
        assertIfMatchMatches(expectedRevision, current.revision);
        // 幂等：值未变 ⇒ 不再迁移、不再记审计（与 public/withdraw 同口径）。
        if (current.enabled === input.enabled) {
          return singleResponse(context, executionMode, 200, current, etagOf(current.revision));
        }
        const result = flagsPort === null
          ? store.commitFlagIfCurrent(flagKey, expectedRevision, { enabled: input.enabled })
          : await commitFlagToPort(flagsPort, flagKey, expectedRevision, input.enabled, input.reason, context);
        if (!result.ok) {
          throw result.reason === 'NOT_FOUND'
            ? new ApiError('NOT_FOUND', '开关不存在')
            : new ApiError('REVISION_CONFLICT', '目标修订已变化，If-Match 与当前 ETag 不匹配');
        }
        // 内存台账照旧记一行（既有单测与审计读面依赖这个入口）；库内审计由端口在**同事务**写入，
        // 两者文本不同源：库里是裁定 §3 的 `set_flag`/`flags:write`/`<flag key>`，这里保持既有口径。
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
  // 开关变更留痕（审计 A→B 可查；迁移 0027）
  // -------------------------------------------------------------------------

  /**
   * 读面：`GET /admin/flag-audit-events`。
   *
   * 为什么单独一个 operationId（而不是复用 `listAuditEvents`）：
   * - `listAuditEvents` 属于阶段 1，读的是**内容内存 store 的审计流**（`app.ts` 已写明这条边界），
   *   本片不能把它改成"有时读库、有时读内存"的双源分页——那会让分页位置失去单一含义；
   * - 开关审计是库内同事务写入的（`set_feature_flag` + 迁移 0027 的 `before_value/after_value`），
   *   库才是唯一权威；用独立读面保持"谁是权威"这件事在 URL 上一目了然。
   *
   * 分页：键集 `(created_at DESC, id DESC)`，游标里存 `created_at|id`，
   * 不返回 `COUNT(*)`（快照统计会让翻页结果与总数互相打脸）。
   */
  async function listFlagAuditEvents(ctx: AdminCallContext, query: PageQuery = {}) {
    const context = resolveContext(ctx, OPS_SCOPES.listFlagAuditEvents);
    const port = flagsPort;
    if (port === null || typeof port.listAudit !== 'function') {
      // 未接线 ≠ 没有变更历史：空页会被读成「平台从未改过开关」，那是无法确认的结论（伪造）。
      throw new ApiError('PROVIDER_UNAVAILABLE', '开关变更留痕读取尚未接线', { retryable: false });
    }
    const limit = parseLimit(query.limit);
    const rawCursor = parseCursorParam(query.cursor);
    let before: { createdAt: string; id: string } | null = null;
    if (rawCursor !== null) {
      const payload = cursors.decode(rawCursor);
      if (
        payload.kind !== 'audit' ||
        payload.family !== FLAG_AUDIT_FAMILY ||
        payload.subject !== context.identity.userId
      ) {
        throw new ApiError('INVALID_CURSOR', '游标不属于当前查询');
      }
      if (payload.expires <= now().getTime()) throw new ApiError('INVALID_CURSOR', '游标已过期');
      before = decodeFlagAuditPosition(payload.after);
    }
    const page = await port.listAudit({ limit, before });
    const items = page.items.map((row) => {
      // 出口必须过契约镜像：库里的行不是"信任边界内"的数据（jsonb 可能被手工改过）。
      const issues = opsValidator.collectIssues('AuditEvent', row);
      if (issues.length > 0) {
        throw new ApiError('PROVIDER_UNAVAILABLE', '开关变更留痕返回不符合契约 AuditEvent', {
          retryable: false,
          details: issues.slice(0, 5),
        });
      }
      return row;
    });
    const last = page.items[page.items.length - 1];
    const nextCursor =
      page.hasMore && last !== undefined
        ? cursors.encode({
            kind: 'audit',
            subject: context.identity.userId,
            family: FLAG_AUDIT_FAMILY,
            after: `${last.created_at}|${last.id}`,
            watermark: FLAG_AUDIT_WATERMARK,
            expires: now().getTime() + 15 * 60 * 1000,
          })
        : null;
    return {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: {
        data: { items: cloneDeep(items) as FlagAuditRow[], next_cursor: nextCursor },
        meta: metaFor(context, executionMode),
      },
    };
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
              // 未接线／端口回传不可信 ⇒ 同一请求重试不会成功：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
              throw new ApiError('PROVIDER_UNAVAILABLE', '社区帖子存储尚未接线', { retryable: false });
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
    accountsWired: store.accountsWired,
    operationIds: OPS_OPERATION_IDS,

    listAdminCategories,
    editCategory,
    listAdminUsers,
    suspendUser,
    listAdminJobs,
    cancelAdminJob,
    listFlags,
    setFlag,
    listFlagAuditEvents,
    hidePost,
    listAdministrators,
    listAdministratorScopes,
  };
}

/** 供测试/装配读取：契约允许的 flag effect 分类（只读）。 */
export { DEFAULT_FLAG_EFFECTS };
