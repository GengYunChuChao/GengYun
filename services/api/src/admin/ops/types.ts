/**
 * GY-I18 阶段 1b · 后台运营与开关（服务层）类型。
 *
 * 形状来源：`packages/contracts/openapi.json`（契约 1.0.0），**只读消费、不修改契约**。
 * 本片实现 9 个 operationId：`listAdminCategories`/`editCategory`、
 * `listAdminUsers`/`suspendUser`、`listAdminJobs`/`cancelAdminJob`、
 * `listFlags`/`setFlag`、`hidePost`。
 *
 * 边界（如实声明）：
 * - **不注册任何 HTTP 路由**、不改 `app.ts`、不改 `apps/admin/**`、不改小程序；
 * - 内存 store（`execution_mode: 'stub'`），**未接真实 PostgreSQL**；
 * - **不做**后台鉴权三项（已在 main 的 `routes/admin-auth.ts` + `auth/service.ts` 实现）、
 *   公开 `GET /knowledge*`（属 #7 线）、`/community/media*`。
 */
import type { TargetRefValue } from '../types.ts';
import type { CommunityStore } from '../../community/store.ts';
import type { ErrorCode } from '../../contract.ts';

/** 契约 `Category.type` 闭集。 */
export const CATEGORY_TYPES = ['crop', 'species'] as const;
export type CategoryType = (typeof CATEGORY_TYPES)[number];

/** 契约 `AdminAccountView.state` 闭集。 */
export const ACCOUNT_STATES = ['active', 'suspended', 'deletion_pending'] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

