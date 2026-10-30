// GY-R70 · 用途授权客户端层（小程序侧）：**读清单 + 授予 + 撤回**，另加政策读面。
//
// 契约（packages/contracts/openapi.json 的 listConsents / grantConsent / withdrawConsent）：
//   listConsents    GET    /me/consents             → ConsentPageEnvelope（200）
//   grantConsent    POST   /me/consents             → ConsentEnvelope（201；Idempotency-Key 必填 8..128）
//   withdrawConsent DELETE /me/consents/{purpose}   → ConsentEnvelope（200；Idempotency-Key + If-Match 必填）
// 另加 `readPolicy` 读 `GET /me/privacy-policy`（PrivacyPolicyEnvelope）：`POST` 的请求体必须给
// `policy_version`，而契约**没有**"按用途读政策版本"的入口，只有这一个读面能给出真实版本
// （`version`）与"当前哪些用途有生效政策"（`purposes`）。客户端不从别处猜版本号。
//
// 纪律（与 utils/favorites-api.js 的写面同口径，本文件不自立一套）：
// 1. **服务端 `error.code` 原样透出**：`REVISION_REQUIRED`（428）、`REVISION_CONFLICT`（409）、
//    `NOT_FOUND`（404）、`CONSENT_REQUIRED`（403）、`OBJECT_UNAVAILABLE`（409）……一律不改写成
//    通用串。⛔ 把 428 与 409 糊成一句"失败"会让页面给出错的动作（428 要补版本、409 要重读）。
// 2. **幂等键由本层生成**（`newIdempotencyKey`）：同一次用户动作的所有重试必须复用同一个 key ——
//    服务端对同键同 body 回放首次结果，对同键不同 body 回 `409 IDEMPOTENCY_CONFLICT`。调用方要
//    重试就把**同一个 key 传回来**；本层绝不在同一次动作里另造一个 key（那样等于新开一次意图）。
// 3. **撤回先取当前 revision 再带 `If-Match`**；收到 **428 `REVISION_REQUIRED`** 时**补取一次**
//    再重试，上限 `WITHDRAW_REFETCH_LIMIT`（⛔ 无限重试：那是把服务端故障变成客户端死循环）。
// 3b. **撤回可以带 `guard`（确认仍然有效的判定）**：撤回是"GET 取 revision → DELETE（428 再补取
//    再 GET）"的多步链路，页面层的确认可能在链路中间过期（离页/切账号）。`guard()` 在**每一步
//    请求之前**被调用一次，返回假值才继续；返回 `{ code, text }` ⇒ 以 `CONFIRM_STALE` 直接丢弃，
//    **在发出任何 GET/DELETE 之前**停下。为什么把判定放进这一层：只在页面入口判一次的话，
//    428 补取那一步仍会用一个已过期的确认发出读取。
// 4. **不缓存、不回落假数据、不本地推断状态**：清单与政策读不到就如实抛错，由页面置灰并说明
//    原因；失败时绝不用旧列表或本地样例顶替（"没读到"与"没授权"是两件事）。
// 5. 只消费契约已声明的路径与字段：封套 `{data, meta}`、实体形状、闭集逐项核对，不符即
//    `INVALID_RESPONSE`（不"尽力解析"、不挑能认的字段凑一个列表出来）。
// 6. 身份只来自服务端签发的会话令牌；客户端不声明 userId / 角色。**401/403 归因不在本文件**：
//    一律委托 `utils/auth.js` 的 `attribution()` / `failureFor()`（单一事实源）。`CONSENT_REQUIRED`
//    按契约**原样透出**：本页正是"看自己授权到哪一步"的页面，把 403 折叠成"登录失效"会让人
//    反复重登却始终看不到原因。
//
// 未取得（如实标注）：微信编译器 / 真机未跑；本地 stub 下 `consent_policies` 没有可用行 ⇒
// 授予大概率回 `403 CONSENT_REQUIRED`，本片证的是"按契约调用 + 失败如实呈现"，不是"真机授予/
// 撤回链路已验"（见 docs/verification/gy-r70-consent-client-20261030.md）。
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
// 契约 `IdempotencyKey` 参数：minLength 8 / maxLength 128。**只有长度约束**，没有字符集约束
// （服务端 `routes/consents.ts` 的判定就是 `key.length < 8 || key.length > 128`，以代码为准）。
const IDEMPOTENCY_KEY_MIN = 8
const IDEMPOTENCY_KEY_MAX = 128
// 契约 `PrivacyPolicy` / `Recipient` 的全部字段（两者都是 `additionalProperties: false`）。
const POLICY_FIELDS = ['version', 'purposes', 'recipients', 'training_enabled']
const RECIPIENT_FIELDS = ['id', 'display_name', 'capability', 'policy_version', 'retention_online_days',
  'retention_backup_days', 'no_training_verified', 'deletion_verified']
