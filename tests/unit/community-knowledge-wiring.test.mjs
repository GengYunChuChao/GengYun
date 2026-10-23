/**
 * #15（GY-I15）· S4「杂草／药剂关联」**装配层接线**的回归（`Refs #15`）。
 *
 * ## 本文件测的是哪一层（与既有用例的分工）
 *
 * `tests/unit/community-http.test.mjs` 的两条 `HTTP 知识关联…` 用例**注入**了
 * `createKnowledgeAvailabilityPort(...)` 替身，证明的是**服务层**语义（未接线 ⇒ 409；已接线 ⇒
 * 只认已核对非模拟资料；编辑遗漏保留旧值）。它们**覆盖不到装配层**：装配层此前只有
 * `import type` + 一个永不使用的注入位，生产路径从不构造真实端口 —— 这正是 S4 能长期滞留的原因。
 *
 * 本文件**不注入** `knowledge`，跑的是 `buildApp` 的**生产默认装配**，因此它锁定的命题是：
 * 「装配层到底有没有按『有没有真库』把真实端口接上」。这条命题在接线前**必须红**。
 *
 * ## 两条臂（缺一不可）
 *
 * 1. **有连接池** ⇒ 装配层用**同一条 pool** 查公开读视图 `catalog_read.current_knowledge`
 *    （真实 PGlite + 真实迁移 0001/0002/0005/0010/0012 + 只授 `gengyun_knowledge_runtime` 的
 *    受限运行角色，与生产 `20-login-roles.sql` 的授权形状一致）：
 *      - 已核对 + 已发布 + 当前生效的资料 ⇒ 201，`linked_knowledge.reference_state='available'`，
 *        摘要标题来自读视图（装配层若不接线，这里恒为 409）；
 *      - **读取时逐次现查**：同一目标下架后，同一条帖子的投影立刻转 `unavailable`
 *        （`linked_knowledge_ref` 仍原样保留，符合契约「原已保存失效引用可原样保留」）。
 * 2. **无连接池** ⇒ 仍是**未接线**端口（fail-closed）：新增关联 409 `OBJECT_UNAVAILABLE`
 *    且不落内容行；同一个装配里**不带关联**的投稿仍 201 —— 证明这条臂不是"什么都 409"。
 *
 * ## 负控制（都在臂 1 里，逐条实测，错误码与语义**不得**变化）
 *
 * 目标不存在 / 已下架（存在但不可见）/ 版本不符 / 类型不符 ⇒ 一律 409 `OBJECT_UNAVAILABLE`；
 * 其中「存在但不可见」与「不存在」的响应体**逐字节同形**（不泄露资料是否存在）。
 *
 * ## 声明（不得误读）
 *
 * 账号、正文与资料行都是**合成夹具**；本文件**不是**真实审核／真实供应商／真机证据，
 * 也不证明小程序发帖页提供了填写入口（`miniprogram/pages/communitycreate/communitycreate.js`
 * 仍不传 `linked_knowledge_ref`，属未取得项）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { CLEAN_BODY, CLEAN_TITLE, makeGate, makeSyntheticPassPort } from './community-fixtures.mjs';
import { frozenModerationInjection } from './stall-hygiene-fixtures.mjs';
import { createPublicPostingConsent } from './community-posting-consent-fixtures.mjs';

const API = '/api/v1';
const START = Date.UTC(2026, 9, 23, 4, 0, 0);
/** 合法 uuid 但库里没有 ⇒ 走"目标不存在"分支（不是格式错误）。 */
const ABSENT = '00000000-0000-4000-8000-000000000000';
const LINK_TITLE = '合成除草剂：水稻田使用要点（装配级夹具）';
const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');

function postBody(over = {}) {
  return { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [], ...over };
}
/** 写头：`Idempotency-Key`（契约要求 8..128 字符）。 */
const write = (key) => ({ 'idempotency-key': key });

