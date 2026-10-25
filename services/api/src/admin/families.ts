/**
 * 四类资料家族的描述符（GY-I18 阶段 1）。
 *
 * 抽象结论（也是本片对「四类共用几套代码」的正面回答）：
 * **四类资料共用 1 套生命周期引擎、1 套契约校验器、1 套审计台账、1 套幂等台账、
 * 1 套分页/游标、1 套权限判定**；差异被压到下面 4 个描述符里，且只有 4 处：
 *
 * 1. `inputSchema` / `pageSchema`：入参与列表的契约 schema 名不同。
 * 2. **出参形状**：`sources` 用 `SourceDraft.source: SourceRef`（把入参摊平进 source，
 *    并额外带 `validity` / `review_status` / `updated_at`）；另外三类用
 *    `content: <XxxInput>` + 顶层 `review_status`。
 * 3. **是否有 visibility**：`SourceDraft` 与 `KnowledgeDraft` 有 `visibility`；
 *    `RegistrationDraft` 与 `Restriction` **没有**这个字段（→ 契约缺口，见下）。
 * 4. **TargetRef.type 的取值策略**：只有 `sources` 能直接命中闭集里的 `source`。
 *
 * 契约缺口（如实记录，不新增字段、不改 packages/contracts/**）：
 * - `TargetRef.type` 的 17 个闭集成员里**没有** knowledge / registration / restriction。
 *   为了既不新增闭集成员、又不丢掉 revision 追溯，本片用下面 `targetRefTypeFor()`
 *   的**临时映射**，并且**只使用闭集内已有的成员**；映射结果由
 *   `tests/unit/admin-contract-fields.test.mjs` 对着契约的 `TargetRef.type` 闭集断言。
 * - `RegistrationDraft` / `Restriction` 没有 `visibility` 字段，「撤回」在它们的
 *   契约响应里无处表达 → 撤回只落在服务层内部生命周期 + 公开读口径上。
 */
import { cloneDeep } from './immutable.ts';
import type { AdminFamily, StoredEntity, StoredRevision, TargetRefValue } from './types.ts';

export interface SourceDraftInputValue {
  title: string;
  url: string;
  publisher: string;
  source_kind: 'database' | 'verified_seed' | 'simulation';
  evidence_kind: 'research' | 'experience' | 'mixed';
  version: string;
  content_hash: string;
  locator: string;
  valid_from: string;
  valid_to: string | null;
}

export interface ConditionsValue {
  crop_id: string;
  region_code: string;
  species_id?: string;
  growth_stage?: string;
  planting_method?: string;
  use_scene?: string;
}

export interface KnowledgeDraftInputValue {
  type: 'species' | 'herbicide' | 'scheme' | 'static_region';
  title: string;
  body: string;
  source_id: string;
  source_version: string;
  conditions: ConditionsValue | null;
  formulation_id: string | null;
}

export interface IngredientValue {
  name: string;
  content_text: string;
  unit_text: string;
}

export interface FormulationInputValue {
  registration_number: string;
  producer: string;
  dosage_form: string;
  ingredients: IngredientValue[];
}

export interface RegistrationDraftInputValue {
  formulation: FormulationInputValue;
  source_id: string;
  source_version: string;
  registered_name: string;
  valid_from: string;
  valid_to: string | null;
}

export interface RestrictionInputValue {
  source_id: string;
  source_version: string;
  formulation_id: string | null;
  conditions: ConditionsValue;
  effect: 'prohibited' | 'restricted' | 'unknown';
  reason: string;
  valid_from: string;
  valid_to: string | null;
}

/** 契约闭集 `TargetRef.type` 里本片用到的成员（其余成员本片不产生）。 */
export type TargetRefTypeValue = 'source' | 'species' | 'herbicide' | 'scheme' | 'static_region';

export interface FamilyDescriptor {
  readonly family: AdminFamily;
  /** 用于审计 action 前缀，例如 source → `source.publish`。 */
  readonly noun: 'source' | 'knowledge' | 'registration' | 'restriction';
  readonly inputSchema: string;
  readonly draftSchema: string;
  readonly pageSchema: string;
  readonly envelopeSchema: string;
  readonly pageEnvelopeSchema: string;
  /** 契约里的集合路径，用作幂等键域的一部分。 */
  readonly path: string;
  readonly readScope: 'sources:read';
  readonly writeScope: 'sources:write';
  readonly operations: {
    readonly list: string;
    readonly create: string;
    readonly get: string;
    readonly edit: string;
    readonly publish: string;
    readonly withdraw: string;
  };
  /** 契约里这类资料的响应是否带 `visibility`。 */
  readonly hasVisibility: boolean;
  /** TargetRef.type 取值策略（契约缺口处的临时映射）。 */
  readonly targetRefTypeFor: (content: unknown) => TargetRefTypeValue;
}

