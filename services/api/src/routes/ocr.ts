/**
 * GY-I10 标签 OCR 路由（契约 operationId 一一对应，不新增字段）。
 *
 *   POST   /ocr                    createOCR  → 202 JobEnvelope
 *   GET    /ocr/{id}               getOCR     → 200 OCREnvelope
 *   DELETE /ocr/{id}               deleteOCR  → 202 AckEnvelope
 *   PATCH  /ocr/{id}/correction    correctOCR → 200 OCREnvelope
 *   POST   /ocr/{id}/verify        verifyOCR  → 200 VerificationEnvelope
 *
 * 契约事实（`packages/contracts/openapi.json` 原文，本片逐一核对过）：
 * - `createOCR` 只要求 `Idempotency-Key`（`x-version-required: false`）；
 * - `deleteOCR` / `correctOCR` / `verifyOCR` 要求 `Idempotency-Key` **且** `If-Match`
 *   （`x-version-required: true`）；`IfMatch` 描述为「缺失428，不匹配409」；
 * - `Ack` 为 `{ accepted: boolean }`（`additionalProperties:false`）。
 *
 * 本模块**只新增文件**：不注册到 `services/api/src/app.ts`（属阶段 2b），
 * 也不改动任何既有路由文件。HTTP 管道（`meta` / 错误封套 / `Cache-Control` / `ETag` /
 * `guards.requireUser`）全部沿用既有实现（`routes/support.ts`、`auth/middleware.ts`、`app.ts`
 * 的 `setErrorHandler`），未另造一套。
 *
 * 头部的 `Idempotency-Key` / `If-Match` **不放进 Fastify schema**：这两个头的契约错误码
 * （`IDEMPOTENCY_KEY_REQUIRED` / `REVISION_REQUIRED` / `INVALID_REQUEST` / `REVISION_CONFLICT`）
 * 由服务层统一判定（与 `routes/profile.ts`、`routes/consents.ts` 的既有做法一致），
 * 避免 schema 校验把"键太短"这类情形改写成通用校验错误。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthGuards } from '../auth/middleware.ts';
import { currentIdentity, readIdentity } from '../auth/middleware.ts';
import { STUB_IDEMPOTENCY_HMAC_KEY } from '../auth/service.ts';
import type { AppConfig } from '../config.ts';
import { API_PREFIX } from '../contract.ts';
import { createOcrService, type OcrService, type OcrTerminalHistoryPort } from '../ocr/service.ts';
import { createMemoryOcrStore, type OcrStore } from '../ocr/store.ts';
import { createOcrProvider, type OcrProvider } from '../ocr/provider.ts';
import { createOcrMediaPort, type OcrMediaPort } from '../ocr/media.ts';
import {
  createOcrDosePort,
  createOcrReferencePort,
  type OcrDosePort,
  type OcrReferencePort,
} from '../ocr/reference.ts';
import type { ConsentGate } from '../privacy/egress.ts';
import { withPrivacyErrors } from '../privacy/egress.ts';
import type { MediaJobEgress } from '../privacy/task-egress.ts';
import { buildMeta } from './support.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * GY-I10 标签 OCR 服务实例（供装配方与回归测试驱动在途任务：
     * `settle()`、`describe().providerCalls` 真实调用计数）。**不含凭据**。
     */
    ocrService: OcrService;
  }
}

/**
 * 路由依赖注入面（**产品装配 `app.ts` 只传 `{ guards }`，不传任何端口**）。
 *
 * 「产品装配不暴露任何 provider / store / 端口注入」本身是**默认关闭**的结构属性：
 * 真实适配器只能由 `createOcrProvider` / `createOcrReferencePort` 依 `config.executionMode` 选择，
 * 装配方无法在装配点塞入一个未审的真实客户端，也无法绕过 fail-closed 换成替身。
 * 其余字段仅供**回归测试**构造隔离场景（如"真实登记库未接线"这一分支）。
 */
