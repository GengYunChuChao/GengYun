const fontScale = require('../../utils/font-scale')
const auth = require('../../utils/auth')
const debug = require('../../utils/debug')
const navigation = require('../../utils/navigation')

// 首页是唯一允许游客预览的页面；其他页面与接口需登录。
Page({
  // 入口图标改用样式层的 demo 线性图标（styles/icons.wxss，几何取自 docs/ui-demo 的
  // SVG path 数据）；数量保持三个已确认入口，不为对齐 demo 的四宫格补虚构入口。
  data: { fontScale: 1, guest: true, entries: [
      { key: 'weed', iconClass: 'gy-icon--leaf', title: '拍草识别', desc: '拍一张照片，识别田里的杂草' },
      { key: 'ocr', iconClass: 'gy-icon--tag', title: '农药标签识别', desc: '拍包装，读出药名与成分' },
      { key: 'voice', iconClass: 'gy-icon--mic', title: '语音提问', desc: '说话提问，也可打字' }
    ], local: false, busy: false, loggedIn: false, status: '开发准备工程：识别、社区、消息与我的等业务尚未接入。' },
  onShow: function () {
    this._active = true
    const action = this._action = (this._action || 0) + 1
    fontScale.applyFontScale(this)
    this.setData({ loggedIn: false, guest: true })
    auth.verifySession((verified) => {
      if (this._active && this._action === action) this.setData({ loggedIn: verified, guest: !verified })
    })
  },
  onLoad: function () { fontScale.applyFontScale(this); this.setData({ local: debug.localEnabled(wx) }) },
  onHide: function () {
    this._active = false
    this._action = (this._action || 0) + 1
    if (!this._handoff) navigation.clearReturnTo(this._navigation)
    this._handoff = false
  },
  onUnload: function () { if (this._active !== false) this.onHide() },
  goLogin: function () {
    this._action = (this._action || 0) + 1
    const op = navigation.beginReturnTo(null)
    this._navigation = op.id
    this._handoff = true
    navigation.goLogin(op.id)
  },
  onEntryTap: function () { this.openGated('/pages/identify/identify') },
  goKnowledge: function () { this.openGated('/pages/knowledge/knowledge') },
  goReference: function () { this.openGated('/pages/reference/reference') },
  goReferenceSeed: function () { this.openGated('/pages/referenceseed/referenceseed') },
  /** 样式走查页：仅在本地替身工程可见（debug.localEnabled）；页内自会再判一次 */
  goSpecimen: function () { wx.navigateTo({ url: '/pages/specimen/specimen' }) },
  openGated: function (target) {
    const op = navigation.beginReturnTo(target)
    const action = this._action = (this._action || 0) + 1
    this._navigation = op.id
    this._handoff = false
    const current = () => this._active !== false && this._action === action
    auth.verifySession((verified, stale) => {
      if (!current() || stale) return
      // A current rejected session may have cleared its old intent.
      if (!navigation.isCurrent(op.id)) {
        op.id = navigation.beginReturnTo(op.target).id
        this._navigation = op.id
      }
      this.setData({ loggedIn: verified, guest: !verified })
      if (verified) {
        const destination = navigation.consumeReturnTo(op.id)
        navigation.openTarget(destination, false, (error) => {
          if (current() && error) this.setData({ status: error })
        })
        return
      }
      wx.showModal({ title: '需要登录', content: '该功能需要微信登录后使用，现在去登录吗？',
        confirmText: '去登录', cancelText: '暂不',
        success: (result) => {
          if (!current() || !navigation.isCurrent(op.id)) return
          if (result.confirm) { this._handoff = true; navigation.goLogin(op.id) }
          else navigation.clearReturnTo(op.id)
        },
        fail: () => { if (current()) navigation.clearReturnTo(op.id) }
      })
    })
  },
  diagnose: function () {
    if (this.data.busy) return
    this.setData({ busy: true, status: '正在连接本地诊断服务…' })
    debug.diagnose(wx, (status) => { this.setData({ busy: false, status: status }) })
  }
})
