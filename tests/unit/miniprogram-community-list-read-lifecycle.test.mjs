// GY-I28（#28，Refs #15）社区列表页**读取生命周期**的定向页面回归（Node + 合成 wx）。
//
// 背景：`reload` / `onLoadMore` 只核对 `_epoch`，而 `onHide` / `onUnload` 只取消登录门禁
// （`pageGate.cancel`），并不会作废已经发出的 `listPosts`。同一会话里离页后，旧的成功仍会写
// `posts` / `nextCursor` / 状态，旧的失败仍会写 `guest` / `errorCode` / `loadMoreError`，
// 旧分页的 `INVALID_CURSOR` 还会 toast 并 `reload`。本文件把「当前读取」与「离页后的迟到读取」
// 分开钉住，并覆盖重进后的刷新／分页恢复与筛选代次隔离。
//
// 边界（如实登记）：这里载入的是**真实页面脚本 + 真实 page-gate / auth / community-api**，
// `wx.request` 只入队、由用例显式回放 success / fail；不联网、不起库。合成 wx **不等于**
// 微信编译、模拟器、Android 真机或真实 API 验收。本文件只新增测试，不改页面以外的产品代码、
// 共享 utils、既有测试、文档或工具。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const META = {
  request_id: '99999999-9999-4999-8999-999999999999',
  contract_version: '1.0.0',
  execution_mode: 'stub',
};
const POST_A_ID = '11111111-1111-4111-8111-111111111111';
const POST_B_ID = '22222222-2222-4222-8222-222222222222';
const POST_C_ID = '33333333-3333-4333-8333-333333333333';
const POST_D_ID = '44444444-4444-4444-8444-444444444444';
const POST_E_ID = '55555555-5555-4555-8555-555555555555';

const future = () => new Date(Date.now() + 3600_000).toISOString();
const flush = () => new Promise((resolveFlush) => setImmediate(resolveFlush));
/** 一次请求链会跨多个微任务；settle 给足，避免断言抢在页面回调之前。 */
async function settle() {
  await flush();
  await flush();
  await flush();
}

/**
 * 合成 wx + 真实页面模块加载器。
 *
 * `wx.request` 只把选项推进 `requests`；用例用 `take` 取一条在途请求，再显式回放。
 * `getCurrentPages` 返回当前页面实例，让真实 `auth.requireLogin` / `navigation` 的门禁路径
 * 与本仓既有 miniprogram harness 保持同形。
 */
