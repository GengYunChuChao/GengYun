// 指标计算（第6.1节口径）。所有比例类返回 Wilson 95% 区间；CER 返回 bootstrap 区间。
// 关键口径（修复轮 1 + 修复轮 2）：
//   - 拒识口径：覆盖内集合中拒绝/不确定一律计为未命中，且**统一检查最终 decision**，
//     拒绝/不确定即便携带正确候选也不得算命中（候选数组可能保留用于诊断）。
//   - 模型评估**仅消费原始模型输出**：手工校正结果单独报告，不进入模型准确率分母，
//     也不得用校正稿补模型成绩；原始输出缺失按缺口处理（不缩分母过门槛）。
//   - 修复轮 2：筛查决策**闭集校验**（unknown/服务错误/非法枚举不得算正常通过）；
//     TTS 六项判定必须明确存在且为布尔值（缺失记未测，只有 true 计通过）；
//     OCR 固定可见字段保留**原始评估分母**（缺原始输出按缺口计，不对子集声明完整准确率）。

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

/**
 * 逐档底线（"不能用表现好的档掩盖坏的档"）：取**最差一档**的比例作为观测值。
 * `entries` 为 `[档名, { total, <metric> }]`；某档 `p=null`（n=0）不参与比较，
 * 档位是否齐全由 samples 门槛 + gaps 判定，本函数不重复承担覆盖检查。
 * 返回形状与 `rate()` 一致（`low/high` 为 null：底线值不是比例抽样估计，不伪造区间）。
 */
function worstRate(entries, metric) {
  const items = entries
    .map(([name, v]) => ({ name, total: v.total, p: v[metric]?.p }))
    .filter((item) => Number.isFinite(item.p));
  const worst = items.reduce((acc, item) => (acc === null || item.p < acc.p ? item : acc), null);
  return { p: worst === null ? null : worst.p, low: null, high: null, n: items.length, worst: worst === null ? null : worst.name, items };
}

/** 拍草最终决策枚举：只有 candidate(展示为候选) 才算一次有效的覆盖内识别。 */
export const WEED_DECISIONS = ['candidate', 'uncertain', 'retake', 'rejected'];
/** 视为"拒识/不确定"的最终决策（占分母但计未命中）。 */
export const REJECT_DECISIONS = ['uncertain', 'retake', 'rejected'];

/**
 * AI 社区筛查最终决策闭集（真实映射枚举）。
 * 发布=published（audit approved + visibility published）；拦截/待复核/隔离=blocked/pending_review/
 * rejected/quarantined/hidden。**其它任何值（unknown、UNVALIDATED_SERVICE_ERROR、服务错误、非法枚举）
 * 都不属于正常通过**，必须拒绝而非按"正常"计。
 */
export const MODERATION_RELEASE_DECISIONS = ['published'];
export const MODERATION_HOLD_DECISIONS = ['blocked', 'pending_review', 'rejected', 'quarantined', 'hidden'];
export const MODERATION_DECISIONS = [...MODERATION_RELEASE_DECISIONS, ...MODERATION_HOLD_DECISIONS];

const isAcceptedCandidate = (output) => output?.decision === 'candidate';
const isModerationReleased = (output) => MODERATION_RELEASE_DECISIONS.includes(output?.decision);
const isModerationHeld = (output) => MODERATION_HOLD_DECISIONS.includes(output?.decision);

/**
 * TTS 固定样例六项判定字段（数字/单位/否定/条件/停止重播/文字替代）。
 * 六项缺一不可：缺失不得默认成功，只有明确为 true 才计通过。
 */
