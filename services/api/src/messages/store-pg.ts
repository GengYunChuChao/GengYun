/**
 * GY-I17（#17）阶段 2 · 消息域的 **PostgreSQL 实现**（迁移 `0019_messages_persistence.sql`）。
 *
 * 逐方法与 `messages/store.ts` 的内存实现对齐，**没有**简化：
 *   - `insertMessage`：单条 `INSERT ... ON CONFLICT DO NOTHING RETURNING id`，
 *     按"有没有返回行"判定 `inserted` / `duplicate`。重复判定**只**由数据库唯一约束
 *     （主键 `id` 与 `(owner_id, event_key)`）给出，因此不存在先查后写的窗口；
 *   - `markReadIfUnread`：单条 `UPDATE ... WHERE id = $1 AND owner_id = $2 AND read_at IS NULL
 *     RETURNING ...`（CAS + 单调 + 恰好一次版本推进）；无行返回时才再读一次，用来区分
 *     "已是已读（空操作 `transitioned: false`）"与"不存在 / 非本人（`NOT_FOUND` / `OWNER_CHANGED`）"。
 *     并发由 PostgreSQL 行级锁收敛：20 个并发标记只有 1 个能匹配到 `read_at IS NULL`；
 *   - `countUnread`：`count(*)` 派生量，**没有**计数器列；
 *   - 幂等台账：复用 0008 的 `public.idempotency_keys`（同一张表、同一套 scope 口径），
 *     `outcome IS NULL` 即"占位中"。三步（claim → produce → complete、失败 release）与
 *     `auth/idempotency.ts` 的 `createPostgresIdempotencyStore` 逐条同口径：
 *     每步都是**单语句原子**操作（`ON CONFLICT DO NOTHING RETURNING` / `UPDATE ... AND outcome IS NULL
 *     RETURNING` / `DELETE ... AND outcome IS NULL`），因此"完成或释放"不会留下半成品行，
 *     也不存在两次 produce（占位由唯一索引原子取得）。
 *     未把 `produce` 包进一条数据库事务：`MessagesStore` 接口没有事务句柄（改签名属派单停手条件），
 *     而台账的原子性已由上述三条单语句各自保证。
 *
 * 归属域：所有语句都带 `owner_id = $userId` 谓词；唯一的例外是 `getMessage(id)`——
 * 接口方法签名**没有** owner 形参（改签名属停手条件），故它按 id 单条读取，
 * 归属判定在同一请求内由服务层完成（`service.ts` 读到非本人即 `notFound()`，与"不存在"同形）。
 *
 * 错误折叠：`57014`（语句超时）/ `55P03`（锁不可得）⇒ `PROVIDER_TIMEOUT`，其余数据库异常 ⇒
 * `PROVIDER_UNAVAILABLE`，与 `conversations/store-pg.ts` / `knowledge/service.ts` 同口径。
 */
import { ApiError } from '../errors.ts';
import { isTransientDatabaseError } from '../db/pool.ts';
import { MESSAGE_TYPES, type MessageType, type TargetRef } from './types.ts';
import type {
  IdempotencyOutcome,
  IdempotencyRecord,
  InsertResult,
  MarkReadExpectation,
  MarkReadResult,
  MessageRecord,
  MessagesStore,
} from './store.ts';

/** `pg` 连接池的最小形状（与 `db/pool.ts` 的 `PgPool` 结构兼容；测试可传记录型假池）。 */
export interface SqlRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresMessagesStoreOptions {
  pool: SqlRunner;
  /** 轮询幂等占位时的间隔（毫秒）；只为测试可注入，默认 25。 */
  settlePollMs?: number;
}

/** 数据库异常的契约化折叠（与 `conversations/store-pg.ts` 逐条同口径）。 */
export function classifyMessagesDatabaseError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['57014', '55P03'].includes(code)) {
    throw new ApiError('PROVIDER_TIMEOUT', '消息数据库响应超时', { retryable: true });
  }
  if (error instanceof ApiError) throw error;
  // `retryable` 分档（口径原文见 `../errors.ts` 的 `ApiError` 注释）：连接层故障（08xxx）、管理员干预
  // （53xxx / 57P0x）、串行化冲突（40001）、死锁（40P01）⇒ 同一请求稍后重试**确实**可能成功 ⇒ true；
  // 权限不足（42501）、库/表/凭据缺失（3D000 / 28P01 / 42P01）、函数缺失（42883）与无法归类的其余
  // 驱动错误 ⇒ 需运维改配置或修缺陷，重试永远不会好 ⇒ false（⛔ 恒 true 会把权限缺失伪装成下游抖动）。
  throw new ApiError('PROVIDER_UNAVAILABLE', '消息数据库暂不可用', { retryable: isTransientDatabaseError(error) });
}

