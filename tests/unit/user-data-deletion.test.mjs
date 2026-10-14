// GY-I16（#16）第 4 项：注销删除接 F13 —— **复用已合并的** packages/privacy 删除注册协议。
//
// 本文件直接驱动**已合并**的 `packages/privacy/deletion.mjs`（模块注册协议）与
// `packages/privacy/deletion-modules.mjs`（全模块完成判定），断言：
//   1. 收藏／历史两个模块注册到的是**同一份**协议（不是平行实现）；
//   2. 处理器只清理**绑定主体**的数据，其它主体不受影响；
//   3. 备份副本清除未接线时 `backup_state` 如实为 `pending`（**不谎称 completed**），
//      因此整体未完成 —— 缺口对用户与监工可见；
//   4. 接线备份清除端口后同一套协议即可判定完成；
//   5. 未绑定主体的请求 ⇒ 处理器抛错被折叠为 `blocked`，**不清理任何人的数据**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import {
  FAVORITES_DELETION_MODULE,
  HISTORY_DELETION_MODULE,
  USER_DATA_DELETION_MODULES,
  createUserDataDeletion,
} from '../../services/api/src/privacy/user-data-deletion.ts';
import { USER_A, USER_B, scriptedClock } from './favorites-history-fixtures.mjs';

async function seed() {
  const clock = scriptedClock();
  const favoritesStore = createMemoryFavoritesStore({ now: () => clock.ms });
  const historyStore = createMemoryHistoryStore({ now: () => clock.ms });
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
  }
  return { clock, favoritesStore, historyStore };
}

test('F13：必需模块闭集只含本片两个模块，且非闭集模块注册即拒（复用同一协议）', async () => {
  const { favoritesStore, historyStore } = await seed();
  const deletion = createUserDataDeletion({ favoritesStore, historyStore });
  assert.deepEqual(deletion.requiredModules(), [...USER_DATA_DELETION_MODULES]);
  assert.deepEqual(deletion.requiredModules(), ['favorites', 'history']);
  assert.equal(FAVORITES_DELETION_MODULE, 'favorites');
  assert.equal(HISTORY_DELETION_MODULE, 'history');
  // 闭集外的模块不可注册（协议自带约束；本片不绕过它）。
  assert.throws(() => deletion.coordinator.registerModule('other-module', async () => ({})), /不在必需模块闭集内/);
  assert.deepEqual(deletion.coordinator.missingRegistrations(), []);
});

test('F13：按主体清理，其它主体不受影响；在线证据非空，备份如实 pending（不谎称完成）', async () => {
  const { favoritesStore, historyStore } = await seed();
  const deletion = createUserDataDeletion({ favoritesStore, historyStore });
  const request = deletion.requestDeletionFor(USER_A.userId);
  const requestId = String(request.id);
  assert.ok(requestId.length > 0);

  await deletion.executeHandlers(requestId);

  // A 的数据被清空；B 的完好（归属正确，绝不清理到别人）。
  assert.equal((await favoritesStore.listFavoritesByOwner(USER_A.userId)).length, 0);
  assert.equal((await historyStore.listHistoryByOwner(USER_A.userId)).length, 0);
  assert.equal((await favoritesStore.listFavoritesByOwner(USER_B.userId)).length, 1);
  assert.equal((await historyStore.listHistoryByOwner(USER_B.userId)).length, 1);

  // 回执是**契约形状**（DeletionReceipt），且模块行状态如实。
  const receipt = deletion.receipt(requestId);
  assert.ok(Array.isArray(receipt.handlers));
  const byModule = new Map(receipt.handlers.map((row) => [row.module, row]));
  for (const module of ['favorites', 'history']) {
    const row = byModule.get(module);
    assert.ok(row !== undefined, `回执必须含模块 ${module}`);
    assert.equal(row.online_state, 'completed', '在线行确实已删除 ⇒ completed');
    assert.equal(row.backup_state, 'pending', '备份副本清除未接线 ⇒ 如实 pending，不得谎称 completed');
    assert.equal(row.error_code, null);
  }

  // 审计只含模块名/行数/状态，不含任何私有正文或凭据。
  const audit = deletion.audit();
  assert.equal(audit.length, 2);
  for (const entry of audit) {
    assert.equal(entry.userId, USER_A.userId);
    assert.equal(entry.onlineRemoved, 1);
    assert.equal(entry.backupState, 'pending');
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'backupState', 'module', 'onlineRemoved', 'requestId', 'userId'].sort());
  }

  // 备份未接线 ⇒ 全模块**未完成**（缺口可见，而不是"看不见即完成"）。
  const status = deletion.completionStatus(requestId);
  assert.equal(status.completed, false, '备份未完成时整体不得判完成');
  assert.notEqual(status.state, 'completed');
});

