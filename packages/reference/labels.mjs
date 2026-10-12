/**
 * GY-I07 查询展示层 · 展示标签（UI 文案的唯一来源）。
 *
 * 硬约束（AC22 / F03 / F14）：
 *   - **不授 AI／用户经验「专家认证」标签**；
 *   - **不对模拟记录显示真实用量**；
 *   - 文案**不得**出现「专家已审 / 已验证安全 / 绝对安全 / 零药害 / 权威认证」等词。
 *
 * 该模块集中产出标签，避免页面各处硬编码漂移；测试会遍历所有标签断言不含禁用词，
 * 并断言**模拟记录**的标签明确标注「非真实资料」。
 *
 * 纯 ESM，无第三方依赖。
 */

import {
  APPLICABILITY_RULE_VERSION,
  DISPLAY_LABELS,
  FORBIDDEN_LABELS,
  SEED_REQUIRED_LABEL,
  SIMULATION_REGISTRATION_PREFIX,
  REVIEW_STATUSES,
} from './constants.mjs';
import { evaluateApplicability, isSimulatedSource } from './query.mjs';

/** 断言文案不含禁用标签（供内部与测试共用）。 */
export function assertNoForbiddenLabel(text) {
  const found = FORBIDDEN_LABELS.filter((w) => String(text).includes(w));
  if (found.length > 0) throw new Error(`文案含禁用标签：${found.join('、')} —— ${text}`);
  return text;
}

/** 来源类型标签。 */
export function sourceKindLabel(kind) {
  return DISPLAY_LABELS.source_kind[kind] ?? '来源类型未知';
}

/** 证据类型标签（科研／经验／混合）。 */
export function evidenceKindLabel(kind) {
  return DISPLAY_LABELS.evidence_kind[kind] ?? '证据类型未知';
}

/** 审核状态标签（未核对/已核对/已驳回）——**不含**任何「专家」措辞。 */
export function reviewStatusLabel(status) {
  return DISPLAY_LABELS.review_status[status] ?? '审核状态未知';
}

/** 参考可得性标签。 */
export function referenceStateLabel(state) {
  return DISPLAY_LABELS.reference_state[state] ?? '资料状态未知';
}

/**
 * 记录状态标签。**模拟记录**额外强标记「模拟演示数据（非真实资料）」，且**不展示用量**。
 * @param {object} item 内部条目（含 simulated / record_status）
 */
export function recordStatusLabel(item) {
  if (item?.simulated) return '模拟演示数据（非真实资料）';
  return DISPLAY_LABELS.record_status[item?.record_status] ?? '字段状态未知';
}

/** 匹配状态标签（无结果/条件不足/已匹配…）。 */
export function matchStateLabel(state) {
  return DISPLAY_LABELS.match_state[state] ?? '查询状态未知';
}

/**
 * 用量展示守卫：**任何记录都不得展示真实用量**。
 * 首批资料缺用量字段（usable_as_dose=false），本函数恒返回「不展示」占位。
 */
export function doseDisplayFor(item) {
  if (item?.usable_as_dose === true) {
    // 即使未来某记录标为可用，展示层也不生成个人处方/换算（F04：只核对原文展示）。
    return '仅按来源原文核对展示，不生成换算或处方';
  }
  return '本记录未采集用量字段，不提供用量信息';
}

