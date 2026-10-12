/**
 * GY-I14 模型层（第二片）· 合流层主口径与**正控制**。
 *
 * 本文件回答四个问题：
 *   1) 规则层通过 + 模型端口通过 ⇒ 是否得到**完整合法**的契约 `Moderation`（除 `id`）；
 *   2) 未接线（不注入端口）时，`execution_mode` 为 `real` 与"未接线"是否**逐字节相同**；
 *   3) 合流层是否**真的复用**了规则层 `pending_model_layer_fields` /
 *      `missingContractFields()` / `evaluateReReview` / `isPublishable`；
 *   4) 输出是否**逐字段**过 `packages/contracts/openapi.json` 的 `Moderation` 结构
 *      （本文件内联一个只读、无依赖的结构校验器，直接读契约，不许自己发明上限）。
 *
 * 断言纪律：先 `typeof`，再判值；每条失败路径都要求"不得 approved"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  AUDIT_STATES,
  MODEL_LAYER_FIELDS,
  REASON_CODES_MAX_ITEMS,
  REASON_CODE_MAX_LENGTH,
  REASON_CODE_MIN_LENGTH,
  VERSION_MAX_LENGTH,
  TARGET_ID_MAX_LENGTH,
  TARGET_ID_MIN_LENGTH,
  TARGET_REVISION_MIN,
} from '../../packages/moderation/constants.mjs';
import { RULES } from '../../packages/moderation/rules.mjs';
import { missingContractFields, REVIEW_ACTIONS, REVIEW_LANDINGS } from '../../packages/moderation/review.mjs';
import {
  MODERATION_CONTRACT_FIELDS,
  checkMergedContractShape,
  mergeModeration,
  mergeReasonCodes,
} from '../../packages/moderation/merge.mjs';
import { checkMergedInvariant } from '../../packages/moderation/merged-invariant.mjs';
import { derivePromptVersionForIds } from '../../packages/moderation/prompt-version.mjs';
import {
  CLEAN_RULE_RESULT,
  MEDIA_RULE_RESULT,
  makeContent,
  makeMediaContent,
  makePort,
  passVerdict,
} from './_model-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const openapi = JSON.parse(readFileSync(join(repoRoot, 'packages/contracts/openapi.json'), 'utf8'));
const schemas = openapi.components.schemas;
const MODERATION_SCHEMA = schemas.Moderation;
const TARGET_REF_SCHEMA = schemas.TargetRef;

const SAMPLE_UUID = '33333333-3333-4333-8333-333333333333';

/**
 * 直接按契约结构校验一个 `Moderation` 值（只读消费 openapi.json，不自创上限）。
 * @param {unknown} value
 * @param {{ allowMissingId?: boolean }} [options]
 * @returns {string[]} 问题清单
 */
