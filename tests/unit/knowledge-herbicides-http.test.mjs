// GY-I07（#7）· 科普／除草剂查询 + 详情 + 来源版本展示的 **HTTP 面** 回归。
//
// 覆盖：
//   A. `/herbicides`、`/herbicides/{id}`（此前 route_mounted=false）——消费已合入的真实
//      登记公告记录（packages/reference + packages/knowledge），校验冻结契约形状、
//      分页/游标、错误码、越权与负例（不得出现任何用量/DoseCard 字段）。
//   B. `/knowledge` 并入**浙江首批真实资料**（未发布/未核对）——如实带出
//      `source.review_status='unverified'`、零用量卡；默认关闭、real 模式硬拒。
//
// 说明：A 段不需要数据库；B 段用**脚本化假连接池**只回答既有读服务会发出的那几条 SQL
// （不连真库、不写生产库、不伪造身份：身份来自内存 auth store 的合成登录）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { toSeedRows } from '../../services/api/src/knowledge/reference-query.ts';
import { loadZhejiangKnowledge } from '../../packages/reference/index.mjs';

const contract = JSON.parse(
  readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'),
);
const schemas = contract.components.schemas;
const IDEM = 'idem-key-000001';
const SESSION_KEY = 'synthetic-session-signing-key-0123456789';
const SEED_FLAG = 'APP_KNOWLEDGE_UNVERIFIED_SEED';

const HERBICIDE_REQUIRED = ['id', 'revision', 'formulation', 'source', 'risk_text', 'reference_state'];
const SOURCE_REQUIRED = ['id', 'version', 'title', 'url', 'publisher', 'source_kind', 'evidence_kind', 'validity', 'review_status', 'updated_at'];
const KNOWLEDGE_REQUIRED = ['id', 'revision', 'type', 'title', 'body', 'source', 'conditions', 'reference_state', 'dose_cards'];
const FORMULATION_REQUIRED = ['id', 'registration_number', 'producer', 'dosage_form', 'ingredients'];
const INGREDIENT_REQUIRED = ['name', 'content_text', 'unit_text'];

function stubConfig() {
  return loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: SESSION_KEY });
}

/** 只回答既有知识读服务实际发出的 SQL；不连真库、不落任何数据。 */
function scriptedPool({ store, rows }) {
  const client = {
    async query(text, values) {
      const sql = String(text);
      if (sql.includes('FROM public.users')) {
        const user = await store.getUser(String(values?.[0] ?? ''));
        return { rows: user ? [{ state: user.state, auth_epoch: user.authEpoch }] : [] };
      }
      if (sql.includes('public.sessions')) return { rows: [{ id: 'synthetic-session' }] };
      if (sql.includes('catalog_read.current_knowledge')) return { rows };
      return { rows: [] };
    },
    release() {},
  };
  return { async connect() { return client; }, async query() { return { rows: [] }; } };
}

async function newApp({ executionMode = 'stub' } = {}) {
  const base = stubConfig();
  const config = executionMode === 'real'
    ? { ...base, logLevel: 'silent', executionMode: 'real', requiresRealCredentials: true }
    : base;
  const store = createMemoryAuthStore();
  const app = buildApp({ config, store, idempotency: createMemoryIdempotencyStore() });
  const token = await login(app);
  return { app, store, token };
}

/** 真实模式下的合成会话：不经微信端点（真实模式不会回退替身身份）。 */
async function syntheticSession(store) {
  const token = 'synthetic-i07-real-mode-token';
  const user = await store.createUser('synthetic-i07-real-mode-lookup');
  await store.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3_600_000),
    audience: 'user',
  });
  return token;
}

async function login(app, code = 'synthetic-i07') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/wechat',
    headers: { 'idempotency-key': IDEM },
    payload: { code },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data.access_token;
}

function get(app, url, token) {
  return app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
}

