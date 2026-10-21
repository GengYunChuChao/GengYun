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
 * ## 不做 hydrate
 * 存量行"当初有没有结论"在库层面也不可区分（决策：只读面用 `present=false ⇒ unknown` 表达，
 * 不改社区契约）。本模块因此**只写不读**：进程启动时不回填内存台账，`byJobId/current/...`
 * 仍答内存里的本次进程结论。跨进程追溯走审计查询（直接查表）。
 */
import { ApiError } from '../errors.ts';
import { createModerationLedger, type ModerationLedger } from './decisions.ts';
import type { ModerationTaskRecord } from './types.ts';

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
  /** 等待已入队写入落定；任何一次落库失败都会在此抛出。 */
  flush(): Promise<void>;
  readonly persistent: true;
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
   AND content_kind = $4 AND superseded = FALSE`;

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
 */
const UPDATE_SQL = `UPDATE public.moderation_decisions SET
  state = $2, lease_token = $3, decision = $4, reason_codes = $5::jsonb, hard_rule_passed = $6,
  rule_version = $7, model_version = $8, prompt_version = $9, contract_value = $10::jsonb,
  gate_holder = $11::jsonb, error_code = $12, evidence = $13::jsonb, superseded = $14,
  updated_at = $15::timestamptz
WHERE job_id = $1`;

/** 下架标记：同一 `(target_type,target_id,target_revision)` 只留一行（下架是终态、可重放）。 */
const WITHDRAW_SQL = `INSERT INTO public.moderation_withdrawals (
  target_type, target_id, target_revision, withdrawn_at
) VALUES ($1, $2, $3, $4::timestamptz)
ON CONFLICT (target_type, target_id, target_revision) DO NOTHING`;

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

export function createPostgresModerationLedger(options: { pool: SqlRunner; now?: () => Date }): PostgresModerationLedger {
  const inner = createModerationLedger();
  const now = options.now ?? (() => new Date());

  /** 串行队列：写入严格按调用顺序落库（同键的 supersede 与 insert 不会乱序）。 */
  let chain: Promise<void> = Promise.resolve();
  let pending: unknown = null;

  function enqueue(run: () => Promise<void>): void {
    chain = chain.then(run).catch((error: unknown) => {
      // 首个失败即定案：后续写入照旧排队（保持顺序），但 flush 一定抛出。
      pending ??= error;
    });
  }

  function stamp(value: string): string {
    return typeof value === 'string' && value.length > 0 ? value : now().toISOString();
  }

  return {
    persistent: true,
    create(record) {
      // 先走内层：重复 job_id 在这里**同步**抛错，绝不会先写库再报错。
      const stored = inner.create(record);
      enqueue(async () => {
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
          stored.superseded,
          stamp(stored.created_at),
          stamp(stored.updated_at),
        ];
        const supersedeValues = [
          stored.target_ref.type,
          stored.target_ref.id,
          stored.target_ref.revision,
          stored.content_kind,
          stamp(stored.updated_at),
        ];
        if (isTransactor(options.pool)) {
          const client = await options.pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(SUPERSEDE_SQL, supersedeValues);
            await client.query(INSERT_SQL, insertValues);
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
        // 只有假池（无 connect）走这里：顺序两条语句，原子性仅在真池成立。
        await options.pool.query(SUPERSEDE_SQL, supersedeValues);
        await options.pool.query(INSERT_SQL, insertValues);
      });
      return stored;
    },
    update(record) {
      // 内层先判"任务是否存在"，保持与内存实现逐字一致的同步抛错。
      const stored = inner.update(record);
      enqueue(async () => {
        await options.pool.query(UPDATE_SQL, [
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
      });
      return stored;
    },
    byJobId: (jobId) => inner.byJobId(jobId),
    current: (target, kind) => inner.current(target, kind),
    forRevision: (target) => inner.forRevision(target),
    history: (target) => inner.history(target),
    markWithdrawn(target) {
      inner.markWithdrawn(target);
      enqueue(async () => {
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
    async flush() {
      await chain;
      if (pending === null) return;
      const error = pending;
      // 抛过一次就不再重复抛（调用方已按"未落库"处理；重试走新的业务调用）。
      pending = null;
      chain = Promise.resolve();
      throw ledgerFailure(error, '落库');
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
