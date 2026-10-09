// GY-I07 契约一致性：本地枚举与 packages/contracts/openapi.json + states.json 对齐。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTRACT_VERSION,
  SOURCE_KINDS,
  EVIDENCE_KINDS,
  KNOWLEDGE_TYPES,
  REFERENCE_STATES,
  MATCH_STATES,
  SOURCE_VALIDITIES,
  REVIEW_STATUSES,
  VISIBILITIES,
  COVERAGE_STATES,
  EXECUTION_MODES,
  ERROR_CODES,
  ERROR_STATUS_MAP,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  REGION_CODE_PATTERN,
} from '../../packages/reference/index.mjs';

const states = JSON.parse(
  readFileSync(new URL('../../packages/contracts/states.json', import.meta.url), 'utf8'),
);
const openapi = JSON.parse(
  readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'),
);
const schemas = openapi.components.schemas;
const params = openapi.components.parameters;

test('contract_version 与 states.json 一致', () => {
  assert.equal(CONTRACT_VERSION, states.contract_version);
});

test('states.json 中的本域枚举完全一致（SourceKind/EvidenceKind/MatchState/ReferenceState/Visibility/ExecutionMode）', () => {
  assert.deepEqual([...SOURCE_KINDS], states.states.SourceKind);
  assert.deepEqual([...EVIDENCE_KINDS], states.states.EvidenceKind);
  assert.deepEqual([...MATCH_STATES], states.states.MatchState);
  assert.deepEqual([...REFERENCE_STATES], states.states.ReferenceState);
  assert.deepEqual([...VISIBILITIES], states.states.Visibility);
  assert.deepEqual([...EXECUTION_MODES], states.states.ExecutionMode);
});

test('KNOWLEDGE_TYPES 取自 Knowledge.type 枚举（契约内联，无独立 states 项）', () => {
  assert.deepEqual([...KNOWLEDGE_TYPES], schemas.Knowledge.properties.type.enum);
});

test('SourceRef.validity / review_status 与契约内联枚举一致', () => {
  assert.deepEqual([...SOURCE_VALIDITIES], schemas.SourceRef.properties.validity.enum);
  assert.deepEqual([...REVIEW_STATUSES], schemas.SourceRef.properties.review_status.enum);
});

test('CoverageState 取自 Species.coverage_state 枚举', () => {
  assert.deepEqual([...COVERAGE_STATES], schemas.Species.properties.coverage_state.enum);
});

test('错误码为契约 ErrorCode 枚举的子集，且每个错误码的 HTTP 状态与契约 error_status_map 一致', () => {
  const contractCodes = new Set(schemas.ErrorCode.enum);
  for (const code of ERROR_CODES) {
    assert.ok(contractCodes.has(code), `错误码 ${code} 不在契约 ErrorCode 枚举内`);
  }
  // ERROR_STATUS_MAP 为 code -> status；须与契约 error_status_map（status -> codes）互证。
  for (const [code, status] of Object.entries(ERROR_STATUS_MAP)) {
    const codesAtStatus = states.error_status_map[String(status)];
    assert.ok(codesAtStatus, `状态 ${status} 不在契约 error_status_map 内`);
    assert.ok(
      codesAtStatus.includes(code),
      `错误码 ${code} 未列入契约状态 ${status} 的映射`,
    );
  }
});

test('分页默认与上限与契约 Limit/Cursor 参数一致', () => {
  assert.equal(params.Limit.schema.default, DEFAULT_LIMIT);
  assert.equal(params.Limit.schema.maximum, MAX_LIMIT);
  assert.equal(params.Limit.schema.minimum, 1);
  assert.equal(params.Cursor.schema.maxLength, 2048);
  assert.equal(params.Cursor.name, 'cursor');
});

test('地区编码正则与契约 Region.code pattern 一致', () => {
  assert.equal(REGION_CODE_PATTERN.source, schemas.Region.properties.code.pattern);
});

test('本域相关端点存在于契约且为用户作用域', () => {
  for (const path of [
    '/herbicides',
    '/herbicides/{id}',
    '/knowledge',
    '/knowledge/{id}',
    '/catalog/crops',
    '/catalog/species',
    '/catalog/regions',
  ]) {
    assert.ok(openapi.paths[path], `契约缺少端点 ${path}`);
  }
  assert.equal(openapi.paths['/herbicides'].get['x-scope'], 'user');
  assert.equal(openapi.paths['/herbicides/{id}'].get['x-scope'], 'user');
  assert.equal(openapi.paths['/knowledge'].get['x-scope'], 'user');
});

test('Herbicide / Formulation / Conditions 必填字段与契约一致', () => {
  assert.deepEqual(schemas.Herbicide.required, ['id', 'revision', 'formulation', 'source', 'risk_text', 'reference_state']);
  assert.ok(schemas.Formulation.required.includes('registration_number'));
  assert.ok(schemas.Formulation.required.includes('ingredients'));
  assert.ok(schemas.Conditions.required.includes('crop_id'));
  assert.ok(schemas.Conditions.required.includes('region_code'));
  // 来源 url 必须 https
  assert.equal(schemas.SourceRef.properties.url.pattern, '^https://');
});

test('Knowledge 约束：body ≤20000、dose_cards ≤10', () => {
  assert.equal(schemas.Knowledge.properties.body.maxLength, 20000);
  assert.equal(schemas.Knowledge.properties.dose_cards.maxItems, 10);
});
