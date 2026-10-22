/**
 * GY-R28 · W6（#19 G5/G11）· 回执 `backupState` 由**真实副本行**推导（只读，不写、不清除）。
 *
 * ## 这片要收的缺口
 * `#397` 之后副本域已有四域闭集（`packages/privacy/backup-copies.mjs:42-47`）、受理事务内落清单行、
 * 以及到期清除端口（`services/api/src/privacy/backup-copies-pg.ts`）。但回执里的 `backup_state`
 * 只在**处理器的推动路径**上被改写（`executeHandlers()` 里调一次 `purge()`）；一旦回到读路径
 * （`GET /account/deletions/:id`），回执只是把进程内账本原样投影 —— 于是出现两种错读：
 *   - 30 日已到期、副本行**已清**，回执仍 `pending`（把已完成的读成未完成）；
 *   - 反向更危险：若有人把「副本已清」直接读成 `completed`，等于**不看清单是否四域齐备**就宣告完成。
 * 本文件只做第一件事的正解：**从 `public.user_backup_copies` 的真实行推导**，按域齐备判定，
 * 并且 `completed` 必须由「未清行 0 + 每行都有非空 `evidence_ref` + 证据可复算」三者共同支撑。
 *
 * ## 判定表（每域）
 * | 行集合 | `evaluateBackupPurge` | 回执 `backupState` | 原因码 |
 * | --- | --- | --- | --- |
 * | 无行（清单没写） | — | `blocked` | `EVIDENCE_REQUIRED`（「没有副本行」≠「清完了」） |
 * | 有 `failed` 行 | `blocked/COPY_FAILED` | `blocked` | `STORE_REJECTED`（重放不会自愈，需显式重排） |
 * | 行输入非法 | `blocked/INPUT_INVALID` | `blocked` | `POLICY_BLOCKED` |
 * | 有到期未清行 | `purge/PURGE_DUE` | `blocked` | `STORE_REJECTED`（到期却没清 ⇒ 不是「还没轮到」） |
 * | 有未到期行 | `wait/WAITING_RETENTION` | `pending` | —（`pending` 的唯一正当语义：还没到期） |
 * | 全部 `purged` | `none/ALL_PURGED` | `completed`（**须复核通过**） | — |
 *
 * 「复核通过」= 每行 `state='purged'` 且 `evidence_ref` 非空白，且按 `purgeEvidenceRef()` 口径
 * 能用**这一组 `payload_digest`** 复算出同一个 `sha256:` 摘要（证据与被清对象一一对应）。
 * 复核不通过 ⇒ `blocked` + `EVIDENCE_REQUIRED`，⛔ 不降级成 `pending`（那会被读成「还没轮到」）。
 *
 * ## 聚合
 * 四域全部 `completed` ⇒ `overall: 'completed'`；任一域 `blocked` ⇒ `'blocked'`；否则 `'pending'`。
 * 缺域（闭集里有、但没有清单行）按 `blocked` 计 —— 所以「只清了两域」永远到不了 `completed`。
 *
 * ## 边界
 * - 本文件**只读**：没有 UPDATE/INSERT/DELETE，也没有 `BEGIN`（不占用写连接，不做隐藏的清除）。
 * - 只用运行时角色**已有列级授权**的列（`module, scope, state, retention_until, payload_digest,
 *   evidence_ref`，见 `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-i19-backup-copies-grant`）；
 *   `payload` 明确不读（它在清除后是 `'null'::jsonb`，读它既无必要也会要求新授权）。
 * - 读不到（连接/权限/形状）⇒ 抛错由调用方折叠成 `blocked`，⛔ 不返回 `pending`：
 *   「查不到」既不等于「清完了」，也不等于「还没轮到」。
 */
import { PrivacyError } from '../../../../packages/privacy/errors.mjs';
import { purgeEvidenceRef } from '../../../../packages/privacy/backup-copies.mjs';
import { BACKUP_PURGE_REASONS, evaluateBackupPurge } from '../../../../packages/privacy/backup-retention.mjs';
import type { PgPool } from '../db/pool.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 回执三态的**备份侧**子集（`online_state` 另有自己的推进路径，本文件不碰）。 */
export type DerivedBackupState = 'completed' | 'pending' | 'blocked';

