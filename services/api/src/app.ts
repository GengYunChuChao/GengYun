/**
 * Fastify 应用装配。
 *
 * 已装配：/health（运营）、游客主页科普预览（/api/v1/public/home）、
 * /api/v1 下的认证与后台认证、授权列表／授予及受限撤回路由、契约错误封套、404、
 * 个人档案与资料查询，以及 GY-I09 的识别任务闭路（/recognitions/**、/jobs/{id}[/cancel]）。
 * 其余业务路由（问答、社区、媒体等）尚未实现；未实现路径返回契约 NOT_FOUND，
 * 不伪造成功。
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { CONTRACT_VERSION } from './contract.ts';
import type { AppConfig } from './config.ts';
import { ApiError, buildErrorEnvelope } from './errors.ts';
import type { PgPool } from './db/pool.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerPublicHomeRoute } from './routes/public-home.ts';
import { registerUserAuthRoutes } from './routes/auth.ts';
import { registerAdminAuthRoutes } from './routes/admin-auth.ts';
import { registerConsentRoutes } from './routes/consents.ts';
import { registerProfileRoutes } from './routes/profile.ts';
import { registerKnowledgeRoutes } from './routes/knowledge.ts';
import { registerRecognitionRoutes } from './routes/recognitions.ts';
import { registerSpeechRoutes } from './routes/speech.ts';
import { createJobRegistry } from './jobs/registry.ts';
import { createRecognitionJobSource, createTranscriptionJobSource } from './jobs/sources.ts';
import { registerJobRoutes } from './jobs/routes.ts';
import type { SpeechStore } from './speech/store.ts';
import type { SpeechProvider } from './speech/provider.ts';
import type { SpeechMediaPort } from './speech/media.ts';
import { createMemoryAuthStore, createPostgresAuthStore, type AuthStore, type SqlExecutor } from './auth/store.ts';
import { createMemoryIdempotencyStore, createPostgresIdempotencyStore, type IdempotencyStore } from './auth/idempotency.ts';
import { STUB_LOOKUP_KEY, createWechatIdentityProvider, type WechatIdentityProvider } from './auth/wechat.ts';
import { AuthService, STUB_IDEMPOTENCY_HMAC_KEY } from './auth/service.ts';
import { createAuthGuards } from './auth/middleware.ts';
import { createRecognitionService, type RecognitionService } from './recognitions/service.ts';
import { createRecognitionProvider, type RecognitionProvider } from './recognitions/provider.ts';
import { createRecognitionMediaPort, type RecognitionMediaPort } from './recognitions/media.ts';
import { createMemoryRecognitionStore, type RecognitionStore } from './recognitions/store.ts';
import { registerSynthesisRoutes } from './routes/synthesis.ts';
import { createCheckedContentPort, type CheckedContentPort } from './tts/content.ts';
import { createSynthesisMediaPort, type SynthesisMediaPort } from './tts/media.ts';
import { createTtsProvider, type TtsProvider } from './tts/provider.ts';
import { createSynthesisService, type SynthesisService } from './tts/service.ts';
import { createMemorySynthesisStore, type SynthesisStore } from './tts/store.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /** 认证服务（供 server.ts 做管理员初始化与测试注入）。 */
    authService: AuthService;
    /** GY-I09 识别服务（供回归测试驱动在途任务与状态判定）。 */
    recognitionService: RecognitionService;
    /** GY-I13 合成服务（供回归测试核对默认关闭、幂等收敛与任务终态）。 */
    synthesisService: SynthesisService;
  }
}

