/**
 * GY-I22（#22）· 账号停用/恢复的**唯一持久化写路径**（PG 适配层）。
 *
 * ## 为什么需要这一层
 * `services/api/db/roles/auth_privacy.sql` 授予运行时角色 `gengyun_api_runtime` 的
 * `public.users` 列权限只有 `SELECT (id,state,auth_epoch,revision,wechat_subject_lookup)`
 * 与 `UPDATE (updated_at)`（**写不了** `state`/`auth_epoch`/`revision`）；
 * `public.sessions` 自 0001 起本就有 `UPDATE (token_hash,revoked_at)`；
 * `public.admin_audit_events` 对运行时完全不可写。
 * 派单 §1 要求「停用某账号时在**单个数据库事务**内完成：写 state + 递增 auth_epoch +
 * 撤会话 + 写审计」，四步里只有「撤会话」这一步运行时能单独做（其余三步一律 `42501`），
 * 而单独做它恰恰最坏：会话撤了、账号还是 `active`、`auth_epoch` 没动、也没有审计——
 * 用户被踢下线却随时能再登回来，且重试还要面对没变的 `revision`。
 * 因此与 GY-I19（注销受理，`privacy/deletion-requests-pg.ts`）走**同一条已裁定路线**：
 * 四步收进窄口径 `SECURITY DEFINER` 函数（迁移 `0017_account_suspend_authority.sql`），
 * 运行时只拿 EXECUTE。本文件是那次调用在 Node 侧的唯一落点：
 * 不拼 DDL/DML、不直改任何表，只在显式事务里调一个函数。
 *
 * ## 事务边界
 * 函数内部四步由 PostgreSQL 保证原子；本层再用 `BEGIN`…`COMMIT` 包住**唯一一条** `SELECT`
 * 并把 `lock_timeout` 固定为 4s（与 `privacy/ledger-pg.ts` 的 `withTransaction()` 同口径）。
 * 任一失败 ⇒ `ROLLBACK` ⇒ **零写入**：不会出现「epoch 已递增但会话没撤」「状态改了但审计没落」
 * 这类把用户锁在门外或留下无审计变更的半成品。
 *
 * ## 恢复（启用）为什么没有 HTTP 路由
 * `packages/contracts/operations.json` 只有 `suspendUser`，**没有** restore/enable 操作。
 * 契约不可改（派单 §2），故恢复能力以「端口方法 + 数据库函数」交付，
 * 由运维/后续片经已审查的调用点使用；本层不注册路由、不改 `routes/admin.ts`。
 *
 * ## 错误码：不新增契约错误码
 * 函数 G 码按既有语义映射到既有契约码（风格同 `privacy/deletion-requests-pg.ts` 的
 * `mapDeletionError()`）：
 *   - `G0001` ⇒ `INVALID_REQUEST`(400)      参数非法
 *   - `G0002` ⇒ `NOT_FOUND`(404)            主体不存在
 *   - `G0003` ⇒ `REVISION_CONFLICT`(409)    `If-Match` 与当前 revision 不符
 *   - `G0004` ⇒ `OBJECT_UNAVAILABLE`(409 域) 账号状态不接受该动作（注销在途/已删）
 *   - `23505` ⇒ `PROVIDER_UNAVAILABLE`(503) 审计 id 撞主键（属服务端缺陷，**不是**已受理）
 *   - `42501`/`42883` ⇒ `PROVIDER_UNAVAILABLE`(503) **权限/函数缺失绝不降级**：不换路径、不重试
 *   - `57014`/`55P03` ⇒ `PROVIDER_TIMEOUT`(504, retryable)
 */
import type { PoolClient } from 'pg';
import { ApiError } from '../../errors.ts';
import type { PgPool } from '../../db/pool.ts';
import type { AccountState, AccountView } from './types.ts';

/** 停用：唯一写路径的精确签名（改动后必须同步 `90-assert-least-privilege.sql`）。 */
export const SUSPEND_ACCOUNT_FUNCTION = 'public.suspend_account';
/** 恢复：唯一写路径的精确签名。 */
export const RESTORE_ACCOUNT_FUNCTION = 'public.restore_account';

