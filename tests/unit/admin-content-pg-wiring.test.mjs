/**
 * 内容域 PG 落点：**装配层二分之另一半**。
 *
 * `tests/unit/admin-real-mode-fail-closed.test.mjs` 钉住的是「`real` + **无连接池** ⇒ 36 条后台
 * 路由一律 503、零内存副作用」。本文件钉住成对的另一半：
 *
 * 1. `real` + **有连接池** ⇒ 内容域那 24 条（`sources` / `knowledge` / `registrations` /
 *    `restrictions` 四族 × 6 操作）**不再 503**，而是真的走到 SQL 层（本文件用**桩池**记录
 *    发出去的 SQL 文本与参数，并断言必须打到 `public.admin_content_entities`）；
 * 2. `store.persistent === true`（PG 实现自报持久化），而 `ops` 域仍是内存实现
 *    （本片只换内容域的存储，账号/作业/开关面的接线是别的片）；
 * 3. 非内容域路由**不受影响**：作业面仍是 503（`jobPort` 未接线）。
 *
 * 为什么用桩池而不是真库：本文件是单元层证据（不连库、不需要 `GY_PG_BIN`）；真库行为由
 * `tests/integration/admin-content-pg.mjs` 覆盖（它自己起 17.x 集群）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';

const API = '/api/v1';
const UNKNOWN_UUID = '00000000-0000-4000-a000-00000000ffff';

/** 与 `tests/unit/admin-real-mode-fail-closed.test.mjs` 同形的**合成占位** real 环境（非真实凭据）。 */
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

const ALL_SCOPES = [
  'sources:read', 'sources:write', 'audit:read',
  'accounts:read', 'accounts:suspend',
  'jobs:read', 'jobs:cancel',
  'flags:read', 'flags:write',
];

/**
 * **桩池**：记录每条 SQL 的文本与参数，一律返回空结果集。
 *
 * 空结果集正是本文件要的形状：`list` 族在空表上必须回 `200 + items: []`，
 * `get` 族在空表上必须回 `404 CONTENT_NOT_FOUND` —— 两者都不需要把行映射成实体
 * （映射器只在真有行时才跑），因此不需要伪造任何列。
 */
function createStubPool() {
  const statements = [];
  const answer = async (text, values = []) => {
    statements.push({ text, values: [...values] });
    return { rows: [], rowCount: 0 };
  };
  return {
    statements,
    query: answer,
    // `transaction()` 走 `pool.connect()`；桩里给同一个答案函数，保证事务内外行为一致。
    async connect() {
      return { query: answer, release() {} };
    },
  };
}

async function seedAdmin(authStore) {
  const adminId = await authStore.createAdmin({
    loginName: `gyi18-pg-${Math.random().toString(36).slice(2, 10)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes: ALL_SCOPES,
  });
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: adminId, tokenHashHex: hashToken(token), authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600 * 1000), audience: 'admin',
  });
  return token;
}

test('real + 有池：内容域接 PG（persistent=true，list 200 / get 404，SQL 真打三表之一）', async () => {
  const authStore = createMemoryAuthStore();
  const pool = createStubPool();
  const app = buildApp({ config: loadConfig(REAL_ENV), store: authStore, pool });
  try {
    const token = await seedAdmin(authStore);
    const headers = { authorization: `Bearer ${token}` };

    // 1) PG 实现自报持久化；ops 域仍是内存实现（本片不动它）。
    assert.equal(app.adminContentService.store.persistent, true, '有池时内容域必须是持久化实现');
    assert.equal(app.adminOpsService.store.persistent, false, '本片只换内容域，运维面仍是内存实现');

    // 2) list 族：空表 ⇒ 200 + 空列表（**不是** 503）。
    const families = ['sources', 'knowledge', 'registrations', 'restrictions'];
    for (const family of families) {
      const res = await app.inject({ method: 'GET', url: `${API}/admin/${family}`, headers });
      assert.equal(res.statusCode, 200, `${family} list：有线池时不得再 503 ⇒ ${res.body}`);
      assert.deepEqual(res.json().data.items, [], `${family} list：空表必须是空列表`);
    }

    // 3) get 族：不存在的实体 ⇒ 404（**不是** 503）。空结果集不触发行映射，故桩池够用。
    const get = await app.inject({ method: 'GET', url: `${API}/admin/sources/${UNKNOWN_UUID}`, headers });
    assert.equal(get.statusCode, 404, `getDraft 必须 404 而不是 503 ⇒ ${get.body}`);
    assert.equal(get.json().error.code, 'NOT_FOUND');

    // 4) 真打库：至少一条 SELECT 落在内容实体表上（证明不是"内存假装持久化"）。
    const touched = pool.statements.filter((s) => /public\.admin_content_entities/.test(s.text));
    assert.ok(touched.length >= 1, `必须真的查询 public.admin_content_entities，实际语句：${pool.statements.map((s) => s.text).join(' | ')}`);
    const listSelect = touched.find((s) => s.text.includes('family = $1'));
    assert.ok(listSelect, 'list 族必须按 family 过滤查询内容实体表');
    assert.deepEqual(listSelect.values[0], 'sources', 'family 必须作为参数传下去');

    // 5) 成对的反面：同一份 real 配置、**不传池** ⇒ 同一条路由回到 503（fail-closed 未被删掉）。
    const noPoolStore = createMemoryAuthStore();
    const noPoolApp = buildApp({ config: loadConfig(REAL_ENV), store: noPoolStore });
    try {
      const noPoolToken = await seedAdmin(noPoolStore);
      const blocked = await noPoolApp.inject({
        method: 'GET', url: `${API}/admin/sources`, headers: { authorization: `Bearer ${noPoolToken}` },
      });
      assert.equal(blocked.statusCode, 503, `无池时内容域必须仍然是 503 ⇒ ${blocked.body}`);
      assert.equal(blocked.json().error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(blocked.json().error.retryable, false);
      assert.equal(noPoolApp.adminContentService.store.persistent, false, '无池时不得静默降级成"持久化"');
    } finally {
      await noPoolApp.close();
    }
  } finally {
    await app.close();
  }
});