/**
 * PGlite 夹具：迁移 + **只授 `gengyun_knowledge_runtime`** 的受限运行角色 + 单连接串行化。
 *
 * 只跑与资料读视图有关的最小迁移集（0001→0002→0005→0010→0012，后三条是从 0005 起的依赖链）；
 * 社区域在本文件里用**内存 store**（与"有没有池"这条判据无关：`communityKnowledge` 只看 `pool`）。
 */
async function pglitePool(t) {
  const db = new PGlite();
  for (const name of [
    '0001_initial_schema',
    '0002_knowledge_catalog',
    '0005_catalog_read_views',
    '0010_knowledge_read_views',
    '0012_knowledge_created_at',
  ]) {
    await db.exec(read('services/api/db/migrations/' + name + '.sql'));
  }
  // 与 `deploy/postgres-cvm/sql/20-login-roles.sql` 同形：运行角色**只**继承资料只读组。
  await db.exec(read('services/api/db/roles/knowledge_runtime.sql'));
  await db.exec(
    'CREATE ROLE gy_s4_knowledge_runtime NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;'
    + ' GRANT gengyun_knowledge_runtime TO gy_s4_knowledge_runtime',
  );
  // PGlite 只有一条连接：用队列串行化，每段查询在自己的 `SET ROLE` 会话里完成
  // （与 `tests/unit/favorites-visibility-wiring.test.mjs`／`knowledge-api.test.mjs` 同一夹具口径）。
  let queue = Promise.resolve();
  /** 记录池上真正执行过的 SQL 文本（断言"装配层用的是**这一条** pool 的公开读视图"）。 */
  const queries = [];
  const pool = {
    async connect() {
      const before = queue;
      let unlock;
      queue = new Promise((resolve) => { unlock = resolve; });
      await before;
      await db.query('SET ROLE gy_s4_knowledge_runtime');
      return {
        query: (...args) => db.query(...args),
        release() { db.query('RESET ROLE').finally(unlock); },
      };
    },
    async query(...args) {
      const [text] = args;
      if (typeof text === 'string') queries.push(text);
      else if (text !== null && typeof text === 'object' && typeof text.text === 'string') queries.push(text.text);
      const client = await this.connect();
      try { return await client.query(...args); } finally { client.release(); }
    },
  };
  t.after(() => db.close());
  return { db, pool, queries };
}

/**
 * 种一条**已核对 + 已发布**的合成资料（与 `tests/unit/knowledge-api.test.mjs` 同形）。
 * `visibility` 允许直接种"存在但已下架"的行，用于"不泄露存在性"的同形负控制。
 */
async function seedKnowledge(db, { title, type = 'herbicide', visibility = 'published' }) {
  const admin = randomUUID();
  const source = randomUUID();
  const version = randomUUID();
  const knowledgeId = randomUUID();
  await db.query(
    "INSERT INTO admin_accounts(id,login_name,credential_hash) VALUES($1,$2,'synthetic-not-login')",
    [admin, 'synthetic-s4-reviewer-' + admin.slice(0, 8)],
  );
  await db.query(
    "INSERT INTO knowledge_dataset_modes(mode,description,accepts_database,accepts_verified_seed) VALUES('real','synthetic fixture only',true,true) ON CONFLICT DO NOTHING",
  );
  await db.query(
    "INSERT INTO knowledge_dataset_config(key,value,mode) VALUES('active_mode','real','real'),('database_connected','true','real') ON CONFLICT DO NOTHING",
  );
  await db.query(
    "INSERT INTO sources(id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES($1,'Synthetic S4 source',$2,'Synthetic publisher','verified_seed','research')",
    [source, 'https://example.invalid/synthetic-s4-' + source.slice(0, 8)],
  );
  await db.query(
    "INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,validity,review_status,reviewed_by,reviewed_at) VALUES($1,$2,'synthetic-s4-v1',repeat('b',64),'synthetic:s4',now(),now()-interval '1 day','valid','verified',$3,now())",
    [version, source, admin],
  );
  await db.query('UPDATE sources SET current_version_id=$1 WHERE id=$2', [version, source]);
  await db.query(
    "INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,crop_ids,species_ids,region_codes,visibility) VALUES($1,$2,1,$3,'Synthetic educational body only',$4,$5,'[\"crop_rice\"]','[\"synthetic_weed\"]','[\"330102\"]',$6)",
    [randomUUID(), knowledgeId, title, type, version, visibility],
  );
  return { knowledgeId };
}

