/**
 * S4-S3 P2-a · 第三方删除的**真库端口**（PG 适配层，迁移
 * `services/api/db/migrations/0044_third_party_deletion_persistence.sql`）。
 *
 * 本切片**只**给端口与单测：装配（`app.ts`、路由、契约接线）是 P2-b，这里不 import 任何装配点。
 *
 * ## 为什么只能走函数（表不可直写）
 * `public.third_party_deletions` 对运行时角色**零 DML 权限**：没有 INSERT/UPDATE，
 * **也没有 SELECT**（`0044:17-22` 的裁定：读和写都必须过函数，P2 不可能直接查表）。
 * 授权只有 `deploy/postgres-cvm/sql/20-login-roles.sql` 对这两个函数的一条 `EXECUTE`
 * ——`0044:307-310` 先 `REVOKE ALL … FROM PUBLIC`，再只授 `EXECUTE`。
 * 因此本文件**不拼 DDL/DML**，只调：
 *   - 写：`public.record_third_party_deletion(uuid, text, uuid, text, text, text, timestamptz)` → `jsonb`
 *   - 读：`public.list_third_party_deletions(uuid)` → `RETURNS TABLE` 八列
 * 两个函数都是 `SECURITY DEFINER`（`SET search_path = pg_catalog`、`SET TimeZone = 'UTC'`）。
 * 函数缺失/权限没补 ⇒ `42883`/`42501` ⇒ 503 `retryable:false`（**不降级**成内存实现、不伪造受理）。
 *
 * ## 单状态限制（P1 的已知限制，⛔ 不在本层拆）
 * 库函数只有**一个** `p_state`，它**同时**写 `online_status` 与 `backup_status` 两列
 * （状态闭集见 `0044:112`，两列同值写入见 `0044:196-198`）。「线上/备份分置」是**改库层**的事
 * （那是另一次迁移），所以本端口只接受一个 `state`，⛔ 不提供 `onlineState`/`backupState`
 * 分别入参的重载——那会在 P2-b 造出「看着能分、实际分不了」的假接口。
 *
 * ## `G0003` 不是并发重试
 * `G0003`（⇒ `REVISION_CONFLICT` 409）在 0044 里表示**终态不可回退**：`confirmed`/`unsupported`
 * 之后再写任何别的状态都被拒（`0044:225-245`）。它不是乐观锁版本号 CAS，也不是「并发双写、
 * 稍后重试就好」——重试**永远**得到同一个结果。调用方该做的是先读
 * （`listThirdPartyDeletions`）确认现状再决定，而不是退避重试。
 * 本层因此把 `G0003` 的文案按功能面改写：共用映射表里那句是注销面的「已在受理中」。
 *
 * ## 错误码：零新增（复用 0016 的同一张 G 码表，不复制第二份）
 * 统一入口 `mapSqlError()`：除 `G0003` 的文案外，全部判定交给
 * `deletion-requests-pg.ts` 的 `mapDeletionError()`（见该文件 `:172-193`）：
 *   - `G0001` ⇒ `INVALID_REQUEST`(400)     参数非法
 *   - `G0002` ⇒ `NOT_FOUND`(404)           请求/导出物不存在（`23503` 也被库层折成它）
 *   - `G0003` ⇒ `REVISION_CONFLICT`(409)   终态不可回退（⛔ 不是并发重试，见上）
 *   - `57014`/`55P03` ⇒ `PROVIDER_TIMEOUT`(504)
 *   - 瞬时类（`db/pool.ts:92` 的口径）⇒ `PROVIDER_UNAVAILABLE`(503, `retryable:true`)
 *   - 其余（含 `42501`/`42883`/无法归类的驱动错误）⇒ 503 `retryable:false`
 * `retryable` 的判据只有一处：`services/api/src/db/pool.ts` 的 `isTransientDatabaseError()`
 * （本文件不另写正则，也不把那张表抄一遍）。
 *
 * ## 端口层先挡（在任何 SQL 之前）
 * 只挡两类，且**不新增库层没有的拒绝规则**：
 *   1. 库层本来也会判 `G0001` 的情形：`request_id`/`export_ref` 非 uuid、`state` 不在闭集、
 *      `confirmed` 缺 `evidence_ref`、**非** `confirmed` 带了 `evidence_ref`、`failed` 缺
 *      `error_code`、`recipient_id` 空/超 80 字符、`error_code` 超 80 字符（`0044:121-157`）；
 *   2. 库层会把 `22007`（时刻不可解析）折成 503 的情形 ⇒ 这里提前判 400。
 * 好处：调用方的错不会被报成「服务不可用」，也不会白跑一次库往返。
 */
import { ApiError } from '../errors.ts';
import type { PgPool } from '../db/pool.ts';
import { mapDeletionError } from './deletion-requests-pg.ts';

