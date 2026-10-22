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
  // 记录型 console（#17 G6）：页面/Tab 的失败告警必须**可观测**，否则「失败被静默」这件事
  // 自身也无法被断言。只收 warn，且不打印到测试输出（否则每次失败用例都刷屏）。
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
  const context = { wx, console: consoleSink, getApp: () => app, App: (value) => { app = value; } };
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
  // 旧断言只锁了文案，等于把「未读数挂了就没有任何可点重试」固化成现状（#17 G3）。
  // 文案断言保留，另加一条：此时 pill 必须真的可点重试。
  assert.equal(page.data.unreadRetryable, true, '未读数取不到时必须留下可点重试入口：pill 自身可点');
  assert.equal(bar.data.unreadText, '', '从未读到过读数 ⇒ 角标仍是空（不写成 0，也不伪造读数）');
  // 结构护栏：「暂无消息」只允许出现在 empty 分支；error 分支不得复用空态文案。
  const wxml = readFileSync(resolve(root, 'miniprogram/pages/messages/messages.wxml'), 'utf8');
  const errorBranch = wxml.indexOf('status === \'error\'');
  const emptyBranch = wxml.indexOf('status === \'empty\'');
  assert.ok(errorBranch !== -1 && emptyBranch !== -1 && errorBranch < emptyBranch, '错误分支必须先于空态分支判定');
  assert.ok(wxml.slice(errorBranch, emptyBranch).includes('暂无消息') === false, '错误分支不得出现「暂无消息」');
});

// ---------------------------------------------------------------------------
// GY-I17（#17）G1 跳转入口 / G3 未读数重试：真实页面 + 真实 utils/navigation + 真实 community-api。
// 合成 wx 只记录请求与跳转，由用例逐条应答后核对；**不是**微信工具或真机证据。
// ---------------------------------------------------------------------------
const POST_ID = '7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c';
const COMMENT_ID = '8d8d8d8d-8d8d-4d8d-8d8d-8d8d8d8d8d8d';
const commentAuthor = () => ({
  display_name: '王秀兰', display_id: 'grower-0042', state: 'active',
  avatar_media_id: null, avatar_media: null, revision: 1,
});
const commentEnvelope = (postId = POST_ID) => messageEnvelope({
  id: COMMENT_ID, revision: 1, post_id: postId, author: commentAuthor(), body: '这季墒情看着不错',
  visibility: 'published', audit_state: 'approved', created_at: '2026-10-16T04:30:00.000Z',
});

test('消息页：列表成功 + 未读数失败 ⇒ pill 可点重试，点一下只重拉未读数', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page, bar } = await openedMessagesPage(h);
  h.requests[1].success({ statusCode: 200, data: messageEnvelope({ items: [message()], next_cursor: null }) });
  h.requests[2].success({ statusCode: 503, data: messageError('PROVIDER_UNAVAILABLE') });
  await flush();
  assert.equal(page.data.status, 'ready', '列表成功就不得落错误态（onRetry 分支因此不可达）');
  assert.equal(page.data.unreadRetryable, true, '未读数失败必须留下可点重试入口');
  assert.match(page.data.unreadNote, /未读数未取得/);
  assert.match(page.data.unreadNote, /点此重试/, '可点态必须在文案里说清楚，不靠颜色猜');

  const before = h.requests.length;
  page.onRetryUnread();
  assert.equal(h.requests.length, before + 1, '点一次重试只补一条请求');
  const retry = h.requests.at(-1);
  assert.equal(pathOf(retry), '/messages/unread-count', '只重读未读数，不重载整个列表');
  retry.success({ statusCode: 200, data: messageEnvelope({ count: 2 }) });
  await flush();
  assert.equal(page.data.unreadNote, '未读 2 条');
  assert.equal(page.data.unreadRetryable, false, '取到读数即收起可点态（不常驻一个无意义的可点 pill）');
  assert.equal(bar.data.unreadText, '2', '重试成功后角标同步');
});

