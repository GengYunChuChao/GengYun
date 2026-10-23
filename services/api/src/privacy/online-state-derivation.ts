/**
 * GY-R32 · #19 片B · 回执 `onlineState` 由**落库证据**推导（只读，不写、不清除）。
 *
 * ## 这片收的缺口
 * 在线域此前**没有**与备份侧 `backup-state-derivation.ts` 对应的读路径：
 *   - `deletion_handlers` / `deletion_requests` 对运行时角色是 `forbidden`，
 *     在线清理证据只以 `sha256:` 摘要进**命令报告 stdout**（`online-purge-driver.ts` 文件头）；
 *   - 因此 `/account/deletions/:id` 的在线列只能照抄进程内账本：换进程就看不见，
 *     到期清完也读不出"已完成"。
 * 迁移 0031 把证据落到 `deletion_requests.online_purge_evidence`（append-only jsonb 数组），
 * 并开了一条窄口径只读函数 `public.read_online_purge_evidence(uuid, uuid)`。本文件只做**推导**。
 *
 * ## 判定表（每域）
 * | 行集合 | 回执 `onlineState` | 原因码 |
 * | --- | --- | --- |
 * | 有可复算证据（任意条） | `completed` | —（证据由 `(requestId, module, removed, idempotency)` 复算） |
 * | 无证据 + 未到期 | `pending` | —（**唯一**正当的 pending：还没轮到） |
 * | 无证据 + 已到期 | `blocked` | `STORE_REJECTED`（到期却没清 ⇒ 不是"还没轮到"） |
 * | 证据摘要对不上 | `blocked` | `EVIDENCE_REQUIRED`（⛔ 不抬成 completed，也不降成 pending） |
 * | 证据/时刻形状非法 | `blocked` | `POLICY_BLOCKED`（不猜） |
 * | 读不到（连接/权限/形状） | `blocked` | `STORE_UNREACHABLE` |
 *
 * 「到期」是闭区间（`now >= online_due_at`），与驱动/候选 SQL/`deletion-aging.ts` 同口径。
 * **有证据 ⇒ completed，即使还没到期**：在线数据在受理时就被处理器清掉是正常路径
 * （`executeHandlers()` 在 202 之前跑），"未到期"只说明"还没轮到定时驱动"，不是"没清"。
 *
 * ## 聚合
 * 闭集里全部 `completed` ⇒ `completed`；任一 `blocked` ⇒ `blocked`；否则 `pending`。
 * 闭集里有、证据里没有的域按 `blocked` 计 —— 所以「只清了两域」永远到不了 `completed`。
 *
 * ## 边界
 * - 本文件**只读**：没有 UPDATE/INSERT/DELETE，也没有 `BEGIN`；写面只在迁移 0031 的写函数里。
 * - 只用运行时角色**已有**的权限：唯一读路径是 `public.read_online_purge_evidence(uuid,uuid)`
 *   的 EXECUTE（`20-login-roles.sql` 的 `gy-r32-i19-online-evidence-grant`），
 *   ⛔ 不需要（也**不得**）给 `deletion_requests` 补任何表级/列级权限。
 * - 读不到（连接/权限/形状）⇒ 抛错由调用方折叠成 `blocked`，⛔ 不返回 `pending`。
 */
import { PrivacyError } from '../../../../packages/privacy/errors.mjs';
import type { PgPool } from '../db/pool.ts';
import { onlinePurgeEvidenceRef } from './online-purge-driver.ts';
import { ONLINE_PURGE_EVIDENCE_READ_SQL } from './online-purge-evidence.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVIDENCE_REF_RE = /^sha256:[0-9a-f]{64}$/;
const STRICT_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

/** 回执三态的**在线侧**子集。 */
export type DerivedOnlineState = 'completed' | 'pending' | 'blocked';

/** 推导原因码（诊断用；不进契约回执）。 */
export const ONLINE_STATE_REASONS = {
  /** 四域里这一域有可复算证据 ⇒ `completed`。 */
  PURGED_WITH_EVIDENCE: 'ONLINE_PURGED_WITH_EVIDENCE',
  /** 没有证据但还没到期 ⇒ `pending`（唯一正当的 pending）。 */
  NOT_DUE: 'ONLINE_PURGE_NOT_DUE',
  /** 已到期却没有证据 ⇒ `blocked`（不能靠等自愈）。 */
  DUE_NOT_EXECUTED: 'ONLINE_PURGE_DUE_NOT_EXECUTED',
  /** 证据摘要与读数对不上 ⇒ `blocked`。 */
  EVIDENCE_MISMATCH: 'ONLINE_EVIDENCE_MISMATCH',
  /** 证据/到期时刻形状非法（含顶层不是数组、缺字段、负数）⇒ `blocked`，不猜。 */
  INPUT_INVALID: 'ONLINE_INPUT_INVALID',
  /** 读不到（连接/权限/形状）⇒ `blocked`。 */
  UNREADABLE: 'ONLINE_STATE_UNREADABLE',
} as const;

