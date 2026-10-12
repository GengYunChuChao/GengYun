/**
 * GY-I14 模型层（第二片）· **版本绑定与重审失效**（派单 §3.4）。
 *
 * 三组**独立**反例：分别只改 `rule_version` / `model_version` / `prompt_version`，
 * 既有结论都必须失效（`stale` + `re_review`），且**失败落点**沿用规则层口径：
 *   版本变化 ⇒ `pending`；版本缺失／证据不可信 ⇒ `quarantined`。
 *
 * 复用证据：规则层那部分（decision 自相矛盾、缺 rule_version、目标绑定变化）
 * 必须仍然由**规则层的 `evaluateReReview`** 判出来——本层不得另写一套。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DECISION_QUARANTINED, isAuditState } from '../../packages/moderation/constants.mjs';
import { REVIEW_ACTIONS, REVIEW_LANDINGS } from '../../packages/moderation/review.mjs';
import { checkMergedInvariant } from '../../packages/moderation/merged-invariant.mjs';
import { mergeModeration } from '../../packages/moderation/merge.mjs';
import {
  MODEL_BINDING_FIELDS,
  evaluateModelReReview,
  isModelLayerPublishable,
  modelBindingOf,
} from '../../packages/moderation/model-review.mjs';
import { derivePromptVersionForIds } from '../../packages/moderation/prompt-version.mjs';
import {
  CLEAN_RULE_RESULT,
  currentBinding,
  existingApproved,
  makeContent,
  makePort,
  stripInputBinding,
} from './_model-fixtures.mjs';

const PROMPT_VERSION = derivePromptVersionForIds(['text_moderation']);
const MODEL_VERSION = 'synthetic-tms-model@1.0';
const OTHER_VERSION = 'synthetic-tms-model@9.9';
const RULE_VERSION = CLEAN_RULE_RESULT.rule_version;

/** 取一个**真实合流出来的**已通过结论，作为"既有结论"。 */
async function realApproved() {
  const merged = await mergeModeration(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: makePort() } });
  assert.equal(merged.decision, 'approved', '夹具前提：能合流出 approved');
  return merged;
}

function expectStale(outcome, name) {
  assert.equal(typeof outcome.stale, 'boolean');
  assert.equal(outcome.stale, true, `${name}: 必须判定失效`);
  assert.equal(outcome.action, 're_review');
  assert.equal(REVIEW_ACTIONS.includes(outcome.action), true);
  assert.equal(REVIEW_LANDINGS.includes(outcome.landing), true);
  assert.equal(outcome.publishable, false, `${name}: 失效结论不得可发布`);
  assert.equal(outcome.reason_codes.includes('NOT_PUBLISHABLE'), true);
}

test('未变化 ⇒ reuse 且可发布（既有结论三版本齐备 + 绑定与当前内容一致）', async () => {
  const existing = await realApproved();
  const outcome = evaluateModelReReview(existing, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
    target_ref: makeContent().target_ref,
    input: makeContent(),
  });
  assert.equal(outcome.stale, false);
  assert.equal(outcome.action, 'reuse');
  assert.equal(outcome.landing, null);
  assert.equal(outcome.publishable, true);
  assert.deepEqual(outcome.reason_codes, []);
  assert.equal(outcome.content_binding_verified, true, '必须核到"绑定的是当前这份内容"');
  assert.deepEqual([...MODEL_BINDING_FIELDS], ['rule_version', 'model_version', 'prompt_version']);
});

test('反例一：只改 rule_version ⇒ 失效（pending，沿用规则层码）', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION });
  const outcome = evaluateModelReReview(existing, {
    rule_version: `mr1+sha256:${'0'.repeat(32)}`,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
    target_ref: existing.target_ref,
    input: makeContent(),
  });
  expectStale(outcome, '只改规则版本');
  assert.equal(outcome.reason_codes.includes('RULE_VERSION_CHANGED'), true);
  assert.equal(outcome.landing, 'pending');
  assert.equal(outcome.rule_layer.stale, true, '规则层那部分必须由规则层函数判出');
});

