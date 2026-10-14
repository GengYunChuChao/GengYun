/**
 * GY-I27 · `services/api` 侧的隐私装配：**授权中间件适配** + **真实外发消费者**（real fail-closed）。
 *
 * ## 为什么单独一个文件
 * `packages/privacy/**` 是纯 ESM 协议层（不 import 任何服务端代码）；HTTP 错误封套、执行模式、
 * 会话身份槽位属于 `services/api`。本文件是两者之间**唯一**的适配点，因此：
 *   - 授权中间件在这里变成 Fastify `preHandler`（把 `PrivacyError` 翻成契约 `ApiError`）；
 *   - 外发消费者在这里按执行模式解析（`real` 未接真实适配器 ⇒ **503 fail-closed**）；
 *   - 本文件**不注册任何路由、不改 `app.ts`**（`app.ts` 属 GY-I02；挂载点见下）。
 *
 * ## 挂载点（装配方按此接线；本片不改他人已合并的路由文件）
 * | 位置 | 挂什么 | 说明 |
 * | --- | --- | --- |
 * | 需要用途授权的执行入口（`/speech/transcriptions`、`/recognitions/**`、`/ocr/**`、`/synthesis/**`、社区投稿入口） | `createConsentPreHandler(guard, { purpose, dataType })` | 放在该路由自己的 `preHandler` 链**之后**（会话先建立 `req.userId` / `req.authEpoch`） |
 * | 任务**执行前** | `createPrivacyInFlightGuard(...).assertExecutable({ exportId, userId })` | 撤回/注销后不得再起新工作 |
 * | 任务**保存前** | `inFlightGuard.saveResult({ exportId, userId, objectVersion, result })` | 回写的实际写入在账本原子临界区内（校验不过 ⇒ 零写入） |
 * | 版本取消 | `inFlightGuard.cancelVersion({ exportId, userId, objectVersion })` | 墓碑只增不减 ⇒ 已取消版本不可被回调复活 |
 * | 撤回/注销的撤销在途 | `createApiEgressRevoker({ ledger })` | `consent-pg.ts` / `grant-pg.ts` 目前以 `OBJECT_UNAVAILABLE` 兜底；注入本对象后可撤掉兜底（**默认不注入 ⇒ 行为与今天逐字一致**） |
 * | 外发派发 | `createPrivacyEgress(...).consumer.send({ identity, ... })` | 无授权/错用途 ⇒ 在预留处被拒；派发前撤回/注销 ⇒ 在原子边界被拒（**零外发**） |
 *
 * ## real 模式红线（监工对 #121 的 P1 口径）
 * `real` 模式下若真实依赖（真实外发适配器）**未真正接入**，必须 **fail-closed**：
 * 契约内 `PROVIDER_UNAVAILABLE` / 503 / `retryable: true`。**不得**用替身实现返回成功封套；
 * 替身只允许出现在明确标注的 `stub` / `preset_demo`。将来接真实后端必须在装配处
 * **显式放行**（`realTransportApproved: true` + 注入已审适配器），不靠自述自动启用。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  createEgressConsumer,
  resolveEgressTransport,
  type EgressConsumer,
  type EgressTransport,
} from '../../../../packages/privacy/egress.mjs';
import { createEgressRevoker, createInFlightGuard, type EgressRevoker, type InFlightGuard } from '../../../../packages/privacy/in-flight.mjs';
import { createDeletionCoordinator, type DeletionCoordinator } from '../../../../packages/privacy/deletion-modules.mjs';
import { ApiError } from '../errors.ts';
import { isErrorCode, type ExecutionMode } from '../contract.ts';

type ContractCodeError = {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
  details?: unknown;
};

/**
 * `PrivacyError` → 契约 `ApiError`。
 *
 * - 契约错误码（`error_status_map` 成员）**原样保留**状态与 `retryable`；
 * - 非同契约错误返回 `null`（调用方如实 500，**不伪造**契约错误码，也不透出原始 message —
 *   原始 message 可能含私有正文/坐标/凭据或第三方 SDK 嵌套原文）。
 */
export function toApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  const candidate = (error ?? {}) as ContractCodeError;
  const code = candidate?.code;
  if (typeof code !== 'string' || !isErrorCode(code)) return null;
  const message =
    candidate?.name === 'PrivacyError' && typeof candidate.message === 'string' && candidate.message.length > 0
      ? candidate.message.slice(0, 200)
      : '隐私守卫拒绝了该请求';
  const details = Array.isArray(candidate.details)
    ? candidate.details
        .slice(0, 30)
        .filter((item): item is { field: string; code: string } => {
          const row = item as { field?: unknown; code?: unknown };
          return typeof row?.field === 'string' && typeof row?.code === 'string';
        })
    : [];
  return new ApiError(code, message, {
    retryable: candidate?.retryable === true,
    details,
  });
}

