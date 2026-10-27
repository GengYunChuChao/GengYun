/**
 * R64 · 后台管理员**账号停用/启用**的唯一持久化写路径（PG 适配层）。
 *
 * ## 为什么需要这一层（而不是复用 `scope-authority-pg.ts`）
 * 「撤光 scope」**不是**停用：撤销只改 `admin_scopes.revoked_at`，`admin_accounts.state` 仍是
 * `active`、`auth_epoch` 不变、既有会话仍然合法。要让一个后台账号真的停下，必须
 *   ① 把 `state` 置 `suspended`（认证中间件据此 403 `ACCOUNT_INACTIVE`）；
 *   ② 把 `auth_epoch + 1`（老 token 的 epoch 对不上 ⇒ 立即失效，不必等 TTL）；
 *   ③ 撤销全部未撤销会话（`admin_sessions.revoked_at`）；
 *   ④ 同一事务写一条 `admin_audit_events`。
 * 这四步必须原子，因此只能落在库内 `SECURITY DEFINER` 函数里：运行时角色
 * `gengyun_api_runtime` 对 `admin_accounts` **零表级、零列级写权限**
 * （`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的 external_manifest 把表级
 * S/I/U/D 钉成 false、列级 ins/upd 为空数组）—— 改权限去换一条内存路径，是这一片
 * **明令禁止**的做法（裁定④）。唯一写路径是迁移 `0048` 的两条函数
 * （`public.disable_admin_account` / `public.enable_admin_account`），运行时只拿它们的 `EXECUTE`
 * （`deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r64-admin-account-disable` 区）。
 *
 * `scope-authority-pg.ts` 之所以**不能**改：它守的是 `admin_scopes` 的写面（0041），
 * 本文件守的是 `admin_accounts` 的状态面（0048）。两者共用同一把事务级 advisory 锁
 * （`hashtextextended('admin_scope:' || p_scope, 18040)`，见 `0041:235`/`:389` 与 `0048` 内注释），
 * 但**契约码、守卫、审计 action 全都不同**；塞进同一个文件会让「一键看出这条路径能写哪张表」
 * 失效。同目录 `account-authority-pg.ts`（0017 的 `suspend_account`，写的是终端用户
 * `public.users`）同理不复用：那张表与 `admin_accounts` 同名不同源（裁定③）。
 *
 * ## 事务边界
 * 函数内部「advisory 锁 → 重核验操作者 → 目标行 FOR UPDATE → 版本/状态门 → 变更 → 版本前进（CAS）
 * → 撤会话 → 写审计」由 PostgreSQL 保证原子；本层再用 `BEGIN`…`COMMIT` 包住**唯一一条** `SELECT`
 * 并把 `lock_timeout` 固定为 4s（与 `scope-authority-pg.ts` / `account-authority-pg.ts` 同口径）。
 * 任一失败 ⇒ `ROLLBACK` ⇒ **零写入**：不会出现「epoc 前进了但会话还活着」「会话撤了但审计没落」
 * 这类半成品。
 *
 * ## 错误码映射（G 码 → 既有/新增契约码；口径来源见 `0048` 的文件头）
 *   - `G0001` ⇒ `INVALID_REQUEST`(400)            参数非法（uuid 形状 / reason 空白或超 500）
 *   - `G0002` ⇒ `NOT_FOUND`(404)                  操作者或目标管理员不存在
 *   - `G0003` ⇒ `REVISION_CONFLICT`(409)          `If-Match` 与 `admin_accounts.revision` 不符
 *   - `G0009` ⇒ `LAST_SCOPE_MANAGER`(409)         停用后 `scopes:write` 有效持有者归零
 *   - `G0010` ⇒ `SCOPE_DENIED`(403)               操作者非有效管理员 / 不持 `scopes:write`
 *   - `G0020` ⇒ `SELF_DISABLE_DENIED`(409)        停用自己（**本片新增契约码**）
 *   - `42501`/`42883` ⇒ `PROVIDER_UNAVAILABLE`(503) 权限/函数缺失**绝不降级**：不换路径、不重试
 *   - `23505` ⇒ `PROVIDER_UNAVAILABLE`(503)       审计 id 撞主键（服务端缺陷，**不是**已受理）
 *   - `57014`/`55P03` ⇒ `PROVIDER_TIMEOUT`(504, retryable)
 *
 * ## 关于 `G0009`：本函数内**结构性不可达**（如实登记，不假装测过）
 * 操作者必须**当前有效**持 `scopes:write` 且 `state = 'active'`（`0048` 的 ③④⑤），而被停用的目标
 * 必然是**另一个**账号（自停用走 `G0020`）。于是「停用目标之后的有效持有者」至少还包含操作者
 * 本人 ⇒ 计数恒 ≥ 1 ⇒ 归零分支进不去。真正的结构性保证是那条操作者前件，而不是这段计数。
 * 守卫仍然保留并有测试覆盖（纵深防御）：它防的是**将来某天**有人放宽操作者前件后，
 * 「停用最后一名元权限持有者」变成可达 —— 那时这段计数就是唯一的拦截点。
 * 因此「摘掉守卫 ⇒ 409 变 200」这种负控制在本路径上**观察不到**，见
 * `docs/verification/gy-r68-aa-admin-disable-20261027.md` 的「负控制」一节。
 *
 * ## 本层**不**做的事
 *   - ⛔ 不做「拒绝留痕」：`0046` 的 `record_admin_scope_denial` 只认 scope 四码
 *     （`G0008`/`G0009`/`G0010`/`G0011`），本条路径的 `G0020`/`G0003` 不在其口径内；
 *     硬塞会让留痕函数把一个「没有对应列语义」的拒绝写成 scope 事件。被拒即被拒，
 *     与 `0017` 的 `suspend_account` 同一口径（它也没有拒绝留痕）。
 *   - ⛔ 不把 `p_reason` 落成列：`admin_audit_events` 没有自由文本列，`before_value` /
 *     `after_value` 必须 `NULL`（裁定⑦，形状校验见 `admin/audit/pg.ts` 的
 *     `toAuditLogReading`：两个字段非空即整条读面 503）。`reason` 只在**入参自检**里被读取，
 *     不落库 —— 这一点必须在验证文档里如实写明，不能让人以为「原因已存档」。
 *   - ⛔ 不缓存、不重试、不降级：函数缺失/权限不足一律 503 如实失败。
 */
