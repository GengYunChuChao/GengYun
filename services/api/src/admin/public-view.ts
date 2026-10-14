/**
 * **服务层公开读口径**（GY-I18 阶段 1）。
 *
 * 这不是契约 operationId，也**没有**注册任何公开路由（本片不碰 `routes/**` / `app.ts`）。
 * 它的唯一用途是让「撤回是否真正退出公开视图」「发布后旧修订是否仍可追溯」这两条安全语义
 * **可被独立断言**——公开读的契约外壳（`SourceRef` / `Knowledge` 等）不在本片范围。
 *
 * 口径（与 `families.ts` 的生命周期映射严格一致）：
 * - 只读**当前生效的已发布修订**（`publishedRevision`），绝不读 head——
 *   发布后又编辑产生的草稿修订**不得**因为它在 head 上而泄露出去；
 * - `lifecycle === 'withdrawn'` ⇒ 不可见（`null`）；从未发布 ⇒ 不可见；
 * - 撤回不删除该修订：`lifecycle` 回到 `published` 后同一修订可再次可见。
 *
 * **本片新增：来源引用在读取时重算**（`reference-integrity.ts`）。
 * 依赖类资料（knowledge / registrations / restrictions）除了"自己已发布"之外，
 * 还必须**当前**引用到一条**当前生效**的来源版本，否则公开读一律 `null`：
 * - 来源被下架/改版后，**同一条请求**立即看不到该内容（判定是每次读取重算的纯函数，
 *   所以"缓存里还留着旧结论""旧链接还能打开"这两件事在结构上不可能发生）；
 * - `unverifiable`（来源不在本存储里，未接真实库无法核对）保持既有可见性，
 *   **不**谎称失效 —— 如实登记为未取得项。
 *
 * `traceableRevisions()` 是**溯源面**（不是公开读、没有路由、不被任何响应投影消费）：
 * 它刻意**不**按引用可用性过滤，因为"这条历史修订当时确实发布过"是审计事实。
 * 公开读的判定只看 `readPublished` / `isPubliclyVisible`。
 */
import { cloneDeep } from './immutable.ts';
import { ADMIN_FAMILIES } from './types.ts';
import type { AdminFamily, StoredEntity, StoredRevision } from './types.ts';
import type { AdminContentStore } from './store.ts';
import { createReferenceIntegrity } from './reference-integrity.ts';
import type { ReferenceResolution } from './reference-integrity.ts';

export interface PublicProjection {
  family: AdminFamily;
  id: string;
  revision: number;
  content: unknown;
  updated_at: string;
}

export interface AdminPublicView {
  /** 公开可见的已发布修订；不可见返回 null（不区分「不存在」与「已撤回」）。 */
  readPublished(family: AdminFamily, id: string): PublicProjection | null;
  isPubliclyVisible(family: AdminFamily, id: string): boolean;
  /** 该实体全部已发布过的修订（含已被新修订取代的），用于「旧修订可追溯」断言。 */
  traceableRevisions(family: AdminFamily, id: string): readonly { revision: number; content: unknown }[];
  /**
   * 本片新增：**读取时重算**的引用可用性（机读原因，供"下架后不得复活"的举证）。
   * 没有生效的已发布修订时返回 `null`（那种情况下"可见性"由生命周期解释，与引用无关）。
   */
  availabilityOf(family: AdminFamily, id: string): ReferenceResolution | null;
}

function isFamily(value: string): value is AdminFamily {
  return (ADMIN_FAMILIES as readonly string[]).includes(value);
}

function publishedRevisionOf(entity: StoredEntity<unknown>): StoredRevision<unknown> | null {
  if (entity.lifecycle !== 'published') return null;
  if (entity.publishedRevision === null) return null;
  return entity.revisions.find((revision) => revision.revision === entity.publishedRevision) ?? null;
}

export function createAdminPublicView(store: AdminContentStore): AdminPublicView {
  const integrity = createReferenceIntegrity(store);

  function lookup(family: AdminFamily, id: string): StoredEntity<unknown> | null {
    if (!isFamily(family)) return null;
    const entity = store.getEntity(id.toLowerCase());
    if (entity === undefined || entity.family !== family) return null;
    return entity;
  }

  /** 公开可见的已发布修订：必须是"自己已发布" **且** 引用当前可用。 */
  function visiblePublished(family: AdminFamily, id: string): { entity: StoredEntity<unknown>; revision: StoredRevision<unknown> } | null {
    const entity = lookup(family, id);
    if (entity === null) return null;
    const revision = publishedRevisionOf(entity);
    if (revision === null) return null;
    // 读取时重算：来源已撤回/改版 ⇒ 立即不可见（不缓存、不靠清缓存动作）。
    if (integrity.resolve(entity.family, revision.content).state === 'unavailable') return null;
    return { entity, revision };
  }

  return {
    readPublished(family, id) {
      const visible = visiblePublished(family, id);
      if (visible === null) return null;
      const { entity, revision } = visible;
      return {
        family: entity.family,
        id: entity.id,
        revision: revision.revision,
        // **出口深拷贝**（返修 1）：公开视图也不得交出存储修订的原对象。
        content: cloneDeep(revision.content),
        updated_at: revision.createdAt.toISOString(),
      };
    },
    isPubliclyVisible(family, id) {
      return visiblePublished(family, id) !== null;
    },
    availabilityOf(family, id) {
      const entity = lookup(family, id);
      if (entity === null) return null;
      const revision = publishedRevisionOf(entity);
      if (revision === null) return null;
      return integrity.resolve(entity.family, revision.content);
    },
    traceableRevisions(family, id) {
      const entity = lookup(family, id);
      if (entity === null || entity.publishedRevision === null) return Object.freeze([]);
      // 「曾经发布过」的修订：修订号 ≤ 已发布修订号的都是历史冻结内容，仍可追溯。
      // 每个历史版本同样返回**深拷贝**，调用方改自己的副本动不了库。
      return Object.freeze(
        entity.revisions
          .filter((revision) => revision.revision <= (entity.publishedRevision ?? 0))
          .map((revision) => Object.freeze({ revision: revision.revision, content: cloneDeep(revision.content) })),
      );
    },
  };
}
