// 地区转换资源装配（GY-I05 D2）：把「坐标 → 浙江行政区代码」的转换资源接进定位入口，
// 页面不再自行写死 regionConverter。
//
// 契约（与 miniprogram/utils/location-region.js 头注一致，本模块不改动它）：
//   convert(latitude, longitude) 返回 ^33[0-9]{4}$ 的浙江行政区代码；返回其他值／null 表示
//   不在首版覆盖的浙江省；抛错表示转换失败。坐标只作为入参使用一次：不写入存储、不进入任何
//   请求体、不跨次复用；本模块也不做持续跟踪（不调用 startLocationUpdate／onLocationChange）。
//
// 数据来源与 U3（如实登记，⛔ 不编造）：
//   期望的资源只读副本为 miniprogram/data/region-centroids.js（模块 id '../data/region-centroids.js'），
//   应由生成脚本从**注明来源与许可**的几何数据产出，且文档本身要带 crs／source／license／retrieved_at
//   ／catalog_version／max_distance_km 才能通过下方校验。截至 2026-10-17，仓库与本机均**未取得**可追溯
//   来源（含许可）的浙江县区质心／边界几何数据，该文件**不存在**，因此本模块如实走 fail-closed 分支：
//   build() 返回 null ⇒ location-region.locate 在定位成功后回落 { status: 'unavailable' }
//   （文案「地区转换资源尚未接入，请手选浙江市县。」），页面保留手选。
//   ⛔ 本模块不内置任何坐标，⛔ 不编造质心／边界，⛔ 不假装转换成功。
//   资源就位后无需改动本模块或页面：文件存在且校验通过即自动接线；校验不通过则照旧 fail-closed。
//
// 校验口径（任一不通过即不接线，宁可回退手选也不使用可疑数据）：
//   schema 相符 · state === 'available' · **crs === 'WGS84'** · source／license／retrieved_at 非空 ·
//   retrieved_at 是 YYYY-MM-DD 形态的真实日期 · max_distance_km 为 (0, 500] 的有限数 ·
//   points 非空 · 每个点 code 匹配 ^33[0-9]{4}$ 且**存在于 miniprogram/data/regions.js 的目录**里 ·
//   code 不重复 · 经纬度为有限值且在合法区间 · catalog_version 是非空字符串且与当前目录一致。
//   转换用最近质心（球面距离）并受 max_distance_km 约束：超出即返回 null（不在覆盖范围），
//   由 locate 如实报 out_of_coverage。
//
// 2026-10-28 加严（Refs #5，本片只加严、不放宽；此前这些缺口都表现为「静默」而不是「报错」）：
//   ① 新增必填 crs 并恒等 'WGS84'——坐标系是数据口径的一部分。此前 schema 里根本没有坐标系字段，
//      掺进 GCJ-02 数据（偏移数百米）也能过校验；而字段缺失又与「资源不存在」同形，看不出区别。
//      现在缺 crs ⇒ reason 'crs'，填了别的基准 ⇒ reason 'crs:<值>'，两者都是**明确的不合规**。
//   ② retrieved_at 必须是 YYYY-MM-DD 的真实日期（拒绝 'todo'／'2026-13-01'／'待补' 这类占位），
//      否则 reason 'retrieved_at-format'。此前只要是任意非空字符串就能过。
//   ③ catalog_version 先单独要求非空字符串（reason 'catalog_version'）再与目录比对；此前非字符串
//      只能靠等值比较间接拒绝，理由含混成 'catalog-version'。
//   ④ max_distance_km 加上限 500 km（reason 'max_distance_km-range'）。本表只服务浙江，
//      阈值超过省域尺度就等于省内外不分：省外坐标会被最近质心判成省内。
//   以上四条都只影响「资源在仓内时」的判定；今天资源不存在，生产行为不变（仍 resource-missing）。

