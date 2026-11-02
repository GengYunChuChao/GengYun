/**
 * GY-R73（P2-c）· 第三方删除**写侧**：注销受理链 → 端口写侧的**唯一**调用点。
 *
 * ## 本片补的洞
 * `docs/architecture/gy-r59-retention-backup-thirdparty-map.md:95` 与 `:140` 记着一句
 * 「`subscribeThirdPartyDeletion` 仍零调用者，注销受理链还不调用它」——库层（迁移 `0044` 的两条
 * `SECURITY DEFINER` 函数）、端口层（`third-party-deletion-pg.ts`）、回执投影
 * （`third-party-deletion-projection.ts`）三层都在，唯独**没人写**：`third_party_deletions`
 * 永远没有一行，回执的 `third_party_state` 只能是 `null`。本文件就是那一个写点。
 *
 * ## 三条硬约束（每条都有用例钉住）
 *  1. **不伪造接收方**：收件人来源（`recipients`）只支持**注入**。今天生产没有这个来源 ⇒
 *     `dispatch()` 一条也不写、`reason: 'RECIPIENTS_UNWIRED'`。⛔ 不许为了让测试好看而硬编码
 *     接收方名单（那是把"没有第三方"写成"已通知第三方"）。
 *  2. **fail-open**：任何写失败/读失败/适配器异常都**不抛**——计数进 `readings`、外发一条
 *     `third_party_deletion_write_failed` 事件，注销受理链照常走完。口径与
 *     `services/api/src/privacy/task-egress.ts:341` 一致（缺省出口 `console.warn(JSON.stringify(event))`，
 *     「写不进库是记账的问题，不是注销的问题」）。⚠ 但**不许静默**：`readings` / `lastResult()`
 *     永远带着这次为什么没写（装配层把它们透出成 `userDataDeletion.thirdPartyWrites`）。
 *  3. **幂等 + 终态不回退**：写前先读现状（`listThirdPartyDeletions()`）。
 *     `confirmed` / `unsupported` 是终态（`0044:225-245` 的 `DO UPDATE … WHERE` 单调守卫，
 *     ⇒ `G0003`）⇒ 跳过，一条不写；`requested` 说明已经发过 ⇒ 跳过（不重复外发、也不刷新
 *     `requested_at`，`0044:210` 的 `COALESCE` 已保证）；只有**没有行**才写 `requested`，
 *     只有 **`failed`** 才直接重发（`failed` 不是终态，可被后续 `confirmed` 覆盖）。
 *     ⛔ 绝不用 `requested` 盖掉 `failed`：库层允许（守卫只挡终态），产品口径不认这个回退。
 *
 * ## 状态从哪来（每一步都有出处，没有一处是猜的）
 *   - `requested` ⇒ 本层在**发起**外发之前写（不是收到回执之后）；
 *   - `confirmed` ⇒ 只接受适配器 `status === 'confirmed'` **且** `evidence_ref` 非空；
 *     拿不到证据 ⇒ 写 `failed` + `EVIDENCE_REQUIRED`（⛔ 不允许"先 confirmed 后补证据"，
 *     `third_party_confirmed_evidence` 也拦不住分两步写）；
 *   - `failed` / `unsupported` ⇒ 适配器的同名结论；`unavailable`（没凭据/没接线，压根没发出去）
 *     ⇒ 记 `failed` + `OBJECT_UNAVAILABLE`（如实"没送达"，且 `failed` 可被后续 `confirmed` 覆盖）。
 *
 * ## 只读一次、只读一份
 * 本层**只**经端口（`0044` 的读函数）判定现状，不读进程内协议账本：`refreshOnlineStates()` /
 * `refreshBackupStates()` 与回执投影读的也是同一份持久行，否则会出现"两本账各说各话"。
 */

