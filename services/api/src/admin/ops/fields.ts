/**
 * GY-I18 阶段 1b · 契约字段镜像表。
 *
 * 与阶段 1 的 `admin/fields.ts` 同一套做法：**手写镜像**逐字段复刻
 * `packages/contracts/openapi.json` 里本片用到的 schema，并由
 * `tests/unit/admin-ops-contract.test.mjs` 读契约原文（只读）做归一化比对。
 *
 * 校验**复用**阶段 1 的解析/判定实现（`createSpecValidator`），不另写第二套校验器。
 * 本片**不新增字段、不新增错误码、不修改 `packages/contracts/**`**。
 */
import { ERROR_CODES } from '../../contract.ts';
import { ADMIN_SCOPES } from '../scopes.ts';
import {
  ALL_SPECS,
  createSpecValidator,
  type FieldSpec,
} from '../fields.ts';
import { POST_REVIEW_REASON_CODES } from './types.ts';

const str = (minLength: number, maxLength: number): FieldSpec => ({ type: 'string', minLength, maxLength });
const enumOf = (...values: string[]): FieldSpec => ({ type: 'string', enum: values });
const uuid = (): FieldSpec => ({ type: 'string', format: 'uuid' });
const datetime = (): FieldSpec => ({ type: 'string', format: 'date-time' });
const integer = (minimum: number): FieldSpec => ({ type: 'integer', minimum });

/** 契约里的具名标量（可以 `$ref` 引用）。 */
const SCALAR_SPECS = {
  /**
   * 契约 `JobState` 是**具名** schema（`AdminJob.state` 用 `$ref` 指向它）。
   * 注意：`Category.type` / `AdminAccountView.state` / `AdminJob.kind` 在契约里是**内联**枚举，
   * 必须就地内联，不能另起名字——否则镜像与契约就不逐字相等了。
   */
  JobState: enumOf('queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'),
  /**
   * 契约 `ErrorCode` 闭集：直接取 `contract.ts` 的 `ERROR_CODES`
   * （该常量由 `tests/contract` 保证与契约一致），不在这里抄第二份。
   */
  ErrorCode: { type: 'string', enum: [...ERROR_CODES] },
  /**
   * `#18` S2 PR-3：契约 `AdminScope`（后台权限闭集 13 项）。
   *
   * 取值来自 `admin/scopes.ts` 的 `ADMIN_SCOPES`（应用层唯一闭集常量，与库层 CHECK
   * `admin_scopes_scope_closed_set` 逐字同源），⛔ 不在这里抄第二份 ——
   * `tests/unit/admin-scopes-write.test.mjs` 会把本镜像与契约 enum 逐项对拍。
   */
  AdminScope: { type: 'string', minLength: 1, maxLength: 80, enum: [...ADMIN_SCOPES] },
} as const satisfies Readonly<Record<string, FieldSpec>>;

/** 契约里 3 处 flag key 的内联枚举。 */
const FLAG_KEY: FieldSpec = enumOf('submissions_enabled', 'specific_herbicide_output_enabled', 'ai_enabled');

/** 本片新增的入参 schema。 */
export const OPS_INPUT_SPECS = {
  CategoryInput: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'description', 'active'],
    properties: {
      name: str(1, 120),
      description: str(1, 2000),
      active: { type: 'boolean' },
    },
  },

  FlagInput: {
    type: 'object',
    additionalProperties: false,
    required: ['enabled', 'reason'],
    properties: {
      enabled: { type: 'boolean' },
      reason: str(1, 500),
    },
  },

  /**
   * S3 `rejectPost` 的请求体：**只有** `reason_code` 一个字段。
   *
   * 刻意不加可选 `note`：契约里没有落点（`community_moderation_decisions` 无 note 列、
   * `admin_audit_events.reason_code` 是闭集），收一个存不下的字段就是照抄 `hidePost`
   * 「只收不落」的既有缺陷。
   *
   * `enum` 与 `types.ts` 的 `POST_REVIEW_REASON_CODES` **逐值相等**（顺序也一致），
   * 由 `tests/unit/admin-post-review-contract.test.mjs` 双向钉死；这里不再手抄第二份字面量。
   */
  PostRejectionInput: {
    type: 'object',
    additionalProperties: false,
    required: ['reason_code'],
    properties: {
      reason_code: enumOf(...POST_REVIEW_REASON_CODES),
    },
  },

  /**
   * `#18` S2 PR-3：`grantAdministratorScope` 的请求体 —— **单个** scope + 原因。
   *
   * 为什么不是"整个 scope 集合"：裁定③明令「不做整集合覆盖」。整集合覆盖会让两个管理员
   * 并发维护同一目标时互相清空对方刚授的权限，且无法从审计里读出"这一次到底加了哪一项"。
   * `reason` 落审计 before/after 的 jsonb（`admin_audit_events` 没有自由文本列）。
   */
  AdminScopeGrantInput: {
    type: 'object',
    additionalProperties: false,
    required: ['scope', 'reason'],
    properties: {
      scope: { ref: 'AdminScope' },
      reason: str(1, 500),
    },
  },
} as const satisfies Readonly<Record<string, FieldSpec>>;

