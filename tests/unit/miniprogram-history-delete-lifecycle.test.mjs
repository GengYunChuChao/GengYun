// GY-I16 / GY-I26 历史列表页：删除确认与 DELETE 写回的**同会话页面生命周期**。
//
// 这不是微信工具或真机证据。用例只验证页面状态机：
//   * 当前取消不发 DELETE；当前确认按历史行的 id/revision 发 DELETE（If-Match + 幂等键），
//     成功展示服务端 cascade 文案并重读列表，普通失败如实报错且不重读；
//   * 弹窗在飞时 hide / unload / 重进后，旧确认不再发 DELETE；
//   * DELETE 在飞时 hide / unload / 重进后，旧成功或旧失败都不 setData、不 load、不改新忙态/文案；
//   * 重进后的新读取仍能建立新 busy；旧写回不得污染它，当前新删除仍正常；
//   * 删除在飞时发生同页的新列表读取，不得把当前删除写回误杀。
//
// 合成夹具复用 `miniprogram-history-response-guard.test.mjs` 的 wx / Page / 请求队列形态；
// DELETE 响应使用契约 AckEnvelope（`data.accepted === true` + meta），不改变既有断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const HISTORY_PAGE = root + '/miniprogram/pages/history/history.js';
const future = () => new Date(Date.now() + 3600_000).toISOString();
const flush = () => new Promise((r) => setImmediate(r));

