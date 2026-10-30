// GY-I26/#28 收藏页：收藏/取消写请求的页面代次隔离（合成 wx／可控响应；**不是**真机、
// 微信开发者工具或 Android 证据）。
//
// 复现的缺口：`onAdd`／`onCancel` 的回调没有页面代次检查。写请求在飞时同会话 onHide／
// onUnload／重进，旧成功/普通失败/NOT_FOUND/REVISION_CONFLICT 晚到会把旧 busy/message 写回
// 新页面，并可能替隐藏页或新页面发起 `loadFavorites` 重读。
//
// 本文件只证明页面数据层：写回调在产生任何 setData／loadFavorites 之前按发起时的页面代次
// 丢弃；当前代次的成功/失败仍照常写回并重读。离页不等于取消服务端写入，本文件也不据此
// 宣称服务端未完成写入。
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
const TARGET_B = '11111111-1111-4111-8111-111111111112';
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
  f.auth.setSession({ accessToken: 'synthetic-i26-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
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

async function passGate(f, call) {
  call();
  await answerGate(f);
}

function meta() {
  return { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' };
}

/** 2xx 走契约信封；非 2xx 原样交给消费层（错误封套由 `fail` 构造）。 */
function answer(f, request, payload, statusCode = 200, header = {}) {
  const ok = statusCode >= 200 && statusCode < 300;
  request.success({ statusCode, data: ok ? { data: payload, meta: meta() } : payload, header });
  return request;
}

function fail(request, code, statusCode) {
  request.success({ statusCode, data: { error: { code, message: 'synthetic', retryable: false } } });
  return request;
}

function favorite(overrides = {}) {
  return Object.assign({
    id: UUID_A, revision: 1, target_ref: { type: 'species', id: TARGET, revision: 3 },
    reference_state: 'available', unavailable_reason: null, created_at: '2026-10-14T06:00:00.000Z'
  }, overrides);
}

function favoriteB() {
  return favorite({ id: UUID_B, target_ref: { type: 'species', id: TARGET_B, revision: 2 } });
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

const favoriteGets = (f) => f.requests.filter((r) => r.method === 'GET' && r.url.includes('/favorites'));
const postRequests = (f) => f.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/favorites'));
const deleteRequests = (f) => f.requests.filter((r) => r.method === 'DELETE' && r.url.includes('/favorites/'));
const targetGets = (f) => f.requests.filter((r) => r.method === 'GET' && r.url.includes('/knowledge'));
const at = (index) => ({ currentTarget: { dataset: { index } } });

/** 进入收藏页并让门禁、收藏列表、资料列表都完成。 */
async function openPage(f, options = {}) {
  await passGate(f, () => f.page.onShow());
  const list = favoriteGets(f).at(-1);
  const targets = targetGets(f).at(-1);
  assert.ok(list && targets, '进入页面应发起收藏与资料读取');
  answer(f, list, { items: options.items || [], next_cursor: null });
  answer(f, targets, { items: options.targets || [], next_cursor: null });
  await flush();
}

test('当前代次：收藏成功重读一次；普通失败如实报错且不重读', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openPage(f, {
    targets: [knowledgeItem(), knowledgeItem({ id: TARGET_B, title: '第二份资料' })]
  });
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.targets.length, 2);

  f.page.onAdd(at(0));
  assert.equal(f.page.data.busy, true);
  assert.equal(f.page.data.message, '正在收藏…');
  const post = postRequests(f).at(-1);
  assert.ok(post);
  const readsBefore = favoriteGets(f).length;
  answer(f, post, favorite(), 201, { ETag: '"1"' });
  await flush();
  assert.equal(f.page.data.busy, true, '成功写回后立即进入当前代次重读');
  assert.equal(f.page.data.message, '已收藏：稻飞虱的识别与田间核对');
  assert.equal(favoriteGets(f).length, readsBefore + 1, '成功只发起一次列表重读');

  const reload = favoriteGets(f).at(-1);
  answer(f, reload, { items: [favorite()], next_cursor: null });
  await flush();
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.items.length, 1);
  assert.equal(f.page.data.targets[0].favorited, true);
  assert.equal(f.page.data.targets[1].favorited, false);

  const failedReadsBefore = favoriteGets(f).length;
  f.page.onAdd(at(1));
  const failedPost = postRequests(f).at(-1);
  fail(failedPost, 'PROVIDER_UNAVAILABLE', 503);
  await flush();
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.message, f.favorites.messageFor({ code: 'PROVIDER_UNAVAILABLE' }));
  assert.equal(f.page.data.items.length, 1, '普通失败不得改写当前列表');
  assert.equal(favoriteGets(f).length, failedReadsBefore, '普通失败不得假装成功，也不触发重读');
});

