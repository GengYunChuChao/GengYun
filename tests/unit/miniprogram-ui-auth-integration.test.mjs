import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';

// 离线运行实际页面及 main 的 auth 模块，防止界面合并丢失游客门禁和退出行为。
// 合成 wx 只记录请求，绝不外发；不作为微信工具或真机证据。
const root = resolve(import.meta.dirname, '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
function harness() {
  const storage = new Map();
  const requests = [], launches = [], tabs = [], navigates = [], toasts = [];
  // G3（#17）：沙箱里换成记录型 console，用来断言「失败不吞错」那条结构化告警
  // （事件名 + 错误码），而不是让页面把告警打穿到测试输出里。
  const warns = [];
  const consoleSink = { warn: (entry) => warns.push(entry), log: () => {}, info: () => {}, error: () => {} };
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
    navigateTo: (options) => navigates.push(options.url),
    showModal: (options) => options.success({ confirm: true }),
    showToast: (options) => toasts.push(options.title),
    getAppBaseInfo: () => ({ fontSizeSetting: systemPx }),
    getSystemInfoSync: () => ({ fontSizeSetting: 16 })
  };
  let systemPx = 20;
  let app = { globalData: { fontScale: 1.25 } };
  const context = { wx, getApp: () => app, App: (value) => { app = value; }, console: consoleSink };
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
  // 并集：合并两侧对同一 helper 的改动 —— #191 的 `component` 与 upstream(#188/#190) 的 `navigates` 都在，字段一个不丢。
  return { auth, page, component, seedCache, acceptVerification, login, requests, launches, tabs, navigates, toasts, warns, load, setSystemPx: (px) => { systemPx = px; }, getApp: () => app };
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

// GY-I12：首页能力卡的目标由 `data-key` 决定（语音/问答卡不再被送进识别页）。
const homeEntryTap = (key) => ({ currentTarget: { dataset: key === undefined ? {} : { key } } });

test('首页能力卡按 data-key 分派：语音/问答卡进播报页，识别卡按现状进识别 Tab', () => {
  const h = harness();
  h.login();
  const page = h.page('home');
  page.onShow();
  h.acceptVerification(h.requests.at(-1));
  page.onEntryTap(homeEntryTap('weed'));
  h.acceptVerification(h.requests.at(-1));
  assert.deepEqual(h.tabs, ['/pages/identify/identify'], '拍草识别卡仍进识别 Tab');
  page.onEntryTap(homeEntryTap('ocr'));
  h.acceptVerification(h.requests.at(-1));
  assert.deepEqual(h.tabs, ['/pages/identify/identify', '/pages/identify/identify'], '农药标签识别卡按现状进识别 Tab');
  assert.deepEqual(h.navigates, [], '前两张卡不跳任何非 Tab 页');
  page.onEntryTap(homeEntryTap('voice'));
  h.acceptVerification(h.requests.at(-1));
  assert.deepEqual(h.navigates, ['/pages/voice/voice'], '语音/问答卡进播报页，不再进识别页');
  assert.equal(h.tabs.length, 2, '语音卡不得再进识别 Tab');
});

test('未登录点语音卡与识别卡同口径被拦：引导登录页，不放行播报页', () => {
  const h = harness();
  const nav = h.load(resolve(root, 'miniprogram/utils/navigation.js'));
  const page = h.page('home');
  page.onLoad();
  page.onShow();
  assert.equal(page.data.guest, true);
  assert.equal(h.requests.length, 0);
  page.onEntryTap(homeEntryTap('weed'));
  assert.equal(nav.peekReturnTo(), '/pages/identify/identify', '识别卡未登录时记下识别页为回跳目标');
  page.onEntryTap(homeEntryTap('voice'));
  assert.deepEqual(h.launches, ['/pages/login/login', '/pages/login/login'], '两张卡未登录时同口径引导到独立登录页');
  assert.deepEqual(h.navigates, [], '未登录不得放行播报页');
  assert.deepEqual(h.tabs, [], '未登录不得放行任何 Tab');
  assert.equal(nav.peekReturnTo(), '/pages/voice/voice', '登录后应回到播报页而不是识别页');
});

test('home.wxml：能力卡逐一透传既有 key（未新增 key、未改导航白名单语义）', () => {
  const wxml = read('miniprogram/pages/home/home.wxml');
  const js = read('miniprogram/pages/home/home.js');
  assert.match(wxml, /data-key="\{\{item\.key\}\}"/, '能力卡需把既有 key 透传给 onEntryTap');
  assert.match(wxml, /bindtap="onEntryTap"/, '能力卡仍绑 onEntryTap');
  assert.deepEqual([...js.matchAll(/key: '([a-z]+)'/g)].map((m) => m[1]), ['weed', 'ocr', 'voice'], '沿用既有 key 体系，不新造 key');
  const nav = harness().load(resolve(root, 'miniprogram/utils/navigation.js'));
  assert.ok(nav.PAGES.includes('pages/voice/voice'), '播报页已在既有导航白名单内');
  assert.ok(!nav.TAB_PAGES.includes('pages/voice/voice'), '播报页不是底部 Tab（应按 navigateTo 打开）');
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
/**
 * G3（#17）：取 messages.wxml 里那条**承载未读数重试**的标签（含标签自身的属性文本）。
 * 用于核两件事：绑定的是 `onRetryUnread`，以及它被 `wx:if="{{unreadFailed}}"` 独占
 * —— 成功态在模板上根本渲染不出重试入口，而不是靠 CSS 隐藏。
 */
function unreadRetryTag(wxml) {
  const at = wxml.indexOf('bindtap="onRetryUnread"');
  if (at === -1) return null;
  return wxml.slice(wxml.lastIndexOf('<', at), wxml.indexOf('>', at) + 1);
}
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
  // G3（#17）**断言订正**：本条原先只锁定「未取得 ＋ 不显示数字」，等于把「失败即终点」
  // 固化成预期 —— 页面此后走到哪儿都不再有出口。现把同一条用例改成断言「重试真的接线了」：
  // 失败标记点亮、出口是函数、模板里唯一的重试绑定由失败态独占（不是删断言，是换掉断言的对象）。
  assert.equal(page.data.unreadFailed, true, '未读数失败必须点亮失败标记（它决定是否渲染重试）');
  assert.equal(typeof page.onRetryUnread, 'function', '失败态必须暴露可点入口 onRetryUnread');
  const wxml = readFileSync(resolve(root, 'miniprogram/pages/messages/messages.wxml'), 'utf8');
  const retryTag = unreadRetryTag(wxml);
  assert.ok(retryTag, '失败态 pill 必须绑定 onRetryUnread（否则失败后无路可走）');
  assert.match(retryTag, /wx:if="\{\{unreadFailed\}\}"/, '重试入口必须由失败态独占渲染（成功态不得出现）');
  assert.equal(wxml.split('bindtap="onRetryUnread"').length - 1, 1, '本页只应有一个未读数重试入口');
  // 失败不吞错：留一条结构化告警，只带 event/code，且不得夹带令牌或手机号。
  assert.equal(h.warns.length, 1, '未读数失败只留一条结构化告警');
  assert.deepEqual(Object.keys(h.warns[0]).sort(), ['code', 'event'], '告警字段只允许 event/code');
  assert.equal(h.warns[0].event, 'messages.unread_count.fetch_failed');
  assert.equal(h.warns[0].code, 'PROVIDER_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(h.warns), /synthetic-token|synthetic-code|\+?\d{11}/, '告警不得携带会话令牌或手机号');
  // 结构护栏：「暂无消息」只允许出现在 empty 分支；error 分支不得复用空态文案。
  const errorBranch = wxml.indexOf('status === \'error\'');
  const emptyBranch = wxml.indexOf('status === \'empty\'');
  assert.ok(errorBranch !== -1 && emptyBranch !== -1 && errorBranch < emptyBranch, '错误分支必须先于空态分支判定');
  assert.ok(wxml.slice(errorBranch, emptyBranch).includes('暂无消息') === false, '错误分支不得出现「暂无消息」');
});

test('消息页：未读数读取成功 ⇒ 成功态没有重试入口，也不把「0 条」写成 0', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page, bar } = await openedMessagesPage(h);
  h.requests[1].success({ statusCode: 200, data: messageEnvelope({ items: [message()], next_cursor: null }) });
  h.requests[2].success({ statusCode: 200, data: messageEnvelope({ count: 0 }) });
  await flush();
  assert.equal(page.data.unreadFailed, false, '成功态不得残留失败标记');
  assert.equal(page.data.retryingUnread, false);
  assert.equal(page.data.unreadNote, '暂无未读');
  assert.equal(page.data.unreadText, '', '0 条不显示数字（未读数是派生量，0 与失败都必须无数字）');
  assert.equal(bar.data.unreadText, '');
  assert.equal(h.warns.length, 0, '成功路径不得打告警');
  // 模板结构：重试只挂在失败分支；成功分支仍是纯展示 pill，一个点击绑定都没有。
  const wxml = readFileSync(resolve(root, 'miniprogram/pages/messages/messages.wxml'), 'utf8');
  const successPill = wxml.split('\n').find((line) => line.includes('pill--gray'));
  assert.ok(successPill, '成功态 pill 必须仍在模板里（失败态不是唯一的 pill）');
  assert.doesNotMatch(successPill, /bindtap|catchtap/, '成功态 pill 不得绑定任何点击（重试只在失败态出现）');
  // 成功态即使被误触也不发请求：出口自己挡在失败标记之外。
  const before = h.requests.length;
  page.onRetryUnread();
  assert.equal(h.requests.length, before, '成功态调用重试入口不得发请求');
});

