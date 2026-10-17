/**
 * GY-I01 共享作业面 · **`JobResult.value` 各分支的完整契约校验**（回应监工 `5497968362` 的 P2）。
 *
 * 监工反例（本条最早被漏掉的那一类）：独立构造 `recognition/succeeded`，`result.value` 为
 * `null` / `{}` / 只带 `candidates`+`uncertainty_reasons` —— **三者都会被当成 200 透出**。
 * 根因是共享守卫只用 `result.kind === Job.kind` 代替了分支 schema 校验。
 *
 * 本文件覆盖：
 * - **镜像与契约逐项一致**（读 `packages/contracts/openapi.json` 原文比对键集合/必填/类型/闭集/上界 ⇒ 防手抄漂移）；
 * - **6 个 kind 的正控制**（契约合法的 succeeded 结果仍被接受，形状不变）；
 * - **负例**：监工那三条 + 每个分支的「缺必填 / 类型错 / 闭集或上界违例 / 多余字段」+ 一条**深层嵌套**违例；
 * - 统一拒绝通道：503 `PROVIDER_UNAVAILABLE`（`retryable`，与 `admin/ops/service.ts` 的 `portIntegrityFailure` 同机制）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RESULT_VALUE_SCHEMA_OF_KIND,
  RESULT_VALUE_SHAPES,
  collectResultValueIssues,
  collectShapeIssues,
} from '../../services/api/src/jobs/result-shape.ts';
import { assertContractJob } from '../../services/api/src/jobs/registry.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const openapi = JSON.parse(readFileSync(resolve(root, 'packages/contracts/openapi.json'), 'utf8'));
const S = openapi.components.schemas;

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const AT = '2026-10-12T00:00:00.000Z';

// ---------------------------------------------------------------- 契约合法的 value 夹具（六分支）

/** 一个契约合法的 `DoseCard`（用于深层嵌套反例；字段与 `DoseCard`/`Formulation`/`DoseConditions`/`DoseSource` 对齐）。 */
function validDoseCard() {
  return {
    id: ID3,
    revision: 1,
    formulation: {
      id: ID3,
      registration_number: 'PD20210001',
      producer: '合成企业',
      dosage_form: '水剂',
      ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
    },
    conditions: {
      crop_id: 'crop_rice',
      region_code: '330100',
      species_id: 'species_barnyardgrass',
      growth_stage: '3-5叶期',
      planting_method: '移栽',
      use_scene: '水稻田',
    },
    original_text: '合成用例·登记标签原文用量。',
    unit_text: '毫升/亩',
    method_text: '合成用例·定向喷雾。',
    precautions_text: '合成用例·注意事项。',
    source: {
      id: ID3,
      version: 'synthetic-1',
      title: '合成用例用量资料',
      url: 'https://example.invalid/dose',
      publisher: '合成用例本地库',
      source_kind: 'database',
      evidence_kind: 'mixed',
      validity: 'valid',
      review_status: 'verified',
      updated_at: AT,
    },
    locator: '合成用例·第 1 段',
    content_hash: 'a'.repeat(64),
  };
}

