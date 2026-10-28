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
// GY-I28：「我的发布」＝社区页的「我的投稿」（契约 `mine`）。社区是底部 Tab，switchTab 不接受
// 查询参数，故用 navigation 的一次性进程内意图把「预选我的投稿」交给社区页；条数仍按本页既有
// 口径取「第一页已加载条数」（服务端封套没有总数），读不到就显示 —，绝不用本地数据凑数。
const navigation = require('../../utils/navigation')
const communityApi = require('../../utils/community-api')
function empty() { return { profile: null, crops: [], regions: [], cities: [], counties: [], cropIndex: -1, cityIndex: -1, countyIndex: -1, cropName: '待读取', regionName: '待读取', editing: false, busy: false, locating: false, loaded: false, message: '', loadError: '', needsReload: false, retryPending: false, loadErrorCode: '' } }
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
  // 403 系列（GY-I04 登录链路盘点）：权限不足 / 缺用途授权 / 账号不可用 —— 与「暂时读取失败」分开说，
  // 重试不会变好（`utils/states.js` 把这三码都归 `denied`）。改前它们被 `profile-api` 折叠成
  // SESSION_REQUIRED，本页只会说「登录失效」，用户反复重登也解决不了。
  if (code === 'SCOPE_DENIED') return '没有权限查看档案（403 SCOPE_DENIED）：当前会话的权限范围不包含档案，重试无效；本页不会用本地数据顶替。'
  if (code === 'CONSENT_REQUIRED') return '缺少用途授权（403 CONSENT_REQUIRED）：未授权时不会读取或保存档案，重试无效。'
  if (code === 'ACCOUNT_INACTIVE') return '账号当前不可用（403 ACCOUNT_INACTIVE）：会话已终止，请重新登录；本页不会用本地数据顶替。'
  return '档案暂时读取失败（' + (code || '未返回可读原因') + '）。请重试读取，本页不会用本地数据顶替。'
}
// 入口在「档案还没读成功 / 需要重读」时的统一解释：入口保持可点，点击必须给出可见原因，不静默 return。
const NOT_READY = '档案还没有读取成功，暂时不能进入编辑。请先点“重试读取档案”。'
const REREAD_REQUIRED = '档案需要重新读取后才能编辑。请先点“重新读取档案”。'
const REFERENCE_NOT_READY = '档案还没有读取成功，暂时不能按档案查资料。请先点“重试读取档案”。'
// 三项计数的独立状态：idle（尚未读取）/ loading / ready / error。
// 每一项只写自己的状态与条数，一项失败不覆盖其他项已成功的条数；重试也只重读该项。
const COUNT_KINDS = ['favorite', 'history', 'myPost']
Page({
  data: Object.assign({ fontScale: 1, guest: true, favoriteCount: '—', historyCount: '—', myPostCount: '—', favoriteState: 'idle', historyState: 'idle', myPostState: 'idle' }, empty()),
  onLoad: function () { fontScale.applyFontScale(this) },
  onShow: function () {
    fontScale.applyFontScale(this)
    const self = this
    // 计数一律清零：不把上一个会话的条数留在界面上；同时让离页/旧会话的在途响应失效。
    this.invalidateCounts()
    this.setData({ favoriteCount: '—', historyCount: '—', myPostCount: '—', favoriteState: 'idle', historyState: 'idle', myPostState: 'idle' })
    pageGate.start(this, function (ok) {
      self.invalidate()
      self.setData(Object.assign({ guest: !ok }, empty()))
      if (ok) { self.loadProfile(); self.loadCounts() }
    })
  },
  /** 让三项计数此前的在途响应全部失效（离页、重新进入、换会话时调用）。 */
  invalidateCounts: function () {
    const ops = this._countOps || (this._countOps = {})
    COUNT_KINDS.forEach(function (kind) { ops[kind] = (ops[kind] || 0) + 1 })
  },
  /**
   * 收藏／识别历史／我的发布的**已加载条数**（不是总数，契约封套没有计数字段）：
   * 只读第一页，`N+` 表示还有下一页；读不到就如实显示 `—`（绝不用本地数据凑数）。
   * 三项各自独立结算：失败只把该项置 error，其他项的成功条数原样保留。
   */
  loadCounts: function () {
    const self = this
    COUNT_KINDS.forEach(function (kind) { self.loadCount(kind) })
  },
  countRequest: function (kind) {
    if (kind === 'favorite') return favoritesApi.listFavorites('', 20)
    if (kind === 'history') return historyApi.listHistory('', 20)
    // GY-I28：契约既有 `GET /posts?mine=true`（community-api listPosts 的 `mine` 参数，
    // 与社区页「我的投稿」同一查询），不新增后端接口。
    return communityApi.listPosts({ mine: true, limit: 20 })
  },
  /** 只重读一项计数；不触碰档案数据、编辑表单或另外两项的条数。 */
  loadCount: function (kind) {
    if (COUNT_KINDS.indexOf(kind) === -1) return
    const ops = this._countOps || (this._countOps = {})
    const op = ops[kind] = (ops[kind] || 0) + 1
    const epoch = auth.sessionEpoch()
    const patch = {}
    patch[kind + 'State'] = 'loading'
    patch[kind + 'Count'] = '—'
    this.setData(patch)
    const self = this
    if (!auth.networkEnabled()) { this.settleCount(kind, op, epoch, null, true); return }
    this.countRequest(kind).then(function (result) {
      self.settleCount(kind, op, epoch, result, false)
    }).catch(function () {
      self.settleCount(kind, op, epoch, null, true)
    })
  },
  /** 旧会话、离页后或已被更新一次重试取代的响应不得写回页面。 */
  countLive: function (kind, op, epoch) {
    return this._gateActive !== false && !!this._countOps && this._countOps[kind] === op && auth.sessionEpoch() === epoch
  },
  settleCount: function (kind, op, epoch, result, failed) {
    if (!this.countLive(kind, op, epoch)) return
    const patch = {}
    if (failed || !result || !Array.isArray(result.items)) {
      patch[kind + 'State'] = 'error'
      patch[kind + 'Count'] = '—'
    } else {
      patch[kind + 'State'] = 'ready'
      patch[kind + 'Count'] = result.items.length + (result.nextCursor ? '+' : '')
    }
    this.setData(patch)
  },
  /** 失败项的显式重试入口（catchtap，不触发整卡跳转）。 */
  retryCount: function (event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset
    const kind = dataset && dataset.kind
    if (COUNT_KINDS.indexOf(kind) === -1) return
    if (this.data.guest || this._gateActive === false) return
    this.loadCount(kind)
  },
  openFavorites: function () { wx.navigateTo({ url: '/pages/favorites/favorites' }) },
  openHistory: function () { wx.navigateTo({ url: '/pages/history/history' }) },
  // 授权清单页（GY-R34 / #29 P1，只读）：本页只负责跳转；读取失败、空态与登录门禁都由该页自己收口。
  openConsent: function () { wx.navigateTo({ url: '/pages/consent/consent' }) },
  /**
   * 「我的发布」（demo profile 的 `data-action="my-posts"`）：小程序没有独立的「我的发布」页，
   * 如实跳到**既有路由**社区页并预选「我的投稿」筛选（同一契约查询 `mine=true`），
   * 不新建页面、不伪造列表。社区页自身仍按登录门禁与 state-view 收口失败／空态。
   */
  openMyPosts: function () {
    navigation.requestCommunityMine()
    navigation.openTarget('/pages/community/community', false, function (error) {
      if (error) wx.showToast({ title: error, icon: 'none' })
    })
  },
  invalidate: function () { this._operation = (this._operation || 0) + 1; this._pendingSave = null; this._subjectBinding = null },
  onHide: function () { this.invalidateCounts(); pageGate.cancel(this) },
  onUnload: function () { this.invalidateCounts(); pageGate.cancel(this) },
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
      this.setData({ crops: result[1], regions: result[2], cities: cities, loaded: true, busy: false, loadError: '', loadErrorCode: '', message: !result[1].length || !cities.length ? '支持目录为空，暂时不能选择档案。' : '' })
      this.display(result[0])
    } catch (e) {
      if (!this.live(op, b)) { this.identityFailure(op); return }
      // 不静默：失败原因如实进 message，并由 loadError 驱动可见失败态 + 重试入口。
      this.setData({ busy: false, message: message(e.code), loadError: readFailure(e.code), loadErrorCode: (e && e.code) || '', needsReload: true })
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
  // 入口「按当前档案查科普资料」。函数名沿用 `openReference`（`profile.wxml:146` 绑定名、
  // 单测的 disabled 守卫都按这个名字查），但**目标页已改**：
  //   · 落 `pages/knowledge`（服务端查询面 `GET /knowledge`）——它能走到「详情 → 收藏」、
  //     能看到来源版本与失效口径；
  //   · 不落 `pages/reference`：该页带作物／杂草／地区条件时**强制**读随包离线副本
  //     （`pages/reference/reference.js:207-210`），这条路永远走不到服务端与收藏，
  //     它只做随包名录浏览（`docs/ui-state-inventory.md` §7.4 的定位不变，本片不改它的行为）。
  openReference: function () {
    if (this.data.guest || this.data.busy) return
    if (!this.subjectCurrent()) return
    // 依赖同一接口（GET /me/profile）的入口同样不静默：读不到就给可见原因，且不跳转。
    if (!this.data.loaded || !this.data.profile) { this.setData({ message: REFERENCE_NOT_READY }); return }
    if (this.data.needsReload) { this.setData({ message: REREAD_REQUIRED }); return }
    const p = this.data.profile
    // 空档案（未选手选作物／地区）：**不跳转**，在入口处给出「先完善档案」的提示。
    // 为什么选「提示」而不是「进知识页但不带筛选」：这个按钮的承诺是「**按当前档案**查科普资料」，
    // 档案为空时跳过去只能给一张与档案无关的全量列表；知识页虽然也有「档案为空」的说明
    // （`pages/knowledge/knowledge.js:19` EMPTY_PROFILE_NOTE），但那是在**用户已经进了查询面
    // 之后**才说，第一屏仍然是一张会被读成「我的作物／地区下查到的资料」的列表。
    // 入口处拦住，既守住按钮的承诺，也不让用户白跑一次；下一步动作就是本页的「编辑档案」。
    if (!p.crop_id || !p.region_code) { this.setData({ message: '请先设置档案（作物与地区）再按档案查科普资料。' }); return }
    // 跳转形状照抄本页同类的三个入口（收藏／历史／授权清单）：直接 `wx.navigateTo`。
    // 目标不是底部 Tab，`navigateTo` 是正确的路由 API；无需 `navigation.openTarget` 的
    // fail 兜底（那套是给 reLaunch／登录回路用的，这里失败也和同类入口一样保持原位）。
    // **不拼查询参数**：`pages/knowledge` 的 `onLoad` 只做字号（`knowledge.js:57`），全页不读
    // `options`；它靠 `prepare()` 自己读一次 `GET /me/profile`，把档案的 `crop_id` 与
    // `region_code` 预置成首次查询条件（`knowledge.js:76-132`，地区一律按省级 `330000` 发并在
    // 页面明示层级）。在这里另造一套参数名既不会被消费，也会与那条唯一实现分叉；
    // `utils/navigation.js:49` 的 `normalizeTarget` 也只白名单 `pages/reference` 的查询串。
    wx.navigateTo({ url: '/pages/knowledge/knowledge' })
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
