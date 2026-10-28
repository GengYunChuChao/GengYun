// GY-I16/#28 收藏页：旧响应隔离（合成 wx／可控 Promise；**不是**真机或微信工具证据）。
//
// 复现的缺口：`loadFavorites`／`loadTargets` 的成功与失败回调没有页面代次保护，
// `pageGate.cancel` 只取消门禁，同会话的旧页面请求仍会落地。R1 在飞 → onHide → onShow
// 发 R2 → R2 先成功 → R1 旧成功/失败晚到，会把旧列表、旧 targets、busy/error 写回新一轮，
// 或触发基于旧 items 的 reconcileTargets。
//
// 本文件只证明页面数据层：旧回调在产生任何 setData／reconcile 之前被丢弃；
// 新刷新/重进正常完成；正常分页与 targets 协调不受影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const FAVORITES_PAGE = root + '/miniprogram/pages/favorites/favorites.js';
const UUID_A = '00000000-0000-4000-8a00-000000000001';
const UUID_B = '00000000-0000-4000-8b00-000000000002';
const TARGET = '11111111-1111-4111-8111-111111111111';
const OLD_TARGET = '22222222-2222-4222-8222-222222222222';
const future = () => new Date(Date.now() + 3600_000).toISOString();
const flush = () => new Promise((r) => setImmediate(r));

function fixture() {
  const requests = [];
  const storage = new Map();
  const sets = [];
  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    request: (o) => requests.push(o),
    showModal: (o) => o.success({ confirm: true }),
    navigateTo: () => {},
    navigateBack: () => {},
    redirectTo: () => {},
    reLaunch: () => {},
    switchTab: () => {},
    setClipboardData: () => {},
    showToast: () => {}
  };
  const page = {
    route: 'pages/favorites/favorites',
    options: {},
    data: {},
    setData(p) { sets.push(p); Object.assign(this.data, p); }
  };
  const cache = new Map();
  function load(path) {
    path = resolve(path);
    if (path.endsWith('runtime.js')) return { mode: 'local', apiBaseUrl: 'http://127.0.0.1:1234/api/v1' };
    if (cache.has(path)) return cache.get(path).exports;
    const m = { exports: {} };
    cache.set(path, m);
    vm.runInNewContext(
      '(function(require,module){' + readFileSync(path, 'utf8') + '\n})',
      { wx, getCurrentPages: () => [page], Page: (d) => { page.data = d.data; Object.assign(page, d); } }
    )((id) => load(resolve(dirname(path), id + '.js')), m);
    return m.exports;
  }
  const auth = load(root + '/miniprogram/utils/auth.js');
  const favorites = load(root + '/miniprogram/utils/favorites-api.js');
  load(FAVORITES_PAGE);
  return { wx, requests, page, sets, auth, favorites };
}

/** 让会话通过**服务端核实**（`isLoggedIn()` 才可能为真）。 */
function login(f) {
  f.auth.setSession({ accessToken: 'synthetic-i16-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
  let verified = null;
  f.auth.requireLogin((ok) => { verified = ok; });
  const request = f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1);
  request.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } });
  return flush().then(() => verified);
}

/** 回答页面 onShow 发起的最新一次门禁核实（`GET /auth/session`）。 */
async function answerGate(f) {
  f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1)
    .success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } });
  await flush();
}

/** 页面 onShow 内的门禁核实在函数内作答。 */
async function passGate(f, call) {
  call();
  await answerGate(f);
}

