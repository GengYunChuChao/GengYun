/**
 * GY-I14 确定性硬规则审核层 · rule_version 派生与版本重审（派单 §4.2）。
 *
 * 必须证明：规则集变化 ⇒ `rule_version` 变化 ⇒ 旧结果被判定失效、必须重审，
 * **不得**静默复用旧判定；并明确重审落点。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MATCHERS, MATCHER_REVISIONS } from '../../packages/moderation/matchers.mjs';
import { RULES, validateRuleCatalog } from '../../packages/moderation/rules.mjs';
import {
  RULE_SET_DIGEST,
  RULE_VERSION,
  RULE_VERSION_SCHEMA,
  deriveRuleVersion,
  isDerivedRuleVersion,
  ruleSetDigest,
  stableStringify,
} from '../../packages/moderation/rule-version.mjs';
import { evaluateReReview, isPublishable, REVIEW_ACTIONS } from '../../packages/moderation/review.mjs';
import { CLEAN_TEXT, makeExtraRule, makeInput, runRules } from './_fixtures.mjs';

test('rule_version 由规则集内容派生：格式固定、与摘要一致、长度合规', () => {
  assert.equal(isDerivedRuleVersion(RULE_VERSION), true);
  assert.equal(RULE_VERSION.startsWith(`${RULE_VERSION_SCHEMA}+sha256:`), true);
  assert.equal(RULE_VERSION, `${RULE_VERSION_SCHEMA}+sha256:${RULE_SET_DIGEST.slice(0, 32)}`);
  assert.equal(RULE_SET_DIGEST.length, 64);
  assert.ok(RULE_VERSION.length <= 80);
  assert.match(RULE_SET_DIGEST, /^[0-9a-f]{64}$/);
});

test('rule_version 稳定：同一规则集重复派生结果一致（跨调用、无随机）', () => {
  for (let index = 0; index < 5; index += 1) {
    assert.equal(deriveRuleVersion(), RULE_VERSION);
    assert.equal(ruleSetDigest(), RULE_SET_DIGEST);
  }
});

test('规则集内容变化 ⇒ rule_version 必然变化', () => {
  const added = [...RULES, makeExtraRule()];
  const patternChanged = RULES.map((rule) =>
    rule.id === 'MR-01' ? { ...rule, patterns: [...rule.patterns, /拌种/] } : rule,
  );
  const descriptionChanged = RULES.map((rule) =>
    rule.id === 'MR-01' ? { ...rule, description: `${rule.description}（文案微调）` } : rule,
  );
  const orderChanged = [...RULES].reverse();
  const removed = RULES.slice(1);
  const matchersChanged = { ...MATCHERS, any_pattern: (text, rule) => ({ matched: false, field: 'text', offset: null, length: 0, suppressed: 0, extra: rule.id }) };
  const revisionsChanged = { ...MATCHER_REVISIONS, any_pattern: MATCHER_REVISIONS.any_pattern + 1 };

  for (const [name, rules] of [
    ['追加规则', added],
    ['修改模式', patternChanged],
    ['修改说明文案', descriptionChanged],
    ['调换规则顺序', orderChanged],
    ['删除规则', removed],
  ]) {
    assert.equal(validateRuleCatalog(rules, MATCHERS).valid, true, `${name}: 夹具规则集应合法`);
    assert.notEqual(deriveRuleVersion(rules, MATCHERS), RULE_VERSION, `${name} 应改变 rule_version`);
  }
  assert.notEqual(deriveRuleVersion(RULES, matchersChanged), RULE_VERSION, '匹配器实现变化应改变 rule_version');
  assert.notEqual(
    deriveRuleVersion(RULES, MATCHERS, revisionsChanged),
    RULE_VERSION,
    '匹配器版本号变化应改变 rule_version',
  );
});

test('stableStringify：键序无关、RegExp 归一、特殊值显式标注', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.equal(stableStringify(/ab/iu), stableStringify(/ab/ui));
  assert.notEqual(stableStringify(/ab/), stableStringify(/ab/u));
  assert.equal(stableStringify(undefined), '"<undefined>"');
  assert.notEqual(stableStringify(undefined), stableStringify(null));
});

test('版本重审：规则集变化后旧结果失效、必须重审（落点 pending）', () => {
  const input = makeInput({ text: CLEAN_TEXT });
  const oldResult = runRules(input);
  assert.equal(oldResult.decision, 'approved');
  assert.equal(oldResult.rule_version, RULE_VERSION);

  // 同一版本、同一目标：可沿用，且可发布（approved + hard_rule_passed=true + 版本一致）。
  const same = evaluateReReview(oldResult, { rule_version: RULE_VERSION, target_ref: input.target_ref });
  assert.equal(same.stale, false);
  assert.equal(same.action, 'reuse');
  assert.equal(same.landing, null);
  assert.equal(same.publishable, true);

  // 规则集变化 ⇒ 新 rule_version ⇒ 旧结果失效。
  const mutatedRules = [...RULES, makeExtraRule()];
  const newVersion = deriveRuleVersion(mutatedRules, MATCHERS);
  assert.notEqual(newVersion, RULE_VERSION);

  const after = evaluateReReview(oldResult, { rule_version: newVersion, target_ref: input.target_ref });
  assert.equal(after.stale, true, '规则集变化必须使旧结果失效');
  assert.equal(after.action, 're_review');
  assert.notEqual(after.action, 'reuse');
  assert.equal(after.landing, 'pending');
  assert.ok(after.reason_codes.includes('RULE_VERSION_CHANGED'));
  assert.equal(after.publishable, false);

  // 旧结果在新版本下不得发布（"旧版本审核结果不能套新版本"）。
  assert.deepEqual(isPublishable(oldResult, newVersion), {
    publishable: false,
    reason_codes: ['RULE_VERSION_CHANGED'],
  });
  assert.equal(isPublishable(oldResult, RULE_VERSION).publishable, true);

  // 新规则集下重跑，同一文本的结论真的变了（不是"换个版本号但行为不变"）。
  const rerun = runRules(input, { rules: mutatedRules, matchers: MATCHERS });
  assert.equal(rerun.rule_version, newVersion);
  assert.equal(rerun.decision, 'rejected');
  assert.ok(rerun.reason_codes.includes('COMMERCE_SOLICITATION'));
});

test('版本重审：目标 revision 变化 ⇒ 旧结果失效（编辑生成新版本重审）', () => {
  const input = makeInput({ text: CLEAN_TEXT });
  const oldResult = runRules(input);
  const outcome = evaluateReReview(oldResult, {
    rule_version: RULE_VERSION,
    target_ref: { type: 'post', id: input.target_ref.id, revision: 2 },
  });
  assert.equal(outcome.stale, true);
  assert.equal(outcome.action, 're_review');
  assert.equal(outcome.landing, 'pending');
  assert.ok(outcome.reason_codes.includes('TARGET_REVISION_CHANGED'));
  assert.equal(outcome.publishable, false);
});

test('版本重审：目标 type/id 变化 ⇒ 失效且隔离（不是同一个对象）', () => {
  const input = makeInput({ text: CLEAN_TEXT });
  const oldResult = runRules(input);
  for (const changed of [
    { type: 'comment', id: input.target_ref.id, revision: 1 },
    { type: 'post', id: 'post-9999', revision: 1 },
  ]) {
    const outcome = evaluateReReview(oldResult, { rule_version: RULE_VERSION, target_ref: changed });
    assert.equal(outcome.stale, true);
    assert.equal(outcome.landing, 'quarantined');
    assert.ok(outcome.reason_codes.includes('TARGET_REF_CHANGED'));
  }
});

// ---- 重审绑定结构校验（返修轮 3 · 监工 P2）----

const BINDING_REVIEW_BASE = { decision: 'approved', hard_rule_passed: true, rule_version: RULE_VERSION };

for (const item of [
  {
    name: 'target_ref.type 不在契约闭集',
    ref: { type: 'bogus', id: 'post-1001', revision: 1 },
  },
  {
    name: 'target_ref.id 为空串',
    ref: { type: 'post', id: '', revision: 1 },
  },
  {
    name: 'target_ref.id 超过 80 字符',
    ref: { type: 'post', id: 'x'.repeat(81), revision: 1 },
  },
  {
    name: 'target_ref.revision 为 0',
    ref: { type: 'post', id: 'post-1001', revision: 0 },
  },
  {
    name: 'target_ref.revision 非整数',
    ref: { type: 'post', id: 'post-1001', revision: 1.5 },
  },
]) {
  test(`重审绑定结构非法：${item.name} ⇒ 失效且隔离，不得 reuse／publishable`, () => {
    const existing = { ...BINDING_REVIEW_BASE, target_ref: item.ref };
    const outcome = evaluateReReview(existing, { rule_version: RULE_VERSION, target_ref: item.ref });
    assert.equal(outcome.stale, true);
    assert.equal(outcome.action, 're_review');
    assert.notEqual(outcome.action, 'reuse');
    assert.equal(outcome.landing, 'quarantined');
    assert.equal(outcome.publishable, false);
    assert.ok(
      outcome.reason_codes.includes('TARGET_REF_INVALID'),
      `缺原因码 TARGET_REF_INVALID：${outcome.reason_codes.join(',')}`,
    );
    // 非法绑定不得被发布口径放行。
    assert.equal(isPublishable(existing, RULE_VERSION).publishable, false);
    assert.ok(isPublishable(existing, RULE_VERSION).reason_codes.includes('TARGET_REF_INVALID'));
  });
}

test('重审绑定结构：传入的"当前目标"结构非法同样隔离，不得 reuse', () => {
  const validRef = { type: 'post', id: 'post-1001', revision: 1 };
  const existing = { ...BINDING_REVIEW_BASE, target_ref: validRef };
  for (const bad of [
    { type: 'bogus', id: 'post-1001', revision: 1 },
    { type: 'post', id: '', revision: 1 },
    { type: 'post', id: 'post-1001', revision: 0 },
  ]) {
    const outcome = evaluateReReview(existing, { rule_version: RULE_VERSION, target_ref: bad });
    assert.equal(outcome.stale, true);
    assert.equal(outcome.landing, 'quarantined');
    assert.equal(outcome.publishable, false);
    assert.ok(outcome.reason_codes.includes('TARGET_REF_INVALID'));
  }
  // 合法对照不受影响。
  const ok = evaluateReReview(existing, { rule_version: RULE_VERSION, target_ref: validRef });
  assert.equal(ok.stale, false);
  assert.equal(ok.action, 'reuse');
  assert.equal(ok.publishable, true);
});

test('版本重审：缺 rule_version／decision 非法／自称通过却未过 = 失效且隔离', () => {
  const target_ref = { type: 'post', id: 'post-1001', revision: 1 };
  const cases = [
    {
      name: '缺 rule_version',
      existing: { decision: 'approved', hard_rule_passed: true, rule_version: undefined, target_ref },
      code: 'RULE_VERSION_UNKNOWN',
    },
    {
      name: 'rule_version 为空串',
      existing: { decision: 'approved', hard_rule_passed: true, rule_version: '', target_ref },
      code: 'RULE_VERSION_UNKNOWN',
    },
    {
      name: 'decision 非法',
      existing: { decision: 'maybe_ok', hard_rule_passed: true, rule_version: RULE_VERSION, target_ref },
      code: 'DECISION_INVALID',
    },
    {
      name: 'approved 但 hard_rule_passed 为 false（PR #82 的 P1 形态）',
      existing: { decision: 'approved', hard_rule_passed: false, rule_version: RULE_VERSION, target_ref },
      code: 'DECISION_INCONSISTENT',
    },
    {
      name: 'approved 但 hard_rule_passed 缺失',
      existing: { decision: 'approved', hard_rule_passed: undefined, rule_version: RULE_VERSION, target_ref },
      code: 'DECISION_INCONSISTENT',
    },
    {
      name: 'target_ref 缺失',
      existing: { decision: 'approved', hard_rule_passed: true, rule_version: RULE_VERSION },
      code: 'REVIEW_INPUT_INVALID',
    },
  ];
  for (const item of cases) {
    const outcome = evaluateReReview(item.existing, { rule_version: RULE_VERSION, target_ref });
    assert.equal(outcome.stale, true, `${item.name} 应判失效`);
    assert.equal(outcome.action, 're_review');
    assert.equal(outcome.landing, 'quarantined');
    assert.ok(outcome.reason_codes.includes(item.code), `${item.name} 缺码 ${item.code}`);
    assert.equal(outcome.publishable, false);
  }
});

test('版本重审：非对象输入与非 approved 决策都不产生"可发布"结论', () => {
  for (const bad of [null, undefined, 42, 'approved', []]) {
    const outcome = evaluateReReview(bad, { rule_version: RULE_VERSION });
    assert.equal(outcome.stale, true);
    assert.equal(outcome.landing, 'quarantined');
    assert.equal(outcome.publishable, false);
    assert.ok(outcome.reason_codes.includes('REVIEW_INPUT_INVALID'));
  }
  const pending = { decision: 'pending', hard_rule_passed: false, rule_version: RULE_VERSION, target_ref: { type: 'post', id: 'p-1', revision: 1 } };
  const outcome = evaluateReReview(pending, { rule_version: RULE_VERSION });
  assert.equal(outcome.stale, false);
  assert.equal(outcome.action, 'reuse');
  assert.equal(outcome.publishable, false);
  assert.ok(outcome.reason_codes.includes('NOT_PUBLISHABLE'));
});

test('重审动作闭集：只允许 reuse / re_review', () => {
  const target_ref = { type: 'post', id: 'p-1', revision: 1 };
  const samples = [
    { decision: 'approved', hard_rule_passed: true, rule_version: RULE_VERSION, target_ref },
    { decision: 'approved', hard_rule_passed: true, rule_version: 'old-version', target_ref },
    { decision: 'approved', hard_rule_passed: false, rule_version: RULE_VERSION, target_ref },
    null,
  ];
  for (const sample of samples) {
    const outcome = evaluateReReview(sample, { rule_version: RULE_VERSION, target_ref });
    assert.ok(REVIEW_ACTIONS.includes(outcome.action), `非法动作 ${outcome.action}`);
    assert.equal(typeof outcome.stale, 'boolean');
    assert.ok(outcome.landing === null || outcome.landing === 'pending' || outcome.landing === 'quarantined');
  }
});
