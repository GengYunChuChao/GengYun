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

// —— F1 回归：列表项必须是**纯契约对象**（不得 undefined/null，不得含额外字段） ——
test('F1：/knowledge 列表项为纯 Knowledge 对象（无 undefined/null、字段完备、无额外字段）', async () => {
  const { createReferenceService } = await import('../../packages/reference/service.mjs');
  const svc = createReferenceService({ executionMode: 'stub' });
  const { body } = svc.listKnowledge({}, 'f1-knowledge');
  assert.equal(body.data.items.length, 20);
  // 不得出现 undefined/null（JSON 序列化会变 null）
  assert.equal(body.data.items.filter((x) => x === undefined || x === null).length, 0);
  const allowed = new Set(Object.keys(schemas.Knowledge.properties));
  for (const item of body.data.items) {
    assert.ok(item && typeof item === 'object', '列表项不得为空');
    for (const field of schemas.Knowledge.required) {
      assert.notEqual(item[field], undefined, `Knowledge 缺必填字段 ${field}`);
    }
    for (const key of Object.keys(item)) {
      assert.ok(allowed.has(key), `Knowledge 列表项含 schema 不允许字段 ${key}`);
    }
  }
  assert.ok(!JSON.stringify(body).includes('undefined'), '响应体不得泄漏 undefined');
});

test('F1：/herbicides 列表项为纯 Herbicide 对象（含 formulation/risk_text，无额外字段）', async () => {
  const { createReferenceService } = await import('../../packages/reference/service.mjs');
  const svc = createReferenceService({ executionMode: 'stub' });
  const { body } = svc.listHerbicides({}, 'f1-herbicide');
  assert.equal(body.data.items.length, 20);
  const allowed = new Set(Object.keys(schemas.Herbicide.properties));
  for (const item of body.data.items) {
    assert.ok(item && typeof item === 'object', '列表项不得为空');
    for (const field of schemas.Herbicide.required) {
      assert.notEqual(item[field], undefined, `Herbicide 缺必填字段 ${field}`);
    }
    assert.ok(item.formulation && item.formulation.registration_number, 'formulation 须含登记号');
    assert.equal(typeof item.risk_text, 'string');
    assert.ok(item.risk_text.length >= 1);
    for (const key of Object.keys(item)) {
      assert.ok(allowed.has(key), `Herbicide 列表项含 schema 不允许字段 ${key}`);
    }
  }
  assert.ok(!JSON.stringify(body).includes('undefined'), '响应体不得泄漏 undefined');
});

test('F1：列表项与详情为同一契约对象（列表 = 详情，同源）', async () => {
  const { createReferenceService } = await import('../../packages/reference/service.mjs');
  const svc = createReferenceService({ executionMode: 'stub' });
  const list = svc.listHerbicides({}, 'f1-same').body.data.items;
  const first = list[0];
  const detail = svc.getHerbicide(first.id, {}, 'f1-same-detail').body.data;
  assert.deepEqual(detail, first, '列表项须与详情完全一致（同一契约对象）');
  // 列表与详情使用同一 source_version（契约 SourceRef.version）
  assert.equal(first.source.version, detail.source.version);
  const kList = svc.listKnowledge({}, 'f1-k').body.data.items;
  const kDetail = svc.getKnowledge(kList[0].id, {}, 'f1-k-detail').body.data;
  assert.deepEqual(kDetail, kList[0], 'Knowledge 列表项须与详情一致');
});

// ---------------------------------------------------------------------------
// G1：冻结 schema **完整校验**（真实 Ajv + 实际序列化响应）
//
// 监工口径：原有回归只检查实体顶层 required/allowed，**未校验嵌套与完整封套**，
// 故 75 项通过仍未发现 Conditions 内部 null、Ingredient 缺 unit_text、封套额外字段。
// 本组用例用项目已有 ajv/dist/2020.js 加载冻结 openapi.json，
// 对**实际列表/详情的完整序列化响应**（JSON 往返）直接校验。
// ---------------------------------------------------------------------------
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js');

