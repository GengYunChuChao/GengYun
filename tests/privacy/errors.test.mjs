import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrivacyError, toErrorEnvelope } from '../../packages/privacy/errors.mjs';

test('PrivacyError 封套保留契约错误码与受控 message', () => {
  const env = toErrorEnvelope(new PrivacyError('CONSENT_REQUIRED', '缺少用途授权：recording'), {
    request_id: 'req-1',
  });
  assert.equal(env.error.code, 'CONSENT_REQUIRED');
  assert.equal(env.error.message, '缺少用途授权：recording');
  assert.equal(env.meta.request_id, 'req-1');
});

test('P2-6 非契约错误不透出原始 message（防私有正文/坐标/凭据外泄）', () => {
  const secret = 'synthetic-private-marker-8f3a';
  const env = toErrorEnvelope(new Error(secret));
  assert.equal(env.error.message, '服务器内部错误');
  assert.equal(env.error.details.length, 0);
  const json = JSON.stringify(env);
  assert.equal(json.includes(secret), false);
});

test('P2-6 嵌套 SDK 错误（cause/originalError）不透出原文', () => {
  const cause = new Error('synthetic-nested-sdk-secret');
  const err = new TypeError('outer');
  err.cause = cause;
  err.originalError = { body: 'synthetic-private-body', token: 'tk-synthetic' };
  const json = JSON.stringify(toErrorEnvelope(err));
  assert.equal(json.includes('synthetic-nested-sdk-secret'), false);
  assert.equal(json.includes('synthetic-private-body'), false);
  assert.equal(json.includes('tk-synthetic'), false);
});

test('P2-6 字符串类型的未知异常也不透出原文', () => {
  const env = toErrorEnvelope('synthetic-string-secret');
  assert.equal(env.error.message, '服务器内部错误');
  assert.equal(JSON.stringify(env).includes('synthetic-string-secret'), false);
});
