/**
 * 契约字段镜像表 + 通用校验器（GY-I18 阶段 1）。
 *
 * 设计立场：**契约是权威**。本文件是一份**手写镜像**，逐字段复刻
 * `packages/contracts/openapi.json` 中本片用到的 21 个 schema 的
 * `type / format / pattern / minLength / maxLength / minimum / enum / const /
 * items / minItems / maxItems / required / additionalProperties:false`。
 *
 * 镜像**不靠人眼保证**：`tests/unit/admin-contract-fields.test.mjs` 会读契约原文
 * （只读，不修改），用同一套归一化规则把两边化成同一形状后 `deepStrictEqual`，
 * 任何字段、必填项、长度上限、闭集成员的漂移都会让该用例失败。
 *
 * 本片**不新增字段、不新增错误码、不修改 `packages/contracts/**`**。
 */
import { ApiError } from '../errors.ts';
import type { FieldError } from '../errors.ts';

/** 契约 JSON Schema 子集在本片用到的全部关键字（归一化后的形状）。 */
export interface FieldSpec {
  type?: 'string' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  const?: string;
  enum?: readonly string[];
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  /** 对应契约的 `anyOf: [<T>, {type:"null"}]`。 */
  nullable?: boolean;
  /** 对应契约的 `$ref: '#/components/schemas/<name>'`。 */
  ref?: string;
  items?: FieldSpec;
  minItems?: number;
  maxItems?: number;
  properties?: Readonly<Record<string, FieldSpec>>;
  required?: readonly string[];
  additionalProperties?: false;
}

const str = (minLength: number, maxLength: number): FieldSpec => ({ type: 'string', minLength, maxLength });
const enumOf = (...values: string[]): FieldSpec => ({ type: 'string', enum: values });
const uuid = (): FieldSpec => ({ type: 'string', format: 'uuid' });
const datetime = (): FieldSpec => ({ type: 'string', format: 'date-time' });

/**
 * 契约里**具名**的标量 schema（可以 `$ref` 引用）。
 * 注意：契约里另有一批**内联**枚举（`KnowledgeDraftInput.type`、各 `review_status`、
 * `SourceRef.validity`、`RestrictionInput.effect`、`TargetRef.type`、`AuditEvent.result`），
 * 它们必须**就地内联**，不能另起名字——否则镜像与契约就不逐字相等了。
 */
const SCALAR_SPECS = {
  SourceKind: enumOf('database', 'verified_seed', 'simulation'),
  EvidenceKind: enumOf('research', 'experience', 'mixed'),
  Visibility: enumOf('private', 'published', 'hidden', 'deleted'),
  ExecutionMode: enumOf('real', 'stub', 'preset_demo'),
} as const satisfies Readonly<Record<string, FieldSpec>>;

/** 契约里 4 处 `review_status` 的内联枚举。 */
const REVIEW_STATUS: FieldSpec = enumOf('unverified', 'verified', 'rejected');

/** 契约 `TargetRef.type` 的 16 个成员（本片按此闭集校验审计目标类型）。 */
export const TARGET_REF_TYPES = [
  'species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr', 'transcription',
  'answer', 'post', 'comment', 'conversation', 'dose_card', 'media', 'synthesis', 'job', 'source',
] as const;

/**
 * **入参** schema（本片 requestBody 及其传递引用的对象图）。
 * 校验器只按这张表判定「能不能进门槛」。
 */
