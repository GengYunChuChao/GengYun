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
