/**
 * GY-R83 · `#1003`：识别链路外发记账台账（`public.provider_call_ledger`，迁移 `0055`）的**唯一**
 * 写入原语。
 *
 * ## 与 `privacy/ledger-pg.ts::recordInvocation` 的关系（刻意同构，不是重复）
 * 0050 那张调用记录表是「每一次真实外发一行」的**长期台账**，但它的写入权在默认部署下
 * 被三处文档明写**有意冻结**（`0050` 的建表件 :106、`90-assert-least-privilege.sql`
 * 的 `unwired_manifest`、「`ai-ops-spec-status.md` 的 N05」）⇒ 运行时写它会恒 42501。0055 另开一张
 * **同构窄表**：列名逐条对齐（`export_id` / `attempt` / `capability` / `model_version` /
 * `invocation_state` / `usage` / `sent_at` / `duration_ms`），日后解冻 0050 时是**并入**而不是重写。
 *
 * ⚠ 本文件刻意**不写**那张表的字面表名与迁移件名：`tests/unit/ai-ops-ledger-pins.test.mjs`
 * 的钉子②把「`services/api/src` 里出现该表名的文件」钉成一份写死的白名单（那是「谁在写这张表」
 * 的唯一凭据），登记只读注释会稀释它。完整出处见 `services/api/db/migrations/README.md` 的 0055 条目。
 *
 * 差异只有三处，都是口径收紧：
 *   1. 闭集更窄：`domain` 只有 `'recognition'`；`invocation_state` 只有 `sent` / `send_failed`
 *      （0050 的 `blocked` 在这里不存在 —— 零外发路径**不写行**，而不是写一行 `blocked`）；
 *   2. 序号维度是 `UNIQUE (export_id, attempt)`（0050 是 `(job_id, attempt)`）—— 同一次外发预留行
 *      可以被提供者重试多次，序号必须跟着**预留行**走；
 *   3. `attempt` **由本文件的语句自己派生**：`COALESCE(MAX(attempt), 0) + 1`，调用方**不得自报**。
 *      这样「第二个写入者」不可能写出重复序号而不被 `UNIQUE` 抓住；并发撞号（`23505`）时
 *      本模块**重试一次**（只重试这一种），再冲突就折成契约错误交给记账层。
 *
 * ## 失败语义（由调用方决定吞不吞）
 * 本模块**只抛不吞**：`record()` 的失败一律折成契约错误后 `throw`（与
 * `media/store-pg.ts::classifyMediaDatabaseError` 同款思路：超时/死锁 ⇒ `PROVIDER_TIMEOUT` 可重试，
 * 其余 ⇒ `PROVIDER_UNAVAILABLE`，驱动原文不外泄）。**吞掉失败是记账层的决定**
 * （`privacy/media-call-accounting.ts` 的 try/catch + `readings.failed` + 事件），不是本模块的。
 * 为什么这样分：本模块不知道自己是不是在执行「已经成功的外发」的尾巴上；只有调用方知道
 * 「这次记账失败该不该影响识别结果」——答案永远是**不该**，但那条判断必须留在看得见的地方。
 *
 * ## 证据边界
 * 本文件零网络、零真实外呼；`record()` 只写**一条** INSERT（`RETURNING attempt`），短预算路径把它
 * 包进 `BEGIN` / `SET LOCAL statement_timeout` / `COMMIT` 三句事务语句里。其逐列清单与
 * `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r83-provider-call-ledger-grant` 区、
 * `90-assert-least-privilege.sql` 的 `expected` 行是同一事实的三种写法（改一处必须三处同改）。
 * 运行时的读权只落在 `(export_id, attempt)` 两列（子查询读、回执读），INSERT 权落在写入的 11 列。
 */
import { ApiError } from '../errors.ts';
import { isTransientDatabaseError } from '../db/pool.ts';
import type { PgPool } from '../db/pool.ts';

/** 迁移 0055 的 `domain` 闭集（本片只有一个成员；加成员必须同时改 CHECK）。 */
export type ProviderCallDomain = 'recognition';

/** 迁移 0055 的 `invocation_state` 闭集。⛔ 没有 `blocked`：零外发不写行。 */
export type ProviderCallInvocationState = 'sent' | 'send_failed';

