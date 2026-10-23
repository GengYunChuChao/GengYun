/**
 * GY-I18 后台资料／运营／开关 · HTTP 路由（阶段 2：产品装配）。
 *
 * 覆盖契约 `packages/contracts/openapi.json` 里 **36 个 operationId**：
 * - 阶段 1（已合并 #96）25 个：四类资料 × 6（list/create/get/edit/publish/withdraw）
 *   + `listAuditEvents`；
 * - 阶段 1b（已合并 #101）9 个：`listAdminCategories`/`editCategory`、
 *   `listAdminUsers`/`suspendUser`、`listAdminJobs`/`cancelAdminJob`、
 *   `listFlags`/`setFlag`、`hidePost`；
 * - R33 1 个：`listFlagAuditEvents`（迁移 0027 的只读函数，scope `flags:read`）；
 * - R34 1 个：`listAuditLogs`（迁移 0033 的只读函数，scope `audit:read`）。
 *
 * **本文件只做「搬运 + 契约映射」**：鉴权/权限、审计、幂等、CAS、可见性、
 * 契约字段校验、fail-closed 判定**全部复用服务层既有实现**
 * （`services/api/src/admin/**`，本文件只 import、不修改其语义）。因此本文件里
 * **没有**第二套权限判定、第二套字段校验、第二套幂等实现。
 *
 * ## 两层分工（本项目已定口径，必须遵守）
 * - **HTTP 层判格式**：路径参数用 Fastify `schema` 声明形状 —— uuid 型 id 用
 *   `{ type:'string', format:'uuid' }`，不透明字符串型 id（分类）用 `minLength/maxLength`。
 *   格式不合法 ⇒ `app.ts` 的 errorHandler 统一映射 **400 `INVALID_REQUEST`**。
 * - **服务层判存在性与归属**：目标不存在、越权、跨家族 ⇒ **404 `NOT_FOUND`**（对外同形）。
 *
 * 这条分工有**钉子用例**（`tests/unit/admin-routes-nail.test.mjs`）钉住：非法 uuid 必须留在
 * **400** 组、**不得**被并进「同形 404」组，防未来静默翻转（与 #10/#106 的钉子同一口径）。
 *
 * ## 有意**不**在路由层收窄的三处（附理由）
 * 1. `setFlag` 的 `:key` **不**在 HTTP 层按契约闭集枚举拦下，只做 `string 1..80`：
 *    服务层必须在「安全语义保留名」被尝试时**留一条 `denied` 审计**；
 *    若在路由层就 400，这条审计永远不会产生 ⇒ 安全语义被削弱。
 *    闭集判定仍由服务层执行（未知 key ⇒ 400 `INVALID_REQUEST`）。
 * 2. **请求体不重复声明 schema**：契约字段校验（`additionalProperties:false`、
 *    必填、长度、枚举、格式）由服务层的**契约镜像校验器**完成（该表由契约比对用例守护）。
 *    在路由层再抄一份 JSON Schema 会形成**第二份会漂移的契约副本**。
 * 3. `If-Match` / `Idempotency-Key` **原样**交给服务层判定
 *    （形状与错误码口径与既有路由一致：缺 `If-Match` ⇒ 428、非法 ⇒ 400、
 *    不匹配 ⇒ 409；缺 `Idempotency-Key` ⇒ 400 `IDEMPOTENCY_KEY_REQUIRED`）。
 *
 * 响应：直接把服务层返回的 `{ status, headers, body }` 落盘 —— 封套（含 `meta`）
 * 由服务层按契约生成，`request_id` 取 `request.id`，与错误封套同一来源。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentIdentity, type AuthGuards } from '../auth/middleware.ts';
import { API_PREFIX } from '../contract.ts';
import { FAMILIES, KNOWLEDGE_FAMILY, REGISTRATION_FAMILY, RESTRICTION_FAMILY, SOURCE_FAMILY } from '../admin/families.ts';
import type { AdminCallContext, ServiceResponse } from '../admin/types.ts';
import type { AdminContentService } from '../admin/service.ts';
import { OPS_SCOPES } from '../admin/ops/service.ts';
import type { AdminOpsService } from '../admin/ops/service.ts';
import { CONTRACT_FLAG_KEYS } from '../admin/ops/flags.ts';
import { AUDIT_LOG_SCOPE } from '../admin/audit/catalog.ts';
import type { AdminAuditLogService } from '../admin/audit/service.ts';

const noStore = { 'Cache-Control': 'no-store' } as const;

/** 契约 uuid 型路径参数（`{ type:'string', format:'uuid' }`）。 */
const uuidIdParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

