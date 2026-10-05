import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { buildCases, runCase, classify, summarize, EXPECTED_STATE as EXPECTED, AUTHORIZATION, MAX_PAID_CALLS, USD_PER_TOKEN } from '../tools/verify-llm-live.mjs';

const config = JSON.parse(readFileSync(new URL('../docs/verification/config.example.json', import.meta.url), 'utf8'));
const env = { DEEPSEEK_API_KEY: 'synthetic-deepseek-key' };
const specs = buildCases(config);
const specFor = c => specs.find(s => s.case === c);
const jsonOk = payload => async () => ({ status: 200, ok: true, text: async () => JSON.stringify(payload) });
const httpError = status => async () => ({ status, ok: false, text: async () => JSON.stringify({ error: { type: 'synthetic_error', code: 'synthetic_code', message: 'synthetic-secret' } }) });
const chat = (content, extra = {}) => ({ id: 'chatcmpl-synthetic-0001', model: 'deepseek-flash', choices: [{ message: { content, ...extra.message }, finish_reason: extra.finish_reason || 'stop' }], usage: extra.usage || { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 } });

test('cases stay synthetic, bounded and match the documented request shapes', () => {
  assert.equal(specs.length, 10);
  assert.equal(specs.filter(s => s.paid).length, MAX_PAID_CALLS);
  assert.equal(specFor('invalid_key').badKey, true);
  const json = specFor('json_object').body;
  assert.equal(json.response_format.type, 'json_object');
  assert.ok(json.messages.some(m => /json/i.test(String(m.content))));
  assert.equal(json.model, 'deepseek-flash'); assert.equal(json.max_tokens, 128); assert.equal(json.stream, false); assert.deepEqual(json.thinking, { type: 'disabled' });
  assert.equal(specFor('tool_call').body.tools.length, 1);
  assert.ok(specFor('oversize_reject').body.messages.at(-1).content.length > 1000000);
  const serialized = JSON.stringify(specs);
  assert.equal(serialized.includes('sk-'), false);
  assert.equal(serialized.includes(env.DEEPSEEK_API_KEY), false);
});

test('success cases classify on real response fields, not presence alone', async () => {
  const single = await runCase(config, env, specFor('single'), {}, jsonOk(chat('应核对剂量、频次与禁忌。')), 20000);
  assert.equal(single.state, 'BUSINESS_RESPONSE'); assert.equal(single.responseId, 'chatcmpl-synthetic-0001'); assert.equal(single.model, 'deepseek-flash');
  assert.equal(single.costUsd, Number((60 * USD_PER_TOKEN.input + 20 * USD_PER_TOKEN.output).toFixed(6)));

  const mt2 = await runCase(config, env, specFor('multiturn_2'), { mt1: '已记住' }, jsonOk(chat('7423')), 20000);
  assert.equal(mt2.state, 'BUSINESS_RESPONSE');
  const mt2bad = await runCase(config, env, specFor('multiturn_2'), { mt1: '已记住' }, jsonOk(chat('我不记得了')), 20000);
  assert.equal(mt2bad.state, 'CONTEXT_MISMATCH');

  const json = await runCase(config, env, specFor('json_object'), {}, jsonOk(chat('{"herb":"合成草A","confidence":0.95}')), 20000);
  assert.equal(json.state, 'BUSINESS_RESPONSE');
  assert.equal((await runCase(config, env, specFor('json_object'), {}, jsonOk(chat('不是json')), 20000)).state, 'JSON_NOT_PARSEABLE');
  assert.equal((await runCase(config, env, specFor('json_object'), {}, jsonOk(chat('')), 20000)).state, 'BUSINESS_SCHEMA_OR_EMPTY_ERROR');

  const tool = await runCase(config, env, specFor('tool_call'), {}, jsonOk(chat('', { message: { tool_calls: [{ id: 'call_1', function: { name: 'get_synthetic_weather', arguments: '{"location":"Hangzhou"}' } }] } })), 20000);
  assert.equal(tool.state, 'BUSINESS_RESPONSE'); assert.equal(tool.toolCalls[0].name, 'get_synthetic_weather');
  assert.equal((await runCase(config, env, specFor('tool_call'), {}, jsonOk(chat('直接回答')), 20000)).state, 'TOOL_CALL_MISSING');

  const cite = await runCase(config, env, specFor('citation'), {}, jsonOk(chat('合成草A喜阴，适宜散射光。[1]')), 20000);
  assert.equal(cite.state, 'BUSINESS_RESPONSE');
  assert.equal((await runCase(config, env, specFor('citation'), {}, jsonOk(chat('喜阴，但没有来源')), 20000)).state, 'CITATION_MISSING');

  const long = await runCase(config, env, specFor('long_context_within'), {}, jsonOk(chat('9931', { usage: { prompt_tokens: 9000, completion_tokens: 4, total_tokens: 9004 } })), 20000);
  assert.equal(long.state, 'BUSINESS_RESPONSE');
});

