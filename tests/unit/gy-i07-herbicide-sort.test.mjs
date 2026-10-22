// GY-R31-I07（#7）· `/herbicides` **列表排序口径**的行为钉子。
//
// 钉住什么
//   `/herbicides` 列表恒按**登记号（registration_number）字典序升序**返回。它与 `/knowledge`
//   列表的 `(created_at DESC, id DESC)` **不是同一个口径**，两者共用一个契约段落的两个子句，
//   而不是同一条排序规则。
//
// 为什么钉（裁定与逐条依据见 docs/verification/gy-r31-i07-sort-20261022.md）
//   1. `packages/reference/query.mjs` 的 `runQuery` 里那行排序自带理由注释：
//      「稳定排序：登记号升序（确定性，便于分页与快照对比）」—— 明示意图，不是随手写的。
//   2. 该行的比较器被**分页游标**反向绑定：`paginate` 用 `registration_number` 定位游标，
//      再取其后 `limit` 条。排序键 ≠ 游标键时分页会重复/漏项，故两者必须同源。
//   3. 冻结契约的 `Herbicide` 是 `additionalProperties: false` 且**没有 `created_at`**
//      （`packages/contracts/openapi.json#/components/schemas/Herbicide`），而实体里唯一的
//      时间戳 `source.updated_at` 在仓内 20 条记录上只有 2 个取值（19 条同日 + 1 条），
//      按它排会把 19 条打成同组、组内由确定性 uuid 决定 —— 与登记号语义无关，也不比
//      登记号升序更确定。
//
// ⚠ 这是**行为钉子**，不是偏好声明。把排序改成降序、改成按 `id`、或给实体补上 `created_at`
//   再按它排，本文件都**必须变红**。变红不等于测试写错：那是口径被改动，请先重开裁定、
//   在证据页留下改前/改后读数，再改本文件。不要为了让红灯变绿而放宽断言。
//
// 不依赖：真机、PostgreSQL、`DATABASE_URL`、网络、外部凭据。数据全部来自仓内 JSON。
// 断言不写死任何源文件行号：一律按导出符号与关联合约取值。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { loadHerbicideRecords } from '../../packages/reference/records.mjs';
import { loadCatalog } from '../../packages/reference/catalog.mjs';
import { normalizeQuery, runQuery } from '../../packages/reference/query.mjs';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';

const SESSION_KEY = 'synthetic-session-signing-key-0123456789';
const IDEM = 'idem-key-gy-i07-sort-0001';

const openapi = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'));

/** 与实现所用的 `<` / `>` 同一定义域：按 UTF-16 码元比较，不依赖 locale。 */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 一份记录集合应得的排序结果（登记号升序）。 */
const ascendingKeys = (items) => items.map((item) => item.registration_number).sort(byCodeUnit);

/** 把比较器取反后的结果：负控制的「另一种口径」。 */
const invertedKeys = (items) => [...ascendingKeys(items)].sort((a, b) => -byCodeUnit(a, b));

function stubConfig() {
  return loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: SESSION_KEY });
}

async function newApp() {
  const app = buildApp({
    config: stubConfig(),
    store: createMemoryAuthStore(),
    idempotency: createMemoryIdempotencyStore(),
  });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/wechat',
    headers: { 'idempotency-key': IDEM },
    payload: { code: 'synthetic-gy-i07-sort' },
  });
  assert.equal(res.statusCode, 200, '合成登录必须成功（不连真库、不走真实微信）');
  return { app, token: res.json().data.access_token };
}

