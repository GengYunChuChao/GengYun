// GY-I16 收藏 HTTP 消费层（原生小程序侧）。
//
// 契约面（packages/contracts/openapi.json 1.0.0）：
//   listFavorites   GET    /favorites         → FavoritePageEnvelope
//   createFavorite  POST   /favorites         → 201 FavoriteEnvelope
//   deleteFavorite  DELETE /favorites/{id}    → AckEnvelope（If-Match + Idempotency-Key 必填）
//
// 硬口径：
// 1) `reference_state`／`unavailable_reason` 是**服务端逐次派生**的结论：本层**不缓存**、
//    不本地推断可见性，也不把"曾经可用"当成现在可用。服务端说不可用就是不可用。
// 2) 无网络 / 未登录 / 门禁拒绝 / 响应形状异常 → 如实报不可用，**绝不**伪造收藏或本地兜底。
// 3) 响应逐字段校验（先判 typeof 再判值；`undefined` 不会被宽松放过）。
// 4) 收藏**不等于**"已使用"：本层没有任何把收藏转成使用/用量事实的接口。
const auth = require('./auth')
const runtime = require('../config/runtime')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTRACT_VERSION = '1.0.0'
const EXECUTION_MODES = ['real', 'stub', 'preset_demo']
// 契约 FavoriteTarget.type（3 项闭集）与 TargetRef.type（17 项闭集）。
const FAVORITE_TARGET_TYPES = ['species', 'herbicide', 'scheme']
const TARGET_REF_TYPES = ['species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr', 'transcription',
  'answer', 'post', 'comment', 'conversation', 'conversation_turn', 'dose_card', 'media', 'synthesis', 'job', 'source']
const FAVORITE_KEYS = ['id', 'revision', 'target_ref', 'reference_state', 'unavailable_reason', 'created_at']
const TARGET_REF_KEYS = ['type', 'id', 'revision']
const REFERENCE_STATES = ['available', 'unavailable']
const PAGE_LIMIT_MAX = 50

function failure(code) { const e = new Error(code); e.code = code; return e }
function object(x) { return !!x && typeof x === 'object' && !Array.isArray(x) }
function keys(x, required) {
  if (!object(x) || required.some(k => !Object.prototype.hasOwnProperty.call(x, k)) ||
      Object.keys(x).some(k => required.indexOf(k) === -1)) throw failure('INVALID_RESPONSE')
}
function text(x, max) { return typeof x === 'string' && x.length > 0 && x.length <= max }
function one(x, values) { return values.indexOf(x) !== -1 }
function integer(x, min) { return typeof x === 'number' && Number.isSafeInteger(x) && x >= min }
function timestamp(value) {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 &&
    Number(m[3]) <= new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate() && Number.isFinite(Date.parse(value))
}

function binding() { const s = auth.getSession(); return s && auth.isLoggedIn() ? { token: s.accessToken, epoch: auth.sessionEpoch() } : null }
function current(b) { const now = binding(); return !!b && !!now && b.token === now.token && b.epoch === now.epoch }

function validateMeta(meta) {
  keys(meta, ['request_id', 'contract_version', 'execution_mode'])
  if (typeof meta.request_id !== 'string' || !UUID.test(meta.request_id) ||
      meta.contract_version !== CONTRACT_VERSION || !one(meta.execution_mode, EXECUTION_MODES)) throw failure('INVALID_RESPONSE')
  return meta.execution_mode
}

function validateTargetRef(value) {
  keys(value, TARGET_REF_KEYS)
  if (!one(value.type, TARGET_REF_TYPES) || !text(value.id, 80) || !integer(value.revision, 1)) throw failure('INVALID_RESPONSE')
  return { type: value.type, id: value.id, revision: value.revision }
}