import type { PoolClient } from 'pg';
import { ApiError } from '../../errors.ts';
import type { PgPool } from '../../db/pool.ts';

/** 停用：唯一写路径的精确签名（改动后必须同步 `90-assert-least-privilege.sql`）。 */
export const DISABLE_ADMIN_ACCOUNT_FUNCTION = 'public.disable_admin_account';
/** 启用：唯一写路径的精确签名。 */
export const ENABLE_ADMIN_ACCOUNT_FUNCTION = 'public.enable_admin_account';

/**
 * 唯一一条语句：调用窄口径函数。
 * 六个形参全显式转型 —— 否则 PostgreSQL 会按 `unknown` 选候选函数，0048 一旦出现重载就会落到
 * 别的签名上（与 `scope-authority-pg.ts` 同一纪律）。
 */
const CALL_DISABLE_SQL = `SELECT public.disable_admin_account(
  $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::text
) AS result`;

const CALL_ENABLE_SQL = `SELECT public.enable_admin_account(
  $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid, $6::text
) AS result`;

/** 写事务的锁等待上限（与 `scope-authority-pg.ts` 的 4s 同口径；常量不拼接用户输入）。 */
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '4s'";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `admin_accounts.state` 的闭集（与 `0017` 的 CHECK 逐字一致）。 */
const ACCOUNT_STATES = ['active', 'suspended'] as const;
type AdminAccountState = (typeof ACCOUNT_STATES)[number];

