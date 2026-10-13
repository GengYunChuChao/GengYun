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
  function login(token = 'synthetic-token') { auth.login(() => {}); answer(last('/auth/wechat'), { access_token: token, audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() }) }
  function show(options = {}) { page.options = options; page.onLoad(options); page.onShow(); const r = last('/auth/session'); if (r) answer(r, { audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() }) }
  return { page, wx, requests, routes, clips, auth, api, nav, answer, login, show, last };
}
test('actual guest gate denies both new pages before any knowledge request', () => {
  for (const n of ['knowledge', 'knowledgedetail']) { const f = fixture(n); f.page.onLoad({ id }); f.page.onShow(); assert.equal(f.page.data.gatePassed, false); assert.equal(f.requests.length, 0); assert.equal(f.routes.at(-1), '/pages/login/login') }
});
test('actual onLoad/onShow and revisit require session verification and a fresh list', async () => {
  const f = fixture(); f.login(); f.page.onLoad(); f.page.onShow(); f.page.onShow(); assert.equal(f.requests.filter(r => r.url.includes('/knowledge')).length, 0);
  f.answer(f.last('/auth/session'), { audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() });
  f.answer(f.last('/knowledge'), { items: [record()], next_cursor: null }); await flush(); assert.equal(f.page.data.items.length, 1); assert.match(f.page.data.modeNote, /替身/);
  f.page.onHide(); assert.equal(f.page.data.items.length, 0); f.page.onShow(); assert.equal(f.page.data.items.length, 0);
  f.answer(f.last('/auth/session'), { audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() }); assert.equal(f.requests.filter(r => r.url.includes('/knowledge')).length, 2);
});
test('list filters encode only frozen query fields; each cursor page replaces the old one', async () => {
  const f = fixture(); f.login(); f.show(); f.answer(f.last('/knowledge'), { items: [record()], next_cursor: 'opaque+/=' }); await flush();
  f.page.next(); assert.equal(f.page.data.items.length, 0); assert.match(f.last('/knowledge').url, /cursor=opaque%2B%2F%3D/);
  const second = record({ id: '44444444-4444-4444-8444-444444444444' }); f.answer(f.last('/knowledge'), { items: [second], next_cursor: null }); await flush(); assert.equal(f.page.data.items.length, 1); assert.equal(f.page.data.items[0].item.id, second.id);
  f.page.input({ currentTarget: { dataset: { field: 'q' } }, detail: { value: '稗草 &水稻' } }); f.page.pick({ currentTarget: { dataset: { field: 'regionIndex' } }, detail: { value: '1' } }); f.page.search();
  const u = new URL(f.last('/knowledge').url); assert.equal(u.searchParams.get('q'), '稗草 &水稻'); assert.equal(u.searchParams.get('region_code'), '330000'); assert.equal(u.searchParams.get('cursor'), null);
});
test('repeated/cyclic cursor is rejected and clears the prior page', async () => {
  const f = fixture(); f.login(); f.show(); f.answer(f.last('/knowledge'), { items: [record()], next_cursor: 'A' }); await flush(); f.page.next(); f.answer(f.last('/knowledge'), { items: [record()], next_cursor: 'A' }); await flush(); assert.equal(f.page.data.items.length, 0); assert.match(f.page.data.status, /无法核对/);
});

test('expired/changed cursor clears stale page, preserves session and restarts query without old cursor', async () => {
  const f = fixture(); f.login(); f.page.setData({ q: '合成查询' }); f.show();
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
    const f = fixture(); f.login(); f.show();
    f.last('/knowledge').success({ statusCode: 400, data: { error: { code: 'INVALID_CURSOR', message: 'synthetic', retryable: false, details: [] }, meta: { ...envelope(null).meta, ...patch } } });
    await flush(); assert.equal(f.page.data.items.length, 0); assert.match(f.page.data.status, /无法核对/);
  }
});
test('older query completion and completion after hide cannot repopulate results', async () => {
  const f = fixture(); f.login(); f.show(); const old = f.last('/knowledge'); f.page.search(); const newer = f.last('/knowledge'); f.answer(newer, { items: [], next_cursor: null }); await flush(); f.answer(old, { items: [record()], next_cursor: null }); await flush(); assert.equal(f.page.data.items.length, 0); assert.match(f.page.data.status, /没有/);
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
  f.show(); f.answer(f.last('/knowledge'), {}, 403); await flush(); assert.equal(f.auth.getSession(), null); assert.equal(f.page.data.items.length, 0); assert.equal(f.page.data.gatePassed, false); assert.match(f.page.data.status, /登录/);
});
for (const status of [404, 503, 500]) test('list HTTP ' + status + ' clears previously shown results without static fallback', async () => { const f = fixture(); f.login(); f.show(); f.answer(f.last('/knowledge'), { items: [record()], next_cursor: null }); await flush(); f.page.search(); assert.equal(f.page.data.items.length, 0); f.answer(f.last('/knowledge'), {}, status); await flush(); assert.equal(f.page.data.items.length, 0); assert.equal(f.page.data.busy, false); });
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
