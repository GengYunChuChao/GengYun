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
  assert.ok(ingTotal >= 42, `成分总数应 >= 42（H1 修复逗号误切后为 42），实为 ${ingTotal}`);
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

// ---------------------------------------------------------------------------
// H1：缺单位时**不得**补成百分比（Jian-bu-de bu-bian）
// 监工复现：parseIngredients("唑草酮 40") 旧实现 content_text="40%"、unit_text="%"
// → 给来源没有的量纲补了单位，违反「缺项如实标记 / 不编造来源条件」。
// ---------------------------------------------------------------------------

test('H1：缺单位输入保留原文数值，unit_text 标为「未采集」（不得补 %）', async () => {
  const { parseIngredients } = await import('../../packages/reference/records.mjs');
  // 监工反例（逐字）
  assert.deepEqual(parseIngredients('唑草酮 40'), [
    { name: '唑草酮', content_text: '40', unit_text: '未采集' },
  ]);
  // content_text 不得出现凭空补的量纲符号
  const [ing] = parseIngredients('唑草酮 40');
  assert.ok(!ing.content_text.includes('%'), 'content_text 不得补 %');
  assert.equal(ing.unit_text, '未采集', 'unit_text 必须显式标为未采集');
  // 多成分中的缺单位项同样处理
  assert.deepEqual(parseIngredients('唑草酮 40、二甲戊灵 22%'), [
    { name: '唑草酮', content_text: '40', unit_text: '未采集' },
    { name: '二甲戊灵', content_text: '22%', unit_text: '%' },
  ]);
});

test('H1：显式单位（%/g/L）仍被正确解析（不误伤正例）', async () => {
  const { parseIngredients } = await import('../../packages/reference/records.mjs');
  assert.deepEqual(parseIngredients('唑草酮 40%'), [
    { name: '唑草酮', content_text: '40%', unit_text: '%' },
  ]);
  assert.deepEqual(parseIngredients('草铵膦 200 g/L'), [
    { name: '草铵膦', content_text: '200g/L', unit_text: 'g/L' },
  ]);
  assert.deepEqual(parseIngredients('吡氟酰草胺 2%、二甲戊灵 22%'), [
    { name: '吡氟酰草胺', content_text: '2%', unit_text: '%' },
    { name: '二甲戊灵', content_text: '22%', unit_text: '%' },
  ]);
});

test('H1：真实 20 条记录的成分 unit_text 均非编造（原文单位或显式未采集）', async () => {
  const { loadHerbicideRecords } = await import('../../packages/reference/records.mjs');
  const { items } = loadHerbicideRecords();
  let total = 0;
  for (const it of items) {
    for (const ing of it.contract.formulation.ingredients) {
      total += 1;
      assert.equal(typeof ing.unit_text, 'string');
      assert.ok(ing.unit_text.length >= 1);
      // 若 unit_text 为「未采集」，则 content_text 不得含量纲符号（不得凭空补）
      if (ing.unit_text === '未采集') {
        assert.ok(!/%|g\/L|mg\/kg|g\/kg/.test(ing.content_text), `content_text 不得补量纲：${ing.content_text}`);
      }
    }
  }
  assert.ok(total >= 42, `成分总数应 >= 42（H1 修复逗号误切后为 42），实为 ${total}`);
});

test('H2：来源/剂型缺失时，普通 string 必填字段以「未采集」占位（不编造发布方/生产企业）', async () => {
  const { toHerbicideContract } = await import('../../packages/reference/records.mjs');
  const compile = ajvCompile();
  // 构造一条缺 publisher / producer / dosage_form（普通 string 必填）的记录。
  // 注意：source_kind / evidence_kind 为**冻结枚举**，缺项处理见下方 H2 枚举用例。
  const rec = {
    record_id: 'H2-TEXT',
    registration_number: 'PD99999999',
    registered_name: '测试药剂',
    ingredients_text: '唑草酮 40',
    source: { source_id: 'src_test', issue: '测试期', published_at: '2026-01-01', source_kind: 'verified_seed', evidence_kind: 'research' },
  };
  const c = toHerbicideContract(rec);
  assert.equal(c.source.publisher, '未采集', '不得编造权威发布方');
  assert.equal(c.formulation.producer, '未采集', '不得编造生产企业');
  assert.equal(c.formulation.dosage_form, '未采集', '不得编造剂型');
  // 不得出现原先硬编码的权威名称
  assert.notEqual(c.source.publisher, '农业农村部农药管理司');
  // 且产物仍须为**合法契约对象**（完整 Ajv）
  assertValid(compile('Herbicide'), ser(c), 'Herbicide（缺 publisher/producer/dosage_form）');
});

