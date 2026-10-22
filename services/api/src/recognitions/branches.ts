/**
 * GY-I09 识别任务的**六类失败与边界分支**（issue #9 范围第 2 条）：
 *   不确定 / 覆盖外·低质量 / 权限拒绝 / 无结果 / 超时 / 重拍。
 *
 * 本文件是这六类的**唯一闭集**（唯一事实来源），并给出每一类在**冻结契约内**的
 * 落点与**可重试语义** —— 派单原文：「每个分支要有明确状态与可重试语义」。
 *
 * 契约对齐（只读消费，不新增契约字段/路径）：
 *   - 任务终态只有 `JobState` 的 7 个枚举成员（`packages/contracts/states.json`）；
 *     六类分支并不各占一个状态，而是**共用** `uncertain` / `timed_out` / HTTP 403：
 *       · 不确定、覆盖外·低质量、无结果、重拍 → `uncertain`（**不得**落 succeeded）；
 *       · 超时 → `timed_out` + `error_code=PROVIDER_TIMEOUT`；
 *       · 权限拒绝 → **受理前** 403 `CONSENT_REQUIRED`，**不创建任务、不产生识别记录**
 *         （授权中间件 `createConsentPreHandler` 已在 `POST /recognitions` 前拦截）。
 *   - 「有明确状态」因而含义是：**每一类都能被客户端唯一判定**，且判定所需信息
 *     （`state` / `error_code` / `uncertainty_reasons`）都在契约封套里。
 *
 * 严格禁止：把任何一类写成 `succeeded`，或为凑「六类」而新增契约外状态/路径。
 */

import type { ErrorCode } from '../contract.ts';
import type { JobState } from './state.ts';

/**
 * 六类分支的机器可读标识（闭集；新增分支必须同时补齐 `BRANCH_DESCRIPTORS`
 * 与 `decideOutcome` 的映射，`tsc` 的穷尽性检查会拦下漏项）。
 */
export const FAILURE_BRANCHES = [
  /** 不确定：模型自述不确定 / 分数缺失 / 分数低于可信门槛。 */
  'uncertain',
  /** 覆盖外·低质量：对象不在覆盖范围，或照片模糊/遮挡/过暗导致不可判。 */
  'out_of_coverage_or_low_quality',
  /** 权限拒绝：用途授权被撤回/缺失，或账号会话失效（**受理前**拦截）。 */
  'permission_denied',
  /** 无结果：正常调用但没有任何候选。 */
  'no_result',
  /** 超时：超过任务截止时间仍未完成。 */
  'timeout',
  /** 重拍：给出候选但拍摄条件不合格，需重新拍摄才能继续。 */
  'reshoot_required',
] as const;
export type FailureBranch = (typeof FAILURE_BRANCHES)[number];

/** 客户端在收到该分支后的**唯一**重试动作（闭集，不给出多余选项）。 */
export const RETRY_ACTIONS = [
  /** 换一张照片/换个角度重拍后新建任务（幂等键必须更换）。 */
  'reshoot',
  /** 原样重试：新建任务（原任务的幂等键已用尽，收敛语义不允许复活终态）。 */
  'new_task',
  /** 先补齐用途授权，再重试同一入口。 */
  'grant_consent',
  /** 先恢复会话（重新登录），再重试。 */
  'reauthenticate',
] as const;
export type RetryAction = (typeof RETRY_ACTIONS)[number];

export interface BranchDescriptor {
  branch: FailureBranch;
  /** 面向用户的一句话（不作绝对承诺、不出现禁用标签）。 */
  label: string;
  /** 契约内任务终态；`null` = 受理前拦截，**不存在**任务（因而不落任何 JobState）。 */
  jobState: JobState | null;
  /** 契约内错误码；`null` = 只靠 `state` + `uncertainty_reasons` 表达。 */
  errorCode: ErrorCode | null;
  /**
   * 是否给出客户端恢复入口（为 `true` 时必须同时给出 {@link retryAction}）。
   *
   * ⚠️ 本字段**不是**错误封套 `Error.retryable` 的口径（口径原文见 `services/api/src/errors.ts` 的
   * `ApiError` 注释：仅当**同一请求在无人工介入下**稍后重试可能成功才为 `true`）。这里的 `true`
   * 只表示「页面上有一个恢复入口」；`requiresHumanAction` 为 `true` 的分支（`permission_denied`）
   * 需要**人先改前置条件**（补授权／重新登录），因此：
   *   · 客户端**不得**据此自动重试，必须等人点那一颗按钮；
   *   · 调度器/服务端**不得**把本字段写进错误封套（`CONSENT_REQUIRED` 等缺口一律 `retryable:false`）。
   */
  retryable: boolean;
  /** 可重试时的唯一重试动作；不可重试时为 `null`。 */
  retryAction: RetryAction | null;
  /**
   * 该恢复入口是否**先需人工介入**（`grant_consent`／`reauthenticate` ⇒ `true`）。
   * 与 `retryable` 分开建模，避免「有恢复入口」被误读成「自动重试可能成功」。
   */
  requiresHumanAction: boolean;
  /**
   * 服务端写出的**如实**原因（进 `uncertainty_reasons`）。
   * `null` 表示该分支不通过 `uncertainty_reasons` 表达（超时/权限拒绝）。
   */
  reason: string | null;
}

/**
 * 覆盖范围/画质类分支上报时的**如实原因**（`uncertainty_reasons` 的 items 上限 80 字符）。
 * 这里只承载「为什么不可判」，**不承载任何物种猜测**（不补造候选）。
 */
