/**
 * GY-I07 · 浙江首批真实资料消费（来源：GY-I03 / PR #131 已合入清单）。
 *
 * 本模块把**已合入仓库**的浙江首批可复核清单
 * （`packages/knowledge/zhejiang/materials-zhejiang-v1.json`，schema
 * `gengyun.knowledge.zhejiang-materials.v1`）投影为 `/knowledge` 可消费的
 * **契约形状 `Knowledge` 条目**，并逐条保留可复核来源定位。
 *
 * 三条硬边界（逐条对应 issue #7 范围与验收 AC02/AC22）：
 *
 *   1. **未核对不得当已核对**：清单来源 `review_status='unverified'`，投影一律
 *      `source.review_status='unverified'`；正文也显式写出「未核对」。绝不改写为
 *      `verified`，也不进入「已核对」口径的有效集合。
 *   2. **未发布（private）不得冒充已发布**：清单条目 `visibility='private'`（未发布）。
 *      契约 `Knowledge`／`Herbicide` **没有** visibility 字段（`additionalProperties:false`），
 *      因此本模块**不新增字段**；`private` 语义以「只在**非 real** 执行模式下并入查询面 +
 *      逐条 `review_status=unverified` + 正文声明」如实表达，并在 `zhejiangState()` 里
 *      给调用方与文档一个可核对的显式状态（见 `visibility` / `published`）。
 *   3. **缺失事实不补齐（尤其用量）**：源工作簿无「标签原文用量／施用方法／注意事项／安全
 *      间隔期」列。清单 `dose_text` 恒为 `null`、`usable_as_dose=false`、`card_ready=false`；
 *      本模块**不推断、不换算、不生成**任何用量，`dose_cards` 恒为 `[]`，
 *      `doseCardDescriptor()` 对其恒判 `renderable=false`（原因 `not_usable`）。
 *
 * 来源 URL 策略（**不虚构来源**）：
 *   清单 `canonical_url` 为 `repo-external://samples/<原文件名>`（仓外只读样本，原文件不入库），
 *   全批**没有任何 `https://` 地址**。冻结契约 `SourceRef.url` 为必填且 `pattern: ^https://`。
 *   因此这里**不编造**真实机构域名，一律使用契约示例自身采用的**不可解析占位**
 *   （RFC 2606 保留域 `example.invalid`，见 `packages/contracts/examples.json:40`），
 *   并把**真实可复核定位**（原文件名 + sha256 + 工作表 + 行号 + 单元格范围 + 行指纹）
 *   逐条写进 `body`，使「任一展示记录能追溯实际来源」在不伪造 URL 的前提下仍然成立。
 *
 * 纯 ESM，零第三方依赖。不实现 HTTP、不接数据库、不生成用量建议。
 */

import {
  EVIDENCE_KINDS,
  SEED_DISCLAIMER,
  SEED_REQUIRED_LABEL,
  SOURCE_KINDS,
  readJson,
  assertInSet,
} from './constants.mjs';
import { deterministicUuid } from './records.mjs';
import { normalizeText } from './catalog.mjs';

/** 清单文件（仓库相对路径）。 */
export const ZHEJIANG_MATERIALS_PATH = 'packages/knowledge/zhejiang/materials-zhejiang-v1.json';

/** 清单 schema 与批次标识（与清单内自述一致，用于**校验**而不是覆盖）。 */
export const ZHEJIANG_SCHEMA = 'gengyun.knowledge.zhejiang-materials.v1';
export const ZHEJIANG_DATASET = 'zhejiang-first-batch';

/** 浙江省级地区码（清单全部条目的 `region_codes`；**只有省级证据**，不细分到县区）。 */
export const ZHEJIANG_PROVINCE_CODE = '330000';

/** 清单逐条自述的审核状态与可见性（**如实采用，不做提升**）。 */
export const ZHEJIANG_REVIEW_STATUS = 'unverified';
export const ZHEJIANG_VISIBILITY = 'private';

