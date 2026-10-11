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
 * 断言一律**先判 typeof / Array.isArray 再判值**，避免 `undefined === undefined` 式的假通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
  OcrProtocolError,
} from '../../services/api/src/ocr/state.ts';
import {
  SUBSTITUTE_REGISTRY,
  SUBSTITUTE_DOSE_CANDIDATES,
  SUBSTITUTE_DOSE_CONDITIONS,
  cloneDoseCandidate,
} from '../../services/api/src/ocr/reference.ts';

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

test('dose gate 正向·条件齐全 + 绑定同一登记制剂 + 来源可信 ⇒ 放行 1 张', () => {
  const candidate = SUBSTITUTE_DOSE_CANDIDATES[0];
  const outcome = gateDoseCards({
    candidates: [candidate],
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
    registrationNumber: 'PD20210001',
  });
  assertArray(outcome.dose_cards, 'dose_cards');
  assert.equal(outcome.dose_cards.length, 1);
  assertString(outcome.dose_cards[0].original_text, 'dose_card.original_text');
  assert.equal(outcome.rejections.length, 0);
});

test('反例·conditions 缺失 ⇒ dose_cards 必为 []（且原因可指出）', () => {
  const decision = decideDoseCard(SUBSTITUTE_DOSE_CANDIDATES[0], { conditions: null, registrationNumber: 'PD20210001' });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'CONDITIONS_ABSENT');
  const outcome = gateDoseCards({ candidates: [SUBSTITUTE_DOSE_CANDIDATES[0]], conditions: null, registrationNumber: 'PD20210001' });
  assertEmptyArray(outcome.dose_cards, 'conditions 缺失时的 dose_cards');
});

test('反例·conditions 不全（只给 crop_id + region_code）⇒ dose_cards 必为 []', () => {
  const partial = { crop_id: 'rice', region_code: '330100' };
  const decision = decideDoseCard(SUBSTITUTE_DOSE_CANDIDATES[0], { conditions: partial, registrationNumber: 'PD20210001' });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'CONDITIONS_INCOMPLETE');
  const outcome = gateDoseCards({ candidates: [SUBSTITUTE_DOSE_CANDIDATES[0]], conditions: partial, registrationNumber: 'PD20210001' });
  assertEmptyArray(outcome.dose_cards, 'conditions 不全时的 dose_cards');
});

