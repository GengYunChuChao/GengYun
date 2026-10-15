// GY-I16（#16）× GY-I17（#17）· **收藏「引用可用性」接线**的回归（`Refs #16, Refs #17`）。
//
// 与被测行为的关系（本文件是"装配默认"用例，不是端口替身用例）：
//   * `tests/unit/favorites-history-visibility.test.mjs` 用**注入替身**证明"每次读取重新派生"的
//     服务层语义；本文件**不注入**任何 `visibility` 端口，直接跑 `buildApp` 的**生产默认装配**
//     ⇒ 接线前后行为不同，故本文件在接线前**必须红**（自证见交付说明）。
//
// 覆盖（全部为实测断言，全部走真实回环 HTTP）：
//   1. 收藏当前**可读**资料 ⇒ 收藏页该行 `reference_state='available'`、`unavailable_reason=null`，
//      且同一目标经 `/knowledge/{id}` 真的可打开（＝「查看资料」可跳转）；
//   2. 该资料**下架/失效**后 ⇒ **同一收藏行**变 `unavailable`（不重新建行、不重启进程）；
//      恢复上架后同一行重新变 `available`（失效是判定，不是不可逆标记）；
//      改版（新修订）后 ⇒ 旧 `target_ref.revision` 不再可用（与审核域 `REVISION_SUPERSEDED` 同口径）；
//   3. 未登录仍 401 `SESSION_REQUIRED`（登录门口径不变）；
//   4. 反例：核不到 / 类型不符 / 不在读面 ⇒ 一律 `unavailable`（fail-closed、不区分
//      "已下架"与"不存在"，说明落在契约 1..80 字符内）。
//
// 「可读资料」两种来源**都覆盖**（生产默认装配的公开读面＝两者的并集，数据库优先）：
//   A. 数据库读视图 `catalog_read.current_knowledge`（已核对 + 已发布 + 当前生效版本）；
//   B. 浙江首批真实资料投影（`APP_KNOWLEDGE_UNVERIFIED_SEED`，本地联调与 Demo 的实际可收藏集合）。
// 用例 A 的第一条断言即"**列表里能读到的资料，收藏后必须可用**"——它同时锁住"读面开关"
// 在 `app.ts`（接线）与 `routes/knowledge.ts`（列表/详情）两处不会漂移。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { REFERENCE_UNAVAILABLE_REASONS } from '../../services/api/src/targetref/visibility.ts';

// 本地联调（`tools/local-dev/api.mjs`）与 Demo 用同一开关：浙江首批真实资料并入 `/knowledge`。
// 必须在 `buildApp` **之前**设置——`routes/knowledge.ts` 在注册路由时读取该开关。
process.env['APP_KNOWLEDGE_UNVERIFIED_SEED'] = '1';

const FAVORITES = '/api/v1/favorites';
const KNOWLEDGE = '/api/v1/knowledge';
const ABSENT_ID = '00000000-0000-4000-8f00-0000000000ff';
const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');

