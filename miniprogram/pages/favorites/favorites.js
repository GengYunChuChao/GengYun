// GY-I16 收藏页（Demo 形态：色板/字号/间距/卡片走 styles/*，组件走 gy-ui-*，失败/空态走 state-view）。
//
// 数据来源（全部为**已合并**契约面，不新增路径）：
//   * 我的收藏：GET /favorites（cursor/limit 分页；只列本人）
//   * 取消收藏：DELETE /favorites/{id}（If-Match 用服务端给的 revision）
//   * 可收藏目标：GET /knowledge（#131/#135 已合并；`Knowledge.type` 恰是 species|herbicide|scheme|
//     static_region，其中前三类正是契约允许收藏的 `FavoriteTarget.type`）
//   * 目标标题/资料页：GET /knowledge/{id} → 跳转既有资料详情页
//
// 硬口径：
//   - `reference_state` 由**服务端逐次派生**：本页只显示，不推断、不缓存；
//     不可用时**不**展示目标正文（服务端也没有给），只显示非披露说明。
//   - 收藏**不等于**"已使用"：本页没有任何"标记已使用"的入口，文案也如实说明这一点。
//   - 无网络 / 未接线 / 未登录 → 如实报不可用，**绝不**用本地数据顶替或伪造收藏。
const fontScale = require('../../utils/font-scale')
const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const favoritesApi = require('../../utils/favorites-api')
const knowledgeApi = require('../../utils/knowledge-api')

const PAGE_SIZE = 20
// 契约 FavoriteTarget.type 闭集（`static_region` 等其它 Knowledge.type 不可收藏）。
const FAVORITE_TARGET_TYPES = ['species', 'herbicide', 'scheme']