/** 唯一一条语句：调用窄口径函数（五参全显式转型，避免参数类型推断落到别的候选）。 */
const CALL_SUSPEND_SQL = `SELECT public.suspend_account(
  $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid
) AS result`;

const CALL_RESTORE_SQL = `SELECT public.restore_account(
  $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid
) AS result`;

/** 写事务的锁等待上限（与 `privacy/ledger-pg.ts` 的 4s 同口径；常量不拼接用户输入）。 */
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '4s'";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACCOUNT_STATES_SET: readonly string[] = ['active', 'suspended', 'deletion_pending'];

/** 一次停用/恢复调用的入参。`expectedRevision === null` ⇒ 无前置条件（未带 `If-Match`）。 */
export interface AccountAuthorityAction {
  /** 操作主体（后台管理员 id）；审计事件的主体。 */
  actorId: string;
  /** 审计事件 id（调用方生成 uuid；重复即第 4 步失败，用于失败注入回归）。 */
  auditId: string;
  /** 目标账号 id。 */
  userId: string;
  /** 强 ETag 前置条件；`null` ⇒ 不做 CAS 校验。 */
  expectedRevision: number | null;
  /** 契约 `Meta.request_id`。 */
  requestId: string;
}

/**
 * 函数**实测**读数（不是算术推断）：`state`/`revision`/`authEpoch` 来自 `UPDATE ... RETURNING`，
 * `revokedSessions` 来自 `GET DIAGNOSTICS ROW_COUNT`，`auditId` 来自落库后的审计行。
 */
export interface AccountAuthorityOutcome {
  account: AccountView;
  authEpoch: number;
  /** 本次实际撤销的会话行数（幂等分支恒为 0）。 */
  revokedSessions: number;
  /** 本次是否真的改了状态（`false` = 幂等重放，无任何副作用）。 */
  changed: boolean;
  auditId: string | null;
}

/** 账号写权威端口（停用/恢复）。`persistent: true` 表示落在真实 PostgreSQL 上。 */
export interface AdminAccountAuthority {
  readonly persistent: true;
  suspend(action: AccountAuthorityAction): Promise<AccountAuthorityOutcome>;
  restore(action: AccountAuthorityAction): Promise<AccountAuthorityOutcome>;
}

/**
 * 形状/契约校验失败一律 `retryable: false`：这些检查全部跑在 `COMMIT` **之后**
 * （`call()` 里 `toOutcome(raw)` 位于事务之外），写早已落地。此刻若标可重试，调用方
 * 会带着同一个旧 `If-Match` 重跑，必然撞 `G0003` 409——重试一定不成功（`errors.ts` 对
 * `retryable` 的定义就是「重试能否成功」），故如实标为不可重试。
 */
function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `账号停用返回缺少字段 ${field}`, { retryable: false });
  }
  return value;
}

function asInteger(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `账号停用返回字段 ${field} 不是整数`, { retryable: false });
  }
  return n;
}

/**
 * 函数返回的 JSON 必须是预期形状；形状不符 ⇒ **失败关闭**（`PROVIDER_UNAVAILABLE`），
 * 绝不把「读不懂的返回」当成停用成功。
 */
function toOutcome(raw: unknown): AccountAuthorityOutcome {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '账号停用返回不是对象', { retryable: false });
  }
  const row = raw as Record<string, unknown>;
  const state = asNonEmptyString(row['state'], 'state');
  if (!ACCOUNT_STATES_SET.includes(state)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '账号停用返回的 state 不在契约闭集内', { retryable: false });
  }
  const auditIdRaw = row['audit_id'];
  if (auditIdRaw !== null && typeof auditIdRaw !== 'string') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '账号停用返回字段 audit_id 形状不对', { retryable: false });
  }
  const changed = row['changed'];
  if (typeof changed !== 'boolean') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '账号停用返回字段 changed 不是布尔', { retryable: false });
  }
  return {
    account: {
      id: asNonEmptyString(row['id'], 'id'),
      revision: asInteger(row['revision'], 'revision'),
      state: state as AccountState,
      display_name: asNonEmptyString(row['display_name'], 'display_name'),
    },
    authEpoch: asInteger(row['auth_epoch'], 'auth_epoch'),
    revokedSessions: asInteger(row['revoked_sessions'], 'revoked_sessions'),
    changed,
    auditId: auditIdRaw,
  };
}

