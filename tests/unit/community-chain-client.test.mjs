/**
 * GY-I14／GY-I15 · 社区链路的**客户端收口**回归（Node + 合成 `wx`）。
 *
 * 本文件只测**本片真正改动的行为**，并且全部驱动仓库里的真代码：
 *   - 真实 `miniprogram/utils/community-api.js`（适配层，401/403 归因**委托** `utils/auth.js`）；
 *   - 真实 `miniprogram/pages/community|communitydetail|communitycreate` 三个页面；
 *   - 真实 `miniprogram/components/state-view` 与 `miniprogram/utils/states.js`（B7 统一状态层）；
 *   - 401/403 的码表与「清不清会话」的期望**直接读** `auth.attribution()` / `auth.isSessionLossCode()`
 *     / `auth.isForbiddenCode()`（单一事实源），不在本文件里另写一份口径 —— 口径变了这里立刻红。
 *
 * 覆盖（与证据页 §4 逐条对应）：
 *   1. 适配层的 `sessionFailure` / `forbidden` 与会话层闭集同源；
 *   2. 列表页 403 ⇒ 不清会话 + `error-code` 落 denied（不再是「请先登录」）；
 *   3. 列表页 403 `ACCOUNT_INACTIVE` ⇒ 码保留 + 按统一层口径清会话；
 *   4. 列表页 401 `SESSION_EXPIRED` ⇒ 归一 `SESSION_REQUIRED` + 清会话 + 回门禁；
 *   5. 列表页 `SESSION_CHANGED`（客户端自造码，属会话类）⇒ 回门禁，不停在错误页；
 *   6. 列表页「加载更多」`INVALID_CURSOR` ⇒ 清死游标 + 重取第一页；
 *   7. 详情页 403 ⇒ denied 语气 + 「返回社区」不被收起（不把用户困在页面上）；
 *   8. 详情页评论取数失败 ⇒ 帖子仍可见、评论区如实报错（**不**折叠成「还没有评论」空态）；
 *   9. 详情页写路径 403 ⇒ **整页** denied（不是一句 toast 掩过去）；
 *  10. 详情页评论「加载更多」`INVALID_CURSOR` ⇒ 清游标 + 重取第一页；
 *  11. 投稿页 403 ⇒ denied 整页 + 无任何成功提示；400 规则驳回仍留在表单上（改内容重试有意义）。
 *
 * 边界（不证明什么）：合成 `wx` 不外发；本文件**不**证明微信开发者工具渲染、真机、真实服务端
 * 联调或真实审核链路，也不把 403 说成成功。页面视觉与无障碍走查不在本文件范围。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const realAuth = createRequire(import.meta.url)('../../miniprogram/utils/auth.js');
const realStates = createRequire(import.meta.url)('../../miniprogram/utils/states.js');

const POST_ID = '11111111-1111-4111-8111-111111111111';
const COMMENT_ID = '22222222-2222-4222-8222-222222222222';
const def = (path) => readFileSync(resolve(root, path), 'utf8');

function author() {
  return { display_name: '耕云用户abcd', display_id: 'gy-abcdef012345', state: 'active', avatar_media_id: null, revision: 1, avatar_media: null };
}
function post(over = {}) {
  return {
    id: POST_ID, revision: 1, author: author(), title: '稗草防除经验交流', body: '按标签说明选择登记药剂。',
    crop_id: 'crop_rice', region_code: '330100', media_ids: [], visibility: 'published', audit_state: 'approved',
    created_at: '2026-10-20T04:00:00.000Z', updated_at: '2026-10-20T04:00:00.000Z', media: [],
    linked_knowledge_ref: null, linked_knowledge: null, ...over,
  };
}
function comment(over = {}) {
  return {
    id: COMMENT_ID, revision: 1, post_id: POST_ID, author: author(), body: '也遇到过类似情况。',
    visibility: 'published', audit_state: 'approved', created_at: '2026-10-20T04:05:00.000Z', ...over,
  };
}
function envelope(data, mode = 'stub') {
  return {
    data,
    meta: { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: mode },
  };
}
function errorEnvelope(code, details = []) {
  return {
    error: { code, message: 'm', retryable: false, details },
    meta: { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' },
  };
}

/** 让用例自行应答（用例拿到请求对象后自己 `success()`）；返回它的请求不会被替身回答。 */
const DEFER = Symbol('defer');

