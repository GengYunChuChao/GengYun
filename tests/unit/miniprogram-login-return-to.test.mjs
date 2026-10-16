import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const root = resolve(import.meta.dirname, '../..');
const directory = mkdtempSync(join(tmpdir(), 'gy-login-return-'));
mkdirSync(join(directory, 'utils')); mkdirSync(join(directory, 'config'));
for (const file of ['auth.js', 'navigation.js']) cpSync(join(root, 'miniprogram/utils', file), join(directory, 'utils', file));
writeFileSync(join(directory, 'config/runtime.js'), "module.exports={mode:'local',apiBaseUrl:'http://127.0.0.1:3000'}");
const requireHere = createRequire(join(directory, 'utils/auth.js'));
after(() => rmSync(directory, { recursive: true, force: true }));
const future = () => new Date(Date.now() + 3600000).toISOString();
const cache = (token = 'synthetic-token') => ({ accessToken: token, audience: 'user', expiresAt: future(), executionMode: 'stub' });
// 合成档案替身数据：作物/地区均未设置 → 未确认上下文。详情本体仍必须真实装载
// （「可以查阅」与「适用」分离），且不依赖 reference 目录的适用判定数据。
const PROFILE = { crop_id: null, region_code: null, region_catalog_version: null, revision: 1 };
const REF = '/pages/reference/reference';
const SEED = '/pages/referenceseed/referenceseed';
function fixture() {
  const storage = new Map(), requests = [], modals = [], routes = [], wxLogins = [];
  const b = { storage, requests, modals, routes, wxLogins, pages: [], failNextRoute: false, profileReads: [] };
  const wx = {
    getStorageSync: (key) => storage.get(key) || '', setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key), request: (opts) => requests.push(opts),
    login: (opts) => wxLogins.push(opts), showModal: (opts) => modals.push(opts),
  };
  for (const method of ['navigateTo', 'switchTab', 'reLaunch']) wx[method] = (opts) => {
    routes.push({ method, url: opts.url, opts });
    if (b.failNextRoute) { b.failNextRoute = false; opts.fail?.({}); }
    else opts.success?.({});
  };
  globalThis.wx = wx;
  globalThis.getCurrentPages = () => b.pages;
  for (const file of ['auth.js', 'navigation.js']) delete requireHere.cache[requireHere.resolve(join(directory, 'utils', file))];
  b.auth = requireHere(join(directory, 'utils/auth.js')); b.nav = requireHere(join(directory, 'utils/navigation.js'));
  b.wx = wx;
  // 切片 E N1 ／ 追加单 N1（对抗性审查 §4）：门禁一旦放行，各页会立刻发业务读取。这里给所有
  // *-api 客户端一个「永不落地」的替身：只让「门禁放行」这一可见状态成立，不引入假数据或未处理异常。
  const pendingApi = new Proxy({}, { get: () => () => new Promise(() => {}) });
  b.page = (name, loadOptions = {}) => {
    let def;
    const fontModule = { exports: {} };
    vm.runInNewContext(readFileSync(join(root, 'miniprogram/utils/font-scale.js'), 'utf8'), { module: fontModule, getApp: () => ({ globalData: { fontScale: 1.25 } }) });
    const gateModule = { exports: {} };
    // 门禁模块的**完整说明符登记表**（登记项逐字取自被加载源码里的 require）：
    // `miniprogram/utils/page-gate.js:3` 只有 `require('./auth')` 一条。改前是 `require: () => b.auth`
    // 的 blanket —— 而且这里返回的是**真实模块**（`requireHere` 从临时目录载入的 miniprogram/utils/auth.js 副本）：
    // page-gate.js 将来 require 别的模块，也会被静默喂成真实 auth，用例仍绿、看着在测真实门禁。
    // 未登记 ⇒ 显式失败并带依赖名（沿用仓库既有口径）。已登记项取值与改前逐字相同。
    const gateDependencies = new Map([['./auth', b.auth]]);
    vm.runInNewContext(loadOptions.gateSource ?? readFileSync(join(root, 'miniprogram/utils/page-gate.js'), 'utf8'), {
      module: gateModule,
      require: (id) => { if (!gateDependencies.has(id)) throw Error('Unexpected page dependency ' + id); return gateDependencies.get(id); },
    });
    const profileModule = { exports: {} };
    // profile-api 的依赖按**完整说明符**登记（逐字取自 miniprogram/utils/profile-api.js 的 require），
    // 不做后缀匹配：改前 `id.endsWith('/auth')`／`id.endsWith('/runtime')` 会把 `require('./auth.js')`、
    // `require('../../config/runtime')` 一类静默喂成已登记替身或最小壳（`{ localEnabled: () => false }`）。
    // 未登记（将来新增依赖）⇒ 显式失败并带依赖名。
    const profileApiDependencies = new Map([
      ['./auth', b.auth],
      ['../config/runtime', requireHere(join(directory, 'config/runtime.js'))],
    ]);
    vm.runInNewContext(readFileSync(join(root, 'miniprogram/utils/profile-api.js'), 'utf8'), { module: profileModule, require: (id) => { if (!profileApiDependencies.has(id)) throw Error('Unexpected page dependency ' + id); return profileApiDependencies.get(id); } });
    const profileApi = profileModule.exports;
    // 合成档案替身：只接线页面用到的 binding/current/read。身份绑定跟随 fixture 里的
    // 真实 auth 当前会话（token+epoch），身份变化立即失效，不在生产代码打补丁。
    const profile = {
      binding: () => profileApi.binding(),
      current: (bound) => profileApi.current(bound),
      read: function () {
        b.profileReads.push(profileApi.binding());
        return Promise.resolve(Object.assign({}, PROFILE));
      }
    };
    // 页面依赖按**完整说明符**登记（逐字取自被加载页面源码里的 require），不做后缀/兜底匹配：
    // 改前 `id.endsWith('-api')`／`id.endsWith('/auth')` 一类会把 `require('../../data/knowledge-api')`、
    // `require('../../utils/auth/')` 一类静默喂成替身，末段 blanket 更会把**任何**新增依赖静默喂成
    // `{ localEnabled: () => false }` —— 看着在测真页面，其实测了替身。未登记 ⇒ 显式失败并带依赖名。
    // 登记表随每次 b.page() 新建 ⇒ 与改前「每次 require 求值」一一对应，已登记项行为逐字不变。
    const pageDependencies = new Map([
      ['../../utils/font-scale', fontModule.exports],
      ['../../utils/page-gate', gateModule.exports],
      ['../../utils/profile-api', profile],
      ['../../utils/reference', requireHere(join(root, 'miniprogram/utils/reference.js'))],
      ['../../utils/auth', b.auth],
      ['../../utils/navigation', b.nav],
      // 业务客户端：本组用例只验「门禁放行」这一可见状态，登记为「永不落地」替身（**非真实模块**）。
      ['../../utils/favorites-api', pendingApi],
      ['../../utils/knowledge-api', pendingApi],
      ['../../utils/history-api', pendingApi],
      ['../../utils/messages-api', pendingApi],
      ['../../utils/community-api', pendingApi],
      ['../../utils/identify-api', pendingApi],
      // 本组不涉及的数据/调试/地区目录：登记为**最小壳**（**非真实模块**，改前同样落到 blanket），
      // 仅为保持既有语义逐字不变；新增依赖一律走上面的显式失败。
      ['../../utils/location-region', { localEnabled: () => false }],
      ['../../utils/debug', { localEnabled: () => false }],
      ['../../data/crops', { localEnabled: () => false }],
      ['../../data/regions', { localEnabled: () => false }],
    ]);
    vm.runInNewContext(readFileSync(join(root, `miniprogram/pages/${name}/${name}.js`), 'utf8'), {
      Page: (value) => { def = value; }, wx, console,
      require: (id) => { if (!pageDependencies.has(id)) throw Error('Unexpected page dependency ' + id); return pageDependencies.get(id); },
    });
    const page = { ...def, route: `pages/${name}/${name}`, options: {}, data: { ...def.data }, setData(value) { Object.assign(this.data, value); } };
    b.pages = [page]; return page;
  };
  b.login = (token = 'synthetic-token') => {
    let result, navId;
    b.auth.login((error, id) => { result = error; navId = id; });
    wxLogins.at(-1).success({ code: 'synthetic-code' });
    const req = requests.at(-1);
    req.success({ statusCode: 200, data: { data: { access_token: token, audience: 'user', expires_at: future() }, meta: { execution_mode: 'stub' } } });
    assert.equal(result, null); return navId;
  };
  return b;
}
function verified(req) { req.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } }); }
// 已确认档案 Promise 落地：先等档案读取真正发起，再排空微任务队列，
// 等其后续的真实详情装载完成（不再依赖同步 setData 时序）。
async function settled(b, page) {
  const reads = b.profileReads.length;
  for (let i = 0; i < 50 && b.profileReads.length === reads; i++) await Promise.resolve();
  for (let i = 0; i < 50 && page.data.profileLoading; i++) await Promise.resolve();
}
test('page and tab lists match actual app.json; each actual tab is accepted without query', () => {
  const b = fixture(), app = JSON.parse(readFileSync(join(root, 'miniprogram/app.json')));
  assert.deepEqual(b.nav.PAGES, app.pages);
  assert.deepEqual(b.nav.TAB_PAGES, app.tabBar.list.map((tab) => tab.pagePath));
  for (const tab of b.nav.TAB_PAGES) assert.equal(b.nav.normalizeTarget('/' + tab), '/' + tab);
});
test('only detail id is admitted; credentials, roles, redirects, malformed and oversized targets reject', () => {
  const b = fixture();
  for (const value of ['', null, {}, 'https://evil.test/x', '//evil.test/x', '/pages/login/login', '/pages/none/none', REF+'?role=admin',
    REF+'?token=x', REF+'?redirect=https://evil.test', '/pages/identify/identify?id=x',
    '/pages/referencedetail/referencedetail?id=%ZZ', '/pages/referencedetail/referencedetail?id=%252fsecret',
    '/pages/referencedetail/referencedetail?id=a&id=b', '/pages/referencedetail/referencedetail?id=a&openid=b',
    '/pages/referencedetail/referencedetail?id=../secret', '/pages/referencedetail/referencedetail?id='+ 'x'.repeat(600), REF+'#foo', REF+'\n']) {
    assert.equal(b.nav.normalizeTarget(value), null, String(value));
  }
  assert.equal(b.nav.normalizeTarget('/pages/referencedetail/referencedetail?id=record_1-2'), '/pages/referencedetail/referencedetail?id=record_1-2');
});
test('invalid replacement or capture never leaves an older target; no persistent return storage', () => {
  const b = fixture(); b.nav.beginReturnTo(REF); b.nav.beginReturnTo('https://evil.test');
  assert.equal(b.nav.peekReturnTo(), null);
  b.nav.beginReturnTo(REF); b.pages = [{ route: 'pages/login/login', options: {} }];
  b.auth.requireLogin(); assert.equal(b.nav.peekReturnTo(), null);
  assert.equal(b.storage.size, 0);
});
test('capture valid id, tab and invalid option types; capture exceptions fail closed', () => {
  const b = fixture(); b.pages = [{ route: 'pages/referencedetail/referencedetail', options: { id: 'ref-1' } }];
  assert.equal(b.nav.captureCurrent(), '/pages/referencedetail/referencedetail?id=ref-1');
  b.pages[0].options = { role: 'admin' }; assert.equal(b.nav.captureCurrent(), null);
  b.pages[0].options = { id: { toString() { throw Error('bad'); } } }; assert.equal(b.nav.captureCurrent(), null);
  b.pages = [{ route: 'pages/community/community', options: {} }]; assert.equal(b.nav.captureCurrent(), '/pages/community/community');
  globalThis.getCurrentPages = () => { throw Error('unavailable'); }; assert.equal(b.nav.captureCurrent(), null);
});
test('real navigation dispatch: tabs use switchTab, ordinary opening navigateTo, resume reLaunch', () => {
  const b = fixture(); b.nav.openTarget('/pages/community/community', true); b.nav.openTarget(REF, false); b.nav.openTarget(REF, true);
  assert.deepEqual(b.routes.map(({ method, url }) => ({ method, url })), [
    { method: 'switchTab', url: '/pages/community/community' }, { method: 'navigateTo', url: REF }, { method: 'reLaunch', url: REF }]);
});
test('return is consumed once; missing target resumes home after a verified login', () => {
  const b = fixture(), op = b.nav.beginReturnTo(REF), id = b.login();
  assert.equal(id, op.id); assert.equal(b.auth.resumeAfterLogin(id), true);
  assert.equal(b.routes.at(-1).url, REF); assert.equal(b.nav.peekReturnTo(), null);
  assert.equal(b.auth.resumeAfterLogin(id), false);
  const fresh = b.login(); b.auth.resumeAfterLogin(fresh); assert.equal(b.routes.at(-1).url, b.nav.HOME);
});
test('direct protected tabs return via switchTab after synthetic login, never navigateTo', () => {
  for (const tab of ['identify', 'community', 'messages', 'profile']) {
    const b = fixture(); b.pages = [{ route: `pages/${tab}/${tab}`, options: {} }];
    b.auth.requireLogin(); const id = b.login(); b.auth.resumeAfterLogin(id);
    assert.equal(b.routes.at(-1).method, 'switchTab'); assert.equal(b.routes.at(-1).url, `/pages/${tab}/${tab}`);
    assert.equal(b.nav.peekReturnTo(), null);
  }
});
test('guest home prompt precedes login; cancellation clears only its own intent', () => {
  const b = fixture(), home = b.page('home'); home.onShow(); home.goReference();
  assert.equal(b.modals.length, 1); assert.equal(b.routes.length, 0);
  b.modals[0].success({ confirm: false }); assert.equal(b.nav.peekReturnTo(), null); assert.equal(b.routes.length, 0);
});
test('home confirm → login → verified synthetic server result → original query page', () => {
  const b = fixture(), home = b.page('home'); home.onShow(); home.goReference(); b.modals[0].success({ confirm: true });
  assert.equal(b.routes.at(-1).url, '/pages/login/login');
  home.onHide(); home.onUnload(); assert.equal(b.nav.peekReturnTo(), REF);
  const login = b.page('login'); login.onShow(); login.login(); b.wxLogins.at(-1).success({ code: 'synthetic-code' });
  assert.deepEqual(b.requests.at(-1).data, { code: 'synthetic-code' });
  b.requests.at(-1).success({ statusCode: 200, data: { data: { access_token: 'synthetic-token', audience: 'user', expires_at: future() }, meta: { execution_mode: 'stub' } } });
  assert.equal(b.routes.at(-1).url, REF); login.onHide(); login.onUnload(); assert.equal(b.auth.isLoggedIn(), true);
});
test('old home modal confirm/cancel/failure cannot overwrite or clear a later target', () => {
  for (const outcome of ['confirm', 'cancel', 'fail']) {
    const b = fixture(), home = b.page('home'); home.onShow(); home.goReference(); home.goReferenceSeed();
    if (outcome === 'fail') b.modals[0].fail({}); else b.modals[0].success({ confirm: outcome === 'confirm' });
    assert.equal(b.nav.peekReturnTo(), SEED); assert.equal(b.routes.length, 0);
    b.modals[1].success({ confirm: true }); assert.equal(b.routes.at(-1).url, b.nav.LOGIN);
  }
});
test('home modal after hide/unload is ignored and intent cleared', () => {
  const b = fixture(), home = b.page('home'); home.onShow(); home.goReference(); home.onHide(); home.onUnload();
  b.modals[0].success({ confirm: true }); assert.equal(b.routes.length, 0); assert.equal(b.nav.peekReturnTo(), null);
});
test('home does not trust cached/previously verified session; entry re-verifies it', () => {
  const b = fixture(); b.login(); const home = b.page('home'); home.onShow();
  assert.equal(home.data.loggedIn, false); home.goReference(); const newer = b.requests.at(-1);
  b.requests.at(-2).success({ statusCode: 401, data: {} }); // Stale onShow cannot clear the entry's session/intent.
  assert.ok(b.auth.getSession()); assert.equal(b.nav.peekReturnTo(), REF);
  verified(newer); assert.equal(b.routes.at(-1).url, REF); assert.equal(b.modals.length, 0);
});
test('expired or server-rejected home session prompts login, never opens protected target', () => {
  for (const expired of [true, false]) {
    const b = fixture(); b.storage.set('gengyun.session', { ...cache(), ...(expired ? { expiresAt: '2000-01-01T00:00:00Z' } : {}) });
    const home = b.page('home'); home.onShow(); home.goReference();
    if (!expired) b.requests.at(-1).success({ statusCode: 401, data: {} });
    assert.equal(b.modals.length, 1); assert.equal(b.routes.length, 0); assert.equal(home.data.loggedIn, false);
  }
});
test('direct/shared page requires verification and captures own actual page plus id', () => {
  const b = fixture(); b.pages = [{ route: 'pages/referencedetail/referencedetail', options: { id: 'other-id' } }];
  let gate; b.auth.requireLogin((value) => { gate = value; });
  assert.equal(gate, false); assert.equal(b.requests.length, 0);
  assert.equal(b.nav.peekReturnTo(), '/pages/referencedetail/referencedetail?id=other-id');
  assert.equal(b.routes.at(-1).url, b.nav.LOGIN); // Intent does not grant access.
});
test('stale requireLogin verification cannot navigate or grant after page/intent changed', () => {
  const b = fixture(); b.storage.set('gengyun.session', cache()); b.pages = [{ route: 'pages/reference/reference', options: {} }];
  let gate; b.auth.requireLogin((value) => { gate = value; }); const req = b.requests.at(-1);
  b.pages = [{ route: 'pages/referenceseed/referenceseed', options: {} }]; b.nav.beginReturnTo(SEED);
  verified(req); assert.equal(gate, false); assert.equal(b.routes.length, 0); assert.equal(b.nav.peekReturnTo(), SEED);
});
test('current requireLogin 401 records a fresh target, while network failure stays gated', () => {
  for (const fail of [false, true]) {
    const b = fixture(); b.storage.set('gengyun.session', cache()); b.pages = [{ route: 'pages/identify/identify', options: {} }];
    let gate; b.auth.requireLogin((value) => { gate = value; });
    if (fail) b.requests.at(-1).fail({}); else b.requests.at(-1).success({ statusCode: 401, data: {} });
    assert.equal(gate, false); assert.equal(b.nav.peekReturnTo(), '/pages/identify/identify'); assert.equal(b.routes.at(-1).url, b.nav.LOGIN);
  }
});
test('guest browsing invalidates delayed login before code exchange or session write', () => {
  for (const stage of ['wx', 'server']) {
    const b = fixture(); b.nav.beginReturnTo(REF); const page = b.page('login'); page.onShow(); page.login();
    if (stage === 'server') b.wxLogins.at(-1).success({ code: 'synthetic-code' });
    const request = b.requests.at(-1); page.browseAsGuest();
    if (stage === 'wx') b.wxLogins.at(-1).success({ code: 'synthetic-code' });
    else request.success({ statusCode: 200, data: { data: { access_token: 'old', audience: 'user', expires_at: future() }, meta: { execution_mode: 'stub' } } });
    assert.equal(b.auth.isLoggedIn(), false); assert.equal(b.nav.peekReturnTo(), null); assert.equal(b.routes.at(-1).url, b.nav.HOME);
    if (stage === 'wx') assert.equal(b.requests.length, 0);
  }
});
test('old login cannot carry an old target to a new intent or a replacement account', () => {
  for (const action of ['new-intent', 'account', 'logout']) {
    const b = fixture(); b.nav.beginReturnTo(REF); b.auth.login(() => {}); b.wxLogins.at(-1).success({ code: 'synthetic-code' }); const req = b.requests.at(-1);
    if (action === 'new-intent') b.nav.beginReturnTo(SEED);
    else if (action === 'account') b.auth.setSession(cache('new-account'));
    else b.auth.logout();
    req.success({ statusCode: 200, data: { data: { access_token: 'old', audience: 'user', expires_at: future() }, meta: { execution_mode: 'stub' } } });
    assert.notEqual(b.auth.getSession()?.accessToken, 'old');
    assert.equal(b.nav.peekReturnTo(), action === 'new-intent' ? SEED : null);
  }
});
test('older wx.login failure cannot erase the target of a newer login with the same intent', () => {
  const b = fixture(); b.nav.beginReturnTo(REF);
  b.auth.login(() => {}); const old = b.wxLogins.at(-1);
  let error; b.auth.login((value) => { error = value; }); const newer = b.wxLogins.at(-1);
  old.fail({}); assert.equal(b.nav.peekReturnTo(), REF);
  newer.success({ code: 'synthetic-code' });
  b.requests.at(-1).success({ statusCode: 200, data: { data: { access_token: 'new', audience: 'user', expires_at: future() }, meta: { execution_mode: 'stub' } } });
  assert.equal(error, null); assert.equal(b.auth.isLoggedIn(), true); assert.equal(b.nav.peekReturnTo(), REF);
});
test('login failure clears target without creating a session', () => {
  const b = fixture(); b.nav.beginReturnTo(REF); let error;
  b.auth.login((value) => { error = value; }); b.wxLogins.at(-1).fail({});
  assert.match(error, /wx.login/); assert.equal(b.nav.peekReturnTo(), null); assert.equal(b.auth.isLoggedIn(), false);
});
test('shared disabled runtime rejects login and clears intent without wx.login/network', () => {
  const b = fixture(); b.nav.beginReturnTo(REF);
  const runtime = requireHere(join(directory, 'config/runtime.js')), oldMode = runtime.mode;
  try {
    runtime.mode = 'disabled'; let error;
    b.auth.login((value) => { error = value; });
    assert.match(error, /未启用联网/); assert.equal(b.wxLogins.length, 0); assert.equal(b.requests.length, 0);
    assert.equal(b.nav.peekReturnTo(), null); assert.equal(b.auth.isLoggedIn(), false);
  } finally { runtime.mode = oldMode; }
});
test('navigation failure falls back home; late old fail never hijacks a newer intent', () => {
  const b = fixture(); b.failNextRoute = true; let result;
  b.nav.openTarget(REF, true, (error) => { result = error; });
  assert.equal(b.routes.at(-1).url, b.nav.HOME); assert.match(result, /返回首页/);
  b.wx.reLaunch = (opts) => { b.routes.push({ method: 'reLaunch', url: opts.url, opts }); };
  b.nav.openTarget(REF, true); const old = b.routes.at(-1).opts; // Deliberately still pending.
  b.nav.beginReturnTo(SEED); const count = b.routes.length; old.fail({});
  assert.equal(b.routes.length, count); assert.equal(b.nav.peekReturnTo(), SEED);
});
test('missing navigation dependency remains a diagnostic error, never swallowed in production', () => {
  const source = readFileSync(join(root, 'miniprogram/utils/auth.js'), 'utf8');
  assert.throws(() => vm.runInNewContext(source, { require(id) { if (id === './navigation') throw Error('navigation missing'); return {}; } }), /navigation missing/);
});

