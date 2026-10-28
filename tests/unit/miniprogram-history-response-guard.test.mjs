// GY-I16 / GY-I26 历史列表页：页面读取代次与旧响应隔离（合成 wx + 可控请求）。
//
// 这不是微信工具或真机证据。用例只验证页面状态机：
//   * onShow / onHide / onUnload / 刷新读取换代后，旧第一页或旧分页的成功、失败都不得
//     写 items / _rawItems、不得调用 historyApi.remember、不得复位新请求的 busy/loading，
//     也不得写 errorText / errorCode；
//   * 重进时立即解除旧的 busy/loading，门禁通过后仍能正常读取；
//   * 当前请求成功/失败（含 401/403）与正常跨页快照累积保持原语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const HISTORY_PAGE = root + '/miniprogram/pages/history/history.js';
const future = () => new Date(Date.now() + 3600_000).toISOString();
const flush = () => new Promise((r) => setImmediate(r));

/** 历史行 id 递增，便于按页断言。 */
function historyRow(n) {
  const id = '00000000-0000-4000-8b00-' + String(n).padStart(12, '0');
  return {
    id,
    revision: 1,
    kind: 'recognition',
    target_ref: { type: 'recognition', id, revision: 1 },
    job_state: 'succeeded',
    reference_state: 'available',
    created_at: '2026-10-14T06:00:00.000Z'
  };
}

function meta() {
  return { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' };
}

/**
 * 合成小程序运行时。`getCurrentPages()` 始终返回这一页，页面方法由 history.js 的 Page()
 * 定义装入；`wx.request` 只入队，由用例显式决定成功/失败与先后顺序。
 */
function fixture() {
  const requests = [];
  const storage = new Map();
  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    request: (o) => requests.push(o),
    showModal: (o) => o.success({ confirm: true }),
    navigateTo: () => {},
    navigateBack: () => {},
    redirectTo: () => {},
    reLaunch: () => {},
    switchTab: () => {},
    setClipboardData: () => {},
    showToast: () => {}
  };
  const page = {
    route: 'pages/history/history',
    options: {},
    data: {},
    setData(p) { Object.assign(this.data, p); }
  };
  const cache = new Map();
  function load(path) {
    path = resolve(path);
    if (path.endsWith('runtime.js')) {
      return { mode: 'local', apiBaseUrl: 'http://127.0.0.1:1234/api/v1' };
    }
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    vm.runInNewContext(
      '(function(require,module){' + readFileSync(path, 'utf8') + '\n})',
      {
        wx,
        getCurrentPages: () => [page],
        Page: (definition) => {
          page.data = definition.data;
          Object.assign(page, definition);
        }
      }
    )((id) => load(resolve(dirname(path), id + '.js')), module);
    return module.exports;
  }
  const auth = load(root + '/miniprogram/utils/auth.js');
  const history = load(root + '/miniprogram/utils/history-api.js');
  load(HISTORY_PAGE);
  return { wx, requests, page, auth, history };
}

function historyRequest(f) {
  return f.requests.filter((r) => r.url.includes('/history?')).at(-1);
}

function authRequest(f) {
  return f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1);
}

function answerGate(f) {
  authRequest(f).success({
    statusCode: 200,
    data: { data: { audience: 'user', expires_at: future() } }
  });
  return flush();
}

async function passGate(f, call) {
  call();
  await answerGate(f);
}

function answerPage(f, request, items, nextCursor) {
  request.success({
    statusCode: 200,
    data: { data: { items, next_cursor: nextCursor }, meta: meta() },
    header: {}
  });
}

function answerPageError(f, request, code, statusCode) {
  request.success({
    statusCode,
    data: { error: { code, message: 'synthetic', retryable: false } }
  });
}

async function login(f) {
  f.auth.setSession({
    accessToken: 'synthetic-history-guard-token',
    audience: 'user',
    expiresAt: future(),
    executionMode: 'stub'
  });
  let verified = null;
  f.auth.requireLogin((ok) => { verified = ok; });
  authRequest(f).success({
    statusCode: 200,
    data: { data: { audience: 'user', expires_at: future() } }
  });
  await flush();
  return verified;
}

function ids(page) {
  return Array.from(page.data.items, (item) => item.id);
}

function rawIds(page) {
  return Array.from(page._rawItems, (item) => item.id);
}

