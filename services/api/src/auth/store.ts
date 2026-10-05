/**
 * 认证会话存储。
 *
 * 两种实现：
 * - `createMemoryAuthStore`：进程内实现，用于 stub/preset_demo 与单元测试。
 *   它**不是持久化存储**；real 模式下若没有数据库连接，登录会被显式拒绝（不假装持久化）。
 * - `createPostgresAuthStore`：基于 0001 的 users / sessions / admin_accounts /
 *   admin_sessions / admin_scopes。SQL 已用 PGlite 内存引擎回归（tests/unit/auth-store-pg.test.mjs），
 *   **不等价于目标 PostgreSQL 17.11 实库验收**。
 *
 * 该接口与 GY-I27 的 account 提供者（stateOf / authEpochOf）语义一致：
 * 会话层保证回调方拿到的 `authEpoch` 与服务端当前 `auth_epoch` 一致。
 */
import { randomUUID } from 'node:crypto';
import type {
  AdminRecord,
  AdminState,
  SessionAudience,
  StoredSession,
  UserRecord,
  UserState,
} from './types.ts';

export interface SqlExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface CreateSessionInput {
  userId: string;
  tokenHashHex: string;
  authEpoch: number;
  expiresAt: Date;
  audience: SessionAudience;
}

export interface CreateAdminInput {
  loginName: string;
  credentialHash: string;
  scopes: string[];
}

/** 后台管理员登录所需的最小账号视图（含凭据摘要，仅登录路径使用）。 */
export interface AdminCredentialRecord extends AdminRecord {
  credentialHash: string;
}

export interface AuthStore {
  /** 存储是否为持久化实现；real 模式下非持久化存储必须拒绝签发会话。 */
  readonly persistent: boolean;

  findUserBySubject(subjectLookupHex: string): Promise<UserRecord | null>;
  createUser(subjectLookupHex: string): Promise<UserRecord>;
  getUser(userId: string): Promise<UserRecord | null>;
  /** 递增 auth_epoch（注销/停用使既有会话立即失效）。 */
  bumpUserAuthEpoch(userId: string): Promise<void>;

  createSession(input: CreateSessionInput): Promise<string>;
  findSession(tokenHashHex: string, audience: SessionAudience): Promise<StoredSession | null>;
  /** 按会话 id 查找（幂等重放核验关联会话用）；不含明文令牌。 */
  findSessionById(sessionId: string, audience: SessionAudience): Promise<StoredSession | null>;
  revokeSession(sessionId: string, audience: SessionAudience): Promise<void>;

  findAdminByLoginName(loginName: string): Promise<AdminCredentialRecord | null>;
  getAdmin(adminId: string): Promise<AdminRecord | null>;
  listAdminScopes(adminId: string): Promise<string[]>;
  countAdmins(): Promise<number>;
  createAdmin(input: CreateAdminInput): Promise<string>;
}

// ---------------------------------------------------------------------------
// 内存实现
// ---------------------------------------------------------------------------