export const SOURCE_FAMILY: FamilyDescriptor = {
  family: 'sources',
  noun: 'source',
  inputSchema: 'SourceDraftInput',
  draftSchema: 'SourceDraft',
  pageSchema: 'SourceDraftPage',
  envelopeSchema: 'SourceDraftEnvelope',
  pageEnvelopeSchema: 'SourceDraftPageEnvelope',
  path: '/admin/sources',
  readScope: 'sources:read',
  writeScope: 'sources:write',
  operations: {
    list: 'listAdminSources',
    create: 'createSourceDraft',
    get: 'getAdminSource',
    edit: 'editSourceDraft',
    publish: 'publishSource',
    withdraw: 'withdrawSource',
  },
  hasVisibility: true,
  // 唯一直接命中闭集成员的家族。
  targetRefTypeFor: () => 'source',
};

export const KNOWLEDGE_FAMILY: FamilyDescriptor = {
  family: 'knowledge',
  noun: 'knowledge',
  inputSchema: 'KnowledgeDraftInput',
  draftSchema: 'KnowledgeDraft',
  pageSchema: 'KnowledgeDraftPage',
  envelopeSchema: 'KnowledgeDraftEnvelope',
  pageEnvelopeSchema: 'KnowledgeDraftPageEnvelope',
  path: '/admin/knowledge',
  readScope: 'sources:read',
  writeScope: 'sources:write',
  operations: {
    list: 'listAdminKnowledge',
    create: 'createKnowledgeDraft',
    get: 'getAdminKnowledge',
    edit: 'editKnowledgeDraft',
    publish: 'publishKnowledge',
    withdraw: 'withdrawKnowledge',
  },
  hasVisibility: true,
  // 契约没有 knowledge 成员：改用资料**自身声明**的 type（该闭集是 TargetRef.type 的子集）。
  targetRefTypeFor: (content) => (content as KnowledgeDraftInputValue).type,
};

export const REGISTRATION_FAMILY: FamilyDescriptor = {
  family: 'registrations',
  noun: 'registration',
  inputSchema: 'RegistrationDraftInput',
  draftSchema: 'RegistrationDraft',
  pageSchema: 'RegistrationDraftPage',
  envelopeSchema: 'RegistrationDraftEnvelope',
  pageEnvelopeSchema: 'RegistrationDraftPageEnvelope',
  path: '/admin/registrations',
  readScope: 'sources:read',
  writeScope: 'sources:write',
  operations: {
    list: 'listAdminRegistration',
    create: 'createRegistrationDraft',
    get: 'getAdminRegistration',
    edit: 'editRegistrationDraft',
    publish: 'publishRegistration',
    withdraw: 'withdrawRegistration',
  },
  hasVisibility: false,
  // 契约缺口：闭集无 registration。制剂登记记录以「除草剂制剂」为主体 → 取 herbicide。
  targetRefTypeFor: () => 'herbicide',
};

export const RESTRICTION_FAMILY: FamilyDescriptor = {
  family: 'restrictions',
  noun: 'restriction',
  inputSchema: 'RestrictionInput',
  draftSchema: 'Restriction',
  pageSchema: 'RestrictionPage',
  envelopeSchema: 'RestrictionEnvelope',
  pageEnvelopeSchema: 'RestrictionPageEnvelope',
  path: '/admin/restrictions',
  readScope: 'sources:read',
  writeScope: 'sources:write',
  operations: {
    list: 'listAdminRestriction',
    create: 'createRestrictionDraft',
    get: 'getAdminRestriction',
    edit: 'editRestrictionDraft',
    publish: 'publishRestriction',
    withdraw: 'withdrawRestriction',
  },
  hasVisibility: false,
  // 契约缺口：闭集无 restriction。使用限制条件以「除草剂制剂 + 条件」为主体 → 取 herbicide。
  targetRefTypeFor: () => 'herbicide',
};

export const FAMILIES: readonly FamilyDescriptor[] = Object.freeze([
  SOURCE_FAMILY,
  KNOWLEDGE_FAMILY,
  REGISTRATION_FAMILY,
  RESTRICTION_FAMILY,
]);

