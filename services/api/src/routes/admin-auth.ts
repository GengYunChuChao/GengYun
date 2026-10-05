/**
 * 独立后台认证路由（契约 openapi：loginAdmin / getAdminSession / logoutAdmin）。
 *
 * 挂载在 /api/v1 之下：
 * - POST /admin/auth/session 公开；login_name + password；需 Idempotency-Key。
 * - GET  /admin/auth/session 需后台会话且具 scope `session:read`。
 * - POST /admin/auth/logout  需后台会话且具 scope `session:logout`；需 Idempotency-Key。
 *
 * 会话隔离：后台会话与用户会话分表、分 audience，令牌不可互用；
 * 普通用户会话访问后台 → 403 SCOPE_DENIED（见 middleware.authenticateAdmin）。
 *
 * 契约缺口（如实报告）：error_status_map 未定义“凭据错误”专用码，
 * 后台口令错误沿用 401 `SESSION_REQUIRED`（语义为“未建立会话”），不臆造新码。
 */
import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../contract.ts';
import type { AppConfig } from '../config.ts';
import type { AuthService } from '../auth/service.ts';
import { issuedSessionToSession, sessionInfo } from '../auth/service.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import { currentIdentity } from '../auth/middleware.ts';
import { buildMeta, runIdempotent } from './support.ts';

/** openapi components.schemas.AdminLoginInput（additionalProperties:false）。 */
export const ADMIN_LOGIN_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['login_name', 'password'],
  properties: {
    login_name: { type: 'string', minLength: 1, maxLength: 80 },
    password: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

export interface AdminAuthRouteDeps {
  service: AuthService;
  guards: AuthGuards;
  now: () => Date;
}

export function registerAdminAuthRoutes(app: FastifyInstance, config: AppConfig, deps: AdminAuthRouteDeps): void {
  const { service, guards, now } = deps;

  app.post(
    `${API_PREFIX}/admin/auth/session`,
    { schema: { body: ADMIN_LOGIN_BODY_SCHEMA } },
    async (request, reply) => {
      const body = request.body as { login_name: string; password: string };
      await runIdempotent({
        request,
        reply,
        service,
        subject: 'anonymous',
        method: 'POST',
        routePath: '/admin/auth/session',
        now,
        produce: async () => {
          const issued = await service.loginAdmin(body.login_name, body.password);
          return {
            status: 200,
            body: { data: issuedSessionToSession(issued), meta: buildMeta(request, config) },
            etag: `"${issued.revision}"`,
            cacheControl: 'no-store',
          };
        },
      });
    },
  );

  app.get(
    `${API_PREFIX}/admin/auth/session`,
    { preHandler: [guards.requireAdmin, guards.requireScope('session:read')] },
    async (request, reply) => {
      const identity = currentIdentity(request);
      const scopes = await service.listAdminScopes(identity.userId);
      reply.header('ETag', `"${identity.revision}"`);
      reply.header('Cache-Control', 'no-store');
      return reply.status(200).send({
        data: sessionInfo({ audience: 'admin', expiresAt: identity.expiresAt, scopes, revision: identity.revision }),
        meta: buildMeta(request, config),
      });
    },
  );

  app.post(
    `${API_PREFIX}/admin/auth/logout`,
    { preHandler: [guards.requireAdmin, guards.requireScope('session:logout')] },
    async (request, reply) => {
      const identity = currentIdentity(request);
      await runIdempotent({
        request,
        reply,
        service,
        subject: identity.userId,
        method: 'POST',
        routePath: '/admin/auth/logout',
        now,
        produce: async () => {
          const result = await service.logoutAdmin(identity.sessionId);
          return {
            status: 200,
            body: { data: { accepted: result.accepted }, meta: buildMeta(request, config) },
            cacheControl: 'no-store',
          };
        },
      });
    },
  );
}