export const INPUT_SPECS = {
  SourceKind: SCALAR_SPECS.SourceKind,
  EvidenceKind: SCALAR_SPECS.EvidenceKind,

  SourceDraftInput: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'url', 'publisher', 'source_kind', 'evidence_kind', 'version', 'content_hash', 'locator', 'valid_from', 'valid_to'],
    properties: {
      title: str(1, 200),
      url: { type: 'string', format: 'uri', pattern: '^https://' },
      publisher: str(1, 200),
      source_kind: { ref: 'SourceKind' },
      evidence_kind: { ref: 'EvidenceKind' },
      version: str(1, 80),
      content_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      locator: str(1, 200),
      valid_from: datetime(),
      valid_to: { ...datetime(), nullable: true },
    },
  },

  SourcePublishInput: {
    type: 'object',
    additionalProperties: false,
    required: ['evidence_ref', 'reason'],
    properties: { evidence_ref: str(1, 80), reason: str(1, 500) },
  },

  ReasonInput: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: { reason: str(1, 500) },
  },

  Conditions: {
    type: 'object',
    additionalProperties: false,
    required: ['crop_id', 'region_code'],
    properties: {
      crop_id: str(1, 80),
      region_code: { type: 'string', pattern: '^33[0-9]{4}$' },
      species_id: str(1, 80),
      growth_stage: str(1, 80),
      planting_method: str(1, 80),
      use_scene: str(1, 80),
    },
  },

  Ingredient: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'content_text', 'unit_text'],
    properties: { name: str(1, 80), content_text: str(1, 80), unit_text: str(1, 80) },
  },

  FormulationInput: {
    type: 'object',
    additionalProperties: false,
    required: ['registration_number', 'producer', 'dosage_form', 'ingredients'],
    properties: {
      registration_number: str(1, 80),
      producer: str(1, 200),
      dosage_form: str(1, 80),
      ingredients: { type: 'array', items: { ref: 'Ingredient' }, minItems: 1, maxItems: 20 },
    },
  },

  KnowledgeDraftInput: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'title', 'body', 'source_id', 'source_version', 'conditions', 'formulation_id'],
    properties: {
      // 契约里 `type` 是**内联**枚举（不是 $ref），故此处同样内联。
      type: enumOf('species', 'herbicide', 'scheme', 'static_region'),
      title: str(1, 200),
      body: str(1, 20000),
      source_id: uuid(),
      source_version: str(1, 80),
      conditions: { ref: 'Conditions', nullable: true },
      formulation_id: { ...uuid(), nullable: true },
    },
  },

  RegistrationDraftInput: {
    type: 'object',
    additionalProperties: false,
    required: ['formulation', 'source_id', 'source_version', 'registered_name', 'valid_from', 'valid_to'],
    properties: {
      formulation: { ref: 'FormulationInput' },
      source_id: uuid(),
      source_version: str(1, 80),
      registered_name: str(1, 200),
      valid_from: datetime(),
      valid_to: { ...datetime(), nullable: true },
    },
  },

  RestrictionInput: {
    type: 'object',
    additionalProperties: false,
    required: ['source_id', 'source_version', 'formulation_id', 'conditions', 'effect', 'reason', 'valid_from', 'valid_to'],
    properties: {
      source_id: uuid(),
      source_version: str(1, 80),
      formulation_id: { ...uuid(), nullable: true },
      conditions: { ref: 'Conditions' },
      // 契约里 `effect` 是内联枚举。
      effect: enumOf('prohibited', 'restricted', 'unknown'),
      reason: str(1, 2000),
      valid_from: datetime(),
      valid_to: { ...datetime(), nullable: true },
    },
  },
} as const satisfies Readonly<Record<string, FieldSpec>>;

/**
 * **出参** schema（本片响应体用到的对象图）。
 * 服务层的每个响应体都要能被这张表判为合法，从而与契约保持一致。
 */