import type {
  ThirdPartyDeletionAdapter,
  ThirdPartyDeletionDispatchResult as ThirdPartyAdapterOutcome,
} from './third-party-deletion-adapter.ts';
import type {
  ThirdPartyDeletionPort,
  ThirdPartyDeletionRecord,
  ThirdPartyDeletionWriteInput,
  WritableThirdPartyDeletionState,
} from './third-party-deletion-pg.ts';

/** 库层终态（`0044:225-245`：这两态之后任何不同内容的重放 ⇒ `G0003`）。 */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['confirmed', 'unsupported']);

/** 已发请求态（`requested_at` 首次写定后不再刷新）。 */
const REQUESTED_STATE = 'requested';

/** 失败态（非终态：可被后续 `confirmed` 覆盖，也是本层唯一"允许重发"的现状）。 */
const FAILED_STATE = 'failed';

/** 适配器说 confirmed 却没给证据时，写进库的确定性原因码（⛔ 不写 confirmed）。 */
export const THIRD_PARTY_EVIDENCE_REQUIRED = 'EVIDENCE_REQUIRED';

/** 适配器 `unavailable`（无凭据/未接线 ⇒ 压根没发出去）落库时的原因码。 */
export const THIRD_PARTY_UNAVAILABLE_CODE = 'OBJECT_UNAVAILABLE';

/** 适配器抛错/未知结论的兜底原因码（与 `third-party-deletion-adapter.ts` 同字面量）。 */
export const THIRD_PARTY_FAILED_CODE = 'THIRD_PARTY_FAILED';

/** 一个接收方（`exportRef` 省略＝整账号面，走 `0044` 的 `(request_id, recipient_id)` 唯一索引）。 */
export interface ThirdPartyDeletionRecipient {
  /** 接收方标识（≤80 字符；外部系统侧的名字/ID，本层只透传、不做映射）。 */
  recipientId: string;
  /**
   * 关联导出物 uuid。整账号注销链**没有**导出物 ⇒ 恒 `null`（不是"待补"，是这条路真的不产生导出）。
   * 给了非 uuid ⇒ 端口层 400、这里按写失败处理（fail-open，不影响注销）。
   */
  exportRef?: string | null;
}

/**
 * 收件人来源（**注入点**）。本期仓内没有任何实现——`recipients` 表是管理表（`0003`），
 * 但"某次注销该通知哪些接收方"这一步产品口径尚未裁定（见设计 §4 的开口）。
 * 因此本接口只声明形状，装配层不传 ⇒ `RECIPIENTS_UNWIRED` ⇒ 一条也不写。
 */
export interface ThirdPartyDeletionRecipientSource {
  listRecipients(input: {
    requestId: string;
    userId: string;
  }): readonly ThirdPartyDeletionRecipient[] | Promise<readonly ThirdPartyDeletionRecipient[]>;
}

/** 写侧读数（`⛔` 不暴露给 HTTP 面；只给装配层/测试取证）。 */
export interface ThirdPartyDeletionWriteReadings {
  /** 真的走到适配器的条数（"发出去了"的条数，与落库成功与否无关）。 */
  dispatched: number;
  /** 落库成功且为 `confirmed` 的条数。 */
  confirmed: number;
  /** 落库成功且为 `failed` 的条数（含 `EVIDENCE_REQUIRED` / `OBJECT_UNAVAILABLE`）。 */
  failed: number;
  /** 落库成功且为 `unsupported` 的条数。 */
  unsupported: number;
  /** 因终态 / 已请求而跳过的条数（幂等读数：重复 dispatch 时它递增、其余不增）。 */
  skipped: number;
  /** 持久侧失败次数（写失败 + 读失败都算：两者都说明"这本账现在写不进去"）。 */
  writeFailures: number;
  /** 最近一次持久侧失败的安全码（不含驱动原文）。 */
  lastError: string | null;
}

/**
 * 本次 dispatch 为什么是这个结果。`OK` = 至少写成一笔且无失败；
 * 其余都是"如实没写/没写完"的原因（⛔ 没有一个分支会把没写当成写成功）。
 */
