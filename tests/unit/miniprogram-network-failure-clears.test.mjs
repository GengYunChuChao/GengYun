// 页面级（**不需要数据库、不需要网络**）：三条页面的「请求失败 ⇒ 清掉旧内容 + 落错误态」路径。
//
// 为什么需要这一片：`tests/integration/user-chain-e2e.mjs` 只在**服务端**面钉了「来源失效」；
// 页面侧"失败就清空"的代码早就存在，却**零测试覆盖**（P0 链路侦察已如实登记）：
//   · `miniprogram/pages/knowledge/knowledge.js` 的 `read()` 进入即 `clear()`、失败分支显式
//     `items: [], nextCursor: null`；
//   · `miniprogram/pages/knowledgedetail/knowledgedetail.js` 的 `read()` 同理，失败 `item:null, labels:null`；
//   · `miniprogram/pages/favorites/favorites.js` 的 `loadFavorites()` 失败 `items: [], total: 0, nextCursor: null`。
// 本文件用**注入的假 `wx.request`**（只入队、由用例显式回放 success／fail）驱动**真页面脚本 + 真客户端**
// 跑这些失败分支，断言「旧数据一个字段都不留 + 错误态被置上」，⛔ 不改任何产品代码。
//
// 覆盖四种注入（三种失败类别）：
//   1. 网络错  —— `fail({errMsg:'request:fail'})`            ⇒ `NETWORK_UNCERTAIN`
//   2. 非 2xx  —— `success({statusCode:503, data:{error}})`  ⇒ 知识面 `UNAVAILABLE`／收藏面原样带出服务端码
//   3. 超时    —— `fail({errMsg:'request:fail timeout'})`     ⇒ `NETWORK_UNCERTAIN`
//   4. 中止    —— `fail({errMsg:'request:fail abort'})`       ⇒ `NETWORK_UNCERTAIN`
// ⚠ 如实登记（本片实测，不是设计意图）：三处 `request()` 的 `fail` 回调都**不看** `errMsg`
//   （`miniprogram/utils/knowledge-api.js`、`miniprogram/utils/favorites-api.js`、`miniprogram/utils/auth.js`
//   各自那一行 `fail: function () { reject(failure(current(b) ? 'NETWORK_UNCERTAIN' : 'SESSION_CHANGED')) }`），
//   所以「超时／中止／网络错」在客户端**折叠成同一个码**。本文件按现状把三者都钉住，不假装它们可区分。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const TARGET = '11111111-1111-4111-8111-111111111111';
const FAVORITE = '22222222-2222-4222-8222-222222222222';
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

/** 过登录门（`GET /auth/session` 由夹具直接判成功），并把「空档案」喂给知识页。 */
async function passGate(f) {
  f.page.onShow();
  f.ok(f.last('/auth/session'), { audience: 'user', expires_at: future() });
  await settle();
}

const EMPTY_PROFILE = { crop_id: null, region_code: null, region_catalog_version: null, revision: 1 };

