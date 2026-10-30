/**
 * GY-I14（#14）审核 HTTP 装配片 · **`moderation` 作业源适配器**（只读复用审核服务，不改其语义）。
 *
 * 契约（`packages/contracts/openapi.json`）：`GET /jobs/{id}` → 200 `JobEnvelope`，
 * `Job.kind ∈ {…, 'moderation'}`，`JobResult` 的 `moderation` 分支 = `ModerationResult`
 * （`{kind:'moderation', value: Moderation}`）。本片**只**接入这一个**已有**读面，
 * **不新增**任何 path/operationId。
 *
 * 归属（与 `jobs/sources.ts` 的既有口径一致）：
 *   - 「不存在」「他人作业」「未接线 kind」**一律同形** `NOT_FOUND`：前两者由本适配器返回 `null`；
 *   - 契约形状由注册表的 `assertContractJob` 统一守卫（本适配器不自行放宽 schema）。
 *
 * **取消能力（GY-R71 追加）**：本源已提供 `cancel`，语义**全部由 `moderation/service.ts` 的
 * `cancelJob` 决定**（`queued`/`running` → `cancelled`、`job_revision` 恰好 +1、终态不可取消）。
 * 接线前的形态是：缺 `cancel` ⇒ 注册表先确认作业存在，再以契约 503 `PROVIDER_UNAVAILABLE`
 * 「该能力尚未提供取消」如实拒绝。现在**只**在"任务还没出结论"的那一段可取消——
 * 已出结论的任务（含 `uncertain`/隔离）仍按 409 `OBJECT_UNAVAILABLE` 拒绝，
 * 因此取消**不会**掩盖任何隔离事实（这是接线前那条注释唯一要求守住的东西，仍被守住）。
 *
 * 本层只做两件事（与 `jobs/sources.ts` 的五个源同构）：域内 `NOT_FOUND` ⇒ `null`（⇒ 同形 404）；
 * 其余错误（`REVISION_CONFLICT`/`OBJECT_UNAVAILABLE`/`REVISION_REQUIRED`/`INVALID_REQUEST`/
 * `IDEMPOTENCY_KEY_REQUIRED`）**原样透出**，不判状态、不改 revision、不另写状态机。
 */
import type { ContractJob, JobSourceCancelInput, JobSourceGetInput, JobSourcePort } from '../jobs/registry.ts';
import type { ModerationService } from './service.ts';
import type { ModerationTaskView } from './types.ts';

/**
 * 任务视图 → 契约 `Job`（**读面与取消面共用的唯一投影点**，避免两条路径长出两套形状）。
 *
 * 契约 `Moderation` 的 `model_version`/`prompt_version` 缺真实值时 `contract_value` 为 `null`
 * ⇒ 如实 `result: null`（`succeeded`/`uncertain` 都允许不带 result），**绝不**填占位串；
 * `cancelled` 的任务在取消时已把 `contract_value` 清空 ⇒ 同样 `result: null`。
 */
function projectModerationJob(task: ModerationTaskView): ContractJob {
  return {
    id: task.job_id,
    revision: task.job_revision,
    kind: 'moderation',
    target_ref: task.target_ref,
    state: task.state,
    deadline_at: task.deadline_at,
    created_at: task.created_at,
    // 台账里的 `error_code` 是域内字符串列（与 `conversations/job.ts` 同口径）：契约闭集由注册表的
    // `assertContractJob` 逐项复核，这里只做类型收窄，**不**填默认值、**不**改写。
    error_code: task.error_code === null ? null : (task.error_code as ContractJob['error_code']),
    result: task.contract_value === null ? null : { kind: 'moderation', value: task.contract_value },
  };
}

export function createModerationJobSource(service: ModerationService): JobSourcePort {
  return {
    kind: 'moderation',
    async get(input: JobSourceGetInput) {
      const task = service.taskByJobId(input.jobId);
      if (task === null) return null;
      // 归属：他人作业与"作业不存在"同形（不泄露存在性）。
      if (task.submitted_by !== input.userId) return null;
      return projectModerationJob(task);
    },
    async cancel(input: JobSourceCancelInput) {
      // 归属检查先行：不存在/越权 ⇒ `null`（同形 404），且**不**消耗调用方的 If-Match/幂等键。
      const task = service.taskByJobId(input.jobId);
      if (task === null) return null;
      if (task.submitted_by !== input.userId) return null;
      const cancelled = await service.cancelJob({
        userId: input.userId,
        jobId: input.jobId,
        ifMatch: input.ifMatch,
        idempotencyKey: input.idempotencyKey,
      });
      return projectModerationJob(cancelled);
    },
  };
}
