/**
 * GY-R28 S20（#20）· 录音转写域的 **PostgreSQL 实现**（迁移 `0026_speech_persistence.sql`）。
 *
 * 逐方法与 `speech/store.ts` 的内存实现对齐（本文件验收口径是**逐条**对齐，不是"大致等价"）：
 *   - `insertJob` / `insertTranscription`：**唯一**写入口，同一 `id` 再写 ⇒ 抛错（文案与内存实现逐字相同：
 *     `任务 id 冲突` / `转写记录 id 冲突`）。重复判定**只**由主键裁决（`23505`），
 *     不存在"先 SELECT 再 INSERT"的检查-写入窗口。
 *   - `getJob` / `getTranscription`：按主键单条读取；不存在 ⇒ `null`（与 Map 未命中同形）。
 *   - `updateJob` / `updateTranscription`：CAS。**判定权在那条带 `WHERE revision = $2` 的 UPDATE**——
 *     读一次只为算出 `mutate` 的结果；并发写不会被覆盖：输的那条 UPDATE 返回 0 行 ⇒ 返回 `null`
 *     （不是"读到旧值就认为成功"）。`updateTranscription` 另加**原始输出不可变**：
 *     `mutate` 返回的行若改了 `rawText` 或改/增/删/重排 `uncertainSpans`，直接抛错（与内存实现同文案），
 *     ⛔ 绝不静默接受 —— 这是「raw_text 与 confirmed_text 严格分离」在存储层的最后一道闸。
 *   - `commitTerminal`：**同一事务**内完成「行锁读 + CAS 校验 + 合法迁移校验 + 写转写记录（可为 null）
 *     + 落任务终态」。CAS 失败（任务已被取消/已终态）⇒ 返回 `null` 且**不写任何记录**（旧回调不复活）；
 *     记录 id 冲突 ⇒ 抛错且任务行不变（事务回滚）。状态机的唯一事实来源仍是
 *     `speech/state.ts` 的 `canTransitionJob`（**不**在 SQL 里再抄一份迁移表）。
 *   - 幂等台账：`findIdempotent` / `claimIdempotent` / `finalizeIdempotent` / `releaseIdempotent` /
 *     `purgeIdempotent` 五个方法各是**一条**语句。`claimIdempotent` 的"检查 + 写入"是单条
 *     `INSERT … ON CONFLICT (scope, key_hash) DO NOTHING RETURNING scope`：写入并返回行 ⇒ `'claimed'`；
 *     已存在 ⇒ 不写入、不返回行 ⇒ `'exists'`。**并发下只有一个调用方拿到 `claimed`**，
 *     也没有"先查后写"的窗口。到期条目的重新占位靠**调用方先清理**：`speech/service.ts:307`
 *     在 claim 之前 `await store.purgeIdempotent(at)` 物理删除到期行，故 `DO NOTHING`
 *     不会把"已过期"误判成"仍在占位"；`purgeIdempotent` 在 0026 上删除的是本域自己的行。
 *     `findIdempotent` **不**按过期过滤（与内存实现逐条一致）。
 *     `finalizeIdempotent` / `releaseIdempotent` 对"行不存在"是**空操作**（内存实现同样是 `return` /
 *     `delete` 未命中）。
 *
 * 连接与事务：沿用仓库既有 PG 方式（与 `ocr/store-pg.ts` / `recognitions/store-pg.ts` 同口径）：
 * `pool.connect()` → `BEGIN` → `SET LOCAL lock_timeout = '4s'` → 业务 SQL → `COMMIT`
 * （异常 `ROLLBACK`）。只有需要临界区的 `commitTerminal` 走事务；其余方法各是单条语句。
 * ⛔ 缺 `connect()` 的池不会被静默降级成"无事务的两步写"：`commitTerminal` 会如实失败
 * （`PROVIDER_UNAVAILABLE`），因为"CAS 失败不写记录"这条不变量没有事务就无法保证。
 *
 * 错误折叠（与 `ocr/store-pg.ts` 逐条同口径）：`57014`（语句超时）/`55P03`（锁不可得）⇒
 * `PROVIDER_TIMEOUT`；其余**数据库**异常 ⇒ `PROVIDER_UNAVAILABLE`。存储层自身的唯一性冲突用
 * `SpeechStoreConflictError`（`instanceof Error`、文案与内存实现相同），**不**被折成数据库错误；
 * 无驱动程序错误码的异常（`mutate`/内部不变式抛出的错）**原样抛出**，不被折成 provider 故障。
 *
 * **三态就绪判定（缺表 ≠ 库坏）**：迁移 `0026` 未应用时（例如真库集成测试只跑迁移子集），
 *   - **读**（`getJob` / `getTranscription` / `findIdempotent`）⇒ `null`，等价于「没有已持久化的行」，
 *     与接线前内存 store 的对外行为一致；
 *   - **写**（其余 9 个方法）⇒ 抛 `SpeechTablesMissingError`（**点名** `0026_speech_persistence.sql`，
 *     `retryable: false`），⛔ 绝不静默丢写、⛔ 绝不退化成内存 store；
 *   - **探测失败**（连接/权限/超时/形状读不懂）⇒ `unknown`，**不是** `missing`：按数据库故障
 *     fail-closed（`PROVIDER_*`），⛔ 不把"探不了"当"没装"——否则一次超时就会让读路径静默返回 `null`。
 *
 * **授权（本片不做，如实登记）**：`0026` 不新增 GRANT，`deploy/postgres-cvm/**` 未被本片改动。
 * 运行时角色访问本域三表会得到 `42501`（`insufficient_privilege`）⇒ 按上面的错误折叠是
 * `PROVIDER_UNAVAILABLE`（可诊断的 503）。补齐权限属**后续授权片**，⛔ 不得在本文件里兜住 `42501`
 * 伪装成 `missing` 或静默降级。
 */
