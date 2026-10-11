// GY-I08 药剂适用过滤与标签原文用量安全边界测试（AC13/AC14/AC22，F04/F14/F20）。
//
// 覆盖：
//   - 适用过滤矩阵：有效性（valid/expired/withdrawn/conflicting/unknown/simulated/缺源/缺证/下架）
//     × 禁限用（unrestricted/restricted/banned/unknown）× 上下文（作物/地区/生育期/剂型/成分/场景）
//     —— 自动生成 ≥100 组，含冲突、失效、未知、模拟、多匹配、关键字段冲突、无来源。
//   - DoseCard 描述符：未采集用量不渲染、关闭开关、有源数字用量才绑定。
//   - 真实 20 条记录：禁限用状态未采集 → fail-closed 不得进入用量卡片。
//   - 小程序侧镜像与域库口径一致（RULE_VERSION 与判定同形）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateApplicability,
  doseCardDescriptor,
  formulationIdentityHash,
  APPLICABILITY_RULE_VERSION,
  FORBIDDEN_LABELS,
  loadHerbicideRecords,
} from '../../packages/reference/index.mjs';
import { miniReference } from './_fixtures.mjs';

/** 构造一条内部条目（默认：有效来源 + 非禁限用 + 水稻）。 */
function baseItem(over = {}) {
  return {
    record_id: 't-base',
    registration_number: 'PD20210001',
    registered_name: '测试剂',
    crop_ids: ['crop_rice'],
    dosage_form: '水分散粒剂',
    ingredients_text: '唑草酮 40%',
    use_scene: '水稻移栽田',
    target_original: '一年生阔叶杂草',
    growth_stage: '',
    region_codes: [],
    visibility: 'published',
    validity: 'valid',
    simulated: false,
    source: { source_kind: 'verified_seed', evidence_kind: 'research', source_validity: 'valid' },
    verification: { usable_as_dose: false, review_status: 'unverified', restriction_status: 'unrestricted' },
    ...over,
  };
}

const RESTRICTIONS = ['unrestricted', 'restricted', 'banned', 'unknown'];

// 有效性变体：除 valid 外均使 evaluateEligibility 失败（阻断 valid_source）。
const ELIGIBILITY = {
  valid: {},
  expired: { source: { source_kind: 'verified_seed', evidence_kind: 'research', source_validity: 'expired' } },
  withdrawn: { source: { source_kind: 'verified_seed', evidence_kind: 'research', source_validity: 'withdrawn' } },
  conflicting: { source: { source_kind: 'verified_seed', evidence_kind: 'research', source_validity: 'conflicting' } },
  unknown_validity: { source: { source_kind: 'verified_seed', evidence_kind: 'research', source_validity: 'unknown' } },
  simulated: { simulated: true },
  missing_source_kind: { source: { evidence_kind: 'research', source_validity: 'valid' } },
  missing_reg: { registration_number: '' },
  hidden: { visibility: 'hidden' },
};

// 上下文：baseline 的 crop=rice、use_scene=水稻移栽田、ingredients=唑草酮 40%，
// region_codes=[]、growth_stage=''（未采集）。
const CONTEXTS = {
  none: {},
  crop_ok: { crop_id: 'crop_rice' },
  crop_bad: { crop_id: 'crop_wheat' },
  region_bad: { region_code: '330100' },
  growth_stage: { growth_stage: '苗后' },
  use_scene_ok: { use_scene: '水稻' },
  use_scene_bad: { use_scene: '茶园' },
  dosage_form_bad: { dosage_form: '乳油' },
  ingredient_ok: { ingredient_content: '唑草酮' },
  ingredient_bad: { ingredient_content: '草甘膦' },
  full_ok: { crop_id: 'crop_rice', use_scene: '水稻', ingredient_content: '唑草酮' },
};

/** 给定上下文，unrestricted 且来源有效时预期被阻断的维度。 */
function expectedBlocks(cname) {
  switch (cname) {
    case 'crop_bad': return ['crop'];
    case 'use_scene_bad': return ['use_scene'];
    case 'dosage_form_bad': return ['dosage_form'];
    case 'ingredient_bad': return ['ingredient_content'];
    default: return []; // region_bad/growth_stage 在 baseline 未采集 → 仅原因、不阻断
  }
}

