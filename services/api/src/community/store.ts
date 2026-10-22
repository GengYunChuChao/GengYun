/**
 * GY-I15（#15）阶段 1 · 社区域存储（可注入）。
 *
 * 本片交付**内存实现**，并明确声明其边界（不得当作已完成持久化）：
 *   - 进程内状态，重启即丢；**没有**新增数据库迁移（`db/**` 属共享文件，本阶段不碰）；
 *   - 阶段 2 需按 `docs/architecture/data-dictionary.md`（`posts`/`post_versions`/
 *     `comments`/`moderation_decisions`/`reports`/`likes`）实现同接口的 PG 版本，
 *     并补齐"同事务发布"的约束。因此阶段 1 **不宣称**社区已端到端可用。
 *
 * 幂等台账沿用 #9/#10/#11/#13 的做法（`services/api/src/auth/idempotency.ts` 的
 * claim / complete / release 语义）：写路径**先原子占位**，占位者执行审核与落库，
 * 完成后写回结果；失败释放占位。同键并发时未占位者**有界等待**占位者结果，
 * 再按其结果重放（恰好 1 条内容、恰好 1 次审核）。
 */
import type { AuditState, KnowledgeTarget, ReportTarget, Visibility } from './types.ts';
import { redactPersonalInfo } from './personal-info.ts';
import { ANONYMIZED_AUTHOR_REF_PATTERN, createAnonymizedAuthorRef } from './authors.ts';

export interface PostRecord {
  id: string;
  revision: number;
  /**
   * 内部作者指针。**可空**（迁移 0030）：注销后置 NULL、由 {@link PostRecord.anonymized_author_ref}
   * 承接作者身份。读路径必须写成 `author_id ?? anonymized_author_ref`，
   * ⛔ 不要用 `String(author_id)` —— 那会把 NULL 变成字符串 `'null'` 并当成一个"用户 id"去投影。
   */
  author_id: string | null;
  /** 行内注销引用（`gy-anon-<16 hex>`）；未注销行为 NULL。两列**恰好一个**非空（0030 CHECK）。 */
  anonymized_author_ref: string | null;
  title: string;
  body: string;
  crop_id: string | null;
  region_code: string | null;
  media_ids: string[];
  linked_knowledge_ref: KnowledgeTarget | null;
  visibility: Visibility;
  audit_state: AuditState;
  created_at: string;
  updated_at: string;
}

export interface CommentRecord {
  id: string;
  revision: number;
  post_id: string;
  /** 同 {@link PostRecord.author_id}：可空，可空性由迁移 0030 的 CHECK 保证"恰好一个作者字段"。 */
  author_id: string | null;
  /** 同 {@link PostRecord.anonymized_author_ref}。 */
  anonymized_author_ref: string | null;
  body: string;
  visibility: Visibility;
  audit_state: AuditState;
  created_at: string;
}

/**
 * 审核结论台账记录。
 *
 * **不是**契约 `Moderation`：`model_version`/`prompt_version` 属模型层（LLM），本片不产出，
 * 因此这里如实标注 `contract_complete: false` 与缺失字段，绝不填占位串假装已填。
 */
export interface ModerationRecord {
  id: string;
  target_ref: ReportTarget;
  decision: AuditState;
  reason_codes: string[];
  hard_rule_passed: boolean;
  rule_version: string | null;
  /**
   * 送审正文的 SHA-256（帖子 = title+LF+body；评论 = body）。
   *
   * 用途：把结论**绑定到具体正文**，而不只绑定 revision——若正文在 revision 未变的情况下
   * 被改动（任何未来实现 bug／旁路写入），读取时的可见性判定立即失败（内容不得可见）。
   * 与数据字典 `moderation_decisions.checked_media_hashes` 的"证据摘要"口径一致。
   */
  text_digest: string;
  contract_complete: false;
  missing_contract_fields: string[];
  created_at: string;
}

/**
 * 举报状态取值（与迁移 `0022:134` 的 CHECK、契约 `Report.state` 逐值一致）。
 *
 * 单独起名是为了让状态机（`community/report-state.ts`）与存储层共用**同一个**联合类型：
 * 状态机的表只要漏一个取值、或存储层加了第四值，tsc 立刻红。
 */
export type ReportState = 'received' | 'isolated' | 'closed';

export interface ReportRecord {
  id: string;
  revision: number;
  reporter_id: string;
  target_ref: ReportTarget;
  state: ReportState;
  reason_code: string;
  /** 请求体里的 detail（契约 `Report` **没有**这个字段，因此不入响应，只留审计）。 */
  detail: string | null;
  created_at: string;
}

/** 幂等结果引用（不含任何凭据；重放时按引用重新读取并重新鉴权）。 */
export interface IdempotencyOutcome {
  kind: 'post' | 'comment' | 'report' | 'ack';
  id: string;
  revision: number;
}

export interface IdempotencyRecord {
  request_hash: string;
  response_status: number;
  outcome: IdempotencyOutcome;
  expires_at: number;
}

/**
 * 更新前的**期望状态**（CAS 的比较条件）。
 *
 * 语义：只有在同一同步临界区内重读到当前记录、并逐项满足下面的期望时，才允许写入；
 * 任何一项不满足都**不写入**并回传失败原因（见 `CommitFailureReason`）。
 */
export interface PostCommitExpectation {
  /** 必须等于当前 `revision`（契约 `If-Match` 的服务端等价物）。 */
  revision: number;
  /** 必须等于当前 `visibility`。 */
  visibility?: Visibility;
  /** 必须等于当前 `audit_state`。 */
  audit_state?: AuditState;
  /** 必须等于当前 `author_id`（归属校验也在同一临界区内完成）。 */
  author_id?: string;
}

export interface CommentCommitExpectation {
  revision: number;
  visibility?: Visibility;
  audit_state?: AuditState;
  author_id?: string;
}

