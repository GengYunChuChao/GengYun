// GY-I16 历史详情页：删除请求的生命周期隔离（合成 wx / 真实 utils 装载）。
// 不是微信开发者工具、Android 真机或真实删除级联证据。
//
// 修复前的真实缺口（本文件逐条钉住）：
//   1. 确认弹窗晚到：`onDelete` 的 success 回调不校页面世代，离页/重进/刷新换代后旧确认
//      仍会 setData 并发 `DELETE /history/{id}`；
//   2. 删除在飞：`deleteHistory().then/catch` 不校世代，旧成功 / NOT_FOUND / 普通失败会
//      覆盖新页面的详情、新 busy，并 `clearSelection()` 清掉新的定位快照；
//   3. 删除请求的目标（id / revision）必须取本次确认对应的目标，不得拿新页面的 revision 顶替。
//
// 修复后仍须保留：当前成功与级联说明、NOT_FOUND 降级、普通错误/版本冲突提示、取消确认、
// 双击 busy 保护，以及刷新/重进后的可用恢复（不留下永久 busy）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const HISTORY_ID = '00000000-0000-4000-8a00-000000000001';
const TARGET = '11111111-1111-4111-8111-111111111111';
const DETAIL_PAGE = root + '/miniprogram/pages/historydetail/historydetail.js';
const future = () => new Date(Date.now() + 3600_000).toISOString();
const flush = () => new Promise((r) => setImmediate(r));

/** 与既有测试同一套最小 wx 夹具；`showModal` 由用例手动作答（旧弹窗可晚到）。 */
function fixture() {
  const requests = [];
  const storage = new Map();
  const modals = [];
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
  return { wx, requests, modals, page, auth, history, load };
}

/** 让会话通过**服务端核实**（`isLoggedIn()` 才可能为真）。 */
function login(f) {
  f.auth.setSession({ accessToken: 'synthetic-i16-delete-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
  let verified = null;
  f.auth.requireLogin((ok) => { verified = ok; });
  f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1)
    .success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } });
  return flush().then(() => verified);
}

function meta() {
  return { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' };
}

function answer(f, payload, statusCode = 200, header = {}) {
  const request = f.requests.at(-1);
  const ok = statusCode >= 200 && statusCode < 300;
  request.success({ statusCode, data: ok ? { data: payload, meta: meta() } : payload, header });
  return request;
}

function errorPayload(code) {
  return { error: { code, message: 'synthetic', retryable: false } };
}

function historyItem(overrides = {}) {
  return Object.assign({
    id: HISTORY_ID, revision: 1, kind: 'recognition',
    target_ref: { type: 'recognition', id: TARGET, revision: 2 },
    job_state: 'succeeded', reference_state: 'available',
    created_at: '2026-10-14T06:00:00.000Z'
  }, overrides);
}

function recognition(overrides = {}) {
  return Object.assign({
    id: TARGET, revision: 2,
    candidates: [
      { species_id: 'spc-1', rank: 1, model_score: 0.82 },
      { species_id: 'spc-2', rank: 2, model_score: null }
    ],
    uncertainty_reasons: ['叶片遮挡'],
    selected_species_id: null,
    model_version: 'model-synthetic-v1'
  }, overrides);
}

/** 页面 onShow 内的门禁核实（GET /auth/session）在函数内作答。 */
async function passGate(f, call) {
  call();
  const gate = f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1);
  assert.ok(gate, '门禁必须发出一次会话核实请求');
  gate.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } });
  await flush();
}

/** 打开详情页到"实时读取成功、详情已渲染、可删除"。 */
async function openLoaded(f, item = historyItem(), detail = recognition()) {
  f.history.remember([item]);
  f.page.onLoad({ id: item.id });
  await passGate(f, () => f.page.onShow());
  answer(f, { items: [item], next_cursor: null });
  await flush();
  answer(f, detail);
  await flush();
  assert.equal(f.page.data.locatedBy, 'live');
  assert.equal(f.page.data.canDelete, true);
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.historyRevision, item.revision);
}

function deleteRequests(f) {
  return f.requests.filter((r) => r.method === 'DELETE');
}

