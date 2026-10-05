import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsentStore } from '../../packages/privacy/consent.mjs';
import { createExportLedger } from '../../packages/privacy/ledger.mjs';
import { createCommitGate } from '../../packages/privacy/commit-gate.mjs';
import { createMemoryWritebackMedium } from '../../packages/privacy/writeback.mjs';
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

// ---- 修复轮 2 · P1 撤回竞态：await 期间终态不可复活 ----

test('R2 派发竞态：原子提交在途期间 revokeInFlight → markSent 不得把记录复活为 sent', async () => {
  const account = createAccountProvider({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const recipientStore = createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT });
  const pausable = createPausableGate({ account, consentStore, recipientStore });
  const ledger = createExportLedger({
    consentStore,
    account,
    recipientStore,
    commitGate: pausable.gate,
  });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);

  pausable.pauseNext();
  const sending = ledger.markSent(rec.id);
  // 让 markSent 推进到原子提交的在途等待点
  await new Promise((r) => setTimeout(r, 0));
  // 撤回：revokeInFlight 同步终结在途记录
  const count = ledger.revokeInFlight({ userId: 'u1', purpose: 'recording' });
  assert.equal(count, 1);
  assert.equal(ledger.get(rec.id).state, 'failed');

  pausable.release(); // 释放：原子提交的同步临界区必须看到 failed 并拒绝
  await assert.rejects(
    () => sending,
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
  assert.equal(ledger.get(rec.id).state, 'failed', '终态不可被复活为 sent');
});

test('R2 派发竞态：终态（failed/outcome_unknown）记录标记 revision，markSent 复核失败', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  ledger.markOutcomeUnknown(rec.id, { errorCode: 'PROVIDER_OUTCOME_UNKNOWN' });
  await assert.rejects(
    () => ledger.markSent(rec.id),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

// ---- 修复轮 2 · P1 身份版本能力强制 ----

test('R2 缺 authEpochOf 的适配器在构造时被拒绝（不再静默跳过版本核对）', () => {
  const account = {
    async stateOf() {
      return 'active';
    },
  };
  assert.throws(
    () =>
      createExportLedger({
        consentStore: createConsentStore(),
        account,
        recipientStore: createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT }),
      }),
    /authEpochOf/,
  );
});

