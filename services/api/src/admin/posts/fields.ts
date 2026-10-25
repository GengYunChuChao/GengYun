/**
 * R59 · 后台帖子读面（`listAdminPosts` / `getAdminPost`）契约字段镜像表。
 *
 * 做法与 `admin/ops/fields.ts` / `admin/fields.ts` 一致：**手写镜像**逐字段复刻
 * `packages/contracts/openapi.json` 里本域用到的 schema，由
 * `tests/unit/admin-posts-read.test.mjs` 读契约原文（只读）做归一化比对。
 *
 * 为什么另起一张表而不是塞进 `OPS_OUTPUT_SPECS`：
 * `tests/unit/admin-ops-contract.test.mjs` 把 ops 域的镜像数量钉成「恰好 22 个 schema」，
 * 塞进去会改动一条与本片无关的钉子，并把两个域的形状耦合在一起。`admin/audit/` 当初
 * 独立成域也是同一个理由。分表 + 复用 `pageOf`/`envelopeOf` 工厂，形状仍然只有一份。
 *
 * 校验**复用** `createSpecValidator`（不另写第二套校验器）；`Meta` / `Visibility` 等
 * 只有一份定义（来自 `ALL_SPECS`），`AuditState` / `KnowledgeTarget` 本域首次用到，就地镜像。
 */
import {
  ALL_SPECS,
  createSpecValidator,
  type FieldSpec,
} from '../fields.ts';
import { envelopeOf, pageOf } from '../ops/fields.ts';

const str = (minLength: number, maxLength: number): FieldSpec => ({ type: 'string', minLength, maxLength });
const enumOf = (...values: string[]): FieldSpec => ({ type: 'string', enum: values });
const uuid = (): FieldSpec => ({ type: 'string', format: 'uuid' });
const datetime = (): FieldSpec => ({ type: 'string', format: 'date-time' });
const integer = (minimum: number): FieldSpec => ({ type: 'integer', minimum });
const nullable = (spec: FieldSpec): FieldSpec => ({ ...spec, nullable: true });

/** 本域首次用到、`ALL_SPECS` 里没有的具名标量。 */
export const ADMIN_POST_SCALAR_SPECS = {
  AuditState: enumOf('pending', 'approved', 'rejected', 'quarantined'),
  /** 契约 `KnowledgeTarget`：`linked_knowledge_ref` 的引用形状（不是解析结果）。 */
  KnowledgeTarget: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'id', 'revision'],
    properties: {
      type: enumOf('species', 'herbicide', 'scheme'),
      id: str(1, 80),
      revision: integer(1),
    },
  },
} as const satisfies Readonly<Record<string, FieldSpec>>;

/** 本域出参 schema（列表项与详情**同一个**形状，少一个漂移面）。 */
export const ADMIN_POST_OUTPUT_SPECS = {
  AuditState: ADMIN_POST_SCALAR_SPECS.AuditState,
  KnowledgeTarget: ADMIN_POST_SCALAR_SPECS.KnowledgeTarget,

  AdminPost: {
    type: 'object',
    additionalProperties: false,
    required: [
      'id',
      'revision',
      'author_id',
      'anonymized_author_ref',
      'title',
      'body',
      'crop_id',
      'region_code',
      'media_ids',
      'visibility',
      'audit_state',
      'created_at',
      'updated_at',
      'linked_knowledge_ref',
    ],
    properties: {
      id: uuid(),
      revision: integer(1),
      // 注销后作者指针置 NULL（迁移 0030），由 `anonymized_author_ref` 承接身份。
      author_id: nullable(uuid()),
      anonymized_author_ref: nullable(str(1, 64)),
      title: str(1, 120),
      body: str(1, 8000),
      crop_id: nullable(str(1, 80)),
      region_code: nullable({ type: 'string', pattern: '^33[0-9]{4}$' }),
      media_ids: { type: 'array', items: uuid(), maxItems: 3 },
      // 库内存储值，**不是**公开读面按规则版本重算后的生效值。
      visibility: { ref: 'Visibility' },
      audit_state: { ref: 'AuditState' },
      created_at: datetime(),
      updated_at: datetime(),
      linked_knowledge_ref: nullable({ ref: 'KnowledgeTarget' }),
    },
  },
} as const satisfies Readonly<Record<string, FieldSpec>>;

export const ADMIN_POST_PAGE_SPECS = {
  AdminPostPage: pageOf('AdminPost'),
} as const satisfies Readonly<Record<string, FieldSpec>>;

export const ADMIN_POST_ENVELOPE_SPECS = {
  AdminPostEnvelope: envelopeOf('AdminPost'),
  AdminPostPageEnvelope: envelopeOf('AdminPostPage'),
} as const satisfies Readonly<Record<string, FieldSpec>>;

/** 校验用注册表 = 全仓既有表 + 本域新增（`Meta`/`Visibility`/`ErrorCode` 仍只有一份）。 */
export const ADMIN_POST_ALL_SPECS: Readonly<Record<string, FieldSpec>> = {
  ...ALL_SPECS,
  ...ADMIN_POST_OUTPUT_SPECS,
  ...ADMIN_POST_PAGE_SPECS,
  ...ADMIN_POST_ENVELOPE_SPECS,
};

/** 复用同一套校验实现，只换注册表。 */
export const adminPostsValidator = createSpecValidator(ADMIN_POST_ALL_SPECS);

/** 供契约比对测试使用的分组（组名 → schema 表）。 */
export const ADMIN_POST_SPEC_GROUPS = {
  ADMIN_POST_OUTPUT_SPECS,
  ADMIN_POST_PAGE_SPECS,
  ADMIN_POST_ENVELOPE_SPECS,
} as const;
