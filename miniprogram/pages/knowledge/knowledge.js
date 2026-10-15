const fontScale = require('../../utils/font-scale')
const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const api = require('../../utils/knowledge-api')
const profileApi = require('../../utils/profile-api')
// These pickers are a labelled bundled directory, never a result fallback.
const cropDoc = require('../../data/crops')
const speciesDoc = require('../../data/species')
const regionDoc = require('../../data/regions')
// 地区层级口径（GY-I05 / GY-I07）：**资料只登记到省级**（packages/reference/zhejiang.mjs 的
// ZHEJIANG_PROVINCE_CODE = '330000'），而档案保存的地区必然是**市/县级码**
// （pages/profile/profile.js 保存的是所选市或县）。因此：
//   · 档案地区属于浙江省 ⇒ 查询按 330000 发，并在页面**明示**「当前资料只登记到省级」；
//   · 档案地区不在浙江省／核不出层级 ⇒ **不得**强行按 330000 查询，给出如实的未收录提示。
// 绝不把省级证据包装成"本地适用"。
const PROVINCE_CODE = '330000'
const ZHEJIANG = /^33[0-9]{4}$/
const PROVINCE_NOTE = '当前资料只登记到省级，已按浙江省查询。'
const EMPTY_PROFILE_NOTE = '我的档案还没有作物和地区，本次没有预置筛选。'
const UNREADABLE_NOTE = '未能读取我的档案，本次没有按档案预置筛选；可在下面手选条件查询。'
const OUT_OF_COVERAGE = '当前资料仅覆盖浙江省，只登记到省级（' + PROVINCE_CODE + '），核不到你档案里的地区是否在覆盖范围内。'
  + '本页没有用省级资料代替你的档案地区查询；可回「我的」改选浙江省内地区，或点「清空条件继续查询」用手选条件查询。'
