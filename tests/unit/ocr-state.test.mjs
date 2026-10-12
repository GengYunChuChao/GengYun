/**
 * GY-I10 标签 OCR · 判定状态与 fail-closed 硬约束单元回归（Refs #10）。
 *
 * 本文件只做**纯函数**层验证（不依赖 HTTP、不依赖数据库），逐条对应派单 §4 的硬性验收条件：
 *   1. MatchState 闭集恰为契约 6 值；
 *   2. 6 类状态每一类都能被真实构造并观察到；
 *   3. missing_fields 非空 ⇒ 绝不得 matched；conflict_fields 非空 ⇒ conflict；
 *      多候选无法区分 ⇒ ambiguous；登记库不可用 ⇒ unavailable（不得用 no_match 掩盖）；
 *   4. dose_cards 被适用性判定 gate：条件缺失/不全、来源模拟/过期/未核对 ⇒ 必为 []，且不补造。
 *
 * **用量卡的重要口径**（对应 GY-I07 验收第 3 条「不对模拟记录显示真实用量」）：
 * 生产装配（替身 / 未接线）**恒返回空候选**，生产路径的 dose_cards 恒为 []。
 * 因此本文件里用来证明 gate **通过面**的候选，是**测试注入的契约合法可信来源**
 * （`INJECTED_TRUSTED_CANDIDATES`，明确命名、明确标注），**不是**生产替身数据 ——
 * 绝不让替身来源扮演「已核对有效」来源。
 *
 * 断言一律**先判 typeof / Array.isArray 再判值**，避免 `undefined === undefined` 式的假通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  MATCH_STATES,
  MAX_DOSE_CARDS,
  isMatchState,
  decideMatchState,
  conflictFields,
  missingNecessaryFields,
  missingDoseConditionFields,
  isDoseConditionsComplete,
  normalizeLabelFields,
  normalizeConditions,
  normalizeIngredients,
  gateDoseCards,
  decideDoseCard,
  sanitizeRegistryLookup,
  OcrProtocolError,
} from '../../services/api/src/ocr/state.ts';
import { SUBSTITUTE_REGISTRY } from '../../services/api/src/ocr/reference.ts';

// ---------------------------------------------------------------- 断言辅助

function assertString(value, label) {
  assert.equal(typeof value, 'string', `${label} 必须是 string，实际是 ${typeof value}`);
}

function assertArray(value, label) {
  assert.ok(Array.isArray(value), `${label} 必须是数组，实际是 ${typeof value}`);
  return value;
}

function assertEmptyArray(value, label) {
  assertArray(value, label);
  assert.equal(value.length, 0, `${label} 必须为空数组，实际有 ${value.length} 项`);
}

/** 契约 LabelFields 的完整合法样本（可覆盖单项）。 */
function fields(overrides = {}) {
  return {
    registration_number: 'PD20210001',
    name: '替身示例草甘膦水剂',
    ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
    dosage_form: '水剂',
    ...overrides,
  };
}

/** 登记库可用 + 给定候选。 */
function available(candidates) {
  return { status: 'available', candidates };
}

// ------------------------------------------- 测试注入的用量卡来源（非生产数据）

/** 用量卡绑定的完整六项条件样例（契约 DoseConditions 要求全齐）。 */
const DOSE_CONDITIONS_SAMPLE = {
  crop_id: 'rice',
  region_code: '330100',
  species_id: 'species_barnyardgrass',
  growth_stage: '3-5叶期',
  planting_method: '移栽',
  use_scene: '水稻田',
};

/**
 * 构造一张**测试注入的、契约合法且来源可信**的用量卡候选。
 *
 * 这是**测试夹具**，不是生产数据：生产替身端口不产出任何候选（见 ocr/reference.ts）。
 * 只有在这里才能构造「来源可信」形态，用于证明 gate 的通过面与逐项拒绝面。
 */
