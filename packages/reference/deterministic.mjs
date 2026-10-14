/**
 * GY-I08 药剂适用过滤与标签原文用量安全边界 · **确定性规则引擎**（单一事实来源）。
 *
 * 本文件是 issue #8 的规则引擎落点，**在既有已合并成果之上补缺**，不另起一套：
 *   - 维度判定复用 `query.mjs` 的 `evaluateApplicability`（8 维度，fail-closed）；
 *   - 用量卡守卫复用 `labels.mjs` 的 `doseCardDescriptor`（原文数字/单位/条件 + 绑定校验）；
 *   - 本文件补齐三件此前缺失的能力：
 *       1) **登记／匹配／限制的登记侧判定**（`evaluateRegistrationMatch`）：
 *          无来源、模拟、失效、多匹配、关键字段冲突一律阻断 —— 对应 issue #8
 *          「无来源、模拟、失效、多匹配和关键字段冲突均阻断」；
 *       2) **功能关闭开关**（`readFeatureSwitches` / `evaluateExecutableAdvice`）：
 *          关闭后**不产出可执行建议，也不产出用量卡**（此前开关只关用量卡）；
 *       3) **可断言、可追溯的规则版本**（`describeRuleVersion` / `ruleVersionDigest`）：
 *          版本号由规则规格内容派生摘要，所有消费端共用同一 `APPLICABILITY_RULE_VERSION`。
 *
 * 合规口径（硬约束）：
 *   - 缺条件或冲突**说明原因、不静默放宽**；不凑选项；
 *   - 用量只能由**有来源的原文卡片**渲染并绑定数字／单位／条件；关闭个人处方、混配与自动换算；
 *   - 未核对／不适用／禁用**不得**进入可执行建议或问答用量卡；
 *   - 风险文字**不得**出现「绝对安全／零药害」类承诺；
 *   - 首批真实资料**没有**用量列 ⇒ 不抽取、不推断、不补造，`dose_text` 保持 null、
 *     `usable_as_dose=false`、`card_ready=false`、DoseCard 计数保持 0。
 *
 * 纯 ESM（仅 `node:crypto` 用于摘要），无第三方依赖。
 */

import {
  APPLICABILITY_DIMENSIONS,
  APPLICABILITY_RULE_VERSION,
  DISPLAY_LABELS,
  DOSE_REJECT_REASONS,
  EVIDENCE_KINDS,
  MATCH_STATES,
  RESTRICTION_STATUSES,
  REVIEW_STATUSES,
  SOURCE_KINDS,
  QUERYABLE_VALIDITIES,
  QUERYABLE_VISIBILITIES,
} from './constants.mjs';
import { evaluateApplicability, evaluateEligibility, isSimulatedSource, readRestrictionStatus } from './query.mjs';
import { doseCardDescriptor } from './labels.mjs';
import { formulationIdentityHash, sha256Hex } from './records.mjs';

/**
 * 阻断类别闭集（**逐类计数与断言的对象**）。
 *
 * 每一类都对应 issue #8 的一条硬要求；任何进入可执行建议／用量卡的路径都必须
 * 逐类给出阻断理由，且**不得**由调用方自行「挑一个较宽松的类别」放行。
 */
export const BLOCK_CODES = Object.freeze({
  /** 无来源：契约必填的来源元数据缺失（登记号／来源类型／证据类型），不编造来源。 */
  NO_SOURCE: 'no_source',
  /** 模拟：`source_kind='simulation'` 或 `SIM-` 登记号或 simulated 标志。 */
  SIMULATED_SOURCE: 'simulated_source',
  /** 失效：过期／撤回／冲突／有效期未知／下架／删除／不可见。 */
  INVALID_SOURCE: 'invalid_source',
  /** 多匹配：多个候选制剂，条件不足以唯一确定（**不静默选一**）。 */
  AMBIGUOUS_MATCH: 'ambiguous_match',
  /** 关键字段冲突：同一登记号下名称／剂型／成分含量互不一致（**不合并**）。 */
  FIELD_CONFLICT: 'field_conflict',
  /** 无匹配：证号格式合法但资料中无对应记录。 */
  NO_MATCH: 'no_match',
  /** 未核对：审核状态为 unverified / rejected / 缺失。 */
  UNREVIEWED: 'unreviewed',
  /** 禁用。 */
  BANNED: 'banned',
  /** 限用（未显式确认时一律阻断）。 */
  RESTRICTED: 'restricted',
  /** 禁限用状态未采集（未知不等于安全）。 */
  RESTRICTION_UNKNOWN: 'restriction_unknown',
  /** 不适用：作物／生育期／地区／制剂／含量剂型／使用场景维度不符或未采集。 */
  NOT_APPLICABLE: 'not_applicable',
  /** 缺条件：必要条件未给出，无法确认适用性。 */
  MISSING_CONDITION: 'missing_condition',
  /** 无来源用量：原文未采集可绑定的数字／单位用量（首批真实资料的现状）。 */
  NO_DOSE_SOURCE: 'no_dose_source',
  /** 功能关闭：功能开关关闭，不产出可执行建议与用量卡。 */
  FEATURE_CLOSED: 'feature_closed',
});

