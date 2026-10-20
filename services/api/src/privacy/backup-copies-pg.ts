/**
 * GY-I19（#19）· 逐用户备份副本域的 **PG 适配层**：写入（受理事务内）＋ 清除端口（真实实现）。
 *
 * ## 为什么写入要挂在受理事务里
 * 设计中「写快照行」必须是受理事务的第 2 步、且在 `executeHandlers()` 之前（设计 §6.1）：
 * 处理器做的是**物理删除**，等它跑完再写清单只能拿到空引用。因此写入口
 * `insertBackupCopySeeds()` 只接受**已经开好事务的** `PoolClient`，由
 * `services/api/src/privacy/deletion-requests-pg.ts` 在 `COMMIT` 之前调用；
 * 这里**不自己** `BEGIN`/`COMMIT`（否则会切成两个事务，「受理成功但清单没写」就会变成合法状态）。
 *
 * 同一原因：清单的行数/引用是在**该事务内**读出来的（`snapshotOwner(ownerId, client)`），
 * 与函数调用看到的是同一个快照，不会出现「行删了但清单漏记」的窗口。
 *
 * ## 清除端口为什么能给出 `blocked`（而不是只有 `purged`/`pending`）
 * 设计 §7.4 的缺口：旧端口只能返回 `{purged, evidenceRef?}`，无法表达「该清但清不掉」。
 * 本实现按 §7.4 的**新增可选字段** `outcome` 返回三态；旧字段 `purged`/`evidenceRef` 继续填，
 * 因此未升级的调用方语义不变（`purged === true` 仍等价于「已清且有证据」）。
 *
 * ## 完成判据 = 删除后**复核**（设计 §7.2，不是「UPDATE 没报错」）
 * `purge` 事务：`UPDATE ... WHERE state='pending_purge' AND retention_until <= now`
 * → **再读一遍**同一 (request, user, module) 的行 → 只有「未清行数 = 0 且证据行 ≥ 1」才
 * `COMMIT` 并返回 `purged`；否则 `ROLLBACK` 并如实返回 `blocked`。证据摘要按 §7.2 口径由
 * 「排序后的 `payload_digest`」算出（纯函数在 `packages/privacy/backup-copies.mjs`），
 * 因此证据与被清对象数一一对得上（一行一个 digest）。
 *
 * ## 失败语义
 * `UPDATE` 抛错或影响 0 行 ⇒ 回滚，另行把未清行置 `failed` + `last_error_code` +
 * `purge_attempts+1`（DB 的 CHECK 要求 `failed` 必有 `last_error_code`；取值用
 * `deletion.mjs` 的 `SAFE_ERROR_CODES` 内码），端口返回
 * `{ outcome:'blocked', errorCode:'STORE_UNREACHABLE' }` ⇒ 回执该模块 `blocked` +
 * `error_code`，**不是** `pending`（`pending` 的语义是「还没轮到」，清不掉不能等它自愈）。
 *
 * ## 前置校验
 * 非 UUID 的 `userId` ⇒ `PrivacyError('SESSION_REQUIRED')`（先例
 * `services/api/src/privacy/ledger-pg.ts:540-542`）：缺身份上下文时不查库、不猜主体。
 */
import { PrivacyError } from '../../../../packages/privacy/errors.mjs';
import {
  BACKUP_COPY_LINEAGE,
  copyPayloadDigest,
  copyPayloadJson,
  normalizeObjectRefs,
  purgeEvidenceRef,
} from '../../../../packages/privacy/backup-copies.mjs';
import { BACKUP_PURGE_REASONS, evaluateBackupPurge } from '../../../../packages/privacy/backup-retention.mjs';
import type { BackupPurgePort, BackupPurgeResult } from './user-data-deletion.ts';
import { isTransientDatabaseError, type PgPool } from '../db/pool.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 受理事务的锁等待上限（与 `privacy/ledger-pg.ts` / `deletion-requests-pg.ts` 的 4s 同口径）。 */
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '4s'";

/** 事务内只读当前 (request, user, module) 的副本行；`payload_digest` 清空后仍保留（设计 §5.3）。 */
const SELECT_COPIES_SQL = `SELECT scope, state, retention_until, payload_digest, evidence_ref
  FROM public.user_backup_copies
  WHERE request_id = $1::uuid AND user_id = $2::uuid AND module = $3
  ORDER BY scope`;