function trustedDoseCandidate(overrides = {}) {
  const { conditions: conditionOverrides = {}, card: cardOverrides = {}, ...rest } = overrides;
  const registrationNumber = rest.registrationNumber ?? 'PD20210001';
  const cardId = rest.cardId ?? '55555555-5555-4555-8555-555555555555';
  const conditions = { ...DOSE_CONDITIONS_SAMPLE, ...conditionOverrides };
  const originalText = '测试注入·登记标签原文用量：防除稗草，按登记标签标注的制剂用量与施药方法使用。';
  const locator = '测试注入·标签「使用技术与使用方法」第 1 段';
  const card = {
    id: cardId,
    revision: 1,
    formulation: {
      id: cardId,
      registration_number: registrationNumber,
      producer: '测试注入合成生产企业',
      dosage_form: '水剂',
      ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
    },
    conditions,
    original_text: originalText,
    unit_text: '毫升/亩',
    method_text: '测试注入·定向喷雾，避免药液漂移到邻近敏感作物。',
    precautions_text: '测试注入·注意事项。',
    source: {
      id: 'bbbbbbbb-0000-4000-8000-000000000001',
      version: 'test-injected-1',
      title: '测试注入用量登记资料',
      url: 'https://example.invalid/test-injected/dose',
      publisher: '测试注入本地用量库',
      source_kind: 'database',
      evidence_kind: 'mixed',
      validity: 'valid',
      review_status: 'verified',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    locator,
    content_hash: createHash('sha256')
      .update(`${originalText}\u0000${locator}\u0000${registrationNumber}`, 'utf8')
      .digest('hex'),
    ...cardOverrides,
  };
  return {
    card,
    formulation_registration_number: registrationNumber,
    conditions,
    source_kind: rest.source_kind ?? 'database',
    validity: rest.validity ?? 'valid',
    review_status: rest.review_status ?? 'verified',
    simulated: rest.simulated ?? false,
  };
}

/** 测试注入的可信候选（单条），供各用例复用。 */
const INJECTED_TRUSTED_CANDIDATES = [trustedDoseCandidate()];

/** 基于注入候选构造变体（`card` / `conditions` 做浅合并）。 */
function variantOfCandidate(candidate, overrides = {}) {
  return {
    ...candidate,
    ...overrides,
    card: { ...candidate.card, ...(overrides.card ?? {}) },
    conditions: { ...candidate.conditions, ...(overrides.conditions ?? {}) },
  };
}

const R1 = SUBSTITUTE_REGISTRY[0];
const R3 = SUBSTITUTE_REGISTRY[2];
const R4 = SUBSTITUTE_REGISTRY[3];

// ---------------------------------------------------------------- 1. 闭集

test('MatchState 闭集恰为契约 6 值（逐项一致，不多不少）', () => {
  assertArray(MATCH_STATES, 'MATCH_STATES');
  assert.deepEqual(
    [...MATCH_STATES],
    ['matched', 'no_match', 'ambiguous', 'conflict', 'insufficient', 'unavailable'],
  );
  for (const state of MATCH_STATES) {
    assertString(state, 'MatchState 成员');
    assert.equal(isMatchState(state), true, `${state} 应被 isMatchState 接受`);
  }
  // 负例：大小写变体 / 近义值 / undefined 一律不得被当成合法状态。
  for (const bogus of ['MATCHED', 'match', 'unknown', '', null, undefined, 0]) {
    assert.equal(isMatchState(bogus), false, `${String(bogus)} 不得被当成合法 MatchState`);
  }
});

// ---------------------------------------------------------------- 2. 六类状态逐类构造

test('六类之一 matched：字段齐全且与唯一登记记录一致', () => {
  const decision = decideMatchState(fields(), available([R1]));
  assertString(decision.match_state, 'match_state');
  assert.equal(decision.match_state, 'matched');
  assert.notEqual(decision.registration, null, 'matched 必须带出命中的登记记录');
  assertString(decision.registration.formulation.registration_number, 'registration.formulation.registration_number');
  assert.equal(decision.registration.formulation.registration_number, 'PD20210001');
  assertEmptyArray(decision.conflict_fields, 'matched.conflict_fields');
  assertEmptyArray(decision.missing_fields, 'matched.missing_fields');
});

test('六类之二 no_match：登记库可用且字段齐全，但无候选', () => {
  const decision = decideMatchState(fields({ registration_number: 'PD99999999' }), available([]));
  assert.equal(decision.match_state, 'no_match');
  assert.equal(decision.registration, null);
  assertEmptyArray(decision.missing_fields, 'no_match.missing_fields');
  assertEmptyArray(decision.conflict_fields, 'no_match.conflict_fields');
});

test('六类之三 ambiguous：多候选且登记号无法收敛到唯一一条', () => {
  // 登记号 PD20210005 不在库，名称命中 R3/R4 两条 → 无法区分。
  const decision = decideMatchState(fields({ registration_number: 'PD20210005' }), available([R3, R4]));
  assert.equal(decision.match_state, 'ambiguous');
  assert.equal(decision.registration, null, 'ambiguous 不得擅自挑一条当结论');
});

test('六类之四 conflict：唯一命中但字段与登记记录冲突', () => {
  const decision = decideMatchState(fields({ dosage_form: '乳油' }), available([R1]));
  assert.equal(decision.match_state, 'conflict');
  assertArray(decision.conflict_fields, 'conflict.conflict_fields');
  assert.ok(decision.conflict_fields.length > 0, 'conflict 必须带出冲突字段');
  assert.equal(decision.conflict_fields.includes('dosage_form'), true, '冲突字段应含 dosage_form');
  assertEmptyArray(decision.missing_fields, 'conflict.missing_fields');
});

test('六类之五 insufficient：必要条件（登记号）未采集', () => {
  const decision = decideMatchState(fields({ registration_number: null }), available([R1]));
  assert.equal(decision.match_state, 'insufficient');
  assertArray(decision.missing_fields, 'insufficient.missing_fields');
  assert.equal(decision.missing_fields.includes('registration_number'), true);
  assert.equal(decision.registration, null);
});

test('六类之六 unavailable：登记库不可用', () => {
  const decision = decideMatchState(fields(), { status: 'unavailable', reason: '登记库未接线' });
  assert.equal(decision.match_state, 'unavailable');
  assert.equal(decision.registration, null);
  assertEmptyArray(decision.conflict_fields, 'unavailable.conflict_fields');
});

test('六类状态在闭集内且互不相同（逐类可观测，不重合）', () => {
  const observed = [
    decideMatchState(fields(), available([R1])).match_state,
    decideMatchState(fields({ registration_number: 'PD99999999' }), available([])).match_state,
    decideMatchState(fields({ registration_number: 'PD20210005' }), available([R3, R4])).match_state,
    decideMatchState(fields({ dosage_form: '乳油' }), available([R1])).match_state,
    decideMatchState(fields({ registration_number: null }), available([R1])).match_state,
    decideMatchState(fields(), { status: 'unavailable', reason: 'x' }).match_state,
  ];
  for (const state of observed) assert.equal(isMatchState(state), true, `${state} 必须在闭集内`);
  assert.equal(new Set(observed).size, 6, `6 类应互不相同，实际 ${JSON.stringify(observed)}`);
  assert.deepEqual([...observed].sort(), [...MATCH_STATES].sort());
});

// ---------------------------------------------------------------- 3. fail-closed 反例（逐条可单独指出）

test('反例·登记库不可用绝不得被 no_match 掩盖', () => {
  const unavailable = decideMatchState(fields(), { status: 'unavailable', reason: '未接线' });
  const noMatch = decideMatchState(fields(), available([]));
  assert.equal(unavailable.match_state, 'unavailable');
  assert.notEqual(unavailable.match_state, 'no_match', '不可用不得伪装成无匹配');
  assert.notEqual(unavailable.match_state, noMatch.match_state, '两者必须是不同结论');
});

test('反例·missing_fields 非空时即使存在完美候选也绝不得 matched', () => {
  const decision = decideMatchState(fields({ registration_number: null }), available([R1]));
  assert.notEqual(decision.match_state, 'matched');
  assert.equal(decision.match_state, 'insufficient');
  assert.ok(decision.missing_fields.length > 0);
  assert.equal(decision.registration, null, '缺项时不得带出"可能匹配"的登记记录');
});

test('反例·名称缺失同样落 insufficient（登记号精确命中也不行）', () => {
  const decision = decideMatchState(fields({ name: null }), available([R1]));
  assert.equal(decision.match_state, 'insufficient');
  assert.equal(decision.missing_fields.includes('name'), true);
  assert.notEqual(decision.match_state, 'matched');
});

test('反例·登记号与名称同时缺失时 missing_fields 至少含两项', () => {
  const decision = decideMatchState(fields({ registration_number: null, name: null }), available([R1]));
  assert.equal(decision.match_state, 'insufficient');
  assert.ok(decision.missing_fields.length >= 2, `实际 ${JSON.stringify(decision.missing_fields)}`);
});

test('反例·conflict_fields 非空必定落 conflict（不得因可命中就报 matched）', () => {
  const decision = decideMatchState(fields({ dosage_form: '乳油' }), available([R1]));
  assert.ok(decision.conflict_fields.length > 0);
  assert.equal(decision.match_state, 'conflict');
  assert.notEqual(decision.match_state, 'matched');
});

test('反例·成分不一致也算冲突（ingredients 参与冲突判定）', () => {
  const decision = decideMatchState(
    fields({ ingredients: [{ name: '草甘膦', content_text: '30', unit_text: '%' }] }),
    available([R1]),
  );
  assert.equal(decision.match_state, 'conflict');
  assert.equal(decision.conflict_fields.includes('ingredients'), true);
});

test('反例·多候选无法区分必定落 ambiguous（不得取第一个当结论）', () => {
  const decision = decideMatchState(fields({ registration_number: 'PD20210005' }), available([R3, R4]));
  assert.equal(decision.match_state, 'ambiguous');
  assert.equal(decision.registration, null);
  assert.notEqual(decision.match_state, 'matched');
});

test('反例·登记号可收敛多候选时不落 ambiguous（证明不是机械地"多候选即 ambiguous"）', () => {
  const decision = decideMatchState(fields(), available([R1, R3]));
  assert.equal(decision.match_state, 'matched');
  assert.notEqual(decision.registration, null);
  assert.equal(decision.registration.formulation.registration_number, 'PD20210001');
});

test('不变量·matched ⇒ missing_fields 与 conflict_fields 同时为空', () => {
  const decision = decideMatchState(fields(), available([R1]));
  assert.equal(decision.match_state, 'matched');
  assertEmptyArray(decision.missing_fields, 'matched.missing_fields');
  assertEmptyArray(decision.conflict_fields, 'matched.conflict_fields');
});

test('不变量·非 matched 的结论一律不得带出 registration 或仅 conflict 例外', () => {
  const cases = [
    decideMatchState(fields(), { status: 'unavailable', reason: 'x' }),
    decideMatchState(fields({ registration_number: null }), available([R1])),
    decideMatchState(fields(), available([])),
    decideMatchState(fields({ registration_number: 'PD20210005' }), available([R3, R4])),
  ];
  for (const decision of cases) {
    assert.notEqual(decision.match_state, 'matched');
    assert.equal(decision.registration, null, `${decision.match_state} 不得带出登记记录`);
  }
});

test('辅助函数·missingNecessaryFields 与 conflictFields 与 decideMatchState 口径一致', () => {
  assert.deepEqual([...missingNecessaryFields(fields({ registration_number: null }))], ['registration_number']);
  assertEmptyArray(missingNecessaryFields(fields()), 'missingNecessaryFields(完整字段)');
  assertEmptyArray(conflictFields(fields(), R1), 'conflictFields(一致)');
  assert.deepEqual([...conflictFields(fields({ dosage_form: '乳油' }), R1)], ['dosage_form']);
});

// ---------------------------------------------------------------- 4. dose_cards 适用性 gate

test('dose gate 通过面（**测试注入**契约合法可信来源）·条件齐全 + 绑定同一登记制剂 ⇒ 放行 1 张', () => {
  const candidate = INJECTED_TRUSTED_CANDIDATES[0];
  const outcome = gateDoseCards({
    candidates: [candidate],
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assertArray(outcome.dose_cards, 'dose_cards');
  assert.equal(outcome.dose_cards.length, 1);
  assertString(outcome.dose_cards[0].original_text, 'dose_card.original_text');
  assert.equal(outcome.rejections.length, 0);
});

test('反例·conditions 缺失 ⇒ dose_cards 必为 []（且原因可指出）', () => {
  const decision = decideDoseCard(INJECTED_TRUSTED_CANDIDATES[0], { conditions: null, registrationNumber: 'PD20210001' });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'CONDITIONS_ABSENT');
  const outcome = gateDoseCards({ candidates: [INJECTED_TRUSTED_CANDIDATES[0]], conditions: null, registrationNumber: 'PD20210001' });
  assertEmptyArray(outcome.dose_cards, 'conditions 缺失时的 dose_cards');
});

test('反例·conditions 不全（只给 crop_id + region_code）⇒ dose_cards 必为 []', () => {
  const partial = { crop_id: 'rice', region_code: '330100' };
  const decision = decideDoseCard(INJECTED_TRUSTED_CANDIDATES[0], { conditions: partial, registrationNumber: 'PD20210001' });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'CONDITIONS_INCOMPLETE');
  const outcome = gateDoseCards({ candidates: [INJECTED_TRUSTED_CANDIDATES[0]], conditions: partial, registrationNumber: 'PD20210001' });
  assertEmptyArray(outcome.dose_cards, 'conditions 不全时的 dose_cards');
});

test('反例·只凭来源"可用"标记不得放行：模拟来源必被 gate 丢弃', () => {
  const simulated = variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], { simulated: true });
  const decision = decideDoseCard(simulated, {
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'SOURCE_SIMULATED');
  const outcome = gateDoseCards({
    candidates: [simulated],
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assertEmptyArray(outcome.dose_cards, '模拟来源时的 dose_cards');
});

test('反例·source_kind=simulation ⇒ dose_cards 必为 []', () => {
  const simulated = variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], { source_kind: 'simulation', simulated: false });
  const outcome = gateDoseCards({
    candidates: [simulated],
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assertEmptyArray(outcome.dose_cards, 'simulation 来源时的 dose_cards');
  assert.equal(outcome.rejections[0]?.reason, 'SOURCE_SIMULATED');
});

test('反例·来源过期 ⇒ dose_cards 必为 []', () => {
  const expired = variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], { validity: 'expired' });
  const decision = decideDoseCard(expired, {
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'SOURCE_EXPIRED');
  const outcome = gateDoseCards({
    candidates: [expired],
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assertEmptyArray(outcome.dose_cards, '过期来源时的 dose_cards');
});

test('反例·来源未核对 ⇒ dose_cards 必为 []', () => {
  const unverified = variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], { review_status: 'unverified' });
  const outcome = gateDoseCards({
    candidates: [unverified],
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assertEmptyArray(outcome.dose_cards, '未核对来源时的 dose_cards');
  assert.equal(outcome.rejections[0]?.reason, 'SOURCE_UNVERIFIED');
});

test('反例·请求条件与**卡片**绑定的六项条件不一致 ⇒ dose_cards 必为 []（归因指向卡片）', () => {
  // 请求说"分蘖期"，卡片与候选外层都绑"3-5叶期" ⇒ 判定对象是卡片，故归因为 CARD_CONDITIONS_MISMATCH。
  const mismatched = { ...DOSE_CONDITIONS_SAMPLE, growth_stage: '分蘖期' };
  const decision = decideDoseCard(INJECTED_TRUSTED_CANDIDATES[0], {
    conditions: mismatched,
    registrationNumber: 'PD20210001',
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'CARD_CONDITIONS_MISMATCH');
  assert.equal(decision.card, null, '拒绝时不得带出任何卡片');
  const outcome = gateDoseCards({ candidates: [INJECTED_TRUSTED_CANDIDATES[0]], conditions: mismatched, registrationNumber: 'PD20210001' });
  assertEmptyArray(outcome.dose_cards, '条件不一致时的 dose_cards');
});

test('反例·外层候选条件与**卡片**条件互相矛盾（外层≠载荷）⇒ 拒绝而非只信一侧', () => {
  // 卡片与请求都是 3-5叶期（一致），只有外层候选声明被改成"分蘖期" ⇒ 载荷与外层矛盾。
  const envelopeLies = variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], {
    conditions: { ...DOSE_CONDITIONS_SAMPLE, growth_stage: '分蘖期' },
  });
  const decision = decideDoseCard(envelopeLies, {
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'CONDITIONS_MISMATCH');
  const outcome = gateDoseCards({ candidates: [envelopeLies], conditions: { ...DOSE_CONDITIONS_SAMPLE }, registrationNumber: 'PD20210001' });
  assertEmptyArray(outcome.dose_cards, '外层与载荷矛盾时的 dose_cards');
});

test('反例·外层候选的制剂与**卡片**制剂互相矛盾 ⇒ 拒绝', () => {
  const envelopeLies = variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], {
    formulation_registration_number: 'PD20210002',
  });
  const decision = decideDoseCard(envelopeLies, {
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'FORMULATION_MISMATCH');
});

test('反例·制剂不匹配（用量卡不绑定本次命中的登记制剂）⇒ dose_cards 必为 []', () => {
  const decision = decideDoseCard(INJECTED_TRUSTED_CANDIDATES[0], {
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210002',
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'FORMULATION_MISMATCH');
  const outcome = gateDoseCards({
    candidates: [INJECTED_TRUSTED_CANDIDATES[0]],
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210002',
  });
  assertEmptyArray(outcome.dose_cards, '制剂不匹配时的 dose_cards');
});

test('反例·登记号为 null（未命中）⇒ dose_cards 必为 []', () => {
  const outcome = gateDoseCards({
    candidates: [INJECTED_TRUSTED_CANDIDATES[0]],
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: null,
  });
  assertEmptyArray(outcome.dose_cards, '登记号为 null 时的 dose_cards');
});

test('反例·卡片形状违规（content_hash 非 64 位十六进制）必被丢弃而非修补', () => {
  const malformed = variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], {
    card: { ...INJECTED_TRUSTED_CANDIDATES[0].card, content_hash: 'NOT-A-HASH' },
  });
  const decision = decideDoseCard(malformed, {
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'CARD_MALFORMED');
  const outcome = gateDoseCards({
    candidates: [malformed],
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assertEmptyArray(outcome.dose_cards, '形状违规时的 dose_cards');
});

// ---------------------------------------- 监工 5487924164 / 行内 4245800045 点名反例
// 判定对象必须是**实际要下发的那张卡**（card.*），不是外层候选。

test('反例①·请求与候选外层均为 rice，但 **card.conditions 任一项与请求不一致** ⇒ 必须拒绝且 0 张（六项逐项参数化）', () => {
  // 六项条件逐一替换成"**契约合法但与请求不同**"的值，每一项都必须被拦下（不是只查 crop_id）。
  const wrongValues = {
    crop_id: 'wheat',
    region_code: '330200', // 合法浙江编码（^33\d{4}$，但与请求的 330100 不同）
    species_id: 'species_other',
    growth_stage: '分蘖期',
    planting_method: '直播',
    use_scene: '旱地',
  };
  for (const field of Object.keys(wrongValues)) {
    const candidate = variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], {
      card: { ...INJECTED_TRUSTED_CANDIDATES[0].card, conditions: { ...DOSE_CONDITIONS_SAMPLE, [field]: wrongValues[field] } },
    });
    // 前提：外层候选与请求都是 rice 系列（即"外层看起来没问题"）。
    assert.deepEqual(candidate.conditions, DOSE_CONDITIONS_SAMPLE, `外层候选条件不应被改动（${field}）`);
    const decision = decideDoseCard(candidate, {
      conditions: { ...DOSE_CONDITIONS_SAMPLE },
      registrationNumber: 'PD20210001',
    });
    assert.equal(decision.usable, false, `card.conditions.${field} 与请求不一致时必须拒绝`);
    assert.equal(decision.reason, 'CARD_CONDITIONS_MISMATCH', `card.conditions.${field} 的归因`);
    assert.equal(decision.card, null);
    const outcome = gateDoseCards({
      candidates: [candidate],
      conditions: { ...DOSE_CONDITIONS_SAMPLE },
      registrationNumber: 'PD20210001',
    });
    assert.equal(outcome.dose_cards.length, 0, `card.conditions.${field} 时 gateDoseCards 必须返回 0 张`);
  }
  // 反面对照：只把请求侧条件改错（卡片不动）同样必须拒绝——两侧都不放过。
  const decision = decideDoseCard(INJECTED_TRUSTED_CANDIDATES[0], {
    conditions: { ...DOSE_CONDITIONS_SAMPLE, crop_id: 'wheat' },
    registrationNumber: 'PD20210001',
  });
  assert.equal(decision.usable, false);
});

test('反例②·**card.source** 为 withdrawn / rejected / simulation ⇒ 必须拒绝且 0 张（三值参数化）', () => {
  const variants = [
    { label: 'validity=withdrawn', source: { validity: 'withdrawn' }, reason: 'SOURCE_EXPIRED' },
    { label: 'review_status=rejected', source: { review_status: 'rejected' }, reason: 'SOURCE_UNVERIFIED' },
    { label: 'source_kind=simulation', source: { source_kind: 'simulation' }, reason: 'SOURCE_SIMULATED' },
  ];
  for (const variant of variants) {
    const candidate = variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], {
      card: { ...INJECTED_TRUSTED_CANDIDATES[0].card, source: { ...INJECTED_TRUSTED_CANDIDATES[0].card.source, ...variant.source } },
    });
    // 前提：外层候选来源全部标称可信（即"外层看起来没问题"）——这正是原实现只信外层的地方。
    assert.equal(candidate.source_kind, 'database', '外层候选来源应为标称可信');
    assert.equal(candidate.validity, 'valid', '外层候选有效期应为标称有效');
    assert.equal(candidate.review_status, 'verified', '外层候选审核状态应为标称已核对');
    const decision = decideDoseCard(candidate, {
      conditions: { ...DOSE_CONDITIONS_SAMPLE },
      registrationNumber: 'PD20210001',
    });
    assert.equal(decision.usable, false, `card.source ${variant.label} 时必须拒绝`);
    assert.equal(decision.reason, variant.reason, `card.source ${variant.label} 的归因`);
    assert.equal(decision.card, null);
    const outcome = gateDoseCards({
      candidates: [candidate],
      conditions: { ...DOSE_CONDITIONS_SAMPLE },
      registrationNumber: 'PD20210001',
    });
    assert.equal(outcome.dose_cards.length, 0, `card.source ${variant.label} 时 gateDoseCards 必须返回 0 张`);
    assert.equal(outcome.rejections[0]?.reason, variant.reason);
  }
});