function meta() {
  return { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' };
}

function answer(f, request, payload) {
  request.success({ statusCode: 200, data: { data: payload, meta: meta() }, header: {} });
}

function fail(request) {
  request.success({ statusCode: 503, data: { error: { code: 'PROVIDER_UNAVAILABLE', message: 'synthetic', retryable: false } } });
}

function favorite(overrides = {}) {
  return Object.assign({
    id: UUID_A, revision: 1, target_ref: { type: 'species', id: TARGET, revision: 3 },
    reference_state: 'available', unavailable_reason: null, created_at: '2026-10-14T06:00:00.000Z'
  }, overrides);
}

function knowledgeItem(overrides = {}) {
  return Object.assign({
    id: TARGET,
    revision: 7,
    type: 'species',
    title: '稻飞虱的识别与田间核对',
    body: '正文（合成演示内容，不代表真实资料）。',
    source: {
      id: UUID_B,
      version: 'v1.0.0',
      title: '示范资料来源',
      url: 'https://example.org/knowledge/demo-1',
      publisher: '示范出版方',
      source_kind: 'verified_seed',
      evidence_kind: 'research',
      validity: 'valid',
      review_status: 'verified',
      updated_at: '2026-10-01T00:00:00.000Z'
    },
    conditions: null,
    reference_state: 'available',
    dose_cards: []
  }, overrides);
}

const favoriteRequests = (f) => f.requests.filter((r) => r.url.includes('/favorites'));
const targetRequests = (f) => f.requests.filter((r) => r.url.includes('/knowledge'));

test('收藏页：R1 在飞→离页重进→R2 先成功，R1 旧成功晚到不得覆盖列表/targets/busy/分页', async () => {
  const f = fixture();
  assert.equal(await login(f), true);

  await passGate(f, () => f.page.onShow());
  const oldList = favoriteRequests(f).at(-1);
  const oldTargets = targetRequests(f).at(-1);
  assert.ok(oldList && oldTargets);
  assert.equal(f.page.data.busy, true, 'R1 已进入在途');

  f.page.onHide();
  f.page.onShow();
  assert.equal(f.page.data.busy, false, '重进先解除上一轮残留的在途态');
  assert.equal(f.page.data.items.length, 0);
  await answerGate(f);
  const newList = favoriteRequests(f).at(-1);
  const newTargets = targetRequests(f).at(-1);
  assert.notEqual(newList, oldList, '重进必须发新一轮读取');
  assert.notEqual(newTargets, oldTargets);

  // R2 先成功：新列表 → 新 targets（targets 协调正常）。
  answer(f, newList, {
    items: [favorite({ id: UUID_B, target_ref: { type: 'species', id: TARGET, revision: 2 } })],
    next_cursor: 'cursor-r2'
  });
  await flush();
  assert.equal(f.page.data.items.length, 1);
  assert.equal(f.page.data.items[0].id, UUID_B);
  assert.equal(f.page.data.busy, false);

  answer(f, newTargets, { items: [knowledgeItem()], next_cursor: null });
  await flush();
  assert.equal(f.page.data.targets.length, 1);
  assert.equal(f.page.data.targets[0].id, TARGET);
  assert.equal(f.page.data.targets[0].favorited, true, '新一轮列表应回填到新一轮 targets');
  assert.equal(f.page.data.targetError, '');

  // R1 旧成功晚到：不得写 items/nextCursor/total，也不得用旧 items 触发 reconcileTargets。
  answer(f, oldList, {
    items: [favorite({ id: UUID_A, target_ref: { type: 'species', id: OLD_TARGET, revision: 1 } })],
    next_cursor: 'cursor-r1'
  });
  await flush();
  assert.deepEqual(f.page.data.items.map((item) => item.id), [UUID_B]);
  assert.equal(f.page.data.total, 1);
  assert.equal(f.page.data.nextCursor, 'cursor-r2', '旧游标不得覆盖新一轮游标');
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.targets[0].favorited, true, '旧列表不得改写新一轮 targets 的已收藏标记');

  // R1 旧 targets 晚到：不得覆盖新一轮标题/类型。
  answer(f, oldTargets, { items: [knowledgeItem({ id: OLD_TARGET, type: 'herbicide', title: '旧资料' })], next_cursor: null });
  await flush();
  assert.equal(f.page.data.targets.length, 1);
  assert.equal(f.page.data.targets[0].id, TARGET);
  assert.equal(f.page.data.targets[0].title, '稻飞虱的识别与田间核对');

  // 正常分页仍可用，且基于新一轮游标。
  f.page.onMore();
  assert.equal(f.page.data.busy, true);
  const more = favoriteRequests(f).at(-1);
  assert.match(more.url, /cursor=cursor-r2/);
  answer(f, more, {
    items: [favorite({ id: UUID_A, target_ref: { type: 'species', id: OLD_TARGET, revision: 1 } })],
    next_cursor: null
  });
  await flush();
  assert.deepEqual(f.page.data.items.map((item) => item.id), [UUID_B, UUID_A]);
  assert.equal(f.page.data.total, 2);
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.message, '');
});

