// GY-I04 · **登记核对**（契约 operationId `verifyRegistration`，`POST /registrations/verify`）的
// **服务层**回归（不经 HTTP，直接驱动 `services/api/src/registrations/service.ts`）。
//
// 覆盖（每条都是断言，不是设计声明）：
//   A. 六类 `MatchState` 的真实形态：matched / conflict / no_match / insufficient / ambiguous /
//      unavailable —— 重点是「不是请求存在就通过」：匹配必须逐字段对上登记记录。
//   B. 过期/失效登记记录**不得**给出 matched（落 conflict 并带出 `source.validity`）。
//   C. `real` 模式真实登记库未接线 ⇒ `unavailable`（**不伪装**成 no_match / matched）；
//      装载失败 ⇒ `503 PROVIDER_UNAVAILABLE`（既有错误码，绝不放行）。
//   D. 重放：同一请求重复调用得到**逐字节一致**的结论（纯函数、无台账、无状态）。
//   E. 信息泄露：响应里不得出现内部标识（`record_id` / `source_version` / `identity_hash`）。
//   F. 模拟 / 下架记录不进入核对面（不得作为真实依据、与读面同口径）。
//   G. **待核维度齐备性（R1）**：缺 `dosage_form` / `ingredients` ⇒ 非 matched（`insufficient`）
//      且 `missing_fields` 逐项点名；内核已判 `conflict` / `no_match` / `ambiguous` / `unavailable`
//      时**不降级**（缺失维度只反映在 `missing_fields`）；三维齐备且一致仍是 `matched`（正控制）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createRecordsRegistryPort,
  createRegistrationVerifyService,
  missingVerifiableDimensions,
  UNWIRED_REGISTRY_REASON,
  VERIFY_DIMENSION_FIELDS,
} from '../../services/api/src/registrations/service.ts';
import { loadHerbicideRecords } from '../../packages/reference/index.mjs';

const contract = JSON.parse(
  readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'),
);
const schemas = contract.components.schemas;
/** 契约 `Verification` / `Herbicide` / `SourceRef` 的必填键（additionalProperties:false）。 */
const VERIFICATION_KEYS = [...schemas.Verification.required].sort();
const HERBICIDE_KEYS = [...schemas.Herbicide.required].sort();
const SOURCE_KEYS = [...schemas.SourceRef.required].sort();

/**
 * 触发器夹具里的「真实记录」（取自仓内公开登记公告记录，非编造）：
 * `PD20161371` = 唑草酮 / 水分散粒剂 / 「唑草酮 40%」（`packages/knowledge/herbicides/records-2026.json`）。
 */
const RECORD = Object.freeze({
  registration_number: 'PD20161371',
  name: '唑草酮',
  dosage_form: '水分散粒剂',
  ingredients: Object.freeze([{ name: '唑草酮', content_text: '40%', unit_text: '%' }]),
});

function fieldsOf(patch = {}) {
  return {
    registration_number: RECORD.registration_number,
    name: RECORD.name,
    ingredients: RECORD.ingredients.map((item) => ({ ...item })),
    dosage_form: RECORD.dosage_form,
    ...patch,
  };
}

/** 一条契约形状的登记记录（供注入型端口使用；**不是**仓内真实资料）。 */
function fixtureRecord({ validity = 'valid', review = 'unverified', registration = 'PDFIXTURE1' } = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    revision: 1,
    formulation: {
      id: '22222222-2222-4222-8222-222222222222',
      registration_number: registration,
      producer: '夹具企业',
      dosage_form: '水剂',
      ingredients: [{ name: '草甘膦', content_text: '41%', unit_text: '%' }],
    },
    source: {
      id: '33333333-3333-4333-8333-333333333333',
      version: 'fixture-1',
      title: '夹具来源',
      url: 'https://example.invalid/fixture',
      publisher: '夹具发布方',
      source_kind: 'database',
      evidence_kind: 'research',
      validity,
      review_status: review,
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    risk_text: '夹具风险说明（非真实资料）',
    reference_state: 'available',
  };
}

/** 注入型端口：直接给候选（用于构造「过期记录」「查询异常」等无法从仓内数据造出的形态）。 */
function portOf(candidates, { kind = 'records', note = 'fixture' } = {}) {
  return {
    kind,
    note,
    async lookup() {
      return { status: 'available', candidates };
    },
  };
}

function serviceWith(registry) {
  return createRegistrationVerifyService({ executionMode: 'stub', registry });
}

