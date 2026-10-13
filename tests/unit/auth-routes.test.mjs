import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import {
  createMemoryIdempotencyStore,
  idempotencyKeyHashHex,
  idempotencyScope,
} from '../../services/api/src/auth/idempotency.ts';
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
    now: extra.now,
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

/** 读取某幂等键的台账记录（用于断言「台账不含凭据」）。 */
function readIdempotencyRecord(store, subject, method, routePath, key) {
  const scope = idempotencyScope(subject, method, routePath);
  return store.find(scope, idempotencyKeyHashHex(scope, key));
}

/**
 * 包装内存存储，如实统计「会话记录数 / 活跃数」，用于校验同键幂等是否收敛到同一会话。
 * 统计口径来自 store 的 createSession / revokeSession 调用，不读取实现内部结构。
 */
function trackingStore(base = createMemoryAuthStore()) {
  const sessions = new Map(); // sessionId -> { revoked }
  const store = {
    ...base,
    async createSession(input) {
      const id = await base.createSession(input);
      sessions.set(id, { revoked: false });
      return id;
    },
    async revokeSession(sessionId, audience) {
      await base.revokeSession(sessionId, audience);
      const entry = sessions.get(sessionId);
      if (entry !== undefined) entry.revoked = true;
    },
    rotateSessionToken(sessionId, newTokenHashHex, audience) {
      return base.rotateSessionToken(sessionId, newTokenHashHex, audience);
    },
  };
  return {
    store,
    sessionCount: () => sessions.size,
    activeCount: () => [...sessions.values()].filter((s) => !s.revoked).length,
  };
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

test('幂等：同键同体收敛到同一会话（重放换发令牌、旧令牌失效）；台账不含明文令牌；同键异体 → 409', async () => {
  const idempotency = createMemoryIdempotencyStore();
  const tracker = trackingStore();
  const app = newApp({ idempotency, store: tracker.store });
  const first = await login(app, 'code-idem', 'idem-key-replay');
  assert.equal(first.statusCode, 200);
  const firstToken = first.json().data.access_token;

  // P1-①：台账只保存不含凭据的结果引用，绝不写入明文 bearer。
  const record = await readIdempotencyRecord(idempotency, 'anonymous', 'POST', '/auth/wechat', 'idem-key-replay');
  assert.ok(record !== null);
  assert.equal(JSON.stringify(record).includes(firstToken), false, '台账不得包含明文令牌');
  assert.equal(JSON.stringify(record).includes('access_token'), false, '台账不得包含令牌字段');
  assert.equal(record.outcome.audience, 'user');
  assert.equal(typeof record.outcome.sessionId, 'string');

  const replay = await login(app, 'code-idem', 'idem-key-replay');
  assert.equal(replay.statusCode, 200);
  const replayToken = replay.json().data.access_token;
  // 重放是「同一会话换发新令牌」而非回放旧令牌。
  assert.notEqual(replayToken, firstToken, '重放应换发新令牌，而非回放旧令牌');
  // 收敛到同一会话：绝对时效保持首次，且只创建了一条会话。
  assert.equal(replay.json().data.expires_at, first.json().data.expires_at, '同键重放的绝对时效应保持首次');
  assert.equal(tracker.sessionCount(), 1, '同键重放不得新建会话');
  // 同一会话只保留一个可用令牌：换发后旧令牌失效。
  assert.equal((await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer(firstToken) })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer(replayToken) })).statusCode, 200);

  const conflict = await login(app, 'code-other', 'idem-key-replay');
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
  await app.close();
});

