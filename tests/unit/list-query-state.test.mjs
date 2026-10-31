// GY-R72（W8）· `GET /herbicides` 列表判定 `query_state` 的 HTTP 面 + 契约面回归。
//
// 缺陷（本片要钉住的）：
//   `packages/reference/query.mjs` 的 `runQuery()` 早就算好了 `match_state`/`reasons`/`total`…，
//   但 API 层 `services/api/src/knowledge/reference-query.ts` 只把 `{data, etag}` 往外递，
//   `query_state` 被**静默丢弃** ⇒ 小程序只能按 `items.length` 猜 `matched`/`no_match`，
//   于是「资料未标注」被谎报成「没有资料」。
//
// 本文件钉四件事：
//   ① 判定真值三态各一条（`matched` / `no_match` / `insufficient`），且同为空列表时必须可区分；
//   ② `QueryState` 字段集合 = `queryStateOf()` 实际产出的字段集合（**从源码读**，不抄文档/契约）；
//   ③ `query_state` 在 `HerbicidePage.required` 里（不是可选装饰）；
//   ④ 真实 200 响应整个封套通过冻结 schema，`match_state` 落在闭集内；
//   ⑤ `total` 是裁剪/分页**前**的领域判定（本页 7 条时仍是 20），不是本页条数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';

const here = (rel) => new URL(rel, import.meta.url);
const openapi = JSON.parse(readFileSync(here('../../packages/contracts/openapi.json'), 'utf8'));
const schemas = openapi.components.schemas;
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js');
const SESSION_KEY = 'synthetic-session-signing-key-0123456789';
const MATCH_STATES = ['matched', 'no_match', 'insufficient'];

/** 从 `packages/reference/service.mjs` 的 `queryStateOf()` 源码里读字段名——不抄文档、不抄契约。 */
function queryStateFieldsFromSource() {
  const source = readFileSync(here('../../packages/reference/service.mjs'), 'utf8');
  const start = source.indexOf('function queryStateOf');
  assert.ok(start > 0, 'service.mjs 里找不到 queryStateOf()：字段集合的源头没了，别拿文档替代');
  const body = source.slice(start, source.indexOf('\n}', start));
  const fields = [...body.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]);
  assert.ok(fields.length >= 6, `queryStateOf() 解析到 ${fields.length} 个字段（少于 6）：解析逻辑或源码形状变了`);
  return fields;
}

/** 真实 Fastify 实例 + 合成登录（内存 auth store，不连库、不连真 PG）。 */
async function host() {
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: SESSION_KEY });
  const store = createMemoryAuthStore();
  const app = buildApp({ config, store, idempotency: createMemoryIdempotencyStore() });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/wechat',
    headers: { 'idempotency-key': 'idem-key-000001' },
    payload: { code: 'synthetic-r72' }
  });
  assert.equal(login.statusCode, 200, '合成登录必须成功（否则后续断言测的不是列表接口）');
  const token = login.json().data.access_token;
  const get = async (url) => {
    const res = await app.inject({ method: 'GET', url: '/api/v1' + url, headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: res.json() };
  };
  return { app, get };
}

test('① 判定真值三态：同一接口按条件返回 matched / no_match / insufficient，判定与理由必须对得上', async () => {
  const { app, get } = await host();
  try {
    const matched = await get('/herbicides?limit=20');
    assert.equal(matched.status, 200);
    assert.deepEqual(matched.body.data.query_state, {
      match_state: 'matched',
      total: 20,
      reasons: [],
      unmatched_reasons: [],
      simulated_excluded: 0,
      matched_dimensions: []
    });

    const none = await get('/herbicides?q=zzz-no-such-herbicide');
    assert.equal(none.status, 200);
    assert.equal(none.body.data.items.length, 0);
    assert.equal(none.body.data.query_state.match_state, 'no_match');
    assert.deepEqual(none.body.data.query_state.reasons, ['现有资料均不满足所选条件']);
    assert.deepEqual(none.body.data.query_state.matched_dimensions, ['q']);
    assert.equal(none.body.data.query_state.total, 0);
    assert.equal(none.body.data.query_state.simulated_excluded, 0);
    assert.equal(none.body.data.query_state.unmatched_reasons.length, 10, '未命中原因按记录列出（至多 10 条）');
    for (const entry of none.body.data.query_state.unmatched_reasons) {
      assert.deepEqual(Object.keys(entry).sort(), ['reasons', 'record_id']);
      assert.deepEqual(entry.reasons, ['关键词不匹配']);
    }

    // `region_code` 是服务端接受的合法参数（客户端本片仍不提交，见 knowledge-api.js 注释）。
    // 资料零条标注适用地区 ⇒ 只能判 `insufficient`（无法确认），**不得**判成 `no_match`（没有资料）。
    const unmarked = await get('/herbicides?region_code=330100');
    assert.equal(unmarked.status, 200);
    const state = unmarked.body.data.query_state;
    assert.deepEqual(unmarked.body.data.items, none.body.data.items, '两条空列表看起来一样，正因如此判定才必须区分');
    assert.equal(state.match_state, 'insufficient', '未标注 ≠ 不满足');
    assert.deepEqual(state.reasons, ['部分条件在资料中未标注，无法确认适用性']);
    assert.deepEqual(state.matched_dimensions, ['region_code']);
    assert.equal(state.total, 0);
    for (const entry of state.unmatched_reasons) {
      assert.deepEqual(entry.reasons, ['记录未标注适用地区，无法确认是否适用该地区']);
    }
    assert.notEqual(none.body.data.query_state.match_state, state.match_state, '同一空列表，两种判定必须可区分');
  } finally {
    await app.close();
  }
});

