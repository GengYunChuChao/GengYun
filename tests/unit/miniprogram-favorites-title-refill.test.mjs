// 收藏页标题回填：`onShow` 里 loadFavorites 与 loadTargets 并行，谁先到都可能。
//
// 复现的缺口（改前实读）：
//   · 服务端 `GET /favorites` 只回 `target_ref`（type/id），**没有 title**；资料名只能由页面
//     用已加载的 targets 回填（`titleFor`）。
//   · 收藏响应先到时 `this.data.targets` 还是空的 ⇒ `items[].title` 落兜底
//     `targetTypeLabel(type) + ' · ' + id 前 8 位`（「杂草 · d0000000」）。
//   · targets 后到只走 `reconcileTargets` 打「已收藏」标记，**不回填已渲染的 title** ⇒ 重新进入
//     收藏页后标题永远停在兜底，等 5 秒也不会自愈（只有当轮收藏时同页卡片标题是对的）。
//
// 本文件只证明页面数据层（合成 wx／可控响应、显式控制两个响应的先后；**不是**真机或开发者
// 工具证据）。它同时钉住「回填只改 title」：条数/游标/其余字段保持不变，且回填不发起任何新请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const PAGE = root + '/miniprogram/pages/favorites/favorites.js';
const UUID_A = '00000000-0000-4000-8a00-000000000001';
const UUID_B = '00000000-0000-4000-8b00-000000000002';
const TARGET = '11111111-1111-4111-8111-111111111111';
const TARGET_B = '11111111-1111-4111-8111-111111111112';
const other = '11111111-1111-4111-8111-111111111199';
const future = () => new Date(Date.now() + 3600_000).toISOString();
const flush = () => new Promise((r) => setImmediate(r));

function fixture() {
  const requests = [];
  const storage = new Map();
  const sets = [];
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
    route: 'pages/favorites/favorites',
    options: {},
    data: {},
    setData(p) { sets.push(p); Object.assign(this.data, p); }
  };
  const cache = new Map();
  function load(path) {
    path = resolve(path);
    if (path.endsWith('runtime.js')) return { mode: 'local', apiBaseUrl: 'http://127.0.0.1:1234/api/v1' };
    if (cache.has(path)) return cache.get(path).exports;
    const m = { exports: {} };
    cache.set(path, m);
    vm.runInNewContext(
      '(function(require,module){' + readFileSync(path, 'utf8') + '\n})',
      { wx, getCurrentPages: () => [page], Page: (d) => { page.data = d.data; Object.assign(page, d); } }
    )((id) => load(resolve(dirname(path), id + '.js')), m);
    return m.exports;
  }
  const auth = load(root + '/miniprogram/utils/auth.js');
  const favorites = load(root + '/miniprogram/utils/favorites-api.js');
  load(PAGE);
  return { wx, requests, page, sets, auth, favorites };
}

/** 让会话通过**服务端核实**（`isLoggedIn()` 才可能为真）。 */
function login(f) {
  f.auth.setSession({ accessToken: 'synthetic-favtitle-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
  let verified = null;
  f.auth.requireLogin((ok) => { verified = ok; });
  const request = f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1);
  request.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } });
  return flush().then(() => verified);
}

const meta = () => ({ request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' });
function answer(request, payload, statusCode = 200) {
  const ok = statusCode >= 200 && statusCode < 300;
  request.success({ statusCode, data: ok ? { data: payload, meta: meta() } : payload, header: {} });
  return request;
}

const favoriteGets = (f) => f.requests.filter((r) => r.method === 'GET' && r.url.includes('/favorites'));
const targetGets = (f) => f.requests.filter((r) => r.method === 'GET' && r.url.includes('/knowledge'));

function favorite(overrides = {}) {
  return Object.assign({
    id: UUID_A, revision: 1, target_ref: { type: 'species', id: TARGET, revision: 3 },
    reference_state: 'available', unavailable_reason: null, created_at: '2026-10-14T06:00:00.000Z'
  }, overrides);
}

/** knowledge-api 的闭集 Knowledge：键必须与真实封套一致（多一个/少一个都 INVALID_RESPONSE）。 */
function knowledgeItem(overrides = {}) {
  return Object.assign({
    id: TARGET,
    revision: 7,
    type: 'species',
    title: '藜',
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

/** 进入收藏页并通过门禁：门禁核实之后两次读取都已发出，但都还没回包（由调用方决定先后）。 */
async function openPage(f) {
  f.page.onShow();
  f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1)
    .success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() } } });
  await flush();
  const list = favoriteGets(f).at(-1);
  const targets = targetGets(f).at(-1);
  assert.ok(list && targets, '进入页面应同时发起收藏与资料读取（这两个请求并行正是本缺陷的成因）');
  return { list, targets };
}

/** 兜底标题原文（改前/改后都必须能一字不差地认出来）。 */
const fallbackTitle = (type, id) => '杂草' + ' · ' + String(id).slice(0, 8);

