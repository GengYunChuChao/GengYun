// 修复轮 2 回归：针对监工第二轮四条（P1-C/D/E、P2-F）的确定性负例。
// 全部使用 tests/evaluation/validation-fixture.mjs 的**程序验证夹具**（非真实样本），
// 只断言"程序必须拒绝主张/不得虚报准确率"，绝不产出真实结论。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateRun,
  METRIC_GATES,
  verifyFrozenManifest,
  verifyCoverageBinding,
  computeCoverageSha256,
  validatePredictionOutput,
  aiModerationMetrics,
  ttsMetrics,
  labelOcrMetrics,
} from '../../packages/evaluation/index.mjs';
import { buildValidationSet, frozenManifestFor, coverageManifestFor } from './validation-fixture.mjs';

const toMap = (predictions) => new Map(Object.entries(predictions));
const near = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

function run(records, predictions, overrides = {}) {
  const { classes = null } = overrides;
  return evaluateRun(records, toMap(predictions), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records),
    coverageManifest: coverageManifestFor(classes ?? undefined),
    ...overrides,
  });
}

// —— P1-C：筛查最终决策闭集 ——
test('[负例C1] 200 正常筛查输出改为 UNVALIDATED_SERVICE_ERROR：非法枚举 → invalid，AI 门禁不得 pass', () => {
  const { records, predictions, classes } = buildValidationSet();
  const pred = { ...predictions };
  let mutated = 0;
  for (const r of records) {
    if (r.task === 'ai_moderation' && r.expectation === 'normal') {
      pred[r.sampleId] = { decision: 'UNVALIDATED_SERVICE_ERROR' };
      mutated += 1;
    }
  }
  assert.equal(mutated, 200);
  const report = run(records, pred, { classes });
  assert.equal(report.predictionEvidence.byTask.ai_moderation.invalid, 200);
  assert.equal(report.tasks.ai_moderation.gateStatus, 'not_evaluated');
  assert.equal(report.isRealEvaluation, false);
});

test('[负例C2] 直接调用 aiModerationMetrics：非法/unknown 决策不得算正常通过', () => {
  const m = aiModerationMetrics([
    { record: { expectation: 'normal' }, output: { decision: 'UNVALIDATED_SERVICE_ERROR' } },
    { record: { expectation: 'normal' }, output: { decision: 'unknown' } },
    { record: { expectation: 'normal' }, output: { decision: 'published' } },
    { record: { expectation: 'risk' }, output: { decision: 'blocked' } },
    { record: { expectation: 'risk' }, output: { decision: 'UNVALIDATED_SERVICE_ERROR' } },
  ]);
  // 2/3 正常样本为非法枚举 → 计误隔离；只有 published 才算正常通过
  near(m.normalFalseIsolationRate.p, 2 / 3);
  // 风险命中只认显式拦截；非法枚举不得计入召回
  near(m.riskRecall.p, 0.5);
});

test('[映射枚举回归] 筛查合法最终决策被接受，unknown/服务错误/非法枚举被拒绝', () => {
  for (const d of ['published', 'blocked', 'pending_review', 'rejected', 'quarantined', 'hidden']) {
    assert.equal(validatePredictionOutput('ai_moderation', { decision: d }).ok, true, `应接受 ${d}`);
  }
  for (const d of ['UNVALIDATED_SERVICE_ERROR', 'unknown', 'failed', '', 'published ', undefined, 123]) {
    assert.equal(validatePredictionOutput('ai_moderation', { decision: d }).ok, false, `应拒绝 ${String(d)}`);
  }
});

// —— P1-D：TTS 六项判定存在性 ——
test('[负例D1] 删除 30 条 TTS 的停止重播/文字替代判定：缺失记未测 → invalid，tts not_evaluated', () => {
  const { records, predictions, classes } = buildValidationSet();
  const pred = { ...predictions };
  let mutated = 0;
  for (const r of records) {
    if (r.task === 'tts') {
      const o = { ...pred[r.sampleId] };
      delete o.stopReplayCorrect;
      delete o.textFallbackCorrect;
      pred[r.sampleId] = o;
      mutated += 1;
    }
  }
  assert.equal(mutated, 30);
  const report = run(records, pred, { classes });
  assert.equal(report.predictionEvidence.byTask.tts.invalid, 30);
  assert.equal(report.tasks.tts.gateStatus, 'not_evaluated');
  assert.equal(report.isRealEvaluation, false);
});

test('[负例D2] TTS 六项：false 不计通过、四项不得外推为六项已测', () => {
  const six = { numbersCorrect: true, unitsCorrect: true, negationCorrect: true, conditionsCorrect: true, stopReplayCorrect: true, textFallbackCorrect: true };
  const m = ttsMetrics([
    { output: six },
    { output: { ...six, stopReplayCorrect: false } },
    { output: { numbersCorrect: true, unitsCorrect: true, negationCorrect: true, conditionsCorrect: true } },
  ]);
  assert.equal(m.allCorrect, false);
  near(m.ttsAllCorrect.p, 1 / 3);
  assert.equal(m.untestedCount, 1);
  assert.equal(m.perFieldMissing.stopReplayCorrect, 1);
  // 只有四项的样本经结构校验也不可用（未测）
  assert.equal(validatePredictionOutput('tts', { numbersCorrect: true, unitsCorrect: true, negationCorrect: true, conditionsCorrect: true }).ok, false);
});

