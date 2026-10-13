/**
 * GY-I01 跨 kind 的作业读面/取消面 · **唯一注册点**（契约 `getJob` / `cancelJob`）。
 *
 * 契约（`packages/contracts/openapi.json`）：
 *   GET  /jobs/{id}        → 200 `JobEnvelope`（`x-task: GY-I01`）
 *   POST /jobs/{id}/cancel → 200 `JobEnvelope`（`x-version-required: true` ⇒ `If-Match` 必填；`Idempotency-Key` 必填）
 * 两者都带 `ETag`（资源 revision 强 ETag）与 `Cache-Control: no-store`。
 *
 * **单一注册**：本文件是全仓**唯一**注册 `/jobs/{id}` 与 `/jobs/{id}/cancel` 的地方。识别域原先在
 * `routes/recognitions.ts` 里自带这两个注册（只查识别域 store），已在本片**迁移**到此处（共享面按 kind 分派），
 * 并由共享面复用同一个识别域服务 ⇒ 识别域行为不变（其既有集成回归仍全绿，见证据文档）。
 *
 * 本层只做三件事：鉴权身份读取、把请求交给注册表、装配封套与头部。业务语义（归属、版本、终态、
 * 幂等回放）全部在**各域服务**里（只读复用）。
 *
 * **两层分工（与 #10/#18 的既有钉子用例同一口径）**：路径参数按契约声明 `format: uuid` ⇒
 * **HTTP 层负责格式**（非 uuid ⇒ `400 INVALID_REQUEST`）；**服务层负责存在性与归属**（⇒ `404 NOT_FOUND`）。
 * 因此「非法 uuid」**不并入**「他人作业／合法但不存在／未接线 kind」那一组同形 404 —— 后三者才是同形的。
 *
 * 这两个操作在契约里**没有声明任何查询参数** ⇒ 显式 `additionalProperties:false`，未声明参数一律 `400 INVALID_REQUEST`
 * （与 `routes/speech.ts` 同口径；**不静默忽略**）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readIdentity } from '../auth/middleware.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import type { AppConfig } from '../config.ts';
import { API_PREFIX } from '../contract.ts';
import { buildMeta } from '../routes/support.ts';
import type { JobRegistry } from './registry.ts';

/** 路径参数：契约 `format: uuid` ⇒ 非 uuid 由 HTTP 层判 400（存在性仍由服务层判 404）。 */
const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

/** 契约未声明查询参数 ⇒ 未声明参数一律 400。 */
const noQuery = { type: 'object', additionalProperties: false } as const;

export function registerJobRoutes(
  app: FastifyInstance,
  config: AppConfig,
  guards: AuthGuards,
  registry: JobRegistry,
): void {
  const actorId = (request: FastifyRequest): string => readIdentity(request).userId;
  const jobIdOf = (request: FastifyRequest): string => (request.params as { id: string }).id;

  app.get(
    `${API_PREFIX}/jobs/:id`,
    { preHandler: guards.requireUser, schema: { params: idParams, querystring: noQuery } },
    async (request, reply) => {
      const job = await registry.get({ userId: actorId(request), jobId: jobIdOf(request) });
      return reply
        .status(200)
        .header('ETag', `"${job.revision}"`)
        .header('Cache-Control', 'no-store')
        .send({ data: job, meta: buildMeta(request, config) });
    },
  );

  app.post(
    `${API_PREFIX}/jobs/:id/cancel`,
    { preHandler: guards.requireUser, schema: { params: idParams, querystring: noQuery } },
    async (request, reply) => {
      const job = await registry.cancel({
        userId: actorId(request),
        jobId: jobIdOf(request),
        ifMatch: request.headers['if-match'],
        idempotencyKey: request.headers['idempotency-key'],
      });
      return reply
        .status(200)
        .header('ETag', `"${job.revision}"`)
        .header('Cache-Control', 'no-store')
        .send({ data: job, meta: buildMeta(request, config) });
    },
  );
}
