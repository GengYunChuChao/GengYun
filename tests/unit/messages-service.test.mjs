/**
 * GY-I17（#17）阶段 1 · 消息域服务层：契约形状、正控制与参数/参数头反例。
 *
 * 契约来源：`packages/contracts/openapi.json`（契约 1.0.0）
 *   - `listMessages`      GET  /messages                （query: cursor ≤2048, limit 1..50 默认20）
 *   - `getUnreadCount`    GET  /messages/unread-count
 *   - `markMessageRead`   PUT  /messages/{id}/read      （path id uuid；Idempotency-Key required；
 *                                                        If-Match required，禁止 *）
 * 断言一律**先判 `typeof` 再判值**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABSENT_MESSAGE_ID,
  ADMIN,
  MESSAGE_KEYS,
  USER_A,
  USER_B,
  append,
  assertApiErrorShape,
  captureError,
  idem,
  makeHarness,
} from './messages-fixtures.mjs';

/** 契约闭集（与 openapi 原文逐项一致）。 */
const MESSAGE_TYPES = ['comment', 'like', 'moderation', 'system'];
const REFERENCE_STATES = ['available', 'unavailable'];

function assertMessageShape(message, label) {
  assert.equal(typeof message, 'object', `${label}：Message 必须是对象`);
  assert.equal(Array.isArray(message), false, `${label}：Message 不得是数组`);
  // additionalProperties:false ⇒ 键集必须**恰好**等于契约 required 七项（无 title/body/actor）。
  assert.deepEqual(Object.keys(message).sort(), [...MESSAGE_KEYS].sort(), `${label}：字段集必须与契约一致`);
  assert.equal(typeof message.id, 'string', `${label}：id 应为 string`);
  assert.equal(typeof message.revision, 'number', `${label}：revision 应为 number`);
  assert.equal(Number.isSafeInteger(message.revision), true, `${label}：revision 应为整数`);
  assert.ok(message.revision >= 1, `${label}：revision 应 ≥1`);
  assert.equal(typeof message.type, 'string', `${label}：type 应为 string`);
  assert.ok(MESSAGE_TYPES.includes(message.type), `${label}：type 必须落在闭集内，实际 ${message.type}`);
  assert.ok(
    message.target_ref === null || typeof message.target_ref === 'object',
    `${label}：target_ref 应为对象或 null`,
  );
  if (message.target_ref !== null) {
    assert.deepEqual(Object.keys(message.target_ref).sort(), ['id', 'revision', 'type'], `${label}：TargetRef 字段集`);
  }
  assert.equal(typeof message.reference_state, 'string', `${label}：reference_state 应为 string`);
  assert.ok(
    REFERENCE_STATES.includes(message.reference_state),
    `${label}：reference_state 必须落在闭集内，实际 ${message.reference_state}`,
  );
  assert.ok(message.read_at === null || typeof message.read_at === 'string', `${label}：read_at 应为 string 或 null`);
  assert.equal(typeof message.created_at, 'string', `${label}：created_at 应为 string`);
}

test('正控制：本人两条消息（一条未读、一条已读）⇒ unread-count=1；形状与排序正确；标记后 count=0；重复标记不改 read_at', async () => {
  const h = makeHarness();
  const first = await append(h.service, { event_key: 'evt-comment-1' });
  const second = await append(h.service, { event_key: 'evt-like-2', type: 'like' });
  assert.equal(typeof first.created, 'boolean');
  assert.equal(first.created, true);
  assert.equal(typeof second.created, 'boolean');
  assert.equal(second.created, true);
  // 创建不当已读：两条都是未读。
  assert.equal(first.message.read_at, null);
  assert.equal(second.message.read_at, null);
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 2);

  // 只把第二条标记已读。
  const markedSecond = await h.service.markMessageRead(USER_A, second.message.id, {
    idempotencyKey: idem(101),
    ifMatch: '"1"',
  });
  assertMessageShape(markedSecond, 'markMessageRead 响应');
  assert.equal(typeof markedSecond.read_at, 'string', '标记后 read_at 必须有值');

  const unread = await h.service.getUnreadCount(USER_A);
  assert.equal(typeof unread.count, 'number');
  assert.equal(unread.count, 1, '两条消息、一条已读 ⇒ 未读恰为 1');

  const page = await h.service.listMessages(USER_A, {});
  assert.equal(typeof page, 'object');
  assert.deepEqual(Object.keys(page).sort(), ['items', 'next_cursor']);
  assert.equal(Array.isArray(page.items), true);
  assert.equal(page.items.length, 2);
  assert.equal(page.next_cursor, null, '两条不足一页 ⇒ next_cursor 为 null');
  for (const item of page.items) assertMessageShape(item, 'listMessages items[]');
  // 契约排序 (created_at DESC, id DESC)：后创建的先出现。
  assert.equal(page.items[0].id, second.message.id);
  assert.equal(page.items[1].id, first.message.id);

  // 标记第一条 ⇒ count=0，且 read_at 有值。
  const markedFirst = await h.service.markMessageRead(USER_A, first.message.id, {
    idempotencyKey: idem(102),
    ifMatch: '"1"',
  });
  assert.equal(typeof markedFirst.read_at, 'string');
  const zero = await h.service.getUnreadCount(USER_A);
  assert.equal(zero.count, 0);

  // 重复标记（新幂等键）：count 仍为 0，read_at 不变（首次时间被保持）。
  const repeat = await h.service.markMessageRead(USER_A, first.message.id, {
    idempotencyKey: idem(103),
    ifMatch: '"1"',
  });
  assert.equal(typeof repeat.read_at, 'string');
  assert.equal(repeat.read_at, markedFirst.read_at, '重复标记不得改动首次 read_at');
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 0, '重复标记不得再次减少未读');
  // 真正发生的读状态转换恰好 2 次（每条消息一次）。
  assert.equal(h.store.snapshotCounts().read_transitions, 2);
});

