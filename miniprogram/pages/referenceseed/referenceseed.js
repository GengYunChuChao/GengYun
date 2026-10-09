// GY-I07 科普资料 · 种子资料浏览页（除草剂名录 / 杂草识别 / 防除时期 / 省份索引）。
//
// 合规口径（强制展示）：
// - 数据为**整理稿**（data_origin=seed_unverified、authority=none）→ 每条常驻「待核实·非权威」标注；
// - **不显示真实用量**；**不授专家认证标签**；**不声称可追溯权威来源**；
// - 缺项**不空白、不模型补写**，统一显示「未采集（种子整理稿无此栏）」。

const auth = require('../../utils/auth')
const reference = require('../../utils/reference')

Page({
  data: {
    tab: 'herbicides',
    tabs: [
      { key: 'herbicides', name: '除草剂' },
      { key: 'weeds', name: '杂草识别' },
      { key: 'controlTiming', name: '防除时期' },
      { key: 'provinces', name: '省份索引' }
    ],
    keyword: '',
    list: [],
    total: 0,
    counts: {},
    label: '',
    dataOrigin: '',
    authority: '',
    disclaimer: '',
    regionConvention: '',
    notCollected: '',
    labels: {}
  },

  onLoad: function () {
    // 门禁前置：会话经服务端核实通过后才装载种子资料（未通过不留任何数据）。
    const self = this
    auth.requireLogin(function (loggedIn) {
      if (!loggedIn) {
        self.setData({ list: [], total: 0 })
        return
      }
      self.setData({
        counts: reference.seed.counts,
        label: reference.seed.label,
        dataOrigin: reference.seed.dataOrigin,
        authority: reference.seed.authority,
        disclaimer: reference.seed.disclaimer,
        regionConvention: reference.seed.regionConvention,
        notCollected: reference.seed.notCollected,
        labels: reference.seedLabels()
      })
      self.refresh()
    })
  },

  onShow: function () {
    // 重入兜底：会话失效则先清列表再跳转。
    if (!auth.isLoggedIn()) {
      this.setData({ list: [], total: 0 })
      auth.requireLogin()
    }
  },

  switchTab: function (event) {
    this.setData({ tab: event.currentTarget.dataset.key, keyword: '' })
    this.refresh()
  },

  onKeyword: function (event) {
    this.setData({ keyword: event.detail.value })
  },

  onSearch: function () {
    this.refresh()
  },

  refresh: function () {
    const tab = this.data.tab
    if (tab === 'herbicides') {
      const list = this.data.keyword ? reference.seedSearch(this.data.keyword) : reference.seed.herbicides
      this.setData({ list: list, total: list.length })
      return
    }
    if (tab === 'weeds') {
      const list = reference.seed.weeds
      this.setData({ list: list, total: list.length })
      return
    }
    if (tab === 'controlTiming') {
      this.setData({ list: reference.seed.controlTiming, total: reference.seed.controlTiming.length })
      return
    }
    this.setData({ list: reference.seed.provinces, total: reference.seed.provinces.length })
  },

  goSeedDetail: function (event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/referenceseeddetail/referenceseeddetail?id=' + encodeURIComponent(id) })
  }
})
