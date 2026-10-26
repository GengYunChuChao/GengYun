// 首页公开预览的唯一消费层：GET /public/home。
// 公共读面不带会话、详情 ID 或私有媒体；共享 runtime 关闭时不得发请求。
const auth = require('./auth')
const runtime = require('../config/runtime')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODES = ['real', 'stub', 'preset_demo']
const SOURCE_LABELS = { database: '数据库资料', verified_seed: '已核对种子资料', simulation: '模拟资料' }

function failure(code) { const error = new Error(code); error.code = code; return error }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value) }
function keys(value, required) {
  if (!object(value) || required.some(function (key) { return !Object.prototype.hasOwnProperty.call(value, key) }) ||
      Object.keys(value).some(function (key) { return required.indexOf(key) === -1 })) throw failure('INVALID_RESPONSE')
}
function text(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max }
function one(value, values) { return values.indexOf(value) !== -1 }
function enabled() { return auth.networkEnabled() }

function validMeta(meta) {
  keys(meta, ['request_id', 'contract_version', 'execution_mode'])
  if (typeof meta.request_id !== 'string' || !UUID.test(meta.request_id) ||
      meta.contract_version !== '1.0.0' || !one(meta.execution_mode, MODES)) throw failure('INVALID_RESPONSE')
  return meta
}

function previewRow(preview) {
  keys(preview, ['id', 'title', 'summary', 'content_type', 'source_kind'])
  if (typeof preview.id !== 'string' || !UUID.test(preview.id) || !text(preview.title, 200) ||
      !text(preview.summary, 500) || !one(preview.content_type, ['knowledge', 'community']) ||
      !(preview.source_kind === null || one(preview.source_kind, Object.keys(SOURCE_LABELS)))) throw failure('INVALID_RESPONSE')
  return {
    id: preview.id,
    title: preview.title,
    summary: preview.summary,
    kind: preview.content_type,
    typeLabel: preview.content_type === 'knowledge' ? '科普知识' : '社区公开内容',
    sourceLabel: preview.source_kind === null ? '来源类型未提供' : SOURCE_LABELS[preview.source_kind]
  }
}

function modeNote(mode) {
  if (mode === 'stub') return '替身响应 · 仅供联调，不代表真实公开资料。'
  if (mode === 'preset_demo') return '预设演示响应 · 不代表真实公开资料。'
  return '公开接口返回 · 仅展示标题与摘要；来源与详情仍需进入对应页面核对。'
}

function load() {
  if (!enabled()) return Promise.reject(failure('NETWORK_DISABLED'))
  return new Promise(function (resolve, reject) {
    wx.request({
      url: runtime.apiBaseUrl + '/public/home', method: 'GET', timeout: 15000,
      header: { 'Cache-Control': 'no-cache' },
      success: function (response) {
        if (response.statusCode !== 200) {
          const code = object(response.data) && object(response.data.error) && typeof response.data.error.code === 'string'
            ? response.data.error.code : 'UNAVAILABLE'
          reject(failure(code)); return
        }
        try {
          keys(response.data, ['data', 'meta'])
          const meta = validMeta(response.data.meta)
          const data = response.data.data
          keys(data, ['previews', 'human_review_state'])
          if (!Array.isArray(data.previews) || data.previews.length > 10 || data.human_review_state !== 'under_construction') {
            throw failure('INVALID_RESPONSE')
          }
          resolve({ items: data.previews.map(previewRow), mode: meta.execution_mode, note: modeNote(meta.execution_mode) })
        } catch (error) { reject(error) }
      },
      fail: function () { reject(failure('NETWORK_UNCERTAIN')) }
    })
  })
}

function message(error) {
  const code = error && error.code
  if (code === 'NETWORK_DISABLED') return '当前工程未启用联网，未请求公开预览。'
  if (code === 'INVALID_RESPONSE') return '公开预览响应无法核对，已停止展示，请重试。'
  if (code === 'NETWORK_UNCERTAIN') return '网络未能确认公开预览，已停止展示，请重试。'
  if (code === 'PROVIDER_UNAVAILABLE') return '公开预览服务暂不可用，请稍后重试。'
  return '公开预览暂不可用，请稍后重试。'
}

module.exports = { enabled: enabled, load: load, message: message }