/**
 * 载入真实适配层。`auth` 替身只替换两件与环境相关的事：**存储/令牌**与**清会话的观测**
 * （`cleared.count`）；归因的判定（码、`retryable`、清不清会话）一律走真实 `auth.js`。
 */
function loadApi(respond) {
  const calls = [];
  const toasts = [];
  const navigations = [];
  const cleared = { count: 0 };
  const auth = {
    isLoggedIn: () => true,
    getSession: () => ({ accessToken: 'synthetic-token', audience: 'user', expiresAt: '2099-01-01T00:00:00.000Z', executionMode: 'stub' }),
    sessionEpoch: () => '7:3',
    networkEnabled: () => true,
    clearSession: () => { cleared.count += 1 },
    attribution: (statusCode, payload) => realAuth.attribution(statusCode, payload),
    isSessionLossCode: (code) => realAuth.isSessionLossCode(code),
    isForbiddenCode: (code) => realAuth.isForbiddenCode(code),
    failureFor: (makeFailure, statusCode, payload) => {
      const a = realAuth.attribution(statusCode, payload);
      if (a.clearsSession) cleared.count += 1;
      const error = makeFailure(a.code);
      error.status = a.status;
      error.retryable = a.retryable;
      return error;
    },
  };
  const wx = {
    request(options) {
      calls.push(options);
      const result = respond(options, calls.length);
      if (result === DEFER) return;
      if (result && result.fail) { options.fail({ errMsg: 'synthetic network failure' }); return }
      options.success(result);
    },
    showToast(options) { toasts.push(options); },
    showModal(options) { if (options.success) options.success({ confirm: true }); },
    showActionSheet(options) { if (options.success) options.success({ tapIndex: 0 }); },
  };
  const box = { exports: {} };
  const dependencies = new Map([
    ['./auth', auth],
    ['../config/runtime', { apiBaseUrl: 'https://synthetic.invalid/api/v1' }],
  ]);
  vm.runInNewContext(def('miniprogram/utils/community-api.js'), {
    module: box,
    wx,
    require: (id) => {
      if (!dependencies.has(id)) throw Error('Unexpected page dependency ' + id);
      return dependencies.get(id);
    },
  });
  return { api: box.exports, calls, toasts, navigations, cleared, wx };
}

const dataCache = new Map();
function dataModule(name) {
  if (!dataCache.has(name)) {
    const box = { exports: {} };
    vm.runInNewContext(def(`miniprogram/data/${name}.js`), { module: box });
    dataCache.set(name, box.exports);
  }
  return dataCache.get(name);
}

/** 装载**真实页面**：接到同一份真实适配层与同一份合成 `wx`（依赖说明符是闭集，未登记即失败）。 */
function loadPage(h, name) {
  const gate = { started: 0, cancelled: 0 };
  const stubs = {
    '../../utils/community-api': h.api,
    '../../utils/auth': { requireLogin() {} },
    '../../utils/page-gate': {
      start(page, callback) { gate.started += 1; callback(false); callback(true); },
      cancel() { gate.cancelled += 1; },
    },
    '../../utils/font-scale': { DEFAULT_FONT_SCALE: 1, applyFontScale() {}, currentFontScale() { return 1 } },
    '../../utils/navigation': {
      openTarget(url, resume, done) { h.navigations.push({ url, resume }); if (done) done(null); },
      consumeCommunityMine() { return false; },
    },
    '../../data/crops': dataModule('crops'),
    '../../data/regions': dataModule('regions'),
  };
  let definition = null;
  vm.runInNewContext(def(`miniprogram/pages/${name}/${name}.js`), {
    Page: (value) => { definition = value; },
    wx: h.wx,
    require: (id) => {
      if (!Object.prototype.hasOwnProperty.call(stubs, id)) throw new Error('未预期的依赖：' + id);
      return stubs[id];
    },
  });
  assert.ok(definition && typeof definition === 'object', `${name} 未注册 Page`);
  const page = Object.assign({}, definition);
  page.data = Object.assign({}, definition.data);
  page.setData = function (patch) { Object.assign(this.data, patch); };
  h.gate = gate;
  h.page = page;
  return page;
}

