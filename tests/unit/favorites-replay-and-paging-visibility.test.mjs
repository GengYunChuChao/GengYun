// 收藏：**读取时语义**在「幂等重放」与「游标签页」两条路径上的补测（GY-I16 / issue #16）。
//
// 为什么单开一个文件：既有 `favorites-http.test.mjs` 已经断言
//   * 同目标换新键重复收藏 ⇒ 同一行（不产生第二行）；
//   * 同键异体（换目标）创建 ⇒ 409 IDEMPOTENCY_CONFLICT；
//   * 成功取消后**换新键**用旧 ETag 重放 ⇒ 404（不复活）；
// 但下面四件事在本片开工前的仓库里**没有断言**（只有注释与服务层实现）：
//   1) 取消收藏**同键重放** ⇒ 200 `{accepted:true}`（即「重复取消不报错」，不是 404/409）；
//   2) 取消收藏**同键异体**（If-Match 变了）⇒ 409 IDEMPOTENCY_CONFLICT，且不污染台账；
//   3) 幂等重放**重新派生**当前可见性（不回放旧结论）：目标隐藏后重放不得再回 `available`；
//   4) 游标翻页的**每一页**都按当前可见性重新判定（第二页不携带第一页的旧结论）。
// 这四条正是验收里「去重语义」「失效不得复活」「读时权限重查」在服务端最容易被缓存打穿的三处。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { makeControllableVisibility, scriptedClock } from './favorites-history-fixtures.mjs';

const START = Date.UTC(2026, 9, 14, 10);
const FAVORITES = '/api/v1/favorites';

async function fixture(t) {
  const clock = scriptedClock(START);
  const auth = createMemoryAuthStore();
  // 可见性端口用「测试替身」：可用性集合由用例控制（**不是**真实可见性核验实现），
  // 这样才能在同一进程里让同一目标先可见、再隐藏，并在每次读取上观察是否重新核验。
  const visibility = makeControllableVisibility();
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: auth,
    now: clock.now,
    favoritesInjection: { visibility: visibility.port },
  });
  async function account(subject) {
    const user = await auth.createUser(subject.repeat(64));
    const token = `synthetic-i16-replay-${subject}`;
    await auth.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(START + 48 * 3600_000),
      audience: 'user',
    });
    return { user, token };
  }
  const a = await account('a');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());

  async function call(method, path, extra = {}) {
    const headers = {
      authorization: `Bearer ${a.token}`,
      ...(extra.payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(extra.headers ?? {}),
    };
    const response = await fetch(base + path, {
      method,
      headers,
      ...(extra.payload === undefined ? {} : { body: JSON.stringify(extra.payload) }),
    });
    return {
      status: response.status,
      body: await response.json(),
      etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'),
    };
  }
  return { app, clock, a, visibility, call };
}

function target(type, id, revision = 1) {
  return { target_ref: { type, id, revision } };
}

function createRequest(id, key) {
  return {
    method: 'POST',
    path: FAVORITES,
    payload: target('species', id),
    headers: { 'idempotency-key': key },
  };
}