test('反例·只凭来源"可用"标记不得放行：模拟来源必被 gate 丢弃', () => {
  const simulated = cloneDoseCandidate(SUBSTITUTE_DOSE_CANDIDATES[0], { simulated: true });
  const decision = decideDoseCard(simulated, {
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
    registrationNumber: 'PD20210001',
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'SOURCE_SIMULATED');
  const outcome = gateDoseCards({
    candidates: [simulated],
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
    registrationNumber: 'PD20210001',
  });
  assertEmptyArray(outcome.dose_cards, '模拟来源时的 dose_cards');
});

test('反例·source_kind=simulation ⇒ dose_cards 必为 []', () => {
  const simulated = cloneDoseCandidate(SUBSTITUTE_DOSE_CANDIDATES[0], { source_kind: 'simulation', simulated: false });
  const outcome = gateDoseCards({
    candidates: [simulated],
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
    registrationNumber: 'PD20210001',
  });
  assertEmptyArray(outcome.dose_cards, 'simulation 来源时的 dose_cards');
  assert.equal(outcome.rejections[0]?.reason, 'SOURCE_SIMULATED');
});

test('反例·来源过期 ⇒ dose_cards 必为 []', () => {
  const expired = cloneDoseCandidate(SUBSTITUTE_DOSE_CANDIDATES[0], { validity: 'expired' });
  const decision = decideDoseCard(expired, {
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
    registrationNumber: 'PD20210001',
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'SOURCE_EXPIRED');
  const outcome = gateDoseCards({
    candidates: [expired],
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
    registrationNumber: 'PD20210001',
  });
  assertEmptyArray(outcome.dose_cards, '过期来源时的 dose_cards');
});

test('反例·来源未核对 ⇒ dose_cards 必为 []', () => {
  const unverified = cloneDoseCandidate(SUBSTITUTE_DOSE_CANDIDATES[0], { review_status: 'unverified' });
  const outcome = gateDoseCards({
    candidates: [unverified],
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
    registrationNumber: 'PD20210001',
  });
  assertEmptyArray(outcome.dose_cards, '未核对来源时的 dose_cards');
  assert.equal(outcome.rejections[0]?.reason, 'SOURCE_UNVERIFIED');
});

test('反例·条件与卡片绑定的六项条件不一致 ⇒ dose_cards 必为 []', () => {
  const mismatched = { ...SUBSTITUTE_DOSE_CONDITIONS, growth_stage: '分蘖期' };
  const decision = decideDoseCard(SUBSTITUTE_DOSE_CANDIDATES[0], {
    conditions: mismatched,
    registrationNumber: 'PD20210001',
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'CONDITIONS_MISMATCH');
  const outcome = gateDoseCards({ candidates: [SUBSTITUTE_DOSE_CANDIDATES[0]], conditions: mismatched, registrationNumber: 'PD20210001' });
  assertEmptyArray(outcome.dose_cards, '条件不一致时的 dose_cards');
});

test('反例·制剂不匹配（用量卡不绑定本次命中的登记制剂）⇒ dose_cards 必为 []', () => {
  const decision = decideDoseCard(SUBSTITUTE_DOSE_CANDIDATES[0], {
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
    registrationNumber: 'PD20210002',
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'FORMULATION_MISMATCH');
  const outcome = gateDoseCards({
    candidates: [SUBSTITUTE_DOSE_CANDIDATES[0]],
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
    registrationNumber: 'PD20210002',
  });
  assertEmptyArray(outcome.dose_cards, '制剂不匹配时的 dose_cards');
});

test('反例·登记号为 null（未命中）⇒ dose_cards 必为 []', () => {
  const outcome = gateDoseCards({
    candidates: [SUBSTITUTE_DOSE_CANDIDATES[0]],
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
    registrationNumber: null,
  });
  assertEmptyArray(outcome.dose_cards, '登记号为 null 时的 dose_cards');
});

test('反例·卡片形状违规（content_hash 非 64 位十六进制）必被丢弃而非修补', () => {
  const malformed = cloneDoseCandidate(SUBSTITUTE_DOSE_CANDIDATES[0], {
    card: { ...SUBSTITUTE_DOSE_CANDIDATES[0].card, content_hash: 'NOT-A-HASH' },
  });
  const decision = decideDoseCard(malformed, {
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
    registrationNumber: 'PD20210001',
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.reason, 'CARD_MALFORMED');
  const outcome = gateDoseCards({
    candidates: [malformed],
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
    registrationNumber: 'PD20210001',
  });
  assertEmptyArray(outcome.dose_cards, '形状违规时的 dose_cards');
});

test('反例·候选为空（real 未接线语义）⇒ dose_cards 为 []，绝不补造', () => {
  const outcome = gateDoseCards({
    candidates: [],
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
    registrationNumber: 'PD20210001',
  });
  assertEmptyArray(outcome.dose_cards, '无候选时的 dose_cards');
  assertEmptyArray(outcome.rejections, '无候选时的 rejections');
});

test('dose gate·候选超过契约上限 10 时最多输出 10 张', () => {
  const many = Array.from({ length: 14 }, (_, index) =>
    cloneDoseCandidate(SUBSTITUTE_DOSE_CANDIDATES[0], {
      card: { ...SUBSTITUTE_DOSE_CANDIDATES[0].card, id: `77777777-7777-4777-8777-777777777${String(index).padStart(3, '0')}` },
    }),
  );
  const outcome = gateDoseCards({
    candidates: many,
    conditions: { ...SUBSTITUTE_DOSE_CONDITIONS },
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
  assertEmptyArray(missingDoseConditionFields({ ...SUBSTITUTE_DOSE_CONDITIONS }), '齐全条件的缺项');
  assert.equal(isDoseConditionsComplete({ ...SUBSTITUTE_DOSE_CONDITIONS }), true);
  assert.equal(isDoseConditionsComplete({ crop_id: 'rice', region_code: '330100' }), false);
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
