/**
 * GY-I15（#15）阶段 1 · 作者投影（可注入）。
 *
 * 契约 `Author` 说明：`revision` 来自 `public_authors`，不是 post/media revision；
 * `avatar_media` 仅在"当前公开且头像独立筛查通过/公开用途有效"时非 null。
 *
 * 本片**没有**接 `public_authors`（阶段 2 接 GY-I04/GY-I05 的作者与头像来源），
 * 因此这里只提供**本地假名投影**：由内部 userId 派生稳定的假名 id 与显示名，
 * **不含**真实微信身份、手机号、头像或任何可反查个人的信息。
 *
 * 声明（不得误读）：
 *   - 这不是身份核验，也不是"真实用户资料"；生产必须注入真实 `public_authors` 读者；
 *   - 因此 `createCommunityService` **要求显式传入** `authors`，不提供默认值——
 *     避免某个接线点忘了接作者来源时，悄悄用假名当真实作者。
 *
 * ## 注销去身份（F13 第 279 行；本片 P2 返修）
 *
 * F13 原文：「帖子评论保留，头像默认，前台显示名／ID为"已注销用户"；内部作者换**不可反查原账户
 * 的注销引用**，删除账号映射，不把所有作者主键混为一个账号。」配套文档（ADR-001、
 * data-dictionary、state-contract）逐字要求**随机、逐作者**的注销引用。
 *
 * 因此匿名化不是把 userId 再做一次摘要（那仍可"拿候选 id 一一确认"，不是不可反查），而是：
 *   - 每个注销主体分配一个 **crypto 随机** 的 `display_id`（`gy-anon-<16 hex>`）；
 *   - 逐作者独立（不同注销者不共用引用，F13「不混为一个账号」）；
 *   - 同一作者在同一进程内**稳定**（多次解析得到同一引用，不能每次刷新换一个）；
 *   - 不包含 userId、不由 userId 派生。
 *
 * ## 持久化落点（R31-F13 后续切片，迁移 0030）
 *
 * 上一版（PR #474）的边界是：注销引用只存在进程内 `Map`，重启即丢 ⇒ 注销装配处如实
 * `blocked`（`author-reference-not-durable`）。迁移 0030 把引用**落到内容行上**
 * （`community_posts/comments.anonymized_author_ref`），于是：
 *   - 写路径：注销事务把 `author_id` 置 NULL、把本模块生成的引用写进那些行
 *     （`store-pg.ts` / `store.ts` 的 `purgeOwnerData`）；
 *   - 读路径：`resolve()` 收到**行内引用**（形状 `^gy-anon-[0-9a-f]{16}$`）时**直接**投影成
 *     已注销作者，**不查任何进程内状态** ⇒ 重启、多副本、跨进程读同一行得同一串。
 *
 * 进程内 `Map` 仍然保留（`anonymize` 会写它、`resolve` 会先查它）：它现在是**兼容用的快路径**，
 * 不是权威落点。权威落点是行内的 `anonymized_author_ref` —— 这也意味着"Map 丢了下一次读仍旧匿名"。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Author, AuthorDirectory } from './types.ts';

export interface LocalAuthorDirectoryOptions {
  /** 已注销/待去身份的 userId：投影为 `state: 'anonymized'`（公开帖评去身份）。 */
  anonymizedUserIds?: Iterable<string>;
  /** 注销引用的随机源（只为测试可注入；默认 `crypto.randomBytes`）。 */
  randomHex?: (bytes: number) => string;
}

const DISPLAY_DOMAIN = 'gengyun.community.pseudonymous-author.v1';

/** 注销引用前缀（与活跃假名 `gy-` 区分；不含任何原文片段）。 */
const ANON_DISPLAY_PREFIX = 'gy-anon-';

/**
 * 注销引用的**形状**（与迁移 0030 的两条 CHECK 逐字同源）：
 * `community_posts_anon_ref_shape` / `community_comments_anon_ref_shape`。
 *
 * 两侧必须一起改：库里放宽了而这里没放宽 ⇒ 行内引用会被投影层当成"未知主体"；
 * 这里放宽了而库里没放宽 ⇒ 写入直接撞 CHECK（事务回滚，注销如实失败）。
 */
export const ANONYMIZED_AUTHOR_REF_PATTERN = /^gy-anon-[0-9a-f]{16}$/;