/** 写路径的精确签名（新增/改动后必须同步 `deploy/postgres-cvm/sql/90-assert-least-privilege.sql`）。 */
export const RECORD_THIRD_PARTY_DELETION_FUNCTION = 'public.record_third_party_deletion';

/** 读路径的精确签名（同上）。 */
export const LIST_THIRD_PARTY_DELETIONS_FUNCTION = 'public.list_third_party_deletions';

/**
 * 唯一一条写语句：调窄口径函数，**七个**位置参数逐个显式转型
 * ——与 `0044:97-105` 的类型序列逐字对齐：`uuid / text / uuid / text / text / text / timestamptz`。
 * 单条语句即隐式事务，函数内部三处写入由 PostgreSQL 保证原子，因此本层不需要
 * `BEGIN`/`COMMIT`，也不要求 `pool.connect`（与 `createPostgresDeletionRequestStore` 的
 * 事务用例不同：那里必须把 `lock_timeout` 和多次写入绑在同一条连接上）。
 */
const RECORD_SQL = `SELECT public.record_third_party_deletion(
  $1::uuid, $2::text, $3::uuid, $4::text, $5::text, $6::text, $7::timestamptz
) AS result`;

/**
 * 唯一一条读语句：显式列名而非 `SELECT *`——`RETURNS TABLE` 的**列序即契约**
 * （`0044:271-280`），`SELECT *` 会在库层改列序时静默错位。
 * 库层已把时刻序列化成 UTC ISO8601 文本并按 `(recipient_id, export_ref)` 固定排序（`0044:297-303`）。
 */
const LIST_SQL = `SELECT recipient_id, export_ref, online_state, backup_state,
       requested_at, confirmed_at, evidence_ref, error_code
  FROM public.list_third_party_deletions($1::uuid)`;

/** 库层可写状态闭集（`0044:112`）。 */
const WRITABLE_STATES: readonly string[] = Object.freeze([
  'requested',
  'confirmed',
  'failed',
  'unsupported',
]);

/**
 * `packages/privacy/constants.mjs:68` 的 `THIRD_PARTY_STATES` 还含 `not_requested`——
 * 那是「**没有**请求」的默认值，不是可写状态，⛔ 不要往函数里传。
 */
export type WritableThirdPartyDeletionState = 'requested' | 'confirmed' | 'failed' | 'unsupported';

/** 与 `0044:123` 的 `length(p_recipient_id) > 80` 同口径。 */
const RECIPIENT_ID_MAX_LENGTH = 80;

/** 与 `0044:130` 的 `length(p_error_code) > 80` 同口径。 */
const ERROR_CODE_MAX_LENGTH = 80;

/** 与 `deletion-requests-pg.ts` 同一条正则口径（迁移里由 `uuid` 形参本身兜底）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 库层返回的一行（写路径的 `jsonb` 与读路径的一列都收敛到这个形状）。 */
export interface ThirdPartyDeletionRecord {
  requestId: string;
  recipientId: string;
  exportRef: string | null;
  /** 线上状态（P1 单状态限制：与 `backupState` 恒等，见文件头注释）。 */
  onlineState: string;
  /** 备份状态（同上，与 `onlineState` 恒等）。 */
  backupState: string;
  /** UTC ISO8601（库层 `to_char(… , 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`，与 `Date#toISOString()` 同形）。 */
  requestedAt: string;
  confirmedAt: string | null;
  evidenceRef: string | null;
  errorCode: string | null;
}

export interface ThirdPartyDeletionWriteInput {
  /** 所属注销请求（`public.deletion_requests.id`，外键 `23503` ⇒ `G0002`）。 */
  requestId: string;
  /** 接收方标识（≤80 字符；外部系统侧的名字/ID，本层只透传）。 */
  recipientId: string;
  /** 关联导出物 uuid；`null` = 整账号面的删除（库层校验导出物属于同一请求）。 */
  exportRef?: string | null;
  /** 目标状态（闭集 4 个；`not_requested` 不可写）。 */
  state: WritableThirdPartyDeletionState;
  /** `confirmed` **必填**（库层 `G0001` 兜底），其余状态必须为 `null`。 */
  evidenceRef?: string | null;
  /** `failed` **必填**，`unsupported` 可选，`requested`/`confirmed` 由库层忽略（见 `normalizeWriteInput`）。 */
  errorCode?: string | null;
  /** 发生时刻（ISO8601 字符串；`confirmed` 时即 `confirmed_at`）。只收字符串，不做 `Date` 隐式转换。 */
  at: string;
}

