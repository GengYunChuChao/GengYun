/**
 * 后台审计日志查询面 · PostgreSQL 只读适配器（R34 切片 · Refs #18）。
 *
 * ## 为什么走库内函数而不是直接 `SELECT`
 * `public.admin_audit_events` 对运行时角色（`gengyun_api_runtime`）是**零表级权限**
 * （0017 裁定的最小权限，本片不动它）。读面因此走迁移 0033 的
 * `public.list_admin_audit_logs(...)`：`SECURITY DEFINER` + 固定 `search_path`，
 * 参数全绑定、`LIMIT` 在函数内收口。本文件里**没有**任何字符串拼接的 SQL
 * （唯一一条 SQL 是常量，参数一律走 `$1..$7`）。
 *
 * ## 出口形状 = 契约 `AuditEvent`
 * 逐字段按 `packages/contracts/openapi.json` 的形状校验；**任何**形状不符都整页 503，
 * ⛔ 不静默丢字段、也不把陌生行当审计事实展示（审计面的"差不多"等于伪造）。
 * 唯一例外是 `before_value` / `after_value`：它们**按 `action` 分派**（见 `AUDIT_READING_KIND` 与
 * `toAuditLogReading`）—— 只有确实写开关读数的动作（今天只有 `set_flag`）走严格校验，
 * 其余动作如实返回 `null`（契约只给这两个字段留了 `FlagReading | null` 一种类型）。
 * 注意列名映射：库里是 `actor_id`，契约里是 `actor`（`AuditEvent.actor`，uuid|null）。
 *
 * ## 分页
 * 键集 `(created_at DESC, id DESC)`，多取一行判「还有下一页」，不额外 `COUNT(*)`
 * （跨页时快照统计会与条目互相打脸）。`before` 来自服务层解签后的游标位置。
 */
import { ApiError, type FieldError } from '../../errors.ts';
import { isTransientDatabaseError, type PgPool } from '../../db/pool.ts';
import { TARGET_REF_TYPES } from '../fields.ts';
import type { AuditResult, TargetRefValue } from '../types.ts';
import {
  AUDIT_ACTION_ACCOUNT_RESTORE,
  AUDIT_ACTION_ACCOUNT_SUSPEND,
  AUDIT_ACTION_ADMIN_SCOPE_DENY,
  AUDIT_ACTION_ADMIN_SCOPE_GRANT,
  AUDIT_ACTION_ADMIN_SCOPE_REVOKE,
  AUDIT_ACTION_JOB_CANCEL,
  AUDIT_ACTION_POST_HIDE,
  AUDIT_ACTION_SET_FLAG,
} from './catalog.ts';
import type { AdminAuditAction } from './catalog.ts';

/** 库内只读函数（迁移 0033）。 */
export const LIST_AUDIT_LOG_FUNCTION = 'public.list_admin_audit_logs';

/**
 * 唯一一条 SQL：常量文本，七个占位符全部显式转型（避免默认值把实参推断成别的类型）。
 *
 * `cursor_position` 是**只给游标用**的微秒精度文本列（`to_char(…, '…SS.US…')`）：
 * `created_at` 走 JSON 出口时必须保持契约的 `date-time`（毫秒 ISO 即可），而键集位置
 * 一旦被截到毫秒就会漏行 —— 见 `AdminAuditLogPage.nextPosition` 的注释。
 * 这一列不进 `AdminAuditLogEntry`，所以契约 `additionalProperties: false` 不受影响。
 */
const SELECT_AUDIT_LOG_SQL = `SELECT l.id, l.actor_id, l.action, l.scope, l.target_ref, l.target_hint, l.reason_code, l.request_id, l.result::text AS result, l.before_value, l.after_value, l.created_at, to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_position FROM public.list_admin_audit_logs($1::integer, $2::timestamptz, $3::timestamptz, $4::text[], $5::text[], $6::timestamptz, $7::uuid) AS l`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 键集位置的时间串：`YYYY-MM-DDTHH:MM:SS.uuuuuuZ`（**恰好 6 位微秒**，UTC）。
 *
 * 为什么必须六位：PG 的 `timestamptz` 精度是微秒，而 JS 的 `Date` 只有毫秒。用毫秒位置
 * 继续翻页时，「同一毫秒内、微秒更晚」的行会被整片跳过（`(created_at,id) < (位置,id)`
 * 把 .123456 截成 .123，于是 .123001…123999 全部落在「已经翻过」的那一侧）。
 * 只接受六位是**故意 fail-closed**：三位位置无法知道它截掉了哪些行，宁可让调用方
 * 从第一页重来（`INVALID_CURSOR`），也不静默漏数据。
 */