/** 契约 `JobState` 闭集（与 `packages/contracts/states.json` 一致）。 */
export const JOB_STATES = ['queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];

/**
 * **终态**作业集合：`states.json.job_transitions` 里这 6 个状态的出边为空 ⇒ 不可再迁移。
 * 取消只允许从 `queued` / `running` 出发；对终态一律拒绝（**不复活**）。
 */
export const TERMINAL_JOB_STATES: readonly JobState[] = Object.freeze([
  'succeeded',
  'uncertain',
  'failed',
  'timed_out',
  'cancelled',
]);

/** 契约 `AdminJob.kind` 闭集。 */
export const JOB_KINDS = ['recognition', 'ocr', 'transcription', 'answer', 'synthesis', 'moderation'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** 契约 `Category`（`additionalProperties:false`）。 */
export interface CategoryView {
  id: string;
  revision: number;
  type: CategoryType;
  name: string;
  description: string;
  active: boolean;
}

/** 契约 `CategoryInput`（`type` 不在输入里 ⇒ **不可编辑**，契约无创建/删除操作）。 */
export interface CategoryInputValue {
  name: string;
  description: string;
  active: boolean;
}

/** 契约 `AdminAccountView`。 */
export interface AccountView {
  id: string;
  revision: number;
  state: AccountState;
  display_name: string;
}

/**
 * 契约 `AdminJob`。
 * `result` 在契约里是 `{"type":"null"}` ⇒ **恒为 null**，本片不填占位内容。
 */
export interface AdminJobView {
  id: string;
  revision: number;
  kind: JobKind;
  target_ref: TargetRefValue;
  state: JobState;
  deadline_at: string;
  created_at: string;
  error_code: string | null;
  result: null;
}

/**
 * `listAdminJobs` 的服务端过滤（契约 `listAdminJobs` 的 `state` / `error_code` 查询参数）。
 *
 * 两个字段都**可选**：都不给 ⇒ 不过滤，读面与 R29 的列表逐字相同。
 * 取值都是契约闭集（`JobState` / `ErrorCode`）：闭集外的入参在服务层就判 400
 * `INVALID_REQUEST`（⛔ 不静默返回空页，也不复用 503 —— 503 是"读出来的值不认识"，
 * 这里的含义是"入参非法"）。
 */
export interface AdminJobFilter {
  /** 契约 `JobState` 闭集，对应三个作业源的真实列 `state`。 */
  state?: JobState;
  /** 契约 `ErrorCode` 闭集，对应真实列 `error_code`（`varchar(80)`，按文本比较）。 */
  error_code?: ErrorCode;
}

/** 契约 `FlagInput`。 */
export interface FlagInputValue {
  enabled: boolean;
  reason: string;
}

/** 契约 `Flag`。 */
export interface FlagView {
  key: string;
  enabled: boolean;
  revision: number;
}

/** 契约 `Ack`。 */
export interface AckView {
  accepted: boolean;
}

// ---------------------------------------------------------------------------
// 作业取消端口
// ---------------------------------------------------------------------------

/** 端口取消结果：**不抛异常**，由服务层映射成契约错误码。 */
export type CancelJobOutcome =
  | { ok: true; job: AdminJobView }
  | { ok: false; reason: 'NOT_FOUND' | 'TERMINAL' | 'REVISION_CHANGED' | 'PORT_UNAVAILABLE' };

/**
 * 平台级作业的**注入式端口**（`AdminJobPort`）。
 *
 * 现实约束：`#9/#10/#11/#13` 产生的平台级 job 目前**没有共享读面/取消面**
 * （那是另一张工单，等 #87 合并）。因此本片只定义端口 + 一个**默认无实现**：
 * - `wired === false` 时：`list()` 返回 `[]`、`get()` 返回 `null`、
 *   `cancel()` 返回 `{ok:false, reason:'PORT_UNAVAILABLE'}`；
 * - 服务层对未接线端口**一律 503 `PROVIDER_UNAVAILABLE`**（读与写都是），
 *   **绝不**把"未知"说成"没有作业"，也绝不伪造作业状态。
 */
export interface AdminJobPort {
  /** 是否已接线。`false` ⇒ 服务层 fail-closed。 */
  readonly wired: boolean;
  /**
   * 是否**持久化到库**（与 `CommunityPostPort.persistent` 同一口径：不是自述布尔，
   * 内存实现恒 `false`、Postgres 实现恒 `true`）：
   * - `false`：内存参考实现 / 未接线端口 ⇒ `cancel()` 只改进程内状态，
   *   审计由服务层写既有的内存 `store.audit.append`；
   * - `true`：Postgres 端口 ⇒ `cancel()` 在**自己的事务里**同时改状态与写审计，
   *   服务层**不再**补写内存审计（补写会变成第二条口径，且掩盖库内已写的那一行）。
   */
  readonly persistent: boolean;
  /**
   * 列表读面。`filter` 缺省（或两个字段都不给）⇒ 不过滤，行为与 R29 逐字相同。
   * 过滤**必须由读面自己下推到查询里**（真实现是 SQL `WHERE`），⛔ 不在内存里筛。
   */
  list(filter?: AdminJobFilter): Promise<AdminJobView[]> | AdminJobView[];
  get(id: string): Promise<AdminJobView | null> | AdminJobView | null;
  /**
   * 终态不可复活：`reason: 'TERMINAL'` 由端口负责判定。
   *
   * `audit` 是本次取消要落的审计入参。**持久端口的契约是原子的**：状态变更与审计行
   * 在同一个事务里提交 —— 审计写不进去就整体回滚，取消不生效。
   * 不这么做的后果是监工 #589 指出的那种缺口：取消先提交、审计后写入，
   * 写审计失败时留下一条**永远补不回来**的已取消作业（审计表 append-only，事后也无从补记）。
   * 内存端口忽略该入参（服务层按 `persistent === false` 自己写内存审计流）。
   */
  cancel(
    id: string,
    expectedRevision: number,
    audit: AdminJobCancelAuditInput,
  ): Promise<CancelJobOutcome> | CancelJobOutcome;
}

/**
 * 一次取消要落的审计入参。
 *
 * 刻意**不含** `jobId` / `jobRevision`：这两个值只能取自端口自己刚锁住的那一行
 * （即 `cancel(id, expectedRevision, …)` 的入参），不让调用方另传一份可能与实际取消对象
 * 不一致的副本。也不含 action / scope / result / target_hint / target_ref —— 那些在
 * 迁移 0043 的函数内固定，调用方无从伪造。
 */
export interface AdminJobCancelAuditInput {
  /** 操作者 `admin_accounts.id`（= 会话身份；函数内重核验存在 / `active` / 当前有效持 `jobs:cancel`）。 */
  readonly actorId: string;
  /** 理由码；当前闭集只有 `job_cancelled`。 */
  readonly reasonCode: string;
  /** 契约 `Meta.request_id`。 */
  readonly requestId: string;
}

// ---------------------------------------------------------------------------
// 社区帖子可见性端口（`hidePost` 复用 #15 的 CAS 原语，不另写一套可见性判定）
// ---------------------------------------------------------------------------

/**
 * 社区帖子端口 = **直接取 #15 的 `CommunityStore` 里那两个方法**（只读 import，不修改该目录）。
 *
 * 为什么这样取：`hidePost` 必须复用社区自己的 CAS 与"已删除不可复活"语义，
 * 而不是在 admin 里复制一份可见性判定；用 `Pick<CommunityStore, ...>` 保证
 * 端口形状**就是**社区存储的形状，不引入会漂移的第二套签名。
 *
 * **GY-I18 · 能力位 `persistent`（#18）**：与 `getPost`/`commitPostIfCurrent` 一起取来，
 * 用作 real 模式放行 `hidePost` 的**唯一**判据（`app.ts` 传
 * `hidePostWired: communityPostPortForAdmin.persistent === true`）。
 * 它不是"自述布尔"：内存实现恒 `false`（`community/store.ts`），PG 实现恒 `true`
 * （`community/store-pg.ts`），观察器 `community/takedown.ts` 原样转发底层值。
 * ⇒ 没有真实持久落点时，real 下的下架照旧 fail-closed 503。
 */
export type CommunityPostPort = Pick<CommunityStore, 'persistent' | 'getPost' | 'commitPostIfCurrent'>;

/**
 * 后台帖子**读面**端口（R59：`listAdminPosts` / `getAdminPost`）。
 *
 * 与 `CommunityPostPort` 同一纪律：用 `Pick<CommunityStore, ...>` 保证端口形状**就是**
 * 社区存储的形状，admin 侧不引入会漂移的第二套读签名。
 *
 * 只要 `listPosts` + `getPost` 两个读原语：
 * - `listPosts` 的 `scope: 'admin'` 由适配层强制注入（见 `admin/ops/community-posts.ts`），
 *   调用方改不了"看得到已隐藏/已删除"这一口径；
 * - `getPost` 是管理视角单条读，**不**复用公开读面的 `readablePost`/有效态重算，
 *   两者可见性谓词不同（公开：非 published 不可见；后台：hidden/deleted 都要读得到）。
 *
 * 本端口**不**取 `persistent`：读面没有写入，不需要"真实落点"判据；
 * 未接线（`undefined`）时服务层直接 fail-closed 503，而不是返回空列表
 * （空列表会被误读成"库里没有帖子"）。
 */
export type CommunityPostReadPort = Pick<CommunityStore, 'listPosts' | 'getPost'>;
