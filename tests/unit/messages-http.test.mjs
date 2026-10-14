// Actual loopback HTTP, synthetic accounts/messages only; no PG or real events/providers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createMemoryAuthStore } from '../../services/api/src/auth/store.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { idempotencyScope, idempotencyKeyHashHex } from '../../services/api/src/auth/idempotency.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createWiredReferencePort } from '../../services/api/src/messages/reference.ts';

const start = Date.UTC(2026, 9, 14, 6);
const unread = '/api/v1/messages/unread-count';
const read = id => `/api/v1/messages/${id}/read`;
const absent = '00000000-0000-4000-8000-000000000000';
const write = (key = 'messages-write-001', version = '"1"') => ({ 'idempotency-key': key, 'if-match': version });

async function fixture(t, { real = false, reference } = {}) {
  let time = start;
  const auth = createMemoryAuthStore();
  const messages = createMemoryMessagesStore({ now: () => time });
  const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }),
    ...(real ? { executionMode: 'real', requiresRealCredentials: true } : {}) };
  const app = buildApp({ config, store: auth, now: () => new Date(time), messagesInjection: { store: messages, reference } });
  async function account(subject) {
    const user = await auth.createUser(subject.repeat(64));
    const token = `synthetic-message-token-${subject}`;
    const session = await auth.createSession({ userId: user.id, tokenHashHex: hashToken(token), authEpoch: user.authEpoch,
      expiresAt: new Date(start + 48 * 3600_000), audience: 'user' });
    return { user, token, session };
  }
  const a = await account('a'), b = await account('b');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  async function call(method, path, actor = a, { headers = {}, payload } = {}) {
    const response = await fetch(url + path, { method, headers: {
      ...(actor ? { authorization: `Bearer ${actor.token}` } : {}), ...headers,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, data: await response.json(), etag: response.headers.get('etag'), cache: response.headers.get('cache-control') };
  }
  async function append(owner = a, event = 'system-event-1', target_ref = null) {
    return app.messagesService.appendMessage({ owner_id: owner.user.id, type: 'system', target_ref, event_key: event });
  }
  return { app, auth, messages, a, b, call, append, advance: ms => { time += ms; } };
}

function error(result, status, code) {
  assert.equal(result.status, status);
  assert.equal(result.data.error.code, code);
  assert.equal(result.cache, 'no-store');
}

test('消息实际HTTP：内部事件去重、并发首次读推进版本、重复读与未读一致', async t => {
  const h = await fixture(t);
  const empty = await h.call('GET', unread);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.data, { count: 0 });
  assert.equal(empty.data.meta.execution_mode, 'stub');
  assert.equal(empty.cache, 'no-store');
  assert.equal(empty.etag, null);
  const added = await h.append(), duplicate = await h.append();
  assert.equal(added.created, true);
  assert.equal(duplicate.created, false);
  assert.deepEqual((await h.call('GET', unread)).data.data, { count: 1 });
  const options = { headers: write() };
  const [one, two] = await Promise.all([h.call('PUT', read(added.message.id), h.a, options), h.call('PUT', read(added.message.id), h.a, options)]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.deepEqual(one.data.data, two.data.data);
  assert.equal(one.etag, '"2"');
  assert.equal(two.etag, '"2"');
  assert.equal(one.data.meta.contract_version, '1.0.0');
  assert.deepEqual(Object.keys(one.data.data).sort(), ['id', 'revision', 'type', 'target_ref', 'reference_state', 'read_at', 'created_at'].sort());
  assert.equal(one.data.data.read_at, new Date(start).toISOString());
  assert.equal(one.data.data.reference_state, 'unavailable');
  assert.deepEqual((await h.call('GET', unread)).data.data, { count: 0 });
  error(await h.call('PUT', read(added.message.id), h.a, { headers: write('messages-stale-001') }), 409, 'REVISION_CONFLICT');
  error(await h.call('PUT', read(added.message.id), h.a, { headers: write('messages-write-001', '"2"') }), 409, 'IDEMPOTENCY_CONFLICT');
  h.advance(1000);
  const repeat = await h.call('PUT', read(added.message.id), h.a, { headers: write('messages-current-001', '"2"') });
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeat.data.data, one.data.data);
  assert.equal(h.messages.snapshotCounts().read_transitions, 1);
});

test('消息实际HTTP：游客/后台/过期会话拒绝，他人与不存在同形，账号epoch变化立即拒绝', async t => {
  const h = await fixture(t);
  const added = await h.append();
  for (const [method, path] of [['GET', unread], ['PUT', read(added.message.id)]]) {
    error(await h.call(method, path, null, { headers: write() }), 401, 'SESSION_REQUIRED');
  }
  const foreign = await h.call('PUT', read(added.message.id), h.b, { headers: write() });
  const missing = await h.call('PUT', read(absent), h.b, { headers: write() });
  error(foreign, 404, 'NOT_FOUND');
  error(missing, 404, 'NOT_FOUND');
  assert.deepEqual(foreign.data.error, missing.data.error);
  assert.deepEqual((await h.call('GET', unread, h.b)).data.data, { count: 0 });
  const admin = await h.auth.createAdmin({ loginName: 'message-admin', credentialHash: 'synthetic-unused-hash', scopes: [] });
  const adminToken = 'synthetic-admin-message-token';
  await h.auth.createSession({ userId: admin, tokenHashHex: hashToken(adminToken), authEpoch: 1, expiresAt: new Date(start + 60000), audience: 'admin' });
  error(await h.call('GET', unread, { token: adminToken }), 401, 'SESSION_EXPIRED');
  await h.auth.revokeSession(h.b.session, 'user');
  error(await h.call('GET', unread, h.b), 401, 'SESSION_EXPIRED');
  await h.auth.bumpUserAuthEpoch(h.a.user.id);
  error(await h.call('PUT', read(added.message.id), h.a, { headers: write() }), 403, 'ACCOUNT_INACTIVE');
  assert.equal(h.messages.snapshotCounts().read_transitions, 0);
});

