/**
 * 平台级作业的**真实 Postgres 读面 / 取消面**（`AdminJobPort` 的生产实现，GY-I18 第一批）。
 *
 * ## 为什么读域内作业表（四源），而不是 `public.jobs`
 * `public.jobs`（建表：`services/api/db/migrations/0001_initial_schema.sql:203-231`）**不是死表**，它有人写：唯一写入点是 `services/api/src/jobs/ledger.ts:268-281` 的 `JOB_LEDGER_UPSERT_SQL`（向 `public.jobs` 写行的 `INSERT`，15 列显式 + `ON CONFLICT (id) DO UPDATE`）；
 * 已接源 `LEDGER_WIRED_SOURCES` = `ocr` / `recognition` / `transcription` / `answer`（`ledger.ts:78`），未接的只有 `moderation` / `synthesis`（理由见 `UNWIRED_SOURCES_REASON`，`ledger.ts:102`）；
 * **本文件的取消事务也写同一张表**（`:618-621`）。真实作业行**另**落在各域自己的表：`public.ocr_jobs`（`0024_ocr_persistence.sql`）/ `public.recognition_jobs`（`0025_*`）/ `public.speech_jobs`（`0026_speech_persistence.sql`）。
 * **读域内表、不读台账的真正理由**：`AdminJobView.target_ref` 要的是**域内记录行**的真实 `revision`（`LEFT JOIN public.ocr_records` / `recognition_records` / `transcriptions` 取 `r.revision`，见 `:114-131`），台账行给的是「作业状态迁移计数」而不是记录版本 —— **不是因为台账没人写**。
 * ✅ **W36：四源全接** —— `SOURCES` 仍是三张域内作业表，读面/取消面改用 `ALL_SOURCES`（末尾追加 `ANSWER_SOURCE`，DML 落在第 4 张域表 `public.conversation_turns`）⇒ 问答作业在运维台**可见也可取消**，取消走 `ledgerRowFromTurn` 写同一张 `public.jobs`。旧口径「`answer` 已接台账但读面只有三源」的缺口到此闭合。（本段刻意不写那条 `INSERT` 的语句字面量：`tests/unit/ai-ops-ledger-pins.test.mjs` 钉子① 把注释里的语句也记成命中，白名单逐条登记、本片不动它。）
 *
 * 三张表的记录 ID 列名不同（`ocr_id` / `recognition_id` / `transcription_id`），所以下面每条 SQL 都
 * 写成**字面量表名、不做表名拼接**：`tests/unit/sql-column-coverage.test.mjs` 按 SQL 字面量提取
 * 表/列。本文件已按授权登记进 `ADDITIONAL_SQL_HOST_FILES`，走的是**审计**（表/列真被读），
 * 不是 `UNAUDITED_SQL_HOSTS` 那种"登记即豁免"的桶。
 *
 * ## 读面口径（如实，不伪造）
 * - `target_ref` 指向**作业产出的记录**（`public.ocr_records` / `public.recognition_records` /
 *   `public.transcriptions`），`revision` 取记录行的**真实版本列**（SQL 里 `r.revision`，投影成
 *   `target_revision`）。作业行自己的 `revision` 是「状态迁移计数」，`target_ref.revision` 是
 *   「目标记录版本」，**两条不同的时钟**，不能混用：
 *   取消会让作业 `revision` 1→2，而 `service.ts:801-808` 要求取消前后 `target_ref` 三字段完全一致
 *   ⇒ 用作业 revision 会让每次取消都以 503 收场。
 * - 记录**尚未创建**时退回 `1`：记录行只由终态事务那一笔写入（`ocr/store-pg.ts:597` /
 *   `recognitions/store-pg.ts:672` / `speech/store-pg.ts` 的 `commitTerminal`），初始 `revision`
 *   恒为 1。这与三域自己的读面**同一口径**（`ocr/service.ts:282`、`recognitions/service.ts:266`、
 *   `speech/service.ts:244-246`：`record === null ? 1 : record.revision`），不是"随便占位"。
 *   取消面因此天然成立：只有 `queued` / `running` 能被取消（`jobs-pg.ts` 的 UPDATE `WHERE`），
 *   这两个状态的行**必然还没有记录** ⇒ 取消前后都是 `1`，不存在"取消瞬间取到旧值"的错位。
 *   ⚠ `lockSql` / `updateSql` **故意不 JOIN**：取消事务的语句与行锁口径不因本片改动半分毫。
 * - `result` 恒 `null`：契约 `AdminJob.result` 是 `{"type": "null"}`（`fields.ts:101`）。
 * - `state` / `error_code` 逐值校验：不符即 503 `PROVIDER_UNAVAILABLE`（宁可说"读不到"，也不把
 *   陌生文本塞进后台列表）。
 * - 列表过滤（`state` / `error_code`）**下推到 SQL**（`WHERE state = $2::<cast>`，值全部绑定），
 *   不在内存里筛：硬上限 200 会把匹配项挤出去，那样过滤等于没生效。闭集外的**入参**在服务层
 *   判 400 `INVALID_REQUEST`（⛔ 不是 503：503 的语义是"读出来的值不认识"）。
 *   ⚠ `state` 的 cast **按源区分**（`ocr_jobs` 是 `text`+`CHECK`，`recognition_jobs` /
 *   `speech_jobs` 是 `job_state` 枚举）——统一写 `::text` 会在枚举源上抛
 *   `42883 operator does not exist: job_state = text`，详见 `listWhereFor` 上方注释。
 *
 * ## 取消口径（终态不可复活）
 * 只有 `queued` / `running` 能迁移到 `cancelled`（`services/api/src/ocr/state.ts:175-180`），
 * 因此 UPDATE 的 WHERE 同时带 `state IN ('queued','running')`；已终态的行由端口自己判成
 * `'TERMINAL'`，而不是让调用方收到一个"什么都没发生"的成功。
 */
