/**
 * 鉴权中间件与会话解析。
 *
 * 本层是“服务端权威身份”的唯一出口：
 * - 从 `Authorization: Bearer <token>` 解析不透明令牌 → 摘要查找会话 → 读账号权威状态。
 * - 把 `userId` / `authEpoch`（正整数）/ `role` 填到请求上，供 GY-I27 的
 *   `requireConsent` 直接消费（`{ userId: req.userId, authEpoch: req.authEpoch }`）。
 * - 客户端无法通过请求体 / 查询 / 自定义头声明身份：这些字段只来自服务端存储。
 *
 * 与 GY-I27 约定的语义（`readIdentity` 逐条实现）：
 * - 缺 `authEpoch` → `SESSION_REQUIRED`（401）
 * - `authEpoch` 非正整数 → `INVALID_REQUEST`（400）
 * - `authEpoch` 与账号当前 `auth_epoch` 不一致 → `ACCOUNT_INACTIVE`（403）
 *
 * 本文件不 import、不修改 `packages/privacy/**`（归 GY-I27 分支）。
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { ApiError } from '../errors.ts';
import type { AuthStore } from './store.ts';
import type { AuthenticatedIdentity, RequestRole, StoredSession } from './types.ts';
import { hashToken, isPositiveInteger, readBearerToken } from './tokens.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** 服务端解析的账号 id；未鉴权为 null。 */
    userId: string | null;
    /** 服务端权威 auth_epoch（正整数）；未鉴权为 null。 */
    authEpoch: number | null;
    /** 会话角色（= audience）；未鉴权为 null。 */
    role: RequestRole | null;
    /** 会话 id（不含明文令牌）；仅服务端内部使用。 */
    sessionId: string | null;
    /** 会话绝对到期时刻；仅服务端内部使用。 */
    sessionExpiresAt: Date | null;
    /** 账号 revision，用于强 ETag；未鉴权为 null。 */
    accountRevision: number | null;
    /** 后台已授予的 scope；用户会话为 null。 */
    authScopes: string[] | null;
  }
}

export interface AuthContext {
  store: AuthStore;
  now: () => Date;
}

/** 解析出的会话及其账号（含账号行，供路由读 revision）。 */
export interface ResolvedUserSession {
  identity: AuthenticatedIdentity;
  session: StoredSession;
}

function tokenOf(request: FastifyRequest, what: string): string {
  const token = readBearerToken(request.headers.authorization);
  if (token === null) {
    // 无凭据：明确要求先建立会话。
    throw new ApiError('SESSION_REQUIRED', `需要${what}会话`);
  }
  return token;
}

async function loadLiveSession(
  context: AuthContext,
  token: string,
  audience: 'user' | 'admin',
): Promise<StoredSession | null> {
  const session = await context.store.findSession(hashToken(token), audience);
  if (session === null) return null;
  if (session.revokedAt !== null) return null;
  if (session.expiresAt.getTime() <= context.now().getTime()) return null;
  return session;
}

/** 用户端鉴权：失败抛契约 ApiError，成功返回服务端权威身份。 */
export async function authenticateUser(context: AuthContext, request: FastifyRequest): Promise<ResolvedUserSession> {
  const token = tokenOf(request, '用户');
  const session = await loadLiveSession(context, token, 'user');
  if (session === null) {
    throw new ApiError('SESSION_EXPIRED', '用户会话已过期或已失效');
  }
  const user = await context.store.getUser(session.userId);
  if (user === null) {
    throw new ApiError('SESSION_EXPIRED', '用户会话对应的账号不存在');
  }
  if (!isPositiveInteger(user.authEpoch)) {
    throw new ApiError('INVALID_REQUEST', '账号 authEpoch 非正整数');
  }
  if (user.state !== 'active') {
    throw new ApiError('ACCOUNT_INACTIVE', '账号不可用');
  }
  if (session.authEpoch !== user.authEpoch) {
    // 账号发生过停用/注销/全局注销：旧会话立即失效。
    throw new ApiError('ACCOUNT_INACTIVE', '会话已因账号变更失效');
  }
  return {
    identity: {
      userId: user.id,
      authEpoch: user.authEpoch,
      role: 'user',
      sessionId: session.id,
      expiresAt: session.expiresAt,
      revision: user.revision,
      scopes: ['user'],
    },
    session,
  };
}

/** 后台鉴权：普通用户会话访问后台 → SCOPE_DENIED（高权限拒绝）。 */
export async function authenticateAdmin(context: AuthContext, request: FastifyRequest): Promise<ResolvedUserSession> {
  const token = tokenOf(request, '管理员');
  const session = await loadLiveSession(context, token, 'admin');
  if (session === null) {
    // 同一令牌若恰好是**有效的用户会话**，说明是普通用户在访问后台能力 → 明确拒绝。
    const asUser = await loadLiveSession(context, token, 'user');
    if (asUser !== null) {
      throw new ApiError('SCOPE_DENIED', '后台接口不接受用户会话');
    }
    throw new ApiError('SESSION_EXPIRED', '后台会话已过期或已失效');
  }
  const admin = await context.store.getAdmin(session.userId);
  if (admin === null) {
    throw new ApiError('SESSION_EXPIRED', '后台会话对应的账号不存在');
  }
  if (!isPositiveInteger(admin.authEpoch)) {
    throw new ApiError('INVALID_REQUEST', '后台账号 authEpoch 非正整数');
  }
  if (admin.state !== 'active') {
    throw new ApiError('ACCOUNT_INACTIVE', '后台账号不可用');
  }
  if (session.authEpoch !== admin.authEpoch) {
    throw new ApiError('ACCOUNT_INACTIVE', '后台会话已因账号变更失效');
  }
  const scopes = await context.store.listAdminScopes(admin.id);
  return {
    identity: {
      userId: admin.id,
      authEpoch: admin.authEpoch,
      role: 'admin',
      sessionId: session.id,
      expiresAt: session.expiresAt,
      revision: admin.revision,
      scopes,
    },
    session,
  };
}

