/**
 * GY-I18 阶段 1b · `hidePost` 适配层。
 *
 * 纪律（派单第 2 条）：**复用社区的可见性语义**，不在 admin 里另写一套可见性/审核判定。
 * 因此这里只做三件事：
 *   1. 调社区 store 的 `getPost` 读当前状态（拿到是否已隐藏 / 已删除 / 当前 revision）；
 *   2. **先**比对调用方给的期望 revision（`If-Match` 的服务端等价物），不匹配就**不写**；
 *   3. 调社区 store **唯一的更新原语** `commitPostIfCurrent`（CAS）把 `visibility` 置为 `'hidden'`，
 *      并把 CAS 的结果如实映射——**绝不**自己拼 visibility、**绝不**自己判断"能不能复活"。
 *
 * 「已删除不可复活」由社区 CAS 自己保证（`community/store.ts` 中
 * `current.visibility === 'deleted'` ⇒ `{ok:false, reason:'DELETED'}`，是单向门）。
 * 本层把该失败**如实**映射成拒绝，不会把 DELETED 谎报成成功。
 *
 * 「退出列表」同样由社区读取侧保证：`community/service.ts` 的口径是
 * 「对外可见 ⟺ `visibility === 'published'` 且 `audit_state === 'approved'`」，
 * 置为 `hidden` 后所有公开读（列表与详情）都会把它排除。
 */
import type { PostRecord } from '../../community/store.ts';
import type { AuditState, Visibility } from '../../community/types.ts';
import type { CommunityPostPort, CommunityPostReadPort } from './types.ts';

export type HidePostResult =
  | { ok: true; changed: boolean; previousRevision: number; revision: number }
  | { ok: false; reason: 'NOT_FOUND' | 'DELETED' | 'NOT_PUBLIC' | 'REVISION_CONFLICT' | 'STORE_UNAVAILABLE' };

export interface HidePostAdapter {
  readonly wired: boolean;
  /** `expectedRevision` 必须在**任何写入之前**比对（避免"先隐藏再报冲突"的部分生效）。 */
  hide(id: string, expectedRevision: number): Promise<HidePostResult>;
}

export function createHidePostAdapter(port: CommunityPostPort | undefined, now: () => Date): HidePostAdapter {
  if (port === undefined) {
    return Object.freeze({
      wired: false,
      hide: async (): Promise<HidePostResult> => ({ ok: false, reason: 'STORE_UNAVAILABLE' }),
    });
  }
  const community = port;

  return Object.freeze({
    wired: true,
    async hide(id: string, expectedRevision: number): Promise<HidePostResult> {
      const current = await community.getPost(id);
      if (current === null) return { ok: false, reason: 'NOT_FOUND' };
      // 已删除是单向门：真正的守卫在社区 CAS 里（下面同样会拒），这里先如实回拒。
      if (current.visibility === 'deleted') return { ok: false, reason: 'DELETED' };
      // If-Match 的服务端等价物：**写之前**比对，避免部分生效。
      if (current.revision !== expectedRevision) return { ok: false, reason: 'REVISION_CONFLICT' };
      // 幂等：已经隐藏 ⇒ 不再迁移、不再记审计。
      if (current.visibility === 'hidden') {
        return { ok: true, changed: false, previousRevision: current.revision, revision: current.revision };
      }
      // 作者的未发布草稿不改写（显式的 fail-closed 策略，见报告）。
      if (current.visibility !== 'published') return { ok: false, reason: 'NOT_PUBLIC' };

      const result = await community.commitPostIfCurrent(
        id,
        { revision: current.revision, visibility: current.visibility },
        { revision: current.revision + 1, visibility: 'hidden', updated_at: now().toISOString() },
        null,
      );
      if (!result.ok) {
        if (result.reason === 'DELETED') return { ok: false, reason: 'DELETED' };
        if (result.reason === 'NOT_FOUND') return { ok: false, reason: 'NOT_FOUND' };
        // REVISION_CHANGED / VISIBILITY_CHANGED / AUDIT_STATE_CHANGED / AUTHOR_CHANGED
        return { ok: false, reason: 'REVISION_CONFLICT' };
      }
      return { ok: true, changed: true, previousRevision: current.revision, revision: result.record.revision };
    },
  });
}

/* ------------------------------------------------------------------ *
 * R59 · 后台帖子**读面**适配层（`listAdminPosts` / `getAdminPost`）
 * ------------------------------------------------------------------ */

/** 已解析的后台列表查询（游标已在服务层验签+解出，这里只做下推）。 */
export interface AdminPostPageQuery {
  readonly limit: number;
  readonly after: { createdAt: string; id: string } | null;
  readonly state: Visibility | null;
  readonly auditState: AuditState | null;
}

export interface AdminPostReadAdapter {
  /**
   * 管理视角一页。**强制** `scope: 'admin'` —— 这是本读面的定义：
   * 候选集里必须有 `hidden` / `deleted`（用户读面 `scope: 'public'` 会把它们全部排除），
   * 否则管理员看不到自己要处置的行。`state` / `auditState` 只做**等值收窄**，不做可见性判定。
   */
  list(query: AdminPostPageQuery): Promise<{ items: PostRecord[]; hasMore: boolean }>;
  /** 管理视角单条。`null` ⇒ 不存在（服务层映射 404，⛔ 不用 403 泄露存在性）。 */
  get(id: string): Promise<PostRecord | null>;
}

/**
 * `port` 未接线 ⇒ 返回 `null`（服务层 fail-closed 503）。
 * ⛔ 不返回"空页适配器"：空列表会被读成「库里没有帖子」，那是伪造读数。
 */
export function createAdminPostReadAdapter(port: CommunityPostReadPort | undefined): AdminPostReadAdapter | null {
  if (port === undefined) return null;
  const community = port;

  return Object.freeze({
    async list(query: AdminPostPageQuery): Promise<{ items: PostRecord[]; hasMore: boolean }> {
      // 多取一行判定 `next_cursor`，返回前截掉——比再跑一次 count 便宜，且不会给出总数
      // （后台列表契约明确不返回总数，见 `AdminPostPageEnvelope` 描述）。
      const rows = await community.listPosts({
        scope: 'admin',
        state: query.state ?? undefined,
        auditState: query.auditState ?? undefined,
        after: query.after,
        limit: query.limit + 1,
      });
      const hasMore = rows.length > query.limit;
      return { items: hasMore ? rows.slice(0, query.limit) : rows, hasMore };
    },
    async get(id: string): Promise<PostRecord | null> {
      return community.getPost(id);
    },
  });
}