test('适用过滤矩阵：有效性×禁限用×上下文（≥100 组，含冲突/失效/未知/模拟）', () => {
  let count = 0;
  for (const [ename, eover] of Object.entries(ELIGIBILITY)) {
    for (const rst of RESTRICTIONS) {
      for (const [cname, ctx] of Object.entries(CONTEXTS)) {
        count += 1;
        const item = baseItem({ ...eover, verification: { ...baseItem().verification, restriction_status: rst } });
        const v = evaluateApplicability(item, ctx);
        assert.equal(v.rule_version, APPLICABILITY_RULE_VERSION, '所有消费端须同一规则版本');
        const eligOk = ename === 'valid';
        if (!eligOk) {
          assert.ok(v.blocked.includes('valid_source'), `${ename}/${rst}/${cname} 应阻断 valid_source`);
          assert.equal(v.applicable, false);
        } else if (rst === 'unrestricted') {
          for (const d of expectedBlocks(cname)) {
            assert.ok(v.blocked.includes(d), `${ename}/${rst}/${cname} 应阻断 ${d}`);
          }
          const exp = expectedBlocks(cname).length === 0;
          assert.equal(v.applicable, exp, `${ename}/${rst}/${cname} applicable 不符（期望 ${exp}）`);
        } else {
          assert.ok(v.blocked.includes('banned_restricted'), `${ename}/${rst}/${cname} 应阻断 banned_restricted`);
          assert.equal(v.applicable, false);
        }
        if (!v.applicable) assert.ok(v.reasons.length > 0, `${ename}/${rst}/${cname} 阻断须给出原因（AC02）`);
      }
    }
  }
  assert.ok(count >= 100, `适用过滤用例数应≥100，实际 ${count}`);
});

test('restricted + allow_restricted：显式确认后可进入（不静默放宽）', () => {
  const item = baseItem({ verification: { ...baseItem().verification, restriction_status: 'restricted' } });
  const blocked = evaluateApplicability(item, {});
  assert.equal(blocked.applicable, false);
  assert.ok(blocked.blocked.includes('banned_restricted'));
  const allowed = evaluateApplicability(item, { allow_restricted: true });
  assert.equal(allowed.applicable, true, '显式 allow_restricted 后不应再阻断');
  assert.ok(allowed.reasons.some((r) => r.includes('限用')));
});

test('地区/生育期已采集时按真实值阻断（未采集仅给原因、不阻断）', () => {
  const withRegion = baseItem({ region_codes: ['330100', '330200'] });
  assert.ok(evaluateApplicabilityBlocksRegion(evaluateApplicability(withRegion, { region_code: '330300' })));
  const noRegion = baseItem({ region_codes: [] });
  const v = evaluateApplicability(noRegion, { region_code: '330100' });
  assert.equal(v.applicable, true, '未标注地区不阻断匹配');
  assert.ok(v.reasons.some((r) => r.includes('未标注适用地区')));

  const withGs = baseItem({ growth_stage: '苗后' });
  const badGs = evaluateApplicability(withGs, { growth_stage: '播种前' });
  assert.ok(badGs.reasons.includes('生育期不符'));
  const noGs = baseItem({ growth_stage: '' });
  const vGs = evaluateApplicability(noGs, { growth_stage: '苗后' });
  assert.equal(vGs.applicable, true);
  assert.ok(vGs.reasons.some((r) => r.includes('未采集生育期')));
});

function evaluateApplicabilityBlocksRegion(v) {
  return v.blocked.includes('region') && !v.applicable;
}

test('多匹配：同一作物多条记录均可进入适用集合', () => {
  const a = baseItem({ record_id: 'a', registration_number: 'PD20210001' });
  const b = baseItem({ record_id: 'b', registration_number: 'PD20210002', ingredients_text: '吡氟酰草胺 2%、二甲戊灵 22%' });
  for (const it of [a, b]) {
    const v = evaluateApplicability(it, { crop_id: 'crop_rice' });
    assert.equal(v.applicable, true, `记录 ${it.registration_number} 应适用`);
  }
});

