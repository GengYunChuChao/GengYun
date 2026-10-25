// GY-I18（#18）· **内容存储就绪探测（三态）× 公开读引用解析** 的单元层证据。
//
// 为什么需要本文件：迁移 0036 之后，`real` ＋有池时内容域是 PG 实现（`persistent: true`）。
// 部署里**没有**这三张表时（子集库、还没跑 0036 的环境），`foldDatabaseError` 会把 `42P01`
// 折成 503 `PROVIDER_UNAVAILABLE`，把**公开读**（`/herbicides`、`/knowledge`）一起打成 503。
// 本文件钉住的三态（⛔ 不许合并成两态、⛔ 不许把库错误无差别吞成 `unverifiable`）：
//
//   | 探测结论 | 含义 | 公开读行为 |
//   |---|---|---|
//   | `ready`   | 三张表都在 | 按已接线解析：引用不可用 ⇒ 隐藏（下架/失效**一律不可见**） |
//   | `missing` | `to_regclass` 明确回 NULL ⇒ **确认未配置**（不是故障） | 退回接线前行为：不过滤、200 |
//   | `unknown` | 探测出错（连接/权限/超时）或形状读不懂 ⇒ **未知 ≠ 未安装** | **不降级**，真实解析 fail-closed 503 |
//
// 覆盖点：
//   A. `missing` ⇒ `/herbicides` 200，且**零** `public.admin_content_*` 查询（证明是短路，不是"查询失败但被吞"）；
//   B. 探测 `42501`（授权/连接故障）⇒ `/herbicides` **仍然 503**，且**真的**打了内容表（证明未降级）；
//   C. `ready` ＋来源已撤回 ⇒ `resolve` 判 `unavailable` ⇒ 公开面**不可见**（hidden 不放宽）；
//   D. 内存 store（`persistent: false`）⇒ **不探测**、行为逐字不变；
//   E. `probeAdminContentTables` 的六种输入形状各自落在哪一态。
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

test('A. 确认未配置（missing）⇒ /herbicides 200，且零内容表查询（短路，不是吞错）', async () => {
  const authStore = createMemoryAuthStore();
  const pool = createStubPool({ contentProbe: () => ({ rows: [{ ready: false }], rowCount: 1 }) });
  const app = buildApp({ config: loadConfig(REAL_ENV), store: authStore, pool });
  try {
    const token = await syntheticUserToken(authStore);
    const res = await get(app, `${API}/herbicides`, token);
    assert.equal(res.statusCode, 200, `缺 0036 三表 ⇒ 公开读不得 503/409，实际 ${res.statusCode} ⇒ ${res.body}`);
    const items = res.json().data.items;
    assert.ok(items.length >= 1, '前置：种子里必须有行，否则 resolve 根本不会被调用（本用例就失去意义）');
    // 关键：一条内容表查询都没发出去 —— 证明 status 200 来自"降级短路"，而不是"查询失败被吞掉"。
    const touched = pool.statements.filter((entry) => CONTENT_QUERY.test(entry.text));
    assert.deepEqual(touched, [], `missing 态必须短路、不得去读 0036 三表，实际：${touched.map((e) => e.text).join(' | ')}`);
  } finally {
    await app.close();
  }
});

test('B. 探测故障（unknown：42501）⇒ 仍 503，且真的打了内容表（未降级、未吞错）', async () => {
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

test('C. 已接线（ready）＋来源已撤回 ⇒ resolve 判 unavailable ⇒ 公开面不可见（hidden 不放宽）', async () => {
  // 来源已撤回：`liveRevisionOf` 回 null，判定表 ⇒ unavailable / source_withdrawn。
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
  const pool = { async query() { return { rows: [{ ready: true }], rowCount: 1 }; } };
  const resolve = createAdminContentReferenceResolver({ host, store, pool });
  await host.runHooks();

  const content = { source_id: withdrawn.id, source_version: 'v1' };
  const resolution = await resolve('knowledge', content);
  assert.equal(reads, 1, 'ready 态必须去问存储（不得短路）');
  assert.equal(resolution.state, 'unavailable', `已撤回来源的引用必须判不可用，实际 ${resolution.state}`);
  assert.equal(resolution.reason, 'source_withdrawn');

  const decision = await decidePublicVisibilityAsync({ family: 'knowledge', content, resolve });
  assert.equal(decision.visible, false, '下架/失效内容**不得**因探测接线而变可见');
  assert.equal(decision.reason, 'unavailable');
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
  const pool = createStubPool({ contentProbe: () => ({ rows: [{ ready: true }], rowCount: 1 }) });
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

test('E. probeAdminContentTables：六种输入形状各自落在哪一态', async () => {
  assert.deepEqual(await probeAdminContentTables(null), { state: 'unknown', reason: 'no_pool' });
  assert.deepEqual(await probeAdminContentTables(undefined), { state: 'unknown', reason: 'no_pool' });
  assert.deepEqual(
    await probeAdminContentTables({ async query() { return { rows: [{ ready: true }] }; } }),
    { state: 'ready' },
  );
  assert.deepEqual(
    await probeAdminContentTables({ async query() { return { rows: [{ ready: false }] }; } }),
    { state: 'missing' },
  );
  assert.deepEqual(
    await probeAdminContentTables({ async query() { throw Object.assign(new Error('boom'), { code: '42501' }); } }),
    { state: 'unknown', reason: 'probe_error' },
    '连接/权限故障必须是 unknown（⛔ 不得折成 missing 后放行）',
  );
  assert.deepEqual(
    await probeAdminContentTables({ async query() { return { rows: [] }; } }),
    { state: 'unknown', reason: 'unexpected_shape' },
  );
  assert.deepEqual(
    await probeAdminContentTables({ async query() { return { rows: [{}] }; } }),
    { state: 'unknown', reason: 'unexpected_shape' },
  );
});
