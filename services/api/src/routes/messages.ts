import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import { readIdentity, type AuthGuards } from '../auth/middleware.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { strongEtagOf, type MessagesService } from '../messages/service.ts';
import { requireIdempotencyKey, requireIfMatch } from '../messages/validate.ts';
import { buildMeta } from './support.ts';

/** Three frozen message operations; message creation remains server-internal. */
export function registerMessageRoutes(
  app: FastifyInstance, config: AppConfig, guards: AuthGuards, service: MessagesService | null,
): void {
  const emptyQuery = { type: 'object', additionalProperties: false, properties: {} };
  function ready(request: FastifyRequest): MessagesService {
    if (request.body !== undefined) throw new ApiError('INVALID_REQUEST', '此接口不接受请求体');
    if (service === null) throw new ApiError('PROVIDER_UNAVAILABLE', '消息持久存储尚未接线', { retryable: true });
    return service;
  }
  const noStore = async (_request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
  };
  app.get(`${API_PREFIX}/messages`, {
    onRequest: noStore, preHandler: guards.requireUser,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      cursor: { type: 'string', minLength: 1, maxLength: 2048 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    } } },
  }, async request => {
    const data = await ready(request).listMessages(readIdentity(request), request.query);
    return { data, meta: buildMeta(request, config) };
  });
  app.get(`${API_PREFIX}/messages/unread-count`, {
    onRequest: noStore, preHandler: guards.requireUser, schema: { querystring: emptyQuery },
  }, async (request) => {
    const data = await ready(request).getUnreadCount(readIdentity(request));
    return { data, meta: buildMeta(request, config) };
  });
  app.put(`${API_PREFIX}/messages/:id/read`, {
    onRequest: noStore, preHandler: guards.requireUser,
    schema: {
      querystring: emptyQuery,
      params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const idempotencyKey = requireIdempotencyKey(request.headers['idempotency-key']);
    const ifMatch = requireIfMatch(request.headers['if-match']).raw;
    const data = await ready(request).markMessageRead(readIdentity(request), (request.params as { id: string }).id, { idempotencyKey, ifMatch });
    return reply.header('ETag', strongEtagOf(data.revision)).send({ data, meta: buildMeta(request, config) });
  });
}
