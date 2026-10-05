import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { createMemoryIdempotencyStore } from '../../services/api/src/auth/idempotency.ts';
import { hashPassword } from '../../services/api/src/auth/password.ts';
import {
  STUB_APP_ID,
  STUB_LOOKUP_KEY,
  STUB_OPENID_PREFIX,
  computeSubjectLookup,
} from '../../services/api/src/auth/wechat.ts';

const IDEM = 'idem-key-000001';
const LOGIN_URL = '/api/v1/auth/wechat';
const USER_SESSION_URL = '/api/v1/auth/session';
const LOGOUT_URL = '/api/v1/auth/logout';
const ADMIN_SESSION_URL = '/api/v1/admin/auth/session';
const ADMIN_LOGOUT_URL = '/api/v1/admin/auth/logout';

function stubConfig(extra = {}) {
  return loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent', ...extra });
}

function newApp(extra = {}) {
  const config = extra.config ?? stubConfig();
  return buildApp({
    config,
    store: extra.store ?? createMemoryAuthStore(),
    idempotency: extra.idempotency ?? createMemoryIdempotencyStore(),
  });
}

async function login(app, code, idempotencyKey = IDEM) {
  return app.inject({
    method: 'POST',
    url: LOGIN_URL,
    headers: { 'idempotency-key': idempotencyKey },
    payload: { code },
  });
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

async function subjectOf(store, code) {
  const user = await store.findUserBySubject(computeSubjectLookup(STUB_LOOKUP_KEY, STUB_APP_ID, `${STUB_OPENID_PREFIX}${code}`));
  assert.ok(user, `合成身份未建用户：${code}`);
  return user;
}

// ---------------------------------------------------------------------------
// 游客拦截 / 登录 / 会话
// ---------------------------------------------------------------------------

test('游客拦截：无会话访问受保护接口 → 401 SESSION_REQUIRED（API 层，非前端隐藏）', async () => {
  const app = newApp();
  const res = await app.inject({ method: 'GET', url: USER_SESSION_URL });
  assert.equal(res.statusCode, 401);
  const body = res.json();
  assert.equal(body.error.code, 'SESSION_REQUIRED');
  assert.equal(body.error.retryable, false);
  assert.deepEqual(body.error.details, []);
  assert.equal(body.meta.contract_version, '1.0.0');
  assert.equal(body.meta.execution_mode, 'stub');
  await app.close();
});

test('非法/未知令牌 → 401 SESSION_EXPIRED，不泄露内部信息', async () => {
  const app = newApp();
  const unknown = await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer('not-a-real-token') });
  assert.equal(unknown.statusCode, 401);
  assert.equal(unknown.json().error.code, 'SESSION_EXPIRED');
  // 头部格式不符视为无凭据
  const malformed = await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: { authorization: 'Basic abc' } });
  assert.equal(malformed.statusCode, 401);
  assert.equal(malformed.json().error.code, 'SESSION_REQUIRED');
  await app.close();
});

test('微信登录：仅凭 code 建立会话，返回契约 Session 封套（不强制手机号）', async () => {
  const app = newApp();
  const res = await login(app, 'code-alpha');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.audience, 'user');
  assert.equal(body.data.token_type, 'Bearer');
  assert.ok(typeof body.data.access_token === 'string' && body.data.access_token.length >= 32);
  assert.match(body.data.expires_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Number.isInteger(body.data.revision) && body.data.revision >= 1);
  assert.equal(body.meta.execution_mode, 'stub');
  assert.match(body.meta.request_id, /^[0-9a-f-]{36}$/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.etag, `"${body.data.revision}"`);
  // 响应不含任何可逆身份（openid / 手机号）
  assert.ok(!/openid|phone|mobile/i.test(res.body), '登录响应不应出现 openid/手机号');
  await app.close();
});

