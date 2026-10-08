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

const SESSION_KEY = 'gengyun.session'
// 小程序只接受用户受众；后台受众（admin）令牌不得出现在小程序会话缓存里。
const USER_AUDIENCE = 'user'
// 契约 ExecutionMode：缓存里的演示标记必须是已知取值，不接受伪造标记。
const KNOWN_EXECUTION_MODES = ['real', 'stub', 'preset_demo']

// 经服务端核实的状态：仅当 login() 或 verifySession() 收到服务端成功响应后才置位。
// 进程启动时为 false —— 因此单靠一个本地缓存对象永远不等于已登录。
let serverVerified = false

// 会话世代：每次「清会话」或「切换/建立新令牌」时递增。
// 在途的 verifySession 请求以发起时的世代 + 令牌绑定；两者任一变化即视为过期回调：
// 迟到的成功不得复活已清除的会话，迟到的失败不得清掉更新的登录。
let generation = 0

function networkEnabled() {
  return runtime.mode === 'local' && typeof runtime.apiBaseUrl === 'string' && runtime.apiBaseUrl !== ''
}

function isFutureIso(value) {
  if (typeof value !== 'string' || value === '') return false
  const ms = Date.parse(value)
  return Number.isFinite(ms) && ms > Date.now()
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

function setSession(session) {
  // 令牌发生变化（登录/切换账号）即递增世代，使旧令牌的在途回调失效；
  // 同一令牌仅刷新时效（verifySession 成功路径）不递增世代，避免误伤并发核实。
  if (currentToken() !== session.accessToken) generation += 1
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

function statusText(response) {
  const body = response && response.data
  if (body && body.error && typeof body.error.code === 'string') return body.error.code
  return 'HTTP ' + (response ? response.statusCode : '?')
}

/**
 * 用服务端 GET /auth/session 核实当前缓存会话。
 * - 200 且契约 SessionInfo 且受众为 user：标记已核实，并按服务端返回值刷新时效。
 * - 其他响应（401/403/5xx 等）：服务端已明确作答且未确认有效 → 清理本地会话，回调 false。
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
  const stale = function () {
    return generation !== requestGeneration || currentToken() !== requestToken
  }
  wx.request({
    url: runtime.apiBaseUrl + '/auth/session',
    method: 'GET',
    header: { authorization: 'Bearer ' + session.accessToken },
    success: function (response) {
      if (stale()) {
        // 会话在请求期间被撤销/清除或已切换账号：迟到的成功响应不得复活旧会话。
        done(false)
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
      // 服务端明确拒绝或返回异常：本地会话作废。
      clearSession()
      done(false)
    },
    fail: function () {
      if (stale()) {
        // 迟到的失败响应不得清掉更新的登录（可能已切换账号/重新登录）。
        done(false)
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
 * callback(errorMessageOrNull)
 */
function login(callback) {
  if (!networkEnabled()) {
    callback('当前未启用联网（共享源码默认关闭）。请在本地或正式环境启用后再登录。')
    return
  }
  wx.login({
    success: function (loginResult) {
      const code = loginResult && loginResult.code
      if (typeof code !== 'string' || code === '') {
        callback('微信未返回登录 code，请重试。')
        return
      }
      wx.request({
        url: runtime.apiBaseUrl + '/auth/wechat',
        method: 'POST',
        header: { 'content-type': 'application/json', 'Idempotency-Key': newIdempotencyKey() },
        data: { code: code },
        success: function (response) {
          const body = response && response.data
          const data = body && body.data
          const meta = body && body.meta
          if (response.statusCode !== 200 || !data || typeof data.access_token !== 'string') {
            callback('登录失败：' + statusText(response))
            return
          }
          const executionMode = meta && typeof meta.execution_mode === 'string' ? meta.execution_mode : ''
          if (KNOWN_EXECUTION_MODES.indexOf(executionMode) === -1) {
            // 缺少可解释的执行模式：不保存难以解释的会话。
            callback('登录响应缺少可解释的执行模式，已拒绝。')
            return
          }
          setSession({
            accessToken: data.access_token,
            audience: data.audience,
            expiresAt: data.expires_at,
            executionMode: executionMode
          })
          serverVerified = true
          if (!isLoggedIn()) {
            callback('登录会话保存失败，请重试。')
            return
          }
          callback(null)
        },
        fail: function () {
          callback('网络请求失败，请检查地址与网络后重试。')
        }
      })
    },
    fail: function () {
      callback('wx.login 调用失败，请重试。')
    }
  })
}

/**
 * 退出登录：联网时调用服务端 /auth/logout 撤销会话（服务端立即失效）。
 * **仅当契约成功 Ack**（HTTP 200 且 body.data.accepted === true）才报「服务端已撤销」；
 * 其他响应（503/500 等）或网络失败一律清理本地会话，但保留
 * 「服务端撤销未确认」状态，不谎称已撤销。
 * callback({ serverRevoked, serverRevocationUnconfirmed })
 */
function logout(callback) {
  const session = getSession()
  if (session === null || !networkEnabled()) {
    clearSession()
    callback({ serverRevoked: false, serverRevocationUnconfirmed: false })
    return
  }
  wx.request({
    url: runtime.apiBaseUrl + '/auth/logout',
    method: 'POST',
    header: { 'content-type': 'application/json', authorization: 'Bearer ' + session.accessToken, 'Idempotency-Key': newIdempotencyKey() },
    success: function (response) {
      const body = response && response.data
      const data = body && body.data
      const acked = response.statusCode === 200 && data && data.accepted === true
      clearSession()
      if (acked) {
        callback({ serverRevoked: true, serverRevocationUnconfirmed: false })
        return
      }
      // 收到响应但非契约成功 Ack：本地已清，服务端撤销未确认。
      callback({ serverRevoked: false, serverRevocationUnconfirmed: true })
    },
    fail: function () {
      clearSession()
      callback({ serverRevoked: false, serverRevocationUnconfirmed: true })
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
  if (getSession() === null || !networkEnabled()) {
    wx.reLaunch({ url: '/pages/login/login' })
    done(false)
    return
  }
  verifySession(function (verified) {
    if (!verified) {
      wx.reLaunch({ url: '/pages/login/login' })
      done(false)
      return
    }
    done(true)
  })
}

module.exports = {
  getSession: getSession,
  setSession: setSession,
  clearSession: clearSession,
  isLoggedIn: isLoggedIn,
  networkEnabled: networkEnabled,
  verifySession: verifySession,
  login: login,
  logout: logout,
  requireLogin: requireLogin
}
