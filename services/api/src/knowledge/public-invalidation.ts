/**
 * GY-I07 本片 · **公开读的「引用失效」判定**（`Refs #7`；跨线 `Refs #18`）。
 *
 * ## 本片只做一件事
 * 把「一条资料在公开读面上**该不该可见**」收敛成**一个纯判定**：
 *
 * ```ts
 * const integrity = createReferenceIntegrity(store); // 既有的"读取时重算"解析器
 * decidePublicVisibility({ family: 'knowledge', content, resolve: integrity.resolve });
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
 * `resolve()` 由调用方注入（结构注入，不导入实现）⇒ 本模块是纯函数：同样输入同样输出，
 * 无副作用、无 I/O。
 *
 * ## 消费方与如实登记的未取得项（请勿读成"失效拦截已生效"）
 * - **消费方（实测，非承诺）**：`routes/knowledge.ts` 已 import 本模块的 `decidePublicVisibility`，
 *   并由该文件**唯一一处** `isPubliclyVisible(resolve, …)` 调用 ⇒ **两个详情面** `/knowledge/{id}`、
 *   `/herbicides/{id}`（不可用 ⇒ 与"不存在"同形 404）与**两个列表面** `/knowledge`、`/herbicides`
 *   （不可用 ⇒ **整条剔除**该行，`Refs #7` 接线）**共用这一处判定**，均在写响应头**之前**消费。
 *   装配点＝`services/api/src/app.ts` 的 `registerKnowledgeRoutes(...)` 调用处：
 *   该处把 `createReferenceIntegrity(adminContentStore).resolve` 作为 `resolve` 依赖注入
 *   （`routes/knowledge.ts` 的 `KnowledgeRouteDeps.resolve`；不传 ⇒ 不判定）。
 *   `routes/knowledge.ts` 调用本判定时传的 `family` 恒为 `'knowledge'`。
 * - 后台 store 为空时 `resolve()` 恒为 `unverifiable` ⇒ 生产默认行为**不变**（内容照旧可见）。
 *   如实登记的未取得项：`real` 模式下默认 store 是**空的内存实现**
 *   （`admin/store.ts#createAdminContentStore`：`persistent: false`，进程启动即空、无持久化），
 *   且**没有任何请求路径能往里写**（`services/api/src/app.ts` 的 `adminRealUnwired` 判定
 *   把 34 条后台路由一律 fail-closed 成 503 PROVIDER_UNAVAILABLE；`adminInjection?.contentStore`
 *   仅测试注入可用）。因此"引用不可用 ⇒ 隐藏"这一支在 `real` 模式下**尚无真实请求路径可达**，
 *   目前只由注入 store 的单元测试覆盖。
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

/** 既有解析器 `createReferenceIntegrity(store).resolve` 的结构类型（不导入实现）。 */
export type ReferenceResolver = (family: AdminFamily, content: unknown) => ReferenceResolution;

export interface PublicVisibilityQuery {
  readonly family: AdminFamily;
  /** 待判定的引用内容；判定只读 `source_id` / `source_version` 这两个既有字段。 */
  readonly content: unknown;
  /** 既有「读取时重算」解析器：`createReferenceIntegrity(store).resolve`。 */
  readonly resolve: ReferenceResolver;
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

/** 纯判定：给定既有 `resolve()` 与一条内容 ⇒ 公开读是否可见 + 原因。 */
export function decidePublicVisibility(query: PublicVisibilityQuery): PublicVisibilityDecision {
  const resolution = query.resolve(query.family, query.content);
  return Object.freeze({
    visible: VISIBLE_BY_STATE[resolution.state],
    reason: resolution.state,
  });
}
