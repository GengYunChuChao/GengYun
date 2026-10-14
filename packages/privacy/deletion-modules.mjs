/**
 * GY-I27 隐私模块 · **全模块**注销/删除注册协议与契约形状回执。
 *
 * ## 本模块补的洞：只有"部分模块"报告也能算完成
 * `deletion.mjs` 已实现「模块注册 + 每个 handler 证据齐全 + 第三方 confirmed」的判定，但它的
 * `completionStatus` 只看**已登记的行**（`hasWork = rows.length > 0 || thirdParties.length > 0`）。
 * 于是只要**任意一个**模块报告 completed（带证据），整单就被判 `completed` ——
 * 一个 8 个模块的账号注销，只有 1 个模块注册并完成也会"完成"。这正是监工所指的
 * **「全模块注销/删除恢复必要证据未齐」**。
 *
 * 本模块把"全模块"变成**显式闭集**：
 *   1. `declareRequiredModules` 在**创建任何删除请求之前**声明必需模块闭集（之后不可再改，
 *      杜绝"按已有结果倒推清单"）；
 *   2. `registerModule` 只接受闭集内的模块名（未声明的模块注册即拒）；
 *   3. `completionStatus` 在**任一必需模块尚未报告**时一律不判完成，并在结果里给出缺失清单；
 *   4. `receipt` 按契约 `DeletionReceipt` / `DeletionHandler`（openapi.json）形状输出，
 *      未报告的模块以 `pending/pending` 呈现 —— 缺口对用户与监工可见，而不是"看不见即完成"。
 *
 * ## 边界（不实现）
 * 完整 7／30 日删除（对象存储、备份、供应商副本、恢复清单重放）仍属 **GY-I19**；
 * 本模块只交付协议与接口，不注册任何 HTTP 路由，不做任何实际删除。
 */
import { DELETION_STATES, HANDLER_STATES, THIRD_PARTY_STATES } from './constants.mjs';
import { PrivacyError } from './errors.mjs';

/** 契约 `DeletionReceipt.handlers` 的 maxItems（= 必需模块闭集上限）。 */
export const DELETION_MODULE_LIMIT = 50;

function assertModuleList(modules) {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new PrivacyError('INVALID_REQUEST', '必需模块闭集不得为空（空集无法证明"全模块"）');
  }
  if (modules.length > DELETION_MODULE_LIMIT) {
    throw new PrivacyError('INVALID_REQUEST', `必需模块闭集不得超过 ${DELETION_MODULE_LIMIT} 项`);
  }
  const seen = new Set();
  for (const module of modules) {
    if (typeof module !== 'string' || module.length === 0 || module.length > 80) {
      throw new PrivacyError('INVALID_REQUEST', '模块名必须是 1..80 字符的字符串');
    }
    if (seen.has(module)) {
      throw new PrivacyError('INVALID_REQUEST', `必需模块闭集含重复项：${module}`);
    }
    seen.add(module);
  }
  return Object.freeze([...modules]);
}

