/**
 * GY-I19（#19）· 注销请求的**唯一持久化写路径**（PG 适配层）。
 *
 * ## 为什么需要这一层
 * 裁定一选定窄口径 `SECURITY DEFINER` 函数：运行时角色 `gengyun_api_runtime`
 * 对 `public.users` 的 `state`/`auth_epoch`/`revision` 与 `public.deletion_requests`
 * **没有任何直接列权限**（见 `services/api/db/roles/auth_privacy.sql` 与
 * `deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的 `protected_columns`），
 * 而 `docs/architecture/state-contract.md` 要求受理注销时在**同一事务**内完成
 * 「账号改 deletion_pending + `auth_epoch` 递增 + 撤全部会话 + 插入删除请求」。
 * 因此「受理注销」在 API 侧**只能**表现为一次函数调用。本文件是那次调用在 Node 侧的
 * 唯一落点：不拼 DDL/DML、不直改任何表，只调
 * `public.request_account_deletion(...)`（迁移 `0016_account_deletion_persistence.sql`）。
 *
 * ## 事务边界
 * 函数内部三处写入由 PostgreSQL 保证原子；本层再显式用 `BEGIN` … `COMMIT` 包住
 * **同一条连接上的两条** `SELECT`（① `public.request_account_deletion(...)` 受理、
 * ② `public.deidentify_account(...)` 注销去身份，`#19` 片1 / 迁移 0057），并把 `lock_timeout`
 * 固定为 4s —— 与仓内既有事务原语
 * `services/api/src/privacy/ledger-pg.ts` 的 `withTransaction()` 同口径，
 * 避免并发双受理时无限等待。任一失败 ⇒ `ROLLBACK` ⇒ **零写入**（不出现「半行」状态，
 * 也不会留下「epoch 已递增但请求没落库」这种把用户锁在门外的半成品；同理不会出现
 * 「受理已提交但身份没擦、外发引用还在」的假去身份）。
 * ⛔ 去身份**必须**复用受理那条连接：受理函数已 `FOR UPDATE` 锁住该 `users` 行，另开连接会 55P03 自死锁。
 *
 * ## **不在**本层（也不在同一事务内）
 * 回执 bearer 的明文签发、`Idempotency-Key` 台账写入（沿用既有 24h 台账语义，
 * 见 `services/api/src/routes/support.ts` 的 `runIdempotent()`）。
 *
 * ## 错误码：不新增契约错误码
 * 函数的模块内 G 码按**既有**语义映射到既有契约错误码（风格同
 * `services/api/src/privacy/ledger-pg.ts` 的 `mapPgError()`）：
 *   - `G0001` ⇒ `INVALID_REQUEST`(400)   参数非法（含回执摘要格式、期限倒挂）
 *   - `G0002` ⇒ `NOT_FOUND`(404)          主体不存在
 *   - `G0003` ⇒ `REVISION_CONFLICT`(409)  该账号注销**已在受理中**（并发双受理的确定性失败面）
 *   - `G0004` ⇒ `ACCOUNT_INACTIVE`(403)   账号状态非 active（语义与 `auth/middleware.ts` 的状态门同码同义）
 *   - `G0015` ⇒ `PROVIDER_UNAVAILABLE`(503, **retryable:false**) 去身份的状态门没通过（账号不在
 *     deletion_pending）；只在受理事务内合法，出现即说明事务/接线缺陷，重试不会改善
 *   - `23505` ⇒ `REVISION_CONFLICT`(409)  回执摘要撞唯一索引（同一回执重复插入）
 *   - `42501`/`42883` ⇒ `PROVIDER_UNAVAILABLE`(503, **retryable:false**) **权限缺失/函数缺失绝不降级**：
 *     不换路径、不重试、不静默放行（需运维补权限或跑迁移，不是时间能解决的）
 *   - `57014`/`55P03` ⇒ `PROVIDER_TIMEOUT`(504, retryable:true)
 *   - 瞬时类（`08xxx` 连接层故障 / `53xxx` 管理员干预 / `57P0x` / `40001` 串行化冲突 / `40P01` 死锁）⇒
 *     `PROVIDER_UNAVAILABLE`(503, retryable:true)：同一请求稍后重试**确实**可能成功
 *   - 其余（含无法归类的驱动错误）⇒ `PROVIDER_UNAVAILABLE`(503, retryable:false)
 *   - 返回形状不符（缺字段／时刻不可解析／非整数／非对象）⇒ `PROVIDER_UNAVAILABLE`(503, retryable:false)：
 *     那是函数与客户端版本不一致的**确定性缺陷**，重试不会改善
 *   - 无事务能力（`pool.connect` 缺失＝接线未完成）⇒ `PROVIDER_UNAVAILABLE`(503, retryable:false)
 *
 * `retryable` 的口径原文与唯一判据见 `services/api/src/errors.ts` 的 `ApiError` 注释与
 * `services/api/src/db/pool.ts` 的 `isTransientDatabaseError()`（本文件不另写正则）。
 */
