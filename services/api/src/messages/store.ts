/**
 * GY-I17（#17）阶段 1 · 消息域存储（可注入）。
 *
 * 本片交付**内存实现**，并明确声明其边界（不得当作已完成持久化）：
 *   - 进程内状态，重启即丢；**没有**新增数据库迁移（`db/**` 属共享文件，本阶段不碰）；
 *   - 阶段 2 需按 `docs/architecture/data-dictionary.md` 实现同接口的 PG 版本
 *     （消息行 + `read_at` 单调置位 + `(owner_id, event_key)` 唯一约束 + 幂等台账），
 *     因此阶段 1 **不宣称**消息系统已端到端可用。
 *
 * 三个**唯一写入原语**（不存在无条件覆盖的入口）：
 *   1. `insertMessage`：同 id 或同 `(owner_id, event_key)` 已存在 ⇒ 不写入、返回 `'duplicate'`；
 *   2. `markReadIfUnread`：读状态的唯一写入口，**比较并写入（CAS）** + **单调**
 *      （只允许 `null → 时刻`；已是已读则**空操作**：不改时间、不推进版本、不再计数）；
 *      **首次读转换会推进 `revision`（自 1 递增）** —— `read_at` 是契约 `Message` 的字段，
 *      改它就是改资源表示，强 ETag `"<revision>"` 必须随之变化（依据：冻结条款
 *      `docs/architecture/state-contract.md`「GET 条目带强 ETag `"<revision>"`；版本整数自1递增…」，
 *      逐字引文见证据文档 §12）。
 *      整个临界区**没有任何 `await`** ⇒ 并发标记只会有一次真正写入（= 恰好一次版本推进）；
 *   3. 幂等台账 `claim/complete/release`（沿用 `auth/idempotency.ts` 的
 *      「先原子占位 → produce → 写回结果，失败释放占位」语义）。
 *
 * **未读数是派生量，不是计数器**：`countUnread` 每次现算 `read_at === null` 的本人行数，
 * 因此不存在"计数漂移"路径，也不可能被并发标记减两次。
 */

import type { MessageType, TargetRef } from './types.ts';
import { cloneDeep, freezeDeep, takeOwnershipDeep } from './immutable.ts';

export interface MessageRecord {
  id: string;
  /**
   * 资源版本（强 ETag 绑定 `"<revision>"`）。初始 1；
   * **首次读转换（`read_at: null → 时刻`）推进 1**；重复标记（已是已读）不变。
   */
  revision: number;
  /** 接收者归属：只有本人能读到/标记（他人一律与"不存在"同形）。 */
  owner_id: string;
  type: MessageType;
  target_ref: TargetRef | null;
  /** 已读时刻（UTC RFC3339）；`null` = 未读。**单调**：一旦有值不再改变。 */
  read_at: string | null;
  created_at: string;
  /** 来源事件 + 版本去重键（**内部字段，不出契约**）。 */
  event_key: string;
}

