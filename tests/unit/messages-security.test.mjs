/**
 * GY-I17（#17）阶段 1 · 消息域安全语义反例：归属同形 404、引用可用性 fail-closed、
 * 目标存在性不泄露、读取时重查（不缓存）、创建口拒绝非法入参。
 *
 * 断言一律**先判 `typeof` 再判值**；"同形"用 `errorEnvelopeJson`（同一 `request_id`
 * + 同一 `execution_mode` 下的契约 `ErrorEnvelope` JSON 串）做**逐字节**比较。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABSENT_MESSAGE_ID,
  MESSAGE_KEYS,
  USER_A,
  USER_B,
  append,
  assertApiErrorShape,
  captureError,
  createUnwiredReferencePort,
  createWiredReferencePort,
  errorEnvelopeJson,
  idem,
  makeHarness,
} from './messages-fixtures.mjs';

/** 只回答"该目标当前对**该用户**是否可用"的合成端口（不返回任何目标内容）。 */
function registryPort(entries, calls = []) {
  return createWiredReferencePort({
    note: '合成目标注册表（测试用；只回答可用性枚举）',
    async resolve({ target_ref, userId }) {
      calls.push({ target_ref: { ...target_ref }, userId });
      const entry = entries[target_ref.id];
      if (entry === undefined) return 'unavailable';
      return entry.visibleTo.includes(userId) ? 'available' : 'unavailable';
    },
  });
}

test('反例·归属：他人消息 既不能标记也不能列出；标记报错与"不存在"逐字节同形', async () => {
  const h = makeHarness();
  const mine = await append(h.service, { owner_id: USER_A.userId, event_key: 'a-1' });
  const mineRead = await append(h.service, { owner_id: USER_A.userId, event_key: 'a-2' });
  await h.service.markMessageRead(USER_A, mineRead.message.id, { idempotencyKey: idem(201), ifMatch: '"1"' });

  const otherUnread = await captureError(() =>
    h.service.markMessageRead(USER_B, mine.message.id, { idempotencyKey: idem(202), ifMatch: '"1"' }),
  );
  const otherRead = await captureError(() =>
    h.service.markMessageRead(USER_B, mineRead.message.id, { idempotencyKey: idem(203), ifMatch: '"1"' }),
  );
  const absent = await captureError(() =>
    h.service.markMessageRead(USER_B, ABSENT_MESSAGE_ID, { idempotencyKey: idem(204), ifMatch: '"1"' }),
  );
  assertApiErrorShape(otherUnread, 'NOT_FOUND', 404);
  assertApiErrorShape(otherRead, 'NOT_FOUND', 404);
  assertApiErrorShape(absent, 'NOT_FOUND', 404);
  // 逐字节同形：不泄露"存在但不是你的"，也不泄露"存在且已读"。
  const baseline = errorEnvelopeJson(absent);
  assert.equal(typeof baseline, 'string');
  assert.equal(errorEnvelopeJson(otherUnread), baseline, '他人未读消息必须与不存在同形');
  assert.equal(errorEnvelopeJson(otherRead), baseline, '他人已读消息也必须与不存在同形');

  // 列表域：B 完全看不到 A 的消息，也数不到 A 的未读。
  const pageB = await h.service.listMessages(USER_B, {});
  assert.equal(pageB.items.length, 0, '他人消息不得出现在列表');
  assert.equal(pageB.next_cursor, null);
  assert.equal((await h.service.getUnreadCount(USER_B)).count, 0, '未读数按接收者归属');

  // A 自己的视图不受影响。
  const pageA = await h.service.listMessages(USER_A, {});
  assert.equal(pageA.items.length, 2);
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 1);

  // 被拒的越权请求不得产生任何读状态转换。
  assert.equal(h.store.snapshotCounts().read_transitions, 1);
});

