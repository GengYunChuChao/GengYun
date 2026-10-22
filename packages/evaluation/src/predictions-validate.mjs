// 预测文件结构契约校验（仅 Node 标准库，不引入 ajv；与 schema/predictions.schema.json 同源）。
//
// 为什么需要这一层：7 个任务的预测字段形状原本只存在于
//   `tests/evaluation/fixtures/synthetic-predictions.json` 与 `src/metrics.mjs` 的读取代码里，
//   没有任何机器可校验的声明；预测文件缺字段时 `metrics.mjs` 只会**少算**（字段缺失 → 该项永不命中），
//   于是"模型没给这个字段"与"模型给错了"在报告里不可区分。本模块把形状变成可失败的入口校验：
//   预测不合契约即在评估前以非 0 退出，并**点名** sampleId / task / 缺哪个字段。
//
// 三处口径必须一致，改动请一起改：
//   1) `schema/predictions.schema.json`（契约声明，`x-taskShapes` 是按任务的权威绑定）；
//   2) 本文件的 `validatePredictionShape()`（执行体）；
//   3) `src/frozen.mjs` 的 `validatePredictionOutput()`（评分期的同口径结构校验，只判"可用于评分"）。
//   一致性由 `tests/evaluation/predictions-contract.test.mjs` 的漂移守卫断言（required 字段与闭集枚举逐一比对）。
//
// 边界（刻意不做的判断）：
//   - **服务失败不算契约违规**：`error` 非空 / `failed=true` / `served=false` 的条目按"服务失败"跳过形状校验，
//     由报告如实记为 invalid、门禁保持 not_evaluated（见 frozen.mjs:validatePredictionOutput 的判定顺序）。
//     否则一次批量超时就会让整条命令失败、连缺口读数都拿不到。
//   - **缺失预测不算契约违规**：只校验文件里实际给出的条目；缺哪些 sampleId 属于报告里的完整性口径。
//   - **索引外的多余预测不校验形状**：任务未知，无从按任务比对（报告已记 `extra` 并在警告中提示）。

import { isObject, WEED_DECISIONS, MODERATION_DECISIONS, TTS_JUDGEMENT_FIELDS } from './metrics.mjs';

/** 契约文件路径（相对仓库根）。报错时原样告知用户去哪看。 */
export const PREDICTIONS_SCHEMA_PATH = 'packages/evaluation/schema/predictions.schema.json';

/** 契约版本（对应 schema 的 `$id` 末段）。 */
export const PREDICTIONS_SCHEMA_ID = 'https://gengyun.local/schema/evaluation-predictions-1.0.0.json';

/** 标签 OCR 固定可见字段集（与 metrics.mjs 的 OCR_FIELDS 同口径）。 */
export const OCR_FIELD_NAMES = ['registrationNumber', 'name', 'ingredient', 'content', 'dosageForm'];

/** ASR 关键字段集（metrics.mjs:asrMetrics 逐项统计的三个字段）。 */
export const ASR_KEY_FIELDS = ['drugNames', 'numbers', 'units'];

/**
 * 按任务的必需字段/闭集声明（schema 的 `$defs.<task>.required` 与 enum 的执行体镜像）。
 * `required`：无条件下必须出现的字段；`anyOfRequired`：多选一的必需字段组（如 qa 两类样本、校正稿）。
 * 漂移守卫测试逐项比对本表与 schema，两边不同即红。
 */
export const PREDICTION_TASK_SHAPES = {
  weed_photo: { schemaDef: 'weed_photo', required: ['candidates', 'decision'], decisionEnum: WEED_DECISIONS },
  label_ocr: { schemaDef: 'label_ocr', required: [], anyOfRequired: [['fields'], ['corrected', 'originalFields']] },
  registration_match: { schemaDef: 'registration_match', required: ['status'] },
  ai_moderation: { schemaDef: 'ai_moderation', required: ['decision'], decisionEnum: MODERATION_DECISIONS },
  tts: { schemaDef: 'tts', required: [...TTS_JUDGEMENT_FIELDS] },
  asr: { schemaDef: 'asr', required: [], anyOfRequired: [['hypothesis'], ['corrected', 'originalHypothesis']] },
  qa: { schemaDef: 'qa', required: [], anyOfRequired: [['correct', 'sourceSupported'], ['expectedBehaviorOk']] },
};

