/**
 * GY-I10（#10）· 用户校正台账与准确率口径的**域级**回归。
 *
 * 这里只测纯函数（无 store、无服务）：校正台账的 append-only 语义、不可覆盖原文、
 * 「谁改的 / 改了什么」逐字段 diff、以及「人工改写不计入 OCR 准确率」的口径断言。
 *
 * 每个断言都写成「改坏一行必红」的形状：
 *   - 篡改 entry.raw_fields ⇒ `assertRawPreserved` 必须抛错（负控制见同名 test 的后半段）；
 *   - 把人工改写行塞回分母 ⇒ `assertAccuracySample` 必须抛错；
 *   - 已阻断状态却带出用量卡 ⇒ `assertDoseNotProduced` 必须抛错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CORRECTION_LEDGER_VERSION,
  CorrectionLedgerError,
  MAX_CORRECTION_ENTRIES,
  appendCorrection,
  assertAccuracySample,
  assertDoseNotProduced,
  assertRawPreserved,
  deriveOcrVerdict,
  diffLabelFields,
  isHumanEdited,
  ocrAccuracyDenominator,
  parseCorrectionLedger,
  summarizeCorrections,
} from '../../services/api/src/ocr/state.ts';

const RAW = {
  registration_number: 'PD20210001',
  name: '替身示例草甘膦水剂',
  ingredients: [{ name: '草甘膦', content_text: '41', unit_text: '%' }],
  dosage_form: '水剂',
};

const AT = new Date('2026-05-01T02:03:04.000Z');
const USER = 'user-actor-0001';

test('校正台账·第一版：版本号从 1 开始，记录 actor / 时间 / 逐字段 diff / 原文快照', () => {
  const ledger = appendCorrection(undefined, {
    actorUserId: USER,
    at: AT,
    revision: 2,
    before: RAW,
    after: { ...RAW, dosage_form: '乳油' },
    raw: RAW,
  });
  assert.equal(ledger.version, CORRECTION_LEDGER_VERSION);
  assert.equal(ledger.entries.length, 1);
  const entry = ledger.entries[0];
  assert.equal(entry.version, 1);
  assert.equal(entry.revision, 2);
  assert.equal(entry.actor_user_id, USER);
  assert.equal(entry.corrected_at, AT.toISOString());
  assert.deepEqual(entry.changes, [{ field: 'dosage_form', before: '水剂', after: '乳油' }]);
  assert.deepEqual(entry.raw_fields, RAW);
  assert.deepEqual(entry.corrected_fields, { ...RAW, dosage_form: '乳油' });
});

test('校正台账·第二版只追加、不改写第一版（append-only 与版本单调）', () => {
  const first = appendCorrection(undefined, {
    actorUserId: USER,
    at: AT,
    revision: 2,
    before: RAW,
    after: { ...RAW, dosage_form: '乳油' },
    raw: RAW,
  });
  const firstSnapshot = JSON.stringify(first);
  const second = appendCorrection(first, {
    actorUserId: 'user-actor-0002',
    at: new Date('2026-05-02T00:00:00.000Z'),
    revision: 3,
    before: { ...RAW, dosage_form: '乳油' },
    after: { ...RAW, dosage_form: '微乳剂' },
    raw: RAW,
  });
  assert.equal(second.entries.length, 2);
  assert.deepEqual(second.entries[0], first.entries[0], '第二版不得改写第一版');
  assert.equal(second.entries[1].version, 2);
  assert.equal(second.entries[1].actor_user_id, 'user-actor-0002');
  assert.deepEqual(second.entries[1].changes, [{ field: 'dosage_form', before: '乳油', after: '微乳剂' }]);
  assert.equal(JSON.stringify(first), firstSnapshot, 'appendCorrection 不得就地修改入参台账');
});

test('校正台账·成分顺序变化不算改写；改含量/改单位/增删成分都算', () => {
  const a = { ...RAW, ingredients: [
    { name: '草甘膦', content_text: '41', unit_text: '%' },
    { name: '助剂', content_text: '5', unit_text: '%' },
  ] };
  const reordered = { ...a, ingredients: [a.ingredients[1], a.ingredients[0]] };
  assert.deepEqual(diffLabelFields(a, reordered), [], '纯顺序变化不产生 diff');
  assert.deepEqual(diffLabelFields(a, { ...a, ingredients: [a.ingredients[0]] }).map((c) => c.field), ['ingredients']);
  const changed = { ...a, ingredients: [{ ...a.ingredients[0], content_text: '30' }] };
  const diff = diffLabelFields(a, changed);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].field, 'ingredients');
  assert.match(String(diff[0].before), /草甘膦\|41\|%/);
  assert.match(String(diff[0].after), /草甘膦\|30\|%/);
});

test('校正台账·空 diff 不允许产生版本（那是重提，不是改写）', () => {
  assert.throws(
    () => appendCorrection(undefined, { actorUserId: USER, at: AT, revision: 2, before: RAW, after: RAW, raw: RAW }),
    CorrectionLedgerError,
  );
});

test('校正台账·次数上限是硬拒绝（不静默截断历史）', () => {
  let ledger;
  for (let index = 1; index <= MAX_CORRECTION_ENTRIES; index += 1) {
    ledger = appendCorrection(ledger, {
      actorUserId: USER,
      at: AT,
      revision: index + 1,
      before: { ...RAW, name: `n-${index - 1}` },
      after: { ...RAW, name: `n-${index}` },
      raw: RAW,
    });
  }
  assert.equal(ledger.entries.length, MAX_CORRECTION_ENTRIES);
  assert.throws(
    () => appendCorrection(ledger, {
      actorUserId: USER,
      at: AT,
      revision: MAX_CORRECTION_ENTRIES + 2,
      before: { ...RAW, name: 'x' },
      after: { ...RAW, name: 'y' },
      raw: RAW,
    }),
    /最多 \d+ 次校正/,
  );
});

test('校正台账·原文不可覆盖（篡改 raw_fields 必被 assertRawPreserved 抓住）', () => {
  const ledger = appendCorrection(undefined, {
    actorUserId: USER,
    at: AT,
    revision: 2,
    before: RAW,
    after: { ...RAW, name: '用户手改名' },
    raw: RAW,
  });
  assert.doesNotThrow(() => assertRawPreserved(ledger, RAW));
  const tampered = {
    ...ledger,
    entries: [{ ...ledger.entries[0], raw_fields: { ...RAW, name: '用户手改名' } }],
  };
  assert.throws(() => assertRawPreserved(tampered, RAW), /原文被覆盖/);
});

test('校正台账·jsonb 往返：形状合法才读回，非法一律抛错（不「尽力解析」半个台账）', () => {
  const ledger = appendCorrection(undefined, {
    actorUserId: USER,
    at: AT,
    revision: 2,
    before: RAW,
    after: { ...RAW, dosage_form: '乳油' },
    raw: RAW,
  });
  const roundTrip = parseCorrectionLedger(JSON.parse(JSON.stringify(ledger)));
  assert.deepEqual(roundTrip, ledger);
  assert.equal(parseCorrectionLedger(undefined), undefined, '老记录没有台账是合法状态');
  assert.throws(() => parseCorrectionLedger({ version: 'other/9', entries: [] }), CorrectionLedgerError);
  assert.throws(() => parseCorrectionLedger({ version: CORRECTION_LEDGER_VERSION, entries: 'nope' }), CorrectionLedgerError);
  assert.throws(
    () => parseCorrectionLedger({ version: CORRECTION_LEDGER_VERSION, entries: [{ ...ledger.entries[0], version: 2 }] }),
    /版本号不连续/,
  );
  assert.throws(
    () => parseCorrectionLedger({ version: CORRECTION_LEDGER_VERSION, entries: [{ ...ledger.entries[0], changes: [] }] }),
    /changes 非法/,
  );
});

test('校正台账·摘要只给计数与最后时间（不泄露 PII）', () => {
  const ledger = appendCorrection(undefined, {
    actorUserId: USER,
    at: AT,
    revision: 2,
    before: RAW,
    after: { ...RAW, name: 'x' },
    raw: RAW,
  });
  assert.deepEqual(summarizeCorrections(ledger), {
    version: CORRECTION_LEDGER_VERSION,
    count: 1,
    last_corrected_at: AT.toISOString(),
  });
  assert.deepEqual(summarizeCorrections(undefined), { version: null, count: 0, last_corrected_at: null });
});

test('准确率口径·人工改写行被剔除并单列（分母不含手改样本）', () => {
  const untouched = { id: 'ocr-a', rawFields: RAW, correctedFields: RAW };
  const edited = { id: 'ocr-b', rawFields: RAW, correctedFields: { ...RAW, name: '用户手改名' } };
  assert.equal(isHumanEdited(untouched), false);
  assert.equal(isHumanEdited(edited), true);
  const sample = ocrAccuracyDenominator([untouched, edited]);
  assert.equal(sample.rows, 2);
  assert.equal(sample.human_edited_rows, 1);
  assert.equal(sample.denominator, 1);
  assert.deepEqual(sample.included, ['ocr-a']);
  assert.deepEqual(sample.excluded, ['ocr-b']);
});

test('准确率口径·负控制：把人工改写行塞回分母 ⇒ 口径断言必红', () => {
  assert.throws(
    () => assertAccuracySample({
      rows: 2,
      human_edited_rows: 1,
      denominator: 2,
      included: ['ocr-a', 'ocr-b'],
      excluded: ['ocr-b'],
    }),
    /人工改写样本混入准确率分母/,
  );
  assert.throws(
    () => assertAccuracySample({ rows: 2, human_edited_rows: 1, denominator: 2, included: ['ocr-a'], excluded: ['ocr-b'] }),
    /分母与纳入行数不一致/,
  );
});

test('四类状态码·无匹配 / 多结果 / 冲突 / 已失效 各自收敛到稳定码，且都阻断用量', () => {
  const cases = [
    { match_state: 'no_match', conflict_fields: [], code: 'REGISTRATION_NOT_FOUND' },
    { match_state: 'ambiguous', conflict_fields: [], code: 'REGISTRATION_AMBIGUOUS' },
    { match_state: 'conflict', conflict_fields: ['dosage_form'], code: 'REGISTRATION_CONFLICT' },
    { match_state: 'conflict', conflict_fields: ['source.validity'], code: 'REGISTRATION_EXPIRED' },
    { match_state: 'conflict', conflict_fields: ['source.validity', 'dosage_form'], code: 'REGISTRATION_EXPIRED' },
    { match_state: 'insufficient', conflict_fields: [], code: 'LABEL_FIELDS_INSUFFICIENT' },
    { match_state: 'unavailable', conflict_fields: [], code: 'REGISTRY_UNAVAILABLE' },
    { match_state: 'matched', conflict_fields: [], code: 'REGISTRATION_MATCHED' },
  ];
  for (const item of cases) {
    const verdict = deriveOcrVerdict({ match_state: item.match_state, conflict_fields: item.conflict_fields });
    assert.equal(verdict.code, item.code, `${item.match_state} → ${item.code}`);
    assert.equal(verdict.dose_blocked, item.match_state !== 'matched', `${item.code} 的阻断面`);
    assert.equal(verdict.block_reason === null, item.match_state === 'matched');
  }
});

test('四类状态码·负控制：已阻断状态带出用量卡 ⇒ assertDoseNotProduced 必抛错', () => {
  const conflict = deriveOcrVerdict({ match_state: 'conflict', conflict_fields: ['dosage_form'] });
  assert.doesNotThrow(() => assertDoseNotProduced(conflict, []));
  assert.throws(() => assertDoseNotProduced(conflict, [{ id: 'card' }]), /违反用量阻断/);
  const matched = deriveOcrVerdict({ match_state: 'matched', conflict_fields: [] });
  assert.doesNotThrow(() => assertDoseNotProduced(matched, [{ id: 'card' }]));
});
