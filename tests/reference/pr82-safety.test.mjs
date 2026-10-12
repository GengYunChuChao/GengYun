// PR #82 三项已证实阻塞的安全回归测试（合成数据，非真实用药）。
//
// 覆盖：
//   P1-1 生育期/地区为必要条件：不符或未采集 → applicable=false（域库与小程序两端）
//   P1-2 DoseCard 资格绑定当前适用判定：禁用/失效/撤回/冲突/未知有效期/下架/模拟/
//        不适用/缺原文条件 → renderable=false；有效合成原文绑定用量 → renderable=true
//   P2   成分/含量跨端一致的精确语义：名称单项、完整组合、不同含量、不同成分、
//        多成分、含量单项、子串混同负例
//   阻塞 A（follow-up）成分名称**精确相等**：同尾/前缀/中缀/后缀子串负例
//   阻塞 B（follow-up）DoseCard 绑定：来源+记录审核都必须显式 verified；
//        用量绑定当前来源版本**与具体登记记录/制剂身份键/原文引用**（防跨制剂挪用）
//   阻塞 C（follow-up）详情页经 profile-api 读取**已确认档案**；未确认/失败不放行
//
// 合成条目均标注与真实资料隔离：record_id 前缀 `syn-`，登记号 `PD-SYN-*`，
// 且绝不写入 packages/knowledge/** 或 db/seeds/**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateApplicability,
  doseCardDescriptor,
  ingredientContentMatch,
  formulationIdentityHash,
  APPLICABILITY_RULE_VERSION,
  FORBIDDEN_LABELS,
  loadHerbicideRecords,
} from '../../packages/reference/index.mjs';
import { parseIngredients } from '../../packages/reference/records.mjs';
import { miniReference } from './_fixtures.mjs';

// —— 阻塞 C（follow-up）：详情页 + profile-api 可控替身 ——
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require_ = createRequire(import.meta.url);
const realReference = require_(path.join(repoRoot, 'miniprogram/utils/reference.js'));
const readPage = (p) => readFileSync(path.join(repoRoot, 'miniprogram', p), 'utf8');

