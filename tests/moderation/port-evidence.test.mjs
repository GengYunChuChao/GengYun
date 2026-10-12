/**
 * GY-I14 模型层（第二片）· **端口执行证据**（返修 2 · 监工 `5489050358` P1）。
 *
 * 监工原样反例（本文件必须让它"先失败、后通过"）：
 *   用 `existingApproved()` 构造一条**带有效 `input_binding`、三版本匹配、但完全没有
 *   `model_layer.kinds`** 的记录 ⇒ 旧实现 `checkMergedInvariant.ok=true`、
 *   `isModelLayerPublishable.publishable=true`、`evaluateModelReReview` 可复用。
 *   根因：不变式**只在 `kinds` 存在时**才检查端口状态 ⇒ "缺失/空对象"直接跳过，
 *   等于把**没有模型执行证据**当成**所有端口通过**。
 *
 * 修复口径（由**内容本身**决定需要哪些端口，不得由"结论里有没有 `kinds`"决定）：
 *   - 任何内容都要求 `tms` 的执行证据；
 *   - 内容带媒体时额外要求 `ims`；
 *   - `kinds` 缺失／空对象／缺所需端口／任一端口状态不是 `pass` ⇒ 一律不得放行、不得复用。
 *
 * 真实 `tms`/`ims` 一律不调：端口都是 `provider.synthetic === true` 的合成替身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DECISION_QUARANTINED } from '../../packages/moderation/constants.mjs';
import {
  checkMergedInvariant,
  modelExecutionEvidence,
  requiredModelPortKinds,
} from '../../packages/moderation/merged-invariant.mjs';
import { evaluateModelReReview, isModelLayerPublishable } from '../../packages/moderation/model-review.mjs';
import { derivePromptVersionForIds } from '../../packages/moderation/prompt-version.mjs';
import {
  CLEAN_RULE_RESULT,
  evidenceFor,
  existingApproved,
  makeContent,
  makeMediaContent,
  passKindEntry,
  stripModelLayerEvidence,
} from './_model-fixtures.mjs';

const PROMPT_VERSION = derivePromptVersionForIds(['text_moderation']);
const MODEL_VERSION = 'synthetic-tms-model@1.0';
const RULE_VERSION = CLEAN_RULE_RESULT.rule_version;

const TEXT_CONTENT = makeContent();
const MEDIA_CONTENT = makeMediaContent();
const VERSION_OPTIONS = {
  rule_version: RULE_VERSION,
  model_version: MODEL_VERSION,
  prompt_version: PROMPT_VERSION,
};

function withInput(options, input) {
  return { ...options, input };
}

test('所需端口由**内容**决定：文本 ⇒ 只需 tms；带媒体 ⇒ tms + ims', () => {
  assert.deepEqual(requiredModelPortKinds(TEXT_CONTENT), ['tms']);
  assert.deepEqual(requiredModelPortKinds(MEDIA_CONTENT), ['tms', 'ims']);
  // 结论里写了什么不影响所需集合：把结论的 kinds 改成"只有 ims"，所需集合仍由内容决定。
  const record = existingApproved({ prompt_version: PROMPT_VERSION });
  record.model_layer = { ...record.model_layer, kinds: { ims: passKindEntry('ims') } };
  assert.deepEqual(requiredModelPortKinds(TEXT_CONTENT), ['tms']);
  assert.equal(checkMergedInvariant(record, { input: TEXT_CONTENT }).ok, false, '缺 tms 证据不得通过');
});

test('P1 主反例（监工原样）：绑定有效 + 版本匹配，但**没有 model_layer.kinds** ⇒ 不得放行、不得复用', () => {
  const record = stripModelLayerEvidence(existingApproved({ prompt_version: PROMPT_VERSION }));
  assert.equal(Object.hasOwn(record, 'model_layer'), false, '夹具前提：确实没有模型层执行证据');
  assert.equal(typeof record.input_binding.digest, 'string', '夹具前提：有有效输入绑定');
  assert.equal(record.decision, 'approved');
  assert.equal(record.hard_rule_passed, true);

  const invariant = checkMergedInvariant(record, { input: TEXT_CONTENT });
  assert.equal(invariant.ok, false, '没有模型执行证据 ⇒ 绝不能判 ok');
  assert.equal(
    invariant.violations.some((item) => item.includes('模型执行证据')),
    true,
    invariant.violations.join('；'),
  );

  const publishReport = isModelLayerPublishable(record, withInput(VERSION_OPTIONS, TEXT_CONTENT));
  assert.equal(publishReport.publishable, false, '缺执行证据不得可发布');
  assert.equal(publishReport.reason_codes.includes('MODEL_LAYER_INVARIANT_VIOLATION'), true, publishReport.reason_codes.join(','));

  const reviewOutcome = evaluateModelReReview(record, withInput(VERSION_OPTIONS, TEXT_CONTENT));
  assert.equal(reviewOutcome.publishable, false);
  assert.equal(reviewOutcome.stale, true, '缺执行证据不得按原样复用');
  assert.equal(reviewOutcome.action, 're_review');
  assert.notEqual(reviewOutcome.action, 'reuse');
  assert.equal(reviewOutcome.landing, DECISION_QUARANTINED);
});

test('kinds 为空对象 ⇒ 不得放行、不得复用', () => {
  const record = existingApproved({ prompt_version: PROMPT_VERSION });
  record.model_layer = { ...record.model_layer, kinds: {} };
  const invariant = checkMergedInvariant(record, { input: TEXT_CONTENT });
  assert.equal(invariant.ok, false);
  assert.equal(invariant.violations.some((item) => item.includes('缺失或为空')), true, invariant.violations.join('；'));
  assert.equal(isModelLayerPublishable(record, withInput(VERSION_OPTIONS, TEXT_CONTENT)).publishable, false);
  assert.equal(evaluateModelReReview(record, withInput(VERSION_OPTIONS, TEXT_CONTENT)).action, 're_review');
});

test('kinds 缺 TMS（只报 IMS）⇒ 不得放行', () => {
  const record = existingApproved({ prompt_version: PROMPT_VERSION });
  record.model_layer = { ...record.model_layer, kinds: { ims: passKindEntry('ims') } };
  const invariant = checkMergedInvariant(record, { input: TEXT_CONTENT });
  assert.equal(invariant.ok, false);
  assert.equal(invariant.violations.some((item) => item.includes('缺少 tms')), true, invariant.violations.join('；'));
});

test('带媒体却缺 IMS 证据 ⇒ 不得放行（所需端口按内容来）', () => {
  const record = existingApproved({ prompt_version: PROMPT_VERSION, input: MEDIA_CONTENT });
  record.model_layer = { ...record.model_layer, kinds: { tms: passKindEntry('tms') } };
  const invariant = checkMergedInvariant(record, { input: MEDIA_CONTENT });
  assert.equal(invariant.ok, false);
  assert.equal(invariant.violations.some((item) => item.includes('缺少 ims')), true, invariant.violations.join('；'));
  const evidence = modelExecutionEvidence(record, { input: MEDIA_CONTENT });
  assert.deepEqual(evidence.required, ['tms', 'ims']);
  assert.equal(evidence.ok, false);
});

test('端口存在但状态不是"通过" ⇒ 一律不得放行（unsure/超时/未求值/失败/blocked）', () => {
  for (const status of ['unsure', 'timeout', 'not_invoked', 'failed', 'blocked', 'error']) {
    const record = existingApproved({ prompt_version: PROMPT_VERSION });
    record.model_layer = { ...record.model_layer, kinds: { tms: { ...passKindEntry('tms'), status } } };
    const invariant = checkMergedInvariant(record, { input: TEXT_CONTENT });
    assert.equal(invariant.ok, false, `status=${status} 必须判不可放行`);
    assert.equal(
      invariant.violations.some((item) => item.includes('状态不是通过')),
      true,
      `status=${status}: ${invariant.violations.join('；')}`,
    );
    assert.equal(isModelLayerPublishable(record, withInput(VERSION_OPTIONS, TEXT_CONTENT)).publishable, false);
  }
});

test('自报 media_count 与本次实际内容不一致（伪造形状以少核端口）⇒ 不得放行', () => {
  const record = existingApproved({ prompt_version: PROMPT_VERSION, input: MEDIA_CONTENT });
  record.input_binding = { ...record.input_binding, media_count: 0 }; // 自称"没有媒体"
  const invariant = checkMergedInvariant(record, { input: MEDIA_CONTENT });
  assert.equal(invariant.ok, false, '自报形状不可信时不得放行');
  assert.equal(
    invariant.violations.some((item) => item.includes('media_count')),
    true,
    invariant.violations.join('；'),
  );
});

test('无法确定所需端口（既无当前输入、绑定也无 media_count）⇒ 不得当作全部通过', () => {
  const record = existingApproved({ prompt_version: PROMPT_VERSION });
  delete record.input_binding.media_count;
  const invariant = checkMergedInvariant(record);
  assert.equal(invariant.ok, false);
  assert.equal(
    invariant.violations.some((item) => item.includes('无法确定本次内容需要哪些模型端口')),
    true,
    invariant.violations.join('；'),
  );
});

test('正控制：所需端口齐备且均为通过 ⇒ 仍可发布、仍可复用（证明不是"一律拒绝"）', () => {
  const record = existingApproved({ prompt_version: PROMPT_VERSION });
  const options = withInput(VERSION_OPTIONS, TEXT_CONTENT);
  const invariant = checkMergedInvariant(record, { input: TEXT_CONTENT });
  assert.equal(invariant.ok, true, invariant.violations.join('；'));
  assert.deepEqual(invariant.evidence.required, ['tms']);

  const publishReport = isModelLayerPublishable(record, options);
  assert.equal(publishReport.publishable, true);
  assert.deepEqual(publishReport.reason_codes, []);

  const reviewOutcome = evaluateModelReReview(record, options);
  assert.equal(reviewOutcome.stale, false);
  assert.equal(reviewOutcome.action, 'reuse');
  assert.equal(reviewOutcome.publishable, true);
});

test('正控制（媒体口径）：带媒体 + tms/ims 均通过 ⇒ 证据核对通过（单位级）', () => {
  const record = existingApproved({ prompt_version: PROMPT_VERSION, input: MEDIA_CONTENT });
  const invariant = checkMergedInvariant(record, { input: MEDIA_CONTENT });
  assert.equal(invariant.ok, true, invariant.violations.join('；'));
  assert.deepEqual(invariant.evidence.required, ['tms', 'ims']);
  assert.equal(invariant.evidence.ok, true);
  // 反面对照：同一内容，去掉 ims 证据即不可放行。
  const missingIms = { ...record, model_layer: { ...record.model_layer, kinds: { tms: passKindEntry('tms') } } };
  assert.equal(checkMergedInvariant(missingIms, { input: MEDIA_CONTENT }).ok, false);
});

test('三处口径一致：闸门把"缺执行证据"作为同一个不变式违例回传', () => {
  const record = stripModelLayerEvidence(existingApproved({ prompt_version: PROMPT_VERSION }));
  const options = withInput(VERSION_OPTIONS, TEXT_CONTENT);
  const invariant = checkMergedInvariant(record, { input: TEXT_CONTENT });
  const publishReport = isModelLayerPublishable(record, options);
  const reviewOutcome = evaluateModelReReview(record, options);

  assert.equal(invariant.ok, false);
  assert.equal(publishReport.publishable, false);
  assert.equal(reviewOutcome.publishable, false);
  // 三处看到的违例集合一致（同一个单一事实来源）
  assert.deepEqual(publishReport.merged_legality.invariant.violations, invariant.violations);
  assert.deepEqual(reviewOutcome.merged_legality.invariant.violations, invariant.violations);
  assert.equal(publishReport.merged_legality.invariant.evidence.ok, false);
  assert.equal(reviewOutcome.merged_legality.invariant.evidence.ok, false);
});

test('合法合流结果自带执行证据：真实 merge 输出的 kinds 与内容所需集合一致', () => {
  const textEvidence = evidenceFor(TEXT_CONTENT);
  assert.deepEqual(Object.keys(textEvidence.kinds), ['tms']);
  const mediaEvidence = evidenceFor(MEDIA_CONTENT);
  assert.deepEqual(Object.keys(mediaEvidence.kinds).sort(), ['ims', 'tms']);
});
