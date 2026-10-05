const session = require('../../utils/session')
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
    this.setData({ guest: session.isGuest() })
  },

  /** 登录入口占位：不获取手机号，不调用任何授权接口 */
  onLogin: function () {
    wx.showToast({ title: '登录功能尚未接入', icon: 'none' })
  }
})
