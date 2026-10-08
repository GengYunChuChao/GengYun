import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * miniprogram/utils/auth.js 的**运行期**回归（Node + 模拟 wx），覆盖：
 * - P2-④ 伪造缓存不构成认证；会话状态须经 GET /auth/session 核实；
 * - P2-⑤ 退出仅在契约成功 Ack 时报「服务端已撤销」，否则保留「撤销未确认」。
 *
 * 注意：这是 Node 侧对纯 JS 逻辑的验证，**不是**微信编译器或真机/开发者工具验证。
 * 共享源码 runtime.mode='disabled'，故这里在临时目录生成一份 mode:'local' 的副本加载，
 * 不修改受版本管理的源码。
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const AUTH_SOURCE = readFileSync(resolve(root, 'miniprogram/utils/auth.js'), 'utf8');

const workDir = mkdtempSync(join(tmpdir(), 'gy-auth-runtime-'));
mkdirSync(join(workDir, 'config'), { recursive: true });
mkdirSync(join(workDir, 'utils'), { recursive: true });
writeFileSync(join(workDir, 'config/runtime.js'), "module.exports = { mode: 'local', apiBaseUrl: 'http://127.0.0.1:3000' }\n");
writeFileSync(join(workDir, 'utils/auth.js'), AUTH_SOURCE);
const requireHere = createRequire(join(workDir, 'utils', 'auth.js'));
const AUTH_PATH = join(workDir, 'utils', 'auth.js');

after(() => rmSync(workDir, { recursive: true, force: true }));

const futureIso = () => new Date(Date.now() + 3600_000).toISOString();

function validCache(overrides = {}) {
  return { accessToken: 'tok-shaped', audience: 'user', expiresAt: futureIso(), executionMode: 'stub', ...overrides };
}

function makeWx() {
  const storage = new Map();
  const requests = [];
  const relaunches = [];
  const wx = {
    getStorageSync: (key) => (storage.has(key) ? storage.get(key) : ''),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    login: (opts) => opts.success({ code: 'code-runtime-test' }),
    request: (opts) => requests.push(opts),
    reLaunch: (opts) => relaunches.push(opts.url),
  };
  return { wx, storage, requests, relaunches };
}

/** 每次重新加载 auth.js，重置其模块级的「已核实」状态。 */
function loadAuth(wx) {
  globalThis.wx = wx;
  delete requireHere.cache[requireHere.resolve(AUTH_PATH)];
  return requireHere(AUTH_PATH);
}

const SESSION_KEY = 'gengyun.session';

// ---------------------------------------------------------------------------
// P2-④
// ---------------------------------------------------------------------------

test('P2-④ 伪造缓存（__devPreview / admin 受众 / 过期）不构成已登录，门禁拒绝并回登录', () => {
  const b = makeWx();
  b.storage.set(SESSION_KEY, { accessToken: '__devPreview', audience: 'admin', expiresAt: '2000-01-01T00:00:00Z' });
  const auth = loadAuth(b.wx);
  assert.equal(auth.getSession(), null, '形状/受众/时效不合格的缓存应被拒绝');
  assert.equal(auth.isLoggedIn(), false);
  let gate;
  auth.requireLogin((ok) => { gate = ok; });
  assert.equal(gate, false);
  assert.deepEqual(b.relaunches, ['/pages/login/login']);
  assert.equal(b.requests.length, 0, '缓存不合格时不应发起核实请求');
});

test('P2-④ 单有形状合格的本地缓存不等于认证（未经服务端核实）', () => {
  const b = makeWx();
  b.storage.set(SESSION_KEY, validCache());
  const auth = loadAuth(b.wx);
  assert.ok(auth.getSession() !== null, '形状合格应可读取');
  assert.equal(auth.isLoggedIn(), false, '读取缓存对象不构成认证');
  assert.equal(b.requests.length, 0);
});