test('反例·card.conditions 缺字段 / 不全 / 不合契约 ⇒ CARD_CONDITIONS_INVALID（读不到就不放行）', () => {
  const missingField = variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], {
    card: { ...INJECTED_TRUSTED_CANDIDATES[0].card, conditions: { crop_id: 'rice', region_code: '330100' } },
  });
  const decision = decideDoseCard(missingField, {
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'CARD_CONDITIONS_INVALID');
  const outcome = gateDoseCards({ candidates: [missingField], conditions: { ...DOSE_CONDITIONS_SAMPLE }, registrationNumber: 'PD20210001' });
  assert.equal(outcome.dose_cards.length, 0);

  // 卡片条件整体缺失（undefined）同样不放行，且不得抛错。
  const noConditions = variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], {
    card: { ...INJECTED_TRUSTED_CANDIDATES[0].card, conditions: undefined },
  });
  const none = decideDoseCard(noConditions, { conditions: { ...DOSE_CONDITIONS_SAMPLE }, registrationNumber: 'PD20210001' });
  assert.equal(none.usable, false);
  assert.equal(none.reason, 'CARD_CONDITIONS_INVALID');

  // 契约 pattern 违规（region_code 非 ^33[0-9]{4}$）算"不合契约"，也在这里被拦下。
  const badRegion = variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], {
    card: { ...INJECTED_TRUSTED_CANDIDATES[0].card, conditions: { ...DOSE_CONDITIONS_SAMPLE, region_code: '440100' } },
  });
  const bad = decideDoseCard(badRegion, { conditions: { ...DOSE_CONDITIONS_SAMPLE }, registrationNumber: 'PD20210001' });
  assert.equal(bad.usable, false);
  assert.equal(bad.reason, 'CARD_CONDITIONS_INVALID');
});

