/**
 * GY-I19（#19）· 删除任务「在线 7 日 / 备份 30 日」到期模块 —— **纯函数切片**。
 *
 * ## 本片只做一件事
 * 判定一个注销/删除请求在**在线**与**备份**两个阶段上是否已经到期，并据此给出
 * 「待办 / 到期 / 失败」三态。它**只计算、不执行**：不碰对象存储、不碰备份、不注册任何
 * HTTP 路由、不新增契约 operation，也不写任何状态（幂等、无副作用）。
 *
 * ## 复用既有协议，不另起一套
 * 期限与状态闭集**不在这里新定义**，而是复用 `packages/privacy`（GY-I27 已合并）：
 *   - 期限口径：`deletion.mjs` 的 `ONLINE_HOURS = 7×24`、`BACKUP_HOURS = 30×24`
 *     ⇒ 本模块的 `ONLINE_RETENTION_MS` / `BACKUP_RETENTION_MS` 与之逐毫秒一致
 *     （由 `tests/privacy/deletion-aging.test.mjs` 与 `createDeletionRegistry()` 交叉校验）；
 *   - 阶段状态闭集：`constants.mjs` 的 `HANDLER_STATES = pending|running|completed|blocked`
 *     （`onlineState`/`backupState` 的取值闭集）；
 *   - 失败码白名单：`deletion.mjs` 的 `SAFE_ERROR_CODES`（自由文本一律**不**透出，
 *     见下面「失败必须带可判别原因码」）。
 *
 * ## 期限口径（**上限**，不是必须保留满）+ 三条铁律
 * `docs/product-requirements.md` B18：「**在线个人记录及原始私有媒体 7 日内删除，备份 30 日内
 * 滚动清理**」—— 7 日 / 30 日是**期限上限（最晚完成时间）**，**不是**「必须保留满 7／30 天」。
 * 因此本模块把**到期（期限）**与**完成（事实）解耦**：
 *
 * 1. **完成任务不看时钟，只看事实**：`recordedState: 'completed'` 且**证据有效**（非空白）
 *    ⇒ `completed: true`，**无论是否到期** —— 期限内提前删完就是完成，必须如实返回；
 *    把它隐去会误导后续调度**延迟**删除。
 *    `is_due` / `online_due` / `backup_due` / `due_at` / `remaining_ms` 只表达**期限**，
 *    不表达「能不能完成」。
 * 2. **不得凭时钟判完成**：未执行（`pending`/`running`）或缺有效证据时 `completed` 一律
 *    `false` 并给出可判别原因码 —— 仍在期限内未完成 ⇒ `AGING_NOT_DUE`；
 *    已逾期未执行 ⇒ `AGING_DUE_NOT_EXECUTED` / `AGING_DUE_IN_PROGRESS`；
 *    报称完成但缺有效证据 ⇒ `AGING_DUE_NO_EVIDENCE`（与 `deletion.mjs` 的
 *    `EVIDENCE_REQUIRED` 同口径，**与是否到期无关**）。
 * 3. **失败必须带可判别原因码**：`completed === false` 时 `reason_code` **必非空**，
 *    便于区分「期限内没做完」「逾期了没做」「逾期了在做」「缺证据」「被阻塞」。
 *    来自既有协议白名单的失败码原样透出（可判别）；非白名单的自定义文本**折叠**为
 *    `AGING_PHASE_FAILED`，不把任意文本带进输出。
 *
 * ## 边界（第 7 日 / 第 30 日**当天**）—— 明确且写进代码
 * `due_at = requested_at + 7×24h`（在线）/ `+ 30×24h`（备份），**精确到毫秒**，
 * 判定采用**闭区间**：
 *   - `now === due_at` ⇒ **已到期**（第 7/30 日当天那一毫秒即到达期限）；
 *   - `now === due_at - 1ms` ⇒ 未到期（差一毫秒也仍在期限内）。
 * 期限只是上限：**当天之前删完同样算完成**，不存在「必须留到第 7/30 日」。`
 *
 * ## 幂等
 * 输出完全由入参决定（`now` 可注入；不注入时才取一次系统时间）。相同入参 ⇒ 逐字段相同，
 * 且**不修改入参**、不缓存、不落库。重复调用不产生第二次副作用（因为本模块本就没有副作用）。
 *
 * ## 未取得项（如实披露）
 * - 契约（`packages/contracts/**`）里没有对应 operation ⇒ **未自造任何路由/字段**，
 *   本文件是内部模块；`packages/contracts/**` 零改动。
 * - 不接任何真实第三方：本片没有任何外部调用，`real` 模式无从触发；备份清除端口仍属后续切片。
 * - `packages/privacy/**` 与 `services/api/src/privacy/**` 的**既有文件零改动**（只读消费）。
 */