/** 推导原因码（诊断用；不进契约回执，契约只有 `pending|running|completed|blocked` 四态）。 */
export const BACKUP_STATE_REASONS = {
  /** 四域里这一域的行全部已清、证据可复算 ⇒ `completed`。 */
  PURGED_WITH_EVIDENCE: 'BACKUP_PURGED_WITH_EVIDENCE',
  /** 还有未到期行 ⇒ `pending`（唯一正当的 `pending`）。 */
  RETAINED_NOT_DUE: 'BACKUP_RETENTION_NOT_DUE',
  /** 已到期却没清 ⇒ `blocked`（不能靠等自愈）。 */
  PURGE_DUE_NOT_EXECUTED: 'BACKUP_PURGE_DUE_NOT_EXECUTED',
  /** 该域一行清单都没有 ⇒ `blocked`（「没有副本行」不等于「清干净了」）。 */
  MANIFEST_MISSING: 'BACKUP_MANIFEST_MISSING',
  /** 有 `failed` 行 ⇒ `blocked`，需显式重排。 */
  COPY_FAILED: 'BACKUP_COPY_FAILED',
  /** 行输入非法（状态/到期时刻/摘要形态不可解析）⇒ `blocked`，不猜。 */
  INPUT_INVALID: 'BACKUP_INPUT_INVALID',
  /** 已清但复核不通过（缺证据或摘要不可复算）⇒ `blocked`。 */
  EVIDENCE_MISSING: 'BACKUP_EVIDENCE_MISSING',
  /** 读不到副本行（连接/权限/形状）⇒ `blocked`。 */
  UNREADABLE: 'BACKUP_STATE_UNREADABLE',
} as const;

export type BackupStateReason = (typeof BACKUP_STATE_REASONS)[keyof typeof BACKUP_STATE_REASONS];

/** 纯推导用的一行（列名转成驼峰，纯函数不依赖 PG 驱动形状）。 */
export interface BackupCopyStateRow {
  module: string;
  scope: string;
  state: string;
  retentionUntil: Date | string | number;
  payloadDigest: string;
  evidenceRef: string | null;
}

export interface DerivedBackupModuleState {
  module: string;
  state: DerivedBackupState;
  reason: BackupStateReason;
  /** `blocked` 时的原因码（取 `SAFE_ERROR_CODES` 内的值），其余为 `null`。 */
  errorCode: string | null;
  /** `completed` 时的证据摘要（`sha256:…`，按 `purgeEvidenceRef()` 口径复算），其余为 `null`。 */
  evidenceRef: string | null;
  /** 该域实际读到的清单行数（诊断用；`0` 即「清单没写」）。 */
  copies: number;
}

export interface DerivedBackupStates {
  requestId: string;
  modules: readonly DerivedBackupModuleState[];
  overall: DerivedBackupState;
  /** 一行清单都没有的域（回执要说清「凭什么 blocked」）。 */
  missingModules: readonly string[];
}

/**
 * 只读端口：按 (request, user) 一次读出四域副本行并推导。
 *
 * `available: false` 的端口表示**没有真库**（`memory` 装配）⇒ 调用方保持既有行为，不假装推导过。
 */
export interface BackupStateDerivationPort {
  readonly kind: 'postgres' | 'unwired';
  readonly available: boolean;
  derive(input: {
    requestId: string;
    userId: string;
    modules: readonly string[];
  }): Promise<DerivedBackupStates>;
}

/** 复核：每行都必须已清且有非空证据，且证据能用这一组摘要复算出来。 */
function reviewDerivedEvidence(
  requestId: string,
  module: string,
  rows: readonly BackupCopyStateRow[],
): { evidenceRef: string | null; reason: BackupStateReason | null } {
  const uncleared = rows.filter((row) => row.state !== 'purged').length;
  const missingEvidence = rows.filter(
    (row) => row.evidenceRef === null || row.evidenceRef.trim() === '',
  ).length;
  if (uncleared > 0 || missingEvidence > 0 || rows.length === 0) {
    return { evidenceRef: null, reason: BACKUP_STATE_REASONS.EVIDENCE_MISSING };
  }
  let evidenceRef: string;
  try {
    // 复算口径与清除端口**同一个**纯函数：证据只由 (requestId, module, 排序后的摘要) 决定。
    evidenceRef = purgeEvidenceRef({
      requestId,
      module,
      payloadDigests: rows.map((row) => row.payloadDigest),
    });
  } catch {
    return { evidenceRef: null, reason: BACKUP_STATE_REASONS.EVIDENCE_MISSING };
  }
  // 逐行**比对**：落库的证据串必须等于按这一组摘要复算出来的那一个。
  // 只查"非空"是不够的 —— 一串对不上的 `sha256:`（伪造、错位、从别的请求抄来的）
  // 会让「副本已清」这句话变成无根据的宣告。对不上 ⇒ 判 blocked/EVIDENCE_REQUIRED。
  const mismatched = rows.filter((row) => (row.evidenceRef ?? '').trim() !== evidenceRef).length;
  if (mismatched > 0) {
    return { evidenceRef: null, reason: BACKUP_STATE_REASONS.EVIDENCE_MISSING };
  }
  return { evidenceRef, reason: null };
}