export function createMemoryAuthStore(): AuthStore {
  const users = new Map<string, UserRecord & { subjectLookupHex: string }>();
  const userBySubject = new Map<string, string>();
  const sessions = new Map<string, StoredSession>();
  const admins = new Map<string, AdminCredentialRecord>();
  const adminByLogin = new Map<string, string>();
  const adminScopes = new Map<string, Set<string>>();

  function sessionKey(tokenHashHex: string, audience: SessionAudience): string {
    return `${audience}:${tokenHashHex}`;
  }

  return {
    persistent: false,

    async findUserBySubject(subjectLookupHex) {
      const id = userBySubject.get(subjectLookupHex);
      if (id === undefined) return null;
      const user = users.get(id);
      return user === undefined ? null : { id: user.id, state: user.state, authEpoch: user.authEpoch, revision: user.revision };
    },
    async createUser(subjectLookupHex) {
      const record = { id: randomUUID(), state: 'active' as UserState, authEpoch: 1, revision: 1, subjectLookupHex };
      users.set(record.id, record);
      userBySubject.set(subjectLookupHex, record.id);
      return { id: record.id, state: record.state, authEpoch: record.authEpoch, revision: record.revision };
    },
    async getUser(userId) {
      const user = users.get(userId);
      return user === undefined ? null : { id: user.id, state: user.state, authEpoch: user.authEpoch, revision: user.revision };
    },
    async bumpUserAuthEpoch(userId) {
      const user = users.get(userId);
      if (user !== undefined) {
        user.authEpoch += 1;
        user.revision += 1;
      }
    },

    async createSession(input) {
      const id = randomUUID();
      sessions.set(sessionKey(input.tokenHashHex, input.audience), {
        id,
        userId: input.userId,
        audience: input.audience,
        authEpoch: input.authEpoch,
        expiresAt: input.expiresAt,
        revokedAt: null,
      });
      return id;
    },
    async findSession(tokenHashHex, audience) {
      return sessions.get(sessionKey(tokenHashHex, audience)) ?? null;
    },
    async findSessionById(sessionId, audience) {
      for (const session of sessions.values()) {
        if (session.id === sessionId && session.audience === audience) return session;
      }
      return null;
    },
    async revokeSession(sessionId, audience) {
      for (const [key, session] of sessions) {
        if (session.id === sessionId && session.audience === audience && session.revokedAt === null) {
          sessions.set(key, { ...session, revokedAt: new Date() });
        }
      }
    },

    async findAdminByLoginName(loginName) {
      const id = adminByLogin.get(loginName);
      if (id === undefined) return null;
      return admins.get(id) ?? null;
    },
    async getAdmin(adminId) {
      const admin = admins.get(adminId);
      if (admin === undefined) return null;
      return { id: admin.id, loginName: admin.loginName, state: admin.state, authEpoch: admin.authEpoch, revision: admin.revision };
    },
    async listAdminScopes(adminId) {
      return [...(adminScopes.get(adminId) ?? new Set<string>())].sort();
    },
    async countAdmins() {
      return admins.size;
    },
    async createAdmin(input) {
      const record: AdminCredentialRecord = {
        id: randomUUID(),
        loginName: input.loginName,
        state: 'active',
        authEpoch: 1,
        revision: 1,
        credentialHash: input.credentialHash,
      };
      admins.set(record.id, record);
      adminByLogin.set(record.loginName, record.id);
      adminScopes.set(record.id, new Set(input.scopes));
      return record.id;
    },
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL 实现
// ---------------------------------------------------------------------------

function asString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : String(value ?? '');
}

function asDate(row: Record<string, unknown>, key: string): Date {
  const value = row[key];
  return value instanceof Date ? value : new Date(String(value));
}

function asNullableDate(row: Record<string, unknown>, key: string): Date | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(String(value));
}

function toUser(row: Record<string, unknown>): UserRecord {
  return {
    id: asString(row, 'id'),
    state: asString(row, 'state') as UserState,
    authEpoch: Number(row['auth_epoch']),
    revision: Number(row['revision']),
  };
}

function toSession(row: Record<string, unknown>): StoredSession {
  return {
    id: asString(row, 'id'),
    userId: asString(row, 'user_id'),
    audience: asString(row, 'audience') as SessionAudience,
    authEpoch: Number(row['auth_epoch']),
    expiresAt: asDate(row, 'expires_at'),
    revokedAt: asNullableDate(row, 'revoked_at'),
  };
}

