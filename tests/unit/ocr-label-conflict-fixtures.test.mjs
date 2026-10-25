// R18 · 登记冲突合成标签夹具（同名不同制剂 / 过期登记 / 登记证被撤销）
//
// 本文件把两类断言分开标注，不混为一谈：
//   ① 【固定现状】产品当前**没有**该项判定或字段，这里钉住「现在实际观测到什么」，
//      防止将来把两份不同的登记静默合并、或无声新增/删除字段；
//      产品尚无冲突判定（标签级）时，本测试固定现状，防止未来无声合并。
//   ② 【真判定】直接调用仓内已存在的判定函数（登记匹配决策 / 契约制剂身份 / 读面状态），
//      断言它们对冲突样本给出正确结果 —— 不为让测试变绿而修改产品代码。
//
// 夹具全部是合成构造（每份文件头都有声明），不含任何真实登记标签内容。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildLabelUrl,
  canonicalFacts,
  extractLabelFacts,
  fixturePathFor,
  sha256Hex,
} from '../../tools/knowledge/fetch-icama-label.mjs';
import {
  CONFLICT_FIELD_SOURCE_VALIDITY,
  decideMatchState,
  registrationStateConflicts,
  sanitizeRegistryLookup,
} from '../../services/api/src/ocr/state.ts';
import {
  deriveReferenceState,
  formulationIdentityHash,
} from '../../packages/reference/index.mjs';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/icama-label/', import.meta.url));
const FIXED_NOW = '2026-10-15T00:00:00.000Z';
const SYNTHETIC_NOTE = '合成构造，不是任何真实标签的拷贝';
const CONFLICT_FIXTURES = ['PD99999905', 'PD99999906', 'PD99999907'];
const ALL_FIXTURES = ['PD99999901', ...CONFLICT_FIXTURES];

function readFixture(registrationNo) {
  return readFileSync(fixturePathFor(FIXTURE_DIR, registrationNo), 'utf8');
}

function extractFixture(registrationNo) {
  const html = readFixture(registrationNo);
  return extractLabelFacts(html, {
    sourceUrl: buildLabelUrl('https://www.icama.cn', registrationNo),
    retrievedAt: FIXED_NOW,
    payloadSha256: sha256Hex(Buffer.from(html, 'utf8')),
    registrationNo,
    mode: 'fixture',
  });
}

const FACTS = new Map(ALL_FIXTURES.map((no) => [no, extractFixture(no)]));

function factsOf(registrationNo) {
  const record = FACTS.get(registrationNo);
  assert.ok(record, `夹具 ${registrationNo} 未被抽取`);
  return record;
}

// 抽取器只把「有效成分及其含量」原文照录，仓内没有把它解析成结构化 Ingredient 的判定路径。
// 这里刻意给空数组而不是臆造一个解析器：LabelFields.ingredients 是必填字段，空数组合法，
// 且 conflictFields 对「标签侧成分为空」不作冲突判断（缺字段不算冲突）。
function labelFieldsOf(record) {
  return {
    registration_number: record.registrationNoInPage,
    name: record.productName,
    ingredients: [],
    dosage_form: record.formulation,
  };
}

const UUID_SLOT = { herbicide: 'a', formulation: 'b', source: 'c' };

function uuidOf(registrationNo, slot) {
  const digit = registrationNo.slice(-1);
  const tail = `${UUID_SLOT[slot]}${digit}`.padStart(12, '0');
  return `0000000${digit}-0000-4000-8000-${tail}`;
}

// 按 services/api/src/ocr/state.ts 的登记记录校验器构造合成登记记录（不含真实登记库数据）。
// source.source_kind='simulation' 标明这是合成来源；url 用 .invalid 保留域。
function registryRecordOf(record, sourceOverrides = {}) {
  return {
    id: uuidOf(record.registrationNoInPage, 'herbicide'),
    revision: 1,
    formulation: {
      id: uuidOf(record.registrationNoInPage, 'formulation'),
      registration_number: record.registrationNoInPage,
      producer: record.holder,
      dosage_form: record.formulation,
      ingredients: [
        { name: record.activeIngredient, content_text: '原文照录', unit_text: '原文照录' },
      ],
    },
    source: {
      id: uuidOf(record.registrationNoInPage, 'source'),
      version: 'synthetic-1',
      title: '合成夹具登记记录（非真实登记库记录）',
      url: `https://fixture.invalid/icama-label/${record.registrationNoInPage}`,
      publisher: '合成构造（非真实来源）',
      source_kind: 'simulation',
      evidence_kind: 'research',
      validity: 'valid',
      review_status: 'unverified',
      updated_at: FIXED_NOW,
      ...sourceOverrides,
    },
    risk_text: '合成夹具，不含真实风险文本。',
    reference_state: 'available',
  };
}

