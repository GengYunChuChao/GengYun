// GY-I19（#19）决策包 A 第 2 步 · 注销（账号删除）HTTP 接线的**单元层**证据。
//
// 覆盖 HTTP 集成脚本够不到的两处：
//   1. **回执 bearer 台账**（`services/api/src/privacy/account-deletion.ts:createDeletionReceiptRegistry`）：
//      只存 sha256 摘要、35 日到期即作废、换发即作废旧摘要 —— 这三条都是「时间/次数」语义，
//      集成脚本无法在不等待 35 日的前提下验证；
//   2. **回执投影的如实性边界**（`projectReceipt`）：非法枚举折叠、错误码只透白名单；
//      以及「备份报称 purged 但**缺证据** ⇒ 仍 `pending`」——不得把部分覆盖说成全部完成。
//
// 本文件是**新增**文件；不改动任何既有断言、不新增 skip/only。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createUserDataDeletion } from '../../services/api/src/privacy/user-data-deletion.ts';
import {
  ACCOUNT_DELETION_UNAVAILABLE_MESSAGE,
  RECEIPT_TTL_MS,
  createAccountDeletionRequestService,
  createDeletionReceiptRegistry,
  projectReceipt,
} from '../../services/api/src/privacy/account-deletion.ts';
import { USER_A, USER_B, scriptedClock } from './favorites-history-fixtures.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 三个模块的在线数据（A、B 各一行），与 `tests/unit/user-data-deletion.test.mjs` 同源形状。 */
async function seed(clock) {
  const favoritesStore = createMemoryFavoritesStore({ now: () => clock.ms });
  const historyStore = createMemoryHistoryStore({ now: () => clock.ms });
  const messagesStore = createMemoryMessagesStore({ now: () => clock.ms });
  const conversationsStore = createMemoryConversationStore();
  for (const [ownerId, tag] of [
    [USER_A.userId, 'a'],
    [USER_B.userId, 'b'],
  ]) {
    await favoritesStore.insertFavorite({
      id: `00000000-0000-4000-8${tag === 'a' ? '1' : '2'}00-000000000001`,
      revision: 1,
      owner_id: ownerId,
      target_ref: { type: 'species', id: `spc-${tag}`, revision: 1 },
      created_at: clock.now().toISOString(),
    });
    await historyStore.insertHistory({
      id: `00000000-0000-4000-8${tag === 'a' ? '3' : '4'}00-000000000001`,
      revision: 1,
      owner_id: ownerId,
      kind: 'recognition',
      target_ref: { type: 'recognition', id: `rec-${tag}`, revision: 1 },
      job_id: `job-${tag}`,
      job_state: 'failed',
      created_at: clock.now().toISOString(),
      event_key: `evt-${tag}`,
    });
    // #17 消息域（C1b 起进闭集）：注销必须真删消息行，且不得清到他人。
    await messagesStore.insertMessage({
      id: `00000000-0000-4000-8${tag === 'a' ? '5' : '6'}00-000000000001`,
      revision: 1,
      owner_id: ownerId,
      type: 'system',
      target_ref: null,
      read_at: null,
      created_at: clock.now().toISOString(),
      event_key: `msg-${tag}`,
    });
    // #12 会话域（C1b-3 起进闭集）：每个主体一条会话行。
    await conversationsStore.insertConversation({
      id: `00000000-0000-4000-8${tag === 'a' ? '7' : '8'}00-000000000001`,
      owner_id: ownerId,
      conditions: null,
      created_at: clock.now(),
    });
  }
  return { favoritesStore, historyStore, messagesStore, conversationsStore };
}

