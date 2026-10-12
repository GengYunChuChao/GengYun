/**
 * GY-I14 模型层（第二片）· **prompt 版本派生**（派单 §3.3 硬性要求）。
 *
 * 核心断言：**改了 prompt 文本（哪怕一个字符）⇒ 版本必变**。
 * 否则旧结论会在 prompt 变更后被静默复用——这正是本层要防的事故形态。
 *
 * 另附"派生输入可复核"用例：`canonicalPromptPayload()` 导出了参与哈希的完整载荷，
 * 测试直接复核它，避免"哈希了什么"只能靠读源码猜。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VERSION_MAX_LENGTH } from '../../packages/moderation/constants.mjs';
import {
  ALL_PROMPTS_VERSION,
  PROMPT_VERSION_DIGEST_LENGTH,
  PROMPT_VERSION_SCHEMA,
  PROMPT_VERSIONS_BY_ID,
  canonicalPromptPayload,
  derivePromptVersion,
  derivePromptVersionForIds,
  isDerivedPromptVersion,
  normalizePromptList,
  promptSetDigest,
  validatePromptDefinition,
  validatePromptSet,
} from '../../packages/moderation/prompt-version.mjs';
import {
  PROMPT_DEFINITION_KEYS,
  PROMPT_DEFINITIONS,
  PROMPT_IDS,
  PROMPT_ID_BY_PORT_KIND,
  promptDefinition,
  promptIdForPortKind,
} from '../../packages/moderation/prompts.mjs';

const TEXT_PROMPT = PROMPT_DEFINITIONS.text_moderation;
const IMAGE_PROMPT = PROMPT_DEFINITIONS.image_moderation;

/** 派生串自助校验。 */
function expectDerived(value) {
  assert.equal(typeof value, 'string');
  assert.equal(isDerivedPromptVersion(value), true);
  assert.equal(value.startsWith(`${PROMPT_VERSION_SCHEMA}+sha256:`), true);
  assert.equal(value.length, PROMPT_VERSION_SCHEMA.length + 8 + PROMPT_VERSION_DIGEST_LENGTH);
  assert.ok(value.length <= VERSION_MAX_LENGTH);
}

test('prompt 版本由内容派生，不是手填字面量', () => {
  for (const id of PROMPT_IDS) {
    expectDerived(PROMPT_VERSIONS_BY_ID[id]);
    assert.equal(PROMPT_VERSIONS_BY_ID[id], derivePromptVersion(PROMPT_DEFINITIONS[id]));
  }
  expectDerived(ALL_PROMPTS_VERSION);
  assert.equal(ALL_PROMPTS_VERSION, derivePromptVersion(PROMPT_DEFINITIONS));
  for (const fake of ['v1', 'prompt-v1', 'mp1', 'mp1+sha256:abc', '', null, undefined, 123, {}]) {
    assert.equal(isDerivedPromptVersion(fake), false, `${String(fake)} 不应被判为派生版本`);
  }
});

test('改一个字符 ⇒ 版本必变（每个文本字段都要参与哈希）', () => {
  const base = derivePromptVersion(TEXT_PROMPT);
  const variants = [
    ['user_template 追加一个字符', { ...TEXT_PROMPT, user_template: `${TEXT_PROMPT.user_template}。` }],
    ['system 追加一个字符', { ...TEXT_PROMPT, system: `${TEXT_PROMPT.system}。` }],
    ['purpose 追加一个字符', { ...TEXT_PROMPT, purpose: `${TEXT_PROMPT.purpose}。` }],
    ['policy_notes 多一条', { ...TEXT_PROMPT, policy_notes: [...TEXT_PROMPT.policy_notes, '新增一条口径'] }],
    ['required_output_fields 多一项', { ...TEXT_PROMPT, required_output_fields: [...TEXT_PROMPT.required_output_fields, 'extra_field'] }],
    ['verdict_labels 少一个', { ...TEXT_PROMPT, verdict_labels: ['pass', 'block'] }],
    ['placeholders 与模板同时调整', {
      ...TEXT_PROMPT,
      placeholders: [...TEXT_PROMPT.placeholders, 'locale'],
      user_template: `${TEXT_PROMPT.user_template}\n语言：{{locale}}`,
    }],
  ];
  for (const [name, variant] of variants) {
    expectDerived(derivePromptVersion(variant));
    assert.notEqual(derivePromptVersion(variant), base, `${name} 必须改变 prompt 版本`);
  }
  // 图片 prompt 同样成立。
  assert.notEqual(
    derivePromptVersion({ ...IMAGE_PROMPT, user_template: `${IMAGE_PROMPT.user_template}。` }),
    derivePromptVersion(IMAGE_PROMPT),
  );
});

test('prompt 集合版本：顺序无关、但集合内容变化必变', () => {
  const forward = derivePromptVersion([TEXT_PROMPT, IMAGE_PROMPT]);
  const backward = derivePromptVersion([IMAGE_PROMPT, TEXT_PROMPT]);
  assert.equal(forward, backward, '定义顺序不得影响版本');
  assert.notEqual(forward, derivePromptVersion(TEXT_PROMPT), '集合版本必须区别于单 prompt 版本');
  assert.notEqual(forward, derivePromptVersion(IMAGE_PROMPT));
  assert.equal(derivePromptVersionForIds(['text_moderation', 'image_moderation']), forward);
  assert.equal(derivePromptVersionForIds(['image_moderation', 'text_moderation']), forward);
  assert.equal(derivePromptVersionForIds(['text_moderation']), PROMPT_VERSIONS_BY_ID.text_moderation);
});

