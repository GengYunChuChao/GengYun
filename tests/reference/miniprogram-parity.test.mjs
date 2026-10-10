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

// —— F5 回归：小程序 source_version 必须与域库**逐条一致**（此前 20/20 不一致） ——
test('F5：小程序侧 source_version 与域库逐条一致（列表 = 详情 = 域库）', () => {
  const doc = loadHerbicideRecords();
  const domMap = new Map(doc.items.map((i) => [i.record_id, i.source_version]));
  const list = miniReference.query({ limit: 50 });
  assert.equal(list.items.length, 20);
  for (const li of list.items) {
    // 与域库一致
    assert.equal(li.source_version, domMap.get(li.record_id), `${li.record_id} 列表 source_version 应与域库一致`);
    // 与详情一致
    const d = miniReference.detail(li.record_id);
    assert.equal(d.source_version, li.source_version, `${li.record_id} 详情 source_version 应与列表一致`);
    // 派生须含附件哈希前 12 位（与域库算法同源的特征）
    assert.match(li.source_version, /#[0-9a-f]{12}$/, `${li.record_id} 应含附件哈希前 12 位`);
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

// —— F4 回归：非法输入不得静默降级；match_state 口径须与域库一致 ——
test('F4：小程序侧非法输入抛 INVALID_REQUEST（不得静默退回全量匹配）', () => {
  const badInputs = [
    { limit: 0 },
    { limit: 999 },
    { limit: -1 },
    { limit: 'abc' },
    { limit: 1.5 },
    { crop_id: 'crop_nope' },
    { species_id: 'sp_nope' },
    { region_code: '999999' },
    { q: 'x'.repeat(200) },
  ];
  for (const input of badInputs) {
    assert.throws(
      () => miniReference.query(input),
      (err) => err && err.code === 'INVALID_REQUEST',
      `非法输入 ${JSON.stringify(input)} 应抛 INVALID_REQUEST`,
    );
  }
});

test('F4：小程序侧 match_state 与域库逐项一致（合法 + 非法两类）', async () => {
  const { createReferenceService } = await import('../../packages/reference/service.mjs');
  const svc = createReferenceService({ executionMode: 'stub' });
  const cases = [
    { label: '空条件', input: {} },
    { label: '不存在关键词', input: { q: '绝不存在zzz' } },
    { label: 'region 330100（条件不足）', input: { region_code: '330100' } },
    { label: '作物水稻', input: { q: '水稻' } },
    { label: '登记号不匹配', input: { registration_number: 'PD00000000' } },
  ];
  for (const { label, input } of cases) {
    const dom = svc.listHerbicides({ ...input, q: input.q ?? undefined }, 'f4').query_state;
    const mini = miniReference.query({ keyword: input.q, region_code: input.region_code, registration_number: input.registration_number });
    assert.equal(mini.match_state, dom.match_state, `${label}：match_state 须与域库一致`);
    assert.equal(mini.total, dom.total, `${label}：total 须与域库一致`);
  }
  // 非法类：两侧都必须拒绝。
  for (const input of [{ q: 'x'.repeat(200) }]) {
    assert.throws(() => svc.listHerbicides(input, 'f4'), (e) => e.code === 'INVALID_REQUEST');
    assert.throws(() => miniReference.query({ keyword: input.q }), (e) => e.code === 'INVALID_REQUEST');
  }
});

// ---------------------------------------------------------------------------
// G3：use_scene / growth_stage / planting_method 三个原始条件——**相同输入直接对照**。
//
// 监工口径：新 validateQueryInput 只加参数合法性检查，小程序 query() **仍未读取/匹配**
// 这三个条件 → 静默放宽为全量匹配。本组用例用**批复明确列出的三个输入**逐项对照域库。
// ---------------------------------------------------------------------------
test('G3：use_scene/growth_stage/planting_method 与域库逐项一致（相同输入）', async () => {
  const { createReferenceService } = await import('../../packages/reference/service.mjs');
  const svc = createReferenceService({ executionMode: 'stub' });
  const cases = [
    { label: 'use_scene=impossible-ZZZ', input: { use_scene: 'impossible-ZZZ' } },
    { label: 'growth_stage=seedling', input: { growth_stage: 'seedling' } },
    { label: 'planting_method=direct', input: { planting_method: 'direct' } },
    // 补充：合法场景/组合/大小写/空白
    { label: 'use_scene=水稻田', input: { use_scene: '水稻田' } },
    { label: 'use_scene=水稻（子串）', input: { use_scene: '水稻' } },
    { label: 'use_scene=非耕地', input: { use_scene: '非耕地' } },
    { label: 'use_scene 帶空白', input: { use_scene: '  水稻  ' } },
    { label: 'use_scene 大写', input: { use_scene: 'Impossible-ZZZ' } },
    { label: 'growth_stage+use_scene 组合', input: { growth_stage: 'seedling', use_scene: '水稻田' } },
    { label: 'planting_method+growth_stage 组合', input: { planting_method: 'transplant', growth_stage: 'tillering' } },
  ];
  for (const { label, input } of cases) {
    const dom = svc.listHerbicides(input, 'g3').query_state;
    const mini = miniReference.query(input);
    assert.equal(mini.match_state, dom.match_state, `G3 ${label}：match_state 须与域库一致`);
    assert.equal(mini.total, dom.total, `G3 ${label}：total 须与域库一致`);
  }
  // 监工三条反例的**具体期望**（防止口径回退为全量匹配）
  assert.equal(miniReference.query({ use_scene: 'impossible-ZZZ' }).total, 0);
  assert.equal(miniReference.query({ use_scene: 'impossible-ZZZ' }).match_state, 'no_match');
  assert.equal(miniReference.query({ growth_stage: 'seedling' }).match_state, 'insufficient');
  assert.equal(miniReference.query({ growth_stage: 'seedling' }).total, 0);
  assert.equal(miniReference.query({ planting_method: 'direct' }).match_state, 'insufficient');
  assert.equal(miniReference.query({ planting_method: 'direct' }).total, 0);
});

// ---------------------------------------------------------------------------
// H2：小程序侧**同口径 fail-closed** —— 缺来源枚举的记录不得投影、不得可查询。
// ---------------------------------------------------------------------------

test('H2：小程序侧记录均命中冻结枚举（契约枚举字段不承载非枚举值）', () => {
  const SOURCE_KINDS = ['database', 'verified_seed', 'simulation'];
  const EVIDENCE_KINDS = ['research', 'experience', 'mixed'];
  assert.equal(miniReference.skippedRecords.length, 0, '真实 20 条来源齐备，不应被排除');
  for (const r of miniReference.records) {
    assert.ok(SOURCE_KINDS.includes(r.source.source_kind), `source_kind 非法：${r.source.source_kind}`);
    assert.ok(EVIDENCE_KINDS.includes(r.source.evidence_kind), `evidence_kind 非法：${r.source.evidence_kind}`);
    assert.notEqual(r.source.source_kind, '未采集', '缺项文案不得塞进强枚举字段');
    assert.notEqual(r.source.evidence_kind, '未采集', '缺项文案不得塞进强枚举字段');
  }
});

test('H2：小程序侧 contractReadiness 与域库 checkSourceContractReadiness 同口径', async () => {
  const { checkSourceContractReadiness: domCheck } = await import('../../packages/reference/records.mjs');
  const variants = [
    ['基线', () => {}],
    ['仅缺 source_kind', (r) => { delete r.source.source_kind; }],
    ['仅缺 evidence_kind', (r) => { delete r.source.evidence_kind; }],
    ['两者都缺', (r) => { delete r.source.source_kind; delete r.source.evidence_kind; }],
    ['缺登记证号', (r) => { delete r.registration_number; }],
    ['非法 source_kind', (r) => { r.source.source_kind = 'made_up'; }],
  ];
  const { readFileSync } = await import('node:fs');
  const first = JSON.parse(readFileSync(new URL('../../packages/knowledge/herbicides/records-2026.json', import.meta.url), 'utf8')).records[0];
  for (const [label, mutate] of variants) {
    const rec = JSON.parse(JSON.stringify(first));
    mutate(rec);
    const dom = domCheck(rec);
    const mini = miniReference.contractReadiness(rec);
    assert.equal(mini.ok, dom.ok, `H2 ${label}：ok 判定须与域库一致`);
    assert.deepEqual(mini.missing, dom.missing, `H2 ${label}：缺项明细须与域库一致`);
  }
});
