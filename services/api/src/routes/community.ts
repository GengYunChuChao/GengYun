/**
 * GY-I15（#15）阶段 2 · 社区 HTTP 路由（契约 operationId 一一对应，**不新增路径/字段**）。
 *
 *   GET    /posts                     listPosts        → 200 PostPageEnvelope
 *   POST   /posts                     createPost       → 201 PostEnvelope
 *   GET    /posts/{id}                getPost          → 200 PostEnvelope
 *   PATCH  /posts/{id}                editPost         → 200 PostEnvelope
 *   DELETE /posts/{id}                deletePost       → 200 AckEnvelope
 *   GET    /posts/{id}/comments       listComments     → 200 CommentPageEnvelope
 *   POST   /posts/{id}/comments       createComment    → 201 CommentEnvelope
 *   GET    /comments/{id}             getComment       → 200 CommentEnvelope
 *   PATCH  /comments/{id}             editComment      → 200 CommentEnvelope
 *   DELETE /comments/{id}             deleteComment    → 200 AckEnvelope
 *   PUT    /posts/{id}/like           likePosts        → 200 AckEnvelope
 *   DELETE /posts/{id}/like           unlikePosts      → 200 AckEnvelope
 *   PUT    /comments/{id}/like        likeComments     → 200 AckEnvelope
 *   DELETE /comments/{id}/like        unlikeComments   → 200 AckEnvelope
 *   POST   /reports                   createReport     → 201 ReportEnvelope
 *   GET    /reports/{id}              getOwnReport     → 200 ReportEnvelope
 *
 * 不注册 `POST /admin/posts/{id}/hide`（属 #18，已由 `routes/admin.ts` 注册）。
 *
 * ## 装配纪律
 *
 * - **鉴权**：一律 `guards.requireUser`（契约 `security: userSession`）。游客 401
 *   `SESSION_REQUIRED`；后台会话 403 `SCOPE_DENIED`（服务层 `requireUserActor` 兜底），
 *   越权/不存在一律 404（不泄露存在性）。
 * - **头部**：写路径的 `Idempotency-Key` / `If-Match` 由**服务层**校验（缺 `If-Match`
 *   ⇒ 428 `REVISION_REQUIRED`，缺 `Idempotency-Key` ⇒ 400 `IDEMPOTENCY_KEY_REQUIRED`），
 *   路由层只**原样转发**请求头，不自己解析、不自己兜底。
 * - **ETag**：只在返回**资源表示**的 200/201 上写强 ETag `"<revision>"`（与
 *   `messages/service.ts::strongEtagOf` 同一口径：不同资源状态不得共用强 ETag）。
 *   列表（契约明写「列表无此头」）与 `Ack` 不写 ETag：`Ack` 不返回资源表示，
 *   删除后资源已不存在，给一个"当前版本"的强 ETag 会指向一个已不可读的状态。
 * - **缓存**：所有响应 `Cache-Control: no-store`（契约 200 头说明「私有/授权访问 no-store」）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readIdentity, type AuthGuards } from '../auth/middleware.ts';
import type { AppConfig } from '../config.ts';
import { API_PREFIX } from '../contract.ts';
import { ApiError } from '../errors.ts';
import type { CommunityService } from '../community/service.ts';
import { buildMeta } from './support.ts';

/** 强 ETag：`"<revision>"`（契约 `If-Match` 参数 pattern `^"[1-9][0-9]*"$`）。 */
export function strongEtagOf(revision: number): string {
  return `"${revision}"`;
}

const ID_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const emptyQuery = { type: 'object', additionalProperties: false, properties: {} } as const;

const knowledgeTargetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'id', 'revision'],
  properties: {
    type: { type: 'string', enum: ['species', 'herbicide', 'scheme'] },
    id: { type: 'string', minLength: 1, maxLength: 80 },
    revision: { type: 'integer', minimum: 1 },
  },
} as const;

/** 契约 `PostInput`（`additionalProperties:false`，required `title`/`body`/`media_ids`）。 */
const postBody = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body', 'media_ids'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    body: { type: 'string', minLength: 1, maxLength: 8000 },
    crop_id: { type: 'string', minLength: 1, maxLength: 80 },
    region_code: { type: 'string', pattern: '^33[0-9]{4}$' },
    media_ids: {
      type: 'array',
      maxItems: 3,
      uniqueItems: true,
      items: { type: 'string', format: 'uuid' },
    },
    linked_knowledge_ref: { anyOf: [knowledgeTargetSchema, { type: 'null' }] },
  },
} as const;