/** 阻断类别闭集（数组，顺序稳定，供计数与断言）。 */
export const BLOCK_CODE_LIST = Object.freeze(Object.values(BLOCK_CODES));

/**
 * **功能关闭开关**（issue #8 验收第 3 条：有功能关闭开关）。
 *
 * 两个开关都是**关闭型**（kill switch）：
 *   - `APP_GY_I08_EXECUTABLE_ENABLED`：关闭后不产出**可执行建议**（也不产出用量卡）；
 *   - `APP_GY_I08_DOSE_CARD_ENABLED`：关闭后不产出**用量卡**（可执行建议仍按适用判定给出）。
 *
 * 取值口径（**fail-closed**，与既有 `APP_KNOWLEDGE_UNVERIFIED_SEED` 同风格）：
 *   - 未设置（`undefined`／空串）⇒ 采用默认值 `true`（开箱保持既有行为）；
 *   - 显式关闭词 `0 / false / off / no`（大小写不敏感）⇒ `false`；
 *   - 显式开启词 `1 / true / on / yes` ⇒ `true`；
 *   - **其它任何取值 ⇒ `false` 并标记 `unrecognized=true`** —— 拼错的开关不得静默当作开启。
 */
export const FEATURE_SWITCH_IDS = Object.freeze({
  EXECUTABLE: 'APP_GY_I08_EXECUTABLE_ENABLED',
  DOSE_CARD: 'APP_GY_I08_DOSE_CARD_ENABLED',
});

const TRUTHY = Object.freeze(['1', 'true', 'on', 'yes']);
const FALSEY = Object.freeze(['0', 'false', 'off', 'no']);

/** 解析单个开关文本 → { enabled, raw, unrecognized }。 */
function parseSwitchValue(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { enabled: fallback, raw: raw ?? null, unrecognized: false };
  }
  const token = String(raw).trim().toLowerCase();
  if (TRUTHY.includes(token)) return { enabled: true, raw: String(raw), unrecognized: false };
  if (FALSEY.includes(token)) return { enabled: false, raw: String(raw), unrecognized: false };
  // 无法识别的取值：**保守关闭**，不静默当作开启。
  return { enabled: false, raw: String(raw), unrecognized: true };
}

/**
 * 读取功能开关状态（默认全部开启；未识别取值保守关闭）。
 * @param {Record<string, unknown>} [env] 环境变量表（默认 `process.env`；显式传入便于确定性测试）
 */
export function readFeatureSwitches(env = globalThis.process?.env ?? {}) {
  const executable = parseSwitchValue(env?.[FEATURE_SWITCH_IDS.EXECUTABLE], true);
  const doseCard = parseSwitchValue(env?.[FEATURE_SWITCH_IDS.DOSE_CARD], true);
  return Object.freeze({
    executable_enabled: executable.enabled,
    dose_card_enabled: doseCard.enabled,
    executable_switch: Object.freeze({ id: FEATURE_SWITCH_IDS.EXECUTABLE, ...executable }),
    dose_card_switch: Object.freeze({ id: FEATURE_SWITCH_IDS.DOSE_CARD, ...doseCard }),
  });
}

/**
 * 解析本次调用的开关状态：**显式入参优先**（供页面开关与测试注入），否则读环境变量。
 * 保证同一份判定既可由配置（运维 kill switch）也可由页面开关驱动，且语义唯一：
 * 用量卡开关**不可能**在可执行建议开关关闭时仍为开启（关闭即同时关闭，见 issue #8 验收第 3 条）。
 */