/** 契约不透明字符串型路径参数（分类 id：`minLength:1, maxLength:80`）。 */
const opaqueIdParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 80 } },
} as const;

/**
 * `setFlag` 的 `:key`：**只做长度形状**，不做闭集枚举。
 * 理由见文件头「有意不在路由层收窄的三处」第 1 条（闭集判定与 `denied` 审计都在服务层）。
 */
const flagKeyParams = {
  type: 'object',
  additionalProperties: false,
  required: ['key'],
  properties: { key: { type: 'string', minLength: 1, maxLength: 80 } },
} as const;

/** 取请求头原值（可能是重复头的数组）：**形态由服务层判定**，本层不做第二次判定。 */
function rawHeader(request: FastifyRequest, name: string): string | string[] | undefined {
  return request.headers[name];
}

/**
 * 组装服务层调用上下文。
 *
 * 身份来自**服务端权威会话**（`auth/middleware.ts` 的 `readIdentity` 缝），
 * 客户端无法通过 body/query/自定义头声明身份；`requestId` 用 Fastify 的 `request.id`，
 * 与错误封套的 `meta.request_id` 同源。
 */
function callerOf(request: FastifyRequest): AdminCallContext {
  const identity = currentIdentity(request);
  return {
    identity: {
      userId: identity.userId,
      authEpoch: identity.authEpoch,
      role: identity.role,
      scopes: identity.scopes,
    },
    requestId: request.id,
    // 形态判定属服务层（非字符串 ⇒ INVALID_REQUEST / REVISION_REQUIRED）。
    idempotencyKey: rawHeader(request, 'idempotency-key') as string | undefined,
    ifMatch: rawHeader(request, 'if-match') as string | undefined,
  };
}

/** 把服务层返回的响应描述符落盘（状态码/头/契约封套全部来自服务层）。 */
function send(reply: FastifyReply, response: ServiceResponse<unknown>): unknown {
  for (const [name, value] of Object.entries(response.headers)) reply.header(name, value);
  return reply.status(response.status).send(response.body);
}

/** 服务方法的**单一**动态调用签名（operationId 即方法名，见各操作表）。 */
type AdminMethod = (ctx: AdminCallContext, ...args: unknown[]) => Promise<ServiceResponse<Record<string, unknown>>>;

function methodOf(owner: object, operationId: string): AdminMethod {
  const found = (owner as unknown as Record<string, AdminMethod>)[operationId];
  if (typeof found !== 'function') {
    // 装配期即失败：服务层缺方法属装配 bug，不能等到请求时才 404/500。
    throw new Error(`后台服务缺少 operationId 对应的方法：${operationId}`);
  }
  // 方法取自服务对象，调用时 this 必须仍是该对象。
  return found.bind(owner) as AdminMethod;
}

export interface AdminDomainServices {
  /** 阶段 1：资料生命周期（25 个 operationId）。 */
  readonly content: AdminContentService;
  /** 阶段 1b：运营与开关（9 个 operationId）。 */
  readonly ops: AdminOpsService;
  /**
   * R34：库内审计日志只读查询（1 个 operationId：`listAuditLogs`）。
   *
   * 单列一个域而不是塞进 `ops`：`AdminOpsService` 被用例钉住「恰好 10 个 operationId」，
   * 把只读审计面挂上去会让那条钉子失焦，也会把「运营写面」与「审计读面」的接线判据混成一个。
   */
  readonly audit: AdminAuditLogService;
}

