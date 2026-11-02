// GY-R73 诚实性：收藏页上半区「可收藏的资料」必须能继续加载，且条数文案自证「已加载」。
//
// 复现的缺口（改前实读 keep）：
//   · `miniprogram/pages/favorites/favorites.js` 的 `loadTargets()` 只发一次
//     `knowledgeApi.list({ limit: 20 })`，既不读也不回写 `next_cursor`，页面上没有任何
//     「还有更多」的出口 ⇒ 资料多于 20 条时列表被截断，而界面读起来像「就这些」；
//   · `miniprogram/pages/profile/profile.js` 用 `items.length + (nextCursor ? '+' : '')`
//     直接渲染成「条数」，`items.length` 只是**已加载**条数（封套没有 count 字段）⇒ 会被读成总数。
//
// 本文件只证明页面数据层与模板接线（合成 wx／可控响应；**不是**真机或开发者工具证据）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const PAGE = root + '/miniprogram/pages/favorites/favorites.js';
const WXML = root + '/miniprogram/pages/favorites/favorites.wxml';
const HISTORY_WXML = root + '/miniprogram/pages/history/history.wxml';
const PROFILE_JS = root + '/miniprogram/pages/profile/profile.js';
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
  load(PAGE);
  return { wx, requests, page, sets, auth };
}

/** 让会话通过**服务端核实**（`isLoggedIn()` 才可能为真）。 */
async function login(f) {
  f.auth.setSession({ accessToken: 'synthetic-r73-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
  let verified = null;
  f.auth.requireLogin((ok) => { verified = ok; });
  const request = f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1);
  request.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } });
  await flush();
  return verified;
}

const meta = () => ({ request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' });
function answer(request, payload, statusCode = 200) {
  const ok = statusCode >= 200 && statusCode < 300;
  request.success({ statusCode, data: ok ? { data: payload, meta: meta() } : payload, header: {} });
  return request;
}
function fail(request, code, statusCode) {
  request.success({ statusCode, data: { error: { code, message: 'synthetic', retryable: false } } });
  return request;
}
const targetGets = (f) => f.requests.filter((r) => r.method === 'GET' && r.url.includes('/knowledge'));
const favoriteGets = (f) => f.requests.filter((r) => r.method === 'GET' && r.url.includes('/favorites'));

/**
 * 一份可收藏的资料条目。形状必须是 knowledge-api 的闭集 Knowledge：
 * 多一个键就 INVALID_RESPONSE，少一个键也 INVALID_RESPONSE，所以这里照抄真实封套字段。
 */
function knowledgeItem(n, type = 'species') {
  return {
    id: '11111111-1111-4111-8111-1111111111' + String(10 + n),
    revision: n,
    type: type,
    title: '资料 ' + n,
    body: '正文（合成演示内容，不代表真实资料）。',
    source: {
      id: '22222222-2222-4222-8222-2222222222' + String(10 + n),
      version: 'v1.0.0',
      title: '示范资料来源 ' + n,
      url: 'https://example.org/knowledge/demo-' + n,
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
  };
}

/** 进入收藏页：门禁、收藏列表、资料第一页都由调用方显式回放。 */
async function openPage(f, targetsPayload) {
  f.page.onShow();
  f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1)
    .success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } });
  await flush();
  answer(favoriteGets(f).at(-1), { items: [], next_cursor: null });
  if (targetsPayload) answer(targetGets(f).at(-1), targetsPayload);
  await flush();
}

test('第一页有 next_cursor：文案写「已加载 N 条」并给出「加载更多资料」出口，首页不带 cursor', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openPage(f, { items: [knowledgeItem(1), knowledgeItem(2)], next_cursor: 'opaque.targets.2' });

  assert.equal(f.page.data.targetNextCursor, 'opaque.targets.2', '首页必须记下续页游标，否则永远看不到第 21 条起');
  assert.equal(f.page.data.targetNote, '来自已上架资料：已加载 2 条可收藏（还有更多）');
  assert.match(f.page.data.targetNote, /已加载 2 条/, '文案必须自证是「已加载」，不是总数');
  assert.equal(/(共|总计|合计)/.test(f.page.data.targetNote), false, '不能把已加载条数写成总数口径');

  const first = targetGets(f).at(-1);
  const query = new URL(first.url).searchParams;
  assert.equal(query.get('limit'), '20');
  assert.equal(query.has('cursor'), false, '首页必须整个不传 cursor（knowledge-api 只接受非空字符串）');

  const wxml = readFileSync(WXML, 'utf8');
  assert.match(wxml, /wx:if="\{\{targetNextCursor\}\}"[\s\S]{0,160}bind:tap="onMoreTargets"/, '缺少由 targetNextCursor 驱动的「加载更多资料」按钮');
  assert.match(wxml, /加载更多资料/, '按钮文案要说明它加载的是资料列表');
  assert.match(wxml, /wx:if="\{\{targetError && targets\.length\}\}"/, '续页失败必须能在页内看见（不清空、不静默）');

  // wx:else 必须紧贴它自己的 wx:if，中间不许插别的带 wx:if 的元素：否则「无资料」空态会错挂到
  // 「加载更多资料」按钮的 wx:if 上——没有下一页时，明明有资料也会渲染「暂无可收藏的资料」。
  const panelTag = 'wx:if="{{targets.length}}"';
  const panelIf = wxml.indexOf(panelTag);
  const elseAt = wxml.indexOf('wx:else', panelIf);
  assert.notEqual(panelIf, -1, '找不到资料面板的 wx:if');
  assert.notEqual(elseAt, -1, '找不到资料空态的 wx:else');
  assert.equal(
    wxml.slice(panelIf + panelTag.length, elseAt).includes('wx:if'),
    false,
    '资料空态的 wx:else 与 wx:if="{{targets.length}}" 之间不得再插带 wx:if 的元素（会打断 if/else 配对）'
  );
  assert.ok(elseAt < wxml.indexOf('targetNextCursor'), '「加载更多资料」按钮必须排在空态 wx:else 之后');
});

