/**
 * GY-I09 识别任务存储（可插拔）。
 *
 * 本片只提供**内存实现**（进程内、可注入、用于本机与隔离回归）；持久化实现属后续任务，
 * 证据文档与 PR 正文必须如实标注「识别任务在内存 store，进程重启即丢失，未取得 PG 持久化证据」。
 * 内存 store **不是**替身提供者，也不伪造任何业务结论：它只保存记录与 CAS 版本。
 *
 * 幂等台账与 services/api 的认证幂等台账口径一致（键域 = 主体/方法/路径，key_hash 只存摘要，
 * request_hash 含请求体与 If-Match），但**独立存放**，不改动 GY-I04 的认证幂等存储。
 *
 * 并发收敛（监工 review 5483726169 [P1]）：写路径必须用 `claimIdempotent` 做**原子单飞占位**，
 * 「查回执 → 占位 → 建任务 → 写回执」之间不得给同键请求留下第二个入口；同键异体一律 `conflict`。
 */
import type { ErrorCode } from '../contract.ts';
import { canTransitionJob, type Candidate, type JobState } from './state.ts';

export interface JobRow {
  id: string;
  revision: number;
  kind: 'recognition';
  ownerUserId: string;
  recognitionId: string;
  mediaId: string;
  mediaRevision: number;
  state: JobState;
  deadlineAt: Date;
  createdAt: Date;
  updatedAt: Date;
  errorCode: ErrorCode | null;
}

export interface RecognitionRow {
  id: string;
  revision: number;
  ownerUserId: string;
  mediaId: string;
  mediaRevision: number;
  candidates: Candidate[];
  uncertaintyReasons: string[];
  selectedSpeciesId: string | null;
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
}

/** 原子占位输入：请求摘要 + 占位到期时刻 + 判定到期用的当前时刻。 */
export interface IdempotencyClaimInput {
  requestHash: string;
  expiresAt: Date;
  now: Date;
}

/**
 * 原子占位结果（同主体同键的并发收敛）：
 * - `claimed`：本次调用占位成功，**只有它**可以进入创建/写入流程；
 * - `completed`：已有完成回执 → 调用方按回执重放（同键同体）；
 * - `in_progress`：同键同体请求正在处理 → 调用方有界等待其回执后重放；
 * - `conflict`：同键已被**不同请求体**占用 → 必须 `IDEMPOTENCY_CONFLICT`。
 */
export type IdempotencyClaimResult =
  | { status: 'claimed' }
  | { status: 'completed'; row: IdempotencyRow }
  | { status: 'in_progress' }
  | { status: 'conflict' };

/** 记录变更函数：只允许写白名单字段，避免调用方整体覆盖（防 selection 回写模型字段）。 */
export type JobMutation = (row: JobRow) => JobRow;
export type RecognitionMutation = (row: RecognitionRow) => RecognitionRow;

export interface RecognitionStore {
  readonly persistent: boolean;
  insertJob(row: JobRow): Promise<void>;
  getJob(jobId: string): Promise<JobRow | null>;
  /** CAS：revision 不一致返回 null（不覆盖他人并发写）。 */
  updateJob(jobId: string, expectedRevision: number, mutate: JobMutation): Promise<JobRow | null>;
  /**
   * 原子提交终态：同一临界区内校验 CAS 与合法迁移，写识别记录（可为 null）并落任务终态。
   * CAS 失败（任务已被取消/已终态）返回 null，且**不写任何记录** —— 旧回调不复活任务。
   */
  commitTerminal(
    jobId: string,
    expectedRevision: number,
    terminal: { state: JobState; errorCode: ErrorCode | null },
    recognition: RecognitionRow | null,
    at: Date,
  ): Promise<JobRow | null>;
  insertRecognition(row: RecognitionRow): Promise<void>;
  getRecognition(recognitionId: string): Promise<RecognitionRow | null>;
  updateRecognition(recognitionId: string, expectedRevision: number, mutate: RecognitionMutation): Promise<RecognitionRow | null>;
  /**
   * 原子占位（单飞）：查回执与写入占位在**同一临界区**内完成，因此同主体同键的并发请求
   * 只有一个拿到 `claimed`，其余得到 `completed`/`in_progress`/`conflict`，
   * **不可能**各自创建一份任务（监工 review 5483726169 [P1]）。
   */
  claimIdempotent(scope: string, keyHashHex: string, input: IdempotencyClaimInput): Promise<IdempotencyClaimResult>;
  /** 写入完成回执并释放同键占位（同一临界区）。 */
  completeIdempotent(scope: string, keyHashHex: string, row: IdempotencyRow): Promise<void>;
  /** 放弃占位（写入流程失败），只删占位、不动已有回执。 */
  releaseIdempotent(scope: string, keyHashHex: string): Promise<void>;
  /** 物理删除已到期的回执与占位。 */
  purgeIdempotent(now: Date): Promise<number>;
}

