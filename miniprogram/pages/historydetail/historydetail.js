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
    /** 最近一次读取失败的契约错误码（交给 `components/state-view` 的 errorCode 决定 401/403/404 语气）。 */
    errorCode: '',
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
    // 进入本页即作废上一条读取链：离开/重进后，旧响应不得再写回页面。
    self._epoch = (self._epoch || 0) + 1
    self.setData({ gatePassed: false, checking: true, message: '', errorText: '', errorCode: '', invalid: false, invalidReason: '' })
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

  onHide: function () { pageGate.cancel(this); this._epoch = (this._epoch || 0) + 1 },
  onUnload: function () { pageGate.cancel(this); this._epoch = (this._epoch || 0) + 1 },

  load: function () {
    const self = this
    const id = self._query.id
    // 每次读取有自己的世代：重复点「重新实时读取」或删除后重试时，旧请求后到的响应不得覆盖新结论
    // （旧响应可能还带着删除前的 succeeded／available 与可删除入口）。
    const epoch = (self._epoch = (self._epoch || 0) + 1)
    const alive = function () { return epoch === self._epoch }
    self.setData({ busy: true, errorText: '', errorCode: '', invalid: false })
    historyApi.locateHistory(id, historyApi.PAGE_LIMIT_MAX).then(function (located) {
      if (!alive()) return null
      if (!located) {
        // 实时未命中且没有快照 ⇒ 记录确实不可用；清空所有旧内容与动作入口（不猜 revision）。
        self.setData({
          busy: false, invalid: true,
          invalidReason: '该记录不存在、已删除、或不属于当前账号（服务端与"不存在"同形返回）。',
          kindLabel: '', locatedBy: '', stateKnown: false, stateLabel: '', stateDesc: '', stateTone: '',
          referenceAvailable: false, referenceLabel: '', createdAt: '', historyRevision: null, canDelete: false,
          recognized: false, modelCandidates: [], modelCandidateNote: '', manualSelection: null,
          uncertaintyReasons: [], sourceVersion: '', raw: null, corrected: null, correctedDiffers: false,
          verification: null, doseSafetyNote: ''
        })
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
          if (!alive()) return
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
        if (!alive()) return
        const detail = historyApi.ocrDetailView(result.ocr)
        self.setData(Object.assign(base, {
          recognized: false, modelCandidates: [], manualSelection: null, uncertaintyReasons: [],
          sourceVersion: detail.sourceVersion,
          raw: detail.raw, corrected: detail.corrected, correctedDiffers: detail.correctedDiffers,
          verification: detail.verification, doseSafetyNote: detail.doseSafetyNote
        }))
      })
    }).catch(function (error) {
      if (!alive()) return
      // 目标详情读取失败（含已删除/不可用）如实说明；**不**用链接里的旧状态顶替。
      // 错误码原样带出：401 仍是"登录失效"，403 是"没有权限"，404 是"记录不可用"。
      // 同时撤掉上一次成功读取留下的状态面板与删除入口：读不到就不得继续显示旧结论，
      // 也不得让用户对着一条无法核对版本的记录点「删除」。
      self.setData({
        busy: false,
        errorText: historyApi.messageFor(error),
        errorCode: (error && error.code) || '',
        stateKnown: false,
        stateLabel: '',
        stateDesc: '',
        stateTone: '',
        referenceAvailable: false,
        referenceLabel: '',
        historyRevision: null,
        canDelete: false,
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
          // 删除后不再展示任何记录内容（也不再给删除入口）；并作废本页带入的定位快照，
          // 否则再点「重新实时读取」时快照兜底会把刚删掉的记录重新当成"可定位"。
          historyApi.clearSelection()
          self.setData({
            invalid: true, invalidReason: '该记录已删除。', canDelete: false,
            stateKnown: false, stateLabel: '', stateDesc: '', stateTone: '',
            referenceAvailable: false, referenceLabel: '', historyRevision: null,
            recognized: false, modelCandidates: [], manualSelection: null, raw: null, corrected: null, verification: null
          })
        }).catch(function (error) {
          // 如实报错；服务端说记录已不存在（含他人记录，二者同形）时按"记录不可用"收口，不再展示内容。
          self.setData({ busy: false, message: historyApi.messageFor(error) })
          if ((error && error.code) === 'NOT_FOUND') {
            historyApi.clearSelection()
            self.setData({
              invalid: true, invalidReason: '该记录不存在、已删除、或不属于当前账号。', canDelete: false,
              stateKnown: false, stateLabel: '', stateDesc: '', stateTone: '',
              referenceAvailable: false, referenceLabel: '', historyRevision: null,
              recognized: false, modelCandidates: [], manualSelection: null, raw: null, corrected: null, verification: null
            })
          }
        })
      }
    })
  },

  // GY-I04 6-A：与 page-gate 同一登录口径（登记本页含记录 id 为返回目标 → reLaunch 登录页），
  // 登录成功后回到本页；门禁拦截语义不变（未登录仍被拦，按钮不放行任何数据）。
  // N1（对抗性审查 §4）：核实失败或在途时点按钮此前无可见反应。核实成功（ok）说明会话
  // 已获服务端确认 ⇒ 取消被本次核实取代的旧门禁周期，并按「重新进入本页」重跑门禁，
  // 让页面可见地放行；ok=false 时 requireLogin 已跳转登录页（可见）。两者都不放行数据。
  onLogin: function () {
    const self = this
    auth.requireLogin(function (ok) { if (ok) { pageGate.cancel(self); self.onShow() } })
  }
})
