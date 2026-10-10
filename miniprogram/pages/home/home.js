const debug = require('../../utils/debug')
const fontScale = require('../../utils/font-scale')
const auth = require('../../utils/auth')

Page({
  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    entries: [
      { key: 'weed', icon: '🌿', title: '拍草识别', desc: '拍一张照片，识别田里的杂草' },
      { key: 'ocr', icon: '🏷️', title: '农药标签识别', desc: '拍包装，读出药名与成分' },
      { key: 'voice', icon: '🎤', title: '语音提问', desc: '说话提问，也可打字' }
    ],
    guest: true,
    local: false,
    busy: false,
    status: ''
  },

  onLoad: function () {
    fontScale.applyFontScale(this)
    this.setData({ local: debug.localEnabled(wx), guest: !auth.isLoggedIn() })
  },

  /** 页面重新显示时刷新微信字号与已核实的登录状态。 */
  onShow: function () {
    this.setData({ guest: !auth.isLoggedIn(), fontScale: fontScale.currentFontScale() })
  },

  goLogin: function () {
    wx.reLaunch({ url: '/pages/login/login' })
  },

  /** 游客先登录；识别页是 Tab 页面，已核实用户用 switchTab 进入。 */
  onEntryTap: function () {
    if (!auth.isLoggedIn()) {
      this.goLogin()
      return
    }
    wx.switchTab({ url: '/pages/identify/identify' })
  },

  goReference: function () { wx.navigateTo({ url: '/pages/reference/reference' }) },
  goReferenceSeed: function () { wx.navigateTo({ url: '/pages/referenceseed/referenceseed' }) },

  diagnose: function () {
    if (this.data.busy) return
    this.setData({ busy: true, status: '正在连接本地诊断服务…' })
    debug.diagnose(wx, (status) => {
      this.setData({ busy: false, status: status })
    })
  }
})
