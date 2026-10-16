/**
 * GY-I07 · 科普／除草剂查询的**服务端装配**（HTTP 路由的领域层）。
 *
 * 职责边界（不改契约、不改他人已合并实现）：
 *   1. `/herbicides`、`/herbicides/{id}`：挂载 issue #7 中**尚未装配**的两条契约 operation，
 *      领域逻辑与数据**复用已合入的 `packages/reference` 适配层**
 *      （`packages/knowledge/herbicides/records-2026.json`：真实公告附表记录，
 *      制剂身份 = 登记号 + 剂型/成分含量哈希，**不按模糊药名合并不同含量剂型**）。
 *   2. `/knowledge` 的**浙江首批真实资料**并入：把 `packages/knowledge/zhejiang/
 *      materials-zhejiang-v1.json`（GY-I03 / #131 已合入）投影为与数据库读视图
 *      `catalog_read.current_knowledge` 同形的行，交给既有 DB 读服务统一过滤/分页/封套，
 *      从而**不新增契约路径、不新增响应字段、不改契约**，同时如实带出
 *      `review_status=unverified` 与 `visibility=private` 语义（后者契约无字段，
 *      只在 `zhejiangState()` 与文档中显式给出）。
 *   3. 用量缺项**不补齐**：浙江批次无「标签原文用量」列，投影恒 `dose_cards=[]`、
 *      `conditions=null`，且 `doseCardDescriptor()` 恒判 `renderable=false`。
 *
 * 执行模式口径：浙江批次是**未发布（private）+ 未核对（unverified）**的种子资料，
 * 只在**非 `real`** 执行模式（`stub` / `preset_demo`，即本地联调与演示）并入查询面；
 * `real` 模式仍只返回「已核对 + 已发布」的数据库投影（`catalog_read.current_knowledge`
 * 本身即按 real 开关与 verified 来源准入）。这样既真的消费了真实资料，
 * 又不把未核对资料提升成 real 模式的权威来源。
 */

import { ERROR_CODES, type ErrorCode } from '../contract.ts';
import { ApiError } from '../errors.ts';
import {
  createReferenceService,
  loadZhejiangKnowledge,
  queryZhejiangKnowledge,
  ZHEJIANG_DOSE_ABSENT_NOTE,
  ZHEJIANG_REVIEW_STATUS,
  ZHEJIANG_VISIBILITY,
  type ZhejiangKnowledge,
  type ZhejiangKnowledgeItem,
} from '../../../../packages/reference/index.mjs';

/** 与 `catalog_read.current_knowledge` 列同形的行（供既有 DB 读服务统一处理）。 */
export interface KnowledgeRow {
  [column: string]: unknown;
}

/** 把域库错误映射为契约错误（码取自域库，状态由本服务端契约映射决定）。 */
function rethrowDomainError(error: unknown): never {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)) {
    const raw = (error as { details?: unknown }).details;
    const details = Array.isArray(raw)
      ? raw.slice(0, 30).map((d) => ({
        field: String((d as { field?: unknown })?.field ?? '').slice(0, 80),
        code: String((d as { reason?: unknown })?.reason ?? 'invalid').slice(0, 80),
      }))
      : [];
    throw new ApiError(code as ErrorCode, (error as Error).message, { details });
  }
  throw new ApiError('PROVIDER_UNAVAILABLE', '资料查询服务暂不可用');
}

/**
 * 浙江首批条目 → 与读视图同形的行（真实定位进 body，用量恒缺项）。
 *
 * `created_at`（契约排序第一分量）：本批次**没有**逐条创建时点，故取该条目来源版本的
 * 检索/发布时点 `item.source.updated_at`（由 `packages/reference/zhejiang.mjs` 从清单
 * 的 `sources[].retrieved_at` 确定性转换而来，即批次日期 `2026-10-14T00:00:00.000Z`）——
 * **不是**运行期时钟、**不是**迁移时间，同一条目在任何时间/环境都得到同一排序键。
 * 这也是 0012 迁移对历史行回填所用的同一批次日期常量，故数据库投影行与并入种子行
 * 落在同一 created_at 上，全序由 `id DESC` 决定且确定性。
 *
 * **纯函数**（供测试注入同构条目做负例回归）。失效/下架条目在此**退出**查询面：
 * `validity !== 'valid'`（expired/withdrawn/conflicting/unknown）与
 * `visibility ∈ {hidden, deleted}` 一律不并入 —— 与「下架/失效退出有效查询，列表与详情一致」同口径。
 */