test('历史列表：刷新换代后旧成功/旧失败不写页面或快照，也不复位新请求 busy/loading', async () => {
  const f = fixture();
  assert.equal(await login(f), true);

  let rememberCalls = 0;
  const remember = f.history.remember;
  f.history.remember = function (items) {
    rememberCalls += 1;
    return remember(items);
  };

  await passGate(f, () => f.page.onShow());
  const first = historyRequest(f);

  // 第一次刷新：R1 仍在飞，R2 成为当前请求。
  f.page.onRefresh();
  const second = historyRequest(f);
  assert.notEqual(first, second);

  // 旧成功晚到：不得把旧页写进 items / `_rawItems`，不得污染定位快照，也不得提前复位 R2。
  answerPage(f, first, [historyRow(1)], 'stale-cursor');
  await flush();
  assert.deepEqual(ids(f.page), []);
  assert.deepEqual(Array.from(f.page._rawItems), [], '旧成功不得写入 _rawItems');
  assert.equal(f.page.data.busy, true, '旧成功不得复位新请求的 busy');
  assert.equal(f.page.data.loading, true, '旧成功不得复位新请求的 loading');
  assert.equal(f.page.data.nextCursor, null);
  assert.equal(f.history.expected(historyRow(1).id), null, '旧成功不得调用 remember');
  assert.equal(rememberCalls, 0);

  // 当前 R2 正常成功。
  answerPage(f, second, [historyRow(2)], 'cursor-2');
  await flush();
  assert.deepEqual(ids(f.page), [historyRow(2).id]);
  assert.deepEqual(rawIds(f.page), [historyRow(2).id]);
  assert.equal(f.page.data.nextCursor, 'cursor-2');
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.loading, false);
  assert.notEqual(f.history.expected(historyRow(2).id), null);
  assert.equal(rememberCalls, 1);

  // 连续两次刷新：R3 是旧请求，R4 是当前请求。
  f.page.onRefresh();
  const third = historyRequest(f);
  f.page.onRefresh();
  const fourth = historyRequest(f);
  assert.notEqual(third, fourth);

  // 旧失败先到：不得清掉仍在新请求中的列表，不得写错误，也不得复位 busy/loading。
  answerPageError(f, third, 'PROVIDER_UNAVAILABLE', 503);
  await flush();
  assert.deepEqual(ids(f.page), [historyRow(2).id]);
  assert.equal(f.page.data.errorText, '');
  assert.equal(f.page.data.errorCode, '');
  assert.equal(f.page.data.busy, true, '旧失败不得复位新请求的 busy');
  assert.equal(f.page.data.loading, true, '旧失败不得复位新请求的 loading');
  assert.equal(f.history.expected(historyRow(2).id), null, 'onRefresh 同步 clearSelection() 已清旧快照，这是刷新既有行为；旧失败不得写回');
  assert.equal(rememberCalls, 1, '旧失败不得调用 remember');

  // 当前 R4 正常成功，旧失败没有遗留错误。
  answerPage(f, fourth, [historyRow(3)], null);
  await flush();
  assert.deepEqual(ids(f.page), [historyRow(3).id]);
  assert.equal(f.page.data.errorText, '');
  assert.equal(f.page.data.errorCode, '');
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.loading, false);
  assert.notEqual(f.history.expected(historyRow(3).id), null);
  assert.equal(rememberCalls, 2);

  // 反向对照：当前请求失败仍照常呈现契约错误码，并清空本轮列表/定位快照。
  f.page.onRefresh();
  const currentFailure = historyRequest(f);
  answerPageError(f, currentFailure, 'SCOPE_DENIED', 403);
  await flush();
  assert.equal(f.page.data.errorCode, 'SCOPE_DENIED');
  assert.equal(f.page.data.errorText, f.history.messageFor({ code: 'SCOPE_DENIED' }));
  assert.deepEqual(ids(f.page), []);
  assert.deepEqual(Array.from(f.page._rawItems), [], '失败路径不得留下 _rawItems');
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.loading, false);
  assert.equal(f.history.expected(historyRow(3).id), null);
  assert.equal(rememberCalls, 2, '失败路径不写定位快照');
});

test('历史列表：离页后旧分页不追加、不污染快照；重进解除旧 busy/loading，新分页仍累积', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await passGate(f, () => f.page.onShow());

  answerPage(f, historyRequest(f), [historyRow(1)], 'cursor-2');
  await flush();
  assert.notEqual(f.history.expected(historyRow(1).id), null);

  // 第 2 页在飞时离页，随后立即重进；旧分页留到新第一页也已在飞时再返回。
  f.page.onMore();
  const oldMore = historyRequest(f);
  f.page.onHide();

  // 重进：页面恢复可见时立即解除旧请求留下的 busy/loading，并丢弃旧快照。
  f.page.onShow();
  assert.equal(f.page.data.busy, false, '重进必须解除旧 busy');
  assert.equal(f.page.data.loading, false, '重进必须解除旧 loading');
  assert.deepEqual(ids(f.page), []);
  assert.deepEqual(Array.from(f.page._rawItems), [], '重进必须丢弃旧快照');
  assert.equal(f.history.expected(historyRow(1).id), null);

  await answerGate(f);
  const fresh = historyRequest(f);
  assert.equal(f.page.data.busy, true, '新读取照常进入 busy');
  assert.equal(f.page.data.loading, true);

  // 旧分页成功晚到：不追加 items、不写 `_rawItems`、不污染定位快照，也不复位新请求 busy。
  answerPage(f, oldMore, [historyRow(21)], 'cursor-22');
  await flush();
  assert.deepEqual(ids(f.page), []);
  assert.deepEqual(Array.from(f.page._rawItems), [], '旧分页不得写入 _rawItems');
  assert.equal(f.page.data.nextCursor, null);
  assert.equal(f.page.data.busy, true);
  assert.equal(f.page.data.loading, true);
  assert.equal(f.history.expected(historyRow(21).id), null, '旧分页不得写入定位快照');

  // 新第一页正常成功，旧分页的行没有混入。
  answerPage(f, fresh, [historyRow(101)], 'cursor-102');
  await flush();
  assert.deepEqual(ids(f.page), [historyRow(101).id]);
  assert.deepEqual(rawIds(f.page), [historyRow(101).id]);
  assert.equal(f.history.expected(historyRow(21).id), null);
  assert.notEqual(f.history.expected(historyRow(101).id), null);

  // 正常跨页累积：新第 2 页仍把两页都写进定位快照。
  f.page.onMore();
  answerPage(f, historyRequest(f), [historyRow(102)], null);
  await flush();
  assert.deepEqual(ids(f.page), [historyRow(101).id, historyRow(102).id]);
  assert.equal(f.page.data.nextCursor, null);
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.loading, false);
  assert.notEqual(f.history.expected(historyRow(101).id), null);
  assert.notEqual(f.history.expected(historyRow(102).id), null);
});

