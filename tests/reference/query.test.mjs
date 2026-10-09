// GY-I07 查询语义与状态测试（无结果 / 条件不足 / 已匹配 / 失效 / 模拟）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCatalog,
  loadHerbicideRecords,
  normalizeQuery,
  runQuery,
  evaluateEligibility,
  paginate,
  toDetail,
  ReferenceError,
  MATCH_STATES,
} from '../../packages/reference/index.mjs';

const catalog = loadCatalog();
const doc = loadHerbicideRecords();

function query(input) {
  return runQuery(doc.items, normalizeQuery(input, catalog), catalog);
}

test('未加条件 → 全量可用记录（matched）', () => {
  const r = query({});
  assert.equal(r.match_state, 'matched');
  assert.equal(r.total, doc.items.length);
});

test('作物筛选命中（crop_rice → 6 条）', () => {
  const r = query({ crop_id: 'crop_rice' });
  assert.equal(r.match_state, 'matched');
  assert.equal(r.total, 6);
  for (const item of r.items) assert.ok(item.crop_ids.includes('crop_rice'));
});

test('不存在的关键词 → no_match（不是错误，200 + 状态表达）', () => {
  const r = query({ q: '绝对不存在的关键词zzz' });
  assert.equal(r.match_state, 'no_match');
  assert.equal(r.total, 0);
  assert.ok(r.reasons.length > 0);
  assert.ok(MATCH_STATES.includes(r.match_state));
});

test('地区条件：记录未结构化标注地区 → insufficient（并给出原因）', () => {
  const r = query({ region_code: '330100' });
  assert.equal(r.match_state, 'insufficient');
  assert.equal(r.total, 0);
  assert.ok(r.reasons.join(' ').includes('未标注'));
});

test('登记证号精确匹配命中 1 条', () => {
  const reg = doc.items[0].registration_number;
  const r = query({ registration_number: reg });
  assert.equal(r.match_state, 'matched');
  assert.equal(r.total, 1);
  assert.equal(r.items[0].registration_number, reg);
});

test('同作物下的多条记录各自独立（不以模糊药名合并不同含量剂型）', () => {
  const r = query({ crop_id: 'crop_rice' });
  const ids = r.items.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, '记录 id 必须唯一，不得合并');
  // 组成 identity_hash 不同 ⇒ 同名不同含量/剂型不会被并成一条。
  const hashSource = doc.items.filter((x) => x.registration_number);
  const keys = new Set(hashSource.map((x) => x.identity_key));
  assert.equal(keys.size, hashSource.length);
});

test('非法游标 → INVALID_CURSOR（受控拒绝）', () => {
  const list = doc.items.slice(0, 5);
  assert.throws(
    () => paginate(list, 2, 'not-a-real-registration-number'),
    (e) => e instanceof ReferenceError && e.code === 'INVALID_CURSOR',
  );
});

test('分页：limit 生效、next_cursor 前进并指向已返回末条、末页为 null', () => {
  const list = doc.items.slice(0, 5).sort((a, b) => (a.registration_number < b.registration_number ? -1 : 1));
  const p1 = paginate(list, 2, null);
  assert.equal(p1.items.length, 2);
  assert.equal(p1.next_cursor, list[1].registration_number);
  const p2 = paginate(list, 2, p1.next_cursor);
  assert.equal(p2.items.length, 2);
  assert.equal(p2.items[0].registration_number, list[2].registration_number);
  const p3 = paginate(list, 2, p2.next_cursor);
  assert.equal(p3.items.length, 1);
  assert.equal(p3.next_cursor, null, '末页 next_cursor 必须为 null');
});

test('非法 limit（越界）→ INVALID_REQUEST（normalizeQuery 直接受控拒绝）', () => {
  assert.throws(
    () => normalizeQuery({ limit: 999 }, catalog),
    (e) => e instanceof ReferenceError && e.code === 'INVALID_REQUEST',
  );
  assert.throws(() => normalizeQuery({ limit: 0 }, catalog), (e) => e.code === 'INVALID_REQUEST');
  // 合法边界透传。
  assert.equal(normalizeQuery({ limit: 50 }, catalog).limit, 50);
});

test('evaluateEligibility：published+valid+非模拟 → queryable', () => {
  const item = doc.items[0];
  const v = evaluateEligibility(item, { includeSimulated: false });
  assert.equal(v.queryable, true);
});

test('evaluateEligibility：hidden → 不可用，原因为「下架」', () => {
  const item = { ...doc.items[0], visibility: 'hidden' };
  const v = evaluateEligibility(item, { includeSimulated: false });
  assert.equal(v.queryable, false);
  assert.ok(v.reason.includes('下架'));
});

test('evaluateEligibility：非 valid 有效期（expired/withdrawn/unknown）→ 不可用', () => {
  for (const validity of ['expired', 'withdrawn', 'unknown']) {
    const item = { ...doc.items[0], source: { ...doc.items[0].source, source_validity: validity } };
    const v = evaluateEligibility(item, { includeSimulated: false });
    assert.equal(v.queryable, false, `${validity} 应不可用`);
  }
});

test('evaluateEligibility：模拟记录默认被排除（且给出「模拟」原因）', () => {
  const item = { ...doc.items[0], simulated: true, registration_number: 'SIM-0001' };
  const v = evaluateEligibility(item, { includeSimulated: false });
  assert.equal(v.queryable, false);
  assert.ok(v.reason.includes('模拟'));
});

test('toDetail：含未采集字段与来源版本（不空白、不补写）', () => {
  const d = toDetail(doc.items[0], catalog);
  assert.ok(Array.isArray(d.not_collected));
  assert.ok(d.not_collected.length > 0, '未采集字段须显式列出');
  assert.equal(typeof d.source_version, 'string');
  assert.equal(d.contract.source.version, d.source_version, '契约来源版本须与记录一致');
});

test('列表与详情匹配状态字段自洽（同一记录的 source_version 相等）', () => {
  const r = query({ registration_number: doc.items[0].registration_number });
  const li = r.items[0];
  const detail = toDetail(doc.items.find((x) => x.contract.id === li.id), catalog);
  assert.equal(li.source.version, detail.source_version);
});