/** 真实 `state-view` 组件实例化（真实 `utils/states.js`），用来判定页面最终落到哪个状态。 */
function renderStateView(bindings) {
  let definition = null;
  vm.runInNewContext(def('miniprogram/components/state-view/state-view.js'), {
    Component: (value) => { definition = value; },
    require: (id) => {
      if (id !== '../../utils/states') throw new Error('未预期的依赖：' + id);
      return realStates;
    },
  });
  assert.ok(definition, 'state-view 未注册 Component');
  const instance = Object.assign({}, definition, definition.methods);
  instance.data = Object.assign({}, definition.data, bindings);
  instance.setData = function (patch) { Object.assign(this.data, patch); };
  instance.refresh();
  return instance.data;
}

/** 社区页 wxml 里某个属性的真实绑定值（从模板取，不在用例里另写一份期望）。 */
function wxmlBindings(name, attr) {
  const source = def(`miniprogram/pages/${name}/${name}.wxml`);
  const found = [];
  const pattern = new RegExp(attr + '="\\{\\{([A-Za-z0-9_.]+)\\}\\}"', 'g');
  let match;
  while ((match = pattern.exec(source)) !== null) found.push(match[1]);
  return found;
}

const flush = () => new Promise((resolvePromise) => setImmediate(resolvePromise));

// --------------------------------------------------------------------------- 适配层：委托关系
test('适配层：sessionFailure/forbidden 与会话层闭集同源（不另立码表），403 三码归 forbidden、会话码归 sessionFailure', () => {
  const h = loadApi(() => DEFER);
  for (const code of ['SCOPE_DENIED', 'CONSENT_REQUIRED', 'ACCOUNT_INACTIVE']) {
    assert.equal(h.api.forbidden({ code }), true, code + ' 必须是契约 403 闭集成员');
    assert.equal(h.api.sessionFailure({ code }), false, code + ' 不是会话失效（不得回门禁）');
  }
  for (const code of ['SESSION_REQUIRED', 'SESSION_EXPIRED', 'SESSION_CHANGED']) {
    assert.equal(h.api.sessionFailure({ code }), true, code + ' 属会话类');
    assert.equal(h.api.forbidden({ code }), false, code + ' 不是 403 闭集成员');
  }
  // 同源断言：适配层不持有第三份码表，判定结果必须等于会话层的闭集判定。
  for (const code of Object.keys(realStates.CODE_KIND).concat(['UNKNOWN_CODE', ''])) {
    assert.equal(h.api.sessionFailure({ code }), realAuth.isSessionLossCode(code), code + ' 的会话判定与会话层不一致');
    assert.equal(h.api.forbidden({ code }), realAuth.isForbiddenCode(code), code + ' 的 403 判定与会话层不一致');
  }
  assert.equal(h.api.sessionFailure(null), false);
  assert.equal(h.api.forbidden(undefined), false);
  // 本域措辞仍在（403 三码各有本域句子，且不得谎称登录失效）
  assert.match(h.api.message({ code: 'SCOPE_DENIED' }), /无权/);
  assert.match(h.api.message({ code: 'CONSENT_REQUIRED' }), /用途授权/);
  assert.match(h.api.message({ code: 'ACCOUNT_INACTIVE' }), /账号当前不可用/);
  for (const code of ['SCOPE_DENIED', 'CONSENT_REQUIRED', 'ACCOUNT_INACTIVE']) {
    assert.doesNotMatch(h.api.message({ code }), /登录状态已失效/, code + ' 的文案不得谎称登录失效');
  }
});

