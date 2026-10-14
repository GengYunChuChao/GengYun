const fontScale = require('../../utils/font-scale')
const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const api = require('../../utils/knowledge-api')
Page({
  data: { fontScale: 1, gatePassed: false, busy: false, item: null, labels: null, status: '', modeNote: api.modeNote(), conditionsText: '',
    // GY-I26：状态语气字段，供 state-view 统一渲染 loading／error；idle 表示尚未发起读取
    stateKind: 'idle' },
  onLoad: function (options) {
    fontScale.applyFontScale(this); this._id = ''
    try { if (options && typeof options.id === 'string' && options.id.length <= 128) { const id = decodeURIComponent(options.id); if (api.validId(id)) this._id = id } } catch (_) {}
  },
  onShow: function () { fontScale.applyFontScale(this); this.checkGate() },
  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },
  clear: function () { this._displayBinding = null; this._readOperation = (this._readOperation || 0) + 1; this.setData({ item: null, labels: null, busy: false, status: '', conditionsText: '', modeNote: api.modeNote(), stateKind: 'idle' }) },
  checkGate: function () { pageGate.start(this, ok => { this.clear(); this.setData({ gatePassed: ok }); if (ok) this.read() }) },
  retry: function () { if (this.data.gatePassed) this.read(); else this.checkGate() },
  read: async function () {
    this.clear()
    if (!this.data.gatePassed || !auth.isLoggedIn()) { this.setData({ gatePassed: false }); this.checkGate(); return }
    if (!this._id) { this.setData({ status: '详情链接格式不正确，请返回列表继续查询。', stateKind: 'error' }); return }
    const b = api.binding(), operation = this._readOperation
    const current = () => this._gateActive === true && this._readOperation === operation && api.current(b)
    try {
      const expected = api.expected(this._id)
      this.setData({ busy: true, status: '正在核对当前来源…', stateKind: 'loading' })
      const r = await api.detail(this._id, expected ? expected.filters : {})
      if (!current()) return
      if (expected && expected.fingerprint !== api.fingerprint(r.item)) { this.setData({ busy: false, status: '资料版本或来源状态已变化，请返回列表重新查询。', modeNote: api.modeNote(r.mode), stateKind: 'error' }); return }
      const c = r.item.conditions
      const names = { crop_id: '作物', region_code: '地区', species_id: '杂草', growth_stage: '生育期', planting_method: '种植方式', use_scene: '使用场景' }
      const conditionsText = c ? Object.keys(names).map(k => names[k] + '：' + (c[k] || '未提供')).join('；') : '条件资料不足，作物／地区等条件未完整提供，不能据此确定适用性或用量。'
      this._displayBinding = b
      this.setData({ item: r.item, labels: api.labels(r.item), busy: false, status: '已重新读取当前资料。', modeNote: api.modeNote(r.mode), conditionsText, stateKind: 'ready' })
    } catch (e) {
      if (!current()) { if (this._gateActive === true && this._readOperation === operation) { this.clear(); this.setData({ gatePassed: false, status: api.message(e) }) }; return }
      this.setData({ item: null, labels: null, busy: false, status: api.message(e), stateKind: 'error' })
    }
  },
  back: function () {
    const operation = this._gateOperation
    wx.navigateBack({ delta: 1, fail: () => { if (this._gateActive === true && this._gateOperation === operation) wx.redirectTo({ url: '/pages/knowledge/knowledge' }) } })
  },
  copySource: function () { if (this._gateActive === true && this.data.gatePassed && api.current(this._displayBinding) && this.data.item) wx.setClipboardData({ data: this.data.item.source.url }) }
})