// ---------------------------------------------------------------------------
// A. 六类 MatchState
// ---------------------------------------------------------------------------

test('A1. matched：登记号+名称+剂型+成分全对 ⇒ matched，且 data 严格是契约 Verification 五键', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  const data = await service.verify({ fields: fieldsOf(), conditions: null });

  assert.equal(data.match_state, 'matched');
  assert.deepEqual(data.conflict_fields, []);
  assert.deepEqual(data.missing_fields, []);
  assert.deepEqual(data.dose_cards, [], '本域无已审用量来源 ⇒ 用量卡恒空（不补造剂量）');
  assert.deepEqual(Object.keys(data).sort(), VERIFICATION_KEYS, 'Verification 必须 exactly 五键');
  assert.equal(schemas.MatchState.enum.includes(data.match_state), true);

  // 命中时如实带出契约 Herbicide（供人工复核），且逐键合规。
  assert.notEqual(data.registration, null);
  assert.deepEqual(Object.keys(data.registration).sort(), HERBICIDE_KEYS);
  assert.equal(data.registration.formulation.registration_number, RECORD.registration_number);
  assert.deepEqual(Object.keys(data.registration.source).sort(), SOURCE_KEYS);
  assert.equal(schemas.SourceRef.properties.review_status.enum.includes(data.registration.source.review_status), true);
  // 仓内记录是**未核对**来源：不得被提升成 verified。
  assert.equal(data.registration.source.review_status, 'unverified');
});

test('A2. conflict：剂型/成分与登记记录不一致 ⇒ conflict，conflict_fields 可指认且仍带出记录', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });

  const dosage = await service.verify({ fields: fieldsOf({ dosage_form: '乳油' }), conditions: null });
  assert.equal(dosage.match_state, 'conflict');
  assert.deepEqual(dosage.conflict_fields, ['dosage_form']);
  assert.equal(dosage.registration.formulation.registration_number, RECORD.registration_number, '冲突时仍如实带出记录供复核');

  const ingredients = await service.verify({
    fields: fieldsOf({ ingredients: [{ name: '莠去津', content_text: '40%', unit_text: '%' }] }),
    conditions: null,
  });
  assert.equal(ingredients.match_state, 'conflict');
  assert.deepEqual(ingredients.conflict_fields, ['ingredients']);

  // 含量不同（名称相同）也必须算冲突：不许把不同含量剂型当同一制剂。
  const content = await service.verify({
    fields: fieldsOf({ ingredients: [{ name: '唑草酮', content_text: '20%', unit_text: '%' }] }),
    conditions: null,
  });
  assert.equal(content.match_state, 'conflict');
  assert.deepEqual(content.conflict_fields, ['ingredients']);
  assert.deepEqual(content.dose_cards, []);
});

test('A3. insufficient：必要条件（登记号/名称）缺失 ⇒ insufficient，绝不 matched', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });

  const noRegistration = await service.verify({ fields: fieldsOf({ registration_number: null }), conditions: null });
  assert.equal(noRegistration.match_state, 'insufficient');
  assert.deepEqual(noRegistration.missing_fields, ['registration_number']);
  assert.equal(noRegistration.registration, null);

  const noName = await service.verify({ fields: fieldsOf({ name: null }), conditions: null });
  assert.equal(noName.match_state, 'insufficient');
  assert.deepEqual(noName.missing_fields, ['name']);

  const nothing = await service.verify({ fields: fieldsOf({ registration_number: null, name: null }), conditions: null });
  assert.equal(nothing.match_state, 'insufficient');
  assert.deepEqual(nothing.missing_fields, ['registration_number', 'name']);
  // 必要条件缺失时**不得**给出 matched —— 这是「不是请求存在就通过」的第一道硬闸。
  for (const data of [noRegistration, noName, nothing]) assert.notEqual(data.match_state, 'matched');
});

test('A4. no_match：登记号与名称都查不到 ⇒ no_match（不伪造记录、不落 insufficient）', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  const data = await service.verify({
    fields: fieldsOf({ registration_number: 'PD00000000', name: '不存在的药剂名称' }),
    conditions: null,
  });
  assert.equal(data.match_state, 'no_match');
  assert.equal(data.registration, null);
  assert.deepEqual(data.conflict_fields, []);
  assert.deepEqual(data.missing_fields, []);
  assert.deepEqual(data.dose_cards, []);
});

