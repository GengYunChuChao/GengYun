/**
 * GY-I12（#12）· **输出守卫**：回答里的引用与用量卡只能来自确定性权威路径。
 *
 * 契约与判据（本文件是唯一执行点）：
 *  1. **引用只能取自本次检索集合**。检索集合 = 本次请求实际读到的条目（`/knowledge`
 *     同源读面：数据库读视图 `catalog_read.current_knowledge` + 同一模式门与同一显式开关下的
 *     浙江首批投影）。守卫按**逐字段双相等**核对：
 *       - 引用必须对应集合内某个条目的 `id`；
 *       - 引用的 `id`/`version`/`title`/`url`/`publisher`/`source_kind`/`evidence_kind`/`validity`/
 *         `review_status`/`updated_at` 必须与该条目自带的来源对象**逐字段相同**。
 *     集合外引用、字段被改写过的引用、集合内 id 但来源字段对不上的引用 —— **一律拒绝**。
 *  2. **用量卡只能取自确定性权威路径**（`packages/reference` 的 `doseCardDescriptor`，
 *     GY-I08 规则版本 + 阻断闭集）。只有在**该条目确实在本次检索集合内**、且描述子判定
 *     `renderable === true` 时，用量卡才被允许产出。
 *
 * 「拒绝不是静默丢弃」（派单 §3 第 5 项）——拒绝有**两条**如实出口，二选一，绝不静默：
 *   - `check_state: 'blocked'` + `status: 'blocked'`：**检测到违规**（引用/用量卡越出权威路径）。
 *     此时正文替换为阻断说明（**不产出违规正文**），引用与用量卡只保留**通过守卫的那部分**。
 *   - `status: 'insufficient'` + `check_state: 'passed'`：没有检测到违规，但权威路径**给不出**
 *     该问题的依据（检索集合为空、或集合内没有任何可用来源）⇒ 如实置"资料不足"，
 *     绝不编造引用、绝不给出用量。
 *
 * 机器可判据（回归用例逐条锁住）：
 *   - 越出集合的引用 ⇒ 该引用**不出现在** `citations` 里，且 `check_state === 'blocked'`；
 *   - 未经确定性判定的用量卡 ⇒ 该卡**不出现在** `dose_cards` 里，且 `check_state === 'blocked'`；
 *   - 无越界时 `check_state === 'passed'`，且 `citations` 与 `dose_cards` 是集合内的**子集**；
 *   - 任何情况下 `citations.length <= 20`、`dose_cards.length <= 10`（契约 maxItems）。
 */
import type { AuthenticatedIdentity } from '../auth/types.ts';
import { ApiError } from '../errors.ts';
import { UUID_PATTERN } from './validate.ts';
import type { DoseCard, SourceRef } from './types.ts';

/** 检索集合中的一条（本片只需要判定引用/用量卡所需的字段）。 */
export interface RetrievalItem {
  id: string;
  revision: number;
  type: string;
  title: string;
  body: string;
  source: SourceRef;
  /** 原始条目（交给 `doseCardDescriptor` 判定；无则用投影后的最小形状）。 */
  raw: unknown;
}

export interface RetrievalSet {
  user_id: string;
  /** 本次请求实际读到的条目（**顺序即读面顺序**，用于稳定产出）。 */
  items: readonly RetrievalItem[];
  /** 读面自述（`/knowledge` 同源；用于如实解释"为什么没有依据"）。 */
  note: string;
}

/**
 * 检索端口：**每次请求现查**，不缓存。
 *
 * 未接线（`kind === 'unwired'`）时 `read()` 返回 `null` ⇒ 调用方一律置
 * `status: 'insufficient'`（没有依据就如实说没有依据），**不**退回任何本地/演示数据。
 *
 * `token` 是调用方**在受理时**捕获的会话凭据：检索集合的读取复用 `/knowledge` 的
 * 同一读面（含同一套账号/会话校验），因此必须把凭据一起交给读面 —— 读面绝不因为
 * 「这是异步阶段」就跳过会话校验，也不自建一套绕过鉴权的旁路查询。
 */
