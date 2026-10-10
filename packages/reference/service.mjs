/**
 * GY-I07 查询展示层 · 服务装配（契约形状的响应封套）。
 *
 * 把「目录 + 记录 + 查询」装配为上层路由可直接返回的**契约形状**响应：
 *   - `/knowledge`、`/knowledge/{id}`  → KnowledgePageEnvelope / KnowledgeEnvelope
 *   - `/herbicides`、`/herbicides/{id}` → HerbicidePageEnvelope / HerbicideEnvelope
 *   - `/catalog/{crops|species|regions}` → *PageEnvelope
 *
 * 关键契约点：
 *   - 每个响应带 `meta = { request_id, contract_version, execution_mode }`（契约 1.0.0）；
 *   - `ETag` 由 `source_version`/revision 派生 —— **列表与详情使用同一 source_version**，
 *     使「下架/失效」能即时让旧缓存失效（详见 source-version.mjs）；
 *   - 未命中/缺项以正常 200 + `match_state` 表达，不伪造数据。
 *
 * 纯 ESM，无第三方依赖（uuid/meta 由 node:crypto 生成）。
 */

import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, EXECUTION_MODES, DEFAULT_LIMIT } from './constants.mjs';
import { loadCatalog } from './catalog.mjs';
import { loadHerbicideRecords, deterministicUuid } from './records.mjs';
import { normalizeQuery, runQuery, toDetail, paginate, evaluateEligibility } from './query.mjs';
import { ReferenceError } from './errors.mjs';
import { createVersionIndex, etagFor } from './source-version.mjs';
import { loadSeedBundle, listSeedHerbicides, findSeedHerbicidesByTerm, seedUsage } from './seed.mjs';
import { describeSeedRecord, seedLabel } from './labels.mjs';

/** 组 meta（契约 Meta：request_id uuid / contract_version const / execution_mode）。 */
export function buildMeta(executionMode, requestId) {
  if (!EXECUTION_MODES.includes(executionMode)) {
    throw new ReferenceError('INVALID_REQUEST', `未知执行模式：${executionMode}`);
  }
  return {
    request_id: requestId ?? randomUUID(),
    contract_version: CONTRACT_VERSION,
    execution_mode: executionMode,
  };
}

/**
 * 创建查询展示服务。
 * @param {object} options
 * @param {string} options.executionMode  'real' | 'stub' | 'preset_demo'
 */