/** 打开删除确认并确认；返回本次发出的 DELETE 请求。 */
function confirmDelete(f) {
  f.page.onDelete();
  const modal = f.modals.at(-1);
  assert.ok(modal, '删除前必须弹确认框');
  modal.success({ confirm: true });
  return deleteRequests(f).at(-1);
}

function deleteSuccess(cascade = 'unwired') {
  return { statusCode: 202, data: { data: { accepted: true }, meta: meta() }, header: { 'X-GY-Cascade': cascade } };
}

test('当前删除：按本次 id/revision 发 DELETE，成功展示级联说明并收口，才清定位快照', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openLoaded(f);
  assert.notEqual(f.history.expected(HISTORY_ID), null);

  f.page.onDelete();
  const modal = f.modals.at(-1);
  assert.equal(deleteRequests(f).length, 0, '确认前不得发 DELETE');
  modal.success({ confirm: true });

  const del = deleteRequests(f).at(-1);
  assert.equal(del.url.endsWith('/history/' + HISTORY_ID), true);
  assert.equal(del.header['If-Match'], '"1"');
  assert.ok(del.header['Idempotency-Key'].length >= 8);
  assert.equal(f.page.data.busy, true);
  assert.equal(f.page.data.message, '正在删除…');

  del.success(deleteSuccess('unwired'));
  await flush();
  await flush();

  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.message, '已删除记录。' + f.history.cascadeNote('unwired'));
  assert.equal(f.page.data.invalid, true);
  assert.equal(f.page.data.invalidReason, '该记录已删除。');
  assert.equal(f.page.data.canDelete, false);
  assert.equal(f.page.data.historyRevision, null);
  assert.equal(f.page.data.recognized, false);
  assert.equal(Array.from(f.page.data.modelCandidates).length, 0);
  assert.equal(f.history.expected(HISTORY_ID), null, '当前世代的成功删除才清掉定位快照');
});

test('当前删除 NOT_FOUND：按"记录不可用"降级，不复述成成功，也不留删除入口', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openLoaded(f);

  const del = confirmDelete(f);
  del.success({ statusCode: 404, data: errorPayload('NOT_FOUND') });
  await flush();
  await flush();

  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.message, f.history.messageFor({ code: 'NOT_FOUND' }));
  assert.equal(f.page.data.invalid, true);
  assert.match(f.page.data.invalidReason, /不存在|已删除|不属于当前账号/);
  assert.equal(/已删除记录/.test(f.page.data.message), false, 'NOT_FOUND 不得被说成删除成功');
  assert.equal(f.page.data.canDelete, false);
  assert.equal(f.page.data.historyRevision, null);
  assert.equal(f.history.expected(HISTORY_ID), null);
});

test('当前删除版本冲突与普通错误：如实提示、保留详情与入口，仍可用同一 revision 重试', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openLoaded(f);

  const conflict = confirmDelete(f);
  conflict.success({ statusCode: 409, data: errorPayload('REVISION_CONFLICT') });
  await flush();
  await flush();

  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.message, f.history.messageFor({ code: 'REVISION_CONFLICT' }));
  assert.equal(f.page.data.invalid, false, '版本冲突不是"记录不存在"');
  assert.equal(f.page.data.canDelete, true, '仍保留删除入口供刷新/重试');
  assert.equal(f.page.data.historyRevision, 1);
  assert.equal(f.page.data.recognized, true);
  assert.equal(Array.from(f.page.data.modelCandidates).length, 2, '失败不得清掉已读到的详情');
  assert.notEqual(f.history.expected(HISTORY_ID), null, '失败不得清定位快照');

  // 普通错误（服务不可用）同样如实提示，不当作成功。
  const failed = confirmDelete(f);
  assert.equal(failed.header['If-Match'], '"1"');
  failed.success({ statusCode: 503, data: errorPayload('PROVIDER_UNAVAILABLE') });
  await flush();
  await flush();

  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.message, f.history.messageFor({ code: 'PROVIDER_UNAVAILABLE' }));
  assert.equal(f.page.data.invalid, false);
  assert.equal(f.page.data.canDelete, true);
  assert.equal(f.page.data.recognized, true);
  assert.notEqual(f.history.expected(HISTORY_ID), null);
});

