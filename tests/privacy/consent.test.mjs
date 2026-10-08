import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { PrivacyError } from '../../packages/privacy/errors.mjs';

test('grant 创建新 epoch，currentEpoch/isGranted/getConsent 正确', async () => {
  const store = createConsentStore();
  const rec = await store.grant({
    userId: 'u1',
    purpose: 'recording',
    policyVersion: '1.0.0',
    recipientIds: ['provider-asr'],
  });
  assert.equal(rec.epoch, 1);
  assert.equal(rec.state, 'granted');
  assert.equal(await store.currentEpoch({ userId: 'u1', purpose: 'recording' }), 1);
  assert.equal(await store.isGranted({ userId: 'u1', purpose: 'recording' }), true);
  assert.equal((await store.getConsent({ userId: 'u1', purpose: 'recording' })).recipientIds[0], 'provider-asr');
});

test('withdraw 标记撤回并递增 epoch（在途外发旧 epoch 失效）', async () => {
  const store = createConsentStore();
  await store.grant({ userId: 'u1', purpose: 'external_inference', policyVersion: '1.0.0', recipientIds: ['provider-llm'] });
  const withdrawn = await store.withdraw({ userId: 'u1', purpose: 'external_inference' });
  assert.equal(withdrawn.state, 'withdrawn');
  assert.ok(withdrawn.withdrawnAt);
  // 撤回后 currentEpoch 递增
  assert.equal(await store.currentEpoch({ userId: 'u1', purpose: 'external_inference' }), 2);
  assert.equal(await store.isGranted({ userId: 'u1', purpose: 'external_inference' }), false);
  assert.equal(await store.getConsent({ userId: 'u1', purpose: 'external_inference' }), null);
});

test('withdraw 幂等：无授权或重复撤回返回 null，不重复递增', async () => {
  const store = createConsentStore();
  assert.equal(await store.withdraw({ userId: 'u1', purpose: 'recording' }), null);
  await store.grant({ userId: 'u1', purpose: 'recording', policyVersion: '1.0.0', recipientIds: [] });
  await store.withdraw({ userId: 'u1', purpose: 'recording' });
  const epochAfterFirst = await store.currentEpoch({ userId: 'u1', purpose: 'recording' });
  assert.equal(await store.withdraw({ userId: 'u1', purpose: 'recording' }), null);
  assert.equal(await store.currentEpoch({ userId: 'u1', purpose: 'recording' }), epochAfterFirst);
});

test('重新授权为新 epoch，旧 epoch 记录保留为撤回历史', async () => {
  const store = createConsentStore();
  await store.grant({ userId: 'u1', purpose: 'recording', policyVersion: '1.0.0', recipientIds: [] });
  await store.withdraw({ userId: 'u1', purpose: 'recording' });
  const regrant = await store.grant({ userId: 'u1', purpose: 'recording', policyVersion: '1.1.0', recipientIds: ['provider-asr'] });
  assert.equal(regrant.epoch, 3);
  const list = await store.list({ userId: 'u1' });
  const recording = list.filter((r) => r.purpose === 'recording');
  assert.equal(recording.length, 1);
  assert.equal(recording[0].state, 'granted');
  assert.equal(recording[0].epoch, 3);
});

test('未知用途抛出契约 INVALID_REQUEST', async () => {
  const store = createConsentStore();
  await assert.rejects(
    () => store.grant({ userId: 'u1', purpose: 'training', policyVersion: '1.0.0', recipientIds: [] }),
    (err) => err instanceof PrivacyError && err.code === 'INVALID_REQUEST',
  );
});
