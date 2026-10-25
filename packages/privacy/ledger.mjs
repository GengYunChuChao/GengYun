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
 *   - 取消/撤回后**实际结果写入**不可发生：`guardWriteback` 的保存动作在原子提交临界区内执行
 *     （见下），不是「先拿授权结论、稍后再保存」。
 *   - **派发 at-least-once**：`markSent` 把 reserved→sent 放进同一临界区提交；真正的第三方网络
 *     派发发生在临界区之外，**不因事后回滚撤销**（外部调用无法与本地事务绑定）。
 *
 * 快照语义：
 *   - reserve 保存「全部必需用途的 epoch」+「外发时固定的账号 auth_epoch」+「接收方 config_version」；
 *   - 派发（markSent）与回写（guardWriteback）始终以这些快照为准，不接收调用方覆盖的新上下文。
 *
 * 并发安全（修复轮 2/3/4/5）：
 *   - 每条记录带单调递增 revision；终态（failed/outcome_unknown）不可复活。
 *   - 派发与回写的**唯一提交边界**是 `commitGate.commit(expected, { precondition, apply })`
 *     （见 commit-gate.mjs）：`commit` 体内**不含任何 await**，在同一个不可分割的同步临界区内
 *     一次性重读「账号身份/auth_epoch + 全部必需用途 epoch/授予 + 接收方 enabled/版本/训练条款」，
 *     逐项与 reserve 快照比对，全部通过才执行 `apply`。
 *   - `guardWriteback` 的结果写入由**受控数据介质**在 `apply` 内完成：结果以**数据**传入，
 *     写入由**账本自身的同步代码**（`Map.prototype.set.call`）执行——**校验不通过 ⇒ 不写入 ⇒ 保存
 *     根本不会发生/生效**。**写入口不是任意函数**（修复轮 7 结论）：不注入 `write` 回调，也不以
 *     `constructor.name` 判断同步性——调用方只能提供纯数据容器，故不存在「被调用时启动异步任务」的可能。
 *   - 因此提交判定**不再**依赖「顺序异步重读」：不存在「读 A 与读 B 之间被插入」或「适配器先取
 *     旧值再异步返回」的窗口——校验与提交在同一 tick 内原子完成。调用方即使**不经** revokeInFlight，
 *     只要在提交临界区之前注销/停用账号、前进 auth_epoch 或撤回用途，都会被这道同步重读捕获。
 *   - markSent / guardWriteback 之前仍保留一段**非权威异步预检**（早退 + 细化错误码）：它读到的是
 *     某一时刻的快照，可能过期，**不构成安全保证**；权威判定一律由 `commit` 给出。
 */
import { randomUUID } from 'node:crypto';
import { CONSENT_PURPOSES, MEDIA_PURPOSES, requiredConsentsForDataType } from './constants.mjs';
import { PrivacyError } from './errors.mjs';
import { createPrivacyGuard } from './guard.mjs';
import { createCommitGate, COMMIT_REASON_ERROR_CODES } from './commit-gate.mjs';
import {
  createMemoryWritebackMedium,
  assertWritebackMedium,
  writebackMediumWrite,
  writebackMediumHas,
  writebackMediumRead,
} from './writeback.mjs';

/**
 * 非媒体资料的对象键（`object_key`）形状：与 `ledger-pg.ts` 的 `OBJECT_KEY`、迁移 0040 收的
 * 库层 CHECK、契约 `TargetRef.id` 的 `maxLength` **同一个数**（1..80 字符；小写字母/数字/`_-.:`，
 * 首尾为字母或数字 ⇒ 拒空串、拒超长、拒空白与注入字符）。三处任一漂移都会让写入侧与读面打架。
 */
const OBJECT_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_.:-]{0,78}[a-z0-9])?$/;