test('A5. ambiguous：名称命中多条不同制剂 ⇒ ambiguous，不静默选一', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  // 仓内「烯草酮」有两条独立记录（PD20211628 / PD20161375）：按名称检索必然多候选。
  const data = await service.verify({
    fields: fieldsOf({ registration_number: 'PD99999999', name: '烯草酮', dosage_form: null, ingredients: [] }),
    conditions: null,
  });
  assert.equal(data.match_state, 'ambiguous');
  assert.equal(data.registration, null, '歧义时不得挑一条下发');
  assert.deepEqual(data.dose_cards, []);
});

test('A6. 登记号与名称指向不同记录 ⇒ conflict(registration_number)，不按名称放宽', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  const data = await service.verify({
    fields: fieldsOf({ registration_number: 'PD99999999', name: RECORD.name, dosage_form: null, ingredients: [] }),
    conditions: null,
  });
  assert.equal(data.match_state, 'conflict');
  assert.deepEqual(data.conflict_fields, ['registration_number']);
  assert.notEqual(data.registration, null);
});

// ---------------------------------------------------------------------------
// B. 过期 / 失效记录
// ---------------------------------------------------------------------------

test('B1. 过期登记记录 ⇒ conflict + source.validity（失效来源不得给出「核对通过」）', async () => {
  const expired = fixtureRecord({ validity: 'expired' });
  const service = serviceWith(portOf([expired]));
  const data = await service.verify({
    fields: { registration_number: 'PDFIXTURE1', name: '夹具草甘膦', ingredients: [], dosage_form: null },
    conditions: null,
  });
  assert.equal(data.match_state, 'conflict');
  assert.deepEqual(data.conflict_fields, ['source.validity']);
  assert.notEqual(data.registration, null, '如实带出该记录（供人工复核），但不给通过结论');
  assert.deepEqual(data.dose_cards, []);
});

test('B2. 被驳回（review_status=rejected）记录 ⇒ conflict + source.review_status', async () => {
  const rejected = fixtureRecord({ review: 'rejected' });
  const service = serviceWith(portOf([rejected]));
  const data = await service.verify({
    fields: { registration_number: 'PDFIXTURE1', name: '夹具草甘膦', ingredients: [], dosage_form: null },
    conditions: null,
  });
  assert.equal(data.match_state, 'conflict');
  assert.deepEqual(data.conflict_fields, ['source.review_status']);
});

test('B3. 有效期正常的记录 ⇒ matched（正控制：上两条不是「一律 conflict」）', async () => {
  const service = serviceWith(portOf([fixtureRecord()]));
  const data = await service.verify({
    // 三维齐备且与夹具记录一致（`水剂` / 草甘膦 41%）：本片起「缺待核维度不得报 matched」，
    // 故这条正控制必须给出**完整**的标签读取结果，否则它证明的是「缺项也 matched」。
    fields: {
      registration_number: 'PDFIXTURE1',
      name: '夹具草甘膦',
      ingredients: [{ name: '草甘膦', content_text: '41%', unit_text: '%' }],
      dosage_form: '水剂',
    },
    conditions: null,
  });
  assert.equal(data.match_state, 'matched');
  assert.deepEqual(data.conflict_fields, []);
  assert.deepEqual(data.missing_fields, []);
});

// ---------------------------------------------------------------------------
// C. 未接线 / 装载失败 / 查询异常（fail-closed）
// ---------------------------------------------------------------------------

test('C1. real 模式：真实登记库未接线 ⇒ unavailable（不伪装成 no_match 或 matched）', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'real' });
  assert.equal(service.describe().registry, 'unwired');
  const data = await service.verify({ fields: fieldsOf(), conditions: null });
  assert.equal(data.match_state, 'unavailable');
  assert.equal(data.registration, null, '不可用时不得回退仓内记录冒充权威登记库');
  assert.deepEqual(data.dose_cards, []);
  assert.equal(UNWIRED_REGISTRY_REASON.length > 0, true);
});

test('C2. 装载失败（数据缺失/不可解析）⇒ ApiError PROVIDER_UNAVAILABLE(503)，绝不放行', async () => {
  const service = createRegistrationVerifyService({
    executionMode: 'stub',
    loadRecords: () => {
      throw new Error('records-2026.json 缺失');
    },
  });
  await assert.rejects(
    () => service.verify({ fields: fieldsOf(), conditions: null }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_UNAVAILABLE');
      assert.equal(error.status, 503);
      assert.equal(error.retryable, false, '需运维修数据，不是时间能解决的瞬时态');
      assert.match(error.message, /登记核对资料装载失败/);
      return true;
    },
  );
  // 同上：`describe()` 也要抛（不谎称「已接线」）。
  assert.throws(() => service.describe(), (error) => error.code === 'PROVIDER_UNAVAILABLE');
});

