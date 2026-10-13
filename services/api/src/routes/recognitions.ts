/**
 * GY-I09 识别路由（契约 operationId 一一对应，不新增字段）：
 *   POST   /recognitions                 createRecognition → 202 JobEnvelope
 *   GET    /recognitions/{id}            getRecognition    → RecognitionEnvelope
 *   PATCH  /recognitions/{id}/selection  selectSpecies     → RecognitionEnvelope
 *   DELETE /recognitions/{id}            deleteRecognition → 202 AckEnvelope
 *   GET    /jobs/{id}                    getJob            → JobEnvelope（读 JobState）
 *   POST   /jobs/{id}/cancel             cancelJob         → JobEnvelope（构造 cancelled）
 *
 * 归属：一律 `guards.requireUser`；越权/不存在由服务层统一映射 NOT_FOUND，不泄露存在性。
 * 私有响应一律 `Cache-Control: no-store` + 资源 revision 强 ETag。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readIdentity } from '../auth/middleware.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import type { AppConfig } from '../config.ts';
import { API_PREFIX } from '../contract.ts';
import type { RecognitionService } from '../recognitions/service.ts';
import { buildMeta } from './support.ts';

const noStore = { 'Cache-Control': 'no-store' } as const;

const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const mediaJobBody = {
  type: 'object',
  additionalProperties: false,
  required: ['media_id', 'media_revision'],
  properties: {
    media_id: { type: 'string', format: 'uuid' },
    media_revision: { type: 'integer', minimum: 1 },
  },
} as const;

const selectionBody = {
  type: 'object',
  additionalProperties: false,
  required: ['selected_species_id'],
  properties: { selected_species_id: { type: 'string', minLength: 1, maxLength: 80 } },
} as const;

function actorId(request: FastifyRequest): string {
  return readIdentity(request).userId;
}

export function registerRecognitionRoutes(
  app: FastifyInstance,
  config: AppConfig,
  guards: AuthGuards,
  service: RecognitionService,
): void {
  app.post(
    `${API_PREFIX}/recognitions`,
    { preHandler: guards.requireUser, schema: { body: mediaJobBody } },
    async (request, reply) => {
      const { job } = await service.createRecognition({
        userId: actorId(request),
        body: request.body,
        idempotencyKey: request.headers['idempotency-key'],
      });
      return reply
        .status(202)
        .headers(noStore)
        .header('ETag', `"${job.revision}"`)
        .send({ data: job, meta: buildMeta(request, config) });
    },
  );

  app.get(
    `${API_PREFIX}/recognitions/:id`,
    { preHandler: guards.requireUser, schema: { params: idParams } },
    async (request, reply) => {
      const data = await service.getRecognition({
        userId: actorId(request),
        recognitionId: (request.params as { id: string }).id,
      });
      return reply.headers(noStore).header('ETag', `"${data.revision}"`).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.patch(
    `${API_PREFIX}/recognitions/:id/selection`,
    { preHandler: guards.requireUser, schema: { params: idParams, body: selectionBody } },
    async (request, reply) => {
      const data = await service.selectSpecies({
        userId: actorId(request),
        recognitionId: (request.params as { id: string }).id,
        body: request.body,
        ifMatch: request.headers['if-match'],
        idempotencyKey: request.headers['idempotency-key'],
      });
      return reply.headers(noStore).header('ETag', `"${data.revision}"`).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.delete(
    `${API_PREFIX}/recognitions/:id`,
    { preHandler: guards.requireUser, schema: { params: idParams } },
    async (request, reply) => {
      const data = await service.deleteRecognition({
        userId: actorId(request),
        recognitionId: (request.params as { id: string }).id,
        ifMatch: request.headers['if-match'],
        idempotencyKey: request.headers['idempotency-key'],
      });
      return reply.status(202).headers(noStore).send({ data, meta: buildMeta(request, config) });
    },
  );

  // ---------------------------------------------------------------- 任务
  // GET /jobs/{id} 是契约里唯一能读到 JobState 的接口，识别页按它分七类呈现。

  app.get(
    `${API_PREFIX}/jobs/:id`,
    { preHandler: guards.requireUser, schema: { params: idParams } },
    async (request, reply) => {
      const data = await service.getJob({
        userId: actorId(request),
        jobId: (request.params as { id: string }).id,
      });
      return reply.headers(noStore).header('ETag', `"${data.revision}"`).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.post(
    `${API_PREFIX}/jobs/:id/cancel`,
    { preHandler: guards.requireUser, schema: { params: idParams } },
    async (request, reply) => {
      const data = await service.cancelJob({
        userId: actorId(request),
        jobId: (request.params as { id: string }).id,
        ifMatch: request.headers['if-match'],
        idempotencyKey: request.headers['idempotency-key'],
      });
      return reply.headers(noStore).header('ETag', `"${data.revision}"`).send({ data, meta: buildMeta(request, config) });
    },
  );
}