export interface ThirdPartyDeletionPort {
  /** 「真库端口」的标记位（仓内 `available` 已被 `app.ts` 等处占用多种含义，⛔ 不要混用）。 */
  readonly persistent: true;
  /** 写：调 `record_third_party_deletion(...)`，返回落库后的快照（含 `requestId`）。 */
  subscribeThirdPartyDeletion(input: ThirdPartyDeletionWriteInput): Promise<ThirdPartyDeletionRecord>;
  /** 读：调 `list_third_party_deletions(...)`，按 `(recipient_id, export_ref)` 固定排序；零行 ⇒ `[]`。 */
  listThirdPartyDeletions(requestId: string): Promise<ThirdPartyDeletionRecord[]>;
}

/** 参数非法（400）。文案只给调用方看，不透出驱动原文与库内细节。 */
function invalidInput(message: string): ApiError {
  return new ApiError('INVALID_REQUEST', `第三方删除参数非法：${message}`);
}

/**
 * 返回形状不符 ⇒ **失败关闭**（503 `retryable:false`）：那是函数与客户端版本不一致的
 * 确定性缺陷，重试不会改善，⛔ 绝不把「读不懂的返回」当成写入成功。
 */
function shapeError(message: string): ApiError {
  return new ApiError('PROVIDER_UNAVAILABLE', message, { retryable: false });
}

function textOf(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw shapeError(`第三方删除返回字段 ${field} 不是字符串`);
  return raw;
}

function nullableTextOf(raw: unknown, field: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw shapeError(`第三方删除返回字段 ${field} 不是字符串或 null`);
  return raw;
}

function timestampOf(raw: unknown, field: string): string {
  const text = textOf(raw, field);
  if (!Number.isFinite(Date.parse(text))) {
    throw shapeError(`第三方删除返回字段 ${field} 不是可解析的时刻`);
  }
  return text;
}

function nullableTimestampOf(raw: unknown, field: string): string | null {
  if (raw === null || raw === undefined) return null;
  return timestampOf(raw, field);
}

/** 写路径：函数 `RETURNS jsonb`，九个键（`0044:248-258`）。 */
function toRecordFromJsonb(raw: unknown): ThirdPartyDeletionRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw shapeError('第三方删除写入返回不是对象');
  }
  const row = raw as Record<string, unknown>;
  return {
    requestId: textOf(row['request_id'], 'request_id'),
    recipientId: textOf(row['recipient_id'], 'recipient_id'),
    exportRef: nullableTextOf(row['export_ref'], 'export_ref'),
    onlineState: textOf(row['online_state'], 'online_state'),
    backupState: textOf(row['backup_state'], 'backup_state'),
    requestedAt: timestampOf(row['requested_at'], 'requested_at'),
    confirmedAt: nullableTimestampOf(row['confirmed_at'], 'confirmed_at'),
    evidenceRef: nullableTextOf(row['evidence_ref'], 'evidence_ref'),
    errorCode: nullableTextOf(row['error_code'], 'error_code'),
  };
}

/** 读路径：`RETURNS TABLE` 八列（`0044:271-280`），没有 `request_id`——入参即该值，用入参补齐。 */
function toRecordFromRow(raw: unknown, requestId: string): ThirdPartyDeletionRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw shapeError('第三方删除读取返回行不是对象');
  }
  const row = raw as Record<string, unknown>;
  return {
    requestId,
    recipientId: textOf(row['recipient_id'], 'recipient_id'),
    exportRef: nullableTextOf(row['export_ref'], 'export_ref'),
    onlineState: textOf(row['online_state'], 'online_state'),
    backupState: textOf(row['backup_state'], 'backup_state'),
    requestedAt: timestampOf(row['requested_at'], 'requested_at'),
    confirmedAt: nullableTimestampOf(row['confirmed_at'], 'confirmed_at'),
    evidenceRef: nullableTextOf(row['evidence_ref'], 'evidence_ref'),
    errorCode: nullableTextOf(row['error_code'], 'error_code'),
  };
}

interface NormalizedWrite {
  requestId: string;
  recipientId: string;
  exportRef: string | null;
  state: WritableThirdPartyDeletionState;
  evidenceRef: string | null;
  errorCode: string | null;
  at: string;
}

/**
 * 端口层前置校验（**任何 SQL 之前**跑完）。规则逐条对应库层的 `G0001` 分支
 * （`0044:121-157`），⛔ 不新增库层没有的拒绝规则——库层放行的，这里就放行。
 */
