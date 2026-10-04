import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { reserve, attempt, signRequest, resolveTc3Credentials, AUTHORIZATION, TTS_RECHECK_AUTHORIZATION, RESOURCE_RECHECK_AUTHORIZATION, OCR_POSTPAID_AUTHORIZATION } from '../tools/verify-tencent-live.mjs';
const env = { TENCENTCLOUD_SECRET_ID: 'synthetic-id', TENCENTCLOUD_SECRET_KEY: 'synthetic-secret' };
const request = { endpoint: 'https://tts.tencentcloudapi.com', action: 'TextToVoice', apiVersion: '2019-08-23', timeoutMs: 8000, body: { Text: '你好，这是语音测试。', SessionId: 'gy25-offline' } };
const requestId = '01234567-89ab-cdef-0123-456789abcdef';
const ledger = () => ({ authorization: AUTHORIZATION, reservedCny: 0, entries: [] });
test('manual authorization, one reservation per case, unknown outcomes and cap prevent repeated charges', () => {
  const l = ledger(); assert.throws(() => reserve(l, 'tts', false, ''), /MANUAL_AUTHORIZATION/);
  reserve(l, 'tts', false, AUTHORIZATION); assert.throws(() => reserve(l, 'tts', false, AUTHORIZATION), /ALREADY_RESERVED/);
  assert.throws(() => reserve(l, 'tts', true, AUTHORIZATION), /NORMAL_SUCCESS/);
  assert.throws(() => reserve(l, 'llm', false, AUTHORIZATION), /MANUAL_AUTHORIZATION/);
  l.reservedCny = 2; assert.throws(() => reserve(l, 'ocr', false, AUTHORIZATION), /LEDGER_INTEGRITY/);
  const full=ledger(); full.entries=Array.from({length:4},()=>({key:'ocr',controlledFailure:false,reservedCny:0.5}));full.reservedCny=2;
  assert.throws(()=>reserve(full,'asr',false,AUTHORIZATION),/BUDGET/);
  const retry=ledger(); reserve(retry,'tts',false,AUTHORIZATION).state='SERVICE_ERROR';
  assert.throws(()=>reserve(retry,'tts',false,AUTHORIZATION,true),/MANUAL_AUTHORIZATION/);
  reserve(retry,'tts',false,TTS_RECHECK_AUTHORIZATION,true);
  assert.throws(()=>reserve(retry,'tts',false,TTS_RECHECK_AUTHORIZATION,true),/ALREADY_RESERVED/);
  const updated=ledger(); reserve(updated,'asr',false,AUTHORIZATION).state='SERVICE_ERROR';reserve(updated,'asr',false,RESOURCE_RECHECK_AUTHORIZATION,true);
  assert.throws(()=>reserve(updated,'asr',false,RESOURCE_RECHECK_AUTHORIZATION,true),/ALREADY_RESERVED/);
  const ocr=ledger();reserve(ocr,'ocr',false,AUTHORIZATION).state='SERVICE_ERROR';Object.assign(reserve(ocr,'ocr',false,RESOURCE_RECHECK_AUTHORIZATION,true),{state:'SERVICE_ERROR',errorCode:'ResourceUnavailable.ResourcePackageRunOut'});
  assert.throws(()=>reserve(ocr,'ocr',false,RESOURCE_RECHECK_AUTHORIZATION,false,true),/MANUAL_AUTHORIZATION/);
  reserve(ocr,'ocr',false,OCR_POSTPAID_AUTHORIZATION,false,true);assert.equal(ocr.reservedCny,1.5);
  assert.throws(()=>reserve(ocr,'ocr',false,OCR_POSTPAID_AUTHORIZATION,false,true),/ALREADY_RESERVED/);
});
test('vision uses a separate Bearer key, checks bounded usage, and consumes only one shared-budget slot', async () => {
  const l=ledger();reserve(l,'weedRecognition',false,AUTHORIZATION);assert.throws(()=>reserve(l,'weedRecognition',true,AUTHORIZATION),/MANUAL_AUTHORIZATION/);
  assert.throws(()=>reserve(l,'weedRecognition',false,AUTHORIZATION),/ALREADY_RESERVED/);
  const vision={endpoint:'https://tokenhub.tencentmaas.com/v1/chat/completions',timeoutMs:20000,body:{model:'hy-vision-2.0-instruct',max_tokens:128}};
  const fetchImpl=async(url,options)=>{assert.equal(url,vision.endpoint);assert.equal(options.headers.Authorization,'Bearer synthetic-vision');assert.equal(options.redirect,'manual');return {ok:true,status:200,json:async()=>({model:'hy-vision-2.0-instruct',choices:[{message:{content:'合成测试 12345'}}],usage:{prompt_tokens:302,completion_tokens:128}})};};
  const report=await attempt({env:{...env,TOKENHUB_API_KEY:'synthetic-vision'},request:vision,key:'weedRecognition',fetchImpl});assert.equal(report.state,'BUSINESS_RESPONSE');assert.equal(report.grassRecognitionVerified,false);assert.equal(report.usagePricedCny,0.004505);assert.equal(JSON.stringify(report).includes('synthetic-vision'),false);
});
test('TC3 signature binds actual body and fixed endpoint; credential values are only in headers', () => {
  const a=signRequest(env,request,'{"Text":"a"}',1700000000),b=signRequest(env,request,'{"Text":"b"}',1700000000);
  assert.notEqual(a.Authorization,b.Authorization); assert.equal(a.Host,'tts.tencentcloudapi.com'); assert.equal(a['X-TC-Action'],'TextToVoice'); assert.equal(a.Authorization.includes(env.TENCENTCLOUD_SECRET_KEY),false);
});
test('HTTP200 service errors, empty ASR and unexpected control acceptance never count as success', async () => {
  const run = body => attempt({env,request,key:'asr',fetchImpl:async()=>({ok:true,status:200,json:async()=>({Response:body})})});
  assert.equal((await run({Error:{Code:'AuthFailure.UnauthorizedOperation',Message:'synthetic-secret'}})).state,'SERVICE_ERROR');
  assert.equal((await run({RequestId:requestId,Result:''})).state,'BUSINESS_SCHEMA_OR_EMPTY_ERROR');
  const r=await attempt({env,request,key:'tts',controlledFailure:true,fetchImpl:async()=>({ok:true,status:200,json:async()=>({Response:{RequestId:requestId,Audio:'abcd'}})})}); assert.equal(r.state,'UNEXPECTED_CONTROL_ACCEPTED');
});
test('synthetic speech response is checked; timeout/network exceptions never leak or retry', async () => {
  let calls=0; const r=await attempt({env,request,key:'asr',fetchImpl:async()=>{calls++;throw Error('synthetic-secret');}}); assert.equal(calls,1);assert.equal(r.state,'OUTCOME_UNKNOWN');assert.equal(JSON.stringify(r).includes('synthetic-secret'),false);
  const a=await attempt({env,request,key:'asr',fetchImpl:async()=>({ok:true,status:200,json:async()=>({Response:{RequestId:requestId,Result:'你好，这是语音测试。'}})})});assert.equal(a.expectedSyntheticTextMatched,true);assert.equal(a.syntheticTranscript,'你好，这是语音测试。');
});
test('TC3 selection keeps ID, key and token in one source with all real network entry points blocked', async () => {
  const originals={fetch:globalThis.fetch,hr:http.request,hg:http.get,sr:https.request,sg:https.get};
  const blocked=()=>{throw Error('REAL_NETWORK_FORBIDDEN');}; globalThis.fetch=http.request=http.get=https.request=https.get=blocked;
  try {
    const shared={secretIdEnv:'TENCENTCLOUD_SECRET_ID',apiKeyEnv:'TENCENTCLOUD_SECRET_KEY'},dedicated={secretIdEnv:'TENCENTCLOUD_ASR_SECRET_ID',apiKeyEnv:'TENCENTCLOUD_ASR_SECRET_KEY'};
    const both={...env,TENCENTCLOUD_SESSION_TOKEN:'synthetic-shared-token',TENCENTCLOUD_ASR_SECRET_ID:'synthetic-asr-id',TENCENTCLOUD_ASR_SECRET_KEY:'synthetic-asr-key'};
    const asr={...request,endpoint:'https://asr.tencentcloudapi.com',action:'SentenceRecognition',apiVersion:'2019-06-14'};
    async function headersFor(source,provider) {
      let headers;
      await attempt({env:resolveTc3Credentials(source,provider),request:asr,key:'asr',fetchImpl:async(_,options)=>{headers=options.headers;return {ok:true,status:200,json:async()=>({Response:{RequestId:requestId,Result:'你好，这是语音测试。'}})};}});
      return headers;
    }
    const long=await headersFor(both,dedicated);assert.equal(long['X-TC-Token'],undefined);assert.ok(long.Authorization.includes('Credential=synthetic-asr-id/'));
    const temporary=await headersFor({...both,TENCENTCLOUD_ASR_SESSION_TOKEN:'synthetic-asr-token'},dedicated);assert.equal(temporary['X-TC-Token'],'synthetic-asr-token');
    const common=await headersFor(both,shared);assert.equal(common['X-TC-Token'],'synthetic-shared-token');assert.ok(common.Authorization.includes('Credential=synthetic-id/'));
    for (const missing of ['TENCENTCLOUD_ASR_SECRET_ID','TENCENTCLOUD_ASR_SECRET_KEY']) {
      const incomplete={...both};delete incomplete[missing];assert.throws(()=>resolveTc3Credentials(incomplete,dedicated),/MISSING_TC3_CREDENTIAL_PAIR/);
    }
    assert.equal(both.TENCENTCLOUD_SESSION_TOKEN,'synthetic-shared-token');
  } finally {globalThis.fetch=originals.fetch;http.request=originals.hr;http.get=originals.hg;https.request=originals.sr;https.get=originals.sg;}
});
test('RequestId presence and type govern traceable success for each TC3 business response', async () => {
  const bodies={ocr:{TextDetections:[{DetectedText:'合成测试你好编号12345'}]},asr:{Result:'你好，这是语音测试。'},tts:{Audio:'YWJjZA==',SessionId:request.body.SessionId},moderationText:{Suggestion:'Pass',Label:'Normal'},moderationImage:{Suggestion:'Pass',Label:'Normal'}};
  for (const [key,body] of Object.entries(bodies)) {
    for (const id of [undefined,'','   ',17,null,{},'unsafe/id']) {
      const r=await attempt({env,request,key,fetchImpl:async()=>({ok:true,status:200,json:async()=>({Response:{...body,RequestId:id}})})});
      assert.equal(r.state,'RESPONSE_EVIDENCE_INCOMPLETE',key);assert.equal(r.responseFields.includes('RequestId'),false);assert.equal(r.requestId,undefined);assert.equal(r.actualChargeCny,null);
    }
    const r=await attempt({env,request,key,fetchImpl:async()=>({ok:true,status:200,json:async()=>({Response:{...body,RequestId:requestId}})})});
    assert.equal(r.state,'BUSINESS_RESPONSE',key);assert.equal(r.requestId,requestId);assert.ok(r.responseFields.includes('RequestId'));
  }
});
test('TTS verifies its nonempty SessionId echo and Audio independently; incomplete evidence is not saved or retried', async () => {
  for (const session of [undefined,'','   ',17,null,{},'another-session']) {
    let saved=0,calls=0;const l=ledger(),entry=reserve(l,'tts',false,AUTHORIZATION);
    Object.assign(entry,await attempt({env,request,key:'tts',saveAudio:()=>saved++,fetchImpl:async()=>{calls++;return {ok:true,status:200,json:async()=>({Response:{RequestId:requestId,SessionId:session,Audio:'YWJjZA=='}})};}}));
    assert.equal(entry.state,'RESPONSE_EVIDENCE_INCOMPLETE');assert.equal(entry.responseFields.includes('SessionId'),false);assert.ok(entry.responseFields.includes('Audio'));assert.equal(saved,0);assert.equal(calls,1);assert.equal(l.reservedCny,0.003);assert.equal(entry.actualChargeCny,null);
    assert.throws(()=>reserve(l,'tts',false,AUTHORIZATION),/ALREADY_RESERVED/);assert.throws(()=>reserve(l,'tts',true,AUTHORIZATION),/NORMAL_SUCCESS/);
  }
  for (const audio of [undefined,'','%%%!',17,null]) {
    const r=await attempt({env,request,key:'tts',fetchImpl:async()=>({ok:true,status:200,json:async()=>({Response:{RequestId:requestId,SessionId:request.body.SessionId,Audio:audio}})})});
    assert.equal(r.state,'BUSINESS_SCHEMA_OR_EMPTY_ERROR');assert.ok(r.responseFields.includes('SessionId'));assert.equal(r.responseFields.includes('Audio'),false);
  }
  let saved=0;const r=await attempt({env,request,key:'tts',saveAudio:()=>saved++,fetchImpl:async()=>({ok:true,status:200,json:async()=>({Response:{RequestId:requestId,SessionId:request.body.SessionId,Audio:'YWJjZA=='}})})});
  assert.equal(r.state,'BUSINESS_RESPONSE');assert.equal(saved,1);assert.deepEqual(r.responseFields,['RequestId','SessionId','Audio']);
});
test('service errors keep their classification without inventing traceability fields', async () => {
  for (const id of [undefined,'',17,requestId]) {
    const r=await attempt({env,request,key:'tts',controlledFailure:true,fetchImpl:async()=>({ok:true,status:200,json:async()=>({Response:{RequestId:id,Error:{Code:'UnsupportedOperation.PkgExhausted',Message:'synthetic-private-secret'}}})})});
    assert.equal(r.state,'SERVICE_ERROR');assert.equal(r.errorCode,'UnsupportedOperation.PkgExhausted');assert.equal(r.responseFields.includes('RequestId'),id===requestId);assert.equal(JSON.stringify(r).includes('synthetic-private-secret'),false);
  }
});
