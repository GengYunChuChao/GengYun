/**
 * GY-I16（#16）· 收藏路由（契约 operationId 一一对应，不新增字段、不新增路径）：
 *   GET    /favorites        listFavorites  → FavoritePageEnvelope
 *   POST   /favorites        createFavorite → 201 FavoriteEnvelope
 *   DELETE /favorites/{id}   deleteFavorite → AckEnvelope
 *
 * 归属：一律 `guards.requireUser`；越权/不存在由服务层统一映射 `NOT_FOUND`，不泄露存在性。
 * 私有响应一律 `Cache-Control: no-store`；资源响应带 `ETag: "<revision>"`（列表无此头，
 * 与契约 `headers.ETag.description` 一致）。
 *
 * `DELETE` **不**回 `ETag`：该操作的成功响应是 `Ack`（无 revision 字段），资源已被删除，
 * 回一个"已删除资源的 ETag"是编造；口径与已合并的 `DELETE /recognitions/{id}`（202 + Ack）一致。
 *
 * 本路由**不挂**用途授权中间件：收藏只需用户自己的会话（契约 `security: userSession`），
 * 不产生外发、不写派生内容；读取与取消必须在撤回用途后依然可用。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readIdentity } from '../auth/middleware.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import type { AppConfig } from '../config.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { strongEtagOf, type FavoritesService } from '../favorites/service.ts';
import { buildMeta } from './support.ts';

const noStore = { 'Cache-Control': 'no-store' } as const;

const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

/** 契约 `FavoriteInput`：required 恰为 `target_ref`；三字段全必填、`type` 3 项闭集。 */
const favoriteBody = {
  type: 'object',
  additionalProperties: false,
  required: ['target_ref'],
  properties: {
    target_ref: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id', 'revision'],
      properties: {
        type: { type: 'string', enum: ['species', 'herbicide', 'scheme'] },
        id: { type: 'string', minLength: 1, maxLength: 80 },
        revision: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const;

/** 契约 `GET /favorites` 只有 `cursor`/`limit`；多余查询参数由 schema 直接拒绝（400）。 */
const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', minLength: 1, maxLength: 2048 },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  },
} as const;

function actorId(request: FastifyRequest): string {
  return readIdentity(request).userId;
}

/**
 * 注册收藏路由。
 *
 * `service` 由装配层按执行模式解析：`real` 模式下收藏域**整体关闭**
 * （`null` ⇒ 三条路由一律 503 `PROVIDER_UNAVAILABLE`，绝不用内存存储冒充持久化）。
 */
export function registerFavoriteRoutes(
  app: FastifyInstance,
  config: AppConfig,
  guards: AuthGuards,
  service: FavoritesService | null,
): void {
  function ready(request: FastifyRequest): FavoritesService {
    if (service === null) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '收藏持久存储尚未接线', { retryable: true });
    }
    return service;
  }

  app.get(`${API_PREFIX}/favorites`, { preHandler: guards.requireUser, schema: { querystring: listQuery } }, async (request, reply) => {
    const data = await ready(request).listFavorites(readIdentity(request), request.query);
    return reply.headers(noStore).send({ data, meta: buildMeta(request, config) });
  });

  app.post(
    `${API_PREFIX}/favorites`,
    { preHandler: guards.requireUser, schema: { querystring: { type: 'object', additionalProperties: false, properties: {} }, body: favoriteBody } },
    async (request, reply) => {
      const data = await ready(request).createFavorite(readIdentity(request), request.body, {
        idempotencyKey: request.headers['idempotency-key'],
      });
      return reply
        .status(201)
        .headers(noStore)
        .header('ETag', strongEtagOf(data.revision))
        .send({ data, meta: buildMeta(request, config) });
    },
  );

  app.delete(
    `${API_PREFIX}/favorites/:id`,
    { preHandler: guards.requireUser, schema: { params: idParams } },
    async (request, reply) => {
      const data = await ready(request).deleteFavorite(readIdentity(request), (request.params as { id: string }).id, {
        idempotencyKey: request.headers['idempotency-key'],
        ifMatch: request.headers['if-match'],
      });
      return reply.headers(noStore).send({ data, meta: buildMeta(request, config) });
    },
  );
}
