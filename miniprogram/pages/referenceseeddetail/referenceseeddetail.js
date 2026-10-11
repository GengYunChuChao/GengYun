const fontScale = require('../../utils/font-scale')
// GY-I07 种子资料 · 除草剂详情页。
//
// 强制合规展示：待核实·非权威；危害等级/主要危害/防除对象/适用地区；
// **不显示真实用量**；缺项以「未采集」显式列出（不空白、不补写）；不出现专家认证标签。

const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const reference = require('../../utils/reference')

Page({
  data: {
    fontScale: 1,
    found: false,
    item: null,
    label: '',
    labels: {},
    notCollected: '',
    // G2：会话门禁状态（未通过服务端核实前恒 false）。
    gatePassed: false
  },

  onLoad: function (options) {
    fontScale.applyFontScale(this)
    this._detailId = options && options.id ? decodeURIComponent(options.id) : ''
    this.checkGate()
  },

  checkGate: function () {
    const seedId = this._detailId || ''
    const self = this
    pageGate.start(this, function (loggedIn) {
      if (!loggedIn) {
        self.setData({ gatePassed: false, found: false, item: null, label: '', labels: {}, notCollected: '' })
        return
      }
      self.setData({ gatePassed: true })
      self.load(seedId)
    })
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    if (!auth.isLoggedIn() || !this.data.gatePassed) this.checkGate()
  },
  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

  load: function (seedId) {
    // G2：门禁未通过则**拒绝加载**——不依赖跳转是否成功。
    if (!this.data.gatePassed || !auth.isLoggedIn()) {
      this.setData({ gatePassed: false, found: false, item: null, label: '', labels: {}, notCollected: '' })
      return
    }
    const item = reference.seedHerbicideDetail(seedId)
    if (!item) {
      this.setData({ found: false, item: null })
      return
    }
    this.setData({
      found: true,
      item: item,
      label: reference.seed.label,
      labels: reference.seedLabels(),
      notCollected: reference.seed.notCollected
    })
  },

  back: function () {
    wx.navigateBack({ delta: 1 })
  }
})
