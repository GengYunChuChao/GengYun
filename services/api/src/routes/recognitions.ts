/**
 * GY-I09 识别路由（契约 operationId 一一对应，不新增字段）：
 *   POST   /recognitions                 createRecognition → 202 JobEnvelope
 *   GET    /recognitions/{id}            getRecognition    → RecognitionEnvelope
 *   PATCH  /recognitions/{id}/selection  selectSpecies     → RecognitionEnvelope
 *   DELETE /recognitions/{id}            deleteRecognition → 202 AckEnvelope
 *
 * **不再注册** `GET /jobs/{id}` 与 `POST /jobs/{id}/cancel`：这两个路径已收敛到共享作业面
 * （`services/api/src/jobs/routes.ts`，单一注册点；识别域改为以作业源形式接入）。
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
import type { ConsentGate } from '../privacy/egress.ts';
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

/**
 * 注册识别路由。
 *
 * `deps.consent`（GY-I27 接线单）：**可选**授权中间件端口。注入后挂在**会外发/会写入
 * 派生内容的入口**（`POST /recognitions` 与 `PATCH /recognitions/{id}/selection`），
 * 资料类型 `weed_recognition` ⇒ 需要 `media_processing` + `external_inference`。
 * **读取（GET）与删除（DELETE）不挂**：撤回用途后用户仍必须能取回并删除自己的数据。
 * 未注入 ⇒ 行为与接线前逐字相同（`real` 模式仍由提供者 fail-closed 拦截）。
 */
export function registerRecognitionRoutes(
  app: FastifyInstance,
  config: AppConfig,
  guards: AuthGuards,
  service: RecognitionService,
  deps: { consent?: ConsentGate } = {},
): void {
  const consentGate =
    deps.consent === undefined
      ? null
      : deps.consent({ purpose: 'external_inference', dataType: 'weed_recognition' });
  app.post(
    `${API_PREFIX}/recognitions`,
    {
      preHandler: consentGate === null ? guards.requireUser : [guards.requireUser, consentGate],
      schema: { body: mediaJobBody },
    },
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
    {
      preHandler: consentGate === null ? guards.requireUser : [guards.requireUser, consentGate],
      schema: { params: idParams, body: selectionBody },
    },
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
  // `/jobs/{id}` 与 `/jobs/{id}/cancel` **已收敛到共享作业面** `services/api/src/jobs/routes.ts`
  // （GY-I01 跨 kind 作业读面/取消面，单一注册点）。识别域只提供作业源
  // （`createRecognitionJobSource(service)`，在 app.ts 装配时注册），因此这里**不再注册**这两个路径；
  // 把识别域服务直接喂给共享面，行为与迁移前一致（既有集成回归仍全绿）。
}