/** 契约 `CommentInput`。 */
const commentBody = {
  type: 'object',
  additionalProperties: false,
  required: ['body'],
  properties: { body: { type: 'string', minLength: 1, maxLength: 4000 } },
} as const;

/** 契约 `ReportInput`（`target_ref` = `ReportTarget`：type ∈ {post,comment}）。 */
const reportBody = {
  type: 'object',
  additionalProperties: false,
  required: ['target_ref', 'reason_code'],
  properties: {
    target_ref: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id', 'revision'],
      properties: {
        type: { type: 'string', enum: ['post', 'comment'] },
        id: { type: 'string', minLength: 1, maxLength: 80 },
        revision: { type: 'integer', minimum: 1 },
      },
    },
    reason_code: {
      type: 'string',
      enum: ['dangerous', 'privacy', 'advertising', 'misleading', 'other'],
    },
    detail: { type: 'string', minLength: 1, maxLength: 1000 },
  },
} as const;

/** `GET /posts` 的查询参数（契约只有这 5 个，多余的 `additionalProperties:false` 直接 400）。 */
const listPostsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', minLength: 1, maxLength: 2048 },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    crop_id: { type: 'string', minLength: 1, maxLength: 80 },
    region_code: { type: 'string', pattern: '^33[0-9]{4}$' },
    mine: { type: 'boolean' },
  },
} as const;

const listCommentsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', minLength: 1, maxLength: 2048 },
    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
  },
} as const;

/** 请求头原样透传给服务层（服务层是头部语义的唯一判定者）。 */
function writeOptions(request: FastifyRequest): { idempotencyKey?: string; ifMatch?: string } {
  const rawKey = request.headers['idempotency-key'];
  const rawMatch = request.headers['if-match'];
  const options: { idempotencyKey?: string; ifMatch?: string } = {};
  if (rawKey !== undefined) options.idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  if (rawMatch !== undefined) options.ifMatch = Array.isArray(rawMatch) ? rawMatch[0] : rawMatch;
  return options;
}

/**
 * 调用主体：服务端权威身份（`readIdentity`）+ 一行防御。
 *
 * `readIdentity` 在 `guards.requireUser` 之后**永不抛错**；这里额外挡住"用户会话缺失"
 * 这种装配层错误（宁可 401，也不要让下游拿到一个没有 userId 的 actor 去写库）。
 */
function actorOf(request: FastifyRequest): unknown {
  const identity = readIdentity(request);
  if (identity.role !== 'user') throw new ApiError('SCOPE_DENIED', '社区读写需要用户会话，后台会话不得代替');
  return identity;
}

function idOf(request: FastifyRequest): string {
  return (request.params as { id: string }).id;
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('Cache-Control', 'no-store');
}

/**
 * `onRequest` 钩子：**先于**鉴权与 schema 校验执行，因此**成功与失败响应都带 no-store**。
 *
 * 为什么必须在钩子里做：契约把社区接口的 200 头标为「私有/授权访问 no-store」，
 * 而 401/403/404/409/422/503 同样可能带出内容或状态，且共享缓存不应缓存任何一份。
 * 只在成功分支写头会让错误响应失去 no-store（`routes/messages.ts` 同口径）。
 */
const noStoreHook = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  reply.header('Cache-Control', 'no-store');
};

