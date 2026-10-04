// 指标与置信区间单元测试。全部使用合成输入，仅验证程序本身，不代表真实模型评估。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wilsonInterval,
  bootstrapRatioInterval,
  levenshtein,
  normalizeForCER,
  weedPhotoMetrics,
  labelOcrMetrics,
  aiModerationMetrics,
  ttsMetrics,
  asrMetrics,
  qaMetrics,
  buildGates,
} from '../../packages/evaluation/index.mjs';
import { METRIC_GATES } from '../../packages/evaluation/src/targets.mjs';

const near = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

test('Wilson 区间：0/0 返回空；1/1 下界接近 0.2065', () => {
  assert.equal(wilsonInterval(0, 0).p, null);
  const r = wilsonInterval(1, 1);
  near(r.p, 1);
  near(r.low, 0.2065, 0.002);
  near(r.high, 1);
});

test('Wilson 区间：对称性 5/10 中心=0.5 且区间跨中', () => {
  const r = wilsonInterval(5, 10);
  near(r.p, 0.5);
  assert.ok(r.low < 0.5 && r.high > 0.5);
  assert.ok(Math.abs((r.low + r.high) / 2 - 0.5) < 1e-9);
});

test('Wilson 区间：非法入参抛错', () => {
  assert.throws(() => wilsonInterval(3, 2));
  assert.throws(() => wilsonInterval(-1, 2));
});

test('CER：去标点后 Levenshtein 与归一化', () => {
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(normalizeForCER('每亩，使用 50 克。'), '每亩使用50克');
});

test('bootstrap 比率区间：全对时下界≥0且上界=0（距离全0）', () => {
  const items = [{ distance: 0, referenceLength: 10 }, { distance: 0, referenceLength: 10 }];
  const r = bootstrapRatioInterval(items, { seed: 1, resamples: 500 });
  assert.equal(r.p, 0);
  assert.equal(r.low, 0);
  assert.equal(r.high, 0);
});

test('bootstrap 比率区间：确定性可重复', () => {
  const items = [{ distance: 2, referenceLength: 10 }, { distance: 0, referenceLength: 10 }];
  const a = bootstrapRatioInterval(items, { seed: 42, resamples: 1000 });
  const b = bootstrapRatioInterval(items, { seed: 42, resamples: 1000 });
  assert.deepEqual(a, b);
});

test('拍草：拒识计入未命中，覆盖外高置信率与低质量不确定率按分组计算', () => {
  const pairs = [
    { record: { coverage: 'covered', quality: 'clear', labelClass: 'A' }, output: { candidates: [{ speciesId: 'A' }], decision: 'candidate' } },
    { record: { coverage: 'covered', quality: 'clear', labelClass: 'A' }, output: { candidates: [], decision: 'uncertain' } }, // 拒识=未命中
    { record: { coverage: 'covered', quality: 'clear', labelClass: 'B' }, output: { candidates: [{ speciesId: 'B' }], decision: 'candidate' } },
    { record: { coverage: 'out_of_coverage', quality: 'clear', labelClass: 'X' }, output: { candidates: [{ speciesId: 'A' }], decision: 'candidate' } },
    { record: { coverage: 'out_of_coverage', quality: 'clear', labelClass: 'X' }, output: { candidates: [], decision: 'uncertain' } },
    { record: { coverage: 'covered', quality: 'blurry', labelClass: 'A' }, output: { candidates: [], decision: 'uncertain' } },
  ];
  const m = weedPhotoMetrics(pairs);
  assert.equal(m.coveredCount, 3);
  near(m.top1.p, 2 / 3);
  near(m.top3.p, 2 / 3);
  near(m.outOfCoverageHighConfidenceRate.p, 0.5);
  near(m.lowQualityUncertainRate.p, 1);
  assert.equal(m.perClass.A.total, 2);
});