import type { PoolClient } from 'pg';
import { ApiError } from '../errors.ts';
import { isTransientDatabaseError, type PgPool } from '../db/pool.ts';
import { insertBackupCopySeeds, type BackupCopySeedSource } from './backup-copies-pg.ts';

/** 唯一写路径的精确签名（新增/改动后必须同步 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql`）。 */
export const ACCOUNT_DELETION_FUNCTION = 'public.request_account_deletion';

/** 唯一一条语句：调用窄口径函数（九参全显式转型，避免参数类型推断落到别的候选）。 */
const CALL_FUNCTION_SQL = `SELECT public.request_account_deletion(
  $1::uuid, $2::uuid, $3::text, $4::integer,
  $5::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz, $9::timestamptz
) AS result`;

/** 受理事务的锁等待上限（与 `privacy/ledger-pg.ts` 的 4s 同口径；常量不拼接用户输入）。 */
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '4s'";

/**
 * 受理事务的第 3 步（`#19` 片1 / 迁移 0057）：注销去身份 —— 擦除 `users` 的四列 PII
 * （nickname / avatar_media_id / wechat_subject_cipher / wechat_subject_lookup）与
 * 外发台账的第三方引用（`exports.provider_request_ref_cipher`）。
 *
 * ⛔ 必须复用受理用的**同一个** `client`：受理函数已 `SELECT ... FOR UPDATE` 锁住该 `users` 行，
 * 另开连接写同一行会在 `lock_timeout='4s'` 之后 55P03 自死锁（同一事务内 `FOR UPDATE` 可重入）。
 * 失败语义 fail-closed：任何异常都走下面的 `catch` ⇒ `ROLLBACK` ⇒ 零写入、**不**签发 202。
 */
const DEIDENTIFY_SQL = 'SELECT public.deidentify_account($1::uuid) AS result';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** 调用入参：id 与三个时刻都由受理服务（同源 `clock()`）计算，避免同一请求出现两套时间。 */
export interface CreateDeletionRequestInput {
  id: string;
  userId: string;
  receiptHash: string;
  generation: number;
  requestedAt: string;
  onlineDueAt: string;
  backupDueAt: string;
  receiptIssuedAt: string;
  receiptExpiresAt: string;
  /**
   * GY-I19（#19）· 备份副本清单来源（每个必需模块一个）。
   *
   * 给了就**在同一事务内**、函数调用之后 `COMMIT` 之前逐模块写清单行（设计 §6.1 第 2 步）：
   * 任何一个模块写失败 ⇒ 整个受理回滚 ⇒ 调用方收到失败、202 不签发，
   * ⛔ 不会出现「受理成功但 30 天后没有可清对象」。
   */
  sources?: readonly BackupCopySeedSource[];
}