/** 允许被 CAS 修改的字段（白名单：不给"整条记录覆盖"的口子）。 */
export type PostCommitPatch = Partial<
  Pick<
    PostRecord,
    | 'revision'
    | 'title'
    | 'body'
    | 'crop_id'
    | 'region_code'
    | 'media_ids'
    | 'linked_knowledge_ref'
    | 'visibility'
    | 'audit_state'
    | 'updated_at'
  >
>;

export type CommentCommitPatch = Partial<Pick<CommentRecord, 'revision' | 'body' | 'visibility' | 'audit_state'>>;

/**
 * 举报 CAS 的期望状态（与 `PostCommitExpectation` 同一套语义，只是比较列不同）。
 *
 * 举报没有「归属校验」这一档：处置方是运营侧，而不是举报者本人（举报者只能读自己的举报，
 * 不能推进它）。因此这里**故意没有** `reporter_id` 期望——把它做成 CAS 条件只会诱使调用方
 * 拿举报者身份去冒充处置方。
 */
export interface ReportCommitExpectation {
  /** 必须等于当前 `revision`（`If-Match` 的服务端等价物）。 */
  revision: number;
  /** 必须等于当前 `state`（防「读到 received、写回时别人已经 triage 过」）。 */
  state?: ReportState;
}

/** 允许被 CAS 修改的字段（白名单；`reporter_id`/`target_ref`/`reason_code` 一律不可改）。 */
export type ReportCommitPatch = Partial<Pick<ReportRecord, 'revision' | 'state'>>;

/**
 * 注销清理的分表计数（`community_reports`/`community_posts`/… 一次事务内的真实行数）。
 *
 * 形状与 `privacy` 的 `OwnerPurgeCounts`（`{ records, idempotency }`）**逐字段兼容**，
 * 并在其上**单列保留/脱敏/媒体**三类读数 —— F13 的注销是「保留正文」而不是「全部软删」，
 * 一个合计数字无法自证"保留了哪些、隐藏了哪些"，因此这里把三类分开报：
 *
 *   - `records`：**真实改动/删除**的行数（正文脱敏的帖评 + 仅移除媒体的帖评 + 清 detail 的举报
 *     + 物理删除的点赞）。**不含**"原样保留"的行 —— 保留不是一次写操作。
 *   - `retained`：正文原样保留的帖子 + 评论数（含"只移除了媒体引用"的行）。
 *   - `redacted`：正文因清除个人信息被改写的帖子 + 评论数。改写后旧审核结论（摘要绑定）
 *     自动失效 ⇒ 该行退出公开面、等重审；这是保留 + 去 PII，不是删除。
 *   - `hiddenMedia`：被移除的媒体引用条数。社区存储没有"媒体已可靠脱敏"的证据面
 *     （媒体投影未接线），因此按 F13 的"不能可靠脱敏 ⇒ 移除"处理；正文照旧保留。
 *   - `authorRefsReplaced`：**行级作者指针被换成注销引用的行数**（迁移 0030：`author_id` 置 NULL +
 *     写 `anonymized_author_ref`）。⚠️ 不并入 `records`（那不是"删除/改写正文"），也不并入
 *     `retained`（保留读数说的是正文是否原样）—— 三者是不同的账，混算会让证据串把
 *     "替换了几行作者"读成"保留了几行"。
 *   - `authorRefsRemaining`：**写入完成后重新测量**的「仍以原 `author_id` 关联本主体」行数
 *     （帖子 + 评论，**含** `visibility='deleted'` 行）。0 = 账号映射已从本主体的全部内容行上
 *     删除；>0 = 仍有行指向该账户，注销端口必须据此如实 `blocked`（⛔ 不得用
 *     `authorRefsReplaced > 0` 冒充完成）。这是 P2 返修新增的**结果**读数：不是"做了几步"，
 *     而是"还剩多少没做"。
 *
 *     **实现义务（fail-closed）**：两个真实实现（`store.ts` 内存 / `store-pg.ts`）必须如实报告
 *     这个读数；**测量不可读**时返回 {@link AUTHOR_REFS_REMAINING_UNKNOWN}，⛔ 不得用 0 顶替
 *     "没读到"（那等于替存储撒谎"已清干净"）。端口按 {@link readAuthorRefsRemaining} 校验：
 *     缺失 / 非数 / 非整数 / 负数 / 非有限值 ⇒ 一律 `blocked` +
 *     `author-refs-remaining-unknown`，⛔ 不回落任何旧判据（监工 PR #483 的残留 fail-open）。
 */
export interface CommunityOwnerPurgeCounts {
  records: number;
  idempotency: number;
  retained: number;
  redacted: number;
  hiddenMedia: number;
  /** 行级作者指针替换行数（迁移 0030；0 = 没有需要替换的行或已是匿名行）。 */
  authorRefsReplaced: number;
  /** 写入后仍以原 `author_id` 关联本主体的行数（帖 + 评，含软删行）；0 = 账号映射已清干净。 */
  authorRefsRemaining: number;
}

/**
 * `authorRefsRemaining` 的**未知**哨兵（`NaN`）。
 *
 * 为什么需要显式的"未知"值：`purgeOwnerData` 的返回值是**证据**，不是"尽力而为的统计"。
 * 「没读到计数」与「读到了 0」在隐私语义上完全不同 —— 后者能证明账号映射已从全部内容行上删除，
 * 前者什么也证明不了。P2 返修（监工 PR #483）之前的端口把两者混为一谈：读数缺失（或
 * `"3"`/`-1`/`1.5`/`NaN`/`Infinity` 这类不可信值）时回落到旧判据 `authorRefsReplaced === 0`
 * ⇒ 审查探针 P6/P6b 实测仍会静默 `completed`，而「已软删除帖评仍保留原作者关联」正好落在
 * 这种形态里。现在口径是 fail-closed：读数不可信 ⇒ 端口一律 `blocked` +
 * `author-refs-remaining-unknown`，⛔ 不得回落、⛔ 不得判完成。
 */