export const AUDIT_LOG_POSITION_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** 契约 `AuditEvent.result` 闭集（逐值抄自 `packages/contracts/openapi.json`）。 */
const AUDIT_RESULTS = ['accepted', 'denied', 'failed'] as const;

/** 契约 `FlagReading`（`before_value` / `after_value` 的形状）。 */
export interface AuditLogReading {
  readonly enabled: boolean;
  readonly revision: number;
}

/**
 * 审计行读数的**语义分类**：`flag_reading` 是真的开关读数；`unexposed` 是今天不在契约读面上。
 *
 * 为什么必须显式分类：契约 `AuditEvent.before_value` / `after_value` 的类型是 `FlagReading`
 * （`{enabled, revision}`，`additionalProperties: false`），但库里今天的 `jsonb` 有三种形状：
 *   - `{enabled, revision}`：**只有** `set_flag`（迁移 0027 的 `set_feature_flag` 同事务写入）；
 *   - `{scopes, reason}`：`admin_scope.grant` / `admin_scope.revoke`
 *     （迁移 `0041_admin_scope_write_authority.sql:326-327` / `:479-480` 写的是
 *     `jsonb_build_object('scopes', …, 'reason', …)`）；
 *   - `NULL`：`account.suspend` / `account.restore`（0017）、`job.cancel`（0043）、
 *     `admin_scope.deny`（0046）、`post.hide`（0047）。
 * 读函数 `0033_admin_audit_log_read.sql:96-107` 只按时间/动作/scope/actor 过滤，**没有形状过滤**
 * ⇒ 0041 的行必然流到这里，所以「哪些 action 带开关读数」必须是一张**显式映射**，不能按形状猜。
 */
type AuditReadingKind = 'flag_reading' | 'unexposed';

/**
 * `action` → 读数语义（**唯一一张表**，不写散落的字符串比较）。
 *
 * 为什么用 `Record<AdminAuditAction, …>`：闭集（`catalog.ts` 的 `AUDIT_ACTIONS`）新增动作时
 * `tsc` 会在这里报缺项，逼着作者为它声明读数语义，而不是静默继承某个默认分支。
 * 闭集外的 action（历史行里可能残留、后来移出 `AUDIT_ACTIONS` 的字符串）按 `unexposed` 处理。
 *
 * 导出只为一件事：`tests/unit/admin-audit-logs.test.mjs` 用 `Object.keys` 与 `AUDIT_ACTIONS`
 * 做**集合与顺序**的双向比对（`Record` 的编译期检查只管「不漏」，构造方式一变就靠这条运行时钉子兜底）。
 */
export const AUDIT_READING_KIND: Readonly<Record<AdminAuditAction, AuditReadingKind>> = Object.freeze({
  [AUDIT_ACTION_ACCOUNT_SUSPEND]: 'unexposed',
  [AUDIT_ACTION_ACCOUNT_RESTORE]: 'unexposed',
  [AUDIT_ACTION_SET_FLAG]: 'flag_reading',
  [AUDIT_ACTION_JOB_CANCEL]: 'unexposed',
  [AUDIT_ACTION_ADMIN_SCOPE_GRANT]: 'unexposed',
  [AUDIT_ACTION_ADMIN_SCOPE_REVOKE]: 'unexposed',
  [AUDIT_ACTION_ADMIN_SCOPE_DENY]: 'unexposed',
  [AUDIT_ACTION_POST_HIDE]: 'unexposed',
});

/** 该 action 的读数语义；闭集外一律 `unexposed`（今天没有契约读面能表达它们的读数）。 */
export function readingKindOf(action: string): AuditReadingKind {
  return (AUDIT_READING_KIND as Readonly<Record<string, AuditReadingKind>>)[action] ?? 'unexposed';
}