function harness() {
  const storage = new Map();
  const requests = [];
  const toasts = [];
  const stops = { count: 0 };
  const pageRef = { current: null };
  let definition = null;
  const wx = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    request: (options) => requests.push(options),
    showToast: (options) => toasts.push(options.title),
    stopPullDownRefresh: () => { stops.count += 1; },
    reLaunch: () => {},
    switchTab: () => {},
    navigateTo: () => {},
    navigateBack: () => {},
    showModal: () => {},
  };
  const context = {
    wx,
    console: { warn: () => {}, log: () => {}, error: () => {}, info: () => {} },
    getApp: () => ({ globalData: { fontScale: 1 } }),
    getCurrentPages: () => (pageRef.current === null ? [] : [pageRef.current]),
  };
  const cache = new Map();
  function load(file) {
    file = resolve(file);
    if (!file.endsWith('.js')) file += '.js';
    // 共享 runtime 默认关闭网络；本夹具按本地准备态给可用基址（与仓内既有页面夹具同形）。
    if (file.endsWith('runtime.js')) {
      return { mode: 'local', apiBaseUrl: 'http://127.0.0.1:4318/api/v1' };
    }
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const wrapper = vm.runInNewContext(
      '(function(require,module,exports){' + readFileSync(file, 'utf8') + '\n})',
      context,
      { filename: file }
    );
    wrapper((id) => load(resolve(dirname(file), id)), module, module.exports);
    return module.exports;
  }
  function page() {
    // 一个 harness 只建一个页面实例：getCurrentPages、门禁与在途回调必须指向同一个对象。
    if (pageRef.current !== null) return pageRef.current;
    context.Page = (value) => { definition = value; };
    const file = resolve(root, 'miniprogram/pages/community/community.js');
    cache.delete(file);
    load(file);
    const instance = Object.assign({}, definition, {
      route: 'pages/community/community',
      options: {},
      data: JSON.parse(JSON.stringify(definition.data)),
    });
    // `onToggleMine` / `onCropChange` 等把 `reload` 作为 setData 回调，夹具必须同步调用它。
    instance.setData = function (patch, callback) {
      Object.assign(this.data, patch);
      if (typeof callback === 'function') callback();
    };
    pageRef.current = instance;
    return instance;
  }
  function seedSession() {
    storage.set('gengyun.session', {
      accessToken: 'synthetic-list-lifecycle-token',
      audience: 'user',
      expiresAt: future(),
      executionMode: 'stub',
    });
  }
  function take(fragment) {
    // 取**最近一条**未回放的请求：重进／改筛选后同一路径可能有多条在飞，旧的那条由用例
    // 提前保存在局部变量里，`take` 只负责取新发起的那条，避免把旧响应误当成新响应回放。
    const found = requests
      .filter((request) => request.__answered !== true && String(request.url).includes(fragment))
      .at(-1);
    assert.ok(found, `期望有一条包含「${fragment}」的在途请求可以回放，实际没有（夹具失配必须显式失败）`);
    return found;
  }
  function answerOk(request, payload) {
    request.__answered = true;
    request.success({ statusCode: 200, data: { data: payload, meta: META } });
  }
  function answerError(request, statusCode, code) {
    request.__answered = true;
    request.success({
      statusCode,
      data: {
        error: { code, message: 'synthetic', retryable: false, details: [] },
        meta: META,
      },
    });
  }
  function answerFail(request) {
    request.__answered = true;
    request.fail({ errMsg: 'request:fail' });
  }
  function postsRequests() {
    return requests.filter((request) => String(request.url).includes('/posts'));
  }
  return {
    requests, toasts, stops, load, page, seedSession,
    take, answerOk, answerError, answerFail, postsRequests,
  };
}

function sessionInfo() {
  return { audience: 'user', expires_at: future() };
}

function post(id, title, body) {
  return {
    id,
    revision: 1,
    author: {
      display_name: '演示用户甲',
      display_id: 'gy-demo-a',
      state: 'active',
      avatar_media_id: null,
      revision: 1,
      avatar_media: null,
    },
    title,
    body,
    crop_id: null,
    region_code: null,
    media_ids: [],
    visibility: 'published',
    audit_state: 'approved',
    created_at: '2026-10-20T04:00:00.000Z',
    updated_at: '2026-10-20T04:00:00.000Z',
    media: [],
    linked_knowledge_ref: null,
    linked_knowledge: null,
  };
}

/** 页面 `_decorate` 的完整展示投影（逐字段期望，不只看标题）。 */
function decorated(item) {
  return {
    id: item.id,
    revision: item.revision,
    title: item.title,
    body: item.body,
    author: item.author.display_name,
    authorAvatar: item.author.display_name.slice(0, 1),
    authorAnonymized: false,
    time: item.created_at,
    crop_id: item.crop_id,
    region_code: item.region_code,
    visibility: item.visibility,
    audit_state: item.audit_state,
    self: false,
    stateLabel: '',
    linkTitle: '',
    linkState: '',
  };
}

/**
 * 跨 VM realm 的记录边界：页面 data 来自另一个 realm，直接把 vm 数组／对象喂给 deepEqual
 * 会在原型上失败。先复制成宿主对象（JSON 往返）再比，保证比较的是**全部字段**。
 */
function hostData(page) {
  return JSON.parse(JSON.stringify(page.data));
}

function pagePayload(items, cursor) {
  return { items, next_cursor: cursor };
}

/** 进入页面并通过登录门禁；返回尚未回放的最近一条 `/posts` 请求。 */
function enter(pageh) {
  const page = pageh.page();
  page.onLoad();
  page.onShow();
  pageh.answerOk(pageh.take('/auth/session'), sessionInfo());
  return pageh.take('/posts');
}