// 契约 `Recipient.capability` 闭集（逐字取自 openapi.json）。
const RECIPIENT_CAPABILITIES = ['weed', 'ocr', 'asr', 'tts', 'llm', 'moderation']
// 服务端 `privacy/privacy-policy.ts` 的空态哨兵：语义是「尚无已发布政策」，**不是**真实版本号。
// 客户端据此判"此刻没有任何用途可授予"，而不是拿它去发 `POST`（服务端必回 403/409）。
const UNPUBLISHED_POLICY_VERSION = 'unpublished'
/**
 * 428 之后最多补取几次 revision 再重试。1 = 「补取一次」，不是"补到成功"。
 *
 * 为什么要有上限：428 是**服务端拒绝**（`routes/consents.ts:74` 在调服务前就抛），补取若也失败
 * （读面 503 / 网络断），再补只会把一次用户动作变成客户端重试风暴。
 */
const WITHDRAW_REFETCH_LIMIT = 1
/** 取当前 revision 时最多翻几页（每页 50 条；四用途闭集，正常 1 页就够，留着防游标异常）。 */
const REVISION_PAGE_LIMIT = 5

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
 * 契约封套 + 错误封套的统一解析（成功只认 `options.expect`，默认 200；其余按契约错误码抛出）。
 *
 * 顺序与 `favorites-api.js` 的 `request()` 一致：会话绑定 → 401/403 归因 → 成功封套 → 错误封套。
 * 写面比读面多三个头：`content-type`（有 body 时）、`Idempotency-Key`、`If-Match`。
 *
 * 错误对象上保留两件事实，页面按它们决定下一步（⛔ 不折叠成一个通用码）：
 *   - `error.code`：服务端 `error.code` 原样（`REVISION_REQUIRED` / `REVISION_CONFLICT` / …）；
 *   - `error.status`：实际 HTTP 状态；`error.retryable`：服务端声明的 `error.retryable`。
 */