/** 契约 `AuditEvent`（本片读面的条目形状；`actor_id` 在此改名为 `actor`）。 */
export interface AdminAuditLogEntry {
  readonly id: string;
  readonly action: string;
  readonly scope: string;
  readonly target_ref: TargetRefValue | null;
  readonly reason_code: string;
  readonly request_id: string;
  readonly result: AuditResult;
  readonly created_at: string;
  readonly actor: string | null;
  readonly target_hint: string | null;
  readonly before_value: AuditLogReading | null;
  readonly after_value: AuditLogReading | null;
}

/**
 * 键集位置：上一页最后一条的 `(位置时间, id)`。
 *
 * `createdAt` 是**六位微秒的 UTC 文本**（`AUDIT_LOG_POSITION_RE`），不是契约里的
 * `created_at`：后者为了 JSON 形状只能给毫秒。
 */
export interface AdminAuditLogCursor {
  readonly createdAt: string;
  readonly id: string;
}

/** 查询筛选（已由服务层判定过闭集与格式；这里只负责绑定参数）。 */
export interface AdminAuditLogFilters {
  readonly limit: number;
  readonly from: string | null;
  readonly to: string | null;
  /** `action` 闭集取值；`null` = 不筛。 */
  readonly actions: readonly string[] | null;
  /** 由 `entity` 映射来的 `scope` 列取值；`null` = 不筛。 */
  readonly scopes: readonly string[] | null;
  readonly before: AdminAuditLogCursor | null;
}

export interface AdminAuditLogPage {
  readonly items: AdminAuditLogEntry[];
  readonly hasMore: boolean;
  /**
   * 下一页的键集位置（**微秒精度**），`hasMore` 为真时必须给。
   *
   * ⛔ 不要用 `items[last].created_at` 拼这个位置：那个字段是契约字段（毫秒 ISO），
   * 用它继续翻页会漏掉同一毫秒内微秒更大的行 —— 真库臂 `同毫秒不同微秒` 用例专门盯这条。
   * `null` 只在 `hasMore === false` 时合法（服务层会拒绝「还有下一页却没有位置」）。
   */
  readonly nextPosition: AdminAuditLogCursor | null;
}

export interface AdminAuditLogPort {
  readonly persistent: true;
  listAuditLogs(filters: AdminAuditLogFilters): Promise<AdminAuditLogPage>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickAuditResult(raw: unknown): AuditResult {
  if (typeof raw === 'string' && (AUDIT_RESULTS as readonly string[]).includes(raw)) {
    return raw as AuditResult;
  }
  throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志返回的 result 不在契约闭集内', { retryable: false });
}

/**
 * 严格解码**开关读数**（只有 `flag_reading` 类 action 走到这里）。
 *
 * 形状不符 ⇒ 503（⛔ 分派不等于放宽：`set_flag` 行读不懂就是读不懂）。
 */
function toFlagReading(raw: unknown): AuditLogReading {
  if (!isRecord(raw)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志的读数不是对象', { retryable: false });
  }
  const enabled = raw['enabled'];
  const revision = raw['revision'];
  if (
    typeof enabled !== 'boolean' ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志的读数形状不符', { retryable: false });
  }
  return { enabled, revision };
}

/**
 * jsonb 读数 → 契约 `AuditEvent.before_value` / `after_value`（**按 `action` 分派**）。
 *
 * - `flag_reading` 类 action（今天只有 `set_flag`）：走 `toFlagReading` 严格校验，形状不符**仍然 503**；
 * - 其余 action：`NULL` 如实保留 `null`；**库里有非 null 值也返回 `null`**。
 *
 * 为什么非开关动作不能 503、也不能硬塞：契约把这两个字段的类型钉成 `FlagReading`
 * （`{enabled, revision}`，`additionalProperties: false`），只能表达**开关读数**；
 * `{scopes, reason}`（0041 的授予/撤销行）今天**不在契约读面上** —— 等后续「契约扩展」片再暴露。
 * ⛔ 不要在这里把 `{scopes, reason}` 硬塞进 `FlagReading`：契约镜像（`collectIssues('AuditEvent', …)`）
 * 会照样拒，只是把 503 从解码器挪到下一道门，问题一点没解决；⛔ 也不要因为一条
 * `admin_scope.grant` 行就让**整页** 503 —— 一条读不懂读数的行不该把其余审计事实一起藏起来。
 */
function toAuditLogReading(raw: unknown, action: string): AuditLogReading | null {
  if (raw === null || raw === undefined) return null;
  if (readingKindOf(action) === 'flag_reading') return toFlagReading(raw);
  return null;
}

/**
 * jsonb `target_ref` → 契约 `TargetRef`。
 *
 * 今天三类写入点都写 `NULL`（0017 的两处 INSERT 与 0027 的 `set_flag` 都是 `NULL`），
 * 非空值只会来自**未来**的写入点。因此这里按契约闭集严格校验：
 * `type` 必须是 `TargetRef.type` 的 17 个成员之一、`id` 1..80 字符、`revision` 正整数；
 * 不符 ⇒ 503（不把契约外的类型透给客户端，也不悄悄抹成 null 来"通过"）。
 */
function toTargetRefValue(raw: unknown): TargetRefValue | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志的 target_ref 不是对象', { retryable: false });
  }
  const type = raw['type'];
  const id = raw['id'];
  const revision = raw['revision'];
  if (typeof type !== 'string' || !(TARGET_REF_TYPES as readonly string[]).includes(type)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志的 target_ref.type 不在契约闭集内', {
      retryable: false,
    });
  }
  if (typeof id !== 'string' || [...id].length < 1 || [...id].length > 80) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志的 target_ref.id 长度不符', { retryable: false });
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志的 target_ref.revision 不是正整数', {
      retryable: false,
    });
  }
  return { type, id, revision };
}

