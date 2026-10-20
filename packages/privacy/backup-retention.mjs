/**
 * GY-I19 · 逐用户备份副本域的**留存判定**（纯逻辑，不碰 IO、不读写任何存储）。
 *
 * ## 这个模块回答什么
 * 「注销后在线 7 日／备份 30 日」里的**备份副本**何时到期、到期那一批副本现在该
 * `purge`（清）、该 `wait`（等）、还是该 `blocked`（停手）。它**只做判定**：
 * 不删行、不建表、不打日志、不认识 PG 与备份介质。真实清除由
 * `services/api/src/privacy/user-data-deletion.ts` 的 `BackupPurgePort` 实现按本判定执行
 * （设计见 `docs/architecture/gy-i19-user-backup-copies-design.md`）。
 *
 * ## 三条硬不变量（本模块的存在理由，逐条对应单测）
 * 1. **空集不是成功**：`copies` 为空 ⇒ `action: 'none'` + `reason: 'BACKUP_NO_COPIES'`。
 *    `none` 的语义是「本次没有可清对象」，**不是**「已清除」。把空登记表读成
 *    `purged: true` 会造出伪证据（`packages/privacy/deletion-modules.mjs` 的
 *    `assertModuleList` 拒绝空集、`deletion.mjs` 的 `completionStatus` 要求
 *    `hasWork = rows.length > 0 || thirdParties.length > 0`，同一口径）。
 * 2. **非法输入不放行**：`now`／`retentionUntil` 解析失败、`copies` 不是数组、
 *    行不是对象、`state` 不在闭集内 —— 一律 `blocked`，**绝不**默认放行或默认当成未到期。
 * 3. **到期取闭区间**：`now === retentionUntil` 那一刻即到期（与
 *    `services/api/src/privacy/deletion-aging.ts` 的 `nowMs >= dueMs` 同口径）；
 *    差 1 毫秒则未到期。
 *
 * ## 时间的唯一口径
 * 输入接受 `Date` / 有限 `number`（epoch 毫秒）/ **带时区的** ISO-8601 字符串
 * （正则与 `deletion-aging.ts` 的 `ISO_8601_STRICT` 逐字相同，裸本地时间
 * `2026-10-18T00:00:00` 这类无时区写法**拒绝**）；输出一律 UTC ISO-8601（`toISOString()`）。
 * 不引入「今天」：所有判定都以入参 `now` 为准，本模块自身不读系统时钟。
 *
 * ## 7 天与 30 天的**同源关系**（为什么这里出现了第三处声明）
 * 数值的真源是 `packages/privacy/deletion.mjs`（`ONLINE_HOURS = 7 * 24`、
 * `BACKUP_HOURS = 30 * 24`，模块私有未导出）与
 * `services/api/src/privacy/deletion-aging.ts`（`ONLINE_RETENTION_DAYS = 7`、
 * `BACKUP_RETENTION_DAYS = 30`）。本模块把「天＋毫秒」显式导出，供备份副本域自己算期限；
 * 三处**必须逐值相等**，由 `tests/unit/backup-retention.test.mjs` 交叉校验
 * （用 `createDeletionRegistry()` 的 `onlineDueAt`／`backupDueAt` 差值反查小时口径，
 * 并直接对 `deletion-aging.ts` 的常量比对天口径）。本片**不改**上面两个既有文件。
 */

/** 在线保留期：受理时刻 + 7×24 小时（单位：天）。 */
export const ONLINE_RETENTION_DAYS = 7;

/** 备份副本保留期：受理时刻 + 30×24 小时（单位：天）。 */
export const BACKUP_RETENTION_DAYS = 30;

/** 上面两个常量的单位（显式登记，避免「7」被读成小时或毫秒）。 */
export const RETENTION_UNIT = 'day';

/** 一天的毫秒数。 */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 在线保留期（毫秒）。 */
export const ONLINE_RETENTION_MS = ONLINE_RETENTION_DAYS * MS_PER_DAY;

/** 备份副本保留期（毫秒）。 */
export const BACKUP_RETENTION_MS = BACKUP_RETENTION_DAYS * MS_PER_DAY;

