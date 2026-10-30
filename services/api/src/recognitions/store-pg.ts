/**
 * GY-R28 S13 · 杂草识别域的 **PostgreSQL 实现**（迁移 `0025_recognitions_persistence.sql`）。
 *
 * 逐方法与 `recognitions/store.ts` 的内存实现对齐（本文件验收口径是**逐条**对齐，不是"大致等价"）：
 *   - `insertJob` / `insertRecognition`：**唯一**写入口，同一 `id` 再写 ⇒ 抛错（文案与内存实现逐字相同：
 *     `任务 id 冲突` / `识别记录 id 冲突`）。重复判定**只**由主键裁决（`23505`），
 *     不存在"先 SELECT 再 INSERT"的检查-写入窗口。
 *   - `getJob` / `getRecognition`：按主键单条读取；不存在 ⇒ `null`（与 Map 未命中同形）。
 *   - `updateJob` / `updateRecognition`：CAS。**判定权在那条带 `WHERE revision = $2` 的 UPDATE**——
 *     读一次只为算出 `mutate` 的结果；并发写不会被覆盖：输的那条 UPDATE 返回 0 行 ⇒ 返回 `null`
 *     （不是"读到旧值就认为成功"）。
 *   - `commitTerminal`：**同一事务**内完成「行锁读 + CAS 校验 + 合法迁移校验 + 写识别记录（可为 null）
 *     + 落任务终态」。CAS 失败（任务已被取消/已终态）⇒ 返回 `null` 且**不写任何记录**（旧回调不复活）；
 *     记录 id 冲突 ⇒ 抛错且任务行不变（事务回滚）。状态机的唯一事实来源仍是
 *     `recognitions/state.ts` 的 `canTransitionJob`（**不**在 SQL 里再抄一份迁移表）。
 *   - `commitSelection`：**同一事务**内完成「行锁读 + CAS 校验 + 追加选择行 + 推进 `selected_species_id`」。
 *     CAS 失败 ⇒ `null` 且**不追加任何选择行**；`selection.recognitionId` 与形参不符 ⇒ 抛
 *     `选择记录与识别记录不匹配`；选择行 id 冲突 ⇒ 抛 `选择记录 id 冲突`（均为内存实现的逐字文案）。
 *   - `listSelections`：按 `recognition_id` + `owner_user_id` 过滤，按 `decided_at` 升序
 *     （再以 `id` 兜底，保证同一时刻多行也有稳定次序）。
 *   - 幂等台账：`claimIdempotent` / `completeIdempotent` / `releaseIdempotent` / `purgeIdempotent`
 *     四个方法，`claim` 的"检查 + 写入"是**单条** `INSERT … ON CONFLICT (scope, key_hash) DO UPDATE …
 *     WHERE recognition_idempotency.expires_at <= $at RETURNING scope`：不存在或已到期 ⇒ 写入/覆盖并返回行
 *     ⇒ `claimed`；已存在且未到期 ⇒ 不更新、不返回行 ⇒ **再按同一条主键读回**该行，按 `request_hash`
 *     是否相等与 `pending` 的真假分成 `conflict` / `in_progress` / `completed`。
 *     因此**并发下只有一个调用方拿到 `claimed`**（与内存实现"检查与写入之间没有 await"同义），
 *     也没有"先查后写"的窗口。
 *
 * 连接与事务：沿用仓库既有 PG 方式（与 `ocr/store-pg.ts` / `favorites/store-pg.ts` 同口径）：
 * `pool.connect()` → `BEGIN` → `SET LOCAL lock_timeout = '4s'` → 业务 SQL → `COMMIT`
 * （异常 `ROLLBACK`）。只有需要临界区的 `commitTerminal` / `commitSelection` 走事务；其余方法各是单条语句。
 * ⛔ 缺 `connect()` 的池不会被静默降级成"无事务的两步写"：两个 commit 会如实失败
 * （`PROVIDER_UNAVAILABLE`），因为"CAS 失败不写记录/不追加选择"这两条不变量没有事务就无法保证。
 *
 * 错误折叠（与 `ocr/store-pg.ts` / `messages/store-pg.ts` 逐条同口径）：`57014`（语句超时）/`55P03`
 * （锁不可得）⇒ `PROVIDER_TIMEOUT`；其余数据库异常 ⇒ `PROVIDER_UNAVAILABLE`。存储层自身的唯一性冲突用
 * `RecognitionStoreConflictError`（`instanceof Error`、文案与内存实现相同），**不**被折成数据库错误。
 *
 * 归属域：所有语句都带 `owner_user_id` 吗？**不是**——`getJob(id)` / `getRecognition(id)` /
 * `updateJob` / `updateRecognition` / `commitTerminal` / `commitSelection(recognitionId, …)` 的接口签名
 * **没有** owner 形参（改签名属停手条件），因此它们按主键操作；归属判定在服务层完成
 * （`recognitions/service.ts` 的 `getOwnedJob` / `getOwnedRecognition` 读到非本人即与"不存在"同形的 404）。
 * `listSelections` 的签名**带** owner ⇒ 它的 WHERE 里带 `owner_user_id`。写入路径上 `owner_user_id`
 * 由调用方明确给出，列上 `NOT NULL` + `REFERENCES users (id) ON DELETE CASCADE` ⇒ 注销时任务、记录与
 * 选择级联删除。
 *
 * 列的类型边界（如实登记，均在服务层不可达）：
 *   * `id` / `recognition_id` / `media_id` / `owner_user_id` 是 uuid 列：本域 id 恒由 `randomUUID()` 产生
 *     （`recognitions/service.ts` 的 `idFactory` 默认值），非 uuid 形 id 会由数据库拒绝（`22P02` ⇒
 *     `PROVIDER_UNAVAILABLE`），而内存实现会把任意字符串当键——服务层入口已用 UUID 正则拦截，
 *     故该差异在生产不可达；
 *   * `state` 列的闭集由库侧 `job_state` 枚举守住（迁移 0025 直接引用 0001 的枚举），`kind` 由 CHECK
 *     守住：内存实现会存下闭集外的值，PG 会拒绝。本域 `mutate` 只写 `running` / `cancelled` / 终态
 *     （`state.ts` 的 `canTransitionJob` 已约束），故该差异同样在服务层不可达 —— 这是 PG 侧的**收紧**；
 *   * `updateJob` / `updateRecognition` 的写回列是**白名单**（不可变键之外的业务列）：内存实现整体替换
 *     Map 值，本实现只写这些列。`candidates` / `uncertaintyReasons` **在**白名单里（内存实现也允许
 *     `mutate` 改它们）；"人工选择不得回写模型字段"由服务层 mutator 保证，存储层不据此另设拒绝
 *     （否则两条实现的语义就不等价了）。
 */
