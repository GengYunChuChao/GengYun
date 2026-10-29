/**
 * GY-I26／#28 · communitydetail 帖子删除的生命周期回归（Node + 合成 `wx`）。
 *
 * 只测这一片：删除弹窗确认后的 DELETE 目标是**点击时**的帖子 id/revision，且确认回调与
 * DELETE 响应只在**同一页面实例、同一次可见周期**内落地；hide／unload／重进之后的旧回调
 * 只丢弃，不改新页（toast／导航／load／`_writeFail` 都不发生）。同页正常 `load()` 换代
 * 读取结果**不**误杀当前删除。
 *
 * 驱动仓库真代码：真实 `miniprogram/utils/community-api.js`（契约封套、`If-Match` 构造）
 * 与真实 `miniprogram/pages/communitydetail/communitydetail.js`；`wx`、页面门禁与导航是合成替身。
 * 断言只看页面公开行为（`wx` 调用、HTTP 请求、`data`、生命周期），不读本次新增的私有字段。
 *
 * 边界：合成 `wx` 不外发；不证明微信渲染、真机或真实服务端联调；离页只丢弃客户端 UI 回调，
 * **不**承诺服务端取消（请求可能已经发出）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const realAuth = createRequire(import.meta.url)('../../miniprogram/utils/auth.js');
const def = (path) => readFileSync(resolve(root, path), 'utf8');

const POST_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const DEFER = Symbol('defer');
const flush = () => new Promise((resolvePromise) => setImmediate(resolvePromise));

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

/** 载入真实适配层；`wx.showModal` 只记录不自动确认，由用例决定何时、以什么结果回调。 */
function loadApi(respond) {
  const calls = [];
  const toasts = [];
  const navigations = [];
  const modals = [];
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
    // 记录边界复制成宿主 realm 的普通对象：页面在 vm 上下文里创建 options，原型与测试进程不同，
    // 直接记录会让 deepStrictEqual 把「同值不同原型」判成不等。展开保留全部实际字段，断言仍是全字段比较。
    showToast(options) { toasts.push({ ...options }); },
    showModal(options) { modals.push(options); },
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
  return { api: box.exports, calls, toasts, navigations, modals, cleared, wx };
}

/** 装载真实详情页：同一份真实适配层、同一份合成 `wx`；记录 setData 次数供失败路径断言。 */
function loadPage(h) {
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
  };
  let definition = null;
  vm.runInNewContext(def('miniprogram/pages/communitydetail/communitydetail.js'), {
    Page: (value) => { definition = value; },
    wx: h.wx,
    require: (id) => {
      if (!Object.prototype.hasOwnProperty.call(stubs, id)) throw new Error('未预期的依赖：' + id);
      return stubs[id];
    },
  });
  assert.ok(definition && typeof definition === 'object', 'communitydetail 未注册 Page');
  const page = Object.assign({}, definition);
  page.data = Object.assign({}, definition.data);
  page.setDataCalls = 0;
  page.setData = function (patch) { this.setDataCalls += 1; Object.assign(this.data, patch); };
  page.gate = gate;
  return page;
}

function ok(data) { return { statusCode: 200, data }; }

/** 按方法／路径应答；DELETE 默认挂起，让用例决定何时以什么结果回调。 */
function route(overrides = {}) {
  return (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'DELETE') return overrides.delete || DEFER;
    if (path.endsWith('/comments')) return overrides.comments || ok(envelope({ items: [], next_cursor: null }));
    return overrides.post || ok(envelope(post()));
  };
}

async function openPage(overrides) {
  const h = loadApi(route(overrides));
  const page = loadPage(h);
  page.onLoad({ id: POST_ID });
  page.onShow();
  await flush();
  assert.equal(page.data.status, 'ready', '前置：帖子已读到');
  assert.equal(page.data.post.id, POST_ID);
  assert.equal(page.data.guest, false);
  assert.equal(h.calls.length, 2, '前置：帖子 + 评论各一次读取');
  return { h, page };
}

function confirmModal(h, index = h.modals.length - 1) {
  assert.ok(h.modals.length > index, '缺少删除确认弹窗');
  h.modals[index].success({ confirm: true });
  return h.modals[index];
}

