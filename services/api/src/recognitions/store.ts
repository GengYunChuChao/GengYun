/**
 * GY-I09 识别任务存储（可插拔）。
 *
 * 本片只提供**内存实现**（进程内、可注入、用于本机与隔离回归）；持久化实现属后续任务，
 * 证据文档与 PR 正文必须如实标注「识别任务在内存 store，进程重启即丢失，未取得 PG 持久化证据」。
 * 内存 store **不是**替身提供者，也不伪造任何业务结论：它只保存记录与 CAS 版本。
 *
 * 幂等台账与 services/api 的认证幂等台账口径一致（键域 = 主体/方法/路径，key_hash 只存摘要，
 * request_hash 含请求体与 If-Match），但**独立存放**，不改动 GY-I04 的认证幂等存储。
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
  findIdempotent(scope: string, keyHashHex: string): Promise<IdempotencyRow | null>;
  putIdempotent(scope: string, keyHashHex: string, row: IdempotencyRow): Promise<void>;
  /** 物理删除已到期台账条目。 */
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
    async findIdempotent(scope, keyHashHex) {
      const row = idempotency.get(composite(scope, keyHashHex));
      return row === undefined ? null : { ...row, payload: { ...row.payload } };
    },
    async putIdempotent(scope, keyHashHex, row) {
      idempotency.set(composite(scope, keyHashHex), { ...row, payload: { ...row.payload } });
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
