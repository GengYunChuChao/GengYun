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

// H2 契约前提（与域库同口径）：`SourceRef.source_kind`/`evidence_kind` 为**冻结枚举**，
// `Formulation.registration_number` 为必填 —— 任一缺失即无法产出合法契约对象。
// 这类记录**在投影/查询前 fail-closed**：既不进入可查询集合，也不被投影为契约形状，
// 缺项说明落在 labels/查询原因（可表达缺项的位置），**绝不**用「未采集」填强枚举字段。
const SOURCE_KINDS = ['database', 'verified_seed', 'simulation']
const EVIDENCE_KINDS = ['research', 'experience', 'mixed']

function contractReadiness(r) {
  const s = r.source || {}
  const missing = []
  if (SOURCE_KINDS.indexOf(s.source_kind) === -1) missing.push('来源类型（source_kind）')
  if (EVIDENCE_KINDS.indexOf(s.evidence_kind) === -1) missing.push('证据类型（evidence_kind）')
  if (typeof r.registration_number !== 'string' || r.registration_number === '') missing.push('登记证号（registration_number）')
  return { ok: missing.length === 0, missing: missing }
}

const normalized = []
const skippedRecords = []
records.records.forEach(function (r, index) {
  const readiness = contractReadiness(r)
  if (!readiness.ok) {
    // fail-closed：不满足契约前提 → 退出投影（缺项说明如实保留，不编造枚举值）。
    skippedRecords.push({
      index: index,
      record_id: r.record_id || null,
      registration_number: r.registration_number || null,
      missing: readiness.missing.slice(),
      reason: '来源元数据缺项，无法满足契约必填：' + readiness.missing.join('、') + '（不编造枚举值，已退出投影）'
    })
    return
  }
  const simulated = String(r.registration_number || '').indexOf('SIM-') === 0 || (r.source && r.source.source_kind === 'simulation')
  const validity = (r.source && (r.source.source_validity || r.source.validity)) || 'unknown'
  const sourceVersion = deriveSourceVersion(r.source)
  normalized.push({
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
  })
})

// 有效判定（列表与详情同源同判）：仅 validity=valid 且 visibility=published 且非模拟。
// H2：**先判契约前提**（来源枚举字段必须命中冻结枚举、登记证号必须存在），
// 否则会出现「产物非法但可查询」的自相矛盾（域库 evaluateEligibility 同口径）。
function isEligible(item) {
  const missing = []
  if (SOURCE_KINDS.indexOf(item.source && item.source.source_kind) === -1) missing.push('来源类型（source_kind）')
  if (EVIDENCE_KINDS.indexOf(item.source && item.source.evidence_kind) === -1) missing.push('证据类型（evidence_kind）')
  if (typeof item.registration_number !== 'string' || item.registration_number === '') missing.push('登记证号（registration_number）')
  if (missing.length > 0) return { ok: false, reason: '来源元数据缺项，无法满足契约必填：' + missing.join('、') }
  if (item.visibility !== 'published') return { ok: false, reason: item.visibility === 'hidden' ? '该记录已下架' : '该记录当前不可见' }
  // PR #82 复核：来源有效期读取与域库 evaluateEligibility **逐字同口径**：
  // `source.source_validity` → `source.validity` → 都没有则 `unknown`（拒绝）。
  // - 字段存在但为**显式空串**：同样视为未知并拒绝（域库 `??` 保留空串即此语义），
  //   不得用真假值默认把空串覆盖成别名字段 —— 显式空串是「未知」状态。
  // - **不回退顶层 `item.validity`**：那是装载期缓存，删除/矛盾时不得掩盖来源真实状态。
  const src = item.source || {}
  const validity = (src.source_validity !== undefined && src.source_validity !== null) ? src.source_validity
    : ((src.validity !== undefined && src.validity !== null) ? src.validity : 'unknown')
  if (validity !== 'valid') {
    const map = { expired: '来源已过期', withdrawn: '来源已撤回', conflicting: '来源相互冲突', unknown: '来源有效期未知', '': '来源有效期未知' }
    return { ok: false, reason: map[validity] || '来源有效期不可用' }
  }
  // PR #82 复核：模拟来源**实名判定**（标志位/来源类型/SIM- 前缀任一成立即排除）。
  if (isSimulatedSource(item)) return { ok: false, reason: '模拟演示记录（非真实资料）' }
  return { ok: true, reason: null }
}