export function resolveFeatureSwitches(opts = {}) {
  const envSwitches = readFeatureSwitches(opts.env ?? globalThis.process?.env ?? {});
  const executableEnabled =
    opts.executableEnabled === undefined ? envSwitches.executable_enabled : opts.executableEnabled !== false;
  const doseCardRequested =
    opts.doseCardEnabled === undefined
      ? opts.executableEnabled === undefined
        ? envSwitches.dose_card_enabled
        : executableEnabled
      : opts.doseCardEnabled !== false;
  return Object.freeze({
    executable_enabled: executableEnabled,
    // 用量卡是「可执行建议」的下位：上层关闭时不得单独开着。
    dose_card_enabled: doseCardRequested && executableEnabled,
    env: envSwitches,
  });
}

/** 记录是否缺少契约必填的来源元数据（无来源，**不编造**）。 */
function missingContractSourceFields(item) {
  if (!SOURCE_KINDS.includes(item?.source?.source_kind)) return true;
  if (!EVIDENCE_KINDS.includes(item?.source?.evidence_kind)) return true;
  if (typeof item?.registration_number !== 'string' || item.registration_number === '') return true;
  return false;
}

/**
 * 来源侧阻断类别判定（用于把 `valid_source` 维度细分为可读的闭集类别）。
 * @returns {string|null} 阻断类别；`null` 表示来源侧通过
 */
export function sourceBlockCode(item) {
  if (missingContractSourceFields(item)) return BLOCK_CODES.NO_SOURCE;
  if (isSimulatedSource(item)) return BLOCK_CODES.SIMULATED_SOURCE;
  const visibility = item?.visibility;
  if (!QUERYABLE_VISIBILITIES.includes(visibility)) return BLOCK_CODES.INVALID_SOURCE;
  const validity = item?.source?.source_validity ?? item?.source?.validity ?? 'unknown';
  if (!QUERYABLE_VALIDITIES.includes(validity)) return BLOCK_CODES.INVALID_SOURCE;
  return null;
}

/** 禁限用侧阻断类别判定（与 `query.mjs` 同口径，未知即阻断）。 */
export function restrictionBlockCode(item, context = {}) {
  const status = readRestrictionStatus(item);
  if (status === 'banned') return BLOCK_CODES.BANNED;
  if (status === 'restricted') return context.allow_restricted === true ? null : BLOCK_CODES.RESTRICTED;
  if (status === 'unknown') return BLOCK_CODES.RESTRICTION_UNKNOWN;
  return null;
}

/**
 * **未核对**判定（issue #8 验收：「未核对／不适用／禁用不能进入可执行建议或问答用量卡片」）。
 *
 * 记录级与来源级审核状态**都**必须显式为 `verified`：
 *   - `unverified`（未核对）、`rejected`（已驳回）、缺失、非枚举 —— 一律阻断；
 *   - 不取「较宽松的一侧」：来源已驳回而记录自标 verified 不得放行（反之亦然）。
 *
 * 该判定与用量卡的审核绑定**同一口径**（`labels.mjs` 的 `isDoseReviewed`），
 * 因此「可执行建议」与「用量卡」不会对同一条记录给出相反的核对结论。
 */
export function reviewBlockCode(item) {
  const recordStatus = item?.verification?.review_status;
  const sourceStatus = item?.source?.review_status;
  if (!REVIEW_STATUSES.includes(recordStatus) || recordStatus !== 'verified') return BLOCK_CODES.UNREVIEWED;
  if (!REVIEW_STATUSES.includes(sourceStatus) || sourceStatus !== 'verified') return BLOCK_CODES.UNREVIEWED;
  return null;
}

/** 把适用判定的维度名映射为阻断类别（供逐类计数）。 */
function blockCodesFromApplicability(applicability) {
  const codes = [];
  for (const dimension of applicability.blocked) {
    if (dimension === 'banned_restricted') continue; // 由 restrictionBlockCode 细分
    if (dimension === 'valid_source') continue; // 由 sourceBlockCode 细分
    codes.push(BLOCK_CODES.NOT_APPLICABLE);
  }
  return codes;
}