function ajvCompile() {
  const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
  ajv.addSchema(openapi, 'openapi');
  return (name) => ajv.compile({ $ref: `openapi#/components/schemas/${name}` });
}
const ser = (o) => JSON.parse(JSON.stringify(o)); // 模拟真实序列化（undefined 丢弃 / null 保留）

function assertValid(validate, payload, label) {
  const ok = validate(payload);
  assert.ok(ok, `${label} 不满足冻结 schema：${JSON.stringify((validate.errors || []).slice(0, 4))}`);
}

test('G1：/knowledge 完整封套通过冻结 schema（真实 Ajv）', async () => {
  const { createReferenceService } = await import('../../packages/reference/service.mjs');
  const compile = ajvCompile();
  const svc = createReferenceService({ executionMode: 'stub' });
  const res = svc.listKnowledge({ limit: 20 }, 'g1-k');
  assertValid(compile('KnowledgePageEnvelope'), ser(res.body), 'KnowledgePageEnvelope');
  // 实体逐条亦须通过
  const vK = compile('Knowledge');
  for (const item of ser(res.body.data.items)) assertValid(vK, item, 'Knowledge 实体');
  // 嵌套：Conditions 内部属性不得为 null（schema 类型 string）
  for (const item of ser(res.body.data.items)) {
    const c = item.conditions;
    if (c === null) continue; // 契约允许整体 null
    for (const f of ['crop_id', 'region_code', 'species_id', 'growth_stage', 'planting_method', 'use_scene']) {
      if (f in c) assert.equal(typeof c[f], 'string', `Conditions.${f} 若存在必须为 string，不得为 null`);
    }
  }
});

test('G1：/herbicides 完整封套通过冻结 schema（含 Ingredient.unit_text）', async () => {
  const { createReferenceService } = await import('../../packages/reference/service.mjs');
  const compile = ajvCompile();
  const svc = createReferenceService({ executionMode: 'stub' });
  const res = svc.listHerbicides({ limit: 20 }, 'g1-h');
  assertValid(compile('HerbicidePageEnvelope'), ser(res.body), 'HerbicidePageEnvelope');
  const vH = compile('Herbicide');
  let ingTotal = 0;
  for (const item of ser(res.body.data.items)) {
    assertValid(vH, item, 'Herbicide 实体');
    for (const ing of item.formulation.ingredients) {
      ingTotal += 1;
      assert.equal(typeof ing.unit_text, 'string', 'Ingredient.unit_text 必填且为 string');
      assert.ok(ing.unit_text.length >= 1);
    }
  }
  assert.ok(ingTotal >= 44, `成分总数应 >= 44，实为 ${ingTotal}`);
});

test('G1：详情封套通过冻结 schema（不含额外字段 query_state/detail_state）', async () => {
  const { createReferenceService } = await import('../../packages/reference/service.mjs');
  const compile = ajvCompile();
  const svc = createReferenceService({ executionMode: 'stub' });
  const hList = svc.listHerbicides({ limit: 1 }, 'g1-d').body.data.items;
  const hDet = svc.getHerbicide(hList[0].id, {}, 'g1-d2');
  assertValid(compile('HerbicideEnvelope'), ser(hDet.body), 'HerbicideEnvelope');
  assert.ok(!('detail_state' in hDet.body), '封套 body 不得含 detail_state');
  // detail_state 仍可用于 UI（挂在响应顶层，不在契约封套内）
  assert.ok(hDet.detail_state && typeof hDet.detail_state === 'object');
  const kList = svc.listKnowledge({ limit: 1 }, 'g1-d3').body.data.items;
  const kDet = svc.getKnowledge(kList[0].id, {}, 'g1-d4');
  assertValid(compile('KnowledgeEnvelope'), ser(kDet.body), 'KnowledgeEnvelope');
});