test('消息页：available + post ⇒ 行可点，按既有 navigation 口径跳社区详情页', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page } = await openedMessagesPage(h);
  h.requests[1].success({ statusCode: 200, data: messageEnvelope({ items: [
    message({ target_ref: { type: 'post', id: POST_ID, revision: 3 }, reference_state: 'available' }),
  ], next_cursor: null }) });
  h.requests[2].success({ statusCode: 200, data: messageEnvelope({ count: 0 }) });
  await flush();
  const row = page.data.items[0];
  assert.equal(row.canOpen, true, '服务端判 available 且目标是 post ⇒ 可点');
  assert.equal(row.targetType, 'post');
  assert.match(row.referenceNote, /可查看/, '可点行如实说明可查看');
  assert.match(row.referenceNote, /点这一条进入社区详情/, '入口要写在行内，不另造第二个页面元素');
  page.onOpenTarget({ currentTarget: { dataset: { id: MESSAGE } } });
  assert.deepEqual(h.navigates, ['/pages/communitydetail/communitydetail?id=' + POST_ID],
    '详情页只接 ?id=<帖子 uuid>（app.json 的 pages + utils/navigation ID_PAGES 同一事实）');
  // 结构护栏（冒泡在合成 wx 里无法模拟，故钉在模板上）：行上有且只有一处跳转入口，
  // 行内「标记已读」必须用 catchtap —— 否则点它会一并冒泡到 onOpenTarget 把详情页打开。
  const wxml = readFileSync(resolve(root, 'miniprogram/pages/messages/messages.wxml'), 'utf8');
  assert.equal(wxml.split('bindtap="onOpenTarget"').length - 1, 1, '跳转入口只有行上这一处');
  assert.match(wxml, /catchtap="onMarkRead"/, '「标记已读」用 catchtap，不冒泡到行上的跳转');
  assert.doesNotMatch(wxml, /bindtap="onMarkRead"/, '不得退回 bindtap（会同时触发跳转）');
});

test('消息页：available + comment ⇒ 先按契约取评论的 post_id，再跳详情页（不把评论 id 当帖子 id）', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page } = await openedMessagesPage(h);
  h.requests[1].success({ statusCode: 200, data: messageEnvelope({ items: [
    message({ target_ref: { type: 'comment', id: COMMENT_ID, revision: 1 }, reference_state: 'available' }),
  ], next_cursor: null }) });
  h.requests[2].success({ statusCode: 200, data: messageEnvelope({ count: 0 }) });
  await flush();
  const row = page.data.items[0];
  assert.equal(row.canOpen, true, '评论目标同样可点（服务端会判 available）');
  assert.equal(row.targetType, 'comment');
  page.onOpenTarget({ currentTarget: { dataset: { id: MESSAGE } } });
  const lookup = h.requests.at(-1);
  assert.equal(lookup.method, 'GET');
  assert.equal(pathOf(lookup), '/comments/' + COMMENT_ID, '按契约 GET /comments/{id} 取所属帖子');
  assert.equal(h.navigates.length, 0, '帖子 id 还没拿到，不得先跳');
  lookup.success({ statusCode: 200, data: commentEnvelope(POST_ID) });
  await flush();
  assert.deepEqual(h.navigates, ['/pages/communitydetail/communitydetail?id=' + POST_ID],
    '跳的是评论所属的帖子，不是评论 id 本身');
});

test('消息页：目标不可用或评论取不到 ⇒ 不跳转、不猜（提示不暗示对方是否删除）', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page } = await openedMessagesPage(h);
  h.requests[1].success({ statusCode: 200, data: messageEnvelope({ items: [
    // 1) 服务端判不可用（unavailable 是 14 型未接线目标的恒态，客户端不按类型猜语义）
    message({ target_ref: { type: 'species', id: 'species-1', revision: 1 }, reference_state: 'unavailable' }),
    // 2) 服务端判可查看，但评论已被取不到（下架/无权/不存在在服务端折叠成同一结果）
    message({ id: READ_MESSAGE, revision: 1, target_ref: { type: 'comment', id: COMMENT_ID, revision: 1 },
      reference_state: 'available' }),
  ], next_cursor: null }) });
  h.requests[2].success({ statusCode: 200, data: messageEnvelope({ count: 0 }) });
  await flush();
  const unavailable = page.data.items[0];
  assert.equal(unavailable.canOpen, false, '不可用的行不可点（保持现状文案）');
  assert.equal(unavailable.referenceNote, '关联内容当前不可查看，本条不提供跳转入口。');
  assert.doesNotMatch(unavailable.referenceNote, /删除|下架|不存在/, '只说打不开，不暗示对方是否删除');

  const before = h.requests.length;
  page.onOpenTarget({ currentTarget: { dataset: { id: MESSAGE } } });
  assert.equal(h.requests.length, before, '不可点的行连请求都不发');
  assert.equal(h.navigates.length, 0);

  page.onOpenTarget({ currentTarget: { dataset: { id: READ_MESSAGE } } });
  const lookup = h.requests.at(-1);
  assert.equal(pathOf(lookup), '/comments/' + COMMENT_ID);
  lookup.success({ statusCode: 404, data: messageError('NOT_FOUND') });
  await flush();
  assert.equal(h.navigates.length, 0, '取不到所属帖子就不跳（不退回首页、不跳错页）');
  assert.deepEqual(h.toasts, ['关联内容当前不可查看'], '失败只提示一句，不解释目标为何打不开');
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

