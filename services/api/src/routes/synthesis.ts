/**
 * GY-I13 普通话 TTS 合成 · HTTP 路由（阶段 2a：**只新增本文件，不注册到 app.ts**）。
 *
 * 契约（`packages/contracts/openapi.json` 原文）：
 *   POST /speech/synthesis   operationId `createSynthesis`   → 202 `JobEnvelope`
 *   requestBody: `SynthesisInput = { checked_content_ref: SynthesisTarget, locale: const "zh-CN" }`
 *                —— `additionalProperties:false`，两字段必填
 *   security: `userSession`；参数：`Idempotency-Key`（必填，8..128）
 *   202 响应头：`ETag`（资源 revision 强 ETag）、`Cache-Control`（私有/授权访问 no-store）
 *   `x-version-required: false` ⇒ 本端点**没有** `If-Match` 参数
 *
 * **读面缺口（如实登记，未自造端点）**：该域契约里**只有 POST**，没有 TTS 专属的读/删端点；
 * 读 JobState 的唯一接口是**平台级** `GET /jobs/{id}`（`getJob`，`JobResult.oneOf` 含
 * `SynthesisResult`），它属 GY-I01/#9 且**当前未装配**（`services/api/src/routes/` 下无 jobs 路由）。
 * 因此本轮经 HTTP **无法**读取任务终态——这属预期缺口，本文件**不新增** GET/DELETE。
 *
 * **默认关闭必须保持**：应用装配路径**永不注入**真实适配器端口。本文件只调用
 * `createTtsProvider({ executionMode })`；`executionMode:'real'` 时它返回 `createRealTtsProvider`
 * 的 fail-closed 实现（缺凭据 ⇒ `available=false` ⇒ **受理前** 503 `PROVIDER_UNAVAILABLE`），
 * 行为与接线前逐字节相同。本文件**不 import** `createLiveTtsProvider` / `live-ports.ts`，
 * 因此路由层**无法**给真实适配器传任何端口（零端口注入）。
 *
 * 复用共享管道（不另造）：`guards.requireUser`（鉴权）、`currentIdentity`（服务端权威身份）、
 * `buildMeta`（成功封套 `meta`）、`ApiError`（错误封套由 `app.ts` 的 errorHandler 统一渲染）、
 * `Cache-Control: no-store` 与 `ETag: "<revision>"`（与 profile/knowledge 同口径）。
 *
 * 业务语义全部在服务层（`services/api/src/tts/service.ts`，阶段 1 已合并，本文件**不改其语义**）：
 * 只播报经核对内容、未通过核对一律 fail-closed、修订绑定、不接受自由文本、幂等原子占位与并发收敛、
 * 提供者失败不得写成功。本文件只做：鉴权 → `Idempotency-Key` 形状 → 调服务 → 202 + JobEnvelope。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { PgPool } from '../db/pool.ts';
import { currentIdentity, type AuthGuards } from '../auth/middleware.ts';
import { STUB_IDEMPOTENCY_HMAC_KEY } from '../auth/service.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { createCheckedContentPort, type CheckedContentPort } from '../tts/content.ts';
import { createSynthesisMediaPort, type SynthesisMediaPort } from '../tts/media.ts';
import { createTtsProvider, type TtsProvider } from '../tts/provider.ts';
import { createSynthesisService, type SynthesisService } from '../tts/service.ts';
import { SYNTHESIS_TARGET_TYPES } from '../tts/state.ts';
import { createMemorySynthesisStore, type SynthesisStore } from '../tts/store.ts';
import { buildMeta } from './support.ts';

/**
 * 可注入依赖（**仅供测试替换端口**；应用装配路径不传，于是走按执行模式装配的默认端口）。
 * 缺省即：内存 store + 按模式的提供者/产物存储/核对源 —— `real` 模式三者全部 fail-closed。
 */
export interface SynthesisRouteDeps {
  store?: SynthesisStore;
  provider?: TtsProvider;
  media?: SynthesisMediaPort;
  content?: CheckedContentPort;
  idempotencyHmacKey?: string;
  jobDeadlineMs?: number;
  idempotencyWaitMs?: number;
  now?: () => Date;
  idFactory?: () => string;
  /** 测试注入：直接替换整个服务（默认由上面的端口装配）。 */
  service?: SynthesisService;
}

/** `Idempotency-Key` 头：与既有路由同一口径（缺/非法 ⇒ 400 IDEMPOTENCY_KEY_REQUIRED）。 */
function requireIdempotencyKeyHeader(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 128) {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', '缺少或非法的 Idempotency-Key 头（8..128 字符）');
  }
  return key;
}

/**
 * 注册 TTS 合成路由。
 *
 * @param pool 本域**尚无可用的 PG 记录层实现**（`tts/store.ts` 目前只有内存实现）。
 *   参数位置与既有 registrar 家族（profile/knowledge/consents…）保持一致，便于阶段 2b 在
 *   `app.ts` 里一行接线；当前**不读取**该参数，也不据此声称任何持久化能力。
 */
export function registerSynthesisRoutes(
  app: FastifyInstance,
  config: AppConfig,
  pool: PgPool | null,
  guards: AuthGuards,
  deps: SynthesisRouteDeps = {},
): SynthesisService {
  void pool; // 预留参数：避免「看起来已接线持久化」

  const mode = config.executionMode;
  const service =
    deps.service ??
    createSynthesisService({
      store: deps.store ?? createMemorySynthesisStore(),
      // 应用装配路径**永不**注入真实适配器端口；real 模式拿到的是 fail-closed 提供者。
      provider: deps.provider ?? createTtsProvider({ executionMode: mode }),
      media: deps.media ?? createSynthesisMediaPort(mode),
      content: deps.content ?? createCheckedContentPort(mode),
      idempotencyHmacKey: deps.idempotencyHmacKey ?? config.sessionSigningKey ?? STUB_IDEMPOTENCY_HMAC_KEY,
      jobDeadlineMs: deps.jobDeadlineMs,
      idempotencyWaitMs: deps.idempotencyWaitMs,
      now: deps.now,
      idFactory: deps.idFactory,
    });

  // 与契约 `SynthesisInput` 逐项一致（`additionalProperties:false` ⇒ 多余字段由 schema 拦下；
  // `app.ts` 关闭了 removeAdditional，所以不会被静默剔除）。
  const body = {
    type: 'object',
    additionalProperties: false,
    required: ['checked_content_ref', 'locale'],
    properties: {
      checked_content_ref: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'id', 'revision'],
        properties: {
          type: { type: 'string', enum: [...SYNTHESIS_TARGET_TYPES] },
          id: { type: 'string', minLength: 1, maxLength: 80 },
          revision: { type: 'integer', minimum: 1 },
        },
      },
      locale: { const: 'zh-CN' },
    },
  };

  app.post(
    `${API_PREFIX}/speech/synthesis`,
    { preHandler: guards.requireUser, schema: { body } },
    async (request, reply) => {
      // 服务端权威身份（客户端无法通过 body/query/自定义头声明身份）。
      const identity = currentIdentity(request);
      const key = requireIdempotencyKeyHeader(request);
      const result = await service.createSynthesis({
        userId: identity.userId,
        body: request.body,
        idempotencyKey: key,
      });
      return reply
        .header('ETag', `"${result.job.revision}"`)
        .header('Cache-Control', 'no-store')
        .status(result.status)
        .send({ data: result.job, meta: buildMeta(request, config) });
    },
  );

  return service;
}
