/**
 * GY-R27 S10（#10）· 标签 OCR 域的 **PostgreSQL 实现**（迁移 `0024_ocr_persistence.sql`）。
 *
 * 逐方法与 `ocr/store.ts` 的内存实现对齐（本文件验收口径是**逐条**对齐，不是"大致等价"）：
 *   - `insertJob` / `insertOcr`：**唯一**写入口，同一 `id` 再写 ⇒ 抛错（文案与内存实现逐字相同：
 *     `任务 id 冲突` / `OCR 记录 id 冲突`）。重复判定**只**由主键裁决（`23505`），
 *     不存在"先 SELECT 再 INSERT"的检查-写入窗口。
 *   - `getJob` / `getOcr`：按主键单条读取；不存在 ⇒ `null`（与 Map 未命中同形）。
 *   - `updateJob` / `updateOcr`：CAS。**判定权在那条带 `WHERE revision = $2` 的 UPDATE**——
 *     读一次只为算出 `mutate` 的结果；并发写不会被覆盖：输的那条 UPDATE 返回 0 行 ⇒ 返回 `null`
 *     （不是"读到旧值就认为成功"）。
 *   - `commitTerminal`：**同一事务**内完成「行锁读 + CAS 校验 + 合法迁移校验 + 写 OCR 记录（可为 null）
 *     + 落任务终态」。CAS 失败（任务已被取消/已终态）⇒ 返回 `null` 且**不写任何记录**（旧回调不复活）；
 *     记录 id 冲突 ⇒ 抛错且任务行不变（事务回滚）。状态机的唯一事实来源仍是
 *     `ocr/state.ts` 的 `canTransitionJob`（**不**在 SQL 里再抄一份迁移表）。
 *   - 幂等台账：`findIdempotent` / `claimIdempotent` / `finalizeIdempotent` / `releaseIdempotent` /
 *     `purgeIdempotent` 五个方法各是**一条**语句。`claimIdempotent` 的"检查 + 写入"是单条
 *     `INSERT … ON CONFLICT (scope, key_hash) DO UPDATE … WHERE ocr_idempotency.expires_at <= $at
 *     RETURNING scope`：已存在且未到期 ⇒ 不更新、不返回行 ⇒ `'exists'`；不存在或已到期 ⇒
 *     写入/覆盖并返回行 ⇒ `'claimed'`。因此**并发下只有一个调用方拿到 `claimed`**（与内存实现
 *     "检查与写入之间没有 await"同义），也没有"先查后写"的窗口。
 *     `findIdempotent` **不**按过期过滤（与内存实现逐条一致：过期行由 `purgeIdempotent` 清理，
 *     且 `claimIdempotent` 会把到期行覆盖掉 ⇒ 到期条目不会被读成 `existing`）。
 *     `finalizeIdempotent` / `releaseIdempotent` 对"行不存在"是**空操作**（内存实现同样是 `return` /
 *     `delete` 未命中）。
 *
 * 连接与事务：沿用仓库既有 PG 方式（与 `favorites/store-pg.ts` / `community/store-pg.ts` 同口径）：
 * `pool.connect()` → `BEGIN` → `SET LOCAL lock_timeout = '4s'` → 业务 SQL → `COMMIT`
 * （异常 `ROLLBACK`）。只有需要临界区的 `commitTerminal` 走事务；其余方法各是单条语句。
 * ⛔ 缺 `connect()` 的池不会被静默降级成"无事务的两步写"：`commitTerminal` 会如实失败
 * （`PROVIDER_UNAVAILABLE`），因为"CAS 失败不写记录"这条不变量没有事务就无法保证。
 *
 * 错误折叠（与 `messages/store-pg.ts` 逐条同口径）：`57014`（语句超时）/`55P03`（锁不可得）⇒
 * `PROVIDER_TIMEOUT`；其余数据库异常 ⇒ `PROVIDER_UNAVAILABLE`。存储层自身的唯一性冲突用
 * `OcrStoreConflictError`（`instanceof Error`、文案与内存实现相同），**不**被折成数据库错误。
 *
 * 归属域：所有语句都带 `owner_user_id` 吗？**不是**——`getJob(id)` / `getOcr(id)` /
 * `updateJob` / `updateOcr` / `commitTerminal` 的接口签名**没有** owner 形参（改签名属停手条件），
 * 因此它们按主键操作；归属判定在服务层完成（`ocr/service.ts` 的 `getOwnedJob` / `getOwnedOcr`
 * 读到非本人即与"不存在"同形的 404）。写入路径上 `owner_user_id` 由调用方明确给出，
 * 列上 `NOT NULL` + `REFERENCES users (id) ON DELETE CASCADE` ⇒ 注销时任务与记录级联删除。
 *
 * 列的类型边界（如实登记，均在服务层不可达）：
 *   * `id` / `ocr_id` / `media_id` / `owner_user_id` 是 uuid 列：本域 id 恒由 `randomUUID()` 产生
 *     （`ocr/service.ts` 的 `idFactory` 默认值），非 uuid 形 id 会由数据库拒绝（`22P02` ⇒
 *     `PROVIDER_UNAVAILABLE`），而内存实现会把任意字符串当键——服务层入口已用 UUID 正则拦截，
 *     故该差异在生产不可达；
 *   * `state` / `kind` 的闭集由库侧 CHECK 守住：内存实现会存下闭集外的值，PG 会拒绝。
 *     本域 `mutate` 只写 `running` / `cancelled` / 终态（`state.ts` 的 `canTransitionJob` 已约束），
 *     故该差异同样在服务层不可达 —— 这是 PG 侧的**收紧**，不是放宽。
 *   * `updateJob` / `updateOcr` 的写回列是**白名单**（不可变键之外的业务列）：内存实现整体替换 Map 值，
 *     本实现只写这些列。`raw_fields` **在**白名单里（内存实现也允许 `mutate` 改它）；
 *     "校正不得改写 raw_fields" 由服务层 mutator + 单测保证，存储层不据此另设拒绝
 *     （否则两条实现的语义就不等价了）。
 */