/**
 * GY-I08 标签原文用量卡片描述符（DoseCard，F14）。
 *
 * PR #82 修订：用量展示资格**绑定当前有效来源/审核、登记制剂、原文条件/版本和适用判定**。
 * 此前只凭 `verification.usable_as_dose === true` + 数字/单位即 `renderable=true`，
 * 导致独立禁用、来源 expired、simulated=true、甚至 applicability=false 时仍可渲染，
 * 而页面只检查 `renderable`。现在逐项绑定（缺一即拒绝）：
 *
 *   1. 功能开关 `doseCardEnabled=false` → 一律不渲染（**不是**资格验证，只是附加条件）；
 *   2. `verification.usable_as_dose !== true` → 不渲染（未采集可用作依据的用量字段）；
 *   3. **必须**给出原文可绑定条件 `dose.condition`（非空字符串）——缺条件即拒绝；
 *   4. **必须**给出可绑定的数字用量 `dose.number` 与 `dose.unit`；
 *   5. **必须**通过 `evaluateApplicability` 当前适用判定：禁用/限用/禁限用未知、
 *      来源失效/撤回/冲突/未知有效期、下架、模拟、作物/生育期/地区/剂型/成分/场景
 *      任一不符或未采集 → 不渲染。开关关闭不能代替资格验证。
 *   6. **必须**已核对（阻塞 B-1）：记录级与来源级 `review_status` 都**必须显式为** `verified`；
 *      `unverified`/`rejected`/**缺失**一律拒绝，**不取较宽松状态**（来源侧缺失=审核情况未知）。
 *   7. **必须**绑定当前来源版本（阻塞 B-2）：`dose.source_version` 须等于记录当前
 *      `source_version`，否则视为陈旧用量数据并拒绝。
 *   8. **必须**登记制剂身份完整**且与用量绑定一致**（阻塞 B-3）：名称/剂型/成分含量非空，
 *      且 `dose.record_id`／`dose.formulation`（登记号+名称+剂型+成分含量）／`dose.reference`
 *      与当前记录一致 —— 防止同一 `source_version`（如同一公告共享版本）下的
 *      **其他制剂挪用同一张用量卡**。绑定用**显式字段逐项比对**（两端同一套规则，
 *      不依赖任何一端的哈希算法），因此后端同一份已核对的用量 JSON 在两端判定一致。
 *   9. **必须**非模拟来源（阻塞 B-4）：`source.source_kind === 'simulation'` 或登记号
 *      以 `SIM-` 前缀，一律拒绝；`include_simulated` 只放开查阅，不放开真实用量卡片。
 *
 * 结果仍恒不含任何禁用标签（AC14），也不生成个人处方/换算。
 *
 * @param {object} item 内部条目
 * @param {{ doseCardEnabled?: boolean, context?: object }} [opts]
 *   doseCardEnabled 默认 true；context 为适用判定上下文（缺省视为无附加条件）
 * @returns {{ renderable: boolean, reason: string|null, rule_version: string, off_switch_supported: boolean, closed: boolean, applicable?: boolean, blocked?: string[], dose?: {number:string,unit:string,condition:string} }}
 */
export function doseCardDescriptor(item, opts = {}) {
  const doseCardEnabled = opts.doseCardEnabled !== false;
  const base = { rule_version: APPLICABILITY_RULE_VERSION, off_switch_supported: true };

  // 1) 功能开关关闭（附加条件，不代替资格验证）。
  if (!doseCardEnabled) {
    return Object.freeze({ ...base, renderable: false, reason: DISPLAY_LABELS.dose_reject_reason.closed, closed: true });
  }

  // 2) 未采集可用作依据的用量字段。
  if (item?.verification?.usable_as_dose !== true) {
    return Object.freeze({ ...base, renderable: false, reason: DISPLAY_LABELS.dose_reject_reason.not_usable, closed: false });
  }

  // 9) 模拟来源实名判定（阻塞 B-4）：标志位与来源类型/登记号前缀**任一**成立即拒绝。
  if (isSimulated(item)) {
    return Object.freeze({ ...base, renderable: false, reason: DISPLAY_LABELS.dose_reject_reason.simulated_source, closed: false });
  }

  // 6) 已核对审核状态（阻塞 B-1）：记录级与来源级都必须 verified，不取较宽松状态。
  if (!isDoseReviewed(item)) {
    return Object.freeze({ ...base, renderable: false, reason: DISPLAY_LABELS.dose_reject_reason.not_reviewed, closed: false });
  }

  // 8) 登记制剂身份完整且与用量绑定一致（阻塞 B-3 + follow-up 复核）。
  const formulation = hasBoundFormulation(item, item?.verification?.dose);
  if (formulation !== 'ok') {
    const reason = {
      incomplete: DISPLAY_LABELS.dose_reject_reason.incomplete_formulation,
      record_mismatch: DISPLAY_LABELS.dose_reject_reason.dose_record_mismatch,
      formulation_mismatch: DISPLAY_LABELS.dose_reject_reason.dose_formulation_mismatch,
      reference_missing: DISPLAY_LABELS.dose_reject_reason.dose_reference_missing,
    }[formulation];
    return Object.freeze({ ...base, renderable: false, reason, closed: false });
  }

  // 3)+4) 来源必须提供可绑定的数字用量 + 单位 + **原文条件**（缺任一即拒绝，不补写）。
  const dose = item?.verification?.dose;
  const hasNumber = dose && typeof dose.number === 'string' && dose.number.trim() !== '';
  const hasUnit = dose && typeof dose.unit === 'string' && dose.unit.trim() !== '';
  const hasCondition = dose && typeof dose.condition === 'string' && dose.condition.trim() !== '';
  if (!(hasNumber && hasUnit)) {
    return Object.freeze({ ...base, renderable: false, reason: DISPLAY_LABELS.dose_reject_reason.not_usable, closed: false });
  }
  if (!hasCondition) {
    return Object.freeze({ ...base, renderable: false, reason: DISPLAY_LABELS.dose_reject_reason.missing_condition, closed: false });
  }

  // 7) 用量版本绑定当前来源版本（阻塞 B-2）：陈旧用量数据不得因当前来源 valid 而合格。
  if (!isDoseBoundToCurrentSource(item, dose)) {
    return Object.freeze({ ...base, renderable: false, reason: DISPLAY_LABELS.dose_reject_reason.stale_dose, closed: false });
  }

  // 5) 当前适用判定（fail-closed）：任一安全性维度不通过即拒绝渲染。
  const applicability = evaluateApplicability(item, opts.context ?? {});
  if (!applicability.applicable) {
    return Object.freeze({
      ...base,
      renderable: false,
      reason: doseRejectReasonFrom(applicability),
      closed: false,
      applicable: false,
      blocked: Object.freeze(applicability.blocked.slice()),
    });
  }

  return Object.freeze({
    ...base,
    renderable: true,
    reason: null,
    closed: false,
    applicable: true,
    blocked: Object.freeze([]),
    dose: { number: dose.number, unit: dose.unit, condition: dose.condition },
  });
}

