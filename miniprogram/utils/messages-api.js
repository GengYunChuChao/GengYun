// GY-I17（#17）阶段 3 · 消息 HTTP 消费层（小程序侧）。
//
// 纪律（与 utils/community-api.js 同口径）：
// 1. **不缓存内容、不做离线成功回落**：任何失败都如实抛出错误码，由页面收口到 state-view；
// 2. 只消费契约已声明的 **3 条 operation**（`listMessages` / `getUnreadCount` / `markMessageRead`），
//    封套、实体形状、闭集、头部逐项核对，不符即 INVALID_RESPONSE（不"尽力解析"）；
// 3. 身份只来自服务端签发的会话令牌；客户端**不**声明 owner_id／读状态／版本；
// 4. 写路径按契约带 `Idempotency-Key`，并带 `If-Match: "<revision>"`（消息当前强 ETag）；
//    同一 `(id, revision)` 的**重试**复用同一个键（见 `retryKeyFor`），成功后释放；
// 5. **401/403 归因委托统一层**（`utils/auth.js` 的 `attribution`/`failureFor`，D1 #396）：
//    本模块**不自建 401/403 码表**。统一口径：401 ⇒ `SESSION_REQUIRED` + 清会话（guest）；
//    403 ⇒ `SCOPE_DENIED`／`CONSENT_REQUIRED`／`ACCOUNT_INACTIVE` 原样带出（denied），
//    其中 `ACCOUNT_INACTIVE` 按统一层口径**清会话**、码保留；403 无封套 ⇒ `SCOPE_DENIED`。
//    本模块只负责这三码的**文案**（措辞属本域，归因不属本域）。
//
// 契约事实（逐字段核对 `packages/contracts/openapi.json`，与 `services/api/src/messages/types.ts` 同口径）：
//   - `Message` 的键**恰为 7 项**：`id`/`revision`/`type`/`target_ref`/`reference_state`/`read_at`/`created_at`；
//     契约里**没有** `title`/`body`/`actor`/`summary`/`unread` —— 本模块**不伪造**消息标题与正文，
//     也不为它们造本地替身字段（页面只按 `type` 呈现固定标签，不假装服务端给了正文）；
//   - `type` 闭集 `comment|like|moderation|system`；`reference_state` 闭集 `available|unavailable`；
//     `TargetRef.type` 闭集 17 项；`read_at` 为 date-time 或 null；`UnreadCount` 为 `{count}`（整数 ≥0）；
//   - 未读数是**派生量**（服务端每次现算 `read_at === null` 的行数，见 `messages/service.ts` 不变式 2）
//     ⇒ 本模块**不维护本地计数器**，每次都向服务端重新读取。
//
// 未取得（如实标注，不得当作已完成）：
//   - **real 模式服务端在消息持久存储未接线时整域 503 `PROVIDER_UNAVAILABLE`**（fail-closed）：
//     页面必须按「服务未接线」如实展示，**绝不显示成「暂无消息」**，也不用本地数据顶替；
//   - **目标可用性端口已接线**（`#425`，服务端 `services/api/src/messages/reference-community.ts`）：
//     只有 `post`／`comment` 两型可能为 `available`，其余 15 型恒为 `unavailable`，
//     且**不泄露目标是否存在**（未接线类型不因目标有无而改变判定）。本模块只透传 `reference_state`；
//     跳转入口与目标类型判据在页面侧（`pages/messages`），本模块**不**拼路由、不伪造目标标题；
//   - 首版**不接**微信外部推送；`comment`／`like` 两类消息自 `#422` 起已有生产路径
//     （社区事件经消息域端口真落库），本模块仍不为其造任何替身消息。
const auth = require('./auth')
const runtime = require('../config/runtime')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MESSAGE_TYPES = ['comment', 'like', 'moderation', 'system']
const REFERENCE_STATES = ['available', 'unavailable']
/** openapi.json -> TargetRef.type（17 项闭集，不得扩展）。 */
const TARGET_REF_TYPES = ['species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr',
  'transcription', 'answer', 'post', 'comment', 'conversation', 'conversation_turn', 'dose_card', 'media', 'synthesis', 'job', 'source']
