import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createExportLedger } from '../../packages/privacy/ledger.mjs';
import { PrivacyError } from '../../packages/privacy/errors.mjs';
import { createAccountProvider, createRecipientStore, VERIFIED_RECIPIENT } from './_fixtures.mjs';

async function setup(overrides = {}) {
  const account = createAccountProvider({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const recipientStore = createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT });
  const ledger = createExportLedger({ consentStore, account, recipientStore, ...overrides });
  return { account, consentStore, recipientStore, ledger };
}

async function grantVoiceConsent(consentStore, userId = 'u1', recipientId = VERIFIED_RECIPIENT.id) {
  for (const p of ['recording', 'media_processing', 'external_inference']) {
    await consentStore.grant({ userId, purpose: p, policyVersion: '1.0.0', recipientIds: [recipientId] });
  }
}

const baseExport = {
  userId: 'u1',
  authEpoch: 1,
  objectType: 'transcription',
  objectId: '00000000-0000-4000-8000-000000000001',
  objectRevision: 1,
  dataType: 'voice_question',
  purpose: 'external_inference',
  recipientId: VERIFIED_RECIPIENT.id,
  sourceVersion: 'asr-v1',
};

test('无授权不能触发外发（reserve 抛 CONSENT_REQUIRED）', async () => {
  const { ledger } = await setup();
  await assert.rejects(
    () => ledger.reserve(baseExport),
    (err) => err instanceof PrivacyError && err.code === 'CONSENT_REQUIRED',
  );
});

test('错用途不能触发外发（purpose 与资料类型不匹配抛 SCOPE_DENIED）', async () => {
  const { ledger, consentStore } = await setup();
  await consentStore.grant({ userId: 'u1', purpose: 'public_posting', policyVersion: '1.0.0', recipientIds: [VERIFIED_RECIPIENT.id] });
  await assert.rejects(
    () => ledger.reserve({ ...baseExport, purpose: 'public_posting' }),
    (err) => err instanceof PrivacyError && err.code === 'SCOPE_DENIED',
  );
});

test('资料类型需多用途，缺其一不能触发外发', async () => {
  const { ledger, consentStore } = await setup();
  await consentStore.grant({ userId: 'u1', purpose: 'recording', policyVersion: '1.0.0', recipientIds: [VERIFIED_RECIPIENT.id] });
  await consentStore.grant({ userId: 'u1', purpose: 'media_processing', policyVersion: '1.0.0', recipientIds: [VERIFIED_RECIPIENT.id] });
  await assert.rejects(
    () => ledger.reserve(baseExport),
    (err) => err instanceof PrivacyError && err.code === 'CONSENT_REQUIRED',
  );
});

test('缺身份版本（authEpoch）不能触发外发', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  await assert.rejects(
    () => ledger.reserve({ ...baseExport, authEpoch: undefined }),
    (err) => err instanceof PrivacyError && err.code === 'SESSION_REQUIRED',
  );
});

test('不默认第三方训练：接收方未验证 no_training 时 external_inference 拒绝', async () => {
  const { ledger, consentStore, recipientStore } = await setup();
  await grantVoiceConsent(consentStore);
  recipientStore.set(VERIFIED_RECIPIENT.id, { no_training_verified: false });
  await assert.rejects(
    () => ledger.reserve(baseExport),
    (err) => err instanceof PrivacyError && err.code === 'SCOPE_DENIED',
  );
});

test('不默认第三方训练：接收方未验证删除确认能力时 external_inference 拒绝', async () => {
  const { ledger, consentStore, recipientStore } = await setup();
  await grantVoiceConsent(consentStore);
  recipientStore.set(VERIFIED_RECIPIENT.id, { deletion_verified: false });
  await assert.rejects(
    () => ledger.reserve(baseExport),
    (err) => err instanceof PrivacyError && err.code === 'SCOPE_DENIED',
  );
});

test('未绑定该接收方时外发被拒（外发匹配准确 recipient）', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore, 'u1', 'another-provider');
  await assert.rejects(
    () => ledger.reserve(baseExport),
    (err) => err instanceof PrivacyError && err.code === 'CONSENT_REQUIRED',
  );
});

test('账号非活跃（注销）不能触发外发', async () => {
  const { ledger, consentStore, account } = await setup();
  await grantVoiceConsent(consentStore);
  account.set('u1', { state: 'deletion_pending' });
  await assert.rejects(
    () => ledger.reserve(baseExport),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
});

test('授权齐全时 reserve 成功，登记 userid/purpose/recipient/source_version', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  assert.equal(rec.state, 'reserved');
  assert.equal(rec.userId, 'u1');
  assert.equal(rec.purpose, 'external_inference');
  assert.equal(rec.recipientId, VERIFIED_RECIPIENT.id);
  assert.equal(rec.sourceVersion, 'asr-v1');
  assert.equal(rec.consentEpoch, 1);
  // 保存全部必需用途 epoch 快照
  assert.deepEqual(rec.requiredConsents, {
    recording: 1,
    media_processing: 1,
    external_inference: 1,
  });
});