import type { ErrorCode } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { ledgerRowFromDomainJob, writeJobLedger } from '../jobs/ledger.ts';
import { isTransientDatabaseError } from '../db/pool.ts';
import {
  MAX_CANDIDATES,
  MAX_REASON_LENGTH,
  MAX_SPECIES_ID_LENGTH,
  MAX_UNCERTAINTY_REASONS,
  canTransitionJob,
  isJobState,
  type Candidate,
  type JobState,
} from './state.ts';
import type { SelectionLinkage } from './linkage.ts';
import { isSelectionProvenance, type SelectionRecord } from './selection.ts';
import type {
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyRow,
  JobRow,
  RecognitionOwnerPurgeCounts,
  RecognitionRow,
  RecognitionStore,
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

export interface PostgresRecognitionStoreOptions {
  pool: TransactionalPool;
}

/** 存储层自身的唯一性冲突：文案与内存实现逐字相同，且不被数据库异常折叠改写。 */
export class RecognitionStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecognitionStoreConflictError';
  }
}

/**
 * **「识别持久化表未迁移（0025）」** —— 与「数据库故障」严格区分的一类明确错误。
 *
 * 为什么要单列（与 `ocr/store-pg.ts` 的 `OcrTablesMissingError` 同一教训，R27-S10-r1 的 CI 真回归）：
 * 真库集成测试会只应用**迁移子集**建库（如 `tests/integration/conversations-pg.mjs` 只跑
 * `0001/0002/0005/0008/0010/0012/0013`；`community-pg.mjs` 只跑 `0001/0022`；
 * `favorites-history-pg.mjs` 跑 `0001/0018`，`0008`（只建 `idempotency_keys`）加不加都不含 `0025`）
 * ⇒ 那种库里**没有** `recognition_*` 四表。
 * 若把「表不存在」（`42P01`）与「数据库故障」一起折成 `PROVIDER_UNAVAILABLE`「识别数据库暂不可用」，
 * 识别作业源的读路径会把**无关域**的 `GET /jobs/{id}` 打成 503（本该 200/404）——
 * `conversations-pg.mjs` 就是这么红的（`#323` 的 OCR 版本）。
 *
 * 语义（与 `ocr/store-pg.ts` / `admin/ops/flags-pg.ts` 同族纪律）：
 * - **读类**：表不存在 ⇒ 视为「没有已持久化的识别任务/记录/选择」⇒ 返回 `null` / `[]`
 *   （与接线前内存 store 的对外行为一致）；
 * - **写类**：表不存在 ⇒ **fail-closed** 并抛本错误（点名迁移号），⛔ 绝不静默丢写、⛔ 绝不退化成内存 store；
 * - `retryable: false`：这是**部署/迁移未执行**，不是瞬时故障 —— 重试不会好，须跑 `0025`。
 */
export class RecognitionTablesMissingError extends ApiError {
  constructor() {
    super(
      'PROVIDER_UNAVAILABLE',
      '识别持久化表未迁移（0025_recognitions_persistence.sql）：拒绝写入，避免静默丢数据',
      { retryable: false },
    );
    this.name = 'RecognitionTablesMissingError';
  }
}

/** 数据库异常的契约化折叠（与 `ocr/store-pg.ts` 逐条同口径）。 */
export function classifyRecognitionDatabaseError(error: unknown): never {
  if (error instanceof RecognitionStoreConflictError) throw error;
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['57014', '55P03'].includes(code)) {
    throw new ApiError('PROVIDER_TIMEOUT', '识别数据库响应超时', { retryable: true });
  }
  // `retryable` 分档（口径原文见 `../errors.ts` 的 `ApiError` 注释）：连接层故障（08xxx）、管理员干预
  // （53xxx / 57P0x）、串行化冲突（40001）、死锁（40P01）⇒ 同一请求稍后重试**确实**可能成功 ⇒ true；
  // 权限不足（42501）、库/表/凭据缺失（3D000 / 28P01 / 42P01）、函数缺失（42883）与无法归类的其余
  // 驱动错误 ⇒ 需运维改配置或修缺陷，重试永远不会好 ⇒ false（⛔ 恒 true 会把权限缺失伪装成下游抖动）。
  throw new ApiError('PROVIDER_UNAVAILABLE', '识别数据库暂不可用', { retryable: isTransientDatabaseError(error) });
}