/** 由 DoseCard 拒绝原因派生阻断类别（逐类可读，不合并「未采集」与「禁用」）。 */
export function doseBlockCode(card) {
  if (card?.renderable === true) return null;
  if (card?.closed === true) return BLOCK_CODES.FEATURE_CLOSED;
  const reason = String(card?.reason ?? '');
  const text = DISPLAY_LABELS.dose_reject_reason;
  const table = [
    [text.not_usable, BLOCK_CODES.NO_DOSE_SOURCE],
    [text.missing_condition, BLOCK_CODES.MISSING_CONDITION],
    [text.not_reviewed, BLOCK_CODES.UNREVIEWED],
    [text.simulated_source, BLOCK_CODES.SIMULATED_SOURCE],
    [text.invalid_source, BLOCK_CODES.INVALID_SOURCE],
    [text.restriction_unknown, BLOCK_CODES.RESTRICTION_UNKNOWN],
    [text.restricted, BLOCK_CODES.RESTRICTED],
    [text.banned, BLOCK_CODES.BANNED],
    [text.not_applicable, BLOCK_CODES.NOT_APPLICABLE],
    [text.incomplete_formulation, BLOCK_CODES.NO_SOURCE],
    [text.dose_formulation_mismatch, BLOCK_CODES.FIELD_CONFLICT],
    [text.dose_record_mismatch, BLOCK_CODES.NO_MATCH],
    [text.dose_reference_missing, BLOCK_CODES.MISSING_CONDITION],
    [text.stale_dose, BLOCK_CODES.INVALID_SOURCE],
    [text.no_confirmed_context, BLOCK_CODES.MISSING_CONDITION],
  ];
  for (const [reasonText, code] of table) {
    if (reason !== '' && reasonText === reason) return code;
  }
  return BLOCK_CODES.NOT_APPLICABLE;
}

/**
 * **可执行建议闸门**（issue #8 验收：未核对／不适用／禁用不得进入可执行建议；关闭开关后不产出）。
 *
 * 与 `evaluateApplicability` 的分工：
 *   - `evaluateApplicability` 只回答「条件是否适用」（**不**受功能开关影响，供详情页说明原因）；
 *   - 本函数回答「是否**真的可以**产出可执行建议」——额外叠加（a）来源／禁限用细分类别、
 *     （b）功能关闭开关。开关关闭时 `executable=false`，**无论条件多好**。
 *
 * @param {object} item 内部条目
 * @param {object} [context] 适用上下文
 * @param {{ executableEnabled?: boolean, doseCardEnabled?: boolean, allow_restricted?: boolean, env?: object, ruleVersion?: string }} [opts]
 * @returns {{ executable:boolean, applicable:boolean, blocked:string[], block_codes:string[], reasons:string[], rule_version:string, feature_switch:object }}
 */
export function evaluateExecutableAdvice(item, context = {}, opts = {}) {
  const ruleVersion = opts.ruleVersion ?? APPLICABILITY_RULE_VERSION;
  const switches = resolveFeatureSwitches(opts);
  const applicability = evaluateApplicability(item, context, { ruleVersion });

  const blockCodes = [];
  const reasons = [...applicability.reasons];

  const sourceCode = sourceBlockCode(item);
  if (sourceCode !== null) blockCodes.push(sourceCode);
  const reviewCode = reviewBlockCode(item);
  if (reviewCode !== null) blockCodes.push(reviewCode);
  const restrictionCode = restrictionBlockCode(item, context);
  if (restrictionCode !== null) blockCodes.push(restrictionCode);
  blockCodes.push(...blockCodesFromApplicability(applicability));

  if (!switches.executable_enabled) {
    blockCodes.push(BLOCK_CODES.FEATURE_CLOSED);
    reasons.push(`功能开关 ${FEATURE_SWITCH_IDS.EXECUTABLE} 已关闭：不产出可执行建议与用量卡`);
  }

  // 去重但保持首次出现顺序（顺序稳定 ⇒ 断言与逐类计数可复核）。
  const uniqueCodes = [...new Set(blockCodes)];
  const executable = uniqueCodes.length === 0 && applicability.applicable === true;

  return Object.freeze({
    executable,
    applicable: applicability.applicable,
    blocked: Object.freeze([...applicability.blocked]),
    block_codes: Object.freeze(uniqueCodes),
    reasons: Object.freeze(reasons),
    rule_version: ruleVersion,
    feature_switch: Object.freeze({
      executable_id: FEATURE_SWITCH_IDS.EXECUTABLE,
      dose_card_id: FEATURE_SWITCH_IDS.DOSE_CARD,
      executable_enabled: switches.executable_enabled,
      dose_card_enabled: switches.dose_card_enabled,
    }),
  });
}

