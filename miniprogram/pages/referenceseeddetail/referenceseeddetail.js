// GY-I07 种子资料 · 除草剂详情页。
//
// 强制合规展示：待核实·非权威；危害等级/主要危害/防除对象/适用地区；
// **不显示真实用量**；缺项以「未采集」显式列出（不空白、不补写）；不出现专家认证标签。

const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const reference = require('../../utils/reference')

Page({
  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
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
    const seedId = options && options.id ? decodeURIComponent(options.id) : ''
    // 门禁前置：会话经服务端核实通过后才加载种子详情（未通过不留任何数据）。
    const self = this
    auth.requireLogin(function (loggedIn) {
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
    // 重入兜底：会话失效则先清详情再跳转。
    if (!auth.isLoggedIn()) {
      this.setData({ gatePassed: false, found: false, item: null })
      auth.requireLogin()
    }
  },

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