test('② QueryState 字段集合 = service.mjs 的 queryStateOf() 实际字段（从源码读），API 输出不多不少', async () => {
  const { app, get } = await host();
  try {
    const fields = queryStateFieldsFromSource();
    const schema = schemas.QueryState;
    assert.ok(schema, 'openapi 缺 QueryState 组件');
    assert.deepEqual(Object.keys(schema.properties).sort(), [...fields].sort(), '契约字段与 queryStateOf() 产出必须逐字段相同');
    assert.deepEqual([...schema.required].sort(), [...fields].sort(), '六个字段全是必填（缺一个都算静默降级）');
    assert.equal(schema.additionalProperties, false, '闭集：契约外的字段不许出现');

    const { body } = await get('/herbicides?limit=7');
    assert.deepEqual(Object.keys(body.data.query_state).sort(), [...fields].sort(), 'API 输出必须逐字段等于 queryStateOf() 产出（不多、不少）');
  } finally {
    await app.close();
  }
});

test('③ 契约：HerbicidePage 必填 query_state；match_state 是三值闭集；未命中原因逐条 record_id+reasons', async () => {
  assert.deepEqual(schemas.HerbicidePage.required, ['items', 'next_cursor', 'query_state']);
  assert.deepEqual(schemas.HerbicidePage.properties.query_state, { $ref: '#/components/schemas/QueryState' });
  assert.equal(schemas.HerbicidePage.additionalProperties, false);
  assert.deepEqual(schemas.QueryState.properties.match_state.enum, MATCH_STATES);
  assert.deepEqual(schemas.QueryState.properties.unmatched_reasons.items.required, ['record_id', 'reasons']);
  assert.equal(schemas.QueryState.properties.unmatched_reasons.items.additionalProperties, false);
  assert.equal(schemas.QueryState.properties.unmatched_reasons.maxItems, 10);
  assert.equal(schemas.QueryState.properties.total.minimum, 0);
  assert.equal(schemas.QueryState.properties.simulated_excluded.minimum, 0);
  // `/herbicides` 200 仍指向同一个封套（没有偷偷换成新 envelope）。
  assert.deepEqual(
    openapi.paths['/herbicides'].get.responses['200'].content['application/json'].schema,
    { $ref: '#/components/schemas/HerbicidePageEnvelope' }
  );
});

test('④ 真实 200 响应通过冻结 HerbicidePageEnvelope（Ajv 2020 直接校验整个封套，不只是顶层键）', async () => {
  const { app, get } = await host();
  try {
    const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
    ajv.addSchema(openapi, 'openapi');
    const validate = ajv.compile({ $ref: 'openapi#/components/schemas/HerbicidePageEnvelope' });
    for (const url of [
      '/herbicides?limit=20',
      '/herbicides?q=%E6%B0%B4%E7%A8%BB',
      '/herbicides?q=zzz-no-such-herbicide',
      '/herbicides?region_code=330100',
      '/herbicides?registration_number=PD20161371'
    ]) {
      const res = await get(url);
      assert.equal(res.status, 200, `${url} 应 200`);
      assert.ok(validate(res.body), `${url} 不满足冻结封套：${JSON.stringify((validate.errors || []).slice(0, 4))}`);
      assert.equal(
        MATCH_STATES.includes(res.body.data.query_state.match_state),
        true,
        `${url} 的 match_state 必须落在闭集内（当前：${res.body.data.query_state.match_state}）`
      );
      assert.deepEqual(Object.keys(res.body).sort(), ['data', 'meta'], `${url} 封套只允许 data/meta`);
    }
  } finally {
    await app.close();
  }
});

test('⑤ 口径：query_state.total 是裁剪/分页前的领域判定 —— 本页 7 条时 total 仍为 20', async () => {
  const { app, get } = await host();
  try {
    const page = await get('/herbicides?limit=7');
    assert.equal(page.status, 200);
    assert.equal(page.body.data.items.length, 7);
    assert.equal(typeof page.body.data.next_cursor, 'string', '还有下一页（游标按过滤前派生）');
    // 口径同 services/api/src/routes/knowledge.ts 的 filterVisiblePage() 注释：
    //   `items` = 当前可见集；`total`/`match_state`/`reasons` = **裁剪前**领域判定。
    // 两者不等只说明「有记录不在本页 / 你看不到」，**不**说明「没有资料」——
    // 所以 total 不许等于本页条数，也不许随分页变化。
    assert.equal(page.body.data.query_state.total, 20, 'total 不得等于本页条数');
    assert.equal(page.body.data.query_state.match_state, 'matched');

    const second = await get('/herbicides?limit=7&cursor=' + encodeURIComponent(page.body.data.next_cursor));
    assert.equal(second.status, 200);
    assert.equal(second.body.data.query_state.total, 20, '翻页不得改写判定');
    assert.equal(second.body.data.query_state.match_state, 'matched');
  } finally {
    await app.close();
  }
});