test('当前代次：取消成功重读；NOT_FOUND／REVISION_CONFLICT 如实报错后重读；普通失败不重读', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openPage(f, {
    items: [favorite(), favoriteB()],
    targets: [knowledgeItem(), knowledgeItem({ id: TARGET_B, title: '第二份资料' })]
  });
  assert.equal(f.page.data.items.length, 2);

  // 正常取消成功：如实写回并重读。
  let readsBefore = favoriteGets(f).length;
  f.page.onCancel(at(0));
  const remove = deleteRequests(f).at(-1);
  assert.equal(remove.header['If-Match'], '"1"');
  answer(f, remove, { accepted: true });
  await flush();
  assert.equal(f.page.data.message, '已取消收藏。');
  assert.equal(f.page.data.busy, true, '取消成功后立即进入当前代次重读');
  assert.equal(favoriteGets(f).length, readsBefore + 1);
  let reload = favoriteGets(f).at(-1);
  answer(f, reload, { items: [favoriteB()], next_cursor: null });
  await flush();
  assert.equal(f.page.data.items.length, 1);
  assert.equal(f.page.data.items[0].id, UUID_B);

  // NOT_FOUND：不假装成功、不先本地删除；由当前代次重读。
  readsBefore = favoriteGets(f).length;
  f.page.onCancel(at(0));
  const notFound = deleteRequests(f).at(-1);
  fail(notFound, 'NOT_FOUND', 404);
  await flush();
  assert.equal(f.page.data.busy, true, 'NOT_FOUND 后当前代次重读在飞');
  assert.equal(f.page.data.message, f.favorites.messageFor({ code: 'NOT_FOUND' }));
  assert.notEqual(f.page.data.message, '已取消收藏。');
  assert.equal(f.page.data.items.length, 1, '重读返回前不得先本地删掉');
  assert.equal(favoriteGets(f).length, readsBefore + 1, 'NOT_FOUND 必须由当前代次重读');
  reload = favoriteGets(f).at(-1);
  answer(f, reload, { items: [favoriteB()], next_cursor: null });
  await flush();

  // REVISION_CONFLICT：同上，如实报错并重读。
  readsBefore = favoriteGets(f).length;
  f.page.onCancel(at(0));
  const conflict = deleteRequests(f).at(-1);
  fail(conflict, 'REVISION_CONFLICT', 409);
  await flush();
  assert.equal(f.page.data.busy, true);
  assert.equal(f.page.data.message, f.favorites.messageFor({ code: 'REVISION_CONFLICT' }));
  assert.equal(f.page.data.items.length, 1);
  assert.equal(favoriteGets(f).length, readsBefore + 1, 'REVISION_CONFLICT 必须由当前代次重读');
  reload = favoriteGets(f).at(-1);
  answer(f, reload, { items: [favoriteB()], next_cursor: null });
  await flush();

  // 普通取消失败：如实报错，不重读、不改写列表。
  readsBefore = favoriteGets(f).length;
  f.page.onCancel(at(0));
  const ordinary = deleteRequests(f).at(-1);
  fail(ordinary, 'PROVIDER_UNAVAILABLE', 503);
  await flush();
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.message, f.favorites.messageFor({ code: 'PROVIDER_UNAVAILABLE' }));
  assert.equal(f.page.data.items.length, 1);
  assert.equal(favoriteGets(f).length, readsBefore, '普通取消失败不得触发重读');
});

test('离页后旧收藏成功／普通失败不写页面、不重读', async () => {
  // onHide 后的旧成功。
  const f = fixture();
  assert.equal(await login(f), true);
  await openPage(f, { targets: [knowledgeItem()] });
  f.page.onAdd(at(0));
  const post = postRequests(f).at(-1);
  f.page.onHide();
  const frozen = JSON.stringify(f.page.data);
  const sets = f.sets.length;
  const reads = favoriteGets(f).length;

  answer(f, post, favorite(), 201, { ETag: '"1"' });
  await flush();
  assert.equal(JSON.stringify(f.page.data), frozen, '离页后的旧成功不得写页面');
  assert.equal(f.sets.length, sets, '离页后的旧成功不得产生 setData');
  assert.equal(favoriteGets(f).length, reads, '离页后的旧成功不得发起 loadFavorites 重读');

  // onUnload 后的旧普通失败。
  const g = fixture();
  assert.equal(await login(g), true);
  await openPage(g, { targets: [knowledgeItem()] });
  g.page.onAdd(at(0));
  const failedPost = postRequests(g).at(-1);
  g.page.onUnload();
  const frozenG = JSON.stringify(g.page.data);
  const setsG = g.sets.length;
  const readsG = favoriteGets(g).length;

  fail(failedPost, 'PROVIDER_UNAVAILABLE', 503);
  await flush();
  assert.equal(JSON.stringify(g.page.data), frozenG, '卸载后的旧失败不得写页面');
  assert.equal(g.sets.length, setsG, '卸载后的旧失败不得产生 setData');
  assert.equal(favoriteGets(g).length, readsG, '卸载后的旧失败不得发起 loadFavorites 重读');
});

