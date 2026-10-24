import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { PgPool } from '../db/pool.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import { currentIdentity } from '../auth/middleware.ts';
import { STUB_IDEMPOTENCY_HMAC_KEY } from '../auth/service.ts';
import { readBearerToken } from '../auth/tokens.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { CONSENT_PURPOSES, createPostgresConsentService, type EgressRevoker } from '../privacy/consent-pg.ts';
import { createPrivacyPolicyReaderForPool, type PrivacyPolicyReader } from '../privacy/privacy-policy.ts';
import { buildMeta } from './support.ts';

/**
 * 只在 `onRequest` 写 `Cache-Control: no-store`：成功与错误分支（401/503 等）都必须 no-store，
 * 只在 handler 里写会让错误响应失去该头。口径与 `routes/community.ts:181-183` 逐字一致。
 *
 * 同文件既有的三条 `/me/consents` 路由仍在 handler 里写同头（`consents.ts:38,48,63`）；本片只在
 * **新路由**上采用 hook 口径，不改既有三条 —— 缩小 diff、不挪既有台账锚点。
 */
const noStoreHook = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  reply.header('Cache-Control', 'no-store');
};

export function registerConsentRoutes(app: FastifyInstance, config: AppConfig, pool: PgPool | null, guards: AuthGuards, testOptions: { allowSyntheticGrantPolicy?: boolean; egressRevoker?: EgressRevoker } = {}): void {
  const service = pool === null ? null : createPostgresConsentService(pool, config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY, testOptions);
  // 未接线（无连接池）⇒ 读面 fail-closed 503，不返回「没有政策」冒充确定空态。
  const policyReader: PrivacyPolicyReader = createPrivacyPolicyReaderForPool(pool);
  const input = (request: FastifyRequest) => {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
    return { identity: currentIdentity(request), token };
  };
  const requireService = () => {
    if (service === null) throw new ApiError('PROVIDER_UNAVAILABLE', '授权数据库未配置');
    return service;
  };
  app.post(`${API_PREFIX}/me/consents`, {
    preHandler: guards.requireUser,
    schema: {
      querystring: { type: 'object', additionalProperties: false },
      body: { type: 'object', additionalProperties: false, required: ['purpose','policy_version','recipient_ids'], properties: {
        purpose: { type: 'string', enum: CONSENT_PURPOSES },
        policy_version: { type: 'string', minLength: 1, maxLength: 80 },
        recipient_ids: { type: 'array', maxItems: 30, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 80 } },
      } },
    },
  }, async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', '缺少有效幂等键');
    const data = await requireService().grant(input(request), { ...(request.body as { purpose: string; policy_version: string; recipient_ids: string[] }), idempotencyKey: key, ifMatch: request.headers['if-match'] });
    return reply.status(201).header('ETag', `"${data.revision}"`).header('Cache-Control', 'no-store').send({ data, meta: buildMeta(request, config) });
  });
  app.get(`${API_PREFIX}/me/consents`, {
    preHandler: guards.requireUser,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      cursor: { type: 'string', maxLength: 2048 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    } } },
  }, async (request, reply) => {
    const query = request.query as { cursor?: string; limit: number };
    const data = await requireService().list(input(request), query);
    return reply.header('Cache-Control', 'no-store').send({ data, meta: buildMeta(request, config) });
  });
  app.delete(`${API_PREFIX}/me/consents/:purpose`, {
    preHandler: guards.requireUser,
    schema: {
      params: { type: 'object', required: ['purpose'], additionalProperties: false, properties: { purpose: { type: 'string', enum: CONSENT_PURPOSES } } },
      querystring: { type: 'object', additionalProperties: false }, body: { type: 'null' },
    },
  }, async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', '缺少有效幂等键');
    const ifMatch = request.headers['if-match'];
    if (ifMatch === undefined) throw new ApiError('REVISION_REQUIRED', '缺少授权版本');
    if (typeof ifMatch !== 'string' || !/^"[1-9][0-9]*"$/.test(ifMatch)) throw new ApiError('INVALID_REQUEST', '授权版本格式无效');
    const data = await requireService().withdraw(input(request), { purpose: (request.params as { purpose: string }).purpose, ifMatch, idempotencyKey: key });
    return reply.header('ETag', `"${data.revision}"`).header('Cache-Control', 'no-store').send({ data, meta: buildMeta(request, config) });
  });
  /**
   * 隐私政策读面（契约 `getPrivacyPolicy`；台账行见 `docs/architecture/contract-status.json`）。
   *
   * 为什么追加在本文件末尾而不是去 `app.ts` 里新注册：`app.ts` 当前被多条在飞分支同时修改，
   * 且台账里大量证据锚点指向它；本路由与同文件的 `/me/consents` 同属 `me` scope
   * （契约 `security: userSession`），追加进本文件零冲突，也不挪动既有锚点。
   *
   * 空态、错误分级与「多版本为何判错」见 `privacy/privacy-policy.ts` 文件头：
   * 无政策行 ⇒ 200 + `version: 'unpublished'`（诚实空态）；无连接池或行不符契约形状 ⇒
   * 503 `PROVIDER_UNAVAILABLE`（fail-closed）。
   */
  app.get(`${API_PREFIX}/me/privacy-policy`, {
    onRequest: noStoreHook,
    preHandler: guards.requireUser,
    schema: { querystring: { type: 'object', additionalProperties: false } },
  }, async (request, reply) => {
    const data = await policyReader.read();
    return reply.send({ data, meta: buildMeta(request, config) });
  });
}
