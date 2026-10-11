import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { createProfileService } from '../../services/api/src/profile/service.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const crops = JSON.parse(read('packages/knowledge/catalog/crops.json')).crops;
const regions = JSON.parse(read('packages/knowledge/catalog/regions-zhejiang.json')).regions;
const input = {crop_id: 'crop_rice', region_code: '330102', region_catalog_version: 'mca-xzqh-2023'};
const route = '/api/v1/me/profile';

async function fixture() {
  let pool, db, release = async () => {};
  if (process.env.GY_PROFILE_TEST_DATABASE_URL) {
    const url = new URL(process.env.GY_PROFILE_TEST_DATABASE_URL);
    assert.equal(url.hostname, '127.0.0.1');
    assert.match(url.pathname, /^\/gy_i05_test_[a-z0-9_]+$/);
    assert.match(url.username, /^gy_i05_test_[a-z0-9_]+$/);
    pool = new pg.Pool({connectionString: url.href, max: 5, statement_timeout: 5000});
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows[0].n, 0, 'only a new empty dedicated local test database is allowed');
    const nativePool = pool;
    db = {exec: sql => nativePool.query(sql), query: (sql, values) => nativePool.query(sql, values)};
    release = () => nativePool.end();
  } else {
    db = new PGlite();
    let tail = Promise.resolve();
    pool = { query: (...args) => db.query(...args), async connect() {
      const before = tail;
      let unlock;
      tail = new Promise(resolve => {unlock = resolve;});
      await before;
      return {query: (...args) => db.query(...args), release: () => unlock()};
    }};
    const engine = db;
    release = () => engine.close();
  }
  await db.exec(read('services/api/db/migrations/0001_initial_schema.sql'));
  await db.exec(read('services/api/db/migrations/0002_knowledge_catalog.sql'));
  await db.exec(read('services/api/db/migrations/0003_privacy_consent.sql'));
  await db.exec(read('services/api/db/migrations/0008_auth_session.sql'));
  await db.exec(read('services/api/db/migrations/0009_consent_policy.sql'));
  for (const row of crops) await db.query('INSERT INTO crops(id,name,active) VALUES($1,$2,true)', [row.id, row.name]);
  for (const row of regions) await db.query('INSERT INTO regions(code,name,parent_code,catalog_version,supported) VALUES($1,$2,$3,$4,true)', [row.code,row.name,row.parent_code,row.catalog_version]);
  await db.exec(read('services/api/db/roles/auth_privacy.sql'));
  await db.exec(read('services/api/db/roles/profile_runtime.sql'));
  await db.exec('CREATE ROLE gy_i05_test_runtime NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT gengyun_auth_privacy,gengyun_profile_runtime TO gy_i05_test_runtime');
  let runtimeRole = 'gy_i05_test_runtime';
  const originalPool = pool;
  const ownerDb = db;
  // PGlite has one session: serialize the complete transaction, not individual
  // statements, so fixture-owner queries cannot leak privileges into API work.
  let queue = Promise.resolve();
  async function acquire() {
    const previous = queue; let unlock;
    queue = new Promise(resolve => {unlock = resolve;});
    await previous;
    return unlock;
  }
  pool = {
    async connect() {
      const unlock = await acquire();
      const client = process.env.GY_PROFILE_TEST_DATABASE_URL ? await originalPool.connect() : {query: (...args) => ownerDb.query(...args),release() {}};
      try { await client.query(`SET ROLE ${runtimeRole}`); }
      catch (error) {client.release();unlock();throw error;}
      return {query: (...args) => client.query(...args), release() { client.query('RESET ROLE').finally(() => {client.release();unlock();}); }};
    },
    async query(...args) {
      const client = await this.connect();
      try { return await client.query(...args); } finally {client.release();}
    },
  };
  db = {async query(...args) {
    const unlock = await acquire();
    try {return await ownerDb.query(...args);} finally {unlock();}
  }};
  const app = buildApp({config: loadConfig({APP_EXECUTION_MODE: 'stub', LOG_LEVEL: 'silent'}), pool});
  async function login(code) {
    const result = await app.inject({method: 'POST', url: '/api/v1/auth/wechat', headers: {'idempotency-key': `login-key-${code}`}, payload: {code}});
    assert.equal(result.statusCode, 200, result.body);
    return result.json().data.access_token;
  }
  const a = await login('profile-a'), b = await login('profile-b');
  const headers = token => ({authorization: `Bearer ${token}`});
  const put = (token, body = input, key = 'profile-key-0001', revision = '"1"') => app.inject({method:'PUT',url:route,headers:{...headers(token),'idempotency-key':key,'if-match':revision},payload:body});
  return {app, db, pool, a, b, headers, put, useRole(role) {runtimeRole=role;}, async close() {await app.close(); await queue; await release();}};
}

