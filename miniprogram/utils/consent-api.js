// GY-R34（#29 P1 前端腿）· 授权清单读取层（小程序侧，**只读**）。
//
// 纪律（与 utils/community-api.js 同口径，本片不另立一套）：
// 1. **只读**：本片只实现契约里的 `GET /me/consents`。授予 / 撤回（`POST`、`DELETE /me/consents`，
//    需要 `policy_version`、`recipient_ids`、`If-Match`、`Idempotency-Key`）属于 P2，
//    这里不写任何写接口，也不留半成品占位——半个写路径比没有更危险。
// 2. **不缓存、不回落假数据**：不写本地缓存，失败时不用旧列表或本地样例顶替；一律如实抛错误码，
//    由页面收口到 `components/state-view`。
// 3. 只消费契约已声明的路径与字段：封套 `{data, meta}`、实体形状、闭集逐项核对，不符即
//    `INVALID_RESPONSE`（不"尽力解析"、不挑能认的字段凑一个列表出来）。
// 4. 身份只来自服务端签发的会话令牌；客户端不声明 userId / 角色。
// 5. **401/403 归因不在本文件**：一律委托 `utils/auth.js` 的 `attribution()` / `failureFor()`
//    （单一事实源，码表由 `utils/states.js` 的 `CODE_KIND` 反推）。本文件只保留本域措辞与两个
//    委托判定 `sessionFailure()` / `forbidden()`。`CONSENT_REQUIRED` 按契约**原样透出**：本页正是
//    "看自己授权到哪一步"的页面，把 403 折叠成"登录失效"会让人反复重登却始终看不到原因。
//
// 未取得（如实标注）：微信编译器 / 真机未跑；服务端 `real` 模式下未接 PG 时该域回
// `503 PROVIDER_UNAVAILABLE`，页面照实显示"服务暂不可用"，绝不显示本地伪造的授权记录。
const auth = require('./auth')
const runtime = require('../config/runtime')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// 用途闭集：逐字取自契约 `ConsentPurpose`（packages/contracts/openapi.json）与服务端
// `CONSENT_PURPOSES`（services/api/src/privacy/consent-pg.ts）。客户端只核对"码在闭集内"。
const CONSENT_PURPOSES = ['recording', 'media_processing', 'external_inference', 'public_posting']
// 状态闭集（契约 `Consent.state`：授予后一直保留记录，撤回只是状态变化）。
const CONSENT_STATES = ['granted', 'withdrawn']
// 契约 `Consent` 的全部字段（`additionalProperties: false` ⇒ 多一个键也算不符）。
const CONSENT_FIELDS = ['id', 'purpose', 'policy_version', 'recipient_ids', 'state', 'epoch', 'revision',
  'granted_at', 'withdrawn_at']
const LIMIT_MAX = 50

/**
 * 用途码 → 可读短名。
 *
 * **只做枚举到短名的机械映射**：不写政策正文、不解释某项授权覆盖哪些数据、不写"已同意最新版"这类
 * 服务端没说过的判断（那些内容属于 P2 的政策页与文案，不属于读取层）。闭集外的值原样显示码，不编名字。
 */
const PURPOSE_LABELS = {
  recording: '录音',
  media_processing: '媒体处理',
  external_inference: '外部推理',
  public_posting: '公开发布'
}
const STATE_LABELS = { granted: '已授权', withdrawn: '已撤回' }

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

/**
 * 单条授权记录的契约核对（与服务端 `consent-pg.ts` 的 `dto()` 同一组判定）：
 * - `granted` ⇒ `withdrawn_at` **必须**是 null；`withdrawn` ⇒ 必须是可解析时间。
 *   这两条不是本模块加的规矩，是服务端自己的一致性条件；宽一格就会把"状态与时间打架"的记录
 *   渲染成一张看不出问题的卡片。
 * - `recipient_ids`：≤30、不重复、每项 1..80。
 */