// ---------------------------------------------------------------------------
// GY-I04 6-A：受保护页的「去登录」只允许一套口径 —— 与 page-gate 同一路径
// （auth.requireLogin：登记本页为返回目标 → reLaunch 登录页 → 登录后回原页）。
// 历史并列实现里的第二套口径（favorites/history/historydetail/profile 的 onLogin
// 直接 navigateTo／reLaunch 登录页）会把登录页 push 进返回栈，且按钮自己不登记目标
// ⇒ 登录成功后停在默认页 HOME。门禁拦截语义不因统一而放宽：登录前不得跳向任何受保护目标。
// ---------------------------------------------------------------------------
const LOGIN_ENTRY_PAGES = [
  ['favorites', null], ['history', null], ['profile', null], ['messages', null],
  ['community', null], ['communitycreate', null],
  ['historydetail', { id: '6b1d0f2a-3c4e-4f50-8a91-2b3c4d5e6f70' }],
  ['communitydetail', { id: '0a9f8e7d-6c5b-4a39-8271-6f5e4d3c2b1a' }],
];
for (const [name, options] of LOGIN_ENTRY_PAGES) {
  test(`${name}: guest 去登录 shares the gate path with its own return target`, () => {
    const b = fixture();
    const page = b.page(name);
    if (options) page.options = options;
    const route = `pages/${name}/${name}`;
    const own = '/' + route + (options ? `?id=${options.id}` : '');
    page.onShow();
    // 门禁失败必须保持游客态；无会话时不得发起任何业务读取。
    assert.equal(page.data.guest === true || page.data.gatePassed === false, true, 'guest gate must fail closed');
    assert.equal(b.requests.length, 0);
    // ① 页面必须提供「去登录」处理，且该处理与门禁同一路径（reLaunch 清栈，不 push 登录页）。
    assert.equal(typeof page.onLogin, 'function', '页面必须提供「去登录」处理');
    page.onLogin();
    assert.equal(b.routes.at(-1).url, b.nav.LOGIN);
    assert.equal(b.routes.at(-1).method, 'reLaunch', '登录页不得被 push 进返回栈');
    assert.equal(b.nav.peekReturnTo(), own, '去登录必须登记本页为返回目标');
    assert.ok(b.routes.every((entry) => entry.url === b.nav.LOGIN), '登录前不得跳向任何受保护目标');
    // ② 返回目标必须由按钮自己登记：上一次意图（门禁登记 / 登录页离页 / 退出）失效后，
    //    点「去登录」仍须回本页，而不是因为目标为空而停在默认页。
    b.nav.clearReturnTo();
    page.onLogin();
    assert.equal(b.nav.peekReturnTo(), own, '按钮必须自己登记返回目标');
    const id = b.login();
    assert.equal(b.auth.resumeAfterLogin(id), true);
    const last = b.routes.at(-1);
    assert.equal(last.url, own, '登录成功后必须回到原页');
    assert.notEqual(last.url, b.nav.HOME, '不得停在默认页');
    assert.equal(last.method, b.nav.TAB_PAGES.indexOf(route) !== -1 ? 'switchTab' : 'reLaunch');
    assert.equal(b.nav.peekReturnTo(), null, '返回目标一次性消费');
  });
}

