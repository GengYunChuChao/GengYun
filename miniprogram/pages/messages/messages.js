const auth = require('../../utils/auth')

// 游客门禁：消息属非首页能力，未登录跳转登录页。
Page({
  onShow: function () {
    auth.requireLogin()
  }
})