function availableLookup(...records) {
  return sanitizeRegistryLookup({ status: 'available', candidates: records });
}

test('R18-1 【固定现状】三份冲突夹具按既有命名约定被夹具装载器读到，且页头声明合成构造', () => {
  for (const registrationNo of CONFLICT_FIXTURES) {
    const path = fixturePathFor(FIXTURE_DIR, registrationNo);
    assert.equal(path, join(FIXTURE_DIR, `label-${registrationNo}.html`), '文件名必须沿用 label-<登记号>.html');
    assert.equal(statSync(path).isFile(), true, '夹具文件必须存在');

    const html = readFixture(registrationNo);
    assert.equal(html.startsWith('<!DOCTYPE html>'), true, '页头先于注释（沿用既有夹具结构）');
    assert.equal(html.includes(SYNTHETIC_NOTE), true, '每份夹具必须自带合成构造声明');
    assert.equal(html.charCodeAt(0), 60, '不得带 BOM');
    assert.equal(html.includes('\r'), false, '夹具用 LF 换行');

    const record = factsOf(registrationNo);
    assert.equal(record.status, 'ok', '必须被当成一张可解析的标签页，而不是无结果页/登录墙');
    assert.equal(record.registrationNoInPage, registrationNo);
    assert.equal(record.extraction.mode, 'fixture');

    // 真判定：合成登记记录必须能通过登记库载荷清洗，才谈得上被匹配决策消费
    assert.equal(availableLookup(registryRecordOf(record)).status, 'available');
  }
});

test('R18-2 【真判定】同名不同制剂：同一商品名的两份夹具不会被判成同一条登记', () => {
  const normal = factsOf('PD99999901');
  const variant = factsOf('PD99999905');

  // 场景成立性：同名，但登记号/剂型/成分含量不同
  assert.equal(variant.productName, normal.productName, '两份夹具必须同名（示例除草剂甲）');
  assert.notEqual(variant.formulation, normal.formulation);
  assert.notEqual(variant.activeIngredient, normal.activeIngredient);
  assert.notEqual(variant.registrationNoInPage, normal.registrationNoInPage);

  // 真判定①：用 PD99999901 那条登记记录核对 PD99999905 的标签 ⇒ conflict，且冲突字段点名
  const lookup = availableLookup(registryRecordOf(normal));
  assert.equal(lookup.status, 'available');
  const decision = decideMatchState(labelFieldsOf(variant), lookup);
  assert.equal(decision.match_state, 'conflict', '同名不同制剂必须判冲突，不得 matched');
  assert.deepEqual([...decision.conflict_fields].sort(), ['dosage_form', 'registration_number']);
  assert.deepEqual(decision.missing_fields, []);
  assert.equal(
    decision.registration?.formulation.registration_number,
    'PD99999901',
    '冲突时仍应如实带出被比对的那条登记供复核',
  );

  // 正控制：同一份标签对自己的登记记录 ⇒ matched（证明上面的 conflict 来自差异本身）
  const self = decideMatchState(labelFieldsOf(normal), lookup);
  assert.equal(self.match_state, 'matched');
  assert.deepEqual(self.conflict_fields, []);

  // 真判定②：契约制剂身份对同名不同剂型/含量必须不同 ⇒ 不会被合并成同一条制剂
  const identityOf = (record) => formulationIdentityHash({
    registered_name: record.productName,
    dosage_form: record.formulation,
    ingredients_text: record.activeIngredient,
  });
  assert.notEqual(identityOf(normal), identityOf(variant), '同名不同含量剂型不得同一制剂身份');
});