/** 历史行 id 递增，便于按页断言；revision 可按用例指定。 */
function historyRow(n, revision = 1) {
  const id = '00000000-0000-4000-8b00-' + String(n).padStart(12, '0');
  return {
    id,
    revision,
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
 * 合成小程序运行时。`getCurrentPages()` 始终返回这一页；`wx.request` 与 `wx.showModal`
 * 都只入队，由用例显式决定确认/取消以及响应成功/失败与先后顺序。
 * `page.writes` 记录 setData 次数，用来证明旧写回没有碰新页面。
 */
function fixture() {
  const requests = [];
  const modals = [];
  const storage = new Map();
  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    request: (o) => requests.push(o),
    showModal: (o) => modals.push(o),
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
    writes: 0,
    setData(p) {
      this.writes += 1;
      Object.assign(this.data, p);
    }
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
  return { wx, requests, modals, page, auth, history };
}

function authRequest(f) {
  return f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1);
}

function listRequests(f) {
  return f.requests.filter((r) => r.method === 'GET' && r.url.includes('/history?'));
}

function lastListRequest(f) {
  return listRequests(f).at(-1);
}

function deleteRequests(f) {
  return f.requests.filter((r) => r.method === 'DELETE');
}

async function answerGate(f) {
  authRequest(f).success({
    statusCode: 200,
    data: { data: { audience: 'user', expires_at: future() } }
  });
  await flush();
}

async function passGate(f, call) {
  call();
  await answerGate(f);
}

function answerList(f, items, nextCursor, request) {
  (request || lastListRequest(f)).success({
    statusCode: 200,
    data: { data: { items, next_cursor: nextCursor }, meta: meta() },
    header: {}
  });
}

/** 契约 DELETE AckEnvelope：202 + `data.accepted === true`，可选 X-GY-Cascade 披露。 */
function answerDelete(f, request, cascade = 'unwired') {
  const header = {};
  if (cascade !== null) header['X-GY-Cascade'] = cascade;
  request.success({
    statusCode: 202,
    data: { data: { accepted: true }, meta: meta() },
    header
  });
}

function answerDeleteError(f, request, code, statusCode) {
  request.success({
    statusCode,
    data: { error: { code, message: 'synthetic', retryable: false } }
  });
}

async function login(f) {
  f.auth.setSession({
    accessToken: 'synthetic-history-delete-token',
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

/** 进入历史列表并完成第一页读取。 */
async function openList(f, rows = [historyRow(1)], nextCursor = null) {
  assert.equal(await login(f), true);
  await passGate(f, () => f.page.onShow());
  answerList(f, rows, nextCursor);
  await flush();
}

function openDeleteModal(f, index = 0) {
  f.page.onDelete({ currentTarget: { dataset: { index } } });
  return f.modals.at(-1);
}

function ids(page) {
  return Array.from(page.data.items, (item) => item.id);
}

test('历史删除：当前取消不发 DELETE，也不改忙态/文案', async () => {
  const f = fixture();
  await openList(f, [historyRow(1)]);
  const message = f.page.data.message;

  const modal = openDeleteModal(f);
  assert.ok(modal, '当前页应弹出删除确认');
  assert.equal(deleteRequests(f).length, 0, '确认前不得发 DELETE');

  modal.success({ confirm: false, cancel: true });
  await flush();

  assert.equal(deleteRequests(f).length, 0, '取消不得发 DELETE');
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.message, message);
});

test('历史删除：当前确认按 id/revision 发 DELETE，成功展示级联文案并重读列表', async () => {
  const f = fixture();
  const row = historyRow(1, 7);
  await openList(f, [row]);
  const listBefore = listRequests(f).length;

  const modal = openDeleteModal(f);
  modal.success({ confirm: true });
  await flush();

  const deletes = deleteRequests(f);
  assert.equal(deletes.length, 1);
  const del = deletes[0];
  assert.equal(del.method, 'DELETE');
  assert.equal(del.url, 'http://127.0.0.1:1234/api/v1/history/' + row.id);
  assert.equal(del.header.authorization, 'Bearer synthetic-history-delete-token');
  assert.equal(del.header['If-Match'], '"7"', 'If-Match 必须用服务端给的 revision');
  assert.match(del.header['Idempotency-Key'], /^his-delete-/);
  assert.ok(del.header['Idempotency-Key'].length >= 8);
  assert.equal(f.page.data.busy, true);
  assert.equal(f.page.data.message, '正在删除…');

  answerDelete(f, del, 'partial');
  await flush();

  assert.equal(
    f.page.data.message,
    '已删除记录。' + f.history.cascadeNote('partial'),
    '成功文案必须带服务端 cascade 披露'
  );
  assert.equal(listRequests(f).length, listBefore + 1, '成功必须重读列表');
  assert.equal(f.page.data.busy, true, '重读已进入新的 busy');

  answerList(f, [], null);
  await flush();
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.message, '还没有识别记录。');
  assert.deepEqual(ids(f.page), []);
});

test('历史删除：当前失败如实报错，不显示成功、不重读列表', async () => {
  const f = fixture();
  await openList(f, [historyRow(1)]);
  const listBefore = listRequests(f).length;

  const modal = openDeleteModal(f);
  modal.success({ confirm: true });
  await flush();

  const del = deleteRequests(f).at(-1);
  answerDeleteError(f, del, 'REVISION_CONFLICT', 409);
  await flush();

  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.message, f.history.messageFor({ code: 'REVISION_CONFLICT' }));
  assert.equal(/已删除记录/.test(f.page.data.message), false, '失败不得显示成功文案');
  assert.equal(listRequests(f).length, listBefore, '失败不得重读列表');
});

test('历史删除：隐藏/未放行/断网/无行/忙态都不弹确认、不发 DELETE', async () => {
  const f = fixture();
  // 尚未 onShow / 门禁未放行。
  f.page.onDelete({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(f.modals.length, 0);

  await openList(f, [historyRow(1)]);

  // 无对应行。
  f.page.onDelete({ currentTarget: { dataset: { index: 9 } } });
  assert.equal(f.modals.length, 0);

  // 忙态。
  f.page.data.busy = true;
  f.page.onDelete({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(f.modals.length, 0);
  f.page.data.busy = false;

  // 网络关闭。
  f.page.data.networkOff = true;
  f.page.onDelete({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(f.modals.length, 0);
  f.page.data.networkOff = false;

  // 隐藏页。
  f.page.onHide();
  f.page.onDelete({ currentTarget: { dataset: { index: 0 } } });
  assert.equal(f.modals.length, 0);
  assert.equal(deleteRequests(f).length, 0);
});

test('历史删除：弹窗在飞时 hide、unload、重进后旧确认一律不发 DELETE', async () => {
  // hide：确认回调晚于隐藏。
  const f = fixture();
  await openList(f, [historyRow(1)]);
  let modal = openDeleteModal(f);
  f.page.onHide();
  modal.success({ confirm: true });
  await flush();
  assert.equal(deleteRequests(f).length, 0, '隐藏后旧确认不得发 DELETE');
  assert.equal(f.page.data.busy, false);

  // unload：确认回调晚于卸载。
  const g = fixture();
  await openList(g, [historyRow(1)]);
  modal = openDeleteModal(g);
  g.page.onUnload();
  modal.success({ confirm: true });
  await flush();
  assert.equal(deleteRequests(g).length, 0, '卸载后旧确认不得发 DELETE');

  // 重进：新门禁/新读取都已完成、busy 已复位，旧确认仍因页面代次失效而不发 DELETE。
  const h = fixture();
  await openList(h, [historyRow(1)]);
  modal = openDeleteModal(h);
  h.page.onHide();
  h.page.onShow();
  await answerGate(h);
  answerList(h, [historyRow(2)], null);
  await flush();
  assert.equal(h.page.data.gatePassed, true);
  assert.equal(h.page.data.busy, false);
  const before = deleteRequests(h).length;

  modal.success({ confirm: true });
  await flush();
  assert.equal(deleteRequests(h).length, before, '重进后旧确认不得删除旧行');
  assert.equal(h.page.data.busy, false);
  assert.deepEqual(ids(h.page), [historyRow(2).id]);
});

test('历史删除：DELETE 在飞时 hide/unload 后旧成功与旧失败都不 setData、不重读、不改忙态', async () => {
  // 旧成功：页面已隐藏。
  const f = fixture();
  await openList(f, [historyRow(1)]);
  let modal = openDeleteModal(f);
  modal.success({ confirm: true });
  await flush();
  const staleSuccess = deleteRequests(f).at(-1);
  const listBefore = listRequests(f).length;
  f.page.onHide();
  const message = f.page.data.message;
  assert.equal(message, '正在删除…');
  f.page.writes = 0;

  answerDelete(f, staleSuccess, 'unwired');
  await flush();
  assert.equal(f.page.writes, 0, '隐藏后旧成功不得 setData');
  assert.equal(listRequests(f).length, listBefore, '隐藏后旧成功不得 load 新列表');
  assert.equal(f.page.data.busy, true, '旧成功不得复位忙态');
  assert.equal(f.page.data.message, message);

  // 旧失败：页面已卸载。
  const g = fixture();
  await openList(g, [historyRow(1)]);
  modal = openDeleteModal(g);
  modal.success({ confirm: true });
  await flush();
  const staleFailure = deleteRequests(g).at(-1);
  const gListBefore = listRequests(g).length;
  g.page.onUnload();
  const gMessage = g.page.data.message;
  g.page.writes = 0;

  answerDeleteError(g, staleFailure, 'PROVIDER_UNAVAILABLE', 503);
  await flush();
  assert.equal(g.page.writes, 0, '卸载后旧失败不得 setData');
  assert.equal(listRequests(g).length, gListBefore, '卸载后旧失败不得 load');
  assert.equal(g.page.data.busy, true, '旧失败不得复位忙态');
  assert.equal(g.page.data.message, gMessage);
});

test('历史删除：重进后的新读取/新忙态不被旧 DELETE 成功或失败覆盖，当前新删除仍正常', async () => {
  // 旧成功晚到：重进后新读取仍在飞。
  const f = fixture();
  await openList(f, [historyRow(1)]);
  let modal = openDeleteModal(f);
  modal.success({ confirm: true });
  await flush();
  const staleSuccess = deleteRequests(f).at(-1);

  f.page.onHide();
  f.page.onShow();
  await answerGate(f);
  const freshReads = listRequests(f).length;
  assert.equal(f.page.data.busy, true, '重进后新读取已建立 busy');
  f.page.writes = 0;

  answerDelete(f, staleSuccess, 'unwired');
  await flush();
  assert.equal(f.page.writes, 0, '旧成功不得写新页面');
  assert.equal(listRequests(f).length, freshReads, '旧成功不得触发 load');
  assert.equal(f.page.data.busy, true, '旧成功不得清除新读取的 busy');
  assert.equal(f.page.data.message, '', '旧成功不得改新页面文案');

  // 新读取正常落地。
  answerList(f, [historyRow(2)], null);
  await flush();
  assert.deepEqual(ids(f.page), [historyRow(2).id]);
  assert.equal(f.page.data.busy, false);

  // 当前新删除仍正常：用新行 id/revision 发 DELETE，并展示新的级联文案。
  modal = openDeleteModal(f);
  modal.success({ confirm: true });
  await flush();
  const current = deleteRequests(f).at(-1);
  assert.notEqual(current, staleSuccess, '新删除必须发新请求');
  assert.ok(current.url.endsWith('/history/' + historyRow(2).id));
  assert.equal(current.header['If-Match'], '"1"');
  answerDelete(f, current, 'initiated');
  await flush();
  assert.equal(f.page.data.message, '已删除记录。' + f.history.cascadeNote('initiated'));

  // 旧失败晚到：同样不得覆盖重进后的新读取。
  const g = fixture();
  await openList(g, [historyRow(1)]);
  modal = openDeleteModal(g);
  modal.success({ confirm: true });
  await flush();
  const staleFailure = deleteRequests(g).at(-1);

  g.page.onHide();
  g.page.onShow();
  await answerGate(g);
  const gFreshReads = listRequests(g).length;
  assert.equal(g.page.data.busy, true);
  g.page.writes = 0;

  answerDeleteError(g, staleFailure, 'PROVIDER_UNAVAILABLE', 503);
  await flush();
  assert.equal(g.page.writes, 0, '旧失败不得写新页面');
  assert.equal(listRequests(g).length, gFreshReads, '旧失败不得触发 load');
  assert.equal(g.page.data.busy, true, '旧失败不得清除新读取的 busy');
  assert.equal(g.page.data.message, '');

  answerList(g, [historyRow(3)], null);
  await flush();
  assert.deepEqual(ids(g.page), [historyRow(3).id]);
  assert.equal(g.page.data.busy, false);
});

test('历史删除：同页新的列表读取不阻断确认，也不使当前 DELETE 写回失效', async () => {
  const f = fixture();
  await openList(f, [historyRow(1)]);

  // 弹窗已打开、尚未确认时发生同页读取：`busy` 短暂为 true，但删除已在确认前发起，
  // 读取换代不得阻断这次正常确认。
  const modal = openDeleteModal(f);
  f.page.onRefresh();
  const firstRead = lastListRequest(f);
  assert.equal(f.page.data.busy, true, '同页读取已进入 busy');

  modal.success({ confirm: true });
  await flush();
  const del = deleteRequests(f).at(-1);
  assert.ok(del, '同页读取不得阻断已发起删除的确认');
  assert.equal(f.page.data.message, '正在删除…');
  const listAfterConfirm = listRequests(f).length;

  // DELETE 在飞时再来一次同页读取：`_listEpoch` 再次前进，但页面代次没变。
  f.page.onRefresh();
  const secondRead = lastListRequest(f);
  assert.equal(listRequests(f).length, listAfterConfirm + 1);

  f.page.writes = 0;
  answerDelete(f, del, 'unwired');
  await flush();
  assert.notEqual(f.page.writes, 0, '当前删除仍须写回（不得被读取代次误杀）');
  assert.equal(f.page.data.message, '已删除记录。' + f.history.cascadeNote('unwired'));
  assert.equal(listRequests(f).length, listAfterConfirm + 2, '当前成功仍须重读列表');

  // 收尾：两次旧读取都应按读取代次丢弃，最后让删除触发的重读落地。
  const reread = lastListRequest(f);
  answerList(f, [historyRow(98)], null, firstRead);
  await flush();
  answerList(f, [historyRow(99)], null, secondRead);
  await flush();
  answerList(f, [], null, reread);
  await flush();
  assert.equal(f.page.data.busy, false);
  assert.deepEqual(ids(f.page), []);
});