import type { PoolClient } from 'pg';
import { ApiError } from '../../errors.ts';
import { ERROR_CODES, type ErrorCode } from '../../contract.ts';
import { parseAdminJobFilter } from './jobs.ts';
import { JOB_KINDS } from './types.ts';
import { ledgerRowFromDomainJob, ledgerRowFromTurn, writeJobLedger, type LedgerWiredSource } from '../../jobs/ledger.ts';
import type {
  AdminJobCancelAuditInput,
  AdminJobFilter,
  AdminJobPort,
  AdminJobView,
  CancelJobOutcome,
  JobKind,
} from './types.ts';

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
 * 取消审计的**同事务**写入点（迁移 `0043_admin_job_cancel_audit.sql`）。
 *
 * 为什么是这一条 `SELECT`、而不是"更新后再去写审计"：
 * `updateSql` 与这条 `SELECT public.record_admin_job_cancel_audit(…)` 跑在**同一个**
 * `client` / 同一个事务里，`COMMIT` 之前任何一步抛错都会整体 `ROLLBACK` —— 于是
 * 「作业已 cancelled 但没有审计行」这种补不回来的缺口在库层就不可能出现
 * （监工 #589）。反过来说，审计表是 append-only 的（触发器拦 UPDATE/DELETE，G0006），
 * 事后补写这条路本来就走不通。
 *
 * **静态列审计（`tests/unit/sql-column-coverage.test.mjs`）为什么不会把这条当成漏登记**：
 * 该工具按字面量解析语句，`SELECT` 里**没有 `FROM`** ⇒ 既不产生表名，也不产生列名
 * （`parseSqlText` 的 `locate('FROM') === null ⇒ return [base]`），`public.` 前缀也不在
 * `INSERT INTO|DELETE FROM|UPDATE|FROM|JOIN` 任一关键字之后。函数调用本身只需要
 * `EXECUTE`，而 `EXECUTE` 在 `deploy/postgres-cvm/sql/20-login-roles.sql` 的
 * `gy-r18-job-cancel-audit-grant` 区域授予运行时角色，表级直写权一行都没有。
 */
const CANCEL_AUDIT_SQL =
  'SELECT public.record_admin_job_cancel_audit($1::uuid, $2::uuid, $3::integer, $4::text, $5::uuid) AS audit_event_id';

/**
 * 四个作业源的**统一读面**（三张域内作业表 + `public.conversation_turns` 的问答轮次）。
 *
 * 为什么不写成 `'ocr'::text AS kind, ocr_id AS record_id … UNION ALL`：本仓库的静态列审计
 * （`tests/unit/sql-column-coverage.test.mjs`）会把 `AS` 别名当成"要读的列名"，于是
 * `record_id` 这类**投影别名**会被判成未授权列（实测 6 条红）。所以 SQL 里只出现真实列：
 * `ocr_id` / `recognition_id` / `transcription_id`；`answer` 源把轮次主键投影成 `j.id AS record_id`
 * （该表主键就叫 `id`，与作业 ID 撞名），`kind` 与 `record_id` 的落地一律由 `projectRow` 按来源补。
 *
 * 每条语句的列面都是各表 12 列里的 7 列（`id / revision / <record> / state / deadline_at /
 * created_at / error_code`），已在 `deploy/postgres-cvm/sql/20-login-roles.sql:527-534`
 * 等四处按列授予运行时角色（`answer` 源是 `:1115-1124`，两列带 `job_` 前缀）。
 *
 * ## `target_ref.revision` 的真实来源：`LEFT JOIN <记录表>` 取 `revision`
 * 读面（list / get）在作业表上 `LEFT JOIN` 对应记录表（`ocr_records` / `recognition_records` /
 * `transcriptions`），投影 `r.revision AS target_revision`。四条硬约束决定了这个写法：
 * 1. **必须 LEFT JOIN**：`*_jobs.<record>_id` 没有外键（记录由 `commitTerminal` 同一事务落库，
 *    `0024_ocr_persistence.sql:80-101` 注释明说），未到终态的作业查记录表取不到行；INNER JOIN
 *    会让排队中的作业从运维台**整条消失**（`answer` 源没有记录表 ⇒ 不 JOIN，见 `ANSWER_SOURCE`）。
 * 2. **必须显式别名 `j` / `r`**：三张记录表也都有 `id` / `revision` / `created_at`
 *    ⇒ 不限定会 `42702 column reference "id" is ambiguous`。故 `listTail` 的 `ORDER BY` 与
 *    `getSql` 的 `WHERE` 都带 `j.` 前缀。
 * 3. **`state` / `error_code` 不加前缀**：这两列在三张记录表里都不存在（`0024:109-126` /
 *    `0025:131-151` / `0026:112-130`），不歧义 ⇒ `LIST_STATE_EQ` 那组字面量原样不动；只有
 *    `answer` 源要换列名（`job_state` / `job_error_code`，见 `columnNameFor`）。
 * 4. **⛔ 不能改写成标量子查询**：静态列审计（`tests/unit/sql-column-coverage.test.mjs`）把
 *    SELECT / RETURNING 里的 `public.ocr_records` 当成**列名**（限定名被剥成 `ocr_records`），
 *    于是要求 `ocr_jobs.ocr_records` 列 ⇒ 必红。改成 JOIN 后，`parseSqlText` 只读 `FROM` 后的
 *    第一张表（`:1653`），JOIN 的表不进表集、`ON r.id = j.ocr_id` 不被当列 ⇒ 那三源的语句数、
 *    表集与列要求**零漂移**（`answer` 源的四条另计：`ALL_SOURCES` 把语句数从 12 抬到 16）。
 */
