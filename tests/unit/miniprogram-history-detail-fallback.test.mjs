// issue #1021：历史详情页在**列表未命中**时改走 `GET /history/{id}`（服务端早已提供的单条读面）。
//
// 修复前的口径是「契约面没有 `GET /history/{id}`」，详情只能从本地已加载的列表（第 1 页）里找记录：
// 从消息/深链进入、或重启小程序后再进详情，记录明明存在却 fail-closed 显示「找不到」。
//
// 本文件锁定四条分支（合成响应；**不是**真机或微信工具证据）：
//   ① 列表实时命中 ⇒ **不发**单条读面请求（缓存优先，不多打一次接口）；
//   ② 深链/重启后只剩列表页留下的引用快照 ⇒ 靠快照定位，**也不发**单条读面请求；
//   ③ 列表未命中 + 单条 200 ⇒ 正常渲染（revision 取单条读面，可删除）；
//   ④ 单条 404 ⇒ 保持「找不到」文案；⑤ 单条 5xx／⑥ 网络失败 ⇒ 走可重试错误态（**不是**「找不到」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const HISTORY_ID = '00000000-0000-4000-8b00-000000000002';
const TARGET = '11111111-1111-4111-8111-111111111111';
const DETAIL_PAGE = root + '/miniprogram/pages/historydetail/historydetail.js';
const future = () => new Date(Date.now() + 3600_000).toISOString();
const flush = () => new Promise((r) => setImmediate(r));

// 页面侧只 require 具体文件（无目录），因此这里沿用既有的 loader 写法即可；
// 注意它会给 require 无条件拼 `.js`，所以新代码不得新增目录型 require。
function fixture() {
  const requests = [];
  const storage = new Map();
  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    request: (o) => requests.push(o),
    showModal: (o) => o.success({ confirm: false }),
    navigateTo: () => {},
    navigateBack: () => {},
    redirectTo: () => {},
    reLaunch: () => {},
    switchTab: () => {},
    setClipboardData: () => {},
    showToast: () => {}
  };
  const page = { route: 'pages/historydetail/historydetail', options: {}, data: {}, setData(p) { Object.assign(this.data, p) } };
  const cache = new Map();
  function load(path) {
    path = resolve(path);
    if (path.endsWith('runtime.js')) return { mode: 'local', apiBaseUrl: 'http://127.0.0.1:1234/api/v1' };
    if (cache.has(path)) return cache.get(path).exports;
    const m = { exports: {} };
    cache.set(path, m);
    vm.runInNewContext(
      '(function(require,module){' + readFileSync(path, 'utf8') + '\n})',
      { wx, getCurrentPages: () => [page], Page: (d) => { page.data = d.data; Object.assign(page, d) } }
    )((id) => load(resolve(dirname(path), id + '.js')), m);
    return m.exports;
  }
  const auth = load(root + '/miniprogram/utils/auth.js');
  const history = load(root + '/miniprogram/utils/history-api.js');
  load(DETAIL_PAGE);
  return { wx, requests, page, auth, history };
}

function meta() {
  return { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' };
}

function envelope(payload) {
  return { statusCode: 200, data: { data: payload, meta: meta() } };
}

function errorPayload(code, retryable = false) {
  return { error: { code, message: 'synthetic', retryable } };
}

function historyItem(overrides = {}) {
  return Object.assign({
    id: HISTORY_ID, revision: 3, kind: 'recognition',
    target_ref: { type: 'recognition', id: TARGET, revision: 2 },
    job_state: 'succeeded', reference_state: 'available', created_at: '2026-10-14T06:00:00.000Z'
  }, overrides);
}

function recognition(overrides = {}) {
  return Object.assign({
    id: TARGET, revision: 2,
    candidates: [{ species_id: 'spc-1', rank: 1, model_score: 0.82 }],
    uncertainty_reasons: ['叶片遮挡'],
    selected_species_id: null,
    model_version: 'model-synthetic-v1'
  }, overrides);
}

/** 让会话通过**服务端核实**（`isLoggedIn()` 才可能为真）。 */
function login(f) {
  f.auth.setSession({ accessToken: 'synthetic-r82-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
  let verified = null;
  f.auth.requireLogin((ok) => { verified = ok; });
  f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1)
    .success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } });
  return flush().then(() => verified);
}

/** 进详情页并放行门禁，返回"实时列表定位请求"。 */
async function open(f, id = HISTORY_ID) {
  f.page.onLoad({ id });
  f.page.onShow();
  f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1)
    .success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } });
  await flush();
  return listRequest(f);
}

const listRequest = (f) => f.requests.filter((r) => /\/history\?limit=\d+$/.test(r.url)).at(-1);
/** `GET /history/{id}` 请求（单条读面；列表请求带 `?limit=`，两者不混）。 */
const byIdRequests = (f) => f.requests.filter((r) => /\/history\/[0-9a-f-]{36}$/.test(r.url));

function answerList(f, items) {
  listRequest(f).success(envelope({ items, next_cursor: null }));
}

test('历史详情（#1021）①：列表实时命中 ⇒ 不发单条读面请求', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await open(f);
  answerList(f, [historyItem()]);
  await flush();
  f.requests.filter((r) => r.url.includes('/recognitions/')).at(-1).success(envelope(recognition()));
  await flush();

  assert.equal(byIdRequests(f).length, 0, '列表已命中，不得再发 GET /history/{id}');
  assert.equal(f.page.data.locatedBy, 'live');
  assert.equal(f.page.data.invalid, false);
  assert.equal(f.page.data.errorText, '');
  assert.equal(f.page.data.historyRevision, 3);
});