test('GY-I19：回执 bearer 只按摘要可解析、35 日到期即作废、换发即作废旧摘要', () => {
  const clock = scriptedClock();
  const receipts = createDeletionReceiptRegistry({ now: clock.now });
  const requestId = '00000000-0000-4000-8f00-000000000001';

  const first = receipts.issue(requestId);
  // 明文 bearer 不是删除请求 id 本身（不透明随机），且台账只按 sha256 摘要反查。
  assert.notEqual(first.token, requestId);
  assert.ok(first.token.length >= 32);
  assert.equal(receipts.resolveRequestId(first.token), requestId);
  assert.equal(receipts.liveCount(), 1);
  // 有效期逐字为 35 日（`docs/architecture/state-contract.md:107`「有效期35日」）。
  assert.equal(Date.parse(first.expiresAt) - clock.ms, 35 * DAY_MS);
  assert.equal(RECEIPT_TTL_MS, 35 * DAY_MS);

  // 未知/空凭据一律 null（不泄露某个删除请求是否存在）。
  assert.equal(receipts.resolveRequestId('not-a-real-bearer-token'), null);
  assert.equal(receipts.resolveRequestId(''), null);
  assert.equal(receipts.resolveRequestId(undefined), null);

  // 到期边界：到期前一毫秒仍有效；到**恰好**到期时刻即作废，且台账里物理移除（不留悬垂摘要）。
  clock.advance(35 * DAY_MS - 1);
  assert.equal(receipts.resolveRequestId(first.token), requestId);
  clock.advance(1);
  assert.equal(receipts.resolveRequestId(first.token), null, '到期即作废，不续期');
  assert.equal(receipts.liveCount(), 0);

  // 换发：同一删除请求任一时刻只保留一个有效 bearer ⇒ 旧 bearer 立刻失效（不回放旧凭据）。
  const second = receipts.issue(requestId);
  const third = receipts.issue(requestId);
  assert.equal(receipts.resolveRequestId(second.token), null, '换发后旧 bearer 必须立即失效');
  assert.equal(receipts.resolveRequestId(third.token), requestId);
  assert.equal(receipts.liveCount(), 1);

  // 显式遗忘（进程内台账的清理口）：返回被清掉的摘要数，之后一律不可解析。
  assert.equal(receipts.forgetRequest(requestId), 1);
  assert.equal(receipts.resolveRequestId(third.token), null);
  assert.equal(receipts.liveCount(), 0);
  assert.equal(receipts.forgetRequest(requestId), 0);
});

test('GY-I19：受理即驱动既有级联（在线真删、只删绑定主体），备份未接线如实 pending', async () => {
  const clock = scriptedClock();
  const { favoritesStore, historyStore, messagesStore, conversationsStore } = await seed(clock);
  const deletion = createUserDataDeletion({ favoritesStore, historyStore, messagesStore, conversationsStore, now: clock.now });
  const receipts = createDeletionReceiptRegistry({ now: clock.now });
  const service = createAccountDeletionRequestService({ deletion, receipts });

  assert.equal(service.available, true);
  assert.equal(service.unavailableMessage, null);
  assert.deepEqual(service.declaredModules(), ['favorites', 'history', 'messages', 'conversations']);

  const accepted = await service.request({ userId: USER_A.userId, receiptInput: 'receipt-input-a' });
  assert.deepEqual(Object.keys(accepted).sort(), ['deletion', 'receipt_expires_at', 'receipt_token']);

  // 回执 bearer 是**新的**、可反查到该删除请求，且有效期 35 日。
  const requestId = String(accepted.deletion.id);
  assert.equal(receipts.resolveRequestId(accepted.receipt_token), requestId);
  assert.equal(Date.parse(accepted.receipt_expires_at) - clock.ms, 35 * DAY_MS);

  // 在线阶段确实跑了：A 清空、B 原样（主体绑定在既有装配里，不跨主体误删）。
  assert.equal((await favoritesStore.listFavoritesByOwner(USER_A.userId)).length, 0);
  assert.equal((await historyStore.listHistoryByOwner(USER_A.userId)).length, 0);
  assert.equal((await messagesStore.listMessagesByOwner(USER_A.userId)).length, 0, '#17：消息行必须真删');
  assert.equal(
    conversationsStore.snapshot().conversations.filter((row) => row.owner_id === USER_A.userId).length,
    0,
    '#12：会话行必须真删',
  );
  assert.equal((await favoritesStore.listFavoritesByOwner(USER_B.userId)).length, 1);
  assert.equal((await historyStore.listHistoryByOwner(USER_B.userId)).length, 1);
  assert.equal((await messagesStore.listMessagesByOwner(USER_B.userId)).length, 1, '他人消息不动');
  assert.equal(
    conversationsStore.snapshot().conversations.filter((row) => row.owner_id === USER_B.userId).length,
    1,
    '他人会话不动',
  );

  // 回执逐模块摊开：在线 completed、备份 pending（未接线不谎称完成）、无自由文本错误码。
  const byModule = new Map(accepted.deletion.handlers.map((row) => [row.module, row]));
  assert.deepEqual([...byModule.keys()].sort(), ['conversations', 'favorites', 'history', 'messages']);
  for (const [module, row] of byModule) {
    assert.equal(row.online_state, 'completed', `${module} 在线清理确实成功`);
    assert.equal(row.backup_state, 'pending', `${module} 备份副本清除未接线 ⇒ 如实 pending`);
    assert.equal(row.third_party_state, null);
    assert.equal(row.error_code, null);
  }
  // 因此整体**不可能**是 completed；协议按「不能完成」如实回落 blocked（不把受理当删除）。
  assert.equal(accepted.deletion.state, 'blocked');
  assert.equal(accepted.deletion.id, requestId);
  assert.ok(accepted.deletion.revision >= 1);
  assert.equal(Date.parse(accepted.deletion.online_due_at) - clock.ms, 7 * DAY_MS);
  assert.equal(Date.parse(accepted.deletion.backup_due_at) - clock.ms, 30 * DAY_MS);
});