function validConsent(item) {
  keys(item, CONSENT_FIELDS)
  if (!uuid(item.id) || !one(item.purpose, CONSENT_PURPOSES) || !text(item.policy_version, 80) ||
    !Array.isArray(item.recipient_ids) || item.recipient_ids.length > 30 ||
    !one(item.state, CONSENT_STATES) || !Number.isSafeInteger(item.epoch) || item.epoch < 1 ||
    !Number.isSafeInteger(item.revision) || item.revision < 1 || !timestamp(item.granted_at) ||
    (item.state === 'granted' ? item.withdrawn_at !== null : !timestamp(item.withdrawn_at))) {
    throw failure('INVALID_RESPONSE')
  }
  const seen = {}
  item.recipient_ids.forEach(function (id) {
    if (!text(id, 80) || Object.prototype.hasOwnProperty.call(seen, id)) throw failure('INVALID_RESPONSE')
    seen[id] = true
  })
  return item
}

/** 分页载体的契约核对（`ConsentPage`：items ≤50、next_cursor 可空串不超过 2048、id 不重复）。 */
function page(data, limit) {
  keys(data, ['items', 'next_cursor'])
  const cap = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : 20, LIMIT_MAX)
  if (!Array.isArray(data.items) || data.items.length > cap ||
    !(data.next_cursor === null || text(data.next_cursor, 2048))) throw failure('INVALID_RESPONSE')
  const seen = []
  data.items.forEach(function (item) {
    validConsent(item)
    if (seen.indexOf(item.id) !== -1) throw failure('INVALID_RESPONSE')
    seen.push(item.id)
  })
  return { items: data.items, nextCursor: data.next_cursor }
}

/** 查询串：键排序后拼接；空值（undefined / null / 空串）不出现——空 cursor 会被服务端判成非法游标。 */
function query(params) {
  return Object.keys(params)
    .filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== '' })
    .sort()
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]) })
    .join('&')
}

/**
 * 契约封套 + 错误封套的统一解析（成功只认 200，其余按契约错误码抛出）。
 * 与 `community-api.js` 的 `send()` 同一套顺序：会话绑定 → 401/403 归因 → 成功封套 → 错误封套。
 */
function send(method, path) {
  const b = binding()
  if (!b || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  const header = { authorization: 'Bearer ' + b.token, 'Cache-Control': 'no-cache' }
  return new Promise(function (resolve, reject) {
    wx.request({
      url: runtime.apiBaseUrl + path,
      method: method,
      timeout: 15000,
      header: header,
      success: function (response) {
        if (!current(b)) { reject(failure('SESSION_CHANGED')); return }
        if (response.statusCode === 401 || response.statusCode === 403) {
          // 归因只有一处实现：401 → SESSION_REQUIRED（并清会话）；403 → 闭集码原样
          // （CONSENT_REQUIRED / SCOPE_DENIED / ACCOUNT_INACTIVE），具体动作交给页面。
          reject(auth.failureFor(failure, response.statusCode, response.data))
          return
        }
        const body = response.data
        try {
          keys(body, ['data', 'meta'])
          const meta = responseMeta(body.meta)
          if (response.statusCode === 200) {
            resolve({ data: body.data, mode: meta.execution_mode, status: response.statusCode })
            return
          }
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
            // 码**原样**抛出：页面据此区分"没登录 / 没授权 / 服务不可用"，不在这里改写成别的码。
            reject(failure(body.error.code, codes))
          } catch (ignored) {
            reject(parseError && parseError.code ? parseError : failure('INVALID_RESPONSE'))
          }
        }
      },
      fail: function () { reject(failure(current(b) ? 'NETWORK_UNCERTAIN' : 'SESSION_CHANGED')) }
    })
  })
}

/**
 * 读取当前用户的授权清单（`GET /me/consents`，只读）。
 *
 * `input` 只接受契约声明的两个查询参数：`cursor`（服务端签名的分页游标）与 `limit`（1..50）。
 * 返回 `{ items, nextCursor, mode }`；`items` 是**原样**的契约 DTO（不做本地合并、不去重排序）。
 * 空列表就是空列表（服务端确实 0 条），失败一律 reject —— 调用方不得把 reject 渲染成空列表。
 */
function listConsents(input) {
  const params = input || {}
  const q = query({ cursor: params.cursor, limit: params.limit })
  return send('GET', '/me/consents' + (q ? '?' + q : '')).then(function (r) {
    const p = page(r.data, params.limit)
    return { items: p.items, nextCursor: p.nextCursor, mode: r.mode }
  })
}

