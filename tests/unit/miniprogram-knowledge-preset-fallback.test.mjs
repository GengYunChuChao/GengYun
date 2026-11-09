// 页面级（**不需要数据库、不需要网络**）：科普页「档案预置筛选命空 ⇒ 按全部范围再查一次」这条路径。
//
// 为什么需要这一片：页面会拿「我的档案」把作物／地区**自动预置**成筛选（`applyProfile`），而演示种子的
// 8 条科普资料 `conditions` 全是 `null` —— 任何 crop_id／region_code 过滤都命中 0，于是首屏必然落空态
// 「没有符合条件的资料，请调整条件继续查询。」，演示到此为止（已实测，不是推测）。
// 修法只动**预置**这一条路：预置筛选命空时自动去掉预置的作物／地区重查一次，并在页面上如实说明
// 「演示资料未标注适用作物与地区，已按全部范围显示。」；**用户手选过的筛选绝不回退**（否则等于筛选失灵）。
//
// 本文件用**注入的假 `wx.request`**（只入队、由用例显式回放 success）驱动**真页面脚本 + 真客户端**，
// 逐条钉住判定边界，⛔ 不改任何产品代码：
//   (a) 预置筛选命中 0 ⇒ 触发回退（查询串里不再有 crop_id／region_code）且最终有数据、页面有说明；
//   (b) 用户手选命中 0 ⇒ **不回退**（不再发第二次请求）、保持既有空态文案；
//   (c) 预置筛选本来就有数据 ⇒ 不回退（只有一次请求、没有说明行）；
//   (d) 回退后仍为空 ⇒ 保持既有空态文案、不加说明（不许把"真的没有"说成"已按全部范围显示"）；
//   (e) 预置筛选 + 用户另填了未采集维度 ⇒ 不回退，落既有的 `uncollected` 态（说明原因是维度未采集）。
//
// 夹具与 `tests/unit/miniprogram-network-failure-clears.test.mjs` 同形（同一套真脚本＋假 wx 手法），
// 只是这里关心「发了几个请求、请求里带了什么」，而不是失败后清空。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const SOURCE = '33333333-3333-4333-8333-333333333333';
const META = { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' };
const future = () => new Date(Date.now() + 3600_000).toISOString();
const flush = () => new Promise((r) => setImmediate(r));
/** 一次 setData 链可能跨多个微任务；settle 给足，避免断言抢在回调之前。 */
async function settle() { await flush(); await flush(); await flush(); }

// ---------------------------------------------------------------------------
// 夹具：真页面脚本 + 真客户端，HTTP 只入队（不联网、不起库、不连 PG）
// ---------------------------------------------------------------------------
function fixture(route) {
  const requests = [];
  const routes = [];
  const storage = new Map();
  const cache = new Map();
  let page = null;
  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    request: (o) => requests.push(o),
    navigateTo: (o) => { routes.push(o.url); if (o.success) o.success() },
    redirectTo: (o) => { routes.push(o.url) },
    reLaunch: (o) => { routes.push(o.url); if (o.success) o.success() },
    switchTab: () => {},
    navigateBack: () => {},
    showToast: () => {},
    showModal: () => {}
  };
  function load(file) {
    file = resolve(file);
    if (!file.endsWith('.js')) file += '.js';
    if (cache.has(file)) return cache.get(file).exports;
    // 共享源码的 runtime 默认是「联网关闭」；本夹具按本地准备态注入可用基址（与仓内既有页面夹具同形）。
    if (file.endsWith('runtime.js')) {
      const stub = { exports: { mode: 'local', apiBaseUrl: 'http://127.0.0.1:1234/api/v1' } };
      cache.set(file, stub);
      return stub.exports;
    }
    const module = { exports: {} };
    cache.set(file, module);
    const sandbox = {
      wx,
      module,
      getApp: () => ({ globalData: { fontScale: 1 } }),
      getCurrentPages: () => (page === null ? [] : [page]),
      Page: (definition) => {
        page = Object.assign({}, definition, {
          route,
          options: {},
          data: JSON.parse(JSON.stringify(definition.data === undefined ? {} : definition.data)),
          setData(patch) { Object.assign(this.data, patch) }
        });
      }
    };
    vm.runInNewContext(
      `(function(require,module){${readFileSync(file, 'utf8')}\n})`,
      sandbox,
      { filename: file }
    )((id) => load(resolve(dirname(file), id)), module);
    return module.exports;
  }
  const handle = {
    requests,
    routes,
    load,
    auth: load(root + '/miniprogram/utils/auth.js'),
    /** 队列里**最后一条** URL 含 `fragment` 的请求（回放式应答的取件口）。 */
    last(fragment) {
      return requests.filter((r) => String(r.url).includes(fragment)).at(-1);
    },
    /** 成功回放：`{data, meta}` 封套。 */
    ok(request, payload) {
      assert.ok(request, '期望有一条在途请求可以回放，实际没有（夹具失配必须显式失败）');
      request.success({ statusCode: 200, data: { data: payload, meta: META } });
    }
  };
  Object.defineProperty(handle, 'page', { get: () => page });
  return handle;
}

