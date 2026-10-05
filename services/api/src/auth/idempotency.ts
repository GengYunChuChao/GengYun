/**
 * 幂等键台账（契约参数 Idempotency-Key）。
 *
 * 契约：`/auth/wechat`、`/auth/logout`、`/admin/auth/session`、`/admin/auth/logout`
 * 四个 POST 的 `Idempotency-Key` 头 required（8..128 字符），语义为
 * “同主体/方法/路径键域，hash 包含 If-Match；重放前重新鉴权”。
 *
 * 实现：
 * - 键域 scope = `<主体>\n<METHOD>\n<路由路径>`；主体为已鉴权账号 id，
 *   公开端点（登录）无主体，固定为 `anonymous`。
 * - key_hash = SHA-256(scope || '\n' || 原始键)，只存摘要，不存原始键。
 * - request_hash = SHA-256(规范化 [请求体, If-Match])；同键异体 → 冲突。
 * - 存储：`createMemoryIdempotencyStore`（进程内，测试/替身）与
 *   `createPostgresIdempotencyStore`（0004 的 idempotency_keys）。
 *
 * 安全边界：
 * - 重放窗口内会暂存首次响应体（含 bearer 令牌明文），因此 TTL 取短值（默认 5 分钟），
 *   仅覆盖“客户端超时重试”的现实场景；是否过期由调用方按自己的时钟判定
 *   （存储层不做时间过滤，便于注入时钟做确定性回归）。
 * - `save` 用 `ON CONFLICT DO NOTHING`：并发同键时后到者不覆盖先到者；
 *   本层不做分布式锁，同键并发的**执行**可能发生一次以上（登录重复执行被
 *   users.wechat_subject_lookup 唯一索引与微信 code 单次交换双重收敛）。
 */
import type { SqlExecutor } from './store.ts';
import { sha256Hex } from './tokens.ts';

/** 幂等重放窗口：只覆盖客户端超时重试，缩短含令牌响应体的留库时间。 */
export const IDEMPOTENCY_TTL_SECONDS = 5 * 60;

export interface IdempotencyRecord {
  /** SHA-256(规范化 [请求体, If-Match])（hex）。 */
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
  expiresAt: Date;
}

export interface IdempotencyStore {
  readonly persistent: boolean;
  find(scope: string, keyHashHex: string): Promise<IdempotencyRecord | null>;
  save(scope: string, keyHashHex: string, record: IdempotencyRecord): Promise<void>;
}

/** 键域：主体 + 方法 + 路径。 */
export function idempotencyScope(subject: string, method: string, routePath: string): string {
  return `${subject}\n${method.toUpperCase()}\n${routePath}`;
}

/** 键摘要：SHA-256(scope || '\n' || 原始键)，hex（32 字节）。 */
export function idempotencyKeyHashHex(scope: string, key: string): string {
  return sha256Hex(`${scope}\n${key}`);
}

/**
 * 请求摘要：SHA-256(规范化 [请求体, If-Match])。
 * 契约要求 hash 包含 If-Match；请求体缺失（logout 无 body）记为 null。
 */
export function idempotencyRequestHash(body: unknown, ifMatch: string | string[] | undefined): string {
  const ifMatchValue = Array.isArray(ifMatch) ? ifMatch[0] : ifMatch;
  return sha256Hex(JSON.stringify([body ?? null, ifMatchValue ?? null]));
}

// ---------------------------------------------------------------------------
// 内存实现
// ---------------------------------------------------------------------------

export function createMemoryIdempotencyStore(): IdempotencyStore {
  const records = new Map<string, IdempotencyRecord>();
  const composite = (scope: string, keyHashHex: string): string => `${scope}\u0000${keyHashHex}`;

  return {
    persistent: false,
    async find(scope, keyHashHex) {
      const record = records.get(composite(scope, keyHashHex));
      return record ?? null;
    },
    async save(scope, keyHashHex, record) {
      const key = composite(scope, keyHashHex);
      if (!records.has(key)) records.set(key, record);
    },
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL 实现（0004 idempotency_keys）
// ---------------------------------------------------------------------------

export function createPostgresIdempotencyStore(sql: SqlExecutor): IdempotencyStore {
  return {
    persistent: true,
    async find(scope, keyHashHex) {
      const { rows } = await sql.query(
        `SELECT request_hash, response_status, response_body, expires_at
         FROM idempotency_keys
         WHERE scope = $1 AND key_hash = decode($2, 'hex')`,
        [scope, keyHashHex],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        requestHash: String(row['request_hash']),
        responseStatus: Number(row['response_status']),
        responseBody: row['response_body'],
        expiresAt: row['expires_at'] instanceof Date ? row['expires_at'] : new Date(String(row['expires_at'])),
      };
    },
    async save(scope, keyHashHex, record) {
      // 过期条目仍占用唯一键：先清掉同键的过期行，再插入，避免过期后永久冲突。
      await sql.query('DELETE FROM idempotency_keys WHERE scope = $1 AND key_hash = decode($2, \'hex\') AND expires_at <= now()', [
        scope,
        keyHashHex,
      ]);
      await sql.query(
        `INSERT INTO idempotency_keys (scope, key_hash, request_hash, response_status, response_body, expires_at)
         VALUES ($1, decode($2, 'hex'), $3, $4, $5::jsonb, $6)
         ON CONFLICT (scope, key_hash) DO NOTHING`,
        [scope, keyHashHex, record.requestHash, record.responseStatus, JSON.stringify(record.responseBody), record.expiresAt],
      );
    },
  };
}