export function registerCommunityRoutes(
  app: FastifyInstance,
  config: AppConfig,
  guards: AuthGuards,
  service: CommunityService | null,
): void {
  /** 未接线（`real` 模式无真实持久存储）⇒ 契约闭集内 503，绝不返回空页/假成功。 */
  function ready(): CommunityService {
    if (service === null) {
      throw new ApiError('PROVIDER_UNAVAILABLE', '社区持久存储尚未接线', { retryable: true });
    }
    return service;
  }

  app.get(
    `${API_PREFIX}/posts`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { querystring: listPostsQuery } },
    async (request, reply) => {
      const data = await ready().listPosts(actorOf(request), request.query as Record<string, never>);
      // 契约：列表不带 ETag（"列表无此头"）。
      return noStore(reply).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.post(
    `${API_PREFIX}/posts`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { body: postBody } },
    async (request, reply) => {
      const data = await ready().createPost(actorOf(request), request.body, writeOptions(request));
      return noStore(reply)
        .status(201)
        .header('ETag', strongEtagOf(data.revision))
        .send({ data, meta: buildMeta(request, config) });
    },
  );

  app.get(
    `${API_PREFIX}/posts/:id`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { params: ID_PARAMS } },
    async (request, reply) => {
      const data = await ready().getPost(actorOf(request), idOf(request));
      return noStore(reply).header('ETag', strongEtagOf(data.revision)).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.patch(
    `${API_PREFIX}/posts/:id`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { params: ID_PARAMS, body: postBody } },
    async (request, reply) => {
      const data = await ready().editPost(actorOf(request), idOf(request), request.body, writeOptions(request));
      return noStore(reply).header('ETag', strongEtagOf(data.revision)).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.delete(
    `${API_PREFIX}/posts/:id`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { params: ID_PARAMS } },
    async (request, reply) => {
      const data = await ready().deletePost(actorOf(request), idOf(request), writeOptions(request));
      // `Ack` 不返回资源表示，删除后资源已不可读 ⇒ 不写 ETag（见文件头"ETag"一节）。
      return noStore(reply).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.get(
    `${API_PREFIX}/posts/:id/comments`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { params: ID_PARAMS, querystring: listCommentsQuery } },
    async (request, reply) => {
      const data = await ready().listComments(
        actorOf(request),
        idOf(request),
        request.query as Record<string, never>,
      );
      return noStore(reply).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.post(
    `${API_PREFIX}/posts/:id/comments`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { params: ID_PARAMS, body: commentBody } },
    async (request, reply) => {
      const data = await ready().createComment(actorOf(request), idOf(request), request.body, writeOptions(request));
      return noStore(reply)
        .status(201)
        .header('ETag', strongEtagOf(data.revision))
        .send({ data, meta: buildMeta(request, config) });
    },
  );

  app.get(
    `${API_PREFIX}/comments/:id`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { params: ID_PARAMS } },
    async (request, reply) => {
      const data = await ready().getComment(actorOf(request), idOf(request));
      return noStore(reply).header('ETag', strongEtagOf(data.revision)).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.patch(
    `${API_PREFIX}/comments/:id`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { params: ID_PARAMS, body: commentBody } },
    async (request, reply) => {
      const data = await ready().editComment(actorOf(request), idOf(request), request.body, writeOptions(request));
      return noStore(reply).header('ETag', strongEtagOf(data.revision)).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.delete(
    `${API_PREFIX}/comments/:id`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { params: ID_PARAMS } },
    async (request, reply) => {
      const data = await ready().deleteComment(actorOf(request), idOf(request), writeOptions(request));
      return noStore(reply).send({ data, meta: buildMeta(request, config) });
    },
  );

  // 点赞：PUT/DELETE 幂等（重复 PUT 不产生第二条记录、不改内容 revision），
  // 因此不写 ETag（`Ack` 无资源表示，且集合变化不改变 `Post`/`Comment` 的版本）。
  app.put(
    `${API_PREFIX}/posts/:id/like`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { params: ID_PARAMS } },
    async (request, reply) => {
      const data = await ready().likePosts(actorOf(request), idOf(request), writeOptions(request));
      return noStore(reply).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.delete(
    `${API_PREFIX}/posts/:id/like`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { params: ID_PARAMS } },
    async (request, reply) => {
      const data = await ready().unlikePosts(actorOf(request), idOf(request), writeOptions(request));
      return noStore(reply).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.put(
    `${API_PREFIX}/comments/:id/like`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { params: ID_PARAMS } },
    async (request, reply) => {
      const data = await ready().likeComments(actorOf(request), idOf(request), writeOptions(request));
      return noStore(reply).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.delete(
    `${API_PREFIX}/comments/:id/like`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { params: ID_PARAMS } },
    async (request, reply) => {
      const data = await ready().unlikeComments(actorOf(request), idOf(request), writeOptions(request));
      return noStore(reply).send({ data, meta: buildMeta(request, config) });
    },
  );

  app.post(
    `${API_PREFIX}/reports`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { body: reportBody } },
    async (request, reply) => {
      const data = await ready().createReport(actorOf(request), request.body, writeOptions(request));
      return noStore(reply)
        .status(201)
        .header('ETag', strongEtagOf(data.revision))
        .send({ data, meta: buildMeta(request, config) });
    },
  );

  app.get(
    `${API_PREFIX}/reports/:id`,
    { onRequest: noStoreHook, preHandler: guards.requireUser, schema: { params: ID_PARAMS, querystring: emptyQuery } },
    async (request, reply) => {
      const data = await ready().getOwnReport(actorOf(request), idOf(request));
      return noStore(reply).header('ETag', strongEtagOf(data.revision)).send({ data, meta: buildMeta(request, config) });
    },
  );
}
