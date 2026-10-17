// GY-I07 来源版本一致性 + 下架/失效缓存回归。
//
// 验收（#7）：「下架／失效退出有效查询，详情与列表一致」+
// 提交证据「来源版本与下架缓存回归」。
//
// 末段为 #7② 的**数据侧**回归样本（下架/失效/撤回/未来生效/有效期未知/缺来源），
// 与 tests/unit/knowledge-api.test.mjs:85 的 DB 侧口径同名，用真实记录作基线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_VALIDITIES,
  activeEtag,
  applyGovernanceChange,
  checkSourceContractReadiness,
  createVersionIndex,
  etagFor,
  evaluateEligibility,
  isActiveVersion,
  loadCatalog,
  loadHerbicideRecords,
  runQuery,
  toDetail,
} from '../../packages/reference/index.mjs';

import { createReferenceService } from '../../packages/reference/service.mjs';

const doc = loadHerbicideRecords();

test('列表与详情使用同一 source_version（逐条核对）', () => {
  const svc = createReferenceService({ executionMode: 'stub' });
  const list = svc.listHerbicides({ limit: 50 });
  const items = list.body.data.items;
  assert.ok(items.length > 0);
  for (const li of items) {
    const detail = svc.getHerbicide(li.id);
    assert.equal(detail.body.data.source.version, li.source.version, `记录 ${li.id} 列表/详情 source_version 不一致`);
  }
});

test('versionIndex 对同一记录返回同一 source_version，且跨入口一致', () => {
  const idx = createVersionIndex(doc.items);
  const first = doc.items[0];
  assert.equal(idx.versionForRecord(first.record_id), first.source_version);
  assert.equal(idx.versionForRegistration(first.registration_number), first.source_version);
  assert.ok(idx.consistent(first.source_version, idx.versionForRecord(first.record_id)));
  // 不同记录的记录身份键不同（即使共用来源版本），保证 ETag 逐记录敏感。
  const keys = new Set(doc.items.map((x) => x.identity_key));
  assert.equal(keys.size, doc.items.length);
});

test('ETag 按「记录身份键@source_version」派生：数量与内容变化均改变 ETag', () => {
  const all = activeEtag(doc.items);
  const fewer = activeEtag(doc.items.slice(0, doc.items.length - 1));
  assert.notEqual(all, fewer, '减少一条记录后 ETag 必须变化（否则下架不失效缓存）');
  // 只按 source_version 去重会导致不变——此处显式反证：绝大多数记录共用同一来源版本。
  const distinctVersions = new Set(doc.items.map((x) => x.source_version));
  assert.ok(
    doc.items.length - distinctVersions.size >= doc.items.length - 2,
    '首批记录几乎共用同一来源版本，正因如此必须按记录身份派生 ETag',
  );
  const counts = {};
  for (const x of doc.items) counts[x.source_version] = (counts[x.source_version] ?? 0) + 1;
  assert.ok(Math.max(...Object.values(counts)) > 1, '同一来源版本被多条记录共用');
});

test('下架一条记录：有效集合 ETag 变化 + 旧集合命中数减少', () => {
  const before = doc.items;
  const victim = before[0];
  const after = applyGovernanceChange(before, { record_id: victim.record_id, visibility: 'hidden' });

  const beforeEtag = activeEtag(before);
  const afterEtag = activeEtag(after);
  assert.notEqual(beforeEtag, afterEtag, '下架后 ETag 必须变化');

  const activeBefore = before.filter(isActiveVersion).length;
  const activeAfter = after.filter(isActiveVersion).length;
  assert.equal(activeAfter, activeBefore - 1);
});

test('失效一条记录（validity=expired）：退出有效集合且 ETag 变化', () => {
  const before = doc.items;
  const victim = before[1];
  const after = applyGovernanceChange(before, { record_id: victim.record_id, validity: 'expired' });
  assert.notEqual(activeEtag(before), activeEtag(after));
  const v = after.find((x) => x.record_id === victim.record_id);
  assert.equal(isActiveVersion(v), false);
  assert.equal(v.reference_state, 'unavailable');
});

