/**
 * GY-I16（#16）· 收藏子域契约类型。
 *
 * 只读消费 `packages/contracts/openapi.json`（契约 1.0.0，`x-proposal-revision=2`）；本片不改契约。
 *
 * 逐项核对（2026-10-14，基线 `upstream/main = fcfa6de`）：
 *   - `FavoriteTarget`：`additionalProperties:false`，required 恰为 `type`/`id`/`revision`；
 *     `type` 闭集 **3 项** `species|herbicide|scheme`（**收藏只允许这三类目标**）；
 *     `id` 1..80；`revision` 整数 ≥1。
 *   - `FavoriteInput`：required 恰为 `target_ref`。
 *   - `Favorite`：required 恰为 6 项 `id`/`revision`/`target_ref`/`reference_state`/
 *     `unavailable_reason`/`created_at`。注意 `Favorite.target_ref` 是 **`TargetRef`（17 项闭集）**
 *     而不是 `FavoriteTarget`（3 项）——写入侧只接受 3 类，读出侧按 17 类 `TargetRef` 投影。
 *     `unavailable_reason` 为 `anyOf [string(1..80), null]`。
 *   - `FavoritePage`：`items`（`maxItems:50`）+ `next_cursor`（1..2048 或 null）。
 *   - 封套：`{data, meta}`（`FavoritePageEnvelope` / `FavoriteEnvelope`）。
 *
 * 「收藏不自动转成已使用事实」：契约里**没有**任何 favourite→usage 字段，本子域的存储也
 * **没有**任何"使用/已用"记录，也没有任何写历史的入口（见 `service.ts` 的不变式一节）。
 */
import type { ReferenceState, TargetRef } from '../targetref/types.ts';

/** openapi.json -> FavoriteTarget.type（3 项闭集，不得扩展）。 */
export const FAVORITE_TARGET_TYPES = ['species', 'herbicide', 'scheme'] as const;

export type FavoriteTargetType = (typeof FAVORITE_TARGET_TYPES)[number];

/** openapi.json -> FavoriteTarget（写入侧：只允许 3 类可收藏目标）。 */
export interface FavoriteTarget {
  type: FavoriteTargetType;
  id: string;
  revision: number;
}

/** openapi.json -> FavoriteInput。 */
export interface FavoriteInput {
  target_ref: FavoriteTarget;
}

/**
 * openapi.json -> Favorite（响应投影）。
 *
 * `reference_state` 与 `unavailable_reason` **逐次重查**派生，不入库（见 `targetref/visibility.ts`）。
 */
export interface Favorite {
  id: string;
  revision: number;
  target_ref: TargetRef;
  reference_state: ReferenceState;
  /** 闭集内的一条非披露说明；`reference_state === 'available'` 时恒为 `null`。 */
  unavailable_reason: string | null;
  created_at: string;
}

/** openapi.json -> FavoritePage。 */
export interface FavoritePage {
  items: Favorite[];
  next_cursor: string | null;
}

/**
 * 收藏接口的调用主体（契约 `security: userSession`）。
 *
 * 与 `services/api/src/messages/types.ts` 的 `MessagesActor` 同口径但**本片独立定义**：
 * 特征域互不 import（仓库既有分层）。
 */
export interface FavoritesActor {
  userId: string;
  role: 'user' | 'admin';
  authEpoch: number;
}

/** 闭集判定（先判 `typeof`，`undefined` 不会被 `includes` 放过）。 */
export function isFavoriteTargetType(value: unknown): value is FavoriteTargetType {
  return typeof value === 'string' && (FAVORITE_TARGET_TYPES as readonly string[]).includes(value);
}
