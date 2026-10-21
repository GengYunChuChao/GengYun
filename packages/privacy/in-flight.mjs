/**
 * GY-I27 隐私模块 · 在途守卫（in-flight guard）与撤回/注销消费者接口。
 *
 * ## 本模块补的正是上一片未齐的「在途守卫」
 * `ledger.mjs` 已把**回写**的实际结果写入放进原子提交临界区（`guardWriteback`）。但任务级还有
 * 三个需要显式守卫的时刻（issue #29 范围第 4 条）：
 *   1. **服务端任务执行前**重查授权／账号状态（`assertExecutable`）——撤回/注销后不得再起新工作；
 *   2. **保存前**重查（`assertSavable`）——在途结果回写被阻断；
 *   3. **取消版本不可被回调复活**（`cancelVersion` 墓碑 + 版本比对）——旧版本回调即使晚到、
 *      即使之后重新授权，也不得写入。
 *
 * ## 身份上下文可注入，不与 GY-I04 形成依赖循环
 * `account` / `consentStore` 由调用方注入（单测用 `tests/privacy/_fixtures.mjs` 的合成账号）；
 * 本模块不 import 任何 `services/api/**`，也不需要微信登录。
 *
 * ## 撤回／注销消费者接口（`createEgressRevoker`）
 * `services/api/src/privacy/consent-pg.ts` 与 `grant-pg.ts` 目前在用户已有
 * jobs/media/exports/author_links 依赖时直接 `OBJECT_UNAVAILABLE`（"撤回消费者尚未接入"），
 * 这是**正确的 fail-closed 兜底**，但缺口是"消费者"本身。`createEgressRevoker` 提供该消费者
 * 的最小接口：撤回/注销时**撤销在途外发**（reserved/sent → failed），使接线方能注入它、
 * 从而撤掉那条兜底而**不是**伪造取消成功。**默认不注入 ⇒ 行为与今天逐字一致**。
 */
import { PrivacyError } from './errors.mjs';
import { redactForLog } from './redact.mjs';

/** 记录终态（不可再变更、不可复活）。与 ledger.mjs 的 `isInFlight` 互补。 */
const TERMINAL_STATES = Object.freeze(['failed', 'outcome_unknown']);

/**
 * 取消原因只允许**短安全 token**（`[a-z0-9_:-]{1,40}`）。
 * 调用方可能把私有正文/坐标当"原因"传进来，而日志里 `reason` 不是敏感键名、不会被键名脱敏命中，
 * 因此这里**不放行自由文本**：不合规一律回落为 `cancelled`（宁可丢原因，不落私有正文）。
 */
const SAFE_REASON = /^[a-z0-9_:-]{1,40}$/;

function sanitizeReason(reason) {
  return typeof reason === 'string' && SAFE_REASON.test(reason) ? reason : 'cancelled';
}

/**
 * 创建在途守卫。
 *
 * @param {{
 *   ledger: object,
 *   account: { stateOf(userId: string): Promise<string>, authEpochOf(userId: string): Promise<number> },
 *   consentStore: { isGranted(i: object): Promise<boolean>, currentEpoch(i: object): Promise<number> },
 *   now?: () => Date,
 * }} deps
 */
