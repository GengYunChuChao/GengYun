/**
 * 媒体域的**持久化端口**（登记册 + 授权 + 幂等台账），以及它的进程内实现。
 *
 * ## 为什么要有这个文件
 * `services/api/src/media/service.ts` 在 W2 阶段的三个事实源全是进程内 `Map`
 * （旧 `records`/`grants`/`idempotency` + 并发占位 `inflight`）：进程一退，`media` 行没了、
 * 授权没了、幂等回执没了 —— 上传句柄、`complete` 的幂等语义、社区读授权全部随进程消失。
 * 本文件把这三样收进一个**窄端口**，让服务只依赖端口，由装配层按 `executionMode`
 * 二分选实现（与 `favorites`/`history`/`messages` 同一范式）：
 * - `createMemoryMediaStore`：进程内，**仅供 stub 模式与单元测试**，`persistent: false`；
 * - `createPostgresMediaStore`（同目录 `store-pg.ts`）：落 0001 的 `media` / `media_derivatives` /
 *   `community_media_grants`，幂等台账复用 0008 的 `public.idempotency_keys`，**待清理对象台账**
 *   落 0029 的 `public.media_object_cleanup`，`persistent: true`。
 *
 * ## 不变量（两个实现必须一致，不然「内存绿、真库红」）
 * - **返回的是快照，不是共享引用**：调用方改动返回值不会自动生效，必须 `saveMedia` 显式落库。
 *   否则进程内实现会替真库掩盖「忘了落库」的 bug。
 * - **`object_ref_cipher` 是密文列**：对象键在端口层是明文（`rawRef`/`derivativeRef`），
 *   进出库由 Postgres 实现用 `ObjectRefCipher` 加解密（见 `./object-ref-cipher.ts`）。
 * - **幂等台账用 claim/settle/release 三段**（与 `auth`、`messages` 同语义）：同键并发时
 *   只有一个能 `claim` 成功，其余读到的 `mediaId` 为 `null` ⇒ 上层回 409 `REQUEST_IN_PROGRESS`。
 */
import { idempotencyKeyHashHex, idempotencyScope } from '../auth/idempotency.ts';
import type { PublishedContentRef } from './content-source.ts';

/**
 * 一个媒体登记册行的**服务层视图**（明文对象键 + 毫秒时间戳）。
 *
 * 列映射见 `store-pg.ts`：`createdAt/updatedAt/expiresAt` ↔ `timestamptz`，`rawRef` ↔
 * `media.object_ref_cipher`，`derivativeRef` ↔ `media_derivatives.object_ref_cipher`。
 * **没有** `metadata_removed`：0001 的表没有这一列，EXIF 剥离结果只在 `completeUpload`
 * 的当次响应里出现，不冒充可持久化事实。
 */
