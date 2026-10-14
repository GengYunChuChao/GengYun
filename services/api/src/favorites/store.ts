/**
 * GY-I16（#16）· 收藏子域存储（可注入）。
 *
 * 本片交付**内存实现**，并明确声明其边界（不得当作已完成持久化）：
 *   - 进程内状态，重启即丢；**没有**新增数据库迁移（`services/api/db/**` 属共享文件，本片不碰）；
 *   - 阶段 2 需按同接口实现 PG 版本：收藏行 + **`(owner_id, target_type, target_id)` 唯一约束**
 *     + 幂等台账，因此本片**不宣称**收藏已端到端可用。
 *
 * 两个**唯一写入原语**（不存在无条件覆盖的入口）：
 *   1. `insertFavorite`：同 `id`、或同 `(owner_id, target_type, target_id)` 已存在
 *      ⇒ 不写入、返回 `'duplicate'`（**去重**：同一个用户对同一目标永远只有一行）；
 *   2. `deleteFavorite`：**比较并删除（CAS）**，同一同步临界区内校验 `owner_id` 与 `revision`。
 *      删除是**物理删除**：取消之后再收藏会得到一行**新 id**，旧行不会复活。
 *
 * 「收藏不自动转成已使用事实」在本文件是**结构性**的：存储里没有"使用/已用"字段，
 * 也没有任何写历史/写任务的入口（收藏域整体不持有历史或识别端口）。
 */
import type { TargetRef } from '../targetref/types.ts';
import { cloneDeep, freezeDeep, takeOwnershipDeep } from '../targetref/immutable.ts';

export interface FavoriteRecord {
  id: string;
  /** 资源版本（强 ETag 绑定 `"<revision>"`）。创建即 1；收藏行创建后不再变更（只可取消）。 */
  revision: number;
  /** 归属：只有本人能读到/取消（他人一律与"不存在"同形）。 */
  owner_id: string;
  /** 目标引用快照（`type`/`id`/`revision`）。可见性**不入库**，每次读取重新派生。 */
  target_ref: TargetRef;
  created_at: string;
}

/** 幂等结果引用（不含任何凭据；重放时按引用重新读取并重新鉴权）。 */
export interface IdempotencyOutcome {
  kind: 'favorite';
  id: string;
  revision: number;
}

export interface IdempotencyRecord {
  request_hash: string;
  response_status: number;
  outcome: IdempotencyOutcome;
  expires_at: number;
}

export type InsertResult = 'inserted' | 'duplicate';

/** CAS 比较条件：仅当同一临界区内重读到当前记录且逐项满足期望，才允许删除。 */
export interface DeleteExpectation {
  revision: number;
  owner_id?: string;
}

export type DeleteResult =
  | { ok: true; record: FavoriteRecord }
  | { ok: false; reason: 'NOT_FOUND' | 'OWNER_CHANGED' | 'REVISION_CHANGED' };

export interface FavoritesStore {
  readonly persistent: boolean;
  /** 写入新收藏；同 id 或同 `(owner_id, target_type, target_id)` 已存在 ⇒ `duplicate` 且不覆盖。 */
  insertFavorite(record: FavoriteRecord): Promise<InsertResult>;
  getFavorite(id: string): Promise<FavoriteRecord | null>;
  /** **去重键**查询：同主体同目标（`type`+`id`）的现有收藏（**不含 revision**）。 */
  findByTarget(ownerId: string, type: string, targetId: string): Promise<FavoriteRecord | null>;
  /** **归属域**列表原语：只返回该主体的行（存储层不把他人行交给上层）。 */
  listFavoritesByOwner(ownerId: string): Promise<FavoriteRecord[]>;
  /** 取消收藏的唯一写入原语（CAS + 物理删除）。 */
  deleteFavorite(id: string, expected: DeleteExpectation): Promise<DeleteResult>;
  /**
   * **注销清理**原语：清空该主体的全部收藏行，返回删除行数。
   * 只由 `services/api/src/privacy/user-data-deletion.ts` 注册到**已合并的**
   * `packages/privacy` 删除注册协议上调用，**不注册任何契约路由**。
   */
  deleteAllByOwner(ownerId: string): Promise<number>;
  // ---- 幂等台账 ----
  findIdempotency(scope: string, keyHash: string): Promise<IdempotencyRecord | null>;
  claimIdempotency(
    scope: string,
    keyHash: string,
    claim: { request_hash: string; response_status: number; expires_at: number },
  ): Promise<boolean>;
  completeIdempotency(
    scope: string,
    keyHash: string,
    done: { response_status: number; outcome: IdempotencyOutcome },
  ): Promise<boolean>;
  releaseIdempotency(scope: string, keyHash: string): Promise<void>;
  awaitIdempotencySettled(scope: string, keyHash: string, waitMs: number): Promise<'settled' | 'timeout'>;
}