test('正控制：同键重放返回同一状态（不重复写、read_at 不变）', async () => {
  const h = makeHarness();
  const created = await append(h.service, { event_key: 'evt-replay' });
  const options = { idempotencyKey: idem(110), ifMatch: '"1"' };
  const once = await h.service.markMessageRead(USER_A, created.message.id, options);
  const twice = await h.service.markMessageRead(USER_A, created.message.id, options);
  assert.equal(twice.id, once.id);
  assert.equal(twice.read_at, once.read_at, '同键重放必须回放同一状态');
  assert.equal(h.store.snapshotCounts().read_transitions, 1, '重放不得产生第二次读状态写入');
});

test('正控制：未读数为 0 的边界（无消息、全已读、重复标记已读）', async () => {
  const h = makeHarness();
  const empty = await h.service.getUnreadCount(USER_B);
  assert.equal(typeof empty.count, 'number');
  assert.equal(empty.count, 0, '没有任何消息 ⇒ 未读为 0（不是 null/NaN）');

  const created = await append(h.service, { event_key: 'evt-boundary' });
  await h.service.markMessageRead(USER_A, created.message.id, { idempotencyKey: idem(120), ifMatch: '"1"' });
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 0);

  // 未读已经是 0，再标记已读消息：仍为 0（单调，绝不增加也绝不变成负数）。
  await h.service.markMessageRead(USER_A, created.message.id, { idempotencyKey: idem(121), ifMatch: '"1"' });
  const stillZero = await h.service.getUnreadCount(USER_A);
  assert.equal(stillZero.count, 0);
  assert.ok(stillZero.count >= 0, '未读数不得为负');
  // 另一个主体仍然 0（未读数按接收者归属）。
  assert.equal((await h.service.getUnreadCount(USER_B)).count, 0);
});

test('反例·主体：缺会话 401 SESSION_REQUIRED；后台会话 403 SCOPE_DENIED', async () => {
  const h = makeHarness();
  const created = await append(h.service, { event_key: 'evt-actor' });

  const noSession = [
    await captureError(() => h.service.listMessages(undefined, {})),
    await captureError(() => h.service.getUnreadCount(undefined)),
    await captureError(() =>
      h.service.markMessageRead(undefined, created.message.id, { idempotencyKey: idem(130), ifMatch: '"1"' }),
    ),
    await captureError(() => h.service.listMessages({ userId: USER_A.userId }, {})),
    await captureError(() => h.service.getUnreadCount({ userId: USER_A.userId, role: 'user' })),
  ];
  for (const error of noSession) assertApiErrorShape(error, 'SESSION_REQUIRED', 401);

  const adminErrors = [
    await captureError(() => h.service.listMessages(ADMIN, {})),
    await captureError(() => h.service.getUnreadCount(ADMIN)),
    await captureError(() =>
      h.service.markMessageRead(ADMIN, created.message.id, { idempotencyKey: idem(131), ifMatch: '"1"' }),
    ),
  ];
  for (const error of adminErrors) assertApiErrorShape(error, 'SCOPE_DENIED', 403);

  // 后台会话被拒后不得产生任何已读转换。
  assert.equal(h.store.snapshotCounts().read_transitions, 0);
});

