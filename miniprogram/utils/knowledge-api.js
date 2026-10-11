// Frozen Knowledge HTTP consumer. No record cache or offline success fallback.
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
        if (r.statusCode !== 200) { reject(failure(r.statusCode === 404 ? 'NOT_FOUND' : 'UNAVAILABLE')); return }
        try {
          keys(r.data, ['data', 'meta']); const m = r.data.meta
          keys(m, ['request_id', 'contract_version', 'execution_mode'])
          if (typeof m.request_id !== 'string' || !UUID.test(m.request_id) || m.contract_version !== '1.0.0' || !one(m.execution_mode, ['real', 'stub', 'preset_demo'])) throw failure('INVALID_RESPONSE')
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
function message(e) { return { NOT_FOUND: '资料不存在、已失效或不符合查询条件，请返回列表重新查询。', INVALID_INPUT: '查询条件格式不正确，请修改后重试。', INVALID_RESPONSE: '资料响应无法核对，已清空，请重试。', UNSUPPORTED_DOSE_RESPONSE: '该资料含本页尚未接入的用量卡，已停止展示。', SESSION_REQUIRED: '登录状态已失效，请重新登录。', SESSION_CHANGED: '会话已变化，请重新进入查询。', NETWORK_UNCERTAIN: '网络未能确认当前资料，已清空，请重试。' }[e && e.code] || '资料服务暂不可用，已清空，请重试。' }
module.exports = { binding, current, filters, list, detail, remember, expected, fingerprint, labels, modeNote, message,
  validId: id => typeof id === 'string' && UUID.test(id), clearSelection: () => { selection = null } }
