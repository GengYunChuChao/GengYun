// 会话与游客门禁（GY-I04）。
//
// 边界（与 shared source 的联网约束一致）：共享源码的 runtime.mode 为 'disabled'，
// 网络未启用时 login() 明确失败，**不伪造登录成功、不写入假令牌**。
// 本地调试/正式环境由 tools/prepare-wechat.mjs 生成 mode:'local' 的忽略副本后启用网络。
//
// 安全：
// - 不在此处保存任何微信凭据；只保存服务端签发的不透明会话令牌。
// - 身份（openid/角色/用户 id）由服务端从 code 换取，客户端不声明。
// - **读取一个本地缓存对象不构成认证**：会话状态须经 GET /auth/session 核实；
//   缓存只做「形状 / 受众 / 时效 / 演示标记」的本地预检，不合格即清理并回登录页。

const runtime = require('../config/runtime')
const navigation = require('./navigation')
const states = require('./states')

const SESSION_KEY = 'gengyun.session'
// 小程序只接受用户受众；后台受众（admin）令牌不得出现在小程序会话缓存里。
const USER_AUDIENCE = 'user'
// 契约 ExecutionMode：缓存里的演示标记必须是已知取值，不接受伪造标记。
const KNOWN_EXECUTION_MODES = ['real', 'stub', 'preset_demo']

// 经服务端核实的状态：仅当 login() 或 verifySession() 收到服务端成功响应后才置位。
// 进程启动时为 false —— 因此单靠一个本地缓存对象永远不等于已登录。
let serverVerified = false

// 会话世代：每次「清会话」或「切换/建立新令牌」时递增。
// 在途的 verifySession / login / logout 请求以发起时的世代绑定：迟到回调不得复活
// 已清除的会话、不得清掉更新的登录。
let generation = 0

// 用户意图世代（登录 ↔ 退出的**共享**单调序号）：任何一次 login()/logout() 在**发起点**
// 都推进它，并各自捕获本操作的世代。回调落地前若该世代已被更晚的意图推进，则整个操作
// 过期（丢弃响应，不改变登录态）。这样「较新的退出意图」在**发起时**即淘汰更早的在途登录，
// 最终登录态**不依赖两个响应到达的先后**。
let intentEpoch = 0

function networkEnabled() {
  return runtime.mode === 'local' && typeof runtime.apiBaseUrl === 'string' && runtime.apiBaseUrl !== ''
}

function isFutureIso(value) {
  if (typeof value !== 'string' || value === '') return false
  const ms = Date.parse(value)
  return Number.isFinite(ms) && ms > Date.now()
}

/**
 * 401/403 归因：会话层与各适配层共用的**单一事实源**（GY-I04 登录链路盘点）。
 *
 * 为什么需要：401 与 403 是两件不同的事——401 是「还没登录 / 登录过期」，403 是
 * 「登录了，但这件事不给你」（`SCOPE_DENIED` 权限范围不足 / `CONSENT_REQUIRED` 缺用途授权 /
 * `ACCOUNT_INACTIVE` 账号不可用）。把 403 也一并当成「登录状态已失效」并清会话，会让用户被
 * 踢回登录页反复重登却始终不明白为什么不行，也让 B7 统一状态层（`utils/states.js` 的
 * `CODE_KIND`）永远收不到真实的 403 码——它一直是「登录失效」。
 *
 * 分类依据**直接取自 `states.CODE_KIND`**（kind === 'session' 即会话失效，kind === 'denied' 即契约 403 闭集），
 * 不另立一份码表；唯一补充是 `ACCOUNT_INACTIVE`：令牌永久不可再用（账号停用/注销、或 auth_epoch 前进），
 * 本地会话必须清掉，但错误码**如实保留**（页面按「账号不可用」呈现，不谎称登录过期）。
 */
