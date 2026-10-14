/**
 * GY-I16（#16）· 目标引用与引用可用性的**共享契约常量**（收藏／历史两个子域共用）。
 *
 * 只读消费 `packages/contracts/openapi.json`（契约 1.0.0）与 `packages/contracts/states.json`；
 * 本片**不改契约**、不新增字段、不新增错误码、不新增契约外路径。
 *
 * 逐项核对（2026-10-14，基线 `upstream/main = fcfa6de`）：
 *   - `TargetRef`：`additionalProperties:false`，required 恰为 `type`/`id`/`revision`；
 *     `type` 闭集 **16 项**；`id` 1..80；`revision` 整数 ≥1。
 *   - `ReferenceState`：闭集 `available|unavailable`（与 `states.json` 的
 *     `states.ReferenceState` 同值）。
 *
 * 与 `services/api/src/messages/types.ts` 的关系：那边是**独立实现**（#17 已合并，不互相 import
 * 的仓库既有分层）。本片把 `TargetRef`／`ReferenceState` 收成**本片（GY-I16）内部共享**的一份，
 * 供收藏与历史两个子域复用，避免同一片里出现第三、第四份逐字拷贝。
 */

/** openapi.json -> TargetRef.type（16 项闭集，不得扩展）。 */
export const TARGET_REF_TYPES = [
  'species',
  'herbicide',
  'scheme',
  'static_region',
  'recognition',
  'ocr',
  'transcription',
  'answer',
  'post',
  'comment',
  'conversation',
  'dose_card',
  'media',
  'synthesis',
  'job',
  'source',
] as const;

export type TargetRefType = (typeof TARGET_REF_TYPES)[number];

/** openapi.json -> TargetRef。 */
export interface TargetRef {
  type: TargetRefType;
  id: string;
  revision: number;
}

/** packages/contracts/states.json -> states.ReferenceState。 */
export const REFERENCE_STATES = ['available', 'unavailable'] as const;

export type ReferenceState = (typeof REFERENCE_STATES)[number];

/** 闭集判定（`undefined` 不会被 `includes` 悄悄放过：先判 `typeof`）。 */
export function isTargetRefType(value: unknown): value is TargetRefType {
  return typeof value === 'string' && (TARGET_REF_TYPES as readonly string[]).includes(value);
}

/** 闭集判定。 */
export function isReferenceState(value: unknown): value is ReferenceState {
  return typeof value === 'string' && (REFERENCE_STATES as readonly string[]).includes(value);
}