test('反例二：只改 model_version ⇒ 失效（pending）', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION });
  const outcome = evaluateModelReReview(existing, {
    rule_version: RULE_VERSION,
    model_version: OTHER_VERSION,
    prompt_version: PROMPT_VERSION,
    target_ref: existing.target_ref,
    input: makeContent(),
  });
  expectStale(outcome, '只改模型版本');
  assert.equal(outcome.reason_codes.includes('MODEL_VERSION_CHANGED'), true);
  assert.equal(outcome.landing, 'pending');
  assert.equal(outcome.reason_codes.includes('RULE_VERSION_CHANGED'), false, '不得把模型变化报成规则变化');
});

test('反例三：只改 prompt_version ⇒ 失效（pending）', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION });
  const outcome = evaluateModelReReview(existing, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: `mp1+sha256:${'f'.repeat(32)}`,
    target_ref: existing.target_ref,
    input: makeContent(),
  });
  expectStale(outcome, '只改 prompt 版本');
  assert.equal(outcome.reason_codes.includes('MODEL_PROMPT_VERSION_CHANGED'), true);
  assert.equal(outcome.landing, 'pending');
});

test('三个版本同时变化 ⇒ 三个原因码都在，且落 pending', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION });
  const outcome = evaluateModelReReview(existing, {
    rule_version: `mr1+sha256:${'1'.repeat(32)}`,
    model_version: OTHER_VERSION,
    prompt_version: `mp1+sha256:${'2'.repeat(32)}`,
    target_ref: existing.target_ref,
    input: makeContent(),
  });
  expectStale(outcome, '三版本同时变化');
  for (const code of ['RULE_VERSION_CHANGED', 'MODEL_VERSION_CHANGED', 'MODEL_PROMPT_VERSION_CHANGED']) {
    assert.equal(outcome.reason_codes.includes(code), true, `缺 ${code}`);
  }
  assert.equal(outcome.landing, 'pending');
});

test('证据不可信：既有结论缺 model_version ⇒ quarantined（未知不等于就没变化）', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION });
  delete existing.model_version;
  const outcome = evaluateModelReReview(existing, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
    target_ref: existing.target_ref,
    input: makeContent(),
  });
  expectStale(outcome, '缺模型版本');
  assert.equal(outcome.reason_codes.includes('MODEL_VERSION_UNKNOWN'), true);
  assert.equal(outcome.landing, DECISION_QUARANTINED);
});

test('证据不可信：调用方没给当前 model_version / prompt_version ⇒ quarantined', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION });
  const withoutModel = evaluateModelReReview(existing, {
    rule_version: RULE_VERSION,
    prompt_version: PROMPT_VERSION,
    target_ref: existing.target_ref,
    input: makeContent(),
  });
  expectStale(withoutModel, '当前模型版本未知');
  assert.equal(withoutModel.reason_codes.includes('MODEL_VERSION_UNKNOWN'), true);
  assert.equal(withoutModel.landing, DECISION_QUARANTINED);

  const withoutPrompt = evaluateModelReReview(existing, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    target_ref: existing.target_ref,
    input: makeContent(),
  });
  expectStale(withoutPrompt, '当前 prompt 版本未知');
  assert.equal(withoutPrompt.reason_codes.includes('MODEL_PROMPT_VERSION_UNKNOWN'), true);
  assert.equal(withoutPrompt.landing, DECISION_QUARANTINED);
});

test('证据不可信：既有结论缺 prompt_version ⇒ quarantined', () => {
  const existing = existingApproved();
  delete existing.prompt_version;
  const outcome = evaluateModelReReview(existing, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
    target_ref: existing.target_ref,
    input: makeContent(),
  });
  expectStale(outcome, '缺 prompt 版本');
  assert.equal(outcome.reason_codes.includes('MODEL_PROMPT_VERSION_UNKNOWN'), true);
  assert.equal(outcome.landing, DECISION_QUARANTINED);
});

