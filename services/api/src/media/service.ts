/**
 * GY-I06（#6）媒体域 · 服务层（HTTP 面的唯一业务入口）。
 *
 * 覆盖冻结契约（`packages/contracts/openapi.json` / `operations.json`）的 7 个 operationId：
 *   POST   /media/uploads                      createUpload
 *   POST   /media/uploads/{id}/complete        completeUpload
 *   GET    /media/{id}                         getMedia
 *   DELETE /media/{id}                         deleteMedia
 *   POST   /media/{id}/access                  grantMediaAccess
 *   POST   /community/media-access             grantCommunityMediaAccess
 *   GET    /community/media/{grant_id}/content readCommunityMediaContent
 *
 * ## 为什么本文件存在（与 `packages/media/service.mjs` 的分工）
 *
 * `packages/media/**`（PR #60 已合并）是本模块的**参考实现与唯一事实来源**：枚举、限额、
 * 状态机、错误码、魔数嗅探、EXIF 结构性段清除、音频真实时长、短效句柄签名全部在那里，**本文件一行不改它**。
 *
 * 但它的 `createMediaService` 有两个形状与**冻结契约**不一致，无法直接充当 HTTP 面：
 *   1. 其存储端口是**同步**的（`record.rawRef = store.put(body, mime)`），而真实对象存储的读写是网络 I/O；
 *   2. 其 `completeUpload({ body })` 要求调用方把**媒体字节**直接交给它，而契约的
 *      `UploadCompleteInput` 只有 `{ sha256, bytes }` —— **不含媒体字节**：字节必须先由服务端从对象
 *      存储取回（见 openapi: “验实际魔数/hash/字节、解码和EXIF”）。
 * 因此本层承担「异步对象存储 + 按契约取回字节」的适配，**其余业务语义全部复用 `packages/media` 的原语**
 * （`validateUploadInput` / `validateCompleteInput` / `assertBytesMatchDeclaration` / `stripImageMetadata` /
 * `createAccessTokenFactory` / 常量与 `MediaError`）。`packages/media/service.mjs` 保持为模块内参考实现，
 * 由 `tests/media/**` 覆盖，二者语义一致性由「同一批原语」保证。
 *
 * ## 状态机（state-contract）
 * `initiated → uploaded → processing → ready`；任一非删除状态 → `rejected`；→ `deleting → deleted`。
 *
 * ## 归属与越权（契约硬红线）
 * 非 owner 与不存在**逐字节同形** 404 `NOT_FOUND`（`getMedia` / `deleteMedia` / `grantMediaAccess` /
 * `completeUpload` 的重放前重新鉴权一律如此），不泄露存在性。
 *
 * ## real 模式 fail-closed（监工对 #121 的 P1 裁定）
 * `executionMode === 'real'` 且注入的对象存储端口 `kind !== 's3_compatible'` ⇒ **整个媒体域**
 * 一律 `PROVIDER_UNAVAILABLE`（503，`retryable: true`）。判据是端口的 `kind`，不是自述布尔标志；
 * 将来接真实存储必须在装配层**显式**传入真实适配器。装配路径默认给 `real` 的是 `unwired` 端口。
 */
import { randomUUID } from 'node:crypto';
import type { ErrorCode } from '../contract.ts';
import { isErrorCode } from '../contract.ts';
import { ApiError } from '../errors.ts';
import {
  COMMUNITY_MAX_IMAGES_PER_POST,
  MEDIA_ACCESS_TTL_MS,
  MEDIA_INITIATED_TTL_MS,
  MEDIA_MAX_BYTES,
  MEDIA_MAX_DURATION_MS,
  MediaError,
  assertBytesMatchDeclaration,
  canTransition,
  createAccessTokenFactory,
  kindOf,
  newObjectRef,
  sha256Hex,
  stripImageMetadata,
  validateCompleteInput,
  validateUploadInput,
} from '../../../../packages/media/index.mjs';
import type { MediaObjectStore, PresignedHandle } from './object-store.ts';
import { createUnwiredObjectStore } from './object-store.ts';
import type { PublishedContentRef, PublishedContentSource } from './content-source.ts';
import { createClosedContentSource } from './content-source.ts';

/** 服务端权威身份（客户端**无法**通过 body/query/自定义头声明）。 */
export interface MediaActor {
  /** 服务端解析的账号 id（`request.userId`）。 */
  ownerId: string;
  /** 账号 auth_epoch（正整数）。 */
  authEpoch: number;
  /** 会话 id（不含明文令牌）。 */
  sessionRef: string;
}

/** 契约 `Media` 投影：只含契约字段，**绝不含** object_ref / owner / 桶路径。 */
export interface MediaProjection {
  id: string;
  revision: number;
  purpose: string;
  mime: string;
  bytes: number;
  duration_ms: number | null;
  state: string;
  sha256: string;
  failure_code: string | null;
}

/** 契约 `AccessGrant`。 */
export interface AccessGrantProjection {
  url: string;
  expires_at: string;
  method: 'PUT' | 'GET';
  access_token: string;
}

export interface UploadGrantOutcome {
  status: 201;
  media: MediaProjection;
  upload: AccessGrantProjection;
}

export interface MediaOutcome {
  status: 200 | 202;
  media: MediaProjection;
}

export interface DeleteOutcome {
  status: 202;
  ack: { accepted: true };
  revision: number;
}

export interface OwnerAccessOutcome {
  status: 200;
  mediaRevision: number;
  grant: AccessGrantProjection;
}