/**
 * 审计行 → 契约 `AuditEvent`。
 *
 * `actor_id` → `actor`：库里列名与契约字段名不同，映射只在这一处发生。
 */
export function toAuditLogRow(raw: unknown): AdminAuditLogEntry {
  if (!isRecord(raw)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志返回不是对象', { retryable: false });
  }
  const id = raw['id'];
  const actor = raw['actor_id'];
  const action = raw['action'];
  const scope = raw['scope'];
  const reasonCode = raw['reason_code'];
  const requestId = raw['request_id'];
  const targetHint = raw['target_hint'];
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志的 id 不是 uuid', { retryable: false });
  }
  if (actor !== null && actor !== undefined && (typeof actor !== 'string' || !UUID_RE.test(actor))) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志的 actor 不是 uuid', { retryable: false });
  }
  if (typeof action !== 'string' || typeof scope !== 'string' || typeof reasonCode !== 'string') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志的文本字段形状不符', { retryable: false });
  }
  if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志的 request_id 不是 uuid', { retryable: false });
  }
  if (targetHint !== null && targetHint !== undefined && typeof targetHint !== 'string') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志的 target_hint 不是字符串', { retryable: false });
  }
  const createdAtRaw = raw['created_at'];
  const createdAt =
    createdAtRaw instanceof Date
      ? createdAtRaw
      : typeof createdAtRaw === 'string'
        ? new Date(createdAtRaw)
        : null;
  if (createdAt === null || Number.isNaN(createdAt.getTime())) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志的 created_at 不是合法时间戳', { retryable: false });
  }
  return {
    id,
    action,
    scope,
    target_ref: toTargetRefValue(raw['target_ref']),
    reason_code: reasonCode,
    request_id: requestId,
    result: pickAuditResult(raw['result']),
    created_at: createdAt.toISOString(),
    actor: typeof actor === 'string' ? actor : null,
    target_hint: typeof targetHint === 'string' ? targetHint : null,
    before_value: toAuditLogReading(raw['before_value'], action),
    after_value: toAuditLogReading(raw['after_value'], action),
  };
}

/**
 * 从原始行取「游标专用」位置：`(cursor_position, id)`，微秒精度。
 *
 * 为什么不让服务层拿 `items[last].created_at` 拼位置：那是契约字段，只能是毫秒 ISO；
 * 用它做键集条件会把同一毫秒内微秒更大的行整片跳过（真库臂有正反两侧读数）。
 * 位置列缺失/形状不符 ⇒ 503（fail-closed），⛔ 不退化成毫秒位置继续翻页。
 */
