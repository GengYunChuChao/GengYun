/**
 * GY-I06（#6）媒体域 · HTTP 路由（**全项目唯一注册点**：由 `app.ts` 调用一次）。
 *
 * 契约（`packages/contracts/openapi.json` 原文，逐字对齐）：
 *
 * | operationId | 方法与路径 | 成功 | 参数 |
 * | --- | --- | --- | --- |
 * | `createUpload` | `POST /media/uploads` | 201 `UploadGrantEnvelope` | `Idempotency-Key` 必填 |
 * | `completeUpload` | `POST /media/uploads/{id}/complete` | 202 `MediaEnvelope` | `Idempotency-Key` + `If-Match` 必填 |
 * | `getMedia` | `GET /media/{id}` | 200 `MediaEnvelope` | — |
 * | `deleteMedia` | `DELETE /media/{id}` | 202 `AckEnvelope` | `Idempotency-Key` + `If-Match` 必填 |
 * | `grantMediaAccess` | `POST /media/{id}/access` | 200 `AccessGrantEnvelope` | `Idempotency-Key` + `If-Match` 必填 |
 * | `grantCommunityMediaAccess` | `POST /community/media-access` | 200 `CommunityMediaGrantEnvelope` | `Idempotency-Key` + `If-Match` 必填 |
 * | `readCommunityMediaContent` | `GET /community/media/{grant_id}/content` | 200 二进制图片 | `X-Media-Access-Token` 必填 |
 *
 * 全部 `security: userSession`（本文件统一挂 `guards.requireUser`）；成功响应统一带
 * `Cache-Control: no-store`（契约「私有/授权访问 no-store」）与强 `ETag`（`"<revision>"`）。
 *
 * 分层（HTTP 层只做「形状」，语义全在服务层）：
 * - HTTP 层：`Idempotency-Key` / 路径 uuid 形状 / 请求体 schema（`additionalProperties:false`，
 *   `app.ts` 已关闭 `removeAdditional`，多余字段不会被静默剔除）⇒ 400；Header 取值非法 ⇒ 400；
 * - 服务层：存在性、归属、版本、状态、审核上下文 ⇒ 404 / 409 / 428 / 503。
 * - 错误封套由 `app.ts` 的 `errorHandler` 统一渲染（本文件只抛 `ApiError`）。
 *
 * **本文件不构造任何存储/提供者**：只接收一个已装配好的 `AppMediaService`（与
 * `registerRecognitionRoutes(app, config, guards, service)` 同形），因此「装配路径零真实存储注入」
 * 由签名在类型上成立。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import { currentIdentity, type AuthGuards } from '../auth/middleware.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { isMediaIdLike, MEDIA_LIMITS, type AppMediaService, type MediaActor } from '../media/service.ts';
import { buildMeta } from './support.ts';

/** 契约 `UploadInput`（`additionalProperties:false`，required = purpose/mime/bytes/sha256）。 */
const UPLOAD_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['purpose', 'mime', 'bytes', 'sha256'],
  properties: {
    purpose: { type: 'string', enum: ['weed_recognition', 'label_ocr', 'voice_question', 'community_image'] },
    mime: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/aac'] },
    bytes: { type: 'integer', minimum: 1, maximum: MEDIA_LIMITS.maxBytes },
    duration_ms: { type: 'integer', minimum: 1, maximum: MEDIA_LIMITS.maxDurationMs },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
} as const;

/** 契约 `UploadCompleteInput`（只有 sha256 + bytes：**不含媒体字节**）。 */
const UPLOAD_COMPLETE_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['sha256', 'bytes'],
  properties: {
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    bytes: { type: 'integer', minimum: 1, maximum: MEDIA_LIMITS.maxBytes },
  },
} as const;

