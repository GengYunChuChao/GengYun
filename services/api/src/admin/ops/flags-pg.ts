/**
 * GY-I18（#18）· 全局开关的**唯一持久化读写路径**（PG 适配层）。
 *
 * ## 为什么是这一层
 * 开关的读面（`GET /admin/feature-flags`、以及 `flag-gate.ts` 的守卫）与写面
 * （`PUT /admin/feature-flags/:key`）此前只落在进程内 `store.ts` 的 Map 上：进程一重启，
 * 「关/开」就回到种子值，多实例之间各读各的。本文件把两端接到
 * `public.feature_flags`（迁移 `0020_feature_flags.sql`）：
 *   - 读：`SELECT key, enabled, revision`，**只读**，不 CREATE、不 UPSERT；
 *   - 写：`SELECT public.set_feature_flag(...)`，单事务内 `FOR UPDATE` 读 revision → 校验
 *     `If-Match` → CAS 递增 revision → 同事务写 `public.admin_audit_events`。
 *
 * ## 为什么不在这里拼 DML
 * 运行时角色 `gengyun_api_runtime` 对 `public.feature_flags` 只有 `SELECT`，对
 * `public.admin_audit_events` 连 SELECT 都没有（0017 固化的最小权限）。直接 `UPDATE`/`INSERT`
 * 必然 `42501`。写面收进 `SECURITY DEFINER` 函数（与 0017 的 `suspend_account` 同一手法）：
 * 审计文本在函数内写死，应用进程**无法**伪造 `action/scope/target_hint/result`。
 * 授予见 `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-i18-flags-grant` 段。
 *
 * ## 事务边界
 * 一次写入 = `BEGIN` → `SET LOCAL lock_timeout = '4s'` → 唯一一条函数调用 → `COMMIT`。
 * 函数内部五步（读锁/校验/短路/CAS/审计）由 PostgreSQL 保证原子；任一失败 ⇒ `ROLLBACK`
 * ⇒ **零写入**：不会出现「revision 递增了但审计没落」，也不会出现「审计落了但开关没变」。
 *
 * ## 失败关闭（fail-closed）
 * - 行不存在 ⇒ `get()` 返回 `null`；`commitIfCurrent` 返回 `{ok:false, reason:'NOT_FOUND'}`。
 *   调用方（`service.ts`）据此抛 404/`PROVIDER_UNAVAILABLE`，**绝不**把「缺行」当成「开」。
 * - 返回形状不符 ⇒ `PROVIDER_UNAVAILABLE`（`retryable:false`）：读不懂的返回不是成功。
 * - `42501`/`42883`/`42P01`（权限/函数/表缺失）⇒ `PROVIDER_UNAVAILABLE`（`retryable:false`）：
 *   ⛔ 不降级到内存 store、⛔ 不假装成功。
 * - `57014`/`55P03`（语句超时/锁不可用）⇒ `PROVIDER_TIMEOUT`（`retryable:true`）。
 *
 * ## 为什么返回类型不直接用 `OpsCommitResult`
 * `store.ts` 的失败联合字面量是 `'REVISION_CHANGED'`；本片裁定 §3 要求端口把 revision 不符
 * 表达为 `'REVISION_CONFLICT'`（与 HTTP 409 的既有错误码同名）。`store.ts` 不在本片允许改动的
 * 文件清单内，且改它要连带改既有单测期望值 ⇒ 这里定义结构等价、只差失败字面量的
 * `FeatureFlagsCommitResult`；`service.ts` 只读 `ok`/`record` 并按 `NOT_FOUND` 与「其余一律冲突」
 * 分支，两种端口可互换。
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError } from '../../errors.ts';
import type { PgPool } from '../../db/pool.ts';
import { CONTRACT_FLAG_KEYS } from './flags.ts';
import type { FlagKey } from './flags.ts';
import type { FlagView } from './types.ts';

/** 读面：三列，顺序固定（调用方再按契约顺序重排）。 */
const SELECT_ONE_SQL =
  'SELECT key, enabled, revision FROM public.feature_flags WHERE key = $1::text';
const SELECT_ALL_SQL =
  'SELECT key, enabled, revision FROM public.feature_flags WHERE key = ANY($1::text[])';

/** 写面唯一一条语句：八个参数全显式转型，避免参数类型推断落到别的候选函数。 */
export const SET_FEATURE_FLAG_FUNCTION = 'public.set_feature_flag';
const CALL_SET_FLAG_SQL = `SELECT public.set_feature_flag(
  $1::text, $2::integer, $3::boolean, $4::uuid, $5::uuid, $6::uuid, $7::text, $8::text
) AS result`;