export function toSeedRows(items: readonly ZhejiangKnowledgeItem[]): KnowledgeRow[] {
  return items
    .filter((item) => item.validity === 'valid' && item.visibility !== 'hidden' && item.visibility !== 'deleted')
    .map((item: ZhejiangKnowledgeItem) => ({
      id: item.knowledge.id,
      revision: item.knowledge.revision,
      created_at: item.source.updated_at,
      type: item.knowledge.type,
      title: item.knowledge.title,
      body: item.knowledge.body,
      crop_ids: item.crop_ids,
      species_ids: item.species_ids,
      region_codes: item.region_codes,
      source_id: item.source.id,
      source_version: item.source.version,
      source_title: item.source.title,
      url: item.source.url,
      publisher: item.source.publisher,
      source_kind: item.source.source_kind,
      evidence_kind: item.source.evidence_kind,
      updated_at: item.source.updated_at,
      review_status: item.review_status,
      validity: item.validity,
    }));
}

/**
 * 创建查询服务。
 * @param options.includeUnverifiedSeed 是否把浙江首批（未发布/未核对）并入 `/knowledge`
 *   查询面。装配层保证：**real 执行模式恒为 false**；非 real 模式仍需
 *   `APP_KNOWLEDGE_UNVERIFIED_SEED` 显式放行（默认关闭）—— 这正是
 *   `v_queryable_seed_version` 的既有口径（「无真实库时的有来源种子联调；必须标注未核对」），
 *   也让「未发布内容进入用户查询面」成为一次可审查的接线决定，而不是默认发生的事。
 */
export function createReferenceQueryService(options: { includeUnverifiedSeed: boolean }) {
  // 域库服务在首次使用时装配（读盘失败即 503，不静默返回空集合冒充「无资料」）。
  let reference: ReturnType<typeof createReferenceService> | null = null;
  function domain(): ReturnType<typeof createReferenceService> {
    try {
      reference ??= createReferenceService({ executionMode: 'stub' });
      return reference;
    } catch (error) {
      throw new ApiError('PROVIDER_UNAVAILABLE', `资料适配层装载失败：${String((error as Error).message ?? error)}`);
    }
  }

  // 浙江首批：一次性装载并冻结（确定性投影；失败即 503，不静默降级为空）。
  let zhejiang: ZhejiangKnowledge | null = null;
  function seed(): ZhejiangKnowledge {
    if (zhejiang === null) {
      try {
        zhejiang = loadZhejiangKnowledge();
      } catch (error) {
        throw new ApiError(
          'PROVIDER_UNAVAILABLE',
          `浙江首批真实资料装载失败（缺项/纪律校验未通过）：${String((error as Error).message ?? error)}`,
        );
      }
    }
    return zhejiang;
  }

  /** 浙江首批条目 → 与读视图同形的行（真实定位进 body，用量恒缺项）。 */
  function seedRows(): KnowledgeRow[] {
    if (!options.includeUnverifiedSeed) return [];
    return toSeedRows(seed().items);
  }

  /** 如实状态（未核对/未发布/零 https/零用量卡），供文档与测试核对。 */
  function seedState(): Record<string, unknown> {
    if (!options.includeUnverifiedSeed) {
      return {
        included: false,
        reason: '执行模式为 real：只返回已核对 + 已发布投影；未发布/未核对的浙江首批不并入',
      };
    }
    const bundle = seed();
    return {
      included: true,
      review_status: ZHEJIANG_REVIEW_STATUS,
      visibility: ZHEJIANG_VISIBILITY,
      dose_note: ZHEJIANG_DOSE_ABSENT_NOTE,
      ...(bundle.state as Record<string, unknown>),
    };
  }

  /** 浙江首批条目的确定性查询（仅结构化条件；未采集条件不静默放宽）。 */
  function querySeed(input: Record<string, unknown>) {
    if (!options.includeUnverifiedSeed) return { match_state: 'unavailable', items: [], reasons: [] };
    return queryZhejiangKnowledge(seed().items, input);
  }

  /** `/herbicides`、`/herbicides/{id}`：直接消费已合入适配层的真实记录。 */
  function listHerbicides(input: Record<string, unknown>): { data: Record<string, unknown>; etag?: string } {
    try {
      const result = domain().listHerbicides(input);
      return { data: result.body.data as Record<string, unknown>, etag: result.headers.ETag };
    } catch (error) {
      return rethrowDomainError(error);
    }
  }

  function getHerbicide(id: string, input: Record<string, unknown>): { data: Record<string, unknown>; etag?: string } {
    try {
      const result = domain().getHerbicide(id, input);
      return { data: result.body.data as Record<string, unknown>, etag: result.headers.ETag };
    } catch (error) {
      return rethrowDomainError(error);
    }
  }

  return { listHerbicides, getHerbicide, seedRows, seedState, querySeed };
}

export type ReferenceQueryService = ReturnType<typeof createReferenceQueryService>;