import { HANDLER_STATES } from '../../../../packages/privacy/constants.mjs';
import { SAFE_ERROR_CODES } from '../../../../packages/privacy/deletion.mjs';

/** 在线保留期（日）；与 `deletion.mjs` 的 `ONLINE_HOURS = 7 * 24` 同口径。 */
export const ONLINE_RETENTION_DAYS = 7;
/** 备份保留期（日）；与 `deletion.mjs` 的 `BACKUP_HOURS = 30 * 24` 同口径。 */
export const BACKUP_RETENTION_DAYS = 30;
/** 一日的毫秒数（UTC 毫秒算术，不受夏令时影响）。 */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** 在线到期偏移（毫秒）= 7×24h。 */
export const ONLINE_RETENTION_MS = ONLINE_RETENTION_DAYS * MS_PER_DAY;
/** 备份到期偏移（毫秒）= 30×24h。 */
export const BACKUP_RETENTION_MS = BACKUP_RETENTION_DAYS * MS_PER_DAY;

/** 删除阶段（与 `onlineState` / `backupState` 一一对应）。 */
export type DeletionAgingPhase = 'online' | 'backup';

/** 三态：待办（未到期）/ 到期（可执行，是否完成另见 `completed`）/ 失败。 */
export type DeletionAgingState = 'pending' | 'due' | 'failed';

/** 既有协议 `HANDLER_STATES` 的取值（本模块只读消费，不重新定义）。 */
export type DeletionRecordedState = 'pending' | 'running' | 'completed' | 'blocked';

/**
 * 本模块**内部**的原因码（辨别"为什么没完成"用）。
 * 说明：这些不是契约错误码，**不会**进入任何用户回执/HTTP 响应；契约白名单内的失败码会
 * 原样出现在 `recorded_error_code` 与 `reason_code` 里（见 `SAFE_ERROR_CODES`）。
 */
const AGING_REASON_CODE_VALUES = {
  /** 仍在期限内、且该阶段尚未完成（**不是**「不得完成」；期限是上限）。 */
  NOT_DUE: 'AGING_NOT_DUE',
  /** 已逾期但该阶段尚未执行。 */
  DUE_NOT_EXECUTED: 'AGING_DUE_NOT_EXECUTED',
  /** 已逾期且该阶段正在执行中。 */
  DUE_IN_PROGRESS: 'AGING_DUE_IN_PROGRESS',
  /** 报称完成但**没有有效证据**（空白不算证据）⇒ 不得判完成（与是否到期无关）。 */
  DUE_NO_EVIDENCE: 'AGING_DUE_NO_EVIDENCE',
  /** 该阶段被阻塞（无白名单错误码可用）。 */
  PHASE_BLOCKED: 'AGING_PHASE_BLOCKED',
  /** 该阶段失败（有失败码但非白名单，或失败码缺失）。 */
  PHASE_FAILED: 'AGING_PHASE_FAILED',
  /** 入参不可信（时间/阶段/已记录状态非法，或请求时间晚于当前时间）—— fail-closed。 */
  INPUT_INVALID: 'AGING_INPUT_INVALID',
} as const;

export const AGING_REASON_CODES = Object.freeze(AGING_REASON_CODE_VALUES);

/** 内部原因码联合类型。 */
export type DeletionAgingReasonCode =
  (typeof AGING_REASON_CODE_VALUES)[keyof typeof AGING_REASON_CODE_VALUES];

/**
 * 严格的 ISO-8601 子集：**必须带时区**（`Z` 或 `±hh:mm`）。
 * 只接受这一形态是为了避免 `Date.parse` 对本地化/宽松串的解析差异，
 * 让"同一入参 ⇒ 同一结果"在跨机器上成立；不合形态一律 fail-closed。
 */