test('GY-I05 persistent profile/catalog HTTP and SQL regression (synthetic identity)', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const {app,db,a,b,headers,put} = f;
  await t.test('old auth-only role reproduces42501/HTTP503; new composed role has explicit limited rights', async () => {
    f.useRole('gengyun_auth_privacy');
    for (const sql of ['SELECT user_id FROM single_profiles','SELECT id FROM crops','SELECT code FROM regions']) {
      await assert.rejects(f.pool.query(sql),error=>error.code==='42501');
    }
    for (const url of [route,'/api/v1/catalog/crops','/api/v1/catalog/regions']) {
      const response=await app.inject({url,headers:headers(a)});
      assert.equal(response.statusCode,503); assert.equal(response.json().error.code,'PROVIDER_UNAVAILABLE');
    }
    f.useRole('gy_i05_test_runtime');
    assert.equal((await f.pool.query('SELECT current_user AS role')).rows[0].role,'gy_i05_test_runtime');
    const flags=(await f.pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.ok(Object.values(flags).every(value=>value===false));
    for (const sql of [
      'CREATE TABLE public.profile_forbidden(id int)', 'CREATE ROLE profile_forbidden_role',
      'DELETE FROM crops', 'DELETE FROM regions', 'DELETE FROM single_profiles',
      "UPDATE crops SET active=false", "UPDATE regions SET supported=false", "UPDATE regions SET catalog_version='forged'",
      'UPDATE single_profiles SET user_id=user_id', "UPDATE users SET state='suspended'", 'UPDATE users SET auth_epoch=auth_epoch+1',
      'SELECT wechat_subject_cipher FROM users', 'SELECT object_ref_cipher FROM media', 'SELECT object_id FROM exports',
    ]) await assert.rejects(f.pool.query(sql),error=>error.code==='42501',sql);
  });
  await t.test('all four endpoints reject guests; no database does not fake profile success', async () => {
    for (const url of [route,'/api/v1/catalog/crops','/api/v1/catalog/regions']) assert.equal((await app.inject({url})).statusCode,401);
    assert.equal((await app.inject({method:'PUT',url:route,payload:input})).statusCode,401);
    const stub = buildApp({config:loadConfig({APP_EXECUTION_MODE:'stub',LOG_LEVEL:'silent'})});
    const login = await stub.inject({method:'POST',url:'/api/v1/auth/wechat',headers:{'idempotency-key':'stub-login-0001'},payload:{code:'none'}});
    assert.equal((await stub.inject({url:route,headers:headers(login.json().data.access_token)})).statusCode,503);
    await stub.close();
  });
  await t.test('empty revision1; first PUT2; replay identical and cross-subject independent', async () => {
    const before = await app.inject({url:route,headers:headers(a)});
    assert.deepEqual(before.json().data,{crop_id:null,region_code:null,region_catalog_version:null,revision:1});
    assert.equal(before.headers.etag,'"1"'); assert.equal(before.headers['cache-control'],'no-store');
    const first = await put(a); assert.equal(first.statusCode,200,first.body); assert.equal(first.json().data.revision,2);
    assert.deepEqual((await put(a)).json().data,first.json().data);
    assert.equal((await put(a,{...input,crop_id:'crop_corn'})).json().error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal((await put(a,input,'profile-key-0002')).json().error.code,'REVISION_CONFLICT');
    assert.equal((await put(b)).json().data.revision,2);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM single_profiles')).rows[0].n,2);
  });
  await t.test('extra owner/role/coordinates, unsupported dictionary/version and missing headers rejected', async () => {
    for (const extra of [{owner_id:'someone'}, {user_id:'someone'}, {latitude:30,longitude:120},{role:'admin'}]) {
      assert.equal((await put(a,{...input,...extra},'invalid-key-0001','"2"')).statusCode,400);
    }
    for (const body of [{...input,crop_id:'unknown'}, {...input,region_code:'330999'},{...input,region_catalog_version:'old'},{...input,region_code:'440100'}]) {
      assert.equal((await put(a,body,'invalid-key-0002','"2"')).statusCode,400);
    }
    assert.equal((await app.inject({method:'PUT',url:route,headers:{...headers(a),'idempotency-key':'missing-version'},payload:input})).statusCode,428);
    assert.equal((await app.inject({method:'PUT',url:route,headers:{...headers(a),'if-match':'"2"'},payload:input})).json().error.code,'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal((await app.inject({url:`${route}?user_id=someone`,headers:headers(a)})).statusCode,400);
  });
  await t.test('actual loopback HTTP reads catalog and own profile; no token or owner in response', async () => {
    const base = await app.listen({host:'127.0.0.1',port:0});
    const response = await fetch(`${base}${route}`,{headers:headers(a)});
    assert.equal(response.status,200); assert.equal(response.headers.get('etag'),'"2"');
    const body = await response.json();
    assert.deepEqual(Object.keys(body.data).sort(),['crop_id','region_catalog_version','region_code','revision']);
    assert.equal(JSON.stringify(body).includes(a),false);
    const catalog = await fetch(`${base}/api/v1/catalog/regions?parent_code=330100`,{headers:headers(a)});
    assert.equal(catalog.status,200); assert.ok((await catalog.json()).data.items.length>0);
    assert.equal((await fetch(`${base}${route}`)).status,401);
  });
  await t.test('signed pagination binds user, filter, route, watermark and expiry', async () => {
    const first = await app.inject({url:'/api/v1/catalog/crops?limit=2',headers:headers(a)});
    assert.equal(first.statusCode,200,first.body); assert.equal(first.json().data.items.length,2);
    const cursor = first.json().data.next_cursor;
    const next = await app.inject({url:`/api/v1/catalog/crops?limit=2&cursor=${encodeURIComponent(cursor)}`,headers:headers(a)});
    assert.equal(next.json().data.items.length,2); assert.equal(next.json().data.next_cursor,null);
    assert.equal(new Set([...first.json().data.items,...next.json().data.items].map(x=>x.id)).size,4);
    for (const [token,url] of [[b,`/api/v1/catalog/crops?cursor=${cursor}`],[a,`/api/v1/catalog/regions?cursor=${cursor}`],[a,`/api/v1/catalog/crops?cursor=${cursor}x`]]) {
      assert.equal((await app.inject({url,headers:headers(token)})).json().error.code,'INVALID_CURSOR');
    }
    const city = await app.inject({url:'/api/v1/catalog/regions?parent_code=330100&limit=1',headers:headers(a)});
    assert.ok(city.json().data.items.every(x=>x.parent_code==='330100'));
    assert.equal((await app.inject({url:`/api/v1/catalog/regions?parent_code=330200&cursor=${city.json().data.next_cursor}`,headers:headers(a)})).json().error.code,'INVALID_CURSOR');
    await db.query("UPDATE crops SET active=false WHERE id='crop_corn'");
    assert.equal((await app.inject({url:`/api/v1/catalog/crops?cursor=${cursor}`,headers:headers(a)})).json().error.code,'INVALID_CURSOR');
    await db.query("UPDATE crops SET active=true WHERE id='crop_corn'");
    const originalNow = Date.now; Date.now = () => originalNow() + 16*60*1000;
    try { assert.equal((await app.inject({url:`/api/v1/catalog/crops?cursor=${cursor}`,headers:headers(a)})).json().error.code,'INVALID_CURSOR'); }
    finally { Date.now=originalNow; }
  });
  await t.test('same-key concurrent PUT once; different-key stale version loses; snapshot rows not rewritten', async () => {
    const author = (await db.query("INSERT INTO public_authors(display_name) VALUES('synthetic author') RETURNING id")).rows[0].id;
    const post = (await db.query('INSERT INTO posts(author_ref,current_revision) VALUES($1,1) RETURNING id',[author])).rows[0].id;
    await db.query("INSERT INTO post_versions(post_id,revision,title,body,crop_id,region_code) VALUES($1,1,'synthetic','snapshot','crop_rice','330102')",[post]);
    const snapshot = (await db.query('SELECT * FROM post_versions WHERE post_id=$1',[post])).rows;
    const results = await Promise.all([put(a,{...input,crop_id:'crop_corn'},'concurrent-same-key','"2"'),put(a,{...input,crop_id:'crop_corn'},'concurrent-same-key','"2"')]);
    assert.ok(results.every(r=>r.statusCode===200)); assert.ok(results.every(r=>r.json().data.revision===3));
    const races = await Promise.all([put(a,input,'concurrent-next-key-a','"3"'),put(a,{...input,crop_id:'crop_soybean'},'concurrent-next-key-b','"3"')]);
    assert.deepEqual(races.map(r=>r.statusCode).sort(),[200,409]);
    assert.equal((await app.inject({url:route,headers:headers(a)})).json().data.revision,4);
    assert.equal((await app.inject({url:route,headers:headers(b)})).json().data.revision,2);
    assert.deepEqual((await db.query('SELECT * FROM post_versions WHERE post_id=$1',[post])).rows,snapshot);
  });
  await t.test('transaction rechecks changed epoch and revoked session; logout blocks historical replay', async () => {
    const session = (await db.query("SELECT id,user_id,auth_epoch FROM sessions WHERE token_hash=decode($1,'hex')",[hashToken(a)])).rows[0];
    const identity={userId:session.user_id,authEpoch:Number(session.auth_epoch),sessionId:session.id,role:'user'};
    const service=createProfileService(f.pool,'test-hmac-key');
    await db.query('UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=$1',[session.user_id]);
    await assert.rejects(service.get({identity,token:a}),error=>error.code==='ACCOUNT_INACTIVE');
    await db.query('UPDATE users SET auth_epoch=auth_epoch-1 WHERE id=$1',[session.user_id]);
    await db.query("UPDATE users SET state='suspended' WHERE id=$1",[session.user_id]);
    await assert.rejects(service.get({identity,token:a}),error=>error.code==='ACCOUNT_INACTIVE');
    await db.query("UPDATE users SET state='active' WHERE id=$1",[session.user_id]);
    await db.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[session.id]);
    await assert.rejects(service.get({identity,token:a}),error=>error.code==='SESSION_EXPIRED');
    const logout=await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{...headers(b),'idempotency-key':'logout-profile-b'}});
    assert.equal(logout.statusCode,200,logout.body);
    assert.equal((await put(b)).statusCode,401);
  });
});