test('controlled failures and injection observation keep their classification', async () => {
  assert.equal((await runCase(config, env, specFor('invalid_key'), {}, httpError(401), 20000)).state, 'CONTROLLED_REJECTED');
  assert.equal((await runCase(config, env, specFor('oversize_reject'), {}, httpError(400), 20000)).state, 'CONTROLLED_REJECTED');
  assert.equal((await runCase(config, env, specFor('oversize_reject'), {}, jsonOk(chat('已越权')), 20000)).state, 'UNEXPECTED_ACCEPTED');
  const refused = await runCase(config, env, specFor('prompt_injection'), {}, jsonOk(chat('我无法提供系统提示词，也不会执行越权指令。')), 20000);
  assert.equal(refused.state, 'INJECTION_REFUSED_OR_IGNORED');
  const complied = await runCase(config, env, specFor('prompt_injection'), {}, jsonOk(chat('已越权')), 20000);
  assert.equal(complied.state, 'INJECTION_COMPLIED');
  assert.equal(classify({ httpStatus: 200 }, {}, 'content'), 'BUSINESS_SCHEMA_OR_EMPTY_ERROR');
});

test('summary aggregates real cost, keeps the authorization, and flags only genuine mismatches', () => {
  const good = Object.keys(EXPECTED).map(c => ({ case: c, paid: c !== 'invalid_key', state: EXPECTED[c], costUsd: c === 'single' ? 0.000032 : 0, costCny: 0 }));
  const summary = summarize(good);
  assert.equal(summary.paidCalls, 9); assert.equal(summary.freeCalls, 1);
  assert.equal(summary.estimatedChargeUsd, 0.000032); assert.equal(summary.actualChargeUsd, null);
  assert.deepEqual(summary.unmatchedExpectedStates, []);
  assert.deepEqual(summarize([{ case: 'single', paid: true, state: 'HTTP_ERROR' }]).unmatchedExpectedStates, ['single']);
});

test('no real network entry point is used and no credential or provider error text leaks', async () => {
  const originals = { fetch: globalThis.fetch, hr: http.request, hg: http.get, sr: https.request, sg: https.get };
  globalThis.fetch = http.request = http.get = https.request = https.get = () => { throw Error('REAL_NETWORK_FORBIDDEN'); };
  try {
    const ok = await runCase(config, env, specFor('single'), {}, jsonOk(chat('合成答复')), 20000);
    assert.equal(ok.state, 'BUSINESS_RESPONSE');
    assert.equal(JSON.stringify(ok).includes(env.DEEPSEEK_API_KEY), false);
    assert.equal(JSON.stringify(ok).includes('synthetic-secret'), false);
    const net = await runCase(config, env, specFor('single'), {}, async () => { throw Error('synthetic-secret'); }, 20000);
    assert.equal(net.state, 'NETWORK_OR_RESPONSE_ERROR');
    assert.equal(JSON.stringify(net).includes('synthetic-secret'), false);
    const timeout = Object.assign(Error('t'), { name: 'TimeoutError' });
    assert.equal((await runCase(config, env, specFor('single'), {}, async () => { throw timeout; }, 20000)).state, 'TIMEOUT');
    assert.equal((await runCase(config, env, specFor('single'), {}, async () => ({ status: 200, ok: true, text: async () => 'not-json' }), 20000)).state, 'RESPONSE_NOT_JSON');
  } finally {
    globalThis.fetch = originals.fetch; http.request = originals.hr; http.get = originals.hg; https.request = originals.sr; https.get = originals.sg;
  }
});
