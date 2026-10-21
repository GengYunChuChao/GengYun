/**
 * GY-I04 登录链路盘点 · 401/403 归因与「误清会话」回归（Node + 模拟 wx）。
 *
 * 为什么需要（issue #4「用户登录 / 注册链路」现状盘点的可本地闭环缺口）：
 * 改前 7 个适配层（favorites / history / knowledge / voice / profile / messages / community）
 * 都用同一句把 **401 与 403 折叠**成「登录状态已失效」并**顺手清掉本地会话**：
 *
 *     if (r.statusCode === 401 || r.statusCode === 403) { auth.clearSession(); reject(failure('SESSION_REQUIRED')) }
 *
 * 后果有两层：
 *   1) 语义错：403 `CONSENT_REQUIRED`（缺用途授权）/ `SCOPE_DENIED`（权限范围不足）/
 *      `ACCOUNT_INACTIVE`（账号不可用）不是「没登录」，说成登录失效会把用户指向错误动作；
 *   2) 状态错：清会话会把**仍然有效**的令牌销毁，用户被踢回登录页反复重登，越重登越不明白；
 *      同时也让 B7 统一状态层（`utils/states.js` 的 `CODE_KIND`，403→`denied`）永远收不到真实的 403 码。
 *
 * 本文件用**仓库里的真代码**（`utils/auth.js` 的归因 + 各适配层的真实 `wx.request` 回调）逐条核对：
 *   - 归因表：401 会话类 vs 403 授权类的码与「是否清会话」两个维度**分开**判定；
 *   - 同源：会话失效闭集直接取自 `states.CODE_KIND`（kind==='session'），不另立第二份码表；
 *   - 适配层：403 授权类错误码原样带出且**不清会话**；`ACCOUNT_INACTIVE` 清会话但**码不谎称登录过期**；
 *     401 仍按会话失效处理（守卫不放宽）；
 *   - 会话核实：`GET /auth/session` 的 401/403 才作废本地会话，5xx（能力未装配的 503）**不**作废。
 *
 * 边界：替身 `wx` 是**合成的**。本文件不证明真机、微信开发者工具编译、真实服务端响应，
 * 只证明「同一份真代码在给定响应下的判定」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '../..');
const requireHere = createRequire(import.meta.url);
// 纯归因与 B7 码表：两者都是**不碰存储、不发请求**的纯模块，可直接在 Node 里载入。
const auth = requireHere('../../miniprogram/utils/auth.js');
const states = requireHere('../../miniprogram/utils/states.js');

const SESSION_KEY = 'gengyun.session';
const JOB_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const POST_ID = '11111111-1111-4111-8111-111111111111';
const future = () => new Date(Date.now() + 3600_000).toISOString();

function envelope(code, retryable) {
  return {
    error: { code: code, message: 'm', retryable: retryable === true, details: [] },
    meta: { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' },
  };
}

// ---------------------------------------------------------------------------
// 1 归因表（纯函数）
// ---------------------------------------------------------------------------

test('归因表：401 恒为会话失效；403 按契约码原样带出，只有 ACCOUNT_INACTIVE 清会话', () => {
  const rows = [
    // 状态, 封套码, 期望 surface, 期望 sessionLost, 期望 clearsSession
    [401, 'SESSION_REQUIRED', 'SESSION_REQUIRED', true, true],
    [401, 'SESSION_EXPIRED', 'SESSION_EXPIRED', true, true],
    [401, 'SOMETHING_ELSE', 'SESSION_REQUIRED', true, true], // 401 只可能是会话类：保守回落，不放宽
    [401, null, 'SESSION_REQUIRED', true, true],
    [403, 'SCOPE_DENIED', 'SCOPE_DENIED', false, false],
    [403, 'CONSENT_REQUIRED', 'CONSENT_REQUIRED', false, false],
    [403, 'ACCOUNT_INACTIVE', 'ACCOUNT_INACTIVE', false, true], // 码如实保留，但令牌永久不可用
    [403, null, 'SCOPE_DENIED', false, false], // 读不到原因也不假装是登录问题
    [403, 'NOT_A_CONTRACT_403_CODE', 'SCOPE_DENIED', false, false], // 闭集外的码：状态码已说清是拒绝
    [403, 'SESSION_EXPIRED', 'SESSION_EXPIRED', true, true], // 越界实现：仍按会话失效，不放宽
  ];
  for (const [status, code, surface, sessionLost, clearsSession] of rows) {
    const payload = code === null ? {} : envelope(code, false);
    const a = auth.attribution(status, payload);
    assert.equal(a.code, surface, `${status} ${code} ⇒ code`);
    assert.equal(a.status, status, `${status} ${code} ⇒ status`);
    assert.equal(a.sessionLost, sessionLost, `${status} ${code} ⇒ sessionLost`);
    assert.equal(a.clearsSession, clearsSession, `${status} ${code} ⇒ clearsSession`);
  }
  // retryable 只透传契约封套的取值，不自行发明
  assert.equal(auth.attribution(403, envelope('CONSENT_REQUIRED', true)).retryable, true);
  assert.equal(auth.attribution(403, envelope('CONSENT_REQUIRED', false)).retryable, false);
  // 归因是纯函数：不读写存储、不发请求
  assert.equal(typeof globalThis.wx, 'undefined', '归因不得触碰 wx');
});

test('同源：会话失效闭集直接取自 B7 统一状态层（states.CODE_KIND），不另立第二份码表', () => {
  const fromStates = Object.keys(states.CODE_KIND)
    .filter((code) => states.CODE_KIND[code] === 'session')
    .sort();
  assert.deepEqual(auth.SESSION_LOSS_CODES.slice().sort(), fromStates,
    'auth.SESSION_LOSS_CODES 必须与 states.CODE_KIND 的 session 类逐项一致');
  // 契约 403 闭集同样取自 B7（kind === 'denied'），且与 kind === 'session' 不相交
  const deniedInStates = Object.keys(states.CODE_KIND)
    .filter((code) => states.CODE_KIND[code] === 'denied')
    .sort();
  assert.deepEqual(auth.FORBIDDEN_CODES.slice().sort(), deniedInStates,
    'auth.FORBIDDEN_CODES 必须与 states.CODE_KIND 的 denied 类逐项一致');
  assert.equal(auth.FORBIDDEN_CODES.filter((code) => auth.isSessionLossCode(code)).length, 0,
    '会话失效码与 403 授权码不得重叠');

  // 三个 403 码都属 B7 的 denied（「登录了但不给你」），与 guest（没登录）分开
  for (const code of ['SCOPE_DENIED', 'CONSENT_REQUIRED', 'ACCOUNT_INACTIVE']) {
    assert.equal(states.CODE_KIND[code], 'denied', `${code} 在 B7 里必须是 denied`);
    assert.equal(states.statusForCode(code), 'denied', `${code} 的组件状态必须是 denied`);
    assert.equal(auth.isSessionLossCode(code), false, `${code} 不是会话失效`);
  }
  // ACCOUNT_INACTIVE 的两个维度显式不同：呈现按 denied，但令牌必须清掉
  assert.equal(auth.attribution(403, envelope('ACCOUNT_INACTIVE')).sessionLost, false);
  assert.equal(auth.attribution(403, envelope('ACCOUNT_INACTIVE')).clearsSession, true);
});

// ---------------------------------------------------------------------------
// 2 真实适配层：403 不再被折叠、不再销毁有效会话
// ---------------------------------------------------------------------------

/** 载入**真代码**：真实 auth.js（含归因）+ 真实适配层，wx 用受控替身，runtime 注入 mode/local。 */
function fixture() {
  const requests = [];
  const storage = new Map();
  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    request: (options) => requests.push(options),
    reLaunch: () => {},
    switchTab: () => {},
    navigateTo: () => {},
    redirectTo: () => {},
    navigateBack: () => {},
    showModal: () => {},
    showToast: () => {},
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
  };
  const runtime = { mode: 'local', apiBaseUrl: 'http://127.0.0.1:4321/api/v1' };
  const cache = new Map();
  function load(path) {
    path = resolve(path);
    if (path.endsWith('runtime.js')) return runtime;
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    vm.runInNewContext(
      '(function(require,module){' + readFileSync(path, 'utf8') + '\n})',
      { wx, getCurrentPages: () => [], Page: () => {}, App: () => {} },
    )((id) => load(resolve(dirname(path), id + '.js')), module);
    return module.exports;
  }
  const loadedAuth = load(resolve(root, 'miniprogram/utils/auth.js'));
  const modules = {
    favorites: load(resolve(root, 'miniprogram/utils/favorites-api.js')),
    history: load(resolve(root, 'miniprogram/utils/history-api.js')),
    knowledge: load(resolve(root, 'miniprogram/utils/knowledge-api.js')),
    voice: load(resolve(root, 'miniprogram/utils/voice-api.js')),
    speech: load(resolve(root, 'miniprogram/utils/speech-transcript.js')),
    profile: load(resolve(root, 'miniprogram/utils/profile-api.js')),
    messages: load(resolve(root, 'miniprogram/utils/messages-api.js')),
    community: load(resolve(root, 'miniprogram/utils/community-api.js')),
    identify: load(resolve(root, 'miniprogram/utils/identify-api.js')),
  };
  return { requests, storage, auth: loadedAuth, modules };
}