export const COVERAGE_REASON_OUT_OF_SCOPE = '拍摄对象不在当前覆盖范围内';
export const COVERAGE_REASON_LOW_QUALITY = '照片模糊/遮挡/光照不足，无法可靠判定';
export const COVERAGE_REASON_RESHOOT = '拍摄条件不合格，建议重新拍摄';

/** 覆盖外·低质量分支的细分（仍是同一分支，不新增 JobState）。 */
export const COVERAGE_REASONS = [
  COVERAGE_REASON_OUT_OF_SCOPE,
  COVERAGE_REASON_LOW_QUALITY,
  COVERAGE_REASON_RESHOOT,
] as const;

/**
 * 六类分支的完整描述符（**唯一事实来源**）。
 *
 * `permission_denied` 的 `jobState` 为 `null`：授权中间件在 `preHandler` 阶段抛错，
 * 请求在创建任何任务之前就被拒绝，因此**不存在**可读的任务状态 —— 硬把它写成
 * `failed` 会凭空造出一个任务（本片禁止）。
 */
export const BRANCH_DESCRIPTORS: Readonly<Record<FailureBranch, BranchDescriptor>> = Object.freeze({
  uncertain: Object.freeze({
    branch: 'uncertain',
    label: '结果不确定：候选仅供参考，需人工核对',
    jobState: 'uncertain',
    errorCode: null,
    retryable: true,
    retryAction: 'new_task',
    requiresHumanAction: false,
    reason: null,
  }),
  out_of_coverage_or_low_quality: Object.freeze({
    branch: 'out_of_coverage_or_low_quality',
    label: '该对象不在覆盖范围内，或照片质量不足无法判定',
    jobState: 'uncertain',
    errorCode: null,
    retryable: true,
    retryAction: 'reshoot',
    requiresHumanAction: false,
    reason: COVERAGE_REASON_OUT_OF_SCOPE,
  }),
  permission_denied: Object.freeze({
    branch: 'permission_denied',
    label: '尚未获得该用途的授权，或会话已失效',
    jobState: null,
    errorCode: 'CONSENT_REQUIRED',
    // 恢复入口保留（页面靠它渲染「去授权」那颗按钮：`miniprogram/pages/identify/identify.wxml:76`
    // 与 `:334` 都按 `branchInfo.retryable` 出按钮/文案），但**必须先由人补授权或重新登录** ⇒
    // `requiresHumanAction: true`，任何自动重试都不得据此触发（R31-S-retryable 口径裁决）。
    retryable: true,
    retryAction: 'grant_consent',
    requiresHumanAction: true,
    reason: null,
  }),
  no_result: Object.freeze({
    branch: 'no_result',
    label: '本次未取得任何候选',
    jobState: 'uncertain',
    errorCode: null,
    retryable: true,
    retryAction: 'reshoot',
    requiresHumanAction: false,
    reason: null,
  }),
  timeout: Object.freeze({
    branch: 'timeout',
    label: '识别超时：超过任务截止时间仍未完成',
    jobState: 'timed_out',
    errorCode: 'PROVIDER_TIMEOUT',
    retryable: true,
    retryAction: 'new_task',
    requiresHumanAction: false,
    reason: null,
  }),
  reshoot_required: Object.freeze({
    branch: 'reshoot_required',
    label: '需要重新拍摄后才能继续',
    jobState: 'uncertain',
    errorCode: null,
    retryable: true,
    retryAction: 'reshoot',
    requiresHumanAction: false,
    reason: COVERAGE_REASON_RESHOOT,
  }),
});

export function isFailureBranch(value: unknown): value is FailureBranch {
  return typeof value === 'string' && (FAILURE_BRANCHES as readonly string[]).includes(value);
}

export function describeBranch(branch: FailureBranch): BranchDescriptor {
  return BRANCH_DESCRIPTORS[branch];
}

/**
 * 覆盖外·低质量的细分原因 → 分支内的**如实原因文本**。
 * 未知明细一律回落到低质量（保守），**不**推导出任何候选或分数。
 */
export function coverageReasonFor(detail: string | undefined): string {
  if (detail === 'out_of_scope') return COVERAGE_REASON_OUT_OF_SCOPE;
  if (detail === 'low_quality') return COVERAGE_REASON_LOW_QUALITY;
  if (detail === 'reshoot') return COVERAGE_REASON_RESHOOT;
  return COVERAGE_REASON_LOW_QUALITY;
}

/**
 * 分支的**契约内落点**：HTTP 层不可达的那一类（`permission_denied`）没有任务状态，
 * 调用方必须据此走「受理前拦截」路径，而不是伪造一个任务。
 */
export function branchCreatesJob(branch: FailureBranch): boolean {
  return BRANCH_DESCRIPTORS[branch].jobState !== null;
}

/**
 * 分支的可重试语义（供路由/客户端声明 `Retry-After` 语义与页面重试入口）。
 * 返回 `retryable:false` 时调用方**不得**给出重试入口；返回 `requiresHumanAction:true` 时
 * 调用方**只能**把恢复交给用户（补授权/重新登录），⛔ 不得自动重试、不得写进错误封套的 `retryable`。
 */
export function retrySemanticsFor(branch: FailureBranch): {
  retryable: boolean;
  retryAction: RetryAction | null;
  requiresHumanAction: boolean;
} {
  const descriptor = BRANCH_DESCRIPTORS[branch];
  return {
    retryable: descriptor.retryable,
    retryAction: descriptor.retryAction,
    requiresHumanAction: descriptor.requiresHumanAction,
  };
}
