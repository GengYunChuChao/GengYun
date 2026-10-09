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
    const item = reference.seedHerbicideDetail(seedId)
    if (!item) {
      this.setData({ found: false })
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

  onShow: function () {
    if (!auth.isLoggedIn()) auth.requireLogin()
  },

  back: function () {
    wx.navigateBack({ delta: 1 })
  }
})
