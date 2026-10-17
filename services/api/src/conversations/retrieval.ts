/**
 * GY-I12（#12）· **检索集合的读取**（回答守卫的唯一依据来源）。
 *
 * 硬纪律（派单 §3 第 5 项 + §5「禁止自建第二套」）：
 *  1. 检索集合必须来自与 `/knowledge` **完全相同**的读面 —— 同一个
 *     `createKnowledgeService` 实例、同一份 `catalog_read.current_knowledge` 视图查询、
 *     **同一套账号/会话校验**、同一个浙江种子开关。本文件**不**写第二条 SQL、不建第二个
 *     连接池、不缓存快照、也不提供任何"绕过鉴权直接查库"的旁路。
 *  2. 读不到就**如实为空**（`items: []`），由守卫置 `insufficient`；**绝不**退回本地/
 *     演示/硬编码资料来"让回答看起来有依据"。
 *  3. 读面缺凭据 ⇒ 抛 `SESSION_REQUIRED`（受理任务据此如实落 `failed`），
 *     不因为"这是异步阶段"就跳过会话校验。
 *  4. 条目来源字段**逐行如实透出**（`unverified` 就是 `unverified`），
 *     绝不在本层把未核对改成已核对。投影**读不出**来源的条目 ⇒ 抛 503（fail-closed）：
 *     形状缺陷不是"没有依据"，静默丢它会让"集合"与读面不一致，正是守卫要防的失真。
 *  5. **有效性判定（GY-I12 D3①）**：`validity !== 'valid'`（`expired` / `withdrawn` /
 *     `conflicting` / `unknown`）或 `review_status === 'rejected'` 的条目**不进集合** ——
 *     它们不具备"可引用的依据"资格。口径全部取自既有定义（见 `validityVerdictOf`），
 *     本层**不**新造枚举、**不**改写来源字段（`validity` 就是读面给的值，不做"洗白"）。
 *     `conflicting` 额外**单独标注**：计入 `note` 并用既有措辞「来源相互冲突」说明
 *     "冲突、资料不足"；**不**解释冲突内容 —— 本层没有核对冲突的事实依据，
 *     编造冲突解释正是要防的失真。
 *  6. **预排序（GY-I12 D3②）**：按与 `question` 的**字面重合度**排序（规则
 *     `cjk-bigram+word-match/1`，与回答器同规则），同分保持**读面顺序**。排序发生在
 *     **截断之前**，所以候选池超出本层上限时丢掉的是"最不相关"的条目，而不是读面顺序
 *     里的尾部条目。排序只改变**顺序**，不放宽也不收紧任何过滤，更不改变
 *     "同一读面同一快照"这一来源（读面仍是一次 `list` 调用，见文件头第 1 条）。
 *
 * 条件收窄（与 `knowledge/service.ts` 的既有口径逐字对齐）：只应用读面**能证成**的三个条件
 * （`crop_id` / `region_code` / `species_id`）。会话如果带上了读面**无法证成**的条件
 * （`growth_stage` / `planting_method` / `use_scene`），本层**不**把它们悄悄丢掉 ——
 * 既有读面对这三个条件的立场是"证不成就返回空，不静默放宽"，所以这里直接给出**空集合**
 * 并把原因写进 `note`，让"该条件下没有可核对依据"成为显式结论。
 */
import type { AuthenticatedIdentity } from '../auth/types.ts';
import type { KnowledgeQuery } from '../knowledge/service.ts';
import { ApiError } from '../errors.ts';
import { createWiredRetrievalPort, type RetrievalItem, type RetrievalPort, type RetrievalSet } from './guard.ts';
import { UUID_PATTERN } from './validate.ts';
import type { SourceRef } from './types.ts';

/**
 * 与 `/knowledge` 同源的读面（装配层传入**同一个** `createKnowledgeService` 实例）。
 *
 * 返回类型刻意声明为 `unknown`：本层对外域返回的行**不假设任何形状**，
 * 逐字段校验后才放进检索集合（形状不对 ⇒ 503，见文件头第 4 条）。
 */
export interface KnowledgeReadFace {
  list(input: { identity: AuthenticatedIdentity; token: string }, query: KnowledgeQuery): Promise<unknown>;
}

/** 一次回答最多读入多少条作为检索集合（读面 `limit` 上限即 50）。 */
export const RETRIEVAL_LIMIT = 50;

/** 读面**能证成**的条件字段（`catalog_read.current_knowledge` 有对应列）。 */
const PROVABLE_CONDITIONS = ['crop_id', 'region_code', 'species_id'] as const;
/** 读面**无法证成**的条件字段（既有读面对它们返回空集合，不静默放宽）。 */
const UNPROVABLE_CONDITIONS = ['growth_stage', 'planting_method', 'use_scene'] as const;