/** 单域推导（纯函数；`rows` 只含该域的行）。 */
export function deriveBackupStateForModule(input: {
  requestId: string;
  module: string;
  rows: readonly BackupCopyStateRow[];
  now: Date;
}): DerivedBackupModuleState {
  const rows = input.rows.filter((row) => row.module === input.module);
  if (rows.length === 0) {
    // 「没写清单行」的真实含义是**没有可清对象**，不是「清完了」：⛔ 不许读成 completed。
    return {
      module: input.module,
      state: 'blocked',
      reason: BACKUP_STATE_REASONS.MANIFEST_MISSING,
      errorCode: 'EVIDENCE_REQUIRED',
      evidenceRef: null,
      copies: 0,
    };
  }
  const decision = evaluateBackupPurge({
    now: input.now,
    copies: rows.map((row) => ({
      state: row.state,
      retentionUntil: row.retentionUntil,
      // 摘要随行带出（`evaluateBackupPurge` 会把它原样复制到 `dueCopies`），供下面复核用。
      payloadDigest: row.payloadDigest,
    })),
  }) as { action: string; reason: string; dueCopies: readonly unknown[] };

  if (decision.action === 'blocked') {
    return decision.reason === BACKUP_PURGE_REASONS.COPY_FAILED
      ? {
          module: input.module,
          state: 'blocked',
          reason: BACKUP_STATE_REASONS.COPY_FAILED,
          errorCode: 'STORE_REJECTED',
          evidenceRef: null,
          copies: rows.length,
        }
      : {
          module: input.module,
          state: 'blocked',
          reason: BACKUP_STATE_REASONS.INPUT_INVALID,
          errorCode: 'POLICY_BLOCKED',
          evidenceRef: null,
          copies: rows.length,
        };
  }
  if (decision.action === 'wait') {
    return {
      module: input.module,
      state: 'pending',
      reason: BACKUP_STATE_REASONS.RETAINED_NOT_DUE,
      errorCode: null,
      evidenceRef: null,
      copies: rows.length,
    };
  }
  if (decision.action === 'purge') {
    // 到期却没清：`blocked`（不是 pending —— pending 的语义是「还没轮到」）。
    return {
      module: input.module,
      state: 'blocked',
      reason: BACKUP_STATE_REASONS.PURGE_DUE_NOT_EXECUTED,
      errorCode: 'STORE_REJECTED',
      evidenceRef: null,
      copies: rows.length,
    };
  }
  // `action === 'none'`：要么全清，要么空集（空集已在上面被拦掉，这里再兜一次）。
  const reviewed = reviewDerivedEvidence(input.requestId, input.module, rows);
  if (reviewed.evidenceRef === null) {
    return {
      module: input.module,
      state: 'blocked',
      reason: reviewed.reason ?? BACKUP_STATE_REASONS.EVIDENCE_MISSING,
      errorCode: 'EVIDENCE_REQUIRED',
      evidenceRef: null,
      copies: rows.length,
    };
  }
  return {
    module: input.module,
    state: 'completed',
    reason: BACKUP_STATE_REASONS.PURGED_WITH_EVIDENCE,
    errorCode: null,
    evidenceRef: reviewed.evidenceRef,
    copies: rows.length,
  };
}

/**
 * 四域推导 + 聚合（纯函数）。
 *
 * `modules` 是**必需模块闭集**（装配处传 `USER_DATA_DELETION_MODULES`）：闭集里有、行里没有的域
 * 按 `blocked` 计，因此「只清了部分域」永远到不了 `completed`（这正是 #397 真库臂的判据）。
 */
export function deriveBackupStates(input: {
  requestId: string;
  modules: readonly string[];
  rows: readonly BackupCopyStateRow[];
  now: Date;
}): DerivedBackupStates {
  const modules = input.modules.map((module) =>
    deriveBackupStateForModule({ requestId: input.requestId, module, rows: input.rows, now: input.now }),
  );
  const missingModules = modules.filter((one) => one.copies === 0).map((one) => one.module);
  const overall: DerivedBackupState =
    modules.length === 0
      ? // 闭集为空不是「全都清完了」；调用方一定有闭集，这里只是不给出虚假的 completed。
        'blocked'
      : modules.some((one) => one.state === 'blocked')
        ? 'blocked'
        : modules.every((one) => one.state === 'completed')
          ? 'completed'
          : 'pending';
  return { requestId: input.requestId, modules, overall, missingModules };
}

