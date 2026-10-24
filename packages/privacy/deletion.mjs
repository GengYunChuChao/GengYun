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
import { HANDLER_STATES } from './constants.mjs';
import { PrivacyError } from './errors.mjs';

const ONLINE_HOURS = 7 * 24; // 在线 7×24 小时
const BACKUP_HOURS = 30 * 24; // 备份 30×24 小时

/**
 * handler / 第三方可写入错误码的**固定安全分类白名单**。
 * 处理器异常或返回码里的「原始 SDK 文本」一律映射到白名单内的固定值，
 * 不把原文（可能含私有正文/坐标/凭据）改名后放进 errorCode 进入用户回执。
 */
export const SAFE_ERROR_CODES = Object.freeze([
  'HANDLER_FAILED',
  'HANDLER_TIMEOUT',
  'EVIDENCE_REQUIRED',
  'INVALID_HANDLER_RESULT',
  'STORE_UNREACHABLE',
  'STORE_REJECTED',
  'POLICY_BLOCKED',
  'THIRD_PARTY_FAILED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
]);
const SAFE_ERROR_CODE_SET = new Set(SAFE_ERROR_CODES);

function sanitizeErrorCode(value, fallback = 'HANDLER_FAILED') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return SAFE_ERROR_CODE_SET.has(trimmed) ? trimmed : fallback;
}

function sanitizeOrNull(value) {
  return value === undefined || value === null ? null : sanitizeErrorCode(value);
}

