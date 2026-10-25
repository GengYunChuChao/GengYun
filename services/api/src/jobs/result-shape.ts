/**
 * GY-I01 跨 kind 作业读面/取消面 · **`JobResult.value` 各分支的契约镜像**（嵌套结果的完整形状校验）。
 *
 * 为什么需要它（监工 `5497968362` 的 P2）：共享守卫此前只校验 `result.kind === Job.kind`，
 * **没有校验 `result.value` 的分支 schema** ⇒ `value=null` / `value={}` / `value` 只带
 * `candidates`+`uncertainty_reasons` 这类**不合契约的成功结果会被当作 200 `JobEnvelope` 透出**。
 * 本模块把契约里**六个分支的嵌套实体**逐项落成镜像表并递归校验：必填、类型、闭集（`enum`/`const`）、
 * 长度/上界/`pattern`，以及 `additionalProperties:false`（键集合必须**恰好**等于契约声明）。
 *
 * 契约来源（`packages/contracts/openapi.json`，**逐项抄录，不凭记忆**）：
 *   `JobResult.oneOf` = `RecognitionResult | OCRResult | TranscriptionResult | AnswerResult | SynthesisResult | ModerationResult`
 *   各 `*Result` = `{ kind: const(<kind>), value: <实体> }`（`additionalProperties:false`，`required:[kind,value]`）
 *   实体：`Recognition` / `OCR` / `Transcription` / `Answer` / `Synthesis` / `Moderation`
 *   嵌套：`Candidate` `LabelFields` `Ingredient` `Verification` `Herbicide` `DoseCard` `Formulation`
 *         `DoseConditions` `DoseSource` `SourceRef` `UncertainSpan` `TargetRef`
 *   （本表覆盖的每个 schema 的全部属性**都**在契约 `required` 里，故镜像按"全必填"编码；
 *    `tests/unit/jobs-registry.test.mjs` 会读契约原文逐项比对键集合/必填/类型/闭集/上界，防手抄漂移。）
 *
 * 拒绝通道：**沿用仓库既有"端口回传不可信 ⇒ fail-closed 503"机制**
 * （先例 `services/api/src/admin/ops/service.ts` 的 `portIntegrityFailure` / `assertJobContract`），
 * 由 `registry.ts` 统一抛出，**不新造第二套错误通道、不放宽冻结契约**。
 */
import type { JobKind } from './registry.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const REGION_CODE_PATTERN = /^33[0-9]{4}$/;
const HTTPS_PATTERN = /^https:\/\//;

/** 契约闭集（逐项抄录）。 */
export const MATCH_STATES = ['matched', 'no_match', 'ambiguous', 'conflict', 'insufficient', 'unavailable'] as const;
export const SOURCE_KINDS = ['database', 'verified_seed', 'simulation'] as const;
export const EVIDENCE_KINDS = ['research', 'experience', 'mixed'] as const;
export const SOURCE_VALIDITY = ['valid', 'expired', 'conflicting', 'unknown', 'withdrawn'] as const;
export const REVIEW_STATUS = ['unverified', 'verified', 'rejected'] as const;
export const AUDIT_STATES = ['pending', 'approved', 'rejected', 'quarantined'] as const;
export const ANSWER_STATUS = ['answered', 'insufficient', 'blocked'] as const;
export const CHECK_STATES = ['passed', 'blocked'] as const;
export const REFERENCE_STATES = ['available', 'unavailable'] as const;
export const DOSE_SOURCE_KINDS = ['database', 'verified_seed'] as const;
export const DOSE_EVIDENCE_KINDS = ['research', 'mixed'] as const;
export const TARGET_REF_TYPES = [
  'species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr', 'transcription',
  'answer', 'post', 'comment', 'conversation', 'conversation_turn', 'dose_card', 'media', 'synthesis', 'job', 'source',
] as const;

type Rule =
  | { k: 'uuid' }
  | { k: 'text'; min?: number; max?: number; pattern?: RegExp }
  | { k: 'nullText'; min?: number; max?: number }
  | { k: 'nullDateTime' }
  | { k: 'dateTime' }
  | { k: 'int'; min?: number; max?: number }
  | { k: 'numOrNull' }
  | { k: 'bool' }
  | { k: 'enum'; values: readonly string[] }
  | { k: 'const'; value: string }
  | { k: 'ref'; schema: ShapeName }
  | { k: 'nullRef'; schema: ShapeName }
  | { k: 'arrayText'; maxItems?: number }
  | { k: 'arrayRef'; schema: ShapeName; maxItems?: number };

