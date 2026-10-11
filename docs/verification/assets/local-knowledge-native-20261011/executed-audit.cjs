const fs=require('fs'),path=require('path'),{createRequire}=require('module'),assert=require('assert/strict');
const root='E:/GengYunWriter/GengYun_Write',dir=root+'/.local/local-knowledge-writer-route-20261011-r3/.local/local-dev';
const pg=createRequire(root+'/package.json')('pg');
const c=JSON.parse(fs.readFileSync(dir+'/private/config.json'));
const base={host:'127.0.0.1',port:55493,database:'gengyun_local_dev'};
(async()=>{
 const runtime=new pg.Client({...base,user:'gengyun_local_runtime',password:c.runtimePassword}),owner=new pg.Client({...base,user:'gengyun_local_owner',password:c.ownerPassword});
 try{
  await runtime.connect();await owner.connect();
  const flags=(await runtime.query('SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.equal(flags.current_user,'gengyun_local_runtime');assert.equal(flags.session_user,flags.current_user);for(const k of ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'])assert.equal(flags[k],false);
  const groups=(await runtime.query('SELECT r.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE u.rolname=current_user ORDER BY r.rolname')).rows.map(x=>x.rolname);
  assert.deepEqual(groups,['gengyun_auth_privacy','gengyun_consent_granter','gengyun_knowledge_runtime','gengyun_preview_reader','gengyun_profile_runtime']);
  const scram=(await owner.query("SELECT rolpassword LIKE 'SCRAM-SHA-256$%' yes FROM pg_authid WHERE rolname='gengyun_local_runtime'")).rows[0].yes;assert.equal(scram,true);assert.notEqual(c.ownerPassword,c.runtimePassword);
  const empty=(await owner.query('SELECT (SELECT count(*)::int FROM sources) sources,(SELECT count(*)::int FROM knowledge_versions) knowledge')).rows[0];assert.deepEqual(empty,{sources:0,knowledge:0});
  const denied=[];for(const sql of ['SELECT body FROM knowledge_versions','SELECT canonical_url FROM sources','SELECT object_ref_cipher FROM media','CREATE TABLE public.local_audit_forbidden(x int)','CREATE TEMP TABLE local_audit_forbidden(x int)','SET ROLE gengyun_local_owner']){await assert.rejects(runtime.query(sql),e=>e.code==='42501');denied.push({sql,code:'42501'});}
  const observations={kind:'actual restricted native PostgreSQL LOGIN audit after normal local-dev restart; synthetic data only',postgres:(await runtime.query('SHOW server_version')).rows[0].server_version,flags,groups,scram,independentPasswords:true,afterFixtureCleanup:empty,denied};
  fs.writeFileSync(path.join(__dirname,'local-knowledge-native-audit.json'),JSON.stringify(observations,null,2)+'\n');console.log('PASS actual restarted runtime SCRAM LOGIN, exact five safe groups, six SQL denials, synthetic fixtures removed');
 }finally{await runtime.end();await owner.end();}
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});
