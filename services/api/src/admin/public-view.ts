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
 */
import { ADMIN_FAMILIES } from './types.ts';
import type { AdminFamily, StoredEntity, StoredRevision } from './types.ts';
import type { AdminContentStore } from './store.ts';

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
  function lookup(family: AdminFamily, id: string): StoredEntity<unknown> | null {
    if (!isFamily(family)) return null;
    const entity = store.getEntity(id.toLowerCase());
    if (entity === undefined || entity.family !== family) return null;
    return entity;
  }

  return {
    readPublished(family, id) {
      const entity = lookup(family, id);
      if (entity === null) return null;
      const revision = publishedRevisionOf(entity);
      if (revision === null) return null;
      return {
        family: entity.family,
        id: entity.id,
        revision: revision.revision,
        content: revision.content,
        updated_at: revision.createdAt.toISOString(),
      };
    },
    isPubliclyVisible(family, id) {
      const entity = lookup(family, id);
      return entity !== null && publishedRevisionOf(entity) !== null;
    },
    traceableRevisions(family, id) {
      const entity = lookup(family, id);
      if (entity === null || entity.publishedRevision === null) return Object.freeze([]);
      // 「曾经发布过」的修订：修订号 ≤ 已发布修订号的都是历史冻结内容，仍可追溯。
      return Object.freeze(
        entity.revisions
          .filter((revision) => revision.revision <= (entity.publishedRevision ?? 0))
          .map((revision) => Object.freeze({ revision: revision.revision, content: revision.content })),
      );
    },
  };
}