/**
 * 备份副本行状态闭集（与设计文档的状态机逐项对应）。
 *
 * - `pending_purge`：副本仍在留存期内，到期后由 `purge()` 硬删 `payload`；
 * - `purged`：`payload` 已硬删（行作为**清除证据**保留，不含正文）；
 * - `failed`：上一次清除尝试失败 ⇒ 必须停在 `blocked` 等重试，不得当作已清。
 */
export const BACKUP_COPY_STATES = Object.freeze(['pending_purge', 'purged', 'failed']);

/** `evaluateBackupPurge()` 的动作闭集。 */
export const BACKUP_PURGE_ACTIONS = Object.freeze(['none', 'wait', 'purge', 'blocked']);

/**
 * 判定理由码（稳定、可断言、不含任何个人数据）。
 *
 * 调用方（`BackupPurgePort` 实现）的映射铁律：**只有 `action === 'purge'` 且本次真的
 * 删掉了副本、且能给出非空证据时**才允许 `{ purged: true }`；
 * `none` / `wait` / `blocked` 一律 `{ purged: false }`。
 */
export const BACKUP_PURGE_REASONS = Object.freeze({
  /** `purge`：至少一条副本已到期，且无 `failed` 行、无非法输入。 */
  PURGE_DUE: 'BACKUP_PURGE_DUE',
  /** `wait`：副本都在留存期内（或已清但仍有未到期行），未到期不做事。 */
  WAITING_RETENTION: 'BACKUP_WAITING_RETENTION',
  /** `none`：**没有任何副本行** —— 不构成清除证据（空集不是成功）。 */
  NO_COPIES: 'BACKUP_NO_COPIES',
  /** `none`：所有副本行都已是 `purged`，本次调用没有可做的事（也不伪造新证据）。 */
  ALL_PURGED: 'BACKUP_ALL_PURGED',
  /** `blocked`：存在 `failed` 副本行，或清除状态不可信。 */
  COPY_FAILED: 'BACKUP_COPY_FAILED',
  /** `blocked`：入参非法（时间不可解析／结构非法／状态未知），一律不放行。 */
  INPUT_INVALID: 'BACKUP_INPUT_INVALID',
});

