/**
 * 后台服务运行时（GY-I18 阶段 1 抽出，阶段 1b 复用）。
 *
 * 这里只做三件与具体业务无关的事，供**内容生命周期**（`store.ts`）与
 * **后台运营/开关**（`ops/store.ts`）两个切片共用：
 *   1. **串行临界区** `transaction()`：写路径的读-改-写整体执行，不存在交错；
 *   2. **只可追加的审计台账**（`audit.ts`，无删改入口）；
 *   3. **幂等台账**：沿用 `services/api/src/auth/idempotency.ts` 的
 *      claim / complete / release 语义（占位行 `outcome === null` 不算已完成结果）。
 *
 * 抽出动机：阶段 1b 的写路径（`editCategory`/`suspendUser`/`cancelAdminJob`/`setFlag`/`hidePost`）
 * 必须**复用同一套**原子占位与审计，而不是另写第二套。抽出是纯搬移，语义逐条不变。
 */
import { createAuditLog } from './audit.ts';
import type { AuditLog } from './audit.ts';
import type { ContentIdempotencyOutcome } from './types.ts';

export interface IdempotencyClaimInput {
  requestHash: string;
  responseStatus: number;
  expiresAt: Date;
  /** 判定既有行是否已到期所用的当前时刻。 */
  now: Date;
}

/** 台账行的真实形状：`outcome === null` 即「占位中」。 */
export interface IdempotencyLedgerRow {
  requestHash: string;
  responseStatus: number;
  outcome: ContentIdempotencyOutcome | null;
  expiresAt: Date;
}

/** 已定型的台账记录（重放时返回的就是这种）。 */
export interface IdempotencySettledRecord {
  requestHash: string;
  responseStatus: number;
  outcome: ContentIdempotencyOutcome;
  expiresAt: Date;
}

export interface AdminRuntime {
  /** 内存实现：**不得**对外声称已接真实数据库。 */
  readonly persistent: false;
  readonly audit: AuditLog;
  transaction<T>(work: () => T | Promise<T>): Promise<T>;

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

/** 串行临界区：把并发的写路径排成一条链，保证「占位」与「生效」之间不被打断。 */
export function createCriticalSection(): <T>(work: () => T | Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => T | Promise<T>): Promise<T> => {
    const result = tail.then(() => work());
    // 无论成败都不让链条断掉，也不让失败外溢到后续排队者。
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export function createAdminRuntime(): AdminRuntime {
  const ledger = new Map<string, IdempotencyLedgerRow>();
  const audit = createAuditLog();
  const runExclusive = createCriticalSection();
  const composite = (scope: string, keyHash: string): string => `${scope}\u0000${keyHash}`;

  return {
    persistent: false,
    audit,
    transaction: runExclusive,

    findIdempotent(scope, keyHash) {
      const row = ledger.get(composite(scope, keyHash));
      // 占位行（outcome === null）不算已完成结果：对重放方表现为「尚未就绪」。
      if (row === undefined || row.outcome === null) return null;
      return { requestHash: row.requestHash, responseStatus: row.responseStatus, outcome: row.outcome, expiresAt: row.expiresAt };
    },

    peekIdempotent(scope, keyHash) {
      const row = ledger.get(composite(scope, keyHash));
      return row === undefined ? null : { ...row };
    },

    claimIdempotent(scope, keyHash, claim) {
      const key = composite(scope, keyHash);
      const existing = ledger.get(key);
      // 只让**已到期**的旧行让位；未到期的行（无论占位还是已定型）一律不覆盖。
      if (existing !== undefined && existing.expiresAt.getTime() > claim.now.getTime()) return false;
      ledger.set(key, {
        requestHash: claim.requestHash,
        responseStatus: claim.responseStatus,
        outcome: null,
        expiresAt: claim.expiresAt,
      });
      return true;
    },

    completeIdempotent(scope, keyHash, outcome, expiresAt) {
      const key = composite(scope, keyHash);
      const existing = ledger.get(key);
      if (existing === undefined || existing.outcome !== null) return false;
      ledger.set(key, { requestHash: existing.requestHash, responseStatus: outcome.status, outcome, expiresAt });
      return true;
    },

    releaseIdempotent(scope, keyHash) {
      const key = composite(scope, keyHash);
      const existing = ledger.get(key);
      // 只释放未定型的占位；已定型结果不因后续失败被抹掉。
      if (existing !== undefined && existing.outcome === null) ledger.delete(key);
    },

    purgeExpiredIdempotent(now) {
      let removed = 0;
      for (const [key, row] of ledger) {
        if (row.expiresAt.getTime() <= now.getTime()) {
          ledger.delete(key);
          removed += 1;
        }
      }
      return removed;
    },

    idempotentCount() {
      return ledger.size;
    },
  };
}
