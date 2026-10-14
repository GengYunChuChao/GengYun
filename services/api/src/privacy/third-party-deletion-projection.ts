/**
 * GY-I19（#19）第 2 步 · **接收方（第三方）删除 请求／完成／失败 三态投影** —— 纯新增适配器。
 *
 * ## 先讲清楚：既有协议已有状态机，本片不另起一套
 * `packages/privacy/deletion.mjs`（GY-I27 已合并）已经实现三态能力本身：
 *   - `requestThirdPartyDeletion()` ⇒ `onlineStatus/backupStatus = 'requested'`（**请求**）；
 *   - `confirmThirdPartyDeletion({ evidenceRef })` ⇒ `'confirmed'`（**完成**，且**强制要求证据**）；
 *   - `failThirdPartyDeletion({ errorCode })` ⇒ `'failed'`（**失败**，错误码经 `SAFE_ERROR_CODES` 折叠）；
 *   - `markUnsupported()` ⇒ `'unsupported'`（无法删除/无法证实）。
 * `packages/privacy/deletion-modules.mjs` 还提供了公开只读访问器 `thirdPartyStatuses(requestId)`。
 * 因此本片**没有**新增任何状态机、没有改 `packages/privacy/**` 一个字节，只做**投影**（只读适配）。
 *
 * ## 本片补的**真实空白**（不是重复造轮子）
 * 1. **契约里的 `third_party_state` 从来填不上**：`openapi.json` 的 `DeletionHandler` 要求
 *    `third_party_state`（`ThirdPartyState|null`）与 `error_code` 一起返回，但已合并实现里
 *    `deletion.mjs::receiptProjection()` 把它**硬编码为 `null`**，`deletion-modules.mjs::receipt()`
 *    只从 handler 行读 `row.thirdPartyState`（该字段从未被写入）⇒ 接收方三态**永远不出现在回执里**。
 *    本片把「接收方行 → 契约闭集值」的映射补成**可复用的纯函数**（`receipt_third_party_state`），
 *    接线方无需另写一套判断，也无需改动既有文件。
 * 2. **既有 `completed` 不看到期**：`thirdPartyStatuses()` 返回的 `completed` 只看
 *    `online_status==='confirmed' && backup_status==='confirmed'`，**完全不看 7 日 / 30 日窗口** ——
 *    刚确认就能自称"完成"。本片复用第 1 步的 `evaluateDeletionAging()` 把窗口接上：
 *    **未到期一律不得 `completed`**（`THIRD_PARTY_NOT_DUE`）。
 * 3. **未完成时没有可判别原因**：既有 `completed:false` 只给一个布尔，分不清"没请求/已请求没确认/
 *    没证据/未到期/接收方失败/无法删除"。本片为每个阶段、每个接收方、整单各给一个**必非空**的
 *    `reason_code`（`completed === true` 时才为 `null`）。
 *
 * ## 边界（默认按"不得谎称完成"设计）
 *   - **未到期不得 completed**：`confirmed` 但 `now < due_at` ⇒ 仍算未完成（`THIRD_PARTY_NOT_DUE`，
 *     同时用 `protocol_state: 'confirmed'` 如实保留协议原值，不隐藏已收到确认这件事）。
 *   - **失败必须留原因**：白名单错误码原样透出（可判别）；非白名单自由文本**折叠**为
 *     `THIRD_PARTY_FAILED`，**原文不透出**（避免供应商 SDK 文本/私有内容进投影）。
 *   - **fail-closed**：越权（主体不匹配）、给了主体却无法核实归属、请求不存在、入参不可信、
 *     协议行状态不在闭集内 —— 一律**不返回任何接收方行**、`completed:false`、并给可判别原因码。
 *   - **无接收方 ⇒ 不得完成**：`THIRD_PARTY_NONE`（与 `deletion.mjs` 的 `hasWork` 同口径，
 *     避免空集合的真空真）；此时 `receipt_third_party_state` 为 `null`（契约允许 `null`）。
 *   - **幂等**：纯函数，输出只由入参决定；不写任何行、不改任何既有对象。
 *
 * ## 未取得项（如实披露）
 *   - `packages/contracts/**` 零改动；契约里**没有**第三方三态查询的独立 operation
 *     ⇒ **未自造任何路由/字段**，本文件是内部模块（`DeletionHandler.third_party_state` 是
 *     契约**已有**字段，本片只是把它填得出来）。
 *   - 不接任何真实第三方：本片零外部调用，只读既有替身/协议行；`real` 未接真实依赖 ⇒ 无调用可发。
 *   - 接收方**实际**删除结果（真实供应商回执）不在本片：本片只投影协议里已记录的请求/完成/失败。
 */
