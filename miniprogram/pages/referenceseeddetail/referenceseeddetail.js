const fontScale = require('../../utils/font-scale')
// GY-I07 种子资料 · 除草剂详情页。
//
// 强制合规展示：待核实·非权威；危害等级/主要危害/防除对象/适用地区；
// **不显示真实用量**；缺项以「未采集」显式列出（不空白、不补写）；不出现专家认证标签。

const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const reference = require('../../utils/reference')

// External links may contain malformed percent encoding. Reject before lookup,
// but always continue into the existing identity gate and empty state.
function detailId(options) {
  const raw = options && options.id
  if (typeof raw !== 'string' || raw.length > 512) return ''
  try {
    const id = decodeURIComponent(raw)
    return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : ''
  } catch (_) { return '' }
}

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
    this._detailId = detailId(options)
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
    const item = typeof seedId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(seedId) ? reference.seedHerbicideDetail(seedId) : null
    if (!item) {
      this.setData({ found: false, item: null, label: '', labels: {}, notCollected: '' })
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
    const self = this, operation = this._gateOperation
    wx.navigateBack({ delta: 1, fail: function () {
      if (self._gateActive !== true || self._gateOperation !== operation) return
      wx.redirectTo({ url: '/pages/referenceseed/referenceseed' })
    } })
  }
})