function validateModeration(value, options = {}) {
  const allowMissingId = options.allowMissingId === true;
  const problems = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['不是对象'];
  const properties = MODERATION_SCHEMA.properties;
  for (const field of MODERATION_SCHEMA.required) {
    if (allowMissingId && field === 'id') continue;
    if (!Object.hasOwn(value, field)) problems.push(`缺必填字段 ${field}`);
  }
  if (MODERATION_SCHEMA.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) problems.push(`契约外字段 ${key}`);
    }
  }
  if (value.target_ref !== undefined) {
    const ref = value.target_ref;
    if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) problems.push('target_ref 不是对象');
    else {
      for (const field of TARGET_REF_SCHEMA.required) {
        if (!Object.hasOwn(ref, field)) problems.push(`target_ref 缺 ${field}`);
      }
      if (!TARGET_REF_SCHEMA.properties.type.enum.includes(ref.type)) problems.push('target_ref.type 越界');
      if (
        typeof ref.id !== 'string' ||
        ref.id.length < TARGET_REF_SCHEMA.properties.id.minLength ||
        ref.id.length > TARGET_REF_SCHEMA.properties.id.maxLength
      ) {
        problems.push('target_ref.id 越界');
      }
      if (
        typeof ref.revision !== 'number' ||
        !Number.isSafeInteger(ref.revision) ||
        ref.revision < TARGET_REF_SCHEMA.properties.revision.minimum
      ) {
        problems.push('target_ref.revision 越界');
      }
      for (const key of Object.keys(ref)) {
        if (!Object.hasOwn(TARGET_REF_SCHEMA.properties, key)) problems.push(`target_ref 契约外字段 ${key}`);
      }
    }
  }
  if (value.decision !== undefined && !AUDIT_STATES.includes(value.decision)) problems.push('decision 越界');
  if (value.hard_rule_passed !== undefined && typeof value.hard_rule_passed !== 'boolean') {
    problems.push('hard_rule_passed 不是 boolean');
  }
  if (value.reason_codes !== undefined) {
    if (!Array.isArray(value.reason_codes)) problems.push('reason_codes 不是数组');
    else {
      if (value.reason_codes.length > properties.reason_codes.maxItems) problems.push('reason_codes 超上限');
      for (const code of value.reason_codes) {
        if (typeof code !== 'string') {
          problems.push('reason_code 不是字符串');
          break;
        }
        if (code.length < properties.reason_codes.items.minLength || code.length > properties.reason_codes.items.maxLength) {
          problems.push('reason_code 长度越界');
          break;
        }
      }
    }
  }
  for (const field of ['model_version', 'prompt_version', 'rule_version']) {
    const spec = properties[field];
    const actual = value[field];
    if (actual === undefined) continue;
    if (typeof actual !== 'string' || actual.length < spec.minLength || actual.length > spec.maxLength) {
      problems.push(`${field} 不是 ${spec.minLength}..${spec.maxLength} 的字符串`);
    }
  }
  return problems;
}

/** 合流并把"必须能过契约"的部分做成公共断言。 */
async function merge(ruleResult = CLEAN_RULE_RESULT, options = {}) {
  return mergeModeration(ruleResult, options);
}

function expectNotApproved(merged, name) {
  assert.equal(typeof merged.decision, 'string', `${name}: decision 必须是字符串`);
  assert.equal(AUDIT_STATES.includes(merged.decision), true, `${name}: decision 越界`);
  assert.notEqual(merged.decision, 'approved', `${name}: 不得判为通过`);
  const invariant = checkMergedInvariant(merged);
  assert.deepEqual(invariant.violations, [], `${name}: 违反合流不变式`);
}

// ---------------------------------------------------------------------------
// 1 正控制：规则层通过 + 模型端口通过 ⇒ 完整合法契约 Moderation
// ---------------------------------------------------------------------------

test('正控制：规则层通过 + 文本端口通过 ⇒ 完整合法 Moderation（三版本齐备、approved）', async () => {
  assert.equal(CLEAN_RULE_RESULT.decision, 'approved', '夹具前提：规则层判通过');
  const merged = await merge(CLEAN_RULE_RESULT, {
    content: makeContent(),
    ports: { tms: makePort() },
  });

  assert.equal(merged.decision, 'approved');
  assert.equal(merged.hard_rule_passed, true);
  assert.equal(typeof merged.rule_version, 'string');
  assert.equal(typeof merged.model_version, 'string');
  assert.equal(typeof merged.prompt_version, 'string');
  assert.equal(merged.rule_version, CLEAN_RULE_RESULT.rule_version);
  assert.equal(merged.model_version, 'synthetic-tms-model@1.0');
  assert.equal(merged.prompt_version, derivePromptVersionForIds(['text_moderation']));
  assert.deepEqual(merged.reason_codes, []);

  // 完整合法契约（除 id）：missingContractFields() 只剩 id，其余全部补齐。
  assert.deepEqual(missingContractFields(), ['id', 'model_version', 'prompt_version']);
  assert.deepEqual(merged.missing_contract_fields, ['id']);
  assert.deepEqual(merged.remaining_contract_fields, []);
  assert.notEqual(merged.contract_value, null);
  assert.deepEqual(validateModeration(merged.contract_value, { allowMissingId: true }), []);
  // 补上持久层的 id 后，整体（含 id）也过契约结构校验。
  assert.deepEqual(validateModeration({ id: SAMPLE_UUID, ...merged.contract_value }), []);

  // ModerationResult 形状。
  assert.equal(merged.moderation_result.kind, 'moderation');
  assert.deepEqual(merged.moderation_result.value, merged.contract_value);

  // 形状与不变式自检。
  const shape = checkMergedContractShape(merged);
  assert.deepEqual(shape.problems, []);
  assert.equal(shape.ok, true);
  assert.deepEqual(checkMergedInvariant(merged), { ok: true, violations: [] });

  // 复用 review 口径：当前版本下可复用且可发布。
  assert.equal(merged.model_layer.re_review.stale, false);
  assert.equal(merged.model_layer.re_review.action, 'reuse');
  assert.equal(REVIEW_ACTIONS.includes(merged.model_layer.re_review.action), true);
  assert.equal(merged.model_layer.re_review.publishable, true);
  assert.equal(merged.model_layer.publishable.publishable, true);
});