/**
 * 同登记号资料冲突探测：返回第一个「同一登记号下制剂身份互不一致」的组（无冲突则 `null`）。
 *
 * `formulationIdentityHash` 的构成为登记号／名称／剂型／有效成分含量 —— 即「关键字段」。
 * 同一个登记号（同一授权制剂身份）下这些字段互相矛盾，说明该登记号的资料**自相矛盾**，
 * 任何基于它的用量结论都不安全。只比较**同一登记号内部**，不跨登记号（与「相似制剂不合并」
 * 同源：不同登记号是不同制剂，互不冲突）。
 *
 * 该探测必须作用于**输入收窄之前**的候选范围，否则调用方传入的名称／剂型／成分含量条件
 * 就会「选一侧」并把冲突消掉（见 `evaluateRegistrationMatch` 步骤 3）。
 */
function sameRegistrationConflict(candidates) {
  const byRegistration = new Map();
  for (const candidate of candidates) {
    const key = normalizeText(candidate.registration_number);
    if (!byRegistration.has(key)) byRegistration.set(key, []);
    byRegistration.get(key).push(candidate);
  }
  for (const [registration, group] of byRegistration) {
    if (group.length < 2) continue;
    const identities = new Set(group.map((c) => formulationIdentityHash(c)));
    if (identities.size > 1) return { registration, group };
  }
  return null;
}

/**
 * **登记／匹配／限制场景的登记侧判定**（issue #8：无来源／模拟／失效／多匹配／关键字段冲突一律阻断）。
 *
 * 状态取契约冻结闭集 `MatchState`（`states.json`）：
 *   matched / no_match / ambiguous / conflict / insufficient / unavailable。
 *
 * 判定顺序（任一步失败即返回，**不静默放宽、不凑选项**）：
 *   1. 候选为空 ⇒ `unavailable`（`no_source`）：没有可用的登记来源记录；
 *   2. 来源侧逐条判定 ⇒ 全部不合格时 `unavailable`，并按类给出 `simulated_source`／
 *      `invalid_source`／`no_source` 计数（不合并成一句「不可用」）；
 *   3. **冲突预检（在输入收窄之前）**：合格候选中同一登记号下出现互不一致的制剂身份
 *      （名称／剂型／成分含量）⇒ `conflict`（`field_conflict`）。
 *      **只有显式给出「另一个」登记号**才能把该组排除在判定范围之外 —— 登记号是登记制剂的
 *      **身份**；而名称／剂型／成分含量正是**互相矛盾的关键字段本身**，用它们收窄等于「选一侧」，
 *      会把资料自身的冲突消掉（P1 缺陷）。故这四类收窄条件对冲突结论**不生效**；
 *   4. **无任何识别条件**且候选多于一条 ⇒ `insufficient`（`missing_condition`）：
 *      条件不足时必须说明原因，不得挑一条返回；
 *   5. 按给出的识别条件（登记号／名称／剂型／成分含量）**精确**过滤；
 *      但**不做相似合并**：0 条命中 ⇒ `no_match`（合法格式但无记录也走这里）；
 *   6. 过滤后仍有多个且无法唯一确定 ⇒ `ambiguous`（`ambiguous_match`）—— **不静默选一**；
 *   7. 唯一命中 ⇒ `matched`。
 *
 * 过滤是「按已有字段确定性匹配」，**不是**放宽：过滤后仍多于一条一律阻断，
 * 因此「多匹配」在任何路径上都不会被静默消解；而**同登记号资料冲突**由步骤 3 在收窄**之前**
 * 判定（`filtered ⊆ scope`，故无需在收窄之后重复判定），收窄条件**不能**把它消掉 —— fail-closed。
 *
 * @param {Array<object>} candidates 候选登记记录（来自登记库／OCR 核对，按**不可信数据**处理）
 * @param {{ registration_number?: string, dosage_form?: string, ingredients_text?: string, registered_name?: string }} [query]
 * @param {{ ruleVersion?: string, includeSimulated?: boolean }} [opts]
 *   `includeSimulated` 只影响「查阅」集合（与既有 `evaluateEligibility` 同语义），
 *   **不**放开可执行资格：模拟候选无论该项取值都会在 `unavailable` 里被如实计数。
 * @returns {{ state:string, matched:object|null, blocked:string[], block_codes:string[], reasons:string[], eligible_count:number, simulated_count:number, invalid_count:number, no_source_count:number, rule_version:string, simulated_allowed:boolean }}
 */
