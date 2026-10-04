const session = require('../../utils/session')

Page({
  data: {
    guest: true
  },

  onShow: function () {
    this.setData({ guest: session.isGuest() })
  },

  /** 发布入口占位：社区未接入，不写入任何数据 */
  onPublish: function () {
    wx.showToast({ title: '社区尚未开放', icon: 'none' })
  }
})