test('反例·目标不可见：reference_state 不得假装可用，且与"目标不存在"不可区分', async () => {
  const privatePost = 'post-private-of-a';
  const missingPost = 'post-does-not-exist';
  const calls = [];
  const reference = registryPort(
    { [privatePost]: { visibleTo: [USER_A.userId] } },
    calls,
  );
  const h = makeHarness({ reference });

  // A 的目标对 A 可见 ⇒ available（正控制：证明端口真的被消费，不是恒定 unavailable）。
  const ownPost = 'post-own-of-a';
  const referenceWide = registryPort({ [ownPost]: { visibleTo: [USER_A.userId] } });
  const hWide = makeHarness({ reference: referenceWide });
  const mineVisible = await append(hWide.service, {
    owner_id: USER_A.userId,
    event_key: 'a-visible',
    target_ref: { type: 'post', id: ownPost, revision: 1 },
  });
  const pageVisible = await hWide.service.listMessages(USER_A, {});
  assert.equal(pageVisible.items[0].id, mineVisible.message.id);
  assert.equal(pageVisible.items[0].reference_state, 'available', '目标对本人可见时必须报 available');

  // B 收到的两条消息：一条指向 A 的私有帖子（存在但不可见），一条指向不存在的目标。
  await append(h.service, {
    owner_id: USER_B.userId,
    event_key: 'b-private',
    target_ref: { type: 'post', id: privatePost, revision: 1 },
  });
  await append(h.service, {
    owner_id: USER_B.userId,
    event_key: 'b-missing',
    target_ref: { type: 'post', id: missingPost, revision: 1 },
  });
  const pageB = await h.service.listMessages(USER_B, {});
  assert.equal(pageB.items.length, 2);
  const byTarget = new Map(pageB.items.map((item) => [item.target_ref.id, item]));
  const invisible = byTarget.get(privatePost);
  const missing = byTarget.get(missingPost);
  assert.equal(typeof invisible.reference_state, 'string');
  assert.equal(invisible.reference_state, 'unavailable', '目标不可见时不得假装可用');
  assert.equal(missing.reference_state, 'unavailable');
  // 除"消息自身身份"（id/created_at）与调用方自己给出的 target_ref 之外，
  // 两者可观测到的**其余字段逐项相同** ⇒ 响应里没有"存在性"旁路
  // （消息 id/created_at 是消息自己的身份，不是目标的身份；目标只由 target_ref 指认）。
  const observable = (message) =>
    JSON.stringify({
      revision: message.revision,
      type: message.type,
      reference_state: message.reference_state,
      read_at: message.read_at,
      keys: Object.keys(message).sort(),
    });
  assert.equal(observable(invisible), observable(missing), '"存在但无权"与"不存在"必须不可区分');
  // 消息本体不得新增任何字段（没有 title/body/actor 之类可用于泄露的通道）。
  assert.deepEqual(Object.keys(invisible).sort(), [...MESSAGE_KEYS].sort());
  // 端口确实被逐条询问（没有"未接线就跳过"这种静默放行）。
  assert.equal(calls.length, 2);
  assert.equal(typeof calls[0].userId, 'string');
});