// ------------------------------------------------------------------ 发起与取消
test('详情页删除：弹窗取消不发 DELETE、不提示、不导航', async () => {
  const { h, page } = await openPage();
  page.onDeletePost();
  assert.equal(h.modals.length, 1, '点击删除只弹确认，不先发请求');
  assert.equal(h.calls.length, 2, '确认之前不得发 DELETE');
  h.modals[0].success({ confirm: false });
  await flush();

  assert.equal(h.calls.length, 2, '取消必须是 0 次 DELETE');
  assert.equal(h.toasts.length, 0);
  assert.equal(h.navigations.length, 0);
});

test('详情页删除：隐藏页、游客、无有效帖子（缺 id 或 revision）不得发起删除', async () => {
  const { h, page } = await openPage();
  const validPost = page.data.post;

  page.onHide();
  page.onDeletePost();
  assert.equal(h.modals.length, 0, '隐藏页不得弹确认');
  assert.equal(h.calls.length, 2, '隐藏页不得发 DELETE');

  page.onShow();
  await flush();
  assert.equal(page.data.guest, false);

  page.setData({ guest: true });
  page.onDeletePost();
  assert.equal(h.modals.length, 0, '游客不得发起删除');

  page.setData({ guest: false, post: null });
  page.onDeletePost();
  assert.equal(h.modals.length, 0, '没有帖子不得发起删除');

  page.setData({ post: { ...validPost, revision: 0 } });
  page.onDeletePost();
  assert.equal(h.modals.length, 0, 'revision 无效不得发起删除');

  page.setData({ post: { ...validPost, id: 'not-a-uuid' } });
  page.onDeletePost();
  assert.equal(h.modals.length, 0, 'id 无效不得发起删除');

  page.setData({ post: validPost });
  page.onDeletePost();
  assert.equal(h.modals.length, 1, '恢复有效状态后仍可正常发起');
});

// ------------------------------------------------------------------ 目标快照
test('详情页删除：确认后按点击快照的 id/revision 发 DELETE，成功 toast + 现有社区导航', async () => {
  const { h, page } = await openPage();
  page.onDeletePost();
  confirmModal(h);
  await flush();

  assert.equal(h.calls.length, 3);
  const request = h.calls[2];
  assert.equal(request.method, 'DELETE');
  assert.equal(new URL(request.url).pathname, `/api/v1/posts/${POST_ID}`);
  assert.equal(request.header['If-Match'], '"1"', 'DELETE 的 If-Match 必须是点击时的 revision');
  assert.equal(h.toasts.length, 0, '响应之前不得预告成功');

  request.success(ok(envelope({ accepted: true })));
  await flush();

  assert.deepEqual(h.toasts, [{ title: '已删除', icon: 'success' }]);
  assert.deepEqual(h.navigations, [{ url: '/pages/community/community', resume: true }]);
});

test('详情页删除：点击后 post 对象被换成另一条帖子，也不得删错目标', async () => {
  const { h, page } = await openPage();
  page.onDeletePost();
  // 弹窗还开着时同页 load 换掉了 post 对象（id/revision 都变了）。
  page.setData({ post: { ...post({ id: OTHER_ID, revision: 9 }) } });
  confirmModal(h);
  await flush();

  assert.equal(h.calls.length, 3);
  assert.equal(new URL(h.calls[2].url).pathname, `/api/v1/posts/${POST_ID}`, 'DELETE 必须仍指向点击时的帖子');
  assert.equal(h.calls[2].header['If-Match'], '"1"', 'revision 必须是点击时的快照，不是后来换上的 9');

  h.calls[2].success(ok(envelope({ accepted: true })));
  await flush();
  assert.deepEqual(h.toasts, [{ title: '已删除', icon: 'success' }]);
  assert.equal(h.navigations.length, 1);
});

