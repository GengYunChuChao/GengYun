/**
 * GY-I27 隐私模块 · 外发账本。
 *
 * 登记真实图片/录音/转写/会话/任务的外发：userid / purpose / recipient / source_version。
 * 对应 db/migrations/0003_privacy_consent.sql 的 exports 表 + recipients 表。
 *
 * 生命周期：reserved（预留，锁定账号版本/全部必需用途 epoch/接收方版本）→
 *           sent（已发出）｜ failed（失败/撤回/取消）｜ outcome_unknown（供应商结果未知）。
 *
 * 核心守卫（docs/architecture/state-contract.md「媒体及 AI 任务」）：
 *   - 无授权 / 错用途不能触发实际外发（reserve 即拦截）。
 *   - 不默认第三方训练：external_inference 外发要求 recipient.no_training_verified 为真。
 *   - 撤回/注销立即禁止新外发；已提交外部请求视为在途，禁止回写。
 *   - 取消/撤回后的版本不可被回调复活（guardWriteback 阻断）。
 *
 * 快照语义（本轮监工 P1 修复）：
 *   - reserve 保存「全部必需用途的 epoch」+「外发时固定的账号 auth_epoch」+「接收方 config_version」；
 *   - 派发（markSent）与回写（guardWriteback）始终以这些快照为准重查，不接收调用方覆盖的新上下文。
 */
import { randomUUID } from 'node:crypto';
import {
  CONSENT_PURPOSES,
  MEDIA_PURPOSES,
  MEDIA_PURPOSE_REQUIRED_CONSENTS,
} from './constants.mjs';
import { PrivacyError } from './errors.mjs';
import { createPrivacyGuard } from './guard.mjs';

/**
 * @param {{
 *   consentStore: object,
 *   account: object,
 *   recipientStore: { get: (id: string) => Promise<object|null> },
 *   now?: () => Date,
 * }} deps
 */
