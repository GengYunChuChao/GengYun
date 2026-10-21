import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';

// GY-I15（#15）· 消息域客户端链路：真实 `miniprogram/utils/messages-api.js` + 真实 `utils/auth.js`
// + 真实 `utils/states.js`，在合成 wx 下逐条核对**请求头、错误码与 denied 归类**。
// 合成 wx 只记录请求，绝不外发；本文件不是微信工具或真机证据，也不替代服务端集成测试。
const root = resolve(import.meta.dirname, '../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const expires = () => new Date(Date.now() + 3600_000).toISOString();
const MESSAGE = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const OTHER = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b';
const META = { request_id: '99999999-9999-4999-8999-999999999999', contract_version: '1.0.0', execution_mode: 'stub' };
const envelope = (data) => ({ data, meta: META });
const errorEnvelope = (code) => ({ error: { code, message: 'm', retryable: false, details: [] }, meta: META });
const message = (over = {}) => ({
  id: MESSAGE, revision: 1, type: 'moderation', target_ref: { type: 'post', id: 'post-1', revision: 2 },
  reference_state: 'unavailable', read_at: null, created_at: '2026-10-16T04:00:00.000Z', ...over,
});

function harness() {
  const storage = new Map();
  const requests = [];
  const toasts = [];
  const cache = new Map();
  const wx = {
    getStorageSync: (key) => storage.get(key) || '',
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.delete(key),
    login: (options) => options.success({ code: 'synthetic-code' }),
    request: (options) => requests.push(options),
    reLaunch: () => {},
    switchTab: () => {},
    navigateTo: () => {},
    showModal: (options) => options.success({ confirm: true }),
    showToast: (options) => toasts.push(options.title),
  };
  const context = { wx, getApp: () => ({ globalData: {} }) };
  function load(path) {
    path = resolve(path);
    if (path.endsWith('config\\runtime.js') || path.endsWith('config/runtime.js')) {
      return { mode: 'local', apiBaseUrl: 'https://synthetic.invalid/api/v1' };
    }
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} };
    cache.set(path, module);
    const wrapper = runInNewContext('(function(require,module,exports){' + readFileSync(path, 'utf8') + '\n})', context, { filename: path });
    wrapper((relative) => load(resolve(dirname(path), relative + '.js')), module, module.exports);
    return module.exports;
  }
  const auth = load(resolve(root, 'miniprogram/utils/auth.js'));
  const api = load(resolve(root, 'miniprogram/utils/messages-api.js'));
  const states = load(resolve(root, 'miniprogram/utils/states.js'));
  function login() {
    auth.login((error) => assert.equal(error, null));
    requests.at(-1).success({ statusCode: 200, data: envelope({ access_token: 'synthetic-token', audience: 'user', expires_at: expires() }) });
    assert.equal(auth.isLoggedIn(), true);
    requests.length = 0;
  }
  return { auth, api, states, requests, toasts, storage, login };
}
const pathOf = (request) => request.url.replace('https://synthetic.invalid/api/v1', '');

// ---------------------------------------------------------------------------------
// (e) 401 / 403 折叠：#15 与 B7 的交叉缺陷。401 必须清会话；403 **必须不清会话**，
// 并且真实码要经 `utils/states.js` 归到 denied（否则 denied 分支永远不可达）。
// ---------------------------------------------------------------------------------
test('消息域 401 ⇒ 清会话并报 SESSION_REQUIRED（走 guest，不伪装成 denied）', async () => {
  const h = harness();
  h.login();
  const pending = h.api.listMessages({});
  h.requests.at(-1).success({ statusCode: 401, data: errorEnvelope('SESSION_REQUIRED') });
  await assert.rejects(pending, (error) => error.code === 'SESSION_REQUIRED');
  assert.equal(h.auth.isLoggedIn(), false, '401 必须清掉本地会话');
  assert.equal(h.storage.has('gengyun.session'), false);
});

test('消息域 403 ⇒ 不清会话，透出真实 403 码（SCOPE_DENIED / CONSENT_REQUIRED / ACCOUNT_INACTIVE）', async () => {
  for (const code of ['SCOPE_DENIED', 'CONSENT_REQUIRED', 'ACCOUNT_INACTIVE']) {
    const h = harness();
    h.login();
    const pending = h.api.listMessages({});
    h.requests.at(-1).success({ statusCode: 403, data: errorEnvelope(code) });
    await assert.rejects(pending, (error) => error.code === code, `403 ${code} 必须原样透出，不得折叠成 SESSION_REQUIRED`);
    assert.equal(h.auth.isLoggedIn(), true, `403 ${code} 是「登录了但不给」，不得清会话`);
    // B7 归类：403 三码必须落在 denied（不可重试、不催重新登录）。
    const resolved = h.states.resolve(code);
    assert.equal(resolved.status, h.states.STATUS.DENIED, `${code} 必须归到 denied`);
    assert.equal(resolved.retryable, false);
    assert.notEqual(resolved.status, h.states.resolve('SESSION_REQUIRED').status, 'denied 与 guest 必须是两个状态');
    // 文案必须是这一码自己的，不能落到兜底句（否则用户分不清「没权限」和「服务不可用」）。
    assert.doesNotMatch(h.api.message({ code }), /消息服务暂不可用，已清空/, `${code} 不得复用兜底文案`);
  }
});