/** 把服务端权威身份填到请求上（GY-I27 接口缝）。 */
export function applyIdentity(request: FastifyRequest, identity: AuthenticatedIdentity): void {
  request.userId = identity.userId;
  request.authEpoch = identity.authEpoch;
  request.role = identity.role;
  request.sessionId = identity.sessionId;
  request.sessionExpiresAt = identity.expiresAt;
  request.accountRevision = identity.revision;
  request.authScopes = identity.role === 'admin' ? identity.scopes : null;
}

/** 读取完整身份（含会话 id / 到期 / revision / scope）；未鉴权或数据异常时抛契约错误。 */
export function currentIdentity(request: FastifyRequest): AuthenticatedIdentity {
  const { userId, authEpoch, role } = readIdentity(request);
  const sessionId = request.sessionId;
  const expiresAt = request.sessionExpiresAt;
  const revision = request.accountRevision;
  if (typeof sessionId !== 'string' || sessionId === '' || expiresAt === null || expiresAt === undefined || revision === null || revision === undefined) {
    throw new ApiError('SESSION_REQUIRED', '缺少会话上下文');
  }
  return {
    userId,
    authEpoch,
    role,
    sessionId,
    expiresAt,
    revision,
    scopes: role === 'admin' ? (request.authScopes ?? []) : ['user'],
  };
}

/**
 * 读取请求上的身份，逐条落实与 GY-I27 约定的语义。
 * 供 privacy 等下游消费；本层保证鉴权通过时这里永不抛错。
 */
export function readIdentity(request: FastifyRequest): { userId: string; authEpoch: number; role: RequestRole } {
  if (request.userId === null || request.userId === undefined || request.userId === '') {
    throw new ApiError('SESSION_REQUIRED', '缺少会话身份');
  }
  if (request.authEpoch === null || request.authEpoch === undefined) {
    throw new ApiError('SESSION_REQUIRED', '缺少会话 authEpoch');
  }
  if (!isPositiveInteger(request.authEpoch)) {
    throw new ApiError('INVALID_REQUEST', 'authEpoch 必须为正整数');
  }
  if (request.role !== 'user' && request.role !== 'admin') {
    throw new ApiError('SESSION_REQUIRED', '缺少会话角色');
  }
  return { userId: request.userId, authEpoch: request.authEpoch, role: request.role };
}

/** 后台 scope 校验：缺少所需能力 → SCOPE_DENIED。 */
export function requireScope(request: FastifyRequest, scope: string): void {
  const scopes = request.authScopes ?? [];
  if (!scopes.includes(scope)) {
    throw new ApiError('SCOPE_DENIED', `缺少所需权限：${scope}`);
  }
}

/**
 * 私有数据归属校验：只认服务端解析出的 userId。
 * 非本人记录对外表现为 `NOT_FOUND`，不泄露资源是否存在（防探测）。
 */
export function requireOwnership(request: FastifyRequest, ownerUserId: string): void {
  const identity = readIdentity(request);
  if (identity.userId !== ownerUserId) {
    throw new ApiError('NOT_FOUND', '记录不存在');
  }
}

// ---------------------------------------------------------------------------
// Fastify preHandler 适配
// ---------------------------------------------------------------------------

export interface AuthGuards {
  /** 用户端受保护路由：未登录 → 401 SESSION_REQUIRED，失效 → 401 SESSION_EXPIRED。 */
  requireUser: preHandlerHookHandler;
  /** 后台受保护路由：用户会话 → 403 SCOPE_DENIED。 */
  requireAdmin: preHandlerHookHandler;
  /** 后台 scope 守卫，需置于 requireAdmin 之后。 */
  requireScope: (scope: string) => preHandlerHookHandler;
}

export function createAuthGuards(context: AuthContext): AuthGuards {
  const requireUser: preHandlerHookHandler = async (request: FastifyRequest, _reply: FastifyReply) => {
    const { identity } = await authenticateUser(context, request);
    applyIdentity(request, identity);
  };
  const requireAdmin: preHandlerHookHandler = async (request: FastifyRequest, _reply: FastifyReply) => {
    const { identity } = await authenticateAdmin(context, request);
    applyIdentity(request, identity);
  };
  return {
    requireUser,
    requireAdmin,
    requireScope: (scope: string) => async (request: FastifyRequest) => {
      requireScope(request, scope);
    },
  };
}