// --------------------------------------------------------------------------- 列表页
test('社区列表页：403 SCOPE_DENIED ⇒ 不清会话、错误码原文落到 denied（改前是「请先登录」）', async () => {
  const h = loadApi(() => ({ statusCode: 403, data: errorEnvelope('SCOPE_DENIED') }));
  const page = loadPage(h, 'community');
  page.onLoad();
  page.onShow();
  await flush();

  assert.equal(h.calls.length, 1, '列表页必须真的发一次 GET /posts');
  assert.equal(page.data.guest, false, '403 不是「没登录」⇒ 不得回登录门禁');
  assert.equal(page.data.status, 'error');
  assert.equal(page.data.errorCode, 'SCOPE_DENIED');
  assert.equal(h.cleared.count, 0, '403 不得销毁仍然有效的会话');

  // 页面把码交给 state-view 的 error-code（模板绑定即断言来源），组件据此升级成 denied。
  assert.deepEqual(wxmlBindings('community', 'error-code'), ['errorCode'], '列表页未把 errorCode 交给 state-view');
  const view = renderStateView({
    status: page.data.status, errorCode: page.data.errorCode, title: '社区内容没有取到',
    desc: page.data.errorText, actionText: '重新读取',
  });
  assert.equal(view.effectiveStatus, 'denied');
  assert.equal(view.kindTag, realStates.KIND_LABEL.denied);
  assert.equal(view.actionSuppressed, true, 'denied 态的「重新读取」必须收起（403 重试不会变好）');
});

test('社区列表页：403 ACCOUNT_INACTIVE ⇒ 码如实保留（denied）且按统一层口径清会话', async () => {
  const h = loadApi(() => ({ statusCode: 403, data: errorEnvelope('ACCOUNT_INACTIVE') }));
  const page = loadPage(h, 'community');
  page.onLoad();
  page.onShow();
  await flush();

  assert.equal(page.data.errorCode, 'ACCOUNT_INACTIVE', '令牌永久失效，但码不得折叠成登录失效');
  assert.equal(page.data.guest, false, '不得把 ACCOUNT_INACTIVE 说成「请先登录」');
  assert.equal(h.cleared.count, 1, 'ACCOUNT_INACTIVE 必须清掉已永久不可用的令牌（口径见 auth.attribution）');
  assert.equal(realAuth.attribution(403, errorEnvelope('ACCOUNT_INACTIVE')).clearsSession, true,
    '清会话的口径来自统一层，不是本文件写的字面量');
});

test('社区列表页：401 SESSION_EXPIRED ⇒ 归一 SESSION_REQUIRED + 清会话 + 回门禁（不停在错误页）', async () => {
  const h = loadApi(() => ({ statusCode: 401, data: errorEnvelope('SESSION_EXPIRED') }));
  const page = loadPage(h, 'community');
  page.onLoad();
  page.onShow();
  await flush();

  assert.equal(h.cleared.count, 1, '401 必须清本地会话');
  assert.equal(page.data.guest, true, '401 ⇒ 回登录门禁');
  assert.equal(page.data.status, 'idle', '不得留在 loading/error 页');
  assert.equal(page.data.errorCode, '', '回门禁时不再呈现错误码');
  assert.equal(realAuth.attribution(401, errorEnvelope('SESSION_EXPIRED')).code, 'SESSION_REQUIRED',
    '401 的封套码统一归一到 SESSION_REQUIRED（口径见 auth.attribution）');
});

test('社区列表页：客户端自造码 SESSION_CHANGED 同样回门禁（改前停在「社区服务暂不可用」错误页）', () => {
  const h = loadApi(() => DEFER);
  const page = loadPage(h, 'community');
  page.onLoad();
  page.setData({ status: 'loading' });
  // 在途响应晚于会话变化：适配层抛 SESSION_CHANGED（`states.CODE_KIND` 里属 session 类）。
  const error = new Error('SESSION_CHANGED');
  error.code = 'SESSION_CHANGED';
  page._fail(error);

  assert.equal(page.data.guest, true, 'SESSION_CHANGED 属会话类 ⇒ 必须回门禁');
  assert.equal(page.data.status, 'idle');
  assert.notEqual(page.data.status, 'error', '不得把会话变化说成一次普通失败');
});