function send(method, path, options) {
  const opts = options || {}
  const expect = Number.isSafeInteger(opts.expect) ? opts.expect : 200
  const b = binding()
  if (!b || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  const header = { authorization: 'Bearer ' + b.token, 'Cache-Control': 'no-cache' }
  if (opts.body !== undefined) header['content-type'] = 'application/json'
  if (opts.idempotencyKey) header['Idempotency-Key'] = opts.idempotencyKey
  if (opts.ifMatch) header['If-Match'] = opts.ifMatch
  return new Promise(function (resolve, reject) {
    const request = {
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
          if (response.statusCode === expect) {
            const etag = response.header && typeof response.header.ETag === 'string' ? response.header.ETag : null
            resolve({ data: body.data, mode: meta.execution_mode, status: response.statusCode, etag: etag })
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
            // 码**原样**抛出：页面据此区分"没登录 / 没授权 / 版本不符 / 服务不可用"，不在这里改写。
            const error = failure(body.error.code, codes)
            error.status = response.statusCode
            error.retryable = body.error.retryable === true
            reject(error)
          } catch (ignored) {
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
    recipientCount: item.recipient_ids.length,
    // 写面要用到的两个版本：`revision` 是 `If-Match` 的取值来源，`epoch` 是"旧凭据随之失效"的
    // 计数器。两者都**原样**透出，页面不自己算、也不缓存成"应该是最新的"。
    revision: item.revision,
    epoch: item.epoch
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

// ---------------------------------------------------------------------------
// 用途政策读面（`GET /me/privacy-policy`）
// ---------------------------------------------------------------------------
function validRecipient(item) {
  keys(item, RECIPIENT_FIELDS)
  if (!text(item.id, 80) || !text(item.display_name, 200) || !one(item.capability, RECIPIENT_CAPABILITIES) ||
    !text(item.policy_version, 80) ||
    !Number.isSafeInteger(item.retention_online_days) || item.retention_online_days < 0 || item.retention_online_days > 7 ||
    !Number.isSafeInteger(item.retention_backup_days) || item.retention_backup_days < 0 || item.retention_backup_days > 30 ||
    typeof item.no_training_verified !== 'boolean' || typeof item.deletion_verified !== 'boolean') {
    throw failure('INVALID_RESPONSE')
  }
  return item
}

/** 契约 `PrivacyPolicy` 的逐字段核对（用途不重复、版本长度、`training_enabled` 恒 false）。 */
function policyView(data) {
  keys(data, POLICY_FIELDS)
  if (!text(data.version, 80) || !Array.isArray(data.purposes) || data.purposes.length > 4 ||
    !Array.isArray(data.recipients) || data.recipients.length > 30 || data.training_enabled !== false) {
    throw failure('INVALID_RESPONSE')
  }
  const seen = {}
  data.purposes.forEach(function (purpose) {
    if (!one(purpose, CONSENT_PURPOSES) || Object.prototype.hasOwnProperty.call(seen, purpose)) {
      throw failure('INVALID_RESPONSE')
    }
    seen[purpose] = true
  })
  data.recipients.forEach(validRecipient)
  return {
    version: data.version,
    // 空态哨兵不是版本号：`published === false` 表示"服务端尚无已发布政策"，不是"版本是 unpublished"。
    published: data.version !== UNPUBLISHED_POLICY_VERSION,
    purposes: data.purposes.slice(),
    recipients: data.recipients.slice(),
    trainingEnabled: data.training_enabled
  }
}

/**
 * 读取用途政策（`GET /me/privacy-policy`）。授予体里的 `policy_version` 只能从这里来。
 *
 * 为什么本层需要它：契约没有"按用途读政策版本"的入口，若客户端自己编一个版本号去 `POST`，
 * 服务端会回 `409 REVISION_CONFLICT`（`privacy/grant-pg.ts` 的逐字比对）——那是把"没读"说成"版本冲突"。
 * 读面 503 时（`real` 模式未接 PG）如实抛 `PROVIDER_UNAVAILABLE`，页面据此把所有开关置灰。
 */
function readPolicy() {
  return send('GET', '/me/privacy-policy').then(function (r) {
    return { policy: policyView(r.data), mode: r.mode }
  })
}

/**
 * 某用途此刻能否**授予**：只看政策读面能证明的事，不做推测。
 *
 * - 政策没读到 ⇒ 不可授予（页面把"没读到"如实说成"没读到"，不说成"没有政策"）；
 * - `unpublished`（服务端尚无已发布政策）⇒ 全部不可授予；
 * - `purposes` 不含该用途 ⇒ 不可授予；
 * - `external_inference` ⇒ 单独不可授予：`POST` 强制"至少一个已核验接收方"
 *   （服务端 `grant-pg.ts` 对空 `recipient_ids` 直接 403），而政策读面露出的 `recipients[]` 是**披露面**
 *   （比授权面宽），拿它当授权面的接收方会是"替用户挑第三方"——本页不做这个决定。
 */
function grantAvailability(policy, purpose) {
  if (!policy) {
    return { grantable: false, reason: '用途政策尚未读取成功，无法判断该用途此刻能否授予；请先「重新读取」。' }
  }
  if (!policy.published) {
    return { grantable: false, reason: '服务端尚无已发布的用途政策（政策读面 version 为 unpublished）：此刻没有任何用途可以授予。' }
  }
  if (policy.purposes.indexOf(purpose) === -1) {
    return { grantable: false, reason: '服务端当前没有该用途的可用政策（政策读面的 purposes 未包含它），因此不能授予。' }
  }
  if (purpose === 'external_inference') {
    return {
      grantable: false,
      reason: '对外推理必须至少绑定一个已核验接收方；政策读面的 recipients 是披露面（比授权面宽），本页不替你挑接收方，因此这里不给授予。'
    }
  }
  return { grantable: true, reason: '' }
}

// ---------------------------------------------------------------------------
// 写面：授予 / 撤回
// ---------------------------------------------------------------------------

/**
 * 生成一个 `Idempotency-Key`。**同一次用户动作的所有重试必须复用同一个 key**：
 * 服务端把 key 哈希进 `idempotency_keys`，同键同 body ⇒ 回放首次结果；同键不同 body ⇒
 * `409 IDEMPOTENCY_CONFLICT`。所以"每次重试换新 key"不是幂等，而是把一次动作变成多次意图。
 *
 * 长度落在契约 `IdempotencyKey` 的 8..128 内（`consent-` + 36 进制时间戳 + 8 位随机 ≈ 30 字符）。
 */
function newIdempotencyKey(prefix) {
  const head = typeof prefix === 'string' && prefix.length > 0 ? prefix : 'consent'
  return head + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

/** 调用方给的 key 必须自洽（长度 8..128）；给了不合规的 key 就**报错**，不悄悄换一个（换 key = 换意图）。 */
function keyOf(value, prefix) {
  if (value === undefined || value === null) return newIdempotencyKey(prefix)
  if (typeof value !== 'string' || value.length < IDEMPOTENCY_KEY_MIN || value.length > IDEMPOTENCY_KEY_MAX) {
    throw failure('INVALID_INPUT')
  }
  return value
}

/**
 * 授予某用途（`POST /me/consents`，成功 201）。
 *
 * `input`：`{ purpose, policyVersion, recipientIds?, idempotencyKey? }`
 *   - `recipientIds` 缺省 `[]`：录制/媒体处理/公开发布三类不需要第三方接收方，**空数组是如实的最小值**
 *     （替用户填接收方等于替他决定把数据交给谁）；
 *   - `idempotencyKey` 缺省由本层生成一次；重试请把**同一个** key 传回来。
 */
function grant(input) {
  const req = input || {}
  if (!one(req.purpose, CONSENT_PURPOSES)) return Promise.reject(failure('INVALID_INPUT'))
  if (!text(req.policyVersion, 80)) return Promise.reject(failure('INVALID_INPUT'))
  const recipients = req.recipientIds === undefined ? [] : req.recipientIds
  if (!Array.isArray(recipients) || recipients.length > 30) return Promise.reject(failure('INVALID_INPUT'))
  const seen = {}
  try {
    recipients.forEach(function (id) {
      if (!text(id, 80) || Object.prototype.hasOwnProperty.call(seen, id)) throw failure('INVALID_INPUT')
      seen[id] = true
    })
  } catch (error) { return Promise.reject(error) }
  let key
  try { key = keyOf(req.idempotencyKey, 'consent-grant') } catch (error) { return Promise.reject(error) }
  const body = { purpose: req.purpose, policy_version: req.policyVersion, recipient_ids: recipients.slice() }
  return send('POST', '/me/consents', { body: body, idempotencyKey: key, expect: 201 }).then(function (r) {
    return { consent: validConsent(r.data), revision: r.data.revision, mode: r.mode, status: r.status, idempotencyKey: key }
  })
}

/** 从清单里找某用途**当前**记录（服务端只返回 `current_epoch>0` 的记录，撤回后仍在）。 */
function currentRecordOf(purpose) {
  let cursor = ''
  let pages = 0
  function step() {
    return listConsents({ cursor: cursor, limit: LIMIT_MAX }).then(function (result) {
      const hit = result.items.filter(function (item) { return item.purpose === purpose })[0]
      if (hit) return hit
      pages += 1
      if (!result.nextCursor || pages >= REVISION_PAGE_LIMIT) return null
      cursor = result.nextCursor
      return step()
    })
  }
  return step()
}

/**
 * 撤回某用途（`DELETE /me/consents/{purpose}`，成功 200）。
 *
 * 流程：**先取当前 revision**（`GET /me/consents`）→ 带 `If-Match: "<revision>"` 发 `DELETE`。
 * 收到 **428 `REVISION_REQUIRED`** ⇒ 补取一次 revision 再重试（上限 `WITHDRAW_REFETCH_LIMIT`）；
 * 补取也失败 ⇒ 把补取自己的错**原样**抛出（附 `refetchFailedAfter` 记录原始 428），⛔ 不再重试。
 *
 * 为什么 428 在本客户端是**防御性**分支（如实登记）：本层始终带 `If-Match`，而 428 只由服务端在
 * `if-match` **缺失**时抛出（`routes/consents.ts` 在调服务前判定）⇒ 正常路径不该出现。它的价值是
 * "服务端换了口径/代理吞了头"时不至于把一次可解释的拒绝说成"失败"。
 * 也正因为 428 发生在服务层之前，补取后**复用同一个 key** 是安全的（服务端没有为该 key 写过
 * request_hash；若写过，同键不同 If-Match 会是 409 IDEMPOTENCY_CONFLICT，而我们不会走到那里）。
 *
 * `guard`（可选，`() => '' | { code, text }`）：调用方给"这次撤回的确认此刻是否还有效"的判定。
 * 本层在**入口**以及**每次要发请求之前**（含 428 补取）调它；判定不成立 ⇒ `CONFIRM_STALE`，
 * 带着调用方给的原因原样上抛，**一条请求都不发**。本层不解释"为什么过期"（那是页面知道的：
 * 可见周期、会话身份），只保证"过期就不发"。
 */
function withdraw(input) {
  const req = input || {}
  if (!one(req.purpose, CONSENT_PURPOSES)) return Promise.reject(failure('INVALID_INPUT'))
  let key
  try { key = keyOf(req.idempotencyKey, 'consent-withdraw') } catch (error) { return Promise.reject(error) }
  const guard = typeof req.guard === 'function' ? req.guard : null
  let refetches = 0

  /** 每一步请求之前都问一次；不成立就抛 `CONFIRM_STALE`（附调用方给的原因）。 */
  function checkGuard() {
    if (!guard) return
    const verdict = guard()
    if (!verdict) return
    const error = failure('CONFIRM_STALE')
    error.reason = verdict
    throw error
  }

  function attempt(revision) {
    try { checkGuard() } catch (error) { return Promise.reject(error) }
    return send('DELETE', '/me/consents/' + encodeURIComponent(req.purpose), {
      ifMatch: '"' + revision + '"', idempotencyKey: key, expect: 200
    }).then(function (r) {
      return {
        consent: validConsent(r.data), revision: r.data.revision, mode: r.mode,
        status: r.status, idempotencyKey: key, refetches: refetches
      }
    }).catch(function (error) {
      // ⛔ 只对 428 补取，且只补 WITHDRAW_REFETCH_LIMIT 次；409/404/403 一律原样上抛给页面。
      if (!error || error.code !== 'REVISION_REQUIRED' || refetches >= WITHDRAW_REFETCH_LIMIT) throw error
      refetches += 1
      // 补取本身也是一次 GET：确认在这期间过期的话，连这条读取都不许发。
      checkGuard()
      return currentRecordOf(req.purpose).then(function (fresh) {
        // 补取到了但服务端仍说"没有该用途的当前记录"：原始 428 才是这次动作的真实结论。
        if (!fresh) throw error
        return attempt(fresh.revision)
      }, function (refetchError) {
        // 补取失败：如实报**它自己的**码（不折叠成通用串），并留下原始 428 的证据。
        if (refetchError && typeof refetchError === 'object') refetchError.refetchFailedAfter = error.code
        throw refetchError
      })
    })
  }

  // 入口就判：过期确认连"取 revision"的那条 GET 都不发。
  try { checkGuard() } catch (error) { return Promise.reject(error) }

  return currentRecordOf(req.purpose).then(function (record) {
    // 清单里没有该用途的当前记录 ⇒ 不发 DELETE（服务端会回 404，但那是"发了一次注定失败的请求"）。
    // `NOT_GRANTED` 是**客户端前置码**，语义明确：没有当前授权记录，所以没有"撤回"这件事。
    if (!record) throw failure('NOT_GRANTED')
    return attempt(record.revision)
  })
}

// ---------------------------------------------------------------------------
// 写面文案与"该不该置灰"
// ---------------------------------------------------------------------------

/**
 * 写面文案。**按端点分开**：`403 CONSENT_REQUIRED` 在两条写面上的含义不同 ——
 * 授予面是"没有可用的已核验用途政策"，撤回面是"该用途当前没有授权"，不能共用一句。
 */
const GRANT_MESSAGES = {
  CONSENT_REQUIRED: '授予被拒绝（403 CONSENT_REQUIRED）：服务端没有可用的已核验用途政策。未改变任何授权状态。',
  REVISION_CONFLICT: '用途政策版本已变化（409 REVISION_CONFLICT）：服务端当前政策版本与本页读到的不一致，请「重新读取」后按最新版本再试。',
  IDEMPOTENCY_CONFLICT: '同一幂等键被复用于不同请求（409 IDEMPOTENCY_CONFLICT）：这次动作与之前那次不一致，请重新读取后重试。',
  IDEMPOTENCY_KEY_REQUIRED: '请求缺少合法幂等键（400 IDEMPOTENCY_KEY_REQUIRED）：请重试。',
  OBJECT_UNAVAILABLE: '已有资料或任务依赖，授权变更消费者不可用（409 OBJECT_UNAVAILABLE）：服务端拒绝做只改一半的变更。',
  INVALID_REQUEST: '授权输入不合法（400 INVALID_REQUEST）：本页没有按契约提交，未改变任何状态。',
  PROVIDER_UNAVAILABLE: '授权服务暂不可用（503 PROVIDER_UNAVAILABLE）：服务端未接存储或数据不可用，未改变任何状态。',
  PROVIDER_TIMEOUT: '授权服务超时（504 PROVIDER_TIMEOUT）：结果未知，请「重新读取」核对后再操作。',
  NETWORK_UNCERTAIN: '网络未能确认这次授予是否生效：请「重新读取」核对，不会在本地假装已授权。',
  INVALID_INPUT: '本页要提交的参数不合法（客户端自检）：未发出请求，也未改变任何状态。',
  INVALID_RESPONSE: '服务端响应无法核对：未改变任何状态，请重试。',
  SESSION_REQUIRED: '登录状态已失效，请重新登录后再操作。',
  SESSION_CHANGED: '会话已变化，请重新进入授权清单。',
  SCOPE_DENIED: '当前会话无权修改用途授权（403 SCOPE_DENIED）：当前是用户会话才可能被允许。',
  ACCOUNT_INACTIVE: '账号当前不可用（403 ACCOUNT_INACTIVE）：请重新登录后再试。'
}
const WITHDRAW_MESSAGES = {
  REVISION_REQUIRED: '服务端要求授权版本（428 REVISION_REQUIRED）：已自动补取一次仍未成功，未改变任何状态。',
  CONFIRM_STALE: '这次撤回的确认已经过期（发起之后页面可见周期或账号变了）：已在发出任何读取或撤回请求之前丢弃，未改变任何状态。',
  REVISION_CONFLICT: '授权版本已变化（409 REVISION_CONFLICT）：请「重新读取」后按最新状态再撤回。',
  NOT_FOUND: '服务端没有该用途的当前授权记录（404 NOT_FOUND）：可能已撤回或从未授予，未改变任何状态。',
  NOT_GRANTED: '服务端清单里没有该用途的当前授权记录：没有发出撤回请求，也未改变任何状态。',
  OBJECT_UNAVAILABLE: '已有资料或任务依赖，撤回消费者不可用（409 OBJECT_UNAVAILABLE）：服务端拒绝做只撤一半的部分撤回。',
  IDEMPOTENCY_CONFLICT: '同一幂等键被复用于不同请求（409 IDEMPOTENCY_CONFLICT）：请重新读取后重试。',
  IDEMPOTENCY_KEY_REQUIRED: '请求缺少合法幂等键（400 IDEMPOTENCY_KEY_REQUIRED）：请重试。',
  INVALID_REQUEST: '撤回输入不合法（400 INVALID_REQUEST）：未改变任何状态。',
  PROVIDER_UNAVAILABLE: '授权服务暂不可用（503 PROVIDER_UNAVAILABLE）：未改变任何状态。',
  PROVIDER_TIMEOUT: '授权服务超时（504 PROVIDER_TIMEOUT）：结果未知，请「重新读取」核对。',
  NETWORK_UNCERTAIN: '网络未能确认撤回是否生效：请「重新读取」核对，不会在本地假装已撤回。',
  INVALID_INPUT: '本页要提交的参数不合法（客户端自检）：未发出请求，也未改变任何状态。',
  INVALID_RESPONSE: '服务端响应无法核对：未改变任何状态，请重试。',
  SESSION_REQUIRED: '登录状态已失效，请重新登录后再操作。',
  SESSION_CHANGED: '会话已变化，请重新进入授权清单。',
  SCOPE_DENIED: '当前会话无权修改用途授权（403 SCOPE_DENIED）：当前是用户会话才可能被允许。',
  ACCOUNT_INACTIVE: '账号当前不可用（403 ACCOUNT_INACTIVE）：请重新登录后再试。'
}

/** `action` ∈ `'grant' | 'withdraw'`；未知码给出"带原码"的兜底，不折叠成"操作失败"。 */
function actionMessage(error, action) {
  const code = error && error.code
  const table = action === 'withdraw' ? WITHDRAW_MESSAGES : GRANT_MESSAGES
  if (code && Object.prototype.hasOwnProperty.call(table, code)) return table[code]
  return '这次' + (action === 'withdraw' ? '撤回' : '授予') + '没有完成（服务端码 ' +
    (code || '未知') + '）：未在本地改变任何状态，请「重新读取」核对后重试。'
}

/**
 * 该不该把这行的动作按钮**置灰**：只有"服务端那边这件事做不成"的码才算（政策缺失 / 服务未接线 /
 * 依赖消费者未接线 / 记录不存在）。`REVISION_CONFLICT`、`IDEMPOTENCY_*`、网络类不算 ——
 * 那些是"再读一次就能重试"的情形，置灰会把可恢复的失败说成永久不可用。
 */
const GRANT_BLOCKING_CODES = ['CONSENT_REQUIRED', 'OBJECT_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT']
const WITHDRAW_BLOCKING_CODES = ['OBJECT_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'NOT_FOUND', 'NOT_GRANTED']

function blockingReason(error, action) {
  const code = error && error.code
  if (!code) return ''
  const set = action === 'withdraw' ? WITHDRAW_BLOCKING_CODES : GRANT_BLOCKING_CODES
  if (set.indexOf(code) === -1) return ''
  return actionMessage(error, action)
}

module.exports = {
  CONSENT_PURPOSES: CONSENT_PURPOSES,
  PURPOSE_LABELS: PURPOSE_LABELS,
  IDEMPOTENCY_KEY_MIN: IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX: IDEMPOTENCY_KEY_MAX,
  WITHDRAW_REFETCH_LIMIT: WITHDRAW_REFETCH_LIMIT,
  listConsents: listConsents,
  readPolicy: readPolicy,
  grant: grant,
  withdraw: withdraw,
  newIdempotencyKey: newIdempotencyKey,
  grantAvailability: grantAvailability,
  consentView: consentView,
  reasonCodes: reasonCodes,
  sessionFailure: sessionFailure,
  forbidden: forbidden,
  modeNote: modeNote,
  message: message,
  actionMessage: actionMessage,
  blockingReason: blockingReason
}