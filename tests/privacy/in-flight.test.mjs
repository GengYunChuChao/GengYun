/**
 * GY-I27（#29）· 在途守卫回归：任务执行前/保存前重查、取消版本不可复活、撤回/注销消费者接口。
 *
 * 全部使用**注入身份 + 内存账本/授权存储 + 替身回写介质**；不依赖 GY-I04（微信登录），
 * 也不连接任何真实第三方或数据库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createExportLedger } from '../../packages/privacy/ledger.mjs';
import { PrivacyError } from '../../packages/privacy/errors.mjs';
import { createEgressRevoker, createInFlightGuard } from '../../packages/privacy/in-flight.mjs';
import { createAccountProvider, createRecipientStore, VERIFIED_RECIPIENT } from './_fixtures.mjs';

const OBJECT_ID = '00000000-0000-4000-8000-0000000000b1';

async function setup() {
  const account = createAccountProvider({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const recipientStore = createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT });
  const ledger = createExportLedger({ consentStore, account, recipientStore });
  const guard = createInFlightGuard({ ledger, account, consentStore });
  for (const purpose of ['recording', 'media_processing', 'external_inference']) {
    await consentStore.grant({ userId: 'u1', purpose, policyVersion: '1.0.0', recipientIds: [VERIFIED_RECIPIENT.id] });
  }
  const record = await ledger.reserve({
    userId: 'u1', authEpoch: 1, objectType: 'transcription', objectId: OBJECT_ID, objectRevision: 1,
    dataType: 'voice_question', purpose: 'external_inference', recipientId: VERIFIED_RECIPIENT.id, sourceVersion: 'asr-v1',
  });
  return { account, consentStore, recipientStore, ledger, guard, exportId: record.id };
}

test('任务执行前重查：授权撤回后 assertExecutable 拒绝（不得再起新工作）', async () => {
  const { guard, consentStore, exportId } = await setup();
  await consentStore.withdraw({ userId: 'u1', purpose: 'recording' });
  await assert.rejects(
    () => guard.assertExecutable({ exportId, userId: 'u1' }),
    (err) => err instanceof PrivacyError && err.code === 'CONSENT_REQUIRED',
  );
});

test('任务执行前重查：用途版本前进（撤回后重新授权）后 assertExecutable 拒绝', async () => {
  const { guard, consentStore, exportId } = await setup();
  await consentStore.withdraw({ userId: 'u1', purpose: 'external_inference' });
  await consentStore.grant({ userId: 'u1', purpose: 'external_inference', policyVersion: '1.0.0', recipientIds: [VERIFIED_RECIPIENT.id] });
  await assert.rejects(
    () => guard.assertExecutable({ exportId, userId: 'u1' }),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

test('任务执行前重查：注销（auth_epoch 前进）后 assertExecutable 抛 ACCOUNT_INACTIVE', async () => {
  const { guard, account, exportId } = await setup();
  account.set('u1', { state: 'deletion_pending', authEpoch: 2 });
  await assert.rejects(
    () => guard.assertExecutable({ exportId, userId: 'u1' }),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
});

test('保存前重查：撤回后 saveResult 阻断且**零写入**（介质无条目）', async () => {
  const { guard, consentStore, ledger, exportId } = await setup();
  await consentStore.withdraw({ userId: 'u1', purpose: 'media_processing' });
  await assert.rejects(
    () => guard.saveResult({ exportId, userId: 'u1', objectVersion: 1, result: { text: '在途旧结果' } }),
    (err) => err instanceof PrivacyError && err.code === 'CONSENT_REQUIRED',
  );
  assert.equal(ledger.getWriteback(exportId), null, '撤回后不得发生任何回写写入');
});

test('保存前重查：注销后 saveResult 阻断且零写入', async () => {
  const { guard, account, ledger, exportId } = await setup();
  account.set('u1', { state: 'deleted', authEpoch: 3 });
  await assert.rejects(
    () => guard.saveResult({ exportId, userId: 'u1', objectVersion: 1, result: { text: 'x' } }),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
  assert.equal(ledger.getWriteback(exportId), null);
});

test('旧版本回调：objectVersion 与预留版本不一致 ⇒ 阻断且零写入', async () => {
  const { guard, ledger, exportId } = await setup();
  await assert.rejects(
    () => guard.saveResult({ exportId, userId: 'u1', objectVersion: 2, result: { text: '旧版本结果' } }),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
  assert.equal(ledger.getWriteback(exportId), null);
});

test('取消版本不可被回调复活：cancelVersion 后回写阻断且零写入，重新授权亦不复活', async () => {
  const { guard, consentStore, ledger, exportId } = await setup();
  const cancelled = guard.cancelVersion({ exportId, userId: 'u1', objectVersion: 1, reason: 'user_cancelled' });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.revokedInFlight, 1);
  assert.equal(ledger.get(exportId).state, 'failed', '取消必须把在途外发置 failed');
  assert.equal(guard.isVersionCancelled({ exportId, objectVersion: 1 }), true);
  assert.deepEqual(guard.cancelledVersionsOf(exportId), [1]);

  await assert.rejects(
    () => guard.saveResult({ exportId, userId: 'u1', objectVersion: 1, result: { text: '晚到的回调结果' } }),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );

  // 即使撤回后重新授权（epoch 前进 + granted），该版本也不得复活。
  await consentStore.withdraw({ userId: 'u1', purpose: 'external_inference' });
  await consentStore.grant({ userId: 'u1', purpose: 'external_inference', policyVersion: '1.0.0', recipientIds: [VERIFIED_RECIPIENT.id] });
  await assert.rejects(
    () => guard.saveResult({ exportId, userId: 'u1', objectVersion: 1, result: { text: '重新授权后的晚到回调' } }),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
  assert.equal(ledger.getWriteback(exportId), null, '已取消版本不得被任何回调写入');

  // 取消幂等：重复取消不改变结论，墓碑只增不减。
  const again = guard.cancelVersion({ exportId, userId: 'u1', objectVersion: 1, reason: 'user_cancelled' });
  assert.equal(again.alreadyCancelled, true);
  assert.equal(guard.cancelledVersionCount(), 1);
});

test('取消后 markSent 亦被阻断：已终态记录不可再派发', async () => {
  const { guard, ledger, exportId } = await setup();
  guard.cancelVersion({ exportId, userId: 'u1', objectVersion: 1 });
  await assert.rejects(
    () => ledger.markSent(exportId),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

test('正向：未撤回、版本一致时 saveResult 恰好写入一次且内容可追溯', async () => {
  const { guard, ledger, exportId } = await setup();
  const written = await guard.saveResult({ exportId, userId: 'u1', objectVersion: 1, result: { text: '合成结果' } });
  assert.deepEqual(written, { written: true, exportId, objectVersion: 1 });
  const entry = ledger.getWriteback(exportId);
  assert.equal(entry.exportId, exportId);
  assert.equal(entry.userId, 'u1');
  assert.deepEqual(entry.result, { text: '合成结果' });
});

test('撤回消费者接口：撤销在途外发后回写被阻断（新外发另由守卫阻断）', async () => {
  const { guard, ledger, exportId } = await setup();
  const revoker = createEgressRevoker({ ledger });

  const revoked = revoker.onConsentWithdrawn({ userId: 'u1', purpose: 'external_inference' });
  assert.equal(revoked.revokedInFlight, 1, '撤回必须撤销依赖该用途的在途外发');
  assert.equal(ledger.get(exportId).state, 'failed');

  await assert.rejects(
    () => guard.saveResult({ exportId, userId: 'u1', objectVersion: 1, result: { text: 'x' } }),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
  assert.equal(ledger.getWriteback(exportId), null);

  // 撤回只撤销**依赖该用途**的在途记录：无关用途（public_posting）的在途记录受影响需另证，
  // 这里只断言本用途记录被撤销、审计保留一条如实记录。
  assert.equal(revoker.audit().length, 1);
  assert.equal(revoker.audit()[0].revokedInFlight, 1);
});

test('注销消费者接口：撤销该用户全部在途外发（含多条）', async () => {
  const { ledger, consentStore } = await setup();
  await consentStore.grant({ userId: 'u1', purpose: 'public_posting', policyVersion: '1.0.0', recipientIds: [VERIFIED_RECIPIENT.id] });
  const community = await ledger.reserve({
    userId: 'u1', authEpoch: 1, objectType: 'post', objectId: OBJECT_ID, objectRevision: 1,
    dataType: 'community_image', purpose: 'public_posting', recipientId: VERIFIED_RECIPIENT.id, sourceVersion: null,
  });
  const revoker = createEgressRevoker({ ledger });

  const revoked = revoker.onAccountSuspendedOrDeleted({ userId: 'u1' });
  assert.equal(revoked.revokedInFlight, 2, '注销必须撤销该用户全部在途外发');
  assert.equal(ledger.get(community.id).state, 'failed');
  assert.equal(revoker.audit().length, 1);
});

test('取消原因只接受短安全 token：自由文本（可能含私有正文）一律回落为 cancelled', async () => {
  const { guard, exportId } = await setup();
  guard.cancelVersion({
    exportId, userId: 'u1', objectVersion: 1,
    reason: '我家地在东经121.47370北纬31.23041，正文私有',
  });
  const dumped = JSON.stringify(guard.audit());
  assert.equal(dumped.includes('121.47370'), false, '取消原因不得把私有坐标写进审计');
  assert.equal(dumped.includes('我家地'), false, '取消原因不得把私有正文写进审计');
  assert.equal(guard.audit()[0].reason, 'cancelled');
});

test('缺能力时构造期拒绝（不得静默跳过账号/授权重查）', async () => {
  const { ledger, consentStore, account } = await setup();
  assert.throws(() => createInFlightGuard({ ledger, consentStore }), /stateOf 与 authEpochOf/);
  assert.throws(
    () => createInFlightGuard({ ledger, account: { stateOf: async () => 'active' }, consentStore }),
    /stateOf 与 authEpochOf/,
  );
  assert.throws(() => createInFlightGuard({ ledger, account }), /consentStore/);
  assert.throws(() => createEgressRevoker({}), /revokeInFlight/);
});
