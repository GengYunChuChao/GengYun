// GY-I16 小程序侧：收藏／历史消费层与纯视图模型（合成响应；**不是**真机或微信工具证据）。
//
// 覆盖 issue #16 的客户端验收：
//   * 收藏：闭集校验、去重（服务端语义）、取消带 If-Match/幂等键、不可用呈现**不细分**隐藏与不存在；
//   * 历史：失败状态真实可见、任务类型/时间显示、**候选与人工选择分开**、OCR 原始/更正/核对分开、
//     来源版本来自 `model_version`；
//   * 负例：**旧链接夹带的状态字段一律忽略**，详情状态只来自实时读取；快照兜底定位时**不携带状态**；
//   * 无网络/未登录 ⇒ 如实失败，绝不用本地数据顶替。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const UUID_A = '00000000-0000-4000-8a00-000000000001';
const UUID_B = '00000000-0000-4000-8b00-000000000002';
const TARGET = '11111111-1111-4111-8111-111111111111';
const future = () => new Date(Date.now() + 3600_000).toISOString();
const flush = () => new Promise((r) => setImmediate(r));

function fixture({ mode = 'local' } = {}) {
  const requests = [];
  const storage = new Map();
  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    request: (o) => requests.push(o),
    showModal: (o) => o.success({ confirm: true }),
    navigateTo: () => {},
    reLaunch: () => {},
    switchTab: () => {},
    showToast: () => {}
  };
  const page = { route: 'pages/favorites/favorites', options: {}, data: {}, setData(p) { Object.assign(this.data, p) } };
  const cache = new Map();
  function load(path) {
    path = resolve(path);
    if (path.endsWith('runtime.js')) return { mode, apiBaseUrl: mode === 'local' ? 'http://127.0.0.1:1234/api/v1' : '' };
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
  const favorites = load(root + '/miniprogram/utils/favorites-api.js');
  const history = load(root + '/miniprogram/utils/history-api.js');
  return { wx, requests, page, auth, favorites, history, load };
}

/** 让会话通过**服务端核实**（`isLoggedIn()` 才可能为真）。 */
function login(f) {
  f.auth.setSession({ accessToken: 'synthetic-i16-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
  let verified = null;
  f.auth.requireLogin((ok) => { verified = ok; });
  const request = f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1);
  request.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } });
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

function favorite(overrides = {}) {
  return Object.assign({
    id: UUID_A, revision: 1, target_ref: { type: 'species', id: TARGET, revision: 3 },
    reference_state: 'available', unavailable_reason: null, created_at: '2026-10-14T06:00:00.000Z'
  }, overrides);
}

function historyItem(overrides = {}) {
  return Object.assign({
    id: UUID_B, revision: 1, kind: 'recognition',
    target_ref: { type: 'recognition', id: TARGET, revision: 2 },
    job_state: 'succeeded', reference_state: 'available', created_at: '2026-10-14T06:00:00.000Z'
  }, overrides);
}

function recognition(overrides = {}) {
  return Object.assign({
    id: TARGET, revision: 2,
    candidates: [{ species_id: 'spc-1', rank: 1, model_score: 0.82 }, { species_id: 'spc-2', rank: 2, model_score: null }],
    uncertainty_reasons: ['叶片遮挡'],
    selected_species_id: null,
    model_version: 'model-synthetic-v1'
  }, overrides);
}

function labelFields(overrides = {}) {
  return Object.assign({ registration_number: null, name: '演示制剂 A', ingredients: [{ name: '成分甲', content_text: '20', unit_text: '%' }], dosage_form: '悬浮剂' }, overrides);
}

function ocr(overrides = {}) {
  return Object.assign({
    id: TARGET, revision: 4,
    raw_fields: labelFields(),
    corrected_fields: labelFields({ name: '演示制剂 A（更正）' }),
    verification: { match_state: 'matched', registration: null, conflict_fields: ['dosage_form'], missing_fields: ['registration_number'], dose_cards: [{ id: UUID_A }] },
    model_version: 'ocr-synthetic-v1'
  }, overrides);
}