const SESSION_LOSS_CODES = Object.freeze(
  Object.keys(states.CODE_KIND).filter(function (code) { return states.CODE_KIND[code] === 'session' })
)
// 契约 403 闭集（SCOPE_DENIED / CONSENT_REQUIRED / ACCOUNT_INACTIVE），同样由 B7 的 kind 反推。
const FORBIDDEN_CODES = Object.freeze(
  Object.keys(states.CODE_KIND).filter(function (code) { return states.CODE_KIND[code] === 'denied' })
)
// 令牌永久失效但语义不是「登录过期」的码：清会话，码原样上抛。
const RETIRED_SESSION_CODES = Object.freeze(['ACCOUNT_INACTIVE'])

/** 从契约错误封套里取错误码；读不到形状即 null（不猜）。 */
function errorCodeOf(payload) {
  if (!payload || typeof payload !== 'object') return null
  const error = payload.error
  if (!error || typeof error !== 'object') return null
  if (typeof error.code !== 'string' || error.code === '' || error.code.length > 80) return null
  return error.code
}

function isSessionLossCode(code) {
  return typeof code === 'string' && SESSION_LOSS_CODES.indexOf(code) !== -1
}

function isForbiddenCode(code) {
  return typeof code === 'string' && FORBIDDEN_CODES.indexOf(code) !== -1
}

/**
 * 把一次 401/403 响应归因为「可展示的契约错误码 + 语义标记」（**纯函数**，不读写存储、不发请求）。
 * - 401：一律归一为 `SESSION_REQUIRED`（会话失效 + 清会话；契约 401 里的 `SESSION_EXPIRED` 与之等价）。
 * - 403：契约闭集为 `SCOPE_DENIED` / `CONSENT_REQUIRED` / `ACCOUNT_INACTIVE`，**原样带出**；
 *   封套读不到、或码不在该闭集 ⇒ `SCOPE_DENIED`（服务端确实拒绝了，只是没说清原因——不假装是登录问题）。
 * - 403 里若出现会话类码（越界实现）：仍按会话失效处理并清会话（不放宽守卫）。
 */
function attribution(statusCode, payload) {
  const code = errorCodeOf(payload)
  const retryable = !!(payload && payload.error && payload.error.retryable === true)
  if (statusCode === 401) {
    // 401 一律归一到 `SESSION_REQUIRED`：契约 401 只承载 `SESSION_REQUIRED` / `SESSION_EXPIRED`，
    // 两者对用户动作与 B7 状态层（`CODE_KIND` 都是 session → `guest`）完全等价；保留 `SESSION_EXPIRED`
    // 只会让各模块的 `messageFor` 出现没有文案的码（改造前 identify / speech 也是折叠的）。
    return {
      code: 'SESSION_REQUIRED',
      status: 401, retryable, sessionLost: true, clearsSession: true
    }
  }
  // 403：会话类码（越界实现）优先按会话失效；契约 403 闭集原样带出；其余（无封套 / 未知码）
  // 一律归 `SCOPE_DENIED` —— 状态码本身已经说清「这是拒绝」，不该再把它说成登录问题。
  const surface = isSessionLossCode(code) || isForbiddenCode(code) ? code : 'SCOPE_DENIED'
  const sessionLost = isSessionLossCode(surface)
  return {
    code: surface,
    status: 403,
    retryable,
    sessionLost,
    clearsSession: sessionLost || RETIRED_SESSION_CODES.indexOf(surface) !== -1
  }
}

/**
 * 适配层落地用：按归因结果**仅在需要时**清会话，并用调用方自己的 `failure` 构造器生成错误对象
 * （各模块的错误形状不同，这里不替它们发明形状，只补 `status` / `retryable`）。
 */
function failureFor(makeFailure, statusCode, payload) {
  const a = attribution(statusCode, payload)
  if (a.clearsSession) clearSession()
  const e = makeFailure(a.code)
  if (e && typeof e === 'object') {
    e.status = a.status
    e.retryable = a.retryable
  }
  return e
}

/** 读取缓存中当前的访问令牌（不触发预检/清理），用于在途回调的绑定校验。 */
function currentToken() {
  try {
    const value = wx.getStorageSync(SESSION_KEY)
    if (value && typeof value === 'object' && typeof value.accessToken === 'string') return value.accessToken
  } catch (_) {}
  return null
}

