// 评估编排：读入脱敏索引 + 模型/规则输出，计算指标、门禁状态与缺口，产出结构化报告。
// 关键安全语义：dataKind 非 real_frozen 或样本未达第6节目标时，isRealEvaluation=false，
// 所有门禁 claimable=false，状态保持 not_evaluated——不得把合成/占位/不足输入写成"通过"。

import { createHash } from 'node:crypto';
import { SCORERS } from './metrics.mjs';
import { computeGaps } from './gaps.mjs';
import { wilsonInterval } from './ci.mjs';

export const REPORT_SCHEMA_VERSION = '1.0.0';

const at = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
const minFieldExact = (m) => {
  const values = Object.values(m.fieldExact ?? {}).map((r) => r.p).filter((v) => v !== null);
  return values.length ? Math.min(...values) : null;
};

// 指标名 -> 从评分结果取观测值的函数（返回数字或 null）。
const GATE_VALUE = {
  top1: (m) => m.top1?.p,
  top3: (m) => m.top3?.p,
  outOfCoverageHighConfidenceRate: (m) => m.outOfCoverageHighConfidenceRate?.p,
  lowQualityUncertainRate: (m) => m.lowQualityUncertainRate?.p,
  registrationNumberExact: (m) => m.registrationNumberExact?.p,
  fieldExact: minFieldExact,
  scenarioPass: (m) => m.scenarioPass?.p,
  riskRecall: (m) => m.riskRecall?.p,
  normalFalseIsolationRate: (m) => m.normalFalseIsolationRate?.p,
  ttsAllCorrect: (m) => m.ttsAllCorrect?.p,
  cer: (m) => m.cer?.p,
  keyFieldExact: (m) => m.keyFieldExact?.p,
  answerableCorrectWithSource: (m) => m.answerableCorrectWithSource?.p,
  expectedBehaviorPass: (m) => m.expectedBehaviorPass?.p,
};

/** 由目标定义构造某 task 的门禁列表。 */
export function buildGates(task, metrics, gateDefs, claimable) {
  return gateDefs
    .filter((g) => g.task === task)
    .map((g) => {
      const observed = GATE_VALUE[g.metric] ? GATE_VALUE[g.metric](metrics) : null;
      let pass = null;
      if (observed !== null && Number.isFinite(observed)) {
        if (g.direction === 'gte') pass = observed >= g.target - 1e-9;
        else if (g.direction === 'lte') pass = observed <= g.target + 1e-9;
        else pass = Math.abs(observed - g.target) <= 1e-9;
      }
      let status;
      let reason;
      if (!claimable) {
        status = 'not_evaluated';
        reason = 'synthetic 或样本未达第6节目标/存在缺口，不得声称达标';
      } else if (pass === null) {
        status = 'not_evaluated';
        reason = '无可用观测值';
      } else {
        status = pass ? 'pass' : 'fail';
      }
      return { metric: g.metric, observed, target: g.target, direction: g.direction, status, claimable, reason, note: g.note };
    });
}

/**
 * 主入口。
 * @param {Array} records 脱敏样本索引（含 gold）
 * @param {Map<string, object>} predictions sampleId -> 模型/规则输出
 * @param {object} options { gateDefs, frozenIndexVersion, seed }
 */
export function evaluateRun(records, predictions, options = {}) {
  const {
    gateDefs,
    frozenIndexVersion = 'unfrozen',
    seed = 20261004,
    generatedAt = new Date().toISOString(),
  } = options;
  const warnings = [];

  const syntheticCount = records.filter((r) => r.sourceKind === 'synthetic_placeholder').length;
  const dataKind = syntheticCount === 0 ? 'real_frozen' : syntheticCount === records.length ? 'synthetic_placeholder' : 'mixed';

  const gaps = computeGaps(records);
  const gapsSatisfied = gaps.every((g) => g.missing === 0);

  // 覆盖内逐类门槛：每个承诺覆盖的杂草至少30张，用缺口桶结果判定。
  const perClassGap = gaps.find((g) => g.bucket === 'weed_photo_covered_per_class');
  const perClassSatisfied = !perClassGap || perClassGap.missing === 0;

  const isRealEvaluation = dataKind === 'real_frozen' && gapsSatisfied && perClassSatisfied;
  if (dataKind !== 'real_frozen') warnings.push('输入含 synthetic_placeholder：仅验证程序可运行，不构成真实评估。');
  if (!gapsSatisfied) warnings.push('真实样本数量未达第6节标准，评估未完成，不得标记达标。');

  const tasks = {};
  for (const task of Object.keys(SCORERS)) {
    const pairs = records
      .filter((r) => r.task === task)
      .map((record) => ({ record, output: predictions.get(record.sampleId) ?? null }));
    const metrics = SCORERS[task](pairs, { seed });
    const gates = buildGates(task, metrics, gateDefs, isRealEvaluation);
    const hasFail = gates.some((g) => g.status === 'fail');
    const allPass = gates.length > 0 && gates.every((g) => g.status === 'pass');
    const gateStatus = !isRealEvaluation ? 'not_evaluated' : hasFail ? 'fail' : allPass ? 'pass' : 'not_evaluated';
    tasks[task] = { sampleCount: pairs.length, metrics, gates, gateStatus };
  }

  const indexSha256 = createHash('sha256').update(JSON.stringify(records)).digest('hex');
  const predictionSha256 = createHash('sha256')
    .update(JSON.stringify([...predictions.entries()].sort((a, b) => a[0].localeCompare(b[0]))))
    .digest('hex');

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    dataKind,
    isRealEvaluation,
    generatedAt,
    indexSha256,
    predictionSha256,
    frozenIndexVersion,
    tasks,
    gaps,
    warnings,
  };
}

export { wilsonInterval, at };