/**
 * 来源 URL 占位（**不是**真实来源地址，不得被当成来源）。
 *
 * 依据：`packages/contracts/examples.json` 自身以 `https://example.invalid/...` 表达
 * 「示例/不可解析」地址；`example.invalid` 属 RFC 2606 保留域，永不解析。
 * 之所以必须给一个值：冻结契约 `SourceRef.url` 必填且 `^https://`，
 * 而清单来源是仓外 `repo-external://` 样本、全批零 https —— 二者不可同时满足，
 * 补一个「看起来真实」的域名才是伪造来源。故此处显式使用不可解析占位，
 * 并把真实定位写入 `body.locator`。
 */
export const ZHEJIANG_SOURCE_URL_NOT_PUBLISHED = 'https://example.invalid/gengyun/source-not-published';

/** 用量缺项的统一文案（响应与文档共用；**不出现任何数值用量**）。 */
export const ZHEJIANG_DOSE_ABSENT_NOTE =
  '本条目源工作簿无「标签原文用量／施用方法／注意事项／安全间隔期」列：未采集即不提供，不推断、不换算、不生成用量卡片。';

/** 未核对声明的统一文案。 */
export const ZHEJIANG_UNVERIFIED_NOTE =
  '来源为整理稿且未逐条核对权威出处：审核状态=未核对（unverified），不得当作已核对资料。';

/** 清单里三类条目在契约 `Knowledge.type` 上的取值（与 build_seeds.py 的种子投影一致）。 */
const KIND_TO_KNOWLEDGE_TYPE = Object.freeze({
  weed: 'species',
  control_timing: 'scheme',
  herbicide_applicability: 'herbicide',
});

/** 清单中「用量族」字段：任一被补造都必须失败（缺项不得补齐）。 */
const DOSE_FAMILY_KEYS = Object.freeze(['dose_text', 'application_method_text', 'precautions_text', 'registration_number']);

/**
 * 清单批次纪律自检。**不通过即抛**（fail-closed）：宁可拒绝消费，也不把
 * 「未核对/缺用量」的条目渲染成已核对或有用量。
 *
 * @param {object} doc 清单 JSON
 * @returns {{https_urls: number, weed_items: number, control_timing_linked: number, herbicide_first_batch: number}}
 */