export interface RetrievalPort {
  readonly kind: 'wired' | 'unwired';
  readonly note: string;
  readonly available: boolean;
  read(input: {
    /** 受理时捕获的**完整**会话身份（读面需要 `sessionId` 才能做会话校验）。 */
    identity: AuthenticatedIdentity;
    question: string;
    token: string | null;
    /** 会话条件（用于把检索集合收窄到本次会话声明的作物/区域/物种）。 */
    conditions: Record<string, unknown> | null;
  }): Promise<RetrievalSet | null>;
}

export function createUnwiredRetrievalPort(
  note = '检索面尚未接线：本端口不声称有任何依据（回答一律 insufficient）',
): RetrievalPort {
  return {
    kind: 'unwired',
    note,
    available: false,
    async read() {
      return null;
    },
  };
}

export function createWiredRetrievalPort(options: {
  read: (input: {
    identity: AuthenticatedIdentity;
    question: string;
    token: string | null;
    conditions: Record<string, unknown> | null;
  }) => Promise<RetrievalSet>;
  note: string;
}): RetrievalPort {
  return {
    kind: 'wired',
    note: options.note,
    available: true,
    read: (input) => options.read(input),
  };
}

/**
 * 用量卡权威端口（确定性路径）。**未接线 ⇒ 一律不产出用量卡**（`false`），
 * 并且必须在 `reason` 里给出可判据的拒绝原因（不得静默）。
 */
export interface DoseAuthority {
  readonly kind: 'wired' | 'unwired';
  readonly note: string;
  readonly available: boolean;
  /**
   * 确定性规则版本（来自域库，本域不猜）。未接线或拿不到版本时**不得**填默认值冒充，
   * 由调用方把"没有版本"如实写进 `Answer.rule_version`。
   */
  readonly ruleVersion?: string;
  /** 该条目是否**允许**产出一张用量卡。 */
  authorize(input: {
    item: RetrievalItem;
    question: string;
    conditions: Record<string, unknown> | null;
  }): { renderable: boolean; reason: string };
}

export function createUnwiredDoseAuthority(
  note = '用量卡权威路径尚未接线：一律不产出用量卡（不静默，reason 明示）',
): DoseAuthority {
  return {
    kind: 'unwired',
    note,
    available: false,
    authorize() {
      return { renderable: false, reason: 'dose_authority_unwired' };
    },
  };
}

/** 契约 `Answer.status` / `check_state` 的取值（与 `types.ts` 同源，避免字面量漂移）。 */
export type GuardedStatus = 'answered' | 'insufficient' | 'blocked';
export type GuardedCheckState = 'passed' | 'blocked';

/**
 * 候选用量卡 = 卡片本体 + **它声称来自的检索条目 id**（显式字段，不用私有键走私）。
 *
 * 守卫必须能核对"这张卡是不是本次检索集合里的东西"，所以来源条目 id 是一等输入；
 * 输出侧（`GuardedAnswer.dose_cards`）只保留契约 `DoseCard` 本体，该字段**不进响应**。
 */
export interface DoseCardCandidate {
  card: DoseCard;
  source_item_id: string;
}

/** 候选回答（生成侧给出；守卫是唯一能把它降级/阻断的地方）。 */
export interface CandidateAnswer {
  text: string;
  citations: readonly SourceRef[];
  dose_cards: readonly DoseCardCandidate[];
  /**
   * 生成侧在**正文层面**发现的越界（GY-R28 W7 返修）。
   *
   * 为什么正文也要有这条通道：只核对结构化 `citations` 时，生成侧可以「先把越界引用从结构体里
   * 悄悄丢掉、再把原正文交上来」——结构上一切合法，正文里的集合外编号/虚构链接却直接出给用户。
   * 因此**凡是会给正文加编号/链接语义的回答器**（目前的真实模型适配器）必须先按本次检索集合
   * 自检正文，把越界项写进这里；守卫见到非空即**整条阻断**（不产出该正文），不把它当成
   * "结构已经干净了"。
   */
  text_violations?: readonly string[];
}

