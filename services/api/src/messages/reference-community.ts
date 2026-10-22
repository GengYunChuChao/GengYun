/**
 * GY-I17（#17）· G4：把**社区域**的"公开可读"判据接成消息跳转目标可用性端口。
 *
 * ## 为什么需要这一层
 *
 * `reference.ts` 只定义契约闭集 `available|unavailable` 与 fail-closed 规范化；
 * "某个 `post`/`comment` 现在能不能读"是社区域的权威判据（可见性 + 审核结论 + 父帖，
 * 见 `community/service.ts` 的 `publiclyVisibleTarget`）。本文件**只做转接**，
 * 不复制、不近似任何业务判定：判定唯一的来源是注入进来的 `isPubliclyVisible`。
 *
 * ## 三条硬边界
 *
 * 1. **不做第二份判定**：这里没有"如果 xxx 就算可见"的旁路；拿不到社区判据就 `unavailable`。
 * 2. **存在性不泄露**：只有 `post`/`comment` 两种目标可能 `available`，其余目标类型
 *    （`species`/`conversation`/`job`… 目前未接线）与任何异常一律 `unavailable`；
 *    且社区判据本身已把"不存在/未发布/已下架/无权"折叠成同一个 `false`，
 *    因此对外**同形**，无法据此区分目标到底处于哪种状态。
 * 3. **逐次重查**：每次读取都重新问一次社区域（不缓存），所以"投递时能跳 → 下架后点不动"
 *    是同一条消息、同一个 id 上的真实迁移，不依赖任何清缓存动作。
 *
 * ## 为什么是"读取器"而不是"实例"
 *
 * 装配顺序是**先消息域、后社区域**（`app.ts`：消息服务在社区服务之前构造）。若这里直接收
 * 社区服务实例，就必须调整整段装配顺序；因此注入的是 `community()` 惰性读取器，由装配层在
 * 社区域构造完成后补一次赋值。**漏了那次赋值 ⇒ 恒 `unavailable`**（不是 500、不是 available），
 * 这正是 fail-closed 想要的姿势，也让"赋值真的发生了"可以用行为断言钉住。
 *
 * ## 主体维度
 *
 * 社区帖子/评论是**公开内容**：登录用户之间的读权限没有差异，因此判据与 `userId` 无关。
 * 一旦社区域引入按主体的可见性（例如仅作者可见的草稿），本端口的 `resolve` 已拿到
 * `userId`，接线处补判即可——届时**不要**在消息域里另写一套。
 */

import { createWiredReferencePort } from './reference.ts';
import type { MessageReferencePort } from './reference.ts';

/** 社区域可注入的**唯一**只读判据（与 `CommunityService['visibility']` 同形）。 */
export interface CommunityPublicVisibility {
  /** `true` = 该目标此刻公开可读；其余一切（不存在/未发布/下架/无权/审核退回）都是 `false`。 */
  isPubliclyVisible(kind: 'post' | 'comment', id: string): Promise<boolean>;
}

export interface CommunityReferencePortOptions {
  /** 后绑定读取器：返回当前装配的社区判据；未接线时返回 `null`（⇒ 一律 `unavailable`）。 */
  community(): CommunityPublicVisibility | null;
}

export function createCommunityReferencePort(options: CommunityReferencePortOptions): MessageReferencePort {
  return createWiredReferencePort({
    note: '跳转目标可用性已接线：逐次按社区域公开可读判据核验（只回答契约闭集取值）',
    async resolve({ target_ref }) {
      if (target_ref.type !== 'post' && target_ref.type !== 'comment') return 'unavailable';
      const community = options.community();
      if (community === null) return 'unavailable';
      const readable = await community.isPubliclyVisible(target_ref.type, target_ref.id);
      return readable === true ? 'available' : 'unavailable';
    },
  });
}
