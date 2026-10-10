// GY-I07 科普／除草剂查询 · 小程序侧数据适配层。
//
// 边界（与 shared source 的联网约束一致）：
// - 共享源码 runtime.mode 恒为 'disabled'，**不发起网络请求、不伪造服务端响应**。
// - 本文件装载**仓库内同一份资料契约**（packages/knowledge/**），做与域库
//   packages/reference 口径一致的确定性过滤与展示投影。
// - 页面在未联网时展示的是**真实资料契约内容 + 明确的替身边界说明**，
//   不把「本地读数」写成「在线权威查询结果」。
//
// 安全：不保存凭据；不生成用量建议；不出现"专家已审/绝对安全"等禁用标签。

const crops = require('../data/crops.js')
const species = require('../data/species.js')
const records = require('../data/records-2026.js')
const sources = require('../data/sources.js')

// 归一化：去空白、小写化（比较用，不改展示原文）。
function norm(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, '').toLowerCase() : ''
}

// 作物别名索引（导航用，不用于合并剂型）。
const cropIndex = {}
for (const c of crops.crops) {
  cropIndex[norm(c.name)] = c.id
  for (const a of c.aliases || []) cropIndex[norm(a)] = c.id
}
const cropById = {}
for (const c of crops.crops) cropById[c.id] = c

const speciesIndex = {}
for (const s of species.species) {
  speciesIndex[norm(s.group_name)] = s.id
  speciesIndex[norm(s.canonical_name)] = s.id
  for (const a of s.aliases || []) speciesIndex[norm(a)] = s.id
}
const speciesById = {}
for (const s of species.species) speciesById[s.id] = s

const sourceById = {}
for (const s of sources.sources) sourceById[s.id] = s

// 记录规范化（与域库口径一致的可见性/有效期判定）。
// F5：source_version 派生算法与域库 packages/reference/records.mjs deriveSourceVersion **逐字一致**：
//     `<source_id>@<version|issue|retrieved_at|unknown>#<attachment_sha256|content_hash 前 12 位>`
//     （哈希缺失时不追加 '#' 段）。列表 = 详情 = 域库，三处同源。
function deriveSourceVersion(source) {
  const s = source || {}
  const versionPart = s.version !== undefined && s.version !== null ? s.version : (s.issue !== undefined && s.issue !== null ? s.issue : (s.retrieved_at !== undefined && s.retrieved_at !== null ? s.retrieved_at : 'unknown'))
  const hashSource = s.attachment_sha256 || s.content_hash || ''
  const hash12 = typeof hashSource === 'string' ? hashSource.slice(0, 12) : ''
  return (s.source_id || 'unknown') + '@' + versionPart + (hash12 ? '#' + hash12 : '')
}

const normalized = records.records.map(function (r) {
  const simulated = String(r.registration_number || '').indexOf('SIM-') === 0 || (r.source && r.source.source_kind === 'simulation')
  const validity = (r.source && (r.source.source_validity || r.source.validity)) || 'unknown'
  const sourceVersion = deriveSourceVersion(r.source)
  return {
    record_id: r.record_id,
    registration_number: r.registration_number,
    registered_name: r.registered_name,
    producer: r.producer,
    dosage_form: r.dosage_form,
    ingredients_text: r.ingredients_text,
    toxicity: r.toxicity,
    use_scene: r.use_scene,
    target_original: r.target_original,
    crop_ids: r.crop_ids || [],
    record_status: r.record_status || 'partial',
    source_version: sourceVersion,
    validity: validity,
    visibility: r.visibility || 'published',
    simulated: simulated,
    source: r.source || {},
    verification: r.verification || {},
    norm: {
      name: norm(r.registered_name),
      producer: norm(r.producer),
      registration: norm(r.registration_number),
      ingredients: norm(r.ingredients_text),
      use_scene: norm(r.use_scene || ''),
      target: norm(r.target_original || '')
    }
  }
})

// 有效判定（列表与详情同源同判）：仅 validity=valid 且 visibility=published 且非模拟。
function isEligible(item) {
  if (item.visibility !== 'published') return { ok: false, reason: item.visibility === 'hidden' ? '该记录已下架' : '该记录当前不可见' }
  if (item.validity !== 'valid') {
    const map = { expired: '来源已过期', withdrawn: '来源已撤回', conflicting: '来源相互冲突', unknown: '来源有效期未知' }
    return { ok: false, reason: map[item.validity] || '来源有效期不可用' }
  }
  if (item.simulated) return { ok: false, reason: '模拟演示记录（非真实资料）' }
  return { ok: true, reason: null }
}