const detailCases = [
  ['referencedetail', 'gy-i03-hb-001', 'detail'],
  ['referenceseeddetail', 'gy-i07-seed-hb-001', 'item'],
];
for (const [name, id, resultKey] of detailCases) {
  for (const order of [[0, 1], [1, 0]]) {
    test(`${name}: cold cached onLoad→onShow retains one loader; response order ${order}`, async () => {
      const b = fixture(); b.storage.set('gengyun.session', cache());
      const page = b.page(name); page.options = { id };
      let loads = 0; const load = page.load; page.load = function (...args) { loads++; return load.apply(this, args); };
      page.onLoad({ id }); page.onShow();
      assert.equal(b.requests.length, 1, 'normal lifecycle must share the callback-bearing verification');
      assert.equal(page.data.gatePassed, false); assert.equal(page.data[resultKey], null);
      // An independent same-session verification may settle before or after the lifecycle request.
      b.auth.verifySession(); assert.equal(b.requests.length, 2);
      for (const n of order) verified(b.requests[n]);
      await settled(b, page);
      // 详情本体照常装载；两页共有：认证通过、found、实体、单 loader、无路由跳转。
      assert.equal(b.auth.isLoggedIn(), true); assert.equal(page.data.gatePassed, true);
      assert.equal(page.data.found, true); assert.ok(page.data[resultKey]);
      // 仅 referencedetail 含档案读取与用量资格断言；referenceseeddetail 无 profile 依赖。
      if (name === 'referencedetail') {
        assert.equal(b.profileReads.length, 1);
        assert.equal(page.data.profileConfirmed, false); assert.equal(page.data.profileContext, null);
        assert.equal(page.data.doseCard, null); assert.equal(page.data.applicability, null);
      }
      assert.equal(loads, 1);
      assert.equal(b.routes.length, 0);
    });
  }
  test(`${name}: hidden/unloaded late success cannot load; re-entry verifies and loads once`, async () => {
    for (const lifecycle of ['onHide', 'onUnload']) {
      const b = fixture(); b.storage.set('gengyun.session', cache()); const page = b.page(name); page.options = { id };
      let loads = 0; const load = page.load; page.load = function (...args) { loads++; return load.apply(this, args); };
      page.onLoad({ id }); page.onShow(); const old = b.requests[0]; page[lifecycle]();
      verified(old); await settled(b, page);
      assert.equal(page.data.gatePassed, false); assert.equal(page.data[resultKey], null); assert.equal(loads, 0);
      page.onShow(); assert.equal(b.requests.length, 2); verified(b.requests[1]);
      await settled(b, page);
      assert.equal(page.data.gatePassed, true); assert.equal(page.data.found, true); assert.equal(loads, 1);
    }
  });
  test(`${name}: old failure after re-entry cannot clear the new verified detail`, async () => {
    const b = fixture(); b.storage.set('gengyun.session', cache()); const page = b.page(name); page.options = { id };
    page.onLoad({ id }); page.onHide(); page.onShow(); verified(b.requests[1]);
    await settled(b, page);
    b.requests[0].success({ statusCode: 401, data: {} });
    await settled(b, page);
    assert.equal(page.data.gatePassed, true); assert.equal(page.data.found, true);
    assert.ok(page.data[resultKey]); assert.equal(b.auth.isLoggedIn(), true); assert.equal(b.routes.length, 0);
  });
  test(`${name}: clear/account/logout/new intent invalidate pending actual-page load`, () => {
    for (const action of ['clear', 'account', 'logout', 'new-intent']) {
      const b = fixture(); b.storage.set('gengyun.session', cache()); const page = b.page(name); page.options = { id };
      page.onLoad({ id }); page.onShow(); const old = b.requests[0];
      if (action === 'clear') b.auth.clearSession();
      else if (action === 'account') b.auth.setSession(cache('new-account'));
      else if (action === 'logout') b.auth.logout();
      else b.nav.beginReturnTo(SEED);
      verified(old); assert.equal(page.data.gatePassed, false); assert.equal(page.data.found, false);
      assert.equal(page.data[resultKey], null);
    }
  });
  test(`${name}: rejected/network-failed startup keeps data gated and captures original ID`, () => {
    for (const status of [401, 503, 'network']) {
      const b = fixture(); b.storage.set('gengyun.session', cache()); const page = b.page(name); page.options = { id };
      page.onLoad({ id }); page.onShow(); assert.equal(b.requests.length, 1);
      if (status === 'network') b.requests[0].fail({}); else b.requests[0].success({ statusCode: status, data: {} });
      assert.equal(page.data.gatePassed, false); assert.equal(page.data[resultKey], null);
      assert.equal(b.nav.peekReturnTo(), `/pages/${name}/${name}?id=${id}`);
      assert.equal(b.routes.at(-1).url, b.nav.LOGIN);
    }
  });
}
for (const [name, key] of [['reference', 'items'], ['referenceseed', 'list']]) {
  test(`${name}: cached startup also shares verification and renders actual catalog`, () => {
    const b = fixture(); b.storage.set('gengyun.session', cache()); const page = b.page(name);
    page.onLoad(); page.onShow(); assert.equal(b.requests.length, 1); assert.equal(page.data[key].length, 0);
    verified(b.requests[0]); assert.equal(page.data.gatePassed, true); assert.ok(page.data[key].length > 0);
    page.onHide(); assert.equal(page.data[key].length, 0); page.onShow(); verified(b.requests[1]); assert.ok(page.data[key].length > 0);
  });
}
for (const stage of ['wx', 'server']) {
  for (const oldFirst of [true, false]) {
    test(`login hide/show retries after cancelled ${stage}; old completion first=${oldFirst}`, () => {
      const b = fixture(); b.nav.beginReturnTo(REF); const page = b.page('login'); page.onShow(); page.login();
      const oldWx = b.wxLogins[0]; if (stage === 'server') oldWx.success({ code: 'synthetic-old' });
      const oldRequest = b.requests[0]; page.onHide(); assert.equal(page.data.busy, false);
      page.onShow(); b.nav.beginReturnTo(SEED); page.login(); assert.equal(b.wxLogins.length, 2); assert.equal(page.data.busy, true);
      const oldDone = () => stage === 'wx' ? oldWx.success({ code: 'synthetic-old' }) : oldRequest.success({ statusCode: 200, data: { data: { access_token: 'old', audience: 'user', expires_at: future() }, meta: { execution_mode: 'stub' } } });
      const newDone = () => {
        b.wxLogins[1].success({ code: 'synthetic-new' });
        b.requests.at(-1).success({ statusCode: 200, data: { data: { access_token: 'new', audience: 'user', expires_at: future() }, meta: { execution_mode: 'stub' } } });
      };
      if (oldFirst) { oldDone(); assert.equal(page.data.busy, true); assert.equal(b.auth.isLoggedIn(), false); }
      newDone(); if (!oldFirst) oldDone();
      assert.equal(page.data.busy, false); assert.equal(page.data.loggedIn, true);
      assert.equal(b.auth.getSession().accessToken, 'new'); assert.equal(b.routes.at(-1).url, SEED);
      assert.equal(b.nav.peekReturnTo(), null);
    });
  }
}