import { THIRD_PARTY_STATES } from '../../../../packages/privacy/constants.mjs';
import { SAFE_ERROR_CODES } from '../../../../packages/privacy/deletion.mjs';
import { AGING_REASON_CODES, evaluateDeletionAging } from './deletion-aging.ts';

/** 三态：请求（待办）/ 完成 / 失败。 */
export type ThirdPartyProjectionState = 'requested' | 'completed' | 'failed';

/** 三态闭集（顺序即语义顺序）。 */
export const THIRD_PARTY_PROJECTION_STATES: readonly ThirdPartyProjectionState[] = Object.freeze([
  'requested',
  'completed',
  'failed',
]);

const REASON_VALUES = {
  /** 该删除请求下没有任何接收方 ⇒ 无工作可判，不得成功。 */
  NONE: 'THIRD_PARTY_NONE',
  /** 请求不存在 / 不可读 ⇒ fail-closed。 */
  REQUEST_UNKNOWN: 'THIRD_PARTY_REQUEST_UNKNOWN',
  /** 越权：调用方主体与该请求绑定的主体不一致 ⇒ 不返回任何行。 */
  SUBJECT_MISMATCH: 'THIRD_PARTY_SUBJECT_MISMATCH',
  /** 给了主体但无法核实归属 ⇒ fail-closed（不敢替别人投影）。 */
  OWNERSHIP_UNVERIFIED: 'THIRD_PARTY_OWNERSHIP_UNVERIFIED',
  /** 入参或协议行形状不可信（时间非法、状态不在闭集内等）⇒ fail-closed。 */
  INPUT_INVALID: 'THIRD_PARTY_INPUT_INVALID',
  /** 尚未向该接收方发起删除请求。 */
  NOT_REQUESTED: 'THIRD_PARTY_NOT_REQUESTED',
  /** 已请求、等待接收方确认。 */
  REQUESTED: 'THIRD_PARTY_REQUESTED',
  /** 接收方已确认，但 7 日 / 30 日窗口**尚未到期** ⇒ 不得判完成。 */
  NOT_DUE: 'THIRD_PARTY_NOT_DUE',
  /** 接收方已确认，但缺完成证据（空白不算证据）⇒ 不得判完成。 */
  NO_EVIDENCE: 'THIRD_PARTY_NO_EVIDENCE',
  /** 接收方报告失败（非白名单错误码已折叠；白名单码原样透出）。 */
  FAILED: 'THIRD_PARTY_FAILED',
  /** 无法删除 / 无法证实：与失败同样阻塞，绝不等价于"已证实完成"。 */
  UNSUPPORTED: 'THIRD_PARTY_UNSUPPORTED',
} as const;

export const THIRD_PARTY_PROJECTION_REASON_CODES = Object.freeze(REASON_VALUES);

/** 以 `deletion-modules.mjs::thirdPartyStatuses()` 的返回行为准的**只读**来源端口。 */
export interface ThirdPartyProjectionSource {
  /** 既有协议访问器（`thirdPartyStatuses(requestId)`）；返回行数组。 */
  thirdPartyStatuses(requestId: string): unknown;
  /** 可选的请求读取器（`getRequest(requestId)`）；提供时用于"未知请求 fail-closed"。 */
  getRequest?(requestId: string): unknown;
}