export interface OcrRouteDeps {
  /** 用户端鉴权守卫（`createAuthGuards` 产物），由装配方提供。 */
  guards: AuthGuards;
  /** 已组装的服务；缺省由本层按 `config.executionMode` 组装（便于 `app.ts` 一行接入）。 */
  service?: OcrService;
  provider?: OcrProvider;
  store?: OcrStore;
  media?: OcrMediaPort;
  reference?: OcrReferencePort;
  dose?: OcrDosePort;
  /** 幂等请求摘要密钥；缺省取 `config.sessionSigningKey`，再缺省为替身桩密钥。 */
  idempotencyHmacKey?: string;
  /**
   * GY-I16（#16）跨线接线：**可选**终态写入服务端识别历史的端口（缺省 = 未接线 fail-closed）。
   *
   * 它是**装配层**（`app.ts`）提供的端口，不是「绕过 fail-closed 的后门」：与本文件其余注入项
   * 一样，产品装配只把历史域的内部创建口交给它；`real` 模式下历史域整域关闭 ⇒ 装配层传
   * `undefined` ⇒ 服务层落到未接线端口（任务照常执行，不产生历史行，**不**伪造成功）。
   */
  history?: OcrTerminalHistoryPort;
  now?: () => Date;
  idFactory?: () => string;
  /** 任务截止时间（毫秒）；生产走服务层默认 30s，仅供装配/回环测试收紧。 */
  jobDeadlineMs?: number;
  /**
   * GY-I27 接线单：**可选**授权中间件端口。注入后挂在**会外发/会写入派生内容的入口**
   * （`POST /ocr`、`PATCH /ocr/{id}/correction`、`POST /ocr/{id}/verify`），资料类型 `label_ocr`
   * ⇒ 需要 `media_processing` + `external_inference`。
   * **读取（GET）与删除（DELETE）不挂**。未注入 ⇒ 行为与接线前逐字相同。
   */
  consent?: ConsentGate;
  /**
   * GY-I27 第二片：**可选**持久外发账本端口（`real` 才接管派发；未注入或非 real ⇒ 不记账）。
   */
  egress?: MediaJobEgress;
}

const noStore = { 'Cache-Control': 'no-store' } as const;

/** 路径参数 `id`：契约 `type: string, format: uuid`。 */
const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

/** 契约 `Ingredient`。 */
const ingredientSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'content_text', 'unit_text'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    content_text: { type: 'string', minLength: 1, maxLength: 80 },
    unit_text: { type: 'string', minLength: 1, maxLength: 80 },
  },
} as const;

/** 契约 `LabelFields`（四字段全必填；可空文本用 anyOf 表达）。 */
const nullableLabelText = { anyOf: [{ type: 'string', minLength: 1, maxLength: 80 }, { type: 'null' }] } as const;

const labelFieldsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['registration_number', 'name', 'ingredients', 'dosage_form'],
  properties: {
    registration_number: nullableLabelText,
    name: nullableLabelText,
    ingredients: { type: 'array', maxItems: 20, items: ingredientSchema },
    dosage_form: nullableLabelText,
  },
} as const;

/** 契约 `Conditions`（`crop_id` / `region_code` 必填，其余可选）。 */
const conditionsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['crop_id', 'region_code'],
  properties: {
    crop_id: { type: 'string', minLength: 1, maxLength: 80 },
    region_code: { type: 'string', pattern: '^33[0-9]{4}$' },
    species_id: { type: 'string', minLength: 1, maxLength: 80 },
    growth_stage: { type: 'string', minLength: 1, maxLength: 80 },
    planting_method: { type: 'string', minLength: 1, maxLength: 80 },
    use_scene: { type: 'string', minLength: 1, maxLength: 80 },
  },
} as const;

/** 契约 `MediaJobInput`（`additionalProperties:false`：多余字段 400）。 */
const mediaJobBody = {
  type: 'object',
  additionalProperties: false,
  required: ['media_id', 'media_revision'],
  properties: {
    media_id: { type: 'string', format: 'uuid' },
    media_revision: { type: 'integer', minimum: 1 },
  },
} as const;

/** 契约 `OCRCorrectionInput`。 */
const correctionBody = {
  type: 'object',
  additionalProperties: false,
  required: ['corrected_fields'],
  properties: { corrected_fields: labelFieldsSchema },
} as const;

