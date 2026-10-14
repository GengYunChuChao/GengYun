/**
 * GY-I18 本片 · **来源 → 引用 的同步失效**（`Refs #18`）。
 *
 * ## 解决什么问题
 * 四类资料不是彼此独立的：`knowledge` / `registrations` / `restrictions` 都用
 * `source_id` + `source_version` 指向一条**来源**（`sources`）。派单要求：
 * 「**修改来源须重新校验并失效相关引用**；**下架后缓存与详情同步**
 * （不得因缓存或旧链接重新公开隐藏/失效内容）」。
 *
 * ## 口径（关键：判定在**读取时**重算，不缓存、不落"失效标记"）
 * 一条依赖引用的"可用性"由**来源的当前生效状态**唯一决定：
 * | 情形 | 判定 | 理由 |
 * |---|---|---|
 * | 来源在本存储中不存在 | `unverifiable` | 未接真实库：库外来源无法核对。**不伪造"失效"结论**，也不假装"已核对" |
 * | 来源存在但未发布（草稿） | `unavailable` | 引用一个还没生效的版本 = 引用不可用 |
 * | 来源已撤回 | `unavailable` | 下架即失效（这正是"下架后不得复活"的那条） |
 * | `source_version` ≠ 来源当前生效版本 | `unavailable` | 修改来源（发新版本）⇒ 旧版本引用随之失效 |
 * | 其余 | `available` | — |
 *
 * 因为判定是**纯函数 + 每次读取重新计算**，所以不存在"缓存里还留着旧结论"这种事：
 * 撤回/改版下一条请求立即看不到该内容。本模块只暴露**只读**方法。
 *
 * ## 两类消费方（两处都落在这里，不各写一套）
 * 1. **公开读口径**（`public-view.ts`）：依赖不可用 ⇒ 公开读返回 `null`
 *    （与"不存在"同形，不泄露存在性）。
 * 2. **发布门槛**（`service.ts` 的 `publishDraft`）：只拦**确认失效**（`unavailable`）
 *    的依赖 ⇒ `SOURCE_CONFLICT`(422，契约闭集内)。`unverifiable` **不拦**
 *    （那会把"没有真实库"变成"整个前台发不出内容"，属过度拦截且不诚实）。
 *
 * ## 责任人/范围（审计）
 * `describeSourceChange(sourceId)` 给出「这次来源变更影响了哪些引用」的机读范围，
 * 由服务层写进来源发布/撤回的审计记录（`target_hint`，内部字段，不外泄到契约投影）。
 */
import { ApiError } from '../errors.ts';
import type { AdminFamily, StoredEntity } from './types.ts';
import type { AdminContentStore } from './store.ts';
import { headRevision } from './families.ts';

/** 会引用来源的家族（`sources` 自己不引用任何来源）。 */
export const DEPENDENT_FAMILIES: readonly AdminFamily[] = Object.freeze(['knowledge', 'registrations', 'restrictions']);

export type ReferenceState = 'available' | 'unavailable' | 'unverifiable';

export type ReferenceUnavailableReason =
  | 'source_reference_malformed'
  | 'source_not_published'
  | 'source_withdrawn'
  | 'source_version_mismatch';

export interface ReferenceResolution {
  readonly state: ReferenceState;
  /** 仅 `state !== 'available'` 时非 null；`unverifiable` 用 `source_not_in_store`。 */
  readonly reason: ReferenceUnavailableReason | 'source_not_in_store' | null;
  /** 该家族是否属于"会引用来源"的家族（`sources` 自己为 false）。 */
  readonly dependent: boolean;
  readonly sourceId: string | null;
  readonly referencedVersion: string | null;
  /** 来源**当前生效**的版本；无生效版本（草稿/已撤回/不存在）为 null。 */
  readonly liveVersion: string | null;
  /** 来源当前生效修订号；无生效版本为 null。 */
  readonly sourceRevision: number | null;
}

/** 一条依赖引用的机读描述（用于审计「范围」与测试断言）。 */
export interface SourceDependency {
  readonly family: AdminFamily;
  readonly id: string;
  /** 该实体当前 head 修订号。 */
  readonly revision: number;
  readonly referencedVersion: string | null;
  readonly state: ReferenceState;
}

export interface SourceChangeImpact {
  readonly sourceId: string;
  /** 变更后来源的生效版本（撤回后为 null）。 */
  readonly liveVersion: string | null;
  /** 引用该来源的依赖总数（含仍可用的）。 */
  readonly references: number;
  /** 其中当前判定为不可用的数量（= 本次变更实际失效的范围）。 */
  readonly invalidated: number;
  /** 不可用依赖的 id（升序，供举证）。 */
  readonly invalidatedIds: readonly string[];
}

export interface ReferenceIntegrity {
  /** 只读解析（每次都重算，绝不缓存）。 */
  resolve(family: AdminFamily, content: unknown): ReferenceResolution;
  /** 来源当前生效版本；无（不存在/未发布/已撤回）为 null。 */
  liveSourceVersionOf(sourceId: string): { version: string; revision: number } | null;
  /** 引用该来源的全部依赖（含已失效的）。 */
  referencesOf(sourceId: string): readonly SourceDependency[];
  /** 本次来源变更实际失效的范围（供审计「范围」）。 */
  describeSourceChange(sourceId: string): SourceChangeImpact;
  /** 发布门槛：仅 `unavailable` ⇒ `SOURCE_CONFLICT`；`unverifiable`/`available` 放行。 */
  assertPublishable(family: AdminFamily, content: unknown): void;
}

