const fontScale = require('../../utils/font-scale')
// GY-I07 科普／除草剂查询 · 列表页（作物—杂草—除草方式导航 + 关键词／地区筛选）。
//
// 数据来源（GY-I07 D1）：**两条路径，逐条可判定，互不冒充**。
// - `data_source='server'`：运行时启用联网（runtime.mode==='local' 且 apiBaseUrl 非空）且**没有**
//   作物／杂草／地区条件时，走服务端真实接口 `GET /herbicides`（miniprogram/utils/knowledge-api.js）。
//   该接口 querystring 只接受 q／registration_number／cursor／limit（路由 schema
//   additionalProperties:false），结构化条件在服务端**不可表达** ⇒ 不静默丢弃条件。
// - `data_source='bundled-offline'`：未启用联网，或带结构化条件时，读随包离线副本
//   （packages/knowledge/** → miniprogram/data/**，经 utils/reference.js），页面**显式标注**
//   离线来源与原因，绝不冒充服务端读数。
// 两条路径共用：同一 source_version 展示口径；失败一律按闭集文案提示，**不落回离线副本**。
// 列表与详情必须展示**同一个 source_version**；不得因模糊药名合并不同含量的剂型。

const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const reference = require('../../utils/reference')
const knowledgeApi = require('../../utils/knowledge-api')

const PAGE_SIZE = 20

// #8：命中侧可解释字段（域库 `matched_dimensions`）→ 中文标签。
// 维度名与 packages/reference/query.mjs `appliedDimensions` 一一对应；未知维度原样显示（不吞字段）。
const DIMENSION_LABELS = {
  crop_id: '作物',
  species_id: '杂草',
  region_code: '地区',
  use_scene: '使用场景',
  growth_stage: '生育期',
  planting_method: '种植方式',
  dosage_form: '制剂（剂型）',
  ingredient_content: '有效成分/含量',
  registration_number: '登记证号',
  q: '关键词'
}

// 把「本次实际应用的筛选维度」翻成一句可核对的话：命中项都满足这些条件，条件未被放宽。
function matchedNoteOf(dimensions) {
  const list = (dimensions || []).map(function (dim) { return DIMENSION_LABELS[dim] || dim })
  if (list.length === 0) return ''
  return '命中条件：' + list.join('、') + '（筛选条件未被放宽）'
}

