import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { createPool } from '../../services/api/src/db/pool.ts';
import { applySourceOperation } from '../../services/api/src/db/source-lifecycle.ts';
import { applyMigrations,discoverMigrations } from '../../services/api/src/db/migrate.ts';
import { buildApp } from '../../services/api/src/app.ts';
import { loadConfig } from '../../services/api/src/config.ts';

const url=new URL(process.env.DATABASE_TEST_URL??'');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
assert.equal(url.pathname,'/gengyun_source_ops_test');
const owner=new pg.Client({connectionString:url.href});await owner.connect();
const groups=['gengyun_source_executor','gengyun_source_operator','gengyun_preview_reader','gengyun_evidence_reader'];
const logins=['gengyun_ops_test','gengyun_ops_preview_test','gengyun_ops_evidence_test','gengyun_ops_public_test','gengyun_ops_alt_test'];
const passwords=logins.map(()=>randomBytes(24).toString('hex'));
let roles=false,ops,opsAlt,preview,evidence,publicPool,app;
const file=(name)=>readFileSync(new URL(`../../services/api/db/${name}`,import.meta.url),'utf8');
const pass=(message)=>console.log(`PASS ${message}`);
const conn=(i)=>{const u=new URL(url);u.username=logins[i];u.password=passwords[i];return u.href;};
async function denied(pool,sql){await assert.rejects(pool.query(sql),{code:'42501'});}
async function cli(input,dsn=conn(0),extra=[]) {
  const args=['tools/database/source-lifecycle.mjs','--action',input.action,'--operation-id',input.operationId,
    '--source-id',input.sourceId,'--source-version-id',input.sourceVersionId,'--expected-revision',String(input.expectedRevision),
    '--expected-validity',input.expectedValidity,'--reason',input.reason,...extra];
  if(input.restoresOperationId)args.push('--restores-operation-id',input.restoresOperationId);
  return await new Promise((resolve,reject)=>{
    const env={DATABASE_URL:dsn};
    for(const key of ['PATH','SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
    const proc=spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let out='',err='';proc.stdout.on('data',(d)=>out+=d);proc.stderr.on('data',(d)=>err+=d);proc.on('error',reject);
    proc.on('close',(code)=>resolve({code,out,err}));
  });
}
async function previews(){const r=await fetch(`${app.listeningOrigin}/api/v1/public/home`);assert.equal(r.status,200);return (await r.json()).data.previews;}
try {
  const version=(await owner.query('SHOW server_version')).rows[0].server_version;
  assert.match(version,/^17\.11(?:\D|$)/);console.log(`Real PostgreSQL patch: ${version}`);
  assert.equal((await owner.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0,'fresh DB only');
  assert.equal((await owner.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=ANY($1)',[[...groups,...logins]])).rows[0].n,0,'never adopt old roles');
  await applyMigrations(owner,discoverMigrations().filter((m)=>['0001','0002','0004','0005','0006'].includes(m.version)));
  await owner.query(file('roles/catalog_readers.sql'));roles=true;
  await owner.query(file('roles/source_operator.sql'));
  for(let i=0;i<logins.length;i++)await owner.query(`CREATE ROLE ${logins[i]} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${passwords[i]}'`);
  await owner.query(`GRANT gengyun_source_operator TO ${logins[0]},${logins[4]}; GRANT gengyun_preview_reader TO ${logins[1]}; GRANT gengyun_evidence_reader TO ${logins[2]}`);
  ops=createPool(conn(0));opsAlt=createPool(conn(4));preview=createPool(conn(1));evidence=createPool(conn(2));publicPool=createPool(conn(3));
  const flags=(await owner.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)',[[...groups,...logins]])).rows;
  for(const row of flags)for(const v of Object.values(row))assert.equal(v,false);
  for(const sql of ["UPDATE public.source_versions SET review_status='verified'","UPDATE public.source_versions SET validity='valid'",
    "UPDATE public.sources SET source_kind='database'","UPDATE public.sources SET revision=revision+1",
    'SELECT * FROM public.users','SELECT * FROM knowledge_staging.workbook_rows','SELECT * FROM public.applicability',
    'INSERT INTO public.catalog_source_update_events(id) VALUES(gen_random_uuid())',
    'SELECT * FROM catalog_ops.operations','CREATE TABLE public.ops_ddl(id int)','CREATE TEMP TABLE ops_temp(id int)',
    'SET ROLE gengyun_source_executor','CREATE ROLE ops_no_role'])await denied(ops,sql);
  const functionSql="SELECT catalog_ops.apply_source_operation(gen_random_uuid(),'withdraw',gen_random_uuid(),gen_random_uuid(),1,'valid','synthetic',NULL)";
  for(const pool of [preview,evidence,publicPool])await denied(pool,functionSql);
  const proc=(await owner.query("SELECT p.prosecdef,p.proconfig,r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='catalog_ops' AND p.proname='apply_source_operation'")).rows[0];
  assert.equal(proc.rolname,'gengyun_source_executor');assert.equal(proc.prosecdef,true);assert.ok(proc.proconfig.includes('search_path=pg_catalog'));
  pass('actual restricted LOGIN/function owner; direct unaudited writes, review/type/private/raw/dose/DDL/TEMP/escalation and other readers denied');

  await owner.query("INSERT INTO knowledge_dataset_modes(mode,description,accepts_database,accepts_verified_seed) VALUES('real','synthetic',true,true)");
  await owner.query("INSERT INTO knowledge_dataset_config(key,value,mode) VALUES('active_mode','real','real'),('database_connected','true','real')");
  const reviewer=randomUUID();await owner.query("INSERT INTO admin_accounts(id,login_name,credential_hash) VALUES($1,'synthetic-review','synthetic')",[reviewer]);
  async function fixture(validity='valid',review='verified') {
    const sid=randomUUID(),vid=randomUUID(),kid=randomUUID();
    await owner.query("INSERT INTO sources(id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES($1,'synthetic','https://example.invalid','synthetic','database','research')",[sid]);
    await owner.query("INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,valid_to,validity,review_status,reviewed_by,reviewed_at) VALUES($1,$2,'synthetic-v1',$3,'synthetic',now(),now()-interval '1 day',now()+interval '1 day',$4,$5,$6,$7)",[vid,sid,'a'.repeat(64),validity,review,review==='unverified'?null:reviewer,review==='unverified'?null:new Date()]);
    await owner.query('UPDATE sources SET current_version_id=$1 WHERE id=$2',[vid,sid]);
    await owner.query("INSERT INTO knowledge_versions(id,knowledge_id,revision,title,body,type,source_version_id,visibility) VALUES($1,$2,1,'synthetic-preview','synthetic-body','species',$3,'published')",[randomUUID(),kid,vid]);
    return {sid,vid,kid};
  }
  const config={...loadConfig({APP_EXECUTION_MODE:'stub'}),executionMode:'real',requiresRealCredentials:true,logLevel:'silent'};
  app=buildApp({config,pool:preview});await app.listen({host:'127.0.0.1',port:0});
  const good=await fixture();
  const input=(f,overrides={})=>({operationId:randomUUID(),action:'withdraw',sourceId:f.sid,sourceVersionId:f.vid,expectedRevision:1,expectedValidity:'valid',reason:'synthetic reason',...overrides});
  const withdrawal=input(good,{reason:"synthetic '; SELECT private --"});
  assert.ok((await previews()).some((p)=>p.id===good.kid));
  const first=await cli(withdrawal);assert.equal(first.code,0);assert.equal(JSON.parse(first.out).data.resulting_validity,'withdrawn');
  assert.equal((await previews()).some((p)=>p.id===good.kid),false);
  const replay=await cli(withdrawal);assert.equal(replay.code,0);assert.equal(JSON.parse(replay.out).data.replayed,true);
  const audit=(await owner.query('SELECT * FROM catalog_ops.operations WHERE id=$1',[withdrawal.operationId])).rows[0];
  assert.equal(audit.actor,logins[0]);assert.equal(audit.before_state.validity,'valid');assert.equal(audit.after_state.validity,'withdrawn');
  assert.equal(audit.before_state.revision,1);assert.equal(audit.after_state.revision,2);assert.deepEqual(audit.request.reason,withdrawal.reason);
  assert.equal((await owner.query('SELECT count(*)::int n FROM catalog_ops.operations WHERE id=$1',[withdrawal.operationId])).rows[0].n,1);
  await assert.rejects(applySourceOperation(ops,{...withdrawal,reason:'different'}),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(applySourceOperation(opsAlt,withdrawal),{code:'IDEMPOTENCY_CONFLICT'});
  const restoration=input(good,{action:'restore',expectedRevision:2,expectedValidity:'withdrawn',restoresOperationId:withdrawal.operationId});
  assert.equal((await cli(restoration)).code,0);assert.ok((await previews()).some((p)=>p.id===good.kid));
  assert.equal((await cli(restoration)).code,0);
  assert.notEqual((await owner.query('SELECT reverted_at FROM catalog_source_update_events WHERE id=$1',[withdrawal.operationId])).rows[0].reverted_at,null);
  const second=input(good,{expectedRevision:3});await applySourceOperation(ops,second);
  await assert.rejects(applySourceOperation(ops,{...restoration,operationId:randomUUID(),expectedRevision:4}),{code:'SOURCE_CONFLICT'});
  const replayOld=await applySourceOperation(ops,restoration);assert.equal(replayOld.replayed,true);
  assert.equal((await previews()).some((p)=>p.id===good.kid),false,'historical receipt must not reapply restore');
  pass('CLI→audited PG→next HTTP invalidation; actor/before-after/request evidence, parameterized reason, safe idempotency, exact restore and later-withdraw protection');

  const concurrent=await fixture();
  const a=input(concurrent),b=input(concurrent);
  const c1=await ops.connect(),c2=await ops.connect();
  assert.notEqual((await c1.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,(await c2.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  let results;
  try { results=await Promise.allSettled([applySourceOperation(c1,a),applySourceOperation(c2,b)]); }
  finally { c1.release();c2.release(); }
  assert.equal(results.filter((r)=>r.status==='fulfilled').length,1);assert.equal(results.find((r)=>r.status==='rejected').reason.code,'REVISION_CONFLICT');
  assert.equal((await owner.query('SELECT revision FROM sources WHERE id=$1',[concurrent.sid])).rows[0].revision,2);
  assert.equal((await owner.query('SELECT count(*)::int n FROM catalog_ops.operations WHERE source_id=$1',[concurrent.sid])).rows[0].n,1);
  const equal=await fixture();const equalRequest=input(equal);
  const receipts=await Promise.all([applySourceOperation(ops,equalRequest),applySourceOperation(ops,equalRequest)]);
  assert.deepEqual(receipts.map((r)=>r.replayed).sort(),[false,true]);
  const fault=await fixture();
  await owner.query("CREATE FUNCTION public.synthetic_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-fault'; END $$; CREATE TRIGGER synthetic_audit_fault BEFORE INSERT ON catalog_ops.operations FOR EACH ROW EXECUTE FUNCTION public.synthetic_audit_fault()");
  const failed=input(fault);await assert.rejects(applySourceOperation(ops,failed),{code:'PROVIDER_UNAVAILABLE'});
  assert.equal((await owner.query('SELECT revision FROM sources WHERE id=$1',[fault.sid])).rows[0].revision,1);
  assert.equal((await owner.query('SELECT validity FROM source_versions WHERE id=$1',[fault.vid])).rows[0].validity,'valid');
  assert.equal((await owner.query('SELECT count(*)::int n FROM catalog_source_update_events WHERE id=$1',[failed.operationId])).rows[0].n,0);
  await owner.query('DROP TRIGGER synthetic_audit_fault ON catalog_ops.operations; DROP FUNCTION public.synthetic_audit_fault()');
  pass('two-connection CAS and concurrent same-ID idempotency; injected audit failure rolls back event, state and revision');

  for(const validity of ['unknown','expired','conflicting']) {
    const f=await fixture(validity);const w=input(f,{expectedValidity:validity});await applySourceOperation(ops,w);
    await assert.rejects(applySourceOperation(ops,input(f,{action:'restore',expectedRevision:2,expectedValidity:'withdrawn',restoresOperationId:w.operationId})),{code:'SOURCE_CONFLICT'});
  }
  for(const change of ['expiry','review','newVersion','hash']) {
    const f=await fixture();const w=input(f);await applySourceOperation(ops,w);
    if(change==='expiry')await owner.query("UPDATE source_versions SET valid_to=now()-interval '1 hour' WHERE id=$1",[f.vid]);
    if(change==='review')await owner.query("UPDATE source_versions SET review_status='rejected' WHERE id=$1",[f.vid]);
    if(change==='newVersion') {
      const nextId=randomUUID();
      await owner.query("INSERT INTO source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,valid_to,validity,review_status,reviewed_by,reviewed_at) SELECT $1,source_id,'synthetic-v2',content_hash,locator,retrieved_at,valid_from,valid_to,'valid',review_status,reviewed_by,reviewed_at FROM source_versions WHERE id=$2",[nextId,f.vid]);
      await owner.query('UPDATE sources SET current_version_id=$1,revision=revision+1 WHERE id=$2',[nextId,f.sid]);
    }
    if(change==='hash')await owner.query('UPDATE source_versions SET content_hash=$1 WHERE id=$2',['b'.repeat(64),f.vid]);
    const state=(await owner.query('SELECT validity,review_status,content_hash FROM source_versions WHERE id=$1',[f.vid])).rows[0];
    await assert.rejects(applySourceOperation(ops,input(f,{action:'restore',expectedRevision:2,expectedValidity:'withdrawn',restoresOperationId:w.operationId})),(e)=>['SOURCE_CONFLICT','REVISION_CONFLICT'].includes(e.code));
    assert.deepEqual((await owner.query('SELECT validity,review_status,content_hash FROM source_versions WHERE id=$1',[f.vid])).rows[0],state);
  }
  // Unchanged date snapshot can still expire with the clock; compare actual time.
  const timed=await fixture();
  await owner.query("UPDATE source_versions SET valid_to=clock_timestamp()+interval '600 milliseconds' WHERE id=$1",[timed.vid]);
  const timedWithdraw=input(timed);await applySourceOperation(ops,timedWithdraw);
  await new Promise((resolve)=>setTimeout(resolve,750));
  await assert.rejects(applySourceOperation(ops,input(timed,{action:'restore',expectedRevision:2,expectedValidity:'withdrawn',restoresOperationId:timedWithdraw.operationId})),{code:'SOURCE_CONFLICT'});
  const damaged=await fixture();const dw=input(damaged);await applySourceOperation(ops,dw);
  await owner.query('UPDATE catalog_source_update_events SET old_validity=NULL WHERE id=$1',[dw.operationId]);
  await assert.rejects(applySourceOperation(ops,input(damaged,{action:'restore',expectedRevision:2,expectedValidity:'withdrawn',restoresOperationId:dw.operationId})),{code:'SOURCE_CONFLICT'});
  await assert.rejects(applySourceOperation(ops,input(fault,{action:'restore',expectedValidity:'valid',restoresOperationId:randomUUID()})),{code:'SOURCE_CONFLICT'});
  await assert.rejects(applySourceOperation(ops,input(fault,{sourceVersionId:good.vid})),{code:'NOT_FOUND'});
  await assert.rejects(applySourceOperation(ops,input(fault,{sourceId:randomUUID()})),{code:'NOT_FOUND'});
  await assert.rejects(applySourceOperation(ops,input(fault,{expectedRevision:99})),{code:'REVISION_CONFLICT'});
  const wrongLink=input(fault,{action:'restore',restoresOperationId:withdrawal.operationId});
  await assert.rejects(applySourceOperation(ops,wrongLink),{code:'SOURCE_CONFLICT'});
  pass('unknown/expired/conflicting, expiry/lost-review/new-version/hash changes, wrong/missing target/link and stale revision restore rejected without data change');

  const bad=await cli(input(fault),'postgres://private-user:DO_NOT_PRINT@127.0.0.1:1/gengyun_source_ops_test');
  assert.equal(bad.code,1);assert.equal(bad.err.includes('DO_NOT_PRINT'),false);assert.equal(bad.err.includes('private-user'),false);
  assert.equal((await cli(input(fault),conn(0),['--actor','spoofed'])).code,1);
  const eventCount=(await owner.query('SELECT count(*)::int n FROM catalog_source_update_events')).rows[0].n;
  await assert.rejects(owner.query(file('migrations/rollback/0006_source_lifecycle.down.sql')),{code:'G0004'});await owner.query('ROLLBACK');
  assert.equal((await owner.query('SELECT count(*)::int n FROM catalog_source_update_events')).rows[0].n,eventCount);
  // Test-owner archive simulation only: no production audit deletion by CLI.
  await owner.query('DELETE FROM catalog_ops.operations');
  await owner.query(file('migrations/rollback/0006_source_lifecycle.down.sql'));
  assert.equal((await owner.query('SELECT count(*)::int n FROM catalog_source_update_events')).rows[0].n,eventCount);
  assert.notEqual((await owner.query("SELECT to_regclass('public.sources') AS name")).rows[0].name,null);
  pass('CLI secret/actor spoof rejection; nonempty audit blocks down; empty scoped down preserves base rows and existing events');
} finally {
  await app?.close();for(const pool of [ops,opsAlt,preview,evidence,publicPool])await pool?.end();
  if(roles){
    const present=new Set((await owner.query('SELECT rolname FROM pg_roles WHERE rolname=ANY($1)',[[...logins,...groups]])).rows.map((r)=>r.rolname));
    for(const role of [...logins,...groups].filter((r)=>present.has(r)))await owner.query(`DROP OWNED BY ${role}`);
    for(const role of [...logins,...groups].filter((r)=>present.has(r)))await owner.query(`DROP ROLE ${role}`);
  }
  await owner.end();
}