test('GY-I19：空主体/空回执明文一律拒绝且不留任何状态；未接线模式给契约不可用文案', async () => {
  const clock = scriptedClock();
  const { favoritesStore, historyStore, messagesStore, conversationsStore } = await seed(clock);
  const deletion = createUserDataDeletion({ favoritesStore, historyStore, messagesStore, conversationsStore, now: clock.now });
  const receipts = createDeletionReceiptRegistry({ now: clock.now });
  const service = createAccountDeletionRequestService({ deletion, receipts });

  await assert.rejects(() => service.request({ userId: '', receiptInput: 'x' }), /非空主体/);
  await assert.rejects(() => service.request({ userId: USER_A.userId, receiptInput: '' }), /回执 bearer 明文/);
  // 被拒的调用不得留下回执或删除痕迹（A 的数据仍在）。
  assert.equal(receipts.liveCount(), 0);
  assert.equal((await favoritesStore.listFavoritesByOwner(USER_A.userId)).length, 1);
  assert.equal(deletion.audit().length, 0);

  // `available:false`（`real` 模式下 app.ts 的装配）⇒ 给契约 503 文案，且**不**自造成功路径。
  const unwired = createAccountDeletionRequestService({ deletion, receipts, available: false });
  assert.equal(unwired.available, false);
  assert.equal(unwired.unavailableMessage, ACCOUNT_DELETION_UNAVAILABLE_MESSAGE);
  assert.match(unwired.unavailableMessage, /未接线/);
});

test('GY-I19：备份报称 purged 但缺证据 ⇒ 仍 pending；证据齐备才可能 completed', async () => {
  const clock = scriptedClock();

  // (1) 缺证据：`purged:true` 但没有 `evidenceRef` ⇒ 备份阶段如实保持 pending，整体不完成。
  const noEvidence = await (async () => {
    const { favoritesStore, historyStore, messagesStore, conversationsStore } = await seed(clock);
    const deletion = createUserDataDeletion({
      favoritesStore,
      historyStore,
      messagesStore,
      conversationsStore,
      now: clock.now,
      backupPurge: {
        kind: 'wired',
        available: true,
        purge: async () => ({ purged: true }),
      },
    });
    const receipts = createDeletionReceiptRegistry({ now: clock.now });
    const service = createAccountDeletionRequestService({ deletion, receipts });
    return service.request({ userId: USER_A.userId, receiptInput: 'receipt-input-no-evidence' });
  })();
  for (const row of noEvidence.deletion.handlers) {
    assert.equal(row.backup_state, 'pending', '缺证据不得判完成');
  }
  assert.notEqual(noEvidence.deletion.state, 'completed', '证据不齐 ⇒ 绝不 completed');

  // (2) 证据齐备：同一套协议即可判定 completed —— 说明本片没有把状态永久钉死，
  //     而是**由证据**决定（反向控制 RC-3 注入的伪造 completed 正是在这里被咬住）。
  const withEvidence = await (async () => {
    const { favoritesStore, historyStore, messagesStore, conversationsStore } = await seed(clock);
    const deletion = createUserDataDeletion({
      favoritesStore,
      historyStore,
      messagesStore,
      conversationsStore,
      now: clock.now,
      backupPurge: {
        kind: 'wired',
        available: true,
        purge: async ({ module }) => ({ purged: true, evidenceRef: `backup-replica-purged:${module}:2026-10-15` }),
      },
    });
    const receipts = createDeletionReceiptRegistry({ now: clock.now });
    const service = createAccountDeletionRequestService({ deletion, receipts });
    return service.request({ userId: USER_A.userId, receiptInput: 'receipt-input-with-evidence' });
  })();
  for (const row of withEvidence.deletion.handlers) {
    assert.equal(row.online_state, 'completed');
    assert.equal(row.backup_state, 'completed');
  }
  assert.equal(withEvidence.deletion.state, 'completed');
});