test('F13：接线备份清除端口后，同一套协议即可判完成（缺口补上即通过）', async () => {
  const { favoritesStore, historyStore } = await seed();
  const purged = [];
  const backupPurge = {
    kind: 'wired',
    available: true,
    async purge(input) {
      purged.push(input);
      if (input.module === 'history') return { purged: false };
      return { purged: true, evidenceRef: 'backup-replica-purged:2026-10-14' };
    },
  };
  const deletion = createUserDataDeletion({ favoritesStore, historyStore, backupPurge });
  const requestId = String(deletion.requestDeletionFor(USER_A.userId).id);
  await deletion.executeHandlers(requestId);

  const receipt = deletion.receipt(requestId);
  const byModule = new Map(receipt.handlers.map((row) => [row.module, row]));
  assert.equal(byModule.get('favorites').backup_state, 'completed', '有证据的备份清除 ⇒ completed');
  assert.equal(byModule.get('history').backup_state, 'pending', '未清除的备份 ⇒ 仍 pending（不谎称）');
  assert.equal(purged.length, 2, '两个模块各调用一次备份清除端口');

  const status = deletion.completionStatus(requestId);
  assert.equal(status.completed, false, '仍有一个模块备份未完成 ⇒ 整体未完成');
  assert.deepEqual([...status.missingModules], []);

  // 数据确实被清（在线部分），且 B 不受影响。
  assert.equal((await favoritesStore.listFavoritesByOwner(USER_A.userId)).length, 0);
  assert.equal((await favoritesStore.listFavoritesByOwner(USER_B.userId)).length, 1);
});

test('F13：未绑定主体的请求 ⇒ 处理器抛错折叠为 blocked，且不清理任何人的数据', async () => {
  const { favoritesStore, historyStore } = await seed();
  const deletion = createUserDataDeletion({ favoritesStore, historyStore });
  // 绕过 `requestDeletionFor`（不经主体绑定）直接建请求：模拟接线错误。
  const orphan = deletion.coordinator.createDeletionRequest();
  const orphanId = String(orphan.id);
  await deletion.executeHandlers(orphanId);

  const receipt = deletion.receipt(orphanId);
  for (const row of receipt.handlers) {
    assert.equal(row.online_state, 'blocked');
    assert.equal(row.backup_state, 'blocked');
    assert.equal(row.error_code, 'HANDLER_FAILED', '原始异常文本必须被折叠为固定安全错误码');
  }
  // 谁的数据都没被删。
  assert.equal((await favoritesStore.listFavoritesByOwner(USER_A.userId)).length, 1);
  assert.equal((await historyStore.listHistoryByOwner(USER_A.userId)).length, 1);
  assert.equal((await favoritesStore.listFavoritesByOwner(USER_B.userId)).length, 1);
  assert.equal((await historyStore.listHistoryByOwner(USER_B.userId)).length, 1);
  assert.equal(deletion.audit().length, 0, '未绑定主体的处理器不得产生清理审计');
  assert.equal(deletion.completionStatus(orphanId).completed, false);
});

test('F13：清理可重跑 —— 未完成行按协议重试（数据仍幂等），已完成行不重跑', async () => {
  const { favoritesStore, historyStore } = await seed();
  const deletion = createUserDataDeletion({ favoritesStore, historyStore });
  const requestId = String(deletion.requestDeletionFor(USER_A.userId).id);
  await deletion.executeHandlers(requestId);
  assert.equal(deletion.audit().length, 2);
  assert.equal(deletion.audit().every((entry) => entry.onlineRemoved === 1), true);

  // 备份未接线 ⇒ 行仍是 running（未完成）⇒ 协议按设计**重试**；数据层面幂等：这次没有可删的行。
  await deletion.executeHandlers(requestId);
  assert.equal(deletion.audit().length, 4, '未完成的行按协议重试');
  assert.deepEqual(
    deletion.audit().slice(2).map((entry) => entry.onlineRemoved),
    [0, 0],
    '重跑不得再删到数据（幂等）',
  );
  assert.equal((await favoritesStore.listFavoritesByOwner(USER_A.userId)).length, 0);
  assert.equal((await historyStore.listHistoryByOwner(USER_B.userId)).length, 1, '其它主体始终不受影响');
  // 备份已接线且有证据 ⇒ 行进入 completed ⇒ 协议**跳过**重跑（审计不再增长）。
  const { favoritesStore: fav2, historyStore: his2 } = await seed();
  const wired = createUserDataDeletion({
    favoritesStore: fav2,
    historyStore: his2,
    backupPurge: {
      kind: 'wired',
      available: true,
      async purge() {
        return { purged: true, evidenceRef: 'backup-replica-purged:2026-10-14' };
      },
    },
  });
  const wiredId = String(wired.requestDeletionFor(USER_A.userId).id);
  await wired.executeHandlers(wiredId);
  const afterFirst = wired.audit().length;
  assert.equal(wired.completionStatus(wiredId).completed, true, '在线与备份均完成且证据齐全 ⇒ 判完成');
  await wired.executeHandlers(wiredId);
  assert.equal(wired.audit().length, afterFirst, '已 completed 的行不重跑');
});
