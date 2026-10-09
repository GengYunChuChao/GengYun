import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const filename = new URL('../../apps/admin/src/auth/session.ts', import.meta.url);
const source = readFileSync(filename, 'utf8');
// Only replace Vite's public build-time URL; execute the actual client in an isolated VM.
const compiled = ts.transpileModule(source.replace('import.meta.env.VITE_API_BASE_URL', "'/api/v1'"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const key = 'gengyun.admin.session';
const credentials = { loginName: 'synthetic-admin', password: 'synthetic-only' };
const expiresAt = '2099-01-01T00:00:00Z';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ data }) });
const loginResponse = (token) => response(200, { access_token: token, expires_at: expiresAt });
const sessionResponse = () => response(200, { expires_at: expiresAt, scopes: ['session:read'] });
const observe = (promise) => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));

function client(token = 'synthetic-A') {
  const storage = new Map(token === null ? [] : [[key, token]]);
  const requests = [];
  const exports = {};
  runInNewContext(compiled, {
    exports, crypto: webcrypto,
    sessionStorage: {
      getItem: name => storage.get(name) ?? null,
      setItem: (name, value) => storage.set(name, value),
      removeItem: name => storage.delete(name),
    },
    fetch: (url, options) => {
      const pending = deferred();
      requests.push({ url, options, ...pending });
      return pending.promise;
    },
  }, { filename: filename.pathname });
  return { api: exports, requests, storage, token: () => storage.get(key) ?? null };
}

function assertSuperseded(result) {
  assert.equal(result.ok, false, 'an obsolete login must not resolve as a current session');
  assert.match(result.error.message, /后台登录请求已失效/);
}

for (const first of ['login', 'logout']) {
  test(`earlier login cannot restore logout intent, ${first} response arrives first`, async () => {
    const c = client();
    const login = observe(c.api.signInAdmin(credentials));
    const logout = c.api.signOutAdmin();
    assert.equal(c.token(), null);
    assert.equal(c.requests[1].options.headers.authorization, 'Bearer synthetic-A');
    if (first === 'logout') { c.requests[1].resolve(response(200, { accepted: true })); await logout; }
    c.requests[0].resolve(loginResponse('synthetic-B'));
    assertSuperseded(await login);
    if (first === 'login') c.requests[1].resolve(response(200, { accepted: true }));
    await logout;
    assert.equal(c.token(), null);
  });
}

test('logout with no cached token also invalidates pending first login', async () => {
  const c = client(null);
  const login = observe(c.api.signInAdmin(credentials));
  await c.api.signOutAdmin();
  assert.equal(c.requests.length, 1, 'no token means no logout network request');
  c.requests[0].resolve(loginResponse('synthetic-B'));
  assertSuperseded(await login);
  assert.equal(c.token(), null);
});

for (const outcome of ['success', '401', 'network']) {
  test(`old GET ${outcome} cannot return session after logout`, async () => {
    const c = client();
    const get = c.api.loadAdminSession();
    const logout = c.api.signOutAdmin();
    c.requests[1].resolve(response(200, { accepted: true }));
    await logout;
    if (outcome === 'network') c.requests[0].reject(new Error('synthetic network failure'));
    else c.requests[0].resolve(outcome === 'success' ? sessionResponse() : response(401, {}));
    assert.equal(await get, null);
    assert.equal(c.token(), null);
  });
}

for (const outcome of ['success', '401', 'malformed', 'network']) {
  test(`old GET ${outcome} cannot clear or return session after new login`, async () => {
    const c = client();
    const oldGet = c.api.loadAdminSession();
    const login = c.api.signInAdmin(credentials);
    c.requests[1].resolve(loginResponse('synthetic-B'));
    assert.equal((await login).accessToken, 'synthetic-B');
    if (outcome === 'network') c.requests[0].reject(new Error('synthetic network failure'));
    else c.requests[0].resolve(outcome === 'success' ? sessionResponse() : response(outcome === '401' ? 401 : 200, {}));
    assert.equal(await oldGet, null);
    assert.equal(c.token(), 'synthetic-B');
  });
}

test('GET invalidated at new login start, even before the login response', async () => {
  const c = client();
  const oldGet = c.api.loadAdminSession();
  const login = c.api.signInAdmin(credentials);
  c.requests[0].resolve(sessionResponse());
  assert.equal(await oldGet, null);
  c.requests[1].resolve(loginResponse('synthetic-B'));
  await login;
  assert.equal(c.token(), 'synthetic-B');
});

