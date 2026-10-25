/**
 * GY-I16（#16）· 历史子域契约类型。
 *
 * 只读消费 `packages/contracts/openapi.json`（契约 1.0.0）；本片不改契约。
 *
 * 逐项核对（2026-10-14，基线 `upstream/main = fcfa6de`）：
 *   - `History`：`additionalProperties:false`，required 恰为 7 项
 *     `id`/`revision`/`kind`/`target_ref`/`job_state`/`reference_state`/`created_at`。
 *     `kind` 闭集 **2 项** `recognition|ocr`；`job_state` 为 `JobState` 闭集 **7 项**；
 *     `target_ref` 为 `TargetRef`（17 项闭集）。
 *     **没有** `title`/`summary`/`candidates`/`selected_species_id`/`model_version`/`used`
 *     之类的字段 —— 所以"候选与人工选择分开""OCR 核对""来源版本"必须在**详情**页由
 *     `GET /recognitions/{id}`、`GET /ocr/{id}` 提供（`#9`／`#10` 已合并的契约面），
 *     历史域**不复制**这些字段，也**不自造** `GET /history/{id}` 这种契约外路径。
 *   - `HistoryPage`：`items`（`maxItems:50`）+ `next_cursor`（1..2048 或 null）。
 *   - 封套：`HistoryPageEnvelope` / `AckEnvelope`（`DELETE /history/{id}`）。
 *
 * 「识别或收藏不自动转成"已使用"事实」：契约 `History` 里**没有**任何 usage/used 字段，
 * 本子域的存储也没有；`appendHistory` 只记"有过这么一次任务"，它不是"已使用"的声明
 * （见 `service.ts` 的不变式一节）。
 */
import type { ReferenceState, TargetRef } from '../targetref/types.ts';

/** openapi.json -> History.kind（2 项闭集，不得扩展）。 */
export const HISTORY_KINDS = ['recognition', 'ocr'] as const;

export type HistoryKind = (typeof HISTORY_KINDS)[number];

/** openapi.json -> JobState（7 项闭集；与 `packages/contracts/states.json` 同值）。 */
export const JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'uncertain',
  'failed',
  'timed_out',
  'cancelled',
] as const;

export type JobState = (typeof JOB_STATES)[number];

/** openapi.json -> History（响应投影）。 */
export interface History {
  id: string;
  revision: number;
  kind: HistoryKind;
  target_ref: TargetRef;
  /** 任务状态：**失败/超时/取消原样可见**，绝不被折叠成"成功"或被隐藏。 */
  job_state: JobState;
  /** 目标当前对该用户是否可得：逐次重查派生，不入库。 */
  reference_state: ReferenceState;
  created_at: string;
}

/** openapi.json -> HistoryPage。 */
export interface HistoryPage {
  items: History[];
  next_cursor: string | null;
}

/** 历史接口的调用主体（契约 `security: userSession`）。 */
export interface HistoryActor {
  userId: string;
  role: 'user' | 'admin';
  authEpoch: number;
}

/**
 * **内部创建口**入参（**不是**契约 operationId，也不注册任何路由）。
 *
 * `job_id` 是**内部字段**（不出契约）：读取时用它向已合并的
 * `recognitionService.getJob` / `ocrService.getJob` 逐次核对任务当前状态与归属。
 * 出参里的 `appended` 表示本次是否真的新建（去重命中即 `false`）。
 */
export interface AppendHistoryInput {
  owner_id: string;
  kind: HistoryKind;
  target_ref: TargetRef;
  job_id: string;
  job_state: JobState;
  /** 去重键（内部字段，不出契约）：同主体同去重键只存在一条历史行。 */
  event_key: string;
}

/** 闭集判定（先判 `typeof`，`undefined` 不会被 `includes` 放过）。 */
export function isHistoryKind(value: unknown): value is HistoryKind {
  return typeof value === 'string' && (HISTORY_KINDS as readonly string[]).includes(value);
}

/** 闭集判定。 */
export function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value);
}

/** 终态（`states.json` 的 `job_transitions`：这 5 个状态没有后继）。 */
export const TERMINAL_JOB_STATES = ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'] as const;

/**
 * 「失败状态真实可见」的判定：凡是**未成功**的终态都必须原样展示，不得被折叠或隐藏。
 * 供页面/测试断言使用（纯函数）。
 */
export function isFailureJobState(state: JobState): boolean {
  return state === 'uncertain' || state === 'failed' || state === 'timed_out' || state === 'cancelled';
}
