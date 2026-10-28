// GY-R68 · 断点钉钉子：**从 `/herbicides` 的 id 收藏必然 `unavailable`**（不改任何业务行为）。
//
// ## 这条断点是什么（本文件钉的"钉子"原文）
//
// `/herbicides` 与 `/knowledge` 是**两套 uuid**，同一份公告记录在两套读面里名字不同：
//   * `/herbicides/{id}`（contract `Herbicide`）：`packages/reference/records.mjs` 的
//     `toHerbicideContract` 用 `deterministicUuid(record.record_id)` 派生 id；
//   * `/knowledge` 的同一份记录（contract `Knowledge`）：同文件的 `toKnowledgeContract`
//     用 `deterministicUuid('knowledge:' + record.record_id)` 派生 id；
//   * 而收藏「引用可用性」的唯一权威是 `/knowledge` 的**公开读面**：`services/api/src/app.ts`
//     的 `publicKnowledgeRowOf` 只查两处 —— 数据库只读视图 `catalog_read.current_knowledge`，
//     以及浙江首批投影 `knowledge/reference-query.ts#toSeedRows`
//     （该投影的 id 是第三套：`deterministicUuid('zhejiang-knowledge:' + item_id)`）。
//
// ⇒ 用 `/herbicides` 的 id 去收藏，`publicKnowledgeRowOf` **永远查不到**这一行
//   （两套 id 对同一条记录必然不同，且与浙江种子 id 集合交集为 0）⇒ 解析器 fail-closed
//   判 `unavailable`。**这与数据是否核准无关**：`/knowledge` 里那些 `review_status='unverified'`
//   的未核准种子行照样能判 `available`（本文件用例 ② 分开断言这两条原因）。
//
// ## 本文件为什么是「负控制」而不是「功能回归」
//
// 本片**不修**这个断点（修它要动服务端契约面，属指挥/用户待裁定的两条出路之一）。
// 因此本文件的断言刻意钉在**今天的坏行为**上：断言写的是 `reference_state === 'unavailable'`。
// 一旦有人按出路 (a) 让解析器认 `/herbicides` 的 id，本文件**必须变红**——那是"钉子被拔了"的
// 正确信号，届时同批改断言，而不是让这条坏收藏静默留在线上。用例 ③ 就是这条性质的自证：
// 把解析器临时换成"任何 id 都 available"，①② 的断言必须整条变红。
//
// 数据来源全部是**合成夹具**（PGlite + 迁移），不连真库、不写仓内文件、不改 `services/**`。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import {
  REFERENCE_UNAVAILABLE_REASONS,
  OBJECT_UNAVAILABLE_REASON,
  createWiredVisibilityPort,
} from '../../services/api/src/targetref/visibility.ts';
import { deterministicUuid, loadHerbicideRecords } from '../../packages/reference/records.mjs';
import { loadZhejiangKnowledge } from '../../packages/reference/zhejiang.mjs';

// 与 `tests/unit/favorites-visibility-wiring.test.mjs` 同一开关、同一理由：必须在 `buildApp`
// **之前**设置（装配层与路由注册都在那时读它），且**不得**写成模块级赋值（`--test-isolation=none`
// 下会一路带到后面跑的文件）。故「用例内打开 + 结束复原」，复原本身是断言。
const UNVERIFIED_SEED = 'APP_KNOWLEDGE_UNVERIFIED_SEED';
const UNVERIFIED_SEED_AT_LOAD = process.env[UNVERIFIED_SEED];

function armUnverifiedSeed(t) {
  const previous = process.env[UNVERIFIED_SEED];
  process.env[UNVERIFIED_SEED] = '1';
  t.after(() => {
    if (previous === undefined) delete process.env[UNVERIFIED_SEED];
    else process.env[UNVERIFIED_SEED] = previous;
    assert.equal(process.env[UNVERIFIED_SEED], previous, `用例结束后必须复原 ${UNVERIFIED_SEED}（不得跨文件泄漏）`);
  });
}

const FAVORITES = '/api/v1/favorites';
const HERBICIDES = '/api/v1/herbicides';
const KNOWLEDGE = '/api/v1/knowledge';
const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const failNote = (response) => JSON.stringify(response.body);

