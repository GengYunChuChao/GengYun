/**
 * 注销账号（account deletion）客户端适配层 —— 契约 1.0.0
 * ------------------------------------------------------------
 * 本模块只做三件事：把契约里那 3 个 operation 包成 Promise、把封套校验到
 * 「少一个必填键就不认」、把错误码翻成页面能直接显示的中文。它不做任何 UI 决策。
 *
 * | operationId            | 方法 / 路径                 | 鉴权              | 请求头                    | 成功 |
 * |------------------------|-----------------------------|-------------------|---------------------------|------|
 * | requestAccountDeletion | POST /me/account/deletion   | 登录会话 [user]   | Idempotency-Key（8..128） | 202  |
 * | getDeletionReceipt     | GET /account/deletions/{id} | **注销回执 bearer** | Authorization: Bearer ... | 200  |
 * | cancelDeletion         | DELETE /me/account/deletion | 登录会话 [user]   | Idempotency-Key（8..128） | 200  |
 *
 * 成功封套一律 `{data, meta}`，`meta` = `{request_id: uuid, contract_version,
 * execution_mode}`；回执本体是 `DeletionReceipt`（id/state/revision/requested_at/
 * online_due_at/backup_due_at/handlers）。契约**没有**给这三个 operation 定义
 * `If-Match`（只有 `IdempotencyKey` 参数），所以这里也不自发 `If-Match`：
 * 多送一个头不会被服务端当成条件请求，只会让「为什么没带」变成下一个人要查的事。
 * 服务端返回的 `ETag` 只用于展示 revision 来源，本模块不做条件重放。
 *
 * ⚠️ 三个 operation 的鉴权面**不是同一个**，这是本模块最容易被写错的地方：
 *   · 申请与取消吃的是登录会话（`auth` 的 `gengyun.session` → `authorization: Bearer <session>`）；
 *   · 查回执吃的是申请时一次性签发的**回执 bearer**（`receipt_token`），与登录会话无关
 *     （`services/api/src/routes/account-deletion.ts:284-322` 不挂 `requireUser`；用户会话
 *     令牌打这一面一律 401 —— 契约 `GET /account/deletions/{id}` 的 security 就是
 *     `[{deletionReceipt: []}]`）。
 *   因此查回执**绝对不能**走 `auth.failureFor`：那个函数见到 401 会 `clearSession()`
 *   （`utils/auth.js` 的 `attribution`），而回执 bearer 过期/被替换时服务端返回的正是
 *   401 —— 走它会把一个只想看进度的用户直接登出。本模块给这一面单独一条
 *   `receiptError()`：只翻码，绝不碰会话。
 *
 * 回执 bearer 的保管口径（产品口径 + 实现约束，写在这里免得下一个人再猜）：
 *   · 只存在本机 `wx.setStorageSync('gengyun.deletion.receipt')`，**只存最近一条**；
 *   · 只用于 `getDeletionReceipt` 查**这一条**回执：`readReceipt(id)` 会校验存储里的 id
 *     与请求 id 一致，不一致就当没有凭据（不拿 A 的回执去查 B）；
 *   · 它**不是**登录态：退出登录**不删**它（用户退出后仍可能想确认注销是否生效），
 *     换设备**拿不到**它（没有服务端同步、没有短信/二维码补发通道），清缓存或重装即丢；
 *   · 丢了**没有找回路径**：页面必须如实说「本机已无凭据」，给「重新申请」而不是假装能查；
 *   · 到期（`receipt_expires_at`）后本地直接丢弃，不再发请求（省一次注定 401 的往返）。
 *
 * 错误码口径：契约错误码原样透传（`states.CODE_KIND` 里有的一律不改名）；同一条码在
 * 两个面上的含义不同时，用 `messageFor(code, intent)` 的第二个参数区分 —— 例如
 * `SESSION_REQUIRED` 在会话面是「请重新登录」，在回执面是「本机没有回执凭据」。
 */

const auth = require('./auth')
const states = require('./states')
const runtime = require('../config/runtime')

const CONTRACT_VERSION = '1.0.0'
const EXECUTION_MODES = ['real', 'stub', 'preset_demo']
const RECEIPT_KEY = 'gengyun.deletion.receipt'
const REQUEST_TIMEOUT = 15000
const DELETE_CONFIRMATION = 'delete_account'
const KEY_MIN = 8
const KEY_MAX = 128
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `DeletionState`（契约闭集）。页面不得自造状态名。 */
const DELETION_STATES = ['requested', 'processing', 'blocked', 'completed', 'cancelled']
/** `DeletionHandler.online_state` / `.backup_state`（契约闭集）。 */
const PART_STATES = ['pending', 'running', 'completed', 'blocked']
/** `ThirdPartyState`（契约闭集）。 */
const THIRD_PARTY_STATES = ['not_requested', 'requested', 'confirmed', 'failed', 'unsupported']

