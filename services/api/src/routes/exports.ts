/**
 * `GET /me/exports`（契约 `listExports`，`x-scope: user`）—— 导出清单的只读列表。
 *
 * 契约对齐（`packages/contracts/openapi.json` 的 `/me/exports`，逐项）：
 * | 契约项 | 实现 |
 * | --- | --- |
 * | `security: userSession` | `guards.requireUser`（缺/失效会话 ⇒ 401） |
 * | `parameters: Cursor`（string ≤2048） | querystring schema `cursor`，`maxLength: 2048` |
 * | `parameters: Limit`（1..50，默认 20） | querystring schema `limit`，`minimum/maximum/default` |
 * | `200 → ExportPageEnvelope` | `{ data: { items, next_cursor }, meta: buildMeta(...) }` |
 * | `200` 头 `Cache-Control` | `no-store`（私有/授权访问） |
 * | `200` 头 `ETag` | **不发**（契约原文：「资源revision强ETag；列表无此头」） |
 * | `503` | 无连接池 / 账本不可用 ⇒ `PROVIDER_UNAVAILABLE`（**不**用内存账本冒充） |
 * | `400` | 参数校验（`INVALID_REQUEST`）；游标不可用 ⇒ `INVALID_CURSOR` |
 *
 * 只读接口 ⇒ 不要求 `Idempotency`。主体绑定：`userId` 只来自会话存储（`readIdentity`），
 * 查询参数里没有任何"用户"维度 ⇒ 用户只能看自己的清单。
 */
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { PgPool } from '../db/pool.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import { readIdentity } from '../auth/middleware.ts';
import { STUB_IDEMPOTENCY_HMAC_KEY } from '../auth/service.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { createExportsListService } from '../privacy/exports-list.ts';
import { withPrivacyErrors } from '../privacy/egress.ts';
import { buildMeta } from './support.ts';

export function registerExportRoutes(
  app: FastifyInstance,
  config: AppConfig,
  pool: PgPool | null,
  guards: AuthGuards,
): void {
  // 无池 ⇒ 装配为 null，请求时 fail-closed 503。**不**降级成内存账本（那会让"导出清单"
  // 看起来有数据却不是持久账本）。
  const service = pool === null
    ? null
    : createExportsListService({ pool, hmacKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY });
  app.get(`${API_PREFIX}/me/exports`, {
    preHandler: guards.requireUser,
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cursor: { type: 'string', maxLength: 2048 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
      },
    },
  }, withPrivacyErrors(async (request, reply) => {
    if (service === null) throw new ApiError('PROVIDER_UNAVAILABLE', '外发账本数据库未配置');
    const identity = readIdentity(request);
    // 与授权列表同口径：本 operation 的 `x-scope` 是 `user`，后台会话不得读用户清单。
    if (identity.role !== 'user') throw new ApiError('SCOPE_DENIED', '需要用户会话');
    const data = await service.list(identity, request.query as { cursor?: string; limit: number });
    return reply.header('Cache-Control', 'no-store').send({ data, meta: buildMeta(request, config) });
  }));
}
