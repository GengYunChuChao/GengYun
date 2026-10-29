/**
 * GY-I26（#28）· 投稿页提交回调的**页面可见周期身份**回归（Node + 合成 wx）。
 *
 * 缺陷（Refs #15／#28）：`onSubmit` 的 `createPost` 在飞时，同一账号会话里
 * `onHide`／`onUnload`／重进页面，旧的成功响应仍会 `setData`（含把新页面的
 * `submitting` 清成 false）、`showToast`、跳详情；旧的失败响应还会写
 * `guest`／`errorCode`／`denied`／`errorText`，覆盖新页面或新一次提交。
 *
 * 本文件只验证页面侧守卫：
 *   - 当前可见周期的成功／会话失败／403／普通失败语义保持；
 *   - 离页（hide／unload）后旧成功与旧失败都不再产生 UI 副作用；
 *   - hide → show 重进后新提交在飞时，旧响应不清新 `submitting`／错误／导航，
 *     新提交仍可正常完成；
 *   - 标题／正文输入校验与表单文本保留。
 *
 * 边界：合成 `wx` 与 Node 的 Promise 时序**不**等于微信编译、模拟器、真机或真实审核；
 * 本文件也不承诺取消服务端已受理的投稿（页面只是丢弃旧回调）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const realAuth = createRequire(import.meta.url)('../../miniprogram/utils/auth.js');

const POST_ID = '11111111-1111-4111-8111-111111111111';
const API_BASE = 'http://127.0.0.1:4318/api/v1';

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

/** 跨 vm realm 的记录归一化：页面 `setData`／`showToast` 收到的对象原型属于另一个 realm。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const dataCache = new Map();
function dataModule(name) {
  if (!dataCache.has(name)) {
    const box = { exports: {} };
    vm.runInNewContext(readFileSync(resolve(root, `miniprogram/data/${name}.js`), 'utf8'), { module: box });
    dataCache.set(name, box.exports);
  }
  return dataCache.get(name);
}

/**
 * 真实适配层 + 真实投稿页，接同一个合成 `wx`。
 * `wx.request` 只登记，不代替用例应答 —— 生命周期用例需要在任意时刻手工回包。
 */
function harness() {
  const state = { loggedIn: true, epoch: '7:3', cleared: 0 };
  const calls = [];
  const toasts = [];
  const routes = [];
  const patches = [];
  const session = { accessToken: 'synthetic-token', audience: 'user', expiresAt: '2099-01-01T00:00:00.000Z', executionMode: 'stub' };
  const auth = {
    isLoggedIn: () => state.loggedIn,
    getSession: () => state.loggedIn ? session : null,
    sessionEpoch: () => state.epoch,
    networkEnabled: () => true,
    clearSession: () => { state.cleared += 1 },
    // 归因用真实实现，保证 SESSION_CHANGED／403 闭集来自仓库单一事实源。
    attribution: (statusCode, payload) => realAuth.attribution(statusCode, payload),
    isSessionLossCode: (code) => realAuth.isSessionLossCode(code),
    isForbiddenCode: (code) => realAuth.isForbiddenCode(code),
    failureFor: (makeFailure, statusCode, payload) => {
      const a = realAuth.attribution(statusCode, payload);
      if (a.clearsSession) state.cleared += 1;
      const error = makeFailure(a.code);
      error.status = a.status;
      error.retryable = a.retryable;
      return error;
    },
  };
  const wx = {
    request(options) { calls.push(options) },
    showToast(options) { toasts.push(plain(options)) },
  };
  const box = { exports: {} };
  vm.runInNewContext(readFileSync(resolve(root, 'miniprogram/utils/community-api.js'), 'utf8'), {
    module: box,
    wx,
    require: (id) => {
      if (id === './auth') return auth;
      if (id === '../config/runtime') return { apiBaseUrl: API_BASE };
      throw Error('Unexpected page dependency ' + id);
    },
  });
  const api = box.exports;

  function loadPage() {
    const stubs = {
      '../../utils/community-api': api,
      '../../utils/auth': { requireLogin() {} },
      '../../utils/page-gate': { start() {}, cancel() {} },
      '../../utils/font-scale': { DEFAULT_FONT_SCALE: 1, applyFontScale() {}, currentFontScale() { return 1 } },
      '../../utils/navigation': {
        openTarget(url, resume, done) { routes.push({ url: url, resume: resume }); if (done) done() },
      },
      '../../data/crops': dataModule('crops'),
      '../../data/regions': dataModule('regions'),
    };
    let definition = null;
    vm.runInNewContext(readFileSync(resolve(root, 'miniprogram/pages/communitycreate/communitycreate.js'), 'utf8'), {
      Page: (value) => { definition = value },
      wx,
      require: (id) => {
        if (!Object.prototype.hasOwnProperty.call(stubs, id)) throw new Error('未预期的依赖：' + id);
        return stubs[id];
      },
    });
    assert.ok(definition && typeof definition === 'object', 'communitycreate 未注册 Page');
    const page = Object.assign({}, definition);
    page.data = Object.assign({}, definition.data);
    page.setData = function (patch) {
      patches.push(plain(patch));
      Object.assign(this.data, patch);
    };
    return page;
  }

  return { api, calls, toasts, routes, patches, state, loadPage };
}