test('C3. 登记库查询异常 ⇒ unavailable（不得降级成 no_match）', async () => {
  const service = serviceWith({
    kind: 'records',
    note: 'throw-on-lookup',
    async lookup() {
      throw new Error('端口故障');
    },
  });
  const data = await service.verify({ fields: fieldsOf(), conditions: null });
  assert.equal(data.match_state, 'unavailable');
  assert.notEqual(data.match_state, 'no_match');
  assert.equal(data.registration, null);
});

// ---------------------------------------------------------------------------
// D. 重放（纯函数语义；不写台账、不留状态）
// ---------------------------------------------------------------------------

test('D1. 同一请求重复调用 ⇒ 结论逐字节一致（幂等由纯函数给出，无 24h 台账）', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  const first = await service.verify({ fields: fieldsOf(), conditions: null });
  const second = await service.verify({ fields: fieldsOf(), conditions: null });
  assert.equal(JSON.stringify(first), JSON.stringify(second), '重放必须得到同一结论（无随机/无时钟）');
  // 五次重放仍稳定，且不改变端口形态（没有「重放被记账」这种副作用）。
  for (let index = 0; index < 5; index += 1) {
    assert.equal(JSON.stringify(await service.verify({ fields: fieldsOf(), conditions: null })), JSON.stringify(first));
  }
  assert.equal(service.describe().registry, 'records');
});

test('D2. 换一个登记号重放 ⇒ 结论随输入变化（不是被缓存成同一答案）', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  const matched = await service.verify({ fields: fieldsOf(), conditions: null });
  const other = await service.verify({ fields: fieldsOf({ registration_number: 'PD00000000', name: '不存在' }), conditions: null });
  assert.equal(matched.match_state, 'matched');
  assert.equal(other.match_state, 'no_match');
});

// ---------------------------------------------------------------------------
// E. 信息泄露
// ---------------------------------------------------------------------------

test('E1. 响应不含内部标识：record_id / source_version / identity_hash / 内部文件路径', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  const data = await service.verify({ fields: fieldsOf(), conditions: null });
  const text = JSON.stringify(data);
  for (const forbidden of ['record_id', 'source_version', 'identity_hash', 'identity_key', 'gy-i03-hb', 'records-2026.json', 'content_hash']) {
    assert.equal(text.includes(forbidden), false, `响应里不得出现内部标识 ${forbidden}`);
  }
  // 反向控制：允许出现的契约字段确实在（否则上一条会因为「响应是空的」而假绿）。
  assert.equal(text.includes('registration_number'), true);
  assert.equal(text.includes('PD20161371'), true);
});

test('E2. 内部条目（含 record_id / source_version）不会被整条下发：只有契约字段', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  const data = await service.verify({ fields: fieldsOf(), conditions: null });
  const allowed = new Set(HERBICIDE_KEYS);
  for (const key of Object.keys(data.registration)) assert.equal(allowed.has(key), true, `Herbicide 出现非法键 ${key}`);
  assert.deepEqual(Object.keys(data.registration.formulation).sort(), ['dosage_form', 'id', 'ingredients', 'producer', 'registration_number']);
});

// ---------------------------------------------------------------------------
// F. 模拟 / 下架记录
// ---------------------------------------------------------------------------

test('F1. 模拟记录与下架记录不进入核对面（模拟不得作为真实依据、下架与读面同口径）', async () => {
  const good = fixtureRecord();
  const items = [
    { simulated: true, visibility: 'published', registered_name: '模拟草甘膦', contract: {} },
    { simulated: false, visibility: 'hidden', registered_name: '下架草甘膦', contract: {} },
    { simulated: false, visibility: 'published', registered_name: '夹具草甘膦', contract: good },
  ];
  const port = createRecordsRegistryPort(items);
  assert.equal(port.kind, 'records');

  const simulated = await port.lookup({ registrationNumber: null, name: '模拟草甘膦' });
  assert.deepEqual(simulated.candidates, [], '模拟记录不得成为候选');

  const hidden = await port.lookup({ registrationNumber: null, name: '下架草甘膦' });
  assert.deepEqual(hidden.candidates, [], '下架记录退出核对面');

  const published = await port.lookup({ registrationNumber: 'PDFIXTURE1', name: null });
  assert.equal(published.candidates.length, 1, '正控制：已发布真实记录仍可命中');
});

