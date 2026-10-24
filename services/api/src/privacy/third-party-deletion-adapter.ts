/**
 * GY-I19（#19）片 E · 第三方删除适配器**接线框架**（默认关闭、无凭据 fail-closed）。
 *
 * ## 本片补的空白（相对第 2 步投影）
 * 第 2 步 `third-party-deletion-projection.ts` 只做**投影**（只读消费既有协议行），
 * 全仓没有任何**真实第三方删除适配器**。本片补「适配器接口 + 默认关闭装配」：
 *   - 有凭据时：经注入点（`fetch`）对单个接收方**单次**调用，登记**脱敏**证据
 *     （requestId / 耗时 / 状态），绝不把凭据、正文或供应商原文写进观测。
 *   - 无凭据（或未注入 `fetch`）时：一律 **fail-closed** —— 不发出任何调用、
 *     不写任何状态、返回 `OBJECT_UNAVAILABLE`，**绝不声称删除已完成**。
 *
 * ## 红线（本片硬边界）
 *   - **不写密钥**：凭据是**不透明**对象（`ThirdPartyDeletionCredentials`），本框架只判「有无」，
 *     绝不读其内容、绝不序列化进任何观测/日志/审计条目。
 *   - **不真的外呼**：真实网络调用由装配方注入的 `fetch` 承担；本框架**只经注入点**单次调用它，
 *     自身不发任何 socket / HTTP 请求。无凭据时连 `fetch` 都不会被调。
 *   - **不回退替身**：无凭据/未接线 ⇒ `unavailable`，**不得**用「假成功」封套冒充；
 *     与 `egress.ts` 的 real fail-closed 同口径（real 未接真实适配器 ⇒ 不派发）。
 *   - **永不假装已验收**：`completed === true` 只可能来自「注入的 `fetch` 明确回报已删除
 *     且给出非空可核验回执引用」；缺证据 / `not_found` / `unsupported` / 未知状态 ⇒ 一律不完成。
 *
 * ## 接线方式（装配方按此；本片不改他人已合并的路由/协议文件）
 * ```
 * const adapter = createThirdPartyDeletionAdapter({ credentials, fetch: realVendorFetch, now, logSink });
 * if (!adapter.available) {
 *   // 无凭据/未接线 ⇒ 上层如实 409 OBJECT_UNAVAILABLE，不确认删除。
 * }
 * const outcome = await adapter.dispatch({ requestId, recipientId, exportRef });
 * // 仅 outcome.status === 'confirmed' 时，调用方才 coordinator.confirmThirdPartyDeletion({ evidenceRef: outcome.evidence_ref })
 * ```
 */

/** 第三方删除的可判别、已脱敏结果状态（与投影三态对齐，外加 fail-closed 的 unavailable）。 */
export type ThirdPartyDeletionOutcomeStatus = 'confirmed' | 'failed' | 'unsupported' | 'unavailable';

/** 结果状态闭集。 */
export const THIRD_PARTY_DELETION_OUTCOME_STATES: readonly ThirdPartyDeletionOutcomeStatus[] = Object.freeze([
  'confirmed',
  'failed',
  'unsupported',
  'unavailable',
]);

/** 无凭据 / 未接线时的确定性关闭错误码（契约 409 OBJECT_UNAVAILABLE）。 */
export const THIRD_PARTY_DELETION_UNAVAILABLE_CODE = 'OBJECT_UNAVAILABLE';

/** 供应商回执状态闭集（注入的 `fetch` 只允许回报这四个值）。 */
export type ThirdPartyDeletionFetchStatus = 'deleted' | 'not_found' | 'unsupported' | 'failed';

/** 供应商回执状态闭集。 */
export const THIRD_PARTY_DELETION_FETCH_STATUSES: readonly ThirdPartyDeletionFetchStatus[] = Object.freeze([
  'deleted',
  'not_found',
  'unsupported',
  'failed',
]);

/** 第三方删除凭据（**不透明**）：框架只判「有无」，绝不读内容、绝不落观测。 */
export interface ThirdPartyDeletionCredentials {
  readonly [key: string]: unknown;
}

/** 注入的删除调用入参。 */
export interface ThirdPartyDeletionFetchInput {
  requestId: string;
  recipientId: string;
  exportRef: string | null;
  credentials: ThirdPartyDeletionCredentials;
}

/** 注入的删除调用回执（**只允许闭集状态 + 可选回执引用**，不含正文/凭据）。 */
export interface ThirdPartyDeletionFetchResult {
  status: ThirdPartyDeletionFetchStatus;
  reference?: string | null;
}

