#!/usr/bin/env node
// 生成"合成占位输入"，仅用于验证评估程序本身可运行。
// 严禁把本文件产物当作真实评估样本：所有记录 sourceKind=synthetic_placeholder，
// 且报告会强制 isRealEvaluation=false、全部门禁 not_evaluated。真实样本须由真实采集/标注另行交接。
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const SOURCE = 'synthetic:generated:for-program-validation-only';

function sample(sampleId, task, extra) {
  const hash = sha256(sampleId);
  return {
    schemaVersion: '1.0.0',
    sampleId,
    task,
    split: 'test',
    clusterId: `cluster-${sampleId}`,
    contentSha256: hash,
    rawMediaSha256: hash,
    sourceKind: 'synthetic_placeholder',
    sourceRef: SOURCE,
    coverage: 'covered',
    quality: 'clear',
    gold: {},
    annotation: { method: 'synthetic_placeholder', annotatorRef: 'synthetic-fixture-generator', modelGenerated: false },
    rawMediaCommitted: false,
    ...extra,
  };
}

export function buildSyntheticFixture() {
  const records = [];
  const predictions = {};

  // 拍草：覆盖内清晰 8（A:4,B:4），其中 2 张 Top1 判错但 Top3 命中。
  const species = ['SYN_SPECIES_A', 'SYN_SPECIES_B'];
  for (let i = 0; i < 8; i += 1) {
    const gold = species[i % 2];
    const id = `syn-weed-covered-${i}`;
    records.push(sample(id, 'weed_photo', { labelClass: gold, gold: { speciesId: gold } }));
    const wrong = i === 2 || i === 5;
    const other = species[(species.indexOf(gold) + 1) % 2];
    predictions[id] = {
      candidates: wrong ? [{ speciesId: other, confidence: 0.6 }, { speciesId: gold, confidence: 0.3 }] : [{ speciesId: gold, confidence: 0.9 }],
      decision: 'candidate',
    };
  }
  // 拍草：覆盖外 4（1 个误给高置信候选，3 个不确定）
  for (let i = 0; i < 4; i += 1) {
    const id = `syn-weed-ooc-${i}`;
    records.push(sample(id, 'weed_photo', { labelClass: 'uncovered_object', coverage: 'out_of_coverage', gold: { speciesId: null, expected: 'not_supported' } }));
    predictions[id] = i === 0 ? { candidates: [{ speciesId: 'SYN_SPECIES_A', confidence: 0.8 }], decision: 'candidate' } : { candidates: [], decision: 'uncertain' };
  }
  // 拍草：低质量 4（3 个不确定，1 个给候选）
  for (let i = 0; i < 4; i += 1) {
    const id = `syn-weed-low-${i}`;
    records.push(sample(id, 'weed_photo', { labelClass: 'SYN_SPECIES_A', quality: i % 2 === 0 ? 'blurry' : 'dark', gold: { speciesId: 'SYN_SPECIES_A', expected: 'uncertain' } }));
    predictions[id] = i < 3 ? { candidates: [], decision: 'uncertain' } : { candidates: [{ speciesId: 'SYN_SPECIES_A', confidence: 0.4 }], decision: 'candidate' };
  }

  // 标签 OCR：清晰 4（2 个登记号记录），content 字段 1 个错误。
  const regs = ['SYN-REG-0001', 'SYN-REG-0002'];
  for (let i = 0; i < 4; i += 1) {
    const reg = regs[i % 2];
    const id = `syn-ocr-clear-${i}`;
    const gold = { registrationNumber: reg, name: `示例名称${i}`, ingredient: '示例成分', content: '10%', dosageForm: '悬浮剂' };
    records.push(sample(id, 'label_ocr', { labelClass: reg, gold }));
    predictions[id] = { fields: { ...gold, content: i === 1 ? '8%' : gold.content }, corrected: false };
  }
  // 标签 OCR：低质量 2
  for (let i = 0; i < 2; i += 1) {
    const id = `syn-ocr-low-${i}`;
    records.push(sample(id, 'label_ocr', { labelClass: regs[0], quality: 'blurry', gold: { registrationNumber: regs[0] } }));
    predictions[id] = { fields: {}, corrected: false };
  }

  // 登记匹配：4 场景，3 通过 1 失败。
  const scenarios = ['legal_no_record', 'same_name_diff_formulation', 'wrong_number', 'field_conflict'];
  scenarios.forEach((scenario, i) => {
    const id = `syn-match-${i}`;
    const expected = i === 3 ? 'conflict' : 'no_match';
    records.push(sample(id, 'registration_match', { labelClass: scenario, gold: { expectedStatus: expected } }));
    predictions[id] = { status: i === 1 ? 'match' : expected };
  });

  // AI 筛查：4 风险（3 拦截）+ 4 正常（1 误隔离）。
  for (let i = 0; i < 4; i += 1) {
    const id = `syn-mod-risk-${i}`;
    records.push(sample(id, 'ai_moderation', { labelClass: i % 2 === 0 ? 'dangerous' : 'injection', expectation: 'risk', gold: { decision: 'blocked' } }));
    predictions[id] = { decision: i < 3 ? 'blocked' : 'published' };
  }
  for (let i = 0; i < 4; i += 1) {
    const id = `syn-mod-normal-${i}`;
    records.push(sample(id, 'ai_moderation', { labelClass: 'normal', expectation: 'normal', gold: { decision: 'published' } }));
    predictions[id] = { decision: i === 0 ? 'pending_review' : 'published' };
  }

  // TTS：4 段，1 段数字单位错误。
  for (let i = 0; i < 4; i += 1) {
    const id = `syn-tts-${i}`;
    records.push(sample(id, 'tts', { labelClass: `tts_case_${i}`, gold: { numbers: true, units: true, negation: true, conditions: true } }));
    predictions[id] = { numbersCorrect: i !== 2, unitsCorrect: true, negationCorrect: true, conditionsCorrect: true, stopReplayCorrect: true, textFallbackCorrect: true };
  }

  // ASR：4 段，2 名说话者。注入少量字符错误。
  const asrCases = [
    { ref: '草甘膦每亩用量一百毫升', hyp: '草甘膦每亩用量一百毫升', speakers: 'speaker-01', ok: true },
    { ref: '间隔七天再施药', hyp: '间隔七天在施药', speakers: 'speaker-01', ok: false },
    { ref: '每亩使用五十克', hyp: '每亩使用五十克', speakers: 'speaker-02', ok: true },
    { ref: '不要在高温时喷施', hyp: '不要在高温时喷施', speakers: 'speaker-02', ok: true },
  ];
  asrCases.forEach((c, i) => {
    const id = `syn-asr-${i}`;
    records.push(sample(id, 'asr', {
      labelClass: i < 2 ? 'quiet' : 'noisy',
      sourceRef: `synthetic:${c.speakers}`,
      gold: { reference: c.ref, keyFields: { drugNames: ['草甘膦'], numbers: ['一百'], units: ['毫升'] } },
    }));
    predictions[id] = { hypothesis: c.hyp, keyFieldsExact: { drugNames: c.ok, numbers: c.ok, units: c.ok } };
  });

  // 问答：可答 4（3 通过）+ 不足 2 + 危险 1 + 注入 1（预期行为均通过）。
  for (let i = 0; i < 4; i += 1) {
    const id = `syn-qa-answer-${i}`;
    records.push(sample(id, 'qa', { labelClass: 'answerable', expectation: 'answerable', gold: { citationRefs: ['SYN-SRC-1'] } }));
    predictions[id] = { status: 'answered', correct: i !== 1, sourceSupported: i !== 1 };
  }
  const qaOther = [['insufficient', 2], ['dangerous', 1], ['injection', 1]];
  for (const [kind, n] of qaOther) {
    for (let i = 0; i < n; i += 1) {
      const id = `syn-qa-${kind}-${i}`;
      records.push(sample(id, 'qa', { labelClass: kind, expectation: kind, gold: {} }));
      predictions[id] = { status: kind === 'insufficient' ? 'insufficient' : 'blocked', expectedBehaviorOk: true };
    }
  }

  return { records, predictions };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out ?? join(HERE, '..', '..', 'tests', 'evaluation', 'fixtures'));
  const { records, predictions } = buildSyntheticFixture();
  mkdirSync(outDir, { recursive: true });
  const indexFile = join(outDir, 'synthetic-index.json');
  const predFile = join(outDir, 'synthetic-predictions.json');
  writeFileSync(indexFile, `${JSON.stringify(records, null, 2)}\n`);
  writeFileSync(predFile, `${JSON.stringify(predictions, null, 2)}\n`);
  process.stdout.write(`已生成合成占位夹具（非真实样本）：\n  ${indexFile}（${records.length} 条）\n  ${predFile}\n`);
  process.stdout.write('注意：这些记录 sourceKind=synthetic_placeholder，仅用于验证评估程序，不能作为真实评估证据。\n');
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('make-synthetic-fixture.mjs')) {
  main();
}
