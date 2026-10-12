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
import type { CommunityPostPort } from './types.ts';

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