export type OnlineStateReason = (typeof ONLINE_STATE_REASONS)[keyof typeof ONLINE_STATE_REASONS];

/**
 * 一条落库证据（`deletion_requests.online_purge_evidence` 数组元素，列名转驼峰）。
 *
 * 字段刻意是 `unknown`：库里的 jsonb 是**外部输入**，校验必须发生在推导里（`typeof` 逐项判），
 * ⛔ 不用 `String(...)` 提前把 `undefined` 洗成 `'undefined'` 那种"形状看起来合法"的假绿。
 */
export interface OnlinePurgeEvidenceEntry {
  module: unknown;
  evidenceRef: unknown;
  removed: unknown;
  idempotency: unknown;
  purgedAt: unknown;
}

/** 纯推导用的一行（`read_online_purge_evidence()` 的返回，列名转驼峰）。 */
export interface OnlinePurgeStateRow {
  requestId: string;
  requestState: string;
  onlineDueAt: unknown;
  evidence: unknown;
}

export interface DerivedOnlineModuleState {
  module: string;
  state: DerivedOnlineState;
  reason: OnlineStateReason;
  /** `blocked` 时的原因码（取 `SAFE_ERROR_CODES` 内的值），其余为 `null`。 */
  errorCode: string | null;
  /** `completed` 时该域**代表证据**的摘要（数组里的最后一条，可复算），其余为 `null`。 */
  evidenceRef: string | null;
  /** `completed` 时代表证据里的真实删除行数（回执证据串据此重建）；其余缺省。 */
  removed?: number;
  /** `completed` 时代表证据里的幂等台账行数；其余缺省。 */
  idempotency?: number;
  /** 该域读到的证据条数（诊断用；`0` 即「这一域没有落库证据」）。 */
  entries: number;
}

export interface DerivedOnlineStates {
  requestId: string;
  modules: readonly DerivedOnlineModuleState[];
  overall: DerivedOnlineState;
  /** 一条证据都没有的域（回执要说清「凭什么 blocked / pending」）。 */
  missingModules: readonly string[];
}

/** 只读端口：按 (request, user) 读出请求行与证据数组并推导。 */
export interface OnlineStateDerivationPort {
  readonly kind: 'postgres' | 'unwired';
  readonly available: boolean;
  derive(input: {
    requestId: string;
    userId: string;
    modules: readonly string[];
  }): Promise<DerivedOnlineStates>;
}

/** 时刻解析：`Date` / 毫秒数 / 带时区 ISO-8601；裸本地时间与非法值返回 `null`。 */
function instantMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && STRICT_INSTANT_RE.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

type ModuleEvidenceReview =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'mismatch' }
  | { kind: 'ok'; evidenceRef: string; removed: number; idempotency: number };

/**
 * 复核单域证据（纯函数）：
 *   - 数组元素必须都是对象、`module` 与本域相等、`evidence_ref` 是 `sha256:<64hex>`、
 *     `removed`/`idempotency` 是非负安全整数、`purged_at` 可解析；
 *   - 每条都必须能由 `(requestId, module, removed, idempotency)` **复算出同一个摘要**；
 *   - 代表证据 = 数组里的最后一条（append-only 语义下即"最新写入的那条"）。
 */