function resolveCropId(term) {
  if (!term) return null
  if (cropById[term]) return term
  return cropIndex[norm(term)] || null
}

function resolveSpeciesId(term) {
  if (!term) return null
  if (speciesById[term]) return term
  return speciesIndex[norm(term)] || null
}

// 展示标签（**不含**禁用词；模拟记录强标记）。
function labels(item) {
  const kindMap = { database: '在线数据库记录', verified_seed: '已核对种子资料', simulation: '模拟演示数据（非真实资料）' }
  const evidenceMap = { research: '科研来源', experience: '经验来源', mixed: '科研与经验混合' }
  const reviewMap = { unverified: '未核对', verified: '已核对', rejected: '已驳回' }
  return {
    source_kind: kindMap[item.source.source_kind] || '来源类型未知',
    evidence_kind: evidenceMap[item.source.evidence_kind] || '证据类型未知',
    review_status: reviewMap[item.verification.review_status] || '审核状态未知',
    record_status: item.simulated ? '模拟演示数据（非真实资料）' : (item.record_status === 'partial' ? '字段不完整' : '字段完整'),
    dose: '本记录未采集用量字段，不提供用量信息'
  }
}

// 查询（确定性结构化过滤：作物/杂草/地区/关键词/登记号）。
//
// 参数（页面与域库同形）：
//   crop_id / species_id / region_code —— 结构化条件（优先；中文名经 resolveCropId 兜底）
//   keyword —— 中文药名／登记号／成分词典匹配
//   registration_number —— 登记证号精确匹配
//   limit (1..50，默认 20) / cursor —— 游标分页
// 语义：无结果 / 条件不足**不是错误**，以 200 + match_state 表达；
//       仅请求非法（游标损坏）才抛错（与域库一致）。
function query(params) {
  params = params || {}
  // F4：与域库 packages/reference 同口径的**严格输入校验**——非法一律抛 INVALID_REQUEST，
  // 不得静默降级为「全量匹配」或改写 match_state。
  validateQueryInput(params)
  const cropId = resolveCropId(params.crop_id || params.crop)
  const speciesId = resolveSpeciesId(params.species_id || params.species)
  const regionCode = typeof params.region_code === 'string' ? params.region_code : ''
  const q = norm(params.keyword || params.q)
  const reg = norm(params.registration_number)
  // G3：读取结构化条件 use_scene / growth_stage / planting_method（此前被忽略 → 静默放宽）。
  const useScene = norm(params.use_scene)
  const growthStage = norm(params.growth_stage)
  const plantingMethod = norm(params.planting_method)
  const limit = clampLimit(params.limit)
  const offset = decodeCursor(params.cursor)

  const eligible = []
  let simulatedExcluded = 0
  for (const item of normalized) {
    const v = isEligible(item)
    if (v.ok) eligible.push(item)
    else if (item.simulated) simulatedExcluded += 1
  }

  const matched = []
  const unmatched = []
  for (const item of eligible) {
    const reasons = []
    if (cropId && item.crop_ids.indexOf(cropId) === -1) reasons.push('作物不符（记录未覆盖该作物）')
    if ((params.species_id || params.species) && !speciesId) reasons.push('所选杂草未在目录中登记')
    if ((params.species_id || params.species) && speciesId) reasons.push('记录未结构化标注杂草对象，无法按所选杂草确认')
    if (regionCode) reasons.push('记录未标注适用地区，无法确认是否适用该地区')
    if (reg && item.norm.registration !== reg) reasons.push('登记证号不符')
    // G3：use_scene 做子串匹配（与域库 matchConditions 口径一致）。
    if (useScene) {
      if (item.norm.use_scene.indexOf(useScene) === -1) reasons.push('使用场景不符')
    }
    // G3：growth_stage / planting_method —— 首批资料**未采集**这两个条件，
    //     与域库一致：保留「记录未采集」的真实不匹配状态（不得静默放宽为全量匹配）。
    if (growthStage || plantingMethod) reasons.push('记录未采集生育期／种植方式条件')
    if (q) {
      const hay = [item.norm.name, item.norm.producer, item.norm.registration, item.norm.ingredients, item.norm.use_scene, item.norm.target].join(' ')
      if (hay.indexOf(q) === -1) reasons.push('关键词不匹配')
    }
    if (reasons.length === 0) matched.push(item)
    else unmatched.push({ record_id: item.record_id, reasons: reasons })
  }

  matched.sort(function (a, b) { return a.registration_number < b.registration_number ? -1 : a.registration_number > b.registration_number ? 1 : 0 })

  const hasCondition = Boolean(cropId || params.species_id || params.species || regionCode || q || reg || params.use_scene || params.growth_stage || params.planting_method)
  let matchState
  const reasonsOut = []
  if (matched.length > 0) {
    matchState = 'matched'
  } else if (eligible.length === 0) {
    matchState = 'no_match'
    reasonsOut.push('当前条件下没有可用资料')
  } else {
    const anyInsufficient = unmatched.some(function (u) { return u.reasons.some(function (x) { return x.indexOf('未标注') !== -1 || x.indexOf('未采集') !== -1 }) })
    matchState = anyInsufficient ? 'insufficient' : 'no_match'
    reasonsOut.push(anyInsufficient ? '部分条件在资料中未标注，无法确认适用性' : '现有资料均不满足所选条件')
  }

  // 游标分页：与域库同口径（offset 编码，越界即止）。
  const page = matched.slice(offset, offset + limit)
  const nextOffset = offset + limit
  const nextCursor = nextOffset < matched.length ? encodeCursor(nextOffset) : null

  return {
    match_state: matchState,
    has_condition: hasCondition,
    items: page.map(listItem),
    total: matched.length,
    next_cursor: nextCursor,
    reasons: reasonsOut,
    unmatched_reasons: unmatched.slice(0, 10),
    simulated_excluded: simulatedExcluded
  }
}

