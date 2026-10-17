/**
 * GY-I12（#12）· 问题与**资料原文**的风险/注入筛查（问答域的唯一接入点）。
 *
 * 纪律（派单 §1）：
 *   - **复用** `packages/moderation` 现成的规则层，**不新写第二套**规则：只取
 *     `category ∈ {dangerous_usage, prompt_injection}` 的规则（当前即 MR-01/MR-02/MR-07：
 *     混配/复配、用量无界、提示注入），其余类别（隐私、权威冒充、绝对安全宣称、导流）
 *     属别的片的判定面，本文件不重复实现、也不扩大范围。
 *   - 判定一律走 `evaluateHardRules`（规则层唯一入口），并沿用它的口径：
 *     `rejected` = 规则命中；`quarantined` = **未能判定**（输入不可扫、规则报错/超时/截断等）；
 *     `approved` = 扫过且未命中。`quarantined` 同样是**拦截**：把"没扫成"读成"没问题"
 *     正是这类闸门最危险的失效方式（fail-closed）。
 *   - 证据只回**偏移与原因码**（规则层口径），本文件**不**把命中原文写进任何返回值/日志。
 *     `checked_text` 只放固定话术（`RISK_BLOCK_TEXT`），不含原文片段。
 *
 * 为什么是"问题侧 + 来源侧"两道：
 *   - 问题侧命中 ⇒ 整轮拒答（不检索、不生成、不进守卫、不给任何结论或用量）；
 *   - 来源侧命中 ⇒ 该条从**本次检索集合**里剔除（不参与生成、不可能成为引用或用量卡来源），
 *     剔除后若集合为空 ⇒ 自然落到守卫既有的「资料不足」路径（不编造依据）。
 */

import {
  MATCHERS,
  MATCHER_REVISIONS,
  RULES,
  deriveRuleVersion,
  evaluateHardRules,
  type ModerationRuleDescriptor,
  type RuleLayerOutcome,
} from '../../../../packages/moderation/index.mjs';
import type { RetrievalItem } from './guard.ts';

/** 本文件消费的规则类别（**只这两个**；新增类别属于扩大范围，必须另走派单）。 */
export const RISK_SCREEN_CATEGORIES = Object.freeze(['dangerous_usage', 'prompt_injection'] as const);

const CATEGORY_SET: ReadonlySet<string> = new Set<string>(RISK_SCREEN_CATEGORIES);

/** 规则层单次扫描的字符上限（`packages/moderation/validate-input.mjs#MAX_TEXT_LENGTH`）。 */
export const RISK_SCREEN_CHUNK = 20_000;
/** 分块重叠：模式可能跨块边界，重叠窗口避免"边界上的命中"被漏掉（不漏 ⇒ 不产生盲区）。 */
const RISK_CHUNK_OVERLAP = 64;

/**
 * 问题被风险/注入筛查拦下时的**固定话术**（派单 §2：`checked_text` 用固定话术）。
 *
 * 硬约束：不含命中原文、不给任何结论/用量/混配建议、不暴露规则内部细节；同时把
 * "已拦截"与守卫的"资料不足"（`insufficient`）在响应里区分开（两种状态文本不同）。
 */
export const RISK_BLOCK_TEXT =
  '本问题已被风险/注入筛查阻断：问题含危险用法或提示注入特征（或筛查无法判定），' +
  '因此不生成回答、不提供任何结论、用量或混配建议。请改为查阅资料页的核准用法。';

/** 资料条目被风险/注入筛查剔除时，记入 `rejected_citations` 的前缀（与守卫的既有原因区分）。 */
export const RISK_SOURCE_REJECTION_PREFIX = 'source_risk:';

/** 规则层决策（`pending` 只作防御性保留：规则层不会产出它，出现即按 fail-closed 处理）。 */
export type RiskDecision = 'approved' | 'rejected' | 'quarantined' | 'pending';

/** 一次文本筛查的结论（**不含原文**：只有决策、原因码、命中规则 id 与版本）。 */
export interface RiskVerdict {
  /** `decision !== 'approved'` 即拦截（`rejected` 命中；`quarantined` 未能判定）。 */
  blocked: boolean;
  decision: RiskDecision;
  /** 规则层给出的原因码（命中码如 `DANGEROUS_MIX`；未能判定则为 fail-closed 码）。 */
  reason_codes: string[];
  /** 命中的规则 id（如 `MR-01`）；未命中为空数组。 */
  rule_ids: string[];
  /** 命中的规则类别（`dangerous_usage` / `prompt_injection`）；未命中为空数组。 */
  categories: string[];
  /** 本次筛查所用的规则版本（`deriveRuleVersion`，与规则层同源）。 */
  rule_version: string;
}

/** 来源侧筛查结论：保留的条目 + 剔除清单（剔除原因带条目 id，可追溯到具体来源）。 */
export interface RiskSourceScreenResult {
  /** 通过筛查的条目（顺序与读面一致；剔除项不在其中）。 */
  items: RetrievalItem[];
  /** 剔除清单，形如 `source_risk:<item.id>:<原因码[+原因码]>`（与守卫的拒绝词汇区分）。 */
  rejected_citations: string[];
  /** 剔除原因码的并集（去重、首次出现顺序）。 */
  reason_codes: string[];
  rule_version: string;
}