interface JobSource {
  /**
   * 四个源都**已接入**统一台账（`LEDGER_WIRED_SOURCES`，`jobs/ledger.ts:78`）。取消要在同一事务里写
   * `public.jobs`，该写入点按来源分两个映射函数：三个域内源走 `ledgerRowFromDomainJob`，`answer` 走 `ledgerRowFromTurn`
   * （轮次表列名以 `job_` 打头，入参是 `TurnJobLedgerInput`）。`kind` 全程用 `LedgerWiredSource`：
   * 新增一个源却忘了接台账仍会在类型层红（两个映射函数都收不到它），而不是运行到取消那一刻才炸；仍是 `JobKind` 子集。
   */
  readonly kind: LedgerWiredSource;
  readonly recordColumn: 'ocr_id' | 'recognition_id' | 'transcription_id' | 'record_id';
  /**
   * 列表读面的 `SELECT … FROM <真实表>` 部分（**不含** `WHERE` / `ORDER BY` / `LIMIT`）。
   * 过滤条件拼在 `listSelect` 与 `listTail` 之间，因此拆成两段而不是一整条。
   */
  readonly listSelect: string;
  /** 列表读面的收尾（`ORDER BY` + `LIMIT`；`$1` 恒为硬上限，过滤值从 `$2` 起）。 */
  readonly listTail: string;
  /**
   * `state` 列的**真实类型**，决定列表过滤里 `state = $2::<cast>` 用哪种 cast。
   *
   * 四个源并不一致（实测迁移原文）：
   * - `public.ocr_jobs.state` 是 `text` + `CHECK (state IN (…7 值…))`（`0024_ocr_persistence.sql:93-95`）；
   * - `public.recognition_jobs.state` 是 `job_state` 枚举（`0025_recognitions_persistence.sql:117`）；
   * - `public.speech_jobs.state` 是 `job_state` 枚举（`0026_speech_persistence.sql:98`），枚举本体在 `0001_initial_schema.sql:24`；
   * - `public.conversation_turns.job_state` 是 `varchar(20)` + `CHECK` 七值（`0013_conversations.sql:71-72`），按文本比。
   *
   * ⚠ 在 PG 里 `枚举列 = text 参数` **没有**隐式转换 ⇒ 统一写 `$2::text` 会让枚举源抛
   * `42883 operator does not exist: job_state = text`（真库臂实测 500）。故 cast 必须按源区分。
   */
  readonly stateCast: 'text' | 'job_state';
  readonly getSql: string;
  /**
   * 取消事务里的行锁读（`FOR UPDATE`）。**故意不 JOIN 记录表**：取消只对 `queued` / `running`
   * 成功，这两个状态的行必然还没有记录（记录由 `commitTerminal` 在终态那一笔事务里写），
   * 多一次 JOIN 只换来一个恒为 `NULL` 的列。行锁口径（`FOR UPDATE` 的范围）也不因本片改动。
   */
  readonly lockSql: string;
  /** 取消的 CAS 更新。**故意不 JOIN**：`RETURNING` 里的表达式会被静态列审计当成列名（见上）。 */
  readonly updateSql: string;
}

