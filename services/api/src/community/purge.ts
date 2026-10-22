/**
 * GY-I15（#15）· 社区域**注销保留/去身份端口**（F13 第 279–280 行；P2 返修新增）。
 *
 * 为什么需要单独的端口（而不是让 `app.ts` 里写两行）：
 *   - 注销路径要同时做**两件事**：清社区行（`store.purgeOwnerData`）＋把该主体的作者投影
 *     换成注销引用（`AuthorDirectory.anonymize`）。两件事必须**同源**（同一个 store、同一个
 *     作者目录），否则会出现"内容保留了、作者还是原假名"或"作者匿名了、内容却没处理"；
 *   - 装配（`app.ts`）与测试必须走**同一条路**，否则测的就不是生产路径；
 *   - `blocked` 的判定要基于**两者的真实结果**，集中在这里才不会在各处漂移。
 *
 * ## blocked：哪些算"未完成"（如实计数，不计入 completed）
 *
 * 1. `author-row-reference-not-replaced`：行级内部作者列（`community_posts.author_id` /
 *    `community_comments.author_id`）仍是**原账户 id**。这不是实现偷懒，而是 schema/授权约束：
 *    两列都是 `uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE`（迁移 `0022`），
 *    且运行时角色对两表的 `UPDATE` 列级授权**不含 `author_id`**（`deploy/postgres-cvm/sql/
 *    20-login-roles.sql`）；本片**不新增迁移、不改授权** ⇒ 无法把行级作者改成随机引用。
 *    投影层已经换成随机注销引用（`AuthorDirectory.anonymize`），但这不等于 F13 的
 *    「内部作者换注销引用、删除账号映射」全部完成 ⇒ 如实记 blocked。
 * 2. `author-reference-not-durable`：注销引用只存在进程内（阶段 1 本地假名投影），
 *    重启即丢。author_links/public_authors 未接线、本片不新增迁移 ⇒ 未持久化。
 * 3. `author-reference-unavailable` / `author-reference-failed`：注入的作者目录没有
 *    `anonymize` 能力，或调用失败 ⇒ 投影也没换成注销引用（更严重，但仍如实 blocked）。
 *
 * 计数口径：`blocked` 是**未完成的处理项数**（不是行数）。一个主体的作者引用问题算 1 项，
 * 具体缺什么写在 `blockedReasons` 里；行级读数（retained/redacted/hiddenMedia）另列，
 * ⛔ 不把"保留了多少行"混算成"完成了多少"。
 */
import type { AuthorDirectory } from './types.ts';
import type { CommunityOwnerPurgeCounts, CommunityStore } from './store.ts';

/** 端口返回值：存储分表计数 + 注销装配层补的 blocked 读数。 */
export interface CommunityOwnerPurgeResult extends CommunityOwnerPurgeCounts {
  /** 未完成的处理项数（0 = 本端口负责的部分都完成了）。 */
  blocked: number;
  /** 未完成项的原因码（只含闭集常量，不含任何私有数据）。 */
  blockedReasons: readonly string[];
}

/** 注销协议要的形状（与 `privacy/user-data-deletion.ts` 的 `OwnerPurgeStore` 结构兼容）。 */
export interface CommunityOwnerPurgePort {
  deleteAllByOwner(ownerId: string): Promise<number>;
  purgeOwnerData(ownerId: string): Promise<CommunityOwnerPurgeResult>;
}

export const AUTHOR_REFERENCE_BLOCKED_REASONS = Object.freeze({
  ROW_REFERENCE: 'author-row-reference-not-replaced',
  NOT_DURABLE: 'author-reference-not-durable',
  UNAVAILABLE: 'author-reference-unavailable',
  FAILED: 'author-reference-failed',
});

export function createCommunityOwnerPurgePort(options: {
  store: Pick<CommunityStore, 'purgeOwnerData'>;
  authors: AuthorDirectory;
}): CommunityOwnerPurgePort {
  const { store, authors } = options;

  async function purgeOwnerData(ownerId: string): Promise<CommunityOwnerPurgeResult> {
    const purge = store.purgeOwnerData;
    if (typeof purge !== 'function') {
      // 与既有装配同口径：没有清理原语 ⇒ 调用即抛（协议折叠为 blocked + HANDLER_FAILED），
      // ⛔ 不在装配期假装"能清"，也不静默返回 0 行。
      throw new Error('社区域存储未实现按主体清理（purgeOwnerData）：拒绝假装清空');
    }
    const counts = await purge.call(store, ownerId);
    const blockedReasons: string[] = [];
    let blocked = 0;
    const hasRetainedContent = counts.retained + counts.redacted > 0;
    if (hasRetainedContent) {
      // 有需要保留/去身份的内容 ⇒ 作者引用这条要求才真正被触发。
      blocked += 1;
      blockedReasons.push(AUTHOR_REFERENCE_BLOCKED_REASONS.ROW_REFERENCE);
      blockedReasons.push(AUTHOR_REFERENCE_BLOCKED_REASONS.NOT_DURABLE);
      const anonymize = authors.anonymize;
      if (typeof anonymize !== 'function') {
        blockedReasons.push(AUTHOR_REFERENCE_BLOCKED_REASONS.UNAVAILABLE);
      } else {
        try {
          await anonymize.call(authors, ownerId);
        } catch {
          // 不把异常上抛：存储侧已提交的保留/脱敏结果必须如实带出；失败项计入 blocked。
          blockedReasons.push(AUTHOR_REFERENCE_BLOCKED_REASONS.FAILED);
        }
      }
    }
    return { ...counts, blocked, blockedReasons };
  }

  return {
    async deleteAllByOwner(ownerId) {
      return (await purgeOwnerData(ownerId)).records;
    },
    purgeOwnerData,
  };
}
