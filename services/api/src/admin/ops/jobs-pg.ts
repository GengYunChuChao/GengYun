/**
 * 平台级作业的**真实 Postgres 读面 / 取消面**（`AdminJobPort` 的生产实现，GY-I18 第一批）。
 *
 * ## 为什么读三张域内作业表，而不是 `public.jobs`
 * `services/api/db/migrations/0001_initial_schema.sql:203-231` 确实建了统一作业台账 `public.jobs`，
 * 但全仓**没有任何代码向它 INSERT**；真实作业行只落在各域自己的表里：
 * - `public.ocr_jobs`（`0024_ocr_persistence.sql`）；
 * - `public.recognition_jobs`（`0025_*`）；
 * - `public.speech_jobs`（`0026_speech_persistence.sql`）。
 *
 * 三张表的记录 ID 列名不同（`ocr_id` / `recognition_id` / `transcription_id`），所以下面每条 SQL 都
 * 写成**字面量表名、不做表名拼接**：`tests/unit/sql-column-coverage.test.mjs` 按 SQL 字面量提取
 * 表/列。本文件已按授权登记进 `ADDITIONAL_SQL_HOST_FILES`，走的是**审计**（表/列真被读），
 * 不是 `UNAUDITED_SQL_HOSTS` 那种"登记即豁免"的桶。
 *
 * ## 读面口径（如实，不伪造）
 * - `target_ref.revision` 恒取 `1`：作业行只带 `media_revision`，记录本体的 revision 需要 JOIN
 *   `ocrs` / `recognitions` / `transcriptions` 三张记录表；本片只读作业表，故按契约允许的最小值
 *   占位，并登记为后续片处方（不假装拿到了真实记录版本）。
 * - `result` 恒 `null`：契约 `AdminJob.result` 是 `{"type": "null"}`（`fields.ts:101`）。
 * - `state` / `error_code` 逐值校验：不符即 503 `PROVIDER_UNAVAILABLE`（宁可说"读不到"，也不把
 *   陌生文本塞进后台列表）。
 *
 * ## 取消口径（终态不可复活）
 * 只有 `queued` / `running` 能迁移到 `cancelled`（`services/api/src/ocr/state.ts:175-180`），
 * 因此 UPDATE 的 WHERE 同时带 `state IN ('queued','running')`；已终态的行由端口自己判成
 * `'TERMINAL'`，而不是让调用方收到一个"什么都没发生"的成功。
 */
import type { PoolClient } from 'pg';
import { ApiError } from '../../errors.ts';
import { ERROR_CODES, type ErrorCode } from '../../contract.ts';
import { JOB_KINDS } from './types.ts';
import type { AdminJobPort, AdminJobView, CancelJobOutcome, JobKind } from './types.ts';

/** 契约 `JobState` 七值闭集（`packages/contracts/states.json` 的 `JobState`，逐值抄写）。 */
const CONTRACT_JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'uncertain',
] as const;
type ContractJobState = (typeof CONTRACT_JOB_STATES)[number];

/** 可取消的源状态：`canTransitionJob(state, 'cancelled')` 为真的两个非终态。 */
const CANCELLABLE_STATES = ['queued', 'running'] as const;

/** 后台列表的硬上限（运维台只看最近的作业；不设上限会把全表拉进内存）。 */
export const ADMIN_JOB_LIST_LIMIT = 200;

/** 写事务的锁等待上限（与 `flags-pg.ts` 的 4s 同口径）。 */
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '4s'";