function cloneJob(row: JobRow): JobRow {
  return { ...row };
}

function cloneRecognition(row: RecognitionRow): RecognitionRow {
  return {
    ...row,
    candidates: row.candidates.map((item) => ({ ...item })),
    uncertaintyReasons: [...row.uncertaintyReasons],
  };
}

export function createMemoryRecognitionStore(): RecognitionStore {
  const jobs = new Map<string, JobRow>();
  const recognitions = new Map<string, RecognitionRow>();
  const idempotency = new Map<string, IdempotencyRow>();
  /** 单飞占位：`claimed` 只在占位存在期间唯一，完成回执写入时释放。 */
  const claims = new Map<string, { requestHash: string; expiresAt: Date }>();
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
    async commitTerminal(jobId, expectedRevision, terminal, recognition, at) {
      const row = jobs.get(jobId);
      if (row === undefined || row.revision !== expectedRevision) return null;
      // 终态迁移必须合法：已被取消/已终态的任务不会被迟到结果改写。
      if (!canTransitionJob(row.state, terminal.state)) return null;
      if (recognition !== null && recognitions.has(recognition.id)) throw new Error('识别记录 id 冲突');
      if (recognition !== null) recognitions.set(recognition.id, cloneRecognition(recognition));
      const next: JobRow = {
        ...cloneJob(row),
        state: terminal.state,
        errorCode: terminal.errorCode,
        revision: row.revision + 1,
        updatedAt: at,
      };
      jobs.set(jobId, cloneJob(next));
      return cloneJob(next);
    },
    async insertRecognition(row) {
      if (recognitions.has(row.id)) throw new Error('识别记录 id 冲突');
      recognitions.set(row.id, cloneRecognition(row));
    },
    async getRecognition(recognitionId) {
      const row = recognitions.get(recognitionId);
      return row === undefined ? null : cloneRecognition(row);
    },
    async updateRecognition(recognitionId, expectedRevision, mutate) {
      const row = recognitions.get(recognitionId);
      if (row === undefined || row.revision !== expectedRevision) return null;
      const next = mutate(cloneRecognition(row));
      recognitions.set(recognitionId, cloneRecognition(next));
      return cloneRecognition(next);
    },
    async claimIdempotent(scope, keyHashHex, input) {
      const key = composite(scope, keyHashHex);
      const nowMs = input.now.getTime();
      // 先物理清理同键的过期回执/占位，避免过期条目永久占用唯一键。
      const completed = idempotency.get(key);
      if (completed !== undefined && completed.expiresAt.getTime() <= nowMs) idempotency.delete(key);
      const pending = claims.get(key);
      if (pending !== undefined && pending.expiresAt.getTime() <= nowMs) claims.delete(key);

      const existing = idempotency.get(key);
      if (existing !== undefined) {
        if (existing.requestHash !== input.requestHash) return { status: 'conflict' };
        return { status: 'completed', row: { ...existing, payload: { ...existing.payload } } };
      }
      const active = claims.get(key);
      if (active !== undefined) {
        // 同键异体并发：立即明确冲突，绝不放行第二个任务。
        if (active.requestHash !== input.requestHash) return { status: 'conflict' };
        return { status: 'in_progress' };
      }
      // 查回执与写占位在同一同步临界区内完成 → 同主体同键并发只有一个 claimed。
      claims.set(key, { requestHash: input.requestHash, expiresAt: input.expiresAt });
      return { status: 'claimed' };
    },
    async completeIdempotent(scope, keyHashHex, row) {
      const key = composite(scope, keyHashHex);
      idempotency.set(key, { ...row, payload: { ...row.payload } });
      claims.delete(key);
    },
    async releaseIdempotent(scope, keyHashHex) {
      claims.delete(composite(scope, keyHashHex));
    },
    async purgeIdempotent(now) {
      let removed = 0;
      for (const [key, row] of idempotency) {
        if (row.expiresAt.getTime() <= now.getTime()) {
          idempotency.delete(key);
          removed += 1;
        }
      }
      for (const [key, claim] of claims) {
        if (claim.expiresAt.getTime() <= now.getTime()) {
          claims.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
