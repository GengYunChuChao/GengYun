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

/** 库内只读函数（迁移 0033）。 */
export const LIST_AUDIT_LOG_FUNCTION = 'public.list_admin_audit_logs';

/** 唯一一条 SQL：常量文本，七个占位符全部显式转型（避免默认值把实参推断成别的类型）。 */
const SELECT_AUDIT_LOG_SQL = `SELECT id, actor_id, action, scope, target_ref, target_hint, reason_code, request_id, result::text AS result, before_value, after_value, created_at FROM public.list_admin_audit_logs($1::integer, $2::timestamptz, $3::timestamptz, $4::text[], $5::text[], $6::timestamptz, $7::uuid)`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 契约 `AuditEvent.result` 闭集（逐值抄自 `packages/contracts/openapi.json`）。 */
const AUDIT_RESULTS = ['accepted', 'denied', 'failed'] as const;

/** 契约 `FlagReading`（`before_value` / `after_value` 的形状）。 */
export interface AuditLogReading {
  readonly enabled: boolean;
  readonly revision: number;
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

/** 键集位置：上一页最后一条的 `(created_at, id)`。 */
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

/** jsonb 读数 → `{enabled, revision}`；非开关行历史为 NULL，如实保留 null。 */
function toAuditLogReading(raw: unknown): AuditLogReading | null {
  if (raw === null || raw === undefined) return null;
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
 * jsonb `target_ref` → 契约 `TargetRef`。
 *
 * 今天三类写入点都写 `NULL`（0017 的两处 INSERT 与 0027 的 `set_flag` 都是 `NULL`），
 * 非空值只会来自**未来**的写入点。因此这里按契约闭集严格校验：
 * `type` 必须是 `TargetRef.type` 的 16 个成员之一、`id` 1..80 字符、`revision` 正整数；
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
    before_value: toAuditLogReading(raw['before_value']),
    after_value: toAuditLogReading(raw['after_value']),
  };
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
        const at = new Date(before.createdAt);
        if (Number.isNaN(at.getTime()) || !UUID_RE.test(before.id)) {
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
      return { items: rows.slice(0, limit).map((row) => toAuditLogRow(row)), hasMore };
    },
  };
}
