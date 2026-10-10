// GY-I07 科普／除草剂查询 · 列表页（作物—杂草—除草方式导航 + 关键词／地区筛选）。
//
// 数据形态说明（务必如实展示，不夸大）：
// - 共享源码 runtime.mode 为 'disabled'，本页**不联网**；数据来自仓库内同一份
//   资料契约（packages/knowledge/** → miniprogram/data/**），口径与域库
//   packages/reference 一致：同一 eligibility 判定、同一 source_version、同一标签。
// - 页面顶部常驻「替身边界」提示：未联网时给出的是本地资料读数，不是在线权威查询结果。
// - 列表与详情必须展示**同一个 source_version**；不得因模糊药名合并不同含量的剂型。

const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const reference = require('../../utils/reference')

const PAGE_SIZE = 20

Page({
  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    // 导航：作物 → 杂草 → 除草方式
    crops: [],
    species: [],
    regions: [],
    cropIndex: -1,
    speciesIndex: -1,
    regionIndex: -1,
    keyword: '',
    // 结果
    matchState: '',
    matchLabel: '',
    items: [],
    total: 0,
    nextCursor: null,
    reasons: [],
    unmatchedReasons: [],
    simulatedExcluded: 0,
    modeNote: '',
    catalogVersion: '',
    sourceVersionNote: '',
    busy: false,
    detailId: '',
    // G2：会话门禁状态。**未通过服务端核实前恒为 false**，
    // 资料加载/搜索处理器一律以该标志为准（不依赖跳转必然成功）。
    gatePassed: false
  },

  onLoad: function () {
    fontScale.applyFontScale(this)
    // 门禁前置：会话须先经服务端核实，**核实通过前不加载任何资料**（避免越权预览窗口）。
    const self = this
    auth.requireLogin(function (loggedIn) {
      if (!loggedIn) {
        // 未通过：清空全部门禁标志与结果，确保不残留任何记录。
        self.setData({ gatePassed: false, items: [], total: 0, nextCursor: null, matchState: '', matchLabel: '', reasons: [], unmatchedReasons: [], sourceVersionNote: '' })
        return
      }
      self.setData({
        gatePassed: true,
        crops: reference.crops,
        species: reference.species,
        regions: reference.regions,
        modeNote: reference.modeNote(),
        catalogVersion: reference.catalogVersionText()
      })
      self.runQuery()
    })
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    // 重入兜底：离开期间会话可能已失效；未通过则先清空再跳转，不残留旧数据。
    if (!auth.isLoggedIn()) {
      // 先关门禁再清数据：即便跳转未成功，处理器也无法再加载资料。
      this.setData({ gatePassed: false, items: [], total: 0, nextCursor: null, sourceVersionNote: '' })
      auth.requireLogin()
    }
  },

  onKeyword: function (event) {
    this.setData({ keyword: event.detail.value })
  },

  onCrop: function (event) {
    const index = Number(event.detail.value)
    const crop = index >= 0 ? this.data.crops[index] : null
    this.setData({
      cropIndex: index,
      cropId: crop ? crop.id : '',
      // 换作物即清空杂草选择，避免旧筛选与新作物口径不一致。
      speciesIndex: -1,
      speciesId: ''
    })
    this.runQuery()
  },

  onSpecies: function (event) {
    const index = Number(event.detail.value)
    const species = index >= 0 ? this.data.species[index] : null
    this.setData({ speciesIndex: index, speciesId: species ? species.id : '' })
    this.runQuery()
  },

  onRegion: function (event) {
    const index = Number(event.detail.value)
    const region = index >= 0 ? this.data.regions[index] : null
    this.setData({ regionIndex: index, regionCode: region ? region.code : '' })
    this.runQuery()
  },

  onSearch: function () {
    this.runQuery()
  },

  onReset: function () {
    this.setData({ keyword: '', cropIndex: -1, speciesIndex: -1, regionIndex: -1, cropId: '', speciesId: '', regionCode: '' })
    this.runQuery()
  },

  onLoadMore: function () {
    if (!this.data.nextCursor) return
    this.runQuery(this.data.nextCursor)
  },

  runQuery: function (cursor) {
    const self = this
    // G2：门禁未通过则**拒绝加载**——不依赖跳转是否成功（跳转可能被拦截/失败）。
    if (!self.data.gatePassed || !auth.isLoggedIn()) {
      self.setData({ gatePassed: false, items: [], total: 0, nextCursor: null, matchState: '', matchLabel: '', reasons: [], unmatchedReasons: [], sourceVersionNote: '' })
      return
    }
    let result
    try {
      result = reference.query({
        keyword: self.data.keyword,
        crop_id: self.data.cropId,
        species_id: self.data.speciesId,
        region_code: self.data.regionCode,
        limit: PAGE_SIZE,
        cursor: cursor || ''
      })
    } catch (error) {
      // 非法请求才抛错；无结果/条件不足以 200 + match_state 表达，不走这里。
      self.setData({ matchState: 'invalid', matchLabel: reference.matchStateLabel('invalid'), items: [], total: 0, nextCursor: null })
      return
    }
    const items = cursor ? self.data.items.concat(result.items) : result.items
    self.setData({
      matchState: result.match_state,
      matchLabel: reference.matchStateLabel(result.match_state),
      items: items,
      total: result.total,
      nextCursor: result.next_cursor,
      reasons: result.reasons || [],
      unmatchedReasons: result.unmatched_reasons || [],
      simulatedExcluded: result.simulated_excluded || 0,
      // 列表来源版本：逐条展示（同一 source_version）。
      sourceVersionNote: result.items.length ? result.items[0].source_version : ''
    })
  },

  goDetail: function (event) {
    const id = event.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/referencedetail/referencedetail?id=' + encodeURIComponent(id) })
  }
})