/** `GET /knowledge` 的行投影（`Knowledge` 闭集，逐字段满足客户端的 validItem）。 */
function knowledgeItem(overrides = {}) {
  return Object.assign({
    id: TARGET,
    revision: 3,
    type: 'species',
    title: '旧资料标题（失败后必须消失）',
    body: '旧资料正文（失败后必须消失）',
    source: {
      id: SOURCE,
      version: 'v1.0.0',
      title: '示范来源',
      url: 'https://example.org/knowledge/demo-netfail',
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

/** `GET /favorites` 的行投影（`Favorite` 闭集）。 */
function favoriteRow(overrides = {}) {
  return Object.assign({
    id: FAVORITE,
    revision: 2,
    target_ref: { type: 'species', id: TARGET, revision: 3 },
    reference_state: 'available',
    unavailable_reason: null,
    created_at: '2026-10-20T06:00:00.000Z'
  }, overrides);
}

/** 四种注入。`expectCode` 由各页面在下面按自己的客户端口径给。 */
const INJECTIONS = [
  { name: '网络错', apply: (r) => r.fail({ errMsg: 'request:fail' }) },
  { name: '非 2xx（503 带错误封套）', apply: (r) => r.success({ statusCode: 503, data: { error: { code: 'PROVIDER_UNAVAILABLE', message: '能力未装配', retryable: false, details: [] }, meta: META } }) },
  { name: '超时', apply: (r) => r.fail({ errMsg: 'request:fail timeout' }) },
  { name: '中止', apply: (r) => r.fail({ errMsg: 'request:fail abort' }) }
];

/** 「旧数据一个字段都不留」的判据：整页 data 序列化后不得再出现旧标题／旧 id。 */
function assertNoResidue(data, markers, where) {
  const serialized = JSON.stringify(data);
  for (const marker of markers) {
    assert.equal(serialized.includes(marker), false, `${where}：失败后界面上不得留下上一次的成功数据（命中 ${marker}）`);
  }
}

// ===========================================================================
// ① 知识列表页：`read()` 失败 ⇒ items 清空、nextCursor 归零、stateKind=error
// ===========================================================================
function knowledgeFixture() {
  const f = fixture('pages/knowledge/knowledge');
  f.auth.setSession({ accessToken: 'synthetic-netfail-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
  f.load(root + '/miniprogram/pages/knowledge/knowledge.js');
  return f;
}

test('知识列表页：四种请求失败都清掉旧列表并落 error（不是留着旧数据、也不是"空列表"了事）', async () => {
  const f = knowledgeFixture();
  await passGate(f);
  f.ok(f.last('/me/profile'), EMPTY_PROFILE);
  await settle();

  // 先跑一次**成功**：把"旧数据"真的放到界面上（否则下面的清空断言在"页面上从来没数据"时也会绿）。
  f.ok(f.last('/knowledge'), { items: [knowledgeItem()], next_cursor: 'cursor-old-page-2' });
  await settle();
  assert.equal(f.page.data.items.length, 1, '成功读取后界面上必须有 1 条旧数据（清空断言的前置）');
  assert.equal(f.page.data.nextCursor, 'cursor-old-page-2', '成功读取后翻页游标必须存在（否则"清空游标"无从观测）');
  assert.equal(f.page.data.stateKind, 'ready');

  for (const [index, injection] of INJECTIONS.entries()) {
    // 每一轮都要**重新**把旧数据放回界面：否则第 2 轮开始"清空"只是延续上一轮的空。
    if (index > 0) {
      f.page.read();
      f.ok(f.last('/knowledge'), { items: [knowledgeItem()], next_cursor: 'cursor-old-page-2' });
      await settle();
      assert.equal(f.page.data.items.length, 1, `第 ${index + 1} 轮前置：旧数据必须重新出现`);
    }
    f.page.read();
    const inFlight = f.last('/knowledge');
    assert.equal(f.page.data.stateKind, 'loading', `${injection.name}：发起读取后必须先进 loading 态`);
    assert.equal(f.page.data.items.length, 0, `${injection.name}：发起读取时就要先清掉旧列表（不等失败回来）`);
    injection.apply(inFlight);
    await settle();

    const label = `知识列表页 / ${injection.name}`;
    // ⚠ 页面 data 里的数组来自 vm 沙箱的另一个 realm，直接用 `deepEqual` 会在**原型**上失败
    //   （`[]` ≠ 宿主 `[]`）⇒ 先展开成宿主数组再比。
    assert.deepEqual([...f.page.data.items], [], `${label}：失败后 items 必须是空数组（不是 undefined、也不是旧数组）`);
    assert.equal(f.page.data.nextCursor, null, `${label}：失败后 nextCursor 必须归零（旧游标不得留下）`);
    assert.equal(f.page.data.stateKind, 'error', `${label}：失败必须落 error 态，而不是 idle／ready`);
    assert.equal(f.page.data.busy, false, `${label}：失败后不得停在 busy`);
    assert.equal(f.page.data.status.includes('已清空'), true, `${label}：文案必须如实说明已清空，实测「${f.page.data.status}」`);
    assertNoResidue(f.page.data, ['旧资料标题（失败后必须消失）', TARGET], label);
  }
});

test('知识列表页：三处失败码口径（网络/超时/中止同码，非 2xx 折叠为 UNAVAILABLE）逐条钉住', async () => {
  const knowledgeApi = knowledgeFixture().load(root + '/miniprogram/utils/knowledge-api.js');
  // 客户端的**冻结文案表**（`miniprogram/utils/knowledge-api.js#message`）：这两条都以"已清空"结尾，
  // 断言的正是"失败必须被说成已清空"，不是"暂无资料"。
  assert.equal(knowledgeApi.message({ code: 'NETWORK_UNCERTAIN' }), '网络未能确认当前资料，已清空，请重试。');
  assert.equal(knowledgeApi.message({ code: 'UNAVAILABLE' }), '资料服务暂不可用，已清空，请重试。');
  // 兜底文案同样必须带"已清空"：任何没进码表的失败码都不许被说成"没有资料"。
  assert.equal(knowledgeApi.message({ code: 'SOMETHING_NEW' }).includes('已清空'), true);
});

// ===========================================================================
// ② 详情页：`read()` 失败 ⇒ item/labels 清空、stateKind=error
// ===========================================================================
function detailFixture() {
  const f = fixture('pages/knowledgedetail/knowledgedetail');
  f.auth.setSession({ accessToken: 'synthetic-netfail-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
  f.load(root + '/miniprogram/pages/knowledgedetail/knowledgedetail.js');
  f.page.onLoad({ id: TARGET });
  return f;
}

test('详情页：四种请求失败都清掉旧详情并落 error（不留旧正文、不留旧来源标签）', async () => {
  const f = detailFixture();
  await passGate(f);
  f.ok(f.last(`/knowledge/${TARGET}`), knowledgeItem());
  await settle();
  // `checkGate` 读完详情会回填收藏态：这里给"未收藏"，把这条路走完再断言（避免在途请求干扰计数）。
  if (f.last('/favorites') !== undefined) {
    f.ok(f.last('/favorites'), { items: [], next_cursor: null });
    await settle();
  }
  assert.equal(f.page.data.item === null, false, '成功读取后详情页必须有旧 item（清空断言的前置）');
  assert.equal(f.page.data.labels === null, false, '成功读取后详情页必须有旧 labels');

  for (const [index, injection] of INJECTIONS.entries()) {
    if (index > 0) {
      f.page.read();
      f.ok(f.last(`/knowledge/${TARGET}`), knowledgeItem());
      await settle();
      assert.equal(f.page.data.item === null, false, `第 ${index + 1} 轮前置：旧详情必须重新出现`);
    }
    f.page.read();
    const inFlight = f.last(`/knowledge/${TARGET}`);
    assert.equal(f.page.data.item, null, `${injection.name}：发起重读时就要先清掉旧详情（不等失败回来）`);
    injection.apply(inFlight);
    await settle();

    const label = `详情页 / ${injection.name}`;
    assert.equal(f.page.data.item, null, `${label}：失败后 item 必须是 null`);
    assert.equal(f.page.data.labels, null, `${label}：失败后 labels 必须是 null（旧来源标签不得留下）`);
    assert.equal(f.page.data.stateKind, 'error', `${label}：失败必须落 error 态`);
    assert.equal(f.page.data.busy, false, `${label}：失败后不得停在 busy`);
    assert.equal(f.page.data.status.includes('已清空'), true, `${label}：文案必须如实说明已清空，实测「${f.page.data.status}」`);
    assertNoResidue(f.page.data, ['旧资料标题（失败后必须消失）', '旧资料正文（失败后必须消失）', TARGET], label);
  }
});

// ===========================================================================
// ③ 收藏页：`loadFavorites()` 失败 ⇒ items/total/nextCursor 归零 + errorCode 原样带出
// ===========================================================================
function favoritesFixture() {
  const f = fixture('pages/favorites/favorites');
  f.auth.setSession({ accessToken: 'synthetic-netfail-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
  f.load(root + '/miniprogram/pages/favorites/favorites.js');
  f.page.onLoad();
  return f;
}

test('收藏页：四种请求失败都清掉旧收藏列表，错误码原样带出（不折叠成空列表）', async () => {
  const f = favoritesFixture();
  await passGate(f);
  // onShow 通过门禁后同时发两条：收藏列表与「可收藏的资料」。
  f.ok(f.last('/favorites'), { items: [favoriteRow()], next_cursor: 'cursor-old-page-2' });
  f.ok(f.last('/knowledge'), { items: [knowledgeItem()], next_cursor: null });
  await settle();
  assert.equal(f.page.data.items.length, 1, '成功读取后收藏页必须有 1 条旧收藏（清空断言的前置）');
  assert.equal(f.page.data.total, 1);
  assert.equal(f.page.data.errorCode, '');
  assert.equal(f.page.data.targets.length, 1, '「可收藏的资料」也必须先有旧数据（失败后不得继续显示）');

  // 非 2xx 用 503 + 服务端错误封套：收藏面会把**服务端码原样带出**（与知识面折叠成 UNAVAILABLE 不同）。
  const expectCode = { '网络错': 'NETWORK_UNCERTAIN', '非 2xx（503 带错误封套）': 'PROVIDER_UNAVAILABLE', '超时': 'NETWORK_UNCERTAIN', '中止': 'NETWORK_UNCERTAIN' };
  for (const [index, injection] of INJECTIONS.entries()) {
    if (index > 0) {
      f.page.loadFavorites();
      f.ok(f.last('/favorites'), { items: [favoriteRow()], next_cursor: 'cursor-old-page-2' });
      await settle();
      assert.equal(f.page.data.items.length, 1, `第 ${index + 1} 轮前置：旧收藏必须重新出现`);
    }
    f.page.loadFavorites();
    const inFlight = f.last('/favorites');
    assert.equal(f.page.data.busy, true, `${injection.name}：发起读取后必须先进 busy`);
    injection.apply(inFlight);
    await settle();

    const label = `收藏页 / ${injection.name}`;
    assert.deepEqual([...f.page.data.items], [], `${label}：失败后 items 必须是空数组（旧收藏一条都不留）`);
    assert.equal(f.page.data.total, 0, `${label}：失败后 total 必须归零`);
    assert.equal(f.page.data.nextCursor, null, `${label}：失败后 nextCursor 必须归零`);
    assert.equal(f.page.data.errorCode, expectCode[injection.name], `${label}：errorCode 必须原样带出（⛔ 不得折叠成空列表或"未登录"）`);
    assert.equal(f.page.data.errorText.length > 0, true, `${label}：失败必须有可见错误文案`);
    assert.equal(f.page.data.busy, false, `${label}：失败后不得停在 busy`);
    assertNoResidue(f.page.data, [FAVORITE], label);
    // 空态文案不得抢在错误前面把"读失败"说成"尚无收藏"。
    assert.notEqual(f.page.data.message, '尚无收藏。', `${label}：读失败不得被说成"尚无收藏"`);
  }
});

// ===========================================================================
// ④ 负控制（可执行的结构守卫）：把清空改回"失败也留旧数据"，上面三组必红
// ===========================================================================
// ⚠ 这里必须**贴着失败分支的错误赋值**去匹配（`status: api.message(e)` / `errorText:` ），
// 否则正则会被同一文件里 `clear()`／`onShow()` 的同名清空串糊过去（本片实测：只写
// `items: [], nextCursor: null` 时，把失败分支里的清空删掉仍然是绿的 —— 那是个假守卫）。
test('负控制：三个**失败分支**的源码里都必须显式清空（改回保留旧数据必红）', () => {
  const expect = [
    // knowledge.js 的 catch：同一个 setData 里既有错误文案又有 items/游标清空。
    ['miniprogram/pages/knowledge/knowledge.js', /busy:\s*false,\s*items:\s*\[\],\s*nextCursor:\s*null,\s*status:\s*api\.message\(e\),\s*stateKind:\s*'error'/],
    // knowledgedetail.js 的 catch：item/labels 与错误文案在同一个 setData 里。
    ['miniprogram/pages/knowledgedetail/knowledgedetail.js', /item:\s*null,\s*labels:\s*null,\s*busy:\s*false,\s*status:\s*api\.message\(e\),\s*stateKind:\s*'error'/],
    // favorites.js 的 .catch：items/total/游标清空与 errorText/errorCode 在同一个 setData 里。
    ['miniprogram/pages/favorites/favorites.js', /items:\s*\[\],\s*total:\s*0,\s*nextCursor:\s*null,\s*errorText:\s*favoritesApi\.messageFor\(error\)/]
  ];
  for (const [file, pattern] of expect) {
    const source = readFileSync(resolve(root, file), 'utf8');
    assert.ok(pattern.test(source), `${file}：失败分支必须显式清空旧数据（找不到 ${pattern}）`);
  }
});