// 模拟来源实名判定（与域库 packages/reference/query.mjs isSimulatedSource 同口径）。
function isSimulatedSource(item) {
  if (item && item.simulated === true) return true;
  if (item && item.source && item.source.source_kind === 'simulation') return true;
  return String((item && item.registration_number) || '').indexOf('SIM-') === 0;
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

// ---------------------------------------------------------------------------
// GY-I08 镜像：药剂适用过滤 + 标签原文用量卡片（DoseCard）。
// 与 packages/reference 同 RULE_VERSION、同口径（所有消费端同一规则版本）。
//
// PR #82 修订（gy-i08/1.2.0，与域库 packages/reference 同步 bump）：
//   A) 成分/含量名称分支改为**精确相等**（此前 includes 子串会把「磺草酮」命中
//      「硝磺草酮」，混同不同成分）。
//   B) DoseCard 追加绑定：已核对审核状态、用量版本绑定当前来源版本、登记制剂身份完整、
//      模拟来源实名判定（source_kind=simulation 或 SIM- 登记号）。
//   C) 详情页适用上下文改为**已确认档案**（/me/profile）：未确认/读取失败/身份变化
//      不得默认为空上下文放行具体用量。
// ---------------------------------------------------------------------------
const APPLICABILITY_RULE_VERSION = 'gy-i08/1.2.0';
const RESTRICTION_STATUSES = ['banned', 'restricted', 'unrestricted', 'unknown'];
const REVIEW_STATUSES = ['unverified', 'verified', 'rejected'];
const APPLICABILITY_DIMENSIONS = ['valid_source', 'banned_restricted', 'crop', 'growth_stage', 'region', 'dosage_form', 'ingredient_content', 'use_scene'];

// PR #82：DoseCard 拒绝原因标签（与域库 DISPLAY_LABELS.dose_reject_reason 同文案）。
const DOSE_REJECT_REASON = {
  not_usable: '本记录未采集可用作依据的用量字段，不提供用量信息',
  missing_condition: '来源未提供可绑定的原文条件，不展示用量',
  not_applicable: '当前条件不适用（或必要条件未采集），不展示用量',
  banned: '该药剂为禁用状态，不展示用量',
  restricted: '该药剂为限用状态，需额外确认后方可展示用量',
  restriction_unknown: '未采集禁限用状态，无法确认非禁用，不展示用量',
  invalid_source: '来源当前不可用（失效/撤回/冲突/有效期未知/下架/模拟），不展示用量',
  closed: '用量卡片已关闭（功能开关）',
  // —— gy-i08/1.2.0（阻塞 B）——
  not_reviewed: '该用量未绑定已核对的审核状态，不展示用量',
  stale_dose: '该用量未绑定当前来源版本（可能为陈旧数据），不展示用量',
  incomplete_formulation: '登记制剂信息不完整（名称/剂型/有效成分含量缺失），不展示用量',
  simulated_source: '该来源为模拟演示数据，不作为真实用量依据',
  // —— follow-up 复核补强 ——
  dose_record_mismatch: '该用量未绑定当前登记记录，不展示用量',
  dose_formulation_mismatch: '该用量未绑定当前登记制剂（名称/剂型/成分含量不一致），不展示用量',
  dose_reference_missing: '该用量缺少原文引用/定位依据，不展示用量'
};

// 制剂绑定校验结果 → 拒绝原因（与域库 doseCardDescriptor 内映射同文案）。
const FORMULATION_REJECT_REASON = {
  incomplete: DOSE_REJECT_REASON.incomplete_formulation,
  record_mismatch: DOSE_REJECT_REASON.dose_record_mismatch,
  formulation_mismatch: DOSE_REJECT_REASON.dose_formulation_mismatch,
  reference_missing: DOSE_REJECT_REASON.dose_reference_missing
};

// 显式读取禁限用状态：只有**非空字符串**才采用；空串/缺失一律回退 unknown（fail-closed）。
// 与域库 readRestrictionStatus 同口径（不用 ?? 也不用 ||，避免空串取值差异）。
function readRestrictionStatus(item) {
  const raw = firstNonEmptyString(
    item && item.verification && item.verification.restriction_status,
    item && item.source && item.source.restriction_status,
    item && item.restriction_status
  );
  if (raw !== null && RESTRICTION_STATUSES.indexOf(raw) !== -1) return raw;
  return 'unknown';
}

function firstNonEmptyString() {
  for (let i = 0; i < arguments.length; i += 1) {
    const v = arguments[i];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

// PR #82：有效成分 + 含量的精确匹配语义（与域库 packages/reference/query.mjs
// `ingredientContentMatch` 逐字同语义）。等分切分 + 每等分按名称/含量**精确相等**比对，
// 全部等分命中才算相符；不用整串 includes（跨端不同判缺陷），也不用名称子串匹配
// （阻塞 A：否则「磺草酮」会命中「硝磺草酮」，把不同成分当同一制剂放行）。
function ingredientContentMatch(ingredients, contextValue) {
  const want = norm(contextValue);
  if (!want) return false;
  const list = (ingredients || []).map(function (ing) {
    return { name: norm(ing && ing.name), content: norm(ing && ing.content_text) };
  });
  const segments = String(contextValue)
    .split(/、|,(?![0-9])/)
    .map(function (s) { return norm(s) })
    .filter(function (s) { return s !== '' });
  if (segments.length === 0) return false;
  return segments.every(function (seg) {
    if (/^[\d.]+\s*(%|g\/l|g\/kg|mg\/kg|g|ml\/l|ml|mg|kg|l|克\/升|克\/公斤|毫升\/升|克|毫克|毫升|升|公斤)?$/.test(seg) && /[\d.]/.test(seg)) {
      // 含量必须**精确相等**：`22%`.includes('2%') 会把「二甲戊灵 2%」错配到
      // 「二甲戊灵 22%」（子串混同），故不用 includes。
      return list.some(function (ing) { return ing.content === seg });
    }
    const m = seg.match(/^(.+?)\s*([\d.]+\s*(?:%|g\/l|g\/kg|mg\/kg|g|ml\/l|ml|mg|kg|l|克\/升|克\/公斤|毫升\/升|克|毫克|毫升|升|公斤))?$/);
    const name = m ? norm(m[1]) : seg;
    const content = m && m[2] ? norm(m[2]) : null;
    if (content !== null) {
      // 完整组合：名称与含量必须命中**同一成分**且**含量精确相等**。
      return list.some(function (ing) { return ing.name === name && ing.content === content });
    }
    // 名称单项：**精确相等**（阻塞 A：不用 includes 子串匹配）。
    return list.some(function (ing) { return ing.name === name });
  });
}

// 从 ingredients_text 解析有效成分（与域库 parseIngredients 同口径：名值对拆分）。
function parseIngredientsLocal(text) {
  if (typeof text !== 'string' || text.trim() === '') return [{ name: '未采集', content_text: '未采集', unit_text: '未采集' }];
  return text
    .split(/、|,(?![0-9])/)
    .map(function (seg) { return seg.trim() })
    .filter(function (seg) { return seg !== '' })
    .map(function (seg) {
      const m = seg.match(/^(.+?)\s*([\d.]+)\s*(%|g\/L|g\/kg|mg\/kg|g|ml\/L|ml|mg|kg|L|克\/升|克\/公斤|毫升\/升|克|毫克|毫升|升|公斤)?\s*$/);
      if (m) {
        const explicitUnit = (m[3] || '').trim();
        if (explicitUnit === '') return { name: m[1].trim(), content_text: m[2].trim(), unit_text: '未采集' };
        return { name: m[1].trim(), content_text: m[2].trim() + explicitUnit, unit_text: explicitUnit };
      }
      return { name: seg, content_text: '未采集', unit_text: '未采集' };
    });
}

// 确定性、fail-closed 的适用过滤（详见 packages/reference/query.mjs 同函数）。
function evaluateApplicability(item, context) {
  context = context || {};
  const reasons = [];
  const blocked = [];
  const elig = isEligible(item);
  if (!elig.ok) {
    blocked.push('valid_source');
    reasons.push('来源不可用：' + (elig.reason || '不满足契约必填或可查询条件'));
  }
  const restriction = readRestrictionStatus(item);
  if (restriction === 'banned') {
    blocked.push('banned_restricted');
    reasons.push('该药剂为禁用状态，不得进入用量建议');
  } else if (restriction === 'restricted') {
    if (context.allow_restricted === true) reasons.push('该药剂为限用状态，已按上下文显式确认');
    else { blocked.push('banned_restricted'); reasons.push('该药剂为限用状态，需额外确认后方可进入用量建议'); }
  } else if (restriction === 'unknown') {
    blocked.push('banned_restricted');
    reasons.push('未采集禁限用状态，无法确认非禁用，不得进入用量建议');
  }
  if (context.crop_id) {
    if ((item.crop_ids || []).indexOf(context.crop_id) === -1) {
      blocked.push('crop');
      reasons.push('作物不符（记录未覆盖该作物）');
    }
  }
  // PR #82：生育期为必要条件——不符或未采集一律阻断（此前仅记原因）。
  // 显式读取：只有非空字符串才算已采集（与域库同口径，避免 ?? / || 差异）。
  if (context.growth_stage) {
    const gs = firstNonEmptyString(item.growth_stage, item.verification && item.verification.growth_stage);
    if (gs !== null) {
      if (norm(gs).indexOf(norm(context.growth_stage)) === -1) { blocked.push('growth_stage'); reasons.push('生育期不符'); }
    } else {
      blocked.push('growth_stage');
      reasons.push('记录未采集生育期条件，无法确认是否适用该生育期');
    }
  }
  // PR #82：地区为必要条件——未标注或不相符一律阻断。
  if (context.region_code) {
    const rc = Array.isArray(item.region_codes) ? item.region_codes : (typeof item.region_code === 'string' ? [item.region_code] : []);
    if (rc.length > 0) {
      if (rc.indexOf(context.region_code) === -1) { blocked.push('region'); reasons.push('适用地区不符'); }
    } else {
      blocked.push('region');
      reasons.push('记录未标注适用地区，无法确认是否适用该地区');
    }
  }
  if (context.dosage_form) {
    if (norm(item.dosage_form || '') !== norm(context.dosage_form)) { blocked.push('dosage_form'); reasons.push('制剂（剂型）不符'); }
  }
  // PR #82：成分/含量改用跨端一致的精确语义。
  if (context.ingredient_content) {
    const parsed = (item.verification && item.verification.parsed_ingredients) || parseIngredientsLocal(item.ingredients_text || (item.norm && item.norm.ingredients) || '');
    if (!ingredientContentMatch(parsed, context.ingredient_content)) {
      blocked.push('ingredient_content');
      reasons.push('有效成分/含量与所选不符');
    }
  }
  if (context.use_scene) {
    if (norm(item.use_scene || '').indexOf(norm(context.use_scene)) === -1) { blocked.push('use_scene'); reasons.push('使用场景不符'); }
  }
  return { applicable: blocked.length === 0, blocked: blocked, reasons: reasons, rule_version: APPLICABILITY_RULE_VERSION };
}

// PR #82：标签原文用量卡片描述符（F14）。
// 用量展示资格**绑定当前有效来源/审核、登记制剂、原文条件/版本和适用判定**：
// 未采集用量字段、缺原文条件、缺数字/单位、审核未核对/已驳回/**来源侧缺失**、
// 用量未绑定当前来源版本、制剂身份不完整或与用量绑定不一致（record_id/formulation_key/reference）、
// 模拟来源（source_kind=simulation 或 SIM- 登记号）、禁用/限用/禁限用未知、
// 来源失效/撤回/冲突/未知有效期、下架、任一适用维度不符或未采集 → 一律不渲染。
// 功能开关关闭只是附加条件，**不能代替资格验证**。
function doseCardDescriptor(item, opts) {
  opts = opts || {};
  const enabled = opts.doseCardEnabled !== false;
  const base = { rule_version: APPLICABILITY_RULE_VERSION, off_switch_supported: true };
  if (!enabled) return { ...base, renderable: false, reason: DOSE_REJECT_REASON.closed, closed: true };
  const ver = item && item.verification;
  if (!ver || ver.usable_as_dose !== true) return { ...base, renderable: false, reason: DOSE_REJECT_REASON.not_usable, closed: false };
  // 阻塞 B-4：模拟来源实名判定（标志位/来源类型/登记号前缀任一成立即拒绝）。
  if (isSimulatedSource(item)) return { ...base, renderable: false, reason: DOSE_REJECT_REASON.simulated_source, closed: false };
  // 阻塞 B-1：记录级与来源级审核状态都必须**显式为** verified；任一侧缺失即拒绝（不取较宽松状态）。
  if (!isDoseReviewed(item)) return { ...base, renderable: false, reason: DOSE_REJECT_REASON.not_reviewed, closed: false };
  // 阻塞 B-3：制剂身份完整且与用量绑定一致（record_id/formulation_key/reference）。
  const bound = hasBoundFormulation(item, ver.dose);
  if (bound !== 'ok') return { ...base, renderable: false, reason: FORMULATION_REJECT_REASON[bound], closed: false };
  const dose = ver.dose;
  const hasNumber = dose && typeof dose.number === 'string' && dose.number.trim() !== '';
  const hasUnit = dose && typeof dose.unit === 'string' && dose.unit.trim() !== '';
  const hasCondition = dose && typeof dose.condition === 'string' && dose.condition.trim() !== '';
  if (!(hasNumber && hasUnit)) return { ...base, renderable: false, reason: DOSE_REJECT_REASON.not_usable, closed: false };
  // 缺原文条件即拒绝（此前 condition=null 仍可渲染）。
  if (!hasCondition) return { ...base, renderable: false, reason: DOSE_REJECT_REASON.missing_condition, closed: false };
  // 阻塞 B-2：用量必须绑定当前来源版本（陈旧用量数据不放行）。
  if (!isDoseBoundToCurrentSource(item, dose)) return { ...base, renderable: false, reason: DOSE_REJECT_REASON.stale_dose, closed: false };
  // 必须通过当前适用判定（fail-closed）。
  const applicability = evaluateApplicability(item, opts.context || {});
  if (!applicability.applicable) {
    return { ...base, renderable: false, reason: doseRejectReasonFrom(applicability), closed: false, applicable: false, blocked: applicability.blocked.slice() };
  }
  return { ...base, renderable: true, reason: null, closed: false, applicable: true, blocked: [], dose: { number: dose.number, unit: dose.unit, condition: dose.condition } };
}

// 阻塞 B-4：模拟来源实名判定（不看 include_simulated——它只放开查阅，不放开真实用量卡片）。
function isSimulatedSource(item) {
  if (item && item.simulated === true) return true;
  if (item && item.source && item.source.source_kind === 'simulation') return true;
  return String((item && item.registration_number) || '').indexOf('SIM-') === 0;
}

// 阻塞 B-1：记录级与来源级审核状态都必须**显式为** verified；任一侧 unverified/rejected/缺失即拒绝。
function isDoseReviewed(item) {
  const recordStatus = item && item.verification && item.verification.review_status;
  const sourceStatus = item && item.source && item.source.review_status;
  if (REVIEW_STATUSES.indexOf(recordStatus) === -1 || recordStatus !== 'verified') return false;
  if (REVIEW_STATUSES.indexOf(sourceStatus) === -1 || sourceStatus !== 'verified') return false;
  return true;
}

// 阻塞 B-3（follow-up 复核）：制剂身份完整**且与用量绑定一致**。
// 仅三个字符串非空不够：dose 还须绑定当前 record_id、完整制剂字段与原文引用/定位依据，
// 防止同一 source_version（如同一公告共享版本）下的其他制剂挪用同一张用量卡。
//
// 与域库 packages/reference/labels.mjs `hasBoundFormulation` **同一套显式字段比对规则**
// （不用任何一端的哈希派生），因此后端同一份已核对的记录及用量 JSON 在两端判定一致。
function hasBoundFormulation(item, dose) {
  const name = nonEmptyText(item && item.registered_name);
  const form = nonEmptyText(item && item.dosage_form);
  const ingredients = nonEmptyText(item && item.ingredients_text);
  if (name === '' || form === '' || ingredients === '') return 'incomplete';
  // 绑定到具体登记记录：两侧都必须存在且相等（不得因双缺 '' === '' 放行）。
  const boundRecord = nonEmptyText(dose && dose.record_id);
  const currentRecord = nonEmptyText(item && item.record_id);
  if (boundRecord === '' || currentRecord === '' || boundRecord !== currentRecord) return 'record_mismatch';
  // 绑定到具体制剂身份：登记号 + 名称 + 剂型 + 成分含量逐项相等。
  const bound = dose && dose.formulation;
  if (!bound || typeof bound !== 'object') return 'formulation_mismatch';
  const sameRegistration = nonEmptyText(bound.registration_number) !== '' && nonEmptyText(bound.registration_number) === nonEmptyText(item && item.registration_number);
  const sameName = nonEmptyText(bound.registered_name) === name;
  const sameForm = nonEmptyText(bound.dosage_form) === form;
  const sameIngredients = nonEmptyText(bound.ingredients_text) === ingredients;
  if (!(sameRegistration && sameName && sameForm && sameIngredients)) return 'formulation_mismatch';
  if (nonEmptyText(dose && dose.reference) === '') return 'reference_missing';
  return 'ok';
}

function nonEmptyText(value) { return typeof value === 'string' ? value.trim() : '' }

// 阻塞 B-2：用量必须绑定当前来源版本；dose.source_version 缺失或不等于记录 source_version 即拒绝。
function isDoseBoundToCurrentSource(item, dose) {
  const bound = dose && typeof dose.source_version === 'string' ? dose.source_version.trim() : '';
  if (bound === '') return false;
  return bound === nonEmptyText(item && item.source_version);
}

function doseRejectReasonFrom(applicability) {
  const b = applicability.blocked || [];
  if (b.indexOf('banned_restricted') !== -1) {
    // 先判「未采集」：该文案本身含「禁用」二字，不能先用禁用判别（会把未知误判为禁用）。
    if ((applicability.reasons || []).some(function (r) { return r.indexOf('未采集禁限用') !== -1 })) return DOSE_REJECT_REASON.restriction_unknown;
    if ((applicability.reasons || []).some(function (r) { return r.indexOf('限用') !== -1 })) return DOSE_REJECT_REASON.restricted;
    return DOSE_REJECT_REASON.banned;
  }
  if (b.indexOf('valid_source') !== -1) return DOSE_REJECT_REASON.invalid_source;
  return DOSE_REJECT_REASON.not_applicable;
}

module.exports = {
  crops: crops.crops,
  APPLICABILITY_RULE_VERSION: APPLICABILITY_RULE_VERSION,
  RESTRICTION_STATUSES: RESTRICTION_STATUSES,
  APPLICABILITY_DIMENSIONS: APPLICABILITY_DIMENSIONS,
  evaluateApplicability: evaluateApplicability,
  doseCardDescriptor: doseCardDescriptor,
  ingredientContentMatch: ingredientContentMatch,
  parseIngredients: parseIngredientsLocal,
  species: species.species,
  sources: sources.sources,
  regions: require('../data/regions.js').regions,
  records: normalized,
  // H2：不满足契约前提（缺源类型/证据类型/登记证号）而被 fail-closed 排除的记录。
  skippedRecords: skippedRecords,
  contractReadiness: contractReadiness,
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
