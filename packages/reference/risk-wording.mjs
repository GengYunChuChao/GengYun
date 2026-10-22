/**
 * GY-I08 · **输出侧**风险文字守卫（issue #8 验收：风险文字禁止「绝对安全／零药害」承诺）。
 *
 * 与 `constants.mjs` 的 `FORBIDDEN_LABELS` 是什么关系？
 *   `FORBIDDEN_LABELS` 是**全仓通用**的展示层禁用词（8 条，来自 AC22 / F03 / F14），
 *   `labels.mjs` 的 `assertNoForbiddenLabel()` 只对**我们生成的标签**逐条校验。
 *   本文件补的是它在「可执行建议 / 问答回答 / 用量卡」这三条**输出通道**上的缺口：
 *     1. 覆盖面：把「无风险」「零风险」「百分百安全」「不伤苗」这类**承诺式**说法
 *        也纳入（`FORBIDDEN_LABELS` 没有），并做空白归一化，防「绝对 安全」绕过；
 *     2. 通道语义：守卫只作用于**产品输出**（我们写的话），不作用于**来源原文引用** ——
 *        产业原文里确实会出现「无残留、不淋溶」（例如浙江批次 `zj-herbicide-r92` 的
 *        `hazard_detail_text`）。原文必须原样引用并标注出处，那是「来源说了什么」，
 *        不是「我们承诺了什么」。把两者混为一谈会逼人改真实资料，反过来降低证据可信度。
 *     3. 不静默：命中即给**机器可读的码**（`RISK_WORDING_FORBIDDEN`）与命中词位置，
 *        供 API 层映射成「不可执行建议」而不是 500，也不是放过。
 *
 * 定位：纯函数、无 IO、无依赖（除 `constants.mjs` 的禁用词表），可被域库、API 装配层、
 * 小程序镜像与测试共同引用。
 */

import { FORBIDDEN_LABELS } from './constants.mjs';

/** 策略版本：术语表或归一化规则变动时 bump，便于证据页按版本核对。 */
export const RISK_WORDING_POLICY_VERSION = 'gy-i08-risk/1.0.0';

/** 守卫覆盖的**输出通道**（产品自己写的话；来源原文引用不在其中，见文件头说明）。 */
export const OUTPUT_CHANNELS = Object.freeze([
  'executable_advice',
  'qa_answer',
  'dose_card',
  'display_label',
  'reason',
]);

/**
 * 输出侧补充的**承诺式**说法（`FORBIDDEN_LABELS` 之外）。
 *
 * 入选标准：把「风险不确定」说成「风险为零/不存在」，或把「未见药害」说成
 * 「不会产生药害」。这类说法在农业场景里是**承诺**，不是描述。
 */
export const OUTPUT_RISK_COMMITMENTS = Object.freeze([
  '无风险',
  '零风险',
  '0风险',
  '无任何风险',
  '绝对无害',
  '完全无害',
  '绝对可靠',
  '百分百安全',
  '100%安全',
  '100％安全',
  '万无一失',
  '无副作用',
  '零副作用',
  '零残留',
  '无残留',
  '包治',
  '保治',
  '不伤苗',
  '绝对不伤苗',
]);

/**
 * 生效术语表 = 全仓禁用词 ∪ 输出侧承诺词（去重、保持稳定顺序）。
 * 顺序稳定是为了让错误信息与证据页可逐条比对。
 */
export const RISK_WORDING_TERMS = Object.freeze([
  ...new Set([...FORBIDDEN_LABELS, ...OUTPUT_RISK_COMMITMENTS]),
]);

/** 命中风险承诺词时抛出的错误（`code` 机器可读，便于映射为「不可执行建议」）。 */
export class RiskWordingError extends Error {
  /**
   * @param {string} text 被检查的原文（仅用于消息，不含敏感内容）
   * @param {ReadonlyArray<{ term: string, index: number }>} hits 命中项
   * @param {string} [channel] 输出通道
   */
  constructor(text, hits, channel) {
    const terms = hits.map((hit) => hit.term);
    super(`输出文案含风险承诺词：${terms.join('、')}${channel ? `（通道 ${channel}）` : ''} —— ${String(text).slice(0, 120)}`);
    this.name = 'RiskWordingError';
    this.code = 'RISK_WORDING_FORBIDDEN';
    this.channel = channel ?? null;
    this.hits = Object.freeze(hits.map((hit) => Object.freeze({ ...hit })));
    this.terms = Object.freeze(terms);
  }
}

/** 归一化：去空白（含全角空格、不换行空格），避免「绝对 安全」「零 药害」绕过。 */
function normalize(text) {
  return String(text ?? '').replace(/[\s\u00a0\u3000]+/g, '');
}

/**
 * 扫描一段输出文案。
 * @param {unknown} text
 * @returns {{ ok: boolean, hits: ReadonlyArray<{ term: string, index: number }> }}
 *   `index` 是**归一化后**文本里的下标（仅用于定位，不用于切分原文）。
 */
export function scanRiskWording(text) {
  const normalized = normalize(text);
  const hits = [];
  for (const term of RISK_WORDING_TERMS) {
    const index = normalized.indexOf(term);
    if (index >= 0) hits.push({ term, index });
  }
  // 稳定排序：先按出现位置，再按词长（长词优先，便于人读）
  hits.sort((a, b) => (a.index - b.index) || (b.term.length - a.term.length));
  return { ok: hits.length === 0, hits: Object.freeze(hits.map((hit) => Object.freeze(hit))) };
}

/**
 * 断言一段输出文案不含风险承诺（命中即抛 `RiskWordingError`）。
 * @param {unknown} text
 * @param {{ channel?: string }} [opts]
 * @returns {string} 原样返回 `text`（便于链式使用）
 */
export function assertRiskWordingSafe(text, opts = {}) {
  const { hits } = scanRiskWording(text);
  if (hits.length > 0) throw new RiskWordingError(text, hits, opts.channel);
  return text;
}

/**
 * 非抛出版守卫：命中时**返回不可输出**的判定（`ok=false` 且 `text=null`），
 * 让调用方必须显式处理「拿不到文案」这条分支，而不是继续把文案拼进响应。
 * @param {unknown} text
 * @param {{ channel?: string }} [opts]
 */
export function guardOutputText(text, opts = {}) {
  const { ok, hits } = scanRiskWording(text);
  return Object.freeze({
    ok,
    channel: opts.channel ?? null,
    text: ok ? String(text) : null,
    hits,
    code: ok ? null : 'RISK_WORDING_FORBIDDEN',
    policy_version: RISK_WORDING_POLICY_VERSION,
  });
}

/** 策略摘要（供文档/证据页与测试打印，避免各处手抄术语表）。 */
export function describeRiskWordingPolicy() {
  return Object.freeze({
    policy_version: RISK_WORDING_POLICY_VERSION,
    channels: OUTPUT_CHANNELS,
    terms: RISK_WORDING_TERMS,
    inherited: Object.freeze([...FORBIDDEN_LABELS]),
    added: Object.freeze([...OUTPUT_RISK_COMMITMENTS]),
    normalization: 'strip-whitespace',
    applies_to: '产品输出（可执行建议/问答/用量卡/标签/原因），不作用于来源原文引用',
  });
}