/** `record()` 的入参。**没有** `attempt`：序号由 SQL 自己派生，调用方不得自报。 */
export interface ProviderCallLedgerRecordInput {
  domain: ProviderCallDomain;
  /** 作业 id；允许为空（外发可能发生在作业被登记之前，与 0050 的 `job_id` 同口径，无外键）。 */
  jobId?: string | null;
  /** 外发预留行（`public.exports.id`）：有外键 + ON DELETE CASCADE。**必填**。 */
  exportId: string;
  /** 接收方能力（`recipients.capability`：识别为 `weed`）—— 落库口径是调用方给的短标签。 */
  capability: string;
  /** 剖面版本串（形状见 `recognitions/call-metadata.ts` 的 `providerConfigVersionOf`）。**必填**。 */
  providerConfigVersion: string;
  /** 模型版本串（可为空）。形状与 `provider_config_version` 相同。 */
  modelVersion?: string | null;
  invocationState: ProviderCallInvocationState;
  /** 供应商回包的结构用量；只在 `sent` 时有值（`send_failed` 传 null）。 */
  usage?: unknown;
  /** 本次外发的尝试时刻（拿到响应或失败都写它；「没发出去」用**不写行**表达，不用 NULL 表达）。 */
  sentAt?: Date | null;
  durationMs?: number | null;
  /**
   * 这条语句的**短预算**（毫秒，≤1500）：以 `SET LOCAL statement_timeout` 落在独立连接的事务里。
   * 超时 ⇒ PostgreSQL `57014` ⇒ 折成可重试的 `PROVIDER_TIMEOUT`；⛔ 不影响调用方对识别结果的判定。
   * 不传 ⇒ 用连接池的默认 `statement_timeout`（`db/pool.ts` 的 5s）。
   */
  timeoutMs?: number | null;
}

/** `record()` 的回执：只有 `RETURNING attempt` 才能给出「这一行实际拿到了哪个序号」。 */
export interface ProviderCallLedgerRecordResult {
  /** 本次落库行的序号（由 SQL 派生，同一 `export_id` 上递增）。 */
  attempt: number;
}

export interface ProviderCallLedger {
  record(input: ProviderCallLedgerRecordInput): Promise<ProviderCallLedgerRecordResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 唯一的写语句。逐列与 0055 的列序一致（`id` / `created_at` 吃表默认值，**不在**这里出现）。
 *
 * 为什么是 `INSERT … SELECT` 而不是 `INSERT … VALUES`：序号要读「同一 `export_id` 上已有的最大
 * `attempt`」，`VALUES` 里放子查询不合法（PostgreSQL 的 `VALUES` 行不允许标量子查询），
 * `SELECT` 还可以让 `$3`（`export_id`）在两处复用同一个参数位。
 *
 * `RETURNING attempt`：回执必须给出**实际落库**的序号（`INSERT … SELECT` 选中零行时会静默不写，
 * 只有回执能识别这种异常）。运行时的读权因此只需要 `(export_id, attempt)` 两列 —— 子查询读
 * `attempt`/`export_id`，回执读 `attempt`；授权面见 `20-login-roles.sql` 的 `gy-r83-…` 区。
 *
 * ## 并发语义（`UNIQUE (export_id, attempt)` 是唯一裁决者）
 * `COALESCE(MAX(attempt), 0) + 1` 是**读后写**：两个并发事务各自读到同一个 `MAX` 时会算出同一个
 * 序号，后提交的那个被唯一键拒（SQLSTATE `23505`）。这是**预期**，不是缺陷 —— 序号不该由应用侧
 * 自增或加锁串行化（那会把记账锁进识别热路径）。本模块对 `23505` **重试一次**（只重试这一种，
 * 且只在写语句层面重试）：重试会重算 `MAX`，通常一次即成功；再冲突就按契约错误上抛，
 * 由记账层折成 `readings.failed`（⛔ 不改判识别结果）。
 */
const INSERT_SQL = `INSERT INTO public.provider_call_ledger
       (domain, job_id, export_id, attempt, capability, provider_config_version,
        model_version, invocation_state, usage, sent_at, duration_ms)
SELECT $1::text, $2::uuid, $3::uuid,
       COALESCE((SELECT MAX(attempt)
                   FROM public.provider_call_ledger
                  WHERE export_id = $3::uuid), 0) + 1,
       $4::text, $5::text, $6::text, $7::text, $8::jsonb, $9::timestamptz, $10::integer
RETURNING attempt`;

/** 唯一键冲突（并发下两个事务算出了同一个 `attempt`）：只对它重试一次。 */
const UNIQUE_VIOLATION = '23505';

/**
 * 数据库异常 → 契约错误（**抛出**，不返回类别）。
 *
 * 口径逐条对齐 `media/store-pg.ts:99-106`：`57014`（statement_timeout）/`55P03`（lock_not_available）
 * ⇒ `PROVIDER_TIMEOUT` 且可重试；已是契约错误则原样上抛；其余 ⇒ `PROVIDER_UNAVAILABLE`，
 * `retryable` 由 `isTransientDatabaseError` 判。⛔ 半句驱动原文都不进 message。
 */
function classifyProviderCallLedgerError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['57014', '55P03'].includes(code)) {
    throw new ApiError('PROVIDER_TIMEOUT', '识别外发记账数据库响应超时', { retryable: true });
  }
  if (error instanceof ApiError) throw error;
  throw new ApiError('PROVIDER_UNAVAILABLE', '识别外发记账暂不可用', { retryable: isTransientDatabaseError(error) });
}

