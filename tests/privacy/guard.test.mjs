import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createPrivacyGuard } from '../../packages/privacy/guard.mjs';
import { PrivacyError } from '../../packages/privacy/errors.mjs';
import { createAccountProvider } from './_fixtures.mjs';

async function setup() {
  const account = createAccountProvider({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const guard = createPrivacyGuard({ account, consentStore });
  return { account, consentStore, guard };
}

test('无授权触发 CONSENT_REQUIRED（系统权限不能替代用途授权）', async () => {
  const { guard } = await setup();
  await assert.rejects(
    () => guard.assertConsent({ userId: 'u1', purpose: 'recording', dataType: 'voice_question' }),
    (err) => err instanceof PrivacyError && err.code === 'CONSENT_REQUIRED' && err.status === 403,
  );
});

test('授权齐全后通过，返回 consentEpoch', async () => {
  const { guard, consentStore } = await setup();
  for (const p of ['recording', 'media_processing', 'external_inference']) {
    await consentStore.grant({ userId: 'u1', purpose: p, policyVersion: '1.0.0', recipientIds: [] });
  }
  const res = await guard.assertConsent({ userId: 'u1', purpose: 'recording', dataType: 'voice_question' });
  assert.equal(res.consentEpoch, 1);
});

test('错用途（purpose 不属于资料类型必需集合）触发 SCOPE_DENIED', async () => {
  const { guard, consentStore } = await setup();
  // 录音用途 voice_question 需要 recording/media_processing/external_inference，public_posting 属错用途
  await consentStore.grant({ userId: 'u1', purpose: 'public_posting', policyVersion: '1.0.0', recipientIds: [] });
  await assert.rejects(
    () => guard.assertConsent({ userId: 'u1', purpose: 'public_posting', dataType: 'voice_question' }),
    (err) => err instanceof PrivacyError && err.code === 'SCOPE_DENIED',
  );
});

test('资料类型需要多用途，缺任一即 CONSENT_REQUIRED', async () => {
  const { guard, consentStore } = await setup();
  // voice_question 需要 recording + media_processing + external_inference
  await consentStore.grant({ userId: 'u1', purpose: 'recording', policyVersion: '1.0.0', recipientIds: [] });
  await consentStore.grant({ userId: 'u1', purpose: 'media_processing', policyVersion: '1.0.0', recipientIds: [] });
  // 缺 external_inference
  await assert.rejects(
    () => guard.assertConsent({ userId: 'u1', purpose: 'recording', dataType: 'voice_question' }),
    (err) => err instanceof PrivacyError && err.code === 'CONSENT_REQUIRED',
  );
});

test('账号非活跃触发 ACCOUNT_INACTIVE（注销/停用/待删除）', async () => {
  const { guard, account, consentStore } = await setup();
  await consentStore.grant({ userId: 'u1', purpose: 'recording', policyVersion: '1.0.0', recipientIds: [] });
  account.set('u1', { state: 'deletion_pending' });
  await assert.rejects(
    () => guard.assertConsent({ userId: 'u1', purpose: 'recording', dataType: 'voice_question' }),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
});

test('auth_epoch 变更触发 ACCOUNT_INACTIVE（注销递增 auth_epoch）', async () => {
  const { guard, account, consentStore } = await setup();
  await consentStore.grant({ userId: 'u1', purpose: 'recording', policyVersion: '1.0.0', recipientIds: [] });
  account.set('u1', { authEpoch: 2 });
  await assert.rejects(
    () => guard.assertAccountActive('u1', { authEpoch: 1 }),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
});

test('requireConsent 中间件可注入身份上下文（不依赖微信登录）', async () => {
  const { guard, consentStore } = await setup();
  for (const p of ['recording', 'media_processing', 'external_inference']) {
    await consentStore.grant({ userId: 'u1', purpose: p, policyVersion: '1.0.0', recipientIds: [] });
  }
  const middleware = guard.requireConsent({ purpose: 'recording', dataType: 'voice_question' });
  const res = await middleware({ userId: 'u1', authEpoch: 1 });
  assert.equal(res.consentEpoch, 1);
});

test('requireConsent 缺少身份上下文触发 SESSION_REQUIRED', async () => {
  const { guard } = await setup();
  const middleware = guard.requireConsent({ purpose: 'recording' });
  await assert.rejects(
    () => middleware({}),
    (err) => err instanceof PrivacyError && err.code === 'SESSION_REQUIRED',
  );
});