/**
 * `42P01`（`undefined_table`）＝「这条 SQL 指向的表不在」。本文件所有语句都写成
 * `public.recognition_*` **全限定**形式，因此它只可能表示「0025 未应用（或刚被回滚）」，
 * 不会被 `search_path` 差异误判 ⇒ 可安全地翻成 {@link RecognitionTablesMissingError}。
 */
const UNDEFINED_TABLE = '42P01';
const isUndefinedTable = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === UNDEFINED_TABLE;

/**
 * 迁移 `0025` 的**只读就绪探测**：四张表是否真实存在。
 *
 * 为什么是一条语句查四张表：四表由**同一个迁移文件**建出（单事务，不可能半建），
 * 但探测仍逐表 `IS NOT NULL` —— 若真的出现半迁移（人为 DROP、恢复不完整），
 * 也应判「未就绪」而不是让读路径看到一半的表。
 *
 * 为什么用 `to_regclass(...)` 而不是 `SELECT 1 FROM public.recognition_jobs`：
 * 表不存在时 `to_regclass` 返回 `NULL`（**不报错**），且**不依赖表级 SELECT 权限**，
 * schema 全限定 ⇒ 运行时角色受限的 `search_path` 也解析得到（与 `ocr/store-pg.ts` 同口径）。
 */
const TABLES_READY_SQL =
  "SELECT (to_regclass('public.recognition_jobs') IS NOT NULL"
  + " AND to_regclass('public.recognition_records') IS NOT NULL"
  + " AND to_regclass('public.recognition_selections') IS NOT NULL"
  + " AND to_regclass('public.recognition_idempotency') IS NOT NULL) AS ready";

/** 就绪探测的三态：`unknown`（探不了）**不是** `missing`（确认没有）。 */
export type RecognitionTablesProbe = 'ready' | 'missing' | 'unknown';

const JOB_COLUMNS =
  'id, revision, kind, owner_user_id, recognition_id, media_id, media_revision, state, deadline_at, created_at, updated_at, error_code';
const RECORD_COLUMNS =
  'id, revision, owner_user_id, media_id, media_revision, candidates, uncertainty_reasons, selected_species_id, model_version, created_at, updated_at, deleted';
const SELECTION_COLUMNS =
  'id, revision, recognition_id, owner_user_id, species_id, provenance, decided_at, linkage';

const INSERT_JOB = `INSERT INTO public.recognition_jobs (${JOB_COLUMNS})
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8::job_state, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12)
  RETURNING id`;

const INSERT_RECORD = `INSERT INTO public.recognition_records (${RECORD_COLUMNS})
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::jsonb, $7::jsonb, $8::text, $9, $10::timestamptz, $11::timestamptz, $12)
  RETURNING id`;

const INSERT_SELECTION = `INSERT INTO public.recognition_selections (${SELECTION_COLUMNS})
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7::timestamptz, $8::jsonb)
  RETURNING ${SELECTION_COLUMNS}`;

/** 内存实现的 `new Error(...)` 文案（逐字相同：调用方/测试按 message 判定，不改写成新文案）。 */
const JOB_CONFLICT_MESSAGE = '任务 id 冲突';
const RECORD_CONFLICT_MESSAGE = '识别记录 id 冲突';
const SELECTION_CONFLICT_MESSAGE = '选择记录 id 冲突';
const SELECTION_MISMATCH_MESSAGE = '选择记录与识别记录不匹配';

/**
 * 幂等占位的**单条**语句：不存在或已到期 ⇒ 写入/覆盖并返回行（`claimed`）；
 * 已存在且未到期 ⇒ `ON CONFLICT` 的 WHERE 为假 ⇒ 不更新、不返回行（由调用方接着读回判定）。
 */
const CLAIM_IDEMPOTENT = `INSERT INTO public.recognition_idempotency (scope, key_hash, request_hash, payload, pending, expires_at)
     VALUES ($1, $2, $3, '{}'::jsonb, true, $4::timestamptz)
ON CONFLICT (scope, key_hash) DO UPDATE
        SET request_hash = EXCLUDED.request_hash,
            payload = EXCLUDED.payload,
            pending = EXCLUDED.pending,
            expires_at = EXCLUDED.expires_at
      WHERE public.recognition_idempotency.expires_at <= $5::timestamptz
  RETURNING scope`;

const SELECT_IDEMPOTENT = `SELECT request_hash, payload, pending, expires_at
     FROM public.recognition_idempotency
    WHERE scope = $1 AND key_hash = $2`;

/** 完成回执：同一条主键行的状态翻转（`pending = false` + 回执 payload）。 */
const COMPLETE_IDEMPOTENT = `INSERT INTO public.recognition_idempotency (scope, key_hash, request_hash, payload, pending, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, false, $5::timestamptz)
ON CONFLICT (scope, key_hash) DO UPDATE
        SET request_hash = EXCLUDED.request_hash,
            payload = EXCLUDED.payload,
            pending = false,
            expires_at = EXCLUDED.expires_at`;

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
 * 解析失败**不**返回空对象（那会把坏行伪装成合法行）——返回 `null` 交给调用方的形状判据拒绝。
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
  return new ApiError('PROVIDER_UNAVAILABLE', `识别 ${what}形状不合约定（内部不变式违反）`, {
    retryable: false,
  });
}

