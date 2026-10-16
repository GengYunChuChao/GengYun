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
  available: '关联内容当前可查看；跳转入口尚未接线，本版不提供跳转。',
  unavailable: '关联内容当前不可查看，本版不提供跳转（服务端目标读取端口未接线）。'
}
const NO_TARGET_NOTE = '本条不带关联目标（服务端只给事件类型与对象引用，不给正文）。'

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
    items: [],
    nextCursor: null,
    loadingMore: false,
    markingId: '',
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
      that.setData({
        status: page.items.length ? 'ready' : 'empty',
        items: that._decorate(page.items),
        nextCursor: page.nextCursor,
        modeNote: api.modeNote(page.mode)
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
        modeNote: ''
      })
      if (done) done()
    })
  },

  onRetry: function () { this.reload(); this.refreshUnread() },

  onLoadMore: function () {
    const that = this
    if (this.data.loadingMore || !this.data.nextCursor || this.data.status !== 'ready') return
    this.setData({ loadingMore: true })
    const epoch = this._epoch
    api.listMessages({ cursor: this.data.nextCursor }).then(function (page) {
      if (epoch !== that._epoch) return
      that.setData({
        items: that.data.items.concat(that._decorate(page.items)),
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
   * 标记已读：契约 `markMessageRead` 幂等且单调；`If-Match` 用**当前** revision。
   * 成功只采信服务端返回的消息本体（不本地猜测 read_at/revision），随后重新读取未读数。
   */
  onMarkRead: function (event) {
    const id = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.id : ''
    const revision = Number(event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.revision : NaN)
    if (!id || this.data.markingId) return
    const that = this
    this.setData({ markingId: id })
    api.markMessageRead(id, revision).then(function (result) {
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
      that.setData({ items: items })
      that.refreshUnread()
    }).catch(function (error) {
      that.setData({ markingId: '' })
      if (error && error.code === 'SESSION_REQUIRED') { that.setData({ guest: true, status: 'idle' }); return }
      wx.showToast({ title: api.message(error), icon: 'none' })
    })
  }
})