import type { ErrorCode } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { isTransientDatabaseError } from '../db/pool.ts';
import { canTransitionJob, isJobState, type JobState, type UncertainSpan } from './state.ts';
import {
  sameSpans,
  type IdempotencyRow,
  type SpeechJobRow,
  type SpeechOwnerPurgeCounts,
  type SpeechStore,
  type TranscriptionRow,
} from './store.ts';

/** `pg` 连接池/连接的最小形状（与 `db/pool.ts` 的 `PgPool` 结构兼容）。 */
export interface SqlRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PgConnection extends SqlRunner {
  release(): void;
}

/** 带事务能力的连接池（`PgPool` 结构兼容；测试可传记录型假池）。 */
export interface TransactionalPool extends SqlRunner {
  connect(): Promise<PgConnection>;
}

export interface PostgresSpeechStoreOptions {
  pool: TransactionalPool;
}

/** 存储层自身的唯一性冲突：文案与内存实现逐字相同，且不被数据库异常折叠改写。 */
export class SpeechStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechStoreConflictError';
  }
}

/**
 * **「转写持久化表未迁移（0026）」** —— 与「数据库故障」严格区分的一类明确错误。
 *
 * 语义（与 `ocr/store-pg.ts` 的 `OcrTablesMissingError` 同族纪律）：
 * - **读类**：表不存在 ⇒ 返回 `null`（与接线前内存 store 的对外行为一致）；
 * - **写类**：表不存在 ⇒ **fail-closed** 并抛本错误（点名迁移号），⛔ 绝不静默丢写、
 *   ⛔ 绝不退化成内存 store；
 * - `retryable: false`：这是**部署/迁移未执行**，不是瞬时故障 —— 重试不会好，须跑 `0026`。
 */
export class SpeechTablesMissingError extends ApiError {
  constructor() {
    super(
      'PROVIDER_UNAVAILABLE',
      '转写持久化表未迁移（0026_speech_persistence.sql）：拒绝写入，避免静默丢数据',
      { retryable: false },
    );
    this.name = 'SpeechTablesMissingError';
  }
}

/** 数据库异常的契约化折叠（与 `ocr/store-pg.ts` / `messages/store-pg.ts` 逐条同口径）。 */
export function classifySpeechDatabaseError(error: unknown): never {
  if (error instanceof SpeechStoreConflictError) throw error;
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') {
    // 无驱动程序错误码 ⇒ 不是数据库故障（多半是 mutate / 内部不变式抛的错）：**原样抛出**，
    // 不折成 provider 故障，否则真正的实现缺陷会被伪装成"数据库暂不可用"。
    throw error;
  }
  if (code === '57014' || code === '55P03') {
    throw new ApiError('PROVIDER_TIMEOUT', '转写数据库响应超时', { retryable: true });
  }
  // `retryable` 分档（口径原文见 `../errors.ts` 的 `ApiError` 注释）：连接层故障（08xxx）、管理员干预
  // （53xxx / 57P0x）、串行化冲突（40001）、死锁（40P01）⇒ 同一请求稍后重试**确实**可能成功 ⇒ true；
  // 权限不足（42501）、库/表/凭据缺失（3D000 / 28P01 / 42P01）、函数缺失（42883）与无法归类的其余
  // 驱动错误 ⇒ 需运维改配置或修缺陷，重试永远不会好 ⇒ false（⛔ 恒 true 会把权限缺失伪装成下游抖动）。
  throw new ApiError('PROVIDER_UNAVAILABLE', '转写数据库暂不可用', { retryable: isTransientDatabaseError(error) });
}

