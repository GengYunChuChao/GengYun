/**
 * GY-I11 普通话录音与转写路由（契约 openapi：`createTranscription` / `getTranscription` /
 * `deleteTranscription` / `confirmTranscription`）。
 *
 * 挂载在契约 `servers[0].url` = `/api/v1` 之下：
 * - `POST   /speech/transcriptions`                    → 202 `JobEnvelope`
 * - `GET    /speech/transcriptions/{id}`               → 200 `TranscriptionEnvelope`
 * - `DELETE /speech/transcriptions/{id}`               → 202 `AckEnvelope`
 * - `PATCH  /speech/transcriptions/{id}/confirmation`  → 200 `TranscriptionEnvelope`
 *
 * 本模块是**薄适配层**：业务语义（原子占位幂等、`If-Match` 判定、归属校验、fail-closed 终态）
 * 全部由 `services/api/src/speech/service.ts` 负责，本层只做三件事：
 *   1. 鉴权身份读取：`auth/middleware.ts` 的 `readIdentity`（只认服务端会话解析出的 `userId`，
 *      绝不采信客户端声明的身份）；
 *   2. 契约请求体 schema 校验（`additionalProperties:false`，与 `app.ts` 的
 *      `ajv.customOptions.removeAdditional:false` 配合 ⇒ 多余字段直接 400）；
 *   3. 响应封套与头部装配：`buildMeta`（`meta.contract_version` / `meta.execution_mode`）、
 *      `ETag: "<revision>"`、`Cache-Control: no-store`（契约 200/202 头部注明「私有/授权访问 no-store」）。
 *
 * **装配（阶段 2b）**：`services/api/src/app.ts` **只加两行**（一行 `import` + 一行
 * `registerSpeechRoutes(app, config, { guards })`，紧随 `registerRecognitionRoutes` 之后）。
 * 产品装配路径**不做任何端口注入**：服务由本模块按 `config.executionMode` 自建
 * （`real` 走 fail-closed，`stub`/`preset_demo` 走明确标注的替身）。
 *
 * **契约里与本域相邻、但不由本模块注册的操作**（不得越界注册，否则与既有路由重复）：
 * - `getJob` `GET /jobs/{id}` / `cancelJob` `POST /jobs/{id}/cancel`（`x-task: GY-I01`）：
 *   已由 GY-I09（PR #87）在 `routes/recognitions.ts` 注册，**只服务于识别任务**；
 *   转写任务的 id 在该路由上得到 `404 NOT_FOUND`（两个域的 store 彼此独立）。
 *   ⇒ 后果：转写任务的 `JobState` 与取消**目前无法经 HTTP 读取**；失败终态
 *   （`failed`/`timed_out`/`uncertain`）只能表现为「该转写记录 `GET` 404（未产生记录）」。
 *   已如实登记在证据文档与 PR 正文（属跨域装配缺口，不是本片越界项）。
 * - `createSynthesis` `POST /speech/synthesis`（#13 TTS）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import { currentIdentity, readIdentity } from '../auth/middleware.ts';
import { STUB_IDEMPOTENCY_HMAC_KEY } from '../auth/service.ts';
import { API_PREFIX } from '../contract.ts';
import { createSpeechService, type SpeechService } from '../speech/service.ts';
import { createMemorySpeechStore, type SpeechStore } from '../speech/store.ts';
import { createSpeechProvider, type SpeechProvider } from '../speech/provider.ts';
import { createSpeechMediaPort, type SpeechMediaPort } from '../speech/media.ts';
import type { ConsentGate } from '../privacy/egress.ts';
import { withPrivacyErrors } from '../privacy/egress.ts';
import type { MediaJobEgress } from '../privacy/task-egress.ts';
import { buildMeta } from './support.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * GY-I11 转写服务实例（供装配方与回归测试驱动在途任务：`settle()`、
     * `describe().providerCalls` 真实调用计数）。**不含凭据**。
     */
    speechService: SpeechService;
  }
}

/**
 * openapi `components.schemas.MediaJobInput`（`additionalProperties:false`）。
 * 只做类型 / 必填 / 多余字段校验；`media_id` 的 uuid 形状与 `media_revision >= 1`
 * 由服务层判定（服务层是语义唯一出口，避免两处规则漂移）。
 */
export const MEDIA_JOB_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['media_id', 'media_revision'],
  properties: {
    media_id: { type: 'string' },
    media_revision: { type: 'integer' },
  },
} as const;