/**
 * 可进入检索集合的有效性取值（**既有口径，本层只消费**）。
 *
 * `packages/reference/constants.mjs` 的 `QUERYABLE_VALIDITIES = ['valid']`，以及读面视图
 * `catalog_read.current_verified_sources` 的 `sv.validity = 'valid'`，都只把 `valid`
 * 当作"可查询的有效来源"。因此 `expired` / `withdrawn` / `conflicting` / `unknown`
 * 一律不进检索集合 —— 它们的共同含义就是"有效期这一项已经证不成都不能算有依据"。
 */
const QUERYABLE_VALIDITY = 'valid';

/**
 * 不可进入检索集合的审核态。
 *
 * 读面视图要求 `review_status = 'verified'`，但**会话域的既有行为允许引用 `unverified`**
 * （如实标注"未核对"，见 `guard.ts` 的 `review_status` 闭集与既有用例），这里不改变它；
 * 只把 `rejected`（未通过核对）判为不可用：一条被驳回的资料不能当依据。
 */
const UNQUERYABLE_REVIEW_STATUS = 'rejected';

/**
 * 失效原因措辞（**逐字复用** `packages/reference/query.mjs#evaluateEligibility` 的既有原因表，
 * 不新造解释）。兜底句同样是那里的原文。
 */
const VALIDITY_REASONS: Readonly<Record<string, string>> = {
  expired: '来源已过期',
  withdrawn: '来源已撤回',
  conflicting: '来源相互冲突',
  unknown: '来源有效期未知',
};
const VALIDITY_REASON_FALLBACK = '来源有效期不可用';
const REVIEW_STATUS_REASON = '未通过核对';

/**
 * 预排序规则名（**与回答器同规则**，`conversations/service.ts` 的 `RELEVANCE_RULE`）。
 *
 * 为什么本文件内单独实现最小分词：`service.ts` 是 D2 片的改动面（派单 §2 第 3 项），
 * 本层不 import 它以避开同文件争用；"两处规则一致"由
 * `tests/unit/conversation-retrieval-validity.test.mjs` 的
 * 「预排序顺序必须与回答器引用顺序一致」断言锁住（规则名/分词/评分任一漂移，该断言必红）。
 */
export const RETRIEVAL_RANK_RULE = 'cjk-bigram+word-match/1';
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const WORD_RUN = /[a-z0-9]{2,}/g;

/** 一条被有效性判定剔除的条目（**逐条留痕**，供 `note` 如实说明"为什么没有依据"）。 */
export interface UnusableSource {
  readonly usable: false;
  readonly field: 'validity' | 'review_status';
  readonly value: string;
  readonly reason: string;
  /** `validity === 'conflicting'`：只标注"互相冲突"这一状态，**不**解释冲突内容。 */
  readonly conflicting: boolean;
}

export type ValidityVerdict = { readonly usable: true } | UnusableSource;

/**
 * 有效性判定（GY-I12 D3①）：这条来源**是否具备"可引用的依据"资格**。
 *
 * 只读来源自身的两个字段，不看正文、不做"看起来还行"的主观判断：
 *  `review_status === 'rejected'` ⇒ 不可用；`validity !== 'valid'` ⇒ 不可用。
 */
export function validityVerdictOf(source: SourceRef): ValidityVerdict {
  // 审核态先判：一条被驳回的资料，即使有效期是 valid，也不能当依据。
  if (source.review_status === UNQUERYABLE_REVIEW_STATUS) {
    return {
      usable: false,
      field: 'review_status',
      value: source.review_status,
      reason: REVIEW_STATUS_REASON,
      conflicting: false,
    };
  }
  if (source.validity !== QUERYABLE_VALIDITY) {
    return {
      usable: false,
      field: 'validity',
      value: source.validity,
      reason: VALIDITY_REASONS[source.validity] ?? VALIDITY_REASON_FALLBACK,
      conflicting: source.validity === 'conflicting',
    };
  }
  return { usable: true };
}

/**
 * 提问 → 字面 shingle 集合（与回答器同规则：单字 CJK 直接入集，否则全部 bigram + ascii 词）。
 *
 * 空提问/无可用字符 ⇒ 空集合 ⇒ 排序退化为"保持读面顺序"（不因为排序把集合清空）。
 */
export function questionShingles(question: string): Set<string> {
  const shingles = new Set<string>();
  for (const run of question.toLocaleLowerCase('zh-CN').match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      shingles.add(run);
      continue;
    }
    for (let index = 0; index + 1 < run.length; index += 1) shingles.add(run.slice(index, index + 2));
  }
  for (const word of question.toLocaleLowerCase('zh-CN').match(WORD_RUN) ?? []) shingles.add(word);
  return shingles;
}