/**
 * 函数**实测**读数（不是算术推断）：`state`/`authEpoch`/`accountRevision` 来自
 * `UPDATE ... RETURNING`，`revokedSessions` 来自 `GET DIAGNOSTICS ROW_COUNT`，
 * 四个时刻来自落库后的 `deletion_requests` 行。
 */
export interface DeletionRequestRecord {
  id: string;
  userId: string;
  state: string;
  revision: number;
  requestedAt: string;
  onlineDueAt: string;
  backupDueAt: string;
  receiptIssuedAt: string;
  receiptExpiresAt: string;
  accountState: string;
  authEpoch: number;
  accountRevision: number;
  revokedSessions: number;
  /**
   * `#19` 片1 的注销去身份**实测**读数（条数来自 `GET DIAGNOSTICS ROW_COUNT`，
   * `generation` 来自 `UPDATE ... RETURNING`／回落的擦除前值）。
   *
   * ⛔ **不进 HTTP 体**：`packages/contracts/openapi.json:14739` 的 `DeletionReceipt` 是
   * `additionalProperties: false`，202 的响应形状一字不动；这里只供服务端记录/证据核对。
   */
  deidentified?: { identity: number; exports: number; generation: number };
}

/** 注销请求的持久化端口（只暴露「受理」这一个动作）。 */
export interface DeletionRequestStore {
  readonly persistent: true;
  /**
   * 原子受理：同一事务内落库三处写入。成功返回**实测**读数；失败抛 `ApiError`
   * 且**零写入**（调用方据此如实拒绝，不得假装受理成功）。
   */
  createRequest(input: CreateDeletionRequestInput): Promise<DeletionRequestRecord>;
}

// 形状校验失败（缺字段／时刻不可解析／非整数／返回不是对象）一律 `retryable:false`：
// 函数的返回值形状与客户端期望不一致是**确定性缺陷**（迁移或部署版本不匹配），同一请求重试必然同样失败。
// 按 `errors.ts` 的 retryable 口径，只有「时间能解决」的瞬时态才可写 true。
function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `注销受理返回缺少字段 ${field}`, { retryable: false });
  }
  return value;
}

function asIsoString(value: unknown, field: string): string {
  const text = asNonEmptyString(value, field);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `注销受理返回字段 ${field} 不是可解析时刻`, { retryable: false });
  }
  return text;
}

function asInteger(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `注销受理返回字段 ${field} 不是整数`, { retryable: false });
  }
  return n;
}

/**
 * 函数返回的 JSON 必须是预期形状；形状不符 ⇒ **失败关闭**（`PROVIDER_UNAVAILABLE`），
 * 绝不把「读不懂的返回」当成受理成功。
 */
function toRecord(raw: unknown): DeletionRequestRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '注销受理返回不是对象', { retryable: false });
  }
  const row = raw as Record<string, unknown>;
  return {
    id: asNonEmptyString(row['id'], 'id'),
    userId: asNonEmptyString(row['user_id'], 'user_id'),
    state: asNonEmptyString(row['state'], 'state'),
    revision: asInteger(row['revision'], 'revision'),
    requestedAt: asIsoString(row['requested_at'], 'requested_at'),
    onlineDueAt: asIsoString(row['online_due_at'], 'online_due_at'),
    backupDueAt: asIsoString(row['backup_due_at'], 'backup_due_at'),
    receiptIssuedAt: asIsoString(row['receipt_issued_at'], 'receipt_issued_at'),
    receiptExpiresAt: asIsoString(row['receipt_expires_at'], 'receipt_expires_at'),
    accountState: asNonEmptyString(row['account_state'], 'account_state'),
    authEpoch: asInteger(row['auth_epoch'], 'auth_epoch'),
    accountRevision: asInteger(row['account_revision'], 'account_revision'),
    revokedSessions: asInteger(row['revoked_sessions'], 'revoked_sessions'),
  };
}

