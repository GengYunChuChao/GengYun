// 指标计算（第6.1节口径）。所有比例类返回 Wilson 95% 区间；CER 返回 bootstrap 区间。
// 拒识口径：拍草覆盖内集合中，拒绝/不确定一律计为未命中。

import { wilsonInterval, bootstrapRatioInterval, levenshtein, normalizeForCER } from './ci.mjs';

const rate = (successes, total) => wilsonInterval(successes, total);

/** 把 [{record, output}] 按谓词拆分。 */
function partition(pairs, predicate) {
  const yes = [];
  const no = [];
  for (const p of pairs) (predicate(p.record) ? yes : no).push(p);
  return { yes, no };
}

/** 拍草：Top1/Top3、逐类、覆盖外高置信率、低质量不确定率。 */
export function weedPhotoMetrics(pairs) {
  const { yes: covered } = partition(pairs, (r) => r.coverage === 'covered' && r.quality === 'clear');
  const { yes: outOfCoverage, no: lowQualityCandidates } = partition(pairs, (r) => r.coverage === 'out_of_coverage');
  const lowQuality = lowQualityCandidates.filter((p) => p.record.quality !== 'clear');

  const hits = (k) => covered.filter((p) => Array.isArray(p.output?.candidates) && p.output.candidates.slice(0, k).some((c) => c.speciesId === p.record.labelClass));
  const top1 = hits(1).length;
  const top3 = hits(3).length;

  const perClass = {};
  for (const p of covered) {
    const key = p.record.labelClass;
    perClass[key] ??= { total: 0, top1: 0, top3: 0 };
    perClass[key].total += 1;
    const cands = Array.isArray(p.output?.candidates) ? p.output.candidates : [];
    if (cands.slice(0, 1).some((c) => c.speciesId === key)) perClass[key].top1 += 1;
    if (cands.slice(0, 3).some((c) => c.speciesId === key)) perClass[key].top3 += 1;
  }
  const perClassReport = {};
  for (const [k, v] of Object.entries(perClass)) {
    perClassReport[k] = { total: v.total, top1: rate(v.top1, v.total), top3: rate(v.top3, v.total) };
  }

  const highConf = outOfCoverage.filter((p) => (p.output?.candidates ?? []).length > 0 && (p.output.decision ?? 'candidate') === 'candidate').length;
  const uncertain = lowQuality.filter((p) => p.output?.decision === 'uncertain' || p.output?.decision === 'retake').length;

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

/** 标签 OCR：清晰组逐字段完全正确率；手工校正样本从模型准确率中剔除并单独报告。 */
export function labelOcrMetrics(pairs) {
  const { yes: clear } = partition(pairs, (r) => r.quality === 'clear');
  const { no: lowQuality } = partition(pairs, (r) => r.quality === 'clear');

  const modelScored = clear.filter((p) => p.output?.corrected !== true);
  const correctedExcluded = clear.filter((p) => p.output?.corrected === true).length;

  const fieldExact = {};
  for (const field of OCR_FIELDS) {
    const ok = modelScored.filter((p) => p.output?.fields?.[field] !== undefined && p.output.fields[field] === p.record.gold?.[field]).length;
    fieldExact[field] = rate(ok, modelScored.length);
  }
  const regOk = modelScored.filter((p) => p.output?.fields?.registrationNumber === p.record.gold?.registrationNumber).length;
  const distinctRecords = new Set(clear.map((p) => p.record.gold?.registrationNumber).filter(Boolean)).size;

  return {
    clearCount: clear.length,
    modelScoredCount: modelScored.length,
    correctedExcluded,
    consideredForModelAccuracy: modelScored.length,
    registrationNumberExact: rate(regOk, modelScored.length),
    fieldExact,
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

/** 普通话 ASR：总体 CER（bootstrap CI）、逐场景、关键字段完全正确率。 */
export function asrMetrics(pairs, { seed = 20261004, resamples = 10000 } = {}) {
  const items = [];
  const perScenario = {};
  const keyFields = { drugNames: [0, 0], numbers: [0, 0], units: [0, 0] };
  let speakers = new Set();

  for (const p of pairs) {
    const ref = normalizeForCER(p.record.gold?.reference ?? '');
    const hyp = normalizeForCER(p.output?.hypothesis ?? '');
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
      if (p.output?.keyFieldsExact?.[field] === true) keyFields[field][0] += 1;
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

export { rate };
