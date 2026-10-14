#!/usr/bin/env node
/**
 * GY-I09 第二片（识别任务 · Top3 候选与选择闭环）· **可复核探针**。
 *
 * 用途：不依赖微信运行时、不联网、不调用任何真实模型，
 * 把本片的硬约束逐条打印成**原始输出**，供人工与 CI 复核：
 *   1. 六类失败/边界分支闭集：契约内落点、是否创建任务、可重试语义、如实原因；
 *   2. 选择后关联科普与条件：只取有效/可访问/非模拟（含逐条排除原因）；
 *   3. 条件完整性与 `CONDITIONS_INCOMPLETE` 阻断；
 *   4. **不得经识别/选择绕过 GY-I08 用量守卫**：
 *      用一条经 GY-I08 判定**本可渲染**的合成条目做正控制，
 *      证明「取不到用量」是**路径的硬边界**而不是「恰好没数据」；
 *   5. 真实域库（已合入公告附表）经同一端口时的如实结果（命中数、恒无用量、未采集禁限用阻断）；
 *   6. 人工选择不计模型成绩（来源闭集与模型成绩无交集 ⇒ model_attributable 恒 0）。
 *
 * 用法：
 *   node tools/verify-gy-i09-candidates.mjs
 * 退出码：0 = 全部断言通过；1 = 有断言失败（输出失败明细）。
 *
 * 边界声明：本脚本使用**合成**资料条目与**合成**身份；不接入真实供应商，
 * 不产生任何准确率证据（真实评估与独立样本指标交 GY-I21）。
 */
import { strict as assert } from 'node:assert';

import {
  BRANCH_DESCRIPTORS,
  FAILURE_BRANCHES,
  branchCreatesJob,
  retrySemanticsFor,
} from '../services/api/src/recognitions/branches.ts';
import {
  DOSE_PATH_BLOCK_CODE,
  LINKAGE_RULE_VERSION,
  LINKAGE_RULE_VERSION_REVIEWED_AGAINST,
  createReferenceLinkagePort,
  missingDoseConditions,
  requiresCompleteConditions,
  resolveSelectionLinkage,
} from '../services/api/src/recognitions/linkage.ts';
import {
  MODEL_ATTRIBUTABLE_PROVENANCE,
  SELECTION_PROVENANCE,
  summarizeSelections,
} from '../services/api/src/recognitions/selection.ts';

function line(text = '') { process.stdout.write(`${text}\n`); }
function section(title) { line(); line(`== ${title} ==`); }

