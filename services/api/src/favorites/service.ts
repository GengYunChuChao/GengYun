/**
 * GY-I16（#16）· 收藏子域服务层；HTTP 装配在 `routes/favorites.ts`，领域层不注册路由。
 *
 * 覆盖契约 operationId：`listFavorites`（`GET /favorites`）、`createFavorite`（`POST /favorites`）、
 * `deleteFavorite`（`DELETE /favorites/{id}`）。本片**没有**内部创建口（收藏只由用户自己发起）。
 *
 * ## 核心不变式
 *
 * 1. **归属**：读取/取消只看得到本人的收藏。他人收藏与"不存在"**同形**：同一个 `notFound()`
 *    ⇒ 同 code／status／message／空 details ⇒ 同一份 `buildErrorEnvelope` 逐字节相同
 *    （不泄露存在性；非本人永远拿不到 409）。
 * 2. **去重（不产生第二行）**：同一个用户对同一 `(type, id)` 目标**永远只有一行**。
 *    重复 `POST`（含换新 `Idempotency-Key`）返回**既有那一行**，不新建、不改 `created_at`。
 *    去重在存储层由 `(owner_id, target_type, target_id)` 唯一索引保证，并发同目标也只有一行。
 * 3. **取消是物理删除**：取消后该行消失；再次收藏得到**新 id**，旧行不复活。
 * 4. **可见性逐次重查、收藏不授予可见性**：`reference_state`／`unavailable_reason` 每次读取
 *    按目标**当前**对该用户的可见性派生（`targetref/visibility.ts`），**不入库、不缓存**。
 *    隐藏／失效／删除／注销之后，旧收藏**不会**因为"曾经收藏过"而重新公开或恢复资格：
 *    `favoriteEligibleForRecommendation()` 只看**本次派生**的 `reference_state`，
 *    与 `created_at` 新旧、与是否收藏过**无关**。
 * 5. **收藏 ≠ 已使用**：`Favorite` 投影**恰为契约的 6 个字段**
 *    （`FAVORITE_PROJECTION_FIELDS`），其中**没有**任何"已用/使用次数/最近使用"字段；
 *    本服务**不持有**历史、识别、用量或任务端口 ⇒ 从结构上不可能把收藏写成"已使用事实"
 *    （测试断言字段集恰等 + 收藏后历史列表不变）。
 * 6. **出口不可变**：所有返回给调用方的对象都是从存储**深拷贝**出来的自有数据。
 *
 * ## 未取得（如实声明，不得当作已完成）
 *
 * - 存储按装配走：`real` 且已接库（`pool !== null`）走 PG（迁移 `0018_favorites_history.sql`、实现 `store-pg.ts`，装配 `app.ts:1865-1869`）；其余走内存（进程重启即丢）。`real` 但 store 不持久 ⇒ 服务为 `null`、该域路由一律 503（判据 `app.ts:1954-1956`）——「无库即不可用」这条限制仍然成立。
 * - 引用可用性端口**已于 #167 接线**（`createWiredVisibilityPort`；装配点 `app.ts` 的
 *   `defaultVisibility`；可用性按 `/knowledge` 公开读面**每次读取重新派生**）⇒ 无库装配
 *   （`pool === null`）或核不到时仍如实 `unavailable`，绝不假装可用。
 *   本片**不宣称**收藏已端到端可用；测试仍可注入自己的 `VisibilityPort` 覆盖缺省。
 * - 契约里 `Favorite.unavailable_reason` 是 `string(1..80)|null`，本片只取**冻结闭集**
 *   （`REFERENCE_UNAVAILABLE_REASONS`）内的三条非披露说明，不细分为"已隐藏/不存在"。
 */
import { createHmac, randomUUID } from 'node:crypto';
import { idempotencyKeyHashHex, idempotencyRequestHash, idempotencyScope } from '../auth/idempotency.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import type { ReferenceState, TargetRef } from '../targetref/types.ts';
import { cloneDeep } from '../targetref/immutable.ts';
import { deriveVisibility, type VisibilityPort } from '../targetref/visibility.ts';
import type { FavoriteRecord, FavoritesStore, IdempotencyOutcome, InsertResult } from './store.ts';
import { compareFavoritesDescending } from './store.ts';
import type { Favorite, FavoriteInput, FavoritePage } from './types.ts';
import {
  parseListFavoritesQuery,
  requireIdempotencyKey,
  requireIfMatch,
  requireUserActor,
  requireUuidParam,
  validateFavoriteInput,
} from './validate.ts';

