// GY-I07 · `GET /catalog/species`（Refs #7）—— 定向证据，不是全量回归。
//
// 本片要证明的四件事：
//   ① 正常返回：真实 SQL（`public.species`）读出来的行，逐字段与批准目录
//      `packages/knowledge/catalog/species.json` 一致，且响应里**只有**契约
//      `Species` 的四个字段（`additionalProperties:false`，别名/组名不得漏出去）；
//   ② fail-closed：无连接池 / 表缺失 / 查询失败 ⇒ 既有 `503 PROVIDER_UNAVAILABLE`，
//      **绝不用空数组冒充成功**（空数组只允许出现在「库确实答了且被 q 收窄到 0 条」）；
//   ③ 鉴权：游客、失效会话、非 user 角色一律拒绝，且拒绝响应不同时带 `data`；
//   ④ 最小授权：运行时角色只拿到四个契约列的 SELECT（别名列不可读）＋ FOR SHARE 所需的锁列。
//
// 为什么不复用 `tests/unit/profile-api.test.mjs`：那份用例把「档案 + crops/regions」
// 绑在同一条链上，加物种会把它变成巨石；这里用同一套夹具口径（PGlite + 真迁移 +
// 真 `/auth/wechat` 登录 + `app.inject`）独立成例，跑法与兄弟片完全一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createProfileService } from '../../services/api/src/profile/service.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const species = JSON.parse(read('packages/knowledge/catalog/species.json')).species;
const route = '/api/v1/catalog/species';
const CONTRACT_FIELDS = ['canonical_name', 'coverage_state', 'id', 'scientific_name'];
const COVERAGE_STATES = ['planned', 'supported', 'unsupported'];
const MIGRATIONS = ['0001_initial_schema.sql', '0002_knowledge_catalog.sql', '0003_privacy_consent.sql',
  '0008_auth_session.sql', '0009_consent_policy.sql'];

