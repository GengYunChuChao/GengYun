import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserve, attempt, signRequest, AUTHORIZATION, TTS_RECHECK_AUTHORIZATION, RESOURCE_RECHECK_AUTHORIZATION, OCR_POSTPAID_AUTHORIZATION } from '../tools/verify-tencent-live.mjs';
const env = { TENCENTCLOUD_SECRET_ID: 'synthetic-id', TENCENTCLOUD_SECRET_KEY: 'synthetic-secret' };
const request = { endpoint: 'https://tts.tencentcloudapi.com', action: 'TextToVoice', apiVersion: '2019-08-23', timeoutMs: 8000, body: { Text: '你好，这是语音测试。' } };
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
  assert.equal((await run({Result:''})).state,'BUSINESS_SCHEMA_OR_EMPTY_ERROR');
  const r=await attempt({env,request,key:'tts',controlledFailure:true,fetchImpl:async()=>({ok:true,status:200,json:async()=>({Response:{Audio:'abcd'}})})}); assert.equal(r.state,'UNEXPECTED_CONTROL_ACCEPTED');
});
test('synthetic speech response is checked; timeout/network exceptions never leak or retry', async () => {
  let calls=0; const r=await attempt({env,request,key:'asr',fetchImpl:async()=>{calls++;throw Error('synthetic-secret');}}); assert.equal(calls,1);assert.equal(r.state,'OUTCOME_UNKNOWN');assert.equal(JSON.stringify(r).includes('synthetic-secret'),false);
  const a=await attempt({env,request,key:'asr',fetchImpl:async()=>({ok:true,status:200,json:async()=>({Response:{Result:'你好，这是语音测试。'}})})});assert.equal(a.expectedSyntheticTextMatched,true);assert.equal(a.syntheticTranscript,'你好，这是语音测试。');
});
