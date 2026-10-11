/**
 * GY-I14 确定性硬规则审核层 · 版本重审（派单 §4.2）。
 *
 * 目标：给定**既有审核结果**与**当前规则版本**，判定该结果是否已失效、必须重审；
 * 并明确重审的 `AuditState` 落点。核心底线是"**不得静默复用旧判定**"：
 *   - 规则集内容变化 ⇒ `rule_version` 变化（rule-version.mjs）⇒ 旧结果失效；
 *   - 目标 `revision` 变化 ⇒ 旧结果失效（编辑生成新版本重审，AC19）；
 *   - 旧结果的 `rule_version` 缺失／非法 ⇒ 失效且隔离（未知不等于有效）；
 *   - 旧结果自称已通过但 `hard_rule_passed` 不是 `true` ⇒ 自相矛盾，失效且隔离
 *     （这正是监工对 PR #82 判 P1 的"必要条件未知却放行"形态）。
 *
 * 重审落点（两种，均**阻断发布**）：
 *   - `pending`：规则集变化／目标修订变化。旧判定失去强制力，内容回到待筛查队列，
 *     由确定性规则自动重跑；重跑本身仍是 fail-closed，不会因"排队"而放行。
 *   - `quarantined`：失效原因属于"证据不可信／结构非法／绑定对象已变"（缺版本号、
 *     decision 非法、approved 与 hard_rule_passed 矛盾、target type/id 变化），
 *     不能自动排队放行，须隔离并留痕。
 *
 * 发布口径：`isPublishable` 要求 `approved` **且** `hard_rule_passed === true` **且**
 * `rule_version` 等于当前版本。三者任一不满足即不得发布——"旧版本审核结果不能套新版本"。
 */
import {
  DECISION_APPROVED,
  DECISION_QUARANTINED,
  NOT_PRODUCED_BY_RULE_LAYER,
  TARGET_ID_MAX_LENGTH,
  TARGET_ID_MIN_LENGTH,
  TARGET_REVISION_MIN,
  isAuditState,
  isTargetType,
} from './constants.mjs';
import { RULE_VERSION } from './rule-version.mjs';

/** 处置动作：沿用既有判定 / 必须重审。 */
export const REVIEW_ACTIONS = Object.freeze(['reuse', 're_review']);
/** 重审落点。 */
export const REVIEW_LANDINGS = Object.freeze(['pending', 'quarantined']);