/** openapi.json -> Message（`additionalProperties:false`，required 恰为 7 项）。 */
const MESSAGE_FIELDS = ['id', 'revision', 'type', 'target_ref', 'reference_state', 'read_at', 'created_at']

function failure(code, extra) {
  const error = new Error(code)
  error.code = code
  if (extra) error.details = extra
  return error
}
function object(x) { return !!x && typeof x === 'object' && !Array.isArray(x) }
function text(x, max) { return typeof x === 'string' && x.length > 0 && x.length <= max }
function one(x, values) { return values.indexOf(x) !== -1 }
function uuid(x) { return typeof x === 'string' && UUID.test(x) }
function timestamp(value) {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 &&
    Number(m[3]) <= new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate() && Number.isFinite(Date.parse(value))
}
function keys(x, required, optional) {
  if (!object(x) || required.some(function (k) { return !Object.prototype.hasOwnProperty.call(x, k) }) ||
    Object.keys(x).some(function (k) { return required.concat(optional || []).indexOf(k) === -1 })) {
    throw failure('INVALID_RESPONSE')
  }
}
function responseMeta(meta) {
  keys(meta, ['request_id', 'contract_version', 'execution_mode'])
  if (!uuid(meta.request_id) || meta.contract_version !== '1.0.0' ||
    !one(meta.execution_mode, ['real', 'stub', 'preset_demo'])) throw failure('INVALID_RESPONSE')
  return meta
}
function binding() {
  const session = auth.getSession()
  return session && auth.isLoggedIn() ? { token: session.accessToken, epoch: auth.sessionEpoch() } : null
}
function current(b) {
  const now = binding()
  return !!b && !!now && b.token === now.token && b.epoch === now.epoch
}

function validTargetRef(ref) {
  keys(ref, ['type', 'id', 'revision'])
  if (!one(ref.type, TARGET_REF_TYPES) || !text(ref.id, 80) ||
    !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw failure('INVALID_RESPONSE')
}
/** 逐字段核对 `Message`：键集恰为 7 项、闭集/时间戳/uuid 全对，否则 INVALID_RESPONSE。 */
function validMessage(message) {
  keys(message, MESSAGE_FIELDS)
  if (!uuid(message.id) || !Number.isSafeInteger(message.revision) || message.revision < 1 ||
    !one(message.type, MESSAGE_TYPES) || !one(message.reference_state, REFERENCE_STATES) ||
    !timestamp(message.created_at) ||
    !(message.read_at === null || timestamp(message.read_at))) throw failure('INVALID_RESPONSE')
  if (message.target_ref !== null) validTargetRef(message.target_ref)
  // 契约语义：没有目标的消息不可能"目标可用"（服务端 reference.ts 同口径，fail-closed）。
  if (message.target_ref === null && message.reference_state !== 'unavailable') throw failure('INVALID_RESPONSE')
  return message
}
function page(data, limit) {
  keys(data, ['items', 'next_cursor'])
  if (!Array.isArray(data.items) || data.items.length > (limit || 20) || data.items.length > 50 ||
    !(data.next_cursor === null || text(data.next_cursor, 2048))) throw failure('INVALID_RESPONSE')
  const seen = []
  data.items.forEach(function (item) {
    validMessage(item)
    if (seen.indexOf(item.id) !== -1) throw failure('INVALID_RESPONSE')
    seen.push(item.id)
  })
  return { items: data.items, nextCursor: data.next_cursor }
}
function query(params) {
  const keysIn = Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== null })
  return keysIn.sort().map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]) }).join('&')
}