test('社区列表页「加载更多」：INVALID_CURSOR ⇒ 清死游标并从第一页重载（改前只弹一句 toast）', async () => {
  const h = loadApi((request, index) => {
    if (index === 1) return { statusCode: 200, data: envelope({ items: [post()], next_cursor: 'cursor-1' }) };
    if (index === 2) return { statusCode: 400, data: errorEnvelope('INVALID_CURSOR') };
    return { statusCode: 200, data: envelope({ items: [post()], next_cursor: 'cursor-2' }) };
  });
  const page = loadPage(h, 'community');
  page.onLoad();
  page.onShow();
  await flush();
  assert.equal(page.data.nextCursor, 'cursor-1');
  assert.equal(page.data.posts.length, 1);

  page.onLoadMore();
  await flush();
  assert.equal(h.calls.length, 3, '失效游标 → 必须重新取第一页（第 3 次请求）');
  assert.equal(new URL(h.calls[2].url).searchParams.get('cursor'), null, '重载不得再带上死游标');
  assert.equal(page.data.nextCursor, 'cursor-2', '游标必须换成第一页返回的新值');
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].title, '列表已过期，已重新载入');
  assert.equal(page.data.status, 'ready', '重载成功 ⇒ 回到 ready，不停在错误页');
});

test('社区列表页「加载更多」：403 ⇒ 整页 denied（不是一句 toast 掩过去）', async () => {
  const h = loadApi((request, index) => {
    if (index === 1) return { statusCode: 200, data: envelope({ items: [post()], next_cursor: 'cursor-1' }) };
    return { statusCode: 403, data: errorEnvelope('CONSENT_REQUIRED') };
  });
  const page = loadPage(h, 'community');
  page.onLoad();
  page.onShow();
  await flush();
  page.onLoadMore();
  await flush();

  assert.equal(page.data.status, 'error');
  assert.equal(page.data.errorCode, 'CONSENT_REQUIRED');
  assert.equal(page.data.loadingMore, false);
  assert.equal(h.toasts.length, 0, '403 不是「翻页失败」这种一次性故障，不得只用 toast');
  assert.equal(h.cleared.count, 0, 'CONSENT_REQUIRED 不清会话');
});

// --------------------------------------------------------------------------- 详情页
test('社区详情页：403 ⇒ denied 语气 + 「返回社区」不被收起（不把用户困在一个回不去的页面）', async () => {
  const h = loadApi(() => ({ statusCode: 403, data: errorEnvelope('SCOPE_DENIED') }));
  const page = loadPage(h, 'communitydetail');
  page.onLoad({ id: POST_ID });
  page.onShow();
  await flush();

  assert.equal(page.data.status, 'error');
  assert.equal(page.data.errorCode, 'SCOPE_DENIED');
  assert.equal(page.data.stateTitle, '没有权限查看这条内容', '403 不得再说成「内容当前不可见」');
  assert.equal(page.data.guest, false);
  assert.equal(h.cleared.count, 0);

  assert.deepEqual(wxmlBindings('communitydetail', 'error-code'), ['errorCode'], '详情页未把 errorCode 交给 state-view');
  assert.match(def('miniprogram/pages/communitydetail/communitydetail.wxml'), /allow-denied-action="\{\{true\}\}"/,
    '详情页 denied 态若不开 allow-denied-action，返回按钮会被收起');
  const view = renderStateView({
    status: page.data.stateStatus, errorCode: page.data.errorCode, title: page.data.stateTitle,
    desc: page.data.errorText, actionText: '返回社区', allowDeniedAction: true,
  });
  assert.equal(view.effectiveStatus, 'denied');
  assert.equal(view.actionSuppressed, false, '「返回社区」是导航不是重试，必须保留');
});

