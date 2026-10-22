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
  list(): Promise<AdminJobView[]> | AdminJobView[];
  get(id: string): Promise<AdminJobView | null> | AdminJobView | null;
  /** 终态不可复活：`reason: 'TERMINAL'` 由端口负责判定。 */
  cancel(id: string, expectedRevision: number): Promise<CancelJobOutcome> | CancelJobOutcome;
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
