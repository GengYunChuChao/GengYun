/**
 * GY-I14 模型层（第二片）· **输入绑定**（返修 1 · 监工 `5488195507` P1）。
 *
 * 监工原样反例（本文件必须让它"先失败、后通过"）：
 *   1. 对干净正文 A 跑 `evaluateHardRules` ⇒ `approved`；
 *   2. **同一个 `target_ref` / `revision`** 下，把 `content.text` 换成硬规则会明确 `rejected` 的正文 B；
 *   3. 注入一个返回 pass 的假模型端口；
 *   4. 旧实现：`mergeModeration` 返回 **`approved`**（模型放行 B 时复用了 A 的硬规则结论，
 *      绕过"模型不能翻案"的硬边界）。
 *
 * 修复后：合流层重算"实际参与硬规则检查的输入"的规范化摘要并与结论自带的绑定比对，
 * 不一致即 **隔离**（`MODEL_LAYER_INPUT_BINDING_MISMATCH`），且**任何模型端口都覆盖不了这个拒绝**。
 *
 * 真实 `tms`/`ims` 一律不调：端口都是 `provider.synthetic === true` 的合成替身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AUDIT_STATES } from '../../packages/moderation/constants.mjs';
import {
  INPUT_BINDING_FIELD,
  INPUT_BINDING_SCHEMA,
  bindRuleResult,
  canonicalModerationInput,
  evaluateBoundHardRules,
  isDerivedInputDigest,
  moderationInputDigest,
  readInputBinding,
  verifyInputBinding,
} from '../../packages/moderation/input-binding.mjs';
import { checkMergedInvariant } from '../../packages/moderation/merged-invariant.mjs';
import { MODERATION_CONTRACT_FIELDS, mergeModeration } from '../../packages/moderation/merge.mjs';
import { DEFAULT_RULE_BUDGET_MS } from '../../packages/moderation/constants.mjs';
import { RULES } from '../../packages/moderation/rules.mjs';
import { scriptedClock } from './_fixtures.mjs';
import {
  CLEAN_RULE_RESULT,
  CLEAN_TEXT,
  IMAGE_REF,
  PRIVACY_TEXT,
  makeContent,
  makeMediaContent,
  makePort,
  runRules,
  runUnboundRules,
  stripInputBinding,
} from './_model-fixtures.mjs';

function expectQuarantinedWithoutApproval(merged, name) {
  assert.equal(typeof merged.decision, 'string', `${name}: decision 必须是字符串`);
  assert.equal(AUDIT_STATES.includes(merged.decision), true, `${name}: decision 越界`);
  assert.notEqual(merged.decision, 'approved', `${name}: 绝不允许 approved`);
  assert.deepEqual(checkMergedInvariant(merged).violations, [], `${name}: 违反合流不变式`);
}

// ---------------------------------------------------------------------------
// 1) 摘要本身的确定性口径
// ---------------------------------------------------------------------------

test('输入摘要：同值不同对象⇒同摘要；改正文／改媒体／改 target_ref 任一⇒摘要必变', () => {
  const base = makeContent();
  const same = makeContent();
  assert.notEqual(base, same, '夹具前提：不是同一个对象引用');
  assert.equal(moderationInputDigest(base), moderationInputDigest(same));
  assert.equal(isDerivedInputDigest(moderationInputDigest(base)), true);

  const variants = [
    ['正文改一个字', { ...base, text: `${CLEAN_TEXT}。` }],
    ['正文换成隐私文本', { ...base, text: PRIVACY_TEXT }],
    ['revision 改', { ...base, target_ref: { ...base.target_ref, revision: 2 } }],
    ['id 改', { ...base, target_ref: { ...base.target_ref, id: 'post-2002' } }],
    ['type 改', { ...base, target_ref: { ...base.target_ref, type: 'comment' } }],
    ['媒体新增一项', { ...base, media: [{ ...IMAGE_REF }] }],
  ];
  for (const [name, variant] of variants) {
    assert.notEqual(moderationInputDigest(variant), moderationInputDigest(base), `${name} 必须改变摘要`);
  }
});

test('输入摘要：媒体"数量相同、内容不同"必须不同（监工要求，不得只看数量）', () => {
  const m1 = makeMediaContent();
  const m2 = makeMediaContent({
    media: [{ ...IMAGE_REF, media_id: '55555555-5555-4555-8555-555555555555' }],
  });
  const m3 = makeMediaContent({
    media: [{ ...IMAGE_REF, mime: 'image/jpeg' }],
  });
  assert.equal(m1.media.length, m2.media.length, '夹具前提：媒体数量相同');
  assert.equal(m1.media.length, m3.media.length, '夹具前提：媒体数量相同');
  const d1 = moderationInputDigest(m1);
  assert.notEqual(moderationInputDigest(m2), d1, '数量相同、内容不同必须被识别');
  assert.notEqual(moderationInputDigest(m3), d1, '数量相同、MIME 不同必须被识别');
  // 保序口径：顺序变化也视为不同输入（宁多失效，不静默复用）。
  const reordered = makeMediaContent({ media: [{ ...IMAGE_REF, media_id: 'z-2' }, { ...IMAGE_REF, media_id: 'a-1' }] });
  const reorderedSwapped = makeMediaContent({ media: [{ ...IMAGE_REF, media_id: 'a-1' }, { ...IMAGE_REF, media_id: 'z-2' }] });
  assert.notEqual(moderationInputDigest(reordered), moderationInputDigest(reorderedSwapped));
});

test('输入摘要：只覆盖规则层真正读的输入面（未知顶层字段由规则层自己拒）', () => {
  const base = makeContent();
  const withUnknown = { ...base, note: '规则层会判 INPUT_UNKNOWN_FIELD' };
  // 规则层确实会拒未知字段（fail-closed），所以它不参与"内容绑定"的比对口径。
  assert.equal(runRules(withUnknown).reason_codes.includes('INPUT_UNKNOWN_FIELD'), true);
  assert.equal(moderationInputDigest(withUnknown), moderationInputDigest(base));
  const canonical = canonicalModerationInput(base);
  assert.deepEqual(Object.keys(canonical).sort(), ['domain', 'media', 'media_count', 'schema', 'target_ref', 'text']);
});

test('输入摘要：不接受手填固定串（先 typeof 再判值）', () => {
  for (const fake of ['mib1', 'mib1+sha256:abc', '', null, undefined, 42, {}]) {
    assert.equal(isDerivedInputDigest(fake), false, `${String(fake)} 不应被判为合法摘要`);
  }
});

// ---------------------------------------------------------------------------
// 2) 绑定入口与校验
// ---------------------------------------------------------------------------

test('evaluateBoundHardRules：只新增绑定字段，规则层既有字段逐字节不变（bound/raw 用同一可控时钟）', () => {
  const input = makeContent();
  // 返修 3 · 监工 `4248262134`：两侧都走夹具（注入**同一个可控时钟**），
  // 因此差异只可能来自"是否带绑定"，不会把墙钟抖动带进这条对照。
  const bound = runRules(input);
  const raw = runUnboundRules(input);
  const { [INPUT_BINDING_FIELD]: binding, ...ruleFields } = bound;
  assert.deepEqual(ruleFields, raw, '绑定必须是"加字段"，不得改动规则层任何既有字段');
  assert.equal(binding.schema, INPUT_BINDING_SCHEMA);
  assert.equal(binding.digest, moderationInputDigest(input));
  assert.equal(binding.media_count, 0);
  assert.equal(binding.text_length, input.text.length);
  assert.equal(readInputBinding(bound).present, true);
  // 同一可控时钟下连 `budget.elapsed_ms` 都一致（冻结时钟 ⇒ 确定值），无需再剔除墙钟字段。
  assert.equal(bound.budget.ms, raw.budget.ms);
  assert.equal(bound.budget.exhausted, false);
  assert.equal(bound.budget.elapsed_ms, raw.budget.elapsed_ms);
});

test('绑定入口保留预算语义：注入慢时钟 ⇒ bound/raw 两侧都不得判通过（预算失败覆盖不丢）', () => {
  const input = makeContent();
  const rawTimeout = runUnboundRules(input, { clock: scriptedClock([0, 1000]), budget_ms: DEFAULT_RULE_BUDGET_MS });
  const boundTimeout = runRules(input, { clock: scriptedClock([0, 1000]), budget_ms: DEFAULT_RULE_BUDGET_MS });
  for (const [name, result] of [['raw', rawTimeout], ['bound', boundTimeout]]) {
    assert.equal(typeof result.decision, 'string', `${name}: decision 必须是字符串`);
    assert.notEqual(result.decision, 'approved', `${name}: 预算耗尽不得判通过`);
    assert.equal(result.decision, 'quarantined', `${name}: 预算耗尽必须隔离`);
    assert.notEqual(result.hard_rule_passed, true, `${name}: 预算耗尽不得 hard_rule_passed=true`);
    assert.equal(result.reason_codes.includes('RULE_TIMEOUT'), true, `${name}: 缺 RULE_TIMEOUT`);
    assert.equal(result.counts.timeouts, RULES.length, `${name}: 全部规则都应记为 timeout`);
    assert.equal(result.counts.evaluated, 0, `${name}: 不得声称求值过`);
  }
  // 绑定只是"加字段"：超时结论同样带着它，且绑定不改变判定。
  assert.equal(typeof boundTimeout[INPUT_BINDING_FIELD]?.digest, 'string');
  assert.equal(boundTimeout.decision, rawTimeout.decision);
});

test('verifyInputBinding：一致⇒ok；缺失／摘要非法⇒MISSING；不一致⇒MISMATCH', () => {
  const input = makeContent();
  const bound = evaluateBoundHardRules(input);

  assert.equal(verifyInputBinding(bound, input).ok, true);
  assert.equal(verifyInputBinding(bound, makeContent()).ok, true, '同值不同对象也必须算一致');

  const missing = stripInputBinding(bound);
  const missingReport = verifyInputBinding(missing, input);
  assert.equal(missingReport.ok, false);
  assert.deepEqual(missingReport.reason_codes, ['MODEL_LAYER_INPUT_BINDING_MISSING']);

  const fakeDigest = bindRuleResult(raw(bound), input);
  fakeDigest[INPUT_BINDING_FIELD] = { schema: INPUT_BINDING_SCHEMA, digest: 'mib1+sha256:' + 'f'.repeat(32) };
  const fakeReport = verifyInputBinding(fakeDigest, input);
  assert.equal(fakeReport.ok, false);
  assert.deepEqual(fakeReport.reason_codes, ['MODEL_LAYER_INPUT_BINDING_MISMATCH']);

  const bogus = { ...bound, [INPUT_BINDING_FIELD]: { schema: 'nope', digest: 'x' } };
  assert.deepEqual(verifyInputBinding(bogus, input).reason_codes, ['MODEL_LAYER_INPUT_BINDING_MISSING']);
});

function raw(bound) {
  const { [INPUT_BINDING_FIELD]: _drop, ...rest } = bound;
  return rest;
}

// ---------------------------------------------------------------------------
// 3) 监工原样反例（先失败后通过）
// ---------------------------------------------------------------------------

test('P1 主反例（监工原样）：同 target_ref/revision 换正文 + 假模型 pass ⇒ 必须隔离，模型不得翻案', async () => {
  const contentA = makeContent({ text: CLEAN_TEXT });
  const ruleResultA = runRules(contentA); // 对 A 的硬规则结论：approved
  assert.equal(ruleResultA.decision, 'approved', '夹具前提：A 的硬规则结论是 approved');
  assert.equal(ruleResultA.hard_rule_passed, true);

  // B 是硬规则会明确 rejected 的正文（不是"无害的另一段字"）
  const contentB = makeContent({ text: PRIVACY_TEXT });
  assert.equal(contentB.target_ref.id, contentA.target_ref.id, '夹具前提：同 id');
  assert.equal(contentB.target_ref.revision, contentA.target_ref.revision, '夹具前提：同 revision');
  assert.equal(runRules(contentB).decision, 'rejected', '夹具前提：B 会被硬规则 rejected');

  let portCalls = 0;
  const passPort = makePort({
    evaluate: () => {
      portCalls += 1;
      return { label: 'pass', reason_codes: [], summary: 'synthetic pass' };
    },
  });

  const merged = await mergeModeration(ruleResultA, { content: contentB, ports: { tms: passPort } });

  expectQuarantinedWithoutApproval(merged, 'P1 主反例');
  assert.equal(merged.decision, 'quarantined');
  assert.equal(merged.reason_codes.includes('MODEL_LAYER_INPUT_BINDING_MISMATCH'), true, merged.reason_codes.join(','));
  // 模型确实跑了、确实返回了 pass —— 证明"不能靠模型 pass 覆盖这个拒绝"
  assert.equal(portCalls, 1, '端口必须被调用过（否则这条反例就没证明力）');
  assert.equal(merged.model_layer.kinds.tms.status, 'pass', '模型明确返回 pass');
  assert.equal(merged.input_binding.verified, false);
  assert.notEqual(merged.input_binding.digest, merged.input_binding.expected_digest);
  // 契约对象里不得出现绑定字段（binding 是非契约诊断）
  assert.notEqual(merged.contract_value, null, '隔离结论仍是完整契约对象（除 id）');
  for (const field of Object.keys(merged.contract_value)) {
    assert.equal(MODERATION_CONTRACT_FIELDS.includes(field), true, `${field} 不该出现在契约对象里`);
  }
});

test('P1 补充反例：结论没有输入绑定（只跑了 evaluateHardRules）⇒ 必须隔离', async () => {
  const content = makeContent();
  const unbound = runUnboundRules(content);
  assert.equal(unbound.decision, 'approved');
  assert.equal(Object.hasOwn(unbound, INPUT_BINDING_FIELD), false, '夹具前提：确实没绑定');

  const merged = await mergeModeration(unbound, { content, ports: { tms: makePort() } });
  expectQuarantinedWithoutApproval(merged, '缺绑定');
  assert.equal(merged.decision, 'quarantined');
  assert.equal(merged.reason_codes.includes('MODEL_LAYER_INPUT_BINDING_MISSING'), true, merged.reason_codes.join(','));
  assert.equal(merged.model_layer.kinds.tms.status, 'pass', '模型 pass 同样不得翻案');
  assert.equal(merged.input_binding.verified, false);
});

test('P1 媒体反例：媒体数量相同、内容不同 ⇒ 判定为输入不一致（不是"数量对了就算对"）', async () => {
  const mediaM1 = makeMediaContent();
  const mediaM2 = makeMediaContent({
    media: [{ ...IMAGE_REF, media_id: '66666666-6666-4666-8666-666666666666' }],
  });
  assert.equal(mediaM1.media.length, mediaM2.media.length);
  const ruleResultM1 = runRules(mediaM1);

  // 绑定层（与决策无关的锐利证明）：摘要不同 ⇒ 校验不通过
  assert.notEqual(moderationInputDigest(mediaM1), moderationInputDigest(mediaM2));
  const verify = verifyInputBinding(ruleResultM1, mediaM2);
  assert.equal(verify.ok, false);
  assert.deepEqual(verify.reason_codes, ['MODEL_LAYER_INPUT_BINDING_MISMATCH']);

  // 合流层：必须留下可判别原因，且绝不 approved
  const merged = await mergeModeration(ruleResultM1, {
    content: mediaM2,
    ports: { tms: makePort(), ims: makePort({ kind: 'ims' }) },
  });
  expectQuarantinedWithoutApproval(merged, '媒体替换');
  assert.equal(merged.reason_codes.includes('MODEL_LAYER_INPUT_BINDING_MISMATCH'), true, merged.reason_codes.join(','));
});

test('P1 正控制：正文与媒体都没变 ⇒ 仍 approved 且可发布（证明不是"一律隔离"）', async () => {
  const content = makeContent();
  const merged = await mergeModeration(runRules(content), { content, ports: { tms: makePort() } });
  assert.equal(merged.decision, 'approved');
  assert.equal(merged.hard_rule_passed, true);
  assert.equal(merged.input_binding.verified, true);
  assert.equal(merged.input_binding.digest, merged.input_binding.expected_digest);
  assert.equal(merged.model_layer.publishable.publishable, true);
  assert.equal(merged.model_layer.publishable.content_binding_verified, true);
  assert.equal(merged.model_layer.re_review.publishable, true);
  assert.equal(merged.model_layer.re_review.stale, false);

  // 同值但不同对象（回读路径常见：从库里读出来再和当前内容比）也必须算"没变"。
  const sameValues = makeContent({ text: CLEAN_TEXT });
  const merged2 = await mergeModeration(runRules(content), { content: sameValues, ports: { tms: makePort() } });
  assert.equal(merged2.decision, 'approved');
  assert.equal(merged2.input_binding.verified, true);
});

test('P1 边界：输入闸门不通过时合流层不尝试模型层，也不因此放行', async () => {
  const invalid = makeContent({ text: '   ' });
  const ruleResult = runRules(invalid);
  assert.equal(ruleResult.input.valid, false);
  const merged = await mergeModeration(ruleResult, { content: invalid, ports: { tms: makePort() } });
  assert.notEqual(merged.decision, 'approved');
  assert.equal(merged.model_layer.status, 'not_attempted');
});

test('P1 边界：规则层结论 + 内容都缺失（不传 content）⇒ 不得 approved', async () => {
  const merged = await mergeModeration(CLEAN_RULE_RESULT, { ports: { tms: makePort() } });
  assert.notEqual(merged.decision, 'approved');
  assert.equal(merged.decision, 'quarantined');
});
