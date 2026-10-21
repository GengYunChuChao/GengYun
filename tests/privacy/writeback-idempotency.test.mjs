/**
 * GY-I27（#29）第六片 · 回写**幂等与诚实性**回归（内存账本，与 `ledger-pg.ts` 同口径）。
 *
 * 背景（本片修的真实缺陷）：`guardWriteback` 的 `INSERT … ON CONFLICT (export_id) DO NOTHING`
 * 在**已有回写**时落 0 行，但旧实现无条件 `return { written: true }` —— 即「写了 0 行」被说成「写了」，
 * 且内存实现在 `apply` 里无条件 `Map.set`，会把**第一个结果覆盖成后来的重放载荷**。
 *
 * 这里锁住三件事：
 *   1. 首次回写：恰好 1 条、如实 `written:true`、返回形状与既有契约逐字一致（{written,exportId,objectVersion}）；
 *   2. 重放回调：**不新增、不覆盖**，如实 `{written:false, replay:true}`；
 *   3. 重放语义**不削弱**终态/撤回/取消守卫：已撤回收到的回调仍然是被拒绝（不是「已写过就算成功」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createExportLedger } from '../../packages/privacy/ledger.mjs';
import { PrivacyError } from '../../packages/privacy/errors.mjs';
import { createEgressRevoker, createInFlightGuard } from '../../packages/privacy/in-flight.mjs';
import { createAccountProvider, createRecipientStore, VERIFIED_RECIPIENT } from './_fixtures.mjs';

const OBJECT_ID = '00000000-0000-4000-8000-0000000000c1';

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
  return { account, consentStore, ledger, guard, exportId: record.id };
}

test('首次回写：恰好 1 条、written:true、返回形状与既有契约一致（无多余字段）', async () => {
  const { guard, ledger, exportId } = await setup();
  const ack = await guard.saveResult({ exportId, userId: 'u1', objectVersion: 1, result: { text: '第一次结果' } });
  assert.deepEqual(ack, { written: true, exportId, objectVersion: 1 });
  assert.equal(Object.keys(ack).length, 3, '首次回执不得多出字段');
  assert.deepEqual(ledger.getWriteback(exportId).result, { text: '第一次结果' });
});

test('重放回调：不新增、不覆盖载荷、如实报 written:false + replay:true', async () => {
  const { guard, ledger, exportId } = await setup();
  const first = await guard.saveResult({ exportId, userId: 'u1', objectVersion: 1, result: { text: '第一次结果' } });
  assert.equal(first.written, true);
  const committedAt = ledger.getWriteback(exportId).committedAt;

  const replay = await guard.saveResult({ exportId, userId: 'u1', objectVersion: 1, result: { text: '重放载荷（不得生效）' } });
  assert.deepEqual(replay, { written: false, replay: true, exportId, objectVersion: 1 },
    '0 行新写入时不得声称 written:true（旧实现此处返回 written:true）');
  const entry = ledger.getWriteback(exportId);
  assert.deepEqual(entry.result, { text: '第一次结果' }, '第一个结果即最终结果，重放不得覆盖');
  assert.equal(entry.committedAt, committedAt, '重放不得改动已提交时间');
});

test('账本层 guardWriteback 同口径：第二次调用如实报 0 行', async () => {
  const { ledger, exportId } = await setup();
  const first = await ledger.guardWriteback({ exportId, userId: 'u1', result: { text: '第一次结果' } });
  assert.deepEqual(first, { written: true, exportId });
  const again = await ledger.guardWriteback({ exportId, userId: 'u1', result: { text: '第二次结果' } });
  assert.deepEqual(again, { written: false, replay: true, exportId });
  assert.deepEqual(ledger.getWriteback(exportId).result, { text: '第一次结果' });
});

test('重放语义不削弱撤回守卫：撤回后的回调仍被拒绝（不是「已写过就算成功」）', async () => {
  const { guard, consentStore, ledger, exportId } = await setup();
  assert.equal((await guard.saveResult({ exportId, userId: 'u1', objectVersion: 1, result: { text: '撤回前的结果' } })).written, true);
  const revoker = createEgressRevoker({ ledger });
  await revoker.onConsentWithdrawn({ userId: 'u1', purpose: 'external_inference' });
  await assert.rejects(
    () => guard.saveResult({ exportId, userId: 'u1', objectVersion: 1, result: { text: '撤回后的重放' } }),
    (error) => error instanceof PrivacyError && error.code === 'OBJECT_UNAVAILABLE',
  );
  assert.deepEqual(ledger.getWriteback(exportId).result, { text: '撤回前的结果' }, '撤回后的回调不得改动已提交结果');
});

test('取消版本后的回调仍被拒绝（终态优先于重放）', async () => {
  const { guard, ledger, exportId } = await setup();
  assert.equal((await guard.saveResult({ exportId, userId: 'u1', objectVersion: 1, result: { text: '取消前的结果' } })).written, true);
  await guard.cancelVersion({ exportId, userId: 'u1', objectVersion: 1, reason: 'user_cancelled' });
  await assert.rejects(
    () => guard.saveResult({ exportId, userId: 'u1', objectVersion: 1, result: { text: '取消后的重放' } }),
    (error) => error instanceof PrivacyError && error.code === 'OBJECT_UNAVAILABLE',
  );
  assert.deepEqual(ledger.getWriteback(exportId).result, { text: '取消前的结果' });
});