/** 数据库行 → 契约 `Candidate[]`（逐字段重建；越界值按内部不变式违反处理，不静默裁剪）。 */
function readCandidates(value: unknown): Candidate[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) throw invariant('candidates');
  if (parsed.length > MAX_CANDIDATES) throw invariant('candidates');
  return parsed.map((item) => {
    const row = asRecord(item);
    if (row === null) throw invariant('candidates');
    const speciesId = row['species_id'];
    const rank = row['rank'];
    const score = row['model_score'];
    if (typeof speciesId !== 'string' || speciesId.length < 1 || speciesId.length > MAX_SPECIES_ID_LENGTH) {
      throw invariant('candidates');
    }
    if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 1 || rank > MAX_CANDIDATES) {
      throw invariant('candidates');
    }
    if (score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)) {
      throw invariant('candidates');
    }
    return { species_id: speciesId, rank, model_score: score as number | null };
  });
}

/** 数据库行 → `uncertaintyReasons`（数组 + 每条 1..80，与契约 `MAX_REASON_LENGTH` 一致）。 */
function readReasons(value: unknown): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.length > MAX_UNCERTAINTY_REASONS) throw invariant('uncertainty_reasons');
  return parsed.map((item) => {
    if (typeof item !== 'string' || item.length < 1 || item.length > MAX_REASON_LENGTH) {
      throw invariant('uncertainty_reasons');
    }
    return item;
  });
}

/** 数据库行 → 契约 `SelectionLinkage`（纯 JSON、无 Date；形状由 `linkage.ts` 在写入前校验）。 */
function readLinkage(value: unknown): SelectionLinkage {
  const parsed = asRecord(parseJson(value));
  if (parsed === null) throw invariant('选择记录 linkage');
  return structuredClone(parsed) as unknown as SelectionLinkage;
}

/** 数据库行 → 内部任务行（未知 state/kind 按内部不变式违反处理，不静默降级）。 */
function jobRowFromRow(row: Record<string, unknown>): JobRow {
  const state = row['state'];
  if (typeof state !== 'string' || !isJobState(state)) throw invariant('任务 state');
  if (row['kind'] !== 'recognition') throw invariant('任务 kind');
  const errorCode = row['error_code'] === null || row['error_code'] === undefined ? null : String(row['error_code']);
  return {
    id: String(row['id']),
    revision: Number(row['revision']),
    kind: 'recognition',
    ownerUserId: String(row['owner_user_id']),
    recognitionId: String(row['recognition_id']),
    mediaId: String(row['media_id']),
    mediaRevision: Number(row['media_revision']),
    state: state as JobState,
    deadlineAt: asDate(row['deadline_at']),
    createdAt: asDate(row['created_at']),
    updatedAt: asDate(row['updated_at']),
    errorCode: errorCode as ErrorCode | null,
  };
}

/** 数据库行 → 内部识别记录行。 */
function recognitionRowFromRow(row: Record<string, unknown>): RecognitionRow {
  const selected = row['selected_species_id'];
  if (selected !== null && selected !== undefined && typeof selected !== 'string') {
    throw invariant('selected_species_id');
  }
  return {
    id: String(row['id']),
    revision: Number(row['revision']),
    ownerUserId: String(row['owner_user_id']),
    mediaId: String(row['media_id']),
    mediaRevision: Number(row['media_revision']),
    candidates: readCandidates(row['candidates']),
    uncertaintyReasons: readReasons(row['uncertainty_reasons']),
    selectedSpeciesId: selected === undefined || selected === null ? null : selected,
    modelVersion: String(row['model_version']),
    createdAt: asDate(row['created_at']),
    updatedAt: asDate(row['updated_at']),
    deleted: row['deleted'] === true,
  };
}

/** 数据库行 → 契约 `SelectionRecord`。 */
function selectionRowFromRow(row: Record<string, unknown>): SelectionRecord {
  const provenance = row['provenance'];
  if (typeof provenance !== 'string' || !isSelectionProvenance(provenance)) {
    throw invariant('选择记录 provenance');
  }
  return {
    id: String(row['id']),
    revision: Number(row['revision']),
    recognitionId: String(row['recognition_id']),
    ownerUserId: String(row['owner_user_id']),
    speciesId: String(row['species_id']),
    provenance,
    decidedAt: asDate(row['decided_at']),
    linkage: readLinkage(row['linkage']),
  };
}

function jobValues(row: JobRow): unknown[] {
  return [
    row.id,
    row.revision,
    row.kind,
    row.ownerUserId,
    row.recognitionId,
    row.mediaId,
    row.mediaRevision,
    row.state,
    row.deadlineAt,
    row.createdAt,
    row.updatedAt,
    row.errorCode,
  ];
}

function recordValues(row: RecognitionRow): unknown[] {
  return [
    row.id,
    row.revision,
    row.ownerUserId,
    row.mediaId,
    row.mediaRevision,
    JSON.stringify(row.candidates),
    JSON.stringify(row.uncertaintyReasons),
    row.selectedSpeciesId,
    row.modelVersion,
    row.createdAt,
    row.updatedAt,
    row.deleted,
  ];
}

function selectionValues(row: SelectionRecord): unknown[] {
  return [
    row.id,
    row.revision,
    row.recognitionId,
    row.ownerUserId,
    row.speciesId,
    row.provenance,
    row.decidedAt,
    JSON.stringify(row.linkage),
  ];
}

