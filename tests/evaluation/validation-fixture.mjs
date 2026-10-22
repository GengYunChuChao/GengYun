// 程序验证夹具（**非真实样本**）。
// 用途：仅为验证评估程序的**门禁拒绝逻辑**可重复运行而构造的内存输入，
//   覆盖第6节全部 bucket 的最小规模，全部 sourceKind=real_collected 仅用于触发/验证来源分支判定。
// 红线：本文件**不得**被当作真实评估样本，也不得产出任何真实结论；
//   它只用于断言"条件不满足时程序必须拒绝主张"。真实样本须由真实采集/标注另行交接。
import { createHash } from 'node:crypto';
import { computeRecordsSha256, computeCoverageSha256 } from '../../packages/evaluation/index.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

export const VALIDATION_CLASSES = ['CLS_A', 'CLS_B', 'CLS_C', 'CLS_D', 'CLS_E', 'CLS_F'];

function record(sampleId, task, extra = {}) {
  return {
    schemaVersion: '1.0.0',
    sampleId,
    task,
    split: 'test',
    clusterId: `cluster-${sampleId}`,
    contentSha256: sha(sampleId),
    rawMediaSha256: sha(`raw-${sampleId}`),
    sourceKind: 'real_collected',
    sourceRef: 'validation:program-only',
    labelClass: 'generic',
    coverage: 'covered',
    quality: 'clear',
    gold: {},
    annotation: { method: 'reliable_label', annotatorRef: 'validation-annotator', modelGenerated: false },
    rawMediaCommitted: false,
    ...extra,
  };
}

/**
 * 构造覆盖第6节全部 bucket 的程序验证输入（1500 条，全 split=test，唯一簇/唯一内容）。
 * 返回 { records, predictions }；predictions 为 sampleId -> 原始模型输出的普通对象。
 */
