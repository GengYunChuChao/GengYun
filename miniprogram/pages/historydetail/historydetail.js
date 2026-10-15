// GY-I16 识别历史详情页。
//
// 契约面：**没有** `GET /history/{id}`。因此本页：
//   1. 用 `GET /history`（**实时**读取，第一页）定位该记录 ⇒ 拿到实时 `job_state` 与
//      `reference_state`（这就是"读取时重查"的落点；旧链接里的状态字段一律忽略）；
//   2. 用列表页带入的**引用快照**兜底定位（记录在第 2 页之后时），但此时**不携带状态**：
//      页面如实说明"任务状态未从实时读取取得"，**不**展示可能过期的状态；
//   3. 目标详情由**已合并**的契约面提供：`GET /recognitions/{id}`（#9）或 `GET /ocr/{id}`（#10）。
//
// 候选与人工选择**分开**呈现（模型候选 ≠ 用户的人工选择）；OCR 的模型原始字段、人工更正字段
// 与核对结果三者分开；来源版本取 `model_version`。
// 用药安全：本页**不渲染**用量卡正文与登记用量数字，只报"存在 N 条"并提示以核验资料为准。
const fontScale = require('../../utils/font-scale')
const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const historyApi = require('../../utils/history-api')
const identify = require('../../utils/identify-api')

Page({
  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    gatePassed: false,
    checking: true,
    networkOff: false,
    busy: false,
    message: '',
    errorText: '',
    invalid: false,
    invalidReason: '',
    ignoredParams: [],
    kindLabel: '',
    locatedBy: '',
    stateKnown: false,
    stateLabel: '',
    stateDesc: '',
    stateTone: '',
    referenceLabel: '',
    referenceAvailable: false,
    createdAt: '',
    historyRevision: null,
    canDelete: false,
    recognized: false,
    modelCandidates: [],
    modelCandidateNote: '',
    manualSelection: null,
    uncertaintyReasons: [],
    sourceVersion: '',
    raw: null,
    corrected: null,
    correctedDiffers: false,
    verification: null,
    doseSafetyNote: ''
  },

  onLoad: function (options) {
    fontScale.applyFontScale(this)
    this._query = historyApi.parseDetailQuery(options || {})
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    const self = this
    self.setData({ gatePassed: false, checking: true, message: '', errorText: '', invalid: false, invalidReason: '' })
    pageGate.start(this, function (ok) {
      self.setData({ checking: false })
      if (!ok) { self.setData({ gatePassed: false }); return }
      self.setData({ gatePassed: true, networkOff: !auth.networkEnabled(), ignoredParams: self._query.ignored })
      if (self._query.valid === false) {
        self.setData({ invalid: true, invalidReason: '链接缺少可用的记录标识（id 必须是 uuid），已停止读取。' })
        return
      }
      if (auth.networkEnabled()) self.load()
    })
  },

  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

  load: function () {
    const self = this
    const id = self._query.id
    self.setData({ busy: true, errorText: '', invalid: false })
    historyApi.locateHistory(id, historyApi.PAGE_LIMIT_MAX).then(function (located) {
      if (!located) {
        self.setData({ busy: false, invalid: true, invalidReason: '该记录不存在、已删除、或不属于当前账号（服务端与"不存在"同形返回）。' })
        return null
      }
      const stateKnown = located.jobState !== null
      const stateView = stateKnown ? identify.describeJobState(located.jobState) : null
      const base = {
        busy: false,
        kindLabel: located.kind === 'recognition' ? '识草' : '标签识别',
        locatedBy: located.locatedBy,
        stateKnown: stateKnown,
        stateLabel: stateView ? stateView.title : '任务状态未从实时读取取得',
        stateDesc: stateView ? stateView.desc : '为避免展示可能过期的状态，本页不显示任务状态；详情字段仍来自服务端实时读取。',
        stateTone: stateView ? stateView.tone : 'warning',
        referenceAvailable: located.referenceState === 'available',
        referenceLabel: stateKnown
          ? (located.referenceState === 'available' ? '目标当前可读' : '目标当前不可用')
          : '可见性未从实时读取取得',
        createdAt: located.createdAt ? located.createdAt.replace('T', ' ').replace(/\.\d+/, '').replace(/Z$/, ' UTC') : '',
        historyRevision: located.historyRevision,
        canDelete: located.locatedBy === 'live'
      }
      if (located.kind === 'recognition') {
        return identify.getRecognition(located.targetId).then(function (result) {
          const detail = historyApi.recognitionDetailView(result.recognition, located.jobState === null ? '' : located.jobState)
          self.setData(Object.assign(base, {
            recognized: detail.recognized,
            modelCandidates: detail.modelCandidates,
            modelCandidateNote: detail.modelCandidateNote,
            manualSelection: detail.manualSelection,
            uncertaintyReasons: detail.uncertaintyReasons,
            sourceVersion: detail.sourceVersion,
            raw: null, corrected: null, verification: null, doseSafetyNote: ''
          }))
        })
      }
      return historyApi.getOcr(located.targetId).then(function (result) {
        const detail = historyApi.ocrDetailView(result.ocr)
        self.setData(Object.assign(base, {
          recognized: false, modelCandidates: [], manualSelection: null, uncertaintyReasons: [],
          sourceVersion: detail.sourceVersion,
          raw: detail.raw, corrected: detail.corrected, correctedDiffers: detail.correctedDiffers,
          verification: detail.verification, doseSafetyNote: detail.doseSafetyNote
        }))
      })
    }).catch(function (error) {
      // 目标详情读取失败（含已删除/不可用）如实说明；**不**用链接里的旧状态顶替。
      self.setData({
        busy: false,
        errorText: historyApi.messageFor(error),
        recognized: false,
        modelCandidates: [],
        manualSelection: null,
        raw: null, corrected: null, verification: null
      })
    })
  },

  onRefresh: function () {
    if (!this.data.gatePassed || this.data.networkOff) return
    this.load()
  },

  onDelete: function () {
    const self = this
    if (self.data.busy || !self.data.canDelete) return
    wx.showModal({
      title: '删除这条记录？',
      content: '将删除该识别记录，并触发关联的识别结果与媒体删除流程。删除后不可恢复。',
      confirmText: '删除',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return
        self.setData({ busy: true, message: '正在删除…' })
        historyApi.deleteHistory(self._query.id, self.data.historyRevision).then(function (result) {
          self.setData({ busy: false, message: '已删除记录。' + historyApi.cascadeNote(result.cascade) })
          // 删除后不再展示任何记录内容。
          self.setData({ invalid: true, invalidReason: '该记录已删除。', recognized: false, modelCandidates: [], manualSelection: null, raw: null, corrected: null, verification: null })
        }).catch(function (error) {
          self.setData({ busy: false, message: historyApi.messageFor(error) })
        })
      }
    })
  },

  // GY-I04 6-A：与 page-gate 同一登录口径（登记本页含记录 id 为返回目标 → reLaunch 登录页），
  // 登录成功后回到本页；门禁拦截语义不变（未登录仍被拦，按钮不放行任何数据）。
  onLogin: function () {
    auth.requireLogin(function () {})
  }
})
