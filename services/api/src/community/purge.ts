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
 * ## 落地点（R31-F13 后续切片，迁移 0030）
 *
 * 上一版（PR #474）如实 blocked 了两项，因为当时没有落点：
 *   1. `author-row-reference-not-replaced`：`community_posts/comments.author_id` 是
 *      `uuid NOT NULL REFERENCES users ON DELETE CASCADE`，且运行时的 `UPDATE` 列级授权不含
 *      `author_id` ⇒ 无法把行级作者换成注销引用；
 *   2. `author-reference-not-durable`：注销引用只在 `authors.ts` 的进程内 Map 里，重启即丢。
 *
 * 本片把两者**同时**解决，因此两个原因码在正常路径上**不再出现**：
 *   - 迁移 0030：`author_id` 可空 + 行内列 `anonymized_author_ref`（CHECK：恰好一个非空）；
 *   - 授权：`20-login-roles.sql` 的两表 `SELECT`/`UPDATE` 列清单补上这两列；
 *   - 写路径：`store.purgeOwnerData(ownerId, { anonymizedAuthorRef })` 在同一事务里
 *     `author_id = NULL, anonymized_author_ref = <ref>`；
 *   - 读路径：`service.ts` 用 `author_id ?? anonymized_author_ref` 投影，`authors.resolve()`
 *     对**行内引用**直接投影 ⇒ 不依赖任何进程内状态。
 *
 * ## 仍然如实 blocked 的两项（能力缺失/调用失败，不谎称完成）
 *
 *   - `author-reference-unavailable`：注入的作者目录**没有** `anonymize` 能力 ⇒ 生成不出
 *     注销引用（也就无法安全地把 `author_id` 置空：那会写出"两个作者字段都空"的行，
 *     撞 0030 的 CHECK）。此时**不替换**行级作者，如实 blocked。
 *   - `author-reference-failed`：`anonymize` 抛错，或返回的引用**形状不合法**
 *     （`^gy-anon-[0-9a-f]{16}$`，与库侧 CHECK 同源）。同上，不替换、如实 blocked。
 *
 * 另有一条**结果判据**：`author-row-reference-not-replaced`。它不再只是"防御性"的：
 * P2 返修（监工 PR #483）前，这里只检查"换了几行"（`authorRefsReplaced === 0`）⇒ 同主体
 * 「普通行 + 已软删行」时普通行替换成功（>0）、平台判 completed，而软删行仍以原 `author_id`
 * 直接关联账户。现在判据改为**清理后重新测量的剩余 owner 引用**（`authorRefsRemaining`，
 * 含软删行）：只要还剩一行指向该账户，就去身份未完成 ⇒ `blocked` + 本原因码。
 *
 * ## fail-closed：证明不了就不算完成（P2 返修残留 fail-open 收口）
 *
 * 上一版在该读数**缺失**时回落到旧判据（`authorRefsReplaced === 0` + retained/redacted > 0）。
 * 对抗性审查探针 P6 实测：替身/实现不报告该读数时仍会静默 `completed`；P6b 还测出
 * `"3"` / `-1` / `1.5` / `NaN` / `Infinity` 一律回落旧判据 ⇒ `blocked = 0`。监工批语：
 * 「已软删除帖评仍保留原作者关联，社区去身份回执却可能报告 completed，存在隐私与完成状态
 * 失真。」因此本端口的口径是：
 *   - 读数必须是**可信的非负安全整数**（`readAuthorRefsRemaining`）；缺失 / 非数 / 非整数 /
 *     负数 / 非有限值 ⇒ 一律 `blocked` + `author-refs-remaining-unknown`（"无法证明已清干净"）；
 *   - 旧判据**整个删除**：它正是 fail-open 的来源，⛔ 不保留为"保底"，⛔ 不得回落到它；
 *   - `0` 仍是唯一的完成读数；`>0` 仍是 `author-row-reference-not-replaced`。
 *
 * 计数口径：`blocked` 是**未完成的处理项数**（不是行数）。一个主体的作者引用问题算 1 项，
 * 具体缺什么写在 `blockedReasons` 里；行级读数（retained/redacted/hiddenMedia/authorRefsReplaced/
 * authorRefsRemaining）另列，⛔ 不把"保留了多少行"混算成"完成了多少"，也不把"换了几行"
 * 混算成"还剩几行"。
 */