test('正控制：同输入两次合流结果完全一致（确定性，逐字节）', async () => {
  const first = await merge(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: makePort() } });
  const second = await merge(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: makePort() } });
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test('合流输出逐项对上契约字段集（去 id 后与 openapi required 完全相同）', () => {
  const expected = [...MODERATION_SCHEMA.required].filter((field) => field !== 'id');
  assert.deepEqual([...MODERATION_CONTRACT_FIELDS].sort(), expected.sort());
  assert.equal(MODERATION_SCHEMA.additionalProperties, false);
});

test('契约结构校验器本身有牙齿：多字段／少字段／越界值都能被抓到', async () => {
  const merged = await merge(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: makePort() } });
  const good = { id: SAMPLE_UUID, ...merged.contract_value };
  assert.deepEqual(validateModeration(good), []);
  assert.notDeepEqual(validateModeration({ ...good, extra_field: 1 }), []);
  const missing = { ...good };
  delete missing.model_version;
  assert.notDeepEqual(validateModeration(missing), []);
  assert.notDeepEqual(validateModeration({ ...good, reason_codes: Array.from({ length: 31 }, (_, i) => `C${i}`) }), []);
  assert.notDeepEqual(validateModeration({ ...good, reason_codes: ['x'.repeat(81)] }), []);
  assert.notDeepEqual(validateModeration({ ...good, decision: 'approved_like' }), []);
  assert.notDeepEqual(validateModeration({ ...good, model_version: '' }), []);
});

// ---------------------------------------------------------------------------
// 2 默认关闭 / 未接线等价性
// ---------------------------------------------------------------------------

test('默认关闭：不注入端口 ⇒ 不得通过，且与 execution_mode=real 逐字节相同', async () => {
  const bare = await merge(CLEAN_RULE_RESULT, { content: makeContent() });
  const explicitReal = await merge(CLEAN_RULE_RESULT, { content: makeContent(), execution_mode: 'real' });
  const explicitUndefinedPorts = await merge(CLEAN_RULE_RESULT, { content: makeContent(), ports: undefined });

  assert.equal(JSON.stringify(explicitReal), JSON.stringify(bare), 'real 与未接线必须逐字节相同');
  assert.equal(JSON.stringify(explicitUndefinedPorts), JSON.stringify(bare), 'ports: undefined 与未接线必须逐字节相同');
  expectNotApproved(bare, '未接线');
  assert.equal(bare.reason_codes.includes('MODEL_LAYER_PORT_MISSING'), true);
  assert.equal(bare.model_version, null, '不得填模型版本占位串');
  assert.equal(bare.contract_value, null, '缺必填字段时不得装配契约对象');
  assert.deepEqual(bare.missing_contract_fields, ['id', 'model_version']);
  assert.equal(bare.model_layer.execution_mode, 'real');
});