const ISO_8601_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** 入参：删除请求创建时间（ISO 串 / 毫秒时间戳 / Date）、阶段、可注入的当前时间。 */
export interface DeletionAgingInput {
  /** 删除请求创建时间（`requestedAt`）。 */
  requestedAt: string | number | Date;
  /** 要判定的阶段。 */
  phase: DeletionAgingPhase;
  /** 可注入的当前时间；不传则取一次系统时间（测试请显式传入）。 */
  now?: string | number | Date;
  /** 该阶段已记录的状态（既有协议 `HANDLER_STATES` 闭集）；缺省视为 `pending`。 */
  recordedState?: DeletionRecordedState | string | null;
  /** 该阶段已记录的完成证据引用；`completed` 必须带非空证据。 */
  evidenceRef?: string | null;
  /** 该阶段已记录的错误码（白名单 `SAFE_ERROR_CODES` 内才原样透出）。 */
  errorCode?: string | null;
}

/** 结果（纯数据；`JSON.stringify` 可安全用于测试比对，不含任何私有正文）。 */
export interface DeletionAgingResult {
  /** 被判定的阶段；入参阶段非法时为 `null`。 */
  readonly phase: DeletionAgingPhase | null;
  /** 删除请求创建时间（ISO）。 */
  readonly requested_at: string | null;
  /** 在线到期时刻（ISO）= requested_at + 7 日。 */
  readonly online_due_at: string | null;
  /** 备份到期时刻（ISO）= requested_at + 30 日。 */
  readonly backup_due_at: string | null;
  /** 本阶段到期时刻（ISO）。 */
  readonly due_at: string | null;
  /** 本次判定使用的当前时间（ISO）。 */
  readonly now: string | null;
  /** 在线阶段是否已到期（`now >= online_due_at`，闭区间）。 */
  readonly online_due: boolean;
  /** 备份阶段是否已到期（`now >= backup_due_at`，闭区间）。 */
  readonly backup_due: boolean;
  /** 本阶段是否已到期。 */
  readonly is_due: boolean;
  /** 三态（**窗口态**）：期限内待办 `pending` / 已到达期限 `due` / 失败 `failed`。
   * 注意：它不是「完成态」——是否完成只看 `completed`（与到期解耦）。 */
  readonly state: DeletionAgingState;
  /** 是否**已带有效证据完成**（`completed` 状态 + 非空白证据）。
   * **与是否到期解耦**：期限内提前删完同样为 `true`；未执行或缺证据恒为 `false`。 */
  readonly completed: boolean;
  /** 是否已终结（`completed` 或 `state === 'failed'`）。 */
  readonly settled: boolean;
  /** 未完成的**可判别**原因码；`completed === false` 时必非空。 */
  readonly reason_code: string | null;
  /** 既有协议白名单内透出的失败码；无则 `null`。 */
  readonly recorded_error_code: string | null;
  /** 距本阶段到期剩余毫秒（已到期为 0；入参非法为 `null`）。 */
  readonly remaining_ms: number | null;
  /** 诊断说明（不含任何私有内容）。 */
  readonly detail: string | null;
}

type InstantParse = { ok: true; ms: number } | { ok: false; detail: string };

/** 解析时刻：Date / 有限毫秒数 / 带时区的严格 ISO-8601 串；其余一律判不可用。 */
function parseInstant(value: unknown, label: string): InstantParse {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? { ok: true, ms } : { ok: false, detail: `${label} 是无效 Date` };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { ok: true, ms: value }
      : { ok: false, detail: `${label} 不是有限毫秒时间戳` };
  }
  if (typeof value === 'string') {
    if (!ISO_8601_STRICT.test(value)) {
      return { ok: false, detail: `${label} 不是带时区的严格 ISO-8601 串` };
    }
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? { ok: true, ms } : { ok: false, detail: `${label} 无法解析` };
  }
  return { ok: false, detail: `${label} 类型不支持（仅接受 ISO 串 / 毫秒时间戳 / Date）` };
}

