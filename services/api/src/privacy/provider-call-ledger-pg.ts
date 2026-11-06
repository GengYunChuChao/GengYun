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
 *      这样「第二个写入者」不可能写出重复序号而不被 `UNIQUE` 抓住。
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
 * 本文件零网络、零真实外呼；`record()` 只有**一条** SQL 语句，其逐列清单与
 * `deploy/postgres-cvm/sql/20-login-roles.sql` 的 `gy-r83-provider-call-ledger-grant` 区、
 * `90-assert-least-privilege.sql` 的 `expected` 行是同一事实的三种写法（改一处必须三处同改）。
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
}

export interface ProviderCallLedger {
  record(input: ProviderCallLedgerRecordInput): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 唯一的写语句。逐列与 0055 的列序一致（`id` / `created_at` 吃表默认值，**不在**这里出现）。
 *
 * 为什么是 `INSERT … SELECT` 而不是 `INSERT … VALUES`：序号要读「同一 `export_id` 上已有的最大
 * `attempt`」，`VALUES` 里放子查询不合法（PostgreSQL 的 `VALUES` 行不允许标量子查询），
 * `SELECT` 还可以让 `$3`（`export_id`）在两处复用同一个参数位。
 */
const INSERT_SQL = `INSERT INTO public.provider_call_ledger
       (domain, job_id, export_id, attempt, capability, provider_config_version,
        model_version, invocation_state, usage, sent_at, duration_ms)
SELECT $1::text, $2::uuid, $3::uuid,
       COALESCE((SELECT MAX(attempt)
                   FROM public.provider_call_ledger
                  WHERE export_id = $3::uuid), 0) + 1,
       $4::text, $5::text, $6::text, $7::text, $8::jsonb, $9::timestamptz, $10::integer`;

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

/**
 * 构造写入原语。
 *
 * @param pool 连接池。**给 `null` 就是「不记账」**（返回 `null`），这是非 real / 无 `DATABASE_URL`
 *   装配路径的正常结果 —— 与 `createPostgresExportLedger` 只在池可用时构造同源。⛔ 绝不因为没池
 *   就伪造一个内存账本：记账是**落库**事实，内存里记一笔等于没记。
 */
export function createProviderCallLedger(pool: PgPool | null): ProviderCallLedger | null {
  if (!pool || typeof pool.query !== 'function') return null;
  return {
    async record(input: ProviderCallLedgerRecordInput): Promise<void> {
      const exportId = typeof input?.exportId === 'string' ? input.exportId.trim() : '';
      if (!UUID.test(exportId)) {
        // 没有合法 export_id 就没有外键归属：这是**调用方的装配错误**，不是数据库故障。
        throw new ApiError('INVALID_REQUEST', '识别外发记账缺少合法的 export_id');
      }
      try {
        await pool.query(INSERT_SQL, [
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
        ]);
      } catch (error) {
        classifyProviderCallLedgerError(error);
      }
    },
  };
}
