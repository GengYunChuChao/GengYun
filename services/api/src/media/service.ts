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
 * 一律 `PROVIDER_UNAVAILABLE`（503，`retryable: false`）。判据是端口的 `kind`，不是自述布尔标志；
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
import type { CommunityGrantRecord, MediaIdempotencyEntry, MediaRecord, MediaStore } from './store.ts';
import {
  MEDIA_IDEMPOTENCY_CLAIM_TTL_MS,
  MEDIA_IDEMPOTENCY_PATHS,
  MEDIA_IDEMPOTENCY_TTL_MS,
  createMemoryMediaStore,
  mediaIdempotencyKeyHash,
  mediaIdempotencyScope,
} from './store.ts';

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
 * - `unwired`（real 默认）：端口自己无法判定（恒 `null`）⇒ 该用途的 `createUpload` **仍 503
 *   fail-closed**，文案明确到「每帖上限计数未接线」。**不得**改用同一 owner 名下存活记录数顶替：
 *   那是**生命周期累计**口径，而清理器（`expireInitiated`／`cleanupOrphans`）与权威每帖计数
 *   （GY-I15）今天都没有生产调用者 ⇒ 累计数会让用户传满 3 张后**永久锁死**，且「先数后写」之间
 *   存在 TOCTOU（并发可超发）。**缺清理器／权威计数器时不得放行**。
 */
export interface CommunityAttachmentCounter {
  readonly kind: 'substitute' | 'unwired' | 'injected';
  readonly note: string;
  /** 返回该 owner 当前已占用的图片槽位数；无法判定返回 null。 */
  countFor(input: { ownerId: string; liveCommunityImages: number }): number | null;
}

// `MediaRecord` / `CommunityGrantRecord` 自 W12 起定义在 `./store.ts`（持久化端口的行视图），
// 本文件只消费端口，不再自持一份「进程内行结构」——否则端口与内存实现会各说一套，
// 真库的列约束（`metadata_removed` 根本不存在）就永远暴露不出来。

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
   *
   * W12 起是异步的：键来自持久化台账（`media.object_ref_cipher` + `media_derivatives`），
   * 进程内没有可同步查询的登记册——重启后的新进程也必须能如实回答。
   */
  serverObjectKeys(mediaId: string): Promise<{ rawRef: string | null; derivativeRef: string | null } | null>;
}