test('社区详情页：404 仍走 invalid 语气（不把「可能已下架」说成没权限）', async () => {
  const h = loadApi(() => ({ statusCode: 404, data: errorEnvelope('NOT_FOUND') }));
  const page = loadPage(h, 'communitydetail');
  page.onLoad({ id: POST_ID });
  page.onShow();
  await flush();

  assert.equal(page.data.stateStatus, 'invalid');
  assert.equal(page.data.stateTitle, '这条内容当前不可见');
  assert.equal(page.data.errorCode, 'NOT_FOUND');
  assert.match(page.data.errorText, /未通过审核/);
});

test('社区详情页：评论取数失败 ⇒ 帖子仍可见、评论区如实报错（不折叠成「还没有评论」空态）', async () => {
  const h = loadApi((request, index) => {
    if (index === 1) return { statusCode: 200, data: envelope(post()) };
    return { statusCode: 503, data: errorEnvelope('PROVIDER_UNAVAILABLE') };
  });
  const page = loadPage(h, 'communitydetail');
  page.onLoad({ id: POST_ID });
  page.onShow();
  await flush();

  assert.equal(page.data.status, 'ready', '帖子读到了就是 ready，评论失败不得把整页打回错误');
  assert.equal(page.data.post.id, POST_ID, '已读到的帖子不得被评论失败抹掉');
  assert.equal(page.data.commentsStatus, 'error');
  assert.notEqual(page.data.commentsStatus, 'empty', '取数失败不得显示成空态');
  assert.equal(page.data.commentsError, h.api.message({ code: 'PROVIDER_UNAVAILABLE' }));
  assert.equal(page.data.comments.length, 0);
  assert.match(def('miniprogram/pages/communitydetail/communitydetail.wxml'), /commentsStatus === 'error'/,
    '评论区必须有独立的失败态分支');
});

test('社区详情页：评论为空才是空态（成功响应 items=[] ⇒ commentsStatus=empty）', async () => {
  const h = loadApi((request, index) => index === 1
    ? { statusCode: 200, data: envelope(post()) }
    : { statusCode: 200, data: envelope({ items: [], next_cursor: null }) });
  const page = loadPage(h, 'communitydetail');
  page.onLoad({ id: POST_ID });
  page.onShow();
  await flush();
  assert.equal(page.data.status, 'ready');
  assert.equal(page.data.commentsStatus, 'empty');
});

test('社区详情页写入：403 CONSENT_REQUIRED ⇒ 整页 denied（改前只弹一句 toast），且不清会话', async () => {
  const h = loadApi((request, index) => {
    if (index === 1) return { statusCode: 200, data: envelope(post()) };
    if (index === 2) return { statusCode: 200, data: envelope({ items: [comment()], next_cursor: null }) };
    return { statusCode: 403, data: errorEnvelope('CONSENT_REQUIRED') };
  });
  const page = loadPage(h, 'communitydetail');
  page.onLoad({ id: POST_ID });
  page.onShow();
  await flush();
  assert.equal(page.data.status, 'ready');

  page.onLikePost();
  await flush();

  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].method, 'PUT');
  assert.match(h.calls[2].url, /\/posts\/.+\/like$/);
  assert.equal(page.data.status, 'error', '写路径 403 必须整页落 denied，而不是仅一条 toast');
  assert.equal(page.data.errorCode, 'CONSENT_REQUIRED');
  assert.equal(page.data.stateStatus, 'error');
  assert.equal(h.toasts.length, 0, '不得只弹一句 toast 就过去');
  assert.equal(h.cleared.count, 0, 'CONSENT_REQUIRED 不清会话');
  const view = renderStateView({
    status: page.data.stateStatus, errorCode: page.data.errorCode, title: page.data.stateTitle,
    desc: page.data.errorText, actionText: '返回社区', allowDeniedAction: true,
  });
  assert.equal(view.effectiveStatus, 'denied');
});

