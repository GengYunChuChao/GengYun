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
  /**
   * 微信 `wx.request` 对 PUT **固定**发送 `content-type: application/json` 与零长 body
   * （客户端不设 content-type 也会被平台补上，见 network 记录 `"data":""`）。
   * 本路由不接受请求体，空 body 即「无 body」。若保留该 content-type，
   * Fastify 默认 JSON 解析器会对零长 body 抛 `FST_ERR_CTP_EMPTY_JSON_BODY`，
   * 被 `app.ts` 映射为 400 `INVALID_REQUEST`，而契约错误码闭集没有它，客户端只能报 `INVALID_RESPONSE`。
   *
   * 这里在解析前剥掉空 body 请求的 content-type，使 Fastify 走
   * 「无 content-type + 空 body」分支直接跳过解析，`request.body` 保持 `undefined`，
   * 由 `ready()` 正常放行。**仅本路由生效**：带真实 body 的请求保留 content-type，
   * 仍会被 `ready()` 以「此接口不接受请求体」拒绝，语义不变。
   */
  const dropEmptyBodyContentType: import('fastify').preParsingHookHandler = (request, _reply, _payload, done) => {
    const headers = request.headers;
    const emptyBody = headers['transfer-encoding'] === undefined &&
      (headers['content-length'] === undefined || headers['content-length'] === '0');
    if (emptyBody && headers['content-type'] !== undefined) delete headers['content-type'];
    done();
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
    onRequest: noStore, preParsing: dropEmptyBodyContentType, preHandler: guards.requireUser,
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