test('消息页：列表成功＋未读数失败 ⇒ pill 可点重试，且只重读未读数（不整页重载、不清已读状态）', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page, bar } = await openedMessagesPage(h);
  // G3 的原始场景：列表**成功**（页面停在 ready，state-view 的 onRetry 根本不可达），未读数失败。
  h.requests[1].success({ statusCode: 200, data: messageEnvelope({
    items: [message({ id: READ_MESSAGE, revision: 2, read_at: '2026-10-16T05:00:00.000Z' })], next_cursor: null }) });
  h.requests[2].success({ statusCode: 503, data: messageError('PROVIDER_UNAVAILABLE') });
  await flush();
  assert.equal(page.data.status, 'ready', '列表成功 ⇒ 页面常态为 ready（重试入口不在 state-view 里）');
  assert.equal(page.data.unreadFailed, true);
  assert.equal(page.data.unreadText, '', '失败不得兜成 0，也不得保留过期读数');
  assert.equal(bar.data.unreadText, '');
  const itemsBefore = JSON.stringify(page.data.items);
  const before = h.requests.length;

  page.onRetryUnread();
  assert.equal(h.requests.length, before + 1, '一次点击只发一条请求');
  const retry = h.requests.at(-1);
  assert.equal(retry.method + ' ' + pathOf(retry), 'GET /messages/unread-count', '重试只重读未读数，不重发 /messages');
  assert.equal(page.data.status, 'ready', '重试不得整页重载（不清列表、不回到 loading）');
  assert.equal(page.data.retryingUnread, true, '重试在飞期间置标记（用于连点保护与「正在重试…」）');

  retry.success({ statusCode: 200, data: messageEnvelope({ count: 2 }) });
  await flush();
  assert.equal(page.data.retryingUnread, false);
  assert.equal(page.data.unreadFailed, false, '成功后回到成功态');
  assert.equal(page.data.unreadNote, '未读 2 条');
  assert.equal(bar.data.unreadText, '2', '成功后角标恢复数字');
  assert.equal(JSON.stringify(page.data.items), itemsBefore, '重试不得改动已加载列表与已读状态');
});