export interface CommunityGrantProjection {
  grant_id: string;
  content_ref: PublishedContentRef;
  media_ref: { media_id: string; media_revision: number };
  slot: 'attachment' | 'author_avatar';
  author_revision: number | null;
  access: AccessGrantProjection;
}

export interface CommunityGrantOutcome {
  status: 200;
  contentRevision: number;
  grant: CommunityGrantProjection;
}

export interface CommunityContentOutcome {
  status: 200;
  bytes: Uint8Array;
  contentType: string;
  revision: number;
}

/**
 * 「社区每帖 ≤3 图」的判定端口。
 *
 * 冻结契约的 `UploadInput` **没有**帖子上下文（无 post id），因此真正的「每帖」判定点是**附件挂载**
 * （属社区线 GY-I15），不在本端点。这里显式建模为端口，避免悄悄放宽或悄悄按错口径计数：
 * - `substitute`（stub/preset_demo/测试）：按**同一 owner 名下存活的 `community_image` 记录数**计数 ——
 *   这是**保守替身**（大于等于真实每帖数），并已如实标注；
 * - `unwired`（real）：无法判定 ⇒ 拒绝该用途的 `createUpload`（503），**不猜测**。
 */
export interface CommunityAttachmentCounter {
  readonly kind: 'substitute' | 'unwired' | 'injected';
  readonly note: string;
  /** 返回该 owner 当前已占用的图片槽位数；无法判定返回 null。 */
  countFor(input: { ownerId: string; liveCommunityImages: number }): number | null;
}

interface MediaRecord {
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
  /** 对象存储键：客户端直传的原始对象（`initiated` 时即已签发，可能尚未落盘）。 */
  rawRef: string | null;
  /** 去元数据衍生件；音频无衍生件。 */
  derivativeRef: string | null;
  metadata_removed: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface CommunityGrantRecord {
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

export interface AppMediaService {
  readonly executionMode: string;
  readonly objectStore: MediaObjectStore;
  readonly contentSource: PublishedContentSource;
  readonly attachmentCounter: CommunityAttachmentCounter;
  /** 非 null 表示整域 fail-closed（real 且真实存储未接线）。 */
  readonly failClosedReason: string | null;
  initiateUpload(input: {
    actor: MediaActor;
    input: unknown;
    idempotencyKey: string;
  }): Promise<UploadGrantOutcome>;
  completeUpload(input: {
    actor: MediaActor;
    mediaId: string;
    ifMatch: string | undefined;
    input: unknown;
    idempotencyKey: string;
  }): Promise<MediaOutcome>;
  getMedia(input: { actor: MediaActor; mediaId: string }): Promise<MediaOutcome>;
  deleteMedia(input: {
    actor: MediaActor;
    mediaId: string;
    ifMatch: string | undefined;
    idempotencyKey: string;
  }): Promise<DeleteOutcome>;
  grantMediaAccess(input: {
    actor: MediaActor;
    mediaId: string;
    ifMatch: string | undefined;
    idempotencyKey: string;
  }): Promise<OwnerAccessOutcome>;
  grantCommunityMediaAccess(input: {
    actor: MediaActor;
    body: unknown;
    ifMatch: string | undefined;
    idempotencyKey: string;
  }): Promise<CommunityGrantOutcome>;
  readCommunityMediaContent(input: {
    actor: MediaActor;
    grantId: string;
    accessToken: string;
  }): Promise<CommunityContentOutcome>;
  /** 24h 未完成的 `initiated` 记录回收（state-contract）。 */
  expireInitiated(): Promise<{ expired: number }>;
  /**
   * `rejected` / `deleted` 记录的对象与已失效句柄统一清理。
   *
   * `pendingObjects` = 端口抛错或返回 `false`（**未能确认删除**）而被保留引用的对象数 ⇒ 仍可重试；
   * `remainingObjects` = 清扫一次后对象存储中仍然存在的对象数（诊断用）。
   */
  cleanupOrphans(): Promise<{
    removedObjects: number;
    revokedGrants: number;
    pendingObjects: number;
    remainingObjects: number;
  }>;
  stats(): Promise<{ mediaCount: number; objectCount: number; grantCount: number }>;
  /**
   * **仅服务端/测试用**：读取某条记录的私有对象键（用于在测试里模拟「客户端直传对象存储」）。
   * 绝不进入任何响应投影、日志或公开列表。
   */
  serverObjectKeys(mediaId: string): { rawRef: string | null; derivativeRef: string | null } | null;
}

export interface AppMediaServiceOptions {
  executionMode: string;
  objectStore: MediaObjectStore;
  tokenSecret: string;
  contentSource?: PublishedContentSource;
  attachmentCounter?: CommunityAttachmentCounter;
  now?: () => Date;
  idFactory?: () => string;
}

// --------------------------------------------------------------------- 端口替身

const SUBSTITUTE_COUNTER_NOTE =
  '替身图片槽位计数器（stub/preset_demo/测试）：按同一 owner 名下存活的 community_image 记录数计数；' +
  '这是「每帖 ≤3 张」的**保守替身**，真正的每帖判定点在附件挂载（社区线 GY-I15）。';

/** 保守替身计数器：用调用方传入的存活 community_image 数作为「当前帖已占用槽位」。 */
export function createSubstituteAttachmentCounter(): CommunityAttachmentCounter {
  return {
    kind: 'substitute',
    note: SUBSTITUTE_COUNTER_NOTE,
    countFor({ liveCommunityImages }) {
      return liveCommunityImages;
    },
  };
}

/** 未接线计数器（real）：无法判定 ⇒ null ⇒ 拒绝该用途（不猜测、不放宽）。 */
export function createUnwiredAttachmentCounter(): CommunityAttachmentCounter {
  return {
    kind: 'unwired',
    note: '图片槽位计数器未接线（real）：无法判定「每帖 ≤3 张」⇒ 拒绝 community_image 上传（fail-closed）。',
    countFor() {
      return null;
    },
  };
}

/** 测试注入计数器。 */
export function createInjectedAttachmentCounter(
  count: (input: { ownerId: string; liveCommunityImages: number }) => number | null,
): CommunityAttachmentCounter {
  return {
    kind: 'injected',
    note: '测试注入的图片槽位计数器。',
    countFor: count,
  };
}

// --------------------------------------------------------------------- 工具

/** `MediaError`（packages/media）→ `ApiError`（services/api），错误码逐字保留。 */
function rethrowMediaError(error: unknown): never {
  if (error instanceof MediaError) {
    const code: string = error.code;
    if (isErrorCode(code)) {
      throw new ApiError(code as ErrorCode, error.message, {
        retryable: error.retryable,
        details: error.details,
      });
    }
  }
  throw error;
}

/** 执行 `fn`；若抛出 `MediaError` 则转换为契约 `ApiError`（错误码逐字保留）。 */
function attempt<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    rethrowMediaError(error);
  }
}

