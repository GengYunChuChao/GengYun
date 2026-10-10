// GY-I07 页面登录门禁回归（F3）。
//
// 背景：原实现 onLoad 先 setData 结果、onShow 才检查登录 → 存在越权预览窗口
// （未登录用户可看到列表/详情数据）。本测试以 vm 载入**真实页面脚本**，
// 注入受控的 auth / reference 替身，断言：
//   1) 会话核实通过前**不得**装载任何记录（items/list/detail 为空）；
//   2) 未通过时会跳转登录页（wx.reLaunch）；
//   3) 会话核实通过后才装载数据；
//   4) onShow 兜底：会话失效时先清空再跳转，不残留旧数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const pagePath = (rel) => fileURLToPath(new URL('../../miniprogram/' + rel, import.meta.url));

// 受控 reference 替身：返回非空数据，便于区分「已装载」与「未装载」。
function fakeReference() {
  return {
    crops: [{ id: 'crop_rice', name: '水稻' }],
    species: [{ id: 'sp_1', name: '稗草' }],
    regions: [{ code: '330100', name: '杭州市' }],
    modeNote: () => '替身边界说明',
    catalogVersionText: () => 'v1',
    matchStateLabel: (s) => s,
    query: () => ({ match_state: 'matched', items: [{ record_id: 'r1', id: 'r1', source_version: 'sv' }], total: 1, next_cursor: null, reasons: [], unmatched_reasons: [], simulated_excluded: 0 }),
    detail: () => ({ labels: {}, verified_scope: [], not_collected: [], unavailable_reason: '', queryable: true, source_version: 'sv' }),
    seed: {
      counts: { herbicides: 96, weeds: 172, weedMaster: 175, provinces: 34, controlTiming: 14 },
      label: '待核实·非权威',
      dataOrigin: 'seed_unverified',
      authority: 'none',
      disclaimer: 'd',
      regionConvention: 'r',
      notCollected: '未采集（种子整理稿无此栏）',
      herbicides: [{ seed_id: 's1' }],
      weeds: [{ name: 'w' }],
      controlTiming: [{ id: 't' }],
      provinces: [{ province: '中国台湾' }],
    },
    seedLabels: () => ({ seed: '待核实·非权威', dose: '不提供用量' }),
    seedHerbicideDetail: () => ({ seed_id: 's1', dosage_status: 'not_collected' }),
    seedSearch: () => [],
  };
}

/** 构造最小微信运行时；verified 控制 async 门禁结果，loggedInDirect 控制同步兜底。 */
function loadPage(rel, { verified, loggedInDirect }) {
  const calls = { setData: [], reLaunch: [] };
  const page = { data: {}, setData(patch) { calls.setData.push(patch); Object.assign(page.data, patch); } };
  const auth = {
    isLoggedIn: () => Boolean(loggedInDirect),
    // 与真实 utils/auth.js 语义一致：未通过核实即 `wx.reLaunch` 到登录页，然后回调 false。
    requireLogin(callback) {
      if (!verified) {
        calls.reLaunch.push('/pages/login/login');
        if (typeof callback === 'function') callback(false);
        return;
      }
      if (typeof callback === 'function') callback(true);
    },
  };
  const sandbox = {
    Page(def) { Object.assign(page, def); },
    wx: {
      reLaunch(opts) { calls.reLaunch.push(opts.url); },
      navigateTo() {},
      navigateBack() {},
      setClipboardData() {},
    },
    console,
    require: (id) => (id.indexOf('auth') !== -1 ? auth : id.indexOf('reference') !== -1 ? fakeReference() : {}),
  };
  vm.runInNewContext(readFileSync(pagePath(rel), 'utf8'), sandbox);
  return { page, calls };
}

const PAGES = [
  { rel: 'pages/reference/reference.js', load: (p) => p.onLoad(), listKey: 'items' },
  { rel: 'pages/referencedetail/referencedetail.js', load: (p) => p.onLoad({ id: 'rec-1' }), listKey: 'detail' },
  { rel: 'pages/referenceseed/referenceseed.js', load: (p) => p.onLoad(), listKey: 'list' },
  { rel: 'pages/referenceseeddetail/referenceseeddetail.js', load: (p) => p.onLoad({ id: 'seed-1' }), listKey: 'item' },
];

function assertEmpty(page, rel, key) {
  const value = page.data[key];
  if (Array.isArray(value)) assert.equal(value.length, 0, `${rel} 未通过门禁时不得残留 ${key}`);
  else assert.ok(value === null || value === undefined, `${rel} 未通过门禁时不得残留 ${key}`);
}

test('F3：四个页面 onLoad 前置门禁——未核实不加载数据且跳转登录页', () => {
  for (const { rel, load, listKey } of PAGES) {
    const { page, calls } = loadPage(rel, { verified: false, loggedInDirect: false });
    load(page);
    assertEmpty(page, rel, listKey);
    assert.ok(calls.reLaunch.length >= 1, `${rel} 未通过核实应跳转登录页`);
  }
});