/** 按冻结契约逐键校验一条 `Herbicide`（additionalProperties:false）。 */
function assertHerbicideContract(item, where) {
  assert.deepEqual(Object.keys(item).sort(), [...HERBICIDE_REQUIRED].sort(), `Herbicide 额外/缺失键：${where}`);
  assert.match(item.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(Number.isInteger(item.revision) && item.revision >= 1, true);
  assert.equal(schemas.ReferenceState.enum.includes(item.reference_state), true);
  assert.equal(typeof item.risk_text === 'string' && item.risk_text.length >= 1 && item.risk_text.length <= 4000, true);

  const f = item.formulation;
  assert.deepEqual(Object.keys(f).sort(), [...FORMULATION_REQUIRED].sort(), `Formulation 额外/缺失键：${where}`);
  assert.match(f.id, /^[0-9a-f-]{36}$/);
  assert.equal(f.registration_number.length >= 1 && f.registration_number.length <= 80, true);
  assert.equal(f.producer.length >= 1 && f.producer.length <= 200, true);
  assert.equal(f.dosage_form.length >= 1 && f.dosage_form.length <= 80, true);
  assert.equal(Array.isArray(f.ingredients) && f.ingredients.length >= 1 && f.ingredients.length <= 20, true);
  for (const ing of f.ingredients) {
    assert.deepEqual(Object.keys(ing).sort(), [...INGREDIENT_REQUIRED].sort(), `Ingredient 额外/缺失键：${where}`);
    for (const v of Object.values(ing)) assert.equal(typeof v === 'string' && v.length >= 1 && v.length <= 80, true);
  }

  const s = item.source;
  assert.deepEqual(Object.keys(s).sort(), [...SOURCE_REQUIRED].sort(), `SourceRef 额外/缺失键：${where}`);
  assert.equal(schemas.SourceKind.enum.includes(s.source_kind), true);
  assert.equal(schemas.EvidenceKind.enum.includes(s.evidence_kind), true);
  assert.equal(schemas.SourceRef.properties.validity.enum.includes(s.validity), true);
  assert.equal(schemas.SourceRef.properties.review_status.enum.includes(s.review_status), true);
  assert.match(s.url, new RegExp(schemas.SourceRef.properties.url.pattern), `SourceRef.url 非 https：${where}`);
  assert.equal(s.updated_at, new Date(s.updated_at).toISOString());
}

/** 契约 Knowledge（additionalProperties:false）逐键校验。 */
function assertKnowledgeContract(item, where) {
  assert.deepEqual(Object.keys(item).sort(), [...KNOWLEDGE_REQUIRED].sort(), `Knowledge 额外/缺失键：${where}`);
  assert.equal(schemas.Knowledge.properties.type.enum.includes(item.type), true);
  assert.equal(schemas.ReferenceState.enum.includes(item.reference_state), true);
  assert.equal(item.conditions, null);
  assert.deepEqual(item.dose_cards, []);
  const s = item.source;
  assert.deepEqual(Object.keys(s).sort(), [...SOURCE_REQUIRED].sort(), `SourceRef 额外/缺失键：${where}`);
  assert.equal(schemas.SourceRef.properties.review_status.enum.includes(s.review_status), true);
  assert.equal(schemas.SourceRef.properties.validity.enum.includes(s.validity), true);
  assert.match(s.url, new RegExp(schemas.SourceRef.properties.url.pattern));
}

// ---------------------------------------------------------------------------
// A. /herbicides、/herbicides/{id}
// ---------------------------------------------------------------------------

test('/herbicides 与 /herbicides/{id} 未登录一律 401 SESSION_REQUIRED（不泄露是否存在）', async () => {
  const { app } = await newApp();
  try {
    for (const url of ['/api/v1/herbicides', '/api/v1/herbicides/00000000-0000-4000-8000-000000000001']) {
      const res = await get(app, url, null);
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error.code, 'SESSION_REQUIRED');
    }
    const bad = await get(app, '/api/v1/herbicides', 'not-a-real-token');
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json().error.code, 'SESSION_EXPIRED');
  } finally { await app.close(); }
});