export function assertZhejiangDiscipline(doc) {
  if (doc?.schema !== ZHEJIANG_SCHEMA) {
    throw new Error(`浙江清单 schema 不符：期望 ${ZHEJIANG_SCHEMA}，实际 ${String(doc?.schema)}`);
  }
  if (doc?.dataset !== ZHEJIANG_DATASET) {
    throw new Error(`浙江清单 dataset 不符：期望 ${ZHEJIANG_DATASET}，实际 ${String(doc?.dataset)}`);
  }

  // 来源：逐条必须 review_status=unverified、validity=valid、枚举字段合法。
  const sources = doc.sources ?? [];
  if (sources.length === 0) throw new Error('浙江清单未登记任何来源');
  let httpsUrls = 0;
  for (const s of sources) {
    if (s.review_status !== ZHEJIANG_REVIEW_STATUS) {
      throw new Error(`浙江清单来源 ${s.id} 的 review_status 非 ${ZHEJIANG_REVIEW_STATUS}（不得把未核对当已核对）`);
    }
    assertInSet(s.source_kind, SOURCE_KINDS, `sources[${s.id}].source_kind`);
    assertInSet(s.evidence_kind, EVIDENCE_KINDS, `sources[${s.id}].evidence_kind`);
    const url = String(s.canonical_url ?? '');
    if (/^https:\/\//i.test(url)) httpsUrls += 1;
    if (!url.startsWith('repo-external://') && !/^https:\/\//i.test(url)) {
      throw new Error(`浙江清单来源 ${s.id} 的 canonical_url 既非 repo-external 也非 https：${url}`);
    }
  }

  // 用量族：工作簿没有这些列 ⇒ 必须显式缺项，**不得补造**。
  const policy = doc.dosage_policy ?? {};
  if (policy.dose_text !== 'absent_in_source' || policy.application_method_text !== 'absent_in_source'
    || policy.precautions_text !== 'absent_in_source') {
    throw new Error('浙江清单 dosage_policy 未显式声明用量/施用方法/注意事项缺项，拒绝消费');
  }

  // 用量族：工作簿**没有**这些列 ⇒ 字段缺失或显式 null 都可以；一旦被补造即拒绝。
  // 注意：逐条字段**缺失**不等于「有值」——缺项如实保留为缺失，才是正确形态；
  // 这里只把「被写入了值」判为违规（不要求清单必须出现 null 占位）。
  const checkDoseFamily = (item, where) => {
    for (const key of DOSE_FAMILY_KEYS) {
      if (key in item && item[key] !== null) {
        throw new Error(`${where} 出现被补造的用量族字段 ${key}（源工作簿无该列，必须为 null 或缺失）`);
      }
    }
    if ('usable_as_dose' in item && item.usable_as_dose !== false) {
      throw new Error(`${where} usable_as_dose 必须为 false（不得作为用量依据）`);
    }
    if ('card_ready' in item && item.card_ready !== false) {
      throw new Error(`${where} card_ready 必须为 false（不得生成用量卡片）`);
    }
  };

  for (const w of doc.weed_items ?? []) checkDoseFamily(w, `浙江杂草条目 ${w.item_id}`);
  for (const t of doc.control_timing_items ?? []) checkDoseFamily(t, `防除时期条目 ${t.item_id}`);
  for (const h of doc.herbicide_items ?? []) checkDoseFamily(h, `除草剂条目 ${h.item_id}`);

  const linked = (doc.control_timing_items ?? []).filter((t) => t.zhejiang_scope === 'scene_matches_zhejiang_main_crop').length;
  const firstBatch = (doc.herbicide_items ?? []).filter((h) => h.in_zhejiang_first_batch === true).length;
  if (firstBatch === 0) throw new Error('浙江清单首批除草剂条数为 0，与已合入清单不符');

  return Object.freeze({
    https_urls: httpsUrls,
    weed_items: (doc.weed_items ?? []).length,
    control_timing_linked: linked,
    herbicide_first_batch: firstBatch,
  });
}

/** 读取并自检浙江首批清单。自检失败即抛（不静默降级）。 */
export function loadZhejiangMaterials() {
  const doc = readJson(ZHEJIANG_MATERIALS_PATH);
  const discipline = assertZhejiangDiscipline(doc);
  return Object.freeze({ doc: Object.freeze(doc), discipline });
}

/** 从品类目录解析作物名 → crop_id（与 tools/knowledge/build_seeds.py::zj_crop_id 同口径）。 */
function cropIdOf(crops, name) {
  for (const c of crops) {
    if (c.name === name) return c.id;
    if (Array.isArray(c.aliases) && c.aliases.includes(name)) return c.id;
  }
  return null;
}

/** 从品类目录解析杂草名/别称 → species_id（与 build_seeds.py::zj_species_id 同口径）。 */
function speciesIdOf(species, item) {
  const tokens = new Set([item?.canonical_name ?? '', ...(item?.parenthetical_aliases ?? [])].filter((x) => x !== ''));
  for (const sp of species) {
    const names = new Set([sp.canonical_name ?? '', sp.group_name ?? '', ...(sp.aliases ?? [])]);
    for (const t of tokens) if (names.has(t)) return sp.id;
  }
  return null;
}

/** 去重且丢弃空值（保持出现顺序）。 */
function dedupe(seq) {
  const out = [];
  for (const x of seq) if (x && !out.includes(x)) out.push(x);
  return out;
}

/** `source` 结构 → 契约 `SourceRef`（url 见文件头「来源 URL 策略」）。 */
function toSourceRef(source) {
  return Object.freeze({
    id: deterministicUuid(`zhejiang-source:${source.id}`),
    version: String(source.version),
    title: String(source.title),
    url: ZHEJIANG_SOURCE_URL_NOT_PUBLISHED,
    publisher: String(source.publisher),
    source_kind: source.source_kind,
    evidence_kind: source.evidence_kind,
    validity: String(source.validity ?? 'valid'),
    review_status: ZHEJIANG_REVIEW_STATUS,
    updated_at: toIsoDateTime(source.retrieved_at),
  });
}

/** 日期/时间 → ISO（仅日期时按 UTC 零点；解析失败时抛，不编造时间）。 */
function toIsoDateTime(value) {
  const text = typeof value === 'string' ? value : '';
  const ms = text === '' ? Number.NaN : Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text);
  if (!Number.isFinite(ms)) throw new Error(`浙江清单时间字段不可解析：${JSON.stringify(value)}`);
  return new Date(ms).toISOString();
}

