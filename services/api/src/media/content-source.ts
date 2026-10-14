/**
 * GY-I06（#6）媒体域 · 公开内容来源端口（社区取图的唯一授权上下文）。
 *
 * 契约 `grantCommunityMediaAccess` 原文：**“登录用户基于当前 published 且 approved 的帖子附件或
 * 帖子/评论作者头像授权”**，并且“回放/读取重新校验当前账号/用途/版本/审核/父帖”。
 * 因此社区取图**不能**只看媒体自身是否 ready：必须有「当前仍公开且已独立筛查通过」的内容上下文。
 *
 * 现状（如实记录）：
 * - 默认装配**不注入**任何公开内容来源 ⇒ `createClosedContentSource()` **一律返回 null** ⇒
 *   社区取图统一 404（与「不存在」同形）。这是 fail-closed，绝不误放行。
 * - 真实来源属**跨线**：社区帖子与审核状态在 `services/api/src/community/**`（GY-I14/GY-I15）
 *   与 `services/api/src/admin/**`（GY-I18）中，本任务**不修改**这些已合并文件，也不自建与之割裂的
 *   替身实例（那会让「已下架 / 未过审」在不同 store 上失真）。接线须由 GY-I14/GY-I15 侧提供只读端口后
 *   在装配层显式注入。
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
  readonly kind: 'closed' | 'in_memory';
  /** 供证据文档/诊断引用的如实标注。 */
  readonly note: string;
  /** 不存在 / 非公开 / 未过审 / 版本不符一律返回 null（调用方统一 404，不泄露存在性）。 */
  getPublishedContent(ref: PublishedContentRef): PublishedContentSnapshot | null;
}

const CLOSED_NOTE =
  '公开内容来源**未接线**（默认装配）：社区取图一律 404，不误放行任何媒体；' +
  '真实来源须由社区/审核线提供只读端口后在装配层显式注入。';

/** 默认来源：**关闭**。任何取图请求都判定为「公开内容不存在」。 */
export function createClosedContentSource(): PublishedContentSource {
  return {
    kind: 'closed',
    note: CLOSED_NOTE,
    getPublishedContent() {
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
    getPublishedContent(ref) {
      const snapshot = snapshots.get(`${ref.type}:${ref.id}:${ref.revision}`);
      if (snapshot === undefined) return null;
      if (!snapshot.published || !snapshot.approved) return null;
      return snapshot;
    },
  };
}