import type { ErrorCode } from '../contract.ts';
import { ApiError } from '../errors.ts';
import { ledgerRowFromDomainJob, writeJobLedger } from '../jobs/ledger.ts';
import { isTransientDatabaseError } from '../db/pool.ts';
import {
  canTransitionJob,
  isJobState,
  isMatchState,
  parseCorrectionLedger,
  type DoseCard,
  type JobState,
  type LabelFields,
  type OcrVerificationDocument,
  type RegistryHerbicide,
} from './state.ts';
import type { IdempotencyRow, OcrJobRow, OcrOwnerPurgeCounts, OcrRow, OcrStore } from './store.ts';

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

export interface PostgresOcrStoreOptions {
  pool: TransactionalPool;
}

/** 存储层自身的唯一性冲突：文案与内存实现逐字相同，且不被数据库异常折叠改写。 */
export class OcrStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrStoreConflictError';
  }
}

/**
 * **「OCR 持久化表未迁移（0024）」** —— 与「数据库故障」严格区分的一类明确错误。
 *
 * 为什么要单列（R27-S10-r1 返修，CI `real-pg-17.11` 抓到的真回归）：
 * 真库集成测试会只应用**迁移子集**建库（如 `tests/integration/conversations-pg.mjs:57` 只跑
 * `0001/0002/0005/0008/0010/0012/0013`；`community-pg.mjs` 只跑 `0001/0022`；
 * `favorites-history-pg.mjs` 跑 `0001/0018`，`0008`（只建 `idempotency_keys`）加不加都不含 `0024`）
 * ⇒ 那种库里**没有** `ocr_*` 三表。
 * 首版实现把「表不存在」（`42P01`）与「数据库故障」一起折成 `PROVIDER_UNAVAILABLE`
 * 「OCR 数据库暂不可用」，于是 OCR 作业源的读路径把**无关域**的 `GET /jobs/{id}` 打成 503
 * （本该 200/404）——`conversations-pg.mjs:406` 就是这么红的。
 *
 * 语义（与 `admin/ops/flags-pg.ts` 的 `featureFlagsTableReady` 同族纪律）：
 * - **读类**：表不存在 ⇒ 视为「没有已持久化的 OCR 作业」⇒ 返回 `null`（与接线前内存 store 的对外行为一致）；
 * - **写类**：表不存在 ⇒ **fail-closed** 并抛本错误（点名迁移号），⛔ 绝不静默丢写、⛔ 绝不退化成内存 store；
 * - `retryable: false`：这是**部署/迁移未执行**，不是瞬时故障 —— 重试不会好，须跑 `0024`。
 */