/** 进入页面并完成一次成功列表读取，得到一个有数据、有游标的就绪页。 */
async function readyPage(pageh, item, cursor) {
  const first = enter(pageh);
  pageh.answerOk(first, pagePayload([item], cursor));
  await settle();
}

// ===========================================================================
// ① 当前读取：reload 的成功／空／失败
// ===========================================================================
test('当前 reload 成功：整页展示投影、游标与替身标注都落到页面', async () => {
  const pageh = harness();
  pageh.seedSession();
  const page = pageh.page();
  page.onLoad();
  page.onShow();
  pageh.answerOk(pageh.take('/auth/session'), sessionInfo());
  const request = pageh.take('/posts');
  assert.equal(String(request.url).includes('cursor='), false, '首屏 reload 不应带游标');
  assert.equal(page.data.status, 'loading');
  assert.equal(page.data.loadingMore, false);

  const item = post(POST_A_ID, '当前页标题甲', '当前页正文甲');
  pageh.answerOk(request, pagePayload([item], 'cursor-a'));
  await settle();

  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.nextCursor, 'cursor-a');
  assert.equal(page.data.loadMoreError, '');
  // 复制到宿主后逐字段 deepEqual（标题、作者、时间、审核/可见性、关联资料等一个不漏）。
  assert.deepEqual(hostData(page).posts, [decorated(item)]);
  assert.match(page.data.modeNote, /替身/);
  assert.match(page.data.stubNote, /替身/);
});

test('当前 reload 空页：status=empty，游标为空，不留下旧列表', async () => {
  const pageh = harness();
  pageh.seedSession();
  const page = pageh.page();
  page.onLoad();
  page.onShow();
  pageh.answerOk(pageh.take('/auth/session'), sessionInfo());
  pageh.answerOk(pageh.take('/posts'), pagePayload([], null));
  await settle();

  assert.equal(page.data.status, 'empty');
  assert.deepEqual(hostData(page).posts, []);
  assert.equal(page.data.nextCursor, null);
  assert.equal(page.data.errorCode, '');
  assert.equal(page.data.loadMoreError, '');
  assert.match(page.data.stubNote, /替身/);
});

test('当前 reload 普通失败：落 error、错误码原样、列表与游标清空', async () => {
  const pageh = harness();
  pageh.seedSession();
  const page = pageh.page();
  page.onLoad();
  page.onShow();
  pageh.answerOk(pageh.take('/auth/session'), sessionInfo());
  pageh.answerFail(pageh.take('/posts'));
  await settle();

  assert.equal(page.data.status, 'error');
  assert.equal(page.data.errorCode, 'NETWORK_UNCERTAIN');
  assert.equal(page.data.errorText, '网络未能确认当前内容，已清空，请重试。');
  assert.deepEqual(hostData(page).posts, []);
  assert.equal(page.data.nextCursor, null);
  assert.equal(page.data.loadMoreError, '');
});

// ===========================================================================
// ② 当前读取：分页成功／普通失败／INVALID_CURSOR／会话与 403
// ===========================================================================
test('当前分页成功：同游标只发一次、成功追加并推进游标', async () => {
  const pageh = harness();
  pageh.seedSession();
  const page = pageh.page();
  const first = post(POST_A_ID, '第一页标题', '第一页正文');
  await readyPage(pageh, first, 'cursor-a');

  page.onLoadMore();
  const request = pageh.take('/posts');
  assert.match(String(request.url), /[?&]cursor=cursor-a(?:&|$)/);
  assert.equal(page.data.loadingMore, true);

  // 在飞期间再次点击不得重复发请求（防重复追加）。
  const before = pageh.postsRequests().length;
  page.onLoadMore();
  assert.equal(pageh.postsRequests().length, before, 'loadingMore 为真时 onLoadMore 必须直接返回');

  const second = post(POST_B_ID, '第二页标题', '第二页正文');
  pageh.answerOk(request, pagePayload([second], 'cursor-b'));
  await settle();

  assert.equal(page.data.loadingMore, false);
  assert.equal(page.data.nextCursor, 'cursor-b');
  assert.equal(page.data.loadMoreError, '');
  assert.deepEqual(hostData(page).posts, [decorated(first), decorated(second)]);
});