/** 逐条来源定位（可复核证据：原文件哈希 + 工作表 + 行 + 单元格 + 行指纹）。 */
function provenanceOf(item) {
  const s = item.source ?? {};
  const locator = String(s.locator ?? '');
  if (locator === '') throw new Error(`浙江清单条目 ${item.item_id} 缺少可复核 locator`);
  return Object.freeze({
    locator,
    row_sha256: String(s.row_sha256 ?? ''),
    file_sha256: String(s.file_sha256 ?? ''),
    sheet: String(s.sheet ?? ''),
    excel_row: Number(s.excel_row ?? 0),
    cell_range: String(s.cell_range ?? ''),
    file: String(s.file ?? ''),
    source_id: String(s.source_id ?? ''),
    source_version: String(s.source_version ?? ''),
  });
}

/** 组装可读正文（含逐条可复核定位与缺项声明；**不含任何用量数值**）。 */
function buildBody(record, source) {
  const rows = [];
  const push = (label, value) => {
    const text = typeof value === 'string' && value.trim() !== '' ? value.trim() : '未采集';
    rows.push(`${label}：${text}`);
  };
  push('条目', record.title);
  push('类别', record.category_text);
  if (record.kind === 'weed') {
    push('学名', record.raw.scientific_name);
    push('科属', record.raw.family_genus);
    push('伴随作物', record.raw.companion_crops_text);
    push('分布', record.raw.distribution_note || record.raw.distribution_text);
    push('生育阶段识别', record.raw.growth_stages_text);
    push('最佳防除时期', record.raw.best_control_stage_text);
    push('施药窗口', record.raw.spray_window_text);
    push('田间识别要点', record.raw.identification_key_text);
    push('浙江适用依据等级', record.raw.zhejiang_evidence_strength);
  } else if (record.kind === 'control_timing') {
    push('场景', record.raw.scene_text);
    push('关键窗口', record.raw.critical_window_text);
    push('防治对象', record.raw.target_weeds_text);
    push('要点', record.raw.key_points_text);
    push('浙江适用依据', record.raw.zhejiang_scope_basis);
  } else {
    push('药剂名', record.raw.herbicide_name);
    push('别名', record.raw.aliases_text);
    push('危害等级', record.raw.hazard_level_text);
    push('危害说明', record.raw.hazard_detail_text);
    push('防治对象', record.raw.target_weeds_text);
    push('适用地区（原文）', record.raw.region_text);
    push('浙江适用范围依据', record.raw.zhejiang_basis);
  }
  push('来源', source.title);
  push('发布方', source.publisher);
  push('来源版本', source.version);
  push('来源审核状态', `${ZHEJIANG_UNVERIFIED_NOTE}（review_status=${ZHEJIANG_REVIEW_STATUS}）`);
  push('来源定位（可复核）', record.provenance.locator);
  push('源表工作表/行/单元格', `${record.provenance.sheet} r${record.provenance.excel_row} ${record.provenance.cell_range}`);
  push('行指纹（row_sha256）', record.provenance.row_sha256);
  push('原文件 sha256（原文件不入库）', record.provenance.file_sha256);
  push('用量', ZHEJIANG_DOSE_ABSENT_NOTE);
  push('合规说明', `${SEED_REQUIRED_LABEL}：${SEED_DISCLAIMER}`);
  return rows.join('\n');
}

/**
 * 由清单构造成**内部记录**（含契约投影 + 展示/判定所需明细）。
 * 纯函数：同一清单输入恒得同一输出（确定性 id / 顺序）。
 *
 * @param {{doc: object}} bundle loadZhejiangMaterials() 的结果（可注入同构清单用于负例回归）
 * @param {{crops: object[], species: object[]}} catalogs 品类目录
 */
