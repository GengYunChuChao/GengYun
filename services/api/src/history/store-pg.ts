/**
 * GY-I16（#16）· 识别／OCR 历史子域的 **PostgreSQL 实现**（迁移 `0018_favorites_history.sql`）。
 *
 * 连接方式、错误折叠、事务形制与收藏域**逐条同口径**（见 `../favorites/store-pg.ts`，
 * 两个文件的 `SqlRunner`/`PgConnection`/`TransactionalPool` 是各自声明的**结构类型**：
 * 同一个 `PgPool` 同时满足两边，不需要任何跨域 import）。
 *
 * 与内存实现（`./store.ts`）的**逐方法对齐**：
 *   - `insertHistory`：**唯一**写入口。同 `id`、同 `(owner_id, event_key)`、或
 *     同 `(owner_id, kind, target_id)` 任一命中 ⇒ `'duplicate'`（两道去重键都在数据库级：
 *     `history_owner_event_key` / `history_owner_target_key`）。`job_state` 不在闭集内时
 *     也与内存实现一致地返回 `'duplicate'`（不是写坏的半条行）。
 *   - `deleteHistory`：同一事务内 `SELECT ... FOR UPDATE` + `DELETE ... AND owner_id AND revision`，
 *     物理删除；并发删除只成功一次。
 *   - `findByEventKey` / `findByTarget` / `listHistoryByOwner`：只按 `owner_id` 过滤。
 *   - `deleteAllByOwner`：注销清理原语，`DELETE ... RETURNING id` 的行数即证据。
 *   - 幂等台账真落库（`history_idempotency`），`outcome` 里多一个 `cascade` 披露字段。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from '../errors.ts';
import { isJobState } from './types.ts';
import type { HistoryKind } from './types.ts';
import type {
  DeleteExpectation,
  DeleteResult,
  HistoryRecord,
  HistoryStore,
  IdempotencyOutcome,
  IdempotencyRecord,
  InsertResult,
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

/** 数据库异常的契约化折叠（与 `conversations/store-pg.ts`、收藏域逐条同口径）。 */
export function classifyHistoryDatabaseError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['57014', '55P03'].includes(code)) {
    throw new ApiError('PROVIDER_TIMEOUT', '历史数据库响应超时', { retryable: true });
  }
  if (error instanceof ApiError) throw error;
  throw new ApiError('PROVIDER_UNAVAILABLE', '历史数据库暂不可用', { retryable: true });
}

/** `awaitIdempotencySettled` 的轮询间隔（25ms、有界、不忙等）。 */
const SETTLE_POLL_INTERVAL_MS = 25;

const HISTORY_COLUMNS =
  'id, owner_id, kind, target_type, target_id, target_revision, revision, job_id, job_state, ' +
  'event_key, created_at';
const IDEMPOTENCY_COLUMNS = 'request_hash, response_status, outcome, expires_at';

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

function toHistory(row: Record<string, unknown>): HistoryRecord {
  return {
    id: String(row['id']),
    revision: Number(row['revision']),
    owner_id: String(row['owner_id']),
    kind: String(row['kind']) as HistoryKind,
    target_ref: {
      type: String(row['target_type']) as HistoryRecord['target_ref']['type'],
      id: String(row['target_id']),
      revision: Number(row['target_revision']),
    },
    job_id: String(row['job_id']),
    job_state: String(row['job_state']) as HistoryRecord['job_state'],
    created_at: asDate(row['created_at']).toISOString(),
    event_key: String(row['event_key']),
  };
}

async function withTransaction<T>(pool: TransactionalPool, run: (sql: SqlRunner) => Promise<T>): Promise<T> {
  let connection: PgConnection | null = null;
  try {
    connection = await pool.connect();
    await connection.query('BEGIN');
    await connection.query("SET LOCAL lock_timeout = '4s'");
    const result = await run(connection);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    if (connection !== null) {
      try {
        await connection.query('ROLLBACK');
      } catch {
        // 回滚失败不覆盖原始异常。
      }
    }
    return classifyHistoryDatabaseError(error);
  } finally {
    connection?.release();
  }
}