/** 收口 `usage`：只接受**普通对象**（列上有 `jsonb_typeof(usage) = 'object'` 的 CHECK）。 */
function usageArg(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return JSON.stringify(value);
}

/** `duration_ms` 只接受非负整数（列上有 `>= 0` 的 CHECK；小数/负数一律按「不知道」处理）。 */
function durationArg(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 短预算收口：只接受 1..5000 的安全整数；不合法按「没给」处理（⛔ 不把 0/负数当无上限下发）。 */
function timeoutArg(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 5000 ? value : null;
}

/** 从 `RETURNING attempt` 的回执里取序号；拿不到就是异常（⛔ 不用 0/1 充数）。 */
function attemptOf(result: unknown): number {
  const attempt = (result as { rows?: Array<{ attempt?: unknown }> } | null)?.rows?.[0]?.attempt;
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new ApiError('PROVIDER_UNAVAILABLE', '识别外发记账未返回 attempt');
  }
  return attempt;
}

/**
 * 构造写入原语。
 *
 * @param pool 连接池。**给 `null` 就是「不记账」**（返回 `null`），这是非 real / 无 `DATABASE_URL`
 *   装配路径的正常结果 —— 与 `createPostgresExportLedger` 只在池可用时构造同源。⛔ 绝不因为没池
 *   就伪造一个内存账本：记账是**落库**事实，内存里记一笔等于没记。
 */
export function createProviderCallLedger(pool: PgPool | null): ProviderCallLedger | null {
  if (!pool || typeof pool.query !== 'function') return null;
  // 收窄后的局部别名：`insertOnce` 是闭包，上面的「非 null」收窄不会被带进闭包体。
  const sink: PgPool = pool;
  // 短预算要一个**独立连接**（`SET LOCAL` 只在事务里有效）；没有 `connect` 的极简池/假池
  // ⇒ 退回池级默认 `statement_timeout`（`db/pool.ts` 的 5s），⛔ 不静默改成「没有预算」。
  const transactional = typeof (sink as { connect?: unknown }).connect === 'function';

  /** 下发一条 INSERT，并取回它实际写下的 `attempt`。 */
  async function insertOnce(params: readonly unknown[], budgetMs: number | null): Promise<number> {
    if (budgetMs === null || !transactional) {
      return attemptOf(await sink.query(INSERT_SQL, params as unknown[]));
    }
    const client = await sink.connect();
    try {
      await client.query('BEGIN');
      // `SET LOCAL` 的作用域就是本事务：超时由服务端执行，客户端不必再等。
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${budgetMs}ms`]);
      const attempt = attemptOf(await client.query(INSERT_SQL, params as unknown[]));
      await client.query('COMMIT');
      return attempt;
    } catch (error) {
      // 回滚失败不许掩盖原始错误（连接已断时 `ROLLBACK` 自己也会抛）。
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async record(input: ProviderCallLedgerRecordInput): Promise<ProviderCallLedgerRecordResult> {
      const exportId = typeof input?.exportId === 'string' ? input.exportId.trim() : '';
      if (!UUID.test(exportId)) {
        // 没有合法 export_id 就没有外键归属：这是**调用方的装配错误**，不是数据库故障。
        throw new ApiError('INVALID_REQUEST', '识别外发记账缺少合法的 export_id');
      }
      const params: readonly unknown[] = [
        input.domain,
        typeof input.jobId === 'string' && UUID.test(input.jobId) ? input.jobId : null,
        exportId,
        input.capability,
        input.providerConfigVersion,
        typeof input.modelVersion === 'string' && input.modelVersion.trim() !== '' ? input.modelVersion.trim() : null,
        input.invocationState,
        usageArg(input.usage),
        input.sentAt instanceof Date && Number.isFinite(input.sentAt.getTime()) ? input.sentAt.toISOString() : null,
        durationArg(input.durationMs),
      ];
      const budgetMs = timeoutArg(input.timeoutMs);
      try {
        try {
          return { attempt: await insertOnce(params, budgetMs) };
        } catch (error) {
          // 并发下两个事务会算出同一个序号（见 `INSERT_SQL` 的「并发语义」）：唯一键拒 ⇒ **重试一次**。
          if ((error as { code?: unknown } | null)?.code === UNIQUE_VIOLATION) {
            return { attempt: await insertOnce(params, budgetMs) };
          }
          throw error;
        }
      } catch (error) {
        classifyProviderCallLedgerError(error);
      }
    },
  };
}