test('/herbicides 列表：契约封套/实体形状对齐、no-store、列表不带 ETag、真实来源可追溯', async () => {
  const { app, token } = await newApp();
  try {
    const res = await get(app, '/api/v1/herbicides', token);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['etag'], undefined, '契约说明：列表无 ETag');
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['data', 'meta']);
    assert.deepEqual(Object.keys(body.data).sort(), ['items', 'next_cursor', 'query_state']);
    assert.deepEqual(Object.keys(body.meta).sort(), ['contract_version', 'execution_mode', 'request_id']);
    assert.equal(body.meta.contract_version, '1.0.0');
    assert.equal(body.meta.execution_mode, 'stub');
    assert.equal(body.data.next_cursor, null);
    // 判定真值随响应下发（契约 QueryState，六字段全必填）。无筛选条件 + 20 条全命中 ⇒ 逐字段写死，
    // 不写「只要存在」：这是"服务端真的算过并如实说出"的判据。
    assert.deepEqual(body.data.query_state, {
      match_state: 'matched',
      total: 20,
      reasons: [],
      unmatched_reasons: [],
      simulated_excluded: 0,
      matched_dimensions: []
    });

    const items = body.data.items;
    assert.equal(items.length, 20, '已合入的真实登记公告记录 20 条');
    for (const [i, item] of items.entries()) assertHerbicideContract(item, `items[${i}]`);

    // 禁止出现任何用量/DoseCard 语义字段（契约 Herbicide 没有，也不许自造）。
    for (const item of items) {
      for (const key of Object.keys(item)) assert.doesNotMatch(key, /dose|dose_card|usable_as|card_ready|original_text/, `非法字段：${key}`);
      assert.doesNotMatch(item.risk_text, /^\s*用量/, 'risk_text 不得冒充用量说明');
    }

    // 来源可追溯：https 来源 + 版本 + 发布方 + 取得时间。
    for (const item of items) {
      assert.match(item.source.url, /^https:\/\//);
      assert.equal(item.source.publisher.length > 0, true);
      assert.match(item.source.version, /^src_/);
    }
    // **不按模糊药名合并**：同源版本下多条记录各自独立（同 version 多记录）。
    const byVersion = new Map();
    for (const item of items) byVersion.set(item.source.version, (byVersion.get(item.source.version) ?? 0) + 1);
    assert.equal([...byVersion.values()].some((n) => n > 1), true, '同一来源版本下应有多条独立制剂记录');
    assert.equal(new Set(items.map((i) => i.formulation.id)).size, items.length, '制剂身份不得重复/合并');
    assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  } finally { await app.close(); }
});

test('/herbicides/{id} 详情：与列表同一条实体、强 ETag、来源版本一致', async () => {
  const { app, token } = await newApp();
  try {
    const list = (await get(app, '/api/v1/herbicides', token)).json().data.items;
    const first = list[0];
    const res = await get(app, `/api/v1/herbicides/${first.id}`, token);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['etag'], /^"sv-\d+-[0-9a-f]{32}"$/, '强 ETag 由记录身份 × source_version 派生');
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['data', 'meta']);
    assert.deepEqual(body.data, first, '列表与详情必须返回同一条实体');
    assertHerbicideContract(body.data, 'detail');
    // 详情 ETag 与列表集合 ETag 不同（列表不带 ETag，此处仅断言详情 ETag 稳定可复现）。
    const again = await get(app, `/api/v1/herbicides/${first.id}`, token);
    assert.equal(again.headers['etag'], res.headers['etag']);
  } finally { await app.close(); }
});