export const OUTPUT_SPECS = {
  Visibility: SCALAR_SPECS.Visibility,
  ExecutionMode: SCALAR_SPECS.ExecutionMode,

  Meta: {
    type: 'object',
    additionalProperties: false,
    required: ['request_id', 'contract_version', 'execution_mode'],
    properties: {
      request_id: uuid(),
      contract_version: { const: '1.0.0' },
      execution_mode: { ref: 'ExecutionMode' },
    },
  },

  TargetRef: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'id', 'revision'],
    properties: {
      type: enumOf(...TARGET_REF_TYPES),
      id: str(1, 80),
      revision: { type: 'integer', minimum: 1 },
    },
  },

  SourceRef: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'version', 'title', 'url', 'publisher', 'source_kind', 'evidence_kind', 'validity', 'review_status', 'updated_at'],
    properties: {
      id: uuid(),
      version: str(1, 80),
      title: str(1, 200),
      url: { type: 'string', format: 'uri', pattern: '^https://' },
      publisher: str(1, 200),
      source_kind: { ref: 'SourceKind' },
      evidence_kind: { ref: 'EvidenceKind' },
      // 契约里 `validity` / `review_status` 都是内联枚举。
      validity: enumOf('valid', 'expired', 'conflicting', 'unknown', 'withdrawn'),
      review_status: REVIEW_STATUS,
      updated_at: datetime(),
    },
  },

  SourceDraft: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'revision', 'source', 'visibility'],
    properties: {
      id: uuid(),
      revision: { type: 'integer', minimum: 1 },
      source: { ref: 'SourceRef' },
      visibility: { ref: 'Visibility' },
    },
  },

  KnowledgeDraft: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'revision', 'content', 'visibility', 'review_status'],
    properties: {
      id: uuid(),
      revision: { type: 'integer', minimum: 1 },
      content: { ref: 'KnowledgeDraftInput' },
      visibility: { ref: 'Visibility' },
      review_status: REVIEW_STATUS,
    },
  },

  RegistrationDraft: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'revision', 'content', 'review_status'],
    properties: {
      id: uuid(),
      revision: { type: 'integer', minimum: 1 },
      content: { ref: 'RegistrationDraftInput' },
      review_status: REVIEW_STATUS,
    },
  },

  Restriction: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'revision', 'content', 'review_status'],
    properties: {
      id: uuid(),
      revision: { type: 'integer', minimum: 1 },
      content: { ref: 'RestrictionInput' },
      review_status: REVIEW_STATUS,
    },
  },

  AuditEvent: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'action', 'scope', 'target_ref', 'reason_code', 'request_id', 'result', 'created_at'],
    properties: {
      id: uuid(),
      action: str(1, 80),
      scope: str(1, 80),
      target_ref: { ref: 'TargetRef', nullable: true },
      reason_code: str(1, 80),
      request_id: uuid(),
      result: enumOf('accepted', 'denied', 'failed'),
      created_at: datetime(),
    },
  },
} as const satisfies Readonly<Record<string, FieldSpec>>;

/** 分页 schema（列表响应体）：`items` + `next_cursor`。 */
function pageOf(itemRef: string, itemSpec: FieldSpec): FieldSpec {
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

/** 分页信封：`data` + `meta`。契约里每个分页都这样包一层。 */
function envelopeOf(dataRef: string): FieldSpec {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['data', 'meta'],
    properties: { data: { ref: dataRef }, meta: { ref: 'Meta' } },
  };
}

export const PAGE_SPECS = {
  SourceDraftPage: pageOf('SourceDraft', OUTPUT_SPECS.SourceDraft),
  KnowledgeDraftPage: pageOf('KnowledgeDraft', OUTPUT_SPECS.KnowledgeDraft),
  RegistrationDraftPage: pageOf('RegistrationDraft', OUTPUT_SPECS.RegistrationDraft),
  RestrictionPage: pageOf('Restriction', OUTPUT_SPECS.Restriction),
  AuditEventPage: pageOf('AuditEvent', OUTPUT_SPECS.AuditEvent),
} as const satisfies Readonly<Record<string, FieldSpec>>;

export const ENVELOPE_SPECS = {
  SourceDraftEnvelope: envelopeOf('SourceDraft'),
  SourceDraftPageEnvelope: envelopeOf('SourceDraftPage'),
  KnowledgeDraftEnvelope: envelopeOf('KnowledgeDraft'),
  KnowledgeDraftPageEnvelope: envelopeOf('KnowledgeDraftPage'),
  RegistrationDraftEnvelope: envelopeOf('RegistrationDraft'),
  RegistrationDraftPageEnvelope: envelopeOf('RegistrationDraftPage'),
  RestrictionEnvelope: envelopeOf('Restriction'),
  RestrictionPageEnvelope: envelopeOf('RestrictionPage'),
  AuditEventPageEnvelope: envelopeOf('AuditEventPage'),
} as const satisfies Readonly<Record<string, FieldSpec>>;

