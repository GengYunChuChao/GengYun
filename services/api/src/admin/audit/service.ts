/**
 * 后台审计日志查询面（`GET /admin/audit-logs`）· 服务层（R34 切片 · Refs #18）。
 *
 * ## 这个读面解决什么
 * 库里 `public.admin_audit_events` 已经落了三条写路径的审计（账号停用/恢复、开关变更），
 * 但**库内没有任何通用读路径**：0027 的 `list_admin_flag_audit` 把 `action='set_flag'` 写死，
 * 而进程内的 `GET /admin/audit-events` 只看得见内存 store（real 模式实测 503）。
 * 于是「谁在什么时候停用了哪个账号」在真实持久化之后**查不到**。本片补的就是这一层：
 * 只读、按时间闭区间与动作/域筛选、键集分页。
 *
 * ## 与既有读面的关系（刻意不合并）
 * | 读面 | 权威 | 用途 |
 * | --- | --- | --- |
 * | `GET /admin/audit-events`（`listAuditEvents`） | 进程内内存台账 | 内容域（资料/分类/开关）动作的即时回显 |
 * | `GET /admin/flag-audit-events`（`listFlagAuditEvents`） | 库内 `list_admin_flag_audit` | 只看开关 A→B 的前后读数 |
 * | **`GET /admin/audit-logs`（本片）** | 库内 `list_admin_audit_logs`（迁移 0033） | **全表**只读查询：停用/恢复/开关，时间区间 + 动作/域筛选 |
 * 三个读面各自的"谁是权威"在 URL 上就能读出来；⛔ 本片**不**把内存读面改成"有时读库"的双源分页。
 *
 * ## 复用（不新造）
 * - 身份/权限门、`limit`/`cursor` 参数判定、响应信封 ← `admin/identity.ts`；
 * - 游标签名/校验 ← `admin/cursor.ts`（HMAC，客户端改不动筛选与位置）；
 * - 契约镜像校验 ← `admin/fields.ts` 的 `collectIssues('AuditEvent' | 'AuditEventPageEnvelope', …)`；
 * - 库内读取 ← `admin/audit/pg.ts` 的只读端口（迁移 0033 的 `SECURITY DEFINER` 函数）。
 *
 * ## 分页与游标
 * - 键集 `(created_at DESC, id DESC)`，与既有索引同序；⛔ 不用深 offset —— 审计表只增不减，
 *   offset 越翻越慢且会随新写入静默跳条/重条；
 * - 游标的 `watermark` 绑**筛选组合**（from/to/action/entity 的规范化串）：换了筛选就必须回第一页，
 *   否则同一个 `(created_at,id)` 位置在另一组筛选下没有意义；
 * - 游标的 `subject` 绑当前管理员：一个管理员的游标不能被另一个管理员复用。
 *
 * ## 失败关闭
 * 端口未接线（stub 默认 / real 无库池）⇒ **503 `PROVIDER_UNAVAILABLE`（`retryable:false`）**，
 * ⛔ 不返回空页：空页会被读成「平台从未发生过任何管理动作」，那是无法确认的结论。
 */
import { ApiError } from '../../errors.ts';
import type { ExecutionMode } from '../../contract.ts';
import { CURSOR_TTL_MS, createCursorCodec } from '../cursor.ts';
import { MAX_FIELD_ERRORS, collectIssues } from '../fields.ts';
import { pageResponse, parseCursorParam, parseLimit, resolveContext, UUID_RE } from '../identity.ts';
import type { MetaValue } from '../identity.ts';
import type { AdminCallContext, ServiceResponse } from '../types.ts';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  AUDIT_LOG_CURSOR_FAMILY,
  AUDIT_LOG_OPERATION_ID,
  AUDIT_LOG_SCOPE,
  scopeOfAuditEntity,
} from './catalog.ts';
import type { AdminAuditEntity } from './catalog.ts';
import type { AdminAuditLogCursor, AdminAuditLogEntry, AdminAuditLogPort } from './pg.ts';

/** 查询参数（路由层原样透传；判定全部在服务层，避免出现第二套会漂移的契约副本）。 */
export interface AdminAuditLogQuery {
  cursor?: unknown;
  limit?: unknown;
  from?: unknown;
  to?: unknown;
  action?: unknown;
  entity?: unknown;
}

/** 契约 `AuditEventPageEnvelope`。 */
export interface AdminAuditLogEnvelope {
  data: { items: AdminAuditLogEntry[]; next_cursor: string | null };
  meta: MetaValue;
}

