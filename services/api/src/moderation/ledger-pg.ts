/**
 * 审核判定台账的 **PostgreSQL 持久实现**（迁移 `0028_moderation_persistence.sql`）。
 *
 * 在此之前 `services/api/src/moderation/decisions.ts` 只有内存实现（`createModerationLedger()`）：
 * 进程重启后审核结论全丢，而社区读面遇到"查不到结论"走的是**宽松**分支
 * （`community/service.ts:419` 的 `present !== true ⇒ null`）——于是已公开内容在重启后继续公开，
 * 且再也答不出它当初是哪一版规则/哪个模型判的。本模块把它接到真库上。
 *
 * ## 为什么是"内存承接读 + 写穿透落库"，而不是把接口改成异步
 * 台账接口（`ModerationLedger`）**全同步**：社区读链 `effectiveState`
 * （`community/service.ts:462-495`）与 `isPubliclyVisible`（:498-501）都是同步函数，
 * `publish` 里的 `ledger.isWithdrawn` / `ledger.current` 也是同步调用。把 `tasks()/current()`
 * 改成 `Promise` 会把整条读链撕成异步（并顺带改掉社区契约的调用形状）。
 * 因此持久实现只在**写入**侧穿透：先走内层内存台账（保留"重复 job_id 抛错 / 未知 job_id 抛错"
 * 这些同步语义），再入队落库动作（建行 = 退位 + 插入两条语句，真池上包在一个事务里）；写入的
 * 落定由 `flush()` 显式等待，调用方在 `moderation/service.ts` 的四个写入点 `await ledger.flush?.()`。
 *
 * ## 写面 fail-closed（本模块的唯一正确用法）
 * `flush()` 拒绝 ⇒ 审核服务**不得**把公开可见性翻成 `published`（`service.ts` 把 flush 放在
 * `authority.setVisibility(target, 'published')` 之前）。real 模式下审核域整体 fail-closed
 * （`service.ts:398-402` → `createFailClosedModerationService()`），因此**即便本表在场**，
 * real 模式也不会因为"有地方落库了"就伪造成功封套——本模块不改变那条边界。
 *
 * ## 失败**不得**被"空队列"洗白（#434 监工 P1）
 * 写入意图进一条**顺序日志**：成功落定才从前缀摘掉，失败项留在日志里。`flush()` 只有在
 * 日志清空时才算落定；日志非空 ⇒ **先重放**（四条语句幂等），重放仍失败 ⇒ 继续抛错。
 * 于是"第一次 INSERT 失败 → 内存 approved 残留 → 第二次 flush 空队列成功 → 目标被发布"
 * 这条路径不再存在：失败过的建行不会被当成已落库，`isDurable()` 也不会承认它。
 * 重放成功（存储恢复）后日志自然清空 ⇒ 调用方可以正常继续（不永久毒化台账）。
 *
 * ## 重放必须按"谁是现任任务"收敛（#434 监工 P2）
 * 同一目标同内容类别的 A、B 两条建行（B 在内存里接任 A）在 A 落库失败后重放时，**不得**：
 *   ① 把已 confirmed 的后项 B 也重放一遍（它跑一次退位就会把 B 自己退位）；
 *   ② 重放旧任务 A 时照旧跑退位语句（会把现任的 B 退位）。
 * 因此：重放只针对**未 confirmed** 的日志项；每笔建行在**执行时**判自己是否仍是现任任务，
 * 旧任务按历史行（`superseded = TRUE`）插入且**不**退位任何人；退位语句自身也排除本 `job_id`
 * （`job_id <> $6`）。建行走 `ON CONFLICT (job_id) DO NOTHING`（命中已有行时什么也没写），
 * 所以写完**必须读回** `superseded` 确认状态与意图一致，不一致就抛错（flush 继续拒绝）。
 *
 * ## 更新也必须按"实际行变更"确认（#434 复审 §6）
 * `UPDATE … WHERE job_id = $1` 命中 0 行时 PostgreSQL **不报错**：目标行不存在（这条建行还没落过库）
 * 或已被并发改动时都如此。若把"没抛错"当成落库，这条更新会被记成 confirmed，而重放只取未
 * confirmed 的项 ⇒ 它**永远不会再被重试**：库停在建行快照（`state`/`decision` 是旧值），内存已推进
 * 到回调结论，`isDurable()` 却仍答 `true`。因此更新语句带 `RETURNING job_id`，按**实际返回行数**
 * 判定：不是恰好 1 行 ⇒ 抛错（`flush()` 折成既有 `PROVIDER_UNAVAILABLE`），失败项留在日志里等
 * 下一次重放把这一行补上。
 *
 * ## 下架集合**回填**，任务结论仍不回填（W43）
 * 存量**任务行**"当初有没有结论"在库层面也不可区分（决策：只读面用 `present=false ⇒ unknown` 表达，
 * 不改社区契约）。因此 `byJobId/current/forRevision/history` **仍只答内存里的本次进程结论**，
 * 跨进程追溯走审计查询（直接查表）。
 *
 * 但**下架标记不是同一类事实**：它是**终态**、只增不减，而且是"旧回调不得复活已下架版本"这条闸门的
 * **唯一判据**（`service.ts` 的发布前 `TARGET_WITHDRAWN` 与回调闸门 `CALLBACK_TARGET_WITHDRAWN` 都只问
 * `isWithdrawn`）。进程重启后若它失忆，一条迟到的旧回调就能把已下架的版本重新翻成 `published`——
 * 这正是本模块此前"只写不读"留下的口子。所以下架行必须在启动后读回来：`hydrate()` 只读三列
 * （`target_type/target_id/target_revision`，`20-login-roles.sql` 已授权）逐行
 * `inner.markWithdrawn(...)`，**只动内存、不回写库**（这些行本来就在库里，再写一遍只会白挨一次
 * `ON CONFLICT DO NOTHING` 与一条写面失败风险）。
 *
 * 回填是**惰性**的（第一次 `flush()`/`hydrate()` 才打库，构造不做 I/O），失败会重试一次、仍失败则
 * `flush()` 拒绝。`isWithdrawn` 保持同步签名（读面不许变异步，理由见上一节）：回填成功前它只按内存答，
 * 调用方必须把"回填未就绪"当成"不许发布"——`flush()` 已经替它把关。
 */