test('/herbicides 错误码：未知 id 404、非法 id/参数 400、游标非法 400、无结果 200 空', async () => {
  const { app, token } = await newApp();
  try {
    const missing = await get(app, '/api/v1/herbicides/00000000-0000-4000-8000-000000000000', token);
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'NOT_FOUND');

    for (const url of ['/api/v1/herbicides/not-a-uuid', '/api/v1/herbicides?q=', '/api/v1/herbicides?limit=51', '/api/v1/herbicides?owner_id=other', '/api/v1/herbicides?cursor=broken']) {
      const res = await get(app, url, token);
      assert.equal(res.statusCode, 400, `${url} 应为 400`);
      assert.equal(['INVALID_REQUEST', 'INVALID_CURSOR'].includes(res.json().error.code), true);
    }
    // 详情不接受任何查询参数（契约无 query 参数）。
    const list = (await get(app, '/api/v1/herbicides', token)).json().data.items;
    const extra = await get(app, `/api/v1/herbicides/${list[0].id}?crop_id=crop_rice`, token);
    assert.equal(extra.statusCode, 400);
    assert.equal(extra.json().error.code, 'INVALID_REQUEST');

    // 无结果 = 200 + 空列表 + next_cursor null（不是错误，也不伪造记录）。
    const none = await get(app, '/api/v1/herbicides?q=zzz-no-such-herbicide', token);
    assert.equal(none.statusCode, 200);
    const empty = none.json().data;
    assert.deepEqual(Object.keys(empty).sort(), ['items', 'next_cursor', 'query_state']);
    assert.deepEqual(empty.items, []);
    assert.equal(empty.next_cursor, null);
    // 判定不许由客户端猜：`no_match` 由服务端给出，含义是"条件都核对过、确实不匹配"，
    // 不是"资料没标注所以不知道"（后者必须是 `insufficient`，见下一段）。
    assert.equal(empty.query_state.match_state, 'no_match');
    assert.equal(empty.query_state.total, 0);
    assert.deepEqual(empty.query_state.reasons, ['现有资料均不满足所选条件']);
    assert.deepEqual(empty.query_state.matched_dimensions, ['q']);
    assert.equal(empty.query_state.simulated_excluded, 0);
    // 未命中原因逐条带记录身份（最多 10 条），理由只能是"关键词不匹配"，不许混进"未标注"。
    assert.deepEqual(
      empty.query_state.unmatched_reasons.map((entry) => entry.record_id),
      Array.from({ length: 10 }, (_v, i) => `gy-i03-hb-${String(i + 1).padStart(3, '0')}`)
    );
    for (const entry of empty.query_state.unmatched_reasons) {
      assert.deepEqual(entry.reasons, ['关键词不匹配']);
    }

    // 同一个"空结果"，理由不同则判定必须不同：零标注的地区条件 ⇒ insufficient（无法确认），
    // **不是** no_match（"看不到适用性" ≠ "资料不适用"）。客户端据此选"未标注"文案。
    const unknown = await get(app, '/api/v1/herbicides?region_code=330100', token);
    assert.equal(unknown.statusCode, 200);
    const undecided = unknown.json().data;
    assert.deepEqual(undecided.items, []);
    assert.equal(undecided.query_state.match_state, 'insufficient');
    assert.equal(undecided.query_state.total, 0);
    assert.deepEqual(undecided.query_state.reasons, ['部分条件在资料中未标注，无法确认适用性']);
    assert.deepEqual(undecided.query_state.matched_dimensions, ['region_code']);
    assert.equal(undecided.query_state.simulated_excluded, 0);
    assert.equal(undecided.query_state.unmatched_reasons.length, 10);
    for (const entry of undecided.query_state.unmatched_reasons) {
      assert.deepEqual(entry.reasons, ['记录未标注适用地区，无法确认是否适用该地区']);
    }
  } finally { await app.close(); }
});

