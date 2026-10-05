const auth = require('../../utils/auth')

Page({
  data: { busy: false, loggedIn: false, network: false, status: '' },
  onShow: function () {
    this.setData({ loggedIn: auth.isLoggedIn(), network: auth.networkEnabled() })
  },
  login: function () {
    if (this.data.busy) return
    const that = this
    this.setData({ busy: true, status: '正在微信登录…' })
    auth.login(function (error) {
      if (error) {
        that.setData({ busy: false, loggedIn: auth.isLoggedIn(), status: error })
        return
      }
      that.setData({ busy: false, loggedIn: true, status: '登录成功。' })
      wx.reLaunch({ url: '/pages/home/home' })
    })
  },
  browseAsGuest: function () {
    wx.reLaunch({ url: '/pages/home/home' })
  },
  logout: function () {
    const that = this
    auth.logout(function (result) {
      that.setData({
        loggedIn: false,
        status: result.serverRevoked ? '已退出登录（服务端会话已撤销）。' : '已清除本地会话（联网未启用，服务端会话未撤销）。'
      })
    })
  }
})
