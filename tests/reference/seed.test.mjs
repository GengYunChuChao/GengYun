// GY-I07 种子资料（整理稿）合规与装载测试。
//
// 断言指挥侧种子数据的合规口径：条数、字段、强制「待核实·非权威」标注、
// **不显示用量**、**不授专家认证标签**、**缺项不空白/不补写**、地区省级口径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadSeedBundle,
  loadSeedHerbicides,
  loadSeedWeeds,
  loadSeedWeedMaster,
  loadSeedProvinceIndex,
  loadSeedControlTiming,
  loadSeedUsageNotes,
  findSeedHerbicidesByTerm,
  listSeedHerbicides,
  seedUsage,
  SEED_REQUIRED_LABEL,
  SEED_DATA_ORIGIN,
  SEED_AUTHORITY,
  NOT_COLLECTED,
  FORBIDDEN_LABELS,
  assertNoForbiddenLabel,
} from '../../packages/reference/index.mjs';
import { createReferenceService } from '../../packages/reference/service.mjs';

const index = JSON.parse(
  readFileSync(new URL('../../db/seeds/gy-i07/INDEX.json', import.meta.url), 'utf8'),
);

test('种子数据声明口径：seed_unverified / authority=none / 原始稿未入仓', () => {
  assert.equal(index.source_kind, 'seed_unverified');
  assert.equal(index.authority, 'none');
  assert.equal(index.originals_committed, false);
  assert.equal(SEED_DATA_ORIGIN, 'seed_unverified');
  assert.equal(SEED_AUTHORITY, 'none');
});

test('种子条数与 INDEX.json 声明一致（herbicides 96 / weeds 172 / weed_master 175 / provinces 34 / timing 14）', () => {
  const declared = Object.fromEntries(index.files.map((f) => [f.name, f.count]));
  const b = loadSeedBundle();
  assert.equal(b.herbicides.count, declared['herbicides.json']);
  assert.equal(b.weeds.count, declared['weeds.json']);
  assert.equal(b.weedMaster.count, declared['weed_master.json']);
  assert.equal(b.provinceIndex.count, declared['province_index.json']);
  assert.equal(b.controlTiming.count, declared['control_timing.json']);
  // 声明数与实际条数必须一致（不静默截断）。
  assert.equal(b.herbicides.count, b.herbicides.declared_count);
  assert.equal(b.weeds.count, b.weeds.declared_count);
  assert.equal(b.weedMaster.count, b.weedMaster.declared_count);
  assert.equal(b.provinceIndex.count, b.provinceIndex.declared_count);
  assert.equal(b.controlTiming.count, b.controlTiming.declared_count);
});

test('每条种子记录带强制「待核实·非权威」标注且 traceable_authority=false', () => {
  const b = loadSeedBundle();
  for (const item of b.herbicides.items) {
    assert.equal(item.seed.label, SEED_REQUIRED_LABEL);
    assert.equal(item.seed.data_origin, SEED_DATA_ORIGIN);
    assert.equal(item.seed.authority, SEED_AUTHORITY);
    assert.equal(item.seed.traceable_authority, false);
  }
});

test('种子记录不提供任何用量（dosage.status=not_collected），不以空白/模型补写', () => {
  const b = loadSeedBundle();
  for (const item of b.herbicides.items) {
    assert.equal(item.dosage.status, 'not_collected');
    assert.equal(item.dosage.note, NOT_COLLECTED);
  }
  for (const item of b.weedMaster.items) {
    assert.equal(item.dosage.status, 'not_collected');
  }
  for (const item of b.controlTiming.items) {
    assert.equal(item.dosage.status, 'not_collected');
  }
});

test('种子声明汇总含 must_not 四项合规约束（用量/专家标签/权威来源/缺项补写）', () => {
  const u = seedUsage();
  assert.equal(u.label_required, SEED_REQUIRED_LABEL);
  assert.equal(u.must_not.length, 4);
  assert.ok(u.must_not.some((x) => x.includes('不得显示真实用量')));
  assert.ok(u.must_not.some((x) => x.includes('专家认证')));
  assert.ok(u.must_not.some((x) => x.includes('权威来源')));
  assert.ok(u.must_not.some((x) => x.includes('空白')));
});