test('R2 身份快照读取失败时拒绝派发（不静默放行）', async () => {
  const { ledger, consentStore, account } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  account.identityOf = () => {
    throw new Error('synthetic auth store down');
  };
  await assert.rejects(
    () => ledger.markSent(rec.id),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
});

test('R2 身份快照返回非法值时拒绝派发', async () => {
  const { ledger, consentStore, account } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  account.identityOf = () => ({ state: 'active', authEpoch: 0 });
  await assert.rejects(
    () => ledger.markSent(rec.id),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
  account.identityOf = () => ({ state: 'active', authEpoch: '1' });
  await assert.rejects(
    () => ledger.markSent(rec.id),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
});

test('R2 身份快照读取失败时 guardWriteback 阻断回写', async () => {
  const { ledger, consentStore, account } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);
  account.identityOf = () => {
    throw new Error('synthetic auth store down');
  };
  await assert.rejects(
    () => ledger.guardWriteback({ exportId: rec.id, userId: 'u1' }),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
});

// ---- 修复轮 2 · P2 公开返回值不得泄露可变授权快照 ----

test('R2 reserve 返回值为深拷贝（改写返回值后 get 仍返回完整快照）', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  delete rec.requiredConsents.recording; // 公开返回值改写
  const again = ledger.get(rec.id);
  assert.deepEqual(again.requiredConsents, {
    recording: 1,
    media_processing: 1,
    external_inference: 1,
  });
});

test('R2 经 reserve 返回值删掉 recording 后撤回 recording，markSent 仍被阻断', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  delete rec.requiredConsents.recording; // 若内部共用对象，此处会绕过 recording 检查
  await consentStore.withdraw({ userId: 'u1', purpose: 'recording' });
  await assert.rejects(
    () => ledger.markSent(rec.id),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

test('R2 经 get() 返回值删掉 recording 后撤回 recording，markSent 仍被阻断', async () => {
  const { ledger, consentStore } = await setup();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  const fetched = ledger.get(rec.id);
  delete fetched.requiredConsents.recording;
  await consentStore.withdraw({ userId: 'u1', purpose: 'recording' });
  await assert.rejects(
    () => ledger.markSent(rec.id),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

// ---- 修复轮 4 · P1 原子提交协议：账号/全部必需用途/接收方 与 派发/回写 不可分离 ----

/**
 * 可受控暂停的提交门禁：模拟「异步适配器（如数据库事务）的在途阶段」。
 * pauseNext() 后，下一次 commit 会先阻塞到 release()，随后仍委托内存参考实现——
 * 其 verify+apply 为**单次同步临界区**，暂停期间发生的任何写入都会被一致重读捕获。
 */
function createPausableGate(deps) {
  const inner = createCommitGate(deps);
  let armed = false;
  let releaseFn = () => {};
  return {
    gate: {
      async commit(expected, hooks) {
        if (armed) {
          armed = false;
          await new Promise((res) => {
            releaseFn = res;
          });
        }
        return inner.commit(expected, hooks);
      },
      verify: (e) => inner.verify(e),
    },
    pauseNext() {
      armed = true;
    },
    release() {
      releaseFn();
    },
  };
}

function setupPausable() {
  const account = createAccountProvider({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const recipientStore = createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT });
  const pausable = createPausableGate({ account, consentStore, recipientStore });
  const ledger = createExportLedger({
    consentStore,
    account,
    recipientStore,
    commitGate: pausable.gate,
  });
  return { account, consentStore, recipientStore, pausable, ledger };
}

test('R4 门闩内部撤回记录用途（不经 revokeInFlight）→ markSent 拒绝且不置 sent', async () => {
  const { consentStore, pausable, ledger } = setupPausable();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);

  pausable.pauseNext();
  const sending = ledger.markSent(rec.id);
  await new Promise((r) => setTimeout(r, 0)); // markSent 推进到原子提交在途等待
  await consentStore.withdraw({ userId: 'u1', purpose: 'recording' }); // 仅撤回用途

  pausable.release();
  await assert.rejects(
    () => sending,
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
  assert.equal(ledger.get(rec.id).state, 'reserved', '原子提交必须拒绝，不得置 sent');
  assert.equal(ledger.get(rec.id).revision, 1, '未提交则 revision 不变（apply 未执行）');
});

test('R4 门闩内部撤回记录用途（不经 revokeInFlight）→ guardWriteback 拒绝', async () => {
  const { consentStore, pausable, ledger } = setupPausable();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);

  pausable.pauseNext();
  const writing = ledger.guardWriteback({ exportId: rec.id, userId: 'u1' });
  await new Promise((r) => setTimeout(r, 0));
  await consentStore.withdraw({ userId: 'u1', purpose: 'recording' });

  pausable.release();
  await assert.rejects(
    () => writing,
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

test('R4 最终 epoch 读取期间注销（deletion_pending + auth_epoch 2，不经 revokeInFlight）→ markSent 拒绝', async () => {
  const { account, consentStore, pausable, ledger } = setupPausable();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);

  pausable.pauseNext();
  const sending = ledger.markSent(rec.id);
  await new Promise((r) => setTimeout(r, 0));
  // 提交在途时直接注销：即使适配器的异步 epoch 读取会返回旧值，同步快照也必须看到新值
  account.set('u1', { state: 'deletion_pending', authEpoch: 2 });

  pausable.release();
  await assert.rejects(
    () => sending,
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
  assert.equal(ledger.get(rec.id).state, 'reserved', '不得派发（终态未被置 sent）');
});

test('R4 最终 epoch 读取期间注销（不经 revokeInFlight）→ guardWriteback 拒绝', async () => {
  const { account, consentStore, pausable, ledger } = setupPausable();
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);

  pausable.pauseNext();
  const writing = ledger.guardWriteback({ exportId: rec.id, userId: 'u1' });
  await new Promise((r) => setTimeout(r, 0));
  account.set('u1', { state: 'deletion_pending', authEpoch: 2 });

  pausable.release();
  await assert.rejects(
    () => writing,
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
});

/** 接收方存储：第 n 次 get 调用会先暂停，直到 release()。 */
function createPausingRecipientStore(recipient) {
  const store = createRecipientStore({ [recipient.id]: recipient });
  const rawGet = store.get.bind(store);
  let count = 0;
  let pauseOnCall = null;
  let releaseFn = () => {};
  store.get = async (id) => {
    count += 1;
    if (count === pauseOnCall) {
      await new Promise((res) => {
        releaseFn = res;
      });
    }
    return rawGet(id);
  };
  return {
    store,
    pauseOnGetCall(n) {
      pauseOnCall = n;
    },
    release() {
      releaseFn();
    },
  };
}

/**
 * 账号适配器：第 n 次 authEpochOf 调用会「先读旧值 → 暂停 → 返回该旧值」，
 * 模拟监工复现 2「适配器先取 epoch=1 再异步返回旧值」。同步 identityOf 始终读当前值。
 */
function createStalePausingAccount(initial = {}) {
  const accounts = new Map(Object.entries(initial));
  let count = 0;
  let pauseOnCall = null;
  let releaseFn = () => {};
  return {
    set(userId, patch) {
      const cur = accounts.get(userId) ?? { state: 'active', authEpoch: 1 };
      accounts.set(userId, { ...cur, ...patch });
    },
    identityOf(userId) {
      const cur = accounts.get(userId) ?? { state: 'active', authEpoch: 1 };
      return { state: cur.state ?? 'active', authEpoch: cur.authEpoch ?? 1 };
    },
    async stateOf(userId) {
      return accounts.get(userId)?.state ?? 'active';
    },
    async authEpochOf(userId) {
      count += 1;
      const stale = accounts.get(userId)?.authEpoch ?? 1; // 先读旧值
      if (count === pauseOnCall) {
        await new Promise((res) => {
          releaseFn = res;
        });
      }
      return stale; // 异步延迟后返回过期快照
    },
    pauseOnAuthEpochCall(n) {
      pauseOnCall = n;
    },
    release() {
      releaseFn();
    },
  };
}

test('R4 门闩内部撤回：暂停第 2 次 recipientStore.get 期间撤回用途（不经 revokeInFlight）→ markSent 拒绝', async () => {
  const account = createAccountProvider({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const pausing = createPausingRecipientStore(VERIFIED_RECIPIENT);
  const ledger = createExportLedger({ consentStore, account, recipientStore: pausing.store });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport); // recipientStore.get 调用 #1

  pausing.pauseOnGetCall(2); // 卡在 markSent 预检的接收方读取（此时已读完全部用途）
  const sending = ledger.markSent(rec.id);
  await new Promise((r) => setTimeout(r, 0));
  await consentStore.withdraw({ userId: 'u1', purpose: 'recording' }); // 仅撤回用途

  pausing.release();
  await assert.rejects(
    () => sending,
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
  assert.equal(ledger.get(rec.id).state, 'reserved', '原子提交必须拒绝，不得置 sent');
});

test('R4 门闩内部撤回：暂停第 2 次 recipientStore.get 期间撤回用途 → guardWriteback 拒绝', async () => {
  const account = createAccountProvider({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const pausing = createPausingRecipientStore(VERIFIED_RECIPIENT);
  const ledger = createExportLedger({ consentStore, account, recipientStore: pausing.store });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);

  pausing.pauseOnGetCall(3); // reserve #1 + markSent #2 → 本次为 #3
  const writing = ledger.guardWriteback({ exportId: rec.id, userId: 'u1' });
  await new Promise((r) => setTimeout(r, 0));
  await consentStore.withdraw({ userId: 'u1', purpose: 'recording' });

  pausing.release();
  await assert.rejects(
    () => writing,
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
});

test('R4 最终 epoch 读取期间注销（适配器返回过期 epoch=1）→ markSent 拒绝', async () => {
  const account = createStalePausingAccount({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const recipientStore = createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT });
  const ledger = createExportLedger({ consentStore, account, recipientStore });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport); // authEpochOf 调用 #1

  account.pauseOnAuthEpochCall(2); // 暂停 markSent 预检的最终 epoch 读取
  const sending = ledger.markSent(rec.id);
  await new Promise((r) => setTimeout(r, 0));
  account.set('u1', { state: 'deletion_pending', authEpoch: 2 }); // 注销，未经 revokeInFlight

  account.release(); // 预检拿到过期 epoch=1 并通过；原子提交必须用同步快照重新判定
  await assert.rejects(
    () => sending,
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
  assert.equal(ledger.get(rec.id).state, 'reserved', '过期预检放行不得导致实际派发');
});

test('R4 最终 epoch 读取期间注销（适配器返回过期 epoch=1）→ guardWriteback 拒绝', async () => {
  const account = createStalePausingAccount({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const recipientStore = createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT });
  const ledger = createExportLedger({ consentStore, account, recipientStore });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id); // authEpochOf 调用 #2（markSent 预检）

  account.pauseOnAuthEpochCall(3); // 暂停 guardWriteback 预检的 epoch 读取
  const writing = ledger.guardWriteback({ exportId: rec.id, userId: 'u1' });
  await new Promise((r) => setTimeout(r, 0));
  account.set('u1', { state: 'deletion_pending', authEpoch: 2 });

  account.release();
  await assert.rejects(
    () => writing,
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
});

test('R4 缺提交一致性契约（account 无同步 identityOf）→ 构造即拒绝投入使用', () => {
  const account = {
    async stateOf() {
      return 'active';
    },
    async authEpochOf() {
      return 1;
    },
  };
  assert.throws(
    () =>
      createExportLedger({
        consentStore: createConsentStore(),
        account,
        recipientStore: createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT }),
      }),
    /identityOf/,
  );
});

test('R4 缺提交一致性契约（consentStore 无同步 snapshotOf）→ 构造即拒绝投入使用', () => {
  const consentStore = {
    async isGranted() {
      return true;
    },
    async currentEpoch() {
      return 1;
    },
    async getConsent() {
      return null;
    },
  };
  assert.throws(
    () =>
      createExportLedger({
        consentStore,
        account: createAccountProvider({ u1: { state: 'active', authEpoch: 1 } }),
        recipientStore: createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT }),
      }),
    /snapshotOf/,
  );
});

test('R4 缺提交一致性契约（recipientStore 无同步 currentOf）→ 构造即拒绝投入使用', () => {
  const recipientStore = {
    async get() {
      return null;
    },
  };
  assert.throws(
    () =>
      createExportLedger({
        consentStore: createConsentStore(),
        account: createAccountProvider({ u1: { state: 'active', authEpoch: 1 } }),
        recipientStore,
      }),
    /currentOf/,
  );
});

test('R4 显式注入的 commitGate 缺 commit 原语 → 构造即拒绝投入使用', () => {
  assert.throws(
    () =>
      createExportLedger({
        consentStore: createConsentStore(),
        account: createAccountProvider({ u1: { state: 'active', authEpoch: 1 } }),
        recipientStore: createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT }),
        commitGate: { verify() {} },
      }),
    /commit/,
  );
});

test('R4 原子提交不误伤：账号/用途/接收方均未变时正常派发与回写', async () => {
  const medium = createMemoryWritebackMedium();
  const { ledger, consentStore } = await setup({ writeback: medium });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  const sent = await ledger.markSent(rec.id);
  assert.equal(sent.state, 'sent');
  const back = await ledger.guardWriteback({ exportId: rec.id, userId: 'u1', result: { asr: 'ok' } });
  assert.equal(medium.rows.size, 1, '受控介质恰好写入一次');
  assert.deepEqual(back, { written: true, exportId: rec.id }, '只返回写入回执，不返回可后置消费的授权结论');
});

test('R3 并发旧回调：注销后 guardWriteback 阻断（不依赖 revokeInFlight）', async () => {
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

// ---- 修复轮 5 · P1：实际结果写入必须与校验同处一个原子提交临界区 ----

test('R5-1 正向：结果写入在 gate 同步临界区内完成（gate Promise settle 之前，恰好一次）', async () => {
  let gateSettled = false;
  const medium = createMemoryWritebackMedium();
  const { ledger, consentStore } = await setup({ writeback: medium });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);

  const writing = ledger.guardWriteback({ exportId: rec.id, userId: 'u1', result: { asr: 'ok' } });
  writing.finally(() => {
    gateSettled = true;
  });
  const ack = await writing;
  assert.equal(gateSettled, true);
  assert.equal(medium.rows.size, 1, '受控介质恰好写入一次');
  assert.equal(ledger.getWriteback(rec.id).exportId, rec.id);
  assert.deepEqual(ack, { written: true, exportId: rec.id });
});

test('R5-2 负向：校验前撤回用途 → 介质零写入并抛 OBJECT_UNAVAILABLE', async () => {
  const medium = createMemoryWritebackMedium();
  const { ledger, consentStore } = await setup({ writeback: medium });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);
  await consentStore.withdraw({ userId: 'u1', purpose: 'recording' });

  await assert.rejects(
    () => ledger.guardWriteback({ exportId: rec.id, userId: 'u1', result: { asr: 'ok' } }),
    (err) => err instanceof PrivacyError && err.code === 'OBJECT_UNAVAILABLE',
  );
  assert.equal(medium.rows.size, 0, '撤回后介质零写入');
});

test('R5-2 负向：校验前注销（deletion_pending + authEpoch=2）→ 介质零写入并抛 ACCOUNT_INACTIVE', async () => {
  const medium = createMemoryWritebackMedium();
  const { ledger, consentStore, account } = await setup({ writeback: medium });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);
  account.set('u1', { state: 'deletion_pending', authEpoch: 2 });

  await assert.rejects(
    () => ledger.guardWriteback({ exportId: rec.id, userId: 'u1', result: { asr: 'ok' } }),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
  assert.equal(medium.rows.size, 0, '注销后介质零写入');
});

/** 复刻监工探针：gate 先同步完成参考 verify+apply，随后**仅**暂停异步返回（校验与 apply 之间未插 await）。 */
function createSyncThenPauseGate({ account, consentStore, recipientStore, events, onApply }) {
  const inner = createCommitGate({ account, consentStore, recipientStore });
  let armed = false;
  let releaseReturn = () => {};
  let trace = false;
  return {
    gate: {
      async commit(expected, hooks) {
        const result = await inner.commit(expected, {
          precondition: hooks.precondition,
          apply: () => {
            if (trace) events.push('apply');
            hooks.apply(); // 实际写入在 inner.commit 的同步临界区内执行
            if (trace && onApply) onApply();
          },
        });
        if (armed) {
          armed = false;
          await new Promise((res) => {
            releaseReturn = res;
          });
        }
        if (trace) events.push('gate-returned');
        return result;
      },
    },
    pauseNext() {
      armed = true;
    },
    release() {
      releaseReturn();
    },
    setTrace(v) {
      trace = v;
    },
  };
}

test('R5-3 边界：gate 同步 verify+apply 后仅暂停异步返回，期间撤回 → 写入只在临界区内发生一次、严格早于撤回', async () => {
  const account = createAccountProvider({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const recipientStore = createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT });
  const events = [];
  let saved = 0;
  const pausable = createSyncThenPauseGate({
    account,
    consentStore,
    recipientStore,
    events,
    onApply: () => {
      saved += 1;
      events.push('write');
    },
  });
  const ledger = createExportLedger({
    consentStore,
    account,
    recipientStore,
    commitGate: pausable.gate,
  });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);

  pausable.setTrace(true);
  pausable.pauseNext();
  const writing = ledger.guardWriteback({ exportId: rec.id, userId: 'u1', result: { asr: 'ok' } });
  await new Promise((r) => setTimeout(r, 0)); // 推进到 gate 的异步返回暂停点

  // 关键证据：此刻 inner.commit 的同步 verify+apply 已完成 —— 写入已在临界区内发生
  assert.equal(saved, 1, '写入必须在临界区内完成，不得等释放后才写');
  events.push('withdraw');
  await consentStore.withdraw({ userId: 'u1', purpose: 'recording' });

  pausable.release();
  await writing;
  assert.equal(saved, 1, '释放后不得再发生第二次写入');
  assert.ok(events.indexOf('write') < events.indexOf('withdraw'), '写入必须早于撤回：' + events.join(' -> '));
  assert.ok(events.indexOf('write') < events.indexOf('gate-returned'), '写入必须早于 gate 返回');
});

test('R5-3 边界：gate 同步 verify+apply 后仅暂停异步返回，期间注销 → 写入只在临界区内发生一次、严格早于注销', async () => {
  const account = createAccountProvider({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const recipientStore = createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT });
  const events = [];
  let saved = 0;
  const pausable = createSyncThenPauseGate({
    account,
    consentStore,
    recipientStore,
    events,
    onApply: () => {
      saved += 1;
      events.push('write');
    },
  });
  const ledger = createExportLedger({
    consentStore,
    account,
    recipientStore,
    commitGate: pausable.gate,
  });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);

  pausable.setTrace(true);
  pausable.pauseNext();
  const writing = ledger.guardWriteback({ exportId: rec.id, userId: 'u1', result: { asr: 'ok' } });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(saved, 1, '写入必须在临界区内完成，不得等释放后才写');
  events.push('logout');
  account.set('u1', { state: 'deletion_pending', authEpoch: 2 });

  pausable.release();
  await writing;
  assert.equal(saved, 1, '释放后不得再发生第二次写入');
  assert.ok(events.indexOf('write') < events.indexOf('logout'), '写入必须早于注销：' + events.join(' -> '));
  assert.ok(events.indexOf('write') < events.indexOf('gate-returned'), '写入必须早于 gate 返回');
});

test('R5-4 反向保护：注入含函数属性的介质（如 write）→ 构造即拒绝（不静默降级）', () => {
  assert.throws(
    () =>
      createExportLedger({
        consentStore: createConsentStore(),
        account: createAccountProvider({ u1: { state: 'active', authEpoch: 1 } }),
        recipientStore: createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT }),
        writeback: { rows: new Map(), write() {} },
      }),
    /不得包含可执行函数/,
  );
});

test('R5-4 反向保护：注入缺原生 Map 的介质 → 构造即拒绝（不静默降级）', () => {
  assert.throws(
    () =>
      createExportLedger({
        consentStore: createConsentStore(),
        account: createAccountProvider({ u1: { state: 'active', authEpoch: 1 } }),
        recipientStore: createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT }),
        writeback: {},
      }),
    /原生 Map/,
  );
});

test('R5-4 反向保护：rows 为 Map 子类（可覆写 set）→ 构造即拒绝（不静默降级）', () => {
  class EvilMap extends Map {}
  assert.throws(
    () =>
      createExportLedger({
        consentStore: createConsentStore(),
        account: createAccountProvider({ u1: { state: 'active', authEpoch: 1 } }),
        recipientStore: createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT }),
        writeback: { rows: new EvilMap() },
      }),
    /原生 Map/,
  );
});

