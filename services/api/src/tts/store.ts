/**
 * GY-I13 普通话 TTS 合成域 · 任务与记录存储（可插拔）。
 *
 * 本片只提供**内存实现**（进程内、可注入、用于本机与隔离回归）；持久化实现属后续任务，
 * 汇报与 PR 正文必须如实标注「合成任务、记录与幂等台账在内存 store，进程重启即丢失，
 * 未取得 PG 持久化证据」。内存 store **不是**替身提供者，也不伪造任何业务结论：
 * 它只保存记录与 CAS 版本。
 *
 * 存储层不变量：
 * - 终态提交在同一临界区内校验 CAS（revision）与合法迁移（`job_transitions`），
 *   CAS 失败或迁移非法 ⇒ 返回 null 且**不写任何记录**（迟到的提供者结果不复活任务）；
 * - 记录 id 冲突直接抛错（不覆盖已有合成记录）；
 * - 记录里**没有**任何自由文本字段：本域不保存「将要朗读的文本」，
 *   只保存已核对目标引用（type/id/revision）与产物 media_id——
 *   文本永远来自核对源，不落在本域。
 *
 * 幂等台账与 `services/api` 的认证幂等台账口径一致（键域 = 主体/方法/路径，key_hash 只存摘要，
 * request_hash 含请求体），但**独立存放**，不改动既有认证幂等存储。
 */

import type { ErrorCode } from '../contract.ts';
import { canTransitionJob, type JobState, type SynthesisTargetRef } from './state.ts';

export interface SynthesisJobRow {
  id: string;
  revision: number;
  kind: 'synthesis';
  ownerUserId: string;
  /** 本次任务将要/已经产出的合成记录 id（占位前生成，作为幂等占位的原子凭据）。 */
  synthesisId: string;
  /** 已核对目标引用：任务与结果共用同一个（结果必须属于同一 target_ref 与 revision）。 */
  checkedContentRef: SynthesisTargetRef;
  locale: string;
  state: JobState;
  deadlineAt: Date;
  createdAt: Date;
  updatedAt: Date;
  errorCode: ErrorCode | null;
}

export interface SynthesisRow {
  id: string;
  revision: number;
  ownerUserId: string;
  /** 实际用于合成的 revision（= 执行期重读并判定的那个 revision）。 */
  checkedContentRef: SynthesisTargetRef;
  mediaId: string;
  /** true = media_id 指向替身标注产物，**不是**真实音频（不进契约 `Synthesis` 投影，只进内部记录与诊断）。 */
  substitute: boolean;
  providerVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IdempotencyRow {
  requestHash: string;
  expiresAt: Date;
  /** 只存**不含凭据**的结果引用（如 job_id）。 */
  payload: Record<string, unknown>;
  /**
   * true = 已**原子占位**但业务尚未完成。
   * 并发重复请求（同键同体）必须据此等待占位者落定后**收敛**到同一结果，
   * 而不是重复执行副作用；false = 业务已完成，可安全回放 `payload`。
   */
  pending: boolean;
}

export type SynthesisJobMutation = (row: SynthesisJobRow) => SynthesisJobRow;

export interface SynthesisStore {
  readonly persistent: boolean;
  insertJob(row: SynthesisJobRow): Promise<void>;
  getJob(jobId: string): Promise<SynthesisJobRow | null>;
  /** CAS：revision 不一致返回 null（不覆盖他人并发写）。 */
  updateJob(jobId: string, expectedRevision: number, mutate: SynthesisJobMutation): Promise<SynthesisJobRow | null>;
  /**
   * 原子提交终态：同一临界区内校验 CAS 与合法迁移，写合成记录（可为 null）并落任务终态。
   * CAS 失败（任务已终态）返回 null，且**不写任何记录** —— 晚到的结果不复活任务。
   */
  commitTerminal(
    jobId: string,
    expectedRevision: number,
    terminal: { state: JobState; errorCode: ErrorCode | null },
    synthesis: SynthesisRow | null,
    at: Date,
  ): Promise<SynthesisJobRow | null>;
  insertSynthesis(row: SynthesisRow): Promise<void>;
  getSynthesis(synthesisId: string): Promise<SynthesisRow | null>;
  findIdempotent(scope: string, keyHashHex: string): Promise<IdempotencyRow | null>;
  /**
   * **原子占位**（先占位再建任务，消除 check-then-act 竞态）：
   * 同一 (scope, keyHash) 只允许**首个**调用方拿到 `claimed`；其余并发调用方一律 `exists`。
   * 已到期条目视同不存在，允许重新占位。
   * 实现必须「检查 + 写入」在同一同步临界区内完成，中间**不得** await。
   */
  claimIdempotent(scope: string, keyHashHex: string, row: IdempotencyRow, at: Date): Promise<'claimed' | 'exists'>;
  /** 占位者完成业务后写入最终结果引用，并把 pending 置为 false。 */
  finalizeIdempotent(scope: string, keyHashHex: string, payload: Record<string, unknown>): Promise<void>;
  /**
   * 占位者**放弃**占位（业务在 finalize 前失败，如落库失败）。
   * 必须释放：否则失败的首次请求会留下永久 pending，使同一 Idempotency-Key 的正常重试
   * 一直拿到 REQUEST_IN_PROGRESS。仅占位者有权调用。
   */
  releaseIdempotent(scope: string, keyHashHex: string): Promise<void>;
  /** 物理删除已到期台账条目。 */
  purgeIdempotent(now: Date): Promise<number>;
}

function cloneJob(row: SynthesisJobRow): SynthesisJobRow {
  return { ...row, checkedContentRef: { ...row.checkedContentRef } };
}

function cloneSynthesis(row: SynthesisRow): SynthesisRow {
  return { ...row, checkedContentRef: { ...row.checkedContentRef } };
}

export function createMemorySynthesisStore(): SynthesisStore {
  const jobs = new Map<string, SynthesisJobRow>();
  const syntheses = new Map<string, SynthesisRow>();
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
    async commitTerminal(jobId, expectedRevision, terminal, synthesis, at) {
      const row = jobs.get(jobId);
      if (row === undefined || row.revision !== expectedRevision) return null;
      // 终态迁移必须合法：已终态的任务不会被迟到结果改写。
      if (!canTransitionJob(row.state, terminal.state)) return null;
      if (synthesis !== null && syntheses.has(synthesis.id)) throw new Error('合成记录 id 冲突');
      if (synthesis !== null) syntheses.set(synthesis.id, cloneSynthesis(synthesis));
      const next: SynthesisJobRow = {
        ...cloneJob(row),
        state: terminal.state,
        errorCode: terminal.errorCode,
        revision: row.revision + 1,
        updatedAt: at,
      };
      jobs.set(jobId, cloneJob(next));
      return cloneJob(next);
    },
    async insertSynthesis(row) {
      if (syntheses.has(row.id)) throw new Error('合成记录 id 冲突');
      syntheses.set(row.id, cloneSynthesis(row));
    },
    async getSynthesis(synthesisId) {
      const row = syntheses.get(synthesisId);
      return row === undefined ? null : cloneSynthesis(row);
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