function clampLimit(value) {
  if (value === undefined || value === null || value === '') return 20
  const n = Number(value)
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < 1 || n > 50) throw invalidRequest('limit 必须为 1..50 的整数')
  return n
}

// F4：请求参数校验（与域库 normalizeQuery 口径一致）。
// 非法输入必须显式失败（INVALID_REQUEST），不得静默丢弃条件或退回全量匹配。
const MAX_QUERY_LENGTH = 80
const REGION_CODE_PATTERN = /^33[0-9]{4}$/

function invalidRequest(message) {
  const error = new Error(message)
  error.code = 'INVALID_REQUEST'
  return error
}

function validateQueryInput(params) {
  const rawQ = params.keyword !== undefined ? params.keyword : params.q
  if (typeof rawQ === 'string' && rawQ.trim().length > MAX_QUERY_LENGTH) {
    throw invalidRequest('关键词长度不得超过 ' + MAX_QUERY_LENGTH)
  }
  // 作物：提供了但不在目录中 → 非法（域库同样抛 INVALID_REQUEST）。
  const cropTerm = params.crop_id !== undefined ? params.crop_id : params.crop
  if (cropTerm !== undefined && cropTerm !== null && cropTerm !== '' && !resolveCropId(cropTerm)) {
    throw invalidRequest('作物未在目录中登记')
  }
  // 杂草：同上。
  const speciesTerm = params.species_id !== undefined ? params.species_id : params.species
  if (speciesTerm !== undefined && speciesTerm !== null && speciesTerm !== '' && !resolveSpeciesId(speciesTerm)) {
    throw invalidRequest('杂草未在目录中登记')
  }
  // 地区：非 33 开头 6 位码即非法（不静默忽略）。
  const regionTerm = params.region_code !== undefined ? params.region_code : params.region
  if (regionTerm !== undefined && regionTerm !== null && regionTerm !== '') {
    if (typeof regionTerm !== 'string' || !REGION_CODE_PATTERN.test(regionTerm)) {
      throw invalidRequest('地区须为浙江 33 开头的 6 位地区码')
    }
  }
  // G3：结构化条件类型校验（与域库一致——非字符串即非法，不静默丢弃）。
  for (const key of ['use_scene', 'growth_stage', 'planting_method']) {
    const v = params[key]
    if (v !== undefined && v !== null && v !== '' && typeof v !== 'string') {
      throw invalidRequest(key + ' 必须为字符串')
    }
    if (typeof v === 'string' && v.length > MAX_QUERY_LENGTH) {
      throw invalidRequest(key + ' 长度不得超过 ' + MAX_QUERY_LENGTH)
    }
  }
}

// 游标（与域库同形：base64url('offset:<n>')）。损坏游标抛错，由页面兜底提示。
function encodeCursor(offset) {
  const raw = 'offset:' + offset
  return typeof Buffer !== 'undefined'
    ? Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    : raw
}

function decodeCursor(cursor) {
  if (!cursor) return 0
  let raw = String(cursor)
  try {
    if (typeof Buffer !== 'undefined') raw = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  } catch (_) {
    throw new Error('INVALID_CURSOR')
  }
  const m = /^offset:(\d+)$/.exec(raw)
  if (!m) throw new Error('INVALID_CURSOR')
  return Number(m[1])
}

