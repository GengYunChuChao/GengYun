/**
 * GY-I12（#12）· 文字问答子域的**持久化端口**（store 接口 + 内存实现）。
 *
 * 设计纪律（沿用仓库既有 PG 方式，**不自建第二套连接池/迁移器**）：
 *  1. 端口只声明**语义**，SQL 集中在 `store-pg.ts`（它接的是 `app.ts` 已有的 `PgPool`，
 *     与 `knowledge/service.ts`、`privacy/ledger-pg.ts` 同一条缝；连接池仍然只有
 *     `services/api/src/server.ts` 那一处 `createPool`）；
 *  2. **CAS 口径与既有删除先例逐字对齐**：删改一律带 `expected_revision`，
 *     以「影响行数」判定成功，失败时用原因码（`NOT_FOUND` / `OWNER_CHANGED` /
 *     `REVISION_CHANGED`）折叠，**不**用 404/409 之外的第三套结果语言；
 *  3. 归属核对在**每一次**读写里做（`owner_id` 始终参与谓词）：别人的会话与不存在的会话
 *     对调用方**逐字节同形**（都是 `NOT_FOUND`），不泄露存在性；
 *  4. 内存实现是**测试/替身**，`persistent` 恒为 `false` —— 装配层据此在真实模式下
 *     拒交服务层（见 `app.ts` 的 real 模式 fail-closed 口径），不会"在真实模式下声称成功、
 *     重启即丢"。
 *
 * 作业状态：轮次行持有**受理时写下的作业快照**（`job_state` / `job_error_code` /
 * `job_deadline_at` / `job_created_at`）。它只在真发生状态跃迁时被更新
 * （`claimTurnJob` → 终态 `settleTurnJob`），且**每次跃迁都递增 `revision`** ——
 * `Turn.revision` 是契约强 ETag 的来源，状态变了而 revision 不变会让客户端拿到过期缓存。
 * 因此读面读到的永远是**已发生且已版本化**的状态，不是重新估算出来的值。
 */
import { randomUUID } from 'node:crypto';
import type {
  AnswerRecord,
  AnswerStatus,
  CheckState,
  Conditions,
  ConversationRecord,
  DoseCard,
  JobState,
  SourceRef,
  TurnRecord,
} from './types.ts';

/** CAS 结果（与 `history/store.ts` 的 `DeleteResult` 同口径）。 */
export type CasResult<T> =
  | { ok: true; record: T }
  | { ok: false; reason: 'NOT_FOUND' | 'OWNER_CHANGED' | 'REVISION_CHANGED' };

/** 轮次落库输入（`id` / `revision` / `created_at` 一律由服务端生成，调用方不能预置）。 */
export interface TurnInsert {
  id: string;
  conversation_id: string;
  owner_id: string;
  input_text: string;
  transcription_ref: { type: string; id: string; revision: number } | null;
  job_id: string;
  job_state: JobState;
  job_deadline_at: Date;
  job_created_at: Date;
  job_error_code: string | null;
  created_at: Date;
}

/** 回答落库输入（`revision` 恒为 1：本片不产生修订，故不提供 update）。 */
export interface AnswerInsert {
  id: string;
  turn_id: string;
  owner_id: string;
  status: AnswerStatus;
  checked_text: string;
  check_state: CheckState;
  citations: readonly SourceRef[];
  dose_cards: readonly DoseCard[];
  model_version: string;
  prompt_version: string;
  rule_version: string;
  created_at: Date;
}

/** 读出的轮次 = 轮次行 + 其回答（契约 `Turn.answer` 的来源；无回答即 `null`）。 */
export interface TurnWithAnswer {
  turn: TurnRecord;
  answer: AnswerRecord | null;
}

/** 列表分页的**位置**（排序口径与 `listConversations` 一致：`created_at DESC, id DESC`）。 */
export interface ListPosition {
  created_at: Date;
  id: string;
}

export interface ListOptions {
  limit: number;
  /** 游标锚点（不含则从首页开始）。 */
  after?: ListPosition | null;
}