test('R18-3 【固定现状+真判定】过期登记：标签只照录有效期原文，过期由登记记录 validity 判定', () => {
  const normal = factsOf('PD99999901');
  const expired = factsOf('PD99999906');

  // 固定现状：抽取器把标签上的有效期原文照录，不做过期计算、不看时钟
  assert.equal(expired.validity, '有效期至2021-06-30');
  assert.equal(Object.hasOwn(expired.nullReasons, 'validity'), false);
  assert.equal(expired.precautionsAsPublished.includes('有效期至2021-06-30'), true);
  // 对照：PD99999901 页面未载明有效期 ⇒ unknown + 缺项理由（两份夹具在现有解析输出上可区分）
  assert.equal(normal.validity, 'unknown');
  assert.equal(normal.nullReasons.validity, 'label_page_does_not_state_registration_validity_period');
  // 固定现状：抽取器输出里没有 expired/withdrawn 之类状态枚举 —— 过期不在标签层判定
  const canonicalText = JSON.stringify(canonicalFacts(expired));
  assert.equal(/expired|withdrawn/.test(canonicalText), false);
  assert.equal(canonicalText.includes('2021-06-30'), true);

  // 真判定①：登记记录 validity 非 valid ⇒ 判冲突并点名 source.validity
  const staleRecord = registryRecordOf(expired, { validity: 'expired' });
  assert.deepEqual(registrationStateConflicts(staleRecord), [CONFLICT_FIELD_SOURCE_VALIDITY]);
  const lookup = availableLookup(staleRecord);
  assert.equal(lookup.status, 'available', '过期记录仍是可解析候选，由决策层判冲突而非在载荷清洗处丢件');
  const decision = decideMatchState(labelFieldsOf(expired), lookup);
  assert.equal(decision.match_state, 'conflict');
  assert.deepEqual(decision.conflict_fields, [CONFLICT_FIELD_SOURCE_VALIDITY]);
  assert.equal(decision.registration?.source.validity, 'expired');

  // 真判定②：有效期枚举为 expired ⇒ 读面不可查询
  assert.equal(
    deriveReferenceState({
      registration_number: expired.registrationNoInPage,
      source: { source_validity: 'expired' },
    }),
    'unavailable',
  );
});

test('R18-4 【固定现状+真判定】登记证被撤销：产品没有标签级撤销字段，撤销经登记记录 validity 参与判定', () => {
  const normal = factsOf('PD99999901');
  const withdrawn = factsOf('PD99999907');

  // 固定现状：抽取器没有「登记证状态」字段（键集与正常标签完全一致），不臆造字段
  assert.deepEqual(Object.keys(withdrawn).sort(), Object.keys(normal).sort());
  assert.equal(withdrawn.licensed, false);
  assert.equal(withdrawn.licenseSurveyStatus, 'not_established');
  // 固定现状：撤销/注销措辞不落进 restrictedOrBanned（该字段只扫禁用/限制使用一类词）
  assert.equal(withdrawn.restrictedOrBanned, null);
  assert.equal(withdrawn.nullReasons.restrictedOrBanned, 'no_restriction_wording_in_label_text');
  assert.equal(withdrawn.precautionsAsPublished.includes('已被撤销'), true);
  // 固定现状：无有效期文字 ⇒ 与 PD99999901 同口径 unknown
  assert.equal(withdrawn.validity, 'unknown');
  assert.notEqual(withdrawn.productName, normal.productName);

  // 真判定①：登记记录 validity='withdrawn' ⇒ 判冲突并点名 source.validity（不得给出「核对通过」）
  const revokedRecord = registryRecordOf(withdrawn, { validity: 'withdrawn' });
  assert.deepEqual(registrationStateConflicts(revokedRecord), [CONFLICT_FIELD_SOURCE_VALIDITY]);
  const decision = decideMatchState(labelFieldsOf(withdrawn), availableLookup(revokedRecord));
  assert.equal(decision.match_state, 'conflict');
  assert.deepEqual(decision.conflict_fields, [CONFLICT_FIELD_SOURCE_VALIDITY]);

  // 真判定②：注销 ⇒ 读面不可查询；正控制 valid ⇒ 可查询
  assert.equal(
    deriveReferenceState({
      registration_number: withdrawn.registrationNoInPage,
      source: { source_validity: 'withdrawn' },
    }),
    'unavailable',
  );
  assert.equal(
    deriveReferenceState({
      registration_number: withdrawn.registrationNoInPage,
      source: { source_validity: 'valid' },
    }),
    'available',
  );
});

test('R18-5 【固定现状】四份标签夹具的事实指纹两两不同 —— 冲突样本不会在事实层被无声合并', () => {
  const records = ALL_FIXTURES.map((registrationNo) => factsOf(registrationNo));

  const hashes = new Set(records.map((record) => record.factsSha256));
  assert.equal(hashes.size, records.length, '同名不同制剂/过期/撤销三份夹具的事实指纹必须各不同');
  for (const record of records) {
    assert.match(record.factsSha256, /^[a-f0-9]{64}$/);
  }

  // 口径兜底：即使哈希口径被换成常量，canonicalFacts 也必须逐份不同
  const canonical = new Set(records.map((record) => JSON.stringify(canonicalFacts(record))));
  assert.equal(canonical.size, records.length);
});