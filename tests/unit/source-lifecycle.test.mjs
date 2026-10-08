import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applySourceOperation } from '../../services/api/src/db/source-lifecycle.ts';
const input=()=>({operationId:randomUUID(),action:'withdraw',sourceId:randomUUID(),sourceVersionId:randomUUID(),expectedRevision:1,expectedValidity:'valid',reason:'synthetic'});
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
