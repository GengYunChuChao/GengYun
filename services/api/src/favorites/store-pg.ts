/**
 * GY-I16（#16）· 收藏子域的 **PostgreSQL 实现**（迁移 `0018_favorites_history.sql`）。
 *
 * 连接方式**沿用仓库既有 PG 方式**，没有第二套连接池或迁移器：
 *   - 本文件接的是 `app.ts` 已有的 `PgPool`（唯一构造点是 `services/api/src/server.ts`
 *     的 `createPool`），事务模式抄 `conversations/store-pg.ts`／`knowledge/service.ts`：
 *     `pool.connect()` → `BEGIN` → `SET LOCAL lock_timeout = '4s'` → 业务 SQL → `COMMIT`
 *     （异常 `ROLLBACK`；`57014` 语句超时 / `55P03` 锁不可得 ⇒ `PROVIDER_TIMEOUT`，
 *     其余数据库异常 ⇒ `PROVIDER_UNAVAILABLE`，与问答域/资料域同口径）；
 *   - 迁移只写 `services/api/db/migrations/0018_favorites_history.sql`，由仓库**唯一**的
 *     运行器 `services/api/src/db/migrate.ts` 执行。
 *
 * 与内存实现（`./store.ts`）的**逐方法对齐**（这是本文件的验收口径，不是"大致等价"）：
 *   - `insertFavorite`：**唯一**写入口。同 `id` 或同 `(owner_id, target_type, target_id)`
 *     已存在 ⇒ 不写入、返回 `'duplicate'`。去重**只**由唯一索引裁决
 *     （`INSERT ... ON CONFLICT DO NOTHING`），**没有**"先 SELECT 再决定是否 INSERT"的窗口。
 *   - `deleteFavorite`：**唯一**删除入口。`SELECT ... FOR UPDATE` 与
 *     `DELETE ... AND owner_id AND revision` 在**同一事务**内完成 ⇒ 并发取消只成功一次；
 *     删除是**物理删除**，取消后再收藏会得到新 `id`，旧行不复活。
 *   - `findByTarget` / `listFavoritesByOwner`：只按 `owner_id` 过滤（他人行不出存储层）。
 *   - `deleteAllByOwner`：注销清理原语，`DELETE ... RETURNING id` 的**行数**即证据。
 *   - 幂等台账**真落库**（`favorites_idempotency`）：`claim`/`complete`/`release` 各是**一条**
 *     带条件的语句，`outcome IS NULL` = 已认领未完成；`awaitIdempotencySettled` 有界轮询
 *     （25ms 间隔、总时长沿用 `waitMs`）**每次真读库**，不用进程内 Map 假装。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from '../errors.ts';
import type {
  DeleteExpectation,
  DeleteResult,
  FavoriteRecord,
  FavoritesStore,
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

/** 数据库异常的契约化折叠（与 `conversations/store-pg.ts` 逐条同口径）。 */
export function classifyFavoritesDatabaseError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['57014', '55P03'].includes(code)) {
    throw new ApiError('PROVIDER_TIMEOUT', '收藏数据库响应超时', { retryable: true });
  }
  if (error instanceof ApiError) throw error;
  throw new ApiError('PROVIDER_UNAVAILABLE', '收藏数据库暂不可用', { retryable: true });
}

/** `awaitIdempotencySettled` 的轮询间隔（与交接说明一致：25ms、有界、不忙等）。 */
const SETTLE_POLL_INTERVAL_MS = 25;

const FAVORITE_COLUMNS = 'id, owner_id, target_type, target_id, target_revision, revision, created_at';
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

function toFavorite(row: Record<string, unknown>): FavoriteRecord {
  return {
    id: String(row['id']),
    revision: Number(row['revision']),
    owner_id: String(row['owner_id']),
    target_ref: {
      // 闭集与 `revision` 由数据库 CHECK 与本域写入路径共同保证；读出时如实转回。
      type: String(row['target_type']) as FavoriteRecord['target_ref']['type'],
      id: String(row['target_id']),
      revision: Number(row['target_revision']),
    },
    // 收藏/历史的 `created_at` 是 **ISO 字符串**（与 `ConversationRecord` 的 `Date` 不同）。
    created_at: asDate(row['created_at']).toISOString(),
  };
}

/** 事务包裹：`BEGIN` → `SET LOCAL lock_timeout` → 业务 → `COMMIT`；异常折叠为契约错误。 */
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
        // 回滚失败不覆盖原始异常：原始异常才是可诊断的原因。
      }
    }
    return classifyFavoritesDatabaseError(error);
  } finally {
    connection?.release();
  }
}