/** 只装 `public.species` 行（来源＝批准目录 JSON，与 db/seeds/seed_reference.sql 同源生成）。 */
async function fixture({ pool = 'attached' } = {}) {
  const db = new PGlite();
  for (const file of MIGRATIONS) await db.exec(read(`services/api/db/migrations/${file}`));
  for (const row of species) {
    await db.query('INSERT INTO species(id,canonical_name,scientific_name,aliases,coverage_state) VALUES($1,$2,$3,$4::jsonb,$5)',
      [row.id, row.canonical_name, row.scientific_name, JSON.stringify(row.aliases ?? []), row.coverage_state]);
  }
  // 一个连接 = 一次请求；PGlite 只有一条会话，故每个请求拿到的都是同一引擎上的独立句柄。
  const attached = {
    query: (...args) => db.query(...args),
    async connect() { return {query: (...args) => db.query(...args), release() {}}; },
  };
  const app = buildApp({config: loadConfig({APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent'}),
    ...(pool === 'attached' ? {pool: attached} : {})});
  async function login(code) {
    const result = await app.inject({method: 'POST', url: '/api/v1/auth/wechat', headers: {'idempotency-key': `species-login-${code}`}, payload: {code}});
    assert.equal(result.statusCode, 200, result.body);
    return result.json().data.access_token;
  }
  const headers = token => ({authorization: `Bearer ${token}`});
  return {app, db, pool: attached, a: await login('species-a'), b: await login('species-b'), headers,
    async close() { await app.close(); await db.close(); }};
}

const byId = (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
const project = rows => rows.map(({id, canonical_name, scientific_name, coverage_state}) => ({id, canonical_name, scientific_name, coverage_state})).sort(byId);

test('GY-I07 正常返回：真实 SQL × 批准目录逐字段一致，且只出现契约四字段', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const {app, a, b, headers} = f;

  const response = await app.inject({url: route, headers: headers(a)});
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  // 目录按领域稳定键（id）升序；原 JSON 顺序不是键升序，所以这条同时钉住 ORDER BY。
  assert.deepEqual(body.data.items, project(species), '物种目录行必须与批准目录逐字段一致且按 id 升序');
  assert.equal(body.data.items.length, 8);
  assert.ok(body.data.items.every(item => COVERAGE_STATES.includes(item.coverage_state)), 'coverage_state 必须在契约枚举内');
  for (const item of body.data.items) {
    assert.deepEqual(Object.keys(item).sort(), CONTRACT_FIELDS, 'Species 是 additionalProperties:false：多一个字段就是契约违规');
  }
  // 授权访问 no-store；列表没有强 ETag（契约头说明里写明「列表无此头」）。
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers.etag, undefined);
  assert.equal(JSON.stringify(body).includes(a), false, '响应不得回显令牌');
  // 两个不同主体拿到同一份公共目录（目录不是按属主投影的）。
  assert.deepEqual((await app.inject({url: route, headers: headers(b)})).json().data.items, body.data.items);

  await t.test('q 收窄：命中俗名/组名、大小写不敏感、折叠空白；空收窄词按未收窄处理', async () => {
    const ids = async query => {
      const res = await app.inject({url: `${route}?${query}`, headers: headers(a)});
      assert.equal(res.statusCode, 200, res.body);
      return res.json().data.items.map(item => item.id);
    };
    // 稗草的俗名/组名（库里 canonical_name 是「稗」；别名只作检索词，不出现在响应里）
    assert.deepEqual(await ids('q=%E7%A8%97%E8%8D%89'), ['species_barnyardgrass']);
    assert.deepEqual(await ids('q=%E7%A8%97%20%E8%8D%89'), ['species_barnyardgrass'], '空白折叠后仍应命中');
    assert.deepEqual(await ids('q=ECHINOCHLOA'), ['species_barnyardgrass'], 'q 大小写不敏感');
    assert.deepEqual(await ids('q=%E8%97%9C'), ['species_lambsquarters']);
    // 收窄到 0 条是「库答了但没有匹配行」，与「未接线返回空数组」必须区分：这里仍是 200 且 next_cursor=null。
    const none = await app.inject({url: `${route}?q=no-such-species-xyz`, headers: headers(a)});
    assert.equal(none.statusCode, 200);
    assert.deepEqual(none.json().data, {items: [], next_cursor: null});
    // 归一化后为空的关键词＝未收窄（与 packages/reference 的 q 口径一致），不是「必空」条件。
    assert.equal((await ids('q=%20')).length, 8, '纯空白 q 不得被当成必空条件');
  });

  await t.test('签名游标分页：三页取尽 8 条且不重不漏，末页 next_cursor=null', async () => {
    const seen = [];
    let cursor;
    for (let page = 0; page < 4; page += 1) {
      const url = `${route}?limit=3${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
      const response2 = await app.inject({url, headers: headers(a)});
      assert.equal(response2.statusCode, 200, response2.body);
      assert.equal(response2.headers['cache-control'], 'no-store');
      const data = response2.json().data;
      seen.push(...data.items.map(item => item.id));
      cursor = data.next_cursor;
      if (cursor === null) break;
    }
    assert.equal(seen.length, 8);
    assert.equal(new Set(seen).size, 8, '分页重复或漏项');
    assert.equal(cursor, null);
  });

  await t.test('游标绑定：他人主体、换 q、换路由、伪造串一律 INVALID_CURSOR', async () => {
    const first = await app.inject({url: `${route}?limit=2`, headers: headers(a)});
    const cursor = first.json().data.next_cursor;
    assert.ok(cursor);
    const cases = [
      ['other subject', b, `${route}?limit=2&cursor=${encodeURIComponent(cursor)}`],
      ['changed q', a, `${route}?limit=2&q=%E7%A8%97&cursor=${encodeURIComponent(cursor)}`],
      ['other route', a, `/api/v1/catalog/crops?cursor=${encodeURIComponent(cursor)}`],
      ['forged', a, `${route}?cursor=${encodeURIComponent(cursor)}x`],
      ['garbage', a, `${route}?cursor=not-a-real-cursor`],
    ];
    for (const [label, token, url] of cases) {
      const response2 = await app.inject({url, headers: headers(token)});
      assert.equal(response2.statusCode, 400, `${label} 应 400，实际 ${response2.statusCode} ${response2.body}`);
      assert.equal(response2.json().error.code, 'INVALID_CURSOR', label);
      assert.equal(response2.json().data, undefined, `${label} 被拒却返回成功 data`);
    }
  });

  await t.test('查询串闭集：多余字段/越界 limit/空或超长 q 一律 400 且不带 data', async () => {
    for (const query of ['limit=51', 'limit=0', 'q=', `q=${'a'.repeat(81)}`, 'parent_code=330100', 'species_id=species_barnyardgrass']) {
      const response2 = await app.inject({url: `${route}?${query}`, headers: headers(a)});
      assert.equal(response2.statusCode, 400, `${query} 应 400，实际 ${response2.statusCode} ${response2.body}`);
      assert.equal(typeof response2.json().error.code, 'string', query);
      assert.equal(response2.json().data, undefined, query);
    }
  });

  await t.test('库内行与目录不一致 ⇒ 该行不出现（不猜、不兜底 coverage_state）', async () => {
    // 库里塞一条契约外 coverage_state（列默认值 unknown）＋一条目录外 id，二者都不得出现在响应里。
    await f.db.query("UPDATE species SET coverage_state='unknown' WHERE id='species_foxtail'");
    await f.db.query("INSERT INTO species(id,canonical_name,scientific_name,coverage_state) VALUES('species_synthetic_outside','合成目录外物种','Synthetic outside',  'planned')");
    const response2 = await app.inject({url: route, headers: headers(a)});
    assert.equal(response2.statusCode, 200);
    const ids = response2.json().data.items.map(item => item.id);
    assert.equal(ids.includes('species_foxtail'), false, 'coverage_state 与目录不一致的行不得出现');
    assert.equal(ids.includes('species_synthetic_outside'), false, '目录外的行不得出现');
    assert.equal(ids.length, 7);
  });
});

test('GY-I07 fail-closed：无连接池与库故障都是 503 PROVIDER_UNAVAILABLE，不返回空数组冒充成功', async t => {
  // ① 未接线（buildApp 不传 pool）：与 crops/regions 同一条既有错误码与文案。
  const stub = await fixture({pool: 'detached'});
  t.after(() => stub.close());
  const guest = await stub.app.inject({url: route});
  assert.equal(guest.statusCode, 401, guest.body);
  const unconfigured = await stub.app.inject({url: route, headers: stub.headers(stub.a)});
  assert.equal(unconfigured.statusCode, 503, `无池应 503，实际 ${unconfigured.statusCode} ${unconfigured.body}`);
  assert.equal(unconfigured.json().error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(unconfigured.json().data, undefined, '无库时不得伪造 data（尤其不得是 {items:[],next_cursor:null}）');

  // ② 有池但表缺失（部署漏迁移/权限收回的等价形态）：同样是 503，不是 200 空数组。
  const broken = await fixture();
  t.after(() => broken.close());
  assert.equal((await broken.app.inject({url: route, headers: broken.headers(broken.a)})).statusCode, 200);
  await broken.db.exec('ALTER TABLE species RENAME TO species_gone');
  const failed = await broken.app.inject({url: route, headers: broken.headers(broken.a)});
  assert.equal(failed.statusCode, 503, `表缺失应 503，实际 ${failed.statusCode} ${failed.body}`);
  assert.equal(failed.json().error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(failed.json().data, undefined);
});

test('GY-I07 鉴权：游客/失效会话/非 user 角色一律拒绝，拒绝响应不带 data', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const {app, db, a, headers} = f;

  const guests = [
    ['no header', {}],
    ['empty bearer', {authorization: 'Bearer '}],
    ['malformed', {authorization: 'NotBearer abc'}],
    ['unknown token', {authorization: `Bearer ${'0'.repeat(43)}`}],
  ];
  for (const [label, extra] of guests) {
    const response = await app.inject({url: route, ...extra});
    assert.equal(response.statusCode, 401, `${label} 应 401，实际 ${response.statusCode} ${response.body}`);
    assert.ok(['SESSION_REQUIRED', 'SESSION_EXPIRED'].includes(response.json().error.code), `${label} → ${response.body}`);
    assert.equal(response.json().data, undefined, `${label} 被拒却返回成功 data`);
  }

  // 注销后同一令牌立刻失效（会话撤销在事务内复验，不看缓存）。
  const logout = await app.inject({method: 'POST', url: '/api/v1/auth/logout', headers: {...headers(a), 'idempotency-key': 'species-logout-a'}});
  assert.equal(logout.statusCode, 200, logout.body);
  const revoked = await app.inject({url: route, headers: headers(a)});
  assert.equal(revoked.statusCode, 401, revoked.body);
  assert.equal(revoked.json().error.code, 'SESSION_EXPIRED');
  assert.equal(revoked.json().data, undefined);

  // 服务层：非 user 角色的会话必须在任何 SQL 之前被拒（SCOPE_DENIED / 403）。
  const f2 = await fixture();
  t.after(() => f2.close());
  const session = (await f2.db.query("SELECT id,user_id,auth_epoch FROM sessions WHERE token_hash=decode($1,'hex')", [hashToken(f2.a)])).rows[0];
  const service = createProfileService(f2.pool, 'test-hmac-key');
  for (const role of ['admin', 'guest', 'service', '']) {
    const identity = {userId: session.user_id, authEpoch: Number(session.auth_epoch), sessionId: session.id, role};
    await assert.rejects(service.listSpecies({identity, token: f2.a}, {limit: 20}), error => error.code === 'SCOPE_DENIED', `role=${role}`);
  }
});

test('GY-I07 最小授权：运行时角色只拿四个契约列的 SELECT ＋ FOR SHARE 所需的锁列', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  // 授权脚本按「0001 之后」写，先建表再授（与 db/roles/* 的部署前置一致）。
  await db.exec(read('services/api/db/migrations/0001_initial_schema.sql'));
  await db.exec(read('services/api/db/roles/profile_runtime.sql'));
  const privilege = async (column, kind) => (await db.query('SELECT has_column_privilege($1,$2,$3,$4) AS granted',
    ['gengyun_profile_runtime', 'public.species', column, kind])).rows[0].granted;
  for (const column of ['id', 'canonical_name', 'scientific_name', 'coverage_state']) {
    assert.equal(await privilege(column, 'SELECT'), true, `${column} 必须可读（契约四字段）`);
  }
  // 别名只作 q 的检索词，服务端不读它 ⇒ 不给权限（最小授权）。
  assert.equal(await privilege('aliases', 'SELECT'), false, 'aliases 不该对 API 角色开放');
  // 锁列与兄弟目录同口径：`FOR SHARE` 需要至少一列 UPDATE，且只开这一列；契约外的列一律不可写。
  assert.equal(await privilege('canonical_name', 'UPDATE'), true, 'FOR SHARE 需要至少一列 UPDATE 锁权限');
  for (const column of ['id', 'scientific_name', 'coverage_state', 'aliases']) {
    assert.equal(await privilege(column, 'UPDATE'), false, `${column} 不该可写`);
  }
  assert.equal((await db.query("SELECT has_table_privilege('gengyun_profile_runtime','public.species','DELETE') AS granted")).rows[0].granted, false);
  assert.equal((await db.query("SELECT has_table_privilege('gengyun_profile_runtime','public.species','INSERT') AS granted")).rows[0].granted, false);
});