export class OcrTablesMissingError extends ApiError {
  constructor() {
    super(
      'PROVIDER_UNAVAILABLE',
      'OCR 持久化表未迁移（0024_ocr_persistence.sql）：拒绝写入，避免静默丢数据',
      { retryable: false },
    );
    this.name = 'OcrTablesMissingError';
  }
}

/** 数据库异常的契约化折叠（与 `messages/store-pg.ts` 逐条同口径）。 */
export function classifyOcrDatabaseError(error: unknown): never {
  if (error instanceof OcrStoreConflictError) throw error;
  if (error instanceof ApiError) throw error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['57014', '55P03'].includes(code)) {
    throw new ApiError('PROVIDER_TIMEOUT', 'OCR 数据库响应超时', { retryable: true });
  }
  // `retryable` 分档（口径原文见 `../errors.ts` 的 `ApiError` 注释）：连接层故障（08xxx）、管理员干预
  // （53xxx / 57P0x）、串行化冲突（40001）、死锁（40P01）⇒ 同一请求稍后重试**确实**可能成功 ⇒ true；
  // 权限不足（42501）、库/表/凭据缺失（3D000 / 28P01 / 42P01）、函数缺失（42883）与无法归类的其余
  // 驱动错误 ⇒ 需运维改配置或修缺陷，重试永远不会好 ⇒ false（⛔ 恒 true 会把权限缺失伪装成下游抖动）。
  throw new ApiError('PROVIDER_UNAVAILABLE', 'OCR 数据库暂不可用', { retryable: isTransientDatabaseError(error) });
}

/**
 * `42P01`（`undefined_table`）＝「这条 SQL 指向的表不在」。本文件所有语句都写成
 * `public.ocr_*` **全限定**形式，因此它只可能表示「0024 未应用（或刚被回滚）」，
 * 不会被 `search_path` 差异误判 ⇒ 可安全地翻成 {@link OcrTablesMissingError}（R27-S10-r1）。
 */
const UNDEFINED_TABLE = '42P01';
const isUndefinedTable = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === UNDEFINED_TABLE;

/**
 * 迁移 `0024` 的**只读就绪探测**：三张表是否真实存在。
 *
 * 为什么是一条语句查三张表：三表由**同一个迁移文件**建出（单事务，不可能半建），
 * 但探测仍逐表 `IS NOT NULL` —— 若真的出现半迁移（人为 DROP、恢复不完整），
 * 也应判「未就绪」而不是让读路径看到一半的表。
 *
 * 为什么用 `to_regclass(...)` 而不是 `SELECT 1 FROM public.ocr_jobs`：
 * 表不存在时 `to_regclass` 返回 `NULL`（**不报错**），且**不依赖表级 SELECT 权限**，
 * schema 全限定 ⇒ 运行时角色受限的 `search_path` 也解析得到（与 `flags-pg.ts` 同口径）。
 */
const TABLES_READY_SQL =
  "SELECT (to_regclass('public.ocr_jobs') IS NOT NULL"
  + " AND to_regclass('public.ocr_records') IS NOT NULL"
  + " AND to_regclass('public.ocr_idempotency') IS NOT NULL) AS ready";

/** 就绪探测的三态：`unknown`（探不了）**不是** `missing`（确认没有）—— #282 的同族纪律。 */
export type OcrTablesProbe = 'ready' | 'missing' | 'unknown';


const JOB_COLUMNS =
  'id, revision, kind, owner_user_id, ocr_id, media_id, media_revision, state, deadline_at, created_at, updated_at, error_code';
const RECORD_COLUMNS =
  'id, revision, owner_user_id, media_id, media_revision, raw_fields, corrected_fields, verification, model_version, created_at, updated_at, deleted';

const INSERT_JOB = `INSERT INTO public.ocr_jobs (${JOB_COLUMNS})
     VALUES ($1::uuid, $2, $3, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12)
  RETURNING id`;

const INSERT_RECORD = `INSERT INTO public.ocr_records (${RECORD_COLUMNS})
     VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::timestamptz, $11::timestamptz, $12)
  RETURNING id`;

