// GY-I20 真实样本冻结清单与答案键的**真实仓库数据**回归。
// 目的：让"真实样本索引 / 答案键 / 覆盖绑定 / 冻结清单"的相互绑定在 CI 里可被证伪——
//   1) 已入库的真实索引通过 schema 与硬红线校验（原始媒体不提交、模型不自答、同簇/近重复不跨 split）；
//   2) 答案键覆盖全部条目，条目名与索引来源逐条一致；
//   3) 冻结清单可由索引**复算**得到同一 indexSha256，且与覆盖清单绑定一致；
//   4) 负控制：改动一条样本内容摘要或缩减覆盖清单，必须导致冻结/绑定校验失败。
// 本测试**不产生任何模型成绩**：真实模型实测未授权，预测文件刻意留空。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  METRIC_GATES,
  computeCoverageSha256,
  computeGaps,
  evaluateRun,
  validateSampleIndex,
  verifyCoverageBinding,
  verifyFrozenManifest,
} from '../../packages/evaluation/index.mjs';
import { computeFreezeFacts } from '../../tools/evaluation/freeze-real-samples.mjs';
import { loadKnowledgeScope } from '../../tools/evaluation/knowledge-scope.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLES = join(REPO_ROOT, 'packages', 'evaluation', 'samples');
const load = (name) => JSON.parse(readFileSync(join(SAMPLES, name), 'utf8'));

const index = load('gy-i20-weeds-real-index.json');
const labels = load('gy-i20-weeds-labels.json');
const coverage = load('gy-i20-weeds-coverage-manifest.json');
const frozen = load('gy-i20-weeds-frozen-manifest.json');
const predictionsAll = load('gy-i20-weeds-predictions-none.json');

test('真实索引：172 条拍草样本通过 schema + 硬红线 + 隔离校验', () => {
  const { ok, errors, stats } = validateSampleIndex(index);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  assert.equal(stats.total, 172);
  assert.deepEqual(stats.byTask, { weed_photo: 172 });
  assert.deepEqual(stats.bySplit, { test: 172 });
  assert.deepEqual(stats.bySourceKind, { real_collected: 172 });
  assert.equal(stats.synthetic, 0, '不得含 synthetic_placeholder 充数');
});

test('真实索引：无原始媒体、无模型自答、ID 与摘要格式合法', () => {
  const ids = new Set();
  for (const r of index) {
    assert.equal(r.rawMediaCommitted, false);
    assert.equal(r.annotation.modelGenerated, false);
    assert.notEqual(r.sourceKind, 'synthetic_placeholder');
    assert.match(r.contentSha256, /^[a-f0-9]{64}$/);
    assert.match(r.rawMediaSha256, /^[a-f0-9]{64}$/);
    assert.match(r.perceptualHash, /^[a-f0-9]{16}$/);
    assert.equal(r.perceptualHash.length, 16);
    assert.equal(ids.has(r.sampleId), false, `sampleId 重复：${r.sampleId}`);
    ids.add(r.sampleId);
    assert.ok(r.gold.media.width > 0 && r.gold.media.height > 0 && r.gold.media.bytes > 0);
  }
  assert.equal(ids.size, 172);
});

test('答案键覆盖全部条目，且条目名/来源与索引逐条一致', () => {
  assert.equal(labels.entries.length, index.length);
  assert.equal(labels.annotation.modelGenerated, false);
  const byOrdinal = new Map(labels.entries.map((e) => [e.ordinal, e]));
  for (const r of index) {
    const ordinal = Number(r.sampleId.slice('gy-i20-weeds-'.length));
    const l = byOrdinal.get(ordinal);
    assert.ok(l, `答案键缺少条目 ${ordinal}`);
    assert.equal(r.sourceRef, `${labels.sourceRef}#entry-${String(ordinal).padStart(3, '0')}`);
    assert.equal(r.gold.labelSource, r.sourceRef);
    assert.ok(l.criteria.length > 0, `条目 ${ordinal} 缺少判据要点`);
    assert.equal(r.labelClass, l.labelClass);
    assert.equal(r.coverage, l.coverage);
    assert.equal(r.gold.speciesId, l.coverage === 'covered' ? l.labelClass : null);
    if (l.coverage === 'out_of_coverage') assert.equal(r.gold.externalLabel, l.docxName);
  }
});

test('覆盖口径：7 条严格同名覆盖内 + 165 条覆盖外；同属近缘种不计入覆盖', () => {
  const covered = index.filter((r) => r.coverage === 'covered');
  assert.equal(covered.length, 7);
  assert.equal(index.filter((r) => r.coverage === 'out_of_coverage').length, 165);
  const classes = new Set(covered.map((r) => r.labelClass));
  assert.deepEqual([...classes].sort(), [
    'species_alligatorweed',
    'species_barnyardgrass',
    'species_crabgrass',
    'species_foxtail',
    'species_goosegrass',
    'species_lambsquarters',
    'species_shortawn_foxtail',
  ]);
  // 覆盖内 labelClass 一律为规范物种 ID；覆盖外用目录外稳定标识，不得假冒规范 ID
  for (const r of index) {
    if (r.coverage === 'covered') assert.match(r.labelClass, /^species_/);
    else assert.match(r.labelClass, /^ext_weed_\d{3}$/);
  }
  const congener = labels.entries.filter((e) => e.nearGroups?.some((n) => n.kind === 'congener'));
  assert.equal(congener.length, 13);
  for (const e of congener) assert.equal(e.coverage, 'out_of_coverage', `近缘种 ${e.ordinal} 不得直接计入覆盖内`);
});

