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
 *     `routes/history.ts` 的 `X-GY-Cascade` 非契约披露头与服务层返回值（内部字段，不进响应体）。
 *
 * ## `'partial'`（R33 裁定新增，`.pg17/ruling-r33-i16-history-cascade-partial-20261023.md`）
 * 语义**严格**限定为：
 *   历史行**已删除** ＋ **至少一项**关联对象（识别结果 / OCR 记录）**已删除** ＋ **未全部删除成功**。
 *
 * 因此它是一个**有下限**的取值，不是"尽力而为"的模糊说法：
 *   - 一项都没删成功（含 404/409/异常） ⇒ 仍是 `'failed'`，**不得**记 `'partial'`；
 *   - 端口未接线 ⇒ 仍是 `'unwired'`，**不得**改写成 `'partial'`；
 *   - 媒体对象与外发撤销**不在本片**（跨 `#6`/`#19`）⇒ 即使识别/OCR 那一条腿删成功，
 *     也**没有**"全部删除成功"这一档可用：默认生产装配（`app.ts` 的 `historyCascadePort`）
 *     因此只可能给出 `'partial' | 'failed'`；`'initiated'` 仍保留在闭集里供显式注入端口使用
 *     （测试／后续接入媒体腿的片），⛔ 但本片的默认装配**不得**声称 `'initiated'`。
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
 * 级联披露取值：只区分"已启动／部分已删／未接线／启动失败"，**不**声称完成。
 * 与 `history/store.ts` 的 `CascadeDisclosure` 同值（同一语义在存储侧与端口侧各有一处声明，
 * 二者结构上相等，可互相赋值）。
 *
 * `'partial'` 的语义见文件头（有下限：至少一项关联已删、但未全部删成功）。
 */
export const CASCADE_OUTCOMES = ['initiated', 'partial', 'unwired', 'failed'] as const;

export type CascadeOutcome = (typeof CASCADE_OUTCOMES)[number];

/** 闭集判定（先判 `typeof`，`undefined` 不会被 `includes` 放过）。 */
export function isCascadeOutcome(value: unknown): value is CascadeOutcome {
  return typeof value === 'string' && (CASCADE_OUTCOMES as readonly string[]).includes(value);
}

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
  /** 启动关联删除（不是完成）。返回闭集取值之一；非闭集取值一律折叠为 `'failed'`（保守，不臆造）。 */
  initiate(request: CascadeRequest): Promise<unknown>;
  note?: string;
}

/** 已接线端口能给出的取值：`'partial'` 是 R33 新档（有下限的部分完成），`'unwired'` 不属此列。 */
export type WiredCascadeOutcome = 'initiated' | 'partial' | 'failed';
/**
 * 已接线端口：把任意实现规范化为闭集 `'initiated' | 'partial' | 'failed'`。
 *
 * - 允许透传 `'partial'`（**必须**透传：否则"部分已删"会被静默改写成 `'failed'`，
 *   与 R33 裁定的语义下限相冲突）；
 * - 非闭集取值、`undefined`、以及抛错 ⇒ 一律 `'failed'`（**不**谎称已删除；也不因此回滚历史行的删除结果）。
 * - `'unwired'` **不会**由本端口产生（接线了就说接线了）；未接线用的是 `createUnwiredHistoryCascadePort`。
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
        // `'unwired'` 若由实现返回，说明实现自认未接线段 —— 但端口本身是 wired，
        // 直接透传会让披露自相矛盾；按"未启动任何删除"折叠为 `'failed'`（保守且不谎称已删）。
        last = value === 'initiated' || value === 'partial' ? value : 'failed';
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