/** 内存实现的 `new Error(...)` 文案（逐字相同：调用方/测试按 message 判定，不改写成新文案）。 */
const JOB_CONFLICT_MESSAGE = '任务 id 冲突';
const RECORD_CONFLICT_MESSAGE = 'OCR 记录 id 冲突';

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
  return new ApiError('PROVIDER_UNAVAILABLE', `OCR ${what}形状不合约定（内部不变式违反）`, {
    retryable: false,
  });
}

/** `string | null`；类型不符返回 `undefined`（与"显式 null"区分开，后者是合法值）。 */
function textOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string') ? [...(value as string[])] : null;
}

/** 数据库行 → 契约 `LabelFields`（逐字段重建；多余键不随行，见文件头「列的类型边界」）。 */
function readLabelFields(value: unknown, column: string): LabelFields {
  const record = asRecord(parseJson(value));
  if (record === null) throw invariant(column);
  const registration = textOrNull(record['registration_number']);
  const name = textOrNull(record['name']);
  const dosageForm = textOrNull(record['dosage_form']);
  const rawIngredients = record['ingredients'];
  if (registration === undefined || name === undefined || dosageForm === undefined || !Array.isArray(rawIngredients)) {
    throw invariant(column);
  }
  const ingredients = rawIngredients.map((item) => {
    const row = asRecord(item);
    if (row === null) throw invariant(column);
    const nameText = textOrNull(row['name']);
    const contentText = textOrNull(row['content_text']);
    const unitText = textOrNull(row['unit_text']);
    if (nameText === undefined || nameText === null || contentText === undefined || contentText === null) {
      throw invariant(column);
    }
    if (unitText === undefined || unitText === null) throw invariant(column);
    return { name: nameText, content_text: contentText, unit_text: unitText };
  });
  return { registration_number: registration, name, ingredients, dosage_form: dosageForm };
}

/** 数据库行 → 契约 `Verification` 投影（五字段全必填；`match_state` 必须在闭集内）。 */
/**
 * `verification` 列的 jsonb → 存储形状（契约五字段 + 可选的用户校正台账）。
 *
 * ⚠ 台账键必须在这里**读回来**：`updateOcr` 的 `verification = $6::jsonb` 是整个文档整体写入，
 * 但只要读路径把它剥掉，下一次 `updateOcr`（CAS 的 mutate 基于读到的行）就会把台账写没。
 * 台账解析严格 fail-closed（`parseCorrectionLedger` 形状不合法即抛错，不"尽力解析"半个台账）。
 */
function readVerification(value: unknown): OcrVerificationDocument {
  const record = asRecord(parseJson(value));
  if (record === null) throw invariant('verification');
  const matchState = record['match_state'];
  if (typeof matchState !== 'string' || !isMatchState(matchState)) throw invariant('verification');
  const registration = record['registration'];
  if (registration !== undefined && registration !== null && asRecord(registration) === null) {
    throw invariant('verification');
  }
  const conflictFields = stringArray(record['conflict_fields']);
  const missingFields = stringArray(record['missing_fields']);
  const doseCards = record['dose_cards'];
  if (conflictFields === null || missingFields === null || !Array.isArray(doseCards)) {
    throw invariant('verification');
  }
  if (doseCards.some((card) => asRecord(card) === null)) throw invariant('verification');
  const ledger = parseCorrectionLedger(record['correction_log']);
  return {
    match_state: matchState,
    registration: registration === null || registration === undefined
      ? null
      : (structuredClone(registration) as RegistryHerbicide),
    conflict_fields: conflictFields,
    missing_fields: missingFields,
    dose_cards: structuredClone(doseCards) as DoseCard[],
    ...(ledger === undefined ? {} : { correction_log: ledger }),
  };
}

/** 幂等台账 `payload`：只存**不含凭据**的结果引用（如 `{job_id}` / `{accepted}`）。 */
function readPayload(value: unknown): Record<string, unknown> {
  const record = asRecord(parseJson(value));
  if (record === null) throw invariant('幂等台账 payload');
  return { ...record };
}