test('默认关闭：端口 kind 与用途不符（拿文本端口当图片端口）⇒ 拒且不得通过', async () => {
  const merged = await merge(MEDIA_RULE_RESULT, {
    content: makeMediaContent(),
    ports: { tms: makePort({ kind: 'tms' }), ims: makePort({ kind: 'tms' }) },
  });
  expectNotApproved(merged, '端口 kind 不符');
  assert.equal(merged.reason_codes.includes('MODEL_LAYER_PORT_INVALID'), true);
});

test('默认关闭：注入端口必须显式声明持有网络 seam，缺一个即拒（"忘了接线"不得当"跑过了"）', async () => {
  const port = makePort();
  delete port.seams.fetchImpl;
  const merged = await merge(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: port } });
  expectNotApproved(merged, 'seam 缺失');
  assert.equal(merged.reason_codes.includes('MODEL_LAYER_PORT_INVALID'), true);
});

// ---------------------------------------------------------------------------
// 3 复用规则层接口的证据
// ---------------------------------------------------------------------------

test('复用 pending_model_layer_fields：规则层没按接口声明 ⇒ 拒（declaration missing）', async () => {
  const tampered = { ...CLEAN_RULE_RESULT };
  delete tampered.pending_model_layer_fields;
  const merged = await merge(tampered, { content: makeContent(), ports: { tms: makePort() } });
  expectNotApproved(merged, '缺 pending 声明');
  assert.equal(merged.reason_codes.includes('MODEL_LAYER_DECLARATION_MISSING'), true);
  assert.equal(merged.model_layer.declaration.declaration_ok, false);
});

test('复用 pending_model_layer_fields：声明内容被改小 ⇒ 同样拒（不许少声明）', async () => {
  const tampered = { ...CLEAN_RULE_RESULT, pending_model_layer_fields: ['model_version'] };
  const merged = await merge(tampered, { content: makeContent(), ports: { tms: makePort() } });
  expectNotApproved(merged, 'pending 声明不全');
  assert.equal(merged.reason_codes.includes('MODEL_LAYER_DECLARATION_MISSING'), true);
  assert.deepEqual([...MODEL_LAYER_FIELDS], ['model_version', 'prompt_version']);
});

test('合流结果可直接喂给规则层 review 函数（字段同名、口径一致）', async () => {
  const merged = await merge(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: makePort() } });
  // 规则层 evaluateReReview / isPublishable 只要求 decision / hard_rule_passed / rule_version / target_ref。
  for (const field of ['decision', 'hard_rule_passed', 'rule_version', 'target_ref']) {
    assert.equal(Object.hasOwn(merged, field), true, `合流结果必须带 ${field} 供规则层 review 复用`);
  }
  assert.equal(merged.model_layer.re_review.rule_layer.stale, false);
  assert.equal(merged.model_layer.publishable.rule_layer.publishable, true);
});

// ---------------------------------------------------------------------------
// 4 reason_codes 合流口径
// ---------------------------------------------------------------------------

test('reason_codes 合流：规则层码在前、模型层码按声明序在后、去重', () => {
  const merged = mergeReasonCodes(
    ['PRIVACY_PII', 'RULE_TIMEOUT', 'PRIVACY_PII'],
    ['MODEL_TIMEOUT', 'MODEL_LAYER_PORT_MISSING', 'MODEL_TIMEOUT'],
    RULES,
  );
  assert.deepEqual(merged.contract, ['RULE_TIMEOUT', 'PRIVACY_PII', 'MODEL_LAYER_PORT_MISSING', 'MODEL_TIMEOUT']);
  assert.deepEqual(merged.full, merged.contract);
  assert.equal(merged.invalid_dropped_count, 0);
});