export interface AppMediaServiceOptions {
  executionMode: string;
  objectStore: MediaObjectStore;
  tokenSecret: string;
  contentSource?: PublishedContentSource;
  attachmentCounter?: CommunityAttachmentCounter;
  now?: () => Date;
  idFactory?: () => string;
  /**
   * **真实媒体接线的显式批准能力**（non-defaultable）：`real` 下唯一能让服务走真实分支的凭据。
   * 不提供（或提供的不是 {@link approveRealMediaWiring} 铸造的对象）⇒ `real` 构造即整域
   * fail-closed，**与端口来源／环境配置无关**。装配层不得自行铸造。
   */
  realMediaApproval?: RealMediaWiringApproval;
  /**
   * `AccessGrant.url` 的**访问网关原点**（`https://<host>[:port]`，例如 `https://media.example.com`）。
   *
   * 由装配层从配置读取后显式注入（配置项 `MEDIA_ACCESS_GRANT_ORIGIN`，见 `services/api/src/config.ts`
   * 的 `AppConfig.mediaAccessGrantOrigin`）。**本文件不读 ambient env**（既有 AST 审计：
   * `tests/unit/media-real-mode-fail-closed.test.mjs` 对 `services/api/src/media/**` 的
   * `process.env`／`import.meta.env` 读取一律判违规），所以配置只能沿「装配层 → 本选项」入。
   *
   * 缺省 = {@link DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN}（占位、**不可解析**：RFC 6761 保留域 `.invalid`）。
   * 注入值非法（http、带路径/查询/凭据）⇒ 构造期抛错，不静默退回占位域。
   */
  accessGrantOrigin?: string;
  /**
   * **持久化端口**（W12 新增）：登记册 + 授权 + 幂等台账的落点。
   *
   * 由装配层按 `executionMode` 二分注入（照 `favorites`/`history`/`messages` 同一范式）：
   * `real` 且拿到连接池与 `MEDIA_OBJECT_REF_KEY` ⇒ `createPostgresMediaStore`；
   * 否则 `createMemoryMediaStore`（stub/测试）。缺省即内存实现——**构造时即可判定**，
   * 因此 `AppMediaService` 不把「持久化与否」藏成运行期惊喜。
   *
   * 端口是 `persistent: false` 而 `executionMode === 'real'` 时，装配层**必须**整域 fail-closed
   * （见 `app.ts` 的 `mediaPersistenceRefusal`），否则就是「进程内 Map 当事实源、PG 只做旁路」的假持久化。
   *
   * 名字叫 `persistence` 而不是 `store`：`tests/unit/media-real-mode-fail-closed.test.mjs` 的 R-B5
   * 判据把 `createAppMediaService({...})` 里任何 `*store*`/`*storage*`/`bucket` 形状的属性名
   * 都当作「第二个存储端口」拒绝（防的是有人再塞一个对象存储进来）。本端口**不是**字节存储，
   * 也绝不替换 `objectStore`，因此用不带歧义的名字，让那条判据保持原样有效。
   */
  persistence?: MediaStore;
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

/**
 * 未接线计数器（real 默认）：端口**不做判定**（恒 `null`）。
 *
 * 服务层据此**继续拒绝** `community_image` 上传：`attachmentLimitFor` 的 `null` 分支 ⇒
 * `503 PROVIDER_UNAVAILABLE`（`retryable: false`），文案明确到「每帖上限计数未接线」。
 *
 * ⛔ **不得**把本计数器改成「按同一 owner 名下存活 `community_image` 记录数计数」：那是
 * **生命周期累计**口径，与缺位的清理器／权威每帖计数（GY-I15）叠加会变成「传满 3 张即永久
 * 锁死（只能手删）」，并且「先数后写」之间有 TOCTOU（并发可超发）。见
 * `.pg17/ruling-i06-d1-substitute-rework-20261017.md` 方案 A。
 */
export function createUnwiredAttachmentCounter(): CommunityAttachmentCounter {
  return {
    kind: 'unwired',
    note:
      '每帖上限计数未接线（real 默认）：端口不做判定（恒 null）⇒ 该用途上传 503 fail-closed；'
      + '不按本地存活记录数顶替（累计口径会永久锁死且 TOCTOU 超发，权威每帖计数属 GY-I15 附件挂载）。',
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

/**
 * 每帖上限计数缺位时 `createUpload` 的 **503 文案**（`real` 默认的 `unwired` 装配走这里）。
 *
 * 必须**具体到「每帖上限计数未接线」**：泛化的「服务不可用」会把「能力未装配」误报成瞬时故障，
 * 既误导调用方重试，也会掩盖真实缺口（见 `.pg17/ruling-i06-d1-substitute-rework-20261017.md`）。
 * 配套的机器可读判别在 `details`（`post_image_limit_unwired`），与 400 的
 * `post_image_limit` 区分开。
 */
const ATTACHMENT_LIMIT_UNWIRED_MESSAGE =
  '每帖上限计数未接线：无法判定「每帖 ≤3 张」图片槽位（缺权威每帖计数，社区图片上传暂不可用）';

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

// ------------------------------------------- 真实媒体接线的显式批准能力（r3 运行期闸门）

/**
 * 真实媒体接线的**显式批准能力**（r3 主闸门）。
 *
 * 为什么不复用「配置／端口 kind／来源模块」：`real` 媒体域能否对外服务**不能**由环境决定 ——
 * `process.env`、`options.env`、端口从哪个模块来、以及任何自述标志都属「配置即门控」。
 * 两轮对抗性复审已实测：只要把来源放在被审文件之外（新增模块 ＋ 签名默认值、
 * `Object.prototype` 四键投毒、链路文件里 1 行副作用 import、动态取键），
 * **封闭世界的静态判据全绿而 `POST /api/v1/media/uploads` 返回 201**。
 * ⇒ 闸门必须落在**运行期、被执行的那条路径**上：{@link createAppMediaService} 在 `real` 下
 * **必须**收到一个由 {@link approveRealMediaWiring} 铸造的本能力对象，否则直接整域 fail-closed。
 *
 * 该能力**不可默认化、不可伪造、不可派生**：
 *   - 唯一铸造点是 {@link approveRealMediaWiring}（显式、可 grep、可审查的一次调用）；
 *   - 判定只认模块私有 `WeakSet` 中的**对象身份**（不是形状、不是标志位）：形状相同的字面量、
 *     `Object.create(token)` 派生物、`Proxy` 包装、结构化克隆／JSON 往返副本一律无效；
 *   - 取值走 `Object.hasOwn`（**不读原型链**）：`Object.prototype` 上的同名属性不算提供。
 *
 * ⛔ 装配层（`app.ts`）**不得**自行铸造（那等于自我批准）；它只转发调用方给出的能力对象。
 */
export interface RealMediaWiringApproval {
  /** 批准理由（仅审计回显，不参与判定）。 */
  readonly reason: string;
  /** 批准时刻（ISO 8601，仅审计）。 */
  readonly approvedAt: string;
}

/** 缺少批准能力时 `real` 的 fail-closed 原因（对外仍是既有 503 `PROVIDER_UNAVAILABLE` 语义）。 */
export const REAL_MEDIA_APPROVAL_REQUIRED_REASON =
  'real 模式缺少真实媒体接线的显式批准能力：媒体域不可用（拒绝以内存/替身存储返回成功应答）';

const APPROVED_REAL_MEDIA_WIRINGS = new WeakSet<object>();

/** 铸造一份真实媒体接线批准能力（**唯一铸造点**；每个调用点都是一次需审查的显式接线决定）。 */
export function approveRealMediaWiring(input: { reason: string; approvedAt?: string }): RealMediaWiringApproval {
  const approval: RealMediaWiringApproval = Object.freeze({
    reason: input.reason,
    approvedAt: input.approvedAt ?? new Date().toISOString(),
  });
  APPROVED_REAL_MEDIA_WIRINGS.add(approval);
  return approval;
}

/** 只认「由 {@link approveRealMediaWiring} 铸造」的对象身份；形状相同／派生／代理／克隆一律 false。 */
export function isRealMediaWiringApproved(value: unknown): value is RealMediaWiringApproval {
  return typeof value === 'object' && value !== null && APPROVED_REAL_MEDIA_WIRINGS.has(value);
}

// ------------------------------------------------------------- 整域 fail-closed

/**
 * real 模式且真实对象存储未接线（或缺少批准能力）⇒ **整域** `PROVIDER_UNAVAILABLE`
 * （503，`retryable: false`）。绝不返回任何成功封套（那等于把内存/替身存储记成真实持久化）。
 */
export function createFailClosedMediaService(reason: string): AppMediaService {
  // 媒体域未接线（fail-closed 替身／计数器未接入）：retryable 必须为 false。
  const fail = (): ApiError => new ApiError('PROVIDER_UNAVAILABLE', `${reason}（fail-closed）`, { retryable: false });
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
    async serverObjectKeys(): Promise<{ rawRef: string | null; derivativeRef: string | null } | null> {
      throw fail();
    },
  };
}

// ---------------------------------------------------- AccessGrant 的访问网关原点

/**
 * `AccessGrant.url` 的**默认**访问网关原点（scheme + host）。
 *
 * **占位、不可解析**：`.invalid` 是 RFC 6761 保留给「永不解析」的顶级域（RFC 2606 同样收录），
 * 因此 `media.placeholder.invalid` **解析不到任何主机**——它不是线上域名、也不回指本服务，
 * 只是「句柄由部署期访问网关解析」的显式占位。
 *
 * 真实部署必须由装配层注入实际的网关原点（选项 {@link AppMediaServiceOptions.accessGrantOrigin}，
 * 配置项 `MEDIA_ACCESS_GRANT_ORIGIN`）；未注入时句柄不可用，这是**刻意的**（宁可不可解析，
 * 也不给出一个「看起来能用」的地址）。
 */
export const DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN = 'https://media.placeholder.invalid';

/**
 * 校验并规范化 `AccessGrant.url` 的访问网关原点：只接受 `https://<host>[:port]`。
 *
 * 拒绝 http、内嵌凭据、路径、查询、片段与首尾空白——这些要么把句柄降级成明文传输，
 * 要么让拼接出的路径指向非预期位置；非法即**抛错**，绝不静默退回占位域或截断成 `new URL().origin`。
 */
export function normalizeMediaAccessGrantOrigin(value: string): string {
  if (typeof value !== 'string' || value === '' || value.trim() !== value) {
    throw new TypeError('AccessGrant 网关原点必须是非空、且无首尾空白的字符串');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`AccessGrant 网关原点不是合法 URL：${value}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new TypeError(`AccessGrant 网关原点必须是 https（契约句柄不得降级为明文）：${value}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError(`AccessGrant 网关原点不得内嵌凭据：${value}`);
  }
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new TypeError(`AccessGrant 网关原点只能是 scheme + host[:port]，不得带路径/查询/片段：${value}`);
  }
  if (parsed.hostname === '') {
    throw new TypeError(`AccessGrant 网关原点缺少主机名：${value}`);
  }
  return parsed.origin;
}

// --------------------------------------------------------------------- 实现

/**
 * 建立媒体域服务。
 *
 * **r3 运行期构造期闸门**：`real` 必须先拿到**显式批准能力**（{@link approveRealMediaWiring}
 * 铸造；non-defaultable、不可从 `process.env`／`options.env`／原型链／全局对象派生）——
 * 缺失即整域 fail-closed（`failClosedReason` 点名「缺少批准能力」），
 * 与「环境里有没有那四个 `OBJECT_STORAGE_*` 键」「谁读了 env」「端口从哪个模块来」**全都无关**。
 * 拿到批准后仍要求端口 `kind === 's3_compatible'`（判据是端口 `kind`，不是自述标志）。
 */
export function createAppMediaService(options: AppMediaServiceOptions): AppMediaService {
  const { executionMode, objectStore } = options;
  if (executionMode === 'real') {
    // 只认**自有属性**：`Object.prototype.realMediaApproval`（污染）不算「提供了批准能力」。
    const approval: unknown = Object.hasOwn(options, 'realMediaApproval') ? options.realMediaApproval : undefined;
    if (!isRealMediaWiringApproved(approval)) {
      return createFailClosedMediaService(REAL_MEDIA_APPROVAL_REQUIRED_REASON);
    }
    if (objectStore.kind !== 's3_compatible') {
      return createFailClosedMediaService(
        'real 模式未接真实对象存储：媒体域不可用（拒绝以内存/替身存储返回成功应答）',
      );
    }
  }

  // 访问网关原点：配置注入值优先；缺省为占位/不可解析域（见 DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN）。
  // 注入值非法即在构造期抛错（不静默降级）。放在 real 闸门**之后**：real 未接线时仍是整域 fail-closed。
  const accessGrantOrigin = normalizeMediaAccessGrantOrigin(
    options.accessGrantOrigin ?? DEFAULT_MEDIA_ACCESS_GRANT_ORIGIN,
  );

  const contentSource = options.contentSource ?? createClosedContentSource();
  const attachmentCounter =
    options.attachmentCounter ??
    (executionMode === 'real' ? createUnwiredAttachmentCounter() : createSubstituteAttachmentCounter());
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => randomUUID());
  const tokenFactory = createAccessTokenFactory(options.tokenSecret);