/** 最小 PGlite 夹具：迁移 + 受限运行角色 + `buildApp` 默认装配（不注入可见性端口）。 */
async function fixture() {
  const db = new PGlite();
  for (const name of [
    '0001_initial_schema',
    '0002_knowledge_catalog',
    '0003_privacy_consent',
    '0005_catalog_read_views',
    '0008_auth_session',
    '0009_consent_policy',
    '0010_knowledge_read_views',
  ]) {
    await db.exec(read('services/api/db/migrations/' + name + '.sql'));
  }
  for (const name of ['auth_privacy', 'knowledge_runtime']) {
    await db.exec(read('services/api/db/roles/' + name + '.sql'));
  }
  await db.exec('CREATE ROLE gy_i16_test_runtime NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT gengyun_auth_privacy,gengyun_knowledge_runtime TO gy_i16_test_runtime');
  // PGlite 只有一条连接：用队列串行化，每段查询在自己的 `SET ROLE` 会话里完成（与既有
  // `tests/unit/knowledge-api.test.mjs` 同一夹具口径，未发明新框架）。
  let queue = Promise.resolve();
  const pool = {
    async connect() {
      const before = queue;
      let unlock;
      queue = new Promise((resolve) => { unlock = resolve; });
      await before;
      await db.query('SET ROLE gy_i16_test_runtime');
      return {
        query: (...args) => db.query(...args),
        release() { db.query('RESET ROLE').finally(unlock); },
      };
    },
    async query(...args) {
      const client = await this.connect();
      try { return await client.query(...args); } finally { client.release(); }
    },
  };
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: randomBytes(32).toString('hex') }),
    pool,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = 'http://127.0.0.1:' + app.server.address().port;

  async function http(path, token, options = {}) {
    const response = await fetch(origin + path, {
      ...options,
      headers: {
        ...(token === null ? {} : { authorization: 'Bearer ' + token }),
        ...(options.headers ?? {}),
      },
    });
    return { status: response.status, body: await response.json() };
  }

  async function login(code) {
    const result = await http('/api/v1/auth/wechat', null, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'gy-i16-vis-login-' + code },
      body: JSON.stringify({ code }),
    });
    assert.equal(result.status, 200, '合成微信登录必须成功：' + JSON.stringify(result.body));
    return result.body.data.access_token;
  }

  /** 种一条**已核对 + 已发布**的合成资料（与 `tests/unit/knowledge-api.test.mjs` 同形）。 */
  async function seedPublishedKnowledge() {
    const admin = randomUUID();
    const source = randomUUID();
    const version = randomUUID();
    const knowledgeId = randomUUID();
    await db.query("INSERT INTO admin_accounts(id,login_name,credential_hash) VALUES($1,'synthetic-i16-vis-reviewer','synthetic-not-login')", [admin]);
    await db.query("INSERT INTO knowledge_dataset_modes(mode,description,accepts_database,accepts_verified_seed) VALUES('real','synthetic fixture only',true,true)");
    await db.query("INSERT INTO knowledge_dataset_config(key,value,mode) VALUES('active_mode','real','real'),('database_connected','true','real')");
    await db.query("INSERT INTO sources(id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES($1,'Synthetic i16 source','https://example.invalid/synthetic-i16','Synthetic publisher','verified_seed','research')", [source]);
    await db.query("INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,validity,review_status,reviewed_by,reviewed_at) VALUES($1,$2,'synthetic-i16-v1',repeat('a',64),'synthetic:i16',now(),now()-interval '1 day','valid','verified',$3,now())", [version, source, admin]);
    await db.query('UPDATE sources SET current_version_id=$1 WHERE id=$2', [version, source]);
    await db.query("INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,crop_ids,species_ids,region_codes,visibility) VALUES($1,$2,1,'Synthetic i16 material','Synthetic educational body only','species',$3,'[\"crop_rice\"]','[\"synthetic_weed\"]','[\"330102\"]','published')", [randomUUID(), knowledgeId, version]);
    return { knowledgeId, version, source };
  }

  /** 为同一 `knowledge_id` 发布**下一个修订**（改版 ⇒ 旧引用按 `REVISION_SUPERSEDED` 口径失效）。 */
  async function publishNextRevision(knowledgeId, version) {
    await db.query("INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,crop_ids,species_ids,region_codes,visibility) VALUES($1,$2,2,'Synthetic i16 material v2','Synthetic educational body only v2','species',$3,'[\"crop_rice\"]','[\"synthetic_weed\"]','[\"330102\"]','published')", [randomUUID(), knowledgeId, version]);
  }

  return {
    db,
    app,
    login,
    http,
    seedPublishedKnowledge,
    publishNextRevision,
    /** 收藏（POST /favorites；每个目标用独立幂等键）。 */
    async favorite(token, type, id, revision, seedKey) {
      return http(FAVORITES, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'gy-i16-vis-fav-' + seedKey },
        body: JSON.stringify({ target_ref: { type, id, revision } }),
      });
    },
    async close() {
      await app.close();
      await queue;
      await db.close();
    },
  };
}

const failNote = (response) => JSON.stringify(response.body);

test('收藏可见性接线③：未登录仍 401 SESSION_REQUIRED（登录门口径不变）', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  for (const method of ['GET', 'POST']) {
    const result = await f.http(FAVORITES, null, {
      method,
      ...(method === 'POST'
        ? {
            headers: { 'content-type': 'application/json', 'idempotency-key': 'gy-i16-vis-anon-1' },
            body: JSON.stringify({ target_ref: { type: 'species', id: ABSENT_ID, revision: 1 } }),
          }
        : {}),
    });
    assert.equal(result.status, 401, `${method} ${FAVORITES} 未登录必须 401：${failNote(result)}`);
    assert.equal(result.body.error.code, 'SESSION_REQUIRED');
    t.diagnostic(`${method} ${FAVORITES}（未登录）=> ${result.status} ${result.body.error.code}`);
  }
});

