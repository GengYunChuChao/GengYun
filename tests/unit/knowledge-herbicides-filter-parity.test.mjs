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

// ── ⑥ 参数面「逐属性表态」（硬判据；属性集从源码读，不在测试里抄清单）──────────────
//
// 触发本判据的缺陷：服务端 `/herbicides` 早已接 `crop_id`／`region_code`，客户端白名单却写死
// `q`／`registration_number` 并把这两个条件当成「服务端不可表达」直接回退离线副本 —— 服务端绿、
// App 里不可达、页面对用户说反话。根因不是某一行写错，而是**没有任何判据要求服务端 schema 的
// 每个属性都得有人表态**：只改一边永远不会变红。本用例把这个缺口钉死：
//   服务端 querystring schema 的每个属性，要么在客户端白名单里，要么在下表里写明「客户端不提交＋真实原因」；
//   两边都不在 ⇒ 断言失败（新增参数的人必须同时回答"客户端怎么处理它"）。
//
// 属性集**从 `services/api/src/routes/knowledge.ts` 源码解析**（含 `...pagination` 这类展开），
// 客户端白名单同样从 `miniprogram/utils/knowledge-api.js` 源码解析。任一侧单独增删都会当场对不上，
// 判据不依赖本文件里抄的任何字符串清单（抄清单 = 测试跟着实现一起漂，正是本缺陷的成因）。
const API_ROUTE_SOURCE = readFileSync(here('../../services/api/src/routes/knowledge.ts'), 'utf8');
const CLIENT_API_SOURCE = readFileSync(here('../../miniprogram/utils/knowledge-api.js'), 'utf8');

/** 从 `source[start]`（必须是 `{`）起做花括号配对（跳过字符串字面量），返回配对 `}` 的下标。 */
function closeBrace(source, start) {
  assert.equal(source[start], '{', `期望对象字面量起始于下标 ${start}`);
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === quote && source[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return i; }
  }
  throw new Error(`对象字面量未闭合（起始下标 ${start}）`);
}

