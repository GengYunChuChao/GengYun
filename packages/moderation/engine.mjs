/**
 * GY-I14 确定性硬规则审核层 · 审核引擎。
 *
 * 首要验收条件（派单 §4.1）：**fail-closed**。
 *   「没跑」不等于「通过」。只有"全部硬规则都**实际求值**且均未命中"才允许
 *   `hard_rule_passed = true`，且只有 `hard_rule_passed = true` 才允许 `decision = approved`。
 *
 * 判不等式的形态（监工对 PR #82 判 P1 的同类错误）：
 *   「必要条件未知却放行（只追加 reason 不追加 blocked ⇒ applicable=true）」。
 *   本引擎把这种形态做成**显式闸门**：任何"未知/未求值/抛错/超时/未覆盖/带媒体未审"
 *   都会把决策压到 `quarantined`，并把 `hard_rule_passed` 钉在 false。
 *
 * 决策口径（唯一出口，禁止旁路）：
 *   quarantined  ⟸ 存在任一 fail-closed 条件（输入非法／类型未覆盖／带媒体未审／规则未求值／抛错／超时／规则集非法）
 *   rejected     ⟸ 无 fail-closed 条件，且至少一条规则实际命中
 *   approved     ⟸ 无 fail-closed 条件，且全部规则实际求值且均未命中（⟺ hard_rule_passed === true）
 *
 * 边界声明：本模块**没有 HTTP 消费者**（本 PR 不新增路由、不改 app.ts），
 * 返回结构也不是完整的契约 `Moderation`——`model_version` / `prompt_version` 属模型层，
 * 本片不产出、不填占位串（见 toRuleLayerDraft）。
 */
import {
  ALL_REASON_CODES,
  DECISION_APPROVED,
  DECISION_QUARANTINED,
  DECISION_REJECTED,
  DEFAULT_RULE_BUDGET_MS,
  FAIL_CLOSED_REASON_CODES,
  MAX_TEXT_LENGTH,
  MODEL_LAYER_FIELDS,
  NOT_PRODUCED_BY_RULE_LAYER,
  PERSISTENCE_LAYER_FIELDS,
  REASON_CODES_MAX_ITEMS,
  REASON_CODE_MAX_LENGTH,
  REASON_CODE_MIN_LENGTH,
  RULE_REASON_CODES,
  VERSION_MAX_LENGTH,
  isAuditState,
} from './constants.mjs';
import { MATCHERS, MATCHER_REVISIONS } from './matchers.mjs';
import { RuleEvaluationError } from './errors.mjs';
import { RULES, validateRuleCatalog } from './rules.mjs';
import { deriveRuleVersion } from './rule-version.mjs';
import { validateModerationInput } from './validate-input.mjs';

const FAIL_CLOSED_ORDER = new Map(FAIL_CLOSED_REASON_CODES.map((code, index) => [code, index]));

/** 稳定排序：fail-closed 码按声明序在前，规则命中码按规则声明序在后，未知码最后。 */
export function orderReasonCodes(codes, rules = RULES) {
  const ruleOrder = new Map(rules.map((rule, index) => [rule.reason_code, index]));
  const unique = [...new Set(codes)];
  return unique.sort((a, b) => {
    const aFail = FAIL_CLOSED_ORDER.has(a);
    const bFail = FAIL_CLOSED_ORDER.has(b);
    if (aFail !== bFail) return aFail ? -1 : 1;
    if (aFail && bFail) return FAIL_CLOSED_ORDER.get(a) - FAIL_CLOSED_ORDER.get(b);
    const aRule = ruleOrder.has(a) ? ruleOrder.get(a) : Number.MAX_SAFE_INTEGER;
    const bRule = ruleOrder.has(b) ? ruleOrder.get(b) : Number.MAX_SAFE_INTEGER;
    if (aRule !== bRule) return aRule - bRule;
    const aKnown = ALL_REASON_CODES.includes(a) || RULE_REASON_CODES.includes(a);
    const bKnown = ALL_REASON_CODES.includes(b) || RULE_REASON_CODES.includes(b);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    return codes.indexOf(a) - codes.indexOf(b);
  });
}

/**
 * 截断到契约上限（≤30）。截断时把 `REASON_CODES_TRUNCATED` 放在**最前**，
 * 保证它一定可见；被截掉的总是排序末位的非关键码。
 */