test('复用规则层：approved 与 hard_rule_passed 自相矛盾 ⇒ DECISION_INCONSISTENT + quarantined', () => {
  const existing = existingApproved({ hard_rule_passed: false, prompt_version: PROMPT_VERSION });
  const outcome = evaluateModelReReview(existing, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
    target_ref: existing.target_ref,
    input: makeContent(),
  });
  expectStale(outcome, '自相矛盾');
  assert.equal(outcome.reason_codes.includes('DECISION_INCONSISTENT'), true);
  assert.equal(outcome.landing, DECISION_QUARANTINED);
});

test('复用规则层：缺 rule_version ⇒ RULE_VERSION_UNKNOWN + quarantined', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION });
  delete existing.rule_version;
  const outcome = evaluateModelReReview(existing, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
    target_ref: existing.target_ref,
    input: makeContent(),
  });
  expectStale(outcome, '缺规则版本');
  assert.equal(outcome.reason_codes.includes('RULE_VERSION_UNKNOWN'), true);
  assert.equal(outcome.landing, DECISION_QUARANTINED);
});

test('复用规则层：目标 revision 变化 ⇒ TARGET_REVISION_CHANGED + pending', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION });
  const outcome = evaluateModelReReview(existing, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
    target_ref: { ...existing.target_ref, revision: 2 },
    input: makeContent(),
  });
  expectStale(outcome, '目标修订变化');
  assert.equal(outcome.reason_codes.includes('TARGET_REVISION_CHANGED'), true);
  assert.equal(outcome.landing, 'pending');
});

test('复用规则层：非对象既有结论 ⇒ REVIEW_INPUT_INVALID + quarantined', () => {
  for (const value of [undefined, null, 'approved', 42, []]) {
    const outcome = evaluateModelReReview(value, {
      rule_version: RULE_VERSION,
      model_version: MODEL_VERSION,
      prompt_version: PROMPT_VERSION,
    });
    expectStale(outcome, `非法既有结论 ${String(value)}`);
    assert.equal(outcome.reason_codes.includes('REVIEW_INPUT_INVALID'), true);
    assert.equal(outcome.landing, DECISION_QUARANTINED);
  }
});

// ---------------------------------------------------------------------------
// 发布口径
// ---------------------------------------------------------------------------

test('isModelLayerPublishable：approved + 三版本一致 + 绑定与当前内容一致 ⇒ 可发布', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION });
  const report = isModelLayerPublishable(existing, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
    input: makeContent(),
  });
  assert.equal(report.publishable, true);
  assert.deepEqual(report.reason_codes, []);
  assert.equal(report.content_binding_verified, true);
  assert.deepEqual(report.binding, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
    rule_version_current: RULE_VERSION,
  });
});