function reviewModuleEvidence(
  requestId: string,
  module: string,
  evidence: unknown,
): ModuleEvidenceReview {
  if (!Array.isArray(evidence)) return { kind: 'invalid' };
  const mine = evidence.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>)['module'] === module,
  );
  if (mine.length === 0) return { kind: 'none' };
  let last: { evidenceRef: string; removed: number; idempotency: number } | null = null;
  for (const entry of mine) {
    const evidenceRef = entry['evidenceRef'];
    const removed = entry['removed'];
    const idempotency = entry['idempotency'];
    if (
      typeof evidenceRef !== 'string' ||
      !EVIDENCE_REF_RE.test(evidenceRef) ||
      typeof removed !== 'number' ||
      !Number.isSafeInteger(removed) ||
      removed < 0 ||
      typeof idempotency !== 'number' ||
      !Number.isSafeInteger(idempotency) ||
      idempotency < 0 ||
      instantMs(entry['purgedAt']) === null
    ) {
      return { kind: 'invalid' };
    }
    const recomputed = onlinePurgeEvidenceRef({ requestId, module, removed, idempotency });
    if (evidenceRef !== recomputed) return { kind: 'mismatch' };
    last = { evidenceRef, removed, idempotency };
  }
  if (last === null) return { kind: 'none' };
  return { kind: 'ok', ...last };
}

/** 单域推导（纯函数；`row` 是整行，函数只挑该域的证据）。 */
export function deriveOnlineStateForModule(input: {
  requestId: string;
  module: string;
  row: OnlinePurgeStateRow;
  now: Date;
}): DerivedOnlineModuleState {
  const review = reviewModuleEvidence(input.requestId, input.module, input.row.evidence);
  const entries =
    Array.isArray(input.row.evidence)
      ? input.row.evidence.filter(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            (entry as Record<string, unknown>)['module'] === input.module,
        ).length
      : 0;

  if (review.kind === 'invalid') {
    return {
      module: input.module,
      state: 'blocked',
      reason: ONLINE_STATE_REASONS.INPUT_INVALID,
      errorCode: 'POLICY_BLOCKED',
      evidenceRef: null,
      entries,
    };
  }
  if (review.kind === 'mismatch') {
    return {
      module: input.module,
      state: 'blocked',
      reason: ONLINE_STATE_REASONS.EVIDENCE_MISMATCH,
      errorCode: 'EVIDENCE_REQUIRED',
      evidenceRef: null,
      entries,
    };
  }
  if (review.kind === 'ok') {
    // 有可复算证据 ⇒ completed，**即使还没到期**（受理时的处理器已清是正常路径）。
    return {
      module: input.module,
      state: 'completed',
      reason: ONLINE_STATE_REASONS.PURGED_WITH_EVIDENCE,
      errorCode: null,
      evidenceRef: review.evidenceRef,
      removed: review.removed,
      idempotency: review.idempotency,
      entries,
    };
  }

  const dueMs = instantMs(input.row.onlineDueAt);
  if (dueMs === null) {
    // 到期时刻不可解析 ⇒ 不猜：既不说"还没到"，也不说"已完成"。
    return {
      module: input.module,
      state: 'blocked',
      reason: ONLINE_STATE_REASONS.INPUT_INVALID,
      errorCode: 'POLICY_BLOCKED',
      evidenceRef: null,
      entries,
    };
  }
  if (input.now.getTime() < dueMs) {
    return {
      module: input.module,
      state: 'pending',
      reason: ONLINE_STATE_REASONS.NOT_DUE,
      errorCode: null,
      evidenceRef: null,
      entries,
    };
  }
  // 到期却没有证据：blocked（⛔ 不是 pending —— pending 的语义是「还没轮到」）。
  return {
    module: input.module,
    state: 'blocked',
    reason: ONLINE_STATE_REASONS.DUE_NOT_EXECUTED,
    errorCode: 'STORE_REJECTED',
    evidenceRef: null,
    entries,
  };
}

/** 闭集推导 + 聚合（纯函数）。 */
export function deriveOnlineStates(input: {
  requestId: string;
  modules: readonly string[];
  row: OnlinePurgeStateRow;
  now: Date;
}): DerivedOnlineStates {
  const modules = input.modules.map((module) =>
    deriveOnlineStateForModule({ requestId: input.requestId, module, row: input.row, now: input.now }),
  );
  const missingModules = modules.filter((one) => one.entries === 0).map((one) => one.module);
  const overall: DerivedOnlineState =
    modules.length === 0
      ? // 空闭集不是「全都清完了」：调用方一定有闭集，这里不给出虚假的 completed。
        'blocked'
      : modules.some((one) => one.state === 'blocked')
        ? 'blocked'
        : modules.every((one) => one.state === 'completed')
          ? 'completed'
          : 'pending';
  return { requestId: input.requestId, modules, overall, missingModules };
}