function loadPage({ verified = true, profile = { mode: 'ok', crop_id: 'crop_rice', region_code: '330100' } } = {}) {
  let page;
  const auth = { isLoggedIn: () => verified, requireLogin(cb) { cb(verified); } };
  const gate = { exports: {} };
  vm.runInNewContext(readPage('utils/page-gate.js'), { module: gate, require: () => auth });
  const font = { exports: {} };
  vm.runInNewContext(readPage('utils/font-scale.js'), { module: font });
  const profileApi = {
    binding: () => ({ token: 't', epoch: 1 }),
    current: () => true,
    read() {
      if (profile.mode === 'fail') {
        const e = new Error('NETWORK_UNCERTAIN');
        e.code = 'NETWORK_UNCERTAIN';
        return Promise.reject(e);
      }
      if (profile.mode === 'empty') {
        return Promise.resolve({ crop_id: null, region_code: null, region_catalog_version: null, revision: 1 });
      }
      return Promise.resolve({ crop_id: profile.crop_id ?? 'crop_rice', region_code: profile.region_code ?? '330100', region_catalog_version: 'v1', revision: 1 });
    },
    crops: () => Promise.resolve([]),
    regions: () => Promise.resolve([]),
    save: () => Promise.reject(new Error('not used')),
  };
  const sandbox = {
    Page(def) { page = { ...def, data: structuredClone(def.data), setData(p) { Object.assign(this.data, p); } }; },
    wx: { navigateBack() {}, redirectTo() {}, setClipboardData() {} },
    require: (id) => (id.endsWith('/page-gate') ? gate.exports : id.endsWith('/font-scale') ? font.exports : id.endsWith('/auth') ? auth : id.endsWith('/profile-api') ? profileApi : realReference),
  };
  vm.runInNewContext(readPage('pages/referencedetail/referencedetail.js'), sandbox);
  return { page };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const REAL_ID = realReference.records[0].record_id;

/** 合成条目（默认：来源有效、非禁限用、登记制剂齐备）。**与真实资料隔离**。 */
function synItem(over = {}) {
  return {
    record_id: 'syn-base',
    registration_number: 'PD-SYN-0001',
    registered_name: '合成测试剂',
    producer: '合成测试主体',
    dosage_form: '水分散粒剂',
    ingredients_text: '硝磺草酮 40%',
    use_scene: '水稻移栽田',
    target_original: '一年生阔叶杂草',
    crop_ids: ['crop_rice'],
    growth_stage: '',
    region_codes: [],
    visibility: 'published',
    validity: 'valid',
    simulated: false,
    source: { source_kind: 'verified_seed', evidence_kind: 'research', source_validity: 'valid' },
    source_version: 'syn-source@v1',
    verification: { usable_as_dose: false, review_status: 'unverified', restriction_status: 'unrestricted' },
    ...over,
  };
}

/** 合成「原文绑定用量」条目：数字+单位+原文条件，并绑定来源版本/记录/制剂/引用。 */
function synDoseItem(over = {}) {
  return synItem({
    verification: {
      usable_as_dose: true,
      review_status: 'verified',
      restriction_status: 'unrestricted',
      dose: {
        number: '40',
        unit: '克/公顷',
        condition: '苗后茎叶喷雾',
        source_version: 'syn-source@v1',
        record_id: 'syn-base',
        formulation: {
          registration_number: 'PD-SYN-0001',
          registered_name: '合成测试剂',
          dosage_form: '水分散粒剂',
          ingredients_text: '硝磺草酮 40%',
        },
        reference: '合成公告 2026 年第 9 期附表第 1 行（仅测试）',
      },
    },
    ...over,
  });
}

// ---------------------------------------------------------------------------
// P1-1：生育期与地区为必要条件（域库 + 小程序两端）
// ---------------------------------------------------------------------------

test('P1-1：生育期不符 → applicable=false（域库与小程序）', () => {
  const item = synItem({ growth_stage: 'seedling' });
  for (const [label, fn] of [['域库', evaluateApplicability], ['小程序', miniReference.evaluateApplicability]]) {
    const v = fn(item, { growth_stage: 'flowering' });
    assert.equal(v.applicable, false, `${label}：生育期不符不得判可执行资格`);
    assert.ok(v.blocked.includes('growth_stage'), `${label}：须阻断 growth_stage`);
    assert.ok(v.reasons.includes('生育期不符'), `${label}：须给出「生育期不符」`);
  }
});

test('P1-1：生育期未采集而上下文要求 → applicable=false（域库与小程序）', () => {
  const item = synItem({ growth_stage: '' });
  for (const [label, fn] of [['域库', evaluateApplicability], ['小程序', miniReference.evaluateApplicability]]) {
    const v = fn(item, { growth_stage: 'seedling' });
    assert.equal(v.applicable, false, `${label}：未采集生育期不得判可执行资格`);
    assert.ok(v.blocked.includes('growth_stage'), `${label}：须阻断 growth_stage`);
    assert.ok(v.reasons.some((r) => r.includes('未采集生育期')), `${label}：须如实说明未采集`);
  }
});

test('P1-1：请求地区而记录未标注 → applicable=false（域库与小程序）', () => {
  const item = synItem({ region_codes: [] });
  for (const [label, fn] of [['域库', evaluateApplicability], ['小程序', miniReference.evaluateApplicability]]) {
    const v = fn(item, { region_code: '330100' });
    assert.equal(v.applicable, false, `${label}：未标注地区不得判可执行资格`);
    assert.ok(v.blocked.includes('region'), `${label}：须阻断 region`);
    assert.ok(v.reasons.some((r) => r.includes('未标注适用地区')), `${label}：须如实说明未标注`);
  }
});

test('P1-1：地区不符 → applicable=false；相符 → 不过度收紧', () => {
  const item = synItem({ region_codes: ['330100', '330200'] });
  assert.equal(evaluateApplicability(item, { region_code: '330300' }).applicable, false);
  assert.equal(evaluateApplicability(item, { region_code: '330100' }).applicable, true, '相符时不得阻断');
});

test('P1-1：未要求该维度时，未采集/未标注不参与判定（不静默收紧无条件查询）', () => {
  const item = synItem({ growth_stage: '', region_codes: [] });
  const v = evaluateApplicability(item, {});
  assert.equal(v.applicable, true, '无上下文要求时不应因未采集而阻断');
  assert.equal(v.blocked.length, 0);
});

test('P1-1：「可以查阅」与「适用/可展示用量」分离：queryable 不受适用收紧影响', () => {
  const doc = loadHerbicideRecords();
  const item = doc.items[0];
  // 详情可查询（queryable）与适用资格（applicable）是两个独立判定。
  const v = evaluateApplicability(item, { region_code: '330100' });
  assert.equal(v.applicable, false, '未标注地区而上下文要求地区 → 不适用');
  assert.ok(v.reasons.length > 0, '仍须给出可读原因（AC02）');
});

// ---------------------------------------------------------------------------
// P1-2：DoseCard 资格绑定当前适用判定
// ---------------------------------------------------------------------------

// 说明：这些用例**基于完整正例**构造，只改目标维度，从而精准断言拒绝原因
// （若用残缺夹具，会先被更早的绑定检查拒绝，无法验证该维度本身）。
const DOSE_REJECT_CASES = [
  ['独立禁用（banned）', (i) => { i.verification.restriction_status = 'banned'; }, '禁用'],
  ['限用未确认（restricted）', (i) => { i.verification.restriction_status = 'restricted'; }, '限用'],
  ['禁限用未知', (i) => { i.verification.restriction_status = 'unknown'; }, '禁限用'],
  ['来源 expired', (i) => { i.source.source_validity = 'expired'; i.validity = 'expired'; }, '来源当前不可用'],
  ['来源 withdrawn', (i) => { i.source.source_validity = 'withdrawn'; i.validity = 'withdrawn'; }, '来源当前不可用'],
  ['来源 conflicting', (i) => { i.source.source_validity = 'conflicting'; i.validity = 'conflicting'; }, '来源当前不可用'],
  ['来源 unknown 有效期', (i) => { i.source.source_validity = 'unknown'; i.validity = 'unknown'; }, '来源当前不可用'],
  ['下架（hidden）', (i) => { i.visibility = 'hidden'; }, '来源当前不可用'],
  ['模拟记录（simulated）', (i) => { i.simulated = true; }, '模拟'],
  ['缺登记证号', (i) => { i.registration_number = ''; }, '登记'],
  ['条件为 null', (i) => { i.verification.dose.condition = null; }, '原文条件'],
  ['条件为空串', (i) => { i.verification.dose.condition = '   '; }, '原文条件'],
  ['缺数字用量', (i) => { i.verification.dose.number = ''; }, '未采集'],
  ['缺单位', (i) => { i.verification.dose.unit = ''; }, '未采集'],
];

test('P1-2：禁用/失效/撤回/冲突/未知/下架/模拟/缺条件/不适用 → DoseCard 一律不渲染（两端）', () => {
  for (const [label, mutate, expectInReason] of DOSE_REJECT_CASES) {
    for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
      const item = completeDoseItem();
      mutate(item);
      const card = fn(item);
      assert.equal(card.renderable, false, `${side} ${label}：不得渲染`);
      assert.ok(card.reason && card.reason.length > 0, `${side} ${label}：须给出拒绝原因`);
      assert.ok(card.reason.includes(expectInReason), `${side} ${label}：原因应说明「${expectInReason}」，实际「${card.reason}」`);
      for (const f of FORBIDDEN_LABELS) assert.ok(!card.reason.includes(f), `${side} ${label}：文案含禁用词 ${f}`);
    }
  }
});

test('P1-2：不适用（作物/生育期/地区/成分/场景不符或未采集）→ DoseCard 不渲染', () => {
  const badContexts = [
    { crop_id: 'crop_wheat' },
    { growth_stage: '播种前' },
    { region_code: '330300' },
    { ingredient_content: '草甘膦' },
    { use_scene: '茶园' },
    { dosage_form: '乳油' },
  ];
  for (const ctx of badContexts) {
    for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
      const item = completeDoseItem();
      const card = fn(item, { context: ctx });
      assert.equal(card.renderable, false, `${side} ${JSON.stringify(ctx)}：不适用不得渲染`);
      assert.equal(card.applicable, false, `${side}：应标注 applicable=false`);
    }
  }
});

