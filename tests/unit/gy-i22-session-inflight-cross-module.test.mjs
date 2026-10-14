/**
 * GY-I22（issue #22）· **跨模块会话/角色在途变化**失败回归（HTTP 级，真实组合应用）。
 *
 * ## 本文件补的空白（为什么不是既有用例的重复）
 * 既有覆盖是**逐域单模块**的：每个域自己的用例造一枚**全新有效令牌**，断言"游客拒绝、
 * 越权同形 404"。`auth-guards.test.mjs` 只测 `middleware.ts` 的纯函数；`community-http.test.mjs`
 * 只在**社区**域里断言失效会话；`messages-http.test.mjs` 只在**消息**域里断言账号 epoch 变化。
 * 因此「单模块自身通过」是成立的。
 *
 * 但 issue #22 要的是**整体**：同一次会话变更（注销／账号版本前进／停用／过期／受众混用／
 * 后台权限降级）之后，那枚**旧令牌**在**组合进 `buildApp` 之后的每一个受保护面**上是否
 * 都被一致拒绝。只要有一个面漏挂共享守卫（或自己解析身份），整体就会越权 —— 而任何单模块
 * 用例都不会变红。本文件把全部受保护面放进**一个矩阵**里，逐面断言，并断言它们给出的
 * 错误封套**逐字节同形**（`error` 全字段 + `meta.contract_version` + `meta.execution_mode`）。
 *
 * ## 反向自证（矩阵不是空转）
 * 「游客无令牌 ⇒ 每一面 401」这一条同时充当**路由确实存在且确实挂了鉴权守卫**的结构性证明：
 * 若某个面是未注册、或注册了但没挂守卫，它会给出 404 `未实现的路径` 或 2xx，本用例立刻变红。
 * 另有正控制用例断言**有效令牌在全部面上都不被鉴权拒绝**，排除"整列恒 401"的空转。
 *
 * ## 声明（不得误读）
 * - 账号、令牌、正文、开关都是**合成夹具**；本文件不是真实供应商、真实登录或真机证据。
 * - 停用（`state='suspended'`）用**只读包装**认证存储实现：真实 PostgreSQL 实现里
 *   `users.state` 本来就是可写列（`createPostgresAuthStore` 按该列判定），本包装只把
 *   该列端点前移，不修改任何实现文件。注销/账号版本前进/过期用**真实**存储 API。
 * - 后台权限降级用**只读过滤包装** `listAdminScopes`（真实实现按 `admin_scopes.revoked_at IS NULL`
 *   过滤，语义等价），因为内存存储没有"撤回 scope"的写口。
 * - 未放宽任何既有断言：本文件只**新增**用例，不修改、不跳过任何既有用例。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { createMemoryCommunityStore } from '../../services/api/src/community/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { ADMIN_FLAG_KEYS } from '../../services/api/src/routes/admin.ts';
import { CLEAN_BODY, CLEAN_TITLE, makeGate } from './community-fixtures.mjs';

const API = '/api/v1';
const START = Date.UTC(2026, 9, 25, 4, 0, 0);
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';
const SHA256 = 'a'.repeat(64);
/** 契约闭集内、且**可配置**的开关（安全语义保留名会被服务层显式拒绝）。 */
const FLAG_KEY = ADMIN_FLAG_KEYS[0];

// ---------------------------------------------------------------------------
// 受保护面矩阵：请求一律**形状合法**（schema 校验在 preHandler 之前跑，
// 形状不合法会先得到 400 而掩盖鉴权结论；这里必须让失败只可能来自守卫）。
// ---------------------------------------------------------------------------

const READ_FACES = Object.freeze([
  { label: '认证 GET /auth/session', method: 'GET', path: `${API}/auth/session` },
  { label: '档案 GET /me/profile', method: 'GET', path: `${API}/me/profile` },
  { label: '授权 GET /me/consents', method: 'GET', path: `${API}/me/consents` },
  { label: '收藏 GET /favorites', method: 'GET', path: `${API}/favorites` },
  { label: '历史 GET /history', method: 'GET', path: `${API}/history` },
  { label: '消息 GET /messages', method: 'GET', path: `${API}/messages` },
  { label: '未读 GET /messages/unread-count', method: 'GET', path: `${API}/messages/unread-count` },
  { label: '社区 GET /posts', method: 'GET', path: `${API}/posts` },
  { label: '资料 GET /knowledge', method: 'GET', path: `${API}/knowledge` },
  { label: '药剂 GET /herbicides', method: 'GET', path: `${API}/herbicides` },
  { label: '识别 GET /recognitions/{id}', method: 'GET', path: `${API}/recognitions/${ABSENT_UUID}` },
  { label: '图文 GET /ocr/{id}', method: 'GET', path: `${API}/ocr/${ABSENT_UUID}` },
  { label: '转写 GET /speech/transcriptions/{id}', method: 'GET', path: `${API}/speech/transcriptions/${ABSENT_UUID}` },
  { label: '作业 GET /jobs/{id}', method: 'GET', path: `${API}/jobs/${ABSENT_UUID}` },
]);

