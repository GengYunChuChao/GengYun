/**
 * GY-I12（#12）· `answer` 作业源（跨 kind 读面 `GET /jobs/{id}` 的第六个源）。
 *
 * 为什么必须有它：契约 `createTurn` 返回 **202 `JobEnvelope`**（`kind: 'answer'`），
 * 而 `kind: 'answer'` 早已在 `jobs/registry.ts` 的 `JOB_KINDS` 闭集里、`AnswerResult` 也早已
 * 在 `JobResult.oneOf` 里 —— 但注册表里**没有任何源**，因此该 202 作业在跨 kind 读面上永远
 * `NOT_FOUND`。本文件补上这个源（**只追加一个源，不发明新状态、不改注册表**）。
 *
 * 作业状态的唯一事实源是**轮次行上的作业快照**（迁移 0013 的 `job_state` /
 * `job_error_code` / `job_deadline_at` / `job_created_at`）—— 它是受理时写下、之后只在真发生
 * 跃迁时被 CAS 更新的值，**不是**读的时候重新估算出来的。因此：
 *   - `get` 只做投影，不做状态推断（`registry.assertContractJob` 会逐键复核，
 *     并把违规统一折叠为 503 `PROVIDER_UNAVAILABLE`，见其「端口回传不可信 ⇒ fail-closed」）；
 *   - 越权与不存在一律 `null`（与注册表口径一致：调用方不得据此区分二者）；
 *   - **不提供 `cancel`**：本片没有取消答案生成的实现，缺 `cancel` 会让注册表先确认作业存在、
 *     再如实 503「该能力尚未提供取消」——**不伪造 `cancelled`、不用 404 谎称不存在**。
 *
 * 如实性：`result` 只在该轮次确实已有回答（`state ∈ {succeeded, uncertain}` 且回答行存在）时给出，
 * `{kind:'answer', value: Answer}`。本片产出的每个 `Answer` 的 `model_version`/`prompt_version`
 * 都带 `unimplemented:no-real-` 前缀（「未接真实模型」的机器可判据标记，红线②）——
 * 替身结果**永远**带着这个标记，不可能被读成真实模型结果。
 */
import type { ContractJob, JobSourceGetInput, JobSourcePort } from '../jobs/registry.ts';
import type { AnswerRecord, TurnRecord } from './types.ts';
import { answerViewOf } from './view.ts';

export interface AnswerJobSourceDeps {
  /** 按作业 id 取轮次 + 回答（**带主体**：越权与不存在同形返回 `null`）。 */
  findByJobId(input: { userId: string; jobId: string }): Promise<{ turn: TurnRecord; answer: AnswerRecord | null } | null>;
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
    target_ref: { type: 'answer', id: turn.id, revision: turn.revision },
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
  };
}
