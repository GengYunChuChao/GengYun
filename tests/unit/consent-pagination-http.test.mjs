import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';

const KEY = 'synthetic-consent-pagination-test-key';
const read = name => readFileSync(new URL('../../services/api/db/' + name, import.meta.url), 'utf8');
const sign = text => createHmac('sha256', KEY).update(`consent-list/v1\n${text}`).digest('base64url');
const rewrite = (cursor, change) => {
  const value = JSON.parse(Buffer.from(cursor.split('.')[0], 'base64url'));
  change(value);
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
};

test('授权分页走实际产品 HTTP 与受限 SQL：稳定排序、用户/水位/有效期、退出重验（合成资料）', async t => {
  const db = new PGlite();
  let app, queue = Promise.resolve();
  t.after(async () => { await app?.close(); await queue; await db.close(); });
  for (const name of ['0001_initial_schema', '0003_privacy_consent', '0008_auth_session']) {
    await db.exec(read(`migrations/${name}.sql`));
  }
  await db.exec(read('roles/auth_privacy.sql'));
  await db.exec('CREATE ROLE gy_consent_page_runtime NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT gengyun_auth_privacy TO gy_consent_page_runtime');
  const pool = {
    async connect() {
      const before = queue;
      let unlock;
      queue = new Promise(resolve => { unlock = resolve; });
      await before;
      await db.query('SET ROLE gy_consent_page_runtime');
      return { query: (...args) => db.query(...args), release() { db.query('RESET ROLE').finally(unlock); } };
    },
    async query(...args) { const client = await this.connect(); try { return await client.query(...args); } finally { client.release(); } },
  };
  app = buildApp({ config: { ...loadConfig({ APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent' }), sessionSigningKey: KEY }, pool });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const http = async (path, token, options = {}) => {
    const response = await fetch(base + path, { ...options, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers } });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
  async function login(code) {
    const response = await http('/auth/wechat', null, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'page-login-' + code }, body: JSON.stringify({ code }) });
    assert.equal(response.status, 200);
    const token = response.body.data.access_token;
    await queue;
    const row = (await db.query("SELECT user_id FROM sessions WHERE token_hash=decode($1,'hex')", [hashToken(token)])).rows[0];
    return { id: row.user_id, token };
  }
  const a = await login('synthetic-a'), b = await login('synthetic-b');
  const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000004'];
  const purposes = ['external_inference', 'media_processing', 'recording', 'public_posting'];
  const dates = ['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z', '2026-09-01T00:00:00Z'];
  for (let index = 0; index < ids.length; index++) {
    await db.query("INSERT INTO consent_records(id,user_id,purpose,policy_version,epoch,granted_at) VALUES($1,$2,$3,'synthetic-not-published',1,$4)", [ids[index], a.id, purposes[index], dates[index]]);
    await db.query("INSERT INTO privacy_epochs(user_id,purpose,current_epoch,state) VALUES($1,$2,1,'granted')", [a.id, purposes[index]]);
  }
  const first = await http('/me/consents?limit=1', a.token);
  assert.equal(first.status, 200);
  assert.equal(first.cache, 'no-store');
  assert.equal(first.body.data.items[0].id, ids[2], '同创建时点按id降序；不能沿用随机UUID升序');
  const cursor = first.body.data.next_cursor;
  const rest = await http('/me/consents?limit=50&cursor=' + cursor, a.token);
  assert.equal(rest.status, 200);
  assert.deepEqual(rest.body.data.items.map(row => row.id), [ids[1], ids[0], ids[3]]);
  assert.equal(rest.body.data.next_cursor, null);
  assert.equal(rest.body.meta.execution_mode, 'stub');
  assert.equal(rest.body.meta.contract_version, '1.0.0');
  assert.ok(!JSON.stringify(rest.body).includes('user_id'));
  const empty = await http('/me/consents', b.token);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data, { items: [], next_cursor: null });
  for (const [token, value] of [
    [b.token, cursor], [a.token, cursor.replace(/\.[^.]+$/, '.invalid')],
    [a.token, Buffer.from(ids[2]).toString('base64url')],
    [a.token, rewrite(cursor, value => { value.expires = Date.now() - 1; })],
    [a.token, rewrite(cursor, value => { value.auth_epoch = 2; })],
    [a.token, rewrite(cursor, value => { value.kind = 'knowledge'; })],
  ]) {
    const rejected = await http('/me/consents?cursor=' + value, token);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'INVALID_CURSOR');
  }
  const withdrawn = await http('/me/consents/recording', a.token, { method: 'DELETE', headers: { 'idempotency-key': 'page-withdraw-recording', 'if-match': '"1"' } });
  assert.equal(withdrawn.status, 200);
  const stale = await http('/me/consents?cursor=' + cursor, a.token);
  assert.equal(stale.status, 400);
  assert.equal(stale.body.error.code, 'INVALID_CURSOR');
  const restarted = await http('/me/consents?limit=1', a.token);
  assert.equal(restarted.status, 200);
  assert.equal(restarted.body.data.items[0].state, 'withdrawn');
  const newCursor = restarted.body.data.next_cursor;
  const logout = await http('/auth/logout', a.token, { method: 'POST', headers: { 'idempotency-key': 'page-logout-test' } });
  assert.equal(logout.status, 200);
  const expired = await http('/me/consents?cursor=' + newCursor, a.token);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.code, 'SESSION_EXPIRED');
  console.log('PASS loopback HTTP + PGlite limited SET ROLE; current consent snapshot and session rechecked; synthetic identity/data only, not native PG17 or external provider evidence');
});