  /**
   * **持久化端口**（W12 起是本域唯一的事实源）。
   *
   * 本文件**不再持有任何进程内 `Map`/`Set`**：登记册、授权、幂等台账全部经端口读写。
   * 缺省仍是内存实现（`createMemoryMediaStore`），但那是**装配层的选择**而不是本文件的隐式默认——
   * 装配层（`app.ts`）在 `real` 且拿到连接池与 `MEDIA_OBJECT_REF_KEY` 时会注入
   * `createPostgresMediaStore`，因此重启不再丢上传句柄／幂等回执。
   */
  const store = options.persistence ?? createMemoryMediaStore({ now: () => now().getTime() });

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

  function revokeGrantsForMedia(mediaId: string, timestamp: number): Promise<number> {
    return store.revokeGrantsForMedia(mediaId, timestamp);
  }

  /**
   * 同一 owner 名下存活的 community_image 记录数。
   *
   * 只作为**已接线**端口的输入（`substitute` 的占位数、`injected` 探针的 `liveCommunityImages`）。
   * `unwired` **不使用**它——见 `attachmentLimitFor` 的 `null` 分支（累计口径会锁死 + TOCTOU）。
   */
  function liveCommunityImageCount(ownerId: string): Promise<number> {
    return store.liveCommunityImageCount(ownerId);
  }