/** 幂等结果引用（不含任何凭据；重放时按引用重新读取并重新鉴权）。 */
export interface IdempotencyOutcome {
  kind: 'message';
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

/** CAS 比较条件：仅当同一临界区内重读到当前记录且逐项满足期望，才允许写入。 */
export interface MarkReadExpectation {
  /** 必须等于当前 `revision`（契约 `If-Match` 的服务端等价物）。 */
  revision: number;
  /** 必须等于当前 `owner_id`（归属校验也在同一临界区内完成）。 */
  owner_id?: string;
}

/**
 * 读状态写入结果。
 * `transitioned` 明确区分"本次真的把 `null` 写成时刻**并推进了一次版本**"与
 * "读到已是已读、空操作未写入" —— 这是"并发只减一次 / 版本只 +1"的可判定证据
 * （诊断字段，不出契约）。
 */
export type MarkReadResult =
  | { ok: true; record: MessageRecord; transitioned: boolean }
  | { ok: false; reason: 'NOT_FOUND' | 'OWNER_CHANGED' | 'REVISION_CHANGED' };

/**
 * 注销清空的**分表**真实行数。
 *
 * 字段名与 `privacy/user-data-deletion.ts` 的 `OwnerPurgeCounts` 逐字一致，接线
 * （§7 P0-2）时可直接交给注销协调器，不必再套一层适配器：
 *   - `records`：本域正文表（`public.messages`）**真的被物理删除**的行数；
 *   - `idempotency`：本主体落在幂等台账里的行数（`public.idempotency_keys` / 内存槽位）。
 *
 * 两项都必须来自 `DELETE ... RETURNING` 的实际返回行数：拿不到行数就如实失败，
 * 绝不用「调用没报错」冒充「删了 N 行」。
 */
export interface MessagesOwnerPurgeCounts {
  records: number;
  idempotency: number;
}

/**
 * 实现了注销清理原语的存储（本片的内存实现与 PG 实现都满足）。
 *
 * 单独一个类型而不是把接口方法改成必填：`MessagesStore` 还要容纳既有替身，
 * 而这里表达的是「这份实现**确实**能按主体清空」——接线处（§7 P0-2）据此收窄即可。
 */
export interface PurgeableMessagesStore extends MessagesStore {
  deleteAllByOwner(ownerId: string): Promise<number>;
  purgeOwnerData(ownerId: string): Promise<MessagesOwnerPurgeCounts>;
}

/**
 * GY-I19（#19）· 受理事务内枚举用的最小 SQL 客户端。
 *
 * 与 `favorites/store.ts:59`、`history/store.ts:73` 的**同形状**定义（各域自持一份，
 * 不跨域 import 别域的存储类型）：只用到 `query`，不把 pg 的完整类型灌进本域。
 */
export interface BackupSnapshotClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface MessagesStore {
  readonly persistent: boolean;
  /** 写入新消息；同 id 或同 `(owner_id, event_key)` 已存在 ⇒ `duplicate` 且不覆盖。 */
  insertMessage(record: MessageRecord): Promise<InsertResult>;
  getMessage(id: string): Promise<MessageRecord | null>;
  /** **归属域**列表原语：只返回该主体的行（存储层不把他人行交给上层）。 */
  listMessagesByOwner(ownerId: string): Promise<MessageRecord[]>;
  findByEventKey(ownerId: string, eventKey: string): Promise<MessageRecord | null>;
  /** 读状态的唯一写入原语（CAS + 单调 + 同步临界区；首次转换推进 `revision`）。 */
  markReadIfUnread(id: string, expected: MarkReadExpectation, readAt: string): Promise<MarkReadResult>;
  /** **派生**未读数：`read_at === null` 的本人行数（不是计数器）。 */
  countUnread(ownerId: string): Promise<number>;
  /**
   * GY-I19（#19）· **备份副本清单**原语：在受理事务内枚举该主体仍持有的对象引用。
   *
   * 只返回**不透明引用**（行 id）与计数：payload 里不许出现消息正文/目标引用/身份信息
   * （设计 §5 的最小化清单）。必须用调用方给的 `client`（受理事务那条连接），
   * 否则清单与受理不在同一快照，「行已删、清单漏记」就会成为合法状态（设计 §6.1）。
   */
  snapshotOwner?(
    ownerId: string,
    client: BackupSnapshotClient,
  ): Promise<{ objectRefs: readonly string[]; records: number }>;
  // ---- 注销清理（#17 P0-1 / P0-2；已进注销模块闭集） ----
  /**
   * **注销清理**原语：按主体**物理删除**本域全部消息行，返回被删的正文行数。
   *
   * 为什么是可选方法：接口还要容纳只读/替身实现（既有多处替身只实现读路径）。
   * 需要「确实能按主体清空」的地方用 `PurgeableMessagesStore`（本文件下方）收窄，
   * 而不是把可选改必填——那会让每个既有替身立刻违反接口（属"为了好看而改契约"）。
   * C1b 起本域**已进注销模块闭集**（`privacy/user-data-deletion.ts` 的
   * `MESSAGES_DELETION_MODULE`），装配层交给注销协调器的正是 `PurgeableMessagesStore`。
   *
   * 幂等台账**没有 owner 列**（共享表 `public.idempotency_keys`，`0008_auth_session.sql:46-58`），
   * 只能按 `scope` 前缀删——`scope` 的第一段就是主体 uuid
   * （`auth/idempotency.ts:111-113` 的 `idempotencyScope`）。
   */
  deleteAllByOwner?(ownerId: string): Promise<number>;
  /** 同一次清理的**分表计数**（正文 + 台账）；协调器用它把两个真实行数都写进证据串。 */
  purgeOwnerData?(ownerId: string): Promise<MessagesOwnerPurgeCounts>;
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
const idempotencyComposite = (scope: string, keyHash: string): string => `${scope}${KEY_DELIMITER}${keyHash}`;

/** 契约排序口径：`(created_at DESC, id DESC)`（`docs/architecture/state-contract.md`）。 */
export function compareMessagesDescending(
  a: { created_at: string; id: string },
  b: { created_at: string; id: string },
): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** 内存实现（测试/替身；不是持久化，不代表端到端可用）。 */
export function createMemoryMessagesStore(
  options: { now?: () => number } = {},
): PurgeableMessagesStore & { snapshotCounts(): { messages: number; read_transitions: number } } {
  const messages = new Map<string, MessageRecord>();
  const eventIndex = new Map<string, string>();
  const idempotency = new Map<string, IdempotencySlot>();
  // 诊断计数：真正发生的 `null → 时刻` 写入次数（供"并发只减一次"用例断言）。
  let readTransitions = 0;
  // 幂等窗口比较必须与服务使用同一个时钟（脚本化时钟不会被真实 Date.now() 判成过期）。
  const clockMs = options.now ?? (() => Date.now());

  function settle(scope: string, keyHash: string): void {
    const slot = idempotency.get(idempotencyComposite(scope, keyHash));
    if (slot === undefined) return;
    const waiters = slot.waiters.splice(0, slot.waiters.length);
    for (const wake of waiters) wake();
  }

  /**
   * 读状态写入的**同步**临界区。
   *
   * 本函数**没有任何 `await`**：从"重读当前记录"到"写回"之间不产生事件循环让步，
   * 所以不会出现"两个并发标记都读到 `read_at === null`，然后各写一次（各推进一次版本）"的窗口。
   * 内存实现天然原子；阶段 2 的 PG 实现必须在**同一事务**内
   * `SELECT ... FOR UPDATE` 后完成同样的比较与写入（等价 SQL：
   * `UPDATE messages SET read_at = $3, revision = revision + 1
   *   WHERE id = $1 AND owner_id = $2 AND revision = $4 AND read_at IS NULL`，
   * 以 `rowCount` 判定是否真的发生了转换），语义与这里逐条对齐。
   */
  function markRead(id: string, expected: MarkReadExpectation, readAt: string): MarkReadResult {
    const current = messages.get(id);
    if (current === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (expected.owner_id !== undefined && current.owner_id !== expected.owner_id) {
      return { ok: false, reason: 'OWNER_CHANGED' };
    }
    if (current.revision !== expected.revision) return { ok: false, reason: 'REVISION_CHANGED' };
    // 单调 + 幂等：已是已读 ⇒ **空操作**（不改首次时间、不推进版本、不再次计减）。
    if (current.read_at !== null) return { ok: true, record: cloneDeep(current), transitioned: false };
    // 首次读转换：`read_at` 是资源表示的一部分 ⇒ 同步推进 `revision`（强 ETag 随之变化）。
    const next: MessageRecord = { ...current, revision: current.revision + 1, read_at: readAt };
    messages.set(id, freezeDeep(cloneDeep(next)));
    readTransitions += 1;
    return { ok: true, record: cloneDeep(next), transitioned: true };
  }

  /**
   * 注销清空的**同步**临界区（函数内没有任何 `await`，与 `markRead` 同口径）。
   *
   * 三件事必须一起做，否则留下两种"半删"：
   *   - 只删正文不删 `eventIndex` ⇒ 同一 `event_key` 再投递被判 `duplicate`，而消息已不存在；
   *   - 只删正文不删幂等槽位 ⇒ 同键重放仍能取回 `outcome` 里的消息引用（`{"kind":"message","id"}`）；
   *   - 幂等槽位的键是 `<scope>\u0000<keyHash>`，`scope` 自身不含 `\u0000`
   *     ⇒ 用第一个分隔符切出 scope 做**前缀**比较，不会误伤其他主体（uuid 定长且互不相同）。
   *
   * 仍在 `awaitIdempotencySettled` 上等的等待者不在此处唤醒：它们的槽位已经不存在，
   * 有界轮询会读到 `undefined ⇒ settled` 或走完自己的超时（`REQUEST_IN_PROGRESS` 可重试），
   * 两种结果都不成立「删除已成功」这种假话。
   */
  function purgeOwnerRows(ownerId: string): MessagesOwnerPurgeCounts {
    const scopePrefix = `${ownerId}\n`;
    let records = 0;
    for (const [id, record] of [...messages]) {
      if (record.owner_id !== ownerId) continue;
      messages.delete(id);
      eventIndex.delete(eventComposite(record.owner_id, record.event_key));
      records += 1;
    }
    let idempotencyCount = 0;
    for (const key of [...idempotency.keys()]) {
      const boundary = key.indexOf(KEY_DELIMITER);
      if (boundary < 0) continue;
      if (!key.slice(0, boundary).startsWith(scopePrefix)) continue;
      idempotency.delete(key);
      idempotencyCount += 1;
    }
    return { records, idempotency: idempotencyCount };
  }

  return {
    persistent: false,

    async insertMessage(record) {
      const eventKey = eventComposite(record.owner_id, record.event_key);
      if (messages.has(record.id) || eventIndex.has(eventKey)) return 'duplicate';
      // 入口冻结 + 深拷贝：库内记录与调用方对象零共享引用。
      const stored = takeOwnershipDeep(record);
      messages.set(record.id, stored);
      eventIndex.set(eventKey, record.id);
      return 'inserted';
    },
    async getMessage(id) {
      const record = messages.get(id);
      return record === undefined ? null : cloneDeep(record);
    },
    async listMessagesByOwner(ownerId) {
      return [...messages.values()].filter((record) => record.owner_id === ownerId).map(cloneDeep);
    },
    async findByEventKey(ownerId, eventKey) {
      const id = eventIndex.get(eventComposite(ownerId, eventKey));
      if (id === undefined) return null;
      const record = messages.get(id);
      return record === undefined ? null : cloneDeep(record);
    },
    async markReadIfUnread(id, expected, readAt) {
      return markRead(id, expected, readAt);
    },
    async countUnread(ownerId) {
      let count = 0;
      for (const record of messages.values()) {
        if (record.owner_id === ownerId && record.read_at === null) count += 1;
      }
      return count;
    },

    // ---- 注销清理（#17 P0-1） ----

    async deleteAllByOwner(ownerId) {
      // 正文行数是本方法的既有契约；台账在同一临界区里一并清掉，行数经 `purgeOwnerData` 给出。
      return purgeOwnerRows(ownerId).records;
    },

    async purgeOwnerData(ownerId) {
      return purgeOwnerRows(ownerId);
    },

    /**
     * 备份副本清单（GY-I19）：只回行 id 与计数，不回正文/目标引用。
     * 内存实现没有事务，`client` 不参与（清单与受理在同一进程、同一同步临界区里读）。
     */
    async snapshotOwner(ownerId) {
      const mine = [...messages.values()].filter((record) => record.owner_id === ownerId);
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
        // 不因等待者而拖住进程退出。
        if (typeof timer.unref === 'function') timer.unref();
        const wake = (): void => {
          clearTimeout(timer);
          resolve('settled');
        };
        slot.waiters.push(wake);
      });
    },

    /**
     * 诊断计数（测试用；不出契约）：`read_transitions` = 真正发生的
     * `read_at: null → 时刻` 写入次数，**等于版本推进次数**（首次转换才推进）。
     */
    snapshotCounts() {
      return { messages: messages.size, read_transitions: readTransitions };
    },
  };
}