/** 投影入参。 */
export interface ThirdPartyProjectionInput {
  source: ThirdPartyProjectionSource;
  requestId: string;
  /** 删除请求创建时间（7/30 日窗口的起点）。 */
  requestedAt: string | number | Date;
  /** 可注入的当前时间；不传则取一次系统时间。 */
  now?: string | number | Date;
  /** 可选：调用方主体。给出时**必须**能核实归属，否则 fail-closed。 */
  subject?: string;
  /** 可选：`requestId → 主体` 绑定读取器（核实归属用）。 */
  ownerOf?: (requestId: string) => string | null | undefined;
}

/** 单个阶段（在线 / 备份）的投影。 */
export interface ThirdPartyPhaseProjection {
  readonly phase: 'online' | 'backup';
  readonly state: ThirdPartyProjectionState;
  readonly completed: boolean;
  /** 该阶段窗口是否已到期（`now >= due_at`，闭区间）。 */
  readonly due: boolean;
  readonly due_at: string | null;
  /** 既有协议闭集内的**原始**值（`ThirdPartyState`），如实保留、不隐藏。 */
  readonly protocol_state: string;
  readonly recorded_error_code: string | null;
  readonly reason_code: string | null;
}

/** 单个接收方的投影。 */
export interface ThirdPartyRecipientProjection {
  readonly recipient_id: string;
  readonly export_ref: string | null;
  readonly requested_at: string | null;
  readonly confirmed_at: string | null;
  readonly online: ThirdPartyPhaseProjection;
  readonly backup: ThirdPartyPhaseProjection;
  readonly state: ThirdPartyProjectionState;
  readonly completed: boolean;
  readonly reason_code: string | null;
  /**
   * 与契约 `DeletionHandler.third_party_state`（`ThirdPartyState` 闭集）对齐的值。
   * 未完成时给阻塞态（`requested` / `failed` / `unsupported`），**绝不**在未完成时给 `confirmed`。
   */
  readonly receipt_third_party_state: string;
}