export function createPostgresHistoryStore(
  pool: TransactionalPool,
  options: { now?: () => number } = {},
): HistoryStore {
  const nowMs = options.now ?? (() => Date.now());

  return {
    persistent: true,

    async insertHistory(record: HistoryRecord): Promise<InsertResult> {
      // 与内存实现逐条一致：非闭集状态不写坏行，直接按"未新建"回报。
      if (!isJobState(record.job_state)) return 'duplicate';
      // 三处唯一性（PK / event_key / (kind, target_id)）都由数据库裁决，不先查后写。
      const result = await pool.query(
        `INSERT INTO history
           (id, owner_id, kind, target_type, target_id, target_revision, revision,
            job_id, job_state, event_key, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          record.id,
          record.owner_id,
          record.kind,
          record.target_ref.type,
          record.target_ref.id,
          record.target_ref.revision,
          record.revision,
          record.job_id,
          record.job_state,
          record.event_key,
          record.created_at,
        ],
      );
      return result.rows.length === 1 ? 'inserted' : 'duplicate';
    },

    async getHistory(id: string): Promise<HistoryRecord | null> {
      const result = await pool.query(`SELECT ${HISTORY_COLUMNS} FROM history WHERE id = $1::uuid`, [id]);
      const row = result.rows[0];
      return row === undefined ? null : toHistory(row);
    },

    async findByEventKey(ownerId: string, eventKey: string): Promise<HistoryRecord | null> {
      const result = await pool.query(
        `SELECT ${HISTORY_COLUMNS} FROM history WHERE owner_id = $1::uuid AND event_key = $2`,
        [ownerId, eventKey],
      );
      const row = result.rows[0];
      return row === undefined ? null : toHistory(row);
    },

    async findByTarget(ownerId: string, kind: HistoryKind, targetId: string): Promise<HistoryRecord | null> {
      const result = await pool.query(
        `SELECT ${HISTORY_COLUMNS} FROM history
          WHERE owner_id = $1::uuid AND kind = $2 AND target_id = $3`,
        [ownerId, kind, targetId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toHistory(row);
    },

    async listHistoryByOwner(ownerId: string): Promise<HistoryRecord[]> {
      const result = await pool.query(
        `SELECT ${HISTORY_COLUMNS} FROM history
          WHERE owner_id = $1::uuid
          ORDER BY created_at DESC, id DESC`,
        [ownerId],
      );
      return result.rows.map(toHistory);
    },

    async deleteHistory(id: string, expected: DeleteExpectation): Promise<DeleteResult> {
      return withTransaction(pool, async (sql) => {
        const locked = await sql.query(
          `SELECT ${HISTORY_COLUMNS} FROM history WHERE id = $1::uuid FOR UPDATE`,
          [id],
        );
        const row = locked.rows[0];
        if (row === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
        const current = toHistory(row);
        if (expected.owner_id !== undefined && current.owner_id !== expected.owner_id) {
          return { ok: false, reason: 'OWNER_CHANGED' } as const;
        }
        if (current.revision !== expected.revision) {
          return { ok: false, reason: 'REVISION_CHANGED' } as const;
        }
        const deleted = await sql.query(
          `DELETE FROM history WHERE id = $1::uuid AND owner_id = $2::uuid AND revision = $3
           RETURNING id`,
          [id, current.owner_id, expected.revision],
        );
        if (deleted.rows.length !== 1) return { ok: false, reason: 'REVISION_CHANGED' } as const;
        return { ok: true, record: current } as const;
      });
    },

    async deleteAllByOwner(ownerId: string): Promise<number> {
      const result = await pool.query(
        'DELETE FROM history WHERE owner_id = $1::uuid RETURNING id',
        [ownerId],
      );
      return result.rows.length;
    },

    // ---- 幂等台账（真落库） ----

    async findIdempotency(scope: string, keyHash: string): Promise<IdempotencyRecord | null> {
      const result = await pool.query(
        `SELECT ${IDEMPOTENCY_COLUMNS} FROM history_idempotency WHERE scope = $1 AND key_hash = $2`,
        [scope, keyHash],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const expiresAt = asDate(row['expires_at']).getTime();
      if (expiresAt <= nowMs()) {
        await pool.query(
          'DELETE FROM history_idempotency WHERE scope = $1 AND key_hash = $2 AND expires_at <= $3::timestamptz',
          [scope, keyHash, new Date(nowMs()).toISOString()],
        );
        return null;
      }
      if (row['outcome'] === null || row['outcome'] === undefined) return null;
      return {
        request_hash: String(row['request_hash']),
        response_status: Number(row['response_status']),
        outcome: parseJson(row['outcome']) as IdempotencyOutcome,
        expires_at: expiresAt,
      };
    },

    async claimIdempotency(
      scope: string,
      keyHash: string,
      claim: { request_hash: string; response_status: number; expires_at: number },
    ): Promise<boolean> {
      const result = await pool.query(
        `INSERT INTO history_idempotency (scope, key_hash, request_hash, response_status, outcome, expires_at)
         VALUES ($1, $2, $3, $4, NULL, $5::timestamptz)
         ON CONFLICT (scope, key_hash) DO UPDATE
           SET request_hash = EXCLUDED.request_hash,
               response_status = EXCLUDED.response_status,
               outcome = NULL,
               expires_at = EXCLUDED.expires_at
           WHERE history_idempotency.expires_at <= $6::timestamptz
         RETURNING scope`,
        [
          scope,
          keyHash,
          claim.request_hash,
          claim.response_status,
          new Date(claim.expires_at).toISOString(),
          new Date(nowMs()).toISOString(),
        ],
      );
      return result.rows.length === 1;
    },

    async completeIdempotency(
      scope: string,
      keyHash: string,
      done: { response_status: number; outcome: IdempotencyOutcome },
    ): Promise<boolean> {
      const result = await pool.query(
        `UPDATE history_idempotency
            SET outcome = $3::jsonb, response_status = $4
          WHERE scope = $1 AND key_hash = $2 AND outcome IS NULL
          RETURNING scope`,
        [scope, keyHash, JSON.stringify(done.outcome), done.response_status],
      );
      return result.rows.length === 1;
    },

    async releaseIdempotency(scope: string, keyHash: string): Promise<void> {
      await pool.query(
        'DELETE FROM history_idempotency WHERE scope = $1 AND key_hash = $2 AND outcome IS NULL',
        [scope, keyHash],
      );
    },

    async awaitIdempotencySettled(scope: string, keyHash: string, waitMs: number): Promise<'settled' | 'timeout'> {
      const deadline = nowMs() + Math.max(0, waitMs);
      for (;;) {
        const result = await pool.query(
          'SELECT outcome FROM history_idempotency WHERE scope = $1 AND key_hash = $2',
          [scope, keyHash],
        );
        const row = result.rows[0];
        if (row === undefined) return 'settled';
        if (row['outcome'] !== null && row['outcome'] !== undefined) return 'settled';
        const remaining = deadline - nowMs();
        if (remaining <= 0) return 'timeout';
        await sleep(Math.min(SETTLE_POLL_INTERVAL_MS, remaining));
      }
    },
  };
}