/**
 * 阻塞 B-4：是否模拟来源（实名判定，与域库 evaluateEligibility 同口径）。
 * 判据（任一成立）：`item.simulated` 标志、`source.source_kind === 'simulation'`、
 * 登记号以 `SIM-` 前缀。**不看 include_simulated**——该选项只放开「查阅」，
 * 不放开真实用量卡片。实现复用 `query.mjs` 的 `isSimulatedSource`，保证两端同判。
 */
const isSimulated = isSimulatedSource;

/**
 * 阻塞 B-1（监工 follow-up 复核）：记录级与来源级审核状态**都**必须为 `verified`。
 *
 * 关键：来源侧**缺失**（`undefined`）视为**未核对**并拒绝，绝不因记录级 verified 而放行。
 * 真实来源的审核状态来自契约 `SourceRef.review_status`（投影为 `item.source.review_status`）；
 * 若该字段缺失，说明来源审核情况未知 —— 与「已核对」是两件事，不得默认通过。
 */
function isDoseReviewed(item) {
  const recordStatus = item?.verification?.review_status;
  const sourceStatus = item?.source?.review_status;
  // 两侧都必须是合法枚举且都为 verified；任一侧缺失/非 verified/非枚举值 → 拒绝。
  if (!REVIEW_STATUSES.includes(recordStatus) || recordStatus !== 'verified') return false;
  if (!REVIEW_STATUSES.includes(sourceStatus) || sourceStatus !== 'verified') return false;
  return true;
}

/**
 * 阻塞 B-3（监工 follow-up 复核）：登记制剂身份**完整且与用量绑定一致**。
 *
 * 为什么不用 `formulationIdentityHash` 做跨端绑定：该函数是 SHA-256（域库有 `node:crypto`），
 * 小程序端无法在不引依赖的前提下复现同一摘要 —— 若小程序另算一个键，就等于「后端同一份
 * 已核对的记录及用量 JSON」在两端被解释成不同身份，正是本次要消除的跨端不同判。
 *
 * 因此绑定语义改为**显式字段逐项比对**（两端同一套规则、无哈希依赖）：
 *   - `registered_name` / `dosage_form` / `ingredients_text` 均为非空字符串；
 *   - `dose.record_id` 与 `item.record_id` **都存在且相等**（缺任一即拒绝，
 *     不因 `'' === ''` 被误当绑定）；
 *   - `dose.formulation` 与当前记录的「登记号 + 名称 + 剂型 + 成分含量」逐项相等
 *     （防止同一 `source_version` —— 如同一公告共享版本 —— 下的其他制剂挪用同一张卡）；
 *   - `dose.reference` 为非空字符串（原文引用/定位依据）。
 *
 * @returns {'ok'|'incomplete'|'record_mismatch'|'formulation_mismatch'|'reference_missing'}
 */