import type { AuthorDirectory } from './types.ts';
import type { CommunityOwnerPurgeCounts, CommunityStore } from './store.ts';
import { readAuthorRefsRemaining } from './store.ts';
import { ANONYMIZED_AUTHOR_REF_PATTERN } from './authors.ts';

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
  /**
   * **仍有行以原 `author_id` 关联本账户**（去身份未完成）。
   *
   * 判据口径（P2 返修）：以存储清理后**重新测量**的 `authorRefsRemaining` 为准，**含**
   * `visibility='deleted'` 的行；⛔ 不再以"换了几行 > 0"推断完成 —— 那正是 PR #483 [P2]
   * 「普通行替换成功、软删行仍关联账户，回执 completed」的成因。
   */
  ROW_REFERENCE: 'author-row-reference-not-replaced',
  /**
   * **无法证明已清干净**：存储没有报告可信的 `authorRefsRemaining`（缺失 / 非数 / 非整数 /
   * 负数 / 非有限值）。
   *
   * 为什么不复用 `ROW_REFERENCE`：两者的事实不同 —— 那个是"**已证实**还有行指向账户"，
   * 这个是"连还剩几行都不知道"。用前者会把"读数缺失"伪装成"已确认残留"，用 `completed`
   * 会把"未知"伪装成"清干净"；两种都失真。口径是 fail-closed：⛔ 不回落旧判据
   * （`authorRefsReplaced === 0` 那种"换过几行就算完"的推断正是 fail-open 的来源）。
   */
  REMAINING_UNKNOWN: 'author-refs-remaining-unknown',
  /**
   * 注销引用**未持久化**（只有进程内 Map）。
   *
   * 0030 之后引用落在行上 ⇒ 正常路径不再出现；保留码位是为了让"某个存储实现把引用只放进内存"
   * 这种回退仍可被如实上报（届时它必然同时命中 `ROW_REFERENCE`）。
   */
  NOT_DURABLE: 'author-reference-not-durable',
  /** 作者目录没有 `anonymize` 能力 ⇒ 生成不出注销引用（能力缺失，如实 blocked）。 */
  UNAVAILABLE: 'author-reference-unavailable',
  /** `anonymize` 抛错或返回形状不合法的引用（调用失败，如实 blocked）。 */
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
    const blockedReasons: string[] = [];
    // ---- 先拿注销引用（顺序重要：引用要随同一次存储事务写进行里）----
    let anonymizedRef: string | null = null;
    const anonymize = authors.anonymize;
    if (typeof anonymize !== 'function') {
      blockedReasons.push(AUTHOR_REFERENCE_BLOCKED_REASONS.UNAVAILABLE);
    } else {
      try {
        const author = await anonymize.call(authors, ownerId);
        const candidate = typeof author?.display_id === 'string' ? author.display_id : '';
        if (ANONYMIZED_AUTHOR_REF_PATTERN.test(candidate)) {
          anonymizedRef = candidate;
        } else {
          // 形状不合约定 ⇒ 写进库里必然撞 0030 的 CHECK；这里就判失败，不带着坏值去写。
          blockedReasons.push(AUTHOR_REFERENCE_BLOCKED_REASONS.FAILED);
        }
      } catch {
        // 不把异常上抛：存储侧尚未执行，没有半成品；但"生成不出引用"必须如实进 blocked。
        blockedReasons.push(AUTHOR_REFERENCE_BLOCKED_REASONS.FAILED);
      }
    }
    // 拿不到引用就传 `null`（**明确**表态，不是"没传"）：存储侧因此完全不替换行级作者 ——
    // 否则会写出"两个作者字段都空"的行，撞迁移 0030 的 CHECK。
    // ⛔ 不要写成 `anonymizedRef === null ? undefined : {...}`：`undefined` 的语义是
    // "调用方没表态，请兜底生成"，那会把"能力缺失"悄悄变成"看起来完成了"。
    const counts = await purge.call(store, ownerId, { anonymizedAuthorRef: anonymizedRef });
    // ⚠️ 判据（P2 返修 · 监工 PR #483 的**残留 fail-open** 收口）：只看"换了几行"会漏掉
    // "部分行没换"；而"读数缺失就回落到旧判据"会漏掉"**根本没证明清干净**"。
    // 同主体「普通行 + 已软删行」时普通行替换成功（`authorRefsReplaced > 0`），软删行仍以原
    // `author_id` 直接关联账户 —— 审查探针 P6 实测：替身不报告该读数时，旧实现回落到
    // `authorRefsReplaced === 0` ⇒ 静默 `completed`；P6b 还测出 `"3"/-1/1.5/NaN/Infinity`
    // 一律回落。监工批语：「已软删除帖评仍保留原作者关联，社区去身份回执却可能报告 completed，
    // 存在隐私与完成状态失真。」
    // 因此只认一个方向：**证明得了 0 才叫完成**；证明不了（缺失/非数/非整数/负数/非有限值）
    // ⇒ blocked + `author-refs-remaining-unknown`。⛔ 不得回落旧判据（它正是 fail-open 的来源，
    // 已整个删除），⛔ 不得把"没读到"当成 0。
    const authorRefsRemaining = readAuthorRefsRemaining(counts.authorRefsRemaining);
    if (authorRefsRemaining === null) {
      blockedReasons.push(AUTHOR_REFERENCE_BLOCKED_REASONS.REMAINING_UNKNOWN);
    } else if (authorRefsRemaining > 0) {
      blockedReasons.push(AUTHOR_REFERENCE_BLOCKED_REASONS.ROW_REFERENCE);
    }
    // 去重（同一原因不重复计数）：blocked 是"处理项数"，不是"命中的判据条数"。
    const uniqueReasons = [...new Set(blockedReasons)];
    const blocked = uniqueReasons.length > 0 ? 1 : 0;
    return { ...counts, blocked, blockedReasons: uniqueReasons };
  }

  return {
    async deleteAllByOwner(ownerId) {
      return (await purgeOwnerData(ownerId)).records;
    },
    purgeOwnerData,
  };
}
