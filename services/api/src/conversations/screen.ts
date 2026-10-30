/**
 * GY-I12（#12）· 问题与**资料原文**的风险/注入筛查（问答域的唯一接入点）。
 *
 * 纪律（派单 §1）：
 *   - **复用** `packages/moderation` 现成的规则层，**不新写第二套**规则。问题侧与资料侧只取
 *     `category ∈ {dangerous_usage, prompt_injection}` 的规则（当前即 MR-01/MR-02/MR-07：
 *     混配/复配、用量无界、提示注入）；**答案侧另立一套 4 类**（再加 `authority_spoofing`
 *     MR-08、`safety_claim` MR-09）。其余类别（隐私、导流）属别的片的判定面，本文件不重复实现。
 *   - 两侧**不共用**类别集（`RISK_SCREEN_CATEGORIES` vs `ANSWER_SCREEN_CATEGORIES`）：资料侧今天
 *     已有真实误剔（`rules.mjs` 的 `/混配|复配/` 是裸名词，「…如唑草酮、2甲4氯复配）」这条资料在
 *     2 类配置下就被判 `MR-01/DANGEROUS_MIX`），把问题侧/资料侧一起扩会把雷区一起放大。
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

/** 问题侧与资料侧消费的规则类别（**只这两个**；新增类别属于扩大范围，必须另走派单 —— 答案侧的那份在下面另立）。 */
export const RISK_SCREEN_CATEGORIES = Object.freeze(['dangerous_usage', 'prompt_injection'] as const);

const CATEGORY_SET: ReadonlySet<string> = new Set<string>(RISK_SCREEN_CATEGORIES);

/**
 * **答案侧**（`screenAnswer`）单独消费的类别：原两类 + 权威冒充（MR-08）+ 绝对安全宣称（MR-09）。
 *
 * 为什么答案侧可以比问题侧/资料侧宽：被扫的是**候选回答正文**（模型生成或确定性拼装），
 * 它直接交付用户，且不参与检索；问题侧/资料侧扩大类别则会先撞上资料侧的裸名词误剔。
 * 顺序固定（前两条与 `RISK_SCREEN_CATEGORIES` 相同，后两条是新增面），T1 逐条对齐。
 */
export const ANSWER_SCREEN_CATEGORIES = Object.freeze([
  'dangerous_usage',
  'prompt_injection',
  'authority_spoofing',
  'safety_claim',
] as const);

const ANSWER_CATEGORY_SET: ReadonlySet<string> = new Set<string>(ANSWER_SCREEN_CATEGORIES);

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

/**
 * 回答被风险/注入筛查拦下时的**固定话术**（与问题侧 `RISK_BLOCK_TEXT` 区分开：
 * 用户能看出"拦的是回答内容"而不是"问题本身"，也不会看到被拦正文的任何片段）。
 *
 * 为什么回答侧还要再筛一遍：自由正文（尤其是语言模型生成的那一段）不能绕过既有的用药安全
 * 边界 —— 引用已经同源、结构已经合法，也不等于正文本身没有危险用法/注入特征，更不等于它
 * 没在冒充权威（`authority_spoofing`）或打包票说绝对安全（`safety_claim`）：后两类正是
 * 答案侧比问题侧/资料侧多出来的判定面，话术里一并点名，免得用户被拦了却不知道踩了哪条。
 */