/** 游标有效期（与知识/社区/消息/后台读口径一致：只服务翻页，不做长期令牌）。 */
export const CURSOR_TTL_MS = 15 * 60 * 1000;
/** 幂等重放窗口（契约参数描述：只覆盖客户端超时重试）。 */
export const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
/** 同键并发等待上界：超过即 409 REQUEST_IN_PROGRESS。 */
export const IDEMPOTENCY_WAIT_MS = 2000;

/**
 * `Favorite` 响应投影的字段集（**恰好**等于契约 `Favorite.properties` 的键）。
 * 测试据此断言"投影里没有 'used/usage/已使用' 这类事实字段"。
 */
export const FAVORITE_PROJECTION_FIELDS = [
  'id',
  'revision',
  'target_ref',
  'reference_state',
  'unavailable_reason',
  'created_at',
] as const;

/**
 * 契约强 ETag 的唯一构造口径：`ETag: "<revision>"`。
 * 与契约 `parameters.IfMatch.schema.pattern`（`^"[1-9][0-9]*"$`）严格同形。
 */
export function strongEtagOf(revision: number): string {
  return `"${revision}"`;
}

/**
 * **推荐资格的唯一判据**：目标在**本次读取**时对当前用户可用。
 *
 * - 只看 `reference_state`，**不看**收藏时间新旧、不看是否曾经可用；
 * - `unavailable`（下架／失效／隐藏／删除／注销后不可读）⇒ **一律不恢复资格**；
 * - 本函数是纯函数：同样的入参永远同样输出，且不读取任何缓存或本地标记。
 */
export function favoriteEligibleForRecommendation(view: { reference_state: ReferenceState }): boolean {
  return view.reference_state === 'available';
}

export interface FavoritesServiceDeps {
  store: FavoritesStore;
  /**
   * 引用可用性端口。**必填**：不提供默认值 —— 默认一个"未接线"端口会让调用方
   * 忘记接线却看起来一切正常；要求显式传入，接线与否在构造处可见。
   */
  visibility: VisibilityPort;
  /** 签名密钥（游标签名 + 幂等请求摘要 HMAC）；只在内存使用，不落库、不入日志。 */
  signingKey: string;
  now?: () => Date;
  newId?: () => string;
  idempotencyTtlMs?: number;
  idempotencyWaitMs?: number;
}

export interface WriteOptions {
  /** 原始头值（`string | string[] | undefined`）；由本域校验器判形状，调用方不做预转换。 */
  idempotencyKey?: unknown;
  ifMatch?: unknown;
}

/** 契约 `404 NOT_FOUND`：他人收藏与不存在**共用这一个**错误，形状逐字节相同。 */
function notFound(): ApiError {
  return new ApiError('NOT_FOUND', '收藏不存在或不可用');
}

/**
 * CAS 失败的契约映射：
 *   - `NOT_FOUND` / `OWNER_CHANGED` ⇒ 404 `NOT_FOUND`（不泄露存在性：非本人永远拿不到 409）；
 *   - `REVISION_CHANGED` ⇒ 409 `REVISION_CONFLICT`（客户端 `If-Match` 依据的视图已过期）。
 */
function commitRefusal(reason: 'NOT_FOUND' | 'OWNER_CHANGED' | 'REVISION_CHANGED'): ApiError {
  switch (reason) {
    case 'NOT_FOUND':
    case 'OWNER_CHANGED':
      return notFound();
    case 'REVISION_CHANGED':
      return new ApiError('REVISION_CONFLICT', '收藏版本已变化，请刷新后重试');
  }
}