const TITLE = '稗草防除的一次记录';
const BODY = '按标签说明选择登记药剂。';

/** 发起一次投稿；断言请求确实发出且布局字段正确，返回该请求供用例手工回包。 */
function submit(page, h, index = 0, title = TITLE, body = BODY) {
  page.setData({ title: title, body: body });
  page.onSubmit();
  assert.equal(h.calls.length, index + 1, '提交必须真的发出请求（不得本地乐观成功）');
  const request = h.calls[index];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, API_BASE + '/posts');
  assert.ok(request.header['Idempotency-Key'].length >= 8, '写路径必须带幂等键');
  assert.equal(request.header['If-Match'], undefined, '创建不需要 If-Match');
  assert.deepEqual(plain(request.data), { title: title, body: body, media_ids: [] });
  assert.equal(page.data.submitting, true);
  return request;
}

test('当前可见成功：按服务端 outcome 文案提示并进详情，submitting 恢复', async () => {
  const h = harness();
  const page = h.loadPage();
  const request = submit(page, h);

  request.success({ statusCode: 201, data: envelope(post()) });
  await flush();

  assert.deepEqual(h.toasts, [{ title: '已通过先行审核', icon: 'success' }]);
  assert.deepEqual(h.routes, [{ url: '/pages/communitydetail/communitydetail?id=' + POST_ID, resume: true }]);
  assert.equal(page.data.submitting, false);
  assert.equal(page.data.errorText, '');
  assert.deepEqual(h.patches, [
    { title: TITLE, body: BODY },
    { submitting: true, errorText: '' },
    { submitting: false },
  ]);
});

test('当前可见会话失败（SESSION_CHANGED）：回 guest 门禁，不弹提示、不导航', async () => {
  const h = harness();
  const page = h.loadPage();
  const request = submit(page, h);

  // 会话 epoch 在途变化 ⇒ 真实适配层抛 SESSION_CHANGED（不是普通失败）。
  h.state.epoch = '7:4';
  request.success({ statusCode: 201, data: envelope(post()) });
  await flush();

  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.routes, []);
  assert.deepEqual(h.patches[h.patches.length - 1], {
    submitting: false, guest: true, errorText: '', errorCode: '', denied: false,
  });
  assert.equal(page.data.submitting, false);
  assert.equal(page.data.guest, true);
});

test('当前可见 403：整页 denied + 契约错误码，不弹提示、不导航', async () => {
  const h = harness();
  const page = h.loadPage();
  const request = submit(page, h);

  request.success({ statusCode: 403, data: errorEnvelope('SCOPE_DENIED') });
  await flush();

  const expected = h.api.message({ code: 'SCOPE_DENIED' });
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.routes, []);
  assert.deepEqual(h.patches[h.patches.length - 1], {
    submitting: false, errorText: expected, errorCode: 'SCOPE_DENIED', denied: true,
  });
  assert.equal(page.data.denied, true);
});

test('当前可见普通失败（503）：只展示适配层文案，不弹提示、不导航', async () => {
  const h = harness();
  const page = h.loadPage();
  const request = submit(page, h);

  request.success({ statusCode: 503, data: errorEnvelope('PROVIDER_UNAVAILABLE') });
  await flush();

  const expected = h.api.message({ code: 'PROVIDER_UNAVAILABLE' });
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.routes, []);
  assert.deepEqual(h.patches[h.patches.length - 1], {
    submitting: false, errorText: expected, errorCode: 'PROVIDER_UNAVAILABLE', denied: false,
  });
  assert.equal(page.data.denied, false);
});

test('onHide 后旧成功与旧失败（SESSION_CHANGED）都无 setData/toast/导航副作用', async () => {
  const cases = [
    ['旧成功', (h, request) => request.success({ statusCode: 201, data: envelope(post()) })],
    ['旧失败', (h, request) => {
      h.state.epoch = '7:4';
      request.success({ statusCode: 201, data: envelope(post()) });
    }],
  ];
  for (const [label, reply] of cases) {
    const h = harness();
    const page = h.loadPage();
    const request = submit(page, h);
    page.onHide();
    assert.equal(page.data.submitting, false, label + '：离页释放本次可见周期的忙碌态');
    assert.equal(page.data.title, TITLE, label + '：离页不得清空表单文本');
    assert.equal(page.data.body, BODY);

    h.patches.length = 0;
    h.toasts.length = 0;
    h.routes.length = 0;
    reply(h, request);
    await flush();

    assert.deepEqual(h.patches, [], label + '：旧回调不得再 setData');
    assert.deepEqual(h.toasts, [], label + '：旧回调不得再弹提示');
    assert.deepEqual(h.routes, [], label + '：旧回调不得再导航');
    assert.equal(page.data.submitting, false);
  }
});