test('F3：会话核实通过后才装载数据', () => {
  const ref = loadPage('pages/reference/reference.js', { verified: true, loggedInDirect: true });
  ref.page.onLoad();
  assert.ok(ref.page.data.items.length > 0, '核实通过后应装载列表数据');
  assert.equal(ref.calls.reLaunch.length, 0, '核实通过不应跳登录页');

  const seed = loadPage('pages/referenceseed/referenceseed.js', { verified: true, loggedInDirect: true });
  seed.page.onLoad();
  assert.ok(seed.page.data.list.length > 0, '核实通过后应装载种子列表');

  const detail = loadPage('pages/referencedetail/referencedetail.js', { verified: true, loggedInDirect: true });
  detail.page.onLoad({ id: 'r1' });
  assert.ok(detail.page.data.found === true, '核实通过后应装载详情');
});

test('F3：onShow 兜底——会话失效时先清空再跳转（不残留旧数据）', () => {
  for (const { rel, listKey } of PAGES) {
    const { page, calls } = loadPage(rel, { verified: false, loggedInDirect: false });
    // 手工注入「旧数据」，模拟离开期间已渲染的残留。
    if (Array.isArray(page.data[listKey])) page.data[listKey] = [{ id: 'stale' }];
    else page.data[listKey] = { id: 'stale' };
    page.onShow();
    assertEmpty(page, rel, listKey);
    assert.ok(calls.reLaunch.length >= 1, `${rel} onShow 失效应跳登录页`);
  }
});

// ---------------------------------------------------------------------------
// G2：门禁**失败后**的搜索/加载处理器必须同样不可用。
//
// 监工口径：不能依赖「跳转必然成功」—— 跳转可能被拦截/失败，此时页面仍存活；
// 若 onSearch/runQuery/refresh/load 不再校验门禁，未登录用户可直接调用处理器拿到数据。
// 本组用例先让门禁失败（且跳转「未成功」——页面保持存活），**再直接调用**这些处理器，
// 断言数据仍不得装载。
// ---------------------------------------------------------------------------

test('G2：门禁失败后调用 onSearch/runQuery 不得装载列表（reference）', () => {
  const { page } = loadPage('pages/reference/reference.js', { verified: false, loggedInDirect: false });
  page.onLoad();
  page.onShow();
  // 跳转「未成功」，页面存活 —— 直接调用实际搜索处理器。
  const afterGate = page.data.items.length;
  page.onSearch();
  assert.equal(page.data.items.length, 0, 'reference：门禁失败后 onSearch 不得装载数据');
  page.runQuery();
  assert.equal(page.data.items.length, 0, 'reference：门禁失败后 runQuery 不得装载数据');
  assert.equal(page.data.gatePassed, false, 'reference：门禁标志应保持 false');
  assert.equal(afterGate, 0);
});

test('G2：门禁失败后调用 onSearch/refresh 不得装载种子列表（referenceseed）', () => {
  const { page } = loadPage('pages/referenceseed/referenceseed.js', { verified: false, loggedInDirect: false });
  page.onLoad();
  page.onShow();
  page.onSearch();
  assert.equal(page.data.list.length, 0, 'referenceseed：门禁失败后 onSearch 不得装载数据');
  page.refresh();
  assert.equal(page.data.list.length, 0, 'referenceseed：门禁失败后 refresh 不得装载数据');
  assert.equal(page.data.gatePassed, false);
});

test('G2：门禁失败后调用 load 不得装载详情（referencedetail / referenceseeddetail）', () => {
  const d = loadPage('pages/referencedetail/referencedetail.js', { verified: false, loggedInDirect: false });
  d.page.onLoad({ id: 'rec-1' });
  d.page.onShow();
  d.page.load('rec-1');
  assert.equal(d.page.data.found, false, 'referencedetail：门禁失败后 load 不得装载详情');
  assert.equal(d.page.data.detail, null);

  const sd = loadPage('pages/referenceseeddetail/referenceseeddetail.js', { verified: false, loggedInDirect: false });
  sd.page.onLoad({ id: 'seed-1' });
  sd.page.onShow();
  sd.page.load('seed-1');
  assert.equal(sd.page.data.found, false, 'referenceseeddetail：门禁失败后 load 不得装载详情');
  assert.equal(sd.page.data.item, null);
});

test('G2：onShow 令会话失效后，处理器立即不可用（reference / referencedetail）', () => {
  // 先通过门禁装载数据，再令会话失效并重入 onShow → 处理器须失效。
  const ref = loadPage('pages/reference/reference.js', { verified: true, loggedInDirect: true });
  ref.page.onLoad();
  assert.ok(ref.page.data.items.length > 0, '前置：门禁通过应已装载');
  ref.page.data.gatePassed = false; // 模拟会话失效后 onShow 归零
  ref.page.runQuery();
  assert.equal(ref.page.data.items.length, 0, '会话失效后 runQuery 不得再装载');

  const d = loadPage('pages/referencedetail/referencedetail.js', { verified: true, loggedInDirect: true });
  d.page.onLoad({ id: 'r1' });
  assert.equal(d.page.data.found, true, '前置：门禁通过应已装载详情');
  d.page.data.gatePassed = false;
  d.page.load('r1');
  assert.equal(d.page.data.found, false, '会话失效后 load 不得再装载');
});
