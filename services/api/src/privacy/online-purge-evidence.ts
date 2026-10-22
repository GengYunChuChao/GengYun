/**
 * GY-R32 · #19 片B · **在线清理证据的落库端口**（迁移 0031 的唯一写路径）。
 *
 * ## 它补的缺口
 * 在线域的清空原本只在**命令报告 stdout** 里留 `sha256:` 摘要（见
 * `services/api/src/privacy/online-purge-driver.ts` 文件头「证据为什么只进报告、不落库」）：
 * 报告是 cron 日志，不是台账 —— 回执读路径拿不到它，换进程更拿不到。
 * 本文件把「每个成功 (request, module) 行」的证据写进
 * `public.deletion_requests.online_purge_evidence`（append-only jsonb 数组）：
 *   - 写入走**唯一**窄口径 `SECURITY DEFINER` 函数 `public.record_online_purge_evidence(...)`；
 *   - 运行时角色对 `deletion_requests` **仍然零表级零列级权限**（授权面只在
 *     `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r32-i19-online-evidence-grant` 段，
 *     且 `90-assert-least-privilege.sql` 的 `online_evidence_*` 断言把形状钉死）。
 *
 * ## 证据摘要口径（与驱动同一条纯函数）
 * `onlinePurgeEvidenceRef({ requestId, module, removed, idempotency })`
 * ⇒ `sha256:…`。因此读路径能用落库的 `removed/idempotency` **独立复算**并逐条比对
 * （见 `services/api/src/privacy/online-state-derivation.ts`）；⛔ 不存正文、标题、身份信息。
 *
 * ## 幂等
 * 同一 `(module, evidence_ref)` 重复写入由库函数挡住（数组里已有 ⇒ 不追加）。
 * 所以「重跑 0 行」与「重试同一成功行」都不会制造重复证据。
 */
import { PrivacyError } from '../../../../packages/privacy/errors.mjs';
import { onlinePurgeEvidenceRef, type OnlinePurgeSqlClient } from './online-purge-driver.ts';

/**
 * 唯一写路径的 SQL（**只有**这一条；形状/幂等/不存在都在函数体里判定）。
 *
 * `p_purged_at` 由调用方注入（驱动用本轮**唯一** cutoff，处理器用应用时钟），
 * ⛔ 不在 SQL 里再取一次 `now()`：那会让"证据时刻"与"到期判定时刻"来自两个时钟。
 */
export const ONLINE_PURGE_EVIDENCE_RECORD_SQL = `SELECT result
  FROM public.record_online_purge_evidence(
    $1::uuid, $2::text, $3::text, $4::integer, $5::integer, $6::timestamptz
  ) AS result`;

/** 唯一读路径的 SQL（按 `(request_id, user_id)` 过滤；读不到行返回 NULL）。 */
export const ONLINE_PURGE_EVIDENCE_READ_SQL = `SELECT state
  FROM public.read_online_purge_evidence($1::uuid, $2::uuid) AS state`;

/** 证据写入的**非个人数据**入参：谁（requestId）、哪个域、清了多少行、何时。 */
export interface OnlinePurgeEvidenceRecordInput {
  requestId: string;
  module: string;
  /** 正文表真实删除行数（含 0：0 是"这一域这次没有行"的可区分读数）。 */
  removed: number;
  /** 本域幂等台账真实删除行数（含 0）。 */
  idempotency: number;
  /** 证据时刻；缺省用端口时钟（驱动会显式传本轮 cutoff）。 */
  purgedAt?: Date | string;
}

/**
 * 驱动与处理器共用的**证据端口**（结构化类型：驱动只依赖这个形状，不 import 本文件 ⇒ 无循环依赖）。
 *
 * 失败语义：抛错即"这一行的证据没落库"。驱动把它折成 `EVIDENCE_WRITE_FAILED` 失败行；
 * 处理器把模块折成 blocked —— ⛔ 两边都不得把"写失败"当成功。
 */