export function zhejiangKnowledgeRecords(bundle, catalogs) {
  const doc = bundle?.doc ?? bundle;
  assertZhejiangDiscipline(doc);
  const crops = catalogs?.crops ?? [];
  const species = catalogs?.species ?? [];
  const sourceById = new Map((doc.sources ?? []).map((s) => [s.id, s]));

  /** 组装单条内部记录。 */
  const build = ({ raw, kind, title, category_text, crop_ids, species_ids, item_id }) => {
    const provenance = provenanceOf(raw);
    const sourceRow = sourceById.get(provenance.source_id);
    if (!sourceRow) throw new Error(`浙江清单条目 ${item_id} 引用了未登记的来源 ${provenance.source_id}`);
    if (String(sourceRow.version) !== provenance.source_version) {
      throw new Error(`浙江清单条目 ${item_id} 的 source_version 与登记来源不一致`);
    }
    const source = toSourceRef(sourceRow);
    const type = KIND_TO_KNOWLEDGE_TYPE[kind];
    if (!type) throw new Error(`浙江清单条目 ${item_id} 的类别未知：${kind}`);
    const record = {
      item_id,
      kind,
      type,
      title,
      category_text,
      raw,
      provenance,
      source,
      source_version: `${provenance.source_id}@${source.version}#${provenance.file_sha256.slice(0, 12)}`,
      content_hash: provenance.row_sha256,
      crop_ids: dedupe(crop_ids),
      species_ids: dedupe(species_ids),
      region_codes: [ZHEJIANG_PROVINCE_CODE],
      visibility: ZHEJIANG_VISIBILITY,
      review_status: ZHEJIANG_REVIEW_STATUS,
      validity: source.validity,
      simulated: false,
      // 用量一族：源工作簿缺列 ⇒ 显式缺项，绝不补造。
      dose_text: null,
      usable_as_dose: false,
      card_ready: false,
      verification: Object.freeze({
        usable_as_dose: false,
        review_status: ZHEJIANG_REVIEW_STATUS,
        dose: null,
        not_collected: Object.freeze(['标签原文用量', '施用方法', '注意事项', '安全间隔期', '登记证号']),
      }),
    };
    record.reference_state = record.validity === 'valid' ? 'available' : 'unavailable';
    const body = buildBody(record, source);
    record.body = body;
    record.knowledge = Object.freeze({
      id: deterministicUuid(`zhejiang-knowledge:${item_id}`),
      revision: 1,
      type,
      title,
      body,
      source,
      // 适用条件未结构化采集（清单只有省级 region 证据，无逐条作物×地区条件）：
      // 契约允许整体 null，**不编造条件**去凑必填。
      conditions: null,
      reference_state: 'available',
      // 用量卡恒空：源工作簿无用量列，不推断、不生成。
      dose_cards: Object.freeze([]),
    });
    return Object.freeze(record);
  };

  const items = [];
  for (const w of doc.weed_items ?? []) {
    items.push(build({
      raw: w,
      kind: 'weed',
      title: `浙江适用杂草：${w.weed_name}`,
      category_text: '浙江适用杂草',
      crop_ids: (w.companion_crops ?? []).map((c) => cropIdOf(crops, c)),
      species_ids: [speciesIdOf(species, w)],
      item_id: w.item_id,
    }));
  }
  for (const t of doc.control_timing_items ?? []) {
    if (t.zhejiang_scope !== 'scene_matches_zhejiang_main_crop') continue;
    items.push(build({
      raw: t,
      kind: 'control_timing',
      title: `浙江防除时期：${t.scene_text}`,
      category_text: '浙江防除时期',
      crop_ids: (t.matched_main_crops ?? []).map((c) => cropIdOf(crops, c)),
      species_ids: [],
      item_id: t.item_id,
    }));
  }
  for (const h of doc.herbicide_items ?? []) {
    if (h.in_zhejiang_first_batch !== true) continue;
    items.push(build({
      raw: h,
      kind: 'herbicide_applicability',
      title: `浙江适用除草剂（环境风险与适用信息）：${h.herbicide_name}`,
      category_text: '浙江适用除草剂适用信息',
      crop_ids: [],
      species_ids: [],
      item_id: h.item_id,
    }));
  }
  return Object.freeze(items);
}

/** 读取品类目录（作物/杂草），供 id 解析。失败即抛（不静默空目录）。 */
export function loadZhejiangCatalogs() {
  const crops = readJson('packages/knowledge/catalog/crops.json').crops ?? [];
  const species = readJson('packages/knowledge/catalog/species.json').species ?? [];
  return Object.freeze({ crops, species });
}

/**
 * 浙江首批记录的「一次性装载」入口（域库/API 共用）。
 * 返回 `{ doc, items, state }`。
 */
