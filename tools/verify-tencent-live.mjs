// Manual synthetic-input verification only; never used by application consumers.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadPrivateEnvironment, prepareOfflineRequest, providerFor } from './ai-config.mjs';
export const AUTHORIZATION = 'gy25-20261004-cny2';
export const TTS_RECHECK_AUTHORIZATION = 'gy25-20261004-cny2-tts-state-confirmed';
export const RESOURCE_RECHECK_AUTHORIZATION = 'gy25-20261004-cny2-all-state-confirmed';
export const PRICES = Object.freeze({ ocr: 0.5, asr: 0.0032, tts: 0.003, moderationText: 0.0025, moderationImage: 0.0025, weedRecognition: 0.2 });
const root = new URL('../.supervisor/gy25-live/', import.meta.url);
const hash = s => createHash('sha256').update(s).digest('hex');
const hmac = (k, s, encoding) => createHmac('sha256', k).update(s).digest(encoding);
export function signRequest(env, request, body, timestamp) {
  const service = new URL(request.endpoint).hostname.split('.')[0], host = service + '.tencentcloudapi.com';
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10), scope = date + '/' + service + '/tc3_request';
  const canonical = 'POST\n/\n\ncontent-type:application/json\nhost:' + host + '\n\ncontent-type;host\n' + hash(body);
  const signingKey = hmac(hmac(hmac('TC3' + env.TENCENTCLOUD_SECRET_KEY, date), service), 'tc3_request');
  return { 'Content-Type': 'application/json', Host: host,
    Authorization: 'TC3-HMAC-SHA256 Credential=' + env.TENCENTCLOUD_SECRET_ID + '/' + scope + ', SignedHeaders=content-type;host, Signature=' + hmac(signingKey, 'TC3-HMAC-SHA256\n' + timestamp + '\n' + scope + '\n' + hash(canonical), 'hex'),
    'X-TC-Action': request.action, 'X-TC-Version': request.apiVersion, 'X-TC-Region': 'ap-shanghai', 'X-TC-Timestamp': String(timestamp),
    ...(env.TENCENTCLOUD_SESSION_TOKEN ? { 'X-TC-Token': env.TENCENTCLOUD_SESSION_TOKEN } : {}) };
}
export function reserve(ledger, key, controlledFailure, authorization, resourceStateRecheck = false) {
  const recheckAuthorized = (authorization === TTS_RECHECK_AUTHORIZATION && key === 'tts') || (authorization === RESOURCE_RECHECK_AUTHORIZATION && ['tts', 'ocr', 'asr'].includes(key));
  if ((resourceStateRecheck ? !recheckAuthorized || controlledFailure : authorization !== AUTHORIZATION) || ledger.authorization !== AUTHORIZATION || !Object.hasOwn(PRICES, key) || (key === 'weedRecognition' && controlledFailure)) throw Error('MANUAL_AUTHORIZATION_REQUIRED');
  if (!Array.isArray(ledger.entries) || !Number.isFinite(ledger.reservedCny) || ledger.reservedCny < 0 || ledger.entries.some(x => !Object.hasOwn(PRICES, x.key) || typeof x.controlledFailure !== 'boolean' || x.reservedCny !== PRICES[x.key]) || Math.abs(ledger.entries.reduce((sum, x) => sum + x.reservedCny, 0) - ledger.reservedCny) > 0.000001) throw Error('LEDGER_INTEGRITY_REQUIRED');
  if (ledger.entries.some(x => x.key === key && x.controlledFailure === controlledFailure && Boolean(x.resourceStateRecheck) === resourceStateRecheck)) throw Error('ATTEMPT_ALREADY_RESERVED');
  if (resourceStateRecheck && !ledger.entries.some(x => x.key === key && !x.controlledFailure && !x.resourceStateRecheck && x.state === 'SERVICE_ERROR')) throw Error('PRIOR_SERVICE_ERROR_REQUIRED');
  if (controlledFailure && !ledger.entries.some(x => x.key === key && !x.controlledFailure && x.state === 'BUSINESS_RESPONSE')) throw Error('NORMAL_SUCCESS_REQUIRED');
  const cost = PRICES[key];
  if (ledger.entries.length >= 11 || (key !== 'weedRecognition' && ledger.entries.filter(x => x.key !== 'weedRecognition').length >= 10) || ledger.entries.filter(x => x.key === key).length >= (key === 'weedRecognition' ? 1 : 2) || ledger.reservedCny + cost > 2) throw Error('BUDGET_OR_COUNT_EXCEEDED');
  ledger.reservedCny = Number((ledger.reservedCny + cost).toFixed(6));
  const entry = { key, controlledFailure, ...(resourceStateRecheck ? { resourceStateRecheck: true } : {}), reservedCny: cost, state: 'OUTCOME_UNKNOWN', actualChargeCny: null };
  ledger.entries.push(entry); return entry;
}
const normalized = s => s.replace(/[\s，。,.！!]/g, '');
export async function attempt({ env, request, key, controlledFailure = false, fetchImpl = globalThis.fetch, saveAudio = () => {} }) {
  let payload = request.body;
  if (controlledFailure) {
    payload = { ...payload };
    if (key === 'ocr') payload.ImageBase64 = 'bm90LWFuLWltYWdl';
    if (key === 'asr') payload.VoiceFormat = 'synthetic-invalid';
    if (key === 'tts') payload.Text = '';
    if (key === 'moderationText') payload.Content = '';
    if (key === 'moderationImage') payload.FileContent = 'bm90LWFuLWltYWdl';
  }
  const body = JSON.stringify(payload), started = Date.now();
  try {
    const response = await fetchImpl(request.endpoint, { method: 'POST', body, headers: key === 'weedRecognition' ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.TOKENHUB_API_KEY } : signRequest(env, request, body, Math.floor(started / 1000)), redirect: 'manual', signal: AbortSignal.timeout(request.timeoutMs) });
    const report = { httpStatus: response.status, elapsedMs: Date.now() - started, actualChargeCny: null };
    const data = await response.json();
    if (!response.ok) return { ...report, state: 'HTTP_ERROR' };
    if (key === 'weedRecognition') {
      const content = data?.choices?.[0]?.message?.content, usage = data?.usage;
      if (data?.model !== 'hy-vision-2.0-instruct' || typeof content !== 'string' || !content.trim() || !Number.isInteger(usage?.prompt_tokens) || usage.prompt_tokens < 0 || usage.prompt_tokens > 24576 || !Number.isInteger(usage?.completion_tokens) || usage.completion_tokens < 0 || usage.completion_tokens > 128) return { ...report, state: 'BUSINESS_SCHEMA_OR_USAGE_ERROR' };
      return { ...report, state: 'BUSINESS_RESPONSE', responseFields: ['model', 'choices.message.content', 'usage'], model: data.model, nonemptyVisualResponse: true, syntheticTextMentioned: content.includes('12345') || content.includes('合成测试'), usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens }, usagePricedCny: Number((usage.prompt_tokens * 7.5 / 1000000 + usage.completion_tokens * 17.5 / 1000000).toFixed(6)), grassRecognitionVerified: false };
    }
    const result = data?.Response;
    if (typeof result?.RequestId === 'string' && /^[a-fA-F0-9-]{16,64}$/.test(result.RequestId)) report.requestId = result.RequestId;
    const code = result?.Error?.Code;
    if (typeof code === 'string') return { ...report, state: 'SERVICE_ERROR', errorCode: /^[A-Za-z0-9.]{1,100}$/.test(code) ? code : 'UNRECOGNIZED_ERROR' };
    if (controlledFailure) return { ...report, state: 'UNEXPECTED_CONTROL_ACCEPTED' };
    if (key === 'ocr' && Array.isArray(result?.TextDetections) && result.TextDetections.length && result.TextDetections.every(x => typeof x?.DetectedText === 'string')) {
      const text = result.TextDetections.map(x => x.DetectedText).join('');
      return { ...report, state: 'BUSINESS_RESPONSE', responseFields: ['TextDetections', 'RequestId'], detectionCount: result.TextDetections.length, expectedSyntheticTextMatched: normalized(text) === '合成测试你好编号12345' };
    }
    if (key === 'asr' && typeof result?.Result === 'string' && result.Result.trim()) {
      const matched = normalized(result.Result) === '你好这是语音测试';
      return { ...report, state: 'BUSINESS_RESPONSE', responseFields: ['Result', 'RequestId'], expectedSyntheticTextMatched: matched, ...(matched ? { syntheticTranscript: '你好，这是语音测试。' } : { transcriptNotPublished: true }) };
    }
    if (key === 'tts' && typeof result?.Audio === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(result.Audio) && result.Audio.length < 3000000) {
      const audio = Buffer.from(result.Audio, 'base64');
      if (audio.length) { saveAudio(audio); return { ...report, state: 'BUSINESS_RESPONSE', responseFields: ['Audio', 'SessionId', 'RequestId'], audioBytes: audio.length, playbackVerified: false }; }
    }
    if (key.startsWith('moderation') && ['Pass', 'Review', 'Block'].includes(result?.Suggestion) && typeof result?.Label === 'string') return { ...report, state: 'BUSINESS_RESPONSE', responseFields: ['Suggestion', 'Label', 'RequestId'], suggestion: result.Suggestion, safeSamplePassed: result.Suggestion === 'Pass' };
    return { ...report, state: 'BUSINESS_SCHEMA_OR_EMPTY_ERROR' };
  } catch (_) { return { state: 'OUTCOME_UNKNOWN', actualChargeCny: null }; }
}
async function main() {
  const args = process.argv.slice(2);
  if (![6, 7].includes(args.length) || args[0] !== '--manual-authorization' || args[2] !== '--endpoint' || args[4] !== '--credentials' || (args.length === 7 && !['--controlled-failure', '--resource-state-recheck'].includes(args[6]))) throw Error('MANUAL_ARGUMENTS_REQUIRED');
  const key = args[3], controlledFailure = args[6] === '--controlled-failure', resourceStateRecheck = args[6] === '--resource-state-recheck';
  if ((resourceStateRecheck ? !((args[1] === TTS_RECHECK_AUTHORIZATION && key === 'tts') || (args[1] === RESOURCE_RECHECK_AUTHORIZATION && ['tts','ocr','asr'].includes(key))) : args[1] !== AUTHORIZATION) || !Object.hasOwn(PRICES, key)) throw Error('MANUAL_AUTHORIZATION_REQUIRED');
  const config = JSON.parse(readFileSync(new URL('../docs/verification/config.local.json', import.meta.url), 'utf8'));
  const env = loadPrivateEnvironment(args[5]);
  const p = providerFor(config, key);
  if (key === 'weedRecognition') { if (!env.TOKENHUB_API_KEY) throw Error('MISSING_CREDENTIALS'); }
  else { if (!env[p?.secretIdEnv] || !env[p?.apiKeyEnv]) throw Error('MISSING_CREDENTIALS'); env.TENCENTCLOUD_SECRET_ID = env[p.secretIdEnv]; env.TENCENTCLOUD_SECRET_KEY = env[p.apiKeyEnv]; }
  // Only fixed local synthetic fixtures; no arbitrary media, remote URLs or application data.
  const input = { text: '你好，这是语音测试。' };
  if (['ocr', 'moderationImage', 'weedRecognition'].includes(key)) input.image = readFileSync(new URL('synthetic.png', root));
  if (key === 'asr') input.wav = readFileSync(new URL('synthetic-speech.wav', root));
  const manifest = JSON.parse(readFileSync(new URL('synthetic-manifest.json', root), 'utf8'));
  if (manifest.authorization !== AUTHORIZATION || manifest.nonpersonalSynthetic !== true || manifest.purpose !== 'manual_access_test') throw Error('SYNTHETIC_PURPOSE_REQUIRED');
  if (input.image && hash(input.image) !== manifest.imageSha256) throw Error('IMAGE_FIXTURE_MISMATCH');
  if (input.wav && hash(input.wav) !== manifest.wavSha256) throw Error('AUDIO_FIXTURE_MISMATCH');
  const request = prepareOfflineRequest(config, key, input);
  const ledgerFile = new URL('ledger.json', root), lockFile = new URL('process.lock', root);
  writeFileSync(lockFile, AUTHORIZATION, { flag: 'wx' }); // Crash leaves a lock: no automatic resumption/retry.
  let ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : { authorization: AUTHORIZATION, ceilingCny: 2, reservedCny: 0, entries: [] };
  const entry = reserve(ledger, key, controlledFailure, args[1], resourceStateRecheck);
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2)); // Reserve even unknown outcomes before sending.
  Object.assign(entry, await attempt({ env, request, key, controlledFailure, saveAudio: audio => writeFileSync(new URL('generated.mp3', root), audio) }));
  writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  const { unlinkSync } = await import('node:fs'); unlinkSync(lockFile);
  console.log(JSON.stringify({ authorization: AUTHORIZATION, attemptedRequests: ledger.entries.length, reservedCny: ledger.reservedCny, platformHardCapVerified: false, taskVerified: false, entry }, null, 2));
  process.exitCode = entry.state === 'BUSINESS_RESPONSE' || (controlledFailure && entry.state === 'SERVICE_ERROR') ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Manual verification stopped; private inputs and error details suppressed.'); process.exitCode = 1; });