/**
 * @param {{
 *   consentStore: object,
 *   account: object,
 *   recipientStore: { get: (id: string) => Promise<object|null>, currentOf?: (id: string) => object|null },
 *   commitGate?: { commit: (expected: object, hooks: object) => Promise<{committed: boolean, reason?: string}> },
 *   writeback?: { rows: Map<string, object> },
 *   now?: () => Date,
 * }} deps
 */
export function createExportLedger({
  consentStore,
  account,
  recipientStore,
  commitGate,
  writeback,
  now = () => new Date(),
} = {}) {
  // 强制要求「身份版本」能力：缺少 authEpochOf 的适配器会绕过账号版本核对，
  // 使旧任务在账号已注销/停用（auth_epoch 前进）后仍被放行。此处直接拒绝构造。
  if (!account || typeof account.stateOf !== 'function' || typeof account.authEpochOf !== 'function') {
    throw new Error('createExportLedger 需要注入带 stateOf 与 authEpochOf 的 account 提供者');
  }
  const guard = createPrivacyGuard({ account, consentStore, now });

  // 强制要求「提交一致性契约」能力：派发/回写的原子边界由 commitGate 提供。
  // 未显式注入时用内存参考实现包裹同步适配器；若适配器缺少同步一致快照方法，
  // createCommitGate 会**构造即抛错**——绝不允许「漏实现即静默放行」。
  const gate =
    commitGate ?? createCommitGate({ account, consentStore, recipientStore });
  if (!gate || typeof gate.commit !== 'function') {
    throw new Error(
      'createExportLedger 需要实现「提交一致性契约」(commit) 的 commitGate，' +
        '或提供带同步快照方法 identityOf/snapshotOf/currentOf 的 account/consentStore/recipientStore',
    );
  }

  // 强制要求「受控数据介质」：结果写入必须是**账本自身的同步代码**作用于**纯数据容器**，
  // **写入口不是任意函数**（修复轮 7 结论）。未注入时用内存参考介质（native Map）。
  // 修复轮 8：校验**不执行访问器**（只读 own data descriptor），并**一次性捕获**已验证的 Map 引用
  // 到**冻结绑定** `{ rows }`；写/读只使用该绑定，**不再回读调用方的 medium.rows**（杜绝 armed getter
  // 在校验与写入之间插入调用方代码）。注入物含函数/访问器、rows 非 own data descriptor 或非原生 Map、
  // 或为 Proxy → **构造即抛错**。
  const writebackBinding = assertWritebackMedium(writeback ?? createMemoryWritebackMedium());

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

  function isInFlight(record) {
    return record.state === 'reserved' || record.state === 'sent';
  }

  function assertInFlight(record) {
    if (!isInFlight(record)) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', `外发已终态（${record.state}），不可变更`);
    }
  }

  /** 提交被拒时按失败原因映射为契约错误码（未知原因兜底 OBJECT_UNAVAILABLE）。 */
  function commitError(reason, action) {
    const code = COMMIT_REASON_ERROR_CODES[reason] ?? 'OBJECT_UNAVAILABLE';
    return new PrivacyError(code, `${action}被拒（${reason ?? 'unknown'}）`);
  }

  /**
   * 从外发记录派生提交期望快照：账号版本 / 全部必需用途 epoch / 接收方版本与训练条款要求。
   * 只读记录内已冻结的字段，不接收调用方覆盖。
   */
  function commitExpectedOf(record) {
    return {
      userId: record.userId,
      authEpoch: record.authEpoch,
      requiredConsents: record.requiredConsents,
      recipientId: record.recipientId,
      recipientConfigVersion: record.recipientConfigVersion,
      requireRecipientIntegrity: record.purpose === 'external_inference',
    };
  }

  // ---------------------------------------------------------------------------
  // 「预检」：best-effort 早退 + 细化错误码。**不构成任何安全保证**——它们与旧版「提交门闩」
  // 的关键区别在于：预检读到的是**某一时刻的异步快照**，可能已过期（如适配器先取旧值再异步返回）；
  // 因此预检通过**不代表**可以提交。真正决定「是否派发/回写」的唯一边界是下方 `gate.commit`
  // 的**同步原子临界区**（见 commit-gate.mjs）。预检仅为尽早失败与错误码细化而保留。
  // ---------------------------------------------------------------------------

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

  /** 预检账号快照（异步，非权威）。 */
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

  /** 预检全部必需用途的 epoch 与授予状态（异步，非权威）。 */
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

  /** 预检接收方资格与绑定版本（异步，非权威）。 */
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
   * 这里读取并冻结提交期望快照；**真正的原子提交边界在 markSent / guardWriteback**。
   * @returns {Promise<object>} export 记录（state=reserved）
   */
  async function reserve({
    userId,
    authEpoch,
    objectType,
    objectId,
    objectKey = null,
    objectRevision,
    dataType,
    purpose,
    recipientId,
    sourceVersion = null,
  }) {
    if (!objectType || typeof objectType !== 'string') {
      throw new PrivacyError('INVALID_REQUEST', 'object_type 缺失');
    }
    // 资料类型判定 = **媒体维 ∪ 非媒体维**（GY-I27 第三片）。此判定**无条件**执行：
    // 未知/缺失/两维都不认识的类型一律逐字拒 `SCOPE_DENIED 未知资料类型：<v>`（既有口径逐字不变，
    // 不给「省略 data_type 就跳过判定」的旁路）。
    if (requiredConsentsForDataType(dataType) === null) {
      throw new PrivacyError('SCOPE_DENIED', `未知资料类型：${dataType}`);
    }
    // 对象标识：**媒体资料**用 uuid（`objectId`，既有口径不变）；**非媒体资料**用文本型键
    // （`objectKey`，1..128 字符、字符集受限）—— 已核对正文的 id 是任意字符串
    // （如 `sample-i13-passed`），不是 uuid。二者恰好给一个，**不得都缺、不得都给**。
    const expectsTextKey = !MEDIA_PURPOSES.includes(dataType);
    const key = expectsTextKey ? objectKey : objectId;
    if (expectsTextKey) {
      if (typeof objectKey !== 'string' || !OBJECT_KEY_PATTERN.test(objectKey)) {
        throw new PrivacyError('INVALID_REQUEST', 'object_key 缺失或非法');
      }
      if (objectId !== undefined && objectId !== null) {
        throw new PrivacyError('INVALID_REQUEST', '非媒体资料的 object_id 必须为空（用 object_key）');
      }
    } else if (!objectId) {
      throw new PrivacyError('INVALID_REQUEST', 'object_id 缺失');
    }
    if (!Number.isInteger(objectRevision) || objectRevision < 1) {
      throw new PrivacyError('INVALID_REQUEST', 'object_revision 非法');
    }
    // 身份版本必须存在（缺身份版本不放行）。
    if (!Number.isInteger(authEpoch) || authEpoch < 1) {
      throw new PrivacyError('SESSION_REQUIRED', '缺少身份版本（auth_epoch）');
    }
    assertValidPurpose(purpose);

    // 错用途：purpose 必须属于 data_type 的必需集合（**媒体维 ∪ 非媒体维**，各自核验）。
    const requiredForDataType = requiredConsentsForDataType(dataType);
    if (!requiredForDataType.includes(purpose)) {
      throw new PrivacyError(
        'SCOPE_DENIED',
        `用途 ${purpose} 与资料类型 ${dataType} 不匹配（错用途）`,
      );
    }

    // 账号活跃 + 身份版本一致（reserve 时刻校验会话提供的 authEpoch）。
    await guard.assertAccountActive(userId, { authEpoch });

    // 保存全部必需用途的 epoch 快照（缺授权 → CONSENT_REQUIRED）。
    const requiredConsents = {};
    for (const p of requiredForDataType) {
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
    for (const p of requiredForDataType) {
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
      objectId: key,
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

  // ---------------------------------------------------------------------------
  // 读面（追溯）：按用户列出外发账本，keyset 游标（createdAt desc, id desc）。
  // 只读、不动任何状态；契约形状（Export / ExportPage）由 egress.mjs 投影。
  // 游标不签名：它只含「上一页最后一条的时间与 id」，不承载任何授权语义
  // （HTTP 接线方仍须按本仓既有分页口径做核对与限幅）。
  // ---------------------------------------------------------------------------
  function encodeCursor(record) {
    return Buffer.from(
      JSON.stringify({ t: new Date(record.createdAt).toISOString(), id: record.id }),
      'utf8',
    ).toString('base64url');
  }

  function decodeCursor(cursor) {
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 2048) {
      throw new PrivacyError('INVALID_CURSOR', '游标非法');
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw new PrivacyError('INVALID_CURSOR', '游标不可解析');
    }
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.t !== 'string') {
      throw new PrivacyError('INVALID_CURSOR', '游标非法');
    }
    const at = new Date(parsed.t);
    if (!Number.isFinite(at.getTime())) throw new PrivacyError('INVALID_CURSOR', '游标非法');
    return { at, id: parsed.id };
  }

  /**
   * 列出某用户的外发账本（追溯用）。
   * @param {{ userId: string, limit?: number, cursor?: string|null }} input
   * @returns {{ items: Array<object>, nextCursor: string|null }}
   */
  function list({ userId, limit = 50, cursor = null } = {}) {
    if (!userId) throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new PrivacyError('INVALID_REQUEST', 'limit 必须是 1..50 的整数');
    }
    const after = cursor === null || cursor === undefined ? null : decodeCursor(cursor);
    const ordered = [...rows.values()]
      .filter((record) => record.userId === userId)
      .sort((a, b) => {
        const at = new Date(a.createdAt).getTime();
        const bt = new Date(b.createdAt).getTime();
        if (at !== bt) return bt - at;
        if (a.id === b.id) return 0;
        return a.id < b.id ? 1 : -1;
      })
      .filter((record) => {
        if (after === null) return true;
        const at = new Date(record.createdAt).getTime();
        const aat = after.at.getTime();
        if (at !== aat) return at < aat;
        return record.id < after.id;
      });
    const page = ordered.slice(0, limit);
    const nextCursor = ordered.length > limit ? encodeCursor(page[page.length - 1]) : null;
    return { items: page.map(projectRecord), nextCursor };
  }

  /**
   * 实际派发：先做**非权威**异步预检（早退 + 细化错误码），再以 reserve 快照为期望，
   * 通过 `commitGate.commit` 在**单次同步临界区**内原子完成「账号 / 全部必需用途 / 接收方」
   * 重读校验 + 在途/revision 前置检查 + 置 sent。
   *
   * 安全性来自 `commit`（校验+apply 无 await），**不来自**预检：即使预检读到过期的旧快照
   * 而放行，原子提交仍会用同一 tick 的同步一致快照重新判定，过期即拒绝。
   * @returns {Promise<object>} 通过原子提交的 export 记录（state=sent）
   */
  async function markSent(id) {
    const record = rows.get(id);
    if (!record) throw new PrivacyError('NOT_FOUND', '外发记录不存在');
    // 记录当前 revision：precondition 在同一临界区内核对，确保 await 期间不被迁移。
    const startRevision = record.revision;
    // 非权威预检（best-effort）：只影响错误码与失败时机，不决定能否提交。
    await assertAccountIntact(record);
    await assertAllConsentsIntact(record);
    await assertRecipientIntact(record);
    // 唯一提交边界：同步原子 CAS 提交。
    const result = await gate.commit(commitExpectedOf(record), {
      precondition: () => isInFlight(record) && record.revision === startRevision,
      apply: () => {
        record.state = 'sent';
        record.sentAt = now();
        record.revision += 1;
        record.updatedAt = now();
      },
    });
    if (!result || result.committed !== true) {
      throw commitError(result?.reason, '派发');
    }
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
   * 在途结果回写守卫：**校验与实际结果写入同处一个原子提交临界区**。
   *
   * 结果以**数据** `result` 传入，由**受控数据介质**（构造时注入并校验，见 writeback.mjs）在
   * `gate.commit` 的 `apply`（同步临界区）内、以**账本自身的同步代码**（`Map.prototype.set.call`）
   * 写入。**写入口不是任意函数**（修复轮 7 结论）——不注入 `write` 回调、也不以 `constructor.name`
   * 判断同步性；调用方只能提供**纯数据容器**，故**不可能**在写路径内启动异步任务。
   * **修复轮 8**：校验**不执行访问器**（只读 own data descriptor），并**一次性捕获**已验证的 Map 引用；
   * 写/读**只使用该冻结绑定**，**不读取调用方可变属性、不执行访问器**——故不存在「armed getter 在校验
   * 与写入之间插入调用方代码」的窗口。结构性保证：
   * **校验不通过 ⇒ 根本不写入 ⇒ 保存不会发生/生效**（不返回 `written:true`），而非「启动了再报错」。
   *
   * 先做**非权威**异步预检（早退 + 细化错误码），再以 reserve 快照（账号版本 / 全部必需用途 epoch /
   * 接收方版本与条款）为期望原子提交；满足以下任一即阻断（**不写入介质**、不落库、不可复活）：
   *   - 账号非活跃 / auth_epoch 已变更（注销/停用/会话失效）
   *   - 任一必需用途 epoch 已前进（撤回或重新授权）
   *   - 接收方停用 / 版本变化 / 训练或删除条款失效
   *   - 外发记录已终态（取消/失败/结果未知）
   * @param {{ exportId: string, userId: string, result?: unknown }} input
   * @returns {Promise<{ written: true, exportId: string } | { written: false, replay: true, exportId: string }>}
   *   仅回执「本次是否真的写入新行」——`written:false` 表示该外发已有回写（重放不覆盖第一次的载荷），
   *   不返回可后置消费的授权结论
   */
  async function guardWriteback({ exportId, userId, result } = {}) {
    const record = rows.get(exportId);
    if (!record || record.userId !== userId) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '外发记录不存在或归属不符');
    }
    await assertAccountIntact(record);
    await assertAllConsentsIntact(record);
    await assertRecipientIntact(record);
    let wrote = false;
    const commitResult = await gate.commit(commitExpectedOf(record), {
      precondition: () => isInFlight(record),
      // 实际结果写入即提交副作用：在同步临界区内以账本自身的同步代码写入纯数据介质，
      // 保存与校验不可分离；写路径内**无任何调用方代码**。
      // 幂等：已有回写时**不覆盖**（第一个结果即最终结果），也不声称本次写入了新行。
      apply: () => {
        if (writebackMediumHas(writebackBinding, record.id)) return;
        writebackMediumWrite(
          writebackBinding,
          Object.freeze({
            exportId: record.id,
            userId: record.userId,
            revision: record.revision,
            result,
            committedAt: now(),
          }),
        );
        wrote = true;
      },
    });
    if (!commitResult || commitResult.committed !== true) {
      throw commitError(commitResult?.reason, '回写');
    }
    if (!wrote) return { written: false, replay: true, exportId: record.id };
    return { written: true, exportId: record.id };
  }

  /** 读取已写入的回写条目（供测试/审计）：账本自身同步读取**已捕获的绑定引用**。 */
  function getWriteback(exportId) {
    return writebackMediumRead(writebackBinding, exportId);
  }

  return {
    reserve,
    get,
    list,
    markSent,
    markFailed,
    markOutcomeUnknown,
    revokeInFlight,
    guardWriteback,
    getWriteback,
    _rows: rows,
  };
}
