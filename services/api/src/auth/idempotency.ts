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
 * - 结果引用 outcome **不含任何凭据**（登录类为会话 id + audience，退出类为成功标记），
 *   **不保存** access_token 等明文 bearer 响应；命中台账时不回放旧响应，而是由调用方
 *   重新校验当前状态并**在同一会话上换发令牌**（见 routes/support.ts、auth/service.ts）。
 *
 * 并发收敛（claim/complete/release）：
 * - 需要执行 produce 前先 `claim` **原子占位**（插入 outcome 为 NULL 的占位行）；
 *   占位成功者才执行 produce，完成后 `complete` 写入结果；失败则 `release` 放弃占位。
 * - 同键并发时未占位者**不产生第二份会话**，而是有界等待占位者结果，再按其结果重放
 *   （收敛到同一会话关系）。这样并发同键登录只会得到一份可撤销的会话。
 *
 * 存储：`createMemoryIdempotencyStore`（进程内，测试/替身）与
 * `createPostgresIdempotencyStore`（0008 的 idempotency_keys）。
 */
import { createHmac } from 'node:crypto';
import type { SqlExecutor } from './store.ts';
import { sha256Hex } from './tokens.ts';

/** 普通幂等回执保留 24 小时（state-contract）；不延长会话或持久业务唯一键。 */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * 不含任何凭据的结果引用。
 * - 登录类：`{ sessionId, audience }` —— 用于重放前核验关联会话与账号当前状态，
 *   并在**同一会话**上换发新令牌（同一可撤销登录结果）；
 * - 退出类：`{ accepted: true }` —— 成功标记，无凭据。
 * - 注销类（GY-I19）：`{ deletion_id }` —— 内核 id 不是凭据，但 `DELETE` 的删除请求是；
 *   `deletion_id` 只用于**按结果引用重新投影/重新签发**回执 bearer，**绝不**回放旧 bearer。
 */
export type IdempotencyOutcome =
  | { sessionId: string; audience: 'user' | 'admin' }
  | { accepted: true }
  | { deletion_id: string };

/** 登录类结果引用（含会话 id 与受众）。 */
export interface LoginOutcomeReference {
  sessionId: string;
  audience: 'user' | 'admin';
}

/** 注销类结果引用（GY-I19：只含删除请求 id，不含任何凭据）。 */
export interface DeletionOutcomeReference {
  deletion_id: string;
}

export function isLoginOutcomeReference(outcome: IdempotencyOutcome): outcome is LoginOutcomeReference {
  return typeof (outcome as LoginOutcomeReference).sessionId === 'string';
}

/**
 * 已完成的台账记录：`find` 只会返回这种（`outcome` 必为不含凭据的结果引用）。
 * 占位中的行（`outcome IS NULL`）不会被 `find` 返回——调用方看到 null 时应当去 `claim`，
 * claim 失败即表示同键请求正在 produce（占位中），需有界等待其完成后重放。
 */
export interface IdempotencyRecord {
  /** HMAC-SHA256(密钥, 规范化 [请求体, If-Match])（hex）。 */
  requestHash: string;
  responseStatus: number;
  /** 不含凭据的结果引用（登录 sessionId+audience / 退出成功标记）。 */
  outcome: IdempotencyOutcome;
  /** 重放窗口到期时刻。 */
  expiresAt: Date;
}

/** 台账写入（`complete`）：`outcome` 为空表示仍是占位（仅内部占位状态）。 */
export interface IdempotencyWrite {
  requestHash: string;
  responseStatus: number;
  outcome: IdempotencyOutcome | null;
  expiresAt: Date;
}

/** 占位请求（claim 的输入）：只需请求摘要与到期时间。 */
export interface IdempotencyClaim {
  requestHash: string;
  responseStatus: number;
  expiresAt: Date;
}