/**
 * 该修订是否就是**当前生效的已发布修订**。
 * 注意：发布后又编辑会产生更新的草稿修订，此时 head 不再是已发布修订。
 */
export function isLivePublishedRevision(entity: StoredEntity<unknown>, revision: StoredRevision<unknown>): boolean {
  return entity.lifecycle === 'published' && entity.publishedRevision === revision.revision;
}

/** 该修订是否**曾经**发布过（含已撤回的当前已发布修订）。 */
function everPublished(entity: StoredEntity<unknown>, revision: StoredRevision<unknown>): boolean {
  return entity.publishedRevision !== null && revision.revision <= entity.publishedRevision;
}

/** 生命周期 → 契约 `Visibility`。仅对 `hasVisibility` 的家族使用。 */
export function visibilityFor(entity: StoredEntity<unknown>, revision: StoredRevision<unknown>): 'private' | 'published' | 'hidden' | 'deleted' {
  if (isLivePublishedRevision(entity, revision)) return 'published';
  if (entity.lifecycle === 'withdrawn' && entity.publishedRevision === revision.revision) return 'hidden';
  return 'private';
}

/** 生命周期 → 契约 `SourceRef.validity`（仅 sources 家族）。 */
function validityFor(entity: StoredEntity<unknown>, revision: StoredRevision<unknown>): 'valid' | 'expired' | 'conflicting' | 'unknown' | 'withdrawn' {
  if (isLivePublishedRevision(entity, revision)) return 'valid';
  if (entity.lifecycle === 'withdrawn' && entity.publishedRevision === revision.revision) return 'withdrawn';
  // 未发布的草稿：契约闭集里表达「尚未核验」的诚实取值。
  return 'unknown';
}

/**
 * 把（实体, 某个修订）投影成契约响应体 `data`。
 * 只按契约字段输出；不新增字段。
 *
 * **出口不可变**（返修 1）：凡承载存储内容的字段一律 `cloneDeep`，
 * 绝不把 `revision.content` 原对象交给调用方。
 */
export function projectRevisionData(
  descriptor: FamilyDescriptor,
  entity: StoredEntity<unknown>,
  revision: StoredRevision<unknown>,
): Record<string, unknown> {
  const reviewStatus = everPublished(entity, revision) ? 'verified' : 'unverified';
  const updatedAt = revision.createdAt.toISOString();

  if (descriptor.family === 'sources') {
    const content = revision.content as SourceDraftInputValue;
    // sources 的契约出参是 `SourceRef`：这里把入参**摊平**成新的标量对象，
    // 每个字段都是 string / enum 原始值，因此天然不共享任何引用，无需额外拷贝。
    return {
      id: entity.id,
      revision: revision.revision,
      source: {
        id: entity.id,
        version: content.version,
        title: content.title,
        url: content.url,
        publisher: content.publisher,
        source_kind: content.source_kind,
        evidence_kind: content.evidence_kind,
        validity: validityFor(entity, revision),
        review_status: reviewStatus,
        updated_at: updatedAt,
      },
      visibility: visibilityFor(entity, revision),
    };
  }

  if (descriptor.family === 'knowledge') {
    return {
      id: entity.id,
      revision: revision.revision,
      // **出口深拷贝**（返修 1）：绝不交出 `revision.content` 原对象。
      // 存储修订已深冻结，这里仍需深拷贝，调用方才能拿到自有的普通数据。
      content: cloneDeep(revision.content),
      visibility: visibilityFor(entity, revision),
      review_status: reviewStatus,
    };
  }

  // registrations / restrictions：契约里**没有** visibility 字段，故不输出。
  return {
    id: entity.id,
    revision: revision.revision,
    content: cloneDeep(revision.content),
    review_status: reviewStatus,
  };
}

/** 构造审计用的 `TargetRef`（含 revision）。 */
export function targetRefFor(
  descriptor: FamilyDescriptor,
  entity: StoredEntity<unknown>,
  revision: StoredRevision<unknown>,
): TargetRefValue {
  return {
    type: descriptor.targetRefTypeFor(revision.content),
    id: entity.id,
    revision: revision.revision,
  };
}

/** 读取实体当前 head 修订（最后一个修订，修订号单调递增）。 */
export function headRevision(entity: StoredEntity<unknown>): StoredRevision<unknown> {
  const head = entity.revisions.at(-1);
  if (head === undefined) throw new Error(`资料 ${entity.id} 没有任何修订`);
  return head;
}
