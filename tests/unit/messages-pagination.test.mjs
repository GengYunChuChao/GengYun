/**
 * GY-I17（#17）阶段 1 · 分页游标反例：同刻多条不漏不重、items ≤ 50、
 * 游标验签/绑定主体/过滤/排序/有效期、翻页期间插入不产生重复。
 *
 * 契约：`MessagePage.items`（`maxItems:50`）+ `next_cursor`（string 1..2048 或 null）；
 * `Cursor`/`Limit` 参数；排序口径 `(created_at DESC, id DESC)`。
 * 断言一律先判 `typeof`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  USER_A,
  USER_B,
  append,
  assertApiErrorShape,
  captureError,
  makeHarness,
  scriptedClock,
  TEST_SIGNING_KEY,
} from './messages-fixtures.mjs';

/** 用同一把测试签名密钥"伪造"一个结构合法但语义不同的游标（白盒：验证逐项绑定校验）。 */
function craftCursor(payload, key = TEST_SIGNING_KEY) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${signature}`;
}

const FIXED_MS = Date.UTC(2026, 9, 12, 3, 0, 0);
const validAfter = { created_at: new Date(FIXED_MS).toISOString(), id: '00000000-0000-4000-8100-000000000000' };

async function seed(service, count, eventPrefix = 'evt') {
  for (let index = 0; index < count; index += 1) {
    await append(service, { owner_id: USER_A.userId, event_key: `${eventPrefix}-${index}` });
  }
}

test('反例·分页：同刻 5 条（created_at 全等）limit=2 翻完 ⇒ 不漏不重', async () => {
  const h = makeHarness({ now: () => new Date(FIXED_MS) });
  await seed(h.service, 5, 'same-instant');
  const all = await h.store.listMessagesByOwner(USER_A.userId);
  assert.equal(all.length, 5);
  // 前提校验：确实"同刻"（这才是需要用 id 兜底全序的场景）。
  assert.equal(new Set(all.map((row) => row.created_at)).size, 1, '前提：五条消息 created_at 必须全等');

  const seen = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const page = await h.service.listMessages(USER_A, { limit: 2, cursor });
    assert.equal(Array.isArray(page.items), true);
    assert.ok(page.items.length <= 2, 'items 不得超过 limit');
    for (const item of page.items) {
      assert.equal(typeof item.id, 'string');
      assert.equal(typeof item.created_at, 'string');
      seen.push(item.id);
    }
    pages += 1;
    if (page.next_cursor === null) break;
    assert.equal(typeof page.next_cursor, 'string');
    cursor = page.next_cursor;
    assert.ok(pages < 10, '游标不得形成死循环');
  }
  assert.equal(pages, 3, '5 条 / 每页 2 条 ⇒ 3 页');
  assert.equal(seen.length, 5, '必须恰好取到 5 条（不漏）');
  assert.equal(new Set(seen).size, 5, '不得重复（同刻多条靠 id 全序兜底）');
  assert.deepEqual([...seen].sort(), [...all.map((row) => row.id)].sort());
  // 同刻时按 id DESC：后创建的 id 更大 ⇒ 先出现。
  assert.deepEqual(seen, [...seen].sort().reverse());
});

test('反例·分页：items ≤ 50 且分页在 60 条上不漏不重（limit=7）', async () => {
  const h = makeHarness();
  await seed(h.service, 60, 'many');
  const first = await h.service.listMessages(USER_A, { limit: 50 });
  assert.equal(first.items.length, 50, 'items 不得超过契约 maxItems:50');
  assert.equal(typeof first.next_cursor, 'string', '还有剩余 ⇒ 必须给出游标');

  const seen = [];
  let cursor = null;
  for (;;) {
    const page = await h.service.listMessages(USER_A, { limit: 50, cursor });
    assert.ok(page.items.length <= 50);
    for (const item of page.items) seen.push(item.id);
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
  }
  assert.equal(seen.length, 60, 'limit=50 翻完必须恰好 60 条');

  const seen7 = [];
  cursor = null;
  for (;;) {
    const page = await h.service.listMessages(USER_A, { limit: 7, cursor });
    assert.ok(page.items.length <= 7);
    for (const item of page.items) seen7.push(item.id);
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
  }
  assert.equal(seen7.length, 60, 'limit=7 翻完必须恰好 60 条');
  assert.equal(new Set(seen7).size, 60, '不得重复');
  assert.deepEqual(seen7, seen, '不同 limit 必须得到同一顺序');
});

test('反例·分页：翻页期间新消息插入 ⇒ 既有快照不漏不重（新消息不在旧游标窗口内）', async () => {
  const h = makeHarness();
  await seed(h.service, 5, 'snap');
  const page1 = await h.service.listMessages(USER_A, { limit: 3 });
  assert.equal(page1.items.length, 3);
  const cursor = page1.next_cursor;
  assert.equal(typeof cursor, 'string');

  // 翻页途中来了一条更新的消息（created_at 更晚 ⇒ 落在游标"之前"的窗口外）。
  await append(h.service, { owner_id: USER_A.userId, event_key: 'snap-new' });

  const page2 = await h.service.listMessages(USER_A, { limit: 3, cursor });
  const ids = [...page1.items.map((item) => item.id), ...page2.items.map((item) => item.id)];
  assert.equal(page2.items.length, 2, '游标窗口内只剩原有的 2 条');
  assert.equal(new Set(ids).size, ids.length, '游标翻页不得产生重复');
  const stored = await h.store.listMessagesByOwner(USER_A.userId);
  assert.equal(stored.length, 6, '新消息确实已入库');
  assert.equal(
    ids.every((id) => stored.some((row) => row.id === id)),
    true,
  );
  // 新消息会出现在**新开的第一页**（不依赖旧游标），这条保证它不会被永久丢掉。
  const fresh = await h.service.listMessages(USER_A, { limit: 50 });
  assert.equal(fresh.items.length, 6);
  assert.equal(fresh.items[0].created_at >= page1.items[0].created_at, true);
});

test('反例·游标：篡改签名 / 非本路由 / 换主体 / 换排序 / 换过滤 / 过期 / 结构非法 ⇒ 400 INVALID_CURSOR', async () => {
  const clock = scriptedClock(FIXED_MS);
  const h = makeHarness({ now: clock.now });
  await seed(h.service, 3, 'cursor');
  const page = await h.service.listMessages(USER_A, { limit: 1 });
  const good = page.next_cursor;
  assert.equal(typeof good, 'string');

  const base = {
    kind: 'messages',
    subject: USER_A.userId,
    route: 'messages',
    filter: {},
    sort: 'created_at_desc',
    after: validAfter,
    expires: clock.ms + 60_000,
  };
  const badCursors = [
    ['篡改签名（改一位）', `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`],
    ['其它密钥签名', craftCursor(base, 'another-key')],
    ['非本路由 kind', craftCursor({ ...base, kind: 'audit' })],
    ['换主体（别人的游标）', craftCursor({ ...base, subject: USER_B.userId })],
    ['换排序', craftCursor({ ...base, sort: 'created_at_asc' })],
    ['换过滤', craftCursor({ ...base, filter: { crop_id: 'x' } })],
    ['已过期', craftCursor({ ...base, expires: clock.ms - 1 })],
    ['after 结构非法', craftCursor({ ...base, after: { created_at: 1, id: 'x' } })],
    ['非 JSON 体（签名正确）', `${Buffer.from('not-json', 'utf8').toString('base64url')}.${createHmac('sha256', TEST_SIGNING_KEY).update(Buffer.from('not-json', 'utf8').toString('base64url')).digest('base64url')}`],
    ['没有分隔点', 'nodothere'],
    ['空体加点', '.sig'],
    ['乱串', 'abc'],
  ];
  for (const [label, cursor] of badCursors) {
    const error = await captureError(() => h.service.listMessages(USER_A, { limit: 1, cursor }));
    assertApiErrorShape(error, 'INVALID_CURSOR', 400);
    assert.equal(error.status, 400, `${label}：应为 400`);
  }

  // 真正过期：把时钟推过 15 分钟有效期。
  clock.advance(16 * 60 * 1000);
  const expired = await captureError(() => h.service.listMessages(USER_A, { limit: 1, cursor: good }));
  assertApiErrorShape(expired, 'INVALID_CURSOR', 400);

  // 正控制：同一个游标在有效期内可以正常翻页。
  const freshClock = scriptedClock(FIXED_MS);
  const h2 = makeHarness({ now: freshClock.now });
  await seed(h2.service, 3, 'cursor-ok');
  const first = await h2.service.listMessages(USER_A, { limit: 1 });
  const second = await h2.service.listMessages(USER_A, { limit: 1, cursor: first.next_cursor });
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0].id, first.items[0].id, '第二页必须与第一页不同');
});