/** 写入一行的唯一语句：唯一键冲突即幂等跳过（设计 §4.2「写入幂等：ON CONFLICT DO NOTHING」）。 */
const INSERT_COPY_SQL = `INSERT INTO public.user_backup_copies (
  id, user_id, request_id, module, scope, delete_generation, lineage,
  covered_through, payload, payload_digest, state, retention_until,
  purge_attempts, created_at, updated_at
) VALUES (
  gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5::integer, $6,
  $7::timestamptz, $8::jsonb, $9::char(64), 'pending_purge', $10::timestamptz,
  0, $7::timestamptz, $7::timestamptz
)
ON CONFLICT (request_id, module, scope) DO NOTHING
RETURNING id`;

/** 到期清除：只清到期的未清行，并把证据一起写上（CHECK 保证 purged 必有证据且 payload 已置 null）。 */
const PURGE_COPIES_SQL = `UPDATE public.user_backup_copies
  SET payload = 'null'::jsonb,
      state = 'purged',
      purged_at = $4::timestamptz,
      evidence_ref = $5,
      updated_at = $4::timestamptz
  WHERE request_id = $1::uuid AND user_id = $2::uuid AND module = $3
    AND state = 'pending_purge' AND retention_until <= $4::timestamptz
  RETURNING scope, payload_digest`;

/** 失败留痕：`failed` 必带 `last_error_code`，重试次数 +1（设计 §4.3 状态机）。 */
const MARK_FAILED_SQL = `UPDATE public.user_backup_copies
  SET state = 'failed',
      last_error_code = $4,
      purge_attempts = purge_attempts + 1,
      updated_at = $5::timestamptz
  WHERE request_id = $1::uuid AND user_id = $2::uuid AND module = $3
    AND state = 'pending_purge'`;

/** 事务内可用的最小 SQL 客户端形状（只用到 `query`；不把 pg 的完整类型灌进主域）。 */
export interface BackupCopySqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * 一个模块的「待清对象枚举器」。
 *
 * `snapshotOwner` **必须**接受事务客户端：清单要在受理事务内读，才能与函数调用同快照。
 * 返回值只许是**不透明引用**（行 id / 摘要 / token）与计数；正文、标题、身份信息一律不许出现
 * （设计 §5.1 的最小化清单，纯函数 `normalizeObjectRefs()` 会把自由文本挡在应用层）。
 */
export interface BackupCopySeedSource {
  readonly module: string;
  readonly scope: string;
  snapshotOwner(
    ownerId: string,
    client: BackupCopySqlClient,
  ): Promise<{ objectRefs: readonly string[]; records: number }>;
}

export interface BackupCopySeedInput {
  requestId: string;
  userId: string;
  generation: number;
  /** 截至水位（= 受理时刻；与 `created_at` 同值，因此 CHECK `covered_through <= created_at` 恒成立）。 */
  coveredThrough: string;
  /** 到期时刻（= `deletion_requests.backup_due_at`，设计 §4.4 要求逐行相等）。 */
  retentionUntil: string;
  sources: readonly BackupCopySeedSource[];
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new PrivacyError('SESSION_REQUIRED', `缺少身份/受理上下文：${field}`);
  }
  return value;
}

/**
 * 在**调用方事务内**写入每个模块的快照行。
 *
 * - `sources` 为空 ⇒ 抛错（每个必需模块都必须有一行；空清单不是成功，设计 §7.3）；
 * - 0 个对象也写一行（`{"object_refs": [], "records": 0}`），清除阶段据此区分「清过」与「没写过」；
 * - 同一 (request, module, scope) 已存在 ⇒ `ON CONFLICT DO NOTHING`（重放幂等，不覆盖既有证据）。
 *
 * @returns 本次真正插入的行数（诊断用；0 表示全是幂等跳过）。
 */
export async function insertBackupCopySeeds(
  client: BackupCopySqlClient,
  input: BackupCopySeedInput,
): Promise<number> {
  assertUuid(input.requestId, 'requestId');
  assertUuid(input.userId, 'userId');
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new PrivacyError('INVALID_REQUEST', '备份副本清单的删除代次非法');
  }
  if (!Array.isArray(input.sources) || input.sources.length === 0) {
    throw new PrivacyError('STORE_REJECTED', '备份副本清单为空：每个必需模块都必须落一行');
  }
  let inserted = 0;
  for (const source of input.sources) {
    // 事务内按主体枚举：与受理函数同一快照，避免「删了却没记」。
    const snapshot = await source.snapshotOwner(input.userId, client);
    const normalized = normalizeObjectRefs(snapshot);
    const payloadJson = copyPayloadJson(normalized);
    const digest = copyPayloadDigest(payloadJson);
    const result = await client.query(INSERT_COPY_SQL, [
      input.userId,
      input.requestId,
      source.module,
      source.scope,
      input.generation,
      BACKUP_COPY_LINEAGE,
      input.coveredThrough,
      payloadJson,
      digest,
      input.retentionUntil,
    ]);
    inserted += result.rows.length;
  }
  return inserted;
}