/** 有效且非空的完成证据（空串/纯空白不算证据）。 */
function hasEvidence(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

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
   * 执行已注册模块的删除处理器（幂等可重试：已完成的行不重跑，blocked/pending/running 重跑）。
   * 每个 handler 须返回合法 online_state/backup_state（缺值或非法值视为 blocked）；
   * 只有当 online 与 backup 均 completed 才记 completed，pending/running 保持未完成。
   * @returns {Promise<object>} 更新后的 request
   */
  async function executeHandlers(requestId) {
    const request = requests.get(requestId);
    if (!request) throw new PrivacyError('NOT_FOUND', '删除请求不存在');
    if (request.state === 'requested') {
      request.state = 'processing';
      request.revision += 1;
    }

    let anyBlocked = false;
    for (const [module, fn] of handlers.entries()) {
      let row = handlerRows.find((r) => r.requestId === requestId && r.module === module);
      if (!row) {
        row = {
          requestId,
          module,
          objectRefCipher: `opaque:${module}:${request.id}`,
          status: 'pending',
          onlineState: 'pending',
          backupState: 'pending',
          evidenceRef: null,
          errorCode: null,
          updatedAt: now(),
        };
        handlerRows.push(row);
      }
      if (row.status === 'completed') continue; // 已完成不重跑
      row.status = 'running';
      row.onlineState = 'running';
      row.backupState = 'running';
      try {
        const result = await fn({ requestId: request.id, module });
        const online = result?.onlineState;
        const backup = result?.backupState;
        // 缺返回值 / 非法状态 → blocked，不默认 completed。
        if (!HANDLER_STATES.includes(online) || !HANDLER_STATES.includes(backup)) {
          row.onlineState = 'blocked';
          row.backupState = 'blocked';
          row.status = 'blocked';
          row.evidenceRef = null;
          row.errorCode = 'INVALID_HANDLER_RESULT';
          anyBlocked = true;
        } else {
          const evidenceRef = hasEvidence(result?.evidenceRef) ? result.evidenceRef.trim() : null;
          row.onlineState = online;
          row.backupState = backup;
          row.evidenceRef = evidenceRef;
          row.errorCode = sanitizeOrNull(result?.errorCode);
          if (online === 'blocked' || backup === 'blocked') {
            row.status = 'blocked';
            anyBlocked = true;
          } else if (online === 'completed' && backup === 'completed') {
            // 冻结契约（state-contract.md）：各阶段「完成证据齐全」才算完成。
            // 报称 completed 但缺证据/空白证据 → 不可判定完成，保持阻塞待验证。
            if (evidenceRef === null) {
              row.status = 'blocked';
              row.errorCode = 'EVIDENCE_REQUIRED';
              anyBlocked = true;
            } else {
              row.status = 'completed';
            }
          } else {
            row.status = 'running'; // pending/running 均保持未完成
          }
        }
      } catch (err) {
        row.onlineState = 'blocked';
        row.backupState = 'blocked';
        row.status = 'blocked';
        row.evidenceRef = null;
        // 原始异常文本/嵌套错误一律映射到固定安全分类，不进入用户回执。
        row.errorCode = sanitizeErrorCode(err && err.code);
        anyBlocked = true;
      }
      row.updatedAt = now();
    }

    // 有 blocked 则整体 blocked；否则保持 processing，最终完成由 completionStatus 判定。
    if (anyBlocked) request.state = 'blocked';
    else request.state = 'processing';
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
    row.errorCode = sanitizeErrorCode(errorCode, 'THIRD_PARTY_FAILED');
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
   * 在途取消：仅 requested / processing / blocked 可取消（终态 completed / cancelled 不可再取消）。
   *
   * 为什么是「状态机终态」而不是「删掉请求」：注销请求是审计事实，取消要保留行与时间线；
   * 取消只是把状态推进到 cancelled 并递增 revision（强 ETag 随之失效，旧读/旧写都靠 revision 对不上被拒）。
   * 取消后迟到回调不得复活：completionStatus 对 cancelled 直接短路返回，不再做完成判定。
   */
  function cancelDeletion(requestId) {
    const request = requests.get(requestId);
    if (!request) throw new PrivacyError('NOT_FOUND', '删除请求不存在');
    if (request.state === 'completed' || request.state === 'cancelled') {
      throw new PrivacyError('OBJECT_UNAVAILABLE', '删除请求已处于终态，不可取消');
    }
    request.state = 'cancelled';
    request.revision += 1;
    return { ...request };
  }

  /**
   * 删除完成状态（派生，不回写不推断）：
   *   completed 仅当：请求已进入处理（非 requested）、存在实际工作（handler 或第三方）、
   *   所有 handler 的 online 与 backup 均 completed、所有第三方均 confirmed（有证据）、
   *   无 failed/blocked/unsupported。
   *   unsupported（无法删除/无法证实）与 failed 一样保留阻塞——「已证实完成」与「无法删除」不等价。
   *   到期不等于完成（不把时钟到期当完成）。
   */
  function completionStatus(requestId) {
    const request = requests.get(requestId);
    if (!request) throw new PrivacyError('NOT_FOUND', '删除请求不存在');

    // 取消是终态：不再做任何完成判定（迟到回调不得把 cancelled 推回 processing/blocked/completed）。
    if (request.state === 'cancelled') {
      return { state: 'cancelled', completed: false };
    }

    const rows = handlerRows.filter((r) => r.requestId === requestId);
    const thirdParties = thirdPartyRows.filter((r) => r.requestId === requestId);

    // 尚未进入处理（requested）：不当作完成。
    if (request.state === 'requested') {
      return { state: 'requested', completed: false };
    }

    // handler 完成：online 与 backup 均 completed 且**完成证据齐全**（缺证据/空白证据不算）。
    const handlersDone = rows.every(
      (r) =>
        r.onlineState === 'completed' &&
        r.backupState === 'completed' &&
        hasEvidence(r.evidenceRef),
    );
    // 第三方完成：仅 confirmed 算完成；failed/unsupported 均不算（区分「无法删除」与「已证实完成」）。
    const tpDone = thirdParties.every(
      (r) => r.onlineStatus === 'confirmed' && r.backupStatus === 'confirmed',
    );
    const tpBlocked = thirdParties.some(
      (r) =>
        r.onlineStatus === 'failed' || r.backupStatus === 'failed' ||
        r.onlineStatus === 'unsupported' || r.backupStatus === 'unsupported',
    );
    const handlerBlocked = rows.some(
      (r) => r.onlineState === 'blocked' || r.backupState === 'blocked',
    );
    // 无任何 handler 与第三方工作：不能判定完成（避免空集合的真空真）。
    const hasWork = rows.length > 0 || thirdParties.length > 0;

    if (request.state !== 'blocked' && handlersDone && tpDone && !tpBlocked && !handlerBlocked && hasWork) {
      if (request.state !== 'completed') {
        request.state = 'completed';
        request.completedAt = now();
        request.revision += 1;
      }
      return { state: 'completed', completed: true };
    }

    const state = request.state === 'blocked' || tpBlocked || handlerBlocked || !handlersDone || !tpDone
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
    cancelDeletion,
    completionStatus,
    receiptProjection,
    _handlers: handlers,
    _requests: requests,
    _handlerRows: handlerRows,
    _thirdPartyRows: thirdPartyRows,
  };
}
