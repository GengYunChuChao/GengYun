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

// ---- 修复轮 3 · P1-A：已认证执行入口强制身份版本（不得省略 epoch）----

async function grantVoice(consentStore) {
  for (const p of ['recording', 'media_processing', 'external_inference']) {
    await consentStore.grant({ userId: 'u1', purpose: p, policyVersion: '1.0.0', recipientIds: [] });
  }
}

test('R3 requireConsent 缺 authEpoch（仅 userId）→ SESSION_REQUIRED，且不放行', async () => {
  const { guard, consentStore } = await setup();
  await grantVoice(consentStore);
  const middleware = guard.requireConsent({ purpose: 'recording', dataType: 'voice_question' });
  await assert.rejects(
    () => middleware({ userId: 'u1' }),
    (err) => err instanceof PrivacyError && err.code === 'SESSION_REQUIRED' && err.status === 401,
  );
});

test('R3 requireConsent authEpoch 为 null → SESSION_REQUIRED', async () => {
  const { guard, consentStore } = await setup();
  await grantVoice(consentStore);
  const middleware = guard.requireConsent({ purpose: 'recording', dataType: 'voice_question' });
  await assert.rejects(
    () => middleware({ userId: 'u1', authEpoch: null }),
    (err) => err instanceof PrivacyError && err.code === 'SESSION_REQUIRED',
  );
});

test('R3 requireConsent 非正整数 authEpoch → INVALID_REQUEST', async () => {
  const { guard, consentStore } = await setup();
  await grantVoice(consentStore);
  const middleware = guard.requireConsent({ purpose: 'recording', dataType: 'voice_question' });
  for (const bad of [0, -1, 1.5, '1', NaN]) {
    await assert.rejects(
      () => middleware({ userId: 'u1', authEpoch: bad }),
      (err) => err instanceof PrivacyError && err.code === 'INVALID_REQUEST',
      `authEpoch=${String(bad)} 应被拒绝`,
    );
  }
});

test('R3 requireConsent 旧版本（账号 active 但 auth_epoch 1→2）→ ACCOUNT_INACTIVE，新版本可过', async () => {
  const { guard, consentStore, account } = await setup();
  await grantVoice(consentStore);
  account.set('u1', { state: 'active', authEpoch: 2 }); // 仍 active 但版本已前进
  const middleware = guard.requireConsent({ purpose: 'recording', dataType: 'voice_question' });
  await assert.rejects(
    () => middleware({ userId: 'u1', authEpoch: 1 }),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
  const ok = await middleware({ userId: 'u1', authEpoch: 2 });
  assert.equal(ok.consentEpoch, 1);
});

test('R3 requireConsent 正确版本通过（已认证执行入口放行）', async () => {
  const { guard, consentStore } = await setup();
  await grantVoice(consentStore);
  const middleware = guard.requireConsent({ purpose: 'recording', dataType: 'voice_question' });
  const res = await middleware({ userId: 'u1', authEpoch: 1 });
  assert.equal(res.consentEpoch, 1);
});

test('R3 纯用途查询 assertConsent 与执行入口分开：无 epoch 仍可查（不代表可执行）', async () => {
  const { guard, consentStore } = await setup();
  await grantVoice(consentStore);
  const res = await guard.assertConsent({ userId: 'u1', purpose: 'recording', dataType: 'voice_question' });
  assert.equal(res.consentEpoch, 1);
});
