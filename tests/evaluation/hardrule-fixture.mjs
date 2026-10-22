// 硬规则层样本夹具（**程序验证用**，非真实样本；不得据此产出任何真实结论）。
//
// 为什么要这组夹具（监工 PR #440 最后一条批复 `supervisor-1022-0541-pr440`，P2）：
//   `hard_rule_passed` 只反映**规则层**事实，风险样本可以**合法地**由模型层拦下而规则层通过
//   ——`tests/unit/community-moderation-fixtures.mjs` 的 `blockingPort()` 就是这种形态
//   （模型层 `block` 且 `hard_rule_passed === true`，代表"规则通过后由模型检出风险"）；
//   图片风险尤其不可能被文本硬规则全部命中。
//   所以"风险样本 ⇒ hard_rule_passed 必须为 false"不是事实；评估口径必须按样本的**显式声明**
//   区分"明确的硬规则/失败用例"与"一般模型风险样本"，不得靠标签名（expectation/labelClass）猜。
//
// 显式判据（唯一定义在 `packages/evaluation/src/metrics.mjs` 的 `hardRuleExpectationOf`）：
//   · `gold.hardRuleExpectation = 'reject'`：明确的硬规则命中/失败用例 ⇒ 期望 `hard_rule_passed === false`；
//   · `gold.hardRuleExpectation = 'pass'`：明确的规则层放行用例 ⇒ 期望 `hard_rule_passed === true`；
//   · 未声明 + `expectation === 'normal'`：默认期望规则层放行（硬规则不得误伤正常内容）；
//   · 未声明 + `expectation === 'risk'`：一般模型风险样本，**不参与** `hardRulePass`，
//     另报为独立指标 `modelRiskIsolation`（模型层隔离读数）。

/** 一般模型风险样本（与 `blockingPort()` 同形）：规则层通过 + 模型层驳回 ⇒ 期望被拦下。 */
export function modelLayerBlockedRisk() {
  return {
    record: { task: 'ai_moderation', expectation: 'risk', labelClass: 'dangerous', gold: {} },
    output: { decision: 'blocked', hard_rule_passed: true },
  };
}

/** 明确的硬规则/失败用例：样本显式声明规则层必须拒绝，规则层确实命中 ⇒ `hard_rule_passed=false`。 */
export function declaredHardRuleRejectedRisk() {
  return {
    record: { task: 'ai_moderation', expectation: 'risk', labelClass: 'dangerous', gold: { hardRuleExpectation: 'reject' } },
    output: { decision: 'blocked', hard_rule_passed: false },
  };
}

/** 漏拦：样本显式声明规则层必须拒绝，规则层却放行（`hard_rule_passed=true`）⇒ 必须判负。 */
export function declaredHardRuleEscapedRisk() {
  return {
    record: { task: 'ai_moderation', expectation: 'risk', labelClass: 'dangerous', gold: { hardRuleExpectation: 'reject' } },
    output: { decision: 'blocked', hard_rule_passed: true },
  };
}

/** 正常样本：规则层全部规则求值且未命中 ⇒ `hard_rule_passed=true`。 */
export function normalPassed() {
  return {
    record: { task: 'ai_moderation', expectation: 'normal', labelClass: 'normal', gold: {} },
    output: { decision: 'published', hard_rule_passed: true },
  };
}

/** 正常样本被硬规则误伤（`hard_rule_passed=false`）⇒ 规则层误隔离，必须判负。 */
export function normalHitByHardRule() {
  return {
    record: { task: 'ai_moderation', expectation: 'normal', labelClass: 'normal', gold: {} },
    output: { decision: 'blocked', hard_rule_passed: false },
  };
}