test('F2. 记录投影不合契约 ⇒ 端口整体退化为 unavailable（不保留「好候选」）', async () => {
  const broken = { ...fixtureRecord(), formulation: { registration_number: 'PDFIXTURE1' } };
  const port = createRecordsRegistryPort([
    { simulated: false, visibility: 'published', registered_name: '好记录', contract: fixtureRecord() },
    { simulated: false, visibility: 'published', registered_name: '坏记录', contract: broken },
  ]);
  assert.equal(port.kind, 'unwired');
  const lookup = await port.lookup({ registrationNumber: 'PDFIXTURE1', name: null });
  assert.equal(lookup.status, 'unavailable');
});

test('F3. 仓内真实记录装载数（防「拿空集当 no_match」的假绿）', () => {
  const items = loadHerbicideRecords().items;
  assert.equal(items.length, 20, '仓内公开登记公告记录 20 条');
  assert.equal(items.every((item) => item.visibility === 'published'), true, '本批记录全部已发布');
  assert.equal(items.some((item) => item.simulated === true), false, '本批记录不含模拟数据');
});

// ---------------------------------------------------------------------------
// G. 待核维度齐备性（R1：缺 dosage_form / ingredients 不得报 matched）
//
// 契约承诺（该 operation description）：「登记号+成分含量剂型精确核对，缺失/冲突不matched」；
// `docs/architecture/state-contract.md` 亦写明「必须登记号+全部可见成分/含量/剂型精确一致，
// 缺字段为 insufficient 而非 matched」。共享内核 `decideMatchState` 的必要字段只含
// 登记号/名称 ⇒ 缺剂型/成分时它不进入冲突检查、会给出 `matched` + `missing_fields: []`，
// 调用方会把未核对的维度读成核对完成。以下用例钉死本片服务层的补位口径。
// ---------------------------------------------------------------------------

test('G1. 缺 dosage_form（null）⇒ 非 matched（insufficient），missing_fields 明确含 dosage_form', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  const data = await service.verify({ fields: fieldsOf({ dosage_form: null }), conditions: null });

  assert.notEqual(data.match_state, 'matched', '缺待核维度绝不得报核对通过');
  assert.equal(data.match_state, 'insufficient');
  assert.deepEqual(data.missing_fields, ['dosage_form']);
  assert.deepEqual(data.conflict_fields, [], '缺失不是冲突（不得混用两个清单）');
  assert.equal(data.registration, null, '未核对完成不得带出候选记录（否则会被读成「已命中」）');
  assert.deepEqual(data.dose_cards, []);
  assert.deepEqual(Object.keys(data).sort(), VERIFICATION_KEYS, '改判后仍严格是契约五键');
  assert.equal(schemas.MatchState.enum.includes(data.match_state), true, '不得新造枚举值');
});

test('G2. dosage_form 为空串 / 纯空白 ⇒ 同一结论（空读归一为未采集，不报 conflict）', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  // `''` 在 HTTP 层会被 minLength 1 挡掉，但服务层是导出面；`'   '` / 全角空格在两个面都能到。
  for (const value of ['', '   ', '\t\n　']) {
    const data = await service.verify({ fields: fieldsOf({ dosage_form: value }), conditions: null });
    assert.equal(
      data.match_state,
      'insufficient',
      `dosage_form=${JSON.stringify(value)} 必须落「未采集」而不是 matched/conflict`,
    );
    assert.deepEqual(data.missing_fields, ['dosage_form'], `dosage_form=${JSON.stringify(value)}`);
    assert.deepEqual(data.conflict_fields, [], '空读不是「读到的剂型不一致」⇒ 不得报 conflict');
    assert.equal(data.registration, null);
  }
});

test('G3. ingredients=[] ⇒ 非 matched（insufficient），missing_fields 明确含 ingredients', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  const data = await service.verify({ fields: fieldsOf({ ingredients: [] }), conditions: null });

  assert.notEqual(data.match_state, 'matched');
  assert.equal(data.match_state, 'insufficient');
  assert.deepEqual(data.missing_fields, ['ingredients']);
  assert.deepEqual(data.conflict_fields, []);
  assert.equal(data.registration, null);
  assert.deepEqual(data.dose_cards, []);
});

