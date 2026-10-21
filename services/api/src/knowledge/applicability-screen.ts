/**
 * GY-I08 · 「可执行建议／用量卡」的**服务端装配层**（issue #8 验收第 2 条）。
 *
 * 职责边界：
 *   1. **判定不在这里**：禁限用、作物、生育期、地区、制剂、含量剂型、使用场景、有效来源的判定
 *      全部在 `packages/reference/deterministic.mjs`（规则版本 `gy-i08/1.2.0`，纯函数）。
 *      本文件只做装配：调域库 → 把阻断类别映射成**契约已登记**的错误码 → 交给既有
 *      `ApiError` / `buildErrorEnvelope` 出 4xx 封套。
 *   2. **绝不静默放过**：`block_codes` 非空时，`status` 恒为 `blocked`、`dose_card` 恒为 `null`、
 *      `error` 恒非空。调用方拿不到「既没通过也没说为什么」的中间态。
 *   3. **绝不 5xx**：所有映射目标都落在 `services/api/src/contract.ts` 的
 *      `ERROR_STATUS_MAP` 4xx 段（400/403/404/409/422）。映射不到的**未来阻断码**一律
 *      fail-closed 映射为 409 `OBJECT_UNAVAILABLE` 并打 `unmapped` 标记 —— 宁可拒绝，
 *      不可因为「不认识这个码」而放行，也不可把装配问题伪装成 503。
 *   4. **不新增契约 operation、不改 `app.ts` 装配**：本文件是可直接被路由层调用的领域层，
 *      与 `reference-query.ts` 同层同级；是否暴露 HTTP 面由契约评审决定。
 *
 * 为什么不做成 HTTP 路由：`packages/contracts/operations.json` 里 `verifyRegistration`
 * 目前没有 handler，新增路由会撞契约；而验收要的是「缺条件 → 明确的 4xx 或不可执行状态」，
 * 该语义完全可以在领域层表达并被单测逐码断言。
 */

import { ApiError } from '../errors.ts';
import { type ErrorCode } from '../contract.ts';
import {
  BLOCK_CODES,
  MATCH_STATES,
  evaluateDoseBoundary,
  evaluateExecutableAdvice,
  evaluateRegistrationMatch,
} from '../../../../packages/reference/index.mjs';

/** 装配结果的两种终态（不存在第三种「未知但放行」）。 */
export const SCREEN_STATUS = Object.freeze({
  EXECUTABLE: 'executable',
  BLOCKED: 'blocked',
} as const);

export type ScreenStatus = (typeof SCREEN_STATUS)[keyof typeof SCREEN_STATUS];

/** 阻断类别 → 契约错误码。键必须覆盖 `BLOCK_CODES` 全集（单测逐码断言）。 */
export const BLOCK_ERROR_MAP: Readonly<Record<string, ErrorCode>> = Object.freeze({
  // 目录对象当前不可用于可执行建议：来源缺失／失效／模拟／未核对／原文无用量。
  [BLOCK_CODES.NO_SOURCE]: 'OBJECT_UNAVAILABLE',
  [BLOCK_CODES.INVALID_SOURCE]: 'OBJECT_UNAVAILABLE',
  [BLOCK_CODES.SIMULATED_SOURCE]: 'OBJECT_UNAVAILABLE',
  [BLOCK_CODES.UNREVIEWED]: 'OBJECT_UNAVAILABLE',
  [BLOCK_CODES.NO_DOSE_SOURCE]: 'OBJECT_UNAVAILABLE',
  // 同一登记号的多来源互相打架：不是输入问题，是来源冲突。
  [BLOCK_CODES.FIELD_CONFLICT]: 'SOURCE_CONFLICT',
  [BLOCK_CODES.AMBIGUOUS_MATCH]: 'SOURCE_CONFLICT',
  // 输入与登记不符，需要用户确认场景条件。
  [BLOCK_CODES.NOT_APPLICABLE]: 'INPUT_UNCERTAIN',
  // 条件缺失／禁限用状态未知：缺的是「条件」，按条件不全拒。
  [BLOCK_CODES.MISSING_CONDITION]: 'CONDITIONS_INCOMPLETE',
  [BLOCK_CODES.RESTRICTION_UNKNOWN]: 'CONDITIONS_INCOMPLETE',
  // 法规禁用／限用：该登记不能给出可执行建议。
  [BLOCK_CODES.BANNED]: 'OBJECT_UNAVAILABLE',
  [BLOCK_CODES.RESTRICTED]: 'OBJECT_UNAVAILABLE',
  // 没有任何登记命中：按资源不存在拒（不是「没匹配就放行」）。
  [BLOCK_CODES.NO_MATCH]: 'NOT_FOUND',
  // 功能开关关闭：部署侧范围关闭，与用户权限同段（403），不是服务故障。
  [BLOCK_CODES.FEATURE_CLOSED]: 'SCOPE_DENIED',
});