export interface RiskScreen {
  readonly kind: 'moderation_rule_layer';
  readonly note: string;
  readonly categories: readonly string[];
  readonly rule_version: string;
  /** 问题侧筛查：命中/未能判定 ⇒ `blocked === true`（调用方整轮拒答，不生成）。 */
  screenQuestion(input: { turnId: string; text: string }): RiskVerdict;
  /** 来源侧筛查：命中的条目从集合中剔除（调用方只用返回的 `items` 继续生成）。 */
  screenSources(input: { turnId: string; items: readonly RetrievalItem[] }): RiskSourceScreenResult;
}

export interface RiskScreenDeps {
  /** 规则子集（缺省 = 两类别全部规则；注入只用于负控制，不改默认行为）。 */
  rules?: ReadonlyArray<ModerationRuleDescriptor>;
}

/** 从规则目录里选出本文件消费的两类规则（**不复制规则正文**，只按类别过滤）。 */
export function selectRiskRules(
  rules: ReadonlyArray<ModerationRuleDescriptor> = RULES,
): ModerationRuleDescriptor[] {
  return rules.filter((rule) => CATEGORY_SET.has(rule.category));
}

/** 默认规则子集（两类别；顺序沿用规则目录，便于逐条追溯）。 */
export const RISK_RULES: ReadonlyArray<ModerationRuleDescriptor> = Object.freeze(selectRiskRules());

/** 默认子集的规则版本（与 `evaluateHardRules` 内部 `deriveRuleVersion` 同源同参）。 */
export const RISK_RULE_VERSION = deriveRuleVersion(RISK_RULES, { ...MATCHERS }, { ...MATCHER_REVISIONS });

/** 决策的严格度排序：分块/多条目合并时取**更严格**的那个（宁可拦，不可漏）。 */
const DECISION_RANK: Readonly<Record<RiskDecision, number>> = Object.freeze({
  approved: 0,
  pending: 1,
  quarantined: 2,
  rejected: 3,
});

/** 按规则层的字符上限切块（短文本即单块；重叠窗口避免跨块漏判）。 */
function chunksOf(text: string): string[] {
  if (text.length <= RISK_SCREEN_CHUNK) return [text];
  const chunks: string[] = [];
  const step = RISK_SCREEN_CHUNK - RISK_CHUNK_OVERLAP;
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + RISK_SCREEN_CHUNK));
    if (start + RISK_SCREEN_CHUNK >= text.length) break;
  }
  return chunks;
}

function pushUnique(target: string[], values: readonly string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

export function createModerationRiskScreen(deps: RiskScreenDeps = {}): RiskScreen {
  const rules = selectRiskRules(deps.rules ?? RULES);
  const ruleVersion = deriveRuleVersion(rules, { ...MATCHERS }, { ...MATCHER_REVISIONS });

  /**
   * 对一段文本求值（可能分块）。`targetId` 只用于规则层的 `target_ref`（≤ 80 字符；
   * 调用方传轮次 id），**不**参与判定，也不会进返回值。
   */
  function screen(text: string, targetId: string): RiskVerdict {
    const reasonCodes: string[] = [];
    const ruleIds: string[] = [];
    const categories: string[] = [];
    let decision: RiskDecision = 'approved';

    for (const chunk of chunksOf(text)) {
      let outcome: RuleLayerOutcome;
      try {
        outcome = evaluateHardRules(
          { target_ref: { type: 'answer', id: targetId, revision: 1 }, text: chunk, media: [] },
          { rules: [...rules] },
        );
      } catch {
        // 规则层抛错 ⇒ 无法判定 ⇒ fail-closed（不把"没扫成"当成"没问题"）。
        return {
          blocked: true,
          decision: 'quarantined',
          reason_codes: ['RULE_ENGINE_ERROR'],
          rule_ids: [],
          categories: [],
          rule_version: ruleVersion,
        };
      }
      const engineDecision = outcome.decision as RiskDecision;
      if (DECISION_RANK[engineDecision] > DECISION_RANK[decision]) decision = engineDecision;
      pushUnique(reasonCodes, outcome.reason_codes);
      for (const entry of outcome.rules) {
        if (entry.status !== 'hit') continue;
        pushUnique(ruleIds, [entry.id]);
        pushUnique(categories, [entry.category]);
      }
    }

    return {
      blocked: decision !== 'approved',
      decision,
      reason_codes: reasonCodes,
      rule_ids: ruleIds,
      categories,
      rule_version: ruleVersion,
    };
  }

  return {
    kind: 'moderation_rule_layer',
    note:
      '风险/注入筛查（复用 packages/moderation 的 dangerous_usage + prompt_injection 规则层；' +
      '命中或未能判定一律拦截，证据只回原因码不回原文）',
    categories: RISK_SCREEN_CATEGORIES,
    rule_version: ruleVersion,
    screenQuestion({ turnId, text }) {
      return screen(text, turnId);
    },
    screenSources({ turnId, items }) {
      const kept: RetrievalItem[] = [];
      const rejectedCitations: string[] = [];
      const reasonCodes: string[] = [];
      for (const item of items) {
        // 筛查资料**原文**（标题 + 正文）：两者都会进入生成侧，任一处带危险用法/注入都算污染。
        const verdict = screen(`${item.title}\n${item.body}`, turnId);
        if (!verdict.blocked) {
          kept.push(item);
          continue;
        }
        const code = verdict.reason_codes.length > 0 ? verdict.reason_codes.join('+') : verdict.decision;
        rejectedCitations.push(`${RISK_SOURCE_REJECTION_PREFIX}${item.id}:${code}`);
        pushUnique(reasonCodes, verdict.reason_codes);
      }
      return { items: kept, rejected_citations: rejectedCitations, reason_codes: reasonCodes, rule_version: ruleVersion };
    },
  };
}
