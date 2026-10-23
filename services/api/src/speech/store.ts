/**
 * GY-I11 录音转写任务存储（可插拔）。
 *
 * 本片只提供**内存实现**（进程内、可注入、用于本机与隔离回归）；持久化实现属后续任务，
 * 汇报与 PR 正文必须如实标注「转写任务与记录在内存 store，进程重启即丢失，未取得 PG 持久化证据」。
 * 内存 store **不是**替身提供者，也不伪造任何业务结论：它只保存记录与 CAS 版本。
 *
 * 幂等台账与 services/api 的认证幂等台账口径一致（键域 = 主体/方法/路径，key_hash 只存摘要，
 * request_hash 含请求体与 If-Match），但**独立存放**，不改动既有认证幂等存储。
 *
 * **原始输出不可变（本域特有的硬不变量）**：契约要求 `raw_text` 是模型原始输出，
 * 而 `confirmed_text` 是人的核对结果。为防止「确认覆写原始输出」这类事故，
 * `updateTranscription` 在存储层**拒绝**任何试图改变 `rawText` 或 `uncertainSpans` 的更新
 * （抛错而不是静默忽略）——这样 requirement「raw_text 与 confirmed_text 严格分离」
 * 就不只靠注释约定，而是由存储的不变量挡住。
 */
import type { ErrorCode } from '../contract.ts';
import { canTransitionJob, type JobState, type UncertainSpan } from './state.ts';

export interface SpeechJobRow {
  id: string;
  revision: number;
  kind: 'transcription';
  ownerUserId: string;
  transcriptionId: string;
  mediaId: string;
  mediaRevision: number;
  state: JobState;
  deadlineAt: Date;
  createdAt: Date;
  updatedAt: Date;
  errorCode: ErrorCode | null;
}

export interface TranscriptionRow {
  id: string;
  revision: number;
  ownerUserId: string;
  mediaId: string;
  mediaRevision: number;
  /** 模型原始输出：**任何用户核对都不得改写本字段**（存储层不变量，见文件头）。 */
  rawText: string;
  /** 提供者如实上报的不确定区间：**不得删改或补造**（存储层不变量，见文件头）。 */
  uncertainSpans: UncertainSpan[];
  /** 用户核对后的文本：与 `rawText` 严格分离，**不计入模型准确率**。未经核对为 null。 */
  confirmedText: string | null;
  confirmedAt: Date | null;
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
   * 并发重复请求（同键同体）必须据此等待占位者落定后**收敛**到同一结果，
   * 而不是重复执行副作用；false = 业务已完成，可安全回放 `payload`。
   */
  pending: boolean;
}

/** 记录变更函数：只允许写白名单字段（`rawText` / `uncertainSpans` 由存储不变量挡住）。 */
export type SpeechJobMutation = (row: SpeechJobRow) => SpeechJobRow;
export type TranscriptionMutation = (row: TranscriptionRow) => TranscriptionRow;

/**
 * 注销闭集（#19 延续片）· 语音域按主体清空的**分表**真实行数。
 *
 * `records` = 正文两表（转写任务 / 转写记录）删除行数之和；`idempotency` = 本域幂等台账删除行数
 * （含 `pending = true` 的未完成占位行）。
 * 两项都进在线清除证据（`<module>:online-purged:<records>` + `;<module>:idempotency-purged:<n>`）；
 * ⛔ 不把「只删了任务表」报成「语音域已清空」。
 *
 * 字段名与 `services/api/src/privacy/user-data-deletion.ts` 的 `OwnerPurgeCounts` 逐字一致，
 * 因此可以直接作为 `OwnerPurgeStore.purgeOwnerData` 的返回值（结构化兼容，不新增适配层）。
 */
export interface SpeechOwnerPurgeCounts {
  records: number;
  idempotency: number;
}