/**
 * 注册 34 个后台路由。
 *
 * 与 `registerSynthesisRoutes` / `registerRecognitionRoutes` 同形：
 * **只接收已装配好的服务**，因此本文件无法构造提供者、存储或端口——
 * 「默认未接线 ⇒ fail-closed」不只靠纪律，而是由签名在类型上成立。
 *
 * 注意本签名**不接收 `config`**（与兄弟路由文件不同）：本层不拼装任何封套，
 * `meta`（含 `execution_mode`）由服务层按同一 config 生成，避免出现第二个来源。
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  guards: AuthGuards,
  services: AdminDomainServices,
): void {
  // -------------------------------------------------------------------------
  // 阶段 1：四类资料 × 6（24 个 operationId）
  // operationId/scope 取自 `families.ts` 的家族描述符（单一来源）；
  // **路径逐条字面书写**（`${API_PREFIX}/admin/...`）：项目的静态路由清单工具
  // （`tools/contract-status-core.mjs` 的 `scanMountedRoutes`）只识别紧跟在
  // `app.<method>(` 之后、且不含未知模板变量的字符串；二次拼接会被判为
  // `Unresolved route template`（并使 `test:unit` 的
  // `contract-status-tool.test.mjs` 失败）。因此这里显式展开 24 条。
  // -------------------------------------------------------------------------
  /** 绑定某家族的 6 个服务方法与两套守卫（只为减少重复；路径仍逐条字面书写）。 */
  function familyOps(descriptor: (typeof FAMILIES)[number]) {
    return {
      read: methodOf(services.content, descriptor.operations.list),
      create: methodOf(services.content, descriptor.operations.create),
      get: methodOf(services.content, descriptor.operations.get),
      edit: methodOf(services.content, descriptor.operations.edit),
      publish: methodOf(services.content, descriptor.operations.publish),
      withdraw: methodOf(services.content, descriptor.operations.withdraw),
      readGuards: { preHandler: [guards.requireAdmin, guards.requireScope(descriptor.readScope)] },
      writeGuards: { preHandler: [guards.requireAdmin, guards.requireScope(descriptor.writeScope)] },
    };
  }

  const sources = familyOps(SOURCE_FAMILY);
  app.get(`${API_PREFIX}/admin/sources`, sources.readGuards, async (request, reply) =>
    send(reply, await sources.read(callerOf(request), request.query)),
  );
  app.post(`${API_PREFIX}/admin/sources`, sources.writeGuards, async (request, reply) =>
    send(reply, await sources.create(callerOf(request), request.body)),
  );
  app.get(`${API_PREFIX}/admin/sources/:id`, { ...sources.readGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await sources.get(callerOf(request), (request.params as { id: string }).id)),
  );
  app.patch(`${API_PREFIX}/admin/sources/:id`, { ...sources.writeGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await sources.edit(callerOf(request), (request.params as { id: string }).id, request.body)),
  );
  app.post(`${API_PREFIX}/admin/sources/:id/publish`, { ...sources.writeGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await sources.publish(callerOf(request), (request.params as { id: string }).id, request.body)),
  );
  app.post(`${API_PREFIX}/admin/sources/:id/withdraw`, { ...sources.writeGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await sources.withdraw(callerOf(request), (request.params as { id: string }).id, request.body)),
  );

  const knowledge = familyOps(KNOWLEDGE_FAMILY);
  app.get(`${API_PREFIX}/admin/knowledge`, knowledge.readGuards, async (request, reply) =>
    send(reply, await knowledge.read(callerOf(request), request.query)),
  );
  app.post(`${API_PREFIX}/admin/knowledge`, knowledge.writeGuards, async (request, reply) =>
    send(reply, await knowledge.create(callerOf(request), request.body)),
  );
  app.get(`${API_PREFIX}/admin/knowledge/:id`, { ...knowledge.readGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await knowledge.get(callerOf(request), (request.params as { id: string }).id)),
  );
  app.patch(`${API_PREFIX}/admin/knowledge/:id`, { ...knowledge.writeGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await knowledge.edit(callerOf(request), (request.params as { id: string }).id, request.body)),
  );
  app.post(`${API_PREFIX}/admin/knowledge/:id/publish`, { ...knowledge.writeGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await knowledge.publish(callerOf(request), (request.params as { id: string }).id, request.body)),
  );
  app.post(`${API_PREFIX}/admin/knowledge/:id/withdraw`, { ...knowledge.writeGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await knowledge.withdraw(callerOf(request), (request.params as { id: string }).id, request.body)),
  );

  const registrations = familyOps(REGISTRATION_FAMILY);
  app.get(`${API_PREFIX}/admin/registrations`, registrations.readGuards, async (request, reply) =>
    send(reply, await registrations.read(callerOf(request), request.query)),
  );
  app.post(`${API_PREFIX}/admin/registrations`, registrations.writeGuards, async (request, reply) =>
    send(reply, await registrations.create(callerOf(request), request.body)),
  );
  app.get(`${API_PREFIX}/admin/registrations/:id`, { ...registrations.readGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await registrations.get(callerOf(request), (request.params as { id: string }).id)),
  );
  app.patch(`${API_PREFIX}/admin/registrations/:id`, { ...registrations.writeGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await registrations.edit(callerOf(request), (request.params as { id: string }).id, request.body)),
  );
  app.post(`${API_PREFIX}/admin/registrations/:id/publish`, { ...registrations.writeGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await registrations.publish(callerOf(request), (request.params as { id: string }).id, request.body)),
  );
  app.post(`${API_PREFIX}/admin/registrations/:id/withdraw`, { ...registrations.writeGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await registrations.withdraw(callerOf(request), (request.params as { id: string }).id, request.body)),
  );

  const restrictions = familyOps(RESTRICTION_FAMILY);
  app.get(`${API_PREFIX}/admin/restrictions`, restrictions.readGuards, async (request, reply) =>
    send(reply, await restrictions.read(callerOf(request), request.query)),
  );
  app.post(`${API_PREFIX}/admin/restrictions`, restrictions.writeGuards, async (request, reply) =>
    send(reply, await restrictions.create(callerOf(request), request.body)),
  );
  app.get(`${API_PREFIX}/admin/restrictions/:id`, { ...restrictions.readGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await restrictions.get(callerOf(request), (request.params as { id: string }).id)),
  );
  app.patch(`${API_PREFIX}/admin/restrictions/:id`, { ...restrictions.writeGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await restrictions.edit(callerOf(request), (request.params as { id: string }).id, request.body)),
  );
  app.post(`${API_PREFIX}/admin/restrictions/:id/publish`, { ...restrictions.writeGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await restrictions.publish(callerOf(request), (request.params as { id: string }).id, request.body)),
  );
  app.post(`${API_PREFIX}/admin/restrictions/:id/withdraw`, { ...restrictions.writeGuards, schema: { params: uuidIdParams } }, async (request, reply) =>
    send(reply, await restrictions.withdraw(callerOf(request), (request.params as { id: string }).id, request.body)),
  );

  // -------------------------------------------------------------------------
  // 阶段 1：审计事件只读（1 个 operationId）
  // -------------------------------------------------------------------------
  const listAudit = methodOf(services.content, 'listAuditEvents');
  app.get(
    `${API_PREFIX}/admin/audit-events`,
    { preHandler: [guards.requireAdmin, guards.requireScope('audit:read')] },
    async (request, reply) => send(reply, await listAudit(callerOf(request), request.query)),
  );

  // -------------------------------------------------------------------------
  // R34：库内审计日志只读查询（1 个 operationId：`listAuditLogs`）
  // 读的是迁移 0033 的 `public.list_admin_audit_logs()`：运行时角色对 `admin_audit_events`
  // 是**零表级权限**（0017 的裁定），所以只能经 `SECURITY DEFINER` 函数读。
  // 未接线（stub 默认 / real 无库池）⇒ 服务层 503 PROVIDER_UNAVAILABLE，本层不改写、不返回空页。
  // 权限复用既有后台 scope `audit:read`（与 `listAuditEvents` 同一把门，不新造一套角色判定）。
  // -------------------------------------------------------------------------
  const listAuditLogs = methodOf(services.audit, 'listAuditLogs');
  app.get(
    `${API_PREFIX}/admin/audit-logs`,
    { preHandler: [guards.requireAdmin, guards.requireScope(AUDIT_LOG_SCOPE)] },
    async (request, reply) => send(reply, await listAuditLogs(callerOf(request), request.query)),
  );

  // -------------------------------------------------------------------------
  // 阶段 1b：分类（2 个 operationId）
  // scope 取自 `OPS_SCOPES`（与 `operations.json` 的契约比对用例守护）。
  // -------------------------------------------------------------------------
  const listCategories = methodOf(services.ops, 'listAdminCategories');
  const editCategory = methodOf(services.ops, 'editCategory');
  app.get(
    `${API_PREFIX}/admin/categories`,
    { preHandler: [guards.requireAdmin, guards.requireScope(OPS_SCOPES.listAdminCategories)] },
    async (request, reply) => send(reply, await listCategories(callerOf(request), request.query)),
  );
  app.patch(
    `${API_PREFIX}/admin/categories/:id`,
    {
      preHandler: [guards.requireAdmin, guards.requireScope(OPS_SCOPES.editCategory)],
      // 分类 id 是**不透明字符串**（不是 uuid）⇒ 只判长度，存在性归服务层。
      schema: { params: opaqueIdParams },
    },
    async (request, reply) =>
      send(reply, await editCategory(callerOf(request), (request.params as { id: string }).id, request.body)),
  );

  // -------------------------------------------------------------------------
  // 阶段 1b：账号（2 个 operationId）
  // -------------------------------------------------------------------------
  const listAccounts = methodOf(services.ops, 'listAdminUsers');
  const suspendUser = methodOf(services.ops, 'suspendUser');
  app.get(
    `${API_PREFIX}/admin/accounts`,
    { preHandler: [guards.requireAdmin, guards.requireScope(OPS_SCOPES.listAdminUsers)] },
    async (request, reply) => send(reply, await listAccounts(callerOf(request), request.query)),
  );
  app.post(
    `${API_PREFIX}/admin/accounts/:id/suspend`,
    {
      preHandler: [guards.requireAdmin, guards.requireScope(OPS_SCOPES.suspendUser)],
      schema: { params: uuidIdParams },
    },
    async (request, reply) =>
      send(reply, await suspendUser(callerOf(request), (request.params as { id: string }).id, request.body)),
  );

  // -------------------------------------------------------------------------
  // 阶段 1b：平台级作业（2 个 operationId）
  // **默认未接线 ⇒ 读与写都 503 `PROVIDER_UNAVAILABLE`（不返回空页）**：
  // 空页会被读成「平台当前没有作业」，那是无法确认的结论。该判定在服务层，
  // 本层不重复、也不把 503 改写成 200。
  // -------------------------------------------------------------------------
  const listJobs = methodOf(services.ops, 'listAdminJobs');
  const cancelJob = methodOf(services.ops, 'cancelAdminJob');
  app.get(
    `${API_PREFIX}/admin/jobs`,
    { preHandler: [guards.requireAdmin, guards.requireScope(OPS_SCOPES.listAdminJobs)] },
    async (request, reply) => send(reply, await listJobs(callerOf(request), request.query)),
  );
  app.post(
    `${API_PREFIX}/admin/jobs/:id/cancel`,
    {
      preHandler: [guards.requireAdmin, guards.requireScope(OPS_SCOPES.cancelAdminJob)],
      schema: { params: uuidIdParams },
    },
    async (request, reply) =>
      send(reply, await cancelJob(callerOf(request), (request.params as { id: string }).id, request.body)),
  );

  // -------------------------------------------------------------------------
  // 阶段 1b：功能开关（2 个 operationId）
  // `:key` 只判长度（闭集判定与 `denied` 审计在服务层，见文件头第 1 条）。
  // -------------------------------------------------------------------------
  const listFlags = methodOf(services.ops, 'listFlags');
  const setFlag = methodOf(services.ops, 'setFlag');
  app.get(
    `${API_PREFIX}/admin/feature-flags`,
    { preHandler: [guards.requireAdmin, guards.requireScope(OPS_SCOPES.listFlags)] },
    async (request, reply) => send(reply, await listFlags(callerOf(request), request.query)),
  );
  app.put(
    `${API_PREFIX}/admin/feature-flags/:key`,
    {
      preHandler: [guards.requireAdmin, guards.requireScope(OPS_SCOPES.setFlag)],
      schema: { params: flagKeyParams },
    },
    async (request, reply) =>
      send(reply, await setFlag(callerOf(request), (request.params as { key: string }).key, request.body)),
  );

  // -------------------------------------------------------------------------
  // GY-I18 第一批：开关变更留痕（1 个 operationId，`flags:read`）
  // 读的是迁移 0027 的库内审计（A→B 同事务写入）；未接线 ⇒ 服务层 503，本层不改写。
  // -------------------------------------------------------------------------
  const listFlagAudit = methodOf(services.ops, 'listFlagAuditEvents');
  app.get(
    `${API_PREFIX}/admin/flag-audit-events`,
    { preHandler: [guards.requireAdmin, guards.requireScope(OPS_SCOPES.listFlagAuditEvents)] },
    async (request, reply) => send(reply, await listFlagAudit(callerOf(request), request.query)),
  );

  // -------------------------------------------------------------------------
  // 阶段 1b：隐藏帖子（1 个 operationId）
  // 可见性语义（社区 CAS 置 `hidden`、已删除不可复活）全在服务层；
  // 未接线时服务层 503，本层不伪造成功。
  // -------------------------------------------------------------------------
  const hidePost = methodOf(services.ops, 'hidePost');
  app.post(
    `${API_PREFIX}/admin/posts/:id/hide`,
    {
      preHandler: [guards.requireAdmin, guards.requireScope(OPS_SCOPES.hidePost)],
      schema: { params: uuidIdParams },
    },
    async (request, reply) =>
      send(reply, await hidePost(callerOf(request), (request.params as { id: string }).id, request.body)),
  );
}

/** 契约闭集的 3 个开关 key（供装配期自检与测试引用；判定仍在服务层）。 */
export const ADMIN_FLAG_KEYS: readonly string[] = CONTRACT_FLAG_KEYS;

/** 与本文件注册的路由一一对应的 operationId 全集（供映射表用例逐项核对）。 */
export const ADMIN_HTTP_OPERATION_IDS: readonly string[] = Object.freeze([
  ...FAMILIES.flatMap((descriptor) => Object.values(descriptor.operations)),
  'listAuditEvents',
  'listAdminCategories',
  'editCategory',
  'listAdminUsers',
  'suspendUser',
  'listAdminJobs',
  'cancelAdminJob',
  'listFlags',
  'setFlag',
  'listFlagAuditEvents',
  'hidePost',
  // R34：库内审计日志只读查询（迁移 0033 的 `public.list_admin_audit_logs()`）。
  'listAuditLogs',
]);
