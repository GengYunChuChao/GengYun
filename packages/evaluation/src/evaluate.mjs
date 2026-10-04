// 评估编排：读入脱敏索引 + 模型/规则输出，计算指标、门禁状态与缺口，产出结构化报告。
// 关键安全语义（修复轮 1 强化）：
//   1. 最终验收**只使用经冻结清单校验的独立 test 集**；来源标签或手填版本号不能代替冻结清单。
//   2. 训练/验证样本另列统计，不参与最终评分。
//   3. 评分与计数**按独立对象去重**（同簇裁剪/连拍/重复 hash 不重复计分）。
//   4. 预测必须完整、结构合法、与索引 ID 对应；缺失/非法保留 not_evaluated 与缺口，不当成功。
//   5. 承诺覆盖清单必须**绑定进经核实的冻结清单**并与外部清单一致；缩减/修改一律拒绝（变化须新冻结版本）。
//   6. 任一条件不满足即 isRealEvaluation=false、全部门禁 claimable=false、状态保持 not_evaluated，
//      绝不把合成/占位/不足/未冻结/预测缺失的输入写成"通过"。

import { createHash } from 'node:crypto';
import { SCORERS } from './metrics.mjs';
import { computeGaps } from './gaps.mjs';
import { wilsonInterval } from './ci.mjs';
import { dedupeByIndependentObject } from './grouping.mjs';
import { verifyFrozenManifest, verifyCoverageBinding, validatePredictionCoverage, validatePredictionOutput, computeRecordsSha256 } from './frozen.mjs';

export const REPORT_SCHEMA_VERSION = '1.0.0';

const at = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 归一化 GY-I03 承诺范围（范围口径，修复轮 3）。
 * 支持两种入参：
 *   - 字符串数组：直接作为允许的覆盖类集合（旧口径，无依据元数据）。
 *   - 对象 { classes, basisRef, catalogRef, catalogVersion, catalogSha256, sourceGroups }：
 *     由物种目录（species.json 的 id ↔ group_name）映射得到规范物种 ID，并携带可追溯依据。
 * 返回 { classes: string[]|null, basis: object|null }。范围校验只使用规范 ID（classes）。
 */
function normalizeKnowledgeScope(knowledgeScope) {
  if (Array.isArray(knowledgeScope)) {
    const classes = knowledgeScope.filter((c) => typeof c === 'string' && c.trim() !== '');
    return { classes: classes.length > 0 ? classes : null, basis: null };
  }
  if (isObject(knowledgeScope) && Array.isArray(knowledgeScope.classes)) {
    const classes = knowledgeScope.classes.filter((c) => typeof c === 'string' && c.trim() !== '');
    const basis = {
      basisRef: typeof knowledgeScope.basisRef === 'string' ? knowledgeScope.basisRef : null,
      catalogRef: typeof knowledgeScope.catalogRef === 'string' ? knowledgeScope.catalogRef : null,
      catalogVersion: typeof knowledgeScope.catalogVersion === 'string' ? knowledgeScope.catalogVersion : null,
      catalogSha256: typeof knowledgeScope.catalogSha256 === 'string' ? knowledgeScope.catalogSha256 : null,
      sourceGroups: Array.isArray(knowledgeScope.sourceGroups) ? [...knowledgeScope.sourceGroups] : null,
    };
    return { classes: classes.length > 0 ? classes : null, basis };
  }
  return { classes: null, basis: null };
}
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

