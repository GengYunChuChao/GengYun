import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { applySourceOperation, validateSourceDatabaseUrl } from '../../services/api/src/db/source-lifecycle.ts';
const input=()=>({operationId:randomUUID(),action:'withdraw',sourceId:randomUUID(),sourceVersionId:randomUUID(),expectedRevision:1,expectedValidity:'valid',reason:'synthetic'});

test('source CLI authority matches actual pg parser; all override options rejected',()=>{
  const base='postgres://synthetic:DO_NOT_PRINT@127.0.0.1:55431/gengyun_source_ops_test';
  // Independent driver construction only, never connect: reproduces the original defect.
  const overridden=new pg.Client({connectionString:base+'?host=example.invalid&port=6432'});
  assert.equal(overridden.connectionParameters.host,'example.invalid');
  assert.equal(overridden.connectionParameters.port,6432);
  for(const host of ['127.0.0.1','localhost','[::1]']) for(const database of ['gengyun_source_ops_test','gengyun_local']) {
    const accepted=validateSourceDatabaseUrl(`postgresql://synthetic:DO_NOT_PRINT@${host}:55431/${database}`);
    const client=new pg.Client({connectionString:accepted});
    assert.equal(client.connectionParameters.host,host==='[::1]'?'::1':host);
    assert.equal(client.connectionParameters.port,55431);
    assert.equal(client.connectionParameters.database,database);
    assert.equal(client.connectionParameters.user,'synthetic');
  }
  for(const suffix of ['?host=example.invalid&port=6432','?%68ost=example.invalid','?host=%2Ftmp','?port=6432','?user=other','?sslkey=DO_NOT_READ','?options=-c%20search_path%3Dpublic','?','#ignored']) {
    assert.throws(()=>validateSourceDatabaseUrl(base+suffix),(e)=>e.code==='INVALID_REQUEST'&&!e.message.includes('DO_NOT_PRINT'));
  }
});

test('actual source CLI rejects pg overrides before any socket connection',()=>{
  // A preload turns ANY socket attempt into an offline test failure, including localhost.
  const guard='data:text/javascript,'+encodeURIComponent("import net from 'node:net'; net.Socket.prototype.connect=function(){process.stderr.write('UNEXPECTED_NETWORK');process.exit(77);};");
  for(const suffix of ['?host=example.invalid&port=6432','?%68ost=example.invalid','?host=%2Ftmp','?port=6432','?sslkey=DO_NOT_READ','#fragment']) {
    const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
    env.DATABASE_URL='postgres://synthetic:DO_NOT_PRINT@127.0.0.1/gengyun_source_ops_test'+suffix;
    const p=spawnSync(process.execPath,['--import',guard,'tools/database/source-lifecycle.mjs','--action','withdraw','--operation-id',randomUUID(),'--source-id',randomUUID(),'--source-version-id',randomUUID(),'--expected-revision','1','--expected-validity','valid','--reason','synthetic'],{env,encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(p.status,1,p.stderr);
    assert.equal(JSON.parse(p.stderr).error.code,'INVALID_REQUEST');
    assert.equal((p.stdout+p.stderr).includes('UNEXPECTED_NETWORK'),false);
    assert.equal((p.stdout+p.stderr).includes('DO_NOT_PRINT'),false);
    assert.equal(p.stdout,'');
  }
});
test('source operation validation fails before SQL',async()=>{
  for(const patch of [{operationId:'bad'},{expectedRevision:0},{expectedRevision:2147483647},{action:'set-valid'},{reason:' '},{reason:'a'.repeat(201)},{action:'restore'},{restoresOperationId:randomUUID()}]) {
    await assert.rejects(applySourceOperation({query(){assert.fail('invalid input reached SQL');}},{...input(),...patch}),{code:'INVALID_REQUEST'});
  }
});
test('source operation is parameterized and returns only function receipt',async()=>{
  const request=input();request.reason="synthetic '; SELECT private --";
  const receipt={operation_id:request.operationId,action:'withdraw',source_id:request.sourceId,source_version_id:request.sourceVersionId,resulting_revision:2,resulting_validity:'withdrawn',replayed:false};
  const result=await applySourceOperation({async query(text,values){assert.equal(text.includes(request.reason),false);assert.equal(values[6],request.reason);return{rows:[{result:{...receipt,unexpected_private:'hidden'}}]};}},request);
  assert.deepEqual(result,receipt);
});
test('missing or malformed receipt never pretends mutation succeeded',async()=>{
  for(const result of [null,undefined,{replayed:false}])await assert.rejects(applySourceOperation({async query(){return{rows:[{result}]};}},input()),{code:'PROVIDER_OUTCOME_UNKNOWN'});
});
test('database errors map fixed codes without driver DSN or SQL',async()=>{
  for(const [sql,code] of [['G0002','NOT_FOUND'],['G0003','REVISION_CONFLICT'],['G0004','SOURCE_CONFLICT'],['G0005','IDEMPOTENCY_CONFLICT'],['42501','PROVIDER_UNAVAILABLE'],['57014','PROVIDER_TIMEOUT'],['ECONNRESET','PROVIDER_OUTCOME_UNKNOWN']]) {
    await assert.rejects(applySourceOperation({async query(){throw Object.assign(new Error('PRIVATE_DSN secret SQL'),{code:sql});}},input()),(e)=>e.code===code&&!e.message.includes('PRIVATE_DSN'));
  }
});