export function evaluateRegistrationMatch(candidates, query = {}, opts = {}) {
  const ruleVersion = opts.ruleVersion ?? APPLICABILITY_RULE_VERSION;
  const includeSimulated = opts.includeSimulated === true;
  const list = Array.isArray(candidates) ? candidates.filter((c) => c !== null && typeof c === 'object') : [];

  const build = (state, codes, reasons, matched, counts) =>
    Object.freeze({
      state,
      matched,
      blocked: Object.freeze(codes.length === 0 ? [] : ['registration_match']),
      block_codes: Object.freeze([...new Set(codes)]),
      reasons: Object.freeze(reasons),
      eligible_count: counts.eligible,
      simulated_count: counts.simulated,
      invalid_count: counts.invalid,
      no_source_count: counts.noSource,
      rule_version: ruleVersion,
      simulated_allowed: includeSimulated,
    });

  // 1) 候选为空：无来源。
  if (list.length === 0) {
    return build('unavailable', [BLOCK_CODES.NO_SOURCE], ['没有可用的登记来源记录（无来源），不放行'], null, {
      eligible: 0,
      simulated: 0,
      invalid: 0,
      noSource: 0,
    });
  }

  // 2) 来源侧逐条判定，按类计数（不合并成一句「不可用」）。
  const eligible = [];
  const simulated = [];
  const invalid = [];
  const noSource = [];
  for (const candidate of list) {
    if (missingContractSourceFields(candidate)) {
      noSource.push(candidate);
      continue;
    }
    if (isSimulatedSource(candidate)) {
      simulated.push(candidate);
      continue;
    }
    const verdict = evaluateEligibility(candidate, { includeSimulated: false });
    if (verdict.queryable) eligible.push(candidate);
    else invalid.push(candidate);
  }
  const counts = { eligible: eligible.length, simulated: simulated.length, invalid: invalid.length, noSource: noSource.length };

  if (eligible.length === 0) {
    const codes = [];
    const reasons = [];
    if (noSource.length > 0) {
      codes.push(BLOCK_CODES.NO_SOURCE);
      reasons.push(`${noSource.length} 条候选缺少契约必填的来源元数据（登记号/来源类型/证据类型），不编造来源`);
    }
    if (simulated.length > 0) {
      codes.push(BLOCK_CODES.SIMULATED_SOURCE);
      reasons.push(`${simulated.length} 条候选为模拟演示数据，不作为真实登记依据`);
    }
    if (invalid.length > 0) {
      codes.push(BLOCK_CODES.INVALID_SOURCE);
      reasons.push(`${invalid.length} 条候选来源已失效（过期/撤回/冲突/有效期未知/下架/删除）`);
    }
    return build('unavailable', codes, reasons, null, counts);
  }

  const queryRegistration = nonEmpty(query.registration_number);
  const queryName = nonEmpty(query.registered_name);
  const queryForm = nonEmpty(query.dosage_form);
  const queryIngredients = nonEmpty(query.ingredients_text);
  const hasIdentifyingCondition = [queryRegistration, queryName, queryForm, queryIngredients].some((v) => v !== '');

  // 3) **冲突预检（在输入收窄之前）**：合格候选中同一登记号下出现互不一致的制剂身份
  //    （名称／剂型／成分含量）⇒ conflict/field_conflict。
  //
  //    范围 `scope` 只允许由**登记号**收窄：登记号是登记制剂的**身份**，显式查询另一个登记号
  //    才谈得上把某个登记号组排除在外。名称／剂型／成分含量是**互相矛盾的关键字段本身**，
  //    若让它们参与收窄，就等于让调用方「选一侧」，会把资料自身的冲突消掉
  //    （这正是监工 2026-10-14 指出的 P1）。
  //    失败代价不对称：这里**宁可保守阻断**（fail-closed），也不许收窄条件消除冲突。
  const scope =
    queryRegistration === ''
      ? eligible
      : eligible.filter((candidate) => normalizeText(candidate.registration_number) === normalizeText(queryRegistration));
  const conflict = sameRegistrationConflict(scope);
  if (conflict !== null) {
    return build(
      'conflict',
      [BLOCK_CODES.FIELD_CONFLICT],
      [
        `登记号 ${conflict.registration} 下存在关键字段冲突（名称/剂型/有效成分含量不一致），不合并不同制剂、不放行；` +
          '该判定在输入收窄之前完成，名称/剂型/成分含量等收窄条件不得消除此冲突',
      ],
      null,
      counts,
    );
  }

  // 4) 无任何识别条件且候选多于一条：条件不足（**不挑一条返回**）。
  if (!hasIdentifyingCondition && eligible.length > 1) {
    return build(
      'insufficient',
      [BLOCK_CODES.MISSING_CONDITION],
      [`存在 ${eligible.length} 条候选且未给出登记号/名称/剂型/成分含量等识别条件，条件不足，不静默选取一条`],
      null,
      counts,
    );
  }

  // 5) 按给出的识别条件**精确**过滤（相似制剂不合并）；0 条命中 ⇒ 无匹配。
  const filtered = eligible.filter((candidate) => {
    if (queryRegistration !== '' && normalizeText(candidate.registration_number) !== normalizeText(queryRegistration)) return false;
    if (queryName !== '' && normalizeText(candidate.registered_name) !== normalizeText(queryName)) return false;
    if (queryForm !== '' && normalizeText(candidate.dosage_form) !== normalizeText(queryForm)) return false;
    if (queryIngredients !== '' && normalizeText(candidate.ingredients_text) !== normalizeText(queryIngredients)) return false;
    return true;
  });
  if (filtered.length === 0) {
    return build('no_match', [BLOCK_CODES.NO_MATCH], ['给出的登记号/名称/剂型/成分含量条件没有任何候选登记制剂与之匹配（不合并相近制剂）'], null, counts);
  }

  // 6) 多匹配：过滤后仍多于一条 ⇒ ambiguous（**不静默选一**）。
  if (filtered.length > 1) {
    return build(
      'ambiguous',
      [BLOCK_CODES.AMBIGUOUS_MATCH],
      [`存在 ${filtered.length} 个可能的登记制剂，现有条件不足以唯一确定，不静默选取一个`],
      null,
      counts,
    );
  }

  // 7) 唯一命中。模拟候选即使被 includeSimulated 允许「查阅」，也不在此放行可执行资格。
  const matched = filtered[0];
  if (isSimulatedSource(matched)) {
    return build('unavailable', [BLOCK_CODES.SIMULATED_SOURCE], ['命中的登记制剂为模拟演示数据，不作为真实登记依据'], null, counts);
  }
  return build('matched', [], [], matched, counts);
}