test('P1-2：功能开关关闭 → 不渲染（但关闭不能代替资格验证）', () => {
  const item = completeDoseItem();
  for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
    const closed = fn(item, { doseCardEnabled: false });
    assert.equal(closed.renderable, false, `${side}：关闭时不得渲染`);
    assert.equal(closed.closed, true);
    assert.ok(closed.reason.includes('关闭'));
    // 开关**开启**时仍必须走资格验证：对禁用记录依旧拒绝。
    const banned = completeDoseItem();
    banned.verification.restriction_status = 'banned';
    const opened = fn(banned, { doseCardEnabled: true, context: FULL_CTX });
    assert.equal(opened.renderable, false, `${side}：开关开启不能代替资格验证`);
  }
});

test('P1-2：有效合成原文绑定用量 → 可渲染（防过度收紧）', () => {
  // 单一 payload 直接喂两端（绑定用显式字段比对，无需按端另造数据）。
  const item = completeDoseItem();
  for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
    const card = fn(item, { context: FULL_CTX });
    assert.equal(card.renderable, true, `${side}：有效合成原文绑定用量应可渲染`);
    assert.equal(card.applicable, true);
    assert.deepEqual(card.dose, { number: '40', unit: '克/公顷', condition: '苗后茎叶喷雾' });
    assert.equal(card.reason, null);
    assert.equal(card.rule_version, APPLICABILITY_RULE_VERSION, '所有消费端同一规则版本');
  }
});

test('P1-2：真实 20 条记录的 DoseCard 全部不渲染（原始标签仍缺）', () => {
  const doc = loadHerbicideRecords();
  assert.ok(doc.items.length >= 20);
  for (const item of doc.items) {
    const card = doseCardDescriptor(item);
    assert.equal(card.renderable, false, `${item.registration_number}：真实资料无用量字段，不得渲染`);
    assert.ok(card.reason.length > 0);
  }
});

// ---------------------------------------------------------------------------
// P2：成分/含量跨端一致的精确语义
// ---------------------------------------------------------------------------

/** 同一合成条目 + 上下文，两端判定必须一致。 */
function assertParity(ingredientsText, contextValue) {
  const item = synItem({ ingredients_text: ingredientsText });
  const d = evaluateApplicability(item, { ingredient_content: contextValue });
  const m = miniReference.evaluateApplicability(item, { ingredient_content: contextValue });
  assert.equal(d.applicable, m.applicable, `「${ingredientsText}」×「${contextValue}」两端 applicable 须一致（域库 ${d.applicable} / 小程序 ${m.applicable}）`);
  assert.deepEqual(d.blocked.sort(), m.blocked.sort(), `「${ingredientsText}」×「${contextValue}」两端 blocked 须一致`);
  return d;
}

test('P2：PR #82 原反例——「硝磺草酮 40%」完整组合两端一致判相符', () => {
  const d = assertParity('硝磺草酮 40%', '硝磺草酮 40%');
  assert.equal(d.applicable, true, '完整组合相符，不得误判不符');
  assert.ok(!d.blocked.includes('ingredient_content'));
});

test('P2：名称单项命中（唑草酮 → 唑草酮 40%）', () => {
  const d = assertParity('唑草酮 40%', '唑草酮');
  assert.equal(d.applicable, true);
});

test('P2：不同含量不相符（40% ≠ 400 g/L）', () => {
  const d = assertParity('唑草酮 40%', '唑草酮 400g/L');
  assert.equal(d.applicable, false);
  assert.ok(d.blocked.includes('ingredient_content'));
});

test('P2：不同成分不相符（草甘膦 vs 唑草酮 40%）', () => {
  const d = assertParity('唑草酮 40%', '草甘膦');
  assert.equal(d.applicable, false);
  assert.ok(d.blocked.includes('ingredient_content'));
});

test('P2：含量单项命中（40%）', () => {
  const d = assertParity('唑草酮 40%', '40%');
  assert.equal(d.applicable, true);
});

test('P2：子串混同负例——「敌唑草酮 40%」不得命中「唑草酮 40%」', () => {
  const d = assertParity('唑草酮 40%', '敌唑草酮 40%');
  assert.equal(d.applicable, false, '不同成分名称不得因整串子串而判相符');
  assert.ok(d.blocked.includes('ingredient_content'));
});

test('P2：多成分记录——逐成分与含量单项均可命中，混配不符则拒绝', () => {
  const text = '吡氟酰草胺 2%、二甲戊灵 22%';
  assert.equal(assertParity(text, '二甲戊灵 22%').applicable, true);
  assert.equal(assertParity(text, '吡氟酰草胺 2%').applicable, true);
  assert.equal(assertParity(text, '22%').applicable, true);
  assert.equal(assertParity(text, '二甲戊灵 2%').applicable, false, '名称对但含量错 → 拒绝');
  assert.equal(assertParity(text, '莠去津 22%').applicable, false, '含量对但成分错 → 拒绝');
});

test('P2：ingredientContentMatch 纯函数与域库/小程序两端同语义', () => {
  const parsed = parseIngredients('唑草酮 40%');
  const cases = [
    ['唑草酮 40%', true],
    ['唑草酮', true],
    ['40%', true],
    ['唑草酮 400g/L', false],
    ['敌唑草酮 40%', false],
    ['草甘膦', false],
    ['', false],
  ];
  for (const [value, expected] of cases) {
    assert.equal(ingredientContentMatch(parsed, value), expected, `域库 ingredientContentMatch("${value}")`);
    assert.equal(miniReference.ingredientContentMatch(parsed, value), expected, `小程序 ingredientContentMatch("${value}")`);
  }
});

test('P2：跨端 RULE_VERSION 与 blocked 维度集合一致', () => {
  assert.equal(miniReference.APPLICABILITY_RULE_VERSION, APPLICABILITY_RULE_VERSION);
  assert.equal(miniReference.APPLICABILITY_RULE_VERSION, 'gy-i08/1.2.0', 'PR #82 修订后规则版本须已 bump');
  assert.deepEqual(miniReference.APPLICABILITY_DIMENSIONS, [
    'valid_source', 'banned_restricted', 'crop', 'growth_stage', 'region', 'dosage_form', 'ingredient_content', 'use_scene',
  ]);
});

