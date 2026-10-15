// GY-I07 第二片 · **公开读详情面消费「引用失效」判定**的接线回归
// （`Refs #7`；跨线 `Refs #18`）。
//
// 本片只做**接线**：`GET /knowledge/{id}` 与 `GET /herbicides/{id}` 在返回前调用第一片的
// 纯函数 `decidePublicVisibility`（判定走既有 `createReferenceIntegrity(store).resolve`，
// 由 app.ts 装配点注入）。
//
// 覆盖任务要求的三类证据：
//   ① 撤回/下架来源后**旧链接**（详情面）⇒ 与"不存在"**逐字节同形** 404；
//   ② 失效前的**缓存副本与旧 ETag/条件请求** ⇒ 不得复活；
//   ③ 来源发新版本后**旧版本引用持续不可用**；
//   ④ **正控制**：改引**新版本**并发布 ⇒ 恢复可见；
//   ⑤ `unverifiable`（来源不在本存储里）⇒ **保持可见**，不得谎称失效（生产默认行为不变）；
//   ⑥ 列表面口径**本片刻意未改**（登记边界，见 PR 正文"跨线"一节）。
//
// 说明：所有"来源状态"都由**既有后台服务**驱动（建草稿/发布/撤回），不手写 lifecycle；
// `/knowledge` 的读取走**脚本化假连接池**（只回答既有读服务会发出的那几条 SQL，不连真库）；
// `/herbicides` 的读取走已合入的 `packages/reference` 适配层真实记录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';
import {
  FAMILY_CASES,
  createDraft,
  createHarness,
  editRevision,
  publishRevision,
  validSourceInput,
  withdrawRevision,
} from './admin-fixtures.mjs';

const [SOURCES] = FAMILY_CASES;
const SESSION_KEY = 'synthetic-session-signing-key-0123456789';
const IDEM = 'idem-key-000001';
const SINK = '00000000-0000-4000-8000-000000000000';

function stubConfig() {
  return loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', SESSION_SIGNING_KEY: SESSION_KEY });
}

/**
 * 只回答既有知识读服务实际发出的 SQL；不连真库、不落任何数据。
 * `rowsRef` 故意做成可变对象：正控制需要"数据库投影里这条资料改了 source_version"。
 */
function scriptedPool({ store, rowsRef }) {
  const client = {
    async query(text, values) {
      const sql = String(text);
      if (sql.includes('FROM public.users')) {
        const user = await store.getUser(String(values?.[0] ?? ''));
        return { rows: user ? [{ state: user.state, auth_epoch: user.authEpoch }] : [] };
      }
      if (sql.includes('public.sessions')) return { rows: [{ id: 'synthetic-session' }] };
      if (sql.includes('catalog_read.current_knowledge')) return { rows: rowsRef.rows };
      return { rows: [] };
    },
    release() {},
  };
  return { async connect() { return client; }, async query() { return { rows: [] }; } };
}

/** 与 `catalog_read.current_knowledge` 同形的合成行（只喂判定所需的既有字段）。 */
function knowledgeRow({ id, revision = 1, sourceId, sourceVersion }) {
  return {
    id,
    revision,
    type: 'herbicide',
    title: '合成资料：接线回归用（非真实资料）',
    body: '合成正文，仅用于路由接线回归，不含用量绑定与适用性结论。',
    crop_ids: ['crop_rice'],
    region_codes: ['330000'],
    species_ids: [],
    source_id: sourceId,
    source_version: sourceVersion,
    source_title: '合成来源标题',
    url: 'https://example.invalid/wiring-not-real',
    publisher: '合成出版方',
    source_kind: 'verified_seed',
    evidence_kind: 'research',
    updated_at: '2026-10-01T00:00:00.000Z',
    review_status: 'verified',
    validity: 'valid',
  };
}

async function login(app) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/wechat',
    headers: { 'idempotency-key': IDEM },
    payload: { code: 'synthetic-i07-wiring' },
  });
  assert.equal(res.statusCode, 200);
  return res.json().data.access_token;
}

/**
 * 建一个**已接线**的 app：后台内容 store 由测试自己建并注入
 * （app.ts 装配点用同一个 store 构造 `createReferenceIntegrity(store).resolve`）。
 */