test('消息域 403 但错误封套不可解析 ⇒ 按 403 语义兜底 SCOPE_DENIED（不退化成谎称未登录）', async () => {
  const h = harness();
  h.login();
  const pending = h.api.listMessages({});
  h.requests.at(-1).success({ statusCode: 403, data: 'gateway-says-no' });
  await assert.rejects(pending, (error) => error.code === 'SCOPE_DENIED');
  assert.equal(h.auth.isLoggedIn(), true);
});

test('消息域 401 与 403 的判定互不污染：401 仍走 guest，403 不再生成 SESSION_REQUIRED', async () => {
  const h = harness();
  h.login();
  const first = h.api.getUnreadCount();
  h.requests.at(-1).success({ statusCode: 403, data: errorEnvelope('SCOPE_DENIED') });
  await assert.rejects(first, (error) => error.code === 'SCOPE_DENIED');
  const second = h.api.getUnreadCount();
  h.requests.at(-1).success({ statusCode: 401, data: errorEnvelope('SESSION_REQUIRED') });
  await assert.rejects(second, (error) => error.code === 'SESSION_REQUIRED');
  assert.equal(h.auth.isLoggedIn(), false, '只有 401 才清会话');
});

// ---------------------------------------------------------------------------------
// (c) 发送 / 写路径：契约没有 create operation，唯一写口是 markMessageRead。
// 幂等键必须「同一 (id, revision) 的重试复用、成功后释放」。
// ---------------------------------------------------------------------------------
test('markMessageRead 头：PUT、If-Match 为当前 revision、带幂等键、无请求体', async () => {
  const h = harness();
  h.login();
  const pending = h.api.markMessageRead(MESSAGE, 3);
  const request = h.requests.at(-1);
  assert.equal(request.method, 'PUT');
  assert.equal(pathOf(request), '/messages/' + MESSAGE + '/read');
  assert.equal(request.header['If-Match'], '"3"');
  assert.ok(request.header['Idempotency-Key'].length >= 8 && request.header['Idempotency-Key'].length <= 128);
  assert.equal(request.data, undefined, '契约该 operation 无请求体');
  request.success({ statusCode: 200, data: envelope(message({ revision: 4, read_at: '2026-10-16T06:00:00.000Z' })) });
  const result = await pending;
  assert.equal(result.message.revision, 4);
  assert.equal(result.message.read_at, '2026-10-16T06:00:00.000Z');
});

test('markMessageRead 失败重试：同一 (id, revision) 复用同一幂等键，成功后才换新键', async () => {
  const h = harness();
  h.login();
  // 第 1 次：响应丢失（网络不确定）——首发可能已在服务端落库。
  const first = h.api.markMessageRead(MESSAGE, 1);
  const key1 = h.requests.at(-1).header['Idempotency-Key'];
  h.requests.at(-1).fail({ errMsg: 'request:fail timeout' });
  await assert.rejects(first, (error) => error.code === 'NETWORK_UNCERTAIN');
  // 第 2 次：同一 (id, revision) 的重试必须复用同一键，否则首发已落库时必然 409。
  const second = h.api.markMessageRead(MESSAGE, 1);
  const key2 = h.requests.at(-1).header['Idempotency-Key'];
  assert.equal(key2, key1, '同一次标记的重试必须复用同一个幂等键');
  h.requests.at(-1).success({ statusCode: 200, data: envelope(message({ revision: 2, read_at: '2026-10-16T05:00:00.000Z' })) });
  await second;
  // 第 3 次：成功后资源版本已推进，这是**另一件事**，必须是新键。
  const third = h.api.markMessageRead(MESSAGE, 2);
  const key3 = h.requests.at(-1).header['Idempotency-Key'];
  assert.notEqual(key3, key2, '成功后必须换新键（否则会把两次不同的标记当成同一次重放）');
  h.requests.at(-1).success({ statusCode: 200, data: envelope(message({ revision: 3, read_at: '2026-10-16T07:00:00.000Z' })) });
  await third;
});

