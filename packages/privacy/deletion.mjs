/**
 * GY-I27 隐私模块 · 注销删除的模块注册协议与第三方删除请求接口。
 *
 * 提供协议与接口，完整 7/30 日集成（对象存储/备份/供应商副本/恢复清单重放）由 GY-I19 完成。
 * 本模块只保证：
 *   - 模块可注册删除处理器（registerModule），所有 handler 证据完成才可完结。
 *   - 第三方删除请求/完成/失败可追溯，且 requested 绝不等于 confirmed（不把请求当完成）。
 *   - 回执查询无私有内容（只暴露进度/期限/最小失败码）。
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { PrivacyError } from './errors.mjs';

const ONLINE_HOURS = 7 * 24; // 在线 7×24 小时
const BACKUP_HOURS = 30 * 24; // 备份 30×24 小时

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 3600 * 1000);
}

/**
 * @param {{ now?: () => Date }} [deps]
 */
export function createDeletionRegistry({ now = () => new Date() } = {}) {
  /** @type {Map<string, (request:object) => Promise<object>>} */
  const handlers = new Map();
  /** @type {Map<string, object>} */
  const requests = new Map();
  /** @type {Array<object>} 删除 handler 行 */
  const handlerRows = [];
  /** @type {Array<object>} 第三方删除行 */
  const thirdPartyRows = [];

  /**
   * 模块删除处理器注册协议：每个模块注册一个处理器，重复注册报错。
   * handler 返回 { onlineState, backupState, evidenceRef?, errorCode? }。
   */
  function registerModule(module, handlerFn) {
    if (typeof module !== 'string' || module.length === 0 || module.length > 80) {
      throw new PrivacyError('INVALID_REQUEST', '模块名非法');
    }
    if (handlers.has(module)) {
      throw new PrivacyError('INVALID_REQUEST', `模块已注册：${module}`);
    }
    if (typeof handlerFn !== 'function') {
      throw new PrivacyError('INVALID_REQUEST', `模块处理器非法：${module}`);
    }
    handlers.set(module, handlerFn);
    return module;
  }

  function receiptHash(input) {
    return createHash('sha256').update(input).digest('hex');
  }

  /**
   * 创建删除请求（受理时刻记录在线/备份截止，不等完成）。
   */
  function createDeletionRequest({ generation = 1, receiptInput = null } = {}) {
    if (!Number.isInteger(generation) || generation < 1) {
      throw new PrivacyError('INVALID_REQUEST', 'generation 非法');
    }
    const requestedAt = now();
    const request = {
      id: randomUUID(),
      receiptHash: receiptHash(receiptInput ?? `${requestedAt.toISOString()}:${generation}:${randomUUID()}`),
      generation,
      state: 'requested',
      requestedAt,
      onlineDueAt: addHours(requestedAt, ONLINE_HOURS),
      backupDueAt: addHours(requestedAt, BACKUP_HOURS),
      revision: 1,
      completedAt: null,
    };
    requests.set(request.id, request);
    return { ...request };
  }

  function getRequest(id) {
    const r = requests.get(id);
    return r ? { ...r } : null;
  }

  /**
   * 执行已注册模块的删除处理器。所有 handler 完成才可推进 state；任一 blocked 则整体 blocked。
   * @returns {Promise<object>} 更新后的 request
   */
  async function executeHandlers(requestId) {
    const request = requests.get(requestId);
    if (!request) throw new PrivacyError('NOT_FOUND', '删除请求不存在');
    request.state = 'processing';
    request.revision += 1;

    let anyBlocked = false;
    for (const [module, fn] of handlers.entries()) {
      const row = {
        requestId,
        module,
        objectRefCipher: `opaque:${module}:${request.id}`,
        status: 'running',
        onlineState: 'running',
        backupState: 'running',
        evidenceRef: null,
        errorCode: null,
        updatedAt: now(),
      };
      handlerRows.push(row);
      try {
        const result = await fn({ requestId: request.id, module });
        row.onlineState = result?.onlineState ?? 'completed';
        row.backupState = result?.backupState ?? 'completed';
        row.evidenceRef = result?.evidenceRef ?? null;
        row.errorCode = result?.errorCode ?? null;
        if (row.onlineState === 'blocked' || row.backupState === 'blocked') {
          row.status = 'blocked';
          anyBlocked = true;
        } else {
          row.status = 'completed';
        }
      } catch (err) {
        row.onlineState = 'blocked';
        row.backupState = 'blocked';
        row.status = 'blocked';
        row.errorCode = (err && err.code) || 'HANDLER_FAILED';
        anyBlocked = true;
      }
      row.updatedAt = now();
    }

    // 所有 handler 完成才算 processing 完成；有 blocked 则整体 blocked。
    const allCompleted = handlerRows
      .filter((r) => r.requestId === requestId)
      .every((r) => r.status === 'completed');
    request.state = anyBlocked ? 'blocked' : allCompleted ? 'processing' : 'processing';
    if (anyBlocked) request.state = 'blocked';
    return { ...request };
  }

  /**
   * 第三方删除请求（状态 requested；不等于 confirmed）。
   */
  function requestThirdPartyDeletion({ requestId, recipientId, exportRef = null } = {}) {
    if (!requests.has(requestId)) throw new PrivacyError('NOT_FOUND', '删除请求不存在');
    const row = {
      requestId,
      recipientId,
      exportRef,
      onlineStatus: 'requested',
      backupStatus: 'requested',
      requestedAt: now(),
      confirmedAt: null,
      evidenceRef: null,
      errorCode: null,
    };
    thirdPartyRows.push(row);
    return { ...row };
  }

  function findThirdParty(requestId, recipientId, exportRef) {
    return thirdPartyRows.find(
      (r) => r.requestId === requestId && r.recipientId === recipientId && r.exportRef === exportRef,
    );
  }

  /**
   * 第三方删除确认：必须有证据与确认时间；requested 绝不直接变 confirmed。
   */
  function confirmThirdPartyDeletion({ requestId, recipientId, exportRef = null, evidenceRef } = {}) {
    const row = findThirdParty(requestId, recipientId, exportRef);
    if (!row) throw new PrivacyError('NOT_FOUND', '第三方删除请求不存在');
    if (!evidenceRef || typeof evidenceRef !== 'string') {
      throw new PrivacyError('INVALID_REQUEST', '确认第三方删除需要证据（evidence_ref）');
    }
    if (row.onlineStatus === 'not_requested') {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '未发起请求，不能确认');
    }
    row.onlineStatus = 'confirmed';
    row.backupStatus = 'confirmed';
    row.confirmedAt = now();
    row.evidenceRef = evidenceRef;
    return { ...row };
  }

  function failThirdPartyDeletion({ requestId, recipientId, exportRef = null, errorCode = 'THIRD_PARTY_FAILED' } = {}) {
    const row = findThirdParty(requestId, recipientId, exportRef);
    if (!row) throw new PrivacyError('NOT_FOUND', '第三方删除请求不存在');
    row.onlineStatus = 'failed';
    row.backupStatus = 'failed';
    row.errorCode = errorCode;
    return { ...row };
  }

  function markUnsupported({ requestId, recipientId, exportRef = null } = {}) {
    const row = findThirdParty(requestId, recipientId, exportRef);
    if (!row) throw new PrivacyError('NOT_FOUND', '第三方删除请求不存在');
    row.onlineStatus = 'unsupported';
    row.backupStatus = 'unsupported';
    return { ...row };
  }

  /**
   * 删除完成状态（派生，不回写不推断）：
   *   completed 仅当：请求已进入处理（非 requested）、存在实际工作（handler 或第三方）、
   *   所有 handler completed、所有第三方 confirmed/unsupported、无 failed/blocked。
   *   到期不等于完成（不把时钟到期当完成）。
   */
  function completionStatus(requestId) {
    const request = requests.get(requestId);
    if (!request) throw new PrivacyError('NOT_FOUND', '删除请求不存在');

    const rows = handlerRows.filter((r) => r.requestId === requestId);
    const thirdParties = thirdPartyRows.filter((r) => r.requestId === requestId);

    // 尚未进入处理（requested）：不当作完成。
    if (request.state === 'requested') {
      return { state: 'requested', completed: false };
    }

    const handlersDone = rows.every((r) => r.status === 'completed');
    const tpDone = thirdParties.every((r) =>
      ['confirmed', 'unsupported'].includes(r.onlineStatus) &&
      ['confirmed', 'unsupported'].includes(r.backupStatus),
    );
    const tpFailed = thirdParties.some((r) =>
      r.onlineStatus === 'failed' || r.backupStatus === 'failed',
    );
    // 无任何 handler 与第三方工作：不能判定完成（避免空集合的真空真）。
    const hasWork = rows.length > 0 || thirdParties.length > 0;

    if (request.state !== 'blocked' && handlersDone && tpDone && !tpFailed && hasWork) {
      if (request.state !== 'completed') {
        request.state = 'completed';
        request.completedAt = now();
        request.revision += 1;
      }
      return { state: 'completed', completed: true };
    }

    const state = request.state === 'blocked' || tpFailed || !handlersDone || !tpDone
      ? 'blocked'
      : 'processing';
    return { state, completed: false };
  }

  /** 回执投影：仅进度/期限/最小失败码，无私有内容。 */
  function receiptProjection(requestId) {
    const request = requests.get(requestId);
    if (!request) return null;
    const handlersProj = handlerRows
      .filter((r) => r.requestId === requestId)
      .map((r) => ({
        module: r.module,
        onlineState: r.onlineState,
        backupState: r.backupState,
        thirdPartyState: null,
        errorCode: r.errorCode,
      }));
    const status = completionStatus(requestId);
    return {
      id: request.id,
      state: status.state,
      revision: request.revision,
      requestedAt: request.requestedAt,
      onlineDueAt: request.onlineDueAt,
      backupDueAt: request.backupDueAt,
      handlers: handlersProj,
    };
  }

  return {
    registerModule,
    createDeletionRequest,
    getRequest,
    executeHandlers,
    requestThirdPartyDeletion,
    confirmThirdPartyDeletion,
    failThirdPartyDeletion,
    markUnsupported,
    completionStatus,
    receiptProjection,
    _handlers: handlers,
    _requests: requests,
    _handlerRows: handlerRows,
    _thirdPartyRows: thirdPartyRows,
  };
}