export interface BuildAppOptions {
  /** Test injection only; server.ts never enables synthetic policy publication. */
  consentGrantTestOptions?: { allowSyntheticGrantPolicy?: boolean };
  config: AppConfig;
  pool?: PgPool | null;
  /** 可注入时钟，便于确定性回归。 */
  now?: () => Date;
  /** 测试注入：替换会话存储（默认按 pool 选择内存/持久化实现）。 */
  store?: AuthStore;
  /** 测试注入：替换幂等台账。 */
  idempotency?: IdempotencyStore;
  /** 测试注入：替换微信身份提供者（默认按 executionMode 选择 real/stub）。 */
  wechat?: WechatIdentityProvider;
  /** 测试注入：替换识别存储（默认进程内内存 store；本片无持久化实现）。 */
  recognitionStore?: RecognitionStore;
  /** 测试注入：替换识别提供者（默认按 executionMode 选择 real/替身）。 */
  recognitionProvider?: RecognitionProvider;
  /** 测试注入：替换媒体引用端口（默认 real=未接线 fail-closed，其余=明确标注的替身）。 */
  recognitionMedia?: RecognitionMediaPort;
  /** 任务截止时间（毫秒），测试可缩短以真实观测 timed_out。 */
  recognitionJobDeadlineMs?: number;
  // GY-I11 转写域注入项（形状与上面识别域的同名项一致）。**全部可选**：
  // 不传时与注入前**逐字节同行为**——存储用内存实现、提供者与媒体端口按 executionMode 自建、
  // 截止时间取服务层默认；即默认装配路径仍成立「零端口注入」。
  /** 测试注入：替换转写存储（默认进程内内存 store；本片无持久化实现）。 */
  speechStore?: SpeechStore;
  /** 测试注入：替换 ASR 提供者（默认按 executionMode 选择 real/替身）。 */
  speechProvider?: SpeechProvider;
  /** 测试注入：替换媒体引用端口（默认 real=未接线 fail-closed，其余=明确标注的替身）。 */
  speechMedia?: SpeechMediaPort;
  /** 转写任务截止时间（毫秒），测试可缩短以真实观测 timed_out。 */
  speechJobDeadlineMs?: number;
  /** 测试注入：替换合成存储（默认进程内内存 store；本片无持久化实现）。 */
  synthesisStore?: SynthesisStore;
  /** 测试注入：替换合成提供者（默认按 executionMode 选择 real/替身）。 */
  synthesisProvider?: TtsProvider;
  /** 测试注入：替换合成产物存储端口（默认 real=未接线 fail-closed，其余=明确标注的替身）。 */
  synthesisMedia?: SynthesisMediaPort;
  /** 测试注入：替换「已核对内容」读取端口（默认按 executionMode；stub 下为空替身源）。 */
  synthesisContent?: CheckedContentPort;
  /** 合成任务截止时间（毫秒），测试可缩短以真实观测 timed_out。 */
  synthesisJobDeadlineMs?: number;
}

