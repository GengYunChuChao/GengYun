const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')

Page({
  onLoad: function () {
    fontScale.applyFontScale(this)
  },

  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    guest: true
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    // 每次进入先关闭入口，服务端核实成功后才显示登录区。
    const that = this
    this.setData({ guest: true, fontScale: fontScale.currentFontScale() })
    pageGate.start(this, function (ok) {
      that.setData({ guest: !ok })
    })
  },
  // GY-I04 6-A：游客态共享 state-view 的「去登录」必须真正可点 —— 与 page-gate 同一口径
  // （登记本页为返回目标 → reLaunch 登录页），登录成功后回到消息页；门禁拦截语义不变。
  // N1（对抗性审查 §4）：核实成功（ok）说明会话已获服务端确认 ⇒ 取消被本次核实取代的旧
  // 门禁周期，并按「重新进入本页」重跑门禁，让页面可见地放行（改前此处无任何可见反应）。
  onLogin: function () {
    const self = this
    auth.requireLogin(function (ok) { if (ok) { pageGate.cancel(self); self.onShow() } })
  },
  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) }
})
