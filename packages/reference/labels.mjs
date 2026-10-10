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

import { DISPLAY_LABELS, FORBIDDEN_LABELS, SEED_REQUIRED_LABEL } from './constants.mjs';

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
