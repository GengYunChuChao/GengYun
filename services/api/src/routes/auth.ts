/**
 * 用户端认证路由（契约 openapi：loginWechat / getUserSession / logoutUser）。
 *
 * 挂载在契约 `servers[0].url` = /api/v1 之下：
 * - POST /auth/wechat  公开；仅凭 code 建立会话；不强制手机号；需 Idempotency-Key。
 * - GET  /auth/session 需用户会话；返回 SessionInfo（本人）。
 * - POST /auth/logout  需用户会话；撤销当前会话；需 Idempotency-Key。
 *
 * 客户端不能指定 openid / 角色 / 用户 id：请求体 schema 为 additionalProperties:false，
 * 且服务端从不读取这些字段（见 app.ts 关闭 ajv removeAdditional，多余字段直接 400）。
 */
import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../contract.ts';
import type { AppConfig } from '../config.ts';
import { ApiError } from '../errors.ts';
import type { AuthService } from '../auth/service.ts';
import { issuedSessionToSession, sessionInfo } from '../auth/service.ts';
import { isLoginOutcomeReference } from '../auth/idempotency.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import { currentIdentity } from '../auth/middleware.ts';
import { buildMeta, runIdempotent } from './support.ts';

/** openapi components.schemas.WechatLoginInput（additionalProperties:false）。 */
export const WECHAT_LOGIN_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['code'],
  properties: {
    code: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

export interface UserAuthRouteDeps {
  service: AuthService;
  guards: AuthGuards;
  now: () => Date;
}

export function registerUserAuthRoutes(app: FastifyInstance, config: AppConfig, deps: UserAuthRouteDeps): void {
  const { service, guards, now } = deps;

  app.post(
    `${API_PREFIX}/auth/wechat`,
    { schema: { body: WECHAT_LOGIN_BODY_SCHEMA } },
    async (request, reply) => {
      const body = request.body as { code: string };
      await runIdempotent({
        request,
        reply,
        service,
        // 登录端点无会话主体：键域固定为 anonymous（同键异体由请求摘要判冲突）。
        subject: 'anonymous',
        method: 'POST',
        routePath: '/auth/wechat',
        now,
        produce: async () => {
          const issued = await service.loginWechat(body.code);
          return {
            status: 200,
            body: { data: issuedSessionToSession(issued), meta: buildMeta(request, config) },
            // 台账只存不含凭据的结果引用（会话 id + 受众），不存令牌明文。
            idempotencyOutcome: { sessionId: issued.sessionId, audience: 'user' },
            etag: `"${issued.revision}"`,
            cacheControl: 'no-store',
          };
        },
        replay: async (record) => {
          if (!isLoginOutcomeReference(record.outcome)) {
            throw new ApiError('IDEMPOTENCY_CONFLICT', '幂等台账结果引用与登录请求不一致');
          }
          // 重新执行含当前状态校验的路径（账号 active / epoch 未变），重新签发新会话。
          const issued = await service.replayUserLogin(record.outcome);
          return {
            status: 200,
            body: { data: issuedSessionToSession(issued), meta: buildMeta(request, config) },
            idempotencyOutcome: { sessionId: issued.sessionId, audience: 'user' },
            etag: `"${issued.revision}"`,
            cacheControl: 'no-store',
          };
        },
      });
    },
  );

  app.get(`${API_PREFIX}/auth/session`, { preHandler: guards.requireUser }, async (request, reply) => {
    // 身份只来自服务端会话；任何客户端声称的 user_id / role 都不参与判定。
    const identity = currentIdentity(request);
    reply.header('ETag', `"${identity.revision}"`);
    reply.header('Cache-Control', 'no-store');
    return reply.status(200).send({
      data: sessionInfo({
        audience: 'user',
        expiresAt: identity.expiresAt,
        scopes: identity.scopes,
        revision: identity.revision,
      }),
      meta: buildMeta(request, config),
    });
  });

  app.post(`${API_PREFIX}/auth/logout`, { preHandler: guards.requireUser }, async (request, reply) => {
    const identity = currentIdentity(request);
    await runIdempotent({
      request,
      reply,
      service,
      subject: identity.userId,
      method: 'POST',
      routePath: '/auth/logout',
      now,
      produce: async () => {
        const result = await service.logoutUser(identity.sessionId);
        return {
          status: 200,
          body: { data: { accepted: result.accepted }, meta: buildMeta(request, config) },
          // 退出响应不含凭据：结果引用记为成功标记。
          idempotencyOutcome: { accepted: true },
          cacheControl: 'no-store',
        };
      },
    });
  });
}