/** 把 pg 连接池适配为认证层的 SqlExecutor（只暴露 query）。 */
function createSqlExecutor(pool: PgPool): SqlExecutor {
  const run = pool.query.bind(pool) as unknown as (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
  return {
    query: async (text: string, values?: unknown[]) => {
      const result = await run(text, values);
      return { rows: result.rows };
    },
  };
}

/** 构建已装配的 Fastify 实例（未监听端口，便于测试用 app.inject）。 */
export function buildApp({ config, pool = null, now, store, idempotency, wechat, consentGrantTestOptions, recognitionStore, recognitionProvider, recognitionMedia, recognitionJobDeadlineMs, speechStore, speechProvider, speechMedia, speechJobDeadlineMs, synthesisStore, synthesisProvider, synthesisMedia, synthesisContent, synthesisJobDeadlineMs }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    genReqId: () => randomUUID(),
    // 契约 WechatLoginInput / AdminLoginInput 为 additionalProperties:false；
    // Fastify 默认 removeAdditional:true 会静默剔除多余字段，这里改为拒绝，
    // 以确保「客户端不可指定 openid / 角色 / 用户 id」在 API 层被显式拦下（400）。
    ajv: { customOptions: { removeAdditional: false } },
  });

  const clock = now ?? (() => new Date());
  const sql = store === undefined && pool !== null ? createSqlExecutor(pool) : null;
  const authStore = store ?? (sql === null ? createMemoryAuthStore() : createPostgresAuthStore(sql));
  const idempotencyStore = idempotency ?? (sql === null ? createMemoryIdempotencyStore() : createPostgresIdempotencyStore(sql));
  const wechatProvider =
    wechat ??
    createWechatIdentityProvider({
      executionMode: config.executionMode,
      appId: config.wechatAppId,
      appSecret: config.wechatAppSecret,
      // 真实模式用 SESSION_SIGNING_KEY 作为 HMAC 密钥；替身/演示用固定桩密钥。
      lookupKey: config.sessionSigningKey ?? STUB_LOOKUP_KEY,
    });

  const service = new AuthService({
    store: authStore,
    wechat: wechatProvider,
    idempotency: idempotencyStore,
    executionMode: config.executionMode,
    now: clock,
    bootstrap: config.adminBootstrap,
    // 幂等请求摘要用带服务端密钥的 HMAC：real 模式取 SESSION_SIGNING_KEY（不入库），
    // 替身/演示用固定桩密钥。
    idempotencyHmacKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
  });
  const guards = createAuthGuards({ store: authStore, now: clock });

  // GY-I09 识别任务闭环：real 走 fail-closed 提供者（缺凭据 503，绝不回退替身），
  // stub/preset_demo 用明确标注的替身；媒体引用端口同理（real 未接线 → OBJECT_UNAVAILABLE）。
  const recognitionProviderResolved =
    recognitionProvider ??
    createRecognitionProvider({
      executionMode: config.executionMode,
      endpoint: process.env['RECOGNITION_PROVIDER_URL'] ?? null,
      apiKey: process.env['RECOGNITION_PROVIDER_KEY'] ?? null,
    });
  const recognitionService = createRecognitionService({
    store: recognitionStore ?? createMemoryRecognitionStore(),
    provider: recognitionProviderResolved,
    media: recognitionMedia ?? createRecognitionMediaPort(config.executionMode),
    idempotencyHmacKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
    now: clock,
    ...(recognitionJobDeadlineMs === undefined ? {} : { jobDeadlineMs: recognitionJobDeadlineMs }),
  });

  // GY-I13 合成域：real 走 fail-closed 提供者（缺凭据受理前 503，绝不回退替身）；产物存储与
  // 「已核对内容」读取端口同样按执行模式解析（real 未接线 ⇒ 受理前拒绝）。
  // **应用装配路径永不注入真实适配器端口**：真实发送只能经 `createLiveTtsProvider(ports)` 触达，
  // 而本文件不 import 它（零端口注入）。
  const synthesisService = createSynthesisService({
    store: synthesisStore ?? createMemorySynthesisStore(),
    provider: synthesisProvider ?? createTtsProvider({ executionMode: config.executionMode }),
    media: synthesisMedia ?? createSynthesisMediaPort(config.executionMode),
    content: synthesisContent ?? createCheckedContentPort(config.executionMode),
    idempotencyHmacKey: config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
    now: clock,
    ...(synthesisJobDeadlineMs === undefined ? {} : { jobDeadlineMs: synthesisJobDeadlineMs }),
  });

  // 请求身份槽位（GY-I27 接口缝：req.userId / req.authEpoch / req.role）。
  app.decorateRequest('userId', null);
  app.decorateRequest('authEpoch', null);
  app.decorateRequest('role', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('sessionExpiresAt', null);
  app.decorateRequest('accountRevision', null);
  app.decorateRequest('authScopes', null);
  app.decorate('authService', service);
  app.decorate('recognitionService', recognitionService);
  app.decorate('synthesisService', synthesisService);

  registerHealthRoutes(app, config, pool);
  registerPublicHomeRoute(app, config, pool);
  registerUserAuthRoutes(app, config, { service, guards, now: clock });
  registerAdminAuthRoutes(app, config, { service, guards, now: clock });
  registerConsentRoutes(app, config, pool, guards, consentGrantTestOptions);
  registerProfileRoutes(app, config, pool, guards);
  registerKnowledgeRoutes(app, config, pool, guards);
  registerRecognitionRoutes(app, config, guards, recognitionService);
  registerSpeechRoutes(app, config, { guards, store: speechStore, provider: speechProvider, media: speechMedia, jobDeadlineMs: speechJobDeadlineMs });
  registerSynthesisRoutes(app, config, guards, synthesisService);
  // GY-I01 跨 kind 作业读面/取消面：`/jobs/{id}` 与 `/jobs/{id}/cancel` 的**唯一注册点**。
  // 各域以作业源形式接入（本片：识别域 + 转写域）；未接线的 kind ⇒ 与「作业不存在」同形 404。
  // 必须在 registerSpeechRoutes 之后：转写服务由该插件装配并装饰为 app.speechService。
  registerJobRoutes(app, config, guards, createJobRegistry([
    createRecognitionJobSource(recognitionService),
    createTranscriptionJobSource(app.speechService),
  ]));

  app.setNotFoundHandler((request, reply) => {
    const error = new ApiError('NOT_FOUND', `未实现的路径：${request.method} ${request.url}`);
    reply
      .status(error.status)
      .send(buildErrorEnvelope(error, { request_id: request.id, execution_mode: config.executionMode }));
  });

  app.setErrorHandler((error, request, reply) => {
    const envelope = (apiError: ApiError) =>
      buildErrorEnvelope(apiError, { request_id: request.id, execution_mode: config.executionMode });

    if (error instanceof ApiError) {
      reply.status(error.status).send(envelope(error));
      return;
    }

    const statusCode = (error as { statusCode?: number }).statusCode;
    const errorCode = (error as { code?: string }).code;

    // Fastify 内容类型解析错误（非法 JSON / 内容类型 / 请求体过大）：
    // 这些是客户端请求错误，映射到契约错误码，而不是 500 缺口。
    if (typeof errorCode === 'string' && errorCode.startsWith('FST_ERR_CTP_')) {
      if (statusCode === 413) {
        reply.status(413).send(envelope(new ApiError('MEDIA_TOO_LARGE', '请求体超过大小限制')));
        return;
      }
      if (statusCode === 415) {
        reply.status(415).send(envelope(new ApiError('MEDIA_TYPE_UNSUPPORTED', '不支持的媒体类型')));
        return;
      }
      // 400：非法 JSON 请求体、空请求体、非法 Content-Length 等。
      reply.status(400).send(envelope(new ApiError('INVALID_REQUEST', '请求体格式错误')));
      return;
    }

    // Fastify schema 校验失败映射为契约 INVALID_REQUEST，保留字段明细。
    const validation = (error as { validation?: Array<{ instancePath?: string; message?: string }> }).validation;
    if (Array.isArray(validation) && validation.length > 0) {
      const apiError = new ApiError('INVALID_REQUEST', '请求校验失败', {
        details: validation.slice(0, 30).map((item) => ({
          field: (item.instancePath && item.instancePath !== '' ? item.instancePath : '/').slice(0, 80),
          code: (item.message ?? 'invalid').slice(0, 80),
        })),
      });
      reply.status(apiError.status).send(envelope(apiError));
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    // 契约 error_status_map 未定义 500 / INTERNAL_ERROR（见 docs/engineering-shell.md“契约缺口”）。
    // 不伪造契约错误码：如实返回 500，并显式标记该缺口，供监工与指挥核对。
    reply.status(500).send({
      error: {
        message: '服务器内部错误',
        retryable: false,
        details: [],
      },
      meta: {
        request_id: request.id,
        contract_version: CONTRACT_VERSION,
        execution_mode: config.executionMode,
      },
      contract_gap: 'NO_CONTRACT_CODE_FOR_500',
    });
  });

  return app;
}