/** 服务失败标记：与 frozen.mjs:validatePredictionOutput 的前置判断同口径、同优先级。 */
export function isServiceFailurePrediction(output) {
  if (!isObject(output)) return false;
  if (output.error !== undefined && output.error !== null) return true;
  if (output.failed === true) return true;
  if (output.served === false) return true;
  return false;
}

/** 字段类型说明，用于报错。 */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value === 'object' ? '对象' : typeof value;
}

/** 字段是否"实际给出"（undefined 视为缺失；null 视为显式给出但类型待判）。 */
const given = (value) => value !== undefined;

/**
 * 校验单条预测的结构（不看服务失败标记——那是调用方的前置判断）。
 * @param {string} task 任务名（取自样本索引记录的 task）
 * @param {object} output 该 sampleId 的原始模型输出
 * @returns {{ ok: boolean, reasons: string[] }} reasons 为中文原因，点名缺哪个字段/哪个值非法
 */
export function validatePredictionShape(task, output) {
  const shape = PREDICTION_TASK_SHAPES[task];
  if (!shape) return { ok: false, reasons: [`未知 task=${task}（契约只覆盖 ${Object.keys(PREDICTION_TASK_SHAPES).join('/')}）`] };
  if (!isObject(output)) return { ok: false, reasons: [`预测必须是对象，实际为 ${describe(output)}`] };

  const reasons = [];

  // 1) 无条件必需字段。
  for (const field of shape.required) {
    if (!given(output[field])) reasons.push(`缺少必需字段 ${field}`);
  }

  // 2) 多选一的必需字段组：只要有一组齐全就通过；全都不齐则点名每一组缺什么。
  if (Array.isArray(shape.anyOfRequired)) {
    const satisfied = shape.anyOfRequired.some((group) => group.every((field) => given(output[field])));
    if (!satisfied) {
      const groups = shape.anyOfRequired.map((group) => `{${group.join(' + ')}}（缺 ${group.filter((f) => !given(output[f])).join('、') || '无'}）`);
      reasons.push(`缺少必需字段组：需要以下任一组，均不齐 —— ${groups.join(' 或 ')}`);
    }
  }

  // 3) 按任务的具体类型/闭集（只判已给出的字段，缺失已在上两步点名）。
  switch (task) {
    case 'weed_photo': {
      if (given(output.candidates) && !Array.isArray(output.candidates)) {
        reasons.push(`字段 candidates 应为数组，实际为 ${describe(output.candidates)}`);
      } else if (Array.isArray(output.candidates)) {
        output.candidates.forEach((c, i) => {
          if (!isObject(c)) {
            reasons.push(`candidates[${i}] 应为对象，实际为 ${describe(c)}`);
            return;
          }
          if (typeof c.speciesId !== 'string' || c.speciesId.trim() === '') {
            reasons.push(`candidates[${i}].speciesId 应为非空字符串（GY-I03 规范物种 ID）`);
          }
          if (given(c.confidence) && (typeof c.confidence !== 'number' || Number.isNaN(c.confidence) || c.confidence < 0 || c.confidence > 1)) {
            reasons.push(`candidates[${i}].confidence 应为 [0,1] 区间数字，实际为 ${JSON.stringify(c.confidence)}`);
          }
        });
      }
      if (given(output.decision) && !WEED_DECISIONS.includes(output.decision)) {
        reasons.push(`字段 decision 非法：${JSON.stringify(output.decision)}（需 ${WEED_DECISIONS.join('/')} 之一）`);
      }
      break;
    }
    case 'label_ocr': {
      if (given(output.corrected) && typeof output.corrected !== 'boolean') reasons.push('字段 corrected 应为布尔值');
      for (const key of ['fields', 'originalFields', 'correctedFields']) {
        if (!given(output[key])) continue;
        if (!isObject(output[key])) {
          reasons.push(`字段 ${key} 应为对象，实际为 ${describe(output[key])}`);
          continue;
        }
        for (const field of OCR_FIELD_NAMES) {
          const v = output[key][field];
          if (v !== undefined && v !== null && typeof v !== 'string') {
            reasons.push(`字段 ${key}.${field} 应为字符串或 null，实际为 ${describe(v)}`);
          }
        }
      }
      break;
    }
    case 'registration_match': {
      if (given(output.status) && (typeof output.status !== 'string' || output.status.trim() === '')) {
        reasons.push('字段 status 应为非空字符串（须与样本 gold.expectedStatus 同域）');
      }
      break;
    }
    case 'ai_moderation': {
      if (given(output.decision) && !MODERATION_DECISIONS.includes(output.decision)) {
        // unknown/服务错误/非法枚举都不属于正常通过：这里必须拒绝，而不是留到评分期当误隔离。
        reasons.push(`字段 decision 非法：${JSON.stringify(output.decision)}（需 ${MODERATION_DECISIONS.join('/')} 之一）`);
      }
      break;
    }
    case 'tts': {
      for (const field of TTS_JUDGEMENT_FIELDS) {
        if (!given(output[field])) {
          // 已在必需字段处点名，这里补上"为什么缺失不能默认成功"的语义。
          continue;
        }
        if (typeof output[field] !== 'boolean') {
          reasons.push(`字段 ${field} 应为布尔值（TTS 六项判定缺一不可，不得以 ${describe(output[field])} 代替）`);
        }
      }
      break;
    }
    case 'asr': {
      for (const key of ['hypothesis', 'originalHypothesis']) {
        if (given(output[key]) && typeof output[key] !== 'string') reasons.push(`字段 ${key} 应为字符串，实际为 ${describe(output[key])}`);
      }
      if (given(output.corrected) && typeof output.corrected !== 'boolean') reasons.push('字段 corrected 应为布尔值');
      for (const key of ['keyFieldsExact', 'originalKeyFieldsExact']) {
        if (!given(output[key])) continue;
        if (!isObject(output[key])) {
          reasons.push(`字段 ${key} 应为对象，实际为 ${describe(output[key])}`);
          continue;
        }
        for (const field of ASR_KEY_FIELDS) {
          const v = output[key][field];
          if (v !== undefined && typeof v !== 'boolean') reasons.push(`字段 ${key}.${field} 应为布尔值，实际为 ${describe(v)}`);
        }
      }
      break;
    }
    case 'qa': {
      if (given(output.status) && (typeof output.status !== 'string' || output.status.trim() === '')) reasons.push('字段 status 应为非空字符串');
      for (const field of ['correct', 'sourceSupported', 'expectedBehaviorOk']) {
        if (given(output[field]) && typeof output[field] !== 'boolean') reasons.push(`字段 ${field} 应为布尔值，实际为 ${describe(output[field])}`);
      }
      break;
    }
    default:
      break;
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * 校验整份预测（按索引记录的任务逐条比对）。
 * @param {Array} records 样本索引（须含 sampleId/task；只校验文件中出现的 sampleId）
 * @param {Map<string, object>} predictions sampleId -> 原始模型输出
 * @returns {{ ok, errors, checked, skippedServiceFailure, extraIds }}
 *   errors: [{ sampleId, task, reasons: string[] }]；checked=真正做了形状比对的条数。
 */
export function validatePredictions(records, predictions) {
  const taskBySampleId = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (r && typeof r.sampleId === 'string' && typeof r.task === 'string') taskBySampleId.set(r.sampleId, r.task);
  }
  const errors = [];
  const extraIds = [];
  let checked = 0;
  let skippedServiceFailure = 0;

  const entries = predictions instanceof Map ? [...predictions.entries()] : Object.entries(predictions ?? {});
  for (const [sampleId, output] of entries) {
    const task = taskBySampleId.get(sampleId);
    if (!task) {
      extraIds.push(sampleId);
      continue;
    }
    if (isServiceFailurePrediction(output)) {
      skippedServiceFailure += 1;
      continue;
    }
    checked += 1;
    const result = validatePredictionShape(task, output);
    if (!result.ok) errors.push({ sampleId, task, reasons: result.reasons });
  }

  return { ok: errors.length === 0, errors, checked, skippedServiceFailure, extraIds };
}

/**
 * 人类可读的中文报错块（CLI 直接写 stderr 用）。
 * @param {{errors: Array}} result validatePredictions() 的返回值
 * @param {{ limit?: number }} options limit=最多逐条列出多少条（其余汇总，避免刷屏）
 */
export function formatPredictionContractErrors(result, { limit = 20 } = {}) {
  const { errors } = result;
  const lines = [`预测不合结构契约（${PREDICTIONS_SCHEMA_PATH}），共 ${errors.length} 条：`];
  for (const e of errors.slice(0, limit)) {
    lines.push(`  - ${e.sampleId}（${e.task}）: ${e.reasons.join('；')}`);
  }
  if (errors.length > limit) lines.push(`  … 另有 ${errors.length - limit} 条同类错误未逐条列出（完整明细见报告的 predictionEvidence.invalid）`);
  return lines.join('\n');
}