test('反例·端口未接线/抛错/返回非闭集取值 ⇒ 一律 unavailable（fail-closed，不假装可用）', async () => {
  const target = { type: 'post', id: 'post-any', revision: 2 };
  const cases = [
    ['未接线端口', createUnwiredReferencePort()],
    [
      '端口抛错',
      createWiredReferencePort({
        resolve: async () => {
          throw new Error('目标后端不可用（合成故障）');
        },
      }),
    ],
    ['端口返回 unknown', createWiredReferencePort({ resolve: async () => 'unknown' })],
    ['端口返回布尔 true', createWiredReferencePort({ resolve: async () => true })],
    ['端口返回 {state:available}', createWiredReferencePort({ resolve: async () => ({ state: 'available' }) })],
    ['端口返回 null', createWiredReferencePort({ resolve: async () => null })],
    [
      '端口谎报与接线状态矛盾（available:false 但 stateOf 返回 available）',
      {
        kind: 'wired',
        note: '合成矛盾端口',
        available: false,
        unavailableReason: '未接线',
        stateOf: async () => 'available',
      },
    ],
  ];
  for (const [label, reference] of cases) {
    const h = makeHarness({ reference });
    await append(h.service, { owner_id: USER_A.userId, event_key: `e-${label}`, target_ref: target });
    const page = await h.service.listMessages(USER_A, {});
    assert.equal(page.items.length, 1, `${label}：应有 1 条消息`);
    assert.equal(typeof page.items[0].reference_state, 'string', `${label}：reference_state 应为字符串`);
    assert.equal(page.items[0].reference_state, 'unavailable', `${label}：必须保守取 unavailable`);
  }

  // 无 target_ref 的消息同样不得凭空声称可用（没有可核验的目标 ⇒ 无正证据）。
  const h = makeHarness();
  const noTarget = await append(h.service, { owner_id: USER_A.userId, event_key: 'e-null-target', target_ref: null });
  assert.equal(noTarget.message.target_ref, null);
  const page = await h.service.listMessages(USER_A, {});
  assert.equal(page.items[0].reference_state, 'unavailable', '没有目标可核验时必须保守 unavailable');
});

test('反例·读取时重查：reference_state 不入库、逐次派生（目标状态变化立即反映）', async () => {
  let visible = true;
  const reference = createWiredReferencePort({ resolve: async () => (visible ? 'available' : 'unavailable') });
  const h = makeHarness({ reference });
  const created = await append(h.service, {
    owner_id: USER_A.userId,
    event_key: 'e-recheck',
    target_ref: { type: 'herbicide', id: 'PD20210001', revision: 1 },
  });

  const before = await h.service.listMessages(USER_A, {});
  assert.equal(before.items[0].reference_state, 'available');

  // 目标被下架/失效（端口改为 unavailable）⇒ 下一次读取立即变 unavailable。
  visible = false;
  const after = await h.service.listMessages(USER_A, {});
  assert.equal(after.items[0].reference_state, 'unavailable', '状态必须在读取时重查，不得缓存');

  // 存储里**没有** reference_state 字段（不是"存了再改"，而是每次派生）。
  const stored = await h.rawStore.getMessage(created.message.id);
  assert.equal(typeof stored, 'object');
  assert.equal(Object.hasOwn(stored, 'reference_state'), false, 'reference_state 不得入库');
  assert.equal(Object.hasOwn(stored, 'title'), false, '消息不得存标题');
  assert.equal(Object.hasOwn(stored, 'body'), false, '消息不得存正文');
});

