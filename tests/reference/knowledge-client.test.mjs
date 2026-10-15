// Actual client/pages/auth/navigation/page-gate with controlled HTTP callbacks.
// All identities and records in this suite are synthetic, never production evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
const root = resolve(import.meta.dirname, '../../miniprogram');
export const id = '11111111-1111-4111-8111-111111111111';
export function record(patch = {}) { return { id, revision: 1, type: 'herbicide', title: '合成知识条目', body: '合成科普正文，不作为用药依据。',
  source: { id: '22222222-2222-4222-8222-222222222222', version: 'synthetic-v1', title: '合成来源', url: 'https://example.test/source', publisher: '测试发布方', source_kind: 'simulation', evidence_kind: 'research', validity: 'valid', review_status: 'unverified', updated_at: '2026-10-11T01:00:00Z' }, conditions: null, reference_state: 'available', dose_cards: [], ...patch }; }
export const envelope = (data, mode = 'stub') => ({ data, meta: { request_id: '33333333-3333-4333-8333-333333333333', contract_version: '1.0.0', execution_mode: mode } });
const flush = () => new Promise(r => setImmediate(r));
function fixture(name = 'knowledge') {
  const requests = [], storage = new Map(), routes = [], clips = [], cache = new Map(); let page;
  const wx = { request: o => requests.push(o), login: o => o.success({ code: 'synthetic-code' }), getStorageSync: k => storage.get(k), setStorageSync: (k, v) => storage.set(k, v), removeStorageSync: k => storage.delete(k),
    reLaunch: o => { routes.push(o.url); o.success?.() }, navigateTo: o => { routes.push(o.url); o.success?.() }, redirectTo: o => { routes.push(o.url); o.success?.() }, navigateBack: o => { wx.back = o }, setClipboardData: o => clips.push(o.data) };
  function load(file) {
    file = resolve(file); if (!file.endsWith('.js')) file += '.js'; if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    if (file === resolve(root, 'config/runtime.js')) { module.exports = { mode: 'local', apiBaseUrl: 'http://127.0.0.1:9999/api/v1' }; return module.exports }
    vm.runInNewContext(readFileSync(file, 'utf8'), { module, wx, require: p => load(resolve(dirname(file), p)),
      getApp: () => ({ globalData: { fontScale: 1 } }), getCurrentPages: () => page ? [page] : [],
      Page: d => { page = { ...d, route: 'pages/' + name + '/' + name, options: {}, data: structuredClone(d.data), setData(p) { Object.assign(this.data, p) } } } }, { filename: file });
    return module.exports;
  }
  const auth = load(resolve(root, 'utils/auth.js')), api = load(resolve(root, 'utils/knowledge-api.js')), nav = load(resolve(root, 'utils/navigation.js'));
  load(resolve(root, 'pages/' + name + '/' + name + '.js'));
  const last = path => requests.filter(r => r.url.includes(path)).at(-1);
  function answer(r, data, status = 200, mode = 'stub') { assert.ok(r, 'expected request'); r.success({ statusCode: status, data: envelope(data, mode) }) }
  // 科普页在门禁通过后**只读一次** /me/profile（见 pages/knowledge/knowledge.js#prepare）：
  // 默认回答"空档案"，即不预置任何筛选，保持既有查询串回归的可比性。
  function answerProfile(patch = {}) { const r = last('/me/profile'); assert.ok(r, 'expected profile request'); answer(r, { crop_id: null, region_code: null, region_catalog_version: null, revision: 1, ...patch }); return r }
  function login(token = 'synthetic-token') { auth.login(() => {}); answer(last('/auth/wechat'), { access_token: token, audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() }) }
  function show(options = {}) { page.options = options; page.onLoad(options); page.onShow(); const r = last('/auth/session'); if (r) { answer(r, { audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() }); if (last('/me/profile')) answerProfile() } }
  return { page, wx, requests, routes, clips, auth, api, nav, answer, answerProfile, login, show, last };
}
// ---- 只读 WXML 兄弟链语义求值（用于钉住科普页结果区"任一状态恰渲染 1 个 .status"）----
// WXML 规则：wx:elif / wx:else 只延续**同一父节点下紧邻**的 wx:if / wx:elif；自带 wx:if 的节点
// 开启**新链**，不会继承上一条链的"已命中"状态。这里不跑编译器、无视觉证据，只做结构语义求值。
const VOID_TAGS = new Set(['image', 'input', 'icon', 'import', 'include', 'wxs']);
function parseWxml(src) {
  const text = src.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' ')); // 注释置空（保行号）
  const tagRe = /<(\/?)([A-Za-z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  let m, prevEnd = 0;
  while ((m = tagRe.exec(text)) !== null) {
    const between = text.slice(prevEnd, m.index);
    if (between.trim()) stack[stack.length - 1].children.push({ tag: '#text', value: between });
    prevEnd = tagRe.lastIndex;
    if (m[1]) { if (stack.length > 1) stack.pop(); continue }
    const attrs = {};
    const ar = /([A-Za-z_:][-\w:.]*)(?:\s*=\s*"([^"]*)")?/g;
    let a; while ((a = ar.exec(m[3])) !== null) attrs[a[1]] = a[2];
    const el = { tag: m[2], attrs, children: [], selfClosing: m[4] === '/' || VOID_TAGS.has(m[2]) };
    stack[stack.length - 1].children.push(el);
    if (!el.selfClosing) stack.push(el);
  }
  return root;
}
const wxmlExpr = (raw, data) => vm.runInNewContext(String(raw).replace(/^\{\{/, '').replace(/\}\}$/, '').trim(), Object.assign(Object.create(null), data));
function renderWxml(node, data, out = [], dangling = []) {
  let chain = null; // { taken } = 当前打开的链；null = 没有可延续的链
  for (const child of node.children) {
    if (child.tag === '#text') { if (child.value.trim()) chain = null; out.push(child); continue }
    const attrs = child.attrs;
    const kind = 'wx:if' in attrs ? 'if' : 'wx:elif' in attrs ? 'elif' : 'wx:else' in attrs ? 'else' : null;
    let show = true;
    if (kind === 'if') { chain = { taken: !!wxmlExpr(attrs['wx:if'], data) }; show = chain.taken }
    else if (kind === 'elif') { if (!chain) { dangling.push(child); show = false } else { const v = !!wxmlExpr(attrs['wx:elif'], data); show = !chain.taken && v; chain.taken = chain.taken || v } }
    else if (kind === 'else') { if (!chain) { dangling.push(child); show = false } else { show = !chain.taken; chain.taken = true } }
    else chain = null; // 无条件兄弟终止链
    if (!show) continue;
    const times = 'wx:for' in attrs ? (Array.isArray(wxmlExpr(attrs['wx:for'], data)) ? wxmlExpr(attrs['wx:for'], data).length : 0) : 1;
    for (let i = 0; i < times; i++) { out.push(child); renderWxml(child, data, out, dangling) }
  }
  return out;
}
const isStatusBlock = el => el.tag === 'view' && /(^|\s)status(\s|$)/.test(el.attrs.class || '');
const paintsStatus = el => el.tag === '#text' ? /\{\{\s*status\s*\}\}/.test(el.value)
  : /\{\{\s*status\s*\}\}/.test(Object.values(el.attrs).join(' ')) || el.children.some(paintsStatus);
