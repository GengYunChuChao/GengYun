// GY-I04: one-use navigation intent, never an authorization or a persisted credential.
// Reference: Agent2 feature/gy-i04-login-loop (uncommitted candidate, 2026-10-10).
// Intents remain in this app process across reLaunch, and disappear on app restart.
const PAGES = ['pages/home/home', 'pages/identify/identify', 'pages/knowledge/knowledge',
  'pages/knowledgedetail/knowledgedetail', 'pages/reference/reference',
  'pages/referencedetail/referencedetail', 'pages/referenceseed/referenceseed',
  'pages/referenceseeddetail/referenceseeddetail', 'pages/community/community',
  // GY-I15：社区投稿与详情（详情页按 uuid 收窄查询参数，不接受任意参数）。
  'pages/communitycreate/communitycreate', 'pages/communitydetail/communitydetail',
  'pages/messages/messages', 'pages/profile/profile', 'pages/login/login',
  // GY-I26：样式走查页（仅本地替身工程可见）。本列表须与 app.json 的 pages 逐项一致，
  // 由 tests/unit/miniprogram-login-return-to.test.mjs 锁定；不改变任何路由逻辑。
  'pages/specimen/specimen',
  // GY-I16：收藏与识别历史（列表／详情）。同样须与 app.json 的 pages 逐项一致；
  // 三者都**不是**底部 Tab，故不加入 TAB_PAGES（不改变任何路由判定逻辑）。
  'pages/favorites/favorites', 'pages/history/history', 'pages/historydetail/historydetail',
  // GY-I13：播报页（语音球与播放生命周期）。同样须与 app.json 的 pages 逐项一致；
  // 不是 Tab，也不接受任何查询参数（本页不从链接取内容来源，见 pages/voice/voice.js）。
  'pages/voice/voice',
  // GY-I12：文字提问页（文字输入 + 显式发送 + 有界轮询 + 回答闸门）。同样须与 app.json 的
  // pages 逐项一致；不是 Tab，也不接受任何查询参数（提问正文只来自用户输入，见 pages/qa/qa.js）。
  'pages/qa/qa',
  // GY-R34 / #29 P1：授权清单页（只读，GET /me/consents）。同样须与 app.json 的 pages 逐项一致；
  // 不是 Tab，也不接受任何查询参数（清单只按当前会话读自己的授权，不认链接参数）。
  'pages/consent/consent']
const TAB_PAGES = ['pages/home/home', 'pages/community/community', 'pages/identify/identify',
  'pages/messages/messages', 'pages/profile/profile']
const HOME = '/pages/home/home'
const LOGIN = '/pages/login/login'
const MAX_PATH_LENGTH = 512
const ID_PAGES = ['/pages/knowledgedetail/knowledgedetail', '/pages/referencedetail/referencedetail', '/pages/referenceseeddetail/referenceseeddetail', '/pages/communitydetail/communitydetail',
  // GY-I16 识别记录详情：只带历史行 id（`?id=<uuid>`），不接受任何状态类参数。
  '/pages/historydetail/historydetail']
// 只接受 uuid 的详情页（避免把任意字符串拼进查询串）。
const UUID_ID_PAGES = ['/pages/knowledgedetail/knowledgedetail', '/pages/communitydetail/communitydetail',
  // GY-I16：识别记录详情同样只接受 uuid（历史行 id）；与页面侧 parseDetailQuery 的校验一致。
  '/pages/historydetail/historydetail']
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
let revision = 0
let returnTo = null

function normalizeTarget(candidate) {
  if (typeof candidate !== 'string' || candidate.length > MAX_PATH_LENGTH) return null
  const parts = candidate.split('?')
  if (parts.length > 2 || PAGES.indexOf(parts[0].slice(1)) === -1 ||
      parts[0].charAt(0) !== '/' || parts[0] === LOGIN) return null
  if (parts.length === 1) return parts[0]
  // 档案入口的结构化条件白名单（⛔ 不是死代码，删掉会把登录回跳目标丢成 HOME）：真消费点是登录回跳——auth.js:550 的 `requireLogin` 用 `navigation.captureCurrent()` 把当前页的 route+options 还原成目标，**由这里放行之后**才存进 returnTo，登录回来再由 auth.js:590 的 `consumeReturnTo` + `openTarget` 打开；不放行 ⇒ 本函数返回 null ⇒ `openTarget` 的 `|| HOME` 兜成首页（用户刚点进来的那组档案筛选条件就丢了）。同时 profile 页「按当前档案查科普资料」（profile.js 的 `openReference`）仍把 crop_id / region_code 传给 pages/reference，该页 `onLoad` 也仍按这两个条件预选筛选（reference.js 的 `_profileFilter`）⇒ 只有该入口改跳 pages/knowledge 之后，才能连同 tests/unit/miniprogram-profile.test.mjs 那条白名单用例一起删。
  if (parts[0] === '/pages/reference/reference' && /^crop_id=[A-Za-z0-9_-]{1,80}&region_code=33[0-9]{4}$/.test(parts[1])) return candidate
  // No arbitrary role/token/user_id/redirect parameters. Only existing detail-page IDs.
  if (ID_PAGES.indexOf(parts[0]) === -1 || !/^id=[A-Za-z0-9_%.-]+$/.test(parts[1])) return null
  let id
  try { id = decodeURIComponent(parts[1].slice(3)) } catch (_) { return null }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null
  if (UUID_ID_PAGES.indexOf(parts[0]) !== -1 && !UUID_PATTERN.test(id)) return null
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
// GY-I28：「我的耕云」的「我的发布」跳到社区（底部 Tab）时要预选「我的投稿」筛选，
// 但 switchTab **不接受**查询参数。这里用一个一次性、仅进程内存在的意图标记把这件事
// 交给社区页消费：不是授权、不落存储、读完即清（与上面的 returnTo 同一设计口径，
// 应用重启即消失；社区页自己仍按门禁与契约 `mine` 参数取数）。
let communityMineIntent = false
function requestCommunityMine() { communityMineIntent = true }
function consumeCommunityMine() {
  const hit = communityMineIntent
  communityMineIntent = false
  return hit
}

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
  currentPage, captureCurrent, requestCommunityMine, consumeCommunityMine,
  openTarget, goLogin }
