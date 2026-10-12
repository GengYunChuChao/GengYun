/**
 * 后台资料存储（GY-I18 阶段 1）：**进程内内存实现**，非真实 PostgreSQL 接线。
 *
 * 三条硬性纪律落在这一层：
 * 1. **修订只可追加**：`appendRevision` 只能往后加编号，永不原地改写既有修订。
 * 2. **写路径有临界区**：`transaction()` 串行化所有读-改-写，发布/撤回的
 *    「原子占位 → 生效 → 记审计」整体在同一个临界区内完成，不存在交错。
 * 3. **审计只可追加**：审计台账由 `audit.ts` 提供，本层没有删改入口。
 *
 * 另有**不可变边界**（返修 1）：`appendRevision` 入库即深拷贝 + 深冻结（含嵌套对象），
 * 修订本体也冻结；配合各投影的出口深拷贝，任何外部持有者都无法通过响应改写存储。
 * 详见 `immutable.ts` 与 `tests/unit/admin-content-immutability.test.mjs`。
 *
 * 幂等台账沿用 `services/api/src/auth/idempotency.ts` 的 claim/complete/release 语义：
 * 占位行（outcome 未定型）**不算**已完成结果，对重放方表现为「尚未就绪」。
 */
import { randomUUID } from 'node:crypto';
import type { AuditLog } from './audit.ts';
import { takeOwnershipDeep } from './immutable.ts';
import { createAdminRuntime } from './runtime.ts';
import type { AdminRuntime, IdempotencyClaimInput, IdempotencyLedgerRow, IdempotencySettledRecord } from './runtime.ts';
import type {
  AdminFamily,
  ContentIdempotencyOutcome,
  Lifecycle,
  StoredEntity,
  StoredRevision,
} from './types.ts';

/**
 * 幂等台账与审计由 `runtime.ts` 提供（阶段 1b 的两个切片共用同一套实现）。
 * 这里重新导出这些类型，保持阶段 1 的既有引用路径不变。
 */
export type { IdempotencyClaimInput, IdempotencyLedgerRow, IdempotencySettledRecord };

export interface AdminContentStore {
  /** 内存 store：**不得**对外声称已接真实数据库。 */
  readonly persistent: false;
  /** 临界区：写路径的读-改-写必须整体在其中执行。 */
  transaction<T>(work: () => T | Promise<T>): Promise<T>;
  readonly audit: AuditLog;

  createEntity(input: { id?: string; family: AdminFamily; stewardId: string; createdAt: Date }): StoredEntity<unknown>;
  getEntity(id: string): StoredEntity<unknown> | undefined;
  listEntities(family: AdminFamily, stewardId: string): readonly StoredEntity<unknown>[];
  appendRevision(input: {
    entity: StoredEntity<unknown>;
    content: unknown;
    authorId: string;
    createdAt: Date;
    derivedFromRevision: number | null;
  }): StoredRevision<unknown>;
  setLifecycle(entity: StoredEntity<unknown>, lifecycle: Lifecycle): void;

  /** 已定型结果；占位中与不存在都返回 null。 */
  findIdempotent(scope: string, keyHash: string): IdempotencySettledRecord | null;
  /** 原始台账行（含占位）；用于区分「同键同体仍在占位」与「同键异体」。 */
  peekIdempotent(scope: string, keyHash: string): IdempotencyLedgerRow | null;
  /** 原子占位：仅当无未到期行时成功。 */
  claimIdempotent(scope: string, keyHash: string, claim: IdempotencyClaimInput): boolean;
  /** 占位者写入最终结果；仅当该行仍是占位时成功。 */
  completeIdempotent(scope: string, keyHash: string, outcome: ContentIdempotencyOutcome, expiresAt: Date): boolean;
  /** 放弃占位（produce 失败）；只删未定型的占位行。 */
  releaseIdempotent(scope: string, keyHash: string): void;
  /** 实际删除已到期行；返回删除数量。 */
  purgeExpiredIdempotent(now: Date): number;
  idempotentCount(): number;
}

export function createAdminContentStore(options: { runtime?: AdminRuntime } = {}): AdminContentStore {
  const runtime = options.runtime ?? createAdminRuntime();
  const entities = new Map<string, StoredEntity<unknown>>();

  return {
    persistent: false,
    audit: runtime.audit,
    transaction: runtime.transaction,

    createEntity(input) {
      const id = input.id ?? randomUUID();
      if (entities.has(id)) throw new Error(`资料 id 重复：${id}`);
      const entity: StoredEntity<unknown> = {
        id,
        family: input.family,
        stewardId: input.stewardId,
        createdAt: input.createdAt,
        revisions: [],
        publishedRevision: null,
        lifecycle: 'draft',
        publishedAt: null,
        publishedById: null,
        publishedEvidenceRef: null,
        publishedReason: null,
        withdrawnAt: null,
        withdrawnById: null,
        withdrawnReason: null,
      };
      entities.set(id, entity);
      return entity;
    },

    getEntity(id) {
      return entities.get(id);
    },

    listEntities(family, stewardId) {
      return Object.freeze(
        [...entities.values()]
          .filter((entity) => entity.family === family && entity.stewardId === stewardId)
          // 稳定游标：按 id 升序。
          .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
      );
    },

    appendRevision(input) {
      const { entity } = input;
      const previous = entity.revisions.at(-1);
      const revision = previous === undefined ? 1 : previous.revision + 1;
      // **存储边界**：入库即深拷贝 + 深冻结（含嵌套对象），并冻结修订本体。
      // 库内内容从此不与任何外部对象共享引用，也不可能被外部改写；
      // 越界改动会直接抛 TypeError（本片选定的可判定语义，见 immutable.ts）。
      const stored: StoredRevision<unknown> = Object.freeze({
        revision,
        content: takeOwnershipDeep(input.content),
        createdAt: input.createdAt,
        authorId: input.authorId,
        derivedFromRevision: input.derivedFromRevision,
      });
      entity.revisions.push(stored);
      return stored;
    },

    setLifecycle(entity, lifecycle) {
      entity.lifecycle = lifecycle;
    },

    // ---- 幂等台账：整体委托给共享 runtime（阶段 1b 复用同一套实现）----
    findIdempotent: runtime.findIdempotent,
    peekIdempotent: runtime.peekIdempotent,
    claimIdempotent: runtime.claimIdempotent,
    completeIdempotent: runtime.completeIdempotent,
    releaseIdempotent: runtime.releaseIdempotent,
    purgeExpiredIdempotent: runtime.purgeExpiredIdempotent,
    idempotentCount: runtime.idempotentCount,
  };
}
