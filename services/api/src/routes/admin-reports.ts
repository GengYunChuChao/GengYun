/**
 * 社区**举报处置**的后台路由（R72）：`POST /api/v1/admin/reports/{id}/disposition`。
 *
 * ## 为什么单独一个文件
 *
 * `services/api/src/routes/admin.ts` 被 `docs/architecture/**` 按 `path:line` 引用了 108 处
 * （台账 `contract-status.json` 的 evidence 就锚在那儿）。那条文件的任何插行都会让这些
 * 地址整体失准，所以本片把新路由放进新文件，`admin.ts` 只留一句注册调用
 * （挂在 `registerAdminRoutes` 末尾，**不新增行**），既有锚点一个都不动。
 *
 * ## 与 `admin.ts` 的关系
 *
 * 本文件复刻了 `admin.ts` 的三个小工具（`uuidIdParams` / `callerOf` / `send`）——它们的
 * 共同点是**只做形态搬运**，不含任何业务判定（判定在服务层：scope 在
 * `ops/service.ts` 的 `advanceReport`，状态机在 `community/report-state.ts`）。
 * 之所以不 import，是因为 `admin.ts` 没有导出它们，而导出它们会改那个热文件的行数。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentIdentity, type AuthGuards } from '../auth/middleware.ts';
import { API_PREFIX } from '../contract.ts';
import { OPS_SCOPES } from '../admin/ops/service.ts';
import type { AdminOpsService } from '../admin/ops/service.ts';
import type { AdminCallContext, ServiceResponse } from '../admin/types.ts';

/** 路径参数：`{id}` 必须是 uuid（闭集/格式判定在路由层，存在性在服务层）。 */
const uuidIdParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

/** 取请求头原值（可能是重复头的数组）：**形态由服务层判定**，本层不做第二次判定。 */
function rawHeader(request: FastifyRequest, name: string): string | string[] | undefined {
  return request.headers[name];
}

/** 组装服务层调用上下文（身份只来自服务端权威会话，客户端无法通过 body/头声明）。 */
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
    idempotencyKey: rawHeader(request, 'idempotency-key') as string | undefined,
    ifMatch: rawHeader(request, 'if-match') as string | undefined,
  };
}

/** 把服务层返回的响应描述符落盘（状态码/头/契约封套全部来自服务层，本层不改写）。 */
function send(reply: FastifyReply, response: ServiceResponse<unknown>): unknown {
  for (const [name, value] of Object.entries(response.headers)) reply.header(name, value);
  return reply.status(response.status).send(response.body);
}

/** 装配所需依赖：守卫套件与 ops 域（`advanceReport` 在 `OPS_OPERATION_IDS` 里）。 */
export interface AdminReportRouteDeps {
  readonly guards: AuthGuards;
  readonly ops: AdminOpsService;
}

/**
 * 注册举报处置路由。
 *
 * 路径**逐条字面书写**（`${API_PREFIX}/admin/...`）：项目的静态路由清单工具只识别紧跟在
 * `app.<method>(` 之后、且不含未知模板变量的字符串（与 `admin.ts` 同一条纪律）。
 */
export function registerAdminReportRoutes(app: FastifyInstance, deps: AdminReportRouteDeps): void {
  const advanceReport = deps.ops.advanceReport.bind(deps.ops);
  app.post(
    `${API_PREFIX}/admin/reports/:id/disposition`,
    {
      // 两道门：后台会话 + 既有写面 scope（`sources:write`，⛔ 不新造 `reports:*`）。
      preHandler: [deps.guards.requireAdmin, deps.guards.requireScope(OPS_SCOPES.advanceReport)],
      schema: { params: uuidIdParams },
    },
    async (request, reply) =>
      send(reply, await advanceReport(callerOf(request), (request.params as { id: string }).id, request.body)),
  );
}