function hasBoundFormulation(item, dose) {
  const name = nonEmpty(item?.registered_name);
  const form = nonEmpty(item?.dosage_form);
  const ingredients = nonEmpty(item?.ingredients_text);
  if (name === '' || form === '' || ingredients === '') return 'incomplete';
  // 绑定到具体登记记录：两侧都必须存在且相等（不得因双缺 `'' === ''` 放行）。
  const boundRecord = nonEmpty(dose?.record_id);
  const currentRecord = nonEmpty(item?.record_id);
  if (boundRecord === '' || currentRecord === '' || boundRecord !== currentRecord) return 'record_mismatch';
  // 绑定到具体制剂身份：登记号 + 名称 + 剂型 + 成分含量逐项相等。
  const bound = dose?.formulation;
  if (!bound || typeof bound !== 'object') return 'formulation_mismatch';
  const sameRegistration = nonEmpty(bound.registration_number) !== '' && nonEmpty(bound.registration_number) === nonEmpty(item?.registration_number);
  const sameName = nonEmpty(bound.registered_name) === name;
  const sameForm = nonEmpty(bound.dosage_form) === form;
  const sameIngredients = nonEmpty(bound.ingredients_text) === ingredients;
  if (!(sameRegistration && sameName && sameForm && sameIngredients)) return 'formulation_mismatch';
  // 原文引用/定位依据。
  if (nonEmpty(dose?.reference) === '') return 'reference_missing';
  return 'ok';
}

/** 非空字符串归一（去首尾空白）；非字符串或空串返回 ''。 */
function nonEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 阻塞 B-2（监工 follow-up 复核）：用量必须绑定**当前**来源版本。
 * `dose.source_version` 须等于记录当前 `source_version`；缺失或不匹配一律拒绝
 * （陈旧用量数据不得因当前 `source_validity=valid` 而合格）。
 */
function isDoseBoundToCurrentSource(item, dose) {
  const bound = nonEmpty(dose?.source_version);
  if (bound === '') return false;
  return bound === nonEmpty(item?.source_version);
}

/** 由适用判定结论派生 DoseCard 拒绝原因（可读、逐项、无禁用词）。
 *  判别顺序：先「未采集」→ 再「限用」→ 后「禁用」。注意「未采集禁限用状态」文案
 *  本身含「禁用」二字，故不能先用 includes('禁用') 判别（会把未知误判为禁用）。 */
function doseRejectReasonFrom(applicability) {
  const b = applicability.blocked ?? [];
  if (b.includes('banned_restricted')) {
    if (applicability.reasons.some((r) => r.includes('未采集禁限用'))) return DISPLAY_LABELS.dose_reject_reason.restriction_unknown;
    if (applicability.reasons.some((r) => r.includes('限用'))) return DISPLAY_LABELS.dose_reject_reason.restricted;
    return DISPLAY_LABELS.dose_reject_reason.banned;
  }
  if (b.includes('valid_source')) return DISPLAY_LABELS.dose_reject_reason.invalid_source;
  return DISPLAY_LABELS.dose_reject_reason.not_applicable;
}

/**
 * 种子资料（整理稿）标签。
 * 指挥提供的结构化种子数据 `data_origin=seed_unverified / authority=none`：
 * 展示**必须**带「待核实·非权威」，且**不得**声称可追溯权威来源。
 */
export function seedLabel() {
  return SEED_REQUIRED_LABEL;
}

/** 组装种子记录的展示标签（含强制「待核实·非权威」；用量恒不展示）。 */
export function describeSeedRecord(item) {
  const labels = {
    seed: SEED_REQUIRED_LABEL,
    data_origin: item?.seed?.data_origin ?? '',
    authority: item?.seed?.authority ?? '',
    evidence_kind: evidenceKindLabel(item?.evidence_kind),
    review_status: reviewStatusLabel('unverified'),
    dose: doseDisplayFor(item),
  };
  for (const v of Object.values(labels)) assertNoForbiddenLabel(v);
  return Object.freeze(labels);
}

/** 组装一个记录卡的全部展示标签（供页面直接渲染）。 */
export function describeRecord(item) {
  const labels = {
    source_kind: sourceKindLabel(item?.source?.source_kind),
    evidence_kind: evidenceKindLabel(item?.source?.evidence_kind),
    review_status: reviewStatusLabel(item?.source?.review_status ?? item?.verification?.review_status),
    reference_state: referenceStateLabel(item?.reference_state),
    record_status: recordStatusLabel(item),
    dose: doseDisplayFor(item),
  };
  for (const v of Object.values(labels)) assertNoForbiddenLabel(v);
  return Object.freeze(labels);
}

export { DISPLAY_LABELS, FORBIDDEN_LABELS };