export interface AdminAuditLogServiceOptions {
  /**
   * 只读端口。缺省/`null` ⇒ **未接线**：`listAuditLogs` 一律 503（fail-closed）。
   * 判据是**能力对象存在**，不读任何"自述持久化"布尔标志。
   */
  port?: AdminAuditLogPort | null;
  now?: () => Date;
  /** 游标签名密钥（只经内存传入，不入库、不进日志）。 */
  signingKey: string;
  /** 内存/替身场景如实标注；真实库场景由装配层传 `real`。 */
  executionMode?: ExecutionMode;
}

export interface AdminAuditLogService {
  /** 本片实现的 operationId 全集（应恰好 1 个）。 */
  readonly operationIds: readonly string[];
  listAuditLogs(ctx: AdminCallContext, query?: AdminAuditLogQuery): Promise<ServiceResponse<AdminAuditLogEnvelope>>;
}

/** 本片 operationId（机读形式，供路由映射与用例逐项核对）。 */
export const AUDIT_LOG_OPERATION_IDS: readonly string[] = Object.freeze([AUDIT_LOG_OPERATION_ID]);

/** 契约参数 `from` / `to` 的 `format: date-time`（RFC 3339，必须带时区）。 */
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 时间筛选参数。
 *
 * 为什么必须带时区：审计表是 `timestamptz`，而「2026-10-23T00:00:00」这种不带时区的串
 * 在不同部署的 `TimeZone` 下会落到不同时刻 —— 一个筛选条件两种含义，等于没有筛选。
 * 规范化成 `toISOString()` 再入参，PG 侧只做一次 `::timestamptz` 转型。
 */
function parseTimestampParam(raw: unknown, field: 'from' | 'to'): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new ApiError('INVALID_REQUEST', `${field} 必须是带时区的 RFC 3339 时间串`, {
      details: [{ field, code: 'type' }],
    });
  }
  if (!RFC3339_RE.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new ApiError(
      'INVALID_REQUEST',
      `${field} 必须是带时区的 RFC 3339 时间串（例：2026-10-23T00:00:00Z）`,
      { details: [{ field, code: 'format' }] },
    );
  }
  return new Date(raw).toISOString();
}

/** `action` 闭集判定：未知取值 400（⛔ 不静默返回空页）。 */
function parseActionParam(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new ApiError('INVALID_REQUEST', 'action 必须是字符串', { details: [{ field: 'action', code: 'type' }] });
  }
  if (!(AUDIT_ACTIONS as readonly string[]).includes(raw)) {
    throw new ApiError('INVALID_REQUEST', `action 必须是闭集之一：${AUDIT_ACTIONS.join(' / ')}`, {
      details: [{ field: 'action', code: 'enum' }],
    });
  }
  return raw;
}

/** `entity` 闭集判定（`entity` → 库内 `scope` 列，映射只在 `catalog.ts` 写一遍）。 */
function parseEntityParam(raw: unknown): AdminAuditEntity | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new ApiError('INVALID_REQUEST', 'entity 必须是字符串', { details: [{ field: 'entity', code: 'type' }] });
  }
  if (!(AUDIT_ENTITIES as readonly string[]).includes(raw)) {
    throw new ApiError('INVALID_REQUEST', `entity 必须是闭集之一：${AUDIT_ENTITIES.join(' / ')}`, {
      details: [{ field: 'entity', code: 'enum' }],
    });
  }
  return raw as AdminAuditEntity;
}

/**
 * 游标位置 `<created_at>|<id>` 解析。
 *
 * 不可解析一律 `INVALID_CURSOR`：⛔ 不把脏串传给 SQL 的 cast（那会变成 500 而不是 400）。
 */
function decodeAuditLogPosition(after: string | null): AdminAuditLogCursor | null {
  if (after === null) return null;
  const separator = after.lastIndexOf('|');
  if (separator <= 0 || separator === after.length - 1) {
    throw new ApiError('INVALID_CURSOR', '游标位置不可解析');
  }
  const createdAt = after.slice(0, separator);
  const id = after.slice(separator + 1);
  if (!UUID_RE.test(id) || Number.isNaN(Date.parse(createdAt))) {
    throw new ApiError('INVALID_CURSOR', '游标位置不可解析');
  }
  return { createdAt, id };
}

