import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import pg from 'pg';
import {createPool} from '../../services/api/src/db/pool.ts';
import {extractIntake,importIntake,rollbackIntake,stagingBatchId,validateStagingDatabaseUrl} from '../../services/api/src/db/staging-intake.ts';
import {applyMigrations,discoverMigrations} from '../../services/api/src/db/migrate.ts';
import {buildApp} from '../../services/api/src/app.ts';
import {loadConfig} from '../../services/api/src/config.ts';

const url=new URL(validateStagingDatabaseUrl(process.env.STAGING_INTAKE_TEST_URL));
assert.equal(url.pathname,'/gengyun_staging_intake_test');
const python=process.env.STAGING_PYTHON??'python3';
const cleanEnv=()=>Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
const owner=new pg.Client({connectionString:url.href});await owner.connect();
const groups=['gengyun_staging_executor','gengyun_staging_importer','gengyun_preview_reader','gengyun_evidence_reader'];
const names=['gengyun_intake_test','gengyun_intake_alt_test','gengyun_intake_preview_test','gengyun_intake_public_test'];
const passwords=names.map(()=>randomBytes(24).toString('hex'));
const conn=i=>{const u=new URL(url);u.username=names[i];u.password=passwords[i];return u.href;};
const file=p=>readFileSync(new URL('../../services/api/db/'+p,import.meta.url),'utf8');
const pass=m=>console.log('PASS '+m);
let created=false,ops,alt,preview,publicPool,app;
const count=async(table)=>Number((await owner.query('SELECT count(*)::integer AS n FROM '+table)).rows[0].n);
async function cli(args,i=0,extraEnv={}) {
  const env={...cleanEnv(),DATABASE_URL:conn(i),STAGING_PYTHON:python,...extraEnv};
  return new Promise((accept,reject)=>{
    const c=spawn(process.execPath,['tools/database/staging-intake.mjs',...args],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let out='',err='';c.stdout.on('data',s=>out+=s);c.stderr.on('data',s=>err+=s);c.on('error',reject);c.on('close',status=>accept({status,out,err}));
  });
}
try {
  assert.equal((await owner.query('SHOW server_version')).rows[0].server_version.split(' ')[0],'17.11');
  console.log('Real PostgreSQL patch:',(await owner.query('SHOW server_version')).rows[0].server_version);
  assert.equal((await owner.query("SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n,0,'fresh database only');
  assert.equal((await owner.query('SELECT count(*)::integer AS n FROM pg_roles WHERE rolname=ANY($1)',[[...groups,...names]])).rows[0].n,0,'no existing test roles');
  await applyMigrations(owner,discoverMigrations().filter(m=>['0001','0002','0004','0005','0007'].includes(m.version)));
  await owner.query(file('roles/catalog_readers.sql'));await owner.query(file('roles/staging_importer.sql'));created=true;
  for(const[i,name]of names.entries()){
    await owner.query(`CREATE ROLE ${name} LOGIN PASSWORD '${passwords[i]}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    if(i<2)await owner.query(`GRANT gengyun_staging_importer TO ${name}`);
    if(i===2)await owner.query(`GRANT gengyun_preview_reader TO ${name}`);
  }
  ops=createPool(conn(0));alt=createPool(conn(1));preview=createPool(conn(2));publicPool=createPool(conn(3));
  const flags=(await owner.query('SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)',[[...groups,...names]])).rows;
  assert.ok(flags.every(r=>!r.rolsuper&&!r.rolcreatedb&&!r.rolcreaterole&&!r.rolreplication&&!r.rolbypassrls));
  const functions=(await owner.query("SELECT p.prosecdef,r.rolname,p.proconfig FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='staging_intake' AND p.proname IN ('apply_import','rollback_import')")).rows;
  assert.equal(functions.length,2);assert.ok(functions.every(r=>r.prosecdef&&r.rolname==='gengyun_staging_executor'&&r.proconfig.includes('search_path=pg_catalog')));
  for(const sql of ['SELECT * FROM knowledge_staging.workbook_rows','SELECT * FROM knowledge_staging.workbook_batches','INSERT INTO knowledge_staging.workbook_batches DEFAULT VALUES','UPDATE knowledge_staging.workbook_rows SET raw=raw','DELETE FROM knowledge_staging.workbook_batches','SELECT * FROM staging_intake.operations','DELETE FROM staging_intake.operations',"UPDATE public.source_versions SET review_status='verified'",'SELECT * FROM public.applicability','SELECT * FROM public.users','CREATE TABLE public.intake_forbidden(x int)','CREATE TEMP TABLE intake_forbidden(x int)','SET ROLE gengyun_staging_executor','CREATE ROLE intake_forbidden','ALTER FUNCTION staging_intake.apply_import(uuid,jsonb,uuid) RENAME TO forbidden'])await assert.rejects(ops.query(sql),{code:'42501'});
  for(const pool of [preview,publicPool])await assert.rejects(pool.query('SELECT staging_intake.apply_import($1,$2,$3)',[randomUUID(),'{}',null]),{code:'42501'});
  pass('actual restricted LOGIN: function owner/search_path, no raw/private/audit DML or reads, no DDL/TEMP/escalation; PUBLIC/preview denied');

  mkdirSync('.local',{recursive:true});const dir=mkdtempSync(resolve('.local/staging-intake-synthetic-'));const workbook=resolve(dir,'synthetic.xlsx');
  const code=`import importlib.util,sys,zipfile
from xml.sax.saxutils import escape
s=importlib.util.spec_from_file_location('fixture','tests/knowledge/test_workbook_staging.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
book=m.fixture();ns=m.intake.NS['m'];rel=m.intake.REL
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('xl/workbook.xml','<workbook xmlns="'+ns+'" xmlns:r="'+rel+'"><sheets>'+''.join('<sheet name="'+escape(s['name'])+'" sheetId="'+str(i+1)+'" r:id="s'+str(i+1)+'"/>' for i,s in enumerate(book['sheets']))+'</sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships>'+''.join('<Relationship Id="s'+str(i+1)+'" Target="worksheets/sheet'+str(i+1)+'.xml"/>' for i in range(len(book['sheets'])))+'</Relationships>')
 for i,sheet in enumerate(book['sheets']):
  rows=''.join('<row r="'+str(r['excel_row'])+'">'+''.join('<c r="'+k+'" t="inlineStr"><is><t>'+escape(c['value'])+'</t></is></c>' for k,c in r['cells'].items())+'</row>' for r in sheet['rows'])
  z.writestr('xl/worksheets/sheet'+str(i+1)+'.xml','<worksheet xmlns="'+ns+'"><sheetData>'+rows+'</sheetData></worksheet>')`;
  const generated=spawnSync(python,['-c',code,workbook],{env:{...cleanEnv(),PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',windowsHide:true});assert.equal(generated.status,0,'synthetic XLSX generation failed');
  // Untrusted PYTHONPATH must not run inside the extractor; database secrets omitted too.
  const probe=resolve(dir,'env-probe');mkdirSync(probe);writeFileSync(resolve(probe,'sitecustomize.py'),"import os\nos._exit(77)\n");
  const previous={PYTHONPATH:process.env.PYTHONPATH,DATABASE_URL:process.env.DATABASE_URL};
  process.env.PYTHONPATH=probe;process.env.DATABASE_URL='synthetic-secret-must-not-reach-python';
  let payload;try{payload=await extractIntake(workbook,python);}finally{for(const[k,v]of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;}
  assert.equal(payload.sha256,createHash('sha256').update(readFileSync(workbook)).digest('hex'));assert.equal(payload.rows.length,3);
  const op=randomUUID();const imported=await cli(['--action','import','--operation-id',op,'--workbook',workbook],0,{PYTHONPATH:probe});assert.equal(imported.status,0,imported.err);const receipt=JSON.parse(imported.out).data;
  assert.equal(receipt.batch_id,payload.batch_id);assert.equal(receipt.row_count,3);assert.equal(receipt.generation,1);assert.equal(receipt.replayed,false);
  assert.equal((await owner.query('SELECT actor FROM staging_intake.operations WHERE id=$1',[op])).rows[0].actor,names[0]);
  assert.equal((await owner.query('SELECT file_sha256 FROM staging_intake.batches WHERE batch_id=$1',[payload.batch_id])).rows[0].file_sha256,payload.sha256);
  const stored=(await owner.query('SELECT sheet_name,excel_row,raw,mapped,state,issues FROM knowledge_staging.workbook_rows WHERE batch_id=$1 ORDER BY sheet_name,excel_row',[payload.batch_id])).rows;
  const actualMapped=stored.find(r=>r.excel_row===2).mapped;assert.equal(actualMapped.validity,'unknown');assert.equal(actualMapped.review_status,'unverified');assert.equal(actualMapped.card_ready,false);
  assert.equal((await owner.query('SELECT count(*)::integer AS n FROM public.sources')).rows[0].n,0);
  for(const marker of ['raw','合成','除草剂','DO_NOT_PRINT'])assert.equal(imported.out.includes(marker),false);
  const repeated=await cli(['--action','import','--operation-id',op,'--workbook',workbook]);assert.equal(repeated.status,0);assert.equal(JSON.parse(repeated.out).data.replayed,true);assert.equal(await count('staging_intake.operations'),1);
  const config={...loadConfig({APP_EXECUTION_MODE:'stub'}),executionMode:'real',requiresRealCredentials:true,logLevel:'silent'};
  app=buildApp({config,pool:preview});await app.listen({host:'127.0.0.1',port:0});
  const base=app.server.address();const response=await fetch(`http://127.0.0.1:${base.port}/api/v1/public/home`);assert.equal(response.status,200);const home=await response.text();assert.equal(home.includes('合成'),false);assert.equal(home.includes('raw'),false);
  pass('synthetic XLSX immutable byte hash → minimal-env Python pipe → CLI → actual PG; unknown/unverified/card_ready false, same-ID replay, public HTTP never exposes raw');

  const badPayloads=[];
  for(const mutate of [p=>p.batch_id=randomUUID(),p=>p.sha256='b'.repeat(64),p=>p.rows[1].row_hash='d'.repeat(64),p=>p.rows[1].raw.cells.A2.value='changed',p=>p.rows.pop(),p=>p.rows.push(p.rows[1]),p=>p.rows[1].mapped.card_ready=true,p=>p.rows[1].state='context']){const p=structuredClone(payload);mutate(p);badPayloads.push(p);}
  for(const p of badPayloads)await assert.rejects(ops.query('SELECT staging_intake.apply_import($1,$2,$3)',[randomUUID(),JSON.stringify(p),null]));
  const changed=structuredClone(payload);changed.filename='different.xlsx';await assert.rejects(importIntake(ops,op,changed),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(importIntake(alt,op,payload),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(importIntake(ops,randomUUID(),payload),{code:'SOURCE_CONFLICT'});
  const legacy=structuredClone(payload);legacy.sha256='c'.repeat(64);legacy.batch_id=stagingBatchId(legacy.sha256);
  await owner.query('INSERT INTO knowledge_staging.workbook_batches(id,file_sha256,filename,mapping_version,quality) VALUES($1,$2,$3,$4,$5)',[legacy.batch_id,legacy.sha256,legacy.filename,legacy.mapping_version,legacy.quality]);
  await assert.rejects(importIntake(ops,randomUUID(),legacy),{code:'SOURCE_CONFLICT'});
  await assert.rejects(rollbackIntake(ops,randomUUID(),legacy.batch_id,op,receipt.payload_hash),{code:'SOURCE_CONFLICT'});
  pass('DB-level UUIDv5/raw SHA256, malformed/incomplete/duplicate/unsafe mapped payloads rejected; altered request/actor and unmanaged old batch cannot be adopted');

  const concurrent=structuredClone(payload);concurrent.sha256='d'.repeat(64);concurrent.batch_id=stagingBatchId(concurrent.sha256);
  const a=await ops.connect(),b=await ops.connect();
  try{
    assert.notEqual((await a.query('SELECT pg_backend_pid() AS p')).rows[0].p,(await b.query('SELECT pg_backend_pid() AS p')).rows[0].p);
    const shared=randomUUID();const results=await Promise.all([importIntake(a,shared,concurrent),importIntake(b,shared,concurrent)]);assert.deepEqual(results.map(r=>r.replayed).sort(),[false,true]);
    const raced=structuredClone(payload);raced.sha256='e'.repeat(64);raced.batch_id=stagingBatchId(raced.sha256);
    const outcomes=await Promise.allSettled([importIntake(a,randomUUID(),raced),importIntake(b,randomUUID(),raced)]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected'&&r.reason.code==='SOURCE_CONFLICT').length,1);
  }finally{a.release();b.release();}
  const fault=structuredClone(payload);fault.sha256='f'.repeat(64);fault.batch_id=stagingBatchId(fault.sha256);const failId=randomUUID();
  await owner.query("CREATE FUNCTION public.intake_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.excel_row=2 THEN RAISE EXCEPTION 'synthetic row fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER intake_test_fault BEFORE INSERT ON knowledge_staging.workbook_rows FOR EACH ROW EXECUTE FUNCTION public.intake_test_fault()");
  await assert.rejects(importIntake(ops,failId,fault));
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM knowledge_staging.workbook_batches WHERE id=$1',[fault.batch_id])).rows[0].n,0);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM staging_intake.batches WHERE batch_id=$1',[fault.batch_id])).rows[0].n,0);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM staging_intake.operations WHERE id=$1',[failId])).rows[0].n,0);
  assert.deepEqual((await owner.query('SELECT sheet_name,excel_row,raw,mapped,state,issues FROM knowledge_staging.workbook_rows WHERE batch_id=$1 ORDER BY sheet_name,excel_row',[payload.batch_id])).rows,stored);
  await owner.query('DROP TRIGGER intake_test_fault ON knowledge_staging.workbook_rows; DROP FUNCTION public.intake_test_fault()');
  const auditFault=structuredClone(payload);auditFault.sha256='1'.repeat(64);auditFault.batch_id=stagingBatchId(auditFault.sha256);
  await owner.query("CREATE FUNCTION public.intake_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit fault'; END $$; CREATE TRIGGER intake_audit_fault BEFORE INSERT ON staging_intake.operations FOR EACH ROW EXECUTE FUNCTION public.intake_audit_fault()");
  await assert.rejects(importIntake(ops,randomUUID(),auditFault));
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM knowledge_staging.workbook_batches WHERE id=$1',[auditFault.batch_id])).rows[0].n,0);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM staging_intake.batches WHERE batch_id=$1',[auditFault.batch_id])).rows[0].n,0);
  await assert.rejects(rollbackIntake(ops,randomUUID(),payload.batch_id,op,receipt.payload_hash));
  assert.equal((await owner.query('SELECT state FROM staging_intake.batches WHERE batch_id=$1',[payload.batch_id])).rows[0].state,'imported');
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM knowledge_staging.workbook_rows WHERE batch_id=$1',[payload.batch_id])).rows[0].n,3);
  await owner.query('DROP TRIGGER intake_audit_fault ON staging_intake.operations; DROP FUNCTION public.intake_audit_fault()');
  pass('two different PG backend connections: same-ID one write/one replay, different-ID one accepted/one conflict; row/audit insertion faults atomically roll back import/rollback batch/rows/ownership/audit');

  await assert.rejects(rollbackIntake(alt,randomUUID(),payload.batch_id,op,receipt.payload_hash),{code:'SOURCE_CONFLICT'});
  await assert.rejects(rollbackIntake(ops,randomUUID(),concurrent.batch_id,op,receipt.payload_hash),{code:'SOURCE_CONFLICT'});
  await assert.rejects(rollbackIntake(ops,randomUUID(),payload.batch_id,randomUUID(),receipt.payload_hash),{code:'SOURCE_CONFLICT'});
  await assert.rejects(rollbackIntake(ops,randomUUID(),payload.batch_id,op,'a'.repeat(64)),{code:'SOURCE_CONFLICT'});
  const snapshot=async bid=>({
    batch:(await owner.query('SELECT * FROM knowledge_staging.workbook_batches WHERE id=$1',[bid])).rows,
    rows:(await owner.query('SELECT * FROM knowledge_staging.workbook_rows WHERE batch_id=$1 ORDER BY sheet_name COLLATE "C",excel_row',[bid])).rows,
    ownership:(await owner.query('SELECT * FROM staging_intake.batches WHERE batch_id=$1',[bid])).rows,
    audit:(await owner.query('SELECT * FROM staging_intake.operations WHERE batch_id=$1 ORDER BY id',[bid])).rows,
    auditTotal:await count('staging_intake.operations'),
  });
  const probeBatch=async label=>{
    const p=structuredClone(payload);p.sha256=createHash('sha256').update('synthetic rollback '+label).digest('hex');p.batch_id=stagingBatchId(p.sha256);
    return {p,r:await importIntake(ops,randomUUID(),p)};
  };
  const addRow=(bid,sheet)=>owner.query("INSERT INTO knowledge_staging.workbook_rows(batch_id,sheet_name,excel_row,row_hash,raw,mapped,state,issues) VALUES($1,$2,99,repeat('a',64),'{\"synthetic_later_row\":true}','{}','context','[]')",[bid,sheet]);
  for(const kind of ['listed-add','unlisted-add','missing','unlisted-replace','coordinate-change','content-change']){
    const {p,r}=await probeBatch(kind);
    if(kind==='listed-add'||kind==='unlisted-add')await addRow(p.batch_id,kind==='listed-add'?p.rows[0].sheet:'unlisted-later-sheet');
    if(kind==='missing'||kind==='unlisted-replace'){
      const note=p.rows[2];await owner.query('DELETE FROM knowledge_staging.workbook_rows WHERE batch_id=$1 AND sheet_name=$2 AND excel_row=$3',[p.batch_id,note.sheet,note.excel_row]);
      if(kind==='unlisted-replace')await addRow(p.batch_id,'unlisted-later-sheet');
    }
    if(kind==='coordinate-change')await owner.query('UPDATE knowledge_staging.workbook_rows SET excel_row=98 WHERE batch_id=$1 AND excel_row=2',[p.batch_id]);
    if(kind==='content-change')await owner.query("UPDATE knowledge_staging.workbook_rows SET raw=raw||'{\"synthetic_change\":true}'::jsonb WHERE batch_id=$1 AND excel_row=2",[p.batch_id]);
    const before=await snapshot(p.batch_id);
    await assert.rejects(rollbackIntake(ops,randomUUID(),p.batch_id,r.import_id,r.payload_hash),{code:'SOURCE_CONFLICT'});
    assert.deepEqual(await snapshot(p.batch_id),before,kind+' must preserve ALL batch/rows/generation/audit');
    // Leave this synthetic changed batch intact; never clean it to make rollback pass.
    pass('rollback full-set '+kind+': SOURCE_CONFLICT; entire batch/all rows/ownership/generation/audit unchanged');
  }

  const {p:protectedPayload,r:protectedReceipt}=await probeBatch('concurrent-fk');
  await owner.query("CREATE FUNCTION public.intake_rollback_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(700700); RETURN OLD; END $$; CREATE TRIGGER intake_rollback_gate BEFORE DELETE ON knowledge_staging.workbook_batches FOR EACH ROW EXECUTE FUNCTION public.intake_rollback_gate()");
  const rollbackClient=await ops.connect();const writer=new pg.Client({connectionString:url.href});await writer.connect();
  const waitFor=async(pid,event)=>{for(let i=0;i<100;i++){const a=(await owner.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];if(event(a?.wait_event))return;await new Promise(r=>setTimeout(r,20));}assert.fail('expected deterministic database lock wait');};
  await owner.query('SELECT pg_advisory_lock(700700)');
  try{
    const rp=(await rollbackClient.query('SELECT pg_backend_pid() AS p')).rows[0].p;
    const wp=(await writer.query('SELECT pg_backend_pid() AS p')).rows[0].p;assert.notEqual(rp,wp);
    const rollbackPromise=rollbackIntake(rollbackClient,randomUUID(),protectedPayload.batch_id,protectedReceipt.import_id,protectedReceipt.payload_hash);
    await waitFor(rp,e=>e==='advisory'); // Function has compared full content and still holds parent/row locks.
    const writerPromise=writer.query("INSERT INTO knowledge_staging.workbook_rows(batch_id,sheet_name,excel_row,row_hash,raw,mapped,state,issues) VALUES($1,'concurrent-unlisted',100,repeat('b',64),'{}','{}','context','[]')",[protectedPayload.batch_id]).then(()=>({code:'unexpected_success'}),e=>({code:e.code}));
    await waitFor(wp,e=>e==='transactionid'||e==='tuple');
    await owner.query('SELECT pg_advisory_unlock(700700)');
    const validRollback=await rollbackPromise;assert.equal(validRollback.row_count,3);
    assert.equal((await writerPromise).code,'23503'); // Writer cannot sneak a row through the locked parent.
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM knowledge_staging.workbook_rows WHERE batch_id=$1',[protectedPayload.batch_id])).rows[0].n,0);
  }finally{
    await owner.query('SELECT pg_advisory_unlock(700700)');rollbackClient.release();await writer.end();
    await owner.query('DROP TRIGGER intake_rollback_gate ON knowledge_staging.workbook_batches; DROP FUNCTION public.intake_rollback_gate()');
  }
  pass('rollback full-set concurrency: after comparison, parent/row locks block actual extra-row INSERT; writer fails FK instead of being silently cascade-deleted');
  await owner.query("UPDATE knowledge_staging.workbook_rows SET raw=raw||'{\"synthetic_change\":true}'::jsonb WHERE batch_id=$1 AND excel_row=2",[payload.batch_id]);
  await assert.rejects(rollbackIntake(ops,randomUUID(),payload.batch_id,op,receipt.payload_hash),{code:'SOURCE_CONFLICT'});
  await owner.query('UPDATE knowledge_staging.workbook_rows SET raw=$1 WHERE batch_id=$2 AND excel_row=2',[payload.rows[1].raw,payload.batch_id]);
  const sid=randomUUID(),sv=randomUUID();
  await owner.query("INSERT INTO public.sources(id,title,canonical_url,publisher,source_kind,evidence_kind) VALUES($1,'synthetic link','https://example.invalid','synthetic','database','research')",[sid]);
  await owner.query("INSERT INTO public.source_versions(id,source_id,version,content_hash,locator,retrieved_at,valid_from,validity,review_status) VALUES($1,$2,'synthetic',repeat('a',64),'synthetic',now(),now(),'unknown','unverified')",[sv,sid]);
  await owner.query('UPDATE knowledge_staging.workbook_batches SET source_version_id=$1 WHERE id=$2',[sv,payload.batch_id]);
  await assert.rejects(rollbackIntake(ops,randomUUID(),payload.batch_id,op,receipt.payload_hash),{code:'SOURCE_CONFLICT'});
  await owner.query('UPDATE knowledge_staging.workbook_batches SET source_version_id=NULL WHERE id=$1',[payload.batch_id]);
  const rb=randomUUID();const rollbackArgs=['--action','rollback','--operation-id',rb,'--batch-id',payload.batch_id,'--import-id',op,'--payload-hash',receipt.payload_hash];
  const rolled=await cli(rollbackArgs);assert.equal(rolled.status,0,rolled.err);assert.equal(JSON.parse(rolled.out).data.state,'reverted');
  const repeatRollback=await cli(rollbackArgs);assert.equal(repeatRollback.status,0);assert.equal(JSON.parse(repeatRollback.out).data.replayed,true);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM knowledge_staging.workbook_rows WHERE batch_id=$1',[payload.batch_id])).rows[0].n,0);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM knowledge_staging.workbook_batches WHERE id=$1',[legacy.batch_id])).rows[0].n,1);
  const historical=await importIntake(ops,op,payload);assert.equal(historical.replayed,true);assert.equal((await owner.query('SELECT count(*)::int AS n FROM knowledge_staging.workbook_batches WHERE id=$1',[payload.batch_id])).rows[0].n,0);
  await assert.rejects(importIntake(ops,randomUUID(),payload),{code:'SOURCE_CONFLICT'});
  const next=randomUUID();const reimport=await cli(['--action','import','--operation-id',next,'--workbook',workbook,'--previous-import-id',op]);assert.equal(reimport.status,0,reimport.err);assert.equal(JSON.parse(reimport.out).data.generation,2);
  const oldReplay=await rollbackIntake(ops,rb,payload.batch_id,op,receipt.payload_hash);assert.equal(oldReplay.replayed,true);assert.equal((await owner.query('SELECT count(*)::int AS n FROM knowledge_staging.workbook_rows WHERE batch_id=$1',[payload.batch_id])).rows[0].n,3);
  await assert.rejects(rollbackIntake(ops,randomUUID(),payload.batch_id,op,receipt.payload_hash),{code:'SOURCE_CONFLICT'});
  pass('precise batch rollback denies other actor/batch/import/hash/changed content; preserves other batch and immutable audit; replay is historical, generation2 requires new ID plus previous import');

  const argvDenied=await cli(['--action','import','--operation-id',randomUUID(),'--workbook',workbook,'--actor','forged']);assert.equal(argvDenied.status,1);assert.equal(argvDenied.err.includes('forged'),false);
  const jsonDenied=await cli(['--action','import','--operation-id',randomUUID(),'--json','synthetic.json']);assert.equal(jsonDenied.status,1);
  const broken=resolve(dir,'broken.xlsx');writeFileSync(broken,'synthetic broken ZIP');const badFile=await cli(['--action','import','--operation-id',randomUUID(),'--workbook',broken]);assert.equal(badFile.status,1);assert.equal(badFile.err.includes(broken),false);
  const deniedSource=await cli(['--action','import','--operation-id',randomUUID(),'--workbook',resolve('README.md')]);assert.equal(deniedSource.status,1);
  for(const limit of ['MAX_INTAKE_ROWS=1','MAX_INTAKE_JSON_BYTES=64']){
    const bounded=spawnSync(python,['-c',`import importlib.util,sys\ns=importlib.util.spec_from_file_location('i','tools/knowledge/import_workbook_staging.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nm.${limit}\nsys.argv=['intake',sys.argv[1],'--internal-json']\ntry: m.main()\nexcept ValueError as e: sys.exit(0 if str(e)=='INTAKE_LIMIT_EXCEEDED' else 1)\nelse: sys.exit(1)`,workbook],{env:{...cleanEnv(),PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',windowsHide:true});
    assert.equal(bounded.status,0,'internal extraction row/JSON limit must reject');assert.equal(bounded.stdout,'');
  }
  const down=file('migrations/rollback/0007_staging_intake.down.sql');await assert.rejects(owner.query(down),{code:'G0004'});await owner.query('ROLLBACK');assert.ok(await count('staging_intake.operations')>0);
  const baseBefore=await count('knowledge_staging.workbook_batches');
  // Only synthetic audit removal simulates a separately authorized archive; CLI has no such command.
  await owner.query('DELETE FROM staging_intake.operations; DELETE FROM staging_intake.batches');await owner.query(down);assert.equal(await count('knowledge_staging.workbook_batches'),baseBefore);assert.equal((await owner.query("SELECT to_regclass('public.source_versions') AS r")).rows[0].r,'source_versions');
  pass('CLI rejects actor/JSON/path/corrupt workbook without leaking raw/DSN; nonempty audit blocks down; archived empty down retains 0004 batches/rows and base tables');
} finally {
  await app?.close();for(const pool of [ops,alt,preview,publicPool])if(pool)await pool.end();
  if(created){for(const name of [...names,...groups]){await owner.query(`DROP OWNED BY ${name}`);await owner.query(`DROP ROLE ${name}`);}}
  await owner.end();
}