/** 整单投影。 */
export interface ThirdPartyDeletionProjection {
  readonly request_id: string;
  readonly requested_at: string | null;
  readonly now: string | null;
  readonly online_due_at: string | null;
  readonly backup_due_at: string | null;
  readonly state: ThirdPartyProjectionState;
  readonly completed: boolean;
  readonly reason_code: string | null;
  /** 全部出现过的可判别原因码（去重、有序）；`completed:true` 时为空数组。 */
  readonly reasons: readonly string[];
  readonly recipients: readonly ThirdPartyRecipientProjection[];
  readonly summary: { readonly total: number; readonly requested: number; readonly completed: number; readonly failed: number };
  /** 契约 `DeletionHandler.third_party_state` 可直接消费的整单聚合值；无接收方 ⇒ `null`。 */
  readonly receipt_third_party_state: string | null;
  readonly detail: string | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoOrNull(value: unknown): string | null {
  if (!isNonEmptyString(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 未完成 ⇒ 必带可判别原因码的 fail-closed 空投影（**不返回任何接收方行**）。 */
function failClosed(input: {
  requestId: string;
  nowIso: string | null;
  reasonCode: string;
  detail: string;
  requestedAtIso?: string | null;
  onlineDueAt?: string | null;
  backupDueAt?: string | null;
}): ThirdPartyDeletionProjection {
  return Object.freeze({
    request_id: input.requestId,
    requested_at: input.requestedAtIso ?? null,
    now: input.nowIso,
    online_due_at: input.onlineDueAt ?? null,
    backup_due_at: input.backupDueAt ?? null,
    state: 'requested' as const,
    completed: false,
    reason_code: input.reasonCode,
    reasons: Object.freeze([input.reasonCode]),
    recipients: Object.freeze([]),
    summary: Object.freeze({ total: 0, requested: 0, completed: 0, failed: 0 }),
    receipt_third_party_state: null,
    detail: input.detail,
  });
}

/** 单阶段判定：协议原值 + 证据 + 到期窗口 ⇒ 三态。 */
function projectPhase(input: {
  phase: 'online' | 'backup';
  protocolStatus: unknown;
  due: boolean;
  dueAt: string | null;
  evidenceOk: boolean;
  whitelistedErrorCode: string | null;
}): ThirdPartyPhaseProjection {
  const { phase, protocolStatus, due, dueAt, evidenceOk, whitelistedErrorCode } = input;
  const protocolValue = typeof protocolStatus === 'string' ? protocolStatus : String(protocolStatus);

  let state: ThirdPartyProjectionState;
  let completed = false;
  let reasonCode: string;

  if (!THIRD_PARTY_STATES.includes(protocolValue)) {
    // 协议行状态不在闭集内 ⇒ 形状不可信，fail-closed（当作阻塞失败，绝不完成）。
    state = 'failed';
    reasonCode = REASON_VALUES.INPUT_INVALID;
  } else if (protocolValue === 'failed') {
    state = 'failed';
    // 白名单码可判别、原样透出；否则折叠为固定分类（不透出供应商原文）。
    reasonCode = whitelistedErrorCode ?? REASON_VALUES.FAILED;
  } else if (protocolValue === 'unsupported') {
    state = 'failed';
    reasonCode = REASON_VALUES.UNSUPPORTED;
  } else if (protocolValue === 'not_requested') {
    state = 'requested';
    reasonCode = REASON_VALUES.NOT_REQUESTED;
  } else if (protocolValue === 'requested') {
    state = 'requested';
    reasonCode = REASON_VALUES.REQUESTED;
  } else if (!due) {
    // 铁律：未到期不得 completed（协议已确认也不认）。
    state = 'requested';
    reasonCode = REASON_VALUES.NOT_DUE;
  } else if (!evidenceOk) {
    state = 'requested';
    reasonCode = REASON_VALUES.NO_EVIDENCE;
  } else {
    state = 'completed';
    completed = true;
    reasonCode = '';
  }

  return Object.freeze({
    phase,
    state,
    completed,
    due,
    due_at: dueAt,
    protocol_state: protocolValue,
    recorded_error_code: whitelistedErrorCode,
    reason_code: completed ? null : reasonCode,
  });
}

/** 三态 ⇒ 契约 `ThirdPartyState` 闭集值（未完成时绝不给 `confirmed`）。 */
function toReceiptState(recipient: ThirdPartyRecipientProjection): string {
  if (recipient.completed) return 'confirmed';
  const protocolValues = [recipient.online.protocol_state, recipient.backup.protocol_state];
  if (protocolValues.includes('failed')) return 'failed';
  if (protocolValues.includes('unsupported')) return 'unsupported';
  if (protocolValues.includes('requested') || protocolValues.includes('confirmed')) return 'requested';
  if (protocolValues.every((value) => value === 'not_requested')) return 'not_requested';
  return 'requested';
}

/**
 * 把既有协议的接收方行投影成**三态 + 可判别原因码**，并对齐 7/30 日到期语义。
 *
 * 纯函数：相同入参 ⇒ 逐字段相同；不修改 `source` 或任何既有对象。
 */
export function projectThirdPartyDeletion(input: ThirdPartyProjectionInput): ThirdPartyDeletionProjection {
  const requestId = typeof input?.requestId === 'string' ? input.requestId : '';
  const source = input?.source;

  // 时间与窗口：复用第 1 步的到期模块（同一套 7 日 / 30 日口径）。
  // 未注入 now 时**只取一次**系统时间，两个阶段共用同一个"当前时间"，避免两次取时钟导致口径漂移。
  const nowValue = input?.now === undefined ? new Date().toISOString() : input.now;
  const onlineAging = evaluateDeletionAging({ requestedAt: input?.requestedAt, phase: 'online', now: nowValue });
  const backupAging = evaluateDeletionAging({ requestedAt: input?.requestedAt, phase: 'backup', now: nowValue });
  const nowIso = onlineAging.now;
  const requestedAtIso = onlineAging.requested_at;

  if (requestId.length === 0 || !source || typeof source.thirdPartyStatuses !== 'function') {
    return failClosed({
      requestId,
      nowIso,
      reasonCode: REASON_VALUES.INPUT_INVALID,
      detail: 'requestId 为空或 source 未提供 thirdPartyStatuses()',
    });
  }
  if (onlineAging.reason_code === AGING_REASON_CODES.INPUT_INVALID || backupAging.reason_code === AGING_REASON_CODES.INPUT_INVALID) {
    return failClosed({
      requestId,
      nowIso,
      reasonCode: REASON_VALUES.INPUT_INVALID,
      detail: `窗口计算入参不可信：${onlineAging.detail ?? backupAging.detail ?? ''}`,
    });
  }

  // 越权 / 无法核实归属 ⇒ 不返回任何行（fail-closed）。
  if (input.subject !== undefined) {
    if (typeof input.ownerOf !== 'function') {
      return failClosed({
        requestId,
        nowIso,
        requestedAtIso,
        onlineDueAt: onlineAging.due_at,
        backupDueAt: backupAging.due_at,
        reasonCode: REASON_VALUES.OWNERSHIP_UNVERIFIED,
        detail: '未提供 ownerOf 绑定，无法核实该请求归属 ⇒ 拒绝投影',
      });
    }
    const owner = input.ownerOf(requestId);
    if (!isNonEmptyString(owner)) {
      return failClosed({
        requestId,
        nowIso,
        requestedAtIso,
        onlineDueAt: onlineAging.due_at,
        backupDueAt: backupAging.due_at,
        reasonCode: REASON_VALUES.REQUEST_UNKNOWN,
        detail: '请求未绑定主体（或请求不存在）⇒ 拒绝投影',
      });
    }
    if (owner !== input.subject) {
      return failClosed({
        requestId,
        nowIso,
        requestedAtIso,
        onlineDueAt: onlineAging.due_at,
        backupDueAt: backupAging.due_at,
        reasonCode: REASON_VALUES.SUBJECT_MISMATCH,
        detail: '调用方主体与该删除请求绑定的主体不一致 ⇒ 拒绝投影',
      });
    }
  }

  // 未知请求 ⇒ fail-closed（仅当来源提供了 getRequest 才能核实）。
  if (typeof source.getRequest === 'function') {
    const request = source.getRequest(requestId);
    if (request === null || request === undefined) {
      return failClosed({
        requestId,
        nowIso,
        requestedAtIso,
        onlineDueAt: onlineAging.due_at,
        backupDueAt: backupAging.due_at,
        reasonCode: REASON_VALUES.REQUEST_UNKNOWN,
        detail: '既有协议中不存在该删除请求 ⇒ 拒绝投影',
      });
    }
  }

  const rows = source.thirdPartyStatuses(requestId);
  if (!Array.isArray(rows)) {
    return failClosed({
      requestId,
      nowIso,
      requestedAtIso,
      onlineDueAt: onlineAging.due_at,
      backupDueAt: backupAging.due_at,
      reasonCode: REASON_VALUES.INPUT_INVALID,
      detail: 'thirdPartyStatuses() 未返回行数组',
    });
  }

  const recipients: ThirdPartyRecipientProjection[] = rows.map((raw, index) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const recipientIdValue = row['recipient_id'];
    const recipientId = isNonEmptyString(recipientIdValue) ? recipientIdValue : `#${index}`;
    const rawErrorCodeValue = row['error_code'];
    const rawErrorCode = isNonEmptyString(rawErrorCodeValue) ? rawErrorCodeValue.trim() : '';
    // 只透出既有协议白名单内的失败码；其余折叠，不进投影。
    const whitelistedErrorCode =
      rawErrorCode.length > 0 && SAFE_ERROR_CODES.includes(rawErrorCode) ? rawErrorCode : null;
    const evidenceOk = isNonEmptyString(row['evidence_ref']);

    const online = projectPhase({
      phase: 'online',
      protocolStatus: row['online_status'],
      due: onlineAging.online_due,
      dueAt: onlineAging.online_due_at,
      evidenceOk,
      whitelistedErrorCode,
    });
    const backup = projectPhase({
      phase: 'backup',
      protocolStatus: row['backup_status'],
      due: backupAging.backup_due,
      dueAt: backupAging.backup_due_at,
      evidenceOk,
      whitelistedErrorCode,
    });

    const completed = online.completed && backup.completed;
    const state: ThirdPartyProjectionState = completed
      ? 'completed'
      : online.state === 'failed' || backup.state === 'failed'
        ? 'failed'
        : 'requested';
    // completed===false 时原因码必非空：优先取失败阶段，其次取第一个未完成阶段。
    const reasonCode = completed
      ? null
      : (online.state === 'failed' ? online.reason_code : null) ??
        (backup.state === 'failed' ? backup.reason_code : null) ??
        online.reason_code ??
        backup.reason_code;

    const recipient: ThirdPartyRecipientProjection = {
      recipient_id: recipientId,
      export_ref: isNonEmptyString(row['export_ref']) ? row['export_ref'] : null,      requested_at: isoOrNull(row['requested_at']),
      confirmed_at: isoOrNull(row['confirmed_at']),
      online,
      backup,
      state,
      completed,
      reason_code: reasonCode,
      receipt_third_party_state: '',
    };
    return Object.freeze({ ...recipient, receipt_third_party_state: toReceiptState(recipient) });
  });

  const completed = recipients.length > 0 && recipients.every((item) => item.completed);
  const failedCount = recipients.filter((item) => item.state === 'failed').length;
  const requestedCount = recipients.filter((item) => item.state === 'requested').length;

  const reasons: string[] = [];
  const pushReason = (code: string | null): void => {
    if (code !== null && code.length > 0 && !reasons.includes(code)) reasons.push(code);
  };
  // 失败优先（阻塞最需要被看见），随后按行序补齐其余未完成原因。
  for (const recipient of recipients) {
    if (recipient.state === 'failed') pushReason(recipient.reason_code);
  }
  for (const recipient of recipients) {
    if (recipient.state !== 'failed') pushReason(recipient.reason_code);
  }

  const state: ThirdPartyProjectionState = completed ? 'completed' : failedCount > 0 ? 'failed' : 'requested';
  // 无接收方 = 无工作可判 ⇒ 唯一原因是 THIRD_PARTY_NONE（也必须出现在 reasons 里，便于机读）。
  if (recipients.length === 0) pushReason(REASON_VALUES.NONE);
  const reasonCode = completed ? null : (reasons[0] ?? REASON_VALUES.NONE);

  const receiptState = recipients.length === 0
    ? null
    : completed
      ? 'confirmed'
      : recipients.some((item) => item.receipt_third_party_state === 'failed')
        ? 'failed'
        : recipients.some((item) => item.receipt_third_party_state === 'unsupported')
          ? 'unsupported'
          : recipients.some((item) => item.receipt_third_party_state === 'requested')
            ? 'requested'
            : 'not_requested';

  return Object.freeze({
    request_id: requestId,
    requested_at: requestedAtIso,
    now: nowIso,
    online_due_at: onlineAging.online_due_at,
    backup_due_at: backupAging.backup_due_at,
    state,
    completed,
    reason_code: reasonCode,
    reasons: Object.freeze(reasons),
    recipients: Object.freeze(recipients),
    summary: Object.freeze({
      total: recipients.length,
      requested: requestedCount,
      completed: recipients.filter((item) => item.completed).length,
      failed: failedCount,
    }),
    receipt_third_party_state: receiptState,
    detail: null,
  });
}

/**
 * 只取契约 `DeletionHandler.third_party_state` 需要的那个值（接线方最常用的入口）。
 * 无接收方 ⇒ `null`（契约允许 `null`；**不得**用 `confirmed` 表示"没有接收方"）。
 */
export function thirdPartyReceiptState(input: ThirdPartyProjectionInput): string | null {
  return projectThirdPartyDeletion(input).receipt_third_party_state;
}