test('收藏客户端：未联网如实失败；成功响应逐字段校验；可用时不得给不可用说明', async () => {
  const off = fixture({ mode: 'disabled' });
  off.auth.setSession({ accessToken: 't', audience: 'user', expiresAt: future(), executionMode: 'stub' });
  await assert.rejects(() => off.favorites.listFavorites('', 20), (e) => e.code === 'SESSION_REQUIRED');
  assert.equal(off.requests.length, 0, '未启用联网时不得发出任何请求');

  const f = fixture();
  assert.equal(await login(f), true);
  const promise = f.favorites.listFavorites('', 20);
  answer(f, { items: [favorite()], next_cursor: null });
  const result = await promise;
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].reference_state, 'available');
  assert.equal(result.items[0].unavailable_reason, null);
  assert.equal(result.nextCursor, null);
  assert.equal(result.mode, 'stub');

  // 可用却带不可用说明 ⇒ 响应异常（不放过）。
  const bad1 = f.favorites.listFavorites('', 20);
  answer(f, { items: [favorite({ unavailable_reason: '不该出现' })], next_cursor: null });
  await assert.rejects(() => bad1, (e) => e.code === 'INVALID_RESPONSE');

  // 多出契约外字段（"已使用"类事实）⇒ 响应异常。
  const bad2 = f.favorites.listFavorites('', 20);
  answer(f, { items: [Object.assign(favorite(), { used: true })], next_cursor: null });
  await assert.rejects(() => bad2, (e) => e.code === 'INVALID_RESPONSE');

  // 不可用但说明缺失 ⇒ 响应异常。
  const bad3 = f.favorites.listFavorites('', 20);
  answer(f, { items: [favorite({ reference_state: 'unavailable', unavailable_reason: null })], next_cursor: null });
  await assert.rejects(() => bad3, (e) => e.code === 'INVALID_RESPONSE');
});

test('收藏客户端：闭集拒绝（本地不发请求）、取消带 If-Match 与幂等键、呈现口径非披露', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  const before = f.requests.length;
  for (const [type, id, revision] of [['post', TARGET, 1], ['static_region', TARGET, 1], ['species', '', 1], ['species', TARGET, 0]]) {
    await assert.rejects(() => f.favorites.createFavorite(type, id, revision), (e) => e.code === 'INVALID_INPUT');
  }
  assert.equal(f.requests.length, before, '非法入参不得发请求');

  const create = f.favorites.createFavorite('herbicide', TARGET, 3);
  const createRequest = answer(f, favorite({ target_ref: { type: 'herbicide', id: TARGET, revision: 3 } }), 201, { ETag: '"1"' });
  assert.equal(createRequest.method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(createRequest.data)), { target_ref: { type: 'herbicide', id: TARGET, revision: 3 } });
  assert.ok(createRequest.header['Idempotency-Key'].length >= 8);
  assert.equal((await create).favorite.revision, 1);

  const remove = f.favorites.deleteFavorite(UUID_A, 1);
  const deleteRequest = answer(f, { accepted: true });
  assert.equal(deleteRequest.method, 'DELETE');
  assert.equal(deleteRequest.header['If-Match'], '"1"');
  assert.ok(deleteRequest.header['Idempotency-Key'].length >= 8);
  assert.deepEqual(JSON.parse(JSON.stringify(await remove)), { accepted: true, mode: 'stub' });

  // 呈现口径：可用 → 有查看入口；不可用 → 用**服务端给的**说明，不细分隐藏/不存在。
  const available = f.favorites.describeFavorite(favorite());
  assert.equal(available.tone, 'ok');
  assert.equal(available.actionText, '查看资料');
  const unavailable = f.favorites.describeFavorite(favorite({ reference_state: 'unavailable', unavailable_reason: '目标已下架、已失效、已隐藏、已删除或不属于当前账号' }));
  assert.equal(unavailable.tone, 'muted');
  assert.equal(unavailable.actionText, '');
  assert.equal(unavailable.hint, '目标已下架、已失效、已隐藏、已删除或不属于当前账号');
  assert.equal(/隐藏|不存在/.test(unavailable.label), false, '呈现文案不得自行细分隐藏与不存在');
  assert.equal(f.favorites.targetTypeLabel('scheme'), '方案');
  assert.ok(f.favorites.messageFor({ code: 'NOT_FOUND' }).length > 0);
  assert.ok(f.favorites.messageFor({ code: 'PROVIDER_UNAVAILABLE' }).includes('不会用本地数据顶替'));
});

