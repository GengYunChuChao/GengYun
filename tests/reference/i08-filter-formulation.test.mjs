// GY-I08 / #8：制剂（剂型）与有效成分含量**适用过滤** + 命中侧可解释字段 + 用药安全边界。
//
// 覆盖口径（docs/implementation-requirements.md:133-137、:299-303、:573-575 AC13）：
//   1. 剂型筛选：只按登记剂型收窄，命中/未命中都有可解释字段（matched_dimensions / unmatched_reasons）；
//      记录未采集剂型 → fail-closed（insufficient），不得当作「符合」放行。
//   2. 有效成分/含量：精确语义（名称精确相等、含量精确相等），不做子串包含、不做换算；
//      「硝磺草酮」不得命中「磺草酮」，「二甲戊灵 2%」不得命中「二甲戊灵 22%」。
//   3. 安全边界（红线）：用量恒不展示；剂量式/混配式输入不产生任何剂量或方案；
//      未登记作物显式拒绝；越界补充剂量不产出 DoseCard。
//   4. 跨端同判：packages/reference/query.mjs 与 miniprogram/utils/reference.js 同输入同结果；
//      页面剂型选择器走随包离线路径并如实标注「条件未被丢弃」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { miniReference } from './_fixtures.mjs';
import { normalizeQuery, runQuery, appliedDimensions } from '../../packages/reference/query.mjs';
import { loadCatalog } from '../../packages/reference/catalog.mjs';
import { loadHerbicideRecords } from '../../packages/reference/records.mjs';
import { doseCardDescriptor } from '../../packages/reference/labels.mjs';

const require = createRequire(import.meta.url);
const knowledgeApi = require('../../miniprogram/utils/knowledge-api.js');
const RECORDS = loadHerbicideRecords().items;
const CATALOG = loadCatalog();

function domainQuery(params) {
  return runQuery(RECORDS, normalizeQuery(params, CATALOG), CATALOG);
}

/** 载入页面模块（vm 沙箱 + 真实 utils/reference 与真实 knowledge-api，仅认证门禁用替身）。 */
function loadReferencePage(options = {}) {
  const source = readFileSync(fileURLToPath(new URL('../../miniprogram/pages/reference/reference.js', import.meta.url)), 'utf8');
  const net = { enabled: Boolean(options.network) };
  let captured = null;
  const sandbox = {
    Page(definition) { captured = definition; },
    require(spec) {
      if (spec.includes('font-scale')) return { applyFontScale() {} };
      if (spec.includes('page-gate')) return { start(_page, cb) { cb(true); }, cancel() {} };
      if (spec.includes('knowledge-api')) return knowledgeApi;
      if (spec.includes('reference')) return miniReference;
      if (spec.includes('auth')) return { isLoggedIn: () => true, networkEnabled: () => net.enabled };
      throw new Error('Unexpected page dependency: ' + spec);
    },
    module: { exports: {} },
    console,
    JSON,
    Number,
    Object,
    Boolean,
    Array,
    String,
    Error,
    encodeURIComponent
  };
  vm.runInNewContext(source, sandbox, { filename: 'miniprogram/pages/reference/reference.js' });
  return { definition: captured, net };
}

function instantiatePage(options = {}) {
  const loaded = loadReferencePage(options);
  const page = Object.assign({}, loaded.definition);
  page.data = JSON.parse(JSON.stringify(loaded.definition.data));
  page.setData = function setData(patch) { Object.assign(this.data, patch); };
  page.net = loaded.net;
  return page;
}

// ---------------------------------------------------------------- 剂型筛选（命中侧）

test('剂型筛选只按登记剂型收窄：乳油命中 7 条且逐条剂型一致', () => {
  const r = domainQuery({ dosage_form: '乳油', limit: 50 });
  assert.equal(r.match_state, 'matched');
  assert.equal(r.total, 7);
  assert.equal(r.items.length, 7);
  for (const item of r.items) assert.equal(item.dosage_form, '乳油');
  // 命中侧可解释字段：本次实际应用的维度清单（用户可核对条件未被放宽）。
  assert.deepEqual([...r.matched_dimensions], ['dosage_form']);
  assert.deepEqual([...appliedDimensions(normalizeQuery({ dosage_form: '乳油' }, CATALOG))], ['dosage_form']);
});