/**
 * 三张域内作业表的**统一读面**。
 *
 * 为什么不写成 `'ocr'::text AS kind, ocr_id AS record_id … UNION ALL`：本仓库的静态列审计
 * （`tests/unit/sql-column-coverage.test.mjs`）会把 `AS` 别名当成"要读的列名"，于是
 * `record_id` 这类**投影别名**会被判成未授权列（实测 6 条红）。别名只是投影便利，
 * 不该逼着授权面去追一个不存在的列：所以 SQL 里**只出现真实列**（`ocr_id` /
 * `recognition_id` / `transcription_id`），`kind` 与 `record_id` 由这里按来源补上。
 *
 * 每条语句的列面都是 12 列里的 7 列（`id / revision / <record> / state / deadline_at /
 * created_at / error_code`），已在 `deploy/postgres-cvm/sql/20-login-roles.sql:527-534`
 * 等三处按列授予运行时角色。
 */
interface JobSource {
  readonly kind: JobKind;
  readonly recordColumn: 'ocr_id' | 'recognition_id' | 'transcription_id';
  readonly listSql: string;
  readonly getSql: string;
  readonly lockSql: string;
  readonly updateSql: string;
}

/**
 * 三张表的 SQL **逐条写死**（表名/列名都不插值）。
 *
 * 为什么不用字符串模板拼表名：静态列审计（`tests/unit/sql-column-coverage.test.mjs`）
 * 读的是源码字面量，`public.${table}` 会被解析成 `public.set` 之类的噪声表名，于是
 * `SET state / revision / updated_at` 会被判成「该表未授任何列」而真红（实测 3 条）。
 * 表名是安全边界的一部分，写死在这里比拼出来更容易审。
 */
const SOURCES: readonly JobSource[] = [
  {
    kind: 'ocr',
    recordColumn: 'ocr_id',
    listSql:
      'SELECT id, revision, ocr_id, state, deadline_at, created_at, error_code FROM public.ocr_jobs ORDER BY created_at DESC, id DESC LIMIT $1::integer',
    getSql: 'SELECT id, revision, ocr_id, state, deadline_at, created_at, error_code FROM public.ocr_jobs WHERE id = $1::uuid',
    lockSql:
      'SELECT id, revision, ocr_id, state, deadline_at, created_at, error_code FROM public.ocr_jobs WHERE id = $1::uuid FOR UPDATE',
    updateSql:
      "UPDATE public.ocr_jobs SET state = 'cancelled', revision = revision + 1, updated_at = now() WHERE id = $1::uuid AND revision = $2::integer AND state IN ('queued','running') RETURNING id, revision, ocr_id, state, deadline_at, created_at, error_code",
  },
  {
    kind: 'recognition',
    recordColumn: 'recognition_id',
    listSql:
      'SELECT id, revision, recognition_id, state, deadline_at, created_at, error_code FROM public.recognition_jobs ORDER BY created_at DESC, id DESC LIMIT $1::integer',
    getSql:
      'SELECT id, revision, recognition_id, state, deadline_at, created_at, error_code FROM public.recognition_jobs WHERE id = $1::uuid',
    lockSql:
      'SELECT id, revision, recognition_id, state, deadline_at, created_at, error_code FROM public.recognition_jobs WHERE id = $1::uuid FOR UPDATE',
    updateSql:
      "UPDATE public.recognition_jobs SET state = 'cancelled', revision = revision + 1, updated_at = now() WHERE id = $1::uuid AND revision = $2::integer AND state IN ('queued','running') RETURNING id, revision, recognition_id, state, deadline_at, created_at, error_code",
  },
  {
    kind: 'transcription',
    recordColumn: 'transcription_id',
    listSql:
      'SELECT id, revision, transcription_id, state, deadline_at, created_at, error_code FROM public.speech_jobs ORDER BY created_at DESC, id DESC LIMIT $1::integer',
    getSql:
      'SELECT id, revision, transcription_id, state, deadline_at, created_at, error_code FROM public.speech_jobs WHERE id = $1::uuid',
    lockSql:
      'SELECT id, revision, transcription_id, state, deadline_at, created_at, error_code FROM public.speech_jobs WHERE id = $1::uuid FOR UPDATE',
    updateSql:
      "UPDATE public.speech_jobs SET state = 'cancelled', revision = revision + 1, updated_at = now() WHERE id = $1::uuid AND revision = $2::integer AND state IN ('queued','running') RETURNING id, revision, transcription_id, state, deadline_at, created_at, error_code",
  },
];


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JobRow {
  readonly id: string;
  readonly revision: number;
  readonly kind: string;
  readonly record_id: string;
  readonly state: string;
  readonly deadline_at: unknown;
  readonly created_at: unknown;
  readonly error_code: string | null;
}