test('取消收藏：同键重放 ⇒ 200 accepted（重复取消不报错），异键 ⇒ 404，且不留墓碑', async (t) => {
  const h = await fixture(t);
  h.visibility.show('species', 'spc-replay-1');
  const created = await h.call('POST', FAVORITES, createRequest('spc-replay-1', 'fav-replay-create-0001'));
  assert.equal(created.status, 201);
  const id = created.body.data.id;

  // 首次取消：200 Ack。
  const first = await h.call('DELETE', `${FAVORITES}/${id}`, {
    headers: { 'idempotency-key': 'fav-replay-delete-0001', 'if-match': '"1"' },
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.data, { accepted: true });
  assert.equal(first.cache, 'no-store');

  // 同键同体重放（真机断网重试的形态）：**必须**是 200 Ack，不是 404（行已删）也不是 409。
  const replay = await h.call('DELETE', `${FAVORITES}/${id}`, {
    headers: { 'idempotency-key': 'fav-replay-delete-0001', 'if-match': '"1"' },
  });
  assert.equal(replay.status, 200, '重复取消不得报错');
  assert.deepEqual(replay.body.data, { accepted: true });
  assert.equal(replay.cache, 'no-store');

  // 第三次仍然幂等（不是只回放一次）。
  const third = await h.call('DELETE', `${FAVORITES}/${id}`, {
    headers: { 'idempotency-key': 'fav-replay-delete-0001', 'if-match': '"1"' },
  });
  assert.equal(third.status, 200);
  assert.deepEqual(third.body.data, { accepted: true });

  // 换新键再删同一 id：行已物理删除 ⇒ 404 NOT_FOUND（与"从来没存在过"同形）。
  const otherKey = await h.call('DELETE', `${FAVORITES}/${id}`, {
    headers: { 'idempotency-key': 'fav-replay-delete-0002', 'if-match': '"1"' },
  });
  assert.equal(otherKey.status, 404);
  assert.equal(otherKey.body.error.code, 'NOT_FOUND');

  // 不产生墓碑/第二行：列表连续两次为空（幂等重放与 404 都不得把它"恢复"成一行）。
  assert.deepEqual((await h.call('GET', FAVORITES)).body.data, { items: [], next_cursor: null });
  assert.deepEqual((await h.call('GET', FAVORITES)).body.data, { items: [], next_cursor: null });

  // 取消后重新收藏：**新 id**（旧行不复活、也不与旧幂等台账串味）。
  const again = await h.call('POST', FAVORITES, createRequest('spc-replay-1', 'fav-replay-create-0002'));
  assert.equal(again.status, 201);
  assert.notEqual(again.body.data.id, id);
  assert.equal(again.body.data.reference_state, 'available');
  assert.equal((await h.call('GET', FAVORITES)).body.data.items.length, 1);
});

test('取消收藏：同键异体（If-Match 变了）⇒ 409 IDEMPOTENCY_CONFLICT，且台账不被污染', async (t) => {
  const h = await fixture(t);
  h.visibility.show('species', 'spc-replay-2');
  const id = (await h.call('POST', FAVORITES, createRequest('spc-replay-2', 'fav-replay2-create-0001'))).body.data.id;

  const removed = await h.call('DELETE', `${FAVORITES}/${id}`, {
    headers: { 'idempotency-key': 'fav-replay2-delete-0001', 'if-match': '"1"' },
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.data, { accepted: true });

  // 同一个幂等键换了一份请求内容（If-Match 不同）⇒ 409，绝不把第一次的 200 套到第二份请求上。
  const conflict = await h.call('DELETE', `${FAVORITES}/${id}`, {
    headers: { 'idempotency-key': 'fav-replay2-delete-0001', 'if-match': '"2"' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  // 冲突**不得**破坏原台账：原键 + 原 If-Match 仍然回 200 Ack。
  const stillReplay = await h.call('DELETE', `${FAVORITES}/${id}`, {
    headers: { 'idempotency-key': 'fav-replay2-delete-0001', 'if-match': '"1"' },
  });
  assert.equal(stillReplay.status, 200);
  assert.deepEqual(stillReplay.body.data, { accepted: true });
  assert.deepEqual((await h.call('GET', FAVORITES)).body.data, { items: [], next_cursor: null });
});

test('收藏创建：幂等重放重新派生可见性，不回放旧结论（隐藏后重放必须是 unavailable）', async (t) => {
  const h = await fixture(t);
  h.visibility.show('species', 'spc-replay-3');
  const request = createRequest('spc-replay-3', 'fav-replay3-create-0001');

  const created = await h.call('POST', FAVORITES, request);
  assert.equal(created.status, 201);
  assert.equal(created.body.data.reference_state, 'available');
  assert.equal(created.body.data.unavailable_reason, null);
  const callsAfterCreate = h.visibility.calls.length;
  assert.equal(callsAfterCreate >= 1, true, '创建响应必须先核验一次可见性');

  // 目标被下架/隐藏：同键同体重放**不得**回放创建时那份 available。
  h.visibility.hide('species', 'spc-replay-3');
  const replayed = await h.call('POST', FAVORITES, request);
  assert.equal(h.visibility.calls.length > callsAfterCreate, true, '重放必须重新核验（不得命中缓存）');
  assert.equal(replayed.body.data.id, created.body.data.id, '重放仍是同一行');
  assert.equal(replayed.body.data.created_at, created.body.data.created_at);
  assert.equal(replayed.body.data.reference_state, 'unavailable');
  assert.equal(typeof replayed.body.data.unavailable_reason, 'string');
  assert.equal(replayed.body.data.unavailable_reason.length > 0, true);

  // 目标重新可用：重放同样如实恢复 —— 证明这是"当前真值"，而不是恒 unavailable 的假安全。
  h.visibility.show('species', 'spc-replay-3');
  const back = await h.call('POST', FAVORITES, request);
  assert.equal(back.body.data.id, created.body.data.id);
  assert.equal(back.body.data.reference_state, 'available');
  assert.equal(back.body.data.unavailable_reason, null);
});

test('收藏列表：游标翻到第二页时同样按当前可见性重新判定（第一页的结论不被携带）', async (t) => {
  const h = await fixture(t);
  const ids = ['spc-page-1', 'spc-page-2', 'spc-page-3'];
  for (const id of ids) h.visibility.show('species', id);
  for (const [index, id] of ids.entries()) {
    h.clock.advance(1000);
    const created = await h.call('POST', FAVORITES, createRequest(id, `fav-page-create-000${index + 1}`));
    assert.equal(created.status, 201);
    assert.equal(created.body.data.reference_state, 'available');
  }

  // 先如实读一遍两页，确定服务端的分页落点（不假设排序方向）。
  const page1 = await h.call('GET', `${FAVORITES}?limit=2`);
  assert.equal(page1.body.data.items.length, 2);
  const cursor = page1.body.data.next_cursor;
  assert.equal(typeof cursor, 'string');
  const page2 = await h.call('GET', `${FAVORITES}?limit=2&cursor=${encodeURIComponent(cursor)}`);
  assert.equal(page2.body.data.items.length, 1);
  const seen = new Set([...page1.body.data.items, ...page2.body.data.items].map((item) => item.id));
  assert.equal(seen.size, 3, '两页合起来恰为三行，不重不漏');

  // 三个目标全部下架/隐藏：**每一页**都要按当前可见性重新判定。
  for (const id of ids) h.visibility.hide('species', id);
  const callsBefore = h.visibility.calls.length;

  const stalePage1 = await h.call('GET', `${FAVORITES}?limit=2`);
  const stalePage2 = await h.call('GET', `${FAVORITES}?limit=2&cursor=${encodeURIComponent(cursor)}`);
  assert.equal(h.visibility.calls.length > callsBefore, true, '每次读取都必须重新核验');
  for (const page of [stalePage1, stalePage2]) {
    assert.equal(page.status, 200, '可见性变化不得让游标失效（游标只绑定位置，不绑定可行性结论）');
    for (const item of page.body.data.items) {
      assert.equal(item.reference_state, 'unavailable', `目标已隐藏：${item.target_ref.id}`);
      assert.equal(typeof item.unavailable_reason, 'string');
    }
  }
  assert.equal(stalePage1.body.data.items.length + stalePage2.body.data.items.length, 3, '行仍在（不是被删）');

  // 逐个恢复：只恢复一个目标，只有它那一行回到 available（恢复是真值，不是缓存复活）。
  h.visibility.show('species', ids[0]);
  const restored = [
    ...(await h.call('GET', `${FAVORITES}?limit=2`)).body.data.items,
    ...(await h.call('GET', `${FAVORITES}?limit=2&cursor=${encodeURIComponent(cursor)}`)).body.data.items,
  ];
  const available = restored.filter((item) => item.reference_state === 'available');
  assert.equal(available.length, 1);
  assert.equal(available[0].target_ref.id, ids[0]);
});