test('actual guest gate denies both new pages before any knowledge request', () => {
  for (const n of ['knowledge', 'knowledgedetail']) { const f = fixture(n); f.page.onLoad({ id }); f.page.onShow(); assert.equal(f.page.data.gatePassed, false); assert.equal(f.requests.length, 0); assert.equal(f.routes.at(-1), '/pages/login/login') }
});
test('actual onLoad/onShow and revisit require session verification and a fresh list', async () => {
  const f = fixture(); f.login(); f.page.onLoad(); f.page.onShow(); f.page.onShow(); assert.equal(f.requests.filter(r => r.url.includes('/knowledge')).length, 0);
  f.answer(f.last('/auth/session'), { audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() }); f.answerProfile(); await flush();
  f.answer(f.last('/knowledge'), { items: [record()], next_cursor: null }); await flush(); assert.equal(f.page.data.items.length, 1); assert.match(f.page.data.modeNote, /替身/);
  f.page.onHide(); assert.equal(f.page.data.items.length, 0); f.page.onShow(); assert.equal(f.page.data.items.length, 0);
  f.answer(f.last('/auth/session'), { audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() }); f.answerProfile(); await flush(); assert.equal(f.requests.filter(r => r.url.includes('/knowledge')).length, 2);
});
// GY-I05/07（缺口 2-A/2-B/3-A）：档案手选条件必须驱动**首次**查询；档案地区只登记到省级，
// 因此省内档案地区按 330000 查并在页面明示层级 —— 绝不把省级证据说成档案地区的本地适用性。
test('my archived crop and county drive the first query at province level, and the tier is stated', async () => {
  const f = fixture(); f.login(); f.page.onShow();
  f.answer(f.last('/auth/session'), { audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() });
  f.answerProfile({ crop_id: 'crop_rice', region_code: '330102', region_catalog_version: 'mca-xzqh-2023', revision: 2 }); await flush();
  const u = new URL(f.last('/knowledge').url);
  assert.equal(u.searchParams.get('crop_id'), 'crop_rice'); assert.equal(u.searchParams.get('region_code'), '330000');
  assert.equal(f.page.data.profileState, 'applied'); assert.equal(f.page.data.regions[f.page.data.regionIndex].name, '浙江省');
  assert.match(f.page.data.profileNote, /来自我的档案/); assert.match(f.page.data.profileNote, /上城区/);
  assert.match(f.page.data.profileNote, /当前资料只登记到省级，已按浙江省查询/);
  f.answer(f.last('/knowledge'), { items: [record()], next_cursor: null }); await flush(); assert.equal(f.page.data.items.length, 1);
  f.page.pick({ currentTarget: { dataset: { field: 'regionIndex' } }, detail: { value: '2' } });
  assert.equal(f.page.data.profileNote, '', '手选改了地区后不得再声称"来自我的档案"');
});
// 冻结契约把档案 region_code 钉在 ^33[0-9]{4}$（services/api/src/routes/profile.ts:31），
// 真实服务不可能存下省外地区 ⇒ 这里用**合成档案响应**核对页面的防守分支：
// 核不出等级的档案地区 ⇒ 不按 330000 代查，给出去向（可改档案／清空条件）。
test('a profile region outside the covered province is never replaced by the province query', async () => {
  const f = fixture(); f.login(); f.page.onShow();
  f.answer(f.last('/auth/session'), { audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() });
  f.answerProfile({ crop_id: 'crop_rice', region_code: '110101', region_catalog_version: 'mca-xzqh-2023', revision: 2 }); await flush();
  assert.equal(f.requests.filter(r => r.url.includes('/knowledge')).length, 0, '不得代按 330000 自动查询');
  assert.equal(f.page.data.stateKind, 'out-of-coverage'); assert.equal(f.page.data.profileState, 'out-of-coverage');
  assert.match(f.page.data.status, /当前资料仅覆盖浙江省/); assert.match(f.page.data.status, /没有用省级资料代替/);
  assert.doesNotMatch(f.page.data.status, /已按浙江省查询/); assert.match(f.page.data.status, /清空条件继续查询/);
});
// 返修 A：结果区各状态块必须是**唯一一条兄弟链**。修复前 :48 另起一条独立 wx:if，与链头 :45 并列
// ⇒ stateKind='out-of-coverage' 时末行 wx:else 的回退块**一并渲染**：出现两个 .status（与页面顶部
// "保留 .status 供既有 automator 脚本定位"的注释冲突），约 120 字的诚实文案被打印两次。
test('the result area keeps one WXML sibling chain: every state renders exactly one .status block', () => {
  const tree = parseWxml(readFileSync(resolve(root, 'pages/knowledge/knowledge.wxml'), 'utf8'));
  const dangling = [];
  const count = data => {
    const rendered = renderWxml(tree, data, [], dangling).filter(e => e.tag !== '#text');
    return rendered.filter(isStatusBlock);
  };
  for (const stateKind of ['idle', 'ready', 'loading', 'empty', 'error', 'out-of-coverage', 'uncollected']) {
    const blocks = count({ gatePassed: true, status: '合成状态文案', stateKind, items: [], nextCursor: null, profileNote: '', advanced: false });
    assert.equal(blocks.length, 1, `stateKind=${stateKind} 必须恰渲染 1 个 .status 块（多个 ⇒ 独立 wx:if 与回退 wx:else 并列）`);
    assert.equal(blocks.filter(paintsStatus).length, 1, `stateKind=${stateKind} 必须恰打印 1 次 status 文案（不得重复）`);
  }
  assert.equal(count({ gatePassed: false, status: '合成状态文案', stateKind: 'idle', items: [], nextCursor: null, profileNote: '', advanced: false }).length, 1, '游客门禁态也必须恰 1 个 .status 块');
  assert.deepEqual(dangling.map(e => e.tag + '[' + (e.attrs['wx:elif'] || e.attrs['wx:else'] || '') + ']'), [], '不得有悬空的 wx:elif / wx:else（没有同链 wx:if 前驱）');
});
// 返修 B：INVALID_RESPONSE 是 validProfile 的**通用**失败码。反例：档案 region_code='330102'
// （确在浙江省内）但 revision=0 ⇒ 修复前页面断言"核不到你档案里的地区是否在覆盖范围内…可回「我的」
// 改选浙江省内地区"，即**断言了它建立不了的诊断**，还可能引导用户去改一个本来正确的地区。
test('a generic profile contract failure never claims the archived region is out of coverage', async () => {
  const f = fixture(); f.login(); f.page.onShow();
  f.answer(f.last('/auth/session'), { audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() });
  f.answerProfile({ crop_id: 'crop_rice', region_code: '330102', region_catalog_version: 'mca-xzqh-2023', revision: 0 }); await flush();
  assert.equal(f.requests.filter(r => r.url.includes('/knowledge')).length, 0, '核不出档案响应时不得自动查询');
  assert.equal(f.page.data.stateKind, 'out-of-coverage');
  assert.doesNotMatch(f.page.data.status, /核不到你档案里的地区|不在覆盖范围内|改选浙江省内地区/, '不得断言档案地区不在覆盖范围内，也不得让用户改地区');
  // 三条实质陈述仍为真：资料只到省级 / 未用省级资料代查 / 手选出口可用。
  assert.match(f.page.data.status, /当前资料仅覆盖浙江省，只登记到省级（330000）/);
  assert.match(f.page.data.status, /没有用省级资料代替/); assert.match(f.page.data.status, /原因未定/);
  assert.match(f.page.data.status, /清空条件继续查询/);
  f.page.reset(); await flush();
  const u = new URL(f.last('/knowledge').url);
  assert.equal(u.searchParams.get('region_code'), null, '手选出口必须真实可达且不带档案地区');
});
test('an unreadable profile is reported and the conditions are not silently substituted', async () => {
  const f = fixture(); f.login(); f.page.onShow();
  f.answer(f.last('/auth/session'), { audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() });
  f.last('/me/profile').success({ statusCode: 503, data: { error: { code: 'PROVIDER_UNAVAILABLE', message: 'synthetic', retryable: true, details: [] }, meta: envelope(null).meta } }); await flush();
  assert.equal(f.page.data.profileState, 'unread'); assert.match(f.page.data.profileNote, /未能读取我的档案/);
  const u = new URL(f.last('/knowledge').url);
  assert.equal(u.searchParams.get('crop_id'), null); assert.equal(u.searchParams.get('region_code'), null);
});
test('list filters encode only frozen query fields; each cursor page replaces the old one', async () => {
  const f = fixture(); f.login(); f.show(); await flush(); f.answer(f.last('/knowledge'), { items: [record()], next_cursor: 'opaque+/=' }); await flush();
  f.page.next(); assert.equal(f.page.data.items.length, 0); assert.match(f.last('/knowledge').url, /cursor=opaque%2B%2F%3D/);
  const second = record({ id: '44444444-4444-4444-8444-444444444444' }); f.answer(f.last('/knowledge'), { items: [second], next_cursor: null }); await flush(); assert.equal(f.page.data.items.length, 1); assert.equal(f.page.data.items[0].item.id, second.id);
  f.page.input({ currentTarget: { dataset: { field: 'q' } }, detail: { value: '稗草 &水稻' } }); f.page.pick({ currentTarget: { dataset: { field: 'regionIndex' } }, detail: { value: '1' } }); f.page.search();
  const u = new URL(f.last('/knowledge').url); assert.equal(u.searchParams.get('q'), '稗草 &水稻'); assert.equal(u.searchParams.get('region_code'), '330000'); assert.equal(u.searchParams.get('cursor'), null);
});
test('repeated/cyclic cursor is rejected and clears the prior page', async () => {
  const f = fixture(); f.login(); f.show(); await flush(); f.answer(f.last('/knowledge'), { items: [record()], next_cursor: 'A' }); await flush(); f.page.next(); f.answer(f.last('/knowledge'), { items: [record()], next_cursor: 'A' }); await flush(); assert.equal(f.page.data.items.length, 0); assert.match(f.page.data.status, /无法核对/);
});