test('当前分页普通失败：保留已加载列表与合法游标，持续提示并可用同一游标重试', async () => {
  const pageh = harness();
  pageh.seedSession();
  const page = pageh.page();
  const first = post(POST_A_ID, '保留的标题', '保留的正文');
  await readyPage(pageh, first, 'cursor-a');

  page.onLoadMore();
  pageh.answerError(pageh.take('/posts'), 503, 'PROVIDER_UNAVAILABLE');
  await settle();

  assert.equal(page.data.status, 'ready', '普通翻页失败不得把整页切成 error');
  assert.deepEqual(hostData(page).posts, [decorated(first)]);
  assert.equal(page.data.nextCursor, 'cursor-a');
  assert.equal(page.data.loadingMore, false);
  assert.match(page.data.loadMoreError, /PROVIDER_UNAVAILABLE/);
  assert.match(page.data.loadMoreError, /仍然保留/);

  // 重试仍请求同一条下一游标，而不是从头开始。
  page.onLoadMore();
  const retry = pageh.take('/posts');
  assert.match(String(retry.url), /[?&]cursor=cursor-a(?:&|$)/);
  const second = post(POST_B_ID, '重试到的标题', '重试到的正文');
  pageh.answerOk(retry, pagePayload([second], 'cursor-b'));
  await settle();
  assert.equal(page.data.loadMoreError, '');
  assert.deepEqual(hostData(page).posts, [decorated(first), decorated(second)]);
});

test('当前分页 INVALID_CURSOR：清游标、提示一次并重新加载第一页（不是每点一次弹一次）', async () => {
  const pageh = harness();
  pageh.seedSession();
  const page = pageh.page();
  await readyPage(pageh, post(POST_A_ID, '过期前标题', '过期前正文'), 'cursor-expired');

  page.onLoadMore();
  pageh.answerError(pageh.take('/posts'), 400, 'INVALID_CURSOR');
  await settle();

  assert.deepEqual(pageh.toasts, ['列表已过期，已重新载入']);
  assert.equal(page.data.nextCursor, null);
  assert.equal(page.data.loadMoreError, '');
  assert.equal(page.data.status, 'loading', 'INVALID_CURSOR 必须触发第一页重载');
  assert.deepEqual(hostData(page).posts, []);

  const reload = pageh.take('/posts');
  assert.equal(String(reload.url).includes('cursor='), false, '重新加载不应带失效游标');
  const fresh = post(POST_C_ID, '重新加载标题', '重新加载正文');
  pageh.answerOk(reload, pagePayload([fresh], 'cursor-fresh'));
  await settle();
  assert.equal(page.data.status, 'ready');
  assert.deepEqual(hostData(page).posts, [decorated(fresh)]);
  assert.equal(pageh.toasts.length, 1, '重新加载成功也不得再弹第二次 toast');
});

test('当前 reload 的会话失败回门禁、403 保留契约错误码', async () => {
  const sessionCase = harness();
  sessionCase.seedSession();
  const sessionPage = sessionCase.page();
  sessionPage.onLoad();
  sessionPage.onShow();
  sessionCase.answerOk(sessionCase.take('/auth/session'), sessionInfo());
  sessionCase.answerError(sessionCase.take('/posts'), 401, 'SESSION_REQUIRED');
  await settle();
  assert.equal(sessionPage.data.guest, true);
  assert.equal(sessionPage.data.status, 'idle');
  assert.equal(sessionPage.data.loadMoreError, '');

  const forbiddenCase = harness();
  forbiddenCase.seedSession();
  const forbiddenPage = forbiddenCase.page();
  forbiddenPage.onLoad();
  forbiddenPage.onShow();
  forbiddenCase.answerOk(forbiddenCase.take('/auth/session'), sessionInfo());
  forbiddenCase.answerError(forbiddenCase.take('/posts'), 403, 'SCOPE_DENIED');
  await settle();
  assert.equal(forbiddenPage.data.guest, false, '403 是「登录了但不给」，不得改写成登录失效');
  assert.equal(forbiddenPage.data.status, 'error');
  assert.equal(forbiddenPage.data.errorCode, 'SCOPE_DENIED');
  assert.equal(forbiddenPage.data.errorText, '当前会话无权访问社区。');
});