test('历史客户端：旧链接夹带的状态字段一律忽略，详情链接只接受 id', () => {
  const f = fixture();
  const stale = f.history.parseDetailQuery({ id: UUID_B, job_state: 'succeeded', reference_state: 'available', created_at: '2020-01-01T00:00:00Z', kind: 'ocr' });
  assert.equal(stale.valid, true);
  assert.equal(stale.id, UUID_B);
  assert.deepEqual([...stale.ignored].sort(), ['created_at', 'job_state', 'kind', 'reference_state']);
  assert.equal(Object.hasOwn(stale, 'jobState'), false, '解析结果不得携带任何状态字段');
  assert.equal(Object.hasOwn(stale, 'referenceState'), false);

  const bad = f.history.parseDetailQuery({ id: 'not-a-uuid' });
  assert.equal(bad.valid, false);
  assert.equal(bad.id, null);
  assert.deepEqual(f.history.parseDetailQuery({}).valid, false);
});

test('历史客户端：失败状态真实可见、任务类型与时间显示、列表响应逐字段校验', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  const promise = f.history.listHistory('', 20);
  answer(f, { items: [historyItem({ job_state: 'timed_out' }), historyItem({ id: UUID_A, kind: 'ocr', job_state: 'failed' })], next_cursor: 'opaque.cursor' });
  const result = await promise;
  assert.equal(result.items.length, 2);
  assert.equal(result.nextCursor, 'opaque.cursor');

  const view = f.history.historyItemView(result.items[0]);
  assert.equal(view.state, 'timed_out');
  assert.equal(view.failed, true);
  assert.match(view.stateLabel, /超时/);
  assert.equal(view.kindLabel, '识草');
  assert.equal(view.createdText, '2026-10-14 06:00:00 UTC');
  assert.equal(f.history.historyItemView(result.items[1]).kindLabel, '标签识别');
  // 目标不可用时不给跳转入口（旧链接不复活）。
  assert.equal(f.history.historyItemView(historyItem({ reference_state: 'unavailable' })).navigable, false);

  // `job_state` 非闭集 ⇒ 响应异常（不得兜底成"成功"）。
  const bad = f.history.listHistory('', 20);
  answer(f, { items: [historyItem({ job_state: 'unknown' })], next_cursor: null });
  await assert.rejects(() => bad, (e) => e.code === 'INVALID_RESPONSE');
});

test('历史详情：实时读取优先；实时未命中时快照只用于定位、**不携带状态**', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  // 列表页写入引用快照（详情页只用它定位）。
  f.history.remember([historyItem({ job_state: 'failed', reference_state: 'unavailable' })]);

  // 1) 实时命中 ⇒ 带回实时状态。
  const live = f.history.locateHistory(UUID_B, 50);
  answer(f, { items: [historyItem({ job_state: 'succeeded' })], next_cursor: null });
  const located = await live;
  assert.equal(located.locatedBy, 'live');
  assert.equal(located.jobState, 'succeeded', '必须以实时读取为准，而不是快照里的 failed');
  assert.equal(located.referenceState, 'available');
  assert.equal(located.targetId, TARGET);

  // 2) 实时未命中（记录不在第一页）⇒ 退回快照，但**不带任何状态**。
  const fallback = f.history.locateHistory(UUID_B, 50);
  answer(f, { items: [], next_cursor: null });
  const fromSnapshot = await fallback;
  assert.equal(fromSnapshot.locatedBy, 'snapshot');
  assert.equal(fromSnapshot.jobState, null, '快照不得携带过期状态');
  assert.equal(fromSnapshot.referenceState, null);
  assert.equal(fromSnapshot.kind, 'recognition');
  assert.equal(fromSnapshot.targetId, TARGET);

  // 3) 都没有 ⇒ null（页面显示"不存在/已删除/不属于当前账号"）。
  f.history.clearSelection();
  const missing = f.history.locateHistory(UUID_B, 50);
  answer(f, { items: [], next_cursor: null });
  assert.equal(await missing, null);
});