function listItem(item) {
  return {
    record_id: item.record_id,
    registration_number: item.registration_number,
    registered_name: item.registered_name,
    dosage_form: item.dosage_form,
    ingredients_text: item.ingredients_text,
    toxicity: item.toxicity,
    use_scene: item.use_scene,
    crop_ids: item.crop_ids,
    source_version: item.source_version,
    record_status: item.record_status,
    simulated: item.simulated,
    labels: labels(item)
  }
}

function detail(recordId) {
  const item = normalized.filter(function (x) { return x.record_id === recordId })[0]
  if (!item) return null
  const v = isEligible(item)
  return {
    record_id: item.record_id,
    registration_number: item.registration_number,
    registered_name: item.registered_name,
    producer: item.producer,
    dosage_form: item.dosage_form,
    ingredients_text: item.ingredients_text,
    toxicity: item.toxicity,
    use_scene: item.use_scene,
    target_original: item.target_original,
    crop_ids: item.crop_ids,
    source_version: item.source_version,
    record_status: item.record_status,
    queryable: v.ok,
    unavailable_reason: v.reason,
    verified_scope: item.verification.source_checked_scope || [],
    not_collected: item.verification.not_collected || [],
    note: item.verification.note || '',
    labels: labels(item),
    source: {
      publisher: item.source.publisher || '',
      issue: item.source.issue || '',
      original_url: item.source.original_url || '',
      retrieved_at: item.source.retrieved_at || ''
    }
  }
}

const REGION_CATALOG_VERSION = require('../data/regions.js').catalog_version

// 匹配状态标签（不出现"权威/已审/绝对安全"等禁用词）。
const MATCH_STATE_LABELS = {
  matched: '已找到符合条件的资料',
  no_match: '暂无匹配资料',
  insufficient: '条件在资料中未标注，无法确认',
  ambiguous: '存在多种可能，需进一步确认',
  conflict: '来源之间相互冲突',
  unavailable: '相关来源当前不可用',
  invalid: '查询条件不合法'
}

function matchStateLabel(state) {
  return MATCH_STATE_LABELS[state] || '状态未知'
}

// 替身边界说明：共享源码未联网时，本页数据来自仓库内资料契约（非在线权威查询）。
function modeNote() {
  return '当前为本地资料读数：数据取自项目内已核对资料契约，未联网调取在线权威接口。'
}

function catalogVersionText() {
  return '作物目录 ' + crops.catalog_version + ' · 杂草目录 ' + species.catalog_version + ' · 地区目录 ' + REGION_CATALOG_VERSION
}

// ---------------------------------------------------------------------------
// GY-I07 指挥侧结构化种子资料（整理稿）· 小程序侧装载。
//
// 合规口径（强制，与 db/seeds/gy-i07/INDEX.json usage_policy 一致）：
//   data_origin=seed_unverified、authority=none、label=「待核实·非权威」；
//   **不得显示真实用量**（本适配层刻意不投影任何剂量/浓度字段）；
//   **不授专家认证标签**；**不声称可追溯权威来源**；**缺项不空白/不补写**。
// ---------------------------------------------------------------------------

const SEED_REQUIRED_LABEL = '待核实·非权威'
const SEED_NOT_COLLECTED = '未采集（种子整理稿无此栏）'

const seedHerbicides = require('../data/seed-herbicides.js')
const seedWeeds = require('../data/seed-weeds.js')
const seedWeedMaster = require('../data/seed-weed-master.js')
const seedProvinceIndex = require('../data/seed-province-index.js')
const seedControlTiming = require('../data/seed-control-timing.js')

function seedNorm(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, '').toLowerCase() : ''
}

// 种子除草剂投影（**不含任何用量字段**）。
const seedHerbicideItems = (seedHerbicides.items || []).map(function (raw, index) {
  const aliases = String(raw.aliases || '').split(/[、,，]/).map(function (s) { return s.trim() }).filter(Boolean)
  return {
    seed_id: 'gy-i07-seed-hb-' + String(index + 1).padStart(3, '0'),
    name: raw.name || '',
    aliases: aliases,
    hazard_level: raw.hazard_level || '',
    hazard_detail: raw.hazard_detail || '',
    target_weeds: raw.target_weeds || '',
    regions: raw.regions || '',
    dosage_status: 'not_collected',
    dosage_note: SEED_NOT_COLLECTED,
    seed_meta: {
      data_origin: 'seed_unverified',
      authority: 'none',
      label: SEED_REQUIRED_LABEL,
      traceable_authority: false
    }
  }
})