/**
 * `42P01`（`undefined_table`）＝「这条 SQL 指向的表不在」。本文件所有语句都写成
 * `public.speech_*` / `public.transcriptions` **全限定**形式，因此它只可能表示
 * 「0026 未应用（或刚被回滚）」，不会被 `search_path` 差异误判 ⇒ 可安全地翻成
 * {@link SpeechTablesMissingError}。
 */
const UNDEFINED_TABLE = '42P01';
const isUndefinedTable = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === UNDEFINED_TABLE;

/**
 * 迁移 `0026` 的**只读就绪探测**：三张表是否真实存在。
 *
 * 为什么是一条语句查三张表：三表由**同一个迁移文件**建出（单事务，不可能半建），
 * 但探测仍逐表 `IS NOT NULL` —— 若真的出现半迁移（人为 DROP、恢复不完整），
 * 也应判「未就绪」而不是让读路径看到一半的表。
 *
 * 为什么用 `to_regclass(...)` 而不是 `SELECT 1 FROM public.speech_jobs`：
 * 表不存在时 `to_regclass` 返回 `NULL`（**不报错**），且**不依赖表级 SELECT 权限**，
 * schema 全限定 ⇒ 运行时角色受限的 `search_path` 也解析得到（与 `flags-pg.ts` 同口径）。
 */
const TABLES_READY_SQL =
  "SELECT (to_regclass('public.speech_jobs') IS NOT NULL"
  + " AND to_regclass('public.transcriptions') IS NOT NULL"
  + " AND to_regclass('public.speech_idempotency') IS NOT NULL) AS ready";

/** 就绪探测的三态：`unknown`（探不了）**不是** `missing`（确认没有）—— #282 的同族纪律。 */
export type SpeechTablesProbe = 'ready' | 'missing' | 'unknown';

const JOB_COLUMNS =
  'id, revision, kind, owner_user_id, transcription_id, media_id, media_revision, state, deadline_at, created_at, updated_at, error_code';
const RECORD_COLUMNS =
  'id, revision, owner_user_id, media_id, media_revision, raw_text, uncertain_spans, confirmed_text, confirmed_at, model_version, created_at, updated_at, deleted';

const INSERT_JOB = `INSERT INTO public.speech_jobs (${JOB_COLUMNS})
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12)
  RETURNING id`;

const INSERT_RECORD = `INSERT INTO public.transcriptions (${RECORD_COLUMNS})
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7::jsonb, $8, $9::timestamptz, $10, $11::timestamptz, $12::timestamptz, $13)
  RETURNING id`;