async function newWiredApp({ rowsRef, contentStore }) {
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: stubConfig(),
    store: authStore,
    idempotency: createMemoryIdempotencyStore(),
    pool: scriptedPool({ store: authStore, rowsRef }),
    adminInjection: { contentStore },
  });
  const token = await login(app);
  return { app, token };
}

function get(app, url, token, headers = {}) {
  return app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
}

/**
 * 归一化掉 `meta.request_id`（每次请求天然不同）后的完整响应体。
 * 「逐字节同形」= 除该字段外，码/文案/retryable/details/contract_version/execution_mode 全等。
 */
function maskRequestId(body) {
  return { ...body, meta: { ...body.meta, request_id: '<masked>' } };
}

/** 断言「与不存在同形」：状态、响应体、以及缓存相关头都不泄露存在性差异。 */
function assertIndistinguishableFromMissing(gated, ghost, label) {
  assert.equal(gated.statusCode, 404, `${label}：必须是 404`);
  assert.equal(ghost.statusCode, 404, `${label}：对照组必须是 404`);
  assert.equal(gated.json().error.code, 'NOT_FOUND');
  assert.deepEqual(
    maskRequestId(gated.json()),
    maskRequestId(ghost.json()),
    `${label}：失效拦截的 404 必须与"不存在"的 404 逐字节同形（仅 request_id 可不同）`,
  );
  // 缓存相关头也必须同形：两边都不得出现 ETag（否则"有/无 ETag"本身就是存在性信号）。
  assert.equal(gated.headers['etag'], undefined, `${label}：404 不得带 ETag`);
  assert.equal(ghost.headers['etag'], undefined, `${label}：对照 404 不得带 ETag`);
  assert.equal(
    gated.headers['cache-control'],
    ghost.headers['cache-control'],
    `${label}：404 的 Cache-Control 必须与对照一致（否则即泄露存在性）`,
  );
}

// ---------------------------------------------------------------------------
// 负例 ①：撤回来源 ⇒ 旧链接（详情面）同形 404
// ---------------------------------------------------------------------------

