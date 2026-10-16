/**
 * GY-I19（#19）决策包 A 第 2 步 · **注销（账号删除）HTTP 路由**（两 operation，逐字对应契约）。
 *
 * | 契约（`packages/contracts/openapi.json`） | operationId | 鉴权 | 成功 |
 * | --- | --- | --- | --- |
 * | `POST /me/account/deletion`（openapi.json:1514） | `requestAccountDeletion` | `userSession` | 202 `DeletionAcceptedEnvelope` |
 * | `GET /account/deletions/{id}`（openapi.json:1609） | `getDeletionReceipt` | `deletionReceipt` | 200 `DeletionReceiptEnvelope` |
 *
 * ## 照抄既有同类路由（不新造模式）
 * 守卫/schema/封套写法取自 `routes/consents.ts`（`guards.requireUser` + `Idempotency-Key` 校验 +
 * `no-store` + 强 `ETag`）与 `routes/favorites.ts`（`readIdentity` + `ApiError` 映射）；
 * 幂等走**既有** `routes/support.ts::runIdempotent()`（24h 台账；命中同键同体**重新签发**而非回放旧响应）。
 *
 * ## 逐条对齐契约口径（不得放宽）
 * - `POST`：`Idempotency-Key` **required**（8..128）⇒ 缺失/非法 `IDEMPOTENCY_KEY_REQUIRED`(400)；
 *   请求体 `DeleteInput` 的 `confirmation` 是 `const "delete_account"` ⇒ 其余取值 400
 *   （`additionalProperties: false` + `required: ['confirmation']`，由 Ajv 直接拒）；
 *   成功 **202**（"受理异步任务，尚未完成"）+ `ETag: "<revision>"` + `Cache-Control: no-store`。
 * - `GET`：鉴权是专用 `deletionReceipt` bearer（**非登录会话**，`securitySchemes.deletionReceipt`
 *   逐字："单注销请求最小进度查询，非登录会话"）⇒ 本路由**不挂** `guards.requireUser`：
 *   用户会话令牌不是回执 bearer，用它查回执一律 401（状态协议 `docs/architecture/state-contract.md:107`
 *   逐字："不允许用户session代替"）。回执只显示进度/期限/最小失败码，无账号与媒体信息。
 * - **「已受理」绝不写成「已删除」**：202 如实回 `state: 'blocked'`（未接线的备份阶段恒 `pending`
 *   ⇒ 该请求此刻确实无法完成）；`completed` **只能**在全模块在线与备份证据齐备时出现。
 * - **未装配**：`service`/`receipts`/`deletion` 任一为 `null` ⇒ 两个 operation 都在**任何状态变更之前**
 *   抛 `PROVIDER_UNAVAILABLE`(503, `retryable: true`)，**不**回 200 空壳、**不**假装删除成功。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import type { AuthGuards } from '../auth/middleware.ts';
import type { AuthService } from '../auth/service.ts';
import { readIdentity } from '../auth/middleware.ts';
import { mintOpaqueToken, readBearerToken } from '../auth/tokens.ts';
import { API_PREFIX, isErrorCode } from '../contract.ts';
import { ApiError } from '../errors.ts';
import {
  ACCOUNT_DELETION_UNAVAILABLE_MESSAGE,
  projectReceipt,
  type AccountDeletionRequestService,
  type DeletionReceiptRegistry,
} from '../privacy/account-deletion.ts';
import type { UserDataDeletionRegistry } from '../privacy/user-data-deletion.ts';
import { buildMeta, runIdempotent } from './support.ts';

const noStore = { 'Cache-Control': 'no-store' } as const;

/** 契约 `DeleteInput`：`confirmation` 为 `const "delete_account"`，且 `additionalProperties: false`。 */
const deleteInput = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmation'],
  properties: { confirmation: { const: 'delete_account' } },
} as const;

/** 契约 `GET /account/deletions/{id}` 的 `id` 为 `format: uuid`。 */
const receiptParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const emptyQuery = { type: 'object', additionalProperties: false, properties: {} } as const;

export interface AccountDeletionRoutesDeps {
  /** 注销申请服务；`null` ⇒ 整域未装配（两个 operation 一律 503，不注册任何回退）。 */
  service: AccountDeletionRequestService | null;
  /** 回执 bearer 台账（与 `service` 同一次装配产出；`null` ⇒ 同上 503）。 */
  receipts: DeletionReceiptRegistry | null;
  /** 已装配的删除注册表（`app.userDataDeletion`）；`null` ⇒ 同上 503。 */
  deletion: UserDataDeletionRegistry | null;
  /** 幂等台账（`app.authService`）。 */
  authService: AuthService;
  now: () => Date;
}

/**
 * 把**带契约错误码**的异常（`PrivacyError` / 已装配的 `ApiError`）翻成契约 `ApiError`。
 * 非同契约错误**原样冒泡**（如实 500，不伪造契约错误码、不透出原始 message）。
 */
function toContractError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !isErrorCode(code)) return error;
  const raw = (error as { message?: unknown }).message;
  const message = typeof raw === 'string' && raw.length > 0 ? raw.slice(0, 200) : '注销删除请求被拒绝';
  return new ApiError(code, message, { retryable: (error as { retryable?: unknown }).retryable === true });
}

