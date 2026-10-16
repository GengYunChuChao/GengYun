import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {bootstrapLocalProfile} from '../../tools/local-dev/profile-bootstrap.mjs';
const root=resolve(import.meta.dirname,'../..');
const read=path=>readFileSync(resolve(root,path),'utf8');

test('local profile bootstrap has a strict target guard before any mutation',async()=>{
 for(const target of [{database:'production',actor:'gengyun_local_owner'},{database:'gengyun_local_dev',actor:'api'}]){
  let calls=0;
  await assert.rejects(bootstrapLocalProfile({query:async()=>{calls++;return {rows:[target]};}},root),/dedicated local owner/);
  assert.equal(calls,1);
 }
});
test('synthetic bootstrap heals old LOGIN membership, preserves data and refuses unsafe identity',async()=>{
 const db=new PGlite();
 try {
  for(const file of ['0001_initial_schema.sql','0002_knowledge_catalog.sql','0003_privacy_consent.sql','0005_catalog_read_views.sql','0008_auth_session.sql','0009_consent_policy.sql','0010_knowledge_read_views.sql','0012_knowledge_created_at.sql'])await db.exec(read('services/api/db/migrations/'+file));
  await db.exec(read('services/api/db/roles/auth_privacy.sql'));
  await db.exec('CREATE ROLE gengyun_local_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT gengyun_auth_privacy TO gengyun_local_runtime');
  // PGlite cannot rename/connect to a named database. This one target-probe
  // response is an explicit adapter fixture; all grants/inserts run real SQL.
  const client={query:async(sql,values)=>{
   if(sql==='SELECT current_database() AS database,current_user AS actor')return {rows:[{database:'gengyun_local_dev',actor:'gengyun_local_owner'}]};
   if(sql.includes('CREATE ROLE gengyun_profile_runtime')||sql.includes('CREATE ROLE gengyun_knowledge_runtime')){await db.exec(sql);return {rows:[]};}
   return db.query(sql,values);
  }};
  const first=await bootstrapLocalProfile(client,root);assert.equal(first.synthetic,true);assert.equal(first.initialized,true);assert.equal(first.cropCount,4);assert.equal(first.regionCount,102);
  await db.exec('SET ROLE gengyun_local_runtime');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM crops')).rows[0].n,4);
  assert.equal((await db.query('SELECT code FROM regions FOR SHARE')).rows.length,102);
  assert.deepEqual((await db.query('SELECT * FROM catalog_read.current_knowledge')).rows,[]);
  for(const sql of ['CREATE TABLE public.forbidden(id int)','CREATE ROLE forbidden_role','DELETE FROM crops','DELETE FROM single_profiles',"UPDATE users SET state='suspended'",'SELECT object_ref_cipher FROM media','SELECT object_id FROM exports'])await assert.rejects(db.query(sql),e=>e.code==='42501');
  await db.exec('RESET ROLE');
  await db.exec('REVOKE gengyun_knowledge_runtime FROM gengyun_local_runtime');
  await db.exec('GRANT SELECT(body) ON knowledge_versions TO gengyun_knowledge_runtime');
  await assert.rejects(bootstrapLocalProfile(client,root),/only reviewed read projection/);
  assert.equal((await db.query("SELECT pg_has_role('gengyun_local_runtime','gengyun_knowledge_runtime','MEMBER') AS member")).rows[0].member,false);
  await db.exec('REVOKE SELECT(body) ON knowledge_versions FROM gengyun_knowledge_runtime');
  for(const danger of ['postgres','pg_read_all_data']){
   await db.exec(`GRANT ${danger} TO gengyun_knowledge_runtime`);
   await assert.rejects(bootstrapLocalProfile(client,root),/membership chain/);
   assert.equal((await db.query("SELECT pg_has_role('gengyun_local_runtime','gengyun_knowledge_runtime','MEMBER') AS member")).rows[0].member,false);
   await db.exec(`REVOKE ${danger} FROM gengyun_knowledge_runtime`);
  }
  const saved=(await db.query('SELECT * FROM crops ORDER BY id')).rows;
  await db.exec('REVOKE gengyun_profile_runtime FROM gengyun_local_runtime');
  const second=await bootstrapLocalProfile(client,root);assert.equal(second.initialized,false);
  assert.equal((await db.query("SELECT pg_has_role('gengyun_local_runtime','gengyun_profile_runtime','MEMBER') AS member")).rows[0].member,true);
  assert.deepEqual((await db.query('SELECT * FROM crops ORDER BY id')).rows,saved);
  assert.equal((await db.query("SELECT pg_has_role('gengyun_local_runtime','gengyun_knowledge_runtime','MEMBER') AS member")).rows[0].member,true);
  await db.query("UPDATE crops SET name='existing local content' WHERE id='crop_rice'");
  await assert.rejects(bootstrapLocalProfile(client,root),/Existing local catalog differs/);
  assert.equal((await db.query("SELECT name FROM crops WHERE id='crop_rice'")).rows[0].name,'existing local content');
  await db.query("UPDATE crops SET name='水稻' WHERE id='crop_rice'");
  await db.exec('GRANT postgres TO gengyun_local_runtime');
  await assert.rejects(bootstrapLocalProfile(client,root),/migration owner/);
  await db.exec('REVOKE postgres FROM gengyun_local_runtime');
  await db.exec('ALTER ROLE gengyun_local_runtime CREATEDB');
  await assert.rejects(bootstrapLocalProfile(client,root),/restricted LOGIN/);
  await db.exec('ALTER ROLE gengyun_local_runtime NOCREATEDB');
  await db.exec('REVOKE gengyun_profile_runtime FROM gengyun_local_runtime');
  const dataBefore=(await db.query('SELECT * FROM crops ORDER BY id')).rows;
  for(const [danger,grant] of [['postgres',null],['local_high_createrole','CREATEROLE'],['local_high_createdb','CREATEDB'],['local_high_bypass','BYPASSRLS'],['pg_read_all_data',null]]){
   if(grant)await db.exec(`CREATE ROLE ${danger} NOLOGIN ${grant}`);
   await db.exec(`GRANT ${danger} TO gengyun_profile_runtime`);
   assert.equal((await db.query("SELECT pg_has_role('gengyun_local_runtime','postgres','MEMBER') AS member")).rows[0].member,false);
   await assert.rejects(bootstrapLocalProfile(client,root),/membership chain/);
   assert.equal((await db.query("SELECT pg_has_role('gengyun_local_runtime','gengyun_profile_runtime','MEMBER') AS member")).rows[0].member,false);
   assert.deepEqual((await db.query('SELECT * FROM crops ORDER BY id')).rows,dataBefore);
   await db.exec(`REVOKE ${danger} FROM gengyun_profile_runtime`);
   if(grant)await db.exec(`DROP ROLE ${danger}`);
  }
  // Inject a real SQL membership change after the pre-check but before the
  // post-GRANT guard. Both the new runtime grant and injected change roll back.
  const afterGrant={query:async(sql,values)=>{
   const result=await client.query(sql,values);
   if(sql==='GRANT gengyun_profile_runtime TO gengyun_local_runtime')await db.exec('GRANT postgres TO gengyun_profile_runtime');
   return result;
  }};
  await assert.rejects(bootstrapLocalProfile(afterGrant,root),/membership chain/);
  for(const role of ['gengyun_profile_runtime','postgres'])assert.equal((await db.query('SELECT pg_has_role($1,$2,\'MEMBER\') AS member',['gengyun_local_runtime',role])).rows[0].member,false);
  assert.equal((await db.query("SELECT pg_has_role('gengyun_profile_runtime','postgres','MEMBER') AS member")).rows[0].member,false);
  assert.deepEqual((await db.query('SELECT * FROM crops ORDER BY id')).rows,dataBefore);
  await db.exec('REVOKE gengyun_knowledge_runtime FROM gengyun_local_runtime');
  const afterKnowledgeGrant={query:async(sql,values)=>{
   const result=await client.query(sql,values);
   if(sql==='GRANT gengyun_knowledge_runtime TO gengyun_local_runtime')await db.exec('GRANT postgres TO gengyun_knowledge_runtime');
   return result;
  }};
  await assert.rejects(bootstrapLocalProfile(afterKnowledgeGrant,root),/membership chain/);
  for(const role of ['gengyun_profile_runtime','gengyun_knowledge_runtime','postgres'])assert.equal((await db.query('SELECT pg_has_role($1,$2,\'MEMBER\') AS member',['gengyun_local_runtime',role])).rows[0].member,false);
  assert.equal((await db.query("SELECT pg_has_role('gengyun_knowledge_runtime','postgres','MEMBER') AS member")).rows[0].member,false);
  // A fresh group's CREATE/grants and empty-directory inserts also belong to
  // the outer transaction and cannot survive a failed final guard.
  await db.exec('DROP OWNED BY gengyun_profile_runtime,gengyun_knowledge_runtime; DROP ROLE gengyun_profile_runtime,gengyun_knowledge_runtime; DELETE FROM crops; DELETE FROM regions');
  let chainChecks=0;
  const finalFailure={query:async(sql,values)=>{
   if(sql.includes('FROM pg_roles WHERE pg_has_role')&&values?.[0]==='gengyun_local_runtime'){
    chainChecks++;
    if(chainChecks===3)await db.exec('GRANT postgres TO gengyun_profile_runtime');
   }
   return client.query(sql,values);
  }};
  await assert.rejects(bootstrapLocalProfile(finalFailure,root),/membership chain/);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname='gengyun_profile_runtime'")).rows[0].n,0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname='gengyun_knowledge_runtime'")).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM crops')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM regions')).rows[0].n,0);
  assert.equal((await bootstrapLocalProfile(client,root)).initialized,true);
  await db.exec('SET SESSION AUTHORIZATION gengyun_local_runtime');
  await assert.rejects(db.query('SET ROLE postgres'),error=>error.code==='42501');
 }finally{await db.close();}
});