test('剂型未命中给出逐条原因，且状态为 no_match（不静默放宽为全量）', () => {
  const r = domainQuery({ dosage_form: '微乳剂', limit: 50 });
  assert.equal(r.total, 0);
  assert.equal(r.match_state, 'no_match');
  assert.ok(r.unmatched_reasons.length > 0);
  for (const entry of r.unmatched_reasons) {
    assert.ok(entry.reasons.some((x) => x.includes('制剂（剂型）不符')), JSON.stringify(entry));
  }
});

test('记录未采集剂型时 fail-closed：标注未采集并判 insufficient，不当作符合', () => {
  const sample = JSON.parse(JSON.stringify(RECORDS[0]));
  delete sample.dosage_form;
  const r = runQuery([sample], normalizeQuery({ dosage_form: '乳油' }, CATALOG), CATALOG);
  assert.equal(r.total, 0);
  assert.equal(r.match_state, 'insufficient');
  assert.ok(r.unmatched_reasons[0].reasons.some((x) => x.includes('未采集制剂（剂型）')), JSON.stringify(r.unmatched_reasons[0]));
});

test('组合条件（作物 + 剂型）逐维收窄，命中条件清单同时包含两维', () => {
  const r = domainQuery({ crop_id: 'crop_rice', dosage_form: '乳油', limit: 50 });
  assert.equal(r.match_state, 'matched');
  assert.equal(r.total, 1);
  assert.equal(r.items[0].registration_number, 'PD20212101');
  assert.deepEqual([...r.matched_dimensions], ['crop_id', 'dosage_form']);
});

// ---------------------------------------------------------------- 有效成分/含量（精确语义）

test('名称精确相等：硝磺草酮不命中成分为磺草酮的记录', () => {
  const r = domainQuery({ ingredient_content: '硝磺草酮', limit: 50 });
  const regs = r.items.map((i) => i.registration_number);
  assert.deepEqual(regs.sort(), ['PD20161175', 'PD20211624', 'PD20212226']);
  assert.ok(!regs.includes('PD20110805'), '磺草酮 14% 不得被「硝磺草酮」命中');
});

test('含量精确相等：二甲戊灵 2% 不命中二甲戊灵 22%', () => {
  const r = domainQuery({ ingredient_content: '二甲戊灵 2%', limit: 50 });
  assert.equal(r.total, 0);
  assert.equal(r.match_state, 'no_match');
  assert.ok(r.unmatched_reasons[0].reasons.some((x) => x.includes('有效成分/含量与所选不符')));
});

test('成分+含量组合命中唯一记录（唑草酮 40% → PD20161371）', () => {
  const r = domainQuery({ ingredient_content: '唑草酮 40%', limit: 50 });
  assert.equal(r.total, 1);
  assert.equal(r.items[0].registration_number, 'PD20161371');
});

test('非法筛选输入显式失败（不静默丢弃条件退回全量）', () => {
  const invalid = (params) => () => normalizeQuery(params, CATALOG);
  assert.throws(invalid({ dosage_form: 123 }), (error) => error.code === 'INVALID_REQUEST');
  assert.throws(invalid({ ingredient_content: 42 }), (error) => error.code === 'INVALID_REQUEST');
  assert.throws(invalid({ ingredient_content: 'x'.repeat(81) }), (error) => error.code === 'INVALID_REQUEST');
  assert.throws(invalid({ crop_id: 'crop_not_registered' }), (error) => error.code === 'INVALID_REQUEST');
});

// ---------------------------------------------------------------- 安全边界（红线）

test('用量恒不展示：20 条真实记录一律不产出 DoseCard', () => {
  for (const item of RECORDS) {
    const card = doseCardDescriptor(item, {});
    assert.equal(card.renderable, false, item.registration_number);
    assert.equal(card.dose, undefined, item.registration_number);
    assert.equal(typeof card.reason, 'string');
  }
});

test('越界补充剂量不产出 DoseCard（usable_as_dose 为真也不得凭空生成）', () => {
  const sample = JSON.parse(JSON.stringify(RECORDS[0]));
  sample.verification = Object.assign({}, sample.verification, { usable_as_dose: true });
  const card = doseCardDescriptor(sample, {});
  assert.equal(card.renderable, false, '仅有可用性标记而无绑定制剂/数字/条件时仍必须拒绝');
  assert.equal(card.dose, undefined);
});