test('R2-1 同键重试收敛同一会话；退出当前会话后重放原 code/key 必须拒绝（会话数 1、活跃 0）', async () => {
  const tracker = trackingStore();
  const app = newApp({ store: tracker.store });

  // 1) 首次登录：建立会话（token1）。
  const first = await login(app, 'code-r2-1', 'idem-r2-1');
  assert.equal(first.statusCode, 200);
  const token1 = first.json().data.access_token;

  // 2) 同 code/key 重试：收敛到**同一会话**（换发 token2），不新建会话。
  const second = await login(app, 'code-r2-1', 'idem-r2-1');
  assert.equal(second.statusCode, 200);
  const token2 = second.json().data.access_token;
  assert.notEqual(token2, token1);
  assert.equal(second.json().data.expires_at, first.json().data.expires_at, '绝对时效保持首次');
  assert.equal(tracker.sessionCount(), 1, '同键重试不得新建会话');
  assert.equal(tracker.activeCount(), 1);
  // 同一会话只保留最新令牌：token1 已被换发失效。
  assert.equal((await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer(token1) })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer(token2) })).statusCode, 200);

  // 3) 退出「当前」会话（token2 所属的那条会话）。
  const logout = await app.inject({
    method: 'POST',
    url: LOGOUT_URL,
    headers: { ...bearer(token2), 'idempotency-key': 'logout-r2-1-0001' },
  });
  assert.equal(logout.statusCode, 200);
  assert.deepEqual(logout.json().data, { accepted: true });

  // 4) 再重放原 code/key：必须拒绝（不得再签发可用凭据）。
  const replay = await login(app, 'code-r2-1', 'idem-r2-1');
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error.code, 'SESSION_EXPIRED');

  // 会话记录数 / 活跃数如实断言：1 条、0 活跃（不得监工探针的 3 条 2 活跃）。
  assert.equal(tracker.sessionCount(), 1, '同键重放不得新建会话（应为 1 条，而非 3 条）');
  assert.equal(tracker.activeCount(), 0, '退出后该唯一会话已撤销，活跃数应为 0');
  await app.close();
});

test('R2-2 并发同键重试收敛到同一会话（不产生互不关联多会话），绝对时效以首次为准', async () => {
  const tracker = trackingStore();
  const app = newApp({ store: tracker.store });

  const [a, b] = await Promise.all([
    login(app, 'code-r2-2', 'idem-r2-2'),
    login(app, 'code-r2-2', 'idem-r2-2'),
  ]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);

  // 收敛结果唯一：只创建一条会话、活跃数唯一。
  assert.equal(tracker.sessionCount(), 1, '并发同键不得产生互不关联的多条会话');
  assert.equal(tracker.activeCount(), 1);
  // 绝对时效以首次为准：两次响应 expires_at 一致。
  assert.equal(a.json().data.expires_at, b.json().data.expires_at, '并发同键的绝对时效应一致（以首次为准）');

  // 两个令牌不同，且同一会话恰好保留一个可用令牌（换发使较早的那个失效）。
  const ta = a.json().data.access_token;
  const tb = b.json().data.access_token;
  assert.notEqual(ta, tb);
  const sa = (await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer(ta) })).statusCode;
  const sb = (await app.inject({ method: 'GET', url: USER_SESSION_URL, headers: bearer(tb) })).statusCode;
  assert.deepEqual([sa, sb].sort(), [200, 401], '同一会话应恰好保留一个可用令牌');
  await app.close();
});