export interface OnlinePurgeEvidenceRecorder {
  readonly kind: 'postgres';
  readonly available: true;
  record(input: OnlinePurgeEvidenceRecordInput): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE_RE = /^[a-z][a-z0-9_]{0,63}$/;

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new PrivacyError('SESSION_REQUIRED', `缺少身份/受理上下文：${field}`);
  }
  return value;
}

/** 模块名闭集形状（与迁移 0031 函数体的 `~ '^[a-z][a-z0-9_]{0,63}$'` 同一口径）。 */
function assertModule(value: unknown): string {
  if (typeof value !== 'string' || !MODULE_RE.test(value)) {
    throw new PrivacyError('STORE_REJECTED', '在线证据的模块名形状非法');
  }
  return value;
}

function assertCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new PrivacyError('STORE_REJECTED', `在线证据的 ${field} 必须是非负整数`);
  }
  return value;
}

/** 证据时刻归一：只接受 `Date` 或带时区的 ISO-8601（裸本地时间一律拒绝，理由同驱动）。 */
function assertInstant(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    // `Date.parse` 对裸本地时间也返回数字 ⇒ 用 `toISOString()` 回写做一次"必须带时区"的判据。
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      return new Date(Date.parse(value));
    }
  }
  throw new PrivacyError('STORE_REJECTED', '在线证据需要可解析的带时区时刻');
}

/** SQL 错误码 → 契约安全码（G0001 参数非法 / G0002 请求不存在；其余原样冒泡给上层的分类器）。 */
function toSafeEvidenceError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'G0001') return new PrivacyError('INVALID_REQUEST', '在线证据入参非法');
  if (code === 'G0002') return new PrivacyError('NOT_FOUND', '在线证据对应的注销请求不存在');
  return error;
}

/**
 * 建**真实**的证据落库端口（PG 唯一写路径）。
 *
 * - `client` 优先（单测/运维脚本直接给一个客户端）；否则用 `pool.connect()` 并在 `finally` 释放；
 * - 每次 `record()` 都是独立语句（不包事务）：证据是**追认**已经完成的删除，不需要和删除同事务
 *   （删除由各域 store 自己的事务保证；证据写失败 ⇒ 让调用方落失败，而不是回滚已经删掉的数据 ——
 *   回滚删除既做不到也不该做）。
 */
export function createPostgresOnlinePurgeEvidenceRecorder({
  pool,
  client,
  now = () => new Date(),
}: {
  pool?: { connect(): Promise<OnlinePurgeSqlClient & { release?(): void }> };
  client?: OnlinePurgeSqlClient;
  now?: () => Date;
}): OnlinePurgeEvidenceRecorder {
  async function recordWith(sql: OnlinePurgeSqlClient, input: OnlinePurgeEvidenceRecordInput): Promise<void> {
    const requestId = assertUuid(input.requestId, 'requestId');
    const module = assertModule(input.module);
    const removed = assertCount(input.removed, 'removed');
    const idempotency = assertCount(input.idempotency, 'idempotency');
    const purgedAt = input.purgedAt === undefined ? assertInstant(now()) : assertInstant(input.purgedAt);
    const evidenceRef = onlinePurgeEvidenceRef({ requestId, module, removed, idempotency });
    try {
      await sql.query(ONLINE_PURGE_EVIDENCE_RECORD_SQL, [
        requestId,
        module,
        evidenceRef,
        removed,
        idempotency,
        purgedAt.toISOString(),
      ]);
    } catch (error) {
      throw toSafeEvidenceError(error);
    }
  }

  return {
    kind: 'postgres',
    available: true,
    async record(input) {
      if (client !== undefined) {
        await recordWith(client, input);
        return;
      }
      if (pool === undefined || typeof pool.connect !== 'function') {
        throw new PrivacyError('PROVIDER_UNAVAILABLE', '在线证据落库需要数据库连接：未提供连接池');
      }
      const connection = await pool.connect();
      try {
        await recordWith(connection, input);
      } finally {
        connection.release?.();
      }
    },
  };
}