// ---- 修复轮 7 · P1：写入口不得是任意用户函数（结构性保证，非 constructor.name 猜测） ----

/** 构造 ledger 依赖（供「注入即被拒绝」的断言使用）。 */
function freshLedgerArgs(overrides = {}) {
  return {
    consentStore: createConsentStore(),
    account: createAccountProvider({ u1: { state: 'active', authEpoch: 1 } }),
    recipientStore: createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT }),
    ...overrides,
  };
}

/**
 * 复刻监工探针的**延迟保存攻击**：`{ write: entry => pending.then(() => save(entry)) }`。
 * 其 `write.constructor.name === 'Function'`——修复轮 6 的 `constructor.name` 检查**放行**它；
 * 且一旦被调用即启动保存链，释放 `pending` 后仍会落库。本轮要求该介质在**构造期**即被拒绝。
 */
function createDelayedSaveProbe() {
  let release = () => {};
  const pending = new Promise((res) => {
    release = res;
  });
  const state = { calls: 0, saves: 0 };
  const probe = {
    write: (entry) => {
      state.calls += 1;
      return pending.then(() => {
        state.saves += 1;
      });
    },
  };
  return { probe, state, release: () => release() };
}

const settleMicrotasks = () => new Promise((r) => setTimeout(r, 0));

