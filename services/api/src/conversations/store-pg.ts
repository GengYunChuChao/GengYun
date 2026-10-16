/**
 * GY-I12（#12）· 文字问答子域的 **PostgreSQL 实现**（迁移 `0013_conversations.sql`）。
 *
 * 连接方式**沿用仓库既有 PG 方式**，没有任何第二套连接池或迁移器：
 *   - 本文件接的是 `app.ts` 已有的 `PgPool`（唯一构造点是 `services/api/src/server.ts`
 *     的 `createPool`），事务模式抄 `knowledge/service.ts`：
 *     `pool.connect()` → `BEGIN` → `SET LOCAL lock_timeout = '4s'` → 业务 SQL → `COMMIT`
 *     （异常 `ROLLBACK`；`57014` 语句超时 / `55P03` 锁不可得 ⇒ `PROVIDER_TIMEOUT`，
 *     其余数据库异常 ⇒ `PROVIDER_UNAVAILABLE`，与资料域同口径）；
 *   - 迁移只写 `services/api/db/migrations/0013_conversations.sql`，由仓库**唯一**的
 *     运行器 `services/api/src/db/migrate.ts` 执行（找不到 DATABASE_URL 即明确失败）；
 *   - 幂等台账口径**沿用** `auth/idempotency.ts` 的 scope = `<主体>\n<METHOD>\n<路径>` 与
 *     HMAC 请求摘要（不另造摘要算法）；但台账**本片是进程内实现**（见 `service.ts` 的
 *     `ConversationIdempotencyLedger`）：0008 的 `idempotency_keys` 表的 `outcome` 联合类型
 *     被既有断言逐字锁住（`tests/unit/auth-store-pg.test.mjs`），本片**不得**改动它，
 *     故不在此表里追加问答类结果引用。该切出项在交接中如实登记。
 *
 * 删除级联：三张表的外键是 `ON DELETE CASCADE`（会话 → 轮次 → 回答）；
 *   CAS 删除仍带 `expected_revision`，以 `rowCount` 判定成功/失败原因。
 */
import { ApiError } from '../errors.ts';
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
import type {
  AnswerInsert,
  CasResult,
  ConversationStore,
  ListOptions,
  TurnInsert,
  TurnWithAnswer,
} from './store.ts';

/** `pg` 连接池/连接的最小形状（与 `db/pool.ts` 的 `PgPool` 结构兼容）。 */
export interface SqlRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PgConnection extends SqlRunner {
  release(): void;
}

/** 带事务能力的连接池（`PgPool` 结构兼容；测试可传 PGlite 适配器）。 */
export interface TransactionalPool extends SqlRunner {
  connect(): Promise<PgConnection>;
}

/** 数据库异常的契约化折叠（与 `knowledge/service.ts` 逐条同口径）。 */
export function classifyConversationDatabaseError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['57014', '55P03'].includes(code)) {
    throw new ApiError('PROVIDER_TIMEOUT', '问答数据库响应超时', { retryable: true });
  }
  if (error instanceof ApiError) throw error;
  throw new ApiError('PROVIDER_UNAVAILABLE', '问答数据库暂不可用', { retryable: true });
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  return value;
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

const CONVERSATION_COLUMNS = 'id, owner_id, revision, conditions, created_at, updated_at';
const TURN_COLUMNS =
  'id, conversation_id, owner_id, revision, input_text, transcription_ref, job_id, job_state, ' +
  'job_deadline_at, job_created_at, job_error_code, answer_id, created_at, updated_at';
const ANSWER_COLUMNS =
  'id, turn_id, owner_id, revision, status, checked_text, check_state, citations, dose_cards, ' +
  'model_version, prompt_version, rule_version, created_at, updated_at';

function toConversation(row: Record<string, unknown>): ConversationRecord {
  return {
    id: String(row['id']),
    owner_id: String(row['owner_id']),
    revision: Number(row['revision']),
    conditions: (parseJson(row['conditions']) as Conditions | null) ?? null,
    created_at: asDate(row['created_at']),
    updated_at: asDate(row['updated_at']),
  };
}

function toTurn(row: Record<string, unknown>): TurnRecord {
  const ref = parseJson(row['transcription_ref']);
  return {
    id: String(row['id']),
    conversation_id: String(row['conversation_id']),
    owner_id: String(row['owner_id']),
    revision: Number(row['revision']),
    input_text: String(row['input_text']),
    transcription_ref: (ref as TurnRecord['transcription_ref']) ?? null,
    job_id: String(row['job_id']),
    job_state: String(row['job_state']) as JobState,
    job_deadline_at: asDate(row['job_deadline_at']),
    job_created_at: asDate(row['job_created_at']),
    job_error_code: row['job_error_code'] === null || row['job_error_code'] === undefined
      ? null
      : String(row['job_error_code']),
    answer_id: row['answer_id'] === null || row['answer_id'] === undefined ? null : String(row['answer_id']),
    created_at: asDate(row['created_at']),
    updated_at: asDate(row['updated_at']),
  };
}