test('收藏可见性接线①：数据库读视图里当前可读的资料 ⇒ 收藏行「可用」；下架/改版/恢复逐次重派生', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const token = await f.login('synthetic-i16-vis-db');
  const { knowledgeId, version } = await f.seedPublishedKnowledge();

  // 读面自证：这条资料当前确实可读（列表与详情都能拿到，revision=1）。
  const detail = await f.http(`${KNOWLEDGE}/${knowledgeId}`, token);
  assert.equal(detail.status, 200, '合成资料必须在公开读面里：' + failNote(detail));
  assert.equal(detail.body.data.revision, 1);

  // ① 收藏当前可读资料 ⇒ 「可用」且没有不可用说明（＝「查看资料」可跳转）。
  const created = await f.favorite(token, 'species', knowledgeId, 1, '0001');
  assert.equal(created.status, 201, failNote(created));
  assert.equal(created.body.data.reference_state, 'available', '当前可读的资料收藏后必须显示「可用」：' + failNote(created));
  assert.equal(created.body.data.unavailable_reason, null);
  const favoriteId = created.body.data.id;
  t.diagnostic(`读数开（视图）：GET /knowledge/${knowledgeId} => 200 revision=${detail.body.data.revision}；POST /favorites => ${created.status} reference_state=${created.body.data.reference_state} unavailable_reason=${String(created.body.data.unavailable_reason)}`);

  const list = await f.http(FAVORITES, token);
  assert.equal(list.body.data.items.length, 1);
  assert.equal(list.body.data.items[0].id, favoriteId);
  assert.equal(list.body.data.items[0].reference_state, 'available');

  // ② 下架（`visibility='hidden'`：仓库既有的"下架"取值，见 `family`/`QUERYABLE_VISIBILITIES`）
  // ⇒ **同一收藏行**下一次读取即不可用；详情面同时 404（两面一致）。
  await f.db.query("UPDATE knowledge_versions SET visibility='hidden' WHERE knowledge_id=$1", [knowledgeId]);
  const afterWithdraw = await f.http(FAVORITES, token);
  assert.equal(afterWithdraw.body.data.items.length, 1, '下架不得删除收藏行本身');
  assert.equal(afterWithdraw.body.data.items[0].id, favoriteId, '必须是同一收藏行');
  assert.equal(afterWithdraw.body.data.items[0].reference_state, 'unavailable', '下架后同一收藏行必须变不可用');
  const reason = afterWithdraw.body.data.items[0].unavailable_reason;
  assert.equal(typeof reason, 'string');
  assert.ok(reason.length >= 1 && reason.length <= 80, 'unavailable_reason 必须落在契约 1..80 字符内');
  assert.equal((await f.http(`${KNOWLEDGE}/${knowledgeId}`, token)).status, 404, '下架后详情面必须与收藏面一致（不再可打开）');
  t.diagnostic(`下架（visibility=hidden）后同一收藏行 ${favoriteId} => reference_state=${afterWithdraw.body.data.items[0].reference_state} unavailable_reason=${String(reason)}；GET /knowledge/{id} => 404`);

  // 失效是**判定**而非不可逆标记：恢复上架后同一行重新可用（不重启、不重建行）。
  await f.db.query("UPDATE knowledge_versions SET visibility='published' WHERE knowledge_id=$1", [knowledgeId]);
  const back = await f.http(FAVORITES, token);
  assert.equal(back.body.data.items[0].id, favoriteId);
  assert.equal(back.body.data.items[0].reference_state, 'available', '恢复上架后同一收藏行必须重新可用');
  assert.equal(back.body.data.items[0].unavailable_reason, null);
  assert.equal((await f.http(`${KNOWLEDGE}/${knowledgeId}`, token)).status, 200);
  t.diagnostic(`恢复上架后同一收藏行 ${favoriteId} => reference_state=${back.body.data.items[0].reference_state} unavailable_reason=${String(back.body.data.items[0].unavailable_reason)}（失效是判定，不是不可逆标记）`);

  // 改版（新修订）⇒ 旧 `target_ref.revision` 不再可用（同审核域 `REVISION_SUPERSEDED` 口径）。
  await f.publishNextRevision(knowledgeId, version);
  const superseded = await f.http(FAVORITES, token);
  assert.equal(superseded.body.data.items[0].id, favoriteId);
  assert.equal(superseded.body.data.items[0].reference_state, 'unavailable', '版本已替换 ⇒ 旧引用不可用');
  assert.equal(typeof superseded.body.data.items[0].unavailable_reason, 'string');
  t.diagnostic(`改版（发布 revision=2）后同一收藏行 ${favoriteId} => reference_state=${superseded.body.data.items[0].reference_state}（旧 target_ref.revision=1）`);
});