test('markMessageRead 幂等键复用不跨消息、不跨版本（不同 id 或不同 revision 各自独立）', async () => {
  const h = harness();
  h.login();
  const a = h.api.markMessageRead(MESSAGE, 1);
  const requestA = h.requests.at(-1);
  const keyA = requestA.header['Idempotency-Key'];
  const b = h.api.markMessageRead(OTHER, 1);
  const requestB = h.requests.at(-1);
  const keyB = requestB.header['Idempotency-Key'];
  const c = h.api.markMessageRead(MESSAGE, 2);
  const requestC = h.requests.at(-1);
  const keyC = requestC.header['Idempotency-Key'];
  assert.notEqual(keyB, keyA, '不同消息不得共用幂等键');
  assert.notEqual(keyC, keyA, '同一消息的不同 revision 之间不得共用幂等键');
  for (const request of [requestA, requestB, requestC]) {
    request.success({ statusCode: 200, data: envelope(message()) });
  }
  await Promise.all([a, b, c]);
});

test('markMessageRead 拒绝非法入参且不发请求（id 非 uuid / revision 非正整数）', async () => {
  const h = harness();
  h.login();
  await assert.rejects(h.api.markMessageRead('not-a-uuid', 1), (error) => error.code === 'INVALID_INPUT');
  await assert.rejects(h.api.markMessageRead(MESSAGE, 0), (error) => error.code === 'INVALID_INPUT');
  assert.equal(h.requests.length, 0, '非法入参不得产生请求');
});

// ---------------------------------------------------------------------------------
// (b) 分页：游标是「位置」不是「字段身份」；客户端只如实透传，不本地重排、不伪造字段。
// ---------------------------------------------------------------------------------
test('listMessages 只发契约声明的 cursor/limit 两个参数，并原样带回 next_cursor', async () => {
  const h = harness();
  h.login();
  const pending = h.api.listMessages({ cursor: 'signed-cursor', limit: 20 });
  const request = h.requests.at(-1);
  assert.equal(request.method, 'GET');
  assert.equal(pathOf(request), '/messages?cursor=signed-cursor&limit=20');
  assert.equal(request.header.authorization, 'Bearer synthetic-token');
  assert.equal(request.header['Idempotency-Key'], undefined, '读路径不带幂等键');
  request.success({ statusCode: 200, data: envelope({ items: [message()], next_cursor: 'next-signed-cursor' }) });
  const page = await pending;
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, 'next-signed-cursor');
  assert.deepEqual(Object.keys(page.items[0]).sort(),
    ['created_at', 'id', 'read_at', 'reference_state', 'revision', 'target_ref', 'type'], '客户端不添字段（契约 Message 恰 7 项）');
});

test('listMessages 不透出契约之外的字段（含 `read_version` 之类的伪字段）', async () => {
  const h = harness();
  h.login();
  const pending = h.api.listMessages({});
  h.requests.at(-1).success({ statusCode: 200, data: envelope({ items: [message({ read_version: 7 })], next_cursor: null }) });
  await assert.rejects(pending, (error) => error.code === 'INVALID_RESPONSE', '多出的字段必须被拒，而不是"尽力解析"');
});

test('listMessages 游标失效码 INVALID_CURSOR 原样透出，供页面重新载入', async () => {
  const h = harness();
  h.login();
  const pending = h.api.listMessages({ cursor: 'expired' });
  h.requests.at(-1).success({ statusCode: 400, data: errorEnvelope('INVALID_CURSOR') });
  await assert.rejects(pending, (error) => error.code === 'INVALID_CURSOR');
  assert.equal(h.states.resolve('INVALID_CURSOR').retryable, false, '过期游标重试同一条不会成功，必须重载');
});

test('getUnreadCount 只认 {count} 整数且非负（派生量，不做本地计数）', async () => {
  const h = harness();
  h.login();
  const ok = h.api.getUnreadCount();
  h.requests.at(-1).success({ statusCode: 200, data: envelope({ count: 0 }) });
  assert.equal((await ok).count, 0);
  const bad = h.api.getUnreadCount();
  h.requests.at(-1).success({ statusCode: 200, data: envelope({ count: '3' }) });
  await assert.rejects(bad, (error) => error.code === 'INVALID_RESPONSE');
});

// ---------------------------------------------------------------------------------
// (a) 角标文案：0 不显示、>99 折 99+（与页面/角标共用同一函数，避免两处各写一套）。
// ---------------------------------------------------------------------------------
test('unreadText：0 或非法 ⇒ 空串；>99 ⇒ 99+', () => {
  const h = harness();
  assert.equal(h.api.unreadText(0), '');
  assert.equal(h.api.unreadText(-1), '');
  assert.equal(h.api.unreadText('5'), '');
  assert.equal(h.api.unreadText(1), '1');
  assert.equal(h.api.unreadText(99), '99');
  assert.equal(h.api.unreadText(100), '99+');
});