export function createPostgresAuthStore(sql: SqlExecutor): AuthStore {
  const findUserBySubject = async (subjectLookupHex: string): Promise<UserRecord | null> => {
    const { rows } = await sql.query(
      'SELECT id, state, auth_epoch, revision FROM users WHERE wechat_subject_lookup = decode($1, \'hex\')',
      [subjectLookupHex],
    );
    const row = rows[0];
    return row === undefined ? null : toUser(row);
  };

  return {
    persistent: true,

    findUserBySubject,
    async createUser(subjectLookupHex) {
      try {
        const { rows } = await sql.query(
          `INSERT INTO users (wechat_subject_lookup, wechat_subject_cipher)
           VALUES (decode($1, 'hex'), NULL)
           RETURNING id, state, auth_epoch, revision`,
          [subjectLookupHex],
        );
        const row = rows[0];
        if (row === undefined) throw new Error('创建用户未返回行');
        return toUser(row);
      } catch (error) {
        // 并发注册同一 subject：唯一索引竞态 → 回读既有行。
        if (typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code === '23505') {
          const existing = await findUserBySubject(subjectLookupHex);
          if (existing !== null) return existing;
        }
        throw error;
      }
    },
    async getUser(userId) {
      const { rows } = await sql.query('SELECT id, state, auth_epoch, revision FROM users WHERE id = $1::uuid', [userId]);
      const row = rows[0];
      return row === undefined ? null : toUser(row);
    },
    async bumpUserAuthEpoch(userId) {
      await sql.query('UPDATE users SET auth_epoch = auth_epoch + 1, revision = revision + 1, updated_at = now() WHERE id = $1::uuid', [userId]);
    },

    async createSession(input) {
      // 会话按其 audience 落入独立表：用户 sessions / 后台 admin_sessions。
      // 两表不互通，令牌不可互用（契约 securitySchemes: userSession / adminSession）。
      const table = input.audience === 'admin' ? 'admin_sessions' : 'sessions';
      const subjectColumn = input.audience === 'admin' ? 'admin_id' : 'user_id';
      const { rows } = await sql.query(
        `INSERT INTO ${table} (${subjectColumn}, token_hash, audience, auth_epoch, expires_at)
         VALUES ($1::uuid, decode($2, 'hex'), $3, $4, $5)
         RETURNING id`,
        [input.userId, input.tokenHashHex, input.audience, input.authEpoch, input.expiresAt],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('创建会话未返回行');
      return asString(row, 'id');
    },
    async findSession(tokenHashHex, audience) {
      const table = audience === 'admin' ? 'admin_sessions' : 'sessions';
      const { rows } = await sql.query(
        `SELECT id, audience, auth_epoch, expires_at, revoked_at,
                ${audience === 'admin' ? 'admin_id' : 'user_id'} AS user_id
         FROM ${table} WHERE token_hash = decode($1, 'hex')`,
        [tokenHashHex],
      );
      const row = rows[0];
      return row === undefined ? null : toSession(row);
    },
    async findSessionById(sessionId, audience) {
      const table = audience === 'admin' ? 'admin_sessions' : 'sessions';
      const { rows } = await sql.query(
        `SELECT id, audience, auth_epoch, expires_at, revoked_at,
                ${audience === 'admin' ? 'admin_id' : 'user_id'} AS user_id
         FROM ${table} WHERE id = $1::uuid`,
        [sessionId],
      );
      const row = rows[0];
      return row === undefined ? null : toSession(row);
    },
    async revokeSession(sessionId, audience) {
      const table = audience === 'admin' ? 'admin_sessions' : 'sessions';
      await sql.query(`UPDATE ${table} SET revoked_at = now() WHERE id = $1::uuid AND revoked_at IS NULL`, [sessionId]);
    },

    async findAdminByLoginName(loginName) {
      const { rows } = await sql.query(
        'SELECT id, login_name, state, auth_epoch, revision, credential_hash FROM admin_accounts WHERE login_name = $1',
        [loginName],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return { ...toAdmin(row), credentialHash: asString(row, 'credential_hash') };
    },
    async getAdmin(adminId) {
      const { rows } = await sql.query(
        'SELECT id, login_name, state, auth_epoch, revision FROM admin_accounts WHERE id = $1::uuid',
        [adminId],
      );
      const row = rows[0];
      return row === undefined ? null : toAdmin(row);
    },
    async listAdminScopes(adminId) {
      const { rows } = await sql.query(
        'SELECT scope FROM admin_scopes WHERE admin_id = $1::uuid AND revoked_at IS NULL ORDER BY scope',
        [adminId],
      );
      return rows.map((row) => asString(row, 'scope'));
    },
    async countAdmins() {
      const { rows } = await sql.query('SELECT count(*)::int AS c FROM admin_accounts');
      return Number(rows[0]?.['c'] ?? 0);
    },
    async createAdmin(input) {
      const { rows } = await sql.query(
        'INSERT INTO admin_accounts (login_name, credential_hash) VALUES ($1, $2) RETURNING id',
        [input.loginName, input.credentialHash],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('创建管理员未返回行');
      const adminId = asString(row, 'id');
      for (const scope of input.scopes) {
        await sql.query('INSERT INTO admin_scopes (admin_id, scope) VALUES ($1::uuid, $2) ON CONFLICT (admin_id, scope) DO NOTHING', [adminId, scope]);
      }
      return adminId;
    },
  };
}

function toAdmin(row: Record<string, unknown>): AdminRecord {
  return {
    id: asString(row, 'id'),
    loginName: asString(row, 'login_name'),
    state: asString(row, 'state') as AdminState,
    authEpoch: Number(row['auth_epoch']),
    revision: Number(row['revision']),
  };
}
