/**
 * 统一作业台账 `public.jobs` 的**唯一写入点**（GY-R71 / N04）。
 *
 * ## 这张表在此之前是什么
 * 表由 `0001_initial_schema.sql:203` 建出（22 列，含 `jobs_single_actor` 约束），而截至基线
 * `8b646ae1` 全仓**没有一条语句级 `INSERT`**：`0013_conversations.sql:19` 把这句 grep 判据写进了
 * 迁移头注，`tests/unit/ai-ops-ledger-pins.test.mjs` 的钉子①把它钉成了结构事实。真实作业行只落在
 * 三张域内表（`ocr_jobs` / `recognition_jobs` / `speech_jobs`）与会话轮次的作业快照列上。
 *
 * ## 本文件做四件事
 * 1. **映射**：域内作业行 → 台账行（`ledgerRowFromDomainJob` / `ledgerRowFromTurn`）。纯函数，
 *    不碰数据库 ⇒ 六源 × 五态矩阵可以在单测里逐格断言（`tests/unit/jobs-ledger-mapping.test.mjs`）。
 * 2. **一条幂等语句**：{@link JOB_LEDGER_UPSERT_SQL}。表名/列名**写死**，不拼字符串（静态列审计
 *    `tests/unit/sql-column-coverage.test.mjs` 读的是源码字面量；拼出来的表名会被解析成噪声，
 *    进而把「该表未授任何列」判成真红 —— 与 `admin/ops/jobs-pg.ts:166-172` 同一条纪律）。
 * 3. **写入**：{@link writeJobLedger}。调用方**必须**在**已开启的事务**里、**紧随域内表那一笔写之后**
 *    调用它（本文件不自己 `BEGIN`：台账行与源表行要么一起提交、要么一起回滚）。
 * 4. **注销清理**：{@link JOB_LEDGER_PURGE_SQL} / {@link purgeJobLedgerByOwner}（GY-R71 补片）。
 *    台账行携带 `owner_id` / `target_id` / `result_ref` 等私有作业关联，因此**必须**在注销闭集里
 *    被按主体删掉 —— 「今天没有读者」不是保留依据，见该常量的注释。
 *
 * ## 幂等：选 `ON CONFLICT (id)` + 同态守卫（不是"状态机守卫"）
 * 台账主键就是**作业 id**（域内三表的 `id`、会话轮次的 `job_id`），所以「同一 job_id 的重复迁移
 * 不产生重复行」由 `ON CONFLICT (id) DO UPDATE` 直接成立 —— 重复受理 / 重试 / 迟到结果都只落到
 * 同一行。另加 `WHERE public.jobs.state IS DISTINCT FROM EXCLUDED.state`：**同态重放是严格 no-op**
 * （不刷 `updated_at`、不改 `revision`），这样台账的 `revision` 数的是**真实状态迁移**，不是写次数。
 * ⛔ 刻意**不**用「先 SELECT 再决定 INSERT/UPDATE」：那需要两次往返，且在并发下要额外的行锁；
 * `ON CONFLICT` 一条语句就够，锁语义由唯一索引给。
 *
 * ## 列映射的口径（哪些是真值、哪些是派生值 —— 一并写清，不留给读者猜）
 * | 台账列 | 来源 | 真值/派生 |
 * |---|---|---|
 * | `id` | 域内作业行 `id`（answer 取轮次的 `job_id`） | 真值 |
 * | `owner_id` | `owner_user_id` / `owner_id` | 真值 |
 * | `actor_admin_id` | 恒 `NULL`（六源全是用户作业） | 常量（满足 `jobs_single_actor`：owner 与 admin 恰一） |
 * | `kind` | 该源在契约 `JobKind` 闭集里的取值 | 常量（**与域内表 CHECK 同值**：`ocr_jobs.kind` 只允许 `'ocr'` 等） |
 * | `target_type` / `target_id` / `entity_revision` | 作业的**输入对象**：媒体域三源取 `media_id` / `media_revision`；answer 取轮次 `id` / `revision` | 真值 |
 * | `input_hash` | {@link ledgerInputHash}：对「输入身份」四元组取 sha256 | **派生**（⛔ 不是输入字节的哈希：全仓没有 `input_hash` 的任何来源，`git grep input_hash services/api/src` 在基线为空） |
 * | `auth_epoch` | `(SELECT users.auth_epoch …)`，与台账行**同一条语句**读 | 真值（不传参、不写哨兵值） |
 * | `state` / `revision` / `deadline_at` / `created_at` / `updated_at` / `error_code` | 域内行同名事实 | 真值 |
 * | `result_ref` | 域内**创建时即预分配**的产出行 id（`ocr_id` / `recognition_id` / `transcription_id`；answer 取 `answer_id`） | 真值（三域 DDL 里这三列都是 `NOT NULL`，所以第一笔写入就是真实 id，不是占位） |
 * | `consent_epoch` / `attempt` / `lease_token` / `lease_expires_at` / `retry_of` / `provider_config_version` | 不写（走 0001 的默认值 / `NULL`） | 如实留空：域内没有这些事实 |
 *
 * ## 边界（如实）
 * - **只写不读**：本片不改任何既有读面。`/admin/jobs` 仍读三张域内表（`admin/ops/jobs-pg.ts:4-9`），
 *   `GET /jobs/{id}` 仍走 `jobs/registry.ts` 与各域 `JobSourcePort` —— 台账今天**没有读者**，
 *   写它不会改变任何一个响应字段。（**没有读者 ≠ 可以不删**：注销清理见 {@link JOB_LEDGER_PURGE_SQL}。）
 * - **两源未接**：`moderation` / `synthesis` 没有可落库的作业行（见 {@link UNWIRED_SOURCES_REASON}）。
 */
