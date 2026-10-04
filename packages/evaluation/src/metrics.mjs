// 指标计算（第6.1节口径）。所有比例类返回 Wilson 95% 区间；CER 返回 bootstrap 区间。
// 关键口径（修复轮 1）：
//   - 拒识口径：覆盖内集合中拒绝/不确定一律计为未命中，且**统一检查最终 decision**，
//     拒绝/不确定即便携带正确候选也不得算命中（候选数组可能保留用于诊断）。
//   - 模型评估**仅消费原始模型输出**：手工校正结果单独报告，不进入模型准确率分母，
//     也不得用校正稿补模型成绩；原始输出缺失按缺口处理（不缩分母过门槛）。

import { wilsonInterval, bootstrapRatioInterval, levenshtein, normalizeForCER } from './ci.mjs';

const rate = (successes, total) => wilsonInterval(successes, total);

/** 把 [{record, output}] 按谓词拆分。 */
function partition(pairs, predicate) {
  const yes = [];
  const no = [];
  for (const p of pairs) (predicate(p.record) ? yes : no).push(p);
  return { yes, no };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 拍草最终决策枚举：只有 candidate(展示为候选) 才算一次有效的覆盖内识别。 */
export const WEED_DECISIONS = ['candidate', 'uncertain', 'retake', 'rejected'];
/** 视为"拒识/不确定"的最终决策（占分母但计未命中）。 */
export const REJECT_DECISIONS = ['uncertain', 'retake', 'rejected'];

const isAcceptedCandidate = (output) => output?.decision === 'candidate';

/** 拍草：Top1/Top3、逐类、覆盖外高置信率、低质量不确定率。 */
export function weedPhotoMetrics(pairs) {
  const { yes: covered } = partition(pairs, (r) => r.coverage === 'covered' && r.quality === 'clear');
  const { yes: outOfCoverage, no: lowQualityCandidates } = partition(pairs, (r) => r.coverage === 'out_of_coverage');
  const lowQuality = lowQualityCandidates.filter((p) => p.record.quality !== 'clear');

  // 命中 = 最终 decision 为 candidate 且 Topk 候选含标准答案物种；
  // 拒识/不确定（即使携带正确候选）计入分母但不算命中。
  const hits = (k) =>
    covered.filter(
      (p) => isAcceptedCandidate(p.output) && Array.isArray(p.output?.candidates) && p.output.candidates.slice(0, k).some((c) => c.speciesId === p.record.labelClass),
    );
  const top1 = hits(1).length;
  const top3 = hits(3).length;

  const perClass = {};
  for (const p of covered) {
    const key = p.record.labelClass;
    perClass[key] ??= { total: 0, top1: 0, top3: 0 };
    perClass[key].total += 1;
    if (!isAcceptedCandidate(p.output)) continue;
    const cands = Array.isArray(p.output?.candidates) ? p.output.candidates : [];
    if (cands.slice(0, 1).some((c) => c.speciesId === key)) perClass[key].top1 += 1;
    if (cands.slice(0, 3).some((c) => c.speciesId === key)) perClass[key].top3 += 1;
  }
  const perClassReport = {};
  for (const [k, v] of Object.entries(perClass)) {
    perClassReport[k] = { total: v.total, top1: rate(v.top1, v.total), top3: rate(v.top3, v.total) };
  }

  // 覆盖外"高置信候选"：必须最终 decision=candidate 且给出候选，才是被当成高置信。
  const highConf = outOfCoverage.filter((p) => isAcceptedCandidate(p.output) && (p.output?.candidates ?? []).length > 0).length;
  const uncertain = lowQuality.filter((p) => REJECT_DECISIONS.includes(p.output?.decision)).length;

  return {
    coveredCount: covered.length,
    top1: rate(top1, covered.length),
    top3: rate(top3, covered.length),
    perClass: perClassReport,
    outOfCoverageCount: outOfCoverage.length,
    outOfCoverageHighConfidenceRate: rate(highConf, outOfCoverage.length),
    lowQualityCount: lowQuality.length,
    lowQualityUncertainRate: rate(uncertain, lowQuality.length),
  };
}

const OCR_FIELDS = ['registrationNumber', 'name', 'ingredient', 'content', 'dosageForm'];

/**
 * 原始模型 OCR 字段。
 * 契约：`output.fields`=原始模型输出；`output.corrected=true` 时原始输出必须放在 `output.originalFields`，
 * 否则视为"原始输出缺失"（不得用 `fields` 里的校正稿冒充模型输出）。
 */
export function originalOcrFields(p) {
  const o = p.output;
  if (!isObject(o)) return null;
  if (o.corrected === true) return isObject(o.originalFields) ? o.originalFields : null;
  return isObject(o.fields) ? o.fields : null;
}

/** 标签 OCR：清晰组逐字段完全正确率；原始输出缺失单独计缺口，校正结果单独报告。 */
export function labelOcrMetrics(pairs) {
  const { yes: clear } = partition(pairs, (r) => r.quality === 'clear');
  const { no: lowQuality } = partition(pairs, (r) => r.quality === 'clear');

  // 分母 = 全部清晰样本（冻结评估集官方分母）；原始输出缺失只标缺口，绝不缩分母。
  const scored = clear.filter((p) => originalOcrFields(p) !== null);
  const originalMissingCount = clear.length - scored.length;

  const fieldExact = {};
  for (const field of OCR_FIELDS) {
    const ok = scored.filter((p) => originalOcrFields(p)[field] !== undefined && originalOcrFields(p)[field] === p.record.gold?.[field]).length;
    fieldExact[field] = rate(ok, scored.length);
  }
  const regOk = scored.filter((p) => originalOcrFields(p).registrationNumber === p.record.gold?.registrationNumber).length;
  const distinctRecords = new Set(clear.map((p) => p.record.gold?.registrationNumber).filter(Boolean)).size;

  // 校正结果单独报告（不进模型准确率分母）。
  const corrected = clear.filter((p) => p.output?.corrected === true);
  const correctedFieldReport = {};
  for (const field of OCR_FIELDS) {
    const denom = corrected.length;
    const originalOk = corrected.filter((p) => originalOcrFields(p)?.[field] === p.record.gold?.[field]).length;
    const correctedOk = corrected.filter((p) => isObject(p.output?.correctedFields) && p.output.correctedFields[field] === p.record.gold?.[field]).length;
    correctedFieldReport[field] = { originalExact: rate(originalOk, denom), correctedExact: rate(correctedOk, denom) };
  }

  return {
    clearCount: clear.length,
    modelScoredCount: scored.length,
    originalMissingCount,
    correctedCount: corrected.length,
    consideredForModelAccuracy: scored.length,
    registrationNumberExact: rate(regOk, scored.length),
    fieldExact,
    correctedFieldReport,
    distinctRegistrationRecords: distinctRecords,
    lowQualityCount: lowQuality.length,
  };
}

/** 登记匹配与冲突：逐场景通过率（eq 门禁=全部通过）。 */
export function registrationMatchMetrics(pairs) {
  const passed = pairs.filter((p) => p.output?.status !== undefined && p.output.status === p.record.gold?.expectedStatus).length;
  const byClass = {};
  for (const p of pairs) {
    const key = p.record.labelClass;
    byClass[key] ??= { total: 0, passed: 0 };
    byClass[key].total += 1;
    if (p.output?.status === p.record.gold?.expectedStatus) byClass[key].passed += 1;
  }
  const perClass = {};
  for (const [k, v] of Object.entries(byClass)) perClass[k] = { total: v.total, pass: rate(v.passed, v.total) };
  return { scenarioPass: rate(passed, pairs.length), scenarioCount: pairs.length, perClass };
}

/** AI社区筛查：风险召回（拦截或待复核）、正常误隔离率。 */
export function aiModerationMetrics(pairs) {
  const { yes: risk } = partition(pairs, (r) => r.expectation === 'risk');
  const { yes: normal } = partition(pairs, (r) => r.expectation === 'normal');
  const isHeld = (p) => p.output?.decision === 'blocked' || p.output?.decision === 'pending_review';
  const riskHeld = risk.filter(isHeld).length;
  const normalIsolated = normal.filter(isHeld).length;
  return {
    riskCount: risk.length,
    normalCount: normal.length,
    riskRecall: rate(riskHeld, risk.length),
    normalFalseIsolationRate: rate(normalIsolated, normal.length),
  };
}

/** 普通话自动播报：固定样例全部准确（数字、单位、否定词、条件、停止重播/文字替代）。 */
export function ttsMetrics(pairs) {
  const ok = pairs.filter((p) => {
    const o = p.output ?? {};
    return o.numbersCorrect && o.unitsCorrect && o.negationCorrect && o.conditionsCorrect && o.stopReplayCorrect !== false && o.textFallbackCorrect !== false;
  }).length;
  return { count: pairs.length, ttsAllCorrect: rate(ok, pairs.length), allCorrect: ok === pairs.length && pairs.length > 0 };
}

/**
 * 原始 ASR 输出。
 * 契约：`output.hypothesis`=原始转写；`output.corrected=true` 时原始转写必须放在 `output.originalHypothesis`、
 * 原始关键字段放在 `output.originalKeyFieldsExact`，否则视为"原始输出缺失"（不得用手改稿补成绩）。
 */
export function originalAsrOutput(p) {
  const o = p.output;
  if (!isObject(o)) return { hypothesis: null, keyFieldsExact: null };
  if (o.corrected === true) {
    return {
      hypothesis: typeof o.originalHypothesis === 'string' ? o.originalHypothesis : null,
      keyFieldsExact: isObject(o.originalKeyFieldsExact) ? o.originalKeyFieldsExact : null,
    };
  }
  return {
    hypothesis: typeof o.hypothesis === 'string' ? o.hypothesis : null,
    keyFieldsExact: isObject(o.keyFieldsExact) ? o.keyFieldsExact : null,
  };
}

/** 普通话 ASR：总体 CER（bootstrap CI）、逐场景、关键字段完全正确率。仅消费原始输出。 */
export function asrMetrics(pairs, { seed = 20261004, resamples = 10000 } = {}) {
  const items = [];
  const perScenario = {};
  const keyFields = { drugNames: [0, 0], numbers: [0, 0], units: [0, 0] };
  let speakers = new Set();
  let originalMissingCount = 0;
  let correctedCount = 0;

  for (const p of pairs) {
    const orig = originalAsrOutput(p);
    if (p.output?.corrected === true) correctedCount += 1;
    if (orig.hypothesis === null) {
      // 原始转写缺失：不得用校正稿补成绩，按缺口跳过（不当作 CER=0）。
      originalMissingCount += 1;
      if (p.record.sourceRef) speakers.add(p.record.sourceRef);
      continue;
    }
    const ref = normalizeForCER(p.record.gold?.reference ?? '');
    const hyp = normalizeForCER(orig.hypothesis);
    const distance = levenshtein(ref, hyp);
    items.push({ distance, referenceLength: ref.length });
    const scenario = p.record.labelClass ?? 'unknown';
    perScenario[scenario] ??= { count: 0, distance: 0, referenceLength: 0 };
    perScenario[scenario].count += 1;
    perScenario[scenario].distance += distance;
    perScenario[scenario].referenceLength += ref.length;
    if (p.record.sourceRef) speakers.add(p.record.sourceRef);
    for (const field of Object.keys(keyFields)) {
      const expected = p.record.gold?.keyFields?.[field];
      if (!Array.isArray(expected) || expected.length === 0) continue;
      keyFields[field][1] += 1;
      // 原始关键字段正确性只能来自原始输出；缺失则不计入（不误判为正确）。
      if (orig.keyFieldsExact?.[field] === true) keyFields[field][0] += 1;
    }
  }

  const scenarioReport = {};
  for (const [k, v] of Object.entries(perScenario)) {
    scenarioReport[k] = { count: v.count, cer: v.referenceLength ? v.distance / v.referenceLength : null };
  }
  const keyFieldReport = {};
  for (const [k, [okN, total]] of Object.entries(keyFields)) keyFieldReport[k] = rate(okN, total);

  const overall = bootstrapRatioInterval(items, { seed, resamples });
  const keyOk = Object.values(keyFields).reduce((s, [okN]) => s + okN, 0);
  const keyTotal = Object.values(keyFields).reduce((s, [, t]) => s + t, 0);

  return {
    utteranceCount: pairs.length,
    scoredUtteranceCount: items.length,
    originalMissingCount,
    correctedCount,
    speakerCount: speakers.size,
    cer: overall,
    perScenario: scenarioReport,
    keyFields: keyFieldReport,
    keyFieldExact: rate(keyOk, keyTotal),
  };
}

/** 大模型资料问答：可答正确且有来源；不足/危险/注入预期行为。 */
export function qaMetrics(pairs) {
  const answerable = pairs.filter((p) => p.record.expectation === 'answerable');
  const expectedBehavior = pairs.filter((p) => ['insufficient', 'dangerous', 'injection'].includes(p.record.expectation));
  const answerableOk = answerable.filter((p) => p.output?.correct === true && p.output?.sourceSupported === true).length;
  const behaviorOk = expectedBehavior.filter((p) => p.output?.expectedBehaviorOk === true).length;
  const byGroup = {};
  for (const p of expectedBehavior) {
    byGroup[p.record.expectation] ??= { total: 0, ok: 0 };
    byGroup[p.record.expectation].total += 1;
    if (p.output?.expectedBehaviorOk === true) byGroup[p.record.expectation].ok += 1;
  }
  const groupReport = {};
  for (const [k, v] of Object.entries(byGroup)) groupReport[k] = { total: v.total, pass: rate(v.ok, v.total) };
  return {
    answerableCount: answerable.length,
    answerableCorrectWithSource: rate(answerableOk, answerable.length),
    expectedBehaviorCount: expectedBehavior.length,
    expectedBehaviorPass: rate(behaviorOk, expectedBehavior.length),
    byGroup: groupReport,
  };
}

export const SCORERS = {
  weed_photo: weedPhotoMetrics,
  label_ocr: labelOcrMetrics,
  registration_match: registrationMatchMetrics,
  ai_moderation: aiModerationMetrics,
  tts: ttsMetrics,
  asr: asrMetrics,
  qa: qaMetrics,
};

export { rate, isObject };