/** 读不到时的统一折叠：四域全 `blocked` + `STORE_UNREACHABLE`（⛔ 不返回 pending）。 */
export function unreadableOnlineStates(input: {
  requestId: string;
  modules: readonly string[];
}): DerivedOnlineStates {
  return {
    requestId: input.requestId,
    modules: input.modules.map((module) => ({
      module,
      state: 'blocked' as const,
      reason: ONLINE_STATE_REASONS.UNREADABLE,
      errorCode: 'STORE_UNREACHABLE',
      evidenceRef: null,
      entries: 0,
    })),
    overall: 'blocked',
    missingModules: [...input.modules],
  };
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new PrivacyError('SESSION_REQUIRED', `缺少身份/受理上下文：${field}`);
  }
  return value;
}

/** 落库证据元素（snake_case jsonb）→ 推导用元素（camelCase；类型原样保留供校验）。 */
function toEvidenceEntry(raw: unknown): OnlinePurgeEvidenceEntry {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    module: record['module'],
    evidenceRef: record['evidence_ref'],
    removed: record['removed'],
    idempotency: record['idempotency'],
    purgedAt: record['purged_at'],
  };
}

/** `read_online_purge_evidence()` 的 jsonb 返回 → 纯推导行；形状非法就抛（由调用方折叠 blocked）。 */
function toStateRow(payload: unknown): OnlinePurgeStateRow {
  if (typeof payload !== 'object' || payload === null) {
    throw new PrivacyError('STORE_REJECTED', '在线证据读路径返回了非对象');
  }
  const record = payload as Record<string, unknown>;
  const evidence = record['evidence'];
  if (!Array.isArray(evidence)) {
    throw new PrivacyError('STORE_REJECTED', '在线证据读路径的 evidence 不是数组');
  }
  return {
    requestId: String(record['request_id']),
    requestState: String(record['state']),
    onlineDueAt: record['online_due_at'],
    evidence: evidence.map(toEvidenceEntry),
  };
}

/** 事务内可用的最小 SQL 客户端形状（与其它只读推导端口同形）。 */
export interface OnlineStateSqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * 建**真实**的回执在线态推导端口（PG 只读实现）。
 *
 * 每次 `derive()` 都重读库（不缓存、不记忆上次结论）：回执是给用户的当下事实。
 * 读的是**窄口径函数**，不是 `deletion_requests` 表 —— 运行时角色对那张表仍然零权限。
 */
export function createPostgresOnlineStateReader({
  pool,
  now = () => new Date(),
  client,
}: {
  pool?: PgPool;
  now?: () => Date;
  /** 测试/运维脚本可直接给一个 SQL 客户端（例如 `pool` 本身就是客户端）。 */
  client?: OnlineStateSqlClient;
}): OnlineStateDerivationPort {
  async function readRow(sql: OnlineStateSqlClient, requestId: string, userId: string): Promise<OnlinePurgeStateRow> {
    const result = await sql.query(ONLINE_PURGE_EVIDENCE_READ_SQL, [requestId, userId]);
    const payload = result.rows[0]?.['state'];
    if (payload === null || payload === undefined) {
      throw new PrivacyError('NOT_FOUND', '注销请求不存在或不属于该主体');
    }
    return toStateRow(payload);
  }

  return {
    kind: 'postgres',
    available: true,
    async derive({ requestId, userId, modules }) {
      const request = assertUuid(requestId, 'requestId');
      const subject = assertUuid(userId, 'userId');
      const at = now();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
        throw new PrivacyError('STORE_REJECTED', '在线态推导需要可解析的当前时刻');
      }
      if (client !== undefined) {
        const row = await readRow(client, request, subject);
        return deriveOnlineStates({ requestId: request, modules, row, now: at });
      }
      const poolClient = pool ?? null;
      if (poolClient === null || typeof poolClient.connect !== 'function') {
        throw new PrivacyError('PROVIDER_UNAVAILABLE', '在线态推导需要数据库连接：未提供连接池');
      }
      const connection = await poolClient.connect();
      try {
        const row = await readRow(connection, request, subject);
        return deriveOnlineStates({ requestId: request, modules, row, now: at });
      } finally {
        connection.release?.();
      }
    },
  };
}

/** 未接线端口（`memory` 装配）：`available: false` ⇒ 调用方保持既有行为，不假装推导过。 */
export function createUnwiredOnlineStateReader(): OnlineStateDerivationPort {
  return {
    kind: 'unwired',
    available: false,
    async derive({ requestId, modules }) {
      return unreadableOnlineStates({ requestId, modules });
    },
  };
}
