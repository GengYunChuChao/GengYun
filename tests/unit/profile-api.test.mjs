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
  for (const kind of ['crops', 'regions']) await t.test(`${kind} actual HTTP chain expires at first 15min boundary after late pagination`, async () => {
    const originalNow = Date.now;
    const initial = originalNow();
    let now = initial;
    Date.now = () => now;
    try {
      const base = app.server.address();
      const path = `/api/v1/catalog/${kind}?limit=1${kind === 'regions' ? '&parent_code=330100' : ''}`;
      const readPage = async cursor => {
        const response = await fetch(`http://127.0.0.1:${base.port}${path}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, {headers:headers(a)});
        if (response.status === 200) assert.equal(response.headers.get('cache-control'),'no-store');
        return {status:response.status, body:await response.json()};
      };
      const first = await readPage();
      assert.equal(first.status,200); assert.ok(first.body.data.next_cursor);
      now = initial + 14*60*1000;
      const second = await readPage(first.body.data.next_cursor);
      assert.equal(second.status,200); assert.ok(second.body.data.next_cursor);
      now = initial + 15*60*1000 - 1;
      const stillValid = await readPage(second.body.data.next_cursor);
      assert.equal(stillValid.status,200);
      now += 1;
      const expired = await readPage(second.body.data.next_cursor);
      assert.equal(expired.status,400,'late second page must not extend the original chain');
      assert.equal(expired.body.error.code,'INVALID_CURSOR'); assert.equal(expired.body.data,undefined);
      const restart = await readPage();
      assert.equal(restart.status,200); assert.deepEqual(restart.body.data.items,first.body.data.items);
      const resumed = await readPage(restart.body.data.next_cursor);
      assert.equal(resumed.status,200); assert.deepEqual(resumed.body.data.items,second.body.data.items);
    } finally { Date.now = originalNow; }
  });
  await t.test('valid current epoch/session rejects old directory cursor but fresh chain works', async () => {
    const cursors = {};
    for (const kind of ['crops','regions']) cursors[kind] = (await app.inject({url:`/api/v1/catalog/${kind}?limit=1`,headers:headers(a)})).json().data.next_cursor;
    const session = (await db.query("SELECT id,user_id,auth_epoch FROM sessions WHERE token_hash=decode($1,'hex')",[hashToken(a)])).rows[0];
    await db.query('UPDATE users SET auth_epoch=auth_epoch+1 WHERE id=$1',[session.user_id]);
    await db.query('UPDATE sessions SET auth_epoch=auth_epoch+1 WHERE id=$1',[session.id]);
    try {
      for (const kind of ['crops','regions']) {
        const response = await app.inject({url:`/api/v1/catalog/${kind}?limit=1&cursor=${encodeURIComponent(cursors[kind])}`,headers:headers(a)});
        assert.equal(response.statusCode,400,'current valid session cannot resume prior epoch chain');
        assert.equal(response.json().error.code,'INVALID_CURSOR'); assert.equal(response.json().data,undefined);
        const fresh = await app.inject({url:`/api/v1/catalog/${kind}?limit=1`,headers:headers(a)});
        assert.equal(fresh.statusCode,200); assert.ok(fresh.json().data.next_cursor);
        assert.equal((await app.inject({url:`/api/v1/catalog/${kind}?limit=1&cursor=${encodeURIComponent(fresh.json().data.next_cursor)}`,headers:headers(a)})).statusCode,200);
      }
    } finally {
      await db.query('UPDATE sessions SET auth_epoch=$2 WHERE id=$1',[session.id,session.auth_epoch]);
      await db.query('UPDATE users SET auth_epoch=$2 WHERE id=$1',[session.user_id,session.auth_epoch]);
    }
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

// —— GY-I05 收尾（Refs #5）：每一条"应当拒绝"都有独立反例（negative control），
// 并且"判定"必须被下游真正消费：被拒的请求一条都不许落库、不许同时返回成功 data。
test('GY-I05 closeout: no session / other subject / self-reported identity / coordinates / extra fields / missing dictionary / revision conflict each rejected without writing', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const {app,db,a,b,headers,put} = f;
  const stored = async () => (await db.query('SELECT user_id,crop_id,region_code,region_catalog_version,revision FROM single_profiles ORDER BY user_id')).rows;
  assert.equal((await put(a)).statusCode,200);
  const baseline = await stored();
  assert.equal(baseline.length,1);
  assert.equal(baseline[0].revision,2);
  const controls = [];
  // 1. 无会话（游客）：读、目录、写都拒绝。
  for (const url of [route,'/api/v1/catalog/crops','/api/v1/catalog/regions']) controls.push(['guest GET '+url, await app.inject({url})]);
  controls.push(['guest PUT', await app.inject({method:'PUT',url:route,headers:{'idempotency-key':'closeout-guest-put','if-match':'"2"'},payload:{...input}})]);
  // 2. 客户端自报身份／指向他人档案：一律拒绝，不得被当作目标主体。
  for (const [index,extra] of [{user_id:'00000000-0000-0000-0000-000000000002'},{owner_id:'synthetic-other'},{role:'admin'},{profile_id:'synthetic-other'}].entries())
    controls.push(['self-reported identity '+JSON.stringify(extra), await put(a,{...input,...extra},'closeout-identity-'+index,'"2"')]);
  controls.push(['query user_id', await app.inject({url:`${route}?user_id=00000000-0000-0000-0000-000000000002`,headers:headers(a)})]);
  // 3. 坐标字段：请求体与查询串都必须拒绝，服务端不接收原始坐标。
  controls.push(['body coordinates', await put(a,{...input,latitude:30,longitude:120},'closeout-coordinates-body','"2"')]);
  for (const url of [`${route}?latitude=30&longitude=120`,'/api/v1/catalog/regions?latitude=30&longitude=120','/api/v1/catalog/crops?longitude=120']) controls.push(['query coordinates', await app.inject({url,headers:headers(a)})]);
  // 4. additionalProperties 多余字段（不含身份/坐标的普通多余字段）。
  controls.push(['extra field', await put(a,{...input,note:'synthetic'},'closeout-extra-field','"2"')]);
  // 5. 缺地区／缺作物／字典外字典版本。
  const missing = [{region_code:input.region_code,region_catalog_version:input.region_catalog_version},{crop_id:input.crop_id,region_catalog_version:input.region_catalog_version},{...input,crop_id:'crop_synthetic_unknown'},{...input,region_code:'330999'},{...input,region_code:'440100'},{...input,region_catalog_version:'forged-version'}];
  for (const [index,body] of missing.entries()) controls.push(['missing/unsupported '+JSON.stringify(body), await put(a,body,'closeout-dictionary-'+index,'"2"')]);
  // 6. revision 冲突。
  controls.push(['revision conflict', await put(a,input,'closeout-revision-conflict','"9"')]);
  for (const [label,response] of controls) {
    assert.ok([400,401,409,428].includes(response.statusCode), label+' -> '+response.statusCode+' '+response.body);
    const body = response.json();
    assert.equal(typeof (body.error && body.error.code),'string', label+' 缺少契约错误码');
    assert.equal(body.data,undefined, label+' 被拒绝却同时返回成功 data');
  }
  assert.deepEqual(await stored(),baseline,'被拒绝的请求改写了档案（判定未被下游消费）');
  assert.equal((await app.inject({url:route,headers:headers(a)})).json().data.revision,2);
  assert.equal((await app.inject({url:route,headers:headers(b)})).json().data.revision,1);
  assert.equal((await stored()).length,1,'另一个主体不应因他人请求产生档案行');
});

test('GY-I05 closeout: non-user session role is denied before any SQL, and profile edits never rewrite saved record tables (byte-identical)', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const {app,db,a,headers,put} = f;
  // 非 user 角色的会话（自报或被错误授予的角色）：服务层在事务内先拒绝。
  const session = (await db.query("SELECT id,user_id,auth_epoch FROM sessions WHERE token_hash=decode($1,'hex')",[hashToken(a)])).rows[0];
  const service = createProfileService(f.pool,'test-hmac-key');
  for (const role of ['admin','guest','service','']) {
    const identity = {userId:session.user_id,authEpoch:Number(session.auth_epoch),sessionId:session.id,role};
    await assert.rejects(service.get({identity,token:a}), error => error.code === 'SCOPE_DENIED', 'role='+role+' GET');
    await assert.rejects(service.put({identity,token:a},input,'"1"','closeout-role-'+role), error => error.code === 'SCOPE_DENIED', 'role='+role+' PUT');
  }
  // 他人会话 id 不能借用主体身份读取档案。
  await assert.rejects(service.get({identity:{userId:session.user_id,authEpoch:Number(session.auth_epoch),sessionId:'00000000-0000-0000-0000-000000000009',role:'user'},token:a}), error => error.code === 'SESSION_EXPIRED');

  // 改档案前后：除 single_profiles / idempotency_keys 外，所有已保存记录表逐字节不变。
  const author = (await db.query("INSERT INTO public_authors(display_name) VALUES('synthetic closeout author') RETURNING id")).rows[0].id;
  const post = (await db.query('INSERT INTO posts(author_ref,current_revision) VALUES($1,1) RETURNING id',[author])).rows[0].id;
  await db.query("INSERT INTO post_versions(post_id,revision,title,body,crop_id,region_code) VALUES($1,1,'synthetic','snapshot','crop_rice','330102')",[post]);
  const immutableTables = async () => {
    const names = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).rows.map(row => row.table_name).filter(name => !['single_profiles','idempotency_keys'].includes(name));
    const dump = [];
    for (const name of names) dump.push([name, (await db.query(`SELECT * FROM public."${name}"`)).rows.map(row => JSON.stringify(row)).sort()]);
    return JSON.stringify(dump);
  };
  const records = (await db.query('SELECT * FROM post_versions WHERE post_id=$1',[post])).rows.map(row => JSON.stringify(row)).sort();
  const before = await immutableTables();
  assert.equal((await put(a)).statusCode,200);
  assert.equal((await put(a,{...input,region_code:'330100'},'closeout-rewrite-region','"2"')).statusCode,200);
  assert.equal((await put(a,{...input,crop_id:'crop_corn',region_code:'330100'},'closeout-rewrite-crop','"3"')).statusCode,200);
  assert.deepEqual((await db.query('SELECT * FROM post_versions WHERE post_id=$1',[post])).rows.map(row => JSON.stringify(row)).sort(),records,'已保存识别/来源记录快照被改写');
  assert.equal(await immutableTables(),before,'改档案改写了档案之外的表');
  const profile = (await db.query('SELECT crop_id,region_code,revision FROM single_profiles WHERE user_id=$1::uuid',[session.user_id])).rows[0];
  assert.equal(profile.revision,4,'正向对照：档案本身确实被改写');
  assert.equal(profile.region_code,'330100');
  // 服务端任何表都没有坐标列，档案不接收也不持久化原始坐标。
  const coordinates = (await db.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND column_name ~* '^(latitude|longitude|lat|lng|lon|coords?|geocode|geohash|location)$'")).rows;
  assert.deepEqual(coordinates,[],'存在疑似坐标列');
  assert.equal((await app.inject({url:route,headers:headers(a)})).json().data.revision,4);
});

// —— GY-I05（#5）：错误码与契约闭集一致（前后端一致性 · 服务端侧）。
// 断言对象是 **packages/contracts/states.json 的 error_status_map**（契约闭集），不是手写清单；
// 同时把该闭集与 openapi.json 的 ErrorCode 枚举对齐，确保没有第二份"自己维护"的错误码表。
const contractStates = JSON.parse(read('packages/contracts/states.json'));
const contractOpenapi = JSON.parse(read('packages/contracts/openapi.json'));
const CONTRACT_STATUS = Object.fromEntries(Object.entries(contractStates.error_status_map)
  .flatMap(([status, codes]) => codes.map(code => [code, Number(status)])));
const CONTRACT_CODES = new Set(Object.values(contractStates.error_status_map).flat());

test('GY-I05: profile/catalog 端点只返回契约闭集内的错误码，且状态码与契约逐项一致', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const {app, db, a, b, headers, put} = f;
  assert.deepEqual([...CONTRACT_CODES].sort(), [...contractOpenapi.components.schemas.ErrorCode.enum].sort(),
    'states.error_status_map 与 openapi ErrorCode 枚举必须一致');

  const observed = [];
  const record = (label, response) => {
    const body = response.json();
    observed.push([label, response.statusCode, body.error && body.error.code, body.data]);
    return response;
  };
  // 无会话（游客）与失效会话。
  for (const url of [route, '/api/v1/catalog/crops', '/api/v1/catalog/regions']) record('guest GET ' + url, await app.inject({url}));
  record('guest PUT', await app.inject({method:'PUT',url:route,headers:{'idempotency-key':'err-guest-put','if-match':'"1"'},payload:input}));
  const logout = await app.inject({method:'POST',url:'/api/v1/auth/logout',headers:{...headers(b),'idempotency-key':'err-logout-b'}});
  assert.equal(logout.statusCode,200,logout.body);
  record('revoked session GET', await app.inject({url:route,headers:headers(b)}));
  record('revoked session PUT', await app.inject({method:'PUT',url:route,headers:{...headers(b),'idempotency-key':'err-revoked-put','if-match':'"1"'},payload:input}));
  // 头部缺失与版本冲突。
  record('no if-match', await app.inject({method:'PUT',url:route,headers:{...headers(a),'idempotency-key':'err-no-ifmatch'},payload:input}));
  record('no idempotency-key', await app.inject({method:'PUT',url:route,headers:{...headers(a),'if-match':'"1"'},payload:input}));
  assert.equal((await put(a)).statusCode,200,'首次保存应成功（revision 2）');
  record('stale if-match', await put(a,input,'err-stale','"9"'));
  record('same key different body', await put(a,{...input,crop_id:'crop_corn'},'profile-key-0001','"2"'));
  // schema 校验失败（查询串与请求体各一条）与失效游标。
  record('query validation', await app.inject({url:`${route}?latitude=30&longitude=120`,headers:headers(a)}));
  record('body validation', await put(a,{...input,note:'x'},'err-body','"2"'));
  record('invalid cursor', await app.inject({url:'/api/v1/catalog/crops?cursor=not-a-real-cursor',headers:headers(a)}));
  // 无数据库：档案端点按契约 503（不伪造空档案成功）。
  const stub = buildApp({config:loadConfig({APP_EXECUTION_MODE:'stub',LOG_LEVEL:'silent'})});
  const stubLogin = await stub.inject({method:'POST',url:'/api/v1/auth/wechat',headers:{'idempotency-key':'err-stub-login'},payload:{code:'none'}});
  const stubToken = stubLogin.json().data.access_token;
  record('no database GET', await stub.inject({url:route,headers:headers(stubToken)}));
  record('no database PUT', await stub.inject({method:'PUT',url:route,headers:{...headers(stubToken),'idempotency-key':'err-stub-put','if-match':'"1"'},payload:input}));
  await stub.close();

  const seen = new Set();
  for (const [label, status, code, data] of observed) {
    assert.equal(typeof code,'string',`${label} 没有契约错误码（body=${JSON.stringify(data)}）`);
    assert.ok(CONTRACT_CODES.has(code),`${label} 返回契约外错误码：${code}`);
    assert.equal(status,CONTRACT_STATUS[code],`${label} 的错误码 ${code} 与契约状态码不一致`);
    assert.equal(data,undefined,`${label} 被拒绝却同时返回成功 data`);
    seen.add(code);
  }
  // 覆盖面守卫：本片真正触达的错误码必须都被观察到（防止断言对象是个空集）。
  for (const code of ['SESSION_REQUIRED','REVISION_REQUIRED','IDEMPOTENCY_KEY_REQUIRED','REVISION_CONFLICT',
    'IDEMPOTENCY_CONFLICT','INVALID_REQUEST','INVALID_CURSOR','PROVIDER_UNAVAILABLE']) {
    assert.ok(seen.has(code),`本片应触达的错误码没有被覆盖：${code}`);
  }
  assert.equal((await app.inject({url:route,headers:headers(a)})).json().data.revision,2,'被拒请求不得改写档案');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM single_profiles')).rows[0].n,1);
});

// ---------------------------------------------------------------- 可重试口径（GY-R31 / #7）

/**
 * **负臂**（独立成例，便于证明"改动前后都绿"）：确定性数据库错误不随正臂一起放开，
 * 即便同一断言表在"改前"状态下会先撞正臂失败，这一例仍必须单独通过。
 */
test('可重试口径·负臂：权限/表缺失/库不存在/凭据/未知码/无 code ⇒ retryable:false（两种状态下都必须绿）', async () => {
  const serviceFor = code => createProfileService({
    async connect() {
      throw code === undefined ? new Error('synthetic profile failure') : Object.assign(new Error('synthetic profile failure'), { code });
    },
  }, 'synthetic-profile-hmac-key');
  const identity = {
    identity: {
      role: 'user',
      userId: '00000000-0000-4000-8000-000000000001',
      authEpoch: 1,
      sessionId: '00000000-0000-4000-8000-000000000002',
    },
    token: 'synthetic-token',
  };
  for (const code of ['42501', '42P01', '3D000', '28P01', 'XX000', undefined]) {
    const label = String(code);
    await assert.rejects(serviceFor(code).get(identity), error => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE', label);
      assert.equal(error.status, 503, `${label} 必须保持既有状态码口径`);
      assert.equal(error.retryable, false, `${label} 是确定性故障，不得谎称可重试`);
      return true;
    });
  }
});

/**
 * 档案库故障的 `retryable` 分档 —— **状态码口径不变**。
 *
 * 判据唯一出处是 `services/api/src/db/pool.ts` 的 `isTransientDatabaseError()`；状态码仍由 `contract.ts` 决定。
 * 正臂（瞬时，时间能解决）：`57014`/`55P03` ⇒ 504 `PROVIDER_TIMEOUT` 且可重试；
 * `08xxx`/`40001`/`40P01`/驱动码 `ECONNREFUSED` ⇒ 503 `PROVIDER_UNAVAILABLE` 且可重试。
 * 负臂（确定性，需运维介入）：`42501`/`42P01`/`3D000`/`28P01`/`XX000`/无 `code` ⇒ 503 且 **不可重试**。
 *
 * 用「连接池直接抛码」构造：`transaction()` 的 catch-all 只读 `error.code`，不需要真库。
 */
test('档案库瞬时故障 ⇒ retryable:true；权限/表缺失/库不存在/凭据/未知码 ⇒ false（状态码不变）', async () => {
  const serviceFor = code => createProfileService({
    async connect() {
      throw code === undefined ? new Error('synthetic profile failure') : Object.assign(new Error('synthetic profile failure'), { code });
    },
  }, 'synthetic-profile-hmac-key');
  const identity = {
    identity: {
      role: 'user',
      userId: '00000000-0000-4000-8000-000000000001',
      authEpoch: 1,
      sessionId: '00000000-0000-4000-8000-000000000002',
    },
    token: 'synthetic-token',
  };
  const cases = [
    ['57014', 'PROVIDER_TIMEOUT', 504, true],
    ['55P03', 'PROVIDER_TIMEOUT', 504, true],
    ['08006', 'PROVIDER_UNAVAILABLE', 503, true],
    ['40001', 'PROVIDER_UNAVAILABLE', 503, true],
    ['40P01', 'PROVIDER_UNAVAILABLE', 503, true],
    ['ECONNREFUSED', 'PROVIDER_UNAVAILABLE', 503, true],
    ['42501', 'PROVIDER_UNAVAILABLE', 503, false],
    ['42P01', 'PROVIDER_UNAVAILABLE', 503, false],
    ['3D000', 'PROVIDER_UNAVAILABLE', 503, false],
    ['28P01', 'PROVIDER_UNAVAILABLE', 503, false],
    ['XX000', 'PROVIDER_UNAVAILABLE', 503, false],
    [undefined, 'PROVIDER_UNAVAILABLE', 503, false],
  ];
  for (const [code, expectedCode, expectedStatus, retryable] of cases) {
    const label = String(code);
    await assert.rejects(serviceFor(code).get(identity), error => {
      assert.equal(error.name, 'ApiError', label);
      assert.equal(error.code, expectedCode, label);
      assert.equal(error.status, expectedStatus, `${label} 必须保持既有状态码口径`);
      assert.equal(error.retryable, retryable, `${label} 的 retryable 必须由瞬时判定给出`);
      return true;
    });
  }
});

// ---------------------------------------------------------------- 手选不依赖定位（GY-R90 / #5）

/**
 * **AC**：「定位仅即时选择地区，服务端不接收原始坐标；拒绝／取消／超时／省外与手选能继续」。
 *
 * 这一条在代码上本来就有防线（`routes/profile.ts` 的 body 与 querystring 都是 `additionalProperties:false`，
 * `region_code` 带 `^33[0-9]{4}$` 的 pattern）。既有用例只断言「状态码 ∈ {400,401,409,428} 且错误码是字符串」，
 * 于是两道防线被钉住的程度并不一样（2026-11-08 逐条实测，读数见 PR 的变异自证）：
 *   · 把 body 的 `additionalProperties` 改成 `true`：既有用例红 5 条（它们塞多余字段并期望 400，却收到 200），
 *     这道防线本来就有人看着；
 *   · 删掉 `region_code` 的 pattern：既有 17 条**全绿** —— 省外码退化成服务层字典校验，仍是
 *     400 `INVALID_REQUEST`，只是 `details` 从「精确到 `/region_code`」变成空数组。**这一段此前没有任何断言钉住。**
 * 本用例把两道防线的**契约形状**都钉死，使上述两种变异各自在下面对应的断言上转红。
 *
 * 本用例钉四件事：
 *   ① 坐标字段（`latitude`／`longitude`／`lng`／`coordinates`／嵌套 `location`）进 body ⇒ 400，且封套 `details`
 *      **逐字**等于 `[{field:'/', code:'must NOT have additional properties'}]`；query 串（读面与两个目录面）同理。
 *      ⚠ 实测：根级违例的 ajv `instancePath` 是空串，`app.ts` 的错误映射只取 `instancePath` ⇒ 封套里 `field` 是 `/`，
 *      **不点名字段**。所以本用例不冒充「details[0].field 指向该字段」——那是契约没做到的事；判别力改在 ④
 *      用同一份契约 + 同一个运行期校验器取 `params.additionalProperty` 来钉。
 *   ② 省外／形状不符的地区码 ⇒ 400，且 `details` 逐字等于
 *      `[{field:'/region_code', code:'must match pattern "^33[0-9]{4}$"'}]`；省内但不存在的码（`330999`）走服务层
 *      字典校验，同样 400 但 `details: []` —— 这两者可区分，正是「删掉 pattern 就转红」的分辨率所在
 *      （只断言状态码的话两臂都是 400，等于没钉住）。
 *   ③ 正例：**零坐标输入**，只传 `crop_id`／`region_code`／`region_catalog_version` ⇒ 200；响应任意层级都没有坐标键，
 *      落库那行只有契约列，档案表也没有坐标列；换地区码（手选）同样成立 ⇒ 手选不依赖定位。
 *   ④ 判别力自证：`schema-validator.ts` 的 `createJsonSchema2020ValidatorCompiler()` 编译契约里的 `ProfileInput`，
 *      `validate.errors[0].params.additionalProperty` 必须精确等于被塞进去的那个键。
 *
 * ⛔ 本用例**不**证明真机四路径（授权／拒绝／取消／超时），只证明契约拒收坐标与服务端不落坐标。
 */
const COORDINATE_KEY = /^(?:latitude|longitude|lat|lng|lon|coords?|coordinates?|geocode|geohash|location)$/i;
/** 递归找出任意层级上的坐标键，返回 `$.data.latitude` 形状的路径（空数组 = 一处都没有）。 */
const coordinateKeys = (value, at = '$', found = []) => {
  if (Array.isArray(value)) value.forEach((item, index) => coordinateKeys(item, `${at}[${index}]`, found));
  else if (value !== null && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (COORDINATE_KEY.test(key)) found.push(`${at}.${key}`);
      coordinateKeys(item, `${at}.${key}`, found);
    }
  return found;
};

test('GY-R90 / #5 手选不依赖定位：坐标字段是契约外属性必被拒且零落库，省外地区码被拒，只给地区码即成功且响应无坐标', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const { app, db, a, headers, put } = f;
  const revision = async () => (await app.inject({ url: route, headers: headers(a) })).json().data.revision;
  const profileRows = async () => (await db.query(
    'SELECT crop_id, region_code, region_catalog_version, revision FROM single_profiles ORDER BY region_code')).rows;

  // ④-预备：契约 artifact 自己先钉闭集 —— 输入/输出两个 schema 都闭集，属性名里没有坐标位。
  const profileInput = contractOpenapi.components.schemas.ProfileInput;
  const profileOut = contractOpenapi.components.schemas.Profile;
  assert.equal(profileInput.additionalProperties, false, '契约 ProfileInput 必须闭集，否则坐标字段在契约上就是合法的');
  assert.equal(profileOut.additionalProperties, false, '契约 Profile 必须闭集，否则响应可以夹带坐标');
  assert.deepEqual(Object.keys(profileInput.properties).sort(), ['crop_id', 'region_catalog_version', 'region_code']);
  assert.deepEqual(Object.keys(profileOut.properties).sort(), ['crop_id', 'region_catalog_version', 'region_code', 'revision']);
  assert.equal(profileInput.properties.region_code.pattern, '^33[0-9]{4}$', '契约的地区码只认浙江（33 开头）');
  assert.deepEqual(coordinateKeys(profileInput.properties), [], '档案输入契约出现坐标属性');
  assert.deepEqual(coordinateKeys(profileOut.properties), [], '档案输出契约出现坐标属性');

  // 空档案 revision=1 是起点；下面所有被拒请求都不得改写它，也不得落库。
  assert.equal(await revision(), 1, '空档案 revision 必须是 1');

  // ① 坐标进 body：闭集外属性必须被 schema 拒，且错误封套形状逐字钉住。
  const coordinateBodies = [
    ['经纬度齐全', { latitude: 30.28, longitude: 120.15 }],
    ['只给纬度', { latitude: 30.28 }],
    ['只给经度', { longitude: 120.15 }],
    ['lng 别名', { lng: 120.15 }],
    ['坐标数组', { coordinates: [30.28, 120.15] }],
    ['嵌套定位对象', { location: { lat: 30.28, lng: 120.15 } }],
  ];
  for (const [index, [label, extra]] of coordinateBodies.entries()) {
    const response = await put(a, { ...input, ...extra }, `r90-coordinate-${index}`, '"1"');
    assert.equal(response.statusCode, 400, `${label}：坐标必须在 schema 层被拒（实际 ${response.statusCode} ${response.body}）`);
    const body = response.json();
    assert.equal(body.data, undefined, `${label}：被拒绝却同时返回成功 data`);
    assert.equal(body.error.code, 'INVALID_REQUEST', label);
    assert.equal(body.error.message, '请求校验失败', label);
    assert.deepEqual(body.error.details, [{ field: '/', code: 'must NOT have additional properties' }],
      `${label}：additionalProperties 违例的封套形状（根级 instancePath 为空 ⇒ field 是 /，不点名字段）`);
  }
  // 读面与两个目录面同样拒收坐标（querystring 也是闭集）。
  for (const url of [`${route}?latitude=30&longitude=120`, `${route}?lat=30&lng=120`,
    '/api/v1/catalog/crops?latitude=30', '/api/v1/catalog/regions?lng=120']) {
    const response = await app.inject({ url, headers: headers(a) });
    assert.equal(response.statusCode, 400, `${url}：query 串带坐标必须被拒（实际 ${response.statusCode} ${response.body}）`);
    const body = response.json();
    assert.equal(body.data, undefined, url);
    assert.equal(body.error.code, 'INVALID_REQUEST', url);
    assert.equal(body.error.message, '请求校验失败', url);
    assert.deepEqual(body.error.details, [{ field: '/', code: 'must NOT have additional properties' }],
      `${url}：query 串的 additionalProperties 封套形状`);
  }

  // ② 省外／形状不符的地区码：pattern 层拒并给出精确到字段的明细。
  for (const [label, code] of [['广东', '440100'], ['北京', '110101'], ['江苏', '320102'],
    ['位数不足', '33010'], ['位数超出', '3301000']]) {
    const response = await put(a, { ...input, region_code: code }, `r90-region-${code}`, '"1"');
    assert.equal(response.statusCode, 400, `${label} ${code}：省外/形状不符的地区码必须被拒（实际 ${response.statusCode} ${response.body}）`);
    const body = response.json();
    assert.equal(body.data, undefined, code);
    assert.equal(body.error.code, 'INVALID_REQUEST', code);
    assert.deepEqual(body.error.details, [{ field: '/region_code', code: 'must match pattern "^33[0-9]{4}$"' }],
      `${label} ${code}：地区码必须由 schema 的 pattern 拒（明细精确到 /region_code）`);
  }
  // 对照臂：省内但不存在的码走服务层字典校验 —— 仍是 400，但**没有**字段明细。
  // 这是 ② 的分辨率：删掉 pattern 后省外码会退化成这一臂的形状，故 ② 必须逐字断言 details。
  const dictionaryMiss = await put(a, { ...input, region_code: '330999' }, 'r90-region-dictionary', '"1"');
  assert.equal(dictionaryMiss.statusCode, 400, '省内但不存在的地区码仍必须 400');
  assert.equal(dictionaryMiss.json().error.code, 'INVALID_REQUEST');
  assert.deepEqual(dictionaryMiss.json().error.details, [],
    '字典层拒绝没有字段明细；如果这里也有明细，② 就失去分辨率（变异后无法转红）');

  // 被拒的坐标/省外请求一条都没落库。
  assert.deepEqual(await profileRows(), [], '被拒的坐标请求不得落库');
  assert.equal(await revision(), 1, '被拒请求不得改写档案 revision');

  // ③ 正例：零坐标输入，只三字段 ⇒ 成功；响应任意层级都没有坐标键。
  const created = await put(a, input, 'r90-manual-only', '"1"');
  assert.equal(created.statusCode, 200, `只传地区码的手选必须成功（实际 ${created.statusCode} ${created.body}）`);
  assert.equal(created.json().data.revision, 2, '手选保存必须把 revision 推到 2');
  assert.deepEqual(Object.keys(created.json().data).sort(), ['crop_id', 'region_catalog_version', 'region_code', 'revision'],
    '手选成功响应的 data 只能有契约里那四栏');
  assert.deepEqual(coordinateKeys(created.json()), [], '手选成功响应出现坐标键');
  assert.equal(JSON.stringify(created.json()).includes('latitude'), false, '手选成功响应夹带 latitude');
  assert.equal(JSON.stringify(created.json()).includes('longitude'), false, '手选成功响应夹带 longitude');

  // 手选换地区码同样不依赖定位。
  const changed = await put(a, { ...input, region_code: '330100' }, 'r90-manual-change', '"2"');
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().data.region_code, '330100', '手选换地区必须生效');
  assert.equal(changed.json().data.revision, 3, '手选换地区必须自增 revision');
  const readBack = await app.inject({ url: route, headers: headers(a) });
  assert.equal(readBack.statusCode, 200, readBack.body);
  assert.deepEqual(Object.keys(readBack.json().data).sort(), ['crop_id', 'region_catalog_version', 'region_code', 'revision']);
  assert.deepEqual(coordinateKeys(readBack.json()), [], '读档案响应出现坐标键');

  // 服务端不落坐标：落库那行只有契约列，档案表也没有任何坐标列。
  assert.deepEqual(await profileRows(),
    [{ crop_id: 'crop_rice', region_code: '330100', region_catalog_version: 'mca-xzqh-2023', revision: 3 }],
    '手选落库那行必须是三字段 + revision，不带坐标');
  const coordinateColumns = (await db.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'single_profiles'"
    + " AND column_name ~* '^(latitude|longitude|lat|lng|lon|coords?|coordinates?|geocode|geohash|location)$'")).rows;
  assert.deepEqual(coordinateColumns, [], '档案表出现坐标列 —— 服务端开始存原始定位');

  // ④ 判别力在 schema 层：用运行期**同一个**校验器编译契约里的 ProfileInput，违例必须点名字段。
  const { createJsonSchema2020ValidatorCompiler } = await import('../../services/api/src/schema-validator.ts');
  const validate = createJsonSchema2020ValidatorCompiler()({ schema: profileInput });
  assert.equal(validate(input), true, '合法三字段必须通过同一份契约校验器（否则上面的 400 可能全是别的错）');
  for (const key of ['latitude', 'longitude']) {
    assert.equal(validate({ ...input, [key]: 30.28 }), false, `${key} 必须被判为契约外属性`);
    assert.equal(validate.errors.length, 1, `${key}：allErrors:false ⇒ 只报一条`);
    assert.equal(validate.errors[0].keyword, 'additionalProperties', key);
    assert.equal(validate.errors[0].params.additionalProperty, key, `${key}：判别力必须精确点名该字段`);
  }
});