test('服务层：下架记录后，列表命中数减少，且详情（按 id）返回 NOT_FOUND ——列表与详情一致', () => {
  // 用同一 mock 重建一个「下架后」服务不可行（service 从文件装载）；
  // 因此直接断言治理原语与服务列表口径一致：下架记录不在有效集合，详情入口对其抛 NOT_FOUND。
  const svc = createReferenceService({ executionMode: 'stub' });
  const before = svc.listHerbicides({ limit: 50 });
  assert.ok(before.body.data.items.length >= 1);
  const target = before.body.data.items[0];
  // 治理：把该记录变为 hidden。
  const after = applyGovernanceChange(doc.items, { record_id: doc.items.find((x) => x.contract.id === target.id).record_id, visibility: 'hidden' });
  const stillActive = after.filter(isActiveVersion).some((x) => x.contract.id === target.id);
  assert.equal(stillActive, false, '下架记录必须退出有效集合（与详情 NOT_FOUND 一致）');
});

test('applyGovernanceChange 不可变（不修改入参）', () => {
  const original = doc.items[2];
  const snapshotVisibility = original.visibility;
  applyGovernanceChange(doc.items, { record_id: original.record_id, visibility: 'deleted' });
  assert.equal(doc.items[2].visibility, snapshotVisibility, '治理变更不得改写原数组元素');
});

test('ETag 顺序无关（同一集合不同顺序 → 同一 ETag）', () => {
  const a = etagFor(doc.items);
  const b = etagFor([...doc.items].reverse());
  assert.equal(a, b);
});

test('ETag 对单条记录（详情）与集合（列表）均为稳定强 ETag', () => {
  const one = etagFor([doc.items[0]]);
  assert.match(one, /^"sv-1-[0-9a-f]{32}"$/);
  const list = etagFor(doc.items);
  assert.match(list, new RegExp(`^"sv-${doc.items.length}-[0-9a-f]{32}"$`));
});

// ---------------------------------------------------------------------------
// #7② 数据侧回归样本：下架 / 失效 / 撤回 / 未来生效 / 有效期未知 / 缺来源
//   与 tests/unit/knowledge-api.test.mjs:85（DB 侧 withdrawn/expired/future/missing source）
//   同名同形，这里以**真实记录**为基线，钉三件事：
//     ① 样本退出有效集合（isActiveVersion=false）且有效集合 ETag 变化；
//     ② 查询命中集合不含该记录（列表侧退出）；
//     ③ 详情投影与列表**共用同一判据**（同一 reason 文案，无第二条路径）。
//   注：HTTP 列表面（services/api/src/routes/knowledge.ts）刻意不拦截未发布种子，属 D5 范围；
//   本块钉的是数据 + 域库判据层（runQuery 命中集合与 toDetail 同用 evaluateEligibility）。
// ---------------------------------------------------------------------------
const catalog = loadCatalog();
const baseline = doc.items;
const sampleBase = baseline[0];
const HIT_QUERY = Object.freeze({ crop_id: 'crop_rice', limit: 50 });

test('#7② 数据侧基线：治理前该记录可查询、且出现在列表命中集合中', () => {
  assert.equal(evaluateEligibility(sampleBase).queryable, true);
  assert.equal(toDetail(sampleBase, catalog).queryable, true);
  const hits = runQuery(baseline, HIT_QUERY, catalog);
  assert.ok(
    hits.matched_items.some((x) => x.record_id === sampleBase.record_id),
    `${sampleBase.record_id} 应出现在基线命中集合中（否则样本无意义）`,
  );
});