test('收藏页：离页后旧成功晚到不产生任何 setData', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await passGate(f, () => f.page.onShow());
  const oldList = favoriteRequests(f).at(-1);
  const oldTargets = targetRequests(f).at(-1);
  assert.equal(f.page.data.busy, true);

  f.page.onHide();
  await flush();
  const before = JSON.stringify(f.page.data);
  const setCount = f.sets.length;

  answer(f, oldList, { items: [favorite()], next_cursor: 'old' });
  await flush();
  answer(f, oldTargets, { items: [knowledgeItem()], next_cursor: null });
  await flush();

  assert.equal(JSON.stringify(f.page.data), before, '离页后的旧成功不得写页面');
  assert.equal(f.sets.length, setCount, '不得产生 setData（含 reconcileTargets）');
});

test('收藏页：重新刷新时旧失败晚到不得污染新一轮 busy/error；新刷新正常完成', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await passGate(f, () => f.page.onShow());
  const oldList = favoriteRequests(f).at(-1);
  const oldTargets = targetRequests(f).at(-1);

  f.page.onRefresh();
  const newList = favoriteRequests(f).at(-1);
  const newTargets = targetRequests(f).at(-1);
  assert.notEqual(newList, oldList, '刷新必须发新一轮读取');
  assert.notEqual(newTargets, oldTargets);
  assert.equal(f.page.data.busy, true);

  answer(f, newList, { items: [favorite()], next_cursor: null });
  await flush();
  answer(f, newTargets, { items: [knowledgeItem()], next_cursor: null });
  await flush();
  assert.equal(f.page.data.items.length, 1);
  assert.equal(f.page.data.busy, false);
  assert.match(f.page.data.targetNote, /1 条可收藏/);

  // 旧一轮的失败晚到：不得清空新列表，也不得写 errorText/errorCode/targetError。
  fail(oldList);
  fail(oldTargets);
  await flush();
  assert.equal(f.page.data.items.length, 1, '旧失败不得清空新一轮列表');
  assert.equal(f.page.data.errorText, '');
  assert.equal(f.page.data.errorCode, '');
  assert.equal(f.page.data.targetError, '');
  assert.match(f.page.data.targetNote, /1 条可收藏/);
  assert.equal(f.page.data.busy, false);

  // 反向对照：新一轮自己的失败照常呈现（不是把失败永久吞掉）。
  f.page.onRefresh();
  const third = favoriteRequests(f).at(-1);
  fail(third);
  await flush();
  assert.equal(f.page.data.errorCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(f.page.data.errorText, f.favorites.messageFor({ code: 'PROVIDER_UNAVAILABLE' }));
  assert.equal(f.page.data.items.length, 0);
  assert.equal(f.page.data.busy, false);
});

test('收藏页：离页后旧失败晚到不产生任何 setData', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await passGate(f, () => f.page.onShow());
  const oldList = favoriteRequests(f).at(-1);
  const oldTargets = targetRequests(f).at(-1);

  f.page.onHide();
  await flush();
  const before = JSON.stringify(f.page.data);
  const setCount = f.sets.length;

  fail(oldList);
  fail(oldTargets);
  await flush();

  assert.equal(JSON.stringify(f.page.data), before, '离页后的旧失败不得写 errorText/targetError');
  assert.equal(f.sets.length, setCount);
});