import { ApiError } from '../errors.ts';
import { createModerationLedger, type ModerationLedger } from './decisions.ts';
import type { ModerationTaskRecord, TargetRef } from './types.ts';

/** `pg` 连接池的最小形状（与 `db/pool.ts` 的 `PgPool` 结构兼容；测试可传记录型假池）。 */
export interface SqlRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** 能开事务的池（`pg.Pool` 有 `connect`；测试假池可以只实现 `query`）。 */
export interface SqlTransactor {
  connect(): Promise<{
    query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
    release(): void;
  }>;
}

function isTransactor(pool: SqlRunner): pool is SqlRunner & SqlTransactor {
  return typeof (pool as Partial<SqlTransactor>).connect === 'function';
}

/** 持久台账：在同步台账之上多出 `flush()` 与不可伪装的 `persistent` 标记。 */
export interface PostgresModerationLedger extends ModerationLedger {
  /** 等待已入队写入落定；只要还有**未确认落库**的写入（含上一次失败留下的）就抛出。 */
  flush(): Promise<void>;
  /**
   * 该记录是否**已确认落库**：建行成功过、且名下没有未确认的写入。
   *
   * 发布路径必须用它：内存里"看起来 approved"不等于账本里 approved。返回 `false` 的记录
   * 不得被当成"已持久化／已批准"用于翻公开可见性（#434 监工 P1）。
   */
  isDurable(record: ModerationTaskRecord): boolean;
  /**
   * 把库里已有的**下架行**回填进内存台账（跨进程读回；只读三列、只动内存、不回写）。
   *
   * 惰性：不在构造里打库，第一次调用（或第一次 `flush()`）才执行；上次失败会**重试一次**，
   * 仍失败就抛错。`flush()` 每次都先走它，所以"回填没做成"绝不会被当成"这些版本没下架"。
   */
  hydrate(): Promise<void>;
  /** 下架集合是否**已从库里回填成功**（未开始／上次失败 ⇒ `false`）。 */
  readonly withdrawalsHydrated: boolean;
  readonly persistent: true;
}