/**
 * `buildApp` 的**生产默认装配**（不传 `knowledge`）。
 *
 * 唯一变量是 `options.pool`：给了就是"有真库"，不给就是"无真库"。
 * 社区 store / 消息 store / 主体存储都走内存替身，与"资料读取口接不接线"无关 ——
 * 这样两条臂的差异只剩 `pool` 一个，避免把别的接线差异混进结论。
 */
async function makeApp(t, options = {}) {
  const time = START;
  const auth = createMemoryAuthStore();
  const community = createMemoryCommunityStore({ now: () => time });
  const messages = createMemoryMessagesStore({ now: () => time });
  const publicPosting = createPublicPostingConsent();
  const config = loadConfig({
    APP_EXECUTION_MODE: 'stub',
    LOG_LEVEL: 'silent',
    SESSION_SIGNING_KEY: randomBytes(32).toString('hex'),
  });
  const app = buildApp({
    config,
    ...(options.pool === undefined ? {} : { pool: options.pool }),
    store: auth,
    now: () => new Date(time),
    privacyInjection: { consent: publicPosting.gate },
    messagesInjection: { store: messages },
    // **注意**：这里没有 `knowledge` —— 测的就是缺省装配。
    communityInjection: { store: community, gate: makeGate() },
    moderationInjection: frozenModerationInjection({
      executionMode: config.executionMode,
      ports: { tms: makeSyntheticPassPort('tms') },
      store: community,
    }),
  });
  async function user(subject) {
    const created = await auth.createUser(subject.repeat(64));
    const token = `synthetic-s4-knowledge-token-${subject}`;
    await auth.createSession({
      userId: created.id,
      tokenHashHex: hashToken(token),
      authEpoch: created.authEpoch,
      expiresAt: new Date(START + 48 * 3600_000),
      audience: 'user',
    });
    await publicPosting.grant(created.id);
    return { user: created, token };
  }
  const a = await user('a');
  const b = await user('b');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = 'http://127.0.0.1:' + app.server.address().port;
  t.after(() => app.close());
  async function call(method, path, actor = a, { headers = {}, payload } = {}) {
    const response = await fetch(url + path, {
      method,
      headers: {
        ...(actor === null ? {} : { authorization: 'Bearer ' + actor.token }),
        ...headers,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? null : JSON.parse(text),
      etag: response.headers.get('etag'),
      cache: response.headers.get('cache-control'),
    };
  }
  return { app, community, a, b, call, publicPosting };
}

/** 契约错误封套（状态码 + 错误码 + no-store，且**无成功封套**）。 */
function assertContractError(result, status, code) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code, JSON.stringify(result.body));
  assert.equal(typeof result.body.error.message, 'string');
  assert.equal(result.body.error.retryable, false, '关联不可用不是可重试错误');
  assert.equal(result.body.data, undefined, '错误响应不得携带成功封套');
  assert.equal(result.body.meta.contract_version, '1.0.0');
  assert.equal(result.cache, 'no-store');
}

/** 去掉每次请求都会变的 `meta.request_id`，用于"逐字节同形"比较。 */
function withoutRequestId(body) {
  const copy = JSON.parse(JSON.stringify(body));
  if (copy.meta !== undefined) copy.meta.request_id = undefined;
  return copy;
}

// ---------------------------------------------------------------------------
// 臂 ②：无连接池 ⇒ 仍 fail-closed（未接线端口）
// ---------------------------------------------------------------------------

