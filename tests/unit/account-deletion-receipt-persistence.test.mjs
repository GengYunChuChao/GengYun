// GY-I19（#19 片B）· 回执 bearer 台账持久化 + 注销在途外发撤销的**单元层**证据。
//
// 覆盖两个收口（都是集成脚本够不到或不该等的语义）：
//   1. **回执 bearer 台账持久化**（`createPostgresDeletionReceiptRegistry`）：
//      `tokenHash → requestId` 落到 `deletion_requests.receipt_bearer_hash`（迁移 0038）⇒
//      **进程重启后旧回执仍可反查**（新实例、同一持久层，`resolveRequestId` 不再 null）。
//      合成 PG 替身只按 SQL 片段回 canned 结果，不连任何数据库。
//   2. **注销在途外发撤销的注入**（`createAccountDeletionRequestService` 的 `egressRevoker`）：
//      注入 ⇒ 受理前先 `onAccountSuspendedOrDeleted({ userId })`；撤销失败 ⇒ 拒绝受理（fail-closed）；
//      **不注入 ⇒ 行为与接线前逐字一致**（照旧受理、不撤销在途外发、不伪造「外发已冻结」）。
//      与 consent-pg / grant-pg 的「无注入仍 OBJECT_UNAVAILABLE 兜底」同源：缺省不注入不改变既有行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFavoritesStore } from '../../services/api/src/favorites/store.ts';
import { createMemoryHistoryStore } from '../../services/api/src/history/store.ts';
import { createMemoryConversationStore } from '../../services/api/src/conversations/store.ts';
import { createMemoryMessagesStore } from '../../services/api/src/messages/store.ts';
import { createUserDataDeletion } from '../../services/api/src/privacy/user-data-deletion.ts';
import {
  createAccountDeletionRequestService,
  createDeletionReceiptRegistry,
  createPostgresDeletionReceiptRegistry,
} from '../../services/api/src/privacy/account-deletion.ts';
import { USER_A } from './favorites-history-fixtures.mjs';

const CLOCK_MS = Date.parse('2026-10-24T03:00:00.000Z');

/**
 * 合成 PG 替身：按 SQL 片段模拟迁移 0038 的三条窄函数（set/resolve/count）。
 * `store` 是持久层（`requestId → { tokenHash, expiresAt }`）；同一份 store 交给两个 registry 实例
 * 即模拟「进程重启、数据库仍在」。
 */
function makeFakePool() {
  const store = new Map();
  const pool = {
    async query(text, params) {
      const sql = String(text);
      if (sql.includes('set_deletion_receipt')) {
        const [requestId, tokenHash, , expiresAt] = params;
        if (tokenHash === null) {
          const rec = store.get(requestId);
          if (rec === undefined || rec.tokenHash === null) return { rows: [{ updated: 0 }] };
          rec.tokenHash = null;
          return { rows: [{ updated: 1 }] };
        }
        const rec = store.get(requestId);
        if (rec === undefined) return { rows: [{ updated: 0 }] };
        rec.tokenHash = tokenHash;
        rec.expiresAt = expiresAt;
        return { rows: [{ updated: 1 }] };
      }
      if (sql.includes('resolve_deletion_receipt')) {
        const [tokenHash] = params;
        for (const [requestId, rec] of store) {
          if (rec.tokenHash === tokenHash && new Date(rec.expiresAt).getTime() > CLOCK_MS) {
            return { rows: [{ request_id: requestId }] };
          }
        }
        return { rows: [] };
      }
      if (sql.includes('count_deletion_receipts')) {
        let n = 0;
        for (const rec of store.values()) {
          if (rec.tokenHash !== null && new Date(rec.expiresAt).getTime() > CLOCK_MS) n += 1;
        }
        return { rows: [{ n }] };
      }
      throw new Error(`合成替身未覆盖的 SQL：${sql}`);
    },
  };
  return { pool, store };
}

async function seedStores(clockMs) {
  const favoritesStore = createMemoryFavoritesStore({ now: () => clockMs });
  const historyStore = createMemoryHistoryStore({ now: () => clockMs });
  const messagesStore = createMemoryMessagesStore({ now: () => clockMs });
  const conversationsStore = createMemoryConversationStore();
  await favoritesStore.insertFavorite({
    id: '00000000-0000-4000-8a00-000000000001',
    revision: 1,
    owner_id: USER_A.userId,
    target_ref: { type: 'species', id: 'spc-a', revision: 1 },
    created_at: new Date(clockMs).toISOString(),
  });
  return { favoritesStore, historyStore, messagesStore, conversationsStore };
}