/**
 * 一个"待落定写入"的登记项：`run` 是**幂等**的落库动作（建行 `ON CONFLICT (job_id) DO NOTHING`、
 * 退位/更新按主键覆盖、下架 `ON CONFLICT (...) DO NOTHING`），因此失败后**重放安全**。
 */
interface WriteIntent {
  /** 归属任务（下架标记没有 `job_id`）。 */
  job_id: string | null;
  /** 是否是建行：只有建行落定过，该 `job_id` 才算"库里有行"。 */
  creates: boolean;
  run: () => Promise<void>;
  confirmed: boolean;
  /** 是否已经被某次 `flush()` 报给调用方。用于区分"本次调用刚失败"与"上一次调用失败留下的"。 */
  reported: boolean;
}

/**
 * 建行前的"退位"语句：把同一目标版本上仍现任的行置 `superseded`。
 *
 * **必须是独立语句**：数据修改型 CTE 里的 `UPDATE` 对同一条语句的 `INSERT` **不可见**
 * （两者共享同一快照），部分唯一索引 `moderation_decisions_current_key`
 * （`WHERE superseded = FALSE`）仍会看到旧行 ⇒ 真库上报
 * `duplicate key value violates unique constraint "moderation_decisions_current_key"`。
 * 因此退位与插入拆成两条语句，并在真池上用显式事务保证原子（见 `create`）。
 */
const SUPERSEDE_SQL = `UPDATE public.moderation_decisions
   SET superseded = TRUE, updated_at = $5::timestamptz
 WHERE target_type = $1 AND target_id = $2 AND target_revision = $3
   AND content_kind = $4 AND superseded = FALSE AND job_id <> $6`;

/**
 * 建行语句：幂等由数据库给（`ON CONFLICT (job_id) DO NOTHING`），不靠"先查后写"。
 */
const INSERT_SQL = `INSERT INTO public.moderation_decisions (
  job_id, target_type, target_id, target_revision, content_kind, port_kind, prompt_id,
  job_revision, state, lease_token, authorization_epoch, submitted_by, deadline_at,
  decision, reason_codes, hard_rule_passed, rule_version, model_version, prompt_version,
  contract_value, gate_holder, error_code, evidence, superseded, created_at, updated_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
  $14, $15::jsonb, $16, $17, $18, $19, $20::jsonb, $21::jsonb, $22, $23::jsonb, $24, $25::timestamptz, $26::timestamptz
)
ON CONFLICT (job_id) DO NOTHING`;

/**
 * 更新语句：只动**可变列**（状态推进/回调落定）。目标身份列（`target_*`、`content_kind`、
 * `job_revision`、`created_at`）一律不可变——审核任务的"审的是哪一版"不许被后续写入改写。
 *
 * 命中行数由 `RETURNING job_id` 的返回行数判（`confirmUpdatedRow`）：真库上 `WHERE job_id = $1`
 * 匹配 0 行时**不报错**，所以这条语句的"落库确认"不能靠"没抛错"。
 */
const UPDATE_SQL = `UPDATE public.moderation_decisions SET
  state = $2, lease_token = $3, decision = $4, reason_codes = $5::jsonb, hard_rule_passed = $6,
  rule_version = $7, model_version = $8, prompt_version = $9, contract_value = $10::jsonb,
  gate_holder = $11::jsonb, error_code = $12, evidence = $13::jsonb, superseded = $14,
  updated_at = $15::timestamptz
WHERE job_id = $1
RETURNING job_id`;

/**
 * 建行之后的**读回**：`ON CONFLICT (job_id) DO NOTHING` 命中已有行时什么也没写，
 * 因此"语句没报错"**不等于**"这行的状态就是我们要的"。只能读回来判（监工 P2）。
 *
 * 只读 `superseded` 一列（已在 `20-login-roles.sql` 的列级 SELECT 授权清单内）。
 */
const READ_SUPERSEDED_SQL = `SELECT superseded FROM public.moderation_decisions WHERE job_id = $1`;

/** 下架标记：同一 `(target_type,target_id,target_revision)` 只留一行（下架是终态、可重放）。 */
const WITHDRAW_SQL = `INSERT INTO public.moderation_withdrawals (
  target_type, target_id, target_revision, withdrawn_at
) VALUES ($1, $2, $3, $4::timestamptz)
ON CONFLICT (target_type, target_id, target_revision) DO NOTHING`;

