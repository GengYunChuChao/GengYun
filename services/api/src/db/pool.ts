/**
 * PostgreSQL 连接池与健康检查。
 *
 * 原则：没有 DATABASE_URL 时不假装连接成功；连接失败如实返回错误类别。
 */
import pg from 'pg';

const { Pool } = pg;

export interface DatabaseHealth {
  configured: boolean;
  status: 'not_configured' | 'ok' | 'error';
  /** 仅错误时给出，已脱敏，不含连接串/凭据。 */
  code?: string;
  detail?: string;
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

/**
 * 执行一次最小只读查询确认连接可用。不修改任何数据。
 * 未配置连接串时返回 not_configured（不视为通过）。
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
    const err = error as { code?: string; message?: string };
    return {
      configured: true,
      status: 'error',
      code: typeof err.code === 'string' ? err.code : 'UNKNOWN',
      detail: typeof err.message === 'string' ? err.message : '未知错误',
      latency_ms: Date.now() - startedAt,
    };
  }
}
