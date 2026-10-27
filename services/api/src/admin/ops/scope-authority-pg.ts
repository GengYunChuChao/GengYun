/**
 * `#18` S2 PR-3 · 后台管理员 scope 的**授予/撤销**唯一持久化写路径（PG 适配层）。
 *
 * ## 为什么需要这一层
 * `admin_scopes` 对运行时角色 `gengyun_api_runtime` 是**零表级、零列级写权限**
 * （`deploy/postgres-cvm/sql/90-assert-least-privilege.sql` 的 external_manifest 把表级
 * S/I/U/D 钉成 false、列级 ins/upd 为空数组；槽 9 的 `protected_columns` 再钉死 `scope` 列不可
 * UPDATE）。唯一写路径是迁移 0041 的两条窄口径 `SECURITY DEFINER` 函数
 * （`public.grant_admin_scope` / `public.revoke_admin_scope`）；运行时只拿它们的 `EXECUTE`
 * （`deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r37-s2-scope-grant` 区）。
 *
 * 本文件因此**不拼 DDL/DML、不直改任何表**，只在显式事务里 `SELECT` 一条函数：
 * 与 `admin/ops/account-authority-pg.ts`（0017 的 `suspend_account`）走同一条已裁定路线。
 *
 * ## 事务边界
 * 函数内部「锁 → 重核验操作者 → 目标行/版本/状态门 → 变更 → 版本前进 → 写审计」由 PostgreSQL
 * 保证原子；本层再用 `BEGIN`…`COMMIT` 包住**唯一一条** `SELECT` 并把 `lock_timeout` 固定为 4s
 * （与 `account-authority-pg.ts` / `privacy/ledger-pg.ts` 的 `withTransaction()` 同口径）。
 * 任一失败 ⇒ `ROLLBACK` ⇒ **零写入**：不会出现「scope 授上了但审计没落」「审计落了但版本没走」
 * 这类半成品。
 *
 * ## 错误码映射（G 码 → 既有/新增契约码；口径来源见 `0041` 的文件头）
 *   - `G0001` ⇒ `INVALID_REQUEST`(400)            参数非法
 *   - `G0002` ⇒ `NOT_FOUND`(404)                  操作者或目标管理员不存在
 *   - `G0003` ⇒ `REVISION_CONFLICT`(409)          `If-Match` 与 `admin_accounts.revision` 不符
 *   - `G0004` ⇒ `OBJECT_UNAVAILABLE`(409 域)      目标管理员 `state <> 'active'`
 *   - `G0008` ⇒ `SELF_SCOPE_GRANT_DENIED`(403)    自授（**本片新增契约码**）
 *   - `G0009` ⇒ `LAST_SCOPE_MANAGER`(409)         撤销后 `scopes:write` 有效持有者归零（**本片新增**）
 *   - `G0010` ⇒ `SCOPE_DENIED`(403)               操作者非有效管理员 / 不持 `scopes:write`
 *   - `G0011` ⇒ `SCOPE_DENIED`(403)               只能授予自己当前有效持有的 scope
 *   - `G0012` ⇒ `PROVIDER_UNAVAILABLE`(503)       **迁移期**闭集预检失败（运行期不该出现；出现即如实失败）
 *   - `42501`/`42883` ⇒ `PROVIDER_UNAVAILABLE`(503) 权限/函数缺失**绝不降级**：不换路径、不重试
 *   - `23505` ⇒ `PROVIDER_UNAVAILABLE`(503)       审计 id 撞主键（服务端缺陷，**不是**已受理）
 *   - `57014`/`55P03` ⇒ `PROVIDER_TIMEOUT`(504, retryable)
 *
 * 为什么 `G0009` 不复用 `OBJECT_UNAVAILABLE`：后者的语义是「目标当前状态不接受该动作」，
 * 运维的处置是换个目标或先改状态；`LAST_SCOPE_MANAGER` 说的是「这个动作会让系统**永久**失去
 * 授权维护能力」，处置是**先补一个元权限持有者**。把两者混成一个码，值班只能看到一句
 * 「目标状态不对」，而实际上系统正要被锁死。
 *
 * 被拒之后的留痕（`#18` S2 收尾片 · 应用层这一半，写入口是迁移 0046 的
 * `public.record_admin_scope_denial`）**不在**本文件里：它必须落在主事务 `ROLLBACK` 与连接
 * `release()` 之后的一条新连接上，失败还得全吞 —— 正好与这里的失败语义相反。见同目录
 * `scope-denial-trace.ts`（那边文件头写了为什么必须第二连接、为什么只认四个 SQLSTATE、
 * 为什么吞异常）。本文件只负责在失败分支里把这一棒交出去。
 */