/** 契约 `VerifyInput`（`fields` 必填，`conditions` 可选）。 */
const verifyBody = {
  type: 'object',
  additionalProperties: false,
  required: ['fields'],
  properties: { fields: labelFieldsSchema, conditions: conditionsSchema },
} as const;

/** 归属者：只认服务端解析出的身份（客户端无法声明）。 */
function actorId(request: FastifyRequest): string {
  return readIdentity(request).userId;
}

/**
 * 注册标签 OCR 路由（契约 5 个 operationId）。
 *
 * 服务缺省由本层按 `config.executionMode` 组装 ⇒ **产品装配 `app.ts` 只需一行调用**：
 * `registerOcrRoutes(app, config, { guards });`（零端口注入，见 `OcrRouteDeps` 注释）。
 * 返回组装好的服务，便于装配方/测试注入或驱动（并已 `decorate` 到 `app.ocrService`）。
 */
export function registerOcrRoutes(app: FastifyInstance, config: AppConfig, deps: OcrRouteDeps, persistencePool: TransactionalPool | null = null): OcrService {
  const guards = deps.guards;
  const provider = deps.provider ?? createOcrProvider({ executionMode: config.executionMode, aiProviders: config.aiProviders?.ocr ?? null });
  const store = deps.store ?? (persistencePool === null ? createMemoryOcrStore() : createPostgresOcrStore({ pool: persistencePool }));
  const media = deps.media ?? createOcrMediaPort(config.executionMode);
  const reference = deps.reference ?? createOcrReferencePort(config.executionMode);
  const dose = deps.dose ?? createOcrDosePort(config.executionMode);
  // GY-I27 第二片：`real` 模式下由持久外发账本接管派发；替身/演示不记账。
  const guardedProvider = deps.egress === undefined ? provider : deps.egress.provider(provider, 'recognize');
  const service =
    deps.service ??
    createOcrService({
      store,
      provider: guardedProvider,
      media,
      reference,
      dose,
      idempotencyHmacKey: deps.idempotencyHmacKey ?? config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
      ...(deps.history === undefined ? {} : { history: deps.history }),
      now: deps.now,
      idFactory: deps.idFactory,
      jobDeadlineMs: deps.jobDeadlineMs,
    });
  app.decorate('ocrService', service);
  // GY-I27 接线单：授权中间件（可选注入；缺省 ⇒ 与接线前逐字相同）。
  const consentGate =
    deps.consent === undefined ? null : deps.consent({ purpose: 'external_inference', dataType: 'label_ocr' });
  const gated = (schema: Record<string, unknown>) => ({
    preHandler: consentGate === null ? deps.guards.requireUser : [deps.guards.requireUser, consentGate],
    schema,
  });
  app.post(
    `${API_PREFIX}/ocr`,
    gated({ body: mediaJobBody }),
    withPrivacyErrors(async (request, reply) => {
      const reservation =
        deps.egress === undefined
          ? null
          : await deps.egress.reserveForAcceptance({
              userId: actorId(request),
              authEpoch: currentIdentity(request).authEpoch,
              objectId: (request.body as { media_id: string }).media_id,
              objectRevision: (request.body as { media_revision: number }).media_revision,
            });
      let created;
      try {
        created = await service.createOcr({
          userId: actorId(request),
          body: request.body,
          idempotencyKey: request.headers['idempotency-key'],
        });
      } catch (error) {
        if (reservation !== null && deps.egress !== undefined) {
          await deps.egress.abandonReservation({ exportId: reservation.exportId });
        }
        throw error;
      }
      const { job } = created;
      return reply
        .status(202)
        .headers(noStore)
        .header('ETag', `"${job.revision}"`)
        .send({ data: job, meta: buildMeta(request, config) });
    }),
  );

  app.get(
    `${API_PREFIX}/ocr/:id`,
    { preHandler: guards.requireUser, schema: { params: idParams } },
    async (request, reply) => {
      const data = await service.getOcr({
        userId: actorId(request),
        ocrId: (request.params as { id: string }).id,
      });
      return reply
        .headers(noStore)
        .header('ETag', `"${data.revision}"`)
        .send({ data, meta: buildMeta(request, config) });
    },
  );

  app.patch(
    `${API_PREFIX}/ocr/:id/correction`,
    gated({ params: idParams, body: correctionBody }),
    async (request, reply) => {
      const data = await service.correctOcr({
        userId: actorId(request),
        ocrId: (request.params as { id: string }).id,
        body: request.body,
        ifMatch: request.headers['if-match'],
        idempotencyKey: request.headers['idempotency-key'],
      });
      return reply
        .headers(noStore)
        .header('ETag', `"${data.revision}"`)
        .send({ data, meta: buildMeta(request, config) });
    },
  );

  app.post(
    `${API_PREFIX}/ocr/:id/verify`,
    gated({ params: idParams, body: verifyBody }),
    async (request, reply) => {
      const { verification, revision } = await service.verifyOcrWithRevision({
        userId: actorId(request),
        ocrId: (request.params as { id: string }).id,
        body: request.body,
        ifMatch: request.headers['if-match'],
        idempotencyKey: request.headers['idempotency-key'],
      });
      return reply
        .headers(noStore)
        .header('ETag', `"${revision}"`)
        .send({ data: verification, meta: buildMeta(request, config) });
    },
  );

  app.delete(
    `${API_PREFIX}/ocr/:id`,
    { preHandler: guards.requireUser, schema: { params: idParams } },
    async (request, reply) => {
      const { accepted, revision } = await service.deleteOcrWithRevision({
        userId: actorId(request),
        ocrId: (request.params as { id: string }).id,
        ifMatch: request.headers['if-match'],
        idempotencyKey: request.headers['idempotency-key'],
      });
      // 只下发契约 `Ack` 的字段（`accepted`）；内部 revision 只用于 ETag，不进响应体，
      // 否则会违反 `Ack` 的 `additionalProperties: false`。
      return reply
        .status(202)
        .headers(noStore)
        .header('ETag', `"${revision}"`)
        .send({ data: { accepted }, meta: buildMeta(request, config) });
    },
  );

  return service;
}

