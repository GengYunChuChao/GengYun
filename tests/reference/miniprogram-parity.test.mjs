// GY-I07 小程序侧适配层与域库口径一致性测试。
//
// 小程序 utils/reference.js 为 CommonJS（微信运行时），从生成的数据文件（miniprogram/data/**）
// 读取资料，与纯 ESM 域库 packages/reference 使用同一份资料与同一判定口径。
// 本测试用 createRequire 直接载入适配层，断言：
//   - 种子资料条数与域库一致；
//   - 标签含「待核实·非权威」，用量恒不展示；
//   - 查询/详情与域库同源（同一 eligibility 判定、同一 source_version）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { miniReference } from './_fixtures.mjs';
import { loadSeedBundle, SEED_REQUIRED_LABEL, loadHerbicideRecords } from '../../packages/reference/index.mjs';

test('小程序适配层可载入（CommonJS）且暴露目录/查询/种子', () => {
  assert.ok(Array.isArray(miniReference.crops));
  assert.equal(miniReference.crops.length, 4);
  assert.equal(typeof miniReference.query, 'function');
  assert.equal(typeof miniReference.detail, 'function');
  assert.equal(typeof miniReference.seedSearch, 'function');
});

test('小程序侧目录与域库同源（作物 4 / 杂草 8 / 记录 20）', () => {
  assert.equal(miniReference.crops.length, 4);
  assert.equal(miniReference.species.length, 8);
  assert.equal(miniReference.records.length, 20);
});

test('小程序侧种子条数与域库 loadSeedBundle 完全一致', () => {
  const b = loadSeedBundle();
  assert.equal(miniReference.seed.counts.herbicides, b.herbicides.count);
  assert.equal(miniReference.seed.counts.weeds, b.weeds.count);
  assert.equal(miniReference.seed.counts.weedMaster, b.weedMaster.count);
  assert.equal(miniReference.seed.counts.provinces, b.provinceIndex.count);
  assert.equal(miniReference.seed.counts.controlTiming, b.controlTiming.count);
});

test('小程序侧种子标签含「待核实·非权威」，且不含任何剂量数值字段', () => {
  assert.equal(miniReference.seed.label, SEED_REQUIRED_LABEL);
  const labels = miniReference.seedLabels();
  assert.equal(labels.seed, SEED_REQUIRED_LABEL);
  assert.ok(labels.dose.includes('不提供用量'));
  for (const item of miniReference.seed.herbicides) {
    assert.equal(item.dosage_status, 'not_collected');
    assert.equal(item.seed_meta.label, SEED_REQUIRED_LABEL);
    // 投影不得暴露任何剂量/浓度数值列。
    assert.equal(item.dosage, undefined);
    assert.equal(item.dose, undefined);
  }
});

test('小程序侧查询与域库同源：作物筛选命中数一致（crop_rice → 6）', () => {
  const cropId = miniReference.resolveCropId('水稻');
  assert.equal(cropId, 'crop_rice');
  const r = miniReference.query({ crop_id: cropId, limit: 50 });
  assert.equal(r.match_state, 'matched');
  assert.equal(r.total, 6);
});

test('小程序侧无结果/条件不足状态与域库一致', () => {
  const none = miniReference.query({ keyword: '绝不存在zzz' });
  assert.equal(none.match_state, 'no_match');
  const insufficient = miniReference.query({ region_code: '330100' });
  assert.equal(insufficient.match_state, 'insufficient');
});

test('小程序侧列表与详情使用同一 source_version', () => {
  const list = miniReference.query({ crop_id: 'crop_rice', limit: 50 });
  for (const li of list.items) {
    const d = miniReference.detail(li.record_id);
    assert.equal(d.source_version, li.source_version);
  }
});

test('小程序侧种子检索按名称/别称精确匹配（不合并记录）', () => {
  assert.equal(miniReference.seedSearch('百草枯').length, 1);
  assert.equal(miniReference.seedSearch('克芜踪').length, 1);
  assert.equal(miniReference.seedSearch('不存在zzz').length, 0);
});

test('小程序侧省份种子含中国台湾/中国香港/中国澳门（省级口径）', () => {
  const names = miniReference.seed.provinces.map((x) => x.province);
  assert.ok(names.includes('中国台湾'));
  assert.ok(names.includes('中国香港'));
  assert.ok(names.includes('中国澳门'));
});

test('小程序侧记录数与域库一致（同源资料）', () => {
  const doc = loadHerbicideRecords();
  assert.equal(miniReference.records.length, doc.items.length);
});
