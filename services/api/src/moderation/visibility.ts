/**
 * GY-I14（#14）审核 HTTP 装配片 · **发布隔离 / 下架 / 读取时重查可见性 + 读缓存失效**。
 *
 * 三条硬口径（派单 §2.2 / §2.6 / AC16）：
 *   1) **筛查通过与发布分开**：任务 `approved` 只是"可以发布"的必要条件；
 *      发布是**独立一步**（`service.publish`），且发布前必须重跑版本/证据/输入绑定闸门。
 *   2) **读取时重查权限与可见性**：读缓存**永远不是**事实来源。每次读取都问权威端口；
 *      命中缓存但权威说不 ⇒ 一律不可见，并**顺手失效**该缓存条目。
 *      隐藏 / 已删除 / 账号停用或去身份 / 旧 revision 链接 **不得**因缓存或旧链接重新公开。
 *   3) **下架事件驱动缓存失效**：下架 = 可见性转 `hidden` + 已发布 revision 置空 +
 *      失效该目标**全部 revision** 的缓存条目（返回被失效的键，可断言）。
 */
import { ApiError } from '../errors.ts';
import { PUBLIC_VOTE_ENABLED, type AuthoritySnapshot, type ContentAuthorityPort, type ModerationActor, type TargetRef, type Visibility } from './types.ts';

/** 可见性判定的闭集原因码（非契约错误码；对外 HTTP 码由调用方按契约闭集映射）。 */
export const VISIBILITY_REASON_CODES = Object.freeze([
  'SESSION_REQUIRED',
  'NOT_FOUND',
  'CONTENT_DELETED',
  'CONTENT_HIDDEN',
  'NOT_PUBLISHED',
  'REVISION_SUPERSEDED',
  'ACCOUNT_INACTIVE',
  'AUTHOR_ANONYMIZED',
  'SCOPE_DENIED',
  'VISIBILITY_UNVERIFIED',
  'CACHE_ENTRY_STALE',
]);

export interface ReadVerdict {
  visible: boolean;
  visibility: Visibility | null;
  reason_codes: string[];
  /** 本次读取**始终**以权威端口为准；该字段只是诊断（缓存不同意时为零）。 */
  cache_hit: boolean;
  cache_entry_stale: boolean;
  cache_keys_invalidated: string[];
}

/** 读缓存条目（**提示**用，不是事实来源）。 */
export interface ReadCacheEntry {
  visibility: Visibility;
  published_revision: number | null;
  author_state: AuthoritySnapshot['author_state'];
  cached_at: string;
}

export interface ReadCache {
  get(target: TargetRef): ReadCacheEntry | null;
  set(target: TargetRef, entry: ReadCacheEntry): void;
  /** 失效**该目标全部 revision**的条目（下架/注销即整链失效）。 */
  invalidateTarget(target: TargetRef): string[];
  size(): number;
  keys(): string[];
}

function targetScope(target: TargetRef): string {
  return `${target.type}|${target.id}`;
}

function cacheKey(target: TargetRef): string {
  return `${target.type}|${target.id}|${target.revision}`;
}

export function createReadCache(): ReadCache {
  const entries = new Map<string, ReadCacheEntry>();
  return {
    get(target) {
      const entry = entries.get(cacheKey(target));
      return entry === undefined ? null : { ...entry };
    },
    set(target, entry) {
      entries.set(cacheKey(target), { ...entry });
    },
    invalidateTarget(target) {
      const scope = `${targetScope(target)}|`;
      const invalidated: string[] = [];
      for (const key of [...entries.keys()]) {
        if (key.startsWith(scope)) {
          entries.delete(key);
          invalidated.push(key);
        }
      }
      return invalidated;
    },
    size() {
      return entries.size;
    },
    keys() {
      return [...entries.keys()];
    },
  };
}