import { createHash } from 'node:crypto';

/**
 * 契约 `JobState` 七值闭集，**逐值抄写**（不是从别处 import 来的）。
 *
 * 为什么抄：`jobs/registry.ts:38` 有同一份闭集，但那是**读面**模块，它 import 了域服务类型；
 * 台账写入点被三个域的 `store-pg.ts` 引用，从读面反向往回 import 会形成
 * `ocr/store-pg → jobs/ledger → jobs/registry → ocr/…` 的模块环。抄一份 + 单测钉住
 * 「本文件闭集 === registry 的 JOB_STATES === 契约 enum」比引入环更划算
 * （`admin/ops/jobs-pg.ts:59-69` 的 `CONTRACT_JOB_STATES` 是同一取舍的先例）。
 */
const LEDGER_JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'uncertain',
  'failed',
  'timed_out',
  'cancelled',
] as const;
export type JobState = (typeof LEDGER_JOB_STATES)[number];

/**
 * 已接入台账的作业源（键＝域内事实，值＝契约 `JobKind`）。
 *
 * ⚠ 键取域内表/服务的真实名字：`transcription` 是语音转写域在契约里的 kind（域目录叫 `speech`），
 * 两者**不是**同一个字符串，写错会让台账 `kind` 与 `/admin/jobs` 的 `kind` 对不上。
 */
export const LEDGER_WIRED_SOURCES = ['ocr', 'recognition', 'transcription', 'answer'] as const;
export type LedgerWiredSource = (typeof LEDGER_WIRED_SOURCES)[number];

/** 每个源的**固定**台账列（`kind` 与 `target_type` 都是域事实，不是调用方可选项）。 */
const SOURCE_FACTS: Readonly<Record<LedgerWiredSource, { kind: string; targetType: string }>> = Object.freeze({
  ocr: { kind: 'ocr', targetType: 'media' },
  recognition: { kind: 'recognition', targetType: 'media' },
  transcription: { kind: 'transcription', targetType: 'media' },
  answer: { kind: 'answer', targetType: 'conversation_turn' },
});