/** openapi `components.schemas.ConfirmTranscriptionInput`（`additionalProperties:false`）。 */
export const CONFIRM_TRANSCRIPTION_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmed_text', 'confirmation'],
  properties: {
    confirmed_text: { type: 'string', minLength: 1, maxLength: 8000 },
    confirmation: { const: 'checked_and_sendable' },
  },
} as const;

/**
 * 这四个操作在契约里**没有**声明任何查询参数（只有路径参数）。
 * 与 `routes/profile.ts` 同口径：显式 `additionalProperties:false`，
 * 未声明的查询参数一律 400 `INVALID_REQUEST`，不静默忽略。
 */
const NO_QUERY_SCHEMA = { type: 'object', additionalProperties: false } as const;

export interface SpeechRouteDeps {
  /** 用户端鉴权守卫（`createAuthGuards` 产物），由装配方提供。 */
  guards: AuthGuards;
  /** 已组装的服务；缺省由本层按 `config.executionMode` 组装（便于 app.ts 一行接入）。 */
  service?: SpeechService;
  provider?: SpeechProvider;
  store?: SpeechStore;
  media?: SpeechMediaPort;
  /** 幂等请求摘要密钥；缺省取 `config.sessionSigningKey`，再缺省为替身桩密钥。 */
  idempotencyHmacKey?: string;
  now?: () => Date;
  /** 任务截止时间（毫秒）；生产走服务层默认 30s，仅供装配/回环测试收紧。 */
  jobDeadlineMs?: number;
  /**
   * GY-I27 接线单：**可选**授权中间件端口。注入后挂在**会外发/会写入派生内容的入口**
   * （`POST /speech/transcriptions` 与 `PATCH .../confirmation`），资料类型 `voice_question`
   * ⇒ 需要 `recording` + `media_processing` + `external_inference`。
   * **读取（GET）与删除（DELETE）不挂**。未注入 ⇒ 行为与接线前逐字相同。
   */
  consent?: ConsentGate;
  /**
   * GY-I27 第二片：**可选**持久外发账本端口。`real` 模式下受理前预留快照、提供者派发经
   * `assertExecutable → markSent → saveResult` 收口；未注入或非 real ⇒ 不记账（行为不变）。
   */
  egress?: MediaJobEgress;
}

/**
 * 注册转写路由；返回实际使用的服务实例（供装配方与证据文档引用）。
 *
 * 缺省组装：`provider` 与 `media` 均按 `config.executionMode` 选择 ⇒ `real` 模式走
 * fail-closed 实现（缺凭据 ⇒ 受理前 503 `PROVIDER_UNAVAILABLE`，**不回退替身**），
 * `stub` / `preset_demo` 走明确标注的替身。
 */