const RESOURCE_MODULE = '../data/region-centroids.js'
const RESOURCE_FILE = 'miniprogram/data/region-centroids.js'
const CATALOG_MODULE = '../data/regions.js'
const SCHEMA = 'gengyun.knowledge.region-centroids.v1'
// 唯一的合法坐标系：定位入参用 wx.getLocation({ type: 'wgs84' })，资源必须同口径。
const CRS = 'WGS84'
// 检索半径上限（km）：本表只服务浙江省域（南北约 450 km），再大的阈值等于省内外不分。
const MAX_DISTANCE_KM = 500
const RETRIEVED_AT = /^\d{4}-\d{2}-\d{2}$/
const CODE = /^33[0-9]{4}$/
const EARTH_RADIUS_KM = 6371.0088

// 资源文件按设计可以缺席（U3 未取得）：require 失败必须被当作「资源不可用」，而不是崩溃或假装成功。
function loadModule(id) {
  try { return require(id) } catch (error) { return null }
}
function nonEmpty(value) { return typeof value === 'string' && value.trim() !== '' }
function finite(value) { return typeof value === 'number' && isFinite(value) }

// 抓取日期必须是**真实**日历日：'2026-13-01'、'2026-02-30'、'todo' 一律不算来源可追溯。
function realDate(text) {
  if (typeof text !== 'string' || !RETRIEVED_AT.test(text)) return false
  const parts = text.split('-')
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])
  const stamp = new Date(Date.UTC(year, month - 1, day))
  return stamp.getUTCFullYear() === year && stamp.getUTCMonth() === month - 1 && stamp.getUTCDate() === day
}

// 目录是转换结果的**唯一**合法性依据：不在目录里的代码一律不予接线。
function catalog() {
  const module = loadModule(CATALOG_MODULE)
  const regions = module && module.regions
  if (!Array.isArray(regions) || regions.length === 0) return null
  const codes = {}
  for (let i = 0; i < regions.length; i += 1) {
    const code = regions[i] && regions[i].code
    if (typeof code === 'string' && code !== '') codes[code] = true
  }
  return Object.keys(codes).length === 0 ? null : { codes: codes, catalog_version: typeof module.catalog_version === 'string' ? module.catalog_version : null }
}

function inspect(document) {
  if (document === null || document === undefined) return { ok: false, reason: 'resource-missing' }
  if (typeof document !== 'object' || Array.isArray(document)) return { ok: false, reason: 'resource-invalid' }
  if (document.schema !== SCHEMA) return { ok: false, reason: 'schema' }
  if (document.state !== 'available') return { ok: false, reason: 'state:' + String(document.state) }
  // 坐标系不合规一律不接线：缺字段与填别的基准都必须说清楚，不能退回「当资源不存在」的静默分支。
  if (!nonEmpty(document.crs)) return { ok: false, reason: 'crs' }
  if (document.crs !== CRS) return { ok: false, reason: 'crs:' + String(document.crs) }
  if (!nonEmpty(document.source)) return { ok: false, reason: 'source' }
  if (!nonEmpty(document.license)) return { ok: false, reason: 'license' }
  if (!nonEmpty(document.retrieved_at)) return { ok: false, reason: 'retrieved_at' }
  if (!realDate(document.retrieved_at)) return { ok: false, reason: 'retrieved_at-format' }
  if (!finite(document.max_distance_km) || document.max_distance_km <= 0) return { ok: false, reason: 'max_distance_km' }
  if (document.max_distance_km > MAX_DISTANCE_KM) return { ok: false, reason: 'max_distance_km-range' }
  if (!Array.isArray(document.points) || document.points.length === 0) return { ok: false, reason: 'points' }
  if (!nonEmpty(document.catalog_version)) return { ok: false, reason: 'catalog_version' }
  const known = catalog()
  if (!known) return { ok: false, reason: 'catalog-unavailable' }
  if (document.catalog_version !== known.catalog_version) return { ok: false, reason: 'catalog-version' }
  const seen = {}
  const points = []
  for (let i = 0; i < document.points.length; i += 1) {
    const point = document.points[i]
    if (!point || typeof point !== 'object') return { ok: false, reason: 'point-invalid:' + i }
    if (typeof point.code !== 'string' || !CODE.test(point.code)) return { ok: false, reason: 'point-code:' + i }
    if (!known.codes[point.code]) return { ok: false, reason: 'code-not-in-catalog:' + point.code }
    if (seen[point.code]) return { ok: false, reason: 'duplicate-code:' + point.code }
    if (!finite(point.latitude) || point.latitude < -90 || point.latitude > 90) return { ok: false, reason: 'point-latitude:' + i }
    if (!finite(point.longitude) || point.longitude < -180 || point.longitude > 180) return { ok: false, reason: 'point-longitude:' + i }
    seen[point.code] = true
    points.push({ code: point.code, latitude: point.latitude, longitude: point.longitude })
  }
  return {
    ok: true, reason: 'available', points: points, max_distance_km: document.max_distance_km,
    source: document.source, license: document.license, retrieved_at: document.retrieved_at,
    catalog_version: document.catalog_version, crs: CRS,
  }
}