/**
 * 生成一个注销引用（**纯函数**，不读进程内状态）。
 *
 * 供两处共用，保证"写进行里的引用"与"投影层认得的引用"永远是同一个形状：
 *   1. `anonymize()`（注销写路径的权威值）；
 *   2. `store-pg.ts` / `store.ts` 的 `purgeOwnerData` 兜底（调用方没给引用时的自保，
 *      避免写出 `author_id = NULL` 而 `anonymized_author_ref = NULL` 的行 —— 那会撞
 *      迁移 0030 的 `num_nonnulls(...) = 1`）。
 *
 * `randomHex` 只为测试可注入；默认 8 字节 crypto 随机（64 bit）。
 */
export function createAnonymizedAuthorRef(randomHex?: (bytes: number) => string): string {
  const hex = (randomHex ?? ((bytes: number) => randomBytes(bytes).toString('hex')))(8);
  return `${ANON_DISPLAY_PREFIX}${hex}`;
}


function digestOf(userId: string): string {
  return createHash('sha256').update(`${DISPLAY_DOMAIN}\u0000${userId}`, 'utf8').digest('hex');
}

/** 本地假名投影（阶段 1 的替身；**不是**真实作者资料）。 */
export function createLocalPseudonymousAuthorDirectory(
  options: LocalAuthorDirectoryOptions = {},
): AuthorDirectory & { anonymize(userId: string): Promise<Author> } {
  const randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString('hex'));
  /** userId → 注销引用（逐作者独立；进程内稳定）。 */
  const anonymizedRefs = new Map<string, string>();
  const takenRefs = new Set<string>();
  const cache = new Map<string, Author>();

  function freshDeletionRef(): string {
    // 8 字节随机 = 64 bit；在"同一进程里注销的主体数"这个量级上碰撞可忽略。
    // 万一撞上（可注入随机源时才会发生），重试而不是复用别人的引用。
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ref = createAnonymizedAuthorRef(randomHex);
      if (!takenRefs.has(ref)) {
        takenRefs.add(ref);
        return ref;
      }
    }
    throw new Error('无法生成不重复的注销引用（随机源异常）');
  }

  /** 仅按**引用本身**构造投影（不读 Map、不查库）：重启/多副本下的唯一依据。 */
  function anonymizedAuthorFromRef(ref: string): Author {
    return {
      display_name: '已注销用户',
      display_id: ref,
      state: 'anonymized',
      avatar_media_id: null,
      revision: 1,
      avatar_media: null,
    };
  }

  function anonymizedAuthor(userId: string): Author {
    let ref = anonymizedRefs.get(userId);
    if (ref === undefined) {
      ref = freshDeletionRef();
      anonymizedRefs.set(userId, ref);
    }
    return anonymizedAuthorFromRef(ref);
  }

  for (const userId of options.anonymizedUserIds ?? []) {
    if (typeof userId === 'string' && userId.length > 0) anonymizedAuthor(userId);
  }

  async function resolve(userId: string): Promise<Author | null> {
    if (typeof userId !== 'string' || userId.length === 0) return null;
    // 入参本身就是**行内注销引用**（读路径 `author_id ?? anonymized_author_ref` 的后者）：
    // 直接按引用投影 ⇒ 不依赖任何进程内 Map，重启/多副本后同一行仍显示同一引用。
    // ⛔ 不要在这里"再哈希一次"或加后缀：那会让同一行在不同进程里显示不同 id。
    if (ANONYMIZED_AUTHOR_REF_PATTERN.test(userId)) return anonymizedAuthorFromRef(userId);
    if (anonymizedRefs.has(userId)) return { ...anonymizedAuthor(userId) };

    const cached = cache.get(userId);
    if (cached !== undefined) return { ...cached };
    const digest = digestOf(userId);
    const author: Author = {
      display_name: `耕云用户${digest.slice(12, 16)}`,
      display_id: `gy-${digest.slice(0, 12)}`,
      state: 'active',
      avatar_media_id: null,
      revision: 1,
      avatar_media: null,
    };
    cache.set(userId, author);
    return { ...author };
  }

  async function anonymize(userId: string): Promise<Author> {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new Error('注销去身份必须绑定非空主体');
    }
    cache.delete(userId);
    return { ...anonymizedAuthor(userId) };
  }

  return { resolve, anonymize };
}