export function createExportLedger({ consentStore, account, recipientStore, now = () => new Date() } = {}) {
  const guard = createPrivacyGuard({ account, consentStore, now });
  /** @type {Map<string, object>} */
  const rows = new Map();

  function assertValidPurpose(purpose) {
    if (!CONSENT_PURPOSES.includes(purpose)) {
      throw new PrivacyError('SCOPE_DENIED', `未知用途：${purpose}`);
    }
  }

  function assertInFlight(record) {
    if (record.state !== 'reserved' && record.state !== 'sent') {
      throw new PrivacyError('OBJECT_UNAVAILABLE', `外发已终态（${record.state}），不可变更`);
    }
  }

  /** 重查账号快照：始终用 record.authEpoch（外发时固定的账号版本），不接受调用方覆盖。 */
  async function assertAccountIntact(record) {
    const state = await account.stateOf(record.userId);
    if (state !== 'active') {
      throw new PrivacyError('ACCOUNT_INACTIVE', `账号状态为 ${state}，禁止操作`);
    }
    if (typeof account.authEpochOf === 'function') {
      const cur = await account.authEpochOf(record.userId);
      if (cur !== record.authEpoch) {
        throw new PrivacyError('ACCOUNT_INACTIVE', '账号状态已变更，禁止操作');
      }
    }
  }

  /** 重查全部必需用途的 epoch 与授予状态：任一撤回/变更即阻断。 */
  async function assertAllConsentsIntact(record) {
    for (const [p, epoch] of Object.entries(record.requiredConsents ?? {})) {
      const cur = await consentStore.currentEpoch({ userId: record.userId, purpose: p });
      if (cur !== epoch) {
        throw new PrivacyError('OBJECT_UNAVAILABLE', `授权 ${p} 已撤回或变更，禁止外发`);
      }
      if (!(await consentStore.isGranted({ userId: record.userId, purpose: p }))) {
        throw new PrivacyError('OBJECT_UNAVAILABLE', `授权 ${p} 已失效，禁止外发`);
      }
    }
  }

  /** 重查当前接收方资格与绑定版本：停用/版本变化/训练条款失效均阻断新外发与回写。 */
  async function assertRecipientIntact(record) {
    const recipient = recipientStore ? await recipientStore.get(record.recipientId) : null;
    if (!recipient || !recipient.enabled) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', `接收方不可用：${record.recipientId}`);
    }
    if (recipient.config_version !== record.recipientConfigVersion) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', `接收方 ${record.recipientId} 版本已变化，需重新同意`);
    }
    if (record.purpose === 'external_inference') {
      if (!recipient.no_training_verified) {
        throw new PrivacyError('SCOPE_DENIED', `接收方 ${record.recipientId} 未验证禁止擅自训练`);
      }
      if (!recipient.deletion_verified) {
        throw new PrivacyError('SCOPE_DENIED', `接收方 ${record.recipientId} 未验证删除确认能力`);
      }
    }
  }

  /**
   * 预留外发：无授权/错用途/账号非活跃/接收方未验证均在此拦截，不产生实际外发。
   * @returns {Promise<object>} export 记录（state=reserved）
   */
  async function reserve({
    userId,
    authEpoch,
    objectType,
    objectId,
    objectRevision,
    dataType,
    purpose,
    recipientId,
    sourceVersion = null,
  }) {
    if (!objectType || typeof objectType !== 'string') {
      throw new PrivacyError('INVALID_REQUEST', 'object_type 缺失');
    }
    if (!objectId) throw new PrivacyError('INVALID_REQUEST', 'object_id 缺失');
    if (!Number.isInteger(objectRevision) || objectRevision < 1) {
      throw new PrivacyError('INVALID_REQUEST', 'object_revision 非法');
    }
    // 身份版本必须存在（缺身份版本不放行）。
    if (!Number.isInteger(authEpoch) || authEpoch < 1) {
      throw new PrivacyError('SESSION_REQUIRED', '缺少身份版本（auth_epoch）');
    }
    assertValidPurpose(purpose);

    // 错用途：purpose 必须属于 data_type 的必需集合。
    if (!MEDIA_PURPOSES.includes(dataType)) {
      throw new PrivacyError('SCOPE_DENIED', `未知资料类型：${dataType}`);
    }
    if (!MEDIA_PURPOSE_REQUIRED_CONSENTS[dataType].includes(purpose)) {
      throw new PrivacyError(
        'SCOPE_DENIED',
        `用途 ${purpose} 与资料类型 ${dataType} 不匹配（错用途）`,
      );
    }

    // 账号活跃 + 身份版本一致（reserve 时刻校验会话提供的 authEpoch）。
    await guard.assertAccountActive(userId, { authEpoch });

    // 保存全部必需用途的 epoch 快照（缺授权 → CONSENT_REQUIRED）。
    const requiredConsents = {};
    for (const p of MEDIA_PURPOSE_REQUIRED_CONSENTS[dataType]) {
      const granted = await consentStore.isGranted({ userId, purpose: p });
      if (!granted) {
        throw new PrivacyError('CONSENT_REQUIRED', `缺少用途授权：${p}`);
      }
      requiredConsents[p] = await consentStore.currentEpoch({ userId, purpose: p });
    }

    // 接收方必须存在且 enabled；绑定接收方：每个用途授权须包含该 recipient。
    const recipient = recipientStore ? await recipientStore.get(recipientId) : null;
    if (!recipient) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', `接收方不可用：${recipientId}`);
    }
    if (!recipient.enabled) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', `接收方未启用：${recipientId}`);
    }
    for (const p of MEDIA_PURPOSE_REQUIRED_CONSENTS[dataType]) {
      const consent = await consentStore.getConsent({ userId, purpose: p });
      if (!consent || !consent.recipientIds.includes(recipientId)) {
        throw new PrivacyError(
          'CONSENT_REQUIRED',
          `用途 ${p} 未绑定接收方 ${recipientId}`,
        );
      }
    }

    // 不默认第三方训练：external_inference 外发要求已验证不擅自训练 + 可删除。
    if (purpose === 'external_inference') {
      if (!recipient.no_training_verified) {
        throw new PrivacyError('SCOPE_DENIED', `接收方 ${recipientId} 未验证禁止擅自训练`);
      }
      if (!recipient.deletion_verified) {
        throw new PrivacyError('SCOPE_DENIED', `接收方 ${recipientId} 未验证删除确认能力`);
      }
    }

    const record = {
      id: randomUUID(),
      userId,
      objectType,
      objectId,
      objectRevision,
      purpose,
      consentEpoch: requiredConsents[purpose],
      requiredConsents,
      recipientId,
      recipientConfigVersion: recipient.config_version,
      sourceVersion,
      state: 'reserved',
      requestedAt: now(),
      sentAt: null,
      providerRequestRefCipher: null,
      deletionState: 'not_requested',
      authEpoch,
      createdAt: now(),
      updatedAt: now(),
    };
    rows.set(record.id, record);
    return { ...record };
  }

  function get(id) {
    const r = rows.get(id);
    return r ? { ...r } : null;
  }

  /**
   * 实际派发前二次核对（账号快照 / 全部必需用途 / 接收方资格），然后置 sent。
   * 不接受调用方覆盖 authEpoch。
   */
  async function markSent(id) {
    const record = rows.get(id);
    if (!record) throw new PrivacyError('NOT_FOUND', '外发记录不存在');
    assertInFlight(record);
    await assertAccountIntact(record);
    await assertAllConsentsIntact(record);
    await assertRecipientIntact(record);
    record.state = 'sent';
    record.sentAt = now();
    record.updatedAt = now();
    return { ...record };
  }

  function markFailed(id, { errorCode = null } = {}) {
    const record = rows.get(id);
    if (!record) throw new PrivacyError('NOT_FOUND', '外发记录不存在');
    assertInFlight(record);
    record.state = 'failed';
    record.errorCode = errorCode;
    record.updatedAt = now();
    return { ...record };
  }

  function markOutcomeUnknown(id, { errorCode = null } = {}) {
    const record = rows.get(id);
    if (!record) throw new PrivacyError('NOT_FOUND', '外发记录不存在');
    assertInFlight(record);
    record.state = 'outcome_unknown';
    record.errorCode = errorCode;
    record.updatedAt = now();
    return { ...record };
  }

  /**
   * 撤回/注销后撤销在途外发：reserved/sent → failed。
   * purpose 为空（注销/全撤）撤销该用户全部在途；否则撤销「依赖该用途」的在途记录。
   */
  function revokeInFlight({ userId, purpose = null } = {}) {
    let count = 0;
    for (const record of rows.values()) {
      if (record.userId !== userId) continue;
      if (purpose && !Object.prototype.hasOwnProperty.call(record.requiredConsents ?? {}, purpose)) {
        continue;
      }
      if (record.state === 'reserved' || record.state === 'sent') {
        record.state = 'failed';
        record.errorCode = 'CONSENT_WITHDRAWN';
        record.updatedAt = now();
        count += 1;
      }
    }
    return count;
  }

  /**
   * 在途结果回写守卫：任务保存前/回调落库前调用。
   * 始终以 reserve 时的快照（账号版本 / 全部必需用途 epoch / 接收方版本）重查，
   * 不依赖调用方是否提供 authEpoch；满足以下任一即阻断（不落库、不可复活）：
   *   - 账号非活跃 / auth_epoch 已变更（注销/停用/会话失效）
   *   - 任一必需用途 epoch 已前进（撤回或重新授权）
   *   - 接收方停用 / 版本变化 / 训练或删除条款失效
   *   - 外发记录已终态（取消/失败/结果未知）
   * @returns {Promise<object>} 通过校验的 export 记录
   */
  async function guardWriteback({ exportId, userId } = {}) {
    const record = rows.get(exportId);
    if (!record || record.userId !== userId) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '外发记录不存在或归属不符');
    }
    await assertAccountIntact(record);
    await assertAllConsentsIntact(record);
    await assertRecipientIntact(record);
    if (record.state !== 'reserved' && record.state !== 'sent') {
      throw new PrivacyError('OBJECT_UNAVAILABLE', `外发已终止（${record.state}），禁止回写`);
    }
    return { ...record };
  }

  return {
    reserve,
    get,
    markSent,
    markFailed,
    markOutcomeUnknown,
    revokeInFlight,
    guardWriteback,
    _rows: rows,
  };
}