/** 数据库行 → 内部任务行（未知 state/kind 按内部不变式违反处理，不静默降级）。 */
function jobRowFromRow(row: Record<string, unknown>): OcrJobRow {
  const state = row['state'];
  if (typeof state !== 'string' || !isJobState(state)) throw invariant('任务 state');
  if (row['kind'] !== 'ocr') throw invariant('任务 kind');
  const errorCode = row['error_code'] === null || row['error_code'] === undefined ? null : String(row['error_code']);
  return {
    id: String(row['id']),
    revision: Number(row['revision']),
    kind: 'ocr',
    ownerUserId: String(row['owner_user_id']),
    ocrId: String(row['ocr_id']),
    mediaId: String(row['media_id']),
    mediaRevision: Number(row['media_revision']),
    state: state as JobState,
    deadlineAt: asDate(row['deadline_at']),
    createdAt: asDate(row['created_at']),
    updatedAt: asDate(row['updated_at']),
    errorCode: errorCode as ErrorCode | null,
  };
}

/** 数据库行 → 内部 OCR 记录行。 */
function ocrRowFromRow(row: Record<string, unknown>): OcrRow {
  return {
    id: String(row['id']),
    revision: Number(row['revision']),
    ownerUserId: String(row['owner_user_id']),
    mediaId: String(row['media_id']),
    mediaRevision: Number(row['media_revision']),
    rawFields: readLabelFields(row['raw_fields'], 'raw_fields'),
    correctedFields: readLabelFields(row['corrected_fields'], 'corrected_fields'),
    verification: readVerification(row['verification']),
    modelVersion: String(row['model_version']),
    createdAt: asDate(row['created_at']),
    updatedAt: asDate(row['updated_at']),
    deleted: row['deleted'] === true,
  };
}

function jobValues(row: OcrJobRow): unknown[] {
  return [
    row.id,
    row.revision,
    row.kind,
    row.ownerUserId,
    row.ocrId,
    row.mediaId,
    row.mediaRevision,
    row.state,
    row.deadlineAt,
    row.createdAt,
    row.updatedAt,
    row.errorCode,
  ];
}

function recordValues(row: OcrRow): unknown[] {
  return [
    row.id,
    row.revision,
    row.ownerUserId,
    row.mediaId,
    row.mediaRevision,
    JSON.stringify(row.rawFields),
    JSON.stringify(row.correctedFields),
    JSON.stringify(row.verification),
    row.modelVersion,
    row.createdAt,
    row.updatedAt,
    row.deleted,
  ];
}