test('种子公开文案不含任何禁用标签（AC22）', () => {
  const b = loadSeedBundle();
  const texts = [];
  for (const h of b.herbicides.items) {
    texts.push(h.name, h.hazard_level, h.hazard_detail, h.target_weeds, h.regions);
  }
  for (const w of b.weeds.items) texts.push(w.name, w.identify_key);
  for (const p of b.provinceIndex.items) texts.push(p.province, p.region, p.main_crops);
  const joined = texts.join('\n');
  for (const forb of FORBIDDEN_LABELS) {
    assert.ok(!joined.includes(forb), `种子文案出现禁用标签：${forb}`);
  }
  assert.doesNotThrow(() => assertNoForbiddenLabel(joined));
});

test('province_index 含中国台湾/中国香港/中国澳门 且按省级口径处理（非国家）', () => {
  const p = loadSeedProvinceIndex();
  const names = p.items.map((x) => x.province);
  assert.ok(names.includes('中国台湾'));
  assert.ok(names.includes('中国香港'));
  assert.ok(names.includes('中国澳门'));
  assert.ok(p.region_rule.includes('省级行政区'));
  // 明确排除「视为国家」的口径（原文含「不得视为国家」）。
  assert.ok(p.region_rule.includes('不得视为国家'));
});

test('按中文药名/别名确定性检索且不合并不同记录', () => {
  const b = loadSeedBundle();
  assert.equal(findSeedHerbicidesByTerm(b, '百草枯').length, 1);
  assert.equal(findSeedHerbicidesByTerm(b, '克芜踪').length, 1); // 别名命中同一条
  assert.equal(findSeedHerbicidesByTerm(b, '草甘膦').length, 1);
  assert.equal(findSeedHerbicidesByTerm(b, 'zzz-不存在').length, 0);
  // 精确匹配：不同记录不得因相似名被合并（每命中 ≤1 且唯一 seed_id）。
  const hit = findSeedHerbicidesByTerm(b, '百草枯');
  assert.equal(new Set(hit.map((x) => x.seed_id)).size, hit.length);
});

test('listSeedHerbicides 分页确定性（按 seed_id 排序、offset 前进）', () => {
  const b = loadSeedBundle();
  const p1 = listSeedHerbicides(b, { limit: 10, offset: 0 });
  const p2 = listSeedHerbicides(b, { limit: 10, offset: 10 });
  assert.equal(p1.items.length, 10);
  assert.equal(p1.total, 96);
  assert.equal(p1.next_offset, 10);
  assert.notEqual(p1.items[0].seed_id, p2.items[0].seed_id);
  // 覆盖全部条目无重复。
  const all = [];
  for (let off = 0; off < 96; off += 10) all.push(...listSeedHerbicides(b, { limit: 10, offset: off }).items);
  assert.equal(new Set(all.map((x) => x.seed_id)).size, 96);
});

test('独立装载函数之一致性（子装载与 bundle 同源）', () => {
  const b = loadSeedBundle();
  assert.equal(loadSeedHerbicides().count, b.herbicides.count);
  assert.equal(loadSeedWeeds().count, b.weeds.count);
  assert.equal(loadSeedWeedMaster().count, b.weedMaster.count);
  assert.equal(loadSeedProvinceIndex().count, b.provinceIndex.count);
  assert.equal(loadSeedControlTiming().count, b.controlTiming.count);
  assert.equal(loadSeedUsageNotes().count, b.usageNotes.count);
});

test('服务端点：种子列表/详情/检索均带「待核实·非权威」且无用量', () => {
  const svc = createReferenceService({ executionMode: 'stub' });
  const l = svc.listSeedHerbicides({ limit: 5 });
  assert.equal(l.body.seed_state.label, SEED_REQUIRED_LABEL);
  for (const item of l.body.data.items) {
    assert.equal(item.labels.seed, SEED_REQUIRED_LABEL);
    assert.equal(item.dosage.status, 'not_collected');
  }
  const d = svc.getSeedHerbicide(l.body.data.items[0].seed_id);
  assert.equal(d.body.data.labels.seed, SEED_REQUIRED_LABEL);
  assert.equal(d.body.seed_state.label, SEED_REQUIRED_LABEL);
  const hit = svc.searchSeedHerbicides('百草枯');
  assert.equal(hit.body.query_state.match_state, 'matched');
  assert.equal(hit.body.data.items[0].labels.seed, SEED_REQUIRED_LABEL);
  const miss = svc.searchSeedHerbicides('不存在药xyz');
  assert.equal(miss.body.query_state.match_state, 'no_match');
});

test('服务端点：未知 seed_id → NOT_FOUND', () => {
  const svc = createReferenceService({ executionMode: 'stub' });
  assert.throws(() => svc.getSeedHerbicide('no-such-seed'), (e) => e.code === 'NOT_FOUND');
});