export function toAuditLogPosition(raw: unknown): AdminAuditLogCursor {
  if (!isRecord(raw)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志返回不是对象', { retryable: false });
  }
  const id = raw['id'];
  const position = raw['cursor_position'];
  if (
    typeof id !== 'string' ||
    !UUID_RE.test(id) ||
    typeof position !== 'string' ||
    !AUDIT_LOG_POSITION_RE.test(position) ||
    Number.isNaN(Date.parse(position))
  ) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志缺少可用的游标位置（cursor_position）', {
      retryable: false,
    });
  }
  return { createdAt: position, id };
}

/**
 * 读面失败的 `retryable` + `details` 唯一来源（口径与 `ops/flags-pg.ts` 的 `flagReadFailure` 同）。
 *
 * `retryable` **只认证据**：判据统一走 `db/pool.ts` 的 `isTransientDatabaseError`
 * （连接层 08xxx / 管理员干预 53xxx / 重启 57P0x / 串行化 40001 / 死锁 40P01 ⇒ true）；
 * 无 `code` 的无法归类错误、其余 SQLSTATE ⇒ 重试永远不会好 ⇒ false
 * （⛔ 恒 true 会把确定性失败伪装成下游抖动）。
 */
export function auditLogReadFailure(error: unknown): { retryable: boolean; details: FieldError[] } {
  const code = (error as { code?: unknown } | null)?.code;
  const sqlState = typeof code === 'string' ? code : '';
  return {
    retryable: isTransientDatabaseError(error),
    details:
      sqlState === ''
        ? [{ field: 'audit_logs', code: 'AUDIT_LOG_READ_FAILED' }]
        : [
            { field: 'audit_logs', code: 'AUDIT_LOG_READ_FAILED' },
            { field: 'db_error_code', code: sqlState },
          ],
  };
}

/**
 * 读面错误映射：权限/缺表/缺函数如实「不可用」，超时如实「可重试」。
 *
 * 兜底分支必须 fail-closed（无法归类 ⇒ 不可重试），否则权限缺失/驱动缺陷会被当作抖动被无限重试。
 * 特别地：`42883 undefined_function`（0033 未执行）⇒ 503 且 `retryable:false` ——
 * 那是部署顺序问题，重试一万次也不会好。
 */
function mapAuditLogReadError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const failure = auditLogReadFailure(error);
  throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志读取失败', failure);
}

/**
 * 建 PG 只读端口。
 *
 * `persistent: true` 是**能力自述**，本片不靠它放行任何东西（放行判据在 `app.ts`：
 * real 且拿到库池才构造本端口，见那里的注释）。
 */
export function createPostgresAdminAuditLogPort(options: { readonly pool: PgPool }): AdminAuditLogPort {
  const pool = options.pool;

  return {
    persistent: true,

    async listAuditLogs(filters: AdminAuditLogFilters): Promise<AdminAuditLogPage> {
      if (!pool || typeof pool.query !== 'function') {
        throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志读取暂不可用', { retryable: false });
      }
      const limit = filters.limit;
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new ApiError('INVALID_REQUEST', '审计日志的分页大小非法');
      }
      const before = filters.before;
      if (before !== null) {
        // 游标位置由服务层解签后给出；这里再判一次，避免把会撞 cast 错误的字符串送进库。
        // 必须是六位微秒（毫秒位置会漏行，见 AUDIT_LOG_POSITION_RE 的注释）。
        if (!AUDIT_LOG_POSITION_RE.test(before.createdAt) || !UUID_RE.test(before.id)) {
          throw new ApiError('INVALID_CURSOR', '游标位置不可解析');
        }
      }
      let rows: unknown;
      try {
        // 多取一行判「还有下一页」：键集分页不引入快照统计。
        const result = await pool.query(SELECT_AUDIT_LOG_SQL, [
          limit + 1,
          filters.from,
          filters.to,
          filters.actions === null ? null : [...filters.actions],
          filters.scopes === null ? null : [...filters.scopes],
          before === null ? null : before.createdAt,
          before === null ? null : before.id,
        ]);
        rows = result.rows;
      } catch (error) {
        return mapAuditLogReadError(error);
      }
      if (!Array.isArray(rows)) {
        throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志返回不是数组', { retryable: false });
      }
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        items: page.map((row) => toAuditLogRow(row)),
        hasMore,
        // 位置取「本页最后一行」的微秒列，而不是 `items` 里的毫秒 `created_at`。
        nextPosition: hasMore ? toAuditLogPosition(page[page.length - 1]) : null,
      };
    },
  };
}
