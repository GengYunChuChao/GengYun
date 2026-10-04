/**
 * GY-I27 隐私模块 · 用途授权存储（可插拔，内存实现用于单元测试与契约验证）。
 *
 * 数据模型对应 services/api/db/migrations/0003_privacy_consent.sql：
 *   - consent_records：每次授予一行（epoch 唯一），历史可追溯，撤回只改 state。
 *   - privacy_epochs：每 (user_id, purpose) 当前 epoch；授予与撤回都原子递增，
 *     使在途外发/回写持有的旧 epoch 失效。
 *
 * 授权与撤回语义（docs/architecture/state-contract.md「授权、撤回及注销」）：
 *   - 系统麦克风/定位权限 ≠ 用途授权；拒绝用途授权允许手选地区/文字替代（由 GY-I05/F12 消费）。
 *   - 撤回递增 purpose epoch，终止新外发与在途回写；重新授权为新 epoch。
 */
import { randomUUID } from 'node:crypto';
import { CONSENT_PURPOSES } from './constants.mjs';
import { PrivacyError } from './errors.mjs';

function key(userId, purpose, epoch) {
  return `${userId}\u0000${purpose}\u0000${epoch ?? ''}`;
}

function assertPurpose(purpose) {
  if (!CONSENT_PURPOSES.includes(purpose)) {
    throw new PrivacyError('INVALID_REQUEST', `未知用途：${purpose}`);
  }
}

/**
 * 创建内存授权存储。生产环境应替换为 Postgres 实现（接口相同即可插拔）。
 * @param {{ now?: () => Date }} [deps]
 */
export function createConsentStore({ now = () => new Date() } = {}) {
  /** @type {Map<string, object>} consent_records 行 */
  const records = new Map();
  /** @type {Map<string, {currentEpoch:number, state:string, revision:number}>} privacy_epochs 行 */
  const epochs = new Map();

  async function currentEpoch({ userId, purpose }) {
    assertPurpose(purpose);
    return epochs.get(key(userId, purpose))?.currentEpoch ?? 0;
  }

  async function isGranted({ userId, purpose }) {
    assertPurpose(purpose);
    return (epochs.get(key(userId, purpose))?.state ?? 'withdrawn') === 'granted';
  }

  /**
   * **同步**一致快照（提交一致性契约用）：返回该 (userId, purpose) 当前 epoch 与是否授予。
   * 同步读取内存状态、无 await，供提交门禁的原子临界区一次性读取（不产生新的异步窗口）。
   */
  function snapshotOf({ userId, purpose } = {}) {
    assertPurpose(purpose);
    const cur = epochs.get(key(userId, purpose));
    if (!cur) return { epoch: 0, granted: false };
    return { epoch: cur.currentEpoch, granted: cur.state === 'granted' };
  }

  /**
   * 授予用途授权：新 epoch，历史行保留，recipient_ids 绑定接收方。
   * @returns {Promise<object>} 新建的 consent record
   */
  async function grant({ userId, purpose, policyVersion, recipientIds = [] }) {
    assertPurpose(purpose);
    if (!policyVersion || typeof policyVersion !== 'string') {
      throw new PrivacyError('INVALID_REQUEST', 'policy_version 缺失');
    }
    if (!Array.isArray(recipientIds) || recipientIds.some((r) => typeof r !== 'string' || r.length === 0)) {
      throw new PrivacyError('INVALID_REQUEST', 'recipient_ids 非法');
    }
    const k = key(userId, purpose);
    const cur = epochs.get(k) ?? { currentEpoch: 0, state: 'withdrawn', revision: 1 };
    const epoch = cur.currentEpoch + 1;
    const record = {
      id: randomUUID(),
      userId,
      purpose,
      policyVersion,
      recipientIds: [...recipientIds],
      state: 'granted',
      epoch,
      grantedAt: now(),
      withdrawnAt: null,
      revision: 1,
    };
    records.set(key(userId, purpose, epoch), record);
    epochs.set(k, { currentEpoch: epoch, state: 'granted', revision: cur.revision + 1 });
    return { ...record };
  }

  /**
   * 撤回用途授权：当前授予行置 withdrawn，并递增当前 epoch 使在途外发失效。
   * 幂等：无授权时返回 null；重复撤回不重复递增。
   * @returns {Promise<object|null>} 被撤回的 record，或 null
   */
  async function withdraw({ userId, purpose }) {
    assertPurpose(purpose);
    const k = key(userId, purpose);
    const cur = epochs.get(k) ?? { currentEpoch: 0, state: 'withdrawn', revision: 1 };
    if (cur.state === 'withdrawn') {
      return null;
    }
    const record = records.get(key(userId, purpose, cur.currentEpoch));
    if (record && record.state === 'granted') {
      record.state = 'withdrawn';
      record.withdrawnAt = now();
      record.revision += 1;
    }
    // 撤回递增 epoch：使在途外发/回写持有的旧 epoch 失效。
    epochs.set(k, {
      currentEpoch: cur.currentEpoch + 1,
      state: 'withdrawn',
      revision: cur.revision + 1,
    });
    return record ? { ...record } : null;
  }

  /**
   * 读取当前有效的授权记录（granted），无有效授权返回 null。
   */
  async function getConsent({ userId, purpose }) {
    assertPurpose(purpose);
    const cur = epochs.get(key(userId, purpose));
    if (!cur || cur.state !== 'granted' || cur.currentEpoch === 0) return null;
    const record = records.get(key(userId, purpose, cur.currentEpoch));
    return record ? { ...record } : null;
  }

  /**
   * 返回该用户所有用途的最近授权记录（含已撤回，供 /me/consents 与追溯）。
   */
  async function list({ userId }) {
    const out = [];
    for (const purpose of CONSENT_PURPOSES) {
      const cur = epochs.get(key(userId, purpose));
      if (!cur || cur.currentEpoch === 0) continue;
      // 当前 granted：取当前行；已撤回：取上一 epoch 的撤回行。
      const epochToShow = cur.state === 'granted' ? cur.currentEpoch : cur.currentEpoch - 1;
      const record = records.get(key(userId, purpose, epochToShow));
      if (record) out.push({ ...record });
    }
    return out;
  }

  return {
    grant,
    withdraw,
    currentEpoch,
    isGranted,
    snapshotOf,
    getConsent,
    list,
  };
}