/** 匹配终态 → 契约错误码（`matched` 为 `null`，表示放行）。 */
export const MATCH_ERROR_MAP: Readonly<Record<string, ErrorCode | null>> = Object.freeze({
  matched: null,
  no_match: 'NOT_FOUND',
  ambiguous: 'SOURCE_CONFLICT',
  conflict: 'SOURCE_CONFLICT',
  insufficient: 'CONDITIONS_INCOMPLETE',
  unavailable: 'OBJECT_UNAVAILABLE',
});

/** 映射不到时的兜底码：fail-closed，且必须是 4xx。 */
export const UNMAPPED_BLOCK_ERROR: ErrorCode = 'OBJECT_UNAVAILABLE';

export interface ScreeningError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /** 触发该错误的阻断类别（按域库返回顺序）。 */
  block_codes: string[];
  /** true 表示遇到了未登记的阻断类别（已 fail-closed，供告警排查）。 */
  unmapped: boolean;
}

export interface DoseCardView {
  rule_version: string;
  off_switch_supported: boolean;
  renderable: boolean;
  dose: { number: string; unit: string; condition: string };
}

export interface ScreeningOutcome {
  status: ScreenStatus;
  executable: boolean;
  renderable: boolean;
  dose_count: number;
  block_codes: string[];
  reasons: string[];
  rule_version: string;
  /** 仅在 `status === 'executable'` 且域库判定可渲染时非空。 */
  dose_card: DoseCardView | null;
  /** 仅在 `status === 'blocked'` 时非空。 */
  error: ScreeningError | null;
  /** 可执行但**没有**原文用量时，专门给出「不可渲染」的 4xx（与阻断原因区分开）。 */
  dose_error: ScreeningError | null;
}

type ScreeningItem = Record<string, unknown>;
type ScreeningContext = Record<string, unknown> | undefined;
type ScreeningOptions = Record<string, unknown> | undefined;

/** 把一组阻断类别收敛成唯一的 4xx 错误（首个可映射码胜出）。 */
export function errorForBlockCodes(blockCodes: readonly string[], reasons: readonly string[] = []): ScreeningError {
  const codes = [...blockCodes];
  const mapped = codes.map((code) => BLOCK_ERROR_MAP[code]).find((code) => typeof code === 'string');
  const unmapped = codes.filter((code) => !(code in BLOCK_ERROR_MAP));
  const code = (mapped ?? UNMAPPED_BLOCK_ERROR) as ErrorCode;
  const reason = reasons.find((text) => typeof text === 'string' && text.trim() !== '');
  return {
    code,
    message: reason ?? (unmapped.length > 0 ? '该记录暂不可用于可执行建议（阻断类别未登记，已按不可用处理）' : '该记录暂不可用于可执行建议'),
    retryable: false,
    block_codes: codes,
    unmapped: unmapped.length > 0,
  };
}

function blockedOutcome(blockCodes: readonly string[], reasons: readonly string[], ruleVersion: string): ScreeningOutcome {
  const codes = [...blockCodes];
  const mergedReasons = [...reasons];
  const error = errorForBlockCodes(codes, mergedReasons);
  return {
    status: SCREEN_STATUS.BLOCKED,
    executable: false,
    renderable: false,
    dose_count: 0,
    block_codes: codes,
    reasons: mergedReasons,
    rule_version: ruleVersion,
    dose_card: null,
    error,
    dose_error: error,
  };
}

/**
 * 装配「可执行建议 + 用量卡」。
 *
 * 两条**独立**的闸门，绝不合并成一条（合并会静默放宽其中一条）：
 *   - 建议闸门：域库 `evaluateExecutableAdvice(...).executable === true` **且** 其 `block_codes` 为空；
 *   - 用量卡闸门：域库 `evaluateDoseBoundary(...).renderable === true`（且 `dose_count === 1`）。
 *
 * 用量层的「无原文用量／用量卡开关关闭」只关闭**卡片**，不追认为整条记录不可用；
 * 此时 `dose_card === null`、`dose_error` 给 4xx，正文不会凭空出现数字。
 */