/**
 * 授权中间件（Fastify `preHandler`）：**已认证执行入口**。
 *
 * 身份上下文来自会话层填充的 `request.userId` / `request.authEpoch`（只来自服务端存储）；
 * 缺 `authEpoch` ⇒ `SESSION_REQUIRED`(401)，非正整数 ⇒ `INVALID_REQUEST`(400)，
 * 账号非活跃/旧版本 ⇒ `ACCOUNT_INACTIVE`(403)，未授权 ⇒ `CONSENT_REQUIRED`(403)，
 * 错用途 ⇒ `SCOPE_DENIED`(403)。**系统麦克风/定位权限不能替代用途授权。**
 */
export function createConsentPreHandler(
  guard: { requireConsent(input: { purpose: string; dataType?: string }): (identity: { userId: string | null; authEpoch: number | null }) => Promise<unknown> },
  requirement: { purpose: string; dataType?: string },
): (request: FastifyRequest) => Promise<void> {
  const middleware = guard.requireConsent(requirement);
  return async function privacyConsentPreHandler(request: FastifyRequest): Promise<void> {
    try {
      await middleware({
        userId: (request as { userId?: string | null }).userId ?? null,
        authEpoch: (request as { authEpoch?: number | null }).authEpoch ?? null,
      });
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError) throw apiError;
      throw error;
    }
  };
}

/**
 * 路由处理包装：把**协议层**的 `PrivacyError` 翻成契约 `ApiError`。
 *
 * 真实装配中，调用 `consumer.send(...)` / `inFlightGuard.saveResult(...)` 的路由必须经这一层，
 * 否则协议错误会冒泡成 **500**（如实但没有契约错误码）。本包装只转换契约错误码，
 * 非契约错误**原样冒泡**（不伪造错误码）。
 */
export function withPrivacyErrors(
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async function privacyErrorTranslated(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
    try {
      return await handler(request, reply);
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError) throw apiError;
      throw error;
    }
  };
}

export interface PrivacyEgressAssembly {
  readonly executionMode: ExecutionMode;
  readonly consumer: EgressConsumer;
  readonly transportKind: string;
  /** false ⇒ real 模式未接真实适配器：任何派发都会在账本变更前 503。 */
  readonly available: boolean;
  readonly note: string | null;
  readonly unavailableReason: string | null;
  /** 是否处于「real 且未接真实外发」的 fail-closed 状态（供健康检查/证据页如实披露）。 */
  readonly realUnwired: boolean;
}

/**
 * 组装外发消费者。
 *
 * `real` 模式**只有**在 `realTransportApproved === true` 且注入了已审真实传输时才可能发出真实请求；
 * 否则返回 fail-closed 消费者（`available=false`）——它连账本都不会改（不标记 sent、不落库），
 * 因此**不可能**出现"替身返回成功封套"。`logSink` 收到的是已脱敏的审计条目（不含私有负载）。
 */
export function createPrivacyEgress(input: {
  executionMode: ExecutionMode;
  ledger: Record<string, unknown>;
  realTransport?: EgressTransport | null;
  realTransportApproved?: boolean;
  logSink?: ((entry: Record<string, unknown>) => void) | null;
  now?: () => Date;
}): PrivacyEgressAssembly {
  const transport = resolveEgressTransport({
    executionMode: input.executionMode,
    realTransport: input.realTransport ?? null,
    realTransportApproved: input.realTransportApproved === true,
  });
  const consumer = createEgressConsumer({
    ledger: input.ledger,
    transport,
    executionMode: input.executionMode,
    logSink: input.logSink ?? null,
    now: input.now,
  });
  return Object.freeze({
    executionMode: input.executionMode,
    consumer,
    transportKind: consumer.transportKind,
    available: consumer.available,
    note: consumer.note,
    unavailableReason: consumer.unavailableReason,
    realUnwired: input.executionMode === 'real' && !consumer.available,
  });
}

/** 在途守卫（执行前/保存前重查 + 版本取消墓碑）。 */
export function createPrivacyInFlightGuard(input: {
  ledger: Record<string, unknown>;
  account: { stateOf(userId: string): Promise<string>; authEpochOf(userId: string): Promise<number> };
  consentStore: {
    isGranted(value: Record<string, unknown>): Promise<boolean>;
    currentEpoch(value: Record<string, unknown>): Promise<number>;
  };
  now?: () => Date;
}): InFlightGuard {
  return createInFlightGuard(input);
}

/** 撤回/注销的撤销在途消费者（供 `consent-pg.ts` / `grant-pg.ts` 注入；不注入即维持 fail-closed 兜底）。 */
export function createApiEgressRevoker(input: { ledger: Record<string, unknown>; now?: () => Date }): EgressRevoker {
  return createEgressRevoker(input);
}

/** 全模块删除注册协议（必需模块闭集 + 契约形状回执；完整 7/30 日集成属 GY-I19）。 */
export function createPrivacyDeletionCoordinator(input: {
  registry: Record<string, unknown>;
  requiredModules: string[];
  now?: () => Date;
}): DeletionCoordinator {
  return createDeletionCoordinator(input);
}
