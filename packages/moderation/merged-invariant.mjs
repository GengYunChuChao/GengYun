/**
 * GY-I14 模型层（第二片）· **合流合法性**（返修 1 · 监工 `5488195507` P2）。
 *
 * 为什么单独一个模块：合流层（`merge.mjs`）与两个放行闸门（`model-review.mjs`）都必须用**同一套**
 * 合法性口径。此前 `checkMergedInvariant` 只被合流层"生产"、却不被闸门"消费"，
 * 于是闸门各自只比版本，放行了一个**自身声明就不合法**的结论：
 *
 *   监工独立构造：`decision='approved'`、`hard_rule_passed=true`、三版本匹配、`reason_codes=['MODEL_TIMEOUT']`
 *   ⇒ `checkMergedInvariant` 早已判 `ok=false`，但 `isModelLayerPublishable` 返回 `publishable=true`、
 *   `evaluateModelReReview` 返回 `action='reuse'/publishable=true`。
 *
 * 本模块把"合流合法性"抽成**单一事实来源**，供三处共用（合流层自查 + 两个闸门前置条件）。
 *
 * 合流层的判定不变式（与规则层**刻意不同**，必须显式声明）：
 *   - 规则层：`approved ⟺ hard_rule_passed === true`（该层唯一判定者是硬规则）；
 *   - 合流层：只有**单向**必要条件 `approved ⟹ hard_rule_passed === true 且无任何 fail-closed 原因码
 *     且全部所需端口实际通过 且输入绑定已验证`。
 *   反向不成立而且必须不成立：规则通过但模型没跑／没结论 ⇒ `hard_rule_passed=true` + `quarantined`。
 */
import { isAuditState } from './constants.mjs';
import { readInputBinding } from './input-binding.mjs';
import { MODEL_FAILURE_REASON_CODES } from './model-reason-codes.mjs';

/** 出现即不得放行／不得复用的合流层原因码（模型层失败类 + 明确 blocked）。 */
export const MERGED_FAILURE_REASON_CODES = Object.freeze([
  ...MODEL_FAILURE_REASON_CODES,
  'MODEL_BLOCKED',
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 结论里出现的合流层失败原因码（去重、保序）。 */
export function mergedFailureCodes(holder) {
  if (!isPlainObject(holder)) return [];
  const codes = holder.reason_codes;
  if (!Array.isArray(codes)) return [];
  return [...new Set(codes.filter((code) => typeof code === 'string' && MERGED_FAILURE_REASON_CODES.includes(code)))];
}

/**
 * 合流合法性检查（**三处共用**：合流层自查、`isModelLayerPublishable`、`evaluateModelReReview`）。
 * 先 `typeof` 再判值，确保 `undefined` 一定被抓到。
 *
 * @returns {{ok: boolean, violations: string[]}}
 */
export function checkMergedInvariant(merged) {
  const violations = [];
  if (!isPlainObject(merged)) return { ok: false, violations: ['合流结果不是对象'] };
  const { decision, hard_rule_passed: hardRulePassed, reason_codes: reasonCodes } = merged;
  if (typeof decision !== 'string' || !isAuditState(decision)) {
    violations.push(`decision 不是 AuditState 闭集值：${typeof decision}`);
  }
  if (typeof hardRulePassed !== 'boolean') {
    violations.push(`hard_rule_passed 必须是 boolean，实际 ${typeof hardRulePassed}`);
  }
  if (!Array.isArray(reasonCodes)) {
    violations.push(`reason_codes 必须是数组，实际 ${typeof reasonCodes}`);
  } else if (reasonCodes.length > 30) {
    violations.push('reason_codes 超过契约上限 30');
  }
  if (decision === 'approved') {
    if (hardRulePassed !== true) violations.push('decision=approved 但 hard_rule_passed 不为 true');
    const failureCodes = (Array.isArray(reasonCodes) ? reasonCodes : []).filter(
      (code) => typeof code === 'string' && MERGED_FAILURE_REASON_CODES.includes(code),
    );
    if (failureCodes.length > 0) {
      violations.push(`approved 但存在合流层失败原因码：${[...new Set(failureCodes)].join(',')}`);
    }
    if (isPlainObject(merged.model_layer) && isPlainObject(merged.model_layer.kinds)) {
      for (const [kind, entry] of Object.entries(merged.model_layer.kinds)) {
        if (!isPlainObject(entry) || entry.status !== 'pass') {
          violations.push(`approved 但 ${kind} 端口未实际通过（status=${String(entry?.status)}）`);
        }
      }
    }
    // 返修 1 · P1：approved 必须绑定"它实际检查过的输入"，且绑定已被重算比对通过。
    const binding = readInputBinding(merged);
    if (!binding.present || binding.digest === null) {
      violations.push('approved 但缺少可用的输入绑定（input_binding 缺失或摘要非法）');
    } else if (binding.verified !== true) {
      violations.push('approved 但输入绑定未被验证通过（input_binding.verified 不为 true）');
    }
  }
  return { ok: violations.length === 0, violations };
}