test('点「加载更多资料」：带 cursor 续读、按 type:id 去重后追加、文案改口「已全部加载」', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openPage(f, { items: [knowledgeItem(1), knowledgeItem(2)], next_cursor: 'opaque.targets.2' });

  f.page.onMoreTargets();
  assert.equal(f.page.data.targetBusy, true, '续页在途要有可见状态');
  const second = targetGets(f).at(-1);
  const query = new URL(second.url).searchParams;
  assert.equal(query.get('cursor'), 'opaque.targets.2');
  assert.equal(query.get('limit'), '20');

  // 续页里故意重复第 2 条（分页 + 闭集过滤下会出现），并混入一个不可收藏的 type。
  answer(second, {
    items: [knowledgeItem(2), knowledgeItem(3), knowledgeItem(4, 'static_region')],
    next_cursor: null
  });
  await flush();

  // 页面 state 里的数组来自 vm 沙箱 realm，展开成本 realm 数组再比对，避免原型不同导致 deepEqual 假红。
  assert.deepEqual([...f.page.data.targets.map((t) => t.id)], [
    knowledgeItem(1).id,
    knowledgeItem(2).id,
    knowledgeItem(3).id
  ], '续页条目按 type:id 去重后追加，保持已加载顺序');
  assert.equal(f.page.data.targets.length, 3);
  assert.equal(f.page.data.targetNextCursor, '');
  assert.equal(f.page.data.targetNote, '来自已上架资料：已加载 3 条可收藏（已全部加载）');
  assert.equal(f.page.data.targetBusy, false);
});

test('续页失败：已加载条目保留、错误在页内可见、游标不被抹掉（可重试）', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openPage(f, { items: [knowledgeItem(1), knowledgeItem(2)], next_cursor: 'opaque.targets.2' });

  f.page.onMoreTargets();
  fail(targetGets(f).at(-1), 'PROVIDER_UNAVAILABLE', 503);
  await flush();

  assert.equal(f.page.data.targets.length, 2, '续页失败不得把已加载的资料清空');
  assert.equal(f.page.data.targetBusy, false);
  assert.ok(f.page.data.targetError, '续页失败必须有可见错误');
  assert.equal(f.page.data.targetNextCursor, 'opaque.targets.2', '游标保留，用户可再点一次重试');
});

test('首页失败：清空列表并如实说不可用，不留下「这就是全部」的错觉', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openPage(f, null);
  fail(targetGets(f).at(-1), 'PROVIDER_UNAVAILABLE', 503);
  await flush();

  assert.equal(f.page.data.targets.length, 0);
  assert.equal(f.page.data.targetNextCursor, '');
  assert.equal(f.page.data.targetNote, '资料列表不可用');
  assert.ok(f.page.data.targetError);
});

test('计数与列表头文案自证「已加载」：profile 的表达式与两处 wxml 都不得回退成裸数字', () => {
  const profile = readFileSync(PROFILE_JS, 'utf8');
  assert.match(profile, /patch\[kind \+ 'Count'\] = '已加载 ' \+ result\.items\.length \+ \(result\.nextCursor \? '\+' : ''\) \+ ' 条'/, 'profile 计数必须写成「已加载 N[+] 条」');
  assert.equal(/patch\[kind \+ 'Count'\] = result\.items\.length \+ \(result\.nextCursor \? '\+' : ''\)\s*\n/.test(profile), false, '不得回退成裸数字（会被读成总数）');

  const favoritesWxml = readFileSync(WXML, 'utf8');
  assert.match(favoritesWxml, /已加载 \{\{items\.length\}\} 条/, '收藏页「我的收藏」头部必须写「已加载 N 条」');
  const historyWxml = readFileSync(HISTORY_WXML, 'utf8');
  assert.match(historyWxml, /已加载 \{\{items\.length\}\} 条/, '历史页头部必须写「已加载 N 条」');
  assert.match(historyWxml, /其中未成功 \{\{failedCount\}\} 条/, '未成功条数要落在「已加载」的范围内，不能被读成全量');
});
