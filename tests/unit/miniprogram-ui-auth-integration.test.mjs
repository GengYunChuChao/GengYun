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
  /**
   * 载入真实自定义组件并实例化（路径相对 `miniprogram/`，如 `custom-tab-bar/index.js`）。
   * 同一个 harness 内每个组件只建一次：模块缓存会把 `Component` 回调吞掉，故先清掉该路径缓存。
   * 组件方法与 `pageLifetimes` 直接挂在实例上，`bar.pageLifetimes.show.call(bar)` 可用。
   */
  function component(relative) {
    let definition;
    context.Component = (value) => { definition = value; };
    const full = resolve(root, 'miniprogram', relative);
    cache.delete(full);
    load(full);
    const instance = { ...definition, ...definition.methods, data: { ...definition.data } };
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
  return { auth, page, component, seedCache, acceptVerification, login, requests, launches, tabs, toasts, load, setSystemPx: (px) => { systemPx = px; }, getApp: () => app };
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
  const h = harness();
  const bar = h.component('custom-tab-bar/index.js');
  assert.deepEqual(Array.from(bar.data.tabs, tab => tab.text), ['首页','社区','识别','消息','我的']);
  for (const item of bar.data.tabs) bar.switchTab({ currentTarget: { dataset: { path: item.pagePath } } });
  assert.equal(h.tabs.length, 5);
  bar.switchTab({ currentTarget: { dataset: { path: 'pages/login/login?token=synthetic' } } });
  assert.equal(h.tabs.length, 5);
  // 未登录：角标刷新不发请求、也不显示数字（未读数不得用 0 或缓存顶替）。
  assert.equal(bar.data.unreadText, '');
  bar.pageLifetimes.show.call(bar);
  assert.equal(bar.data.unreadText, '');
  assert.equal(h.requests.length, 0, '未登录时角标不得发起任何请求');
});

// ---------------------------------------------------------------------------
// GY-I17（#17）消息读面 + 未读角标：真实页面 / 真实适配层 / 真实 custom-tab-bar 一起验。
// 合成 wx 只记录请求，由用例逐条应答后核对页面状态；**不是**微信工具或真机证据。
// 覆盖：未登录零请求（门禁）、已登录 + stub 下 3 条 operation 的真实调用、
// real 未接线 503 与空态**可分辨**、以及未读数 N ⇒ 角标 N、读后归零。
// ---------------------------------------------------------------------------
const MESSAGE = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const READ_MESSAGE = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b';
const message = (over = {}) => ({
  id: MESSAGE, revision: 1, type: 'moderation', target_ref: { type: 'post', id: 'post-1', revision: 2 },
  reference_state: 'unavailable', read_at: null, created_at: '2026-10-16T04:00:00.000Z', ...over,
});
const messageEnvelope = (data, mode = 'stub') => ({
  data, meta: { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: mode },
});
const messageError = (code) => ({
  error: { code, message: 'm', retryable: false, details: [] },
  meta: { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' },
});
const flush = async (times = 8) => { for (let i = 0; i < times; i += 1) await Promise.resolve(); };
const pathOf = (request) => request.url.replace('https://synthetic.invalid/api/v1', '');
/** 门禁核实通过、页面已发出「列表」与「未读数」两条真实读取请求。 */
async function openedMessagesPage(h) {
  const bar = h.component('custom-tab-bar/index.js');
  const page = h.page('messages');
  page.getTabBar = () => bar;
  page.onLoad();
  page.onShow();
  assert.equal(h.requests.length, 1, '门禁之前只允许会话核实请求');
  assert.ok(h.requests[0].url.endsWith('/auth/session'));
  h.acceptVerification(h.requests[0]);
  await flush();
  return { page, bar };
}

test('消息页：未登录 ⇒ 门禁拦截、零请求（页面与角标都不发请求）', () => {
  const h = harness();
  const bar = h.component('custom-tab-bar/index.js');
  const page = h.page('messages');
  page.getTabBar = () => bar;
  page.onLoad();
  page.onShow();
  assert.equal(page.data.guest, true, '无会话时必须停在游客态');
  assert.equal(h.requests.length, 0, '未登录不得发生任何请求（含消息与未读数）');
  assert.deepEqual(h.launches, ['/pages/login/login'], '门禁拦截口径与识别/社区/我的一致');
  bar.pageLifetimes.show.call(bar);
  assert.equal(bar.data.unreadText, '');
  assert.equal(h.requests.length, 0, '未登录时角标不得发起请求');
});

test('消息页：已登录 + stub ⇒ 真实调用 3 条 operation；未读数 N ⇒ 角标 N、读后归零', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0; // 登录本身（/auth/wechat）已由上面的用例单独覆盖
  const { page, bar } = await openedMessagesPage(h);
  assert.deepEqual(h.requests.slice(1).map((request) => request.method + ' ' + pathOf(request)),
    ['GET /messages', 'GET /messages/unread-count'], '门禁放行后按契约读取列表与派生未读数');

  h.requests[1].success({ statusCode: 200, data: messageEnvelope({ items: [
    message(), message({ id: READ_MESSAGE, revision: 2, read_at: '2026-10-16T05:00:00.000Z' }), ], next_cursor: null }) });
  h.requests[2].success({ statusCode: 200, data: messageEnvelope({ count: 1 }) });
  await flush();
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.items.length, 2);
  assert.equal(page.data.items[0].unread, true, 'read_at === null ⇒ 未读');
  assert.equal(page.data.items[0].label, '内容审核结果', '按契约 type 闭集呈现固定标签（契约无正文）');
  assert.equal(page.data.items[1].unread, false);
  assert.match(page.data.items[0].referenceNote, /不可查看/, '目标不可用时如实说明且不提供跳转');
  assert.equal(page.data.unreadNote, '未读 1 条');
  assert.equal(bar.data.unreadText, '1', '角标显示服务端派生的未读数');

  // 第 3 条 operation：标记已读（幂等键 + 目标当前强 ETag；契约无请求体）。
  page.onMarkRead({ currentTarget: { dataset: { id: MESSAGE, revision: 1 } } });
  const mark = h.requests.at(-1);
  assert.equal(mark.method, 'PUT');
  assert.equal(pathOf(mark), '/messages/' + MESSAGE + '/read');
  assert.equal(mark.header['If-Match'], '"1"');
  assert.ok(mark.header['Idempotency-Key'].length >= 8 && mark.header['Idempotency-Key'].length <= 128);
  assert.equal(mark.data, undefined);
  mark.success({ statusCode: 200, data: messageEnvelope(message({ revision: 2, read_at: '2026-10-16T06:00:00.000Z' })) });
  await flush();
  const count = h.requests.at(-1);
  assert.equal(pathOf(count), '/messages/unread-count', '标记成功后重新读取派生未读数（本地不递减）');
  count.success({ statusCode: 200, data: messageEnvelope({ count: 0 }) });
  await flush();
  assert.equal(page.data.items[0].unread, false, '只采信服务端返回的 read_at');
  assert.equal(page.data.items[0].revision, 2, '只采信服务端返回的 revision');
  assert.equal(page.data.unreadNote, '暂无未读');
  assert.equal(bar.data.unreadText, '', '读后归零 ⇒ 角标不再显示数字');
});

