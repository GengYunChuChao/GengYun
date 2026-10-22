// GY-I16 识别结果页「收藏」入口（`miniprogram/components/fav-entry`）在合成响应下的读数。
//
// 这不是真机 / 微信开发者工具证据，也不是真库证据：只证明组件在四类边界（候选缺失 / 网络失败 /
// 409 冲突 / 403 越权）下**如实失败**，并在正控制下真的把两个不同的 revision 用对地方：
//   * `target_ref.revision` = **目标资料**（`GET /knowledge/{id}` 的 `item.revision`）；
//   * `If-Match` = **收藏行**的 revision（`DELETE /favorites/{id}`）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const BASE = 'http://127.0.0.1:1234/api/v1';
const JOB = '22222222-2222-4222-8222-222222222222';
const JOB_B = '88888888-8888-4888-8888-888888888888';
const REC = '33333333-3333-4333-8333-333333333333';
const SPECIES_A = '44444444-4444-4444-8444-444444444444';
const SPECIES_B = '55555555-5555-4555-8555-555555555555';
const FAV = '66666666-6666-4666-8666-666666666666';
const FUTURE = () => new Date(Date.now() + 3600_000).toISOString();

function meta() {
  return { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' };
}

function candidate(rank, speciesId) {
  return { species_id: speciesId, rank: rank, model_score: 0.9 };
}

function job({ candidates = [candidate(1, SPECIES_A)], state = 'succeeded', withResult = true } = {}) {
  return {
    id: JOB, revision: 7, kind: 'recognition',
    target_ref: { type: 'recognition', id: REC, revision: 2 },
    state: state, deadline_at: FUTURE(), created_at: '2026-10-21T00:00:00.000Z', error_code: null,
    // 未完成的作业带 result 就是响应异常（identify-api.js:327）⇒ queued/running 必须 result=null。
    result: withResult ? {
      kind: 'recognition',
      value: {
        id: REC, revision: 2, candidates: candidates, uncertainty_reasons: [],
        selected_species_id: null, model_version: 'gy-model-1'
      }
    } : null
  };
}

function knowledge(speciesId, revision = 5, overrides = {}) {
  return Object.assign({
    id: speciesId, revision: revision, type: 'species', title: '合成的杂草资料', body: '正文',
    source: {
      id: '77777777-7777-4777-8777-777777777777', version: 'v1', title: '合成来源', url: 'https://example.test/source',
      publisher: '合成出版社', source_kind: 'verified_seed', evidence_kind: 'research', validity: 'valid',
      review_status: 'verified', updated_at: '2026-10-01T00:00:00.000Z'
    },
    conditions: null, reference_state: 'available', dose_cards: []
  }, overrides);
}

function favorite(overrides = {}) {
  return Object.assign({
    id: FAV, revision: 2,
    target_ref: { type: 'species', id: SPECIES_A, revision: 5 },
    reference_state: 'available', unavailable_reason: null, created_at: '2026-10-21T01:00:00.000Z'
  }, overrides);
}

/** 契约错误封套里的 `error` 对象（外层 `meta` 由 `mount` 补上）。 */
function errorBody(code, retryable = false) {
  return { code: code, message: code, retryable: retryable, details: [] };
}

/** 装配一套 wx 替身 + 模块加载器；`handler` 按 `{method, path, body, header}` 回一条合成响应。 */
function mount(handler) {
  const requests = [];
  const unhandled = [];
  const storage = new Map();
  // 与既有 `miniprogram-favorites-history.test.mjs` 同形：`navigation.currentPage()` 需要一页真实
  // 的页面描述，否则 `requireLogin` 的回调会被判成「页面已变」而恒返回 false。
  const page = { route: 'pages/identify/identify', options: {}, data: {}, setData(p) { Object.assign(this.data, p); } };
  let definition = null;
  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    request(o) {
      requests.push(o);
      const out = handler({ method: o.method || 'GET', path: String(o.url).replace(BASE, ''), body: o.data, header: o.header || {} });
      if (!out) {
        unhandled.push((o.method || 'GET') + ' ' + String(o.url).replace(BASE, ''));
        o.success({ statusCode: 599, data: { meta: meta(), error: errorBody('UNEXPECTED') }, header: {} });
        return;
      }
      if (out.fail) { o.fail({ errMsg: 'request:fail timeout' }); return; }
      const ok = out.status >= 200 && out.status < 300;
      o.success({
        statusCode: out.status,
        data: ok ? { data: out.data, meta: meta() } : { meta: meta(), error: out.error },
        header: out.header || {}
      });
    },
    showToast: () => {},
    showModal: (o) => o.success({ confirm: true }),
    navigateTo: () => {}, navigateBack: () => {}, redirectTo: () => {}, reLaunch: () => {}, switchTab: () => {}
  };
  const cache = new Map();
  function load(path) {
    path = resolve(path);
    if (path.endsWith('runtime.js')) return { mode: 'local', apiBaseUrl: BASE };
    if (cache.has(path)) return cache.get(path).exports;
    const m = { exports: {} };
    cache.set(path, m);
    vm.runInNewContext(
      '(function(require,module,Component,Page){' + readFileSync(path, 'utf8') + '\n})',
      { wx, Component: (d) => { definition = d; return d }, Page: () => {}, getCurrentPages: () => [page] }
    )((id) => load(resolve(dirname(path), id + '.js')), m, (d) => { definition = d; return d }, () => {});
    return m.exports;
  }
  const auth = load(root + '/miniprogram/utils/auth.js');
  load(root + '/miniprogram/components/fav-entry/fav-entry.js');
  return { wx, requests, unhandled, auth, def: definition };
}

