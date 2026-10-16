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
import { currentIdentity, type AuthGuards } from '../auth/middleware.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { SYNTHESIS_TARGET_TYPES } from '../tts/state.ts';
import type { SynthesisService } from '../tts/service.ts';
import { withPrivacyErrors, type ConsentGate } from '../privacy/egress.ts';
import type { SynthesisEgress } from '../privacy/synthesis-egress.ts';
import { buildMeta } from './support.ts';

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
 * **只接收一个已装配好的服务**（与 `registerRecognitionRoutes(app, config, guards, service)` 同形）：
 * 本文件因此**不可能**构造提供者、产物存储或核对源——「应用装配路径零端口注入」不只靠纪律，
 * 而是由这个签名在类型上成立。服务由 `app.ts` 按执行模式（或测试注入）构建，
 * 并在 `buildApp` 里 decorate 为 `app.synthesisService` 供回归核对默认关闭与任务终态。
 */
export function registerSynthesisRoutes(
  app: FastifyInstance,
  config: AppConfig,
  guards: AuthGuards,
  service: SynthesisService,
  /**
   * GY-I27 接线单：**可选**授权中间件端口。注入后挂在 `POST /speech/synthesis`
   * （外部 TTS 外发 ⇒ 用途 `external_inference`）。合成**不属**四类媒体资料类型
   * （`MEDIA_PURPOSES` 无 TTS），因此这里只声明用途、不声明 `data_type`（不做「错用途」判定）；
   * 未注入 ⇒ 行为与接线前逐字相同。
   */
  consent?: ConsentGate,
  /**
   * GY-I27（#29）·**可选**外发账本端口（第二维度 `checked_content`）。注入（且执行模式 `real`）后：
   * 受理前先 `reserveForAcceptance` 冻结「执行期会重读到的同一份已核对正文快照」；
   * `real` 未接真实传输 ⇒ **在任何账本变更之前** 503 `PROVIDER_UNAVAILABLE`（零 `sent`）。
   * 实际派发/回写在提供者包装侧（`privacy/synthesis-egress.ts`）。
   *
   * **为什么预留必须在受理处**：真实外发发生在**执行期**（作业入队后由 `execute` 调提供者），
   * 而「已核对正文」的读取端口只在执行期才拿到实际快照；若不在受理处预留，执行期就没有
   * 「已登记的这一次外发」可用于 `markSent` 授权判定。故与识别/转写/OCR 三域同形。
   * 未注入 ⇒ 与接线前逐字相同（`real` 仍由提供者 fail-closed 拦截）。
   */
  egress?: SynthesisEgress,
): void {

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
    {
      preHandler:
        consent === undefined
          ? guards.requireUser
          : [guards.requireUser, consent({ purpose: 'external_inference' })],
      schema: { body },
    },
    withPrivacyErrors(async (request, reply) => {
      // 服务端权威身份（客户端无法通过 body/query/自定义头声明身份）。
      const identity = currentIdentity(request);
      const key = requireIdempotencyKeyHeader(request);
      // schema 已保证形状（`checked_content_ref{type,id,revision}` 必填、`additionalProperties:false`）。
      const ref = (
        request.body as { checked_content_ref: { type: string; id: string; revision: number } }
      ).checked_content_ref;
      // GY-I27：本次受理的账本门面（只认本属主）。`undefined`（未装配账本）⇒ 一行账本访问都没有。
      const scoped = egress === undefined ? null : egress.withOwner(identity.userId);
      const reservation =
        scoped === null
          ? null
          : await scoped.reserveForAcceptance({
              userId: identity.userId,
              authEpoch: identity.authEpoch,
              // 账本对象键由 egress 侧**重读**已核对正文后派生（`<type>:<id>`），
              // 不直接采信客户端在 body 里声称的标识。
              contentType: ref.type,
              contentId: ref.id,
              contentRevision: ref.revision,
            });
      let result;
      try {
        result = await service.createSynthesis({
          userId: identity.userId,
          body: request.body,
          idempotencyKey: key,
        });
      } catch (error) {
        // 预留后受理失败 ⇒ 预留置终态（不留残留 `reserved` 行）。
        if (reservation !== null && scoped !== null) {
          await scoped.abandonReservation({ exportId: reservation.exportId });
        }
        throw error;
      }
      if (result.replayed === true && reservation !== null && scoped !== null) {
        // 幂等重放：服务层**不再调提供者** ⇒ 本次不会派发，预留行必须收回，
        // 否则会留下一条永不派发的 `reserved`（既占账本又误导排查）。
        await scoped.abandonReservation({ exportId: reservation.exportId });
      }
      return reply
        .header('ETag', `"${result.job.revision}"`)
        .header('Cache-Control', 'no-store')
        .status(result.status)
        .send({ data: result.job, meta: buildMeta(request, config) });
    }),
  );
}
