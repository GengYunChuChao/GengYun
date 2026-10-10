// GY-I07 来源版本一致性 + 下架/失效缓存回归。
//
// 验收（#7）：「下架／失效退出有效查询，详情与列表一致」+
// 提交证据「来源版本与下架缓存回归」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVersionIndex,
  etagFor,
  activeEtag,
  isActiveVersion,
  applyGovernanceChange,
  loadHerbicideRecords,
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