export function createInFlightGuard({ ledger, account, consentStore, now = () => new Date() } = {}) {
  for (const method of ['get', 'guardWriteback', 'markFailed', 'revokeInFlight']) {
    if (!ledger || typeof ledger[method] !== 'function') {
      throw new Error(`createInFlightGuard 需要账本提供 ${method}()`);
    }
  }
  if (!account || typeof account.stateOf !== 'function' || typeof account.authEpochOf !== 'function') {
    throw new Error('createInFlightGuard 需要注入带 stateOf 与 authEpochOf 的 account 提供者');
  }
  if (!consentStore || typeof consentStore.isGranted !== 'function' || typeof consentStore.currentEpoch !== 'function') {
    throw new Error('createInFlightGuard 需要注入 consentStore（isGranted + currentEpoch）');
  }

  /**
   * 已取消版本墓碑：`exportId\0objectVersion`。
   * 键**同时**含外发记录与对象版本：取消的是"那一次任务的那一个版本"，不是整个用户。
   * 墓碑只增不减（无复活接口），因此"已取消版本不得被回调复活"是结构性事实。
   * @type {Map<string, { exportId: string, objectVersion: number, reason: string, at: string }>}
   */
  const cancelledVersions = new Map();
  /** @type {Array<object>} 只读审计（已脱敏） */
  const auditEntries = [];

  function versionKey(exportId, objectVersion) {
    return `${exportId}\u0000${objectVersion}`;
  }

  function recordAudit(entry) {
    const safe = Object.freeze(
      redactForLog({
        at: now().toISOString(),
        action: entry.action,
        exportId: entry.exportId ?? null,
        userId: entry.userId ?? null,
        objectVersion: entry.objectVersion ?? null,
        reason: entry.reason ?? null,
        revokedInFlight: entry.revokedInFlight ?? null,
      }),
    );
    auditEntries.push(safe);
    return safe;
  }

  /**
   * 读取并核对归属。
   *
   * **持久账本适配（GY-I27 第二片）**：内存账本的 `get` 是同步的，PostgreSQL 账本的 `get`
   * 必然返回 Promise，因此这里统一 `await` —— 对同步实现是**零成本且行为不变**（await 非 Promise
   * 值直接返回该值），对持久实现则正确等待。否则守卫会拿到 Promise 并把归属判成不符（fail-closed
   * 方向正确但功能不可用）。
   */
  async function requireRecord({ exportId, userId }) {
    if (typeof exportId !== 'string' || exportId.length === 0) {
      throw new PrivacyError('INVALID_REQUEST', 'exportId 缺失');
    }
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
    }
    const record = await ledger.get(exportId);
    if (!record || record.userId !== userId) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '外发记录不存在或归属不符');
    }
    return record;
  }

  /** 重查账号状态与**外发时冻结的** auth_epoch（注销/停用会前进 auth_epoch ⇒ 旧任务失效）。 */
  async function assertAccountIntact(record) {
    const state = await account.stateOf(record.userId);
    if (state !== 'active') {
      throw new PrivacyError('ACCOUNT_INACTIVE', `账号状态为 ${state}，禁止继续`);
    }
    const current = await account.authEpochOf(record.userId);
    if (!Number.isInteger(current) || current < 1 || current !== record.authEpoch) {
      throw new PrivacyError('ACCOUNT_INACTIVE', '账号状态已变更，请重新登录');
    }
  }

  /** 重查**全部必需用途**的 epoch 与授予状态（撤回或重新授权即 epoch 前进 ⇒ 旧任务失效）。 */
  async function assertAllConsentsIntact(record) {
    for (const [purpose, epoch] of Object.entries(record.requiredConsents ?? {})) {
      const granted = await consentStore.isGranted({ userId: record.userId, purpose });
      if (!granted) {
        throw new PrivacyError('CONSENT_REQUIRED', `用途 ${purpose} 授权已撤回，禁止继续`);
      }
      const current = await consentStore.currentEpoch({ userId: record.userId, purpose });
      if (current !== epoch) {
        throw new PrivacyError('OBJECT_UNAVAILABLE', `用途 ${purpose} 授权版本已变化，禁止继续`);
      }
    }
  }

  function assertVersionNotCancelled(record, objectVersion) {
    if (cancelledVersions.has(versionKey(record.id, objectVersion))) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '该对象版本已取消，回调不得复活');
    }
  }

  /** 任务**执行前**重查：记录在途、版本未被取消、账号活跃、全部必需用途仍有效。 */
  async function assertExecutable({ exportId, userId }) {
    const record = await requireRecord({ exportId, userId });
    if (TERMINAL_STATES.includes(record.state)) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', `外发已终态（${record.state}），禁止继续执行`);
    }
    assertVersionNotCancelled(record, record.objectRevision);
    await assertAccountIntact(record);
    await assertAllConsentsIntact(record);
    return { exportId: record.id, purposes: Object.keys(record.requiredConsents ?? {}) };
  }

  /**
   * **保存前**重查：在执行前检查之外，还要求回调携带的 `objectVersion` 与外发预留时冻结的
   * `objectRevision` **完全一致**（旧版本回调不得写到新版本上），且该版本未被取消。
   */
  async function assertSavable({ exportId, userId, objectVersion }) {
    if (!Number.isInteger(objectVersion) || objectVersion < 1) {
      throw new PrivacyError('INVALID_REQUEST', 'object_version 非法');
    }
    const record = await requireRecord({ exportId, userId });
    if (TERMINAL_STATES.includes(record.state)) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', `外发已终态（${record.state}），回写被阻断`);
    }
    assertVersionNotCancelled(record, objectVersion);
    if (objectVersion !== record.objectRevision) {
      throw new PrivacyError(
        'OBJECT_UNAVAILABLE',
        `回调版本（${objectVersion}）与预留版本（${record.objectRevision}）不一致，回写被阻断`,
      );
    }
    await assertAccountIntact(record);
    await assertAllConsentsIntact(record);
    return { exportId: record.id, objectVersion };
  }

  /**
   * 取消一个版本：登记**不可复活**的墓碑，并把在途外发置 `failed`。
   * 取消是幂等的；已终态记录仍登记墓碑（晚到回调同样被阻断）。
   *
   * **持久账本适配（GY-I27 第二片）**：返回 Promise，并 `await` 账本的 `markFailed`
   * （PostgreSQL 实现必须在**单事务**内完成状态迁移；同步实现的 await 是零成本）。
   * @returns {Promise<{exportId:string, objectVersion:number, cancelled:boolean, alreadyCancelled:boolean, revokedInFlight:number}>}
   */
  async function cancelVersion({ exportId, userId, objectVersion, reason = 'cancelled' } = {}) {
    if (!Number.isInteger(objectVersion) || objectVersion < 1) {
      throw new PrivacyError('INVALID_REQUEST', 'object_version 非法');
    }
    const record = await requireRecord({ exportId, userId });
    const key = versionKey(record.id, objectVersion);
    const already = cancelledVersions.has(key);
    const safeReason = sanitizeReason(reason);
    if (!already) {
      cancelledVersions.set(key, {
        exportId: record.id,
        objectVersion,
        reason: safeReason,
        at: now().toISOString(),
      });
    }
    let revoked = 0;
    if (!TERMINAL_STATES.includes(record.state)) {
      try {
        await ledger.markFailed(exportId, { errorCode: 'OBJECT_CANCELLED' });
        revoked = 1;
      } catch {
        // 记录已在派发/回写路径上进入终态：保留既有结论。
      }
    }
    recordAudit({ action: 'cancel_version', exportId, userId, objectVersion, reason: safeReason, revokedInFlight: revoked });
    return Object.freeze({ exportId: record.id, objectVersion, cancelled: true, alreadyCancelled: already, revokedInFlight: revoked });
  }

  function isVersionCancelled({ exportId, objectVersion } = {}) {
    return cancelledVersions.has(versionKey(exportId, objectVersion));
  }

  /**
   * 保存结果（回写）。
   *
   * 预检（`assertSavable`）只用于**尽早失败与细化错误码**：它是异步的、可能过期，
   * **不构成安全保证**。权威判定仍是账本 `guardWriteback` 的同步原子临界区——
   * 校验不通过 ⇒ **根本不写入**（零写入），而不是"写了再报错"。
   */
  async function saveResult({ exportId, userId, objectVersion, result } = {}) {
    await assertSavable({ exportId, userId, objectVersion });
    const written = await ledger.guardWriteback({ exportId, userId, result });
    recordAudit({ action: 'save_result', exportId, userId, objectVersion, reason: null });
    // `replay` 仅在为真时出现：保持既有 `{written,exportId,objectVersion}` 返回形状不变。
    return Object.freeze({
      written: written.written === true,
      exportId,
      objectVersion,
      ...(written.replay === true ? { replay: true } : {}),
    });
  }

  return Object.freeze({
    assertExecutable,
    assertSavable,
    cancelVersion,
    isVersionCancelled,
    saveResult,
    /** 某条外发记录上被取消的版本号（追溯用）。 */
    cancelledVersionsOf: (exportId) =>
      [...cancelledVersions.values()]
        .filter((info) => info.exportId === exportId)
        .map((info) => info.objectVersion)
        .sort((a, b) => a - b),
    cancelledVersionCount: () => cancelledVersions.size,
    audit: () => auditEntries.map((entry) => ({ ...entry })),
  });
}