/**
 * 行视图：把契约 DTO 摊平成模板能直接用的字段，**不做判断**。
 *
 * - `purposeLabel`：枚举短名（见 `PURPOSE_LABELS`）；闭集外的值退回原码，不编名字。
 * - `changedAt`：契约**没有** `updated_at`。这里取"最后一次状态变化的时间"——已撤回取
 *   `withdrawn_at`，已授权取 `granted_at`；页面按"最近更新"如实标注，不改叫"更新时间"以外的含义。
 * - `policyVersion`：原样透出服务端记录的 `policy_version`，不判断它是否最新版、不比较大小。
 */
function consentView(item) {
  return {
    id: item.id,
    purpose: item.purpose,
    purposeLabel: PURPOSE_LABELS[item.purpose] || item.purpose,
    state: item.state,
    stateLabel: STATE_LABELS[item.state] || item.state,
    policyVersion: item.policy_version,
    grantedAt: item.granted_at,
    withdrawnAt: item.withdrawn_at,
    changedAt: item.state === 'withdrawn' ? item.withdrawn_at : item.granted_at,
    recipientCount: item.recipient_ids.length
  }
}

/** 审核未通过时服务端回传的规则层原因码（与 community-api 同名同义，供页面如实展示）。 */
function reasonCodes(error) {
  return error && Array.isArray(error.details) ? error.details.slice(0, 6) : []
}

/**
 * 页面收口用的两个**委托**判定（本文件不自持码表，闭集来自 `utils/auth.js`）：
 * - `sessionFailure(error)`：会话没建立 / 已失效（含客户端自造码 `SESSION_CHANGED`）⇒ 回登录门禁。
 * - `forbidden(error)`：契约 403 闭集（`SCOPE_DENIED` / `CONSENT_REQUIRED` / `ACCOUNT_INACTIVE`）
 *   ⇒ 页面按"登录了但不给"呈现，不说成"登录过期"。
 */
function sessionFailure(error) {
  return !!error && auth.isSessionLossCode(error.code)
}
function forbidden(error) {
  return !!error && auth.isForbiddenCode(error.code)
}

function modeNote(mode) {
  if (mode === 'real') return ''
  if (mode === 'preset_demo') return '预设演示模式的授权记录，不代表真实授权状态。'
  if (mode === 'stub') return '替身服务返回的授权记录，仅供联调，不代表真实授权状态。'
  return '授权清单需重新读取，失败时不会改用本地数据。'
}

const MESSAGES = {
  SESSION_REQUIRED: '登录状态已失效，请重新登录。',
  SESSION_CHANGED: '会话已变化，请重新进入授权清单。',
  NETWORK_UNCERTAIN: '网络未能确认授权清单，已清空，请重试。',
  PROVIDER_UNAVAILABLE: '授权数据暂不可用（服务端未接存储），请稍后再试。',
  INVALID_CURSOR: '授权列表已过期（授权记录已变化），请重新进入本页。',
  SCOPE_DENIED: '当前会话无权读取授权清单。',
  CONSENT_REQUIRED: '缺少用途授权（403 CONSENT_REQUIRED）：服务端拒绝了这次读取，未展示任何记录。',
  ACCOUNT_INACTIVE: '账号当前不可用（403 ACCOUNT_INACTIVE）：请重新登录后再试。',
  INVALID_RESPONSE: '服务端响应无法核对，已清空，请重试。',
  UNEXPECTED_STATUS: '服务端返回了未预期的状态，已清空，请重试。'
}
function message(error) {
  const code = error && error.code
  return MESSAGES[code] || '授权清单暂时读不到，已清空，请重试。'
}

module.exports = {
  CONSENT_PURPOSES: CONSENT_PURPOSES,
  PURPOSE_LABELS: PURPOSE_LABELS,
  listConsents: listConsents,
  consentView: consentView,
  reasonCodes: reasonCodes,
  sessionFailure: sessionFailure,
  forbidden: forbidden,
  modeNote: modeNote,
  message: message
}