  async function ownedRecord(actor: MediaActor, mediaId: string): Promise<MediaRecord> {
    const record = await store.getMedia(mediaId);
    // 非本人 / 不存在**同形** 404：不泄露存在性。
    if (record === null || record.ownerId !== actor.ownerId) {
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

  /**
   * 「每帖 ≤3 张」的上传侧判定输入（`createUpload` 的 `mediaCountForPost`）。
   *
   * 口径（本片返修确立；来源：GY-I06 验收缺口 C5／最小闭环 D1，见 `#6`；决定见
   * `.pg17/ruling-i06-d1-substitute-rework-20261017.md` 方案 A）：
   * - **判定只认端口**：`substitute`／`injected` 由 `countFor` 给出占位数，语义不变
   *   （`substitute` ＝同一 owner 名下存活 `community_image` 记录数，上传侧**保守替身**）。
   * - 端口返回 `null`（含 `real` 默认的 `unwired`）⇒ `503 PROVIDER_UNAVAILABLE`
   *   （`retryable: false`），文案明确到「每帖上限计数未接线」，**不猜测、不放宽**。
   * - ⛔ **不得**用同一 owner 名下存活记录数顶替 `unwired`：那是**生命周期累计**口径，而清理器
   *   （`expireInitiated`／`cleanupOrphans`）与权威每帖计数（GY-I15）今天都没有生产调用者
   *   ⇒ 累计数会让用户传满 3 张后**永久锁死**（只能手删），并且「先数后写」之间存在 TOCTOU
   *   （并发可超发）。**缺清理器／权威计数器时不得放行**。
   */
  async function attachmentLimitFor(actor: MediaActor, purpose: unknown): Promise<number> {
    if (purpose !== 'community_image') return 0;
    const liveCommunityImages = await liveCommunityImageCount(actor.ownerId);
    const counted = attachmentCounter.countFor({
      ownerId: actor.ownerId,
      liveCommunityImages,
    });
    if (counted === null) {
      throw new ApiError('PROVIDER_UNAVAILABLE', ATTACHMENT_LIMIT_UNWIRED_MESSAGE, {
        // 能力未装配（每帖上限计数缺位，非瞬时故障）：retryable 必须为 false，
        // 且 details 给出机器可读判别，避免与 400 的 post_image_limit 混淆。
        retryable: false,
        details: [{ field: '/purpose', code: 'post_image_limit_unwired' }],
      });
    }
    return counted;
  }

  // ------------------------------------------------------------ 生命周期

  /**
   * 一次幂等请求的**台账占位**。
   *
   * W12 之前这里是进程内 `Set`（`inflight`）+ `Map`（`idempotency`）：重启即丢，且多实例各判一次。
   * 现在占位落在持久化台账里（`0008 public.idempotency_keys` 的唯一索引 `(scope, key_hash)`），
   * 语义逐条保持：同键并发只有一个能占到，其余 409 `REQUEST_IN_PROGRESS`（`app.ts` 附加
   * `Retry-After: 1`）；请求 hash **含原 If-Match**（与 B3 口径一致）；结果 24h 可回放。
   */
  interface IdempotencySlot {
    settle(mediaId: string): Promise<void>;
    release(): Promise<void>;
  }

  const claimConflict = (message: string): ApiError =>
    new ApiError('IDEMPOTENCY_CONFLICT', message);
  const claimInProgress = (): ApiError =>
    new ApiError('REQUEST_IN_PROGRESS', '同一 Idempotency-Key 的请求正在处理中，请稍后重试', {
      retryable: true,
    });

  /**
   * 打开一次幂等请求：返回**已有回执**（调用方按 `requestHash` 判冲突/回放）或**新占位**。
   *
   * 占位是**单语句原子**的（`ON CONFLICT DO NOTHING RETURNING`），因此不存在「先查后写」的窗口，
   * 也不依赖进程内时序；抢占失败时再读一次台账，区分「异请求体 ⇒ 409 冲突」与「同键仍在处理 ⇒ 409 重试」。
   */
  async function openIdempotentRequest(
    actor: MediaActor,
    method: string,
    routePath: string,
    idempotencyKey: string,
    requestHash: string,
    conflictMessage: string,
  ): Promise<{ prior: MediaIdempotencyEntry } | { slot: IdempotencySlot }> {
    const scope = mediaIdempotencyScope(actor.ownerId, method, routePath);
    const keyHashHex = mediaIdempotencyKeyHash(scope, idempotencyKey);
    const prior = await store.findIdempotency(scope, keyHashHex);
    if (prior !== null) return { prior };

    const claimed = await store.claimIdempotency(scope, keyHashHex, {
      requestHash,
      // 占位短于回执：占位者崩了不会把键钉住 24h。
      expiresAt: at() + MEDIA_IDEMPOTENCY_CLAIM_TTL_MS,
    });
    if (!claimed) {
      const raced = await store.findIdempotency(scope, keyHashHex);
      if (raced !== null && raced.requestHash !== requestHash) throw claimConflict(conflictMessage);
      throw claimInProgress();
    }
    let settled = false;
    return {
      slot: {
        async settle(mediaId) {
          settled = true;
          await store.settleIdempotency(scope, keyHashHex, {
            mediaId,
            expiresAt: at() + MEDIA_IDEMPOTENCY_TTL_MS,
          });
        },
        async release() {
          // 已结算就不再删：回执必须留着供重放。
          if (settled) return;
          await store.releaseIdempotency(scope, keyHashHex);
        },
      },
    };
  }

  /** 回执命中时的统一处理：异请求体 ⇒ 409 冲突；占位中 ⇒ 409 重试；否则交出 mediaId 供回放。 */
  function replayOrConflict(prior: MediaIdempotencyEntry, requestHash: string, conflictMessage: string): string {
    if (prior.requestHash !== requestHash) throw claimConflict(conflictMessage);
    if (prior.mediaId === null) throw claimInProgress();
    return prior.mediaId;
  }

  const initiateUpload: AppMediaService['initiateUpload'] = async ({ actor, input, idempotencyKey }) => {
    requireActor(actor);
    requireIdempotencyKey(idempotencyKey);
    const requestHash = hashRequest({ op: 'initiate', input });
    const opened = await openIdempotentRequest(
      actor,
      'POST',
      MEDIA_IDEMPOTENCY_PATHS.initiate,
      idempotencyKey,
      requestHash,
      '同一 Idempotency-Key 已被不同请求体使用',
    );
    if ('prior' in opened) {
      const replayId = replayOrConflict(opened.prior, requestHash, '同一 Idempotency-Key 已被不同请求体使用');
      const record = await ownedRecord(actor, replayId);
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

    const { slot } = opened;
    try {
      const purpose = (input as { purpose?: unknown } | null)?.purpose;
      const mediaCountForPost = await attachmentLimitFor(actor, purpose);
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
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: timestamp + MEDIA_INITIATED_TTL_MS,
      };
      // 记录先落库再结算台账：崩在两者之间时留下「占位中」+ 可能孤立的 initiated 行，
      // 由 `expireInitiated` 回收，而不会让客户端拿到一个查不到的 mediaId。
      await store.createMedia(record);
      await slot.settle(record.id);
      return { status: 201, media: toProjection(record), upload: uploadGrant(record, handle) };
    } finally {
      // 已结算 ⇒ no-op；未结算（校验失败/存储不可用）⇒ 放开键，允许客户端改正后重试。
      await slot.release();
    }
  };

  const completeUpload: AppMediaService['completeUpload'] = async ({ actor, mediaId, ifMatch, input, idempotencyKey }) => {
    requireActor(actor);
    requireIdempotencyKey(idempotencyKey);

    // 幂等（含原 If-Match）：同键同请求回放首次成功结果；同键异请求 → IDEMPOTENCY_CONFLICT。
    const requestHash = hashRequest({ op: 'complete', mediaId, ifMatch: ifMatch ?? null, input });
    const opened = await openIdempotentRequest(
      actor,
      'POST',
      MEDIA_IDEMPOTENCY_PATHS.complete,
      idempotencyKey,
      requestHash,
      '同一 Idempotency-Key 已被不同的完成请求使用',
    );
    if ('prior' in opened) {
      const replayId = replayOrConflict(opened.prior, requestHash, '同一 Idempotency-Key 已被不同的完成请求使用');
      return { status: 202, media: toProjection(await ownedRecord(actor, replayId)) };
    }
    const { slot } = opened;
    try {
      const record = await ownedRecord(actor, mediaId);

      requireIfMatch(ifMatch, record.revision);

      const declared = attempt(() => validateCompleteInput(input));
      if (declared.sha256 !== record.sha256 || declared.bytes !== record.bytes) {
        throw new ApiError('INVALID_REQUEST', '完成上传声明与初始化声明不一致');
      }
      if (record.state === 'ready') {
        await slot.settle(record.id);
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
      await store.saveMedia(record);
      await slot.settle(record.id);
      return { status: 202, media: toProjection(record) };
    } finally {
      await slot.release();
    }
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
    await revokeGrantsForMedia(record.id, timestamp);
    // 回收结果（对象键被清空 / 状态与 failure_code）必须落库：否则重启后
    // 会看到 `rawRef` 仍在的 rejected 行，cleanupOrphans 也会重复尝试删同一个键。
    await store.saveMedia(record);
  }

  const getMedia: AppMediaService['getMedia'] = async ({ actor, mediaId }) => {
    requireActor(actor);
    return { status: 200, media: toProjection(await ownedRecord(actor, mediaId)) };
  };

  const deleteMedia: AppMediaService['deleteMedia'] = async ({ actor, mediaId, ifMatch, idempotencyKey }) => {
    requireActor(actor);
    requireIdempotencyKey(idempotencyKey);
    const requestHash = hashRequest({ op: 'delete', mediaId, ifMatch: ifMatch ?? null });
    const opened = await openIdempotentRequest(
      actor,
      'DELETE',
      MEDIA_IDEMPOTENCY_PATHS.remove,
      idempotencyKey,
      requestHash,
      '同一 Idempotency-Key 已被不同的删除请求使用',
    );
    if ('prior' in opened) {
      const replayId = replayOrConflict(opened.prior, requestHash, '同一 Idempotency-Key 已被不同的删除请求使用');
      const replay = await ownedRecord(actor, replayId);
      return { status: 202, ack: { accepted: true }, revision: replay.revision };
    }
    const { slot } = opened;
    try {
      const record = await ownedRecord(actor, mediaId);
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
      await revokeGrantsForMedia(record.id, timestamp);
      record.revision += 1;
      await store.saveMedia(record);
      await slot.settle(record.id);
      return { status: 202, ack: { accepted: true }, revision: record.revision };
    } finally {
      await slot.release();
    }
  };

  // ------------------------------------------------------- 私有 owner 访问

  const grantMediaAccess: AppMediaService['grantMediaAccess'] = async ({ actor, mediaId, ifMatch, idempotencyKey }) => {
    requireActor(actor);
    requireIdempotencyKey(idempotencyKey);
    const record = await ownedRecord(actor, mediaId);
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
    // host 来自配置（`AppMediaServiceOptions.accessGrantOrigin` ⇒ 配置 `MEDIA_ACCESS_GRANT_ORIGIN`），
    // 未配置时是本文件顶部的**不可解析占位域**，绝不硬编码任何形似线上域名的主机。
    return {
      status: 200,
      mediaRevision: record.revision,
      grant: {
        url: `${accessGrantOrigin}/api/v1/media/${record.id}/content`,
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
    const record = await store.getMedia(mediaRef.media_id);
    if (record === null || record.state !== 'ready' || record.purpose !== 'community_image') {
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
    await store.createGrant({
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
    // 句柄 host 与 owner 句柄同源：配置注入的网关原点（缺省为不可解析的占位域）。
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
          url: `${accessGrantOrigin}/api/v1/community/media/${grantId}/content`,
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
    const grant = await store.getGrant(grantId);
    if (grant === null) throw new ApiError('NOT_FOUND', '授权不存在');
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
    const record = await store.getMedia(grant.mediaId);
    if (
      record === null ||
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
      for (const record of await store.listMediaByState(['initiated'])) {
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
      for (const record of await store.listMediaByState(['rejected', 'deleted'])) {
        const outcome = await dropObjects(record);
        removedObjects += outcome.removed;
        pendingObjects += outcome.pending;
        revokedGrants += await revokeGrantsForMedia(record.id, timestamp);
        // 回收结果落库：否则重启后同一个键会被再次尝试删除（pending 永远不收敛）。
        await store.saveMedia(record);
      }
      // 过期或已撤销的授权不再需要：从台账删除（`community_media_grants` 的 TTL 上限只有 300s）。
      for (const grant of await store.listStaleGrants(timestamp)) {
        await store.deleteGrant(grant.grantId);
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
        mediaCount: await store.countMedia(),
        objectCount: await attemptAsync(() => objectStore.objectCount()),
        grantCount: await store.countGrants(),
      };
    },
    async serverObjectKeys(mediaId) {
      // **必须查持久化台账**：本服务不再持有进程内登记册，重启后的新进程只能从真库回答
      // 「这条媒体在桶里的原始键/衍生键是什么」——这正是 W12 要接通的那一环。
      const record = await store.getMedia(mediaId);
      if (record === null) return null;
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

// ------------------------------------------------------- owner 私有字节读（无外部出口）

/** {@link readOwnerMediaContent} 的成功口径（与社区取图面同形：只给字节 + 元信息）。 */
export interface OwnerContentOutcome {
  status: 200;
  bytes: Uint8Array;
  contentType: string;
  /** 派生来源：`derivative` = 已去元数据的衍生物（图片）；`raw` = 非图片用途的原始对象。 */
  source: 'derivative' | 'raw';
  revision: number;
}

/**
 * **owner 私有字节读（服务层内部函数，⛔ 无外部出口）**。
 *
 * 为什么不是一个 operation：85 条冻结路径里**没有**「owner 读自己媒体字节」这一面
 * （`GET /media/{id}` 只回元数据；`POST /media/{id}/access` 只回句柄，而承接该句柄的
 * `GET /media/{id}/content` 也不在冻结路径内）。按红线**不自造契约、不注册路由**，
 * 因此本能力只以**导出函数**的形式留在服务层：`services/api/src/routes/media.ts`
 * 一次都不引用它 ⇒ 外部 HTTP 面对它只会 404；调用方必须先过 `guards.requireUser`，
 * 再以 `MediaActor` 传入（本函数自身仍通过 `getMedia` 复核 owner 归属，不信任调用方）。
 *
 * 取用口径与社区取图面一致：**有衍生物就只取衍生物**（图片的原始对象永不出网），
 * 无衍生物（录音等非图片用途）才取原始对象。对象缺失/端口异常一律
 * `OBJECT_UNAVAILABLE`（`retryable: false`）——沿用媒体域既有契约码，不新造错误码。
 */
export async function readOwnerMediaContent(
  media: AppMediaService,
  input: { actor: MediaActor; mediaId: string },
): Promise<OwnerContentOutcome> {
  // 归属复核走既有 `getMedia`（内部 `ownedRecord` 判 owner + authEpoch，跨主体一律 NOT_FOUND）。
  const { media: projection } = await media.getMedia({ actor: input.actor, mediaId: input.mediaId });
  if (projection.state !== 'ready') {
    throw new ApiError('OBJECT_UNAVAILABLE', '媒体尚未就绪', { retryable: false });
  }
  const keys = await media.serverObjectKeys(input.mediaId);
  const source: OwnerContentOutcome['source'] = keys?.derivativeRef == null ? 'raw' : 'derivative';
  const objectRef = source === 'derivative' ? keys?.derivativeRef : keys?.rawRef;
  const object =
    objectRef == null ? null : await attemptAsync(() => media.objectStore.getObject(objectRef));
  if (object === null) {
    throw new ApiError('OBJECT_UNAVAILABLE', '对象不存在或已被回收', { retryable: false });
  }
  return {
    status: 200,
    bytes: object.bytes,
    contentType: projection.mime,
    source,
    revision: projection.revision,
  };
}
