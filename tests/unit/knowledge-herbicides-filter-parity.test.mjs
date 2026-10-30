// GY-R71 · 切片 #8「过滤面对齐」：`/herbicides` 补 `crop_id` / `region_code`（与 `/knowledge` **同名同义**）。
//
// 判据分层（强→弱）：
//   ① **集合相等**（硬判据）：同一份语料下，同一组过滤条件在两个读面命中的 id 集合必须相等；
//   ② **敏感性**（防"判据空转"）：故意让一个语料行只在一个面存在 ⇒ 判据必须变红；
//   ③ **非法值**：不支持/非法取值 ⇒ 4xx + 契约错误码闭集（不静默忽略、不返回 200 空集）；
//   ④ **未给参数的等价性**：无参（及既有 q / registration_number）响应与改前 `8b646ae1` **逐字节相同**。
//
// 语料与身份全部合成/仓内种子：不连真库、不外呼、不落任何真实个人信息。
// 两个读面用**真实回环 HTTP**（`app.listen({port:0})` 动态空闲口），不使用 `inject`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';
import { ERROR_STATUS_MAP } from '../../services/api/src/contract.ts';

const here = (path) => new URL(path, import.meta.url);
const RECORDS_JSON = JSON.parse(readFileSync(here('../../packages/knowledge/herbicides/records-2026.json'), 'utf8'));
/** 仓内真实登记公告记录（20 条）；这是两个读面**共同的语料**。 */
const RECORDS = Array.isArray(RECORDS_JSON)
  ? RECORDS_JSON
  : (RECORDS_JSON.records ?? RECORDS_JSON.items ?? Object.values(RECORDS_JSON)[0]);
/** 改前（`8b646ae1`）无新增过滤参数时的响应快照，证明"未给参数 ⇒ 逐字节同行为"。 */
const GOLDEN = JSON.parse(readFileSync(here('../fixtures/herbicides-list-baseline-8b646ae1.json'), 'utf8'));

const SESSION_KEY = 'synthetic-session-signing-key-0123456789';
const IDEM = 'idem-key-000001';

/** 只回答既有知识读服务实际发出的那几条 SQL；不连真库、不落任何数据。 */
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

/**
 * 把**同一批**除草剂记录投影成 `catalog_read.current_knowledge` 同形行。
 *
 * 投影只复制记录自身已有的结构化条件（`crop_ids` / `region_codes` / `species_ids`），
 * **不补、不猜**：记录未标注地区就投影成空数组 —— 于是 `/knowledge` 的
 * `region_codes.includes(...)` 与 `/herbicides` 的「未标注即不命中」在同一份数据上是同一条谓词。
 */
function projectRows(listItems) {
  const byRegistration = new Map(RECORDS.map((record) => [record.registration_number, record]));
  return listItems.map((item) => {
    const record = byRegistration.get(item.formulation.registration_number);
    assert.ok(record, `投影失败：登记号 ${item.formulation.registration_number} 不在语料里`);
    return {
      id: item.id,
      revision: 1,
      created_at: item.source.updated_at,
      type: 'species',
      title: `合成投影 ${record.record_id}`,
      body: `合成投影正文：${record.use_scene ?? ''}`,
      crop_ids: record.crop_ids ?? [],
      species_ids: record.species_ids ?? [],
      region_codes: record.region_codes ?? [],
      source_id: item.source.id,
      source_version: item.source.version,
      source_title: item.source.title,
      url: item.source.url,
      publisher: item.source.publisher,
      source_kind: item.source.source_kind,
      evidence_kind: item.source.evidence_kind,
      updated_at: item.source.updated_at,
      review_status: 'unverified',
      validity: 'valid',
    };
  });
}

