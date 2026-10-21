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

// 跨端一致性锚点：小程序侧的「冲突字段人话标签」必须认识服务端下发的这两个 token。
import {
  CONFLICT_FIELD_SOURCE_VALIDITY,
  CONFLICT_FIELD_SOURCE_REVIEW,
} from '../../services/api/src/ocr/state.ts';

const root = resolve(import.meta.dirname, '../..');
const UUID_A = '00000000-0000-4000-8a00-000000000001';
const UUID_B = '00000000-0000-4000-8b00-000000000002';
const TARGET = '11111111-1111-4111-8111-111111111111';
const future = () => new Date(Date.now() + 3600_000).toISOString();
const flush = () => new Promise((r) => setImmediate(r));

function fixture({ mode = 'local', route = 'pages/favorites/favorites' } = {}) {
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
  const page = { route, options: {}, data: {}, setData(p) { Object.assign(this.data, p) } };
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

test('历史详情：实时改为不可用时，不得用快照里的旧 available 顶替（失效不复活）', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  // 列表页写入的引用快照是"当时可用"——这正是旧链接/旧缓存的形态。
  f.history.remember([historyItem({ job_state: 'succeeded', reference_state: 'available' })]);

  // 详情页实时读取拿到的是"现在不可用"：必须以实时为准，快照里的旧 available 一律作废。
  const live = f.history.locateHistory(UUID_B, 50);
  answer(f, { items: [historyItem({ job_state: 'succeeded', reference_state: 'unavailable' })], next_cursor: null });
  const located = await live;
  assert.equal(located.locatedBy, 'live');
  assert.equal(located.referenceState, 'unavailable', '实时不可用必须压过快照里的旧 available');
  assert.equal(located.referenceState === 'available', false, '页面不得给出"打开资料"的入口');
  assert.equal(located.jobState, 'succeeded', '可见性变化不影响任务状态如实呈现');

  // 反向对照：实时可用时才允许 available（不是把页面做成恒不可用）。
  const back = f.history.locateHistory(UUID_B, 50);
  answer(f, { items: [historyItem({ job_state: 'succeeded', reference_state: 'available' })], next_cursor: null });
  assert.equal((await back).referenceState, 'available');
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
  // 原 token 照录不动，另给同序的中文标签（页面只显示中文，机器 token 仍可复核）。
  assert.deepEqual([...view.verification.conflictLabels], ['剂型']);
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

test('冲突字段人话标签：来源失效/被拒有中文说法，未知 token 原样保留（不改写、不猜）', () => {
  const f = fixture();
  assert.deepEqual(
    [...f.history.conflictFieldLabels([
      CONFLICT_FIELD_SOURCE_VALIDITY,
      CONFLICT_FIELD_SOURCE_REVIEW,
      'dosage_form',
      'ingredients',
      'mystery_token',
    ])],
    ['登记记录已失效或撤销', '登记记录已被拒绝核对', '剂型', '有效成分', 'mystery_token'],
  );
  // 空清单照旧为空：不补造任何一条冲突说法。
  assert.deepEqual([...f.history.conflictFieldLabels([])], []);
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

// ===========================================================================
// GY-I16 切片A：**详情页**收藏／取消收藏的接线（合成响应驱动页面实例；
// 仍**不是**真机、微信开发者工具或渲染证据 —— 本片按要求未 attach 9420）。
//
// 覆盖断点 4-A（详情页没有任何收藏入口）与 4-B（从收藏进详情后无法就地取消）。
// ===========================================================================

const DETAIL_PAGE = root + '/miniprogram/pages/knowledgedetail/knowledgedetail.js';

/** `GET /knowledge/{id}` 投影（Knowledge.type 闭集取值由用例指定）。 */
function knowledgeItem(overrides = {}) {
  return Object.assign({
    id: TARGET,
    revision: 7,
    type: 'species',
    title: '稻飞虱的识别与田间核对',
    body: '正文（合成演示内容，不代表真实资料）。',
    source: {
      id: UUID_B,
      version: 'v1.0.0',
      title: '示范资料来源',
      url: 'https://example.org/knowledge/demo-1',
      publisher: '示范出版方',
      source_kind: 'verified_seed',
      evidence_kind: 'research',
      validity: 'valid',
      review_status: 'verified',
      updated_at: '2026-10-01T00:00:00.000Z'
    },
    conditions: null,
    reference_state: 'available',
    dose_cards: []
  }, overrides);
}

/**
 * 打开详情页到"资料已读到"这一步：门禁核实（GET /auth/session，函数内作答）
 * → GET /knowledge/{id}（函数内作答）→ 收藏状态回填请求（**留给用例作答**）。
 */
async function openDetailPage(f, item) {
  f.page.onLoad({ id: item.id });
  f.page.onShow();
  const gate = f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1);
  gate.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } });
  await flush();
  const detail = f.requests.filter((r) => r.url.includes('/knowledge/')).at(-1);
  detail.success({ statusCode: 200, data: { data: item, meta: meta() } });
  await flush();
  return f.requests.filter((r) => r.url.includes('/favorites')).at(-1);
}