/** 会话必须过服务端核实（`auth.isLoggedIn()` 才可能为真）。 */
async function login(f) {
  f.auth.setSession({ accessToken: 'synthetic-i16-fav-token', audience: 'user', expiresAt: FUTURE(), executionMode: 'stub' });
  f.auth.requireLogin(() => {});
  const request = f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1);
  request.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: FUTURE() } } });
  await new Promise((r) => setImmediate(r));
  // `requireLogin` 的回调值还受页面身份约束（导航快照），这里只认真正的前置条件：
  // 服务端核实通过的会话（`serverVerified && session !== null`）。
  return f.auth.isLoggedIn();
}

function instance(def) {
  const data = JSON.parse(JSON.stringify(def.data || {}));
  for (const [key, spec] of Object.entries(def.properties || {})) data[key] = spec.value;
  const inst = { data, setData(patch) { Object.assign(this.data, patch); }, triggerEvent() {} };
  for (const [key, fn] of Object.entries(def.methods || {})) inst[key] = fn.bind(inst);
  return inst;
}

/** 走组件真正的 `observers` 入口（与微信里属性变化同一条路径）。 */
function observe(def, inst, patch) {
  const name = Object.keys(def.observers || {})[0];
  const args = name.split(',').map((s) => s.trim()).map((k) => (k in patch ? patch[k] : inst.data[k]));
  return def.observers[name].apply(inst, args);
}

function tap(inst, index) {
  return inst.onToggle({ currentTarget: { dataset: { index: index } } });
}

/** 计数：作业详情读了几次、收藏读了几次。 */
function readsOf(f, id = JOB) {
  return f.requests.filter((r) => String(r.url).endsWith('/jobs/' + id)).length;
}
function favOf(f) {
  return f.requests.filter((r) => String(r.url).includes('/favorites')).length;
}

test('候选缺失：拿不到候选就不渲染入口，也不发生任何收藏读写', async () => {
  const f = mount(({ path }) => {
    if (path === '/auth/session') return { status: 200, data: { audience: 'user', expires_at: FUTURE() } };
    if (path === '/jobs/' + JOB) return { status: 200, data: job({ candidates: [] }) };
    return undefined;
  });
  assert.equal(await login(f), true);
  const inst = instance(f.def);
  await observe(f.def, inst, { jobId: JOB, enabled: true });

  assert.equal(inst.data.visible, false, '无候选时入口必须不渲染');
  assert.deepEqual([...inst.data.items], []);
  assert.equal(inst.data.errorText, '', '无候选是合法空态，不是错误');
  assert.equal(f.requests.filter((r) => r.url.includes('/favorites')).length, 0, '无候选时不得读/写收藏');
  assert.deepEqual([...f.unhandled], []);
});