test('社区详情页写入：401 SESSION_EXPIRED ⇒ 清会话并回门禁（不谎称操作失败）', async () => {
  const h = loadApi((request, index) => {
    if (index === 1) return { statusCode: 200, data: envelope(post()) };
    if (index === 2) return { statusCode: 200, data: envelope({ items: [], next_cursor: null }) };
    return { statusCode: 401, data: errorEnvelope('SESSION_EXPIRED') };
  });
  const page = loadPage(h, 'communitydetail');
  page.onLoad({ id: POST_ID });
  page.onShow();
  await flush();
  page.onLikePost();
  await flush();

  assert.equal(h.cleared.count, 1);
  assert.equal(page.data.guest, true);
  assert.equal(h.toasts.length, 0, '会话失效不是「点赞失败」');
});

test('社区详情页评论「加载更多」：INVALID_CURSOR ⇒ 清死游标并重取第一页', async () => {
  const h = loadApi((request, index) => {
    if (index === 1) return { statusCode: 200, data: envelope(post()) };
    if (index === 2) return { statusCode: 200, data: envelope({ items: [comment()], next_cursor: 'cc-1' }) };
    if (index === 3) return { statusCode: 400, data: errorEnvelope('INVALID_CURSOR') };
    return { statusCode: 200, data: envelope({ items: [comment()], next_cursor: null }) };
  });
  const page = loadPage(h, 'communitydetail');
  page.onLoad({ id: POST_ID });
  page.onShow();
  await flush();
  assert.equal(page.data.nextCursor, 'cc-1');

  page.onLoadMoreComments();
  await flush();
  assert.equal(h.calls.length, 4, '失效游标 → 必须再取一次第一页');
  assert.equal(new URL(h.calls[3].url).searchParams.get('cursor'), null, '重取不得再带上死游标');
  assert.equal(page.data.nextCursor, null);
  assert.equal(page.data.comments.length, 1);
  assert.equal(h.toasts[0].title, '评论列表已过期，已重新载入');
});

// --------------------------------------------------------------------------- 投稿页
test('投稿页：403 CONSENT_REQUIRED ⇒ 整页 denied、表单收起、无任何成功提示；不清会话', async () => {
  const h = loadApi(() => ({ statusCode: 403, data: errorEnvelope('CONSENT_REQUIRED') }));
  const page = loadPage(h, 'communitycreate');
  page.setData({ title: '稗草防除的一次记录', body: '按标签说明选择登记药剂。' });
  page.onSubmit();
  await flush();

  assert.equal(page.data.denied, true);
  assert.equal(page.data.errorCode, 'CONSENT_REQUIRED');
  assert.equal(page.data.errorText, h.api.message({ code: 'CONSENT_REQUIRED' }));
  assert.equal(h.toasts.length, 0, '未被受理时不得弹任何提示');
  assert.equal(h.navigations.length, 0, '未被受理时不得跳详情页');
  assert.equal(h.cleared.count, 0);

  assert.match(def('miniprogram/pages/communitycreate/communitycreate.wxml'), /error-code="\{\{errorCode\}\}"/,
    '投稿页 denied 态未把错误码交给 state-view');
  const view = renderStateView({
    status: 'error', errorCode: page.data.errorCode, title: '这次发布没有通过权限检查',
    desc: page.data.errorText, actionText: '重新填写', allowDeniedAction: true,
  });
  assert.equal(view.effectiveStatus, 'denied');
  assert.equal(view.actionSuppressed, false, '「重新填写」必须保留（否则表单收起后无法回到表单）');

  page.onDismissDenied();
  assert.equal(page.data.denied, false, '解除后表单应重新出现（不放宽任何校验）');
});

test('投稿页：400 规则驳回仍留在表单上（改内容重试有意义，不算 denied）', async () => {
  const h = loadApi(() => ({ statusCode: 400, data: errorEnvelope('INVALID_REQUEST', [{ field: 'reason_codes', code: 'DANGEROUS_MIX' }]) }));
  const page = loadPage(h, 'communitycreate');
  page.setData({ title: '标题', body: '正文' });
  page.onSubmit();
  await flush();

  assert.equal(page.data.denied, false, '规则驳回不是权限问题，不得收起表单');
  assert.equal(page.data.errorCode, 'INVALID_REQUEST');
  assert.match(page.data.errorText, /DANGEROUS_MIX/);
  assert.equal(h.toasts.length, 0);
});
