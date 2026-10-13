/** Synthetic inputs, real HTTP and native PG17.11, dedicated fresh loopback DB only.
 * Owner performs migrations/fixtures/fault injection; API uses a separate restricted LOGIN.
 * The test-only read route is not an implemented media/export consumer.
 */
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createPool } from '../../services/api/src/db/pool.ts';
import { createPostgresAuthStore } from '../../services/api/src/auth/store.ts';
import { createAuthGuards, currentIdentity } from '../../services/api/src/auth/middleware.ts';
import { hashToken, readBearerToken } from '../../services/api/src/auth/tokens.ts';
import { hashPassword } from '../../services/api/src/auth/password.ts';
import { createPostgresConsentService } from '../../services/api/src/privacy/consent-pg.ts';

const url = new URL(process.env.AUTH_PRIVACY_TEST_URL ?? '');
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.equal(url.search, '', 'no pg URL override options');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'loopback only');
assert.equal(url.pathname, '/gengyun_auth_privacy_test', 'dedicated fresh DB only');
const owner = new pg.Client({ connectionString: url.href });
await owner.connect();
const group = 'gengyun_auth_privacy';
const loginName = 'gengyun_auth_privacy_test';
const password = randomBytes(24).toString('hex');
const signingKey = randomBytes(32).toString('hex');
let pool, app, rolesCreated = false, passed = 0;
const say = text => { passed++; console.log(`PASS ${passed}: ${text}`); };
const sqlFile = path => readFileSync(new URL(`../../services/api/db/${path}`, import.meta.url), 'utf8');
const subject = code => createHmac('sha256', signingKey).update(`synthetic\n${code}`).digest('hex');
async function request(path, token, options = {}) {
  const r = await fetch(`${app.listeningOrigin}/api/v1${path}`, {
    ...options, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  const body = await r.json();
  assert.equal(body.meta.execution_mode, 'real');
  assert.equal(body.meta.contract_version, '1.0.0');
  return { status: r.status, body, headers: r.headers };
}
async function expectError(path, token, status, code, options = {}) {
  const r = await request(path, token, options);
  assert.equal(r.status, status, JSON.stringify(r.body));
  assert.equal(r.body.error.code, code);
  return r;
}
async function login(code, key = randomBytes(12).toString('hex')) {
  const r = await request('/auth/wechat', null, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ code }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const user = (await owner.query("SELECT id FROM users WHERE wechat_subject_lookup=decode($1,'hex')", [subject(code)])).rows[0];
  const session = (await owner.query("SELECT id FROM sessions WHERE token_hash=decode($1,'hex')", [hashToken(r.body.data.access_token)])).rows[0];
  return { id: user.id, sessionId: session.id, token: r.body.data.access_token };
}
async function fixture(user, purpose = 'external_inference', epoch = 1) {
  const r = await owner.query(`INSERT INTO consent_records(user_id,purpose,policy_version,recipient_ids,epoch)
    VALUES($1,$2,'synthetic-not-published','[]',$3) RETURNING *`, [user.id, purpose, epoch]);
  await owner.query(`INSERT INTO privacy_epochs(user_id,purpose,current_epoch,state) VALUES($1,$2,$3,'granted')
    ON CONFLICT(user_id,purpose) DO UPDATE SET current_epoch=excluded.current_epoch,state='granted',revision=privacy_epochs.revision+1`, [user.id, purpose, epoch]);
  return r.rows[0];
}
const deletion = (key = randomBytes(12).toString('hex'), revision = 1) => ({ method: 'DELETE', headers: { 'idempotency-key': key, 'if-match': `"${revision}"` } });
const withdraw = (user, key, revision = 1) => request('/me/consents/external_inference', user.token, deletion(key, revision));
async function epoch(user, purpose = 'external_inference') {
  return (await owner.query('SELECT current_epoch,state FROM privacy_epochs WHERE user_id=$1 AND purpose=$2', [user.id, purpose])).rows[0];
}
async function waitForLock() {
  for (let i = 0; i < 100; i++) {
    const r = await owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'", [loginName]);
    if (r.rows[0].n > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('actual API SQL lock wait not observed');
}
async function lockedRace(user, action, mutate) {
  const lock = new pg.Client({ connectionString: url.href });
  await lock.connect();
  let pending;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    pending = action();
    await waitForLock();
    await mutate(lock);
    await lock.query('COMMIT');
    return await pending;
  } finally { await lock.query('ROLLBACK').catch(() => {}); await lock.end(); await pending?.catch(() => {}); }
}
try {
  const version = (await owner.query('SHOW server_version')).rows[0].server_version;
  assert.match(version, /^17\.11(?:\D|$)/);
  console.log(`Native PostgreSQL: ${version}`);
  assert.equal((await owner.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
  assert.equal((await owner.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=ANY($1)', [[group, loginName]])).rows[0].n, 0);
  for (const file of ['0001_initial_schema.sql', '0003_privacy_consent.sql', '0008_auth_session.sql']) await owner.query(sqlFile(`migrations/${file}`));
  say('0001/0003/0008 executed on fresh native PG17.11 (not migration-runner atomicity evidence)');
  await owner.query(sqlFile('roles/auth_privacy.sql'));
  rolesCreated = true;
  await owner.query(`CREATE ROLE ${loginName} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  await owner.query(`GRANT ${group} TO ${loginName}`);
  const runtimeUrl = new URL(url); runtimeUrl.username = loginName; runtimeUrl.password = password;
  pool = createPool(runtimeUrl.href);
  const flags = (await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.ok(Object.values(flags).every(value => value === false));
  const ownerName = (await owner.query('SELECT current_user AS name')).rows[0].name.replaceAll('"', '""');
  for (const sql of ['CREATE TABLE public.forbidden(id int)', 'CREATE TEMP TABLE forbidden(id int)', 'CREATE ROLE forbidden', `SET ROLE "${ownerName}"`, 'SELECT wechat_subject_cipher FROM users', 'SELECT object_ref_cipher FROM media', "UPDATE users SET state='deleted'", 'DELETE FROM users', 'INSERT INTO privacy_epochs(user_id,purpose) VALUES(gen_random_uuid(),\'recording\')', "UPDATE recipients SET enabled=true", 'INSERT INTO admin_accounts(login_name,credential_hash) VALUES(\'forbidden\',\'forbidden\')']) {
    await assert.rejects(pool.query(sql), e => e.code === '42501');
  }
  say('restricted LOGIN cannot DDL, owner SET ROLE, private content, account disable, grant, recipient enable or admin bootstrap');
  const config = { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), executionMode: 'real', sessionSigningKey: signingKey };
  const store = createPostgresAuthStore({ query: async (text, values) => ({ rows: (await pool.query(text, values)).rows }) });
  const guards = createAuthGuards({ store, now: () => new Date() });
  const consent = createPostgresConsentService(pool, signingKey);
  let authClockMs = null;
  let identityExchanges = 0;
  app = buildApp({ config, pool, now: () => new Date(authClockMs ?? Date.now()),
    wechat: { exchange: async code => { identityExchanges++; return { subjectLookupHex: subject(code) }; } } });
  // Test-only read consumer: no remote provider, no business media route, no write callback.
  app.get('/api/v1/test-only/consent-read', { preHandler: guards.requireUser }, request => consent.requireConsent({ identity: currentIdentity(request), token: readBearerToken(request.headers.authorization) }, { purpose: 'external_inference' }));
  // The test-only route must still produce the application meta envelope.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url === '/api/v1/test-only/consent-read' && reply.statusCode === 200) return JSON.stringify({ data: JSON.parse(payload), meta: { execution_mode: 'real', contract_version: '1.0.0' } });
    return payload;
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const a = await login('synthetic-A');
  const b = await login('synthetic-B');
  assert.notEqual(a.id, b.id);
  say('actual loopback HTTP login persists hashed sessions for synthetic identities under runtime LOGIN');
  await expectError('/me/consents', null, 401, 'SESSION_REQUIRED');
  await expectError('/me/consents', 'unknown-token', 401, 'SESSION_EXPIRED');
  await expectError('/auth/wechat', null, 400, 'INVALID_REQUEST', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'forged-identity' }, body: JSON.stringify({ code: 'fake', userId: a.id, authEpoch: 1 }) });
  await expectError(`/me/consents?userId=${b.id}`, a.token, 400, 'INVALID_REQUEST');
  say('missing/unknown bearer and client-supplied identity are rejected');
  const adminPassword = randomBytes(20).toString('hex');
  const admin = (await owner.query('INSERT INTO admin_accounts(login_name,credential_hash) VALUES($1,$2) RETURNING id', ['synthetic-admin', hashPassword(adminPassword)])).rows[0];
  await owner.query("INSERT INTO admin_scopes(admin_id,scope) VALUES($1,'moderation')", [admin.id]);
  const adminLogin = await request('/admin/auth/session', null, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'synthetic-admin-login' }, body: JSON.stringify({ login_name: 'synthetic-admin', password: adminPassword }) });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
  await expectError('/me/consents', adminLogin.body.data.access_token, 401, 'SESSION_EXPIRED');
  await expectError('/me/consents/external_inference', adminLogin.body.data.access_token, 401, 'SESSION_EXPIRED', deletion('admin-wrong-audience'));
  say('actual PG administrator session cannot list or withdraw user consent');
  await expectError('/test-only/consent-read', a.token, 403, 'CONSENT_REQUIRED');
  await owner.query("INSERT INTO privacy_epochs(user_id,purpose) VALUES($1,'recording')", [a.id]);
  assert.equal((await request('/me/consents', a.token)).body.data.items.length, 0);
  await expectError('/test-only/consent-read', a.token, 403, 'CONSENT_REQUIRED');
  say('no consent and epoch-zero never-granted records do not authorize');
  const initial = await fixture(a);
  await fixture(a, 'media_processing');
  await fixture(b);
  const read = await request('/test-only/consent-read', a.token);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.data.userId, a.id); assert.equal(read.body.data.consentEpoch, 1);
  const page = await request('/me/consents?limit=1', a.token);
  assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.body.data.items.length, 1); assert.ok(page.body.data.next_cursor);
  const next = await request(`/me/consents?limit=1&cursor=${page.body.data.next_cursor}`, a.token);
  assert.equal(next.body.data.items.length, 1); assert.equal(next.body.data.next_cursor, null);
  assert.notEqual(next.body.data.items[0].id, page.body.data.items[0].id);
  const own = await request('/me/consents', b.token);
  assert.equal(own.body.data.items.length, 1);
  assert.notEqual(own.body.data.items[0].id, initial.id);
  assert.ok(!JSON.stringify(page.body).includes('user_id'));
  await expectError('/me/consents?cursor=invalid', a.token, 400, 'INVALID_CURSOR');
  await expectError('/me/consents?limit=51', a.token, 400, 'INVALID_REQUEST');
  say('reference guard consumes authenticated PG identity; paginated consent DTOs are owner-scoped');
  await expectError('/me/consents/external_inference', a.token, 428, 'REVISION_REQUIRED', { method: 'DELETE', headers: { 'idempotency-key': 'missing-revision' } });
  await expectError('/me/consents/external_inference', a.token, 400, 'IDEMPOTENCY_KEY_REQUIRED', { method: 'DELETE', headers: { 'if-match': '"1"' } });
  await expectError('/me/consents/external_inference', a.token, 409, 'REVISION_CONFLICT', deletion('wrong-revision', 2));
  await expectError('/me/consents/external_inference', a.token, 400, 'INVALID_REQUEST', { method: 'DELETE', headers: { 'idempotency-key': 'weak-etag-withdraw', 'if-match': 'W/"1"' } });
  assert.equal((await epoch(a)).current_epoch, '1');
  say('withdrawal requires idempotency key and strong current revision, with no mutation on rejection');
  const key = 'same-key-concurrent-withdraw';
  const concurrent = await Promise.all([withdraw(a, key), withdraw(a, key)]);
  assert.deepEqual(concurrent.map(r => r.status), [200, 200]);
  assert.deepEqual(concurrent[0].body.data, concurrent[1].body.data);
  assert.equal(concurrent[0].headers.get('etag'), '"2"');
  assert.deepEqual(await epoch(a), { current_epoch: '2', state: 'withdrawn' });
  await expectError('/test-only/consent-read', a.token, 403, 'CONSENT_REQUIRED');
  await expectError('/me/consents/external_inference', a.token, 409, 'IDEMPOTENCY_CONFLICT', deletion(key, 2));
  say('same-key concurrent HTTP withdrawal converges, atomically advances epoch once, blocks subsequent reads');
  await fixture(a, 'external_inference', 3);
  assert.equal((await withdraw(a, key)).body.data.id, initial.id);
  assert.deepEqual(await epoch(a), { current_epoch: '3', state: 'granted' });
  assert.equal((await request('/test-only/consent-read', a.token)).status, 200);
  say('old withdrawal receipt replay cannot withdraw a newly granted epoch');
  const d = await login('different-keys'); await fixture(d);
  const competing = await Promise.all([withdraw(d, 'withdraw-key-one'), withdraw(d, 'withdraw-key-two')]);
  assert.deepEqual(competing.map(r => r.status).sort(), [200, 409]);
  assert.equal((await epoch(d)).current_epoch, '2');
  say('different-key concurrent withdrawals serialize and stale revision loses without a second epoch bump');
  const f = await login('forced-rollback'); const fRecord = await fixture(f);
  await owner.query(`CREATE FUNCTION public.test_only_fail_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.user_id='${f.id}'::uuid THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_only_fail_epoch BEFORE UPDATE ON privacy_epochs FOR EACH ROW EXECUTE FUNCTION public.test_only_fail_epoch()`);
  await expectError('/me/consents/external_inference', f.token, 503, 'PROVIDER_UNAVAILABLE', deletion('forced-rollback-key'));
  assert.equal((await owner.query('SELECT state,revision FROM consent_records WHERE id=$1', [fRecord.id])).rows[0].state, 'granted');
  assert.equal((await epoch(f)).current_epoch, '1');
  assert.equal((await owner.query('SELECT count(*)::int n FROM idempotency_keys WHERE scope LIKE $1', [`${f.id}%`])).rows[0].n, 0);
  await owner.query('DROP TRIGGER test_only_fail_epoch ON privacy_epochs; DROP FUNCTION public.test_only_fail_epoch()');
  assert.equal((await withdraw(f, 'forced-rollback-key')).status, 200);
  say('injected native SQL failure rolls back record, epoch and receipt together; retry succeeds');
  const dependent = await login('existing-media'); await fixture(dependent);
  const mediaId = (await owner.query(`INSERT INTO media(owner_id,purpose,mime,bytes,sha256,object_ref_cipher) VALUES($1,'weed_recognition','image/png',1,$2,'synthetic-private-ref') RETURNING id`, [dependent.id, '0'.repeat(64)])).rows[0].id;
  await expectError('/me/consents/external_inference', dependent.token, 409, 'OBJECT_UNAVAILABLE', deletion('dependency-block'));
  assert.equal((await epoch(dependent)).current_epoch, '1');
  await owner.query('DELETE FROM media WHERE id=$1', [mediaId]);
  assert.equal((await withdraw(dependent, 'dependency-block')).status, 200);
  say('existing media dependency refuses partial withdrawal; rejection leaves consent and receipt unchanged');
  const corrupt = await login('inconsistent-epoch'); const corruptRecord = await fixture(corrupt);
  await owner.query("UPDATE consent_records SET state='withdrawn',withdrawn_at=now() WHERE id=$1", [corruptRecord.id]);
  await expectError('/me/consents', corrupt.token, 503, 'PROVIDER_UNAVAILABLE');
  await expectError('/test-only/consent-read', corrupt.token, 503, 'PROVIDER_UNAVAILABLE');
  await expectError('/me/consents/external_inference', corrupt.token, 503, 'PROVIDER_UNAVAILABLE', deletion('bad-state-withdraw'));
  say('inconsistent persisted record/epoch fails closed for list, read gate and withdrawal');
  await owner.query('DELETE FROM consent_records WHERE id=$1', [corruptRecord.id]);
  await expectError('/me/consents', corrupt.token, 503, 'PROVIDER_UNAVAILABLE');
  await expectError('/test-only/consent-read', corrupt.token, 503, 'PROVIDER_UNAVAILABLE');
  const malformed = await login('malformed-recipient'); const malformedRecord = await fixture(malformed);
  await owner.query('UPDATE consent_records SET recipient_ids=$2::jsonb WHERE id=$1', [malformedRecord.id, '[123]']);
  await expectError('/me/consents', malformed.token, 503, 'PROVIDER_UNAVAILABLE');
  say('missing corresponding record or malformed recipient DTO fails closed');
  const inactive = await login('inactive'); await fixture(inactive);
  for (const state of ['suspended', 'deletion_pending', 'deleted']) {
    await owner.query('UPDATE users SET state=$2 WHERE id=$1', [inactive.id, state]);
    await expectError('/me/consents', inactive.token, 403, 'ACCOUNT_INACTIVE');
    await expectError('/me/consents/external_inference', inactive.token, 403, 'ACCOUNT_INACTIVE', deletion('inactive-replay'));
  }
  await owner.query("UPDATE users SET state='active',auth_epoch=auth_epoch+1 WHERE id=$1", [inactive.id]);
  await expectError('/me/consents', inactive.token, 403, 'ACCOUNT_INACTIVE');
  say('suspended/deletion_pending/deleted and stale auth epoch block list and mutation');
  const stop = await login('stop-after-auth'); await fixture(stop);
  const stopped = await lockedRace(stop, () => withdraw(stop, 'stopped-during-request'), lock => lock.query("UPDATE users SET state='suspended',auth_epoch=auth_epoch+1 WHERE id=$1", [stop.id]));
  assert.equal(stopped.status, 403); assert.equal(stopped.body.error.code, 'ACCOUNT_INACTIVE');
  assert.equal((await epoch(stop)).current_epoch, '1');
  say('observed PG lock race: account disabled after HTTP preHandler but before transaction prevents mutation');
  const revoke = await login('revoke-after-auth'); await fixture(revoke);
  const revoked = await lockedRace(revoke, () => withdraw(revoke, 'revoke-during-request'), lock => lock.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [revoke.sessionId]));
  assert.equal(revoked.status, 401); assert.equal(revoked.body.error.code, 'SESSION_EXPIRED');
  assert.equal((await epoch(revoke)).current_epoch, '1');
  say('observed PG lock race: revoked session after HTTP preHandler is rechecked before withdrawal');
  const expired = await login('expire-after-auth'); await fixture(expired);
  const expiredResponse = await lockedRace(expired, () => withdraw(expired, 'expire-during-request'), lock => lock.query("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 millisecond',created_at=clock_timestamp()-interval '1 day' WHERE id=$1", [expired.sessionId]));
  assert.equal(expiredResponse.status, 401); assert.equal(expiredResponse.body.error.code, 'SESSION_EXPIRED');
  assert.equal((await epoch(expired)).current_epoch, '1');
  say('observed PG lock race: session expiring after HTTP preHandler cannot mutate');
  const delayed = await login('consent-withdrawn-before-read'); const delayedRecord = await fixture(delayed);
  const delayedRead = await lockedRace(delayed, () => request('/test-only/consent-read', delayed.token), async lock => {
    await lock.query("UPDATE consent_records SET state='withdrawn',withdrawn_at=clock_timestamp(),revision=revision+1 WHERE id=$1", [delayedRecord.id]);
    await lock.query("UPDATE privacy_epochs SET state='withdrawn',current_epoch=current_epoch+1,revision=revision+1 WHERE user_id=$1 AND purpose='external_inference'", [delayed.id]);
  });
  assert.equal(delayedRead.status, 403); assert.equal(delayedRead.body.error.code, 'CONSENT_REQUIRED');
  say('observed PG lock race: withdrawal before delayed authenticated read prevents stale permission reuse (not a business write test)');
  await owner.query('UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=$1', [a.id]);
  await expectError('/me/consents/external_inference', a.token, 403, 'ACCOUNT_INACTIVE', deletion(key));
  say('idempotent withdrawal replay reauthenticates and rejects stale account epoch');
  const replayKey = 'synthetic-login-replay';
  const first = await login('login-replay', replayKey); const second = await login('login-replay', replayKey);
  assert.equal(first.sessionId, second.sessionId); assert.notEqual(first.token, second.token);
  await expectError('/me/consents', first.token, 401, 'SESSION_EXPIRED');
  assert.equal((await request('/me/consents', second.token)).status, 200);
  await request('/auth/logout', second.token, { method: 'POST', headers: { 'idempotency-key': 'synthetic-logout' } });
  await expectError('/me/consents', second.token, 401, 'SESSION_EXPIRED');
  say('real PG auth idempotent login rotates one session; old and logged-out bearer cannot read consent');
  const ledger = (await owner.query('SELECT outcome FROM idempotency_keys')).rows;
  assert.ok(ledger.every(row => row.outcome === null || !JSON.stringify(row.outcome).includes('access_token')));
  assert.ok(!JSON.stringify(ledger).includes(signingKey));
  say('idempotency receipts contain references, no bearer or server signing key');
  // Only auth requests follow below. Time advances in the application clock; no wall-clock wait
  // or real WeChat exchange. All rows use this disposable cluster's synthetic identities.
  authClockMs = Date.now();
  const startMs = authClockMs;
  const exchangesBefore = identityExchanges;
  const ttlKey = 'synthetic-24h-window';
  const ttlFirst = await login('login-ttl-window', ttlKey);
  const receipt = (await owner.query("SELECT id,expires_at FROM idempotency_keys WHERE outcome->>'sessionId'=$1", [ttlFirst.sessionId])).rows[0];
  const originalSession = (await owner.query('SELECT expires_at FROM sessions WHERE id=$1', [ttlFirst.sessionId])).rows[0];
  assert.equal(receipt.expires_at.getTime(), startMs + 24 * 60 * 60 * 1000);
  let latest = ttlFirst;
  for (const at of [startMs + 6 * 60 * 1000, startMs + 24 * 60 * 60 * 1000 - 1]) {
    authClockMs = at;
    latest = await login('login-ttl-window', ttlKey);
    assert.equal(latest.sessionId, ttlFirst.sessionId);
    assert.equal(identityExchanges, exchangesBefore + 1);
    const saved = (await owner.query('SELECT expires_at FROM idempotency_keys WHERE id=$1', [receipt.id])).rows[0];
    assert.equal(saved.expires_at.getTime(), receipt.expires_at.getTime());
    const session = (await owner.query('SELECT expires_at FROM sessions WHERE id=$1', [ttlFirst.sessionId])).rows[0];
    assert.equal(session.expires_at.getTime(), originalSession.expires_at.getTime());
  }
  await expectError('/auth/wechat', null, 409, 'IDEMPOTENCY_CONFLICT', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': ttlKey }, body: JSON.stringify({ code: 'different-ttl-code' }) });
  say('24h auth receipt persists under restricted LOGIN; 6m/24h-1ms replays retain one session and one synthetic identity exchange, no sliding expiry');
  assert.equal((await request('/auth/logout', latest.token, { method: 'POST', headers: { 'idempotency-key': 'synthetic-ttl-logout' } })).status, 200);
  await expectError('/auth/wechat', null, 401, 'SESSION_EXPIRED', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': ttlKey }, body: JSON.stringify({ code: 'login-ttl-window' }) });
  assert.equal(identityExchanges, exchangesBefore + 1);
  authClockMs = startMs + 24 * 60 * 60 * 1000;
  const renewed = await login('login-ttl-window', ttlKey);
  assert.notEqual(renewed.sessionId, ttlFirst.sessionId);
  assert.equal(identityExchanges, exchangesBefore + 2);
  assert.equal((await owner.query('SELECT count(*)::int n FROM idempotency_keys WHERE id=$1', [receipt.id])).rows[0].n, 0);
  say('within-window revoked login cannot replay; exact 24h boundary physically removes original PG receipt (new exchange remains synthetic)');
  authClockMs = Date.now();
  const adminStartMs = authClockMs;
  const ttlAdminOptions = { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'synthetic-admin-24h-window' },
    body: JSON.stringify({ login_name: 'synthetic-admin', password: adminPassword }) };
  const adminFirst = await request('/admin/auth/session', null, ttlAdminOptions);
  assert.equal(adminFirst.status, 200);
  assert.equal(Date.parse(adminFirst.body.data.expires_at), adminStartMs + 8 * 60 * 60 * 1000);
  authClockMs += 6 * 60 * 1000;
  const adminReplay = await request('/admin/auth/session', null, ttlAdminOptions);
  assert.equal(adminReplay.status, 200);
  assert.equal(adminReplay.body.data.expires_at, adminFirst.body.data.expires_at);
  const sessionCount = (await owner.query('SELECT count(*)::int n FROM admin_sessions WHERE admin_id=$1', [admin.id])).rows[0].n;
  authClockMs = adminStartMs + 8 * 60 * 60 * 1000;
  await expectError('/admin/auth/session', null, 401, 'SESSION_EXPIRED', ttlAdminOptions);
  assert.equal((await owner.query('SELECT count(*)::int n FROM admin_sessions WHERE admin_id=$1', [admin.id])).rows[0].n, sessionCount);
  say('24h PG receipt does not prolong an 8h admin session or silently establish a replacement');
  console.log(`ALL ${passed} native PG17.11 integration groups passed; grant API is tested separately; business write/export consumers remain unimplemented.`);
} finally {
  await app?.close();
  await pool?.end();
  if (rolesCreated) {
    await owner.query(`DROP OWNED BY ${loginName},${group}; DROP ROLE IF EXISTS ${loginName}; DROP ROLE ${group}`);
  }
  await owner.end();
}