test('消息页：未读数重试连点只发一次；成功后再失败仍可再次重试', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page, bar } = await openedMessagesPage(h);
  h.requests[1].success({ statusCode: 200, data: messageEnvelope({ items: [message()], next_cursor: null }) });
  h.requests[2].success({ statusCode: 503, data: messageError('PROVIDER_UNAVAILABLE') });
  await flush();
  assert.equal(page.data.unreadFailed, true);

  const before = h.requests.length;
  page.onRetryUnread();
  page.onRetryUnread();
  page.onRetryUnread();
  assert.equal(h.requests.length, before + 1, '连点三次只允许一条重读请求（在飞期间不重复发）');
  h.requests.at(-1).success({ statusCode: 200, data: messageEnvelope({ count: 3 }) });
  await flush();
  assert.equal(page.data.unreadNote, '未读 3 条');
  assert.equal(bar.data.unreadText, '3');
  assert.equal(page.data.unreadFailed, false, '成功后回到成功态（重试入口消失）');

  // 成功后再失败（例如标记已读后重新读取时服务端故障）⇒ 仍要能再点，不是一次性开关。
  page.refreshUnread();
  h.requests.at(-1).success({ statusCode: 503, data: messageError('PROVIDER_UNAVAILABLE') });
  await flush();
  assert.equal(page.data.unreadFailed, true);
  assert.equal(bar.data.unreadText, '', '再次失败 ⇒ 角标回到「不显示数字」');
  const again = h.requests.length;
  page.onRetryUnread();
  assert.equal(h.requests.length, again + 1, '再次失败后仍可重试');
  assert.equal(pathOf(h.requests.at(-1)), '/messages/unread-count');
  assert.equal(h.warns.length, 2, '两次失败各留一条结构化告警（不吞错、不刷屏）');
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