/** 契约 `CommunityMediaAccessInput`（`additionalProperties:false`，4 字段全必填）。 */
const COMMUNITY_MEDIA_ACCESS_INPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['content_ref', 'media_ref', 'slot', 'author_revision'],
  properties: {
    content_ref: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id', 'revision'],
      properties: {
        type: { type: 'string', enum: ['post', 'comment'] },
        id: { type: 'string', minLength: 1, maxLength: 80 },
        revision: { type: 'integer', minimum: 1 },
      },
    },
    media_ref: {
      type: 'object',
      additionalProperties: false,
      required: ['media_id', 'media_revision'],
      properties: {
        media_id: { type: 'string', minLength: 1, maxLength: 80 },
        media_revision: { type: 'integer', minimum: 1 },
      },
    },
    slot: { type: 'string', enum: ['attachment', 'author_avatar'] },
    // 契约写的是 `anyOf: [integer>=1, null]`。此处用等价的联合 `type` 写法，
    // 因为 Fastify 默认 `coerceTypes: true`：`anyOf` 的第二支 `{type:'null'}` 会把数字 `0`
    // **静默强转**成 null 从而通过校验；联合 `type` 下 `0` 仍按 integer 校验并被 `minimum:1` 拒绝。
    author_revision: { type: ['integer', 'null'], minimum: 1 },
  },
} as const;

const NO_QUERY = { type: 'object', additionalProperties: false } as const;

const ID_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 80 } },
} as const;

const GRANT_ID_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['grant_id'],
  properties: { grant_id: { type: 'string', minLength: 1, maxLength: 80 } },
} as const;

/** `Idempotency-Key`：与既有路由同一口径（缺/非法 ⇒ 400 `IDEMPOTENCY_KEY_REQUIRED`）。 */
function idempotencyKeyOf(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 128) {
    throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', '缺少或非法的 Idempotency-Key 头（8..128 字符）');
  }
  return key;
}