/** 一次停用/启用调用的入参。`expectedRevision === null` ⇒ 无前置条件（未带 `If-Match`）。 */
export interface AdminAccountStateAction {
  /** 操作主体（后台管理员 id）；审计事件的 actor。 */
  actorId: string;
  /** 审计事件 id（调用方生成 uuid；重复即审计那一步失败，用于失败注入回归）。 */
  auditId: string;
  /** 目标管理员 id（`admin_accounts.id`，⛔ 不是 `users.id`）。 */
  targetId: string;
  /** 强 ETag 前置条件；`null` ⇒ 不做 CAS 校验。 */
  expectedRevision: number | null;
  /** 契约 `Meta.request_id`（落审计行的 `request_id`）。 */
  requestId: string;
  /** 原因（自由文本 1..500，**只在入参自检里读**，不落库；见文件头「本层不做的事」）。 */
  reason: string;
}

/**
 * 函数**实测**读数（不是算术推断）：`state`/`authEpoch`/`revision` 来自函数体内
 * `UPDATE … RETURNING`，`revokedSessions` 来自撤销会话那条 `UPDATE` 的行数，
 * `changed` 来自状态是否真的变了，`auditId` 来自落库后的审计行（`changed=false` 时为 `null`）。
 */
export interface AdminAccountStateOutcome {
  administratorId: string;
  /** 变更后的 `admin_accounts.revision`（幂等分支即当前值）。 */
  revision: number;
  /** 变更后的 `admin_accounts.state`。 */
  state: AdminAccountState;
  /** 变更后的 `admin_accounts.auth_epoch`（停用/启用都 +1；幂等分支即当前值）。 */
  authEpoch: number;
  /** 本次撤销的会话行数（停用时 `> 0` 才证明「踢下线」真的发生；启用恒 0）。 */
  revokedSessions: number;
  /** 本次是否真的改了库（`false` = 幂等重放，无任何副作用、无第二条审计）。 */
  changed: boolean;
  auditId: string | null;
}

/** 管理员账号状态写权威端口（停用/启用）。`persistent: true` 表示落在真实 PostgreSQL 上。 */
export interface AdminAccountStateAuthority {
  readonly persistent: true;
  disable(action: AdminAccountStateAction): Promise<AdminAccountStateOutcome>;
  enable(action: AdminAccountStateAction): Promise<AdminAccountStateOutcome>;
}

/**
 * 形状/契约校验失败一律 `retryable: false`：这些检查全部跑在 `COMMIT` **之后**
 * （`call()` 里 `toOutcome(raw)` 位于事务之外），写早已落地。此刻若标可重试，调用方会带同一个
 * 旧 `If-Match` 重跑，必然撞 `G0003` 409 —— 重试一定不成功（`errors.ts` 对 `retryable` 的定义
 * 就是「重试能否成功」），故如实标为不可重试。
 */
function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `管理员账号状态变更返回缺少字段 ${field}`, { retryable: false });
  }
  return value;
}

function asInteger(value: unknown, field: string, min = 0): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `管理员账号状态变更返回字段 ${field} 不是整数`, { retryable: false });
  }
  return n;
}

/**
 * 函数返回的 JSON 必须是预期形状；形状不符 ⇒ **失败关闭**（`PROVIDER_UNAVAILABLE`），
 * 绝不把「读不懂的返回」当成停用成功。
 *
 * ⚠ 这里对 `revoked_sessions` 只做**形状**校验（非负整数），不做「停用必须 > 0」的断言：
 * 目标可能本来就没有活动会话（刚建号、或早已被踢），那是合法的 0。把 0 当失败会把一次
 * 已经提交的停用折成 503 —— 正是本仓反复禁止的「用响应码撒谎」。
 */