test('剂量式与混配式输入不产生任何用量或方案（不换算、不叠加）', () => {
  for (const input of ['唑草酮 40% 30毫升/亩', '唑草酮 40%、草甘膦 41%', '唑草酮+草甘膦 混配']) {
    const r = domainQuery({ ingredient_content: input, limit: 50 });
    assert.equal(r.total, 0, input);
    assert.equal(r.items.length, 0, input);
    for (const item of r.items) {
      assert.equal(item.dose, undefined);
      assert.equal(item.dose_text, undefined);
    }
    const mirror = miniReference.query({ ingredient_content: input, limit: 50 });
    assert.equal(mirror.total, 0, input);
  }
});

// ---------------------------------------------------------------- 跨端同判

test('小程序镜像与域库同判：剂型/成分筛选结果与命中条件清单一致', () => {
  assert.deepEqual([...miniReference.dosageForms].sort(), [...new Set(RECORDS.map((i) => i.dosage_form))].sort());
  assert.equal(miniReference.dosageForms.length, 8);

  const cases = [
    { dosage_form: '乳油' },
    { dosage_form: '颗粒剂' },
    { dosage_form: '微乳剂' },
    { ingredient_content: '硝磺草酮' },
    { ingredient_content: '二甲戊灵 2%' },
    { crop_id: 'crop_rice', dosage_form: '乳油' }
  ];
  for (const params of cases) {
    const domain = domainQuery(Object.assign({ limit: 50 }, params));
    const mirror = miniReference.query(Object.assign({ limit: 50 }, params));
    const label = JSON.stringify(params);
    assert.equal(mirror.total, domain.total, label);
    assert.equal(mirror.match_state, domain.match_state, label);
    assert.deepEqual(mirror.items.map((i) => i.registration_number), domain.items.map((i) => i.registration_number), label);
    assert.deepEqual([...mirror.matched_dimensions], [...domain.matched_dimensions], label);
    if (domain.total === 0) {
      assert.deepEqual(mirror.unmatched_reasons[0].reasons, domain.unmatched_reasons[0].reasons, label);
    }
  }
  assert.throws(() => miniReference.query({ dosage_form: 5 }), (error) => error.code === 'INVALID_REQUEST');
});

// ---------------------------------------------------------------- 页面接线

test('页面剂型选择器：选乳油后按剂型收窄，标注命中条件与离线来源', () => {
  const page = instantiatePage();
  page.checkGate();
  assert.deepEqual([...page.data.dosageForms], [...miniReference.dosageForms]);
  assert.equal(page.data.items.length, 20);
  assert.equal(page.data.matchedNote, '');

  const index = page.data.dosageForms.indexOf('乳油');
  assert.ok(index >= 0);
  // 联网可用时带结构化条件仍必须走随包离线副本，并如实说明「条件未被丢弃」。
  page.net.enabled = true;
  page.onDosageForm({ detail: { value: String(index) } });

  assert.equal(page.data.dosageForm, '乳油');
  assert.equal(page.data.items.length, 7);
  assert.ok(page.data.matchedNote.includes('制剂（剂型）'), page.data.matchedNote);
  assert.equal(page.data.dataSource, knowledgeApi.HERBICIDE_SOURCES.BUNDLED_OFFLINE);
  assert.ok(page.data.dataSourceLabel.includes('筛选条件未被丢弃'), page.data.dataSourceLabel);

  page.net.enabled = false;
  page.onReset();
  assert.equal(page.data.dosageForm, '');
  assert.equal(page.data.items.length, 20);
  assert.equal(page.data.matchedNote, '');
});

test('列表页不渲染任何用量字段（只有不提供用量建议的声明）', () => {
  const wxml = readFileSync(fileURLToPath(new URL('../../miniprogram/pages/reference/reference.wxml', import.meta.url)), 'utf8');
  assert.ok(wxml.includes('不提供用药量建议'));
  assert.ok(!/item\.dose|dosage_amount|doseText|毫升\/亩|制剂量/.test(wxml));
});