// ------------------------------------------------------------------ 失败分类
test('详情页删除失败：REVISION_CONFLICT 保留原提示并重新 load', async () => {
  const { h, page } = await openPage({ delete: { statusCode: 409, data: errorEnvelope('REVISION_CONFLICT') } });
  page.onDeletePost();
  confirmModal(h);
  await flush();

  assert.deepEqual(h.toasts, [{ title: '内容已更新，请刷新后重试', icon: 'none' }]);
  assert.equal(h.navigations.length, 0);
  assert.equal(h.calls.length, 5, '冲突后仍按原行为重取帖子与评论');
  assert.equal(h.calls[3].method, 'GET');
  assert.equal(new URL(h.calls[3].url).pathname, `/api/v1/posts/${POST_ID}`);
  assert.equal(page.data.status, 'ready');
});

test('详情页删除失败：NOT_FOUND 保留原提示且不重新 load', async () => {
  const { h, page } = await openPage({ delete: { statusCode: 404, data: errorEnvelope('NOT_FOUND') } });
  page.onDeletePost();
  confirmModal(h);
  await flush();

  assert.deepEqual(h.toasts, [{ title: '该内容不属于当前账号或已不存在', icon: 'none' }]);
  assert.equal(h.calls.length, 3, 'NOT_FOUND 不触发重新 load');
  assert.equal(h.navigations.length, 0);
});

test('详情页删除失败：其他错误仍交给 _writeFail（不吞成成功，不放宽会话／403）', async () => {
  const { h, page } = await openPage({ delete: { statusCode: 500, data: errorEnvelope('INTERNAL_ERROR') } });
  page.onDeletePost();
  confirmModal(h);
  await flush();

  assert.deepEqual(h.toasts, [{ title: h.api.message({ code: 'INTERNAL_ERROR' }), icon: 'none' }]);
  assert.equal(h.calls.length, 3);
  assert.equal(h.navigations.length, 0);
});

// ------------------------------------------------------------------ 弹窗在飞时离页
test('详情页删除：弹窗在飞时 hide，旧确认不得再发 DELETE', async () => {
  const { h, page } = await openPage();
  page.onDeletePost();
  page.onHide();
  confirmModal(h);
  await flush();

  assert.equal(h.calls.length, 2, 'hide 之后的旧确认不得补发 DELETE');
  assert.equal(h.toasts.length, 0);
  assert.equal(h.navigations.length, 0);
});

test('详情页删除：弹窗在飞时 unload，旧确认不得再发 DELETE', async () => {
  const { h, page } = await openPage();
  page.onDeletePost();
  page.onUnload();
  confirmModal(h);
  await flush();

  assert.equal(h.calls.length, 2);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.navigations.length, 0);
});

test('详情页删除：弹窗在飞时 hide 后重进，旧确认不 DELETE，当前新操作仍正常', async () => {
  const { h, page } = await openPage();
  page.onDeletePost();
  page.onHide();
  page.onShow();
  await flush();
  assert.equal(page.data.status, 'ready');
  assert.equal(h.calls.length, 4);

  confirmModal(h, 0);
  await flush();
  assert.equal(h.calls.length, 4, '重进后旧确认不得补发 DELETE');
  assert.equal(h.toasts.length, 0);
  assert.equal(h.navigations.length, 0);

  page.onDeletePost();
  assert.equal(h.modals.length, 2);
  confirmModal(h, 1);
  await flush();
  assert.equal(h.calls.length, 5, '当前可见周期的新确认必须正常发 DELETE');
  assert.equal(h.calls[4].method, 'DELETE');
  h.calls[4].success(ok(envelope({ accepted: true })));
  await flush();
  assert.deepEqual(h.toasts, [{ title: '已删除', icon: 'success' }]);
  assert.equal(h.navigations.length, 1);
});

// ------------------------------------------------------------------ DELETE 在飞时离页
test('详情页删除：DELETE 在飞时 hide，旧成功不 toast、不导航、不 load', async () => {
  const { h, page } = await openPage();
  page.onDeletePost();
  confirmModal(h);
  await flush();
  const request = h.calls[2];
  page.onHide();
  const setDataBefore = page.setDataCalls;

  request.success(ok(envelope({ accepted: true })));
  await flush();

  assert.equal(h.toasts.length, 0);
  assert.equal(h.navigations.length, 0);
  assert.equal(h.calls.length, 3, '旧成功不得触发 load');
  assert.equal(page.setDataCalls, setDataBefore, '旧成功不得再改这一页');
});