// ---------------------------------------------------------------------------
// GY-I15（#15）消息域链路补口：403 不与 guest 折叠、失效游标重载、
// 未读数并发只采信最后一次、版本冲突后重新同步。全部复用真实页面 / 真实适配层 / 真实状态层。
// ---------------------------------------------------------------------------
test('未读角标（Tab 自读）：并发刷新只采纳最后一次发出的结果，旧读数不得覆盖新读数', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const bar = h.component('custom-tab-bar/index.js');
  bar.pageLifetimes.show.call(bar);
  const first = h.requests.at(-1);
  bar.pageLifetimes.show.call(bar);
  const second = h.requests.at(-1);
  assert.notEqual(first, second, '两次刷新必须是两个独立请求');
  second.success({ statusCode: 200, data: messageEnvelope({ count: 0 }) });
  await flush();
  first.success({ statusCode: 200, data: messageEnvelope({ count: 4 }) });
  await flush();
  assert.equal(bar.data.unreadText, '', '晚到的旧读数不得把角标改回 4');
});

test('消息页：列表 403 SCOPE_DENIED ⇒ 不清会话、落 denied 态（不与 guest 折叠）', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page, bar } = await openedMessagesPage(h);
  assert.equal(page.data.guest, false);
  h.requests[1].success({ statusCode: 403, data: messageError('SCOPE_DENIED') });
  h.requests[2].success({ statusCode: 403, data: messageError('SCOPE_DENIED') });
  await flush();
  assert.equal(h.auth.isLoggedIn(), true, '403 是「登录了但不给」，不得清会话');
  assert.deepEqual(h.launches, [], '403 不得把用户踢去登录页（否则反复登录也过不去）');
  assert.equal(page.data.guest, false, '403 不是游客态');
  assert.equal(page.data.status, 'error');
  assert.equal(page.data.errorCode, 'SCOPE_DENIED', '真实 403 码必须透传到 state-view');
  assert.match(page.data.stateDesc, /无权/);
  assert.doesNotMatch(page.data.stateDesc, /登录状态已失效/, '不得把 403 说成登录失效');
  assert.equal(bar.data.unreadText, '', '403 下未读数不显示任何数字');
  // B7 端到端：把页面真实交给 state-view 组件（真实组件、真实 states 分类）。
  const view = h.component('components/state-view/state-view.js');
  view.setData({
    status: page.data.status, title: page.data.stateTitle, desc: page.data.stateDesc,
    actionText: '重新读取', errorCode: page.data.errorCode,
  });
  view.refresh();
  assert.equal(view.data.effectiveStatus, 'denied', '页面按 error 传入、码是 403 时必须呈现 denied');
  assert.equal(view.data.actionSuppressed, true, 'denied 不提供重试（重试对 403 无效）');
  assert.equal(view.data.retryable, false);
  assert.equal(view.data.kindTag, '没有权限');
});

test('消息页：加载更多遇 INVALID_CURSOR ⇒ 清掉死游标并从第一页重载', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page } = await openedMessagesPage(h);
  h.requests[1].success({ statusCode: 200, data: messageEnvelope({ items: [message()], next_cursor: 'cursor-1' }) });
  h.requests[2].success({ statusCode: 200, data: messageEnvelope({ count: 1 }) });
  await flush();
  assert.equal(page.data.nextCursor, 'cursor-1');
  page.onLoadMore();
  const more = h.requests.at(-1);
  assert.equal(pathOf(more), '/messages?cursor=cursor-1');
  more.success({ statusCode: 400, data: messageError('INVALID_CURSOR') });
  await flush();
  assert.equal(page.data.nextCursor, null, '失效游标必须被清掉，不能留着让人反复点');
  assert.equal(pathOf(h.requests.at(-1)), '/messages', '失效后必须重新从第一页载入');
  h.requests.at(-1).success({ statusCode: 200, data: messageEnvelope({ items: [message()], next_cursor: null }) });
  await flush();
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.loadingMore, false);
  assert.ok(h.toasts.some((title) => /已重新载入/.test(title)), '如实告知列表已重新载入');
});

