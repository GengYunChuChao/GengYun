/**
 * GY-I07 本片 · **公开读的「引用失效」判定**（`Refs #7`；跨线 `Refs #18`）。
 *
 * ## 本片只做一件事
 * 把「一条资料在公开读面上**该不该可见**」收敛成**一个纯判定**（同步版 / 异步孪生共享同一映射）：
 *
 * ```ts
 * const integrity = createAsyncReferenceIntegrity(store); // 既有的"读取时重算"解析器
 * await decidePublicVisibilityAsync({ family: 'knowledge', content, resolve: integrity.resolve });
 * // → { visible: false, reason: 'unavailable' }
 * ```
 *
 * ## 口径：**不新造语义**，只是把既有判定原样表述一遍
 * 语义的唯一来源是 `admin/reference-integrity.ts` 的 `resolve()`（读取时重算，只读
 * `source_id` / `source_version`）以及 `admin/public-view.ts#visiblePublished` 的既有过滤：
 *
 * | `resolve()` 结论 | 公开面 | 理由 |
 * |---|---|---|
 * | `available` | 可见（`visible:true`） | 引用到来源**当前生效**的版本 |
 * | `unavailable` | **隐藏**（`visible:false`） | 来源已撤回／未发布／版本不一致／引用行写坏 —— 与「不存在」同形 |
 * | `unverifiable` | **保持可见**（`visible:true`） | 来源不在本存储里（未接真实库）核不到 ⇒ **不得谎称失效** |
 *
 * 因此本模块**不**自己读存储、**不**缓存结论、**不**发明实体 id 命名空间
 * （判定只看既有的 `content.source_id` / `content.source_version`），也**不**碰路由与响应投影。
 * `resolve()` 由调用方注入（结构注入，不导入实现）⇒ 本模块无副作用、无 I/O：同样输入同样输出。
 * **#18（迁移 0036）后的形状**：解析器可能是**异步**的（真实落点要库往返）。因此提供**两个入口**，
 * 共用同一张 `VISIBLE_BY_STATE` 映射：`decidePublicVisibility`（同步解析器，内存 store 的既有
 * 形态，签名与语义逐字未变）与 `decidePublicVisibilityAsync`（可 await 库往返）。
 * 路由一律用异步孪生；同步入口保留给既有同步判定的调用方与测试钉。
 *
 * ## 消费方与如实登记的未取得项（请勿读成"失效拦截已生效"）
 * - **消费方（实测，非承诺）**：`routes/knowledge.ts` 已 import 本模块的 `decidePublicVisibilityAsync`，
 *   并由该文件**唯一一处** `isPubliclyVisible(resolve, …)` 调用 ⇒ **两个详情面** `/knowledge/{id}`、
 *   `/herbicides/{id}`（不可用 ⇒ 与"不存在"同形 404）与**两个列表面** `/knowledge`、`/herbicides`
 *   （不可用 ⇒ **整条剔除**该行，`Refs #7` 接线）**共用这一处判定**，均在写响应头**之前**消费。
 *   装配点＝`services/api/src/app.ts` 的 `registerKnowledgeRoutes(...)` 调用处：
 *   该处把 `createAsyncReferenceIntegrity(adminContentStore).resolve` 作为 `resolve` 依赖注入
 *   （`routes/knowledge.ts` 的 `KnowledgeRouteDeps.resolve`；不传 ⇒ 不判定）。
 *   `routes/knowledge.ts` 调用本判定时传的 `family` 恒为 `'knowledge'`。
 * - 后台 store 为空时 `resolve()` 恒为 `unverifiable` ⇒ 生产默认行为**不变**（内容照旧可见）。
 *   如实登记的口径（#18 已推进）：内容域**已接真实落点**——`real` + 有池时
 *   `admin/store-pg` 走迁移 0036 的 `public.admin_content_{entities,revisions,idempotency}`，
 *   后台写入路径（24 条内容操作）随之可达，"引用不可用 ⇒ 隐藏"这一支在那种部署下**有真实
 *   请求路径**（单元测试 + `tests/integration/admin-content-pg.mjs` 的真库臂共同覆盖）。
 *   `real` 且**无池**时 store 仍是空的内存实现（`admin/store.ts#createAdminContentStore`：
 *   `persistent: false`），且 25 条后台路由逐条 fail-closed 503 ⇒ 那时该支仍不可达。
 */
