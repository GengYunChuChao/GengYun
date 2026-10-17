const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const api = require('../../utils/profile-api')
const locationRegion = require('../../utils/location-region')
// GY-I05 D2：地区转换资源经装配模块注入，页面不再写死转换函数。资源缺席或校验不通过时
// regionConverterResource.build() 返回 null，定位入口按契约如实回落到「地区转换资源尚未接入」
// 并保留手选（fail-closed），不假装转换成功；资源就位且校验通过即自动接线。
const regionConverterResource = require('../../utils/region-converter')
// GY-I16：收藏与识别历史各自有独立页面；本页只显示**已加载条数**并给出入口。
const favoritesApi = require('../../utils/favorites-api')
const historyApi = require('../../utils/history-api')
function empty() { return { profile: null, crops: [], regions: [], cities: [], counties: [], cropIndex: -1, cityIndex: -1, countyIndex: -1, cropName: '待读取', regionName: '待读取', editing: false, busy: false, locating: false, loaded: false, message: '', loadError: '', needsReload: false, retryPending: false } }
function message(code) {
  const messages = { REVISION_CONFLICT: '档案版本已变化，请重新读取并确认。', IDEMPOTENCY_CONFLICT: '保存请求已冲突，请重新读取并确认。', INVALID_CURSOR: '目录版本已变化，请重新读取。', INVALID_REQUEST: '所选目录已不可用，请重新读取后选择。', NETWORK_UNCERTAIN: '网络中断，保存结果未确认。', REQUEST_IN_PROGRESS: '这次保存仍在处理，请稍后重试同一次保存。', PROVIDER_UNAVAILABLE: '档案服务暂不可用。', PROVIDER_TIMEOUT: '档案服务超时。' }
  return messages[code] || '档案暂时无法读取或保存，请重试。'
}
/**
 * 读取（GET /me/profile 与 /catalog/*）失败时的**可见失败态**说明：
 * 只如实描述失败原因，不粉饰成成功、不吞掉、也不用本地数据顶替。
 * 失败态统一由 state-view(status="error") 呈现（见 docs/ui-state-inventory.md:80
 * 「各页面不得再自写一行灰字当失败提示」）。
 */