import type { PoolClient } from 'pg';
import { ApiError } from '../../errors.ts';
import type { PgPool } from '../../db/pool.ts';
import { ADMIN_SCOPES, isAdminScope } from '../scopes.ts';
import {
  recordAdminScopeDenial,
  recordEarlyAdminScopeDenial,
  sqlStateOf,
  type AdminScopeDenialLogPort,
  type AdminScopeDenialSubject,
} from './scope-denial-trace.ts';

// 「早拒」这条端口契约要用的 SQLSTATE 由本模块转出：调用方（`service.ts`）只认识**端口**，
// 不必认识留痕模块（依赖方向：服务层 ⇒ 端口 ⇒ 旁路，⛔ 不许服务层直接依赖旁路细节）。
export { SELF_SCOPE_GRANT_DENIAL_SQLSTATE } from './scope-denial-trace.ts';

/** 授予：唯一写路径的精确签名（改动后必须同步 `90-assert-least-privilege.sql`）。 */
export const GRANT_ADMIN_SCOPE_FUNCTION = 'public.grant_admin_scope';
/** 撤销：唯一写路径的精确签名。 */
export const REVOKE_ADMIN_SCOPE_FUNCTION = 'public.revoke_admin_scope';

/**
 * 唯一一条语句：调用窄口径函数。
 * 七个形参全显式转型 —— 否则 PostgreSQL 会按 `unknown` 选候选函数，0041 一旦出现重载就会落到
 * 别的签名上（与 `account-authority-pg.ts` 同一纪律）。
 */
const CALL_GRANT_SQL = `SELECT public.grant_admin_scope(
  $1::uuid, $2::uuid, $3::text, $4::text, $5::uuid, $6::uuid, $7::integer
) AS result`;

const CALL_REVOKE_SQL = `SELECT public.revoke_admin_scope(
  $1::uuid, $2::uuid, $3::text, $4::text, $5::uuid, $6::uuid, $7::integer
) AS result`;

/** 写事务的锁等待上限（与 `account-authority-pg.ts` 的 4s 同口径；常量不拼接用户输入）。 */
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '4s'";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 一次授予/撤销调用的入参。`expectedRevision === null` ⇒ 无前置条件（未带 `If-Match`）。 */
export interface AdminScopeAuthorityAction {
  /** 操作主体（后台管理员 id）；审计事件的 actor。 */
  actorId: string;
  /** 审计事件 id（调用方生成 uuid；重复即审计那一步失败，用于失败注入回归）。 */
  auditId: string;
  /** 目标管理员 id（`admin_accounts.id`，⛔ 不是 `users.id`）。 */
  targetId: string;
  /** 后台权限闭集成员（库层 CHECK 兜底，应用层先判 400）。 */
  scope: string;
  /** 原因（自由文本 ≤500；落审计 before/after 的 jsonb，⛔ 不新增自由文本列）。 */
  reason: string;
  /** 契约 `Meta.request_id`。 */
  requestId: string;
  /** 强 ETag 前置条件；`null` ⇒ 不做 CAS 校验。 */
  expectedRevision: number | null;
}

/**
 * 函数**实测**读数（不是算术推断）：`administratorId`/`revision`/`scopes` 来自函数体内
 * `UPDATE ... RETURNING` 与 `array_agg`，`changed` 来自单语句 upsert / UPDATE 的行数，
 * `auditId` 来自落库后的审计行（`changed=false` 时为 `null`）。
 */