const seedWeedItems = (seedWeeds.items || []).map(function (raw, index) {
  return {
    seed_id: 'gy-i07-seed-weed-' + String(index + 1).padStart(3, '0'),
    name: raw.name || '',
    identify_key: raw.identify_key || ''
  }
})

const seedWeedMasterItems = (seedWeedMaster.items || []).map(function (raw, index) {
  return {
    seed_id: 'gy-i07-seed-wm-' + String(index + 1).padStart(3, '0'),
    name: raw['杂草名称'] || '',
    scientific_name: raw['学名'] || SEED_NOT_COLLECTED,
    family_genus: raw['科属'] || SEED_NOT_COLLECTED,
    companion_crops: raw['伴生作物'] || SEED_NOT_COLLECTED,
    distribution_provinces: raw['分布省份（中国）'] || SEED_NOT_COLLECTED,
    growth_stages: raw['各生长时期状态描述'] || SEED_NOT_COLLECTED,
    best_control_period: raw['最佳防除时期'] || SEED_NOT_COLLECTED,
    application_window: raw['推荐施药／防除窗口'] || SEED_NOT_COLLECTED,
    identify_key: raw['识别要点'] || SEED_NOT_COLLECTED
  }
})

const seedProvinceItems = (seedProvinceIndex.items || []).map(function (raw, index) {
  return {
    seed_id: 'gy-i07-seed-prov-' + String(index + 1).padStart(3, '0'),
    province: raw['省份／省级行政区'] || '',
    region: raw['所属大区'] || '',
    weed_count: raw['该省常见农田杂草（数量）'] || '',
    weed_list: raw['常见杂草清单'] || '',
    main_crops: raw['该省主要作物与说明'] || ''
  }
})

const seedControlTimingItems = (seedControlTiming.items || []).map(function (raw, index) {
  return {
    seed_id: 'gy-i07-seed-ct-' + String(index + 1).padStart(3, '0'),
    scene: raw['作物／场景'] || '',
    control_period: raw['防除关键期'] || '',
    target_weeds: raw['主要杂草对象'] || '',
    tips: raw['要点提示'] || '',
    dosage_status: 'not_collected',
    dosage_note: SEED_NOT_COLLECTED
  }
})

const seedModule = {
  label: SEED_REQUIRED_LABEL,
  notCollected: SEED_NOT_COLLECTED,
  dataOrigin: seedHerbicides.data_origin || 'seed_unverified',
  authority: seedHerbicides.authority || 'none',
  disclaimer: seedHerbicides.disclaimer || '',
  regionConvention: seedHerbicides.region_convention || '',
  counts: {
    herbicides: seedHerbicideItems.length,
    weeds: seedWeedItems.length,
    weedMaster: seedWeedMasterItems.length,
    provinces: seedProvinceItems.length,
    controlTiming: seedControlTimingItems.length
  },
  herbicides: seedHerbicideItems,
  weeds: seedWeedItems,
  weedMaster: seedWeedMasterItems,
  provinces: seedProvinceItems,
  controlTiming: seedControlTimingItems
}

// 种子除草剂确定性检索（按名称/别名精确匹配，**不合并不同记录**）。
function seedSearch(keyword) {
  const t = seedNorm(keyword)
  if (!t) return seedHerbicideItems.slice()
  return seedHerbicideItems.filter(function (item) {
    if (seedNorm(item.name).indexOf(t) !== -1) return true
    return item.aliases.some(function (a) { return seedNorm(a).indexOf(t) !== -1 })
  })
}

// 种子除草剂详情（按 seed_id）。
function seedHerbicideDetail(seedId) {
  return seedHerbicideItems.filter(function (x) { return x.seed_id === seedId })[0] || null
}

// 种子资料统一展示标签（强制「待核实·非权威」；用量恒不展示）。
function seedLabels() {
  return {
    seed: SEED_REQUIRED_LABEL,
    evidence_kind: '经验来源',
    review_status: '未核对',
    dose: '种子整理稿未采集用量字段，不提供用量信息'
  }
}

module.exports = {
  crops: crops.crops,
  species: species.species,
  sources: sources.sources,
  regions: require('../data/regions.js').regions,
  records: normalized,
  query: query,
  detail: detail,
  resolveCropId: resolveCropId,
  resolveSpeciesId: resolveSpeciesId,
  matchStateLabel: matchStateLabel,
  modeNote: modeNote,
  catalogVersionText: catalogVersionText,
  seed: seedModule,
  seedSearch: seedSearch,
  seedHerbicideDetail: seedHerbicideDetail,
  seedLabels: seedLabels,
  catalogVersion: {
    crops: crops.catalog_version,
    species: species.catalog_version,
    regions: REGION_CATALOG_VERSION
  }
}