/** 台账里只存**不含凭据**的结果引用：删除请求 id（回放据此重新签发，不回放旧 bearer）。 */
function readOutcomeDeletionId(outcome: unknown): string | null {
  const candidate = (outcome ?? {}) as { deletion_id?: unknown };
  return typeof candidate.deletion_id === 'string' && candidate.deletion_id.length > 0 ? candidate.deletion_id : null;
}

interface WiredDeletion {
  service: AccountDeletionRequestService;
  receipts: DeletionReceiptRegistry;
  deletion: UserDataDeletionRegistry;
}

/**
 * 注册注销 HTTP 面的两个 operation。
 *
 * 装配层（`app.ts`）负责建 `service`/`receipts`/`deletion`；本函数只负责路由语义与错误映射。
 */
export function registerAccountDeletionRoutes(
  app: FastifyInstance,
  config: AppConfig,
  guards: AuthGuards,
  deps: AccountDeletionRoutesDeps,
): void {
  const routePath = `${API_PREFIX}/me/account/deletion`;

  /** 未装配 ⇒ 503（fail-closed）。**先判**，保证未装配时零状态变更。 */
  function requireWired(): WiredDeletion {
    if (deps.service === null || deps.receipts === null || deps.deletion === null) {
      throw new ApiError('PROVIDER_UNAVAILABLE', ACCOUNT_DELETION_UNAVAILABLE_MESSAGE, {
        retryable: true,
      });
    }
    return { service: deps.service, receipts: deps.receipts, deletion: deps.deletion };
  }

  app.post(
    routePath,
    {
      preHandler: guards.requireUser,
      schema: { querystring: emptyQuery, body: deleteInput },
    },
    async (request, reply) => {
      const wired = requireWired();
      const userId = readIdentity(request).userId;
      await runIdempotent({
        request,
        reply,
        service: deps.authService,
        subject: userId,
        method: 'POST',
        routePath,
        now: deps.now,
        produce: async () => {
          // 明文回执 bearer 只在这里出现一次（既有协议只存 sha256 摘要 `<request>.receiptHash`）。
          const accepted = await wired.service.request({ userId, receiptInput: mintOpaqueToken() });
          const deletion = accepted.deletion;
          return {
            status: 202,
            body: { data: accepted, meta: buildMeta(request, config) },
            idempotencyOutcome: { deletion_id: String(deletion['id']) },
            etag: `"${String(deletion['revision'])}"`,
            cacheControl: 'no-store',
          };
        },
        replay: async (record) => {
          const deletionId = readOutcomeDeletionId(record.outcome);
          const receipt = deletionId === null ? null : wired.deletion.receipt(deletionId);
          const projected = projectReceipt(receipt);
          if (deletionId === null || projected === null) {
            // 台账引用的删除请求已不可达（进程内台账随重启清空）⇒ 如实 409，不编造回执。
            throw new ApiError('OBJECT_UNAVAILABLE', '注销删除请求已不可达（进程内台账已失效）');
          }
          const issued = wired.receipts.issue(deletionId);
          return {
            status: 202,
            body: {
              data: { receipt_token: issued.token, receipt_expires_at: issued.expiresAt, deletion: projected },
              meta: buildMeta(request, config),
            },
            idempotencyOutcome: { deletion_id: deletionId },
            etag: `"${String(projected['revision'])}"`,
            cacheControl: 'no-store',
          };
        },
      }).catch((error: unknown) => {
        throw toContractError(error);
      });
    },
  );

  app.get(
    `${API_PREFIX}/account/deletions/:id`,
    {
      // 鉴权 = 专用回执 bearer（**不是**用户会话）：故此处**不挂** `guards.requireUser`。
      schema: { params: receiptParams, querystring: emptyQuery },
    },
    async (request, reply) => {
      const wired = requireWired();
      const token = readBearerToken(request.headers.authorization);
      if (token === null) throw new ApiError('SESSION_REQUIRED', '需要注销回执 bearer');
      const id = (request.params as { id: string }).id;
      const boundId = wired.receipts.resolveRequestId(token);
      // 未知 / 已过期 / 已换发 / 跨请求使用：一律按「凭据不可用」如实拒绝，不泄露该 id 是否存在（防探测）。
      if (boundId === null || boundId !== id) throw new ApiError('SESSION_EXPIRED', '注销回执凭据已失效');
      const receipt = wired.deletion.receipt(id);
      const projected = projectReceipt(receipt);
      if (projected === null) throw new ApiError('NOT_FOUND', '注销删除请求不存在');
      return reply
        .headers(noStore)
        .header('ETag', `"${String(projected['revision'])}"`)
        .send({ data: projected, meta: buildMeta(request, config) });
    },
  );
}

/** 只读诊断：本次请求是否携带 bearer（不读值、不写日志；供集成脚本的对照臂使用）。 */
export function hasBearerCredential(request: FastifyRequest): boolean {
  return readBearerToken(request.headers.authorization) !== null;
}
