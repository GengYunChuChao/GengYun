/**
 * GY-I18（#18）· `real` 模式下 `hidePost` 的**能力门**单元回归（本文件全新增，不改任何既有断言）。
 *
 * 被测链路（真实 `buildApp`，不 mock 路由/服务/外壳）：
 *   `POST /admin/posts/{id}/hide` → 守卫 → `restrictAdminOpsToAccountsAuthority()` 外壳
 *   → `admin/ops/service.ts::hidePost` → `admin/ops/community-posts.ts` 适配层
 *   → 社区 store 的**唯一** CAS 原语 `commitPostIfCurrent`。
 *
 * 钉住五件事：
 *  1. **放行**：`real` + 已接其它真实权威（注入合成 `flagsPort` 以进入外壳）+ 社区端口
 *     `persistent === true` ⇒ 200 `{accepted:true}`，且 CAS 真的把行改成
 *     `visibility='hidden'`、`revision` 1→2（业务结果不只是"返 200"）；
 *  2. **不放行**：同一装配下社区端口 `persistent === false`（＝内存实现）⇒ 503
 *     `PROVIDER_UNAVAILABLE`、`retryable:false`，且**零副作用**（行未被改、无审计）；
 *  3. **能力位由观察器原样转发**：用例 1/2 都走
 *     `app.ts` 的 `withTakedownObserver(communityStore, …)` 回退路径，
 *     因此"true 放行 / false 拒绝"同时证明 `community/takedown.ts` 没有吞掉 `persistent`；
 *  4. **负控制（整域门仍在）**：`real` 但一个真实权威都没接（`pool === null`、无 `flagsPort`、
 *     无 `accountAuthority`）⇒ 即便社区端口自述持久，整域仍 503 —— 能力位不是绕过整域门的钥匙；
 *  5. **不泄漏到非 real**：`stub` 装配不经过本外壳，既有 `hidePost` 行为逐字不变（200 + 写内存 store）。
 *
 * ⚠ 本文件**不**证明"真库下架"：合成端口的 `persistent: true` 只是能力位的**注入臂**。
 * 真库证据在 `tests/integration/community-pg.mjs` 的 admin 臂（需 `COMMUNITY_PG_TEST_URL`，缺库记 77）。
 * ⚠ 本文件**不**证明审计落库：`appendAudit` 仍写内存 ops store（`persistent:false`）——
 * "库内审计未取得"见 PR 正文的如实登记；此处只断言"未放行时不留审计"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken, mintOpaqueToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';

const API = '/api/v1';
const HIDE = (id) => `${API}/admin/posts/${id}/hide`;

/** 与 `admin-real-mode-fail-closed.test.mjs` 同形的**合成占位** real 环境（非真实凭据）。 */
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

const HIDE_POST_SCOPES = ['sources:write'];

/**
 * 合成开关端口（形状照 `FeatureFlagsPort`）：本文件只用它**进入** real 分支的能力外壳，
 * 不验证开关语义（那条由 `admin-flag-gate.test.mjs` / `admin-flags-pg.test.mjs` 覆盖）。
 * `list()` 返回契约闭集内三条合法行，让 `onReady` 的预取不会因形状非法而降级。
 */
function syntheticFlagsPort() {
  const rows = new Map(
    ['ai_enabled', 'specific_herbicide_output_enabled', 'submissions_enabled'].map((key) => [
      key,
      Object.freeze({ key, enabled: true, revision: 1 }),
    ]),
  );
  return Object.freeze({
    persistent: true,
    list: async () => [...rows.values()],
    get: async (key) => rows.get(key) ?? null,
    commitIfCurrent: async () => ({ ok: false, reason: 'REVISION_CONFLICT' }),
  });
}

/** 一条"已发布 + 审核通过"的社区帖子（社区读取侧对外可见的口径）。 */
function publishedPost(id, authorId) {
  return {
    id,
    revision: 1,
    author_id: authorId,
    title: '水稻田稗草防除记录',
    body: '结构性示例正文：先看苗情，再按标签说明选择登记药剂。',
    crop_id: 'crop-rice',
    region_code: '330100',
    media_ids: [],
    linked_knowledge_ref: null,
    visibility: 'published',
    audit_state: 'approved',
    created_at: '2026-10-22T02:00:00.000Z',
    updated_at: '2026-10-22T02:00:00.000Z',
  };
}

/**
 * 能力位注入臂：**同一份**内存 store 的浅拷贝，只覆写 `persistent`。
 * 方法与内部 Map 共享（改的是同一批行），因此"行有没有被改"可以拿原 store 复核。
 */
function withPersistence(store, persistent) {
  return { ...store, persistent };
}

async function seedAdmin(authStore) {
  const adminId = await authStore.createAdmin({
    loginName: `gyi18-hide-${Math.random().toString(36).slice(2, 10)}`,
    credentialHash: 'synthetic-not-a-real-credential-hash',
    scopes: HIDE_POST_SCOPES,
  });
  const token = mintOpaqueToken();
  await authStore.createSession({
    userId: adminId,
    tokenHashHex: hashToken(token),
    authEpoch: 1,
    expiresAt: new Date(Date.now() + 3600 * 1000),
    audience: 'admin',
  });
  return { token, adminId };
}