test('装配级（无池）：关联读取口保持未接线 ⇒ 新增关联 409 OBJECT_UNAVAILABLE 且不落内容行', async (t) => {
  // 生产默认装配，**不传 pool**（＝没配 DATABASE_URL），也不注入 knowledge。
  const h = await makeApp(t);

  // 关联目标本身给的是合法 uuid：409 来自"读不到可用性"，不是入参校验。
  const linked = await h.call('POST', `${API}/posts`, h.a, {
    headers: write('gy-s4-nopool-link-1'),
    payload: postBody({ linked_knowledge_ref: { type: 'herbicide', id: ABSENT, revision: 1 } }),
  });
  assertContractError(linked, 409, 'OBJECT_UNAVAILABLE');
  assert.equal(h.community.snapshotCounts().posts, 0, '关联不可用时不得落内容行');

  // 对照：同一装配里"不带关联"的投稿仍 201 —— 说明 409 只来自关联闸，不是整域不可用。
  const plain = await h.call('POST', `${API}/posts`, h.a, {
    headers: write('gy-s4-nopool-plain-1'),
    payload: postBody(),
  });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal(plain.body.data.linked_knowledge_ref, null);
  assert.equal(plain.body.data.linked_knowledge, null);
  assert.equal(h.community.snapshotCounts().posts, 1);

  t.diagnostic(
    `无池装配：POST /posts（带 linked_knowledge_ref）=> ${linked.status} ${linked.body.error.code}；`
    + `同一装配不带关联 => ${plain.status}（posts=${h.community.snapshotCounts().posts}）`,
  );
});

// ---------------------------------------------------------------------------
// 臂 ①：有连接池 ⇒ 装配层构造真实端口（同一 pool 查公开读视图）
// ---------------------------------------------------------------------------