// ---------------------------------------------------------------------------
// H2：缺来源类型**不得**用中文占位填入冻结枚举
// 监工复现：仅删 source.source_kind → toHerbicideContract 产物 source_kind="未采集"
// 被 Ajv 以 `/source/source_kind · enum` 拒绝；仅删 evidence_kind 同理；
// 而 evaluateEligibility 仍判 queryable=true（矛盾）。
// 口径：契约枚举字段不得承载非枚举值；缺项须在可表达缺项的位置如实说明；
//       不可确认时 fail-closed（在投影/查询前排除，并保持 queryable 与契约合法性一致）。
// ---------------------------------------------------------------------------

/**
 * 本文件**绝不写** `packages/knowledge/herbicides/records-2026.json`。
 *
 * 该文件是被 git 跟踪的真实资料，而同一批 `node --test` 里另有用例**并发读**它
 * （`tests/reference/i08-scenarios-100.test.mjs`、`tests/reference/miniprogram-parity.test.mjs`）。
 * 凡是「把文件改成变体 → 读回 → 复原」的写法，读者都可能落在变体存活窗口内：
 *   - `writeFileSync(target, data)` 默认 flag `'w'`，**先把目标截断为 0 字节**再写 ⇒
 *     窗口内读者抛 `SyntaxError: Unexpected end of JSON input`；
 *   - 「同目录临时文件 + `renameSync` 原子替换」消掉了半截读，但**逻辑窗口仍在**：
 *     读者读到的是合法 JSON、只是记录数变成 19 ⇒ 真实红点
 *     `应有≥20 条真实记录，实际 19`（PR #237 CI 抖动）。
 *
 * 原子替换只缩小窗口，不消除窗口；根治只能是**不写**：变体在内存里构造，交给
 * `projectHerbicideRecords`（与 `loadHerbicideRecords` 同一投影实现）检验 fail-closed，
 * 并以「文件逐字节未变」把原「数据文件须已复原」的意图升级为「从未被改写」。
 */
/**
 * 诊断归属：双失败可归因 —— 变体写（writeMutated）与 finally 复原写（restore）
 * 都失败时，被抛出的必须是**首个**失败（变体写），复原写的失败挂在它的
 * `cause.restores` 上（两者都可见，不丢失其一 ✓）。
 * 断言阶段（assertLoaded，可选）在变体写之后、复原写之前执行：断言失败时
 * 复原写仍照常执行（与原 try/finally 语义一致 ✓）。
 */
function runWithRestoreOnFailure(writeMutated, restore, assertLoaded) {
  let first = null;
  try {
    writeMutated();
    if (assertLoaded) assertLoaded();
  } catch (err) {
    first = err;
    throw err; // 单失败路径：首个失败保持原样、栈指向首个失败点 ✓
  } finally {
    try {
      restore();
    } catch (restoreErr) {
      if (!first) throw restoreErr; // 只有复原失败：异常照旧指向复原写 ✓
      // 双失败：首个失败已带原生栈，把复原失败挂到它的 cause 上 ✓
      const cur = first.cause;
      if (cur && typeof cur === 'object' && Array.isArray(cur.restores)) {
        cur.restores.push(restoreErr); // 连续双失败场景（暂无）：累计复原异常
      } else {
        first.cause = Object.assign(
          new Error(`复原写也失败：${restoreErr && restoreErr.message ? restoreErr.message : String(restoreErr)}`),
          { restores: [restoreErr] },
        );
      }
    }
  }
}

/** 构造缺字段变体记录（基于首条真实记录，**逐字节复制后仅删指定字段**）。 */
function variantOfFirstRecord(mutate) {
  const first = JSON.parse(
    readFileSync(new URL('../../packages/knowledge/herbicides/records-2026.json', import.meta.url), 'utf8'),
  ).records[0];
  const rec = JSON.parse(JSON.stringify(first));
  mutate(rec);
  return rec;
}