function toOutcome(raw: unknown, expected: AdminAccountState): AdminAccountStateOutcome {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '管理员账号状态变更返回不是对象', { retryable: false });
  }
  const row = raw as Record<string, unknown>;
  const administratorId = asNonEmptyString(row['admin_id'], 'admin_id');
  const revision = asInteger(row['revision'], 'revision', 1);
  const authEpoch = asInteger(row['auth_epoch'], 'auth_epoch', 0);
  const revokedSessions = asInteger(row['revoked_sessions'], 'revoked_sessions', 0);
  const stateRaw = row['state'];
  if (!ACCOUNT_STATES.includes(stateRaw as AdminAccountState)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `管理员账号状态变更返回的 state 不在闭集内：${String(stateRaw)}`, {
      retryable: false,
    });
  }
  const state = stateRaw as AdminAccountState;
  // 状态与调用语义不符 ⇒ 返回不可信（例如调 disable 却回 active）：此时库里到底发生了什么
  // 已无从判断，只能失败关闭，绝不返回一个「看起来成功了」的 200。
  if (state !== expected) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `管理员账号状态变更返回的 state 与动作不符：期望 ${expected}，实得 ${state}`, {
      retryable: false,
    });
  }
  const changed = row['changed'];
  if (typeof changed !== 'boolean') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '管理员账号状态变更返回字段 changed 不是布尔', { retryable: false });
  }
  const auditIdRaw = row['audit_id'];
  if (auditIdRaw !== null && typeof auditIdRaw !== 'string') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '管理员账号状态变更返回字段 audit_id 形状不对', { retryable: false });
  }
  // `changed=true` 必须有审计 id；`changed=false` 必须是 null。两者不一致 ⇒ 返回不可信。
  if (changed !== (auditIdRaw !== null)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '管理员账号状态变更返回的 changed 与 audit_id 不自洽', { retryable: false });
  }
  return { administratorId, revision, state, authEpoch, revokedSessions, changed, auditId: auditIdRaw };
}

/** PostgreSQL 错误 → 契约错误码（不透出驱动原文；权限缺失按「不可用」如实失败）。 */
export function mapAdminAccountAuthorityError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown })?.code;
  const sqlState = typeof code === 'string' ? code : '';
  if (sqlState === 'G0001') throw new ApiError('INVALID_REQUEST', '管理员账号状态变更参数非法');
  if (sqlState === 'G0002') throw new ApiError('NOT_FOUND', '管理员不存在');
  if (sqlState === 'G0003') throw new ApiError('REVISION_CONFLICT', '目标修订已变化，If-Match 与当前 ETag 不匹配');
  // 与 `0041` **同一个**码：两处说的都是「这个动作会让系统永久失去授权维护能力」。
  if (sqlState === 'G0009') {
    throw new ApiError('LAST_SCOPE_MANAGER', '停用会使最后一名 scopes:write 持有者消失，系统将永久失去授权维护能力', {
      retryable: false,
    });
  }
  if (sqlState === 'G0010') throw new ApiError('SCOPE_DENIED', '缺少后台权限 scopes:write');
  // 本片新增码：自停用是**业务规则**而不是「缺权限」，故不复用 403 `SCOPE_DENIED`
  // （那会让值班以为补个 scope 就能过）。`retryable: false` 是契约写死的。
  if (sqlState === 'G0020') {
    throw new ApiError('SELF_DISABLE_DENIED', '不能停用自己；请由另一名持 scopes:write 的管理员执行', {
      retryable: false,
    });
  }
  if (sqlState === '57014' || sqlState === '55P03') {
    throw new ApiError('PROVIDER_TIMEOUT', '管理员账号状态变更事务超时', { retryable: true });
  }
  // `42501`（权限不足）/`42883`（函数不存在）/`23505`（审计 id 撞主键）走同一条「不可用」分支：
  // ⛔ 不降级、⛔ 不改走内存路径、⛔ 不假装成功。
  throw new ApiError('PROVIDER_UNAVAILABLE', '管理员账号状态变更暂不可用', { retryable: false });
}

/**
 * 归还连接只许「尽力而为」：`release()` 抛错（连接已被池回收、池已关闭、重复释放）不得把
 * 403/409 改写成 500。与 `scope-authority-pg.ts` 的 `releaseQuietly` 是同一条不变量的两半。
 */
