// 硬规则层口径回归（监工 PR #440 最后一条批复 `supervisor-1022-0541-pr440`，P2）。
//
// 被判负的形态（修复前）：`hardRulePass` 把**所有** risk 样本都要求 `hard_rule_passed === false`。
// 但仓内合法的 `blockingPort()`（`tests/unit/community-moderation-fixtures.mjs`）是
// "模型层 block + `hard_rule_passed === true`"：规则通过后由模型检出风险，图片风险更不可能被
// 文本硬规则全部命中。于是一条**合法且召回正确**的风险样本会把 `hardRulePass` 拖成 0，
// 目标 `target=1 eq` 随即把 ai_moderation 整条门禁判红——这不是能力缺口，是口径错误。
//
// 修复后的判据（只认样本显式字段，不靠标签名猜）：
//   · `gold.hardRuleExpectation='reject'` 的子集才要求 `hard_rule_passed === false`；
//   · `gold.hardRuleExpectation='pass'` 要求 `true`；
//   · 未声明的 normal 默认要求 `true`（硬规则不得误伤正常内容）；
//   · 未声明的 risk 不参与 `hardRulePass`，另报独立指标 `modelRiskIsolation`。
// 三条回归（a/b/c）分别覆盖：模型层合法隔离不再判负 / 显式硬规则失败仍红 / normal 照旧通过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiModerationMetrics, buildGates, evaluateRun, METRIC_GATES } from '../../packages/evaluation/index.mjs';
import { buildValidationSet, frozenManifestFor, coverageManifestFor } from './validation-fixture.mjs';
import {
  modelLayerBlockedRisk,
  declaredHardRuleRejectedRisk,
  declaredHardRuleEscapedRisk,
  normalPassed,
  normalHitByHardRule,
} from './hardrule-fixture.mjs';

const near = (a, b, message = `${a} !≈ ${b}`, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, message);

/** 取 `hardRulePass` 门禁（targets.mjs 的 target=1 / eq）——断言打在门禁结论上，不只看指标值。 */
function hardRuleGate(metrics, claimable = true) {
  const gate = buildGates('ai_moderation', metrics, METRIC_GATES, claimable).find((g) => g.metric === 'hardRulePass');
  assert.ok(gate, 'targets 必须包含 hardRulePass 门禁');
  return gate;
}

function runReport(records, predictions) {
  return evaluateRun(records, new Map(Object.entries(predictions)), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records),
    coverageManifest: coverageManifestFor(),
  });
}

// —— 回归 a：模型层 block + hard_rule_passed=true 的合法风险样本不再被 hardRulePass 判负 ——
test('[回归a] 模型层 block 且 hard_rule_passed=true 的风险样本：不参与 hardRulePass，不再判负', () => {
  const pairs = [modelLayerBlockedRisk(), declaredHardRuleRejectedRisk()];
  const m = aiModerationMetrics(pairs);

  // 风险召回照旧：模型层与规则层都能拦下，recall=1（旧口径下这条本来就正确）
  near(m.riskRecall.p, 1);

  // 硬规则指标只比较显式声明硬规则拒绝的那一条
  assert.equal(m.hardRulePass.checked, 1, '只有显式声明硬规则期望的样本进入 hardRulePass 分母');
  near(m.hardRulePass.p, 1, '模型层合法隔离不得再把 hardRulePass 拖成 0');
  assert.equal(m.hardRulePass.modelRiskExcluded, 1, '模型层风险样本应被计为"不参与本指标"');

  // 模型层读数单独报告，不丢
  assert.equal(m.modelRiskIsolation.count, 1);
  near(m.modelRiskIsolation.rate.p, 1);

  const gate = hardRuleGate(m);
  assert.equal(gate.status, 'pass');
  assert.equal(gate.observed, 1);
});

