/**
 * 社区**举报处置**写面（R72）：`POST /admin/reports/{id}/disposition` ⇒ `advanceReport`。
 *
 * ## 为什么单独一个文件
 *
 * 本片是**接线**，不是实现：转移表是 `community/report-state.ts`（纯函数，唯一权威），
 * 入参校验是 `community/validate.ts` 的 `validateReportDispositionInput`，CAS 落库是
 * `community/store.ts` 的 `commitReportIfCurrent`，服务入口是
 * `community/service.ts` 的 `advanceReport(reportId, input)`。**本文件不重算状态机、
 * 不重写错误话术**：所有 400 / 404 / 409 都由社区域原样抛出，本层只做三件事——
 * 判后台 scope、判 `id` 形态、把结果包进后台的单资源封套（强 ETag + `no-store`）。
 *
 * 唯一的失败是本层自己的：社区存储未接线（`source === undefined`）⇒ 503
 * `PROVIDER_UNAVAILABLE`（`retryable: false`），与同类写 op 的未接线口径一致。
 *
 * ## 操作留痕（R72 · 迁移 0053）
 *
 * 本层**不写**审计行，但把「谁、哪次请求」如实交给社区域：`actorId` 取
 * `context.identity.userId`（服务端权威会话，⛔ 不接受调用方自报），`requestId` 取
 * `context.requestId`。真库实现在**举报处置的同一个事务**里写一行
 * `report.{triage|resolve|reject}` 审计（`community/store-pg.ts` 的 `commitReport`），
 * 审计写不进去 ⇒ 整笔回滚 ⇒ 本层如实抛 503（`PROVIDER_UNAVAILABLE`，`retryable: false`），
 * ⛔ 不假成功。读面闭集随本片扩三值（`report.triage` / `report.resolve` / `report.reject`，见
 * `admin/audit/catalog.ts` 与契约 `AuditAction`）⇒ `GET /admin/audit-logs?action=` 能把三种处置
 * 单独筛出来；`?entity=` 仍没有 `report` 取值（举报不是六个实体之一）。
 *
 * ## 刻意**不做**的两件事（见证据页与契约 description）
 *
 * 1. **不改社区可见性**：处置只推进举报状态，不串帖子的下架链路；
 * 2. **不区分「成立」与「驳回」的 `state` 取值**：`closed` 一值两义（`report-state.ts:27-31`
 *    已登记为已知弱化）；二者的区分**只**落在审计行的 `action`（`report.resolve` /
 *    `report.reject`）上——那正是本次留痕要解决的问题，⛔ 不再靠"以后再补"。
 */

import { ApiError } from '../../errors.ts';
import { etagOf, normalizeIdParam, resolveContext, singleResponse } from '../identity.ts';
import { runIdempotentWrite, type IdempotentWriteDeps } from '../idempotent-write.ts';
import type { AdminCallContext, ServiceResponse } from '../types.ts';
import type { ExecutionMode } from '../../contract.ts';
import type { Report } from '../../community/types.ts';
import type { SingleEnvelope } from './service.ts';

/**
 * 本 op 的门（与 `OPS_SCOPES.advanceReport` 逐字相同）。
 *
 * 这里再写一遍字面量，是为了让本文件**不**反向 import `./service.ts` 的值（那会形成
 * 运行时环：`service.ts` 需要本文件的 `advanceReportImpl`）。判定本身仍只有一道：
 * `resolveContext` 的 scope 检查（`sources:write` 既有的写面门，⛔ 不新造 `reports:*`）。
 */
export const ADVANCE_REPORT_SCOPE = 'sources:write';

/** 处置结果：成功带处置后的 `Report`；唯一失败是「社区存储未接线」。 */
export type ReportDispositionResult =
  | { readonly ok: true; readonly report: Report }
  | { readonly ok: false; readonly reason: 'STORE_UNAVAILABLE' };

/** 举报处置的操作留痕上下文（迁移 0053：写入行由库侧窄函数校验并落 `admin_audit_events`）。 */
export interface ReportDispositionAuditContext {
  /** 操作者（服务层传 `context.identity.userId`，⛔ 不接受调用方自报）。 */
  readonly actorId: string;
  /** 请求 id（服务层传 `context.requestId`，用于把审计行与请求对齐）。 */
  readonly requestId: string;
}