function distanceKm(latitude, longitude, point) {
  const toRad = Math.PI / 180
  const dLat = (point.latitude - latitude) * toRad
  const dLng = (point.longitude - longitude) * toRad
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(latitude * toRad) * Math.cos(point.latitude * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

function toConverter(checked) {
  const points = checked.points
  const limit = checked.max_distance_km
  function convert(latitude, longitude) {
    if (!finite(latitude) || !finite(longitude)) return null
    let best = null
    let bestKm = Infinity
    for (let i = 0; i < points.length; i += 1) {
      const km = distanceKm(latitude, longitude, points[i])
      if (km < bestKm) { bestKm = km; best = points[i] }
    }
    if (!best || bestKm > limit) return null
    return best.code
  }
  convert.provenance = {
    schema: SCHEMA, crs: CRS, source: checked.source, license: checked.license, retrieved_at: checked.retrieved_at,
    catalog_version: checked.catalog_version, point_count: points.length, max_distance_km: limit, method: 'nearest-centroid',
  }
  return convert
}

// options.resource 只给测试与显式装配用（传 null／undefined 表示「当作资源缺席」）；
// 生产调用 build() 时资源来自 RESOURCE_MODULE，缺席即返回 null（fail-closed）。
function readDocument(options) {
  const settings = options || {}
  if (Object.prototype.hasOwnProperty.call(settings, 'resource')) return settings.resource
  return loadModule(RESOURCE_MODULE)
}

function build(options) {
  const checked = inspect(readDocument(options))
  return checked.ok ? toConverter(checked) : null
}

// 供交接与排障使用：如实说明「是否接线、为什么没接线、期望的资源在哪里」。
function describe(options) {
  const document = readDocument(options)
  const checked = inspect(document)
  return {
    wired: checked.ok, reason: checked.reason, resource_module: RESOURCE_MODULE, resource_file: RESOURCE_FILE,
    schema: SCHEMA, expected_crs: CRS,
    declared_state: document && typeof document === 'object' && !Array.isArray(document) && typeof document.state === 'string' ? document.state : null,
    // 坐标系是排障的第一问：资源声明了什么、期望是什么，两者分列，不合规时才看得见差在哪。
    declared_crs: document && typeof document === 'object' && !Array.isArray(document) && typeof document.crs === 'string' ? document.crs : null,
    source: checked.ok ? checked.source : null, license: checked.ok ? checked.license : null,
    retrieved_at: checked.ok ? checked.retrieved_at : null, point_count: checked.ok ? checked.points.length : 0,
    max_distance_km: checked.ok ? checked.max_distance_km : null,
  }
}

module.exports = { SCHEMA, CRS, MAX_DISTANCE_KM, RESOURCE_MODULE, RESOURCE_FILE, build, describe, inspect }
