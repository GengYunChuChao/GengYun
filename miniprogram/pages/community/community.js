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
    modeNote: '',
    // GY-I26：服务端 `mode` 为 stub／preset_demo 时的**置顶**替身标注（页尾小字不足以「明显」）。
    // 逐字取 `api.modeNote(mode)`，不新造第二套替身文案；real 模式保持为空，只留页尾说明。
    stubNote: '',
    posts: [],
    nextCursor: null,
    loadingMore: false,
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

  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

  onPullDownRefresh: function () {
    const that = this
    this.reload(function () { wx.stopPullDownRefresh(); that.setData({ loadingMore: false }) })
  },

  /** 每次筛选变化都从第一页重新查询（服务端游标绑定主体/过滤/排序，不能复用旧游标）。 */
  reload: function (done) {
    const epoch = ++this._epoch
    const that = this
    this.setData({ status: 'loading', errorText: '', posts: [], nextCursor: null })
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
      if (error && error.code === 'SESSION_REQUIRED') { that.setData({ guest: true }); if (done) done(); return }
      that.setData({ status: 'error', errorText: api.message(error), modeNote: '', stubNote: '' })
      if (done) done()
    })
  },

  onLoadMore: function () {
    const that = this
    if (this.data.loadingMore || !this.data.nextCursor) return
    this.setData({ loadingMore: true })
    const epoch = this._epoch
    api.listPosts(this._query(this.data.nextCursor)).then(function (page) {
      if (epoch !== that._epoch) return
      that.setData({
        posts: that.data.posts.concat(that._decorate(page.items)),
        nextCursor: page.nextCursor,
        loadingMore: false
      })
    }).catch(function (error) {
      if (epoch !== that._epoch) return
      that.setData({ loadingMore: false })
      wx.showToast({ title: api.message(error), icon: 'none' })
    })
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

  /** 列表项展示字段：只做**展示**派生（可见性/审核状态如实标注），不改契约语义。 */
  _decorate: function (items) {
    return items.map(function (post) {
      return {
        id: post.id,
        revision: post.revision,
        title: post.title,
        body: post.body,
        author: post.author.display_name,
        authorState: post.author.state,
        time: post.created_at,
        crop_id: post.crop_id,
        region_code: post.region_code,
        visibility: post.visibility,
        audit_state: post.audit_state,
        self: post.visibility !== 'published' || post.audit_state !== 'approved',
        stateLabel: post.visibility === 'published' && post.audit_state === 'approved'
          ? ''
          : (post.visibility === 'hidden' ? '已下架（仅本人可见）' : '待审／未公开'),
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
