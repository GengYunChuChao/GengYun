const session = require('../../utils/session')
const fontScale = require('../../utils/font-scale')

Page({
  onLoad: function () {
    fontScale.applyFontScale(this)
  },

  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    fontChoices: fontScale.FONT_SCALE_CHOICES,
    guest: true
  },

  onShow: function () {
    this.setData({ guest: session.isGuest(), fontScale: fontScale.currentFontScale() })
  },

  /** 应用内字号选择：写入本地并立即生效，无需登录 */
  onFontScaleTap: function (e) {
    const value = Number(e.currentTarget.dataset.value)
    const applied = fontScale.setFontScale(this, value)
    wx.showToast({ title: '字号已设为「' + fontScale.labelOf(applied) + '」', icon: 'none' })
  },

  /** 登录入口占位：不获取手机号，不调用任何授权接口 */
  onLogin: function () {
    wx.showToast({ title: '登录功能尚未接入', icon: 'none' })
  }
})