export interface MediaRecord {
  id: string;
  ownerId: string;
  revision: number;
  purpose: string;
  mime: string;
  bytes: number;
  duration_ms: number | null;
  sha256: string;
  state: string;
  failure_code: string | null;
  rawRef: string | null;
  derivativeRef: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

/** 一次社区媒体读授权（`community_media_grants` 行的服务层视图；token 只存摘要）。 */
export interface CommunityGrantRecord {
  grantId: string;
  tokenHash: string;
  requesterId: string;
  sessionRef: string;
  requesterAuthEpoch: number;
  mediaId: string;
  mediaRevision: number;
  contentRef: PublishedContentRef;
  slot: 'attachment' | 'author_avatar';
  authorRevision: number | null;
  expiresAt: number;
  revokedAt: number | null;
}

/**
 * 幂等台账条目。`mediaId === null` 表示**占位中**（另一请求正在产生结果），
 * 与 0008 表里 `outcome IS NULL` 同义。
 */
export interface MediaIdempotencyEntry {
  requestHash: string;
  mediaId: string | null;
}

/**
 * 一条「**待清理对象**」意图（迁移 `0029_media_object_cleanup` 的
 * `public.media_object_cleanup` 行）的服务层视图。
 *
 * ## 为什么需要它（监工 1022-0203 / 1022-0541 / 1022-0659 三轮 P1）
 * 「桶删除返回 `false` ⇒ 端口**未确认**删除 ⇒ 必须保留引用以便重试」这条隐私红线原来只有
 * **父行**一个落点。而父行随时可能被并发的 `delete` 清空引用（`deleted` 是软删，行还在、
 * `rawRef`/`derivativeRef` 都成了 `null`），也可能被注销清理物理删掉。于是一旦「桶这次删不掉」
 * 撞上「父行同时没了引用」，`cleanupOrphans` 只能枚举真行 ⇒ **永远找不到那个对象**，
 * 一次失败的尽力删除就把可重试的清理依据永久丢掉。
 *
 * ⇒ 意图必须**先**落到一个不依赖父行存活的台账里，再尝试桶删除；只有**确认**删除成功
 * （端口返回 `true`，含幂等删除「对象本就不存在」）才删该行。父行被删**不**级联删除本表。
 *
 * 字段口径：`objectRef` 是端口层**明文**对象键（真库落在密文列 `object_ref_cipher`，
 * 另有 `object_ref_digest`=sha256 明文键，供去重与按对象删行）；`attempts` 是**尝试次数**
 * （首次登记 = 1，每次重新登记 +1），用来看「这个对象重试了几轮还没清掉」。
 */
export interface MediaObjectCleanupEntry {
  /** 产生该对象的媒体行 id。**只做定位**，不建外键（父行可能已被物理删除）。 */
  mediaId: string;
  /** 待清理的对象键（明文；真库为密文列 + 摘要列）。 */
  objectRef: string;
  /** 为什么需要清（闭集 slug：`cas_conflict` / `owner_delete` / `reject_<failure_code>`）。 */
  reason: string;
  attempts: number;
}

/** 幂等回执保留时长（与 0008 台账 24h 同口径，见 `auth/idempotency.ts:33`）。 */
export const MEDIA_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 占位有效期：占位者崩了也不会把键永久钉住。
 * 短于回执 TTL 是刻意的——占位只是「有人正在算」，不是结果。
 */
export const MEDIA_IDEMPOTENCY_CLAIM_TTL_MS = 60 * 1000;

/**
 * 条件写的**前置条件**：写入前库内该行的 `revision` 与 `state`，即读快照那一刻的值。
 * 两者都进 `WHERE`：只比 `revision` 会漏掉「同 revision 但状态已变」的写法，只比 `state`
 * 会漏掉「状态没变但 generation 已推进」的写法。
 */
export interface MediaWritePrecondition {
  revision: number;
  state: string;
}

/** 媒体域持久化端口。全部方法异步：真库实现无法同步返回，端口不能承诺同步性。 */
export interface MediaStore {
  readonly persistent: boolean;
  readonly kind: 'memory' | 'postgres';

  /** 新建登记册行（`id` 冲突即抛错，与主键约束同语义）。 */
  createMedia(record: MediaRecord): Promise<void>;
  /**
   * **无条件**全量覆写一行（状态、revision、对象键、失败码、更新时间都走这一条）。
   *
   * 只给「这一行由调用方独占」的场合用：建库夹具、端口语义测试、离线脚本。**服务层不得使用**——
   * 服务手里的每一行都是从登记册读出来的**快照**，而 `complete` 与 `delete` 的幂等 scope 不同、
   * 可以并发；读快照到写回之间随时会有一次 `delete`/`expire` 落地，无条件写会把已经写好的
   * 终态覆写回去（监工 1927 轮 P1：已成功删除的媒体被迟到的 `complete` 复活成 `ready`）。
   */
  saveMedia(record: MediaRecord): Promise<void>;
  /**
   * **条件**全量覆写：仅当库内该行仍是 `expected` 声明的 `revision` 与 `state` 时写入，
   * 返回**影响行数**（1 = 已写入；0 = 前置条件不成立，一行都没写，连带衍生件也不写）。
   *
   * 0 刻意不区分「行不存在」与「行已被推进」：真库 `UPDATE … WHERE … RETURNING` 两种情况都是
   * 空行集，内存实现必须同语义，否则两个实现会在竞态下给出不同结论。需要区分时由调用方在
   * 拿到 0 之后再 `getMedia` 一次，按真实状态决定对外错误码（删除 ⇒ `OBJECT_UNAVAILABLE`，
   * 其它推进 ⇒ `REVISION_CONFLICT`）。
   */
  saveMediaIfCurrent(record: MediaRecord, expected: MediaWritePrecondition): Promise<number>;
  getMedia(id: string): Promise<MediaRecord | null>;
  /**
   * 该 owner 当前仍占据「社区图位」的媒体数（`purpose='community_image'` 且
   * 状态不是 `deleted`/`rejected`）。上限判定用它，不能用「历史累计」。
   */
  liveCommunityImageCount(ownerId: string): Promise<number>;
  /** 按状态枚举（清理器用：`expireInitiated` 取 `initiated`，`cleanupOrphans` 取 `rejected`/`deleted`）。 */
  listMediaByState(states: readonly string[]): Promise<MediaRecord[]>;
  countMedia(): Promise<number>;