export interface IdempotencyStore {
  readonly persistent: boolean;
  /** 读取**已完成**的台账记录；占位中（outcome IS NULL）与不存在都返回 null。 */
  find(scope: string, keyHashHex: string): Promise<IdempotencyRecord | null>;
  /**
   * 原子占位：仅当 scope+key 不存在（或已到期、已被清理）时插入占位行（outcome=NULL）。
   * 返回是否占位成功（true=本次请求可执行 produce）。
   */
  claim(scope: string, keyHashHex: string, claim: IdempotencyClaim): Promise<boolean>;
  /** 占位者写入最终结果；仅当该行仍是未完成占位（outcome IS NULL）时成功。 */
  complete(scope: string, keyHashHex: string, record: IdempotencyRecord): Promise<boolean>;
  /** 放弃占位（produce 失败）；只删除未完成的占位行。 */
  release(scope: string, keyHashHex: string): Promise<void>;
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
    // GY-I19：注销类结果引用（只含删除请求 id，凭据一律不入台账）。
    if (typeof record['deletion_id'] === 'string' && record['deletion_id'].length > 0) {
      return { deletion_id: record['deletion_id'] };
    }
  }
  throw new Error('幂等台账结果引用格式非法');
}

// ---------------------------------------------------------------------------
// 内存实现
// ---------------------------------------------------------------------------

export function createMemoryIdempotencyStore(): IdempotencyStore {
  const records = new Map<string, IdempotencyWrite>();
  const composite = (scope: string, keyHashHex: string): string => `${scope}\u0000${keyHashHex}`;

  return {
    persistent: false,
    async find(scope, keyHashHex) {
      const record = records.get(composite(scope, keyHashHex));
      // 占位行（outcome IS NULL）不算已完成结果：对重放方表现为「尚未就绪」。
      if (record === undefined || record.outcome === null) return null;
      return {
        requestHash: record.requestHash,
        responseStatus: record.responseStatus,
        outcome: record.outcome,
        expiresAt: record.expiresAt,
      };
    },
    async claim(scope, keyHashHex, input) {
      const key = composite(scope, keyHashHex);
      if (records.has(key)) return false;
      records.set(key, {
        requestHash: input.requestHash,
        responseStatus: input.responseStatus,
        outcome: null,
        expiresAt: input.expiresAt,
      });
      return true;
    },
    async complete(scope, keyHashHex, record) {
      const key = composite(scope, keyHashHex);
      const existing = records.get(key);
      if (existing === undefined || existing.outcome !== null) return false;
      records.set(key, record);
      return true;
    },
    async release(scope, keyHashHex) {
      const key = composite(scope, keyHashHex);
      const existing = records.get(key);
      if (existing !== undefined && existing.outcome === null) records.delete(key);
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
// PostgreSQL 实现（0008 idempotency_keys）
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
      const rawOutcome = row['outcome'];
      // 占位行（outcome IS NULL）：同键请求正在 produce，对重放方表现为「尚未就绪」。
      if (rawOutcome === null || rawOutcome === undefined) return null;
      return {
        requestHash: String(row['request_hash']),
        responseStatus: Number(row['response_status']),
        outcome: parseIdempotencyOutcome(rawOutcome),
        expiresAt: row['expires_at'] instanceof Date ? row['expires_at'] : new Date(String(row['expires_at'])),
      };
    },
    async claim(scope, keyHashHex, input) {
      // 过期条目仍占用唯一键：先清掉同键的过期行，再插入占位，避免过期后永久冲突。
      await sql.query('DELETE FROM idempotency_keys WHERE scope = $1 AND key_hash = decode($2, \'hex\') AND expires_at <= now()', [
        scope,
        keyHashHex,
      ]);
      const { rows } = await sql.query(
        `INSERT INTO idempotency_keys (scope, key_hash, request_hash, response_status, outcome, expires_at)
         VALUES ($1, decode($2, 'hex'), $3, $4, NULL, $5)
         ON CONFLICT (scope, key_hash) DO NOTHING
         RETURNING id`,
        [scope, keyHashHex, input.requestHash, input.responseStatus, input.expiresAt],
      );
      return rows.length === 1;
    },
    async complete(scope, keyHashHex, record) {
      const { rows } = await sql.query(
        `UPDATE idempotency_keys
         SET outcome = $3::jsonb, response_status = $4
         WHERE scope = $1 AND key_hash = decode($2, 'hex') AND outcome IS NULL
         RETURNING id`,
        [scope, keyHashHex, JSON.stringify(record.outcome), record.responseStatus],
      );
      return rows.length === 1;
    },
    async release(scope, keyHashHex) {
      await sql.query('DELETE FROM idempotency_keys WHERE scope = $1 AND key_hash = decode($2, \'hex\') AND outcome IS NULL', [
        scope,
        keyHashHex,
      ]);
    },
    purgeExpired(now) {
      return purge(now);
    },
  };
}
