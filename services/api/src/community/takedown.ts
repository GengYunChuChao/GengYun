/**
 * GY-I15（#15）阶段 2 · 下架观察器（装配层接线，**不修改 admin/** 与 messages/**）。
 *
 * ## 问题
 *
 * 「下架」这条路径是**后台**发起的：`POST /admin/posts/{id}/hide` →
 * `admin/ops/community-posts.ts::createHidePostAdapter` → 社区 store 的**唯一更新原语**
 * `commitPostIfCurrent`（把 `visibility` 置为 `'hidden'`）。社区服务层（`community/service.ts`）
 * 不在这条调用链上，因此**看不到**这次下架，也就无法投递「下架」事件。
 *
 * ## 做法（唯一改动点：装配层）
 *
 * 在**装配层**给交给后台的社区帖子端口套一层**只读观察**：`commitPostIfCurrent` 委托给
 * 真实 store，**提交成功且结果确实把该帖置为 `hidden`** 时，投递一条 `takedown` 事件到
 * 消息中心公开端口。除此之外**不改变任何行为**：不改 visibility、不自己判"能不能隐藏"、
 * 不改错误映射、不缓存、不加锁——权威判定与写入仍然只在社区 store 的 CAS 里。
 *
 * ## 为什么不用社区服务层重建一套
 *
 * 「下架后列表/详情引用一致」由社区 CAS（单向门 + 读取时重算可见性）保证；
 * 观察器**只**发通知。若通知失败（端口未接线/消息域拒绝），下架本身仍然生效，
 * 只是如实记为未投递 —— 绝不因为"发不出消息"就回滚一次已生效的合规处置。
 */
import type { CommunityEventsPort } from './events.ts';
import type { CommitResult, CommunityStore, PostCommitExpectation, PostCommitPatch, PostRecord } from './store.ts';

/** 后台侧需要的社区帖子端口形状（= `admin/ops/types.ts` 的 `CommunityPostPort`）。 */
export type CommunityPostStorePort = Pick<CommunityStore, 'getPost' | 'commitPostIfCurrent'>;

export interface TakedownObserverOptions {
  events: CommunityEventsPort;
  /** 处置原因码（内部标签，只参与事件去重键，不进契约响应）。 */
  reason?: string;
}

/**
 * 包装社区帖子端口，观测「已生效的下架」。
 *
 * 判定严格：**CAS 成功** 且 **返回记录的当前 `visibility === 'hidden'`** 且
 * **本次提交的补丁显式要求 `hidden`**。三者缺一不发（例如后台的幂等路径
 * `changed:false` 根本不调用 CAS，自然不重复发）。
 *
 * ## 事件版本口径（与审核域下架键**同一套**）
 *
 * 事件的 `target.revision` 取 **`expected.revision`＝被下架的那一版（处置前）**，
 * 不取处置后的 `result.record.revision`（隐藏会把 revision +1）。理由：
 *   - 被公开发布、被读取缓存、被审核域 `cache.invalidateTarget` 键住的都是**处置前那一版**；
 *   - 事件若带处置后的版本，任何"按事件失效缓存/核对版本"的消费者都会算错键，
 *     恰好失效不到真正在缓存里的那一版（详见 `.pg17/analysis/i14-moderation-gaps-20261019.md` R6）；
 *   - CAS 成功本身即证明 `expected.revision` 就是提交前的当前版本，无需再读一次。
 */
export function withTakedownObserver(
  store: CommunityPostStorePort,
  options: TakedownObserverOptions,
): CommunityPostStorePort {
  const reason = options.reason ?? 'admin_hide';
  return {
    getPost(id: string): Promise<PostRecord | null> {
      return store.getPost(id);
    },
    async commitPostIfCurrent(
      id: string,
      expected: PostCommitExpectation,
      patch: PostCommitPatch,
      moderation: Parameters<CommunityStore['commitPostIfCurrent']>[3],
    ): Promise<CommitResult<PostRecord>> {
      const result = await store.commitPostIfCurrent(id, expected, patch, moderation);
      if (result.ok && patch.visibility === 'hidden' && result.record.visibility === 'hidden') {
        try {
          // 迁移 0030：已注销内容（`author_id = NULL`）**没有可通知的账户主体** ⇒ 不投递。
          // ⛔ 不要给事件塞 `ownerId: null`：事件端口按契约要求非空主体，那会造一条无人可收的孤儿通知。
          if (result.record.author_id !== null) {
            await options.events.publish({
              event: 'takedown',
              ownerId: result.record.author_id,
              target: { type: 'post', id: result.record.id, revision: expected.revision },
              reason,
            });
          }
        } catch {
          // 通知失败不影响已生效的处置；事件端口自身如实标注未投递。
        }
      }
      return result;
    },
  };
}