function toAnswer(row: Record<string, unknown>): AnswerRecord {
  return {
    id: String(row['id']),
    turn_id: String(row['turn_id']),
    owner_id: String(row['owner_id']),
    revision: Number(row['revision']),
    status: String(row['status']) as AnswerStatus,
    checked_text: String(row['checked_text']),
    check_state: String(row['check_state']) as CheckState,
    citations: (parseJson(row['citations']) as SourceRef[] | null) ?? [],
    dose_cards: (parseJson(row['dose_cards']) as DoseCard[] | null) ?? [],
    model_version: String(row['model_version']),
    prompt_version: String(row['prompt_version']),
    rule_version: String(row['rule_version']),
    created_at: asDate(row['created_at']),
    updated_at: asDate(row['updated_at']),
  };
}

/** 在一个事务里跑一段逻辑（异常统一走 `classifyConversationDatabaseError`）。 */
async function withTransaction<T>(pool: TransactionalPool, run: (sql: SqlRunner) => Promise<T>): Promise<T> {
  let connection: PgConnection | null = null;
  try {
    connection = await pool.connect();
    const sql: SqlRunner = connection;
    await sql.query('BEGIN');
    // 与资料读面同一道闸：锁等待超过 4s 即放弃（不允许一个请求把行锁拖到请求超时）。
    await sql.query("SET LOCAL lock_timeout = '4s'");
    const result = await run(sql);
    await sql.query('COMMIT');
    return result;
  } catch (error) {
    if (connection !== null) {
      try {
        await connection.query('ROLLBACK');
      } catch {
        // 回滚失败不掩盖原始错误（连接即将归还，池会自行清理）。
      }
    }
    return classifyConversationDatabaseError(error);
  } finally {
    connection?.release();
  }
}

/**
 * 新建持久 store。
 *
 * `subjectGuard` 是**可选**的主体核对口：给定 `{userId, authEpoch}` 在**同一事务**里
 * 核对 `public.users.state='active'` 与 `public.sessions`（audience='user'、未撤销未过期）。
 * 不注入 ⇒ 不做该核对（调用方自己保证身份来自服务端权威会话；`auth/middleware.ts`
 * 的 `readIdentity` 在 `guards.requireUser` 之后永不抛错）。
 */