/** 异步版：对象存储端口抛出的 `MediaError`（如未接线端口的 PROVIDER_UNAVAILABLE）同样转为 `ApiError`。 */
async function attemptAsync<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (error) {
    rethrowMediaError(error);
  }
}

/** 通过函数读取状态：阻断 TS 对 `record.state` 的窄化（catch 分支需要看真实状态）。 */
function isRejectedRecord(record: { state: string }): boolean {
  return record.state === 'rejected';
}

function requireActor(actor: MediaActor): void {
  if (actor.ownerId === '' || !Number.isInteger(actor.authEpoch) || actor.authEpoch < 1) {
    throw new ApiError('SESSION_REQUIRED', '缺少会话身份');
  }
}

function requireIdempotencyKey(key: string): void {
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 128) {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', '缺少或非法的 Idempotency-Key 头（8..128 字符）');
  }
}

/** If-Match：契约 `^"[1-9][0-9]*"$`；缺失 428、格式非法 400、不匹配 409。 */
function requireIfMatch(ifMatch: string | undefined, currentRevision: number): number {
  if (ifMatch === undefined || ifMatch === '') {
    throw new ApiError('REVISION_REQUIRED', '缺少 If-Match 版本头');
  }
  if (!/^"[1-9][0-9]*"$/.test(ifMatch)) {
    throw new ApiError('INVALID_REQUEST', 'If-Match 必须是形如 "1" 的强 ETag');
  }
  const parsed = Number(ifMatch.slice(1, -1));
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError('INVALID_REQUEST', 'If-Match 版本超出安全整数范围');
  }
  if (parsed !== currentRevision) {
    throw new ApiError('REVISION_CONFLICT', 'If-Match 版本与当前版本不一致');
  }
  return parsed;
}