const failures = [];
function check(label, fn) {
  try {
    fn();
    line(`  [PASS] ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    line(`  [FAIL] ${label} -> ${error.message}`);
  }
}

/** 经 GY-I08 判定**本可渲染**的合成条目（正控制；字段逐项满足 doseCardDescriptor 前置条件）。 */
function renderableRecord(overrides = {}) {
  const base = {
    record_id: 'rec-probe-renderable',
    registration_number: 'PD20210001',
    registered_name: '合成除草剂甲',
    dosage_form: '水分散粒剂',
    ingredients_text: '唑草酮 40%',
    use_scene: '水稻移栽田',
    growth_stage: '苗后',
    crop_ids: ['crop_rice'],
    region_codes: ['330100'],
    visibility: 'published',
    reference_state: 'available',
    simulated: false,
    source_version: 'sv-probe-1',
    source: { source_kind: 'database', evidence_kind: 'research', source_validity: 'valid', review_status: 'verified' },
    verification: {
      usable_as_dose: true,
      review_status: 'verified',
      restriction_status: 'unrestricted',
      dose: {
        number: '40',
        unit: '克/公顷',
        condition: '苗后茎叶喷雾',
        source_version: 'sv-probe-1',
        record_id: 'rec-probe-renderable',
        formulation: {
          registration_number: 'PD20210001',
          registered_name: '合成除草剂甲',
          dosage_form: '水分散粒剂',
          ingredients_text: '唑草酮 40%',
        },
        reference: '合成公告第 1 表',
      },
    },
    knowledge: { title: '合成除草剂甲 科普条目' },
  };
  return { ...base, ...overrides };
}

const COMPLETE_CONDITIONS = {
  crop_id: 'crop_rice',
  region_code: '330100',
  species_id: 'species_barnyardgrass',
  growth_stage: '苗后',
  planting_method: 'transplant',
  use_scene: '水稻移栽田',
};

line('GY-I09 第二片探针：识别任务 · Top3 候选与选择闭环（合成数据；无网络、无真实模型调用）');

section('1. 六类失败/边界分支闭集');
line(`  FAILURE_BRANCHES = ${JSON.stringify(FAILURE_BRANCHES)}`);
for (const branch of FAILURE_BRANCHES) {
  const descriptor = BRANCH_DESCRIPTORS[branch];
  const retry = retrySemanticsFor(branch);
  line(
    `  - ${branch}: job_state=${JSON.stringify(descriptor.jobState)} error_code=${JSON.stringify(descriptor.errorCode)}` +
    ` creates_job=${branchCreatesJob(branch)} retryable=${retry.retryable} retry_action=${JSON.stringify(retry.retryAction)}` +
    ` reason=${JSON.stringify(descriptor.reason)}`,
  );
}
check('六类分支闭集恰为 6 类且顺序固定', () => {
  assert.deepEqual([...FAILURE_BRANCHES], [
    'uncertain', 'out_of_coverage_or_low_quality', 'permission_denied', 'no_result', 'timeout', 'reshoot_required',
  ]);
});
check('权限拒绝在受理前拦截（不创建任务、无任务状态）', () => {
  assert.equal(branchCreatesJob('permission_denied'), false);
  assert.equal(BRANCH_DESCRIPTORS.permission_denied.jobState, null);
});
check('除权限拒绝外，其余分支落点均为契约既有 JobState', () => {
  for (const branch of FAILURE_BRANCHES.filter((item) => item !== 'permission_denied')) {
    assert.ok(['uncertain', 'timed_out'].includes(BRANCH_DESCRIPTORS[branch].jobState), branch);
  }
});

section('2. 选择后关联：只取有效、可访问、非模拟');
const mixed = [
  renderableRecord(),
  renderableRecord({ record_id: 'rec-probe-expired', registration_number: 'PD20210002', source: { ...renderableRecord().source, source_validity: 'expired' } }),
  renderableRecord({ record_id: 'rec-probe-hidden', registration_number: 'PD20210003', visibility: 'hidden' }),
  renderableRecord({ record_id: 'rec-probe-sim', registration_number: 'SIM-0001', simulated: true, source: { ...renderableRecord().source, source_kind: 'simulation' } }),
];
const mixedLinkage = resolveSelectionLinkage({
  speciesId: 'species_barnyardgrass',
  conditions: COMPLETE_CONDITIONS,
  records: mixed,
});
line(`  rule_version = ${mixedLinkage.rule_version}`);
line(`  reference_state = ${mixedLinkage.reference_state} items = ${mixedLinkage.items.length} applicable = ${mixedLinkage.applicable_count}`);
for (const item of mixedLinkage.items) {
  line(`  - 采纳 record_id=${item.record_id} source_kind=${item.source_kind} review_status=${item.review_status} applicable=${item.applicable} blocked=${JSON.stringify(item.blocked_codes)}`);
}
for (const row of mixedLinkage.excluded) line(`  - 排除 record_id=${row.record_id} reason=${row.reason}`);
check('失效/下架/模拟一律排除且**带原因**', () => {
  assert.equal(mixedLinkage.items.length, 1);
  assert.equal(mixedLinkage.excluded.length, 3);
  for (const row of mixedLinkage.excluded) assert.ok(row.reason.length > 0);
});

section('3. 条件完整性与 CONDITIONS_INCOMPLETE 阻断');
line(`  完整条件缺项 = ${JSON.stringify(missingDoseConditions(COMPLETE_CONDITIONS))}`);
line(`  仅 {crop_id, region_code} 缺项 = ${JSON.stringify(missingDoseConditions({ crop_id: 'crop_rice', region_code: '330100' }))}`);
let thrown = null;
try {
  requiresCompleteConditions({ crop_id: 'crop_rice' });
} catch (error) {
  thrown = error;
}
line(`  条件不全调用守卫 -> code=${thrown === null ? 'null' : thrown.code} status=${thrown === null ? 'null' : thrown.status} message=${thrown === null ? 'null' : thrown.message}`);
check('条件不全时守卫抛契约内 422 CONDITIONS_INCOMPLETE', () => {
  assert.ok(thrown !== null, '必须抛错');
  assert.equal(thrown.code, 'CONDITIONS_INCOMPLETE');
  assert.equal(thrown.status, 422);
});

section('4. 不得经识别/选择绕过 GY-I08 用量守卫（正控制 + 负例）');
const positive = resolveSelectionLinkage({
  speciesId: 'species_barnyardgrass',
  conditions: COMPLETE_CONDITIONS,
  records: [renderableRecord()],
});
line(`  正控制：条件完整 = ${positive.conditions_complete}，经 GY-I08 判定本可渲染的条目数 = ${positive.dose.conditionally_renderable_count}`);
line(`  负例：dose.renderable = ${positive.dose.renderable} dose.card = ${JSON.stringify(positive.dose.card)} block_code = ${positive.dose.block_code} blocked_by_path = ${positive.dose.blocked_by_path}`);
line(`  逐条判定 = ${JSON.stringify(positive.dose.per_item)}`);
check('正控制成立：该条目在 GY-I08 口径下本可渲染', () => {
  assert.equal(positive.dose.conditionally_renderable_count, 1);
  assert.equal(positive.dose.per_item[0].renderable, true);
});
check('识别/选择路径恒不产出用量卡（条件完整时也一样）', () => {
  assert.equal(positive.dose.renderable, false);
  assert.equal(positive.dose.card, null);
  assert.equal(positive.dose.block_code, DOSE_PATH_BLOCK_CODE);
  assert.equal(positive.dose.blocked_by_path, 'recognition_selection');
  assert.ok(positive.blocked_codes.includes(DOSE_PATH_BLOCK_CODE));
});
check('规则版本与 GY-I08 同源且可断言', () => {
  assert.equal(LINKAGE_RULE_VERSION, 'gy-i08/1.2.0');
  assert.equal(LINKAGE_RULE_VERSION_REVIEWED_AGAINST, 'gy-i08/1.2.0');
});

section('5. 真实域库端口（已合入公告附表）· 如实结果');
const port = createReferenceLinkagePort();
const realRecords = port.itemsForSpecies('species_barnyardgrass');
line(`  port.kind = ${port.kind}`);
line(`  species_barnyardgrass 命中记录数 = ${realRecords.length}`);
const realLinkage = resolveSelectionLinkage({
  speciesId: 'species_barnyardgrass',
  conditions: COMPLETE_CONDITIONS,
  records: realRecords,
});
line(`  reference_state = ${realLinkage.reference_state} items = ${realLinkage.items.length}`);
for (const item of realLinkage.items) {
  line(`  - record_id=${item.record_id} review_status=${item.review_status} applicable=${item.applicable} blocked=${JSON.stringify(item.blocked_codes)}`);
  line(`    reasons=${JSON.stringify(item.reasons)}`);
}
line(`  dose.renderable = ${realLinkage.dose.renderable} conditionally_renderable_count = ${realLinkage.dose.conditionally_renderable_count}`);
line(`  blocked_codes = ${JSON.stringify(realLinkage.blocked_codes)}`);
check('未命中的品种如实返回空（不伪造资料）', () => {
  assert.deepEqual(createReferenceLinkagePort().itemsForSpecies('species_not_in_catalog'), []);
});
check('真实资料未采集用量 ⇒ 恒不可渲染，且未采集禁限用 fail-closed 阻断', () => {
  assert.ok(realLinkage.items.length >= 1, '稗草应命中真实记录');
  assert.equal(realLinkage.dose.renderable, false);
  assert.equal(realLinkage.dose.conditionally_renderable_count, 0);
  const item = realLinkage.items[0];
  assert.equal(item.applicable, false);
  assert.ok(item.blocked_codes.includes('banned_restricted'), JSON.stringify(item.blocked_codes));
});

section('6. 人工选择不计模型成绩');
line(`  SELECTION_PROVENANCE = ${JSON.stringify(SELECTION_PROVENANCE)}`);
line(`  MODEL_ATTRIBUTABLE_PROVENANCE = ${JSON.stringify(MODEL_ATTRIBUTABLE_PROVENANCE)}`);
const syntheticSelections = SELECTION_PROVENANCE.map((provenance, index) => ({
  id: `probe-${index}`, revision: 1, recognitionId: 'probe-rec', ownerUserId: 'probe-user',
  speciesId: 'species_barnyardgrass', provenance, decidedAt: new Date(1000 * (index + 1)), linkage: null,
}));
const summary = summarizeSelections(syntheticSelections);
line(`  summary = ${JSON.stringify(summary)}`);
check('人工/手改/预设一律不计模型成绩（model_attributable 恒 0）', () => {
  assert.deepEqual([...MODEL_ATTRIBUTABLE_PROVENANCE], []);
  assert.equal(summary.model_attributable, 0);
  assert.equal(summary.total, SELECTION_PROVENANCE.length);
});

section('结论');
if (failures.length === 0) {
  line(`  ALL PASS（${FAILURE_BRANCHES.length} 类分支、关联守卫与用量路径阻断逐条通过）`);
  line('  未验证项：真实模型调用与真实准确率（未授权）、微信开发者工具/ACE3V 真机走查（未取得）。');
  process.exit(0);
}
line(`  FAILURES (${failures.length}):`);
for (const failure of failures) line(`   - ${failure}`);
process.exit(1);