test('R7-1 公开注入路径传入「普通函数返回延迟 Promise」→ 构造即拒绝，实际 save=0', async () => {
  const { probe, state, release } = createDelayedSaveProbe();
  assert.throws(
    () => createExportLedger(freshLedgerArgs({ writeback: probe })),
    /不得包含可执行函数/,
    '含函数的回写介质必须在构造期被拒绝（非调用后判 Promise）',
  );
  release(); // 释放 pending：若该函数曾被接入写路径，此处会落库
  await settleMicrotasks();
  await settleMicrotasks();
  assert.equal(state.calls, 0, '攻击函数不得被调用');
  assert.equal(state.saves, 0, '释放 pending 后实际 save 计数必须为 0');
});

test('R7-2 撤回 recording + revokeInFlight：攻击注入被拒，释放 pending 后 save=0，记录 failed', async () => {
  const { probe, state, release } = createDelayedSaveProbe();
  assert.throws(
    () => createExportLedger(freshLedgerArgs({ writeback: probe })),
    /不得包含可执行函数/,
  );

  // 安全内存路径：撤回 + revokeInFlight 使记录 failed，且零写入
  const medium = createMemoryWritebackMedium();
  const { ledger, consentStore } = await setup({ writeback: medium });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);

  await consentStore.withdraw({ userId: 'u1', purpose: 'recording' });
  const revoked = ledger.revokeInFlight({ userId: 'u1', purpose: 'recording' });
  assert.equal(revoked, 1);
  assert.equal(ledger.get(rec.id).state, 'failed');

  release();
  await settleMicrotasks();
  await settleMicrotasks();
  assert.equal(state.calls, 0, '攻击函数不得被调用');
  assert.equal(state.saves, 0, '释放 pending 后实际 save 计数必须为 0');
  assert.equal(medium.rows.size, 0, '安全内存路径零写入');
  assert.equal(ledger.getWriteback(rec.id), null, '无持久化效果');
});