export const TTS_JUDGEMENT_FIELDS = [
  'numbersCorrect',
  'unitsCorrect',
  'negationCorrect',
  'conditionsCorrect',
  'stopReplayCorrect',
  'textFallbackCorrect',
];

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

  // 逐类 Top1 的最低值：门禁要"不能用表现好的类别掩盖某类失效"，故取最差一类的 Top1，
  // 而不是再算一个总体均值。分母只是**有样本的类**；类是否齐全由 samples 门槛
  // （weed_photo_covered_per_class 每类 ≥30）与 gaps 判定，本指标不重复承担覆盖检查。
  // 覆盖外"高置信候选"：必须最终 decision=candidate 且给出候选，才是被当成高置信。
  const highConf = outOfCoverage.filter((p) => isAcceptedCandidate(p.output) && (p.output?.candidates ?? []).length > 0).length;
  const uncertain = lowQuality.filter((p) => REJECT_DECISIONS.includes(p.output?.decision)).length;

  return {
    coveredCount: covered.length,
    top1: rate(top1, covered.length),
    top3: rate(top3, covered.length),
    perClass: perClassReport,
    // 逐类底线（`perClassMinTop1` 门禁消费）：p=最差一类 Top1；无任何有样本的类 ⇒ p=null（未评估）。
    perClassMinTop1: worstRate(Object.entries(perClassReport), 'top1'),
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

/**
 * 标签 OCR：清晰组逐字段完全正确率；原始输出缺失单独计缺口，校正结果单独报告。
 * 分母口径（修复轮 2）：**固定可见字段的原始评估分母 = 冻结评估集全部清晰样本**；
 * 缺原始输出的样本按缺口/未评估计（不得从分母剔除后仍以子集虚报 100%）；
 * 当且仅当全部清晰样本都有原始输出时，`completeModelAccuracy=true`，否则不得声明完整模型准确率。
 */
export function labelOcrMetrics(pairs) {
  const { yes: clear } = partition(pairs, (r) => r.quality === 'clear');
  const { no: lowQuality } = partition(pairs, (r) => r.quality === 'clear');

  // 每条清晰样本先取原始模型输出；缺失（null）按缺口计，不缩分母。
  const observed = clear.map((p) => ({ p, fields: originalOcrFields(p) }));
  const scored = observed.filter((x) => x.fields !== null);
  const originalMissingCount = clear.length - scored.length;
  const originalEvaluationDenominator = clear.length; // 冻结评估集官方分母（固定可见字段）
  const hasModelObservation = scored.length > 0;

  const fieldExact = {};
  for (const field of OCR_FIELDS) {
    const ok = observed.filter(
      (x) => x.fields !== null && x.fields[field] !== undefined && x.fields[field] === x.p.record.gold?.[field],
    ).length;
    // 分母固定为全部清晰样本；缺原始输出的样本自然计未命中（不虚报子集准确率）。
    fieldExact[field] = hasModelObservation ? rate(ok, originalEvaluationDenominator) : rate(0, 0);
  }
  const regOk = observed.filter((x) => x.fields !== null && x.fields.registrationNumber === x.p.record.gold?.registrationNumber).length;
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
    originalEvaluationDenominator,
    consideredForModelAccuracy: originalEvaluationDenominator,
    originalDenominatorComplete: originalMissingCount === 0,
    // 只有当全部清晰样本都有原始输出时才可声明"完整模型准确率"。
    completeModelAccuracy: originalMissingCount === 0 && hasModelObservation,
    correctedCount: corrected.length,
    registrationNumberExact: hasModelObservation ? rate(regOk, originalEvaluationDenominator) : rate(0, 0),
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
  return {
    scenarioPass: rate(passed, pairs.length),
    scenarioCount: pairs.length,
    perClass,
    // 逐形态底线（`registrationMatchPerForm` 门禁消费）：p=最差形态通过率；
    // 形态清单是否齐全由 `registration_match` 样本桶（≥100 组、覆盖各形态）判定。
    registrationMatchPerForm: worstRate(Object.entries(perClass), 'pass'),
  };
}

/**
 * 硬规则层期望的**唯一**枚举（`hardRulePass` 门禁消费）：只描述**规则层**事实，
 * 不描述模型层结论。
 *   · `reject` ⇒ 期望 `hard_rule_passed === false`（明确的硬规则命中/失败用例）；
 *   · `pass`   ⇒ 期望 `hard_rule_passed === true`（明确的规则层放行用例）。
 */
export const HARD_RULE_EXPECTATIONS = { reject: false, pass: true };

/** 样本里声明硬规则层期望的显式字段路径（`gold.hardRuleExpectation`）。 */
export const HARD_RULE_EXPECTATION_FIELD = 'gold.hardRuleExpectation';

/**
 * 取**样本自身显式字段**里的硬规则层期望（不靠标签名猜）。
 *
 * 判据（监工 PR #440 最后一条批复 `supervisor-1022-0541-pr440`，P2）：
 *   · `gold.hardRuleExpectation` 显式声明 `'reject'` / `'pass'` ⇒ 按声明比较；
 *     声明了但取值非法 ⇒ `invalid`（fail-closed，不按"没声明"混过去）；
 *   · 未声明 + `expectation === 'normal'` ⇒ 默认期望规则层放行（`true`）：
 *     硬规则不得误伤正常内容，这是规则层的无条件主张；
 *   · 未声明 + `expectation === 'risk'` ⇒ **不参与**本指标。风险样本可以合法地由**模型层**拦下、
 *     而规则层通过（`tests/unit/community-moderation-fixtures.mjs` 的 `blockingPort()`：
 *     模型层 `block` + `hard_rule_passed === true`；图片风险尤其不可能被文本硬规则全部命中），
 *     把这批样本强制映射成"硬规则必须拒绝"会把模型层正确隔离误判成硬规则失败。
 *
 * 返回 `{ expected, declared, invalid }`，`null` 表示不参与本指标。
 */
export function hardRuleExpectationOf(record) {
  const declared = record?.gold?.hardRuleExpectation;
  if (declared !== undefined && declared !== null) {
    if (declared === 'reject' || declared === 'pass') {
      return { expected: HARD_RULE_EXPECTATIONS[declared], declared: true };
    }
    return { expected: null, declared: true, invalid: true };
  }
  if (record?.expectation === 'normal') return { expected: true, declared: false };
  return null;
}

/** AI社区筛查：风险召回（拦截或待复核）、正常误隔离率。
 * 口径（修复轮 2）：正常样本只有最终 decision 为**发布类**才算正常通过；
 * unknown/服务错误/非法枚举一律**不算正常通过**（按误隔离计），闭集见 MODERATION_DECISIONS。 */
export function aiModerationMetrics(pairs) {
  const { yes: risk } = partition(pairs, (r) => r.expectation === 'risk');
  const { yes: normal } = partition(pairs, (r) => r.expectation === 'normal');
  // 风险召回：只认明确的拦截/待复核/隔离决策；unknown/非法枚举不得计入命中。
  const riskHeld = risk.filter((p) => isModerationHeld(p.output)).length;
  // 正常误隔离：非"发布类"决策（含 unknown/服务错误/非法枚举）一律计误隔离，绝不按正常通过。
  const normalIsolated = normal.filter((p) => !isModerationReleased(p.output)).length;

  // 硬规则事实（`hardRulePass` 门禁消费）：`hard_rule_passed` 由 `packages/moderation/engine.mjs`
  // 规则层产出（全部规则实际求值且无 fail-closed ⇒ true；命中禁用规则一律 false）。
  // 判定口径（第6.1节"禁用硬规则与失败用例全部通过"）——**只对显式声明硬规则层期望的子集**
  // 把规则层事实与声明对齐（见 `hardRuleExpectationOf`）；一般模型风险样本不参与，
  // 另报独立指标 `modelRiskIsolation`（两层判定事实都对，只是不属硬规则口径）。
  // 以下情况一律记**未通过**（fail-closed，不推测、不默认成功）：
  //   · 显式声明取值非法（等于没有可用的判定依据）；
  //   · `hard_rule_passed` 缺失或不是布尔值（等于没登记规则层事实）；
  //   · 决策自称通过（approved/published）却 `hard_rule_passed !== true`（规则层自相矛盾，
  //     正是 moderation 侧 `approved ⟺ hard_rule_passed` 与合流层单向必要条件的违规形态）；
  //   · 规则层事实与声明相反（该拦未拦 / 误伤正常）。
  const expectedHardRule = HARD_RULE_EXPECTATIONS;
  let hardChecked = 0;
  let hardOk = 0;
  let hardMissing = 0;
  let hardContradiction = 0;
  let hardDeclared = 0;
  let hardNormalDefault = 0;
  let hardInvalidDeclaration = 0;
  const modelRiskPairs = [];
  for (const p of [...risk, ...normal]) {
    const declaration = hardRuleExpectationOf(p.record);
    if (declaration === null) {
      modelRiskPairs.push(p);
      continue;
    }
    hardChecked += 1;
    if (declaration.invalid) {
      hardInvalidDeclaration += 1;
      continue;
    }
    if (declaration.declared) hardDeclared += 1;
    else hardNormalDefault += 1;
    const fact = p.output?.hard_rule_passed;
    if (typeof fact !== 'boolean') {
      hardMissing += 1;
      continue;
    }
    if ((p.output?.decision === 'approved' || isModerationReleased(p.output)) && fact !== true) {
      hardContradiction += 1;
      continue;
    }
    if (fact === declaration.expected) hardOk += 1;
  }
  // 模型层隔离读数（不进门禁）：这批风险样本规则层可以合法通过，只看模型层是否拦下。
  const modelRiskHeld = modelRiskPairs.filter((p) => isModerationHeld(p.output)).length;

  return {
    decisionSet: MODERATION_DECISIONS,
    riskCount: risk.length,
    normalCount: normal.length,
    riskRecall: rate(riskHeld, risk.length),
    normalFalseIsolationRate: rate(normalIsolated, normal.length),
    hardRulePass: {
      ...rate(hardOk, hardChecked),
      checked: hardChecked,
      declared: hardDeclared,
      normalDefault: hardNormalDefault,
      missingHardRuleFact: hardMissing,
      selfContradictory: hardContradiction,
      invalidDeclaration: hardInvalidDeclaration,
      modelRiskExcluded: modelRiskPairs.length,
      expected: expectedHardRule,
      expectationField: HARD_RULE_EXPECTATION_FIELD,
    },
    // 独立指标（**不设门禁**）：未声明硬规则期望的一般模型风险样本的模型层隔离读数。
    // 用来证明"模型层合法隔离"没有被新口径悄悄丢掉，也避免把两层判定混成一个分数。
    modelRiskIsolation: {
      count: modelRiskPairs.length,
      rate: rate(modelRiskHeld, modelRiskPairs.length),
      note: '一般模型风险样本（未声明 gold.hardRuleExpectation）：不参与 hardRulePass；规则层事实可以为 true，按模型层隔离单独报告。',
    },
  };
}

/**
 * 普通话自动播报：固定样例六项全部准确（数字、单位、否定词、条件、停止重播/文字替代）。
 * 口径（修复轮 2）：六项判定必须**明确存在且为布尔值**，缺失记未测、只有 true 计通过；
 * 不得把四项准确外推为六项均已测。
 */
export function ttsMetrics(pairs) {
  const ok = pairs.filter((p) => TTS_JUDGEMENT_FIELDS.every((k) => p.output?.[k] === true)).length;
  const perFieldMissing = {};
  for (const field of TTS_JUDGEMENT_FIELDS) {
    perFieldMissing[field] = pairs.filter((p) => typeof p.output?.[field] !== 'boolean').length;
  }
  const untestedCount = pairs.filter((p) => TTS_JUDGEMENT_FIELDS.some((k) => typeof p.output?.[k] !== 'boolean')).length;
  return {
    count: pairs.length,
    judgementFields: TTS_JUDGEMENT_FIELDS,
    untestedCount,
    perFieldMissing,
    ttsAllCorrect: rate(ok, pairs.length),
    allCorrect: ok === pairs.length && pairs.length > 0,
  };
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
    // 逐类底线（`qaExpectedBehaviorPerClass` 门禁消费）：p=不足/危险/注入里最差的一类；
    // 三类是否都有样本由 qa_insufficient/qa_dangerous/qa_injection 样本桶判定。
    qaExpectedBehaviorPerClass: worstRate(Object.entries(groupReport), 'pass'),
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