function clearSession() {
  // 世代递增：使此前在途的 verifySession 回调失效（退出/清会话/切账号）。
  generation += 1
  serverVerified = false
  navigation.clearReturnTo()
  try {
    wx.removeStorageSync(SESSION_KEY)
  } catch (_) {}
}

/**
 * 本地预检：缓存必须形状完整（accessToken 非空 / audience=user / expiresAt 未来 /
 * executionMode 为已知演示标记），否则清理并返回 null。
 * 通过预检也**只**是必要条件，不构成认证（仍需 verifySession）。
 */
function getSession() {
  let value
  try {
    value = wx.getStorageSync(SESSION_KEY)
  } catch (_) {
    return null
  }
  if (!value || typeof value !== 'object') {
    if (value) clearSession()
    return null
  }
  const shapeOk =
    typeof value.accessToken === 'string' &&
    value.accessToken !== '' &&
    value.audience === USER_AUDIENCE &&
    isFutureIso(value.expiresAt) &&
    KNOWN_EXECUTION_MODES.indexOf(value.executionMode) !== -1
  if (!shapeOk) {
    clearSession()
    return null
  }
  return value
}

function setSession(session, preserveNavigation) {
  // 令牌发生变化（登录/切换账号）即递增世代，使旧令牌的在途回调失效；
  // 同一令牌仅刷新时效（verifySession 成功路径）不递增世代，避免误伤并发核实。
  if (currentToken() !== session.accessToken) {
    generation += 1
    if (!preserveNavigation) navigation.clearReturnTo()
  }
  try {
    wx.setStorageSync(SESSION_KEY, {
      accessToken: session.accessToken,
      audience: session.audience,
      expiresAt: session.expiresAt,
      executionMode: session.executionMode
    })
  } catch (_) {
    // 存储失败不谎称已登录：getSession 会如实返回 null。
  }
}

/** 是否已登录：必须是**经服务端核实**且本地预检通过的会话。 */
function isLoggedIn() {
  return serverVerified && getSession() !== null
}

/** 生成本次登录请求的幂等键（>=8 字符，契约要求）。 */
function newIdempotencyKey() {
  const rand = Math.random().toString(36).slice(2, 10)
  return 'gy-' + Date.now().toString(36) + '-' + rand
}

/** 等待秒数的上限：服务端限流窗口最长 1 小时，更长的值一律按 3600 处理。 */
const RETRY_AFTER_MAX_SECONDS = 3600

/** 候选值 → 正整数秒：非法/≤0 ⇒ null；小数向上取整；再截断到上限。 */
function positiveSeconds(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return Math.min(RETRY_AFTER_MAX_SECONDS, Math.ceil(seconds))
}

/**
 * 429 的等待秒数（纯函数，不读全局状态）：`headers`（响应头，两种大小写都认）×
 * `body`（响应体）× `now`（毫秒时间戳）→ 正整数秒；取不到可解释的值 ⇒ null。
 *
 * 取值顺序与 `retryAfterText` 同一套：`retry-after` 秒数 → `retry-after` 的 HTTP 日期 →
 * body 里的 `retry_after_seconds`/`retryAfter` → body 文案里的「N 秒」→ null。
 * **头优先**：头里的秒数与限流器算出的窗口同源，body 文案可能来自别的路径或已经过期。
 * 非法/≤0 一律 null（不拿 0 秒去「冷却」），上限截断到 `RETRY_AFTER_MAX_SECONDS`。
 */
