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
import {
  ALL_SPECS,
  createSpecValidator,
  type FieldSpec,
} from '../fields.ts';

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
} as const satisfies Readonly<Record<string, FieldSpec>>;

/** 分页 schema。 */
function pageOf(itemRef: string): FieldSpec {
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

function envelopeOf(dataRef: string): FieldSpec {
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
} as const satisfies Readonly<Record<string, FieldSpec>>;

/**
 * 本片校验用注册表 = 阶段 1 的全表 + 本片新增。
 * 这样 `ReasonInput` / `Meta` / `TargetRef` / `ExecutionMode` 等**只有一份定义**。
 */
export const OPS_ALL_SPECS: Readonly<Record<string, FieldSpec>> = {
  ...ALL_SPECS,
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