/** 守卫结论（守卫**唯一**允许的输出：正文 + 状态 + 检查态 + 通过与拒绝两份清单）。 */
export interface GuardedAnswer {
  status: GuardedStatus;
  check_state: GuardedCheckState;
  checked_text: string;
  citations: SourceRef[];
  dose_cards: DoseCard[];
  /** 通过守卫的引用条数 / 被拒绝的引用条数（供披露与回归断言；不进响应）。 */
  accepted_citations: number;
  rejected_citations: string[];
  rejected_dose_cards: string[];
  /** 正文层面的拒绝清单（集合外编号/未检索链接等；供披露与回归断言，**不进响应**）。 */
  rejected_text: string[];
}

/**
 * 正文里的 URL（「正文链接与结构化引用同源」判据的机器实现）。
 *
 * 与 `citations` 的逐字段核对是**同一条纪律**：正文里出现的每个链接都必须能在本次检索集合里
 * 找到出处 —— 要么就是某条来源自带的 `url`，要么逐字出现在某条来源的正文里（确定性回答器
 * 原样搬资料原文时属于后者）。找不到出处的链接一律视为「未检索来源」，不得出给用户。
 */
const TEXT_URL_PATTERN = /https?:\/\/[^\s<>"'`，。；：！？、（）【】《》「」]+/gu;
/** URL 末尾的 ASCII 标点通常是正文标点，不是链接的一部分。 */
const URL_TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/u;

/** 提取正文里的 URL（去重、去尾部标点、保持出现顺序）。 */
export function urlsInText(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(TEXT_URL_PATTERN)) {
    const url = match[0].replace(URL_TRAILING_PUNCTUATION, '');
    if (url.length > 'https://'.length && !found.includes(url)) found.push(url);
  }
  return found;
}

/** 本次检索集合**能背书**的 URL 集合（来源自带 url + 正文里原样出现的 url）。 */
export function groundedUrlsOf(items: readonly RetrievalItem[]): Set<string> {
  const grounded = new Set<string>();
  for (const item of items) {
    grounded.add(item.source.url);
    for (const url of urlsInText(item.body ?? '')) grounded.add(url);
  }
  return grounded;
}

export const MAX_CITATIONS = 20;
export const MAX_DOSE_CARDS = 10;

/** 契约 `SourceRef` 的闭集（`packages/contracts/openapi.json`；**本文件是唯一执行点**）。 */
const SOURCE_KINDS = ['database', 'verified_seed', 'simulation'] as const;
const EVIDENCE_KINDS = ['research', 'experience', 'mixed'] as const;
const VALIDITIES = ['valid', 'expired', 'conflicting', 'unknown', 'withdrawn'] as const;
const REVIEW_STATUSES = ['unverified', 'verified', 'rejected'] as const;

/**
 * 引用是否**可被契约表达**：`url` 必须匹配契约的 `^https://`、四个枚举必须落在闭集内、
 * `id` 必须是 uuid、`updated_at` 必须是可解析的时间。
 *
 * 为什么守卫要做这一层：检索集合可能含有**契约表达不了**的来源（例如 `http://`
 * 或枚举外的 `source_kind`）。这种条目即便"在集合内"，一旦被写进 `Answer.citations`
 * 就会产出**违反冻结契约**的响应体。守卫**不得**让它过 —— 也不能静默丢掉，
 * 而是逐条记入 `rejected_citations` 并整体置 `blocked`（派单 §3 第 5 项）。
 */
