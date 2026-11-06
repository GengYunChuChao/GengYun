/**
 * GY-I07 查询展示层 · 目录装载与规范化检索。
 *
 * 装载 GY-I03 的资料契约（`packages/knowledge/catalog/*.json`），提供：
 *   - 作物（crop_id）／杂草（species_id）／浙江地区（region_code）／来源（source_id）字典；
 *   - **中文药名／登记号词典优先**：以规范化后的精确匹配优先于模糊匹配；
 *   - 别名（aliases）归一：用于导航与关键词筛选，**不用于合并不同含量剂型**。
 *
 * 边界：
 *   - 只读 `packages/knowledge/**`，不修改 GY-I03 交付物；
 *   - 目录缺项原样返回缺项，不补造。
 *
 * 纯 ESM，无第三方依赖。
 */

import { CATALOG_PATHS, COVERAGE_STATES, REGION_CODE_PATTERN, readJson } from './constants.mjs';

/** 归一化：去空白、全角转半角常见标点、小写化（用于比较，不改变展示原文）。 */
export function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\s+/g, '')
    .replace(/[·．\.]/g, '·')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .toLowerCase();
}

/** 提取可能的 6 位地区码（用于「浙A」式或纯数字输入）。 */
export function extractRegionCode(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/33\d{4}/);
  return m ? m[0] : null;
}

/**
 * 校验物种条目的 `id`：必须是非空字符串，且 trim 后唯一。
 *
 * 单独导出是为了让「目录里出现缺 id / 重复 id 时必须抛错」可被直接断言——
 * `loadCatalog()` 读固定路径、没有注入点，不导出就只能靠改真实 JSON 才能测到（`#1014`）。
 *
 * @param {readonly unknown[]} rows 物种条目数组（`species.json` 的 `species` 字段）
 * @returns {readonly string[]} trim 后的 id 列表（顺序与入参一致）
 */
export function assertSpeciesIds(rows) {
  if (!Array.isArray(rows)) {
    throw new Error(`species 列表不是数组：${typeof rows}`);
  }
  const seen = new Set();
  const ids = [];
  for (const s of rows) {
    if (typeof s !== 'object' || s === null || typeof s.id !== 'string' || s.id.trim() === '') {
      throw new Error(`species 条目缺少 id：${JSON.stringify(s).slice(0, 120)}`);
    }
    // 比较前 trim：闭集侧（provider/adapter）会 trim，若这里用原值比较，
    // `" species_x"` 与 `"species_x"` 都能过校验，随后在闭集里变成两个同名 id。
    const speciesId = s.id.trim();
    if (seen.has(speciesId)) {
      throw new Error(`species id 重复：${speciesId}`);
    }
    seen.add(speciesId);
    ids.push(speciesId);
  }
  return ids;
}

/** 装载目录字典（作物／杂草／来源／地区），返回冻结结构。 */
export function loadCatalog() {
  const crops = readJson(CATALOG_PATHS.crops);
  const species = readJson(CATALOG_PATHS.species);
  const sources = readJson(CATALOG_PATHS.sources);
  const regions = readJson(CATALOG_PATHS.regions);

  // 杂草覆盖状态校验：未知取值直接抛错，不静默接受。
  // id 的非空与唯一交给 assertSpeciesIds（同一个校验，装配路径与单测共用，`#1014`）。
  assertSpeciesIds(species.species);
  for (const s of species.species) {
    if (!COVERAGE_STATES.includes(s.coverage_state)) {
      throw new Error(`species ${s.id} 的 coverage_state 非法：${s.coverage_state}`);
    }
  }

  const cropById = new Map();
  const cropAlias = new Map(); // normalized alias/name -> crop_id
  for (const c of crops.crops) {
    cropById.set(c.id, c);
    cropAlias.set(normalizeText(c.name), c.id);
    for (const a of c.aliases ?? []) cropAlias.set(normalizeText(a), c.id);
  }

  const speciesById = new Map();
  const speciesAlias = new Map(); // normalized alias/group/canonical -> species_id
  for (const s of species.species) {
    speciesById.set(s.id, s);
    speciesAlias.set(normalizeText(s.group_name), s.id);
    speciesAlias.set(normalizeText(s.canonical_name), s.id);
    for (const a of s.aliases ?? []) speciesAlias.set(normalizeText(a), s.id);
  }

  const regionByCode = new Map();
  for (const r of regions.regions ?? regions.items ?? []) {
    // 宽容读取：不同版本字段名可能为 code/name 或 region_code/region_name，但必须能取到 6 位码。
    const code = r.code ?? r.region_code ?? r.adcode;
    const name = r.name ?? r.region_name;
    const parent = r.parent_code ?? r.parent ?? null;
    if (typeof code !== 'string' || !REGION_CODE_PATTERN.test(code)) continue;
    regionByCode.set(code, { code, name, parent_code: parent ?? null, catalog_version: regions.catalog_version ?? null });
  }

  const sourceById = new Map();
  for (const s of sources.sources) sourceById.set(s.id, s);

  return Object.freeze({
    crops: crops.crops,
    cropById,
    cropAlias,
    species: species.species,
    speciesById,
    speciesAlias,
    regions: [...regionByCode.values()],
    regionByCode,
    sources: sources.sources,
    sourceById,
    catalogVersions: Object.freeze({
      crops: crops.catalog_version ?? null,
      species: species.catalog_version ?? null,
      sources: null,
      regions: regions.catalog_version ?? null,
    }),
  });
}

/**
 * 解析导航输入为规范 id（**精确优先**）。
 * - 若输入本身是 crop_id / species_id，直接返回；
 * - 否则用归一化名称／别名查表（**仅用于导航，不作为剂型合并依据**）。
 * 返回 { kind: 'crop'|'species'|'region'|'unknown', id }。
 */
export function resolveNavTerm(catalog, raw) {
  const t = normalizeText(raw);
  if (t === '') return { kind: 'unknown', id: null };

  if (catalog.cropById.has(raw) || catalog.cropAlias.get(t)) {
    return { kind: 'crop', id: catalog.cropById.has(raw) ? raw : catalog.cropAlias.get(t) };
  }
  if (catalog.speciesById.has(raw) || catalog.speciesAlias.get(t)) {
    return { kind: 'species', id: catalog.speciesById.has(raw) ? raw : catalog.speciesAlias.get(t) };
  }
  const regionCode = extractRegionCode(raw);
  if (regionCode && catalog.regionByCode.has(regionCode)) {
    return { kind: 'region', id: regionCode };
  }
  return { kind: 'unknown', id: null };
}

/** 地区名校验：返回是否存在（用于条件不足判定，不编造缺项）。 */
export function hasRegion(catalog, regionCode) {
  return typeof regionCode === 'string' && catalog.regionByCode.has(regionCode);
}

/** 作物名校验。 */
export function hasCrop(catalog, cropId) {
  return typeof cropId === 'string' && catalog.cropById.has(cropId);
}

/** 杂草名校验。 */
export function hasSpecies(catalog, speciesId) {
  return typeof speciesId === 'string' && catalog.speciesById.has(speciesId);
}
