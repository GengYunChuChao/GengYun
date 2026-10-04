// 冻结清单校验与预测完整性校验（修复轮 1）。
// 目标：最终验收只认"经冻结清单校验的独立 test 集"，且预测必须完整、结构合法、可对应索引。
// 来源标签（sourceKind）或手填版本号**不能**代替冻结清单校验。

import { createHash } from 'node:crypto';
import { originalOcrFields, originalAsrOutput, isObject, WEED_DECISIONS } from './metrics.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** 计算一组记录（保持给定顺序）的规范化 SHA-256。 */
export function computeRecordsSha256(records) {
  return sha256(JSON.stringify(records));
}

/**
 * 校验冻结清单是否真的对应给定 test 集。
 * 清单字段：{ manifestVersion, indexVersion, split:'test', recordCount, indexSha256, frozenAt }。
 * 返回 { verified, reasons, computedSha256, manifestSha256 }。
 */
export function verifyFrozenManifest(manifest, testRecords) {
  const reasons = [];
  const computedSha256 = computeRecordsSha256(testRecords);
  if (!isObject(manifest)) {
    return { verified: false, reasons: ['缺少冻结清单：未提供经核实的冻结清单，不得主张真实评估'], computedSha256, manifestSha256: null };
  }
  if (manifest.split !== 'test') reasons.push(`冻结清单 split 必须为 test（当前 ${manifest.split ?? '未填写'}）`);
  if (typeof manifest.indexVersion !== 'string' || manifest.indexVersion.trim() === '') reasons.push('冻结清单缺 indexVersion');
  if (typeof manifest.frozenAt !== 'string' || manifest.frozenAt.trim() === '') reasons.push('冻结清单缺 frozenAt（冻结时间）');
  if (manifest.recordCount !== testRecords.length) reasons.push(`冻结清单 recordCount=${manifest.recordCount} 与实际 test 集 ${testRecords.length} 不一致`);
  if (manifest.indexSha256 !== computedSha256) reasons.push('冻结清单 indexSha256 与实际 test 集内容不一致（冻结集被改动或清单未核实）');
  return {
    verified: reasons.length === 0,
    reasons,
    computedSha256,
    manifestSha256: sha256(JSON.stringify(manifest)),
  };
}

/**
 * 单条预测的结构/失败标记校验。
 * 返回 { ok, reason }：ok=false 表示该预测不可用于评分（缺失/结构非法/服务失败）。
 * 注意：`decision=uncertain` 等拒识是**合法结果**，不是失败；这里只看结构完整性与失败标记。
 */
export function validatePredictionOutput(task, output) {
  if (!isObject(output)) return { ok: false, reason: '预测缺失或非对象' };
  if (output.error !== undefined && output.error !== null) return { ok: false, reason: '预测标注 error（服务失败）' };
  if (output.failed === true) return { ok: false, reason: '预测 failed=true（服务失败）' };
  if (output.served === false) return { ok: false, reason: '预测 served=false（未实际测量）' };

  switch (task) {
    case 'weed_photo':
      if (!Array.isArray(output.candidates)) return { ok: false, reason: '缺少 candidates 数组' };
      if (!WEED_DECISIONS.includes(output.decision)) return { ok: false, reason: `缺少合法最终 decision（需 ${WEED_DECISIONS.join('/')}）` };
      return { ok: true };
    case 'label_ocr':
      if (originalOcrFields({ output }) === null) return { ok: false, reason: '缺少原始模型 fields（校正稿不得冒充）' };
      return { ok: true };
    case 'registration_match':
      if (typeof output.status !== 'string') return { ok: false, reason: '缺少 status' };
      return { ok: true };
    case 'ai_moderation':
      if (typeof output.decision !== 'string') return { ok: false, reason: '缺少 decision' };
      return { ok: true };
    case 'tts':
      if (['numbersCorrect', 'unitsCorrect', 'negationCorrect', 'conditionsCorrect'].some((k) => typeof output[k] !== 'boolean')) {
        return { ok: false, reason: '缺少 TTS 布尔判定字段' };
      }
      return { ok: true };
    case 'asr':
      if (originalAsrOutput({ output }).hypothesis === null) return { ok: false, reason: '缺少原始转写 hypothesis（校正稿不得冒充）' };
      return { ok: true };
    case 'qa':
      return { ok: true };
    default:
      return { ok: false, reason: `未知 task=${task}` };
  }
}

/**
 * 预测覆盖与结构校验：对照 test 集逐条检查 ID 对应、结构合法。
 * 返回 { expected, present, missing, invalid, extra, byTask, complete }。
 */
export function validatePredictionCoverage(testRecords, predictions) {
  const expectedIds = new Set(testRecords.map((r) => r.sampleId));
  const missing = [];
  const invalid = [];
  const byTask = {};

  for (const r of testRecords) {
    const bucket = (byTask[r.task] ??= { expected: 0, present: 0, missing: 0, invalid: 0 });
    bucket.expected += 1;
    const output = predictions.get(r.sampleId);
    if (output === undefined) {
      missing.push(r.sampleId);
      bucket.missing += 1;
      continue;
    }
    const check = validatePredictionOutput(r.task, output);
    if (!check.ok) {
      invalid.push({ sampleId: r.sampleId, task: r.task, reason: check.reason });
      bucket.invalid += 1;
      continue;
    }
    bucket.present += 1;
  }

  const extra = [];
  for (const id of predictions.keys()) if (!expectedIds.has(id)) extra.push(id);

  const complete = missing.length === 0 && invalid.length === 0;
  return {
    expected: expectedIds.size,
    present: expectedIds.size - missing.length - invalid.length,
    missing,
    invalid,
    extra,
    byTask,
    complete,
  };
}
