// GY-I17（#17）阶段 3 · 消息页（真实读面，客户端侧）。
//
// 数据全部来自服务端契约既有 3 条 operation（`GET /messages`、`GET /messages/unread-count`、
// `PUT /messages/{id}/read`），经 `utils/messages-api.js` 逐字段核对后呈现。
// **不展示任何本地伪造通知**，也不把失败显示成空态：
//   - 未登录 ⇒ 门禁拦截（`page-gate`，与识别/社区/我的同口径），**零业务请求**；
//   - 空列表（服务端返回 0 条）⇒ 空态「暂无消息」；
//   - 服务端 real 模式未接线真实消息存储（503 `PROVIDER_UNAVAILABLE`）⇒ **「消息服务未接线」**，
//     与空态**可分辨**（不得显示成「暂无消息」）；
//   - 其它失败 ⇒ 错误态 + 契约错误码对应文案（沿用社区页的 `state-view` 收口口径）。
//
// 契约事实：`Message` **没有** title/body/actor 字段 ⇒ 本页只按 `type` 给出固定标签，
// 不伪造标题与正文；`reference_state` 为 `unavailable` 时行内如实说明「目标当前不可查看」
// 并**不提供跳转**（目标可用性端口与跳转表属另一片）。
const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const api = require('../../utils/messages-api')

/** `Message.type` 闭集（契约 comment|like|moderation|system）⇒ 页面固定标签与图标。 */
const TYPE_LABELS = {
  comment: { label: '评论', icon: 'chat' },
  like: { label: '点赞', icon: 'heart' },
  moderation: { label: '内容审核结果', icon: 'shield' },
  system: { label: '系统通知', icon: 'tab-bell' }
}
/** 目标可跳转性的如实说明：端口未接线时**不**假装可跳。 */
const REFERENCE_NOTES = {
  available: '关联内容当前可查看；本页只列出消息，不提供跳转入口。',
  unavailable: '关联内容当前不可查看，本页只列出消息，不提供跳转入口。'
}
const NO_TARGET_NOTE = '本条不带关联目标（服务端只给事件类型与对象引用，不给正文）。'
/**
 * 筛选 chips（demo messages 页 `.chips > .chip`／`.chip.active`，docs/ui-demo/demo.html:73）。
 * 四档并列落地，每档都是**对已加载真实消息的本地过滤**：
 *   - `全部`／`未读`：派单要求的读写视角（未读与「全部已读」互补，后者是批量动作）；
 *   - `互动`／`系统`：demo 原有的两档（audit M1「无 chips 全部/互动/系统」），
 *     按契约 `Message.type` 闭集映射（互动 = comment+like，系统 = moderation+system），
 *     映射由契约类型决定，不是本地编造的分类。
 */
const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'unread', label: '未读', unreadOnly: true },
  { value: 'interaction', label: '互动', types: ['comment', 'like'] },
  { value: 'system', label: '系统', types: ['moderation', 'system'] }
]