test('G4. 两者都缺 ⇒ missing_fields 同时含两者；与内核缺项合并时互不覆盖（内核在前）', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  const both = await service.verify({ fields: fieldsOf({ dosage_form: null, ingredients: [] }), conditions: null });
  assert.equal(both.match_state, 'insufficient');
  assert.deepEqual(both.missing_fields, ['dosage_form', 'ingredients']);

  // 合并口径：内核必要字段（登记号/名称）在前，待核维度在后，一个都不删。
  const merged = await service.verify({
    fields: fieldsOf({ registration_number: null, dosage_form: null, ingredients: [] }),
    conditions: null,
  });
  assert.equal(merged.match_state, 'insufficient');
  assert.deepEqual(merged.missing_fields, ['registration_number', 'dosage_form', 'ingredients']);

  // 口径本身也钉死（清单与顺序固定 ⇒ `missing_fields` 读数可逐字节复现）。
  assert.deepEqual([...VERIFY_DIMENSION_FIELDS], ['dosage_form', 'ingredients']);
  assert.deepEqual(
    missingVerifiableDimensions(fieldsOf({ dosage_form: '   ', ingredients: [] })),
    ['dosage_form', 'ingredients'],
    '空读与空数组都由同一处口径判缺',
  );
});

test('G5. 正控制：三维齐备且一致 ⇒ 仍是 matched；带前后空白的**已读到**值不被改判', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });

  const exact = await service.verify({ fields: fieldsOf(), conditions: null });
  assert.equal(exact.match_state, 'matched', '本片不得把正常路径改坏');
  assert.deepEqual(exact.missing_fields, []);
  assert.deepEqual(exact.conflict_fields, []);
  assert.equal(exact.registration.formulation.registration_number, RECORD.registration_number);
  assert.deepEqual(exact.dose_cards, []);

  // 边界：本片只把「归一后为空」当缺失；有内容的取值一律原样交给内核比对
  // （前后空白/全角由 `normalizeComparableText` 消除 ⇒ 仍是同一值）。
  const padded = await service.verify({
    fields: fieldsOf({
      dosage_form: '  水分散粒剂  ',
      ingredients: [{ name: ' 唑草酮 ', content_text: '40%', unit_text: '%' }],
    }),
    conditions: null,
  });
  assert.equal(padded.match_state, 'matched');
  assert.deepEqual(padded.missing_fields, []);
});

test('G6. 优先级：内核已判 conflict ⇒ 不降级为 insufficient，缺失维度仍如实进 missing_fields', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  const data = await service.verify({ fields: fieldsOf({ dosage_form: '乳油', ingredients: [] }), conditions: null });

  assert.equal(data.match_state, 'conflict', '强结论不得因「另有缺项」被降级');
  assert.deepEqual(data.conflict_fields, ['dosage_form']);
  assert.deepEqual(data.missing_fields, ['ingredients'], '缺失维度仍须体现，不得被强结论吞掉');
  assert.notEqual(data.registration, null, '冲突时仍如实带出记录供复核（内核既有口径）');
});

test('G7. 优先级：no_match 与缺项同时存在 ⇒ 保持 no_match（缺失不把强结论降级）', async () => {
  const service = createRegistrationVerifyService({ executionMode: 'stub' });
  const data = await service.verify({
    fields: fieldsOf({ registration_number: 'PD00000000', name: '不存在的药剂名称', dosage_form: null, ingredients: [] }),
    conditions: null,
  });

  assert.equal(data.match_state, 'no_match');
  assert.equal(data.registration, null);
  assert.deepEqual(data.conflict_fields, []);
  assert.deepEqual(data.missing_fields, ['dosage_form', 'ingredients']);
});

test('G8. 优先级（其余结论）：ambiguous / unavailable 同样不降级，缺失维度只进 missing_fields', async () => {
  // ambiguous：名称命中多条不同制剂（仓内「烯草酮」两条）。
  const stub = createRegistrationVerifyService({ executionMode: 'stub' });
  const ambiguous = await stub.verify({
    fields: fieldsOf({ registration_number: 'PD99999999', name: '烯草酮', dosage_form: null, ingredients: [] }),
    conditions: null,
  });
  assert.equal(ambiguous.match_state, 'ambiguous');
  assert.deepEqual(ambiguous.missing_fields, ['dosage_form', 'ingredients']);

  // unavailable：real 模式真实登记库未接线（不可用绝不被「缺项」掩盖）。
  const real = createRegistrationVerifyService({ executionMode: 'real' });
  const unavailable = await real.verify({ fields: fieldsOf({ dosage_form: null, ingredients: [] }), conditions: null });
  assert.equal(unavailable.match_state, 'unavailable');
  assert.equal(unavailable.registration, null);
  assert.deepEqual(unavailable.missing_fields, ['dosage_form', 'ingredients']);
});