export type ThirdPartyDeletionDispatchReason =
  | 'OK'
  | 'NO_RECIPIENTS'
  | 'RECIPIENTS_UNWIRED'
  | 'RECIPIENTS_FAILED'
  | 'WRITE_PORT_UNWIRED'
  | 'ADAPTER_UNWIRED'
  | 'ADAPTER_UNAVAILABLE'
  | 'READ_FAILED'
  /** 有接收方、也发了，但至少一笔**落库失败**（fail-open：注销照常，账没记全）。 */
  | 'WRITE_FAILED'
  | 'DISPATCH_FAILED';

/** 逐条明细（不含正文/凭据；只含标识、状态与跳过原因）。 */
export interface ThirdPartyDeletionDispatchRow {
  recipientId: string;
  exportRef: string | null;
  /** 本次是否真的向对方发起过（`false` ⇒ 跳过或没写成）。 */
  dispatched: boolean;
  /** 本次**落库成功**的状态；`null` ⇒ 这次没写成任何状态。 */
  state: WritableThirdPartyDeletionState | null;
  /** 跳过原因（`dispatched === false` 且不是写失败时才有值）。 */
  skipped: 'terminal' | 'already_requested' | null;
  /** 落库失败（fail-open：已计数 + 已记事件，调用方无需处理）。 */
  writeFailed: boolean;
}

/** 一次 dispatch 的结论（诊断用；不出契约）。 */
export interface ThirdPartyDeletionDispatchResult {
  requestId: string;
  reason: ThirdPartyDeletionDispatchReason;
  /** 归一后的接收方条数（去重后；`0` ⇒ 这次确实没有接收方）。 */
  recipients: number;
  rows: readonly ThirdPartyDeletionDispatchRow[];
}

export interface ThirdPartyDeletionDispatcher {
  /** 累计读数（活对象：每次 dispatch 就地累加）。 */
  readonly readings: ThirdPartyDeletionWriteReadings;
  /** 受理链调用它；**永不抛**（任何异常都折叠成 `DISPATCH_FAILED` + 计数）。 */
  dispatch(input: { requestId: string; userId: string }): Promise<ThirdPartyDeletionDispatchResult>;
  /** 最近一次 dispatch 的结论（`null` ⇒ 还没调用过）。 */
  lastResult(): ThirdPartyDeletionDispatchResult | null;
}

export interface ThirdPartyDeletionDispatcherDeps {
  /**
   * 写端口。`null` ⇒ 写侧未接线（`unwired` / `unavailable` 读侧端口都没有写方法）：
   * 照样返回 `WRITE_PORT_UNWIRED`，⛔ 不假装写过。
   */
  port: ThirdPartyDeletionPort | null;
  /** 外发适配器。`null`（今天的生产装配）⇒ `ADAPTER_UNWIRED`，一条也不写。 */
  adapter: ThirdPartyDeletionAdapter | null;
  /** 收件人来源。不传 ⇒ `RECIPIENTS_UNWIRED`（今天的生产装配），一条也不写。 */
  recipients?: ThirdPartyDeletionRecipientSource | null;
  now?: () => Date;
  /** 观测出口（缺省进 stderr）；**不得**抛错，本层对它也做了兜底。 */
  log?: (event: Record<string, unknown>) => void;
}

/**
 * 从**读侧端口**上探测写方法。
 *
 * 为什么是探测而不是新增一个装配参数：`app.ts` 在本片的锚点面上**必须净 0 行改动**（三套基线
 * 按行号比对），而真库读写本来就是**同一个对象**（`createPostgresThirdPartyDeletionPort()`
 * 同时返回 `listThirdPartyDeletions()` 与 `subscribeThirdPartyDeletion()`）。
 * `unwired` / `unavailable` 端口没有写方法 ⇒ 如实判"写侧未接线"，⛔ 不补一个假写方法。
 */
