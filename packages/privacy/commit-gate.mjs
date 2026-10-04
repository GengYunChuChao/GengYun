/**
 * GY-I27 隐私模块 · 提交门禁（Commit Gate）——把「账号 / 全部必需用途 / 接收方失效」
 * 与「派发或回写提交」绑定为**不可分离**的原子协议。
 *
 * 为什么需要它（修复轮 4 结论）：
 *   仅用「多读一次异步快照」（顺序重读）**不能**证明最终提交安全——任一 `await` 都可能被
 *   写者插入（如暂停 `recipientStore.get` 期间撤回用途，或适配器把先读到的 epoch 异步返回旧值），
 *   而先后读取的不同维度可能来自不同时刻，顺序重读无法给出「同一时刻」的一致证据。
 *
 * 本模块提供**一次性一致快照 + 单调版本字段**，并在**单个不可分割临界区**内完成校验与提交
 * （CAS 式提交原语）：校验通过才执行 `apply`；校验与 `apply` 之间**不允许**任何写者插入。
 *   - 内存参考实现：`commit` 的函数体内**不含任何 await**（同步临界区），
 *     在单线程模型下与任何 `await` 边界的写者不可交错——窗口被**真正**消除，而非再读一次。
 *   - 数据库部署：由部署方以**单事务 + 行锁 / 行版本 CAS** 实现同一 `commit` 契约
 *     （见 README「提交一致性契约」）。本模块不假装内存实现等价于实库事务。
 *
 * 契约（部署方必须实现；缺失即拒绝投入使用）：
 *   `commit(expected, { precondition, apply }) -> Promise<{ committed: boolean, reason?: CommitFailReason }>`
 *   在同一临界区内：
 *     1) 重读账号 `身份(状态 + 单调 auth_epoch)`；
 *     2) 重读 `expected.requiredConsents` 中每个用途的 `(epoch, granted)`（epoch 单调）；
 *     3) 重读接收方 `(enabled, config_version, no_training_verified, deletion_verified)`；
 *     4) 逐项与 `expected` 比对；
 *     5) `precondition()`（同步、调用方所有、如外发行的在途状态与 revision）也必须为真；
 *     6) 全部通过 → 执行 `apply()`（提交副作用）并返回 `{ committed: true }`；
 *        任一失败 → **不执行** `apply()`，返回 `{ committed: false, reason }`。
 *   **不得**在校验读取与 `apply` 之间插入任何 `await`/IO；否则临界区被撕开，窗口复现。
 */

/** 允许的失败原因（固定枚举；账本据此映射为契约错误码，未知一律 OBJECT_UNAVAILABLE）。 */
export const COMMIT_FAIL_REASONS = Object.freeze([
  'account', // 账号非活跃 / auth_epoch 不一致 / 身份快照非法或读取失败
  'consent', // 必需用途 epoch 前进、未授予或读取失败
  'recipient', // 接收方缺失 / 停用 / 版本变化 / 读取失败
  'recipient_policy', // 接收方训练或删除条款失效（SCOPE_DENIED）
  'precondition', // 调用方的同步前置条件不成立（如外发行已终态 / revision 变化）
]);

/** 失败原因 → 契约错误码（与 packages/contracts/states.json 的 error_status_map 对齐）。 */
export const COMMIT_REASON_ERROR_CODES = Object.freeze({
  account: 'ACCOUNT_INACTIVE',
  consent: 'OBJECT_UNAVAILABLE',
  recipient: 'OBJECT_UNAVAILABLE',
  recipient_policy: 'SCOPE_DENIED',
  precondition: 'OBJECT_UNAVAILABLE',
});

const REASON_SET = new Set(COMMIT_FAIL_REASONS);

/**
 * 参考实现（内存）：由**同步访问器**构成的一致快照，`commit` 体内无 await。
 * 传入的三个 store 必须提供同步快照方法；缺失即抛错（拒绝投入使用）。
 *
 * @param {{
 *   account: { identityOf: (userId: string) => { state: string, authEpoch: number } },
 *   consentStore: { snapshotOf: (q: { userId: string, purpose: string }) => { epoch: number, granted: boolean } },
 *   recipientStore: { currentOf: (id: string) => object|null },
 * }} deps
 */
export function createCommitGate({ account, consentStore, recipientStore } = {}) {
  if (!account || typeof account.identityOf !== 'function') {
    throw new Error('createCommitGate 需要 account 提供同步快照方法 identityOf(userId)');
  }
  if (!consentStore || typeof consentStore.snapshotOf !== 'function') {
    throw new Error(
      'createCommitGate 需要 consentStore 提供同步快照方法 snapshotOf({ userId, purpose })',
    );
  }
  if (!recipientStore || typeof recipientStore.currentOf !== 'function') {
    throw new Error('createCommitGate 需要 recipientStore 提供同步快照方法 currentOf(recipientId)');
  }

  /**
   * 同步一致校验：全部读取在同一个无 await 的临界区内完成，返回失败原因或 null。
   * 任一读取抛出/返回非法值一律视为对应维度失效（**不静默放行**）。
   * @returns {'account'|'consent'|'recipient'|'recipient_policy'|null}
   */
  function verify(expected) {
    if (!expected || typeof expected !== 'object') return 'precondition';

    let accountSnapshot;
    try {
      accountSnapshot = account.identityOf(expected.userId);
    } catch {
      return 'account';
    }
    if (!accountSnapshot || accountSnapshot.state !== 'active') return 'account';
    if (
      !Number.isInteger(accountSnapshot.authEpoch) ||
      accountSnapshot.authEpoch !== expected.authEpoch
    ) {
      return 'account';
    }

    for (const [purpose, epoch] of Object.entries(expected.requiredConsents ?? {})) {
      let snapshot;
      try {
        snapshot = consentStore.snapshotOf({ userId: expected.userId, purpose });
      } catch {
        return 'consent';
      }
      if (!snapshot || snapshot.granted !== true || snapshot.epoch !== epoch) return 'consent';
    }

    let recipient;
    try {
      recipient = recipientStore.currentOf(expected.recipientId);
    } catch {
      return 'recipient';
    }
    if (!recipient || recipient.enabled !== true) return 'recipient';
    if (recipient.config_version !== expected.recipientConfigVersion) return 'recipient';
    if (expected.requireRecipientIntegrity) {
      if (recipient.no_training_verified !== true) return 'recipient_policy';
      if (recipient.deletion_verified !== true) return 'recipient_policy';
    }
    return null;
  }

  /**
   * CAS 式提交原语。函数体内**无 await**：从校验到 apply 为单个同步临界区，
   * 任何在 await 边界发生的写者都不可能插入其中。
   * @param {object} expected 预留时捕获的快照（见 ledger.reserve）
   * @param {{ precondition?: () => boolean, apply: () => void }} hooks
   * @returns {Promise<{ committed: boolean, reason?: string }>}
   */
  async function commit(expected, { precondition, apply } = {}) {
    if (typeof apply !== 'function') {
      throw new Error('commit 需要 apply 回调');
    }
    // —— 同步临界区开始（以下到 apply 之间严禁出现 await）——
    const reason = verify(expected);
    if (reason !== null) return { committed: false, reason };
    if (typeof precondition === 'function' && precondition() !== true) {
      return { committed: false, reason: 'precondition' };
    }
    apply();
    // —— 同步临界区结束 ——
    return { committed: true };
  }

  return { commit, verify, _reasons: REASON_SET };
}