function detailFixture() {
  const f = fixture({ route: 'pages/knowledgedetail/knowledgedetail' });
  f.load(DETAIL_PAGE);
  return f;
}

const favoriteRequests = (f) => f.requests.filter((r) => r.url.includes('/favorites'));

test('详情页收藏（切片A，断点4-B）：进详情即按服务端收藏回填，可就地取消并带 If-Match／幂等键', async () => {
  const f = detailFixture();
  assert.equal(await login(f), true);
  const item = knowledgeItem();
  await openDetailPage(f, item);
  // read() 的既有语义不得被收藏接线改变。
  assert.equal(f.page.data.stateKind, 'ready');
  assert.equal(f.page.data.status, '已重新读取当前资料。');
  assert.equal(f.page.data.item.id, item.id);

  // 回填：逐次读 GET /favorites（第一页，服务端上限 limit=50）。
  const scan = f.requests.at(-1);
  assert.equal(scan.method, 'GET');
  assert.match(scan.url, /\/favorites\?limit=50$/);
  assert.equal(scan.header.authorization, 'Bearer synthetic-i16-token');
  // 本用例的替身响应把该收藏置为 unavailable（服务端引用可用性端口已于 #167 接线、逐次派生；
  // 本页不依赖该取值）——本页不得因此把收藏入口判为失败，也不得据此展示任何可用性结论。
  answer(f, {
    items: [favorite({
      id: UUID_A, revision: 3,
      target_ref: { type: 'species', id: item.id, revision: item.revision },
      reference_state: 'unavailable',
      unavailable_reason: '目标已下架、已失效、已隐藏、已删除或不属于当前账号'
    })],
    next_cursor: null
  });
  await flush();
  assert.equal(f.page.data.favSupported, true);
  assert.equal(f.page.data.favState, 'favorited');
  assert.equal(f.page.data.favLabel, '取消收藏');
  assert.equal(f.page.data.favNote, '已收藏该资料。');
  assert.equal(f.page.data.favBusy, false);
  assert.equal(/不可用|不存在/.test(f.page.data.favNote), false, '收藏入口不得复述或推断可用性结论');

  // 就地取消（断点 4-B 的正解）：DELETE /favorites/{服务端给的 id} + If-Match + Idempotency-Key。
  const before = f.requests.length;
  f.page.toggleFavorite();
  assert.equal(f.requests.length, before + 1, '取消收藏只发一条请求');
  const remove = f.requests.at(-1);
  assert.equal(remove.method, 'DELETE');
  assert.ok(remove.url.endsWith('/favorites/' + UUID_A));
  assert.equal(remove.header['If-Match'], '"3"');
  assert.ok(remove.header['Idempotency-Key'].length >= 8);
  answer(f, { accepted: true });
  await flush();
  assert.equal(f.page.data.favState, 'none');
  assert.equal(f.page.data.favLabel, '收藏');
  assert.equal(f.page.data.favNote, '已取消收藏。');
  assert.equal(f.page.data.favBusy, false);
});