/**
 * 撤回／注销消费者接口：撤回用途或注销账号时**撤销在途外发**。
 *
 * 这是 `consent-pg.ts` / `grant-pg.ts` 里"消费者尚未接入"那条兜底所缺的对象。
 * 接口刻意只做**一件事**（撤销在途外发）且**不返回可后置消费的授权结论**：
 * 撤销本身由账本 `revokeInFlight` 完成，之后任何 `markSent` / `guardWriteback`
 * 都会在原子边界上被拒。
 *
 * **持久账本适配（GY-I27 第二片）**：两个方法返回 Promise 并 `await` 账本的 `revokeInFlight`
 * （PostgreSQL 实现是一条原子 UPDATE；同步实现的 await 是零成本）。调用方（授权服务）
 * 必须 `await` —— 否则撤销失败会变成未处理的 rejection。
 *
 * 接线方（`services/api`）注入本对象后即可删掉 `OBJECT_UNAVAILABLE` 兜底；
 * **不注入时行为与今天逐字一致**（仍然 fail-closed，不伪造取消成功）。
 *
 * @param {{ ledger: object, now?: () => Date }} deps
 */
export function createEgressRevoker({ ledger, now = () => new Date() } = {}) {
  if (!ledger || typeof ledger.revokeInFlight !== 'function') {
    throw new Error('createEgressRevoker 需要账本提供 revokeInFlight()');
  }
  const revoked = [];

  function note(scope, userId, purpose, count) {
    revoked.push(
      Object.freeze(
        redactForLog({ at: now().toISOString(), scope, userId, purpose: purpose ?? null, revokedInFlight: count }),
      ),
    );
    return count;
  }

  return Object.freeze({
    /** 用途撤回：撤销**依赖该用途**的在途外发。 */
    async onConsentWithdrawn({ userId, purpose } = {}) {
      if (typeof userId !== 'string' || userId.length === 0) {
        throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
      }
      const count = await ledger.revokeInFlight({ userId, purpose });
      note('consent_withdrawn', userId, purpose, count);
      return Object.freeze({ revokedInFlight: count });
    },
    /** 注销/停用：撤销该用户**全部**在途外发（新外发由账号状态守卫阻断）。 */
    async onAccountSuspendedOrDeleted({ userId } = {}) {
      if (typeof userId !== 'string' || userId.length === 0) {
        throw new PrivacyError('SESSION_REQUIRED', '缺少身份上下文');
      }
      const count = await ledger.revokeInFlight({ userId });
      note('account_inactive', userId, null, count);
      return Object.freeze({ revokedInFlight: count });
    },
    audit: () => revoked.map((entry) => ({ ...entry })),
  });
}