test('网络失败：作业详情取不到 ⇒ 不渲染入口，只给如实提示', async () => {
  const f = mount(({ path }) => {
    if (path === '/auth/session') return { status: 200, data: { audience: 'user', expires_at: FUTURE() } };
    if (path === '/jobs/' + JOB) return { fail: true };
    return undefined;
  });
  assert.equal(await login(f), true);
  const inst = instance(f.def);
  await observe(f.def, inst, { jobId: JOB, enabled: true });

  assert.equal(inst.data.visible, false);
  assert.deepEqual([...inst.data.items], []);
  assert.equal(inst.data.errorText, '网络未能确认结果，已停止显示，请重试。');
  assert.equal(f.requests.filter((r) => r.url.includes('/favorites')).length, 0);
  assert.deepEqual([...f.unhandled], []);
});

test('409 冲突：取消收藏的冲突如实报错，绝不吞成「已取消」', async () => {
  const f = mount(({ method, path }) => {
    if (path === '/auth/session') return { status: 200, data: { audience: 'user', expires_at: FUTURE() } };
    if (path === '/jobs/' + JOB) return { status: 200, data: job() };
    if (path.startsWith('/knowledge/')) return { status: 200, data: knowledge(SPECIES_A) };
    if (path === '/favorites?limit=50') return { status: 200, data: { items: [favorite()], next_cursor: null } };
    if (method === 'DELETE' && path === '/favorites/' + FAV) return { status: 409, error: errorBody('REVISION_CONFLICT') };
    return undefined;
  });
  assert.equal(await login(f), true);
  const inst = instance(f.def);
  await observe(f.def, inst, { jobId: JOB, enabled: true });
  assert.equal(inst.data.visible, true, '正控制：有候选且资料可读时入口必须出现');
  assert.equal(inst.data.items[0].favorited, true);
  assert.equal(inst.data.items[0].favoriteRevision, 2);

  await tap(inst, 0);

  assert.equal(inst.data.items[0].favorited, true, '409 之后本地状态必须仍是「已收藏」');
  assert.equal(inst.data.note, '', '不得出现「已取消收藏」这类成功话术');
  assert.equal(inst.data.errorText, '收藏已被更新，请刷新后重试。');
  const del = f.requests.filter((r) => r.method === 'DELETE').at(-1);
  assert.equal(del.header['If-Match'], '"2"', 'If-Match 必须用收藏行 revision');
  assert.deepEqual([...f.unhandled], []);
});

test('403 越权：如实报权限拒绝，且不折叠成 401／不清会话', async () => {
  const f = mount(({ method, path }) => {
    if (path === '/auth/session') return { status: 200, data: { audience: 'user', expires_at: FUTURE() } };
    if (path === '/jobs/' + JOB) return { status: 200, data: job() };
    if (path.startsWith('/knowledge/')) return { status: 200, data: knowledge(SPECIES_A) };
    if (path === '/favorites?limit=50') return { status: 200, data: { items: [], next_cursor: null } };
    if (method === 'POST' && path === '/favorites') return { status: 403, error: errorBody('SCOPE_DENIED') };
    return undefined;
  });
  assert.equal(await login(f), true);
  const inst = instance(f.def);
  await observe(f.def, inst, { jobId: JOB, enabled: true });
  assert.equal(inst.data.items[0].favorited, false);

  await tap(inst, 0);

  assert.equal(inst.data.items[0].favorited, false, '403 之后不得假装收藏成功');
  assert.equal(inst.data.errorText, '当前会话无权读写用户收藏（收藏只对用户会话开放）。');
  assert.equal(f.auth.isLoggedIn(), true, '403 属于权限拒绝，不得清会话（与 401 区分）');
  assert.deepEqual([...f.unhandled], []);
});

