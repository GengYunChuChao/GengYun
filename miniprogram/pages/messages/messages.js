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
// 不伪造标题与正文。
//
// 跳转入口（#17 G1）：目标可用性端口接线后（#425），`reference_state` 可以为 `available`。
// 本页据此提供**唯一**跳转入口，且只在服务端说「可查看」时出现：
//   - `target_ref.type === 'post'`   ⇒ 直接进社区详情页（`?id=<帖子 uuid>`）；
//   - `target_ref.type === 'comment'` ⇒ 先按契约 `GET /comments/{id}` 取 `comment.post_id` 再进详情页
//     （详情页只接帖子 uuid；评论 id 不是帖子 id，塞错会打开错内容）；
//   - 其余情况（`unavailable`、无目标、类型不由社区详情页承接）⇒ **不可点**，行内如实说明，
//     且说明里**不**暗示对方是否删除（与服务端「未接线目标不泄露存在性」同口径）。
const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const navigation = require('../../utils/navigation')
const communityApi = require('../../utils/community-api')
const api = require('../../utils/messages-api')

/** 社区详情页的真实路由（`app.json` 的 pages + `utils/navigation.js` 的 ID_PAGES／UUID_ID_PAGES 同一份事实）。 */
const COMMUNITY_DETAIL_PATH = '/pages/communitydetail/communitydetail'
/** 社区详情页能承接的目标类型（服务端 `reference-community.ts` 只给这两型判 `available`）。 */
const DETAIL_TARGET_TYPES = ['post', 'comment']

/** `Message.type` 闭集（契约 comment|like|moderation|system）⇒ 页面固定标签与图标。 */
const TYPE_LABELS = {
  comment: { label: '评论', icon: 'chat' },
  like: { label: '点赞', icon: 'heart' },
  moderation: { label: '内容审核结果', icon: 'shield' },
  system: { label: '系统通知', icon: 'tab-bell' }
}
/**
 * 目标跳转性的如实说明。措辞纪律（与服务端 `reference-community.ts` 同一口径）：
 * 「不可查看」只描述**当前这条消息打不开目标**，不区分目标是不存在、已下架还是无权查看
 * —— 服务端对未接线类型恒判 `unavailable`，本页也不得据此推测对方内容是否被删除。
 */