test('幂等：24小时窗口内复用原会话且不滑动，到期物理清理，台账不含凭据', async (t) => {
  let clockMs = Date.parse('2026-01-01T00:00:00Z');
  const startMs = clockMs;
  const idempotency = createMemoryIdempotencyStore();
  const tracker = trackingStore();
  const app = newApp({ store: tracker.store, idempotency, now: () => new Date(clockMs) });
  t.after(() => app.close());
  const first = await login(app, 'code-ttl', 'idem-key-ttl');
  assert.equal(first.statusCode, 200);
  const firstToken = first.json().data.access_token;
  const record = await readIdempotencyRecord(idempotency, 'anonymous', 'POST', '/auth/wechat', 'idem-key-ttl');
  assert.equal(record.expiresAt.getTime(), startMs + 24 * 60 * 60 * 1000);
  assert.equal(JSON.stringify(record).includes(firstToken), false, '台账不含明文令牌');
  clockMs += (5 * 60 + 1) * 1000;
  const conflict = await login(app, 'code-other', 'idem-key-ttl');
  assert.equal(conflict.statusCode, 409, '超过旧5分钟仍保留同键异体冲突');
  assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
  for (const at of [clockMs, startMs + 24 * 60 * 60 * 1000 - 1]) {
    clockMs = at;
    const replay = await login(app, 'code-ttl', 'idem-key-ttl');
    assert.equal(replay.statusCode, 200);
    assert.notEqual(replay.json().data.access_token, firstToken);
    assert.equal(replay.json().data.expires_at, first.json().data.expires_at);
    assert.equal(tracker.sessionCount(), 1, '窗口内不能重新建立会话');
    const retained = await readIdempotencyRecord(idempotency, 'anonymous', 'POST', '/auth/wechat', 'idem-key-ttl');
    assert.equal(retained.outcome.sessionId, record.outcome.sessionId);
    assert.equal(retained.expiresAt.getTime(), record.expiresAt.getTime(), '重放不滑动回执有效期');
    assert.equal(JSON.stringify(retained).includes(replay.json().data.access_token), false);
  }
  // 到期边界按新请求处理；这里的 code 由明确的替身身份提供者重复兑换。
  clockMs = startMs + 24 * 60 * 60 * 1000;
  assert.equal((await login(app, 'code-ttl', 'idem-key-ttl')).statusCode, 200);
  assert.equal(tracker.sessionCount(), 2);
  const renewed = await readIdempotencyRecord(idempotency, 'anonymous', 'POST', '/auth/wechat', 'idem-key-ttl');
  assert.notEqual(renewed.outcome.sessionId, record.outcome.sessionId);
  // 到期条目已在本次请求开始时被实际清理（不是只写 TTL 字段）。
  assert.equal(await idempotency.purgeExpired(new Date(clockMs)), 0, '到期条目应在请求处理时已清理');
});

test('24小时回执不延长后台8小时会话：到期仍401且不建立新会话', async (t) => {
  let clockMs = Date.parse('2026-01-01T00:00:00Z');
  const startMs = clockMs;
  const idempotency = createMemoryIdempotencyStore();
  const tracker = trackingStore();
  const app = newApp({
    store: tracker.store, idempotency, now: () => new Date(clockMs),
    config: stubConfig({ ADMIN_BOOTSTRAP_LOGIN_NAME: 'root', ADMIN_BOOTSTRAP_PASSWORD: 'synthetic-bootstrap-pass' }),
  });
  t.after(() => app.close());
  await app.authService.ensureBootstrapAdmin();
  const request = () => app.inject({ method: 'POST', url: ADMIN_SESSION_URL,
    headers: { 'idempotency-key': 'admin-window-0001' },
    payload: { login_name: 'root', password: 'synthetic-bootstrap-pass' } });
  const first = await request();
  assert.equal(first.statusCode, 200);
  assert.equal(Date.parse(first.json().data.expires_at), startMs + 8 * 60 * 60 * 1000);
  clockMs += (5 * 60 + 1) * 1000;
  const replay = await request();
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().data.expires_at, first.json().data.expires_at);
  assert.equal(tracker.sessionCount(), 1);
  clockMs = startMs + 8 * 60 * 60 * 1000;
  const expired = await request();
  assert.equal(expired.statusCode, 401);
  assert.equal(expired.json().error.code, 'SESSION_EXPIRED');
  assert.equal(tracker.sessionCount(), 1, '仍有效回执不能绕过原会话过期');
  const retained = await readIdempotencyRecord(idempotency, 'anonymous', 'POST', '/admin/auth/session', 'admin-window-0001');
  assert.equal(retained.expiresAt.getTime(), startMs + 24 * 60 * 60 * 1000);
});