/**
 * 下架集合的**回填**读（`WITHDRAW_SQL` 的另一半：写进去的行必须在重启后读回来）。
 *
 * 只读三列主键 `target_type/target_id/target_revision` —— 正是 `deploy/postgres-cvm/sql/20-login-roles.sql`
 * 里 `GRANT SELECT (target_type,target_id,target_revision) ON public.moderation_withdrawals` 授的三列。
 * **不得**写成 `SELECT *`：`withdrawn_by`/`withdrawn_at` 未对运行时角色授权（会 42501），
 * 且回填只需要"哪些版本下架过"，不需要"谁在什么时候"（那是审计查询的事）。
 */
const HYDRATE_WITHDRAWALS_SQL = `SELECT target_type, target_id, target_revision
  FROM public.moderation_withdrawals`;

/** 数据库异常 ⇒ 领域错误（与 `messages/store-pg.ts` 同口径：超时/锁不可得 ⇒ `PROVIDER_TIMEOUT`）。 */
function ledgerFailure(error: unknown, action: string): ApiError {
  if (error instanceof ApiError) return error;
  const record = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown };
  const code = record.code;
  const detail = typeof record.message === 'string'
    ? (record.message.split('\n')[0] ?? '').slice(0, 200)
    : '未知数据库错误';
  if (code === '57014' || code === '55P03') {
    return new ApiError('PROVIDER_TIMEOUT', `审核台账${action}超时：结论未落定，按未落库处理（${detail}）`);
  }
  return new ApiError('PROVIDER_UNAVAILABLE', `审核台账${action}失败：结论未落定，按未落库处理（${detail}）`);
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/**
 * `UPDATE … WHERE job_id = $1 RETURNING job_id` 的**落库确认**（#434 复审 §6：`update` 写面没有落库确认）。
 *
 * PostgreSQL 对"匹配 0 行"的 `UPDATE` **不报错**，因此"语句没抛错"**不等于**"这一行真的被改了"：
 * 目标行不存在（这条建行还没落过库）或已被并发改动时都会命中 0 行。这里用 `RETURNING` 的
 * **实际返回行数**判定（与 `messages/store-pg.ts`、`favorites/store-pg.ts`、`conversations/store-pg.ts`
 * 同口径——它们的 `SqlRunner` 同样只有 `rows`），`rows.length !== 1` 即抛错（由 `flush()` 折成
 * 既有 `PROVIDER_UNAVAILABLE`），失败项留在日志里供下一次重放。
 *
 * 否则这条更新会被 `settle()` 记成 confirmed：重放只取未 confirmed 的项 ⇒ 它再也不会被重试，
 * 库停在建行快照（`state`/`decision` 是旧值）、内存已推进，而 `isDurable()` 仍答 `true`。
 *
 * 只 `RETURNING job_id`（主键列，已在 `20-login-roles.sql` 的列级 SELECT 授权清单内）：
 * 不新增授权面、不新增 SQL 字面量。
 */
function confirmUpdatedRow(jobId: string, result: { rows: Array<Record<string, unknown>> }): void {
  const row = result.rows[0];
  if (result.rows.length === 1 && row !== undefined && row.job_id === jobId) return;
  throw new Error(`审核台账更新未命中目标行：job ${jobId} 期望影响 1 行，实际返回 ${result.rows.length} 行`);
}

