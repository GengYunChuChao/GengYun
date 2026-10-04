// 近重复排除与训练/验证/测试隔离测试（合成输入）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  hammingDistanceHex,
  analyzeClusters,
  splitIsolationErrors,
  validateSample,
  validateSampleIndex,
  dedupeByIndependentObject,
  computeGaps,
} from '../../packages/evaluation/index.mjs';

const sha = (t) => createHash('sha256').update(t).digest('hex');

function rec(overrides = {}) {
  const id = overrides.sampleId ?? 'S1';
  return {
    schemaVersion: '1.0.0',
    sampleId: id,
    task: 'weed_photo',
    split: 'test',
    clusterId: `c-${id}`,
    contentSha256: sha(id),
    sourceKind: 'real_collected',
    sourceRef: 'batch-1',
    labelClass: 'A',
    coverage: 'covered',
    quality: 'clear',
    gold: { speciesId: 'A' },
    annotation: { method: 'reliable_label', annotatorRef: 'ann-1', modelGenerated: false },
    rawMediaCommitted: false,
    ...overrides,
  };
}

test('hammingDistanceHex：相同=0，不同位计数', () => {
  assert.equal(hammingDistanceHex('0000000000000000', '0000000000000000'), 0);
  assert.equal(hammingDistanceHex('0000000000000000', '000000000000000f'), 4);
  assert.equal(hammingDistanceHex('zzzz', '0000'), null);
});

test('显式簇跨 split 被拒绝', () => {
  const records = [rec({ sampleId: 'A', clusterId: 'crop-1', split: 'train' }), rec({ sampleId: 'B', clusterId: 'crop-1', split: 'test' })];
  const errors = splitIsolationErrors(records);
  assert.ok(errors.some((e) => e.includes('crop-1')));
});

test('同簇同 split 通过', () => {
  const records = [rec({ sampleId: 'A', clusterId: 'crop-1', split: 'test' }), rec({ sampleId: 'B', clusterId: 'crop-1', split: 'test' })];
  assert.deepEqual(splitIsolationErrors(records), []);
});

test('连拍系列跨 split 被拒绝', () => {
  const records = [
    rec({ sampleId: 'A', clusterId: 's1', captureSeriesId: 'burst-1', split: 'train' }),
    rec({ sampleId: 'B', clusterId: 's2', captureSeriesId: 'burst-1', split: 'test' }),
  ];
  const errors = splitIsolationErrors(records);
  assert.ok(errors.some((e) => e.includes('连拍系列 burst-1')));
});

test('感知哈希近重复但不同簇被要求合并', () => {
  const records = [
    rec({ sampleId: 'A', clusterId: 'c1', perceptualHash: 'ffffffffffffffff' }),
    rec({ sampleId: 'B', clusterId: 'c2', perceptualHash: 'ffffffffffffff00' }),
  ];
  const errors = splitIsolationErrors(records, { hammingThreshold: 8 });
  assert.ok(errors.some((e) => e.includes('感知近重复')));
});

test('analyzeClusters 统计簇成员', () => {
  const records = [rec({ sampleId: 'A', clusterId: 'c1' }), rec({ sampleId: 'B', clusterId: 'c1' }), rec({ sampleId: 'C', clusterId: 'c2' })];
  const { clusters } = analyzeClusters(records);
  assert.equal(clusters.get('c1').length, 2);
});

test('同文本问答跨 split 被拒绝', () => {
  const mk = (id, split) => rec({ sampleId: id, task: 'qa', split, clusterId: `c-${id}`, gold: { question: 'Q', reference: 'R' } });
  const errors = splitIsolationErrors([mk('A', 'train'), mk('B', 'test')]);
  assert.ok(errors.some((e) => e.includes('同文本样本')));
});

test('validateSample：模型自答/原始媒体提交/坏 hash 均被拒', () => {
  assert.ok(validateSample(rec({ annotation: { method: 'reliable_label', annotatorRef: 'x', modelGenerated: true } })).some((e) => e.includes('modelGenerated')));
  assert.ok(validateSample(rec({ rawMediaCommitted: true })).some((e) => e.includes('rawMediaCommitted')));
  assert.ok(validateSample(rec({ contentSha256: 'deadbeef' })).some((e) => e.includes('contentSha256')));
  assert.ok(validateSample(rec({ annotation: { method: 'model_output', annotatorRef: 'x', modelGenerated: false } })).some((e) => e.includes('annotation.method')));
});

test('validateSampleIndex：合法索引通过，重复 ID 被拒', () => {
  const ok = validateSampleIndex([rec({ sampleId: 'A' }), rec({ sampleId: 'B' })]);
  assert.equal(ok.ok, true);
  const dup = validateSampleIndex([rec({ sampleId: 'A' }), rec({ sampleId: 'A' })]);
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((e) => e.includes('重复')));
});

test('validateSampleIndex：真实与合成混合给出警告', () => {
  const r = validateSampleIndex([
    rec({ sampleId: 'A', sourceKind: 'real_collected' }),
    rec({ sampleId: 'B', sourceKind: 'synthetic_placeholder', annotation: { method: 'synthetic_placeholder', annotatorRef: 'gen', modelGenerated: false } }),
  ]);
  assert.ok(r.warnings.some((w) => w.includes('混合')));
});

test('dedupeByIndependentObject：同簇/同内容只算一个独立对象', () => {
  const rows = [
    rec({ sampleId: 'A', clusterId: 'c1', contentSha256: sha('x') }),
    rec({ sampleId: 'B', clusterId: 'c1', contentSha256: sha('y') }), // 同簇去重
    rec({ sampleId: 'C', clusterId: 'c2', contentSha256: sha('x') }), // 跨簇同内容去重
    rec({ sampleId: 'D', clusterId: 'c3', contentSha256: sha('z') }),
  ];
  const { kept, excluded } = dedupeByIndependentObject(rows);
  assert.equal(kept.length, 2);
  assert.equal(excluded.length, 2);
});

test('computeGaps：按独立对象去重计数 + 依覆盖清单逐类报缺口', () => {
  // 300 条覆盖内清晰，但全部同簇 → 去重后 1
  const covered = Array.from({ length: 300 }, (_, i) =>
    rec({ sampleId: `W${i}`, task: 'weed_photo', labelClass: 'A', coverage: 'covered', quality: 'clear', clusterId: 'one', contentSha256: sha('same') }),
  );
  const gaps = computeGaps(covered, { coverageManifest: { weedPhotoCoveredClasses: ['A', 'B'] } });
  const coveredGap = gaps.find((g) => g.bucket === 'weed_photo_covered');
  assert.equal(coveredGap.present, 1);
  assert.equal(coveredGap.duplicatesExcluded, 299);
  const perClass = gaps.find((g) => g.bucket === 'weed_photo_covered_per_class');
  assert.equal(perClass.present, 0); // 承诺类 B 未到位
  assert.equal(perClass.missing, 30);
});