test('正控制：收藏写目标资料 revision，取消写收藏行 revision，两步都不串版本', async () => {
  const f = mount(({ method, path }) => {
    if (path === '/auth/session') return { status: 200, data: { audience: 'user', expires_at: FUTURE() } };
    if (path === '/jobs/' + JOB) return { status: 200, data: job({ candidates: [candidate(1, SPECIES_A), candidate(2, SPECIES_B)] }) };
    if (path.startsWith('/knowledge/')) {
      const id = path.slice('/knowledge/'.length);
      if (id === SPECIES_A) return { status: 200, data: knowledge(SPECIES_A, 5) };
      if (id === SPECIES_B) return { status: 404, error: errorBody('NOT_FOUND') };
      return undefined;
    }
    if (path === '/favorites?limit=50') return { status: 200, data: { items: [], next_cursor: null } };
    if (method === 'POST' && path === '/favorites') return { status: 201, data: favorite() };
    if (method === 'DELETE' && path === '/favorites/' + FAV) return { status: 200, data: { accepted: true } };
    return undefined;
  });
  assert.equal(await login(f), true);
  const inst = instance(f.def);
  await observe(f.def, inst, { jobId: JOB, enabled: true });

  // 候选 2 的资料取不到 ⇒ 只丢这一个候选，候选 1 仍然可收藏（逐条 fail-closed，不整块失败）。
  assert.equal(inst.data.visible, true);
  assert.equal(inst.data.items.length, 1, '取不到版本的候选必须被丢掉，而不是带着 0 版本出现');
  assert.equal(inst.data.items[0].speciesId, SPECIES_A);
  assert.equal(inst.data.items[0].revision, 5);

  await tap(inst, 0);
  const post = f.requests.filter((r) => r.method === 'POST').at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(post.data)), { target_ref: { type: 'species', id: SPECIES_A, revision: 5 } }, 'target_ref.revision 必须是资料版本');
  assert.equal(typeof post.header['Idempotency-Key'], 'string');
  assert.equal(post.header['If-Match'], undefined, '收藏写入不带 If-Match（契约不要求）');
  assert.equal(inst.data.items[0].favorited, true);
  assert.equal(inst.data.items[0].favoriteRevision, 2);
  assert.equal(inst.data.note, '已收藏。');

  await tap(inst, 0);
  const del = f.requests.filter((r) => r.method === 'DELETE').at(-1);
  assert.equal(del.header['If-Match'], '"2"', 'If-Match 必须是收藏行 revision 2，而不是资料 revision 5');
  assert.equal(inst.data.items[0].favorited, false);
  assert.equal(inst.data.note, '已取消收藏。');
  assert.deepEqual([...f.unhandled], []);
});

test('状态机收敛：同一作业 queued→running→succeeded 会重新装配（监工 1021-2358 探针）', async () => {
  let phase = 'queued';
  const f = mount(({ path }) => {
    if (path === '/auth/session') return { status: 200, data: { audience: 'user', expires_at: FUTURE() } };
    if (path === '/jobs/' + JOB) {
      return { status: 200, data: phase === 'succeeded' ? job() : job({ state: phase, withResult: false }) };
    }
    if (path.startsWith('/knowledge/')) return { status: 200, data: knowledge(SPECIES_A) };
    if (path === '/favorites?limit=50') return { status: 200, data: { items: [], next_cursor: null } };
    return undefined;
  });
  assert.equal(await login(f), true);
  const inst = instance(f.def);

  // 第一拍：宿主刚创建任务（queued）⇒ 一个请求都不发，更别读收藏。
  await observe(f.def, inst, { jobId: JOB, enabled: true, jobState: 'queued' });
  assert.equal(readsOf(f), 0, 'queued 时不该去取作业详情');
  assert.equal(favOf(f), 0);
  assert.equal(inst.data.visible, false);
  assert.deepEqual([...inst.data.items], []);

  // 中间态：id 与开关都没变，只有状态变了。
  await observe(f.def, inst, { jobId: JOB, enabled: true, jobState: 'running' });
  assert.equal(readsOf(f), 0, 'running 同样没有可收藏的结果');

  // 第二拍：作业成功。修前 _key 只含 (jobId, enabled)，这里被永久短路 ⇒ 入口永不出现。
  phase = 'succeeded';
  await observe(f.def, inst, { jobId: JOB, enabled: true, jobState: 'succeeded' });
  const reads = readsOf(f);
  assert.equal(reads, 1, '同一作业成功后必须真的取一次作业详情');
  assert.equal(inst.data.visible, true, '同一作业成功后收藏入口必须出现');
  assert.equal(inst.data.items.length, 1);
  assert.equal(inst.data.items[0].speciesId, SPECIES_A);
  assert.equal(inst.data.loading, false);
  assert.deepEqual([...f.unhandled], []);

  // 三元组没变 ⇒ 不重复打网络。
  await observe(f.def, inst, { jobId: JOB, enabled: true, jobState: 'succeeded' });
  assert.equal(readsOf(f), reads, '同参数重复触发不得重复打网络');
});