test('H2：仅缺 source_kind / 仅缺 evidence_kind 的记录不满足契约前提（fail-closed，不编造枚举）', async () => {
  const { checkSourceContractReadiness } = await import('../../packages/reference/records.mjs');
  const onlyKind = checkSourceContractReadiness(variantOfFirstRecord((r) => delete r.source.source_kind));
  assert.equal(onlyKind.ok, false, '仅缺 source_kind 应判定为不满足契约前提');
  assert.deepEqual(onlyKind.missing, ['来源类型（source_kind）']);
  const onlyEvidence = checkSourceContractReadiness(variantOfFirstRecord((r) => delete r.source.evidence_kind));
  assert.equal(onlyEvidence.ok, false, '仅缺 evidence_kind 应判定为不满足契约前提');
  assert.deepEqual(onlyEvidence.missing, ['证据类型（evidence_kind）']);
  const both = checkSourceContractReadiness(
    variantOfFirstRecord((r) => {
      delete r.source.source_kind;
      delete r.source.evidence_kind;
    }),
  );
  assert.deepEqual(both.missing, ['来源类型（source_kind）', '证据类型（evidence_kind）']);
  // 非法枚举取值同判（不得因「像枚举」而放行）
  const bogus = checkSourceContractReadiness(variantOfFirstRecord((r) => { r.source.source_kind = 'made_up'; }));
  assert.equal(bogus.ok, false);
  // 基线记录满足前提
  assert.equal(checkSourceContractReadiness(variantOfFirstRecord(() => {})).ok, true);
});

test('H2：缺枚举字段的记录在投影前被排除（items 不含、skipped 如实说明缺项）', async () => {
  const { loadHerbicideRecords, projectHerbicideRecords } = await import('../../packages/reference/records.mjs');
  const dataPath = new URL('../../packages/knowledge/herbicides/records-2026.json', import.meta.url);
  // 真实资料文件在执行前后的字节快照：本用例**只读**它，绝不写（见上方「绝不写真实资料」）。
  const bytesBefore = readFileSync(dataPath);
  const baseline = loadHerbicideRecords();
  assert.equal(baseline.items.length, 20);
  assert.equal(baseline.skipped.length, 0, '真实 20 条来源齐备，不应被排除');
  const variant = JSON.parse(bytesBefore.toString('utf8'));
  delete variant.records[0].source.source_kind; // 仅缺 source_kind
  // 变体只存在于内存，走与 loadHerbicideRecords 完全同一投影实现（不落盘 ⇒ 无并发抢跑窗口）
  const loaded = projectHerbicideRecords(variant);
  assert.equal(loaded.items.length, 19, '缺枚举字段的记录不得进入投影集合');
  assert.equal(loaded.skipped.length, 1);
  assert.deepEqual(loaded.skipped[0].missing, ['来源类型（source_kind）']);
  assert.ok(loaded.skipped[0].reason.includes('来源类型（source_kind）'), '缺项说明须如实列出缺失字段');
  // 被排除的记录不得出现在任何对外投影中
  assert.ok(!loaded.items.some((it) => it.contract.source.source_kind === '未采集'), '契约为外部消费者所依赖，不得含非枚举占位');
  assert.equal(loadHerbicideRecords().items.length, 20, '数据文件须已复原');
  // 原「须已复原」升级为「从未被改写」：不再依赖 finally 复原成功，进程中途被杀也不会留下脏工作树
  assert.ok(readFileSync(dataPath).equals(bytesBefore), '真实数据文件不得被本用例改写（须逐字节未变）');
});

test('H2：变体写与复原写双双失败时，首个失败（变体写）不被复原失败顶掉（双失败可归因）', () => {
  // 场外复现机制（真实 EPERM/ENOENT 不可在仓内稳定注入，改为注入式失败）：
  // writeMutated 抛 errA，restore 也抛 errB ⇒ 断言被抛出的是 errA、errB 挂在其 cause.restores。
  const errA = new Error('变体写失败（注入：EPERM）');
  const errB = new Error('复原写失败（注入：EACCES）');
  assert.throws(
    () => runWithRestoreOnFailure(
      () => { throw errA; },
      () => { throw errB; },
    ),
    (thrown) => {
      assert.equal(thrown, errA, '被抛出的必须是首个失败（变体写），不得被复原失败顶掉');
      assert.ok(thrown.cause instanceof Error, '复原失败须挂在首个失败的 cause 上（双失败均可见）');
      assert.match(thrown.cause.message, /复原写也失败/);
      assert.equal(thrown.cause.message.includes('复原写失败（注入：EACCES）'), true);
      assert.ok(Array.isArray(thrown.cause.restores) && thrown.cause.restores[0] === errB);
      return true;
    },
  );
});