export interface AdminScopeAuthorityOutcome {
  administratorId: string;
  /** 变更后的 `admin_accounts.revision`（幂等分支即当前值）。 */
  revision: number;
  /** 变更后的**有效** scope 集合（函数内 `array_agg ... ORDER BY scope`）。 */
  scopes: string[];
  /** 本次是否真的改了库（`false` = 幂等重放，无任何副作用、无第二条审计）。 */
  changed: boolean;
  auditId: string | null;
}

/** 管理员 scope 写权威端口（授予/撤销）。`persistent: true` 表示落在真实 PostgreSQL 上。 */
export interface AdminScopeAuthority {
  readonly persistent: true;
  grant(action: AdminScopeAuthorityAction): Promise<AdminScopeAuthorityOutcome>;
  revoke(action: AdminScopeAuthorityAction): Promise<AdminScopeAuthorityOutcome>;
  /**
   * **权威之外**的那一次拒绝也要留痕：调用方在 `grant`/`revoke` **之前**就拒掉请求时用
   * （服务层自授 ⇒ 403 `SELF_SCOPE_GRANT_DENIED`，见 `service.ts` 的 `grantAdministratorScope`）。
   *
   * 为什么必须由权威提供：留痕的写入口（迁移 `0046`）与「只认四个 G 码」的口径都在这一侧。
   * 让服务层自己开连接写审计，等于把同一条纪律拆成两份实现。
   *
   * 实现是**同一条**旁路：失败语义与 `grant`/`revoke` 的 `catch` 分支完全一致 —— 全吞、只
   * `log.warn`、绝不改变主响应，`void` 返回（调用方拿不到「留痕成没成」，就不可能让它参与判定）。
   *
   * `sqlState` 仍是 **SQLSTATE**（⛔ 不是 `reason_code`）：映射表只有 `scope-denial-trace.ts` 一份。
   */
  recordEarlyDenial(subject: AdminScopeDenialSubject, sqlState: string): Promise<void>;
}

/**
 * 形状/契约校验失败一律 `retryable: false`：这些检查全部跑在 `COMMIT` **之后**
 * （`call()` 里 `toOutcome(raw)` 位于事务之外），写早已落地。此刻若标可重试，调用方会带同一个
 * 旧 `If-Match` 重跑，必然撞 `G0003` 409 —— 重试一定不成功（`errors.ts` 对 `retryable` 的定义
 * 就是「重试能否成功」），故如实标为不可重试。
 */
function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `管理员权限变更返回缺少字段 ${field}`, { retryable: false });
  }
  return value;
}

function asInteger(value: unknown, field: string): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `管理员权限变更返回字段 ${field} 不是整数`, { retryable: false });
  }
  return n;
}

/**
 * 函数返回的 JSON 必须是预期形状；形状不符 ⇒ **失败关闭**（`PROVIDER_UNAVAILABLE`），
 * 绝不把「读不懂的返回」当成授予/撤销成功。
 *
 * `scopes` 逐项过应用层闭集（`admin/scopes.ts`）：一条越界就让整条写面 503 ——
 * ⛔ 不静默丢弃该条（丢弃会把"权限不明"读成"没有这项权限"），
 * ⛔ 也不原样照抄给调用方（照抄会让契约 enum 被库里的脏值突破）。
 */
function toOutcome(raw: unknown): AdminScopeAuthorityOutcome {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '管理员权限变更返回不是对象', { retryable: false });
  }
  const row = raw as Record<string, unknown>;
  const administratorId = asNonEmptyString(row['admin_id'], 'admin_id');
  const revision = asInteger(row['revision'], 'revision');
  if (revision < 1) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '管理员权限变更返回的 revision 不是正整数', { retryable: false });
  }
  const changed = row['changed'];
  if (typeof changed !== 'boolean') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '管理员权限变更返回字段 changed 不是布尔', { retryable: false });
  }
  const auditIdRaw = row['audit_id'];
  if (auditIdRaw !== null && typeof auditIdRaw !== 'string') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '管理员权限变更返回字段 audit_id 形状不对', { retryable: false });
  }
  // `changed=true` 必须有审计 id；`changed=false` 必须是 null。两者不一致 ⇒ 返回不可信。
  if (changed !== (auditIdRaw !== null)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '管理员权限变更返回的 changed 与 audit_id 不自洽', { retryable: false });
  }
  const rawScopes = row['scopes'];
  if (!Array.isArray(rawScopes)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '管理员权限变更返回字段 scopes 不是数组', { retryable: false });
  }
  const scopes: string[] = [];
  for (const scope of rawScopes) {
    if (!isAdminScope(scope)) {
      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        `管理员权限变更返回的 scope 不在闭集内：${String(scope)}（闭集 ${ADMIN_SCOPES.length} 项，见 admin/scopes.ts）`,
        { retryable: false },
      );
    }
    scopes.push(scope);
  }
  return { administratorId, revision, scopes, changed, auditId: auditIdRaw };
}

