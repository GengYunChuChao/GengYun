const auth = require('../../utils/auth')
const navigation = require('../../utils/navigation')

Page({
  data: { busy: false, loggedIn: false, network: false, status: '' },
  onShow: function () {
    this._active = true
    this.setData({ loggedIn: auth.isLoggedIn(), network: auth.networkEnabled() })
  },
  onHide: function () {
    this._active = false
    this._operation = (this._operation || 0) + 1
    if (!this._resuming) auth.cancelLogin()
    this._resuming = false
  },
  onUnload: function () { if (this._active !== false) this.onHide() },
  login: function () {
    if (this.data.busy) return
    const that = this
    const operation = this._operation = (this._operation || 0) + 1
    this.setData({ busy: true, status: '正在微信登录…' })
    auth.login(function (error, navigationId) {
      if (that._active === false || that._operation !== operation) return
      if (error) {
        that.setData({ busy: false, loggedIn: auth.isLoggedIn(), status: error })
        return
      }
      that.setData({ busy: false, loggedIn: true, status: '登录成功。' })
      that._resuming = true
      if (!auth.resumeAfterLogin(navigationId, function (navigationError) {
        if (that._operation === operation && navigationError) that.setData({ status: navigationError })
      })) {
        that._resuming = false
        that.setData({ status: '登录返回目标已变更，请重新选择入口。' })
      }
    })
  },
  browseAsGuest: function () {
    this._operation = (this._operation || 0) + 1
    auth.cancelLogin()
    this.setData({ busy: false, loggedIn: false })
    navigation.openTarget(navigation.HOME, true)
  },
  logout: function () {
    const that = this
    const operation = this._operation = (this._operation || 0) + 1
    this.setData({ busy: false })
    auth.logout(function (result) {
      if (that._active === false || that._operation !== operation) return
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
