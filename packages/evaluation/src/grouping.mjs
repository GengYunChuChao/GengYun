// 近重复排除与训练/验证/测试隔离。
// 规约（第6.1节）：同一原图裁剪、连拍或近重复不能同时进入训练与测试；
// 记录每类与拒识样本；原始私有样本不提交 Git。

import { levenshtein } from './ci.mjs';

/** 两个 64 位 hex 感知哈希的汉明距离。 */
export function hammingDistanceHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return null;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = parseInt(a[i], 16);
    const y = parseInt(b[i], 16);
    if (Number.isNaN(x) || Number.isNaN(y)) return null;
    let v = x ^ y;
    while (v) {
      distance += v & 1;
      v >>= 1;
    }
  }
  return distance;
}

export const DEFAULT_HAMMING_THRESHOLD = 8; // 64 位 dHash 常用近重复阈值

/**
 * 显式簇 + 感知哈希近重复检测。
 * 返回 { clusters: Map<clusterId, sampleIds[]>, nearDuplicates: [{a,b,distance}], splitSpans }
 */
export function analyzeClusters(records, { hammingThreshold = DEFAULT_HAMMING_THRESHOLD } = {}) {
  const clusters = new Map();
  for (const r of records) {
    if (!clusters.has(r.clusterId)) clusters.set(r.clusterId, []);
    clusters.get(r.clusterId).push(r.sampleId);
  }

  const nearDuplicates = [];
  const byHash = records.filter((r) => typeof r.perceptualHash === 'string');
  for (let i = 0; i < byHash.length; i += 1) {
    for (let j = i + 1; j < byHash.length; j += 1) {
      if (byHash[i].task !== byHash[j].task) continue;
      const d = hammingDistanceHex(byHash[i].perceptualHash, byHash[j].perceptualHash);
      if (d !== null && d <= hammingThreshold) {
        nearDuplicates.push({ a: byHash[i].sampleId, b: byHash[j].sampleId, distance: d });
      }
    }
  }

  const spanByCluster = new Map();
  for (const r of records) {
    const set = spanByCluster.get(r.clusterId) ?? new Set();
    set.add(r.split);
    spanByCluster.set(r.clusterId, set);
  }
  return { clusters, nearDuplicates, spanByCluster };
}

/**
 * 隔离校验：同簇（显式 clusterId 或连拍 seriesId）不得跨 split；
 * 感知哈希近重复的两条样本必须同簇且同 split。
 * 返回错误数组（空=通过）。
 */
export function splitIsolationErrors(records, { hammingThreshold = DEFAULT_HAMMING_THRESHOLD } = {}) {
  const errors = [];
  const { nearDuplicates, spanByCluster } = analyzeClusters(records, { hammingThreshold });
  const byId = new Map(records.map((r) => [r.sampleId, r]));

  for (const [clusterId, splits] of spanByCluster) {
    if (splits.size > 1) {
      errors.push(`近重复簇 ${clusterId} 跨 split：${[...splits].sort().join('/')}（同源裁剪/连拍不得跨训练与测试）`);
    }
  }

  // 连拍：同一 captureSeriesId 必须映射到同一 clusterId 与同一 split。
  const series = new Map();
  for (const r of records) {
    if (!r.captureSeriesId) continue;
    if (!series.has(r.captureSeriesId)) series.set(r.captureSeriesId, []);
    series.get(r.captureSeriesId).push(r);
  }
  for (const [seriesId, rows] of series) {
    const clusters = new Set(rows.map((r) => r.clusterId));
    const splits = new Set(rows.map((r) => r.split));
    if (clusters.size > 1) errors.push(`连拍系列 ${seriesId} 跨多个近重复簇，应同簇`);
    if (splits.size > 1) errors.push(`连拍系列 ${seriesId} 跨 split：${[...splits].sort().join('/')}`);
  }

  for (const dup of nearDuplicates) {
    const a = byId.get(dup.a);
    const b = byId.get(dup.b);
    if (a.clusterId !== b.clusterId) {
      errors.push(`感知近重复 ${a.sampleId}~${b.sampleId}(距离${dup.distance}) 不同簇，需合并或人工确认`);
    }
  }

  // 文本类重复：同 task 内标准答案文本完全相同视为近重复，必须同 split。
  const byText = new Map();
  for (const r of records) {
    if (r.task !== 'qa' && r.task !== 'asr') continue;
    const key = `${r.task}::${JSON.stringify(r.gold ?? {})}`;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(r);
  }
  for (const rows of byText.values()) {
    if (rows.length > 1) {
      const splits = new Set(rows.map((r) => r.split));
      if (splits.size > 1) {
        errors.push(`同文本样本 ${rows.map((r) => r.sampleId).join(',')} 跨 split，需去重或同 split`);
      }
    }
  }

  return errors;
}

/** 拒识样本统计：按 task 与 expected reject/uncertain 计数。 */
export function rejectionCounts(records) {
  const out = {};
  for (const r of records) {
    const key = r.task;
    out[key] ??= { total: 0, rejectExpected: 0 };
    out[key].total += 1;
    if (r.expectation === 'reject') out[key].rejectExpected += 1;
  }
  return out;
}

export { levenshtein };