test('详情页收藏（切片A，断点4-A）：未收藏时发 POST /favorites，返回行决定下一次取消的 id 与 revision', async () => {
  const f = detailFixture();
  assert.equal(await login(f), true);
  const item = knowledgeItem({ type: 'herbicide', revision: 5 });
  await openDetailPage(f, item);
  answer(f, { items: [], next_cursor: null });
  await flush();
  assert.equal(f.page.data.favState, 'none');
  assert.equal(f.page.data.favLabel, '收藏');

  f.page.toggleFavorite();
  const create = f.requests.at(-1);
  assert.equal(create.method, 'POST');
  assert.ok(create.url.endsWith('/favorites'));
  assert.deepEqual(JSON.parse(JSON.stringify(create.data)), { target_ref: { type: 'herbicide', id: item.id, revision: 5 } });
  assert.ok(create.header['Idempotency-Key'].length >= 8);
  assert.equal(create.header['If-Match'], undefined, '新建收藏不得携带 If-Match');
  answer(f, favorite({ id: UUID_B, revision: 4, target_ref: { type: 'herbicide', id: item.id, revision: 5 } }), 201, { ETag: '"4"' });
  await flush();
  assert.equal(f.page.data.favState, 'favorited');
  assert.equal(f.page.data.favLabel, '取消收藏');

  // 取消必须用**服务端返回行**的 id/revision，不得用资料自身的 revision(5) 冒充。
  f.page.toggleFavorite();
  const remove = f.requests.at(-1);
  assert.equal(remove.method, 'DELETE');
  assert.ok(remove.url.endsWith('/favorites/' + UUID_B));
  assert.equal(remove.header['If-Match'], '"4"');
  answer(f, { accepted: true });
  await flush();
  assert.equal(f.page.data.favState, 'none');
  assert.equal(f.page.data.favNote, '已取消收藏。');
});

test('详情页收藏（切片A）：闭集外目标（static_region）不给入口、不发任何收藏请求', async () => {
  const f = detailFixture();
  assert.equal(await login(f), true);
  const item = knowledgeItem({ type: 'static_region' });
  assert.equal(await openDetailPage(f, item), undefined);
  assert.equal(favoriteRequests(f).length, 0, '闭集外目标不得回填收藏');
  assert.equal(f.page.data.favSupported, false);
  assert.equal(f.page.data.favState, 'unsupported');
  assert.match(f.page.data.favNote, /不在收藏范围内/);

  // 即便被误触发也不得发请求（闭集在本地拦住，服务端 schema 只作第二道）。
  const before = f.requests.length;
  f.page.toggleFavorite();
  assert.equal(f.requests.length, before);
  assert.equal(f.page.data.favState, 'unsupported');
});

test('详情页收藏（切片A，验收3）：未登录时页面侧门禁拦住，不发任何收藏请求（接口侧 401 见 favorites-http）', async () => {
  const f = detailFixture();
  f.page.onLoad({ id: TARGET });
  f.page.onShow();
  await flush();
  assert.equal(f.page.data.gatePassed, false);
  assert.equal(f.page.data.item, null);
  assert.equal(f.page.data.favState, 'idle');
  assert.equal(f.page.data.favSupported, false);
  assert.equal(f.page.data.favBusy, false);
  assert.equal(f.requests.length, 0, '未经服务端核实的会话不得发出任何请求');
  assert.equal(favoriteRequests(f).length, 0);
});