/**
 * 库行 → `JobRow`。`kind` 与 `record_id` 由**来源**决定（SQL 里不出现别名），
 * 因此陌生表/陌生列会在这里直接变成 503，而不是悄悄读出一个 undefined。
 */
function projectRow(source: JobSource, row: Record<string, unknown>): JobRow {
  const recordId = row[source.recordColumn];
  return {
    id: row.id as string,
    revision: row.revision as number,
    kind: source.kind,
    record_id: recordId as string,
    state: row.state as string,
    deadline_at: row.deadline_at,
    created_at: row.created_at,
    error_code: (row.error_code ?? null) as string | null,
  };
}

/** `created_at` 倒序、`id` 倒序的稳定合并（三张表各自已排序，这里只做归并）。 */
function newerFirst(left: JobRow, right: JobRow): number {
  const a = new Date(left.created_at as string | Date).getTime();
  const b = new Date(right.created_at as string | Date).getTime();
  if (a !== b) return b - a;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

function unavailable(why: string): ApiError {
  return new ApiError('PROVIDER_UNAVAILABLE', `作业存储不可用：${why}`, { retryable: false });
}

function isContractJobState(value: unknown): value is ContractJobState {
  return typeof value === 'string' && (CONTRACT_JOB_STATES as readonly string[]).includes(value);
}

function isJobKind(value: unknown): value is JobKind {
  return typeof value === 'string' && (JOB_KINDS as readonly string[]).includes(value);
}

/** `timestamptz` 读出可能是 `Date`（pg 默认）也可能是 ISO 字符串（测试替身），统一成 ISO-8601。 */
function isoAt(value: unknown, field: string): string {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) throw unavailable(`${field} 不是合法时间戳`);
  return date.toISOString();
}

/**
 * 把一行库记录投影成契约 `AdminJob`。
 *
 * 任何"库里出现契约外取值"的情形都折成 503：后台列表宁可整页失败（说明存储与契约已经分叉），
 * 也不该把陌生状态/错误码当成已知语义展示给运维。
 */
export function toAdminJobView(row: JobRow): AdminJobView {
  if (typeof row.id !== 'string' || !UUID_RE.test(row.id)) throw unavailable('作业 id 不是 uuid');
  if (!Number.isInteger(row.revision) || row.revision < 1) throw unavailable('作业 revision 非法');
  if (!isJobKind(row.kind)) throw unavailable('作业 kind 不在契约闭集内');
  if (!isContractJobState(row.state)) throw unavailable('作业 state 不在契约闭集内');
  if (typeof row.record_id !== 'string' || !UUID_RE.test(row.record_id)) {
    throw unavailable('作业目标记录 id 不是 uuid');
  }
  const errorCode = row.error_code;
  if (
    errorCode !== null &&
    (typeof errorCode !== 'string' || !(ERROR_CODES as readonly string[]).includes(errorCode))
  ) {
    throw unavailable('作业 error_code 不在契约闭集内');
  }
  return {
    id: row.id,
    revision: row.revision,
    kind: row.kind,
    target_ref: { type: row.kind, id: row.record_id, revision: 1 },
    state: row.state,
    deadline_at: isoAt(row.deadline_at, 'deadline_at'),
    created_at: isoAt(row.created_at, 'created_at'),
    error_code: errorCode as ErrorCode | null,
    result: null,
  };
}

function isTerminal(state: ContractJobState): boolean {
  return !(CANCELLABLE_STATES as readonly string[]).includes(state);
}