/** 写事务的锁等待上限（与 `account-authority-pg.ts` 的 4s 同口径；常量不拼接用户输入）。 */
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '4s'";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 理由归一失败时的固定短码（裁定 §3：`reason_code` 取归一短码，否则此值）。 */
export const DEFAULT_FLAG_REASON_CODE = 'ADMIN_SET_FLAG';

/** 写入结果：成功带**实测**行；失败只区分「行没了」与「revision 不符」。 */
export type FeatureFlagsCommitResult =
  | { readonly ok: true; readonly record: FlagView }
  | { readonly ok: false; readonly reason: 'NOT_FOUND' | 'REVISION_CONFLICT' };

/** 开关端口（`service.ts` 只依赖这个形状；单测用假端口替身）。 */
export interface FeatureFlagsPort {
  readonly persistent: true;
  list(): Promise<readonly FlagView[]>;
  get(key: FlagKey): Promise<FlagView | null>;
  commitIfCurrent(
    key: FlagKey,
    expectedRevision: number,
    patch: { enabled: boolean },
    /**
     * `requestId` 是**可选**增量：给了就写进审计行（可回查是哪次请求改的开关），
     * 没给则新生成一个合法 uuid（审计表 `request_id` 为 NOT NULL）。
     * 其余两个字段与派单签名逐字一致。
     */
    meta: { changedBy: string | null; reason: string | null; requestId?: string | null },
  ): Promise<FeatureFlagsCommitResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContractFlagKey(value: unknown): value is FlagKey {
  return typeof value === 'string' && (CONTRACT_FLAG_KEYS as readonly string[]).includes(value);
}

/**
 * 把 `body.reason` 归一成审计短码（`^[A-Z][A-Z0-9_]{0,63}$`）。
 *
 * 规则：大写 → 非 `[A-Z0-9]` 连续段折叠成单个 `_` → 去首尾 `_` → 截 64 字符。
 * 归一后为空（例如纯中文理由）或以非字母开头 ⇒ 固定 `ADMIN_SET_FLAG`。
 * 理由原文仍完整落 `feature_flags.reason`（不脱敏、不截断；500 字符上限由契约与表约束保证）。
 */
export function flagReasonCode(reason: string | null): string {
  const normalized = String(reason ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  if (normalized.length === 0 || !/^[A-Z]/.test(normalized)) return DEFAULT_FLAG_REASON_CODE;
  return normalized;
}

/** 读面/写面返回行 → 契约形状；读不懂一律失败关闭（不是「默认关」，不是「默认开」）。 */
function toFlagView(raw: unknown, expectedKey?: FlagKey): FlagView {
  if (!isRecord(raw)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关读取返回不是对象', { retryable: false });
  }
  const key = raw['key'];
  if (!isContractFlagKey(key)) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关返回的 key 不在契约闭集内', { retryable: false });
  }
  if (expectedKey !== undefined && key !== expectedKey) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关读取返回了非目标的 key', { retryable: false });
  }
  const enabled = raw['enabled'];
  if (typeof enabled !== 'boolean') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关返回的 enabled 不是布尔', { retryable: false });
  }
  const revisionRaw = raw['revision'];
  const revision = typeof revisionRaw === 'string' ? Number(revisionRaw) : revisionRaw;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关返回的 revision 不是正整数', { retryable: false });
  }
  return { key, enabled, revision };
}

/** 读面错误映射：权限/缺表/缺函数如实「不可用」，超时如实「可重试」。 */
function mapFlagReadError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown })?.code;
  const sqlState = typeof code === 'string' ? code : '';
  if (sqlState === '57014' || sqlState === '55P03') {
    throw new ApiError('PROVIDER_TIMEOUT', '全局开关读取超时', { retryable: true });
  }
  if (sqlState === '42501' || sqlState === '42883' || sqlState === '42P01' || sqlState === '3D000') {
    throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关读取暂不可用', { retryable: false });
  }
  // 连接被掐/网络抖动等 ⇒ 可重试（读面幂等，重试无害）。
  throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关读取暂不可用', { retryable: true });
}

/** 写面错误映射：G0002/G0003 是**业务结果**（返回 ok:false），其余一律抛既有契约错误码。 */
function mapFlagWriteError(error: unknown): FeatureFlagsCommitResult {
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown })?.code;
  const sqlState = typeof code === 'string' ? code : '';
  if (sqlState === 'G0002') return { ok: false, reason: 'NOT_FOUND' };
  if (sqlState === 'G0003') return { ok: false, reason: 'REVISION_CONFLICT' };
  if (sqlState === 'G0001') throw new ApiError('INVALID_REQUEST', '全局开关写入参数非法');
  if (sqlState === '57014' || sqlState === '55P03') {
    throw new ApiError('PROVIDER_TIMEOUT', '全局开关写入事务超时', { retryable: true });
  }
  // 42501（权限）/42883（函数不存在）/42P01（表不存在）/23505（审计 id 撞主键）/
  // 23503（主体不存在）⇒ 一律如实失败，⛔ 不降级、⛔ 不假装成功。
  throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关写入暂不可用', { retryable: false });
}