function ifMatchOf(request: FastifyRequest): string | undefined {
  const raw = request.headers['if-match'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : undefined;
}

/** 路径参数必须是 uuid 形状：格式错误在 **HTTP 层**判 400（存在性判定属服务层 404）。 */
function requireUuidPathParam(value: string, field: string): string {
  if (!isMediaIdLike(value)) {
    throw new ApiError('INVALID_REQUEST', `路径参数 ${field} 必须是 uuid`, {
      details: [{ field: `/${field}`, code: 'invalid_format' }],
    });
  }
  return value;
}

function actorOf(request: FastifyRequest): MediaActor {
  const identity = currentIdentity(request);
  return { ownerId: identity.userId, authEpoch: identity.authEpoch, sessionRef: identity.sessionId };
}

/** 注册媒体域全部 7 条路由（唯一注册点）。 */
export function registerMediaRoutes(
  app: FastifyInstance,
  config: AppConfig,
  guards: AuthGuards,
  service: AppMediaService,
): void {
  if (service.failClosedReason !== null) {
    app.log.warn(
      { executionMode: config.executionMode },
      `GY-I06 媒体域：${service.failClosedReason} ⇒ 7 条媒体路由一律 503 PROVIDER_UNAVAILABLE`,
    );
  }

  // ---------------------------------------------------------------- createUpload
  app.post(
    `${API_PREFIX}/media/uploads`,
    { preHandler: guards.requireUser, schema: { body: UPLOAD_INPUT, querystring: NO_QUERY } },
    async (request, reply) => {
      const outcome = await service.initiateUpload({
        actor: actorOf(request),
        input: request.body,
        idempotencyKey: idempotencyKeyOf(request),
      });
      return reply
        .header('ETag', `"${outcome.media.revision}"`)
        .header('Cache-Control', 'no-store')
        .status(outcome.status)
        .send({ data: { media: outcome.media, upload: outcome.upload }, meta: buildMeta(request, config) });
    },
  );

  // --------------------------------------------------------------- completeUpload
  app.post(
    `${API_PREFIX}/media/uploads/:id/complete`,
    {
      preHandler: guards.requireUser,
      schema: { params: ID_PARAMS, body: UPLOAD_COMPLETE_INPUT, querystring: NO_QUERY },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const outcome = await service.completeUpload({
        actor: actorOf(request),
        mediaId: requireUuidPathParam(id, 'id'),
        ifMatch: ifMatchOf(request),
        input: request.body,
        idempotencyKey: idempotencyKeyOf(request),
      });
      return reply
        .header('ETag', `"${outcome.media.revision}"`)
        .header('Cache-Control', 'no-store')
        .status(outcome.status)
        .send({ data: outcome.media, meta: buildMeta(request, config) });
    },
  );

  // -------------------------------------------------------------------- getMedia
  app.get(
    `${API_PREFIX}/media/:id`,
    { preHandler: guards.requireUser, schema: { params: ID_PARAMS, querystring: NO_QUERY } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const outcome = await service.getMedia({
        actor: actorOf(request),
        mediaId: requireUuidPathParam(id, 'id'),
      });
      return reply
        .header('ETag', `"${outcome.media.revision}"`)
        .header('Cache-Control', 'no-store')
        .status(outcome.status)
        .send({ data: outcome.media, meta: buildMeta(request, config) });
    },
  );

  // ----------------------------------------------------------------- deleteMedia
  app.delete(
    `${API_PREFIX}/media/:id`,
    { preHandler: guards.requireUser, schema: { params: ID_PARAMS, querystring: NO_QUERY } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const outcome = await service.deleteMedia({
        actor: actorOf(request),
        mediaId: requireUuidPathParam(id, 'id'),
        ifMatch: ifMatchOf(request),
        idempotencyKey: idempotencyKeyOf(request),
      });
      return reply
        .header('ETag', `"${outcome.revision}"`)
        .header('Cache-Control', 'no-store')
        .status(outcome.status)
        .send({ data: { accepted: outcome.ack.accepted }, meta: buildMeta(request, config) });
    },
  );

  // -------------------------------------------------------------- grantMediaAccess
  app.post(
    `${API_PREFIX}/media/:id/access`,
    { preHandler: guards.requireUser, schema: { params: ID_PARAMS, querystring: NO_QUERY } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const outcome = await service.grantMediaAccess({
        actor: actorOf(request),
        mediaId: requireUuidPathParam(id, 'id'),
        ifMatch: ifMatchOf(request),
        idempotencyKey: idempotencyKeyOf(request),
      });
      return reply
        .header('ETag', `"${outcome.mediaRevision}"`)
        .header('Cache-Control', 'no-store')
        .status(outcome.status)
        .send({ data: outcome.grant, meta: buildMeta(request, config) });
    },
  );

  // ------------------------------------------------------ grantCommunityMediaAccess
  app.post(
    `${API_PREFIX}/community/media-access`,
    { preHandler: guards.requireUser, schema: { body: COMMUNITY_MEDIA_ACCESS_INPUT, querystring: NO_QUERY } },
    async (request, reply) => {
      const outcome = await service.grantCommunityMediaAccess({
        actor: actorOf(request),
        body: request.body,
        ifMatch: ifMatchOf(request),
        idempotencyKey: idempotencyKeyOf(request),
      });
      return reply
        .header('ETag', `"${outcome.contentRevision}"`)
        .header('Cache-Control', 'no-store')
        .status(outcome.status)
        .send({ data: outcome.grant, meta: buildMeta(request, config) });
    },
  );

  // ---------------------------------------------------- readCommunityMediaContent
  app.get(
    `${API_PREFIX}/community/media/:grant_id/content`,
    { preHandler: guards.requireUser, schema: { params: GRANT_ID_PARAMS, querystring: NO_QUERY } },
    async (request, reply) => {
      const { grant_id: grantId } = request.params as { grant_id: string };
      const rawToken = request.headers['x-media-access-token'];
      const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
      if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
        throw new ApiError('INVALID_REQUEST', '缺少或非法的 X-Media-Access-Token 头（1..512 字符）');
      }
      const outcome = await service.readCommunityMediaContent({
        actor: actorOf(request),
        grantId: requireUuidPathParam(grantId, 'grant_id'),
        accessToken: token,
      });
      return reply
        .header('Content-Type', outcome.contentType)
        .header('ETag', `"${outcome.revision}"`)
        // 契约：`Cache-Control` 恒为 `no-store`；无原桶 URL 重定向。
        .header('Cache-Control', 'no-store')
        .header('X-Request-Id', request.id)
        .header('X-Execution-Mode', config.executionMode)
        .status(outcome.status)
        .send(Buffer.from(outcome.bytes));
    },
  );
}
