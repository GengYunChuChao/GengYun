/**
 * GY-I17（#17）阶段 1 · 出口不可变反例（"入口冻结 + 出口深拷贝"两条边界）。
 *
 * 参照 `services/api/src/admin/immutable.ts`（#18，只读参考）的边界语义：
 *   - 出口必须是**深**拷贝（本次专门针对 `message.target_ref.id` 这种嵌套层）；
 *   - 入口必须**深**冻结 ⇒ 越界赋值直接抛 `TypeError`（可判定），不做静默丢弃。
 * 断言一律先判 `typeof`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloneDeep, freezeDeep, takeOwnershipDeep } from '../../services/api/src/messages/immutable.ts';
import { USER_A, append, idem, makeHarness } from './messages-fixtures.mjs';

test('反例·出口不可变：改列表响应里的嵌套 target_ref / read_at 动不了存储', async () => {
  const h = makeHarness();
  const target = { type: 'post', id: 'post-original', revision: 1 };
  const created = await append(h.service, { owner_id: USER_A.userId, event_key: 'e-immut', target_ref: target });

  const before = await h.rawStore.getMessage(created.message.id);
  assert.equal(typeof before.target_ref, 'object');
  assert.equal(before.target_ref.id, 'post-original');

  const page = await h.service.listMessages(USER_A, {});
  assert.equal(page.items.length, 1);
  const item = page.items[0];
  // 出口对象必须是**可变的自有数据**（不是存进去的冻结对象，也不是同一引用）。
  assert.equal(Object.isFrozen(item), false, '出口不应是冻结对象（调用方拿到自有普通数据）');
  assert.equal(Object.isFrozen(item.target_ref), false);
  assert.notEqual(item.target_ref, target, '出口 target_ref 不得与调用方对象共享引用');
  // 嵌套改写 + 顶层改写 + 数组改写。
  item.target_ref.id = 'post-mutated';
  item.target_ref.revision = 99;
  item.read_at = '2000-01-01T00:00:00.000Z';
  item.id = 'mutated-id';
  page.items.push({ id: 'x' });

  const after = await h.rawStore.getMessage(created.message.id);
  assert.equal(after.target_ref.id, 'post-original', '嵌套改动不得写回存储');
  assert.equal(after.target_ref.revision, 1);
  assert.equal(after.read_at, null);
  assert.equal(after.id, created.message.id);
  const pageAgain = await h.service.listMessages(USER_A, {});
  assert.equal(pageAgain.items.length, 1, 'push 进响应数组不得影响存储');

  // markMessageRead 的响应同理。
  const marked = await h.service.markMessageRead(USER_A, created.message.id, {
    idempotencyKey: idem(601),
    ifMatch: '"1"',
  });
  assert.equal(typeof marked.read_at, 'string');
  marked.read_at = '1999-01-01T00:00:00.000Z';
  marked.revision = 42;
  const storedAfterMutate = await h.rawStore.getMessage(created.message.id);
  assert.equal(typeof storedAfterMutate.read_at, 'string');
  assert.notEqual(storedAfterMutate.read_at, '1999-01-01T00:00:00.000Z', '改响应不得改存储里的 read_at');
  assert.equal(storedAfterMutate.revision, 1);
});

test('反例·入口冻结：把入参对象再改动不得影响存储，且存储内的记录是深冻结的', async () => {
  const h = makeHarness();
  const target = { type: 'herbicide', id: 'PD20210001', revision: 3 };
  const created = await append(h.service, { owner_id: USER_A.userId, event_key: 'e-freeze', target_ref: target });
  assert.equal(created.created, true);
  // 创建口返回的对象也不得与调用方对象共享引用。
  assert.notEqual(created.message.target_ref, target);

  // 调用方在入库后继续改自己的对象 ⇒ 存储不受影响（入口深拷贝）。
  target.id = 'PD99999999';
  target.revision = 9;
  const stored = await h.rawStore.getMessage(created.message.id);
  assert.equal(stored.target_ref.id, 'PD20210001');
  assert.equal(stored.target_ref.revision, 3);

  // 边界单元：`takeOwnershipDeep` = 深拷贝 + 深冻结，越界赋值抛 TypeError（可判定）。
  const source = { nested: { value: 1 }, list: [{ deep: 2 }] };
  const owned = takeOwnershipDeep(source);
  assert.equal(owned === source, false);
  assert.equal(Object.isFrozen(owned), true);
  assert.equal(Object.isFrozen(owned.nested), true);
  assert.equal(Object.isFrozen(owned.list), true);
  assert.equal(Object.isFrozen(owned.list[0]), true);
  assert.throws(() => {
    owned.nested.value = 2;
  }, TypeError);
  assert.throws(() => {
    owned.list[0].deep = 3;
  }, TypeError);
  assert.throws(() => {
    owned.list.push({ deep: 4 });
  }, TypeError);
  source.nested.value = 42;
  assert.equal(owned.nested.value, 1, '深拷贝：改原对象不得影响自有副本');

  // `cloneDeep` 是深拷贝而非浅拷贝，且返回**可变**数据。
  const copy = cloneDeep(owned);
  assert.equal(Object.isFrozen(copy), false);
  assert.equal(Object.isFrozen(copy.nested), false);
  copy.nested.value = 7;
  assert.equal(owned.nested.value, 1);

  // `freezeDeep` 返回同一引用（冻结而非拷贝）。
  const plain = { a: { b: 1 } };
  assert.equal(freezeDeep(plain), plain);
  assert.equal(Object.isFrozen(plain.a), true);
});
