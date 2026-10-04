// 修复轮 1 回归：针对监工六类负例的确定性回归。
// 全部使用 tests/evaluation/validation-fixture.mjs 的**程序验证夹具**（非真实样本），
// 只断言"程序必须拒绝主张"或"门禁不写通过"，绝不产出真实结论。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRun, METRIC_GATES } from '../../packages/evaluation/index.mjs';
import { toPredictionMap } from '../../tools/evaluation/lib.mjs';
import { buildValidationSet, frozenManifestFor, coverageManifestFor } from './validation-fixture.mjs';

const toMap = (predictions) => new Map(Object.entries(predictions));

/** 基线：所有条件满足（仅用于验证程序能主张，不代表真实结论）。 */
function positiveRun(overrides = {}) {
  const { records, predictions, classes } = buildValidationSet();
  const report = evaluateRun(records, toMap(predictions), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records),
    coverageManifest: coverageManifestFor(classes),
    ...overrides,
  });
  return { report, records, predictions, classes };
}

test('[负例0/基线] 冻结 test 集 + 完整预测 + 覆盖清单：程序可主张 isRealEvaluation=true，门禁全 pass', () => {
  const { report } = positiveRun();
  assert.equal(report.dataKind, 'real_frozen');
  assert.equal(report.frozenVerified, true);
  assert.equal(report.isRealEvaluation, true);
  assert.equal(report.predictionEvidence.complete, true);
  assert.equal(report.duplicatesExcluded, 0);
  for (const t of Object.values(report.tasks)) assert.equal(t.gateStatus, 'pass');
});

// —— 负例 1：非 synthetic 标签 ≠ 冻结独立 test 集 ——
test('[负例1a] 1500 条全部 split=train：无独立 test 集，dataKind=no_test_split、不得主张', () => {
  const { records, predictions } = buildValidationSet();
  const trainOnly = records.map((r) => ({ ...r, split: 'train' }));
  const report = evaluateRun(trainOnly, toMap(predictions), { gateDefs: METRIC_GATES });
  assert.equal(report.dataKind, 'no_test_split');
  assert.equal(report.isRealEvaluation, false);
  assert.equal(report.splits.test, 0);
  assert.equal(report.splits.train, records.length);
  for (const t of Object.values(report.tasks)) assert.equal(t.gateStatus, 'not_evaluated');
});

test('[负例1b] 缺冻结清单（unfrozen）：即使真实 test 集达标也不得主张', () => {
  const { records, predictions, classes } = buildValidationSet();
  const report = evaluateRun(records, toMap(predictions), { gateDefs: METRIC_GATES, coverageManifest: coverageManifestFor(classes) });
  assert.equal(report.frozenVerified, false);
  assert.equal(report.isRealEvaluation, false);
  assert.equal(report.frozenIndexVersion, 'unfrozen');
  assert.ok(report.warnings.some((w) => w.includes('冻结清单校验未通过')));
  for (const t of Object.values(report.tasks)) assert.equal(t.gateStatus, 'not_evaluated');
});

test('[负例1c] 手填版本号/来源标签不能代替冻结清单：hash 不符即拒绝', () => {
  const { records, predictions } = buildValidationSet();
  const tampered = frozenManifestFor(records, { indexSha256: 'f'.repeat(64), frozenAt: '2026-10-04T00:00:00Z' });
  const report = evaluateRun(records, toMap(predictions), {
    gateDefs: METRIC_GATES,
    frozenManifest: tampered,
    coverageManifest: coverageManifestFor(),
  });
  assert.equal(report.frozenVerified, false);
  assert.equal(report.isRealEvaluation, false);
});

test('[负例1d] 混合 split：最终评分只用 test；train 另列统计且不计入', () => {
  const { report, records } = (() => {
    const base = buildValidationSet();
    const trainCopy = base.records.slice(0, 25).map((r) => ({ ...r, sampleId: `train-${r.sampleId}`, clusterId: `train-${r.clusterId}`, split: 'train' }));
    const records = [...base.records, ...trainCopy];
    const report = evaluateRun(records, toMap(base.predictions), {
      gateDefs: METRIC_GATES,
      frozenManifest: frozenManifestFor(records),
      coverageManifest: coverageManifestFor(base.classes),
    });
    return { report, records };
  })();
  assert.equal(report.splits.test, 1500);
  assert.equal(report.splits.train, 25);
  assert.equal(report.isRealEvaluation, true);
  // 每个 task 的样本数只统计 test（train 副本不计入）
  assert.equal(report.tasks.weed_photo.sampleCount, 500);
});