/**
 * 四张表的 SQL **逐条写死**（表名/列名都不插值）。
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
    listSelect:
      'SELECT j.id, j.revision, j.ocr_id, j.state, j.deadline_at, j.created_at, j.error_code, r.revision AS target_revision FROM public.ocr_jobs AS j LEFT JOIN public.ocr_records AS r ON r.id = j.ocr_id',
    listTail: ' ORDER BY j.created_at DESC, j.id DESC LIMIT $1::integer',
    // `ocr_jobs.state` 是 text + CHECK（0024:93-95），按文本比。
    stateCast: 'text',
    getSql:
      'SELECT j.id, j.revision, j.ocr_id, j.state, j.deadline_at, j.created_at, j.error_code, r.revision AS target_revision FROM public.ocr_jobs AS j LEFT JOIN public.ocr_records AS r ON r.id = j.ocr_id WHERE j.id = $1::uuid',
    lockSql:
      'SELECT id, revision, ocr_id, owner_user_id, media_id, media_revision, state, deadline_at, created_at, error_code FROM public.ocr_jobs WHERE id = $1::uuid FOR UPDATE',
    updateSql:
      "UPDATE public.ocr_jobs SET state = 'cancelled', revision = revision + 1, updated_at = now() WHERE id = $1::uuid AND revision = $2::integer AND state IN ('queued','running') RETURNING id, revision, ocr_id, state, deadline_at, created_at, error_code, updated_at",
  },
  {
    kind: 'recognition',
    recordColumn: 'recognition_id',
    listSelect:
      'SELECT j.id, j.revision, j.recognition_id, j.state, j.deadline_at, j.created_at, j.error_code, r.revision AS target_revision FROM public.recognition_jobs AS j LEFT JOIN public.recognition_records AS r ON r.id = j.recognition_id',
    listTail: ' ORDER BY j.created_at DESC, j.id DESC LIMIT $1::integer',
    // `recognition_jobs.state` 是 job_state 枚举（0025:117）⇒ 必须显式转成枚举再比。
    stateCast: 'job_state',
    getSql:
      'SELECT j.id, j.revision, j.recognition_id, j.state, j.deadline_at, j.created_at, j.error_code, r.revision AS target_revision FROM public.recognition_jobs AS j LEFT JOIN public.recognition_records AS r ON r.id = j.recognition_id WHERE j.id = $1::uuid',
    lockSql:
      'SELECT id, revision, recognition_id, owner_user_id, media_id, media_revision, state, deadline_at, created_at, error_code FROM public.recognition_jobs WHERE id = $1::uuid FOR UPDATE',
    updateSql:
      "UPDATE public.recognition_jobs SET state = 'cancelled', revision = revision + 1, updated_at = now() WHERE id = $1::uuid AND revision = $2::integer AND state IN ('queued','running') RETURNING id, revision, recognition_id, state, deadline_at, created_at, error_code, updated_at",
  },
  {
    kind: 'transcription',
    recordColumn: 'transcription_id',
    listSelect:
      'SELECT j.id, j.revision, j.transcription_id, j.state, j.deadline_at, j.created_at, j.error_code, r.revision AS target_revision FROM public.speech_jobs AS j LEFT JOIN public.transcriptions AS r ON r.id = j.transcription_id',
    listTail: ' ORDER BY j.created_at DESC, j.id DESC LIMIT $1::integer',
    // `speech_jobs.state` 是 job_state 枚举（0026:98）⇒ 同 recognition，显式转枚举。
    stateCast: 'job_state',
    getSql:
      'SELECT j.id, j.revision, j.transcription_id, j.state, j.deadline_at, j.created_at, j.error_code, r.revision AS target_revision FROM public.speech_jobs AS j LEFT JOIN public.transcriptions AS r ON r.id = j.transcription_id WHERE j.id = $1::uuid',
    lockSql:
      'SELECT id, revision, transcription_id, owner_user_id, media_id, media_revision, state, deadline_at, created_at, error_code FROM public.speech_jobs WHERE id = $1::uuid FOR UPDATE',
    updateSql:
      "UPDATE public.speech_jobs SET state = 'cancelled', revision = revision + 1, updated_at = now() WHERE id = $1::uuid AND revision = $2::integer AND state IN ('queued','running') RETURNING id, revision, transcription_id, state, deadline_at, created_at, error_code, updated_at",
  },
];


/**
 * 列表过滤的 `WHERE` 片段（**只写真实列名**；值全部走绑定参数，⛔ 不拼值）。
 *
 * 参数编号：`$1` 恒为硬上限 `LIMIT`，过滤值从 `$2` 起 ⇒ 三种组合各写一条，不做编号插值。
 *
 * 为什么单独成字面量、且**以空格开头**：静态列审计（`tests/unit/sql-column-coverage.test.mjs`
 * 的 `SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE)\s+\S/i`）只把首个 token 是那四个动词的
 * 字面量记成语句；`' WHERE …'` 既不计入语句数也不进 opaque 登记，于是本文件的
 * SQL 语句数只由「源数 × list/get/lock/update」决定（四源 ⇒ 16 条），这四个片段一条都不加。
 *
 * ## cast 口径（**按源区分**，别再改回统一 `::text`）
 * `state` 的列类型三表不一致（见 `JobSource.stateCast`）：`ocr_jobs.state` 是 `text`+`CHECK`
 * （`0024_ocr_persistence.sql:93-95`），`recognition_jobs.state` / `speech_jobs.state` 是
 * `job_state` 枚举（`0025:117` / `0026:98`，枚举本体 `0001_initial_schema.sql:24`）。
 * PG 对「枚举列 = text 参数」**没有隐式转换**，统一写 `$2::text` 会让两个枚举源抛
 * `42883 operator does not exist: job_state = text` ⇒ 后台列表直接 500（真库臂实测）。
 * 所以 `state` 的 cast 由 `source.stateCast` 决定；过滤值进 SQL 前已过闭集校验（七值之一），
 * `::job_state` 不会因非法值抛错。
 *
 * `error_code` 四表都是字符串列（`0024:100` / `0025:122` / `0026:103` / `0013:75` 的 `job_error_code varchar(80)`），
 * `varchar` 与 `text` 二进制兼容，故统一 `$2::text` / `$3::text`；cast 不按源区分，只有列名要换（`columnNameFor`）。
 */