test('isModelLayerPublishable：版本不一致 / 缺失 / 未通过 ⇒ 一律不可发布', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION });
  const cases = [
    ['模型版本变化', { rule_version: RULE_VERSION, model_version: OTHER_VERSION, prompt_version: PROMPT_VERSION }, 'MODEL_VERSION_CHANGED'],
    ['prompt 版本变化', { rule_version: RULE_VERSION, model_version: MODEL_VERSION, prompt_version: `mp1+sha256:${'3'.repeat(32)}` }, 'MODEL_PROMPT_VERSION_CHANGED'],
    ['规则版本变化', { rule_version: `mr1+sha256:${'4'.repeat(32)}`, model_version: MODEL_VERSION, prompt_version: PROMPT_VERSION }, 'RULE_VERSION_CHANGED'],
    ['未给模型版本', { rule_version: RULE_VERSION, prompt_version: PROMPT_VERSION }, 'MODEL_VERSION_UNKNOWN'],
    ['未给 prompt 版本', { rule_version: RULE_VERSION, model_version: MODEL_VERSION }, 'MODEL_PROMPT_VERSION_UNKNOWN'],
  ];
  for (const [name, options, code] of cases) {
    const report = isModelLayerPublishable(existing, { ...options, input: makeContent() });
    assert.equal(report.publishable, false, `${name} 不得可发布`);
    assert.equal(report.reason_codes.includes(code), true, `${name} 缺 ${code}`);
    assert.equal(report.reason_codes.includes('NOT_PUBLISHABLE'), true);
  }

  const quarantined = existingApproved({ decision: 'quarantined', hard_rule_passed: false, prompt_version: PROMPT_VERSION });
  const report = isModelLayerPublishable(quarantined, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
    input: makeContent(),
  });
  assert.equal(report.publishable, false);
  assert.equal(report.reason_codes.includes('NOT_PUBLISHABLE'), true);
  assert.equal(isAuditState(quarantined.decision), true);
});

test('modelBindingOf：缺项为 null，绝不填占位串；先 typeof 再判值', () => {
  assert.deepEqual(modelBindingOf(undefined), { rule_version: null, model_version: null, prompt_version: null });
  assert.deepEqual(modelBindingOf({ rule_version: 42, model_version: {}, prompt_version: [] }), {
    rule_version: null,
    model_version: null,
    prompt_version: null,
  });
  assert.deepEqual(modelBindingOf(existingApproved({ prompt_version: PROMPT_VERSION })), {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
  });
});

test('绑定字段清单与既有夹具口径一致（防止有人悄悄改字段名）', () => {
  const binding = currentBinding({ prompt_version: PROMPT_VERSION });
  assert.deepEqual(Object.keys(binding).sort(), ['model_version', 'prompt_version', 'rule_version', 'target_ref']);
});

// ---------------------------------------------------------------------------
// 返修 1 · 监工 5488195507 P2：两个放行闸门必须校验合流合法性与模型层失败原因
// ---------------------------------------------------------------------------

const VERSION_OPTIONS = {
  rule_version: RULE_VERSION,
  model_version: MODEL_VERSION,
  prompt_version: PROMPT_VERSION,
};

test('P2 主反例（监工原样）：approved + 版本匹配 + reason_codes=[MODEL_TIMEOUT] ⇒ 不得可发布、不得复用', () => {
  // 监工构造：结论自称 approved/hard_rule_passed=true/三版本匹配，但原因码里有模型层失败。
  const contradictory = existingApproved({ prompt_version: PROMPT_VERSION, reason_codes: ['MODEL_TIMEOUT'] });
  const options = { ...VERSION_OPTIONS, input: makeContent() };

  // 合法性单一事实来源先判它不合法（这一条是既有的，返修前闸门就是没查它）
  const invariant = checkMergedInvariant(contradictory);
  assert.equal(invariant.ok, false);
  assert.equal(
    invariant.violations.some((item) => item.includes('MODEL_TIMEOUT')),
    true,
    invariant.violations.join('；'),
  );

  const publishReport = isModelLayerPublishable(contradictory, options);
  assert.equal(publishReport.publishable, false, '自相矛盾结论不得可发布');
  assert.equal(publishReport.reason_codes.includes('MODEL_LAYER_INVARIANT_VIOLATION'), true, publishReport.reason_codes.join(','));
  assert.equal(publishReport.reason_codes.includes('MODEL_TIMEOUT'), true, '必须带上可判别的模型层失败原因');
  assert.equal(publishReport.reason_codes.includes('NOT_PUBLISHABLE'), true);

  const reviewOutcome = evaluateModelReReview(contradictory, options);
  assert.equal(reviewOutcome.publishable, false);
  assert.equal(reviewOutcome.stale, true, '不得按原样复用');
  assert.equal(reviewOutcome.action, 're_review');
  assert.notEqual(reviewOutcome.action, 'reuse');
  assert.equal(reviewOutcome.landing, DECISION_QUARANTINED);
  assert.equal(reviewOutcome.reason_codes.includes('MODEL_LAYER_INVARIANT_VIOLATION'), true, reviewOutcome.reason_codes.join(','));
  assert.equal(reviewOutcome.merged_legality.ok, false);
});