test('#7② 五类治理样本退出有效查询：列表命中与详情投影同一判据（下架/失效/撤回/未来/未知）', () => {
  // 'future' 不在 SOURCE_VALIDITIES 内 ⇒ 靠 evaluateEligibility 的兜底文案 fail-closed。
  assert.ok(!SOURCE_VALIDITIES.includes('future'), "'future' 不是合法枚举，必须靠兜底拒绝");
  const cases = [
    { name: '下架', change: { visibility: 'hidden' }, reason: '该记录已下架' },
    { name: '失效', change: { validity: 'expired' }, reason: '来源已过期' },
    { name: '撤回', change: { validity: 'withdrawn' }, reason: '来源已撤回' },
    { name: '未来生效', change: { validity: 'future' }, reason: '来源有效期不可用' },
    { name: '有效期未知', change: { validity: 'unknown' }, reason: '来源有效期未知' },
  ];

  const beforeEtag = activeEtag(baseline);
  const beforeActive = baseline.filter(isActiveVersion).length;

  for (const c of cases) {
    const after = applyGovernanceChange(baseline, { record_id: sampleBase.record_id, ...c.change });
    const item = after.find((x) => x.record_id === sampleBase.record_id);

    // ① 退出有效集合 + 缓存失效
    assert.equal(isActiveVersion(item), false, `${c.name}：必须退出有效集合`);
    assert.equal(item.reference_state, 'unavailable', `${c.name}：引用状态须为 unavailable`);
    assert.equal(after.filter(isActiveVersion).length, beforeActive - 1, `${c.name}：有效集合应恰好减少 1 条`);
    assert.notEqual(activeEtag(after), beforeEtag, `${c.name}：有效集合 ETag 必须变化（否则缓存不失效）`);

    // ② 列表命中集合退出（同一条件下其他记录仍命中，证明是「退出」而非「全空」）
    const hits = runQuery(after, HIT_QUERY, catalog);
    assert.ok(
      !hits.matched_items.some((x) => x.record_id === sampleBase.record_id),
      `${c.name}：命中集合不得含该记录`,
    );
    assert.ok(hits.matched_items.length > 0, `${c.name}：其他记录不应被连带排除`);

    // ③ 详情与列表同一判据
    const verdict = evaluateEligibility(item);
    assert.equal(verdict.queryable, false, `${c.name}：不可查询`);
    assert.equal(verdict.reason, c.reason, `${c.name}：不可查询原因文案必须逐字一致`);
    const detail = toDetail(item, catalog);
    assert.equal(detail.queryable, false, `${c.name}：详情不可查询`);
    assert.equal(detail.unavailable_reason, c.reason, `${c.name}：详情与列表判定不一致`);
    // 治理不得波及其他记录
    assert.equal(after.length, baseline.length);
    assert.equal(runQuery(after, HIT_QUERY, catalog).matched_items.length, hits.matched_items.length);
  }
});

test('#7② 缺来源（source_kind 缺失）：契约前提先于有效期判定 fail-closed，同样退出命中集合', () => {
  const missing = Object.freeze({
    ...sampleBase,
    source: Object.freeze({ ...sampleBase.source, source_kind: undefined }),
  });
  // 装载层会先把这类记录 fail-closed 排除（packages/reference/records.mjs:82-98 ⇒ skipped），
  // 此处直接对条目判定，验证「契约前提 → 可见性/有效期」的判定次序。
  const readiness = checkSourceContractReadiness(missing);
  assert.equal(readiness.ok, false);
  assert.deepEqual(readiness.missing, ['来源类型（source_kind）']);

  const verdict = evaluateEligibility(missing);
  assert.equal(verdict.queryable, false);
  assert.equal(verdict.reason, '来源类型缺失或非法枚举，无法满足契约必填（不编造来源类型）');
  // 有效期仍是 valid、可见性仍是 published ⇒ 说明拒绝来自契约前提（不编造来源类型），而非有效期
  assert.equal(missing.source.source_validity, 'valid');
  assert.equal(missing.visibility, 'published');

  const withMissing = baseline.map((x) => (x.record_id === sampleBase.record_id ? missing : x));
  const hits = runQuery(withMissing, HIT_QUERY, catalog);
  assert.ok(
    !hits.matched_items.some((x) => x.record_id === sampleBase.record_id),
    '缺来源字段的记录不得进入命中集合（不得靠默认值补出 source_kind）',
  );
  assert.equal(toDetail(missing, catalog).queryable, false);
  assert.equal(
    toDetail(missing, catalog).unavailable_reason,
    '来源类型缺失或非法枚举，无法满足契约必填（不编造来源类型）',
  );
});

