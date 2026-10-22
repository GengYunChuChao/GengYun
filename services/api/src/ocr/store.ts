/**
 * GY-I10 标签 OCR 任务存储（可插拔）。
 *
 * 本片只提供**内存实现**（进程内、可注入、用于本机与隔离回归）；持久化实现属后续任务，
 * 证据文档与 PR 正文必须如实标注「OCR 任务与记录在内存 store，进程重启即丢失，
 * 未取得 PG 持久化证据」。内存 store **不是**替身提供者，也不伪造任何业务结论：
 * 它只保存记录与 CAS 版本。
 *
 * 幂等台账与 services/api 的认证幂等台账口径一致（键域 = 主体/方法/路径，key_hash 只存摘要，
 * request_hash 含请求体与 If-Match），但**独立存放**，不改动既有认证幂等存储。
 */
import type { ErrorCode } from '../contract.ts';
import {
  canTransitionJob,
  cloneLabelFields,
  toVerificationProjection,
  type JobState,
  type LabelFields,
  type OcrVerification,
  type OcrVerificationDocument,
} from './state.ts';

/**
 * `OcrVerification` / `OcrVerificationDocument` / `toVerificationProjection` 定义在
 * `state.ts`（本模块 `export … from` 转出，保持既有导入路径可用）。
 * ⚠ 为什么搬过去：`ocr-http.mjs` 有一条**冻结的 OCR 域装载边基线**（11 条），
 * `service.ts` 原本只 `import type` 本模块（无运行时边），一旦从本模块取**值**
 * （`toVerificationProjection`）就多出一条基线之外的运行时边 ⇒ 判红。
 * 搬到两者都已装载的 `state.ts` 后，运行时装载边一条不增（判据未放宽）。
 */
export { toVerificationProjection };
export type { OcrVerification, OcrVerificationDocument };

export interface OcrJobRow {
  id: string;
  revision: number;
  kind: 'ocr';
  ownerUserId: string;
  ocrId: string;
  mediaId: string;
  mediaRevision: number;
  state: JobState;
  deadlineAt: Date;
  createdAt: Date;
  updatedAt: Date;
  errorCode: ErrorCode | null;
}

export interface OcrRow {
  id: string;
  revision: number;
  ownerUserId: string;
  mediaId: string;
  mediaRevision: number;
  /** 模型原始输出：**任何用户校正都不得改写本字段**（契约 correctOCR 明文要求保留 raw_fields）。 */
  rawFields: LabelFields;
  /** 用户校正后的字段：与 rawFields 严格分离，**不计入模型准确率**。 */
  correctedFields: LabelFields;
  /** 契约五字段 + 校正台账（见 `OcrVerificationDocument`）。 */
  verification: OcrVerificationDocument;
  modelVersion: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: boolean;
}

export interface IdempotencyRow {
  requestHash: string;
  expiresAt: Date;
  /** 只存**不含凭据**的结果引用（如 job_id / accepted）。 */
  payload: Record<string, unknown>;
  /**
   * true = 已**原子占位**但业务尚未完成。
   * 并发重复请求（同键同体）必须据此回 `REQUEST_IN_PROGRESS`，而不是重复执行副作用；
   * false = 业务已完成，可安全回放 `payload`。
   */
  pending: boolean;
}

/** 记录变更函数：只允许写白名单字段，避免调用方整体覆盖（防校正回写 rawFields）。 */
export type OcrJobMutation = (row: OcrJobRow) => OcrJobRow;
export type OcrMutation = (row: OcrRow) => OcrRow;

export interface OcrStore {
  readonly persistent: boolean;
  insertJob(row: OcrJobRow): Promise<void>;
  getJob(jobId: string): Promise<OcrJobRow | null>;
  /** CAS：revision 不一致返回 null（不覆盖他人并发写）。 */
  updateJob(jobId: string, expectedRevision: number, mutate: OcrJobMutation): Promise<OcrJobRow | null>;
  /**
   * 原子提交终态：同一临界区内校验 CAS 与合法迁移，写 OCR 记录（可为 null）并落任务终态。
   * CAS 失败（任务已被取消/已终态）返回 null，且**不写任何记录** —— 旧回调不复活任务。
   */
  commitTerminal(
    jobId: string,
    expectedRevision: number,
    terminal: { state: JobState; errorCode: ErrorCode | null },
    ocr: OcrRow | null,
    at: Date,
  ): Promise<OcrJobRow | null>;
  insertOcr(row: OcrRow): Promise<void>;
  getOcr(ocrId: string): Promise<OcrRow | null>;
  updateOcr(ocrId: string, expectedRevision: number, mutate: OcrMutation): Promise<OcrRow | null>;
  findIdempotent(scope: string, keyHashHex: string): Promise<IdempotencyRow | null>;
  /**
   * **原子占位**（先占位再建任务，消除 check-then-act 竞态）：
   * 同一 (scope, keyHash) 只允许**首个**调用方拿到 `claimed`；其余并发调用方一律 `exists`。
   * 已到期条目视同不存在，允许重新占位。
   * 实现必须「检查 + 写入」在同一同步临界区内完成，中间**不得** await。
   */
  claimIdempotent(
    scope: string,
    keyHashHex: string,
    row: IdempotencyRow,
    at: Date,
  ): Promise<'claimed' | 'exists'>;
  /** 占位者完成业务后写入最终结果引用，并把 pending 置为 false。 */
  finalizeIdempotent(scope: string, keyHashHex: string, payload: Record<string, unknown>): Promise<void>;
  /**
   * 占位者**放弃**占位（业务在 finalize 前失败，如版本冲突 / 校验失败）。
   * 必须释放：否则失败的首次请求会留下永久 pending，使同一 Idempotency-Key 的正常重试
   * 一直拿到 REQUEST_IN_PROGRESS。仅占位者有权调用。
   */
  releaseIdempotent(scope: string, keyHashHex: string): Promise<void>;
  /** 物理删除已到期台账条目。 */
  purgeIdempotent(now: Date): Promise<number>;
}

