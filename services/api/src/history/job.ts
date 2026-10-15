/**
 * GY-I16（#16）· **任务状态端口**（历史 `History.job_state` 的读取时核对面）。
 *
 * ## 为什么要有这个端口
 * 契约 `History.job_state` 是 `JobState` 闭集（**没有** `unknown` 取值），所以历史行必须记住
 * "最后一次已知状态"。但 issue #16 要求"**失败状态真实可见**"且读取时重查 —— 若只展示入库时
 * 的快照，就会出现"任务其实早已失败/超时，历史却一直显示排队中"的失真。
 *
 * 因此：**读取时**用本端口向**已合并的公开方法**核对当前状态
 * （`recognitionService.getJob({userId, jobId})`、`ocrService.getJob({userId, jobId})`）：
 *   - 端口已接线且返回闭集内取值 ⇒ **以实时值为准**；
 *   - 端口未接线 / 核不到（他人任务、任务不存在、读取失败）⇒ 退回**入库时记录的最后已知状态**；
 *   - 任何情况下**都不会凭空升级为 `succeeded`**：只有端口的实时取值或入库值本身是 `succeeded`
 *     才会呈现成功，且入库值在写入时已被闭集校验。
 *
 * 该端口**不做归属判定**（归属由历史行自己的 `owner_id` + 服务层负责；端口的"核不到"统一折叠为
 * `null`，不向响应暴露原因，避免用 `job_state` 泄露"存在但不是你的"）。
 */
import { isJobState, type HistoryKind, type JobState } from './types.ts';

export interface JobStateProbeInput {
  kind: HistoryKind;
  /** 内部作业标识（不出契约）。 */
  jobId: string;
  /** 当前主体（端口必须只回答"该用户的这个任务"）。 */
  userId: string;
}

/**
 * 任务状态端口。
 * `available` 是端口的**接线状态**；未接线端口一律返回 `null`（核不到），由服务层退回入库值。
 */
export interface HistoryJobPort {
  readonly kind: 'wired' | 'unwired';
  readonly note: string;
  readonly available: boolean;
  /** 返回 `JobState`（已规范化为闭集）或 `null`（核不到 —— 绝不用 `null` 冒充成功）。 */
  stateOf(input: JobStateProbeInput): Promise<JobState | null>;
}

/**
 * 未接线端口（**不是生产默认**）：一律 `null`。
 *
 * 缺省端口**早已接线** —— 装配点 `services/api/src/app.ts` 的
 * `historyJobPort = historyInjection?.job ?? createWiredHistoryJobPort({...})`，
 * 自 `1b0b3d6`(#144) 起接到 `recognitionService.getJob`／`ocrService.getJob`。
 * 本工厂保留为**合法的 fail-closed 端口**（`services/**` 内无调用，供测试夹具注入与对照使用）；
 * 服务层与用例无需改动。
 */
export function createUnwiredHistoryJobPort(
  note = '任务状态端口尚未接线：读取时退回历史行记录的最后已知状态（不外推、不伪造成成功）',
): HistoryJobPort {
  return {
    kind: 'unwired',
    note,
    available: false,
    async stateOf() {
      return null;
    },
  };
}

export interface WiredHistoryJobPortOptions {
  /**
   * 任务状态核验实现。允许返回 `JobState`、`{ state: JobState }`，或任意"核不到"的值
   * （`null`/`undefined`/抛错/非闭集取值）—— 后者一律折叠为 `null`。
   */
  resolve(input: JobStateProbeInput): Promise<unknown>;
  note?: string;
}

/** 已接线端口：把任意实现规范化为闭集取值或 `null`；异常不外传。 */
export function createWiredHistoryJobPort(options: WiredHistoryJobPortOptions): HistoryJobPort {
  return {
    kind: 'wired',
    note: options.note ?? '任务状态端口已接线：逐次核验任务当前状态（只返回契约闭集取值或"核不到"）',
    available: true,
    async stateOf(input) {
      try {
        const value = await options.resolve(input);
        if (isJobState(value)) return value;
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          const state = (value as { state?: unknown }).state;
          if (isJobState(state)) return state;
        }
        return null;
      } catch {
        // 核不到（含他人任务、任务不存在、读取失败）⇒ null，不向上抛、不泄露原因。
        return null;
      }
    },
  };
}

/**
 * 读取时派生最终 `job_state`：**实时值优先，核不到退回入库值**。
 *
 * 硬边界：只有当 `live` 是闭集内取值时才采信实时值；`null` 一律退回 `recorded`
 * （入库值在写入时已被闭集校验）。本函数**不会**产出闭集外的取值，也不会把 `null`
 * 折成 `succeeded`。
 */
export async function deriveJobState(
  port: HistoryJobPort,
  recorded: JobState,
  input: JobStateProbeInput,
): Promise<JobState> {
  if (port.available !== true) return recorded;
  const live = await port.stateOf(input);
  return isJobState(live) ? live : recorded;
}
