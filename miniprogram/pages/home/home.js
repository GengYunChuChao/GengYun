const auth = require('../../utils/auth')
const debug = require('../../utils/debug')

// 首页是唯一允许游客预览的页面；其他页面与接口需登录。
Page({
  data: { local: false, busy: false, loggedIn: false, status: '开发准备工程：识别、社区、消息与我的等业务尚未接入。' },
  onShow: function () { this.setData({ loggedIn: auth.isLoggedIn() }) },
  onLoad: function () { this.setData({ local: debug.localEnabled(wx) }) },
  goLogin: function () { wx.reLaunch({ url: '/pages/login/login' }) },
  diagnose: function () {
    if (this.data.busy) return
    this.setData({ busy: true, status: '正在连接本地诊断服务…' })
    debug.diagnose(wx, (status) => { this.setData({ busy: false, status: status }) })
  }
})