const get = (app, url, token) => app.inject({
  method: 'GET',
  url,
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

test('A. 领域层：runQuery 对输入排列不敏感，恒按登记号升序返回', () => {
  const catalog = loadCatalog();
  const items = loadHerbicideRecords().items;
  assert.ok(items.length >= 5, `仓内除草剂记录只有 ${items.length} 条，断言失去分辨力`);

  const expected = ascendingKeys(items);
  assert.equal(new Set(expected).size, expected.length, '登记号必须两两不同，否则「升序」不是全序');

  // 非空性前置：文件里的顺序**本来就**不是升序；否则「输出是升序」可能是碰巧读对了顺序。
  assert.notDeepEqual(
    items.map((item) => item.registration_number),
    expected,
    '仓内记录文件顺序与升序相同时，本条断言无法区分「排过」与「没排」',
  );

  const permutations = [
    ['文件原序', (list) => list],
    ['整体逆序', (list) => [...list].reverse()],
    ['错位轮转', (list) => [...list.slice(7), ...list.slice(0, 7)]],
  ];

  for (const [label, rearrange] of permutations) {
    const result = runQuery(rearrange(items), normalizeQuery({ limit: 50 }, catalog), catalog);
    assert.deepEqual(
      result.items.map((row) => row.registration_number),
      expected,
      `输入排列「${label}」下，输出必须仍是登记号升序（排序须由查询自身给出）`,
    );
  }
});

test("B. 契约形状：Herbicide 实体没有 created_at，故「created_at DESC」在 /herbicides 上不可表达", () => {
  const herbicide = openapi.components.schemas.Herbicide;
  assert.equal(herbicide.additionalProperties, false, 'Herbicide 必须是封闭实体（不得偷偷加字段）');
  assert.equal(
    Object.hasOwn(herbicide.properties, 'created_at'),
    false,
    '实体一旦补上 created_at，本页裁定前提失效，必须重开裁定',
  );
  // 排序键在实体里是可见的：registration_number 嵌在 formulation 内且为必填。
  assert.equal(openapi.components.schemas.Formulation.required.includes('registration_number'), true,
    '排序键 registration_number 必须是契约必填字段（客户端可见、可复核）');
  assert.equal(Object.hasOwn(herbicide.properties, 'registration_number'), false,
    'registration_number 不应被提到顶层（列表按 formulation.registration_number 复核）');
});

test('C. HTTP 面：一页取满时 /herbicides 返回登记号升序，接线层不重排', async () => {
  const { app, token } = await newApp();
  const res = await get(app, '/api/v1/herbicides?limit=50', token);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.next_cursor, null, '记录数小于 limit 时不应有下一页');

  const got = body.data.items.map((item) => item.formulation.registration_number);
  assert.deepEqual(got, ascendingKeys(loadHerbicideRecords().items),
    '/herbicides 列表必须按登记号升序；路由与可见性过滤只可剔除行，不可改序');
});

test('D. 游标键与排序键同源：逐页走完 limit=5 的全程，拼接序 = 单页序', async () => {
  const { app, token } = await newApp();
  const expected = ascendingKeys(loadHerbicideRecords().items);

  const walked = [];
  let cursor = null;
  let pages = 0;
  do {
    const url = `/api/v1/herbicides?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await get(app, url, token);
    assert.equal(res.statusCode, 200, `游标 ${cursor ?? '(首页)'} 必须可取`);
    const body = res.json();
    const page = body.data.items.map((item) => item.formulation.registration_number);
    assert.ok(page.length <= 5, '单页不得超过 limit');
    walked.push(...page);
    cursor = body.data.next_cursor;
    pages += 1;
    assert.ok(pages <= 10, '分页未在 10 页内收敛，疑似游标不前进');
  } while (cursor !== null);

  assert.equal(walked.length, expected.length, '逐页拼接后条数必须与全集一致（游标不得重复或漏项）');
  assert.deepEqual(walked, expected, '逐页拼接序必须严格等于登记号升序（排序键即游标键）');
});

test('E. 负控制：倒序解必然与升序不同 —— 断言对方向敏感，不是恒真', () => {
  const catalog = loadCatalog();
  const items = loadHerbicideRecords().items;
  const ascending = ascendingKeys(items);
  const inverted = invertedKeys(items);

  // ① 两个解必须真的不同；相同则说明键不足以分辨方向，钉子为空。
  assert.notDeepEqual(inverted, ascending, '升/降两序相同 ⇒ 本钉子是空的');
  assert.notEqual(inverted[0], ascending[0], '首项必须不同（只看首项即可判定方向）');

  // ② 把实现里的比较器取反后跑同一条断言路径：**必须抛错**。
  const asIfDescending = runQuery([...items].reverse(), normalizeQuery({ limit: 50 }, catalog), catalog)
    .items.map((row) => row.registration_number)
    .sort((a, b) => -byCodeUnit(a, b));
  assert.deepEqual(asIfDescending, inverted, '取反比较器的结果必须等于倒序解');
  assert.throws(
    () => assert.deepEqual(asIfDescending, ascending),
    '倒序结果必须让 B/C/D 用的升序断言失败；若这里不抛错，说明断言退化成恒真',
  );
});