test('反例·card.source 缺字段 / 非法 url / 非 https ⇒ CARD_SOURCE_INVALID（读不到就不放行）', () => {
  const variants = [
    { label: 'source 缺失', source: undefined },
    { label: 'url 非 https', source: { url: 'http://example.invalid/x' } },
    { label: 'title 缺失', source: { title: '' } },
    { label: 'updated_at 非日期', source: { updated_at: 'not-a-date' } },
    { label: 'evidence_kind 非法', source: { evidence_kind: 'guess' } },
  ];
  for (const variant of variants) {
    const card = { ...INJECTED_TRUSTED_CANDIDATES[0].card };
    if (variant.source === undefined) card.source = undefined;
    else card.source = { ...INJECTED_TRUSTED_CANDIDATES[0].card.source, ...variant.source };
    const candidate = variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], { card });
    const decision = decideDoseCard(candidate, {
      conditions: { ...DOSE_CONDITIONS_SAMPLE },
      registrationNumber: 'PD20210001',
    });
    assert.equal(decision.usable, false, `${variant.label} 时必须拒绝`);
    assert.equal(decision.reason, 'CARD_SOURCE_INVALID', `${variant.label} 的归因`);
  }
});

test('反例·card 整块缺失 / 非对象 ⇒ CARD_MALFORMED，且 gate 不抛错', () => {
  for (const broken of [undefined, null, 'not-an-object', 42, []]) {
    const decision = decideDoseCard({ card: broken }, {
      conditions: { ...DOSE_CONDITIONS_SAMPLE },
      registrationNumber: 'PD20210001',
    });
    assert.equal(decision.usable, false, `card=${JSON.stringify(broken)} 时必须拒绝`);
    assert.equal(decision.reason, 'CARD_MALFORMED');
  }
  // 候选本身畸形 / 非对象，也不得抛错。
  for (const broken of [undefined, null, 'x', 42]) {
    const decision = decideDoseCard(broken, { conditions: { ...DOSE_CONDITIONS_SAMPLE }, registrationNumber: 'PD20210001' });
    assert.equal(decision.usable, false);
  }
});