type ShapeName =
  | 'Recognition' | 'Candidate' | 'OCR' | 'LabelFields' | 'Ingredient' | 'Verification' | 'Herbicide'
  | 'DoseCard' | 'Formulation' | 'DoseConditions' | 'DoseSource' | 'SourceRef'
  | 'Transcription' | 'UncertainSpan' | 'Answer' | 'Synthesis' | 'TargetRef' | 'Moderation';

/**
 * 各 `kind` 的 `result.value` 实体 schema（`JobResult` 判别子 ⇒ 实体）。
 * 逐项对应契约 `XxxResult.properties.value.$ref`。
 */
export const RESULT_VALUE_SCHEMA_OF_KIND: Readonly<Record<JobKind, ShapeName>> = {
  recognition: 'Recognition',
  ocr: 'OCR',
  transcription: 'Transcription',
  answer: 'Answer',
  synthesis: 'Synthesis',
  moderation: 'Moderation',
};

/** 镜像表：每个 schema 的**全部**属性（契约里这些 schema 的属性全部 required）。 */
export const RESULT_VALUE_SHAPES: Readonly<Record<ShapeName, Readonly<Record<string, Rule>>>> = {
  Recognition: {
    id: { k: 'uuid' },
    revision: { k: 'int', min: 1 },
    candidates: { k: 'arrayRef', schema: 'Candidate', maxItems: 3 },
    uncertainty_reasons: { k: 'arrayText', maxItems: 10 },
    selected_species_id: { k: 'nullText', min: 1, max: 80 },
    model_version: { k: 'text', min: 1, max: 80 },
  },
  Candidate: {
    species_id: { k: 'text', min: 1, max: 80 },
    rank: { k: 'int', min: 1, max: 3 },
    model_score: { k: 'numOrNull' },
  },
  OCR: {
    id: { k: 'uuid' },
    revision: { k: 'int', min: 1 },
    raw_fields: { k: 'ref', schema: 'LabelFields' },
    corrected_fields: { k: 'ref', schema: 'LabelFields' },
    verification: { k: 'ref', schema: 'Verification' },
    model_version: { k: 'text', min: 1, max: 80 },
  },
  LabelFields: {
    registration_number: { k: 'nullText', min: 1, max: 80 },
    name: { k: 'nullText', min: 1, max: 80 },
    ingredients: { k: 'arrayRef', schema: 'Ingredient', maxItems: 20 },
    dosage_form: { k: 'nullText', min: 1, max: 80 },
  },
  Ingredient: {
    name: { k: 'text', min: 1, max: 80 },
    content_text: { k: 'text', min: 1, max: 80 },
    unit_text: { k: 'text', min: 1, max: 80 },
  },
  Verification: {
    match_state: { k: 'enum', values: MATCH_STATES },
    registration: { k: 'nullRef', schema: 'Herbicide' },
    conflict_fields: { k: 'arrayText', maxItems: 20 },
    missing_fields: { k: 'arrayText', maxItems: 20 },
    dose_cards: { k: 'arrayRef', schema: 'DoseCard', maxItems: 10 },
  },
  Herbicide: {
    id: { k: 'uuid' },
    revision: { k: 'int', min: 1 },
    formulation: { k: 'ref', schema: 'Formulation' },
    source: { k: 'ref', schema: 'SourceRef' },
    risk_text: { k: 'text', min: 1, max: 4000 },
    reference_state: { k: 'enum', values: REFERENCE_STATES },
  },
  DoseCard: {
    id: { k: 'uuid' },
    revision: { k: 'int', min: 1 },
    formulation: { k: 'ref', schema: 'Formulation' },
    conditions: { k: 'ref', schema: 'DoseConditions' },
    original_text: { k: 'text', min: 1, max: 4000 },
    unit_text: { k: 'text', min: 1, max: 80 },
    method_text: { k: 'text', min: 1, max: 4000 },
    precautions_text: { k: 'text', min: 1, max: 4000 },
    source: { k: 'ref', schema: 'DoseSource' },
    locator: { k: 'text', min: 1, max: 200 },
    content_hash: { k: 'text', pattern: CONTENT_HASH_PATTERN },
  },
  Formulation: {
    id: { k: 'uuid' },
    registration_number: { k: 'text', min: 1, max: 80 },
    producer: { k: 'text', min: 1, max: 200 },
    dosage_form: { k: 'text', min: 1, max: 80 },
    ingredients: { k: 'arrayRef', schema: 'Ingredient', maxItems: 20 },
  },
  DoseConditions: {
    crop_id: { k: 'text', min: 1, max: 80 },
    region_code: { k: 'text', pattern: REGION_CODE_PATTERN },
    species_id: { k: 'text', min: 1, max: 80 },
    growth_stage: { k: 'text', min: 1, max: 80 },
    planting_method: { k: 'text', min: 1, max: 80 },
    use_scene: { k: 'text', min: 1, max: 80 },
  },
  DoseSource: {
    id: { k: 'uuid' },
    version: { k: 'text', min: 1, max: 80 },
    title: { k: 'text', min: 1, max: 200 },
    url: { k: 'text', pattern: HTTPS_PATTERN },
    publisher: { k: 'text', min: 1, max: 200 },
    source_kind: { k: 'enum', values: DOSE_SOURCE_KINDS },
    evidence_kind: { k: 'enum', values: DOSE_EVIDENCE_KINDS },
    validity: { k: 'const', value: 'valid' },
    review_status: { k: 'const', value: 'verified' },
    updated_at: { k: 'dateTime' },
  },
  SourceRef: {
    id: { k: 'uuid' },
    version: { k: 'text', min: 1, max: 80 },
    title: { k: 'text', min: 1, max: 200 },
    url: { k: 'text', pattern: HTTPS_PATTERN },
    publisher: { k: 'text', min: 1, max: 200 },
    source_kind: { k: 'enum', values: SOURCE_KINDS },
    evidence_kind: { k: 'enum', values: EVIDENCE_KINDS },
    validity: { k: 'enum', values: SOURCE_VALIDITY },
    review_status: { k: 'enum', values: REVIEW_STATUS },
    updated_at: { k: 'dateTime' },
  },
  Transcription: {
    id: { k: 'uuid' },
    revision: { k: 'int', min: 1 },
    raw_text: { k: 'text', min: 0, max: 8000 },
    uncertain_spans: { k: 'arrayRef', schema: 'UncertainSpan', maxItems: 100 },
    confirmed_text: { k: 'nullText', min: 1, max: 8000 },
    confirmed_at: { k: 'nullDateTime' },
    model_version: { k: 'text', min: 1, max: 80 },
  },
  UncertainSpan: {
    start: { k: 'int', min: 0 },
    end: { k: 'int', min: 1 },
    reason: { k: 'text', min: 1, max: 80 },
  },
  Answer: {
    id: { k: 'uuid' },
    revision: { k: 'int', min: 1 },
    status: { k: 'enum', values: ANSWER_STATUS },
    checked_text: { k: 'text', min: 1, max: 16000 },
    check_state: { k: 'enum', values: CHECK_STATES },
    citations: { k: 'arrayRef', schema: 'SourceRef', maxItems: 20 },
    dose_cards: { k: 'arrayRef', schema: 'DoseCard', maxItems: 10 },
    model_version: { k: 'text', min: 1, max: 80 },
    prompt_version: { k: 'text', min: 1, max: 80 },
    rule_version: { k: 'text', min: 1, max: 80 },
  },
  Synthesis: {
    id: { k: 'uuid' },
    revision: { k: 'int', min: 1 },
    checked_content_ref: { k: 'ref', schema: 'TargetRef' },
    media_id: { k: 'uuid' },
  },
  TargetRef: {
    type: { k: 'enum', values: TARGET_REF_TYPES },
    id: { k: 'text', min: 1, max: 80 },
    revision: { k: 'int', min: 1 },
  },
  Moderation: {
    id: { k: 'uuid' },
    target_ref: { k: 'ref', schema: 'TargetRef' },
    decision: { k: 'enum', values: AUDIT_STATES },
    reason_codes: { k: 'arrayText', maxItems: 30 },
    hard_rule_passed: { k: 'bool' },
    model_version: { k: 'text', min: 1, max: 80 },
    prompt_version: { k: 'text', min: 1, max: 80 },
    rule_version: { k: 'text', min: 1, max: 80 },
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDateTime(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** 按规则收集单个字段的问题（返回人类可读原因，空数组 = 合规）。 */
function collectFieldIssues(rule: Rule, value: unknown, path: string): string[] {
  switch (rule.k) {
    case 'uuid':
      return typeof value === 'string' && UUID_PATTERN.test(value) ? [] : [`${path} 必须是 uuid`];
    case 'text': {
      if (typeof value !== 'string') return [`${path} 必须是字符串`];
      if (rule.min !== undefined && value.length < rule.min) return [`${path} 长度不得小于 ${rule.min}`];
      if (rule.max !== undefined && value.length > rule.max) return [`${path} 长度不得超过 ${rule.max}`];
      if (rule.pattern !== undefined && !rule.pattern.test(value)) return [`${path} 不符合契约 pattern`];
      return [];
    }
    case 'nullText':
      if (value === null) return [];
      if (typeof value !== 'string') return [`${path} 必须是字符串或 null`];
      if (rule.min !== undefined && value.length < rule.min) return [`${path} 长度不得小于 ${rule.min}`];
      if (rule.max !== undefined && value.length > rule.max) return [`${path} 长度不得超过 ${rule.max}`];
      return [];
    case 'nullDateTime':
      return value === null || isDateTime(value) ? [] : [`${path} 必须是 date-time 字符串或 null`];
    case 'dateTime':
      return isDateTime(value) ? [] : [`${path} 必须是 date-time 字符串`];
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) return [`${path} 必须是整数`];
      if (rule.min !== undefined && value < rule.min) return [`${path} 不得小于 ${rule.min}`];
      if (rule.max !== undefined && value > rule.max) return [`${path} 不得大于 ${rule.max}`];
      return [];
    case 'numOrNull':
      if (value === null) return [];
      return typeof value === 'number' && Number.isFinite(value) ? [] : [`${path} 必须是有限数或 null`];
    case 'bool':
      return typeof value === 'boolean' ? [] : [`${path} 必须是布尔值`];
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value !== null ? String(value) : '')
        ? []
        : [`${path} 必须是契约闭集成员（${rule.values.join('|')}）`];
    case 'const':
      return value === rule.value ? [] : [`${path} 必须是 ${JSON.stringify(rule.value)}`];
    case 'ref':
    case 'nullRef': {
      if (value === null) return rule.k === 'nullRef' ? [] : [`${path} 不得为 null`];
      if (!isPlainObject(value)) return [`${path} 必须是对象${rule.k === 'nullRef' ? '或 null' : ''}`];
      return collectShapeIssues(rule.schema, value, path);
    }
    case 'arrayText': {
      if (!Array.isArray(value)) return [`${path} 必须是数组`];
      if (rule.maxItems !== undefined && value.length > rule.maxItems) return [`${path} 项数不得超过 ${rule.maxItems}`];
      return value.flatMap((item, index) => (typeof item === 'string' ? [] : [`${path}[${index}] 必须是字符串`]));
    }
    case 'arrayRef': {
      if (!Array.isArray(value)) return [`${path} 必须是数组`];
      if (rule.maxItems !== undefined && value.length > rule.maxItems) return [`${path} 项数不得超过 ${rule.maxItems}`];
      return value.flatMap((item, index) =>
        isPlainObject(item) ? collectShapeIssues(rule.schema, item, `${path}[${index}]`) : [`${path}[${index}] 必须是对象`],
      );
    }
    default:
      return [`${path} 的镜像规则缺失`];
  }
}

/** 按镜像表收集一个对象 schema 的问题：`additionalProperties:false` + 全必填 + 逐字段规则。 */
export function collectShapeIssues(schema: ShapeName, value: unknown, path: string = schema): string[] {
  const shape = RESULT_VALUE_SHAPES[schema];
  const issues: string[] = [];
  if (!isPlainObject(value)) return [`${path} 必须是对象`];
  const expected = Object.keys(shape).sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    issues.push(`${path} 的键集合必须恰好是契约声明的 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
    return issues;
  }
  for (const [key, rule] of Object.entries(shape)) {
    issues.push(...collectFieldIssues(rule, value[key], `${path}.${key}`));
  }
  return issues;
}

/**
 * 校验某个 `kind` 的 `result.value` 是否为**契约合法的实体**（递归到全部嵌套 schema）。
 * 返回问题清单（空 = 合法）；调用方（`registry.ts`）据此走统一的 fail-closed 拒绝通道。
 */
export function collectResultValueIssues(kind: JobKind, value: unknown): string[] {
  return collectShapeIssues(RESULT_VALUE_SCHEMA_OF_KIND[kind], value, `${kind}.result.value`);
}