const LIST_WHERE_LEAD = ' WHERE ';
const LIST_STATE_EQ = 'state = $2::';
const LIST_ERROR_CODE_EQ = 'error_code = $2::text';
const LIST_AND_ERROR_CODE_AFTER_STATE = ' AND error_code = $3::text';

/**
 * 过滤组合 → (`WHERE` 片段, 绑定值)；`state` 的 cast 取该源的 `stateCast`（见上）。
 * 两个字段都不给 ⇒ 片段为空串、值也为空 ⇒ 语句与改动前**逐字相同**（无 `WHERE`）。
 */
function listWhereFor(
  source: JobSource,
  filter: AdminJobFilter,
): { where: string; values: readonly unknown[] } {
  const hasState = filter.state !== undefined;
  const hasErrorCode = filter.error_code !== undefined;
  const stateEq = LIST_STATE_EQ.replace('state', columnNameFor(source, 'state')) + source.stateCast;
  if (hasState && hasErrorCode) {
    return {
      where: LIST_WHERE_LEAD + stateEq + LIST_AND_ERROR_CODE_AFTER_STATE.replace('error_code', columnNameFor(source, 'error_code')),
      values: [filter.state, filter.error_code],
    };
  }
  if (hasState) return { where: LIST_WHERE_LEAD + stateEq, values: [filter.state] };
  if (hasErrorCode) return { where: LIST_WHERE_LEAD + LIST_ERROR_CODE_EQ.replace('error_code', columnNameFor(source, 'error_code')), values: [filter.error_code] };
  return { where: '', values: [] };
}