test('历史详情视图：候选与人工选择分开、失败不当作成功、分数不是准确率', () => {
  const f = fixture();
  const succeeded = f.history.recognitionDetailView(recognition(), 'succeeded');
  assert.equal(succeeded.candidateSelectionSeparated, true);
  assert.equal(succeeded.recognized, true);
  assert.equal(succeeded.modelCandidates.length, 2);
  assert.equal(succeeded.modelCandidates[0].scoreText, '82%');
  assert.equal(succeeded.modelCandidates[1].scoreText, '无分数');
  assert.equal(succeeded.manualSelection.present, false);
  assert.equal(succeeded.manualSelection.label, '未人工选择');
  assert.match(succeeded.modelCandidateNote, /不是准确率/);
  assert.match(succeeded.manualSelection.note, /已使用/);
  assert.equal(succeeded.sourceVersion, 'model-synthetic-v1');
  assert.deepEqual(succeeded.uncertaintyReasons, ['叶片遮挡']);

  // 人工选择与模型候选是**两个**分离字段。
  const chosen = f.history.recognitionDetailView(recognition({ selected_species_id: 'spc-2' }), 'succeeded');
  assert.equal(chosen.manualSelection.present, true);
  assert.equal(chosen.manualSelection.selected, 'spc-2');
  assert.equal(chosen.modelCandidates.length, 2, '人工选择不得覆盖或删掉模型候选');

  // 失败/超时/取消/不确定 ⇒ 不当作成功；未成功时不把候选当结果。
  for (const state of ['failed', 'timed_out', 'cancelled', 'uncertain', 'queued', 'running']) {
    const view = f.history.recognitionDetailView(recognition(), state);
    assert.equal(view.recognized, false, state);
    assert.match(view.modelCandidateNote, /不把任何候选当作结果/);
  }
  // 状态未取得（空状态）同样不得当作成功。
  assert.equal(f.history.recognitionDetailView(recognition(), '').recognized, false);
});

test('OCR 视图：原始字段/人工更正/核对结果分开，只报用量卡数量（不展示用量内容）', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  // 视图模型吃的是**已校验**的 OCR 投影（页面真实路径：getOcr → validateOcr → ocrDetailView）。
  const valid = f.history.getOcr(TARGET);
  answer(f, ocr());
  const { ocr: validated } = await valid;

  const view = f.history.ocrDetailView(validated);
  assert.equal(view.raw.name, '演示制剂 A');
  assert.equal(view.corrected.name, '演示制剂 A（更正）');
  assert.equal(view.correctedDiffers, true);
  assert.equal(view.verification.matchState, 'matched');
  assert.match(view.verification.matchLabel, /已匹配/);
  assert.deepEqual([...view.verification.conflictFields], ['dosage_form']);
  assert.deepEqual([...view.verification.missingFields], ['registration_number']);
  assert.equal(view.verification.doseCardCount, 1);
  assert.equal(JSON.stringify(view).includes('original_text'), false, '不得渲染用量卡正文');
  assert.match(view.doseSafetyNote, /不构成用药建议/);
  assert.equal(view.sourceVersion, 'ocr-synthetic-v1');

  // `getOcr` 逐字段校验：多出契约外字段 ⇒ 响应异常。
  const bad = f.history.getOcr(TARGET);
  answer(f, Object.assign(ocr(), { used: true }));
  await assert.rejects(() => bad, (e) => e.code === 'INVALID_RESPONSE');

  // `verification.match_state` 非闭集 ⇒ 响应异常。
  const bad2 = f.history.getOcr(TARGET);
  answer(f, ocr({ verification: Object.assign(ocr().verification, { match_state: 'weird' }) }));
  await assert.rejects(() => bad2, (e) => e.code === 'INVALID_RESPONSE');
});

test('级联披露（非契约标记）三态文案不同，未接线明确说明只删了记录本身', () => {
  const f = fixture();
  const unwired = f.history.cascadeNote('unwired');
  assert.match(unwired, /只删除了历史记录本身/);
  assert.match(f.history.cascadeNote('initiated'), /不等于已完成/);
  assert.match(f.history.cascadeNote('failed'), /启动失败/);
  assert.notEqual(unwired, f.history.cascadeNote('initiated'));
  assert.match(f.history.cascadeNote(null), /未取得/);
  assert.ok(f.history.messageFor({ code: 'NOT_FOUND' }).length > 0);
});