export const ANSWER_RISK_BLOCK_TEXT =
  '本回答已被输出侧风险筛查阻断：候选回答正文含危险用法、提示注入、冒充权威或对安全性的过度承诺特征' +
  '（或筛查无法判定），因此不展示该回答，也不提供任何结论、用量或混配建议。' +
  '请改为查阅资料页的核准用法。';

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
  /**
   * 命中的规则类别：问题侧/资料侧只可能是 `dangerous_usage` / `prompt_injection`；答案侧还可能是
   * `authority_spoofing` / `safety_claim`。未命中为空数组。
   */
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
  /** 问题侧与资料侧消费的类别（两类别；不随答案侧扩大而变）。 */
  readonly categories: readonly string[];
  /** 与 `categories` 对应的规则版本（问题侧/资料侧口径）。 */
  readonly rule_version: string;
  /** 答案侧**单独**消费的类别（四类别：两类别 + `authority_spoofing` + `safety_claim`）。 */
  readonly answer_categories: readonly string[];
  /** 与 `answer_categories` 对应的规则版本（必须与 `rule_version` 不同：两侧用的不是同一个子集）。 */
  readonly answer_rule_version: string;
  /** 问题侧筛查：命中/未能判定 ⇒ `blocked === true`（调用方整轮拒答，不生成）。 */
  screenQuestion(input: { turnId: string; text: string }): RiskVerdict;
  /** 来源侧筛查：命中的条目从集合中剔除（调用方只用返回的 `items` 继续生成）。 */
  screenSources(input: { turnId: string; items: readonly RetrievalItem[] }): RiskSourceScreenResult;
  /**
   * 回答侧筛查（第三道）：自由正文在交付用户**之前**过同一规则层。
   *
   * 命中/未能判定 ⇒ `blocked === true`（调用方整条降级为阻断话术）。空正文由调用方跳过
   * （空正文走守卫的"资料不足"路径，不该被当成"命中"）。
   */
  screenAnswer(input: { turnId: string; text: string }): RiskVerdict;
}

export interface RiskScreenDeps {
  /**
   * 规则子集（缺省 = 规则目录全部，进来后再按各侧类别集过滤：问题侧/资料侧 2 类、答案侧 4 类；
   * 注入只用于负控制，不改默认行为）。
   */
  rules?: ReadonlyArray<ModerationRuleDescriptor>;
  /**
   * 规则层的时钟（**可选**，只供确定性测试注入冻结时钟）。
   *
   * 缺省（不传 / `undefined`）⇒ 规则层沿用自带的 `Date.now`，与不传该字段**逐字等价**。
   * 注入它**不改**预算、不改判定口径、不放宽超时：超时仍是 `quarantined`（fail-closed）。
   */
  clock?: () => number;
  /**
   * 规则层单次扫描的预算（毫秒，**可选**，只供确定性测试显式给定）。
   *
   * 缺省（不传 / `undefined`）⇒ 规则层沿用 `DEFAULT_RULE_BUDGET_MS`（50ms 墙钟，
   * 超时 ⇒ `RULE_TIMEOUT` ⇒ `quarantined`）。**默认值不在这里改**。
   */
  budget_ms?: number;
}

/** 类别数组 → 只读集合（两个常量集合复用预构建的那份；只有调用方自带数组时才新建）。 */
function categorySetOf(categories: readonly string[]): ReadonlySet<string> {
  if (categories === RISK_SCREEN_CATEGORIES) return CATEGORY_SET;
  if (categories === ANSWER_SCREEN_CATEGORIES) return ANSWER_CATEGORY_SET;
  return new Set<string>(categories);
}

/**
 * 从规则目录里选出本文件消费的规则（**不复制规则正文**，只按类别过滤）。
 *
 * 两个参数都带缺省值：`selectRiskRules()` 的既有调用逐字等价（仍取
 * `RISK_SCREEN_CATEGORIES` 两类）；答案侧显式传 `ANSWER_SCREEN_CATEGORIES`。
 */
export function selectRiskRules(
  rules: ReadonlyArray<ModerationRuleDescriptor> = RULES,
  categories: readonly string[] = RISK_SCREEN_CATEGORIES,
): ModerationRuleDescriptor[] {
  const categorySet = categorySetOf(categories);
  return rules.filter((rule) => categorySet.has(rule.category));
}

/** 默认规则子集（问题侧/资料侧两类别；顺序沿用规则目录，便于逐条追溯）。 */
export const RISK_RULES: ReadonlyArray<ModerationRuleDescriptor> = Object.freeze(selectRiskRules());

/** 默认子集的规则版本（与 `evaluateHardRules` 内部 `deriveRuleVersion` 同源同参）。 */
export const RISK_RULE_VERSION = deriveRuleVersion(RISK_RULES, { ...MATCHERS }, { ...MATCHER_REVISIONS });

/** 答案侧规则子集（四类别；顺序沿用规则目录 ⇒ 前三条同 `RISK_RULES`，后两条是 MR-08/MR-09）。 */
export const ANSWER_RISK_RULES: ReadonlyArray<ModerationRuleDescriptor> = Object.freeze(
  selectRiskRules(RULES, ANSWER_SCREEN_CATEGORIES),
);