function iso(value) {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

/**
 * 创建删除协调器（在 `createDeletionRegistry` 之上补"全模块"语义）。
 *
 * @param {{
 *   registry: object,
 *   requiredModules: string[],
 *   now?: () => Date,
 * }} deps
 */
export function createDeletionCoordinator({ registry, requiredModules, now = () => new Date() } = {}) {
  for (const method of [
    'registerModule',
    'createDeletionRequest',
    'getRequest',
    'executeHandlers',
    'completionStatus',
    'requestThirdPartyDeletion',
    'confirmThirdPartyDeletion',
    'failThirdPartyDeletion',
    'markUnsupported',
  ]) {
    if (!registry || typeof registry[method] !== 'function') {
      throw new Error(`createDeletionCoordinator 需要删除注册表提供 ${method}()`);
    }
  }
  if (!registry._handlerRows || !registry._thirdPartyRows || !registry._requests) {
    throw new Error('createDeletionCoordinator 需要注册表暴露 handler/第三方/请求表（_handlerRows/_thirdPartyRows/_requests）');
  }

  let declared = assertModuleList(requiredModules);
  /** 每个请求创建时冻结的模块闭集快照（请求之间互不影响）。 @type {Map<string, string[]>} */
  const requestModules = new Map();

  function declaredOf(requestId) {
    return requestModules.get(requestId) ?? [...declared];
  }

  function handlerRows(requestId) {
    return registry._handlerRows.filter((row) => row.requestId === requestId);
  }

  function thirdPartyRows(requestId) {
    return registry._thirdPartyRows.filter((row) => row.requestId === requestId);
  }

  /** 重新声明模块闭集：**只允许在创建任何删除请求之前**（防止按结果倒推清单）。 */
  function declareRequiredModules(modules) {
    if (registry._requests.size > 0) {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '已有删除请求，必需模块闭集不可再变（不得按已有结果倒推清单）');
    }
    declared = assertModuleList(modules);
    return [...declared];
  }

  function modules() {
    return [...declared];
  }

  /** 模块注册：**只接受闭集内**的模块（未声明 ⇒ 拒绝，避免"注册了就算齐"）。 */
  function registerModule(module, handler) {
    if (!declared.includes(module)) {
      throw new PrivacyError('INVALID_REQUEST', `模块 ${module} 不在必需模块闭集内，不可注册`);
    }
    return registry.registerModule(module, handler);
  }

  function registeredModules() {
    return [...registry._handlers.keys()];
  }

  /** 尚未注册删除处理器的必需模块（= "全模块证据未齐"的具体缺口）。 */
  function missingRegistrations() {
    const registered = new Set(registeredModules());
    return declared.filter((module) => !registered.has(module));
  }

  /** 某请求下尚未**报告**（没有任何 handler 行）的必需模块。 */
  function missingModules(requestId) {
    const reported = new Set(handlerRows(requestId).map((row) => row.module));
    return declaredOf(requestId).filter((module) => !reported.has(module));
  }

  function createDeletionRequest({ generation = 1, receiptInput = null } = {}) {
    const missing = missingRegistrations();
    if (missing.length > 0) {
      // 受理即受理，**但**缺模块受理会让"全模块完成"永远不可达而不自知；
      // 这里直接拒绝受理，让接线方先补齐注册（不把请求当完成，也不假装能完成）。
      throw new PrivacyError('OBJECT_UNAVAILABLE', `删除处理器未覆盖全部必需模块：${missing.join(', ')}`);
    }
    const request = registry.createDeletionRequest({ generation, receiptInput });
    requestModules.set(request.id, [...declared]);
    return request;
  }

  async function executeHandlers(requestId) {
    return registry.executeHandlers(requestId);
  }

  /**
   * 全模块完成判定：**任一必需模块未报告 ⇒ 一律未完成**。
   * 未完成时仍区分 `requested` / `processing` / `blocked`（不把"进行中"说成"完成"，
   * 也不把"缺少报告"说成"已核实无可删"）。
   */
  function completionStatus(requestId) {
    const request = registry.getRequest(requestId);
    if (!request) throw new PrivacyError('NOT_FOUND', '删除请求不存在');
    const missing = missingModules(requestId);
    if (missing.length === 0) {
      const base = registry.completionStatus(requestId);
      return Object.freeze({
        state: base.state,
        completed: base.completed === true,
        missingModules: Object.freeze([]),
      });
    }
    if (request.state === 'requested') {
      return Object.freeze({ state: 'requested', completed: false, missingModules: Object.freeze(missing) });
    }
    const rows = handlerRows(requestId);
    const blocked = rows.some(
      (row) => row.status === 'blocked' || row.onlineState === 'blocked' || row.backupState === 'blocked',
    );
    return Object.freeze({
      state: blocked ? 'blocked' : 'processing',
      completed: false,
      missingModules: Object.freeze(missing),
    });
  }

  /**
   * 契约形状回执（openapi `DeletionReceipt`）：
   * `{ id, state, revision, requested_at, online_due_at, backup_due_at, handlers[] }`，
   * handler 为 `{ module, online_state, backup_state, third_party_state, error_code }`。
   *
   * **未报告的必需模块以 `pending/pending` 出现**：回执本身就把"全模块"缺口摊开；
   * 回执不含任何私有正文/媒体/坐标/凭据（只含模块名、状态与安全错误码）。
   */
  function receipt(requestId) {
    const request = registry.getRequest(requestId);
    if (!request) return null;
    const status = completionStatus(requestId);
    const rowsByModule = new Map(handlerRows(requestId).map((row) => [row.module, row]));
    const declaredSet = new Set(declaredOf(requestId));
    // 闭集内的模块各一行（缺报告的为 pending）；闭集外若出现行也如实列出（不静默丢弃）。
    const modules = [...declaredOf(requestId), ...handlerRows(requestId).map((row) => row.module).filter((m) => !declaredSet.has(m))];
    const handlers = modules.map((module) => {
      const row = rowsByModule.get(module);
      const online = row?.onlineState;
      const backup = row?.backupState;
      return {
        module,
        online_state: HANDLER_STATES.includes(online) ? online : 'pending',
        backup_state: HANDLER_STATES.includes(backup) ? backup : 'pending',
        third_party_state: THIRD_PARTY_STATES.includes(row?.thirdPartyState) ? row.thirdPartyState : null,
        error_code: typeof row?.errorCode === 'string' && row.errorCode.length > 0 ? row.errorCode : null,
      };
    });
    return {
      id: String(request.id),
      state: DELETION_STATES.includes(status.state) ? status.state : 'processing',
      revision: Number.isSafeInteger(request.revision) && request.revision >= 1 ? request.revision : 1,
      requested_at: iso(request.requestedAt),
      online_due_at: iso(request.onlineDueAt),
      backup_due_at: iso(request.backupDueAt),
      handlers,
    };
  }

  /** 第三方删除状态（请求／完成／失败可追溯；`requested` 绝不等于 `confirmed`）。 */
  function thirdPartyStatuses(requestId) {
    return thirdPartyRows(requestId).map((row) => ({
      recipient_id: String(row.recipientId),
      export_ref: row.exportRef ?? null,
      online_status: String(row.onlineStatus),
      backup_status: String(row.backupStatus),
      requested_at: iso(row.requestedAt),
      confirmed_at: iso(row.confirmedAt),
      evidence_ref: typeof row.evidenceRef === 'string' && row.evidenceRef.length > 0 ? row.evidenceRef : null,
      error_code: typeof row.errorCode === 'string' && row.errorCode.length > 0 ? row.errorCode : null,
      completed: row.onlineStatus === 'confirmed' && row.backupStatus === 'confirmed',
    }));
  }

  return Object.freeze({
    requiredModules: modules,
    declareRequiredModules,
    registerModule,
    registeredModules,
    missingRegistrations,
    missingModules,
    createDeletionRequest,
    getRequest: (requestId) => registry.getRequest(requestId),
    executeHandlers,
    completionStatus,
    receipt,
    thirdPartyStatuses,
    requestThirdPartyDeletion: (input) => registry.requestThirdPartyDeletion(input),
    confirmThirdPartyDeletion: (input) => registry.confirmThirdPartyDeletion(input),
    failThirdPartyDeletion: (input) => registry.failThirdPartyDeletion(input),
    markUnsupported: (input) => registry.markUnsupported(input),
    now,
  });
}
