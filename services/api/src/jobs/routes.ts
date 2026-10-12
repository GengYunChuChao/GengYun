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
 * **不注册 `params: {format:'uuid'}`**（刻意，见证据文档）：契约把路径参数标为 `format: uuid`，但派单要求
 * 「他人作业／未知 id／非法 uuid／未接线 kind」四类**对外封套逐字节同形**；若在 Fastify 层用 `format:'uuid'`
 * 校验，非法 uuid 会先被判 `400 INVALID_REQUEST`，与其余三类的 `404 NOT_FOUND` 不同形。因此这里把
 * 形状判定交给各域服务（非 uuid 一律走"找不到"分支）⇒ 四类同形。
 * 同理**不声明 querystring schema**：与迁移前的识别域路由一致（未声明的查询参数被忽略），避免为共享路径引入新的拒绝面。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readIdentity } from '../auth/middleware.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import type { AppConfig } from '../config.ts';
import { API_PREFIX } from '../contract.ts';
import { buildMeta } from '../routes/support.ts';
import type { JobRegistry } from './registry.ts';

export function registerJobRoutes(
  app: FastifyInstance,
  config: AppConfig,
  guards: AuthGuards,
  registry: JobRegistry,
): void {
  const actorId = (request: FastifyRequest): string => readIdentity(request).userId;
  const jobIdOf = (request: FastifyRequest): string => (request.params as { id: string }).id;

  app.get(`${API_PREFIX}/jobs/:id`, { preHandler: guards.requireUser }, async (request, reply) => {
    const job = await registry.get({ userId: actorId(request), jobId: jobIdOf(request) });
    return reply
      .status(200)
      .header('ETag', `"${job.revision}"`)
      .header('Cache-Control', 'no-store')
      .send({ data: job, meta: buildMeta(request, config) });
  });

  app.post(`${API_PREFIX}/jobs/:id/cancel`, { preHandler: guards.requireUser }, async (request, reply) => {
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
  });
}