test('历史列表：onUnload 后旧分页成功/失败或旧第一页失败都不写已卸载页面', async () => {
  // 旧成功：onUnload 后不得追加旧页、不得写定位快照、不得复位 busy。
  const f = fixture();
  assert.equal(await login(f), true);
  await passGate(f, () => f.page.onShow());
  answerPage(f, historyRequest(f), [historyRow(1)], 'cursor-2');
  await flush();
  f.page.onMore();
  const staleMore = historyRequest(f);
  f.page.onUnload();

  answerPage(f, staleMore, [historyRow(21)], 'cursor-22');
  await flush();
  assert.deepEqual(ids(f.page), [historyRow(1).id]);
  assert.deepEqual(rawIds(f.page), [historyRow(1).id]);
  assert.equal(f.page.data.busy, true);
  assert.equal(f.page.data.loading, true);
  assert.equal(f.history.expected(historyRow(21).id), null);

  // 旧失败：页面已卸载，失败不得写错误或清列表。
  const g = fixture();
  assert.equal(await login(g), true);
  await passGate(g, () => g.page.onShow());
  const staleList = historyRequest(g);
  g.page.onUnload();

  answerPageError(g, staleList, 'PROVIDER_UNAVAILABLE', 503);
  await flush();
  assert.deepEqual(ids(g.page), []);
  assert.deepEqual(Array.from(g.page._rawItems), [], '卸载后旧第一页失败不得写入 _rawItems');
  assert.equal(g.page.data.errorText, '');
  assert.equal(g.page.data.errorCode, '');
  assert.equal(g.page.data.busy, true);
  assert.equal(g.page.data.loading, true);

  // 旧分页失败：不得清掉已加载页、不得写错误，也不得抹掉定位快照。
  const h = fixture();
  assert.equal(await login(h), true);
  await passGate(h, () => h.page.onShow());
  answerPage(h, historyRequest(h), [historyRow(1)], 'cursor-2');
  await flush();
  h.page.onMore();
  const stalePageFailure = historyRequest(h);
  h.page.onUnload();

  answerPageError(h, stalePageFailure, 'PROVIDER_UNAVAILABLE', 503);
  await flush();
  assert.deepEqual(ids(h.page), [historyRow(1).id]);
  assert.deepEqual(rawIds(h.page), [historyRow(1).id]);
  assert.equal(h.page.data.errorText, '');
  assert.equal(h.page.data.errorCode, '');
  assert.equal(h.page.data.busy, true);
  assert.equal(h.page.data.loading, true);
  assert.notEqual(h.history.expected(historyRow(1).id), null);
});

test('历史列表：当前请求 401/403 的契约错误码仍原样呈现', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await passGate(f, () => f.page.onShow());
  answerPageError(f, historyRequest(f), 'SCOPE_DENIED', 403);
  await flush();
  assert.equal(f.page.data.errorCode, 'SCOPE_DENIED');
  assert.equal(f.page.data.errorText, f.history.messageFor({ code: 'SCOPE_DENIED' }));
  assert.deepEqual(ids(f.page), []);
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.loading, false);
  assert.equal(f.auth.isLoggedIn(), true, '403 不销毁仍有效的会话');

  const g = fixture();
  assert.equal(await login(g), true);
  await passGate(g, () => g.page.onShow());
  answerPageError(g, historyRequest(g), 'SESSION_EXPIRED', 401);
  await flush();
  assert.equal(g.page.data.errorCode, 'SESSION_REQUIRED');
  assert.equal(g.page.data.errorText, g.history.messageFor({ code: 'SESSION_REQUIRED' }));
  assert.deepEqual(ids(g.page), []);
  assert.equal(g.page.data.busy, false);
  assert.equal(g.page.data.loading, false);
  assert.equal(g.auth.isLoggedIn(), false, '401 仍按会话失效处理');
});