/**
 * **替身**权威端口（`stub` / `preset_demo` / 测试）。
 *
 * 明确标注 `origin: 'substitute'`：它**不是**真实内容存储；真实内容属社区/资料线（跨线接线）。
 * 替身不联网、不读环境变量、不落盘。
 */
export interface SubstituteContentAuthority extends ContentAuthorityPort {
  readonly origin: 'substitute';
  seed(
    target: TargetRef,
    snapshot: { visibility: Visibility; author_state: AuthoritySnapshot['author_state']; source_kind: AuthoritySnapshot['source_kind']; owner_id: string | null; current_revision?: number },
  ): void;
  setAuthorState(target: TargetRef, state: AuthoritySnapshot['author_state']): void;
  setCurrentRevision(target: TargetRef, revision: number): void;
  get(target: TargetRef): AuthoritySnapshot | null;
}

export function createSubstituteContentAuthority(): SubstituteContentAuthority {
  interface Row {
    owner_id: string | null;
    visibility: Visibility;
    author_state: AuthoritySnapshot['author_state'];
    source_kind: AuthoritySnapshot['source_kind'];
    current_revision: number;
  }
  const rows = new Map<string, Row>();
  const published = new Map<string, number | null>();

  const rowOf = (target: TargetRef): Row | null => rows.get(targetScope(target)) ?? null;

  const snapshotOf = (target: TargetRef): AuthoritySnapshot | null => {
    const row = rowOf(target);
    if (row === null) return null;
    return {
      exists: true,
      visibility: row.visibility,
      author_state: row.author_state,
      source_kind: row.source_kind,
      owner_id: row.owner_id,
      current_revision: row.current_revision,
    };
  };

  return {
    origin: 'substitute',
    async read(target) {
      return snapshotOf(target);
    },
    async setVisibility(target, visibility) {
      const row = rowOf(target);
      if (row === null) throw new ApiError('OBJECT_UNAVAILABLE', '目标内容不存在（替身权威：未登记）');
      row.visibility = visibility;
    },
    async setPublishedRevision(target, revision) {
      published.set(targetScope(target), revision);
    },
    async publishedRevision(target) {
      return published.get(targetScope(target)) ?? null;
    },
    seed(target, snapshot) {
      rows.set(targetScope(target), {
        owner_id: snapshot.owner_id,
        visibility: snapshot.visibility,
        author_state: snapshot.author_state,
        source_kind: snapshot.source_kind,
        current_revision: snapshot.current_revision ?? target.revision,
      });
    },
    setAuthorState(target, state) {
      const row = rowOf(target);
      if (row === null) throw new Error('替身权威：目标未登记');
      row.author_state = state;
    },
    setCurrentRevision(target, revision) {
      const row = rowOf(target);
      if (row === null) throw new Error('替身权威：目标未登记');
      row.current_revision = revision;
    },
    get(target) {
      return snapshotOf(target);
    },
  };
}

/**
 * **real 未接线**权威端口：任何读写都 fail-closed（契约 503 `PROVIDER_UNAVAILABLE` + `retryable`）。
 * **不得**用替身冒充真实内容存储（那等于在真实模式声称内容已核对）。
 */
export function createUnwiredContentAuthority(): ContentAuthorityPort {
  const deny = (): never => {
    throw new ApiError('PROVIDER_UNAVAILABLE', '真实内容权威未接线：审核可见性不可核对（fail-closed）', {
      // 内容可见性权威未接线（deny 替身）：retryable 必须为 false。
      retryable: false,
    });
  };
  return {
    origin: 'unwired',
    async read() {
      return deny();
    },
    async setVisibility() {
      return deny();
    },
    async setPublishedRevision() {
      return deny();
    },
    async publishedRevision() {
      return deny();
    },
  };
}

export interface CheckReadArgs {
  actor: ModerationActor | null;
  target: TargetRef;
  snapshot: AuthoritySnapshot | null;
  published_revision: number | null;
  cache_entry: ReadCacheEntry | null;
}