function retryAfterSeconds(headers, body, now) {
  const header = headers && typeof headers === 'object' ? headers : {}
  const raw = header['retry-after'] !== undefined ? header['retry-after'] : header['Retry-After']
  // 头优先（1/2）：先按秒数解释，再按 HTTP 日期解释——`Number(<HTTP 日期>)` 是 NaN，两条不互相抢。
  const fromHeaderSeconds = positiveSeconds(raw)
  if (fromHeaderSeconds !== null) return fromHeaderSeconds
  if (raw !== undefined && raw !== null && raw !== '') {
    const at = Date.parse(String(raw))
    if (!Number.isNaN(at)) {
      const base = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
      const fromHeaderDate = positiveSeconds((at - base) / 1000)
      if (fromHeaderDate !== null) return fromHeaderDate
    }
  }
  const error = body && typeof body === 'object' ? body.error : null
  const explicit = [
    error && error.retry_after_seconds,
    error && error.retryAfter,
    body && typeof body === 'object' && body.retry_after_seconds,
    body && typeof body === 'object' && body.retryAfter
  ]
  for (let i = 0; i < explicit.length; i += 1) {
    const seconds = positiveSeconds(explicit[i])
    if (seconds !== null) return seconds
  }
  const messages = [error && error.message, body && typeof body === 'object' && body.message]
  for (let i = 0; i < messages.length; i += 1) {
    if (typeof messages[i] !== 'string') continue
    const match = /([0-9]+)\s*秒/.exec(messages[i])
    if (match) {
      const seconds = positiveSeconds(match[1])
      if (seconds !== null) return seconds
    }
  }
  return null
}

/**
 * `Retry-After`（秒数，或 HTTP 日期）→ 「请 N 秒后再试」；拿不到可解释的值就返回 null。
 * 微信小程序的响应头 key 一律小写，这里两种写法都认。
 */
function retryAfterText(response) {
  const seconds = retryAfterSeconds(response && response.header, response && response.data, Date.now())
  if (seconds === null) return null
  return '请求过于频繁，请 ' + seconds + ' 秒后再试'
}

/**
 * 失败原因的可读文本。
 *
 * 429（契约码 `RATE_LIMITED`）是唯一要特殊处理的分支：限流不是"错误码"，而是"等一会儿再来"。
 * 服务端在 `error.message` 里已经写了「请求过于频繁，请 N 秒后再试」，响应头 `Retry-After`
 * 又给了同一个 N（秒）——优先用头重拼一句，保证提示里的秒数与限流器算出的窗口一致；
 * 拿不到头就退回服务端 message。**其余错误码维持原样**（回错误码，便于对问题）。
 */
function statusText(response) {
  const body = response && response.data
  const error = body && body.error
  if (response && (response.statusCode === 429 || (error && error.code === 'RATE_LIMITED'))) {
    const retryAfter = retryAfterText(response)
    if (retryAfter !== null) return retryAfter
    if (error && typeof error.message === 'string' && error.message !== '') return error.message
    return '请求过于频繁，请稍后再试'
  }
  if (error && typeof error.code === 'string') return error.code
  return 'HTTP ' + (response ? response.statusCode : '?')
}

/**
 * 用服务端 GET /auth/session 核实当前缓存会话。
 * - 200 且契约 SessionInfo 且受众为 user：标记已核实，并按服务端返回值刷新时效。
 * - 401/403：服务端**明确**判定该会话不可用 ⇒ 清理本地会话，回调 false。
 * - 200 但契约形状/受众/时效不符：服务端自相矛盾 ⇒ 同样作废，回调 false。
 * - 其它状态（408/429/5xx/未知）：核实**没做成**，不判定会话失效 ⇒ **不清理会话**，
 *   只保持「未核实」（门禁关闭、绝不谎称已登录）；回调 false。一次 503 不该毁掉有效登录。
 * - 网络失败：无法核实 → **不置已核实**（门禁保持关闭）并回调 false；不谎称已登录。
 * callback(verified)
 */
