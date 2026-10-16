// Real loopback HTTP transport + actual protected client; synthetic service/identity/data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url), { createFixture, ID, item } = require('./knowledge-http-fixture.cjs');
const f = createFixture(); await new Promise(r => f.server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + f.server.address().port + '/api/v1';
let token = f.token, epoch = 1; const auth = { getSession: () => token ? { accessToken: token } : null, isLoggedIn: () => !!token, networkEnabled: () => true, sessionEpoch: () => epoch, clearSession: () => { token = null; epoch++ } };
const box = { exports: {} }; const wx = { request: o => { fetch(o.url, { method: o.method, headers: o.header }).then(async r => o.success({ statusCode: r.status, data: await r.json() })).catch(() => o.fail({})) } };
// 依赖按**完整说明符**登记，不做 else 兜底：未登记（新增 require）⇒ 显式失败并带依赖名，而不是静默喂 `{ apiBaseUrl }` 空壳。
const knowledgeApiDependencies = new Map([['./auth', auth], ['../config/runtime', { apiBaseUrl: base }]]);
vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/knowledge-api.js', import.meta.url), 'utf8'), { module: box, wx, require: p => { if (!knowledgeApiDependencies.has(p)) throw Error('Unexpected page dependency ' + p); return knowledgeApiDependencies.get(p); } }); const api = box.exports;
try {
 const p = await api.list({ q: '稗草 &水稻', crop_id: 'crop_rice', region_code: '330102', limit: 20 }); assert.equal(p.items[0].id, ID); assert.equal(p.mode, 'stub'); assert.equal(f.requests.at(-1).query.q, '稗草 &水稻');
 api.remember(p.items[0], { crop_id: 'crop_rice' }); const d = await api.detail(ID, { crop_id: 'crop_rice' }); assert.equal(api.fingerprint(d.item), api.expected(ID).fingerprint); assert.equal(d.item.conditions, null); assert.equal(d.item.dose_cards.length, 0);
 f.state.version = 'synthetic-v2'; const changed = await api.detail(ID, {}); assert.notEqual(api.fingerprint(changed.item), api.expected(ID).fingerprint);
 f.state.withdrawn = true; await assert.rejects(api.detail(ID, {}), e => e.code === 'NOT_FOUND'); assert.equal((await api.list({})).items.length, 0); f.state.withdrawn = false;
 assert.equal((await api.list({ q: '无结果' })).items.length, 0); assert.equal((await api.list({ growth_stage: '未采集' })).items.length, 0); await assert.rejects(api.detail(ID, { planting_method: '未采集' }), e => e.code === 'NOT_FOUND');
 const first = await api.list({ q: '分页' }); const second = await api.list({ q: '分页', cursor: first.nextCursor }); assert.equal(second.nextCursor, null); assert.notEqual(second.items[0].id, first.items[0].id);
 f.state.expiredCursor = true;
 await assert.rejects(api.list({ q: '分页', cursor: first.nextCursor }), e => e.code === 'INVALID_CURSOR' && /点击查询重新开始/.test(api.message(e)));
 assert.equal(token, f.token); assert.ok((await api.list({ q: '分页' })).nextCursor); assert.equal(f.requests.at(-1).query.cursor, undefined);
 f.state.expiredCursor = false;
 await assert.rejects(api.list({ q: '服务失败' }), e => e.code === 'UNAVAILABLE'); token = 'invalid-synthetic'; await assert.rejects(api.list({}), e => e.code === 'SESSION_REQUIRED'); assert.equal(token, null);
 console.log('PASS 9 loopback HTTP groups; actual client; synthetic identity/data/server; no production API or PG claim');
} finally { await new Promise(r => f.server.close(r)) }