test('退出后超过旧5分钟重放登录仍拒绝，不借24小时回执复活会话', async (t) => {
  let clockMs = Date.parse('2026-01-01T00:00:00Z');
  const tracker = trackingStore();
  const app = newApp({ store: tracker.store, now: () => new Date(clockMs) });
  t.after(() => app.close());
  const first = await login(app, 'code-window-revoked', 'idem-window-revoked');
  assert.equal(first.statusCode, 200);
  const logout = await app.inject({ method: 'POST', url: LOGOUT_URL,
    headers: { ...bearer(first.json().data.access_token), 'idempotency-key': 'logout-window-0001' } });
  assert.equal(logout.statusCode, 200);
  clockMs += 6 * 60 * 1000;
  const replay = await login(app, 'code-window-revoked', 'idem-window-revoked');
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error.code, 'SESSION_EXPIRED');
  assert.equal(tracker.sessionCount(), 1);
  assert.equal(tracker.activeCount(), 0);
});

// ---------------------------------------------------------------------------
// P1-②：请求摘要必须带服务端密钥，避免台账成为廉价离线口令验证器
// ---------------------------------------------------------------------------

test('P1-② 幂等 request_hash 为带密钥 HMAC：仅有台账无法离线快速验证后台口令', async () => {
  const signingKey = 'test-signing-key-for-idempotency-hmac';
  const config = stubConfig({
    SESSION_SIGNING_KEY: signingKey,
    ADMIN_BOOTSTRAP_LOGIN_NAME: 'root',
    ADMIN_BOOTSTRAP_PASSWORD: 'bootstrap-pass-123',
  });
  const idempotency = createMemoryIdempotencyStore();
  const store = createMemoryAuthStore();
  const app = newApp({ config, store, idempotency });
  await app.authService.ensureBootstrapAdmin();

  const body = { login_name: 'root', password: 'bootstrap-pass-123' };
  const res = await app.inject({
    method: 'POST',
    url: ADMIN_SESSION_URL,
    headers: { 'idempotency-key': 'admin-hmac-0001' },
    payload: body,
  });
  assert.equal(res.statusCode, 200);

  const record = await readIdempotencyRecord(idempotency, 'anonymous', 'POST', '/admin/auth/session', 'admin-hmac-0001');
  // 旧实现（无密钥 SHA-256）会允许用已知登录名+候选口令直接复算命中。
  const keyless = createHash('sha256').update(JSON.stringify([body, null]), 'utf8').digest('hex');
  assert.notEqual(record.requestHash, keyless, '台账摘要不得等于无密钥 SHA-256（否则可离线快速验证口令）');
  // 只有持服务端密钥（process.env，不入库）才能复算。
  const keyed = createHmac('sha256', signingKey).update(JSON.stringify([body, null]), 'utf8').digest('hex');
  assert.equal(record.requestHash, keyed, '台账摘要应为带服务端密钥的 HMAC');
  await app.close();
});

// ---------------------------------------------------------------------------
// P2-③：重放前必须核对当前身份（账号状态 / epoch / 关联会话 / 凭据）
// ---------------------------------------------------------------------------

test('P2-③ 用户账号 suspended 后同键同体重放登录 → 403 ACCOUNT_INACTIVE（不回放旧令牌）', async () => {
  const base = createMemoryAuthStore();
  const store = {
    ...base,
    async getUser(userId) {
      const user = await base.getUser(userId);
      return user === null ? null : { ...user, state: 'suspended' };
    },
  };
  const app = newApp({ store });
  assert.equal((await login(app, 'code-susp', 'idem-key-susp')).statusCode, 200);
  const replay = await login(app, 'code-susp', 'idem-key-susp');
  assert.equal(replay.statusCode, 403);
  assert.equal(replay.json().error.code, 'ACCOUNT_INACTIVE');
  await app.close();
});

test('P2-③ 用户 auth_epoch 递增后同键同体重放登录 → 403 ACCOUNT_INACTIVE', async () => {
  const store = createMemoryAuthStore();
  const app = newApp({ store });
  assert.equal((await login(app, 'code-epoch', 'idem-key-epoch')).statusCode, 200);
  const user = await subjectOf(store, 'code-epoch');
  await store.bumpUserAuthEpoch(user.id);
  const replay = await login(app, 'code-epoch', 'idem-key-epoch');
  assert.equal(replay.statusCode, 403);
  assert.equal(replay.json().error.code, 'ACCOUNT_INACTIVE');
  await app.close();
});