/**
 * **用量卡边界的统一入口**（可执行建议 + 原文用量卡，同一个规则版本、同一个开关面）。
 *
 * 语义（issue #8）：
 *   - `executable`：是否可产出**可执行建议**（适用判定 + 来源/禁限用细分 + 开关）；
 *   - `renderable`：是否可产出**用量卡** —— 必须 `executable === true` **且** `doseCardDescriptor`
 *     判定可渲染（原文数字／单位／条件齐全，且绑定当前登记制剂与来源版本）。
 *     即：**开关关闭或资格不足时，既不产出可执行建议，也不产出用量卡**。
 *   - `dose_count`：实际产出的用量卡数量（**真实数据下恒为 0**：首批资料无用量列）。
 *
 * @returns {{ executable:boolean, renderable:boolean, dose_count:number, block_codes:string[], reasons:string[], rule_version:string, dose_card:object, advice:object, feature_switch:object }}
 */
export function evaluateDoseBoundary(item, context = {}, opts = {}) {
  const switches = resolveFeatureSwitches(opts);
  const advice = evaluateExecutableAdvice(item, context, opts);
  const card = doseCardDescriptor(item, { doseCardEnabled: switches.dose_card_enabled, context });
  const cardAllowed = advice.executable === true && card.renderable === true;

  const blockCodes = [...advice.block_codes];
  const reasons = [...advice.reasons];
  if (!cardAllowed) {
    const code = doseBlockCode(card);
    if (code !== null) blockCodes.push(code);
    if (typeof card.reason === 'string' && card.reason !== '' && !reasons.includes(card.reason)) reasons.push(card.reason);
  }

  return Object.freeze({
    executable: advice.executable,
    renderable: cardAllowed,
    dose_count: cardAllowed ? 1 : 0,
    block_codes: Object.freeze([...new Set(blockCodes)]),
    reasons: Object.freeze(reasons),
    rule_version: advice.rule_version,
    dose_card: card,
    advice,
    feature_switch: advice.feature_switch,
  });
}