const REFERENCE_NOTES = {
  available: '关联内容当前可查看，点这一条进入社区详情。',
  unavailable: '关联内容当前不可查看，本条不提供跳转入口。'
}
/** 兜底：服务端判 `available` 但目标类型不由社区详情页承接（当前不可能发生，只为不骗人而不给「点这里」）。 */
const UNSUPPORTED_TARGET_NOTE = '本条关联目标暂不在消息页提供跳转入口。'
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
    // B7：契约错误码透传给 state-view（统一层判定分类与可重试性，403 升级为 denied 语气）。
    errorCode: '',
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
    unreadNote: '未读数尚未读取',
    // #17 G3：未读数取不到时，pill 自身成为可点重试入口（`onRetry` 只在 status==='error' 分支可达，
    // 「列表成功 + 未读数失败」时原本没有任何可点重试）。取到即收起，避免出现无意义的可点 pill。
    unreadRetryable: false
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

  /** 失败态的统一收口：标题/说明/错误码一处生成，避免各分支各写一套（B7 由 state-view 判 denied）。 */
  _fail: function (error) {
    this.setData({
      status: 'error',
      errorText: api.message(error),
      errorCode: (error && error.code) || '',
      stateTitle: api.stateTitle(error),
      stateDesc: api.message(error),
      modeNote: '',
      stubNote: ''
    })
  },

  /** 每次进入/重试都从第一页重新查询（服务端游标绑定主体，不能复用旧游标）。 */
  reload: function (done) {
    const epoch = (this._epoch = (this._epoch || 0) + 1)
    const that = this
    // 换代即作废旧分页：旧 `onLoadMore` 的响应会因 epoch 不符提前 return，**不会**再替自己解忙锁。
    // 因此忙锁必须由新一代替这里复位，否则「翻页在飞时刷新」会让 `loadingMore` 永久为 true。
    this.setData({ status: 'loading', errorText: '', errorCode: '', stateTitle: '', stateDesc: '', loadingMore: false })
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
      that._fail(error)
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
      // 游标失效（15 分钟 TTL 到期、水位变化、主体/auth_epoch 变化）⇒ 这条游标**永远不会**再成功：
      // 清掉它并从第一页重载，而不是留着死游标让用户反复点「加载更多」看同一句报错。
      if (error && error.code === 'INVALID_CURSOR') {
        that.setData({ nextCursor: null })
        that.reload()
        wx.showToast({ title: '列表已过期，已重新载入', icon: 'none' })
        return
      }
      wx.showToast({ title: api.message(error), icon: 'none' })
    })
  },

  /**
   * 未读数是**派生量**：每次都向服务端重新读取，本地不维护计数器。
   * 取不到时**不动角标**（`#17` G6）：保留上一次已知读数——从来没读到过就还是空，但**绝不**
   * 把它写成 `''`／`0`，那等于把「读取失败」渲染成「没有未读」。同时如实说明未取得，
   * 并留一条结构化告警（只含 `event`/`code`，见 `utils/messages-api.js` 的 `warnUnreadFailure`）。
   *
   * 并发保护（世代号）：进入页面时的读取、标记单条后的读取、全部已读结束后的读取会同时在飞，
   * 响应次序**不由请求次序决定**。若不设世代号，先发后到的**旧**读数会覆盖刚拿到的新读数
   * （典型：标记已读后 count 3→2，但更早那次读到 3 的响应晚到 ⇒ 角标弹回 3）。
   * 只采纳**最后一次发出**的请求结果，过期响应直接丢弃。
   */
  refreshUnread: function () {
    const that = this
    const epoch = (this._unreadEpoch = (this._unreadEpoch || 0) + 1)
    if (!auth.isLoggedIn()) {
      this._applyUnread('')
      this.setData({ unreadNote: '未读数尚未读取', unreadRetryable: false })
      return
    }
    api.getUnreadCount().then(function (result) {
      if (epoch !== that._unreadEpoch) return
      that._applyUnread(api.unreadText(result.count))
      that.setData({
        unreadNote: result.count > 0 ? '未读 ' + result.count + ' 条' : '暂无未读',
        unreadRetryable: false
      })
    }).catch(function (error) {
      if (epoch !== that._unreadEpoch) return
      // G6（#17）：失败分支**不进 `_applyUnread`**——一次 setData 都不发给角标，
      // 角标停在最后一次已知读数上（从未成功读到过就仍是空），失败不再被清成「0 条未读」。
      api.warnUnreadFailure(error)
      that.setData({
        unreadNote: (api.unwired(error) ? '未读数未取得：服务端未接线' : '未读数未取得：' + api.message(error)) +
          '（点此重试）',
        unreadRetryable: true
      })
    })
  },

  /**
   * 未读数重试（#17 G3，`messages.wxml` 的 pill `bindtap`）。
   *
   * 为什么单独一个入口：`onRetry` 只挂在 `status === 'error'` 的 state-view 上，
   * 「列表成功 + 未读数失败」时该分支不可达 ⇒ 用户只能退出重进。这里**只重读未读数**
   * （列表本来就成功，不重载列表、不打断已渲染内容），并发保护沿用 `refreshUnread` 的世代号。
   */
  onRetryUnread: function () {
    if (!this.data.unreadRetryable) return
    this.setData({ unreadRetryable: false })
    this.refreshUnread()
  },

  /**
   * 打开消息行关联的社区内容（#17 G1，`messages.wxml` 行上的 `bindtap`）。
   *
   * 只做一件事：把**服务端判定可查看**的目标送到社区详情页。三层判定，缺一不跳：
   *   1. 该行 `canOpen`（`reference_state === 'available'` 且 `type ∈ {post, comment}`）；
   *   2. `post` 直接用 `target_ref.id`（帖子 uuid）；`comment` 先按契约 `GET /comments/{id}`
   *      取 `comment.post_id`（详情页只接帖子 uuid，评论 id 当帖子 id 会打开错内容）；
   *   3. 路由与参数交给 `utils/navigation.openTarget` 统一校验（只认 `?id=<uuid>`，不认任意串）。
   * 任何一步失败都**不猜**：不跳转、只提示一句，且提示里不说目标是否存在／是否被删。
   */
  onOpenTarget: function (event) {
    const that = this
    const dataset = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset
      : {}
    const id = dataset.id
    if (!id || this._openingTarget) return
    const item = this.data.items.filter(function (entry) { return entry.id === id })[0]
    // 不可用的行**不跳转**（行内已有如实说明）；这是唯一闸门，不按类型猜目标。
    if (!item || item.canOpen !== true) return
    // 双击保护：从这次点击到「跳转已发起」之间只放行一次（评论目标是异步的，期间再点不重复取数）。
    // 释放点就在发跳转的那一刻，任何分支都不会把标记留在页面上（导航本身由 router 兜底）。
    this._openingTarget = id
    const open = function (postId) {
      that._openingTarget = ''
      that._openDetail(postId)
    }
    if (item.targetType === 'post') { open(item.targetId); return }
    communityApi.getComment(item.targetId).then(function (result) {
      return result.comment.post_id
    }).then(open).catch(function () {
      that._openingTarget = ''
      // 与行内文案同口径：只说这次打不开，不暗示对方内容是否被删除。
      wx.showToast({ title: '关联内容当前不可查看', icon: 'none' })
    })
  },

  /** 社区详情页的统一出口：先校验 uuid，再交给 `navigation.openTarget` 判路由与跳法。 */
  _openDetail: function (postId) {
    if (!communityApi.validId(postId)) {
      wx.showToast({ title: '关联内容当前不可查看', icon: 'none' })
      return
    }
    navigation.openTarget(COMMUNITY_DETAIL_PATH + '?id=' + encodeURIComponent(postId), false,
      function (errorText) { if (errorText) wx.showToast({ title: errorText, icon: 'none' }) })
  },

  /** 角标只读展示在既有 custom-tab-bar 上；不改变 tabBar 配置语义。 */
  _applyUnread: function (textValue) {
    this.setData({ unreadText: textValue })
    const bar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (bar && typeof bar.setData === 'function') bar.setData({ unreadText: textValue })
  },

  /** 列表项展示字段：只做**展示**派生（类型标签 + 目标可跳转性说明 + 可跳转判定），不改契约语义。 */
  _decorate: function (items) {
    return items.map(function (message) {
      const meta = TYPE_LABELS[message.type] || { label: '通知', icon: 'tab-bell' }
      const target = message.target_ref
      // 唯一的可点判据：服务端说可查看，且目标类型由社区详情页承接。
      const canOpen = message.reference_state === 'available' && target !== null &&
        DETAIL_TARGET_TYPES.indexOf(target.type) !== -1
      let referenceNote = NO_TARGET_NOTE
      if (target !== null) {
        if (canOpen) referenceNote = REFERENCE_NOTES.available
        else if (message.reference_state === 'available') referenceNote = UNSUPPORTED_TARGET_NOTE
        else referenceNote = REFERENCE_NOTES.unavailable
      }
      return {
        id: message.id,
        revision: message.revision,
        type: message.type,
        label: meta.label,
        icon: meta.icon,
        unread: message.read_at === null,
        readAt: message.read_at || '',
        time: message.created_at,
        // `target_ref` 只用于跳转定位（帖子 uuid／评论 uuid），不渲染成正文，也不拼进任何文案。
        targetType: target === null ? '' : target.type,
        targetId: target === null ? '' : target.id,
        canOpen: canOpen,
        referenceNote: referenceNote
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
      // 403 系（deny）不是「请先登录」：整页收口到 denied 态（state-view 按错误码判定），
      // 不用一句 toast 掩饰 —— 否则用户会反复点、也看不见「没有权限」这件事。
      if (error && (error.code === 'SCOPE_DENIED' || error.code === 'CONSENT_REQUIRED' ||
        error.code === 'ACCOUNT_INACTIVE')) {
        that._fail(error)
        return
      }
      // 本地 revision 已过期（另一处先写成功）⇒ 必须重新读取拿当前 If-Match；
      // 否则后续每一次点击都带着旧版本号再打 409，用户会看到「一直失败」而无法自愈。
      if (error && error.code === 'REVISION_CONFLICT') {
        wx.showToast({ title: api.message(error), icon: 'none' })
        that.reload()
        that.refreshUnread()
        return
      }
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
        if (error && (error.code === 'SCOPE_DENIED' || error.code === 'CONSENT_REQUIRED' ||
          error.code === 'ACCOUNT_INACTIVE')) { that._fail(error); return }
        const stale = !!error && error.code === 'REVISION_CONFLICT'
        wx.showModal({
          title: '全部已读未完成',
          content: '已按顺序标记 ' + marked + ' 条，下一条失败即停：' + api.message(error),
          showCancel: false
        })
        // 版本冲突时整批剩余条目都拿的是旧版本号 ⇒ 重新读取，避免用户重试仍然逐条 409。
        if (stale) that.reload()
      })
    }
    step()
  }
})