test('未声明 job-state 的老宿主：未完成不缓存，同参重放也能拿到新结果（监工探针同参重放）', async () => {
  let phase = 'queued';
  const f = mount(({ path }) => {
    if (path === '/auth/session') return { status: 200, data: { audience: 'user', expires_at: FUTURE() } };
    if (path === '/jobs/' + JOB) {
      return { status: 200, data: phase === 'succeeded' ? job() : job({ state: phase, withResult: false }) };
    }
    if (path.startsWith('/knowledge/')) return { status: 200, data: knowledge(SPECIES_A) };
    if (path === '/favorites?limit=50') return { status: 200, data: { items: [], next_cursor: null } };
    return undefined;
  });
  assert.equal(await login(f), true);
  const inst = instance(f.def);

  await observe(f.def, inst, { jobId: JOB, enabled: true, jobState: '' });
  assert.equal(readsOf(f), 1, '未声明状态只能问服务端');
  assert.equal(inst.data.visible, false);
  assert.equal(favOf(f), 0, '作业没成功时不得读收藏');

  // 与监工最小复现同形：**同一组参数**再触发一次（修前 _key 短路 ⇒ reads 仍 1、visible 仍 false）。
  await observe(f.def, inst, { jobId: JOB, enabled: true, jobState: '' });
  assert.equal(readsOf(f), 2, '未完成不是结论，重复触发必须重新取');

  phase = 'succeeded';
  await observe(f.def, inst, { jobId: JOB, enabled: true, jobState: '' });
  assert.equal(readsOf(f), 3);
  assert.equal(inst.data.visible, true, '同一作业成功后收藏入口必须出现');
  assert.equal(inst.data.items[0].speciesId, SPECIES_A);
  assert.deepEqual([...f.unhandled], []);
});

test('宿主声称 succeeded 但服务端仍 queued ⇒ 仍不渲染，服务端状态优先', async () => {
  let phase = 'queued';
  const f = mount(({ path }) => {
    if (path === '/auth/session') return { status: 200, data: { audience: 'user', expires_at: FUTURE() } };
    if (path === '/jobs/' + JOB) {
      return { status: 200, data: phase === 'succeeded' ? job() : job({ state: phase, withResult: false }) };
    }
    if (path.startsWith('/knowledge/')) return { status: 200, data: knowledge(SPECIES_A) };
    if (path === '/favorites?limit=50') return { status: 200, data: { items: [], next_cursor: null } };
    return undefined;
  });
  assert.equal(await login(f), true);
  const inst = instance(f.def);

  await observe(f.def, inst, { jobId: JOB, enabled: true, jobState: 'succeeded' });
  assert.equal(readsOf(f), 1);
  assert.equal(inst.data.visible, false, '服务端状态优先于宿主声明');
  assert.deepEqual([...inst.data.items], []);
  assert.equal(favOf(f), 0);

  // 服务端随后也成功：宿主声明没变，但未终态不缓存 ⇒ 再触发能拿到结果。
  phase = 'succeeded';
  await observe(f.def, inst, { jobId: JOB, enabled: true, jobState: 'succeeded' });
  assert.equal(readsOf(f), 2);
  assert.equal(inst.data.visible, true);
  assert.deepEqual([...f.unhandled], []);
});