async function addInFlight() {
  const f = fixture();
  assert.equal(await login(f), true);
  await openPage(f, { targets: [knowledgeItem()] });
  f.page.onAdd(at(0));
  const post = postRequests(f).at(-1);
  assert.ok(post);
  return { f, post };
}

async function reenter(f) {
  f.page.onHide();
  f.page.onShow();
  await answerGate(f);
  const list = favoriteGets(f).at(-1);
  const targets = targetGets(f).at(-1);
  assert.ok(list && targets, '重进后应发起新一轮读取');
  return { list, targets };
}

test('重进后旧收藏成功／失败不写新页面、不复位新 busy、不重读，也不杀掉新读取', async () => {
  for (const outcome of ['success', 'failure']) {
    const { f, post } = await addInFlight();
    const pending = await reenter(f);
    assert.equal(f.page.data.busy, true, '新页面首个列表读取在飞');
    assert.equal(f.page.data.message, '');
    const frozen = JSON.stringify(f.page.data);
    const sets = f.sets.length;
    const reads = favoriteGets(f).length;

    if (outcome === 'success') answer(f, post, favorite(), 201, { ETag: '"1"' });
    else fail(post, 'PROVIDER_UNAVAILABLE', 503);
    await flush();

    assert.equal(JSON.stringify(f.page.data), frozen, outcome + '：旧写回调不得写新页面');
    assert.equal(f.sets.length, sets, outcome + '：旧写回调不得 setData');
    assert.equal(f.page.data.busy, true, outcome + '：不得复位新页面的 busy');
    assert.equal(f.page.data.message, '', outcome + '：不得写新页面的 message');
    assert.equal(favoriteGets(f).length, reads, outcome + '：不得发起新页面 loadFavorites 重读');

    // 新读取仍能在旧回调之后正常写回，证明旧写回调没有抢走/杀掉当前代次的读取。
    answer(f, pending.list, { items: [], next_cursor: null });
    answer(f, pending.targets, { items: [knowledgeItem()], next_cursor: null });
    await flush();
    assert.equal(f.page.data.busy, false);
    assert.equal(f.page.data.items.length, 0);
    assert.equal(f.page.data.message, '尚无收藏。');
    assert.equal(f.page.data.targets.length, 1);
  }
});

test('重进后旧取消 NOT_FOUND／REVISION_CONFLICT 不写新页面、不重读，新读取仍可写回', async () => {
  for (const [code, status] of [['NOT_FOUND', 404], ['REVISION_CONFLICT', 409]]) {
    const f = fixture();
    assert.equal(await login(f), true);
    await openPage(f, { items: [favorite()], targets: [knowledgeItem()] });
    f.page.onCancel(at(0));
    const remove = deleteRequests(f).at(-1);
    assert.ok(remove);

    const pending = await reenter(f);
    assert.equal(f.page.data.busy, true, '新页面首个列表读取在飞');
    assert.equal(f.page.data.message, '');
    const frozen = JSON.stringify(f.page.data);
    const sets = f.sets.length;
    const reads = favoriteGets(f).length;

    fail(remove, code, status);
    await flush();

    assert.equal(JSON.stringify(f.page.data), frozen, code + '：旧取消回调不得写新页面');
    assert.equal(f.sets.length, sets, code + '：旧取消回调不得 setData');
    assert.equal(f.page.data.busy, true, code + '：不得复位新页面 busy');
    assert.equal(f.page.data.message, '', code + '：不得写新页面 message');
    assert.equal(favoriteGets(f).length, reads, code + '：不得发起新页面 loadFavorites 重读');

    // 当前代次的新读取仍能正常写回（旧冲突回调没有替它重读/抢走 seq）。
    answer(f, pending.list, { items: [], next_cursor: null });
    answer(f, pending.targets, { items: [knowledgeItem()], next_cursor: null });
    await flush();
    assert.equal(f.page.data.busy, false);
    assert.equal(f.page.data.items.length, 0);
    assert.equal(f.page.data.message, '尚无收藏。');
  }
});