test('expired/changed cursor clears stale page, preserves session and restarts query without old cursor', async () => {
  const f = fixture(); f.login(); f.page.setData({ q: '合成查询' }); f.show(); await flush();
  f.answer(f.last('/knowledge'), { items: [record()], next_cursor: 'synthetic-expired' }); await flush();
  f.api.remember(record(), { q: '合成查询' });
  f.page.next(); const count = f.requests.length;
  f.last('/knowledge').success({ statusCode: 400, data: { error: { code: 'INVALID_CURSOR', message: 'synthetic', retryable: false, details: [] }, meta: envelope(null).meta } });
  await flush();
  assert.equal(f.page.data.items.length, 0); assert.equal(f.page.data.nextCursor, null);
  assert.equal(f.page.data.busy, false); assert.equal(f.api.expected(id), null);
  assert.match(f.page.data.status, /点击查询重新开始/); assert.equal(f.auth.isLoggedIn(), true);
  assert.equal(f.requests.length, count, 'no automatic stale-cursor retry loop');
  f.page.next(); assert.equal(f.requests.length, count);
  f.page.search(); const url = new URL(f.last('/knowledge').url);
  assert.equal(url.searchParams.get('cursor'), null); assert.equal(url.searchParams.get('q'), '合成查询');
  f.answer(f.last('/knowledge'), { items: [record()], next_cursor: null }); await flush();
  assert.equal(f.page.data.items.length, 1);
});