interface CursorPayload {
  v: 1;
  kind: 'favorites';
  /** 调用方主体：防止一个用户复用别人的游标（游标由服务端签名，客户端改不动）。 */
  subject: string;
  auth_epoch: number;
  /**
   * 行身份与创建时刻的摘要（不是可见性摘要）：可见性变化**不**使翻页链失效，
   * 但新增/取消收藏会（翻页位置已不可复现 ⇒ `INVALID_CURSOR`，要求重新读首页）。
   */
  watermark: string;
  route: 'favorites';
  /** 过滤器（契约 `GET /favorites` 没有筛选参数 ⇒ 恒为 `{}`，仍逐字节参与校验）。 */
  filter: Record<string, string>;
  sort: 'created_at_desc';
  after: { created_at: string; id: string };
  expires: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createFavoritesService(deps: FavoritesServiceDeps) {
  const store = deps.store;
  const visibility = deps.visibility;
  const signingKey = deps.signingKey;
  const clock = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const idempotencyTtlMs = deps.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
  const idempotencyWaitMs = deps.idempotencyWaitMs ?? IDEMPOTENCY_WAIT_MS;

  const nowIso = (): string => clock().toISOString();
  const sign = (value: string): string =>
    createHmac('sha256', signingKey).update('favorites-list/v1\n').update(value).digest('base64url');

  // -------------------------------------------------------------------------
  // 幂等：先原子占位 → produce → 写回结果；失败释放占位；同键异体 409
  // -------------------------------------------------------------------------

  async function withIdempotency<T>(
    scope: string,
    keyHash: string,
    requestDigest: string,
    responseStatus: number,
    produce: () => Promise<{ outcome: IdempotencyOutcome; result: T }>,
    replay: (ref: IdempotencyOutcome) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await store.findIdempotency(scope, keyHash);
      if (existing !== null) {
        // 同键异体（含 If-Match 变了 / 请求体变了）⇒ 409，绝不回放另一份请求的结果。
        if (existing.request_hash !== requestDigest) {
          throw new ApiError('IDEMPOTENCY_CONFLICT', '同键请求内容不一致');
        }
        // 重放：按结果引用**重新读取并重新鉴权**（重新派生 reference_state），不回放旧响应。
        return replay(existing.outcome);
      }
      const claimed = await store.claimIdempotency(scope, keyHash, {
        request_hash: requestDigest,
        response_status: responseStatus,
        expires_at: clock().getTime() + idempotencyTtlMs,
      });
      if (!claimed) {
        const settled = await store.awaitIdempotencySettled(scope, keyHash, idempotencyWaitMs);
        if (settled === 'timeout') {
          throw new ApiError('REQUEST_IN_PROGRESS', '同键请求正在处理中，请稍后重试', { retryable: true });
        }
        continue;
      }
      let produced: { outcome: IdempotencyOutcome; result: T };
      try {
        produced = await produce();
      } catch (error) {
        // 失败释放占位：不留"半成品结果"，也不让同键重试被永久挡住。
        await store.releaseIdempotency(scope, keyHash);
        throw error;
      }
      const saved = await store.completeIdempotency(scope, keyHash, {
        response_status: responseStatus,
        outcome: produced.outcome,
      });
      if (saved) return produced.result;
      // 占位被他人完成/释放（理论上不出现）：回到循环按台账重放，不重复落库。
    }
    throw new ApiError('REQUEST_IN_PROGRESS', '同键请求正在处理中，请稍后重试', { retryable: true });
  }

  // -------------------------------------------------------------------------
  // 契约 `Favorite` 投影（可见性逐次派生）
  // -------------------------------------------------------------------------

  /**
   * 契约 `Favorite` 投影。字段顺序与契约一致；`target_ref` 深拷贝；
   * `reference_state`／`unavailable_reason` **逐次重查**（列表／创建响应／幂等重放都会重新派生，
   * 不做缓存），因此"隐藏/失效/注销后用旧链接或缓存重新公开"在服务端不可达。
   */
  async function project(record: FavoriteRecord, userId: string): Promise<Favorite> {
    const verdict = await deriveVisibility(visibility, {
      target_ref: cloneDeep(record.target_ref),
      userId,
    });
    return {
      id: record.id,
      revision: record.revision,
      target_ref: cloneDeep(record.target_ref),
      reference_state: verdict.state,
      unavailable_reason: verdict.state === 'available' ? null : verdict.reason,
      created_at: record.created_at,
    };
  }

  // -------------------------------------------------------------------------
  // 游标（签名 + 绑定主体/路由/过滤/排序；防篡改与跨主体复用）
  // -------------------------------------------------------------------------

