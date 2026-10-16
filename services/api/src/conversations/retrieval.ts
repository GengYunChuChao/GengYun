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
 *     绝不在本层把未核对改成已核对。投影无法核对来源的条目 ⇒ 抛 503（fail-closed），
 *     **不**静默丢弃：丢弃会让"集合"与读面不一致，正是守卫要防的失真。
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
    async read({ identity, token, conditions }): Promise<RetrievalSet> {
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
      const items = retrievalItemsOf(result).map((row, index) => retrievalItemOf(row, `#${index}`));
      return {
        user_id: identity.userId,
        items,
        note: `本次检索集合：${items.length} 条（读面 /knowledge 同一快照；上限 ${RETRIEVAL_LIMIT} 条，未翻页）`,
      };
    },
  });
}