test('reason_codes 超 30 条：截断口径（REASON_CODES_TRUNCATED 置顶、≤30、诊断字段留全量）', () => {
  const ruleCodes = Array.from({ length: 28 }, (_, i) => `SYNTHETIC_CODE_${i}`);
  const modelCodes = ['MODEL_TIMEOUT', 'MODEL_QUOTA_EXCEEDED', 'MODEL_AUTH_FAILED'];
  const merged = mergeReasonCodes(ruleCodes, modelCodes, RULES);
  assert.equal(merged.full.length, 31);
  assert.equal(merged.contract.length, REASON_CODES_MAX_ITEMS);
  assert.equal(merged.contract[0], 'REASON_CODES_TRUNCATED');
  assert.deepEqual([...new Set(merged.contract)], merged.contract, '截断后不得有重复');
  for (const code of merged.contract) {
    assert.equal(typeof code, 'string');
    assert.ok(code.length >= REASON_CODE_MIN_LENGTH && code.length <= REASON_CODE_MAX_LENGTH);
  }
});

test('reason_codes 含非法长度项：被裁掉且不改变决策（诊断字段统计丢弃数）', () => {
  const merged = mergeReasonCodes(['PRIVACY_PII', 'X'.repeat(REASON_CODE_MAX_LENGTH + 1), ''], ['MODEL_TIMEOUT'], RULES);
  assert.equal(merged.invalid_dropped_count, 2);
  assert.equal(merged.contract.includes('REASON_CODES_TRUNCATED'), true);
  for (const code of merged.contract) assert.ok(code.length <= REASON_CODE_MAX_LENGTH);
  assert.equal(merged.contract.includes('MODEL_TIMEOUT'), true, '模型层失败原因仍必须可见');
});

test('reason_codes 截断不得把 quarantined/rejected 变 approved', async () => {
  const rejected = await merge(
    // 规则层 rejected + 大量原因码 + 模型 pass：合流只能是 rejected。
    { ...CLEAN_RULE_RESULT, decision: 'rejected', hard_rule_passed: false },
    { content: makeContent(), ports: { tms: makePort() } },
  );
  assert.equal(rejected.decision, 'rejected');
  assert.equal(rejected.decision === 'approved', false);
});

test('版本字段长度上限与 prompt 派生长度都受契约约束', async () => {
  const merged = await merge(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: makePort() } });
  assert.ok(merged.rule_version.length <= VERSION_MAX_LENGTH);
  assert.ok(merged.model_version.length <= VERSION_MAX_LENGTH);
  assert.ok(merged.prompt_version.length <= VERSION_MAX_LENGTH);
  assert.ok(TARGET_ID_MAX_LENGTH >= TARGET_ID_MIN_LENGTH && TARGET_REVISION_MIN >= 1);
});

// ---------------------------------------------------------------------------
// 5 mergeModeration 的异步性与 verdict 形状入口
// ---------------------------------------------------------------------------

test('端口可以返回 Promise（真实端口是异步的），合流层 await 后再判定', async () => {
  const port = makePort({ evaluate: async () => passVerdict() });
  const merged = await merge(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: port } });
  assert.equal(merged.decision, 'approved');
});

test('合流层不读取 seam 的值：seam 里的 fetchImpl 抛错也不影响已通过的结论', async () => {
  const port = makePort({
    seams: {
      fetchImpl: () => {
        throw new Error('boom: seam fetchImpl');
      },
      credentials: {},
      liveGate: {},
      now: () => 0,
    },
  });
  const merged = await merge(CLEAN_RULE_RESULT, { content: makeContent(), ports: { tms: port } });
  assert.equal(merged.decision, 'approved');
  assert.equal(merged.model_layer.synthetic_ports.includes('tms'), true);
});

test('合流层落点闭集与规则层一致（review 口径复用，不另立标准）', async () => {
  const merged = await merge(CLEAN_RULE_RESULT, { content: makeContent() });
  assert.deepEqual([...REVIEW_LANDINGS], ['pending', 'quarantined']);
  assert.deepEqual([...REVIEW_ACTIONS], ['reuse', 're_review']);
  assert.equal(merged.model_layer.re_review.landing, 'quarantined');
  assert.equal(REVIEW_LANDINGS.includes(merged.model_layer.re_review.landing), true);
});