/** 按**顶层**（括号深度 0）逗号切分对象字面量的内部文本；字符串里的逗号不切。 */
function splitTopLevel(inner) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let from = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote !== null) {
      if (ch === quote && inner[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(inner.slice(from, i)); from = i + 1; }
  }
  parts.push(inner.slice(from));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** 读同一文件里 `const <name> = { … }` 的顶层键（供 `...spread` 展开用，支持嵌套展开）。 */
function declaredObjectKeys(source, name, path = []) {
  assert.equal(path.includes(name), false, `对象常量 ${name} 出现循环展开：${[...path, name].join(' → ')}`);
  const decl = new RegExp(`const\\s+${name}\\s*=\\s*\\{`, 'u').exec(source);
  assert.ok(decl, `源码里读不到 \`const ${name} = { … }\`；属性集必须从源码读，不得在测试里抄清单`);
  const open = decl.index + decl[0].length - 1;
  return objectLiteralKeys(source, source.slice(open, closeBrace(source, open) + 1), [...path, name]);
}

/** 对象字面量文本 ⇒ 顶层键数组（`key:value` 简写、`'key':value`、`...spread` 展开三种写法）。 */
function objectLiteralKeys(source, literal, path = []) {
  assert.equal(literal[0], '{', `schema 片段必须以 { 起：${literal.slice(0, 40)}`);
  const keys = [];
  for (const entry of splitTopLevel(literal.slice(1, -1))) {
    if (entry.startsWith('...')) {
      keys.push(...declaredObjectKeys(source, entry.slice(3).trim(), path));
      continue;
    }
    const colon = entry.indexOf(':');
    assert.ok(colon > 0, `无法解析 schema 属性条目：${entry}`);
    const key = entry.slice(0, colon).trim().replace(/^['"\u0060]|['"\u0060]$/gu, '');
    assert.ok(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key), `schema 属性名不规范：${JSON.stringify(key)}`);
    keys.push(key);
  }
  return keys;
}

/** `/herbicides` **列表**路由的 querystring `properties:{…}` 字面量（不是 `/herbicides/:id`）。 */
function herbicidesQuerystringLiteral(source) {
  const marker = '${API_PREFIX}/herbicides' + '`'; // 带反引号 ⇒ 只匹配列表路由，不匹配 `/herbicides/:id`
  const at = source.indexOf(marker);
  assert.ok(at >= 0, '源码里找不到 `${API_PREFIX}/herbicides` 列表路由 ⇒ 本判据的前提失效，先去核对路由文件');
  const rest = source.slice(at);
  const propsAt = rest.indexOf('properties:{');
  assert.ok(propsAt >= 0, '`/herbicides` 列表路由没有 querystring properties ⇒ 本判据的前提失效');
  assert.ok(
    rest.slice(0, propsAt).includes('additionalProperties:false'),
    '`/herbicides` 列表路由的 querystring 不是 additionalProperties:false ⇒ 判据前提（闭集）失效',
  );
  const open = at + propsAt + 'properties:'.length;
  assert.equal(source[open], '{', '`properties:` 后面应紧跟对象字面量');
  return source.slice(open, closeBrace(source, open) + 1);
}

/**
 * 服务端 schema 里**不进**客户端筛选白名单的属性，必须在这里表态（客户端怎么处理它 + 为什么）。
 * 这张表就是"表态"的地方：新增属性既不在白名单、也不在这里 ⇒ ⑥ 红；表里写占位符也 ⇒ ⑥ 红。
 */
const CLIENT_NOT_A_FILTER = new Map([
  ['cursor', '分页游标，不是筛选条件：客户端 `herbicideQuery` 的 cursor 分支单独校验（非空字符串、≤2048）后提交，服务端 schema 同形（minLength 1 / maxLength 2048）。'],
  ['limit', '页长，不是筛选条件：客户端 `herbicideQuery` 的 limit 分支单独校验（整数 1..50）后提交，服务端 schema 同形（minimum 1 / maximum 50 / default 20）。'],
  // 服务端 schema **接受** `region_code`（pattern ^33[0-9]{4}$），但客户端本版不提交它——原因不是"接口不支持"：
  // 仓内没有一条记录标注 `region_codes`（`packages/reference/query.mjs` 的 `matchConditions()` 对未标注记录判
  // "记录未标注适用地区，无法确认"），而该原因只留在 `reference.listHerbicides()` 的 `query_state.reasons` 里、
  // 不进响应体（`{data:{items,next_cursor},meta}`）⇒ 提交 `region_code` 只会拿到 `items: []`，页面再把"未标注"
  // 显示成"不满足所选条件"。接它必须先由服务端补上 `match_state`/`reasons` 出口（下一片）。
  ['region_code', '地区：服务端 schema 接受该参数（pattern ^33[0-9]{4}$），但当前资料零条标注 region_codes（未标注适用地区），且响应体不回 match_state/reasons ⇒ 提交只会把"未标注"误报成"不满足"，故本版不提交，待服务端补 match_state 出口后再接。'],
]);

const SERVER_PROPERTIES = objectLiteralKeys(API_ROUTE_SOURCE, herbicidesQuerystringLiteral(API_ROUTE_SOURCE));
const CLIENT_FILTERS = (() => {
  const decl = /const\s+HERBICIDE_FILTERS\s*=\s*\[([\s\S]*?)\]/u.exec(CLIENT_API_SOURCE);
  assert.ok(decl, '客户端源码里读不到 `const HERBICIDE_FILTERS = [ … ]` ⇒ 本判据的前提失效');
  return splitTopLevel(decl[1]).map((entry) => {
    assert.match(entry, /^['"][^'"]+['"]$/u, `客户端白名单条目必须是字符串字面量：${entry}`);
    return entry.slice(1, -1);
  });
})();

/** 服务端属性里，既不在客户端白名单、也没在表态表里的那些（"没人表态"）。 */
const unaccounted = (properties) => properties.filter(
  (name) => !CLIENT_FILTERS.includes(name) && !CLIENT_NOT_A_FILTER.has(name),
);

test('⑥ 参数面逐属性表态：服务端 schema 每个属性都在客户端白名单或显式表态表里（属性集从源码读）', () => {
  // 解析器自检：读错路由/读空都会让下面的判据空转，所以先钉住"读到了东西、且是闭集"。
  assert.ok(SERVER_PROPERTIES.length >= 4, `从 routes/knowledge.ts 读到的 /herbicides 属性只有 ${SERVER_PROPERTIES.length} 个，解析器可能读错了路由`);
  assert.equal(new Set(SERVER_PROPERTIES).size, SERVER_PROPERTIES.length, `/herbicides 属性表出现重复键：${SERVER_PROPERTIES.join(', ')}`);
  assert.ok(CLIENT_FILTERS.length > 0, '客户端白名单解析为空 ⇒ 判据会空转');

  // ① 服务端每个属性：在客户端白名单里，或在表态表里写明"客户端怎么处理 + 为什么"。
  assert.deepEqual(
    unaccounted(SERVER_PROPERTIES),
    [],
    `服务端 /herbicides 的这些属性既不在客户端白名单、也没在表态表里说明 ⇒ 加参数的人只改了一边：${unaccounted(SERVER_PROPERTIES).join(', ')}`,
  );

  // ② 反向护栏：客户端白名单不得出现服务端 schema 里没有的键（否则客户端会发一个必然 400 的参数）。
  const phantom = CLIENT_FILTERS.filter((name) => !SERVER_PROPERTIES.includes(name));
  assert.deepEqual(phantom, [], `客户端白名单出现服务端不存在的键：${phantom.join(', ')}`);

  // ③ 白名单与表态表不得对同一个键自相矛盾（既说"会提交"又说"不提交"）。
  const contradictory = [...CLIENT_NOT_A_FILTER.keys()].filter((name) => CLIENT_FILTERS.includes(name));
  assert.deepEqual(contradictory, [], `白名单与表态表互相矛盾：${contradictory.join(', ')}`);

  // ④ 表态表里的每一条都得是"真原因"，不是占位符。
  for (const [name, reason] of CLIENT_NOT_A_FILTER) {
    assert.equal(typeof reason, 'string', `表态表 ${name} 的原因必须是字符串`);
    assert.ok(reason.trim().length >= 12, `表态表 ${name} 的原因太短，疑似占位符：${JSON.stringify(reason)}`);
  }

  // ⑤ 判据自身非空转（负控制的常驻孪生）：多一个没人表态的属性，`unaccounted` 必须点名它。
  assert.deepEqual(
    unaccounted([...SERVER_PROPERTIES, 'synthetic_new_filter']),
    ['synthetic_new_filter'],
    '判据必须抓得出"新增了服务端属性却没人表态"，否则 ⑥ 恒真',
  );

  console.log(
    `⑥ 读数：服务端 /herbicides 属性 ${SERVER_PROPERTIES.length} 个 [${SERVER_PROPERTIES.join(', ')}]；`
    + `客户端白名单 ${CLIENT_FILTERS.length} 个 [${CLIENT_FILTERS.join(', ')}]；`
    + `表态为非筛选 ${CLIENT_NOT_A_FILTER.size} 个 [${[...CLIENT_NOT_A_FILTER.keys()].join(', ')}]`,
  );
});

test('端口已释放：回环宿主关闭后 app.server 不再监听（动态空闲口，不占固定端口）', async () => {
  const probe = await host({ rows: [] });
  const port = probe.app.server.address().port;
  await probe.app.close();
  assert.equal(probe.app.server.listening, false, '宿主要已停止监听');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/v1/herbicides`), '关闭后该端口不应再接受连接');
  assert.equal(typeof port, 'number', `使用的端口 ${port} 由内核分配`);
});