function verifySession(callback) {
  const done = typeof callback === 'function' ? callback : function () {}
  const session = getSession()
  if (session === null || !networkEnabled()) {
    done(false)
    return
  }
  // 以「会话世代 + 当前令牌」绑定本次请求：退出/清会话/切换账号后，在途回调一律失效。
  const requestGeneration = generation
  const requestToken = session.accessToken
  const requestIntent = intentEpoch
  const requestNavigation = navigation.epoch()
  const stale = function () {
    return generation !== requestGeneration || currentToken() !== requestToken ||
      intentEpoch !== requestIntent || !navigation.isCurrent(requestNavigation)
  }
  wx.request({
    url: runtime.apiBaseUrl + '/auth/session',
    method: 'GET',
    header: { authorization: 'Bearer ' + session.accessToken },
    success: function (response) {
      if (stale()) {
        // 会话在请求期间被撤销/清除或已切换账号：迟到的成功响应不得复活旧会话。
        done(false, true)
        return
      }
      const body = response && response.data
      const data = body && body.data
      if (
        response.statusCode === 200 &&
        data &&
        typeof data === 'object' &&
        data.audience === USER_AUDIENCE &&
        isFutureIso(data.expires_at)
      ) {
        setSession({
          accessToken: session.accessToken,
          audience: data.audience,
          expiresAt: data.expires_at,
          executionMode: session.executionMode
        })
        serverVerified = true
        done(true)
        return
      }
      // 非 200：先看服务端是否**明确**判定该会话不可用。
      const status = response ? response.statusCode : 0
      if (status === 401 || status === 403) {
        // 401（未登录/过期）与 403（账号不可用/受众不符）都说明这份令牌不能再用了 ⇒ 作废。
        clearSession()
        done(false)
        return
      }
      if (status === 200) {
        // 200 但契约形状/受众/时效不符：服务端自相矛盾，不能当作已核实 ⇒ 按作废处理。
        clearSession()
        done(false)
        return
      }
      // 其它（408 / 429 / 5xx / 未知状态）：服务端**没有**判定会话失效，只是这次核实没做成
      // （例如能力未装配的 503 PROVIDER_UNAVAILABLE）。清掉本地会话会让一次瞬时故障毁掉仍然
      // 有效的登录，用户被迫重登；这里只保持「未核实」（门禁仍关闭，绝不谎称已登录）。
      serverVerified = false
      done(false)
    },
    fail: function () {
      if (stale()) {
        // 迟到的失败响应不得清掉更新的登录（可能已切换账号/重新登录）。
        done(false, true)
        return
      }
      // 网络失败：不能核实，也不谎称已登录（门禁保持关闭）。
      serverVerified = false
      done(false)
    }
  })
}

/**
 * 微信登录：wx.login 取 code → 服务端 /auth/wechat 换取会话。
 * 客户端不传 openid / 角色 / 用户 id。
 *
 * 世代绑定：**发起时**推进并捕获共享的意图世代（`intentEpoch`）与会话世代（`generation`）；
 * 成功回调在写会话（`setSession` / `serverVerified`）**之前**校验二者未变。若期间发生
 * 退出 / 清会话 / 切换账号 / 更新的登录，则丢弃该响应（不写会话、不放行），避免旧登录结果
 * 复活已被清除的会话或覆盖较新的（尤其是**退出**）意图。
 * callback(errorMessageOrNull, navigationEpoch, retryAfterSecondsOrNull)
 * 第三个参数只在 429/RATE_LIMITED 时非空，供页面按秒冷却；其余失败一律 null。
 */
