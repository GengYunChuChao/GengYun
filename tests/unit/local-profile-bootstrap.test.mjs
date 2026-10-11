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
  for(const file of ['0001_initial_schema.sql','0002_knowledge_catalog.sql','0003_privacy_consent.sql','0008_auth_session.sql','0009_consent_policy.sql'])await db.exec(read('services/api/db/migrations/'+file));
  await db.exec(read('services/api/db/roles/auth_privacy.sql'));
  await db.exec('CREATE ROLE gengyun_local_runtime LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT gengyun_auth_privacy TO gengyun_local_runtime');
  // PGlite cannot rename/connect to a named database. This one target-probe
  // response is an explicit adapter fixture; all grants/inserts run real SQL.
  const client={query:async(sql,values)=>{
   if(sql==='SELECT current_database() AS database,current_user AS actor')return {rows:[{database:'gengyun_local_dev',actor:'gengyun_local_owner'}]};
   if(sql.includes('CREATE ROLE gengyun_profile_runtime')){await db.exec(sql);return {rows:[]};}
   return db.query(sql,values);
  }};
  const first=await bootstrapLocalProfile(client,root);assert.equal(first.synthetic,true);assert.equal(first.initialized,true);assert.equal(first.cropCount,4);assert.equal(first.regionCount,102);
  await db.exec('SET ROLE gengyun_local_runtime');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM crops')).rows[0].n,4);
  assert.equal((await db.query('SELECT code FROM regions FOR SHARE')).rows.length,102);
  for(const sql of ['CREATE TABLE public.forbidden(id int)','CREATE ROLE forbidden_role','DELETE FROM crops','DELETE FROM single_profiles',"UPDATE users SET state='suspended'",'SELECT object_ref_cipher FROM media','SELECT object_id FROM exports'])await assert.rejects(db.query(sql),e=>e.code==='42501');
  await db.exec('RESET ROLE');
  const saved=(await db.query('SELECT * FROM crops ORDER BY id')).rows;
  await db.exec('REVOKE gengyun_profile_runtime FROM gengyun_local_runtime');
  const second=await bootstrapLocalProfile(client,root);assert.equal(second.initialized,false);
  assert.equal((await db.query("SELECT pg_has_role('gengyun_local_runtime','gengyun_profile_runtime','MEMBER') AS member")).rows[0].member,true);
  assert.deepEqual((await db.query('SELECT * FROM crops ORDER BY id')).rows,saved);
  await db.query("UPDATE crops SET name='existing local content' WHERE id='crop_rice'");
  await assert.rejects(bootstrapLocalProfile(client,root),/Existing local catalog differs/);
  assert.equal((await db.query("SELECT name FROM crops WHERE id='crop_rice'")).rows[0].name,'existing local content');
  await db.exec('GRANT postgres TO gengyun_local_runtime');
  await assert.rejects(bootstrapLocalProfile(client,root),/migration owner/);
  await db.exec('REVOKE postgres FROM gengyun_local_runtime');
  await db.exec('ALTER ROLE gengyun_local_runtime CREATEDB');
  await assert.rejects(bootstrapLocalProfile(client,root),/restricted LOGIN/);
 }finally{await db.close();}
});