test('P2 同型反例：reason_codes=[MODEL_BLOCKED] 且自称 rejected ⇒ 不得可发布、不得复用', () => {
  const blocked = existingApproved({
    prompt_version: PROMPT_VERSION,
    decision: 'rejected',
    hard_rule_passed: false,
    reason_codes: ['MODEL_BLOCKED'],
  });
  const options = { ...VERSION_OPTIONS, input: makeContent() };

  const publishReport = isModelLayerPublishable(blocked, options);
  assert.equal(publishReport.publishable, false);
  assert.equal(publishReport.reason_codes.includes('MODEL_BLOCKED'), true, publishReport.reason_codes.join(','));
  // 这一条与"自相矛盾"不同：rejected 结论本身不违反合流不变式（不变式只对 approved 提必要条件），
  // 但"携带模型层失败原因 ⇒ 不得放行"的前置条件必须照样咬住它。
  assert.equal(publishReport.merged_legality.ok, false, '失败/blocked 原因必须进放行前置条件');
  assert.deepEqual(checkMergedInvariant(blocked).violations, [], '夹具前提：rejected 不触发不变式');

  const reviewOutcome = evaluateModelReReview(blocked, options);
  assert.equal(reviewOutcome.publishable, false);
  assert.equal(reviewOutcome.stale, true);
  assert.equal(reviewOutcome.action, 're_review');
  assert.equal(reviewOutcome.landing, DECISION_QUARANTINED);
});

test('P2 补充：既有的合理隔离结论（MODEL_TIMEOUT + quarantined）同样不得复用', () => {
  const quarantined = existingApproved({
    prompt_version: PROMPT_VERSION,
    decision: 'quarantined',
    hard_rule_passed: false,
    reason_codes: ['MODEL_TIMEOUT'],
  });
  const options = { ...VERSION_OPTIONS, input: makeContent() };
  const reviewOutcome = evaluateModelReReview(quarantined, options);
  assert.equal(reviewOutcome.stale, true, '有模型层失败原因的结论不得按原样复用');
  assert.equal(reviewOutcome.action, 're_review');
  assert.equal(reviewOutcome.publishable, false);
});

// ---------------------------------------------------------------------------
// 返修 1 · 监工 5488195507 P1 回读侧：闸门也必须核"绑的是不是这份内容"
// ---------------------------------------------------------------------------

test('P1 回读侧：既有结论没有输入绑定 ⇒ 不复用、不可发布（未知不等于没变化）', () => {
  const existing = stripInputBinding(existingApproved({ prompt_version: PROMPT_VERSION }));
  const options = { ...VERSION_OPTIONS, input: makeContent() };

  const publishReport = isModelLayerPublishable(existing, options);
  assert.equal(publishReport.publishable, false);
  assert.equal(publishReport.reason_codes.includes('MODEL_LAYER_INPUT_BINDING_MISSING'), true, publishReport.reason_codes.join(','));

  const reviewOutcome = evaluateModelReReview(existing, options);
  assert.equal(reviewOutcome.stale, true);
  assert.equal(reviewOutcome.action, 're_review');
  assert.equal(reviewOutcome.landing, DECISION_QUARANTINED);
});