test('标签 OCR：手工校正样本从模型准确率剔除', () => {
  const pairs = [
    { record: { quality: 'clear', gold: { registrationNumber: 'R1', content: '10%' } }, output: { fields: { registrationNumber: 'R1', content: '10%' }, corrected: false } },
    { record: { quality: 'clear', gold: { registrationNumber: 'R1', content: '10%' } }, output: { fields: { registrationNumber: 'R1', content: '99%' }, corrected: true } },
  ];
  const m = labelOcrMetrics(pairs);
  assert.equal(m.clearCount, 2);
  assert.equal(m.correctedExcluded, 1);
  assert.equal(m.consideredForModelAccuracy, 1);
  near(m.registrationNumberExact.p, 1);
});

test('AI 筛查：风险召回与正常误隔离率', () => {
  const pairs = [
    { record: { expectation: 'risk' }, output: { decision: 'blocked' } },
    { record: { expectation: 'risk' }, output: { decision: 'pending_review' } },
    { record: { expectation: 'risk' }, output: { decision: 'published' } },
    { record: { expectation: 'normal' }, output: { decision: 'published' } },
    { record: { expectation: 'normal' }, output: { decision: 'blocked' } },
  ];
  const m = aiModerationMetrics(pairs);
  near(m.riskRecall.p, 2 / 3);
  near(m.normalFalseIsolationRate.p, 0.5);
});

test('TTS：全部准确才 allCorrect', () => {
  const ok = { numbersCorrect: true, unitsCorrect: true, negationCorrect: true, conditionsCorrect: true };
  const pairs = [{ output: ok }, { output: { ...ok, unitsCorrect: false } }];
  const m = ttsMetrics(pairs);
  near(m.ttsAllCorrect.p, 0.5);
  assert.equal(m.allCorrect, false);
});

test('ASR：总体 CER 与关键字段、说话者计数', () => {
  const pairs = [
    { record: { labelClass: 'quiet', sourceRef: 'spk-1', gold: { reference: '草甘膦一百毫升', keyFields: { drugNames: ['草甘膦'] } } }, output: { hypothesis: '草甘膦一百毫升', keyFieldsExact: { drugNames: true } } },
    { record: { labelClass: 'noisy', sourceRef: 'spk-2', gold: { reference: '草甘膦一百毫升', keyFields: { drugNames: ['草甘膦'] } } }, output: { hypothesis: '草甘磷一百毫升', keyFieldsExact: { drugNames: false } } },
  ];
  const m = asrMetrics(pairs, { resamples: 200 });
  assert.equal(m.speakerCount, 2);
  near(m.cer.p, 1 / 14, 0.001);
  near(m.keyFields.drugNames.p, 0.5);
});

test('问答：可答正确且有来源 + 预期行为分组', () => {
  const pairs = [
    { record: { expectation: 'answerable' }, output: { correct: true, sourceSupported: true } },
    { record: { expectation: 'answerable' }, output: { correct: true, sourceSupported: false } },
    { record: { expectation: 'insufficient' }, output: { expectedBehaviorOk: true } },
    { record: { expectation: 'injection' }, output: { expectedBehaviorOk: false } },
  ];
  const m = qaMetrics(pairs);
  near(m.answerableCorrectWithSource.p, 0.5);
  near(m.expectedBehaviorPass.p, 0.5);
  assert.equal(m.byGroup.injection.total, 1);
});

test('门禁：claimable=true 时按方向产生 pass/fail', () => {
  const metrics = { top1: { p: 0.9 }, top3: { p: 0.96 }, outOfCoverageHighConfidenceRate: { p: 0.02 }, lowQualityUncertainRate: { p: 0.97 } };
  const gates = buildGates('weed_photo', metrics, METRIC_GATES, true);
  assert.equal(gates.length, 4);
  assert.ok(gates.every((g) => g.status === 'pass'));
  const fail = buildGates('weed_photo', { ...metrics, top1: { p: 0.5 } }, METRIC_GATES, true);
  assert.equal(fail.find((g) => g.metric === 'top1').status, 'fail');
});

test('门禁：claimable=false 时一律 not_evaluated，不写通过', () => {
  const metrics = { top1: { p: 1 }, top3: { p: 1 }, outOfCoverageHighConfidenceRate: { p: 0 }, lowQualityUncertainRate: { p: 1 } };
  const gates = buildGates('weed_photo', metrics, METRIC_GATES, false);
  assert.ok(gates.every((g) => g.status === 'not_evaluated' && g.claimable === false));
});