/**
 * 建持久化开关端口。
 *
 * 构造期**不**探测函数是否存在（探测会把「迁移没跑」变成启动期崩溃，与
 * `createPostgresAccountAuthority` 同口径）；函数缺失/无事务能力在**调用期**以
 * `42501`/`42883`/无 `connect` ⇒ `PROVIDER_UNAVAILABLE` 如实失败。
 */
export function createPostgresFeatureFlags({ pool }: { pool: PgPool }): FeatureFlagsPort {
  async function list(): Promise<readonly FlagView[]> {
    if (!pool || typeof pool.query !== 'function') {
      throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关读取暂不可用', { retryable: false });
    }
    let rows: unknown;
    try {
      const result = await pool.query(SELECT_ALL_SQL, [[...CONTRACT_FLAG_KEYS]]);
      rows = result.rows;
    } catch (error) {
      return mapFlagReadError(error);
    }
    if (!Array.isArray(rows)) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关读取返回不是数组', { retryable: false });
    }
    return rows.map((row) => toFlagView(row));
  }

  async function get(key: FlagKey): Promise<FlagView | null> {
    if (!isContractFlagKey(key)) {
      throw new ApiError('INVALID_REQUEST', '开关 key 不在契约闭集内', {
        details: [{ field: 'key', code: 'ENUM' }],
      });
    }
    if (!pool || typeof pool.query !== 'function') {
      throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关读取暂不可用', { retryable: false });
    }
    let rows: unknown;
    try {
      const result = await pool.query(SELECT_ONE_SQL, [key]);
      rows = result.rows;
    } catch (error) {
      return mapFlagReadError(error);
    }
    if (!Array.isArray(rows)) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关读取返回不是数组', { retryable: false });
    }
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关读取返回了重复行', { retryable: false });
    }
    return toFlagView(rows[0], key);
  }

  async function commitIfCurrent(
    key: FlagKey,
    expectedRevision: number,
    patch: { enabled: boolean },
    meta: { changedBy: string | null; reason: string | null; requestId?: string | null },
  ): Promise<FeatureFlagsCommitResult> {
    if (!isContractFlagKey(key)) {
      throw new ApiError('INVALID_REQUEST', '开关 key 不在契约闭集内', {
        details: [{ field: 'key', code: 'ENUM' }],
      });
    }
    if (typeof patch?.enabled !== 'boolean') {
      throw new ApiError('INVALID_REQUEST', '开关写入缺少 enabled 布尔');
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new ApiError('INVALID_REQUEST', '开关写入的 expectedRevision 不是正整数');
    }
    const changedBy = meta?.changedBy ?? null;
    if (changedBy === null || !UUID_RE.test(changedBy)) {
      throw new ApiError('INVALID_REQUEST', '开关写入缺少合法的变更主体（后台管理员 uuid）');
    }
    const reasonCode = flagReasonCode(meta?.reason ?? null);
    const providedRequestId = typeof meta?.requestId === 'string' ? meta.requestId : null;
    const requestId = providedRequestId !== null && UUID_RE.test(providedRequestId)
      ? providedRequestId
      : randomUUID();
    if (!pool || typeof pool.connect !== 'function') {
      // 没有事务能力 ⇒ 如实不可用（fail closed，不是静默跳过持久化）。
      throw new ApiError('PROVIDER_UNAVAILABLE', '全局开关写入暂不可用', { retryable: false });
    }

    let client: PoolClient | undefined;
    let raw: unknown;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query(LOCK_TIMEOUT_SQL);
      const result = await client.query(CALL_SET_FLAG_SQL, [
        key,
        expectedRevision,
        patch.enabled,
        changedBy,
        randomUUID(),
        requestId,
        meta?.reason ?? null,
        reasonCode,
      ]);
      raw = result.rows[0]?.['result'];
      await client.query('COMMIT');
    } catch (error) {
      if (client !== undefined) await client.query('ROLLBACK').catch(() => {});
      return mapFlagWriteError(error);
    } finally {
      client?.release();
    }
    // 解析放在事务之外（与 account-authority-pg.ts 同口径）：形状不符 ⇒ 失败关闭，
    // 但不会误发 ROLLBACK 去撤销一个已经提交的事务。
    return { ok: true, record: toFlagView(raw, key) };
  }

  return { persistent: true, list, get, commitIfCurrent };
}

