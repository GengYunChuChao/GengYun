/**
 * GY-I12（#12）· 会话/轮次路由（契约里**全部七个**问答 operation）。
 *
 * 逐条对应 `packages/contracts/operations.json`（**不新增 path、不新增响应键**）：
 *   | operation | method | path |
 *   |---|---|---|
 *   | `createConversation` | POST | `/conversations` |
 *   | `listConversations` | GET | `/conversations` |
 *   | `getConversation` | GET | `/conversations/{id}` |
 *   | `deleteConversation` | DELETE | `/conversations/{id}` |
 *   | `createTurn` | POST | `/conversations/{id}/turns` |
 *   | `listTurns` | GET | `/conversations/{id}/turns` |
 *   | `deleteTurn` | DELETE | `/conversations/{id}/turns/{turn_id}` |
 *
 * 响应头口径（契约对每个成功响应都声明 `ETag` 与 `Cache-Control`，但**都没有标 required**）：
 *   - 单资源（`getConversation`/`getConversation` 的 200、`createTurn` 的 202）⇒ 强 ETag
 *     `"<revision>"` + `Cache-Control: no-store`；
 *   - **列表**（两个 200 页）⇒ 只 `Cache-Control: no-store`（契约 ETag 描述逐字写明"列表无此头"）；
 *   - 202 `AckEnvelope`（两个 DELETE）⇒ 只 `Cache-Control: no-store`：`Ack` 只有 `accepted`、
 *     没有 revision 可绑定，**不伪造 ETag**（与 `routes/speech.ts` 的既有口径一致）。
 *
 * 未实现的相邻路径（例如 `PATCH /conversations/{id}`、`GET /conversations/{id}/turns/{turn_id}`）
 * **不注册** ⇒ 走 `app.ts` 的 `setNotFoundHandler`，如实回契约 `NOT_FOUND`；**不**吞成 200 空壳。
 *
 * 服务层未接线（`service === null`）⇒ 一律 503 `PROVIDER_UNAVAILABLE`（retryable），
 * 让"没接线"与"资源不存在"在响应上可区分。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import { currentIdentity, readIdentity, type AuthGuards } from '../auth/middleware.ts';
import { readBearerToken } from '../auth/tokens.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import type { ConversationService, ConversationSession } from '../conversations/service.ts';
import { buildMeta } from './support.ts';

const noStore = { 'Cache-Control': 'no-store' } as const;

const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const turnParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'turn_id'],
  properties: { id: { type: 'string', format: 'uuid' }, turn_id: { type: 'string', format: 'uuid' } },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', minLength: 1, maxLength: 2048 },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  },
} as const;

const noQuery = { type: 'object', additionalProperties: false } as const;

/**
 * 请求体只声明"是对象"。
 *
 * 逐字段的判定**全部**留在服务层的 `conversations/validate.ts`（`ConversationInput` 的
 * `conditions` 闭集、`TurnInput` 的 `oneOf` 判别子）。为什么不在路由 schema 里复写一遍：
 * 同一份契约形状只能有一个执行点，否则两处判定会各自漂移；而 fastify 的 schema 校验失败
 * 会走 `app.ts` 的统一 400 分支，错误 `details` 也不如本域校验的结构化 `{field,code}`。
 * 这里只拦"根本不是对象"的请求体（含缺失/不可解析的 JSON ⇒ 400 `INVALID_REQUEST`）。
 */
const bodyObject = { type: 'object' } as const;