test('当前分页的会话失败回门禁、403 保留契约错误码', async () => {
  const sessionCase = harness();
  sessionCase.seedSession();
  const sessionPage = sessionCase.page();
  await readyPage(sessionCase, post(POST_A_ID, '会话前标题', '会话前正文'), 'cursor-a');
  sessionPage.onLoadMore();
  sessionCase.answerError(sessionCase.take('/posts'), 401, 'SESSION_REQUIRED');
  await settle();
  assert.equal(sessionPage.data.guest, true);
  assert.equal(sessionPage.data.status, 'idle');
  assert.equal(sessionPage.data.loadingMore, false);

  const forbiddenCase = harness();
  forbiddenCase.seedSession();
  const forbiddenPage = forbiddenCase.page();
  await readyPage(forbiddenCase, post(POST_B_ID, '403 前标题', '403 前正文'), 'cursor-b');
  forbiddenPage.onLoadMore();
  forbiddenCase.answerError(forbiddenCase.take('/posts'), 403, 'SCOPE_DENIED');
  await settle();
  assert.equal(forbiddenPage.data.loadingMore, false);
  assert.equal(forbiddenPage.data.status, 'error');
  assert.equal(forbiddenPage.data.errorCode, 'SCOPE_DENIED');
  assert.equal(forbiddenPage.data.loadMoreError, '');
});

// ===========================================================================
// ③ 离页：hide / unload 后旧 reload、旧分页的成功与失败都不得有副作用
// ===========================================================================
const STALE_CASES = [
  { kind: 'reload', outcome: 'success' },
  { kind: 'reload', outcome: 'network' },
  { kind: 'loadMore', outcome: 'success' },
  { kind: 'loadMore', outcome: 'network' },
  { kind: 'loadMore', outcome: 'invalid-cursor' },
];

for (const lifecycle of ['hide', 'unload']) {
  for (const stale of STALE_CASES) {
    test(`离页（${lifecycle}）后旧 ${stale.kind} / ${stale.outcome} 不写任何页面字段、不 toast、不 reload`, async () => {
      const pageh = harness();
      pageh.seedSession();
      const page = pageh.page();
      await readyPage(pageh, post(POST_A_ID, '离页前标题', '离页前正文'), 'cursor-a');

      if (stale.kind === 'reload') {
        page.reload();
      } else {
        page.onLoadMore();
      }
      const inFlight = pageh.take('/posts');

      if (lifecycle === 'hide') page.onHide();
      else page.onUnload();

      // 记录边界：把离页瞬间的**全部** data 复制成宿主对象，之后逐字段比对。
      const before = hostData(page);
      const toastCount = pageh.toasts.length;
      const requestCount = pageh.postsRequests().length;

      if (stale.outcome === 'success') {
        pageh.answerOk(inFlight, pagePayload([post(POST_B_ID, '迟到标题', '迟到正文')], 'cursor-late'));
      } else if (stale.outcome === 'network') {
        pageh.answerFail(inFlight);
      } else {
        pageh.answerError(inFlight, 400, 'INVALID_CURSOR');
      }
      await settle();

      assert.deepEqual(hostData(page), before, '离页后的旧响应不得改动页面任何字段（posts／游标／状态／错误码／loadingMore）');
      assert.equal(pageh.toasts.length, toastCount, '离页后的旧失败不得再弹 toast');
      assert.equal(pageh.postsRequests().length, requestCount, '离页后的旧 INVALID_CURSOR 不得再触发 reload');
    });
  }
}