test('派生输入可复核：canonicalPromptPayload 覆盖全部文本字段，且归一化集合', () => {
  const payload = canonicalPromptPayload();
  assert.equal(payload.prompts.length, PROMPT_IDS.length);
  const textEntry = payload.prompts.find((item) => item.id === 'text_moderation');
  assert.equal(textEntry.system, TEXT_PROMPT.system);
  assert.equal(textEntry.user_template, TEXT_PROMPT.user_template);
  assert.equal(textEntry.purpose, TEXT_PROMPT.purpose);
  assert.deepEqual(textEntry.placeholders, [...TEXT_PROMPT.placeholders].sort());
  assert.deepEqual(textEntry.required_output_fields, [...TEXT_PROMPT.required_output_fields].sort());
  // 归一化：传入集合顺序不同 ⇒ 规范化结果逐字节相同（因此版本相同）。
  assert.equal(
    JSON.stringify(canonicalPromptPayload([IMAGE_PROMPT, TEXT_PROMPT])),
    JSON.stringify(canonicalPromptPayload([TEXT_PROMPT, IMAGE_PROMPT])),
  );
  assert.equal(typeof promptSetDigest(TEXT_PROMPT), 'string');
  assert.equal(promptSetDigest(TEXT_PROMPT).length, 64);
});

test('prompt 定义非法 ⇒ 自检报错且派生拒绝（不得"按出厂定义跑一遍就算"）', () => {
  const cases = [
    ['id 为空', { ...TEXT_PROMPT, id: '' }, 'prompt.id'],
    ['system 为空', { ...TEXT_PROMPT, system: '   ' }, 'prompt.system'],
    ['user_template 缺失', { ...TEXT_PROMPT, user_template: undefined }, 'prompt.user_template'],
    ['placeholders 非数组', { ...TEXT_PROMPT, placeholders: 'text' }, 'prompt.placeholders'],
    ['占位符未出现在模板里', { ...TEXT_PROMPT, placeholders: ['never_used'] }, 'placeholders'],
    ['required_output_fields 缺 label', { ...TEXT_PROMPT, required_output_fields: ['summary'] }, 'label'],
    ['非对象', null, '对象'],
  ];
  for (const [name, prompt, keyword] of cases) {
    const problems = validatePromptDefinition(prompt);
    assert.ok(problems.length > 0, `${name} 应被判非法`);
    assert.equal(problems.some((item) => item.includes(keyword)), true, `${name} 的报错应提到 ${keyword}：${problems.join('；')}`);
    assert.throws(() => derivePromptVersion(prompt), `${name} 时派生必须抛错`);
  }

  const emptySet = validatePromptSet([]);
  assert.equal(emptySet.valid, false);
  assert.equal(emptySet.errors.some((item) => item.includes('为空')), true);
  assert.throws(() => derivePromptVersion([]));

  const duplicated = validatePromptSet([TEXT_PROMPT, TEXT_PROMPT]);
  assert.equal(duplicated.valid, false);
  assert.equal(duplicated.errors.some((item) => item.includes('重复')), true);
});

test('没有 prompt 参与筛查时不得派生版本（零个 prompt ≠ 已筛查）', () => {
  assert.throws(() => derivePromptVersionForIds([]));
  assert.throws(() => derivePromptVersionForIds(['not_a_prompt']));
  assert.throws(() => derivePromptVersionForIds('text_moderation'));
});

test('normalizePromptList：映射／单条／数组／缺省四种形态归一一致', () => {
  assert.equal(normalizePromptList(undefined).length, PROMPT_IDS.length);
  assert.deepEqual(normalizePromptList(TEXT_PROMPT), [TEXT_PROMPT]);
  assert.deepEqual(normalizePromptList([TEXT_PROMPT]), [TEXT_PROMPT]);
  assert.equal(normalizePromptList(PROMPT_DEFINITIONS).length, PROMPT_IDS.length);
});

test('prompt 定义表结构稳定：闭集 id、端口映射唯一、定义键受控', () => {
  assert.deepEqual([...PROMPT_IDS], ['text_moderation', 'image_moderation']);
  assert.deepEqual(PROMPT_ID_BY_PORT_KIND, { tms: 'text_moderation', ims: 'image_moderation' });
  assert.equal(promptIdForPortKind('tms'), 'text_moderation');
  assert.equal(promptIdForPortKind('ims'), 'image_moderation');
  assert.equal(promptIdForPortKind('xms'), null);
  assert.equal(promptIdForPortKind(undefined), null);
  assert.equal(promptDefinition('text_moderation'), TEXT_PROMPT);
  assert.equal(promptDefinition('nope'), null);
  for (const prompt of Object.values(PROMPT_DEFINITIONS)) {
    assert.deepEqual(Object.keys(prompt).sort(), [...PROMPT_DEFINITION_KEYS].sort(), '未声明的键必须显式登记');
    assert.equal(validatePromptDefinition(prompt).length, 0);
    assert.equal(prompt.required_output_fields.includes('label'), true);
    for (const label of ['pass', 'block', 'unsure']) {
      assert.equal(prompt.verdict_labels.includes(label), true, `${prompt.id} 必须声明 ${label} 标签`);
    }
  }
});
