/**
 * GY-I16（#16）· 历史子域存储（可注入）。
 *
 * 本片交付**内存实现**，边界与收藏域相同（进程内、重启即丢、**没有**新增数据库迁移；
 * 阶段 2 需按同接口实现 PG 版本：历史行 + `(owner_id, kind, target_id)` 唯一约束 + 幂等台账）。
 *
 * 三个**唯一写入原语**：
 *   1. `insertHistory`：同 `id`、或同 `(owner_id, kind, target_id)` 已存在 ⇒ `duplicate`（去重）；
 *   2. `deleteHistory`：**CAS**，同一同步临界区内校验 `owner_id` 与 `revision`，物理删除；
 *   3. `deleteAllByOwner`：**注销清理原语**（按主体清空；返回删除行数）。
 *      只由 `services/api/src/privacy/user-data-deletion.ts` 注册到**已合并的**
 *      `packages/privacy` 删除注册协议上调用，**不注册任何契约路由**。
 *
 * `job_state` 是**入库时记录的最后已知状态**（闭集校验后写入），读取时会再由
 * `history/job.ts` 的端口核对实时状态；`reference_state` **不入库**（每次读取派生）。
 */
import type { TargetRef } from '../targetref/types.ts';
import { cloneDeep, freezeDeep, takeOwnershipDeep } from '../targetref/immutable.ts';
import type { HistoryKind, JobState } from './types.ts';
import { isJobState } from './types.ts';

export interface HistoryRecord {
  id: string;
  /** 资源版本（强 ETag 绑定 `"<revision>"`）。创建即 1；历史行创建后不再变更（只可删除）。 */
  revision: number;
  /** 归属：只有本人能读到/删除（他人一律与"不存在"同形）。 */
  owner_id: string;
  kind: HistoryKind;
  target_ref: TargetRef;
  /** 内部作业标识（**不出契约**）：读取时用它向公开的 `getJob` 核对实时状态。 */
  job_id: string;
  /** 入库时的最后已知状态（闭集内取值；读取时可能被实时值覆盖）。 */
  job_state: JobState;
  created_at: string;
  /** 去重键（**内部字段，不出契约**）：同 `(owner_id, event_key)` 只存在一条历史行。 */
  event_key: string;
}

/**
 * 删除的级联披露（内部字段，**不出契约**）：只区分"已启动／部分已删／未接线／启动失败"，绝不声称完成。
 *
 * `'partial'`（R33 裁定新增）语义**严格**为：历史行已删除 ＋ **至少一项**关联对象
 * （识别结果 / OCR 记录）**已删除** ＋ **未全部删除成功**（媒体与外发删除仍跨线未接）。
 * ⛔ 「一项都没删成功」仍是 `'failed'`；⛔ 未接线仍是 `'unwired'`，不得改写。
 * 与 `history/cascade.ts` 的 `CascadeOutcome` 同值。
 */
export type CascadeDisclosure = 'initiated' | 'partial' | 'unwired' | 'failed';

/** 幂等结果引用（不含任何凭据；重放时按引用重新读取并重新鉴权）。 */
export interface IdempotencyOutcome {
  kind: 'history';
  id: string;
  revision: number;
  /**
   * 首次成功请求的级联披露。重放**按引用回放同一披露**，而不是再触发一次级联删除
   * （重复触发会对外部接收方产生第二次删除请求）。
   */
  cascade?: CascadeDisclosure;
}

export interface IdempotencyRecord {
  request_hash: string;
  response_status: number;
  outcome: IdempotencyOutcome;
  expires_at: number;
}

export type InsertResult = 'inserted' | 'duplicate';

export interface DeleteExpectation {
  revision: number;
  owner_id?: string;
}

export type DeleteResult =
  | { ok: true; record: HistoryRecord }
  | { ok: false; reason: 'NOT_FOUND' | 'OWNER_CHANGED' | 'REVISION_CHANGED' };

