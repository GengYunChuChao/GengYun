/**
 * GY-I16（#16）· **引用可用性端口**（收藏／历史两个子域的 `reference_state` 唯一来源）。
 *
 * ## 契约语义：`ReferenceState` 是"目标当前对该主体可得"的**逐次派生**结论
 * 闭集只有 `available|unavailable` 两值（`packages/contracts/states.json`）：
 *   - `available`：目标**当前**存在、未下架/未删除、且对**当前用户**可见 ⇒ 可以跳转；
 *   - `unavailable`：其余一切（版本已替换、来源失效、被隐藏/删除、无权限、未接线、读取失败）
 *     ⇒ 统一 `unavailable`，**不区分"已隐藏"与"不存在"**。
 *
 * ## 三条硬边界（与 `services/api/src/messages/reference.ts` 同口径，独立实现）
 *
 * 1. **不泄露内容／存在性**：端口只回答闭集取值。收藏与历史记录本身**不存目标正文**
 *    （契约 `Favorite`／`History` 都没有这类型字段），因此唯一可能泄露的通道是"取值可区分
 *    存在性"——所以所有**对象侧**原因折叠成**同一条**非披露说明
 *    （`OBJECT_UNAVAILABLE_REASON`），不回传"存在但无权"之类的可区分信号。
 * 2. **fail-closed**：未接线（`unwired`）、端口抛错、返回非 `'available'` 的一切
 *    ⇒ 一律 `unavailable`。"取不到状态"绝不假装可用，也绝不回退替身。
 * 3. **逐次重查**：`stateOf` 每次读取都调用（列表／详情／幂等重放都重新派生），**不缓存结果**。
 *    这是 issue #16「列表／详情／收藏／消息在**读取时重查**对象权限与当前可见性；
 *    隐藏／失效／注销不因缓存或旧链接重新公开」的服务端落点。
 *
 * `unavailable_reason`（契约 `Favorite.unavailable_reason`，1..80 字符或 null）只能取本文件
 * 冻结闭集 `REFERENCE_UNAVAILABLE_REASONS` 中的一个；**任何其它值一律折叠为对象侧那条**，
 * 因此端口／存储里混进自由文本也不会进入响应（避免把内部原因改名后外泄）。
 */
import { isReferenceState, type ReferenceState, type TargetRef } from './types.ts';

/**
 * `Favorite.unavailable_reason` 的**冻结闭集**（非披露）。
 *
 * 只有三条，且前两条描述的是**端口自身的接线/读取状态**（与具体对象无关，因此不泄露存在性）；
 * 对象侧的一切原因（下架／失效／隐藏／删除／无权／版本替换／地域限制）合并为同一条。
 */
export const REFERENCE_UNAVAILABLE_REASONS = [
  /** 对象侧一切原因的统一描述（**不得**细分为"已隐藏"或"不存在"）。 */
  '目标已下架、已失效、已隐藏、已删除或不属于当前账号',
  /** 端口未接线（与对象无关）。 */
  '目标可用性读取通道尚未接线，无法核对',
  /** 端口读取失败（与对象无关）。 */
  '目标可用性读取失败，已按不可用处理',
] as const;

export type ReferenceUnavailableReason = (typeof REFERENCE_UNAVAILABLE_REASONS)[number];

export const OBJECT_UNAVAILABLE_REASON: ReferenceUnavailableReason = REFERENCE_UNAVAILABLE_REASONS[0];
export const UNWIRED_UNAVAILABLE_REASON: ReferenceUnavailableReason = REFERENCE_UNAVAILABLE_REASONS[1];
export const READ_FAILED_UNAVAILABLE_REASON: ReferenceUnavailableReason = REFERENCE_UNAVAILABLE_REASONS[2];

const REASON_SET: ReadonlySet<string> = new Set<string>(REFERENCE_UNAVAILABLE_REASONS);

/** 说明是否属于冻结闭集（自由文本一律不采信）。 */
export function isReferenceUnavailableReason(value: unknown): value is ReferenceUnavailableReason {
  return typeof value === 'string' && REASON_SET.has(value);
}

/**
 * 折叠任意实现返回的值为闭集判定。
 * 只有**恰好** `'available'`（或 `{ state: 'available' }`）算可用；其余一律不可用
 * （`null`／`undefined`／`true`／任意对象／抛错都不是正证据）。
 */
export function foldVisibilityResult(value: unknown): ReferenceState {
  if (value === 'available') return 'available';
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const state = (value as { state?: unknown }).state;
    if (isReferenceState(state) && state === 'available') return 'available';
  }
  return 'unavailable';
}

export interface VisibilityProbeInput {
  /** 目标引用（契约 `TargetRef`，三字段齐备）。 */
  target_ref: TargetRef;
  /** 当前主体：端口必须回答"**该用户**现在能不能读"，而不是"目标是否存在"。 */
  userId: string;
}

/** 一次派生的判定结果（不必入库；每次读取重新算）。 */
export interface VisibilityVerdict {
  state: ReferenceState;
  /** `state === 'available'` 时必须为 `null`；否则必为闭集内的一条说明。 */
  reason: ReferenceUnavailableReason | null;
}