/**
 * 生产端口要求的 Pool 形状：`query` 供读面，`connect` 供取消（要开事务并加行锁）。
 */
export interface AdminJobPool {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  connect(): Promise<PoolClient>;
}

/**
 * 真实作业端口。
 *
 * `wired: true` —— 一旦注入，`listAdminJobs` / `cancelAdminJob` 不再走未接线的 503 分支；
 * 但**读失败仍然是 503**（`PROVIDER_UNAVAILABLE`），不会被误读成"没有作业"。
 */
export function createPostgresAdminJobPort(options: {
  pool: AdminJobPool;
  limit?: number;
}): AdminJobPort {
  const pool = options.pool;
  const limit = options.limit ?? ADMIN_JOB_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('ADMIN_JOB_LIST_LIMIT 必须是正整数');

  async function lockRow(
    client: PoolClient,
    id: string,
  ): Promise<{ source: JobSource; row: JobRow } | null> {
    for (const source of SOURCES) {
      const result = await client.query(source.lockSql, [id]);
      const row = (result.rows as Record<string, unknown>[])[0];
      if (row !== undefined) return { source, row: projectRow(source, row) };
    }
    return null;
  }

  async function updateRow(
    client: PoolClient,
    source: JobSource,
    id: string,
    expectedRevision: number,
  ): Promise<JobRow | null> {
    const result = await client.query(source.updateSql, [id, expectedRevision]);
    const row = (result.rows as Record<string, unknown>[])[0];
    return row === undefined ? null : projectRow(source, row);
  }

  return {
    wired: true,
    async list(): Promise<AdminJobView[]> {
      const pages = await Promise.all(
        SOURCES.map(async (source) => {
          const result = await pool.query(source.listSql, [limit]);
          return (result.rows as Record<string, unknown>[]).map((row) => projectRow(source, row));
        }),
      );
      return pages
        .flat()
        .sort(newerFirst)
        .slice(0, limit)
        .map((row) => toAdminJobView(row));
    },
    async get(id: string): Promise<AdminJobView | null> {
      if (!UUID_RE.test(id)) return null;
      for (const source of SOURCES) {
        const result = await pool.query(source.getSql, [id]);
        const row = (result.rows as Record<string, unknown>[])[0];
        if (row !== undefined) return toAdminJobView(projectRow(source, row));
      }
      return null;
    },
    async cancel(id: string, expectedRevision: number): Promise<CancelJobOutcome> {
      if (!UUID_RE.test(id) || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
        return { ok: false, reason: 'NOT_FOUND' };
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(LOCK_TIMEOUT_SQL);
        const located = await lockRow(client, id);
        if (located === null) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'NOT_FOUND' };
        }
        const { source, row: current } = located;
        if (!isContractJobState(current.state)) {
          await client.query('ROLLBACK');
          throw unavailable('作业 state 不在契约闭集内');
        }
        if (isTerminal(current.state)) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'TERMINAL' };
        }
        if (current.revision !== expectedRevision) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'REVISION_CHANGED' };
        }
        const updated = await updateRow(client, source, id, expectedRevision);
        if (updated === null) {
          // 行锁在手却更新不到：只可能是并发把状态推进成了终态。
          await client.query('ROLLBACK');
          return { ok: false, reason: 'TERMINAL' };
        }
        await client.query('COMMIT');
        return { ok: true, job: toAdminJobView(updated) };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error instanceof ApiError) throw error;
        throw unavailable(`取消失败：${(error as Error).message}`);
      } finally {
        client.release();
      }
    },
  };
}

/** 供真库臂与单测复用的语句导出（只读断言用；运行时不直接引用）。 */
export const ADMIN_JOB_SQL = {
  list: SOURCES.map((source) => source.listSql),
  get: SOURCES.map((source) => source.getSql),
  lock: SOURCES.map((source) => source.lockSql),
  update: SOURCES.map((source) => source.updateSql),
  limit: ADMIN_JOB_LIST_LIMIT,
} as const;