  function encodeCursor(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${sign(body)}`;
  }

  function decodeCursor(
    cursor: string | null,
    expected: Omit<CursorPayload, 'after' | 'expires'>,
  ): Pick<CursorPayload, 'after' | 'expires'> | null {
    if (cursor === null) return null;
    try {
      const parts = cursor.split('.');
      if (parts.length !== 2) throw new Error('shape');
      const body = parts[0];
      const signature = parts[1];
      if (typeof body !== 'string' || typeof signature !== 'string' || body.length === 0) throw new Error('shape');
      const decoded = Buffer.from(body, 'base64url');
      if (decoded.toString('base64url') !== body || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new Error('encoding');
      const expectedSignature = Buffer.from(sign(body), 'base64url');
      const received = Buffer.from(signature, 'base64url');
      if (received.toString('base64url') !== signature) throw new Error('encoding');
      if (received.length !== expectedSignature.length || !timingSafeEqualBytes(expectedSignature, received)) {
        throw new Error('signature');
      }
      const value: unknown = JSON.parse(decoded.toString('utf8'));
      const keys = ['v', 'kind', 'subject', 'auth_epoch', 'watermark', 'route', 'filter', 'sort', 'after', 'expires'];
      if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
        throw new Error('fields');
      }
      if (value['v'] !== 1 || value['auth_epoch'] !== expected.auth_epoch || value['watermark'] !== expected.watermark) {
        throw new Error('version');
      }
      if (value['kind'] !== expected.kind || value['route'] !== expected.route) throw new Error('scope');
      if (value['subject'] !== expected.subject) throw new Error('subject');
      if (value['sort'] !== expected.sort) throw new Error('sort');
      if (JSON.stringify(value['filter']) !== JSON.stringify(expected.filter)) throw new Error('filter');
      const expires = value['expires'];
      if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires <= clock().getTime()) {
        throw new Error('expired');
      }
      const after = value['after'];
      if (!isRecord(after) || Object.keys(after).length !== 2 || !Object.hasOwn(after, 'created_at') || !Object.hasOwn(after, 'id')) {
        throw new Error('after');
      }
      if (typeof after['created_at'] !== 'string' || typeof after['id'] !== 'string') throw new Error('after');
      return { after: { created_at: after['created_at'], id: after['id'] }, expires };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('INVALID_CURSOR', '游标无效或已失效');
    }
  }

  return {
    /** `listFavorites`：`GET /favorites`。只列本人收藏；`(created_at DESC, id DESC)` 稳定排序。 */
    async listFavorites(actor: unknown, query: unknown = {}): Promise<FavoritePage> {
      const user = requireUserActor(actor);
      const { cursor, limit } = parseListFavoritesQuery(query);
      const rows = await store.listFavoritesByOwner(user.userId);
      const sorted = [...rows].sort(compareFavoritesDescending);
      const expected: Omit<CursorPayload, 'after' | 'expires'> = {
        v: 1,
        kind: 'favorites',
        subject: user.userId,
        auth_epoch: user.authEpoch,
        watermark: createHmac('sha256', signingKey)
          .update('favorites-watermark/v1\n')
          .update(JSON.stringify(sorted.map((row) => [row.id, row.created_at])))
          .digest('base64url'),
        route: 'favorites',
        filter: {},
        sort: 'created_at_desc',
      };
      const chain = decodeCursor(cursor, expected);
      const after = chain?.after ?? null;
      if (after !== null && !sorted.some((row) => row.id === after.id && row.created_at === after.created_at)) {
        throw new ApiError('INVALID_CURSOR', '游标位置已失效，请重新读取首页');
      }
      const expires = chain?.expires ?? clock().getTime() + CURSOR_TTL_MS;
      // 稳定游标：同 `created_at` 用 `id` 全序兜底 ⇒ 同刻多条不漏不重。
      const remaining =
        after === null
          ? sorted
          : sorted.filter(
              (row) =>
                row.created_at < after.created_at || (row.created_at === after.created_at && row.id < after.id),
            );
      const page = remaining.slice(0, limit);
      const last = page[page.length - 1];
      const next_cursor =
        remaining.length > limit && last !== undefined
          ? encodeCursor({ ...expected, after: { created_at: last.created_at, id: last.id }, expires })
          : null;
      const items: Favorite[] = [];
      for (const row of page) items.push(await project(row, user.userId));
      return { items, next_cursor };
    },

    /**
     * `createFavorite`：`POST /favorites`。
     *
     * - 只接受 `species|herbicide|scheme`（契约 `FavoriteTarget` 闭集）；未知字段 400；
     * - **去重**：同主体同 `(type, id)` 已有收藏 ⇒ 不新建、不改 `created_at`，返回**既有那一行**
     *   （HTTP 201 + `FavoriteEnvelope`，契约只有 201 这一个成功响应）；
     * - **不授予可见性**：即使目标当前不可用也如实建行，但响应里的 `reference_state`
     *   由**本次派生**给出 `unavailable` + 非披露说明 ⇒ 收藏动作本身不产生任何"可公开/可用"事实；
     * - **不产生已使用事实**：本方法不写历史、不写用量、不触碰识别/OCR 端口（无该依赖）。
     */
    async createFavorite(actor: unknown, body: unknown, options: WriteOptions = {}): Promise<Favorite> {
      const user = requireUserActor(actor);
      const input: FavoriteInput = validateFavoriteInput(body);
      const key = requireIdempotencyKey(options.idempotencyKey);
      const scope = idempotencyScope(user.userId, 'POST', `${API_PREFIX}/favorites`);
      const keyHash = idempotencyKeyHashHex(scope, key);
      const digest = idempotencyRequestHash(input, undefined, signingKey);
      return withIdempotency(
        scope,
        keyHash,
        digest,
        201,
        async () => {
          const existing = await store.findByTarget(user.userId, input.target_ref.type, input.target_ref.id);
          if (existing !== null) {
            // 去重命中：返回既有行（不新建、不改 created_at、不推进版本）。
            return {
              outcome: { kind: 'favorite' as const, id: existing.id, revision: existing.revision },
              result: await project(existing, user.userId),
            };
          }
          const record: FavoriteRecord = {
            id: newId(),
            revision: 1,
            owner_id: user.userId,
            target_ref: {
              type: input.target_ref.type,
              id: input.target_ref.id,
              revision: input.target_ref.revision,
            },
            created_at: nowIso(),
          };
          const inserted: InsertResult = await store.insertFavorite(record);
          if (inserted === 'inserted') {
            return {
              outcome: { kind: 'favorite' as const, id: record.id, revision: record.revision },
              result: await project(record, user.userId),
            };
          }
          // 并发同目标：另一次插入先赢，回读既有行（不产生第二条收藏）。
          const raced = await store.findByTarget(user.userId, input.target_ref.type, input.target_ref.id);
          if (raced === null) {
            throw new ApiError('PROVIDER_UNAVAILABLE', '收藏去重索引不一致（内部不变式违反）');
          }
          return {
            outcome: { kind: 'favorite' as const, id: raced.id, revision: raced.revision },
            result: await project(raced, user.userId),
          };
        },
        async (ref) => {
          const record = await store.getFavorite(ref.id);
          // 重放同样重新鉴权、重新派生可见性（不重放旧可见性结论）。
          if (record === null || record.owner_id !== user.userId) throw notFound();
          return project(record, user.userId);
        },
      );
    },

    /**
     * `deleteFavorite`：`DELETE /favorites/{id}`（取消收藏）。
     *
     * - 归属：非本人（含不存在）一律 404 `NOT_FOUND`，同形；
     * - `If-Match`：缺失 428、形状非法 400、**与目标当前 `revision` 不符 409**
     *   （不做 last-write-wins）；
     * - **物理删除**：比较与删除在同一同步临界区内完成（并发取消只成功一次）；
     *   取消后该行不再出现于列表，再次收藏得到新 id（旧行不复活）。
     */
    async deleteFavorite(actor: unknown, id: unknown, options: WriteOptions = {}): Promise<{ accepted: true }> {
      const user = requireUserActor(actor);
      const favoriteId = requireUuidParam(id, 'id');
      const key = requireIdempotencyKey(options.idempotencyKey);
      const ifMatch = requireIfMatch(options.ifMatch);
      const scope = idempotencyScope(user.userId, 'DELETE', `${API_PREFIX}/favorites/${favoriteId}`);
      const keyHash = idempotencyKeyHashHex(scope, key);
      // 该 DELETE 契约上没有请求体：摘要只含 If-Match（用**规范化后**的强 ETag，不用原始头）。
      const digest = idempotencyRequestHash(null, ifMatch.raw, signingKey);
      return withIdempotency(
        scope,
        keyHash,
        digest,
        200,
        async () => {
          const record = await store.getFavorite(favoriteId);
          // 归属与"不存在"同形：非本人**不得**得到 409（那会泄露"存在但不是你的"）。
          if (record === null || record.owner_id !== user.userId) throw notFound();
          if (record.revision !== ifMatch.revision) {
            throw new ApiError('REVISION_CONFLICT', '收藏版本已变化，请刷新后重试');
          }
          // 检查（归属/revision）与删除在**同一原子临界区**内再次完成，
          // `record`（旧快照）只用于给出"期望值"，不用于写回。
          const committed = await store.deleteFavorite(favoriteId, {
            revision: record.revision,
            owner_id: user.userId,
          });
          if (!committed.ok) throw commitRefusal(committed.reason);
          return {
            outcome: { kind: 'favorite' as const, id: favoriteId, revision: committed.record.revision },
            result: { accepted: true as const },
          };
        },
        async () => {
          // 重放：按结果引用重新鉴权（行已删除 ⇒ 只有仍属于本主体才可回报成功）。
          const record = await store.getFavorite(favoriteId);
          if (record !== null && record.owner_id !== user.userId) throw notFound();
          return { accepted: true as const };
        },
      );
    },
  };
}

export type FavoritesService = ReturnType<typeof createFavoritesService>;

/** 定长比较（避免把签名长度差异暴露成时序差异）；不引入额外依赖。 */
function timingSafeEqualBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}