test('详情页删除：DELETE 在飞时 hide 后重进，旧成功不 toast、不导航、不 load', async () => {
  const { h, page } = await openPage();
  page.onDeletePost();
  confirmModal(h);
  await flush();
  const request = h.calls[2];
  page.onHide();
  page.onShow();
  await flush();
  const callsAfterReenter = h.calls.length;

  request.success(ok(envelope({ accepted: true })));
  await flush();

  assert.equal(h.calls.length, callsAfterReenter, '旧成功不得触发新的读取');
  assert.equal(h.toasts.length, 0);
  assert.equal(h.navigations.length, 0);
});

test('详情页删除：DELETE 在飞时 unload，旧成功不 toast、不导航、不 load', async () => {
  const { h, page } = await openPage();
  page.onDeletePost();
  confirmModal(h);
  await flush();
  const request = h.calls[2];
  page.onUnload();
  const setDataBefore = page.setDataCalls;

  request.success(ok(envelope({ accepted: true })));
  await flush();

  assert.equal(h.toasts.length, 0);
  assert.equal(h.navigations.length, 0);
  assert.equal(h.calls.length, 3, '旧成功不得触发 load');
  assert.equal(page.setDataCalls, setDataBefore);
});

test('详情页删除：DELETE 在飞时 unload，旧 REVISION_CONFLICT 不 toast、不 setData、不 load、不 _writeFail', async () => {
  const { h, page } = await openPage();
  page.onDeletePost();
  confirmModal(h);
  await flush();
  const request = h.calls[2];
  page.onUnload();
  let writeFails = 0;
  page._writeFail = () => { writeFails += 1 };
  const setDataBefore = page.setDataCalls;

  request.success({ statusCode: 409, data: errorEnvelope('REVISION_CONFLICT') });
  await flush();

  assert.equal(h.toasts.length, 0, '旧冲突不得改新页的提示');
  assert.equal(h.calls.length, 3, '旧冲突不得触发 load');
  assert.equal(page.setDataCalls, setDataBefore);
  assert.equal(writeFails, 0);
  assert.equal(h.navigations.length, 0);
});

test('详情页删除：DELETE 在飞时 unload，旧普通失败不 toast、不 setData、不 load、不 _writeFail', async () => {
  const { h, page } = await openPage();
  page.onDeletePost();
  confirmModal(h);
  await flush();
  const request = h.calls[2];
  page.onUnload();
  let writeFails = 0;
  page._writeFail = () => { writeFails += 1 };
  const setDataBefore = page.setDataCalls;

  request.success({ statusCode: 500, data: errorEnvelope('INTERNAL_ERROR') });
  await flush();

  assert.equal(h.toasts.length, 0);
  assert.equal(h.calls.length, 3);
  assert.equal(page.setDataCalls, setDataBefore);
  assert.equal(writeFails, 0);
  assert.equal(h.navigations.length, 0);
});

// ------------------------------------------------------------------ 同页读取换代
test('详情页删除：同页正常 load 换代读取结果，不误杀当前删除', async () => {
  const { h, page } = await openPage();
  const firstPost = page.data.post;
  page.onDeletePost();
  confirmModal(h);
  await flush();
  const request = h.calls[2];
  assert.equal(request.method, 'DELETE');

  // 删除在飞时同页正常 load：`_epoch` 前进、data.post 换成新对象，但这不是离页。
  page.load();
  await flush();
  assert.equal(page.data.status, 'ready');
  assert.notEqual(page.data.post, firstPost, '前提：读取结果确实换代了');
  assert.equal(h.calls.length, 5);

  request.success(ok(envelope({ accepted: true })));
  await flush();

  assert.deepEqual(h.toasts, [{ title: '已删除', icon: 'success' }], '同页读取换代不得吞掉删除成功');
  assert.deepEqual(h.navigations, [{ url: '/pages/community/community', resume: true }]);
});
