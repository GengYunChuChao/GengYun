/**
 * GY-I17（#17）阶段 1 · 并发/幂等反例（本片"有牙齿"的部分）。
 *
 * 两条关键武器：
 *   1. **计数屏障** `makeBarrier(2)`：让两条并发标记请求**都跨过"读记录"这一步之后**
 *      才各自写 —— 真正复现"检查与写入之间隔着 await"的窗口，检验 CAS 是否关掉了它；
 *   2. **挂起点** `makePausePoint()`：把第一条请求停在"已读、未写"，让第二条先完成，
 *      再放行迟到者 —— 迟到者**必须**复用首次 `read_at`，不得改写、不得再次计减。
 *
 * 判据一律用可判定量：`read_transitions`（存储层真正发生的 `null → 时刻` 写入次数）、
 * 导出式未读数、以及两次响应里的 `read_at` 是否**完全相同**。
 * 断言一律先判 `typeof`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  USER_A,
  USER_B,
  append,
  assertApiErrorShape,
  captureError,
  idem,
  makeBarrier,
  makeHarness,
  makePausePoint,
} from './messages-fixtures.mjs';

test('并发反例（主）：同一消息两条并发标记 ⇒ 未读只减一次，两个响应 read_at 相同', async () => {
  const barrier = makeBarrier(2);
  const h = makeHarness({
    storeWrapper: (base) => ({
      ...base,
      // 两条请求都必须先完成"读记录"再进入写入临界区（复现真实的交错窗口）。
      getMessage: async (id) => {
        const record = await base.getMessage(id);
        await barrier.wait();
        return record;
      },
    }),
  });
  const created = await append(h.service, { owner_id: USER_A.userId, event_key: 'e-race' });
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 1);

  barrier.arm();
  const settled = await Promise.allSettled([
    h.service.markMessageRead(USER_A, created.message.id, { idempotencyKey: idem(301), ifMatch: '"1"' }),
    h.service.markMessageRead(USER_A, created.message.id, { idempotencyKey: idem(302), ifMatch: '"1"' }),
  ]);
  assert.equal(barrier.arrived, 2, '两条请求必须都到达写入前的窗口');
  const fulfilled = settled.filter((item) => item.status === 'fulfilled');
  const rejected = settled.filter((item) => item.status === 'rejected');
  assert.equal(rejected.length, 0, `并发标记不应互相报错：${rejected.map((item) => String(item.reason)).join(' / ')}`);
  assert.equal(fulfilled.length, 2);

  const [left, right] = fulfilled.map((item) => item.value);
  assert.equal(typeof left.read_at, 'string');
  assert.equal(typeof right.read_at, 'string');
  assert.equal(left.read_at, right.read_at, '两者必须报告同一个首次已读时刻');

  // 实测计数：未读 1 → 0，且真正发生的转换**恰好 1 次**（不是 2 次、也不是负数）。
  const counts = h.store.snapshotCounts();
  assert.equal(typeof counts.read_transitions, 'number');
  assert.equal(counts.read_transitions, 1, '并发标记同一消息必须只发生一次读状态转换');
  const unread = await h.service.getUnreadCount(USER_A);
  assert.equal(unread.count, 0, '未读数只减一次 ⇒ 0（不是 -1，也不是 2）');
  assert.ok(unread.count >= 0, '未读数不得为负');
  assert.equal(counts.messages, 1, '并发标记不得产生新消息');

  // 派生不变量：count 必须等于 read_at===null 的本人行数（现算现比，杜绝漂移）。
  const rows = await h.rawStore.listMessagesByOwner(USER_A.userId);
  assert.equal(unread.count, rows.filter((row) => row.read_at === null).length);
});

test('并发反例：挂起点交错（迟到者的检查发生在别人写入之前）⇒ 迟到者不得改写 read_at', async () => {
  const pause = makePausePoint();
  const h = makeHarness({
    storeWrapper: (base) => ({
      ...base,
      getMessage: async (id) => {
        await pause.pauseOnce();
        return base.getMessage(id);
      },
    }),
  });
  const created = await append(h.service, { owner_id: USER_A.userId, event_key: 'e-late' });

  pause.arm();
  const late = h.service.markMessageRead(USER_A, created.message.id, {
    idempotencyKey: idem(310),
    ifMatch: '"1"',
  });
  await pause.entered;
  // 迟到者已经读到"未读、revision=1"，但还没写；此时另一请求完整地完成标记。
  const winner = await h.service.markMessageRead(USER_A, created.message.id, {
    idempotencyKey: idem(311),
    ifMatch: '"1"',
  });
  assert.equal(typeof winner.read_at, 'string');
  pause.release();
  const latched = await late;
  assert.equal(typeof latched.read_at, 'string');
  assert.equal(latched.read_at, winner.read_at, '迟到者必须复用首次 read_at，不得改写');
  assert.equal(h.store.snapshotCounts().read_transitions, 1, '只有一次转换');
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 0);

  // 显式核对 CAS 原语本身：拿到旧期望值时必须拒绝写入并报 REVISION_CHANGED。
  const stale = await h.rawStore.markReadIfUnread(created.message.id, { revision: 99 }, '2026-10-12T09:00:00.000Z');
  assert.equal(typeof stale.ok, 'boolean');
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'REVISION_CHANGED');
  const afterStale = await h.rawStore.getMessage(created.message.id);
  assert.equal(afterStale.read_at, winner.read_at, '被拒的 CAS 不得改动 read_at');

  // 非接收者（他人）的期望值必须报 OWNER_CHANGED，且不得写入。
  const foreign = await h.rawStore.markReadIfUnread(
    created.message.id,
    { revision: 1, owner_id: USER_B.userId },
    '2026-10-12T09:30:00.000Z',
  );
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'OWNER_CHANGED');
  assert.equal((await h.rawStore.getMessage(created.message.id)).read_at, winner.read_at);
});

test('并发反例：同键同体并发 ⇒ 恰好一次生效（占位 + 有界等待 + 重放）且只写一次', async () => {
  // 屏障放在**查找台账**上：保证两条请求都先看到"台账里没有这个键"，再让其中一条去占位。
  // （不能放在 `getMessage` 上：同键的等待者根本不会进入 produce，会形成死等。）
  const barrier = makeBarrier(2);
  const h = makeHarness({
    storeWrapper: (base) => ({
      ...base,
      findIdempotency: async (scope, keyHash) => {
        const found = await base.findIdempotency(scope, keyHash);
        await barrier.wait();
        return found;
      },
    }),
  });
  const created = await append(h.service, { owner_id: USER_A.userId, event_key: 'e-same-key' });
  const options = { idempotencyKey: idem(320), ifMatch: '"1"' };

  barrier.arm();
  const settled = await Promise.allSettled([
    h.service.markMessageRead(USER_A, created.message.id, options),
    h.service.markMessageRead(USER_A, created.message.id, options),
  ]);
  assert.ok(barrier.arrived >= 2, '两条请求都必须先经过"查台账"这一步');
  const fulfilled = settled.filter((item) => item.status === 'fulfilled');
  const rejected = settled.filter((item) => item.status === 'rejected');
  assert.equal(rejected.length, 0, `同键并发不应报错：${rejected.map((item) => String(item.reason)).join(' / ')}`);
  assert.equal(fulfilled.length, 2, '同键并发必须都拿到结果（占位者 produce + 等待者重放）');
  assert.equal(fulfilled[0].value.read_at, fulfilled[1].value.read_at);
  assert.equal(h.store.snapshotCounts().read_transitions, 1, '同键并发只能有一次生效');
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 0);
});

test('并发反例：同键请求处理中 ⇒ 等待者有界等待后 409 REQUEST_IN_PROGRESS（不重复生效）', async () => {
  const pause = makePausePoint();
  const h = makeHarness({
    idempotencyWaitMs: 20,
    storeWrapper: (base) => ({
      ...base,
      getMessage: async (id) => {
        await pause.pauseOnce();
        return base.getMessage(id);
      },
    }),
  });
  const created = await append(h.service, { owner_id: USER_A.userId, event_key: 'e-in-progress' });
  const options = { idempotencyKey: idem(340), ifMatch: '"1"' };

  // 占位者：先 claim 占位，然后在"读记录"处挂住（模拟处理中）。
  pause.arm();
  const occupier = h.service.markMessageRead(USER_A, created.message.id, options);
  await pause.entered;

  // 等待者：同键 ⇒ 有界等待超时 ⇒ 409，而不是重复执行 produce。
  const waiter = await captureError(() => h.service.markMessageRead(USER_A, created.message.id, options));
  assertApiErrorShape(waiter, 'REQUEST_IN_PROGRESS', 409);
  assert.equal(h.store.snapshotCounts().read_transitions, 0, '等待超时期间不得产生写入');

  pause.release();
  const done = await occupier;
  assert.equal(typeof done.read_at, 'string');
  assert.equal(h.store.snapshotCounts().read_transitions, 1, '最终只生效一次');
});

test('并发反例：同键异体 ⇒ 一方 IDEMPOTENCY_CONFLICT（409），不得重复生效', async () => {
  const h = makeHarness();
  const created = await append(h.service, { owner_id: USER_A.userId, event_key: 'e-same-key-diff' });
  const key = idem(330);
  const first = await h.service.markMessageRead(USER_A, created.message.id, { idempotencyKey: key, ifMatch: '"1"' });
  assert.equal(typeof first.read_at, 'string');
  const conflict = await captureError(() =>
    h.service.markMessageRead(USER_A, created.message.id, { idempotencyKey: key, ifMatch: '"4"' }),
  );
  assertApiErrorShape(conflict, 'IDEMPOTENCY_CONFLICT', 409);
  assert.equal(h.store.snapshotCounts().read_transitions, 1);
});

test('并发反例：并发创建同一 event_key ⇒ 恰好一条消息（同键并发只生效一次）', async () => {
  const h = makeHarness();
  const settled = await Promise.allSettled([
    append(h.service, { owner_id: USER_A.userId, event_key: 'moderation:m1:r1' }),
    append(h.service, { owner_id: USER_A.userId, event_key: 'moderation:m1:r1' }),
    append(h.service, { owner_id: USER_A.userId, event_key: 'moderation:m1:r1' }),
  ]);
  const values = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
  assert.equal(values.length, 3, '并发创建都必须有结果（命中去重者回读既有记录）');
  assert.equal(values.filter((value) => value.created === true).length, 1, '恰好一次创建生效');
  assert.equal(new Set(values.map((value) => value.message.id)).size, 1, '三条结果必须是同一条消息');
  assert.equal(h.store.snapshotCounts().messages, 1);
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 1, '只应产生一条未读');
});

test('单调性：批量并发标记/重复标记后，未读数只减不增且等于派生值（无漂移）', async () => {
  const h = makeHarness();
  const ids = [];
  for (let index = 0; index < 5; index += 1) {
    const created = await append(h.service, { owner_id: USER_A.userId, event_key: `e-batch-${index}` });
    ids.push(created.message.id);
  }
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 5);

  // 第一轮：每条消息各标一次（并发）。
  await Promise.all(
    ids.map((id, index) =>
      h.service.markMessageRead(USER_A, id, { idempotencyKey: idem(400 + index), ifMatch: '"1"' }),
    ),
  );
  assert.equal(h.store.snapshotCounts().read_transitions, 5);
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 0);

  // 第二轮：全部再标一次（并发、新幂等键）⇒ 未读仍为 0，转换次数仍为 5（单调 + 幂等）。
  await Promise.all(
    ids.map((id, index) =>
      h.service.markMessageRead(USER_A, id, { idempotencyKey: idem(500 + index), ifMatch: '"1"' }),
    ),
  );
  const counts = h.store.snapshotCounts();
  assert.equal(counts.read_transitions, 5, '重复标记不得新增转换');
  const unread = await h.service.getUnreadCount(USER_A);
  assert.equal(unread.count, 0);
  const rows = await h.rawStore.listMessagesByOwner(USER_A.userId);
  assert.equal(rows.filter((row) => row.read_at === null).length, 0);
  assert.equal(
    rows.filter((row) => typeof row.read_at === 'string').length,
    5,
    '五条都必须有 read_at（一次都没漏）',
  );
});
