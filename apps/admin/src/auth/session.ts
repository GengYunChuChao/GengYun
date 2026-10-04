/**
 * 独立后台鉴权入口占位。
 *
 * 约束（ADR-001 / 契约）：
 * - 后台与会话与用户端会话分离（audience=admin，独立 token），本文件不产生任何可用凭据。
 * - 骨架阶段不实现真实登录；不伪造“已登录”状态，不调用 /admin/auth/session。
 * - 真实实现由后续任务承接，须走服务端校验、最小权限 scope 与审计。
 */

export interface AdminSession {
  adminId: string;
  expiresAt: string;
}

/** 明确标记后端鉴权尚未接入。 */
export const ADMIN_AUTH_IMPLEMENTED = false;

/** API 基地址来自公开构建变量；不承载任何密钥。 */
export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

/** 骨架阶段没有会话来源，恒定返回 null（不猜测、不伪造）。 */
export async function loadAdminSession(): Promise<AdminSession | null> {
  return null;
}

/** 登录占位：明确失败，避免以“占位成功”冒充可用后台。 */
export async function signInAdmin(_credentials: { loginName: string; password: string }): Promise<never> {
  throw new Error('独立后台鉴权尚未实现（GY-I02 骨架）；不提供占位登录。');
}

export async function signOutAdmin(): Promise<void> {
  throw new Error('独立后台鉴权尚未实现（GY-I02 骨架）；不提供占位登出。');
}
