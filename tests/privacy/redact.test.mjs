import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactForLog, assertNoSensitiveLeak } from '../../packages/privacy/redact.mjs';

test('凭据被脱敏（token/password/secret/authorization 等键）', () => {
  const input = {
    authorization: 'Bearer abc.def.ghi',
    access_token: 'tk-123456',
    password: 'hunter2',
    api_key: 'sk-secret',
    credential_hash: 'a'.repeat(64),
  };
  const out = redactForLog(input);
  assert.equal(out.authorization, '[REDACTED]');
  assert.equal(out.access_token, '[REDACTED]');
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.api_key, '[REDACTED]');
  assert.equal(out.credential_hash, '[REDACTED]');
});

test('私有正文被脱敏（body/text/transcription 等键）', () => {
  const input = {
    body: '我的家庭住址是……',
    raw_text: '用户私密语音转写内容',
    confirmed_text: '确认后的私密文字',
  };
  const out = redactForLog(input);
  assert.equal(out.body, '[REDACTED]');
  assert.equal(out.raw_text, '[REDACTED]');
  assert.equal(out.confirmed_text, '[REDACTED]');
});

test('图片/音频（data URI / 长 base64 / media 键）被脱敏', () => {
  const input = {
    media: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
    audio: Buffer.from('fake-audio-bytes'.repeat(30)).toString('base64'),
    object_ref_cipher: 'opaque://bucket/key',
  };
  const out = redactForLog(input);
  assert.equal(out.media, '[REDACTED]');
  assert.equal(out.audio, '[REDACTED]');
  assert.equal(out.object_ref_cipher, '[REDACTED]');
});

test('精确坐标被脱敏（lat/lng 键 + 坐标对字符串）', () => {
  const input = {
    lat: 30.274158,
    lng: 120.155070,
    coordinates: '30.274158, 120.155070',
  };
  const out = redactForLog(input);
  assert.equal(out.lat, '[REDACTED]');
  assert.equal(out.lng, '[REDACTED]');
  assert.equal(out.coordinates, '[REDACTED]');
});

test('非敏感字段保留（purpose/epoch/state 不被误伤）', () => {
  const input = {
    purpose: 'recording',
    epoch: 3,
    state: 'granted',
    recipientId: 'provider-llm',
  };
  const out = redactForLog(input);
  assert.deepEqual(out, input);
});

test('嵌套对象递归脱敏', () => {
  const input = {
    meta: { request_id: 'req-1', execution_mode: 'real' },
    request: { headers: { authorization: 'Bearer xyz' }, body: 'private' },
  };
  const out = redactForLog(input);
  assert.equal(out.request.headers.authorization, '[REDACTED]');
  assert.equal(out.request.body, '[REDACTED]');
  assert.equal(out.meta.request_id, 'req-1');
});

test('assertNoSensitiveLeak 检测泄漏片段', () => {
  // secret 键会被脱敏，片段不应泄漏
  assert.deepEqual(assertNoSensitiveLeak({ secret: 'super-secret-value' }, ['super-secret-value']), { ok: true });
  // 非敏感键下的原文未被键名层拦截时，工具应报告泄漏（用于运行期自检）
  const leak = assertNoSensitiveLeak({ note: 'here is abc12345678901234567890' }, ['abc12345678901234567890']);
  assert.equal(leak.ok, false);
  assert.equal(leak.leaked, 'abc12345678901234567890');
});

test('Bearer token 与高精度坐标对字符串值被脱敏', () => {
  const out = redactForLog({ a: 'Bearer abcdefghijklmnop', b: '30.123456,120.654321' });
  assert.equal(out.a, '[REDACTED]');
  assert.equal(out.b, '[REDACTED]');
});

// ---- P2-6：camelCase 字段脱敏 ----

test('P2-6 camelCase 字段命中脱敏（appSecret/rawText/providerRequestRefCipher 等）', () => {
  const input = {
    appSecret: 'synthetic-app-secret',
    rawText: 'synthetic-private-transcript',
    providerRequestRefCipher: 'opaque://provider/request',
    accessToken: 'tk-synthetic',
    wechatSubjectCipher: 'cipher-synthetic',
  };
  const out = redactForLog(input);
  assert.equal(out.appSecret, '[REDACTED]');
  assert.equal(out.rawText, '[REDACTED]');
  assert.equal(out.providerRequestRefCipher, '[REDACTED]');
  assert.equal(out.accessToken, '[REDACTED]');
  assert.equal(out.wechatSubjectCipher, '[REDACTED]');
});