/**
 * 去身份返回的 JSON 也必须是预期形状；形状不符同样**失败关闭**（在 `COMMIT` 之前解析，
 * 因此会整笔回滚、不签发 202，而不是「受理成功但去身份读数读不懂」）。
 */
function toDeidentified(raw: unknown): { identity: number; exports: number; generation: number } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '注销去身份返回不是对象', { retryable: false });
  }
  const row = raw as Record<string, unknown>;
  return {
    identity: asInteger(row['identity'], 'identity'),
    exports: asInteger(row['exports'], 'exports'),
    generation: asInteger(row['generation'], 'generation'),
  };
}

/** PostgreSQL 错误 → 既有契约错误码（不透出驱动原文；权限缺失按「不可用」如实失败）。导出供 `third-party-deletion-pg.ts` 复用，码表只此一份。 */
export function mapDeletionError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown })?.code;
  const sqlState = typeof code === 'string' ? code : '';
  if (sqlState === 'G0001') throw new ApiError('INVALID_REQUEST', '注销受理参数非法');
  if (sqlState === 'G0002') throw new ApiError('NOT_FOUND', '账号不存在');
  if (sqlState === 'G0003') throw new ApiError('REVISION_CONFLICT', '该账号的注销请求已在受理中');
  if (sqlState === 'G0004') throw new ApiError('ACCOUNT_INACTIVE', '账号不可用');
  // G0015 = 去身份函数的状态门没通过（账号不在 deletion_pending）。它只在「受理事务里、
  // 受理函数刚把账号改成 deletion_pending 之后」才合法 ⇒ 走到这里说明事务/接线出了缺陷，
  // 重试不会改善（迁移或部署版本不匹配）⇒ 不可重试；整笔已 ROLLBACK，零写入。
  if (sqlState === 'G0015') throw new ApiError('PROVIDER_UNAVAILABLE', '注销去身份暂不可用', { retryable: false });
  if (sqlState === '23505') throw new ApiError('REVISION_CONFLICT', '该注销请求回执摘要已存在');
  if (sqlState === '57014' || sqlState === '55P03') {
    throw new ApiError('PROVIDER_TIMEOUT', '注销受理事务超时', { retryable: true });
  }
  // 分档（口径原文见 `errors.ts` 的 `ApiError` 注释与 `db/pool.ts` 的 `isTransientDatabaseError()`）：
  if (isTransientDatabaseError(error)) {
    // 瞬时类（08xxx 连接层 / 53xxx 管理员干预 / 57P0x / 40001 串行化 / 40P01 死锁）⇒ 稍后重试确实可能成功。
    throw new ApiError('PROVIDER_UNAVAILABLE', '注销受理暂不可用', { retryable: true });
  }
  // 其余：42501（权限不足）/ 42883（函数缺失）/ 无法归类的驱动错误 ⇒ 同一条「不可用」分支，
  // ⛔ 不降级、不改走别的路径；需运维补权限、跑迁移或修缺陷 ⇒ 不可重试。
  throw new ApiError('PROVIDER_UNAVAILABLE', '注销受理暂不可用', { retryable: false });
}

/**
 * 建持久化注销请求存储。
 *
 * 构造期**不**探测函数是否存在（探测会把「迁移没跑」变成启动期崩溃）；
 * 函数缺失在**调用期**以 `42501`/`42883` ⇒ `PROVIDER_UNAVAILABLE`(503) 如实失败，
 * 受理面不会伪造 202。
 *
 * 同理，构造期**也**不校验 `pool.connect`：本函数要求的是**事务能力**（`BEGIN`/`COMMIT`/
 * `ROLLBACK` 必须作用在同一条连接上），只有真 pg 连接池才有。若把它做成构造期硬失败，
 * 「池子不是真池」就会变成**启动期崩溃**——而既有装配里 `pool` 参数一直允许最小替身
 * （多个既有单测传 `{ query() {…} }` 来模拟数据库故障，见 `tests/unit/public-home.test.mjs`
 * 与 `tests/unit/api-health.test.mjs`），那会让这些既有路径整体起不来。
 * 因此改为**调用期**如实失败：没有事务能力 ⇒ `PROVIDER_UNAVAILABLE`(503, retryable:**false**
 * —— 那是装配/接线缺陷，运维换掉 pool 才能好，不是时间能解决的)，⛔ 绝不退回「不持久化也返回 202」的假受理。
 */
