import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';

// 离线运行实际页面及 main 的 auth 模块，防止界面合并丢失游客门禁和退出行为。
// 合成 wx 只记录请求，绝不外发；不作为微信工具或真机证据。
const root = resolve(import.meta.dirname, '../..');
function harness() {
  const storage = new Map();
  const requests = [], launches = [], tabs = [], toasts = [];
  const cache = new Map();
  const expires = () => new Date(Date.now() + 3600_000).toISOString();
  const wx = {
    getStorageSync: (key) => storage.get(key) || '',
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    login: (options) => options.success({ code: 'synthetic-code' }),
    request: (options) => requests.push(options),
    reLaunch: (options) => launches.push(options.url),
    switchTab: (options) => tabs.push(options.url),
    showModal: (options) => options.success({ confirm: true }),
    showToast: (options) => toasts.push(options.title),
    getAppBaseInfo: () => ({ fontSizeSetting: systemPx }),
    getSystemInfoSync: () => ({ fontSizeSetting: 16 })
  };
  let systemPx = 20;
  let app = { globalData: { fontScale: 1.25 } };
  const context = { wx, getApp: () => app, App: (value) => { app = value; } };
  function load(path) {
    path = resolve(path);
    if (path.endsWith('config\\runtime.js') || path.endsWith('config/runtime.js')) {
      return { mode: 'local', apiBaseUrl: 'https://synthetic.invalid/api/v1' };
    }
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    const wrapper = runInNewContext('(function(require,module,exports){' + readFileSync(path, 'utf8') + '\n})', context, { filename: path });
    wrapper((relative) => load(resolve(dirname(path), relative + '.js')), module, module.exports);
    return module.exports;
  }
  const auth = load(resolve(root, 'miniprogram/utils/auth.js'));
  function page(name) {
    let definition;
    context.Page = (value) => { definition = value; };
    load(resolve(root, `miniprogram/pages/${name}/${name}.js`));
    const instance = { ...definition, data: { ...definition.data } };
    instance.setData = (patch) => Object.assign(instance.data, patch);
    return instance;
  }
  function seedCache() {
    storage.set('gengyun.session', { accessToken: 'synthetic-token', audience: 'user', expiresAt: expires(), executionMode: 'stub' });
  }
  function acceptVerification(request) {
    request.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: expires() } } });
  }
  function login() {
    auth.login((error) => assert.equal(error, null));
    requests.at(-1).success({ statusCode: 200, data: { data: { access_token: 'synthetic-token', audience: 'user', expires_at: expires() }, meta: { execution_mode: 'stub' } } });
    assert.equal(auth.isLoggedIn(), true);
  }
  return { auth, page, seedCache, acceptVerification, login, requests, launches, tabs, toasts, load, setSystemPx: (px) => { systemPx = px; }, getApp: () => app };
}

for (const name of ['identify', 'community', 'messages', 'profile']) {
  test(`${name}: 只有缓存不能展示登录区，拒绝核实时跳转登录`, () => {
    const h = harness();
    h.seedCache();
    const page = h.page(name);
    page.onLoad();
    page.onShow();
    assert.equal(page.data.guest, true);
    assert.equal(page.data.fontScale, 1.25);
    assert.equal(h.auth.isLoggedIn(), false);
    assert.equal(h.requests.length, 1);
    h.requests[0].success({ statusCode: 401, data: { error: { code: 'AUTH_REQUIRED' } } });
    assert.equal(page.data.guest, true);
    assert.deepEqual(h.launches, ['/pages/login/login']);
  });

  test(`${name}: 服务端核实后展示登录区，再次进入等待核实时关闭入口`, () => {
    const h = harness();
    h.seedCache();
    const page = h.page(name);
    page.onShow();
    h.acceptVerification(h.requests[0]);
    assert.equal(page.data.guest, false);
    page.onShow();
    assert.equal(page.data.guest, true);
    h.acceptVerification(h.requests.filter(r => r.url.endsWith("/auth/session")).at(-1));
    assert.equal(page.data.guest, false);
  });
}

test('首页允许游客预览，登录按钮和功能入口引导到独立登录页', () => {
  const h = harness(), page = h.page('home');
  page.onLoad();
  page.onShow();
  assert.equal(page.data.guest, true);
  assert.equal(h.requests.length, 0);
  assert.equal(h.launches.length, 0);
  page.goLogin();
  page.onEntryTap();
  assert.deepEqual(h.launches, ['/pages/login/login', '/pages/login/login']);
  assert.equal(h.tabs.length, 0);
});