// ===========================================================================
// ④ 重进：hide/show 交错、loadingMore 恢复、筛选代次隔离
// ===========================================================================
test('hide/show 交错：旧分页失败与旧 reload 成功都不污染新读取，新分页可继续', async () => {
  const pageh = harness();
  pageh.seedSession();
  const page = pageh.page();
  const first = post(POST_A_ID, '旧页标题', '旧页正文');
  await readyPage(pageh, first, 'cursor-a');

  // 旧分页在飞时离页。
  page.onLoadMore();
  const oldMore = pageh.take('/posts');
  assert.equal(page.data.loadingMore, true);
  page.onHide();

  // 重进门禁尚未核实，旧分页先带着 INVALID_CURSOR 失败：离页已作废，不得 toast、
  // 不得改游标、不得触发 reload，也不得写回任何字段。
  page.onShow();
  const reentry = hostData(page);
  const requestsBefore = pageh.postsRequests().length;
  pageh.answerError(oldMore, 400, 'INVALID_CURSOR');
  await settle();
  assert.deepEqual(pageh.toasts, []);
  assert.deepEqual(hostData(page), reentry);
  assert.equal(pageh.postsRequests().length, requestsBefore);
  assert.equal(page.data.loadingMore, true, '旧分页失败不得清掉标志；由接下来的新读取复位');

  // 门禁核实后触发新的第一页读取。
  pageh.answerOk(pageh.take('/auth/session'), sessionInfo());
  const freshReload = pageh.take('/posts');
  const fresh = post(POST_B_ID, '新页标题', '新页正文');
  pageh.answerOk(freshReload, pagePayload([fresh], 'cursor-b'));
  await settle();
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.loadingMore, false, '新读取必须复位离页遗留的 loadingMore');
  assert.deepEqual(hostData(page).posts, [decorated(fresh)]);

  // 旧 reload 的成功同样不能覆盖新页面（跨一次 hide/show）。
  page.reload();
  const oldReload = pageh.take('/posts');
  page.onHide();
  page.onShow();
  pageh.answerOk(pageh.take('/auth/session'), sessionInfo());
  const latestReload = pageh.take('/posts');
  const latest = post(POST_C_ID, '最新标题', '最新正文');
  pageh.answerOk(latestReload, pagePayload([latest], 'cursor-c'));
  await settle();
  pageh.answerOk(oldReload, pagePayload([post(POST_D_ID, '旧 reload 标题', '旧 reload 正文')], 'cursor-old'));
  await settle();
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.nextCursor, 'cursor-c');
  assert.deepEqual(hostData(page).posts, [decorated(latest)]);

  // loadingMore 已由新读取复位，新页面可以正常继续分页。
  page.onLoadMore();
  const next = pageh.take('/posts');
  assert.match(String(next.url), /[?&]cursor=cursor-c(?:&|$)/);
  const extra = post(POST_E_ID, '新分页标题', '新分页正文');
  pageh.answerOk(next, pagePayload([extra], 'cursor-d'));
  await settle();
  assert.equal(page.data.loadingMore, false);
  assert.equal(page.data.nextCursor, 'cursor-d');
  assert.deepEqual(hostData(page).posts, [decorated(latest), decorated(extra)]);
});

test('筛选代次：旧筛选的迟到响应不写新筛选列表，新筛选的分页仍带新条件', async () => {
  const pageh = harness();
  pageh.seedSession();
  const page = pageh.page();
  page.onLoad();
  page.onShow();
  pageh.answerOk(pageh.take('/auth/session'), sessionInfo());
  const allRequest = pageh.take('/posts');
  assert.equal(String(allRequest.url).includes('mine=true'), false);

  page.onToggleMine({ detail: { value: 'mine' } });
  const mineRequest = pageh.take('/posts');
  assert.match(String(mineRequest.url), /[?&]mine=true(?:&|$)/);
  const mineItem = post(POST_A_ID, '我的投稿标题', '我的投稿正文');
  pageh.answerOk(mineRequest, pagePayload([mineItem], 'cursor-mine'));
  await settle();
  assert.deepEqual(hostData(page).posts, [decorated(mineItem)]);

  // 旧筛选（全部）此时才成功：代次已过期，不得把列表换回旧结果。
  pageh.answerOk(allRequest, pagePayload([post(POST_B_ID, '全部标题', '全部正文')], 'cursor-all'));
  await settle();
  assert.deepEqual(hostData(page).posts, [decorated(mineItem)]);
  assert.equal(page.data.nextCursor, 'cursor-mine');
  assert.equal(page.data.filterMine, true);

  page.onLoadMore();
  const next = pageh.take('/posts');
  assert.match(String(next.url), /[?&]mine=true(?:&|$)/);
  assert.match(String(next.url), /[?&]cursor=cursor-mine(?:&|$)/);
});