  createGrant(grant: CommunityGrantRecord): Promise<void>;
  getGrant(grantId: string): Promise<CommunityGrantRecord | null>;
  /** 把某媒体的所有存活授权置为已撤销；返回撤销行数。 */
  revokeGrantsForMedia(mediaId: string, revokedAtMs: number): Promise<number>;
  /** 已过期或已撤销的授权（清理器用）。 */
  listStaleGrants(atMs: number): Promise<CommunityGrantRecord[]>;
  /** 物理删除一行授权（清理器用；`getGrant` 已把 revoked/过期判为未命中）。 */
  deleteGrant(grantId: string): Promise<void>;
  countGrants(): Promise<number>;

  findIdempotency(scope: string, keyHashHex: string): Promise<MediaIdempotencyEntry | null>;
  /** 原子占位：已有存活条目（含占位中）⇒ false。 */
  claimIdempotency(
    scope: string,
    keyHashHex: string,
    claim: { requestHash: string; expiresAt: number },
  ): Promise<boolean>;
  /** 写最终结果：仅当该条仍是占位中时成功。 */
  settleIdempotency(
    scope: string,
    keyHashHex: string,
    done: { requestHash: string; mediaId: string; expiresAt: number },
  ): Promise<boolean>;
  /** 放弃占位（produce 失败）；只删占位中的条目。 */
  releaseIdempotency(scope: string, keyHashHex: string): Promise<void>;

