/**
 * GY-I14 确定性硬规则审核层 · 契约一致性回归。
 *
 * 只读比对 packages/contracts（states.json / openapi.json）：
 *   闭集值不得新增、长度上限不得自创、模型层字段不得被本片伪造。
 * 这些用例的作用是"契约一变就红"，避免组件静默漂移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  AUDIT_STATES,
  COVERED_TARGET_TYPES,
  FAIL_CLOSED_REASON_CODES,
  MODEL_LAYER_FIELDS,
  MODERATION_FIELD_LAYERS,
  PERSISTENCE_LAYER_FIELDS,
  REASON_CODES_MAX_ITEMS,
  REASON_CODE_MAX_LENGTH,
  REASON_CODE_MIN_LENGTH,
  RULE_CATEGORIES,
  RULE_LAYER_FIELDS,
  RULE_REASON_CODES,
  TARGET_BINDING_FIELDS,
  TARGET_ID_MAX_LENGTH,
  TARGET_ID_MIN_LENGTH,
  TARGET_REVISION_MIN,
  TARGET_TYPES,
  VERSION_MAX_LENGTH,
  isAuditState,
} from '../../packages/moderation/constants.mjs';
import { RULES, rulesByCategory, validateRuleCatalog } from '../../packages/moderation/rules.mjs';
import { deriveRuleVersion, isDerivedRuleVersion, RULE_VERSION } from '../../packages/moderation/rule-version.mjs';
import { MATCHERS } from '../../packages/moderation/matchers.mjs';
import { toRuleLayerDraft } from '../../packages/moderation/engine.mjs';
import { missingContractFields } from '../../packages/moderation/review.mjs';
import { makeInput, runRules } from './_fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const states = JSON.parse(readFileSync(join(repoRoot, 'packages/contracts/states.json'), 'utf8'));
const openapi = JSON.parse(readFileSync(join(repoRoot, 'packages/contracts/openapi.json'), 'utf8'));
const schemas = openapi.components.schemas;
const moderationSchema = schemas.Moderation;
const targetRefSchema = schemas.TargetRef;

test('AuditState 闭集与契约 states.json 逐项一致（不得新增值）', () => {
  assert.deepEqual([...AUDIT_STATES], states.states.AuditState);
  assert.equal(AUDIT_STATES.length, 4);
  for (const value of AUDIT_STATES) assert.equal(typeof value, 'string');
});

test('TargetRef.type 闭集与契约 openapi.json 逐项一致', () => {
  assert.deepEqual([...TARGET_TYPES], targetRefSchema.properties.type.enum);
  for (const type of COVERED_TARGET_TYPES) {
    assert.ok(TARGET_TYPES.includes(type), `覆盖声明里的 ${type} 必须属于契约闭集`);
  }
});

test('长度与数量上限取自契约，不自创', () => {
  assert.equal(REASON_CODES_MAX_ITEMS, moderationSchema.properties.reason_codes.maxItems);
  assert.equal(REASON_CODE_MIN_LENGTH, moderationSchema.properties.reason_codes.items.minLength);
  assert.equal(REASON_CODE_MAX_LENGTH, moderationSchema.properties.reason_codes.items.maxLength);
  assert.equal(VERSION_MAX_LENGTH, moderationSchema.properties.rule_version.maxLength);
  assert.equal(TARGET_ID_MIN_LENGTH, targetRefSchema.properties.id.minLength);
  assert.equal(TARGET_ID_MAX_LENGTH, targetRefSchema.properties.id.maxLength);
  assert.equal(TARGET_REVISION_MIN, targetRefSchema.properties.revision.minimum);
});

test('契约 Moderation 的必填字段被本片诚实拆分为四层，且不重叠', () => {
  const required = [...moderationSchema.required].sort();
  const claimed = [
    ...RULE_LAYER_FIELDS,
    ...TARGET_BINDING_FIELDS,
    ...MODEL_LAYER_FIELDS,
    ...PERSISTENCE_LAYER_FIELDS,
  ].sort();
  assert.deepEqual(claimed, required, '四层字段并集必须恰好覆盖契约必填字段');
  assert.deepEqual(
    Object.values(MODERATION_FIELD_LAYERS).flat().sort(),
    [...moderationSchema.required].sort(),
  );
  const layers = Object.entries(MODERATION_FIELD_LAYERS);
  const seen = new Set();
  for (const [layer, fields] of layers) {
    for (const field of fields) {
      assert.equal(seen.has(field), false, `${field} 同时出现在多层（${layer}）`);
      seen.add(field);
    }
  }
  assert.deepEqual([...MODEL_LAYER_FIELDS], ['model_version', 'prompt_version']);
  assert.equal(moderationSchema.additionalProperties, false);
});

test('全部自带 reason_code 都是 1..80 的字符串（契约约束）', () => {
  for (const code of [...RULE_REASON_CODES, ...FAIL_CLOSED_REASON_CODES]) {
    assert.equal(typeof code, 'string');
    assert.ok(code.length >= REASON_CODE_MIN_LENGTH, `${code} 过短`);
    assert.ok(code.length <= REASON_CODE_MAX_LENGTH, `${code} 超过 80`);
  }
});

test('出厂规则集结构合法：id 唯一、类别覆盖齐全、原因码属于闭集', () => {
  const report = validateRuleCatalog(RULES, MATCHERS);
  assert.deepEqual(report.errors, []);
  assert.equal(report.valid, true);
  for (const rule of RULES) {
    assert.match(rule.id, /^MR-\d{2}$/);
    assert.ok(RULE_REASON_CODES.includes(rule.reason_code));
    assert.equal(rule.severity, 'block');
  }
  const grouped = rulesByCategory(RULES);
  // 派单 §3 的六类 + F05／AC16 的商业禁止类别，都必须有规则。
  for (const category of RULE_CATEGORIES) {
    assert.ok(grouped[category].length > 0, `类别 ${category} 没有任何规则`);
  }
});

test('rule_version 由内容派生，不是手填字面量', () => {
  assert.equal(isDerivedRuleVersion(RULE_VERSION), true);
  assert.equal(RULE_VERSION, deriveRuleVersion(RULES, MATCHERS));
  assert.notEqual(RULE_VERSION, 'fixture-only');
  assert.notEqual(RULE_VERSION, 'v1');
  assert.ok(RULE_VERSION.length <= VERSION_MAX_LENGTH);
});

test('本片不产出 model_version / prompt_version：源码里没有占位赋值', () => {
  const packageDir = join(repoRoot, 'packages/moderation');
  const files = readdirSync(packageDir).filter((name) => name.endsWith('.mjs'));
  assert.ok(files.length > 0);
  // 匹配 `model_version: '...'` / `prompt_version = "..."` 这类"假装已填"的赋值。
  const fabricated = /["']?(?:model_version|prompt_version)["']?\s*[:=]\s*["'`][^"'`]/;
  for (const name of files) {
    const text = readFileSync(join(packageDir, name), 'utf8');
    assert.equal(fabricated.test(text), false, `${name} 疑似填了模型层占位字符串`);
  }
});

test('规则层草稿显式声明不完整，且不含模型层字段键', () => {
  const result = runRules(makeInput());
  const draft = toRuleLayerDraft(result);
  assert.equal(draft.complete, false);
  assert.equal('model_version' in draft, false);
  assert.equal('prompt_version' in draft, false);
  assert.equal('model_version' in draft.rule_layer, false);
  assert.equal('prompt_version' in draft.rule_layer, false);
  assert.deepEqual(draft.missing_contract_fields, ['id', 'model_version', 'prompt_version']);
  assert.deepEqual(missingContractFields(), ['id', 'model_version', 'prompt_version']);
  assert.equal(typeof draft.rule_layer.rule_version, 'string');
  assert.equal(typeof draft.rule_layer.hard_rule_passed, 'boolean');
});

test('引擎产出的 decision 永远落在契约闭集内（含异常输入）', () => {
  const inputs = [
    makeInput(),
    makeInput({ text: '这个配方保证无残留，绝对安全。' }),
    undefined,
    null,
    123,
    {},
    makeInput({ media: [{ kind: 'image' }] }),
  ];
  for (const input of inputs) {
    const result = runRules(input);
    assert.equal(typeof result.decision, 'string');
    assert.equal(isAuditState(result.decision), true, `decision 越界：${String(result.decision)}`);
  }
});