test('GY-I19：回执投影只做形状归一 —— 非法枚举折叠，错误码只透白名单', () => {
  // null 入参 ⇒ null（调用方据此 404，绝不回 200 空壳）。
  assert.equal(projectReceipt(null), null);

  const projected = projectReceipt({
    id: '00000000-0000-4000-8f00-00000000000a',
    state: 'definitely-not-a-state',
    revision: 0,
    requested_at: '2026-10-15T03:00:00.000Z',
    online_due_at: '2026-10-22T03:00:00.000Z',
    backup_due_at: '2026-11-14T03:00:00.000Z',
    handlers: [
      { module: 'favorites', online_state: 'completed', backup_state: 'nonsense', third_party_state: 'nonsense', error_code: 'HANDLER_FAILED' },
      { module: 'history', online_state: 'completed', backup_state: 'pending', error_code: 'SECRET_FREE_TEXT_LEAK' },
      { module: 'ocr', online_state: 'pending', backup_state: 'pending', error_code: 'x'.repeat(81) },
    ],
  });
  assert.deepEqual(Object.keys(projected).sort(), [
    'backup_due_at',
    'handlers',
    'id',
    'online_due_at',
    'requested_at',
    'revision',
    'state',
  ]);
  // 非法状态不被抬升为 completed（折叠到安全默认），revision 非法 ⇒ 1。
  assert.equal(projected.state, 'processing');
  assert.equal(projected.revision, 1);
  // 行状态非法 ⇒ pending；白名单内的安全码原样透出，白名单外/超长一律折叠为 HANDLER_FAILED。
  assert.deepEqual(projected.handlers[0], {
    module: 'favorites',
    online_state: 'completed',
    backup_state: 'pending',
    third_party_state: null,
    error_code: 'HANDLER_FAILED',
  });
  assert.equal(projected.handlers[1].error_code, 'HANDLER_FAILED', '白名单外的自由文本不得透出');
  assert.equal(projected.handlers[2].error_code, 'HANDLER_FAILED', '超长文本不得透出');

  // date-time 不可解析时**抛错**（宁可 500，也不回一个编造的期限）。
  assert.throws(
    () =>
      projectReceipt({
        id: 'x',
        state: 'blocked',
        revision: 1,
        requested_at: 'not-a-date',
        online_due_at: '2026-10-22T03:00:00.000Z',
        backup_due_at: '2026-11-14T03:00:00.000Z',
        handlers: [],
      }),
    /requested_at/,
  );
});

test('GY-I22：在途取消 —— 本人可取消、非本人无入口、终态不可取消、取消后状态可核', async () => {
  const clock = scriptedClock();
  const { favoritesStore, historyStore, messagesStore, conversationsStore } = await seed(clock);
  const deletion = createUserDataDeletion({ favoritesStore, historyStore, messagesStore, conversationsStore, now: clock.now });

  // 两个主体各建一个在途注销请求（requested 即「在途」，尚未进入处理）。
  const reqA = deletion.requestDeletionFor(USER_A.userId, { receiptInput: 'cancel-a' });
  const idA = String(reqA['id']);
  const reqB = deletion.requestDeletionFor(USER_B.userId, { receiptInput: 'cancel-b' });
  const idB = String(reqB['id']);
  assert.equal(reqA['state'], 'requested');

  // 本人可取消：state → cancelled、revision +1，回执与完成判定都可核。
  const cancelledA = deletion.cancelDeletion(USER_A.userId);
  assert.ok(cancelledA !== null, '本人有在途请求时取消不得返回 null');
  assert.equal(cancelledA['id'], idA);
  assert.equal(cancelledA['state'], 'cancelled', '取消后回执必须如实 state=cancelled');
  assert.equal(deletion.receipt(idA)['state'], 'cancelled');
  assert.equal(deletion.completionStatus(idA).state, 'cancelled');
  assert.equal(deletion.completionStatus(idA).completed, false, '取消不是完成');

  // 非本人无入口：取消 A 不影响 B 的在途请求（B 仍停留在 requested，未被 A 的取消动过）。
  assert.equal(deletion.completionStatus(idB).state, 'requested');
  assert.notEqual(deletion.receipt(idB)['state'], 'cancelled');

  // 终态不可取消：A 已是 cancelled（终态），再取消 → OBJECT_UNAVAILABLE(409)。
  assert.throws(
    () => deletion.cancelDeletion(USER_A.userId),
    (error) => error !== null && typeof error === 'object' && error.code === 'OBJECT_UNAVAILABLE',
  );

  // 无在途请求的未知主体 → null（调用方据此 404，不编造回执）。
  assert.equal(deletion.cancelDeletion('no-such-user'), null);
});