test('H2：单失败（仅变体写失败、复原成功）时，异常仍指向首个失败且不带复原 cause', () => {
  const errA = new Error('变体写失败（注入：EBUSY）');
  assert.throws(
    () => runWithRestoreOnFailure(
      () => { throw errA; },
      () => {},
    ),
    (thrown) => {
      assert.equal(thrown, errA);
      assert.equal(thrown.cause, undefined, '复原成功时不得挂任何 cause');
      return true;
    },
  );
});

test('H2：单失败（仅复原写失败、变体写成功）时，异常指向复原写', () => {
  const errB = new Error('复原写失败（注入：EPERM）');
  assert.throws(
    () => runWithRestoreOnFailure(
      () => {},
      () => { throw errB; },
    ),
    (thrown) => {
      assert.equal(thrown, errB, '只有复原失败时，异常须照旧指向复原写');
      return true;
    },
  );
});

test('H2：直接投影时枚举字段**永不**承载非枚举值（缺失则整体不写出，绝不编造）', async () => {
  const { toHerbicideContract, toKnowledgeContract } = await import('../../packages/reference/records.mjs');
  const { SOURCE_KINDS, EVIDENCE_KINDS } = await import('../../packages/reference/constants.mjs');
  const vH = ajvCompile()('Herbicide');
  const vK = ajvCompile()('Knowledge');
  const variants = [
    ['仅缺 source_kind', (r) => delete r.source.source_kind],
    ['仅缺 evidence_kind', (r) => delete r.source.evidence_kind],
    ['两者都缺', (r) => { delete r.source.source_kind; delete r.source.evidence_kind; }],
    ['source 整体缺失', (r) => { delete r.source; }],
  ];
  for (const [label, mutate] of variants) {
    const rec = variantOfFirstRecord(mutate);
    for (const [name, contract] of [
      ['Herbicide', toHerbicideContract(rec)],
      ['Knowledge', toKnowledgeContract(rec)],
    ]) {
      const payload = ser(contract);
      const kind = payload.source?.source_kind;
      const evidence = payload.source?.evidence_kind;
      // 核心判据：枚举字段**要么命中冻结枚举，要么不含该字段** ——
      // 绝不出现 `未采集` 这类非枚举值（也不挑一个合法值来编造来源类型）。
      assert.ok(
        kind === undefined || SOURCE_KINDS.includes(kind),
        `${label} / ${name}：source_kind 不得为非枚举值（实为 ${JSON.stringify(kind)}）`,
      );
      assert.ok(
        evidence === undefined || EVIDENCE_KINDS.includes(evidence),
        `${label} / ${name}：evidence_kind 不得为非枚举值（实为 ${JSON.stringify(evidence)}）`,
      );
      assert.notEqual(kind, '未采集', '缺项文案不得塞进强枚举字段');
      // 产物若整体合法（未被 fail-closed 拦下）须通过**完整** Ajv；
      // 若因缺必填枚举而整体不合法，则必须是「字段缺失」而非「字段写错值」。
      const validate = name === 'Herbicide' ? vH : vK;
      if (!validate(payload)) {
        const errs = validate.errors || [];
        const onlyMissingRequired = errs.every(
          (e) => e.keyword === 'required' && ['source_kind', 'evidence_kind'].includes(e.params.missingProperty),
        );
        assert.ok(
          onlyMissingRequired,
          `${name}（${label}）若被拒绝，原因只能是缺失必填枚举字段（不得是写入了非法枚举值）：${JSON.stringify(errs.slice(0, 4))}`,
        );
      }
    }
  }
});