test('onUnload 后旧成功与旧失败（403）都无 setData/toast/导航副作用', async () => {
  const cases = [
    ['旧成功', (h, request) => request.success({ statusCode: 201, data: envelope(post()) })],
    ['旧失败', (h, request) => request.success({ statusCode: 403, data: errorEnvelope('SCOPE_DENIED') })],
  ];
  for (const [label, reply] of cases) {
    const h = harness();
    const page = h.loadPage();
    const request = submit(page, h);
    page.onUnload();

    h.patches.length = 0;
    h.toasts.length = 0;
    h.routes.length = 0;
    reply(h, request);
    await flush();

    assert.deepEqual(h.patches, [], label + '：卸载后旧回调不得再 setData');
    assert.deepEqual(h.toasts, [], label + '：卸载后旧回调不得再弹提示');
    assert.deepEqual(h.routes, [], label + '：卸载后旧回调不得再导航');
  }
});

test('hide→show 重进 + 新提交在飞：旧成功不清新 submitting／错误／导航，新提交正常完成', async () => {
  const h = harness();
  const page = h.loadPage();
  submit(page, h, 0, '旧标题', '旧正文');

  page.onHide();
  assert.equal(page.data.submitting, false);
  page.onShow();
  submit(page, h, 1, '新标题', '新正文');
  assert.equal(page.data.submitting, true);

  h.patches.length = 0;
  h.toasts.length = 0;
  h.routes.length = 0;

  // 旧提交的成功响应晚到：必须被页面可见周期守卫丢弃。
  h.calls[0].success({ statusCode: 201, data: envelope(post()) });
  await flush();
  assert.deepEqual(h.patches, [], '旧成功不得清掉新提交的 submitting');
  assert.deepEqual(h.toasts, [], '旧成功不得弹提示');
  assert.deepEqual(h.routes, [], '旧成功不得导航');
  assert.equal(page.data.submitting, true);
  assert.equal(page.data.errorText, '');
  assert.equal(page.data.title, '新标题');
  assert.equal(page.data.body, '新正文');

  // 新提交照常完成（非通过结论仍按服务端返回文案）。
  h.calls[1].success({ statusCode: 201, data: envelope(post({ visibility: 'published', audit_state: 'pending' })) });
  await flush();
  assert.deepEqual(h.toasts, [{ title: '待审／未公开', icon: 'none' }]);
  assert.deepEqual(h.routes, [{ url: '/pages/communitydetail/communitydetail?id=' + POST_ID, resume: true }]);
  assert.equal(page.data.submitting, false);
});

test('hide→show 重进 + 新提交在飞：旧失败（403）不覆盖新提交错误态，新失败正常落表单', async () => {
  const h = harness();
  const page = h.loadPage();
  submit(page, h, 0, '旧标题', '旧正文');

  page.onHide();
  page.onShow();
  submit(page, h, 1, '新标题', '新正文');

  h.patches.length = 0;
  h.toasts.length = 0;
  h.routes.length = 0;

  // 旧提交的 403 晚到：不得写 denied／errorCode／errorText，也不得清新 submitting。
  h.calls[0].success({ statusCode: 403, data: errorEnvelope('SCOPE_DENIED') });
  await flush();
  assert.deepEqual(h.patches, [], '旧失败不得覆盖新页面错误态');
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.routes, []);
  assert.equal(page.data.submitting, true);
  assert.equal(page.data.denied, false);
  assert.equal(page.data.errorCode, '');
  assert.equal(page.data.errorText, '');

  // 新提交的 422 照常落表单（隔离待复核，不冒充成功）。
  h.calls[1].success({
    statusCode: 422,
    data: errorEnvelope('INPUT_UNCERTAIN', [{ field: 'reason_codes', code: 'NOT_SCREENED' }]),
  });
  await flush();
  const expected = h.api.message({ code: 'INPUT_UNCERTAIN', details: ['NOT_SCREENED'] });
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(h.routes, []);
  assert.deepEqual(h.patches[h.patches.length - 1], {
    submitting: false, errorText: expected, errorCode: 'INPUT_UNCERTAIN', denied: false,
  });
  assert.match(page.data.errorText, /隔离待复核/);
});

test('标题／正文输入校验保留：空或超长不发请求，只写 errorText，表单文本不清空', () => {
  const cases = [
    ['标题为空', '', BODY, '标题需要 1..120 个字符。'],
    ['标题超长', 'x'.repeat(121), BODY, '标题需要 1..120 个字符。'],
    ['正文为空', TITLE, '', '正文需要 1..8000 个字符。'],
    ['正文超长', TITLE, 'x'.repeat(8001), '正文需要 1..8000 个字符。'],
  ];
  for (const [label, title, body, expected] of cases) {
    const h = harness();
    const page = h.loadPage();
    page.setData({ title: title, body: body });
    h.patches.length = 0;
    page.onSubmit();

    assert.equal(h.calls.length, 0, label + '：校验失败不得发请求');
    assert.equal(page.data.submitting, false, label + '：校验失败不得进入提交态');
    assert.deepEqual(h.patches, [{ errorText: expected }], label + '：只写校验提示');
    assert.equal(page.data.title, title, label + '：不得清空标题');
    assert.equal(page.data.body, body, label + '：不得清空正文');
  }
});