test('取消确认不发请求；删除在飞时双击产生的旧确认不得重复 DELETE', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openLoaded(f);

  // 取消：不发请求、不改页面。
  f.page.onDelete();
  f.modals.at(-1).success({ confirm: false });
  assert.equal(deleteRequests(f).length, 0);
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.canDelete, true);

  // 双击在确认前各开一个弹窗；第一个确认后在飞，第二个晚到的确认必须被 busy 挡住。
  f.page.onDelete();
  f.page.onDelete();
  assert.equal(f.modals.length, 3);
  f.modals[1].success({ confirm: true });
  assert.equal(deleteRequests(f).length, 1);
  f.modals[2].success({ confirm: true });
  assert.equal(deleteRequests(f).length, 1, '在飞时旧确认不得重复删除');

  deleteRequests(f)[0].success(deleteSuccess('initiated'));
  await flush();
  await flush();
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.invalid, true);
});

test('同一会话 hide 后旧 DELETE 成功静默：不写页面、不清新的定位快照', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openLoaded(f);

  const del = confirmDelete(f);
  f.page.onHide();
  del.success(deleteSuccess('unwired'));
  await flush();
  await flush();

  assert.equal(f.page.data.message, '正在删除…', '旧成功不得写 message');
  assert.equal(f.page.data.busy, true, '旧成功不得替页面复位 busy');
  assert.equal(f.page.data.invalid, false);
  assert.equal(f.page.data.canDelete, true);
  assert.equal(f.page.data.historyRevision, 1);
  assert.equal(f.page.data.recognized, true);
  assert.equal(Array.from(f.page.data.modelCandidates).length, 2);
  assert.equal(f.page.data.sourceVersion, 'model-synthetic-v1');
  assert.notEqual(f.history.expected(HISTORY_ID), null, '旧成功不得清掉定位快照');
});

test('同一会话 unload 后旧 DELETE NOT_FOUND 静默：不降级、不清新的定位快照', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openLoaded(f);

  const del = confirmDelete(f);
  f.page.onUnload();
  del.success({ statusCode: 404, data: errorPayload('NOT_FOUND') });
  await flush();
  await flush();

  assert.equal(f.page.data.message, '正在删除…');
  assert.equal(f.page.data.busy, true);
  assert.equal(f.page.data.invalid, false, '旧 NOT_FOUND 不得把页面改成"记录不可用"');
  assert.equal(f.page.data.canDelete, true);
  assert.equal(f.page.data.historyRevision, 1);
  assert.equal(f.page.data.recognized, true);
  assert.notEqual(f.history.expected(HISTORY_ID), null, '旧 NOT_FOUND 不得清掉定位快照');
});

test('重进并读到新详情后：旧 DELETE 成功不覆盖新详情/busy/快照，新删除用新 revision 正常完成', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openLoaded(f);

  const stale = confirmDelete(f);
  assert.equal(stale.header['If-Match'], '"1"');

  // 离页再重进：新一轮实时读取拿到 revision 3、失败任务、目标不可用，详情版本也换了。
  f.page.onHide();
  await passGate(f, () => f.page.onShow());
  answer(f, { items: [historyItem({ revision: 3, job_state: 'failed', reference_state: 'unavailable' })], next_cursor: null });
  await flush();
  answer(f, recognition({ model_version: 'model-synthetic-v2', selected_species_id: 'spc-2' }));
  await flush();

  assert.equal(f.page.data.busy, false, '重进后新读取完成必须复位 busy');
  assert.equal(f.page.data.message, '');
  assert.equal(f.page.data.historyRevision, 3);
  assert.equal(f.page.data.canDelete, true);
  assert.equal(f.page.data.stateKnown, true);
  assert.equal(f.page.data.stateLabel, '识别失败');
  assert.equal(f.page.data.referenceAvailable, false);
  assert.equal(f.page.data.recognized, false);
  assert.equal(f.page.data.sourceVersion, 'model-synthetic-v2');

  // 旧删除这时才成功：页面上的新结论与定位快照都不得被动。
  stale.success(deleteSuccess('initiated'));
  await flush();
  await flush();

  assert.equal(f.page.data.message, '', '旧成功不得写"已删除"');
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.invalid, false);
  assert.equal(f.page.data.canDelete, true);
  assert.equal(f.page.data.historyRevision, 3);
  assert.equal(f.page.data.stateKnown, true);
  assert.equal(f.page.data.stateLabel, '识别失败');
  assert.equal(f.page.data.referenceAvailable, false);
  assert.equal(f.page.data.recognized, false);
  assert.equal(f.page.data.sourceVersion, 'model-synthetic-v2');
  assert.notEqual(f.history.expected(HISTORY_ID), null, '旧成功不得清掉新的定位快照');

  // 新操作照常：用新读到的 revision（3）删除，成功后才收口并清快照。
  const fresh = confirmDelete(f);
  assert.notEqual(fresh, stale);
  assert.equal(fresh.header['If-Match'], '"3"', '删除必须用本次目标的 revision，不得沿用旧值');
  assert.equal(fresh.url.endsWith('/history/' + HISTORY_ID), true);
  fresh.success(deleteSuccess('partial'));
  await flush();
  await flush();

  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.message, '已删除记录。' + f.history.cascadeNote('partial'));
  assert.equal(f.page.data.invalid, true);
  assert.equal(f.page.data.canDelete, false);
  assert.equal(f.history.expected(HISTORY_ID), null);
});

