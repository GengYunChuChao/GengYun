// GY-I18 本片 · **后台列表/详情在读取时重查权限与可见性**（`Refs #18`）。
//
// 覆盖：
//   R1. 详情读取时**重算可见性**：发布 ⇒ `published`；撤回 ⇒ `hidden`（不缓存写时的结论）；
//       用失效前拿到的响应副本改写，不影响下一次读的结论。
//   R2. 详情/列表读取时**重查对象权限**：管辖变更后，原主体立刻 404（与"不存在"同形），
//       新主体可读 —— 证明权限是**读时**从存储判定的，而不是写时记在响应/缓存里的。
//   R3. 列表读取时**逐项重算**：同一份列表里已撤回项为 `hidden`、未发布项为 `private`，
//       每次调用都按当前状态重新投影。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FAMILY_CASES,
  OTHER_STEWARD,
  STEWARD,
  adminIdentity,
  context,
  createDraft,
  createHarness,
  expectApiError,
  publishRevision,
  withdrawRevision,
} from './admin-fixtures.mjs';

const [SOURCES, KNOWLEDGE] = FAMILY_CASES;

test('R1. 详情读取时重算可见性：发布 published → 撤回 hidden（写时结论不被复用）', async () => {
  const { service, store } = createHarness();
  const created = await createDraft(SOURCES, service);
  const id = created.body.data.id;

  assert.equal((await service.getAdminSource(context(), id)).body.data.visibility, 'private', '未发布 ⇒ private');

  await publishRevision(SOURCES, service, id, 1);
  const published = await service.getAdminSource(context(), id);
  assert.equal(published.body.data.visibility, 'published');
  assert.equal(published.body.data.source.review_status, 'verified', 'sources 家族的 review_status 在 source 内（契约形状）');

  // 拿住失效前的响应副本并改写（响应是深拷贝：改写它不得污染存储，也不得改变下一次读）。
  published.body.data.visibility = 'tampered';
  await withdrawRevision(SOURCES, service, id, 1);

  const after = await service.getAdminSource(context(), id);
  assert.equal(after.body.data.visibility, 'hidden', '撤回后必须按当前状态重新投影');
  assert.equal(after.body.data.source.review_status, 'verified', '曾经发布过的修订仍如实标 verified（可追溯）');
  assert.notEqual(after.body.data.visibility, 'tampered');
  assert.equal(store.getEntity(id).lifecycle, 'withdrawn');

  // 再发布同一修订 ⇒ 读取时又变回 published（可见性是读取时的判定，不是不可逆标记）。
  await publishRevision(SOURCES, service, id, 1);
  assert.equal((await service.getAdminSource(context(), id)).body.data.visibility, 'published');
});

test('R2. 读取时重查对象权限：管辖外主体的详情读取 404（与"不存在"同形），列表为空', async () => {
  const { service } = createHarness();
  const created = await createDraft(KNOWLEDGE, service);
  const id = created.body.data.id;
  assert.equal((await service.getAdminKnowledge(context(), id)).status, 200);

  const other = { identity: adminIdentity({ userId: OTHER_STEWARD }) };
  await expectApiError(() => service.getAdminKnowledge(other, id), 'NOT_FOUND');
  // 列表不泄露存在性：管辖外主体看到的是空集合（不是 403/404，也没有"别的主体有多少条"）。
  const listed = await service.listAdminKnowledge(other);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data.items, []);
  assert.equal(listed.body.data.next_cursor, null);
});

test('R2b. 管辖按读时判定：把存储里的管辖主体换人后，原主体 404、新主体 200、列表也随之切换', async () => {
  const { service, store } = createHarness();
  const created = await createDraft(KNOWLEDGE, service);
  const id = created.body.data.id;
  const other = { identity: adminIdentity({ userId: OTHER_STEWARD }) };

  assert.equal((await service.listAdminKnowledge(other)).body.data.items.length, 0, '换人前新主体列表为空');
  assert.equal((await service.listAdminKnowledge(context())).body.data.items.length, 1);

  // 存储侧管辖变更（模拟运维/治理动作）。读路径没有任何写时快照 ⇒ 结论立刻跟着变。
  store.getEntity(id).stewardId = OTHER_STEWARD;

  await expectApiError(() => service.getAdminKnowledge(context(), id), 'NOT_FOUND');
  await expectApiError(
    () => service.editKnowledgeDraft(
      { ...context(), idempotencyKey: 'gy-i18-readtime-edit-0001', ifMatch: '"1"' },
      id,
      KNOWLEDGE.editedInput(),
    ),
    'NOT_FOUND',
  );
  assert.equal((await service.getAdminKnowledge(other, id)).status, 200, '新主体可读');
  assert.equal((await service.listAdminKnowledge(other)).body.data.items.length, 1);
  assert.equal((await service.listAdminKnowledge(context())).body.data.items.length, 0, '原主体列表立刻为空（不是缓存）');
  assert.equal(store.getEntity(id).stewardId, OTHER_STEWARD);
  assert.equal(STEWARD.length > 0, true, 'sanity');
});

test('R3. 列表逐项重算：同一份列表里已撤回项为 hidden、草稿项为 private', async () => {
  const { service } = createHarness();
  const first = await createDraft(SOURCES, service);
  const second = await createDraft(SOURCES, service);
  await publishRevision(SOURCES, service, first.body.data.id, 1);
  await publishRevision(SOURCES, service, second.body.data.id, 1);
  await withdrawRevision(SOURCES, service, second.body.data.id, 1);

  const listed = await service.listAdminSources(context());
  assert.equal(listed.status, 200);
  const byId = Object.fromEntries(listed.body.data.items.map((item) => [item.id, item]));
  assert.equal(byId[first.body.data.id].visibility, 'published');
  assert.equal(byId[second.body.data.id].visibility, 'hidden', '撤回项必须在同一次列表读取里就变成 hidden');

  // 再建一条草稿：下一次读立刻多出 private 项（列表不是快照）。
  const third = await createDraft(SOURCES, service);
  const listedAgain = await service.listAdminSources(context());
  const byIdAgain = Object.fromEntries(listedAgain.body.data.items.map((item) => [item.id, item]));
  assert.equal(byIdAgain[third.body.data.id].visibility, 'private');
  assert.equal(listedAgain.body.data.items.length, 3);
});
