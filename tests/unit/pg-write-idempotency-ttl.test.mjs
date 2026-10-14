import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';
import { hashToken } from '../../services/api/src/auth/tokens.ts';
import { idempotencyScope, idempotencyKeyHashHex } from '../../services/api/src/auth/idempotency.ts';

const read = path => readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const profile = {crop_id:'crop_rice',region_code:'330102',region_catalog_version:'mca-xzqh-2023'};
const consent = {purpose:'recording',policy_version:'fixture-v1',recipient_ids:[]};
async function fixture() {
  let engine, nativePool, queue=Promise.resolve();
  const native=process.env.GY_PG_WRITE_TTL_TEST_URL;
  if(native) {
    const url=new URL(native);
    assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.search,'');
    assert.match(url.pathname,/^\/gy_pg_write_ttl_test_[a-z0-9_]+$/);
    assert.match(url.username,/^gy_pg_write_ttl_test_[a-z0-9_]+$/);
    nativePool=new pg.Pool({connectionString:url.href,max:6,statement_timeout:6000});
    assert.equal((await nativePool.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n,0,'fresh dedicated local database only');
    engine={query:(...args)=>nativePool.query(...args),exec:sql=>nativePool.query(sql)};
  } else engine=new PGlite();
  async function acquire() {const before=queue;let done;queue=new Promise(resolve=>{done=resolve});await before;return done;}
  for(const name of ['0001_initial_schema','0002_knowledge_catalog','0003_privacy_consent','0008_auth_session','0009_consent_policy'])await engine.exec(read('services/api/db/migrations/'+name+'.sql'));
  for(const file of ['auth_privacy','profile_runtime','consent_granter'])await engine.exec(read('services/api/db/roles/'+file+'.sql'));
  await engine.exec('CREATE ROLE gy_pg_write_ttl_runtime NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT gengyun_auth_privacy,gengyun_profile_runtime,gengyun_consent_granter TO gy_pg_write_ttl_runtime');
  for(const row of JSON.parse(read('packages/knowledge/catalog/crops.json')).crops)await engine.query('INSERT INTO crops(id,name,active) VALUES($1,$2,true)',[row.id,row.name]);
  for(const row of JSON.parse(read('packages/knowledge/catalog/regions-zhejiang.json')).regions)await engine.query('INSERT INTO regions(code,name,parent_code,catalog_version,supported) VALUES($1,$2,$3,$4,true)',[row.code,row.name,row.parent_code,row.catalog_version]);
  const reviewer=(await engine.query("INSERT INTO admin_accounts(login_name,credential_hash) VALUES('fixture-reviewer','synthetic-unused') RETURNING id")).rows[0].id;
  await engine.query(`INSERT INTO consent_policies(purpose,policy_version,source_kind,source_ref,content_sha256,review_evidence_ref,valid_from,valid_until,reviewed_by,reviewed_at,enabled)
    VALUES('recording','fixture-v1','synthetic','fixture://ttl/policy',$1,'fixture://ttl/review',clock_timestamp()-interval '1 day',clock_timestamp()+interval '2 days',$2,clock_timestamp()-interval '1 hour',true)`,['a'.repeat(64),reviewer]);
  const pool={
    async connect() {
      const unlock=native?()=>{}:await acquire();
      const client=native?await nativePool.connect():{query:(...args)=>engine.query(...args),release(){}};
      try{await client.query('SET ROLE gy_pg_write_ttl_runtime');}catch(error){client.release();unlock();throw error;}
      return {query:(...args)=>client.query(...args),release(){client.query('RESET ROLE').finally(()=>{client.release();unlock();});}};
    },
    async query(...args){const c=await this.connect();try{return await c.query(...args);}finally{c.release();}},
  };
  const owner=async(...args)=>{const unlock=native?()=>{}:await acquire();try{return await engine.query(...args);}finally{unlock();}};
  const config=loadConfig({APP_EXECUTION_MODE:'stub',LOG_LEVEL:'silent'});
  const app=buildApp({config,pool,consentGrantTestOptions:{allowSyntheticGrantPolicy:true}});
  await app.listen({host:'127.0.0.1',port:0});
  const base=app.listeningOrigin+'/api/v1';
  async function http(path,user,method='GET',body,key,revision) {
    const response=await fetch(base+path,{method,headers:{...(user?{authorization:'Bearer '+user.token}:{}),...(key?{'idempotency-key':key}:{}),...(revision?{'if-match':revision}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const result={status:response.status,body:await response.json()};
    assert.equal(result.body.meta.execution_mode,'stub');return result;
  }
  async function user(name) {
    const r=await http('/auth/wechat',null,'POST',{code:'ttl-'+name},'ttl-login-'+name);assert.equal(r.status,200);
    const token=r.body.data.access_token;
    const row=(await owner("SELECT user_id,id FROM sessions WHERE token_hash=decode($1,'hex')",[hashToken(token)])).rows[0];
    return {id:row.user_id,sessionId:row.id,token};
  }
  function receiptKey(u,method,path,key){const scope=idempotencyScope(u.id,method,path);return [scope,idempotencyKeyHashHex(scope,key)];}
  async function receipt(u,method,path,key) {
    const rows=(await owner("SELECT id,outcome,expires_at::text expires,EXTRACT(EPOCH FROM expires_at-clock_timestamp())::float8 remaining FROM idempotency_keys WHERE scope=$1 AND key_hash=decode($2,'hex')",receiptKey(u,method,path,key))).rows;
    assert.equal(rows.length,1);return rows[0];
  }
  const age=(u,method,path,key,minutes=6)=>owner("UPDATE idempotency_keys SET created_at=created_at-($3::integer*interval '1 minute'),expires_at=expires_at-($3::integer*interval '1 minute') WHERE scope=$1 AND key_hash=decode($2,'hex')",[...receiptKey(u,method,path,key),minutes]);
  const expire=(u,method,path,key)=>owner("UPDATE idempotency_keys SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp() WHERE scope=$1 AND key_hash=decode($2,'hex')",receiptKey(u,method,path,key));
  const put=(u,key,body=profile,revision='"1"')=>http('/me/profile',u,'PUT',body,key,revision);
  const grant=(u,key,body=consent)=>http('/me/consents',u,'POST',body,key);
  const withdraw=(u,key,revision)=>http('/me/consents/recording',u,'DELETE',undefined,key,revision);
  const withinDay=r=>assert.ok(r.remaining>86390&&r.remaining<=86410,`expected new 24h receipt; actual remaining ${r.remaining}`);
  const rejected=(r,status,code)=>{assert.equal(r.status,status,JSON.stringify(r.body));assert.equal(r.body.error.code,code);assert.equal(r.body.data,undefined);};
  return {pool,owner,http,user,receipt,age,expire,put,grant,withdraw,withinDay,rejected,async close(){await app.close();await queue;if(native)await nativePool.end();else await engine.close();}};
}

test('PG profile/grant/withdraw ordinary receipts keep 24h over real product HTTP (synthetic only)',async t=>{
  const f=await fixture();t.after(()=>f.close());
  const {user,put,grant,withdraw,receipt,age,expire,owner,rejected,withinDay}=f;
  await t.test('runtime cannot change expiry, authority, account state or create roles',async()=>{
    const flags=(await f.pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.ok(Object.values(flags).every(value=>value===false));
    for(const sql of ['UPDATE idempotency_keys SET expires_at=clock_timestamp()','UPDATE consent_policies SET enabled=false',"UPDATE users SET state='suspended'",'CREATE ROLE forbidden_ttl_role'])await assert.rejects(f.pool.query(sql),e=>e.code==='42501');
  });
  for(const kind of ['profile','grant','withdraw']) {
    const method=kind==='profile'?'PUT':kind==='grant'?'POST':'DELETE';
    const path=kind==='profile'?'/me/profile':kind==='grant'?'/me/consents':'/me/consents/recording';
    async function create(u,key) {
      if(kind==='profile')return put(u,key);
      if(kind==='grant')return grant(u,key);
      const given=await grant(u,key+'-setup');assert.equal(given.status,201);return withdraw(u,key,'"'+given.body.data.revision+'"');
    }
    const replay=(u,key)=>kind==='profile'?put(u,key):kind==='grant'?grant(u,key):withdraw(u,key,'"2"');
    await t.test(kind+' new receipt retains a full 24h',async()=>{
      const u=await user(kind+'-duration'),key='ttl-duration-'+kind;
      const r=await create(u,key);assert.equal(r.status,kind==='grant'?201:200);withinDay(await receipt(u,method,path,key));
    });
    await t.test(kind+' six-minute retry replays one result without sliding or accepting a changed request',async()=>{
      const u=await user(kind+'-age'),key='ttl-age-'+kind;
      const first=await create(u,key);assert.equal(first.status,kind==='grant'?201:200);
      await age(u,method,path,key);const before=await receipt(u,method,path,key);
      const again=await replay(u,key);assert.equal(again.status,first.status);assert.deepEqual(again.body.data,first.body.data);
      assert.equal((await receipt(u,method,path,key)).expires,before.expires);
      const changed=kind==='profile'?await put(u,key,{...profile,crop_id:'crop_corn'}):kind==='grant'?await grant(u,key,{...consent,policy_version:'different'}):await withdraw(u,key,'"999"');
      rejected(changed,409,'IDEMPOTENCY_CONFLICT');
      assert.equal((await receipt(u,method,path,key)).expires,before.expires);
      await age(u,method,path,key,1433);const nearEnd=await receipt(u,method,path,key);
      const late=await replay(u,key);assert.equal(late.status,first.status);assert.deepEqual(late.body.data,first.body.data);
      assert.equal((await receipt(u,method,path,key)).expires,nearEnd.expires,'23h59m replay must not renew receipt');
    });
    await t.test(kind+' expired receipt follows current state/version and new receipt starts a full day',async()=>{
      const u=await user(kind+'-expire'),key='ttl-expire-'+kind;
      const first=await create(u,key);assert.equal(first.status,kind==='grant'?201:200);
      const before=await receipt(u,method,path,key);await expire(u,method,path,key);
      let next;
      if(kind==='grant') {
        next=await grant(u,key);assert.equal(next.status,201);assert.notEqual(next.body.data.id,first.body.data.id);assert.equal(next.body.data.epoch,first.body.data.epoch+1);
      } else {
        rejected(await replay(u,key),409,'REVISION_CONFLICT');
        assert.equal((await receipt(u,method,path,key)).id,before.id,'failed retry rolls back cleanup, does not record a new success');
        next=kind==='profile'?await put(u,key,profile,'"2"'):await withdraw(u,key,'"3"');assert.equal(next.status,200);
        if(kind==='profile')assert.equal(next.body.data.revision,3);else assert.deepEqual(next.body.data,first.body.data);
      }
      const saved=await receipt(u,method,path,key);assert.notEqual(saved.id,before.id);withinDay(saved);
    });
    await t.test(kind+' pre-upgrade 5min receipt is not extended; after expiry new success gets 24h',async()=>{
      const u=await user(kind+'-legacy'),key='ttl-legacy-'+kind;
      const first=await create(u,key);assert.equal(first.status,kind==='grant'?201:200);
      const prior=await receipt(u,method,path,key);
      await owner("UPDATE idempotency_keys SET expires_at=created_at+interval '5 minutes' WHERE id=$1",[prior.id]);
      const legacy=await receipt(u,method,path,key);
      assert.ok(legacy.remaining>290&&legacy.remaining<=300);
      assert.deepEqual((await replay(u,key)).body.data,first.body.data);
      assert.equal((await receipt(u,method,path,key)).expires,legacy.expires);
      await age(u,method,path,key);
      const next=kind==='profile'?await put(u,key,profile,'"2"'):kind==='grant'?await grant(u,key):await withdraw(u,key,'"3"');
      assert.equal(next.status,first.status);
      const current=await receipt(u,method,path,key);assert.notEqual(current.id,legacy.id);withinDay(current);
    });
  }
  await t.test('long-lived grant receipt rechecks policy and withdrawn state; historical withdrawal cannot undo later grant',async()=>{
    const u=await user('lifecycle'),key='ttl-lifecycle-grant';const first=await grant(u,key);assert.equal(first.status,201);
    await age(u,'POST','/me/consents',key);
    await owner("UPDATE consent_policies SET enabled=false WHERE purpose='recording'");
    try{rejected(await grant(u,key),403,'CONSENT_REQUIRED');}finally{await owner("UPDATE consent_policies SET enabled=true WHERE purpose='recording'");}
    const gone=await withdraw(u,'ttl-lifecycle-withdraw','"'+first.body.data.revision+'"');assert.equal(gone.status,200);
    rejected(await grant(u,key),403,'CONSENT_REQUIRED');
    const fresh=await grant(u,'ttl-lifecycle-new-grant');assert.equal(fresh.status,201);
    await age(u,'DELETE','/me/consents/recording','ttl-lifecycle-withdraw');
    const history=await withdraw(u,'ttl-lifecycle-withdraw','"'+first.body.data.revision+'"');assert.equal(history.status,200);assert.equal(history.body.data.state,'withdrawn');
    const current=(await owner("SELECT state,current_epoch FROM privacy_epochs WHERE user_id=$1 AND purpose='recording'",[u.id])).rows[0];
    assert.equal(current.state,'granted');assert.equal(Number(current.current_epoch),fresh.body.data.epoch);
  });
  await t.test('same-key concurrent writes execute once; other subject has an independent key domain',async()=>{
    const u=await user('concurrent'),v=await user('other');
    const profiles=await Promise.all([put(u,'ttl-concurrent-profile'),put(u,'ttl-concurrent-profile')]);
    assert.ok(profiles.every(r=>r.status===200&&r.body.data.revision===2));
    assert.equal((await put(v,'ttl-concurrent-profile')).status,200);
    const grants=await Promise.all([grant(u,'ttl-concurrent-grant'),grant(u,'ttl-concurrent-grant')]);
    assert.ok(grants.every(r=>r.status===201));assert.equal(grants[0].body.data.id,grants[1].body.data.id);
    const other=await grant(v,'ttl-concurrent-grant');assert.equal(other.status,201);assert.notEqual(other.body.data.id,grants[0].body.data.id);
    const withdrawals=await Promise.all([withdraw(u,'ttl-concurrent-withdraw','"2"'),withdraw(u,'ttl-concurrent-withdraw','"2"')]);
    assert.ok(withdrawals.every(r=>r.status===200&&r.body.data.revision===3));
    assert.equal((await owner('SELECT count(*)::int n FROM consent_records WHERE user_id=$1',[u.id])).rows[0].n,1);
  });
  await t.test('revoked session cannot replay any of the three long-lived receipts',async()=>{
    const u=await user('revoked');assert.equal((await put(u,'ttl-revoked-profile')).status,200);
    assert.equal((await grant(u,'ttl-revoked-grant')).status,201);assert.equal((await withdraw(u,'ttl-revoked-withdraw','"2"')).status,200);
    await owner('UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',[u.sessionId]);
    for(const r of [await put(u,'ttl-revoked-profile'),await grant(u,'ttl-revoked-grant'),await withdraw(u,'ttl-revoked-withdraw','"2"')])rejected(r,401,'SESSION_EXPIRED');
  });
});
