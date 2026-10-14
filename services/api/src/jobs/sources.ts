/**
 * GY-I01 跨 kind 的作业读面/取消面 · **各域作业源适配器**（只读复用各域服务，不改其语义）。
 *
 * 本文件把「域内服务」适配成注册表要的 `JobSourcePort`：
 * - 域内 `getJob`/`cancelJob` 在「不存在**或**越权」时抛 `NOT_FOUND`（各域既有口径）；适配层把
 *   `NOT_FOUND` 映射为 `null` ⇒ 注册表无法区分二者，**对外一律同形**。
 * - 其余错误（`REVISION_CONFLICT`/`OBJECT_UNAVAILABLE`/`REQUEST_IN_PROGRESS` 等）**原样透出**，
 *   不经本层改写 ⇒ 版本冲突、终态不可取消等语义仍由**各域自己**决定（不在作业面另写状态机）。
 *
 * 本片接线范围（派单 §设计要求 3）：**`recognition`（#87 已合并）与 `transcription`（#11/#102 已合并）**。
 * 未接线的 kind 见证据文档的「待接线清单」；本文件**不引用任何未合并代码**。
 */
import { ApiError } from '../errors.ts';
import type { RecognitionService } from '../recognitions/service.ts';
import type { SpeechService } from '../speech/service.ts';
import type { JobSourceCancelInput, JobSourceGetInput, JobSourcePort } from './registry.ts';

/** 域内「不存在或越权」的统一信号；只有它会变成 `null`（⇒ 同形 404）。 */
function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'NOT_FOUND';
}

/** 识别域作业源（#87）：`getJob` 读取、`cancelJob` 取消（两者都已实现，含 If-Match/幂等/终态语义）。 */
export function createRecognitionJobSource(
  service: RecognitionService,
  /**
   * GY-I27 第二片：取消后的**追加式**钩子（可选）。域内取消**成功后**调用，用于写外发取消墓碑
   * （只增不减 ⇒ 晚到回调不可复活）。钩子异常**不改变**取消结果（取消已提交），只记入告警日志。
   */
  hooks: { onCancelled?(input: { jobId: string; userId: string }): Promise<void> } = {},
): JobSourcePort {
  return {
    kind: 'recognition',
    async get(input: JobSourceGetInput) {
      try {
        return await service.getJob({ userId: input.userId, jobId: input.jobId });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async cancel(input: JobSourceCancelInput) {
      let cancelled;
      try {
        cancelled = await service.cancelJob({
          userId: input.userId,
          jobId: input.jobId,
          ifMatch: input.ifMatch,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      if (cancelled !== null && hooks.onCancelled !== undefined) {
        // 取消已提交：钩子失败不得回滚取消，也不得改写成失败响应（原始错误只进日志）。
        await hooks.onCancelled({ jobId: input.jobId, userId: input.userId }).catch(() => {});
      }
      return cancelled;
    },
  };
}

/**
 * 转写域作业源（#11/#102）：`getJob` 读取可用。
 *
 * **取消能力：本基线没有**——`speech/service.ts` 只提供受理/读取/确认/删除，没有取消入口；
 * 派单明令"不得在作业面上另写一套状态机""不得改动各域服务语义"，因此这里**省略 `cancel`**：
 * 注册表会先确认作业确实存在，再以 **`503 PROVIDER_UNAVAILABLE`（`retryable: true`）**（"该作业所属能力尚未提供取消"）
 * 如实拒绝；**不会**假装取消成功，也**不会**为它伪造 `cancelled` 状态。
 */
export function createTranscriptionJobSource(service: SpeechService): JobSourcePort {
  return {
    kind: 'transcription',
    async get(input: JobSourceGetInput) {
      try {
        return await service.getJob({ userId: input.userId, jobId: input.jobId });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
  };
}