test('missing or unsafe knowledge projection refuses before role creation or catalog writes',async()=>{
 const db=new PGlite();try{
  for(const file of ['0001_initial_schema.sql','0002_knowledge_catalog.sql','0003_privacy_consent.sql','0005_catalog_read_views.sql','0008_auth_session.sql','0009_consent_policy.sql'])await db.exec(read('services/api/db/migrations/'+file));
  const client={query:async(sql,values)=>sql==='SELECT current_database() AS database,current_user AS actor'?{rows:[{database:'gengyun_local_dev',actor:'gengyun_local_owner'}]}:db.query(sql,values)};
  for(const state of ['missing','not_barrier','wrong_owner']){
   if(state==='not_barrier')await db.exec('CREATE VIEW catalog_read.current_knowledge AS SELECT knowledge_id AS id FROM knowledge_versions');
   if(state==='wrong_owner')await db.exec('DROP VIEW catalog_read.current_knowledge; CREATE ROLE different_view_owner NOLOGIN; CREATE VIEW catalog_read.current_knowledge WITH(security_barrier=true) AS SELECT knowledge_id AS id FROM knowledge_versions; ALTER VIEW catalog_read.current_knowledge OWNER TO different_view_owner');
   await assert.rejects(bootstrapLocalProfile(client,root),/reviewed 0010/);
   assert.equal((await db.query("SELECT count(*)::int n FROM pg_roles WHERE rolname IN ('gengyun_profile_runtime','gengyun_knowledge_runtime')")).rows[0].n,0);
   assert.equal((await db.query('SELECT count(*)::int n FROM crops')).rows[0].n,0);
  }
 }finally{await db.close();}
});