/** 本片新增的出参 schema。 */
export const OPS_OUTPUT_SPECS = {
  // 契约里 `JobState` 是具名 schema；`ErrorCode` 也是。
  JobState: SCALAR_SPECS.JobState,
  ErrorCode: SCALAR_SPECS.ErrorCode,

  Category: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'revision', 'type', 'name', 'description', 'active'],
    properties: {
      // 分类 id 是 1..80 的**不透明字符串**（不是 uuid）——照契约。
      id: str(1, 80),
      revision: integer(1),
      // 契约里 `Category.type` 是内联枚举。
      type: enumOf('crop', 'species'),
      name: str(1, 120),
      description: str(1, 2000),
      active: { type: 'boolean' },
    },
  },

  AdminAccountView: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'revision', 'state', 'display_name'],
    properties: {
      id: uuid(),
      revision: integer(1),
      // 契约里 `state` 是内联枚举。
      state: enumOf('active', 'suspended', 'deletion_pending'),
      display_name: str(1, 80),
    },
  },

  AdminJob: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'revision', 'kind', 'target_ref', 'state', 'deadline_at', 'created_at', 'error_code', 'result'],
    properties: {
      id: uuid(),
      revision: integer(1),
      // 契约里 `kind` 是内联枚举。
      kind: enumOf('recognition', 'ocr', 'transcription', 'answer', 'synthesis', 'moderation'),
      target_ref: { ref: 'TargetRef' },
      state: { ref: 'JobState' },
      deadline_at: datetime(),
      created_at: datetime(),
      error_code: { ref: 'ErrorCode', nullable: true },
      // 契约里 `result` 是 `{"type":"null"}` ⇒ 恒为 null，不做占位。
      result: { type: 'null' },
    },
  },

  Flag: {
    type: 'object',
    additionalProperties: false,
    required: ['key', 'enabled', 'revision'],
    properties: {
      key: FLAG_KEY,
      enabled: { type: 'boolean' },
      revision: integer(1),
    },
  },

  Ack: {
    type: 'object',
    additionalProperties: false,
    required: ['accepted'],
    properties: { accepted: { type: 'boolean' } },
  },

  /**
   * `#18` S2 PR-3：授予/撤销后的管理端快照（`grantAdministratorScope` /
   * `revokeAdministratorScope` 的共同响应体）。
   *
   * 为什么带 `revision` 而**只读**权限面（`AdminAdministratorScopesView`）刻意不发 ETag：
   * 写面**确实**推进了 `admin_accounts.revision`（迁移 0041 第 ⑧/⑨ 步），调用方要拿它做下一次
   * `If-Match`；只读面不改任何行，拿同一个 revision 当"权限集合版本"才是谎称。
   * `scopes` 走 `AdminScope` 具名引用（与契约同形），去重 + 码元序由服务层归一化。
   */
  AdminScopeWriteView: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'revision', 'scopes', 'changed'],
    properties: {
      id: uuid(),
      revision: integer(1),
      scopes: { type: 'array', items: { ref: 'AdminScope' }, maxItems: 20 },
      changed: { type: 'boolean' },
    },
  },

  /**
   * S3 `approvePost` / `rejectPost` 的共同响应体。
   *
   * 键集合与 `types.ts` 的 `PostReviewOutcome` 逐字一致，且是**新增**的具名组件
   * （不复用 `Ack`）：运营需要知道"打在了哪个版本上、结论是什么、作者是否被通知"，
   * `{accepted:true}` 给不了这些。枚举一律**内联**（与 `Category.type` 同款纪律：
   * 契约里内联的，镜像也必须内联，否则归一化比对不相等）。
   */
  PostReviewOutcome: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'revision', 'audit_state', 'visibility', 'decision', 'changed', 'notified', 'reason_codes'],
    properties: {
      id: uuid(),
      revision: integer(1),
      audit_state: enumOf('approved', 'rejected'),
      visibility: enumOf('private', 'published', 'hidden', 'deleted'),
      decision: enumOf('approved', 'rejected'),
      changed: { type: 'boolean' },
      notified: { type: 'boolean' },
      // 门禁原因码（机器码全大写 / 运营码小写 snake_case 混装，故不设 enum）。
      // ⛔ 不得加 minLength/maxLength：契约里 `items` 只有 `{"type":"string"}`，
      // 镜像多写一条约束就跟契约不同形（`admin-ops-contract` 逐字比对会红）。
      reason_codes: { type: 'array', items: { type: 'string' } },
    },
  },
} as const satisfies Readonly<Record<string, FieldSpec>>;