test('GET /auth/session：返回本人 SessionInfo（audience/scopes/revision），ETag 为 revision', async () => {
  const app = newApp();
  const issued = (await login(app, 'code-alpha')).json().data;
  const res = await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer(issued.access_token) });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.audience, 'user');
  assert.deepEqual(body.data.scopes, ['user']);
  assert.equal(body.data.expires_at, issued.expires_at);
  assert.equal(body.data.revision, issued.revision);
  assert.equal(res.headers.etag, `"${issued.revision}"`);
  assert.equal(res.headers['cache-control'], 'no-store');
  await app.close();
});

// ---------------------------------------------------------------------------
// 客户端不可声明身份 / 角色
// ---------------------------------------------------------------------------

test('客户端不可在登录体声明身份：多余字段（openid/role/user_id）→ 400 INVALID_REQUEST', async () => {
  const app = newApp();
  for (const extra of [{ openid: 'evil' }, { role: 'admin' }, { user_id: '11111111-1111-4111-8111-111111111111' }]) {
    const res = await app.inject({
      method: 'POST',
      url: LOGIN_URL,
      headers: { 'idempotency-key': IDEM },
      payload: { code: 'code-alpha', ...extra },
    });
    assert.equal(res.statusCode, 400, `多余字段应被拒绝：${JSON.stringify(extra)}`);
    assert.equal(res.json().error.code, 'INVALID_REQUEST');
    assert.ok(res.json().error.details.length > 0);
  }
  await app.close();
});

test('服务端不以客户端声称的 user_id / role 作最终权限依据', async () => {
  const app = newApp();
  const token = (await login(app, 'code-claim')).json().data.access_token;
  const baseline = await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer(token) });
  assert.equal(baseline.statusCode, 200);

  const forgedId = '11111111-1111-4111-8111-111111111111';
  const forged = await app.inject({
    method: 'GET',
    url: `${USER_SESSION_URL}?user_id=${forgedId}&role=admin`,
    headers: { ...bearer(token), 'x-user-id': forgedId, 'x-role': 'admin' },
  });
  assert.equal(forged.statusCode, 200);
  // 身份不受任何客户端声明影响：与基线完全一致，且不出现被声称的 id
  assert.deepEqual(forged.json().data, baseline.json().data);
  assert.equal(forged.json().data.audience, 'user');
  assert.ok(!forged.body.includes(forgedId));

  // 声称 admin 也不能访问后台能力
  const admin = await app.inject({
    method: 'GET',
    url: ADMIN_SESSION_URL,
    headers: { ...bearer(token), 'x-role': 'admin' },
  });
  assert.equal(admin.statusCode, 403);
  assert.equal(admin.json().error.code, 'SCOPE_DENIED');
  await app.close();
});

// ---------------------------------------------------------------------------
// 退出失效 / 会话撤销
// ---------------------------------------------------------------------------

test('退出登录：撤销当前会话后同一令牌立即失效（401 SESSION_EXPIRED）', async () => {
  const app = newApp();
  const token = (await login(app, 'code-logout')).json().data.access_token;
  assert.equal((await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer(token) })).statusCode, 200);

  const logout = await app.inject({
    method: 'POST',
    url: LOGOUT_URL,
    headers: { ...bearer(token), 'idempotency-key': 'logout-key-0001' },
  });
  assert.equal(logout.statusCode, 200);
  assert.deepEqual(logout.json().data, { accepted: true });

  const after = await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer(token) });
  assert.equal(after.statusCode, 401);
  assert.equal(after.json().error.code, 'SESSION_EXPIRED');
  await app.close();
});

test('会话撤销：账号 auth_epoch 变更后既有会话立即失效（403 ACCOUNT_INACTIVE）', async () => {
  const store = createMemoryAuthStore();
  const app = newApp({ store });
  const token = (await login(app, 'code-revoke')).json().data.access_token;
  assert.equal((await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer(token) })).statusCode, 200);

  const user = await subjectOf(store, 'code-revoke');
  await store.bumpUserAuthEpoch(user.id);

  const after = await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer(token) });
  assert.equal(after.statusCode, 403);
  assert.equal(after.json().error.code, 'ACCOUNT_INACTIVE');
  await app.close();
});

