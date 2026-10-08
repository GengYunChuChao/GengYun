const session = require('../../utils/session')
const fontScale = require('../../utils/font-scale')

Page({
  onLoad: function () {
    fontScale.applyFontScale(this)
  },

  data: {
    /** 实际生效系数，注入 --font-scale */
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    /** 用户显式档位；null 表示「跟随系统」，仅用于判断选中态 */
    savedScale: null,
    fontChoices: fontScale.buildChoices(fontScale.DEFAULT_FONT_SCALE),
    guest: true
  },

  onShow: function () {
    const applied = fontScale.currentFontScale()
    this.setData({
      guest: session.isGuest(),
      fontScale: applied,
      savedScale: fontScale.savedScaleValue(),
      fontChoices: fontScale.buildChoices(applied)
    })
  },

  /**
   * 应用内字号选择：写入本地并立即生效，无需登录、无需重启。
   * data-mode 为 auto 时表示「跟随系统」，此时不读 data-value（其值为 null）。
   */
  onFontScaleTap: function (e) {
    const mode = e.currentTarget.dataset.mode
    const applied =
      mode === 'auto'
        ? fontScale.setFontScale(this, null)
        : fontScale.setFontScale(this, Number(e.currentTarget.dataset.value))
    this.setData({ fontScale: applied, savedScale: fontScale.savedScaleValue() })
    const label = fontScale.labelOf(mode === 'auto' ? null : applied)
    wx.showToast({ title: '字号「' + label + '」已应用', icon: 'none', duration: 1200 })
  },

  /** 登录入口占位：不获取手机号，不调用任何授权接口 */
  onLogin: function () {
    wx.showToast({ title: '登录功能尚未接入', icon: 'none' })
  }
})