export const AUTHOR_REFS_REMAINING_UNKNOWN = Number.NaN;

/**
 * 把存储报告的 `authorRefsRemaining` 规范成**可信读数**：非负安全整数 ⇒ 原值；其余 ⇒ `null`。
 *
 * 调用方拿到 `null` 必须按「未知」处理（端口 ⇒ `blocked`），⛔ 不得当成 0、⛔ 不得回落到别的
 * 判据。两侧实现与端口**共用这一个判据**（内存 `store.ts`、PG `store-pg.ts`、端口 `purge.ts`），
 * 避免某一边悄悄放宽：缺失、`null`、字符串（`"3"`）、负数、非整数（`1.5`）、非有限值
 * （`NaN`/`±Infinity`）、超出安全整数范围（含 `2^53`）一律不可信。
 */
export function readAuthorRefsRemaining(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

/**
 * `purgeOwnerData` 的调用选项。
 *
 * `anonymizedAuthorRef`：由注销装配层（`community/purge.ts` 的 `authors.anonymize`）生成的注销引用，
 * **全行共用同一个**（逐主体独立，不是逐行随机）。
 *
 * 三态（⚠️ `undefined` 与 `null` 语义**不同**，不要用 `??` 把它们合并）：
 *   - `undefined`：调用方没表态（例如测试直接调 store）⇒ 存储实现用
 *     `authors.ts::createAnonymizedAuthorRef()` **兜底生成**。这不是"第二个真源"，而是自保：
 *     只要要写 `author_id = NULL`，就**必须**同时写入形状合法的引用，否则撞迁移 0030 的
 *     `num_nonnulls(author_id, anonymized_author_ref) = 1`。
 *   - `null`：调用方**明确**表示"我拿不到引用"（注销端口在 `anonymize` 缺失/失败时这样传）
 *     ⇒ 存储**完全不替换**行级作者（保留原 `author_id`），由端口如实 blocked。
 *     ⛔ 不要退化成"那就兜底生成一个"：那会把"能力缺失"悄悄变成"看起来完成了"。
 *   - `string`：必须合 `^gy-anon-[0-9a-f]{16}$`，否则抛错（不静默改写）。
 */
export interface CommunityOwnerPurgeOptions {
  anonymizedAuthorRef?: string | null;
}

/**
 * `listPosts` 的**下推筛选**（SQL 实现把每一项都写进 `WHERE`，内存实现逐项等价过滤）。
 *
 * 口径与 `GET /posts` 的既有参数一一对应，**没有新增契约参数**：
 *   - `scope: 'public'` ⇒ 公开列表的**候选集**（`visibility = 'published'`）。规则版本/正文摘要
 *     复核仍由服务层 `isPubliclyVisible()` 逐行确认——那部分取决于规则层与审核域台账，不是 SQL
 *     能判定的谓词，所以只把「结构上不可能公开」的行（`private`/`hidden`/`deleted`）挡在库外。
 *   - `scope: 'mine'` ⇒ 「我的发布」：`visibility <> 'deleted'` + `author_id = authorId`（含未公开版本）。
 *     `author_id` 可空（迁移 0030）⇒ **已匿名行永远不属于任何主体**（`NULL = <uuid>` 得 NULL，
 *     不是 TRUE）—— 这正是"注销后不再出现在原用户的『我的发布』里"想要的语义。
 *     ⛔ 不要把它补成 `coalesce(author_id, anonymized_author_ref)`（那会把匿名行算回某个用户），
 *     也不要用 `IS NOT DISTINCT FROM`（两列都为 NULL 时会误命中）。
 *   - `scope: 'all'` ⇒ **不做任何可见性过滤**，只为测试夹具/诊断保留；生产调用方不得使用。
 *
 * 分页是 keyset：`after` 是上一页最后一行（`created_at` + `id`），排序用确定性的
 * `created_at DESC, id DESC`（`id` 是 tie-breaker，否则同秒内容翻页会重复/漏行）。
 * `limit` 在 `WHERE` **之后**生效——不存在「先取一页再过滤」那种页内缺行/跳行的读数。
 */
export interface ListPostsFilter {
  scope: 'public' | 'mine' | 'all';
  /** `scope: 'mine'` 必填（主体自己的 id）；其余 scope 忽略。 */
  authorId?: string | null;
  cropId?: string | null;
  regionCode?: string | null;
  after?: { createdAt: string; id: string } | null;
  /** `null` ⇒ 不限制（仅测试夹具/诊断用）。 */
  limit?: number | null;
}

/** CAS 失败原因。**注意：已删除（`DELETED`）永远失败**——不提供"复活已删除内容"的开关。 */
export type CommitFailureReason =
  | 'NOT_FOUND'
  | 'DELETED'
  | 'AUTHOR_CHANGED'
  | 'REVISION_CHANGED'
  | 'VISIBILITY_CHANGED'
  | 'AUDIT_STATE_CHANGED'
  /**
   * 举报专用：`state` 与期望值不符（有人已经推进过这条举报）。
   *
   * 不并进 `REVISION_CHANGED`：两者的**修法**不同——revision 变了是"重新读一遍再试"，
   * state 变了是"这条举报的状态路线已经分叉，必须重新判断该不该处置"。运维/调用方看到
   * 同一个码却要做不同的事，那就应该是两个码。
   */
  | 'STATE_CHANGED';

export type CommitResult<T> = { ok: true; record: T } | { ok: false; reason: CommitFailureReason };

export interface CommunityStore {
  readonly persistent: boolean;
  // ---- 帖子 ----
  /** 创建：同 id 已存在则不写入并返回 `false`；**内容与审核结论同一次提交写入**。 */
  insertPost(record: PostRecord, moderation: ModerationRecord | null): Promise<boolean>;
  getPost(id: string): Promise<PostRecord | null>;
  /**
   * **唯一的帖子更新原语**：比较并写入（CAS）。
   * 在同一同步临界区内完成"重读当前记录 → 校验 revision/可见性/审核状态/归属/未删除 → 写入补丁
   * （+ 可选：同一次提交写入该 revision 的审核结论）"。**不存在**无条件覆盖的更新入口。
   */
  commitPostIfCurrent(
    id: string,
    expected: PostCommitExpectation,
    patch: PostCommitPatch,
    moderation: ModerationRecord | null,
  ): Promise<CommitResult<PostRecord>>;
  /**
   * 列表读取。`filter` 的每一项都必须由**存储层**执行（SQL 实现写进 `WHERE`，内存实现等价过滤），
   * 服务层不得再拿全表结果在内存里筛——那是「筛选未下推」的原始缺陷（#444 §S5）。
   * 省略参数 = `scope: 'all'`（无可见性过滤、不限制行数），仅供测试夹具/诊断，生产调用方必须显式给筛选。
   */
  listPosts(filter?: ListPostsFilter): Promise<PostRecord[]>;
  // ---- 评论 ----
  /**
   * 创建评论：同 id 已存在则不写入；`requireParent` 给定时，还在**同一临界区**内校验父帖
   * 仍存在、未删除且 revision 未变（防止"父帖刚被删除却插入评论"）。
   */
  insertComment(
    record: CommentRecord,
    moderation: ModerationRecord | null,
    requireParent?: { id: string; revision: number },
  ): Promise<boolean>;
  getComment(id: string): Promise<CommentRecord | null>;
  /** 评论侧的唯一更新原语（CAS），语义同 `commitPostIfCurrent`。 */
  commitCommentIfCurrent(
    id: string,
    expected: CommentCommitExpectation,
    patch: CommentCommitPatch,
    moderation: ModerationRecord | null,
  ): Promise<CommitResult<CommentRecord>>;
  listComments(postId: string): Promise<CommentRecord[]>;
  // ---- 点赞（集合语义：同主体同目标至多 1 条，计数由集合大小派生，永不为负）----
  addLike(kind: 'post' | 'comment', targetId: string, userId: string): Promise<boolean>;
  removeLike(kind: 'post' | 'comment', targetId: string, userId: string): Promise<boolean>;
  countLikes(kind: 'post' | 'comment', targetId: string): Promise<number>;
  // ---- 审核结论台账 ----
  /**
   * **未提交内容**的结论补录（拒绝/隔离的写入请求）：仅当该 `(type,id,revision)`
   * 既没有内容行、也没有既有结论时写入，否则返回 `false` 不覆盖。
   * 已提交内容的结论由 `insertPost`/`commitPostIfCurrent` **同原子**写入，不走这里。
   */
  putRefusalVerdict(record: ModerationRecord): Promise<boolean>;
  getModeration(kind: 'post' | 'comment', id: string, revision: number): Promise<ModerationRecord | null>;
  countModeration(): Promise<number>;
  // ---- 举报 ----
  insertReport(record: ReportRecord): Promise<void>;
  getReport(id: string): Promise<ReportRecord | null>;
  /**
   * **唯一的举报状态推进原语**（CAS），语义对齐 `commitPostIfCurrent`：同一临界区内
   * 重读 → 校验 `revision`（与可选 `state`）→ 写入 `{revision, state}` 白名单补丁。
   *
   * 为什么必须是 CAS 而不是 `updateReport`：处置是**两个人可能同时点**的动作（队列里两条
   * 运营同时打开同一条举报），无条件写入会让后到者覆盖先到者的结论，而举报结论一旦覆盖就
   * 无法从台账上复原。CAS 让它变成「一个成功、一个 409」。
   */
  commitReportIfCurrent(
    id: string,
    expected: ReportCommitExpectation,
    patch: ReportCommitPatch,
  ): Promise<CommitResult<ReportRecord>>;
  /**
   * 注销清理（GY-I15 · R31-S6 / F13 保留规则）：把该用户名下**社区域**的数据按既定口径处理，
   * 返回**分表真实行数**（保留/脱敏/媒体/改动/台账分开报）。
   *
   * 口径（见 `store-pg.ts` 同名实现的注释与 `docs/implementation-requirements.md` F13）：
   *   - **帖子/评论保留**：已审核、无个人信息的安全正文**不改可见性**（不因注销软删）；
   *   - **个人信息清除**：正文命中联系方式/精确门牌等片段时替换为占位符，并推进 revision
   *     （旧审核摘要失效 ⇒ 退出公开面、等重审；行仍在库）；
   *   - **不能可靠脱敏的媒体移除**：`media_ids` 清空（正文保留）；
   *   - 举报**清空自由文本**（`detail` 置空，状态机与台账行保留）、点赞**物理删除**、
   *     本域幂等台账按主体清空；
   *   - **作者主动删除（`visibility='deleted'`）的行：内容与可见性原样保留**（注销路径不复活、
   *     不脱敏、不推进版本、不更新 `updated_at`），但**作者关联照样清除**——「保留作者自己的
   *     删除语义」与「删除账号映射」不冲突（P2 返修，见 `store-pg.ts` 同名实现）；
   *   - **行级作者指针替换**（迁移 0030）：`author_id` 置 NULL、写入随机注销引用
   *     `anonymized_author_ref`（全行共用同一串；计数进 `authorRefsReplaced`）。
   *     命中集 = 该主体名下的**全部**行，**含** `visibility='deleted'` 行：只替换作者指针会让
   *     「普通行 + 已软删行」的主体在 `authorRefsReplaced > 0` 时看起来完成，而软删行仍直接
   *     关联账户（监工 PR #483 [P2]）。
   *   - **剩余读数**：`authorRefsRemaining` 在写入完成后**重新测量**「仍以原 `author_id` 关联
   *     本主体的行数」（帖 + 评，**含**软删行）。端口只认这个数判 blocked，⛔ 不以
   *     `authorRefsReplaced` 冒充完成。读数必须是可信的非负安全整数；测量不可读时返回
   *     {@link AUTHOR_REFS_REMAINING_UNKNOWN}（端口据此 fail-closed 判 `blocked`），
   *     ⛔ 不得用 0 顶替"没读到"。
   *
   * **可选方法**：与 `snapshotCounts` 同一条纪律——不把已有的测试替身一次性改红。装配处
   * （`app.ts`）在缺失时按「该域没有清理能力」处理并**如实降级**（调用即抛 ⇒ blocked），
   * 不做静默假装。
   */
  purgeOwnerData?(ownerId: string, options?: CommunityOwnerPurgeOptions): Promise<CommunityOwnerPurgeCounts>;
  // ---- 幂等台账 ----
  findIdempotency(scope: string, keyHash: string): Promise<IdempotencyRecord | null>;
  claimIdempotency(
    scope: string,
    keyHash: string,
    claim: { request_hash: string; response_status: number; expires_at: number },
  ): Promise<boolean>;
  completeIdempotency(
    scope: string,
    keyHash: string,
    done: { response_status: number; outcome: IdempotencyOutcome },
  ): Promise<boolean>;
  releaseIdempotency(scope: string, keyHash: string): Promise<void>;
  /** 有界等待占位者完成；返回 `settled` 或 `timeout`。 */
  awaitIdempotencySettled(scope: string, keyHash: string, waitMs: number): Promise<'settled' | 'timeout'>;
}

interface IdempotencySlot {
  request_hash: string;
  response_status: number;
  outcome: IdempotencyOutcome | null;
  expires_at: number;
  waiters: Array<() => void>;
}

const MODERATION_DELIMITER = '\u0000';
const likeComposite = (kind: string, targetId: string): string => `${kind}${MODERATION_DELIMITER}${targetId}`;
const idempotencyComposite = (scope: string, keyHash: string): string => `${scope}${MODERATION_DELIMITER}${keyHash}`;
const moderationComposite = (kind: string, id: string, revision: number): string =>
  `${kind}${MODERATION_DELIMITER}${id}${MODERATION_DELIMITER}${revision}`;

function compareCreatedAtDescending(
  a: { created_at: string; id: string },
  b: { created_at: string; id: string },
): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

function compareCreatedAtAscending(
  a: { created_at: string; id: string },
  b: { created_at: string; id: string },
): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** 内存实现（测试/替身；不是持久化，不代表端到端可用）。 */
export function createMemoryCommunityStore(
  options: { now?: () => number } = {},
): CommunityStore & {
  snapshotCounts(): { posts: number; comments: number; reports: number; moderation: number };
} {
  const posts = new Map<string, PostRecord>();
  const comments = new Map<string, CommentRecord>();
  const reports = new Map<string, ReportRecord>();
  const moderation = new Map<string, ModerationRecord>();
  const likes = new Map<string, Set<string>>();
  const idempotency = new Map<string, IdempotencySlot>();
  // 幂等窗口比较必须与服务使用同一个时钟（否则测试里的脚本化时钟会被真实的 Date.now() 判成过期）。
  const clockMs = options.now ?? (() => Date.now());

  const clonePost = (record: PostRecord): PostRecord => ({
    ...record,
    media_ids: [...record.media_ids],
    linked_knowledge_ref: record.linked_knowledge_ref === null ? null : { ...record.linked_knowledge_ref },
  });
  const cloneComment = (record: CommentRecord): CommentRecord => ({ ...record });
  const cloneReport = (record: ReportRecord): ReportRecord => ({ ...record, target_ref: { ...record.target_ref } });
  const cloneModeration = (record: ModerationRecord): ModerationRecord => ({
    ...record,
    target_ref: { ...record.target_ref },
    reason_codes: [...record.reason_codes],
    missing_contract_fields: [...record.missing_contract_fields],
  });

  function settle(scope: string, keyHash: string): void {
    const slot = idempotency.get(idempotencyComposite(scope, keyHash));
    if (slot === undefined) return;
    const waiters = slot.waiters.splice(0, slot.waiters.length);
    for (const wake of waiters) wake();
  }

  /**
   * 帖子 CAS 的**同步**临界区。
   *
   * 这个函数**没有任何 `await`**：从"重读当前记录"到"写回"之间不产生事件循环让步，
   * 因此不会出现"检查用旧快照、写回却覆盖新状态"的窗口（监工 5487924826 P1 的成因）。
   * 内存实现天然原子；阶段 2 的 PG 实现必须在**同一事务**内 `SELECT ... FOR UPDATE`
   * 后完成同样的比较与写入，语义与这里逐条对齐。
   */
  function commitPost(
    id: string,
    expected: PostCommitExpectation,
    patch: PostCommitPatch,
    moderationRecord: ModerationRecord | null,
  ): CommitResult<PostRecord> {
    const current = posts.get(id);
    if (current === undefined) return { ok: false, reason: 'NOT_FOUND' };
    // 已删除是单向门：任何写入（含把 visibility 改回 published）都不得复活它。
    if (current.visibility === 'deleted') return { ok: false, reason: 'DELETED' };
    if (expected.author_id !== undefined && current.author_id !== expected.author_id) {
      return { ok: false, reason: 'AUTHOR_CHANGED' };
    }
    if (current.revision !== expected.revision) return { ok: false, reason: 'REVISION_CHANGED' };
    if (expected.visibility !== undefined && current.visibility !== expected.visibility) {
      return { ok: false, reason: 'VISIBILITY_CHANGED' };
    }
    if (expected.audit_state !== undefined && current.audit_state !== expected.audit_state) {
      return { ok: false, reason: 'AUDIT_STATE_CHANGED' };
    }
    const next: PostRecord = { ...current, ...patch };
    posts.set(id, clonePost(next));
    if (moderationRecord !== null) {
      moderation.set(moderationComposite('post', id, next.revision), cloneModeration(moderationRecord));
    }
    return { ok: true, record: clonePost(next) };
  }

  /** 评论 CAS 的同步临界区（语义同 commitPost）。 */
  function commitComment(
    id: string,
    expected: CommentCommitExpectation,
    patch: CommentCommitPatch,
    moderationRecord: ModerationRecord | null,
  ): CommitResult<CommentRecord> {
    const current = comments.get(id);
    if (current === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (current.visibility === 'deleted') return { ok: false, reason: 'DELETED' };
    if (expected.author_id !== undefined && current.author_id !== expected.author_id) {
      return { ok: false, reason: 'AUTHOR_CHANGED' };
    }
    if (current.revision !== expected.revision) return { ok: false, reason: 'REVISION_CHANGED' };
    if (expected.visibility !== undefined && current.visibility !== expected.visibility) {
      return { ok: false, reason: 'VISIBILITY_CHANGED' };
    }
    if (expected.audit_state !== undefined && current.audit_state !== expected.audit_state) {
      return { ok: false, reason: 'AUDIT_STATE_CHANGED' };
    }
    const next: CommentRecord = { ...current, ...patch };
    comments.set(id, cloneComment(next));
    if (moderationRecord !== null) {
      moderation.set(moderationComposite('comment', id, next.revision), cloneModeration(moderationRecord));
    }
    return { ok: true, record: cloneComment(next) };
  }

  return {
    persistent: false,

    async insertPost(record, moderationRecord) {
      if (posts.has(record.id)) return false;
      posts.set(record.id, clonePost(record));
      if (moderationRecord !== null) {
        moderation.set(moderationComposite('post', record.id, record.revision), cloneModeration(moderationRecord));
      }
      return true;
    },
    async getPost(id) {
      const record = posts.get(id);
      return record === undefined ? null : clonePost(record);
    },
    async commitPostIfCurrent(id, expected, patch, moderationRecord) {
      return commitPost(id, expected, patch, moderationRecord);
    },
    async listPosts(filter = { scope: 'all' }) {
      const scope = filter.scope;
      const authorId = filter.authorId ?? null;
      const cropId = filter.cropId ?? null;
      const regionCode = filter.regionCode ?? null;
      const after = filter.after ?? null;
      const limit = filter.limit ?? null;
      if (scope === 'mine' && authorId === null) {
        throw new Error('listPosts: scope=mine 必须给出 authorId（存储层不接受隐式主体）');
      }
      const matched = [...posts.values()]
        .filter((record) => {
          if (scope !== 'all') {
            if (record.visibility === 'deleted') return false;
            if (scope === 'public' && record.visibility !== 'published') return false;
            if (scope === 'mine' && record.author_id !== authorId) return false;
          }
          if (cropId !== null && record.crop_id !== cropId) return false;
          if (regionCode !== null && record.region_code !== regionCode) return false;
          if (after === null) return true;
          // 与 SQL 的 `(created_at, id) < ($n, $m)` 同义：created_at DESC 上的 keyset。
          return record.created_at < after.createdAt
            || (record.created_at === after.createdAt && record.id < after.id);
        })
        .sort(compareCreatedAtDescending)
        .map(clonePost);
      return limit === null ? matched : matched.slice(0, limit);
    },

    async insertComment(record, moderationRecord, requireParent) {
      if (comments.has(record.id)) return false;
      if (requireParent !== undefined) {
        // 父帖校验与插入处于同一临界区：父帖被并发删除/改版时不得插入孤儿评论。
        const parent = posts.get(requireParent.id);
        if (parent === undefined || parent.visibility === 'deleted' || parent.revision !== requireParent.revision) {
          return false;
        }
      }
      comments.set(record.id, cloneComment(record));
      if (moderationRecord !== null) {
        moderation.set(
          moderationComposite('comment', record.id, record.revision),
          cloneModeration(moderationRecord),
        );
      }
      return true;
    },
    async getComment(id) {
      const record = comments.get(id);
      return record === undefined ? null : cloneComment(record);
    },
    async commitCommentIfCurrent(id, expected, patch, moderationRecord) {
      return commitComment(id, expected, patch, moderationRecord);
    },
    async listComments(postId) {
      return [...comments.values()]
        .filter((record) => record.post_id === postId)
        .map(cloneComment)
        .sort(compareCreatedAtAscending);
    },

    async addLike(kind, targetId, userId) {
      const key = likeComposite(kind, targetId);
      const bucket = likes.get(key) ?? new Set<string>();
      const changed = !bucket.has(userId);
      bucket.add(userId);
      likes.set(key, bucket);
      return changed;
    },
    async removeLike(kind, targetId, userId) {
      const key = likeComposite(kind, targetId);
      const bucket = likes.get(key);
      if (bucket === undefined) return false;
      const changed = bucket.delete(userId);
      if (bucket.size === 0) likes.delete(key);
      return changed;
    },
    async countLikes(kind, targetId) {
      return likes.get(likeComposite(kind, targetId))?.size ?? 0;
    },

    async putRefusalVerdict(record) {
      const key = moderationComposite(record.target_ref.type, record.target_ref.id, record.target_ref.revision);
      // 已有结论（含"内容已提交时同原子写入的结论"）优先，不覆盖。
      if (moderation.has(key)) return false;
      const content =
        record.target_ref.type === 'post' ? posts.get(record.target_ref.id) : comments.get(record.target_ref.id);
      // 该 revision 的内容已经存在 ⇒ 它的结论必须由提交路径写，这里不补录。
      if (content !== undefined && content.revision === record.target_ref.revision) return false;
      moderation.set(key, cloneModeration(record));
      return true;
    },
    async getModeration(kind, id, revision) {
      const record = moderation.get(moderationComposite(kind, id, revision));
      return record === undefined ? null : cloneModeration(record);
    },
    async countModeration() {
      return moderation.size;
    },

    async insertReport(record) {
      reports.set(record.id, cloneReport(record));
    },
    async getReport(id) {
      const record = reports.get(id);
      return record === undefined ? null : cloneReport(record);
    },
    async commitReportIfCurrent(id, expected, patch) {
      const current = reports.get(id);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' };
      if (current.revision !== expected.revision) return { ok: false, reason: 'REVISION_CHANGED' };
      if (expected.state !== undefined && current.state !== expected.state) {
        return { ok: false, reason: 'STATE_CHANGED' };
      }
      // 补丁白名单在类型层，但运行时可能收到 `as` 进来的对象：这里再挡一次 id/reporter 覆盖。
      const next: ReportRecord = {
        ...current,
        revision: patch.revision ?? current.revision,
        state: patch.state ?? current.state,
      };
      reports.set(id, cloneReport(next));
      return { ok: true, record: cloneReport(next) };
    },
    async purgeOwnerData(ownerId, options = {}) {
      // 口径与 `store-pg.ts` 同名实现逐条对齐（F13 保留规则，**不是**无条件软删）：
      //   1. 帖子/评论保留可见性；正文命中个人信息才改写（改写 ⇒ 旧审核摘要失效 ⇒ 待重审）；
      //   2. 媒体引用一律移除（社区没有"媒体已可靠脱敏"的证据面）；
      //   3. 作者主动删除（visibility='deleted'）的行：内容与可见性原样不动（不复活、不脱敏），
      //      但**作者关联照清**（P2 返修：删除账号映射不受"作者的删除语义"豁免）；
      //   4. 行级作者指针替换（迁移 0030）：author_id=null + 行内注销引用（不计入 records）；
      //   5. 举报清自由文本、点赞物理删除、本域幂等台账按主体清空；
      //   6. 写入后重新测量 `authorRefsRemaining`（仍指向本主体的行数，含软删行）。
      let records = 0;
      let retained = 0;
      let redacted = 0;
      let hiddenMedia = 0;
      let authorRefsReplaced = 0;
      /**
       * 注销引用（全行共用）。**惰性求值**：没有要替换的行就不生成，
       * 避免"无内容的注销"也消耗一个随机引用。
       *
       * 三态（与 `CommunityOwnerPurgeOptions` 的说明逐字对应）：
       *   · `undefined`（调用方没表态，例如直接调 store）⇒ 兜底生成（自保：绝不许写出
       *     `author_id = NULL` 而引用为空的行）；
       *   · `null`（调用方**明确**说"我拿不到引用"）⇒ **完全不替换**行级作者，
       *     由端口如实 blocked（`author-reference-unavailable`/`-failed`）；
       *   · 字符串 ⇒ 必须形状合法，否则**抛错**（与迁移 0030 的 CHECK 同口径），
       *     ⛔ 不静默换成新串（那会让同一主体分裂出两个引用）。
       */
      const providedRef = options.anonymizedAuthorRef;
      const replaceAuthorRefs = providedRef !== null;
      if (typeof providedRef === 'string' && !ANONYMIZED_AUTHOR_REF_PATTERN.test(providedRef)) {
        throw new Error('注销引用形状不合约定（拒绝写入：迁移 0030 的 CHECK 会拒绝它）');
      }
      let anonymizedRef: string | null = typeof providedRef === 'string' ? providedRef : null;
      const refForRows = (): string => {
        anonymizedRef ??= createAnonymizedAuthorRef();
        return anonymizedRef;
      };
      const stamp = new Date(clockMs()).toISOString();
      for (const [id, post] of [...posts]) {
        if (post.author_id !== ownerId) continue;
        // 作者主动删除的行：**内容/可见性/版本/updated_at 一律不动**（不复活、不脱敏、
        // 不计 retained/records），但作者指针必须清 —— 两者不冲突（P2 返修）。
        if (post.visibility === 'deleted') {
          if (replaceAuthorRefs) {
            posts.set(id, clonePost({ ...post, author_id: null, anonymized_author_ref: refForRows() }));
            authorRefsReplaced += 1;
          }
          continue;
        }
        const title = redactPersonalInfo(post.title);
        const body = redactPersonalInfo(post.body);
        const media = [...post.media_ids];
        // 作者指针替换：与正文改写**同一次写入**（内存实现天然原子；PG 侧同事务）。
        const replacedAuthor = replaceAuthorRefs && post.author_id !== null;
        const authorFields = replacedAuthor
          ? { author_id: null, anonymized_author_ref: refForRows() }
          : { author_id: post.author_id, anonymized_author_ref: post.anonymized_author_ref };
        if (title.removed + body.removed > 0) {
          // 正文改了 ⇒ revision+1（旧 ETag 与旧审核摘要都失效，读取时自动降级为待重审）。
          posts.set(
            id,
            clonePost({
              ...post,
              ...authorFields,
              title: title.text,
              body: body.text,
              media_ids: [],
              revision: post.revision + 1,
              updated_at: stamp,
            }),
          );
          records += 1;
          redacted += 1;
          hiddenMedia += media.length;
        } else if (media.length > 0) {
          // 正文安全、只隐藏媒体：**不推进 revision**（正文摘要未变，审核结论仍成立 ⇒ 内容继续可见）。
          posts.set(id, clonePost({ ...post, ...authorFields, media_ids: [], updated_at: stamp }));
          records += 1;
          retained += 1;
          hiddenMedia += media.length;
        } else {
          // 正文与媒体都没动：**保留读数照旧 +1**；作者指针若被替换，只记 authorRefsReplaced
          // （不记 records —— 替换作者指针不是"改动/删除正文"，混算会把证据读成"改了一行内容"）。
          if (replacedAuthor) posts.set(id, clonePost({ ...post, ...authorFields }));
          retained += 1;
        }
        if (replacedAuthor) authorRefsReplaced += 1;
      }
      for (const [id, comment] of [...comments]) {
        if (comment.author_id !== ownerId) continue;
        // 同帖子口径：软删评论的内容/可见性不动，作者指针照清（P2 返修）。
        if (comment.visibility === 'deleted') {
          if (replaceAuthorRefs) {
            comments.set(id, cloneComment({ ...comment, author_id: null, anonymized_author_ref: refForRows() }));
            authorRefsReplaced += 1;
          }
          continue;
        }
        const body = redactPersonalInfo(comment.body);
        const replacedAuthor = replaceAuthorRefs && comment.author_id !== null;
        const authorFields = replacedAuthor
          ? { author_id: null, anonymized_author_ref: refForRows() }
          : { author_id: comment.author_id, anonymized_author_ref: comment.anonymized_author_ref };
        if (body.removed > 0) {
          comments.set(
            id,
            cloneComment({ ...comment, ...authorFields, body: body.text, revision: comment.revision + 1 }),
          );
          records += 1;
          redacted += 1;
        } else {
          if (replacedAuthor) comments.set(id, cloneComment({ ...comment, ...authorFields }));
          retained += 1;
        }
        if (replacedAuthor) authorRefsReplaced += 1;
      }
      for (const [id, report] of [...reports]) {
        if (report.reporter_id !== ownerId || report.detail === null) continue;
        reports.set(id, cloneReport({ ...report, detail: null, revision: report.revision + 1 }));
        records += 1;
      }
      for (const [key, bucket] of [...likes]) {
        if (!bucket.delete(ownerId)) continue;
        records += 1;
        if (bucket.size === 0) likes.delete(key);
      }
      // 幂等台账的 scope 形如 `<subject>\n<METHOD>\n<path>`（`auth/idempotency.ts:111-113`），
      // 内存键再拼 `MODERATION_DELIMITER`（NUL）+ key_hash（`:268`）。主体是**首段**，
      // 因此 `ownerId + '\n'` 前缀就是「该主体在这个域里占过的全部键」——注意分隔符是换行，
      // 不是 NUL；用错分隔符会一条也删不掉，而且不会报错。
      let idempotencyRows = 0;
      for (const key of [...idempotency.keys()]) {
        if (!key.startsWith(`${ownerId}\n`)) continue;
        idempotency.delete(key);
        idempotencyRows += 1;
      }
      // 写入完成后**重新测量**「还剩多少行仍指向本主体」（帖 + 评、**含**软删行）。
      // 这是结果读数，不是从 `authorRefsReplaced` 倒推出来的：端口只认它判 blocked，
      // 所以它必须反映此刻表里真实剩下的东西（P2 返修，见 `CommunityOwnerPurgeCounts`）。
      let remainingCount = 0;
      for (const post of posts.values()) {
        if (post.author_id === ownerId) remainingCount += 1;
      }
      for (const comment of comments.values()) {
        if (comment.author_id === ownerId) remainingCount += 1;
      }
      // 与 PG 实现、端口共用**同一个**校验函数（`readAuthorRefsRemaining`）：内存实现按构造
      // 恒为非负安全整数，仍走校验是为了让"两侧同口径"落在代码上，且未来改计数时不会静默
      // 回落到"看起来清干净了"。
      const authorRefsRemaining = readAuthorRefsRemaining(remainingCount) ?? AUTHOR_REFS_REMAINING_UNKNOWN;
      return {
        records,
        idempotency: idempotencyRows,
        retained,
        redacted,
        hiddenMedia,
        authorRefsReplaced,
        authorRefsRemaining,
      };
    },

    async findIdempotency(scope, keyHash) {
      const key = idempotencyComposite(scope, keyHash);
      const slot = idempotency.get(key);
      if (slot === undefined) return null;
      if (slot.expires_at <= clockMs()) {
        idempotency.delete(key);
        return null;
      }
      if (slot.outcome === null) return null;
      return {
        request_hash: slot.request_hash,
        response_status: slot.response_status,
        outcome: { ...slot.outcome },
        expires_at: slot.expires_at,
      };
    },
    async claimIdempotency(scope, keyHash, claim) {
      const key = idempotencyComposite(scope, keyHash);
      const slot = idempotency.get(key);
      if (slot !== undefined && slot.expires_at > clockMs()) return false;
      idempotency.set(key, {
        request_hash: claim.request_hash,
        response_status: claim.response_status,
        outcome: null,
        expires_at: claim.expires_at,
        waiters: [],
      });
      return true;
    },
    async completeIdempotency(scope, keyHash, done) {
      const slot = idempotency.get(idempotencyComposite(scope, keyHash));
      if (slot === undefined || slot.outcome !== null) return false;
      slot.outcome = { ...done.outcome };
      slot.response_status = done.response_status;
      settle(scope, keyHash);
      return true;
    },
    async releaseIdempotency(scope, keyHash) {
      const key = idempotencyComposite(scope, keyHash);
      const slot = idempotency.get(key);
      if (slot === undefined || slot.outcome !== null) return;
      idempotency.delete(key);
      settle(scope, keyHash);
    },
    async awaitIdempotencySettled(scope, keyHash, waitMs) {
      const slot = idempotency.get(idempotencyComposite(scope, keyHash));
      if (slot === undefined || slot.outcome !== null) return 'settled';
      return new Promise<'settled' | 'timeout'>((resolve) => {
        const timer = setTimeout(() => {
          const index = slot.waiters.indexOf(wake);
          if (index >= 0) slot.waiters.splice(index, 1);
          resolve('timeout');
        }, waitMs);
        // 不因等待者而拖住进程退出。
        if (typeof timer.unref === 'function') timer.unref();
        const wake = (): void => {
          clearTimeout(timer);
          resolve('settled');
        };
        slot.waiters.push(wake);
      });
    },

    snapshotCounts() {
      return {
        posts: posts.size,
        comments: comments.size,
        reports: reports.size,
        moderation: moderation.size,
      };
    },
  };
}