/** 知识页夹具：已登录（合成会话，不联网）。 */
function knowledgeFixture() {
  const f = fixture('pages/knowledge/knowledge');
  f.auth.setSession({ accessToken: 'synthetic-preset-fallback-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
  f.load(root + '/miniprogram/pages/knowledge/knowledge.js');
  return f;
}

/** 全部 `/knowledge` 列表请求，按发出顺序（回退判定看的是"第几次"). */
function listCalls(f) {
  return f.requests.filter((r) => String(r.url).includes('/knowledge?'))
}

/** 过登录门并把「水稻 · 西湖区」档案喂给页面：页面据此预置 作物=水稻、地区=浙江省 330000 并自动首查。 */
async function openWithProfile(f, profile = PROFILE) {
  f.page.onShow();
  f.ok(f.last('/auth/session'), { audience: 'user', expires_at: future() });
  await settle();
  assert.equal(f.page.data.gatePassed, true, '登录门必须通过（否则后面根本不会查）');
  f.ok(f.last('/me/profile'), profile);
  await settle();
}

/** 合法档案：`validProfile` 要求作物与地区同时设置、地区在浙江省口径内。 */
const PROFILE = { crop_id: 'crop_rice', region_code: '330106', region_catalog_version: 'mca-xzqh-2023', revision: 2 };
const PRESET_NOTE = '来自我的档案：水稻 · 西湖区；当前资料只登记到省级，已按浙江省查询。';
const FALLBACK_NOTE = '演示资料未标注适用作物与地区，已按全部范围显示。';
const EMPTY_STATUS = '没有符合条件的资料，请调整条件继续查询。';

/** `GET /knowledge` 的行投影：逐字段满足客户端 `validItem`（演示种子的真实形状：conditions 全为 null）。 */
function knowledgeItem(id, title) {
  return {
    id,
    revision: 3,
    type: 'species',
    title,
    body: title + '的示范正文',
    source: {
      id: SOURCE,
      version: 'v1.0.0',
      title: '示范来源',
      url: 'https://example.org/knowledge/demo-fallback',
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
  };
}

/** 演示库那 8 条（名字取自实测返回），conditions 全为 null。 */
const DEMO_TITLES = ['稗', '狗尾草', '荨麻属', '马唐属', '牛筋草', '看麦娘', '藜', '空心莲子草'];
const DEMO_ROWS = DEMO_TITLES.map((name, i) => knowledgeItem('11111111-1111-4111-8111-11111111110' + (i + 1), name));

// ===========================================================================
// (a) 预置筛选命中 0 ⇒ 触发回退，最终有数据、页面如实说明
// ===========================================================================
test('科普页：预置筛选命中 0 ⇒ 去掉预置的作物／地区再查一次，首屏出 8 条并如实说明', async () => {
  const f = knowledgeFixture();
  await openWithProfile(f);

  // 档案确实被预置成页面筛选（作物=水稻 1、地区=浙江省 1，首位都是"全部"）。
  assert.equal(f.page.data.profileState, 'applied');
  assert.equal(f.page.data.cropIndex, 1, '水稻在随包目录里是 1 号（0 号是"全部作物"）');
  assert.equal(f.page.data.regionIndex, 1, '浙江省在随包目录里是 1 号（0 号是"全部地区"）');
  assert.equal(f.page.data.profileNote, PRESET_NOTE);

  assert.equal(listCalls(f).length, 1, '档案预置后自动发起第一次查询');
  const first = listCalls(f)[0];
  assert.ok(String(first.url).includes('crop_id=crop_rice'), '第一次查询必须带上预置的作物');
  assert.ok(String(first.url).includes('region_code=330000'), '第一次查询必须带上预置的省级地区');

  // 演示种子 conditions 全 null ⇒ 预置筛选命中 0。
  f.ok(first, { items: [], next_cursor: null });
  await settle();

  assert.equal(listCalls(f).length, 2, '预置筛选命空后必须**再查一次**（这正是本片要钉的修法）');
  const fallback = listCalls(f)[1];
  assert.equal(String(fallback.url).includes('crop_id'), false, '回退查询不得再带作物');
  assert.equal(String(fallback.url).includes('region_code'), false, '回退查询不得再带地区');
  assert.ok(String(fallback.url).includes('limit=20'), '回退查询保留分页参数');
  assert.equal(f.page.data.stateKind, 'loading', '回退查询在途时不得先闪一下空态');

  f.ok(fallback, { items: DEMO_ROWS, next_cursor: null });
  await settle();

  assert.equal(f.page.data.stateKind, 'ready');
  assert.equal(f.page.data.items.length, 8, '回退后首屏直接出演示库那 8 条');
  assert.equal(f.page.data.cropIndex, 0, '回退后作物下拉要如实显示"全部作物"');
  assert.equal(f.page.data.regionIndex, 0, '回退后地区下拉要如实显示"全部地区"');
  assert.equal(f.page.data.profileNote, '', '"来自我的档案"这行不能再描述当前条件');
  assert.equal(f.page.data.fallbackNote, FALLBACK_NOTE, '页面必须如实说明为什么按全部范围显示');
  assert.equal(f.page.data.status, '已读取当前页资料；详情会重新核对来源。');
});

// ===========================================================================
// (b) 用户手选筛选命中 0 ⇒ 不回退、保持既有空态（筛选没失灵）
// ===========================================================================
test('科普页：用户手选筛选命中 0 ⇒ 不回退（不再发第二次请求）并保持既有空态文案', async () => {
  const f = knowledgeFixture();
  await openWithProfile(f);
  // 先让预置筛选有一次**成功**的读取：证明"只有预置且空"才回退，不是"只要空就回退"。
  f.ok(listCalls(f)[0], { items: DEMO_ROWS, next_cursor: null });
  await settle();
  assert.equal(f.page.data.stateKind, 'ready');

  // 用户手动把作物改成 2 号（不是档案预置的 1 号）。
  f.page.pick({ currentTarget: { dataset: { field: 'cropIndex' } }, detail: { value: 2 } });
  await settle();
  assert.equal(f.page.data.cropIndex, 2);
  assert.equal(f.page.data.profileNote, '', '手选改了作物后"来自我的档案"必须撤下（既有行为）');
  assert.equal(f.page.data.fallbackNote, '');

  f.page.search();
  await settle();
  assert.equal(listCalls(f).length, 2, '手选后点查询：只发一条请求');
  const picked = listCalls(f)[1];
  assert.ok(String(picked.url).includes('crop_id=' + f.page.data.crops[2].id), '查询串必须用手选的作物');

  f.ok(picked, { items: [], next_cursor: null });
  await settle();

  assert.equal(listCalls(f).length, 2, '用户手选过的筛选**不许**被回退（否则用户会觉得筛选失灵）');
  assert.equal(f.page.data.stateKind, 'empty', '手选命空落既有空态');
  assert.equal(f.page.data.status, EMPTY_STATUS, '空态文案保持原样');
  assert.equal(f.page.data.fallbackNote, '', '没回退就不得出现"已按全部范围显示"的说明');
  assert.equal(f.page.data.cropIndex, 2, '用户选的作物不得被页面改掉');
});

// ===========================================================================
// (c) 预置筛选本来就有数据 ⇒ 不回退
// ===========================================================================
test('科普页：预置筛选本来就有数据 ⇒ 不回退（只发一次请求、没有回退说明）', async () => {
  const f = knowledgeFixture();
  await openWithProfile(f);

  f.ok(listCalls(f)[0], { items: DEMO_ROWS.slice(0, 3), next_cursor: null });
  await settle();

  assert.equal(listCalls(f).length, 1, '预置筛选有数据就到此为止，不得多发一条"全部范围"的请求');
  assert.equal(f.page.data.stateKind, 'ready');
  assert.equal(f.page.data.items.length, 3);
  assert.equal(f.page.data.fallbackNote, '');
  assert.equal(f.page.data.cropIndex, 1, '预置筛选被保留（作物仍是档案里的水稻）');
  assert.equal(f.page.data.regionIndex, 1);
  assert.equal(f.page.data.profileNote, PRESET_NOTE, '"来自我的档案"仍然准确，保持显示');
});

// ===========================================================================
// (d) 回退后仍为空 ⇒ 保持既有空态文案（不加"已按全部范围显示"）
// ===========================================================================
test('科普页：回退后仍为空 ⇒ 保持既有空态文案、不加回退说明', async () => {
  const f = knowledgeFixture();
  await openWithProfile(f);

  f.ok(listCalls(f)[0], { items: [], next_cursor: null });
  await settle();
  assert.equal(listCalls(f).length, 2, '先确认回退确实发生了（否则下面的断言等于没测）');

  f.ok(listCalls(f)[1], { items: [], next_cursor: null });
  await settle();

  assert.equal(f.page.data.stateKind, 'empty');
  assert.equal(f.page.data.status, EMPTY_STATUS, '回退也查不到 ⇒ 仍是原来那句空态文案');
  assert.equal(f.page.data.fallbackNote, '', '没拿到数据就不许说"已按全部范围显示"');
  assert.equal(f.page.data.items.length, 0);
});

// ===========================================================================
// (e) 预置筛选 + 用户另填了未采集维度 ⇒ 不回退，落既有 uncollected 态
// ===========================================================================
test('科普页：预置筛选下用户另填了未采集维度 ⇒ 不回退，仍按"未采集"如实解释', async () => {
  const f = knowledgeFixture();
  await openWithProfile(f);
  f.ok(listCalls(f)[0], { items: [], next_cursor: null });
  await settle();
  // 上面那次预置命空已经触发回退：先把它回放成有数据，回到"预置筛选可用"的起点。
  f.ok(listCalls(f)[1], { items: DEMO_ROWS, next_cursor: null });
  await settle();
  assert.equal(f.page.data.stateKind, 'ready');

  f.page.input({ currentTarget: { dataset: { field: 'growth_stage' } }, detail: { value: '苗期' } });
  await settle();
  f.page.search();
  await settle();
  const calls = listCalls(f);
  assert.equal(calls.length, 3, '填了未采集维度后点查询：只发一条请求');
  assert.ok(String(calls[2].url).includes('growth_stage='), '查询串必须带上用户填的生育期');

  f.ok(calls[2], { items: [], next_cursor: null });
  await settle();

  assert.equal(listCalls(f).length, 3, '用户填了维度就不许回退（否则会把用户的输入悄悄丢掉）');
  assert.equal(f.page.data.stateKind, 'uncollected', '落既有"未采集"态，而不是泛化空态');
  assert.ok(String(f.page.data.status).includes('生育期'), '文案要点名是哪个维度没采集');
  assert.equal(f.page.data.fallbackNote, '');
});