/**
 * 最小 PGlite 夹具（与 `favorites-visibility-wiring.test.mjs` 同形，未发明新框架）。
 *
 * @param {{ permissiveVisibility?: boolean }} [options]
 *   `permissiveVisibility` —— **仅用于用例 ③ 的负控制**：经 `buildApp` 的公开注入缝
 *   `favoritesInjection.visibility` 换掉"引用可用性解析器"，让**任何** id 都判 `available`。
 *   ⛔ 这不是生产装配（生产默认见 `app.ts` 的 `defaultVisibility`），只用来证明用例 ①②
 *   真的在看解析结果。
 */
async function fixture(options = {}) {
  const db = new PGlite();
  for (const name of [
    '0001_initial_schema',
    '0002_knowledge_catalog',
    '0003_privacy_consent',
    '0005_catalog_read_views',
    '0008_auth_session',
    '0009_consent_policy',
    '0010_knowledge_read_views',
    '0012_knowledge_created_at',
  ]) {
    await db.exec(read('services/api/db/migrations/' + name + '.sql'));
  }
  for (const name of ['auth_privacy', 'knowledge_runtime']) {
    await db.exec(read('services/api/db/roles/' + name + '.sql'));
  }
  await db.exec('CREATE ROLE gy_r68_test_runtime NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT gengyun_auth_privacy,gengyun_knowledge_runtime TO gy_r68_test_runtime');
  // PGlite 只有一条连接：队列串行化，每段查询在自己的 `SET ROLE` 会话里完成。
  let queue = Promise.resolve();
  const pool = {
    async connect() {
      const before = queue;
      let unlock;
      queue = new Promise((resolve) => { unlock = resolve; });
      await before;
      await db.query('SET ROLE gy_r68_test_runtime');
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
    ...(options.permissiveVisibility === true
      ? {
          favoritesInjection: {
            visibility: createWiredVisibilityPort({
              note: '负控制（仅测试注入）：任何 id 都判 available，用于证明用例真的在看解析结果',
              resolve: async () => 'available',
            }),
          },
        }
      : {}),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = 'http://127.0.0.1:' + app.server.address().port;

  async function http(path, token, requestOptions = {}) {
    const response = await fetch(origin + path, {
      ...requestOptions,
      headers: {
        ...(token === null ? {} : { authorization: 'Bearer ' + token }),
        ...(requestOptions.headers ?? {}),
      },
    });
    return { status: response.status, body: await response.json() };
  }

  async function login(code) {
    const result = await http('/api/v1/auth/wechat', null, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'gy-r68-login-' + code },
      body: JSON.stringify({ code }),
    });
    assert.equal(result.status, 200, '合成微信登录必须成功：' + failNote(result));
    return result.body.data.access_token;
  }

  /** 收藏（POST /favorites；每个目标用独立幂等键，避免幂等重放掩盖第二次读数）。 */
  async function favorite(token, type, id, revision, seedKey) {
    return http(FAVORITES, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'gy-r68-fav-' + seedKey },
      body: JSON.stringify({ target_ref: { type, id, revision } }),
    });
  }

  /** 把 `/knowledge` 整个读面翻完（契约排序 `created_at DESC, id DESC`，单页上限 50）。 */
  async function allKnowledge(token) {
    const items = [];
    let cursor = null;
    for (let page = 0; page < 40; page += 1) {
      const list = await http(`${KNOWLEDGE}?limit=50` + (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`), token);
      assert.equal(list.status, 200, '读面列表必须可读：' + failNote(list));
      items.push(...list.body.data.items);
      cursor = list.body.data.next_cursor;
      if (cursor === null) break;
    }
    assert.equal(cursor, null, '读面必须能翻到末页（否则"交集为 0"的断言不成立）');
    return items;
  }

  /**
   * 合成一条**已核对 + 已发布**的资料行（与 `favorites-visibility-wiring.test.mjs` 同形），
   * 但 `knowledge_id` 由调用方指定 —— 用例 ② 用它把"同一条公告记录换一套 id 拼法"这一
   * **单一变量**隔离出来。标题显式写"合成"，不被误读为真实核准资料。
   */
  async function seedPublishedKnowledge(knowledgeId, title) {
    const admin = randomUUID();
    const source = randomUUID();
    const version = randomUUID();
    await db.query("INSERT INTO admin_accounts(id,login_name,credential_hash) VALUES($1,'synthetic-r68-reviewer','synthetic-not-login')", [admin]);
    await db.query("INSERT INTO knowledge_dataset_modes(mode,description,accepts_database,accepts_verified_seed) VALUES('real','synthetic fixture only',true,true) ON CONFLICT DO NOTHING");
    await db.query("INSERT INTO knowledge_dataset_config(key,value,mode) VALUES('active_mode','real','real'),('database_connected','true','real') ON CONFLICT DO NOTHING");
    await db.query("INSERT INTO sources(id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES($1,'Synthetic r68 source','https://example.invalid/synthetic-r68','Synthetic publisher','verified_seed','research')", [source]);
    await db.query("INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,validity,review_status,reviewed_by,reviewed_at) VALUES($1,$2,'synthetic-r68-v1',repeat('b',64),'synthetic:r68',now(),now()-interval '1 day','valid','verified',$3,now())", [version, source, admin]);
    await db.query('UPDATE sources SET current_version_id=$1 WHERE id=$2', [version, source]);
    await db.query("INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,crop_ids,species_ids,region_codes,visibility) VALUES($1,$2,1,$3,'Synthetic educational body only（合成夹具，仅用于隔离 id 变量）','herbicide',$4,'[\"crop_rice\"]','[\"synthetic_weed\"]','[\"330102\"]','published')", [randomUUID(), knowledgeId, title, version]);
    return { knowledgeId, version };
  }

  return {
    db,
    app,
    http,
    login,
    favorite,
    allKnowledge,
    seedPublishedKnowledge,
    async close() {
      await app.close();
      await queue;
      await db.close();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 用例 0（纯函数，无 HTTP）：两套 id 对**同一条记录**必然不同，且与浙江种子 id 集合无交集。
// 这条是断点的根因口算，跑得最快，红了说明"两套 id"这个前提本身变了。
// ─────────────────────────────────────────────────────────────────────────────
test('R68-0 断点根因：`/herbicides` 的 id 与 `/knowledge` 的 id 是同一条记录的两套 uuid（交集为 0）', (t) => {
  const records = loadHerbicideRecords();
  assert.equal(records.skipped.length, 0, '20 条公告记录都应通过契约前提门禁（否则下面的口算分母不对）');
  assert.equal(records.items.length, 20, '公告记录应为 20 条');

  const pairs = records.items.map((item) => ({
    recordId: item.record_id,
    // `/herbicides/{id}` 的 id（`toHerbicideContract`）
    herbicideId: item.contract.id,
    // 同一份记录在 `/knowledge` 拼法下的 id（`toKnowledgeContract`）
    knowledgeId: item.knowledge.id,
  }));

  for (const pair of pairs) {
    assert.equal(
      pair.herbicideId,
      deterministicUuid(pair.recordId),
      `\`/herbicides\` 的 id 必须逐字等于 deterministicUuid(record_id)：${pair.recordId}`,
    );
    assert.equal(
      pair.knowledgeId,
      deterministicUuid('knowledge:' + pair.recordId),
      `\`/knowledge\` 的 id 必须逐字等于 deterministicUuid('knowledge:'+record_id)：${pair.recordId}`,
    );
    assert.notEqual(pair.herbicideId, pair.knowledgeId, `同一条记录的两套 id 不得相同：${pair.recordId}`);
  }

  // 与浙江首批投影（收藏解析器**唯一**会认的第二处来源）的 id 集合取交集。
  const zhejiangIds = new Set(loadZhejiangKnowledge().items.map((item) => item.knowledge.id));
  assert.ok(zhejiangIds.size > 0, '浙江首批投影必须非空（否则"交集为 0"是空跑）');
  const overlapping = pairs.filter((pair) => zhejiangIds.has(pair.herbicideId));
  assert.equal(overlapping.length, 0, '`/herbicides` 的 id 不得与浙江首批 id 撞上任一（两套命名空间互不相认）');

  // 同一份投影里还要自证：浙江种子的 id 也不是 `deterministicUuid('knowledge:'+…)` 那套。
  const zhejiangHerbicideIds = loadZhejiangKnowledge().items
    .filter((item) => item.knowledge.type === 'herbicide')
    .map((item) => item.knowledge.id);
  assert.ok(zhejiangHerbicideIds.length > 0, '浙江首批里必须有 herbicide 条目（用例 ② 的对照来源）');
  const knowledgeSpaceHits = pairs.filter((pair) => zhejiangIds.has(pair.knowledgeId));
  assert.equal(knowledgeSpaceHits.length, 0, '公告记录的 `/knowledge` 拼法 id 也不在浙江首批 id 集合里（第三套命名空间）');

  t.diagnostic(
    `读数 20 条公告记录：/herbicides id=deterministicUuid(record_id)、/knowledge id=deterministicUuid('knowledge:'+record_id)，`
    + `两套对同一条记录全部不同（0/20 相同）；与浙江首批 ${zhejiangIds.size} 条 id 交集 0；`
    + `样本 ${pairs[0].recordId}：herbicide=${pairs[0].herbicideId} / knowledge=${pairs[0].knowledgeId}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 用例 ①（负控制本体）：`/herbicides` 列表里取一个 id ⇒ POST /favorites 201 但永不 available。
// ─────────────────────────────────────────────────────────────────────────────
test('R68-① 从 `/herbicides` 取 id 收藏 ⇒ 201 且 `reference_state=unavailable`（理由码在冻结闭集内）', async (t) => {
  armUnverifiedSeed(t);
  const f = await fixture();
  t.after(() => f.close());
  const token = await f.login('synthetic-r68-herbicide-favorite');

  // 读面自证：`/herbicides` 列表本身可读（不是"路由坏了"）。
  const herbicideList = await f.http(HERBICIDES, token);
  assert.equal(herbicideList.status, 200, '/herbicides 列表必须可读：' + failNote(herbicideList));
  const herbicideItems = herbicideList.body.data.items;
  assert.equal(herbicideItems.length, 20, '公告记录 20 条应全部可读');
  const target = herbicideItems[0];
  assert.equal(target.revision, 1);
  assert.equal(typeof target.id, 'string');

  // 对照组自证：同一夹具里 `/knowledge` 读面**非空**（159 条浙江首批投影）
  // ⇒ 下面那条 unavailable 不可能由"读面为空"解释，只能是"这个 id 不在读面里"。
  const knowledgeItems = await f.allKnowledge(token);
  assert.ok(knowledgeItems.length > 0, '浙江首批投影必须并入读面（否则本用例退化为"读面为空"的平凡断言）');
  const knowledgeIds = new Set(knowledgeItems.map((item) => item.id));
  const leaked = herbicideItems.filter((item) => knowledgeIds.has(item.id));
  assert.equal(
    leaked.length,
    0,
    '`/herbicides` 的 id 不得出现在 `/knowledge` 读面里（20 条逐条核对）：实际命中 ' + leaked.length + ' 条',
  );

  // 收藏它。
  const created = await f.favorite(token, 'herbicide', target.id, target.revision, '0001');
  assert.equal(created.status, 201, '收藏必须**成功**（坏收藏比被拒更糟：用户以为收藏到了）：' + failNote(created));
  assert.equal(
    created.body.data.reference_state,
    'unavailable',
    '从 `/herbicides` 取来的 id 收藏后必然 unavailable（本片不修，只钉住）：' + failNote(created),
  );
  assert.equal(created.body.data.unavailable_reason, OBJECT_UNAVAILABLE_REASON, '理由必须是"对象侧"那条（不区分下架与不存在）');
  assert.ok(
    REFERENCE_UNAVAILABLE_REASONS.includes(created.body.data.unavailable_reason),
    '不可用说明必须取自冻结闭集：' + String(created.body.data.unavailable_reason),
  );

  // 列表读数与创建读数一致（派生逐次重算，不是一次性写死）。
  const list = await f.http(FAVORITES, token);
  assert.equal(list.status, 200, failNote(list));
  assert.equal(list.body.data.items.length, 1);
  const row = list.body.data.items[0];
  assert.equal(row.id, created.body.data.id, '必须是同一收藏行');
  assert.deepEqual(row.target_ref, { type: 'herbicide', id: target.id, revision: target.revision }, '收藏行记的 id 就是 `/herbicides` 那套');
  assert.equal(row.reference_state, 'unavailable', '收藏页再读一次仍是 unavailable');
  assert.ok(REFERENCE_UNAVAILABLE_REASONS.includes(row.unavailable_reason));

  t.diagnostic(
    `读数：/herbicides 列表 ${herbicideItems.length} 条 / 首条 id=${target.id}；`
    + `/knowledge 读面 ${knowledgeItems.length} 条且与 20 条 herbicide id 交集 0；`
    + `POST /favorites => ${created.status} reference_state=${created.body.data.reference_state} `
    + `unavailable_reason=${JSON.stringify(created.body.data.unavailable_reason)}；`
    + `GET /favorites 同一行 => ${row.reference_state}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 用例 ②（对照，两条原因**分开**断言）：坏的**不是**"数据未核准"，是"id 不认"。
// ─────────────────────────────────────────────────────────────────────────────
test('R68-② 对照：未核准 ≠ 不可用（原因甲）；同一记录换 `/knowledge` 的 id 拼法即可用（原因乙）', async (t) => {
  armUnverifiedSeed(t);
  const f = await fixture();
  t.after(() => f.close());
  const token = await f.login('synthetic-r68-cause-separation');
  const knowledgeItems = await f.allKnowledge(token);

  // ── 原因甲：「数据未核准」**不**导致 unavailable ────────────────────────────
  // 浙江首批 159 条全是 `review_status='unverified'`（未核对）+ `visibility='private'`（未发布），
  // 但它们照样落 `available` —— 因为可用性判的是"在不在读面里"，不是"核没核准"。
  const seedHerbicide = knowledgeItems.find((item) => item.type === 'herbicide');
  assert.ok(seedHerbicide !== undefined, '读面里必须有 herbicide 类型的浙江首批条目');
  assert.equal(
    seedHerbicide.source.review_status,
    'unverified',
    '浙江首批必须如实标「未核对」（这不是本片要改的东西）：' + JSON.stringify(seedHerbicide.source),
  );
  const unverifiedFavorite = await f.favorite(token, 'herbicide', seedHerbicide.id, seedHerbicide.revision, '1001');
  assert.equal(unverifiedFavorite.status, 201, failNote(unverifiedFavorite));
  assert.equal(
    unverifiedFavorite.body.data.reference_state,
    'available',
    '【原因甲】未核准的读面行照样 available ⇒ "源未核准"解释不了 `/herbicides` id 的 unavailable：'
    + failNote(unverifiedFavorite),
  );
  assert.equal(unverifiedFavorite.body.data.unavailable_reason, null);

  // ── 原因乙：「id 不认」——同一条公告记录，两套拼法，一个可用一个不可用 ────────
  // 合成发布一条 knowledge 行，`knowledge_id` 取 `deterministicUuid('knowledge:'+record_id)`，
  // 即"同一个 record_id 在 `/knowledge` 命名空间下的那个 id"。除 id 拼法外一切相同。
  const record = loadHerbicideRecords().items[0];
  const knowledgeSpelling = deterministicUuid('knowledge:' + record.record_id);
  const herbicideSpelling = deterministicUuid(record.record_id);
  assert.equal(herbicideSpelling, record.contract.id, '与 `/herbicides` 契约里的 id 必须是同一个值');
  await f.seedPublishedKnowledge(knowledgeSpelling, '合成夹具：同一条公告记录的 /knowledge id 拼法');

  // `/knowledge` 拼法：读得到、收藏即可用。
  const knowledgeDetail = await f.http(`${KNOWLEDGE}/${knowledgeSpelling}`, token);
  assert.equal(knowledgeDetail.status, 200, '合成发布行必须可读：' + failNote(knowledgeDetail));
  const knowledgeSpellingFavorite = await f.favorite(token, 'herbicide', knowledgeSpelling, 1, '1002');
  assert.equal(knowledgeSpellingFavorite.status, 201, failNote(knowledgeSpellingFavorite));
  assert.equal(
    knowledgeSpellingFavorite.body.data.reference_state,
    'available',
    '【原因乙】`/knowledge` 拼法的同一条记录必须 available：' + failNote(knowledgeSpellingFavorite),
  );

  // `/herbicides` 拼法：同一条记录、同一类型、同样已"发布"，仍然 unavailable。
  const herbicideSpellingFavorite = await f.favorite(token, 'herbicide', herbicideSpelling, 1, '1003');
  assert.equal(herbicideSpellingFavorite.status, 201, failNote(herbicideSpellingFavorite));
  assert.equal(
    herbicideSpellingFavorite.body.data.reference_state,
    'unavailable',
    '【原因乙】`/herbicides` 拼法的同一条记录必须 unavailable —— 唯一的差别就是 id：'
    + failNote(herbicideSpellingFavorite),
  );
  assert.ok(REFERENCE_UNAVAILABLE_REASONS.includes(herbicideSpellingFavorite.body.data.unavailable_reason));

  // 两条原因各自的判据互不重叠：甲的判据是"未核准但可用"，乙的判据是"同记录同类型，只有 id 不同"。
  assert.notEqual(knowledgeSpelling, herbicideSpelling, '两套拼法必须不同（否则上面那对读数无从解释）');

  t.diagnostic(
    `读数【原因甲·数据未核准】：浙江首批 herbicide id=${seedHerbicide.id} `
    + `review_status=${seedHerbicide.source.review_status} ⇒ 收藏 ${unverifiedFavorite.status} `
    + `reference_state=${unverifiedFavorite.body.data.reference_state}`
    + `（未核准不影响可用性判定）；`
    + `读数【原因乙·id 不认】：同一条记录 ${record.record_id}，`
    + `knowledge 拼法 ${knowledgeSpelling} ⇒ ${knowledgeSpellingFavorite.body.data.reference_state}；`
    + `herbicides 拼法 ${herbicideSpelling} ⇒ ${herbicideSpellingFavorite.body.data.reference_state}`
    + `（${String(herbicideSpellingFavorite.body.data.unavailable_reason)}）`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 用例 ③（负控制）：把解析器临时换成"任何 id 都 available" ⇒ ①②的断言必红。
// 走 `buildApp` 的公开注入缝 `favoritesInjection.visibility`，**不改 `services/**` 一个字节**。
// ─────────────────────────────────────────────────────────────────────────────
test('R68-③ 负控制：解析器改成"任何 id 都 available"后，①②的断言必红（证明用例真在看解析结果）', async (t) => {
  armUnverifiedSeed(t);
  const f = await fixture({ permissiveVisibility: true });
  t.after(() => f.close());
  const token = await f.login('synthetic-r68-negative-control');

  const herbicideList = await f.http(HERBICIDES, token);
  assert.equal(herbicideList.status, 200, failNote(herbicideList));
  const target = herbicideList.body.data.items[0];

  // 同一个探针，换了"解析器"这一个变量。
  const created = await f.favorite(token, 'herbicide', target.id, 1, '2001');
  assert.equal(created.status, 201, failNote(created));
  assert.equal(
    created.body.data.reference_state,
    'available',
    '负控制前提：注入"任何 id 都 available"的解析器后，读数必须翻成 available（否则注入缝没生效）',
  );

  // 把 ① 的断言原样再跑一遍，必须抛错 —— 这就是"钉子没白钉"的证据。
  assert.throws(
    () => assert.equal(created.body.data.reference_state, 'unavailable', 'R68-①'),
    /R68-①/,
    '负控制成立：把可用性解析器换成"任何 id 都 available"，用例 ① 的核心断言必须变红',
  );

  // ② 的两条原因断言在负控制下同样失去区分度：`unavailable` 那条（原因乙的读数）也翻成 available。
  const knowledgeItems = await f.allKnowledge(token);
  const seedHerbicide = knowledgeItems.find((item) => item.type === 'herbicide');
  assert.ok(seedHerbicide !== undefined, '负控制下读面仍须非空');
  const herbicideSpelling = deterministicUuid(loadHerbicideRecords().items[0].record_id);
  const flipped = await f.favorite(token, 'herbicide', herbicideSpelling, 1, '2002');
  assert.equal(flipped.body.data.reference_state, 'available', '负控制下 `/herbicides` 拼法也翻成 available');
  assert.throws(
    () => assert.equal(flipped.body.data.reference_state, 'unavailable', 'R68-②原因乙'),
    /R68-②原因乙/,
    '负控制成立：② 的"id 不认"断言同样必须变红',
  );

  t.diagnostic(
    '读数（负控制·注入任何 id 都 available）：`/herbicides` 首条 id=' + target.id
    + ` ⇒ ${created.body.data.reference_state}（生产默认装配下是 unavailable）；`
    + `同一条记录的 /herbicides 拼法 ⇒ ${flipped.body.data.reference_state}`
    + ' ⇒ ①②的核心断言在负控制下双双变红，证明它们看的是解析结果',
  );
});

// 文件级自证（默认隔离下恒真；`--test-isolation=none` 下才是真检查）。
after(() => {
  assert.equal(
    process.env[UNVERIFIED_SEED],
    UNVERIFIED_SEED_AT_LOAD,
    `${UNVERIFIED_SEED} 在本文件跑完后仍未复原（跨文件环境变量泄漏）`,
  );
});