Page({
  data: {
    fontScale: 1,
    // 导航：作物 → 杂草 → 除草方式
    crops: [],
    species: [],
    regions: [],
    // #8：制剂（剂型）筛选项——由 utils/reference 依据随包记录确定性派生，不在页面硬编码。
    dosageForms: [],
    cropIndex: -1,
    speciesIndex: -1,
    regionIndex: -1,
    formIndex: -1,
    dosageForm: '',
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
    // GY-I07 D1：数据来源标记（**可判定**，不是文案）。'server' = 服务端 `/herbicides` 真实读数；
    // 'bundled-offline' = 随包离线副本。两者都必须如实展示，任一时刻不得互相冒充。
    dataSource: '',
    dataSourceLabel: '',
    countNote: '',
    // #8：命中条件说明（来自域库 matched_dimensions），空串即无结构化条件。
    matchedNote: '',
    queryError: '',
    // 失败态的可判定字段（#28）：错误码原样带出给 state-view 补分类与可重试性；
    // querySession 区分「会话失效」与「服务端失败」——两者的下一步动作不同（重新核实登录／原条件重查）。
    queryErrorCode: '',
    querySession: false,
    busy: false,
    detailId: '',
    // G2：会话门禁状态。**未通过服务端核实前恒为 false**，
    // 资料加载/搜索处理器一律以该标志为准（不依赖跳转必然成功）。
    gatePassed: false
  },

  onLoad: function (options) {
    const q = options || {}
    this._profileFilter = /^[A-Za-z0-9_-]{1,80}$/.test(q.crop_id || '') && /^33[0-9]{4}$/.test(q.region_code || '') ? { crop_id: q.crop_id, region_code: q.region_code } : null
    fontScale.applyFontScale(this); this.checkGate() },

  checkGate: function () {
    const self = this
    pageGate.start(this, function (loggedIn) {
      if (!loggedIn) {
        // 未通过：清空全部门禁标志与结果，确保不残留任何记录。
        self.setData({ gatePassed: false, items: [], total: 0, nextCursor: null, matchState: '', matchLabel: '', reasons: [], unmatchedReasons: [], sourceVersionNote: '' })
        return
      }
      const decision = self.querySource()
      self.setData({
        gatePassed: true,
        crops: reference.crops,
        species: reference.species,
        regions: reference.regions,
        dosageForms: reference.dosageForms || [],
        dataSource: decision.source,
        dataSourceLabel: decision.label,
        // 服务端读数未返回前只给「来源待定」口径：不宣称已取得接口数据。
        modeNote: decision.source === knowledgeApi.HERBICIDE_SOURCES.SERVER ? knowledgeApi.modeNote('') : reference.modeNote(),
        catalogVersion: reference.catalogVersionText()
      })
      if (self._profileFilter) {
        const filter = self._profileFilter; self._profileFilter = null
        const cropIndex = reference.crops.findIndex(function (c) { return c.id === filter.crop_id })
        const regionIndex = reference.regions.findIndex(function (r) { return r.code === filter.region_code })
        if (cropIndex < 0 || regionIndex < 0) {
          self.setData({ matchState: 'invalid', matchLabel: '当前资料目录不支持档案条件，请重新选择。', items: [], total: 0, nextCursor: null })
          return
        }
        self.setData({ cropId: filter.crop_id, regionCode: filter.region_code, cropIndex: cropIndex, regionIndex: regionIndex })
      }
      self.runQuery()
    })
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    if (!auth.isLoggedIn() || !this.data.gatePassed) this.checkGate()
  },
  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

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

  // #8：剂型筛选。只按记录的登记剂型收窄，**不提供含量换算、不提供用量**；
  // 未选即空串（等价「全部剂型」，不参与判定也不冒充已筛选）。
  onDosageForm: function (event) {
    const index = Number(event.detail.value)
    const form = index >= 0 ? this.data.dosageForms[index] : ''
    this.setData({ formIndex: index, dosageForm: form || '' })
    this.runQuery()
  },

  onSearch: function () {
    this.runQuery()
  },

  onReset: function () {
    this.setData({ keyword: '', cropIndex: -1, speciesIndex: -1, regionIndex: -1, formIndex: -1, cropId: '', speciesId: '', regionCode: '', dosageForm: '' })
    this.runQuery()
  },

  onLoadMore: function () {
    if (!this.data.nextCursor) return
    this.runQuery(this.data.nextCursor)
  },

  // 来源判定（可判定标记 + 原因，不是纯文案）：服务端 `/herbicides` 的 querystring 只接受
  // q／registration_number／cursor／limit ⇒ 作物／杂草／地区／剂型条件在该接口**不可表达**；
  // 未启用联网（runtime.mode 非 local 或 apiBaseUrl 为空）时也无法发起请求。
  querySource: function () {
    if (!auth.networkEnabled()) return {
      source: knowledgeApi.HERBICIDE_SOURCES.BUNDLED_OFFLINE,
      label: '数据来源：随包离线副本（bundled-offline）——当前运行未启用联网（runtime.mode 非 local），不冒充服务端读数。'
    }
    // #8：剂型条件单独如实说明（不笼统并入作物／杂草／地区，也不改既有文案口径）。
    if (this.data.dosageForm) {
      const others = Boolean(this.data.cropId || this.data.speciesId || this.data.regionCode)
      return {
        source: knowledgeApi.HERBICIDE_SOURCES.BUNDLED_OFFLINE,
        label: '数据来源：随包离线副本（bundled-offline）——服务端 /herbicides 不支持' + (others ? '作物／杂草／地区／剂型' : '剂型') + '条件，筛选条件未被丢弃。'
      }
    }
    if (this.data.cropId || this.data.speciesId || this.data.regionCode) return {
      source: knowledgeApi.HERBICIDE_SOURCES.BUNDLED_OFFLINE,
      label: '数据来源：随包离线副本（bundled-offline）——服务端 /herbicides 不支持作物／杂草／地区条件，筛选条件未被丢弃。'
    }
    return { source: knowledgeApi.HERBICIDE_SOURCES.SERVER,
      label: '数据来源：服务端接口 /herbicides（真实读数，等待返回）。' }
  },

  runQuery: function (cursor) {
    const self = this
    // G2：门禁未通过则**拒绝加载**——不依赖跳转是否成功（跳转可能被拦截/失败）。
    if (!self.data.gatePassed || !auth.isLoggedIn()) {
      self._queryActive = false
      self.setData({ gatePassed: false, items: [], total: 0, nextCursor: null, matchState: '', matchLabel: '', reasons: [], unmatchedReasons: [], sourceVersionNote: '', countNote: '', matchedNote: '', queryError: '', queryErrorCode: '', querySession: false, dataSource: '', dataSourceLabel: '' })
      return
    }
    const decision = self.querySource()
    if (decision.source === knowledgeApi.HERBICIDE_SOURCES.SERVER) { self.runServerQuery(cursor, decision); return }
    self.runBundledQuery(cursor, decision)
  },

  // 路径一：服务端真实接口（`GET /herbicides`）。异步 ⇒ 世代号 + 活跃标志丢弃过期回包，
  // 不回写已卸载或已重查的页面；失败按冻结闭集文案提示，**不落回离线副本**。
  runServerQuery: function (cursor, decision) {
    const self = this
    const operation = (self._queryOperation = (self._queryOperation || 0) + 1)
    self._queryActive = true
    const input = { limit: PAGE_SIZE }
    if (self.data.keyword) input.q = self.data.keyword
    if (cursor) input.cursor = cursor
    self.setData({ busy: true, dataSource: decision.source, dataSourceLabel: decision.label, queryError: '', queryErrorCode: '', querySession: false })
    const alive = function () {
      return self._queryActive === true && self._queryOperation === operation && self.data.gatePassed === true && auth.isLoggedIn()
    }
    knowledgeApi.listHerbicides(input).then(function (result) {
      if (!alive()) return
      const rows = result.items.map(function (item) { return knowledgeApi.herbicideRow(item) })
      const items = cursor ? self.data.items.concat(rows) : rows
      self.setData({
        busy: false,
        modeNote: knowledgeApi.herbicideModeNote(result.mode),
        matchState: items.length ? 'matched' : 'no_match',
        matchLabel: reference.matchStateLabel(items.length ? 'matched' : 'no_match'),
        items: items,
        total: 0,
        nextCursor: result.nextCursor,
        reasons: [],
        unmatchedReasons: [],
        simulatedExcluded: 0,
        sourceVersionNote: rows.length ? rows[0].source_version : '',
        countNote: rows.length ? '本页 ' + rows.length + ' 条（该接口不返回总数）' : '',
        // 服务端路径不携带结构化条件 ⇒ 无「命中条件」可说，恒空（不冒充已筛选）。
        matchedNote: '',
        queryError: '',
        queryErrorCode: '',
        querySession: false
      })
    }).catch(function (error) {
      if (!alive()) return
      const session = error && (error.code === 'SESSION_REQUIRED' || error.code === 'SESSION_CHANGED')
      self.setData({
        busy: false,
        gatePassed: session ? false : self.data.gatePassed,
        dataSource: knowledgeApi.HERBICIDE_SOURCES.SERVER,
        dataSourceLabel: '数据来源：服务端接口 /herbicides（本次请求未完成，未改用离线副本）。',
        items: [], total: 0, nextCursor: null, sourceVersionNote: '', reasons: [], unmatchedReasons: [], simulatedExcluded: 0,
        matchState: session ? '' : 'unavailable',
        matchLabel: session ? '' : reference.matchStateLabel('unavailable'),
        countNote: '',
        matchedNote: '',
        // 失败态：冻结闭集文案 + 原样错误码（不猜、不折叠成「没有资料」）；
        // session 单独标记，页面据此把下一步动作换成「重新核实登录」而不是「重试查询」。
        queryError: knowledgeApi.message(error),
        queryErrorCode: (error && error.code) || '',
        querySession: session
      })
    })
  },

  // 路径二：随包离线副本（逐条标注来源）——仅在未联网或带结构化条件时使用。
  runBundledQuery: function (cursor, decision) {
    const self = this
    self._queryActive = false
    let result
    try {
      result = reference.query({
        keyword: self.data.keyword,
        crop_id: self.data.cropId,
        species_id: self.data.speciesId,
        region_code: self.data.regionCode,
        dosage_form: self.data.dosageForm,
        limit: PAGE_SIZE,
        cursor: cursor || ''
      })
    } catch (error) {
      // 非法请求才抛错；无结果/条件不足以 200 + match_state 表达，不走这里。
      self.setData({ matchState: 'invalid', matchLabel: reference.matchStateLabel('invalid'), items: [], total: 0, nextCursor: null, countNote: '', matchedNote: '', queryError: '', queryErrorCode: '', querySession: false })
      return
    }
    const rows = result.items.map(function (row) {
      return Object.assign({}, row, { data_source: knowledgeApi.HERBICIDE_SOURCES.BUNDLED_OFFLINE, source_marker: '随包离线副本' })
    })
    const items = cursor ? self.data.items.concat(rows) : rows
    self.setData({
      dataSource: knowledgeApi.HERBICIDE_SOURCES.BUNDLED_OFFLINE,
      dataSourceLabel: decision.label,
      modeNote: reference.modeNote(),
      matchState: result.match_state,
      matchLabel: reference.matchStateLabel(result.match_state),
      items: items,
      total: result.total,
      nextCursor: result.next_cursor,
      reasons: result.reasons || [],
      unmatchedReasons: result.unmatched_reasons || [],
      simulatedExcluded: result.simulated_excluded || 0,
      // 列表来源版本：逐条展示（同一 source_version）。
      sourceVersionNote: rows.length ? rows[0].source_version : '',
      countNote: result.total ? '共 ' + result.total + ' 条符合条件' : '',
      matchedNote: matchedNoteOf(result.matched_dimensions),
      queryError: '',
      queryErrorCode: '',
      querySession: false
    })
  },

  // 失败态的「重试」入口（state-view 的 action，见 reference.wxml 失败块）。
  // 会话失效 ⇒ 重新核实门禁（不放行数据，也不假装已登录）；其余失败 ⇒ 用**当前条件**原样重查，
  // 不改条件、不改数据来源、不落回离线副本。
  onRetry: function () {
    if (this.data.querySession || !this.data.gatePassed) { this.checkGate(); return }
    this.runQuery()
  },

  goDetail: function (event) {
    const id = event.currentTarget.dataset.id
    // 跳转失败必须可见（页面栈满／路由被拦截时，点了卡片毫无反应会被当成「记录不存在」）。
    wx.navigateTo({
      url: '/pages/referencedetail/referencedetail?id=' + encodeURIComponent(id),
      fail: function () { wx.showToast({ title: '没能打开这条资料，请重试', icon: 'none' }) }
    })
  }
})