function contractProblemsOf(source: SourceRef): string[] {
  const problems: string[] = [];
  if (!UUID_PATTERN.test(source.id)) problems.push('id_not_uuid');
  if (!/^https:\/\//.test(source.url)) problems.push('url_not_https');
  if (!(SOURCE_KINDS as readonly string[]).includes(source.source_kind)) problems.push('source_kind_out_of_enum');
  if (!(EVIDENCE_KINDS as readonly string[]).includes(source.evidence_kind)) problems.push('evidence_kind_out_of_enum');
  if (!(VALIDITIES as readonly string[]).includes(source.validity)) problems.push('validity_out_of_enum');
  if (!(REVIEW_STATUSES as readonly string[]).includes(source.review_status)) problems.push('review_status_out_of_enum');
  if (Number.isNaN(new Date(source.updated_at).getTime())) problems.push('updated_at_unparsable');
  return problems;
}

/**
 * 逐字段比较两个 `SourceRef`（键集合相同且十个键取值全同）。
 * 用严格序列化比较：字段顺序无关、类型必须一致（`"1"` 与 `1` **不**相等）。
 */
function sameSourceRef(a: SourceRef, b: SourceRef): boolean {
  return (
    a.id === b.id &&
    a.version === b.version &&
    a.title === b.title &&
    a.url === b.url &&
    a.publisher === b.publisher &&
    a.source_kind === b.source_kind &&
    a.evidence_kind === b.evidence_kind &&
    a.validity === b.validity &&
    a.review_status === b.review_status &&
    a.updated_at === b.updated_at
  );
}

export interface AnswerGuardDeps {
  dose: DoseAuthority;
}

export interface AnswerGuard {
  readonly dose: DoseAuthority;
  /**
   * 执行守卫。`set === null`（检索端口未接线/读不到）⇒ 一律 `insufficient`
   * （**不**接受任何候选引用/用量卡：没有集合就没有"集合内"）。
   */
  check(input: {
    candidate: CandidateAnswer;
    set: RetrievalSet | null;
    question: string;
    conditions: Record<string, unknown> | null;
  }): GuardedAnswer;
}

function clipCandidates<T>(values: readonly T[], max: number, rejected: string[], label: string): T[] {
  if (values.length <= max) return [...values];
  for (let index = max; index < values.length; index += 1) rejected.push(`${label}_over_limit`);
  return values.slice(0, max);
}

export function createAnswerGuard(deps: AnswerGuardDeps): AnswerGuard {
  return {
    dose: deps.dose,
    check({ candidate, set, question, conditions }) {
      const rejectedCitations: string[] = [];
      const rejectedDoseCards: string[] = [];
      // 正文层面的拒绝清单：生成侧自报的越界（编号/链接）先收进来，下面再独立复核正文里的链接。
      const rejectedText: string[] = [];
      for (const violation of candidate.text_violations ?? []) {
        if (!rejectedText.includes(violation)) rejectedText.push(violation);
      }

      if (set === null) {
        // 没有检索集合 ⇒ 不存在"集合内引用"这一概念。候选内容一律不接受，
        // 如实置「资料不足」，而不是把候选原文配上"未验证"标签放出去。
        if (candidate.citations.length > 0) rejectedCitations.push('no_retrieval_set');
        if (candidate.dose_cards.length > 0) rejectedDoseCards.push('no_retrieval_set');
        return {
          status: 'insufficient',
          check_state: 'passed',
          checked_text: '资料不足：本次未取得任何可核对依据，不提供结论与用量。',
          citations: [],
          dose_cards: [],
          accepted_citations: 0,
          rejected_citations: rejectedCitations,
          rejected_dose_cards: rejectedDoseCards,
          rejected_text: rejectedText,
        };
      }

      // ---- 引用：必须逐字段等于集合内某条目自带的来源对象 ----
      const accepted: SourceRef[] = [];
      for (const citation of candidate.citations) {
        const item = set.items.find((entry) => entry.id === citation.id);
        if (item === undefined) {
          rejectedCitations.push(`not_in_retrieval_set:${citation.id}`);
          continue;
        }
        if (!sameSourceRef(item.source, citation)) {
          rejectedCitations.push(`source_mismatch:${citation.id}`);
          continue;
        }
        // 「在集合内且字段没被改写」还不够：契约表达不了的来源同样不得外发。
        const problems = contractProblemsOf(citation);
        if (problems.length > 0) {
          rejectedCitations.push(`source_not_representable:${citation.id}:${problems.join('+')}`);
          continue;
        }
        if (accepted.some((entry) => entry.id === citation.id)) {
          rejectedCitations.push(`duplicate_citation:${citation.id}`);
          continue;
        }
        accepted.push(item.source);
      }

      // ---- 用量卡：只接受"集合内 + 确定性权威路径判定可渲染"的卡 ----
      const acceptedCards: DoseCard[] = [];
      for (const candidateCard of candidate.dose_cards) {
        const card = candidateCard.card;
        const item = set.items.find((entry) => entry.id === candidateCard.source_item_id);
        if (item === undefined) {
          // 卡片没有可核对的来源条目 ⇒ 无法证明它来自本次检索集合。
          rejectedDoseCards.push(`dose_card_without_retrieval_item:${String(card['id'] ?? 'unknown')}`);
          continue;
        }
        const verdict = deps.dose.authorize({ item, question, conditions });
        if (!verdict.renderable) {
          rejectedDoseCards.push(`dose_not_authoritative:${verdict.reason}`);
          continue;
        }
        acceptedCards.push(structuredClone(card));
      }

      // ---- 正文链接：必须与结构化引用同源（未检索来源不得随正文出给用户）----
      // 生成侧自报之外再独立复核一遍：**不**依赖上游的自检（自检被绕过/漏报时这里仍然拦得住）。
      const grounded = groundedUrlsOf(set.items);
      for (const url of urlsInText(candidate.text)) {
        if (!grounded.has(url)) rejectedText.push(`unattributed_url:${url}`);
      }

      const boundedCitations = clipCandidates(accepted, MAX_CITATIONS, rejectedCitations, 'citation');
      const boundedCards = clipCandidates(acceptedCards, MAX_DOSE_CARDS, rejectedDoseCards, 'dose_card');

      // 正文越界同样致阻断：只丢结构化引用、把原正文盖章通过，正是返修要堵的那条路。
      const blocked = rejectedCitations.length > 0 || rejectedDoseCards.length > 0 || rejectedText.length > 0;
      if (blocked) {
        // 正文层面越界 ⇒ **整条不交付**：连同一条候选里"看起来合法"的引用/用量卡也不放出，
        // 否则等于用一份合法 citation 给被拒正文背书（"洗白"）。结构化越界（本分支的既有语义）
        // 仍保留已通过核对的那部分 —— 那是既有契约，不在本次返修范围。
        const deliverCitations = rejectedText.length > 0 ? [] : boundedCitations;
        const deliverCards = rejectedText.length > 0 ? [] : boundedCards;
        return {
          status: 'blocked',
          check_state: 'blocked',
          checked_text:
            '本回答已被输出守卫阻断：候选内容含有超出本次检索集合的引用、来源链接或未经确定性判定的用量数据，' +
            '因此不产出该部分内容。请以资料页的核准来源为准。',
          citations: deliverCitations,
          dose_cards: deliverCards,
          accepted_citations: deliverCitations.length,
          rejected_citations: rejectedCitations,
          rejected_dose_cards: rejectedDoseCards,
          rejected_text: rejectedText,
        };
      }

      if (boundedCitations.length === 0 && boundedCards.length === 0) {
        return {
          status: 'insufficient',
          check_state: 'passed',
          checked_text: '资料不足：本次检索集合内没有可用来源，不提供结论与用量。',
          citations: [],
          dose_cards: [],
          accepted_citations: 0,
          rejected_citations: [],
          rejected_dose_cards: [],
          rejected_text: [],
        };
      }

      if (candidate.text.trim().length === 0) {
        // 生成侧回传空正文 ⇒ 端口回传不可信（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
        throw new ApiError('PROVIDER_UNAVAILABLE', '生成侧给出了空正文（拒绝产出空回答）', { retryable: false });
      }
      return {
        status: 'answered',
        check_state: 'passed',
        checked_text: candidate.text,
        citations: boundedCitations,
        dose_cards: boundedCards,
        accepted_citations: boundedCitations.length,
        rejected_citations: [],
        rejected_dose_cards: [],
        rejected_text: [],
      };
    },
  };
}