export function buildValidationSet({ classes = VALIDATION_CLASSES } = {}) {
  const records = [];
  const predictions = {};
  const push = (r, p) => {
    records.push(r);
    predictions[r.sampleId] = p;
  };

  // 覆盖内拍草：每承诺类 50 → 300（逐类 ≥30）
  for (const cls of classes) {
    for (let i = 0; i < 50; i += 1) {
      const id = `val-weed-cov-${cls}-${i}`;
      push(record(id, 'weed_photo', { labelClass: cls, gold: { speciesId: cls } }), { candidates: [{ speciesId: cls, confidence: 0.9 }], decision: 'candidate' });
    }
  }
  // 覆盖外 100：拒识（不显示高置信候选）
  for (let i = 0; i < 100; i += 1) {
    const id = `val-weed-ooc-${i}`;
    push(record(id, 'weed_photo', { labelClass: 'out_of_coverage_object', coverage: 'out_of_coverage', gold: { speciesId: null, expected: 'not_supported' } }), {
      candidates: [],
      decision: 'uncertain',
    });
  }
  // 低质量 100：不确定/重拍
  for (let i = 0; i < 100; i += 1) {
    const id = `val-weed-low-${i}`;
    push(record(id, 'weed_photo', { labelClass: classes[0], quality: 'blurry', gold: { speciesId: classes[0] } }), { candidates: [], decision: 'uncertain' });
  }
  // 标签 OCR 清晰 200（20 个独立登记号）
  for (let i = 0; i < 200; i += 1) {
    const reg = `REG-${String(i % 20).padStart(4, '0')}`;
    const gold = { registrationNumber: reg, name: `名称${i}`, ingredient: '成分', content: '10%', dosageForm: '悬浮剂' };
    push(record(`val-ocr-clear-${i}`, 'label_ocr', { labelClass: reg, gold }), { fields: { ...gold }, corrected: false });
  }
  // 标签 OCR 低质量 100
  for (let i = 0; i < 100; i += 1) {
    push(record(`val-ocr-low-${i}`, 'label_ocr', { labelClass: 'REG-0000', quality: 'blurry', gold: { registrationNumber: 'REG-0000' } }), { fields: {}, corrected: false });
  }
  // 登记匹配 100
  const scenarios = ['legal_no_record', 'same_name_diff_formulation', 'wrong_number', 'field_conflict'];
  for (let i = 0; i < 100; i += 1) {
    const sc = scenarios[i % scenarios.length];
    const expected = i % scenarios.length === 3 ? 'conflict' : 'no_match';
    push(record(`val-match-${i}`, 'registration_match', { labelClass: sc, gold: { expectedStatus: expected } }), { status: expected });
  }
  // AI 风险 200 → blocked（规则层事实：禁用硬规则命中 ⇒ hard_rule_passed=false）
  for (let i = 0; i < 200; i += 1) {
    push(record(`val-mod-risk-${i}`, 'ai_moderation', { labelClass: i % 2 ? 'injection' : 'dangerous', expectation: 'risk', gold: { decision: 'blocked' } }), { decision: 'blocked', hard_rule_passed: false });
  }
  // AI 正常 200 → published（规则层事实：全部规则求值且未命中 ⇒ hard_rule_passed=true）
  for (let i = 0; i < 200; i += 1) {
    push(record(`val-mod-normal-${i}`, 'ai_moderation', { labelClass: 'normal', expectation: 'normal', gold: { decision: 'published' } }), { decision: 'published', hard_rule_passed: true });
  }
  // TTS 30
  for (let i = 0; i < 30; i += 1) {
    push(record(`val-tts-${i}`, 'tts', { labelClass: `tts_${i}`, gold: { numbers: true, units: true, negation: true, conditions: true } }), {
      numbersCorrect: true,
      unitsCorrect: true,
      negationCorrect: true,
      conditionsCorrect: true,
      stopReplayCorrect: true,
      textFallbackCorrect: true,
    });
  }
  // ASR 50（10 名说话者）
  for (let i = 0; i < 50; i += 1) {
    const spk = `speaker-${String(i % 10).padStart(2, '0')}`;
    const ref = '草甘膦每亩用量一百毫升';
    push(record(`val-asr-${i}`, 'asr', { labelClass: i % 2 ? 'quiet' : 'noisy', sourceRef: `validation:${spk}`, gold: { reference: ref, keyFields: { drugNames: ['草甘膦'], numbers: ['一百'], units: ['毫升'] } } }), {
      hypothesis: ref,
      keyFieldsExact: { drugNames: true, numbers: true, units: true },
    });
  }
  // 问答 60 可答 + 20 不足 + 20 危险 + 20 注入
  for (let i = 0; i < 60; i += 1) {
    push(record(`val-qa-answerable-${i}`, 'qa', { labelClass: 'answerable', expectation: 'answerable', gold: { citationRefs: ['SRC-1'] } }), { correct: true, sourceSupported: true });
  }
  for (const [kind, n] of [['insufficient', 20], ['dangerous', 20], ['injection', 20]]) {
    for (let i = 0; i < n; i += 1) {
      push(record(`val-qa-${kind}-${i}`, 'qa', { labelClass: kind, expectation: kind, gold: {} }), { expectedBehaviorOk: true });
    }
  }

  return { records, predictions, classes };
}

/** 由记录（默认 test 划分）构造匹配的冻结清单；可覆盖字段用于负例。
 *  修复轮 2：冻结清单内嵌承诺覆盖清单绑定块（coverage.weedPhotoCoveredClasses + coverageSha256 + basisRef），
 *  使覆盖口径与冻结版本绑定；可用 overrides.coverage.weedPhotoCoveredClasses 产出新的冻结版本。 */
export function frozenManifestFor(records, overrides = {}) {
  const testRecords = records.filter((r) => r.split === 'test');
  const coveredClasses = overrides.coverage?.weedPhotoCoveredClasses ?? VALIDATION_CLASSES;
  const basisRef = overrides.coverage?.basisRef ?? 'GY-I03#species_groups';
  const coverageBlock = {
    weedPhotoCoveredClasses: [...coveredClasses],
    coverageSha256: computeCoverageSha256({ weedPhotoCoveredClasses: coveredClasses }),
    basisRef,
  };
  const { coverage: _coverage, ...rest } = overrides;
  return {
    manifestVersion: '1.0.0',
    indexVersion: 'validation-v1',
    split: 'test',
    recordCount: testRecords.length,
    indexSha256: computeRecordsSha256(testRecords),
    frozenAt: '2026-10-04T00:00:00Z',
    coverage: coverageBlock,
    ...rest,
  };
}

export const coverageManifestFor = (classes = VALIDATION_CLASSES) => ({ weedPhotoCoveredClasses: [...classes] });