/** 让会话**真的**通过服务端核实（否则各适配层的 binding() 为 null，一条请求都不会发）。 */
function login(f) {
  f.auth.setSession({ accessToken: 'synthetic-i04-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
  let verified = null;
  f.auth.requireLogin((ok) => { verified = ok; });
  const request = f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1);
  assert.ok(request, 'requireLogin 必须发起 GET /auth/session');
  request.success({ statusCode: 200, data: { data: { audience: 'user', expires_at: future() }, meta: {} } });
  assert.equal(verified, true, '200 + 契约 SessionInfo ⇒ 门禁放行');
  assert.equal(f.auth.isLoggedIn(), true);
  f.requests.length = 0;
}

async function rejects(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('本用例期望服务端错误，实际成功了');
}

/** 九个消费面的**最简单一次真实调用**（覆盖全部改过的适配层）。 */
const CALLS = [
  ['favorites-api', (m) => m.favorites.listFavorites('', 20)],
  ['history-api', (m) => m.history.listHistory('', 20)],
  ['knowledge-api', (m) => m.knowledge.listHerbicides({})],
  ['voice-api', (m) => m.voice.getJob(JOB_ID)],
  ['speech-transcript', (m) => m.speech.getTranscription(JOB_ID)],
  ['profile-api', (m) => m.profile.read()],
  ['messages-api', (m) => m.messages.getUnreadCount()],
  ['community-api', (m) => m.community.getPost(POST_ID)],
  ['identify-api', (m) => m.identify.serverMode()],
];

for (const [name, call] of CALLS) {
  test(`${name}：403 CONSENT_REQUIRED 原样带出且不清会话；403 ACCOUNT_INACTIVE 清会话但码不变；401 仍会话失效`, async () => {
    // ① 403 缺用途授权：用户只是没授权，会话仍然有效
    const consent = fixture();
    login(consent);
    const consentPromise = call(consent.modules);
    consent.requests.at(-1).success({ statusCode: 403, data: envelope('CONSENT_REQUIRED') });
    const consentError = await rejects(consentPromise);
    assert.equal(consentError.code, 'CONSENT_REQUIRED', '403 授权类必须按契约码如实带出（不得折叠成登录失效）');
    assert.equal(consentError.status, 403);
    assert.equal(consent.auth.isLoggedIn(), true, '403 CONSENT_REQUIRED 不得误清会话');
    assert.equal(consent.storage.has(SESSION_KEY), true, '本地会话必须还在');

    // ② 403 账号不可用：令牌永久不可用 ⇒ 清会话，但错误码不谎称「登录过期」
    const inactive = fixture();
    login(inactive);
    const inactivePromise = call(inactive.modules);
    inactive.requests.at(-1).success({ statusCode: 403, data: envelope('ACCOUNT_INACTIVE') });
    const inactiveError = await rejects(inactivePromise);
    assert.equal(inactiveError.code, 'ACCOUNT_INACTIVE', '账号不可用不得说成「登录已过期」');
    assert.equal(inactive.auth.isLoggedIn(), false, 'ACCOUNT_INACTIVE 之后不得再声称已登录');
    assert.equal(inactive.storage.has(SESSION_KEY), false, '令牌已永久失效，本地会话必须清掉');

    // ③ 401 仍按会话失效处理（守卫不放宽）：清会话 + SESSION_* 码
    const expired = fixture();
    login(expired);
    const expiredPromise = call(expired.modules);
    expired.requests.at(-1).success({ statusCode: 401, data: envelope('SESSION_EXPIRED') });
    const expiredError = await rejects(expiredPromise);
    assert.equal(expiredError.code, 'SESSION_EXPIRED', '401 的封套码原样保留');
    assert.equal(expired.auth.isLoggedIn(), false);
    assert.equal(expired.storage.has(SESSION_KEY), false, '401 必须清会话');

    // ④ 403 但封套读不到原因：不假装是登录问题
    const bare = fixture();
    login(bare);
    const barePromise = call(bare.modules);
    bare.requests.at(-1).success({ statusCode: 403, data: {} });
    const bareError = await rejects(barePromise);
    assert.equal(bareError.code, 'SCOPE_DENIED', '无封套的 403 归为「无权」，不归为「未登录」');
    assert.equal(bare.auth.isLoggedIn(), true);
  });
}

// ---------------------------------------------------------------------------
// 3 会话核实：只有 401/403 才作废本地会话
// ---------------------------------------------------------------------------

test('GET /auth/session 的 503 不作废本地会话（一次瞬时故障不该毁掉有效登录），但门禁仍关闭', () => {
  const f = fixture();
  f.auth.setSession({ accessToken: 'synthetic-i04-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
  let verified = null;
  f.auth.requireLogin((ok) => { verified = ok; });
  const request = f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1);
  request.success({ statusCode: 503, data: envelope('PROVIDER_UNAVAILABLE') });
  assert.equal(verified, false, '核实没做成 ⇒ 门禁保持关闭，不谎称已登录');
  assert.equal(f.auth.isLoggedIn(), false);
  assert.equal(f.storage.has(SESSION_KEY), true, '503 是服务端能力未装配，不是会话失效：不得清会话');
});

test('GET /auth/session 的 401 与 403 都作废本地会话（这两类才是「这份令牌不能再用」）', () => {
  for (const status of [401, 403]) {
    const f = fixture();
    f.auth.setSession({ accessToken: 'synthetic-i04-token', audience: 'user', expiresAt: future(), executionMode: 'stub' });
    let verified = null;
    f.auth.requireLogin((ok) => { verified = ok; });
    const request = f.requests.filter((r) => r.url.endsWith('/auth/session')).at(-1);
    request.success({ statusCode: status, data: status === 401 ? envelope('SESSION_EXPIRED') : envelope('ACCOUNT_INACTIVE') });
    assert.equal(verified, false, `${status} ⇒ 门禁关闭`);
    assert.equal(f.storage.has(SESSION_KEY), false, `${status} ⇒ 清理本地会话`);
  }
});