test('详情页收藏（切片A）：回填失败如实报"未取得"，不臆断已收藏／未收藏；再点收藏由服务端去重兜底', async () => {
  const f = detailFixture();
  assert.equal(await login(f), true);
  const item = knowledgeItem();
  await openDetailPage(f, item);
  const scan = f.requests.at(-1);
  assert.match(scan.url, /\/favorites/);
  scan.success({ statusCode: 503, data: { error: { code: 'PROVIDER_UNAVAILABLE', message: '收藏持久存储尚未接线', retryable: false } } });
  await flush();
  assert.equal(f.page.data.favState, 'unknown');
  assert.equal(f.page.data.favSupported, true);
  assert.equal(f.page.data.favLabel, '收藏');
  assert.match(f.page.data.favNote, /不会用本地数据顶替/);
  assert.equal(f.page.data.favBusy, false);

  // 未知状态下点「收藏」⇒ POST；服务端 `(user,target)` 唯一索引兜底去重，回既有行。
  f.page.toggleFavorite();
  const create = f.requests.at(-1);
  assert.equal(create.method, 'POST');
  answer(f, favorite({ id: UUID_A, revision: 2, target_ref: { type: 'species', id: item.id, revision: item.revision } }), 201, { ETag: '"2"' });
  await flush();
  assert.equal(f.page.data.favState, 'favorited');
  assert.equal(f.page.data.favLabel, '取消收藏');

  // 取消失败（版本冲突）不得显示成"已取消"，也不得残留"已收藏"。
  f.page.toggleFavorite();
  const remove = f.requests.at(-1);
  assert.equal(remove.method, 'DELETE');
  remove.success({ statusCode: 409, data: { error: { code: 'REVISION_CONFLICT', message: '收藏版本已变化，请刷新后重试', retryable: false } } });
  await flush();
  assert.equal(f.page.data.favState, 'unknown');
  assert.equal(f.page.data.favLabel, '收藏');
  assert.match(f.page.data.favNote, /收藏已被更新/);
});

test('详情页收藏（切片A，验收4）：不接可见性端口 ⇒ 页面不做"可用／查看资料"断言，也不读收藏的 reference_state', () => {
  const js = readFileSync(DETAIL_PAGE, 'utf8');
  const wxml = readFileSync(root + '/miniprogram/pages/knowledgedetail/knowledgedetail.wxml', 'utf8');
  assert.equal(/reference_state|describeFavorite/.test(js), false, '详情页不得消费收藏的可见性字段');
  assert.equal(/查看资料/.test(js + wxml), false, '详情页不得展示资料跳转入口');
  assert.equal(/canOpen/.test(js), false);
  assert.match(wxml, /不代表已核对、已使用或已确认适用性/);
  assert.match(wxml, /bindtap="toggleFavorite"/);
  // 收藏卡片与既有读取状态机是**两套**独立字段。
  assert.match(js, /favSupported: false, favState: 'idle', favLabel: '收藏'/);
});

test('详情页收藏（切片A，F1）：在途 401（会话失效：favorites-api 先 clearSession 再 reject）必须复位 favBusy 并按既有错误映射说明', async () => {
  // 复现审查 F1 的机理：401/403 时 `favorites-api` **先** `auth.clearSession()`（世代 +1）再
  // reject `SESSION_REQUIRED` ⇒ 页面 `favAlive()` 在 catch 里必为假。修复前两条 catch 在此
  // 直接 return，`favBusy` 永久为 true（WXML 按钮 `disabled="{{favBusy}}"` 卡死），
  // 文案停在"正在核对收藏状态…"／"正在收藏…"（此时已无任何在途请求）。
  const wxml = readFileSync(root + '/miniprogram/pages/knowledgedetail/knowledgedetail.wxml', 'utf8');
  assert.match(wxml, /bindtap="toggleFavorite" loading="\{\{favBusy\}\}" disabled="\{\{favBusy\}\}"/, '卡死的载体就是 favBusy 绑定的 disabled');

  // 1) 回填路径：GET /favorites 在途时 401。
  const f = detailFixture();
  assert.equal(await login(f), true);
  await openDetailPage(f, knowledgeItem());
  assert.equal(f.page.data.favState, 'loading');
  assert.equal(f.page.data.favBusy, true, '回填已进入在途');

  const scan = f.requests.at(-1);
  scan.success({ statusCode: 401, data: { error: { code: 'SESSION_REQUIRED', message: '需要登录', retryable: false } } });
  await flush();
  assert.equal(f.auth.isLoggedIn(), false, '401 由消费层先清会话（世代 +1）再 reject');
  assert.equal(f.page.data.favBusy, false, '在途 401 后 favBusy 必须复位（否则按钮永久 disabled）');
  assert.notEqual(f.page.data.favState, 'loading', '不得停在"正在核对收藏状态…"的在途态');
  assert.equal(f.page.data.favState, 'unknown', '不臆断已收藏／未收藏');
  assert.equal(f.page.data.favLabel, '收藏');
  assert.equal(f.page.data.favSupported, true, '入口仍在，用户可由既有「重新核对／重试」恢复');
  assert.equal(f.page.data.favNote, f.favorites.messageFor({ code: 'SESSION_REQUIRED' }), '文案取既有错误映射（与收藏页同口径）');
  assert.match(f.page.data.favNote, /登录状态已失效/);
  assert.equal(/正在核对收藏状态|正在收藏/.test(f.page.data.favNote), false);

  // 2) 收藏（POST）路径：同一 401 也必须在 setData 复位之后才返回。
  const g = detailFixture();
  assert.equal(await login(g), true);
  await openDetailPage(g, knowledgeItem());
  answer(g, { items: [], next_cursor: null });
  await flush();
  assert.equal(g.page.data.favState, 'none');

  g.page.toggleFavorite();
  const create = g.requests.at(-1);
  assert.equal(create.method, 'POST');
  assert.equal(g.page.data.favBusy, true, '收藏已进入在途');
  assert.equal(g.page.data.favNote, '正在收藏…');

  create.success({ statusCode: 401, data: { error: { code: 'SESSION_REQUIRED', message: '需要登录', retryable: false } } });
  await flush();
  assert.equal(g.auth.isLoggedIn(), false);
  assert.equal(g.page.data.favBusy, false, '在途 401 后 favBusy 必须复位（否则按钮永久 disabled）');
  assert.equal(g.page.data.favState, 'unknown', '不臆断已收藏／未收藏');
  assert.equal(g.page.data.favLabel, '收藏');
  assert.equal(g.page.data.favNote, g.favorites.messageFor({ code: 'SESSION_REQUIRED' }));
  assert.equal(/正在收藏…/.test(g.page.data.favNote), false, '不得留"正在收藏…"（此时无在途请求）');
});