/** PostgreSQL 错误 → 契约错误码（不透出驱动原文；权限缺失按「不可用」如实失败）。 */
export function mapAdminScopeAuthorityError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown })?.code;
  const sqlState = typeof code === 'string' ? code : '';
  if (sqlState === 'G0001') throw new ApiError('INVALID_REQUEST', '管理员权限变更参数非法');
  if (sqlState === 'G0002') throw new ApiError('NOT_FOUND', '管理员不存在');
  if (sqlState === 'G0003') throw new ApiError('REVISION_CONFLICT', '目标修订已变化，If-Match 与当前 ETag 不匹配');
  if (sqlState === 'G0004') throw new ApiError('OBJECT_UNAVAILABLE', '目标管理员当前状态不接受该动作');
  // 本片新增的两个码：`retryable: false` 是**契约写死的**（裁定⑥），不是各调用点自己判断。
  if (sqlState === 'G0008') {
    throw new ApiError('SELF_SCOPE_GRANT_DENIED', '不能把权限授予自己', { retryable: false });
  }
  if (sqlState === 'G0009') {
    throw new ApiError('LAST_SCOPE_MANAGER', '撤销会使最后一名 scopes:write 持有者消失，系统将永久失去授权维护能力', {
      retryable: false,
    });
  }
  if (sqlState === 'G0010') throw new ApiError('SCOPE_DENIED', '缺少后台权限 scopes:write');
  // G0011：只能授予自己当前有效持有的 scope。仍走既有 403 `SCOPE_DENIED`（裁定⑥只说「缺元权限等复用现有码」，
  // 没有为它新增契约码）——措辞必须与"你没有这项权限"区分开，否则值班分不清是操作者缺权限还是越权代授。
  if (sqlState === 'G0011') {
    throw new ApiError('SCOPE_DENIED', '只能授予自己当前有效持有的 scope', {
      details: [{ field: 'scope', code: 'not_held' }],
    });
  }
  if (sqlState === '57014' || sqlState === '55P03') {
    throw new ApiError('PROVIDER_TIMEOUT', '管理员权限变更事务超时', { retryable: true });
  }
  // `G0012`（迁移期闭集预检失败）/`42501`（权限不足）/`42883`（函数不存在）/`23505`（审计 id 撞主键）
  // 走同一条「不可用」分支：⛔ 不降级、⛔ 不改走内存路径、⛔ 不假装成功。
  throw new ApiError('PROVIDER_UNAVAILABLE', '管理员权限变更暂不可用', { retryable: false });
}

/**
 * 归还连接只许「尽力而为」：`release()` 抛错（连接已被池回收、池已关闭、重复释放）不得把
 * 403/409 改写成 500。与留痕侧的 `warnQuietly` 是同一条不变量的两半 —— 「旁路与收尾都不得
 * 改变主响应」。
 */
function releaseQuietly(client: PoolClient | undefined): void {
  try {
    client?.release();
  } catch {
    // 释放失败只影响这条连接能否回到池里，与本次业务结论无关。
  }
}

/**
 * 建持久化的管理员 scope 写权威。
 *
 * 构造期**不**探测函数是否存在（探测会把「迁移没跑」变成启动期崩溃）；也**不**校验
 * `pool.connect` 的形状（既有装配里 `pool` 允许最小替身）。函数缺失/无事务能力在**调用期**
 * 以 `42501`/`42883`/无 `connect` ⇒ `PROVIDER_UNAVAILABLE` 如实失败，写面不会伪造成功。
 *
 * `log` 只用于**拒绝留痕**这条旁路的 `warn`；不给就静默吞（留痕失败本就不该影响主响应）。
 */