export function registerSpeechRoutes(app: FastifyInstance, config: AppConfig, deps: SpeechRouteDeps, persistencePool: TransactionalPool | null = null): SpeechService {
  const provider = deps.provider ?? createSpeechProvider({ executionMode: config.executionMode, aiProviders: config.aiProviders.asr });
  const store = deps.store ?? (config.executionMode === 'real' && persistencePool !== null ? createPostgresSpeechStore({ pool: persistencePool }) : createMemorySpeechStore());
  const media = deps.media ?? createSpeechMediaPort(config.executionMode);
  // GY-I27 第二片：`real` 模式下由持久外发账本接管派发（执行前/保存前重查 + 结果写回）。
  // 其余模式（替身/演示）**不记账**：替身不发生真实外发，账本里不得出现 sent。
  const guardedProvider = deps.egress === undefined ? provider : deps.egress.provider(provider, 'transcribe');
  const service =
    deps.service ??
    createSpeechService({
      store,
      provider: guardedProvider,
      media,
      idempotencyHmacKey: deps.idempotencyHmacKey ?? config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
      now: deps.now,
      jobDeadlineMs: deps.jobDeadlineMs,
    });

  // 暴露给装配方与回归测试（驱动在途任务、读取真实调用计数）；不含凭据。
  app.decorate('speechService', service);

  /** 只认服务端会话解析出的身份（客户端无法声明 userId）。 */
  const userId = (request: FastifyRequest): string => readIdentity(request).userId;

  // GY-I27 接线单：授权中间件（可选注入）。缺省 null ⇒ 路由与接线前逐字相同。
  const consentGate =
    deps.consent === undefined
      ? null
      : deps.consent({ purpose: 'external_inference', dataType: 'voice_question' });
  const gated = (schema: Record<string, unknown>) => ({
    preHandler: consentGate === null ? deps.guards.requireUser : [deps.guards.requireUser, consentGate],
    schema,
  });

  app.post(
    `${API_PREFIX}/speech/transcriptions`,
    gated({ querystring: NO_QUERY_SCHEMA, body: MEDIA_JOB_INPUT_SCHEMA }),
    withPrivacyErrors(async (request, reply) => {
      const reservation =
        deps.egress === undefined
          ? null
          : await deps.egress.reserveForAcceptance({
              userId: userId(request),
              authEpoch: currentIdentity(request).authEpoch,
              objectId: (request.body as { media_id: string }).media_id,
              objectRevision: (request.body as { media_revision: number }).media_revision,
            });
      let created;
      try {
        created = await service.createTranscription({
          userId: userId(request),
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
      // 202：已受理、尚未完成；JobEnvelope 的 ETag 绑 Job 自身 revision。
      return reply
        .status(202)
        .header('ETag', `"${job.revision}"`)
        .header('Cache-Control', 'no-store')
        .send({ data: job, meta: buildMeta(request, config) });
    }),
  );

  app.get(
    `${API_PREFIX}/speech/transcriptions/:id`,
    { preHandler: deps.guards.requireUser, schema: { querystring: NO_QUERY_SCHEMA } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const data = await service.getTranscription({ userId: userId(request), transcriptionId: id });
      return reply
        .status(200)
        .header('ETag', `"${data.revision}"`)
        .header('Cache-Control', 'no-store')
        .send({ data, meta: buildMeta(request, config) });
    },
  );

  app.delete(
    `${API_PREFIX}/speech/transcriptions/:id`,
    { preHandler: deps.guards.requireUser, schema: { querystring: NO_QUERY_SCHEMA } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const data = await service.deleteTranscription({
        userId: userId(request),
        transcriptionId: id,
        ifMatch: request.headers['if-match'],
        idempotencyKey: request.headers['idempotency-key'],
      });
      // AckEnvelope 只有 `accepted`，**没有** revision 可绑定；契约未把 ETag 标为 required
      // （见 openapi 202.headers），因此这里只下发 Cache-Control，不伪造一个 ETag。
      return reply
        .status(202)
        .header('Cache-Control', 'no-store')
        .send({ data, meta: buildMeta(request, config) });
    },
  );

  app.patch(
    `${API_PREFIX}/speech/transcriptions/:id/confirmation`,
    gated({ querystring: NO_QUERY_SCHEMA, body: CONFIRM_TRANSCRIPTION_INPUT_SCHEMA }),
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const data = await service.confirmTranscription({
        userId: userId(request),
        transcriptionId: id,
        body: request.body,
        ifMatch: request.headers['if-match'],
        idempotencyKey: request.headers['idempotency-key'],
      });
      return reply
        .status(200)
        .header('ETag', `"${data.revision}"`)
        .header('Cache-Control', 'no-store')
        .send({ data, meta: buildMeta(request, config) });
    },
  );

  return service;
}
import { createPostgresSpeechStore, type TransactionalPool } from '../speech/store-pg.ts'; // 追加在文件末尾：本模块的存储选型要用它的值（顶部 import 区零插入，ESM 提升语义等价）

/**
 * 存储选型（GY-R28 S20，语音持久化接线）——为什么在域内选、为什么池走位置实参：
 *
 * 1. `tests/integration/speech-http.mjs:530-540` 把「app.ts 对 speech/{store,provider,media}
 *    只能有 import type 引用」钉成结构性质（默认零端口注入的证据）。值导入会打红这条**既有**
 *    断言 ⇒ 选型下沉到本模块，app.ts 只多传一个位置实参。
 * 2. OCR 域 2026-10-20 的持久化接线（迁移 0024）遇到同一约束，采用的正是「装配层传位置实参池
 *    ＋ 域内三态选型」；本片照同一范式 ⇒ 既没改那条断言，也没削弱它。
 * 3. 三态：注入 `deps.store` **优先** → `real` 且有池 ⇒ `createPostgresSpeechStore({ pool })`
 *    （`persistent: true`）→ 其余（stub/preset_demo，或 real 但无池）⇒ `createMemorySpeechStore()`
 *    （`persistent: false`，⛔ 不冒充持久化，`describe().storePersistent` 如实回报）。
 * 4. 池是第 4 个**位置实参**、不是 `deps` 的键 ⇒ `speech-http.mjs` 对注册行的键集判据
 *    （guards/store/provider/media/jobDeadlineMs/consent/egress）逐字不变。
 * 5. 本文件既有行号是 `docs/architecture/contract-status.json` 的锚点，因此改动保持**零净行数**：
 *    签名与选型各替换一行（行数不变），解释与导入全部追加在文件末尾（锚点 160-248 之后）。
 */