/** 由目标定义构造某 task 的门禁列表。claimable=false 时一律 not_evaluated，不写通过。 */
export function buildGates(task, metrics, gateDefs, claimable, notClaimableReason) {
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
        reason = notClaimableReason ?? '不可主张：非真实冻结 test 集 / 样本未达第6节目标 / 存在缺口或预测不完整，不得声称达标';
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
 * @param {Array} records 脱敏样本索引（含 gold，含 train/validation/test）
 * @param {Map<string, object>} predictions sampleId -> 模型/规则输出
 * @param {object} options { gateDefs, frozenManifest, coverageManifest, knowledgeScope, seed, generatedAt }
 *   frozenManifest: 经核实的冻结清单（indexVersion/split/recordCount/indexSha256/frozenAt +
 *     **内嵌 coverage 绑定块**）；缺失或覆盖未绑定即不可主张。
 *   coverageManifest: 外部承诺覆盖清单（weedPhotoCoveredClasses）；必须与冻结清单内嵌绑定一致，
 *     缩减/修改/新增一律拒绝（变化须成为新冻结版本）。
 *   knowledgeScope: 可选 GY-I03 承诺范围（允许的覆盖类全集）。可传字符串数组，或
 *     { classes, basisRef, catalogRef, catalogVersion, catalogSha256, sourceGroups }：
 *     后者由 GY-I03 物种目录（中文组名 → 规范物种 ID）映射得到，并把映射依据记入报告
 *     `coverageBinding.scopeBasis` 供审计。范围校验一律以**规范物种 ID**比较。
 */
export function evaluateRun(records, predictions, options = {}) {
  const { gateDefs, frozenManifest = null, coverageManifest = null, knowledgeScope = null, seed = 20261004, generatedAt = new Date().toISOString() } = options;
  const warnings = [];

  // 1. 按 split 划分：最终验收只用 test；train/validation 另列统计。
  const testRecordsAll = records.filter((r) => r.split === 'test');
  const trainCount = records.filter((r) => r.split === 'train').length;
  const validationCount = records.filter((r) => r.split === 'validation').length;

  // 2. 冻结清单校验（针对 test 集）。
  const frozen = verifyFrozenManifest(frozenManifest, testRecordsAll);
  const frozenIndexVersion = frozenManifest && typeof frozenManifest.indexVersion === 'string' ? frozenManifest.indexVersion : 'unfrozen';

  // 2b. 承诺覆盖清单与冻结清单的绑定校验（防事后缩减/修改覆盖清单改变达标结论）。
  //     范围口径统一为**规范物种 ID**：knowledgeScope 的展示名称须先由物种目录映射为 ID 再核对。
  const scope = normalizeKnowledgeScope(knowledgeScope);
  const coverageBinding = verifyCoverageBinding(frozenManifest, coverageManifest, { scopeClasses: scope.classes });
  // 只有绑定通过时，冻结内嵌的承诺覆盖类才可信；否则逐类达标一律按未满足计。
  const boundCoverageManifest = coverageBinding.verified ? { weedPhotoCoveredClasses: coverageBinding.boundClasses } : null;

  // 3. 数据性质（只看参与验收的 test 集）。
  const syntheticCount = testRecordsAll.filter((r) => r.sourceKind === 'synthetic_placeholder').length;
  const dataKind =
    testRecordsAll.length === 0 ? 'no_test_split' : syntheticCount === 0 ? 'real_frozen' : syntheticCount === testRecordsAll.length ? 'synthetic_placeholder' : 'mixed';

  // 4. 按独立对象去重：评分与计数排除同源/近重复，避免充数。
  const { kept: testRecords, excluded: duplicateRecords } = dedupeByIndependentObject(testRecordsAll);
  const duplicatesExcluded = duplicateRecords.length;

  // 5. 预测完整性与结构校验。
  const predictionEvidence = validatePredictionCoverage(testRecords, predictions);

  // 6. 缺口（原始 test 集；computeGaps 内部按真实样本去重并如实报重复数）。
  const gaps = computeGaps(testRecordsAll, { coverageManifest: boundCoverageManifest });
  const gapsSatisfied = gaps.every((g) => g.missing === 0);
  const coverageManifestPresent = gaps.some((g) => g.bucket === 'weed_photo_covered_per_class' && g.coverageManifestPresent === true);

  // 7. 是否构成可主张的真实评估。
  const isRealEvaluation =
    testRecords.length > 0 &&
    frozen.verified &&
    coverageBinding.verified &&
    dataKind === 'real_frozen' &&
    gapsSatisfied &&
    predictionEvidence.complete;

  // 8. 警告。
  if (testRecordsAll.length === 0) warnings.push('没有 split=test 的样本：缺少冻结独立测试集，评估未完成，不得主张真实评估。');
  if (dataKind === 'synthetic_placeholder' || dataKind === 'mixed') warnings.push('输入含 synthetic_placeholder：仅验证程序可运行，不构成真实评估。');
  if (!frozen.verified) warnings.push(`冻结清单校验未通过：${frozen.reasons.join('；')}`);
  if (!gapsSatisfied) warnings.push('真实样本数量未达第6节标准，评估未完成，不得标记达标。');
  if (!coverageManifestPresent) warnings.push('未提供冻结覆盖清单：覆盖内逐类达标不可推断。');
  if (!coverageBinding.verified) warnings.push(`承诺覆盖清单未与冻结清单绑定：${coverageBinding.reasons.join('；')}；覆盖达标按未满足计，变化须作为新冻结版本。`);
  if (duplicatesExcluded > 0) warnings.push(`已按独立对象去重：排除近重复/同源记录 ${duplicatesExcluded} 条（不计入评分与缺口）。`);
  if (!predictionEvidence.complete) {
    warnings.push(`预测不完整：缺失 ${predictionEvidence.missing.length} 条，非法/失败 ${predictionEvidence.invalid.length} 条；相关任务保持 not_evaluated。`);
  }
  if (predictionEvidence.extra.length > 0) warnings.push(`存在 ${predictionEvidence.extra.length} 条索引外的多余预测，已忽略且不参与评分。`);
  if (!isRealEvaluation && frozen.verified) warnings.push('存在未满足的可主张条件（缺口/预测完整性/数据性质），门禁保持 not_evaluated。');

  // 9. 逐任务评分（仅 test 集、去重后、结构合法预测）。
  const tasks = {};
  for (const task of Object.keys(SCORERS)) {
    const taskRecords = testRecords.filter((r) => r.task === task);
    const scorablePairs = taskRecords
      .map((record) => ({ record, output: predictions.get(record.sampleId) }))
      .filter((p) => validatePredictionOutput(task, p.output).ok);
    const metrics = SCORERS[task](scorablePairs, { seed });
    const coverage = predictionEvidence.byTask[task] ?? { expected: 0, present: 0, missing: 0, invalid: 0 };
    const taskComplete = coverage.missing === 0 && coverage.invalid === 0;
    const claimable = isRealEvaluation && taskComplete;
    const gates = buildGates(task, metrics, gateDefs, claimable);
    const hasFail = gates.some((g) => g.status === 'fail');
    const allPass = gates.length > 0 && gates.every((g) => g.status === 'pass');
    const gateStatus = !claimable ? 'not_evaluated' : hasFail ? 'fail' : allPass ? 'pass' : 'not_evaluated';
    tasks[task] = { sampleCount: taskRecords.length, scoredCount: scorablePairs.length, predictionEvidence: coverage, metrics, gates, gateStatus };
  }

  const indexSha256 = createHash('sha256').update(JSON.stringify(records)).digest('hex');
  const testIndexSha256 = computeRecordsSha256(testRecordsAll);
  const predictionSha256 = createHash('sha256')
    .update(JSON.stringify([...predictions.entries()].sort((a, b) => a[0].localeCompare(b[0]))))
    .digest('hex');

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    dataKind,
    isRealEvaluation,
    generatedAt,
    indexSha256,
    testIndexSha256,
    predictionSha256,
    frozenIndexVersion,
    frozenVerified: frozen.verified,
    frozenVerification: { verified: frozen.verified, reasons: frozen.reasons, indexSha256: frozen.computedSha256, manifestSha256: frozen.manifestSha256 },
    coverageBinding: {
      verified: coverageBinding.verified,
      reasons: coverageBinding.reasons,
      boundClasses: coverageBinding.boundClasses,
      coverageSha256: coverageBinding.coverageSha256,
      basisRef: coverageBinding.basisRef,
      scopeBasis: scope.basis,
    },
    splits: { train: trainCount, validation: validationCount, test: testRecordsAll.length, total: records.length },
    duplicatesExcluded,
    coverageManifestPresent,
    predictionEvidence: {
      expected: predictionEvidence.expected,
      present: predictionEvidence.present,
      missing: predictionEvidence.missing,
      invalid: predictionEvidence.invalid,
      extra: predictionEvidence.extra,
      complete: predictionEvidence.complete,
      byTask: predictionEvidence.byTask,
    },
    tasks,
    gaps,
    warnings,
  };
}

export { wilsonInterval, at };