// ================= C5（#16 端到端接线）：401 与 403 必须分开 =========================
//
// 服务端可达的 403 有两个真实来源：
//   * `services/api/src/favorites/validate.ts:65` / `services/api/src/history/validate.ts:68`
//     （后台会话不得代替用户读写收藏/历史 ⇒ SCOPE_DENIED）；
//   * `services/api/src/auth/middleware.ts:89`/`:93`（账号停用、auth_epoch 不符 ⇒ ACCOUNT_INACTIVE）。
// 修复前两个消费层把 401 与 403 一起折叠成 `SESSION_REQUIRED` 并 `auth.clearSession()`：
// 用户被静默登出、页面把"没有权限"说成"请重新登录"，且 `utils/states.js` 的 denied 永远不出现
// （`messageFor` 里已写好的 SCOPE_DENIED 文案因此不可达）。

const FAVORITES_PAGE = root + '/miniprogram/pages/favorites/favorites.js';
const HISTORY_PAGE = root + '/miniprogram/pages/history/history.js';
const HISTORY_DETAIL_PAGE = root + '/miniprogram/pages/historydetail/historydetail.js';

function forbiddenPayload(code) {
  return { error: { code, message: 'synthetic', retryable: false } };
}

/** 页面 onShow 内的门禁核实（`GET /auth/session`）在函数内作答。 */
async function passGate(f, call) {
  call();
  f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1)
    .success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } });
  await flush();
}