/** PostgreSQL 错误 → 既有契约错误码（不透出驱动原文；权限缺失按「不可用」如实失败）。 */
function mapAccountAuthorityError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown })?.code;
  const sqlState = typeof code === 'string' ? code : '';
  if (sqlState === 'G0001') throw new ApiError('INVALID_REQUEST', '账号状态变更参数非法');
  if (sqlState === 'G0002') throw new ApiError('NOT_FOUND', '账号不存在');
  if (sqlState === 'G0003') throw new ApiError('REVISION_CONFLICT', '目标修订已变化，If-Match 与当前 ETag 不匹配');
  if (sqlState === 'G0004') throw new ApiError('OBJECT_UNAVAILABLE', '账号当前状态不接受该动作');
  if (sqlState === '57014' || sqlState === '55P03') {
    throw new ApiError('PROVIDER_TIMEOUT', '账号状态变更事务超时', { retryable: true });
  }
  // `42501`（权限不足）/`42883`（函数不存在）走同一条「不可用」分支：⛔ 不降级、不改走内存路径、
  // ⛔ 不假装成功。`23505`（审计 id 撞主键）同样不是「已受理」，一律如实失败。
  throw new ApiError('PROVIDER_UNAVAILABLE', '账号状态变更暂不可用', { retryable: false });
}

/**
 * 建持久化账号写权威。
 *
 * 构造期**不**探测函数是否存在（探测会把「迁移没跑」变成启动期崩溃）；
 * 也**不**校验 `pool.connect` 的形状（既有装配里 `pool` 允许最小替身，构造期硬失败会让
 * 这些路径整体起不来）。函数缺失/无事务能力在**调用期**以 `42501`/`42883`/无 `connect`
 * ⇒ `PROVIDER_UNAVAILABLE` 如实失败，停用面不会伪造成功。
 */
export function createPostgresAccountAuthority({ pool }: { pool: PgPool }): AdminAccountAuthority {
  async function call(sql: string, action: AccountAuthorityAction): Promise<AccountAuthorityOutcome> {
    if (!pool || typeof pool.connect !== 'function') {
      // 没有事务能力 ⇒ 如实不可用（fail closed，不是静默跳过持久化）。
      throw new ApiError('PROVIDER_UNAVAILABLE', '账号状态变更暂不可用', { retryable: false });
    }
    if (
      !UUID_RE.test(action.actorId) ||
      !UUID_RE.test(action.auditId) ||
      !UUID_RE.test(action.userId) ||
      !UUID_RE.test(action.requestId)
    ) {
      throw new ApiError('INVALID_REQUEST', '账号状态变更参数非法');
    }
    if (action.expectedRevision !== null && !(Number.isSafeInteger(action.expectedRevision) && action.expectedRevision >= 1)) {
      throw new ApiError('INVALID_REQUEST', '账号状态变更参数非法');
    }

    let client: PoolClient | undefined;
    let raw: unknown;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query(LOCK_TIMEOUT_SQL);
      const result = await client.query(sql, [
        action.actorId,
        action.auditId,
        action.userId,
        action.expectedRevision,
        action.requestId,
      ]);
      raw = result.rows[0]?.['result'];
      await client.query('COMMIT');
    } catch (error) {
      if (client !== undefined) await client.query('ROLLBACK').catch(() => {});
      return mapAccountAuthorityError(error);
    } finally {
      client?.release();
    }
    // 解析放在事务之外：返回形状不符 ⇒ 失败关闭，但不影响已提交的事务（不会误发 ROLLBACK 警告）。
    return toOutcome(raw);
  }

  return {
    persistent: true,
    suspend: (action) => call(CALL_SUSPEND_SQL, action),
    restore: (action) => call(CALL_RESTORE_SQL, action),
  };
}
