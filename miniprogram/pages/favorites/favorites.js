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
    /** 最近一次读取失败的契约错误码（交给 `components/state-view` 的 errorCode 决定 401/403/404 语气）。 */
    errorCode: '',
    loading: false,
    items: [],
    total: 0,
    nextCursor: null,
    targets: [],
    /** 可收藏资料的续页游标（空串=没有更多）；与「我的收藏」的 nextCursor 分开存。 */
    targetNextCursor: '',
    /** 续页在途：只禁用「加载更多资料」，不影响收藏列表本身的取消/收藏。 */
    targetBusy: false,
    targetNote: '',
    targetError: ''
  },

  onLoad: function () {
    fontScale.applyFontScale(this)
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    const self = this
    // 页面代次：每次进入/离开都推进。上一轮在途的读取（成功或失败）一律作废，
    // 不得把旧列表/targets/busy/error 写回新一轮。
    self._epoch = (self._epoch || 0) + 1
    // 门禁未通过前清空一切结果，避免残留上一个会话的收藏；同时解除上一轮可能残留的在途态。
    self.setData({
      gatePassed: false, checking: true, items: [], total: 0, nextCursor: null,
      targets: [], targetNextCursor: '', targetBusy: false, targetNote: '', targetError: '',
      errorText: '', errorCode: '', message: '',
      busy: false, loading: false
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

  onHide: function () { pageGate.cancel(this); this._epoch = (this._epoch || 0) + 1 },
  onUnload: function () { pageGate.cancel(this); this._epoch = (this._epoch || 0) + 1 },

  // 读取代次：每发起一次读取推进，并与页面代次一起校验。旧页面或旧一轮的回调必须在
  // **任何 setData／reconcile 之前**返回，否则旧列表/旧 targets/旧 busy/error 会污染新一轮。
  beginRead: function (key) {
    this[key] = (this[key] || 0) + 1
    return { epoch: this._epoch || 0, seq: this[key] }
  },

  readAlive: function (read, key) {
    return !!read && read.epoch === (this._epoch || 0) && read.seq === this[key]
  },

  // 写操作（收藏/取消）绑定发起时的页面代次。离页不会取消已发出的服务端写，但旧响应
  // 不得写回隐藏页或重进后的新页面，也不得替新页面发起 loadFavorites 重读。这里单独
  // 捕获页面代次，**不**复用/推进读取的 _favoritesRead、_targetsRead seq：写回调不是读取，
  // 不能把当前代次正在飞的新读取判成过期。
  beginWrite: function () {
    return { epoch: this._epoch || 0 }
  },

  writeAlive: function (write) {
    return !!write && write.epoch === (this._epoch || 0)
  },

  loadFavorites: function (cursor) {
    const self = this
    const read = self.beginRead('_favoritesRead')
    self.setData({ busy: true, errorText: '', errorCode: '' })
    favoritesApi.listFavorites(cursor || '', PAGE_SIZE).then(function (result) {
      if (!self.readAlive(read, '_favoritesRead')) return
      const items = cursor ? self.data.items.concat(result.items.map(self.presentFavorite, self)) : result.items.map(self.presentFavorite, self)
      self.setData({
        busy: false, loading: false, items: items, total: items.length,
        nextCursor: result.nextCursor, mode: result.mode,
        // 空态文案看**合并后**的列表：翻页拿到空页时列表里仍有收藏，不能说"尚无收藏"。
        message: items.length ? '' : '尚无收藏。'
      })
      self.reconcileTargets()
    }).catch(function (error) {
      if (!self.readAlive(read, '_favoritesRead')) return
      // 失败时不保留旧列表（避免"看起来还在"）。错误码原样带出，401/403/404 由状态组件分别呈现，
      // 不把"没有权限"或"服务不可用"折叠成空列表或"请重新登录"。
      self.setData({
        busy: false, loading: false, items: [], total: 0, nextCursor: null,
        errorText: favoritesApi.messageFor(error), errorCode: (error && error.code) || ''
      })
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
      createdAt: require('../../utils/time-format').formatDateTime(item.created_at),
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

  /**
   * 可收藏目标（来自已合并的 /knowledge 列表）。第一页与续页共用本函数：
   * · 续页必须带 cursor；knowledge-api 的 cursor 只接受非空字符串，首页必须整个键不传。
   * · 续页条目按 type:id 去重后追加，保持已加载顺序（分页+闭集过滤可能返回重复条目）。
   * · 文案与按钮都自证范围：报「已加载 N 条」，有 nextCursor 就给「加载更多资料」，
   *   不让人把第一页当成全部（旧实现只读第一页 20 条，且界面没有任何「还有更多」的出口）。
   */
  loadTargets: function (cursor) {
    const self = this
    const read = self.beginRead('_targetsRead')
    const more = typeof cursor === 'string' && cursor !== ''
    const query = more ? { limit: PAGE_SIZE, cursor: cursor } : { limit: PAGE_SIZE }
    self.setData({ targetBusy: true })
    knowledgeApi.list(query).then(function (result) {
      if (!self.readAlive(read, '_targetsRead')) return
      const page = result.items
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
      const targets = appendTargets(more ? self.data.targets : [], page)
      self.setData({
        targets: targets,
        targetBusy: false,
        targetNextCursor: result.nextCursor || '',
        targetNote: targetNoteText(targets.length, result.nextCursor),
        targetError: ''
      })
      self.reconcileTargets()
    }).catch(function (error) {
      if (!self.readAlive(read, '_targetsRead')) return
      // 续页失败：已加载的条目照旧显示（不清空），把失败原因写在提示里，可再点重试。
      if (more) { self.setData({ targetBusy: false, targetError: knowledgeApi.message(error) }); return }
      // 首页失败：如实说不可用并清空列表，不让人以为看到的就是全部。
      self.setData({
        targets: [], targetBusy: false, targetNextCursor: '',
        targetNote: '资料列表不可用', targetError: knowledgeApi.message(error)
      })
    })
  },

  /** 回填「已收藏」标记，并把晚到 targets 的资料名补写进已渲染的收藏项（只改 title 字段）。
   *  不重建列表/分页：未变的条目原样返回（同一对象），兜底标题在这里被改写而不是永远停在兜底。 */
  reconcileTargets: function () {
    const owned = {}
    this.data.items.forEach(function (item) { owned[item.type + ':' + item.targetId] = true })
    this.setData({
      items: retitleItems(this),
      targets: this.data.targets.map(function (entry) { return Object.assign({}, entry, { favorited: owned[entry.key] === true }) })
    })
  },

  onAdd: function (event) {
    const self = this
    if (self.data.busy) return
    const index = Number(event.currentTarget.dataset.index)
    const target = self.data.targets[index]
    if (!target || target.favorited) return
    const write = self.beginWrite()
    self.setData({ busy: true, message: '正在收藏…' })
    favoritesApi.createFavorite(target.type, target.id, target.revision).then(function () {
      // 离页只丢弃本页旧响应；服务端写入仍可能完成，不能用“没写回”反推“没收藏”。
      if (!self.writeAlive(write)) return
      self.setData({ busy: false, message: '已收藏：' + target.title })
      self.loadFavorites()
    }).catch(function (error) {
      if (!self.writeAlive(write)) return
      self.setData({ busy: false, message: favoritesApi.messageFor(error) })
    })
  },

  onCancel: function (event) {
    const self = this
    if (self.data.busy) return
    const index = Number(event.currentTarget.dataset.index)
    const item = self.data.items[index]
    if (!item) return
    const write = self.beginWrite()
    self.setData({ busy: true, message: '正在取消收藏…' })
    favoritesApi.deleteFavorite(item.id, item.revision).then(function () {
      // 同上：离页后旧成功不得写新页面，也不得替新页面重读。
      if (!self.writeAlive(write)) return
      self.setData({ busy: false, message: '已取消收藏。' })
      // 取消后重新读取（不走本地删除，确保列表与服务端一致）。
      self.loadFavorites()
    }).catch(function (error) {
      // 已被别人删掉 / 版本已变时不猜结果：如实报错，并回到服务端重读（不本地删除，也不假装成功）。
      // 但旧代次的错误（含 NOT_FOUND／REVISION_CONFLICT）只丢弃，不能写当前页或触发重读。
      if (!self.writeAlive(write)) return
      self.setData({ busy: false, message: favoritesApi.messageFor(error) })
      const code = error && error.code
      if (code === 'NOT_FOUND' || code === 'REVISION_CONFLICT') self.loadFavorites()
    })
  },

  onMore: function () {
    if (this.data.busy || !this.data.nextCursor) return
    this.loadFavorites(this.data.nextCursor)
  },

  /** 「加载更多资料」：只续读可收藏目标那一页，不重读收藏列表。 */
  onMoreTargets: function () {
    if (this.data.targetBusy || !this.data.targetNextCursor) return
    this.loadTargets(this.data.targetNextCursor)
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

  // GY-I04 6-A：与 page-gate 同一登录口径（登记本页为返回目标 → reLaunch 登录页），
  // 登录成功后回到本页；门禁拦截语义不变（未登录仍被拦，按钮不放行任何数据）。
  // N1（对抗性审查 §4）：核实失败或在途时点按钮此前无可见反应。核实成功（ok）说明会话
  // 已获服务端确认 ⇒ 取消被本次核实取代的旧门禁周期，并按「重新进入本页」重跑门禁，
  // 让页面可见地放行；ok=false 时 requireLogin 已跳转登录页（可见）。两者都不放行数据。
  onLogin: function () {
    const self = this
    auth.requireLogin(function (ok) { if (ok) { pageGate.cancel(self); self.onShow() } })
  }
})

// 续页合并：按 key（type:id）去重后追加，保持已加载顺序（闭集过滤后的分页可能返回重复条目）。
function appendTargets(existing, page) {
  const seen = {}
  return (existing || []).concat(page).filter(function (entry) {
    if (seen[entry.key]) return false
    seen[entry.key] = true
    return true
  })
}

// 文案自证范围：只说「已加载 N 条」，并把「还有更多／已全部加载」明写出来。
// 服务端封套不提供可收藏资料的总数，所以这个数字在任何位置都不得被呈现为总数。
function targetNoteText(count, nextCursor) {
  return '来自已上架资料：已加载 ' + count + ' 条可收藏' + (nextCursor ? '（还有更多）' : '（已全部加载）')
}

// 标题回填：`onShow` 里 loadFavorites 与 loadTargets 并行，收藏响应先到时 `titleFor` 只能落
// 「类型 · 短id」兜底（服务端 `GET /favorites` 只回 target_ref，没有 title）。targets 晚到后
// 必须把已渲染的 title 重算一遍，否则重进页面会一直停在兜底、等多久都不自愈。
// 只替换 title 真的变了的条目：未变项原样返回（同一对象），所以不重建列表，也不动分页/游标。
function retitleItems(page) {
  return page.data.items.map(function (item) {
    const title = page.titleFor(item.type, item.targetId)
    return title === item.title ? item : Object.assign({}, item, { title: title })
  })
}