// ============================================================================
// GY-R27 S10（#10）· 第 4 个实参 `persistencePool`，以及「为什么这段说明与 import 写在文件末尾」
// ============================================================================
// 1) 选择规则（**判定在装配层** `app.ts`，**构造在域内**即本文件）：
//    `app.ts` 只在 `real` 时把它本来就持有的**那一个** `PgPool` 传进来
//    （`const ocrPersistencePool = config.executionMode === 'real' ? pool : null;`），本层按
//    `deps.store ?? (persistencePool === null ? 内存 : PG)` 选实现：
//      · `real` + 有池 ⇒ `createPostgresOcrStore`（`persistent: true`；迁移 `0024_ocr_persistence.sql`）；
//      · `real` + 无池 ⇒ 内存 store（`persistent: false`，**如实**标注不持久，⛔ 绝不冒充持久化）；
//      · `stub` / `preset_demo`（无论有没有池）⇒ 内存 store（行为与接线前逐字一致）。
//    `persistencePool` **不是**适配器注入面：装配点无法借它塞进 store / provider / reference，
//    它只提供连接能力，换不换实现由域内判定 ⇒ `deps.store` 仍是**唯一**可供回归测试替换存储的口子。
//
// 2) 为什么 import 与说明放在**文件末尾**（不是风格偏好，是被既有门禁钉住的）：
//    `docs/architecture/contract-status.json` 把本文件 5 个路由注册块的行号范围
//    （`224-257` / `259-272` / `274-290` / `292-308` / `310-328`）当作证据钉住，而该 JSON 在本片是**禁改项**。
//    只要在注册块之前插入任何一行，契约实现状态的语义校验就会判红（实测原文：
//    `getOCR: services/api/src/routes/ocr.ts:259-272 区间落在 post /ocr 的注册块内…`）。
//    ESM 的 `import` 声明是提升的（hoisted），放在文件末尾与放在顶部**语义等价** —— 用它换"注册块行号不变"：
//    本文件的接线因此**逐行等长**（`git diff` 只有 2 行改动），`contract-status.json` 无需修改。
import { createPostgresOcrStore, type TransactionalPool } from '../ocr/store-pg.ts';