  /**
   * **登记一条「待清理对象」意图**（幂等 upsert）：同一 `objectRef` 已存在 ⇒ 只累计 `attempts`
   * 并刷新 `reason`/`updatedAt`，不新增第二行（重试器按行扫描，不能越重试越多）。
   *
   * 调用时序是硬要求（见 {@link MediaObjectCleanupEntry}）：**先**登记，**再**尝试桶删除；
   * 只有桶删除被确认成功才调 {@link deleteObjectCleanup}。
   */
  saveObjectCleanup(intent: { mediaId: string; objectRef: string; reason: string }, atMs: number): Promise<void>;
  /** 枚举全部待清理意图（重试器扫描面；不含已确认删除的对象——那些行已被删掉）。 */
  listObjectCleanup(): Promise<MediaObjectCleanupEntry[]>;
  /**
   * 删掉某对象键的待清理行（**只允许在桶删除被确认成功后调用**）；返回删除行数。
   * 重复调用返回 0（幂等）。
   */
  deleteObjectCleanup(objectRef: string): Promise<number>;
}

/** 幂等键域：主体（owner） + 方法 + 路由模板。与 `auth/idempotency.ts:111-113` 同一格式。 */
export function mediaIdempotencyScope(ownerId: string, method: string, routePath: string): string {
  return idempotencyScope(ownerId, method, routePath);
}

/** 键摘要：`SHA-256(scope || '\n' || 原始键)`，hex。与 `auth/idempotency.ts:116-118` 同口径。 */
export function mediaIdempotencyKeyHash(scope: string, key: string): string {
  return idempotencyKeyHashHex(scope, key);
}

/**
 * 幂等键域用的**路由模板**（方法由 `mediaIdempotencyScope` 单独拼进 scope）。
 * 用模板而不是具体路径：`/media/{id}/complete` 的 `{id}` 不能进键域，否则同一个键
 * 换一个媒体 id 就变成另一个键域，幂等语义被绕开。
 */
export const MEDIA_IDEMPOTENCY_PATHS = {
  initiate: '/api/v1/media/uploads',
  complete: '/api/v1/media/uploads/{id}/complete',
  remove: '/api/v1/media/{id}',
} as const;

function copyRecord(record: MediaRecord): MediaRecord {
  return { ...record };
}

function copyGrant(grant: CommunityGrantRecord): CommunityGrantRecord {
  return { ...grant, contentRef: { ...grant.contentRef } };
}

/**
 * 进程内实现：**仅供 stub 模式与单元测试**。
 *
 * 刻意保持「读写都是快照」：与 Postgres 实现一致，免得内存版替真库掩盖漏落库的 bug。
 * 占位/结算都是**函数体内无 await 的同步临界区**，同键并发只有一个能成功。
 */
export function createMemoryMediaStore(options: { now?: () => number } = {}): MediaStore {
  const now = options.now ?? (() => Date.now());
  const media = new Map<string, MediaRecord>();
  const grants = new Map<string, CommunityGrantRecord>();
  const idempotency = new Map<string, { requestHash: string; mediaId: string | null; expiresAt: number }>();
  // 清理台账：**键就是对象键本身**（内存实现没有密文列，也不必模拟摘要列）。
  const cleanup = new Map<string, MediaObjectCleanupEntry>();

  const liveEntry = (scope: string, keyHashHex: string) => {
    const entry = idempotency.get(`${scope}\u0000${keyHashHex}`);
    if (entry === undefined) return null;
    if (entry.expiresAt <= now()) {
      idempotency.delete(`${scope}\u0000${keyHashHex}`);
      return null;
    }
    return entry;
  };

  return {
    persistent: false,
    kind: 'memory',

    async createMedia(record) {
      if (media.has(record.id)) throw new Error(`媒体登记册已存在该 id（${record.id}）`);
      media.set(record.id, copyRecord(record));
    },
    async saveMedia(record) {
      if (!media.has(record.id)) throw new Error(`媒体登记册不存在该 id（${record.id}）`);
      media.set(record.id, copyRecord(record));
    },
    async saveMediaIfCurrent(record, expected) {
      const current = media.get(record.id);
      // 与真库 `UPDATE … WHERE id AND revision AND state … RETURNING id` 同语义：
      // 行不存在或前置条件不成立都是 0 行，且**不写**（含衍生件）。
      if (current === undefined) return 0;
      if (current.revision !== expected.revision || current.state !== expected.state) return 0;
      media.set(record.id, copyRecord(record));
      return 1;
    },
    async getMedia(id) {
      const record = media.get(id);
      return record === undefined ? null : copyRecord(record);
    },
    async liveCommunityImageCount(ownerId) {
      let count = 0;
      for (const record of media.values()) {
        if (record.ownerId !== ownerId) continue;
        if (record.purpose !== 'community_image') continue;
        if (record.state === 'deleted' || record.state === 'rejected') continue;
        count += 1;
      }
      return count;
    },
    async listMediaByState(states) {
      const wanted = new Set(states);
      return [...media.values()].filter((record) => wanted.has(record.state)).map(copyRecord);
    },
    async countMedia() {
      return media.size;
    },

    async createGrant(grant) {
      if (grants.has(grant.grantId)) throw new Error(`媒体授权已存在该 id（${grant.grantId}）`);
      grants.set(grant.grantId, copyGrant(grant));
    },
    async getGrant(grantId) {
      const grant = grants.get(grantId);
      return grant === undefined ? null : copyGrant(grant);
    },
    async revokeGrantsForMedia(mediaId, revokedAtMs) {
      let revoked = 0;
      for (const [grantId, grant] of grants) {
        if (grant.mediaId !== mediaId || grant.revokedAt !== null) continue;
        grants.set(grantId, { ...grant, revokedAt: revokedAtMs });
        revoked += 1;
      }
      return revoked;
    },
    async listStaleGrants(atMs) {
      return [...grants.values()]
        .filter((grant) => grant.revokedAt !== null || grant.expiresAt <= atMs)
        .map(copyGrant);
    },
    async deleteGrant(grantId) {
      grants.delete(grantId);
    },
    async countGrants() {
      return grants.size;
    },

    async findIdempotency(scope, keyHashHex) {
      const entry = liveEntry(scope, keyHashHex);
      return entry === null ? null : { requestHash: entry.requestHash, mediaId: entry.mediaId };
    },
    async claimIdempotency(scope, keyHashHex, claim) {
      if (liveEntry(scope, keyHashHex) !== null) return false;
      idempotency.set(`${scope}\u0000${keyHashHex}`, {
        requestHash: claim.requestHash,
        mediaId: null,
        expiresAt: claim.expiresAt,
      });
      return true;
    },
    async settleIdempotency(scope, keyHashHex, done) {
      const entry = liveEntry(scope, keyHashHex);
      if (entry === null || entry.mediaId !== null) return false;
      idempotency.set(`${scope}\u0000${keyHashHex}`, {
        requestHash: entry.requestHash,
        mediaId: done.mediaId,
        expiresAt: done.expiresAt,
      });
      return true;
    },
    async releaseIdempotency(scope, keyHashHex) {
      const entry = liveEntry(scope, keyHashHex);
      if (entry === null || entry.mediaId !== null) return;
      idempotency.delete(`${scope}\u0000${keyHashHex}`);
    },

    async saveObjectCleanup(intent) {
      const existing = cleanup.get(intent.objectRef);
      // 与真库的 `INSERT … ON CONFLICT (object_ref_digest) DO UPDATE` 同语义：一行、次数累加。
      cleanup.set(intent.objectRef, {
        mediaId: intent.mediaId,
        objectRef: intent.objectRef,
        reason: intent.reason,
        attempts: existing === undefined ? 1 : existing.attempts + 1,
      });
    },
    async listObjectCleanup() {
      return [...cleanup.values()].map((entry) => ({ ...entry }));
    },
    async deleteObjectCleanup(objectRef) {
      return cleanup.delete(objectRef) ? 1 : 0;
    },
  };
}
