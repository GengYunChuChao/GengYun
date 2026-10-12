/**
 * GY-I15（#15）阶段 1 · 发布前审核 gate（先审后发 + 版本绑定 + fail-closed）。
 *
 * 职责：把 `packages/moderation`（GY-I14，已合并 main）的确定性硬规则层包成
 * **发布闸门**，回答两个问题，且两个问题都只能回答"可发布 / 不可发布"：
 *   1. `evaluate(target, text, media)`：一次**新审核**（创建或新版本）能否发布；
 *   2. `assess(target, verdict)`：一条**既有审核结论**在**当前规则版本**下是否仍然有效
 *      （失效 ⇒ 内容不得保持可见，须重审）。
 *
 * 硬性语义（派单 §2）：
 *   - 只有 `decision === 'approved'` 且 `hard_rule_passed === true` 且 `rule_version`
 *     等于**当前**派生版本，才允许发布；三者任一不满足即不得发布。
 *   - **fail-closed**：规则层抛错／截断（`RULE_SCAN_TRUNCATED`）／超时（`RULE_TIMEOUT`）／
 *     未求值／输入非法／类型未覆盖／带媒体未审，一律 `quarantined` ⇒ **不得发布**。
 *     "没跑"不等于"通过"。
 *   - **版本绑定**：结论必须与 `TargetRef{type,id,revision}` 和 `rule_version` 一起使用；
 *     目标 `revision` 变化或规则集内容变化 ⇒ 旧结论失效。
 *
 * 复用声明（**不另写一套**）：
 *   - 审核本身：`evaluateHardRules`（= `evaluateTarget`）；
 *   - 版本重审判定：`evaluateReReview`；
 *   - 发布口径：`isPublishable`；
 *   - 判定不变式自查：`checkDecisionInvariant`；
 *   - 规则版本派生：`deriveRuleVersion`（**不手填**版本串；也不拿 `RULE_VERSION` 常量做比较，
 *     因为调用方可能注入自定义规则集，当前版本必须由同一份输入派生）。
 *
 * 边界：本模块**没有 HTTP 消费者**（阶段 2 才装配路由）；返回结构不是完整的契约
 * `Moderation`——`model_version` / `prompt_version` 属模型层，本片不产出、不填占位串
 * （见 `missing_contract_fields`）。
 */
import {
  RULES,
  checkDecisionInvariant,
  deriveRuleVersion,
  evaluateHardRules,
  evaluateReReview,
  isPublishable,
  makeQuarantineResult,
  missingContractFields,
} from '../../../../packages/moderation/index.mjs';
import type {
  HardRuleOptions,
  ModerationRuleDescriptor,
  ReReviewOutcome,
  RuleLayerOutcome,
} from '../../../../packages/moderation/index.mjs';
import type { AuditState, TargetRef } from './types.ts';

/** 契约 `Moderation.reason_codes` 上限（maxItems 30）。 */
const REASON_CODES_MAX_ITEMS = 30;

/** 审核结论（规则层可产出的那部分；不含模型层字段，见边界声明）。 */
export interface RuleLayerVerdict {
  target_ref: TargetRef;
  decision: AuditState;
  reason_codes: string[];
  hard_rule_passed: boolean;
  /** 派生版本串；无法派生时为 `null`（此时**任何**内容都不得发布）。 */
  rule_version: string | null;
}

/** 一次新审核的判定结果（含为什么不可发布）。 */
export interface GateOutcome extends RuleLayerVerdict {
  /** 最终发布口径：只有这一项为 `true` 才允许内容可见。 */
  publishable: boolean;
  /** 是否落在 fail-closed 一侧（隔离/未能求值/输入不可用/不变式违反）。 */
  fail_closed: boolean;
  /** 不可发布的原因码（发布口径 + 不变式的并集，供调用方原样回传）。 */
  refusal_reason_codes: string[];
  counts: RuleLayerOutcome['counts'] | null;
  /** 引擎级错误标记（例如"规则层整体抛错被本 gate 兜底"），仅诊断用。 */
  engine_error: string | null;
  /** 引擎自查（`checkDecisionInvariant`）结果；违反即不得发布。 */
  invariant: { ok: boolean; violations: string[] };
  /** 本组件只产出规则层字段：`id` 由持久层生成，`model_version`/`prompt_version` 属模型层。 */
  rule_layer_only: true;
  wired_to_http: false;
  missing_contract_fields: string[];
}

