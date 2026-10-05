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
    this.setData({ guest: session.isGuest(), fontScale: fontScale.currentFontScale() })
  },

  /** 发布入口占位：社区未接入，不写入任何数据 */
  onPublish: function () {
    wx.showToast({ title: '社区尚未开放', icon: 'none' })
  }
})
