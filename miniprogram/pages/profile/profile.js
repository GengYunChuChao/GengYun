const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const api = require('../../utils/profile-api')
function empty() { return { profile: null, crops: [], regions: [], cities: [], counties: [], cropIndex: -1, cityIndex: -1, countyIndex: -1, cropName: '未设置', regionName: '未设置', editing: false, busy: false, loaded: false, message: '', needsReload: false, retryPending: false } }
function message(code) {
  const messages = { REVISION_CONFLICT: '档案版本已变化，请重新读取并确认。', IDEMPOTENCY_CONFLICT: '保存请求已冲突，请重新读取并确认。', INVALID_CURSOR: '目录版本已变化，请重新读取。', INVALID_REQUEST: '所选目录已不可用，请重新读取后选择。', NETWORK_UNCERTAIN: '网络中断，保存结果未确认。', REQUEST_IN_PROGRESS: '这次保存仍在处理，请稍后重试同一次保存。', PROVIDER_UNAVAILABLE: '档案服务暂不可用。', PROVIDER_TIMEOUT: '档案服务超时。' }
  return messages[code] || '档案暂时无法读取或保存，请重试。'
}
Page({
  data: Object.assign({ fontScale: 1, guest: true }, empty()),
  onLoad: function () { fontScale.applyFontScale(this) },
  onShow: function () {
    fontScale.applyFontScale(this)
    const self = this
    pageGate.start(this, function (ok) {
      self.invalidate()
      self.setData(Object.assign({ guest: !ok }, empty()))
      if (ok) self.loadProfile()
    })
  },
  invalidate: function () { this._operation = (this._operation || 0) + 1; this._pendingSave = null; this._subjectBinding = null },
  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },
  live: function (op, b) { return this._gateActive !== false && this._operation === op && api.current(b) },
  identityFailure: function (op) {
    if (this._operation !== op || this._gateActive === false) return
    this.invalidate(); this.setData(Object.assign({ guest: true }, empty()))
    this.onShow()
  },
  display: function (p) {
    const c = this.data.crops.find(function (i) { return i.id === p.crop_id })
    const r = this.data.regions.find(function (i) { return i.code === p.region_code && i.catalog_version === p.region_catalog_version })
    this.setData({ profile: p, cropName: p.crop_id === null ? '未设置' : c ? c.name : '当前目录不可用', regionName: p.region_code === null ? '未设置' : r ? r.name : '当前目录版本不可用' })
  },
  loadProfile: async function () {
    if (this.data.guest || this.data.busy) return
    const op = this._operation = (this._operation || 0) + 1, b = api.binding()
    this._pendingSave = null; this._subjectBinding = b
    this.setData(Object.assign(empty(), { busy: true, message: '正在读取档案与目录…' }))
    try {
      const result = await Promise.all([api.read(), api.crops(), api.regions()])
      if (!this.live(op, b)) { this.identityFailure(op); return }
      const roots = result[2].filter(function (r) { return r.parent_code === null })
      const cities = result[2].filter(function (r) { return roots.some(function (p) { return p.code === r.parent_code }) })
      this.setData({ crops: result[1], regions: result[2], cities: cities, loaded: true, busy: false, message: !result[1].length || !cities.length ? '支持目录为空，暂时不能选择档案。' : '' })
      this.display(result[0])
    } catch (e) {
      if (!this.live(op, b)) { this.identityFailure(op); return }
      this.setData({ busy: false, message: message(e.code), needsReload: true })
    }
  },
  subjectCurrent: function () {
    if (api.current(this._subjectBinding)) return true
    this.identityFailure(this._operation); return false
  },
  onEdit: function () {
    if (!this.subjectCurrent()) return
    if (this.data.guest || !this.data.loaded || this.data.busy || this.data.needsReload || this._pendingSave) return
    const p = this.data.profile, regions = this.data.regions
    const selected = regions.find(function (r) { return r.code === p.region_code && r.catalog_version === p.region_catalog_version })
    const cityIndex = this.data.cities.findIndex(function (r) { return selected && (r.code === selected.code || r.code === selected.parent_code) })
    const city = this.data.cities[cityIndex]
    const counties = city ? regions.filter(function (r) { return r.parent_code === city.code }) : []
    this.setData({ editing: true, cropIndex: this.data.crops.findIndex(function (r) { return r.id === p.crop_id }), cityIndex: cityIndex, counties: counties, countyIndex: counties.findIndex(function (r) { return selected && r.code === selected.code }), message: '' })
  },
  editable: function () { return this.subjectCurrent() && !this.data.guest && this.data.editing && !this.data.busy && !this._pendingSave && !this.data.needsReload },
  onCrop: function (event) { if (this.editable()) this.setData({ cropIndex: Number(event.detail.value) }) },
  onCity: function (event) {
    if (!this.editable()) return
    const i = Number(event.detail.value), city = this.data.cities[i]
    this.setData({ cityIndex: i, countyIndex: -1, counties: city ? this.data.regions.filter(function (r) { return r.parent_code === city.code }) : [] })
  },
  onCounty: function (event) { if (this.editable()) this.setData({ countyIndex: Number(event.detail.value) }) },
  useCity: function () { if (this.editable()) this.setData({ countyIndex: -1 }) },
  onCancel: function () { if (this.editable()) this.setData({ editing: false, message: '' }) },
  onSave: function () {
    if (this.data.guest || this.data.busy || this.data.needsReload || !this.data.loaded || !this.data.editing) return
    if (!this.subjectCurrent()) return
    const b = this._subjectBinding
    if (!b) { this.identityFailure(this._operation); return }
    const crop = this.data.crops[this.data.cropIndex], region = this.data.counties[this.data.countyIndex] || this.data.cities[this.data.cityIndex]
    if (!crop || !region) { this.setData({ message: '请选择一项作物和浙江市县。' }); return }
    const frozen = this._pendingSave || { key: 'profile-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12), revision: this.data.profile.revision, body: { crop_id: crop.id, region_code: region.code, region_catalog_version: region.catalog_version } }
    const op = this._operation
    this.setData({ busy: true })
    const self = this
    wx.showModal({ title: this._pendingSave ? '重试同一次保存' : '确认档案', content: crop.name + ' · ' + region.name + '。只更新当前档案，不修改历史任务。', success: function (r) {
      if (!self.live(op, b)) { self.identityFailure(op); return }
      if (!r.confirm) { self.setData({ busy: false }); return }
      self._pendingSave = frozen; self.commitSave(op, b, frozen)
    }, fail: function () { if (self.live(op, b)) self.setData({ busy: false }) } })
  },
  commitSave: async function (op, b, frozen) {
    try {
      await api.save(frozen)
      if (!this.live(op, b)) { this.identityFailure(op); return }
      this._pendingSave = null
      this.setData({ retryPending: false, message: '保存已受理，正在重新读取…' })
      const latest = await api.read()
      if (!this.live(op, b)) { this.identityFailure(op); return }
      this.display(latest)
      this.setData({ busy: false, editing: false, message: '已重新读取当前档案。' })
    } catch (e) {
      if (!this.live(op, b)) { this.identityFailure(op); return }
      const conflict = ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'INVALID_REQUEST', 'INVALID_CURSOR'].indexOf(e.code) !== -1
      if (conflict) this._pendingSave = null
      this.setData({ busy: false, retryPending: !!this._pendingSave, needsReload: conflict || !this._pendingSave, message: message(e.code) + (this._pendingSave ? '可重试同一次保存，或重新读取。' : '') })
    }
  },
  openReference: function () {
    if (this.data.guest || !this.data.profile || !this.data.loaded || this.data.busy || this.data.needsReload) return
    if (!this.subjectCurrent()) return
    const p = this.data.profile
    if (!p.crop_id || !p.region_code) { this.setData({ message: '请先设置档案。' }); return }
    wx.navigateTo({ url: '/pages/reference/reference?crop_id=' + encodeURIComponent(p.crop_id) + '&region_code=' + encodeURIComponent(p.region_code) })
  },
  onLogin: function () { wx.reLaunch({ url: '/pages/login/login' }) },
  logout: function () {
    const self = this; pageGate.cancel(this)
    auth.logout(function (result) {
      self.setData({ guest: true }); wx.reLaunch({ url: '/pages/login/login' })
      if (!result.serverRevoked) wx.showToast({ title: result.serverRevocationUnconfirmed ? '本地已清，服务端撤销未确认' : '已清除本地会话', icon: 'none' })
    })
  }
})