/** 非空字符串归一。 */
function nonEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 文本归一（与 `catalog.mjs` 的 normalizeText 同口径；此处仅需去空白与大小写）。 */
function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * 稳定序列化（对象键排序），用于规则规格摘要 —— 键序不得改变摘要。
 * 导出以便测试**独立复核**摘要算法（版本可追溯性不能只靠"我们自己说"）。
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * 规则规格（**版本号的追溯对象**）。
 * 任何一项变化都会改变 `ruleVersionDigest()` ⇒ 版本可断言、可追溯。
 */
export function ruleVersionSpec() {
  return Object.freeze({
    version: APPLICABILITY_RULE_VERSION,
    dimensions: APPLICABILITY_DIMENSIONS,
    match_states: MATCH_STATES,
    restriction_statuses: RESTRICTION_STATUSES,
    dose_reject_reasons: Object.values(DOSE_REJECT_REASONS),
    block_codes: BLOCK_CODE_LIST,
  });
}

/** 由规则规格派生的内容摘要（形如 `gy-i08-spec+sha256:<64hex>`）。 */
export function ruleVersionDigest() {
  return `gy-i08-spec+sha256:${sha256Hex(canonicalJson(ruleVersionSpec()))}`;
}

/**
 * **消费端登记表**（issue #8：所有消费端使用同一规则版本）。
 *
 * 每条都是可被测试**实际读盘核对**的（`tests/reference/i08-rule-version.test.mjs`），
 * 而不是文档里的口头声明：声明与源码不一致即测试失败。
 *
 * `status` 语义：
 *   - `single_source`：直接或间接取自 `packages/reference/constants.mjs` 的同一常量；
 *   - `mirror_asserted`：跨运行时无法 import（微信小程序无构建步骤）⇒ 常量镜像 + 一致性测试断言同值；
 *   - `cross_line_gap`：平行用量闸门（他线已合并实现）**未声明**本规则版本
 *     —— 当前为 **0 条**：GY-I10 线 `services/api/src/ocr/state.ts` 已按用户 2026-10-14 授权
 *     纳入同一规则版本（见该文件的 `DOSE_GATE_RULE_VERSION_DIFFERENCES`：两层语义差异如实登记，
 *     **不声称判定已等同**）；此后任何新增的未声明平行闸门都必须显式登记，测试断言该集合为空。
 */
export const RULE_VERSION_CONSUMERS = Object.freeze([
  Object.freeze({ id: 'domain-constants', path: 'packages/reference/constants.mjs', status: 'single_source', version_source: 'APPLICABILITY_RULE_VERSION 常量（唯一事实来源）' }),
  Object.freeze({ id: 'domain-engine', path: 'packages/reference/deterministic.mjs', status: 'single_source', version_source: '从 constants.mjs 引入并回传于每条判定结果' }),
  Object.freeze({ id: 'domain-query', path: 'packages/reference/query.mjs', status: 'single_source', version_source: 'evaluateApplicability 的 rule_version 默认值' }),
  Object.freeze({ id: 'domain-labels', path: 'packages/reference/labels.mjs', status: 'single_source', version_source: 'doseCardDescriptor 的 rule_version 字段' }),
  Object.freeze({ id: 'api-knowledge', path: 'services/api/src/knowledge/reference-query.ts', status: 'single_source', version_source: '经 packages/reference/index.mjs 消费，不另立版本' }),
  Object.freeze({ id: 'miniprogram-adapter', path: 'miniprogram/utils/reference.js', status: 'mirror_asserted', version_source: '跨端镜像常量 APPLICABILITY_RULE_VERSION（一致性测试断言同值）' }),
  Object.freeze({ id: 'miniprogram-detail', path: 'miniprogram/pages/referencedetail/referencedetail.js', status: 'mirror_asserted', version_source: '消费 miniprogram/utils/reference.js，页面展示同值 rule_version' }),
  Object.freeze({
    id: 'ocr-dose-gate',
    path: 'services/api/src/ocr/state.ts',
    status: 'single_source',
    version_source:
      '直接 import constants.mjs 的 APPLICABILITY_RULE_VERSION 并导出为 DOSE_GATE_RULE_VERSION；差异登记见 DOSE_GATE_RULE_VERSION_DIFFERENCES（本层不实现禁限用维度）',
  }),
]);

/** 规则版本的完整追溯描述（版本号 + 规格 + 内容摘要 + 消费端登记）。 */
export function describeRuleVersion() {
  return Object.freeze({
    ...ruleVersionSpec(),
    spec_digest: ruleVersionDigest(),
    feature_switches: FEATURE_SWITCH_IDS,
    consumers: RULE_VERSION_CONSUMERS,
  });
}