/** 毫秒 → ISO；非有限值返回 `null`。 */
function toIso(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

/** 构造入参不可信时的 fail-closed 结果：**绝不** completed，且带可判别原因码。 */
function invalidInput(nowIso: string | null, detail: string): DeletionAgingResult {
  return Object.freeze({
    phase: null,
    requested_at: null,
    online_due_at: null,
    backup_due_at: null,
    due_at: null,
    now: nowIso,
    online_due: false,
    backup_due: false,
    is_due: false,
    state: 'failed' as const,
    completed: false,
    settled: true,
    reason_code: AGING_REASON_CODE_VALUES.INPUT_INVALID,
    recorded_error_code: null,
    remaining_ms: null,
    detail,
  });
}

/**
 * 计算一个删除请求的在线/备份到期时刻（**不含**任何"是否完成"的判断）。
 *
 * 幂等：`requested_at + 7×24h` / `+ 30×24h`，只依赖 `requestedAt`。
 * 入参非法时抛错（调用方若要用"不可信入参不得静默通过"，请直接用 `evaluateDeletionAging`，
 * 它会 fail-closed 成 `AGING_INPUT_INVALID` 而不是抛错）。
 */
export function deletionAgingDeadlines(
  requestedAt: string | number | Date,
): { requested_at: string; online_due_at: string; backup_due_at: string } {
  const parsed = parseInstant(requestedAt, 'requestedAt');
  if (!parsed.ok) throw new Error(`deletionAgingDeadlines 入参非法：${parsed.detail}`);
  const requestedIso = new Date(parsed.ms).toISOString();
  return Object.freeze({
    requested_at: requestedIso,
    online_due_at: toIso(parsed.ms + ONLINE_RETENTION_MS) as string,
    backup_due_at: toIso(parsed.ms + BACKUP_RETENTION_MS) as string,
  });
}

/**
 * 判定某阶段（在线 / 备份）的到期与三态。
 *
 * 返回值恒为冻结对象；`completed: false` 时 `reason_code` 必非空（见文件头三条铁律）。
 * 相同入参（含显式 `now`）⇒ 逐字段相同；不修改入参。
 */
export function evaluateDeletionAging(input: DeletionAgingInput): DeletionAgingResult {
  const nowParsed = parseInstant(input?.now === undefined ? new Date() : input.now, 'now');
  const nowIso = nowParsed.ok ? new Date(nowParsed.ms).toISOString() : null;

  const requestedParsed = parseInstant(input?.requestedAt, 'requestedAt');
  const phase = input?.phase;
  const phaseValid = phase === 'online' || phase === 'backup';

  const recordedRaw = input?.recordedState ?? 'pending';
  const recordedValid = typeof recordedRaw === 'string' && HANDLER_STATES.includes(recordedRaw);

  if (!requestedParsed.ok || !nowParsed.ok || !phaseValid || !recordedValid) {
    const detail = [
      requestedParsed.ok ? null : requestedParsed.detail,
      nowParsed.ok ? null : nowParsed.detail,
      phaseValid ? null : 'phase 必须是 online 或 backup',
      recordedValid ? null : `recordedState 不在既有协议闭集内：${String(recordedRaw)}`,
    ]
      .filter((item): item is string => item !== null)
      .join('；');
    return invalidInput(nowIso, detail);
  }

  // 请求创建时间晚于当前时间 ⇒ 入参不可信（fail-closed，不猜、不夹取）。
  if (requestedParsed.ms > nowParsed.ms) {
    return invalidInput(nowIso, 'requestedAt 晚于 now：时间线不可信');
  }

  const evidence = typeof input?.evidenceRef === 'string' ? input.evidenceRef.trim() : '';
  const rawErrorCode = typeof input?.errorCode === 'string' ? input.errorCode.trim() : '';
  // 只透出既有协议白名单内的失败码；其余自定义文本一律折叠，不带进输出。
  const whitelistedErrorCode =
    rawErrorCode.length > 0 && SAFE_ERROR_CODES.includes(rawErrorCode) ? rawErrorCode : null;
  const hasFailureSignal = recordedRaw === 'blocked' || rawErrorCode.length > 0;

  const requestedMs = requestedParsed.ms;
  const nowMs = nowParsed.ms;
  const onlineDueMs = requestedMs + ONLINE_RETENTION_MS;
  const backupDueMs = requestedMs + BACKUP_RETENTION_MS;
  const onlineDue = nowMs >= onlineDueMs;
  const backupDue = nowMs >= backupDueMs;
  const dueMs = phase === 'online' ? onlineDueMs : backupDueMs;
  // 边界：闭区间。now === dueMs ⇒ 已到期（第 7/30 日当天那一刻即到期）；差 1ms 则未到期。
  const isDue = nowMs >= dueMs;

  let state: DeletionAgingState;
  let completed = false;
  let reasonCode: string;
  let recordedErrorCode: string | null = null;
  let detail: string | null = null;

  if (hasFailureSignal) {
    state = 'failed';
    recordedErrorCode = whitelistedErrorCode;
    if (whitelistedErrorCode !== null) {
      // 白名单内的既有失败码：可判别，原样透出。
      reasonCode = whitelistedErrorCode;
      detail = `阶段 ${phase} 已记录失败（既有协议白名单错误码）`;
    } else if (rawErrorCode.length > 0) {
      // 有失败码但不在白名单：折叠为固定分类，**不透出原文**（避免任意文本进输出）。
      reasonCode = AGING_REASON_CODE_VALUES.PHASE_FAILED;
      detail = `阶段 ${phase} 带非白名单错误码，已折叠为固定分类（不透出原文）`;
    } else {
      // 无任何错误码可用：仍给出可辨别的固定分类。
      reasonCode = AGING_REASON_CODE_VALUES.PHASE_BLOCKED;
      detail = `阶段 ${phase} 已记录 blocked，且无白名单错误码可用`;
    }
  } else if (recordedRaw === 'completed' && evidence.length > 0) {
    // **完成看事实、不看时钟**：期限内提前删完 + 有效证据 ⇒ 如实判完成。
    // 7 日 / 30 日是期限**上限**，不是必须保留满的时长；把提前完成隐去会误导调度延迟删除。
    completed = true;
    state = isDue ? 'due' : 'pending'; // 窗口态只反映期限，不反映完成。
    reasonCode = ''; // 无：completed 时 reason_code 为 null。
    detail = null;
  } else if (recordedRaw === 'completed') {
    // 报称完成但**缺有效证据**（空白不算证据）⇒ 不得判完成（与是否到期无关）。
    state = isDue ? 'due' : 'pending';
    reasonCode = AGING_REASON_CODE_VALUES.DUE_NO_EVIDENCE;
    detail = `阶段 ${phase} 报称完成但缺有效证据，不得判完成（证据是完成的必要条件）`;
  } else if (!isDue) {
    // 仍在期限内、尚未完成 ⇒ 如实报「期限内待办」；**不是**「不得完成」。
    state = 'pending';
    reasonCode = AGING_REASON_CODE_VALUES.NOT_DUE;
    detail = `阶段 ${phase} 仍在期限内且尚未完成（期限是上限；未到期 ≠ 不得完成）`;
  } else if (recordedRaw === 'running') {
    state = 'due';
    reasonCode = AGING_REASON_CODE_VALUES.DUE_IN_PROGRESS;
    detail = `阶段 ${phase} 已逾期、执行中`;
  } else {
    state = 'due';
    reasonCode = AGING_REASON_CODE_VALUES.DUE_NOT_EXECUTED;
    detail = `阶段 ${phase} 已逾期、尚未执行`;
  }

  const settled = completed || state === 'failed';

  return Object.freeze({
    phase,
    requested_at: new Date(requestedMs).toISOString(),
    online_due_at: toIso(onlineDueMs),
    backup_due_at: toIso(backupDueMs),
    due_at: toIso(dueMs),
    now: new Date(nowMs).toISOString(),
    online_due: onlineDue,
    backup_due: backupDue,
    is_due: isDue,
    state,
    completed,
    settled,
    // completed === false ⇒ reason_code 必非空（铁律 2）。
    reason_code: completed ? null : reasonCode,
    recorded_error_code: recordedErrorCode,
    remaining_ms: Math.max(0, dueMs - nowMs),
    detail,
  });
}