test('消息实际HTTP：严格输入及无请求体，不接受客户端归属/读状态/版本', async t => {
  const h = await fixture(t);
  const added = await h.append();
  error(await h.call('GET', unread + '?owner_id=' + h.b.user.id), 400, 'INVALID_REQUEST');
  error(await h.call('PUT', read(added.message.id) + '?read_at=now', h.a, { headers: write() }), 400, 'INVALID_REQUEST');
  error(await h.call('PUT', read(added.message.id), h.a, { headers: { 'idempotency-key': 'messages-valid-001' } }), 428, 'REVISION_REQUIRED');
  error(await h.call('PUT', read(added.message.id), h.a, { headers: { 'if-match': '"1"' } }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
  error(await h.call('PUT', read(added.message.id), h.a, { headers: write('messages-invalid-001', '*') }), 400, 'INVALID_REQUEST');
  error(await h.call('PUT', read('not-a-uuid'), h.a, { headers: write() }), 400, 'INVALID_REQUEST');
  for (const payload of [{}, null, { owner_id: h.b.user.id, revision: 3, read_at: 'now' }]) {
    error(await h.call('PUT', read(added.message.id), h.a, { headers: write(), payload }), 400, 'INVALID_REQUEST');
  }
  assert.equal(h.messages.snapshotCounts().read_transitions, 0);
});

test('消息实际HTTP：相同回执重放重新核验目标可见性，不恢复已失效引用', async t => {
  let visible = true, probes = 0;
  const reference = createWiredReferencePort({ resolve: async () => { probes++; return visible ? 'available' : 'unavailable'; } });
  const h = await fixture(t, { reference });
  const added = await h.append(h.a, 'referenced-event', { type: 'job', id: absent, revision: 1 });
  const first = await h.call('PUT', read(added.message.id), h.a, { headers: write() });
  assert.equal(first.status, 200);
  assert.equal(first.data.data.reference_state, 'available');
  visible = false;
  const replay = await h.call('PUT', read(added.message.id), h.a, { headers: write() });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.data.reference_state, 'unavailable');
  assert.equal(probes, 2);
  assert.equal(replay.data.data.read_at, first.data.data.read_at);
  assert.equal(replay.etag, first.etag);
  assert.equal(h.messages.snapshotCounts().read_transitions, 1);
});

test('消息实际HTTP：产品回执24h，6m及23h59m重放不续期，到期旧版本冲突', async t => {
  const h = await fixture(t);
  const added = await h.append(), key = 'messages-ttl-001';
  const scope = idempotencyScope(h.a.user.id, 'PUT', `/messages/${added.message.id}/read`);
  const keyHash = idempotencyKeyHashHex(scope, key);
  const first = await h.call('PUT', read(added.message.id), h.a, { headers: write(key) });
  assert.equal(first.status, 200);
  const deadline = (await h.messages.findIdempotency(scope, keyHash)).expires_at;
  assert.equal(deadline - start, 86400000);
  h.advance(6 * 60000);
  assert.equal((await h.call('PUT', read(added.message.id), h.a, { headers: write(key) })).status, 200);
  h.advance(1433 * 60000);
  assert.equal((await h.call('PUT', read(added.message.id), h.a, { headers: write(key) })).status, 200);
  assert.equal((await h.messages.findIdempotency(scope, keyHash)).expires_at, deadline);
  h.advance(60000);
  error(await h.call('PUT', read(added.message.id), h.a, { headers: write(key) }), 409, 'REVISION_CONFLICT');
  const fresh = await h.call('PUT', read(added.message.id), h.a, { headers: write(key, '"2"') });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.etag, '"2"');
  assert.equal(h.messages.snapshotCounts().read_transitions, 1);
});

test('消息实际HTTP：real即使注入内存也503，未注册列表/创建，不伪造消息能力', async t => {
  const h = await fixture(t, { real: true });
  assert.equal(h.app.messagesService, null);
  error(await h.call('GET', unread), 503, 'PROVIDER_UNAVAILABLE');
  error(await h.call('PUT', read(absent), h.a, { headers: write() }), 503, 'PROVIDER_UNAVAILABLE');
  error(await h.call('GET', unread, null), 401, 'SESSION_REQUIRED');
  const list = await h.call('GET', '/api/v1/messages');
  const create = await h.call('POST', '/api/v1/messages', h.a, { payload: { owner_id: h.a.user.id } });
  assert.equal(list.status, 404);
  assert.equal(create.status, 404);
  assert.equal(h.messages.snapshotCounts().messages, 0);
});
