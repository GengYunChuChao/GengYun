const fontScale = require('../../utils/font-scale')
// GY-I07 科普资料 · 种子资料浏览页（除草剂名录 / 杂草识别 / 防除时期 / 省份索引）。
//
// 合规口径（强制展示）：
// - 数据为**整理稿**（data_origin=seed_unverified、authority=none）→ 每条常驻「待核实·非权威」标注；
// - **不显示真实用量**；**不授专家认证标签**；**不声称可追溯权威来源**；
// - 缺项**不空白、不模型补写**，统一显示「未采集（种子整理稿无此栏）」。

const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const reference = require('../../utils/reference')

Page({
  data: {
    fontScale: 1,
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
    // #28 空内容态文案（由 refresh 按「有无检索词」决定，wxml 只渲染，不在模板里拼字符串）。
    emptyTitle: '',
    emptyDesc: '',
    labels: {},
    // G2：会话门禁状态（未通过服务端核实前恒 false）。
    gatePassed: false
  },

  onLoad: function () {
    fontScale.applyFontScale(this); this.checkGate() },

  checkGate: function () {
    const self = this
    pageGate.start(this, function (loggedIn) {
      if (!loggedIn) {
        self.setData({ gatePassed: false, list: [], total: 0 })
        return
      }
      self.setData({
        gatePassed: true,
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
    fontScale.applyFontScale(this)
    if (!auth.isLoggedIn() || !this.data.gatePassed) this.checkGate()
  },
  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

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

  /**
   * 空内容态的文案（#28）：说清**为什么空**与**下一步做什么**，不补写任何条目。
   * 有检索词 ⇒ 只在除草剂名录里按药名／别称匹配（不合并不同记录），出口是清空检索词看全部；
   * 无检索词 ⇒ 该栏整理稿暂时没有条目，出口是回除草剂名录或换栏目。
   */
  emptyCopy: function (keyword, count) {
    if (count > 0) return { title: '', desc: '' }
    if (keyword) return {
      title: '没有匹配「' + keyword + '」的记录',
      desc: '检索只在除草剂名录里按药名／别称匹配，不合并不同记录，也不会用近似条目顶替。'
        + '可清空检索词看全部名录，或回首页用「识草查药」按作物／杂草／地区查询。'
    }
    return {
      title: '这一栏还没有条目',
      desc: '这一栏的整理稿里暂时没有可展示的记录（不补写、不用近似条目顶替）。'
        + '可切换到其他栏目查看，或回首页用「识草查药」按作物／杂草／地区查询。'
    }
  },

  refresh: function () {
    const tab = this.data.tab
    // G2：门禁未通过则**拒绝装载**——不依赖跳转是否成功。
    if (!this.data.gatePassed || !auth.isLoggedIn()) {
      this.setData({ gatePassed: false, list: [], total: 0, emptyTitle: '', emptyDesc: '' })
      return
    }
    let list
    if (tab === 'herbicides') {
      list = this.data.keyword ? reference.seedSearch(this.data.keyword) : reference.seed.herbicides
    } else if (tab === 'weeds') {
      list = reference.seed.weeds
    } else if (tab === 'controlTiming') {
      list = reference.seed.controlTiming
    } else {
      list = reference.seed.provinces
    }
    const empty = this.emptyCopy(this.data.keyword, list.length)
    this.setData({ list: list, total: list.length, emptyTitle: empty.title, emptyDesc: empty.desc })
  },

  // 空态的动作按钮：有关键词先清空检索词看全部；没有关键词则回除草剂名录。
  emptyAction: function () {
    if (this.data.keyword) { this.setData({ keyword: '' }); this.refresh(); return }
    this.setData({ tab: 'herbicides', keyword: '' }); this.refresh()
  },

  goSeedDetail: function (event) {
    const id = event.currentTarget.dataset.id
    if (!id) return
    // 跳转失败必须可见（页面栈满／路由被拦截时，点了条目毫无反应会被当成「条目不存在」）。
    wx.navigateTo({
      url: '/pages/referenceseeddetail/referenceseeddetail?id=' + encodeURIComponent(id),
      fail: function () { wx.showToast({ title: '没能打开这条资料，请重试', icon: 'none' }) }
    })
  }
})
