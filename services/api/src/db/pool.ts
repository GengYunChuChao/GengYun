/**
 * PostgreSQL 连接池与健康检查。
 *
 * 原则：没有 DATABASE_URL 时不假装连接成功；连接失败如实返回错误类别。
 */
import pg from 'pg';

const { Pool } = pg;

export type DatabaseErrorCategory =
  | 'connection_failed'
  | 'timeout'
  | 'auth_failed'
  | 'database_missing'
  | 'unavailable';

export interface DatabaseHealth {
  configured: boolean;
  status: 'not_configured' | 'ok' | 'error';
  /** 仅错误时给出；固定安全分类，绝不包含驱动原始 message（可能带用户名/主机/SQL 上下文）。 */
  category?: DatabaseErrorCategory;
  latency_ms?: number;
}

export type PgPool = InstanceType<typeof Pool>;

export function createPool(databaseUrl: string | null): PgPool | null {
  if (databaseUrl === null) return null;
  return new Pool({
    connectionString: databaseUrl,
    // 骨架阶段保持小连接数，避免误用生产容量。
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    // Server cancels expensive reads first; driver also bounds a stalled reply.
    statement_timeout: 5000,
    query_timeout: 6000,
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`数据库健康检查超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 将数据库错误映射为固定安全分类；只依赖驱动错误码白名单，不读取 message 原文。 */
export function classifyDatabaseError(error: unknown): DatabaseErrorCategory {
  const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
  switch (code) {
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ECONNRESET':
      return 'connection_failed';
    case 'ETIMEDOUT':
      return 'timeout';
    case '28P01':
    case '28000':
      return 'auth_failed';
    case '3D000':
      return 'database_missing';
    default:
      return 'unavailable';
  }
}

/** 驱动/网络层的瞬时代码（连接被拒/重置、DNS 抖动、套接字超时）：同一请求稍后重试可能成功。 */
const TRANSIENT_DRIVER_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE']);

/**
 * 判定一个数据库故障是否属于**瞬时**类（`retryable` 口径见 `services/api/src/errors.ts` 的 `ApiError` 注释：
 * 仅当同一请求在无人工/运维介入下稍后重试可能成功才为 `true`）。
 *
 * 与 `services/api/src/privacy/ledger-pg.ts` 的 `mapPgError()` 逐条同源，**只此一处**定义，调用点不得各写一套正则：
 * - 驱动/网络层：`TRANSIENT_DRIVER_CODES`（连接被拒/重置、DNS 抖动、套接字超时）；
 * - SQLSTATE：`57014`/`55P03`（语句取消/拿不到锁，超时类，调用方通常另映射为 `PROVIDER_TIMEOUT`）、
 *   `08xxx`（连接层故障）、`53xxx`（管理员干预）、`57P0x`（含 `57P01` 管理员重启）、
 *   `40001`（串行化失败）、`40P01`（死锁）。
 *
 * 其余（`3D000` 库不存在、`28P01` 凭据不匹配、`42P01` 表缺失、`42501` 权限不足、`42883` 函数缺失，
 * 以及无 `code` 的无法归类错误）⇒ 需运维改配置或修缺陷，**不是时间能解决的** ⇒ `false`。
 */
export function isTransientDatabaseError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || code.length === 0) return false;
  if (TRANSIENT_DRIVER_CODES.has(code)) return true;
  return /^(08|53|57P0|40001|40P01|57014|55P03)/.test(code);
}

/**
 * 执行一次最小只读查询确认连接可用。不修改任何数据。
 * 未配置连接串时返回 not_configured（不视为通过）。
 * 失败只返回安全分类，不泄露驱动异常原文。
 */
export async function checkDatabase(pool: PgPool | null, timeoutMs: number): Promise<DatabaseHealth> {
  if (pool === null) {
    return { configured: false, status: 'not_configured' };
  }
  const startedAt = Date.now();
  try {
    await withTimeout(pool.query('SELECT 1'), timeoutMs);
    return { configured: true, status: 'ok', latency_ms: Date.now() - startedAt };
  } catch (error) {
    return {
      configured: true,
      status: 'error',
      category: classifyDatabaseError(error),
      latency_ms: Date.now() - startedAt,
    };
  }
}