const COLUMNS = 'id, revision, owner_id, type, target_ref, read_at, created_at, event_key';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  // 不因等待者而拖住进程退出（与内存实现的 `unref` 同口径）。
  if (typeof timer.unref === 'function') timer.unref();
});

function asIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function asTargetRef(value: unknown): TargetRef | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '消息目标引用形状不合约定（内部不变式违反）', { retryable: false });
  }
  const candidate = parsed as Partial<TargetRef>;
  if (typeof candidate.type !== 'string' || typeof candidate.id !== 'string' || typeof candidate.revision !== 'number') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '消息目标引用形状不合约定（内部不变式违反）', { retryable: false });
  }
  return { type: candidate.type, id: candidate.id, revision: candidate.revision };
}

/** 数据库行 → 内部记录（字段名与契约一致；未知类型按内部不变式违反处理，不静默降级）。 */
export function messageRecordFromRow(row: Record<string, unknown>): MessageRecord {
  const type = row.type;
  if (typeof type !== 'string' || !(MESSAGE_TYPES as readonly string[]).includes(type)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '消息类型不在契约闭集内（内部不变式违反）', { retryable: false });
  }
  return {
    id: String(row.id),
    revision: Number(row.revision),
    owner_id: String(row.owner_id),
    type: type as MessageType,
    target_ref: asTargetRef(row.target_ref),
    read_at: row.read_at === null || row.read_at === undefined ? null : asIso(row.read_at),
    created_at: asIso(row.created_at),
    event_key: String(row.event_key),
  };
}

/** 台账 `outcome` → 消息类结果引用；形状不符按内部不变式违反处理（绝不回放别人的结果）。 */
function outcomeFromRow(value: unknown): IdempotencyOutcome {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  const candidate = (parsed ?? {}) as Partial<IdempotencyOutcome>;
  if (candidate.kind !== 'message' || typeof candidate.id !== 'string' || typeof candidate.revision !== 'number') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '幂等台账结果引用不可解析（内部不变式违反）', { retryable: false });
  }
  return { kind: 'message', id: candidate.id, revision: candidate.revision };
}