/** 内存实现的 `new Error(...)` 文案（逐字相同：调用方/测试按 message 判定，不改写成新文案）。 */
const JOB_CONFLICT_MESSAGE = '任务 id 冲突';
const RECORD_CONFLICT_MESSAGE = '转写记录 id 冲突';
/** 内存实现里「原始输出不可变」的抛错文案（逐字相同，见 `speech/store.ts:196`）。 */
const RAW_IMMUTABLE_MESSAGE = '转写记录的 raw_text / uncertain_spans 不可改写（存储层不变量）';

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23505';
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(String(value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * jsonb 列读出：`pg` 正常会把 jsonb 解析成 JS 值；只在拿到字符串时兜底解析。
 * 解析失败**不**返回空数组（那会把坏行伪装成合法行）——返回 `null` 交给调用方的形状判据拒绝。
 */
function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function invariant(what: string): ApiError {
  return new ApiError('PROVIDER_UNAVAILABLE', `转写 ${what}形状不合约定（内部不变式违反）`, {
    retryable: false,
  });
}

/** `string | null`；类型不符返回 `undefined`（与"显式 null"区分开，后者是合法值）。 */
function textOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

/** 数据库行 → 契约 `UncertainSpan[]`（逐项校验；reason 不得为空串 —— 与 state.ts 的 gate 同界）。 */
function readSpans(value: unknown): UncertainSpan[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) throw invariant('uncertain_spans');
  return parsed.map((item) => {
    const record = asRecord(item);
    if (record === null) throw invariant('uncertain_spans');
    const start = record['start'];
    const end = record['end'];
    const reason = record['reason'];
    if (typeof start !== 'number' || typeof end !== 'number' || typeof reason !== 'string') {
      throw invariant('uncertain_spans');
    }
    return { start, end, reason };
  });
}

/** 幂等台账 `payload`：只存**不含凭据**的结果引用（如 `{job_id}` / `{accepted}`）。 */
function readPayload(value: unknown): Record<string, unknown> {
  const record = asRecord(parseJson(value));
  if (record === null) throw invariant('幂等台账 payload');
  return { ...record };
}

/** 数据库行 → 内部任务行（未知 state/kind 按内部不变式违反处理，不静默降级）。 */
function jobRowFromRow(row: Record<string, unknown>): SpeechJobRow {
  const state = row['state'];
  if (typeof state !== 'string' || !isJobState(state)) throw invariant('任务 state');
  if (row['kind'] !== 'transcription') throw invariant('任务 kind');
  const errorCode = row['error_code'] === null || row['error_code'] === undefined ? null : String(row['error_code']);
  return {
    id: String(row['id']),
    revision: Number(row['revision']),
    kind: 'transcription',
    ownerUserId: String(row['owner_user_id']),
    transcriptionId: String(row['transcription_id']),
    mediaId: String(row['media_id']),
    mediaRevision: Number(row['media_revision']),
    state: state as JobState,
    deadlineAt: asDate(row['deadline_at']),
    createdAt: asDate(row['created_at']),
    updatedAt: asDate(row['updated_at']),
    errorCode: errorCode as ErrorCode | null,
  };
}

/** 数据库行 → 内部转写记录行。 */
function transcriptionRowFromRow(row: Record<string, unknown>): TranscriptionRow {
  const confirmedText = textOrNull(row['confirmed_text']);
  if (confirmedText === undefined) throw invariant('转写记录 confirmed_text');
  const confirmedAtRaw = row['confirmed_at'];
  if (confirmedAtRaw !== null && confirmedAtRaw !== undefined && typeof confirmedAtRaw !== 'string'
    && !(confirmedAtRaw instanceof Date)) {
    throw invariant('转写记录 confirmed_at');
  }
  return {
    id: String(row['id']),
    revision: Number(row['revision']),
    ownerUserId: String(row['owner_user_id']),
    mediaId: String(row['media_id']),
    mediaRevision: Number(row['media_revision']),
    rawText: String(row['raw_text']),
    uncertainSpans: readSpans(row['uncertain_spans']),
    confirmedText,
    confirmedAt: confirmedAtRaw === null || confirmedAtRaw === undefined ? null : asDate(confirmedAtRaw),
    modelVersion: String(row['model_version']),
    createdAt: asDate(row['created_at']),
    updatedAt: asDate(row['updated_at']),
    deleted: row['deleted'] === true,
  };
}

function jobValues(row: SpeechJobRow): unknown[] {
  return [
    row.id,
    row.revision,
    row.kind,
    row.ownerUserId,
    row.transcriptionId,
    row.mediaId,
    row.mediaRevision,
    row.state,
    row.deadlineAt,
    row.createdAt,
    row.updatedAt,
    row.errorCode,
  ];
}

function recordValues(row: TranscriptionRow): unknown[] {
  return [
    row.id,
    row.revision,
    row.ownerUserId,
    row.mediaId,
    row.mediaRevision,
    row.rawText,
    JSON.stringify(row.uncertainSpans),
    row.confirmedText,
    row.confirmedAt,
    row.modelVersion,
    row.createdAt,
    row.updatedAt,
    row.deleted,
  ];
}

export function createPostgresSpeechStore({ pool }: PostgresSpeechStoreOptions): SpeechStore {
  /**
   * 就绪状态的**缓存**：只缓存**确定结论**（`ready` / `missing`）。
   * `null` = 未探过（或探测结果未知、或 42P01 后失效）⇒ 下一次调用重探。
   * ⛔ `unknown` 绝不写入本缓存 —— 把「探不了」当「没装」正是 #282 的缺陷成因。
   */
  let tables: 'ready' | 'missing' | null = null;

  /**
   * 最近一次探测失败的原因（只用于「未知」时**保持既有错误分类**：`57014`/`55P03` ⇒
   * `PROVIDER_TIMEOUT`，其余 ⇒ `PROVIDER_UNAVAILABLE`）。它**不**参与缓存判断
   * （`unknown` 不入缓存），因此不会把偶发故障粘成长期状态。
   */
  let probeFailure: unknown = null;

  /** 只读就绪探测（**不抛**：任何失败都以 `unknown` 返回，由调用方决定 fail-closed 策略）。 */
  async function probeTables(): Promise<SpeechTablesProbe> {
    probeFailure = null;
    let rows: unknown;
    try {
      rows = (await pool.query(TABLES_READY_SQL)).rows;
    } catch (error) {
      // 权限/连接/超时：**状态未知**。⛔ 不得返回 `missing`（那会把故障判成"未迁移"而放行读）。
      // 原因留给 `tablesReady`：真正连不上/超时仍按既有分类折成 PROVIDER_*（不吞掉分类）。
      probeFailure = error;
      return 'unknown';
    }
    if (!Array.isArray(rows) || rows.length === 0) return 'unknown';
    const ready = (rows[0] as Record<string, unknown> | null | undefined)?.['ready'];
    if (ready === true) return 'ready';
    if (ready === false) return 'missing';
    // 形状读不懂 ⇒ 不知道表在不在 ⇒ 未知（既不是「未就绪」，更不是「可以放行」）。
    return 'unknown';
  }

  /**
   * 取就绪状态（带缓存）。
   *
   * - `ready`：照常执行；
   * - `missing`：由调用方按「读 ⇒ null / 写 ⇒ {@link SpeechTablesMissingError}」分化处理；
   * - `unknown`（探测抛错/形状读不懂）：**抛**（fail-closed），⛔ 不缓存、⛔ 不当成 `missing`。
   */
  async function tablesReady(): Promise<'ready' | 'missing'> {
    if (tables !== null) return tables;
    const state = await probeTables();
    if (state === 'unknown') {
      // 探测抛错：先按**既有分类**折叠原因（57014/55P03 ⇒ PROVIDER_TIMEOUT，08xxx/40001 等瞬时 ⇒
      // PROVIDER_UNAVAILABLE + `retryable:true`，42501/28P01/42883 等运维动作 ⇒ `retryable:false`）。
      if (probeFailure !== null) classifySpeechDatabaseError(probeFailure);
      // 走到这里只剩「**应答形状读不懂**」（空行/非数组/`ready` 不是布尔）：这是确定性缺陷
      // （驱动或查询形状不对），同一请求重试永远不会变好 ⇒ `retryable:false`（R31-S-retryable 口径），
      // 原因分类入 `details` 供排障，⛔ 不再借「可能是抖动」把确定性失败标成可重试。
      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        '转写持久化表就绪探测结果未知（应答形状无法识别）：按数据库故障 fail-closed（未知 ≠ 未迁移）',
        { retryable: false, details: [{ field: 'speech_tables', code: 'PROBE_SHAPE_UNKNOWN' }] },
      );
    }
    tables = state;
    return state;
  }

  /** 写类的前置门：表不存在 ⇒ 明确 fail-closed（绝不静默丢写、绝不退化成内存 store）。 */
  async function requireTables(): Promise<void> {
    if ((await tablesReady()) === 'missing') throw new SpeechTablesMissingError();
  }

  async function run(text: string, values?: unknown[]): Promise<Array<Record<string, unknown>>> {
    try {
      const result = await pool.query(text, values);
      return result.rows;
    } catch (error) {
      if (isUndefinedTable(error)) {
        // 探测之后表被回滚/恢复不完整：失效缓存，下一次调用重探；本语句按「未迁移」处理。
        tables = null;
        throw new SpeechTablesMissingError();
      }
      return classifySpeechDatabaseError(error);
    }
  }

  /** 写类语句：唯一性冲突只在这里翻成与内存实现同文案的冲突错误。 */
  async function runWrite(text: string, values: unknown[], conflictMessage: string): Promise<void> {
    try {
      await pool.query(text, values);
    } catch (error) {
      if (isUniqueViolation(error)) throw new SpeechStoreConflictError(conflictMessage);
      if (isUndefinedTable(error)) {
        tables = null;
        throw new SpeechTablesMissingError();
      }
      classifySpeechDatabaseError(error);
    }
  }

  /**
   * 读类：表未迁移 ⇒ `null`（等价于「没有已持久化的行」，与接线前内存 store 的对外行为一致）；
   * **真数据库故障照旧抛**（不被这一层吞掉）。
   */
  async function readOrMissing<T>(work: () => Promise<T | null>): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof SpeechTablesMissingError) return null;
      throw error;
    }
  }

  /**
   * 把 `public.purge_owner_speech(...)` 回的 jsonb 读数收敛成本域计数形状
   * （`{ records, idempotency }`，字段名与 `packages/privacy` 的 `OwnerPurgeCounts` 逐字一致）。
   *
   * 这个读数是回执证据串（`speech:online-purged:<records>;speech:idempotency-purged:<idempotency>`）
   * 的唯一来源，所以按契约对待：读不懂就抛——⛔ 绝不把「读不到行数」降级成「已清 0 行」。
   */
  function purgeCountsFromFunction(
    row: Record<string, unknown> | undefined,
    what: string,
  ): SpeechOwnerPurgeCounts {
    const raw = row?.['counts'];
    if (raw === null || typeof raw !== 'object') {
      throw new Error(`${what} 未返回结构化读数：拒绝把「读不到行数」当成「已清 0 行」`);
    }
    const source = raw as Record<string, unknown>;
    const pick = (key: string): number => {
      const value = source[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`${what} 的 ${key} 读数非法（${String(value)}）：拒绝把「读不懂」当成「已清」`);
      }
      return value;
    };
    return { records: pick('records'), idempotency: pick('idempotency') };
  }

  /** 事务包裹：`BEGIN` → `SET LOCAL lock_timeout` → 业务 → `COMMIT`；异常折叠为契约错误。 */
  async function withTransaction<T>(work: (sql: SqlRunner) => Promise<T>): Promise<T> {
    let connection: PgConnection | null = null;
    try {
      connection = await pool.connect();
      await connection.query('BEGIN');
      await connection.query("SET LOCAL lock_timeout = '4s'");
      const result = await work(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      if (connection !== null) {
        try {
          await connection.query('ROLLBACK');
        } catch {
          // 回滚失败不覆盖原始异常：原始异常才是可诊断的原因。
        }
      }
      if (isUndefinedTable(error)) {
        // 探测之后表被回滚/恢复不完整：失效缓存，按「未迁移」而非「数据库故障」报告。
        tables = null;
        throw new SpeechTablesMissingError();
      }
      return classifySpeechDatabaseError(error);
    } finally {
      connection?.release();
    }
  }

  /**
   * 注销闭集（#19 延续片）· 按主体清空语音域三张表。
   *
   * 写路径是**迁移 0033 的 SECURITY DEFINER 函数** `public.purge_owner_speech(uuid)`，不是本文件
   * 里的 DELETE：运行时角色对这五张正文表**没有任何** DELETE 权限，且那是刻意的安全不变量
   * （`deploy/postgres-cvm/evidence/probe-runtime-grants.sql` 逐条探针要求「直接 DELETE 必须
   * 恰好 42501」，deploy-sql-gate 钉死 18 条 / 9 个对象）。PG 没有列级 DELETE，所以收窄只能
   * 是「不给表权限、给一条只删一个主体一个域的函数」。
   * ⛔ 绝不能为了省事改回 `DELETE FROM public.speech_*` —— 那会同时打破禁止面与真库臂的
   * 成对断言（函数可清 vs 直接 DELETE 仍 42501）。
   *
   * 顺序不再由本文件决定，而是钉在迁移里（`0026_speech_persistence.sql`）：
   *   `:92`（`speech_jobs`）与 `:115`（`transcriptions`）各自 `owner_user_id`，两者之间
   *   **没有**外键，按语义「任务先于其产物」；`speech_idempotency`（`:137`）没有主体列
   *   ⇒ 按 scope 首段主体前缀删（`idempotencyScope` 恒以主体 uuid 开头）。
   *
   * 返回值仍是本域计数形状 `{ records, idempotency }`；函数回 jsonb 明细，这里只取这两个与
   * 端口一致的字段。读数读不懂就抛（⛔ 不把「读不到」当「已清 0 行」）。
   * ⚠️ 迁移没跑（0026/0033 缺）⇒ `requireTables()` / 函数不存在都会明确 fail-closed。
   */
  async function purgeOwnerRows(ownerId: string): Promise<SpeechOwnerPurgeCounts> {
    await requireTables();
    const rows = await run('SELECT public.purge_owner_speech($1::uuid) AS counts', [ownerId]);
    return purgeCountsFromFunction(rows[0], '语音域按主体清空（public.purge_owner_speech）');
  }

  return {
    persistent: true,

    async insertJob(row) {
      await requireTables();
      await runWrite(INSERT_JOB, jobValues(row), JOB_CONFLICT_MESSAGE);
    },

    async getJob(jobId) {
      if ((await tablesReady()) === 'missing') return null;
      return readOrMissing(async () => {
        const rows = await run(`SELECT ${JOB_COLUMNS} FROM public.speech_jobs WHERE id = $1::uuid`, [jobId]);
        const row = rows[0];
        return row === undefined ? null : jobRowFromRow(row);
      });
    },

    async updateJob(jobId, expectedRevision, mutate) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（不静默当成"CAS 失败"，那会让调用方无限重试）。
      await requireTables();
      // 读一次只为算出 mutate 的结果；**判定权在下面的 UPDATE**（`WHERE revision = $2`），
      // 因此两次读之间即使有并发写，也不会被本方法覆盖（0 行 ⇒ null）。
      const current = await run(`SELECT ${JOB_COLUMNS} FROM public.speech_jobs WHERE id = $1::uuid`, [jobId]);
      const snapshot = current[0];
      if (snapshot === undefined) return null;
      if (Number(snapshot['revision']) !== expectedRevision) return null;
      const next = mutate(jobRowFromRow(snapshot));
      const rows = await run(
        `UPDATE public.speech_jobs
            SET revision = $3,
                state = $4,
                deadline_at = $5::timestamptz,
                updated_at = $6::timestamptz,
                error_code = $7
          WHERE id = $1::uuid AND revision = $2
        RETURNING ${JOB_COLUMNS}`,
        [jobId, expectedRevision, next.revision, next.state, next.deadlineAt, next.updatedAt, next.errorCode],
      );
      const row = rows[0];
      return row === undefined ? null : jobRowFromRow(row);
    },

    async commitTerminal(jobId, expectedRevision, terminal, transcription, at) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（事务里根本不发语句）。
      await requireTables();
      return withTransaction(async (sql) => {
        // 行锁：并发的取消/另一次终态提交在本行上排队，随后各自按 revision 重新求值 ⇒ 只有一个能成功。
        const locked = await sql.query(
          `SELECT ${JOB_COLUMNS} FROM public.speech_jobs WHERE id = $1::uuid FOR UPDATE`,
          [jobId],
        );
        const snapshot = locked.rows[0];
        if (snapshot === undefined) return null;
        const current = jobRowFromRow(snapshot);
        if (current.revision !== expectedRevision) return null;
        // 终态迁移必须合法：已被取消/已终态的任务不会被迟到结果改写（状态机唯一事实来源在 state.ts）。
        if (!canTransitionJob(current.state, terminal.state)) return null;
        if (transcription !== null) {
          try {
            await sql.query(INSERT_RECORD, recordValues(transcription));
          } catch (error) {
            // 与内存实现同语义：记录 id 冲突 ⇒ 抛错，且任务行**没有**被改写（事务在此回滚）。
            if (isUniqueViolation(error)) throw new SpeechStoreConflictError(RECORD_CONFLICT_MESSAGE);
            throw error;
          }
        }
        // revision 恰好 +1（`revision + 1` 在 SQL 里算，行已被锁住 ⇒ 不会与并发写叠加成 +2）。
        const updated = await sql.query(
          `UPDATE public.speech_jobs
              SET state = $3,
                  error_code = $4,
                  revision = revision + 1,
                  updated_at = $5::timestamptz
            WHERE id = $1::uuid AND revision = $2
          RETURNING ${JOB_COLUMNS}`,
          [jobId, expectedRevision, terminal.state, terminal.errorCode, at],
        );
        const row = updated.rows[0];
        return row === undefined ? null : jobRowFromRow(row);
      });
    },

    async insertTranscription(row) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（绝不静默丢写、绝不退化成内存 store）。
      await requireTables();
      await runWrite(INSERT_RECORD, recordValues(row), RECORD_CONFLICT_MESSAGE);
    },

    async getTranscription(transcriptionId) {
      if ((await tablesReady()) === 'missing') return null;
      return readOrMissing(async () => {
        const rows = await run(
          `SELECT ${RECORD_COLUMNS} FROM public.transcriptions WHERE id = $1::uuid`,
          [transcriptionId],
        );
        const row = rows[0];
        return row === undefined ? null : transcriptionRowFromRow(row);
      });
    },

    async updateTranscription(transcriptionId, expectedRevision, mutate) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（不得当成"CAS 失败"返回 null，那会让调用方误以为并发冲突）。
      await requireTables();
      const current = await run(
        `SELECT ${RECORD_COLUMNS} FROM public.transcriptions WHERE id = $1::uuid`,
        [transcriptionId],
      );
      const snapshot = current[0];
      if (snapshot === undefined) return null;
      if (Number(snapshot['revision']) !== expectedRevision) return null;
      const before = transcriptionRowFromRow(snapshot);
      const next = mutate(transcriptionRowFromRow(snapshot));
      // 原始输出不可变：确认/其他任何更新都不得改写 raw_text 与 uncertain_spans（与内存实现同文案）。
      if (next.rawText !== before.rawText || !sameSpans(next.uncertainSpans, before.uncertainSpans)) {
        throw new Error(RAW_IMMUTABLE_MESSAGE);
      }
      const rows = await run(
        `UPDATE public.transcriptions
            SET revision = $3,
                raw_text = $4,
                uncertain_spans = $5::jsonb,
                confirmed_text = $6,
                confirmed_at = $7::timestamptz,
                model_version = $8,
                updated_at = $9::timestamptz,
                deleted = $10
          WHERE id = $1::uuid AND revision = $2
        RETURNING ${RECORD_COLUMNS}`,
        [
          transcriptionId,
          expectedRevision,
          next.revision,
          next.rawText,
          JSON.stringify(next.uncertainSpans),
          next.confirmedText,
          next.confirmedAt,
          next.modelVersion,
          next.updatedAt,
          next.deleted,
        ],
      );
      const row = rows[0];
      return row === undefined ? null : transcriptionRowFromRow(row);
    },

    // ---- 幂等台账（本域独立的 speech_idempotency；`payload` 占位期就有值，`pending` 是显式列） ----

    async findIdempotent(scope, keyHashHex) {
      // 读类：表未迁移 ⇒ null（「没有已持久化的幂等占位」），与接线前内存实现的未命中同形。
      if ((await tablesReady()) === 'missing') return null;
      return readOrMissing(async () => {
        // 与内存实现逐条一致：**不**按过期过滤（到期行由服务层 purge 清理后再 claim）。
        const rows = await run(
          `SELECT request_hash, payload, pending, expires_at
             FROM public.speech_idempotency
            WHERE scope = $1 AND key_hash = $2`,
          [scope, keyHashHex],
        );
        const row = rows[0];
        if (row === undefined) return null;
        const record: IdempotencyRow = {
          requestHash: String(row['request_hash']),
          expiresAt: asDate(row['expires_at']),
          payload: readPayload(row['payload']),
          pending: row['pending'] === true,
        };
        return record;
      });
    },

    async claimIdempotent(scope, keyHashHex, row, at) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（占位必须真落库，否则幂等语义静默失效）。
      await requireTables();
      // 单条语句 = 「检查 + 写入」同一临界区：唯一约束 (scope, key_hash) 裁决首个占位者。
      // 写入并返回行 ⇒ 'claimed'；已存在 ⇒ DO NOTHING 不写、不返回行 ⇒ 'exists'。
      // 到期条目由 **调用方先 purge**（`speech/service.ts:307`）物理删除，因此这里不会把
      // 「已过期」误判成「仍在占位」，也不需要「先 SELECT 再 INSERT」的检查-写入窗口。
      // 形参 `at` 因此只服务接口签名（内存实现用它判到期）；此处不参与 SQL 谓词。
      const rows = await run(
        `INSERT INTO public.speech_idempotency (scope, key_hash, request_hash, payload, pending, expires_at)
              VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz)
         ON CONFLICT (scope, key_hash) DO NOTHING
           RETURNING scope`,
        [scope, keyHashHex, row.requestHash, JSON.stringify(row.payload), row.pending, row.expiresAt],
      );
      return rows.length > 0 ? 'claimed' : 'exists';
    },

    async finalizeIdempotent(scope, keyHashHex, payload) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（终态回填不能静默丢）。
      await requireTables();
      // 行不存在 ⇒ 0 行更新（空操作），与内存实现的 `if (row === undefined) return;` 同义。
      await run(
        `UPDATE public.speech_idempotency
            SET payload = $3::jsonb,
                pending = false
          WHERE scope = $1 AND key_hash = $2`,
        [scope, keyHashHex, JSON.stringify(payload)],
      );
    },

    async releaseIdempotent(scope, keyHashHex) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（释放失败会让幂等键永久 pending）。
      await requireTables();
      // 内存实现是 `idempotency.delete(...)`（无条件删）：这里同样不带完成态条件。
      await run('DELETE FROM public.speech_idempotency WHERE scope = $1 AND key_hash = $2', [scope, keyHashHex]);
    },

    async purgeIdempotent(now) {
      // 写类（DELETE）：表未迁移 ⇒ 明确 fail-closed；调用方（claim 起始）会因此得到可诊断的 503。
      await requireTables();
      const rows = await run(
        'DELETE FROM public.speech_idempotency WHERE expires_at <= $1::timestamptz RETURNING scope',
        [now],
      );
      return rows.length;
    },

    // ---- 注销闭集（#19 延续片）：按主体清空（三表同一事务；见 `purgeOwnerRows`） ----

    async purgeOwnerData(ownerId) {
      return purgeOwnerRows(ownerId);
    },

    async deleteAllByOwner(ownerId) {
      return (await purgeOwnerRows(ownerId)).records;
    },
  };
}