export function registerConversationRoutes(
  app: FastifyInstance,
  config: AppConfig,
  guards: AuthGuards,
  service: ConversationService | null,
): void {
  function ready(): ConversationService {
    if (service === null) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '问答持久存储尚未接线', { retryable: true });
    }
    return service;
  }

  /** 只读 operation 的调用方身份（`readIdentity` 的 `userId`/`authEpoch`/`role`）。 */
  function actorOf(request: FastifyRequest) {
    return readIdentity(request);
  }

  /**
   * `createTurn` 需要**完整**会话：检索集合在回答阶段要走 `/knowledge` 的同一读面，
   * 读面自己做会话校验（需 `sessionId`）与凭据校验（需 Bearer 令牌）。两者都在**受理时**
   * 捕获，随异步任务传下去 —— 异步阶段不重新鉴权、也不跳过鉴权。
   */
  function sessionOf(request: FastifyRequest): ConversationSession {
    const token = readBearerToken(request.headers.authorization);
    if (token === null) throw new ApiError('SESSION_REQUIRED', '需要用户会话');
    return { identity: currentIdentity(request), token };
  }

  function headersOf(request: FastifyRequest): { idempotencyKey: unknown; ifMatch: unknown } {
    return {
      idempotencyKey: request.headers['idempotency-key'],
      ifMatch: request.headers['if-match'],
    };
  }

  // ---------------------------------------------------------------- 会话

  app.post(
    `${API_PREFIX}/conversations`,
    { preHandler: guards.requireUser, schema: { body: bodyObject } },
    async (request, reply) => {
      const outcome = await ready().createConversation(actorOf(request), request.body, headersOf(request));
      const headers = reply.status(201).headers(noStore);
      if (outcome.etag !== undefined) headers.header('ETag', outcome.etag);
      return headers.send({ data: outcome.data, meta: buildMeta(request, config) });
    },
  );

  app.get(
    `${API_PREFIX}/conversations`,
    { preHandler: guards.requireUser, schema: { querystring: listQuery } },
    async (request, reply) => {
      const outcome = await ready().listConversations(actorOf(request), request.query as { cursor: string | null; limit: number });
      // 列表：契约 ETag 描述写明"列表无此头"，故只下发 no-store。
      return reply.headers(noStore).send({ data: outcome.data, meta: buildMeta(request, config) });
    },
  );

  app.get(
    `${API_PREFIX}/conversations/:id`,
    { preHandler: guards.requireUser, schema: { params: idParams, querystring: noQuery } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const outcome = await ready().getConversation(actorOf(request), id);
      const headers = reply.headers(noStore);
      if (outcome.etag !== undefined) headers.header('ETag', outcome.etag);
      return headers.send({ data: outcome.data, meta: buildMeta(request, config) });
    },
  );

  app.delete(
    `${API_PREFIX}/conversations/:id`,
    { preHandler: guards.requireUser, schema: { params: idParams, querystring: noQuery } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const outcome = await ready().deleteConversation(actorOf(request), id, headersOf(request));
      // 202 Ack：`Ack` 没有 revision 可绑定 ⇒ 不伪造 ETag。
      return reply.status(202).headers(noStore).send({ data: outcome.data, meta: buildMeta(request, config) });
    },
  );

  // ---------------------------------------------------------------- 轮次

  app.post(
    `${API_PREFIX}/conversations/:id/turns`,
    { preHandler: guards.requireUser, schema: { params: idParams, querystring: noQuery, body: bodyObject } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const outcome = await ready().createTurn(sessionOf(request), id, request.body, headersOf(request));
      // 202 Job：作业有 revision（受理时 = 1），故按契约给强 ETag。
      const headers = reply.status(202).headers(noStore);
      if (outcome.etag !== undefined) headers.header('ETag', outcome.etag);
      return headers.send({ data: outcome.data, meta: buildMeta(request, config) });
    },
  );

  app.get(
    `${API_PREFIX}/conversations/:id/turns`,
    { preHandler: guards.requireUser, schema: { params: idParams, querystring: listQuery } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const outcome = await ready().listTurns(actorOf(request), id, request.query as { cursor: string | null; limit: number });
      return reply.headers(noStore).send({ data: outcome.data, meta: buildMeta(request, config) });
    },
  );

  app.delete(
    `${API_PREFIX}/conversations/:id/turns/:turn_id`,
    { preHandler: guards.requireUser, schema: { params: turnParams, querystring: noQuery } },
    async (request, reply) => {
      const { id, turn_id: turnId } = request.params as { id: string; turn_id: string };
      const outcome = await ready().deleteTurn(actorOf(request), id, turnId, headersOf(request));
      const headers = reply.status(202).headers(noStore);
      // 级联处置的**非契约披露**（沿用 `routes/history.ts` 的既有先例）：
      // 只区分 initiated/unwired/failed，绝不声称"外部清理已完成"。
      if (outcome.cascade !== undefined) headers.header('X-GY-Cascade', outcome.cascade);
      return headers.send({ data: outcome.data, meta: buildMeta(request, config) });
    },
  );
}
