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
 *
 * GY-I13 追加（**纯追加，不改既有两个源**）：新增 `createSynthesisJobSource`（#13 合成域）。
 * 读面复用已合并的 `tts/service.ts` 的 `inspectJob`；本基线**没有**取消入口 ⇒ 与
 * `createTranscriptionJobSource` 同形**省略 `cancel`**（注册表对已存在的合成作业如实 503
 * `PROVIDER_UNAVAILABLE`(`retryable`)，**不伪造** `cancelled`、不另写状态机）。
 *
 * GY-I10 追加（**纯追加，不改既有五个源**）：新增 `createOcrJobSource`（#10 标签 OCR 域）。
 * 读面复用已合并的 `ocr/service.ts` 的 `getJob`（域内 `toJob` 产物**已是**契约 `Job` 九键形状）；
 * 取消面复用同文件的 `cancelJob`（`queued`/`running` → `cancelled`，revision 恰好 +1，终态不可
 * 取消）⇒ 与识别源同构地**提供 `cancel`**，版本冲突/终态等语义仍由 OCR 域自己决定。
 *
 * GY-R27 追加（**纯追加，不改其它源**）：转写源补上 `cancel` 面（#11/#13 的取消能力）。
 * 取消面复用已合并的 `speech/service.ts` 的 `cancelJob`（`queued`/`running` → `cancelled`，
 * revision 恰好 +1；终态再取消 ⇒ 域内 `OBJECT_UNAVAILABLE` 原样透出）；本层**不判状态、
 * 不改 revision、不另写状态机**——`canTransitionJob` 仍只在 `speech/state.ts` 一处。
 */
import { ApiError } from '../errors.ts';
import type { OcrService } from '../ocr/service.ts';
import type { RecognitionService } from '../recognitions/service.ts';
import type { SpeechService } from '../speech/service.ts';
import type { SynthesisService } from '../tts/service.ts';
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
 * 转写域作业源（#11/#102）：`getJob` 读取、`cancelJob` 取消（GY-R27 接线）。
 *
 * 取消语义**全部由 `speech/service.ts` 决定**，本层只做两件事：
 * - 域内 `NOT_FOUND`（不存在**或**越权）⇒ `null`，注册表据此回同形 404；
 * - 其余错误（`REVISION_CONFLICT` / `OBJECT_UNAVAILABLE` / `IDEMPOTENCY_*` /
 *   `REQUEST_IN_PROGRESS`）**原样透出** ⇒ 终态不可取消等问题如实回 409，
 *   **不再**被改写成 `503 PROVIDER_UNAVAILABLE`（本基线之前的形态：无 `cancel` ⇒ 503）。
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
    async cancel(input: JobSourceCancelInput) {
      try {
        return await service.cancelJob({
          userId: input.userId,
          jobId: input.jobId,
          ifMatch: input.ifMatch,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
  };
}

/**
 * 合成（普通话 TTS）域作业源（#13）。
 *
 * **只读复用**已合并的 `tts/service.ts`：`inspectJob({userId, jobId})` 是**域内**读面
 * （契约里 TTS 只有 `POST /speech/synthesis`，没有专属读端点 ⇒ `GET /jobs/{id}` 是读 JobState 的唯一契约面）。
 *
 * 归属与不存在**同形**：域内 `getOwnedJob` 对「不存在」与「他人作业」都抛 `ApiError('NOT_FOUND')`，
 * 本适配层把它映射为 `null` ⇒ 注册表无法、也不需要区分二者（与识别/转写源同一口径）。
 *
 * **取消能力：本基线没有**——`tts/service.ts` 只提供受理/读取/校验，没有取消入口；派单明令
 * 「不得在作业面上另写一套状态机」「不得改动各域服务语义」，因此这里**省略 `cancel`**：
 * 注册表会先确认作业确实存在，再以契约 **`503 PROVIDER_UNAVAILABLE`（`retryable: false`）** 如实拒绝。
 * 合成作业不在 `states.json.job_transitions` 之外新增任何迁移语义，本层不判状态、不改 revision。
 *
 * 契约形状**不由本层放宽**：出口仍由注册表的 `assertContractJob` 逐项校验，其中
 * `JobResult` 的 `synthesis` 分支镜像在 `./result-shape.ts` 的 `Synthesis`（`id`/`revision`/
 * `checked_content_ref`(TargetRef)/`media_id` 四键，`additionalProperties:false`）。
 */
export function createSynthesisJobSource(service: SynthesisService): JobSourcePort {
  return {
    kind: 'synthesis',
    async get(input: JobSourceGetInput) {
      try {
        return await service.inspectJob({ userId: input.userId, jobId: input.jobId });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
  };
}

/**
 * 标签 OCR 域作业源（#10，**纯追加**）。
 *
 * **只读复用**已合并的 `ocr/service.ts`：`getJob({userId, jobId})` 是**域内**读面
 * （契约里 OCR 只有 `POST /ocr` / `GET /ocr/{id}` / `DELETE` / `PATCH …/correction` / `POST …/verify`，
 * **没有** OCR 专属的任务状态端点 ⇒ `GET /jobs/{id}` 是读 `JobState` 与 `error_code` 的**唯一**契约面：
 * `GET /ocr/{id}` 只在产出记录后可读，`failed`/`timed_out` 不产出记录 ⇒ 与"仍在处理"同形）。
 *
 * 归属与不存在**同形**：域内 `getOwnedJob` 对「不存在」与「他人作业」都抛 `ApiError('NOT_FOUND')`
 * （非法 uuid 亦同），本适配层把它映射为 `null` ⇒ 注册表无法、也不需要区分二者（与识别/转写/合成源同一口径）。
 *
 * **取消能力：已接线**（GY-I10 取消片）——`ocr/service.ts` 的 `cancelJob` 把 `queued`/`running`
 * 原子迁到 `cancelled`（单次 CAS ⇒ revision **恰好 +1**、`error_code` 清空）；终态（`succeeded`/
 * `uncertain`/`failed`/`timed_out`/`cancelled`）不可再取消，域内抛 `OBJECT_UNAVAILABLE`，本层原样透出。
 * 取消后的迟到结果由域内 `commitTerminal` 的 CAS + 状态机拦住 ⇒ **不复活**（不靠删记录）。
 * 本层不判状态、不改 revision、不另写状态机（与识别源同一口径）。
 *
 * 契约形状**不由本层放宽**：出口仍由注册表的 `assertContractJob` 逐项校验，其中
 * `JobResult` 的 `ocr` 分支镜像在 `./result-shape.ts` 的 `OCR`（`id`/`revision`/`raw_fields`/
 * `corrected_fields`/`verification`/`model_version` 六键，`additionalProperties:false`）。
 */
export function createOcrJobSource(
  service: OcrService,
  /**
   * 与识别源同形的**追加式**取消钩子（可选）：取消**成功提交后**调用；钩子异常不改变取消结果
   * （取消已提交），只保证不外抛（原始错误由调用方记日志）。
   */
  hooks: { onCancelled?(input: { jobId: string; userId: string }): Promise<void> } = {},
): JobSourcePort {
  return {
    kind: 'ocr',
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