function cloneVerification(verification: OcrVerificationDocument): OcrVerificationDocument {
  const projection = toVerificationProjection(verification);
  const ledger = verification.correction_log;
  if (ledger === undefined) return projection;
  return {
    ...projection,
    correction_log: {
      version: ledger.version,
      entries: ledger.entries.map((entry) => ({
        version: entry.version,
        revision: entry.revision,
        actor_user_id: entry.actor_user_id,
        corrected_at: entry.corrected_at,
        changes: entry.changes.map((change) => ({ ...change })),
        raw_fields: cloneLabelFields(entry.raw_fields),
        corrected_fields: cloneLabelFields(entry.corrected_fields),
      })),
    },
  };
}

function cloneJob(row: OcrJobRow): OcrJobRow {
  return { ...row };
}

function cloneOcr(row: OcrRow): OcrRow {
  return {
    ...row,
    rawFields: cloneLabelFields(row.rawFields),
    correctedFields: cloneLabelFields(row.correctedFields),
    verification: cloneVerification(row.verification),
  };
}

export function createMemoryOcrStore(): OcrStore {
  const jobs = new Map<string, OcrJobRow>();
  const ocrRows = new Map<string, OcrRow>();
  const idempotency = new Map<string, IdempotencyRow>();
  const composite = (scope: string, keyHashHex: string): string => `${scope}\u0000${keyHashHex}`;
  return {
    persistent: false,
    async insertJob(row) {
      if (jobs.has(row.id)) throw new Error('任务 id 冲突');
      jobs.set(row.id, cloneJob(row));
    },
    async getJob(jobId) {
      const row = jobs.get(jobId);
      return row === undefined ? null : cloneJob(row);
    },
    async updateJob(jobId, expectedRevision, mutate) {
      const row = jobs.get(jobId);
      if (row === undefined || row.revision !== expectedRevision) return null;
      const next = mutate(cloneJob(row));
      jobs.set(jobId, cloneJob(next));
      return cloneJob(next);
    },
    async commitTerminal(jobId, expectedRevision, terminal, ocr, at) {
      const row = jobs.get(jobId);
      if (row === undefined || row.revision !== expectedRevision) return null;
      // 终态迁移必须合法：已被取消/已终态的任务不会被迟到结果改写。
      if (!canTransitionJob(row.state, terminal.state)) return null;
      if (ocr !== null && ocrRows.has(ocr.id)) throw new Error('OCR 记录 id 冲突');
      if (ocr !== null) ocrRows.set(ocr.id, cloneOcr(ocr));
      const next: OcrJobRow = {
        ...cloneJob(row),
        state: terminal.state,
        errorCode: terminal.errorCode,
        revision: row.revision + 1,
        updatedAt: at,
      };
      jobs.set(jobId, cloneJob(next));
      return cloneJob(next);
    },
    async insertOcr(row) {
      if (ocrRows.has(row.id)) throw new Error('OCR 记录 id 冲突');
      ocrRows.set(row.id, cloneOcr(row));
    },
    async getOcr(ocrId) {
      const row = ocrRows.get(ocrId);
      return row === undefined ? null : cloneOcr(row);
    },
    async updateOcr(ocrId, expectedRevision, mutate) {
      const row = ocrRows.get(ocrId);
      if (row === undefined || row.revision !== expectedRevision) return null;
      const next = mutate(cloneOcr(row));
      ocrRows.set(ocrId, cloneOcr(next));
      return cloneOcr(next);
    },
    async findIdempotent(scope, keyHashHex) {
      const row = idempotency.get(composite(scope, keyHashHex));
      return row === undefined ? null : { ...row, payload: { ...row.payload } };
    },
    async claimIdempotent(scope, keyHashHex, row, at) {
      const key = composite(scope, keyHashHex);
      const existing = idempotency.get(key);
      // JS 单线程：下面的「检查 + 写入」之间没有 await，因此对并发调用方是原子的。
      if (existing !== undefined && existing.expiresAt.getTime() > at.getTime()) return 'exists';
      idempotency.set(key, { ...row, payload: { ...row.payload } });
      return 'claimed';
    },
    async finalizeIdempotent(scope, keyHashHex, payload) {
      const key = composite(scope, keyHashHex);
      const row = idempotency.get(key);
      if (row === undefined) return;
      idempotency.set(key, { ...row, payload: { ...payload }, pending: false });
    },
    async releaseIdempotent(scope, keyHashHex) {
      idempotency.delete(composite(scope, keyHashHex));
    },
    async purgeIdempotent(now) {
      let removed = 0;
      for (const [key, row] of idempotency) {
        if (row.expiresAt.getTime() <= now.getTime()) {
          idempotency.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
