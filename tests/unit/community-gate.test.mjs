/**
 * GY-I15（#15）阶段 1 · 发布前审核 gate 的 fail-closed 与版本绑定用例。
 *
 * 断言纪律：**先判 `typeof` 再判值**（`undefined` 不会被 `===` 的偶然相等蒙混过关）。
 * 证据边界：这些是规则夹具上的确定性回归，**不是**模型准确率／召回率证据，
 * 也不代表社区已端到端可用。
 *
 * 时钟确定性（参见 PR「测试确定性修复」）：本文件默认用 `makeGate()`（**冻结时钟**）构造闸门，
 * 使 `evaluateHardRules` 的 50ms **真实墙钟**预算（`DEFAULT_RULE_BUDGET_MS`）不会把机器负载
 * 变成测试结果；「预算耗尽 ⇒ 不得发布」由「反例 6」与末条「确定性」用例显式覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACTORY_RULE_COUNT,
  createPublishGate,
} from '../../services/api/src/community/moderation-gate.ts';
import { RULES, MATCHERS, isPublishable, evaluateReReview } from '../../packages/moderation/index.mjs';
import {
  buildScanLimitText,
  makeExtraRule,
  scriptedClock,
} from '../moderation/_fixtures.mjs';
import { FROZEN_CLOCK, makeGate } from './community-fixtures.mjs';

const TARGET = Object.freeze({ type: 'post', id: '00000000-0000-4000-8500-000000000001', revision: 1 });
const CLEAN = '今年雨水偏多，我按标签说明选择登记药剂，先看苗情再决定，注意轮换。';
const DANGEROUS = '我想把草甘膦和乙草胺一起打，效果会不会更好？';

function assertVerdictShape(outcome) {
  assert.equal(typeof outcome.decision, 'string', 'decision 必须是字符串');
  assert.equal(typeof outcome.hard_rule_passed, 'boolean', 'hard_rule_passed 必须是布尔');
  assert.equal(typeof outcome.publishable, 'boolean', 'publishable 必须是布尔');
  assert.ok(Array.isArray(outcome.reason_codes), 'reason_codes 必须是数组');
  assert.ok(Array.isArray(outcome.refusal_reason_codes), 'refusal_reason_codes 必须是数组');
  for (const code of outcome.reason_codes) {
    assert.equal(typeof code, 'string');
    assert.ok(code.length >= 1 && code.length <= 80, `reason_code 长度越界：${code}`);
  }
  assert.ok(outcome.reason_codes.length <= 30, 'reason_codes 不得超过契约上限 30');
  assert.equal(typeof outcome.rule_layer_only, 'boolean');
  assert.equal(outcome.wired_to_http, false, '本片不得声称已接 HTTP');
}

test('出厂规则集为 11 条，发布 gate 不缩小规则集（不得用空/小规则集换"通过"）', () => {
  assert.equal(typeof FACTORY_RULE_COUNT, 'number');
  assert.equal(FACTORY_RULE_COUNT, 11);
  assert.equal(RULES.length, 11);
  const gate = makeGate();
  assert.equal(gate.ruleCount(), 11);
  assert.equal(typeof gate.currentRuleVersion(), 'string');
  assert.ok(gate.currentRuleVersion().startsWith('mr1+sha256:'), 'rule_version 必须由规则集内容派生，不是手填串');
  assert.equal(typeof gate.currentRuleVersion(), typeof RULES[0].reason_code);
});

test('正控制：干净文本 ⇒ approved 且 publishable=true，且与 packages/moderation 的 isPublishable 一致', () => {
  const gate = makeGate();
  const outcome = gate.evaluate(TARGET, CLEAN, []);
  assertVerdictShape(outcome);
  assert.equal(outcome.decision, 'approved');
  assert.equal(outcome.hard_rule_passed, true);
  assert.equal(outcome.publishable, true);
  assert.deepEqual(outcome.reason_codes, []);
  assert.equal(outcome.rule_version, gate.currentRuleVersion());

  // 复用 packages/moderation 的发布口径独立复核（本模块不另写一套判定）。
  const reused = isPublishable(outcome, gate.currentRuleVersion());
  assert.equal(typeof reused.publishable, 'boolean');
  assert.equal(reused.publishable, outcome.publishable);
  assert.deepEqual(reused.reason_codes, []);
});

test('反例 1：确定性规则命中（危险混配）⇒ rejected 且 publishable=false，reason_codes 带上', () => {
  const gate = makeGate();
  const outcome = gate.evaluate(TARGET, DANGEROUS, []);
  assertVerdictShape(outcome);
  assert.equal(outcome.decision, 'rejected');
  assert.equal(outcome.hard_rule_passed, false);
  assert.equal(outcome.publishable, false);
  assert.ok(outcome.reason_codes.includes('DANGEROUS_MIX'), `应带 DANGEROUS_MIX，实际 ${outcome.reason_codes}`);
  assert.equal(outcome.fail_closed, false, 'rejected 是"明确命中"，不是 fail-closed 隔离');
  assert.ok(outcome.refusal_reason_codes.length >= 1);
  assert.equal(isPublishable(outcome, gate.currentRuleVersion()).publishable, false);
});

test('反例 2：带媒体（图片审核属模型层，未审）⇒ quarantined，不得发布', () => {
  const gate = makeGate();
  const outcome = gate.evaluate(TARGET, CLEAN, [{ media_id: '00000000-0000-4000-8500-0000000000ff' }]);
  assertVerdictShape(outcome);
  assert.equal(outcome.decision, 'quarantined');
  assert.equal(outcome.hard_rule_passed, false);
  assert.equal(outcome.publishable, false);
  assert.equal(outcome.fail_closed, true);
  assert.ok(
    outcome.reason_codes.includes('MEDIA_NOT_EVALUATED_BY_RULE_LAYER'),
    `应带 MEDIA_NOT_EVALUATED_BY_RULE_LAYER，实际 ${outcome.reason_codes}`,
  );
});

test('反例 3：文本为空/仅空白 ⇒ quarantined（"没有可审内容"不等于通过）', () => {
  const gate = makeGate();
  for (const text of ['', '   ', '\n\t ']) {
    const outcome = gate.evaluate(TARGET, text, []);
    assertVerdictShape(outcome);
    assert.equal(outcome.decision, 'quarantined', `text=${JSON.stringify(text)} 应隔离`);
    assert.equal(outcome.publishable, false);
    assert.ok(outcome.reason_codes.includes('INPUT_TEXT_EMPTY'));
  }
});

test('反例 4：落单代理项（编码异常）⇒ quarantined，不得发布', () => {
  const gate = makeGate();
  const outcome = gate.evaluate(TARGET, `苗情正常\uD800`, []);
  assertVerdictShape(outcome);
  assert.equal(outcome.decision, 'quarantined');
  assert.equal(outcome.publishable, false);
  assert.ok(outcome.reason_codes.includes('INPUT_TEXT_ENCODING_INVALID'), `实际 ${outcome.reason_codes}`);
});

test('反例 5：扫描限额截断 ⇒ RULE_SCAN_TRUNCATED + quarantined；未截断的同形文本仍 rejected（对照）', () => {
  const gate = makeGate();
  const truncated = gate.evaluate(TARGET, buildScanLimitText(64), []);
  assertVerdictShape(truncated);
  assert.equal(truncated.decision, 'quarantined');
  assert.equal(truncated.publishable, false);
  assert.ok(truncated.reason_codes.includes('RULE_SCAN_TRUNCATED'), `实际 ${truncated.reason_codes}`);
  assert.equal(truncated.counts.truncated >= 1, true, '必须至少有一条规则被记为 truncated');

  const notTruncated = gate.evaluate(TARGET, buildScanLimitText(63), []);
  assertVerdictShape(notTruncated);
  assert.equal(notTruncated.decision, 'rejected', '63 次重复时真实混配应被检查到，证明不是"一律隔离"');
  assert.equal(notTruncated.publishable, false);
});

test('反例 6：规则求值超时（预算耗尽）⇒ RULE_TIMEOUT + quarantined，不得发布', () => {
  const gate = makeGate({ budget_ms: 50, clock: scriptedClock([0, 1000, 1000]) });
  const outcome = gate.evaluate(TARGET, CLEAN, []);
  assertVerdictShape(outcome);
  assert.equal(outcome.decision, 'quarantined');
  assert.equal(outcome.publishable, false);
  assert.equal(outcome.hard_rule_passed, false);
  assert.ok(outcome.reason_codes.includes('RULE_TIMEOUT'), `实际 ${outcome.reason_codes}`);
  assert.equal(outcome.counts.evaluated, 0);
});

test('反例 7a：匹配器抛错被引擎捕获 ⇒ RULE_ENGINE_ERROR + quarantined（不吞成"未命中"）', () => {
  const brokenMatchers = {};
  for (const name of Object.keys(MATCHERS)) {
    brokenMatchers[name] = () => {
      throw new Error('boom: matcher');
    };
  }
  const gate = makeGate({ matchers: brokenMatchers });
  const outcome = gate.evaluate(TARGET, CLEAN, []);
  assertVerdictShape(outcome);
  assert.equal(outcome.decision, 'quarantined', '"规则跑了但炸了"必须隔离，不得当作未命中');
  assert.equal(outcome.hard_rule_passed, false);
  assert.equal(outcome.publishable, false);
  assert.equal(outcome.fail_closed, true);
  assert.ok(outcome.reason_codes.includes('RULE_ENGINE_ERROR'), `实际 ${outcome.reason_codes}`);
  assert.equal(outcome.counts.errors, 11);
});

test('反例 7b：规则层整体抛错（匹配器查表即炸）⇒ gate 自身 fail-closed，干净文本也不得发布', () => {
  const gate = makeGate({
    matchers: new Proxy(
      {},
      {
        get() {
          throw new Error('boom: matcher lookup');
        },
      },
    ),
  });
  const outcome = gate.evaluate(TARGET, CLEAN, []);
  assertVerdictShape(outcome);
  assert.equal(outcome.publishable, false, '规则层抛错时，连干净文本也不得发布');
  assert.equal(outcome.decision, 'quarantined');
  assert.equal(outcome.hard_rule_passed, false);
  assert.equal(outcome.engine_error, 'Error', 'gate 必须走"规则层抛错"的兜底路径，而不是当作未命中');
  assert.equal(outcome.counts.evaluated, 0, '抛错时没有任何规则被求值');
  assert.equal(outcome.counts.not_evaluated, 11);
  assert.equal(outcome.fail_closed, true);
  assert.ok(outcome.reason_codes.includes('RULE_ENGINE_ERROR'), `实际 ${outcome.reason_codes}`);
});

test('反例 8：规则集升级（rule_version 变化）⇒ 旧结论 stale 且不得继续可见', () => {
  const gateA = makeGate();
  const published = gateA.evaluate(TARGET, CLEAN, []);
  assert.equal(published.publishable, true);

  const upgraded = makeGate({ rules: [...RULES, makeExtraRule()] });
  assert.notEqual(upgraded.currentRuleVersion(), gateA.currentRuleVersion());
  const assessment = upgraded.assess(TARGET, published);
  assert.equal(typeof assessment.stale, 'boolean');
  assert.equal(assessment.stale, true);
  assert.equal(assessment.publishable, false, '旧版本结论不得套新规则集');
  assert.ok(assessment.reason_codes.includes('RULE_VERSION_CHANGED'), `实际 ${assessment.reason_codes}`);

  // 同一版本下仍可复用（证明不是"一律失效"）。
  const reused = gateA.assess(TARGET, published);
  assert.equal(reused.stale, false);
  assert.equal(reused.publishable, true);
  assert.equal(reused.inconsistent, false);

  // 并且与 packages/moderation 的 evaluateReReview 逐字段一致（本模块不另写一套）。
  const direct = evaluateReReview(published, {
    rule_version: upgraded.currentRuleVersion(),
    target_ref: TARGET,
  });
  assert.equal(direct.stale, assessment.stale);
  assert.deepEqual(direct.reason_codes, assessment.reason_codes);
});

test('反例 9：目标 revision 变化 ⇒ 旧结论失效须重审', () => {
  const gate = makeGate();
  const published = gate.evaluate(TARGET, CLEAN, []);
  const assessment = gate.assess({ ...TARGET, revision: 2 }, published);
  assert.equal(assessment.stale, true);
  assert.equal(assessment.publishable, false);
  assert.ok(assessment.reason_codes.includes('TARGET_REVISION_CHANGED'), `实际 ${assessment.reason_codes}`);
});

test('反例 10：自相矛盾的旧结论（approved 但 hard_rule_passed=false）不得可见', () => {
  const gate = makeGate();
  const published = gate.evaluate(TARGET, CLEAN, []);
  const tampered = { ...published, hard_rule_passed: false };
  const assessment = gate.assess(TARGET, tampered);
  assert.equal(assessment.stale, true);
  assert.equal(assessment.publishable, false);
  assert.ok(assessment.reason_codes.includes('DECISION_INCONSISTENT'), `实际 ${assessment.reason_codes}`);
});

test('反例 11：结论缺少 rule_version（证据不可信）⇒ 须重审并隔离', () => {
  const gate = makeGate();
  const published = gate.evaluate(TARGET, CLEAN, []);
  const assessment = gate.assess(TARGET, { ...published, rule_version: undefined });
  assert.equal(assessment.stale, true);
  assert.equal(assessment.publishable, false);
  assert.ok(assessment.reason_codes.includes('RULE_VERSION_UNKNOWN'), `实际 ${assessment.reason_codes}`);
});

test('反例 12：绑定结构非法（type 不在契约闭集 / revision=0）⇒ 不得可见', () => {
  const gate = makeGate();
  const published = gate.evaluate(TARGET, CLEAN, []);
  for (const broken of [
    { ...published, target_ref: { type: 'bogus', id: TARGET.id, revision: 1 } },
    { ...published, target_ref: { type: 'post', id: TARGET.id, revision: 0 } },
  ]) {
    const assessment = gate.assess(TARGET, broken);
    assert.equal(assessment.publishable, false, `非法绑定不得可见：${JSON.stringify(broken.target_ref)}`);
    assert.equal(assessment.stale, true);
  }
});

test('评定不变式：approved ⟺ hard_rule_passed=true，且 approved 时 counts 全干净', () => {
  const gate = makeGate();
  const outcome = gate.evaluate(TARGET, CLEAN, []);
  assert.equal(outcome.invariant.ok, true, `不变式违反：${outcome.invariant.violations.join('；')}`);
  assert.equal(outcome.decision === 'approved', outcome.hard_rule_passed === true);
  assert.equal(outcome.counts.total, 11);
  assert.equal(outcome.counts.evaluated, 11);
  assert.equal(outcome.counts.hits, 0);
  assert.equal(outcome.counts.errors, 0);
  assert.equal(outcome.counts.timeouts, 0);
  assert.equal(outcome.counts.truncated, 0);
  assert.equal(outcome.counts.not_evaluated, 0);
});

/**
 * 时钟确定性（本文件与夹具的默认闸门）：
 * 同一个"**同步忙等 >50ms**"的匹配器下——
 *   - 冻结时钟（`makeGate()` 默认 / `FROZEN_CLOCK`）：引擎照跑 11 条规则、`approved`；
 *   - 真实墙钟 + 默认 50ms 预算：**必然** `RULE_TIMEOUT` ⇒ `quarantined` ⇒ 不得发布。
 * 这条用例把"预算耗尽 ⇒ 不得判通过"的语义**留在覆盖内**，同时证明默认闸门不再受机器负载影响。
 */