test('onShow 仍只消费一次「我的发布」意图，消费后不再自动改筛选', async () => {
  const pageh = harness();
  pageh.seedSession();
  const navigation = pageh.load(resolve(root, 'miniprogram/utils/navigation.js'));
  const page = pageh.page();
  page.onLoad();

  navigation.requestCommunityMine();
  page.onShow();
  pageh.answerOk(pageh.take('/auth/session'), sessionInfo());
  const first = pageh.take('/posts');
  assert.match(String(first.url), /[?&]mine=true(?:&|$)/);
  assert.equal(page.data.filterMine, true);
  pageh.answerOk(first, pagePayload([], null));
  await settle();

  page.onHide();
  page.setData({ filterMine: false });
  page.onShow();
  pageh.answerOk(pageh.take('/auth/session'), sessionInfo());
  const second = pageh.take('/posts');
  assert.equal(String(second.url).includes('mine=true'), false, '一次性意图不得在每次 onShow 重新生效');
  assert.equal(page.data.filterMine, false);
});

// ===========================================================================
// ⑤ 下拉刷新：正常停止语义保留；旧 done 不得写新页面
// ===========================================================================
test('下拉刷新：正常成功与失败都停止动画并复位 loadingMore', async () => {
  const pageh = harness();
  pageh.seedSession();
  const page = pageh.page();
  await readyPage(pageh, post(POST_A_ID, '刷新前标题', '刷新前正文'), 'cursor-a');

  page.onPullDownRefresh();
  assert.equal(pageh.stops.count, 0);
  pageh.answerOk(pageh.take('/posts'), pagePayload([post(POST_B_ID, '刷新后标题', '刷新后正文')], 'cursor-b'));
  await settle();
  assert.equal(pageh.stops.count, 1);
  assert.equal(page.data.loadingMore, false);
  assert.equal(page.data.status, 'ready');

  page.onPullDownRefresh();
  pageh.answerFail(pageh.take('/posts'));
  await settle();
  assert.equal(pageh.stops.count, 2, '下拉刷新失败同样必须停止动画');
  assert.equal(page.data.loadingMore, false);
  assert.equal(page.data.status, 'error');
});

test('下拉刷新的旧 done 不写新页面，也不清掉新页面正在进行的分页', async () => {
  const pageh = harness();
  pageh.seedSession();
  const page = pageh.page();
  await readyPage(pageh, post(POST_A_ID, '旧刷新前标题', '旧刷新前正文'), 'cursor-a');

  // 旧刷新在飞：它自己随后会被离页作废。
  page.onPullDownRefresh();
  const oldRefresh = pageh.take('/posts');

  page.onHide();
  page.onShow();
  pageh.answerOk(pageh.take('/auth/session'), sessionInfo());
  const fresh = post(POST_B_ID, '新刷新标题', '新刷新正文');
  pageh.answerOk(pageh.take('/posts'), pagePayload([fresh], 'cursor-b'));
  await settle();
  assert.equal(page.data.status, 'ready');
  assert.deepEqual(hostData(page).posts, [decorated(fresh)]);

  // 新页面上的分页在飞时，旧刷新才成功：旧 done 不得 stopPullDownRefresh、不得清 loadingMore。
  page.onLoadMore();
  const newMore = pageh.take('/posts');
  assert.equal(page.data.loadingMore, true);
  pageh.answerOk(oldRefresh, pagePayload([post(POST_C_ID, '旧刷新标题', '旧刷新正文')], 'cursor-old'));
  await settle();

  assert.equal(pageh.stops.count, 0, '离页后的旧刷新 done 不得再停止当前页面的下拉动画');
  assert.equal(page.data.loadingMore, true, '旧 done 不得清掉新页面正在进行的分页状态');
  assert.deepEqual(hostData(page).posts, [decorated(fresh)]);

  pageh.answerOk(newMore, pagePayload([post(POST_D_ID, '新分页标题', '新分页正文')], 'cursor-c'));
  await settle();
  assert.equal(page.data.loadingMore, false);
  assert.equal(page.data.nextCursor, 'cursor-c');
});