function login(callback) {
  const done = typeof callback === 'function' ? callback : function () {}
  const opNavigation = navigation.epoch()
  // 第三个参数只在 429 时给值：登录页用它给按钮上冷却（`retryAfterSeconds` 的读数）。
  const finishError = function (message, retryAfter) {
    navigation.clearReturnTo(opNavigation)
    done(message, undefined, retryAfter === undefined ? null : retryAfter)
  }
  if (!networkEnabled()) {
    finishError('当前未启用联网（共享源码默认关闭）。请在本地或正式环境启用后再登录。')
    return
  }
  const opIntent = ++intentEpoch
  const opGeneration = generation
  const stale = function () {
    return intentEpoch !== opIntent || generation !== opGeneration || !navigation.isCurrent(opNavigation)
  }
  wx.login({
    success: function (loginResult) {
      if (stale()) { done('登录结果已失效（会话状态已变更），请重试。'); return }
      const code = loginResult && loginResult.code
      if (typeof code !== 'string' || code === '') {
        finishError('微信未返回登录 code，请重试。')
        return
      }
      wx.request({
        url: runtime.apiBaseUrl + '/auth/wechat',
        method: 'POST',
        header: { 'content-type': 'application/json', 'Idempotency-Key': newIdempotencyKey() },
        data: { code: code },
        success: function (response) {
          if (stale()) {
            // 本次登录已被更新的登录 / 退出 / 清会话取代：迟到响应不得写会话、不得放行。
            done('登录结果已失效（会话状态已变更），请重试。')
            return
          }
          const body = response && response.data
          const data = body && body.data
          const meta = body && body.meta
          if (response.statusCode !== 200 || !data || typeof data.access_token !== 'string') {
            // 429 把等待秒数一并交出：文案照旧走 statusText，冷却时长走纯函数（同一套取值顺序）。
            const limited = response.statusCode === 429 ||
              (body && body.error && body.error.code === 'RATE_LIMITED')
            finishError('登录失败：' + statusText(response),
              limited ? retryAfterSeconds(response.header, body, Date.now()) : null)
            return
          }
          const executionMode = meta && typeof meta.execution_mode === 'string' ? meta.execution_mode : ''
          if (KNOWN_EXECUTION_MODES.indexOf(executionMode) === -1) {
            // 缺少可解释的执行模式：不保存难以解释的会话。
            finishError('登录响应缺少可解释的执行模式，已拒绝。')
            return
          }
          setSession({
            accessToken: data.access_token,
            audience: data.audience,
            expiresAt: data.expires_at,
            executionMode: executionMode
          }, true)
          serverVerified = true
          if (!isLoggedIn()) {
            finishError('登录会话保存失败，请重试。')
            return
          }
          done(null, opNavigation)
        },
        fail: function () {
          if (stale()) {
            // 本次登录已被更新的会话操作取代：不得误报为当前登录失败。
            done('登录结果已失效（会话状态已变更），请重试。')
            return
          }
          finishError('网络请求失败，请检查地址与网络后重试。')
        }
      })
    },
    fail: function () {
      if (stale()) { done('登录结果已失效（会话状态已变更），请重试。'); return }
      finishError('wx.login 调用失败，请重试。')
    }
  })
}

/**
 * 退出登录：联网时调用服务端 /auth/logout 撤销会话（服务端立即失效）。
 * **仅当契约成功 Ack**（HTTP 200 且 body.data.accepted === true）才报「服务端已撤销」；
 * 其他响应（503/500 等）或网络失败一律清理本地会话，但保留
 * 「服务端撤销未确认」状态，不谎称已撤销。
 *
 * 世代绑定：**发起时**推进并捕获共享的意图世代（`intentEpoch`）、会话世代（`generation`）
 * 与目标令牌；success/fail 回调在 `clearSession` **之前**校验三者未变。若期间发生更新的一次
 * 登录 / 退出 / 清会话，则该退出操作已失效——既不清除更新的会话，也不回调（避免以旧退出
 * 误报新会话状态）。
 * callback({ serverRevoked, serverRevocationUnconfirmed })
 */
function logout(callback) {
  const done = typeof callback === 'function' ? callback : function () {}
  navigation.clearReturnTo()
  const session = getSession()
  if (session === null || !networkEnabled()) {
    clearSession()
    done({ serverRevoked: false, serverRevocationUnconfirmed: false })
    return
  }
  const opIntent = ++intentEpoch
  const opGeneration = generation
  const opToken = session.accessToken
  const stale = function () {
    return intentEpoch !== opIntent || generation !== opGeneration || currentToken() !== opToken
  }
  wx.request({
    url: runtime.apiBaseUrl + '/auth/logout',
    method: 'POST',
    data: {},
    header: { 'content-type': 'application/json', authorization: 'Bearer ' + session.accessToken, 'Idempotency-Key': newIdempotencyKey() },
    success: function (response) {
      if (stale()) {
        // 该退出操作已被更新的登录/退出取代：不得清除更新的会话，也不回调。
        return
      }
      const body = response && response.data
      const data = body && body.data
      const acked = response.statusCode === 200 && data && data.accepted === true
      clearSession()
      if (acked) {
        done({ serverRevoked: true, serverRevocationUnconfirmed: false })
        return
      }
      // 收到响应但非契约成功 Ack：本地已清，服务端撤销未确认。
      done({ serverRevoked: false, serverRevocationUnconfirmed: true })
    },
    fail: function () {
      if (stale()) {
        // 该退出操作已被更新的登录/退出取代：不得清除更新的会话，也不回调。
        return
      }
      clearSession()
      done({ serverRevoked: false, serverRevocationUnconfirmed: true })
    }
  })
}