Page({
  data: { fontScale: 1, gatePassed: false, busy: false, status: '', modeNote: api.modeNote(), items: [], nextCursor: null,
    // GY-I26：状态语气字段，供 state-view 统一渲染 loading／empty／error；idle 表示尚未发起查询
    stateKind: 'idle',
    // 档案预置（GY-I05/07）：profileState = idle 未读／applied 已按档案预置／none 档案为空／
    // unread 读不到档案／out-of-coverage 档案地区核不出（不按 330000 代查）。
    profileState: 'idle', profileNote: '',
    q: '', cropIndex: 0, speciesIndex: 0, regionIndex: 0, growth_stage: '', planting_method: '', use_scene: '', advanced: false,
    crops: [{ name: '全部作物', id: '' }].concat(cropDoc.crops), species: [{ name: '全部杂草', id: '' }].concat(speciesDoc.species),
    regions: [{ name: '全部地区', code: '' }].concat(regionDoc.regions),
    directoryNote: '筛选目录为随包目录：' + cropDoc.catalog_version + ' / ' + speciesDoc.catalog_version + ' / ' + regionDoc.catalog_version },
  onLoad: function () { fontScale.applyFontScale(this) },
  onShow: function () { fontScale.applyFontScale(this); this.checkGate() },
  onHide: function () { pageGate.cancel(this); this._applied = null; this._preset = null; this.setData({ q: '', cropIndex: 0, speciesIndex: 0, regionIndex: 0, growth_stage: '', planting_method: '', use_scene: '', profileState: 'idle', profileNote: '' }) },
  onUnload: function () { this.onHide() },
  clear: function () {
    this._displayBinding = null
    this._readOperation = (this._readOperation || 0) + 1
    // 任何一次用户操作都作废在途的档案预置：迟到的档案结果不得覆盖手选条件。
    this._prepareOperation = (this._prepareOperation || 0) + 1
    this.setData({ busy: false, items: [], nextCursor: null, modeNote: api.modeNote(), status: '', stateKind: 'idle' })
  },
  checkGate: function () {
    pageGate.start(this, ok => { this.clear(); this.setData({ gatePassed: ok }); if (ok) this.prepare() })
  },
  /**
   * 登录门通过后**只读一次**「我的档案」（不轮询、不落本地存储）：把档案的作物/地区预置成页面筛选，
   * 再发起**首次查询**（查询串因此带上预置条件）。读不到档案就如实说明"本次未按档案预置"，
   * 绝不用别的条件顶替，也绝不把省级资料说成档案地区的适用性。
   */
  prepare: function () {
    const self = this
    const op = this._prepareOperation = (this._prepareOperation || 0) + 1
    const live = function () { return self._gateActive === true && self._prepareOperation === op }
    if (!auth.isLoggedIn()) { this.setData({ gatePassed: false }); this.checkGate(); return }
    profileApi.read().then(function (p) { if (live()) self.applyProfile(p) }, function (e) {
      if (!live()) return
      const code = e && e.code
      if (code === 'SESSION_REQUIRED' || code === 'SESSION_CHANGED') { self.setData({ gatePassed: false }); self.checkGate(); return }
      // 档案响应对不上冻结契约：当前契约把 region_code 钉在 ^33[0-9]{4}$（浙江省）且作物/地区
      // 必须同时设置，因此这一支就是"档案地区核不出／不在浙江省内"⇒ 不查询，也不拿省级资料顶替。
      if (code === 'INVALID_RESPONSE') { self.outOfCoverage(); return }
      self._preset = null
      self.setData({ profileState: 'unread', profileNote: UNREADABLE_NOTE })
      self.read()
    })
  },
  /**
   * 档案地区不在当前资料的覆盖范围（或核不出层级）：**不发起查询**，给出如实的未收录提示。
   * 地区口径见文件头：不得把省级证据包装成档案地区的本地适用性。
   */
  outOfCoverage: function () {
    this._preset = null
    this.setData({ profileState: 'out-of-coverage', profileNote: '', status: OUT_OF_COVERAGE, stateKind: 'out-of-coverage' })
  },
  /**
   * 把档案预置成页面筛选（`cropIndex`／`regionIndex`，首位"全部"语义不变）。
   * 省内档案地区一律预置成**省级** `330000` 并在提示里明示层级——页面下拉显示的查询口径
   * 与实际发出的 `region_code` 始终一致，不出现"显示上城区、实查 330000"的错位。
   */
  applyProfile: function (p) {
    const d = this.data
    if (p.crop_id === null && p.region_code === null) {
      // 空档案：不预置任何筛选，与"没有档案"时的既有行为一致。
      this._preset = null
      this.setData({ profileState: 'none', profileNote: EMPTY_PROFILE_NOTE })
      this.read()
      return
    }
    if (p.region_code !== null && !ZHEJIANG.test(p.region_code)) { this.outOfCoverage(); return }
    const cropIndex = d.crops.findIndex(function (c) { return c.id === p.crop_id })
    const cropName = cropIndex === -1 ? '档案作物不在当前随包目录' : d.crops[cropIndex].name
    const region = d.regions.find(function (r) { return r.code === p.region_code })
    const regionName = region ? region.name : '地区码 ' + p.region_code
    const provinceIndex = d.regions.findIndex(function (r) { return r.code === PROVINCE_CODE })
    const preset = { cropIndex: cropIndex === -1 ? 0 : cropIndex, regionIndex: provinceIndex < 1 ? 0 : provinceIndex,
      note: '来自我的档案：' + cropName + ' · ' + regionName + '；' + (provinceIndex < 1 ? '随包地区目录里没有省级项，本次没有预置地区筛选。' : PROVINCE_NOTE) }
    this._preset = preset
    this.setData({ cropIndex: preset.cropIndex, regionIndex: preset.regionIndex, profileState: 'applied', profileNote: preset.note })
    this.read()
  },
  /** 手选改了作物/地区后，"来自我的档案"这行不再描述当前条件 ⇒ 如实撤下（改回预置再显示）。 */
  syncProfileNote: function () {
    if (this.data.profileState !== 'applied' || !this._preset) return
    const same = this.data.cropIndex === this._preset.cropIndex && this.data.regionIndex === this._preset.regionIndex
    const note = same ? this._preset.note : ''
    if (note !== this.data.profileNote) this.setData({ profileNote: note })
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
    if (field === 'cropIndex' || field === 'regionIndex') this.syncProfileNote()
  },
  toggle: function () { this.setData({ advanced: !this.data.advanced }) },
  conditions: function () {
    const d = this.data, q = { limit: 20 }
    const values = { q: d.q.trim(), crop_id: d.crops[d.cropIndex].id, species_id: d.species[d.speciesIndex].id, region_code: d.regions[d.regionIndex].code,
      growth_stage: d.growth_stage.trim(), planting_method: d.planting_method.trim(), use_scene: d.use_scene.trim() }
    Object.keys(values).forEach(k => { if (values[k]) q[k] = values[k] }); return api.filters(q, true)
  },
  search: function () { if (this.data.gatePassed) this.read(); else this.checkGate() },
  reset: function () { this.setData({ q: '', cropIndex: 0, speciesIndex: 0, regionIndex: 0, growth_stage: '', planting_method: '', use_scene: '' }); this.syncProfileNote(); this.search() },
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
