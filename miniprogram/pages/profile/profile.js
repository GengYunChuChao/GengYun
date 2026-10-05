const auth = require('../../utils/auth')

// 游客门禁：我的属非首页能力，未登录（或会话未经服务端核实）跳转登录页。
Page({
  data: { loggedIn: false, status: '' },
  onShow: function () {
    const that = this
    auth.requireLogin(function (ok) {
      if (!ok) return
      that.setData({ loggedIn: auth.isLoggedIn() })
    })
  },
  logout: function () {
    const that = this
    auth.logout(function (result) {
      that.setData({ loggedIn: false })
      wx.reLaunch({ url: '/pages/login/login' })
      if (!result.serverRevoked) {
        // 不在页面上谎称服务端会话已撤销：区分「未联网」与「撤销未确认」。
        wx.showToast({
          title: result.serverRevocationUnconfirmed ? '本地已清，服务端撤销未确认' : '已清除本地会话',
          icon: 'none'
        })
      }
    })
  }
})