export function createPostgresFavoritesStore(
  pool: TransactionalPool,
  options: { now?: () => number } = {},
): FavoritesStore {
  // 幂等窗口比较必须与服务使用同一个时钟（脚本化时钟不会被真实 Date.now() 判成过期）。
  const nowMs = options.now ?? (() => Date.now());

  async function readFavorite(sql: SqlRunner, id: string): Promise<FavoriteRecord | null> {
    const result = await sql.query(`SELECT ${FAVORITE_COLUMNS} FROM favorites WHERE id = $1::uuid`, [id]);
    const row = result.rows[0];
    return row === undefined ? null : toFavorite(row);
  }

  return {
    // 进程重启后数据仍在 ⇒ 本实现可以被 `app.ts` 当作"真实持久化"放行。
    persistent: true,

    async insertFavorite(record: FavoriteRecord): Promise<InsertResult> {
      // 去重**只**由唯一索引裁决：撞 PK 或撞 `favorites_owner_target_key` 都返回 `duplicate`。
      const result = await pool.query(
        `INSERT INTO favorites (id, owner_id, target_type, target_id, target_revision, revision, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::timestamptz)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          record.id,
          record.owner_id,
          record.target_ref.type,
          record.target_ref.id,
          record.target_ref.revision,
          record.revision,
          record.created_at,
        ],
      );
      return result.rows.length === 1 ? 'inserted' : 'duplicate';
    },

    async getFavorite(id: string): Promise<FavoriteRecord | null> {
      return readFavorite(pool, id);
    },

    async findByTarget(ownerId: string, type: string, targetId: string): Promise<FavoriteRecord | null> {
      // 去重键**不含** `target_revision`：同一目标的不同版本仍是同一行收藏。
      const result = await pool.query(
        `SELECT ${FAVORITE_COLUMNS} FROM favorites
          WHERE owner_id = $1::uuid AND target_type = $2 AND target_id = $3`,
        [ownerId, type, targetId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toFavorite(row);
    },

    async listFavoritesByOwner(ownerId: string): Promise<FavoriteRecord[]> {
      const result = await pool.query(
        `SELECT ${FAVORITE_COLUMNS} FROM favorites
          WHERE owner_id = $1::uuid
          ORDER BY created_at DESC, id DESC`,
        [ownerId],
      );
      return result.rows.map(toFavorite);
    },

    async deleteFavorite(id: string, expected: DeleteExpectation): Promise<DeleteResult> {
      return withTransaction(pool, async (sql) => {
        // 锁行后再比较：与内存实现的"无 await 同步临界区"等价（并发取消只成功一次）。
        const locked = await sql.query(
          `SELECT ${FAVORITE_COLUMNS} FROM favorites WHERE id = $1::uuid FOR UPDATE`,
          [id],
        );
        const row = locked.rows[0];
        if (row === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
        const current = toFavorite(row);
        if (expected.owner_id !== undefined && current.owner_id !== expected.owner_id) {
          return { ok: false, reason: 'OWNER_CHANGED' } as const;
        }
        if (current.revision !== expected.revision) {
          return { ok: false, reason: 'REVISION_CHANGED' } as const;
        }
        // `RETURNING id` 不是装饰：`SqlRunner` 只有 `rows`（没有 `rowCount`），
        // 删除是否真的发生只能以返回行数判定。
        const deleted = await sql.query(
          `DELETE FROM favorites WHERE id = $1::uuid AND owner_id = $2::uuid AND revision = $3
           RETURNING id`,
          [id, current.owner_id, expected.revision],
        );
        if (deleted.rows.length !== 1) return { ok: false, reason: 'REVISION_CHANGED' } as const;
        return { ok: true, record: current } as const;
      });
    },

    async deleteAllByOwner(ownerId: string): Promise<number> {
      const result = await pool.query(
        'DELETE FROM favorites WHERE owner_id = $1::uuid RETURNING id',
        [ownerId],
      );
      return result.rows.length;
    },

    // ---- 幂等台账（真落库） ----

    async findIdempotency(scope: string, keyHash: string): Promise<IdempotencyRecord | null> {
      const result = await pool.query(
        `SELECT ${IDEMPOTENCY_COLUMNS} FROM favorites_idempotency WHERE scope = $1 AND key_hash = $2`,
        [scope, keyHash],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const expiresAt = asDate(row['expires_at']).getTime();
      if (expiresAt <= nowMs()) {
        // 过期即删（与内存实现一致：过期槽位不参与重放，也不阻塞重新认领）。
        await pool.query(
          'DELETE FROM favorites_idempotency WHERE scope = $1 AND key_hash = $2 AND expires_at <= $3::timestamptz',
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
      // 单条语句完成"未被占用则占用/已过期则接管"：先查后写会在多进程下漏放并发。
      const result = await pool.query(
        `INSERT INTO favorites_idempotency (scope, key_hash, request_hash, response_status, outcome, expires_at)
         VALUES ($1, $2, $3, $4, NULL, $5::timestamptz)
         ON CONFLICT (scope, key_hash) DO UPDATE
           SET request_hash = EXCLUDED.request_hash,
               response_status = EXCLUDED.response_status,
               outcome = NULL,
               expires_at = EXCLUDED.expires_at
           WHERE favorites_idempotency.expires_at <= $6::timestamptz
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
      // 只有"已认领未完成（outcome IS NULL）"的槽位可以被完成（不覆盖别人的已完成结果）。
      const result = await pool.query(
        `UPDATE favorites_idempotency
            SET outcome = $3::jsonb, response_status = $4
          WHERE scope = $1 AND key_hash = $2 AND outcome IS NULL
          RETURNING scope`,
        [scope, keyHash, JSON.stringify(done.outcome), done.response_status],
      );
      return result.rows.length === 1;
    },

    async releaseIdempotency(scope: string, keyHash: string): Promise<void> {
      // 释放只针对"已认领未完成"的槽位：已完成的结果不得被失败路径抹掉。
      await pool.query(
        'DELETE FROM favorites_idempotency WHERE scope = $1 AND key_hash = $2 AND outcome IS NULL',
        [scope, keyHash],
      );
    },

    async awaitIdempotencySettled(scope: string, keyHash: string, waitMs: number): Promise<'settled' | 'timeout'> {
      const deadline = nowMs() + Math.max(0, waitMs);
      for (;;) {
        // 每次迭代都**真读库**：槽位消失（被释放/已过期）或已写入结果都算"已结算"。
        const result = await pool.query(
          'SELECT outcome FROM favorites_idempotency WHERE scope = $1 AND key_hash = $2',
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