test('malformed INVALID_CURSOR envelope cannot bypass response validation', async () => {
  for (const patch of [{ contract_version: '0.0.0' }, { execution_mode: 'unknown' }, { request_id: 'bad' }]) {
    const f = fixture(); f.login(); f.show(); await flush();
    f.last('/knowledge').success({ statusCode: 400, data: { error: { code: 'INVALID_CURSOR', message: 'synthetic', retryable: false, details: [] }, meta: { ...envelope(null).meta, ...patch } } });
    await flush(); assert.equal(f.page.data.items.length, 0); assert.match(f.page.data.status, /无法核对/);
  }
});
test('older query completion and completion after hide cannot repopulate results', async () => {
  const f = fixture(); f.login(); f.show(); await flush(); const old = f.last('/knowledge'); f.page.search(); const newer = f.last('/knowledge'); f.answer(newer, { items: [], next_cursor: null }); await flush(); f.answer(old, { items: [record()], next_cursor: null }); await flush(); assert.equal(f.page.data.items.length, 0); assert.match(f.page.data.status, /没有/);
  f.page.search(); const pending = f.last('/knowledge'); f.page.onHide(); f.answer(pending, { items: [record()], next_cursor: null }); await flush(); assert.equal(f.page.data.items.length, 0); assert.equal(f.page.data.gatePassed, false);
});
test('in-flight logout and a different or re-established token reject old client success', async () => {
  for (const mode of ['logout', 'different', 'same']) { const f = fixture(); f.login(); const p = f.api.list({ limit: 20 }); const r = f.last('/knowledge');
    if (mode === 'logout') f.auth.logout(() => {}); else { f.auth.clearSession(); f.login(mode === 'same' ? 'synthetic-token' : 'other-token') }
    f.answer(r, { items: [record()], next_cursor: null }); await assert.rejects(p, e => e.code === 'SESSION_CHANGED');
  }
});
test('old 401 cannot clear a newer identity; current 403 invalidates session and page', async () => {
  const f = fixture(); f.login(); const p = f.api.list({}); const old = f.last('/knowledge'); f.login('other-token'); f.answer(old, {}, 401); await assert.rejects(p, e => e.code === 'SESSION_CHANGED'); assert.equal(f.auth.getSession().accessToken, 'other-token');
  f.show(); await flush(); f.answer(f.last('/knowledge'), {}, 403); await flush(); assert.equal(f.auth.getSession(), null); assert.equal(f.page.data.items.length, 0); assert.equal(f.page.data.gatePassed, false); assert.match(f.page.data.status, /登录/);
});
for (const status of [404, 503, 500]) test('list HTTP ' + status + ' clears previously shown results without static fallback', async () => { const f = fixture(); f.login(); f.show(); await flush(); f.answer(f.last('/knowledge'), { items: [record()], next_cursor: null }); await flush(); f.page.search(); assert.equal(f.page.data.items.length, 0); f.answer(f.last('/knowledge'), {}, status); await flush(); assert.equal(f.page.data.items.length, 0); assert.equal(f.page.data.busy, false); });
test('network failure clears detail and retry performs a new GET', async () => {
  const f = fixture('knowledgedetail'); f.login(); f.show({ id }); f.answer(f.last('/knowledge/'), record()); await flush(); assert.ok(f.page.data.item); assert.match(f.page.data.conditionsText, /条件资料不足/); f.page.retry(); assert.equal(f.page.data.item, null); f.last('/knowledge/').fail({ errMsg: 'private transport content' }); await flush(); assert.equal(f.page.data.item, null); assert.match(f.page.data.status, /网络/); assert.doesNotMatch(f.page.data.status, /private/); const before = f.requests.length; f.page.retry(); assert.equal(f.requests.length, before + 1);
});
for (const validity of ['withdrawn', 'expired', 'conflicting', 'unknown']) test('detail ' + validity + ' never retains body or source', async () => { const f = fixture('knowledgedetail'); f.login(); f.show({ id }); const r = record(); r.source.validity = validity; f.answer(f.last('/knowledge/'), r); await flush(); assert.equal(f.page.data.item, null); assert.equal(f.page.data.labels, null); assert.match(f.page.data.status, /失效/); });
test('source id/version/updated_at or Knowledge revision changes invalidate list-to-detail snapshot', async () => {
  for (const kind of ['id', 'version', 'updated_at', 'revision']) { const f = fixture('knowledgedetail'); f.login(); f.api.remember(record(), { crop_id: 'crop_rice', q: 'q' }); f.show({ id }); const r = record();
    if (kind === 'revision') r.revision = 2; else r.source[kind] = kind === 'id' ? '55555555-5555-4555-8555-555555555555' : kind === 'version' ? 'synthetic-v2' : '2026-10-11T02:00:00Z';
    assert.match(f.last('/knowledge/').url, /crop_id=crop_rice/); assert.doesNotMatch(f.last('/knowledge/').url, /q=/); f.answer(f.last('/knowledge/'), r); await flush(); assert.equal(f.page.data.item, null); assert.match(f.page.data.status, /已变化/);
  }
});
test('matching source tuple displays exact body, honest research/unverified/simulation labels and source link', async () => {
  const f = fixture('knowledgedetail'); f.login(); f.api.remember(record(), {}); f.show({ id }); f.answer(f.last('/knowledge/'), record()); await flush(); assert.equal(f.page.data.item.source.version, 'synthetic-v1'); assert.equal(f.page.data.labels.evidence, '科研来源'); assert.equal(f.page.data.labels.review, '未核对'); assert.equal(f.page.data.labels.source, '模拟资料'); f.page.copySource(); assert.equal(f.clips[0], record().source.url); f.auth.clearSession(); f.login('different-token'); f.page.copySource(); assert.equal(f.clips.length, 1);
});
test('direct detail does not reuse another identity selection; hidden data and late back are inert', async () => {
  const f = fixture('knowledgedetail'); f.login(); f.api.remember(record(), { crop_id: 'crop_rice' }); f.auth.clearSession(); f.login('different-token'); f.show({ id }); assert.doesNotMatch(f.last('/knowledge/').url, /crop_id/);
  const pending = f.last('/knowledge/'); f.page.back(); const back = f.wx.back; f.page.onHide(); f.answer(pending, record()); back.fail(); await flush(); assert.equal(f.page.data.item, null); assert.equal(f.routes.length, 0);
});
test('valid detail cold back has a fixed list fallback; malformed ID still goes through gate', async () => {
  const f = fixture('knowledgedetail'); f.login(); f.show({ id: '%' }); assert.equal(f.requests.filter(r => r.url.includes('/knowledge')).length, 0); assert.match(f.page.data.status, /格式/); f.page.back(); f.wx.back.fail(); assert.equal(f.routes.at(-1), '/pages/knowledge/knowledge');
});
test('knowledge return-to navigation accepts UUID only, never extra identity/redirect params', () => {
  const f = fixture(); const target = '/pages/knowledgedetail/knowledgedetail?id=' + id; assert.equal(f.nav.normalizeTarget(target), target); assert.equal(f.nav.normalizeTarget('/pages/knowledge/knowledge'), '/pages/knowledge/knowledge');
  for (const p of [target + '&token=x', target + '&redirect=x', target.replace(id, 'not-uuid'), '/pages/knowledge/knowledge?role=admin']) assert.equal(f.nav.normalizeTarget(p), null);
});
const malformed = [
 ['extra source_version', r => r.source_version = 'invented'], ['missing body', r => delete r.body], ['array ID', r => r.id = [id]], ['bad revision', r => r.revision = 0],
 ['unknown type', r => r.type = 'prescription'], ['unknown source kind', r => r.source.source_kind = 'unknown'], ['unknown evidence', r => r.source.evidence_kind = 'expert'], ['bad source URL', r => r.source.url = 'http://example.test'],
 ['invalid updated_at', r => r.source.updated_at = 'yesterday'], ['missing timestamp zone', r => r.source.updated_at = '2026-10-11T01:00:00'], ['invalid calendar date', r => r.source.updated_at = '2026-02-31T01:00:00Z'], ['nullable condition field', r => r.conditions = { crop_id: 'crop_rice', region_code: null }], ['extra condition', r => r.conditions = { crop_id: 'crop_rice', region_code: '330102', owner: 'x' }],
 ['nonempty dose cards', r => r.dose_cards = [{}]], ['duplicate records', () => {}], ['unavailable list record', r => r.reference_state = 'unavailable'], ['rejected source', r => r.source.review_status = 'rejected']
];
for (const [name, mutate] of malformed) test('rejects ' + name + ' instead of displaying unchecked content', async () => { const f = fixture(); f.login(); const p = f.api.list({ limit: 20 }); const r = record(); mutate(r); f.answer(f.last('/knowledge'), { items: name === 'duplicate records' ? [r, r] : [r], next_cursor: null }); await assert.rejects(p); });
test('invalid filters and IDs are rejected before network; no client identity or schema drift', async () => {
  const f = fixture(); f.login(); const before = f.requests.length;
  for (const q of [{ q: '' }, { q: 'x'.repeat(81) }, { region_code: '440000' }, { limit: 0 }, { limit: 51 }, { limit: '20' }, { cursor: 'x'.repeat(2049) }, { user_id: 'x' }]) await assert.rejects(f.api.list(q), e => e.code === 'INVALID_INPUT');
  await assert.rejects(f.api.detail('not-uuid', {})); await assert.rejects(f.api.detail(id, { q: 'x' })); assert.equal(f.requests.length, before);
});
test('wrong detail identity and wrong contract metadata are rejected', async () => {
  const f = fixture(); f.login(); const p = f.api.detail(id, {}); f.answer(f.last('/knowledge/'), record({ id: '44444444-4444-4444-8444-444444444444' })); await assert.rejects(p, e => e.code === 'INVALID_RESPONSE');
  for (const patch of [{ contract_version: '2.0.0' }, { execution_mode: 'local_stub' }, { request_id: [id] }]) { const p = f.api.list({}); const body = envelope({ items: [], next_cursor: null }); Object.assign(body.meta, patch); f.last('/knowledge').success({ statusCode: 200, data: body }); await assert.rejects(p, e => e.code === 'INVALID_RESPONSE') }
});

