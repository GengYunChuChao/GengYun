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
 * - request_hash = HMAC-SHA256(服务端密钥, 规范化 [请求体, If-Match])；同键异体 → 冲突。
 *   用带密钥的 HMAC 而非无密钥 SHA-256：密钥只经 `process.env`（`SESSION_SIGNING_KEY`）
 *   且**不入库**，因此即便台账整体外泄，也无法据此对后台口令做廉价离线验证。
 * - 存储：`createMemoryIdempotencyStore`（进程内，测试/替身）与
 *   `createPostgresIdempotencyStore`（0004 的 idempotency_keys）。
 *
 * 安全边界：
 * - 台账**只保存不含凭据的结果引用**（登录类为签发的 sessionId + audience，退出类为成功标记）；
 *   **不保存** access_token 等明文 bearer 响应。命中台账时不回放旧响应，而是由调用方
 *   重新执行 produce（含当前状态校验）以重新签发，见 routes/support.ts。
 * - 结果引用里没有凭据，故留存本身不再构成凭据泄露；`purgeExpired` 仍按到期时间做**实际删除**，
 *   而不是只写 TTL 字段（`save` 时顺带全局清理已到期条目）。
 * - `save` 用 `ON CONFLICT DO NOTHING`：并发同键时后到者不覆盖先到者；
 *   本层不做分布式锁，同键并发的**执行**可能发生一次以上（登录重复执行被
 *   users.wechat_subject_lookup 唯一索引与微信 code 单次交换双重收敛）。
 */
import { createHmac } from 'node:crypto';
import type { SqlExecutor } from './store.ts';
import { sha256Hex } from './tokens.ts';

/** 幂等重放窗口：只覆盖客户端超时重试。 */
export const IDEMPOTENCY_TTL_SECONDS = 5 * 60;

/**
 * 不含任何凭据的结果引用。
 * - 登录类：`{ sessionId, audience }` —— 用于重放前核验关联会话与账号当前状态并重新签发；
 * - 退出类：`{ accepted: true }` —— 成功标记，无凭据。
 */
export type IdempotencyOutcome =
  | { sessionId: string; audience: 'user' | 'admin' }
  | { accepted: true };

/** 登录类结果引用（含会话 id 与受众）。 */
export interface LoginOutcomeReference {
  sessionId: string;
  audience: 'user' | 'admin';
}

export function isLoginOutcomeReference(outcome: IdempotencyOutcome): outcome is LoginOutcomeReference {
  return typeof (outcome as LoginOutcomeReference).sessionId === 'string';
}

export interface IdempotencyRecord {
  /** HMAC-SHA256(密钥, 规范化 [请求体, If-Match])（hex）。 */
  requestHash: string;
  responseStatus: number;
  /** 不含凭据的结果引用；**绝不**是完整响应体。 */
  outcome: IdempotencyOutcome;
  expiresAt: Date;
}

export interface IdempotencyStore {
  readonly persistent: boolean;
  find(scope: string, keyHashHex: string): Promise<IdempotencyRecord | null>;
  save(scope: string, keyHashHex: string, record: IdempotencyRecord): Promise<void>;
  /** 实际删除已到期条目（不只是 TTL 字段）；返回删除数量。 */
  purgeExpired(now: Date): Promise<number>;
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
 * 请求摘要：HMAC-SHA256(服务端密钥, 规范化 [请求体, If-Match])。
 * 契约要求 hash 包含 If-Match；请求体缺失（logout 无 body）记为 null。
 *
 * 必须是**带密钥**的摘要：无密钥 SHA-256 会把后台 `login_name/password` 变成
 * 比 credential_hash 的 scrypt 便宜得多的离线口令验证器。
 */
export function idempotencyRequestHash(
  body: unknown,
  ifMatch: string | string[] | undefined,
  hmacKey: string,
): string {
  const ifMatchValue = Array.isArray(ifMatch) ? ifMatch[0] : ifMatch;
  const payload = JSON.stringify([body ?? null, ifMatchValue ?? null]);
  return createHmac('sha256', hmacKey).update(payload, 'utf8').digest('hex');
}

/** 校验并规范化从存储读回的结果引用（不信任库内容形状）。 */
export function parseIdempotencyOutcome(value: unknown): IdempotencyOutcome {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['sessionId'] === 'string' && (record['audience'] === 'user' || record['audience'] === 'admin')) {
      return { sessionId: record['sessionId'], audience: record['audience'] };
    }
    if (record['accepted'] === true) return { accepted: true };
  }
  throw new Error('幂等台账结果引用格式非法');
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
    async purgeExpired(now) {
      let removed = 0;
      for (const [key, record] of records) {
        if (record.expiresAt.getTime() <= now.getTime()) {
          records.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL 实现（0004 idempotency_keys）
// ---------------------------------------------------------------------------

export function createPostgresIdempotencyStore(sql: SqlExecutor): IdempotencyStore {
  const purge = async (now: Date): Promise<number> => {
    const { rows } = await sql.query('DELETE FROM idempotency_keys WHERE expires_at <= $1 RETURNING id', [now]);
    return rows.length;
  };

  return {
    persistent: true,
    async find(scope, keyHashHex) {
      const { rows } = await sql.query(
        `SELECT request_hash, response_status, outcome, expires_at
         FROM idempotency_keys
         WHERE scope = $1 AND key_hash = decode($2, 'hex')`,
        [scope, keyHashHex],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        requestHash: String(row['request_hash']),
        responseStatus: Number(row['response_status']),
        outcome: parseIdempotencyOutcome(row['outcome']),
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
        `INSERT INTO idempotency_keys (scope, key_hash, request_hash, response_status, outcome, expires_at)
         VALUES ($1, decode($2, 'hex'), $3, $4, $5::jsonb, $6)
         ON CONFLICT (scope, key_hash) DO NOTHING`,
        [scope, keyHashHex, record.requestHash, record.responseStatus, JSON.stringify(record.outcome), record.expiresAt],
      );
    },
    purgeExpired(now) {
      return purge(now);
    },
  };
}