/** 起一个回环 HTTP 宿主（动态空闲口），两个读面共用同一个 app。 */
async function host({ rows }) {
  const store = createMemoryAuthStore();
  const config = loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: SESSION_KEY });
  const app = buildApp({ config, store, idempotency: createMemoryIdempotencyStore(), pool: scriptedPool({ store, rows }) });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(`${origin}/api/v1/auth/wechat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': IDEM },
      body: JSON.stringify({ code: 'synthetic-r71-herbfilter' }),
    });
    assert.equal(login.status, 200);
    const token = (await login.json()).data.access_token;
    const get = async (path) => {
      const res = await fetch(`${origin}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: await res.json(), port: app.server.address().port };
    };
    return { app, get, origin };
  } catch (error) {
    // 失败也要释放监听口，否则失败路径会把事件循环吊住（门禁变成挂起而不是变红）。
    await app.close();
    throw error;
  }
}

/**
 * 取「两读面共同语料」：`/herbicides` 的全量记录（只作语料源，不做断言）。
 *
 * 每次都用 `finally` 关宿主：断言失败时**不得**遗留监听中的服务（否则 `--test` 挂起而非报红）。
 */
async function sharedCorpus() {
  const probe = await host({ rows: [] });
  let corpus;
  try {
    corpus = await probe.get('/herbicides?limit=50');
  } finally {
    await probe.app.close();
  }
  return corpus;
}

const idsOf = (body) => body.data.items.map((item) => item.id).sort();
const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** 把过滤条件表变成两条读面各自的 URL（参数名必须**字面相同**，这是本片的对齐点）。 */
const FILTERS = [
  { label: '无条件', query: '' },
  { label: 'crop_id=crop_rice', query: '&crop_id=crop_rice' },
  { label: 'crop_id=crop_corn', query: '&crop_id=crop_corn' },
  { label: 'crop_id=crop_soybean', query: '&crop_id=crop_soybean' },
  { label: 'crop_id=crop_rapeseed', query: '&crop_id=crop_rapeseed' },
  // 目录内 4 个作物（crop_rice / crop_corn / crop_soybean / crop_rapeseed）全部在语料里出现，
  // 故"合法取值但零命中"用「作物 × 未标注地区」组合表达（下面两行）；不在目录里的取值属**非法值**，
  // 归 ③ 号用例（`/herbicides` 400，`/knowledge` 200 空 —— 该不对称是既有的、已如实记录）。
  { label: 'region_code=330000（语料未标注地区）', query: '&region_code=330000' },
  { label: 'region_code=330102（语料未标注地区）', query: '&region_code=330102' },
  { label: 'crop_id=crop_rice & region_code=330000', query: '&crop_id=crop_rice&region_code=330000' },
  { label: 'crop_id=crop_corn & region_code=330102', query: '&crop_id=crop_corn&region_code=330102' },
];

test('①集合相等（硬判据）：同一语料 × 同一组过滤条件，/knowledge 与 /herbicides 命中 id 集合逐条相等', async () => {
  const corpus = await sharedCorpus();
  assert.equal(corpus.status, 200);
  assert.equal(corpus.body.data.items.length, RECORDS.length, '语料条数须与仓内真实记录一致');

  const rows = projectRows(corpus.body.data.items);
  const { app, get } = await host({ rows });
  try {
    for (const filter of FILTERS) {
      const herbicide = await get(`/herbicides?limit=50${filter.query}`);
      const knowledge = await get(`/knowledge?limit=50${filter.query}`);
      assert.equal(herbicide.status, 200, `/herbicides 应 200：${filter.label}`);
      assert.equal(knowledge.status, 200, `/knowledge 应 200：${filter.label}`);
      assert.deepEqual(
        idsOf(herbicide.body),
        idsOf(knowledge.body),
        `两读面在同一组过滤条件下必须集合相等：${filter.label}`,
      );
    }
    // 非退化断言：等值不是"两边都空"凑出来的 —— 作物维度必须真命中，
    // 地区维度必须真为空（语料 0/20 标注地区，两侧都 fail-closed 而不是放宽）。
    const rice = await get('/herbicides?limit=50&crop_id=crop_rice');
    assert.equal(rice.body.data.items.length > 0, true, 'crop_id 过滤必须真收窄到非空');
    assert.equal(rice.body.data.items.length < RECORDS.length, true, 'crop_id 过滤必须真收窄（不是全量）');
    const region = await get('/herbicides?limit=50&region_code=330000');
    assert.deepEqual(region.body.data.items, [], '未标注地区的记录不得因地区条件被放宽放行');
    const knowledgeRegion = await get('/knowledge?limit=50&region_code=330000');
    assert.deepEqual(knowledgeRegion.body.data.items, [], '两侧同一条谓词：未标注即不命中');
  } finally { await app.close(); }
});