// ---------------------------------------------------------------------------
// GY-I04 6-A 追加单 N1（对抗性审查报告 §4 N1）：门禁核实**失败或在途**时点「去登录」
// 此前无任何可见反应（页面停在游客态，需离开重进）。最小修法＝按钮回调在核实成功（ok）
// 时重跑本页门禁 ⇒ 页面可见地放行。覆盖：
//   ① 门禁那一轮核实仍在途时点按钮 ⇒ 本次核实通过后必须重跑门禁并放行本页；
//      门禁第 1 轮的迟到响应不得关闭已放行的页面；
//   ② 护栏（改前即绿，防「提示但放行」）：核实失败时按钮只去登录页，绝不放行、无业务请求。
// ---------------------------------------------------------------------------
// 覆盖页并集（8 页）＝ #176 6-A 的 favorites/history/profile/messages/communitycreate/
//   historydetail ＋ 切片 E 的 community/communitydetail（guest 族，无 gatePassed 字段）。
const N1_PAGES = [['favorites', null], ['history', null], ['profile', null], ['messages', null],
  ['communitycreate', null], ['historydetail', { id: 'c4d5e6f7-0a1b-4c2d-9e3f-4a5b6c7d8e9f' }],
  ['community', null], ['communitydetail', { id: 'c4d5e6f7-0a1b-4c2d-9e3f-4a5b6c7d8e9f' }]];
