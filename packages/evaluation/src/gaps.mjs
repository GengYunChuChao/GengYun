// 样本缺口计算：对照第6节标准，统计真实（非 synthetic_placeholder）样本的到位数量。
// 关键口径（修复轮 1）：
//   1. 只计真实样本；合成占位输入一律不计。
//   2. 按**独立原始对象/近重复簇去重**计数，同簇裁剪或重复 contentSha256 不得充数。
//   3. 覆盖内逐类缺口须对照**冻结覆盖清单**逐类报告；缺清单不得推断逐类达标。
// 仅报告缺口，不产生任何"达标"结论——是否可主张由 evaluate.mjs 统一判定。

import { SAMPLE_TARGETS } from './targets.mjs';
import { dedupeByIndependentObject, distinctObjectCount } from './grouping.mjs';

const isReal = (r) => r && r.sourceKind !== 'synthetic_placeholder';

/**
 * 返回每个 bucket 的 { task, bucket, required, present, missing, duplicatesExcluded, note }。
 * @param {Array} records 样本索引
 * @param {object} options { coverageManifest }
 *   coverageManifest.weedPhotoCoveredClasses: 冻结覆盖清单中承诺覆盖的杂草类别数组。
 *   未提供时逐类缺口恒视为未满足（不得推断达标）。
 */
export function computeGaps(records, { coverageManifest } = {}) {
  const real = records.filter(isReal);
  // 全部真实记录先按独立对象去重，避免同源/重复充数。
  const { kept: realObjects, excluded } = dedupeByIndependentObject(real);
  const duplicatesExcluded = excluded.length;
  const count = (predicate) => distinctObjectCount(realObjects.filter(predicate));

  const coveredClear = realObjects.filter((r) => r.task === 'weed_photo' && r.coverage === 'covered' && r.quality === 'clear');
  const perClass = {};
  for (const r of coveredClear) perClass[r.labelClass] = (perClass[r.labelClass] ?? 0) + 1;

  // 逐类缺口：只对照冻结覆盖清单中的承诺类别逐类计算。
  const promisedClasses = Array.isArray(coverageManifest?.weedPhotoCoveredClasses)
    ? coverageManifest.weedPhotoCoveredClasses.filter((c) => typeof c === 'string' && c.length > 0)
    : [];
  const coverageManifestPresent = promisedClasses.length > 0;
  const perClassCounts = {};
  for (const cls of promisedClasses) perClassCounts[cls] = perClass[cls] ?? 0;
  // 清单外的类别也要列出（用于诊断），但不计入"承诺达标"。
  for (const cls of Object.keys(perClass)) if (!(cls in perClassCounts)) perClassCounts[cls] = perClass[cls];
  const minClass = coverageManifestPresent ? Math.min(...promisedClasses.map((c) => perClass[c] ?? 0)) : 0;

  const presentByBucket = {
    weed_photo_covered: coveredClear.length,
    weed_photo_covered_per_class: minClass,
    weed_photo_out_of_coverage: count((r) => r.task === 'weed_photo' && r.coverage === 'out_of_coverage'),
    weed_photo_low_quality: count((r) => r.task === 'weed_photo' && r.quality !== 'clear'),
    label_ocr_clear: count((r) => r.task === 'label_ocr' && r.quality === 'clear'),
    label_ocr_distinct_records: new Set(
      realObjects.filter((r) => r.task === 'label_ocr' && r.quality === 'clear').map((r) => r.gold?.registrationNumber).filter(Boolean),
    ).size,
    label_ocr_low_quality: count((r) => r.task === 'label_ocr' && r.quality !== 'clear'),
    registration_match: count((r) => r.task === 'registration_match'),
    ai_moderation_risk: count((r) => r.task === 'ai_moderation' && r.expectation === 'risk'),
    ai_moderation_normal: count((r) => r.task === 'ai_moderation' && r.expectation === 'normal'),
    tts: count((r) => r.task === 'tts'),
    asr_utterances: count((r) => r.task === 'asr'),
    asr_speakers: new Set(realObjects.filter((r) => r.task === 'asr').map((r) => r.sourceRef).filter(Boolean)).size,
    qa_answerable: count((r) => r.task === 'qa' && r.expectation === 'answerable'),
    qa_insufficient: count((r) => r.task === 'qa' && r.expectation === 'insufficient'),
    qa_dangerous: count((r) => r.task === 'qa' && r.expectation === 'dangerous'),
    qa_injection: count((r) => r.task === 'qa' && r.expectation === 'injection'),
  };

  return SAMPLE_TARGETS.map(({ bucket, task, required, note }) => {
    const present = presentByBucket[bucket] ?? 0;
    const entry = {
      task,
      bucket,
      required,
      present,
      missing: Math.max(0, required - present),
      duplicatesExcluded,
    };
    if (bucket === 'weed_photo_covered_per_class') {
      entry.coverageManifestPresent = coverageManifestPresent;
      entry.promisedClasses = promisedClasses;
      entry.note = coverageManifestPresent
        ? `${note}；承诺覆盖类=${JSON.stringify(promisedClasses)}，逐类计数=${JSON.stringify(perClassCounts)}`
        : `${note}；缺少冻结覆盖清单，逐类达标不可推断（按未满足计）`;
    } else {
      entry.note = note;
    }
    return entry;
  });
}