test('P2-④ 未知演示标记的缓存被拒绝', () => {
  const b = makeWx();
  b.storage.set(SESSION_KEY, validCache({ executionMode: 'forged-mode' }));
  const auth = loadAuth(b.wx);
  assert.equal(auth.getSession(), null);
});

test('P2-④ 过期时间已过的缓存被拒绝', () => {
  const b = makeWx();
  b.storage.set(SESSION_KEY, validCache({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const auth = loadAuth(b.wx);
  assert.equal(auth.getSession(), null);
});

test('P2-④ GET /auth/session 核实成功后才视为已登录，门禁放行', () => {
  const b = makeWx();
  b.storage.set(SESSION_KEY, validCache());
  const auth = loadAuth(b.wx);
  let verified;
  auth.verifySession((ok) => { verified = ok; });
  assert.equal(b.requests.length, 1);
  assert.match(b.requests[0].url, /\/auth\/session$/);
  assert.equal(b.requests[0].header.authorization, 'Bearer tok-shaped');
  b.requests[0].success({ statusCode: 200, data: { data: { audience: 'user', expires_at: futureIso(), scopes: ['user'], revision: 1 } } });
  assert.equal(verified, true);
  assert.equal(auth.isLoggedIn(), true);

  let gate;
  auth.requireLogin((ok) => { gate = ok; });
  b.requests[b.requests.length - 1].success({ statusCode: 200, data: { data: { audience: 'user', expires_at: futureIso(), scopes: ['user'], revision: 1 } } });
  assert.equal(gate, true);
  assert.equal(b.relaunches.length, 0);
});

test('P2-④ 服务端返回 401 时清理本地会话并拒绝门禁', () => {
  const b = makeWx();
  b.storage.set(SESSION_KEY, validCache());
  const auth = loadAuth(b.wx);
  let verified;
  auth.verifySession((ok) => { verified = ok; });
  b.requests[0].success({ statusCode: 401, data: { error: { code: 'SESSION_EXPIRED' } } });
  assert.equal(verified, false);
  assert.equal(auth.getSession(), null);
  assert.equal(b.storage.has(SESSION_KEY), false, '失效会话应被清理');

  let gate;
  b.storage.set(SESSION_KEY, validCache());
  auth.requireLogin((ok) => { gate = ok; });
  b.requests[b.requests.length - 1].success({ statusCode: 403, data: { error: { code: 'ACCOUNT_INACTIVE' } } });
  assert.equal(gate, false);
  assert.equal(b.storage.has(SESSION_KEY), false);
  assert.ok(b.relaunches.length >= 1, '应回登录页');
});

test('P2-④ 网络失败不谎称已登录（门禁保持关闭）', () => {
  const b = makeWx();
  b.storage.set(SESSION_KEY, validCache());
  const auth = loadAuth(b.wx);
  let verified;
  auth.verifySession((ok) => { verified = ok; });
  b.requests[0].fail({ errMsg: 'request:fail timeout' });
  assert.equal(verified, false);
  assert.equal(auth.isLoggedIn(), false);
});

test('登录成功：保存服务端返回的演示标记并标记为已核实', () => {
  const b = makeWx();
  const auth = loadAuth(b.wx);
  let error = 'pending';
  auth.login((e) => { error = e; });
  assert.equal(b.requests.length, 1);
  assert.match(b.requests[0].url, /\/auth\/wechat$/);
  b.requests[0].success({
    statusCode: 200,
    data: {
      data: { access_token: 'tok-issued', audience: 'user', expires_at: futureIso(), revision: 1 },
      meta: { execution_mode: 'stub' },
    },
  });
  assert.equal(error, null);
  assert.equal(auth.getSession().executionMode, 'stub');
  assert.equal(auth.isLoggedIn(), true);
});

test('登录响应缺少可解释的执行模式 → 不落盘、不视为已登录', () => {
  const b = makeWx();
  const auth = loadAuth(b.wx);
  let error = null;
  auth.login((e) => { error = e; });
  b.requests[0].success({
    statusCode: 200,
    data: { data: { access_token: 'tok-issued', audience: 'user', expires_at: futureIso(), revision: 1 }, meta: {} },
  });
  assert.ok(typeof error === 'string' && error !== '');
  assert.equal(auth.isLoggedIn(), false);
  assert.equal(b.storage.has(SESSION_KEY), false);
});

// ---------------------------------------------------------------------------
// P2-⑤
// ---------------------------------------------------------------------------

test('P2-⑤ 退出：503 不报「服务端已撤销」，清本地但保留「撤销未确认」', () => {
  const b = makeWx();
  b.storage.set(SESSION_KEY, validCache());
  const auth = loadAuth(b.wx);
  let result;
  auth.logout((r) => { result = r; });
  assert.equal(b.requests.length, 1);
  assert.match(b.requests[0].url, /\/auth\/logout$/);
  b.requests[0].success({ statusCode: 503, data: { error: { code: 'PROVIDER_UNAVAILABLE' } } });
  assert.equal(result.serverRevoked, false, '503 不得报告已撤销');
  assert.equal(result.serverRevocationUnconfirmed, true, '应保留撤销未确认状态');
  assert.equal(b.storage.has(SESSION_KEY), false, '本地会话已清');
});

test('P2-⑤ 退出：契约成功 Ack（200 + accepted）才报「服务端已撤销」', () => {
  const b = makeWx();
  b.storage.set(SESSION_KEY, validCache());
  const auth = loadAuth(b.wx);
  let result;
  auth.logout((r) => { result = r; });
  b.requests[0].success({ statusCode: 200, data: { data: { accepted: true } } });
  assert.equal(result.serverRevoked, true);
  assert.equal(result.serverRevocationUnconfirmed, false);
  assert.equal(b.storage.has(SESSION_KEY), false);
});

test('P2-⑤ 退出：200 但非契约 Ack（accepted 缺失/false）不报已撤销', () => {
  const b = makeWx();
  const auth = loadAuth(b.wx);
  for (const body of [{ data: {} }, { data: { accepted: false } }, {}]) {
    b.storage.set(SESSION_KEY, validCache());
    let result;
    auth.logout((r) => { result = r; });
    b.requests[b.requests.length - 1].success({ statusCode: 200, data: body });
    assert.equal(result.serverRevoked, false, `非 Ack 不得报告已撤销：${JSON.stringify(body)}`);
    assert.equal(result.serverRevocationUnconfirmed, true);
  }
});

test('P2-⑤ 退出：网络失败清本地并保留「撤销未确认」', () => {
  const b = makeWx();
  b.storage.set(SESSION_KEY, validCache());
  const auth = loadAuth(b.wx);
  let result;
  auth.logout((r) => { result = r; });
  b.requests[0].fail({ errMsg: 'request:fail' });
  assert.equal(result.serverRevoked, false);
  assert.equal(result.serverRevocationUnconfirmed, true);
  assert.equal(b.storage.has(SESSION_KEY), false);
});

test('P2-⑤ 退出：无本地会话且未联网时不谎称已撤销（unconfirmed=false）', () => {
  const b = makeWx();
  const auth = loadAuth(b.wx);
  let result;
  auth.logout((r) => { result = r; });
  assert.equal(b.requests.length, 0);
  assert.equal(result.serverRevoked, false);
  assert.equal(result.serverRevocationUnconfirmed, false);
});

// ---------------------------------------------------------------------------
// 阻塞 2 / R2-3、R2-4：以会话世代 + 当前令牌绑定请求，使在途回调失效
// ---------------------------------------------------------------------------

test('R2-3 退出后释放迟到的 verifySession 成功响应不得复活会话，旧门禁回调不被放行', () => {
  const b = makeWx();
  b.storage.set(SESSION_KEY, validCache());
  const auth = loadAuth(b.wx);

  // 在途门禁核实：requireLogin 内部发起 GET /auth/session，先暂停其成功响应。
  let gate = 'pending';
  auth.requireLogin((ok) => { gate = ok; });
  assert.equal(b.requests.length, 1, '应在途发起核实请求');
  const paused = b.requests[0];
  assert.match(paused.url, /\/auth\/session$/);

  // 期间退出：logout 收到契约成功 Ack（200 + accepted）→ 清缓存、报已撤销。
  let logoutResult;
  auth.logout((r) => { logoutResult = r; });
  assert.equal(b.requests.length, 2);
  b.requests[1].success({ statusCode: 200, data: { data: { accepted: true } } });
  assert.equal(logoutResult.serverRevoked, true);
  assert.equal(b.storage.has(SESSION_KEY), false, '退出应清本地会话');

  // 释放此前暂停的旧 GET200：不得复活会话、不得放行旧门禁回调。
  paused.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: futureIso(), scopes: ['user'], revision: 1 } } });
  assert.equal(auth.isLoggedIn(), false, '迟到成功不得复活已清除的会话');
  assert.equal(auth.getSession(), null);
  assert.equal(gate, false, '旧门禁回调不得被放行');
});

