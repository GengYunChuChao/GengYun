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
 */
import { createHash } from 'node:crypto';
import type { Author, AuthorDirectory } from './types.ts';

export interface LocalAuthorDirectoryOptions {
  /** 已注销/待去身份的 userId：投影为 `state: 'anonymized'`（公开帖评去身份）。 */
  anonymizedUserIds?: Iterable<string>;
}

const DISPLAY_DOMAIN = 'gengyun.community.pseudonymous-author.v1';

function digestOf(userId: string): string {
  return createHash('sha256').update(`${DISPLAY_DOMAIN}\u0000${userId}`, 'utf8').digest('hex');
}

/** 本地假名投影（阶段 1 的替身；**不是**真实作者资料）。 */
export function createLocalPseudonymousAuthorDirectory(
  options: LocalAuthorDirectoryOptions = {},
): AuthorDirectory {
  const anonymized = new Set(options.anonymizedUserIds ?? []);
  const cache = new Map<string, Author>();

  return {
    async resolve(userId: string): Promise<Author | null> {
      if (typeof userId !== 'string' || userId.length === 0) return null;
      const cached = cache.get(userId);
      if (cached !== undefined) return { ...cached };
      const digest = digestOf(userId);
      const author: Author =
        anonymized.has(userId)
          ? {
              display_name: '已注销用户',
              display_id: `gy-anon-${digest.slice(0, 10)}`,
              state: 'anonymized',
              avatar_media_id: null,
              revision: 1,
              avatar_media: null,
            }
          : {
              display_name: `耕云用户${digest.slice(12, 16)}`,
              display_id: `gy-${digest.slice(0, 12)}`,
              state: 'active',
              avatar_media_id: null,
              revision: 1,
              avatar_media: null,
            };
      cache.set(userId, author);
      return { ...author };
    },
  };
}