/**
 * 分页 schema。
 *
 * 导出给 `admin/posts/fields.ts` 复用（R59）：后台帖子读面的分页/信封形状与 ops 域
 * **逐字相同**，再造一份就会漂移；复用同一工厂保证两边永远同形。
 */
export function pageOf(itemRef: string): FieldSpec {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'next_cursor'],
    properties: {
      items: { type: 'array', items: { ref: itemRef }, maxItems: 50 },
      next_cursor: { type: 'string', minLength: 1, maxLength: 2048, nullable: true },
    },
  };
}

/** 信封 schema。同 `pageOf`：导出以便 `admin/posts/fields.ts` 复用同一形状。 */
export function envelopeOf(dataRef: string): FieldSpec {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['data', 'meta'],
    properties: { data: { ref: dataRef }, meta: { ref: 'Meta' } },
  };
}

export const OPS_PAGE_SPECS = {
  CategoryPage: pageOf('Category'),
  AdminAccountViewPage: pageOf('AdminAccountView'),
  AdminJobPage: pageOf('AdminJob'),
  FlagPage: pageOf('Flag'),
} as const satisfies Readonly<Record<string, FieldSpec>>;

export const OPS_ENVELOPE_SPECS = {
  CategoryEnvelope: envelopeOf('Category'),
  CategoryPageEnvelope: envelopeOf('CategoryPage'),
  AdminAccountViewEnvelope: envelopeOf('AdminAccountView'),
  AdminAccountViewPageEnvelope: envelopeOf('AdminAccountViewPage'),
  AdminJobEnvelope: envelopeOf('AdminJob'),
  AdminJobPageEnvelope: envelopeOf('AdminJobPage'),
  FlagEnvelope: envelopeOf('Flag'),
  FlagPageEnvelope: envelopeOf('FlagPage'),
  AckEnvelope: envelopeOf('Ack'),
  // `#18` S2 PR-3：授予/撤销的单资源信封（data = AdminScopeWriteView）。
  AdminScopeWriteViewEnvelope: envelopeOf('AdminScopeWriteView'),
} as const satisfies Readonly<Record<string, FieldSpec>>;

/**
 * 本片校验用注册表 = 阶段 1 的全表 + 本片新增。
 * 这样 `ReasonInput` / `Meta` / `TargetRef` / `ExecutionMode` 等**只有一份定义**。
 *
 * `...SCALAR_SPECS` 是 `#18` S2 PR-3 加的：`AdminScopeGrantInput.scope` 用 `ref: 'AdminScope'`
 * 引用具名 schema，校验器必须在**同一张注册表**里找到它，否则会报 `spec_missing`。
 * 它**不**进 `OPS_*_SPECS` 那四个被 `admin-ops-contract.test.mjs` 逐字比对的组 ——
 * 与契约 enum 的逐项相等由 `tests/unit/admin-scopes-write.test.mjs` 单独钉（一条更锋利的判据：
 * 那里比的是**成员**，不只是形状）。
 */
export const OPS_ALL_SPECS: Readonly<Record<string, FieldSpec>> = {
  ...ALL_SPECS,
  ...SCALAR_SPECS,
  ...OPS_INPUT_SPECS,
  ...OPS_OUTPUT_SPECS,
  ...OPS_PAGE_SPECS,
  ...OPS_ENVELOPE_SPECS,
};

/** 复用阶段 1 的同一套校验实现，只换注册表。 */
export const opsValidator = createSpecValidator(OPS_ALL_SPECS);

/** 供契约比对测试使用的分组（组名 → schema 表）。 */
export const OPS_SPEC_GROUPS = {
  OPS_INPUT_SPECS,
  OPS_OUTPUT_SPECS,
  OPS_PAGE_SPECS,
  OPS_ENVELOPE_SPECS,
} as const;