/** 与 `deletion-aging.ts` 逐字相同的严格 ISO-8601（必须带 `Z` 或 `±HH:MM` 时区）。 */
const ISO_8601_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * 解析一个时刻为 epoch 毫秒；不可信一律返回 `null`（调用方据此 fail closed）。
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function parseInstant(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    if (!ISO_8601_STRICT.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * 把受理时刻解析成 epoch 毫秒，非法即抛错（期限不许从不可信时间推导）。
 *
 * @param {unknown} requestedAt
 * @returns {number}
 */
function requireInstant(requestedAt) {
  const ms = parseInstant(requestedAt);
  if (ms === null) {
    throw new TypeError(
      '受理时刻必须是 Date／epoch 毫秒／带时区的 ISO-8601 字符串；不接受裸本地时间与空值',
    );
  }
  return ms;
}

/**
 * 在线保留截止：`requestedAt + 7×24h`。
 *
 * @param {string | number | Date} requestedAt 注销受理时刻
 * @returns {string} UTC ISO-8601
 */
export function onlineRetentionUntil(requestedAt) {
  return new Date(requireInstant(requestedAt) + ONLINE_RETENTION_MS).toISOString();
}

/**
 * 备份副本保留截止：`requestedAt + 30×24h`。
 *
 * @param {string | number | Date} requestedAt 注销受理时刻
 * @returns {string} UTC ISO-8601
 */
export function backupRetentionUntil(requestedAt) {
  return new Date(requireInstant(requestedAt) + BACKUP_RETENTION_MS).toISOString();
}

/**
 * 从「受理时间」一次推导两条期限（回执里的 `online_due_at`／`backup_due_at` 同源口径）。
 *
 * @param {string | number | Date} requestedAt 注销受理时刻
 * @returns {{ requested_at: string, online_retention_until: string, backup_retention_until: string }}
 */
export function retentionDeadlines(requestedAt) {
  const ms = requireInstant(requestedAt);
  return Object.freeze({
    requested_at: new Date(ms).toISOString(),
    online_retention_until: new Date(ms + ONLINE_RETENTION_MS).toISOString(),
    backup_retention_until: new Date(ms + BACKUP_RETENTION_MS).toISOString(),
  });
}

/**
 * @typedef {{ state: 'pending_purge' | 'purged' | 'failed', retentionUntil: string | number | Date }} BackupCopyRow
 */

/**
 * 判定这一批备份副本此刻该做什么。
 *
 * 判定顺序（**先 fail closed，再判到期**）：
 *   1. `now` 不可解析 ⇒ `blocked`／`INPUT_INVALID`；
 *   2. `copies` 不是数组（含未传） ⇒ `blocked`／`INPUT_INVALID`
 *      —— 「没查存储」与「查到空集」都不得被读成「清干净了」；
 *   3. 逐行校验：行不是对象／`state` 不在闭集／`retentionUntil` 不可解析 ⇒ `blocked`／`INPUT_INVALID`；
 *   4. 存在 `failed` 行 ⇒ `blocked`／`COPY_FAILED`（即使同时有到期行，也不许报「清完了」）；
 *   5. 有到期行（`now >= retentionUntil`，闭区间） ⇒ `purge`／`PURGE_DUE`；
 *   6. 有未到期行 ⇒ `wait`／`WAITING_RETENTION`；
 *   7. 全是 `purged` 行 ⇒ `none`／`ALL_PURGED`（本次无事可做，不伪造新证据）；
 *   8. 空集 ⇒ `none`／`NO_COPIES`（**不是成功**）。
 *
 * @param {{ now: string | number | Date, copies: ReadonlyArray<BackupCopyRow> }} input
 * @returns {{ action: 'none' | 'wait' | 'purge' | 'blocked', dueCopies: ReadonlyArray<BackupCopyRow>, reason: string }}
 */
export function evaluateBackupPurge({ now, copies } = {}) {
  const nowMs = parseInstant(now);
  if (nowMs === null) {
    return makeResult('blocked', [], BACKUP_PURGE_REASONS.INPUT_INVALID);
  }
  if (!Array.isArray(copies)) {
    return makeResult('blocked', [], BACKUP_PURGE_REASONS.INPUT_INVALID);
  }

  const dueCopies = [];
  let failedRows = 0;
  let purgedRows = 0;
  let waitingRows = 0;

  for (const copy of copies) {
    if (copy === null || typeof copy !== 'object') {
      return makeResult('blocked', [], BACKUP_PURGE_REASONS.INPUT_INVALID);
    }
    const state = copy.state;
    if (!BACKUP_COPY_STATES.includes(state)) {
      return makeResult('blocked', [], BACKUP_PURGE_REASONS.INPUT_INVALID);
    }
    const untilMs = parseInstant(copy.retentionUntil);
    if (untilMs === null) {
      // 期限不可解析的副本**不得**被当作「未到期」跳过，也不得被当作「已到期」删掉。
      return makeResult('blocked', [], BACKUP_PURGE_REASONS.INPUT_INVALID);
    }
    if (state === 'failed') {
      failedRows += 1;
    } else if (state === 'purged') {
      purgedRows += 1;
    } else if (nowMs >= untilMs) {
      dueCopies.push(Object.freeze({ ...copy }));
    } else {
      waitingRows += 1;
    }
  }

  if (failedRows > 0) {
    return makeResult('blocked', [], BACKUP_PURGE_REASONS.COPY_FAILED);
  }
  if (dueCopies.length > 0) {
    return makeResult('purge', dueCopies, BACKUP_PURGE_REASONS.PURGE_DUE);
  }
  if (waitingRows > 0) {
    return makeResult('wait', [], BACKUP_PURGE_REASONS.WAITING_RETENTION);
  }
  if (purgedRows > 0) {
    return makeResult('none', [], BACKUP_PURGE_REASONS.ALL_PURGED);
  }
  return makeResult('none', [], BACKUP_PURGE_REASONS.NO_COPIES);
}

/**
 * @param {'none' | 'wait' | 'purge' | 'blocked'} action
 * @param {ReadonlyArray<BackupCopyRow>} dueCopies
 * @param {string} reason
 */
function makeResult(action, dueCopies, reason) {
  return Object.freeze({ action, dueCopies: Object.freeze(dueCopies), reason });
}