Page({
  onLoad: function () {
    fontScale.applyFontScale(this)
  },

  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    guest: true,
    status: 'idle',
    errorText: '',
    stateTitle: '',
    stateDesc: '',
    modeNote: '',
    // GY-I26：服务端 `mode` 为 stub／preset_demo 时的**置顶**替身标注（页尾小字不足以「明显」）。
    // 逐字取 `api.modeNote(mode)`，不新造第二套替身文案；real 模式保持为空。
    stubNote: '',
    items: [],
    // 筛选（demo messages 页的 chips，见顶部 FILTERS）：'all'／'unread'／'interaction'／'system'。
    // **只筛「当前已加载」的消息**（服务端游标分页，本地不重排、不补数据）。
    filter: 'all',
    filterLabel: '全部',
    filters: FILTERS.map(function (item) { return { value: item.value, label: item.label } }),
    visibleItems: [],
    hasUnread: false,
    nextCursor: null,
    loadingMore: false,
    markingId: '',
    markingAll: false,
    unreadText: '',
    unreadNote: '未读数尚未读取'
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    // 每次进入先关闭入口，服务端核实成功后才显示登录区。
    const that = this
    this.setData({ guest: true, fontScale: fontScale.currentFontScale() })
    pageGate.start(this, function (ok) {
      that.setData({ guest: !ok })
      if (ok) { that.reload(); that.refreshUnread() }
    })
  },

  // GY-I04 6-A：游客态共享 state-view 的「去登录」必须真正可点 —— 与 page-gate 同一口径
  // （登记本页为返回目标 → reLaunch 登录页），登录成功后回到消息页；门禁拦截语义不变。
  onLogin: function () {
    const self = this
    auth.requireLogin(function (ok) { if (ok) { pageGate.cancel(self); self.onShow() } })
  },
  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

  /** 每次进入/重试都从第一页重新查询（服务端游标绑定主体，不能复用旧游标）。 */
  reload: function (done) {
    const epoch = (this._epoch = (this._epoch || 0) + 1)
    const that = this
    this.setData({ status: 'loading', errorText: '', stateTitle: '', stateDesc: '' })
    api.listMessages({}).then(function (page) {
      if (epoch !== that._epoch) return
      const items = that._decorate(page.items)
      const mode = page.mode
      that.setData({
        status: items.length ? 'ready' : 'empty',
        items: items,
        visibleItems: that._visible(items, that.data.filter),
        hasUnread: that._hasUnread(items),
        nextCursor: page.nextCursor,
        modeNote: api.modeNote(mode),
        stubNote: mode === 'stub' || mode === 'preset_demo' ? api.modeNote(mode) : ''
      })
      if (done) done()
    }).catch(function (error) {
      if (epoch !== that._epoch) return
      if (error && error.code === 'SESSION_REQUIRED') { that.setData({ guest: true, status: 'idle' }); if (done) done(); return }
      that.setData({
        status: 'error',
        errorText: api.message(error),
        stateTitle: api.stateTitle(error),
        stateDesc: api.message(error),
        modeNote: '',
        stubNote: ''
      })
      if (done) done()
    })
  },

  /** 失败态的可点重试入口（messages.wxml 的 error 分支 bind:action="onRetry"）。 */
  onRetry: function () { this.reload(); this.refreshUnread() },

  onLoadMore: function () {
    const that = this
    if (this.data.loadingMore || !this.data.nextCursor || this.data.status !== 'ready') return
    this.setData({ loadingMore: true })
    const epoch = this._epoch
    api.listMessages({ cursor: this.data.nextCursor }).then(function (page) {
      if (epoch !== that._epoch) return
      const items = that.data.items.concat(that._decorate(page.items))
      that.setData({
        items: items,
        visibleItems: that._visible(items, that.data.filter),
        hasUnread: that._hasUnread(items),
        nextCursor: page.nextCursor,
        loadingMore: false
      })
    }).catch(function (error) {
      if (epoch !== that._epoch) return
      that.setData({ loadingMore: false })
      wx.showToast({ title: api.message(error), icon: 'none' })
    })
  },

  /**
   * 未读数是**派生量**：每次都向服务端重新读取，本地不维护计数器。
   * 取不到时**不显示任何数字**（既不显示 0，也不保留过期值），并如实说明未取得。
   */
  refreshUnread: function () {
    const that = this
    if (!auth.isLoggedIn()) { this._applyUnread(''); this.setData({ unreadNote: '未读数尚未读取' }); return }
    api.getUnreadCount().then(function (result) {
      that._applyUnread(api.unreadText(result.count))
      that.setData({ unreadNote: result.count > 0 ? '未读 ' + result.count + ' 条' : '暂无未读' })
    }).catch(function (error) {
      that._applyUnread('')
      that.setData({ unreadNote: api.unwired(error) ? '未读数未取得：服务端未接线' : '未读数未取得：' + api.message(error) })
    })
  },

  /** 角标只读展示在既有 custom-tab-bar 上；不改变 tabBar 配置语义。 */
  _applyUnread: function (textValue) {
    this.setData({ unreadText: textValue })
    const bar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (bar && typeof bar.setData === 'function') bar.setData({ unreadText: textValue })
  },

  /** 列表项展示字段：只做**展示**派生（类型标签 + 目标可跳转性说明），不改契约语义。 */
  _decorate: function (items) {
    return items.map(function (message) {
      const meta = TYPE_LABELS[message.type] || { label: '通知', icon: 'tab-bell' }
      return {
        id: message.id,
        revision: message.revision,
        type: message.type,
        label: meta.label,
        icon: meta.icon,
        unread: message.read_at === null,
        readAt: message.read_at || '',
        time: message.created_at,
        referenceNote: message.target_ref === null ? NO_TARGET_NOTE : REFERENCE_NOTES[message.reference_state]
      }
    })
  },

  /**
   * 筛选用的派生列表：`all` 原样返回、`unread` 只留未读项、`interaction`／`system`
   * 按契约 `Message.type` 闭集取子集。纯展示派生，不改契约语义、不改数据。
   */
  _visible: function (items, filter) {
    const spec = FILTERS.filter(function (item) { return item.value === filter })[0]
    if (!spec) return items
    if (spec.unreadOnly) return items.filter(function (item) { return item.unread })
    if (spec.types) {
      return items.filter(function (item) { return spec.types.indexOf(item.type) !== -1 })
    }
    return items
  },

  /** 「全部已读」按钮的禁用依据：当前已加载的消息里是否还有未读项。 */
  _hasUnread: function (items) {
    return items.some(function (item) { return item.unread })
  },

  /**
   * 筛选切换（demo messages 页 `.chip`／`.chip.active` ⇒ `.chip--active`）：
   * 只切本地视图，不重新请求、不改任何数据；切到某一档后若一条都没命中，
   * WXML 沿用 state-view 的 empty 口径如实说明（不新造状态、不伪造消息）。
   */
  onFilter: function (event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset
      : {}
    const next = dataset.filter
    const spec = FILTERS.filter(function (item) { return item.value === next })[0]
    if (!spec) return
    if (next === this.data.filter) return
    this.setData({
      filter: next,
      filterLabel: spec.label,
      visibleItems: this._visible(this.data.items, next)
    })
  },

  /**
   * 标记已读：契约 `markMessageRead` 幂等且单调；`If-Match` 用**当前** revision。
   * 成功只采信服务端返回的消息本体（不本地猜测 read_at/revision）。
   * 单条按钮与「全部已读」共用本函数：一条一条走**同一个既有写接口**，不新增批量接口。
   */
  _markReadOne: function (id, revision) {
    const that = this
    this.setData({ markingId: id })
    return api.markMessageRead(id, revision).then(function (result) {
      that.setData({ markingId: '' })
      const items = that.data.items.map(function (item) {
        if (item.id !== result.message.id) return item
        return Object.assign({}, item, {
          revision: result.message.revision,
          unread: result.message.read_at === null,
          readAt: result.message.read_at || '',
          referenceNote: result.message.target_ref === null
            ? NO_TARGET_NOTE
            : REFERENCE_NOTES[result.message.reference_state]
        })
      })
      that.setData({
        items: items,
        visibleItems: that._visible(items, that.data.filter),
        hasUnread: that._hasUnread(items)
      })
      return result
    }).catch(function (error) {
      that.setData({ markingId: '' })
      throw error
    })
  },

  onMarkRead: function (event) {
    const dataset = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset
      : {}
    const id = dataset.id || ''
    const revision = Number(dataset.revision)
    if (!id || this.data.markingId || this.data.markingAll) return
    const that = this
    this._markReadOne(id, revision).then(function () {
      that.refreshUnread()
    }).catch(function (error) {
      if (error && error.code === 'SESSION_REQUIRED') { that.setData({ guest: true, status: 'idle' }); return }
      wx.showToast({ title: api.message(error), icon: 'none' })
    })
  },

  /**
   * 「全部已读」（demo `data-action="read-all"`）：**逐个串行**复用上面的单条路径，
   * 不并发（并发会拿同一份 revision 打服务端）、不新增批量接口；任一条失败即停：
   * 已标记的保持已标记，如实告知标记了几条、停在哪一步，不假装整批成功。
   * 结束时**只**重新读一次未读数（不随条数放大请求）。
   */
  onMarkAllRead: function () {
    if (this.data.markingAll || this.data.markingId) return
    const targets = this.data.items.filter(function (item) { return item.unread })
    if (!targets.length) return
    const that = this
    let index = 0
    let marked = 0
    this.setData({ markingAll: true })
    const step = function () {
      if (index >= targets.length) {
        that.setData({ markingAll: false })
        that.refreshUnread()
        wx.showToast({ title: '已将 ' + marked + ' 条消息标为已读', icon: 'none' })
        return
      }
      const target = targets[index]
      index += 1
      that._markReadOne(target.id, target.revision).then(function () {
        marked += 1
        step()
      }).catch(function (error) {
        that.setData({ markingAll: false })
        that.refreshUnread()
        if (error && error.code === 'SESSION_REQUIRED') { that.setData({ guest: true, status: 'idle' }); return }
        wx.showModal({
          title: '全部已读未完成',
          content: '已按顺序标记 ' + marked + ' 条，下一条失败即停：' + api.message(error),
          showCancel: false
        })
      })
    }
    step()
  }
})