/**
 * 游客门禁（异步）：未登录或会话未获服务端核实即跳转登录页并返回 false。
 * 门禁只看经服务端核实的会话状态，**不看**缓存对象本身。
 * callback(loggedIn)
 */
function requireLogin(callback) {
  const done = typeof callback === 'function' ? callback : function () {}
  const session = getSession()
  const page = navigation.currentPage()
  const target = navigation.captureCurrent()
  const op = navigation.beginReturnTo(target)
  const opIntent = intentEpoch
  if (session === null || !networkEnabled()) {
    navigation.goLogin(op.id)
    done(false)
    return
  }
  verifySession(function (verified, stale) {
    if (stale || intentEpoch !== opIntent || navigation.currentPage() !== page) { done(false); return }
    if (!verified) {
      // Current rejection may have cleared the session/intent; never resurrect a stale callback.
      const pending = navigation.beginReturnTo(target)
      navigation.goLogin(pending.id)
      done(false)
      return
    }
    navigation.clearReturnTo(op.id)
    done(true)
  })
}

/**
 * 取消**本页在途的那次登录**（不是退出登录）。
 * - 默认：推进意图世代并清会话（游客取消、无既有会话的场景）。
 * - `preserveVerifiedSession=true`：只推进意图世代让在途登录结果作废；若取消前已有
 *   **经服务端核实**且本地预检通过的会话，则保留它。页面隐藏/返回不该销毁仍然有效的登录，
 *   真正的撤销只走 logout()。
 */
function cancelLogin(preserveVerifiedSession) {
  intentEpoch += 1
  if (preserveVerifiedSession && serverVerified && getSession() !== null) {
    // 只作废本页在途登录与这次一次性返回意图；仍然有效的会话本身保留（撤销只走 logout）。
    navigation.clearReturnTo()
    return
  }
  clearSession()
}
function resumeAfterLogin(id, callback) {
  if (!navigation.isCurrent(id) || !isLoggedIn()) return false
  const target = navigation.consumeReturnTo(id)
  navigation.openTarget(target, true, callback)
  return true
}

module.exports = {
  // Read-only binding for protected client requests, including an in-flight logout.
  sessionEpoch: function () { return generation + ":" + intentEpoch },
  // 401/403 归因的单一事实源（各适配层共用；见文件头 attribution 注释）。
  SESSION_LOSS_CODES: SESSION_LOSS_CODES,
  FORBIDDEN_CODES: FORBIDDEN_CODES,
  RETIRED_SESSION_CODES: RETIRED_SESSION_CODES,
  isSessionLossCode: isSessionLossCode,
  isForbiddenCode: isForbiddenCode,
  attribution: attribution,
  failureFor: failureFor,
  getSession: getSession,
  setSession: setSession,
  clearSession: clearSession,
  isLoggedIn: isLoggedIn,
  networkEnabled: networkEnabled,
  verifySession: verifySession,
  // 429 的等待秒数（纯函数）：登录页据此按秒冷却，单测直接钉「头优先」的取值顺序。
  retryAfterSeconds: retryAfterSeconds,
  login: login,
  logout: logout,
  requireLogin: requireLogin,
  cancelLogin: cancelLogin,
  resumeAfterLogin: resumeAfterLogin
}