export function createPostgresConversationStore(
  pool: TransactionalPool,
  options: { subjectGuard?: (sql: SqlRunner, input: { userId: string; authEpoch: number }) => Promise<void> } = {},
): ConversationStore {
  const guard = options.subjectGuard;

  async function guarded<T>(run: (sql: SqlRunner) => Promise<T>, subject?: { userId: string; authEpoch: number }): Promise<T> {
    return withTransaction(pool, async (sql) => {
      if (guard !== undefined && subject !== undefined) await guard(sql, subject);
      return run(sql);
    });
  }

  /** keyset 分页谓词（`created_at DESC, id DESC`）：与内存实现 `isAfter` 逐项对应。 */
  function listWhere(alias: string, options: ListOptions, params: unknown[]): string {
    const after = options.after ?? null;
    if (after === null) return '';
    params.push(after.created_at, after.id);
    const at = `$${params.length - 1}`;
    const id = `$${params.length}`;
    return ` AND (${alias}.created_at < ${at}::timestamptz OR (${alias}.created_at = ${at}::timestamptz AND ${alias}.id < ${id}::uuid))`;
  }

  /** 读一条回答（`getTurn` / `listTurns` 组装 `Turn.answer` 时复用）。 */
  async function readAnswer(answerId: string, ownerId: string): Promise<AnswerRecord | null> {
    const { rows } = await pool.query(
      `SELECT ${ANSWER_COLUMNS} FROM conversation_answers WHERE id = $1::uuid AND owner_id = $2::uuid`,
      [answerId, ownerId],
    );
    const row = rows[0];
    return row === undefined ? null : toAnswer(row);
  }

  return {
    persistent: true,

    // -----------------------------------------------------------------------
    // 会话
    // -----------------------------------------------------------------------
    async insertConversation(record) {
      const { rows } = await pool.query(
        `INSERT INTO conversations (id, owner_id, revision, conditions, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $5)
         RETURNING ${CONVERSATION_COLUMNS}`,
        [record.id, record.owner_id, record.revision, record.conditions === null ? null : JSON.stringify(record.conditions), record.created_at],
      );
      const row = rows[0];
      // 写库未返回结果行 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
      if (row === undefined) throw new ApiError('PROVIDER_UNAVAILABLE', '问答数据库未返回写入结果', { retryable: false });
      return toConversation(row);
    },

    async getConversation(id, ownerId) {
      const { rows } = await pool.query(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = $1::uuid AND owner_id = $2::uuid`,
        [id, ownerId],
      );
      const row = rows[0];
      return row === undefined ? null : toConversation(row);
    },

    async listConversations(ownerId, options) {
      const params: unknown[] = [ownerId, options.limit];
      const where = listWhere('conversations', options, params);
      const { rows } = await pool.query(
        `SELECT ${CONVERSATION_COLUMNS} FROM conversations
         WHERE owner_id = $1::uuid${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        params,
      );
      return rows.map(toConversation);
    },

    async deleteConversation(id, ownerId, expectedRevision) {
      // 先读再 CAS：读取同时给出「不存在/他人」与「版本不符」两类原因，
      // 且 FOR UPDATE 让并发删除在同一把行锁上串行（与历史域 PG 要求逐字一致）。
      return guarded(async (sql) => {
        const found = await sql.query(
          `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = $1::uuid FOR UPDATE`,
          [id],
        );
        const row = found.rows[0];
        if (row === undefined || String(row['owner_id']) !== ownerId) return { ok: false, reason: 'NOT_FOUND' } as CasResult<ConversationRecord>;
        if (Number(row['revision']) !== expectedRevision) return { ok: false, reason: 'REVISION_CHANGED' } as CasResult<ConversationRecord>;
        // `RETURNING id` 不是装饰：`SqlRunner` 只有 `rows`（没有 `rowCount`），
        // 不带 RETURNING 的 DELETE 一律回空数组，CAS 判定会被误读成"版本不符"。
        const deleted = await sql.query(
          'DELETE FROM conversations WHERE id = $1::uuid AND owner_id = $2::uuid AND revision = $3 RETURNING id',
          [id, ownerId, expectedRevision],
        );
        if (deleted.rows.length !== 1) return { ok: false, reason: 'REVISION_CHANGED' } as CasResult<ConversationRecord>;
        return { ok: true, record: toConversation(row) } as CasResult<ConversationRecord>;
      });
    },

    // -----------------------------------------------------------------------
    // 轮次与回答
    // -----------------------------------------------------------------------
    async insertTurn(record) {
      const { rows } = await pool.query(
        `INSERT INTO conversation_turns
           (id, conversation_id, owner_id, revision, input_text, transcription_ref, job_id, job_state,
            job_deadline_at, job_created_at, job_error_code, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4, $5::jsonb, $6::uuid, $7, $8, $9, $10, $11, $11)
         RETURNING ${TURN_COLUMNS}`,
        [
          record.id,
          record.conversation_id,
          record.owner_id,
          record.input_text,
          record.transcription_ref === null ? null : JSON.stringify(record.transcription_ref),
          record.job_id,
          record.job_state,
          record.job_deadline_at,
          record.job_created_at,
          record.job_error_code,
          record.created_at,
        ],
      );
      const row = rows[0];
      // 写库未返回结果行 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
      if (row === undefined) throw new ApiError('PROVIDER_UNAVAILABLE', '问答数据库未返回写入结果', { retryable: false });
      return toTurn(row);
    },

    async getTurn(conversationId, turnId, ownerId) {
      const found = await pool.query(
        `SELECT ${TURN_COLUMNS} FROM conversation_turns
         WHERE id = $1::uuid AND conversation_id = $2::uuid AND owner_id = $3::uuid`,
        [turnId, conversationId, ownerId],
      );
      const row = found.rows[0];
      if (row === undefined) return null;
      const turn = toTurn(row);
      const answer = turn.answer_id === null ? null : await readAnswer(turn.answer_id, ownerId);
      return { turn, answer } satisfies TurnWithAnswer;
    },

    async listTurns(conversationId, ownerId, options) {
      const params: unknown[] = [conversationId, ownerId, options.limit];
      const where = listWhere('conversation_turns', options, params);
      const { rows } = await pool.query(
        `SELECT ${TURN_COLUMNS} FROM conversation_turns
         WHERE conversation_id = $1::uuid AND owner_id = $2::uuid${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $3`,
        params,
      );
      const turns = rows.map(toTurn);
      const withAnswers: TurnWithAnswer[] = [];
      for (const turn of turns) {
        const answer = turn.answer_id === null ? null : await readAnswer(turn.answer_id, ownerId);
        withAnswers.push({ turn, answer });
      }
      return withAnswers;
    },

    async deleteTurn(conversationId, turnId, ownerId, expectedRevision) {
      return guarded(async (sql) => {
        const found = await sql.query(
          `SELECT ${TURN_COLUMNS} FROM conversation_turns
           WHERE id = $1::uuid AND conversation_id = $2::uuid AND owner_id = $3::uuid FOR UPDATE`,
          [turnId, conversationId, ownerId],
        );
        const row = found.rows[0];
        if (row === undefined) return { ok: false, reason: 'NOT_FOUND' } as CasResult<TurnRecord>;
        if (Number(row['revision']) !== expectedRevision) return { ok: false, reason: 'REVISION_CHANGED' } as CasResult<TurnRecord>;
        // 同 `deleteConversation`：`rows` 是唯一的判定依据，必须带 RETURNING。
        const deleted = await sql.query(
          'DELETE FROM conversation_turns WHERE id = $1::uuid AND owner_id = $2::uuid AND revision = $3 RETURNING id',
          [turnId, ownerId, expectedRevision],
        );
        if (deleted.rows.length !== 1) return { ok: false, reason: 'REVISION_CHANGED' } as CasResult<TurnRecord>;
        return { ok: true, record: toTurn(row) } as CasResult<TurnRecord>;
      });
    },

    async claimTurnJob(turnId, ownerId) {
      const { rows } = await pool.query(
        `UPDATE conversation_turns
         SET job_state = 'running', revision = revision + 1, updated_at = now()
         WHERE id = $1::uuid AND owner_id = $2::uuid AND job_state = 'queued'
         RETURNING ${TURN_COLUMNS}`,
        [turnId, ownerId],
      );
      const row = rows[0];
      return row === undefined ? null : toTurn(row);
    },

    async settleTurnJob(input) {
      return guarded(async (sql) => {
        let answerId: string | null = null;
        if (input.answer !== null) {
          const inserted = await sql.query(
            `INSERT INTO conversation_answers
               (id, turn_id, owner_id, revision, status, checked_text, check_state, citations, dose_cards,
                model_version, prompt_version, rule_version, created_at, updated_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $12)
             RETURNING id`,
            [
              input.answer.id,
              input.answer.turn_id,
              input.answer.owner_id,
              input.answer.status,
              input.answer.checked_text,
              input.answer.check_state,
              JSON.stringify(input.answer.citations),
              JSON.stringify(input.answer.dose_cards),
              input.answer.model_version,
              input.answer.prompt_version,
              input.answer.rule_version,
              input.answer.created_at,
            ],
          );
          if (inserted.rows.length !== 1) {
            // 写库未返回结果行 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
            throw new ApiError('PROVIDER_UNAVAILABLE', '问答数据库未返回写入结果', { retryable: false });
          }
          answerId = String(inserted.rows[0]?.['id']);
        }
        const { rows } = await sql.query(
          `UPDATE conversation_turns
           SET job_state = $4, job_error_code = $5, answer_id = COALESCE($3::uuid, answer_id),
               revision = revision + 1, updated_at = $6
           WHERE id = $1::uuid AND owner_id = $2::uuid AND job_state IN ('queued', 'running')
           RETURNING ${TURN_COLUMNS}`,
          [input.turnId, input.ownerId, answerId, input.state, input.errorCode, input.at],
        );
        const row = rows[0];
        return row === undefined ? null : toTurn(row);
      });
    },

    async getAnswer(answerId, ownerId) {
      return readAnswer(answerId, ownerId);
    },

    async findTurnByJobId(jobId, ownerId) {
      const found = await pool.query(
        `SELECT ${TURN_COLUMNS} FROM conversation_turns WHERE job_id = $1::uuid AND owner_id = $2::uuid`,
        [jobId, ownerId],
      );
      const row = found.rows[0];
      if (row === undefined) return null;
      const turn = toTurn(row);
      const answer = turn.answer_id === null ? null : await readAnswer(turn.answer_id, ownerId);
      return { turn, answer } satisfies TurnWithAnswer;
    },

    async deleteAllByOwner(ownerId) {
      const { rows } = await pool.query('DELETE FROM conversations WHERE owner_id = $1::uuid RETURNING id', [ownerId]);
      return rows.length;
    },
  };
}
