const fontScale = require('../../utils/font-scale')
const auth = require('../../utils/auth')
const navigation = require('../../utils/navigation')

Page({
  data: { fontScale: 1, busy: false, loggedIn: false, network: false, status: '', cooldown: 0 },
  onLoad: function () { fontScale.applyFontScale(this) },
  onShow: function () {
    fontScale.applyFontScale(this)
    this._active = true
    this.setData({ loggedIn: auth.isLoggedIn(), network: auth.networkEnabled() })
    // 离页时冷却计时暂停（不把剩余等待时间清零），回到本页按剩余秒数续上。
    if (this._cooldownRemaining > 0) this.resumeCooldown()
  },
  onHide: function () {
    this._active = false
    this.pauseCooldown()
    this._operation = (this._operation || 0) + 1
    if (!this._resuming) {
      const wasBusy = this.data.busy
      // 只有本页确实有一次登录在途时才取消它。普通离页／切后台不是「取消登录」，
      // 更不是退出登录：已核实且仍有效的会话不得被页面生命周期清掉，否则用户
      // 从登录页返回或切后台就会被静默登出；退出登录只走 logout() 的显式撤销。
      // 已登录后再点一次「微信登录」时离页：只作废那次在途重登，保留原有效会话。
      if (wasBusy) auth.cancelLogin(auth.isLoggedIn())
      this.setData({ busy: false, loggedIn: auth.isLoggedIn(),
        status: wasBusy ? '登录已取消，可以重新尝试。' : this.data.status })
    }
    this._resuming = false
  },
  onUnload: function () {
    if (this._active !== false) this.onHide()
    // 页面销毁：停表并丢弃剩余秒数（不再 setData）。
    this.pauseCooldown()
    this._cooldownRemaining = 0
  },
  login: function () {
    // 冷却期内按钮本已 disabled，这里再挡一道：连点/键盘触发也不会打满 429 窗口。
    if (this.data.busy || this.data.cooldown > 0) return
    const that = this
    const operation = this._operation = (this._operation || 0) + 1
    this.setData({ busy: true, status: '正在微信登录…' })
    auth.login(function (error, navigationId, retryAfter) {
      if (that._active === false || that._operation !== operation) return
      if (error) {
        that.setData({ busy: false, loggedIn: auth.isLoggedIn(), status: error })
        // 429：文案已由 retryAfterText 给出秒数，这里把同一个秒数落成界面状态（按钮按秒冷却）。
        if (retryAfter > 0) that.startCooldown(retryAfter)
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
  // 429 冷却状态机（最小实现）：拿到秒数即禁用按钮，每秒递减，到 0 恢复可点。
  startCooldown: function (seconds) {
    const remaining = Math.ceil(Number(seconds))
    if (!Number.isFinite(remaining) || remaining <= 0) return
    this.stopCooldown()
    this._cooldownRemaining = remaining
    this.setData({ cooldown: remaining })
    this.armCooldown()
  },
  resumeCooldown: function () {
    if (!(this._cooldownRemaining > 0)) return
    this.armCooldown()
  },
  armCooldown: function () {
    if (this._cooldownTimer) return
    const that = this
    this._cooldownTimer = setInterval(function () {
      const next = (that._cooldownRemaining || 0) - 1
      if (next <= 0) { that.stopCooldown(); return }
      that._cooldownRemaining = next
      that.setData({ cooldown: next })
    }, 1000)
  },
  pauseCooldown: function () {
    if (this._cooldownTimer) { clearInterval(this._cooldownTimer); this._cooldownTimer = null }
  },
  stopCooldown: function () {
    this.pauseCooldown()
    this._cooldownRemaining = 0
    if (this.data.cooldown !== 0) this.setData({ cooldown: 0 })
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