test('撤回与任务竞争：撤回后旧结果回写被阻断（epoch 前进）', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);
  await consentStore.withdraw({ userId: 'u1', purpose: 'external_inference' });
  await assert.rejects(
    () => ledger.guardWriteback({ exportId: rec.id, userId: 'u1' }),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

test('注销与任务竞争：auth_epoch 前进后旧结果回写被阻断', async () => {
  const { ledger, consentStore, account } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);
  account.set('u1', { state: 'deletion_pending', authEpoch: 2 });
  await assert.rejects(
    () => ledger.guardWriteback({ exportId: rec.id, userId: 'u1' }),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
});

test('取消版本不可被回调复活：取消后 markSent 被阻断', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  ledger.markFailed(rec.id, { errorCode: 'CANCELLED' });
  await assert.rejects(
    () => ledger.markSent(rec.id),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

test('revokeInFlight 将撤回/注销用户的在途外发置 failed，回写被阻断', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  const count = ledger.revokeInFlight({ userId: 'u1', purpose: 'external_inference' });
  assert.equal(count, 1);
  assert.equal(ledger.get(rec.id).state, 'failed');
  await assert.rejects(
    () => ledger.guardWriteback({ exportId: rec.id, userId: 'u1' }),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

test('markSent 前二次核对：撤回后禁止派发', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await consentStore.withdraw({ userId: 'u1', purpose: 'external_inference' });
  await assert.rejects(
    () => ledger.markSent(rec.id),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

// ---- P1-1：发送/回写核对全部必需用途 epoch ----

test('P1-1 撤回非主用途（recording）后 markSent 被阻断', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await consentStore.withdraw({ userId: 'u1', purpose: 'recording' });
  await assert.rejects(
    () => ledger.markSent(rec.id),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

test('P1-1 撤回非主用途（recording）后 guardWriteback 被阻断', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);
  await consentStore.withdraw({ userId: 'u1', purpose: 'recording' });
  await assert.rejects(
    () => ledger.guardWriteback({ exportId: rec.id, userId: 'u1' }),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

test('P1-1 revokeInFlight 覆盖依赖 recording 的在途记录', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  const count = ledger.revokeInFlight({ userId: 'u1', purpose: 'recording' });
  assert.equal(count, 1);
  assert.equal(ledger.get(rec.id).state, 'failed');
});

test('P1-1 重新授权后旧 epoch 快照失效（markSent 阻断）', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await consentStore.withdraw({ userId: 'u1', purpose: 'external_inference' });
  await consentStore.grant({ userId: 'u1', purpose: 'external_inference', policyVersion: '1.1.0', recipientIds: [VERIFIED_RECIPIENT.id] });
  await assert.rejects(
    () => ledger.markSent(rec.id),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

// ---- P1-2：回写/发送始终核对「外发时固定的账号版本」 ----

test('P1-2 guardWriteback 省略 authEpoch 仍核对账号版本快照（epoch 前进阻断）', async () => {
  const { ledger, consentStore, account } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport); // 快照 authEpoch=1
  account.set('u1', { state: 'active', authEpoch: 2 }); // 仍 active 但 epoch 升为 2
  await assert.rejects(
    () => ledger.guardWriteback({ exportId: rec.id, userId: 'u1' }), // 未传 authEpoch
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
});

test('P1-2 markSent 不接受新账号版本覆盖旧任务凭据（epoch 前进阻断）', async () => {
  const { ledger, consentStore, account } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport); // 快照 authEpoch=1
  account.set('u1', { state: 'active', authEpoch: 2 });
  await assert.rejects(
    () => ledger.markSent(rec.id),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
});

test('P1-2 停用后恢复（auth_epoch 前进）旧任务仍被阻断', async () => {
  const { ledger, consentStore, account } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);
  account.set('u1', { state: 'suspended', authEpoch: 2 });
  account.set('u1', { state: 'active', authEpoch: 2 }); // 恢复但 epoch 已前进
  await assert.rejects(
    () => ledger.guardWriteback({ exportId: rec.id, userId: 'u1' }),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
});

// ---- P1-3：预留后接收方持续有效性重查 ----

test('P1-3 预留后接收方停用，markSent 阻断', async () => {
  const { ledger, consentStore, recipientStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  recipientStore.set(VERIFIED_RECIPIENT.id, { enabled: false });
  await assert.rejects(
    () => ledger.markSent(rec.id),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

test('P1-3 预留后接收方版本变化，guardWriteback 阻断', async () => {
  const { ledger, consentStore, recipientStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  recipientStore.set(VERIFIED_RECIPIENT.id, { config_version: '2.0.0' });
  await assert.rejects(
    () => ledger.guardWriteback({ exportId: rec.id, userId: 'u1' }),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

test('P1-3 预留后接收方训练条款失效，markSent 阻断', async () => {
  const { ledger, consentStore, recipientStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  recipientStore.set(VERIFIED_RECIPIENT.id, { no_training_verified: false });
  await assert.rejects(
    () => ledger.markSent(rec.id),
    (err) => err instanceof PrivacyError && err.code === 'SCOPE_DENIED',
  );
});

test('P1-3 预留后接收方删除确认能力失效，guardWriteback 阻断', async () => {
  const { ledger, consentStore, recipientStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);
  recipientStore.set(VERIFIED_RECIPIENT.id, { deletion_verified: false });
  await assert.rejects(
    () => ledger.guardWriteback({ exportId: rec.id, userId: 'u1' }),
    (err) => err instanceof PrivacyError && err.code === 'SCOPE_DENIED',
  );
});
