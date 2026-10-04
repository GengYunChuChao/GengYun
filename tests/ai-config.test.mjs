import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AI_ENDPOINTS, auditAIConfiguration, loadPrivateEnvironment, prepareOfflineRequest, describeOfflineRequest } from '../tools/ai-config.mjs';
const example = JSON.parse(readFileSync(new URL('../docs/verification/config.example.json', import.meta.url), 'utf8'));
const fixture = () => { const config = structuredClone(example); config.providers.moderation.bizType = 'synthetic_text'; config.providers.moderation.image.bizType = 'synthetic_image'; return config; };
const env = { TOKENHUB_API_KEY: 'synthetic-tokenhub-secret', DEEPSEEK_API_KEY: 'synthetic-deepseek-secret', TENCENTCLOUD_SECRET_ID: 'synthetic-id', TENCENTCLOUD_SECRET_KEY: 'synthetic-tencent-secret' };
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2kAAAAASUVORK5CYII=', 'base64');
function wav(seconds = 1) {
  const dataLength = seconds * 32000, result = Buffer.alloc(44 + dataLength);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8); result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22); result.writeUInt32LE(16000, 24); result.writeUInt32LE(32000, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(dataLength, 40);
  return result;
}
test('seven endpoints of six categories compile offline without secrets or execution', () => {
  const original = globalThis.fetch; globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
  try {
    const config = fixture(), report = auditAIConfiguration(config, env);
    assert.equal(report.categories, 6); assert.equal(report.endpointCount, 7); assert.equal(report.budgetLocked, true);
    for (const [key, row] of Object.entries(report.endpoints)) {
      assert.equal(row.parameterConfigurationComplete, true, key); assert.equal(row.credentialPresent, true); assert.equal(row.executionAllowed, false); assert.equal(row.capabilityVerified, false);
      const request = prepareOfflineRequest(config, key, { image, wav: wav(), text: '合成非个人验证文本' });
      assert.equal(request.endpoint, AI_ENDPOINTS[key].endpoint); assert.equal(request.maxRetries, 0); assert.equal(request.executionAllowed, false);
      const summary = describeOfflineRequest(request); assert.equal(summary.mode, 'OFFLINE_PREPARED'); assert.equal(summary.executionAllowed, false);
      for (const value of ['合成非个人验证文本', image.toString('base64'), ...Object.values(env)]) assert.equal(JSON.stringify(summary).includes(value), false);
    }
    for (const value of Object.values(env)) assert.equal(JSON.stringify(report).includes(value), false);
  } finally { globalThis.fetch = original; }
});
test('real example preserves missing TokenHub key and both BizTypes as blockers', () => {
  const report = auditAIConfiguration(example, { ...env, TOKENHUB_API_KEY: '' });
  assert.equal(report.endpoints.weedRecognition.credentialPresent, false);
  for (const key of ['moderationText', 'moderationImage']) { assert.equal(report.endpoints[key].parameterConfigurationComplete, false); assert.ok(report.endpoints[key].issues.includes('MISSING_OR_INVALID_BIZTYPE')); }
  assert.equal(report.executionAllowed, false);
});
test('endpoint credential exfiltration, old vision API, model substitution and automatic retries are rejected', () => {
  for (const endpoint of ['http://tokenhub.tencentmaas.com/v1/chat/completions', 'https://attacker.invalid', 'https://tokenhub.tencentmaas.com/v1/chat/completions?secret=synthetic', 'https://hunyuan.ai.tencentcloudapi.com']) {
    const config = fixture(); config.providers.weedRecognition.endpoint = endpoint;
    assert.throws(() => prepareOfflineRequest(config, 'weedRecognition', { image, text: 'synthetic' }), /ENDPOINT_NOT_ALLOWLISTED/);
  }
  const model = fixture(); model.providers.weedRecognition.model = 'deepseek-v4-pro';
  assert.throws(() => prepareOfflineRequest(model, 'weedRecognition', { image, text: 'synthetic' }), /MODEL_NOT_ALLOWLISTED/);
  const secret = fixture(); secret.providers.llm.apiKey = 'synthetic-private';
  assert.throws(() => prepareOfflineRequest(secret, 'llm', { text: 'synthetic' }), /INLINE_SECRET_FORBIDDEN/);
  const retry = fixture(); retry.providers.ocr.maxRetries = 1;
  assert.throws(() => prepareOfflineRequest(retry, 'ocr', { image }), /AUTOMATIC_RETRIES_DISABLED_REQUIRED/);
  const unsafe = fixture(); unsafe.budget.liveInferenceAllowed = true;
  assert.equal(auditAIConfiguration(unsafe, env).budgetLocked, false); assert.equal(auditAIConfiguration(unsafe, env).executionAllowed, false);
});
test('media and text constraints reject URL-only, oversized, wrong WAV and overlong input before dispatch', () => {
  const config = fixture();
  assert.throws(() => prepareOfflineRequest(config, 'ocr', { imageUrl: 'https://attacker.invalid/media' }), /IMAGE_SIZE_OR_TYPE_INVALID/);
  assert.throws(() => prepareOfflineRequest(config, 'ocr', { image: Buffer.alloc(2097153) }), /IMAGE_SIZE_OR_TYPE_INVALID/);
  assert.throws(() => prepareOfflineRequest(config, 'moderationImage', { image: Buffer.from('not-image') }), /IMAGE_HEADER_INVALID/);
  assert.throws(() => prepareOfflineRequest(config, 'asr', { wav: wav(61) }), /AUDIO_DURATION_EXCEEDED/);
  assert.throws(() => prepareOfflineRequest(config, 'asr', { wav: wav(74) }), /AUDIO_BASE64_TOO_LARGE/);
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  assert.throws(() => prepareOfflineRequest(config, 'asr', { wav: stereo }), /WAV_PROFILE_INVALID/);
  assert.throws(() => prepareOfflineRequest(config, 'tts', { text: '字'.repeat(101) }), /TEXT_SIZE_OR_TYPE_INVALID/);
  assert.throws(() => prepareOfflineRequest(config, 'llm', { text: '字'.repeat(201) }), /TEXT_SIZE_OR_TYPE_INVALID/);
  assert.throws(() => prepareOfflineRequest(config, 'UNKNOWN', {}), /UNKNOWN_CAPABILITY/);
});
test('ASR length is decoded bytes, TMS is UTF8 base64, images stay inline, output bounds remain explicit', () => {
  const config = fixture(), audio = wav();
  config.providers.moderation.bizType = 'synthetic-text'; config.providers.moderation.image.bizType = 'x';
  assert.equal(auditAIConfiguration(config, env).endpoints.moderationImage.parameterConfigurationComplete, true);
  const asr = prepareOfflineRequest(config, 'asr', { wav: audio });
  assert.equal(asr.body.DataLen, audio.length); assert.equal(asr.body.Data, audio.toString('base64')); assert.equal(asr.body.SourceType, 1);
  const tms = prepareOfflineRequest(config, 'moderationText', { text: '合成样例' }); assert.equal(Buffer.from(tms.body.Content, 'base64').toString('utf8'), '合成样例'); assert.equal(tms.body.Type, 'TEXT');
  const llm = prepareOfflineRequest(config, 'llm', { text: '合成样例' }); assert.equal(llm.body.max_tokens, 128); assert.deepEqual(llm.body.thinking, { type: 'disabled' });
  const vision = prepareOfflineRequest(config, 'weedRecognition', { text: '合成样例', image }); assert.ok(vision.body.messages[0].content[0].image_url.url.startsWith('data:image/png;base64,'));
});
test('private loading uses explicit account and allowlisted fields, suppressing raw JSON errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gy25-ai-'));
  try {
    const file = join(dir, 'synthetic.json'); writeFileSync(file, '{"secret":"sensitive-malformed');
    assert.throws(() => loadPrivateEnvironment(file), /^Error: PRIVATE_FILE_UNAVAILABLE$/);
    writeFileSync(file, JSON.stringify({ appid: 'wrong', tokenhubApiKey: 'synthetic-key' })); assert.throws(() => loadPrivateEnvironment(file), /PRIVATE_ACCOUNT_MISMATCH/);
    writeFileSync(file, JSON.stringify({ appid: 'wx4407a4b908a69a54', tokenhubApiKey: 'synthetic-tokenhub', tencentSessionToken: 'synthetic-session', unexpectedSecret: 'ignore-me' }));
    const loaded = loadPrivateEnvironment(file); assert.equal(loaded.TOKENHUB_API_KEY, 'synthetic-tokenhub'); assert.equal(loaded.TENCENTCLOUD_SESSION_TOKEN, 'synthetic-session'); assert.equal(loaded.unexpectedSecret, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