test('反例·gate 入参 candidates 非数组 ⇒ 返回 0 张且不抛错（fail-closed）', () => {
  for (const broken of [undefined, null, 'nope', 42, { length: 1 }]) {
    const outcome = gateDoseCards({
      candidates: broken,
      conditions: { ...DOSE_CONDITIONS_SAMPLE },
      registrationNumber: 'PD20210001',
    });
    assertEmptyArray(outcome.dose_cards, `candidates=${JSON.stringify(broken)} 时的 dose_cards`);
    assertEmptyArray(outcome.rejections, `candidates=${JSON.stringify(broken)} 时的 rejections`);
  }
});

test('gate 下发的是**重新构造**的契约卡片，不是端口给的原始载荷对象', () => {
  const source = INJECTED_TRUSTED_CANDIDATES[0];
  const outcome = gateDoseCards({
    candidates: [source],
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assert.equal(outcome.dose_cards.length, 1);
  const emitted = outcome.dose_cards[0];
  assert.notEqual(emitted, source.card, '不得把端口给的载荷对象直接下发');
  // 来源被重建为契约 DoseSource（const 字段由 gate 依据校验结果写成）。
  assert.equal(emitted.source.source_kind, 'database');
  assert.equal(emitted.source.validity, 'valid');
  assert.equal(emitted.source.review_status, 'verified');
  assert.equal(emitted.conditions.crop_id, DOSE_CONDITIONS_SAMPLE.crop_id);
  // 条件对象也是新建的（不共享引用）。
  assert.notEqual(emitted.conditions, source.card.conditions);
});

test('反例·生产装配（替身 / 未接线）不产出任何候选 ⇒ dose_cards 为 []，绝不补造', () => {
  const outcome = gateDoseCards({
    candidates: [],
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assertEmptyArray(outcome.dose_cards, '无候选时的 dose_cards');
  assertEmptyArray(outcome.rejections, '无候选时的 rejections');
});

test('dose gate·候选超过契约上限 10 时最多输出 10 张', () => {
  const many = Array.from({ length: 14 }, (_, index) =>
    variantOfCandidate(INJECTED_TRUSTED_CANDIDATES[0], {
      card: { ...INJECTED_TRUSTED_CANDIDATES[0].card, id: `77777777-7777-4777-8777-777777777${String(index).padStart(3, '0')}` },
    }),
  );
  const outcome = gateDoseCards({
    candidates: many,
    conditions: { ...DOSE_CONDITIONS_SAMPLE },
    registrationNumber: 'PD20210001',
  });
  assert.equal(outcome.dose_cards.length, MAX_DOSE_CARDS);
  assert.equal(MAX_DOSE_CARDS, 10);
});

test('辅助函数·missingDoseConditionFields 对 null 返回全部 6 项，对不全条件返回缺项', () => {
  const all = missingDoseConditionFields(null);
  assert.equal(all.length, 6, `实际 ${JSON.stringify(all)}`);
  const partial = missingDoseConditionFields({ crop_id: 'rice', region_code: '330100' });
  assert.deepEqual([...partial].sort(), ['growth_stage', 'planting_method', 'species_id', 'use_scene']);
  assertEmptyArray(missingDoseConditionFields({ ...DOSE_CONDITIONS_SAMPLE }), '齐全条件的缺项');
  assert.equal(isDoseConditionsComplete({ ...DOSE_CONDITIONS_SAMPLE }), true);
  assert.equal(isDoseConditionsComplete({ crop_id: 'rice', region_code: '330100' }), false);
});

test('反例·登记库返回物不可解析 ⇒ 收敛为 unavailable（不得当 no_match，也不得抛错）', () => {
  const cases = [
    { label: '整体非对象', raw: 'not-an-object' },
    { label: 'status 未知', raw: { status: 'weird', candidates: [R1] } },
    { label: 'candidates 非数组', raw: { status: 'available', candidates: null } },
    { label: '候选非对象', raw: { status: 'available', candidates: ['nope'] } },
    { label: '候选缺 formulation', raw: { status: 'available', candidates: [{ id: '11111111-1111-4111-8111-111111111111', revision: 1 }] } },
    { label: '候选 registration_number 非字符串', raw: { status: 'available', candidates: [{ ...R1, formulation: { ...R1.formulation, registration_number: 42 } }] } },
    { label: '候选成分数组为空', raw: { status: 'available', candidates: [{ ...R1, formulation: { ...R1.formulation, ingredients: [] } }] } },
    { label: '候选来源 url 非 https', raw: { status: 'available', candidates: [{ ...R1, source: { ...R1.source, url: 'http://x.invalid' } }] } },
  ];
  for (const item of cases) {
    const sanitized = sanitizeRegistryLookup(item.raw);
    assert.equal(sanitized.status, 'unavailable', `${item.label} 应收敛为 unavailable`);
    assertString(sanitized.reason, `${item.label} 的 reason`);
    // 经判定链仍然是 unavailable，且不得退化成 no_match。
    const decision = decideMatchState(fields(), sanitized);
    assert.equal(decision.match_state, 'unavailable', `${item.label} 的 match_state`);
    assert.notEqual(decision.match_state, 'no_match');
    assert.equal(decision.registration, null);
  }

  // unavailable 原样透传（保留原因）。
  const passthrough = sanitizeRegistryLookup({ status: 'unavailable', reason: '登记库未接线' });
  assert.equal(passthrough.status, 'unavailable');
  assert.equal(passthrough.reason, '登记库未接线');
});

test('sanitizeRegistryLookup·合法载荷保持 available，且候选被**重新构造**（不共享引用）', () => {
  const sanitized = sanitizeRegistryLookup({ status: 'available', candidates: [R1] });
  assert.equal(sanitized.status, 'available');
  assert.equal(sanitized.candidates.length, 1);
  assert.notEqual(sanitized.candidates[0], R1, '不得把登记库给的候选对象直接下发');
  assert.deepEqual(sanitized.candidates[0], R1);
  // 空候选是合法的 no_match（不是 unavailable）。
  const empty = sanitizeRegistryLookup({ status: 'available', candidates: [] });
  assert.equal(empty.status, 'available');
  assert.equal(decideMatchState(fields(), empty).match_state, 'no_match');
});

test('反例·decideMatchState 收到畸形 lookup（候选非数组）⇒ unavailable，不得抛错', () => {
  const decision = decideMatchState(fields(), { status: 'available', candidates: null });
  assert.equal(decision.match_state, 'unavailable');
  assert.notEqual(decision.match_state, 'no_match');
});

// ---------------------------------------------------------------- 5. 归一化 fail-closed

test('normalizeLabelFields·缺字段（undefined）一律拒绝，不得静默当 null', () => {
  assert.throws(
    () => normalizeLabelFields({ name: null, ingredients: [], dosage_form: null }),
    (error) => error instanceof OcrProtocolError,
  );
});

test('反例·LabelFields 多余字段一律拒绝（additionalProperties:false）', () => {
  assert.throws(
    () => normalizeLabelFields({ ...fields(), extra: 1 }),
    (error) => error instanceof OcrProtocolError,
  );
});

test('反例·成分超过契约上限 20 条一律拒绝（不截断）', () => {
  const tooMany = Array.from({ length: 21 }, () => ({ name: '草甘膦', content_text: '41', unit_text: '%' }));
  assert.throws(() => normalizeIngredients(tooMany), (error) => error instanceof OcrProtocolError);
  assert.equal(normalizeIngredients(tooMany.slice(0, 20)).length, 20);
});

test('反例·region_code 不符合契约 ^33[0-9]{4}$ 一律拒绝', () => {
  assert.throws(() => normalizeConditions({ crop_id: 'rice', region_code: '440100' }), (error) => error instanceof OcrProtocolError);
  assert.throws(() => normalizeConditions({ crop_id: 'rice', region_code: '33010' }), (error) => error instanceof OcrProtocolError);
});

test('normalizeConditions·接受只有 crop_id + region_code 的合法但不全条件', () => {
  const parsed = normalizeConditions({ crop_id: 'rice', region_code: '330100' });
  assertString(parsed.crop_id, 'conditions.crop_id');
  assertString(parsed.region_code, 'conditions.region_code');
  assert.equal(parsed.species_id, undefined);
  assert.equal(missingDoseConditionFields(parsed).length, 4);
});

test('normalizeConditions·多余字段一律拒绝', () => {
  assert.throws(
    () => normalizeConditions({ crop_id: 'rice', region_code: '330100', weed: 'x' }),
    (error) => error instanceof OcrProtocolError,
  );
});
