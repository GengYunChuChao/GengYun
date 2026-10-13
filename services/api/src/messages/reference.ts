/**
 * GY-I17（#17）阶段 1 · 消息跳转目标可用性端口（`Message.reference_state` 的唯一来源）。
 *
 * ## 契约语义（`ReferenceState`，闭集 `available|unavailable`）
 *
 * 契约只给两个取值，语义由 `packages/reference/records.mjs::deriveReferenceState` 与
 * `docs/architecture/state-contract.md` 确定：**它是"目标当前是否对该主体可得"的
 * 逐次派生结论，不是存下来的历史状态**——
 *   - `available`：目标**当前**存在、未下架/未删除、且对**当前用户**可见 ⇒ 可以跳转；
 *   - `unavailable`：除上以外的一切（版本已替换、来源失效、被隐藏/删除、无权限、
 *     未接线、读取失败）——统一 `unavailable`，**不区分"隐藏"与"不存在"**。
 *
 * ## 本片的三条硬边界
 *
 * 1. **不泄露内容/存在性**：端口只回答枚举，**不得**返回目标正文、标题、URL、用量或
 *    "存在但无权"之类的可区分信号。消息记录本身也**不存**目标正文（契约 `Message`
 *    没有这类字段），因此即使端口实现有 bug，也没有可泄露的正文通道；
 *    唯一可能泄露的通道是"取值可区分存在性"，所以本端口把一切非 `available`
 *    都折叠成同一个 `unavailable`。
 * 2. **fail-closed**：未接线（`unwired`）、端口抛错、返回非闭集取值、以及
 *    `target_ref === null`（没有可核验的目标）**一律 `unavailable`** ——
 *    "取不到状态"绝不假装可用，也不回退替身。
 * 3. **逐次重查**：`stateOf` 每次读取都调用（列表/详情/重放都重新派生），不缓存结果。
 */

import type { ReferenceState, TargetRef } from './types.ts';

export interface ReferenceProbeInput {
  /** 目标引用（契约 `TargetRef`，三字段齐备）。 */
  target_ref: TargetRef;
  /** 当前主体：端口必须回答"**该用户**现在能不能读"，而不是"目标是否存在"。 */
  userId: string;
}

/**
 * 目标可用性端口。
 *
 * `available`/`unavailableReason` 是端口的**接线状态**（是否有真实读取能力），
 * 与单次 `stateOf` 的返回值分开表达：未接线端口 `available:false`，
 * 服务层即使拿到 `stateOf` 的 `available` 也会因接线状态为假而折叠为 `unavailable`
 * （冗余的第二道 fail-closed，见 `service.ts::referenceStateFor`）。
 */
export interface MessageReferencePort {
  readonly kind: 'wired' | 'unwired';
  readonly note: string;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  stateOf(input: ReferenceProbeInput): Promise<ReferenceState>;
}

/**
 * 未接线端口（生产默认；本片**没有**接线任何目标读取实现）。
 *
 * 一律 `unavailable`：**不得**返回 `'available'` 来"默认可用"，
 * 也**不得**改成"查不到就是不可用"以外的任何臆测。真实接线（阶段 2：把
 * `post`/`comment`/`species`/`herbicide`/`conversation`/`job`… 的当前可见性核验接进来）
 * 只需替换本工厂，服务层与用例无需改动。
 */
export function createUnwiredReferencePort(
  reason = '目标读取端口尚未接线，无法核验跳转目标当前是否对所辖用户可用',
): MessageReferencePort {
  return {
    kind: 'unwired',
    note: `${reason}（fail-closed：一律 unavailable，不假装可用、不回退替身）`,
    available: false,
    unavailableReason: reason,
    async stateOf() {
      return 'unavailable';
    },
  };
}

export interface WiredReferencePortOptions {
  /**
   * 目标核验实现。**只允许**返回闭集取值 `available|unavailable`；
   * 返回其它任何值（含 `true`、对象、"unknown"）或抛错都会被折叠为 `unavailable`。
   */
  resolve(input: ReferenceProbeInput): Promise<unknown>;
  note?: string;
  /** 端口自身默认的不可用原因（逐次核验结果不因此改变，仅用于诊断说明）。 */
  unavailableReason?: string;
}

/**
 * 已接线端口：把任意实现**规范化**为契约闭集。
 *
 * 规范化规则（这就是 fail-closed 的落点）：
 *   - 恰好 `'available'` ⇒ `available`（唯一的正证据路径）；
 *   - 其余一切（`'unavailable'`、`null`、`undefined`、`true`、任意对象、抛错）⇒ `unavailable`。
 *
 * **刻意不把异常抛给上层**：端口读不到状态属于"不可用"，不是 500，也不能变成
 * "默认可用"。原始异常不外传、不入响应，避免把目标侧细节带回消息响应。
 */
export function createWiredReferencePort(options: WiredReferencePortOptions): MessageReferencePort {
  return {
    kind: 'wired',
    note: options.note ?? '目标读取端口已接线：逐次核验目标当前对主体的可用性（只返回契约闭集取值）',
    available: true,
    unavailableReason: options.unavailableReason ?? null,
    async stateOf(input) {
      try {
        const value = await options.resolve(input);
        return value === 'available' ? 'available' : 'unavailable';
      } catch {
        // 取不到状态 ⇒ 保守不可用（不泄露原因细节，不向上抛）。
        return 'unavailable';
      }
    },
  };
}