test('负例①：撤回来源后，旧链接 /knowledge/{id} ⇒ 与"不存在"逐字节同形的 404（不泄露存在性）', async () => {
  const harness = createHarness();
  const { service, store: contentStore } = harness;

  // 合法来源：建草稿 + 发布（生效版本 2026-09）。
  const source = await createDraft(SOURCES, service);
  const sourceId = source.body.data.id;
  await publishRevision(SOURCES, service, sourceId, 1);

  const knowledgeId = randomUUID();
  const rowsRef = { rows: [knowledgeRow({ id: knowledgeId, sourceId, sourceVersion: '2026-09' })] };
  const { app, token } = await newWiredApp({ rowsRef, contentStore });
  try {
    // 撤回前：引用当前生效版本 ⇒ 可见。
    const before = await get(app, `/api/v1/knowledge/${knowledgeId}`, token);
    assert.equal(before.statusCode, 200, '撤回前必须可见');
    assert.equal(before.headers['etag'], '"1"');
    assert.equal(before.headers['cache-control'], 'no-store');

    // 撤回来源（走既有后台服务，不手写 lifecycle）。
    await withdrawRevision(SOURCES, service, sourceId, 1);

    const gated = await get(app, `/api/v1/knowledge/${knowledgeId}`, token);
    const ghost = await get(app, `/api/v1/knowledge/${SINK}`, token);
    assertIndistinguishableFromMissing(gated, ghost, '负例①');
    // 关键：一条**存在**但引用失效的资料，与一条**不存在**的资料，客户端无法区分。
    assert.equal(rowsRef.rows[0].id, knowledgeId, '存储里这条资料仍然存在（失效只是读取时结论）');
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------
// 负例 ②：失效前的缓存副本与旧 ETag/条件请求 ⇒ 不得复活
// ---------------------------------------------------------------------------

test('负例②：失效前的旧 ETag/条件请求不得复活内容（不返 200/304，且失败响应不带 ETag）', async () => {
  const harness = createHarness();
  const { service, store: contentStore } = harness;

  const source = await createDraft(SOURCES, service);
  const sourceId = source.body.data.id;
  await publishRevision(SOURCES, service, sourceId, 1);

  const knowledgeId = randomUUID();
  const rowsRef = { rows: [knowledgeRow({ id: knowledgeId, sourceId, sourceVersion: '2026-09' })] };
  const { app, token } = await newWiredApp({ rowsRef, contentStore });
  try {
    const before = await get(app, `/api/v1/knowledge/${knowledgeId}`, token);
    assert.equal(before.statusCode, 200);
    const staleEtag = before.headers['etag'];
    assert.equal(staleEtag, '"1"');
    // 失效前的响应体：把它当作"缓存里的副本"，失效后不得再以任何形式复活。
    const cachedCopy = before.json();

    await withdrawRevision(SOURCES, service, sourceId, 1);

    for (const headers of [
      {},
      // 条件请求：拿旧 ETag 去问"还能不能复用"。
      { 'if-none-match': staleEtag },
      // 客户端声明的缓存副本（旧体摘要）。
      { 'if-match': staleEtag },
    ]) {
      const res = await get(app, `/api/v1/knowledge/${knowledgeId}`, token, headers);
      assert.equal(res.statusCode, 404, `带 ${JSON.stringify(headers)} 时也必须是 404，不得 200/304`);
      assert.equal(res.json().error.code, 'NOT_FOUND');
      assert.equal(res.headers['etag'], undefined, '失效后的失败响应不得回写 ETag');
      assert.notDeepEqual(res.json().data, cachedCopy, '缓存副本不得复活');
    }

    // 对照：同一个旧 ETag 在**未失效**时也不产生 304（本基线无 304 协商），
    // 因此"404 而非 304"这条断言不是靠"本来就没有 304"蒙对的。
    const otherSource = await createDraft(SOURCES, service);
    const otherSourceId = otherSource.body.data.id;
    await publishRevision(SOURCES, service, otherSourceId, 1);
    const aliveId = randomUUID();
    rowsRef.rows = [knowledgeRow({ id: aliveId, sourceId: otherSourceId, sourceVersion: '2026-09' })];
    const alive = await get(app, `/api/v1/knowledge/${aliveId}`, token, { 'if-none-match': staleEtag });
    assert.notEqual(alive.statusCode, 404, '未失效的资料不得被旧 ETag 影响成 404');
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------
// 负例 ③ + 正控制 ④：来源发新版本
// ---------------------------------------------------------------------------

test('负例③：来源发新版本后，仍引用旧版本的资料持续不可用（失效是每次读取重算，不是一次性标记）', async () => {
  const harness = createHarness();
  const { service, store: contentStore } = harness;

  const source = await createDraft(SOURCES, service);
  const sourceId = source.body.data.id;
  await publishRevision(SOURCES, service, sourceId, 1);

  const knowledgeId = randomUUID();
  const rowsRef = { rows: [knowledgeRow({ id: knowledgeId, sourceId, sourceVersion: '2026-09' })] };
  const { app, token } = await newWiredApp({ rowsRef, contentStore });
  try {
    assert.equal((await get(app, `/api/v1/knowledge/${knowledgeId}`, token)).statusCode, 200);

    // 来源改版：编辑（修订 2）+ 发布 ⇒ 生效版本变成 2026-10。
    await editRevision(SOURCES, service, sourceId, 1, validSourceInput({ version: '2026-10' }));
    await publishRevision(SOURCES, service, sourceId, 2);

    const ghost = await get(app, `/api/v1/knowledge/${SINK}`, token);
    // **持续**不可用：连续多次请求都必须是同形 404，不存在"第一次拦、之后放行"或反之。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await get(app, `/api/v1/knowledge/${knowledgeId}`, token);
      assertIndistinguishableFromMissing(res, ghost, `负例③（第 ${attempt + 1} 次）`);
    }
  } finally { await app.close(); }
});

test('正控制④：改引来源当前生效版本并发布 ⇒ 同一条资料的详情恢复可见（无需清缓存）', async () => {
  const harness = createHarness();
  const { service, store: contentStore } = harness;

  const source = await createDraft(SOURCES, service);
  const sourceId = source.body.data.id;
  await publishRevision(SOURCES, service, sourceId, 1);

  const knowledgeId = randomUUID();
  const sourceVersion = '2026-09';
  const rowsRef = { rows: [knowledgeRow({ id: knowledgeId, sourceId, sourceVersion })] };
  const { app, token } = await newWiredApp({ rowsRef, contentStore });
  try {
    assert.equal((await get(app, `/api/v1/knowledge/${knowledgeId}`, token)).statusCode, 200);

    await editRevision(SOURCES, service, sourceId, 1, validSourceInput({ version: '2026-10' }));
    await publishRevision(SOURCES, service, sourceId, 2);
    assert.equal(
      (await get(app, `/api/v1/knowledge/${knowledgeId}`, token)).statusCode,
      404,
      '前置：仍引用旧版本 ⇒ 不可用',
    );

    // 正控制：数据库投影里这条资料重新校验到**来源当前生效版本**并发布（修订 2）。
    rowsRef.rows = [knowledgeRow({ id: knowledgeId, revision: 2, sourceId, sourceVersion: '2026-10' })];

    const restored = await get(app, `/api/v1/knowledge/${knowledgeId}`, token);
    assert.equal(restored.statusCode, 200, '改引新版本后必须恢复可见');
    assert.equal(restored.headers['etag'], '"2"');
    assert.equal(restored.headers['cache-control'], 'no-store');
    const data = restored.json().data;
    assert.equal(data.id, knowledgeId);
    assert.equal(data.source.version, '2026-10');
    // 恢复可见**不是靠清缓存**：判定是读时重算，同一进程内没有任何需要失效的缓存。
    assert.equal((await get(app, `/api/v1/knowledge/${knowledgeId}`, token)).statusCode, 200);
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------
// ⑤ unverifiable（核不到）⇒ 保持可见：不得谎称失效
// ---------------------------------------------------------------------------

test('⑤ 来源不在本存储里（未接真实库）⇒ 详情保持可见：核不到不等于失效', async () => {
  // 空的后台内容 store = 生产默认（未接真实来源库）。
  const harness = createHarness();
  const contentStore = harness.store;
  const knowledgeId = randomUUID();
  // 引用一条**库外**来源：本存储里没有它。
  const rowsRef = { rows: [knowledgeRow({ id: knowledgeId, sourceId: randomUUID(), sourceVersion: '2026-09' })] };
  const { app, token } = await newWiredApp({ rowsRef, contentStore });
  try {
    const res = await get(app, `/api/v1/knowledge/${knowledgeId}`, token);
    assert.equal(res.statusCode, 200, 'unverifiable ⇒ 必须保持可见（不得谎称失效）');
    assert.equal(res.json().data.id, knowledgeId);

    // 边界：投影还原不出可用引用（合成行，契约上不应出现）时**不判定** ⇒ 保持可见。
    // 证明本片的 404 只由"确实处于失效状态的来源"触发，绝不由"核不到"触发。
    rowsRef.rows = [knowledgeRow({ id: knowledgeId, sourceId: null, sourceVersion: null })];
    const unreadable = await get(app, `/api/v1/knowledge/${knowledgeId}`, token);
    assert.equal(unreadable.statusCode, 200, '读不到引用字段 ⇒ 不判定（不谎称失效）');
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------
// 详情面同样接线：/herbicides/{id}
// ---------------------------------------------------------------------------

test('⑤b /herbicides/{id}：库外来源保持可见；把该来源接进后台 store 后同一条判定生效（撤回 ⇒ 同形 404）', async () => {
  const harness = createHarness();
  const { service, store } = harness;
  const contentStore = store;

  const { app, token } = await newWiredApp({ rowsRef: { rows: [] }, contentStore });
  try {
    // 先取一条**已合入的真实记录**（`packages/reference` 适配层），拿到它的既有 source。
    const list = await get(app, '/api/v1/herbicides', token);
    assert.equal(list.statusCode, 200);
    const record = list.json().data.items[0];
    const sourceId = record.source.id;
    const sourceVersion = record.source.version;
    assert.match(sourceId, /^[0-9a-f-]{36}$/);
    assert.match(sourceVersion, /^src_/);

    // 未接来源库：该来源不在后台 store 里 ⇒ unverifiable ⇒ 详情照旧可见（生产默认行为不变）。
    const unverifiable = await get(app, `/api/v1/herbicides/${record.id}`, token);
    assert.equal(unverifiable.statusCode, 200, 'unverifiable ⇒ 保持可见');
    assert.deepEqual(unverifiable.json().data, record, '列表与详情仍是同一条实体');

    // 把该来源接进后台 store：沿用既有 store 的 `createEntity({ id })` 定 id（测试播种），
    // 生命周期流转仍走**既有后台服务**（发布用 publishRevision，不手写 publishedRevision）。
    const entity = store.createEntity({
      id: sourceId,
      family: 'sources',
      stewardId: '11111111-1111-4111-8111-111111111111',
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    store.appendRevision({
      entity,
      content: validSourceInput({ version: sourceVersion }),
      authorId: '11111111-1111-4111-8111-111111111111',
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      derivedFromRevision: null,
    });

    // 尚未发布 ⇒ unavailable（source_not_published）⇒ 详情同形 404。
    const draftGated = await get(app, `/api/v1/herbicides/${record.id}`, token);
    const ghost = await get(app, `/api/v1/herbicides/${SINK}`, token);
    assertIndistinguishableFromMissing(draftGated, ghost, '⑤b（来源未发布）');
    assert.equal(ghost.json().error.message, '未找到该除草剂记录', '对照组文案取自该域既有"查不到"路径');

    await publishRevision(SOURCES, service, sourceId, 1);
    // 正控制：引用到来源当前生效版本 ⇒ 恢复可见，且与列表仍同一条实体。
    const visible = await get(app, `/api/v1/herbicides/${record.id}`, token);
    assert.equal(visible.statusCode, 200, 'available ⇒ 可见');
    assert.deepEqual(visible.json().data, record);

    // 撤回 ⇒ 同形 404（与 /knowledge/{id} 同一判定、同一同形口径）。
    await withdrawRevision(SOURCES, service, sourceId, 1);
    const withdrawn = await get(app, `/api/v1/herbicides/${record.id}`, token);
    assertIndistinguishableFromMissing(withdrawn, await get(app, `/api/v1/herbicides/${SINK}`, token), '⑤b（来源已撤回）');
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------
// ⑥ 列表面口径：本片**刻意未改**（登记的边界，供监工裁定）
// ---------------------------------------------------------------------------

test('⑥ 列表面口径登记：本片只拦详情面，列表**仍返回**该行（刻意边界，理由与影响面见 PR 正文）', async () => {
  const harness = createHarness();
  const { service, store: contentStore } = harness;

  const source = await createDraft(SOURCES, service);
  const sourceId = source.body.data.id;
  await publishRevision(SOURCES, service, sourceId, 1);

  const knowledgeId = randomUUID();
  const rowsRef = { rows: [knowledgeRow({ id: knowledgeId, sourceId, sourceVersion: '2026-09' })] };
  const { app, token } = await newWiredApp({ rowsRef, contentStore });
  try {
    await withdrawRevision(SOURCES, service, sourceId, 1);

    // 详情面：已 404。
    assert.equal((await get(app, `/api/v1/knowledge/${knowledgeId}`, token)).statusCode, 404);

    // 列表面：**口径未改** ⇒ 仍返回该行，分页封套/游标语义与接线前逐字相同。
    const list = await get(app, '/api/v1/knowledge?limit=50', token);
    assert.equal(list.statusCode, 200);
    assert.equal(list.headers['etag'], undefined, '列表不带 ETag（既有口径）');
    const items = list.json().data.items;
    assert.equal(items.length, 1, '列表口径未改：仍返回该行');
    assert.equal(items[0].id, knowledgeId);
    assert.deepEqual(Object.keys(list.json().data).sort(), ['items', 'next_cursor']);
    assert.equal(list.json().data.next_cursor, null, '单页取尽 ⇒ 游标语义未变');

    // /herbicides 列表同样未按引用可用性过滤（其游标由域层 registration_number 派生，
    // 事后过滤会打断游标；详见 PR 正文影响面一节）。
    const hb = await get(app, '/api/v1/herbicides', token);
    assert.equal(hb.statusCode, 200);
    assert.equal(hb.json().data.items.length, 20, '/herbicides 列表口径未改');
    assert.equal(hb.json().data.next_cursor, null);
  } finally { await app.close(); }
});