export function createReferenceService({ executionMode = 'stub' } = {}) {
  const catalog = loadCatalog();
  const herbicideDoc = loadHerbicideRecords();
  const versionIndex = createVersionIndex(herbicideDoc.items);
  const seedBundle = loadSeedBundle();

  /** 目录枚举端点：作物 / 杂草 / 地区。 */
  function listCrops(input = {}, requestId) {
    const limit = normalizeLimit(input.limit);
    const page = paginateItems(catalog.crops, limit, input.cursor, (c) => c.id);
    return {
      body: { data: { items: page.items.map((c) => ({ id: c.id, name: c.name })), next_cursor: page.next_cursor }, meta: buildMeta(executionMode, requestId) },
      headers: cacheHeaders(null),
    };
  }

  function listSpecies(input = {}, requestId) {
    const limit = normalizeLimit(input.limit);
    const page = paginateItems(catalog.species, limit, input.cursor, (s) => s.id);
    const items = page.items.map((s) => ({
      id: s.id,
      canonical_name: s.canonical_name,
      scientific_name: s.scientific_name ?? null,
      coverage_state: s.coverage_state,
    }));
    return { body: { data: { items, next_cursor: page.next_cursor }, meta: buildMeta(executionMode, requestId) }, headers: cacheHeaders(null) };
  }

  function listRegions(input = {}, requestId) {
    const limit = normalizeLimit(input.limit);
    const page = paginateItems(catalog.regions, limit, input.cursor, (r) => r.code);
    const items = page.items.map((r) => ({
      code: r.code,
      name: r.name,
      parent_code: r.parent_code ?? null,
      catalog_version: r.catalog_version ?? catalog.catalogVersions.regions ?? 'unknown',
    }));
    return { body: { data: { items, next_cursor: page.next_cursor }, meta: buildMeta(executionMode, requestId) }, headers: cacheHeaders(null) };
  }

  /** /knowledge —— 科普资料列表（除草剂知识条目）。 */
  function listKnowledge(input = {}, requestId) {
    const query = normalizeQuery(input, catalog);
    const result = runQuery(herbicideDoc.items, query, catalog);
    // 契约 KnowledgePage.items 为**纯 Knowledge 对象**（additionalProperties:false）。
    // 不得塞入额外字段，也不得出现 undefined/null。
    const items = result.matched_items.map((item) => item.knowledge);
    const etag = etagFor(result.matched_items);
    // G1：冻结封套 KnowledgePageEnvelope 仅允许 data/meta → 响应除 `body` 外可挂载扩展字段，
    // 但**不得**写入 `body`（否则 additionalProperties:false 拒绝）。
    return {
      body: { data: { items, next_cursor: result.next_cursor }, meta: buildMeta(executionMode, requestId) },
      query_state: queryStateOf(result),
      headers: cacheHeaders(etag),
    };
  }

  function getKnowledge(id, input = {}, requestId) {
    const item = findById(herbicideDoc.items, 'knowledge', id);
    if (!item) throw new ReferenceError('NOT_FOUND', '未找到该资料');
    const verdict = evaluateEligibility(item, { includeSimulated: true });
    if (!verdict.queryable) throw new ReferenceError('NOT_FOUND', verdict.reason);
    const detail = toDetail(item, catalog);
    return { body: { data: detail.knowledge, meta: buildMeta(executionMode, requestId) }, headers: cacheHeaders(etagFor([item])) };
  }

  /** /herbicides —— 除草剂记录列表。 */
  function listHerbicides(input = {}, requestId) {
    const query = normalizeQuery(input, catalog);
    const result = runQuery(herbicideDoc.items, query, catalog);
    // 契约 HerbicidePage.items 为**纯 Herbicide 对象**（additionalProperties:false）：
    // 必须含 id/revision/formulation/source/risk_text/reference_state，且不得有额外字段。
    const items = result.matched_items.map((item) => item.contract);
    const etag = etagFor(result.matched_items);
    return {
      body: { data: { items, next_cursor: result.next_cursor }, meta: buildMeta(executionMode, requestId) },
      query_state: queryStateOf(result),
      headers: cacheHeaders(etag),
    };
  }

  function getHerbicide(id, input = {}, requestId) {
    const item = findById(herbicideDoc.items, 'herbicide', id);
    if (!item) throw new ReferenceError('NOT_FOUND', '未找到该除草剂记录');
    const verdict = evaluateEligibility(item, { includeSimulated: true });
    if (!verdict.queryable) throw new ReferenceError('NOT_FOUND', verdict.reason);
    const detail = toDetail(item, catalog);
    // G1：冻结封套 HerbicideEnvelope 仅允许 data/meta → detail_state 挂到响应顶层，不进 `body`。
    return { body: { data: detail.contract, meta: buildMeta(executionMode, requestId) }, detail_state: detailStateOf(detail, item), headers: cacheHeaders(etagFor([item])) };
  }

  /**
   * 种子资料（整理稿）· 除草剂名录列表。
   * 强制合规标注：`seed.label = 待核实·非权威`、`traceable_authority=false`、用量恒不展示。
   */
  function listSeedHerbicidesEndpoint(input = {}, requestId) {
    const limit = normalizeLimit(input.limit);
    let offset = 0;
    if (input.cursor !== null && input.cursor !== undefined && input.cursor !== '') {
      const n = Number(input.cursor);
      if (!Number.isInteger(n) || n < 0) throw new ReferenceError('INVALID_CURSOR', '游标无效或已过期');
      offset = n;
    }
    const page = listSeedHerbicides(seedBundle, { limit, offset, keyword: input.keyword ?? '' });
    const items = page.items.map((item) => seedHerbicideListItem(item));
    return {
      body: {
        data: { items, next_cursor: page.next_offset === null ? null : String(page.next_offset) },
        meta: buildMeta(executionMode, requestId),
        seed_state: { total: page.total, label: seedLabel(), usage: seedUsage() },
      },
      headers: cacheHeaders(seedEtag('herbicides', page.total)),
    };
  }

  /** 种子资料 · 单条除草剂详情（含强制标注与未采集用量标记）。 */
  function getSeedHerbicideEndpoint(seedId, input = {}, requestId) {
    void input;
    const item = seedBundle.herbicides.items.find((x) => x.seed_id === seedId) ?? null;
    if (!item) throw new ReferenceError('NOT_FOUND', '未找到该种子资料');
    return {
      body: {
        data: seedHerbicideListItem(item, true),
        meta: buildMeta(executionMode, requestId),
        seed_state: { label: seedLabel(), usage: seedUsage() },
      },
      headers: cacheHeaders(seedEtag('herbicides', seedBundle.herbicides.total ?? seedBundle.herbicides.count, seedId)),
    };
  }

  /** 种子资料 · 按中文药名/别称确定性检索（**不合并不同记录**）。 */
  function searchSeedHerbicides(term, requestId) {
    const items = findSeedHerbicidesByTerm(seedBundle, term).map((item) => seedHerbicideListItem(item));
    return {
      body: {
        data: { items },
        meta: buildMeta(executionMode, requestId),
        query_state: {
          match_state: items.length > 0 ? 'matched' : 'no_match',
          total: items.length,
          reasons: items.length > 0 ? [] : ['种子资料中无匹配药名'],
        },
        seed_state: { label: seedLabel(), usage: seedUsage() },
      },
      headers: cacheHeaders(null),
    };
  }

  /** 种子资料 · 目录计数（供概览）。 */
  function seedSummary(requestId) {
    return {
      body: {
        data: {
          counts: {
            herbicides: seedBundle.herbicides.count,
            weeds: seedBundle.weeds.count,
            weedMaster: seedBundle.weedMaster.count,
            provinces: seedBundle.provinceIndex.count,
            controlTiming: seedBundle.controlTiming.count,
          },
          label: seedLabel(),
        },
        meta: buildMeta(executionMode, requestId),
        seed_state: { usage: seedUsage() },
      },
      headers: cacheHeaders(null),
    };
  }

  return Object.freeze({
    executionMode,
    catalog,
    herbicideDoc,
    versionIndex,
    seedBundle,
    listCrops,
    listSpecies,
    listRegions,
    listKnowledge,
    getKnowledge,
    listHerbicides,
    getHerbicide,
    listSeedHerbicides: listSeedHerbicidesEndpoint,
    getSeedHerbicide: getSeedHerbicideEndpoint,
    searchSeedHerbicides,
    seedSummary,
    /** 供测试/页面读取的快照（不暴露内部可变结构）。 */
    snapshot() {
      return Object.freeze({
        catalog_versions: catalog.catalogVersions,
        herbicide_meta: herbicideDoc.docMeta,
        version_index_size: versionIndex.size,
        // H2：因来源元数据缺项被 fail-closed 排除的记录（缺项说明落于此，不在契约枚举字段）。
        skipped_records: herbicideDoc.skipped,
        seed_counts: {
          herbicides: seedBundle.herbicides.count,
          weeds: seedBundle.weeds.count,
          weedMaster: seedBundle.weedMaster.count,
          provinces: seedBundle.provinceIndex.count,
          controlTiming: seedBundle.controlTiming.count,
        },
        execution_mode: executionMode,
      });
    },
  });
}