// ---------------------------------------------------------------------------
// 幂等
// ---------------------------------------------------------------------------

test('幂等：缺/短路 Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
  const app = newApp();
  const missing = await app.inject({ method: 'POST', url: LOGIN_URL, payload: { code: 'code-alpha' } });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const shortKey = await app.inject({
    method: 'POST',
    url: LOGIN_URL,
    headers: { 'idempotency-key': 'short' },
    payload: { code: 'code-alpha' },
  });
  assert.equal(shortKey.statusCode, 400);
  assert.equal(shortKey.json().error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  await app.close();
});

test('幂等：同键同体重放首次响应；同键异体 → 409 IDEMPOTENCY_CONFLICT', async () => {
  const app = newApp();
  const first = await login(app, 'code-idem', 'idem-key-replay');
  const replay = await login(app, 'code-idem', 'idem-key-replay');
  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().data.access_token, first.json().data.access_token, '重放应返回首次签发的令牌');

  const conflict = await login(app, 'code-other', 'idem-key-replay');
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
  await app.close();
});

// ---------------------------------------------------------------------------
// 后台鉴权 / 管理员初始化 / 高权限拒绝
// ---------------------------------------------------------------------------

async function adminApp() {
  const config = stubConfig({ ADMIN_BOOTSTRAP_LOGIN_NAME: 'root', ADMIN_BOOTSTRAP_PASSWORD: 'bootstrap-pass-123' });
  const store = createMemoryAuthStore();
  const app = newApp({ config, store });
  const bootstrap = await app.authService.ensureBootstrapAdmin();
  return { app, store, bootstrap };
}

test('管理员初始化：仅首次创建；重复调用不重复建号', async () => {
  const { app, bootstrap } = await adminApp();
  assert.deepEqual(bootstrap, { created: true, reason: 'created', loginName: 'root' });
  assert.deepEqual(await app.authService.ensureBootstrapAdmin(), { created: false, reason: 'already_initialized' });
  await app.close();
});

test('未配置 bootstrap 凭据时不建号（不猜默认口令）', async () => {
  const app = newApp();
  assert.deepEqual(await app.authService.ensureBootstrapAdmin(), { created: false, reason: 'not_configured' });
  await app.close();
});

test('后台登录/会话/退出全流程（独立 audience=admin，带契约 scope）', async () => {
  const { app } = await adminApp();
  const loginRes = await app.inject({
    method: 'POST',
    url: ADMIN_SESSION_URL,
    headers: { 'idempotency-key': 'admin-login-0001' },
    payload: { login_name: 'root', password: 'bootstrap-pass-123' },
  });
  assert.equal(loginRes.statusCode, 200);
  assert.equal(loginRes.json().data.audience, 'admin');
  assert.equal(loginRes.json().data.token_type, 'Bearer');
  const token = loginRes.json().data.access_token;

  const session = await app.inject({ method: 'GET', url: ADMIN_SESSION_URL, headers: bearer(token) });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().data.audience, 'admin');
  assert.deepEqual(session.json().data.scopes, ['session:logout', 'session:read']);

  const logout = await app.inject({
    method: 'POST',
    url: ADMIN_LOGOUT_URL,
    headers: { ...bearer(token), 'idempotency-key': 'admin-logout-0001' },
  });
  assert.equal(logout.statusCode, 200);
  assert.deepEqual(logout.json().data, { accepted: true });

  const after = await app.inject({ method: 'GET', url: ADMIN_SESSION_URL, headers: bearer(token) });
  assert.equal(after.statusCode, 401);
  assert.equal(after.json().error.code, 'SESSION_EXPIRED');
  await app.close();
});