export function createPostgresOcrStore({ pool }: PostgresOcrStoreOptions): OcrStore {
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
  async function probeTables(): Promise<OcrTablesProbe> {
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
   * - `missing`：由调用方按「读 ⇒ null / 写 ⇒ {@link OcrTablesMissingError}」分化处理；
   * - `unknown`（探测抛错/形状读不懂）：**抛**（fail-closed），⛔ 不缓存、⛔ 不当成 `missing`。
   */
  async function tablesReady(): Promise<'ready' | 'missing'> {
    if (tables !== null) return tables;
    const state = await probeTables();
    if (state === 'unknown') {
      // 探测抛错：先按**既有分类**折叠原因（57014/55P03 ⇒ PROVIDER_TIMEOUT，08xxx/40001 等瞬时 ⇒
      // PROVIDER_UNAVAILABLE + `retryable:true`，42501/28P01/42883 等运维动作 ⇒ `retryable:false`）。
      if (probeFailure !== null) classifyOcrDatabaseError(probeFailure);
      // 走到这里只剩「**应答形状读不懂**」（空行/非数组/`ready` 不是布尔）：这是确定性缺陷
      // （驱动或查询形状不对），同一请求重试永远不会变好 ⇒ `retryable:false`（R31-S-retryable 口径），
      // 原因分类入 `details` 供排障，⛔ 不再借「可能是抖动」把确定性失败标成可重试。
      throw new ApiError(
        'PROVIDER_UNAVAILABLE',
        'OCR 持久化表就绪探测结果未知（应答形状无法识别）：按数据库故障 fail-closed（未知 ≠ 未迁移）',
        { retryable: false, details: [{ field: 'ocr_tables', code: 'PROBE_SHAPE_UNKNOWN' }] },
      );
    }
    tables = state;
    return state;
  }

  /** 写类的前置门：表不存在 ⇒ 明确 fail-closed（绝不静默丢写、绝不退化成内存 store）。 */
  async function requireTables(): Promise<void> {
    if ((await tablesReady()) === 'missing') throw new OcrTablesMissingError();
  }

  async function run(text: string, values?: unknown[]): Promise<Array<Record<string, unknown>>> {
    try {
      const result = await pool.query(text, values);
      return result.rows;
    } catch (error) {
      if (isUndefinedTable(error)) {
        // 探测之后表被回滚/恢复不完整：失效缓存，下一次调用重探；本语句按「未迁移」处理。
        tables = null;
        throw new OcrTablesMissingError();
      }
      return classifyOcrDatabaseError(error);
    }
  }

  /** 写类语句：唯一性冲突只在这里翻成与内存实现同文案的冲突错误。 */
  async function runWrite(text: string, values: unknown[], conflictMessage: string): Promise<void> {
    try {
      await pool.query(text, values);
    } catch (error) {
      if (isUniqueViolation(error)) throw new OcrStoreConflictError(conflictMessage);
      if (isUndefinedTable(error)) {
        tables = null;
        throw new OcrTablesMissingError();
      }
      classifyOcrDatabaseError(error);
    }
  }

  /**
   * 读类：表未迁移 ⇒ `null`（等价于「没有已持久化的 OCR 作业」，与接线前内存 store 的对外行为一致）；
   * **真数据库故障照旧抛**（不被这一层吞掉）。
   */
  async function readOrMissing<T>(work: () => Promise<T | null>): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof OcrTablesMissingError) return null;
      throw error;
    }
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
        throw new OcrTablesMissingError();
      }
      return classifyOcrDatabaseError(error);
    } finally {
      connection?.release();
    }
  }

  /**
   * 注销闭集（R34 片 3 / #19）：按主体清空 OCR 域三表 —— **真删除、真行数**。
   *
   * 语句（三条 DELETE 在**同一事务**里，任一条失败整批回滚）：
   *   `DELETE FROM public.ocr_records     WHERE owner_user_id = $1::uuid RETURNING id`
   *   `DELETE FROM public.ocr_jobs        WHERE owner_user_id = $1::uuid RETURNING id`
   *   `DELETE FROM public.ocr_idempotency WHERE left(scope, char_length($1::text) + 1) = $1::text || chr(10) RETURNING scope`
   *
   * 为什么现在能直接 DELETE：R34 片 3 起 OCR 三表 DELETE 是**用户批准的表级例外**
   * （`deploy/postgres-cvm/sql/20-login-roles.sql` 的 R34 段 + `90-assert` 的
   * `allow_table_dml` 三元组），替换此前的 `SECURITY DEFINER` 路线。授权面若被收紧，这里会拿到
   * `42501` 并由 `classifyOcrDatabaseError` 折叠成可诊断的数据库错误 ⇒ 协议记 `blocked` +
   * `HANDLER_FAILED`，⛔ 不会被读成"清完了"。
   *
   * 行数口径：`RETURNING` 的行数 = **实际删除**的行数（不是"匹配行数"，也不是"执行了语句"）。
   * 顺序：**先子后父** —— `ocr_records` 是 `ocr_jobs` 的产物（两表之间没有外键，顺序按语义）。
   */
  async function purgeOwnerRows(ownerId: string): Promise<OcrOwnerPurgeCounts> {
    await requireTables();
    return withTransaction(async (sql) => {
      const records = await sql.query(
        'DELETE FROM public.ocr_records WHERE owner_user_id = $1::uuid RETURNING id',
        [ownerId],
      );
      const jobs = await sql.query(
        'DELETE FROM public.ocr_jobs WHERE owner_user_id = $1::uuid RETURNING id',
        [ownerId],
      );
      // 幂等台账没有主体列：scope 首段恒为主体 uuid + 换行（与迁移 0034 的同一条判据）。
      const idempotency = await sql.query(
        `DELETE FROM public.ocr_idempotency
          WHERE left(scope, char_length($1::text) + 1) = $1::text || chr(10)
      RETURNING scope`,
        [ownerId],
      );
      return {
        records: records.rows.length + jobs.rows.length,
        idempotency: idempotency.rows.length,
        tableCounts: { ocr_records: records.rows.length, ocr_jobs: jobs.rows.length },
      };
    });
  }

  return {
    persistent: true,

    async insertJob(row) {
      await requireTables();
      // GY-R71：台账行与源表行**同一个事务**（⛔ 不在 `runWrite` 之后补写 —— 那是两个提交点）。
      // 事务里因此不能再用 `runWrite`：它自己走 pool（自动提交），冲突折叠与未迁移折叠在这里原地重做。
      await withTransaction(async (sql) => {
        try {
          await sql.query(INSERT_JOB, jobValues(row));
        } catch (error) {
          if (isUniqueViolation(error)) throw new OcrStoreConflictError(JOB_CONFLICT_MESSAGE);
          throw error;
        }
        await writeJobLedger(sql, ledgerRowFromDomainJob('ocr', row, row.ocrId));
      });
    },

    async getJob(jobId) {
      if ((await tablesReady()) === 'missing') return null;
      return readOrMissing(async () => {
        const rows = await run(`SELECT ${JOB_COLUMNS} FROM public.ocr_jobs WHERE id = $1::uuid`, [jobId]);
        const row = rows[0];
        return row === undefined ? null : jobRowFromRow(row);
      });
    },
    async updateJob(jobId, expectedRevision, mutate) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（不静默当成"CAS 失败"，那会让调用方无限重试）。
      await requireTables();
      // GY-R71：读 / CAS 更新 / 台账 upsert 三句在**同一个事务**里（台账行不得比 CAS 结果先落或后落）。
      return withTransaction(async (sql) => {
        // 读一次只为算出 mutate 的结果；**判定权在下面的 UPDATE**（`WHERE revision = $2`），
        // 因此两次读之间即使有并发写，也不会被本方法覆盖（0 行 ⇒ null）。
        const current = await sql.query(
          `SELECT ${JOB_COLUMNS} FROM public.ocr_jobs WHERE id = $1::uuid`,
          [jobId],
        );
        const snapshot = current.rows[0];
        if (snapshot === undefined) return null;
        if (Number(snapshot['revision']) !== expectedRevision) return null;
        const next = mutate(jobRowFromRow(snapshot));
        const rows = await sql.query(
          `UPDATE public.ocr_jobs
              SET revision = $3,
                  state = $4,
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
        await writeJobLedger(sql, ledgerRowFromDomainJob('ocr', updated, updated.ocrId));
        return updated;
      });
    },

    async commitTerminal(jobId, expectedRevision, terminal, ocr, at) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（事务里根本不发语句）。
      await requireTables();
      return withTransaction(async (sql) => {
        // 行锁：并发的取消/另一次终态提交在本行上排队，随后各自按 revision 重新求值 ⇒ 只有一个能成功。
        const locked = await sql.query(
          `SELECT ${JOB_COLUMNS} FROM public.ocr_jobs WHERE id = $1::uuid FOR UPDATE`,
          [jobId],
        );
        const snapshot = locked.rows[0];
        if (snapshot === undefined) return null;
        const current = jobRowFromRow(snapshot);
        if (current.revision !== expectedRevision) return null;
        // 终态迁移必须合法：已被取消/已终态的任务不会被迟到结果改写（状态机唯一事实来源在 state.ts）。
        if (!canTransitionJob(current.state, terminal.state)) return null;
        if (ocr !== null) {
          try {
            await sql.query(INSERT_RECORD, recordValues(ocr));
          } catch (error) {
            // 与内存实现同语义：记录 id 冲突 ⇒ 抛错，且任务行**没有**被改写（事务在此回滚）。
            if (isUniqueViolation(error)) throw new OcrStoreConflictError(RECORD_CONFLICT_MESSAGE);
            throw error;
          }
        }
        // revision 恰好 +1（`revision + 1` 在 SQL 里算，行已被锁住 ⇒ 不会与并发写叠加成 +2）。
        const updated = await sql.query(
          `UPDATE public.ocr_jobs
              SET state = $3,
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
        await writeJobLedger(sql, ledgerRowFromDomainJob('ocr', committed, committed.ocrId));
        return committed;
      });
    },

    async insertOcr(row) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（绝不静默丢写、绝不退化成内存 store）。
      await requireTables();
      await runWrite(INSERT_RECORD, recordValues(row), RECORD_CONFLICT_MESSAGE);
    },

    async getOcr(ocrId) {
      if ((await tablesReady()) === 'missing') return null;
      return readOrMissing(async () => {
        const rows = await run(`SELECT ${RECORD_COLUMNS} FROM public.ocr_records WHERE id = $1::uuid`, [ocrId]);
        const row = rows[0];
        return row === undefined ? null : ocrRowFromRow(row);
      });
    },

    async updateOcr(ocrId, expectedRevision, mutate) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（不得当成"CAS 失败"返回 null，那会让调用方误以为并发冲突）。
      await requireTables();
      const current = await run(`SELECT ${RECORD_COLUMNS} FROM public.ocr_records WHERE id = $1::uuid`, [ocrId]);
      const snapshot = current[0];
      if (snapshot === undefined) return null;
      if (Number(snapshot['revision']) !== expectedRevision) return null;
      const next = mutate(ocrRowFromRow(snapshot));
      const rows = await run(
        `UPDATE public.ocr_records
            SET revision = $3,
                raw_fields = $4::jsonb,
                corrected_fields = $5::jsonb,
                verification = $6::jsonb,
                model_version = $7,
                updated_at = $8::timestamptz,
                deleted = $9
          WHERE id = $1::uuid AND revision = $2
        RETURNING ${RECORD_COLUMNS}`,
        [
          ocrId,
          expectedRevision,
          next.revision,
          JSON.stringify(next.rawFields),
          JSON.stringify(next.correctedFields),
          JSON.stringify(next.verification),
          next.modelVersion,
          next.updatedAt,
          next.deleted,
        ],
      );
      const row = rows[0];
      return row === undefined ? null : ocrRowFromRow(row);
    },

    // ---- 幂等台账（本域独立的 ocr_idempotency；`payload` 占位期就有值，`pending` 是显式列） ----

    async findIdempotent(scope, keyHashHex) {
      // 读类：表未迁移 ⇒ null（「没有已持久化的幂等占位」），与接线前内存实现的未命中同形。
      if ((await tablesReady()) === 'missing') return null;
      return readOrMissing(async () => {
        // 与内存实现逐条一致：**不**按过期过滤（到期行由 claim 覆盖、由 purge 清理）。
        const rows = await run(
          `SELECT request_hash, payload, pending, expires_at
             FROM public.ocr_idempotency
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
      // 单条语句 = 「检查 + 写入」同一临界区：`ON CONFLICT … DO UPDATE … WHERE expires_at <= $at`
      // 未到期 ⇒ WHERE 为假 ⇒ 不更新、不返回行 ⇒ 'exists'；否则写入/覆盖 ⇒ 'claimed'。
      const rows = await run(
        `INSERT INTO public.ocr_idempotency (scope, key_hash, request_hash, payload, pending, expires_at)
              VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz)
         ON CONFLICT (scope, key_hash) DO UPDATE
                 SET request_hash = EXCLUDED.request_hash,
                     payload = EXCLUDED.payload,
                     pending = EXCLUDED.pending,
                     expires_at = EXCLUDED.expires_at
               WHERE public.ocr_idempotency.expires_at <= $7::timestamptz
           RETURNING scope`,
        [scope, keyHashHex, row.requestHash, JSON.stringify(row.payload), row.pending, row.expiresAt, at],
      );
      return rows.length > 0 ? 'claimed' : 'exists';
    },

    async finalizeIdempotent(scope, keyHashHex, payload) {
      // 写类：表未迁移 ⇒ 明确 fail-closed（终态回填不能静默丢）。
      await requireTables();
      // 行不存在 ⇒ 0 行更新（空操作），与内存实现的 `if (row === undefined) return;` 同义。
      await run(
        `UPDATE public.ocr_idempotency
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
      await run('DELETE FROM public.ocr_idempotency WHERE scope = $1 AND key_hash = $2', [scope, keyHashHex]);
    },

    async purgeIdempotent(now) {
      // 写类（DELETE）：表未迁移 ⇒ 明确 fail-closed；调用方（claim 起始）会因此得到可诊断的 503。
      await requireTables();
      const rows = await run(
        'DELETE FROM public.ocr_idempotency WHERE expires_at <= $1::timestamptz RETURNING scope',
        [now],
      );
      return rows.length;
    },

    purgeOwnerData: purgeOwnerRows,

    async deleteAllByOwner(ownerId) {
      // 注销协议的简化形态：只回报正文表行数（幂等台账行数由 `purgeOwnerData` 单独给）。
      return (await purgeOwnerRows(ownerId)).records;
    },
  };
}
