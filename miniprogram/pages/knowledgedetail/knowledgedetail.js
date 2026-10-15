const fontScale = require('../../utils/font-scale')
const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const api = require('../../utils/knowledge-api')
const favoritesApi = require('../../utils/favorites-api')

// GY-I16 切片A：收藏／取消收藏的**独立**接线。
// 契约 `FavoriteTarget.type` 闭集：`species|herbicide|scheme` 可收藏，`static_region` 不可收藏。
// 该闭集只决定"要不要显示收藏按钮"，**不**构成任何可用性结论（本页不做目标可见性判定）。
const FAVORITE_TARGET_TYPES = ['species', 'herbicide', 'scheme']
// 回填按钮文案时最多读几页 `GET /favorites`（每页 50，服务端上限）。
// 扫不到**不做任何本地去重决定**：再点「收藏」由服务端 `(user,target)` 唯一索引去重（201 返回既有行）。
const FAVORITE_SCAN_PAGES = 3

Page({
  data: { fontScale: 1, gatePassed: false, busy: false, item: null, labels: null, status: '', modeNote: api.modeNote(), conditionsText: '',
    // GY-I26：状态语气字段，供 state-view 统一渲染 loading／error；idle 表示尚未发起读取
    stateKind: 'idle',
    // GY-I16 切片A：收藏入口的**独立**状态（不参与 gatePassed／stateKind／busy 的既有语义）。
    // favState: idle（未接线／不展示）| loading | none | favorited | unknown | unsupported
    favSupported: false, favState: 'idle', favLabel: '收藏', favNote: '', favBusy: false },
  onLoad: function (options) {
    fontScale.applyFontScale(this); this._id = ''
    try { if (options && typeof options.id === 'string' && options.id.length <= 128) { const id = decodeURIComponent(options.id); if (api.validId(id)) this._id = id } } catch (_) {}
  },
  onShow: function () { fontScale.applyFontScale(this); this.checkGate() },
  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },
  clear: function () { this._displayBinding = null; this._readOperation = (this._readOperation || 0) + 1; this.setData({ item: null, labels: null, busy: false, status: '', conditionsText: '', modeNote: api.modeNote(), stateKind: 'idle' }); this.resetFavorite() },
  checkGate: function () { pageGate.start(this, ok => { this.clear(); this.setData({ gatePassed: ok }); if (ok) this.read().then(() => this.refreshFavorite()) }) },
  retry: function () { if (this.data.gatePassed) this.read().then(() => this.refreshFavorite()); else this.checkGate() },
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
  // ---------------------------------------------------------------------------
  // GY-I16 切片A：收藏／取消收藏（独立按钮 + 独立状态；不参与 read() 的状态机）
  // 口径：收藏只表示"保存了这条资料"，不产生"已核对／已使用／已确认适用"任何事实；
  // 也不判定目标可见性（本片不接端口，故不做任何可用性断言与跳转）。
  // ---------------------------------------------------------------------------

  /** 清空收藏入口状态并使在途的收藏请求失效（会话/门禁变化时调用）。 */
  resetFavorite: function () {
    this._favOperation = (this._favOperation || 0) + 1
    this._favCurrent = null
    this.setData({ favSupported: false, favState: 'idle', favLabel: '收藏', favNote: '', favBusy: false })
  },

  /** 收藏请求的失效判据：更晚的操作、会话世代变化、门禁关闭，任一发生即丢弃结果。 */
  favAlive: function (operation, epoch) {
    return this._favOperation === operation && auth.sessionEpoch() === epoch && this.data.gatePassed === true
  },

  /**
   * 按 `item` 回填收藏入口：**逐次**读 `GET /favorites`（不缓存、不本地推断），
   * 命中同 `(type,id)` 才显示「取消收藏」。读取失败如实报"未知"，不假定任一侧。
   */
  refreshFavorite: async function () {
    const item = this.data.item
    if (!this.data.gatePassed || !auth.isLoggedIn() || !item) { this.resetFavorite(); return }
    if (FAVORITE_TARGET_TYPES.indexOf(item.type) === -1) {
      // 契约不接受该类目标：如实说明"不在收藏范围内"，不显示按钮、不发请求。
      this.resetFavorite()
      this.setData({ favState: 'unsupported', favNote: '该类资料不在收藏范围内（只能收藏杂草／药剂／方案类资料）。' })
      return
    }
    const operation = this._favOperation = (this._favOperation || 0) + 1
    const epoch = auth.sessionEpoch()
    this._favCurrent = null
    this.setData({ favSupported: true, favState: 'loading', favLabel: '收藏', favNote: '正在核对收藏状态…', favBusy: true })
    try {
      const found = await this.scanFavorite(item.type, item.id)
      if (!this.favAlive(operation, epoch)) return
      if (found) {
        this._favCurrent = found
        this.setData({ favState: 'favorited', favLabel: '取消收藏', favNote: '已收藏该资料。', favBusy: false })
      } else {
        this.setData({ favState: 'none', favLabel: '收藏', favNote: '尚未收藏该资料。', favBusy: false })
      }
    } catch (e) {
      if (!this.favAlive(operation, epoch)) return
      // 读取失败 ⇒ 如实报"未取得"，既不假定已收藏也不假定未收藏。
      this.setData({ favState: 'unknown', favLabel: '收藏', favNote: favoritesApi.messageFor(e), favBusy: false })
    }
  },

  /**
   * 逐页读收藏，找同 `(type,id)` 的既有行，返回 `{ id, revision }`（均来自服务端）。
   * 只用于回填按钮文案；**不做**去重判断（去重永远由服务端唯一索引决定）。
   */
  scanFavorite: async function (type, id) {
    let cursor = ''
    for (let page = 0; page < FAVORITE_SCAN_PAGES; page += 1) {
      const result = await favoritesApi.listFavorites(cursor, 50)
      const hit = result.items.filter(function (x) { return x.target_ref.type === type && x.target_ref.id === id })[0]
      if (hit) return { id: hit.id, revision: hit.revision }
      if (!result.nextCursor) return null
      cursor = result.nextCursor
    }
    return null
  },

  /** 收藏／取消收藏按钮（同一按钮，行为完全由**服务端确认过**的当前状态决定）。 */
  toggleFavorite: async function () {
    const item = this.data.item
    if (this.data.favBusy || !this.data.favSupported || !this.data.gatePassed || !auth.isLoggedIn() || !item) return
    const operation = this._favOperation = (this._favOperation || 0) + 1
    const epoch = auth.sessionEpoch()
    const existing = this._favCurrent
    this.setData({ favBusy: true, favNote: existing ? '正在取消收藏…' : '正在收藏…' })
    try {
      if (existing) {
        // 取消收藏：`favorites-api` 会带 `If-Match: "<revision>"` 与 `Idempotency-Key`。
        await favoritesApi.deleteFavorite(existing.id, existing.revision)
        if (!this.favAlive(operation, epoch)) return
        this._favCurrent = null
        this.setData({ favBusy: false, favState: 'none', favLabel: '收藏', favNote: '已取消收藏。' })
        return
      }
      // 收藏：`favorites-api` 会带 `Idempotency-Key`；服务端按 `(user,target)` 去重。
      const created = await favoritesApi.createFavorite(item.type, item.id, item.revision)
      if (!this.favAlive(operation, epoch)) return
      this._favCurrent = { id: created.favorite.id, revision: created.favorite.revision }
      this.setData({ favBusy: false, favState: 'favorited', favLabel: '取消收藏', favNote: '已收藏该资料。' })
    } catch (e) {
      if (!this.favAlive(operation, epoch)) return
      // 失败后不保留乐观状态：回到"未知"，如实说明原因，由用户重新核对。
      this._favCurrent = null
      this.setData({ favBusy: false, favState: 'unknown', favLabel: '收藏', favNote: favoritesApi.messageFor(e) })
    }
  },

  back: function () {
    const operation = this._gateOperation
    wx.navigateBack({ delta: 1, fail: () => { if (this._gateActive === true && this._gateOperation === operation) wx.redirectTo({ url: '/pages/knowledge/knowledge' }) } })
  },
  copySource: function () { if (this._gateActive === true && this.data.gatePassed && api.current(this._displayBinding) && this.data.item) wx.setClipboardData({ data: this.data.item.source.url }) }
})