export function createPostgresMessagesStore(options: PostgresMessagesStoreOptions): MessagesStore {
  const { pool } = options;
  const settlePollMs = options.settlePollMs ?? 25;

  async function run(text: string, values?: unknown[]): Promise<Array<Record<string, unknown>>> {
    try {
      const result = await pool.query(text, values);
      return result.rows;
    } catch (error) {
      classifyMessagesDatabaseError(error);
    }
  }

  async function readById(id: string): Promise<MessageRecord | null> {
    // 归属判定在服务层（接口无 owner 形参）；这里只按 id 取单条。
    const rows = await run(`SELECT ${COLUMNS} FROM public.messages WHERE id = $1::uuid`, [id]);
    const row = rows[0];
    return row === undefined ? null : messageRecordFromRow(row);
  }

  return {
    persistent: true,

    async insertMessage(record) {
      const rows = await run(
        `INSERT INTO public.messages (id, owner_id, type, target_ref, read_at, created_at, revision, event_key)
              VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::timestamptz, $6::timestamptz, $7, $8)
         ON CONFLICT DO NOTHING
           RETURNING id`,
        [
          record.id,
          record.owner_id,
          record.type,
          record.target_ref === null ? null : JSON.stringify(record.target_ref),
          record.read_at,
          record.created_at,
          record.revision,
          record.event_key,
        ],
      );
      const result: InsertResult = rows.length > 0 ? 'inserted' : 'duplicate';
      return result;
    },

    async getMessage(id) {
      return readById(id);
    },

    async listMessagesByOwner(ownerId) {
      const rows = await run(
        `SELECT ${COLUMNS} FROM public.messages
          WHERE owner_id = $1::uuid
          ORDER BY created_at DESC, id DESC`,
        [ownerId],
      );
      return rows.map(messageRecordFromRow);
    },

    async findByEventKey(ownerId, eventKey) {
      const rows = await run(
        `SELECT ${COLUMNS} FROM public.messages
          WHERE owner_id = $1::uuid AND event_key = $2
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [ownerId, eventKey],
      );
      const row = rows[0];
      return row === undefined ? null : messageRecordFromRow(row);
    },

    async markReadIfUnread(id, expected: MarkReadExpectation, readAt) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const rows = await run(
          `UPDATE public.messages
              SET read_at = $3::timestamptz, revision = revision + 1
            WHERE id = $1::uuid
              AND ($2::uuid IS NULL OR owner_id = $2::uuid)
              AND read_at IS NULL
            RETURNING ${COLUMNS}`,
          [id, expected.owner_id ?? null, readAt],
        );
        const row = rows[0];
        if (row !== undefined) {
          const record = messageRecordFromRow(row);
          return { ok: true, record, transitioned: true };
        }
        // 无行返回：要么已是已读（并发/重复标记，空操作），要么不存在，要么不是本人。
        const current = await readById(id);
        if (current === null) return { ok: false, reason: 'NOT_FOUND' };
        if (expected.owner_id !== undefined && current.owner_id !== expected.owner_id) {
          return { ok: false, reason: 'OWNER_CHANGED' };
        }
        // 判定顺序逐条对齐内存实现：不存在 → 非本人 → 版本不符 → 已读空操作。
        if (current.revision !== expected.revision) return { ok: false, reason: 'REVISION_CHANGED' };
        if (current.read_at !== null) return { ok: true, record: current, transitioned: false };
        // 行仍在、仍未读、版本未变：只可能是两轮之间的瞬时窗口，重试同一条 UPDATE，不臆造结果。
      }
      return { ok: false, reason: 'REVISION_CHANGED' };
    },

    async countUnread(ownerId) {
      // 派生量：每次现算本人未读行数（没有计数器列，因此不存在计数漂移）。
      const rows = await run(
        `SELECT count(*)::bigint AS count FROM public.messages
          WHERE owner_id = $1::uuid AND read_at IS NULL`,
        [ownerId],
      );
      const row = rows[0];
      return row === undefined ? 0 : Number(row.count);
    },

    // ---- 幂等台账（0008 的 public.idempotency_keys；scope 已编码主体） ----

    async findIdempotency(scope, keyHash) {
      const rows = await run(
        `SELECT request_hash,
                response_status,
                outcome,
                (extract(epoch FROM expires_at) * 1000)::bigint AS expires_at_ms
           FROM public.idempotency_keys
          WHERE scope = $1 AND key_hash = decode($2, 'hex') AND expires_at > now()`,
        [scope, keyHash],
      );
      const row = rows[0];
      // 到期即视为不存在（与内存实现的惰性淘汰同义）；未完成的占位（outcome IS NULL）也视为不存在。
      if (row === undefined) return null;
      if (row.outcome === null || row.outcome === undefined) return null;
      const record: IdempotencyRecord = {
        request_hash: String(row.request_hash).trim(),
        response_status: Number(row.response_status),
        outcome: outcomeFromRow(row.outcome),
        expires_at: Number(row.expires_at_ms),
      };
      return record;
    },

    async claimIdempotency(scope, keyHash, claim) {
      // 先清掉已到期的残留占位（与 auth 的 Postgres 台账逐条同口径），再原子占位。
      await run(
        `DELETE FROM public.idempotency_keys
          WHERE scope = $1 AND key_hash = decode($2, 'hex') AND expires_at <= now()`,
        [scope, keyHash],
      );
      const rows = await run(
        `INSERT INTO public.idempotency_keys (scope, key_hash, request_hash, response_status, outcome, expires_at)
              VALUES ($1, decode($2, 'hex'), $3, $4, NULL, to_timestamp($5::bigint / 1000.0))
         ON CONFLICT (scope, key_hash) DO NOTHING
           RETURNING id`,
        [scope, keyHash, claim.request_hash, claim.response_status, claim.expires_at],
      );
      return rows.length > 0;
    },

    async completeIdempotency(scope, keyHash, done) {
      const rows = await run(
        `UPDATE public.idempotency_keys
            SET response_status = $3, outcome = $4::jsonb
          WHERE scope = $1 AND key_hash = decode($2, 'hex') AND outcome IS NULL
          RETURNING id`,
        [scope, keyHash, done.response_status, JSON.stringify(done.outcome)],
      );
      return rows.length > 0;
    },

    async releaseIdempotency(scope, keyHash) {
      // 只释放"占位中"的行：已完成的结果不因一次失败重试被抹掉。
      await run(
        `DELETE FROM public.idempotency_keys
          WHERE scope = $1 AND key_hash = decode($2, 'hex') AND outcome IS NULL`,
        [scope, keyHash],
      );
    },

    async awaitIdempotencySettled(scope, keyHash, waitMs) {
      const deadline = Date.now() + Math.max(0, waitMs);
      for (;;) {
        const rows = await run(
          `SELECT outcome FROM public.idempotency_keys
            WHERE scope = $1 AND key_hash = decode($2, 'hex')`,
          [scope, keyHash],
        );
        const row = rows[0];
        if (row === undefined) return 'settled';
        if (row.outcome !== null && row.outcome !== undefined) return 'settled';
        const remaining = deadline - Date.now();
        if (remaining <= 0) return 'timeout';
        await sleep(Math.min(settlePollMs, remaining));
      }
    },
  };
}
