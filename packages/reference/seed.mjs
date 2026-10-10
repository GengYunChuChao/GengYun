/**
 * GY-I07 结构化**种子资料**装载与展示投影（指挥侧提供，整理稿）。
 *
 * 合规口径（db/seeds/gy-i07/INDEX.json usage_policy，强制）：
 *   - `data_origin = seed_unverified`、`authority = none`；
 *   - 展示须标注「待核实·非权威」（`SEED_REQUIRED_LABEL`）；
 *   - **不得显示真实用量**（剂量/浓度/施药量）；
 *   - **不得授予「专家认证」或用户经验认证标签**；
 *   - **不得声称可追溯权威来源**（本数据集为整理稿）；
 *   - **不得在缺项处用空白或模型补写填充**（缺项返回明确的 `not_collected` 标记）；
 *   - 地区表述：中国台湾/中国香港/中国澳门 按省级行政区处理。
 *
 * 设计：
 *   - 纯 ESM、零第三方依赖；只读 `db/seeds/gy-i07/*.json`。
 *   - 种子记录一律 `source_kind = 'verified_seed'`（契约 SourceKind），但**审核状态为
 *     `unverified`**、来源为整理稿（无逐条权威出处）→ 与 `packages/knowledge` 中
 *     「已核对种子」在**证据等级上区分**：本种子数据的 `authority=none`。
 *   - 每条记录带 `seed` 元数据块，供 UI 渲染「待核实·非权威」。
 *
 * **不在此处产出**：用量字段（本模块刻意不解析剂量列，且不生成任何剂量文本）。
 */

import { SEED_PATHS, readJson, SEED_REQUIRED_LABEL, SEED_DATA_ORIGIN, SEED_AUTHORITY } from './constants.mjs';
import { assertNoForbiddenLabel } from './labels.mjs';

/** 去空白（比较用，不改展示原文）。 */
function norm(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, '').toLowerCase() : '';
}

/**
 * 用法声明块（统一附加到各导出，供 UI/接口显式展示合规口径）。
 * `label_required` 即「待核实·非权威」。
 */
export function seedUsage() {
  return {
    data_origin: SEED_DATA_ORIGIN,
    authority: SEED_AUTHORITY,
    label_required: SEED_REQUIRED_LABEL,
    must_not: [
      '不得显示真实用量（剂量/浓度/施药量）',
      '不得授予「专家认证」或用户经验认证标签',
      '不得声称可追溯权威来源（本数据集为整理稿）',
      '不得在缺项处用空白或模型补写填充',
    ],
  };
}

/** 单条种子记录统一附加的 `seed` 元数据块。 */
function seedMeta(extra) {
  return Object.assign(
    {
      data_origin: SEED_DATA_ORIGIN,
      authority: SEED_AUTHORITY,
      label: SEED_REQUIRED_LABEL,
      traceable_authority: false,
    },
    extra || {},
  );
}

/** 缺项标记：**不以空白或模型补写**；缺项在返回结构中显式列出。 */
export const NOT_COLLECTED = '未采集（种子整理稿无此栏）';

/**
 * 载入除草剂种子（96 条）。
 * 投影：name / aliases / hazard_level / hazard_detail / target_weeds / regions。
 * **不含任何用量字段**（源数据与投影都无剂量/浓度）。
 */
