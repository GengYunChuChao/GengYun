const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')

Page({
  data: { busy: false, loggedIn: false, network: false, status: '', fontScale: fontScale.DEFAULT_FONT_SCALE },

  onLoad: function () {
    fontScale.applyFontScale(this)
  },
  onShow: function () {
    this.setData({
      loggedIn: auth.isLoggedIn(),
      network: auth.networkEnabled(),
      fontScale: fontScale.currentFontScale()
    })
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
      let status
      if (result.serverRevoked) {
        status = '已退出登录（服务端会话已撤销）。'
      } else if (result.serverRevocationUnconfirmed) {
        // 服务端撤销未被契约成功 Ack 确认：如实上报，不谎称已撤销。
        status = '已清除本地会话（服务端会话撤销未确认，请稍后重试或检查网络）。'
      } else {
        status = '已清除本地会话（未联网，服务端会话未撤销）。'
      }
      that.setData({ loggedIn: false, status: status })
    })
  }
})
