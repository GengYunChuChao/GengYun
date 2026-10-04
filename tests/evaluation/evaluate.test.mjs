// 端到端评估编排测试（合成输入）。关键断言：合成/不足输入绝不产生"通过"结论。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRun, METRIC_GATES } from '../../packages/evaluation/index.mjs';
import { buildSyntheticFixture } from '../../tools/evaluation/make-synthetic-fixture.mjs';

test('合成夹具报告：dataKind=synthetic_placeholder、isRealEvaluation=false、门禁全 not_evaluated', () => {
  const { records, predictions } = buildSyntheticFixture();
  const map = new Map(Object.entries(predictions));
  const report = evaluateRun(records, map, { gateDefs: METRIC_GATES, frozenIndexVersion: 'synthetic' });

  assert.equal(report.dataKind, 'synthetic_placeholder');
  assert.equal(report.isRealEvaluation, false);
  for (const task of Object.values(report.tasks)) {
    assert.equal(task.gateStatus, 'not_evaluated');
    assert.ok(task.gates.every((g) => g.status === 'not_evaluated' && g.claimable === false));
  }
  assert.ok(report.warnings.some((w) => w.includes('不构成真实评估')));
});

test('合成夹具：缺口按第6节目标逐桶计算，真实样本到位为 0', () => {
  const { records, predictions } = buildSyntheticFixture();
  const report = evaluateRun(records, new Map(Object.entries(predictions)), { gateDefs: METRIC_GATES });
  assert.equal(report.gaps.length, 17);
  assert.ok(report.gaps.every((g) => g.present === 0 && g.missing === g.required));
  const covered = report.gaps.find((g) => g.bucket === 'weed_photo_covered');
  assert.equal(covered.required, 300);
});

test('报告结构满足 run-report 必填字段', () => {
  const { records, predictions } = buildSyntheticFixture();
  const report = evaluateRun(records, new Map(Object.entries(predictions)), { gateDefs: METRIC_GATES });
  for (const key of ['schemaVersion', 'dataKind', 'isRealEvaluation', 'generatedAt', 'indexSha256', 'predictionSha256', 'tasks', 'gaps', 'warnings']) {
    assert.ok(key in report, `缺少 ${key}`);
  }
  assert.match(report.indexSha256, /^[a-f0-9]{64}$/);
  assert.match(report.predictionSha256, /^[a-f0-9]{64}$/);
});

test('指标确实被计算（非空），证明程序可运行', () => {
  const { records, predictions } = buildSyntheticFixture();
  const report = evaluateRun(records, new Map(Object.entries(predictions)), { gateDefs: METRIC_GATES });
  assert.ok(report.tasks.weed_photo.metrics.top1.p !== null);
  assert.ok(report.tasks.asr.metrics.cer.p !== null);
  assert.equal(report.tasks.asr.metrics.speakerCount, 2);
  assert.equal(report.tasks.qa.metrics.answerableCount, 4);
});

test('预测缺失：不得当成功，任务保持 not_evaluated 且报告缺口', () => {
  const { records } = buildSyntheticFixture();
  const report = evaluateRun(records, new Map(), { gateDefs: METRIC_GATES });
  assert.equal(report.isRealEvaluation, false);
  assert.equal(report.predictionEvidence.complete, false);
  // 合成夹具全为 split=test，全部预测缺失
  assert.equal(report.predictionEvidence.missing.length, records.filter((r) => r.split === 'test').length);
  // 无有效预测不得伪造 0 分：观测值为空
  assert.equal(report.tasks.weed_photo.metrics.top1.p, null);
  assert.equal(report.tasks.weed_photo.gateStatus, 'not_evaluated');
});

test('非 synthetic 标签但全部 split=train：无独立 test 集，不得主张真实评估', () => {
  const { records, predictions } = buildSyntheticFixture();
  const trainOnly = records.map((r) => ({ ...r, split: 'train' }));
  const report = evaluateRun(trainOnly, new Map(Object.entries(predictions)), { gateDefs: METRIC_GATES });
  assert.equal(report.dataKind, 'no_test_split');
  assert.equal(report.isRealEvaluation, false);
  assert.equal(report.splits.test, 0);
  assert.equal(report.splits.train, records.length);
  for (const task of Object.values(report.tasks)) assert.equal(task.gateStatus, 'not_evaluated');
});

test('报告含冻结校验与预测完整性字段（synthetic 下冻结未通过）', () => {
  const { records, predictions } = buildSyntheticFixture();
  const report = evaluateRun(records, new Map(Object.entries(predictions)), { gateDefs: METRIC_GATES });
  assert.equal(report.frozenVerified, false);
  assert.equal(report.coverageManifestPresent, false);
  assert.ok(report.predictionEvidence);
  assert.ok(report.frozenVerification.reasons.length > 0);
});