const WRITE_FACES = Object.freeze([
  {
    label: '媒体受理 POST /media/uploads',
    method: 'POST',
    path: `${API}/media/uploads`,
    headers: { 'idempotency-key': 'gy-i22-media-upload-0001' },
    payload: { purpose: 'weed_recognition', mime: 'image/jpeg', bytes: 1024, sha256: SHA256 },
  },
  {
    label: '社区投稿 POST /posts',
    method: 'POST',
    path: `${API}/posts`,
    headers: { 'idempotency-key': 'gy-i22-community-post-0001' },
    payload: { title: CLEAN_TITLE, body: CLEAN_BODY, media_ids: [] },
  },
]);

const USER_FACES = Object.freeze([...READ_FACES, ...WRITE_FACES]);

/** 后台面（`requireAdmin` 在前、`requireScope` 在后 ⇒ 用户会话必须先得到 SCOPE_DENIED）。 */
const ADMIN_FACES = Object.freeze([
  { label: '后台 GET /admin/feature-flags', method: 'GET', path: `${API}/admin/feature-flags` },
  { label: '后台 GET /admin/sources', method: 'GET', path: `${API}/admin/sources` },
  { label: '后台 GET /admin/audit-events', method: 'GET', path: `${API}/admin/audit-events` },
  {
    label: '后台 PUT /admin/feature-flags/{key}',
    method: 'PUT',
    path: `${API}/admin/feature-flags/${FLAG_KEY}`,
    headers: { 'idempotency-key': 'gy-i22-admin-flag-set-0001', 'if-match': '"1"' },
    payload: { enabled: false, reason: 'GY-I22 跨模块回归（合成）' },
  },
]);

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

async function makeFixture(t) {
  let time = START;
  const base = createMemoryAuthStore();
  // 只读包装（不修改任何实现文件）：把真实实现里本就是**可写列/可撤回行**的两个端点前移。
  const control = { suspended: new Set(), revokedScopes: new Set() };
  const auth = {
    ...base,
    async getUser(userId) {
      const user = await base.getUser(userId);
      if (user !== null && control.suspended.has(user.id)) return { ...user, state: 'suspended' };
      return user;
    },
    async listAdminScopes(adminId) {
      return (await base.listAdminScopes(adminId)).filter((scope) => !control.revokedScopes.has(scope));
    },
  };
  const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'stub' };
  const app = buildApp({
    config,
    store: auth,
    now: () => new Date(time),
    communityInjection: { store: createMemoryCommunityStore({ now: () => time }), gate: makeGate() },
    messagesInjection: { store: createMemoryMessagesStore({ now: () => time }) },
  });
  t.after(() => app.close());

  async function makeUser(subject) {
    const user = await auth.createUser(subject.repeat(64));
    const token = `synthetic-gy-i22-user-token-${subject}`;
    await auth.createSession({
      userId: user.id,
      tokenHashHex: hashToken(token),
      authEpoch: user.authEpoch,
      expiresAt: new Date(START + 48 * 3600_000),
      audience: 'user',
    });
    return { user, token };
  }
  async function makeAdmin(scopes, label) {
    const adminId = await auth.createAdmin({
      loginName: `gy-i22-admin-${label}`,
      credentialHash: 'synthetic-not-a-real-credential-hash',
      scopes,
    });
    const token = `synthetic-gy-i22-admin-token-${label}`;
    await auth.createSession({
      userId: adminId,
      tokenHashHex: hashToken(token),
      authEpoch: 1,
      expiresAt: new Date(START + 3600_000),
      audience: 'admin',
    });
    return { adminId, token };
  }

  const a = await makeUser('a');
  const b = await makeUser('b');
  const adminAll = await makeAdmin(
    ['flags:read', 'flags:write', 'sources:read', 'sources:write', 'audit:read', 'accounts:read', 'accounts:suspend', 'jobs:read', 'jobs:cancel'],
    'full',
  );
  return {
    app,
    auth,
    base,
    control,
    a,
    b,
    adminAll,
    makeUser,
    makeAdmin,
    advance: (ms) => {
      time += ms;
    },
  };
}

