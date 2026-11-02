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
 * ## 刻意**不做**的三件事（见证据页与契约 description）
 *
 * 1. **不落审计行**：要审计得新增迁移 + `admin/audit/catalog.ts` 的 `AUDIT_ACTIONS` 闭集 +
 *    两处 SQL 的列级授权同步，属迁移片，另批；
 * 2. **不改社区可见性**：处置只推进举报状态，不串帖子的下架链路；
 * 3. **不区分「成立」与「驳回」**：`closed` 一值两义（`report-state.ts:28-31` 已登记为
 *    已知弱化），要反查结论得加列 ⇒ 迁移，另批。
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

/** 举报处置端口（未接线与否由 `wired` 如实暴露，供装配期日志与用例断言）。 */
export interface ReportDispositionPort {
  readonly wired: boolean;
  advance(reportId: string, input: unknown): Promise<ReportDispositionResult>;
}

/**
 * 端口背后的真实来源：只要一个方法。
 *
 * 不用 `Pick<CommunityStore, ...>`：举报的写路径不在 store 上（`insertReport` /
 * `commitReportIfCurrent` 是它的两支），而在 `CommunityService.advanceReport`
 * ——那里已经封装了「查当前态 → 规划转移 → CAS → 投影」的整段语义。
 */
export interface ReportDispositionSource {
  advanceReport(reportId: unknown, input: unknown): Promise<Report>;
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
    async advance(reportId: string, input: unknown): Promise<ReportDispositionResult> {
      // 404 / 409 / 400 由社区域原样抛出：本层**不重映射**，避免两套话术漂移。
      const report = await source.advanceReport(reportId, input);
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
      const outcome = await port.advance(normalizedId, body);
      if (!outcome.ok) throw new ApiError('PROVIDER_UNAVAILABLE', '社区举报存储尚未接线', { retryable: false });
      // 成功 = 处置后的 `Report` 原样进出，`ETag` 取新的 revision（强 ETag）。
      return singleResponse(context, deps.executionMode, 200, outcome.report, etagOf(outcome.report.revision));
    },
  );
}