test('消息页：并发读取未读数只采纳最后一次发出的结果（旧读数不得覆盖新读数）', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page, bar } = await openedMessagesPage(h);
  const firstUnread = h.requests[2];
  page.refreshUnread();
  const secondUnread = h.requests.at(-1);
  assert.notEqual(firstUnread, secondUnread, '两次刷新必须是两个独立请求');
  // 后发的先到：0 条（已读），先发的后到：7 条（过期读数）。
  secondUnread.success({ statusCode: 200, data: messageEnvelope({ count: 0 }) });
  await flush();
  firstUnread.success({ statusCode: 200, data: messageEnvelope({ count: 7 }) });
  await flush();
  assert.equal(bar.data.unreadText, '', '晚到的旧读数不得把角标改回 7');
  assert.equal(page.data.unreadNote, '暂无未读');
});

test('消息页：标记已读 409 REVISION_CONFLICT ⇒ 重新读取列表，拿当前 revision 再试', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page } = await openedMessagesPage(h);
  h.requests[1].success({ statusCode: 200, data: messageEnvelope({ items: [message()], next_cursor: null }) });
  h.requests[2].success({ statusCode: 200, data: messageEnvelope({ count: 1 }) });
  await flush();
  page.onMarkRead({ currentTarget: { dataset: { id: MESSAGE, revision: 1 } } });
  const mark = h.requests.at(-1);
  assert.equal(mark.header['If-Match'], '"1"');
  mark.success({ statusCode: 409, data: messageError('REVISION_CONFLICT') });
  await flush();
  assert.deepEqual(h.requests.slice(-2).map(pathOf), ['/messages', '/messages/unread-count'],
    '版本冲突后必须重新读取列表与派生未读数，不能停在旧版本号上');
  h.requests.slice(-2)[0].success({ statusCode: 200, data: messageEnvelope({ items: [message({ revision: 5 })], next_cursor: null }) });
  h.requests.slice(-1)[0].success({ statusCode: 200, data: messageEnvelope({ count: 1 }) });
  await flush();
  assert.equal(page.data.items[0].revision, 5, '重新读取后本地拿到当前 revision');
  page.onMarkRead({ currentTarget: { dataset: { id: MESSAGE, revision: page.data.items[0].revision } } });
  assert.equal(h.requests.at(-1).header['If-Match'], '"5"', '下一次标记必须带当前 revision，而不是旧的 1');
});

test('消息页：写路径遇 403 ACCOUNT_INACTIVE ⇒ 整页落 denied（不是一句 toast 掩过去）', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page } = await openedMessagesPage(h);
  h.requests[1].success({ statusCode: 200, data: messageEnvelope({ items: [message()], next_cursor: null }) });
  h.requests[2].success({ statusCode: 200, data: messageEnvelope({ count: 1 }) });
  await flush();
  assert.equal(page.data.status, 'ready');
  page.onMarkRead({ currentTarget: { dataset: { id: MESSAGE, revision: 1 } } });
  h.requests.at(-1).success({ statusCode: 403, data: messageError('ACCOUNT_INACTIVE') });
  await flush();
  // 统一层口径：ACCOUNT_INACTIVE 码保留 + 清会话（`auth.RETIRED_SESSION_CODES`）；
  // 页面据此**整页**收口到 denied，而不是留在 ready 上只弹一句 toast。
  assert.equal(page.data.status, 'error', '写路径 403 必须落到失败态');
  assert.equal(page.data.errorCode, 'ACCOUNT_INACTIVE', '码必须是真实 403 码，不得折叠成 SESSION_REQUIRED');
  assert.equal(page.data.guest, false, '403 不走游客态');
  assert.equal(h.auth.isLoggedIn(), false, 'ACCOUNT_INACTIVE 按统一层口径清会话');
  const view = h.component('components/state-view/state-view.js');
  view.setData({ status: page.data.status, title: page.data.stateTitle, desc: page.data.stateDesc, errorCode: page.data.errorCode });
  view.refresh();
  assert.equal(view.data.effectiveStatus, 'denied', '403 码必须呈现 denied 语气');
  assert.equal(view.data.actionSuppressed, true);
});