test('收藏/历史消费层：403 契约码原样带出；SCOPE_DENIED/CONSENT_REQUIRED 不清会话，ACCOUNT_INACTIVE 清会话；401 仍清会话', async () => {
  const f = fixture();
  assert.equal(await login(f), true);

  const denied = assert.rejects(f.favorites.listFavorites(''), (e) => {
    assert.equal(e.code, 'SCOPE_DENIED');
    assert.equal(e.status, 403);
    assert.equal(e.retryable, false);
    assert.match(f.favorites.messageFor(e), /无权/, '403 有自己的人话，不落到"请重新登录"');
    return true;
  });
  f.requests.at(-1).success({ statusCode: 403, data: forbiddenPayload('SCOPE_DENIED') });
  await denied;
  assert.equal(f.auth.isLoggedIn(), true, '403 SCOPE_DENIED 不清会话：会话本身有效，只是没有权限');

  assert.match(f.favorites.messageFor({ code: 'ACCOUNT_INACTIVE' }), /账号当前不可用/);
  assert.match(f.favorites.messageFor({ code: 'CONSENT_REQUIRED' }), /授权同意/);

  // 历史层同一口径（两个消费层不各造一套语义）。
  const consent = assert.rejects(f.history.listHistory(''), (e) => e.code === 'CONSENT_REQUIRED');
  f.requests.at(-1).success({ statusCode: 403, data: forbiddenPayload('CONSENT_REQUIRED') });
  await consent;
  assert.equal(f.auth.isLoggedIn(), true, '403 CONSENT_REQUIRED 不清会话（用户只是没授权）');
  assert.match(f.history.messageFor({ code: 'ACCOUNT_INACTIVE' }), /账号当前不可用/);

  // 账号停用/注销（同一 403 集合，但令牌**永久**不可再用）：码如实保留，会话清掉。
  // 口径见 docs/verification/gy-i04-login-chain-20261021.md「口径决定」第 3 条。
  const retired = fixture();
  assert.equal(await login(retired), true);
  const inactive = assert.rejects(retired.favorites.listFavorites(''), (e) => e.code === 'ACCOUNT_INACTIVE' && e.status === 403);
  retired.requests.at(-1).success({ statusCode: 403, data: forbiddenPayload('ACCOUNT_INACTIVE') });
  await inactive;
  assert.equal(retired.auth.isLoggedIn(), false, 'ACCOUNT_INACTIVE ⇒ 令牌永久失效，必须清会话（下一次进页面走重新登录）');

  // 反例：401 仍然是"会话失效" ⇒ 清会话 + 契约会话码（既有语义不变）。
  const g = fixture();
  assert.equal(await login(g), true);
  const expired = assert.rejects(g.favorites.listFavorites(''), (e) => e.code === 'SESSION_REQUIRED' && e.status === 401);
  g.requests.at(-1).success({ statusCode: 401, data: forbiddenPayload('SESSION_EXPIRED') });
  await expired;
  assert.equal(g.auth.isLoggedIn(), false, '401 仍按会话失效处理');
});

test('收藏/历史消费层：403 无错误体、或码不在契约 403 闭集内 ⇒ 归 SCOPE_DENIED 且**不清**会话（不假装登录问题）', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  const bodyless = assert.rejects(f.favorites.listFavorites(''), (e) => e.code === 'SCOPE_DENIED' && e.status === 403);
  f.requests.at(-1).success({ statusCode: 403, data: 'forbidden' });
  await bodyless;
  assert.equal(f.auth.isLoggedIn(), true, '没有可核对的错误码时，状态码 403 已说清"这是拒绝"，不得销毁有效会话');

  const g = fixture();
  assert.equal(await login(g), true);
  const unknown = assert.rejects(g.history.listHistory(''), (e) => e.code === 'SCOPE_DENIED' && e.status === 403);
  g.requests.at(-1).success({ statusCode: 403, data: forbiddenPayload('NOT_A_CONTRACT_403_CODE') });
  await unknown;
  assert.equal(g.auth.isLoggedIn(), true, '契约 403 闭集之外的码归"无权"，不归"未登录"');
  assert.match(g.history.messageFor({ code: 'SCOPE_DENIED' }), /无权/);
});

test('收藏页：服务端 403 时交给统一状态组件呈现 denied，不折叠成空列表，也不清会话', async () => {
  const f = fixture({ route: 'pages/favorites/favorites' });
  f.load(FAVORITES_PAGE);
  const states = f.load(root + '/miniprogram/utils/states.js');
  assert.equal(await login(f), true);

  await passGate(f, () => f.page.onShow());

  const list = f.requests.filter((r) => r.url.includes('/favorites')).at(-1);
  list.success({ statusCode: 403, data: forbiddenPayload('SCOPE_DENIED') });
  await flush();

  assert.equal(f.page.data.errorCode, 'SCOPE_DENIED', '错误码必须带给状态组件');
  assert.equal(f.page.data.errorText, f.favorites.messageFor({ code: 'SCOPE_DENIED' }));
  assert.equal(f.page.data.items.length, 0);
  assert.equal(f.page.data.busy, false);
  assert.equal(f.page.data.loading, false);
  assert.equal(f.page.data.message, '', '失败不得被说成"尚无收藏。"（失败不折叠成空列表成功）');
  assert.equal(f.auth.isLoggedIn(), true, '403 不清会话');

  // 401 与 403 在状态层是两档：guest vs denied（折叠就分不出来了）。
  assert.equal(states.statusForCode('SCOPE_DENIED'), states.STATUS.DENIED);
  assert.equal(states.statusForCode('SESSION_REQUIRED'), states.STATUS.GUEST);

  // WXML 必须把错误码真的交给状态组件，否则 denied 永远不会渲染。
  const wxml = readFileSync(root + '/miniprogram/pages/favorites/favorites.wxml', 'utf8');
  assert.match(wxml, /<state-view[\s\S]{0,200}errorCode="\{\{errorCode\}\}"[\s\S]{0,200}title="收藏读取失败"/);
});