/** 种子记录 → 对外展示项（强制标注「待核实·非权威」；用量恒不展示）。 */
function seedHerbicideListItem(item, withDetail = false) {
  const base = {
    seed_id: item.seed_id,
    name: item.name,
    aliases: item.aliases,
    hazard_level: item.hazard_level,
    target_weeds: item.target_weeds,
    regions: item.regions,
    // 用量：显式「未采集」，不以空白/模型补写。
    dosage: { status: 'not_collected', note: item.dosage.note },
    labels: describeSeedRecord(item),
  };
  if (withDetail) base.hazard_detail = item.hazard_detail;
  return base;
}

/** 种子数据 ETag：按「数据集 + 条数 + 可选键」派生；种子增减即失效。 */
function seedEtag(dataset, count, key) {
  const seed = `seed:${dataset}:${count}:${key ?? ''}`;
  return `"seed-${dataset}-${Buffer.from(seed).length.toString(16)}-${simpleHash(seed)}"`;
}

/** 简单稳定哈希（仅供 ETag 键派生，不用于安全）。 */
function simpleHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 按契约 id（herbicide 用 formulation id；knowledge 用 knowledge id）查记录。 */
function findById(items, kind, id) {
  if (kind === 'knowledge') return items.find((x) => x.knowledge.id === id) ?? null;
  return items.find((x) => x.contract.id === id) ?? null;
}

/** 查询状态（**非错误**；用于 UI 展示无结果原因与重筛入口）。 */
function queryStateOf(result) {
  return {
    match_state: result.match_state,
    total: result.total,
    reasons: result.reasons,
    unmatched_reasons: result.unmatched_reasons,
    simulated_excluded: result.simulated_excluded,
  };
}

/** 详情状态（含不可用原因、未采集字段，供 UI 明确标注）。 */
function detailStateOf(detail, item) {
  return {
    registration_number: item.registration_number,
    source_version: item.source_version,
    record_status: item.record_status,
    simulated: item.simulated,
    not_collected: detail.not_collected,
    verified_scope: detail.verified_scope,
    confidence_note: detail.confidence_note,
  };
}

function normalizeLimit(limit) {
  if (limit === undefined) return DEFAULT_LIMIT;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new ReferenceError('INVALID_REQUEST', 'limit 必须为 1..50 的整数');
  return n;
}

function paginateItems(list, limit, cursor, keyOf) {
  let start = 0;
  if (cursor !== null && cursor !== undefined && cursor !== '') {
    const idx = list.findIndex((x) => keyOf(x) === cursor);
    if (idx === -1) throw new ReferenceError('INVALID_CURSOR', '游标无效或已过期');
    start = idx + 1;
  }
  const slice = list.slice(start, start + limit);
  const next = start + limit < list.length ? keyOf(slice[slice.length - 1]) : null;
  return { items: slice, next_cursor: next };
}

function cacheHeaders(etag) {
  return {
    // 授权访问 no-store（契约 /knowledge 头说明）；有 etag 时附带 ETag 供一致性校验。
    'Cache-Control': 'no-store',
    ...(etag ? { ETag: etag } : {}),
  };
}

export { deterministicUuid };
