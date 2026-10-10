const fontScale = require('../../utils/font-scale')
// GY-I07 科普／除草剂详情页。
//
// 展示：制剂（登记号/持有人/剂型/成分）、条件（作物/场所/防治对象）、风险（毒性/注意事项）、
//       原文来源（发布机构/期号/原始链接/采集日期）、来源版本与更新时间。
// 一致性与边界：
// - 详情与列表使用**同一个 source_version**（同一条记录的同一来源版本）。
// - 未采集字段如实列为「未采集」，**不以空白或模型补写填充**。
// - 不提供用量；不出现"权威认证/绝对安全"等禁用标签；模拟记录强标记。
// - 失效/下架记录：不进入有效查询（列表）；直接访问详情时明确说明不可用原因并支持返回继续查询。

const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const reference = require('../../utils/reference')

Page({
  data: {
    fontScale: 1,
    recordId: '',
    found: false,
    detail: null,
    labels: null,
    verifiedScope: [],
    notCollected: [],
    unavailableReason: '',
    queryable: true,
    modeNote: '',
    // G2：会话门禁状态（未通过服务端核实前恒 false）。
    gatePassed: false
  },

  onLoad: function (options) {
    fontScale.applyFontScale(this)
    this._detailId = options && options.id ? decodeURIComponent(options.id) : ''
    this.checkGate()
  },

  checkGate: function () {
    const recordId = this._detailId || ''
    const self = this
    pageGate.start(this, function (loggedIn) {
      if (!loggedIn) {
        self.setData({ gatePassed: false, recordId: '', found: false, detail: null, labels: null, verifiedScope: [], notCollected: [], unavailableReason: '', queryable: true })
        return
      }
      self.setData({ gatePassed: true, recordId: recordId, modeNote: reference.modeNote() })
      self.load(recordId)
    })
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    if (!auth.isLoggedIn() || !this.data.gatePassed) this.checkGate()
  },
  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

  load: function (recordId) {
    // G2：门禁未通过则**拒绝加载**——不依赖跳转是否成功。
    if (!this.data.gatePassed || !auth.isLoggedIn()) {
      this.setData({ gatePassed: false, found: false, detail: null, labels: null, verifiedScope: [], notCollected: [], unavailableReason: '' })
      return
    }
    const detail = reference.detail(recordId)
    if (!detail) {
      this.setData({ found: false, detail: null })
      return
    }
    this.setData({
      found: true,
      detail: detail,
      labels: detail.labels,
      verifiedScope: detail.verified_scope || [],
      notCollected: detail.not_collected || [],
      unavailableReason: detail.unavailable_reason || '',
      queryable: detail.queryable === true
    })
  },

  backToList: function () {
    wx.navigateBack({ delta: 1 })
  },

  copySource: function () {
    const d = this.data.detail
    if (!d || !d.source || !d.source.original_url) return
    wx.setClipboardData({ data: d.source.original_url })
  }
})
