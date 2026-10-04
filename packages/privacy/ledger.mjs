/**
 * GY-I27 隐私模块 · 外发账本。
 *
 * 登记真实图片/录音/转写/会话/任务的外发：userid / purpose / recipient / source_version。
 * 对应 services/api/db/migrations/0003_privacy_consent.sql 的 exports 表 + recipients 表。
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
 *
 * 并发安全（修复轮 2 + 3）：
 *   - 每条记录带单调递增 revision，任何状态迁移都递增；
 *   - markSent 在全部异步核对完成后，做**同步原子复核**（状态仍为在途 + revision 未变），
 *     确保 await 期间被 revokeInFlight/markFailed 置为终态的记录不会被重新置为 sent（终态不可复活）；
 *   - **提交门闩** assertCommitFence：在最后一次 await 之后全量重读「用途 epoch + 接收方 + 账号身份」
 *     快照。调用方即使**不经** revokeInFlight，只要在 await 期间注销/停用账号、前进 auth_epoch 或
 *     撤回用途，也会被这道最后重读捕获；读后到提交之间无 await 间隙，杜绝
 *     「以一次早先查询证明最终提交安全」的临界漏洞。
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
  // 强制要求「身份版本」能力：缺少 authEpochOf 的适配器会绕过账号版本核对，
  // 使旧任务在账号已注销/停用（auth_epoch 前进）后仍被放行。此处直接拒绝构造。
  if (!account || typeof account.stateOf !== 'function' || typeof account.authEpochOf !== 'function') {
    throw new Error('createExportLedger 需要注入带 stateOf 与 authEpochOf 的 account 提供者');
  }
  const guard = createPrivacyGuard({ account, consentStore, now });
  /** @type {Map<string, object>} */
  const rows = new Map();

  /** 对外投影：深拷贝授权快照，调用方改写返回值不得影响内部记录。 */
  function projectRecord(record) {
    return { ...record, requiredConsents: { ...(record.requiredConsents ?? {}) } };
  }

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

  /** 读取当前身份版本；缺失能力、查询失败或非法值一律拒绝（不静默放行）。 */
  async function readAuthEpochOrThrow(userId) {
    let current;
    try {
      current = await account.authEpochOf(userId);
    } catch {
      throw new PrivacyError('ACCOUNT_INACTIVE', '身份版本查询失败，禁止操作');
    }
    if (!Number.isInteger(current) || current < 1) {
      throw new PrivacyError('ACCOUNT_INACTIVE', '身份版本非法，禁止操作');
    }
    return current;
  }

  /** 重查账号快照：始终用 record.authEpoch（外发时固定的账号版本），不接受调用方覆盖。 */
  async function assertAccountIntact(record) {
    const state = await account.stateOf(record.userId);
    if (state !== 'active') {
      throw new PrivacyError('ACCOUNT_INACTIVE', `账号状态为 ${state}，禁止操作`);
    }
    const current = await readAuthEpochOrThrow(record.userId);
    if (current !== record.authEpoch) {
      throw new PrivacyError('ACCOUNT_INACTIVE', '账号状态已变更，禁止操作');
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
   * 提交门闩（原子协议，修复轮 3）：在**最后一次 await 之后**再全量重读快照
   * （用途 epoch / 接收方版本 / 账号状态与 auth_epoch），随后调用方立即**同步**提交/返回。
   *
   * 为什么要「bookend」：若只在前面查一次，调用方可在某次 await（如 recipientStore.get）
   * 期间把账号改为 deletion_pending / 前进 auth_epoch，或撤回用途——而**不经过** revokeInFlight，
   * 使外发行 revision 不变，先前的检查看不到真实失效。门闩把账号身份读放到最后，
   * 保证「最后一次异步读取」就是最终一致性证据；读后到提交之间无 await 间隙，杜绝临界窗口。
   *
   * 顺序有意为之：先用途、再接收方、最后账号身份（把最关键的注销/停用放在最后读）。
   */
  async function assertCommitFence(record) {
    await assertAllConsentsIntact(record);
    await assertRecipientIntact(record);
    await assertAccountIntact(record);
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
      // 冻结内部快照：调用方经公开返回值无法改写（对外返回深拷贝投影）。
      requiredConsents: Object.freeze({ ...requiredConsents }),
      recipientId,
      recipientConfigVersion: recipient.config_version,
      sourceVersion,
      state: 'reserved',
      revision: 1,
      requestedAt: now(),
      sentAt: null,
      providerRequestRefCipher: null,
      deletionState: 'not_requested',
      authEpoch,
      createdAt: now(),
      updatedAt: now(),
    };
    rows.set(record.id, record);
    return projectRecord(record);
  }

  function get(id) {
    const r = rows.get(id);
    return r ? projectRecord(r) : null;
  }

  /**
   * 实际派发前二次核对（账号快照 / 全部必需用途 / 接收方资格），然后置 sent。
   * 不接受调用方覆盖 authEpoch。
   * 异步核对完成后先过**提交门闩**（最后 await 之后全量重读快照），再做同步原子复核
   * （在途状态 + revision 未变），使 await 期间被撤回/失败/注销的记录不可被置为 sent。
   */
  async function markSent(id) {
    const record = rows.get(id);
    if (!record) throw new PrivacyError('NOT_FOUND', '外发记录不存在');
    assertInFlight(record);
    const startRevision = record.revision;
    await assertAccountIntact(record);
    await assertAllConsentsIntact(record);
    await assertRecipientIntact(record);
    // 提交门闩：最后一次 await 之后再全量重读快照（捕获 await 期间的账号变更/用途撤回）。
    await assertCommitFence(record);
    // 原子复核（无 await 间隙）：在途检查 + 版本号未被他方迁移。
    assertInFlight(record);
    if (record.revision !== startRevision) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '外发在派发前已被变更，禁止派发');
    }
    record.state = 'sent';
    record.sentAt = now();
    record.revision += 1;
    record.updatedAt = now();
    return projectRecord(record);
  }

  function markFailed(id, { errorCode = null } = {}) {
    const record = rows.get(id);
    if (!record) throw new PrivacyError('NOT_FOUND', '外发记录不存在');
    assertInFlight(record);
    record.state = 'failed';
    record.errorCode = errorCode;
    record.revision += 1;
    record.updatedAt = now();
    return projectRecord(record);
  }

  function markOutcomeUnknown(id, { errorCode = null } = {}) {
    const record = rows.get(id);
    if (!record) throw new PrivacyError('NOT_FOUND', '外发记录不存在');
    assertInFlight(record);
    record.state = 'outcome_unknown';
    record.errorCode = errorCode;
    record.revision += 1;
    record.updatedAt = now();
    return projectRecord(record);
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
        record.revision += 1;
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
    // 提交门闩：最后一次 await 之后再全量重读快照（捕获 await 期间的账号变更/用途撤回）。
    await assertCommitFence(record);
    if (record.state !== 'reserved' && record.state !== 'sent') {
      throw new PrivacyError('OBJECT_UNAVAILABLE', `外发已终止（${record.state}），禁止回写`);
    }
    return projectRecord(record);
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