test('R7-3 账号 deletion_pending + auth_epoch 递增：攻击注入被拒，释放 pending 后 save=0，记录 failed', async () => {
  const { probe, state, release } = createDelayedSaveProbe();
  assert.throws(
    () => createExportLedger(freshLedgerArgs({ writeback: probe })),
    /不得包含可执行函数/,
  );

  const medium = createMemoryWritebackMedium();
  const { ledger, consentStore, account } = await setup({ writeback: medium });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);

  account.set('u1', { state: 'deletion_pending', authEpoch: 2 });
  await assert.rejects(
    () => ledger.guardWriteback({ exportId: rec.id, userId: 'u1', result: { asr: 'ok' } }),
    (err) => err instanceof PrivacyError && err.code === 'ACCOUNT_INACTIVE',
  );
  ledger.revokeInFlight({ userId: 'u1' });
  assert.equal(ledger.get(rec.id).state, 'failed');

  release();
  await settleMicrotasks();
  await settleMicrotasks();
  assert.equal(state.calls, 0, '攻击函数不得被调用');
  assert.equal(state.saves, 0, '释放 pending 后实际 save 计数必须为 0');
  assert.equal(medium.rows.size, 0, '安全内存路径零写入');
});

test('R7-4 正向：合法数据介质写入在同一同步边界内恰好一次', async () => {
  const medium = createMemoryWritebackMedium();
  const account = createAccountProvider({ u1: { state: 'active', authEpoch: 1 } });
  const consentStore = createConsentStore();
  const recipientStore = createRecipientStore({ [VERIFIED_RECIPIENT.id]: VERIFIED_RECIPIENT });
  const pausable = createSyncThenPauseGate({ account, consentStore, recipientStore, events: [] });
  const ledger = createExportLedger({
    consentStore,
    account,
    recipientStore,
    commitGate: pausable.gate,
    writeback: medium,
  });
  await grantVoiceConsent(consentStore);
  const rec = await ledger.reserve(baseExport);
  await ledger.markSent(rec.id);

  pausable.pauseNext(); // gate 同步 verify+apply 后仅暂停异步返回
  const writing = ledger.guardWriteback({ exportId: rec.id, userId: 'u1', result: { asr: 'ok' } });
  await settleMicrotasks();
  assert.equal(medium.rows.size, 1, '暂停异步返回期间，写入已在同一同步边界内恰好一次');
  pausable.release();
  const ack = await writing;
  assert.equal(medium.rows.size, 1, '释放后不得再发生第二次写入');
  assert.deepEqual(ack, { written: true, exportId: rec.id });
  assert.deepEqual(ledger.getWriteback(rec.id).result, { asr: 'ok' });
});

test('R7-5 复刻监工探针：{ write: entry => pending.then(...) } 注入被拒（含 rows+函数混合介质）save=0', async () => {
  const { probe, state, release } = createDelayedSaveProbe();

  // (1) 纯函数介质：构造即拒绝
  assert.throws(
    () => createExportLedger(freshLedgerArgs({ writeback: probe })),
    /不得包含可执行函数/,
    '监工探针原形（普通函数）必须被构造期拒绝',
  );
  // (2) 混合介质：既有原生 rows、又夹带函数 → 仍拒绝（不存在「借 rows 混入函数」的旁路）
  assert.throws(
    () => createExportLedger(freshLedgerArgs({ writeback: { rows: new Map(), write: probe.write } })),
    /不得包含可执行函数/,
    '混合介质同样必须被构造期拒绝',
  );

  release();
  await settleMicrotasks();
  await settleMicrotasks();
  assert.equal(state.calls, 0, '攻击函数不得被调用');
  assert.equal(state.saves, 0, '释放 pending 后实际 save 计数必须为 0');
});
