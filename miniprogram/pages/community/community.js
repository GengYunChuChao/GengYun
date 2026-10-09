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
    // 每次进入先关闭入口，服务端核实成功后才显示登录区。
    const that = this
    this.setData({ guest: true, fontScale: fontScale.currentFontScale() })
    auth.requireLogin(function (ok) {
      if (!ok) return
      that.setData({ guest: !auth.isLoggedIn() })
    })
  },

  /** 发布入口占位：社区未接入，不写入任何数据 */
  onPublish: function () {
    wx.showToast({ title: '社区尚未开放', icon: 'none' })
  }
})