test('P1 回读侧：有绑定但调用方没给当前内容 ⇒ 不得发布（内容是否仍是同一份未知）', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION });
  const publishReport = isModelLayerPublishable(existing, VERSION_OPTIONS);
  assert.equal(publishReport.publishable, false);
  assert.equal(publishReport.reason_codes.includes('MODEL_LAYER_INPUT_BINDING_UNVERIFIED'), true, publishReport.reason_codes.join(','));
  const reviewOutcome = evaluateModelReReview(existing, VERSION_OPTIONS);
  assert.equal(reviewOutcome.publishable, false);
  assert.equal(reviewOutcome.stale, true);
});

test('P1 回读侧：当前内容与结论绑定的正文不同 ⇒ MISMATCH、不复用、不可发布', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION }); // 绑的是干净正文 A
  const otherContent = makeContent({ text: '有事打我电话 13812345678，或者晚上再联系。' }); // B
  const options = { ...VERSION_OPTIONS, input: otherContent };

  const publishReport = isModelLayerPublishable(existing, options);
  assert.equal(publishReport.publishable, false);
  assert.equal(publishReport.reason_codes.includes('MODEL_LAYER_INPUT_BINDING_MISMATCH'), true, publishReport.reason_codes.join(','));

  const reviewOutcome = evaluateModelReReview(existing, options);
  assert.equal(reviewOutcome.stale, true);
  assert.equal(reviewOutcome.action, 're_review');
  assert.equal(reviewOutcome.landing, DECISION_QUARANTINED);
  assert.equal(reviewOutcome.reason_codes.includes('MODEL_LAYER_INPUT_BINDING_MISMATCH'), true);
});

// ---------------------------------------------------------------------------
// 返修 1 · 监工 5488195507 P2 第 2 条：导出消费者清查
// ---------------------------------------------------------------------------

test('导出清查：本包所有"能让外部拿到可发布/可复用结论"的出口都被逐一登记且有口径', async () => {
  const moderation = await import('../../packages/moderation/index.mjs');

  // 这 4 个是"拿一个结论 ⇒ 回答可发布/可复用/合法"的全部出口（改名或删除即红）。
  const GATE_EXPORTS = Object.freeze({
    isPublishable: 'rule-layer',
    isModelLayerPublishable: 'model-layer',
    evaluateModelReReview: 'model-layer',
    checkMergedInvariant: 'shared',
  });
  for (const [name, scope] of Object.entries(GATE_EXPORTS)) {
    assert.equal(typeof moderation[name], 'function', `${name} 必须作为出口存在（口径：${scope}）`);
  }

  // 模型层口径的三个出口（含共用的合法性函数）都必须拒绝监工那条自相矛盾结论。
  const contradictory = existingApproved({ prompt_version: PROMPT_VERSION, reason_codes: ['MODEL_TIMEOUT'] });
  const options = { ...VERSION_OPTIONS, input: makeContent() };
  assert.equal(moderation.checkMergedInvariant(contradictory).ok, false);
  assert.equal(moderation.isModelLayerPublishable(contradictory, options).publishable, false);
  assert.equal(moderation.evaluateModelReReview(contradictory, options).publishable, false);
  assert.equal(moderation.evaluateModelReReview(contradictory, options).action, 're_review');

  // `isPublishable` 是**规则层**口径（PR #88 已合并）：它只对规则层事实负责、不认识模型层码。
  // 因此本包的口径是"模型层结论必须走 isModelLayerPublishable"，不改规则层语义；
  // 这里只断言它仍然只做规则层那三件事（不把模型层码当自己的判定依据），
  // 不提"它放行"也不把该行为写死成期望（清查结论见 docs/moderation/model-layer.md 与 PR 正文）。
  const ruleOnly = { decision: 'approved', hard_rule_passed: true, rule_version: RULE_VERSION, target_ref: makeContent().target_ref };
  assert.equal(moderation.isPublishable(ruleOnly, RULE_VERSION).publishable, true);
  assert.equal(moderation.isPublishable({ ...ruleOnly, rule_version: 'mr1+sha256:' + '9'.repeat(32) }, RULE_VERSION).publishable, false);
});