test('②敏感性（防判据空转）：构造一条只在一个面命中的数据 ⇒ 集合相等必须不成立', async () => {
  const corpus = await sharedCorpus();
  const rows = projectRows(corpus.body.data.items);
  // 只多出一行：`/knowledge` 面的语料有它，`/herbicides` 面的语料没有它（真实语料不可变）。
  const ghost = { ...rows[0], id: '00000000-0000-4000-8000-00000000dead', crop_ids: ['crop_rice'] };
  const { app, get } = await host({ rows: [ghost, ...rows] });
  try {
    const herbicide = await get('/herbicides?limit=50&crop_id=crop_rice');
    const knowledge = await get('/knowledge?limit=50&crop_id=crop_rice');
    assert.equal(herbicide.status, 200);
    assert.equal(knowledge.status, 200);
    assert.equal(
      knowledge.body.data.items.some((item) => item.id === ghost.id), true,
      '只在一面存在的行必须真的被该面返回（否则本负控制不成立）',
    );
    assert.equal(
      herbicide.body.data.items.some((item) => item.id === ghost.id), false,
      '另一面没有这条记录 ⇒ 必须不返回',
    );
    assert.notDeepEqual(
      idsOf(herbicide.body),
      idsOf(knowledge.body),
      '两读面结果不等时，集合相等判据必须变红（判据不是恒真）',
    );
  } finally { await app.close(); }
});

test('③非法值 ⇒ 4xx + 契约错误码闭集；⛔ 不静默忽略、⛔ 不返回 200 空集', async () => {
  const corpus = await sharedCorpus();
  const { app, get } = await host({ rows: projectRows(corpus.body.data.items) });
  try {
    const allowed400 = ERROR_STATUS_MAP[400];
    // 取值不在目录里（crop_wheat 未登记）/ 空串 / 非浙江 33 开头的地区码 ⇒ 一律 4xx。
    for (const query of ['&crop_id=crop_wheat', '&crop_id=', '&region_code=110101', '&region_code=3301', '&region_code=']) {
      const res = await get(`/herbicides?limit=50${query}`);
      assert.equal(res.status, 400, `${query} 必须 4xx，不得静默忽略或 200 空集`);
      assert.equal(allowed400.includes(res.body.error.code), true, `${query} 的错误码必须在契约 400 闭集内：${res.body.error.code}`);
      assert.equal(res.body.error.code, 'INVALID_REQUEST');
      // 不得"吞掉参数当没给"：错误响应里不能带 items。
      assert.equal(res.body.data, undefined, '非法值不得返回数据体');
    }
    // 取值合法但目录里没有该作物（`crop_wheat`）走域层校验：details 指出字段，仍不静默放宽。
    const unknownCrop = await get('/herbicides?limit=50&crop_id=crop_wheat');
    assert.equal(unknownCrop.body.error.details.some((detail) => detail.field === 'crop_id'), true, 'details 必须点名 crop_id');

    // 本片只加 crop_id / region_code：其余 `/knowledge` 维度仍**不在** `/herbicides` 参数面内（不擅自扩面）。
    for (const query of ['&species_id=synthetic_weed', '&growth_stage=unknown', '&planting_method=unknown', '&use_scene=unknown', '&owner_id=other']) {
      const res = await get(`/herbicides?limit=50${query}`);
      assert.equal(res.status, 400, `${query} 仍属未支持参数 ⇒ 400`);
      assert.equal(allowed400.includes(res.body.error.code), true);
    }
  } finally { await app.close(); }
});

