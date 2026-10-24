// GY-R34（#29 P1 前端腿）· 授权清单页（**只读**）。
//
// 数据来源：契约 `GET /me/consents`（服务端读面已在 main：services/api/src/routes/consents.ts），
// 经 `utils/consent-api.js` 读取。本页只**看**，不提供授予 / 撤回——那需要 `policy_version`、
// `recipient_ids`、`If-Match`、`Idempotency-Key` 与政策正文，属于 P2；本页没有开关，也不写"随时撤回"。
//
// 硬口径：
//   - **失败不折叠成空列表**：读取失败时清空 items，同时给出 errorText + errorCode，由 state-view
//     按 error / denied / guest 呈现。空态只在服务端**确实**返回 0 条时出现，文案是「尚未授权任何用途」：
//     "没读到"和"没授权"是两件事，页面必须能分开，否则用户会以为自己的授权丢了。
//   - 用途名只来自契约枚举的短名映射（`consent-api.PURPOSE_LABELS`）并**同时显示原码**；
//     页面不写政策正文、不解释某项授权覆盖哪些数据。
//   - `policy_version` 原样展示，不判断是否最新版、不写"已同意最新版"。
const fontScale = require('../../utils/font-scale')
const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const consentApi = require('../../utils/consent-api')

const PAGE_SIZE = 20

Page({
  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    gatePassed: false,
    checking: true,
    networkOff: false,
    busy: false,
    loading: false,
    mode: '',
    modeText: '',
    /** 最近一次读取失败的页面文案（与 errorCode 同时给出；两者都空才是"读取成功"）。 */
    errorText: '',
    /** 最近一次读取失败的契约错误码（交给 state-view 的 errorCode 决定 401/403 语气）。 */
    errorCode: '',
    items: [],
    nextCursor: null
  },

  onLoad: function () {
    fontScale.applyFontScale(this)
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    const self = this
    self.setData({
      gatePassed: false, checking: true, items: [], nextCursor: null,
      errorText: '', errorCode: '', mode: '', modeText: ''
    })
    pageGate.start(this, function (ok) {
      self.setData({ checking: false })
      if (!ok) { self.setData({ gatePassed: false }); return }
      self.setData({ gatePassed: true, networkOff: !auth.networkEnabled() })
      if (auth.networkEnabled()) self.load('')
    })
  },

  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

  /** 读取一页：`cursor` 为空即重新读取第一页（并丢弃已有行）。失败一律清空，不保留旧列表冒充最新。 */
  load: function (cursor) {
    const self = this
    const first = !cursor
    self.setData({ busy: true, loading: true, errorText: '', errorCode: '' })
    consentApi.listConsents({ cursor: cursor, limit: PAGE_SIZE }).then(function (result) {
      const rows = result.items.map(function (item) { return consentApi.consentView(item) })
      self.setData({
        busy: false,
        loading: false,
        mode: result.mode,
        modeText: result.mode === 'real' ? '' : consentApi.modeNote(result.mode),
        items: first ? rows : self.data.items.concat(rows),
        nextCursor: result.nextCursor
      })
    }).catch(function (error) {
      self.setData({
        busy: false, loading: false, items: [], nextCursor: null,
        errorText: consentApi.message(error),
        errorCode: (error && error.code) || '',
        mode: '', modeText: ''
      })
    })
  },

  // 与 favorites / history 同名同义（wxml 里「重新读取」按钮走 onRefresh）。
  onRefresh: function () {
    if (this.data.busy || !this.data.gatePassed) return
    if (this.data.networkOff) return
    this.load('')
  },

  onMore: function () {
    if (this.data.busy || !this.data.nextCursor) return
    this.load(this.data.nextCursor)
  },

  // 门禁动作与 favorites / history 同一口径：未登录时 requireLogin 已跳登录页（可见），
  // 已获服务端确认 ⇒ 取消被本次核实取代的旧门禁周期，并按"重新进入本页"重跑。
  onLogin: function () {
    const self = this
    auth.requireLogin(function (ok) { if (ok) { pageGate.cancel(self); self.onShow() } })
  }
})