export function writePortOf(readPort: unknown): ThirdPartyDeletionPort | null {
  if (readPort === null || typeof readPort !== 'object') return null;
  const candidate = readPort as Partial<ThirdPartyDeletionPort>;
  return typeof candidate.subscribeThirdPartyDeletion === 'function' ? (candidate as ThirdPartyDeletionPort) : null;
}

/** 安全码：只取 `code`（契约错误码），绝不把驱动原文写进观测。 */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoOf(value: unknown, fallback: string): string {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  return fallback;
}

/** `(recipientId, exportRef)` 的复合键（`exportRef` 为 `null` 时是另一条唯一索引，必须分开）。 */
function keyOf(recipientId: string, exportRef: string | null): string {
  return `${recipientId}\u0000${exportRef ?? ''}`;
}

/**
 * 创建写侧派发器。
 *
 * 调用点约定（本片只有一处）：注销受理链在**级联处理器跑完之后**调用一次——那时
 * `request_id` 已在库（`deletion_requests` 有行，`0044` 的外键才不会 `G0002`）、主体已绑定。
 */
export function createThirdPartyDeletionDispatcher(
  deps: ThirdPartyDeletionDispatcherDeps,
): ThirdPartyDeletionDispatcher {
  const now = deps.now ?? (() => new Date());
  const port = deps.port ?? null;
  const adapter = deps.adapter ?? null;
  const recipients = deps.recipients ?? null;
  const emit =
    deps.log ??
    ((event: Record<string, unknown>) => {
      console.warn(JSON.stringify(event));
    });

  const readings: ThirdPartyDeletionWriteReadings = {
    dispatched: 0,
    confirmed: 0,
    failed: 0,
    unsupported: 0,
    skipped: 0,
    writeFailures: 0,
    lastError: null,
  };
  let last: ThirdPartyDeletionDispatchResult | null = null;
  /** 装配缺口的日志只报一次（配置运行期不变；⛔ 不为每次注销刷一条同样的 warn）。 */
  const notedGaps = new Set<string>();

  /** 记一笔事件；出口抛错也不许打断调用方（这里自己吞掉并留下读数）。 */
  function note(event: Record<string, unknown>): void {
    try {
      emit(event);
    } catch {
      // 观测出口坏了是观测的问题：断链在这里，不影响注销，也不再伪造第二次事件。
    }
  }

  function notePersistenceFailure(input: {
    event: string;
    requestId: string;
    recipientId?: string;
    state?: string;
    error: unknown;
  }): void {
    const code = codeOf(input.error);
    readings.writeFailures += 1;
    readings.lastError = code;
    note({
      event: input.event,
      request_id: input.requestId,
      ...(input.recipientId === undefined ? {} : { recipient_id: input.recipientId }),
      ...(input.state === undefined ? {} : { state: input.state }),
      code,
    });
  }

  function noteGapOnce(reason: ThirdPartyDeletionDispatchReason, detail: Record<string, unknown>): void {
    if (notedGaps.has(reason)) return;
    notedGaps.add(reason);
    note({ event: 'third_party_deletion_dispatch_unwired', reason, ...detail });
  }

  /** 归一 + 去重 + 丢掉非法项（空/超 80 字符的 `recipientId`、非字符串的 `exportRef`）。 */
  function normalize(source: readonly ThirdPartyDeletionRecipient[]): ThirdPartyDeletionRecipient[] {
    const seen = new Set<string>();
    const out: ThirdPartyDeletionRecipient[] = [];
    for (const item of Array.isArray(source) ? source : []) {
      const recipientId = (item as { recipientId?: unknown } | null)?.recipientId;
      if (!isNonEmptyString(recipientId) || recipientId.length > 80) continue;
      const rawExport = (item as { exportRef?: unknown }).exportRef;
      const exportRef = rawExport === null || rawExport === undefined ? null : typeof rawExport === 'string' ? rawExport : null;
      const key = keyOf(recipientId, exportRef);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ recipientId, exportRef });
    }
    return out;
  }

  /** 适配器结论 → 库层可写**结论**态（`requested` 不在此列：它只由本层在发起前写）。⛔ confirmed 没有证据就**不是** confirmed。 */
  function stateOf(outcome: ThirdPartyAdapterOutcome): {
    state: 'confirmed' | 'failed' | 'unsupported';
    evidenceRef: string | null;
    errorCode: string | null;
  } {
    switch (outcome.status) {
      case 'confirmed':
        return isNonEmptyString(outcome.evidence_ref)
          ? { state: 'confirmed', evidenceRef: outcome.evidence_ref, errorCode: null }
          : { state: 'failed', evidenceRef: null, errorCode: THIRD_PARTY_EVIDENCE_REQUIRED };
      case 'unsupported':
        return { state: 'unsupported', evidenceRef: null, errorCode: outcome.error_code ?? null };
      case 'unavailable':
        // 压根没发出去（无凭据/未接线）：如实记"没送达"，且 failed 可被后续 confirmed 覆盖。
        return { state: 'failed', evidenceRef: null, errorCode: outcome.error_code ?? THIRD_PARTY_UNAVAILABLE_CODE };
      case 'failed':
      default:
        return { state: 'failed', evidenceRef: null, errorCode: outcome.error_code ?? THIRD_PARTY_FAILED_CODE };
    }
  }

  async function run(input: { requestId: string; userId: string }): Promise<ThirdPartyDeletionDispatchResult> {
    const result: ThirdPartyDeletionDispatchResult = {
      requestId: input.requestId,
      reason: 'OK',
      recipients: 0,
      rows: [],
    };
    const rows: ThirdPartyDeletionDispatchRow[] = [];
    const finish = (reason: ThirdPartyDeletionDispatchReason): ThirdPartyDeletionDispatchResult => {
      const final: ThirdPartyDeletionDispatchResult = { ...result, reason, rows };
      last = final;
      return final;
    };

    // ① 装配缺口：如实说明为什么一条也不写（今天的生产就走这三条之一）。
    if (port === null) {
      noteGapOnce('WRITE_PORT_UNWIRED', { request_id: input.requestId });
      return finish('WRITE_PORT_UNWIRED');
    }
    if (adapter === null) {
      noteGapOnce('ADAPTER_UNWIRED', { request_id: input.requestId });
      return finish('ADAPTER_UNWIRED');
    }
    if (adapter.available !== true) {
      noteGapOnce('ADAPTER_UNAVAILABLE', { request_id: input.requestId, code: THIRD_PARTY_UNAVAILABLE_CODE });
      return finish('ADAPTER_UNAVAILABLE');
    }
    if (recipients === null) {
      noteGapOnce('RECIPIENTS_UNWIRED', { request_id: input.requestId });
      return finish('RECIPIENTS_UNWIRED');
    }

    // ② 收件人：来源给什么就是什么（空 ⇒ 没有接收方，⛔ 不补默认名单）。
    let listed: readonly ThirdPartyDeletionRecipient[];
    try {
      listed = await recipients.listRecipients({ requestId: input.requestId, userId: input.userId });
    } catch (error) {
      notePersistenceFailure({ event: 'third_party_deletion_recipients_failed', requestId: input.requestId, error });
      return finish('RECIPIENTS_FAILED');
    }
    const targets = normalize(listed);
    result.recipients = targets.length;
    if (targets.length === 0) return finish('NO_RECIPIENTS');

    // ③ 现状：读不到就不发（"可能已经发过"比"重复外发"更不可接受）。
    let existing: readonly ThirdPartyDeletionRecord[];
    try {
      existing = await port.listThirdPartyDeletions(input.requestId);
    } catch (error) {
      notePersistenceFailure({ event: 'third_party_deletion_read_failed', requestId: input.requestId, error });
      return finish('READ_FAILED');
    }
    const byKey = new Map<string, ThirdPartyDeletionRecord>();
    for (const row of Array.isArray(existing) ? existing : []) {
      byKey.set(keyOf(row.recipientId, row.exportRef ?? null), row);
    }

    const writePort = port;
    async function writeState(payload: ThirdPartyDeletionWriteInput): Promise<boolean> {
      try {
        await writePort.subscribeThirdPartyDeletion(payload);
        return true;
      } catch (error) {
        notePersistenceFailure({
          event: 'third_party_deletion_write_failed',
          requestId: payload.requestId,
          recipientId: payload.recipientId,
          state: payload.state,
          error,
        });
        return false;
      }
    }

    for (const target of targets) {
      const exportRef = target.exportRef ?? null;
      const current = byKey.get(keyOf(target.recipientId, exportRef));
      const row: ThirdPartyDeletionDispatchRow = {
        recipientId: target.recipientId,
        exportRef,
        dispatched: false,
        state: null,
        skipped: null,
        writeFailed: false,
      };

      // ④ 终态 / 已请求 ⇒ 跳过（幂等与"不回退"的全部机关就在这两行判断里）。
      if (current !== undefined && (TERMINAL_STATES.has(current.onlineState) || TERMINAL_STATES.has(current.backupState))) {
        readings.skipped += 1;
        rows.push({ ...row, skipped: 'terminal' });
        continue;
      }
      if (
        current !== undefined &&
        (current.onlineState === REQUESTED_STATE || current.backupState === REQUESTED_STATE)
      ) {
        readings.skipped += 1;
        rows.push({ ...row, skipped: 'already_requested' });
        continue;
      }

      // ⑤ 先写 requested（只有"没有行"才写；failed 直接重发，⛔ 不用 requested 盖掉 failed）。
      if (current === undefined) {
        const wrote = await writeState({
          requestId: input.requestId,
          recipientId: target.recipientId,
          exportRef,
          state: 'requested',
          evidenceRef: null,
          errorCode: null,
          at: now().toISOString(),
        });
        if (!wrote) {
          rows.push({ ...row, writeFailed: true });
          continue;
        }
        row.state = 'requested';
      }

      // ⑥ 外发一次（适配器自己保证"单接收方单次调用"；它抛错也折成 failed，不中断后面的人）。
      let outcome: ThirdPartyAdapterOutcome;
      try {
        outcome = await adapter.dispatch({ requestId: input.requestId, recipientId: target.recipientId, exportRef });
      } catch (error) {
        note({
          event: 'third_party_deletion_adapter_failed',
          request_id: input.requestId,
          recipient_id: target.recipientId,
          code: codeOf(error),
        });
        outcome = {
          status: 'failed',
          completed: false,
          error_code: THIRD_PARTY_FAILED_CODE,
          evidence_ref: null,
          duration_ms: null,
          attempted_at: null,
        };
      }
      readings.dispatched += 1;
      row.dispatched = true;

      // ⑦ 落结论（confirmed 必须与证据同一次写齐）。
      const mapped = stateOf(outcome);
      const wrote = await writeState({
        requestId: input.requestId,
        recipientId: target.recipientId,
        exportRef,
        state: mapped.state,
        evidenceRef: mapped.evidenceRef,
        errorCode: mapped.errorCode,
        at: isoOf(outcome.attempted_at, now().toISOString()),
      });
      if (wrote) {
        readings[mapped.state] += 1;
        row.state = mapped.state;
      } else {
        row.writeFailed = true;
      }
      rows.push(row);
    }

    return finish(rows.some((row) => row.writeFailed) ? 'WRITE_FAILED' : 'OK');
  }

  return {
    readings,
    lastResult: () => last,
    async dispatch(input) {
      try {
        return await run(input);
      } catch (error) {
        // 兜底：⛔ 写侧的任何问题都不许穿过注销受理链。
        notePersistenceFailure({ event: 'third_party_deletion_dispatch_failed', requestId: input.requestId, error });
        const fallback: ThirdPartyDeletionDispatchResult = {
          requestId: input.requestId,
          reason: 'DISPATCH_FAILED',
          recipients: 0,
          rows: [],
        };
        last = fallback;
        return fallback;
      }
    },
  };
}