function failure(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isTime(value) {
  return typeof value === 'string' && value !== '' && !isNaN(Date.parse(value))
}

// ---------------------------------------------------------------- 幂等键

/** 幂等键长度/形状同服务端校验（`idempotency-key` 必须 string 且 8..128）。 */
function validKey(key) {
  return typeof key === 'string' && key.length >= KEY_MIN && key.length <= KEY_MAX
}

function newKey(prefix) {
  const rand = Math.random().toString(36).slice(2, 10)
  return (prefix + '-' + Date.now().toString(36) + '-' + rand).slice(0, KEY_MAX)
}

// ---------------------------------------------------------------- 本机回执凭据

/**
 * 保存最近一条回执凭据 + 它最后一次被读到的快照。
 * 快照（`deletion`）是给「刷新失败时别清屏」用的：失败时页面继续显示上次读到的
 * id/state/到期时间，并标明这是本机上次的读数，而不是假装刚刚读到。
 * @returns {{id: string, token: string, expiresAt: string, savedAt: string, deletion: object}|null}
 */
function saveReceipt(record) {
  if (!isObject(record)) return null
  if (typeof record.id !== 'string' || !UUID.test(record.id)) return null
  if (typeof record.token !== 'string' || record.token === '') return null
  if (!isTime(record.expiresAt)) return null
  const stored = {
    v: 1,
    id: record.id,
    token: record.token,
    expiresAt: record.expiresAt,
    savedAt: new Date().toISOString(),
    deletion: isObject(record.deletion) ? readReceiptShape(record.deletion) : null
  }
  try {
    wx.setStorageSync(RECEIPT_KEY, stored)
  } catch (e) {
    return null
  }
  return stored
}

/** 读本机凭据；形状不对或已到期 ⇒ 清掉并返回 null（到期后不再发注定 401 的请求）。 */
function loadReceipt() {
  let stored = null
  try {
    stored = wx.getStorageSync(RECEIPT_KEY)
  } catch (e) {
    return null
  }
  if (!isObject(stored) || stored.v !== 1) {
    clearReceipt()
    return null
  }
  if (typeof stored.id !== 'string' || !UUID.test(stored.id)) {
    clearReceipt()
    return null
  }
  if (typeof stored.token !== 'string' || stored.token === '' || !isTime(stored.expiresAt)) {
    clearReceipt()
    return null
  }
  if (Date.parse(stored.expiresAt) <= Date.now()) {
    clearReceipt()
    return null
  }
  return {
    id: stored.id,
    token: stored.token,
    expiresAt: stored.expiresAt,
    savedAt: typeof stored.savedAt === 'string' ? stored.savedAt : '',
    deletion: isObject(stored.deletion) ? readReceiptShape(stored.deletion) : null
  }
}

function clearReceipt() {
  try {
    wx.removeStorageSync(RECEIPT_KEY)
  } catch (e) {
    // 本地清理失败不改写调用方结论：凭据最多留到下次 loadReceipt 再判一次。
  }
}

/** 只把与 `id` 对得上的凭据交出去：不拿一条回执的 bearer 去查另一条。 */
function tokenFor(id) {
  const stored = loadReceipt()
  return stored && stored.id === id ? stored.token : ''
}

// ---------------------------------------------------------------- 传输

function binding() {
  const session = auth.getSession()
  return session && auth.isLoggedIn() ? { token: session.accessToken, epoch: auth.sessionEpoch() } : null
}

function current(b) {
  const session = auth.getSession()
  return !!session && session.accessToken === b.token && auth.sessionEpoch() === b.epoch
}

function raw(method, path, options) {
  return new Promise(function (resolve, reject) {
    wx.request({
      url: runtime.apiBaseUrl + path,
      method: method,
      data: options.body,
      timeout: REQUEST_TIMEOUT,
      header: options.header,
      success: function (response) {
        resolve(response || {})
      },
      fail: function () {
        // 请求没有拿到响应：结果不确定。申请/取消面用 NETWORK_UNCERTAIN（别乐观当失败），
        // 回执面同样如此 —— 不确定不等于「回执没了」。
        reject(failure('NETWORK_UNCERTAIN'))
      }
    })
  })
}

/** 会话面调用（POST 申请 / DELETE 取消）：带登录会话，且在途期间会话变了就不认结果。 */
async function sessionCall(method, path, options) {
  if (!auth.networkEnabled()) throw failure('UNAVAILABLE')
  const b = binding()
  if (!b) throw failure('SESSION_REQUIRED')
  const header = Object.assign({ 'content-type': 'application/json' }, options.header || {}, {
    authorization: 'Bearer ' + b.token
  })
  const response = await raw(method, path, { body: options.body, header: header })
  if (!current(b)) throw failure('SESSION_CHANGED')
  return response
}

/**
 * 回执面调用：只带回执 bearer，**不带**登录会话。
 * 401/403 在这里不意味着登录态没了，所以一个字段都不交给 `auth.failureFor`。
 */
async function receiptCall(id, token) {
  if (!auth.networkEnabled()) throw failure('UNAVAILABLE')
  const response = await raw('GET', '/account/deletions/' + encodeURIComponent(id), {
    header: { 'content-type': 'application/json', authorization: 'Bearer ' + token }
  })
  return response
}

/** 会话面的状态码 → 错误码（401/403 交给 `auth.failureFor`，它负责契约闭集与清会话）。 */
function sessionError(response) {
  const status = response.statusCode || 0
  const payload = response.data || {}
  if (status === 401 || status === 403) return auth.failureFor(failure, status, payload)
  const code = payload && payload.error && payload.error.code
  return failure(typeof code === 'string' && code !== '' ? code : 'UNAVAILABLE')
}

/** 回执面的状态码 → 错误码。只读 `error.code`，绝不 `clearSession()`。 */
function receiptError(response) {
  const status = response.statusCode || 0
  const payload = response.data || {}
  const code = payload && payload.error && payload.error.code
  if (typeof code === 'string' && code !== '') return failure(code)
  if (status === 401) return failure('SESSION_EXPIRED')
  if (status === 404) return failure('NOT_FOUND')
  return failure('UNAVAILABLE')
}

// ---------------------------------------------------------------- 封套校验

function metaOf(meta) {
  if (!isObject(meta)) return null
  if (typeof meta.request_id !== 'string' || !UUID.test(meta.request_id)) return null
  if (meta.contract_version !== CONTRACT_VERSION) return null
  if (EXECUTION_MODES.indexOf(meta.execution_mode) === -1) return null
  return meta
}

/**
 * 只保留契约里那几个键，且每个都按契约校验；有一项不合格就整条不认（返回 null）。
 * 为什么不「宽松接受」：注销是不可逆流程，页面要展示「什么时候失效」，读错一个字段
 * 就会把假的到期时间当真话讲给用户。
 */
function readReceiptShape(value) {
  if (!isObject(value)) return null
  if (typeof value.id !== 'string' || !UUID.test(value.id)) return null
  if (DELETION_STATES.indexOf(value.state) === -1) return null
  if (typeof value.revision !== 'number' || !isFinite(value.revision) || value.revision < 1) return null
  if (!isTime(value.requested_at) || !isTime(value.online_due_at) || !isTime(value.backup_due_at)) return null
  if (!Array.isArray(value.handlers) || value.handlers.length > 50) return null
  const handlers = []
  for (let i = 0; i < value.handlers.length; i += 1) {
    const handler = value.handlers[i]
    if (!isObject(handler) || typeof handler.module !== 'string' || handler.module === '') return null
    if (PART_STATES.indexOf(handler.online_state) === -1) return null
    if (PART_STATES.indexOf(handler.backup_state) === -1) return null
    const thirdParty = handler.third_party_state
    if (thirdParty !== null && THIRD_PARTY_STATES.indexOf(thirdParty) === -1) return null
    const errorCode = handler.error_code
    if (errorCode !== null && (typeof errorCode !== 'string' || errorCode === '')) return null
    handlers.push({
      module: handler.module,
      online_state: handler.online_state,
      backup_state: handler.backup_state,
      third_party_state: thirdParty,
      error_code: errorCode
    })
  }
  return {
    id: value.id,
    state: value.state,
    revision: value.revision,
    requested_at: value.requested_at,
    online_due_at: value.online_due_at,
    backup_due_at: value.backup_due_at,
    handlers: handlers
  }
}

function acceptedOf(data) {
  if (!isObject(data)) return null
  if (typeof data.receipt_token !== 'string' || data.receipt_token === '') return null
  if (!isTime(data.receipt_expires_at)) return null
  const deletion = readReceiptShape(data.deletion)
  if (!deletion) return null
  return { receiptToken: data.receipt_token, receiptExpiresAt: data.receipt_expires_at, deletion: deletion }
}

// ---------------------------------------------------------------- 三个 operation

/**
 * `requestAccountDeletion`：POST /me/account/deletion。
 * 202 + `DeletionAcceptedEnvelope`。幂等键由调用方决定复用（同一份申请重试要用同一个键，
 * 服务端命中同键会重新签发 bearer 而不会重复建单）。
 */
async function requestAccountDeletion(options) {
  const opts = options || {}
  const key = opts.idempotencyKey || newKey('deletion-request')
  if (!validKey(key)) throw failure('IDEMPOTENCY_KEY_REQUIRED')
  const response = await sessionCall('POST', '/me/account/deletion', {
    body: { confirmation: DELETE_CONFIRMATION },
    header: { 'Idempotency-Key': key }
  })
  if (response.statusCode !== 202) throw sessionError(response)
  const body = response.data || {}
  const meta = metaOf(body.meta)
  const accepted = acceptedOf(body.data)
  if (!meta || !accepted) throw failure('UNAVAILABLE')
  return {
    receiptToken: accepted.receiptToken,
    receiptExpiresAt: accepted.receiptExpiresAt,
    deletion: accepted.deletion,
    meta: meta,
    idempotencyKey: key
  }
}

/**
 * `getDeletionReceipt`：GET /account/deletions/{id}，**回执 bearer**鉴权。
 * `options.token` 不给就用本机保存的那一条（且必须 id 一致）。
 * 本地没有凭据时不发请求：服务端对「没有回执 bearer」的正式答复就是 401
 * `SESSION_REQUIRED`（`account-deletion.ts:293`），本地直接用同一个码，
 * 页面对这一面按「失效」呈现，不按「未登录」。
 */
async function readReceipt(id, options) {
  const opts = options || {}
  if (typeof id !== 'string' || !UUID.test(id)) throw failure('SESSION_REQUIRED')
  const token = opts.token || tokenFor(id)
  if (!token) throw failure('SESSION_REQUIRED')
  const response = await receiptCall(id, token)
  if (response.statusCode !== 200) throw receiptError(response)
  const body = response.data || {}
  const meta = metaOf(body.meta)
  const deletion = readReceiptShape(body.data)
  if (!meta || !deletion) throw failure('UNAVAILABLE')
  return { deletion: deletion, meta: meta }
}

/**
 * `cancelDeletion`：DELETE /me/account/deletion，200 + `DeletionReceiptEnvelope`
 * （state=cancelled）。服务端在「没有可取消的在途请求」时回 404 `NOT_FOUND`，
 * 这里原样透传 —— 客户端不把 404 自行解释成「已生效」。
 */
async function cancelDeletion(options) {
  const opts = options || {}
  const key = opts.idempotencyKey || newKey('deletion-cancel')
  if (!validKey(key)) throw failure('IDEMPOTENCY_KEY_REQUIRED')
  const response = await sessionCall('DELETE', '/me/account/deletion', {
    header: { 'Idempotency-Key': key }
  })
  if (response.statusCode !== 200) throw sessionError(response)
  const body = response.data || {}
  const meta = metaOf(body.meta)
  const deletion = readReceiptShape(body.data)
  if (!meta || !deletion) throw failure('UNAVAILABLE')
  return { deletion: deletion, meta: meta, idempotencyKey: key }
}

// ---------------------------------------------------------------- 投影与文案

const STATE_LABELS = {
  requested: '已提交，等待处理',
  processing: '处理中',
  blocked: '有环节被阻塞',
  completed: '已完成',
  cancelled: '已取消'
}

const PART_LABELS = {
  pending: '未开始',
  running: '进行中',
  completed: '已完成',
  blocked: '被阻塞'
}

const THIRD_PARTY_LABELS = {
  not_requested: '未通知',
  requested: '已通知',
  confirmed: '对方已确认',
  failed: '通知失败',
  unsupported: '对方不支持'
}

function pad(value) {
  return value < 10 ? '0' + value : String(value)
}

/** 服务端给的是带时区的 ISO 串，页面只显示本机本地时间（不做「几天后」换算）。 */
function formatTime(iso) {
  const at = Date.parse(iso)
  if (isNaN(at)) return ''
  const date = new Date(at)
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/** 把 `DeletionReceipt` 投影成页面直接用的一层（含中文标签），不改契约字段。 */
function describe(deletion) {
  const receipt = readReceiptShape(deletion)
  if (!receipt) return null
  return {
    id: receipt.id,
    state: receipt.state,
    stateLabel: STATE_LABELS[receipt.state] || receipt.state,
    revision: receipt.revision,
    requestedAt: formatTime(receipt.requested_at),
    onlineDueAt: formatTime(receipt.online_due_at),
    backupDueAt: formatTime(receipt.backup_due_at),
    rows: receipt.handlers.map(function (handler) {
      return {
        module: handler.module,
        online: PART_LABELS[handler.online_state] || handler.online_state,
        backup: PART_LABELS[handler.backup_state] || handler.backup_state,
        thirdParty: handler.third_party_state ? THIRD_PARTY_LABELS[handler.third_party_state] || handler.third_party_state : '',
        errorCode: handler.error_code || ''
      }
    })
  }
}

const MESSAGES = {
  SESSION_REQUIRED: '登录状态已失效，请重新登录后再操作。',
  SESSION_EXPIRED: '登录状态已过期，请重新登录后再操作。',
  SESSION_CHANGED: '操作期间登录状态变了（可能换了账号），本次结果不予采用。',
  ACCOUNT_INACTIVE: '当前账号已停用或已注销，无法再执行这项操作。',
  SCOPE_DENIED: '当前账号没有这项操作的权限。',
  CONSENT_REQUIRED: '缺少必要的授权同意，请先完成授权。',
  IDEMPOTENCY_KEY_REQUIRED: '客户端没有带上合规的幂等键，请求没有发出。',
  IDEMPOTENCY_CONFLICT: '这个幂等键已被另一份内容不同的请求占用，请重新发起。',
  REQUEST_IN_PROGRESS: '同一份请求正在处理中，请稍后用同一个幂等键重试。',
  NOT_FOUND: '服务端没有找到这条注销申请（可能已生效、已取消或已过期）。',
  OBJECT_UNAVAILABLE: '这条注销申请在服务端已不可达（进程内台账已失效），请重新发起。',
  REVISION_REQUIRED: '缺少版本号，请求没有发出。',
  REVISION_CONFLICT: '内容已被改动过，请重新读取后再操作。',
  RATE_LIMITED: '请求过于频繁，请稍后再试。',
  PROVIDER_UNAVAILABLE: '服务端还没有装配注销能力（fail-closed），本次没有产生任何注销请求。',
  PROVIDER_OUTCOME_UNKNOWN: '服务端处理结果不确定，请先刷新回执再决定是否重试。',
  PROVIDER_TIMEOUT: '服务端处理超时，请先刷新回执再决定是否重试。',
  INTERNAL_ERROR: '服务端处理失败（不是网络问题），请稍后再试或联系管理员。',
  INVALID_REQUEST: '请求参数不被接受，本次没有提交成功。',
  UNAVAILABLE: '服务暂时不可用，请稍后重试。',
  NETWORK_UNCERTAIN: '网络没有拿到响应，结果不确定：请先刷新回执，不要急着重复提交。'
}

/** 回执面专用的同码不同义文案（见文件头「错误码口径」）。 */
const RECEIPT_MESSAGES = {
  SESSION_REQUIRED: '本机没有保存这条回执的凭据。回执只在当初申请的那台设备上可查：换设备、清缓存或重装后无法再查，也没有补发通道。',
  SESSION_EXPIRED: '这条回执的凭据已在服务端失效（到期或被替换），查不到了。',
  NOT_FOUND: '服务端已经没有这条注销回执（可能早已处理完）。'
}

/**
 * @param {string} code 契约错误码 / 客户端码
 * @param {'apply'|'read'|'cancel'} [intent] 哪个面：同一码在回执面另有说法
 */
function messageFor(code, intent) {
  if (intent === 'read' && RECEIPT_MESSAGES[code]) return RECEIPT_MESSAGES[code]
  if (MESSAGES[code]) return MESSAGES[code]
  return '操作没有成功（' + String(code || 'UNKNOWN') + '），请稍后再试。'
}

/**
 * 错误码 → 九态里的哪一种。
 * 注意 `NETWORK_UNCERTAIN` 不在契约码表（`states.CODE_KIND`）里，`states.resolve` 对未知码
 * 一律判「不可重试」；而网络没拿到响应恰恰是该重试的场景，所以这里显式覆盖。
 */
function resolveCode(code) {
  return states.resolve(code, code === 'NETWORK_UNCERTAIN' ? { retryable: true } : {})
}

module.exports = {
  CONTRACT_VERSION,
  DELETION_STATES,
  RECEIPT_KEY,
  DELETE_CONFIRMATION,
  newKey,
  validKey,
  saveReceipt,
  loadReceipt,
  clearReceipt,
  tokenFor,
  requestAccountDeletion,
  readReceipt,
  cancelDeletion,
  describe,
  formatTime,
  messageFor,
  resolveCode,
  readReceiptShape
}
