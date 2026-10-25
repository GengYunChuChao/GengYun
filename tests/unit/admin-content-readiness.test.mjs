// GY-I18（#18）· **内容存储就绪探测（四态）× 公开读引用解析** 的单元层证据。
//
// 为什么需要本文件：迁移 0036 之后，`real` ＋有池时内容域是 PG 实现（`persistent: true`）。
// 部署里**没有**这三张表时（子集库、还没跑 0036 的环境），`foldDatabaseError` 会把 `42P01`
// 折成 503 `PROVIDER_UNAVAILABLE`，把**公开读**（`/herbicides`、`/knowledge`）一起打成 503。
//
// 本文件钉住的四态（⛔ 不许合并成三态/两态、⛔ 不许把库错误无差别吞成 `unverifiable`）：
//
//   | 探测结论 | 库形状 | 公开读行为 |
//   |---|---|---|
//   | `ready`      | `entities` ＋ `revisions` 都在（`idempotency` 可缺） | 按已接线解析：引用不可用 ⇒ 隐藏（下架/失效**一律不可见**） |
//   | `unwired`    | 三张表**全都不在** ⇒ **全域确认未配置**（不是故障） | 退回接线前行为：不过滤、200 |
//   | `incomplete` | 部分存在（半套 schema） | **明确 503 fail-closed**（⛔ 不得回落成"未配置"） |
//   | `unknown`    | 探测出错（连接/权限/超时）或形状读不懂 ⇒ **未知 ≠ 未安装** | **不降级**，真实解析 fail-closed 503 |
//
// 覆盖点（用例名对应监工 2026-10-25T04:15:22Z 复核给出的 U1–U6）：
//   U1. 三张全缺 ⇒ `unwired` ⇒ `/herbicides` 200，且**零** `public.admin_content_*` 查询（短路，不是"查询失败但被吞"）；
//   U2. **监工场景**：`entities`/`revisions` 都在、其中一条来源已 `withdrawn`、**仅 `idempotency` 缺**
//       ⇒ 必须 `ready` ⇒ `unavailable`/`source_withdrawn` ⇒ `visible === false`（⛔ 断言它**不是** `unverifiable`）；
//   U3. `entities` 在、`revisions` 缺 ⇒ `incomplete` ⇒ 503；U4. 反向 ⇒ 503；
//   U5. 两张读表都缺、只有 `idempotency` 在 ⇒ 503（⛔ 不得判 `unwired`）；
//   U6. 探测 `42501`（权限/连接故障）⇒ `/herbicides` **仍然 503**，且**真的**打了内容表（证明未降级）；
//   D.  内存 store（`persistent: false`）⇒ **不探测**、行为逐字不变；
//   E.  `probeAdminContentTables` 在三列布尔下的各种输入形状各自落在哪一态；
//   F.  `unwired` 定型后 20 次公开读**只探 1 次**（定型结论，⛔ 不得退化成每请求重探）。
//
// 不连真库：本文件是单元层证据；真库行为由 `tests/integration/admin-flags-pg.mjs` 场景 1
// （子集库，刻意无 0036）与 `tests/integration/admin-content-pg.mjs` 覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createAdminContentReferenceResolver } from '../../services/api/src/admin/content-readiness.ts';
import { probeAdminContentTables } from '../../services/api/src/admin/ops/content-pg.ts';
import { createPostgresAdminContentStore } from '../../services/api/src/admin/ops/content-pg.ts';
import { decidePublicVisibilityAsync } from '../../services/api/src/knowledge/public-invalidation.ts';

const API = '/api/v1';

/** 与 `tests/unit/admin-content-pg-wiring.test.mjs` 同形的**合成占位** real 环境（非真实凭据）。 */
const REAL_ENV = {
  APP_EXECUTION_MODE: 'real',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://synthetic_local_only@127.0.0.1:5432/gengyun_synthetic_never_connected',
  SESSION_SIGNING_KEY: 'synthetic-not-a-real-signing-key',
  DELETION_LEDGER_KEY: 'synthetic-not-a-real-ledger-key',
  WECHAT_APP_ID: 'synthetic-not-a-real-appid',
  WECHAT_APP_SECRET: 'synthetic-not-a-real-appsecret',
  OBJECT_STORAGE_ENDPOINT: 'https://example.invalid',
  OBJECT_STORAGE_BUCKET: 'synthetic-not-a-real-bucket',
  OBJECT_STORAGE_ACCESS_KEY: 'synthetic-not-a-real-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'synthetic-not-a-real-secret-key',
};

