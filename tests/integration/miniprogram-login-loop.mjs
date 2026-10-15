// Real loopback HTTP + repository client source; synthetic WeChat code/identity and memory DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const requireData = createRequire(import.meta.url);
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
const app = buildApp({ config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }) });
const listen = await app.listen({ host: '127.0.0.1', port: 0 });
const base = listen + '/api/v1';
const storage = new Map(), routes = [], requests = [], pending = new Set();
let pages = [{ route: 'pages/reference/reference', options: {} }];
const source = (path) => readFileSync(new URL('../../miniprogram/' + path, import.meta.url), 'utf8');
let groups = 0;
const pass = (label) => { groups += 1; console.log('PASS synthetic HTTP: ' + label); };
const wx = {
  getStorageSync: (key) => storage.get(key) || '', setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key), login: (opts) => opts.success({ code: 'synthetic-login-loop' }),
  request(opts) {
    requests.push({ method: opts.method, path: new URL(opts.url).pathname });
    const task = fetch(opts.url, { method: opts.method, headers: opts.header,
      ...(opts.data !== undefined ? { body: JSON.stringify(opts.data) } : {}) })
      .then(async (response) => opts.success({ statusCode: response.status, data: await response.json() }))
      .catch(() => opts.fail({})).finally(() => pending.delete(task));
    pending.add(task);
  },
};
for (const method of ['switchTab', 'reLaunch', 'navigateTo']) wx[method] = (opts) => { routes.push({ method, url: opts.url }); opts.success?.({}); };
function load(path, requires) {
  const module = { exports: {} };
  vm.runInNewContext(source(path), { module, wx, getCurrentPages: () => pages, require: (id) => {
    if (!(id in requires)) throw Error('Unexpected dependency ' + id);
    return requires[id];
  } }); return module.exports;
}
const navigation = load('utils/navigation.js', {});
const auth = load('utils/auth.js', { './navigation': navigation, '../config/runtime': { mode: 'local', apiBaseUrl: base } });
async function request(path, opts = {}) { const response = await fetch(base + path, opts); return { status: response.status, body: await response.json() }; }
async function error(path, expectedStatus, expectedCode, opts = {}) {
  const response = await request(path, opts);
  assert.equal(response.status, expectedStatus); assert.equal(response.body.error.code, expectedCode);
}
const GATE_VERIFICATION = { method: 'GET', path: '/api/v1/auth/session' };
// GY-I08 / PR #90（b1f6ab0）：详情页在门禁核实通过后合法地读取一次已确认档案，故紧随门禁之后
// 必须恰好多一条 GET /api/v1/me/profile。断言整段请求序列（条数 + 方法 + 路径 + 先后），
// 因此**任何额外/无关/顺序错误的请求仍会失败**，而不是退化成「至少一次」。
const PROFILE_READ = { method: 'GET', path: '/api/v1/me/profile' };
const expectedRequests = (lifecycles, profileReads) => Array.from({ length: lifecycles }).flatMap(() => profileReads ? [GATE_VERIFICATION, PROFILE_READ] : [GATE_VERIFICATION]);
function assertRequestSequence(observed, expected, label) {
  const shape = (list) => list.map((req) => `${req.method} ${req.path}`);
  assert.deepEqual(shape(observed), shape(expected),
    `${label}: expected request sequence ${JSON.stringify(shape(expected))}, observed ${JSON.stringify(shape(observed))}`);
}
try {
  await error('/auth/session', 401, 'SESSION_REQUIRED');
  await error('/me/consents', 401, 'SESSION_REQUIRED');
  pass('direct API guest rejected');
  await error('/auth/wechat', 400, 'INVALID_REQUEST', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'synthetic-forged-identity' },
    body: JSON.stringify({ code: 'synthetic-forged', openid: 'untrusted', role: 'admin' }) });
  pass('client openid/role rejected');
  let gate; auth.requireLogin((ok) => { gate = ok; });
  assert.equal(gate, false); assert.equal(routes.at(-1).url, navigation.LOGIN);
  assert.equal(navigation.peekReturnTo(), '/pages/reference/reference');
  const navigationId = await new Promise((resolve, reject) => auth.login((error, id) => error ? reject(Error(error)) : resolve(id)));
  assert.equal(auth.isLoggedIn(), true); assert.equal(auth.resumeAfterLogin(navigationId), true);
  assert.deepEqual(routes.at(-1), { method: 'reLaunch', url: '/pages/reference/reference' });
  assert.equal(navigation.peekReturnTo(), null);
  pass('actual client code establishes synthetic server session and returns once');
  const currentToken = auth.getSession().accessToken;
  await new Promise((resolve) => auth.requireLogin((ok) => { assert.equal(ok, true); resolve(); }));
  assert.ok(requests.some((req) => req.method === 'GET' && req.path.endsWith('/auth/session')));
  pass('returned page requires actual GET session verification');
  // Cold module + actual repository pages, not an isolated requireLogin callback.
  // profileReads: 该页在门禁核实后是否合法读取一次档案（仅 referencedetail，自 PR #90 起需要已确认档案上下文）。
  for (const [name, id, resultKey, profileReads] of [
    ['referencedetail', 'gy-i03-hb-001', 'detail', true],
    ['referenceseeddetail', 'gy-i07-seed-hb-001', 'item', false],
    ['reference', null, 'items', false], ['referenceseed', null, 'list', false],
  ]) {
    const cold = load('utils/auth.js', { './navigation': navigation, '../config/runtime': { mode: 'local', apiBaseUrl: base } });
    assert.equal(cold.isLoggedIn(), false);
    const gate = load('utils/page-gate.js', { './auth': cold });
    let definition;
    vm.runInNewContext(source(`pages/${name}/${name}.js`), { Page: (value) => { definition = value; }, wx,
      require: (dep) => {
        if (dep.endsWith('/font-scale')) return load('utils/font-scale.js', {});
        if (dep.endsWith('/auth')) return cold;
        if (dep.endsWith('/page-gate')) return gate;
        if (dep.endsWith('/profile-api')) return load('utils/profile-api.js', { './auth': cold, '../config/runtime': { mode: 'local', apiBaseUrl: base } });
        if (dep.endsWith('/reference')) return requireData('../../miniprogram/utils/reference.js');
        throw Error('Unexpected page dependency');
      } });
    const page = { ...definition, route: `pages/${name}/${name}`, options: id ? { id } : {},
      data: { ...definition.data }, setData(patch) { Object.assign(this.data, patch); } };
    pages = [page]; const before = requests.length;
    page.onLoad(page.options); page.onShow();
    assert.equal(page.data.gatePassed, false);
    while (pending.size) await Promise.all([...pending]);
    assertRequestSequence(requests.slice(before), expectedRequests(1, profileReads), `${name} cold lifecycle`);
    assert.equal(cold.isLoggedIn(), true); assert.equal(page.data.gatePassed, true);
    if (id) { assert.equal(page.data.found, true); assert.ok(page.data[resultKey]); }
    else assert.ok(page.data[resultKey].length > 0);
    page.onHide(); assert.equal(page.data.gatePassed, false); page.onShow();
    while (pending.size) await Promise.all([...pending]);
    assert.equal(page.data.gatePassed, true);
    assertRequestSequence(requests.slice(before), expectedRequests(2, profileReads), `${name} re-entry`);
    pass(`actual ${name} cold lifecycle renders catalog after HTTP verification and re-entry`);
  }
  const headers = { authorization: 'Bearer ' + currentToken };
  await error('/admin/auth/session', 403, 'SCOPE_DENIED', { headers });
  await error('/me/consents?userId=00000000-0000-4000-8000-000000000001', 400, 'INVALID_REQUEST', { headers });
  pass('ordinary user cannot use admin session or override private subject');
  const result = await new Promise((resolve) => auth.logout(resolve));
  assert.equal(result.serverRevoked, true); assert.equal(auth.getSession(), null);
  assert.equal(navigation.peekReturnTo(), null);
  await error('/auth/session', 401, 'SESSION_EXPIRED', { headers });
  pass('logout Ack and immediate server rejection of revoked token');
  // Independent server clock enables deterministic expiry without modifying runtime configuration.
  let clock = new Date('2030-01-01T00:00:00Z');
  const expiring = buildApp({ config: loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), now: () => clock });
  try {
    const address = await expiring.listen({ host: '127.0.0.1', port: 0 });
    const issued = await fetch(address + '/api/v1/auth/wechat', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'synthetic-expiry' }, body: JSON.stringify({ code: 'synthetic-expiry' }) });
    assert.equal(issued.status, 200); const body = await issued.json();
    clock = new Date(Date.parse(body.data.expires_at) + 1);
    const response = await fetch(address + '/api/v1/auth/session', { headers: { authorization: 'Bearer ' + body.data.access_token } });
    assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'SESSION_EXPIRED');
    pass('server absolute expiry rejects independently of cached login display');
  } finally { await expiring.close(); }
  console.log(`PASS ${groups} groups; source_kind=synthetic; memory store; not WeChat/device/native PG evidence`);
} finally { await Promise.allSettled([...pending]); await app.close(); }