test('GY-I19 片B：回执 bearer 摘要落持久层 ⇒ 重启（新台账实例）后旧回执仍可反查、不再 404', async () => {
  const { pool, store } = makeFakePool();
  const requestId = '00000000-0000-4000-8f00-000000000001';
  // 受理事务（0016）已先落 `deletion_requests` 行；台账只需在该行上写回执 bearer 摘要。
  store.set(requestId, { tokenHash: null, expiresAt: null });

  const now = () => new Date(CLOCK_MS);
  const registryBeforeRestart = createPostgresDeletionReceiptRegistry({ pool, now });
  const issued = await registryBeforeRestart.issue(requestId);
  assert.ok(issued.token.length >= 32, '签发的是不透明随机 bearer');
  assert.equal(await registryBeforeRestart.resolveRequestId(issued.token), requestId);
  assert.equal(await registryBeforeRestart.liveCount(), 1);

  // 重启：同一持久层、全新台账实例 ⇒ 旧 bearer 摘要仍在库里，反查不再因进程内台账清空而 null。
  const registryAfterRestart = createPostgresDeletionReceiptRegistry({ pool, now });
  assert.equal(await registryAfterRestart.resolveRequestId(issued.token), requestId, '重启后旧回执必须仍可反查');
  assert.equal(await registryAfterRestart.liveCount(), 1);

  // 换发覆盖旧摘要：重放时 `issue` 先作废旧摘要 ⇒ 旧 bearer 立即失效、新 bearer 可反查。
  const reissued = await registryAfterRestart.issue(requestId);
  assert.equal(await registryAfterRestart.resolveRequestId(issued.token), null, '换发后旧 bearer 必须立即失效');
  assert.equal(await registryAfterRestart.resolveRequestId(reissued.token), requestId);

  // 显式作废：`forgetRequest` 清掉摘要 ⇒ 之后不可解析。
  assert.equal(await registryAfterRestart.forgetRequest(requestId), 1);
  assert.equal(await registryAfterRestart.resolveRequestId(reissued.token), null);
  assert.equal(await registryAfterRestart.liveCount(), 0);
});

test('GY-I19 片B：注销受理注入 egressRevoker ⇒ 受理前先撤销在途外发；不注入 ⇒ 行为与接线前逐字一致', async () => {
  const clock = { ms: CLOCK_MS, now: () => new Date(CLOCK_MS) };
  const { favoritesStore, historyStore, messagesStore, conversationsStore } = await seedStores(CLOCK_MS);
  const deletion = createUserDataDeletion({ favoritesStore, historyStore, messagesStore, conversationsStore, now: clock.now });
  const receipts = createDeletionReceiptRegistry({ now: clock.now });

  const calls = [];
  const serviceWithRevoker = createAccountDeletionRequestService({
    deletion,
    receipts,
    egressRevoker: {
      onAccountSuspendedOrDeleted: async (input) => {
        calls.push(input);
        return { revokedInFlight: 3 };
      },
    },
  });
  const acceptedWith = await serviceWithRevoker.request({ userId: USER_A.userId, receiptInput: 'receipt-input-with-revoker' });
  assert.ok(acceptedWith.receipt_token, '注入撤销消费者后受理仍应成功');
  assert.deepEqual(calls, [{ userId: USER_A.userId }], '撤销消费者必须在受理前被调用且只调用一次');

  // 不注入 ⇒ 照旧受理、不撤销在途外发、不伪造「外发已冻结」（缺省行为与接线前逐字一致）。
  const deletion2 = createUserDataDeletion({ favoritesStore, historyStore, messagesStore, conversationsStore, now: clock.now });
  const receipts2 = createDeletionReceiptRegistry({ now: clock.now });
  const serviceWithoutRevoker = createAccountDeletionRequestService({ deletion: deletion2, receipts: receipts2 });
  const acceptedWithout = await serviceWithoutRevoker.request({ userId: USER_A.userId, receiptInput: 'receipt-input-without-revoker' });
  assert.ok(acceptedWithout.receipt_token, '不注入撤销消费者时受理仍应成功（缺省不撤销在途外发）');
});

test('GY-I19 片B：撤销消费者抛错 ⇒ 拒绝受理（fail-closed），不得假装「外发已冻结」', async () => {
  const clock = { ms: CLOCK_MS, now: () => new Date(CLOCK_MS) };
  const { favoritesStore, historyStore, messagesStore, conversationsStore } = await seedStores(CLOCK_MS);
  const deletion = createUserDataDeletion({ favoritesStore, historyStore, messagesStore, conversationsStore, now: clock.now });
  const receipts = createDeletionReceiptRegistry({ now: clock.now });

  const failingRevoker = {
    onAccountSuspendedOrDeleted: async () => {
      const error = new Error('relation "exports" does not exist');
      error.code = '42P01';
      throw error;
    },
  };
  const service = createAccountDeletionRequestService({ deletion, receipts, egressRevoker: failingRevoker });
  await assert.rejects(
    () => service.request({ userId: USER_A.userId, receiptInput: 'receipt-input-failing-revoker' }),
    (error) => /exports/.test(String(error?.message ?? error)) || (error?.code === '42P01'),
    '撤销在途外发失败必须拒绝受理（fail-closed），不得伪造受理成功',
  );
  assert.equal(await receipts.liveCount(), 0, '被拒的受理不得留下任何回执');
});
