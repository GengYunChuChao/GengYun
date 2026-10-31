/**
 * GY-I06（#6）媒体域 · 公开内容来源端口（社区取图的唯一授权上下文）。
 *
 * 契约 `grantCommunityMediaAccess` 原文：**“登录用户基于当前 published 且 approved 的帖子附件或
 * 帖子/评论作者头像授权”**，并且“回放/读取重新校验当前账号/用途/版本/审核/父帖”。
 * 因此社区取图**不能**只看媒体自身是否 ready：必须有「当前仍公开且已独立筛查通过」的内容上下文。
 *
 * 现状（如实记录）：
 * - 媒体自身 ready **不等于**「当前公开且已独立过审」：判据只能是**读时重算**的「已发布 + 已过审」，
 *   不是「写入时信任一次」的旧结论。
 * - 真实来源（GY-I06/G3）**已接线**：默认装配是 `createRealContentSource(communityService, mediaStore)`
 *   （装配点 `services/api/src/app.ts` 的 `contentSource`）—— 社区只读端口 `publishedContent`
 *   （读时重算的 `effectiveState`，**没有作者旁路**）+ 媒体记录的当前 revision 组装而成。
 *   社区域整体未接线时回落 `createClosedContentSource()`（一律 null ⇒ 取图统一 404），仍 fail-closed。
 * - `createInMemoryContentSource` 只用于**测试**与 `stub`/`preset_demo` 离线联调，`note` 中显式标明。
 */

/** 契约 `PublishedContentRef`。 */
export interface PublishedContentRef {
  type: 'post' | 'comment';
  id: string;
  revision: number;
}

/** 一次取图判定所需的**当前**内容快照（不含正文，仅审核/版本/附件引用）。 */
export interface PublishedContentSnapshot {
  ref: PublishedContentRef;
  /** 当前是否处于公开可见状态（已发布且未下架）。 */
  published: boolean;
  /** 是否已通过独立筛查（审核）。未通过即不得取图。 */
  approved: boolean;
  /** 作者账号 revision；仅 `author_avatar` 槽位参与比对。 */
  authorRevision: number | null;
  /** 帖子附件引用（`slot='attachment'`）。 */
  media: Array<{ mediaId: string; mediaRevision: number }>;
  /** 作者头像引用（`slot='author_avatar'`）。 */
  avatarMedia: { mediaId: string; mediaRevision: number } | null;
}

export interface PublishedContentSource {
  readonly kind: 'closed' | 'in_memory' | 'real';
  /** 供证据文档/诊断引用的如实标注。 */
  readonly note: string;
  /** 不存在 / 非公开 / 未过审 / 版本不符一律返回 null（调用方统一 404，不泄露存在性）。 */
  getPublishedContent(ref: PublishedContentRef): Promise<PublishedContentSnapshot | null>;
}

const CLOSED_NOTE =
  '公开内容来源**未接线**（默认装配）：社区取图一律 404，不误放行任何媒体；' +
  '真实来源须由社区/审核线提供只读端口后在装配层显式注入。';

/** 默认来源：**关闭**。任何取图请求都判定为「公开内容不存在」。 */
export function createClosedContentSource(): PublishedContentSource {
  return {
    kind: 'closed',
    note: CLOSED_NOTE,
    async getPublishedContent() {
      return null;
    },
  };
}

/**
 * 测试 / `stub` 用内存来源：**明确标注的替身**。
 * 只按 `(type, id, revision)` 精确匹配，且 `published` / `approved` 必须同时为真 —— 它不构造
 * 「审核通过」的假状态，测试必须显式给出这些位。
 */
export function createInMemoryContentSource(seed: PublishedContentSnapshot[] = []): PublishedContentSource {
  const snapshots = new Map<string, PublishedContentSnapshot>();
  for (const snapshot of seed) {
    snapshots.set(`${snapshot.ref.type}:${snapshot.ref.id}:${snapshot.ref.revision}`, snapshot);
  }
  return {
    kind: 'in_memory',
    note: '内存公开内容来源（测试 / stub 离线联调专用替身）：只做精确版本匹配，不接真实社区与审核存储。',
    async getPublishedContent(ref) {
      const snapshot = snapshots.get(`${ref.type}:${ref.id}:${ref.revision}`);
      if (snapshot === undefined) return null;
      if (!snapshot.published || !snapshot.approved) return null;
      return snapshot;
    },
  };
}

/**
 * 消费侧（媒体域）声明、装配层把社区域只读端口适配进来 —— 不 import 社区实现，避免跨线耦合。
 * 与 `CommunityMediaMetadataSource` 同一范式：端口由需要它的一侧声明，实现留在社区域。
 */
export interface PublishedContentRecord {
  /** 该内容当前引用的媒体 id（顺序即发布顺序）；如实回放库里已有的 `media_ids`。 */
  readonly mediaIds: readonly string[];
}

/** 社区域「已发布且审核通过」只读端口的结构性要求（`community/service.ts` 的 `publishedContent`）。 */
export interface PublishedContentPort {
  /** 当前不可公开（不存在／未发布／已下架／已删除／未过审／版本不符）一律返回 null。 */
  read(ref: PublishedContentRef): Promise<PublishedContentRecord | null>;
}

/** 媒体记录当前 revision 的只读查询（装配层用 `MediaStore` 适配）。 */
export interface PublishedMediaRevisionLookup {
  getMedia(id: string): Promise<{ readonly revision: number } | null>;
}

const REAL_NOTE =
  '真实公开内容来源（装配层接线）：判定交给社区域只读端口 `publishedContent`（读时重算的 ' +
  '`effectiveState`，无作者旁路）；本来源不缓存、不旁路，也不把「曾经通过」当现在通过。';

/**
 * 真实来源（GY-I06/G3）：**社区域只读端口 + 媒体记录当前 revision** 的组装。
 *
 * - 只有端口回答「此刻已发布且审核通过」才会走到下面 ⇒ 快照的 `published`/`approved` 恒真；
 *   任何「读不到」都在端口里被折叠成 `null`，这里**不补判、不猜测**。
 * - 附件 revision 取媒体行的**当前** revision：`content_media_refs` 至今无写入方，没有可信的
 *   历史附件版本可回放；媒体行缺失（未完成上传／已删除）的就**不进清单**，授权自然不成立。
 * - 头像槽位如实不可用：`users.avatar_media_id` 至今无写入方 ⇒ `avatarMedia`/`authorRevision`
 *   恒 `null`（`slot='author_avatar'` 的取图因此恒 404），这里不构造假引用。
 * - 社区域整体未接线（`real` 且无持久化 ⇒ 社区整域 503）时 `community` 为 `null`：回落
 *   `createClosedContentSource()`，与「未接线」同形，仍然 fail-closed。
 */
export function createRealContentSource(
  community: { readonly publishedContent?: PublishedContentPort } | null,
  media: PublishedMediaRevisionLookup,
): PublishedContentSource {
  const port = community?.publishedContent ?? null;
  if (port === null) return createClosedContentSource();
  return {
    kind: 'real',
    note: REAL_NOTE,
    async getPublishedContent(ref) {
      const record = await port.read(ref);
      if (record === null) return null;
      const attachments: Array<{ mediaId: string; mediaRevision: number }> = [];
      for (const mediaId of record.mediaIds) {
        const current = await media.getMedia(mediaId);
        if (current === null) continue;
        attachments.push({ mediaId, mediaRevision: current.revision });
      }
      return {
        ref,
        published: true,
        approved: true,
        authorRevision: null,
        media: attachments,
        avatarMedia: null,
      };
    },
  };
}