test('后台口令错误/账号不存在 → 401 SESSION_REQUIRED（契约无“凭据错误”专用码，如实沿用，不臆造）', async () => {
  const { app } = await adminApp();
  const wrong = await app.inject({
    method: 'POST',
    url: ADMIN_SESSION_URL,
    headers: { 'idempotency-key': 'admin-login-0002' },
    payload: { login_name: 'root', password: 'wrong-password-123' },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error.code, 'SESSION_REQUIRED');

  const ghost = await app.inject({
    method: 'POST',
    url: ADMIN_SESSION_URL,
    headers: { 'idempotency-key': 'admin-login-0003' },
    payload: { login_name: 'ghost', password: 'whatever-pass-123' },
  });
  assert.equal(ghost.statusCode, 401);
  assert.equal(ghost.json().error.code, 'SESSION_REQUIRED');
  // 未知账号与错误口令返回同一码，避免账号枚举
  assert.equal(wrong.body.replace(/"request_id":"[^"]+"/, ''), ghost.body.replace(/"request_id":"[^"]+"/, ''));
  await app.close();
});

test('后台高权限拒绝：scope 不足的管理员被 403 SCOPE_DENIED 拦下', async () => {
  const { app, store } = await adminApp();
  await store.createAdmin({ loginName: 'limited', credentialHash: hashPassword('limited-pass-123'), scopes: [] });
  const loginRes = await app.inject({
    method: 'POST',
    url: ADMIN_SESSION_URL,
    headers: { 'idempotency-key': 'admin-login-0004' },
    payload: { login_name: 'limited', password: 'limited-pass-123' },
  });
  assert.equal(loginRes.statusCode, 200);
  const token = loginRes.json().data.access_token;

  const read = await app.inject({ method: 'GET', url: ADMIN_SESSION_URL, headers: bearer(token) });
  assert.equal(read.statusCode, 403);
  assert.equal(read.json().error.code, 'SCOPE_DENIED');

  const logout = await app.inject({
    method: 'POST',
    url: ADMIN_LOGOUT_URL,
    headers: { ...bearer(token), 'idempotency-key': 'admin-logout-0002' },
  });
  assert.equal(logout.statusCode, 403);
  assert.equal(logout.json().error.code, 'SCOPE_DENIED');
  await app.close();
});

test('越权：普通用户会话访问后台 → 403 SCOPE_DENIED；后台令牌不能访问用户端', async () => {
  const { app } = await adminApp();
  const userToken = (await login(app, 'code-user-for-admin')).json().data.access_token;
  const asAdmin = await app.inject({ method: 'GET', url: ADMIN_SESSION_URL, headers: bearer(userToken) });
  assert.equal(asAdmin.statusCode, 403);
  assert.equal(asAdmin.json().error.code, 'SCOPE_DENIED');

  const adminLogin = await app.inject({
    method: 'POST',
    url: ADMIN_SESSION_URL,
    headers: { 'idempotency-key': 'admin-login-0005' },
    payload: { login_name: 'root', password: 'bootstrap-pass-123' },
  });
  const adminToken = adminLogin.json().data.access_token;
  const asUser = await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer(adminToken) });
  assert.equal(asUser.statusCode, 401);
  assert.equal(asUser.json().error.code, 'SESSION_EXPIRED');
  await app.close();
});

// ---------------------------------------------------------------------------
// real 模式的持久化要求
// ---------------------------------------------------------------------------

test('real 模式未配置数据库时拒绝签发会话（503，不假装持久化）', async () => {
  const realConfig = loadConfig({
    APP_EXECUTION_MODE: 'real',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/gengyun',
    SESSION_SIGNING_KEY: 'x'.repeat(32),
    DELETION_LEDGER_KEY: 'y'.repeat(32),
    WECHAT_APP_ID: 'wx0000000000000000',
    WECHAT_APP_SECRET: 'secret',
    OBJECT_STORAGE_ENDPOINT: 'https://oss.example.invalid',
    OBJECT_STORAGE_BUCKET: 'gengyun',
    OBJECT_STORAGE_ACCESS_KEY: 'ak',
    OBJECT_STORAGE_SECRET_KEY: 'sk',
  });
  // pool=null → 内存存储；real 模式必须拒绝，不得以进程内会话冒充持久会话。
  const app = newApp({ config: realConfig });
  const res = await login(app, 'code-real');
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(res.json().error.retryable, true);
  await app.close();
});