function validateFavorite(value) {
  keys(value, FAVORITE_KEYS)
  if (typeof value.id !== 'string' || !UUID.test(value.id) || !integer(value.revision, 1)) throw failure('INVALID_RESPONSE')
  if (!one(value.reference_state, REFERENCE_STATES)) throw failure('INVALID_RESPONSE')
  if (!timestamp(value.created_at)) throw failure('INVALID_RESPONSE')
  // `unavailable_reason`：可用时**必须**为 null，不可用时**必须**是 1..80 字符的说明。
  if (value.reference_state === 'available') {
    if (value.unavailable_reason !== null) throw failure('INVALID_RESPONSE')
  } else if (!text(value.unavailable_reason, 80)) throw failure('INVALID_RESPONSE')
  return {
    id: value.id,
    revision: value.revision,
    target_ref: validateTargetRef(value.target_ref),
    reference_state: value.reference_state,
    unavailable_reason: value.unavailable_reason,
    created_at: value.created_at
  }
}

// 401/403 分流：口径统一由 `miniprogram/utils/auth.js` 的归因层决定（`attribution` / `failureFor`），
// 本文件**不再自持码表**。合并前这里曾有一份 `FORBIDDEN_CODES + forbiddenOrSessionLoss`
// （#393 引入的第三份同形实现），与 `identify-api` / `speech-transcript` 各自那份漂移过；
// 现全站只留 `auth.js` 一份：401 ⇒ 会话失效并清会话；403 ⇒ 契约码原样带出，仅
// `ACCOUNT_INACTIVE` 清会话（令牌已永久失效）；403 无错误封套 ⇒ `SCOPE_DENIED` 且**不**清会话
// （见 `docs/verification/gy-i04-login-chain-20261021.md` 的「口径决定」）。

function request(method, path, options) {
  const opts = options || {}
  const b = binding()
  if (!b || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  const header = { authorization: 'Bearer ' + b.token, 'Cache-Control': 'no-cache' }
  if (opts.body !== undefined) header['content-type'] = 'application/json'
  if (opts.idempotencyKey) header['Idempotency-Key'] = opts.idempotencyKey
  if (opts.ifMatch) header['If-Match'] = opts.ifMatch
  return new Promise(function (resolve, reject) {
    const wxOptions = {
      url: runtime.apiBaseUrl + path, method: method, timeout: 15000, header: header,
      success: function (r) {
        if (!current(b)) { reject(failure('SESSION_CHANGED')); return }
        if (r.statusCode === 401 || r.statusCode === 403) { reject(auth.failureFor(failure, r.statusCode, r.data)); return }
        try {
          const payload = r.data
          if (r.statusCode === 200 || r.statusCode === 201) {
            keys(payload, ['data', 'meta'])
            resolve({ data: payload.data, mode: validateMeta(payload.meta), etag: r.header && r.header.ETag ? r.header.ETag : null })
            return
          }
          if (object(payload) && object(payload.error) && typeof payload.error.code === 'string') {
            const e = failure(payload.error.code); e.status = r.statusCode; e.retryable = payload.error.retryable === true
            reject(e); return
          }
          reject(failure(r.statusCode === 404 ? 'NOT_FOUND' : 'UNAVAILABLE'))
        } catch (e) { reject(e) }
      },
      fail: function () { reject(failure(current(b) ? 'NETWORK_UNCERTAIN' : 'SESSION_CHANGED')) }
    }
    if (opts.body !== undefined) wxOptions.data = opts.body
    wx.request(wxOptions)
  })
}

function newKey(prefix) { return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) }

/** `GET /favorites`：只列本人收藏；`cursor` 缺省即第一页。 */
async function listFavorites(cursor, limit) {
  const query = []
  if (cursor) query.push('cursor=' + encodeURIComponent(cursor))
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) throw failure('INVALID_INPUT')
    query.push('limit=' + limit)
  }
  const r = await request('GET', '/favorites' + (query.length ? '?' + query.join('&') : ''), {})
  keys(r.data, ['items', 'next_cursor'])
  if (!Array.isArray(r.data.items) || !(r.data.next_cursor === null || text(r.data.next_cursor, 2048))) throw failure('INVALID_RESPONSE')
  return { items: r.data.items.map(validateFavorite), nextCursor: r.data.next_cursor, mode: r.mode }
}