test('历史页：服务端 403 ACCOUNT_INACTIVE 时仍呈现 denied 文案，但会话已清（令牌永久失效）', async () => {
  const f = fixture({ route: 'pages/history/history' });
  f.load(HISTORY_PAGE);
  const states = f.load(root + '/miniprogram/utils/states.js');
  assert.equal(await login(f), true);

  await passGate(f, () => f.page.onShow());

  const list = f.requests.filter((r) => r.url.includes('/history')).at(-1);
  list.success({ statusCode: 403, data: forbiddenPayload('ACCOUNT_INACTIVE') });
  await flush();

  assert.equal(f.page.data.errorCode, 'ACCOUNT_INACTIVE', '错误码必须如实带给状态组件');
  assert.equal(f.page.data.errorText, f.history.messageFor({ code: 'ACCOUNT_INACTIVE' }));
  assert.equal(f.page.data.items.length, 0);
  assert.equal(f.page.data.failedCount, 0);
  assert.equal(f.page.data.message, '', '失败不得被说成"还没有识别记录。"');
  // ACCOUNT_INACTIVE 的口径（docs/verification/gy-i04-login-chain-20261021.md「口径决定」第 3 条）：
  // 码如实保留并按 denied 呈现，但令牌**永久**不可用 ⇒ 清会话，下一次进页面走重新登录。
  assert.equal(f.auth.isLoggedIn(), false, '账号已停用/注销 ⇒ 会话必须清掉，不留死令牌');
  assert.equal(states.statusForCode('ACCOUNT_INACTIVE'), states.STATUS.DENIED);

  const wxml = readFileSync(root + '/miniprogram/pages/history/history.wxml', 'utf8');
  assert.match(wxml, /<state-view[\s\S]{0,200}errorCode="\{\{errorCode\}\}"[\s\S]{0,200}title="历史读取失败"/);
});

/** 打开历史详情页到"实时定位请求已发出"这一步（详情内容读取留给用例作答或留在在途）。 */
async function openHistoryDetail(f, id) {
  f.page.onLoad({ id });
  await passGate(f, () => f.page.onShow());
  return f.requests.filter((r) => r.url.includes('/history?')).at(-1);
}

test('历史详情：记录已删除/不存在（实时列表未命中）呈现 invalid，不用链接或快照顶替内容', async () => {
  const f = fixture({ route: 'pages/historydetail/historydetail' });
  f.load(HISTORY_DETAIL_PAGE);
  assert.equal(await login(f), true);
  await openHistoryDetail(f, UUID_B);
  answer(f, { items: [], next_cursor: null });
  await flush();

  assert.equal(f.page.data.invalid, true);
  assert.match(f.page.data.invalidReason, /不存在|已删除|不属于当前账号/);
  assert.equal(f.page.data.canDelete, false, '定位不到就不给删除入口（不猜 revision）');
  assert.equal(f.page.data.errorText, '', '这是"记录不可用"，不是"读取失败"');
});

