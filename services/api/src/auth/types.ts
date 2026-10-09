/**
 * GY-I04 认证与会话层 · 共享类型。
 *
 * 与 GY-I27（packages/privacy）的接口缝：本层在请求上填充
 * `userId` / `authEpoch`（正整数）/ `role`，供 I27 的 `requireConsent` 直接消费
 * （`const identity = { userId: req.userId, authEpoch: req.authEpoch }`）。
 * 本层不 import、不修改 packages/privacy/**（归 I27 分支）。
 */

/** 契约 Session.audience / SessionInfo.audience。 */
export type SessionAudience = 'user' | 'admin';

/** 请求上的角色，等价于会话 audience；供 I27 及后续任务消费。 */
export type RequestRole = SessionAudience;

export type UserState = 'active' | 'suspended' | 'deletion_pending' | 'deleted';
export type AdminState = 'active' | 'suspended';

export interface UserRecord {
  id: string;
  state: UserState;
  /** 服务端权威 auth_epoch（正整数）。客户端不可声明。 */
  authEpoch: number;
  /** users.revision，用于会话响应 revision。 */
  revision: number;
}

export interface AdminRecord {
  id: string;
  loginName: string;
  state: AdminState;
  authEpoch: number;
  revision: number;
}

/** 已建立的会话（不含明文令牌）。 */
export interface StoredSession {
  id: string;
  userId: string;
  audience: SessionAudience;
  /** 建立时冻结的 auth_epoch 快照；与账号当前值不一致即旧会话。 */
  authEpoch: number;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * 会话层解析出的调用方身份（服务端权威）。
 *
 * 与 GY-I27 的接口缝：`userId` / `authEpoch`（正整数）/ `role` 会原样填到
 * `req.userId` / `req.authEpoch` / `req.role`，供 `requireConsent` 消费。
 * 这三项**只来自服务端存储**，客户端无法通过请求体/查询/头部声明。
 */
export interface AuthenticatedIdentity {
  userId: string;
  authEpoch: number;
  role: RequestRole;
  /** 会话 id（不含明文令牌）；仅服务端内部使用，不进入响应。 */
  sessionId: string;
  expiresAt: Date;
  /** 账号 revision，用于会话响应与强 ETag。 */
  revision: number;
  /** user 会话为 ['user']；admin 会话为后台已授予的 scope 列表。 */
  scopes: string[];
}