interface IdempotencySlot {
  request_hash: string;
  response_status: number;
  outcome: IdempotencyOutcome | null;
  expires_at: number;
  waiters: Array<() => void>;
}

const KEY_DELIMITER = '\u0000';
const targetComposite = (ownerId: string, type: string, targetId: string): string =>
  `${ownerId}${KEY_DELIMITER}${type}${KEY_DELIMITER}${targetId}`;
const idempotencyComposite = (scope: string, keyHash: string): string => `${scope}${KEY_DELIMITER}${keyHash}`;

/** 契约排序口径：`(created_at DESC, id DESC)`（`docs/architecture/state-contract.md`）。 */
export function compareFavoritesDescending(
  a: { created_at: string; id: string },
  b: { created_at: string; id: string },
): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** 内存实现（测试/替身；不是持久化，不代表端到端可用）。 */
export function createMemoryFavoritesStore(
  options: { now?: () => number } = {},
): FavoritesStore & { snapshotCounts(): { favorites: number; unique_targets: number } } {
  const favorites = new Map<string, FavoriteRecord>();
  const targetIndex = new Map<string, string>();
  const idempotency = new Map<string, IdempotencySlot>();
  // 幂等窗口比较必须与服务使用同一个时钟（脚本化时钟不会被真实 Date.now() 判成过期）。
  const clockMs = options.now ?? (() => Date.now());

  function settle(scope: string, keyHash: string): void {
    const slot = idempotency.get(idempotencyComposite(scope, keyHash));
    if (slot === undefined) return;
    const waiters = slot.waiters.splice(0, slot.waiters.length);
    for (const wake of waiters) wake();
  }

  /**
   * 取消收藏的**同步**临界区。
   *
   * 本函数**没有任何 `await`**：从"重读当前记录"到"删除"之间不产生事件循环让步，
   * 所以不会出现"两个并发取消都读到同一版本、都删除成功"的窗口。
   * 阶段 2 的 PG 实现必须在**同一事务**内 `SELECT ... FOR UPDATE` 后完成同样的比较与删除
   * （等价 SQL：`DELETE FROM favorites WHERE id = $1 AND owner_id = $2 AND revision = $3`，
   * 以 `rowCount` 判定是否真的删除了行），语义与这里逐条对齐。
   */
  function remove(id: string, expected: DeleteExpectation): DeleteResult {
    const current = favorites.get(id);
    if (current === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (expected.owner_id !== undefined && current.owner_id !== expected.owner_id) {
      return { ok: false, reason: 'OWNER_CHANGED' };
    }
    if (current.revision !== expected.revision) return { ok: false, reason: 'REVISION_CHANGED' };
    const deleted = cloneDeep(current);
    favorites.delete(id);
    targetIndex.delete(targetComposite(current.owner_id, current.target_ref.type, current.target_ref.id));
    return { ok: true, record: deleted };
  }

  return {
    persistent: false,

    async insertFavorite(record) {
      const composite = targetComposite(record.owner_id, record.target_ref.type, record.target_ref.id);
      if (favorites.has(record.id) || targetIndex.has(composite)) return 'duplicate';
      // 入口冻结 + 深拷贝：库内记录与调用方对象零共享引用。
      const stored = takeOwnershipDeep(record);
      favorites.set(record.id, stored);
      targetIndex.set(composite, record.id);
      return 'inserted';
    },
    async getFavorite(id) {
      const record = favorites.get(id);
      return record === undefined ? null : cloneDeep(record);
    },
    async findByTarget(ownerId, type, targetId) {
      const id = targetIndex.get(targetComposite(ownerId, type, targetId));
      if (id === undefined) return null;
      const record = favorites.get(id);
      return record === undefined ? null : cloneDeep(record);
    },
    async listFavoritesByOwner(ownerId) {
      return [...favorites.values()]
        .filter((record) => record.owner_id === ownerId)
        .map((record) => freezeDeep(cloneDeep(record)));
    },
    async deleteFavorite(id, expected) {
      return remove(id, expected);
    },
    async deleteAllByOwner(ownerId) {
      const mine = [...favorites.values()].filter((record) => record.owner_id === ownerId);
      for (const record of mine) {
        favorites.delete(record.id);
        targetIndex.delete(targetComposite(record.owner_id, record.target_ref.type, record.target_ref.id));
      }
      return mine.length;
    },

    async findIdempotency(scope, keyHash) {
      const key = idempotencyComposite(scope, keyHash);
      const slot = idempotency.get(key);
      if (slot === undefined) return null;
      if (slot.expires_at <= clockMs()) {
        idempotency.delete(key);
        return null;
      }
      if (slot.outcome === null) return null;
      return {
        request_hash: slot.request_hash,
        response_status: slot.response_status,
        outcome: { ...slot.outcome },
        expires_at: slot.expires_at,
      };
    },
    async claimIdempotency(scope, keyHash, claim) {
      const key = idempotencyComposite(scope, keyHash);
      const slot = idempotency.get(key);
      if (slot !== undefined && slot.expires_at > clockMs()) return false;
      idempotency.set(key, {
        request_hash: claim.request_hash,
        response_status: claim.response_status,
        outcome: null,
        expires_at: claim.expires_at,
        waiters: [],
      });
      return true;
    },
    async completeIdempotency(scope, keyHash, done) {
      const slot = idempotency.get(idempotencyComposite(scope, keyHash));
      if (slot === undefined || slot.outcome !== null) return false;
      slot.outcome = { ...done.outcome };
      slot.response_status = done.response_status;
      settle(scope, keyHash);
      return true;
    },
    async releaseIdempotency(scope, keyHash) {
      const key = idempotencyComposite(scope, keyHash);
      const slot = idempotency.get(key);
      if (slot === undefined || slot.outcome !== null) return;
      idempotency.delete(key);
      settle(scope, keyHash);
    },
    async awaitIdempotencySettled(scope, keyHash, waitMs) {
      const slot = idempotency.get(idempotencyComposite(scope, keyHash));
      if (slot === undefined || slot.outcome !== null) return 'settled';
      return new Promise<'settled' | 'timeout'>((resolve) => {
        const timer = setTimeout(() => {
          const index = slot.waiters.indexOf(wake);
          if (index >= 0) slot.waiters.splice(index, 1);
          resolve('timeout');
        }, waitMs);
        // 不因等待者而拖住进程退出。
        if (typeof timer.unref === 'function') timer.unref();
        const wake = (): void => {
          clearTimeout(timer);
          resolve('settled');
        };
        slot.waiters.push(wake);
      });
    },

    /** 诊断计数（测试用；不出契约）：`unique_targets` 应恒等于 `favorites`（去重不变式）。 */
    snapshotCounts() {
      return { favorites: favorites.size, unique_targets: targetIndex.size };
    },
  };
}