// —— 负例 2：按行计数 / 同源重复充数 / 漏承诺类别 ——
test('[负例2a] 300 条覆盖内同 clusterId/contentSha256：去重后 present=1，缺口不满足', () => {
  const { records, predictions, classes } = buildValidationSet();
  const mutated = records.map((r) =>
    r.task === 'weed_photo' && r.coverage === 'covered' && r.quality === 'clear'
      ? { ...r, clusterId: 'one-cluster', contentSha256: 'a'.repeat(64) }
      : r,
  );
  const report = evaluateRun(mutated, toMap(predictions), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(mutated),
    coverageManifest: coverageManifestFor(classes),
  });
  const covered = report.gaps.find((g) => g.bucket === 'weed_photo_covered');
  assert.equal(covered.present, 1);
  assert.equal(covered.duplicatesExcluded, 299);
  assert.equal(report.isRealEvaluation, false);
  assert.equal(report.duplicatesExcluded, 299);
});

test('[负例2b] 缺冻结覆盖清单：逐类达标不可推断，门禁不通过', () => {
  const { records, predictions } = buildValidationSet();
  const report = evaluateRun(records, toMap(predictions), { gateDefs: METRIC_GATES, frozenManifest: frozenManifestFor(records) });
  const perClass = report.gaps.find((g) => g.bucket === 'weed_photo_covered_per_class');
  assert.equal(perClass.present, 0);
  assert.equal(perClass.coverageManifestPresent, false);
  assert.equal(report.coverageManifestPresent, false);
  assert.equal(report.isRealEvaluation, false);
});

test('[负例2c] 覆盖清单承诺类别未到位：逐类取清单最小值，漏类即缺口', () => {
  const { records, predictions, classes } = buildValidationSet();
  const report = evaluateRun(records, toMap(predictions), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records),
    coverageManifest: { weedPhotoCoveredClasses: [...classes, 'CLS_NOT_COLLECTED'] },
  });
  const perClass = report.gaps.find((g) => g.bucket === 'weed_photo_covered_per_class');
  assert.equal(perClass.present, 0);
  assert.equal(perClass.missing, 30);
  assert.equal(report.isRealEvaluation, false);
});

// —— 负例 3：缺失预测被当成功 ——
test('[负例3a] 删除 100 覆盖外 + 200 正常审核预测：任务 not_evaluated，正常误隔离率不为 0', () => {
  const { records, predictions, classes } = buildValidationSet();
  const pred = { ...predictions };
  for (const r of records) {
    if ((r.task === 'weed_photo' && r.coverage === 'out_of_coverage') || (r.task === 'ai_moderation' && r.expectation === 'normal')) delete pred[r.sampleId];
  }
  const report = evaluateRun(records, toMap(pred), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records),
    coverageManifest: coverageManifestFor(classes),
  });
  assert.equal(report.isRealEvaluation, false);
  assert.equal(report.predictionEvidence.missing.length, 300);
  assert.equal(report.tasks.weed_photo.gateStatus, 'not_evaluated');
  assert.equal(report.tasks.ai_moderation.gateStatus, 'not_evaluated');
  assert.equal(report.tasks.ai_moderation.metrics.normalFalseIsolationRate.p, null);
});

test('[负例3b] 部分缺失 → 未测保留 not_evaluated 与缺口，不当作空输出成功', () => {
  const { records, predictions, classes } = buildValidationSet();
  const pred = { ...predictions };
  let removed = 0;
  for (const r of records) {
    if (r.task === 'qa' && r.expectation === 'answerable' && removed < 5) {
      delete pred[r.sampleId];
      removed += 1;
    }
  }
  const report = evaluateRun(records, toMap(pred), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records),
    coverageManifest: coverageManifestFor(classes),
  });
  assert.equal(report.tasks.qa.gateStatus, 'not_evaluated');
  assert.equal(report.predictionEvidence.byTask.qa.missing, 5);
  assert.equal(report.isRealEvaluation, false);
});

test('[负例3c] 服务失败标记（error）视为未测量 → 任务 not_evaluated', () => {
  const { records, predictions, classes } = buildValidationSet();
  const pred = { ...predictions };
  for (const r of records) if (r.task === 'tts') pred[r.sampleId] = { error: 'upstream_timeout' };
  const report = evaluateRun(records, toMap(pred), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records),
    coverageManifest: coverageManifestFor(classes),
  });
  assert.equal(report.tasks.tts.gateStatus, 'not_evaluated');
  assert.equal(report.predictionEvidence.byTask.tts.invalid, 30);
  assert.equal(report.isRealEvaluation, false);
});