/**
 * **未接入**台账的两个源，以及为什么接不进来（⛔ 不是"没来得及"，是结构上没有可同事务的源行）。
 *
 * - `moderation`：审核作业的 `queued` / `running` 只活在进程内（`moderation/service.ts` 的作业态），
 *   落库的只有 `moderation_decisions` / `moderation_withdrawals` —— 那是**决定**，不是作业行，
 *   且写在判定完成之后。若只为终态补一行台账，台账会声称一段**从未落库**的状态史（`queued` 行
 *   永远不会出现），比不写更坏。
 * - `synthesis`：合成域**没有任何**持久化作业表（全仓迁移里 `synthesis` 只出现在导出键形状与收藏
 *   历史的 `target_type` 取值里），作业态同样只在内存。单事务内无源可写。
 *
 * 结论：这两源要靠「先给它们落一张域内作业表」的独立片才有接入点；本片如实登记，不用
 * 「尽力而为」的终态补写把缺口糊过去。
 */
export const UNWIRED_SOURCES_REASON: Readonly<Record<'moderation' | 'synthesis', string>> = Object.freeze({
  moderation: '审核作业只有进程内作业态；落库的是决定行（moderation_decisions），不是作业行 —— 无同事务可写的源行',
  synthesis: '合成域没有持久化作业表（迁移里无 synthesis_jobs）；作业态只在内存 —— 无同事务可写的源行',
});

/** 域内三源作业行的最小公共形状（`ocr_jobs` / `recognition_jobs` / `speech_jobs` 的列集交集）。 */
export interface DomainJobLedgerInput {
  readonly id: string;
  readonly revision: number;
  readonly kind: string;
  readonly ownerUserId: string;
  readonly state: string;
  readonly deadlineAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly errorCode: string | null;
  readonly mediaId: string;
  readonly mediaRevision: number;
}

/** 会话轮次行里与作业有关的那几列（`conversation_turns` 的快照列）。 */
export interface TurnJobLedgerInput {
  readonly id: string;
  readonly revision: number;
  readonly owner_id: string;
  readonly job_id: string;
  readonly job_state: string;
  readonly job_deadline_at: Date;
  readonly job_created_at: Date;
  readonly job_error_code: string | null;
  readonly answer_id: string | null;
  readonly updated_at: Date;
}