// —— 回归 b：显式硬规则失败样本仍判负、门禁仍红 ——
test('[回归b] 显式声明硬规则拒绝、规则层却放行 ⇒ hardRulePass 仍判负、门禁仍红', () => {
  const m = aiModerationMetrics([declaredHardRuleEscapedRisk(), normalPassed()]);
  assert.equal(m.hardRulePass.checked, 2);
  near(m.hardRulePass.p, 0.5);
  const gate = hardRuleGate(m);
  assert.equal(gate.status, 'fail', '漏拦必须把门禁判红（target=1 eq）');
  assert.equal(gate.observed, 0.5);
  assert.equal(gate.target, 1);

  // 真正的硬规则失败用例照旧计为通过（不是把整类风险样本排除掉了事）
  const ok = aiModerationMetrics([declaredHardRuleRejectedRisk()]);
  near(ok.hardRulePass.p, 1);
  assert.equal(hardRuleGate(ok).status, 'pass');
});

// —— 回归 c：normal 样本 hard_rule_passed=true 照旧通过（默认放行期望未放宽） ——
test('[回归c] normal 样本 hard_rule_passed=true 照旧通过；被硬规则误伤仍红', () => {
  const m = aiModerationMetrics([normalPassed(), normalPassed()]);
  assert.equal(m.hardRulePass.checked, 2, 'normal 未显式声明时按默认放行期望进入分母');
  assert.equal(m.hardRulePass.normalDefault, 2);
  near(m.hardRulePass.p, 1);
  assert.equal(hardRuleGate(m).status, 'pass');

  const hurt = aiModerationMetrics([normalHitByHardRule()]);
  near(hurt.hardRulePass.p, 0, '正常内容被硬规则命中 ⇒ 规则层误隔离，必须判负');
  assert.equal(hardRuleGate(hurt).status, 'fail');
});

// —— 显式声明非法值：fail-closed，不静默放过 ——
test('[口径] gold.hardRuleExpectation 取非法值 ⇒ 记未通过（不默认成功）', () => {
  const m = aiModerationMetrics([
    { record: { expectation: 'risk', gold: { hardRuleExpectation: 'maybe' } }, output: { decision: 'blocked', hard_rule_passed: true } },
  ]);
  assert.equal(m.hardRulePass.checked, 1);
  assert.equal(m.hardRulePass.invalidDeclaration, 1);
  near(m.hardRulePass.p, 0);
  assert.equal(hardRuleGate(m).status, 'fail');
});

// —— 端到端：真实的评估编排 + targets 门禁 ——
test('[端到端a] 把一条风险样本改为"模型层驳回 + 规则层通过"（不声明硬规则期望）⇒ 整条门禁仍 pass', () => {
  const { records, predictions } = buildValidationSet();
  const target = records.find((r) => r.task === 'ai_moderation' && r.expectation === 'risk');
  delete target.gold.hardRuleExpectation; // 该样本按"一般模型风险"登记（同 blockingPort 形态）
  const mutated = { ...predictions, [target.sampleId]: { decision: 'blocked', hard_rule_passed: true } };

  const report = runReport(records, mutated);
  assert.equal(report.isRealEvaluation, true, '夹具本身应可主张（否则门禁状态无意义）');
  const m = report.tasks.ai_moderation.metrics;
  assert.equal(m.hardRulePass.checked, 399, '只有 399 条显式硬规则/正常样本参与');
  near(m.hardRulePass.p, 1);
  assert.equal(m.modelRiskIsolation.count, 1);
  near(m.modelRiskIsolation.rate.p, 1);
  assert.equal(report.tasks.ai_moderation.gateStatus, 'pass');
  assert.equal(hardRuleGate(m, true).status, 'pass');
});

test('[端到端b] 把一条显式硬规则用例改成规则层放行 ⇒ 门禁必须 fail（不因新口径而放宽）', () => {
  const { records, predictions } = buildValidationSet();
  const target = records.find((r) => r.task === 'ai_moderation' && r.expectation === 'risk' && r.gold.hardRuleExpectation === 'reject');
  assert.ok(target, '夹具必须显式声明硬规则拒绝用例');
  const mutated = { ...predictions, [target.sampleId]: { decision: 'blocked', hard_rule_passed: true } };

  const report = runReport(records, mutated);
  const m = report.tasks.ai_moderation.metrics;
  assert.equal(m.hardRulePass.checked, 400);
  near(m.hardRulePass.p, 399 / 400);
  assert.equal(report.tasks.ai_moderation.gateStatus, 'fail');
  assert.equal(hardRuleGate(m, true).status, 'fail');
});