export function createPostgresDeletionRequestStore({ pool }: { pool: PgPool }): DeletionRequestStore {
  return {
    persistent: true,
    async createRequest(input) {
      if (!pool || typeof pool.connect !== 'function') {
        // 没有事务能力＝装配未完成（接线缺陷）：换掉 pool 才能好，重试不会改善 ⇒ retryable:false。
        // 如实不可用（fail closed，不是静默跳过持久化）。
        throw new ApiError('PROVIDER_UNAVAILABLE', '注销受理暂不可用', { retryable: false });
      }
      if (!UUID_RE.test(input.id) || !UUID_RE.test(input.userId)) {
        throw new ApiError('INVALID_REQUEST', '注销受理参数非法');
      }
      if (!SHA256_HEX_RE.test(input.receiptHash)) {
        throw new ApiError('INVALID_REQUEST', '注销受理参数非法');
      }
      if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
        throw new ApiError('INVALID_REQUEST', '注销受理参数非法');
      }

      let client: PoolClient | undefined;
      let raw: unknown;
      let deidentified: { identity: number; exports: number; generation: number } | undefined;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query(LOCK_TIMEOUT_SQL);
        const result = await client.query(CALL_FUNCTION_SQL, [
          input.id,
          input.userId,
          input.receiptHash,
          input.generation,
          input.requestedAt,
          input.onlineDueAt,
          input.backupDueAt,
          input.receiptIssuedAt,
          input.receiptExpiresAt,
        ]);
        raw = result.rows[0]?.['result'];
        // 受理事务的第 2 步（设计 §6.1）：写入逐模块的备份副本清单行。
        // 位置固定在函数调用之后（FK 需要 `deletion_requests` 行已存在）、`COMMIT` 之前
        // （失败必须整笔回滚，⛔ 不能「受理成功但清单半写」）。
        if (input.sources !== undefined) {
          await insertBackupCopySeeds(client, {
            requestId: input.id,
            userId: input.userId,
            generation: input.generation,
            // 与受理函数同源的时刻：`covered_through` = 受理时刻（= `created_at`，CHECK 恒成立），
            // `retention_until` = `backup_due_at`（设计 §4.4 要求逐行相等）。
            coveredThrough: input.requestedAt,
            retentionUntil: input.backupDueAt,
            sources: input.sources,
          });
        }
        // 受理事务的第 3 步（`#19` 片1）：注销去身份。位置固定在备份清单写入之后、`COMMIT` 之前，
        // 且复用**同一个 client**（另开连接会 55P03 自死锁，见 `DEIDENTIFY_SQL` 的注释）。
        // 读数在 `COMMIT` 之前解析：形状不符 ⇒ 整笔回滚 ⇒ 零写入、不签发 202（fail-closed）。
        const deidentifyResult = await client.query(DEIDENTIFY_SQL, [input.userId]);
        deidentified = toDeidentified(deidentifyResult.rows[0]?.['result']);
        await client.query('COMMIT');
      } catch (error) {
        if (client !== undefined) await client.query('ROLLBACK').catch(() => {});
        return mapDeletionError(error);
      } finally {
        client?.release();
      }
      // 到这一步事务已提交：`deidentified` 在 `COMMIT` 之前就解析过了（形状不符已在上面整笔回滚），
      // 这里只做合流；⛔ 不把这两个读数塞进 HTTP 体（`DeletionReceipt` 是 `additionalProperties:false`）。
      return { ...toRecord(raw), deidentified };
    },
  };
}