Page({
  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    gatePassed: false,
    checking: true,
    networkOff: false,
    busy: false,
    mode: '',
    message: '',
    errorText: '',
    loading: false,
    items: [],
    total: 0,
    nextCursor: null,
    targets: [],
    targetNote: '',
    targetError: ''
  },

  onLoad: function () {
    fontScale.applyFontScale(this)
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    const self = this
    // 门禁未通过前清空一切结果，避免残留上一个会话的收藏。
    self.setData({
      gatePassed: false, checking: true, items: [], total: 0, nextCursor: null,
      targets: [], targetNote: '', targetError: '', errorText: '', message: ''
    })
    pageGate.start(this, function (ok) {
      self.setData({ checking: false })
      if (!ok) { self.setData({ gatePassed: false }); return }
      self.setData({ gatePassed: true, networkOff: !auth.networkEnabled() })
      if (auth.networkEnabled()) {
        self.loadFavorites()
        self.loadTargets()
      }
    })
  },

  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

  loadFavorites: function (cursor) {
    const self = this
    self.setData({ busy: true, errorText: '' })
    favoritesApi.listFavorites(cursor || '', PAGE_SIZE).then(function (result) {
      const items = cursor ? self.data.items.concat(result.items.map(self.presentFavorite, self)) : result.items.map(self.presentFavorite, self)
      self.setData({
        busy: false, loading: false, items: items, total: items.length,
        nextCursor: result.nextCursor, mode: result.mode,
        message: result.items.length ? '' : '尚无收藏。'
      })
      self.reconcileTargets()
    }).catch(function (error) {
      // 失败时不保留旧列表（避免"看起来还在"）。
      self.setData({ busy: false, loading: false, items: [], total: 0, nextCursor: null, errorText: favoritesApi.messageFor(error) })
    })
  },

  /** 把服务端投影转成页面视图（标题从已加载的资料列表里回填；没有就只显示类型与短 id）。 */
  presentFavorite: function (item) {
    const view = favoritesApi.describeFavorite(item)
    return {
      id: item.id,
      revision: item.revision,
      type: item.target_ref.type,
      typeLabel: favoritesApi.targetTypeLabel(item.target_ref.type),
      targetId: item.target_ref.id,
      title: this.titleFor(item.target_ref.type, item.target_ref.id),
      createdAt: item.created_at.replace('T', ' ').replace(/\.\d+/, '').replace(/Z$/, ' UTC'),
      stateTone: view.tone,
      stateLabel: view.label,
      stateHint: view.hint,
      available: item.reference_state === 'available',
      // 只在服务端说"当前可用"时才提供进入资料页的入口（不可用不跳转，避免旧链接复活）。
      canOpen: item.reference_state === 'available'
    }
  },

  titleFor: function (type, id) {
    const found = (this.data.targets || []).filter(function (entry) { return entry.type === type && entry.id === id })[0]
    if (found) return found.title
    return favoritesApi.targetTypeLabel(type) + ' · ' + String(id).slice(0, 8)
  },

  /** 可收藏目标（来自已合并的 /knowledge 列表第一页）。 */
  loadTargets: function () {
    const self = this
    knowledgeApi.list({ limit: PAGE_SIZE }).then(function (result) {
      const targets = result.items
        .filter(function (item) { return FAVORITE_TARGET_TYPES.indexOf(item.type) !== -1 })
        .map(function (item) {
          return {
            key: item.type + ':' + item.id,
            type: item.type,
            typeLabel: favoritesApi.targetTypeLabel(item.type),
            id: item.id,
            revision: item.revision,
            title: item.title,
            favorited: false
          }
        })
      self.setData({ targets: targets, targetNote: '来自已上架资料（' + targets.length + ' 条可收藏）', targetError: '' })
      self.reconcileTargets()
    }).catch(function (error) {
      // 资料列表不可用时如实说明；收藏列表本身仍可查看与取消。
      self.setData({ targets: [], targetNote: '资料列表不可用', targetError: knowledgeApi.message(error) })
    })
  },

  /** 把"已收藏"标记回填到可收藏目标列表（按 type+id 比对，不做本地去重决定）。 */
  reconcileTargets: function () {
    const owned = {}
    this.data.items.forEach(function (item) { owned[item.type + ':' + item.targetId] = true })
    this.setData({
      targets: this.data.targets.map(function (entry) {
        return Object.assign({}, entry, { favorited: owned[entry.key] === true })
      })
    })
  },

  onAdd: function (event) {
    const self = this
    if (self.data.busy) return
    const index = Number(event.currentTarget.dataset.index)
    const target = self.data.targets[index]
    if (!target || target.favorited) return
    self.setData({ busy: true, message: '正在收藏…' })
    favoritesApi.createFavorite(target.type, target.id, target.revision).then(function () {
      self.setData({ busy: false, message: '已收藏：' + target.title })
      self.loadFavorites()
    }).catch(function (error) {
      self.setData({ busy: false, message: favoritesApi.messageFor(error) })
    })
  },

  onCancel: function (event) {
    const self = this
    if (self.data.busy) return
    const index = Number(event.currentTarget.dataset.index)
    const item = self.data.items[index]
    if (!item) return
    self.setData({ busy: true, message: '正在取消收藏…' })
    favoritesApi.deleteFavorite(item.id, item.revision).then(function () {
      self.setData({ busy: false, message: '已取消收藏。' })
      // 取消后重新读取（不走本地删除，确保列表与服务端一致）。
      self.loadFavorites()
    }).catch(function (error) {
      self.setData({ busy: false, message: favoritesApi.messageFor(error) })
    })
  },

  onMore: function () {
    if (this.data.busy || !this.data.nextCursor) return
    this.loadFavorites(this.data.nextCursor)
  },

  onRefresh: function () {
    if (!this.data.gatePassed) return
    this.loadFavorites()
    this.loadTargets()
  },

  openTarget: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    const item = this.data.items[index]
    if (!item || !item.canOpen) { this.setData({ message: '该目标当前不可用，已停止跳转。' }); return }
    wx.navigateTo({ url: '/pages/knowledgedetail/knowledgedetail?id=' + encodeURIComponent(item.targetId) })
  },

  onLogin: function () {
    wx.navigateTo({ url: '/pages/login/login' })
  }
})
