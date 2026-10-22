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

test('拍草：拒识/重拍即使携带正确候选也计未命中（统一检查最终 decision）', () => {
  const mk = (decision) => ({
    record: { coverage: 'covered', quality: 'clear', labelClass: 'A' },
    output: { candidates: [{ speciesId: 'A' }], decision },
  });
  const m = weedPhotoMetrics([mk('candidate'), mk('uncertain'), mk('retake'), mk('rejected')]);
  assert.equal(m.coveredCount, 4);
  near(m.top1.p, 0.25);
  near(m.top3.p, 0.25);
  assert.equal(m.perClass.A.total, 4);
  near(m.perClass.A.top1.p, 0.25);
});

test('标签 OCR：校正样本保留原始输出评分，分母不缩，校正结果单独报告', () => {
  const pairs = [
    { record: { quality: 'clear', gold: { registrationNumber: 'R1', content: '10%' } }, output: { fields: { registrationNumber: 'R1', content: '10%' }, corrected: false } },
    {
      record: { quality: 'clear', gold: { registrationNumber: 'R1', content: '10%' } },
      output: { corrected: true, originalFields: { registrationNumber: 'R1', content: '99%' }, correctedFields: { registrationNumber: 'R1', content: '10%' } },
    },
  ];
  const m = labelOcrMetrics(pairs);
  assert.equal(m.clearCount, 2);
  assert.equal(m.correctedCount, 1);
  assert.equal(m.originalMissingCount, 0);
  // 分母保持冻结评估集官方分母 2，不因手改剔除而缩分母
  assert.equal(m.consideredForModelAccuracy, 2);
  near(m.registrationNumberExact.p, 1);
  near(m.fieldExact.content.p, 0.5);
  near(m.correctedFieldReport.content.correctedExact.p, 1);
});

test('标签 OCR：corrected=true 但缺原始输出 → 原始缺失计缺口，不得用校正稿补成绩', () => {
  const pairs = [
    { record: { quality: 'clear', gold: { registrationNumber: 'R1' } }, output: { corrected: true, fields: { registrationNumber: 'R1' } } },
  ];
  const m = labelOcrMetrics(pairs);
  assert.equal(m.clearCount, 1);
  assert.equal(m.modelScoredCount, 0);
  assert.equal(m.originalMissingCount, 1);
  assert.equal(m.registrationNumberExact.p, null);
});

test('标签 OCR：2 清晰样本（1 原始正确 + 1 校正缺原始）→ 保留原始分母，不得虚报 100%/n=1', () => {
  const pairs = [
    { record: { quality: 'clear', gold: { registrationNumber: 'R1', content: '10%' } }, output: { fields: { registrationNumber: 'R1', content: '10%' }, corrected: false } },
    { record: { quality: 'clear', gold: { registrationNumber: 'R2', content: '20%' } }, output: { corrected: true, fields: { registrationNumber: 'R2', content: '20%' } } },
  ];
  const m = labelOcrMetrics(pairs);
  assert.equal(m.clearCount, 2);
  assert.equal(m.modelScoredCount, 1);
  assert.equal(m.originalMissingCount, 1);
  // 分母固定为原始评估集分母 2，不是缺口后的子集 1
  assert.equal(m.originalEvaluationDenominator, 2);
  assert.equal(m.consideredForModelAccuracy, 2);
  assert.equal(m.originalDenominatorComplete, false);
  assert.equal(m.completeModelAccuracy, false);
  assert.equal(m.registrationNumberExact.n, 2);
  near(m.registrationNumberExact.p, 0.5);
  assert.equal(m.fieldExact.content.n, 2);
  near(m.fieldExact.content.p, 0.5);
});

test('ASR：仅消费原始转写，手改稿不得补成绩', () => {
  const gold = { reference: '草甘膦一百毫升', keyFields: { drugNames: ['草甘膦'] } };
  const pairs = [
    {
      record: { labelClass: 'quiet', sourceRef: 'spk-1', gold },
      // 改前错误、改后正确：模型成绩必须取原始转写
      output: { corrected: true, originalHypothesis: '草甘磷一百毫升', originalKeyFieldsExact: { drugNames: false }, hypothesis: '草甘膦一百毫升', keyFieldsExact: { drugNames: true } },
    },
  ];
  const m = asrMetrics(pairs, { resamples: 200 });
  assert.equal(m.correctedCount, 1);
  assert.equal(m.originalMissingCount, 0);
  // 原始转写错误被计入 CER（1/7），而非用改后正确文本得 0
  near(m.cer.p, 1 / 7, 0.001);
  near(m.keyFields.drugNames.p, 0);
});

test('ASR：纯校正输入（无原始转写）→ 原始缺失，不计 CER、不给成绩', () => {
  const pairs = [
    { record: { labelClass: 'quiet', sourceRef: 'spk-1', gold: { reference: '草甘膦一百毫升', keyFields: { drugNames: ['草甘膦'] } } }, output: { corrected: true, hypothesis: '草甘膦一百毫升', keyFieldsExact: { drugNames: true } } },
  ];
  const m = asrMetrics(pairs, { resamples: 200 });
  assert.equal(m.originalMissingCount, 1);
  assert.equal(m.scoredUtteranceCount, 0);
  assert.equal(m.cer.p, null);
});