function validValue(kind) {
  switch (kind) {
    case 'recognition':
      return {
        id: ID,
        revision: 1,
        candidates: [{ species_id: 'species_barnyardgrass', rank: 1, model_score: 0.5 }],
        uncertainty_reasons: [],
        selected_species_id: null,
        model_version: 'stub-v1',
      };
    case 'ocr':
      return {
        id: ID,
        revision: 1,
        raw_fields: { registration_number: null, name: null, ingredients: [], dosage_form: null },
        corrected_fields: { registration_number: null, name: null, ingredients: [], dosage_form: null },
        verification: { match_state: 'insufficient', registration: null, conflict_fields: [], missing_fields: ['registration_number'], dose_cards: [] },
        model_version: 'stub-v1',
      };
    case 'transcription':
      return {
        id: ID,
        revision: 1,
        raw_text: '合成用例·转写文本',
        uncertain_spans: [{ start: 0, end: 2, reason: '合成用例·前缀' }],
        confirmed_text: null,
        confirmed_at: null,
        model_version: 'stub-v1',
      };
    case 'answer':
      return {
        id: ID,
        revision: 1,
        status: 'answered',
        checked_text: '合成用例·回答文本',
        check_state: 'passed',
        citations: [],
        dose_cards: [],
        model_version: 'stub-v1',
        prompt_version: 'prompt-1',
        rule_version: 'rules-1',
      };
    case 'synthesis':
      return { id: ID, revision: 1, checked_content_ref: { type: 'source', id: 'synthetic-source', revision: 1 }, media_id: ID2 };
    case 'moderation':
      return {
        id: ID,
        target_ref: { type: 'post', id: 'synthetic-post', revision: 1 },
        decision: 'approved',
        reason_codes: [],
        hard_rule_passed: true,
        model_version: 'model-1',
        prompt_version: 'prompt-1',
        rule_version: 'rules-1',
      };
    default:
      throw new Error('未知 kind：' + kind);
  }
}

function succeededJob(kind, value) {
  return {
    id: ID2,
    revision: 4,
    kind,
    target_ref: { type: kind === 'ocr' ? 'ocr' : kind === 'recognition' ? 'recognition' : 'transcription', id: ID3, revision: 1 },
    state: 'succeeded',
    deadline_at: AT,
    created_at: AT,
    error_code: null,
    result: { kind, value },
  };
}

const KINDS = ['recognition', 'ocr', 'transcription', 'answer', 'synthesis', 'moderation'];

function assertRejected(kind, value, label) {
  const issues = collectResultValueIssues(kind, value);
  assert.ok(Array.isArray(issues), `${label}：collectResultValueIssues 应返回数组`);
  assert.ok(issues.length > 0, `${label}：应收集到问题`);
  assert.throws(
    () => assertContractJob(succeededJob(kind, value), 'unit'),
    (error) => {
      assert.equal(error?.name, 'ApiError', `${label} 应走统一 fail-closed 通道，实际 ${error?.name}`);
      assert.equal(error?.code, 'PROVIDER_UNAVAILABLE', `${label} 错误码`);
      assert.equal(error?.status, 503, `${label} 状态码`);
      assert.equal(error?.retryable, false, `${label} retryable`);
      assert.ok(error.message.includes('result.value'), `${label} 的 message 应指向 result.value，实际：${error.message}`);
      return true;
    },
  );
}

// ---------------------------------------------------------------- 契约镜像一致性（防手抄漂移）

/** 把本模块的镜像规则归一成可比签名。 */
function ruleSignature(rule) {
  switch (rule.k) {
    case 'uuid':
      return 'string|uuid';
    case 'text': {
      const parts = ['string'];
      if (rule.min !== undefined && rule.min > 0) parts.push('min:' + rule.min);
      if (rule.max !== undefined) parts.push('max:' + rule.max);
      if (rule.pattern !== undefined) parts.push('pattern');
      return parts.join('|');
    }
    case 'nullText': {
      const parts = ['string', 'null'];
      if (rule.min !== undefined && rule.min > 0) parts.push('min:' + rule.min);
      if (rule.max !== undefined) parts.push('max:' + rule.max);
      return parts.join('|');
    }
    case 'dateTime':
      return 'datetime';
    case 'nullDateTime':
      return 'datetime|null';
    case 'int': {
      const parts = ['integer'];
      if (rule.min !== undefined) parts.push('min:' + rule.min);
      if (rule.max !== undefined) parts.push('max:' + rule.max);
      return parts.join('|');
    }
    case 'numOrNull':
      return 'number|null';
    case 'bool':
      return 'boolean';
    case 'enum':
      return 'enum:' + rule.values.join(',');
    case 'const':
      return 'const:' + rule.value;
    case 'ref':
      return 'ref:' + rule.schema;
    case 'nullRef':
      return 'ref:' + rule.schema + '|null';
    case 'arrayText':
      return 'array:string' + (rule.maxItems !== undefined ? '|maxItems:' + rule.maxItems : '');
    case 'arrayRef':
      return 'array:ref:' + rule.schema + (rule.maxItems !== undefined ? '|maxItems:' + rule.maxItems : '');
    default:
      return 'unknown';
  }
}