export interface SpeechStore {
  readonly persistent: boolean;
  insertJob(row: SpeechJobRow): Promise<void>;
  getJob(jobId: string): Promise<SpeechJobRow | null>;
  /** CAS：revision 不一致返回 null（不覆盖他人并发写）。 */
  updateJob(jobId: string, expectedRevision: number, mutate: SpeechJobMutation): Promise<SpeechJobRow | null>;
  /**
   * 原子提交终态：同一临界区内校验 CAS 与合法迁移，写转写记录（可为 null）并落任务终态。
   * CAS 失败（任务已被取消/已终态）返回 null，且**不写任何记录** —— 旧回调不复活任务。
   */
  commitTerminal(
    jobId: string,
    expectedRevision: number,
    terminal: { state: JobState; errorCode: ErrorCode | null },
    transcription: TranscriptionRow | null,
    at: Date,
  ): Promise<SpeechJobRow | null>;
  insertTranscription(row: TranscriptionRow): Promise<void>;
  getTranscription(transcriptionId: string): Promise<TranscriptionRow | null>;
  /**
   * CAS 更新。除 CAS 外还强制**原始输出不可变**：若 mutate 返回的行改变了 `rawText`
   * 或 `uncertainSpans`，直接抛错（视为内部不变量被破坏），绝不静默接受。
   */
  updateTranscription(
    transcriptionId: string,
    expectedRevision: number,
    mutate: TranscriptionMutation,
  ): Promise<TranscriptionRow | null>;
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
   * 占位者**放弃**占位（业务在 finalize 前失败，如版本冲突 / 落库失败）。
   * 必须释放：否则失败的首次请求会留下永久 pending，使同一 Idempotency-Key 的正常重试
   * 一直拿到 REQUEST_IN_PROGRESS。仅占位者有权调用。
   */
  releaseIdempotent(scope: string, keyHashHex: string): Promise<void>;
  /** 物理删除已到期台账条目。 */
  purgeIdempotent(now: Date): Promise<number>;
  /**
   * **注销按主体清空**（#19 延续片）：删掉该主体在本域**全部**行
   * （转写任务 / 转写记录 / 幂等台账），返回分表真实行数。
   *
   * 只由 `services/api/src/privacy/user-data-deletion.ts` 的注销处理器调用，**不注册任何契约路由**。
   * 顺序由迁移 `0026_speech_persistence.sql` 决定：两张正文表各自 `owner_user_id → users` CASCADE、
   * 互相**没有**外键 ⇒ 任务先于其产物（业务语义）；幂等台账按 `scope` 首段主体前缀精确删。
   *
   * ⛔ 缺这个方法就是「本域不可按主体清空」：装配处必须让它**调用即失败**（折叠 blocked），
   * 不得静默跳过、更不得假装已清。
   */
  purgeOwnerData?(ownerId: string): Promise<SpeechOwnerPurgeCounts>;
  /** 同一清理的窄口径（只回正文行数）；`purgeOwnerData` 可用时优先后者。 */
  deleteAllByOwner?(ownerId: string): Promise<number>;
}

function cloneSpan(span: UncertainSpan): UncertainSpan {
  return { start: span.start, end: span.end, reason: span.reason };
}

function cloneJob(row: SpeechJobRow): SpeechJobRow {
  return { ...row };
}

function cloneTranscription(row: TranscriptionRow): TranscriptionRow {
  return { ...row, uncertainSpans: row.uncertainSpans.map(cloneSpan) };
}