/**
 * GY-I19（#19）· 受理事务内枚举用的最小 SQL 客户端（R28-C1b G6/G8 追加）。
 *
 * 与 `favorites/store.ts`、`history/store.ts`、`messages/store.ts` 的**同形状**定义
 * （各域自持一份，不跨域 import 别域的存储类型）：只用到 `query`。
 */
export interface BackupSnapshotClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ConversationStore {
  /** 存储是否为持久实现（real 模式必须持久，否则装配层不交服务层）。 */
  readonly persistent: boolean;
  insertConversation(record: ConversationRecord): Promise<ConversationRecord>;
  getConversation(id: string, ownerId: string): Promise<ConversationRecord | null>;
  listConversations(ownerId: string, options: ListOptions): Promise<ConversationRecord[]>;
  /** CAS 删除会话（其下轮次与回答由 PG 外键级联、由内存实现显式级联，二者语义一致）。 */
  deleteConversation(id: string, ownerId: string, expectedRevision: number): Promise<CasResult<ConversationRecord>>;
  insertTurn(record: TurnInsert): Promise<TurnRecord>;
  getTurn(conversationId: string, turnId: string, ownerId: string): Promise<TurnWithAnswer | null>;
  listTurns(conversationId: string, ownerId: string, options: ListOptions): Promise<TurnWithAnswer[]>;
  deleteTurn(conversationId: string, turnId: string, ownerId: string, expectedRevision: number): Promise<CasResult<TurnRecord>>;
  /** 受理后的状态跃迁：只允许从 `queued` 起（重复调用返回 `null`，不覆盖已发生的状态）。 */
  claimTurnJob(turnId: string, ownerId: string): Promise<TurnRecord | null>;
  /** 写入终态（+ 回答）：只有仍处于 `queued`/`running` 的轮次可被结算，其它一律 `null`。 */
  settleTurnJob(input: {
    turnId: string;
    ownerId: string;
    state: JobState;
    errorCode: string | null;
    answer: AnswerInsert | null;
    at: Date;
  }): Promise<TurnRecord | null>;
  getAnswer(answerId: string, ownerId: string): Promise<AnswerRecord | null>;
  /**
   * 按作业 id 反查轮次 + 回答（`GET /jobs/{id}` 的 `answer` 源用）。
   * **必须带 `ownerId`**：越权与不存在同形返回 `null`。
   */
  findTurnByJobId(jobId: string, ownerId: string): Promise<TurnWithAnswer | null>;
  /** 按主体清空（F13 注销清理协议用；返回**真实删除**的会话行数）。 */
  deleteAllByOwner(ownerId: string): Promise<number>;
  /**
   * GY-I19（#19）· **备份副本清单**原语（R28-C1b G6/G8 追加）：在受理事务内枚举该主体
   * 仍持有的**会话行 id**。
   *
   * 只回**不透明引用（行 id）**与计数：
   *   - ⛔ 不回问题正文、回答正文、引用片段、用量卡等任何内容字段（`conversation_answers`
   *     里存的是**模型生成的回答**，正文绝不能进清单/证据/日志）；
   *   - 只枚举 `conversations` 一张表：`conversation_turns.conversation_id` 与
   *     `conversation_answers.turn_id` 都是 `ON DELETE CASCADE`（`0013_conversations.sql:64,105`），
   *     所以「删掉这些会话」就等于「其下轮次与回答一并消失」——清单记会话 id 即覆盖三张表。
   *     漏记风险：若存在**没有会话行的孤儿轮次/回答**（外键 NOT NULL 已从结构上排除），它们不会
   *     出现在清单里；本域不产生这种行。
   * 必须用调用方给的 `client`（受理事务那条连接），否则清单与受理不在同一快照
   * （「行已删、清单漏记」会成为合法状态，设计 §6.1）。
   */
  snapshotOwner?(
    ownerId: string,
    client: BackupSnapshotClient,
  ): Promise<{ objectRefs: readonly string[]; records: number }>;
  /** 进程内测试/替身用：把当前所有行整形成快照（仅内存实现提供）。 */
  snapshot?(): {
    conversations: ConversationRecord[];
    turns: TurnRecord[];
    answers: AnswerRecord[];
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isAfter(record: { created_at: Date; id: string }, position: ListPosition): boolean {
  const delta = record.created_at.getTime() - position.created_at.getTime();
  if (delta !== 0) return delta < 0;
  return record.id < position.id;
}

function compareDescending(a: { created_at: Date; id: string }, b: { created_at: Date; id: string }): number {
  const delta = b.created_at.getTime() - a.created_at.getTime();
  if (delta !== 0) return delta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function materialiseAnswer(input: AnswerInsert): AnswerRecord {
  return {
    ...input,
    revision: 1,
    citations: clone([...input.citations]),
    dose_cards: clone([...input.dose_cards]),
    updated_at: input.created_at,
  };
}

/** 内存 store（测试/替身；`persistent: false`）。 */
export function createMemoryConversationStore(): ConversationStore {
  const conversations = new Map<string, ConversationRecord>();
  const turns = new Map<string, TurnRecord>();
  const answers = new Map<string, AnswerRecord>();

  function pageOf<T extends { created_at: Date; id: string }>(rows: T[], options: ListOptions): T[] {
    const after = options.after ?? null;
    const filtered = after === null ? rows : rows.filter((row) => isAfter(row, after));
    return filtered.sort(compareDescending).slice(0, options.limit).map(clone);
  }

  function answerOf(turn: TurnRecord): AnswerRecord | null {
    if (turn.answer_id === null) return null;
    const record = answers.get(turn.answer_id);
    return record === undefined ? null : clone(record);
  }

  return {
    persistent: false,
    async insertConversation(record) {
      conversations.set(record.id, clone(record));
      return clone(record);
    },
    async getConversation(id, ownerId) {
      const record = conversations.get(id);
      // 归属不符与不存在同形：都返回 null，调用方统一映射 NOT_FOUND。
      if (record === undefined || record.owner_id !== ownerId) return null;
      return clone(record);
    },
    async listConversations(ownerId, options) {
      const rows = [...conversations.values()].filter((row) => row.owner_id === ownerId);
      return pageOf(rows, options);
    },
    async deleteConversation(id, ownerId, expectedRevision) {
      const record = conversations.get(id);
      if (record === undefined || record.owner_id !== ownerId) return { ok: false, reason: 'NOT_FOUND' };
      if (record.revision !== expectedRevision) return { ok: false, reason: 'REVISION_CHANGED' };
      conversations.delete(id);
      // 显式级联：其下轮次与回答一并删除（与 PG 的 ON DELETE CASCADE 语义一致）。
      for (const [turnId, turn] of [...turns]) {
        if (turn.conversation_id !== id) continue;
        turns.delete(turnId);
        if (turn.answer_id !== null) answers.delete(turn.answer_id);
      }
      return { ok: true, record: clone(record) };
    },
    async insertTurn(record) {
      // 受理时落库：`revision` 从 1 起、尚无回答，`updated_at` 与受理时刻一致。
      const stored: TurnRecord = {
        id: record.id,
        revision: 1,
        conversation_id: record.conversation_id,
        owner_id: record.owner_id,
        input_text: record.input_text,
        transcription_ref: record.transcription_ref === null ? null : { ...record.transcription_ref },
        job_id: record.job_id,
        job_state: record.job_state,
        job_deadline_at: new Date(record.job_deadline_at),
        job_created_at: new Date(record.job_created_at),
        job_error_code: record.job_error_code,
        answer_id: null,
        created_at: new Date(record.created_at),
        updated_at: new Date(record.created_at),
      };
      turns.set(stored.id, clone(stored));
      return clone(stored);
    },
    async getTurn(conversationId, turnId, ownerId) {
      const record = turns.get(turnId);
      if (record === undefined) return null;
      if (record.conversation_id !== conversationId || record.owner_id !== ownerId) return null;
      return { turn: clone(record), answer: answerOf(record) };
    },
    async listTurns(conversationId, ownerId, options) {
      const rows = [...turns.values()].filter(
        (row) => row.conversation_id === conversationId && row.owner_id === ownerId,
      );
      return pageOf(rows, options).map((turn) => {
        const stored = turns.get(turn.id);
        return { turn, answer: stored === undefined ? null : answerOf(stored) };
      });
    },
    async deleteTurn(conversationId, turnId, ownerId, expectedRevision) {
      const record = turns.get(turnId);
      if (record === undefined || record.owner_id !== ownerId || record.conversation_id !== conversationId) {
        return { ok: false, reason: 'NOT_FOUND' };
      }
      if (record.revision !== expectedRevision) return { ok: false, reason: 'REVISION_CHANGED' };
      turns.delete(turnId);
      if (record.answer_id !== null) answers.delete(record.answer_id);
      return { ok: true, record: clone(record) };
    },
    async claimTurnJob(turnId, ownerId) {
      const record = turns.get(turnId);
      if (record === undefined || record.owner_id !== ownerId) return null;
      if (record.job_state !== 'queued') return null;
      // 状态跃迁必须递增 revision：`Turn.revision` 是强 ETag，状态变了 revision 不变
      // 会让持有旧 ETag 的客户端继续 CAS 成功（读到过期状态）。
      const next: TurnRecord = {
        ...record,
        revision: record.revision + 1,
        job_state: 'running',
        updated_at: new Date(),
      };
      turns.set(turnId, next);
      return clone(next);
    },
    async settleTurnJob(input) {
      const record = turns.get(input.turnId);
      if (record === undefined || record.owner_id !== input.ownerId) return null;
      if (record.job_state !== 'queued' && record.job_state !== 'running') return null;
      let answerId: string | null = record.answer_id;
      if (input.answer !== null) {
        const answer = materialiseAnswer(input.answer);
        answers.set(answer.id, answer);
        answerId = answer.id;
      }
      const next: TurnRecord = {
        ...record,
        revision: record.revision + 1,
        job_state: input.state,
        job_error_code: input.errorCode,
        answer_id: answerId,
        updated_at: input.at,
      };
      turns.set(input.turnId, next);
      return clone(next);
    },
    async getAnswer(answerId, ownerId) {
      const record = answers.get(answerId);
      if (record === undefined || record.owner_id !== ownerId) return null;
      return clone(record);
    },
    async findTurnByJobId(jobId, ownerId) {
      for (const turn of turns.values()) {
        if (turn.job_id !== jobId || turn.owner_id !== ownerId) continue;
        return { turn: clone(turn), answer: answerOf(turn) };
      }
      return null;
    },
    async deleteAllByOwner(ownerId) {
      let removed = 0;
      for (const [id, record] of [...conversations]) {
        if (record.owner_id !== ownerId) continue;
        conversations.delete(id);
        removed += 1;
        for (const [turnId, turn] of [...turns]) {
          if (turn.conversation_id !== id) continue;
          turns.delete(turnId);
          if (turn.answer_id !== null) answers.delete(turn.answer_id);
        }
      }
      return removed;
    },
    /**
     * 备份副本清单（GY-I19 G6/G8）：只回**会话行 id** 与计数，不回任何正文。
     * 内存实现没有事务，`client` 不参与（清单与受理在同一进程、同一同步临界区里读）。
     * 轮次/回答不出现在清单里：它们是会话的从属行，随会话一并删除（见接口注释的漏记风险说明）。
     */
    async snapshotOwner(ownerId) {
      const mine = [...conversations.values()].filter((record) => record.owner_id === ownerId);
      return { objectRefs: mine.map((record) => record.id), records: mine.length };
    },
    snapshot() {
      return {
        conversations: [...conversations.values()].map(clone),
        turns: [...turns.values()].map(clone),
        answers: [...answers.values()].map(clone),
      };
    },
  };
}

/** 服务端内部 id 生成（契约 uuid 形状；测试可注入确定性实现）。 */
export function defaultNewId(): string {
  return randomUUID();
}