test('H2：契约前提齐备的投影必须通过完整 Ajv（真实数据零回归）', async () => {
  const { loadHerbicideRecords } = await import('../../packages/reference/records.mjs');
  const vH = ajvCompile()('Herbicide');
  const vK = ajvCompile()('Knowledge');
  const { items, skipped } = loadHerbicideRecords();
  assert.equal(skipped.length, 0, '真实 20 条来源齐备，不得有记录被 fail-closed 排除');
  assert.equal(items.length, 20);
  for (const it of items) {
    assertValid(vH, ser(it.contract), `Herbicide ${it.registration_number}`);
    assertValid(vK, ser(it.knowledge), `Knowledge ${it.registration_number}`);
    // 枚举字段必须是契约枚举（真实资料齐备）
    assert.ok(SOURCE_KINDS.includes(it.contract.source.source_kind));
    assert.ok(EVIDENCE_KINDS.includes(it.contract.source.evidence_kind));
  }
});

test('H2：evaluateEligibility 的 queryable 与契约合法性一致（不得「Ajv 拒绝但 queryable=true」）', async () => {
  const { evaluateEligibility } = await import('../../packages/reference/query.mjs');
  const { toHerbicideContract } = await import('../../packages/reference/records.mjs');
  const vH = ajvCompile()('Herbicide');
  const variants = [
    ['基线', () => {}],
    ['仅缺 source_kind', (r) => delete r.source.source_kind],
    ['仅缺 evidence_kind', (r) => delete r.source.evidence_kind],
    ['两者都缺', (r) => { delete r.source.source_kind; delete r.source.evidence_kind; }],
    ['缺 registration_number', (r) => delete r.registration_number],
    ['非法 source_kind', (r) => { r.source.source_kind = 'made_up'; }],
  ];
  for (const [label, mutate] of variants) {
    const rec = variantOfFirstRecord(mutate);
    const verdict = evaluateEligibility(
      { visibility: 'published', registration_number: rec.registration_number, source: rec.source ?? {}, simulated: false },
      { includeSimulated: false },
    );
    const legal = vH(ser(toHerbicideContract(rec)));
    if (!legal) {
      assert.equal(verdict.queryable, false, `${label}：契约为非法对象时 queryable 必须为 false（否则自相矛盾）`);
      assert.ok(typeof verdict.reason === 'string' && verdict.reason.length > 0, `${label}：须给出可读原因`);
    }
  }
  // 基线仍可查询（不误伤）
  const okVerdict = evaluateEligibility(
    { visibility: 'published', registration_number: 'PD20161371', source: { source_kind: 'verified_seed', evidence_kind: 'research', source_validity: 'valid' }, simulated: false },
    {},
  );
  assert.equal(okVerdict.queryable, true);
});

test('H1：药品名内含逗号不得被误切（2,4-滴异辛酯 为单一成分，不凭空产生假成分）', async () => {
  const { parseIngredients } = await import('../../packages/reference/records.mjs');
  // 名称内逗号（后接数字）→ 不作为分隔符
  assert.deepEqual(parseIngredients('乙草胺 60%、2,4-滴异辛酯 18%'), [
    { name: '乙草胺', content_text: '60%', unit_text: '%' },
    { name: '2,4-滴异辛酯', content_text: '18%', unit_text: '%' },
  ]);
  // 全角/半角逗号作分隔符（后接非数字）仍生效
  assert.deepEqual(parseIngredients('二氯吡啶酸 24%,氨氯吡啶酸 6%'), [
    { name: '二氯吡啶酸', content_text: '24%', unit_text: '%' },
    { name: '氨氯吡啶酸', content_text: '6%', unit_text: '%' },
  ]);
  // 中文单位（克/升）按原文如实解析，不补 %
  assert.deepEqual(parseIngredients('烯草酮 240克/升'), [
    { name: '烯草酮', content_text: '240克/升', unit_text: '克/升' },
  ]);
});

test('H1：真实记录中每个成分名均为原文子串（无凭空产生的成分）', async () => {
  const { loadHerbicideRecords } = await import('../../packages/reference/records.mjs');
  const { items } = loadHerbicideRecords();
  for (const it of items) {
    for (const ing of it.contract.formulation.ingredients) {
      assert.ok(
        it.ingredients_text.includes(ing.name),
        `${it.registration_number}：成分名「${ing.name}」不是原文子串（可能是误切产生）`,
      );
    }
  }
});
