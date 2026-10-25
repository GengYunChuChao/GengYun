// Real loopback HTTP transport + actual protected client; synthetic service/identity/data.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url), { createFixture, ID, item } = require('./knowledge-http-fixture.cjs');
const f = createFixture(); await new Promise(r => f.server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + f.server.address().port + '/api/v1';
let token = f.token, epoch = 1;
// 401/403 归因的**真实**实现在 `miniprogram/utils/auth.js`（GY-I04 单一事实源）。
// 本夹具只替换「会话存储」这一个外部边界（token/epoch 探针），归因逻辑仍走真实模块：
//   `attribution(statusCode, payload)` 是纯函数（只读 `utils/states.js` 的码表）；
//   `failureFor` 用真实归因判定「是否该清会话」，再把清会话落回本文件的探针。
// 夹具**不自带码表**：若这里缺 `attribution`/`failureFor`，401/403 分支会在 `wx` 垫片里抛
// TypeError 并被 `.catch` 吞成 NETWORK_UNCERTAIN —— 那是夹具缺项，不是产品行为。
const realAuth = createRequire(import.meta.url)('../../miniprogram/utils/auth.js');
const clearProbe = () => { token = null; epoch++; };
const auth = {
  getSession: () => token ? { accessToken: token } : null,
  isLoggedIn: () => !!token,
  networkEnabled: () => true,
  sessionEpoch: () => epoch,
  clearSession: clearProbe,
  attribution: (statusCode, payload) => realAuth.attribution(statusCode, payload),
  failureFor: (makeFailure, statusCode, payload) => {
    const verdict = realAuth.attribution(statusCode, payload);
    if (verdict.clearsSession) clearProbe();
    const error = makeFailure(verdict.code);
    error.status = verdict.status;
    error.retryable = verdict.retryable;
    return error;
  }
};
const box = { exports: {} }; const wx = { request: o => { fetch(o.url, { method: o.method, headers: o.header }).then(async r => o.success({ statusCode: r.status, data: await r.json() })).catch(() => o.fail({})) } };
// 依赖按**完整说明符**登记，不做 else 兜底：未登记（新增 require）⇒ 显式失败并带依赖名，而不是静默喂 `{ apiBaseUrl }` 空壳。
const knowledgeApiDependencies = new Map([['./auth', auth], ['../config/runtime', { apiBaseUrl: base }]]);
vm.runInNewContext(readFileSync(new URL('../../miniprogram/utils/knowledge-api.js', import.meta.url), 'utf8'), { module: box, wx, require: p => { if (!knowledgeApiDependencies.has(p)) throw Error('Unexpected page dependency ' + p); return knowledgeApiDependencies.get(p); } }); const api = box.exports;
// ---- P0：详情与列表**逐字段一致** + `source` 深等 -----------------------------------------
// 深度对齐 `tests/integration/user-chain-e2e.mjs:473-476`（那条断言只在需真 PG 的 `user-chain-e2e.mjs`
// 里，而该文件有**未接任何 CI** 的缺口，见 `tests/unit/ci-integration-chain-structure.test.mjs` 的
// `UNWIRED_DECLARATIONS`）⇒ 搬进这条已接 `test:integration:http` 的回环脚本。
// 弱版只比 `api.fingerprint`（`miniprogram/utils/knowledge-api.js:64`）：指纹取 id/revision + source 十键，
// **不含** type/title/body/reference_state/conditions/dose_cards，也看不见 source 上是否多出键。
// 真实回归面在客户端边界：`list()` 原样返回 `p.items`、`detail()` 原样返回 `r.data`
// （`knowledge-api.js:102` / `:110`）——任一侧开始做投影裁剪，指纹仍相等而字段已经不同。
// `validItem` 的闭集校验（`knowledge-api.js:13-16`、`:45-54`）保证两侧键集相同，深等才不是同义反复。
const DETAIL_FIELDS = ['id', 'revision', 'type', 'title', 'body', 'reference_state', 'conditions', 'dose_cards'];
// `source` 逐键覆盖 `SourceRef` 的全部十键：id/version/title/url/publisher/source_kind/evidence_kind/
// validity/review_status/updated_at —— 含与详情 `revision` **不同源**的 `source.version`。
function sameAsList(detailItem, listItem) {
  DETAIL_FIELDS.forEach(field => assert.deepEqual(detailItem[field], listItem[field], `详情 ${field} 必须与列表逐字段一致`));
  assert.deepEqual(detailItem.source, listItem.source, '详情 source 必须与列表逐字段一致（含 version/validity/review_status）');
}
try {
 const p = await api.list({ q: '稗草 &水稻', crop_id: 'crop_rice', region_code: '330102', limit: 20 }); assert.equal(p.items[0].id, ID); assert.equal(p.mode, 'stub'); assert.equal(f.requests.at(-1).query.q, '稗草 &水稻');
 api.remember(p.items[0], { crop_id: 'crop_rice' }); const d = await api.detail(ID, { crop_id: 'crop_rice' }); assert.equal(api.fingerprint(d.item), api.expected(ID).fingerprint); assert.equal(d.item.conditions, null); assert.equal(d.item.dose_cards.length, 0);
 sameAsList(d.item, p.items[0]);
 // 负控制：同一份夹具、同一个查询条件，只把**详情**的标题换掉 ⇒ 旧判据（指纹）仍相等，
 // 逐字段断言必须红 —— 否则上面那条「逐字段一致」就是恒真，P0 又变回弱版。
 f.state.divergentTitle = true; const gapList = await api.list({ q: '稗草 &水稻' }), gapDetail = await api.detail(ID, {});
 assert.equal(api.fingerprint(gapDetail.item), api.expected(ID).fingerprint);
 assert.throws(() => sameAsList(gapDetail.item, gapList.items[0]), /详情 title 必须与列表逐字段一致/);
 f.state.divergentTitle = false; sameAsList((await api.detail(ID, {})).item, gapList.items[0]);
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