function sourceFieldsOf(content: unknown): { sourceId: string | null; version: string | null } {
  if (content === null || typeof content !== 'object') return { sourceId: null, version: null };
  const record = content as Record<string, unknown>;
  const sourceId = typeof record.source_id === 'string' && record.source_id !== '' ? record.source_id.toLowerCase() : null;
  const version = typeof record.source_version === 'string' && record.source_version !== '' ? record.source_version : null;
  return { sourceId, version };
}

export function createReferenceIntegrity(store: AdminContentStore): ReferenceIntegrity {
  function findSource(sourceId: string): StoredEntity<unknown> | undefined {
    return store.getEntity(sourceId);
  }

  /** 来源当前生效修订（`lifecycle === 'published'` 且存在 publishedRevision）。 */
  function liveSourceRevision(sourceId: string): { entity: StoredEntity<unknown>; revision: number; version: string | null } | null {
    const entity = findSource(sourceId);
    if (entity === undefined || entity.family !== 'sources') return null;
    if (entity.lifecycle !== 'published' || entity.publishedRevision === null) return null;
    const revision = entity.revisions.find((entry) => entry.revision === entity.publishedRevision);
    if (revision === undefined) return null;
    const content = revision.content as Record<string, unknown> | null;
    const version = content !== null && typeof content === 'object' && typeof content.version === 'string' ? content.version : null;
    return { entity, revision: revision.revision, version };
  }

  function resolve(family: AdminFamily, content: unknown): ReferenceResolution {
    if (!DEPENDENT_FAMILIES.includes(family)) {
      return {
        state: 'available',
        reason: null,
        dependent: false,
        sourceId: null,
        referencedVersion: null,
        liveVersion: null,
        sourceRevision: null,
      };
    }
    const { sourceId, version } = sourceFieldsOf(content);
    if (sourceId === null || version === null) {
      // 依赖行本身写坏了：不能核对 ⇒ 明确判不可用（fail-closed），而不是放行。
      return {
        state: 'unavailable',
        reason: 'source_reference_malformed',
        dependent: true,
        sourceId,
        referencedVersion: version,
        liveVersion: null,
        sourceRevision: null,
      };
    }
    const source = findSource(sourceId);
    if (source === undefined || source.family !== 'sources') {
      // 未接真实库：库外来源无法核对。如实标 unverifiable，**不**谎称失效。
      return {
        state: 'unverifiable',
        reason: 'source_not_in_store',
        dependent: true,
        sourceId,
        referencedVersion: version,
        liveVersion: null,
        sourceRevision: null,
      };
    }
    const live = liveSourceRevision(sourceId);
    if (live === null) {
      return {
        state: 'unavailable',
        reason: source.lifecycle === 'withdrawn' ? 'source_withdrawn' : 'source_not_published',
        dependent: true,
        sourceId,
        referencedVersion: version,
        liveVersion: null,
        sourceRevision: source.publishedRevision,
      };
    }
    if (live.version === null || live.version !== version) {
      return {
        state: 'unavailable',
        reason: 'source_version_mismatch',
        dependent: true,
        sourceId,
        referencedVersion: version,
        liveVersion: live.version,
        sourceRevision: live.revision,
      };
    }
    return {
      state: 'available',
      reason: null,
      dependent: true,
      sourceId,
      referencedVersion: version,
      liveVersion: live.version,
      sourceRevision: live.revision,
    };
  }

  function dependenciesOf(sourceId: string): readonly SourceDependency[] {
    const target = sourceId.toLowerCase();
    const found: SourceDependency[] = [];
    for (const family of DEPENDENT_FAMILIES) {
      for (const entity of store.listFamilyEntities(family)) {
        const { sourceId: referenced } = sourceFieldsOf(headRevision(entity).content);
        if (referenced !== target) continue;
        const resolution = resolve(family, headRevision(entity).content);
        found.push({
          family,
          id: entity.id,
          revision: headRevision(entity).revision,
          referencedVersion: resolution.referencedVersion,
          state: resolution.state,
        });
      }
    }
    return Object.freeze(found.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)));
  }

  return {
    resolve,
    liveSourceVersionOf(sourceId) {
      const live = liveSourceRevision(sourceId.toLowerCase());
      if (live === null || live.version === null) return null;
      return { version: live.version, revision: live.revision };
    },
    referencesOf: dependenciesOf,
    describeSourceChange(sourceId) {
      const dependencies = dependenciesOf(sourceId);
      const invalidated = dependencies.filter((entry) => entry.state === 'unavailable');
      const live = liveSourceRevision(sourceId.toLowerCase());
      return {
        sourceId: sourceId.toLowerCase(),
        liveVersion: live === null ? null : live.version,
        references: dependencies.length,
        invalidated: invalidated.length,
        invalidatedIds: Object.freeze(invalidated.map((entry) => entry.id)),
      };
    },
    assertPublishable(family, content) {
      const resolution = resolve(family, content);
      if (resolution.state !== 'unavailable') return;
      throw new ApiError(
        'SOURCE_CONFLICT',
        `发布门槛未通过：引用来源当前不可用（${resolution.reason}）——请先按来源新版本重新校验该引用`,
        { details: [{ field: 'source_id', code: resolution.reason ?? 'REFERENCE_UNAVAILABLE' }] },
      );
    },
  };
}
