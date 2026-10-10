// GY-I04: one-use navigation intent, never an authorization or a persisted credential.
// Reference: Agent2 feature/gy-i04-login-loop (uncommitted candidate, 2026-10-10).
// Intents remain in this app process across reLaunch, and disappear on app restart.
const PAGES = ['pages/home/home', 'pages/identify/identify', 'pages/reference/reference',
  'pages/referencedetail/referencedetail', 'pages/referenceseed/referenceseed',
  'pages/referenceseeddetail/referenceseeddetail', 'pages/community/community',
  'pages/messages/messages', 'pages/profile/profile', 'pages/login/login']
const TAB_PAGES = ['pages/home/home', 'pages/identify/identify', 'pages/community/community',
  'pages/messages/messages', 'pages/profile/profile']
const HOME = '/pages/home/home'
const LOGIN = '/pages/login/login'
const MAX_PATH_LENGTH = 512
const ID_PAGES = ['/pages/referencedetail/referencedetail', '/pages/referenceseeddetail/referenceseeddetail']
let revision = 0
let returnTo = null

function normalizeTarget(candidate) {
  if (typeof candidate !== 'string' || candidate.length > MAX_PATH_LENGTH) return null
  const parts = candidate.split('?')
  if (parts.length > 2 || PAGES.indexOf(parts[0].slice(1)) === -1 ||
      parts[0].charAt(0) !== '/' || parts[0] === LOGIN) return null
  if (parts.length === 1) return parts[0]
  // No arbitrary role/token/user_id/redirect parameters. Only existing detail-page IDs.
  if (ID_PAGES.indexOf(parts[0]) === -1 || !/^id=[A-Za-z0-9_%.-]+$/.test(parts[1])) return null
  let id
  try { id = decodeURIComponent(parts[1].slice(3)) } catch (_) { return null }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null
  return parts[0] + '?id=' + encodeURIComponent(id)
}

function epoch() { return revision }
function isCurrent(id) { return id === revision }
function beginReturnTo(candidate) {
  revision += 1
  returnTo = normalizeTarget(candidate) // Invalid replaces old, rather than leaving it behind.
  return { id: revision, target: returnTo }
}
function clearReturnTo(id) {
  if (id !== undefined && !isCurrent(id)) return false
  revision += 1
  returnTo = null
  return true
}
function peekReturnTo() { return returnTo }
function consumeReturnTo(id) {
  if (id !== undefined && !isCurrent(id)) return null
  const target = returnTo
  clearReturnTo()
  return target
}
function currentPage() {
  try {
    const pages = getCurrentPages()
    return Array.isArray(pages) && pages.length ? pages[pages.length - 1] : null
  } catch (_) { return null }
}
function captureCurrent() {
  const page = currentPage()
  if (!page || typeof page.route !== 'string') return null
  try {
    const options = page.options || {}
    const keys = Object.keys(options)
    const query = keys.map(function (key) {
      if (typeof options[key] !== 'string') throw new Error('invalid page option')
      return encodeURIComponent(key) + '=' + encodeURIComponent(options[key])
    }).join('&')
    return normalizeTarget('/' + page.route + (query ? '?' + query : ''))
  } catch (_) { return null }
}

// Correct route API per tabBar. Failure fallback never overrides a newer intent.
function openTarget(candidate, replace, callback) {
  const done = typeof callback === 'function' ? callback : function () {}
  const target = normalizeTarget(candidate) || HOME
  const op = revision
  let settled = false
  function fail() {
    if (settled || !isCurrent(op)) return
    settled = true
    if (target === HOME) { done('页面打开失败，请重试。'); return }
    try {
      wx.reLaunch({ url: HOME,
        success: function () { if (isCurrent(op)) done('原目标页暂时无法打开，已返回首页。') },
        fail: function () { if (isCurrent(op)) done('页面打开失败，请重试。') } })
    } catch (_) { done('页面打开失败，请重试。') }
  }
  const method = TAB_PAGES.indexOf(target.slice(1)) !== -1 ? 'switchTab' : replace ? 'reLaunch' : 'navigateTo'
  try {
    wx[method]({ url: target, fail: fail, success: function () {
      if (settled || !isCurrent(op)) return
      settled = true
      done(null)
    } })
  } catch (_) { fail() }
}
function goLogin(id, callback) {
  if (!isCurrent(id)) return false
  try {
    wx.reLaunch({ url: LOGIN, fail: function () {
      if (!isCurrent(id)) return
      clearReturnTo(id)
      openTarget(HOME, true, callback)
    } })
  } catch (_) {
    if (!isCurrent(id)) return false
    clearReturnTo(id)
    openTarget(HOME, true, callback)
  }
  return true
}
module.exports = { PAGES, TAB_PAGES, HOME, LOGIN, MAX_PATH_LENGTH, normalizeTarget,
  epoch, isCurrent, beginReturnTo, clearReturnTo, peekReturnTo, consumeReturnTo,
  currentPage, captureCurrent, openTarget, goLogin }