/**
 * 读取时可见性判定（**纯函数**，便于逐条断言）。
 *
 * 顺序即优先级：先身份、再存在性、再下架/删除、再所有者权限、再作者状态、再**旧链接**，
 * 最后按可见性决定。
 *  - `private`：仅**所有者**可见（未公开内容不进公共读面；他人 403 语义 `SCOPE_DENIED`）；
 *  - `published`：要求**已发布 revision 等于本次请求的 revision**（下架后置空 ⇒ 旧链接不复活）。
 * 任何一项不成立 ⇒ 不可见（fail-closed），且**绝不**因为"缓存说是 published"而放行。
 */
export function checkReadVisibility(args: CheckReadArgs): ReadVerdict {
  const reasons: string[] = [];
  const cacheHit = args.cache_entry !== null;
  const stale =
    cacheHit &&
    (args.snapshot === null ||
      args.cache_entry?.visibility !== args.snapshot.visibility ||
      args.cache_entry?.published_revision !== args.published_revision ||
      args.cache_entry?.author_state !== args.snapshot.author_state);

  const deny = (visibility: Visibility | null, ...codes: string[]): ReadVerdict => ({
    visible: false,
    visibility,
    reason_codes: [...codes],
    cache_hit: cacheHit,
    cache_entry_stale: stale,
    cache_keys_invalidated: stale ? [cacheKey(args.target)] : [],
  });

  if (args.actor === null || typeof args.actor.userId !== 'string' || args.actor.userId.length === 0) {
    return deny(null, 'SESSION_REQUIRED');
  }
  if (args.snapshot === null || args.snapshot.exists !== true) {
    return deny(null, 'NOT_FOUND');
  }
  const snapshot = args.snapshot;
  if (snapshot.visibility === 'deleted') return deny('deleted', 'CONTENT_DELETED');
  if (snapshot.visibility === 'hidden') return deny('hidden', 'CONTENT_HIDDEN');
  const owned = snapshot.owner_id !== null && snapshot.owner_id === args.actor.userId;
  if (snapshot.visibility === 'private' && !owned) return deny('private', 'SCOPE_DENIED');
  if (snapshot.author_state === 'inactive') return deny(snapshot.visibility, 'ACCOUNT_INACTIVE');
  if (snapshot.author_state === 'anonymized') return deny(snapshot.visibility, 'AUTHOR_ANONYMIZED');
  if (snapshot.current_revision !== args.target.revision) {
    // 旧链接：目标已生成新 revision，旧 revision 不得因缓存/书签继续可见。
    return deny(snapshot.visibility, 'REVISION_SUPERSEDED');
  }
  if (snapshot.visibility === 'private') {
    // 所有者读自己的未公开内容：可见，但**不计为已发布**（`published_revision` 不参与）。
    if (stale) reasons.push('CACHE_ENTRY_STALE');
    return {
      visible: true,
      visibility: 'private',
      reason_codes: reasons,
      cache_hit: cacheHit,
      cache_entry_stale: stale,
      cache_keys_invalidated: stale ? [cacheKey(args.target)] : [],
    };
  }
  if (args.published_revision === null || args.published_revision !== args.target.revision) {
    return deny(snapshot.visibility, 'NOT_PUBLISHED');
  }
  if (snapshot.visibility !== 'published') return deny(snapshot.visibility, 'NOT_PUBLISHED');
  if (stale) reasons.push('CACHE_ENTRY_STALE');
  return {
    visible: true,
    visibility: 'published',
    reason_codes: reasons,
    cache_hit: cacheHit,
    cache_entry_stale: stale,
    cache_keys_invalidated: stale ? [cacheKey(args.target)] : [],
  };
}

/** 公开票决：**首版不进入**（本函数只是可断言的事实，不是功能）。 */
export function publicVotingEnabled(): boolean {
  return PUBLIC_VOTE_ENABLED;
}