test('首页已核实用户进入识别 Tab，退出后的 onShow 恢复游客', () => {
  const h = harness();
  h.login();
  const page = h.page('home');
  page.onShow();
  h.acceptVerification(h.requests.at(-1));
  assert.equal(page.data.guest, false);
  page.onEntryTap();
  h.acceptVerification(h.requests.at(-1));
  assert.deepEqual(h.tabs, ['/pages/identify/identify']);
  h.auth.clearSession();
  page.onShow();
  assert.equal(page.data.guest, true);
});

test('我的保留 main 的退出调用与撤销未确认提示', () => {
  const h = harness();
  h.login();
  const page = h.page('profile');
  page.onShow();
  h.acceptVerification(h.requests.at(-1));
  page.logout();
  const logout = h.requests.at(-1);
  assert.equal(logout.method, 'POST');
  assert.ok(logout.url.endsWith('/auth/logout'));
  logout.success({ statusCode: 503, data: {} });
  assert.equal(h.auth.isLoggedIn(), false);
  assert.equal(page.data.guest, true);
  assert.deepEqual(h.launches, ['/pages/login/login']);
  assert.deepEqual(h.toasts, ['本地已清，服务端撤销未确认']);
});

test('应用入口同时保留 main 会话读取及 PR 字体缩放', () => {
  const h = harness();
  h.seedCache();
  h.load(resolve(root, 'miniprogram/app.js'));
  h.getApp().onLaunch();
  assert.equal(h.getApp().globalData.session.accessToken, 'synthetic-token');
  assert.equal(h.getApp().globalData.fontScale, 1.25);
  assert.equal(h.auth.isLoggedIn(), false, '读取缓存不构成认证');
});

for (const name of ['identify', 'community', 'messages', 'profile']) {
  test(`${name}: late verification after hide cannot revive protected UI`, () => {
    const h = harness(); h.seedCache(); const page = h.page(name);
    page.onLoad(); page.onShow(); const old = h.requests.at(-1);
    page.onHide(); h.acceptVerification(old);
    assert.equal(page.data.guest, true);
    page.onShow(); assert.equal(h.requests.length, 2);
    h.acceptVerification(h.requests.at(-1)); assert.equal(page.data.guest, false);
    page.onUnload(); assert.equal(page.data.guest, true);
  });
}

test('actual App and page modules refresh font from wx base-info, preserving auth gate and custom Tab', () => {
  const h = harness(); h.load(resolve(root, 'miniprogram/app.js')); h.getApp().onLaunch();
  const page = h.page('home'); const bar = { data: {}, setData(patch) { Object.assign(this.data, patch); } };
  page.route = 'pages/home/home'; page.getTabBar = () => bar;
  page.onLoad(); assert.equal(page.data.fontScale, 1.25);
  h.setSystemPx(16); h.getApp().onShow(); page.onShow();
  assert.equal(page.data.fontScale, 1); assert.equal(bar.data.fontScale, 1);
  assert.equal(bar.data.selected, page.route); assert.equal(page.data.guest, true);
  h.setSystemPx(26); page.onShow();
  assert.equal(page.data.fontScale, 1.3); assert.equal(bar.data.fontScale, 1.3);
  assert.equal(h.getApp().globalData.fontScale, 1.3);
});
test('actual custom Tab accepts only declared route and cannot grant authentication', () => {
  let def; const tabs = [];
  runInNewContext(readFileSync(resolve(root,'miniprogram/custom-tab-bar/index.js'),'utf8'), {
    Component: value => { def = value; }, wx: { switchTab: options => tabs.push(options.url) }
  });
  assert.deepEqual(Array.from(def.data.tabs, tab => tab.text), ['首页','社区','识别','消息','我的']);
  const bar = { ...def.methods };
  for (const item of def.data.tabs) bar.switchTab({ currentTarget: { dataset: { path: item.pagePath } } });
  assert.equal(tabs.length, 5);
  bar.switchTab({ currentTarget: { dataset: { path: 'pages/login/login?token=synthetic' } } });
  assert.equal(tabs.length, 5);
});