test('反例·参数：非法 uuid / 未知 id / 缺与非法 Idempotency-Key / 缺与非法 If-Match / 版本不符', async () => {
  const h = makeHarness();
  const created = await append(h.service, { event_key: 'evt-params' });
  const id = created.message.id;

  assertApiErrorShape(
    await captureError(() => h.service.markMessageRead(USER_A, 'not-a-uuid', { idempotencyKey: idem(140), ifMatch: '"1"' })),
    'INVALID_REQUEST',
    400,
  );
  assertApiErrorShape(
    await captureError(() =>
      h.service.markMessageRead(USER_A, ABSENT_MESSAGE_ID, { idempotencyKey: idem(141), ifMatch: '"1"' }),
    ),
    'NOT_FOUND',
    404,
  );

  // Idempotency-Key（required 8..128）
  assertApiErrorShape(
    await captureError(() => h.service.markMessageRead(USER_A, id, { ifMatch: '"1"' })),
    'IDEMPOTENCY_KEY_REQUIRED',
    400,
  );
  assertApiErrorShape(
    await captureError(() => h.service.markMessageRead(USER_A, id, { idempotencyKey: 'short', ifMatch: '"1"' })),
    'IDEMPOTENCY_KEY_REQUIRED',
    400,
  );

  // If-Match（required `^"[1-9][0-9]*"$`，禁止 *）
  assertApiErrorShape(
    await captureError(() => h.service.markMessageRead(USER_A, id, { idempotencyKey: idem(142) })),
    'REVISION_REQUIRED',
    428,
  );
  assertApiErrorShape(
    await captureError(() =>
      h.service.markMessageRead(USER_A, id, { idempotencyKey: idem(143), ifMatch: '*' }),
    ),
    'INVALID_REQUEST',
    400,
  );
  assertApiErrorShape(
    await captureError(() =>
      h.service.markMessageRead(USER_A, id, { idempotencyKey: idem(144), ifMatch: '3' }),
    ),
    'INVALID_REQUEST',
    400,
  );
  assertApiErrorShape(
    await captureError(() =>
      h.service.markMessageRead(USER_A, id, { idempotencyKey: idem(145), ifMatch: '"0"' }),
    ),
    'INVALID_REQUEST',
    400,
  );

  // 与当前版本不符 ⇒ 409 REVISION_CONFLICT（If-Match 的语义落点，可判定）。
  assertApiErrorShape(
    await captureError(() =>
      h.service.markMessageRead(USER_A, id, { idempotencyKey: idem(146), ifMatch: '"2"' }),
    ),
    'REVISION_CONFLICT',
    409,
  );
  assert.equal(h.store.snapshotCounts().read_transitions, 0, '被拒的请求不得产生读状态写入');

  // 正控制对照：合法请求成功。
  const ok = await h.service.markMessageRead(USER_A, id, { idempotencyKey: idem(147), ifMatch: '"1"' });
  assert.equal(typeof ok.read_at, 'string');
});

test('反例·参数：limit 越界/非整数、cursor 格式非法、查询参数含未声明字段 ⇒ 400 INVALID_REQUEST', async () => {
  const h = makeHarness();
  await append(h.service, { event_key: 'evt-query' });

  for (const limit of [0, 51, -1, 1.5, '10', Number.NaN]) {
    const error = await captureError(() => h.service.listMessages(USER_A, { limit }));
    assertApiErrorShape(error, 'INVALID_REQUEST', 400);
  }
  // limit=50（上限）与 limit=1（下限）必须被接受。
  assert.equal((await h.service.listMessages(USER_A, { limit: 1 })).items.length, 1);
  assert.equal((await h.service.listMessages(USER_A, { limit: 50 })).items.length, 1);

  assertApiErrorShape(
    await captureError(() => h.service.listMessages(USER_A, { cursor: '' })),
    'INVALID_REQUEST',
    400,
  );
  assertApiErrorShape(
    await captureError(() => h.service.listMessages(USER_A, { cursor: 'x'.repeat(2049) })),
    'INVALID_REQUEST',
    400,
  );
  // 未在契约中声明的查询字段 ⇒ 明确 400，不静默丢弃。
  assertApiErrorShape(
    await captureError(() => h.service.listMessages(USER_A, { limit: 1, crop_id: 'x' })),
    'INVALID_REQUEST',
    400,
  );
  assertApiErrorShape(
    await captureError(() => h.service.listMessages(USER_A, 'limit=1')),
    'INVALID_REQUEST',
    400,
  );
});

test('反例·幂等台账：同键异体 409；produce 失败必须释放占位（同键可重试）', async () => {
  const h = makeHarness();
  const created = await append(h.service, { event_key: 'evt-idem' });
  const id = created.message.id;

  // 先用一个会失败的请求占用同一个键（If-Match 不匹配 ⇒ 409 由服务层抛出）。
  const key = idem(150);
  assertApiErrorShape(
    await captureError(() => h.service.markMessageRead(USER_A, id, { idempotencyKey: key, ifMatch: '"9"' })),
    'REVISION_CONFLICT',
    409,
  );
  // 占位必须被释放：同一个键换成正确的 If-Match 必须能成功（不被永久挡住）。
  const retried = await h.service.markMessageRead(USER_A, id, { idempotencyKey: key, ifMatch: '"1"' });
  assert.equal(typeof retried.read_at, 'string');
  assert.equal(h.store.snapshotCounts().read_transitions, 1);

  // 同键同体的重放仍返回同一状态；同键异体 ⇒ 409 IDEMPOTENCY_CONFLICT。
  const replayed = await h.service.markMessageRead(USER_A, id, { idempotencyKey: key, ifMatch: '"1"' });
  assert.equal(replayed.read_at, retried.read_at);
  assertApiErrorShape(
    await captureError(() => h.service.markMessageRead(USER_A, id, { idempotencyKey: key, ifMatch: '"7"' })),
    'IDEMPOTENCY_CONFLICT',
    409,
  );
  assert.equal(h.store.snapshotCounts().read_transitions, 1, '冲突不得产生第二次写入');
});