test('未读角标：>99 显示 99+；取不到时保留上一次已知读数（不改写成 0）且只留一条结构化告警', async () => {
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
  // #17 G6：失败**不清空角标**。清成 `''` 与 `'0'` 都等于告诉用户「没有未读」，
  // 而事实上是「这次没读到」——旧断言锁的正是那个错误口径，这里换成「保留上一次已知读数」。
  assert.equal(bar.data.unreadText, '99+', '取不到未读数时保留上一次已知读数（不得清成空串 = 0 条未读）');
  assert.notEqual(bar.data.unreadText, '0');
  assert.equal(h.warns.length, 1, '一次失败恰好一条告警（不重复刷日志）');
  assert.deepEqual(Object.keys(h.warns[0]).sort(), ['code', 'event'], '告警只允许 event/code 两个键');
  assert.equal(h.warns[0].event, 'messages.unread_count.fetch_failed');
  assert.equal(h.warns[0].code, 'PROVIDER_UNAVAILABLE');
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
  assert.equal(bar.data.unreadText, '', '403 下从未读到过读数 ⇒ 角标仍是空（不是被清成 0）');
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

// ---------------------------------------------------------------------------
// GY-I17（#17）R31 复盘 P2 缺口：G6 未读数失败被静默清空 / G7 过期文案 / G8 过期注释。
// G6 走真实页面与真实 custom-tab-bar；G7/G8 是**性质断言**——只锁「那句话不许回来」与
// 「文案必须与服务端/页面能力同口径」，不锁具体措辞，避免把文案钉成不可维护的字符串。
// ---------------------------------------------------------------------------
test('消息页 G6：未读数刷新失败 ⇒ 角标保留上一次已知读数（不是 0／不被写成空串），且只留一条仅含 event/code 的告警', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const { page, bar } = await openedMessagesPage(h);
  h.requests[1].success({ statusCode: 200, data: messageEnvelope({ items: [message()], next_cursor: null }) });
  h.requests[2].success({ statusCode: 200, data: messageEnvelope({ count: 3 }) });
  await flush();
  assert.equal(bar.data.unreadText, '3', '基线：先有一个已知读数');

  page.refreshUnread();
  h.requests.at(-1).success({ statusCode: 503, data: messageError('PROVIDER_UNAVAILABLE') });
  await flush();
  assert.equal(page.data.unreadText, '3', '失败不得把页面角标写成空串（空串 = 0 条未读）');
  assert.equal(bar.data.unreadText, '3', '失败不得清空 Tab 角标：用户看到的仍是最后一次已知读数');
  assert.notEqual(bar.data.unreadText, '', '空串与 0 一样会被读成「没有未读」');
  assert.notEqual(bar.data.unreadText, '0', '失败不等于「0 条未读」');
  // 失败仍要如实说明（这句是对用户的交付物），只是**不再用清空角标来表达失败**。
  assert.match(page.data.unreadNote, /^未读数未取得/);
  assert.equal(page.data.unreadRetryable, true, '失败必须留下可点重试入口（#17 G3 现状不变）');
  // 一次性留痕：恰好一条，且只允许 event/code（不得带令牌/手机号/正文）。
  assert.equal(h.warns.length, 1, '一次失败恰好一条告警');
  assert.deepEqual(Object.keys(h.warns[0]).sort(), ['code', 'event'], '告警只允许 event/code 两个键');
  assert.equal(h.warns[0].event, 'messages.unread_count.fetch_failed');
  assert.equal(h.warns[0].code, 'PROVIDER_UNAVAILABLE', 'code 是统一错误码，不是自由文本');
  assert.doesNotMatch(JSON.stringify(h.warns), /synthetic-token|synthetic-code|\+?\d{11}/,
    '告警不得包含令牌/验证码/手机号');
});

test('tabBar G6：从未读到过读数就失败 ⇒ 角标保持不显示数字（明确不更新，不写成 0），并留一条 event/code 告警', async () => {
  const h = harness();
  h.login();
  h.requests.length = 0;
  const bar = h.component('custom-tab-bar/index.js');
  bar.pageLifetimes.show.call(bar);
  h.requests.at(-1).success({ statusCode: 503, data: messageError('PROVIDER_UNAVAILABLE') });
  await flush();
  assert.equal(bar.data.unreadText, '', '从未读到过 ⇒ 仍是空（不凭空造读数）');
  assert.notEqual(bar.data.unreadText, '0', '失败不得被渲染成「0 条未读」');
  assert.equal(h.warns.length, 1);
  assert.deepEqual(Object.keys(h.warns[0]).sort(), ['code', 'event']);
});

test('G7：messages.wxml 不再自陈「仅内容审核结果有生产路径」，且类型说明与服务端事件映射、页面跳转能力一致', () => {
  const wxml = read('miniprogram/pages/messages/messages.wxml');
  const messages = read('miniprogram/pages/messages/messages.js');
  const events = read('services/api/src/community/events.ts');

  // 1) #422 之前为真的那两句，现在必须不在了（不再锁具体新措辞，只锁旧说法不许回来）。
  assert.doesNotMatch(wxml, /仅「内容审核结果」有生产路径/);
  assert.doesNotMatch(wxml, /只为「内容审核结果」写入了消息/);

  // 2) 服务端事实：#422 的映射把社区事件落成 comment/like/moderation 三型。
  assert.match(events, /export type CommunityMessageType = 'comment' \| 'like' \| 'moderation'/);

  // 3) 类型段的 meta 行必须点出三类有生产路径，且把「没有生产路径」只留给系统通知。
  //    只在**标记**里找（注释里的同义说明不参与计数），避免把注释也算成用户可见文案。
  const markup = wxml.replace(/<!--[\s\S]*?-->/g, '');
  const metas = markup.split('\n').filter((line) => line.includes('有生产路径'));
  assert.equal(metas.length, 1, '「生产路径」口径只允许出现在一行，避免多处文案各自漂移');
  for (const label of ['评论', '点赞', '内容审核结果', '系统通知']) {
    assert.ok(metas[0].includes(label), `类型说明必须点名「${label}」`);
  }
  assert.match(metas[0], /暂无|没有/, '系统通知必须被明确标成「暂无」');

  // 4) 页尾说明同样不得把「评论与点赞」写成没有生产路径。
  const caption = markup.split('\n').find((line) => line.includes('上面的列表只呈现服务端已产生的消息'));
  assert.ok(caption, '页尾说明仍在（不得靠删文案「修好」缺口）');
  assert.match(caption, /评论与点赞/);
  assert.match(caption, /内容审核结果/);
  assert.match(caption, /系统通知/);
  assert.match(caption, /尚无|暂无|没有/);

  // 5) 文案与真实能力一致：可查看的行确实给出跳转入口，不可查看的行仍如实说不提供。
  const noteLine = (state) => messages.split('\n').find((line) => line.trim().startsWith(state + ':'));
  assert.match(noteLine('available'), /可查看/);
  assert.match(noteLine('available'), /进入|点这一条/, '能跳的行必须告诉用户「点这一条」');
  assert.doesNotMatch(noteLine('available'), /不提供跳转/, '能跳还说「不提供跳转」就是自相矛盾');
  assert.match(noteLine('unavailable'), /不可查看/);
  assert.match(noteLine('unavailable'), /不提供跳转/, '不能跳的行必须如实说不提供入口');
  assert.match(wxml, /bindtap="onOpenTarget"/, '「点这一条」必须有对应的真实入口，不能只有文案');
});

test('G8：messages-api.js 头部注释不再称「端口未接线／reference_state 恒为 unavailable」，与 #425/#422 的现状对齐', () => {
  const source = read('miniprogram/utils/messages-api.js');
  const head = source.slice(0, source.indexOf("const auth = require('./auth')"));
  assert.ok(head.length > 400 && head.includes('未取得'), '取到的是头部「未取得」段');

  // 1) #425 之后不成立的三条旧说法不得回来。
  assert.doesNotMatch(head, /目标可用性端口未接线/);
  assert.doesNotMatch(head, /`reference_state` 恒为/);
  assert.doesNotMatch(head, /暂无生产路径/);

  // 2) 必须点出两片接线的事实锚（#425 目标可用性、#422 社区事件生产路径）。
  assert.match(head, /#425/);
  assert.match(head, /#422/);

  // 3) 「只有 post/comment 可能 available、其余恒 unavailable」的条数必须与闭集同源推导，
  //    闭集扩容时这条断言会红，避免注释里的 14 变成手写常量。
  const block = source.slice(source.indexOf('const TARGET_REF_TYPES')).split(']')[0];
  const types = block.match(/'[a-z_]+'/g) || [];
  assert.equal(types.length, 16, 'TargetRef.type 闭集仍是 16 项');
  assert.ok(head.includes('其余 ' + (types.length - 2) + ' 型恒为 `unavailable`'),
    '注释里的「其余 N 型」必须等于闭集条数减 2（只有 post/comment 可能 available）');

  // 4) 不泄露存在性的口径必须与 reference-community.ts 同一句事实。
  assert.match(head, /不泄露/);
});