/** 幂等台账行 → 契约 `IdempotencyRow`。 */
function idempotencyRowFromRow(row: Record<string, unknown>): IdempotencyRow {
  const payload = asRecord(parseJson(row['payload']));
  if (payload === null) throw invariant('幂等台账 payload');
  return {
    requestHash: String(row['request_hash']),
    expiresAt: asDate(row['expires_at']),
    payload: { ...payload },
  };
}

export function createPostgresRecognitionStore({ pool }: PostgresRecognitionStoreOptions): RecognitionStore {
  /**
   * 就绪状态的**缓存**：只缓存**确定结论**（`ready` / `missing`）。
   * `null` = 未探过（或探测结果未知、或 42P01 后失效）⇒ 下一次调用重探。
   * ⛔ `unknown` 绝不写入本缓存 —— 把「探不了」当「没装」正是 #282/#323 的缺陷成因。
   */
  let tables: 'ready' | 'missing' | null = null;

  /**
   * 最近一次探测失败的原因（只用于「未知」时**保持既有错误分类**：`57014`/`55P03` ⇒
   * `PROVIDER_TIMEOUT`，其余 ⇒ `PROVIDER_UNAVAILABLE`）。它**不**参与缓存判断，
   * 因此不会把偶发故障粘成长期状态。
   */
  let probeFailure: unknown = null;

  /** 只读就绪探测（**不抛**：任何失败都以 `unknown` 返回，由调用方决定 fail-closed 策略）。 */
  async function probeTables(): Promise<RecognitionTablesProbe> {
    probeFailure = null;
    let rows: unknown;
    try {
      rows = (await pool.query(TABLES_READY_SQL)).rows;
    } catch (error) {
      // 权限/连接/超时：**状态未知**。⛔ 不得返回 `missing`（那会把故障判成"未迁移"而放行读）。
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
   * - `missing`：由调用方按「读 ⇒ null / 写 ⇒ {@link RecognitionTablesMissingError}」分化处理；
   * - `unknown`（探测抛错/形状读不懂）：**抛**（fail-closed），⛔ 不缓存、⛔ 不当成 `missing`。
   */
  async function tablesReady(): Promise<'ready' | 'missing'> {
    if (tables !== null) return tables;
    const state = await probeTables();
    if (state === 'unknown') {
      // 探测抛错：先按**既有分类**折叠原因（57014/55P03 ⇒ PROVIDER_TIMEOUT，08xxx/40001 等瞬时 ⇒
      // PROVIDER_UNAVAILABLE + `retryable:true`，42501/28P01/42883 等运维动作 ⇒ `retryable:false`）。
      if (probeFailure !== null) classifyRecognitionDatabaseError(probeFailure);
      // 走到这里只剩「**应答形状读不懂**」（空行/非数组/`ready` 不是布尔）：这是确定性缺陷
      // （驱动或查询形状不对），同一请求重试永远不会变好 ⇒ `retryable:false`（R31-S-retryable 口径），
      // 原因分类入 `details` 供排障，⛔ 不再借「可能是抖动」把确定性失败标成可重试。
      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        '识别持久化表就绪探测结果未知（应答形状无法识别）：按数据库故障 fail-closed（未知 ≠ 未迁移）',
        { retryable: false, details: [{ field: 'recognition_tables', code: 'PROBE_SHAPE_UNKNOWN' }] },
      );
    }
    tables = state;
    return state;
  }

  /** 写类的前置门：表不存在 ⇒ 明确 fail-closed（绝不静默丢写、绝不退化成内存 store）。 */
  async function requireTables(): Promise<void> {
    if ((await tablesReady()) === 'missing') throw new RecognitionTablesMissingError();
  }

  async function run(text: string, values?: unknown[]): Promise<Array<Record<string, unknown>>> {
    try {
      const result = await pool.query(text, values);
      return result.rows;
    } catch (error) {
      if (isUndefinedTable(error)) {
        // 探测之后表被回滚/恢复不完整：失效缓存，下一次调用重探；本语句按「未迁移」处理。
        tables = null;
        throw new RecognitionTablesMissingError();
      }
      return classifyRecognitionDatabaseError(error);
    }
  }

  /** 写类语句：唯一性冲突只在这里翻成与内存实现同文案的冲突错误。 */
  async function runWrite(text: string, values: unknown[], conflictMessage: string): Promise<void> {
    try {
      await pool.query(text, values);
    } catch (error) {
      if (isUniqueViolation(error)) throw new RecognitionStoreConflictError(conflictMessage);
      if (isUndefinedTable(error)) {
        tables = null;
        throw new RecognitionTablesMissingError();
      }
      classifyRecognitionDatabaseError(error);
    }
  }

  /**
   * 读类：表未迁移 ⇒ `null`（等价于「没有已持久化的识别任务/记录」，与接线前内存 store 的对外行为一致）；
   * **真数据库故障照旧抛**（不被这一层吞掉）。
   */
  async function readOrMissing<T>(work: () => Promise<T | null>): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof RecognitionTablesMissingError) return null;
      throw error;
    }
  }

  /**
   * 把 `public.purge_owner_recognitions(...)` 回的 jsonb 读数收敛成本域的计数形状
   * （`{ records, idempotency }`，字段名与 `packages/privacy` 的 `OwnerPurgeCounts` 逐字一致）。
   *
   * 为什么把它当**契约**而不是顺手解包：这个读数是回执证据串
   * （`recognitions:online-purged:<records>;recognitions:idempotency-purged:<idempotency>`）
   * 的唯一来源。读不懂就抛——⛔ 绝不把「读不到行数」降级成「已清 0 行」，
   * 那会让一次完全没删成的调用在回执里长得跟「本来就干净」一模一样。
   */
  function purgeCountsFromFunction(
    row: Record<string, unknown> | undefined,
    what: string,
  ): RecognitionOwnerPurgeCounts {
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

  /** 事务包裹：`BEGIN` → `SET LOCAL lock_timeout` → 业务 → `COMMIT`；数据库异常折叠为契约错误。 */
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
      const driverCode = (error as { code?: unknown } | null)?.code;
      if (typeof driverCode !== 'string') {
        // 非数据库异常（`ApiError` / `RecognitionStoreConflictError` / 「选择记录与识别记录不匹配」
        // 这类内部不变式）**原样抛出**：它们没有驱动错误码，折成 PROVIDER_UNAVAILABLE 会把
        // 编程错误伪装成运维故障。
        throw error;
      }
      if (isUndefinedTable(error)) {
        // 探测之后表被回滚/恢复不完整：失效缓存，按「未迁移」而非「数据库故障」报告。
        tables = null;
        throw new RecognitionTablesMissingError();
      }
      return classifyRecognitionDatabaseError(error);
    } finally {
      connection?.release();
    }
  }

  /**
   * 注销闭集（#19 延续片）· 按主体清空识别域四张表。
   *
   * 写路径是**迁移 0034 的 SECURITY DEFINER 函数** `public.purge_owner_recognitions(uuid)`，
   * 不是本文件里的 DELETE：运行时角色对这四张表**没有任何** DELETE 权限，而且那是刻意的
   * 安全不变量（`deploy/postgres-cvm/evidence/probe-runtime-grants.sql` 逐条探针要求
   * 「直接 DELETE 必须恰好 42501」，deploy-sql-gate 钉死 18 条 / 9 个对象）。PG 没有列级
   * DELETE，所以收窄只能是「不给表权限、给一条只删一个主体一个域的函数」。
   * ⛔ 这里绝不能为了省事改回 `DELETE FROM public.recognition_*` —— 那会同时打破禁止面与
   * 真库臂的成对断言（函数可清 vs 直接 DELETE 仍 42501）。
   *
   * 顺序不再由本文件决定，而是钉在迁移里（外键唯一确定）：
   *   `0025:163` `recognition_selections.recognition_id → recognition_records(id) ON DELETE CASCADE`
   *   ⇒ 先删 selections（子）；`0025:110`/`:134` 的 jobs 与 records 各自 `owner_user_id`，
   *   二者之间无外键，按语义「任务先于其产物」；`recognition_idempotency`（`0025:180`）
   *   没有主体列 ⇒ 按 scope 首段主体前缀删（`idempotencyScope` 恒以主体 uuid 开头）。
   *
   * 返回值仍是本域的计数形状 `{ records, idempotency }`：函数回 jsonb 明细，这里只取这两个
   * 与 `packages/privacy` 端口一致的字段。读数读不懂就抛（⛔ 不把「读不到」当「已清 0 行」）。
   * ⚠️ 迁移没跑（0025/0034 缺）⇒ `requireTables()` / 函数不存在都会明确 fail-closed。
   */
  async function purgeOwnerRows(ownerId: string): Promise<RecognitionOwnerPurgeCounts> {
    await requireTables();
    const rows = await run('SELECT public.purge_owner_recognitions($1::uuid) AS counts', [ownerId]);
    return purgeCountsFromFunction(rows[0], '识别域按主体清空（public.purge_owner_recognitions）');
  }

  return {
    persistent: true,

    async insertJob(row) {
      await requireTables();
      // GY-R71：台账行与源表行**同一个事务**（⛔ 不在 `runWrite` 之后补写 —— 那是两个提交点）。
      await withTransaction(async (sql) => {
        try {
          await sql.query(INSERT_JOB, jobValues(row));
        } catch (error) {
          if (isUniqueViolation(error)) throw new RecognitionStoreConflictError(JOB_CONFLICT_MESSAGE);
          throw error;
        }
        await writeJobLedger(sql, ledgerRowFromDomainJob('recognition', row, row.recognitionId));
      });
    },

    async getJob(jobId) {
      if ((await tablesReady()) === 'missing') return null;
      return readOrMissing(async () => {
        const rows = await run(`SELECT ${JOB_COLUMNS} FROM public.recognition_jobs WHERE id = $1::uuid`, [jobId]);
        const row = rows[0];
        return row === undefined ? null : jobRowFromRow(row);
      });
    },

    async updateJob(jobId, expectedRevision, mutate) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（不静默当成"CAS 失败"，那会让调用方无限重试）。
      await requireTables();
      // GY-R71：读 / CAS 更新 / 台账 upsert 三句在**同一个事务**里。
      return withTransaction(async (sql) => {
        // 读一次只为算出 mutate 的结果；**判定权在下面的 UPDATE**（`WHERE revision = $2`），
        // 因此两次读之间即使有并发写，也不会被本方法覆盖（0 行 ⇒ null）。
        const current = await sql.query(
          `SELECT ${JOB_COLUMNS} FROM public.recognition_jobs WHERE id = $1::uuid`,
          [jobId],
        );
        const snapshot = current.rows[0];
        if (snapshot === undefined) return null;
        if (Number(snapshot['revision']) !== expectedRevision) return null;
        const next = mutate(jobRowFromRow(snapshot));
        const rows = await sql.query(
          `UPDATE public.recognition_jobs
              SET revision = $3,
                  state = $4::job_state,
                  deadline_at = $5::timestamptz,
                  updated_at = $6::timestamptz,
                  error_code = $7
            WHERE id = $1::uuid AND revision = $2
          RETURNING ${JOB_COLUMNS}`,
          [jobId, expectedRevision, next.revision, next.state, next.deadlineAt, next.updatedAt, next.errorCode],
        );
        const row = rows.rows[0];
        if (row === undefined) return null;
        const updated = jobRowFromRow(row);
        await writeJobLedger(sql, ledgerRowFromDomainJob('recognition', updated, updated.recognitionId));
        return updated;
      });
    },

    async commitTerminal(jobId, expectedRevision, terminal, recognition, at) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（事务里根本不发语句）。
      await requireTables();
      return withTransaction(async (sql) => {
        // 行锁：并发的取消/另一次终态提交在本行上排队，随后各自按 revision 重新求值 ⇒ 只有一个能成功。
        const locked = await sql.query(
          `SELECT ${JOB_COLUMNS} FROM public.recognition_jobs WHERE id = $1::uuid FOR UPDATE`,
          [jobId],
        );
        const snapshot = locked.rows[0];
        if (snapshot === undefined) return null;
        const current = jobRowFromRow(snapshot);
        if (current.revision !== expectedRevision) return null;
        // 终态迁移必须合法：已被取消/已终态的任务不会被迟到结果改写（状态机唯一事实来源在 state.ts）。
        if (!canTransitionJob(current.state, terminal.state)) return null;
        if (recognition !== null) {
          try {
            await sql.query(INSERT_RECORD, recordValues(recognition));
          } catch (error) {
            // 与内存实现同语义：记录 id 冲突 ⇒ 抛错，且任务行**没有**被改写（事务在此回滚）。
            if (isUniqueViolation(error)) throw new RecognitionStoreConflictError(RECORD_CONFLICT_MESSAGE);
            throw error;
          }
        }
        // revision 恰好 +1（`revision + 1` 在 SQL 里算，行已被锁住 ⇒ 不会与并发写叠加成 +2）。
        const updated = await sql.query(
          `UPDATE public.recognition_jobs
              SET state = $3::job_state,
                  error_code = $4,
                  revision = revision + 1,
                  updated_at = $5::timestamptz
            WHERE id = $1::uuid AND revision = $2
          RETURNING ${JOB_COLUMNS}`,
          [jobId, expectedRevision, terminal.state, terminal.errorCode, at],
        );
        const row = updated.rows[0];
        if (row === undefined) return null;
        const committed = jobRowFromRow(row);
        // GY-R71：终态台账行与「记录行 + 作业行」同一个事务（CAS 失败时根本走不到这里）。
        await writeJobLedger(sql, ledgerRowFromDomainJob('recognition', committed, committed.recognitionId));
        return committed;
      });
    },

    async insertRecognition(row) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（绝不静默丢写、绝不退化成内存 store）。
      await requireTables();
      await runWrite(INSERT_RECORD, recordValues(row), RECORD_CONFLICT_MESSAGE);
    },

    async getRecognition(recognitionId) {
      if ((await tablesReady()) === 'missing') return null;
      return readOrMissing(async () => {
        const rows = await run(
          `SELECT ${RECORD_COLUMNS} FROM public.recognition_records WHERE id = $1::uuid`,
          [recognitionId],
        );
        const row = rows[0];
        return row === undefined ? null : recognitionRowFromRow(row);
      });
    },

    async updateRecognition(recognitionId, expectedRevision, mutate) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（不得当成"CAS 失败"返回 null，那会让调用方误以为并发冲突）。
      await requireTables();
      const current = await run(
        `SELECT ${RECORD_COLUMNS} FROM public.recognition_records WHERE id = $1::uuid`,
        [recognitionId],
      );
      const snapshot = current[0];
      if (snapshot === undefined) return null;
      if (Number(snapshot['revision']) !== expectedRevision) return null;
      const next = mutate(recognitionRowFromRow(snapshot));
      const rows = await run(
        `UPDATE public.recognition_records
            SET revision = $3,
                candidates = $4::jsonb,
                uncertainty_reasons = $5::jsonb,
                selected_species_id = $6::text,
                model_version = $7,
                updated_at = $8::timestamptz,
                deleted = $9
          WHERE id = $1::uuid AND revision = $2
        RETURNING ${RECORD_COLUMNS}`,
        [
          recognitionId,
          expectedRevision,
          next.revision,
          JSON.stringify(next.candidates),
          JSON.stringify(next.uncertaintyReasons),
          next.selectedSpeciesId,
          next.modelVersion,
          next.updatedAt,
          next.deleted,
        ],
      );
      const row = rows[0];
      return row === undefined ? null : recognitionRowFromRow(row);
    },

    async commitSelection(recognitionId, expectedRevision, mutate, selection) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（选择记录不能静默丢）。
      await requireTables();
      return withTransaction(async (sql) => {
        const locked = await sql.query(
          `SELECT ${RECORD_COLUMNS} FROM public.recognition_records WHERE id = $1::uuid FOR UPDATE`,
          [recognitionId],
        );
        const snapshot = locked.rows[0];
        if (snapshot === undefined) return null;
        const current = recognitionRowFromRow(snapshot);
        // CAS 失败 ⇒ null，且**不追加任何选择行**（与内存实现"先判 CAS 再判归属再写"同序）。
        if (current.revision !== expectedRevision) return null;
        // 选择记录必须挂到**本张**识别记录上：与内存实现逐字同文案的拒绝。
        if (selection.recognitionId !== recognitionId) throw new Error(SELECTION_MISMATCH_MESSAGE);
        const next = mutate(current);
        let inserted: Record<string, unknown> | undefined;
        try {
          const rows = await sql.query(INSERT_SELECTION, selectionValues(selection));
          inserted = rows.rows[0];
        } catch (error) {
          // 与内存实现同语义：选择记录 id 冲突 ⇒ 抛错，且识别记录**没有**被改写（事务在此回滚）。
          if (isUniqueViolation(error)) throw new RecognitionStoreConflictError(SELECTION_CONFLICT_MESSAGE);
          throw error;
        }
        if (inserted === undefined) throw invariant('选择记录');
        // revision 恰好 +1（`revision + 1` 在 SQL 里算，行已被锁住 ⇒ 不会与并发写叠加成 +2）。
        const updated = await sql.query(
          `UPDATE public.recognition_records
              SET revision = revision + 1,
                  candidates = $3::jsonb,
                  uncertainty_reasons = $4::jsonb,
                  selected_species_id = $5::text,
                  model_version = $6,
                  updated_at = $7::timestamptz,
                  deleted = $8
            WHERE id = $1::uuid AND revision = $2
          RETURNING ${RECORD_COLUMNS}`,
          [
            recognitionId,
            expectedRevision,
            JSON.stringify(next.candidates),
            JSON.stringify(next.uncertaintyReasons),
            next.selectedSpeciesId,
            next.modelVersion,
            next.updatedAt,
            next.deleted,
          ],
        );
        const row = updated.rows[0];
        if (row === undefined) return null;
        return { recognition: recognitionRowFromRow(row), selection: selectionRowFromRow(inserted) };
      });
    },

    async listSelections(recognitionId, ownerUserId) {
      // 读类：表未迁移 ⇒ `[]`（等价于「没有已持久化的选择历史」，与内存实现未命中同形）。
      if ((await tablesReady()) === 'missing') return [];
      const rows = await readOrMissing(async () => {
        const result = await run(
          `SELECT ${SELECTION_COLUMNS}
             FROM public.recognition_selections
            WHERE recognition_id = $1::uuid AND owner_user_id = $2::uuid
            ORDER BY decided_at ASC, id ASC`,
          [recognitionId, ownerUserId],
        );
        return result.map((row) => selectionRowFromRow(row));
      });
      return rows ?? [];
    },

    // ---- 幂等台账（本域独立的 recognition_idempotency；`pending` 区分占位与已完成回执） ----

    async claimIdempotent(scope, keyHashHex, input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
      // 写类：表未迁移 ⇒ 明确 fail-closed（占位必须真落库，否则幂等语义静默失效）。
      await requireTables();
      // 两轮上限只为覆盖一个窄竞态：占位行在"我们输掉 ON CONFLICT"与"读回"之间被 release/purge 删掉
      // （此时键重新可用）。⛔ 不是重试业务：两轮都拿不到就按"他人正持有"返回，由服务层有界等待。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const claimed = await run(CLAIM_IDEMPOTENT, [
          scope,
          keyHashHex,
          input.requestHash,
          input.expiresAt,
          input.now,
        ]);
        if (claimed.length > 0) return { status: 'claimed' };
        const existing = await run(SELECT_IDEMPOTENT, [scope, keyHashHex]);
        const row = existing[0];
        // 回执/占位刚被删除（release 失败路径或 purge）：再试一次，而不是把它误判成别人的占位。
        if (row === undefined) continue;
        // 同键异体：已完成回执或活跃占位都算冲突（与内存实现的四分支同义）。
        if (String(row['request_hash']) !== input.requestHash) return { status: 'conflict' };
        if (row['pending'] === true) return { status: 'in_progress' };
        return { status: 'completed', row: idempotencyRowFromRow(row) };
      }
      // 两次都没拿到行：键正被他人持有（有界等待后由服务层重试 claim）。
      return { status: 'in_progress' };
    },

    async completeIdempotent(scope, keyHashHex, row) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（终态回执不能静默丢）。
      await requireTables();
      await run(COMPLETE_IDEMPOTENT, [
        scope,
        keyHashHex,
        row.requestHash,
        JSON.stringify(row.payload),
        row.expiresAt,
      ]);
    },

    async releaseIdempotent(scope, keyHashHex) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（释放失败会让幂等键永久 pending）。
      await requireTables();
      // 只删**占位行**：已完成回执不因一次失败路径的释放动作而消失（与内存实现只 `claims.delete` 同义）。
      await run(
        `DELETE FROM public.recognition_idempotency
          WHERE scope = $1 AND key_hash = $2 AND pending`,
        [scope, keyHashHex],
      );
    },

    async purgeIdempotent(now) {
      // 写类（DELETE）：表未迁移 ⇒ 明确 fail-closed；调用方（写路径起始）会因此得到可诊断的 503。
      await requireTables();
      const rows = await run(
        `DELETE FROM public.recognition_idempotency
          WHERE expires_at <= $1::timestamptz
        RETURNING scope`,
        [now],
      );
      return rows.length;
    },

    // ---- 注销闭集（#19 延续片）：按主体清空（四表同一事务、先子后父；见 `purgeOwnerRows`） ----

    async purgeOwnerData(ownerId) {
      return purgeOwnerRows(ownerId);
    },

    async deleteAllByOwner(ownerId) {
      return (await purgeOwnerRows(ownerId)).records;
    },
  };
}