/** 答案侧规则版本（与 `RISK_RULE_VERSION` 同一派生口径；两者必然不同，见 T2）。 */
export const ANSWER_RISK_RULE_VERSION = deriveRuleVersion(ANSWER_RISK_RULES, { ...MATCHERS }, { ...MATCHER_REVISIONS });

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
  // 答案侧：同一份目录、不同的类别集（注入 `deps.rules` 时按 4 类过滤——注入只换目录，不换口径）。
  const answerRules = selectRiskRules(deps.rules ?? RULES, ANSWER_SCREEN_CATEGORIES);
  const answerRuleVersion = deriveRuleVersion(answerRules, { ...MATCHERS }, { ...MATCHER_REVISIONS });
  // 注入缝（**可选**）：两个字段都缺省时，下面的 `ruleOptions` 与改动前逐字等价——只有
  // `rules` 一个键，规则层照旧用 `Date.now` + 默认 50ms 预算。注入后也只是把时钟/预算
  // **原样**交给规则层，判定口径（含超时 ⇒ `quarantined`）一行未改。
  const clock = deps.clock;
  const budgetMs = deps.budget_ms;

  /**
   * 对一段文本求值（可能分块）。`targetId` 只用于规则层的 `target_ref`（≤ 80 字符；
   * 调用方传轮次 id），**不**参与判定，也不会进返回值。
   *
   * `activeRules`／`activeRuleVersion` 由入口**显式**传入（问题侧/资料侧 2 类，答案侧 4 类）：
   * 判定逻辑一处不复制，两侧唯一的差别是"哪些规则进这一轮"。
   */
  function screen(
    text: string,
    targetId: string,
    activeRules: ReadonlyArray<ModerationRuleDescriptor>,
    activeRuleVersion: string,
  ): RiskVerdict {
    const reasonCodes: string[] = [];
    const ruleIds: string[] = [];
    const categories: string[] = [];
    let decision: RiskDecision = 'approved';

    for (const chunk of chunksOf(text)) {
      let outcome: RuleLayerOutcome;
      try {
        outcome = evaluateHardRules(
          { target_ref: { type: 'answer', id: targetId, revision: 1 }, text: chunk, media: [] },
          {
            rules: [...activeRules],
            // 条件展开：未注入时对象里**没有**这两个键（与改动前的 `{ rules: [...] }` 逐字等价）。
            ...(clock === undefined ? {} : { clock }),
            ...(budgetMs === undefined ? {} : { budget_ms: budgetMs }),
          },
        );
      } catch {
        // 规则层抛错 ⇒ 无法判定 ⇒ fail-closed（不把"没扫成"当成"没问题"）。
        return {
          blocked: true,
          decision: 'quarantined',
          reason_codes: ['RULE_ENGINE_ERROR'],
          rule_ids: [],
          categories: [],
          rule_version: activeRuleVersion,
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
      rule_version: activeRuleVersion,
    };
  }

  return {
    kind: 'moderation_rule_layer',
    note:
      '风险/注入筛查（复用 packages/moderation 的规则层：问题侧与资料侧只用 ' +
      'dangerous_usage + prompt_injection，答案侧另加 authority_spoofing + safety_claim；' +
      '命中或未能判定一律拦截，证据只回原因码不回原文）',
    categories: RISK_SCREEN_CATEGORIES,
    rule_version: ruleVersion,
    answer_categories: ANSWER_SCREEN_CATEGORIES,
    answer_rule_version: answerRuleVersion,
    screenQuestion({ turnId, text }) {
      // 问题侧：仍是 2 类（扩大它等于把资料侧的既有误剔一起放大，见文件头纪律）。
      return screen(text, turnId, rules, ruleVersion);
    },
    screenSources({ turnId, items }) {
      const kept: RetrievalItem[] = [];
      const rejectedCitations: string[] = [];
      const reasonCodes: string[] = [];
      for (const item of items) {
        // 筛查资料**原文**（标题 + 正文）：两者都会进入生成侧，任一处带危险用法/注入都算污染。
        const verdict = screen(`${item.title}\n${item.body}`, turnId, rules, ruleVersion);
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
    screenAnswer({ turnId, text }) {
      // 同一条规则层、同一预算、同一 fail-closed 口径；只有被扫的文本与**类别集**不同（4 类）。
      return screen(text, turnId, answerRules, answerRuleVersion);
    },
  };
}