// ---- GY-I07／差距侦察 3-B：把"恒空条件"变成**可解释**状态 ----
// growth_stage／planting_method／use_scene 任一非空时，服务端可见性过滤**必然**返回 0 条
// （services/api/src/knowledge/service.ts:64 注释 "Current schema has no stage/method/scene evidence"、
// :66 的 `&& !filter.growth_stage && !filter.planting_method && !filter.use_scene`）⇒ 原因是
// **当前资料未采集该维度**，不是"没有符合条件的资料"。修复前页面只给泛化空态
// "没有符合条件的资料，请调整条件继续查询。" ⇒ 用户无法分辨"真的没有"与"资料没采集"（本切片要消灭的误导）。
// 服务端行为不变：条件仍原样发出，服务端仍返回空。
const pageWxml = () => parseWxml(readFileSync(resolve(root, 'pages/knowledge/knowledge.wxml'), 'utf8'));
const renderPage = data => renderWxml(pageWxml(), data, [], []).filter(e => e.tag !== '#text');
const mustache = (raw, data) => { const m = /^\{\{([\s\S]*)\}\}$/.exec(String(raw).trim()); return m ? wxmlExpr(m[1], data) : String(raw) };
const nodeText = (el, data) => mustache(el.children.filter(c => c.tag === '#text').map(c => c.value).join(''), data);
const stateViews = data => renderPage(data).filter(e => e.tag === 'state-view');
test('a filled condition dimension is named as not collected instead of a generic empty result', async () => {
  const f = fixture(); f.login(); f.show(); await flush();
  f.answer(f.last('/knowledge'), { items: [record()], next_cursor: null }); await flush();
  f.page.input({ currentTarget: { dataset: { field: 'growth_stage' } }, detail: { value: '幼苗期' } }); f.page.search();
  const u = new URL(f.last('/knowledge').url);
  assert.equal(u.searchParams.get('growth_stage'), '幼苗期', '服务端行为不变：条件仍原样发出（服务端仍返回空）');
  assert.equal(f.page.data.stateKind, 'loading'); const pending = f.last('/knowledge');
  f.answer(pending, { items: [], next_cursor: null }); await flush();
  assert.equal(f.page.data.stateKind, 'uncollected', '条件维度非空 + 空结果 ⇒ 必须是"未采集"这一类，不是泛化空态');
  assert.match(f.page.data.status, /当前资料未采集生育期条件/);
  assert.doesNotMatch(f.page.data.status, /^没有符合条件的资料/);
  // 用户看到的是 wxml 渲染出来的文案，不只是 data 字段。
  const views = stateViews(f.page.data);
  assert.equal(views.length, 1, '结果区恰 1 个 state-view');
  assert.equal(views[0].attrs.title, '当前资料未采集该条件');
  assert.match(String(mustache(views[0].attrs.desc, f.page.data)), /当前资料未采集生育期条件/);
  assert.equal(views[0].attrs['action-text'], '清空该条件继续查询');
  assert.ok(!renderPage(f.page.data).some(e => e.tag === 'state-view' && /^没有符合条件的资料/.test(e.attrs.title || '')), '不得同时渲染泛化空态标题');
});
test('the region picker states the province-only tier and never claims local coverage', () => {
  const f = fixture(); const d = f.page.data; const page = Object.assign({}, d, { gatePassed: true });
  assert.match(d.regionNote, /^地区筛选仅浙江省级（330000）/, '地区说明必须点名"仅浙江省级（330000）"');
  assert.match(d.regionNote, /当前资料只登记到省级/, '与 #168 的档案提示同一口径（只到省级）');
  const rendered = renderPage(page);
  const notes = rendered.filter(e => /(^|\s)region-note(\s|$)/.test(e.attrs.class || ''));
  assert.equal(notes.length, 1, 'wxml 必须渲染恰 1 条 .region-note');
  assert.equal(nodeText(notes[0], page), d.regionNote);
  // 说明必须紧邻地区选择器（在其后），且在结果区之前 —— 否则"下拉有说明"对用户不成立。
  const order = rendered.indexOf(notes[0]);
  assert.ok(order > rendered.findIndex(e => e.tag === 'picker' && e.attrs['data-field'] === 'regionIndex'), '.region-note 必须在地区选择器之后');
  assert.ok(order < rendered.findIndex(isStatusBlock), '.region-note 必须在结果区之前');
  // 目录仍保留市／县（说明存在的理由）；说明本身不得暗示"资料已覆盖到市／县"。
  assert.ok(d.regions.some(r => r.code === '330100') && d.regions.some(r => r.code === '330102'));
  assert.doesNotMatch(d.regionNote, /已覆盖|已登记到市|已登记到县|本地适用/);
});
test('clearing just the uncollected dimensions restores the previous query and keeps other filters', async () => {
  const f = fixture(); f.login(); f.show(); await flush();
  f.answer(f.last('/knowledge'), { items: [record()], next_cursor: null }); await flush();
  f.page.pick({ currentTarget: { dataset: { field: 'cropIndex' } }, detail: { value: '1' } });
  f.page.input({ currentTarget: { dataset: { field: 'growth_stage' } }, detail: { value: '幼苗期' } });
  f.page.input({ currentTarget: { dataset: { field: 'use_scene' } }, detail: { value: '稻田除草' } });
  f.page.search();
  let u = new URL(f.last('/knowledge').url);
  assert.equal(u.searchParams.get('crop_id'), 'crop_rice'); assert.equal(u.searchParams.get('growth_stage'), '幼苗期'); assert.equal(u.searchParams.get('use_scene'), '稻田除草');
  f.answer(f.last('/knowledge'), { items: [], next_cursor: null }); await flush();
  assert.equal(f.page.data.stateKind, 'uncollected');
  assert.match(f.page.data.status, /当前资料未采集生育期条件；当前资料未采集使用场景条件/, '每个被填的维度都要点名');
  assert.match(f.page.data.status, /清空该条件继续查询/);
  f.page.clearUncollected();
  u = new URL(f.last('/knowledge').url);
  assert.equal(u.searchParams.get('growth_stage'), null, '清空该条件后不得再带该条件');
  assert.equal(u.searchParams.get('use_scene'), null);
  assert.equal(u.searchParams.get('crop_id'), 'crop_rice', '其余条件保持不变');
  assert.equal(f.page.data.growth_stage + f.page.data.planting_method + f.page.data.use_scene, '');
  f.answer(f.last('/knowledge'), { items: [record()], next_cursor: null }); await flush();
  assert.equal(f.page.data.stateKind, 'ready'); assert.equal(f.page.data.items.length, 1);
  assert.doesNotMatch(f.page.data.status, /未采集/, '清空后回到原有查询文案');
});
test('no invented "not collected" state: genuine empty results and blank input keep the generic copy', async () => {
  const f = fixture(); f.login(); f.show(); await flush();
  f.answer(f.last('/knowledge'), { items: [], next_cursor: null }); await flush();
  assert.equal(f.page.data.stateKind, 'empty', '三个条件都没填 ⇒ 仍是既有泛化空态');
  assert.equal(f.page.data.status, '没有符合条件的资料，请调整条件继续查询。');
  assert.equal(stateViews(f.page.data)[0].attrs.title, '没有符合条件的资料');
  assert.doesNotMatch(f.page.data.status, /未采集/);
  // 已采集的维度（关键词）非空但无结果 ⇒ 不得谎称"未采集"。
  f.page.setData({ q: '合成查询' }); f.page.search();
  assert.equal(new URL(f.last('/knowledge').url).searchParams.get('q'), '合成查询');
  f.answer(f.last('/knowledge'), { items: [], next_cursor: null }); await flush();
  assert.equal(f.page.data.stateKind, 'empty'); assert.doesNotMatch(f.page.data.status, /未采集/);
  // 纯空白不算"填了条件"（conditions() trim 后根本不发该条件）。
  f.page.input({ currentTarget: { dataset: { field: 'growth_stage' } }, detail: { value: '   ' } }); f.page.search();
  assert.equal(new URL(f.last('/knowledge').url).searchParams.get('growth_stage'), null);
  f.answer(f.last('/knowledge'), { items: [], next_cursor: null }); await flush();
  assert.equal(f.page.data.stateKind, 'empty'); assert.doesNotMatch(f.page.data.status, /未采集/);
});
test('a filled dimension never masks real results as "not collected"', async () => {
  const f = fixture(); f.login(); f.show(); await flush();
  f.answer(f.last('/knowledge'), { items: [], next_cursor: null }); await flush();
  f.page.input({ currentTarget: { dataset: { field: 'planting_method' } }, detail: { value: ' 移栽 ' } }); f.page.search();
  assert.equal(new URL(f.last('/knowledge').url).searchParams.get('planting_method'), '移栽', 'trim 后发出，与 conditions() 一致');
  f.answer(f.last('/knowledge'), { items: [record()], next_cursor: null }); await flush();
  assert.equal(f.page.data.stateKind, 'ready'); assert.equal(f.page.data.items.length, 1);
  assert.doesNotMatch(f.page.data.status, /未采集/, '有结果时不得声称资料未采集该维度');
});
