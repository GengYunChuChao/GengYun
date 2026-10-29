// GY-I15（#15）阶段 2 · 社区列表页。
//
// 形态对齐 docs/ui-demo/demo.html 的 community()／postCard()：分段「社区 ⇄ 资料库」、
// 筛选 chips、feed 卡片（作者/时间/标题/正文/点赞·评论·反馈）。
// 数据全部来自服务端契约接口；失败与空态收口到 `state-view`，**不展示任何本地伪造帖子**。
//
// 筛选：全部 / 我的（契约 `mine`）＋ 作物（`crop_id`，取自仓库既有作物目录数据）
//      ＋ 地区（`region_code`，取自既有浙江地区数据，形态 ^33[0-9]{4}$）。
const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const navigation = require('../../utils/navigation')
const api = require('../../utils/community-api')

const CROPS = require('../../data/crops').crops || []
const REGIONS = require('../../data/regions').regions || []

const CROP_ALL = { id: '', name: '全部作物' }
const REGION_ALL = { code: '', name: '全部地区' }

Page({
  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    guest: true,
    status: 'loading',
    errorText: '',
    // B7：把契约错误码透传给 state-view，由 utils/states.js 统一判定「哪类问题 + 能否重试」；
    // 403 系列会自动升级成 denied 语气（不是「请先登录」）。页面文案仍取 api.message(error)。
    errorCode: '',
    modeNote: '',
    // GY-I26：服务端 `mode` 为 stub／preset_demo 时的**置顶**替身标注（页尾小字不足以「明显」）。
    // 逐字取 `api.modeNote(mode)`，不新造第二套替身文案；real 模式保持为空，只留页尾说明。
    stubNote: '',
    posts: [],
    nextCursor: null,
    loadingMore: false,
    // C1：普通翻页失败（网络／服务不可用等）的**持续可读**提示，渲染在列表底部。
    // 失败时不清空 posts / nextCursor：已加载行保留，重试仍请求同一条下一游标。
    loadMoreError: '',
    filterMine: false,
    cropOptions: [CROP_ALL].concat(CROPS.map(function (c) { return { id: c.id, name: c.name } })),
    cropLabels: [CROP_ALL.name].concat(CROPS.map(function (c) { return c.name })),
    cropIndex: 0,
    regionOptions: [REGION_ALL].concat(REGIONS.map(function (r) { return { code: r.code, name: r.name } })),
    regionLabels: [REGION_ALL.name].concat(REGIONS.map(function (r) { return r.name })),
    regionIndex: 0
  },

  onLoad: function () {
    fontScale.applyFontScale(this)
    this._epoch = 0
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    const that = this
    // GY-I28：「我的耕云」的「我的发布」经 switchTab 进来（Tab 页不能带查询参数），
    // 消费一次性的进程内意图：命中即预选「我的投稿」（契约 `mine`），读完立刻清除。
    // 筛选只是**查询条件**，取数仍走 pageGate 门禁与 GET /posts?mine=true，不用本地数据顶替。
    if (navigation.consumeCommunityMine()) this.setData({ filterMine: true })
    this.setData({ guest: true, fontScale: fontScale.currentFontScale() })
    pageGate.start(this, function (ok) {
      that.setData({ guest: !ok })
      if (ok) that.reload()
    })
  },

  onHide: function () {
    // 离页后本页的在途读取即作废：旧 reload／翻页的成功或失败都不得再写页面状态。
    this._invalidateReads()
    pageGate.cancel(this)
  },
  onUnload: function () {
    this._invalidateReads()
    pageGate.cancel(this)
  },

  /**
   * 推进读取代次，作废所有**已发出**的列表读取（不取消服务端请求，只丢弃迟到结果）。
   *
   * - onHide／onUnload 调用：同一实例重进时，离页前发出的成功不会写 posts／cursor／状态，
   *   失败不会写 guest／errorCode／loadMoreError，INVALID_CURSOR 也不会再 toast 或 reload；
   * - reload 每次也推进同一计数器：它同时是筛选代次，旧筛选的迟到响应不能写进新筛选列表；
   * - onLoadMore 捕获发起时的代次，所以跨代次的分页响应同样被丢弃，不会重复追加。
   */
  _invalidateReads: function () {
    this._epoch = (this._epoch || 0) + 1
  },

  onPullDownRefresh: function () {
    const that = this
    this.reload(function () { wx.stopPullDownRefresh(); that.setData({ loadingMore: false }) })
  },

  /** 每次筛选变化都从第一页重新查询（服务端游标绑定主体/过滤/排序，不能复用旧游标）。 */
  reload: function (done) {
    const epoch = ++this._epoch
    const that = this
    // 新一次读取开始即重置翻页态：离页时被作废的旧 onLoadMore 不会再回来清 loadingMore，
    // 若不在这里复位，新页面会被旧请求遗留的 loadingMore 永久卡住（无法再分页）。
    this.setData({ status: 'loading', errorText: '', errorCode: '', posts: [], nextCursor: null, loadMoreError: '', loadingMore: false })
    api.listPosts(this._query(null)).then(function (page) {
      if (epoch !== that._epoch) return
      const mode = page.mode
      that.setData({
        status: page.items.length ? 'ready' : 'empty',
        posts: that._decorate(page.items),
        nextCursor: page.nextCursor,
        modeNote: api.modeNote(mode),
        stubNote: mode === 'stub' || mode === 'preset_demo' ? api.modeNote(mode) : ''
      })
      if (done) done()
    }).catch(function (error) {
      if (epoch !== that._epoch) return
      that._fail(error)
      if (done) done()
    })
  },

  /**
   * 失败收口（单一实现，读路径与「加载更多」共用）：
   *   - 会话类（`SESSION_REQUIRED` / `SESSION_CHANGED`）⇒ 回登录门禁，**不**留在错误页；
   *   - 其余如实进 error 态并把契约错误码透传给 `state-view`（403 由统一状态层升级成 denied）。
   */
  _fail: function (error) {
    if (api.sessionFailure(error)) { this.setData({ guest: true, status: 'idle', loadMoreError: '' }); return }
    this.setData({
      status: 'error',
      errorText: api.message(error),
      errorCode: (error && error.code) || '',
      modeNote: '',
      stubNote: '',
      loadMoreError: ''
    })
  },

  onLoadMore: function () {
    const that = this
    // 防重复点击／重复追加：同一时刻只允许一个翻页请求在飞。
    // 失败后 nextCursor 原样保留，所以「重试」再次调用本方法时请求的仍是**同一条**下一游标。
    if (this.data.loadingMore || !this.data.nextCursor) return
    const cursor = this.data.nextCursor
    this.setData({ loadingMore: true, loadMoreError: '' })
    const epoch = this._epoch
    api.listPosts(this._query(cursor)).then(function (page) {
      if (epoch !== that._epoch) return
      that.setData({
        posts: that.data.posts.concat(that._decorate(page.items)),
        nextCursor: page.nextCursor,
        loadingMore: false,
        loadMoreError: ''
      })
    }).catch(function (error) {
      if (epoch !== that._epoch) return
      that.setData({ loadingMore: false })
      // 会话失效 / 403：不是「这一次翻页没成功」，而是整页的取数前提没了 ⇒ 走统一失败收口。
      if (api.sessionFailure(error) || api.forbidden(error)) { that._fail(error); return }
      // 失效游标：服务端已声明这条游标永不成功（15 分钟 TTL、期间有新内容、主体/世代变化）。
      // 改前只弹一句 toast，`nextCursor` 原样留着 ⇒ 用户每点一次「加载更多」都会看到同一句报错。
      if (error && error.code === 'INVALID_CURSOR') {
        that.setData({ nextCursor: null, loadMoreError: '' })
        wx.showToast({ title: '列表已过期，已重新载入', icon: 'none' })
        that.reload()
        return
      }
      // 普通网络／服务失败：保留已加载行与合法 cursor，在列表底部给出**持续可读**的
      // 失败提示与显式重试入口（wxml 的 loadMoreError 块），不再只弹一句会消失的 toast。
      // 文案由本页给出：适配层的 `api.message()` 带「已清空」口径，而翻页失败时我们**没有**清空，
      // 直接复用会变成假陈述；这里只陈述「这一页没读到 + 已加载内容仍在」。
      that.setData({ loadMoreError: that._loadMoreMessage(error) })
    })
  },

  _loadMoreMessage: function (error) {
    if (error && error.code === 'NETWORK_UNCERTAIN') {
      return '网络未能确认这次请求，已加载的内容仍然保留，可以重试这一页。'
    }
    const code = (error && error.code) || 'UNKNOWN'
    return '服务暂时没有返回下一页（' + code + '），已加载的内容仍然保留，可以重试这一页。'
  },

  _query: function (cursor) {
    const crop = this.data.cropOptions[this.data.cropIndex] || CROP_ALL
    const region = this.data.regionOptions[this.data.regionIndex] || REGION_ALL
    const params = {}
    if (cursor) params.cursor = cursor
    if (this.data.filterMine) params.mine = true
    if (crop.id) params.crop_id = crop.id
    if (region.code) params.region_code = region.code
    return params
  },

  /**
   * 列表项展示字段：只做**展示**派生（可见性/审核状态如实标注），不改契约语义。
   *
   * 审核结论的措辞一律取适配层 `api.outcomeOf`（唯一一张表）：改前这里把
   * `pending`/`quarantined`/`rejected` 一律写成「待审／未公开」，于是「隔离待复核」与
   * 「明确驳回」在列表上完全同形，被驳回的还被告知「待审」。
   */
  _decorate: function (items) {
    return items.map(function (post) {
      const author = api.authorView(post.author)
      const outcome = api.outcomeOf(post)
      return {
        id: post.id,
        revision: post.revision,
        title: post.title,
        body: post.body,
        author: author.name,
        authorAvatar: author.avatar,
        authorAnonymized: author.anonymized,
        time: post.created_at,
        crop_id: post.crop_id,
        region_code: post.region_code,
        visibility: post.visibility,
        audit_state: post.audit_state,
        self: outcome.key !== 'approved',
        stateLabel: outcome.key === 'approved' ? '' : outcome.title,
        linkTitle: post.linked_knowledge && post.linked_knowledge.summary
          ? post.linked_knowledge.summary.title
          : '',
        linkState: post.linked_knowledge ? post.linked_knowledge.reference_state : ''
      }
    })
  },

  onToggleMine: function (event) {
    const mine = !!event.detail && event.detail.value === 'mine'
    if (mine === this.data.filterMine) return
    this.setData({ filterMine: mine }, this.reload.bind(this))
  },

  onCropChange: function (event) {
    this.setData({ cropIndex: Number(event.detail.value) }, this.reload.bind(this))
  },

  onRegionChange: function (event) {
    this.setData({ regionIndex: Number(event.detail.value) }, this.reload.bind(this))
  },

  /** 失败态的可点重试入口（community.wxml 的 error 分支 bind:action="onRetry"）。 */
  onRetry: function () { this.reload() },

  onOpenPost: function (event) {
    const id = event.currentTarget.dataset.id
    navigation.openTarget('/pages/communitydetail/communitydetail?id=' + encodeURIComponent(id), false, function (error) {
      if (error) wx.showToast({ title: error, icon: 'none' })
    })
  },

  onCreate: function () {
    navigation.openTarget('/pages/communitycreate/communitycreate', false, function (error) {
      if (error) wx.showToast({ title: error, icon: 'none' })
    })
  },

  onOpenLibrary: function () {
    navigation.openTarget('/pages/knowledge/knowledge', false, function (error) {
      if (error) wx.showToast({ title: error, icon: 'none' })
    })
  },

  onLogin: function () {
    const self = this
    auth.requireLogin(function (ok) { if (ok) { pageGate.cancel(self); self.onShow() } })
  }
})