/** `POST /favorites`：收藏一个 `species|herbicide|scheme` 目标（服务端按 user+目标去重）。 */
async function createFavorite(targetType, targetId, targetRevision) {
  if (!one(targetType, FAVORITE_TARGET_TYPES)) throw failure('INVALID_INPUT')
  if (!text(targetId, 80) || !integer(targetRevision, 1)) throw failure('INVALID_INPUT')
  const r = await request('POST', '/favorites', {
    body: { target_ref: { type: targetType, id: targetId, revision: targetRevision } },
    idempotencyKey: newKey('fav-create')
  })
  return { favorite: validateFavorite(r.data), mode: r.mode }
}

/** `DELETE /favorites/{id}`：取消收藏（If-Match 用当前强 ETag 对应的 revision）。 */
async function deleteFavorite(favoriteId, revision) {
  if (typeof favoriteId !== 'string' || !UUID.test(favoriteId) || !integer(revision, 1)) throw failure('INVALID_INPUT')
  const r = await request('DELETE', '/favorites/' + favoriteId, {
    ifMatch: '"' + revision + '"', idempotencyKey: newKey('fav-delete')
  })
  keys(r.data, ['accepted'])
  if (r.data.accepted !== true) throw failure('INVALID_RESPONSE')
  return { accepted: true, mode: r.mode }
}

/**
 * 收藏项的**呈现口径**：只描述"当前是否可用"，**不**细分隐藏/失效/不存在
 * （服务端刻意折叠成同一条非披露说明，客户端不得自行拆分或猜测）。
 */
function describeFavorite(item) {
  if (item.reference_state === 'available') {
    return { tone: 'ok', label: '可用', hint: '目标当前可读，可进入资料页查看。', actionText: '查看资料' }
  }
  return { tone: 'muted', label: '不可用', hint: item.unavailable_reason, actionText: '' }
}

/** 收藏类型的中文名（契约 3 项闭集）。 */
function targetTypeLabel(type) {
  return { species: '杂草', herbicide: '药剂', scheme: '方案' }[type] || '未知类型'
}

function messageFor(e) {
  const code = e && e.code
  return {
    SESSION_REQUIRED: '登录状态已失效，请重新登录后再查看收藏。',
    SESSION_CHANGED: '会话已变化，请重新进入本页。',
    NETWORK_UNCERTAIN: '网络未能确认结果，已停止显示，请重试。',
    NOT_FOUND: '该收藏不存在、或已取消、或不属于当前账号。',
    INVALID_INPUT: '请求参数不合法，已停止。',
    INVALID_RESPONSE: '服务端响应无法核对，已停止显示，请重试。',
    REVISION_CONFLICT: '收藏已被更新，请刷新后重试。',
    REVISION_REQUIRED: '缺少版本信息，请刷新后重试。',
    IDEMPOTENCY_KEY_REQUIRED: '请求缺少幂等键，请重试。',
    IDEMPOTENCY_CONFLICT: '同一幂等键被复用于不同请求，请重试。',
    SCOPE_DENIED: '当前会话无权读写用户收藏（收藏只对用户会话开放）。',
    CONSENT_REQUIRED: '缺少必要的授权同意，无法读取或修改收藏。',
    ACCOUNT_INACTIVE: '账号当前不可用（已停用或已注销），无法读取或修改收藏。',
    PROVIDER_UNAVAILABLE: '收藏服务当前不可用（真实持久存储未接入），不会用本地数据顶替。',
    INVALID_CURSOR: '翻页位置已失效，请重新读取第一页。',
    UNAVAILABLE: '收藏服务暂不可用，已停止显示，请重试。'
  }[code] || '收藏服务暂不可用，已停止显示，请重试。'
}

module.exports = {
  FAVORITE_TARGET_TYPES: FAVORITE_TARGET_TYPES.slice(),
  TARGET_REF_TYPES: TARGET_REF_TYPES.slice(),
  FAVORITE_KEYS: FAVORITE_KEYS.slice(),
  PAGE_LIMIT_MAX: PAGE_LIMIT_MAX,
  CONTRACT_VERSION: CONTRACT_VERSION,
  listFavorites: listFavorites,
  createFavorite: createFavorite,
  deleteFavorite: deleteFavorite,
  describeFavorite: describeFavorite,
  targetTypeLabel: targetTypeLabel,
  messageFor: messageFor,
  newKey: newKey,
  validId: function (id) { return typeof id === 'string' && UUID.test(id) }
}