function normalizeWriteInput(input: ThirdPartyDeletionWriteInput): NormalizedWrite {
  if (input === null || typeof input !== 'object') throw invalidInput('入参不是对象');
  const { requestId } = input;
  if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
    throw invalidInput('request_id 不是 uuid');
  }
  const exportRef = input.exportRef ?? null;
  if (exportRef !== null && (typeof exportRef !== 'string' || !UUID_RE.test(exportRef))) {
    throw invalidInput('export_ref 不是 uuid');
  }
  const { recipientId } = input;
  if (typeof recipientId !== 'string' || recipientId.trim() === '') {
    throw invalidInput('recipient_id 为空');
  }
  if (recipientId.length > RECIPIENT_ID_MAX_LENGTH) {
    throw invalidInput(`recipient_id 超过 ${RECIPIENT_ID_MAX_LENGTH} 字符`);
  }
  const state = input.state;
  if (typeof state !== 'string' || !WRITABLE_STATES.includes(state)) {
    throw invalidInput('state 不在闭集 requested/confirmed/failed/unsupported 内');
  }
  const evidenceRef = input.evidenceRef ?? null;
  if (state === 'confirmed') {
    if (typeof evidenceRef !== 'string' || evidenceRef.trim() === '') {
      throw invalidInput('confirmed 必须带 evidence_ref');
    }
  } else if (evidenceRef !== null) {
    throw invalidInput('只有 confirmed 可以带 evidence_ref');
  }
  const errorCode = input.errorCode ?? null;
  if (state === 'failed' && (typeof errorCode !== 'string' || errorCode.trim() === '')) {
    throw invalidInput('failed 必须带 error_code');
  }
  if (errorCode !== null) {
    if (typeof errorCode !== 'string' || errorCode.length > ERROR_CODE_MAX_LENGTH) {
      throw invalidInput(`error_code 超过 ${ERROR_CODE_MAX_LENGTH} 字符`);
    }
  }
  // `requested`/`confirmed` 带 error_code：库层**静默丢弃**（`0044:148-157` 只强制 `failed`，
  // 与那里注释的口径不一致）。本层照库层放行、不另立规则；调用方别指望它被写进列。
  if (typeof input.at !== 'string' || !Number.isFinite(Date.parse(input.at))) {
    // 库层对不可解析的 timestamptz 报 `22007` ⇒ 会被折成 503；在这里提前判 400 更诚实。
    throw invalidInput('at 不是可解析的 ISO8601 时刻');
  }
  return { requestId, recipientId, exportRef, state: state as WritableThirdPartyDeletionState, evidenceRef, errorCode, at: input.at };
}

/**
 * SQL 错误 → 既有契约错误码的**唯一**入口（本文件所有 `catch` 都走它）。
 *
 * 除 `G0003` 的文案外全部委托给 `deletion-requests-pg.ts::mapDeletionError()`：
 * 码表只有一份，本层不复制（新增/改动 G 码时**不用**改两个地方）。
 */
export function mapSqlError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code === 'G0003') {
    // 终态不可回退（`0044:225-245`）：这不是并发重试，也不是「已在受理中」。
    throw new ApiError('REVISION_CONFLICT', '该接收方的第三方删除已是终态，不可回退');
  }
  mapDeletionError(error);
}

/**
 * 建第三方删除的**真库端口**。
 *
 * 构造期**只**做形状守卫（同 `ledger-pg.ts:777` 的口径），**不**探测函数是否存在
 * （口径见 `deletion-requests-pg.ts:195-209`：探测会把「迁移没跑」变成启动期崩溃，
 * 而函数缺失在调用期以 `42883` ⇒ 503 如实失败）。也不实现 `close()`：池子的生命周期
 * 归装配方，端口不持有资源。
 */
export function createPostgresThirdPartyDeletionPort({ pool }: { pool: PgPool }): ThirdPartyDeletionPort {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('createPostgresThirdPartyDeletionPort 需要 pg 连接池');
  }
  return {
    persistent: true,
    async subscribeThirdPartyDeletion(input) {
      const write = normalizeWriteInput(input);
      const rows = await queryOrThrow(pool, RECORD_SQL, [
        write.requestId,
        write.recipientId,
        write.exportRef,
        write.state,
        write.evidenceRef,
        write.errorCode,
        write.at,
      ]);
      const raw = rows[0]?.['result'];
      if (raw === undefined) throw shapeError('第三方删除写入返回零行');
      return toRecordFromJsonb(raw);
    },
    async listThirdPartyDeletions(requestId) {
      if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
        throw invalidInput('request_id 不是 uuid');
      }
      const rows = await queryOrThrow(pool, LIST_SQL, [requestId]);
      return rows.map((row) => toRecordFromRow(row, requestId));
    },
  };
}

async function queryOrThrow(
  pool: PgPool,
  text: string,
  values: readonly unknown[],
): Promise<ReadonlyArray<Record<string, unknown>>> {
  try {
    const result = await pool.query(text, values as unknown[]);
    return (result.rows ?? []) as ReadonlyArray<Record<string, unknown>>;
  } catch (error) {
    mapSqlError(error);
  }
}
