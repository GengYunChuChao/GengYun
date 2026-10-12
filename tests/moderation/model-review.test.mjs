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
import { mergeModeration } from '../../packages/moderation/merge.mjs';
import {
  MODEL_BINDING_FIELDS,
  evaluateModelReReview,
  isModelLayerPublishable,
  modelBindingOf,
} from '../../packages/moderation/model-review.mjs';
import { derivePromptVersionForIds } from '../../packages/moderation/prompt-version.mjs';
import { CLEAN_RULE_RESULT, currentBinding, existingApproved, makeContent, makePort } from './_model-fixtures.mjs';

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

test('未变化 ⇒ reuse 且可发布（既有结论三版本齐备时）', async () => {
  const existing = await realApproved();
  const outcome = evaluateModelReReview(existing, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
    target_ref: makeContent().target_ref,
  });
  assert.equal(outcome.stale, false);
  assert.equal(outcome.action, 'reuse');
  assert.equal(outcome.landing, null);
  assert.equal(outcome.publishable, true);
  assert.deepEqual(outcome.reason_codes, []);
  assert.deepEqual([...MODEL_BINDING_FIELDS], ['rule_version', 'model_version', 'prompt_version']);
});

test('反例一：只改 rule_version ⇒ 失效（pending，沿用规则层码）', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION });
  const outcome = evaluateModelReReview(existing, {
    rule_version: `mr1+sha256:${'0'.repeat(32)}`,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
    target_ref: existing.target_ref,
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
  });
  expectStale(withoutModel, '当前模型版本未知');
  assert.equal(withoutModel.reason_codes.includes('MODEL_VERSION_UNKNOWN'), true);
  assert.equal(withoutModel.landing, DECISION_QUARANTINED);

  const withoutPrompt = evaluateModelReReview(existing, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    target_ref: existing.target_ref,
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

test('isModelLayerPublishable：approved + 三版本一致 ⇒ 可发布', () => {
  const existing = existingApproved({ prompt_version: PROMPT_VERSION });
  const report = isModelLayerPublishable(existing, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
  });
  assert.equal(report.publishable, true);
  assert.deepEqual(report.reason_codes, []);
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
    const report = isModelLayerPublishable(existing, options);
    assert.equal(report.publishable, false, `${name} 不得可发布`);
    assert.equal(report.reason_codes.includes(code), true, `${name} 缺 ${code}`);
    assert.equal(report.reason_codes.includes('NOT_PUBLISHABLE'), true);
  }

  const quarantined = existingApproved({ decision: 'quarantined', hard_rule_passed: false, prompt_version: PROMPT_VERSION });
  const report = isModelLayerPublishable(quarantined, {
    rule_version: RULE_VERSION,
    model_version: MODEL_VERSION,
    prompt_version: PROMPT_VERSION,
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