/** 契约封套 + 错误封套的统一解析（成功只认 200，其余按错误码抛出）。 */
function send(method, path, options) {
  const b = binding()
  if (!b || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  const opts = options || {}
  const header = { authorization: 'Bearer ' + b.token, 'Cache-Control': 'no-cache' }
  if (opts.body !== undefined) header['content-type'] = 'application/json'
  if (opts.idempotencyKey !== undefined) header['Idempotency-Key'] = opts.idempotencyKey
  if (opts.ifMatch !== undefined) header['If-Match'] = '"' + opts.ifMatch + '"'
  return new Promise(function (resolve, reject) {
    const request = {
      url: runtime.apiBaseUrl + path, method: method, timeout: 15000, header: header,
      success: function (response) {
        if (!current(b)) { reject(failure('SESSION_CHANGED')); return }
        // 401/403 归因**只有一处事实源**：`auth.attribution`（D1 #396 统一层，码表由
        // `utils/states.js` 的 `CODE_KIND` 反推）。本模块不再自建 401/403 码表：
        //   401 ⇒ 归一 `SESSION_REQUIRED` + 清会话（走 guest）；
        //   403 ⇒ 契约三码原样带出（denied），`ACCOUNT_INACTIVE` 另按统一层口径清会话；
        //   403 但封套不可解析 ⇒ `SCOPE_DENIED`（不谎称「未登录」）。
        if (response.statusCode === 401 || response.statusCode === 403) {
          reject(auth.failureFor(failure, response.statusCode, response.data))
          return
        }
        let body = response.data
        try {
          keys(body, ['data', 'meta'])
          const meta = responseMeta(body.meta)
          if (response.statusCode === 200) {
            resolve({ data: body.data, mode: meta.execution_mode, status: response.statusCode })
            return
          }
          // 403 已在上面由 `auth.failureFor` 收口（此处不可能到达），不重复判定。
          reject(failure('UNEXPECTED_STATUS'))
        } catch (parseError) {
          // 错误封套：{ error: { code, message, retryable, details }, meta }
          try {
            keys(body, ['error', 'meta'])
            responseMeta(body.meta)
            keys(body.error, ['code', 'message', 'retryable', 'details'])
            if (typeof body.error.code !== 'string' || typeof body.error.message !== 'string' ||
              typeof body.error.retryable !== 'boolean' || !Array.isArray(body.error.details)) {
              throw failure('INVALID_RESPONSE')
            }
            const codes = body.error.details
              .filter(function (d) { return object(d) && typeof d.code === 'string' })
              .map(function (d) { return d.code })
            reject(failure(body.error.code, codes))
          } catch (ignored) {
            // 403 已在上面由 `auth.failureFor` 收口（此处不可能到达），不重复判定。
            reject(parseError && parseError.code ? parseError : failure('INVALID_RESPONSE'))
          }
        }
      },
      fail: function () { reject(failure(current(b) ? 'NETWORK_UNCERTAIN' : 'SESSION_CHANGED')) }
    }
    if (opts.body !== undefined) request.data = opts.body
    wx.request(request)
  })
}

/** 幂等键（契约要求 8..128 字符）。 */
function newIdempotencyKey() {
  return 'gyc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/**
 * 同一 `(id, revision)` 的**重试**必须复用同一个幂等键。
 *
 * 为什么：`PUT /messages/{id}/read` 的幂等语义由 `Idempotency-Key` + 请求摘要（摘要含 `If-Match`）
 * 共同决定（`services/api/src/messages/service.ts` 的 `withIdempotency`）。若每次调用都换新键：
 * 首发其实已落库、只是响应丢了（`NETWORK_UNCERTAIN`），重试带着**旧的** `If-Match` 再打一次
 * ⇒ 服务端 `revision` 已 +1 ⇒ 409 `REVISION_CONFLICT`。用户看到「消息状态已更新」，
 * 而事实是**这条已经标记成功**了。复用同键则走重放分支，重新读当前记录并重新鉴权，不产生第二次写入。
 *
 * 边界：只在**同一次成功之前**复用；成功即释放（下次仍是新键）；窗口 5 分钟
 * （与 `service.ts` 的 `IDEMPOTENCY_TTL_MS` 同量级），表容量上界 32 条，超界丢最旧。
 */
const RETRY_KEY_LIMIT = 32
const RETRY_KEY_TTL_MS = 5 * 60 * 1000
const retryKeys = []

function pruneRetryKeys(now) {
  while (retryKeys.length &&
    (retryKeys.length >= RETRY_KEY_LIMIT || now - retryKeys[0].at > RETRY_KEY_TTL_MS)) {
    retryKeys.shift()
  }
}

function retryKeyFor(id, revision) {
  const now = Date.now()
  pruneRetryKeys(now)
  const match = retryKeys.filter(function (entry) { return entry.id === id && entry.revision === revision })[0]
  if (match) return match.key
  const entry = { id: id, revision: revision, at: now, key: newIdempotencyKey() }
  retryKeys.push(entry)
  return entry.key
}

function forgetRetryKey(id, revision) {
  for (let i = retryKeys.length - 1; i >= 0; i -= 1) {
    if (retryKeys[i].id === id && retryKeys[i].revision === revision) retryKeys.splice(i, 1)
  }
}

/** `GET /messages`（契约只有 `cursor`/`limit` 两个查询参数，没有筛选）。 */
function listMessages(input) {
  const params = input || {}
  const q = query({ cursor: params.cursor, limit: params.limit })
  return send('GET', '/messages' + (q ? '?' + q : '')).then(function (r) {
    const data = page(r.data, params.limit)
    return { items: data.items, nextCursor: data.nextCursor, mode: r.mode }
  })
}

/** `GET /messages/unread-count`：派生量，每次现读；不在本地维护计数器。 */
function getUnreadCount() {
  return send('GET', '/messages/unread-count').then(function (r) {
    keys(r.data, ['count'])
    if (!Number.isSafeInteger(r.data.count) || r.data.count < 0) throw failure('INVALID_RESPONSE')
    return { count: r.data.count, mode: r.mode }
  })
}

/** `PUT /messages/{id}/read`：幂等且单调；`If-Match` 必须是**当前** revision。 */
function markMessageRead(id, revision) {
  if (!uuid(id) || !Number.isSafeInteger(revision) || revision < 1) return Promise.reject(failure('INVALID_INPUT'))
  const key = retryKeyFor(id, revision)
  return send('PUT', '/messages/' + encodeURIComponent(id) + '/read', {
    idempotencyKey: key, ifMatch: revision
  }).then(function (r) {
    // 成功即释放：资源版本已推进，下一次标记是**另一件事**（另一个 revision），必须是新键。
    forgetRetryKey(id, revision)
    return { message: validMessage(r.data), mode: r.mode }
  })
}

/** 角标文案：0 不显示；>99 显示 `99+`（避免角标撑破底部导航）。 */
function unreadText(count) {
  if (!Number.isSafeInteger(count) || count <= 0) return ''
  return count > 99 ? '99+' : String(count)
}

/**
 * 未读数刷新失败的结构化告警事件名（客户端诊断口径，非契约字段）。
 * 与 `#17` G6 配套：失败**不得**被渲染成「没有未读」，所以失败必须留下可检索的痕迹。
 */
const UNREAD_FAILURE_EVENT = 'messages.unread_count.fetch_failed'

/**
 * 记一条未读数失败告警（`#17` G6）。
 *
 * 只允许 `event` 与 `code` 两个键：告警会出现在用户日志里，
 * **不得**带会话令牌、手机号、消息正文或目标 id。`code` 取本模块统一错误码
 * （`PROVIDER_UNAVAILABLE` / `SESSION_REQUIRED` / `INVALID_RESPONSE` …），拿不到就 `UNKNOWN`。
 *
 * 去重由调用方负责（页面与 Tab 各自只在自己的刷新里报一次），本函数不维护状态。
 */
function warnUnreadFailure(error) {
  const entry = { event: UNREAD_FAILURE_EVENT, code: (error && error.code) || 'UNKNOWN' }
  if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
    console.warn(entry)
  }
}

function modeNote(mode) {
  if (mode === 'real') return '服务端真实模式；消息持久存储未接线时不会返回成功。'
  if (mode === 'preset_demo') return '预设演示数据，不代表真实消息。'
  if (mode === 'stub') return '替身服务数据，仅供联调，不代表真实消息投递。'
  return '消息需重新查询，失败时不会改用本地数据。'
}

/**
 * 服务端 real 模式下未接线真实消息存储 ⇒ 503 `PROVIDER_UNAVAILABLE`。
 * 页面据此显示**「服务未接线」类**提示，**不得**显示成「暂无消息」（空态与不可用必须可分辨）。
 */
function unwired(error) { return !!error && error.code === 'PROVIDER_UNAVAILABLE' }

/** 错误态标题：把「服务未接线」与其它失败、空态三者分开措辞（不新造第二套文案体系）。 */
function stateTitle(error) {
  return unwired(error) ? '消息服务未接线' : '消息没有取到'
}

const MESSAGES = {
  SESSION_REQUIRED: '登录状态已失效，请重新登录。',
  SESSION_CHANGED: '会话已变化，请重新进入消息页。',
  NETWORK_UNCERTAIN: '网络未能确认当前消息，已清空，请重试。',
  NOT_FOUND: '消息不存在或不属于当前账号。',
  REVISION_CONFLICT: '消息状态已更新，请刷新后重试。',
  REVISION_REQUIRED: '缺少版本信息，请刷新后重试。',
  IDEMPOTENCY_KEY_REQUIRED: '请求缺少幂等键，请重试。',
  IDEMPOTENCY_CONFLICT: '同一幂等键被复用于不同请求，请重试。',
  REQUEST_IN_PROGRESS: '同一次标记仍在处理，请稍后重试。',
  INVALID_CURSOR: '列表已过期，请重新进入消息页。',
  PROVIDER_UNAVAILABLE: '消息服务暂不可用（服务端未接线真实消息存储），本页不会用本地数据顶替。',
  // 403 三码文案（契约 `ERROR_STATUS_MAP[403]`；归因来自 `auth.attribution`，各域只提供措辞）：
  // 登录了但这件事不给 ⇒ denied 语气，不催人重新登录。
  SCOPE_DENIED: '当前会话无权访问消息。',
  CONSENT_REQUIRED: '缺少用途授权（403 CONSENT_REQUIRED）：未授权时不会执行该消息操作。',
  ACCOUNT_INACTIVE: '账号当前不可用（403 ACCOUNT_INACTIVE）：请重新登录后再试。',
  INVALID_RESPONSE: '服务端响应无法核对，已清空，请重试。',
  UNEXPECTED_STATUS: '服务端返回了未预期的状态，已清空，请重试。'
}
function message(error) {
  const code = error && error.code
  return MESSAGES[code] || '消息服务暂不可用，已清空，请重试。'
}

module.exports = {
  newIdempotencyKey: newIdempotencyKey,
  binding: binding,
  current: current,
  validId: uuid,
  messageTypes: MESSAGE_TYPES.slice(),
  referenceStates: REFERENCE_STATES.slice(),
  listMessages: listMessages,
  getUnreadCount: getUnreadCount,
  markMessageRead: markMessageRead,
  unreadText: unreadText,
  unreadFailureEvent: UNREAD_FAILURE_EVENT,
  warnUnreadFailure: warnUnreadFailure,
  unwired: unwired,
  stateTitle: stateTitle,
  modeNote: modeNote,
  message: message
}