function safeGet(holder, key) {
  try {
    return { ok: true, present: key in holder, value: holder[key] };
  } catch {
    return { ok: false, present: false, value: undefined };
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `target_ref` 的**结构性校验**（返修轮 3 · P2）。
 *
 * 只判 "type/id 是 string、revision 是 number" 是不够的：`type=bogus`、`id=''`、`revision=0`
 * 都能通过宽松检查，从而被 `reuse` 甚至 `publishable=true`——等于把**非法绑定**当成可复用结果。
 * 这里按契约 `TargetRef` 校验：type 属闭集、id 非空且 ≤80、revision 为 ≥1 的正整数。
 *
 * @returns {string[]} 问题清单（空数组 = 合法）
 */
function targetRefProblems(ref) {
  if (!isPlainObject(ref)) return ['target_ref 必须是对象'];
  const problems = [];
  if (!isTargetType(ref.type)) problems.push('target_ref.type 不在契约闭集内');
  if (
    typeof ref.id !== 'string' ||
    ref.id.length < TARGET_ID_MIN_LENGTH ||
    ref.id.length > TARGET_ID_MAX_LENGTH
  ) {
    problems.push(`target_ref.id 必须是 ${TARGET_ID_MIN_LENGTH}..${TARGET_ID_MAX_LENGTH} 的非空字符串`);
  }
  if (
    typeof ref.revision !== 'number' ||
    !Number.isSafeInteger(ref.revision) ||
    ref.revision < TARGET_REVISION_MIN
  ) {
    problems.push(`target_ref.revision 必须是 ≥${TARGET_REVISION_MIN} 的正整数`);
  }
  return problems;
}

function buildOutcome(fields) {
  const reasonCodes = [...new Set(fields.reason_codes)];
  return {
    rule_version_current: fields.rule_version_current,
    stale: fields.stale,
    action: fields.stale ? 're_review' : 'reuse',
    landing: fields.stale ? fields.landing : null,
    publishable: fields.publishable,
    reason_codes: reasonCodes,
    details: fields.details,
  };
}

/**
 * 判定既有审核结果是否失效、须重审。
 *
 * @param {unknown} existing 既有审核结果（至少含 decision / hard_rule_passed / rule_version / target_ref）
 * @param {{ rule_version?: string, target_ref?: {type:string,id:string,revision:number} }} [options]
 */
export function evaluateReReview(existing, options = {}) {
  const ruleVersionCurrent = options.rule_version ?? RULE_VERSION;
  const targetRef = options.target_ref ?? null;
  const reason_codes = [];
  const details = [];
  const fail = (code, landing, field = null) => {
    reason_codes.push(code);
    details.push({ field, code });
    return { stale: true, landing, publishable: false };
  };
  const base = {
    rule_version_current: ruleVersionCurrent,
    stale: false,
    landing: 'pending',
    publishable: false,
    reason_codes,
    details,
  };

  if (!isPlainObject(existing)) {
    const outcome = fail('REVIEW_INPUT_INVALID', 'quarantined', null);
    return buildOutcome({ ...base, ...outcome });
  }

  const decisionRead = safeGet(existing, 'decision');
  const hardRead = safeGet(existing, 'hard_rule_passed');
  const versionRead = safeGet(existing, 'rule_version');
  const refRead = safeGet(existing, 'target_ref');
  if (!decisionRead.ok || !hardRead.ok || !versionRead.ok || !refRead.ok) {
    const outcome = fail('REVIEW_INPUT_INVALID', 'quarantined', null);
    return buildOutcome({ ...base, ...outcome });
  }

  const decision = decisionRead.value;
  const hardRulePassed = hardRead.value;
  const ruleVersion = versionRead.value;
  const existingRef = refRead.value;

  // 1) decision 必须是契约闭集值；否则旧判定不可信。
  if (!isAuditState(decision)) {
    const outcome = fail('DECISION_INVALID', 'quarantined', 'decision');
    return buildOutcome({ ...base, ...outcome });
  }

  // 2) rule_version 未知 ⇒ 视为失效（"不知道用的哪版规则"不等于"没变化"）。
  if (typeof ruleVersion !== 'string' || ruleVersion.length === 0) {
    const outcome = fail('RULE_VERSION_UNKNOWN', 'quarantined', 'rule_version');
    return buildOutcome({ ...base, ...outcome });
  }

  // 3) target_ref 必须存在且**结构合法**（返修轮 3 · P2：宽松检查会放过 type=bogus／id 空／revision=0）。
  if (!isPlainObject(existingRef)) {
    const outcome = fail('REVIEW_INPUT_INVALID', 'quarantined', 'target_ref');
    return buildOutcome({ ...base, ...outcome });
  }
  if (targetRefProblems(existingRef).length > 0) {
    const outcome = fail('TARGET_REF_INVALID', 'quarantined', 'target_ref');
    return buildOutcome({ ...base, ...outcome });
  }

  // 4) 自相矛盾：自称通过却没有 hard_rule_passed=true（或反之）。
  if (typeof hardRulePassed !== 'boolean') {
    const outcome = fail('DECISION_INCONSISTENT', 'quarantined', 'hard_rule_passed');
    return buildOutcome({ ...base, ...outcome });
  }
  if (decision === DECISION_APPROVED && hardRulePassed !== true) {
    const outcome = fail('DECISION_INCONSISTENT', 'quarantined', 'hard_rule_passed');
    return buildOutcome({ ...base, ...outcome });
  }
  if (hardRulePassed === true && decision !== DECISION_APPROVED) {
    const outcome = fail('DECISION_INCONSISTENT', 'quarantined', 'hard_rule_passed');
    return buildOutcome({ ...base, ...outcome });
  }

  // 5) 规则集内容变化 ⇒ 旧结果失效。
  if (ruleVersion !== ruleVersionCurrent) {
    fail('RULE_VERSION_CHANGED', 'pending', 'rule_version');
  }

  // 6) 目标绑定变化 ⇒ 旧结果失效（先校验"当前目标"本身是否结构合法）。
  if (targetRef !== null) {
    if (targetRefProblems(targetRef).length > 0) {
      fail('TARGET_REF_INVALID', 'quarantined', 'target_ref');
    } else if (targetRef.type !== existingRef.type || targetRef.id !== existingRef.id) {
      fail('TARGET_REF_CHANGED', 'quarantined', 'target_ref');
    } else if (targetRef.revision !== existingRef.revision) {
      fail('TARGET_REVISION_CHANGED', 'pending', 'target_ref.revision');
    }
  }

  const stale = reason_codes.length > 0;
  const landing = stale
    ? reason_codes.some((code) =>
        [
          'DECISION_INVALID',
          'DECISION_INCONSISTENT',
          'RULE_VERSION_UNKNOWN',
          'TARGET_REF_CHANGED',
          'TARGET_REF_INVALID',
          'REVIEW_INPUT_INVALID',
        ].includes(code),
      )
      ? DECISION_QUARANTINED
      : 'pending'
    : 'pending';
  const publishable = !stale && decision === DECISION_APPROVED && hardRulePassed === true;
  if (!publishable) reason_codes.push('NOT_PUBLISHABLE');

  return buildOutcome({ ...base, stale, landing, publishable });
}

/**
 * 发布口径独立判定：`approved` + `hard_rule_passed === true` + 版本等于当前版本。
 * 用于"下架/发布"分离（F08：通过筛查不等同于专业验证）与"不能发布旧版本结果"（AC19）。
 */
export function isPublishable(result, ruleVersionCurrent = RULE_VERSION) {
  const reason_codes = [];
  if (!isPlainObject(result)) {
    return { publishable: false, reason_codes: ['REVIEW_INPUT_INVALID'] };
  }
  const decisionRead = safeGet(result, 'decision');
  const hardRead = safeGet(result, 'hard_rule_passed');
  const versionRead = safeGet(result, 'rule_version');
  const refRead = safeGet(result, 'target_ref');
  if (!decisionRead.ok || !hardRead.ok || !versionRead.ok || !refRead.ok) {
    return { publishable: false, reason_codes: ['REVIEW_INPUT_INVALID'] };
  }
  if (!isAuditState(decisionRead.value)) reason_codes.push('DECISION_INVALID');
  else if (decisionRead.value !== DECISION_APPROVED) reason_codes.push('NOT_PUBLISHABLE');
  if (hardRead.value !== true) reason_codes.push('DECISION_INCONSISTENT');
  // 绑定结构非法（type 不在闭集／id 空／revision 非正整数）⇒ 不得发布（返修轮 3 · P2）。
  if (targetRefProblems(refRead.value).length > 0) reason_codes.push('TARGET_REF_INVALID');
  if (versionRead.value !== ruleVersionCurrent) {
    reason_codes.push(versionRead.value === undefined || versionRead.value === null
      ? 'RULE_VERSION_UNKNOWN'
      : 'RULE_VERSION_CHANGED');
  }
  return { publishable: reason_codes.length === 0, reason_codes };
}

/** 本片不产出的字段清单（供接线方核对，避免把草稿当完整 Moderation 落库）。 */
export function missingContractFields() {
  return [...NOT_PRODUCED_BY_RULE_LAYER];
}
