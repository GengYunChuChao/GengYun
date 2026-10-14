import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { PgPool } from '../db/pool.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import { currentIdentity } from '../auth/middleware.ts';
import { STUB_IDEMPOTENCY_HMAC_KEY } from '../auth/service.ts';
import { readBearerToken } from '../auth/tokens.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { CONSENT_PURPOSES, createPostgresConsentService, type EgressRevoker } from '../privacy/consent-pg.ts';
import { buildMeta } from './support.ts';

export function registerConsentRoutes(app: FastifyInstance, config: AppConfig, pool: PgPool | null, guards: AuthGuards, testOptions: { allowSyntheticGrantPolicy?: boolean; egressRevoker?: EgressRevoker } = {}): void {
  const service = pool === null ? null : createPostgresConsentService(pool, config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY, testOptions);
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
}