test('AI 筛查：风险召回与正常误隔离率；unknown/非法枚举不算正常通过', () => {
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
  // 非法/服务错误枚举：正常样本不得算正常通过（计误隔离），风险样本不得计入命中。
  const tampered = aiModerationMetrics([
    { record: { expectation: 'normal' }, output: { decision: 'UNVALIDATED_SERVICE_ERROR' } },
    { record: { expectation: 'normal' }, output: { decision: 'unknown' } },
    { record: { expectation: 'risk' }, output: { decision: 'UNVALIDATED_SERVICE_ERROR' } },
  ]);
  near(tampered.normalFalseIsolationRate.p, 1);
  near(tampered.riskRecall.p, 0);
});

test('AI 筛查：hardRulePass 与规则层 hard_rule_passed 逐例对齐（缺失/自相矛盾记未通过）', () => {
  // 口径来源：packages/moderation 规则层产出 hard_rule_passed（engine.mjs 计算、merge.mjs 回填）：
  // 风险例应被硬规则拦下 ⇒ false；正常例应放行 ⇒ true。下面每条都按该期望造。
  const aligned = [
    { record: { expectation: 'risk' }, output: { decision: 'blocked', hard_rule_passed: false } },
    { record: { expectation: 'risk' }, output: { decision: 'pending_review', hard_rule_passed: false } },
    { record: { expectation: 'normal' }, output: { decision: 'published', hard_rule_passed: true } },
  ];
  near(aiModerationMetrics(aligned).hardRulePass.p, 1);

  // 字段缺失：不得默认"规则层通过"，一律记未通过（fail-closed）。
  const missing = aiModerationMetrics([
    { record: { expectation: 'normal' }, output: { decision: 'published' } },
    { record: { expectation: 'normal' }, output: { decision: 'published', hard_rule_passed: 'yes' } },
  ]);
  near(missing.hardRulePass.p, 0);
  assert.equal(missing.hardRulePass.missingHardRuleFact, 2);

  // 自相矛盾：approved/published 却说规则层没通过 ⇒ 记未通过（engine.mjs 的不变式 approved ⟺ hard_rule_passed===true）。
  const contradictory = aiModerationMetrics([
    { record: { expectation: 'normal' }, output: { decision: 'approved', hard_rule_passed: false } },
    { record: { expectation: 'normal' }, output: { decision: 'published', hard_rule_passed: false } },
  ]);
  near(contradictory.hardRulePass.p, 0);
  assert.equal(contradictory.hardRulePass.selfContradictory, 2);

  // 期望相反（风险例被放行且声称规则层通过）：同样记未通过，不因字段存在就放过。
  const opposite = aiModerationMetrics([
    { record: { expectation: 'risk' }, output: { decision: 'published', hard_rule_passed: true } },
  ]);
  near(opposite.hardRulePass.p, 0);
});

test('TTS：六项全部准确才 allCorrect（缺项记未测，不得默认成功）', () => {
  const ok = {
    numbersCorrect: true,
    unitsCorrect: true,
    negationCorrect: true,
    conditionsCorrect: true,
    stopReplayCorrect: true,
    textFallbackCorrect: true,
  };
  const pairs = [{ output: ok }, { output: { ...ok, unitsCorrect: false } }];
  const m = ttsMetrics(pairs);
  near(m.ttsAllCorrect.p, 0.5);
  assert.equal(m.allCorrect, false);
  assert.equal(m.untestedCount, 0);
  // 只有四项（缺停止重播/文字替代）→ 记未测，不按通过
  const partial = ttsMetrics([{ output: { numbersCorrect: true, unitsCorrect: true, negationCorrect: true, conditionsCorrect: true } }]);
  assert.equal(partial.ttsAllCorrect.p, 0);
  assert.equal(partial.allCorrect, false);
  assert.equal(partial.untestedCount, 1);
  assert.equal(partial.perFieldMissing.stopReplayCorrect, 1);
  assert.equal(partial.perFieldMissing.textFallbackCorrect, 1);
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
  const metrics = {
    top1: { p: 0.9 },
    top3: { p: 0.96 },
    outOfCoverageHighConfidenceRate: { p: 0.02 },
    lowQualityUncertainRate: { p: 0.97 },
    perClassMinTop1: { p: 0.88 },
  };
  const gates = buildGates('weed_photo', metrics, METRIC_GATES, true);
  assert.equal(gates.length, METRIC_GATES.filter((g) => g.task === 'weed_photo').length, 'weed_photo 门禁条数应与 METRIC_GATES 一致（新增门槛不得被这里静默忽略）');
  assert.ok(gates.every((g) => g.status === 'pass'));
  const fail = buildGates('weed_photo', { ...metrics, top1: { p: 0.5 } }, METRIC_GATES, true);
  assert.equal(fail.find((g) => g.metric === 'top1').status, 'fail');
  // 最差一档：某一类塌陷即 fail，不得被总体 Top1 平均掉。
  const perClassFail = buildGates('weed_photo', { ...metrics, perClassMinTop1: { p: 0.2 } }, METRIC_GATES, true);
  assert.equal(perClassFail.find((g) => g.metric === 'perClassMinTop1').status, 'fail');
});

test('门禁：claimable=false 时一律 not_evaluated，不写通过', () => {
  const metrics = { top1: { p: 1 }, top3: { p: 1 }, outOfCoverageHighConfidenceRate: { p: 0 }, lowQualityUncertainRate: { p: 1 } };
  const gates = buildGates('weed_photo', metrics, METRIC_GATES, false);
  assert.ok(gates.every((g) => g.status === 'not_evaluated' && g.claimable === false));
});