export function screenApplicability(
  item: ScreeningItem,
  context: ScreeningContext = {},
  options: ScreeningOptions = {},
): ScreeningOutcome {
  const advice = evaluateExecutableAdvice(item, context ?? {}, options ?? {});
  const boundary = evaluateDoseBoundary(item, context ?? {}, options ?? {});
  const adviceCodes = [...advice.block_codes];
  const boundaryCodes = [...boundary.block_codes];
  const reasons = [...advice.reasons, ...boundary.reasons];
  const ruleVersion = String(boundary.rule_version ?? advice.rule_version ?? '');

  if (advice.executable !== true || adviceCodes.length > 0) {
    return blockedOutcome([...new Set([...adviceCodes, ...boundaryCodes])], reasons, ruleVersion);
  }

  const card = boundary.dose_card;
  const dose = card?.dose as { number?: unknown; unit?: unknown; condition?: unknown } | undefined;
  const renderable = boundary.renderable === true && boundary.dose_count === 1 && dose !== undefined && dose !== null;

  if (!renderable) {
    // 有建议但无可渲染原文用量：不编造卡片，给出「无用量来源」的 4xx（用量层自己的码优先）。
    const doseError = errorForBlockCodes(
      boundaryCodes.length > 0 ? boundaryCodes : [BLOCK_CODES.NO_DOSE_SOURCE],
      reasons,
    );
    return {
      status: SCREEN_STATUS.EXECUTABLE,
      executable: true,
      renderable: false,
      dose_count: 0,
      block_codes: boundaryCodes,
      reasons,
      rule_version: ruleVersion,
      dose_card: null,
      error: null,
      dose_error: doseError,
    };
  }

  const doseCard: DoseCardView = {
    rule_version: String(card.rule_version ?? ''),
    off_switch_supported: card.off_switch_supported === true,
    renderable: true,
    // 数字／单位／条件逐字取自原文，本层不做任何换算或补全。
    dose: {
      number: String(dose.number ?? ''),
      unit: String(dose.unit ?? ''),
      condition: String(dose.condition ?? ''),
    },
  };

  return {
    status: SCREEN_STATUS.EXECUTABLE,
    executable: true,
    renderable: true,
    dose_count: Number(boundary.dose_count ?? 0),
    block_codes: [],
    reasons,
    rule_version: ruleVersion,
    dose_card: doseCard,
    error: null,
    dose_error: null,
  };
}

export type MatchScreeningOutcome = ScreeningOutcome & { state: string; matched: ScreeningItem | null };

/** 装配「登记匹配」。非 `matched` 一律带 4xx 错误码，绝不返回「匹配不上但可用」的记录。 */
export function screenRegistrationMatch(
  candidates: readonly ScreeningItem[],
  query: ScreeningItem,
  options: ScreeningOptions = {},
): MatchScreeningOutcome {
  const verdict = evaluateRegistrationMatch(candidates, query, options ?? {});
  const state = String(verdict.state ?? '');
  const blockCodes = [...verdict.block_codes];
  const reasons = [...verdict.reasons];
  const ruleVersion = String(verdict.rule_version ?? '');
  const matched = verdict.matched ?? null;

  if (state !== 'matched' || matched === null) {
    const mapped = (MATCH_ERROR_MAP[state] ?? UNMAPPED_BLOCK_ERROR) as ErrorCode;
    const outcome = blockedOutcome(blockCodes, reasons, ruleVersion);
    const error: ScreeningError = {
      code: mapped,
      message: reasons.find((text) => text.trim() !== '') ?? '未找到可用于可执行建议的登记记录',
      retryable: false,
      block_codes: blockCodes,
      unmapped: !(state in MATCH_ERROR_MAP),
    };
    return { ...outcome, error, dose_error: error, state, matched: null };
  }

  return {
    status: SCREEN_STATUS.EXECUTABLE,
    executable: true,
    renderable: false,
    dose_count: 0,
    block_codes: blockCodes,
    reasons,
    rule_version: ruleVersion,
    dose_card: null,
    error: null,
    dose_error: null,
    state,
    matched,
  };
}

/** 路由层用法：拿不到可执行建议就抛 4xx（`ApiError.status` 由契约映射决定）。 */
export function requireExecutableAdvice(
  item: ScreeningItem,
  context: ScreeningContext = {},
  options: ScreeningOptions = {},
): ScreeningOutcome {
  const outcome = screenApplicability(item, context, options);
  if (outcome.status !== SCREEN_STATUS.EXECUTABLE || outcome.error !== null) {
    const error = outcome.error ?? errorForBlockCodes([BLOCK_CODES.NO_SOURCE], outcome.reasons);
    throw new ApiError(error.code, error.message, { retryable: error.retryable });
  }
  return outcome;
}

/** 问答用量卡片入口：没有可渲染的原文用量就抛 4xx，绝不用默认值/换算值顶替。 */
export function requireDoseCard(
  item: ScreeningItem,
  context: ScreeningContext = {},
  options: ScreeningOptions = {},
): DoseCardView {
  const outcome = screenApplicability(item, context, options);
  if (outcome.dose_card !== null) return outcome.dose_card;
  const error = outcome.dose_error ?? outcome.error ?? errorForBlockCodes([BLOCK_CODES.NO_DOSE_SOURCE], outcome.reasons);
  throw new ApiError(error.code, error.message, { retryable: error.retryable });
}

/** 装配自检：映射表必须逐码覆盖域库闭集（供启动自检与单测复用）。 */
export function assertScreenMappingsComplete(): { block_codes: string[]; match_states: string[] } {
  const blockCodes = Object.values(BLOCK_CODES) as string[];
  const missingBlocks = blockCodes.filter((code) => !(code in BLOCK_ERROR_MAP));
  const missingStates = (MATCH_STATES as readonly string[]).filter((state) => !(state in MATCH_ERROR_MAP));
  if (missingBlocks.length > 0) throw new Error(`阻断类别缺少错误映射：${missingBlocks.join(',')}`);
  if (missingStates.length > 0) throw new Error(`匹配状态缺少错误映射：${missingStates.join(',')}`);
  return { block_codes: blockCodes, match_states: [...(MATCH_STATES as readonly string[])] };
}