export function truncateReasonCodes(codes, max = REASON_CODES_MAX_ITEMS) {
  if (codes.length <= max) return codes;
  return ['REASON_CODES_TRUNCATED', ...codes.slice(0, max - 1)];
}

function safeNow(clock) {
  try {
    const value = clock();
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** 单条规则求值：**只**回传偏移证据，不回传命中原文。 */
export function evaluateRule(rule, text, matchers = MATCHERS) {
  const matcher = matchers[rule.matcher];
  if (typeof matcher !== 'function') {
    return {
      id: rule.id,
      category: rule.category,
      reason_code: rule.reason_code,
      status: 'error',
      matched: false,
      evidence: null,
      error: { type: 'MissingMatcher', code: 'RULE_ENGINE_ERROR' },
    };
  }
  const outcome = matcher(text, rule);
  if (outcome === null || typeof outcome !== 'object' || typeof outcome.matched !== 'boolean') {
    return {
      id: rule.id,
      category: rule.category,
      reason_code: rule.reason_code,
      status: 'error',
      matched: false,
      evidence: null,
      error: { type: 'InvalidMatcherOutcome', code: 'RULE_ENGINE_ERROR' },
    };
  }
  const matched = outcome.matched === true;
  return {
    id: rule.id,
    category: rule.category,
    reason_code: rule.reason_code,
    status: matched ? 'hit' : 'evaluated',
    matched,
    evidence: matched
      ? {
          field: typeof outcome.field === 'string' ? outcome.field : 'text',
          offset: Number.isInteger(outcome.offset) ? outcome.offset : null,
          length: Number.isInteger(outcome.length) ? outcome.length : null,
          suppressed: Number.isInteger(outcome.suppressed) ? outcome.suppressed : 0,
          // 被"取消词"顶掉否定的次数与具体取消词（来自规则闭集，不是输入原文，可安全回传）。
          cancelled: Number.isInteger(outcome.cancelled) ? outcome.cancelled : 0,
          cancelled_by: typeof outcome.cancelled_by === 'string' ? outcome.cancelled_by : null,
        }
      : null,
    error: null,
  };
}

function emptyRuleResult(rule, status = 'not_evaluated') {
  return {
    id: rule.id,
    category: rule.category,
    reason_code: rule.reason_code,
    status,
    matched: false,
    evidence: null,
    error: null,
  };
}

/**
 * 引擎选项自检。
 *
 * 与输入校验同理：**"选项给错了"不等于"按默认值跑一遍就算通过"**。
 * 例如 `rules` 传了非数组、`budget_ms` 传了 NaN，如果静默回落到默认值，
 * 调用方会以为自定规则生效了、或以为有时间预算，进而把结论当成有效判定。
 */
function validateEngineOptions(options) {
  const errors = [];
  if (options.rules !== undefined && !Array.isArray(options.rules)) errors.push('rules 必须是数组');
  if (
    options.matchers !== undefined &&
    (typeof options.matchers !== 'object' || options.matchers === null || Array.isArray(options.matchers))
  ) {
    errors.push('matchers 必须是对象');
  }
  if (
    options.matcher_revisions !== undefined &&
    (typeof options.matcher_revisions !== 'object' ||
      options.matcher_revisions === null ||
      Array.isArray(options.matcher_revisions))
  ) {
    errors.push('matcher_revisions 必须是对象');
  }
  if (options.clock !== undefined && typeof options.clock !== 'function') errors.push('clock 必须是函数');
  if (
    options.budget_ms !== undefined &&
    !(typeof options.budget_ms === 'number' && Number.isFinite(options.budget_ms) && options.budget_ms >= 0)
  ) {
    errors.push('budget_ms 必须是 ≥0 的有限数');
  }
  if (
    options.max_text_length !== undefined &&
    !(typeof options.max_text_length === 'number' &&
      Number.isSafeInteger(options.max_text_length) &&
      options.max_text_length > 0)
  ) {
    errors.push('max_text_length 必须是正整数');
  }
  return errors;
}

function countStatuses(ruleResults) {
  const counts = { total: ruleResults.length, evaluated: 0, hits: 0, errors: 0, timeouts: 0, not_evaluated: 0 };
  for (const item of ruleResults) {
    if (item.status === 'evaluated') counts.evaluated += 1;
    else if (item.status === 'hit') counts.hits += 1;
    else if (item.status === 'error') counts.errors += 1;
    else if (item.status === 'timeout') counts.timeouts += 1;
    else counts.not_evaluated += 1;
  }
  return counts;
}

/**
 * 判定不变式检查（先 `typeof` 再判值，确保 `undefined` 一定被抓到）。
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function checkDecisionInvariant(result) {
  const violations = [];
  if (result === null || typeof result !== 'object') {
    return { ok: false, violations: ['结果不是对象'] };
  }
  const { decision, hard_rule_passed: hardRulePassed, reason_codes: reasonCodes, rule_version: ruleVersion } = result;

  if (typeof decision !== 'string' || !isAuditState(decision)) {
    violations.push(`decision 不是 AuditState 闭集值：${typeof decision}`);
  }
  if (typeof hardRulePassed !== 'boolean') {
    violations.push(`hard_rule_passed 必须是 boolean，实际 ${typeof hardRulePassed}`);
  }
  if (!Array.isArray(reasonCodes)) {
    violations.push(`reason_codes 必须是数组，实际 ${typeof reasonCodes}`);
  } else {
    if (reasonCodes.length > REASON_CODES_MAX_ITEMS) {
      violations.push(`reason_codes 超过契约上限 ${REASON_CODES_MAX_ITEMS}`);
    }
    for (const code of reasonCodes) {
      if (typeof code !== 'string' || code.length < REASON_CODE_MIN_LENGTH || code.length > REASON_CODE_MAX_LENGTH) {
        violations.push(`reason_code 必须是 ${REASON_CODE_MIN_LENGTH}..${REASON_CODE_MAX_LENGTH} 的字符串`);
        break;
      }
    }
  }
  if (typeof ruleVersion !== 'string' || ruleVersion.length === 0 || ruleVersion.length > VERSION_MAX_LENGTH) {
    violations.push(`rule_version 必须是 1..${VERSION_MAX_LENGTH} 的字符串，实际 ${JSON.stringify(ruleVersion)}`);
  }
  // 核心不变式：approved ⟺ hard_rule_passed === true
  if (decision === DECISION_APPROVED && hardRulePassed !== true) {
    violations.push('decision=approved 但 hard_rule_passed 不为 true');
  }
  if (hardRulePassed === true && decision !== DECISION_APPROVED) {
    violations.push(`hard_rule_passed=true 但 decision=${String(decision)}`);
  }
  return { ok: violations.length === 0, violations };
}

/** 断言版：违反不变式即抛错（供测试与后续接线的前置自检）。 */
export function assertDecisionInvariant(result) {
  const { ok, violations } = checkDecisionInvariant(result);
  if (!ok) {
    throw new Error(`审核判定违反不变式：${violations.join('；')}`);
  }
  return result;
}

/** 违反不变式时的兜底：降级为隔离，绝不"修好"成通过。 */
function guardInvariant(result, rules) {
  const first = checkDecisionInvariant(result);
  if (first.ok) return result;
  const full = orderReasonCodes(
    [...(result.reason_codes_full ?? result.reason_codes ?? []), 'ENGINE_INVARIANT_VIOLATION'],
    rules,
  );
  const guarded = {
    ...result,
    decision: DECISION_QUARANTINED,
    hard_rule_passed: false,
    reason_codes_full: full,
    reason_codes: truncateReasonCodes(full),
    invariant_violations: [...(result.invariant_violations ?? []), ...first.violations],
  };
  const second = checkDecisionInvariant(guarded);
  return { ...guarded, contract_shape_ok: second.ok };
}

/**
 * 对一个目标执行确定性硬规则审核。
 *
 * @param {unknown} input `{ target_ref, text, media }`
 * @param {{
 *   rules?: Array<object>,
 *   matchers?: Record<string, Function>,
 *   matcher_revisions?: Record<string, number>,
 *   clock?: () => number,
 *   budget_ms?: number,
 *   max_text_length?: number,
 * }} [options]
 */
export function evaluateHardRules(input, options = {}) {
  const rules = Array.isArray(options.rules) ? options.rules : RULES;
  const matchers = options.matchers ?? MATCHERS;
  const revisions = options.matcher_revisions ?? MATCHER_REVISIONS;
  const clock = options.clock ?? Date.now;
  const budgetMs = options.budget_ms ?? DEFAULT_RULE_BUDGET_MS;
  const maxTextLength = options.max_text_length ?? MAX_TEXT_LENGTH;

  const failClosed = [];
  const ruleResults = [];
  let budgetExhausted = false;
  let engineError = null;
  let elapsedMs = null;
  let ruleVersion = null;

  // ---- 0. 选项与规则集自检：非法配置绝不产生"通过" ----
  const optionErrors = validateEngineOptions(options);
  if (optionErrors.length > 0) failClosed.push('ENGINE_OPTIONS_INVALID');
  const catalog = validateRuleCatalog(rules, matchers);
  const emptyCatalog = rules.length === 0;
  if (!catalog.valid || emptyCatalog) {
    failClosed.push('RULE_CATALOG_INVALID');
  }

  // ---- 1. rule_version 由规则集内容派生（派生失败同样不放行）----
  try {
    ruleVersion = deriveRuleVersion(rules, matchers, revisions);
  } catch {
    ruleVersion = null;
    if (!failClosed.includes('RULE_CATALOG_INVALID')) failClosed.push('RULE_CATALOG_INVALID');
  }

  // ---- 2. 输入校验（fail-closed 第一道闸）----
  const validation = validateModerationInput(input, { max_text_length: maxTextLength });
  for (const code of validation.reason_codes) failClosed.push(code);

  const gateBlocked =
    !validation.valid || !validation.covered || validation.has_media || failClosed.length > 0;

  if (!gateBlocked) {
    const started = safeNow(clock);
    if (started === null) {
      engineError = 'clock_unavailable';
      failClosed.push('RULE_ENGINE_ERROR');
      for (const rule of rules) ruleResults.push(emptyRuleResult(rule, 'not_evaluated'));
    } else {
      for (let index = 0; index < rules.length; index += 1) {
        const now = safeNow(clock);
        if (now === null) {
          engineError = 'clock_unavailable';
          failClosed.push('RULE_ENGINE_ERROR');
          for (let rest = index; rest < rules.length; rest += 1) {
            ruleResults.push(emptyRuleResult(rules[rest], 'not_evaluated'));
          }
          break;
        }
        // 预算语义：只在**开始一条规则之前**检查；已开始的规则必须跑完。
        // 超时即"未求值"，绝不当作"未命中"。
        if (now - started > budgetMs) {
          budgetExhausted = true;
          failClosed.push('RULE_TIMEOUT');
          for (let rest = index; rest < rules.length; rest += 1) {
            ruleResults.push(emptyRuleResult(rules[rest], 'timeout'));
          }
          elapsedMs = now - started;
          break;
        }
        try {
          ruleResults.push(evaluateRule(rules[index], validation.text, matchers));
        } catch (error) {
          // 单条规则抛错：计入"未求值/失败"，不吞成"未命中"，也不影响其它目标。
          failClosed.push('RULE_ENGINE_ERROR');
          ruleResults.push({
            ...emptyRuleResult(rules[index], 'error'),
            error: {
              type: typeof error?.name === 'string' ? error.name : 'Error',
              code: 'RULE_ENGINE_ERROR',
              rule_id: error instanceof RuleEvaluationError ? error.rule_id : rules[index].id,
            },
          });
        }
        const after = safeNow(clock);
        elapsedMs = after === null ? elapsedMs : after - started;
      }
    }
  } else {
    for (const rule of rules) ruleResults.push(emptyRuleResult(rule));
    if (validation.valid && !validation.covered) failClosed.push('TARGET_TYPE_NOT_COVERED');
    if (validation.valid && validation.covered && validation.has_media) {
      failClosed.push('MEDIA_NOT_EVALUATED_BY_RULE_LAYER');
    }
  }

  // ---- 3. 决策 ----
  const counts = countStatuses(ruleResults);
  const hitCodes = ruleResults.filter((item) => item.status === 'hit').map((item) => item.reason_code);
  const allEvaluated =
    !gateBlocked && rules.length > 0 && ruleResults.length === rules.length && counts.evaluated === rules.length;
  const hardRulePassed = allEvaluated && failClosed.length === 0;
  const canDecide = !gateBlocked && failClosed.length === 0 && ruleResults.length === rules.length && rules.length > 0;

  let decision = DECISION_QUARANTINED;
  if (canDecide) {
    decision = hitCodes.length > 0 ? DECISION_REJECTED : DECISION_APPROVED;
  }

  const full = orderReasonCodes([...failClosed, ...hitCodes], rules);

  const result = {
    // —— 与契约 Moderation 同口径的 4 个字段（本片产出）——
    target_ref: validation.target_ref,
    decision,
    reason_codes: truncateReasonCodes(full),
    hard_rule_passed: hardRulePassed,
    rule_version: ruleVersion,
    // —— 以下为组件内诊断字段，**不得**写进契约 Moderation ——
    rule_layer_only: true,
    wired_to_http: false,
    pending_model_layer_fields: [...MODEL_LAYER_FIELDS],
    pending_persistence_fields: [...PERSISTENCE_LAYER_FIELDS],
    reason_codes_full: full,
    rules: ruleResults,
    counts,
    input: {
      valid: validation.valid,
      covered: validation.covered,
      media_declared: validation.media_declared,
      media_count: validation.media_count,
    },
    budget: { ms: budgetMs, elapsed_ms: elapsedMs, exhausted: budgetExhausted },
    engine_error: engineError,
    option_errors: optionErrors,
    invariant_violations: [],
    contract_shape_ok: true,
    component: 'packages/moderation',
  };

  return guardInvariant(result, rules);
}

/** 别名：同一目标审核。 */
export const evaluateTarget = evaluateHardRules;

/**
 * 构造一条"未能判定"的隔离结果（引擎级兜底）。
 * 用于批量审核里单条目标在引擎外抛出（例如输入对象的 ownKeys 陷阱抛错）时的隔离，
 * 保证"一条异常不影响其它目标"，同时该条**绝不**通过。
 */
export function makeQuarantineResult(reasonCodes = [], options = {}) {
  const rules = Array.isArray(options.rules) ? options.rules : RULES;
  const matchers = options.matchers ?? MATCHERS;
  const revisions = options.matcher_revisions ?? MATCHER_REVISIONS;
  let ruleVersion = null;
  try {
    ruleVersion = deriveRuleVersion(rules, matchers, revisions);
  } catch {
    ruleVersion = null;
  }
  const ruleResults = rules.map((rule) => emptyRuleResult(rule));
  const full = orderReasonCodes(
    reasonCodes.length > 0 ? reasonCodes : ['RULE_ENGINE_ERROR'],
    rules,
  );
  const result = {
    target_ref: null,
    decision: DECISION_QUARANTINED,
    reason_codes: truncateReasonCodes(full),
    hard_rule_passed: false,
    rule_version: ruleVersion,
    rule_layer_only: true,
    wired_to_http: false,
    pending_model_layer_fields: [...MODEL_LAYER_FIELDS],
    pending_persistence_fields: [...PERSISTENCE_LAYER_FIELDS],
    reason_codes_full: full,
    rules: ruleResults,
    counts: countStatuses(ruleResults),
    input: { valid: false, covered: false, media_declared: false, media_count: null },
    budget: { ms: options.budget_ms ?? DEFAULT_RULE_BUDGET_MS, elapsed_ms: null, exhausted: false },
    engine_error: options.engine_error ?? null,
    invariant_violations: [],
    contract_shape_ok: true,
    component: 'packages/moderation',
  };
  return guardInvariant(result, rules);
}

/**
 * 把规则层结果投影成**明确标注为不完整**的草稿：
 * 契约 `Moderation` 共 9 个必填结构，本片只产出其中 4 个。
 * 这里**不**用占位字符串补 `model_version` / `prompt_version`——补了就是假装已填。
 */
export function toRuleLayerDraft(result) {
  return {
    schema: 'gengyun/moderation/rule-layer-draft@1',
    complete: false,
    missing_contract_fields: [...NOT_PRODUCED_BY_RULE_LAYER],
    rule_layer: {
      target_ref: result?.target_ref ?? null,
      decision: result?.decision ?? null,
      reason_codes: result?.reason_codes ?? [],
      hard_rule_passed: result?.hard_rule_passed ?? false,
      rule_version: result?.rule_version ?? null,
    },
    note: '本草稿不是契约 Moderation：模型版本／提示词版本由模型层增量补齐，本片不产出占位值。',
  };
}