export function createPostgresAdminScopeAuthority({
  pool,
  log,
}: {
  pool: PgPool;
  log?: AdminScopeDenialLogPort;
}): AdminScopeAuthority {
  async function call(sql: string, action: AdminScopeAuthorityAction): Promise<AdminScopeAuthorityOutcome> {
    if (!pool || typeof pool.connect !== 'function') {
      // 没有事务能力 ⇒ 如实不可用（fail closed，不是静默跳过持久化）。
      throw new ApiError('PROVIDER_UNAVAILABLE', '管理员权限变更暂不可用', { retryable: false });
    }
    if (
      !UUID_RE.test(action.actorId)
      || !UUID_RE.test(action.auditId)
      || !UUID_RE.test(action.targetId)
      || !UUID_RE.test(action.requestId)
    ) {
      throw new ApiError('INVALID_REQUEST', '管理员权限变更参数非法');
    }
    if (!isAdminScope(action.scope)) {
      throw new ApiError('INVALID_REQUEST', '管理员权限变更参数非法', {
        details: [{ field: 'scope', code: 'enum' }],
      });
    }
    if (typeof action.reason !== 'string' || action.reason.trim() === '' || [...action.reason].length > 500) {
      throw new ApiError('INVALID_REQUEST', '管理员权限变更参数非法', {
        details: [{ field: 'reason', code: 'length' }],
      });
    }
    if (action.expectedRevision !== null && !(Number.isSafeInteger(action.expectedRevision) && action.expectedRevision >= 1)) {
      throw new ApiError('INVALID_REQUEST', '管理员权限变更参数非法');
    }

    let client: PoolClient | undefined;
    let raw: unknown;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query(LOCK_TIMEOUT_SQL);
      const result = await client.query(sql, [
        action.actorId,
        action.targetId,
        action.scope,
        action.reason,
        action.requestId,
        action.auditId,
        action.expectedRevision,
      ]);
      raw = result.rows[0]?.['result'];
      await client.query('COMMIT');
    } catch (error) {
      // 失败的三步**顺序即纪律**（裁定 B）：
      // ① **先** ROLLBACK：被拒那一笔必须整笔消失（不留半成品 scope 行/审计行）。
      if (client !== undefined) await client.query('ROLLBACK').catch(() => {});
      // ② **再**释放主连接：留痕一律在**另一条**新连接上写（纪律 1）。
      //    ⛔ 不得在还占着这条连接时做旁路写：那样留痕行会跟主事务绑在一起被回滚掉。
      //    置空是为了让下面的 `finally` 成为幂等的兜底（`release()` 重复调用会抛）。
      //    `release()` 自己抛错（连接已被池回收、池已关闭）同样不得改写主响应 ⇒ 走收口函数。
      releaseQuietly(client);
      client = undefined;
      // ③ 旁路留痕：只认四个 G 码、整段吞错、单独自提交（失败只 warn，不影响 ④）。
      await recordAdminScopeDenial({ pool, subject: action, sqlState: sqlStateOf(error), log });
      // ④ 原样抛出主错误：403/409 绝不因留痕的成败而升为 500 或变成 200。
      return mapAdminScopeAuthorityError(error);
    } finally {
      releaseQuietly(client);
    }
    // 解析放在事务之外：返回形状不符 ⇒ 失败关闭，但不影响已提交的事务（不会误发 ROLLBACK 警告）。
    return toOutcome(raw);
  }

  return {
    persistent: true,
    grant: (action) => call(CALL_GRANT_SQL, action),
    revoke: (action) => call(CALL_REVOKE_SQL, action),
    // 早拒（服务层自授）：没有主事务、也没有要回滚的东西 ⇒ 直接交给同一条旁路（单语句自提交）。
    recordEarlyDenial: (subject, sqlState) => recordEarlyAdminScopeDenial({ pool, subject, sqlState, log }),
  };
}
