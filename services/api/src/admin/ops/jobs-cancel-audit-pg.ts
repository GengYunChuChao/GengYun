/**
 * `job.cancel` 的**库内审计落点**（迁移 0043 的窄口径 `SECURITY DEFINER` 函数的生产实现）。
 *
 * ## 为什么这里只有一条 SELECT
 * 运行时对 `public.admin_audit_events` 是**零表级、零列级**权限（`90-assert-least-privilege.sql`
 * 的 external_manifest 与槽 9 protected_columns 钉死）。唯一写入口是迁移 0043 建的
 * `public.record_admin_job_cancel_audit(uuid, uuid, integer, text, uuid)`：函数内固定
 * `action` / `scope` / `result`，`target_ref` 由形参重建，并重核验
 * 「操作者存在 + `state='active'` + 当前有效持 `jobs:cancel`」。
 *
 * ## 为什么这条语句**没有 `FROM`**
 * 纯投影的标量函数调用不触任何表/列，因此本文件不会被
 * `tests/unit/sql-column-coverage.test.mjs` 当成 SQL 宿主（该测试对「无表无函数」的文件直接跳过，
 * 且 `public.<name>(` 只在 `INSERT/DELETE/UPDATE/FROM/JOIN` 之后才算 public 限定访问）。
 * ⛔ 不要为了"看起来更像 SQL"补一个 `FROM`：那会把本文件变成新的 SQL 宿主，
 * 逼着授权面去审计一条根本不存在的表访问。
 *
 * ## 失败口径
 * 数据库侧任何失败都折成 `PROVIDER_UNAVAILABLE`（`retryable: false`）：审计写入**不是**可重试的
 * 幂等动作，而是一次已经发生的取消的结果登记。如实登记的已知窗口见迁移 0043 头注「已知边界」——
 * `jobs-pg.ts` 的 `cancel()` 自带事务并已提交，因此本文件失败时作业行可能**已经是 cancelled**
 * 而没有这次的审计行。这里选择把它变成**可观测的 503**（而不是静默丢审计，也不是把审计写成
 * 先成后败的假成功）。
 */
import { ApiError } from '../../errors.ts';
import type { PgPool } from '../../db/pool.ts';
import type { AdminJobCancelAuditInput, AdminJobCancelAuditPort } from './types.ts';

/**
 * 迁移 0043 的唯一写路径（`REVOKE ALL … FROM PUBLIC` +
 * `20-login-roles.sql` 的 `gy-r18-job-cancel-audit-grant` 只授运行时）。
 * 五个形参顺序即函数签名顺序：actor / job / revision / reason_code / request_id。
 */
const RECORD_SQL =
  'SELECT public.record_admin_job_cancel_audit($1::uuid, $2::uuid, $3::integer, $4::text, $5::uuid) AS audit_event_id';

/** 契约 `Meta.request_id` 与 `admin_accounts.id` 都是 uuid；不做"猜一个"式的兜底。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unavailable(message: string): ApiError {
  return new ApiError('PROVIDER_UNAVAILABLE', message, { retryable: false });
}

/**
 * 真实端口。`wired: true` —— 一旦注入，`cancelAdminJob` 成功后走库内审计，
 * 内存 ops store 只保留**非库模式**（stub / 未接作业端口）。
 */
export function createPostgresJobCancelAudit({ pool }: { readonly pool: PgPool }): AdminJobCancelAuditPort {
  return {
    wired: true,
    async record(input: AdminJobCancelAuditInput): Promise<{ auditEventId: string }> {
      if (!pool || typeof pool.query !== 'function') {
        throw unavailable('作业取消审计暂不可用');
      }
      if (!UUID_RE.test(input.actorId) || !UUID_RE.test(input.jobId) || !UUID_RE.test(input.requestId)) {
        // 走到这里说明服务层给了非 uuid 的身份/作业/请求 id：那是装配错误，不是用户输入错误。
        throw unavailable('作业取消审计的操作者/作业/请求 id 不是 uuid');
      }
      if (!Number.isInteger(input.jobRevision) || input.jobRevision < 1) {
        throw unavailable('作业取消审计的 revision 必须是正整数');
      }
      let rows: unknown;
      try {
        const result = await pool.query(RECORD_SQL, [
          input.actorId,
          input.jobId,
          input.jobRevision,
          input.reasonCode,
          input.requestId,
        ]);
        rows = result.rows;
      } catch (error) {
        throw unavailable(`作业取消审计写入失败：${(error as Error).message}`);
      }
      const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
      const auditEventId = row?.audit_event_id;
      if (typeof auditEventId !== 'string' || !UUID_RE.test(auditEventId)) {
        throw unavailable('作业取消审计写入未返回合法的审计行 id');
      }
      return { auditEventId };
    },
  };
}