test('R2-4 期间完成新登录后，迟到的 verifySession 失败响应（401/网络失败）不得清掉新登录', () => {
  const b = makeWx();
  b.storage.set(SESSION_KEY, validCache({ accessToken: 'tok-old' }));
  const auth = loadAuth(b.wx);

  // 在途核实旧令牌：先暂停其响应。
  let verified = 'pending';
  auth.verifySession((ok) => { verified = ok; });
  assert.equal(b.requests.length, 1);
  const paused = b.requests[0];
  assert.equal(paused.header.authorization, 'Bearer tok-old');

  // 期间完成新登录（令牌变化 → 世代递增）。
  let loginErr = 'pending';
  auth.login((e) => { loginErr = e; });
  assert.equal(b.requests.length, 2);
  b.requests[1].success({
    statusCode: 200,
    data: { data: { access_token: 'tok-new', audience: 'user', expires_at: futureIso(), revision: 1 }, meta: { execution_mode: 'stub' } },
  });
  assert.equal(loginErr, null);
  assert.equal(auth.isLoggedIn(), true, '新登录应生效');
  assert.equal(auth.getSession().accessToken, 'tok-new');

  // 释放旧 verifySession 的失败响应（401）：不得清掉新登录。
  paused.success({ statusCode: 401, data: { error: { code: 'SESSION_EXPIRED' } } });
  assert.equal(verified, false, '旧回调应如实返回未通过');
  assert.equal(auth.isLoggedIn(), true, '迟到失败不得清掉新登录');
  assert.equal(auth.getSession().accessToken, 'tok-new', '新登录令牌应保留');

  // 另一路径：迟到的**网络失败**同样不得清掉更新的登录。
  let verified2 = 'pending';
  auth.verifySession((ok) => { verified2 = ok; });
  const paused2 = b.requests[b.requests.length - 1];
  assert.equal(paused2.header.authorization, 'Bearer tok-new');

  let loginErr2 = 'pending';
  auth.login((e) => { loginErr2 = e; });
  b.requests[b.requests.length - 1].success({
    statusCode: 200,
    data: { data: { access_token: 'tok-newer', audience: 'user', expires_at: futureIso(), revision: 1 }, meta: { execution_mode: 'stub' } },
  });
  assert.equal(loginErr2, null);
  paused2.fail({ errMsg: 'request:fail' });
  assert.equal(verified2, false, '旧网络失败回调应如实返回未通过');
  assert.equal(auth.isLoggedIn(), true, '迟到网络失败不得清掉更新的登录');
  assert.equal(auth.getSession().accessToken, 'tok-newer');
});
