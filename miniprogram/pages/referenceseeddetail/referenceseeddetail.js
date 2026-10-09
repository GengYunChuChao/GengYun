// GY-I07 种子资料 · 除草剂详情页。
//
// 强制合规展示：待核实·非权威；危害等级/主要危害/防除对象/适用地区；
// **不显示真实用量**；缺项以「未采集」显式列出（不空白、不补写）；不出现专家认证标签。

const auth = require('../../utils/auth')
const reference = require('../../utils/reference')

Page({
  data: {
    found: false,
    item: null,
    label: '',
    labels: {},
    notCollected: ''
  },

  onLoad: function (options) {
    const seedId = options && options.id ? decodeURIComponent(options.id) : ''
    // 门禁前置：会话经服务端核实通过后才加载种子详情（未通过不留任何数据）。
    const self = this
    auth.requireLogin(function (loggedIn) {
      if (!loggedIn) {
        self.setData({ found: false, item: null, label: '', labels: {}, notCollected: '' })
        return
      }
      const item = reference.seedHerbicideDetail(seedId)
      if (!item) {
        self.setData({ found: false, item: null })
        return
      }
      self.setData({
        found: true,
        item: item,
        label: reference.seed.label,
        labels: reference.seedLabels(),
        notCollected: reference.seed.notCollected
      })
    })
  },

  onShow: function () {
    // 重入兜底：会话失效则先清详情再跳转。
    if (!auth.isLoggedIn()) {
      this.setData({ found: false, item: null })
      auth.requireLogin()
    }
  },

  back: function () {
    wx.navigateBack({ delta: 1 })
  }
})
