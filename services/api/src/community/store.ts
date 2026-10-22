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

export interface PostRecord {
  id: string;
  revision: number;
  author_id: string;
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
  author_id: string;
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

export interface ReportRecord {
  id: string;
  revision: number;
  reporter_id: string;
  target_ref: ReportTarget;
  state: 'received' | 'isolated' | 'closed';
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
 * `listPosts` 的**下推筛选**（SQL 实现把每一项都写进 `WHERE`，内存实现逐项等价过滤）。
 *
 * 口径与 `GET /posts` 的既有参数一一对应，**没有新增契约参数**：
 *   - `scope: 'public'` ⇒ 公开列表的**候选集**（`visibility = 'published'`）。规则版本/正文摘要
 *     复核仍由服务层 `isPubliclyVisible()` 逐行确认——那部分取决于规则层与审核域台账，不是 SQL
 *     能判定的谓词，所以只把「结构上不可能公开」的行（`private`/`hidden`/`deleted`）挡在库外。
 *   - `scope: 'mine'` ⇒ 「我的发布」：`visibility <> 'deleted'` + `author_id = authorId`（含未公开版本）。
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
  | 'AUDIT_STATE_CHANGED';

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