test('消息页：real 未接线 503 ⇒ 提示「服务未接线」，绝不显示成「暂无消息」', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page, bar } = await openedMessagesPage(h);
  h.requests[1].success({ statusCode: 503, data: messageError('PROVIDER_UNAVAILABLE') });
  h.requests[2].success({ statusCode: 503, data: messageError('PROVIDER_UNAVAILABLE') });
  await flush();
  assert.equal(page.data.status, 'error', '未接线必须落在错误态，不得落空态');
  assert.match(page.data.stateTitle, /未接线/);
  assert.match(page.data.stateDesc, /未接线/);
  assert.equal(page.data.items.length, 0);
  assert.doesNotMatch(JSON.stringify(page.data), /暂无消息/, '不可用不得被渲染成「暂无消息」');
  assert.match(page.data.unreadNote, /未读数未取得/);
  assert.equal(bar.data.unreadText, '', '未读数取不到 ⇒ 不显示数字（不显示 0）');
  // 结构护栏：「暂无消息」只允许出现在 empty 分支；error 分支不得复用空态文案。
  const wxml = readFileSync(resolve(root, 'miniprogram/pages/messages/messages.wxml'), 'utf8');
  const errorBranch = wxml.indexOf('status === \'error\'');
  const emptyBranch = wxml.indexOf('status === \'empty\'');
  assert.ok(errorBranch !== -1 && emptyBranch !== -1 && errorBranch < emptyBranch, '错误分支必须先于空态分支判定');
  assert.ok(wxml.slice(errorBranch, emptyBranch).includes('暂无消息') === false, '错误分支不得出现「暂无消息」');
});

test('消息页：服务端返回 0 条 ⇒ 空态（与「服务未接线」可分辨）', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page, bar } = await openedMessagesPage(h);
  h.requests[1].success({ statusCode: 200, data: messageEnvelope({ items: [], next_cursor: null }) });
  h.requests[2].success({ statusCode: 200, data: messageEnvelope({ count: 0 }) });
  await flush();
  assert.equal(page.data.status, 'empty');
  assert.equal(page.data.items.length, 0);
  assert.equal(page.data.unreadNote, '暂无未读');
  assert.equal(bar.data.unreadText, '');
  assert.equal(page.data.stateTitle, '', '空态不借用错误态标题（空 ≠ 不可用）');
});

test('未读角标：>99 显示 99+；取不到时不显示数字（不显示 0、不保留过期值）', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const bar = h.component('custom-tab-bar/index.js');
  bar.pageLifetimes.show.call(bar);
  assert.equal(pathOf(h.requests.at(-1)), '/messages/unread-count');
  h.requests.at(-1).success({ statusCode: 200, data: messageEnvelope({ count: 150 }) });
  await flush();
  assert.equal(bar.data.unreadText, '99+');
  bar.pageLifetimes.show.call(bar);
  h.requests.at(-1).success({ statusCode: 503, data: messageError('PROVIDER_UNAVAILABLE') });
  await flush();
  assert.equal(bar.data.unreadText, '', '取不到未读数时不显示任何数字');
});
