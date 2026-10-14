/**
 * GY-I16（#16）· **关联数据级联删除端口**（契约 `deleteHistory` 描述的服务端义务）。
 *
 * 契约对 `DELETE /history/{id}` 的描述逐字为：
 * 「同时启动关联识别/OCR私有结果/媒体和外发删除；共享引用核对后处理。」
 *
 * 本片能自己完成的只有**历史行本身**（归属 + CAS + 幂等 + 物理删除）。
 * "关联识别/OCR 私有结果、媒体、外发删除"落在 `recognitions/**`、`ocr/**`、`media/**`、
 * `packages/privacy/**` 的删除链路上：**属跨线**，本片不改他人已合并实现，也不另起第二套删除机制
 * （按仓库口径，完整 7/30 日删除与共享引用核对属 GY-I19）。
 *
 * 因此本片只交付**端口 + 披露**：
 *   - `initiate(...)` 由装配层接线后**启动**（不是"完成"）关联删除；
 *   - 未接线时端口 `available === false`，服务层**照常删除历史行**（用户"删除自己的记录"
 *     这一隐私权利不得被未接线的内部端口阻塞），并且**不谎称**级联已完成 —— 见
 *     `routes/history.ts` 的 `X-GY-Cascade` 非契约披露头与服务层返回值
 *     `cascade: 'initiated' | 'unwired'`（内部字段，不进响应体）。
 */
import type { TargetRef } from '../targetref/types.ts';
import { isHistoryKind, type HistoryKind, type JobState } from './types.ts';

export interface CascadeRequest {
  userId: string;
  historyId: string;
  kind: HistoryKind;
  target_ref: TargetRef;
  jobId: string;
  jobState: JobState;
}

/**
 * 级联披露取值：只区分"已启动／未接线／启动失败"，**不**声称完成。
 * 与 `history/store.ts` 的 `CascadeDisclosure` 同值（同一语义在存储侧与端口侧各有一处声明，
 * 二者结构上相等，可互相赋值）。
 */
export type CascadeOutcome = 'initiated' | 'unwired' | 'failed';

export interface HistoryCascadePort {
  readonly kind: 'wired' | 'unwired';
  readonly note: string;
  readonly available: boolean;
  initiate(request: CascadeRequest): Promise<CascadeOutcome>;
}

/**
 * 未接线端口（**生产默认**）：如实返回 `'unwired'`。
 * **不得**把"没做"说成 `'initiated'`，也不得因此拒绝删除历史行。
 */
export function createUnwiredHistoryCascadePort(
  note = '关联识别/OCR 私有结果、媒体与外发删除尚未接线（属 GY-I19／跨线）：只删除历史行本身',
): HistoryCascadePort {
  return {
    kind: 'unwired',
    note,
    available: false,
    async initiate() {
      return 'unwired';
    },
  };
}

export interface WiredHistoryCascadePortOptions {
  /** 启动关联删除（不是完成）。返回 `'initiated'`；抛错由端口折叠为 `'wired_failed'` 之外的保守值。 */
  initiate(request: CascadeRequest): Promise<unknown>;
  note?: string;
}

export type CascadeFailureOutcome = 'initiated' | 'failed';
export type WiredCascadeOutcome = CascadeFailureOutcome;
/**
 * 已接线端口：把任意实现规范化为 `'initiated' | 'failed'`。
 * 抛错 ⇒ `'failed'`（**不**谎称已启动；也不因此回滚历史行的删除结果）。
 */
export function createWiredHistoryCascadePort(
  options: WiredHistoryCascadePortOptions,
): HistoryCascadePort & { lastOutcome(): WiredCascadeOutcome | null } {
  let last: WiredCascadeOutcome | null = null;
  return {
    kind: 'wired',
    note: options.note ?? '关联删除端口已接线：只启动（不声称完成）关联识别/OCR/媒体/外发删除',
    available: true,
    async initiate(request) {
      try {
        const value = await options.initiate(request);
        last = value === 'initiated' ? 'initiated' : 'failed';
      } catch {
        last = 'failed';
      }
      return last;
    },
    lastOutcome() {
      return last;
    },
  };
}

/** 端口入参的形状校验（内部口调用方可能传错；错误即抛，不静默折叠）。 */
export function assertCascadeRequest(value: unknown): asserts value is CascadeRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('级联删除请求必须是对象');
  }
  const request = value as Record<string, unknown>;
  if (typeof request['userId'] !== 'string' || request['userId'] === '') throw new Error('级联删除请求缺少 userId');
  if (typeof request['historyId'] !== 'string' || request['historyId'] === '') {
    throw new Error('级联删除请求缺少 historyId');
  }
  if (!isHistoryKind(request['kind'])) throw new Error('级联删除请求 kind 非闭集取值');
  if (typeof request['jobId'] !== 'string' || request['jobId'] === '') throw new Error('级联删除请求缺少 jobId');
}
