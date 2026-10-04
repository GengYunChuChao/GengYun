// 样本索引校验（仅 Node 标准库，不引入 ajv）。
// 覆盖 sample.schema.json 的必填/枚举/格式约束，以及第6节硬红线：
// 标准答案不得由模型生成、原始媒体不得提交、同源近重复不得跨 split。

import { splitIsolationErrors } from './grouping.mjs';

export const TASKS = ['weed_photo', 'label_ocr', 'registration_match', 'ai_moderation', 'tts', 'asr', 'qa'];
export const SPLITS = ['train', 'validation', 'test'];
export const SOURCE_KINDS = ['real_collected', 'real_third_party_licensed', 'database_record', 'synthetic_placeholder'];
export const QUALITIES = ['clear', 'blurry', 'occluded', 'dark', 'target_too_small', 'reflective', 'bent', 'field_missing'];
export const ANNOTATION_METHODS = ['reliable_label', 'independent_verification', 'expert_transcription', 'cross_checked_original', 'synthetic_placeholder'];

const HEX64 = /^[a-f0-9]{64}$/;
const HEX16 = /^[a-f0-9]{16}$/;

function requireString(errors, value, field, id) {
  if (typeof value !== 'string' || value.trim() === '') errors.push(`${id}: 缺少或非法的 ${field}`);
}

/** 校验单条记录；返回错误字符串数组。 */
export function validateSample(record, index = -1) {
  const errors = [];
  const id = record && typeof record.sampleId === 'string' ? record.sampleId : `#${index}`;
  if (!record || typeof record !== 'object') return [`#${index}: 记录不是对象`];

  if (record.schemaVersion !== '1.0.0') errors.push(`${id}: schemaVersion 必须为 1.0.0`);
  requireString(errors, record.sampleId, 'sampleId', id);
  requireString(errors, record.clusterId, 'clusterId', id);
  if (!TASKS.includes(record.task)) errors.push(`${id}: 非法 task=${record.task}`);
  if (!SPLITS.includes(record.split)) errors.push(`${id}: 非法 split=${record.split}`);
  if (!SOURCE_KINDS.includes(record.sourceKind)) errors.push(`${id}: 非法 sourceKind=${record.sourceKind}`);
  if (!QUALITIES.includes(record.quality)) errors.push(`${id}: 非法 quality=${record.quality}`);
  if (record.coverage !== 'covered' && record.coverage !== 'out_of_coverage') errors.push(`${id}: 非法 coverage=${record.coverage}`);
  if (!HEX64.test(record.contentSha256 ?? '')) errors.push(`${id}: contentSha256 必须为 64 位小写 hex`);
  if (record.perceptualHash !== undefined && !HEX16.test(record.perceptualHash)) errors.push(`${id}: perceptualHash 必须为 16 位小写 hex`);
  if (record.rawMediaSha256 !== undefined && !HEX64.test(record.rawMediaSha256)) errors.push(`${id}: rawMediaSha256 必须为 64 位小写 hex`);
  requireString(errors, record.sourceRef, 'sourceRef', id);
  requireString(errors, record.labelClass, 'labelClass', id);

  // 硬红线 2：原始私有样本不提交
  if (record.rawMediaCommitted !== false) errors.push(`${id}: rawMediaCommitted 必须为 false（原始私有媒体不提交 Git）`);

  // 硬红线 3：模型不得作为自己的标准答案
  const ann = record.annotation;
  if (!ann || typeof ann !== 'object') {
    errors.push(`${id}: 缺少 annotation`);
  } else {
    if (!ANNOTATION_METHODS.includes(ann.method)) errors.push(`${id}: 非法 annotation.method=${ann.method}`);
    if (ann.modelGenerated !== false) errors.push(`${id}: annotation.modelGenerated 必须为 false（禁止模型自答）`);
    requireString(errors, ann.annotatorRef, 'annotation.annotatorRef', id);
  }

  if (record.gold === undefined || record.gold === null || typeof record.gold !== 'object') {
    errors.push(`${id}: 缺少 gold 标准答案`);
  }
  return errors;
}

/** 校验整个索引（数组）。返回 { ok, errors, warnings, stats }。 */
export function validateSampleIndex(records, { hammingThreshold } = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(records)) return { ok: false, errors: ['索引根必须是数组'], warnings, stats: null };

  const seen = new Set();
  records.forEach((record, i) => {
    errors.push(...validateSample(record, i));
    if (record && typeof record.sampleId === 'string') {
      if (seen.has(record.sampleId)) errors.push(`${record.sampleId}: sampleId 重复`);
      seen.add(record.sampleId);
    }
    if (record?.sourceKind === 'synthetic_placeholder' && record?.annotation?.method !== 'synthetic_placeholder') {
      warnings.push(`${record.sampleId}: synthetic_placeholder 来源应同时使用 annotation.method=synthetic_placeholder`);
    }
  });

  const wellFormed = records.filter((r) => r && typeof r.sampleId === 'string' && typeof r.clusterId === 'string');
  if (wellFormed.length === records.length) {
    errors.push(...splitIsolationErrors(records, { hammingThreshold }));
  }

  const dataKinds = new Set(records.map((r) => r?.sourceKind));
  if (dataKinds.has('synthetic_placeholder') && dataKinds.size > 1) {
    warnings.push('索引混合了 synthetic_placeholder 与真实来源，评估必须按真实样本单独重算');
  }

  const stats = {
    total: records.length,
    byTask: {},
    bySplit: {},
    bySourceKind: {},
    synthetic: records.filter((r) => r?.sourceKind === 'synthetic_placeholder').length,
  };
  for (const r of records) {
    if (!r) continue;
    stats.byTask[r.task] = (stats.byTask[r.task] ?? 0) + 1;
    stats.bySplit[r.split] = (stats.bySplit[r.split] ?? 0) + 1;
    stats.bySourceKind[r.sourceKind] = (stats.bySourceKind[r.sourceKind] ?? 0) + 1;
  }
  return { ok: errors.length === 0, errors, warnings, stats };
}