/** 区间序列是否逐项相同（含顺序）：用于「不得删改或补造」的存储不变量判定。 */
export function sameSpans(left: readonly UncertainSpan[], right: readonly UncertainSpan[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((span, index) => {
    const other = right[index];
    return (
      other !== undefined && span.start === other.start && span.end === other.end && span.reason === other.reason
    );
  });
}

export function createMemorySpeechStore(): SpeechStore {
  const jobs = new Map<string, SpeechJobRow>();
  const transcriptions = new Map<string, TranscriptionRow>();
  const idempotency = new Map<string, IdempotencyRow>();
  const composite = (scope: string, keyHashHex: string): string => `${scope}\u0000${keyHashHex}`;

  /**
   * 按主体清空（#19 延续片）· 内存实现。
   *
   * 与 PG 实现的口径必须一致（否则 stub/preset_demo 与 real 的证据串读数不可比）：
   * 正文行 = 转写任务 + 转写记录；台账 = 完成回执 + 未完成占位（PG 里是同一张表的两种行）。
   * 顺序先任务后记录（业务语义：任务产记录），与 `0026` 的外键方向不冲突（两表无 FK）。
   */
  function purgeOwnerRows(ownerId: string): SpeechOwnerPurgeCounts {
    let records = 0;
    for (const [id, row] of jobs) {
      if (row.ownerUserId !== ownerId) continue;
      jobs.delete(id);
      records += 1;
    }
    for (const [id, row] of transcriptions) {
      if (row.ownerUserId !== ownerId) continue;
      transcriptions.delete(id);
      records += 1;
    }
    let idleRemoved = 0;
    // 台账按**主体前缀**清：key = `scope + "\u0000" + keyHash`，scope 首段恒为主体
    // （`<主体>\n<METHOD>\n<路径>`），所以前缀是 `<主体>\n`（⛔ 不是 `\u0000` —— 那是 scope 与
    // keyHash 的分隔符，拿它当前缀会一条都不匹配，把"漏清台账"变成静默通过）。
    // 与 PG 的 `left(scope, char_length($1::text) + 1) = $1::text || chr(10)` 逐字等价。
    for (const key of [...idempotency.keys()]) {
      if (!key.startsWith(`${ownerId}\n`)) continue;
      idempotency.delete(key);
      idleRemoved += 1;
    }
    return { records, idempotency: idleRemoved };
  }

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
    async commitTerminal(jobId, expectedRevision, terminal, transcription, at) {
      const row = jobs.get(jobId);
      if (row === undefined || row.revision !== expectedRevision) return null;
      // 终态迁移必须合法：已被取消/已终态的任务不会被迟到结果改写。
      if (!canTransitionJob(row.state, terminal.state)) return null;
      if (transcription !== null && transcriptions.has(transcription.id)) throw new Error('转写记录 id 冲突');
      if (transcription !== null) transcriptions.set(transcription.id, cloneTranscription(transcription));
      const next: SpeechJobRow = {
        ...cloneJob(row),
        state: terminal.state,
        errorCode: terminal.errorCode,
        revision: row.revision + 1,
        updatedAt: at,
      };
      jobs.set(jobId, cloneJob(next));
      return cloneJob(next);
    },
    async insertTranscription(row) {
      if (transcriptions.has(row.id)) throw new Error('转写记录 id 冲突');
      transcriptions.set(row.id, cloneTranscription(row));
    },
    async getTranscription(transcriptionId) {
      const row = transcriptions.get(transcriptionId);
      return row === undefined ? null : cloneTranscription(row);
    },
    async updateTranscription(transcriptionId, expectedRevision, mutate) {
      const row = transcriptions.get(transcriptionId);
      if (row === undefined || row.revision !== expectedRevision) return null;
      const next = mutate(cloneTranscription(row));
      // 原始输出不可变：确认/其他任何更新都不得改写 raw_text 与 uncertain_spans。
      if (next.rawText !== row.rawText || !sameSpans(next.uncertainSpans, row.uncertainSpans)) {
        throw new Error('转写记录的 raw_text / uncertain_spans 不可改写（存储层不变量）');
      }
      transcriptions.set(transcriptionId, cloneTranscription(next));
      return cloneTranscription(next);
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
    async purgeOwnerData(ownerId) {
      return purgeOwnerRows(ownerId);
    },
    async deleteAllByOwner(ownerId) {
      return purgeOwnerRows(ownerId).records;
    },
  };
}