function hashRequest(value: unknown): string {
  return sha256Hex(Buffer.from(JSON.stringify(value), 'utf8'));
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

// ------------------------------------------------------------- 整域 fail-closed

/**
 * real 模式且真实对象存储未接线 ⇒ **整域** `PROVIDER_UNAVAILABLE`（503，`retryable: true`）。
 * 绝不返回任何成功封套（那等于把内存/替身存储记成真实持久化）。
 */
export function createFailClosedMediaService(reason: string): AppMediaService {
  const fail = (): ApiError => new ApiError('PROVIDER_UNAVAILABLE', `${reason}（fail-closed）`, { retryable: true });
  const objectStore = createUnwiredObjectStore(reason);
  const contentSource = createClosedContentSource();
  const attachmentCounter = createUnwiredAttachmentCounter();
  return {
    executionMode: 'real',
    objectStore,
    contentSource,
    attachmentCounter,
    failClosedReason: reason,
    async initiateUpload(): Promise<UploadGrantOutcome> {
      throw fail();
    },
    async completeUpload(): Promise<MediaOutcome> {
      throw fail();
    },
    async getMedia(): Promise<MediaOutcome> {
      throw fail();
    },
    async deleteMedia(): Promise<DeleteOutcome> {
      throw fail();
    },
    async grantMediaAccess(): Promise<OwnerAccessOutcome> {
      throw fail();
    },
    async grantCommunityMediaAccess(): Promise<CommunityGrantOutcome> {
      throw fail();
    },
    async readCommunityMediaContent(): Promise<CommunityContentOutcome> {
      throw fail();
    },
    async expireInitiated(): Promise<{ expired: number }> {
      throw fail();
    },
    async cleanupOrphans(): Promise<{
      removedObjects: number;
      revokedGrants: number;
      pendingObjects: number;
      remainingObjects: number;
    }> {
      throw fail();
    },
    async stats(): Promise<{ mediaCount: number; objectCount: number; grantCount: number }> {
      return { mediaCount: 0, objectCount: 0, grantCount: 0 };
    },
    serverObjectKeys(): { rawRef: string | null; derivativeRef: string | null } | null {
      throw fail();
    },
  };
}

// --------------------------------------------------------------------- 实现

/**
 * 建立媒体域服务。
 *
 * `real` 且对象存储端口 `kind !== 's3_compatible'` ⇒ 直接返回整域 fail-closed 实例
 * （判据是端口 `kind`，不是自述标志）。
 */
export function createAppMediaService(options: AppMediaServiceOptions): AppMediaService {
  const { executionMode, objectStore } = options;
  if (executionMode === 'real' && objectStore.kind !== 's3_compatible') {
    return createFailClosedMediaService(
      'real 模式未接真实对象存储：媒体域不可用（拒绝以内存/替身存储返回成功应答）',
    );
  }

  const contentSource = options.contentSource ?? createClosedContentSource();
  const attachmentCounter =
    options.attachmentCounter ??
    (executionMode === 'real' ? createUnwiredAttachmentCounter() : createSubstituteAttachmentCounter());
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => randomUUID());
  const tokenFactory = createAccessTokenFactory(options.tokenSecret);

  const records = new Map<string, MediaRecord>();
  const grants = new Map<string, CommunityGrantRecord>();
  /** `${ownerId}:${op}:${key}` → { requestHash, mediaId }；请求 hash **含原 If-Match**（与 B3 口径一致）。 */
  const idempotency = new Map<string, { requestHash: string; mediaId: string }>();
  /** 正在处理的同键请求（在任何 `await` 之前同步登记，跨 await 保持）。 */
  const inflight = new Set<string>();

  const at = (): number => now().getTime();
  const iso = (ms: number): string => new Date(ms).toISOString();

  function toProjection(record: MediaRecord): MediaProjection {
    return {
      id: record.id,
      revision: record.revision,
      purpose: record.purpose,
      mime: record.mime,
      bytes: record.bytes,
      duration_ms: record.duration_ms,
      state: record.state,
      sha256: record.sha256,
      failure_code: record.failure_code,
    };
  }

  function transition(record: MediaRecord, to: string, timestamp: number): void {
    if (!canTransition(record.state, to)) {
      throw new ApiError('OBJECT_UNAVAILABLE', `当前状态不可迁移：${record.state} → ${to}`);
    }
    record.state = to;
    record.updatedAt = timestamp;
  }

  /**
   * 回收记录持有的私有对象。
   *
   * **隐私红线（监工批复 P1 返修）**：只有**确认删除成功**（端口返回 `true`）才清空该引用。
   * 端口**抛错**或返回 **`false`** ⇒ **保留该引用**，使 `cleanupOrphans` / 后续重试**仍有依据**；
   * 未确认删除**绝不算成功**，也绝不让「删不掉的对象」变成不可达的孤儿。
   *
   * 端口契约（`MediaObjectStore.deleteObject`）因此被明确为：`true` = 已确认删除
   * （含幂等删除「对象本就不存在」，与 S3 `DeleteObject` 的 204 语义一致）；
   * `false` = **未能确认**；抛出 = 暂时失败。后两者都保留引用。
   */
  async function dropObjects(record: MediaRecord): Promise<{ removed: number; pending: number }> {
    let removed = 0;
    let pending = 0;
    for (const field of ['rawRef', 'derivativeRef'] as const) {
      const ref = record[field];
      if (ref === null) continue;
      try {
        if (await objectStore.deleteObject(ref)) {
          record[field] = null;
          removed += 1;
        } else {
          // 未确认删除：**保留引用**，留给 cleanupOrphans / 下次删除重试。
          pending += 1;
        }
      } catch {
        // 暂时失败同样不得清空引用，否则永久丢失清理依据。
        pending += 1;
      }
    }
    return { removed, pending };
  }

  function revokeGrantsForMedia(mediaId: string, timestamp: number): number {
    let revoked = 0;
    for (const grant of grants.values()) {
      if (grant.mediaId === mediaId && grant.revokedAt === null) {
        grant.revokedAt = timestamp;
        revoked += 1;
      }
    }
    return revoked;
  }

  /** 同一 owner 名下存活的 community_image 记录数（保守替身计数器的输入）。 */
  function liveCommunityImageCount(ownerId: string): number {
    let count = 0;
    for (const record of records.values()) {
      if (record.ownerId === ownerId && record.purpose === 'community_image' && record.state !== 'deleted' && record.state !== 'rejected') {
        count += 1;
      }
    }
    return count;
  }

  function ownedRecord(actor: MediaActor, mediaId: string): MediaRecord {
    const record = records.get(mediaId);
    // 非本人 / 不存在**同形** 404：不泄露存在性。
    if (record === undefined || record.ownerId !== actor.ownerId) {
      throw new ApiError('NOT_FOUND', '媒体不存在');
    }
    return record;
  }

  /** 上传句柄 = 对象存储预签名 URL + 服务端签发的短效令牌（令牌**不入 URL**，契约 AccessGrant）。 */
  function uploadGrant(record: MediaRecord, handle: PresignedHandle): AccessGrantProjection {
    return {
      url: handle.url,
      expires_at: handle.expires_at,
      method: 'PUT',
      access_token: tokenFactory.issue({
        kind: 'upload',
        mediaId: record.id,
        revision: record.revision,
        ownerId: record.ownerId,
        exp: record.expiresAt,
      }),
    };
  }

  function attachmentLimitFor(actor: MediaActor, purpose: unknown): number {
    if (purpose !== 'community_image') return 0;
    const counted = attachmentCounter.countFor({
      ownerId: actor.ownerId,
      liveCommunityImages: liveCommunityImageCount(actor.ownerId),
    });
    if (counted === null) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '无法判定「每帖 ≤3 张」图片槽位：计数器未接线', {
        retryable: true,
      });
    }
    return counted;
  }

  // ------------------------------------------------------------ 生命周期

  /**
   * 同键**并发**占位：在任何 `await` 之前**同步**登记，使同一 Idempotency-Key 的并发请求
   * 不会各自创建资源（那会产生重复媒体记录，并让先落库对象的键成为孤立对象）。
   * 仍在处理中 ⇒ 409 `REQUEST_IN_PROGRESS`（`app.ts` 会附带 `Retry-After: 1`，
   * 与本仓既有幂等口径、契约 error_status_map 一致）。
   */
  async function withKeyClaim<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (inflight.has(key)) {
      throw new ApiError('REQUEST_IN_PROGRESS', '同一 Idempotency-Key 的请求正在处理中，请稍后重试', {
        retryable: true,
      });
    }
    inflight.add(key);
    try {
      return await run();
    } finally {
      inflight.delete(key);
    }
  }

  /** 只有形状合法的幂等键才参与并发占位；非法键交给函数体按契约报 400。 */
  function claimScope(ownerId: string, op: string, idempotencyKey: string): string | null {
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.trim().length < 8 ||
      idempotencyKey.length > 128
    ) {
      return null;
    }
    return `${ownerId}:${op}:${idempotencyKey}`;
  }

  const initiateUploadUnclaimed: AppMediaService['initiateUpload'] = async ({ actor, input, idempotencyKey }) => {
    requireActor(actor);
    requireIdempotencyKey(idempotencyKey);
    const requestHash = hashRequest({ op: 'initiate', input });
    const key = `${actor.ownerId}:initiate:${idempotencyKey}`;
    const prior = idempotency.get(key);
    if (prior !== undefined) {
      if (prior.requestHash !== requestHash) {
        throw new ApiError('IDEMPOTENCY_CONFLICT', '同一 Idempotency-Key 已被不同请求体使用');
      }
      const record = ownedRecord(actor, prior.mediaId);
      if (record.rawRef === null) {
        // 记录已 rejected / deleted：原上传句柄不再有效，不重新签发。
        throw new ApiError('OBJECT_UNAVAILABLE', '上传句柄已失效');
      }
      const handle = await attemptAsync(() =>
        objectStore.presignUpload({
          key: record.rawRef as string,
          contentType: record.mime,
          expiresInSeconds: Math.max(1, Math.floor((record.createdAt + MEDIA_INITIATED_TTL_MS - at()) / 1000)),
        }),
      );
      return { status: 201, media: toProjection(record), upload: uploadGrant(record, handle) };
    }

    const purpose = (input as { purpose?: unknown } | null)?.purpose;
    const mediaCountForPost = attachmentLimitFor(actor, purpose);
    const declared = attempt(() => validateUploadInput(input, { mediaCountForPost }));

    const timestamp = at();
    const rawRef = newObjectRef();
    const handle = await attemptAsync(() =>
      objectStore.presignUpload({
        key: rawRef,
        contentType: declared.mime,
        expiresInSeconds: Math.floor(MEDIA_INITIATED_TTL_MS / 1000),
      }),
    );
    const record: MediaRecord = {
      id: idFactory(),
      ownerId: actor.ownerId,
      revision: 1,
      purpose: declared.purpose,
      mime: declared.mime,
      bytes: declared.bytes,
      duration_ms: declared.duration_ms,
      sha256: declared.sha256,
      state: 'initiated',
      failure_code: null,
      rawRef,
      derivativeRef: null,
      metadata_removed: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: timestamp + MEDIA_INITIATED_TTL_MS,
    };
    records.set(record.id, record);
    idempotency.set(key, { requestHash, mediaId: record.id });
    return { status: 201, media: toProjection(record), upload: uploadGrant(record, handle) };
  };

  /** 并发同键保护后的 `createUpload`（占位在任何 await 之前同步取得）。 */
  const initiateUpload: AppMediaService['initiateUpload'] = (request) => {
    const key = claimScope(request.actor.ownerId, 'initiate', request.idempotencyKey);
    return key === null
      ? initiateUploadUnclaimed(request)
      : withKeyClaim(key, () => initiateUploadUnclaimed(request));
  };

  const completeUploadUnclaimed: AppMediaService['completeUpload'] = async ({ actor, mediaId, ifMatch, input, idempotencyKey }) => {
    requireActor(actor);
    requireIdempotencyKey(idempotencyKey);
    const record = ownedRecord(actor, mediaId);

    // 幂等（含原 If-Match）：同键同请求回放首次成功结果；同键异请求 → IDEMPOTENCY_CONFLICT。
    const requestHash = hashRequest({ op: 'complete', mediaId, ifMatch: ifMatch ?? null, input });
    const key = `${actor.ownerId}:complete:${idempotencyKey}`;
    const prior = idempotency.get(key);
    if (prior !== undefined) {
      if (prior.requestHash !== requestHash) {
        throw new ApiError('IDEMPOTENCY_CONFLICT', '同一 Idempotency-Key 已被不同的完成请求使用');
      }
      return { status: 202, media: toProjection(ownedRecord(actor, prior.mediaId)) };
    }

    requireIfMatch(ifMatch, record.revision);

    const declared = attempt(() => validateCompleteInput(input));
    if (declared.sha256 !== record.sha256 || declared.bytes !== record.bytes) {
      throw new ApiError('INVALID_REQUEST', '完成上传声明与初始化声明不一致');
    }
    if (record.state === 'ready') {
      idempotency.set(key, { requestHash, mediaId: record.id });
      return { status: 202, media: toProjection(record) };
    }
    if (record.state !== 'initiated' && record.state !== 'uploaded') {
      throw new ApiError('OBJECT_UNAVAILABLE', `当前状态不可完成上传：${record.state}`);
    }

    // 契约 UploadCompleteInput **不含**媒体字节：字节必须由服务端从对象存储取回。
    const stored = record.rawRef === null ? null : await attemptAsync(() => objectStore.getObject(record.rawRef as string));
    if (stored === null) {
      await reject(record, 'upload_missing');
      throw new ApiError('OBJECT_UNAVAILABLE', '上传对象不存在或已被回收');
    }

    const timestamp = at();
    try {
      transition(record, 'uploaded', timestamp);
      const detected = assertBytesMatchDeclaration({
        bytes: stored.bytes,
        declared: {
          mime: record.mime,
          bytes: record.bytes,
          sha256: record.sha256,
          purpose: record.purpose,
          duration_ms: record.duration_ms,
        },
      });

      if (kindOf(record.purpose) === 'image') {
        const stripped = stripImageMetadata(stored.bytes, detected.mime);
        if (!stripped.ok) {
          await reject(record, 'decode_failed');
          throw new MediaError('MEDIA_TYPE_UNSUPPORTED', '图片解码失败，无法去除元数据');
        }
        transition(record, 'processing', timestamp);
        const derivativeRef = newObjectRef();
        await attemptAsync(() => objectStore.putObject(derivativeRef, stripped.data, detected.mime));
        record.derivativeRef = derivativeRef;
        record.metadata_removed = stripped.removed;
      } else {
        transition(record, 'processing', timestamp);
        // 音频：以**真实时长**为准覆盖声明值（B2 口径）。
        if (typeof detected.durationMs === 'number') record.duration_ms = detected.durationMs;
      }
      transition(record, 'ready', timestamp);
    } catch (error) {
      // 失败即回收对象（不留孤立对象），再按契约错误码抛出。
      if (!isRejectedRecord(record)) await reject(record, 'validation_failed');
      rethrowMediaError(error);
    }

    record.revision += 1;
    idempotency.set(key, { requestHash, mediaId: record.id });
    return { status: 202, media: toProjection(record) };
  };

  /** 并发同键保护后的 `completeUpload`（避免同键并发重复自增与重复落衍生件）。 */
  const completeUpload: AppMediaService['completeUpload'] = (request) => {
    const key = claimScope(request.actor.ownerId, 'complete', request.idempotencyKey);
    return key === null
      ? completeUploadUnclaimed(request)
      : withKeyClaim(key, () => completeUploadUnclaimed(request));
  };

  /** 受控失败：迁移到 `rejected`、记录 failure_code、回收对象（孤立清理）。 */
  async function reject(record: MediaRecord, failureCode: string): Promise<void> {
    const timestamp = at();
    if (canTransition(record.state, 'rejected')) {
      record.state = 'rejected';
      record.updatedAt = timestamp;
    }
    record.failure_code = failureCode;
    await dropObjects(record);
    revokeGrantsForMedia(record.id, timestamp);
  }

  const getMedia: AppMediaService['getMedia'] = async ({ actor, mediaId }) => {
    requireActor(actor);
    return { status: 200, media: toProjection(ownedRecord(actor, mediaId)) };
  };

  const deleteMediaUnclaimed: AppMediaService['deleteMedia'] = async ({ actor, mediaId, ifMatch, idempotencyKey }) => {
    requireActor(actor);
    requireIdempotencyKey(idempotencyKey);
    const record = ownedRecord(actor, mediaId);
    const requestHash = hashRequest({ op: 'delete', mediaId, ifMatch: ifMatch ?? null });
    const key = `${actor.ownerId}:delete:${idempotencyKey}`;
    const prior = idempotency.get(key);
    if (prior !== undefined) {
      if (prior.requestHash !== requestHash) {
        throw new ApiError('IDEMPOTENCY_CONFLICT', '同一 Idempotency-Key 已被不同的删除请求使用');
      }
      const replay = ownedRecord(actor, prior.mediaId);
      return { status: 202, ack: { accepted: true }, revision: replay.revision };
    }
    requireIfMatch(ifMatch, record.revision);
    const timestamp = at();
    if (record.state !== 'deleted') {
      if (canTransition(record.state, 'deleting')) record.state = 'deleting';
      record.updatedAt = timestamp;
    }
    // **即使记录已是 `deleted`**（上一次未确认删除）也重试回收：不得因状态已终态而丢掉重试依据。
    // 未确认删除时 `rawRef` / `derivativeRef` 会被保留（见 dropObjects）；对外语义仍是 202 已删除。
    await dropObjects(record);
    record.state = 'deleted';
    record.updatedAt = timestamp;
    revokeGrantsForMedia(record.id, timestamp);
    record.revision += 1;
    idempotency.set(key, { requestHash, mediaId: record.id });
    return { status: 202, ack: { accepted: true }, revision: record.revision };
  };

  /** 并发同键保护后的 `deleteMedia`（避免同键并发重复自增 revision）。 */
  const deleteMedia: AppMediaService['deleteMedia'] = (request) => {
    const key = claimScope(request.actor.ownerId, 'delete', request.idempotencyKey);
    return key === null
      ? deleteMediaUnclaimed(request)
      : withKeyClaim(key, () => deleteMediaUnclaimed(request));
  };

  // ------------------------------------------------------- 私有 owner 访问

  const grantMediaAccess: AppMediaService['grantMediaAccess'] = async ({ actor, mediaId, ifMatch, idempotencyKey }) => {
    requireActor(actor);
    requireIdempotencyKey(idempotencyKey);
    const record = ownedRecord(actor, mediaId);
    requireIfMatch(ifMatch, record.revision);
    if (record.state !== 'ready') {
      throw new ApiError('OBJECT_UNAVAILABLE', '媒体尚未就绪');
    }
    const expiresAt = at() + MEDIA_ACCESS_TTL_MS;
    const token = tokenFactory.issue({
      kind: 'owner_read',
      mediaId: record.id,
      revision: record.revision,
      ownerId: actor.ownerId,
      authEpoch: actor.authEpoch,
      exp: expiresAt,
    });
    // 契约 `AccessGrant.url` 必须是 https 句柄；本端点的字节读取由部署期访问网关承担
    // （冻结契约内**没有**私有媒体内容路由，见证据文档「契约缺口」）。
    return {
      status: 200,
      mediaRevision: record.revision,
      grant: {
        url: `https://media.gengyun.local/api/v1/media/${record.id}/content`,
        expires_at: iso(expiresAt),
        method: 'GET',
        access_token: token,
      },
    };
  };

  // ------------------------------------------------- 社区公开取图（带内容上下文）

  const grantCommunityMediaAccess: AppMediaService['grantCommunityMediaAccess'] = async ({
    actor,
    body,
    ifMatch,
    idempotencyKey,
  }) => {
    requireActor(actor);
    requireIdempotencyKey(idempotencyKey);
    const parsed = body as
      | {
          content_ref?: PublishedContentRef;
          media_ref?: { media_id?: string; media_revision?: number };
          slot?: string;
          author_revision?: number | null;
        }
      | null;
    const contentRef = parsed?.content_ref;
    const mediaRef = parsed?.media_ref;
    const slot = parsed?.slot;
    if (
      contentRef === undefined ||
      mediaRef === undefined ||
      (slot !== 'attachment' && slot !== 'author_avatar') ||
      typeof contentRef.id !== 'string' ||
      (contentRef.type !== 'post' && contentRef.type !== 'comment') ||
      !Number.isInteger(contentRef.revision) ||
      typeof mediaRef.media_id !== 'string' ||
      !Number.isInteger(mediaRef.media_revision)
    ) {
      throw new ApiError('INVALID_REQUEST', '社区取图请求结构非法');
    }
    const authorRevision: number | null =
      parsed?.author_revision === null || parsed?.author_revision === undefined ? null : parsed.author_revision;
    if (authorRevision !== null && (!Number.isInteger(authorRevision) || authorRevision < 1)) {
      throw new ApiError('INVALID_REQUEST', 'author_revision 非法');
    }

    // 契约：If-Match 对应 **content_ref.revision**（不是媒体 revision）。
    requireIfMatch(ifMatch, contentRef.revision);

    const content = contentSource.getPublishedContent({
      type: contentRef.type,
      id: contentRef.id,
      revision: contentRef.revision,
    });
    // 不存在 / 未发布 / 未过审 / 版本不符 → 统一 404（不泄露存在性）。
    if (content === null || !content.published || !content.approved) {
      throw new ApiError('NOT_FOUND', '公开内容不存在');
    }
    const record = records.get(mediaRef.media_id);
    if (record === undefined || record.state !== 'ready' || record.purpose !== 'community_image') {
      throw new ApiError('NOT_FOUND', '公开内容不存在');
    }
    if (slot === 'attachment') {
      const authorized = content.media.some(
        (item) => item.mediaId === mediaRef.media_id && item.mediaRevision === mediaRef.media_revision,
      );
      if (!authorized || record.revision !== mediaRef.media_revision) {
        throw new ApiError('NOT_FOUND', '公开内容不存在');
      }
    } else {
      const avatar = content.avatarMedia;
      if (
        avatar === null ||
        avatar.mediaId !== mediaRef.media_id ||
        avatar.mediaRevision !== mediaRef.media_revision ||
        authorRevision === null ||
        authorRevision !== content.authorRevision ||
        record.revision !== mediaRef.media_revision
      ) {
        throw new ApiError('NOT_FOUND', '公开内容不存在');
      }
    }

    const expiresAt = at() + MEDIA_ACCESS_TTL_MS;
    const grantId = idFactory();
    const token = tokenFactory.issue({
      kind: 'community_read',
      grantId,
      mediaId: record.id,
      revision: record.revision,
      requesterId: actor.ownerId,
      sessionRef: actor.sessionRef,
      authEpoch: actor.authEpoch,
      exp: expiresAt,
    });
    grants.set(grantId, {
      grantId,
      tokenHash: tokenFactory.hash(token),
      requesterId: actor.ownerId,
      sessionRef: actor.sessionRef,
      requesterAuthEpoch: actor.authEpoch,
      mediaId: record.id,
      mediaRevision: record.revision,
      contentRef: { type: contentRef.type, id: contentRef.id, revision: contentRef.revision },
      slot,
      authorRevision: slot === 'author_avatar' ? content.authorRevision : null,
      expiresAt,
      revokedAt: null,
    });
    return {
      status: 200,
      contentRevision: contentRef.revision,
      grant: {
        grant_id: grantId,
        content_ref: { type: contentRef.type, id: contentRef.id, revision: contentRef.revision },
        media_ref: { media_id: record.id, media_revision: record.revision },
        slot,
        author_revision: slot === 'author_avatar' ? content.authorRevision : null,
        access: {
          url: `https://media.gengyun.local/api/v1/community/media/${grantId}/content`,
          expires_at: iso(expiresAt),
          method: 'GET',
          access_token: token,
        },
      },
    };
  };

  const readCommunityMediaContent: AppMediaService['readCommunityMediaContent'] = async ({
    actor,
    grantId,
    accessToken,
  }) => {
    requireActor(actor);
    if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > 512) {
      throw new ApiError('INVALID_REQUEST', '缺少或非法的 X-Media-Access-Token 头');
    }
    const grant = grants.get(grantId);
    if (grant === undefined) throw new ApiError('NOT_FOUND', '授权不存在');
    if (grant.tokenHash !== tokenFactory.hash(accessToken)) throw new ApiError('NOT_FOUND', '授权不存在');
    // 契约：「grant 绑定同一登录主体、内容/媒体/头像版本及用途 epoch …… 每次取图复核全部当前条件，
    // **失效统一 404**」。因此主体/会话/epoch 不符一律与「授权不存在」**逐字节同形** 404
    //（未登录或会话本身失效由 `guards.requireUser` 在更早处如实 401，不经本分支）。
    if (
      grant.requesterId !== actor.ownerId ||
      grant.sessionRef !== actor.sessionRef ||
      grant.requesterAuthEpoch !== actor.authEpoch
    ) {
      throw new ApiError('NOT_FOUND', '授权不存在');
    }
    if (grant.revokedAt !== null || grant.expiresAt <= at()) {
      throw new ApiError('NOT_FOUND', '授权不存在');
    }
    const record = records.get(grant.mediaId);
    if (
      record === undefined ||
      record.state !== 'ready' ||
      record.purpose !== 'community_image' ||
      record.revision !== grant.mediaRevision
    ) {
      throw new ApiError('NOT_FOUND', '授权不存在');
    }
    // 每次取图**复核**当前审核/发布/版本状态（短效句柄 ≠ 公开权限）。
    const content = contentSource.getPublishedContent(grant.contentRef);
    if (content === null || !content.published || !content.approved) {
      throw new ApiError('NOT_FOUND', '授权不存在');
    }
    if (grant.slot === 'author_avatar' && content.authorRevision !== grant.authorRevision) {
      throw new ApiError('NOT_FOUND', '授权不存在');
    }
    const bytes = record.derivativeRef === null ? null : await attemptAsync(() => objectStore.getObject(record.derivativeRef as string));
    if (bytes === null) throw new ApiError('NOT_FOUND', '授权不存在');
    // 对外只提供**已去元数据**的衍生件；原始对象不出网。
    return { status: 200, bytes: bytes.bytes, contentType: record.mime, revision: record.revision };
  };

  // ------------------------------------------------------------ 过期与清理

  const service: AppMediaService = {
    executionMode,
    objectStore,
    contentSource,
    attachmentCounter,
    failClosedReason: null,
    initiateUpload,
    completeUpload,
    getMedia,
    deleteMedia,
    grantMediaAccess,
    grantCommunityMediaAccess,
    readCommunityMediaContent,
    async expireInitiated() {
      const timestamp = at();
      let expired = 0;
      for (const record of records.values()) {
        if (record.state === 'initiated' && record.expiresAt <= timestamp) {
          await reject(record, 'expired');
          expired += 1;
        }
      }
      return { expired };
    },
    async cleanupOrphans() {
      const timestamp = at();
      let removedObjects = 0;
      let pendingObjects = 0;
      let revokedGrants = 0;
      for (const record of records.values()) {
        if (record.state === 'rejected' || record.state === 'deleted') {
          const outcome = await dropObjects(record);
          removedObjects += outcome.removed;
          pendingObjects += outcome.pending;
          revokedGrants += revokeGrantsForMedia(record.id, timestamp);
        }
      }
      for (const [grantId, grant] of grants) {
        if (grant.expiresAt <= timestamp || grant.revokedAt !== null) grants.delete(grantId);
      }
      return {
        removedObjects,
        revokedGrants,
        pendingObjects,
        remainingObjects: await attemptAsync(() => objectStore.objectCount()),
      };
    },
    async stats() {
      return {
        mediaCount: records.size,
        objectCount: await attemptAsync(() => objectStore.objectCount()),
        grantCount: grants.size,
      };
    },
    serverObjectKeys(mediaId) {
      const record = records.get(mediaId);
      if (record === undefined) return null;
      return { rawRef: record.rawRef, derivativeRef: record.derivativeRef };
    },
  };
  return service;
}

/** 常量再导出：供路由层 schema 与文档核对（避免各处硬编码导致漂移）。 */
export const MEDIA_LIMITS = Object.freeze({
  communityMaxImagesPerPost: COMMUNITY_MAX_IMAGES_PER_POST,
  maxBytes: MEDIA_MAX_BYTES,
  maxDurationMs: MEDIA_MAX_DURATION_MS,
  accessTtlMs: MEDIA_ACCESS_TTL_MS,
  initiatedTtlMs: MEDIA_INITIATED_TTL_MS,
});

/** 供路由层做路径参数格式判定（不合规 ⇒ HTTP 层 400）。 */
export function isMediaIdLike(value: string): boolean {
  return isUuidLike(value);
}