import type { AdminFamily } from '../admin/types.ts';
import type { ReferenceResolution, ReferenceState } from '../admin/reference-integrity.ts';

/** 公开读结论的原因：直接复用既有三态，本模块不新增取值。 */
export type PublicVisibilityReason = ReferenceState;

export interface PublicVisibilityDecision {
  /** 公开读是否可见：`unavailable` ⇒ `false`；`available` / `unverifiable` ⇒ `true`。 */
  readonly visible: boolean;
  readonly reason: PublicVisibilityReason;
}

/**
 * 既有解析器的结构类型（不导入实现）。返回值允许是 Promise：迁移 0036 之后真实落点下
 * `getEntity` 是库往返（`createAsyncReferenceIntegrity`），内存实现仍同步返回。
 */
export type ReferenceResolver = (
  family: AdminFamily,
  content: unknown,
) => ReferenceResolution | Promise<ReferenceResolution>;

export interface PublicVisibilityQuery {
  readonly family: AdminFamily;
  /** 待判定的引用内容；判定只读 `source_id` / `source_version` 这两个既有字段。 */
  readonly content: unknown;
  /** 既有「读取时重算」解析器：`createAsyncReferenceIntegrity(store).resolve`。 */
  readonly resolve: ReferenceResolver;
}

/** 同步解析器（内存 store 形态）。 */
export type SyncReferenceResolver = (
  family: AdminFamily,
  content: unknown,
) => ReferenceResolution;

/** `decidePublicVisibility` 的入参：解析器**必须同步**（库往返请用异步孪生）。 */
export interface SyncVisibilityQuery {
  readonly family: AdminFamily;
  readonly content: unknown;
  readonly resolve: SyncReferenceResolver;
}

/**
 * 唯一一处"结论 → 可见性"映射。写成穷举表而不是 `state !== 'unavailable'`：
 * 将来 `ReferenceState` 增删取值时 tsc 会在**编译期**报错，逼这里显式表态，
 * 而不是把新状态悄悄当成"可见"。
 */
const VISIBLE_BY_STATE: Record<ReferenceState, boolean> = Object.freeze({
  available: true,
  unavailable: false,
  // 核不到 **不**等于失效：保持既有可见性，不谎称失效。
  unverifiable: true,
});

/** 同步版与异步版的**唯一**映射实现（两个入口都调它，不存在第二套口径）。 */
function decisionOf(resolution: ReferenceResolution): PublicVisibilityDecision {
  return Object.freeze({
    visible: VISIBLE_BY_STATE[resolution.state],
    reason: resolution.state,
  });
}

/** 判定：给定**同步**解析器与一条内容 ⇒ 公开读是否可见 + 原因（内存 store 的既有形态）。 */
export function decidePublicVisibility(query: SyncVisibilityQuery): PublicVisibilityDecision {
  return decisionOf(query.resolve(query.family, query.content));
}

/**
 * 判定（**异步**孪生）：解析器可以返回 Promise —— 迁移 0036 之后真实落点下 `getEntity`
 * 是库往返（`createAsyncReferenceIntegrity`）。映射逻辑与同步版**共用**
 * `VISIBLE_BY_STATE`，不存在第二套口径。
 */
export async function decidePublicVisibilityAsync(
  query: PublicVisibilityQuery,
): Promise<PublicVisibilityDecision> {
  return decisionOf(await query.resolve(query.family, query.content));
}