test('冻结清单可由索引复算：indexSha256/coverageSha256/recordCount 一致（可复算）', () => {
  const { manifest } = computeFreezeFacts(index, coverage, {
    indexVersion: frozen.indexVersion,
    frozenAt: frozen.frozenAt,
  });
  assert.equal(manifest.indexSha256, frozen.indexSha256);
  assert.equal(manifest.recordCount, frozen.recordCount);
  assert.equal(manifest.coverage.coverageSha256, frozen.coverage.coverageSha256);
  assert.equal(computeCoverageSha256({ weedPhotoCoveredClasses: frozen.coverage.weedPhotoCoveredClasses }), frozen.coverage.coverageSha256);
  assert.equal(frozen.split, 'test');
});

test('冻结校验与覆盖绑定在真实数据上通过，且落在 GY-I03 承诺范围内', () => {
  const frozenCheck = verifyFrozenManifest(frozen, index.filter((r) => r.split === 'test'));
  assert.equal(frozenCheck.verified, true, frozenCheck.reasons.join('；'));
  const scope = loadKnowledgeScope();
  assert.ok(scope && scope.classes.length === 8);
  const binding = verifyCoverageBinding(frozen, coverage, { scopeClasses: scope.classes });
  assert.equal(binding.verified, true, binding.reasons.join('；'));
  assert.deepEqual(binding.boundClasses, coverage.weedPhotoCoveredClasses);
});

test('负控制：改动一条样本内容摘要 → 冻结校验必须失败（冻结集被改动）', () => {
  const tampered = index.map((r, i) => (i === 0 ? { ...r, contentSha256: 'f'.repeat(64) } : r));
  const check = verifyFrozenManifest(frozen, tampered.filter((r) => r.split === 'test'));
  assert.equal(check.verified, false);
  assert.ok(check.reasons.some((s) => s.includes('indexSha256')));
});

test('负控制：删除一条样本 → recordCount 与摘要不一致，冻结校验失败', () => {
  const check = verifyFrozenManifest(frozen, index.slice(1).filter((r) => r.split === 'test'));
  assert.equal(check.verified, false);
  assert.ok(check.reasons.some((s) => s.includes('recordCount')));
});

test('负控制：缩减承诺覆盖清单 → 覆盖绑定必须拒绝（覆盖清单被缩减）', () => {
  const shrunk = { ...coverage, weedPhotoCoveredClasses: coverage.weedPhotoCoveredClasses.slice(0, 3) };
  const binding = verifyCoverageBinding(frozen, shrunk);
  assert.equal(binding.verified, false);
  assert.ok(binding.reasons.some((s) => s.includes('缩减') || s.includes('不一致')));
});

test('真实缺口：覆盖外达标（165≥100），覆盖内每类/总量仍缺；重复排除数为 0', () => {
  const gaps = computeGaps(index, { coverageManifest: coverage });
  const by = Object.fromEntries(gaps.map((g) => [g.bucket, g]));
  assert.equal(by.weed_photo_covered.present, 7);
  assert.equal(by.weed_photo_covered.missing, 293);
  assert.equal(by.weed_photo_out_of_coverage.present, 165);
  assert.equal(by.weed_photo_out_of_coverage.missing, 0);
  assert.equal(by.weed_photo_covered_per_class.present, 0, '荨麻类无样本 → 逐类按未满足计');
  assert.equal(by.weed_photo_covered_per_class.coverageManifestPresent, true);
  assert.deepEqual(by.weed_photo_covered_per_class.promisedClasses, coverage.weedPhotoCoveredClasses);
  assert.equal(by.weed_photo_low_quality.present, 0);
  assert.equal(by.weed_photo_covered.duplicatesExcluded, 0);
});

test('真实样本 + 空预测的离线评估：isRealEvaluation=false、门禁全 not_evaluated、无任何模型成绩', () => {
  const report = evaluateRun(index, new Map(Object.entries(predictionsAll)), {
    gateDefs: METRIC_GATES,
    frozenManifest: frozen,
    coverageManifest: coverage,
    knowledgeScope: loadKnowledgeScope(),
    generatedAt: '2026-10-14T00:00:00.000Z',
  });
  assert.equal(report.dataKind, 'real_frozen');
  assert.equal(report.isRealEvaluation, false);
  assert.equal(report.frozenVerified, true);
  assert.equal(report.coverageBinding.verified, true);
  assert.equal(report.predictionEvidence.complete, false);
  assert.equal(report.predictionEvidence.missing.length, 172);
  assert.equal(report.tasks.weed_photo.gateStatus, 'not_evaluated');
  assert.equal(report.tasks.weed_photo.metrics.top1.p, null, '无预测不得伪造 0 分或成绩');
  assert.ok(report.tasks.weed_photo.gates.every((g) => g.claimable === false && g.status === 'not_evaluated'));
  assert.equal(report.tasks.weed_photo.sampleCount, 172);
  assert.ok(report.warnings.some((w) => w.includes('预测不完整')));
});