/** 导出用：给 `ADMIN_JOB_SQL.listWhere` 现算三种组合的片段（与运行时同一函数，不会漂移）。 */
const listWhereExportFor = (source: JobSource) => ({
  kind: source.kind,
  /** 该源 `state` 的真实类型 ⇒ `state = $2::<cast>` 里的 cast。 */
  stateCast: source.stateCast,
  where: {
    state: listWhereFor(source, { state: 'failed' }).where,
    error_code: listWhereFor(source, { error_code: 'PROVIDER_TIMEOUT' }).where,
    state_and_error_code: listWhereFor(source, { state: 'failed', error_code: 'PROVIDER_TIMEOUT' })
      .where,
  },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `pg` 的 `timestamptz` 列读出来是 `Date`，替身/夹具里可能是 ISO 串 ⇒ 两种都收成 `Date`。
 * GY-R71 的台账写入需要真实 `Date`（列绑定是 `$N::timestamptz`），⛔ 不用 `String(...)` 再塞回去。
 */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/**
 * 目标记录**尚未创建**时的 `target_ref.revision`（契约下限 `revision >= 1` 的最小合法值）。
 *
 * 这是「记录行的初始版本」而不是"占位 1"：记录只在终态事务里以 `revision = 1` 写入
 * （`ocr/store-pg.ts:597` / `recognitions/store-pg.ts:672` / `speech/store-pg.ts:558` 的
 * `commitTerminal`），之后只由记录级 CAS 递增。三域自己的读面是同一口径
 * （`ocr/service.ts:282`、`recognitions/service.ts:266`、`speech/service.ts:246`），
 * 管理台读面必须与之对齐，否则同一个 target 在两个接口上会报出不同版本。
 */
const UNCREATED_RECORD_REVISION = 1;

/** 库行投影的产物（三源共用），见 `projectRow`。 */
export interface JobRow {
  readonly id: string;
  readonly revision: number;
  readonly kind: string;
  readonly record_id: string;
  readonly state: string;
  readonly deadline_at: unknown;
  readonly created_at: unknown;
  readonly error_code: string | null;
  /**
   * 目标记录的真实 `revision`（SQL 的 `r.revision AS target_revision`）。
   * `null` = **记录行尚不存在**（`LEFT JOIN` 无匹配，或该语句不读记录表：`lockSql` / `updateSql`）。
   */
  readonly target_revision: number | null;
  /**
   * GY-R71：取消时写统一台账要用的三个**域事实** —— `owner_id`、`media_id`（台账 `target_id`）、
   * `media_revision`（台账 `entity_revision`）。只有 `lockSql` 读它们；`listSql` / `getSql` /
   * `updateSql` 与行锁语句的取舍见各自注释 ⇒ 在那些投影里为 `null`，与 `target_revision`
   * 同一种「这条语句没读该列」的表示法（⛔ 不是"值为空"）。
   */
  readonly owner_user_id: string | null;
  readonly media_id: string | null;
  readonly media_revision: number | null;
  /** 取消 `UPDATE … updated_at = now()` 回传的**库时钟**：台账 `updated_at` 直接沿用它。 */
  readonly updated_at: unknown;
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
    // `undefined`（语句没读该列，如 `lockSql` / `updateSql`）与 `null`（LEFT JOIN 无匹配）同义：
    // 都表示"这行没有可报的记录版本"，由 `toAdminJobView` 折成初始值。
    target_revision: (row.target_revision ?? null) as number | null,
    owner_user_id: (row['owner_user_id'] ?? null) as string | null,
    media_id: (row['media_id'] ?? null) as string | null,
    media_revision: (row['media_revision'] ?? null) as number | null,
    updated_at: row['updated_at'] ?? null,
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

/**
 * 取消事务里审计写不进去时的错误。
 *
 * 措辞刻意写全「已回滚，取消未生效」：调用方看到 503 时必须能判断出
 * **作业状态没有变**，而不是"取消成功了但审计失败"（那种缺口本片就是为了消灭它）。
 * `retryable: false` 与既有口径一致：同一请求重试能不能成，取决于审计面是否恢复，
 * 不是这一条请求本身的问题。
 */
function auditUnavailable(why: string): ApiError {
  return new ApiError('PROVIDER_UNAVAILABLE', `作业取消审计写入失败（已回滚，取消未生效）：${why}`, {
    retryable: false,
  });
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
  // 记录版本：`null` = 记录尚未创建（合法，见 `UNCREATED_RECORD_REVISION`）；
  // 其余必须是契约下限内的整数 —— 库里读出 `0` / `2.5` / 字符串一律 503，不折算、不夹到 1。
  const targetRevision = row.target_revision;
  if (
    targetRevision !== null &&
    (!Number.isInteger(targetRevision) || targetRevision < 1)
  ) {
    throw unavailable('作业目标记录 revision 非法');
  }
  return {
    id: row.id,
    revision: row.revision,
    kind: row.kind,
    target_ref: {
      type: row.kind,
      id: row.record_id,
      revision: targetRevision ?? UNCREATED_RECORD_REVISION,
    },
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
    for (const source of ALL_SOURCES) {
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

  /**
   * 在**取消事务内**写一行审计（`CANCEL_AUDIT_SQL`）。
   *
   * 任何一步不成立都抛 503：这条路径上「审计没写成」只可能是装配错、授权错或库错，
   * 三者都该让整体回滚（取消不生效），而不是提交一次没有审计的取消。
   */
  async function recordCancelAudit(
    client: PoolClient,
    audit: AdminJobCancelAuditInput | undefined,
    id: string,
    expectedRevision: number,
  ): Promise<void> {
    if (
      audit === undefined ||
      typeof audit.actorId !== 'string' ||
      !UUID_RE.test(audit.actorId) ||
      typeof audit.requestId !== 'string' ||
      !UUID_RE.test(audit.requestId) ||
      typeof audit.reasonCode !== 'string' ||
      audit.reasonCode === ''
    ) {
      throw auditUnavailable('取消审计入参缺失或不合法（actor / request / reason）');
    }
    let result: { rows: unknown[] };
    try {
      result = await client.query(CANCEL_AUDIT_SQL, [
        audit.actorId,
        id,
        expectedRevision,
        audit.reasonCode,
        audit.requestId,
      ]);
    } catch (error) {
      // 审计写不进去（函数抛 G 码 / 授权缺失 / 库错）⇒ 换成明确的"已回滚，取消未生效"。
      // 不这样折的话，外层 catch 会把它说成"作业存储不可用：取消失败"，读起来像冲突而不是审计问题。
      throw auditUnavailable((error as Error).message);
    }
    const row = (result.rows as Record<string, unknown>[])[0];
    if (row === undefined || typeof row.audit_event_id !== 'string' || !UUID_RE.test(row.audit_event_id)) {
      throw auditUnavailable('审计函数未回传审计行 id');
    }
  }

  return {
    wired: true,
    // 唯一 `persistent: true` 的实现：取消走真事务，审计行与状态变更同一 `COMMIT`。
    persistent: true,
    async list(filter: AdminJobFilter = {}): Promise<AdminJobView[]> {
      // 端口边界再判一次闭集：端口也会被直接调用（集成/单测），非法入参一律 400 INVALID_REQUEST，
      // 绝不静默返回空页。不过滤时 `where` 为空串、`values` 为空 ⇒ 语句与改动前逐字相同。
      const applied = parseAdminJobFilter(filter);
      const pages = await Promise.all(
        ALL_SOURCES.map(async (source) => {
          // WHERE 按**该源**的 `state` 真实类型拼（枚举源 `::job_state`、文本源 `::text`）。
          const { where, values } = listWhereFor(source, applied);
          const result = await pool.query(source.listSelect + where + source.listTail, [
            limit,
            ...values,
          ]);
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
      for (const source of ALL_SOURCES) {
        const result = await pool.query(source.getSql, [id]);
        const row = (result.rows as Record<string, unknown>[])[0];
        if (row !== undefined) return toAdminJobView(projectRow(source, row));
      }
      return null;
    },
    async cancel(
      id: string,
      expectedRevision: number,
      audit: AdminJobCancelAuditInput,
    ): Promise<CancelJobOutcome> {
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
        // **审计与状态变更同一事务**（监工 #589）：这一步失败 ⇒ 下面的 catch 整体 ROLLBACK，
        // 作业保持取消前的 state/revision，审计表零新增。绝不在 COMMIT 之后补写。
        await recordCancelAudit(client, audit, id, expectedRevision);
        // GY-R71：统一台账行与「域内取消 + 审计」**同一个事务**。缺列（只可能是装配/授权错）
        // ⇒ fail-closed 抛 503 并整体回滚，绝不写一条字段残缺的台账行（`answer` 源没有 media 列）。
        if (current.owner_user_id === null) {
          throw unavailable('取消事务未取到台账所需列（owner_user_id）');
        }
        // 两个映射函数的入参形状不同：轮次表用 `TurnJobLedgerInput`（`jobs/ledger.ts:123-134`），
        // 三张域表用 `DomainJobLedgerInput`。先把行对象算好，`writeJobLedger` 只留**一处**调用点
        // （`tests/unit/jobs-ledger-mapping.test.mjs` 把「本文件只有一处写点」钉成精确读数）。
        const ledgerRow = source.kind === 'answer'
          ? ledgerRowFromTurn({
              id: updated.record_id,
              revision: updated.revision,
              owner_id: current.owner_user_id,
              job_id: updated.id,
              job_state: updated.state,
              job_deadline_at: toDate(updated.deadline_at),
              job_created_at: toDate(updated.created_at),
              job_error_code: updated.error_code,
              answer_id: null,
              updated_at: toDate(updated.updated_at),
            })
          : domainLedgerRow(source.kind, current, updated);
        await writeJobLedger(client, ledgerRow);
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

/**
 * 第 4 个作业源：`public.conversation_turns`（问答轮次的作业三列 `job_id` / `job_state` / `job_*`）。
 *
 * 为什么**不调换 `SOURCES`**：把 answer 塞进 `SOURCES` 会挪动那三源声明块的行号，而 `docs/`
 * 按行号引本文件（`ai-ops-spec-status.md:104/126/212/219` 等）⇒ 用 `ALL_SOURCES` 追加。
 *
 * 为什么**不 JOIN `public.conversation_answers` 取记录 revision**：问答的 answer 行**不可修订**
 * （`conversations/store.ts:80` 的 revision 恒 1，`20-login-roles.sql:1127-1128` 也没有 UPDATE 授权），
 * 而 `admin/ops/service.ts:1073-1080` 会逐字段比对 `target_ref` ⇒ 多投影一个会变的
 * `target_revision`，取消一次就 `portIntegrityFailure` 503。所以本条**不投影**它，
 * `toAdminJobView` 退回 `UNCREATED_RECORD_REVISION = 1`（与三域「记录尚未创建」同一口径）。
 *
 * `job_id` 有唯一索引（`0013_conversations.sql:92`）⇒ `getSql` / `lockSql` 的 `WHERE j.job_id = $1::uuid`
 * 至多一行；`updateSql` 的 SET / `IN ('queued', 'running')` **逐字镜像** `conversations/store-pg.ts:413-416`
 * 的域内取消（`cancelTurnJob`），故两条路径写出的 `job_state` / `job_error_code` / `revision` 同形，
 * 且与 `settleTurnJob` 的抢占（`store-pg.ts:429-435`）天然互斥。
 */
const ANSWER_SOURCE: JobSource = {
  kind: 'answer',
  recordColumn: 'record_id',
  listSelect:
    'SELECT j.job_id AS id, j.revision, j.id AS record_id, j.job_state AS state, j.job_deadline_at AS deadline_at, j.job_created_at AS created_at, j.job_error_code AS error_code FROM public.conversation_turns j',
  listTail: ' ORDER BY j.job_created_at DESC, j.id DESC LIMIT $1::integer',
  // `conversation_turns.job_state` 是 varchar(20) + CHECK（0013:71-72），按文本比。
  stateCast: 'text',
  getSql:
    'SELECT j.job_id AS id, j.revision, j.id AS record_id, j.job_state AS state, j.job_deadline_at AS deadline_at, j.job_created_at AS created_at, j.job_error_code AS error_code FROM public.conversation_turns j WHERE j.job_id = $1::uuid',
  lockSql:
    'SELECT j.job_id AS id, j.revision, j.id AS record_id, j.owner_id AS owner_user_id, j.job_state AS state, j.job_deadline_at AS deadline_at, j.job_created_at AS created_at, j.job_error_code AS error_code, j.updated_at FROM public.conversation_turns j WHERE j.job_id = $1::uuid FOR UPDATE',
  updateSql:
    "UPDATE public.conversation_turns SET job_state = 'cancelled', job_error_code = NULL, revision = revision + 1, updated_at = now() WHERE job_id = $1::uuid AND revision = $2::integer AND job_state IN ('queued', 'running') RETURNING job_id AS id, revision, id AS record_id, job_state AS state, job_deadline_at AS deadline_at, job_created_at AS created_at, job_error_code AS error_code, updated_at",
};

/**
 * 读面 / 取消面的**全集**：三张域内作业表 + 问答轮次表。
 *
 * 顺序有意义：前三源在前 ⇒ 同一个 ID 命中多表时（理论上不可能，四张表的主键各不相干）
 * 仍按既有次序取第一条；`ADMIN_JOB_SQL` 的数组顺序也随之变成「三源 + answer」。
 */
const ALL_SOURCES: readonly JobSource[] = [...SOURCES, ANSWER_SOURCE];

/**
 * 列表过滤片段里的**列名**：`answer` 源的轮次表把两列写成 `job_state` / `job_error_code`
 * （`0013_conversations.sql:71-75`），其余三源就是 `state` / `error_code`。
 *
 * ⚠ 不能靠 `state AS state` 这类投影别名绕过：PG 的 `WHERE` 不认输出别名（会 42703
 * `column "state" does not exist`），所以列名必须在拼片段时就换对。
 */
function columnNameFor(source: JobSource, column: 'state' | 'error_code'): string {
  return source.kind === 'answer' ? `job_${column}` : column;
}

/**
 * 台账写入需要的两个 media 列（`target_id` / `entity_revision`）：只有三个域内源有，
 * `answer` 源的轮次表没有媒体列。缺列只可能是装配/授权错 ⇒ 抛 503 让取消整体回滚，
 * ⛔ 不写一条字段残缺的台账行。
 */
function requireMediaColumns(row: JobRow): { mediaId: string; mediaRevision: number } {
  if (row.media_id === null || row.media_revision === null) {
    throw unavailable('取消事务未取到台账所需列（media_id / media_revision）');
  }
  return { mediaId: row.media_id, mediaRevision: row.media_revision };
}

/**
 * 三张域内作业表的台账行：`DomainJobLedgerInput` 需要 `mediaId` / `mediaRevision`，而这两列
 * 只有那三张表有（`answer` 源的轮次表没有媒体列，见 `ANSWER_SOURCE`）。
 *
 * 缺列只可能是装配/授权错 ⇒ 抛 503 让取消整体回滚，⛔ 不写一条字段残缺的台账行。
 * 取消路径的 `:620` 已对四源统一要求 `owner_user_id` 非空，这里再兜一次类型窄化。
 */
function domainLedgerRow(
  source: Exclude<LedgerWiredSource, 'answer'>,
  current: JobRow,
  updated: JobRow,
) {
  const media = requireMediaColumns(current);
  if (current.owner_user_id === null) {
    throw unavailable('取消事务未取到台账所需列（owner_user_id）');
  }
  return ledgerRowFromDomainJob(
    source,
    {
      id: current.id,
      revision: updated.revision,
      kind: updated.kind,
      ownerUserId: current.owner_user_id,
      state: updated.state,
      deadlineAt: toDate(current.deadline_at),
      createdAt: toDate(current.created_at),
      updatedAt: toDate(updated.updated_at),
      errorCode: updated.error_code,
      mediaId: media.mediaId,
      mediaRevision: media.mediaRevision,
    },
    updated.record_id,
  );
}

/** 供真库臂与单测复用的语句导出（只读断言用；运行时不直接引用）。 */
export const ADMIN_JOB_SQL = {
  /** 无过滤时的列表语句（没有 `WHERE`；`target_revision` 由 `LEFT JOIN <记录表>` 取真实值）。 */
  list: ALL_SOURCES.map((source) => source.listSelect + source.listTail),
  /**
   * 列表过滤的 `WHERE` 片段，**逐源分开**（值永远走 `$2` / `$3` 绑定，不拼字符串）。
   * `state` 的 cast 随源不同：`ocr` / `answer` ⇒ `::text`；`recognition` / `transcription` ⇒ `::job_state`
   * （枚举列与 text 参数在 PG 里没有隐式转换，写成 `::text` 会 42883 ⇒ 500）。
   */
  listWhere: ALL_SOURCES.map((source) => listWhereExportFor(source)),
  get: ALL_SOURCES.map((source) => source.getSql),
  lock: ALL_SOURCES.map((source) => source.lockSql),
  update: ALL_SOURCES.map((source) => source.updateSql),
  /** 取消事务里的审计写入（迁移 0043 的函数调用；真库臂据此断言签名与表级零写入）。 */
  cancelAudit: CANCEL_AUDIT_SQL,
  limit: ADMIN_JOB_LIST_LIMIT,
} as const;
