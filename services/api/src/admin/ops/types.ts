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

// ---------------------------------------------------------------------------
// 社区帖子**人工审核**端口（S3：`approvePost` / `rejectPost`）
// ---------------------------------------------------------------------------

/**
 * 驳回理由码闭集（**小写 snake_case**，10 值）。
 *
 * 为什么另立一套而不复用审核域的全大写码（`DECISION_INCONSISTENT` / `RULE_VERSION_CHANGED`…）：
 * 同一个 `reason_codes` 数组里同时装"机器判定的失效原因"与"运营给出的处置理由"，
 * 用大小写分治就能在日志与 SQL 里**一眼看出这条结论里有没有人的判断**，
 * 不需要新字段、也不把两套语义焊死。
 *
 * **单一来源**：契约 `PostRejectionInput.properties.reason_code.enum` 必须与本数组
 * **逐值相等（含顺序）**，由 `tests/unit/admin-post-review-contract.test.mjs` 钉死。
 * 加值 = 改契约 + 改这里 + 改该用例，三件套，缺一即红。
 *
 * 与既有码的关系（避免被问"为什么又一套码"）：
 * - `community_reports.reason_code`（举报理由）是**自由文本**，不合并：举报是用户主张，
 *   处置是平台结论，合并会让举报侧被迫接受处置码表；
 * - `admin_audit_events.reason_code` 是**每个 action 一个值**的闭集（例：迁移 0043 只允许
 *   `job_cancelled`）；本片不写该表，故不冲突；
 * - `moderation_decisions.reason_codes`（机器审核台账）不动。
 */
export const POST_REVIEW_REASON_CODES: readonly string[] = Object.freeze([
  // —— 违法/不良信息类（生态治理口径）——
  'spam',
  'harassment',
  'adult_or_violent',
  'illegal_or_political',
  'privacy',
  // —— 本域特有（农事/农资）——
  'misleading_agronomy',
  'banned_agrochemical',
  // —— 社区秩序类 ——
  'off_topic',
  'duplicate',
  // —— 兜底（长期高频 ⇒ 说明闭集漏项，须在周报里审视）——
  'other',
]);

/** 驳回理由码。类型层面即闭集：写错值 tsc 直接红。 */
export type PostRejectionReasonCode = (typeof POST_REVIEW_REASON_CODES)[number];

/** 人工审核的两个结论。与契约 `PostReviewOutcome.decision.enum` 逐值一致。 */
export type PostReviewDecision = 'approved' | 'rejected';

/**
 * 一次人工审核请求（服务层 → 端口的完整入参）。
 *
 * `expectedRevision` 是 `If-Match`（契约 `ETag`）解析出来的**必填**版本：审核动作必须打在
 * 运营读到的那个版本上，**不提供"不给 If-Match 也能过"的兼容**。
 */
export interface PostReviewRequest {
  readonly postId: string;
  readonly expectedRevision: number;
  readonly decision: PostReviewDecision;
  /** `decision === 'rejected'` 时必填且在闭集内；`approved` 时恒 `null`。 */
  readonly reasonCode: PostRejectionReasonCode | null;
  /** 做出结论的运营者 `admin_accounts.id`（= 会话身份）；落 `decided_by` 供溯源。 */
  readonly actorId: string;
}

/**
 * 审核结果。
 *
 * 失败面刻意复用 `hidePost` 已经映射好的那几个（`NOT_FOUND`/`DELETED`/
 * `REVISION_CONFLICT`/`STORE_UNAVAILABLE`），只多两个**审核域特有**的：
 * - `RULE_VETOED`：硬规则层明确否决（`hard_rule_passed === false`）⇒ 人工不能放行；
 * - `RULE_VERSION_UNKNOWN`：当前规则集版本取不到（`null`）⇒ 写进去的结论会被读面判
 *   `RULE_VERSION_UNKNOWN` 而落 `quarantined`，等于伪造"已通过/已驳回"，宁可拒绝。
 *
 * ⛔ 刻意**没有** `NOT_PUBLIC`：待审队列本身就是 `private`+`pending`
 * （`community/service.ts:1066-1067` 的"联动发布未成"），若把 `private` 当"无审核可言"
 * 就会把唯一需要人工审的那批行判成不可审——契约里也没有别的发布出口。
 */
export type PostReviewFailureReason =
  | 'NOT_FOUND'
  | 'DELETED'
  | 'REVISION_CONFLICT'
  | 'RULE_VETOED'
  | 'RULE_VERSION_UNKNOWN'
  | 'STORE_UNAVAILABLE';

export type PostReviewResult =
  | {
      ok: true;
      /** `false` = 幂等命中（状态本来就如此），不产生第二次写入与第二条通知。 */
      changed: boolean;
      previousRevision: number;
      revision: number;
      auditState: 'approved' | 'rejected';
      /** v1 通过即发布：`approve` 可能把 `private` 推成 `published`；`reject` 置 `hidden`（见口径页 §1/§2）。 */
      visibility: 'private' | 'published' | 'hidden' | 'deleted';
      /** 作者通知是否送出。`false` 不回滚已提交的结论（见 `community/takedown.ts` 的既有纪律）。 */
      notified: boolean;
      /** 门禁给出的原因码（`approved` 且全清时为空数组）。 */
      reasonCodes: readonly string[];
    }
  | { ok: false; reason: PostReviewFailureReason; reasonCodes?: readonly string[] };

/**
 * 帖子人工审核端口。
 *
 * 与 `HidePostAdapter` 同形：`wired === false` ⇒ 服务层 503（fail-closed），
 * 而不是"悄悄成功"。真实实现见 `community-posts.ts` 的 `createPostReviewAdapter`。
 *
 * 溯源取舍：审核人只写 `community_moderation_decisions.decided_by`（迁移 0045），
 * **故意不建外键**——账号注销后仍要能答"谁批过它"，强引用会让注销链卡死或把证据置空；
 * 账号是否存在由应用层解释（写入来源是已认证的 `AdminCallContext.identity`）。
 */
export interface PostReviewPort {
  readonly wired: boolean;
  review(request: PostReviewRequest): Promise<PostReviewResult>;
}

/**
 * 对外的审核结论视图（= 契约 `PostReviewOutcome`，逐字段一致）。
 *
 * 刻意**不**回帖子正文/标题：审核响应是"处置回执"，不是内容读面；
 * 也不回 `target_ref` / `text_digest` / `hard_rule_passed` 这些内部判定料
 * （运营不需要，且把内部判定暴露到 HTTP 面会让"人工结论"看起来像"机器结论"）。
 */
export interface PostReviewOutcome {
  id: string;
  revision: number;
  audit_state: 'approved' | 'rejected';
  visibility: 'private' | 'published' | 'hidden' | 'deleted';
  decision: PostReviewDecision;
  /** `false` = 幂等命中：本次没有产生新版本，也没有再发通知。 */
  changed: boolean;
  notified: boolean;
  reason_codes: string[];
}
