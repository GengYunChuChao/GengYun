const fontScale = require('../../utils/font-scale')
const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const api = require('../../utils/knowledge-api')
// These pickers are a labelled bundled directory, never a result fallback.
const cropDoc = require('../../data/crops')
const speciesDoc = require('../../data/species')
const regionDoc = require('../../data/regions')
Page({
  data: { fontScale: 1, gatePassed: false, busy: false, status: '', modeNote: api.modeNote(), items: [], nextCursor: null,
    // GY-I26：状态语气字段，供 state-view 统一渲染 loading／empty／error；idle 表示尚未发起查询
    stateKind: 'idle',
    q: '', cropIndex: 0, speciesIndex: 0, regionIndex: 0, growth_stage: '', planting_method: '', use_scene: '', advanced: false,
    crops: [{ name: '全部作物', id: '' }].concat(cropDoc.crops), species: [{ name: '全部杂草', id: '' }].concat(speciesDoc.species),
    regions: [{ name: '全部地区', code: '' }].concat(regionDoc.regions),
    directoryNote: '筛选目录为随包目录：' + cropDoc.catalog_version + ' / ' + speciesDoc.catalog_version + ' / ' + regionDoc.catalog_version },
  onLoad: function () { fontScale.applyFontScale(this) },
  onShow: function () { fontScale.applyFontScale(this); this.checkGate() },
  onHide: function () { pageGate.cancel(this); this._applied = null; this.setData({ q: '', cropIndex: 0, speciesIndex: 0, regionIndex: 0, growth_stage: '', planting_method: '', use_scene: '' }) },
  onUnload: function () { this.onHide() },
  clear: function () { this._displayBinding = null; this._readOperation = (this._readOperation || 0) + 1; this.setData({ busy: false, items: [], nextCursor: null, modeNote: api.modeNote(), status: '', stateKind: 'idle' }) },
  checkGate: function () {
    pageGate.start(this, ok => { this.clear(); this.setData({ gatePassed: ok }); if (ok) this.read() })
  },
  input: function (e) {
    const field = e.currentTarget.dataset.field
    if (['q', 'growth_stage', 'planting_method', 'use_scene'].indexOf(field) === -1) return
    this.clear(); api.clearSelection(); this.setData({ [field]: e.detail.value })
  },
  pick: function (e) {
    const field = e.currentTarget.dataset.field, index = Number(e.detail.value)
    const entries = { cropIndex: this.data.crops, speciesIndex: this.data.species, regionIndex: this.data.regions }[field]
    if (!entries || !Number.isInteger(index) || index < 0 || index >= entries.length) return
    this.clear(); api.clearSelection(); this.setData({ [field]: index })
  },
  toggle: function () { this.setData({ advanced: !this.data.advanced }) },
  conditions: function () {
    const d = this.data, q = { limit: 20 }
    const values = { q: d.q.trim(), crop_id: d.crops[d.cropIndex].id, species_id: d.species[d.speciesIndex].id, region_code: d.regions[d.regionIndex].code,
      growth_stage: d.growth_stage.trim(), planting_method: d.planting_method.trim(), use_scene: d.use_scene.trim() }
    Object.keys(values).forEach(k => { if (values[k]) q[k] = values[k] }); return api.filters(q, true)
  },
  search: function () { if (this.data.gatePassed) this.read(); else this.checkGate() },
  reset: function () { this.setData({ q: '', cropIndex: 0, speciesIndex: 0, regionIndex: 0, growth_stage: '', planting_method: '', use_scene: '' }); this.search() },
  next: function () { if (!this.data.busy && this.data.nextCursor) this.read(this.data.nextCursor) },
  read: async function (cursor) {
    this.clear(); api.clearSelection()
    if (!this.data.gatePassed || !auth.isLoggedIn()) { this.setData({ gatePassed: false }); this.checkGate(); return }
    const b = api.binding(), operation = this._readOperation
    const current = () => this._gateActive === true && this._readOperation === operation && api.current(b)
    let q
    try {
      q = cursor ? Object.assign({}, this._applied, { cursor }) : this.conditions()
      if (!cursor) this._cursors = []
      if (cursor && this._cursors.indexOf(cursor) !== -1) throw { code: 'INVALID_RESPONSE' }
      this._applied = Object.assign({}, q); delete this._applied.cursor
      this.setData({ busy: true, status: '正在核对当前资料…', stateKind: 'loading' })
      const r = await api.list(q)
      if (!current()) return
      if (r.nextCursor && (this._cursors.indexOf(r.nextCursor) !== -1 || this._cursors.length >= 100)) throw { code: 'INVALID_RESPONSE' }
      if (cursor) this._cursors.push(cursor)
      this._displayBinding = b
      this.setData({ busy: false, nextCursor: r.nextCursor, modeNote: api.modeNote(r.mode),
        items: r.items.map(item => ({ id: item.id, item, labels: api.labels(item), conditionNote: item.conditions ? '适用条件需逐项核对，不能据此推定用量可用。' : '条件资料不足，不能据此确定适用性或用量。' })),
        stateKind: r.items.length ? 'ready' : 'empty',
        status: r.items.length ? '已读取当前页资料；详情会重新核对来源。' : '没有符合条件的资料，请调整条件继续查询。' })
    } catch (e) {
      if (!current()) { if (this._gateActive === true && this._readOperation === operation) { this.clear(); this.setData({ gatePassed: false, status: api.message(e) }) }; return }
      this.setData({ busy: false, items: [], nextCursor: null, status: api.message(e), stateKind: 'error' })
    }
  },
  open: function (e) {
    if (!this.data.gatePassed || !api.current(this._displayBinding) || this.data.busy) { this.clear(); this.setData({ gatePassed: false }); return }
    const id = e.currentTarget.dataset.id, entry = this.data.items.find(x => x.item.id === id)
    if (!entry) return
    api.remember(entry.item, this._applied || {})
    wx.navigateTo({ url: '/pages/knowledgedetail/knowledgedetail?id=' + encodeURIComponent(id) })
  }
})
