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
const REF = '/pages/reference/reference';
const SEED = '/pages/referenceseed/referenceseed';
function fixture() {
  const storage = new Map(), requests = [], modals = [], routes = [], wxLogins = [];
  const b = { storage, requests, modals, routes, wxLogins, pages: [], failNextRoute: false };
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
  b.page = (name) => {
    let def;
    const gateModule = { exports: {} };
    vm.runInNewContext(readFileSync(join(root, 'miniprogram/utils/page-gate.js'), 'utf8'), { module: gateModule, require: () => b.auth });
    vm.runInNewContext(readFileSync(join(root, `miniprogram/pages/${name}/${name}.js`), 'utf8'), {
      Page: (value) => { def = value; }, wx, console,
      require: (id) => id.endsWith('/page-gate') ? gateModule.exports : id.endsWith('/reference') ? requireHere(join(root, 'miniprogram/utils/reference.js')) : id.endsWith('/auth') ? b.auth : id.endsWith('/navigation') ? b.nav : { localEnabled: () => false },
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

const detailCases = [
  ['referencedetail', 'gy-i03-hb-001', 'detail'],
  ['referenceseeddetail', 'gy-i07-seed-hb-001', 'item'],
];
for (const [name, id, resultKey] of detailCases) {
  for (const order of [[0, 1], [1, 0]]) {
    test(`${name}: cold cached onLoad→onShow retains one loader; response order ${order}`, () => {
      const b = fixture(); b.storage.set('gengyun.session', cache());
      const page = b.page(name); page.options = { id };
      let loads = 0; const load = page.load; page.load = function (...args) { loads++; return load.apply(this, args); };
      page.onLoad({ id }); page.onShow();
      assert.equal(b.requests.length, 1, 'normal lifecycle must share the callback-bearing verification');
      assert.equal(page.data.gatePassed, false); assert.equal(page.data[resultKey], null);
      // An independent same-session verification may settle before or after the lifecycle request.
      b.auth.verifySession(); assert.equal(b.requests.length, 2);
      for (const n of order) verified(b.requests[n]);
      assert.equal(b.auth.isLoggedIn(), true); assert.equal(page.data.gatePassed, true);
      assert.equal(page.data.found, true); assert.ok(page.data[resultKey]); assert.equal(loads, 1);
      assert.equal(b.routes.length, 0);
    });
  }
  test(`${name}: hidden/unloaded late success cannot load; re-entry verifies and loads once`, () => {
    for (const lifecycle of ['onHide', 'onUnload']) {
      const b = fixture(); b.storage.set('gengyun.session', cache()); const page = b.page(name); page.options = { id };
      let loads = 0; const load = page.load; page.load = function (...args) { loads++; return load.apply(this, args); };
      page.onLoad({ id }); page.onShow(); const old = b.requests[0]; page[lifecycle]();
      verified(old); assert.equal(page.data.gatePassed, false); assert.equal(page.data[resultKey], null); assert.equal(loads, 0);
      page.onShow(); assert.equal(b.requests.length, 2); verified(b.requests[1]);
      assert.equal(page.data.gatePassed, true); assert.equal(page.data.found, true); assert.equal(loads, 1);
    }
  });
  test(`${name}: old failure after re-entry cannot clear the new verified detail`, () => {
    const b = fixture(); b.storage.set('gengyun.session', cache()); const page = b.page(name); page.options = { id };
    page.onLoad({ id }); page.onHide(); page.onShow(); verified(b.requests[1]);
    b.requests[0].success({ statusCode: 401, data: {} });
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