/** 把契约字段归一成同一套签名（`format: uri` 等本镜像不断言的格式不参与比较）。 */
function contractSignature(prop) {
  if (prop.const !== undefined) return 'const:' + prop.const;
  if (prop.enum) return 'enum:' + prop.enum.join(',');
  if (prop.$ref) {
    // `$ref` 指向**具名枚举**（如 MatchState/SourceKind/EvidenceKind/AuditState）时按闭集比较；指向对象时按 ref 比较。
    const target = S[prop.$ref.split('/').pop()];
    if (target && target.enum && !target.properties) return 'enum:' + target.enum.join(',');
    return 'ref:' + prop.$ref.split('/').pop();
  }
  if (prop.anyOf) {
    const branches = prop.anyOf.map((b) => {
      if (b.type === 'null') return 'null';
      if (b.$ref) return 'ref:' + b.$ref.split('/').pop();
      if (b.type === 'string' && b.format === 'date-time') return 'datetime';
      return b.type;
    });
    if (branches.includes('datetime')) return 'datetime|null';
    const nonNull = prop.anyOf.find((b) => b.type !== 'null') ?? {};
    const parts = [...branches];
    if (nonNull.minLength !== undefined && nonNull.minLength > 0) parts.push('min:' + nonNull.minLength);
    if (nonNull.maxLength !== undefined) parts.push('max:' + nonNull.maxLength);
    return parts.join('|');
  }
  if (prop.type === 'array') {
    const item = prop.items?.$ref ? 'ref:' + prop.items.$ref.split('/').pop() : (prop.items?.type ?? '?');
    return 'array:' + item + (prop.maxItems !== undefined ? '|maxItems:' + prop.maxItems : '');
  }
  const parts = [prop.type === 'integer' ? 'integer' : prop.type];
  if (prop.type === 'string' && prop.format === 'uuid') parts.push('uuid');
  if (prop.type === 'string' && prop.format === 'date-time') return 'datetime';
  if (prop.minLength !== undefined && prop.minLength > 0) parts.push('min:' + prop.minLength);
  if (prop.maxLength !== undefined) parts.push('max:' + prop.maxLength);
  if (prop.pattern !== undefined) parts.push('pattern');
  if (prop.minimum !== undefined) parts.push('min:' + prop.minimum);
  if (prop.maximum !== undefined) parts.push('max:' + prop.maximum);
  return parts.join('|');
}

test('契约一致性·六个分支的 value 实体映射与 JobResult.oneOf 逐项一致', () => {
  const oneOf = S.JobResult.oneOf.map((branch) => branch.$ref.split('/').pop());
  assert.equal(oneOf.length, 6);
  for (const kind of KINDS) {
    const resultName = kind === 'ocr' ? 'OCRResult' : kind[0].toUpperCase() + kind.slice(1) + 'Result';
    assert.ok(oneOf.includes(resultName), `${kind} 的分支 ${resultName} 应在 JobResult.oneOf 内`);
    const branch = S[resultName];
    assert.equal(branch.additionalProperties, false, `${resultName} 必须 additionalProperties:false`);
    assert.deepEqual([...branch.required].sort(), ['kind', 'value']);
    assert.equal(branch.properties.kind.const, kind, `${resultName}.kind 必须是 const ${kind}`);
    const entityName = branch.properties.value.$ref.split('/').pop();
    assert.equal(RESULT_VALUE_SCHEMA_OF_KIND[kind], entityName, `${kind} 的镜像实体必须与契约 $ref 一致`);
  }
});