test('回归：收藏先到、targets 后到 ⇒ 已渲染的 items[].title 必须从兜底改写成资料名', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  const { list, targets } = await openPage(f);

  // 收藏响应先到：targets 还是空的。
  answer(list, { items: [favorite()], next_cursor: 'opaque.favorites.1' });
  await flush();
  assert.equal(f.page.data.items.length, 1);
  assert.equal(f.page.data.items[0].title, fallbackTitle('species', TARGET), '改前现场：收藏先到时只能落「杂草 · 短id」兜底');
  assert.equal(f.page.data.targets.length, 0, '此刻 targets 还没回来');
  const presented = Object.assign({}, f.page.data.items[0]);

  // targets 后到：必须回填已渲染的 title（这正是改前缺失的一步）。
  answer(targets, { items: [knowledgeItem()], next_cursor: null });
  await flush();
  assert.equal(f.page.data.items[0].title, '藜', 'targets 到达后必须补写已渲染的 title，不能等多久都停在兜底');
  assert.equal(f.page.data.items[0].title, f.page.data.targets[0].title, '收藏项标题与资料列表里的标题必须一致');

  // 只改 title，不动分页/条数与其它字段（避免回填把翻页状态冲掉）。
  assert.equal(f.page.data.items.length, 1);
  assert.equal(f.page.data.total, 1);
  assert.equal(f.page.data.nextCursor, 'opaque.favorites.1', '回填不得丢收藏列表的续页游标');
  assert.equal(f.page.data.items[0].id, UUID_A);
  assert.equal(f.page.data.items[0].revision, 1);
  assert.equal(f.page.data.items[0].canOpen, true);
  assert.equal(f.page.data.items[0].createdAt, presented.createdAt, '除 title 外的字段必须原样保留');
  assert.equal(f.page.data.items[0].typeLabel, presented.typeLabel);
  assert.equal(f.page.data.items[0].available, presented.available);

  // 回填是纯客户端改写：不得靠再读一次列表/资料来自愈（否则会打转）。
  assert.equal(favoriteGets(f).length, 1, '回填不得触发收藏列表重读');
  assert.equal(targetGets(f).length, 1, '回填不得触发资料列表重读');
});

test('targets 先到、收藏后到：首帧即资料名（原顺序不能被回填改坏）', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  const { list, targets } = await openPage(f);

  answer(targets, { items: [knowledgeItem()], next_cursor: null });
  await flush();
  answer(list, { items: [favorite()], next_cursor: null });
  await flush();
  assert.equal(f.page.data.items[0].title, '藜', 'targets 先到时 presentFavorite 就该回填成资料名');
  assert.equal(f.page.data.targets[0].favorited, true, '「已收藏」标记照旧回填');
});

test('targets 第二页晚到：续页里的资料名同样补写（不只第一页）', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  const { list, targets } = await openPage(f);

  answer(list, { items: [favorite(), favorite({ id: UUID_B, target_ref: { type: 'species', id: TARGET_B, revision: 2 } })], next_cursor: null });
  await flush();
  assert.equal(f.page.data.items[1].title, fallbackTitle('species', TARGET_B));

  answer(targets, { items: [knowledgeItem()], next_cursor: 'opaque.targets.2' });
  await flush();
  assert.equal(f.page.data.items[0].title, '藜');
  assert.equal(f.page.data.items[1].title, fallbackTitle('species', TARGET_B), '第一页没有这份资料，标题仍应老实兜底');

  f.page.onMoreTargets();
  answer(targetGets(f).at(-1), { items: [knowledgeItem({ id: TARGET_B, title: '小藜' })], next_cursor: null });
  await flush();
  assert.equal(f.page.data.items[1].title, '小藜', '续页 targets 到达后同样要补写已渲染的标题');
  assert.equal(f.page.data.items[0].title, '藜', '已回填的标题不得被续页冲掉');
  assert.equal(f.page.data.items.length, 2, '续页只影响标题，不重建收藏列表');
});

test('targets 里确实没有这份资料：保持「杂草 · 短id」兜底，不伪造资料名', async () => {
  const f = fixture();
  assert.equal(await login(f), true);
  const { list, targets } = await openPage(f);

  answer(list, { items: [favorite()], next_cursor: null });
  await flush();
  answer(targets, { items: [knowledgeItem({ id: other, title: '另一份资料' })], next_cursor: null });
  await flush();
  assert.equal(f.page.data.items[0].title, fallbackTitle('species', TARGET), '查不到名字就必须如实兜底，绝不拿别的资料名顶上');
  assert.equal(f.page.data.items[0].title.includes('另一份资料'), false);

  const source = readFileSync(PAGE, 'utf8');
  assert.match(source, /return favoritesApi\.targetTypeLabel\(type\) \+ ' · ' \+ String\(id\)\.slice\(0, 8\)/, '兜底文案保持「类型 · 短id」形态，不得改成看起来像真名的字符串');
});