/** 读不到时的统一折叠：四域全 `blocked` + `STORE_UNREACHABLE`（⛔ 不返回 pending）。 */
export function unreadableBackupStates(input: {
  requestId: string;
  modules: readonly string[];
}): DerivedBackupStates {
  return {
    requestId: input.requestId,
    modules: input.modules.map((module) => ({
      module,
      state: 'blocked' as const,
      reason: BACKUP_STATE_REASONS.UNREADABLE,
      errorCode: 'STORE_UNREACHABLE',
      evidenceRef: null,
      copies: 0,
    })),
    overall: 'blocked',
    missingModules: [...input.modules],
  };
}

/**
 * 只读 SQL：一次取回某个请求下**全部模块**的副本行。
 *
 * 用一条语句而不是「按模块循环」：四域的判定要在**同一快照**上做（否则「快照 A 里 favorites 已清、
 * 快照 B 里 history 未清」这种错位会把聚合结论带偏）。列全部在 `gy-i19-backup-copies-grant`
 * 的 SELECT 列表内，**不需要**新增授权面。
 */
const SELECT_REQUEST_COPIES_SQL = `SELECT module, scope, state, retention_until, payload_digest, evidence_ref
  FROM public.user_backup_copies
  WHERE request_id = $1::uuid AND user_id = $2::uuid
  ORDER BY module, scope`;

/** 事务内可用的最小 SQL 客户端形状（与 `backup-copies-pg.ts::BackupCopySqlClient` 同形）。 */
export interface BackupStateSqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new PrivacyError('SESSION_REQUIRED', `缺少身份/受理上下文：${field}`);
  }
  return value;
}

function toStateRow(row: Record<string, unknown>): BackupCopyStateRow {
  return {
    module: String(row['module']),
    scope: String(row['scope']),
    state: String(row['state']),
    retentionUntil: new Date(row['retention_until'] as string | Date),
    payloadDigest: String(row['payload_digest']),
    evidenceRef:
      row['evidence_ref'] === null || row['evidence_ref'] === undefined
        ? null
        : String(row['evidence_ref']),
  };
}

/**
 * 建**真实**的回执备份态推导端口（PG 只读实现）。
 *
 * 每次 `derive()` 都重读库（不缓存、不记忆上次结论）：回执是要给用户的当下事实，
 * 缓存会把「已经清完」或「刚刚失败」都读成旧结论。
 */
export function createPostgresBackupStateReader({
  pool,
  now = () => new Date(),
  client,
}: {
  pool?: PgPool;
  now?: () => Date;
  /** 测试/运维脚本可直接给一个 SQL 客户端（例如 CLI 里 `pool` 本身就是客户端）。 */
  client?: BackupStateSqlClient;
}): BackupStateDerivationPort {
  async function readRows(sql: BackupStateSqlClient, requestId: string, userId: string) {
    const result = await sql.query(SELECT_REQUEST_COPIES_SQL, [requestId, userId]);
    return result.rows.map(toStateRow);
  }

  return {
    kind: 'postgres',
    available: true,
    async derive({ requestId, userId, modules }) {
      const request = assertUuid(requestId, 'requestId');
      const subject = assertUuid(userId, 'userId');
      const at = now();
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
        throw new PrivacyError('STORE_REJECTED', '备份态推导需要可解析的当前时刻');
      }
      if (client !== undefined) {
        const rows = await readRows(client, request, subject);
        return deriveBackupStates({ requestId: request, modules, rows, now: at });
      }
      const poolClient = pool ?? null;
      if (poolClient === null || typeof poolClient.connect !== 'function') {
        throw new PrivacyError('PROVIDER_UNAVAILABLE', '备份态推导需要数据库连接：未提供连接池');
      }
      const connection = await poolClient.connect();
      try {
        const rows = await readRows(connection, request, subject);
        return deriveBackupStates({ requestId: request, modules, rows, now: at });
      } finally {
        connection.release?.();
      }
    },
  };
}

/** 未接线端口（`memory` 装配）：`available: false` ⇒ 调用方保持既有行为，不假装推导过。 */
export function createUnwiredBackupStateReader(): BackupStateDerivationPort {
  return {
    kind: 'unwired',
    available: false,
    async derive({ requestId, modules }) {
      return unreadableBackupStates({ requestId, modules });
    },
  };
}