export function loadZhejiangKnowledge() {
  const bundle = loadZhejiangMaterials();
  const items = zhejiangKnowledgeRecords(bundle, loadZhejiangCatalogs());
  return Object.freeze({ doc: bundle.doc, items, state: zhejiangState(bundle.doc, items) });
}

/**
 * 浙江批次的**如实状态**（供装配层判定与文档/测试核对）。
 * 契约没有 visibility 字段，故 `private`／未发布语义只能在此显式给出。
 */
export function zhejiangState(doc, items) {
  const discipline = assertZhejiangDiscipline(doc);
  const list = items ?? [];
  const byKind = { weed: 0, control_timing: 0, herbicide_applicability: 0 };
  for (const it of list) byKind[it.kind] += 1;
  return Object.freeze({
    schema: doc.schema,
    dataset: doc.dataset,
    release: doc.release,
    region_code: ZHEJIANG_PROVINCE_CODE,
    review_status: ZHEJIANG_REVIEW_STATUS,
    visibility: ZHEJIANG_VISIBILITY,
    published: false,
    source_kind: (doc.sources ?? []).map((s) => s.source_kind),
    https_source_urls: discipline.https_urls,
    source_url_policy: {
      url: ZHEJIANG_SOURCE_URL_NOT_PUBLISHED,
      resolvable: false,
      reason: '清单来源为仓外 repo-external 样本且全批零 https；冻结契约 SourceRef.url 必填且 ^https://，'
        + '故使用 RFC 2606 保留域不可解析占位，并在 body 内给出真实 locator；不编造真实机构地址。',
    },
    dose: { dose_text: null, usable_as_dose: false, card_ready: false, dose_cards: 0 },
    counts: Object.freeze({ ...byKind, total: list.length }),
    required_label: SEED_REQUIRED_LABEL,
  });
}

/**
 * 确定性结构化查询浙江首批条目（**结构化条件优先，不静默放宽**）。
 *
 * 与既有 `/knowledge` 数据库投影同口径：
 *   - `crop_id`/`species_id`/`region_code` 按**显式数组成员精确匹配**，空数组不解释为「全适用」；
 *   - `region_code` 只登记到**省级** `330000`，因此县区码查询不会命中（不猜测层级归属）；
 *   - `growth_stage`/`planting_method`/`use_scene` 在这批清单里**没有结构化证据**，
 *     指定即不命中并给出可读原因（**绝不丢弃该条件继续展示**）；
 *   - 无任何条件时返回全部（仍逐条标注未核对）。
 *
 * @returns {{match_state: string, items: object[], reasons: string[]}}
 */
export function queryZhejiangKnowledge(items, query = {}) {
  const q = normalizeText(typeof query.q === 'string' ? query.q : '');
  const growthStage = trimOrNull(query.growth_stage);
  const plantingMethod = trimOrNull(query.planting_method);
  const useScene = trimOrNull(query.use_scene);
  const reasons = [];

  if (growthStage || plantingMethod || useScene) {
    return Object.freeze({
      match_state: 'insufficient',
      items: Object.freeze([]),
      reasons: Object.freeze(['浙江首批清单未结构化采集生育期／种植方式／使用场景条件，无法确认适用性（不丢弃条件继续展示）']),
    });
  }

  const matched = items.filter((it) => {
    if (query.crop_id && !it.crop_ids.includes(query.crop_id)) return false;
    if (query.species_id && !it.species_ids.includes(query.species_id)) return false;
    if (query.region_code && !it.region_codes.includes(query.region_code)) return false;
    if (q !== '' && !normalizeText(`${it.title}\n${it.body}`).includes(q)) return false;
    return true;
  });

  const hasCondition = Boolean(q || query.crop_id || query.species_id || query.region_code);
  if (matched.length === 0) {
    reasons.push(hasCondition ? '浙江首批清单中无满足该条件的条目（条件不满足不静默放宽）' : '浙江首批清单为空');
  }
  return Object.freeze({
    match_state: matched.length > 0 ? 'matched' : (hasCondition ? 'no_match' : 'insufficient'),
    items: Object.freeze(matched.slice()),
    reasons: Object.freeze(reasons),
  });
}

function trimOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
