/**
 * GY-I12（#12）· `answer` 作业源（跨 kind 读面 `GET /jobs/{id}` 的第六个源）。
 *
 * 为什么必须有它：契约 `createTurn` 返回 **202 `JobEnvelope`**（`kind: 'answer'`），
 * 而 `kind: 'answer'` 早已在 `jobs/registry.ts` 的 `JOB_KINDS` 闭集里、`AnswerResult` 也早已
 * 在 `JobResult.oneOf` 里 —— 但注册表里**没有任何源**，因此该 202 作业在跨 kind 读面上永远
 * `NOT_FOUND`。本文件补上这个源（**只追加一个源，不发明新状态、不改注册表**）。
 *
 * 作业状态的事实源是**轮次行上的作业快照**（迁移 0013 的 `job_state` /
 * `job_error_code` / `job_deadline_at` / `job_created_at`）：受理时写下、只在真发生跃迁时被更新，
 * **不是**读的时候重新估算出来的值。唯一例外是**过期裁定**：
 *   - 读面在「仍非终态 ∧ 已过 `deadline_at + 宽限`」时，用 `settleTurnJob` 做**一次** CAS 落
 *     `timed_out` / `PROVIDER_TIMEOUT`（与 OCR／合成同形），除此之外不做状态推断；投影仍经
 *     `registry.assertContractJob` 逐键复核（违规折 503）；越权与不存在一律 `null`（不得据此区分二者）；
 *   - **取消面**（GY-R71 追加）：本片给本源补上 `cancel`，语义**全部由会话域既有的 `cancelTurn` 决定**
 *     （`queued`/`running` → `cancelled`、revision 恰好 +1、终态不可取消、同键重放回放首次结果）。
 *     取消只写轮次行的作业快照、**不写回答**，因此"取消后仍落一条回答"在存储层即不可能
 *     （`settleTurnJob` 的状态谓词不再命中）。接线前该 kind 的取消一律 503「该能力尚未提供取消」。
 *
 * 如实性：`result` 只在该轮次确实已有回答（`state ∈ {succeeded, uncertain}` 且回答行存在）时给出，
 * `{kind:'answer', value: Answer}`。本片产出的每个 `Answer` 的 `model_version`/`prompt_version`
 * 都带 `unimplemented:no-real-` 前缀（「未接真实模型」的机器可判据标记，红线②）——
 * 替身结果**永远**带着这个标记，不可能被读成真实模型结果。
 */
import type { ContractJob, JobSourceCancelInput, JobSourceGetInput, JobSourcePort } from '../jobs/registry.ts';
import { ApiError } from '../errors.ts';
import type { AnswerRecord, TurnRecord } from './types.ts';
import { answerViewOf } from './view.ts';

export interface AnswerJobSourceDeps {
  /** 按作业 id 取轮次 + 回答（**带主体**：越权与不存在同形返回 `null`）。 */
  findByJobId(input: { userId: string; jobId: string }): Promise<{ turn: TurnRecord; answer: AnswerRecord | null } | null>;
  /**
   * GY-R71 取消片：取消答案作业（**只读复用**会话域既有的 `cancelTurn`：状态机、`If-Match`、
   * 幂等台账、终态语义全在域内，本层不判状态、不改 revision）。
   * 不存在/越权 ⇒ `null`（⇒ 注册表回同形 404）；其余错误（`REVISION_CONFLICT`/
   * `OBJECT_UNAVAILABLE`/`IDEMPOTENCY_*`/`REQUEST_IN_PROGRESS`）**原样透出**。
   */
  cancelJob(input: {
    userId: string;
    jobId: string;
    ifMatch: unknown;
    idempotencyKey: unknown;
  }): Promise<ContractJob | null>;
}

/**
 * 该轮次的作业快照是否**允许**携带结果（与 `jobs/registry.ts` 的如实性不变式同口径：
 * `result !== null ⇒ state ∈ {succeeded, uncertain}`，且 `succeeded ⇒ error_code === null`）。
 */
function resultAllowed(state: TurnRecord['job_state']): boolean {
  return state === 'succeeded' || state === 'uncertain';
}

/**
 * 把轮次的作业快照投影成契约 `Job`（九键，`additionalProperties:false`）。
 *
 * 如实性硬边界：`result` **只在状态允许且回答行确实存在**时给出；状态是
 * `failed` / `timed_out` / `cancelled` / `queued` / `running` 时一律 `null`
 * ——即便回答行还在（例如删除竞态），也绝不把"有回答"报告成"作业成功"。
 * 投影出的对象随后由 `registry.assertContractJob` 逐键复核（违规统一折叠为 503）。
 */
export function projectTurnJob(turn: TurnRecord, answer: AnswerRecord | null): ContractJob {
  const withResult = answer !== null && resultAllowed(turn.job_state);
  return {
    id: turn.job_id,
    revision: turn.revision,
    kind: 'answer',
    target_ref: { type: 'answer', id: turn.id, revision: answer === null ? 1 : answer.revision }, // 目标版本 = 回答行自己的版本（answer 行不可修订，恒 1）；未产出时取记录初始版本 1，绝不跟作业 revision 走
    state: turn.job_state,
    deadline_at: turn.job_deadline_at.toISOString(),
    created_at: turn.job_created_at.toISOString(),
    error_code: turn.job_error_code === null ? null : (turn.job_error_code as ContractJob['error_code']),
    result: withResult && answer !== null ? { kind: 'answer', value: answerViewOf(answer) } : null,
  };
}

/** 建 `answer` 作业源（注册进 `jobs/registry.ts` 的源数组，与其它五个源并列）。 */
export function createAnswerJobSource(deps: AnswerJobSourceDeps): JobSourcePort {
  return {
    kind: 'answer',
    async get(input: JobSourceGetInput): Promise<unknown | null> {
      const found = await deps.findByJobId(input);
      if (found === null) return null;
      return projectTurnJob(found.turn, found.answer);
    },
    async cancel(input: JobSourceCancelInput): Promise<unknown | null> {
      try {
        return await deps.cancelJob({
          userId: input.userId,
          jobId: input.jobId,
          ifMatch: input.ifMatch,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        // 域内「不存在**或**越权」一律 `NOT_FOUND`（问答域既有口径）⇒ 适配层把它映射成 `null`，
        // 由注册表统一回**同形 404**（文案 `作业不存在`）。不映射会让问答域的 `资源不存在` 从本源漏出，
        // 破坏跨 kind 的文案同形（`tests/unit/gy-i22-message-parity.test.mjs` 钉住的就是这一条）。
        if (error instanceof ApiError && error.code === 'NOT_FOUND') return null;
        throw error;
      }
    },
  };
}