/** 第三方删除外发调用（**注入点**）：真实网络调用由装配方提供。 */
export type ThirdPartyDeletionFetch = (input: ThirdPartyDeletionFetchInput) => Promise<ThirdPartyDeletionFetchResult>;

/** 脱敏证据条目：只含 requestId/接收方/状态/耗时/尝试时间，**不含凭据、正文、回执引用**。 */
export interface ThirdPartyDeletionEvidence {
  readonly request_id: string;
  readonly recipient_id: string;
  readonly status: ThirdPartyDeletionOutcomeStatus;
  readonly completed: boolean;
  readonly error_code: string | null;
  readonly duration_ms: number | null;
  readonly attempted_at: string | null;
}

/** 单次派发结果（调用方据此决定 confirm/fail/markUnsupported；**不得**据此替身成功）。 */
export interface ThirdPartyDeletionDispatchResult {
  readonly status: ThirdPartyDeletionOutcomeStatus;
  readonly completed: boolean;
  readonly error_code: string | null;
  /** 仅 `confirmed` 时非空：供应商可核验回执引用（供 confirmThirdPartyDeletion 登记，不进观测）。 */
  readonly evidence_ref: string | null;
  readonly duration_ms: number | null;
  readonly attempted_at: string | null;
}

/** 第三方删除适配器（装配产物）。 */
export interface ThirdPartyDeletionAdapter {
  /** 有凭据 + 有 fetch ⇒ true；否则 fail-closed。 */
  readonly available: boolean;
  readonly transportKind: 'real' | 'unwired';
  readonly note: string | null;
  readonly unavailableReason: string | null;
  dispatch(input: { requestId: string; recipientId: string; exportRef: string | null }): Promise<ThirdPartyDeletionDispatchResult>;
  audit(): readonly ThirdPartyDeletionEvidence[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoOf(value: unknown): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function durationMs(started: unknown, ended: unknown): number {
  const start = started instanceof Date && Number.isFinite(started.getTime()) ? started.getTime() : 0;
  const end = ended instanceof Date && Number.isFinite(ended.getTime()) ? ended.getTime() : 0;
  return Math.max(0, end - start);
}

/**
 * 组装第三方删除适配器。
 *
 * `available === true` **只有**在「同时注入了凭据与 `fetch`」时成立；否则返回 fail-closed 适配器
 * （`available=false`）——它连 `fetch` 都不会调，因此**不可能**出现「替身返回成功封套」。
 * `logSink` 收到的是**已脱敏**的证据条目（不含凭据/正文/回执引用）。
 */
export function createThirdPartyDeletionAdapter(deps: {
  credentials?: ThirdPartyDeletionCredentials | null;
  fetch?: ThirdPartyDeletionFetch | null;
  now?: () => Date;
  logSink?: ((entry: Record<string, unknown>) => void) | null;
}): ThirdPartyDeletionAdapter {
  const credentials = deps?.credentials ?? null;
  const transport = deps?.fetch ?? null;
  const now = deps?.now ?? (() => new Date());
  const logSink = deps?.logSink ?? null;

  const credentialsProvided = credentials !== null;
  const transportProvided = transport !== null;
  const available = credentialsProvided && transportProvided;

  const note = available
    ? '已接线：有凭据 + 注入 fetch；派发时经注入点对单个接收方单次调用并登记脱敏证据'
    : '默认关闭：无凭据或无 fetch ⇒ fail-closed，绝不声称删除已完成';

  const unavailableReason = available
    ? null
    : credentialsProvided
      ? '已注入凭据但未注入 fetch ⇒ 无法发起真实删除'
      : '未注入第三方删除凭据 ⇒ 默认关闭';

  const evidenceEntries: ThirdPartyDeletionEvidence[] = [];

  function record(
    requestId: string,
    recipientId: string,
    fields: {
      status: ThirdPartyDeletionOutcomeStatus;
      completed: boolean;
      error_code: string | null;
      duration_ms: number | null;
      attempted_at: string | null;
    },
  ): ThirdPartyDeletionEvidence {
    const entry = Object.freeze({
      request_id: requestId,
      recipient_id: recipientId,
      status: fields.status,
      completed: fields.completed,
      error_code: fields.error_code,
      duration_ms: fields.duration_ms,
      attempted_at: fields.attempted_at,
    });
    evidenceEntries.push(entry);
    if (logSink !== null) {
      // 观测只落「白名单字段」证据条目本身（已脱敏）；不回传任何调用方对象。
      logSink({ ...entry });
    }
    return entry;
  }

  function unavailableOutcome(requestId: string, recipientId: string): ThirdPartyDeletionDispatchResult {
    record(requestId, recipientId, {
      status: 'unavailable',
      completed: false,
      error_code: THIRD_PARTY_DELETION_UNAVAILABLE_CODE,
      duration_ms: null,
      attempted_at: null,
    });
    return Object.freeze({
      status: 'unavailable',
      completed: false,
      error_code: THIRD_PARTY_DELETION_UNAVAILABLE_CODE,
      evidence_ref: null,
      duration_ms: null,
      attempted_at: null,
    });
  }

  function mapResult(
    requestId: string,
    recipientId: string,
    result: ThirdPartyDeletionFetchResult | null | undefined,
    elapsed: number,
    attemptedAt: string | null,
  ): ThirdPartyDeletionDispatchResult {
    const status = result?.status;
    if (status === 'deleted') {
      const reference = isNonEmptyString(result?.reference) ? result.reference.trim() : null;
      if (reference === null) {
        // 供应商声称已删除但无可核验回执 ⇒ 不得判完成（证据不足）。
        record(requestId, recipientId, {
          status: 'unsupported',
          completed: false,
          error_code: 'EVIDENCE_REQUIRED',
          duration_ms: elapsed,
          attempted_at: attemptedAt,
        });
        return Object.freeze({
          status: 'unsupported',
          completed: false,
          error_code: 'EVIDENCE_REQUIRED',
          evidence_ref: null,
          duration_ms: elapsed,
          attempted_at: attemptedAt,
        });
      }
      record(requestId, recipientId, {
        status: 'confirmed',
        completed: true,
        error_code: null,
        duration_ms: elapsed,
        attempted_at: attemptedAt,
      });
      return Object.freeze({
        status: 'confirmed',
        completed: true,
        error_code: null,
        evidence_ref: reference,
        duration_ms: elapsed,
        attempted_at: attemptedAt,
      });
    }
    if (status === 'not_found' || status === 'unsupported') {
      record(requestId, recipientId, {
        status: 'unsupported',
        completed: false,
        error_code: null,
        duration_ms: elapsed,
        attempted_at: attemptedAt,
      });
      return Object.freeze({
        status: 'unsupported',
        completed: false,
        error_code: null,
        evidence_ref: null,
        duration_ms: elapsed,
        attempted_at: attemptedAt,
      });
    }
    // status === 'failed' 或任何未知值 ⇒ fail-closed：绝不据此判完成。
    record(requestId, recipientId, {
      status: 'failed',
      completed: false,
      error_code: 'THIRD_PARTY_FAILED',
      duration_ms: elapsed,
      attempted_at: attemptedAt,
    });
    return Object.freeze({
      status: 'failed',
      completed: false,
      error_code: 'THIRD_PARTY_FAILED',
      evidence_ref: null,
      duration_ms: elapsed,
      attempted_at: attemptedAt,
    });
  }

  async function dispatch(input: {
    requestId: string;
    recipientId: string;
    exportRef: string | null;
  }): Promise<ThirdPartyDeletionDispatchResult> {
    const requestId = isNonEmptyString(input?.requestId) ? input.requestId.trim() : '';
    const recipientId = isNonEmptyString(input?.recipientId) ? input.recipientId.trim() : '';
    const exportRef = isNonEmptyString(input?.exportRef) ? input.exportRef.trim() : null;

    if (credentials === null || transport === null) {
      return unavailableOutcome(requestId, recipientId);
    }
    if (requestId.length === 0 || recipientId.length === 0) {
      // 无法定位接收方 ⇒ 不调用、不判完成（fail-closed）。
      return unavailableOutcome(requestId, recipientId);
    }

    const started = now();
    const attemptedAt = isoOf(started);
    try {
      const result = await transport({ requestId, recipientId, exportRef, credentials });
      return mapResult(requestId, recipientId, result, durationMs(started, now()), attemptedAt);
    } catch {
      // 异常原文（可能含凭据/正文/供应商嵌套错误）一律不进观测，折叠为固定分类。
      const elapsed = durationMs(started, now());
      record(requestId, recipientId, {
        status: 'failed',
        completed: false,
        error_code: 'THIRD_PARTY_FAILED',
        duration_ms: elapsed,
        attempted_at: attemptedAt,
      });
      return Object.freeze({
        status: 'failed',
        completed: false,
        error_code: 'THIRD_PARTY_FAILED',
        evidence_ref: null,
        duration_ms: elapsed,
        attempted_at: attemptedAt,
      });
    }
  }

  return Object.freeze({
    available,
    transportKind: available ? ('real' as const) : ('unwired' as const),
    note,
    unavailableReason,
    dispatch,
    audit: () => Object.freeze([...evidenceEntries]),
  });
}