test('历史详情：读取被 403 拒绝时呈现 denied（不是 invalid），不清会话，也不再自写状态块', async () => {
  const f = fixture({ route: 'pages/historydetail/historydetail' });
  f.load(HISTORY_DETAIL_PAGE);
  const states = f.load(root + '/miniprogram/utils/states.js');
  assert.equal(await login(f), true);
  const list = await openHistoryDetail(f, UUID_B);
  list.success({ statusCode: 403, data: forbiddenPayload('SCOPE_DENIED') });
  await flush();

  assert.equal(f.page.data.errorCode, 'SCOPE_DENIED');
  assert.equal(f.page.data.errorText, f.history.messageFor({ code: 'SCOPE_DENIED' }));
  assert.equal(f.page.data.invalid, false, '403 不等于"记录不存在"');
  assert.equal(f.auth.isLoggedIn(), true, '403 不清会话');
  assert.equal(states.statusForCode('SCOPE_DENIED'), states.STATUS.DENIED);

  const wxml = readFileSync(root + '/miniprogram/pages/historydetail/historydetail.wxml', 'utf8');
  assert.match(wxml, /errorCode="\{\{errorCode\}\}"/);
  assert.equal(/notice notice--warn" wx:if="\{\{errorText\}\}"/.test(wxml), false, '读失败改由统一状态组件呈现');
});

test('历史详情：删除时服务端 404（已删除/他人记录同形）⇒ 按"记录不可用"收口，不猜结果', async () => {
  const f = fixture({ route: 'pages/historydetail/historydetail' });
  f.load(HISTORY_DETAIL_PAGE);
  assert.equal(await login(f), true);
  await openHistoryDetail(f, UUID_B);
  answer(f, { items: [historyItem({ kind: 'ocr', target_ref: { type: 'ocr', id: TARGET, revision: 2 } })], next_cursor: null });
  await flush();
  answer(f, ocr());
  await flush();
  assert.equal(f.page.data.locatedBy, 'live');
  assert.equal(f.page.data.historyRevision, 1, '删除用的是实时读到的 revision');
  assert.equal(f.page.data.canDelete, true);

  f.page.onDelete();
  const del = f.requests.filter((r) => r.method === 'DELETE').at(-1);
  assert.equal(del.url.endsWith('/history/' + UUID_B), true);
  assert.equal(del.header['If-Match'], '"1"');
  del.success({ statusCode: 404, data: forbiddenPayload('NOT_FOUND') });
  await flush();

  assert.equal(f.page.data.invalid, true, '服务端说没有 ⇒ 页面按"记录不可用"收口');
  assert.match(f.page.data.invalidReason, /不存在|已删除|不属于当前账号/);
  assert.equal(f.page.data.canDelete, false);
});

test('历史删除客户端：契约 202 才算成功（200|202 白名单），201 仍然失败、404 仍走错误分支', async () => {
  const f = fixture();
  assert.equal(await login(f), true);

  // ① 契约路径：`DELETE /history/{id}` 只声明 202 ⇒ 必须判成功，并如实回传 `X-GY-Cascade` 披露。
  const accepted = f.history.deleteHistory(UUID_B, 1);
  const del = answer(f, { accepted: true }, 202, { 'X-GY-Cascade': 'unwired' });
  assert.equal(del.method, 'DELETE');
  assert.equal(del.header['If-Match'], '"1"');
  assert.deepEqual(JSON.parse(JSON.stringify(await accepted)), { accepted: true, mode: 'stub', cascade: 'unwired' });

  // ② 200 仍接受：服务端尚未升级时，客户端不得把成功当失败（口径是逐操作白名单 200|202）。
  const legacy = f.history.deleteHistory(UUID_B, 1);
  answer(f, { accepted: true });
  assert.deepEqual(JSON.parse(JSON.stringify(await legacy)), { accepted: true, mode: 'stub', cascade: null });

  // ③ 201 **仍然失败**：白名单若被换成「只要不是 200 也算」，这一条会静默通过。
  const wrong = f.history.deleteHistory(UUID_B, 1);
  answer(f, { accepted: true }, 201);
  await assert.rejects(() => wrong, (e) => e.code === 'UNAVAILABLE');

  // ④ 404 仍走错误分支，不被白名单吞成成功。
  const missing = f.history.deleteHistory(UUID_B, 1);
  answer(f, forbiddenPayload('NOT_FOUND'), 404);
  await assert.rejects(() => missing, (e) => e.code === 'NOT_FOUND');
});