/**
 * 引用可用性端口。
 *
 * `available` 是端口的**接线状态**（是否具备真实读取能力），与单次 `stateOf` 的返回值分开表达：
 * 未接线端口 `available:false`，服务层即使拿到 `stateOf` 的 `available` 也会因接线状态为假而
 * 折叠为 `unavailable`（冗余的第二道 fail-closed）。
 */
export interface VisibilityPort {
  readonly kind: 'wired' | 'unwired';
  readonly note: string;
  readonly available: boolean;
  readonly unavailableReason: ReferenceUnavailableReason;
  stateOf(input: VisibilityProbeInput): Promise<VisibilityVerdict>;
}

/**
 * 未接线端口（**不是生产默认**：生产默认已于 #167 接线 —— 装配点 `services/api/src/app.ts` 的
 * `defaultVisibility = createWiredVisibilityPort({...})`，可用性按 `/knowledge` 公开读面
 * **每次读取重新派生**；本工厂保留为**合法的 fail-closed 端口**，供测试注入与对照使用）。
 *
 * 一律 `unavailable` + 未接线说明：**不得**返回 `'available'` 来"默认可用"。
 * 真实接线已由 #167 部分交付：`species`/`herbicide`/`scheme` 经公开读面逐次核验；
 * **识别/OCR/媒体的当前可见性核验仍未接线**（非收藏闭集目标恒 `unavailable`）。
 * 服务层与用例无需改动。
 */
export function createUnwiredVisibilityPort(
  reason: ReferenceUnavailableReason = UNWIRED_UNAVAILABLE_REASON,
  note = '引用可用性端口尚未接线：一律不可用（fail-closed，不假装可用、不回退替身）',
): VisibilityPort {
  const settled: VisibilityVerdict = { state: 'unavailable', reason };
  return {
    kind: 'unwired',
    note: `${note}（一律 unavailable；不泄露目标内容或存在性）`,
    available: false,
    unavailableReason: reason,
    async stateOf() {
      return settled;
    },
  };
}

export interface WiredVisibilityPortOptions {
  /**
   * 目标核验实现。**只允许**返回 `'available'` 或 `{ state: 'available' }` 表示可用；
   * 返回其它任何值或抛错都会被折叠为 `unavailable` + 对象侧统一说明。
   */
  resolve(input: VisibilityProbeInput): Promise<unknown>;
  note?: string;
}

/**
 * 已接线端口：把任意实现规范化为契约闭集判定。
 *
 * **刻意不把异常抛给上层**：读不到状态属于"不可用"，不是 500，也不能变成"默认可用"。
 * 原始异常不外传、不入响应，避免把目标侧细节带进收藏／历史响应。
 */
export function createWiredVisibilityPort(options: WiredVisibilityPortOptions): VisibilityPort {
  return {
    kind: 'wired',
    note: options.note ?? '引用可用性端口已接线：逐次核验目标当前对主体的可用性（只返回契约闭集判定）',
    available: true,
    unavailableReason: OBJECT_UNAVAILABLE_REASON,
    async stateOf(input) {
      try {
        const value = await options.resolve(input);
        return foldVisibilityResult(value) === 'available'
          ? { state: 'available', reason: null }
          : { state: 'unavailable', reason: OBJECT_UNAVAILABLE_REASON };
      } catch {
        // 取不到状态 ⇒ 保守不可用（不向上抛、不泄露原因细节）。
        return { state: 'unavailable', reason: READ_FAILED_UNAVAILABLE_REASON };
      }
    },
  };
}

/**
 * 服务层派生入口：把端口接线状态与单次判定叠成最终闭集结论。
 *
 * 三道保守取值（任一命中即 `unavailable`）：
 *   1. 端口声明 `available !== true`（未接线）⇒ 用端口自己的说明；
 *   2. `stateOf` 返回非闭集取值／非对象 ⇒ 折叠为对象侧统一说明（第二道 fail-closed）；
 *   3. 判定为 `unavailable` 但说明不在冻结闭集内 ⇒ 折叠为对象侧统一说明。
 *
 * `available` 时 `reason` 恒为 `null` —— 契约 `Favorite.unavailable_reason` 只描述不可用。
 */
export async function deriveVisibility(
  port: VisibilityPort,
  input: VisibilityProbeInput,
): Promise<VisibilityVerdict> {
  if (port.available !== true) return { state: 'unavailable', reason: port.unavailableReason };
  const raw = await port.stateOf(input);
  const verdict: unknown = raw;
  if (typeof verdict !== 'object' || verdict === null || Array.isArray(verdict)) {
    return { state: 'unavailable', reason: OBJECT_UNAVAILABLE_REASON };
  }
  const { state, reason } = verdict as { state?: unknown; reason?: unknown };
  if (!isReferenceState(state)) return { state: 'unavailable', reason: OBJECT_UNAVAILABLE_REASON };
  if (state === 'available') return { state: 'available', reason: null };
  return {
    state: 'unavailable',
    reason: isReferenceUnavailableReason(reason) ? reason : OBJECT_UNAVAILABLE_REASON,
  };
}