test('关键字段冲突：同登记证号不同含量剂型产生不同制剂身份（不合并）', () => {
  const r1 = { registration_number: 'PD1', registered_name: 'X', dosage_form: '可湿性粉剂', ingredients_text: '莠去津 38%' };
  const r2 = { registration_number: 'PD1', registered_name: 'X', dosage_form: '悬乳剂', ingredients_text: '莠去津 50%' };
  assert.notEqual(formulationIdentityHash(r1), formulationIdentityHash(r2), '同名不同含量剂型不应合并');
});

test('真实 20 条记录：禁限用状态未采集 → fail-closed，不得进入用量卡片', () => {
  const doc = loadHerbicideRecords();
  assert.ok(doc.items.length >= 20, `应有≥20条真实记录，实际 ${doc.items.length}`);
  for (const item of doc.items) {
    const v = evaluateApplicability(item, {});
    assert.equal(v.applicable, false, `记录 ${item.registration_number} 禁限用未采集，不得进入用量卡片`);
    assert.ok(v.blocked.includes('banned_restricted'));
    const card = doseCardDescriptor(item);
    assert.equal(card.renderable, false, `记录 ${item.registration_number} 无用量数据，DoseCard 不渲染`);
    assert.ok(card.reason.includes('未采集用量') || card.reason.includes('关闭'), 'DoseCard 须如实说明未采集/关闭');
  }
});

test('DoseCard 描述符：未采集用量不渲染；关闭开关生效；有源数字用量才绑定', () => {
  const uncollected = doseCardDescriptor(baseItem());
  assert.equal(uncollected.renderable, false);
  assert.ok(uncollected.reason.includes('未采集用量'));
  assert.equal(uncollected.off_switch_supported, true);
  assert.equal(uncollected.closed, false);

  const closed = doseCardDescriptor(baseItem(), { doseCardEnabled: false });
  assert.equal(closed.renderable, false);
  assert.equal(closed.closed, true);
  assert.ok(closed.reason.includes('关闭'));

  const usable = baseItem({
    verification: { usable_as_dose: true, restriction_status: 'unrestricted', dose: { number: '40', unit: '克/公顷', condition: '苗后茎叶喷雾' } },
  });
  const card = doseCardDescriptor(usable);
  assert.equal(card.renderable, true, '有源数字用量须可渲染');
  assert.deepEqual(card.dose, { number: '40', unit: '克/公顷', condition: '苗后茎叶喷雾' });
  assert.equal(card.reason, null);
});

test('DoseCard 与适用过滤所有文案不含禁用词（AC14）', () => {
  const docs = [baseItem(), baseItem({ verification: { usable_as_dose: true, restriction_status: 'unrestricted', dose: { number: '40', unit: '克/公顷', condition: '苗后' } } })];
  for (const item of docs) {
    const card = doseCardDescriptor(item);
    if (card.reason) {
      for (const f of FORBIDDEN_LABELS) assert.ok(!card.reason.includes(f), `DoseCard 文案含禁用词 ${f}`);
    }
    const v = evaluateApplicability(item, { crop_id: 'crop_wheat' });
    for (const r of v.reasons) for (const f of FORBIDDEN_LABELS) assert.ok(!r.includes(f), `适用过滤原因含禁用词 ${f}`);
  }
});

test('跨端一致：小程序镜像与域库同 RULE_VERSION、同判定口径', () => {
  assert.equal(miniReference.APPLICABILITY_RULE_VERSION, APPLICABILITY_RULE_VERSION, '跨端 RULE_VERSION 必须一致');
  assert.equal(typeof miniReference.evaluateApplicability, 'function');
  assert.equal(typeof miniReference.doseCardDescriptor, 'function');
  const item = baseItem();
  const d = evaluateApplicability(item, { crop_id: 'crop_wheat' });
  const m = miniReference.evaluateApplicability(item, { crop_id: 'crop_wheat' });
  assert.equal(d.applicable, m.applicable, '跨端 applicable 须一致');
  assert.deepEqual(d.blocked.sort(), m.blocked.sort(), '跨端 blocked 须一致');
  const dc = miniReference.doseCardDescriptor(item);
  assert.equal(dc.renderable, false);
  assert.equal(dc.rule_version, APPLICABILITY_RULE_VERSION);
  // 关闭开关两条路径一致
  const dcOff = miniReference.doseCardDescriptor(item, { doseCardEnabled: false });
  assert.equal(dcOff.closed, true);
});
