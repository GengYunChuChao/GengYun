// 会话与游客门禁（GY-I04）。
//
// 边界（与 shared source 的联网约束一致）：共享源码的 runtime.mode 为 'disabled'，
// 网络未启用时 login() 明确失败，**不伪造登录成功、不写入假令牌**。
// 本地调试/正式环境由 tools/prepare-wechat.mjs 生成 mode:'local' 的忽略副本后启用网络。
//
// 安全：不在此处保存任何微信凭据；只保存服务端签发的不透明会话令牌。
// 身份（openid/角色/用户 id）由服务端从 code 换取，客户端不声明。

const runtime = require('../config/runtime')

const SESSION_KEY = 'gengyun.session'

function networkEnabled() {
  return runtime.mode === 'local' && typeof runtime.apiBaseUrl === 'string' && runtime.apiBaseUrl !== ''
}

function getSession() {
  try {
    const value = wx.getStorageSync(SESSION_KEY)
    if (!value || typeof value !== 'object') return null
    if (typeof value.accessToken !== 'string' || value.accessToken === '') return null
    return value
  } catch (_) {
    return null
  }
}

function setSession(session) {
  try {
    wx.setStorageSync(SESSION_KEY, {
      accessToken: session.accessToken,
      audience: session.audience,
      expiresAt: session.expiresAt
    })
  } catch (_) {
    // 存储失败不谎称已登录：getSession 会如实返回 null。
  }
}

function clearSession() {
  try {
    wx.removeStorageSync(SESSION_KEY)
  } catch (_) {}
}

function isLoggedIn() {
  return getSession() !== null
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
          if (response.statusCode !== 200 || !data || typeof data.access_token !== 'string') {
            callback('登录失败：' + statusText(response))
            return
          }
          setSession({ accessToken: data.access_token, audience: data.audience, expiresAt: data.expires_at })
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
 * 退出登录：联网时调用服务端 /auth/logout 撤销会话（服务端立即失效），
 * 再清本地会话；未联网时只清本地，不谎称已撤销服务端会话。
 * callback({serverRevoked: boolean})
 */
function logout(callback) {
  const session = getSession()
  if (session === null || !networkEnabled()) {
    clearSession()
    callback({ serverRevoked: false })
    return
  }
  wx.request({
    url: runtime.apiBaseUrl + '/auth/logout',
    method: 'POST',
    header: { 'content-type': 'application/json', authorization: 'Bearer ' + session.accessToken, 'Idempotency-Key': newIdempotencyKey() },
    success: function () {
      clearSession()
      callback({ serverRevoked: true })
    },
    fail: function () {
      clearSession()
      callback({ serverRevoked: false })
    }
  })
}

/** 游客门禁：未登录跳转登录页并返回 false；已登录返回 true。 */
function requireLogin() {
  if (isLoggedIn()) return true
  wx.reLaunch({ url: '/pages/login/login' })
  return false
}

module.exports = {
  getSession: getSession,
  setSession: setSession,
  clearSession: clearSession,
  isLoggedIn: isLoggedIn,
  networkEnabled: networkEnabled,
  login: login,
  logout: logout,
  requireLogin: requireLogin
}
