const fontScale = require('../../utils/font-scale')
// GY-I07 科普／除草剂查询 · 列表页（作物—杂草—除草方式导航 + 关键词／地区筛选）。
//
// 数据来源（GY-I07 D1）：**两条路径，逐条可判定，互不冒充**。
// - `data_source='server'`：运行时启用联网（runtime.mode==='local' 且 apiBaseUrl 非空），且本次条件集合
//   落在本页实际提交的参数面内（`q`／`registration_number`／`crop_id`；判据唯一真源是
//   `services/api/src/routes/knowledge.ts` 的 querystring schema，客户端不信自己的记忆）时，走服务端
//   真实接口（miniprogram/utils/knowledge-api.js）：**作物**服务端真按 `crop_ids` 收窄，故随请求真的提交。
// - `data_source='bundled-offline'`：未启用联网，或带了服务端**确实不接受**的条件（`species_id` 杂草、
//   `dosage_form` 剂型），或带了 `region_code`（地区）时，读随包离线副本（packages/knowledge/** →
//   miniprogram/data/**，经 utils/reference.js），页面**显式标注**离线来源与真实原因，绝不冒充服务端读数。
//   **地区不是"接口不支持"**：`region_code` 在服务端参数面内，但当前资料零条标注适用地区，且响应体
//   （`{data:{items,next_cursor},meta}`）不回 `match_state`/`reasons` ⇒ 提交它只会把"未标注"显示成
//   "不满足所选条件"，故本版不提交、改走随包副本并写明"资料未标注适用地区"（接它需服务端先补
//   `match_state` 出口，下一片）。
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

  // 来源判定（可判定标记 + 真实原因，不是纯文案）。判据是服务端 `/herbicides` 的 querystring schema：
  // 它接受 `q`／`registration_number`／`crop_id`／`region_code`（另有分页 `cursor`／`limit`）。但"服务端接受"
  // 不等于"提交了就能如实显示"：**作物**服务端真按 `crop_ids` 收窄（随包 20 条记录 20/20 都标了），所以
  // 作物只推向服务端、绝不能成为回退离线的理由；**地区**参数服务端虽接受，但当前资料零条标注适用地区，
  // 且响应体不回 `match_state`/`reasons` ⇒ 提交它只会把"未标注"显示成"不满足所选条件"，故本版改走随包
  // 副本并如实写"资料未标注适用地区"。`species_id`／`dosage_form` 则是该接口根本没有的参数。逐条点名真因
  // （不笼统写成"作物／杂草／地区"，也不写成"接口不支持地区"）。
  // 未启用联网（runtime.mode 非 local 或 apiBaseUrl 为空）时也无法发起请求。
  querySource: function () {
    if (!auth.networkEnabled()) return {
      source: knowledgeApi.HERBICIDE_SOURCES.BUNDLED_OFFLINE,
      label: '数据来源：随包离线副本（bundled-offline）——当前运行未启用联网（runtime.mode 非 local），不冒充服务端读数。'
    }
    // 逐条点名**真实原因**（三种原因不同，不许混成一句）：
    //   - species_id／dosage_form：服务端 schema 里没有这两个键，硬发只会换回 400 INVALID_REQUEST；
    //   - region_code：服务端 schema **接受**它，但资料未标注适用地区 + 响应不回 match_state ⇒ 提交后只能误报。
    const rejected = []
    if (this.data.speciesId) rejected.push('杂草（species_id）：该接口没有这个参数')
    if (this.data.dosageForm) rejected.push('剂型（dosage_form）：该接口没有这个参数')
    if (this.data.regionCode) rejected.push('地区（region_code）：资料未标注适用地区，无法确认')
    if (rejected.length) return {
      source: knowledgeApi.HERBICIDE_SOURCES.BUNDLED_OFFLINE,
      label: '数据来源：随包离线副本（bundled-offline）——以下条件服务端当前无法如实判定，已改读随包副本（筛选条件未被丢弃）：' + rejected.join('；') + '。'
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
    // 结构化条件：只有 `crop_id` 会真的提交——服务端按记录的 `crop_ids` 收窄，不提交就等于页面显示
    // "已筛选"而实际是全量。`region_code` 仍**不提交**：服务端虽接受该参数（并已回 `query_state`），
    // 但当前资料零条标注适用地区，本片不改筛选面（选地区仍走随包副本并如实标注"未标注"）。
    const sent = []
    if (self.data.cropId) { input.crop_id = self.data.cropId; sent.push('crop_id') }
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
      // 判定一律取服务端真值 `query_state`，**不按 `items.length` 反推**（旧实现就是那句谎报）：
      //   · 响应没有该字段 ⇒ `null`，页面如实说"未提供判定"，不猜 matched/no_match；
      //   · `insufficient` = 该条件在资料里未标注/未采集 ⇒ 文案说"无法确认"，**不许**说成"不满足"；
      //   · `total`/`match_state` 是**裁剪前**领域判定，`items` 是权限裁剪后的当前页 ⇒ `total` 大于
      //     本页条数只表示"有记录被隐藏"，不是 `no_match`。
      const state = result.queryState
      self.setData({
        busy: false,
        modeNote: knowledgeApi.herbicideModeNote(result.mode),
        matchState: state ? state.match_state : '',
        matchLabel: state ? reference.matchStateLabel(state.match_state) : '服务端未提供匹配判定',
        items: items,
        total: state ? state.total : 0,
        nextCursor: result.nextCursor,
        reasons: state ? state.reasons : [],
        unmatchedReasons: state ? state.unmatched_reasons : [],
        simulatedExcluded: state ? state.simulated_excluded : 0,
        sourceVersionNote: rows.length ? rows[0].source_version : '',
        countNote: countNoteOf(state, rows.length),
        // 命中条件优先用服务端回传的 `matched_dimensions`（服务端**真的**应用过的维度）；没有判定时
        // 退回"本次真的提交了哪些维度"——两者都不冒充未提交的条件。
        matchedNote: matchedNoteOf(state ? state.matched_dimensions : sent),
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

  // 路径二：随包离线副本（逐条标注来源）——仅在未联网、或带了该接口**确实不接受**的条件时使用。
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

// 本页条数说明。口径：`queryState.total` 是服务端**裁剪前**的领域判定，`items` 是权限裁剪后的
// 可见集 ⇒ 两者可以不等（差额是"存在但你看不到"的记录），所以分开说，不把差额算成"没有资料"。
// 放在文件末尾是为了不移动上文既有行号——证据页对 `runServerQuery()` 的引用按行号取证。
function countNoteOf(state, pageCount) {
  if (!state) return pageCount ? '本页 ' + pageCount + ' 条（服务端未提供匹配判定）' : ''
  if (!state.total) return ''
  return '本页 ' + pageCount + ' 条 / 共 ' + state.total + ' 条（总数为裁剪前领域判定）'
}