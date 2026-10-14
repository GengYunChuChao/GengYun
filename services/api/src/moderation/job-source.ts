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
 *   - 契约形状由注册表的 `assertContractJob` 统一守卫（本适配器不自行放宽 schema）；
 *   - **取消能力本片不提供**：省略 `cancel` ⇒ 注册表对已存在的审核作业以契约
 *     `503 PROVIDER_UNAVAILABLE`（`retryable`）如实拒绝，**不伪造** `cancelled`（审核任务不是
 *     用户可取消的排队作业，且"取消"会掩盖隔离事实）。
 */
import type { JobSourceGetInput, JobSourcePort } from '../jobs/registry.ts';
import type { ModerationService } from './service.ts';

export function createModerationJobSource(service: ModerationService): JobSourcePort {
  return {
    kind: 'moderation',
    async get(input: JobSourceGetInput) {
      const task = service.taskByJobId(input.jobId);
      if (task === null) return null;
      // 归属：他人作业与"作业不存在"同形（不泄露存在性）。
      if (task.submitted_by !== input.userId) return null;
      return {
        id: task.job_id,
        revision: task.job_revision,
        kind: 'moderation',
        target_ref: task.target_ref,
        state: task.state,
        deadline_at: task.deadline_at,
        created_at: task.created_at,
        error_code: task.error_code,
        // 契约 `Moderation` 的 `model_version`/`prompt_version` 缺真实值时 `contract_value` 为 `null`
        // ⇒ 如实 `result: null`（`succeeded`/`uncertain` 都允许不带 result），**绝不**填占位串。
        result:
          task.contract_value === null
            ? null
            : { kind: 'moderation', value: task.contract_value },
      };
    },
  };
}
