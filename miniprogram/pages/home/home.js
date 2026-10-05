const debug = require('../../utils/debug')
const fontScale = require('../../utils/font-scale')
const session = require('../../utils/session')

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
    this.setData({ local: debug.localEnabled(wx), guest: session.isGuest() })
  },

  /** 识别页是 tabBar 页面，只能用 switchTab，不能传参 */
  onEntryTap: function () {
    wx.switchTab({ url: '/pages/identify/identify' })
  },

  diagnose: function () {
    if (this.data.busy) return
    this.setData({ busy: true, status: '正在连接本地诊断服务…' })
    debug.diagnose(wx, (status) => {
      this.setData({ busy: false, status: status })
    })
  }
})
