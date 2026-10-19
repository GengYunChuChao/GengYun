/**
 * GY-I14（#14 审核域）⇄ GY-I15（#15 社区域）· **同源内容权威端口**（`ContentAuthorityPort`）。
 *
 * ## 解决什么问题
 *
 * 审核域的下架（`moderationService.withdraw`）与读取时重查（`readView`）都要问一个
 * **内容权威**："这条内容现在到底存不存在、可见性是什么、作者状态如何、当前 revision 是多少"。
 * 审核域自带的替身权威（`createSubstituteContentAuthority`）是**另一份内存表**——把社区帖子
 * 交给它，等于让审核域对着一份"社区并不认"的副本做下架与缓存失效，属于**两域不同源**。
 *
 * 本文件把权威端口接到**社区那一份** `CommunityStore`（与后台 `hidePost` 用的是**同一份**，
 * 沿用既有口径）：审核域读到的就是社区真实的帖子/评论行，下架写的也是同一行。
 *
 * ## 口径（单点事实来源，不另存副本）
 *
 * | 方法 | 口径 |
 * | --- | --- |
 * | `read` | 直接读社区 store 的帖子/评论行；不存在 ⇒ `null`（审核域按 `NOT_FOUND` fail-closed） |
 * | `setVisibility` | 用社区**唯一**更新原语 `commitPostIfCurrent`/`commitCommentIfCurrent`（CAS）写可见性；已是目标值 ⇒ 幂等不改写；`private`/`deleted` **不接受**（删除是作者的单向门，审核域无权删除） |
 * | `publishedRevision` | **派生**：`visibility==='published' && audit_state==='approved'` ⇒ 该行 revision，否则 `null` |
 * | `setPublishedRevision` | **一致性核对**，不是第二个存储：声明 `rev` 就必须与派生值相等，否则 fail-closed 拒绝（审核域不能对社区宣称一个社区不认的"已发布版本"） |
 *
 * `author_state` 取自社区**同一份**作者投影（`AuthorDirectory`）：解析不出来时判 `inactive`
 * （fail-closed：无法核对作者状态就不得当作可发布）。
 */
import { ApiError } from '../errors.ts';
import type { AuthorDirectory, Visibility } from './types.ts';
import type { CommunityStore, PostRecord, CommentRecord } from './store.ts';

/** 审核域 `TargetRef` 中与本端口相关的子集（字符串类型，交由本端口辨识）。 */
export interface AuthorityTargetRef {
  type: string;
  id: string;
  revision: number;
}

/** 与 `services/api/src/moderation/types.ts` 的 `AuthoritySnapshot` 逐字段同形。 */
export interface AuthoritySnapshot {
  exists: boolean;
  visibility: Visibility;
  author_state: 'active' | 'anonymized' | 'inactive';
  source_kind: 'database' | 'verified_seed' | 'simulation';
  owner_id: string | null;
  current_revision: number;
}

/** 同源权威端口（结构性；装配层把它当作审核域的 `ContentAuthorityPort` 传入）。 */
export interface CommunityContentAuthorityPort {
  readonly origin: 'community_store';
  read(target_ref: AuthorityTargetRef): Promise<AuthoritySnapshot | null>;
  setVisibility(target_ref: AuthorityTargetRef, visibility: Visibility): Promise<void>;
  setPublishedRevision(target_ref: AuthorityTargetRef, revision: number | null): Promise<void>;
  publishedRevision(target_ref: AuthorityTargetRef): Promise<number | null>;
}

type CommunityRecord = PostRecord | CommentRecord;

function isPost(record: CommunityRecord): record is PostRecord {
  return 'title' in record;
}

/**
 * 构造同源权威端口。
 *
 * `store` 必须是**社区那一份** store（与社区服务、后台 `hidePost` 同一个实例）；
 * `authors` 必须是社区**同一份**作者投影。
 */
