/**
 * GY-I16（#16）· 历史路由（契约 operationId 一一对应，不新增字段、不新增路径）：
 *   GET    /history        listHistory  → HistoryPageEnvelope
 *   DELETE /history/{id}   deleteHistory → AckEnvelope
 *
 * **刻意不注册 `GET /history/{id}`**：契约里 `/history/{id}` 只有 `delete`。
 * 历史详情由客户端用列表项的目标引用去读**已合并**的 `GET /recognitions/{id}`（#9）或
 * `GET /ocr/{id}`（#10）；本片不新造契约外路径。
 *
 * 归属：一律 `guards.requireUser`；越权/不存在由服务层统一映射 `NOT_FOUND`，不泄露存在性。
 * 私有响应一律 `Cache-Control: no-store`；`GET` 是列表 ⇒ **无 `ETag`**（契约 `headers.ETag.description`：
 * 「资源revision强ETag；列表无此头」）。
 *
 * `DELETE` **不**回 `ETag`：成功响应是 `Ack`（无 revision 字段），资源已删除，回一个
 * "已删除资源的 ETag"是编造；口径与已合并的 `DELETE /recognitions/{id}` 一致。
 *
 * ## `X-GY-Cascade`（**非契约披露标记**，与前例 `contract_gap` 同一做法）
 * 契约对该删除的描述是「同时启动关联识别/OCR私有结果/媒体和外发删除」。截至本片，
 * 那条级联链路（`recognitions/**`／`ocr/**`／`media/**`／外发删除）**尚未接线**（属 GY-I19／跨线），
 * 而契约 `Ack` 只有 `accepted` 一个字段、**没有**位置承载这个缺口。因此本路由额外回一个
 * **明确标注为非契约**的响应头，取值：
 *   - `initiated`：级联删除已**启动**（**不代表已完成**）；
 *   - `unwired`：级联尚未接线 —— **只有历史行本身被删除**；
 *   - `failed`：级联启动失败（历史行已完成删除，不受影响）。
 * 客户端**不得**把它当契约字段依赖（前端不读它）；它服务于运营核对、监工复核与回归断言。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readIdentity } from '../auth/middleware.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import type { AppConfig } from '../config.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import type { HistoryService } from '../history/service.ts';
import { buildMeta } from './support.ts';

const noStore = { 'Cache-Control': 'no-store' } as const;

const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

/** 契约 `GET /history` 只有 `cursor`/`limit`；多余查询参数由 schema 直接拒绝（400）。 */
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
 * 注册历史路由。
 *
 * `service` 由装配层按执行模式解析：`real` 模式下历史域**整体关闭**
 * （`null` ⇒ 两条路由一律 503 `PROVIDER_UNAVAILABLE`，绝不用内存存储冒充持久化）。
 */
export function registerHistoryRoutes(
  app: FastifyInstance,
  config: AppConfig,
  guards: AuthGuards,
  service: HistoryService | null,
): void {
  function ready(request: FastifyRequest): HistoryService {
    if (service === null) {
      // 未接线／确定性缺陷 ⇒ 同一请求重试不会成功（需运维改配置或修缺陷）：retryable 必须为 false。
      // 口径原文见 services/api/src/errors.ts 的 ApiError 注释。
      throw new ApiError('PROVIDER_UNAVAILABLE', '历史持久存储尚未接线', { retryable: false });
    }
    return service;
  }

  app.get(`${API_PREFIX}/history`, { preHandler: guards.requireUser, schema: { querystring: listQuery } }, async (request, reply) => {
    const data = await ready(request).listHistory(readIdentity(request), request.query);
    return reply.headers(noStore).send({ data, meta: buildMeta(request, config) });
  });

  app.delete(
    `${API_PREFIX}/history/:id`,
    { preHandler: guards.requireUser, schema: { params: idParams } },
    async (request, reply) => {
      const result = await ready(request).deleteHistory(readIdentity(request), (request.params as { id: string }).id, {
        idempotencyKey: request.headers['idempotency-key'],
        ifMatch: request.headers['if-match'],
      });
      return reply
        .headers(noStore)
        .header('X-GY-Cascade', result.cascade)
        .send({ data: result.data, meta: buildMeta(request, config) });
    },
  );
}
