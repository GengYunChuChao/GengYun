// Frozen HTTP consumer for the two read-only science faces:
//   `/knowledge`, `/knowledge/{id}`（Knowledge 实体）与
//   `/herbicides`、`/herbicides/{id}`（Herbicide 实体，GY-I07 D1）。
// No record cache and no offline success fallback: 失败一律按错误码拒绝，
// 绝不把随包离线副本冒充成服务端读数（来源标记见 `HERBICIDE_SOURCES`）。
const auth = require('./auth')
const runtime = require('../config/runtime')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FILTERS = ['crop_id', 'region_code', 'species_id', 'growth_stage', 'planting_method', 'use_scene']
let selection = null
function failure(code) { const e = new Error(code); e.code = code; return e }
function object(x) { return !!x && typeof x === 'object' && !Array.isArray(x) }
function keys(x, required, optional) {
  if (!object(x) || required.some(k => !Object.prototype.hasOwnProperty.call(x, k)) ||
      Object.keys(x).some(k => required.concat(optional || []).indexOf(k) === -1)) throw failure('INVALID_RESPONSE')
}
function text(x, max) { return typeof x === 'string' && x.length > 0 && x.length <= max }
function timestamp(value) {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 &&
    Number(m[3]) <= new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate() && Number.isFinite(Date.parse(value))
}
function one(x, values) { return values.indexOf(x) !== -1 }
function responseMeta(m) {
  keys(m, ['request_id', 'contract_version', 'execution_mode'])
  if (typeof m.request_id !== 'string' || !UUID.test(m.request_id) || m.contract_version !== '1.0.0' || !one(m.execution_mode, ['real', 'stub', 'preset_demo'])) throw failure('INVALID_RESPONSE')
  return m
}
function binding() { const s = auth.getSession(); return s && auth.isLoggedIn() ? { token: s.accessToken, epoch: auth.sessionEpoch() } : null }
function current(b) { const now = binding(); return !!b && !!now && b.token === now.token && b.epoch === now.epoch }
function filters(input, list) {
  const allowed = FILTERS.concat(list ? ['q', 'cursor', 'limit'] : [])
  if (!object(input) || Object.keys(input).some(k => allowed.indexOf(k) === -1)) throw failure('INVALID_INPUT')
  const out = {}
  Object.keys(input).forEach(function (k) {
    const v = input[k]
    if (k === 'limit') { if (!Number.isInteger(v) || v < 1 || v > 50) throw failure('INVALID_INPUT'); out[k] = v; return }
    if (!text(v, k === 'cursor' ? 2048 : 80) || (k === 'region_code' && !/^33[0-9]{4}$/.test(v))) throw failure('INVALID_INPUT')
    out[k] = v
  })
  return out
}
function query(input) { return Object.keys(input).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(input[k])).join('&') }
function validItem(x) {
  keys(x, ['id', 'revision', 'type', 'title', 'body', 'source', 'conditions', 'reference_state', 'dose_cards'])
  const s = x.source
  keys(s, ['id', 'version', 'title', 'url', 'publisher', 'source_kind', 'evidence_kind', 'validity', 'review_status', 'updated_at'])
  if (typeof x.id !== 'string' || !UUID.test(x.id) || !Number.isSafeInteger(x.revision) || x.revision < 1 || !one(x.type, ['species', 'herbicide', 'scheme', 'static_region']) ||
      !text(x.title, 200) || !text(x.body, 20000) || typeof s.id !== 'string' || !UUID.test(s.id) || !text(s.version, 80) || !text(s.title, 200) || !text(s.publisher, 200) ||
      typeof s.url !== 'string' || !/^https:\/\/[^\s]+$/.test(s.url) || !one(s.source_kind, ['database', 'verified_seed', 'simulation']) ||
      !one(s.evidence_kind, ['research', 'experience', 'mixed']) || !one(s.validity, ['valid', 'expired', 'conflicting', 'unknown', 'withdrawn']) ||
      !one(s.review_status, ['unverified', 'verified', 'rejected']) || !timestamp(s.updated_at) ||
      !one(x.reference_state, ['available', 'unavailable']) || !Array.isArray(x.dose_cards)) throw failure('INVALID_RESPONSE')
  // This component is read-only science, not the separately gated DoseCard consumer.
  if (x.dose_cards.length !== 0) throw failure('UNSUPPORTED_DOSE_RESPONSE')
  if (x.conditions !== null) {
    keys(x.conditions, ['crop_id', 'region_code'], FILTERS.slice(2))
    try { filters(x.conditions, false) } catch (_) { throw failure('INVALID_RESPONSE') }
  }
  return x
}
function usable(x) { return x.reference_state === 'available' && x.source.validity === 'valid' && x.source.review_status !== 'rejected' }
function fingerprint(x) { const s = x.source; return JSON.stringify([x.id, x.revision, s.id, s.version, s.updated_at, s.title, s.url, s.publisher, s.source_kind, s.evidence_kind, s.validity, s.review_status]) }
function request(path) {
  const b = binding()
  if (!b || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  return new Promise(function (resolve, reject) {
    wx.request({ url: runtime.apiBaseUrl + path, method: 'GET', timeout: 15000,
      header: { authorization: 'Bearer ' + b.token, 'Cache-Control': 'no-cache' },
      success: function (r) {
        if (!current(b)) { reject(failure('SESSION_CHANGED')); return }
        if (r.statusCode === 401 || r.statusCode === 403) { auth.clearSession(); selection = null; reject(failure('SESSION_REQUIRED')); return }
        if (r.statusCode === 400 && object(r.data) && object(r.data.error) && r.data.error.code === 'INVALID_CURSOR') {
          try {
            keys(r.data, ['error', 'meta']); responseMeta(r.data.meta)
            keys(r.data.error, ['code', 'message', 'retryable', 'details'])
            if (typeof r.data.error.message !== 'string' || r.data.error.retryable !== false || !Array.isArray(r.data.error.details)) throw failure('INVALID_RESPONSE')
          } catch (e) { reject(e); return }
          reject(failure('INVALID_CURSOR')); return
        }
        if (r.statusCode !== 200) { reject(failure(r.statusCode === 404 ? 'NOT_FOUND' : 'UNAVAILABLE')); return }
        try {
          keys(r.data, ['data', 'meta']); const m = responseMeta(r.data.meta)
          resolve({ data: r.data.data, mode: m.execution_mode })
        } catch (e) { reject(e) }
      }, fail: function () { reject(failure(current(b) ? 'NETWORK_UNCERTAIN' : 'SESSION_CHANGED')) }
    })
  })
}
async function list(input) {
  const q = filters(input || {}, true), r = await request('/knowledge?' + query(q)), p = r.data
  keys(p, ['items', 'next_cursor'])
  if (!Array.isArray(p.items) || p.items.length > (q.limit || 20) || !(p.next_cursor === null || text(p.next_cursor, 2048)) ||
      (p.next_cursor !== null && p.next_cursor === q.cursor)) throw failure('INVALID_RESPONSE')
  const seen = []
  p.items.forEach(function (x) { validItem(x); if (!usable(x) || seen.indexOf(x.id) !== -1) throw failure('INVALID_RESPONSE'); seen.push(x.id) })
  return { items: p.items, nextCursor: p.next_cursor, mode: r.mode }
}
async function detail(id, input) {
  if (typeof id !== 'string' || !UUID.test(id)) throw failure('INVALID_INPUT')
  const q = filters(input || {}, false), r = await request('/knowledge/' + encodeURIComponent(id) + (Object.keys(q).length ? '?' + query(q) : ''))
  const item = validItem(r.data)
  if (item.id !== id) throw failure('INVALID_RESPONSE')
  if (!usable(item)) throw failure('NOT_FOUND')
  return { item, mode: r.mode }
}
// --- GY-I07 D1：除草剂阅读面（`/herbicides`、`/herbicides/{id}`）----------------------
// 冻结契约里 `Herbicide` 与 `Knowledge` 是**两条独立 schema**（components.schemas.Herbicide =
// id/revision/formulation/source/risk_text/reference_state，additionalProperties:false）：没有
// type/title/body/conditions，**也没有 dose_cards**。所以这里用独立闭集校验器，不把
// Knowledge 形状的 `validItem` 套到除草剂上；`usable`（reference_state+validity+review_status）、
// `labels`（只读 source.*）、`request`（401/403⇒clearSession、404⇒NOT_FOUND、其它非 200⇒UNAVAILABLE）
// 三条语义逐字复用。
const HERBICIDE_KEYS = ['id', 'revision', 'formulation', 'source', 'risk_text', 'reference_state']
const FORMULATION_KEYS = ['id', 'registration_number', 'producer', 'dosage_form', 'ingredients']
const INGREDIENT_KEYS = ['name', 'content_text', 'unit_text']
// 服务端 `/herbicides` querystring 只接受这四项（路由 schema additionalProperties:false）：
// 作物／杂草／地区条件在该接口**不可表达**，不得静默丢弃（页面按来源标记回退随包副本）。
const HERBICIDE_FILTERS = ['q', 'registration_number']
function herbicideQuery(input) {
  if (!object(input) || Object.keys(input).some(k => HERBICIDE_FILTERS.concat(['cursor', 'limit']).indexOf(k) === -1)) throw failure('INVALID_INPUT')
  const out = {}
  Object.keys(input).forEach(function (k) {
    const v = input[k]
    if (k === 'limit') { if (!Number.isInteger(v) || v < 1 || v > 50) throw failure('INVALID_INPUT'); out[k] = v; return }
    if (!text(v, k === 'cursor' ? 2048 : 80)) throw failure('INVALID_INPUT')
    out[k] = v
  })
  return out
}
function validHerbicide(x) {
  // 先判用量卡，再判闭集：带非空 `dose_cards` 的响应必须落 UNSUPPORTED_DOSE_RESPONSE，
  // **不许**被 additionalProperties 闭集降级成 INVALID_RESPONSE（本组件是只读科学资料，
  // 不是另一处门禁的 DoseCard 消费者）。该分支因此刻意放在 `keys()` 之前。
  if (object(x) && Object.prototype.hasOwnProperty.call(x, 'dose_cards') && Array.isArray(x.dose_cards) && x.dose_cards.length !== 0) throw failure('UNSUPPORTED_DOSE_RESPONSE')
  keys(x, HERBICIDE_KEYS)
  const s = x.source, f = x.formulation
  keys(s, ['id', 'version', 'title', 'url', 'publisher', 'source_kind', 'evidence_kind', 'validity', 'review_status', 'updated_at'])
  keys(f, FORMULATION_KEYS)
  if (typeof x.id !== 'string' || !UUID.test(x.id) || !Number.isSafeInteger(x.revision) || x.revision < 1 ||
      !text(x.risk_text, 4000) || !one(x.reference_state, ['available', 'unavailable']) ||
      typeof f.id !== 'string' || !UUID.test(f.id) || !text(f.registration_number, 80) || !text(f.producer, 200) || !text(f.dosage_form, 80) ||
      !Array.isArray(f.ingredients) || f.ingredients.length < 1 || f.ingredients.length > 20 ||
      typeof s.id !== 'string' || !UUID.test(s.id) || !text(s.version, 80) || !text(s.title, 200) || !text(s.publisher, 200) ||
      typeof s.url !== 'string' || !/^https:\/\/[^\s]+$/.test(s.url) || !one(s.source_kind, ['database', 'verified_seed', 'simulation']) ||
      !one(s.evidence_kind, ['research', 'experience', 'mixed']) || !one(s.validity, ['valid', 'expired', 'conflicting', 'unknown', 'withdrawn']) ||
      !one(s.review_status, ['unverified', 'verified', 'rejected']) || !timestamp(s.updated_at)) throw failure('INVALID_RESPONSE')
  f.ingredients.forEach(function (i) {
    keys(i, INGREDIENT_KEYS)
    if (!text(i.name, 80) || !text(i.content_text, 80) || !text(i.unit_text, 80)) throw failure('INVALID_RESPONSE')
  })
  return x
}
async function listHerbicides(input) {
  const q = herbicideQuery(input || {}), r = await request('/herbicides' + (Object.keys(q).length ? '?' + query(q) : '')), p = r.data
  keys(p, ['items', 'next_cursor'])
  if (!Array.isArray(p.items) || p.items.length > (q.limit || 20) || !(p.next_cursor === null || text(p.next_cursor, 2048)) ||
      (p.next_cursor !== null && p.next_cursor === q.cursor)) throw failure('INVALID_RESPONSE')
  const seen = []
  p.items.forEach(function (x) { validHerbicide(x); if (!usable(x) || seen.indexOf(x.id) !== -1) throw failure('INVALID_RESPONSE'); seen.push(x.id) })
  return { items: p.items, nextCursor: p.next_cursor, mode: r.mode }
}
async function detailHerbicide(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw failure('INVALID_INPUT')
  // `/herbicides/{id}` 的 querystring schema 为 additionalProperties:false ⇒ **不带任何查询串**。
  const r = await request('/herbicides/' + encodeURIComponent(id))
  const item = validHerbicide(r.data)
  if (item.id !== id) throw failure('INVALID_RESPONSE')
  if (!usable(item)) throw failure('NOT_FOUND')
  return { item, mode: r.mode }
}
// 数据来源标记（可判定，不是文案）：服务端读数与随包离线副本必须能区分，且不得互相冒充。
const HERBICIDE_SOURCES = { SERVER: 'server', BUNDLED_OFFLINE: 'bundled-offline' }
function herbicideRow(x) {
  const item = validHerbicide(x), l = labels(item)
  return {
    data_source: HERBICIDE_SOURCES.SERVER,
    record_id: item.id,
    registration_number: item.formulation.registration_number,
    producer: item.formulation.producer,
    dosage_form: item.formulation.dosage_form,
    // `Herbicide` 契约里**没有**登记名称/毒性/作物场所：留空并由页面按「接口未提供」呈现。
    // 不得用成分名拼接冒名登记名称（登记简称与成分名不是同一字段）。
    registered_name: '', toxicity: '', use_scene: '',
    ingredients_text: item.formulation.ingredients.map(i => i.name + ' ' + i.content_text).join('、'),
    risk_text: item.risk_text,
    // 来源可追溯三元组：`SourceRef` 的 id／publisher／title 原样透传（闭集校验已保证非空串），
    // 页面据此展示「来源名称」「来源标识」，缺项不补写、不推断。
    source_id: item.source.id,
    source_publisher: item.source.publisher,
    source_title: item.source.title,
    // 展示串：只用契约里的 publisher／title 拼接，不加入任何推断或模型生成内容。
    source_name: item.source.publisher + ' · ' + item.source.title,
    source_version: item.source.version,
    reference_state: item.reference_state,
    source_marker: '服务端接口 /herbicides',
    labels: { source_kind: l.source || '来源类型未知', evidence_kind: l.evidence || '证据类型未知',
      review_status: l.review || '审核状态未知', record_status: '接口未提供字段完整度',
      dose: '本接口未提供用量字段，不提供用量信息' }
  }
}
function herbicideModeNote(mode) { return '除草剂接口 /herbicides · ' + modeNote(mode) }
function remember(item, input) {
  const b = binding(); if (!b) throw failure('SESSION_REQUIRED')
  const conditions = {}; FILTERS.forEach(k => { if (input[k] !== undefined) conditions[k] = input[k] })
  selection = { id: item.id, fingerprint: fingerprint(item), filters: filters(conditions, false), binding: b }
}
function expected(id) { return selection && selection.id === id && current(selection.binding) ? selection : null }
function labels(x) {
  const s = x.source
  return { source: { database: '数据库资料', verified_seed: '已核对种子资料', simulation: '模拟资料' }[s.source_kind],
    evidence: { research: '科研来源', experience: '经验来源', mixed: '混合证据' }[s.evidence_kind],
    review: { verified: '已核对', unverified: '未核对', rejected: '已拒绝' }[s.review_status] }
}
function modeNote(mode) { return mode === 'real' ? '服务端资料读取；来源核对与适用条件仍需分别确认。' : mode === 'preset_demo' ? '预设演示资料，不代表实际查询结果。' : mode === 'stub' ? '替身服务资料，仅供联调，不代表真实资料查询。' : '服务端资料查询；资料需重新核对，失败时不会改用本地资料。' }
function message(e) { return { NOT_FOUND: '资料不存在、已失效或不符合查询条件，请返回列表重新查询。', INVALID_CURSOR: '查询已过期或资料已更新，请点击查询重新开始。', INVALID_INPUT: '查询条件格式不正确，请修改后重试。', INVALID_RESPONSE: '资料响应无法核对，已清空，请重试。', UNSUPPORTED_DOSE_RESPONSE: '该资料含本页尚未接入的用量卡，已停止展示。', SESSION_REQUIRED: '登录状态已失效，请重新登录。', SESSION_CHANGED: '会话已变化，请重新进入查询。', NETWORK_UNCERTAIN: '网络未能确认当前资料，已清空，请重试。' }[e && e.code] || '资料服务暂不可用，已清空，请重试。' }
module.exports = { binding, current, filters, list, detail, listHerbicides, detailHerbicide, herbicideRow, herbicideModeNote,
  HERBICIDE_SOURCES, remember, expected, fingerprint, labels, modeNote, message,
  validId: id => typeof id === 'string' && UUID.test(id), clearSelection: () => { selection = null } }
