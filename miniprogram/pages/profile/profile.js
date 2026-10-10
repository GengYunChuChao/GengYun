const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')

Page({
  onLoad: function () {
    fontScale.applyFontScale(this)
  },

  data: {
    /** 生效的缩放系数，注入 --font-scale；取自微信字体设置 */
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

  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

  /** 复用 main 的独立登录页，不在界面层声明身份。 */
  onLogin: function () {
    wx.reLaunch({ url: '/pages/login/login' })
  },

  logout: function () {
    const that = this
    auth.logout(function (result) {
      that.setData({ guest: true })
      wx.reLaunch({ url: '/pages/login/login' })
      if (!result.serverRevoked) {
        wx.showToast({
          title: result.serverRevocationUnconfirmed ? '本地已清，服务端撤销未确认' : '已清除本地会话',
          icon: 'none'
        })
      }
    })
  }
})