test('契约一致性·镜像表的键集合/必填/类型/闭集/上界与 openapi **逐字段**相同（防手抄漂移）', () => {
  let compared = 0;
  for (const [shapeName, shape] of Object.entries(RESULT_VALUE_SHAPES)) {
    const schema = S[shapeName];
    assert.ok(schema, `契约里必须存在 schema ${shapeName}`);
    assert.equal(schema.additionalProperties, false, `${shapeName} 必须 additionalProperties:false`);
    assert.deepEqual(
      Object.keys(shape).sort(),
      Object.keys(schema.properties).sort(),
      `${shapeName} 的键集合必须与契约一致`,
    );
    assert.deepEqual(
      [...schema.required].sort(),
      Object.keys(schema.properties).sort(),
      `${shapeName} 契约里所有属性都必须 required（镜像按全必填编码）`,
    );
    for (const [field, rule] of Object.entries(shape)) {
      assert.equal(
        ruleSignature(rule),
        contractSignature(schema.properties[field]),
        `${shapeName}.${field} 的镜像规则与契约不一致`,
      );
      compared += 1;
    }
  }
  assert.ok(compared >= 80, `至少比对了 80 个字段，实际 ${compared}`);
});

// ---------------------------------------------------------------- 正控制

test('正控制·六个分支的契约合法 succeeded 结果一律被接受，且出口为重建的新对象', () => {
  for (const kind of KINDS) {
    const value = validValue(kind);
    const job = assertContractJob(succeededJob(kind, value), 'unit');
    assert.equal(job.result.kind, kind, `${kind} 的 result.kind`);
    assert.deepEqual(job.result.value, value, `${kind} 的 result.value 应原样（重建后内容相同）`);
    assert.notEqual(job.result.value, value, `${kind} 的 result.value 必须深拷贝`);
  }
  assert.equal(collectResultValueIssues('recognition', validValue('recognition')).length, 0);
});

// ---------------------------------------------------------------- 监工的三条反例

test('反例（监工 5497968362）·recognition/succeeded 的 result.value 为 null / {} / 只带两字段 ⇒ 一律拒绝', () => {
  assertRejected('recognition', null, 'value=null');
  assertRejected('recognition', {}, 'value={}');
  assertRejected('recognition', { candidates: [], uncertainty_reasons: [] }, 'value 只带 candidates/uncertainty_reasons');
  // 逐条给出可单独指出的问题（缺 id/revision/selected_species_id/model_version）
  const issues = collectResultValueIssues('recognition', { candidates: [], uncertainty_reasons: [] });
  assert.ok(issues.some((issue) => issue.includes('键集合')), '应指出键集合不合契约');
});

test('反例·同一形状在六个分支上都拒绝 null / {} 与"只带部分字段"', () => {
  for (const kind of KINDS) {
    assertRejected(kind, null, `${kind}: value=null`);
    assertRejected(kind, {}, `${kind}: value={}`);
    const partial = { id: ID };
    assertRejected(kind, partial, `${kind}: 只带 id`);
  }
});

// ---------------------------------------------------------------- 每分支四类变异