test('非成功态与关闭开关：零请求、零残留（游客 / 未完成 / 失败都不给入口）', async () => {
  const f = mount(({ path }) => {
    if (path === '/auth/session') return { status: 200, data: { audience: 'user', expires_at: FUTURE() } };
    return undefined;
  });
  assert.equal(await login(f), true);
  const inst = instance(f.def);

  await observe(f.def, inst, { jobId: JOB, enabled: false, jobState: 'succeeded' });
  assert.equal(readsOf(f), 0, '关了开关就不该发请求');

  for (const state of ['queued', 'running', 'uncertain', 'failed', 'timed_out', 'cancelled']) {
    await observe(f.def, inst, { jobId: JOB, enabled: true, jobState: state });
  }
  assert.equal(inst.data.visible, false);
  assert.deepEqual([...inst.data.items], []);
  assert.equal(readsOf(f), 0, '非 succeeded 状态一次作业详情都不该取');
  assert.equal(favOf(f), 0);
  assert.deepEqual([...f.unhandled], []);
});

test('换任务：旧任务的收藏条目立即清空，不残留可点按钮', async () => {
  const f = mount(({ path }) => {
    if (path === '/auth/session') return { status: 200, data: { audience: 'user', expires_at: FUTURE() } };
    if (path === '/jobs/' + JOB) return { status: 200, data: job() };
    if (path === '/jobs/' + JOB_B) return { status: 200, data: Object.assign(job({ candidates: [] }), { id: JOB_B }) };
    if (path.startsWith('/knowledge/')) return { status: 200, data: knowledge(SPECIES_A) };
    if (path === '/favorites?limit=50') return { status: 200, data: { items: [], next_cursor: null } };
    return undefined;
  });
  assert.equal(await login(f), true);
  const inst = instance(f.def);

  await observe(f.def, inst, { jobId: JOB, enabled: true, jobState: 'succeeded' });
  assert.equal(inst.data.items.length, 1);

  await observe(f.def, inst, { jobId: JOB_B, enabled: true, jobState: 'succeeded' });
  assert.deepEqual([...inst.data.items], [], '换任务后不得残留上一任务的收藏条目');
  assert.equal(inst.data.visible, false);

  // 关开关同样立刻清空（用户在页面上不该还能点到旧条目）。
  await observe(f.def, inst, { jobId: JOB, enabled: true, jobState: 'succeeded' });
  assert.equal(inst.data.items.length, 1);
  await observe(f.def, inst, { jobId: JOB, enabled: false, jobState: 'succeeded' });
  assert.deepEqual([...inst.data.items], []);
  assert.equal(inst.data.visible, false);
  assert.deepEqual([...f.unhandled], []);
});

test('接线：identify.json 注册组件、identify.wxml 按宿主状态机挂载且只一行标签', () => {
  const json = JSON.parse(readFileSync(resolve(root, 'miniprogram/pages/identify/identify.json'), 'utf8'));
  assert.equal(json.usingComponents['fav-entry'], '/components/fav-entry/fav-entry');
  const wxml = readFileSync(resolve(root, 'miniprogram/pages/identify/identify.wxml'), 'utf8');
  const tags = wxml.match(/<fav-entry\b[^>]*>/g) || [];
  assert.equal(tags.length, 1, '只允许一个 <fav-entry> 标签');
  assert.match(tags[0], /job-id="\{\{job\.id\}\}"/);
  assert.match(tags[0], /job-state="\{\{job\.state\}\}"/);
  assert.match(tags[0], /enabled="\{\{!guest\}\}"/);
  // 挂载条件必须跟着宿主的真实状态机：只有 succeeded 才给收藏目标。
  assert.match(tags[0], /wx:if="\{\{job\.id && job\.state === 'succeeded' && !guest\}\}"/);
});