/** 举报处置端口（未接线与否由 `wired` 如实暴露，供装配期日志与用例断言）。 */
export interface ReportDispositionPort {
  readonly wired: boolean;
  advance(reportId: string, input: unknown, audit: ReportDispositionAuditContext): Promise<ReportDispositionResult>;
}

/**
 * 端口背后的真实来源：只要一个方法。
 *
 * 不用 `Pick<CommunityStore, ...>`：举报的写路径不在 store 上（`insertReport` /
 * `commitReportIfCurrent` 是它的两支），而在 `CommunityService.advanceReport`
 * ——那里已经封装了「查当前态 → 规划转移 → CAS → 投影」的整段语义。
 *
 * 第 3 个参数是操作留痕上下文（迁移 0053）：**必填**，防止有人新增调用点时"顺手"丢掉审计
 * （那样处置仍会成功、却没有任何留痕——正是本片要消灭的状态）。
 */
export interface ReportDispositionSource {
  advanceReport(reportId: unknown, input: unknown, audit: ReportDispositionAuditContext): Promise<Report>;
}

/** 未接线 ⇒ 冻结的 503 替身（`advance` 从不抛，由调用点翻译成 503）。 */
export function createReportDispositionAdapter(source: ReportDispositionSource | undefined): ReportDispositionPort {
  if (source === undefined) {
    const unwired: ReportDispositionPort = {
      wired: false,
      advance: async (): Promise<ReportDispositionResult> => ({ ok: false, reason: 'STORE_UNAVAILABLE' }),
    };
    return Object.freeze(unwired);
  }
  const wired: ReportDispositionPort = {
    wired: true,
    async advance(reportId: string, input: unknown, audit: ReportDispositionAuditContext): Promise<ReportDispositionResult> {
      // 404 / 409 / 400 由社区域原样抛出：本层**不重映射**，避免两套话术漂移。
      const report = await source.advanceReport(reportId, input, audit);
      return { ok: true, report };
    },
  };
  return Object.freeze(wired);
}

/** 实现所需的注入面（全部来自 `createAdminOpsService` 的闭包，不新增选项）。 */
export interface AdvanceReportDeps {
  readonly source: ReportDispositionSource | undefined;
  readonly writeDeps: IdempotentWriteDeps;
  readonly executionMode: ExecutionMode;
}

/**
 * `advanceReport` 的实现体。
 *
 * 形状照同类写 op（`hidePost` / `commitPostReview`）：`resolveContext` 判门 →
 * `normalizeIdParam` 判 `id` 形态 → `runIdempotentWrite` 包幂等（`Idempotency-Key` 必填，
 * 缺键 400、同键异体 409、进行中 409）→ 端口 → 单资源封套。
 *
 * **刻意不**读 `If-Match`：本 op 的版本前置条件是 body 里的 `expected_revision`
 * （契约 `x-version-required: false`）。理由见 `packages/contracts/openapi.json` 的
 * description：`advanceReport` 的入参类型与 `validateReportDispositionInput` 都已冻结，
 * 改成 header 口径要同时改这两处签名；body 口径下 `expected_revision` 仍逐字进 CAS，
 * 「落后一拍」照样 409 且库内一字不变。
 */
export async function advanceReportImpl(
  deps: AdvanceReportDeps,
  ctx: AdminCallContext,
  id: string,
  body: unknown,
): Promise<ServiceResponse<SingleEnvelope<Report>>> {
  const context = resolveContext(ctx, ADVANCE_REPORT_SCOPE);
  const normalizedId = normalizeIdParam(id);
  const port = createReportDispositionAdapter(deps.source);
  return runIdempotentWrite(
    deps.writeDeps,
    context,
    // 幂等键域用**真实 id**：不同举报不会互相串键。
    { method: 'POST', path: `/admin/reports/${normalizedId}/disposition`, expectedStatus: 200 },
    body,
    async () => {
      const outcome = await port.advance(normalizedId, body, {
        actorId: context.identity.userId,
        requestId: context.requestId,
      });
      if (!outcome.ok) throw new ApiError('PROVIDER_UNAVAILABLE', '社区举报存储尚未接线', { retryable: false });
      // 成功 = 处置后的 `Report` 原样进出，`ETag` 取新的 revision（强 ETag）。
      return singleResponse(context, deps.executionMode, 200, outcome.report, etagOf(outcome.report.revision));
    },
  );
}