test('④未给参数 ⇒ 行为与改前逐字节相同（golden 快照，采集自 8b646ae1）+ 既有收窄条件不回归', async () => {
  const { app, get } = await host({ rows: [] });
  try {
    for (const [path, want] of Object.entries(GOLDEN)) {
      if (path === '__pages__') continue;
      const res = await get(path.replace('/api/v1', ''));
      assert.equal(res.status, want.status, `${path} 状态码必须与改前一致`);
      assert.equal(sha256(res.body.data), sha256(want.data), `${path} 响应 data 必须与改前逐字节相同`);
    }
    // 分页链逐页逐字节（游标里带有效期，故只对 items 与"是否有下一页"做等价性）。
    let cursor = null;
    for (const page of GOLDEN.__pages__) {
      const res = await get(`/herbicides?limit=7${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      assert.equal(sha256(res.body.data.items), sha256(page.items), '分页每页 items 必须与改前逐字节相同');
      assert.equal(res.body.data.next_cursor !== null, page.hasNext, '下一页的存在性必须与改前一致');
      cursor = res.body.data.next_cursor;
    }
    // 既有收窄条件（q / registration_number）与新增条件可叠加，且叠加后仍是真收窄。
    const combined = await get('/herbicides?limit=50&crop_id=crop_rice&registration_number=PD20161371');
    assert.equal(combined.status, 200);
    assert.equal(combined.body.data.items.length, 1, 'crop_id 与既有 registration_number 必须同时生效');
  } finally { await app.close(); }
});

test('⑤契约对齐：/herbicides 的 crop_id / region_code 参数名与 schema 与 /knowledge **逐字段相同**', () => {
  const contract = JSON.parse(readFileSync(here('../../packages/contracts/openapi.json'), 'utf8'));
  const params = (path) => new Map(
    (contract.paths[path].get.parameters ?? []).filter((p) => typeof p.name === 'string').map((p) => [p.name, p]),
  );
  const knowledge = params('/knowledge');
  const herbicides = params('/herbicides');
  for (const name of ['crop_id', 'region_code']) {
    assert.equal(knowledge.has(name), true, `/knowledge 契约应声明 ${name}`);
    assert.equal(herbicides.has(name), true, `/herbicides 契约必须声明 ${name}（同参数名，不另起一套）`);
    assert.deepEqual(herbicides.get(name), knowledge.get(name), `${name} 的契约定义必须与 /knowledge 逐字段相同`);
  }
  // 反向护栏：本片只加这两个维度，其余 `/knowledge` 维度**不得**顺手扩到 `/herbicides`（扩面要单独裁定）。
  for (const name of ['species_id', 'growth_stage', 'planting_method', 'use_scene']) {
    assert.equal(herbicides.has(name), false, `/herbicides 不应出现未裁定的参数：${name}`);
  }
  // 既有参数面不因本片丢失或改名。
  for (const name of ['q', 'registration_number']) assert.equal(herbicides.has(name), true, `/herbicides 既有参数 ${name} 不得丢失`);
});

test('端口已释放：回环宿主关闭后 app.server 不再监听（动态空闲口，不占固定端口）', async () => {
  const probe = await host({ rows: [] });
  const port = probe.app.server.address().port;
  await probe.app.close();
  assert.equal(probe.app.server.listening, false, '宿主要已停止监听');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/v1/herbicides`), '关闭后该端口不应再接受连接');
  assert.equal(typeof port, 'number', `使用的端口 ${port} 由内核分配`);
});
