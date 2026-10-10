import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { PgPool } from '../db/pool.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import { currentIdentity } from '../auth/middleware.ts';
import { readBearerToken } from '../auth/tokens.ts';
import { STUB_IDEMPOTENCY_HMAC_KEY } from '../auth/service.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { createProfileService, type ProfileInput } from '../profile/service.ts';
import { buildMeta } from './support.ts';

export function registerProfileRoutes(app: FastifyInstance, config: AppConfig, pool: PgPool | null, guards: AuthGuards): void {
  const service = pool === null ? null : createProfileService(pool, config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY);
  function input(request: FastifyRequest) {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
    return {identity: currentIdentity(request), token};
  }
  function ready() {
    if (service === null) throw new ApiError('PROVIDER_UNAVAILABLE', '档案数据库尚未配置');
    return service;
  }
  const querystring = { type: 'object', additionalProperties: false };
  app.get(`${API_PREFIX}/me/profile`, {preHandler: guards.requireUser, schema: {querystring}}, async (request, reply) => {
    const data = await ready().get(input(request));
    return reply.header('Cache-Control', 'no-store').header('ETag', `"${data.revision}"`).send({data, meta: buildMeta(request, config)});
  });
  app.put(`${API_PREFIX}/me/profile`, {preHandler: guards.requireUser, schema: {querystring, body: {
    type: 'object', additionalProperties: false, required: ['crop_id', 'region_code', 'region_catalog_version'], properties: {
      crop_id: {type: 'string', minLength: 1, maxLength: 80}, region_code: {type: 'string', pattern: '^33[0-9]{4}$'},
      region_catalog_version: {type: 'string', minLength: 1, maxLength: 80},
    },
  }}}, async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', '缺少有效幂等键');
    const version = request.headers['if-match'];
    if (version === undefined) throw new ApiError('REVISION_REQUIRED', '缺少档案版本');
    if (typeof version !== 'string' || !/^"[1-9][0-9]*"$/.test(version) || !Number.isSafeInteger(Number(version.slice(1,-1)))) throw new ApiError('INVALID_REQUEST', '档案版本无效');
    const data = await ready().put(input(request), request.body as ProfileInput, version, key);
    return reply.header('Cache-Control', 'no-store').header('ETag', `"${data.revision}"`).send({data, meta: buildMeta(request, config)});
  });
  for (const kind of ['crops', 'regions'] as const) {
    app.get(`${API_PREFIX}/catalog/${kind}`, {preHandler: guards.requireUser, schema: {querystring: {
      type: 'object', additionalProperties: false, properties: {
        cursor: {type: 'string', minLength: 1, maxLength: 2048}, limit: {type: 'integer', minimum: 1, maximum: 50, default: 20},
        ...(kind === 'regions' ? {parent_code: {type: 'string', pattern: '^33[0-9]{4}$'}} : {}),
      },
    }}}, async (request, reply) => {
      const data = await ready().list(input(request), kind, request.query as {cursor?: string; limit: number; parent_code?: string});
      return reply.header('Cache-Control', 'no-store').send({data, meta: buildMeta(request, config)});
    });
  }
}