function readFailure(code) {
  if (code === 'PROVIDER_UNAVAILABLE') return '档案暂时读取失败（服务端未启用该接口）。档案与作物、市县目录都没有读到，本页不会用本地数据顶替，可重试读取。'
  if (code === 'NETWORK_UNCERTAIN') return '档案暂时读取失败（网络中断，读取结果未确认）。请确认网络后重试，本页不会用本地数据顶替。'
  return '档案暂时读取失败（' + (code || '未返回可读原因') + '）。请重试读取，本页不会用本地数据顶替。'
}
// 入口在「档案还没读成功 / 需要重读」时的统一解释：入口保持可点，点击必须给出可见原因，不静默 return。
const NOT_READY = '档案还没有读取成功，暂时不能进入编辑。请先点“重试读取档案”。'
const REREAD_REQUIRED = '档案需要重新读取后才能编辑。请先点“重新读取档案”。'
const REFERENCE_NOT_READY = '档案还没有读取成功，暂时不能按档案查资料。请先点“重试读取档案”。'
Page({
  data: Object.assign({ fontScale: 1, guest: true, favoriteCount: '—', historyCount: '—' }, empty()),
  onLoad: function () { fontScale.applyFontScale(this) },
  onShow: function () {
    fontScale.applyFontScale(this)
    const self = this
    // 计数一律清零：不把上一个会话的条数留在界面上。
    this.setData({ favoriteCount: '—', historyCount: '—' })
    pageGate.start(this, function (ok) {
      self.invalidate()
      self.setData(Object.assign({ guest: !ok }, empty()))
      if (ok) { self.loadProfile(); self.loadCounts() }
    })
  },
  /**
   * 收藏／识别历史的**已加载条数**（不是总数，契约封套没有计数字段）：
   * 只读第一页，`N+` 表示还有下一页；读不到就如实显示 `—`（绝不用本地数据凑数）。
   */
  loadCounts: function () {
    const self = this
    if (!auth.networkEnabled()) return
    favoritesApi.listFavorites('', 20).then(function (result) {
      self.setData({ favoriteCount: result.items.length + (result.nextCursor ? '+' : '') })
    }).catch(function () { self.setData({ favoriteCount: '—' }) })
    historyApi.listHistory('', 20).then(function (result) {
      self.setData({ historyCount: result.items.length + (result.nextCursor ? '+' : '') })
    }).catch(function () { self.setData({ historyCount: '—' }) })
  },
  openFavorites: function () { wx.navigateTo({ url: '/pages/favorites/favorites' }) },
  openHistory: function () { wx.navigateTo({ url: '/pages/history/history' }) },
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
      this.setData({ crops: result[1], regions: result[2], cities: cities, loaded: true, busy: false, loadError: '', message: !result[1].length || !cities.length ? '支持目录为空，暂时不能选择档案。' : '' })
      this.display(result[0])
    } catch (e) {
      if (!this.live(op, b)) { this.identityFailure(op); return }
      // 不静默：失败原因如实进 message，并由 loadError 驱动可见失败态 + 重试入口。
      this.setData({ busy: false, message: message(e.code), loadError: readFailure(e.code), needsReload: true })
    }
  },
  subjectCurrent: function () {
    if (api.current(this._subjectBinding)) return true
    this.identityFailure(this._operation); return false
  },
  onEdit: function () {
    if (!this.subjectCurrent()) return
    if (this.data.guest || this.data.busy) return
    // 读取失败/未读完/待重读：入口**保持可点**并如实说明原因（不静默吞掉点击），但**不**进入编辑。
    if (!this.data.loaded || !this.data.profile) { this.setData({ message: NOT_READY }); return }
    if (this.data.needsReload) { this.setData({ message: REREAD_REQUIRED }); return }
    if (this._pendingSave) { this.setData({ message: '上一次保存还没处理完，请先重试同一次保存或重新读取档案。' }); return }
    // 目录为空时同样不进入编辑（守卫不放宽），只给可见原因。
    if (!this.data.crops.length || !this.data.cities.length) { this.setData({ message: '支持目录为空，暂时不能选择档案。请稍后点“重新读取档案”。' }); return }
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
  // 地区转换资源来自 utils/region-converter.js 的装配结果：资源缺席／校验不通过时为 null，
  // 定位入口只处理授权／拒绝／取消／超时并回退手选，不假装转换成功。
  // 坐标只在内存中经入参交给它（convert(latitude, longitude)），不写入存储，也不进入任何请求体。
  regionConverter: regionConverterResource.build(),
  onLocate: function () {
    if (!this.editable() || this.data.locating) return
    const self = this, op = this._operation, b = this._subjectBinding
    wx.showModal({ title: '使用定位选地区', content: locationRegion.EXPLAIN, confirmText: '允许并定位', cancelText: '改用手选', success: function (r) {
      if (!self.live(op, b)) { self.identityFailure(op); return }
      if (!r.confirm) { self.setData({ message: '已选择手选，可继续选择浙江市县。' }); return }
      self.setData({ locating: true, message: '正在获取位置…' })
      locationRegion.locate(wx, self.regionConverter).then(function (result) {
        if (!self.live(op, b)) { self.identityFailure(op); return }
        if (result.status !== 'ok') { self.setData({ locating: false, message: locationRegion.message(result.status) }); return }
        self.applyLocatedRegion(result.region_code)
      })
    }, fail: function () { if (self.live(op, b)) self.setData({ locating: false, message: locationRegion.message('failed') }) } })
  },
  // 定位只负责预选，不自动保存：仍需用户在目录内确认后手动保存；任何失败都保留手选入口。
  applyLocatedRegion: function (code) {
    const regions = this.data.regions
    const found = regions.find(function (r) { return r.code === code })
    const city = found && found.parent_code !== null ? regions.find(function (r) { return r.code === found.parent_code }) : null
    const isCity = !!found && regions.some(function (r) { return r.parent_code === code })
    const selected = isCity ? found : city
    const cityIndex = selected ? this.data.cities.findIndex(function (r) { return r.code === selected.code }) : -1
    if (cityIndex < 0) { this.setData({ locating: false, message: locationRegion.message('out_of_coverage') }); return }
    const counties = regions.filter(function (r) { return r.parent_code === selected.code })
    this.setData({ locating: false, cityIndex: cityIndex, counties: counties, countyIndex: isCity ? -1 : counties.findIndex(function (r) { return r.code === code }), message: '已按定位预选 ' + (isCity ? selected.name : found.name) + '，请确认后保存档案。' })
  },
  onCancel: function () { if (this.editable()) this.setData({ editing: false, locating: false, message: '' }) },
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
    if (this.data.guest || this.data.busy) return
    if (!this.subjectCurrent()) return
    // 依赖同一接口（GET /me/profile）的入口同样不静默：读不到就给可见原因，且不跳转。
    if (!this.data.loaded || !this.data.profile) { this.setData({ message: REFERENCE_NOT_READY }); return }
    if (this.data.needsReload) { this.setData({ message: REREAD_REQUIRED }); return }
    const p = this.data.profile
    if (!p.crop_id || !p.region_code) { this.setData({ message: '请先设置档案。' }); return }
    wx.navigateTo({ url: '/pages/reference/reference?crop_id=' + encodeURIComponent(p.crop_id) + '&region_code=' + encodeURIComponent(p.region_code) })
  },
  // GY-I04 6-A：与 page-gate 同一登录口径（登记本页为返回目标 → reLaunch 登录页），
  // 登录成功后回到本页；门禁拦截语义不变（未登录仍被拦，按钮不放行任何数据）。
  // N1（对抗性审查 §4）：核实失败或在途时点按钮此前无可见反应。核实成功（ok）说明会话
  // 已获服务端确认 ⇒ 取消被本次核实取代的旧门禁周期，并按「重新进入本页」重跑门禁，
  // 让页面可见地放行；ok=false 时 requireLogin 已跳转登录页（可见）。两者都不放行数据。
  onLogin: function () {
    const self = this
    auth.requireLogin(function (ok) { if (ok) { pageGate.cancel(self); self.onShow() } })
  },
  logout: function () {
    const self = this; pageGate.cancel(this)
    auth.logout(function (result) {
      self.setData({ guest: true }); wx.reLaunch({ url: '/pages/login/login' })
      if (!result.serverRevoked) wx.showToast({ title: result.serverRevocationUnconfirmed ? '本地已清，服务端撤销未确认' : '已清除本地会话', icon: 'none' })
    })
  }
})