/** 一条资料与提问的字面重合度（命中 shingle 个数；只作排序键，不代表"可靠"）。 */
export function questionMatchScore(
  shingles: ReadonlySet<string>,
  item: { readonly title: string; readonly body: string },
): number {
  const itemShingles = questionShingles(`${item.title}\n${item.body}`);
  let score = 0;
  for (const shingle of itemShingles) {
    if (shingles.has(shingle)) score += 1;
  }
  return score;
}

/**
 * 按提问预排序（`RETRIEVAL_RANK_RULE`）：分数降序，**同分保持读面顺序**（稳定）。
 *
 * 排序不是过滤：这里既不新增也不删除条目，候选池的成员由读面与有效性判定决定。
 */
export function rankByQuestion<T extends { readonly title: string; readonly body: string }>(
  items: readonly T[],
  question: string,
): T[] {
  const shingles = questionShingles(question);
  if (shingles.size === 0) return [...items];
  return items
    .map((item, index) => ({ item, index, score: questionMatchScore(shingles, item) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item);
}

/** 剔除清单 → `note` 里的计数摘要（按 `field=value` 稳定排序，便于逐字核对）。 */
function exclusionSummary(excluded: readonly UnusableSource[]): string {
  const counts = new Map<string, { count: number; reason: string }>();
  for (const entry of excluded) {
    const key = `${entry.field}=${entry.value}`;
    const found = counts.get(key);
    if (found === undefined) counts.set(key, { count: 1, reason: entry.reason });
    else found.count += 1;
  }
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key} ${value.count} 条：${value.reason}`)
    .join('/');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取字符串字段；缺失/非字符串/空串一律视为**无法核对**（抛 503，不填默认值）。 */
function requiredString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError('PROVIDER_UNAVAILABLE', `检索集合条目 ${where} 的来源字段 ${key} 缺失或非字符串`, {
      // 读面投影不合契约 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
      retryable: false,
    });
  }
  return value;
}

/**
 * 读面投影 → 检索条目（**逐字段校验**）。
 *
 * 契约 `SourceRef` 是 `additionalProperties:false` 且十键全必填，所以这里要求来源对象
 * **恰好**带这十个字符串键：多一个键意味着读面投影与契约已经不一致，宁可 503 也不把它
 * 当作"能引用的来源"。
 */
export function retrievalItemOf(value: unknown, where = 'unknown'): RetrievalItem {
  if (!isPlainObject(value)) {
    // 读面投影不合契约 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
    throw new ApiError('PROVIDER_UNAVAILABLE', `检索集合条目 ${where} 不是对象`, { retryable: false });
  }
  const id = value['id'];
  const revision = value['revision'];
  const source = value['source'];
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    // 读面投影不合契约 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
    throw new ApiError('PROVIDER_UNAVAILABLE', `检索集合条目 id 不是 uuid：${String(id)}`, { retryable: false });
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    // 读面投影不合契约 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
    throw new ApiError('PROVIDER_UNAVAILABLE', `检索集合条目 ${id} 的 revision 不是 >=1 的整数`, { retryable: false });
  }
  if (!isPlainObject(source)) {
    // 读面投影不合契约 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
    throw new ApiError('PROVIDER_UNAVAILABLE', `检索集合条目 ${id} 缺少来源对象（无法核对引用）`, { retryable: false });
  }
  const ref: SourceRef = {
    id: requiredString(source, 'id', id),
    version: requiredString(source, 'version', id),
    title: requiredString(source, 'title', id),
    url: requiredString(source, 'url', id),
    publisher: requiredString(source, 'publisher', id),
    source_kind: requiredString(source, 'source_kind', id),
    evidence_kind: requiredString(source, 'evidence_kind', id),
    validity: requiredString(source, 'validity', id),
    review_status: requiredString(source, 'review_status', id),
    updated_at: requiredString(source, 'updated_at', id),
  };
  if (ref.id !== id) {
    // 读面把条目 id 与来源 id 混为一谈 ⇒ 引用核对会失去意义。
    // 读面投影不合契约 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
    throw new ApiError('PROVIDER_UNAVAILABLE', `检索集合条目 ${id} 的来源 id 与条目 id 不一致`, { retryable: false });
  }
  return {
    id,
    revision,
    type: typeof value['type'] === 'string' ? value['type'] : 'unknown',
    title: typeof value['title'] === 'string' ? value['title'] : '',
    body: typeof value['body'] === 'string' ? value['body'] : '',
    source: ref,
    raw: value,
  };
}

/** 读面返回体 → 条目数组（形状不对 ⇒ 503，不把 `undefined` 当成空集合）。 */
export function retrievalItemsOf(result: unknown): unknown[] {
  if (!isPlainObject(result) || !Array.isArray(result['items'])) {
    // 读面投影不合契约 ⇒ 确定性缺陷（重试不会改善）：retryable 必须为 false。口径见 services/api/src/errors.ts 的 ApiError 注释。
    throw new ApiError('PROVIDER_UNAVAILABLE', '资料读面返回体缺少 items 数组', { retryable: false });
  }
  return result['items'];
}

/** 从会话条件里取出读面能证成的查询参数；同时报告是否存在读面无法证成的条件。 */
export function knowledgeQueryOf(conditions: Record<string, unknown> | null): {
  query: KnowledgeQuery;
  unprovable: string[];
} {
  const query: KnowledgeQuery = { limit: RETRIEVAL_LIMIT };
  const unprovable: string[] = [];
  if (conditions === null) return { query, unprovable };
  for (const field of PROVABLE_CONDITIONS) {
    const value = conditions[field];
    if (typeof value === 'string' && value.length > 0) {
      query[field] = value;
    }
  }
  for (const field of UNPROVABLE_CONDITIONS) {
    const value = conditions[field];
    if (typeof value === 'string' && value.length > 0) unprovable.push(field);
  }
  return { query, unprovable };
}

/**
 * 装配检索端口。
 *
 * @param options.face 与 `/knowledge` **同一个**读面实例（由 `app.ts` 传入，不在此处新建）。
 */
export function createKnowledgeRetrievalPort(options: { face: KnowledgeReadFace; note?: string }): RetrievalPort {
  const face = options.face;
  return createWiredRetrievalPort({
    note:
      options.note ??
      '检索集合 = 与 /knowledge 同一读面（视图 catalog_read.current_knowledge + 同一浙江种子开关 + 同一会话校验）的本次读取结果',
    async read({ identity, question, token, conditions }): Promise<RetrievalSet> {
      const { query, unprovable } = knowledgeQueryOf(conditions);
      if (unprovable.length > 0) {
        // 既有读面对这三个条件"证不成就返回空，不静默放宽"；本层不把它们悄悄丢掉，
        // 而是直接给出空集合 + 显式原因（回答据此如实置 insufficient）。
        return {
          user_id: identity.userId,
          items: [],
          note: `会话条件 ${unprovable.join('/')} 在当前读面无法证成（读面无对应证据列），按既有口径该条件下没有可核对的依据`,
        };
      }
      if (token === null) {
        // 受理时没拿到凭据 ⇒ 不绕过会话校验，直接如实失败。
        throw new ApiError('SESSION_REQUIRED', '检索集合读取需要受理时捕获的用户会话凭据');
      }
      const result = await face.list({ identity, token }, query);
      const rows = retrievalItemsOf(result).map((row, index) => retrievalItemOf(row, `#${index}`));
      // 有效性判定（文件头第 5 条）：不通过的条目退出集合，但**逐条留痕**给 note（不静默丢弃）。
      const usableItems: RetrievalItem[] = [];
      const excluded: UnusableSource[] = [];
      for (const item of rows) {
        const verdict = validityVerdictOf(item.source);
        if (verdict.usable) usableItems.push(item);
        else excluded.push(verdict);
      }
      // 预排序在**截断之前**（文件头第 6 条）：候选池大于上限时，丢的是最不相关的条目。
      const ranked = rankByQuestion(usableItems, question);
      const items = ranked.slice(0, RETRIEVAL_LIMIT);
      const conflicts = excluded.filter((entry) => entry.conflicting);
      const noteParts = [
        `本次检索集合：${items.length} 条（读面 /knowledge 同一快照；上限 ${RETRIEVAL_LIMIT} 条，未翻页）`,
      ];
      if (excluded.length > 0) {
        noteParts.push(`有效性判定剔除 ${excluded.length} 条（${exclusionSummary(excluded)}）`);
      }
      if (conflicts.length > 0) {
        // 「冲突」必须被说出来（不能静默当成"没有这条"），但也只说到"证不成"为止：
        // 冲突内容本层没有核对依据，编造解释就是失真。
        noteParts.push(
          `其中 ${conflicts.length} 条为 conflicting：冲突原因本层未核对，故只能如实说明` +
            '「来源相互冲突、该条资料不足」，不解释冲突内容',
        );
      }
      if (ranked.length > items.length) {
        noteParts.push(
          `候选池 ${ranked.length} 条超出上限，按与提问的字面重合度（${RETRIEVAL_RANK_RULE}）保留前 ${items.length} 条`,
        );
      }
      return { user_id: identity.userId, items, note: noteParts.join('；') };
    },
  });
}