/**
 * 装配期的**只读就绪探测**：`public.feature_flags` 是否真的存在。
 *
 * 为什么需要：真库集成测试会只应用**迁移子集**建库（例如
 * `tests/integration/egress-ledger-pg.mjs` 只跑 0001/0003/0008/0009/0011），该库里没有 0020 的表。
 * 那种库上若仍按「real + 有池 ⇒ 武装」，开关门会在首个受控面请求上预取失败并 503 fail-closed，
 * 把与开关无关的既有面（识别受理等）打红。武装必须以「表真实可用」为前提，而不是「池非空」。
 *
 * 口径：
 * - 只跑 `to_regclass('public.feature_flags')`：schema 全限定，运行时角色受限的 `search_path`
 *   也解析得到；表不存在返回 `NULL`（不是报错），**不依赖**表级 SELECT 权限；
 * - 只有结果严格为 `true` 才算就绪；
 * - 不在本函数内缓存：是否复用由调用方按三态裁决（`flag-gate.ts` 的 `ensureReady`：
 *   确定结论 `ready`/`missing` 缓存，`unknown` 下一次判前重探）。
 *
 * ## 三态（#282 P1 修复，逐字对应监工要求）
 * 旧实现把「**确认未安装**」与「**探测异常（未知）**」折叠成同一个 `false`。这看似保守，
 * 实际是 fail-open：已接真实端口时 `flag-gate.ts` 收到 `false` 就把 `armed` 永久置 `false`，
 * 于是「一次连接/权限抖动」⇒ 开关门永久不判 ⇒ 库里的 `ai_enabled=false` 不再阻断受控面，
 * 且直到重启都不再读库。因此探测结果必须区分三态：
 * - `ready`：`to_regclass(...) IS NOT NULL` 严格为 `true` ⇒ 表真实存在，可武装并按库判定；
 * - `missing`：严格为 `false`（`NULL` ⇒ 表确实不在，迁移子集库的兼容场景）⇒ **确认未安装**，
 *   调用方允许降级（不判开关，与接线前逐字相同）；
 * - `unknown`：探测抛错（权限/连接/超时）或返回形状读不懂 ⇒ **未知 ≠ 未安装**。调用方必须
 *   保持 fail-closed（503）并允许后续重试，⛔ 不得据此退回 `open`。
 */
export const FEATURE_FLAGS_TABLE = 'public.feature_flags';
const TABLE_READY_SQL = "SELECT to_regclass('public.feature_flags') IS NOT NULL AS ready";

/**
 * 就绪探测的**三态**结果。
 *
 * `unknown` 是最重要的那一态：它**不是** `missing` —— 把「探不了」当成「没有」正是 #282 的
 * 缺陷成因（一次抖动 ⇒ 开关永久失效）。
 */
export type FeatureFlagsTableProbe =
  | { readonly state: 'ready' }
  | { readonly state: 'missing' }
  | {
      readonly state: 'unknown';
      /** 未知的具体来路（只用于诊断，不参与放行判定）。 */
      readonly reason: 'probe_error' | 'unexpected_shape' | 'no_pool';
    };

/**
 * 只读就绪探测（三态）。**不抛**：任何失败都以 `unknown` 返回，由调用方决定 fail-closed 策略。
 *
 * 注意「无池」也归 `unknown` 而不是 `missing`：没有连接不等于表不存在，绝不能由它推出「未武装 ⇒ 放行」。
 */
export async function probeFeatureFlagsTable(
  pool: Pick<PgPool, 'query'> | null | undefined,
): Promise<FeatureFlagsTableProbe> {
  if (!pool || typeof pool.query !== 'function') return { state: 'unknown', reason: 'no_pool' };
  let rows: unknown;
  try {
    const result = await pool.query(TABLE_READY_SQL);
    rows = result?.rows;
  } catch {
    // 权限/连接/超时：**状态未知**。⛔ 不得返回 `missing`（那会让调用方永久 fail-open）。
    return { state: 'unknown', reason: 'probe_error' };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { state: 'unknown', reason: 'unexpected_shape' };
  const ready = (rows[0] as Record<string, unknown> | null | undefined)?.['ready'];
  if (ready === true) return { state: 'ready' };
  if (ready === false) return { state: 'missing' };
  // 形状读不懂 ⇒ 不知道表在不在 ⇒ 未知（既不是「未就绪」，更不是「可以放行」）。
  return { state: 'unknown', reason: 'unexpected_shape' };
}

/**
 * 布尔便捷形式（保留给只问「就绪了吗」的调用点与既有单测）：只有**确认存在**才是 `true`，
 * `missing` 与 `unknown` 都是 `false`。
 *
 * ⚠️ 武装判定**不要**用它 —— 它丢掉了 `missing`/`unknown` 的区别，正是 #282 的缺陷成因；
 * 武装必须走 `probeFeatureFlagsTable`。
 */
export async function featureFlagsTableReady(
  pool: Pick<PgPool, 'query'> | null | undefined,
): Promise<boolean> {
  return (await probeFeatureFlagsTable(pool)).state === 'ready';
}