/**
 * 建**真实**的备份副本清除端口（PG 实现）。
 *
 * 每次 `purge()` 都**重读**库（不缓存、不记忆上次结论）：读时重查状态是设计要求
 * （隐藏/失效/注销不得因缓存复活），也保证「重放已 purged 的模块」走复核而不是降级成 pending。
 */
export function createPostgresBackupPurgePort({
  pool,
  now = () => new Date(),
}: {
  pool: PgPool;
  now?: () => Date;
}): BackupPurgePort {
  async function readCopies(
    client: BackupCopySqlClient,
    requestId: string,
    userId: string,
    module: string,
  ): Promise<
    Array<{
      scope: string;
      state: string;
      retentionUntil: Date;
      payloadDigest: string;
      evidenceRef: string | null;
    }>
  > {
    const result = await client.query(SELECT_COPIES_SQL, [requestId, userId, module]);
    return result.rows.map((row) => ({
      scope: String(row['scope']),
      state: String(row['state']),
      retentionUntil: new Date(row['retention_until'] as string | Date),
      payloadDigest: String(row['payload_digest']),
      evidenceRef: row['evidence_ref'] === null || row['evidence_ref'] === undefined ? null : String(row['evidence_ref']),
    }));
  }

  /** 复核：未清行必须为 0，且证据行（purged 且有非空白 evidence_ref）至少 1。 */
  function reviewPassed(
    rows: ReadonlyArray<{ state: string; evidenceRef: string | null }>,
  ): boolean {
    const remaining = rows.filter((row) => row.state !== 'purged').length;
    const evidenceRows = rows.filter(
      (row) => row.state === 'purged' && row.evidenceRef !== null && row.evidenceRef.trim() !== '',
    ).length;
    return remaining === 0 && evidenceRows >= 1;
  }

  /**
   * 失败留痕（`state='failed'` + `last_error_code` + `purge_attempts+1`）。
   *
   * 返回是否落库成功：留痕写不进（权限/连接）时**不能**静默当作已留痕 —— 人要靠这行做显式重排，
   * 所以调用方会把「留痕失败」写进 blocked 的 reason 里，让运维一眼看出还要先修权限。
   */
  async function markFailed(
    poolClient: BackupCopySqlClient | null,
    requestId: string,
    userId: string,
    module: string,
    errorCode: string,
  ): Promise<boolean> {
    if (poolClient === null) return false;
    try {
      await poolClient.query(MARK_FAILED_SQL, [requestId, userId, module, errorCode, now().toISOString()]);
      return true;
    } catch {
      return false;
    }
  }

  return {
    kind: 'wired',
    available: true,
    async purge({ userId, module, requestId }: { userId: string; module: string; requestId?: string }): Promise<BackupPurgeResult> {
      if (!pool || typeof pool.connect !== 'function') {
        // 没有事务能力＝装配未完成：如实 blocked（STORE_UNREACHABLE），⛔ 不静默退回「pending 假装没轮到」。
        return { purged: false, outcome: 'blocked', errorCode: 'STORE_UNREACHABLE', reason: '备份副本库不可用' };
      }
      assertUuid(userId, 'userId');
      const request = assertUuid(requestId, 'requestId');
      let client: { query: BackupCopySqlClient['query']; release?: () => void } | undefined;
      try {
        client = await pool.connect();
      } catch (error) {
        void error;
        return { purged: false, outcome: 'blocked', errorCode: 'STORE_UNREACHABLE', reason: '备份副本库不可用' };
      }
      try {
        // ---- 1. 读当前状态（每次重读；不缓存） ----
        const before = await readCopies(client, request, userId, module);
        const decision = evaluateBackupPurge({
          now: now(),
          copies: before.map((row) => ({
            state: row.state,
            retentionUntil: row.retentionUntil,
            // 附带的摘要字段会被 evaluateBackupPurge 原样复制到 dueCopies（`{...copy}`）。
            payloadDigest: row.payloadDigest,
          })),
        }) as {
          action: string;
          reason: string;
          dueCopies: ReadonlyArray<{ state: string; retentionUntil: Date; payloadDigest?: string }>;
        };

        if (decision.action === 'blocked') {
          // 已存在 failed 行 ⇒ 清不掉（重放不会自愈，需显式重排）；输入非法 ⇒ 策略阻断，不猜。
          return decision.reason === BACKUP_PURGE_REASONS.COPY_FAILED
            ? { purged: false, outcome: 'blocked', errorCode: 'STORE_REJECTED', reason: '已有清除失败行，需显式重排' }
            : { purged: false, outcome: 'blocked', errorCode: 'POLICY_BLOCKED', reason: '副本行输入非法' };
        }
        if (decision.action === 'wait') {
          return { purged: false, outcome: 'waiting', reason: BACKUP_PURGE_REASONS.WAITING_RETENTION };
        }
        if (decision.action === 'none') {
          if (decision.reason === BACKUP_PURGE_REASONS.NO_COPIES) {
            // 没有副本行 ≠ 没有副本：清单根本没写，30 天后没有可清对象，等不会自愈。
            return { purged: false, outcome: 'blocked', errorCode: 'EVIDENCE_REQUIRED', reason: '无副本清单行，无法证明已清除' };
          }
          // ALL_PURGED：只复核持久行，不伪造新证据，也不降级成 pending（设计 §7.5）。
          return reviewPassed(before)
            ? {
                purged: true,
                outcome: 'purged',
                evidenceRef: purgeEvidenceRef({
                  requestId: request,
                  module,
                  payloadDigests: before.map((row) => row.payloadDigest),
                }),
              }
            : { purged: false, outcome: 'blocked', errorCode: 'EVIDENCE_REQUIRED', reason: '已清状态复核不通过' };
        }

        // ---- 2. purge：到期清除，证据按「排序后的 payload_digest」计算 ----
        // 同一受理下所有副本行的 retention_until 都等于 backup_due_at，因此同模块的行同时到期；
        // 若仍出现部分到期（时钟/写入错位），下方复核会失败并如实 blocked，而不是只清一半就报完成。
        const dueDigests = decision.dueCopies.map((copy) => String(copy.payloadDigest ?? ''));
        if (dueDigests.length === 0 || dueDigests.some((digest) => digest.length === 0)) {
          return { purged: false, outcome: 'blocked', errorCode: 'EVIDENCE_REQUIRED', reason: '到期行缺少摘要，无法生成证据' };
        }
        const evidenceRef = purgeEvidenceRef({ requestId: request, module, payloadDigests: dueDigests });
        const at = now().toISOString();
        let purgedRows: Array<Record<string, unknown>>;
        try {
          await client.query('BEGIN');
          await client.query(LOCK_TIMEOUT_SQL);
          const updated = await client.query(PURGE_COPIES_SQL, [request, userId, module, at, evidenceRef]);
          purgedRows = updated.rows;
          // 复核在**同一事务内**做：读到的是清除后的真实状态，不是 UPDATE 的返回值。
          const after = await readCopies(client, request, userId, module);
          if (!reviewPassed(after)) {
            await client.query('ROLLBACK').catch(() => {});
            const marked = await markFailed(client, request, userId, module, 'EVIDENCE_REQUIRED');
            return {
              purged: false,
              outcome: 'blocked',
              errorCode: 'EVIDENCE_REQUIRED',
              reason: marked ? '清除后复核不通过' : '清除后复核不通过，且失败留痕未写入（先修权限/连接）',
            };
          }
          await client.query('COMMIT');
          void purgedRows;
          return { purged: true, outcome: 'purged', evidenceRef };
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          const marked = await markFailed(client, request, userId, module, 'STORE_UNREACHABLE');
          void isTransientDatabaseError(error);
          return {
            purged: false,
            outcome: 'blocked',
            errorCode: 'STORE_UNREACHABLE',
            reason: marked ? '清除事务失败' : '清除事务失败，且失败留痕未写入（先修权限/连接）',
          };
        }
      } catch {
        // 读都读不到（连接/权限/形状）⇒ 如实 blocked；不返回 pending（那会被读成「还没轮到」）。
        return { purged: false, outcome: 'blocked', errorCode: 'STORE_UNREACHABLE', reason: '备份副本状态不可读' };
      } finally {
        client.release?.();
      }
    },
  };
}