test('确定性：慢匹配器在真实时钟下必然超预算不得发布，在冻结时钟（夹具默认）下正常 approved', () => {
  assert.equal(typeof FROZEN_CLOCK, 'function');
  assert.equal(FROZEN_CLOCK(), 0);
  assert.equal(FROZEN_CLOCK(), 0, '冻结时钟两次读数必须相同');

  // 规则 MR-01／02／03 用 negation_guarded_pattern：把它换成同步忙等 >50ms 的实现
  // （测试内注入匹配器，不改 packages/moderation 一行）。
  const busyMatcher = () => {
    const deadline = Date.now() + 60;
    while (Date.now() < deadline) {
      // 同步忙等：制造"规则求值本身占用了 >50ms 墙钟"的确定性场景。
    }
    return { matched: false, offset: null, length: 0 };
  };
  const slowMatchers = { ...MATCHERS, negation_guarded_pattern: busyMatcher };

  const realClockGate = createPublishGate({ matchers: slowMatchers });
  const realOutcome = realClockGate.evaluate(TARGET, CLEAN, []);
  assertVerdictShape(realOutcome);
  assert.equal(realOutcome.decision, 'quarantined', '真实时钟下忙等 >50ms 必然触发预算超时');
  assert.equal(realOutcome.hard_rule_passed, false);
  assert.equal(realOutcome.publishable, false, '预算耗尽绝不放行');
  assert.ok(realOutcome.reason_codes.includes('RULE_TIMEOUT'), `实际 ${realOutcome.reason_codes}`);
  assert.ok(realOutcome.counts.timeouts >= 1);

  const frozenGate = makeGate({ matchers: slowMatchers });
  const frozenOutcome = frozenGate.evaluate(TARGET, CLEAN, []);
  assertVerdictShape(frozenOutcome);
  assert.equal(frozenOutcome.decision, 'approved');
  assert.equal(frozenOutcome.publishable, true);
  assert.equal(frozenOutcome.counts.evaluated, 11, '规则仍然逐条求值（预算检查路径照跑）');
  assert.equal(frozenOutcome.counts.timeouts, 0);
});