function hideRequest(app, token, postId, { ifMatch = '"1"' } = {}) {
  return app.inject({
    method: 'POST',
    url: HIDE(postId),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': `gyi18-hide-${randomUUID()}`,
      ...(ifMatch === null ? {} : { 'if-match': ifMatch }),
    },
    payload: { reason: '示例：管理员下架违规帖子（结构性文本）' },
  });
}

/** 内存社区 store + 一条已发布帖子；store 引用留给"行有没有真的变"的复核。 */
async function seedCommunityPost() {
  const store = createMemoryCommunityStore({ now: () => Date.now() });
  const post = publishedPost(randomUUID(), randomUUID());
  assert.equal(await store.insertPost(post, null), true);
  return { store, post };
}

test('正控制：real + 已接其它真实权威 + 社区端口 persistent:true ⇒ hidePost 200（行 visibility=hidden、revision 1→2）', async () => {
  const { store, post } = await seedCommunityPost();
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig(REAL_ENV),
    store: authStore,
    // 经 `communityInjection.store` 注入 ⇒ 后台端口走 `withTakedownObserver(store, …)` 回退路径：
    // 放行同时证明观察器把 `persistent` 原样转发给了 `hidePostWired` 判据。
    communityInjection: { store: withPersistence(store, true) },
    adminInjection: { flagsPort: syntheticFlagsPort() },
  });
  try {
    assert.notEqual(app.communityService, null, '真实持久的社区端口 ⇒ real 下社区域必须开启');
    const { token } = await seedAdmin(authStore);
    const res = await hideRequest(app, token, post.id);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.accepted, true, '契约 Ack 的成功封套');
    assert.equal(res.headers.etag, '"2"', '下架后 ETag 必须是新 revision（1→2）');

    // 业务结果（不只是"返 200"）：CAS 真的把行推进到 hidden 且 revision +1。
    const after = await store.getPost(post.id);
    assert.equal(after.visibility, 'hidden');
    assert.equal(after.revision, 2);
    assert.equal(after.author_id, post.author_id, '下架不改作者归属');
    assert.equal(after.title, post.title, '下架不改正文');
  } finally {
    await app.close();
  }
});

test('反例：real + 同一装配但社区端口 persistent:false ⇒ 503 PROVIDER_UNAVAILABLE，且零副作用', async () => {
  const { store, post } = await seedCommunityPost();
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig(REAL_ENV),
    store: authStore,
    // 注入的是**同一份**内存 store（能真的改行），只让能力位保持 `false`
    // ⇒ 若门失效，行会被改；因此"行没变"本身就是门生效的证据，而不是"端口不存在"。
    communityInjection: { store },
    adminInjection: { flagsPort: syntheticFlagsPort() },
  });
  try {
    const { token } = await seedAdmin(authStore);
    const res = await hideRequest(app, token, post.id);
    assert.equal(res.statusCode, 503, res.body);
    const body = res.json();
    assert.equal(body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(body.error.retryable, false, '未接线 ⇒ 需运维接线，同一请求原样重试不会成功');
    assert.equal(body.data, undefined, '不得返回成功封套');

    const after = await store.getPost(post.id);
    assert.equal(after.visibility, 'published', '被拒的下架不得改动可见性');
    assert.equal(after.revision, 1, '被拒的下架不得推进 revision');
    assert.equal(app.adminOpsService.store.audit.list().length, 0, '被拒的下架不得留审计（不占幂等位、不写内存）');
  } finally {
    await app.close();
  }
});

test('负控制：real + 社区端口 persistent:true，但未接任何其它真实权威（pool=null、无 flagsPort）⇒ 整域仍 503', async () => {
  const { store, post } = await seedCommunityPost();
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig(REAL_ENV),
    store: authStore,
    // 社区端口自述持久也**不放行**：整域门（`realAccountAuthority === null && !flagsWired`）
    // 在能力外壳**之前**决定一切 —— 本用例防"把能力位当整域门的旁路"。
    communityInjection: { store: withPersistence(store, true) },
  });
  try {
    assert.notEqual(app.communityService, null, '持久社区端口 ⇒ 社区域开启（因此下面的 503 只能来自后台整域门）');
    const { token } = await seedAdmin(authStore);
    const res = await hideRequest(app, token, post.id);
    assert.equal(res.statusCode, 503, res.body);
    assert.equal(res.json().error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(res.json().error.retryable, false);
    assert.equal((await store.getPost(post.id)).visibility, 'published', '整域 fail-closed 不得放过任何写入');
  } finally {
    await app.close();
  }
});

test('不泄漏到非 real：stub 装配不经过本外壳，既有 hidePost 行为逐字不变（200 + 写内存 store）', async () => {
  const { store, post } = await seedCommunityPost();
  const authStore = createMemoryAuthStore();
  const app = buildApp({
    config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    store: authStore,
    communityInjection: { store },
  });
  try {
    const { token } = await seedAdmin(authStore);
    const res = await hideRequest(app, token, post.id);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().data.accepted, true);
    const after = await store.getPost(post.id);
    assert.equal(after.visibility, 'hidden');
    assert.equal(after.revision, 2);
    // 审计仍只有**内存**一份（stub 既有口径；`persistent:false`）。
    assert.equal(app.adminOpsService.store.persistent, false);
    assert.equal(app.adminOpsService.store.audit.list().length, 1);
  } finally {
    await app.close();
  }
});
