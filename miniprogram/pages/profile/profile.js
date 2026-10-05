const auth = require('../../utils/auth')

// 游客门禁：我的属非首页能力，未登录跳转登录页。
Page({
  data: { loggedIn: false, status: '' },
  onShow: function () {
    if (!auth.requireLogin()) return
    this.setData({ loggedIn: auth.isLoggedIn() })
  },
  logout: function () {
    const that = this
    auth.logout(function (result) {
      that.setData({ loggedIn: false })
      wx.reLaunch({ url: '/pages/login/login' })
      if (!result.serverRevoked) {
        // 不在页面上谎称服务端会话已撤销。
        wx.showToast({ title: '已清除本地会话', icon: 'none' })
      }
    })
  }
})