// 门禁放行判据：gatePassed 页看 gatePassed，guest 页看 !guest。
const opened = (page) => page.data.gatePassed === undefined ? page.data.guest === false : page.data.gatePassed === true;
for (const [name, options] of N1_PAGES) {
  test(`${name}: 门禁在途时点「去登录」⇒ 核实成功后本页可见放行（N1）`, () => {
    const b = fixture();
    b.storage.set('gengyun.session', cache());
    const page = b.page(name);
    if (options) { page.options = options; page._query = { valid: true, id: options.id, ignored: [] }; }
    page.onShow();                                  // 门禁第 1 轮核实（在途，先不回答）
    assert.equal(b.requests.length, 1); assert.equal(b.requests[0].url.endsWith('/auth/session'), true);
    assert.equal(opened(page), false, '核实在途时仍是游客态（fail-closed）');
    page.onLogin();                                 // 在途时点「去登录」
    assert.equal(b.requests.length, 2, '按钮自己发起一次核实');
    verified(b.requests[1]);                        // 服务端确认会话有效 ⇒ 必须出现可见反馈
    assert.equal(b.requests.length, 3, '核实成功后必须重跑本页门禁（可见放行），不得静默无反应');
    verified(b.requests[2]);                        // 重跑的门禁核实通过
    assert.equal(opened(page), true, '页面必须可见放行');
    assert.equal(b.nav.peekReturnTo(), null, '放行后不得留下待返回目标');
    assert.ok(b.routes.every((entry) => entry.url === b.nav.LOGIN), '不得跳向任何受保护目标');
    assert.ok(b.requests.every((entry) => entry.url.endsWith('/auth/session')), '门禁之前不得发生业务请求');
    verified(b.requests[0]);                        // 门禁第 1 轮的迟到响应（已被取代）
    assert.equal(opened(page), true, '迟到的门禁核实不得关闭已放行的页面');
  });
  test(`${name}: 核实失败时点「去登录」只去登录页，可见且不放行（N1 护栏）`, () => {
    for (const outcome of ['rejected', 'network']) {
      const b = fixture();
      b.storage.set('gengyun.session', cache());
      const page = b.page(name);
      if (options) { page.options = options; page._query = { valid: true, id: options.id, ignored: [] }; }
      page.onShow();
      const first = b.requests[0];
      if (outcome === 'network') first.fail({}); else first.success({ statusCode: 401, data: {} });
      assert.equal(opened(page), false);
      page.onLogin();                                       // 点「去登录」
      const last = b.requests.at(-1);
      if (last !== first) {                                 // 网络失败不清会话 ⇒ 按钮再核实一次
        assert.equal(last.url.endsWith('/auth/session'), true);
        if (outcome === 'network') last.fail({}); else last.success({ statusCode: 401, data: {} });
      }
      assert.equal(b.routes.at(-1).url, b.nav.LOGIN, '核实失败必须去登录页（可见反馈）');
      assert.equal(b.routes.at(-1).method, 'reLaunch');
      assert.equal(opened(page), false, '不得因点按钮而放行');
      assert.ok(b.requests.every((entry) => entry.url.endsWith('/auth/session')), '不得发生业务请求');
    }
  });
}
// 负控制：登记的说明符是**完整且唯一**的。把真实 page-gate 源码的 `require('./auth')` 换成相近写法
// （`./auth.js`／`./Auth`／`./utils/auth`／`./auth/`／`../utils/auth`）后重跑**本站点自己的**装载器
// ⇒ 必须显式失败并带原名，不得近似命中（改前是 blanket `require: () => b.auth`，且返回**真实模块**：
// 这些写法都会被静默喂成真实 auth，用例照样绿、看着在测真实门禁）。
test('page-gate 未登记说明符：显式失败并带名，零近似命中', () => {
  const gateSource = readFileSync(join(root, 'miniprogram/utils/page-gate.js'), 'utf8');
  assert.ok(gateSource.includes("require('./auth')"), '真实源码的 require 说明符变了，登记表须同步');
  assert.doesNotThrow(() => fixture().page('home', { gateSource }), '已登记项必须照常装载');
  for (const spec of ['./auth.js', './Auth', './utils/auth', './auth/', '../utils/auth']) {
    assert.throws(() => fixture().page('home', { gateSource: gateSource.replace("require('./auth')", "require('" + spec + "')") }),
      new RegExp('Unexpected page dependency ' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
      '近似说明符 ' + spec + ' 未被显式拒绝');
  }
});