/** 内容表查询的正则：`to_regclass(...)` 探测语句里也出现表名，故只认"真读表"的三种写法。 */
const CONTENT_QUERY = /\b(FROM|INTO|UPDATE)\s+public\.admin_content_[a-z_]+\b/;

/** 三列布尔探测的**单行结果**（缺省全缺 ⇒ `unwired`）。 */
function tableRow({ entities = false, revisions = false, idempotency = false } = {}) {
  return { rows: [{ entities, revisions, idempotency }], rowCount: 1 };
}

/**
 * 桩池：**按语句分流**回答。
 *
 * - 开关门探测（`public.feature_flags`）一律回 `ready: false` ⇒ 开关未武装（本文件不考开关门，
 *   但 `/herbicides` 是受控面，必须让门放行才不会把两件事混在一起）；
 * - 内容三表探测（`to_regclass('public.admin_content_entities')`）⇒ 走 `contentProbe`；
 * - 其余**真读**内容表的语句 ⇒ 抛 `42P01`（模拟"部署里没跑 0036"的真实库），
 *   于是"有没有降级"直接体现为"这条语句有没有发出去 / 请求是 200 还是 503"。
 */
function createStubPool({ contentProbe }) {
  const statements = [];
  const answer = async (text, values = []) => {
    const sql = String(text);
    statements.push({ text: sql, values: [...values] });
    if (sql.includes("to_regclass('public.feature_flags')")) return { rows: [{ ready: false }], rowCount: 1 };
    if (sql.includes("to_regclass('public.admin_content_entities')")) return contentProbe();
    if (CONTENT_QUERY.test(sql)) {
      throw Object.assign(new Error('relation "public.admin_content_entities" does not exist'), { code: '42P01' });
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    statements,
    query: answer,
    async connect() {
      return { query: answer, release() {} };
    },
  };
}

/** real 模式下的合成用户会话（真实模式不会回退替身身份，故直接写内存 store）。 */
async function syntheticUserToken(store) {
  const token = 'synthetic-r34-readiness-token';
  const user = await store.createUser('synthetic-r34-readiness-user');
  await store.createSession({
    userId: user.id,
    tokenHashHex: hashToken(token),
    authEpoch: user.authEpoch,
    expiresAt: new Date(Date.now() + 3_600_000),
    audience: 'user',
  });
  return token;
}

function get(app, url, token) {
  return app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
}

/** 就绪探测的假宿主：只收集钩子，`runHooks()` 手动跑到"`ready()` 之后"的同一时点。 */
function createHookHost() {
  const hooks = [];
  return {
    hooks,
    addHook(name, hook) {
      assert.equal(name, 'onReady', '探针必须挂在 onReady（与 featureFlagGate 同一时点）');
      hooks.push(hook);
      return undefined;
    },
    async runHooks() {
      for (const hook of hooks) await hook();
    },
  };
}

test('U1. 全域确认未配置（unwired：三张表全缺）⇒ /herbicides 200，且零内容表查询（短路，不是吞错）', async () => {
  const authStore = createMemoryAuthStore();
  const pool = createStubPool({ contentProbe: () => tableRow() });
  const app = buildApp({ config: loadConfig(REAL_ENV), store: authStore, pool });
  try {
    const token = await syntheticUserToken(authStore);
    const res = await get(app, `${API}/herbicides`, token);
    assert.equal(res.statusCode, 200, `三表全缺（unwired）⇒ 公开读不得 503/409，实际 ${res.statusCode} ⇒ ${res.body}`);
    const items = res.json().data.items;
    assert.ok(items.length >= 1, '前置：种子里必须有行，否则 resolve 根本不会被调用（本用例就失去意义）');
    // 关键：一条内容表查询都没发出去 —— 证明 status 200 来自"降级短路"，而不是"查询失败被吞掉"。
    const touched = pool.statements.filter((entry) => CONTENT_QUERY.test(entry.text));
    assert.deepEqual(touched, [], `unwired 态必须短路、不得去读 0036 三表，实际：${touched.map((e) => e.text).join(' | ')}`);
  } finally {
    await app.close();
  }
});

test('U2. 监工场景：entities/revisions 在、仅 idempotency 缺 + 来源已撤回 ⇒ ready ⇒ unavailable ⇒ visible=false（不是 unverifiable）', async () => {
  // 监工 2026-10-25T04:15:22Z 的原话场景：读失效真值所需的数据**仍在**（entities/revisions 都在），
  // 只是 `admin_content_idempotency` 没建。旧实现把三表 AND 后判 missing ⇒ 回落 unverifiable ⇒
  // 已下架内容**重新可见**。本用例就是那条红的回归钉：必须判 ready、必须判 unavailable、必须不可见。
  const withdrawn = {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    family: 'sources',
    lifecycle: 'withdrawn',
    publishedRevision: null,
    revisions: [],
  };
  let reads = 0;
  const store = {
    persistent: true,
    async getEntity() {
      reads += 1;
      return withdrawn;
    },
  };
  const host = createHookHost();
  const pool = {
    async query() {
      // 读面两张表都在；写侧幂等台账缺 —— 这正是监工指出的形状。
      return tableRow({ entities: true, revisions: true, idempotency: false });
    },
  };
  const resolve = createAdminContentReferenceResolver({ host, store, pool });
  await host.runHooks();

  const content = { source_id: withdrawn.id, source_version: 'v1' };
  const resolution = await resolve('knowledge', content);
  assert.equal(reads, 1, 'ready 态必须去问存储（不得短路）');
  assert.notEqual(
    resolution.state,
    'unverifiable',
    `⛔ 部分缺表不得回落成 unverifiable（那会让已撤回内容重新可见），实际 ${resolution.state}`,
  );
  assert.equal(resolution.state, 'unavailable', `已撤回来源的引用必须判不可用，实际 ${resolution.state}`);
  assert.equal(resolution.reason, 'source_withdrawn');

  const decision = await decidePublicVisibilityAsync({ family: 'knowledge', content, resolve });
  assert.equal(decision.visible, false, '下架/失效内容**不得**因探测接线而变可见（监工复核的核心）');
  assert.equal(decision.reason, 'unavailable');
});

test('U3. entities 在、revisions 缺 ⇒ incomplete ⇒ /herbicides 503（明确拒绝，不回落）', async () => {
  const authStore = createMemoryAuthStore();
  const pool = createStubPool({ contentProbe: () => tableRow({ entities: true }) });
  const app = buildApp({ config: loadConfig(REAL_ENV), store: authStore, pool });
  try {
    const token = await syntheticUserToken(authStore);
    const res = await get(app, `${API}/herbicides`, token);
    assert.equal(res.statusCode, 503, `半套 schema 必须 fail-closed，实际 ${res.statusCode} ⇒ ${res.body}`);
    assert.equal(res.json().error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(res.json().error.retryable, false, 'schema 不完整需运维介入，不是"稍后自己会好"');
    assert.match(res.json().error.message, /schema 不完整（就绪探测：entities=true, revisions=false）/);
  } finally {
    await app.close();
  }
});

test('U4. entities 缺、revisions 在 ⇒ incomplete ⇒ /herbicides 503', async () => {
  const authStore = createMemoryAuthStore();
  const pool = createStubPool({ contentProbe: () => tableRow({ revisions: true }) });
  const app = buildApp({ config: loadConfig(REAL_ENV), store: authStore, pool });
  try {
    const token = await syntheticUserToken(authStore);
    const res = await get(app, `${API}/herbicides`, token);
    assert.equal(res.statusCode, 503, `半套 schema 必须 fail-closed，实际 ${res.statusCode} ⇒ ${res.body}`);
    assert.equal(res.json().error.code, 'PROVIDER_UNAVAILABLE');
    assert.match(res.json().error.message, /entities=false, revisions=true/);
  } finally {
    await app.close();
  }
});

test('U5. 两张读表都缺、只有 idempotency 在 ⇒ incomplete ⇒ 503（⛔ 不得判 unwired）', async () => {
  const authStore = createMemoryAuthStore();
  const pool = createStubPool({ contentProbe: () => tableRow({ idempotency: true }) });
  const app = buildApp({ config: loadConfig(REAL_ENV), store: authStore, pool });
  try {
    const token = await syntheticUserToken(authStore);
    const res = await get(app, `${API}/herbicides`, token);
    assert.equal(res.statusCode, 503, `只挂了一张写侧台账不算"未配置"，实际 ${res.statusCode} ⇒ ${res.body}`);
    assert.equal(res.json().error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(res.json().error.retryable, false);
  } finally {
    await app.close();
  }
});

test('U6. 探测故障（unknown：42501）⇒ 仍 503，且真的打了内容表（未降级、未吞错）', async () => {
  const authStore = createMemoryAuthStore();
  const pool = createStubPool({
    contentProbe: () => {
      throw Object.assign(new Error('permission denied for table admin_content_entities'), { code: '42501' });
    },
  });
  const app = buildApp({ config: loadConfig(REAL_ENV), store: authStore, pool });
  try {
    const token = await syntheticUserToken(authStore);
    const res = await get(app, `${API}/herbicides`, token);
    assert.equal(res.statusCode, 503, `未知态必须 fail-closed（不得因探测出错就放行），实际 ${res.statusCode} ⇒ ${res.body}`);
    assert.equal(res.json().error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(res.json().error.retryable, false, '权限不足需运维介入，不是"稍后自己会好"');
    const touched = pool.statements.filter((entry) => CONTENT_QUERY.test(entry.text));
    assert.ok(touched.length >= 1, `unknown 态必须真的去读内容表（证明没有短路降级），实际零查询`);
  } finally {
    await app.close();
  }
});

test('D. 内存 store（persistent=false）⇒ 不探测、不降级，行为逐字不变', async () => {
  const host = createHookHost();
  let reads = 0;
  const store = {
    persistent: false,
    async getEntity() {
      reads += 1;
      return undefined;
    },
  };
  const pool = { async query() { throw new Error('未接线时不该有任何库往返'); } };
  const resolve = createAdminContentReferenceResolver({ host, store, pool });
  assert.deepEqual(host.hooks, [], '内存 store 不注册就绪探针');

  const content = { source_id: 'a1b2c3d4-0000-4000-8000-000000000002', source_version: 'v1' };
  const resolution = await resolve('knowledge', content);
  assert.equal(reads, 1, '内存 store 必须照旧被问（不走探测分支）');
  assert.equal(resolution.state, 'unverifiable', '空存储 ⇒ 与接线前一致：unverifiable（可见，不谎称失效）');
});

test('D2. 探测通过但库里其实没有表（ready ＋ 42P01）⇒ 仍 503（不缓存"绿灯"）', async () => {
  const pool = createStubPool({ contentProbe: () => tableRow({ entities: true, revisions: true }) });
  const store = createPostgresAdminContentStore({ pool });
  await assert.rejects(
    () => createAdminContentReferenceResolver({
      host: createHookHost(),
      store,
      pool,
    })('knowledge', { source_id: 'a1b2c3d4-0000-4000-8000-000000000003', source_version: 'v1' }),
    (error) => error.code === 'PROVIDER_UNAVAILABLE' && error.status === 503,
    'ready 态下真实库报 42P01 仍必须折成 503（fail-closed 未被放宽）',
  );
});

test('E. probeAdminContentTables：三列布尔下的各种输入形状各自落在哪一态', async () => {
  assert.deepEqual(await probeAdminContentTables(null), { state: 'unknown', reason: 'no_pool' });
  assert.deepEqual(await probeAdminContentTables(undefined), { state: 'unknown', reason: 'no_pool' });
  assert.deepEqual(
    await probeAdminContentTables({ async query() { return tableRow({ entities: true, revisions: true }); } }),
    { state: 'ready', tables: { entities: true, revisions: true, idempotency: false } },
    '读面两张表都在即 ready —— `idempotency` 不参与读面判定（监工场景：仅它缺也必须是 ready）',
  );
  assert.deepEqual(
    await probeAdminContentTables({ async query() { return tableRow({ entities: true, revisions: true, idempotency: true }); } }),
    { state: 'ready', tables: { entities: true, revisions: true, idempotency: true } },
  );
  assert.deepEqual(
    await probeAdminContentTables({ async query() { return tableRow(); } }),
    { state: 'unwired', tables: { entities: false, revisions: false, idempotency: false } },
    '三表全缺才是 unwired（唯一可回落的形状）',
  );
  assert.deepEqual(
    await probeAdminContentTables({ async query() { return tableRow({ entities: true }); } }),
    { state: 'incomplete', tables: { entities: true, revisions: false, idempotency: false } },
    '半套 schema ⇒ incomplete（⛔ 不得判 unwired 后放行）',
  );
  assert.deepEqual(
    await probeAdminContentTables({ async query() { return tableRow({ idempotency: true }); } }),
    { state: 'incomplete', tables: { entities: false, revisions: false, idempotency: true } },
    '只有写侧台账也不算未配置',
  );
  assert.deepEqual(
    await probeAdminContentTables({ async query() { throw Object.assign(new Error('boom'), { code: '42501' }); } }),
    { state: 'unknown', reason: 'probe_error' },
    '连接/权限故障必须是 unknown（⛔ 不得折成 unwired 后放行）',
  );
  const unknownShape = { state: 'unknown', reason: 'unexpected_shape' };
  assert.deepEqual(await probeAdminContentTables({ async query() { return { rows: [] }; } }), unknownShape);
  assert.deepEqual(await probeAdminContentTables({ async query() { return { rows: [{}] }; } }), unknownShape);
  // 三列布尔下的"读不懂"：都**不得**被判成 unwired（unwired 会直接降级放行，误判即等于放水）。
  assert.deepEqual(
    await probeAdminContentTables({ async query() { return { rows: [{ entities: 'false', revisions: 'false', idempotency: 'false' }] }; } }),
    unknownShape,
    "字符串 `'false'` 不是 `false`：⛔ 不得当成缺表降级",
  );
  assert.deepEqual(
    await probeAdminContentTables({ async query() { return { rows: [{ entities: false, revisions: false }] }; } }),
    unknownShape,
    '缺列（`idempotency` 不在）⇒ 读不懂 ⇒ 未知',
  );
  assert.deepEqual(
    await probeAdminContentTables({
      async query() { return { rows: [{ entities: false, revisions: false, idempotency: false, extra: false }] }; },
    }),
    unknownShape,
    '多余列说明语句被换掉了 ⇒ 未知（不挑着用）',
  );
  assert.deepEqual(
    await probeAdminContentTables({
      async query() { return { rows: [tableRow().rows[0], tableRow().rows[0]] }; },
    }),
    unknownShape,
    '多行 rows 不合预期：聚合探测只该回一行，⛔ 不得只看首行就定态',
  );
  assert.deepEqual(
    await probeAdminContentTables({
      async query() { return { rows: [{ entities: null, revisions: null, idempotency: null }] }; },
    }),
    unknownShape,
    '`null`（列存在但为空）⇒ 未知，⛔ 不得判缺表',
  );
});

test('F. unwired 定型后 20 次公开读只探 1 次（不得退化成每请求重探）', async () => {
  let probes = 0;
  const pool = {
    async query() {
      probes += 1;
      return tableRow();
    },
  };
  let storeReads = 0;
  const store = {
    persistent: true,
    async getEntity() {
      storeReads += 1;
      return undefined;
    },
  };
  const host = createHookHost();
  const resolve = createAdminContentReferenceResolver({ host, store, pool });
  await host.runHooks();
  assert.equal(probes, 1, 'onReady 探一次即定型');

  const content = { source_id: 'a1b2c3d4-0000-4000-8000-000000000004', source_version: 'v1' };
  for (let i = 0; i < 20; i += 1) {
    const resolution = await resolve('knowledge', content);
    assert.equal(resolution.state, 'unverifiable', 'unwired 态照旧判"核对不到来源"（可见，不谎称失效）');
    assert.equal(resolution.reason, 'source_not_in_store');
  }
  assert.equal(probes, 1, `unwired 是定型结论：20 次公开读后探测次数必须仍是 1，实际 ${probes}（退化成每请求重探会放大库压）`);
  assert.equal(storeReads, 0, 'unwired 态必须短路，不得去问存储');
});