export function loadSeedHerbicides() {
  const doc = readJson(SEED_PATHS.herbicides);
  const items = (doc.items || []).map((raw, index) => {
    const aliases = (raw.aliases || '')
      .split(/[、,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const record = {
      seed_id: `gy-i07-seed-hb-${String(index + 1).padStart(3, '0')}`,
      name: raw.name || '',
      aliases,
      hazard_level: raw.hazard_level || '',
      hazard_detail: raw.hazard_detail || '',
      target_weeds: raw.target_weeds || '',
      regions: raw.regions || '',
      // 用量刻意缺省且显式标记（不得以空白或模型补写填充）。
      dosage: { status: 'not_collected', note: NOT_COLLECTED },
      evidence_kind: 'experience',
      seed: seedMeta({ source_file: 'herbicides.json' }),
      norm: { name: norm(raw.name), aliases: aliases.map(norm) },
    };
    // 断言投影后的公开文案不含禁用标签（AC22）。
    assertNoForbiddenLabel([record.name, record.hazard_level, record.hazard_detail, record.target_weeds, record.regions].join(' '));
    return record;
  });
  return {
    count: items.length,
    declared_count: doc.count,
    usage: seedUsage(),
    disclaimer: doc.disclaimer || '',
    region_convention: doc.region_convention || '',
    items,
  };
}

/** 载入杂草识别种子（172 条）。 */
export function loadSeedWeeds() {
  const doc = readJson(SEED_PATHS.weeds);
  const items = (doc.items || []).map((raw, index) => ({
    seed_id: `gy-i07-seed-weed-${String(index + 1).padStart(3, '0')}`,
    name: raw.name || '',
    identify_key: raw.identify_key || '',
    seed: seedMeta({ source_file: 'weeds.json' }),
    norm: { name: norm(raw.name) },
  }));
  return {
    count: items.length,
    declared_count: doc.count,
    usage: seedUsage(),
    disclaimer: doc.disclaimer || '',
    items,
  };
}

/** 载入杂草总表（175 条，九栏；缺项以 NOT_COLLECTED 显式标注）。 */
export function loadSeedWeedMaster() {
  const doc = readJson(SEED_PATHS.weedMaster);
  const items = (doc.items || []).map((raw, index) => ({
    seed_id: `gy-i07-seed-wm-${String(index + 1).padStart(3, '0')}`,
    name: raw['杂草名称'] || '',
    scientific_name: raw['学名'] || NOT_COLLECTED,
    family_genus: raw['科属'] || NOT_COLLECTED,
    companion_crops: raw['伴生作物'] || NOT_COLLECTED,
    distribution_provinces: raw['分布省份（中国）'] || NOT_COLLECTED,
    growth_stages: raw['各生长时期状态描述'] || NOT_COLLECTED,
    best_control_period: raw['最佳防除时期'] || NOT_COLLECTED,
    application_window: raw['推荐施药／防除窗口'] || NOT_COLLECTED,
    identify_key: raw['识别要点'] || NOT_COLLECTED,
    // 刻意不解析/不生成任何剂量数值；施药窗口为**时期描述**而非用量。
    dosage: { status: 'not_collected', note: NOT_COLLECTED },
    seed: seedMeta({ source_file: 'weed_master.json' }),
  }));
  return {
    count: items.length,
    declared_count: doc.count,
    header: doc.header || [],
    usage: seedUsage(),
    disclaimer: doc.disclaimer || '',
    items,
  };
}

/** 载入省份索引（34 条，含中国台湾/中国香港/中国澳门 省级口径）。 */
export function loadSeedProvinceIndex() {
  const doc = readJson(SEED_PATHS.provinceIndex);
  const items = (doc.items || []).map((raw, index) => ({
    seed_id: `gy-i07-seed-prov-${String(index + 1).padStart(3, '0')}`,
    province: raw['省份／省级行政区'] || '',
    region: raw['所属大区'] || '',
    weed_count: raw['该省常见农田杂草（数量）'] || '',
    weed_list: raw['常见杂草清单'] || '',
    main_crops: raw['该省主要作物与说明'] || '',
    seed: seedMeta({ source_file: 'province_index.json' }),
  }));
  return {
    count: items.length,
    declared_count: doc.count,
    region_rule: doc.region_rule || '',
    usage: seedUsage(),
    disclaimer: doc.disclaimer || '',
    items,
  };
}

/** 载入作物防除时期（14 条）。 */
export function loadSeedControlTiming() {
  const doc = readJson(SEED_PATHS.controlTiming);
  const items = (doc.items || []).map((raw, index) => ({
    seed_id: `gy-i07-seed-ct-${String(index + 1).padStart(3, '0')}`,
    scene: raw['作物／场景'] || '',
    control_period: raw['防除关键期'] || '',
    target_weeds: raw['主要杂草对象'] || '',
    tips: raw['要点提示'] || '',
    dosage: { status: 'not_collected', note: NOT_COLLECTED },
    seed: seedMeta({ source_file: 'control_timing.json' }),
  }));
  return {
    count: items.length,
    declared_count: doc.count,
    usage: seedUsage(),
    disclaimer: doc.disclaimer || '',
    items,
  };
}

/** 载入使用说明（23 条纯文本行）。 */
export function loadSeedUsageNotes() {
  const doc = readJson(SEED_PATHS.usageNotes);
  const items = (doc.items || []).map((text, index) => ({
    seed_id: `gy-i07-seed-note-${String(index + 1).padStart(3, '0')}`,
    text: String(text || ''),
    seed: seedMeta({ source_file: 'usage_notes.json' }),
  }));
  return {
    count: items.length,
    declared_count: doc.count,
    usage: seedUsage(),
    disclaimer: doc.disclaimer || '',
    items,
  };
}

/**
 * 载入全部种子数据（惰性一次性装配，供服务与测试复用）。
 * 返回冻结结构，避免调用方误改。
 */
export function loadSeedBundle() {
  const bundle = {
    index: readJson(SEED_PATHS.index),
    herbicides: loadSeedHerbicides(),
    weeds: loadSeedWeeds(),
    weedMaster: loadSeedWeedMaster(),
    provinceIndex: loadSeedProvinceIndex(),
    controlTiming: loadSeedControlTiming(),
    usageNotes: loadSeedUsageNotes(),
    usage: seedUsage(),
  };
  return bundle;
}

/** 按中文药名/别名在种子除草剂里做确定性精确检索（不合并不同记录）。 */
export function findSeedHerbicidesByTerm(bundle, term) {
  const t = norm(term);
  if (!t) return [];
  return bundle.herbicides.items.filter((x) => x.norm.name === t || x.norm.aliases.includes(t));
}

/** 种子除草剂列表（分页，确定性按 seed_id 排序）。 */
export function listSeedHerbicides(bundle, { limit = 20, offset = 0, keyword = '' } = {}) {
  const t = norm(keyword);
  const all = bundle.herbicides.items
    .filter((x) => (t ? x.norm.name.includes(t) || x.norm.aliases.some((a) => a.includes(t)) : true))
    .slice()
    .sort((a, b) => (a.seed_id < b.seed_id ? -1 : a.seed_id > b.seed_id ? 1 : 0));
  const page = all.slice(offset, offset + limit);
  return { items: page, total: all.length, next_offset: offset + limit < all.length ? offset + limit : null };
}