/** 既有结论的重审判定（读取可见性与版本升级重审共用）。 */
export interface VerdictAssessment {
  /** 旧结论是否已失效（规则版本或目标 revision 变化、证据不可信）。 */
  stale: boolean;
  /** 该结论在当前规则版本下是否仍可支撑"可见/发布"。 */
  publishable: boolean;
  reason_codes: string[];
  rule_version_current: string | null;
  landing: ReReviewOutcome['landing'];
  /** 两套发布口径（evaluateReReview / isPublishable）结论不一致时为 true。 */
  inconsistent: boolean;
}

export interface PublishGate {
  /** 当前应使用的规则版本（由规则集内容派生；无法派生 ⇒ `null` ⇒ 不得发布）。 */
  currentRuleVersion(): string | null;
  /** 新审核：创建帖子/评论，或编辑生成的新版本。 */
  evaluate(target: TargetRef, text: string, media: readonly unknown[]): GateOutcome;
  /** 既有结论在当前规则版本下是否仍支撑可见。 */
  assess(target: TargetRef, verdict: RuleLayerVerdict): VerdictAssessment;
  /** 本 gate 使用的规则集规模（供测试与诊断；不是版本号）。 */
  ruleCount(): number;
}

function uniqueCodes(codes: readonly string[]): string[] {
  return [...new Set(codes)].slice(0, REASON_CODES_MAX_ITEMS);
}

/**
 * 构造发布闸门。
 *
 * `options` 直接透传给 `packages/moderation`（`rules`/`matchers`/`matcher_revisions`/
 * `clock`/`budget_ms`/`max_text_length`），因此注入**自定义规则集**时会真实改变派生
 * `rule_version`——这既用于测试"规则集升级后旧结论失效"，也是阶段 2 升级规则的唯一入口。
 * 本模块**从不接受** `rule_version` 参数：不能用"传入假版本号"来放行。
 */