for (const status of [200, 401]) {
  test(`GET ${status} is bound to captured token even without a new API intent`, async () => {
    const c = client();
    const get = c.api.loadAdminSession();
    c.storage.set(key, 'synthetic-B');
    c.requests[0].resolve(status === 200 ? sessionResponse() : response(401, {}));
    assert.equal(await get, null);
    assert.equal(c.token(), 'synthetic-B');
  });
}

test('GET checks intent after response body parsing, not just fetch completion', async () => {
  const c = client();
  const body = deferred(), parsing = deferred();
  const get = c.api.loadAdminSession();
  c.requests[0].resolve({ ok: true, status: 200, json: () => { parsing.resolve(); return body.promise; } });
  await parsing.promise;
  const login = c.api.signInAdmin(credentials);
  c.requests[1].resolve(loginResponse('synthetic-B'));
  await login;
  body.resolve({ data: { expires_at: expiresAt, scopes: ['session:read'] } });
  assert.equal(await get, null);
  assert.equal(c.token(), 'synthetic-B');
});

test('login checks intent after response body parsing; logout cannot be revived', async () => {
  const c = client();
  const body = deferred(), parsing = deferred();
  const login = observe(c.api.signInAdmin(credentials));
  c.requests[0].resolve({ ok: true, status: 200, json: () => { parsing.resolve(); return body.promise; } });
  await parsing.promise;
  const logout = c.api.signOutAdmin();
  c.requests[1].resolve(response(200, { accepted: true }));
  await logout;
  body.resolve({ data: { access_token: 'synthetic-B', expires_at: expiresAt } });
  assertSuperseded(await login);
  assert.equal(c.token(), null);
});

for (const oldOutcome of ['success', '401', 'network']) {
  for (const first of ['old', 'new']) {
    test(`newer login wins against old ${oldOutcome}, ${first} response first`, async () => {
      const c = client();
      const old = observe(c.api.signInAdmin(credentials));
      const newer = c.api.signInAdmin(credentials);
      if (first === 'new') { c.requests[1].resolve(loginResponse('synthetic-C')); await newer; }
      if (oldOutcome === 'network') c.requests[0].reject(new Error('synthetic network failure'));
      else c.requests[0].resolve(oldOutcome === 'success' ? loginResponse('synthetic-B') : response(401, {}));
      assertSuperseded(await old);
      if (first === 'old') { c.requests[1].resolve(loginResponse('synthetic-C')); await newer; }
      assert.equal(c.token(), 'synthetic-C');
    });
  }
}

for (const outcome of ['200', '503', 'network']) {
  test(`new login after logout survives the old logout ${outcome}`, async () => {
    const c = client();
    const logout = c.api.signOutAdmin();
    const login = c.api.signInAdmin(credentials);
    c.requests[1].resolve(loginResponse('synthetic-B'));
    await login;
    if (outcome === 'network') c.requests[0].reject(new Error('synthetic network failure'));
    else c.requests[0].resolve(response(Number(outcome), { accepted: outcome === '200' }));
    await logout;
    assert.equal(c.token(), 'synthetic-B');
  });
}

test('current login, session read and server rejection retain ordinary behavior', async () => {
  const c = client(null);
  assert.equal(await c.api.loadAdminSession(), null);
  const login = c.api.signInAdmin(credentials);
  assert.equal(c.requests[0].options.credentials, 'omit');
  assert.match(c.requests[0].options.headers['Idempotency-Key'], /^admin-[0-9a-f]{32}$/);
  c.requests[0].resolve(loginResponse('synthetic-B'));
  assert.equal((await login).accessToken, 'synthetic-B');
  const get = c.api.loadAdminSession();
  c.requests[1].resolve(sessionResponse());
  assert.equal((await get).accessToken, 'synthetic-B');
  const invalid = c.api.loadAdminSession();
  c.requests[2].resolve(response(401, {}));
  assert.equal(await invalid, null);
  assert.equal(c.token(), null);
});

test('current login failures are reported and preserve the previous token', async () => {
  for (const outcome of ['401', 'malformed', 'network']) {
    const c = client();
    const login = observe(c.api.signInAdmin(credentials));
    if (outcome === 'network') c.requests[0].reject(new Error('synthetic network failure'));
    else c.requests[0].resolve(response(outcome === '401' ? 401 : 200, {}));
    const result = await login;
    assert.equal(result.ok, false);
    assert.match(result.error.message, outcome === 'network' ? /synthetic network failure/ : /后台登录失败/);
    assert.equal(c.token(), 'synthetic-A');
  }
});