export function createPostgresModerationLedger(options: { pool: SqlRunner; now?: () => Date }): PostgresModerationLedger {
  const inner = createModerationLedger();
  const now = options.now ?? (() => new Date());

  /** 写入严格按登记顺序落库的串行链。 */
  let chain: Promise<void> = Promise.resolve();

  /**
   * 写入意图**顺序日志**：成功落定才从**前缀**摘掉，失败项一律留在日志里。
   *
   * 关键不变式：**日志非空 ⇔ 还有未确认落库的写入**。`flush()` 只有把日志清空才放行，
   * 因此"失败被消费掉 + 空队列"不再等于"已落定"（`#434` 监工 P1 的洗白入口）。
   */
  const journal: WriteIntent[] = [];
  /** 已确认落库的 `job_id`（建行成功过）；`isDurable` 的第一条判据。 */
  const confirmedCreates = new Set<string>();
  /** 最近一次失败（只用于 `flush()` 的错误文案；不承担"是否有未落定写入"的判据）。 */
  let lastFailure: unknown = null;

  // ---- 下架集合的回填（惰性、只读、只动内存） --------------------------------
  /** 当前这次回填的 promise（`null` ⇒ 没有在跑／上次失败已清空，下次调用重新回填）。 */
  let hydration: Promise<void> | null = null;
  /** 是否已成功回填过；一旦为 `true` 就不再打库。 */
  let hydrated = false;
  /** 上次回填的失败原因（只用于错误文案）。 */
  let hydrationError: unknown = null;

  /**
   * 回填失败 ⇒ 领域错误。文案**必须同时**点明「回填」与「结论未落定」：
   * 前者让人知道是哪一步没做成，后者保证它不会被读成"已保存"（与写面失败同码不同事）。
   */
  function hydrateFailure(error: unknown): ApiError {
    return ledgerFailure(error, '回填下架集合');
  }

  /**
   * 一次回填：读三列 → 逐行 `inner.markWithdrawn(...)`。
   *
   * **只动内存，不 enqueue**：这些行本来就在库里，把回填当成"待落库的写入"会让
   * `isDurable`／`flush()` 因为一次纯读而拒绝，也会让下架行被无意义地再写一遍。
   */
  async function startHydration(): Promise<void> {
    const result = await options.pool.query(HYDRATE_WITHDRAWALS_SQL);
    for (const row of result.rows) {
      const revision = Number(row.target_revision);
      if (typeof row.target_type !== 'string' || typeof row.target_id !== 'string' || !Number.isInteger(revision)) {
        // 行形状不对 ⇒ 宁可整体失败（flush 因而拒绝），也不许"跳过这一行"：
        // 漏掉一行下架标记就是给旧回调留一条复活路径。
        throw new Error(
          `下架行形状不可用：type=${String(row.target_type)} id=${String(row.target_id)} revision=${String(row.target_revision)}`,
        );
      }
      inner.markWithdrawn({ type: row.target_type as TargetRef['type'], id: row.target_id, revision });
    }
    hydrated = true;
    hydrationError = null;
  }

  /** 复用正在跑的那次回填；失败即清空（下一次调用重新回填，不缓存失败）。 */
  function once(): Promise<void> {
    hydration ??= startHydration().catch((error: unknown) => {
      hydration = null;
      hydrationError = error;
      throw error;
    });
    return hydration;
  }

  async function hydrate(): Promise<void> {
    if (hydrated) return;
    try {
      await once();
      return;
    } catch {
      // 上次（含本次的第一次尝试）失败：存储可能刚恢复，重试一次。再失败就如实抛出。
    }
    try {
      await once();
    } catch (error) {
      throw hydrateFailure(hydrationError ?? error);
    }
  }

  /** 只有**前缀全部确认**才前移：中间失败不会让后面的成功把失败"顶掉"。 */
  function pruneConfirmed(): void {
    for (let head = journal[0]; head !== undefined && head.confirmed; head = journal[0]) journal.shift();
  }

  /** 一次成功的收尾（首次执行与重放**共用**同一段，保证两条路径的可信度一致）。 */
  function settle(intent: WriteIntent): void {
    intent.confirmed = true;
    if (intent.creates && intent.job_id !== null) confirmedCreates.add(intent.job_id);
    pruneConfirmed();
  }

  /** 把一条意图挂到串行链上（写入严格按登记顺序落库）。 */
  function schedule(intent: WriteIntent): void {
    chain = chain
      .then(async () => {
        await intent.run();
        settle(intent);
      })
      .catch((error: unknown) => {
        // 失败即**留在日志里**（不摘除、不清空）：`flush()` 会重放它；
        // 在它真的落定之前，日志非空 ⇒ 任何 `flush()` 都拒绝。
        lastFailure = error;
      });
  }

  function enqueue(meta: { job_id: string | null; creates: boolean }, run: () => Promise<void>): void {
    const intent: WriteIntent = { job_id: meta.job_id, creates: meta.creates, run, confirmed: false, reported: false };
    journal.push(intent);
    schedule(intent);
  }

  function stamp(value: string): string {
    return typeof value === 'string' && value.length > 0 ? value : now().toISOString();
  }

  return {
    persistent: true,
    create(record) {
      // 先走内层：重复 job_id 在这里**同步**抛错，绝不会先写库再报错。
      const stored = inner.create(record);
      enqueue({ job_id: stored.job_id, creates: true }, async () => {
        // **执行时**再判这一笔还是不是"现任任务"：登记之后，同目标同内容类别可能又建了更新的
        // 任务（内存台账已由它接任）。这时这一笔必须按**历史行**落库（监工 P2）：
        //   · 不跑退位语句 —— 否则重放旧任务会把现存任的任务 B 退位，库里 0 条 current；
        //   · 插入时 `superseded = TRUE` —— 它本来就是被接任的旧结论。
        // 现任任务则相反：退位同目标版本上的**别的**行（`job_id <> $6` 排除自己），再插入。
        const isCurrent = inner.current(stored.target_ref, stored.content_kind)?.job_id === stored.job_id;
        const supersededRow = !isCurrent;
        const insertValues = [
          stored.job_id,
          stored.target_ref.type,
          stored.target_ref.id,
          stored.target_ref.revision,
          stored.content_kind,
          stored.port_kind,
          stored.prompt_id,
          stored.job_revision,
          stored.state,
          stored.lease_token,
          stored.authorization_epoch,
          stored.submitted_by,
          stored.deadline_at,
          stored.decision,
          JSON.stringify(stored.reason_codes),
          stored.hard_rule_passed,
          stored.rule_version,
          stored.model_version,
          stored.prompt_version,
          jsonOrNull(stored.contract_value),
          jsonOrNull(stored.gate_holder),
          stored.error_code,
          JSON.stringify(stored.evidence),
          supersededRow,
          stamp(stored.created_at),
          stamp(stored.updated_at),
        ];
        const supersedeValues = [
          stored.target_ref.type,
          stored.target_ref.id,
          stored.target_ref.revision,
          stored.content_kind,
          stamp(stored.updated_at),
          stored.job_id,
        ];
        const write = async (
          query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>,
        ) => {
          if (isCurrent) await query(SUPERSEDE_SQL, supersedeValues);
          await query(INSERT_SQL, insertValues);
          // `ON CONFLICT (job_id) DO NOTHING` 命中已有行时不写任何东西：**必须读回**确认状态，
          // 不得假设"没报错 ⇒ 状态正确"（否则旧行会带着错误的 superseded 留在库里）。
          const read = await query(READ_SUPERSEDED_SQL, [stored.job_id]);
          const row = read.rows[0];
          const actual = row !== undefined && row.superseded === true;
          if (row === undefined || actual !== supersededRow) {
            throw new Error(
              `读回不一致：job ${stored.job_id} 期望 superseded=${supersededRow}，实际 ${row === undefined ? '缺行' : String(actual)}`,
            );
          }
        };
        if (isTransactor(options.pool)) {
          const client = await options.pool.connect();
          try {
            await client.query('BEGIN');
            await write((text, values) => client.query(text, values));
            await client.query('COMMIT');
          } catch (error) {
            try {
              await client.query('ROLLBACK');
            } catch {
              // 回滚自身失败不能盖掉原始错误：原始错误才是"没落库"的判据。
            }
            throw error;
          } finally {
            client.release();
          }
          return;
        }
        // 只有假池（无 connect）走这里：顺序语句，原子性仅在真池成立。
        await write((text, values) => options.pool.query(text, values));
      });
      return stored;
    },
    update(record) {
      // 内层先判"任务是否存在"，保持与内存实现逐字一致的同步抛错。
      const stored = inner.update(record);
      enqueue({ job_id: stored.job_id, creates: false }, async () => {
        const result = await options.pool.query(UPDATE_SQL, [
          stored.job_id,
          stored.state,
          stored.lease_token,
          stored.decision,
          JSON.stringify(stored.reason_codes),
          stored.hard_rule_passed,
          stored.rule_version,
          stored.model_version,
          stored.prompt_version,
          jsonOrNull(stored.contract_value),
          jsonOrNull(stored.gate_holder),
          stored.error_code,
          JSON.stringify(stored.evidence),
          stored.superseded,
          stamp(stored.updated_at),
        ]);
        // 命中 0 行（目标行不存在／已被并发改动）真库**不报错**：必须按实际行变更确认，
        // 否则这条更新会被记成已落库、再也不会被重放（#434 复审 §6）。
        confirmUpdatedRow(stored.job_id, result);
      });
      return stored;
    },
    byJobId: (jobId) => inner.byJobId(jobId),
    current: (target, kind) => inner.current(target, kind),
    forRevision: (target) => inner.forRevision(target),
    history: (target) => inner.history(target),
    markWithdrawn(target) {
      inner.markWithdrawn(target);
      enqueue({ job_id: null, creates: false }, async () => {
        await options.pool.query(WITHDRAW_SQL, [
          target.type,
          target.id,
          target.revision,
          now().toISOString(),
        ]);
      });
    },
    isWithdrawn: (target) => inner.isWithdrawn(target),
    snapshotCounts: () => inner.snapshotCounts(),
    hydrate,
    get withdrawalsHydrated(): boolean {
      return hydrated;
    },
    isDurable(record) {
      // 建行必须真的落定过；且该任务名下不得有**未确认**的写入（含刚失败的那次）。
      if (!confirmedCreates.has(record.job_id)) return false;
      return !journal.some((intent) => intent.job_id === record.job_id);
    },
    async flush() {
      // **先回填下架集合，再等写入链。** 库里有下架行等于"这些版本已经永久下架"；回填没做成时
      // 放行 `flush()`，调用方就会接着把公开可见性翻成 `published`（下架标记是那条闸门的唯一判据）。
      // 回填失败**不跳过**写面收尾（否则失败项不会被标成 reported，重放语义会被饿死），
      // 但最终**必须拒绝**：文案含「回填」，与写面失败（含「结论未落定」）同码不同事。
      let hydrationFailure: unknown = null;
      try {
        await hydrate();
      } catch (error) {
        hydrationFailure = error;
      }
      /** 写面已收尾：只有回填也做成才允许放行。 */
      const settled = (): void => {
        if (hydrationFailure !== null) throw hydrateFailure(hydrationFailure);
      };
      await chain;
      if (journal.length === 0) {
        settled();
        return;
      }
      if (journal.some((intent) => !intent.reported)) {
        // 这些写入是**本次调用自己**刚尝试过的：不再原地重试，先如实拒绝；
        // 重试发生在下一次业务调用（`flush` 一次调用只打一次库，失败就停）。
        for (const intent of journal) intent.reported = true;
        throw ledgerFailure(lastFailure ?? new Error('审核台账写入未落定'), '落库');
      }
      // 到这里说明日志里的失败是**上一次调用**留下的：重放它们。
      // 只重放**未确认**的项（监工 P2）：日志允许在"前缀未确认"时保留后面的已落定项，
      // 把已 confirmed 的后项一起重放，会让它再跑一次退位、把现任行退位掉。
      // 四条语句都是幂等的（建行/下架 `ON CONFLICT ... DO NOTHING`，退位与更新按主键覆盖），
      // 所以"失败一次再来一次"不会写坏账本；真实落定后日志自然清空 ⇒ 本次放行。
      for (const intent of journal.filter((item) => !item.confirmed)) schedule(intent);
      await chain;
      if (journal.length === 0) {
        settled();
        return;
      }
      // 仍然没落定 ⇒ 继续**拒绝**（沿用既有安全错误码）。失败项留在日志里：
      // 既不会被"空队列"洗白，也不会永久毒化台账（存储恢复后下一次 flush 重放成功即放行）。
      throw ledgerFailure(lastFailure ?? new Error('审核台账写入未落定'), '落库');
    },
  };
}

/**
 * 判定台账的持久实现是否可用：`pool` 缺席时**不**退化成本地内存成功路径
 * （真实运行环境里"落不了库"必须是可见的失败，而不是静默降级）。
 */
export function moderationLedgerStoreOf(pool: SqlRunner | null | undefined, now?: () => Date): PostgresModerationLedger | null {
  if (pool === null || pool === undefined) return null;
  return createPostgresModerationLedger({ pool, now });
}

/* 导出面说明：本模块只对外提供两件东西——建台账的 `createPostgresModerationLedger`，
 * 以及"有池才建、无池不降级"的 `moderationLedgerStoreOf`。装配点（`app.ts`）用前者，
 * 因为装配处已经判过 `pool === null`；后者留给需要"缺失即不可用"语义的调用方。 */
