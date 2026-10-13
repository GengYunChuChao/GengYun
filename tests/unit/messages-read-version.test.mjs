/**
 * GY-I17（#17）阶段 1 · **返修 1**：首次读转换必须推进 `revision`（回应监工 `8dc8eecd`/`8dc2eecd` 批复）。
 *
 * 冻结依据（`docs/architecture/state-contract.md` 第 15 行，逐字引文见证据文档 §12）：
 *   「GET 条目带强 ETag `"<revision>"`；版本整数自1递增，PATCH/DELETE/取消以及 OpenAPI 标注的
 *     创建要求 `If-Match`，缺失428，不匹配409，不做 last-write-wins。」
 *
 * 本文件把监工要求的五类回归**各自独立**落成用例：
 *   ① 首次标记 ⇒ `revision` +1 且 `ETag` 随之变化；
 *   ② 重复标记（新键 + **当前** ETag）⇒ `revision` 不变、`read_at` 不变、未读为 0；
 *   ③ 用**旧 ETag** 做第二次标记 ⇒ 409（不得静默通过），且不改动存储；
 *   ④ 并发两条首次标记同一消息 ⇒ **恰好一次版本推进**、未读只减一次
 *      （含"同键并发 ⇒ 两响应 read_at 相同"与"异键并发 ⇒ 一方 409"两种交错）；
 *   ⑤ 同键同体重放 ⇒ 幂等，且**回放当前 ETag**。
 *
 * 断言一律先判 `typeof`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  USER_A,
  append,
  assertApiErrorShape,
  captureError,
  errorEnvelopeJson,
  idem,
  makeBarrier,
  makeHarness,
  strongEtagOf,
} from './messages-fixtures.mjs';

test('回归①：首次标记 ⇒ revision 恰好 +1，且强 ETag 随资源状态变化', async () => {
  const h = makeHarness();
  const created = await append(h.service, { owner_id: USER_A.userId, event_key: 'v-first' });
  assert.equal(created.message.revision, 1, '创建时 revision 自 1 起');
  assert.equal(created.message.read_at, null);
  const etagBefore = strongEtagOf(created.message.revision);
  assert.equal(typeof etagBefore, 'string');
  assert.equal(etagBefore, '"1"');
  assert.match(etagBefore, /^"[1-9][0-9]*"$/, '必须与契约 If-Match 的 pattern 同形');

  // 未读时用当前 ETag 正常标记。
  const marked = await h.service.markMessageRead(USER_A, created.message.id, {
    idempotencyKey: idem(701),
    ifMatch: etagBefore,
  });
  assert.equal(typeof marked.revision, 'number');
  assert.equal(marked.revision, 2, '首次读转换必须推进 revision（自 1 递增）');
  assert.equal(typeof marked.read_at, 'string');
  const etagAfter = strongEtagOf(marked.revision);
  assert.equal(etagAfter, '"2"');
  assert.notEqual(etagAfter, etagBefore, '不同资源状态不得共用同一强 ETag');

  // 存储里的版本也必须同步推进（不是只在响应里改）。
  const stored = await h.rawStore.getMessage(created.message.id);
  assert.equal(stored.revision, 2);
  assert.equal(typeof stored.read_at, 'string');
  assert.equal(h.store.snapshotCounts().read_transitions, 1, '一次转换 = 一次版本推进');
});

test('回归②：重复标记（新键 + 当前 ETag）⇒ revision 不变、read_at 不变、未读为 0', async () => {
  const h = makeHarness();
  const created = await append(h.service, { owner_id: USER_A.userId, event_key: 'v-repeat' });
  const first = await h.service.markMessageRead(USER_A, created.message.id, {
    idempotencyKey: idem(710),
    ifMatch: '"1"',
  });
  assert.equal(first.revision, 2);
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 0);

  // 新幂等键 + 当前 ETag ⇒ 空操作（不是 409，也不是再次推进版本）。
  const repeat = await h.service.markMessageRead(USER_A, created.message.id, {
    idempotencyKey: idem(711),
    ifMatch: strongEtagOf(first.revision),
  });
  assert.equal(repeat.revision, 2, '重复标记不得推进版本');
  assert.equal(repeat.read_at, first.read_at, '重复标记不得改首次 read_at');
  assert.equal(repeat.id, first.id);
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 0);
  assert.equal(h.store.snapshotCounts().read_transitions, 1, '不得发生第二次转换/推进');
  // 再来一次（第三个键）同样空操作。
  const repeatAgain = await h.service.markMessageRead(USER_A, created.message.id, {
    idempotencyKey: idem(712),
    ifMatch: strongEtagOf(repeat.revision),
  });
  assert.equal(repeatAgain.revision, 2);
  assert.equal(repeatAgain.read_at, first.read_at);
  assert.equal(h.store.snapshotCounts().read_transitions, 1);
});

test('回归③：用旧 ETag 做第二次标记 ⇒ 409 REVISION_CONFLICT，且不得改动存储', async () => {
  const h = makeHarness();
  const created = await append(h.service, { owner_id: USER_A.userId, event_key: 'v-stale' });
  const marked = await h.service.markMessageRead(USER_A, created.message.id, {
    idempotencyKey: idem(720),
    ifMatch: '"1"',
  });
  assert.equal(marked.revision, 2);

  // 旧 ETag（"1"）在首次标记后就不再匹配 ⇒ 必须 409，不得静默通过、不得当作空操作。
  const stale = await captureError(() =>
    h.service.markMessageRead(USER_A, created.message.id, { idempotencyKey: idem(721), ifMatch: '"1"' }),
  );
  assertApiErrorShape(stale, 'REVISION_CONFLICT', 409);

  const stored = await h.rawStore.getMessage(created.message.id);
  assert.equal(stored.revision, 2, '被拒请求不得改动版本');
  assert.equal(stored.read_at, marked.read_at, '被拒请求不得改动 read_at');
  assert.equal(h.store.snapshotCounts().read_transitions, 1);
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 0);
});

test('回归④a：并发两条首次标记（同幂等键）⇒ 恰好一次版本推进、两响应 read_at 与 ETag 相同', async () => {
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
  const created = await append(h.service, { owner_id: USER_A.userId, event_key: 'v-race-same' });
  const options = { idempotencyKey: idem(730), ifMatch: '"1"' };

  barrier.arm();
  const settled = await Promise.allSettled([
    h.service.markMessageRead(USER_A, created.message.id, options),
    h.service.markMessageRead(USER_A, created.message.id, options),
  ]);
  assert.ok(barrier.arrived >= 2, '两条请求都必须先经过"查台账"');
  const fulfilled = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
  const rejected = settled.filter((item) => item.status === 'rejected');
  assert.equal(rejected.length, 0, `同键并发不应报错：${rejected.map((item) => String(item.reason)).join(' / ')}`);
  assert.equal(fulfilled.length, 2);
  assert.equal(typeof fulfilled[0].revision, 'number');
  assert.equal(fulfilled[0].revision, 2, '恰好一次版本推进');
  assert.equal(fulfilled[1].revision, 2);
  assert.equal(typeof fulfilled[0].read_at, 'string');
  assert.equal(fulfilled[0].read_at, fulfilled[1].read_at, '两响应 read_at 必须相同');
  assert.equal(strongEtagOf(fulfilled[0].revision), strongEtagOf(fulfilled[1].revision), '两响应 ETag 相同');
  assert.equal(h.store.snapshotCounts().read_transitions, 1, '未读只减一次');
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 0);
  const stored = await h.rawStore.getMessage(created.message.id);
  assert.equal(stored.revision, 2, '最终版本只 +1（不是 3）');
});

test('回归④b：并发两条首次标记（不同幂等键、都带当前 ETag "1"）⇒ 恰好一次推进，落败方 409', async () => {
  const barrier = makeBarrier(2);
  const h = makeHarness({
    storeWrapper: (base) => ({
      ...base,
      getMessage: async (id) => {
        const record = await base.getMessage(id);
        await barrier.wait();
        return record;
      },
    }),
  });
  const created = await append(h.service, { owner_id: USER_A.userId, event_key: 'v-race-diff' });

  barrier.arm();
  const settled = await Promise.allSettled([
    h.service.markMessageRead(USER_A, created.message.id, { idempotencyKey: idem(740), ifMatch: '"1"' }),
    h.service.markMessageRead(USER_A, created.message.id, { idempotencyKey: idem(741), ifMatch: '"1"' }),
  ]);
  assert.equal(barrier.arrived, 2, '两条请求都必须先读到"未读、revision=1"');
  const fulfilled = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
  const rejected = settled.filter((item) => item.status === 'rejected').map((item) => item.reason);
  assert.equal(fulfilled.length, 1, '版本语义下只应有一个请求真正转换成功');
  assert.equal(rejected.length, 1, '另一个携带已失效 ETag，必须 409（不得静默通过）');
  assertApiErrorShape(rejected[0], 'REVISION_CONFLICT', 409);
  assert.equal(fulfilled[0].revision, 2, '恰好一次版本推进');
  assert.equal(h.store.snapshotCounts().read_transitions, 1, '未读只减一次');
  assert.equal((await h.service.getUnreadCount(USER_A)).count, 0);
  const stored = await h.rawStore.getMessage(created.message.id);
  assert.equal(stored.revision, 2, '落败方不得再推进一次版本（不能是 3）');
  assert.equal(stored.read_at, fulfilled[0].read_at, '落败方不得改写首次 read_at');
});

test('回归④b 附证：落败方的请求形状与"用旧 ETag 的第二次标记"完全同形 ⇒ 规则上不可区分', async () => {
  // 两条独立消息，分别制造"并发落败方"与"顺序用旧 ETag 重试"两种情形。
  const h = makeHarness();
  const raced = await append(h.service, { owner_id: USER_A.userId, event_key: 'shape-race' });
  const sequential = await append(h.service, { owner_id: USER_A.userId, event_key: 'shape-seq' });

  // 两边的"第一次标记"都成功（都把 revision 推到 2）。
  const winner = await h.service.markMessageRead(USER_A, raced.message.id, {
    idempotencyKey: idem(750),
    ifMatch: '"1"',
  });
  assert.equal(winner.revision, 2);
  const first = await h.service.markMessageRead(USER_A, sequential.message.id, {
    idempotencyKey: idem(751),
    ifMatch: '"1"',
  });
  assert.equal(first.revision, 2);

  // 此刻两条消息的可观测状态完全相同：{revision: 2, read_at: 有值}；
  // 两边随后的请求也完全相同：{ifMatch: "1"}（只有幂等键不同，而幂等键只用于重试合并，
  // 不是状态选择器）⇒ 任何"让并发落败方成功"的规则都会同时让"旧 ETag 重试"成功。
  const afterRace = await h.rawStore.getMessage(raced.message.id);
  const afterSeq = await h.rawStore.getMessage(sequential.message.id);
  assert.equal(afterRace.revision, afterSeq.revision);
  assert.equal(typeof afterRace.read_at, 'string');
  assert.equal(typeof afterSeq.read_at, 'string');

  const loserShape = await captureError(() =>
    h.service.markMessageRead(USER_A, raced.message.id, { idempotencyKey: idem(752), ifMatch: '"1"' }),
  );
  const staleShape = await captureError(() =>
    h.service.markMessageRead(USER_A, sequential.message.id, { idempotencyKey: idem(753), ifMatch: '"1"' }),
  );
  assertApiErrorShape(loserShape, 'REVISION_CONFLICT', 409);
  assertApiErrorShape(staleShape, 'REVISION_CONFLICT', 409);
  // 同一 request_id 下两份错误封套逐字节相同 ⇒ 系统对这两种情形给出**同一个**可观测结果。
  assert.equal(errorEnvelopeJson(loserShape), errorEnvelopeJson(staleShape));
});

test('回归⑤：同键同体重放 ⇒ 幂等，且回放**当前** ETag（不是首次响应的快照）', async () => {
  const h = makeHarness();
  const created = await append(h.service, { owner_id: USER_A.userId, event_key: 'v-replay' });
  const options = { idempotencyKey: idem(760), ifMatch: '"1"' };
  const first = await h.service.markMessageRead(USER_A, created.message.id, options);
  assert.equal(first.revision, 2);

  const replay = await h.service.markMessageRead(USER_A, created.message.id, options);
  assert.equal(replay.id, first.id);
  assert.equal(replay.read_at, first.read_at);
  assert.equal(replay.revision, 2, '重放必须反映当前版本');
  assert.equal(strongEtagOf(replay.revision), strongEtagOf(first.revision));
  assert.equal(h.store.snapshotCounts().read_transitions, 1, '重放不得产生第二次转换');

  // 重放返回的 ETag 必须是**当前**ETag：用它（而不是别的值）能直接通过下一次 If-Match 校验。
  const afterReplay = await h.service.markMessageRead(USER_A, created.message.id, {
    idempotencyKey: idem(761),
    ifMatch: strongEtagOf(replay.revision),
  });
  assert.equal(afterReplay.revision, 2);
  assert.equal(afterReplay.read_at, first.read_at);
});