function releaseQuietly(client: PoolClient | undefined): void {
  try {
    client?.release();
  } catch {
    // 释放失败只影响这条连接能否回到池里，与本次业务结论无关。
  }
}

/**
 * 建持久化的管理员账号状态写权威。
 *
 * 构造期**不**探测函数是否存在（探测会把「迁移没跑」变成启动期崩溃）；也**不**校验
 * `pool.connect` 的形状（既有装配里 `pool` 允许最小替身）。函数缺失/无事务能力在**调用期**
 * 以 `42501`/`42883`/无 `connect` ⇒ `PROVIDER_UNAVAILABLE` 如实失败，写面不会伪造成功。
 */
export function createPostgresAdminAccountStateAuthority({
  pool,
  log,
}: {
  pool: PgPool;
  /**
   * 可选日志口（与 `createPostgresAdminScopeAuthority` 同形）。只记**失败**的 SQLSTATE，
   * ⛔ 不记 `reason` 原文、⛔ 不记任何令牌/UUID 之外的请求体 —— 停用原因可能含人事情报。
   */
  log?: { warn(obj: Record<string, unknown>, msg?: string): void };
}): AdminAccountStateAuthority {
  async function call(
    sql: string,
    expected: AdminAccountState,
    action: AdminAccountStateAction,
  ): Promise<AdminAccountStateOutcome> {
    if (!pool || typeof pool.connect !== 'function') {
      // 没有事务能力 ⇒ 如实不可用（fail closed，不是静默跳过持久化）。
      throw new ApiError('PROVIDER_UNAVAILABLE', '管理员账号状态变更暂不可用', { retryable: false });
    }
    if (
      !UUID_RE.test(action.actorId)
      || !UUID_RE.test(action.auditId)
      || !UUID_RE.test(action.targetId)
      || !UUID_RE.test(action.requestId)
    ) {
      throw new ApiError('INVALID_REQUEST', '管理员账号状态变更参数非法');
    }
    if (typeof action.reason !== 'string' || action.reason.trim() === '' || [...action.reason].length > 500) {
      throw new ApiError('INVALID_REQUEST', '管理员账号状态变更参数非法', {
        details: [{ field: 'reason', code: 'length' }],
      });
    }
    if (action.expectedRevision !== null && !(Number.isSafeInteger(action.expectedRevision) && action.expectedRevision >= 1)) {
      throw new ApiError('INVALID_REQUEST', '管理员账号状态变更参数非法');
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
        action.targetId,
        action.expectedRevision,
        action.requestId,
        action.reason,
      ]);
      raw = result.rows[0]?.['result'];
      await client.query('COMMIT');
    } catch (error) {
      // 失败两步的顺序即纪律（与 `scope-authority-pg.ts` 同一段注释）：① 先 ROLLBACK
      // （被拒那一笔必须整笔消失）；② 再归还连接（⛔ 不得在还占着连接时做任何旁路写）；③ 映射错误。
      if (client !== undefined) await client.query('ROLLBACK').catch(() => {});
      releaseQuietly(client);
      client = undefined;
      // 只记 SQLSTATE 与目标 id，⛔ 不记 reason 原文（可能含人事情报）。
      const sqlState = (error as { code?: unknown })?.code;
      log?.warn({ sqlState: typeof sqlState === 'string' ? sqlState : null, targetId: action.targetId }, '管理员账号状态变更失败');
      return mapAdminAccountAuthorityError(error);
    } finally {
      releaseQuietly(client);
    }
    // 解析放在事务之外：返回形状不符 ⇒ 失败关闭，但不影响已提交的事务（不会误发 ROLLBACK 警告）。
    return toOutcome(raw, expected);
  }

  return {
    persistent: true,
    disable: (action) => call(CALL_DISABLE_SQL, 'suspended', action),
    enable: (action) => call(CALL_ENABLE_SQL, 'active', action),
  };
}