// —— P1-E：覆盖清单与冻结清单绑定 ——
test('[负例E1] 冻结清单/indexSha256 不动，仅把外部覆盖清单缩为 1 类 → 绑定不一致，拒绝', () => {
  const { records, predictions, classes } = buildValidationSet();
  const frozen = frozenManifestFor(records); // 内嵌 6 类
  const report = evaluateRun(records, toMap(predictions), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozen,
    coverageManifest: { weedPhotoCoveredClasses: [classes[0]] },
  });
  assert.equal(report.coverageBinding.verified, false);
  assert.equal(report.isRealEvaluation, false);
  assert.ok(report.coverageBinding.reasons.some((r) => r.includes('绑定不一致')));
  assert.ok(report.warnings.some((w) => w.includes('未与冻结清单绑定')));
  // 逐类达标按未满足计
  assert.equal(report.gaps.find((g) => g.bucket === 'weed_photo_covered_per_class').missing, 30);
});

test('[负例E2] 冻结清单内 coverage 块被改动（coverageSha256 不符）→ 绑定拒绝', () => {
  const { records, predictions, classes } = buildValidationSet();
  const frozen = frozenManifestFor(records);
  frozen.coverage = { ...frozen.coverage, weedPhotoCoveredClasses: [classes[0]] }; // 改内容不改 hash
  const report = evaluateRun(records, toMap(predictions), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozen,
    coverageManifest: coverageManifestFor([classes[0]]),
  });
  assert.equal(report.coverageBinding.verified, false);
  assert.ok(report.coverageBinding.reasons.some((r) => r.includes('coverageSha256')));
  assert.equal(report.isRealEvaluation, false);
});

test('[负例E3] 变化须成为新冻结版本：内嵌 1 类新版本 + 匹配外部清单 → 绑定通过且 manifestSha256 改变', () => {
  const { records, predictions, classes } = buildValidationSet();
  const testRecords = records.filter((r) => r.split === 'test');
  const original = frozenManifestFor(records);
  const oneClass = [classes[0]];
  const newVersion = frozenManifestFor(records, { indexVersion: 'validation-v2', frozenAt: '2026-10-05T00:00:00Z', coverage: { weedPhotoCoveredClasses: oneClass } });
  const report = evaluateRun(records, toMap(predictions), {
    gateDefs: METRIC_GATES,
    frozenManifest: newVersion,
    coverageManifest: coverageManifestFor(oneClass),
  });
  assert.equal(report.coverageBinding.verified, true);
  assert.equal(report.frozenIndexVersion, 'validation-v2');
  // 覆盖口径变化 → 冻结版本（manifestSha256）必须变化，可被审计
  assert.notEqual(verifyFrozenManifest(original, testRecords).manifestSha256, verifyFrozenManifest(newVersion, testRecords).manifestSha256);
});

test('[负例E4] 承诺覆盖类超出 GY-I03 承诺范围 → 拒绝', () => {
  const { records, predictions, classes } = buildValidationSet();
  const promised = [classes[0], 'CLS_NOT_IN_GYI03'];
  const report = evaluateRun(records, toMap(predictions), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records, { coverage: { weedPhotoCoveredClasses: promised } }),
    coverageManifest: coverageManifestFor(promised),
    knowledgeScope: classes,
  });
  assert.equal(report.coverageBinding.verified, false);
  assert.ok(report.coverageBinding.reasons.some((r) => r.includes('GY-I03')));
  assert.equal(report.isRealEvaluation, false);
});

test('[绑定] computeCoverageSha256 稳定且随覆盖类变化', () => {
  const a = computeCoverageSha256({ weedPhotoCoveredClasses: ['A', 'B'] });
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, computeCoverageSha256({ weedPhotoCoveredClasses: ['A', 'B'] }));
  assert.notEqual(a, computeCoverageSha256({ weedPhotoCoveredClasses: ['A'] }));
  // 直接单元：外部清单与冻结不一致
  const binding = verifyCoverageBinding(
    { coverage: { weedPhotoCoveredClasses: ['A', 'B'], coverageSha256: a, basisRef: 'GY-I03#species_groups' } },
    { weedPhotoCoveredClasses: ['A'] },
  );
  assert.equal(binding.verified, false);
});

// —— P2-F：OCR 原始评估分母 ——
test('[负例F] 直接调用 labelOcrMetrics：2 清晰（1 原始正确 + 1 校正无原始）→ 原始分母 n=2，非 100%/n=1', () => {
  const m = labelOcrMetrics([
    { record: { quality: 'clear', gold: { registrationNumber: 'R1', content: '10%' } }, output: { fields: { registrationNumber: 'R1', content: '10%' }, corrected: false } },
    { record: { quality: 'clear', gold: { registrationNumber: 'R2', content: '20%' } }, output: { corrected: true, fields: { registrationNumber: 'R2', content: '20%' } } },
  ]);
  assert.equal(m.originalMissingCount, 1);
  assert.equal(m.originalEvaluationDenominator, 2);
  assert.equal(m.completeModelAccuracy, false);
  assert.equal(m.registrationNumberExact.n, 2);
  near(m.registrationNumberExact.p, 0.5);
  assert.equal(m.fieldExact.content.n, 2);
  near(m.fieldExact.content.p, 0.5);
});