test('历史详情（#1021）②：深链/重启后只有引用快照 ⇒ 靠快照定位，也不发单条读面请求', async () => {
  const f = fixture();
  // 模拟"列表页已经翻到过这条记录、随后重启小程序再进详情"：只有快照，没有列表响应。
  f.history.remember([historyItem()]);
  assert.equal(await login(f), true);
  await open(f);
  answerList(f, []);
  await flush();
  f.requests.filter((r) => r.url.includes('/recognitions/')).at(-1).success(envelope(recognition()));
  await flush();

  assert.equal(byIdRequests(f).length, 0, '快照已定位，不得再发 GET /history/{id}');
  assert.equal(f.page.data.locatedBy, 'snapshot');
  assert.equal(f.page.data.stateKnown, false, '快照不携带状态');
  assert.equal(f.page.data.canDelete, false, '快照不给删除入口');
  assert.equal(f.page.data.invalid, false);
});

test('历史详情（#1021）③：列表未命中 + 单条读面 200 ⇒ 正常渲染（实时定位、可删除）', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await open(f);
  answerList(f, []);
  await flush();

  const byId = byIdRequests(f).at(-1);
  assert.ok(byId, '列表未命中后必须补发 GET /history/{id}');
  assert.equal(byId.method, 'GET');
  assert.equal(byId.url.endsWith('/history/' + HISTORY_ID), true);
  // 复用既有 request 封装（同一套鉴权头与 no-cache 口径），不是另造一套请求。
  assert.equal(byId.header.authorization, 'Bearer synthetic-r82-token');
  assert.equal(byId.header['Cache-Control'], 'no-cache');

  byId.success(envelope(historyItem({ revision: 7 })));
  await flush();

  const target = f.requests.filter((r) => r.url.includes('/recognitions/')).at(-1);
  assert.ok(target, '定位成功后仍要读目标正文');
  target.success(envelope(recognition()));
  await flush();

  assert.equal(f.page.data.invalid, false, '记录存在就不得显示「找不到」');
  assert.equal(f.page.data.errorText, '');
  assert.equal(f.page.data.locatedBy, 'live', '单条读面同样是实时读取 ⇒ 与 live 同口径');
  assert.equal(f.page.data.stateKnown, true);
  assert.equal(f.page.data.stateLabel.length > 0, true);
  assert.equal(f.page.data.historyRevision, 7, 'revision 取单条读面读到的值');
  assert.equal(f.page.data.canDelete, true, '实时读到 revision 才给删除入口');
  assert.equal(f.page.data.recognized, true);
  assert.equal(f.page.data.kindLabel, '识草');
});

test('历史详情（#1021）④：单条读面 404 ⇒ 保持「找不到」文案，不当成可重试错误', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await open(f);
  answerList(f, []);
  await flush();

  byIdRequests(f).at(-1).success({ statusCode: 404, data: errorPayload('NOT_FOUND') });
  await flush();

  assert.equal(f.page.data.invalid, true);
  assert.match(f.page.data.invalidReason, /不存在|已删除|不属于当前账号/);
  assert.equal(f.page.data.errorText, '', '404 是「记录不可用」，不是「读取失败」');
  assert.equal(f.page.data.errorCode, '');
  assert.equal(f.page.data.canDelete, false);
  assert.equal(f.page.data.locatedBy, '');
  assert.equal(f.requests.filter((r) => r.url.includes('/recognitions/')).length, 0, '找不到就不读目标正文');
});

test('历史详情（#1021）⑤：单条读面 503 ⇒ 可重试错误态（不是「找不到」），重试后恢复', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await open(f);
  answerList(f, []);
  await flush();

  byIdRequests(f).at(-1).success({ statusCode: 503, data: errorPayload('PROVIDER_UNAVAILABLE', true) });
  await flush();

  assert.equal(f.page.data.invalid, false, '服务不可用不等于记录不存在');
  assert.equal(f.page.data.errorCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(f.page.data.errorText, f.history.messageFor({ code: 'PROVIDER_UNAVAILABLE' }));
  assert.equal(f.page.data.canDelete, false);

  // 「重新实时读取」可恢复：列表仍未命中，单条读面这次成功。
  f.page.onRefresh();
  answerList(f, []);
  await flush();
  byIdRequests(f).at(-1).success(envelope(historyItem({ revision: 2 })));
  await flush();
  f.requests.filter((r) => r.url.includes('/recognitions/')).at(-1).success(envelope(recognition()));
  await flush();

  assert.equal(f.page.data.errorText, '', '恢复后不得留失败态');
  assert.equal(f.page.data.errorCode, '');
  assert.equal(f.page.data.invalid, false);
  assert.equal(f.page.data.historyRevision, 2);
});

test('历史详情（#1021）⑥：单条读面网络失败 ⇒ NETWORK_UNCERTAIN 错误态（不是「找不到」）', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await open(f);
  answerList(f, []);
  await flush();

  byIdRequests(f).at(-1).fail({ errMsg: 'request:fail timeout' });
  await flush();

  assert.equal(f.page.data.errorCode, 'NETWORK_UNCERTAIN');
  assert.equal(f.page.data.errorText, f.history.messageFor({ code: 'NETWORK_UNCERTAIN' }));
  assert.equal(f.page.data.invalid, false, '网络失败不得被说成「记录不存在」');
  assert.equal(/不存在/.test(f.page.data.errorText), false);
  assert.equal(f.page.data.canDelete, false);
});