/** 全部本片 schema 的解析表（校验器按名字查表，支持跨组引用）。 */
export const ALL_SPECS: Readonly<Record<string, FieldSpec>> = {
  ...INPUT_SPECS,
  ...OUTPUT_SPECS,
  ...PAGE_SPECS,
  ...ENVELOPE_SPECS,
};

/** 契约 `Error.details` 上限（maxItems: 30）。 */
export const MAX_FIELD_ERRORS = 30;

export interface ValidationIssue {
  field: string;
  code: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** JSON Schema 的 length 语义按**码点**计（不是 UTF-16 单元）。 */
const lengthOf = (value: string): number => [...value].length;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkFormat(format: string, value: string): boolean {
  switch (format) {
    case 'uuid':
      return UUID_RE.test(value);
    case 'uri': {
      try {
        const url = new URL(value);
        return url.protocol.length > 1;
      } catch {
        return false;
      }
    }
    case 'date-time':
      return DATETIME_RE.test(value) && Number.isFinite(Date.parse(value));
    default:
      // 契约里本片用到的 format 只有 uuid / uri / date-time；未知 format 不静默放行。
      return false;
  }
}

function collect(registry: Readonly<Record<string, FieldSpec>>, spec: FieldSpec, value: unknown, path: string, issues: ValidationIssue[]): void {
  if (issues.length >= MAX_FIELD_ERRORS) return;

  // 契约里存在 `{"type":"null"}` 这种"恒为 null"的字段（例如 `AdminJob.result`）。
  // 必须先于通用 null 分支处理，否则合法的 null 会被误判。
  if (spec.type === 'null') {
    if (value !== null) issues.push({ field: path, code: 'type' });
    return;
  }

  // 可空字段：契约的 anyOf [T, {type:"null"}]。null 是合法值，但键仍必须存在（由父层 required 保证）。
  if (value === null) {
    if (spec.nullable !== true) issues.push({ field: path, code: 'type' });
    return;
  }

  if (spec.ref !== undefined) {
    const target = registry[spec.ref];
    if (target === undefined) {
      issues.push({ field: path, code: 'spec_missing' });
      return;
    }
    collect(registry, target, value, path, issues);
    return;
  }

  if (spec.const !== undefined) {
    if (value !== spec.const) issues.push({ field: path, code: 'const' });
    return;
  }

  if (spec.enum !== undefined) {
    if (typeof value !== 'string' || !spec.enum.includes(value)) issues.push({ field: path, code: 'enum' });
    return;
  }

  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') {
        issues.push({ field: path, code: 'type' });
        return;
      }
      const size = lengthOf(value);
      if (spec.minLength !== undefined && size < spec.minLength) issues.push({ field: path, code: 'min_length' });
      if (spec.maxLength !== undefined && size > spec.maxLength) issues.push({ field: path, code: 'max_length' });
      if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(value)) issues.push({ field: path, code: 'pattern' });
      if (spec.format !== undefined && !checkFormat(spec.format, value)) issues.push({ field: path, code: 'format' });
      return;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        issues.push({ field: path, code: 'type' });
        return;
      }
      if (spec.minimum !== undefined && value < spec.minimum) issues.push({ field: path, code: 'minimum' });
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') issues.push({ field: path, code: 'type' });
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        issues.push({ field: path, code: 'type' });
        return;
      }
      if (spec.minItems !== undefined && value.length < spec.minItems) issues.push({ field: path, code: 'min_items' });
      if (spec.maxItems !== undefined && value.length > spec.maxItems) issues.push({ field: path, code: 'max_items' });
      const items = spec.items;
      if (items !== undefined) {
        for (let index = 0; index < value.length; index += 1) {
          if (issues.length >= MAX_FIELD_ERRORS) return;
          collect(registry, items, value[index], `${path}[${index}]`, issues);
        }
      }
      return;
    }
    case 'object': {
      if (!isPlainObject(value)) {
        issues.push({ field: path, code: 'type' });
        return;
      }
      const properties = spec.properties ?? {};
      for (const key of spec.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          issues.push({ field: path === '' ? key : `${path}.${key}`, code: 'required' });
        }
      }
      for (const [key, child] of Object.entries(value)) {
        if (issues.length >= MAX_FIELD_ERRORS) return;
        const childPath = path === '' ? key : `${path}.${key}`;
        const childSpec = properties[key];
        if (childSpec === undefined) {
          // 契约声明 additionalProperties:false：多余字段一律拒绝。
          if (spec.additionalProperties === false) issues.push({ field: childPath, code: 'additional_property' });
          continue;
        }
        collect(registry, childSpec, child, childPath, issues);
      }
      return;
    }
    default:
      // 没有 type 也没有 ref / const / enum 的 spec 属于镜像不完整：不静默放行。
      issues.push({ field: path, code: 'spec_incomplete' });
  }
}