test('收藏可见性接线②：`/knowledge` 列表里能读到的资料（浙江首批投影）收藏后必须「可用」且详情可打开', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const token = await f.login('synthetic-i16-vis-seed');

  // 与小程序收藏页同一取数口径：可收藏目标来自 `GET /knowledge` 列表。
  const list = await f.http(`${KNOWLEDGE}?limit=50`, token);
  assert.equal(list.status, 200, failNote(list));
  const items = list.body.data.items;
  assert.ok(items.length > 0, '浙江首批真实资料必须并入读面（否则本用例退化为空跑）');

  const picked = [];
  for (const type of ['species', 'herbicide', 'scheme']) {
    const item = items.find((entry) => entry.type === type);
    assert.ok(item !== undefined, `读面里必须有可收藏类型 ${type}（浙江首批三类齐全）`);
    picked.push(item);
  }

  let index = 0;
  for (const item of picked) {
    index += 1;
    // 「查看资料」可跳转：目标详情在**同一读面**里真的可打开。
    const detail = await f.http(`${KNOWLEDGE}/${item.id}`, token);
    assert.equal(detail.status, 200, `${item.type} 详情必须可打开：` + failNote(detail));
    assert.equal(detail.body.data.type, item.type);
    assert.equal(detail.body.data.revision, item.revision);

    // ① 收藏当前可读资料 ⇒ 「可用」。
    const created = await f.favorite(token, item.type, item.id, item.revision, '100' + index);
    assert.equal(created.status, 201, failNote(created));
    assert.equal(
      created.body.data.reference_state,
      'available',
      `${item.type} 是列表里当前可读的资料，收藏后必须显示「可用」：${failNote(created)}`,
    );
    assert.equal(created.body.data.unavailable_reason, null);
  }
  t.diagnostic(
    '读数开（浙江首批投影）：' + picked
      .map((item) => `${item.type} ${item.id} rev=${item.revision} → 详情 200、收藏行 available`)
      .join('；'),
  );

  const page = await f.http(FAVORITES, token);
  assert.equal(page.body.data.items.length, picked.length);
  for (const item of picked) {
    const row = page.body.data.items.find((entry) => entry.target_ref.id === item.id);
    assert.ok(row !== undefined, '收藏行必须仍在列表里');
    assert.equal(row.reference_state, 'available', `${item.type} 收藏行必须保持「可用」`);
    assert.equal(row.unavailable_reason, null);
  }

  // ④ 反例（fail-closed）：读面里没有的目标 / 类型不符 ⇒ 一律不可用，且说明落在契约闭集内，
  //    不区分"已下架"与"不存在"（不泄露存在性）。
  const missing = await f.favorite(token, 'species', ABSENT_ID, 1, '2001');
  assert.equal(missing.status, 201);
  assert.equal(missing.body.data.reference_state, 'unavailable', '读面里没有的目标必须保守判不可用');
  assert.equal(typeof missing.body.data.unavailable_reason, 'string');
  assert.ok(
    REFERENCE_UNAVAILABLE_REASONS.includes(missing.body.data.unavailable_reason),
    '不可用说明必须取自冻结闭集（不把内部原因改名后外泄）：' + String(missing.body.data.unavailable_reason),
  );

  const speciesItem = picked.find((item) => item.type === 'species');
  const wrongType = await f.favorite(token, 'scheme', speciesItem.id, speciesItem.revision, '2002');
  assert.equal(wrongType.status, 201);
  assert.equal(wrongType.body.data.reference_state, 'unavailable', '类型与读面不符 ⇒ 不得判可用');
  assert.deepEqual(wrongType.body.data.target_ref, {
    type: 'scheme',
    id: speciesItem.id,
    revision: speciesItem.revision,
  });
  t.diagnostic(
    `反例（fail-closed，不泄露存在性）：读面里没有的 id => ${missing.body.data.reference_state}`
    + `（${String(missing.body.data.unavailable_reason)}）；类型不符（把 species 资料声明成 scheme）=> ${wrongType.body.data.reference_state}`,
  );
});