/** 台账行（列名对齐 `0001_initial_schema.sql:193-217`，这里是驼峰形态）。 */
export interface JobLedgerRow {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly entityRevision: number;
  readonly inputHash: string;
  readonly state: JobState;
  readonly revision: number;
  readonly deadlineAt: Date;
  readonly errorCode: string | null;
  readonly resultRef: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * 台账 `input_hash`（`char(64)`）的派生口径。
 *
 * 四元组 = `kind` / `target_type` / `target_id` / `entity_revision`，用 `\n` 分隔后取 sha256 十六进制。
 * 于是「同一个输入对象的同一类作业」得到同一个摘要，重试/重复受理不会换摘要；换输入对象或换输入
 * 版本则必然换摘要。⚠ 它**不是**输入字节的哈希 —— 全仓没有那个东西的来源，把派生值说成"输入哈希"
 * 已经够可疑，再让它不透明就更糟，所以口径写在这里、也被单测钉住（`input_hash` 长度 64、同输入同值、
 * 换版本换值）。
 */
export function ledgerInputHash(input: {
  kind: string;
  targetType: string;
  targetId: string;
  entityRevision: number;
}): string {
  const canonical = [input.kind, input.targetType, input.targetId, String(input.entityRevision)].join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** 契约 `JobState` 闭集判定（⛔ 不静默接受陌生状态：写进枚举列只会抛 22P02，不如在这里就失败）。 */
export function assertJobState(value: string): JobState {
  if (!(LEDGER_JOB_STATES as readonly string[]).includes(value)) {
    throw new Error(`台账 state 不在契约 JobState 闭集内：${value}`);
  }
  return value as JobState;
}

/** 源 → 该源固定列（未知源直接抛：⛔ 不猜 kind）。 */
function factsOf(source: LedgerWiredSource): { kind: string; targetType: string } {
  const facts = SOURCE_FACTS[source];
  if (facts === undefined) throw new Error(`台账不认识的作业源：${String(source)}`);
  return facts;
}

/**
 * 域内三源作业行 → 台账行。
 *
 * `resultRef` 单独传（不放进 `job`）：三域的产出行列名不同（`ocr_id` / `recognition_id` /
 * `transcription_id`），而它们在台账里都落到 `result_ref`。调用点因此写成
 * `ledgerRowFromDomainJob('ocr', row, row.ocrId)`，列名差异留在调用点、映射规则留在这里。
 */
export function ledgerRowFromDomainJob(
  source: Exclude<LedgerWiredSource, 'answer'>,
  job: DomainJobLedgerInput,
  resultRef: string | null,
): JobLedgerRow {
  const facts = factsOf(source);
  // 域内 `kind` 是 CHECK 约束列（`ocr_jobs.kind = 'ocr'` 等）；与源不符说明调用点接错了域。
  if (job.kind !== facts.kind) {
    throw new Error(`台账 kind 与作业源不符：源 ${source} 期望 ${facts.kind}，实际 ${job.kind}`);
  }
  return {
    id: job.id,
    ownerId: job.ownerUserId,
    kind: facts.kind,
    targetType: facts.targetType,
    targetId: job.mediaId,
    entityRevision: job.mediaRevision,
    inputHash: ledgerInputHash({
      kind: facts.kind,
      targetType: facts.targetType,
      targetId: job.mediaId,
      entityRevision: job.mediaRevision,
    }),
    state: assertJobState(job.state),
    revision: job.revision,
    deadlineAt: job.deadlineAt,
    errorCode: job.errorCode,
    resultRef,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/**
 * 会话轮次行 → 台账行（`kind: 'answer'`）。
 *
 * 三个 id 各就各位，别混：台账主键是**作业 id**（`turn.job_id`，也就是 `GET /jobs/{id}` 认的那个），
 * 目标对象是**轮次**（`turn.id`），产出是**回答**（`turn.answer_id`，未产出时为 `null`）。
 */
export function ledgerRowFromTurn(turn: TurnJobLedgerInput): JobLedgerRow {
  const facts = factsOf('answer');
  return {
    id: turn.job_id,
    ownerId: turn.owner_id,
    kind: facts.kind,
    targetType: facts.targetType,
    targetId: turn.id,
    entityRevision: turn.revision,
    inputHash: ledgerInputHash({
      kind: facts.kind,
      targetType: facts.targetType,
      targetId: turn.id,
      entityRevision: turn.revision,
    }),
    state: assertJobState(turn.job_state),
    revision: turn.revision,
    deadlineAt: turn.job_deadline_at,
    errorCode: turn.job_error_code,
    resultRef: turn.answer_id,
    createdAt: turn.job_created_at,
    updatedAt: turn.updated_at,
  };
}

/**
 * 台账行的**唯一**写入语句。
 *
 * 15 列显式列出（⛔ 不用 `INSERT … VALUES` 省略列名：台账列多，省略会让"哪一列没写"不可见）；
 * `auth_epoch` 用同一条语句里的子查询取 `users` 的真值（见文件头「列映射」）；其余走默认值。
 *
 * `ON CONFLICT (id) DO UPDATE` 只改**会随状态迁移变**的五列；`kind` / `target_*` / `input_hash` /
 * `created_at` 是作业的身份，冲突时**不动**（它们与主键一一对应，改了就是把两笔作业的历史混在一起）。
 */
export const JOB_LEDGER_UPSERT_SQL =
  `INSERT INTO public.jobs
     (id, owner_id, kind, target_type, target_id, entity_revision, input_hash,
      auth_epoch, state, revision, deadline_at, error_code, result_ref, created_at, updated_at)
   VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::integer, $7,
           (SELECT u.auth_epoch FROM public.users AS u WHERE u.id = $2::uuid),
           $8::job_state, $9::integer, $10::timestamptz, $11, $12::uuid, $13::timestamptz, $14::timestamptz)
   ON CONFLICT (id) DO UPDATE
      SET state = EXCLUDED.state,
          revision = EXCLUDED.revision,
          error_code = EXCLUDED.error_code,
          result_ref = EXCLUDED.result_ref,
          updated_at = EXCLUDED.updated_at
    WHERE jobs.state IS DISTINCT FROM EXCLUDED.state`;

/**
 * 台账行的绑定值（顺序 = {@link JOB_LEDGER_UPSERT_SQL} 的 `$1..$14`）。
 *
 * ⚠ `$2`（owner）被语句用了两次（`owner_id` 与 `auth_epoch` 子查询），所以这里只出现一次。
 * 未接入两源（`moderation` / `synthesis`）没有映射，也就没有绑定值 —— 类型上就取不到。
 */
export function ledgerParams(row: JobLedgerRow): unknown[] {
  return [
    row.id,
    row.ownerId,
    row.kind,
    row.targetType,
    row.targetId,
    row.entityRevision,
    row.inputHash,
    row.state,
    row.revision,
    row.deadlineAt,
    row.errorCode,
    row.resultRef,
    row.createdAt,
    row.updatedAt,
  ];
}

/**
 * **统一入口**（给矩阵单测与"未来新增源"用的单一取行口）：
 * 已接源 → 台账行；未接源（`moderation` / `synthesis`）→ `null`（⛔ 不抛错、更不造一行假数据）；
 * 陌生源 → 抛错（⛔ 不静默返回 `null`：那会让"拼错源名"看起来像"这个源本来就没接"）。
 *
 * 为什么需要它：六源 × 五态的矩阵断言要能**逐格**问"这一格有没有台账行、行里是什么"，
 * 而不是让测试自己 `switch` 一遍源 —— 那种 switch 会与生产代码各写一份映射，漂移了也测不出来。
 */
export function ledgerRowForSource(
  source: string,
  input: { job?: DomainJobLedgerInput; resultRef?: string | null; turn?: TurnJobLedgerInput } = {},
): JobLedgerRow | null {
  if (source === 'answer') {
    if (input.turn === undefined) throw new Error('台账映射缺 turn 输入：answer 源的台账行只能由轮次行构造');
    return ledgerRowFromTurn(input.turn);
  }
  if (source === 'ocr' || source === 'recognition' || source === 'transcription') {
    if (input.job === undefined) throw new Error(`台账映射缺 job 输入：${source}`);
    return ledgerRowFromDomainJob(source, input.job, input.resultRef ?? null);
  }
  if (Object.hasOwn(UNWIRED_SOURCES_REASON, source)) return null;
  throw new Error(`台账不认识这个作业源：${source}`);
}

/** 台账行 → 一行可读文本（单测/证据页引用用；⛔ 不进任何响应）。 */
export function describeLedgerRow(row: JobLedgerRow): string {
  return [
    `id=${row.id}`,
    `kind=${row.kind}`,
    `state=${row.state}`,
    `revision=${row.revision}`,
    `target=${row.targetType}:${row.targetId}@${row.entityRevision}`,
    `result_ref=${row.resultRef ?? 'null'}`,
    `error_code=${row.errorCode ?? 'null'}`,
  ].join(' ');
}

/** 事务执行器的最小形状（`PoolClient` / `SqlRunner` 都满足）。 */
export interface LedgerSqlRunner {
  /** `rowCount` 只有 `pg` 的 `Pool` / `PoolClient` 给；缺它时回退数 `RETURNING` 的行。 */
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

/**
 * 写台账行。**必须已被一个事务包着**，且在域内表那一笔写之后调用。
 *
 * 为什么把「事务」责任交给调用方而不是在这里 `BEGIN`：域内那一笔（`INSERT INTO ocr_jobs` /
 * `UPDATE conversation_turns` …）是**调用方**的事务内容，若本函数自己开一个事务，"台账 + 源表"
 * 就变成两个提交点 —— 那正是本片要消灭的不一致。调用点因此一律：
 *   ① 域内写 → ② `writeJobLedger(sql, row)` → ③ 同一个 `COMMIT`。
 */
export async function writeJobLedger(sql: LedgerSqlRunner, row: JobLedgerRow): Promise<void> {
  await sql.query(JOB_LEDGER_UPSERT_SQL, ledgerParams(row));
}

/**
 * 台账行的**唯一**删除语句（账号注销清理，GY-R71 / 监工 B 档实质阻塞）。
 *
 * ## 为什么必须有这一条
 * 本文件写进 `public.jobs` 的列里有 `owner_id` / `target_id`（媒体或轮次） / `result_ref`
 * （产出 id）与 `auth_epoch` —— 这些**全都是私有作业关联**。源域表（`ocr_jobs` / `recognition_jobs` /
 * `speech_jobs` / `conversation_turns` 的快照列）在注销时被各域处理器清掉，若台账行留着，
 * 用户的作业身份、媒体关联与产出指针就仍在库里，而「注销闭集」看不见它：
 * 「台账今天没有读者」**不是**保留依据（无读者只说明没人看，不说明没人能看）。
 *
 * ## 口径（为什么是这三条）
 * 1. **只按 `owner_id` 收窄**，一条语句删完该主体的全部作业行（四个源：ocr / recognition /
 *    transcription / answer 全在 `public.jobs` 里）。为什么不再按 `kind` 分四刀：四个源的处理器
 *    各自开自己的事务（识别/语音域的清理走 0034 的 `SECURITY DEFINER` 函数，无法与表级 DML 同事务），
 *    没有「一个跨域事务」可挂；按 `kind` 分刀只会让「哪个域的清理由谁负责」变成四份判断，
 *    而漏掉一份就等于静默留下该主体的行。因此**一个模块、一条语句、全部 kind**。
 * 2. **不用 `RETURNING *`**：注销证据只需要行数，把整行再读出来（含 `target_id` / `result_ref`）
 *    没有用处，徒增一段「删了什么」的日志面。行数取 `rowCount`（`pg` 给真实值），
 *    拿不到就抛错 —— ⛔ 不把「不知道删了几行」报成 0（那会让 blocked 变成 completed）。
 * 3. **幂等**：同一主体重复调用第二次删 0 行，不报错（注销重放/重试的既有口径）。
 *
 * 主体为空 ⇒ 抛错（⛔ 绝不让空主体退化成「删全部」）。这一条与 `media/store.ts::purgeOwnedMedia`
 * 的边界同向。
 */
export const JOB_LEDGER_PURGE_SQL = 'DELETE FROM public.jobs WHERE owner_id = $1::uuid';

/**
 * 按主体清空台账行，返回**真实删除行数**（供在线清除证据 `jobs:online-purged:<n>`）。
 *
 * 调用方必须已在真库路径上（表级 `DELETE` 面见 `deploy/postgres-cvm/sql/20-login-roles.sql`
 * 的 `gy-r71-jobs-ledger-grant` 段）；缺权（42501）、连接失败、行数不可读一律抛错，
 * 由删除协议折叠成 `blocked` + `HANDLER_FAILED` —— ⛔ 不折成 `completed`，也不折成 0 行。
 */
export async function purgeJobLedgerByOwner(sql: LedgerSqlRunner, ownerId: string): Promise<number> {
  if (typeof ownerId !== 'string' || ownerId.trim() === '') {
    throw new Error('台账清理缺少主体：拒绝清空全部作业行');
  }
  const result = await sql.query(JOB_LEDGER_PURGE_SQL, [ownerId]);
  // `pg` 的 `Pool` / `PoolClient` 一定给 `rowCount`；没有它（假池、或换了 runner）时才回退数 `RETURNING` 行。
  // ⚠️ 两者都拿不到 ⇒ 抛错：空数组**不能**当作「删了 0 行」的证据 —— 那是「不知道」，而「不知道」
  // 一旦被写成 0，回执就会把 blocked 显示成完成。
  const reported = typeof result.rowCount === 'number' ? result.rowCount : null;
  const fallback = Array.isArray(result.rows) && result.rows.length > 0 ? result.rows.length : null;
  const removed = reported ?? fallback;
  if (removed === null || !Number.isSafeInteger(removed) || removed < 0) {
    throw new Error('台账清理拿不到真实删除行数：拒绝把「不知道」报成 0');
  }
  return removed;
}