/** GY-I19（#19）· 受理事务内枚举用的最小 SQL 客户端（只用到 `query`，不把 pg 类型灌进本域）。 */
export interface BackupSnapshotClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface HistoryStore {
  readonly persistent: boolean;
  insertHistory(record: HistoryRecord): Promise<InsertResult>;
  getHistory(id: string): Promise<HistoryRecord | null>;
  findByEventKey(ownerId: string, eventKey: string): Promise<HistoryRecord | null>;
  findByTarget(ownerId: string, kind: HistoryKind, targetId: string): Promise<HistoryRecord | null>;
  /** **归属域**列表原语：只返回该主体的行（存储层不把他人行交给上层）。 */
  listHistoryByOwner(ownerId: string): Promise<HistoryRecord[]>;
  /** 删除历史行的唯一写入原语（CAS + 物理删除）。 */
  deleteHistory(id: string, expected: DeleteExpectation): Promise<DeleteResult>;
  /** **注销清理**原语：清空该主体的全部历史行，返回删除行数（只有 F13 注册的处理器会调用）。 */
  deleteAllByOwner(ownerId: string): Promise<number>;
  /**
   * GY-I19（#19）· **备份副本清单**原语：在受理事务内枚举该主体仍持有的对象引用。
   *
   * 只返回**不透明引用**（行 id）与计数：payload 里不许出现历史条目的对象名/身份信息
   * （设计 §5 的最小化清单）。必须用调用方给的 `client`（受理事务那条连接）。
   */
  snapshotOwner?(
    ownerId: string,
    client: BackupSnapshotClient,
  ): Promise<{ objectRefs: readonly string[]; records: number }>;
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
const eventComposite = (ownerId: string, eventKey: string): string => `${ownerId}${KEY_DELIMITER}${eventKey}`;
const targetComposite = (ownerId: string, kind: string, targetId: string): string =>
  `${ownerId}${KEY_DELIMITER}${kind}${KEY_DELIMITER}${targetId}`;
const idempotencyComposite = (scope: string, keyHash: string): string => `${scope}${KEY_DELIMITER}${keyHash}`;

/** 契约排序口径：`(created_at DESC, id DESC)`。 */
export function compareHistoryDescending(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** 内存实现（测试/替身；不是持久化，不代表端到端可用）。 */
export function createMemoryHistoryStore(
  options: { now?: () => number } = {},
): HistoryStore & { snapshotCounts(): { history: number; unique_targets: number } } {
  const rows = new Map<string, HistoryRecord>();
  const eventIndex = new Map<string, string>();
  const targetIndex = new Map<string, string>();
  const idempotency = new Map<string, IdempotencySlot>();
  const clockMs = options.now ?? (() => Date.now());

  function settle(scope: string, keyHash: string): void {
    const slot = idempotency.get(idempotencyComposite(scope, keyHash));
    if (slot === undefined) return;
    const waiters = slot.waiters.splice(0, slot.waiters.length);
    for (const wake of waiters) wake();
  }

  function forget(record: HistoryRecord): void {
    rows.delete(record.id);
    eventIndex.delete(eventComposite(record.owner_id, record.event_key));
    targetIndex.delete(targetComposite(record.owner_id, record.kind, record.target_ref.id));
  }

  /**
   * 删除的**同步**临界区（调用链上无 `await`）。阶段 2 的 PG 实现必须在同一事务内
   * `SELECT ... FOR UPDATE` 后完成同样的比较与删除（等价 SQL：
   * `DELETE FROM history WHERE id = $1 AND owner_id = $2 AND revision = $3`，以 `rowCount` 判定）。
   */
  function remove(id: string, expected: DeleteExpectation): DeleteResult {
    const current = rows.get(id);
    if (current === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (expected.owner_id !== undefined && current.owner_id !== expected.owner_id) {
      return { ok: false, reason: 'OWNER_CHANGED' };
    }
    if (current.revision !== expected.revision) return { ok: false, reason: 'REVISION_CHANGED' };
    const deleted = cloneDeep(current);
    forget(current);
    return { ok: true, record: deleted };
  }

  return {
    persistent: false,

    async insertHistory(record) {
      if (!isJobState(record.job_state)) return 'duplicate';
      const byEvent = eventComposite(record.owner_id, record.event_key);
      const byTarget = targetComposite(record.owner_id, record.kind, record.target_ref.id);
      if (rows.has(record.id) || eventIndex.has(byEvent) || targetIndex.has(byTarget)) return 'duplicate';
      const stored = takeOwnershipDeep(record);
      rows.set(record.id, stored);
      eventIndex.set(byEvent, record.id);
      targetIndex.set(byTarget, record.id);
      return 'inserted';
    },
    async getHistory(id) {
      const record = rows.get(id);
      return record === undefined ? null : cloneDeep(record);
    },
    async findByEventKey(ownerId, eventKey) {
      const id = eventIndex.get(eventComposite(ownerId, eventKey));
      if (id === undefined) return null;
      const record = rows.get(id);
      return record === undefined ? null : cloneDeep(record);
    },
    async findByTarget(ownerId, kind, targetId) {
      const id = targetIndex.get(targetComposite(ownerId, kind, targetId));
      if (id === undefined) return null;
      const record = rows.get(id);
      return record === undefined ? null : cloneDeep(record);
    },
    async listHistoryByOwner(ownerId) {
      return [...rows.values()]
        .filter((record) => record.owner_id === ownerId)
        .map((record) => freezeDeep(cloneDeep(record)));
    },
    async deleteHistory(id, expected) {
      return remove(id, expected);
    },
    async deleteAllByOwner(ownerId) {
      const mine = [...rows.values()].filter((record) => record.owner_id === ownerId);
      for (const record of mine) forget(record);
      return mine.length;
    },
    /**
     * 备份副本清单（GY-I19）：只回行 id 与计数。
     * 内存实现没有事务，`client` 不参与（清单与受理在同一进程、同一同步临界区里读）。
     */
    async snapshotOwner(ownerId) {
      const mine = [...rows.values()].filter((record) => record.owner_id === ownerId);
      return { objectRefs: mine.map((record) => record.id), records: mine.length };
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
        if (typeof timer.unref === 'function') timer.unref();
        const wake = (): void => {
          clearTimeout(timer);
          resolve('settled');
        };
        slot.waiters.push(wake);
      });
    },

    /** 诊断计数（测试用；不出契约）：去重不变式 ⇒ `unique_targets === history`。 */
    snapshotCounts() {
      return { history: rows.size, unique_targets: targetIndex.size };
    },
  };
}