test('PR #82：适用过滤与 DoseCard 全部文案不含禁用词（AC14）', () => {
  const items = [
    synItem(),
    synDoseItem(),
    synDoseItem({ verification: { usable_as_dose: true, restriction_status: 'banned', dose: { number: '40', unit: '克/公顷', condition: '苗后' } } }),
  ];
  const contexts = [{}, { crop_id: 'crop_rice' }, { region_code: '330100' }, { growth_stage: '苗后' }, { ingredient_content: '硝磺草酮 40%' }];
  for (const item of items) {
    for (const ctx of contexts) {
      const card = doseCardDescriptor(item, { context: ctx });
      if (card.reason) for (const f of FORBIDDEN_LABELS) assert.ok(!card.reason.includes(f), `DoseCard 文案含禁用词 ${f}：${card.reason}`);
      const v = evaluateApplicability(item, ctx);
      for (const r of v.reasons) for (const f of FORBIDDEN_LABELS) assert.ok(!r.includes(f), `适用原因含禁用词 ${f}：${r}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 阻塞 A：成分名称**精确相等**（子串混同负例）
// ---------------------------------------------------------------------------

test('阻塞 A：「磺草酮」不得命中「硝磺草酮 40%」（同尾/部分名称子串负例，两端）', () => {
  // 监工独立反例：此前名称分支用 includes，两端同时判 applicable=true。
  const d = assertParity('硝磺草酮 40%', '磺草酮');
  assert.equal(d.applicable, false, '「磺草酮」不是「硝磺草酮」，不得判可执行资格');
  assert.ok(d.blocked.includes('ingredient_content'), '须阻断 ingredient_content');
});

test('阻塞 A：成分名称前缀/中缀/后缀子串一律不命中（两端一致）', () => {
  const cases = [
    ['硝磺', '前缀子串'],
    ['磺草', '中缀子串'],
    ['草酮', '后缀子串'],
    ['硝磺草酮乳', '超集名称'],
    ['硝', '单字'],
  ];
  for (const [value, label] of cases) {
    const d = assertParity('硝磺草酮 40%', value);
    assert.equal(d.applicable, false, `${label}「${value}」不得命中`);
  }
});

test('阻塞 A：完整名称与完整组合仍命中；不同成分/不同含量仍拒绝', () => {
  assert.equal(assertParity('硝磺草酮 40%', '硝磺草酮').applicable, true, '完整名称应命中');
  assert.equal(assertParity('硝磺草酮 40%', '硝磺草酮 40%').applicable, true, '完整组合应命中');
  assert.equal(assertParity('硝磺草酮 40%', '硝磺草酮 400g/L').applicable, false, '不同含量应拒绝');
  assert.equal(assertParity('硝磺草酮 40%', '敌磺草酮 40%').applicable, false, '不同成分应拒绝');
});

test('阻塞 A：多成分逐项与含量单项仍保留正反例（两端一致）', () => {
  const text = '吡氟酰草胺 2%、二甲戊灵 22%';
  assert.equal(assertParity(text, '二甲戊灵 22%').applicable, true);
  assert.equal(assertParity(text, '吡氟酰草胺 2%').applicable, true);
  assert.equal(assertParity(text, '吡氟酰草胺').applicable, true, '完整名称单项应命中');
  assert.equal(assertParity(text, '22%').applicable, true, '含量单项作为精确过滤保留');
  assert.equal(assertParity(text, '2%').applicable, true, '另一成分含量单项');
  assert.equal(assertParity(text, '二甲戊灵 2%').applicable, false, '名称对含量错 → 拒绝');
  assert.equal(assertParity(text, '戊灵 22%').applicable, false, '名称子串 → 拒绝');
  assert.equal(assertParity(text, '莠去津 22%').applicable, false, '成分错 → 拒绝');
});

test('阻塞 A：含量单项是精确过滤，不能独立证明制剂身份', () => {
  // 监工口径：含量单项保留为查询过滤语义，但不得据此认定制剂身份。
  // 「40%」可命中任一含 40% 的成分——故仍需与登记制剂/适用判定共同决定资格。
  const parsed = parseIngredients('唑草酮 40%');
  assert.equal(ingredientContentMatch(parsed, '40%'), true, '含量单项按定义命中');
  // 但仅凭含量无法区分制剂：DoseCard 仍要求登记制剂身份完整（阻塞 B-3）。
  const onlyContent = synDoseItem({ registered_name: '', dose: { number: '40', unit: '克/公顷', condition: '苗后', source_version: 'sv' } });
  assert.equal(doseCardDescriptor(onlyContent).renderable, false, '制剂身份不完整时含量命中也不得渲染');
});

// ---------------------------------------------------------------------------
// 阻塞 B：DoseCard 绑定审核/版本/制剂/模拟来源（单维度变更矩阵）
// ---------------------------------------------------------------------------

/**
 * 完整有效合成正例（**仅用于测试**的合成记录，与真实种子资料隔离）。
 * 绑定点：来源版本、登记记录、完整制剂字段（登记号+名称+剂型+成分含量）、
 *         原文引用/定位依据、数字+单位+原文条件、记录级与来源级审核均为 verified、
 *         来源有效、非禁限用、登记制剂齐备。
 *
 * 这是一个**单一 payload**：原样直接传给域库与小程序 descriptor，两端都必须 renderable=true
 * （绑定用显式字段比对，不依赖任何一端的哈希派生，故无需按端另造数据）。
 */
function completeDoseItem() {
  const base = synItem({
    growth_stage: '苗后',
    region_codes: ['330100'],
    registered_name: '合成测试剂',
    dosage_form: '水分散粒剂',
    ingredients_text: '硝磺草酮 40%',
    verification: {
      usable_as_dose: true,
      review_status: 'verified',
      restriction_status: 'unrestricted',
      dose: {
        number: '40',
        unit: '克/公顷',
        condition: '苗后茎叶喷雾',
        source_version: 'syn-source@v1',
        record_id: 'syn-base',
        formulation: {
          registration_number: 'PD-SYN-0001',
          registered_name: '合成测试剂',
          dosage_form: '水分散粒剂',
          ingredients_text: '硝磺草酮 40%',
        },
        reference: '合成公告 2026 年第 9 期附表第 1 行（仅测试）',
      },
    },
    source_version: 'syn-source@v1',
  });
  base.source = { ...base.source, review_status: 'verified' };
  return base;
}

const FULL_CTX = { crop_id: 'crop_rice', growth_stage: '苗后', region_code: '330100', ingredient_content: '硝磺草酮 40%', use_scene: '水稻' };

test('阻塞 B：单一完整 payload 同时被域库与小程序判可渲染（跨端一致，非按端另造）', () => {
  const payload = completeDoseItem();
  const d = doseCardDescriptor(payload, { context: FULL_CTX });
  const m = miniReference.doseCardDescriptor(payload, { context: FULL_CTX });
  assert.equal(d.renderable, true, '域库：完整有效正例应可渲染');
  assert.equal(m.renderable, true, '小程序：同一 payload 应可渲染');
  assert.deepEqual(d.dose, { number: '40', unit: '克/公顷', condition: '苗后茎叶喷雾' });
  assert.deepEqual(m.dose, d.dose, '两端展示的用量必须一致');
  assert.equal(d.applicable, true);
  assert.equal(m.applicable, true);
});

test('阻塞 B-1：仅改审核状态（verified→unverified/rejected/缺失）→ 从可渲染转为拒绝', () => {
  for (const [label, status] of [['unverified', 'unverified'], ['rejected', 'rejected'], ['缺失', undefined]]) {
    for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
      const item = completeDoseItem();
      if (status === undefined) delete item.verification.review_status;
      else item.verification.review_status = status;
      const card = fn(item, { context: FULL_CTX });
      assert.equal(card.renderable, false, `${side} 审核=${label} 不得渲染`);
      assert.ok(card.reason.includes('审核'), `${side} 应说明审核未绑定，实际：${card.reason}`);
    }
  }
});

test('阻塞 B-1：来源审核状态冲突不得取较宽松状态', () => {
  // 记录自标 verified 但来源 rejected / unverified / 缺失 → 拒绝（不取较宽松状态）。
  for (const [label, sourceStatus] of [['rejected', 'rejected'], ['unverified', 'unverified'], ['缺失', undefined]]) {
    for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
      const item = completeDoseItem();
      if (sourceStatus === undefined) delete item.source.review_status;
      else item.source.review_status = sourceStatus;
      const card = fn(item, { context: FULL_CTX });
      assert.equal(card.renderable, false, `${side} 来源审核=${label} 不得渲染`);
      assert.ok(card.reason.includes('审核'), `${side} 应说明审核未绑定，实际：${card.reason}`);
    }
  }
  // 两侧都为 verified 时不影响正例。
  for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
    assert.equal(fn(completeDoseItem(), { context: FULL_CTX }).renderable, true, `${side} 两侧 verified 应可渲染`);
  }
});

test('阻塞 B-2：仅改用量版本绑定（陈旧/缺失/不匹配）→ 拒绝', () => {
  for (const [label, mutate] of [
    ['陈旧版本', (i) => { i.verification.dose.source_version = 'syn-source@v0'; }],
    ['缺失绑定', (i) => { delete i.verification.dose.source_version; }],
    ['空串绑定', (i) => { i.verification.dose.source_version = '  '; }],
  ]) {
    for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
      const item = completeDoseItem();
      mutate(item);
      const card = fn(item, { context: FULL_CTX });
      assert.equal(card.renderable, false, `${side} ${label} 不得渲染`);
      assert.ok(card.reason.includes('来源版本'), `${side} 应说明未绑定当前来源版本，实际：${card.reason}`);
    }
  }
  // 与当前 source_version 一致时不影响正例。
  assert.equal(doseCardDescriptor(completeDoseItem(), { context: FULL_CTX }).renderable, true);
});

test('阻塞 B-3：仅空掉一个制剂身份字段（名称/剂型/成分含量）→ 拒绝', () => {
  for (const [label, field] of [['registered_name', 'registered_name'], ['dosage_form', 'dosage_form'], ['ingredients_text', 'ingredients_text']]) {
    for (const empty of ['', '   ']) {
      for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
        const item = completeDoseItem();
        item[field] = empty;
        const card = fn(item, { context: FULL_CTX });
        assert.equal(card.renderable, false, `${side} ${field}=${JSON.stringify(empty)} 不得渲染`);
        assert.ok(card.reason.includes('制剂'), `${side} 应说明制剂身份不完整，实际：${card.reason}`);
      }
    }
  }
  // 仅登记号存在、其余全空 → 拒绝（监工反例 3）。
  for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
    const onlyReg = completeDoseItem();
    onlyReg.registered_name = '';
    onlyReg.dosage_form = '';
    onlyReg.ingredients_text = '';
    assert.equal(fn(onlyReg, { context: FULL_CTX }).renderable, false, `${side} 仅登记号存在不得渲染`);
  }
});

test('阻塞 B-4：仅把来源改为模拟（source_kind=simulation，item.simulated=false）→ 拒绝', () => {
  for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
    const item = completeDoseItem();
    item.source = { ...item.source, source_kind: 'simulation' };
    item.simulated = false; // 标志位仍为 false：必须实名判定来源类型
    const card = fn(item, { context: FULL_CTX });
    assert.equal(card.renderable, false, `${side} simulation 来源不得渲染`);
    assert.ok(card.reason.includes('模拟'), `${side} 应说明模拟来源，实际：${card.reason}`);
  }
});

test('阻塞 B-4：SIM- 登记号前缀即使标志位为 false 也不得作为真实用量依据', () => {
  for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
    const item = completeDoseItem();
    item.registration_number = 'SIM-20260001';
    item.simulated = false;
    const card = fn(item, { context: FULL_CTX });
    assert.equal(card.renderable, false, `${side} SIM- 登记号不得渲染`);
    assert.ok(card.reason.includes('模拟'), `${side} 应说明模拟来源，实际：${card.reason}`);
  }
});

test('阻塞 B-4：include_simulated 只放开查阅，不放开真实用量卡片', () => {
  // 显式构造三种模拟判据（completeDoseItem 不接受覆盖参数，故直接改字段）。
  for (const [label, mutate] of [
    ['simulated 标志位', (i) => { i.simulated = true; }],
    ['source_kind=simulation', (i) => { i.source.source_kind = 'simulation'; }],
    ['SIM- 登记号', (i) => { i.registration_number = 'SIM-1'; }],
  ]) {
    for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
      const item = completeDoseItem();
      mutate(item);
      const card = fn(item, { context: FULL_CTX, includeSimulated: true });
      assert.equal(card.renderable, false, `${side} ${label}：include_simulated 不得放开真实用量卡片`);
    }
  }
});

test('阻塞 B：单维度变更矩阵——每项只改一个维度即可由可渲染转为拒绝（不互相掩盖）', () => {
  const baseline = doseCardDescriptor(completeDoseItem(), { context: FULL_CTX });
  assert.equal(baseline.renderable, true, '基线必须可渲染，否则矩阵无意义');
  const mutations = [
    ['审核 unverified', (i) => { i.verification.review_status = 'unverified'; }],
    ['审核 rejected', (i) => { i.verification.review_status = 'rejected'; }],
    ['来源审核 rejected', (i) => { i.source.review_status = 'rejected'; }],
    ['用量版本陈旧', (i) => { i.verification.dose.source_version = 'old'; }],
    ['用量版本缺失', (i) => { delete i.verification.dose.source_version; }],
    ['名称为空', (i) => { i.registered_name = ''; }],
    ['剂型为空', (i) => { i.dosage_form = ''; }],
    ['成分含量为空', (i) => { i.ingredients_text = ''; }],
    ['来源模拟', (i) => { i.source.source_kind = 'simulation'; }],
    ['SIM- 登记号', (i) => { i.registration_number = 'SIM-1'; }],
    ['模拟标志位', (i) => { i.simulated = true; }],
    ['条件缺失', (i) => { delete i.verification.dose.condition; }],
    ['数字缺失', (i) => { delete i.verification.dose.number; }],
    ['单位缺失', (i) => { delete i.verification.dose.unit; }],
    ['禁用', (i) => { i.verification.restriction_status = 'banned'; }],
    ['限用', (i) => { i.verification.restriction_status = 'restricted'; }],
    ['禁限用未知', (i) => { i.verification.restriction_status = 'unknown'; }],
    ['来源失效', (i) => { i.source.source_validity = 'expired'; i.validity = 'expired'; }],
    ['作物不符', (i) => { i.crop_ids = ['crop_wheat']; }],
    ['地区不符', (i) => { i.region_codes = ['330200']; }],
    ['生育期不符', (i) => { i.growth_stage = '播种前'; }],
    ['成分不符', (i) => { i.ingredients_text = '敌磺草酮 40%'; }],
    ['场景不符', (i) => { i.use_scene = '茶园'; }],
    ['剂型不符', (i) => { i.dosage_form = '乳油'; }],
    // —— follow-up 复核：绑定维度 ——
    ['来源审核缺失', (i) => { delete i.source.review_status; }],
    ['来源审核 unverified', (i) => { i.source.review_status = 'unverified'; }],
    ['来源审核 rejected', (i) => { i.source.review_status = 'rejected'; }],
    ['记录绑定不符', (i) => { i.verification.dose.record_id = 'syn-other'; }],
    ['记录绑定缺失', (i) => { delete i.verification.dose.record_id; }],
    ['制剂绑定不符', (i) => { i.verification.dose.formulation = { ...i.verification.dose.formulation, registered_name: '其他制剂' }; }],
    ['制剂绑定缺失', (i) => { delete i.verification.dose.formulation; }],
    ['引用依据缺失', (i) => { delete i.verification.dose.reference; }],
    ['引用依据为空', (i) => { i.verification.dose.reference = '   '; }],
  ];
  const seenReasons = new Set();
  for (const [label, mutate] of mutations) {
    for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
      const item = completeDoseItem();
      mutate(item);
      const card = fn(item, { context: FULL_CTX });
      assert.equal(card.renderable, false, `${side} ${label}：单维度变更必须转为拒绝`);
      assert.ok(card.reason && card.reason.length > 0, `${side} ${label}：必须给出拒绝原因`);
      seenReasons.add(card.reason);
    }
  }
  // 拒绝原因必须覆盖多个不同类别（证明不是所有负例都被同一个缺失字段掩盖）。
  assert.ok(seenReasons.size >= 12, `拒绝原因应至少覆盖 12 类，实际 ${seenReasons.size} 类：${[...seenReasons].join(' / ')}`);
});

// ---------------------------------------------------------------------------
// 监工 follow-up 复核：来源审核缺失、跨制剂挪用、引用定位、跨端同判
// ---------------------------------------------------------------------------

test('follow-up 1：来源审核缺失时，即使记录 verified 也不得放行', () => {
  for (const [label, mutate] of [
    ['来源 review_status 缺失', (i) => { delete i.source.review_status; }],
    ['来源 review_status=unverified', (i) => { i.source.review_status = 'unverified'; }],
    ['来源 review_status=rejected', (i) => { i.source.review_status = 'rejected'; }],
    ['来源 review_status 非枚举值', (i) => { i.source.review_status = 'made_up'; }],
    ['记录 review_status 缺失', (i) => { delete i.verification.review_status; }],
  ]) {
    for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
      const item = completeDoseItem();
      mutate(item);
      const card = fn(item, { context: FULL_CTX });
      assert.equal(card.renderable, false, `${side} ${label} 不得渲染`);
      assert.ok(card.reason.includes('审核'), `${side} 应说明审核未绑定，实际：${card.reason}`);
    }
  }
});

test('follow-up 2：同一 source_version 的其他制剂不得挪用同一张用量卡（单一 payload 两端同判）', () => {
  // 真实 20 条记录的 source_version 来自**同一公告**（共享版本），
  // 因此仅 dose.source_version === item.source_version 不足以绑定具体制剂。
  const shared = 'src_moa_pd_2026@2026-10-04#bfe97d34e219';
  // 上下文与 a 的实际成分一致（唑草酮 40%），确保只有「制剂绑定」这一个变量。
  const ctxA = { crop_id: 'crop_rice', growth_stage: '苗后', region_code: '330100', ingredient_content: '唑草酮 40%', use_scene: '水稻' };
  const a = completeDoseItem();
  a.record_id = 'syn-a';
  a.registered_name = '合成甲';
  a.ingredients_text = '唑草酮 40%';
  a.source_version = shared;
  a.verification.dose = {
    ...a.verification.dose,
    source_version: shared,
    record_id: 'syn-a',
    formulation: { registration_number: a.registration_number, registered_name: '合成甲', dosage_form: a.dosage_form, ingredients_text: '唑草酮 40%' },
  };
  // b 与 a 共享同一 source_version，但 dose 指向 a 的记录与制剂（跨制剂挪用）。
  const b = completeDoseItem();
  b.record_id = 'syn-b';
  b.registered_name = '合成乙';
  b.ingredients_text = '敌磺草酮 40%';
  b.source_version = shared;
  b.verification.dose = { ...a.verification.dose, record_id: 'syn-a' };
  for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
    assert.equal(fn(a, { context: ctxA }).renderable, true, `${side} 自身绑定应可渲染`);
    assert.equal(fn(b, { context: ctxA }).renderable, false, `${side} 挪用他剂制用量卡不得渲染`);
  }
});

test('follow-up 2：仅改当前制剂的名称/剂型/成分含量之一 → 绑定失配即拒绝（两端）', () => {
  for (const [label, mutate] of [
    ['改名称', (i) => { i.registered_name = '合成改名剂'; }],
    ['改剂型', (i) => { i.dosage_form = '乳油'; }],
    ['改成分含量', (i) => { i.ingredients_text = '敌磺草酮 40%'; }],
    ['改登记号', (i) => { i.registration_number = 'PD-SYN-9999'; }],
  ]) {
    for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
      const item = completeDoseItem();
      mutate(item);
      const card = fn(item, { context: FULL_CTX });
      assert.equal(card.renderable, false, `${side} ${label} 不得渲染（绑定失配）`);
      assert.ok(card.reason.includes('制剂') || card.reason.includes('登记'), `${side} 应说明制剂绑定不符，实际：${card.reason}`);
    }
  }
});

test('follow-up 2：record_id 双侧缺失不得因 "" === "" 被当绑定', () => {
  for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
    const item = completeDoseItem();
    delete item.record_id;
    delete item.verification.dose.record_id;
    const card = fn(item, { context: FULL_CTX });
    assert.equal(card.renderable, false, `${side} record_id 双缺不得渲染`);
    assert.ok(card.reason.includes('登记记录'), `${side} 应说明未绑定登记记录，实际：${card.reason}`);
  }
});

test('follow-up 2：原文引用/定位依据缺失或为空 → 拒绝', () => {
  for (const [label, mutate] of [
    ['缺失', (i) => { delete i.verification.dose.reference; }],
    ['空串', (i) => { i.verification.dose.reference = ''; }],
    ['纯空白', (i) => { i.verification.dose.reference = '   '; }],
    ['非字符串', (i) => { i.verification.dose.reference = 42; }],
  ]) {
    for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
      const item = completeDoseItem();
      mutate(item);
      const card = fn(item, { context: FULL_CTX });
      assert.equal(card.renderable, false, `${side} 引用${label} 不得渲染`);
      assert.ok(card.reason.includes('引用') || card.reason.includes('定位'), `${side} 应说明缺引用/定位依据，实际：${card.reason}`);
    }
  }
});

test('follow-up 2：制剂绑定校验跨端一致（同一 payload 同一结论）', () => {
  // 绑定用**显式字段比对**（不用任何一端的哈希派生），因此同一 payload 在两端结论一致。
  const payload = completeDoseItem();
  assert.equal(doseCardDescriptor(payload, { context: FULL_CTX }).renderable, true, '域库：正例可渲染');
  assert.equal(miniReference.doseCardDescriptor(payload, { context: FULL_CTX }).renderable, true, '小程序：同一 payload 可渲染');
  for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
    const broken = JSON.parse(JSON.stringify(payload));
    broken.verification.dose.formulation = { ...broken.verification.dose.formulation, registered_name: '其他制剂' };
    assert.equal(fn(broken, { context: FULL_CTX }).renderable, false, `${side} 制剂绑定不符须拒绝`);
  }
});

test('follow-up 2：formulationIdentityHash 对同名不同含量/剂型仍产生不同契约身份', () => {
  // 契约身份哈希保持既有算法不变（决定 formulation.id/UUID）；
  // DoseCard 绑定不依赖它，但同名不同含量剂型仍不得合并为同一制剂。
  const a = { registered_name: 'X', dosage_form: '可湿性粉剂', ingredients_text: '莠去津 38%' };
  const b = { registered_name: 'X', dosage_form: '悬乳剂', ingredients_text: '莠去津 50%' };
  assert.notEqual(formulationIdentityHash(a), formulationIdentityHash(b), '同名不同含量剂型不得同一制剂身份');
});

test('follow-up 3：详情页档案接线保留身份/离开/旧回调保护（失败不放行）', async () => {
  const { page } = loadPage({ verified: true, profile: { mode: 'fail' } });
  page.onLoad({ id: REAL_ID });
  await settle();
  // 失败后不得出现可执行用量资格。
  assert.equal(page.data.applicability, null);
  assert.equal(page.data.doseCard, null);
  assert.equal(page.data.profileConfirmed, false);
  // 页面离开后不得再回填资格。
  page.onHide();
  await settle();
  assert.equal(page.data.applicability, null, '离开后不得回填适用结论');
  assert.equal(page.data.doseCard, null, '离开后不得回填 DoseCard');
});


test('阻塞 B：真实 20 条记录 + 既有投影仍为可用卡 0（不伪造真实用量）', () => {
  const doc = loadHerbicideRecords();
  let renderable = 0;
  for (const item of doc.items) {
    const card = doseCardDescriptor(item);
    assert.equal(card.renderable, false, `${item.registration_number} 不得渲染`);
    renderable += card.renderable ? 1 : 0;
  }
  assert.equal(renderable, 0, '真实资料可用 DoseCard 必须为 0');
  // Knowledge 契约投影的 dose_cards 仍为空数组（冻结契约不改）。
  for (const item of doc.items) assert.deepEqual(item.knowledge.dose_cards, []);
});

test('阻塞 B：规则版本已 bump 且两端一致', () => {
  assert.equal(APPLICABILITY_RULE_VERSION, 'gy-i08/1.2.0');
  assert.equal(miniReference.APPLICABILITY_RULE_VERSION, APPLICABILITY_RULE_VERSION, '两端 RULE_VERSION 必须一致');
});

// ---------------------------------------------------------------------------
// follow-up 4：来源有效期矛盾、空串 ?? / || 差异、include_simulated 不放行资格
// ---------------------------------------------------------------------------

test('follow-up 4：source.source_validity=expired 而顶层 validity=valid → 两端都拒绝', () => {
  const item = completeDoseItem();
  item.source = { ...item.source, source_validity: 'expired' };
  item.validity = 'valid'; // 陈旧顶层标志不得放行
  for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
    const card = fn(item, { context: FULL_CTX });
    assert.equal(card.renderable, false, `${side} 来源已过期不得渲染`);
    assert.ok(card.reason.includes('来源当前不可用'), `${side} 应说明来源不可用，实际：${card.reason}`);
  }
});

test('follow-up 4：来源有效期缺失/撤回/冲突/未知 → 两端都拒绝', () => {
  for (const validity of ['withdrawn', 'conflicting', 'unknown']) {
    const item = completeDoseItem();
    item.source = { ...item.source, source_validity: validity };
    item.validity = 'valid';
    for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
      assert.equal(fn(item, { context: FULL_CTX }).renderable, false, `${side} 来源 ${validity} 不得渲染`);
    }
  }
});

test('follow-up 4：仅删除 source.source_validity（顶层 validity 仍 valid）→ 两端都拒绝', () => {
  // 监工独立发现：来源有效性缺失不能被顶层缓存掩盖。
  const item = completeDoseItem();
  delete item.source.source_validity;
  item.validity = 'valid';
  for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
    const card = fn(item, { context: FULL_CTX });
    assert.equal(card.renderable, false, `${side} 来源有效期缺失不得渲染`);
    assert.ok(card.reason.includes('来源当前不可用'), `${side} 应说明来源不可用，实际：${card.reason}`);
  }
  for (const [side, fn] of [['域库', evaluateApplicability], ['小程序', miniReference.evaluateApplicability]]) {
    const v = fn(item, {});
    assert.equal(v.applicable, false, `${side} 来源有效期缺失不得判可执行资格`);
    assert.ok(v.blocked.includes('valid_source'), `${side} 应阻断 valid_source`);
  }
});

test('follow-up 4（监工补充）：source_validity 显式空串 + source.validity=valid → 两端都拒绝', () => {
  // 域库 `??` 保留显式空串 → unknown → 拒绝；小程序不得用真假值把空串覆盖成别名字段。
  const item = completeDoseItem();
  item.source = { ...item.source, source_validity: '', validity: 'valid' };
  item.validity = 'valid';
  for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
    const card = fn(item, { context: FULL_CTX });
    assert.equal(card.renderable, false, `${side} 显式空串来源有效期不得渲染`);
    assert.ok(card.reason.includes('来源当前不可用'), `${side} 应说明来源不可用，实际：${card.reason}`);
  }
  for (const [side, fn] of [['域库', evaluateApplicability], ['小程序', miniReference.evaluateApplicability]]) {
    const v = fn(item, {});
    assert.equal(v.applicable, false, `${side} 显式空串来源有效期不得判可执行资格`);
    assert.ok(v.blocked.includes('valid_source'), `${side} 应阻断 valid_source`);
  }
});

test('follow-up 4（监工补充）：source.validity 显式空串（source_validity 缺失）→ 两端都拒绝', () => {
  const item = completeDoseItem();
  delete item.source.source_validity;
  item.source = { ...item.source, validity: '' };
  for (const [side, fn] of [['域库', doseCardDescriptor], ['小程序', miniReference.doseCardDescriptor]]) {
    assert.equal(fn(item, { context: FULL_CTX }).renderable, false, `${side} 显式空串 source.validity 不得渲染`);
  }
});

test('follow-up 4：growth_stage 空串 + verification.growth_stage 有效值 → 两端同判', () => {
  for (const stage of ['苗后', '播种前', '']) {
    const item = completeDoseItem();
    item.growth_stage = ''; // 顶层空串
    item.verification.growth_stage = stage;
    for (const ctx of [{ growth_stage: '苗后' }, { growth_stage: '播种前' }]) {
      const d = evaluateApplicability(item, ctx);
      const m = miniReference.evaluateApplicability(item, ctx);
      assert.equal(d.applicable, m.applicable, `stage=${JSON.stringify(stage)} ctx=${JSON.stringify(ctx)}：两端 applicable 须一致`);
      assert.deepEqual(d.blocked.sort(), m.blocked.sort(), `stage=${JSON.stringify(stage)} ctx=${JSON.stringify(ctx)}：两端 blocked 须一致`);
    }
  }
});

test('follow-up 4：restriction_status 空串 + source.restriction_status 有效值 → 两端同判', () => {
  for (const status of ['unrestricted', 'restricted', 'banned', 'unknown', '']) {
    const item = completeDoseItem();
    item.verification.restriction_status = ''; // 记录级空串 → 回退来源级
    item.source.restriction_status = status;
    // 两端必须同判（关键：不能用 ?? 与 || 造成一端 fail-closed、一端放行）。
    const d = evaluateApplicability(item, {});
    const m = miniReference.evaluateApplicability(item, {});
    assert.equal(d.applicable, m.applicable, `restriction=${JSON.stringify(status)}：两端 applicable 须一致`);
    assert.deepEqual(d.blocked.sort(), m.blocked.sort(), `restriction=${JSON.stringify(status)}：两端 blocked 须一致`);
    // 记录级与来源级**都**为空/未知 → fail-closed 阻断。
    if (status === '' || status === 'unknown') {
      assert.equal(d.applicable, false, `restriction=${JSON.stringify(status)}：未知禁限用须阻断`);
      assert.ok(d.blocked.includes('banned_restricted'));
    }
    // banned / restricted 一律阻断；unrestricted 不因此维度阻断。
    if (status === 'banned' || status === 'restricted') {
      assert.equal(d.applicable, false, `restriction=${status} 须阻断`);
    }
  }
});

test('follow-up 4：include_simulated 不得令 evaluateApplicability 产生可执行资格', () => {
  for (const [label, mutate] of [
    ['simulated 标志位', (i) => { i.simulated = true; }],
    ['source_kind=simulation', (i) => { i.source.source_kind = 'simulation'; }],
    ['SIM- 登记号', (i) => { i.registration_number = 'SIM-1'; }],
  ]) {
    const item = completeDoseItem();
    mutate(item);
    for (const [side, fn] of [['域库', evaluateApplicability], ['小程序', miniReference.evaluateApplicability]]) {
      const v = fn(item, { include_simulated: true });
      assert.equal(v.applicable, false, `${side} ${label}：include_simulated 只放开查阅，不得产生可执行资格`);
      assert.ok(v.blocked.includes('valid_source'), `${side} ${label}：应阻断 valid_source`);
    }
  }
});