test('反例·每个分支的「缺必填 / 类型错 / 闭集或上界违例 / 多余字段」逐条拒绝', () => {
  /** 深/浅路径设值（支持数组下标），返回新对象。 */
  function setPath(value, path, next) {
    const clone = structuredClone(value);
    const keys = path.split('.');
    let cursor = clone;
    for (const key of keys.slice(0, -1)) cursor = cursor[key];
    cursor[keys.at(-1)] = next;
    return clone;
  }
  const cases = [
    ['recognition', '缺必填 selected_species_id', (v) => { const c = structuredClone(v); delete c.selected_species_id; return c; }],
    ['recognition', 'revision 为字符串', (v) => setPath(v, 'revision', '1')],
    ['recognition', 'candidates[0].rank 超出 1..3', (v) => setPath(v, 'candidates.0.rank', 4)],
    ['recognition', '多余字段', (v) => ({ ...structuredClone(v), extra: 1 })],
    ['ocr', '缺必填 verification', (v) => { const c = structuredClone(v); delete c.verification; return c; }],
    ['ocr', 'revision 为字符串', (v) => setPath(v, 'revision', '1')],
    ['ocr', 'verification.match_state 闭集外', (v) => setPath(v, 'verification.match_state', 'unknown_state')],
    ['ocr', '多余字段', (v) => ({ ...structuredClone(v), extra: 1 })],
    ['transcription', '缺必填 uncertain_spans', (v) => { const c = structuredClone(v); delete c.uncertain_spans; return c; }],
    ['transcription', 'raw_text 类型错（数字）', (v) => setPath(v, 'raw_text', 123)],
    ['transcription', 'uncertain_spans[0].start 为负（minimum 0）', (v) => setPath(v, 'uncertain_spans.0.start', -1)],
    ['transcription', '多余字段', (v) => ({ ...structuredClone(v), extra: 1 })],
    ['answer', '缺必填 citations', (v) => { const c = structuredClone(v); delete c.citations; return c; }],
    ['answer', 'revision 为字符串', (v) => setPath(v, 'revision', '1')],
    ['answer', 'status 闭集外', (v) => setPath(v, 'status', 'unknown_status')],
    ['answer', '多余字段', (v) => ({ ...structuredClone(v), extra: 1 })],
    ['synthesis', '缺必填 media_id', (v) => { const c = structuredClone(v); delete c.media_id; return c; }],
    ['synthesis', 'media_id 非 uuid', (v) => setPath(v, 'media_id', 'not-a-uuid')],
    ['synthesis', 'checked_content_ref.type 闭集外', (v) => setPath(v, 'checked_content_ref.type', 'not_a_type')],
    ['synthesis', '多余字段', (v) => ({ ...structuredClone(v), extra: 1 })],
    ['moderation', '缺必填 decision', (v) => { const c = structuredClone(v); delete c.decision; return c; }],
    ['moderation', 'hard_rule_passed 类型错（字符串）', (v) => setPath(v, 'hard_rule_passed', 'yes')],
    ['moderation', 'decision 闭集外', (v) => setPath(v, 'decision', 'unknown_decision')],
    ['moderation', '多余字段', (v) => ({ ...structuredClone(v), extra: 1 })],
  ];
  for (const [kind, label, mutate] of cases) {
    assertRejected(kind, mutate(validValue(kind)), `${kind}: ${label}`);
  }
  assert.equal(cases.length, 24, '应逐分支覆盖四类变异（6 × 4）');
});

test('反例·**深层嵌套**违例同样被拒（证明递归到 DoseCard/Conditions，而不是只看一层）', () => {
  const ocr = validValue('ocr');
  ocr.verification.dose_cards = [validDoseCard()];
  assert.equal(collectResultValueIssues('ocr', ocr).length, 0, '深层合法的 DoseCard 必须先被接受');

  const badRegion = structuredClone(ocr);
  badRegion.verification.dose_cards[0].conditions.region_code = '310100'; // 违反 ^33[0-9]{4}$
  const issues = collectResultValueIssues('ocr', badRegion);
  assert.ok(issues.length > 0, '深层 region_code 违例必须被发现');
  assert.ok(issues.some((issue) => issue.includes('region_code')), `问题应指向 region_code，实际 ${JSON.stringify(issues)}`);
  assertRejected('ocr', badRegion, '深层 region_code 违例');

  const badHash = structuredClone(ocr);
  badHash.verification.dose_cards[0].content_hash = 'not-a-hash';
  assertRejected('ocr', badHash, '深层 content_hash 违例');

  const badKey = structuredClone(ocr);
  badKey.verification.dose_cards[0].extra = 1;
  assertRejected('ocr', badKey, '深层多余字段违例');
});

test('镜像工具·collectShapeIssues 对非对象/键集合/必填均给出可读原因', () => {
  assert.ok(collectShapeIssues('TargetRef', null)[0].includes('必须是对象'));
  assert.ok(collectShapeIssues('TargetRef', {})[0].includes('键集合'));
  const issues = collectShapeIssues('TargetRef', { type: 'post', id: 'x', revision: 0 });
  assert.ok(issues.some((issue) => issue.includes('revision')), JSON.stringify(issues));
});