async function call(app, entry, token, { extraHeaders = {} } = {}) {
  const headers = {
    ...(token === null || token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...(entry.headers ?? {}),
    ...extraHeaders,
  };
  if (entry.payload !== undefined) headers['content-type'] = 'application/json';
  const response = await app.inject({
    method: entry.method,
    url: entry.path,
    headers,
    ...(entry.payload === undefined ? {} : { payload: entry.payload }),
  });
  let body = null;
  try {
    body = response.json();
  } catch {
    body = null;
  }
  return { status: response.statusCode, body };
}

/**
 * 错误封套指纹：`error` 全字段 + `meta` 里与调用方无关的两个字段。
 * 排除 `meta.request_id`（每次都不同，且刻意不参与同形判定）。
 */
function fingerprint(result) {
  assert.ok(result.body !== null, `响应必须是 JSON 错误封套，实际 status=${result.status}`);
  assert.equal(result.body.data, undefined, '错误响应不得携带成功封套');
  const { error, meta } = result.body;
  assert.ok(error !== undefined && meta !== undefined, '错误封套缺少 error/meta');
  return JSON.stringify({
    error,
    contract_version: meta.contract_version,
    execution_mode: meta.execution_mode,
  });
}

/**
 * 矩阵一致性断言：**每一面**都必须给出指定的状态码与错误码，且**所有面**的错误封套
 * 逐字节同形（`error` 连 message/retryable/details 都一致），并且不是
 * "未实现的路径" 这种未注册兜底。
 */
async function expectUniformRejection(app, faces, token, status, code, note) {
  const fingerprints = new Set();
  for (const entry of faces) {
    const result = await call(app, entry, token);
    assert.notEqual(
      result.body?.error?.message?.startsWith?.('未实现的路径') === true,
      true,
      `${entry.label}：该面未注册（404 兜底），不属于"被鉴权拒绝" —— ${note}`,
    );
    assert.equal(result.status, status, `${entry.label}：期望 ${status}，实际 ${result.status} ${JSON.stringify(result.body)}`);
    assert.equal(result.body.error.code, code, `${entry.label}：期望错误码 ${code}，实际 ${result.body.error.code}`);
    assert.equal(result.body.error.retryable, false, `${entry.label}：鉴权类拒绝不得标记 retryable`);
    assert.deepEqual(result.body.error.details, [], `${entry.label}：鉴权类拒绝不得携带字段级明细`);
    fingerprints.add(fingerprint(result));
  }
  assert.equal(
    fingerprints.size,
    1,
    `全部受保护面必须给出**逐字节同形**的错误封套；实际出现 ${fingerprints.size} 种：\n${[...fingerprints].join('\n')}`,
  );
  return [...fingerprints][0];
}

// ---------------------------------------------------------------------------
// 1. 游客矩阵（同时充当"该面确实挂守卫"的结构性证明）
// ---------------------------------------------------------------------------

test('跨模块·游客矩阵：无令牌在全部 16 个受保护面一致 401 SESSION_REQUIRED，且错误封套逐字节同形', async (t) => {
  const h = await makeFixture(t);
  assert.equal(USER_FACES.length, 16, '矩阵应覆盖 14 个读面 + 2 个写面');
  const print = await expectUniformRejection(h.app, USER_FACES, null, 401, 'SESSION_REQUIRED', '游客');
  assert.equal(typeof print, 'string');

  // 后台面同样不得对游客放行。
  await expectUniformRejection(h.app, ADMIN_FACES, null, 401, 'SESSION_REQUIRED', '游客访问后台面');
});

// ---------------------------------------------------------------------------
// 2. 正控制（矩阵非空转）
// ---------------------------------------------------------------------------

test('跨模块·正控制：同一枚有效用户令牌在全部面上都不被鉴权拒绝（排除整列恒 401 的空转）', async (t) => {
  const h = await makeFixture(t);
  for (const entry of USER_FACES) {
    const result = await call(h.app, entry, h.a.token);
    assert.notEqual(result.status, 401, `${entry.label}：有效令牌不得 401（${JSON.stringify(result.body)}）`);
    assert.notEqual(result.status, 403, `${entry.label}：有效令牌不得 403（${JSON.stringify(result.body)}）`);
    assert.notEqual(
      result.body?.error?.message?.startsWith?.('未实现的路径') === true,
      true,
      `${entry.label}：矩阵项必须是已注册路由`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. 注销（会话撤销）在途变化
// ---------------------------------------------------------------------------

test('跨模块·注销：POST /auth/logout 后同一枚旧令牌在全部 16 个面一致 401 SESSION_EXPIRED（不得有任何一面留用旧会话）', async (t) => {
  const h = await makeFixture(t);
  // 注销前：旧令牌确实可用（正控制，证明后面变红不是因为它从来不可用）。
  const before = await call(h.app, READ_FACES[0], h.a.token);
  assert.equal(before.status, 200, JSON.stringify(before.body));

  const logout = await h.app.inject({
    method: 'POST',
    url: `${API}/auth/logout`,
    headers: { authorization: `Bearer ${h.a.token}`, 'idempotency-key': 'gy-i22-logout-0001' },
  });
  assert.equal(logout.statusCode, 200, logout.body);
  assert.equal(logout.json().data.accepted, true);

  await expectUniformRejection(h.app, USER_FACES, h.a.token, 401, 'SESSION_EXPIRED', '注销后');

  // B 的会话不受 A 注销影响（撤销必须是按会话的，不是按进程/全局的）。
  const otherSession = await call(h.app, READ_FACES[0], h.b.token);
  assert.equal(otherSession.status, 200, '他人会话不得被连带撤销');
});

test('跨模块·会话撤销幂等且不可复活：旧令牌重放注销请求本身也必须 401（不得重放旧 Ack）', async (t) => {
  const h = await makeFixture(t);
  const headers = { authorization: `Bearer ${h.a.token}`, 'idempotency-key': 'gy-i22-logout-replay-0001' };
  const first = await h.app.inject({ method: 'POST', url: `${API}/auth/logout`, headers });
  assert.equal(first.statusCode, 200, first.body);
  const replay = await h.app.inject({ method: 'POST', url: `${API}/auth/logout`, headers });
  assert.equal(replay.statusCode, 401, replay.body);
  assert.equal(replay.json().error.code, 'SESSION_EXPIRED');
  assert.equal(replay.json().data, undefined);
});

// ---------------------------------------------------------------------------
// 4. 账号版本前进（停用/注销使既有会话立即失效的真实存储语义）
// ---------------------------------------------------------------------------

test('跨模块·账号版本前进：auth_epoch 前进后旧令牌在全部 16 个面一致 403 ACCOUNT_INACTIVE', async (t) => {
  const h = await makeFixture(t);
  const before = await call(h.app, READ_FACES[0], h.a.token);
  assert.equal(before.status, 200, JSON.stringify(before.body));

  await h.auth.bumpUserAuthEpoch(h.a.user.id);

  await expectUniformRejection(h.app, USER_FACES, h.a.token, 403, 'ACCOUNT_INACTIVE', '账号版本前进后');
  // 账号版本前进是**账号级**变更：B 的会话不受影响。
  assert.equal((await call(h.app, READ_FACES[0], h.b.token)).status, 200, '他人会话不得被连带失效');
  // 重新登录会拿到新 epoch；旧令牌即使被"再授权"也不复活（epoch 只增不回）。
  const again = await call(h.app, READ_FACES[0], h.a.token);
  assert.equal(again.status, 403, '旧令牌不得因后续操作复活');
});

test('跨模块·账号停用：state=suspended 后旧令牌在全部 16 个面一致 403 ACCOUNT_INACTIVE', async (t) => {
  const h = await makeFixture(t);
  const before = await call(h.app, READ_FACES[0], h.a.token);
  assert.equal(before.status, 200, JSON.stringify(before.body));

  h.control.suspended.add(h.a.user.id);

  await expectUniformRejection(h.app, USER_FACES, h.a.token, 403, 'ACCOUNT_INACTIVE', '账号停用后');
  assert.equal((await call(h.app, READ_FACES[0], h.b.token)).status, 200, '他人会话不受账号停用影响');
});

// ---------------------------------------------------------------------------
// 5. 过期令牌
// ---------------------------------------------------------------------------

test('跨模块·过期令牌：会话绝对到期后同一枚令牌在全部 16 个面一致 401 SESSION_EXPIRED', async (t) => {
  const h = await makeFixture(t);
  assert.equal((await call(h.app, READ_FACES[0], h.a.token)).status, 200);
  // 会话绝对到期时刻为 START + 48h。
  h.advance(48 * 3600_000 + 1);
  await expectUniformRejection(h.app, USER_FACES, h.a.token, 401, 'SESSION_EXPIRED', '会话过期后');
});

// ---------------------------------------------------------------------------
// 6. 受众隔离（用户令牌 ↔ 后台令牌不得互用）
// ---------------------------------------------------------------------------

test('跨模块·受众隔离：用户令牌访问全部后台面一致 403 SCOPE_DENIED，后台令牌访问全部用户面一致 401 SESSION_EXPIRED', async (t) => {
  const h = await makeFixture(t);
  // 用户令牌在后台面：SCOPE_DENIED（明确的高权限拒绝，不是 404/403 之外的口径）。
  await expectUniformRejection(h.app, ADMIN_FACES, h.a.token, 403, 'SCOPE_DENIED', '用户令牌访问后台面');
  // 后台令牌在用户面：后台会话不构成用户会话。
  await expectUniformRejection(h.app, USER_FACES, h.adminAll.token, 401, 'SESSION_EXPIRED', '后台令牌访问用户面');

  // 正控制：后台令牌在后台面可用（证明上面的 401 不是因为它不可用）。
  const ok = await call(h.app, ADMIN_FACES[0], h.adminAll.token);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

// ---------------------------------------------------------------------------
// 7. 后台权限在途降级（按调用点重查 scope + 零副作用）
// ---------------------------------------------------------------------------

test('跨模块·后台权限在途降级：撤掉 flags:write 后旧后台令牌写面 403 SCOPE_DENIED，开关零变更，flags:read 仍可用', async (t) => {
  const h = await makeFixture(t);
  const callAdmin = (entry, token) => call(h.app, entry, token);

  // 先读出当前开关状态与 revision（权威结论只来自服务端响应，不由测试臆造）。
  const listBefore = await callAdmin(ADMIN_FACES[0], h.adminAll.token);
  assert.equal(listBefore.status, 200, JSON.stringify(listBefore.body));
  const flagBefore = listBefore.body.data.items.find((item) => item.key === FLAG_KEY);
  assert.ok(flagBefore !== undefined, `开关 ${FLAG_KEY} 应在列表里`);

  // 真实写一次（翻转），证明写面在降级前确实可用。
  const flipTo = !flagBefore.enabled;
  const writeEntry = {
    ...ADMIN_FACES[3],
    headers: { 'idempotency-key': 'gy-i22-admin-flag-set-0002', 'if-match': `"${flagBefore.revision}"` },
    payload: { enabled: flipTo, reason: 'GY-I22 跨模块回归：降级前真写一次（合成）' },
  };
  const wrote = await call(h.app, writeEntry, h.adminAll.token);
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
  assert.equal(wrote.body.data.enabled, flipTo);
  const revisionAfterWrite = wrote.body.data.revision;
  assert.ok(revisionAfterWrite > flagBefore.revision, '真实写入必须推进 revision');

  // 在途降级：撤回 flags:write（只读过滤包装，等价于真实实现里 admin_scopes 行被撤回）。
  h.control.revokedScopes.add('flags:write');

  const denied = await call(
    h.app,
    {
      ...writeEntry,
      headers: { 'idempotency-key': 'gy-i22-admin-flag-set-0003', 'if-match': `"${revisionAfterWrite}"` },
      payload: { enabled: flagBefore.enabled, reason: 'GY-I22 跨模块回归：降级后必须被拒（合成）' },
    },
    h.adminAll.token,
  );
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.body.error.code, 'SCOPE_DENIED');
  assert.equal(denied.body.data, undefined);

  // 零副作用：值仍是刚才写入的那个，revision 未再推进。
  const listAfter = await callAdmin(ADMIN_FACES[0], h.adminAll.token);
  assert.equal(listAfter.status, 200, '仍有 flags:read ⇒ 读面必须继续可用（只降级被撤的那一项）');
  const flagAfter = listAfter.body.data.items.find((item) => item.key === FLAG_KEY);
  assert.equal(flagAfter.enabled, flipTo, '被拒的写请求不得改变开关值');
  assert.equal(flagAfter.revision, revisionAfterWrite, '被拒的写请求不得推进 revision');
});
