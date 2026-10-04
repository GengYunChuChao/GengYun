// 样本缺口计算：对照第6节标准，统计真实（非 synthetic_placeholder）样本的到位数量。
// 只有真实样本计入 present；合成占位输入一律不计，避免用生成样本充数。

import { SAMPLE_TARGETS } from './targets.mjs';

const isReal = (r) => r && r.sourceKind !== 'synthetic_placeholder';

/** 返回每个 bucket 的 { task, bucket, required, present, missing, note }。 */
export function computeGaps(records) {
  const real = records.filter(isReal);
  const count = (predicate) => real.filter(predicate).length;

  const coveredClear = real.filter((r) => r.task === 'weed_photo' && r.coverage === 'covered' && r.quality === 'clear');
  const perClass = {};
  for (const r of coveredClear) perClass[r.labelClass] = (perClass[r.labelClass] ?? 0) + 1;
  const minClass = Object.values(perClass).length ? Math.min(...Object.values(perClass)) : 0;

  const presentByBucket = {
    weed_photo_covered: coveredClear.length,
    weed_photo_covered_per_class: minClass,
    weed_photo_out_of_coverage: count((r) => r.task === 'weed_photo' && r.coverage === 'out_of_coverage'),
    weed_photo_low_quality: count((r) => r.task === 'weed_photo' && r.quality !== 'clear'),
    label_ocr_clear: count((r) => r.task === 'label_ocr' && r.quality === 'clear'),
    label_ocr_distinct_records: new Set(
      real.filter((r) => r.task === 'label_ocr' && r.quality === 'clear').map((r) => r.gold?.registrationNumber).filter(Boolean),
    ).size,
    label_ocr_low_quality: count((r) => r.task === 'label_ocr' && r.quality !== 'clear'),
    registration_match: count((r) => r.task === 'registration_match'),
    ai_moderation_risk: count((r) => r.task === 'ai_moderation' && r.expectation === 'risk'),
    ai_moderation_normal: count((r) => r.task === 'ai_moderation' && r.expectation === 'normal'),
    tts: count((r) => r.task === 'tts'),
    asr_utterances: count((r) => r.task === 'asr'),
    asr_speakers: new Set(real.filter((r) => r.task === 'asr').map((r) => r.sourceRef).filter(Boolean)).size,
    qa_answerable: count((r) => r.task === 'qa' && r.expectation === 'answerable'),
    qa_insufficient: count((r) => r.task === 'qa' && r.expectation === 'insufficient'),
    qa_dangerous: count((r) => r.task === 'qa' && r.expectation === 'dangerous'),
    qa_injection: count((r) => r.task === 'qa' && r.expectation === 'injection'),
  };

  return SAMPLE_TARGETS.map(({ bucket, task, required, note }) => {
    const present = presentByBucket[bucket] ?? 0;
    const entry = { task, bucket, required, present, missing: Math.max(0, required - present) };
    if (bucket === 'weed_photo_covered_per_class') {
      entry.note = `${note}；当前各类计数=${JSON.stringify(perClass)}`;
    }
    return entry;
  });
}