test('[负例3d] 重复预测（数组重复 sampleId）被拒绝', () => {
  assert.throws(() => toPredictionMap([{ sampleId: 'dup-1', output: {} }, { sampleId: 'dup-1', output: {} }]), /重复 sampleId/);
  assert.throws(() => toPredictionMap([{ sampleId: 'a', output: {} }, { sampleId: 'b', output: {} }, { sampleId: 'a', output: {} }]), /重复 sampleId/);
});

test('[负例3e] 全部预测缺失：无任何观测值，全部门禁 not_evaluated、不得主张', () => {
  const { records, classes } = buildValidationSet();
  const report = evaluateRun(records, new Map(), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records),
    coverageManifest: coverageManifestFor(classes),
  });
  assert.equal(report.predictionEvidence.missing.length, 1500);
  assert.equal(report.isRealEvaluation, false);
  for (const t of Object.values(report.tasks)) {
    assert.equal(t.gateStatus, 'not_evaluated');
    assert.equal(t.metrics.top1?.p ?? null, null);
  }
});

// —— 负例 4：剔除手改样本缩分母过门槛 ——
test('[负例4] 199/200 清晰标签为 corrected 且缺原始输出：不得缩分母过门槛，label_ocr not_evaluated', () => {
  const { records, predictions, classes } = buildValidationSet();
  const pred = { ...predictions };
  let mutated = 0;
  for (const r of records) {
    if (r.task === 'label_ocr' && r.quality === 'clear' && mutated < 199) {
      const gold = r.gold;
      // corrected=true 但只给校正稿、不给原始输出 → 原始输出缺失
      pred[r.sampleId] = { corrected: true, fields: { ...gold }, correctedFields: { ...gold } };
      mutated += 1;
    }
  }
  const report = evaluateRun(records, toMap(pred), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records),
    coverageManifest: coverageManifestFor(classes),
  });
  assert.equal(report.predictionEvidence.byTask.label_ocr.invalid, 199);
  assert.equal(report.tasks.label_ocr.metrics.modelScoredCount, 1);
  assert.equal(report.tasks.label_ocr.gateStatus, 'not_evaluated');
  assert.equal(report.isRealEvaluation, false);
});

// —— 负例 5：ASR 未处理 corrected ——
test('[负例5] ASR 全为 corrected 且缺原始转写：手改稿不得补成绩，asr not_evaluated', () => {
  const { records, predictions, classes } = buildValidationSet();
  const pred = { ...predictions };
  for (const r of records) {
    if (r.task === 'asr') pred[r.sampleId] = { corrected: true, hypothesis: r.gold.reference, keyFieldsExact: { drugNames: true, numbers: true, units: true } };
  }
  const report = evaluateRun(records, toMap(pred), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records),
    coverageManifest: coverageManifestFor(classes),
  });
  assert.equal(report.predictionEvidence.byTask.asr.invalid, 50);
  assert.equal(report.tasks.asr.gateStatus, 'not_evaluated');
  assert.equal(report.isRealEvaluation, false);
});

// —— 负例 6：覆盖内拒识携带候选仍算命中 ——
test('[负例6] 覆盖内全部 decision=uncertain 且携带正确候选：Top1=0，拍草门禁 fail', () => {
  const { records, predictions, classes } = buildValidationSet();
  const pred = { ...predictions };
  for (const r of records) {
    if (r.task === 'weed_photo' && r.coverage === 'covered' && r.quality === 'clear') {
      pred[r.sampleId] = { candidates: [{ speciesId: r.labelClass, confidence: 0.9 }], decision: 'uncertain' };
    }
  }
  const report = evaluateRun(records, toMap(pred), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozenManifestFor(records),
    coverageManifest: coverageManifestFor(classes),
  });
  assert.equal(report.isRealEvaluation, true);
  assert.equal(report.tasks.weed_photo.metrics.top1.p, 0);
  assert.equal(report.tasks.weed_photo.gateStatus, 'fail');
});

// —— 负例 1 补充：冻结校验单元（非 JSON 清单不可信） ——
test('[负例1e] verifyFrozenManifest：split/recordCount/hash 任一不符即未通过', async () => {
  const { verifyFrozenManifest } = await import('../../packages/evaluation/src/frozen.mjs');
  const { records } = buildValidationSet();
  const testRecords = records.filter((r) => r.split === 'test');
  assert.equal(verifyFrozenManifest(null, testRecords).verified, false);
  assert.equal(verifyFrozenManifest(frozenManifestFor(records, { split: 'train' }), testRecords).verified, false);
  assert.equal(verifyFrozenManifest(frozenManifestFor(records, { recordCount: 1 }), testRecords).verified, false);
  assert.equal(verifyFrozenManifest(frozenManifestFor(records, { frozenAt: '' }), testRecords).verified, false);
  assert.equal(verifyFrozenManifest(frozenManifestFor(records), testRecords).verified, true);
});