export function createCommunityContentAuthority(options: {
  store: CommunityStore;
  authors: AuthorDirectory;
}): CommunityContentAuthorityPort {
  const store = options.store;
  const authors = options.authors;

  async function recordOf(target: AuthorityTargetRef): Promise<CommunityRecord | null> {
    if (target.type === 'post') return store.getPost(target.id);
    if (target.type === 'comment') return store.getComment(target.id);
    return null;
  }

  /** 派生"已发布 revision"（**不另存副本**：社区行就是事实来源）。 */
  function publishedRevisionOf(record: CommunityRecord): number | null {
    return record.visibility === 'published' && record.audit_state === 'approved' ? record.revision : null;
  }

  async function authorStateOf(ownerId: string): Promise<AuthoritySnapshot['author_state']> {
    const author = await authors.resolve(ownerId);
    if (author === null) return 'inactive'; // 无法核对 ⇒ fail-closed
    return author.state === 'anonymized' ? 'anonymized' : 'active';
  }

  async function writeVisibility(target: AuthorityTargetRef, visibility: 'published' | 'hidden'): Promise<void> {
    const record = await recordOf(target);
    if (record === null) {
      throw new ApiError('OBJECT_UNAVAILABLE', '目标内容不存在（社区存储：未登记）');
    }
    if (record.visibility === 'deleted') {
      // 已删除是单向门：审核域**不得**复活它，也不得把它改成别的可见性。
      throw new ApiError('OBJECT_UNAVAILABLE', '目标内容已删除，审核域不得改写其可见性（单向门）');
    }
    // 幂等：已是目标可见性 ⇒ **没有写入**，不涉及版本核对（见下方 setPublishedRevision 同口径）。
    // 既有接线口径：后台隐藏已把行置 `hidden` 并推进 revision 后，审核域会按**处置前**版本
    // 补一次"未发布"声明；那一版已不是社区当前版本，但该调用不改变任何字段，属纯声明。
    // 该 revision 口径差异是已登记的 P2 项（诊断 3-5），不属本片范围。
    if (record.visibility === visibility) return;
    // **旧版本不得改可见性**：请求核对的是 `target.revision` 那一版；社区行已不是那一版
    // （版本前进=旧链接/旧结论）⇒ 抛错且**零副作用**，绝不把旧请求写到新版本上。
    if (record.revision !== target.revision) {
      throw new ApiError(
        'REVISION_CONFLICT',
        `可见性写入未生效（目标 revision=${target.revision} 不是社区当前版本 ${record.revision}：旧版本不得改可见性）`,
      );
    }
    // 审核域**不推进**社区 revision：版本推进属内容写路径（投稿/编辑/后台隐藏）的职责。
    const patch = visibility === 'published'
      ? { visibility, audit_state: 'approved' as const }
      : { visibility };
    // CAS 的期望版本**取自请求要核对的 `target.revision`**（不取行自身当前值）：
    // 两者不等已在上面拒绝，这里再进 CAS 是为了让并发推进版本时的拒绝也落在"目标版本"上。
    const expected = { revision: target.revision, visibility: record.visibility, audit_state: record.audit_state };
    const casRefusal = (reason: string): ApiError =>
      // CAS 失败（revision/可见性/状态已变）⇒ 如实拒绝，绝不谎报"已改写"。
      new ApiError('REVISION_CONFLICT', `可见性写入未生效（社区 CAS 拒绝：${reason}）`);
    if (isPost(record)) {
      const result = await store.commitPostIfCurrent(target.id, expected, patch, null);
      if (!result.ok) throw casRefusal(result.reason);
      return;
    }
    const result = await store.commitCommentIfCurrent(target.id, expected, patch, null);
    if (!result.ok) throw casRefusal(result.reason);
  }

  return {
    origin: 'community_store',
    async read(target_ref) {
      const record = await recordOf(target_ref);
      if (record === null) return null;
      return {
        exists: true,
        visibility: record.visibility,
        author_state: await authorStateOf(record.author_id),
        // 社区行来自服务端存储（不是替身/不是合成种子）；这里如实标 `database`。
        source_kind: 'database',
        owner_id: record.author_id,
        current_revision: record.revision,
      };
    },
    async setVisibility(target_ref, visibility) {
      if (visibility === 'private' || visibility === 'deleted') {
        throw new ApiError(
          'INVALID_REQUEST',
          `同源权威不接受审核域把内容改为 ${visibility}（删除/私有属作者动作，是单向门）`,
        );
      }
      await writeVisibility(target_ref, visibility);
    },
    async setPublishedRevision(target_ref, revision) {
      const record = await recordOf(target_ref);
      if (record === null) throw new ApiError('OBJECT_UNAVAILABLE', '目标内容不存在（社区存储：未登记）');
      // 声明/收回"已发布版本"同样只能针对权威当前版本：旧 revision 的声明一律拒绝（零副作用）。
      // 但**不改变任何声明的幂等调用**不在此列：`revision===null` 且派生值本就是 `null`
      // （下架后补一次"未发布"声明），或声明值恰好等于派生值 —— 两者都不写任何字段。
      const derived = publishedRevisionOf(record);
      const declaresNothing = revision === null ? derived === null : derived === revision;
      if (!declaresNothing && record.revision !== target_ref.revision) {
        throw new ApiError(
          'REVISION_CONFLICT',
          `拒绝声明已发布 revision=${revision ?? 'null'}：目标 revision=${target_ref.revision} 不是社区当前版本 ${record.revision}`,
        );
      }
      if (revision === null) {
        if (derived !== null) {
          throw new ApiError('REVISION_CONFLICT', '拒绝声明"未发布"：社区行仍是已发布状态（事实来源不一致）');
        }
        return;
      }
      if (derived !== revision) {
        throw new ApiError(
          'REVISION_CONFLICT',
          `拒绝声明已发布 revision=${revision}：社区行的派生已发布版本为 ${derived ?? 'null'}（事实来源不一致）`,
        );
      }
    },
    async publishedRevision(target_ref) {
      const record = await recordOf(target_ref);
      return record === null ? null : publishedRevisionOf(record);
    },
  };
}