/**
 * 按 schema 名收集字段级问题。
 * `value` 必须已确认存在（缺必填顶层体由调用方映射为 `required`）。
 */
export function collectIssues(specName: string, value: unknown): ValidationIssue[] {
  const spec = ALL_SPECS[specName];
  if (spec === undefined) throw new Error(`契约镜像表缺少 schema：${specName}`);
  const issues: ValidationIssue[] = [];
  collect(ALL_SPECS, spec, value, '', issues);
  return issues;
}

/** 入参校验（fail-closed）：任何契约不符一律 `INVALID_REQUEST`，并带上字段级 details。 */
export function assertContractInput(specName: string, value: unknown): void {
  const spec = ALL_SPECS[specName];
  if (spec === undefined) throw new Error(`契约镜像表缺少 schema：${specName}`);
  assertInputWith(ALL_SPECS, specName, value);
}

function assertInputWith(registry: Readonly<Record<string, FieldSpec>>, specName: string, value: unknown): void {
  if (value === undefined) {
    throw new ApiError('INVALID_REQUEST', '缺少请求体', { details: [{ field: '', code: 'required' }] });
  }
  const spec = registry[specName];
  if (spec === undefined) throw new Error(`契约镜像表缺少 schema：${specName}`);
  const issues: ValidationIssue[] = [];
  collect(registry, spec, value, '', issues);
  if (issues.length > 0) {
    const details: FieldError[] = issues.map((issue) => ({ field: issue.field === '' ? '(body)' : issue.field, code: issue.code }));
    throw new ApiError('INVALID_REQUEST', '请求体不符合契约字段约束', { details });
  }
}

/**
 * 用**同一套解析与判定实现**针对另一张 schema 注册表建校验函数。
 *
 * 用途（GY-I18 阶段 1b）：阶段 1b 的后台运营/开关切片有自己的镜像表
 * （`admin/ops/fields.ts`），但它**复用**这里的实现，不另写第二套校验器——
 * 避免"两套校验语义各自演化"。
 */
export interface SpecValidator {
  collectIssues(specName: string, value: unknown): ValidationIssue[];
  assertInput(specName: string, value: unknown): void;
}

export function createSpecValidator(registry: Readonly<Record<string, FieldSpec>>): SpecValidator {
  return {
    collectIssues(specName, value) {
      const spec = registry[specName];
      if (spec === undefined) throw new Error(`契约镜像表缺少 schema：${specName}`);
      const issues: ValidationIssue[] = [];
      collect(registry, spec, value, '', issues);
      return issues;
    },
    assertInput(specName, value) {
      assertInputWith(registry, specName, value);
    },
  };
}
