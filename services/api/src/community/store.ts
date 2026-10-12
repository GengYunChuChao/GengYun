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

export interface CommunityStore {
  readonly persistent: boolean;
  // ---- 帖子 ----
  insertPost(record: PostRecord): Promise<void>;
  getPost(id: string): Promise<PostRecord | null>;
  replacePost(record: PostRecord): Promise<boolean>;
  listPosts(): Promise<PostRecord[]>;
  // ---- 评论 ----
  insertComment(record: CommentRecord): Promise<void>;
  getComment(id: string): Promise<CommentRecord | null>;
  replaceComment(record: CommentRecord): Promise<boolean>;
  listComments(postId: string): Promise<CommentRecord[]>;
  // ---- 点赞（集合语义：同主体同目标至多 1 条，计数由集合大小派生，永不为负）----
  addLike(kind: 'post' | 'comment', targetId: string, userId: string): Promise<boolean>;
  removeLike(kind: 'post' | 'comment', targetId: string, userId: string): Promise<boolean>;
  countLikes(kind: 'post' | 'comment', targetId: string): Promise<number>;
  // ---- 审核结论台账 ----
  putModeration(record: ModerationRecord): Promise<void>;
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

  return {
    persistent: false,

    async insertPost(record) {
      posts.set(record.id, clonePost(record));
    },
    async getPost(id) {
      const record = posts.get(id);
      return record === undefined ? null : clonePost(record);
    },
    async replacePost(record) {
      if (!posts.has(record.id)) return false;
      posts.set(record.id, clonePost(record));
      return true;
    },
    async listPosts() {
      return [...posts.values()].map(clonePost).sort(compareCreatedAtDescending);
    },

    async insertComment(record) {
      comments.set(record.id, cloneComment(record));
    },
    async getComment(id) {
      const record = comments.get(id);
      return record === undefined ? null : cloneComment(record);
    },
    async replaceComment(record) {
      if (!comments.has(record.id)) return false;
      comments.set(record.id, cloneComment(record));
      return true;
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

    async putModeration(record) {
      moderation.set(moderationComposite(record.target_ref.type, record.target_ref.id, record.target_ref.revision), cloneModeration(record));
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
