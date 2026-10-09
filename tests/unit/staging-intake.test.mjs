import {test}from'node:test';
import assert from'node:assert/strict';
import {createHash,randomUUID}from'node:crypto';
import {spawnSync}from'node:child_process';
import pg from'pg';
import {stagingBatchId,pythonJson,validateIntakePayload,validateStagingDatabaseUrl,importIntake,rollbackIntake}from'../../services/api/src/db/staging-intake.ts';
function fixture(){
  const raw={cells:{A1:{value:'合成头',stored:'合成头',type:'inlineStr',formula:null,style:null,formula_attributes:null}},sheet_state:'visible'};
  return{batch_id:stagingBatchId('a'.repeat(64)),sha256:'a'.repeat(64),filename:'synthetic.xlsx',mapping_version:'herbicide-summary-v1',extracted_at:'synthetic',
    quality:{macro_present:false,external_links_present:false,data_rows:0,sheets:[{name:'除草剂汇总表',nonempty_rows:1,state:'visible'}]},
    rows:[{sheet:'除草剂汇总表',excel_row:1,row_hash:createHash('sha256').update(pythonJson(raw)).digest('hex'),raw,mapped:{},state:'context',issues:[]}]};
}
test('staging deterministic batch agrees with Python UUIDv5 known contract',()=>{
  assert.equal(stagingBatchId('a'.repeat(64)),'865a60d5-861d-5835-a347-07aad5f03a95');
  validateIntakePayload(fixture());
});
test('staging payload corruption/incomplete batch rejected before SQL',async()=>{
  const cases=[p=>p.batch_id=randomUUID(),p=>p.sha256='b'.repeat(64),p=>p.rows[0].raw.cells.A1.value='changed',p=>p.rows.push(structuredClone(p.rows[0])),
    p=>p.rows[0].row_hash='c'.repeat(64),p=>p.quality.sheets[0].nonempty_rows=2,p=>p.rows[0].mapped={card_ready:true},
    p=>p.rows[0].excel_row=0,p=>p.rows[0].raw.cells.A1.value=3,p=>p.quality.macro_present=true,p=>p.rows=Array(10001).fill(p.rows[0]),p=>p.rows[0].raw.cells.A1.value='x'.repeat(8_000_001)];
  for(const mutate of cases){const p=fixture();mutate(p);await assert.rejects(importIntake({query(){assert.fail('bad intake reached SQL');}},randomUUID(),p),{code:'INVALID_REQUEST'});}
});
test('staging uses fixed SQL and whitelist receipt; driver error never leaks SQL/raw/DSN',async()=>{
  const p=fixture(),id=randomUUID();const r={operation_id:id,action:'import',batch_id:p.batch_id,generation:1,payload_hash:'b'.repeat(64),row_count:1,state:'imported',import_id:id,replayed:false};
  const actual=await importIntake({async query(sql,values){assert.equal(sql,'SELECT staging_intake.apply_import($1,$2::jsonb,$3) AS result');assert.equal(JSON.parse(values[1]).batch_id,p.batch_id);return{rows:[{result:{...r,raw:'DO_NOT_PRINT'}}]};}},id,p);
  assert.deepEqual(actual,r);
  for(const code of ['G0001','G0004','G0005','ECONNRESET'])await assert.rejects(importIntake({async query(){throw Object.assign(new Error('DO_NOT_PRINT raw SQL postgres://private'),{code});}},id,p),e=>!e.message.includes('DO_NOT_PRINT'));
  await assert.rejects(rollbackIntake({query(){assert.fail('invalid rollback reached SQL');}},id,p.batch_id,id,'bad'),{code:'INVALID_REQUEST'});
});
test('staging own database profile rejects source DB and any pg URL options before sockets',()=>{
  const base='postgres://synthetic:DO_NOT_PRINT@127.0.0.1:55431/gengyun_staging_intake_test';
  const client=new pg.Client({connectionString:validateStagingDatabaseUrl(base)});
  assert.equal(client.connectionParameters.host,'127.0.0.1');assert.equal(client.connectionParameters.database,'gengyun_staging_intake_test');
  assert.throws(()=>validateStagingDatabaseUrl(base.replace('staging_intake','source_ops')),{code:'INVALID_REQUEST'});
  const guard='data:text/javascript,'+encodeURIComponent("import net from 'node:net';net.Socket.prototype.connect=function(){process.stderr.write('UNEXPECTED_NETWORK');process.exit(77);};");
  for(const suffix of ['?host=example.invalid&port=6432','?%68ost=example.invalid','?HOST=example.invalid','?host=127.0.0.1&host=example.invalid','?hostaddr=192.0.2.1','?service=other','?sslkey=DO_NOT_READ','#fragment']){
    const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));env.DATABASE_URL=base+suffix;
    const p=spawnSync(process.execPath,['--import',guard,'tools/database/staging-intake.mjs','--action','rollback','--operation-id',randomUUID(),'--batch-id',randomUUID(),'--import-id',randomUUID(),'--payload-hash','a'.repeat(64)],{env,encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(p.status,1,p.stderr);assert.equal(JSON.parse(p.stderr).error.code,'INVALID_REQUEST');assert.equal((p.stdout+p.stderr).includes('DO_NOT_PRINT'),false);assert.equal((p.stdout+p.stderr).includes('UNEXPECTED_NETWORK'),false);
  }
});
