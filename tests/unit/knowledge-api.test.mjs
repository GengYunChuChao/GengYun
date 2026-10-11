// All records and identities are synthetic, in a fresh isolated test database.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import pg from 'pg';
import {buildApp} from '../../services/api/src/app.ts';
import {loadConfig} from '../../services/api/src/config.ts';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
async function fixture(){
  let db,owner,pool,queue=Promise.resolve();
  const native=process.env.GY_KNOWLEDGE_TEST_OWNER_URL;
  if(native){const url=new URL(native);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/gy_i07_test_[a-z0-9_]+$/);owner=new pg.Pool({connectionString:native});db={exec:s=>owner.query(s),query:(...a)=>owner.query(...a)};assert.equal((await db.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n,0);}
  else db=new PGlite();
  for(const name of ['0001_initial_schema','0002_knowledge_catalog','0003_privacy_consent','0005_catalog_read_views','0008_auth_session','0009_consent_policy','0010_knowledge_read_views'])await db.exec(read('services/api/db/migrations/'+name+'.sql'));
  for(const name of ['auth_privacy','knowledge_runtime'])await db.exec(read('services/api/db/roles/'+name+'.sql'));
  const password=randomBytes(24).toString('hex');
  await db.exec(`CREATE ROLE gy_i07_test_runtime ${native?'LOGIN':'NOLOGIN'} INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS ${native?"PASSWORD '"+password+"'":''}; GRANT gengyun_auth_privacy,gengyun_knowledge_runtime TO gy_i07_test_runtime`);
  if(native){const url=new URL(native);url.username='gy_i07_test_runtime';url.password=password;pool=new pg.Pool({connectionString:url.href,max:4,statement_timeout:5000});}
  else pool={async connect(){const before=queue;let unlock;queue=new Promise(r=>{unlock=r});await before;await db.query('SET ROLE gy_i07_test_runtime');return {query:(...a)=>db.query(...a),release(){db.query('RESET ROLE').finally(unlock)}}},async query(...a){const c=await this.connect();try{return await c.query(...a)}finally{c.release()}}};
  let intercept=null;
  const actual=pool;
  pool={async query(...args){return actual.query(...args)},async connect(){const c=await actual.connect();return {async query(...args){if(intercept&&String(args[0]).includes(intercept.marker)){const cb=intercept.cb;intercept=null;await cb();}return c.query(...args)},release(){c.release()}}}};
  const app=buildApp({config:loadConfig({APP_EXECUTION_MODE:'stub',LOG_LEVEL:'silent'}),pool});
  await app.listen({host:'127.0.0.1',port:0});const base=app.server.address();const origin='http://127.0.0.1:'+base.port;
  async function http(path,token,options={}){const r=await fetch(origin+'/api/v1'+path,{...options,headers:{...(token?{authorization:'Bearer '+token}:{}),...options.headers}});return {status:r.status,data:await r.json(),etag:r.headers.get('etag'),cache:r.headers.get('cache-control')};}
  async function login(code){const r=await http('/auth/wechat',null,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'login-key-'+code},body:JSON.stringify({code})});assert.equal(r.status,200);return r.data.data.access_token;}
  const a=await login('synthetic-a'),b=await login('synthetic-b');
  async function seed(){
    const admin=randomUUID(),source=randomUUID(),version=randomUUID();
    await db.query("INSERT INTO admin_accounts(id,login_name,credential_hash) VALUES($1,'synthetic-reviewer','synthetic-not-login')",[admin]);
    await db.query("INSERT INTO knowledge_dataset_modes(mode,description,accepts_database,accepts_verified_seed) VALUES('real','synthetic fixture only',true,true)");
    await db.query("INSERT INTO knowledge_dataset_config(key,value,mode) VALUES('active_mode','real','real'),('database_connected','true','real')");
    await db.query("INSERT INTO sources(id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES($1,'Synthetic source','https://example.invalid/synthetic','Synthetic publisher','verified_seed','research')",[source]);
    await db.query("INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,validity,review_status,reviewed_by,reviewed_at) VALUES($1,$2,'synthetic-v1',repeat('a',64),'synthetic:page1',now(),now()-interval '1 day','valid','verified',$3,now())",[version,source,admin]);
    await db.query('UPDATE sources SET current_version_id=$1 WHERE id=$2',[version,source]);
    const ids=[];
    for(let i=0;i<3;i++){const id=randomUUID();ids.push(id);await db.query("INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,crop_ids,species_ids,region_codes,visibility) VALUES($1,$2,1,$3,'Synthetic educational body only','species',$4,'[\"crop_rice\"]','[\"synthetic_weed\"]','[\"330102\"]','published')",[randomUUID(),id,'Synthetic '+i,version]);}
    return {admin,source,version,ids:ids.sort()};
  }
  return {db,pool,app,http,a,b,seed,native,intercept(marker,cb){intercept={marker,cb}},async close(){await app.close();if(native){await actual.end();await owner.end()}else{await queue;await db.close()}}};
}
test('knowledge real projection and limited runtime over loopback HTTP (synthetic only)',async t=>{
  const f=await fixture();t.after(()=>f.close());const {http,db,a,b,pool}=f;
  await t.test('real empty, guest denial, invalid filter, unconfigured pool is not static fallback',async()=>{
    assert.deepEqual((await http('/knowledge',a)).data.data,{items:[],next_cursor:null});assert.equal((await http('/knowledge')).status,401);
    for(const q of ['limit=51','owner_id=other','region_code=110101','q=','cursor=broken'])assert.equal((await http('/knowledge?'+q,a)).status,400);
    const noDb=buildApp({config:loadConfig({APP_EXECUTION_MODE:'stub',LOG_LEVEL:'silent'})});
    try{const logged=await noDb.inject({method:'POST',url:'/api/v1/auth/wechat',headers:{'idempotency-key':'no-db-login-key'},payload:{code:'synthetic-no-db'}});const r=await noDb.inject({url:'/api/v1/knowledge',headers:{authorization:'Bearer '+logged.json().data.access_token}});assert.equal(r.statusCode,503);assert.equal(r.json().error.code,'PROVIDER_UNAVAILABLE');}finally{await noDb.close()}
  });
  const s=await f.seed();let cursor;
  await t.test('list and detail frozen entity equality, real ETag and no-store; structured and keyword filters',async()=>{
    const r=await http('/knowledge?limit=1',a);assert.equal(r.status,200);assert.equal(r.cache,'no-store');assert.equal(r.etag,null);cursor=r.data.data.next_cursor;assert.ok(cursor);
    const detail=await http('/knowledge/'+r.data.data.items[0].id,a);assert.deepEqual(detail.data.data,r.data.data.items[0]);assert.equal(detail.etag,'"1"');assert.equal(detail.data.data.source.version,'synthetic-v1');assert.equal(detail.data.data.source.id,s.source);assert.equal(detail.data.data.conditions,null);assert.deepEqual(detail.data.data.dose_cards,[]);
    assert.equal((await http('/knowledge?crop_id=crop_rice&region_code=330102&species_id=synthetic_weed&q=synthetic',a)).data.data.items.length,3);
    assert.equal((await http('/knowledge?crop_id=missing',a)).data.data.items.length,0);
    for(const key of ['growth_stage','planting_method','use_scene']){assert.equal((await http('/knowledge?'+key+'=unknown',a)).data.data.items.length,0);assert.equal((await http('/knowledge/'+s.ids[0]+'?'+key+'=unknown',a)).status,404);}
  });
  await t.test('cursor subject, filter, signature, next page and visibility watermark binding',async()=>{
    const next=await http('/knowledge?limit=1&cursor='+encodeURIComponent(cursor),a);assert.equal(next.status,200);assert.equal(next.data.data.items[0].id,s.ids[1]);
    for(const [token,suffix,c] of [[b,'',cursor],[a,'&q=changed',cursor],[a,'',cursor+'x']])assert.equal((await http('/knowledge?limit=1&cursor='+encodeURIComponent(c)+suffix,token)).data.error.code,'INVALID_CURSOR');
    await db.query("UPDATE knowledge_versions SET visibility='hidden' WHERE knowledge_id=$1",[s.ids[0]]);
    assert.equal((await http('/knowledge?cursor='+encodeURIComponent(cursor),a)).data.error.code,'INVALID_CURSOR');assert.equal((await http('/knowledge/'+s.ids[0],a)).status,404);
    await db.query("UPDATE knowledge_versions SET visibility='published' WHERE knowledge_id=$1",[s.ids[0]]);
  });
  await t.test('unverified, expired, withdrawn, future, missing source and body fields never leak',async()=>{
    for(const [sql,value] of [["UPDATE source_versions SET validity=$1 WHERE id=$2",'withdrawn'],["UPDATE source_versions SET validity=$1 WHERE id=$2",'expired'],["UPDATE source_versions SET validity=$1 WHERE id=$2",'unknown']]){await db.query(sql,[value,s.version]);assert.equal((await http('/knowledge',a)).data.data.items.length,0);assert.equal((await http('/knowledge/'+s.ids[0],a)).status,404);}
    await db.query("UPDATE source_versions SET validity='valid',review_status='unverified',reviewed_by=NULL,reviewed_at=NULL WHERE id=$1",[s.version]);assert.equal((await http('/knowledge',a)).data.data.items.length,0);
    await db.query("UPDATE source_versions SET review_status='verified',reviewed_by=$2,reviewed_at=now(),valid_from=now()+interval '1 day' WHERE id=$1",[s.version,s.admin]);assert.equal((await http('/knowledge',a)).data.data.items.length,0);
    await db.query("UPDATE source_versions SET valid_from=now()-interval '1 day' WHERE id=$1",[s.version]);
    for(const [column,value] of [['canonical_url','http://example.invalid'],['publisher',''],['title','']]){const old=(await db.query('SELECT '+column+' FROM sources WHERE id=$1',[s.source])).rows[0][column];await db.query('UPDATE sources SET '+column+'=$1 WHERE id=$2',[value,s.source]);assert.equal((await http('/knowledge',a)).data.data.items.length,0);await db.query('UPDATE sources SET '+column+'=$1 WHERE id=$2',[old,s.source]);}
    await db.query("UPDATE knowledge_versions SET body='' WHERE knowledge_id=$1",[s.ids[0]]);assert.equal((await http('/knowledge/'+s.ids[0],a)).status,404);await db.query("UPDATE knowledge_versions SET body='Synthetic educational body only' WHERE knowledge_id=$1",[s.ids[0]]);
    await db.query("UPDATE sources SET source_kind='simulation' WHERE id=$1",[s.source]);assert.equal((await http('/knowledge',a)).data.data.items.length,0);await db.query("UPDATE sources SET source_kind='verified_seed' WHERE id=$1",[s.source]);
    await db.query("UPDATE source_versions SET valid_to=now()-interval '1 hour' WHERE id=$1",[s.version]);assert.equal((await http('/knowledge',a)).data.data.items.length,0);await db.query('UPDATE source_versions SET valid_to=NULL WHERE id=$1',[s.version]);
    await db.query("UPDATE knowledge_versions SET body=repeat(' ',20000)||'x' WHERE knowledge_id=$1",[s.ids[0]]);assert.equal((await http('/knowledge/'+s.ids[0],a)).status,404);await db.query("UPDATE knowledge_versions SET body='Synthetic educational body only' WHERE knowledge_id=$1",[s.ids[0]]);
  });
  await t.test('current source changes remove stale old-version knowledge; newer hidden revision blocks fallback',async()=>{
    const fresh=randomUUID();await db.query("INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,validity,review_status,reviewed_by,reviewed_at) VALUES($1,$2,'synthetic-v2',repeat('b',64),'synthetic:page2',now(),now()-interval '1 day','valid','verified',$3,now())",[fresh,s.source,s.admin]);
    await db.query('UPDATE sources SET current_version_id=$1,revision=revision+1 WHERE id=$2',[fresh,s.source]);assert.equal((await http('/knowledge',a)).data.data.items.length,0);
    await db.query('UPDATE knowledge_versions SET source_version_id=$1 WHERE knowledge_id=$2',[fresh,s.ids[0]]);assert.equal((await http('/knowledge/'+s.ids[0],a)).data.data.source.version,'synthetic-v2');
    await db.query("INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,visibility) VALUES($1,$2,2,'Synthetic private replacement','Synthetic private body','species',$3,'hidden')",[randomUUID(),s.ids[0],fresh]);assert.equal((await http('/knowledge/'+s.ids[0],a)).status,404);
  });
  await t.test('native separate-connection withdrawal and account state changes at guarded read boundary',{skip:!f.native},async()=>{
    await db.query("DELETE FROM knowledge_versions WHERE knowledge_id=$1 AND revision=2",[s.ids[0]]);
    f.intercept('SELECT * FROM catalog_read.current_knowledge',async()=>{await db.query("UPDATE source_versions SET validity='withdrawn' WHERE id=(SELECT current_version_id FROM sources WHERE id=$1)",[s.source])});
    assert.equal((await http('/knowledge/'+s.ids[0],a)).status,404,'withdrawal committed after auth locks but before material read is excluded');
    await db.query("UPDATE source_versions SET validity='valid' WHERE id=(SELECT current_version_id FROM sources WHERE id=$1)",[s.source]);
    f.intercept('SELECT state,auth_epoch FROM public.users',async()=>{await db.query("UPDATE users SET state='suspended'")});
    assert.equal((await http('/knowledge',a)).data.error.code,'ACCOUNT_INACTIVE','account disabled after middleware checked is refused inside transaction');
    await db.query("UPDATE users SET state='active'");
  });
  await t.test('SQL privileges cannot read private knowledge/source/media, publish, DDL or manage roles',async()=>{
    const flags=(await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user')).rows[0];for(const k of ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'])assert.equal(flags[k],false);assert.equal(flags.rolcanlogin,!!f.native);
    for(const sql of ['SELECT body FROM knowledge_versions','SELECT canonical_url FROM sources','SELECT content_hash FROM source_versions','SELECT object_ref_cipher FROM media',"UPDATE users SET state='deleted'",'DELETE FROM knowledge_versions','CREATE TABLE private_ddl(x int)','CREATE ROLE forbidden_role'])await assert.rejects(pool.query(sql),e=>e.code==='42501',sql);
    if(f.native)await assert.rejects(pool.query('SET ROLE '+new URL(process.env.GY_KNOWLEDGE_TEST_OWNER_URL).username),e=>e.code==='42501');
  });
  await t.test('logout prevents old session reads',async()=>{assert.equal((await http('/auth/logout',a,{method:'POST',headers:{'idempotency-key':'synthetic-logout'}})).status,200);assert.equal((await http('/knowledge',a)).status,401);});
  console.log('PASS '+(f.native?'native PG17 limited LOGIN':'PGlite limited SET ROLE')+'; actual loopback HTTP; all source/identity data synthetic');
});