export function createAdminAuditLogService(options: AdminAuditLogServiceOptions): AdminAuditLogService {
  const port = options.port ?? null;
  const now = options.now ?? (() => new Date());
  const executionMode: ExecutionMode = options.executionMode ?? 'stub';
  const signingKey = options.signingKey;
  if (typeof signingKey !== 'string' || [...signingKey].length < 16) {
    throw new Error('后台审计日志服务需要至少 16 字符的签名密钥（只经内存传入，不入库）');
  }
  const cursors = createCursorCodec(signingKey);

  /**
   * 读面：`GET /admin/audit-logs`。
   *
   * 判定顺序刻意固定：权限门 → 接线判定 → 参数格式 → 闭集 → 游标 → 查询 → 契约镜像。
   * 权限门在最前，因此「未授权」与「参数非法」两种失败不会互相泄露（未授权一律 403，不看参数）。
   */
  async function listAuditLogs(
    ctx: AdminCallContext,
    query: AdminAuditLogQuery = {},
  ): Promise<ServiceResponse<AdminAuditLogEnvelope>> {
    const context = resolveContext(ctx, AUDIT_LOG_SCOPE);
    if (port === null || typeof port.listAuditLogs !== 'function') {
      // 未接线 ≠ 没有审计：空页会被读成「平台从未发生过任何管理动作」，那是无法确认的结论（伪造）。
      // 端口缺方法也算未接线（与 ops 域 `typeof port.listAudit !== 'function'` 的口径一致）：
      // 否则 TypeError 会冒成 500，而 500 会被读成「服务抖动、稍后重试就好」。
      throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志读取尚未接线', { retryable: false });
    }

    const limit = parseLimit(query.limit);
    const from = parseTimestampParam(query.from, 'from');
    const to = parseTimestampParam(query.to, 'to');
    if (from !== null && to !== null && Date.parse(from) > Date.parse(to)) {
      throw new ApiError('INVALID_REQUEST', 'from 必须早于或等于 to（闭区间）', {
        details: [{ field: 'from', code: 'order' }],
      });
    }
    const action = parseActionParam(query.action);
    const entity = parseEntityParam(query.entity);

    // 筛选组合的签名：游标只能在同一组筛选下继续翻页。
    const watermark = cursors.watermarkOf([from ?? '', to ?? '', action ?? '', entity ?? '']);

    const rawCursor = parseCursorParam(query.cursor);
    let before: AdminAuditLogCursor | null = null;
    if (rawCursor !== null) {
      const payload = cursors.decode(rawCursor);
      if (
        payload.kind !== 'audit' ||
        payload.family !== AUDIT_LOG_CURSOR_FAMILY ||
        payload.subject !== context.identity.userId
      ) {
        throw new ApiError('INVALID_CURSOR', '游标不属于当前查询');
      }
      if (payload.expires <= now().getTime()) throw new ApiError('INVALID_CURSOR', '游标已过期');
      if (payload.watermark !== watermark) {
        throw new ApiError('INVALID_CURSOR', '筛选条件已变化，请从第一页重新开始');
      }
      before = decodeAuditLogPosition(payload.after);
    }

    const page = await port.listAuditLogs({
      limit,
      from,
      to,
      actions: action === null ? null : [action],
      scopes: entity === null ? null : [scopeOfAuditEntity(entity)],
      before,
    });

    // 出口必须过契约镜像：库里的行不是"信任边界内"的数据（jsonb 可能被手工改过）。
    const items = page.items.map((item) => {
      const issues = collectIssues('AuditEvent', item);
      if (issues.length > 0) {
        throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志返回不符合契约 AuditEvent', {
          retryable: false,
          details: issues.slice(0, MAX_FIELD_ERRORS),
        });
      }
      return item;
    });

    const last = items[items.length - 1];
    const nextCursor =
      page.hasMore && last !== undefined
        ? cursors.encode({
            kind: 'audit',
            subject: context.identity.userId,
            family: AUDIT_LOG_CURSOR_FAMILY,
            after: `${last.created_at}|${last.id}`,
            watermark,
            expires: now().getTime() + CURSOR_TTL_MS,
          })
        : null;

    const envelope = pageResponse(context, executionMode, items, nextCursor);
    // 封套也过同一套镜像：列表语义（`items` + `next_cursor`）与 `meta` 缺一不可。
    const envelopeIssues = collectIssues('AuditEventPageEnvelope', envelope.body);
    if (envelopeIssues.length > 0) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '审计日志响应不符合契约 AuditEventPageEnvelope', {
        retryable: false,
        details: envelopeIssues.slice(0, MAX_FIELD_ERRORS),
      });
    }
    return envelope;
  }

  return { operationIds: AUDIT_LOG_OPERATION_IDS, listAuditLogs };
}