test('刷新新读取在飞时旧 DELETE 普通失败静默：不复位新 busy、不写错误；新读取完成后恢复可用', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  await openLoaded(f);

  const stale = confirmDelete(f);
  f.page.onRefresh(); // 新世代读取，busy=true 在飞
  assert.equal(f.page.data.busy, true);

  stale.success({ statusCode: 503, data: errorPayload('PROVIDER_UNAVAILABLE') });
  await flush();
  await flush();

  assert.equal(f.page.data.busy, true, '旧失败不得把新读取的 busy 提前复位');
  assert.equal(f.page.data.errorText, '');
  assert.equal(f.page.data.errorCode, '');
  assert.equal(f.page.data.message, '', '新一轮读取已清掉上一轮删除提示');
  assert.equal(f.page.data.canDelete, true, '旧失败不得撤掉新读取前的入口状态');

  // 新读取完成：详情回到可用状态，busy 正常收口。
  answer(f, { items: [historyItem({ revision: 2, job_state: 'running' })], next_cursor: null });
  await flush();
  answer(f, recognition());
  await flush();

  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.errorText, '');
  assert.equal(f.page.data.invalid, false);
  assert.equal(f.page.data.canDelete, true);
  assert.equal(f.page.data.historyRevision, 2);
  assert.equal(f.page.data.stateLabel, '识别中');
  assert.equal(f.page.data.recognized, false);
  assert.notEqual(f.history.expected(HISTORY_ID), null, '旧失败不得清掉新读取的定位快照');
});

test('旧确认弹窗在刷新/离页后晚到：不得对新页面发起 DELETE', async () => {
  // ① 刷新换代后晚到。
  const f = fixture();
  assert.equal(await login(f), true);
  await openLoaded(f);

  f.page.onDelete();
  const late = f.modals.at(-1);
  f.page.onRefresh();
  answer(f, { items: [historyItem({ revision: 4 })], next_cursor: null });
  await flush();
  answer(f, recognition({ model_version: 'model-synthetic-v4' }));
  await flush();
  assert.equal(f.page.data.historyRevision, 4);

  late.success({ confirm: true });
  assert.equal(deleteRequests(f).length, 0, '换代后的旧确认不得发 DELETE');
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.canDelete, true);
  assert.equal(f.page.data.historyRevision, 4);
  assert.equal(f.page.data.sourceVersion, 'model-synthetic-v4');

  // ② 离页（unload）后晚到。
  const g = fixture();
  assert.equal(await login(g), true);
  await openLoaded(g);
  g.page.onDelete();
  const afterUnload = g.modals.at(-1);
  g.page.onUnload();
  afterUnload.success({ confirm: true });
  assert.equal(deleteRequests(g).length, 0, '离页后的旧确认不得发 DELETE');
  assert.equal(g.page.data.busy, false);
});