test('/herbicides 查询与分页：登记号收窄、q 关键词、limit=1 逐页取尽', async () => {
  const { app, token } = await newApp();
  try {
    const all = (await get(app, '/api/v1/herbicides', token)).json().data.items;
    const target = all[3];
    const byReg = (await get(app, `/api/v1/herbicides?registration_number=${target.formulation.registration_number}`, token)).json().data.items;
    assert.equal(byReg.length, 1);
    assert.equal(byReg[0].id, target.id);

    const byName = (await get(app, '/api/v1/herbicides?q=莠去津', token)).json().data.items;
    assert.equal(byName.length > 0, true);
    for (const item of byName) {
      assert.equal(item.formulation.ingredients.some((ing) => ing.name === '莠去津'), true, '关键词命中必须真的在有效成分中');
    }

    const seen = [];
    let cursor = null;
    for (let page = 0; page < 30; page += 1) {
      const url = `/api/v1/herbicides?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const data = (await get(app, url, token)).json().data;
      assert.equal(data.items.length, 1);
      seen.push(data.items[0].id);
      cursor = data.next_cursor;
      if (cursor === null) break;
    }
    assert.equal(cursor, null);
    assert.deepEqual(seen, all.map((i) => i.id), '逐页取尽且顺序稳定一致');
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------
// B. /knowledge 消费浙江首批真实资料（未发布/未核对）
// ---------------------------------------------------------------------------

test('/knowledge 默认不并入浙江首批：开关关闭时列表仍为空（不把未发布内容默认放行）', async () => {
  const store = createMemoryAuthStore();
  const app = buildApp({ config: stubConfig(), store, idempotency: createMemoryIdempotencyStore(), pool: scriptedPool({ store, rows: [] }) });
  try {
    const token = await login(app);
    const res = await get(app, '/api/v1/knowledge', token);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data, { items: [], next_cursor: null });
  } finally { await app.close(); }
});

test('/knowledge 显式放行 + 空库：真实消费浙江首批（未核对如实呈现、零用量卡、来源可复核）', async () => {
  const store = createMemoryAuthStore();
  process.env[SEED_FLAG] = '1';
  let app;
  try {
    app = buildApp({ config: stubConfig(), store, idempotency: createMemoryIdempotencyStore(), pool: scriptedPool({ store, rows: [] }) });
  } finally {
    delete process.env[SEED_FLAG];
  }
  try {
    const token = await login(app);
    const res = await get(app, '/api/v1/knowledge?limit=50', token);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['etag'], undefined);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['data', 'meta']);
    assert.deepEqual(Object.keys(body.data).sort(), ['items', 'next_cursor']);
    const items = body.data.items;
    assert.equal(items.length, 50);
    assert.equal(typeof body.data.next_cursor, 'string', '159 条 > limit=50，必须有下一页游标');

    for (const [i, item] of items.entries()) {
      assertKnowledgeContract(item, `seed-items[${i}]`);
      assert.equal(item.source.review_status, 'unverified', '不得把未核对当已核对');
      assert.equal(item.source.validity, 'valid');
      assert.equal(item.source.source_kind, 'verified_seed');
      assert.deepEqual(item.dose_cards, []);
      assert.equal(item.conditions, null);
      // 未发布（private）没有契约字段：不得自造 visibility/published/private 等额外键。
      for (const key of Object.keys(item)) assert.doesNotMatch(key, /visibility|published|private|unverified|seed/, `自造字段：${key}`);
      for (const key of Object.keys(item.source)) assert.doesNotMatch(key, /visibility|reviewed_|published/, `自造来源字段：${key}`);
      // 可复核来源在 body 内（不靠不可解析 URL 冒充来源）。
      assert.match(item.body, /来源定位（可复核）：file=/);
      assert.match(item.body, /row_sha256/);
      assert.match(item.body, /不生成用量卡片/);
      assert.match(item.source.url, /^https:\/\/example\.invalid\//);
    }

    // 详情与列表同一条实体（同一 id 可查、内容一致）。
    const detail = await get(app, `/api/v1/knowledge/${items[0].id}`, token);
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.headers['etag'], '"1"');
    assert.deepEqual(detail.json().data, items[0]);
    assertKnowledgeContract(detail.json().data, 'seed-detail');
  } finally { await app.close(); }
});

test('/knowledge 结构与条件过滤：省级命中、县区/未采集条件不命中、无结果 200 空、详情 404', async () => {
  const store = createMemoryAuthStore();
  process.env[SEED_FLAG] = '1';
  let app;
  try {
    app = buildApp({ config: stubConfig(), store, idempotency: createMemoryIdempotencyStore(), pool: scriptedPool({ store, rows: [] }) });
  } finally { delete process.env[SEED_FLAG]; }
  try {
    const token = await login(app);
    const count = async (query) => (await get(app, `/api/v1/knowledge?limit=50${query}`, token)).json().data.items.length;
    assert.equal(await count('&region_code=330000') > 0, true, '省级 330000 命中');
    assert.equal(await count('&region_code=330102'), 0, '清单只有省级证据，不猜县区归属');
    assert.equal(await count('&crop_id=crop_rice') > 0, true);
    assert.equal(await count('&crop_id=missing'), 0);
    for (const key of ['growth_stage', 'planting_method', 'use_scene']) {
      assert.equal(await count(`&${key}=unknown`), 0, `${key} 未采集即不命中（不丢弃条件继续展示）`);
    }
    const none = await get(app, '/api/v1/knowledge?q=zzz-no-such-item', token);
    assert.equal(none.statusCode, 200);
    assert.deepEqual(none.json().data, { items: [], next_cursor: null });

    // 详情：命中的 id 可查；不存在的 id 404 且与列表一致（列表里没有就不会有详情）。
    const sea = (await get(app, '/api/v1/knowledge?q=稗', token)).json().data.items;
    assert.equal(sea.length > 0, true);
    assert.equal((await get(app, `/api/v1/knowledge/${sea[0].id}`, token)).statusCode, 200);
    const ghost = await get(app, '/api/v1/knowledge/00000000-0000-4000-8000-000000000000', token);
    assert.equal(ghost.statusCode, 404);
    assert.equal(ghost.json().error.code, 'NOT_FOUND');
    // 未采集条件在**详情**同样不放过（列表与详情一致）。
    assert.equal((await get(app, `/api/v1/knowledge/${sea[0].id}?growth_stage=unknown`, token)).statusCode, 404);
  } finally { await app.close(); }
});

test('/knowledge real 执行模式硬拒：即使开关打开也不并入未发布/未核对种子', async () => {
  const store = createMemoryAuthStore();
  const base = stubConfig();
  const config = { ...base, logLevel: 'silent', executionMode: 'real', requiresRealCredentials: true };
  process.env[SEED_FLAG] = '1';
  let app;
  try {
    app = buildApp({ config, store, idempotency: createMemoryIdempotencyStore(), pool: scriptedPool({ store, rows: [] }) });
  } finally { delete process.env[SEED_FLAG]; }
  try {
    const token = await syntheticSession(store);
    const res = await get(app, '/api/v1/knowledge', token);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data, { items: [], next_cursor: null });
    assert.equal(res.json().meta.execution_mode, 'real');
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------
// C. 读路径故障 ⇒ `retryable` 按 `errors.ts:28-40` 的口径**逐码**分档，不整条 catch 一律置位。
//
//   瞬时（同一请求稍后重试可能成功）：`57014`（statement_timeout）/ `55P03`
//   （lock_not_available）⇒ **504** `PROVIDER_TIMEOUT` 且 `retryable === true`；
//   其余数据库故障（权限 42501 / 缺表 42P01 / 库不存在 3D000 / 凭据 28P01 / 无法归类）
//   需运维介入，时间不会让它自愈 ⇒ **503** `PROVIDER_UNAVAILABLE` 且 `retryable === false`。
//
//   改前：catch 分支未传 `retryable`（`ApiError` 默认 `false`）⇒ 504 也报"不可重试"，
//   客户端会把一次 4 秒锁超时当成永久故障而不再重试。
// ---------------------------------------------------------------------------

/** 在 `catalog_read.current_knowledge` 处抛指定驱动错误；只回答会话校验的那两条 SQL，不连真库。 */
function failingPool({ store, error }) {
  const client = {
    async query(text, values) {
      const sql = String(text);
      if (sql.includes('FROM public.users')) {
        const user = await store.getUser(String(values?.[0] ?? ''));
        return { rows: user ? [{ state: user.state, auth_epoch: user.authEpoch }] : [] };
      }
      if (sql.includes('public.sessions')) return { rows: [{ id: 'synthetic-session' }] };
      if (sql.includes('catalog_read.current_knowledge')) throw error;
      return { rows: [] };
    },
    release() {},
  };
  return { async connect() { return client; }, async query() { return { rows: [] }; } };
}

/** 驱动错误替身：`code` 为 SQLSTATE，消息里带连接串原文供"不得泄露"断言使用。 */
const driverError = (code) => Object.assign(new Error('PRIVATE_DSN postgres://u:p@10.0.0.9/db'), { code });

async function readWithFailingPool(code) {
  const store = createMemoryAuthStore();
  const app = buildApp({
    config: stubConfig(),
    store,
    idempotency: createMemoryIdempotencyStore(),
    pool: failingPool({ store, error: driverError(code) }),
  });
  try {
    const token = await login(app);
    return await get(app, '/api/v1/knowledge', token);
  } finally { await app.close(); }
}

test('/knowledge 读路径：57014 与 55P03 是瞬时竞争态 ⇒ 504 PROVIDER_TIMEOUT 且 retryable:true', async () => {
  for (const code of ['57014', '55P03']) {
    const res = await readWithFailingPool(code);
    assert.equal(res.statusCode, 504, `${code} 应映射 504`);
    const body = res.json();
    assert.equal(body.error.code, 'PROVIDER_TIMEOUT');
    assert.equal(body.error.retryable, true, `${code} 同一请求稍后重试可能成功 ⇒ retryable 必须为 true`);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(JSON.stringify(body).includes('PRIVATE_DSN'), false, '不得把驱动原文/连接串带进封套');
    // 封套形状仍守契约闭集（不因本片新增/丢失字段）。
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'details', 'message', 'retryable']);
  }
});

test('/knowledge 读路径：其余数据库故障需运维介入 ⇒ 503 PROVIDER_UNAVAILABLE 且 retryable:false（负控制）', async () => {
  for (const code of ['42501', '42P01', '3D000', '28P01', 'XX000', undefined]) {
    const res = await readWithFailingPool(code);
    assert.equal(res.statusCode, 503, `${String(code)} 应映射 503`);
    const body = res.json();
    assert.equal(body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(body.error.retryable, false, `${String(code)} 重试不会成功 ⇒ 不得劝客户端重试`);
    assert.equal(JSON.stringify(body).includes('PRIVATE_DSN'), false);
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'details', 'message', 'retryable']);
  }
});

test('负例·失效(expired/withdrawn/conflicting/unknown)与下架(hidden/deleted)条目退出有效查询', () => {
  const items = loadZhejiangKnowledge().items;
  assert.equal(toSeedRows(items).length, 159);
  for (const [field, value] of [['validity', 'expired'], ['validity', 'withdrawn'], ['validity', 'conflicting'], ['validity', 'unknown'], ['visibility', 'hidden'], ['visibility', 'deleted']]) {
    const mutated = items.map((item, index) => (index === 0 ? { ...item, [field]: value } : item));
    const rows = toSeedRows(mutated);
    assert.equal(rows.length, 158, `${field}=${value} 应退出查询面`);
    assert.equal(rows.some((row) => row.id === items[0].knowledge.id), false);
  }
  // 未发布（private）本身**不**被丢弃：它由显式接线开关控制，逐条仍标注未核对。
  assert.equal(items[0].visibility, 'private');
  assert.equal(toSeedRows(items).length, 159);
});