export function createPublishGate(options: HardRuleOptions = {}): PublishGate {
  const engineOptions: HardRuleOptions = {
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    ...(options.matchers === undefined ? {} : { matchers: options.matchers }),
    ...(options.matcher_revisions === undefined ? {} : { matcher_revisions: options.matcher_revisions }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.budget_ms === undefined ? {} : { budget_ms: options.budget_ms }),
    ...(options.max_text_length === undefined ? {} : { max_text_length: options.max_text_length }),
  };
  const rules: ReadonlyArray<ModerationRuleDescriptor> = Array.isArray(options.rules) ? options.rules : RULES;

  function currentRuleVersion(): string | null {
    try {
      return deriveRuleVersion(engineOptions.rules, engineOptions.matchers, engineOptions.matcher_revisions);
    } catch {
      // 派生失败＝无法确定"当前是哪版规则" ⇒ 调用方必须按 fail-closed 处理。
      return null;
    }
  }

  function safeInvariant(result: unknown): { ok: boolean; violations: string[] } {
    try {
      return checkDecisionInvariant(result);
    } catch (error) {
      return { ok: false, violations: [`checkDecisionInvariant 抛错：${(error as Error)?.name ?? 'Error'}`] };
    }
  }

  function toVerdict(target: TargetRef, result: RuleLayerOutcome): RuleLayerVerdict {
    return {
      target_ref: target,
      decision: result.decision,
      reason_codes: Array.isArray(result.reason_codes) ? result.reason_codes.slice(0, REASON_CODES_MAX_ITEMS) : [],
      hard_rule_passed: result.hard_rule_passed === true,
      rule_version: typeof result.rule_version === 'string' ? result.rule_version : null,
    };
  }

  function evaluate(target: TargetRef, text: string, media: readonly unknown[]): GateOutcome {
    let result: RuleLayerOutcome;
    try {
      result = evaluateHardRules({ target_ref: target, text, media: [...media] }, engineOptions);
    } catch (error) {
      // 规则层**抛错**＝"没跑"：绝不当作通过，直接按引擎兜底判为隔离。
      result = makeQuarantineResult(['RULE_ENGINE_ERROR'], {
        ...engineOptions,
        engine_error: `${(error as Error)?.name ?? 'Error'}`,
      });
    }

    const verdict = toVerdict(target, result);
    const current = currentRuleVersion();
    const invariant = safeInvariant(result);

    let publishCheck: { publishable: boolean; reason_codes: string[] };
    try {
      publishCheck = isPublishable(verdict, current ?? '\u0000不可能匹配的版本串');
    } catch (error) {
      publishCheck = { publishable: false, reason_codes: ['REVIEW_INPUT_INVALID'] };
      invariant.violations.push(`isPublishable 抛错：${(error as Error)?.name ?? 'Error'}`);
      invariant.ok = false;
    }

    // 单点发布口径：以下每一项都必须成立，缺一即不得发布。
    const publishable =
      current !== null &&
      publishCheck.publishable === true &&
      invariant.ok === true &&
      result.contract_shape_ok === true &&
      verdict.decision === 'approved' &&
      verdict.hard_rule_passed === true &&
      verdict.rule_version === current;

    const refusal = new Set<string>();
    for (const code of publishCheck.reason_codes) {
      // 非 approved 的结论本来就不发布，`isPublishable` 仍会报 DECISION_INCONSISTENT；
      // 那不是"自相矛盾"，不当作拒绝理由回传（真实矛盾只可能出现在自称 approved 的结论上）。
      if (code === 'DECISION_INCONSISTENT' && verdict.decision !== 'approved') continue;
      refusal.add(code);
    }
    if (!invariant.ok) refusal.add('ENGINE_INVARIANT_VIOLATION');
    if (current === null) refusal.add('RULE_VERSION_UNKNOWN');
    if (result.contract_shape_ok !== true) refusal.add('ENGINE_INVARIANT_VIOLATION');
    if (!publishable && refusal.size === 0) refusal.add('NOT_PUBLISHABLE');

    return {
      ...verdict,
      publishable,
      fail_closed: !publishable && verdict.decision !== 'rejected',
      // 拒绝理由必须自带**规则层原因码**（rejected 的命中码 / fail-closed 的隔离码），
      // 否则调用方只能看到"不可发布"而说不出为什么。
      refusal_reason_codes: uniqueCodes([...verdict.reason_codes, ...refusal]),
      counts: result.counts ?? null,
      engine_error: typeof result.engine_error === 'string' ? result.engine_error : null,
      invariant,
      rule_layer_only: true,
      wired_to_http: false,
      missing_contract_fields: missingContractFields(),
    };
  }

  function assess(target: TargetRef, verdict: RuleLayerVerdict): VerdictAssessment {
    const current = currentRuleVersion();
    if (current === null) {
      return {
        stale: true,
        publishable: false,
        reason_codes: ['RULE_VERSION_UNKNOWN'],
        rule_version_current: null,
        landing: 'quarantined',
        inconsistent: false,
      };
    }

    let review: ReReviewOutcome;
    try {
      review = evaluateReReview(verdict, { rule_version: current, target_ref: target });
    } catch {
      return {
        stale: true,
        publishable: false,
        reason_codes: ['REVIEW_INPUT_INVALID'],
        rule_version_current: current,
        landing: 'quarantined',
        inconsistent: true,
      };
    }

    let publishCheck: { publishable: boolean; reason_codes: string[] };
    try {
      publishCheck = isPublishable(verdict, current);
    } catch {
      publishCheck = { publishable: false, reason_codes: ['REVIEW_INPUT_INVALID'] };
    }

    // 两套口径必须一致；不一致说明"证据自相矛盾" ⇒ 不得可见（保守取交集）。
    const inconsistent = review.publishable !== publishCheck.publishable;
    const publishable = review.publishable && publishCheck.publishable && !inconsistent && !review.stale;
    return {
      stale: review.stale,
      publishable,
      reason_codes: uniqueCodes([
        ...review.reason_codes,
        ...publishCheck.reason_codes,
        ...(inconsistent ? ['DECISION_INCONSISTENT'] : []),
      ]),
      rule_version_current: current,
      landing: review.landing,
      inconsistent,
    };
  }

  return { currentRuleVersion, evaluate, assess, ruleCount: () => rules.length };
}

/** 出厂规则集规模（只读事实，便于测试断言"没有偷偷换小规则集"）。 */
export const FACTORY_RULE_COUNT = RULES.length;