test('P2-③ 关联会话已撤销（退出）后同键同体重放登录 → 401 SESSION_EXPIRED', async () => {
  const app = newApp();
  const token = (await login(app, 'code-revoked', 'idem-key-revoked')).json().data.access_token;
  const logout = await app.inject({
    method: 'POST',
    url: LOGOUT_URL,
    headers: { ...bearer(token), 'idempotency-key': 'logout-revoked-0001' },
  });
  assert.equal(logout.statusCode, 200);
  const replay = await login(app, 'code-revoked', 'idem-key-revoked');
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error.code, 'SESSION_EXPIRED');
  await app.close();
});

/** 构造一个可切换“变更后”状态的后台存储，用于模拟账号变更/凭据轮换。 */
function mutableAdminStore() {
  const base = createMemoryAuthStore();
  let mutation = {};
  let mutated = false;
  const store = {
    ...base,
    async findAdminByLoginName(loginName) {
      const admin = await base.findAdminByLoginName(loginName);
      if (admin === null || !mutated) return admin;
      return { ...admin, ...mutation };
    },
  };
  return {
    store,
    mutate(next) {
      mutation = next;
      mutated = true;
    },
  };
}

async function adminLogin(app, key, password = 'bootstrap-pass-123') {
  return app.inject({
    method: 'POST',
    url: ADMIN_SESSION_URL,
    headers: { 'idempotency-key': key },
    payload: { login_name: 'root', password },
  });
}

async function bootstrapAdminApp() {
  const { store, mutate } = mutableAdminStore();
  const config = stubConfig({ ADMIN_BOOTSTRAP_LOGIN_NAME: 'root', ADMIN_BOOTSTRAP_PASSWORD: 'bootstrap-pass-123' });
  const app = newApp({ config, store });
  await app.authService.ensureBootstrapAdmin();
  return { app, store, mutate };
}

test('P2-③ 后台账号 suspended 后同键同体重放 → 403 ACCOUNT_INACTIVE', async () => {
  const { app, mutate } = await bootstrapAdminApp();
  assert.equal((await adminLogin(app, 'admin-susp-0001')).statusCode, 200);
  mutate({ state: 'suspended' });
  const replay = await adminLogin(app, 'admin-susp-0001');
  assert.equal(replay.statusCode, 403);
  assert.equal(replay.json().error.code, 'ACCOUNT_INACTIVE');
  await app.close();
});

test('P2-③ 后台 auth_epoch 递增后同键同体重放 → 403 ACCOUNT_INACTIVE', async () => {
  const { app, mutate } = await bootstrapAdminApp();
  assert.equal((await adminLogin(app, 'admin-epoch-0001')).statusCode, 200);
  mutate({ authEpoch: 2 });
  const replay = await adminLogin(app, 'admin-epoch-0001');
  assert.equal(replay.statusCode, 403);
  assert.equal(replay.json().error.code, 'ACCOUNT_INACTIVE');
  await app.close();
});

test('P2-③ 后台关联会话撤销后同键同体重放 → 401 SESSION_EXPIRED', async () => {
  const { app } = await bootstrapAdminApp();
  const token = (await adminLogin(app, 'admin-revoke-0001')).json().data.access_token;
  const logout = await app.inject({
    method: 'POST',
    url: ADMIN_LOGOUT_URL,
    headers: { ...bearer(token), 'idempotency-key': 'admin-logout-revoke-0001' },
  });
  assert.equal(logout.statusCode, 200);
  const replay = await adminLogin(app, 'admin-revoke-0001');
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error.code, 'SESSION_EXPIRED');
  await app.close();
});

test('P2-③ 后台凭据轮换后同键同体重放 → 401 SESSION_REQUIRED（重新校验当前凭据）', async () => {
  const { app, mutate } = await bootstrapAdminApp();
  assert.equal((await adminLogin(app, 'admin-rotate-0001')).statusCode, 200);
  mutate({ credentialHash: hashPassword('rotated-pass-9999') });
  const replay = await adminLogin(app, 'admin-rotate-0001');
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().error.code, 'SESSION_REQUIRED');
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