test('反例·创建口：拒绝非法入参（type 闭集外、owner/event_key/target_ref 形状、注入 read_at/id/revision）且不落库', async () => {
  const h = makeHarness();
  const badInputs = [
    ['type 闭集外', { owner_id: USER_A.userId, type: 'advertisement', target_ref: null, event_key: 'e' }],
    ['type 缺失', { owner_id: USER_A.userId, target_ref: null, event_key: 'e' }],
    ['type 非字符串', { owner_id: USER_A.userId, type: 7, target_ref: null, event_key: 'e' }],
    ['owner_id 非 uuid', { owner_id: 'user-a', type: 'system', target_ref: null, event_key: 'e' }],
    ['owner_id 缺失', { type: 'system', target_ref: null, event_key: 'e' }],
    ['event_key 空串', { owner_id: USER_A.userId, type: 'system', target_ref: null, event_key: '' }],
    ['event_key 超长', { owner_id: USER_A.userId, type: 'system', target_ref: null, event_key: 'x'.repeat(201) }],
    ['event_key 非字符串', { owner_id: USER_A.userId, type: 'system', target_ref: null, event_key: 12 }],
    ['target_ref 缺失', { owner_id: USER_A.userId, type: 'system', event_key: 'e' }],
    [
      'target_ref.type 闭集外',
      { owner_id: USER_A.userId, type: 'system', target_ref: { type: 'unknown', id: 'x', revision: 1 }, event_key: 'e' },
    ],
    [
      'target_ref.id 空',
      { owner_id: USER_A.userId, type: 'system', target_ref: { type: 'post', id: '', revision: 1 }, event_key: 'e' },
    ],
    [
      'target_ref.revision 非整数',
      { owner_id: USER_A.userId, type: 'system', target_ref: { type: 'post', id: 'x', revision: 0 }, event_key: 'e' },
    ],
    [
      'target_ref 多余字段',
      {
        owner_id: USER_A.userId,
        type: 'system',
        target_ref: { type: 'post', id: 'x', revision: 1, title: '泄露?' },
        event_key: 'e',
      },
    ],
    [
      '注入 read_at（想"创建即已读"）',
      { owner_id: USER_A.userId, type: 'system', target_ref: null, event_key: 'e', read_at: '2026-10-12T03:00:00.000Z' },
    ],
    ['注入 id', { owner_id: USER_A.userId, type: 'system', target_ref: null, event_key: 'e', id: ABSENT_MESSAGE_ID }],
    ['注入 revision', { owner_id: USER_A.userId, type: 'system', target_ref: null, event_key: 'e', revision: 5 }],
    [
      '注入 reference_state',
      { owner_id: USER_A.userId, type: 'system', target_ref: null, event_key: 'e', reference_state: 'available' },
    ],
    ['入参不是对象', 'not-an-object'],
    ['入参为数组', []],
  ];
  for (const [label, input] of badInputs) {
    const error = await captureError(() => h.service.appendMessage(input));
    assertApiErrorShape(error, 'INVALID_REQUEST', 400);
    assert.equal(Array.isArray(error.details), true, `${label}：details 应为数组`);
    if (label !== '入参不是对象' && label !== '入参为数组') {
      assert.ok(error.details.length >= 1, `${label}：应给出字段级 details`);
      assert.equal(typeof error.details[0].field, 'string', `${label}：detail.field 应为字符串`);
      assert.equal(typeof error.details[0].code, 'string', `${label}：detail.code 应为字符串`);
    }
  }
  assert.equal(h.store.snapshotCounts().messages, 0, '非法入参一律不得落库');

  // 正控制对照：合法入参落一条，且创建**不当作已读**。
  const ok = await append(h.service, {
    owner_id: USER_A.userId,
    type: 'moderation',
    target_ref: { type: 'post', id: 'p-1', revision: 3 },
    event_key: 'e-ok',
  });
  assert.equal(ok.created, true);
  assert.equal(ok.message.read_at, null, '创建不得当作已读');
  assert.equal(ok.message.revision, 1);
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 1);
});

test('反例·事件去重：同 (owner,event_key) 只创建一次，且命中去重不得重置读状态', async () => {
  const h = makeHarness();
  const first = await append(h.service, { owner_id: USER_A.userId, event_key: 'comment:c1:r1' });
  assert.equal(first.created, true);
  const duplicate = await append(h.service, { owner_id: USER_A.userId, event_key: 'comment:c1:r1' });
  assert.equal(duplicate.created, false, '重复调度不得重复创建');
  assert.equal(duplicate.message.id, first.message.id);
  assert.equal(h.store.snapshotCounts().messages, 1);

  // 标记已读后再来一次重复调度：不得把读状态重置为未读。
  await h.service.markMessageRead(USER_A, first.message.id, { idempotencyKey: idem(210), ifMatch: '"1"' });
  const again = await append(h.service, { owner_id: USER_A.userId, event_key: 'comment:c1:r1' });
  assert.equal(again.created, false);
  assert.equal(typeof again.message.read_at, 'string', '去重不得重置 read_at');
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 0);

  // 同一事件键在不同接收者之间互相独立（未读按接收者归属）。
  const forB = await append(h.service, { owner_id: USER_B.userId, event_key: 'comment:c1:r1' });
  assert.equal(forB.created, true);
  assert.notEqual(forB.message.id, first.message.id);
  assert.equal((await h.service.getUnreadCount(USER_B)).count, 1);
  assert.equal(h.store.snapshotCounts().messages, 2);
});
