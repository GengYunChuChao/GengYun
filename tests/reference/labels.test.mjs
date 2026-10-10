// GY-I07 展示标签与合规文案测试（AC22：不授 AI/用户经验「专家认证」标签；不展示真实用量）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORBIDDEN_LABELS,
  DISPLAY_LABELS,
  assertNoForbiddenLabel,
  sourceKindLabel,
  evidenceKindLabel,
  reviewStatusLabel,
  referenceStateLabel,
  recordStatusLabel,
  matchStateLabel,
  doseDisplayFor,
  describeRecord,
  describeSeedRecord,
  seedLabel,
  SEED_REQUIRED_LABEL,
  loadHerbicideRecords,
} from '../../packages/reference/index.mjs';

test('标签词典本身不含任何禁用词', () => {
  const all = JSON.stringify(DISPLAY_LABELS);
  for (const forb of FORBIDDEN_LABELS) {
    assert.ok(!all.includes(forb), `展示词典含禁用词：${forb}`);
  }
  assert.ok(!all.includes('专家'));
});

test('assertNoForbiddenLabel：含禁用词即抛，正常文案通过', () => {
  assert.throws(() => assertNoForbiddenLabel('该记录专家认证通过'));
  assert.throws(() => assertNoForbiddenLabel('绝对安全'));
  assert.doesNotThrow(() => assertNoForbiddenLabel('已核对种子资料'));
  assert.equal(assertNoForbiddenLabel('未核对'), '未核对');
});

test('各标签函数对未知取值返回明确占位（不返回禁用词）', () => {
  const vals = [
    sourceKindLabel('unknown-kind'),
    evidenceKindLabel('unknown-kind'),
    reviewStatusLabel('unknown-kind'),
    referenceStateLabel('unknown-kind'),
    matchStateLabel('unknown-kind'),
    recordStatusLabel({ record_status: 'weird' }),
  ];
  for (const v of vals) assert.doesNotThrow(() => assertNoForbiddenLabel(v));
});

test('模拟记录标签强标记「非真实资料」且不展示用量', () => {
  const label = recordStatusLabel({ simulated: true });
  assert.ok(label.includes('模拟'));
  assert.ok(label.includes('非真实资料'));
});

test('doseDisplayFor：任何记录都不展示真实用量（含 usable_as_dose=false）', () => {
  assert.ok(doseDisplayFor({ usable_as_dose: false }).includes('不提供用量'));
  // 即使标为可用，也不生成个人处方/换算。
  const usable = doseDisplayFor({ usable_as_dose: true });
  assert.ok(usable.includes('不生成换算') || usable.includes('仅按来源原文'));
  for (const v of [doseDisplayFor({}), doseDisplayFor({ usable_as_dose: true })]) {
    assert.doesNotThrow(() => assertNoForbiddenLabel(v));
  }
});

test('describeRecord：组装标签全集且逐项无禁用词（遍历全部真实记录）', () => {
  const doc = loadHerbicideRecords();
  for (const item of doc.items) {
    const labels = describeRecord(item);
    for (const v of Object.values(labels)) {
      assert.doesNotThrow(() => assertNoForbiddenLabel(v), `记录 ${item.registration_number} 标签含禁用词`);
    }
    assert.ok(labels.dose.includes('不提供用量') || labels.dose.includes('不生成换算'));
  }
});

test('describeSeedRecord：强制「待核实·非权威」且无禁用词', () => {
  const labels = describeSeedRecord({ evidence_kind: 'experience', seed: { data_origin: 'seed_unverified', authority: 'none' } });
  assert.equal(labels.seed, SEED_REQUIRED_LABEL);
  assert.equal(labels.data_origin, 'seed_unverified');
  assert.equal(labels.authority, 'none');
  for (const v of Object.values(labels)) assert.doesNotThrow(() => assertNoForbiddenLabel(v));
});

test('seedLabel 恒为「待核实·非权威」', () => {
  assert.equal(seedLabel(), SEED_REQUIRED_LABEL);
});

test('禁用词表覆盖「权威来源/无药害」等扩展项', () => {
  assert.ok(FORBIDDEN_LABELS.includes('权威来源'));
  assert.ok(FORBIDDEN_LABELS.includes('无药害'));
  assert.ok(FORBIDDEN_LABELS.includes('专家认证'));
});