test('装配级（有池）：默认装配用同一 pool 查公开读视图 ⇒ 已核对有效资料可挂上，且读取时逐次现查', async (t) => {
  const { db, pool, queries } = await pglitePool(t);
  const visible = await seedKnowledge(db, { title: LINK_TITLE });
  const h = await makeApp(t, { pool });
  const link = { type: 'herbicide', id: visible.knowledgeId, revision: 1 };

  // ① 正控制：装配层若没接线，这里恒为 409（＝接线前的实际行为）。
  const created = await h.call('POST', `${API}/posts`, h.a, {
    headers: write('gy-s4-pool-link-0001'),
    payload: postBody({ linked_knowledge_ref: link }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.data.linked_knowledge_ref, link, '关联目标必须原样保存');
  assert.equal(created.body.data.linked_knowledge.reference_state, 'available');
  assert.equal(created.body.data.linked_knowledge.unavailable_reason, null);
  assert.deepEqual(created.body.data.linked_knowledge.summary, { title: LINK_TITLE }, '摘要标题只能来自读视图');
  assert.deepEqual(
    Object.keys(created.body.data.linked_knowledge).sort(),
    ['reference_state', 'summary', 'target_ref', 'unavailable_reason'].sort(),
    '契约 KnowledgeLink 字段闭集不得变',
  );
  // "同一条 pool" 的直接证据：这套装配里只有这一条池，且它真的被用来读那张视图。
  assert.ok(
    queries.some((text) => text.includes('catalog_read.current_knowledge')),
    '装配层必须用注入的 pool 查公开读视图：' + JSON.stringify(queries.slice(-5)),
  );

  // ② 读取时逐次现查：目标下架后同一条帖子的投影立刻转 unavailable，ref 仍原样保留。
  await db.query("UPDATE knowledge_versions SET visibility='hidden' WHERE knowledge_id=$1", [visible.knowledgeId]);
  const readBack = await h.call('GET', `${API}/posts/${created.body.data.id}`, h.b);
  assert.equal(readBack.status, 200, JSON.stringify(readBack.body));
  assert.deepEqual(readBack.body.data.linked_knowledge_ref, link, '已保存的引用不得被静默清除');
  assert.equal(readBack.body.data.linked_knowledge.reference_state, 'unavailable');
  assert.equal(readBack.body.data.linked_knowledge.unavailable_reason, 'TARGET_UNAVAILABLE');
  assert.equal(readBack.body.data.linked_knowledge.summary, null, '不可用时不得泄露标题');

  // ③ 恢复上架后同一引用重新可用（失效是判定，不是不可逆标记）——同样证明"每次现查"。
  await db.query("UPDATE knowledge_versions SET visibility='published' WHERE knowledge_id=$1", [visible.knowledgeId]);
  const back = await h.call('GET', `${API}/posts/${created.body.data.id}`, h.b);
  assert.equal(back.body.data.linked_knowledge.reference_state, 'available');
  assert.deepEqual(back.body.data.linked_knowledge.summary, { title: LINK_TITLE });

  t.diagnostic(
    `有池装配：POST /posts（linked_knowledge_ref=herbicide:${link.id}:1）=> ${created.status} `
    + `reference_state=${created.body.data.linked_knowledge.reference_state} summary.title=${created.body.data.linked_knowledge.summary.title}；`
    + `下架后同一帖子 => ${readBack.body.data.linked_knowledge.reference_state}/${String(readBack.body.data.linked_knowledge.unavailable_reason)}；`
    + `恢复上架后 => ${back.body.data.linked_knowledge.reference_state}`,
  );
});

test('装配级（有池）负控制：不存在／不可见／版本不符／类型不符一律 409，且"不可见"与"不存在"逐字节同形', async (t) => {
  const { db, pool } = await pglitePool(t);
  const visible = await seedKnowledge(db, { title: LINK_TITLE });
  // 同一份已验证来源、但**已下架**（存在却不在读视图里）——用于"不泄露存在性"的同形比较。
  const hidden = await seedKnowledge(db, { title: '合成已下架资料', visibility: 'hidden' });
  const h = await makeApp(t, { pool });

  const cases = [
    ['absent', { type: 'herbicide', id: ABSENT, revision: 1 }],
    ['hidden', { type: 'herbicide', id: hidden.knowledgeId, revision: 1 }],
    ['revision-mismatch', { type: 'herbicide', id: visible.knowledgeId, revision: 2 }],
    ['type-mismatch', { type: 'scheme', id: visible.knowledgeId, revision: 1 }],
  ];
  const responses = {};
  for (const [label, target] of cases) {
    const result = await h.call('POST', `${API}/posts`, h.a, {
      headers: write(`gy-s4-neg-${label}`),
      payload: postBody({ linked_knowledge_ref: target }),
    });
    assertContractError(result, 409, 'OBJECT_UNAVAILABLE');
    responses[label] = result;
    assert.equal(h.community.snapshotCounts().posts, 0, `${label} 不得被写成关联`);
  }

  // 不泄露存在性：库里有行但不可见，必须与"库里根本没有"逐字节同形（除 request_id）。
  assert.deepEqual(
    withoutRequestId(responses.hidden.body),
    withoutRequestId(responses.absent.body),
    '「存在但不可见」与「不存在」必须逐字节同形（不泄露资料是否存在）',
  );

  // 对照：同一装配里同一张表的**可见**行仍可挂上（证明上面四条不是"全表都挂不上"）。
  const ok = await h.call('POST', `${API}/posts`, h.a, {
    headers: write('gy-s4-neg-control-ok'),
    payload: postBody({ linked_knowledge_ref: { type: 'herbicide', id: visible.knowledgeId, revision: 1 } }),
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));

  t.diagnostic(
    '负控制：' + cases.map(([label]) => `${label} => ${responses[label].status} ${responses[label].body.error.code}`).join('；')
    + '；「不可见」与「不存在」响应体逐字节同形；对照可见行 => ' + ok.status,
  );
});
