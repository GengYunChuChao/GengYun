// GY-I13 **播报页**：语音球 + 等效播放控件 + 完整安全检查在前 + 离页取消/释放。
//
// 三段式（每一段都如实呈现，绝不跳过前一段）：
//   ① 安全检查：`utils/speech-text.js` 的 `assertSpeakable`（只有 `check_state === 'passed'`
//      才放行）。**未通过 ⇒ 不发起任何合成请求、不创建播放器**（可复核：请求数为 0）；
//   ② 合成：`POST /speech/synthesis`（带 `Idempotency-Key`）→ 轮询 `GET /jobs/{id}` 到终态，
//      七类 `JobState` 与 `error_code` 逐类如实显示，不折叠成"成功/失败"。
//      目标引用（type/id/revision）**取契约值**：经 `voiceApi.checkedContentRefForSample()`，
//      并**优先**采用服务端回传的 revision（`rememberServerRevision`）；页面**不内联** `revision: 1`。
//   ③ 播放：只有"任务成功 **且** 有可播放的音频源"才自动播放；**契约里没有面向客户端的音频出口**
//      （见 `voiceApi.NO_CLIENT_AUDIO_EGRESS_NOTE`）⇒ 取不到可播放来源 ⇒ **自动播放失败**：
//      页面如实写「本环境无可播放音频（契约无客户端音频出口）」+ 文案 + 主动播放按钮，
//      **不显示「播放中／已播放」**、**不伪造音频**、**不记「已听取」**。
//
// 离页口径（返回 / 切页 / 隐藏三条路径共用同一个出口）：
//   取消本机在途请求与轮询 + `controller.release()`（退订全部监听、销毁音频句柄）；
//   合成任务**没有服务端取消能力**，因此**不谎称**服务端任务已取消（文案见
//   `utils/voice-api.js` 的 `EXIT_CANCELLATION_NOTE`）。
//
// 替身边界（本地替身工程专用，**默认关闭**）：本页在 `debug.localEnabled` 为真时才提供
// **明确标注的替身样本**与**替身播放端口**走查开关；替身走查默认**关**（否则会出现
// "没有可播放来源 + 正在播报"的自相矛盾状态 ✗），由本地替身工程显式开启；
// 替身播放不产生任何声音、**不计入「已听取」**、也不冒充真实音频。
const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const speechText = require('../../utils/speech-text')
const audioPlayback = require('../../utils/audio-playback')
const innerAudioPort = require('../../utils/inner-audio-port')
const substitutePlayer = require('../../utils/substitute-player')
const voiceApi = require('../../utils/voice-api')
const recorderPort = require('../../utils/recorder-port')
const identifyApi = require('../../utils/identify-api')

const POLL_INTERVAL_MS = 1000
const POLL_MAX_TICKS = 30
const SUBSTITUTE_SOURCE_PREFIX = 'substitute://segment/'
/** 已录时长展示的刷新间隔（契约时长以秒为量级，100ms 足够且不造成无意义渲染）。 */
const RECORD_TICK_MS = 100

/** 录音授权被拒时，页内不做任何"重试弹窗"谎术：如实指向微信设置页由用户自己决定。 */
const RECORD_PERMISSION_HINT = '未获得麦克风授权时，本页不会开始录音、不会采集、不会上传任何音频。'
  + '可在微信「设置 → 授权管理 → 录音」中开启后返回本页重试。'

const RECORD_NOTE = '录音走小程序原生能力（wx.getRecorderManager）：需要麦克风授权，拒绝即如实提示，不假装在录。'
  + '录到的音频按契约用途 voice_question 走既有私有媒体上传通道，并带真实时长 duration_ms。'
  + '录音控件与播报控件是两个独立控件，互不复用；播报的内容一律来自服务端已核对正文。'

/** 上传落定前的**如实**说明：契约允许的用途与限额，逐项与 packages/media 实读一致。 */
const VOICE_LIMIT_NOTE = '用途 voice_question：仅 MP3 / WAV / AAC，单次 ≤60 秒、≤10 MiB；'
  + '录音上传只走既有私有媒体通道，本页不新增用途、不新增字段。'

/**
 * 「在途上传被作废」的原因措辞（`releaseAll` 的 reason ⇒ 用户可读的一句）。
 *
 * 只用于**如实说明**在途上传为何没有结果；不改变任何判定，也不谎称服务端任务被取消。
 */
const LEAVE_REASON_TEXT = Object.freeze({
  hide: '已离开本页',
  unload: '已离开本页',
  gate: '会话／门禁已失效'
})

Page({
  onLoad: function () {
    fontScale.applyFontScale(this)
    this._generation = 0
    this._controller = null
    this._plan = []
    this._substituteSegments = []
    this._failFirst = null
    this._recorder = null
    this._recPending = false
    this._recStartedAt = 0
    this._recTimer = null
    this._recTick = 0
    this._uploadEpoch = 0
    /** 页面已卸载：此后**任何**入口都不得再重新打开麦克风。 */
    this._gone = false
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    this.setData({ fontScale: fontScale.currentFontScale() })
    const that = this
    pageGate.start(this, function (ok) {
      const loggedIn = ok === true && auth.isLoggedIn()
      const localEnabled = loggedIn ? voiceApi.substituteSamplesEnabled() : false
      // 能力自述只读平台是否提供录音能力（**不**触发任何授权弹窗、不开始录音）。
      const support = recorderPort.support()
      that.setData({
        guest: loggedIn !== true,
        localEnabled: localEnabled,
        samples: localEnabled ? voiceApi.SUBSTITUTE_SPEAK_SAMPLES : [],
        substituteNote: localEnabled ? voiceApi.SUBSTITUTE_NOTE : '',
        recordSupported: support.ok === true,
        recordSupportNote: support.note,
        recordMaxMs: support.maxDurationMs
      })
      if (loggedIn !== true) that.closePrivate()
    })
  },

  // 返回 / 切页 / 隐藏：三条路径都走同一个释放出口。
  //
  // ⚠️ 顺序有意为之（OBS-1）：**先**按"离页"释放录音，**再**让门禁出口收尾其余私有展示。
  // 原因是 `pageGate.cancel()` 会调 `page._gateClose()` ⇒ `callback(false)` ⇒ `closePrivate()`
  // ⇒ `releaseAll('gate')`；若让门禁先跑，作废说明就会写成"会话／门禁已失效"（而用户其实是**主动离页**，
  // 这么写会被读成"掉登录"）。先跑离页出口 ⇒ 用户看到的原因与他的实际动作一致；
  // 其后门禁/`releaseAll` 的重复调用都是幂等空转（状态已复位，`inFlight` 判据为假）。
  onHide: function () {
    this.releaseRecorder('hide')
    pageGate.cancel(this)
    this.releaseAll('hide')
  },
  onUnload: function () {
    // 卸载后本页不会再有 `onShow`：标记为"已消失"，杜绝任何入口在卸载后重新打开麦克风。
    this._gone = true
    this.releaseRecorder('unload')
    pageGate.cancel(this)
    this.releaseAll('unload')
  },

  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    guest: true,
    localEnabled: false,
    samples: [],
    substituteNote: '',
    selectedSampleId: '',
    // ① 安全检查
    checkState: '',
    checkPassed: false,
    checkMessage: '',
    checkedText: '',
    segmentCount: 0,
    segmentPreview: '',
    // ② 合成
    stage: 'check',
    busy: false,
    mode: '',
    job: null,
    synthesisNote: '',
    // ③ 播放
    playbackState: 'idle',
    listened: false,
    substitute: false,
    substituteCompleted: false,
    failure: null,
    ballLabel: '播报已核对内容',
    ballHint: '',
    /**
     * 来源的**如实**口径（取不到可播放来源时非空；见 `voiceApi.NO_CLIENT_AUDIO_EGRESS_NOTE`）。
     * 与「播放中」互斥：取不到来源时页面只会显示失败态 + 本提示，不会显示「正在播报」。
     */
    sourceNotice: '',
    /**
     * 本地替身工程的**显式**走查开关：**默认关闭**。
     *
     * 默认关闭是本片刻意选择的：契约取不到可播放来源，若默认开启替身走查，页面会在
     * 「没有可播放的音频源」的同时显示「正在播报」，等于给出假播放状态 ✗。
     * 关掉（默认）时页面如实走失败出口 + 来源提示；需要走查控件生命周期时，
     * 由本地替身工程**显式**开启（非真实音频、不产生任何声音、不计「已听取」）。
     */
    substituteWalkthrough: false,
    failureProbe: '',
    probing: false,
    // 录音控件（独立）：默认**不录音**，各态逐态可分辨（idle/recording/stopped/uploading/failed）
    recordState: 'idle',
    recordLabel: '开始录音',
    recording: false,
    /** 是否已有可用的本机录音产物（**只**在平台真实回调给出文件后为真，不预先为真）。 */
    hasRecording: false,
    recordStageNote: '',
    recordElapsedMs: 0,
    recordDurationMs: 0,
    recordMaxMs: voiceApi.RECORD_MAX_DURATION_MS,
    recordedMime: '',
    uploadedMediaId: null,
    uploadedPurpose: '',
    uploadErrorCode: '',
    recordSupported: false,
    recordSupportNote: '',
    recordPermissionNote: RECORD_PERMISSION_HINT,
    recordNote: RECORD_NOTE,
    voiceLimitNote: VOICE_LIMIT_NOTE,
    exitNote: voiceApi.EXIT_CANCELLATION_NOTE,
    exitReason: ''
  },

  // ---------------------------------------------------------------- 操作代次

  beginOperation: function () {
    this._generation = (this._generation || 0) + 1
    return this._generation
  },

  isCurrent: function (generation) {
    return this._generation === generation && this.data.guest !== true
  },

  /** 关闭私有展示（未登录/门禁失效/离页）：停轮询、作废在途请求、释放播放器与录音。 */
  closePrivate: function () {
    this.releaseAll('gate')
    this.beginOperation()
    this.setData({
      selectedSampleId: '', checkState: '', checkPassed: false, checkMessage: '',
      checkedText: '', segmentCount: 0, segmentPreview: '',
      stage: 'check', busy: false, mode: '', job: null, synthesisNote: '', sourceNotice: ''
    })
  },

  /**
   * 统一的释放出口：停轮询 → 作废在途请求 → **停止录音并释放麦克风** → 释放控制器（退订 + 销毁句柄）。
   * 幂等；`release()` 之后迟到的播放/录音回调一律失效（后台残留的负例判据）。
   */
  releaseAll: function (reason) {
    this.stopPoll()
    voiceApi.cancelAll()
    this.beginOperation()
    this._plan = []
    // 录音：离页必须**停止并释放**，不留挂起状态（也不留下会继续计时的定时器）。
    this.releaseRecorder(reason)
    if (this._controller !== null) {
      this._controller.release()
      this._controller = null
    }
    this.setData({
      playbackState: 'idle', listened: false, substituteCompleted: false, failure: null,
      sourceNotice: '', busy: false, exitReason: typeof reason === 'string' ? reason : ''
    })
  },

  /** 停止已录计时并清空录音器引用（不触发任何 UI 承诺）。 */
  clearRecTimer: function () {
    if (this._recTimer) { clearInterval(this._recTimer); this._recTimer = null }
    this._recStartedAt = 0
    this._recTick = 0
  },

  /**
   * 释放录音端口：停止录音 → 作废在途上传 → 清掉计时器 → **把录音控件无条件复位到默认**。
   *
   * 三条离页路径（返回 / 切页 / 隐藏）、门禁失效、`onUnload` 共用本出口。
   *
   * ⚠️ 复位**必须无条件**（与 `releaseAll` 对 `playbackState` 的写法对称）：
   * 在途上传已被 `_uploadEpoch` 作废 ⇒ 它**永远不会**再落定，若此时只复位"录音中"而不复位"上传中"，
   * 页面就会永久停在 `recordState='uploading'`、录音按钮被 WXML 的 `disabled` 表达式永久禁用
   * —— 那正是"离页/取消不得留挂起状态"被违反的形态。所以在途（录音中或上传中）一律复位，
   * 并**如实**说明"本次上传已作废"，而不是留一句"上传中"。
   *
   * 幂等：端口为 null 时只清计时器与在途上传代次。
   */
  releaseRecorder: function (reason) {
    this.clearRecTimer()
    // 作废在途上传：迟到的响应不再落 UI（服务端任务本就没有客户端取消能力，不谎称已取消）。
    this._uploadEpoch = (this._uploadEpoch || 0) + 1
    this._recPending = false
    if (this._recorder !== null) {
      this._recorder.release()
      this._recorder = null
    }
    const wasUploading = this.data.recordState === 'uploading'
    const inFlight = this.data.recording === true || this.data.recordState === 'recording' || wasUploading
    if (inFlight !== true) return
    const patch = {
      recording: false, recordState: 'idle', recordLabel: '开始录音',
      recordElapsedMs: 0, recordDurationMs: 0, recordedMime: '', hasRecording: false,
      uploadedMediaId: null, uploadedPurpose: '', uploadErrorCode: ''
    }
    if (wasUploading) {
      // 上传中被作废：如实说明"没有上传成功、也没有 media_id"，并明确"可以重新录音"（不得留挂起态）。
      patch.recordStageNote = '本次上传已作废（' + (LEAVE_REASON_TEXT[reason] || LEAVE_REASON_TEXT.hide)
        + '）：没有上传成功、也没有 media_id；可以重新录音。'
    } else {
      patch.recordStageNote = '已离开本页：录音已停止并释放麦克风。'
    }
    this.setData(patch)
  },

  /** 惰性建端口（与 `ensureController` 同一写法；端口不可用时如实返回 null）。 */
  ensureRecorder: function () {
    if (this._recorder !== null && this._recorder.available === true) return this._recorder
    const port = recorderPort.createRecorderPort()
    if (port.available !== true) return null
    this._recorder = port
    return port
  },

  /** 已录时长（优先用端口真实计时；离页/未录音时为 0）。 */
  elapsedRecordMs: function () {
    if (this._recStartedAt < 1) return 0
    const elapsed = Date.now() - this._recStartedAt
    return Math.max(0, Math.min(Math.round(elapsed), voiceApi.RECORD_MAX_DURATION_MS))
  },

  // ---------------------------------------------------------------- ① 安全检查

  onSelectSample: function (event) {
    if (this.data.guest || this.data.samples.length === 0) return
    const sampleId = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.id : null
    const sample = this.data.samples.filter(function (item) { return item.id === sampleId })[0]
    if (!sample) return
    this.stopPoll()
    voiceApi.cancelAll()
    this.beginOperation()
    if (this._controller !== null) { this._controller.release(); this._controller = null }
    this._plan = []
    this._substituteSegments = []

    // 安全检查闸门：`checkState` 不是契约闭集里的 `passed` ⇒ 一律阻断。
    const gate = speechText.assertSpeakable({
      checkState: sample.checkState,
      text: sample.checkedText,
      checkedText: sample.checkedText
    })
    const segments = gate.ok === true ? gate.segments : []
    this.setData({
      selectedSampleId: sample.id,
      checkState: sample.checkState,
      checkPassed: gate.ok === true,
      checkMessage: gate.ok === true
        ? '安全检查已通过（check_state=passed）：已核对正文与播报计划逐字一致，关键令牌（数字/单位/制剂条件/否定词）齐全。'
        : speechText.gateMessage(gate) + '（' + String(gate.code) + '）',
      checkedText: sample.checkedText,
      segmentCount: segments.length,
      segmentPreview: segments.length > 1 ? ('第 1 段：' + segments[0]) : '',
      stage: 'check',
      busy: false,
      mode: '',
      job: null,
      synthesisNote: '',
      // 换样本 ⇒ 上一份来源口径作废（不得把上一条的提示留在新样本上）。
      sourceNotice: '',
      playbackState: 'idle',
      listened: false,
      substituteCompleted: false,
      failure: null
    })
  },

  // ---------------------------------------------------------------- ② 合成

  /** 提交（安全检查通过后才允许发起合成；未通过时**零请求**）。 */
  onBroadcast: async function () {
    if (this.data.guest || this.data.busy || this.data.selectedSampleId === '') return
    if (this.data.checkPassed !== true) {
      this.setData({ synthesisNote: '安全检查未通过：未发起任何合成请求，也不会播报。' })
      return
    }
    const selectedId = this.data.selectedSampleId
    const sample = this.data.samples.filter(function (item) { return item.id === selectedId })[0]
    if (!sample) return
    // 目标引用一律**取契约值**（服务端回传的 revision 优先），页面**不得**内联拼 `revision: 1`。
    const ref = voiceApi.checkedContentRefForSample(sample)
    if (ref === null) {
      // 样本没有声明契约目标引用 ⇒ 不发明内容来源、不发起任何请求（如实说明）。
      this.setData({
        busy: false,
        stage: 'synthesis',
        synthesisNote: '该样本没有声明契约目标引用（type/id/revision）：为不发明内容来源，本次未发起任何合成请求。'
      })
      return
    }
    const generation = this.beginOperation()
    this.setData({ busy: true, stage: 'synthesis', synthesisNote: '', job: null, failure: null, listened: false, substituteCompleted: false, playbackState: 'idle' })
    try {
      const created = await voiceApi.createSynthesis(ref)
      if (!this.isCurrent(generation)) return
      // 采纳**服务端回传的** revision（受理响应里的 `target_ref`）。
      voiceApi.rememberServerRevision(created.job)
      this.setData({ mode: created.mode, job: describe(created.job), busy: !voiceApi.isTerminal(created.job.state) })
      if (voiceApi.isTerminal(created.job.state)) { this.afterSynthesis(created.job, created.mode, generation); return }
      this.startPoll(created.job.id, created.mode, generation)
    } catch (error) {
      if (!this.isCurrent(generation)) return
      if (isGateLoss(error)) { this.closePrivate(); return }
      this.setData({ busy: false, stage: 'synthesis', synthesisNote: voiceApi.messageFor(error) + '（' + String(error && error.code) + '）' })
      // 合成本身就失败了 ⇒ 没有任何产物可播：如实走"自动播放失败"出口（不记已听取）。
      this.afterSynthesis(null, '', generation, error)
    }
  },

  startPoll: function (jobId, mode, generation) {
    const that = this
    this.stopPoll()
    let ticks = 0
    this._pollTimer = setInterval(function () {
      ticks += 1
      if (!that.isCurrent(generation)) { that.stopPoll(); return }
      if (ticks > POLL_MAX_TICKS) {
        that.stopPoll()
        that.setData({ busy: false, synthesisNote: '轮询已达上限，请重新提交后再查看任务状态。' })
        return
      }
      that.refreshJob(jobId, mode, generation)
    }, POLL_INTERVAL_MS)
  },

  stopPoll: function () {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null }
  },

  refreshJob: async function (jobId, mode, generation) {
    try {
      const read = await voiceApi.getJob(jobId)
      if (!this.isCurrent(generation)) return
      if (!this.data.job || this.data.job.id !== jobId) return
      // 读面同样回传 `target_ref`：一并采纳服务端 revision（重复记同值不改变任何行为）。
      voiceApi.rememberServerRevision(read.job)
      this.setData({ mode: read.mode, job: describe(read.job), busy: !voiceApi.isTerminal(read.job.state) })
      if (voiceApi.isTerminal(read.job.state)) { this.stopPoll(); this.afterSynthesis(read.job, read.mode, generation) }
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.stopPoll()
      if (isGateLoss(error)) { this.closePrivate(); return }
      this.setData({ busy: false, synthesisNote: voiceApi.messageFor(error) + '（' + String(error && error.code) + '）' })
    }
  },

  // ---------------------------------------------------------------- ③ 播放

  /**
   * 合成落定后进入播放段：先判可播源，再决定自动播报或如实走失败出口。
   *
   * 可播源在契约层面取不到（见 `voiceApi.audioSourceForJob` / `NO_CLIENT_AUDIO_EGRESS_NOTE`）：
   * 页面如实呈现该口径，**不显示「播放中／已播放」**、不伪造音频、不记「已听取」。
   * 唯一的例外是**本地替身工程的显式走查开关**（非真实音频、不产生声音、不计已听取）。
   */
  afterSynthesis: function (job, mode, generation, synthesisError) {
    if (!this.isCurrent(generation)) return
    this.stopPoll()
    const source = job === null
      ? { ok: false, code: 'SOURCE_UNAVAILABLE', reason: synthesisError ? '合成未成功：没有可播放的产物。' : '没有可播放的产物。' }
      : voiceApi.audioSourceForJob(job, mode)
    const segments = this.substituteSegmentsFor(job, source)
    this._plan = segments
    this.setData({
      stage: 'playback',
      busy: false,
      ballLabel: '播报已核对内容',
      ballHint: segments.length > 1 ? (segments.length + ' 段（按句分段，逐段播报）') : '',
      playbackState: 'idle',
      listened: false,
      substituteCompleted: false,
      failure: null
    })
    // 无论是否替身走查，都先如实写下**来源**口径（有真实源时才清空）。
    this.applyModeNotice(source)
    if (segments.length === 0) {
      // 自动播放失败：**文案 + 主动播放按钮**，并且不记「已听取」。
      this.ensureController().play([], { auto: true })
      return
    }
    this.ensureController().play(segments, { auto: true })
  },

  /**
   * 可播放源解析。
   * - 真实源可用（`audioSourceForJob` 给出 src）⇒ 用真实源（本片恒不可用，见该函数注释）；
   * - 否则：本地替身工程 + 走查开关打开 ⇒ 用**明确标注的替身源**（非真实音频、不计已听取）；
   * - 否则 ⇒ 空计划（如实走"自动播放失败"出口）。
   */
  substituteSegmentsFor: function (job, source) {
    if (source.ok === true) return [{ src: source.src, label: '真实音频' }]
    if (this.data.localEnabled !== true || this.data.substituteWalkthrough !== true) {
      this._substituteSegments = []
      return []
    }
    const text = this.data.checkedText
    const parts = speechText.splitForSpeech(text)
    this._substituteSegments = parts
    if (parts.length === 0) return []
    this.setData({ substitute: true })
    return parts.map(function (part, index) {
      return { src: SUBSTITUTE_SOURCE_PREFIX + index, label: '替身段 ' + (index + 1) }
    })
  },

  /**
   * 来源口径的**如实**呈现（无论走查开不开都要写）。
   *
   * - 有真实可播源 ⇒ 清空来源提示（本片恒不可用，见 `voiceApi.audioSourceForJob`）；
   * - 取不到 ⇒ 写 `NO_CLIENT_AUDIO_EGRESS_NOTE` + 该分支的具体原因（契约缺口，不是网络问题），
   *   并保留既有「没有可播放的音频源：…」一句；页面**不得**因此显示「播放中／已播放」。
   */
  applyModeNotice: function (source) {
    if (source.ok === true) {
      this.setData({ sourceNotice: '' })
      return
    }
    this.setData({
      sourceNotice: voiceApi.NO_CLIENT_AUDIO_EGRESS_NOTE + '（具体原因：' + String(source.reason) + '）',
      synthesisNote: this.data.synthesisNote === ''
        ? ('没有可播放的音频源：' + String(source.reason))
        : this.data.synthesisNote
    })
  },

  playerPort: function () {
    if (this.data.localEnabled === true && this.data.substituteWalkthrough === true) {
      return substitutePlayer.createSubstitutePlayerPort({ failFirst: this._failFirst })
    }
    return innerAudioPort.createInnerAudioPort()
  },

  ensureController: function () {
    if (this._controller !== null && this._controller.isReleased() !== true) return this._controller
    const that = this
    this._controller = audioPlayback.createPlaybackController({
      player: this.playerPort(),
      onStateChange: function (snapshot) { that.applySnapshot(snapshot) },
      onListened: function (snapshot) { that.applySnapshot(snapshot) },
      onFailure: function (failure, snapshot) {
        that.applySnapshot(snapshot)
        that.setData({ failure: { title: failure.title, hint: failure.hint, actionText: failure.actionText, code: failure.code } })
      }
    })
    return this._controller
  },

  applySnapshot: function (snapshot) {
    this.setData({
      playbackState: snapshot.state,
      listened: snapshot.listened === true,
      substitute: snapshot.substitute === true,
      substituteCompleted: snapshot.substituteCompleted === true,
      ballHint: snapshot.total > 1
        ? ('第 ' + Math.min(snapshot.index + 1, snapshot.total) + ' / ' + snapshot.total + ' 段')
        : this.data.ballHint
    })
  },

  onPlay: function () {
    if (this.data.guest) return
    const controller = this.ensureController()
    const result = this._plan.length === 0 ? controller.play([], { auto: false }) : controller.play(this._plan, { auto: false })
    if (result && result.ok !== true && result.code === 'ALREADY_PLAYING') return
  },

  onPause: function () { if (this._controller !== null) this._controller.pause() },
  onStop: function () { if (this._controller !== null) this._controller.stop() },
  onReplay: function () { if (this._controller !== null) this._controller.replay() },

  // ---------------------------------------------------------------- 本地走查开关（仅替身工程）

  onToggleWalkthrough: function () {
    if (this.data.localEnabled !== true) return
    const next = this.data.substituteWalkthrough !== true
    if (next === false) {
      // 关掉替身播放 ⇒ 立刻释放，避免"看起来在播"。
      if (this._controller !== null) { this._controller.release(); this._controller = null }
      this._plan = []
    }
    this.setData({ substituteWalkthrough: next, substitute: false, playbackState: 'idle', listened: false, substituteCompleted: false, failure: null, ballHint: '' })
  },

  onPickFailureProbe: function (event) {
    if (this.data.localEnabled !== true) return
    const code = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.code : ''
    this._failFirst = typeof code === 'string' && code !== '' ? code : null
    if (this._controller !== null) { this._controller.release(); this._controller = null }
    this.setData({ failureProbe: this._failFirst || '', probing: this._failFirst !== null, failure: null, playbackState: 'idle', listened: false })
  },

  // ---------------------------------------------------------------- 录音控件（独立、真实录音 + 按用途上传）

  /**
   * 录音入口（独立按钮）：未录 ⇒ 开始录音；录音中 ⇒ 停止并走上传。
   *
   * **真调用原生能力**：经 `utils/recorder-port.js` 的注入端口调用 `wx.getRecorderManager()`
   * 的 `start`/`stop`（端口是本仓唯一引用平台录音 API 的地方）。页面自己**不**切文案假装录音：
   * 只有端口真的开始（`ok:true`）才进入 `recording` 态；授权被拒/失败/中断一律如实呈现。
   */
  onRecord: async function () {
    if (this.data.guest || this._gone === true) return
    if (this.data.recording === true) { await this.stopAndUpload(); return }
    await this.startRecording()
  },

  /**
   * 开始录音：先看能力，再按平台真实返回归因（拒绝授权 ⇒ 不开始、不假装在录）。
   *
   * 端口对**所有**失败都 resolve 成 `{ ok:false, code, errMsg }`（不 reject），因此这里
   * 只有一个归因出口：不存在"某条失败路径忘了提示"的可能。异常兜底只为防端口自身崩坏。
   */
  startRecording: async function () {
    if (this.data.guest || this._gone === true) return
    const port = this.ensureRecorder()
    if (port === null) {
      this.setData({
        recording: false, recordState: 'failed', recordLabel: '开始录音',
        recordStageNote: voiceApi.recordUploadMessageFor({ code: 'RECORDER_UNAVAILABLE' }),
        uploadErrorCode: 'RECORDER_UNAVAILABLE', uploadedMediaId: null, uploadedPurpose: ''
      })
      return
    }
    const epoch = this.beginOperation()
    this.setData({
      recordState: 'recording', recordLabel: '正在录音…', recording: true,
      recordStageNote: '正在录音（麦克风已打开）。再次点击即停止并上传。',
      recordElapsedMs: 0, recordDurationMs: 0, recordedMime: '',
      uploadedMediaId: null, uploadedPurpose: '', uploadErrorCode: ''
    })

    let started
    try {
      started = await port.start({ format: 'aac' })
    } catch (error) {
      started = { ok: false, code: error && error.code ? error.code : 'RECORD_FAILED', errMsg: error && error.message }
    }
    if (!this.isCurrent(epoch)) return
    if (started.ok !== true) {
      // 授权被拒 / 能力失败 / 被中断：**没有任何音频被采集**，如实说明并回到未录音态。
      this.setData({
        recording: false, recordState: 'failed', recordLabel: '开始录音',
        recordElapsedMs: 0,
        recordStageNote: voiceApi.recordUploadMessageFor({ code: started.code }),
        uploadErrorCode: typeof started.code === 'string' ? started.code : 'RECORD_FAILED',
        uploadedMediaId: null, uploadedPurpose: ''
      })
      return
    }

    // 已录计时：本地只用于**显示**，契约时长一律取平台 `onStop` 的真实 duration。
    this._recStartedAt = Date.now()
    this._recTick = 0
    const that = this
    this._recTimer = setInterval(function () {
      that._recTick = (that._recTick || 0) + 1
      that.setData({ recordElapsedMs: that.elapsedRecordMs() })
      // 到达契约上限：主动停（平台也会自动停，这里收在同一出口，避免状态分叉）。
      if (that._recTick * RECORD_TICK_MS >= voiceApi.RECORD_MAX_DURATION_MS) that.stopAndUpload()
    }, RECORD_TICK_MS)
  },

  /**
   * 停止录音并上传：产物 → `wx.getFileInfo` 取真实字节数/sha256 → 按用途 `voice_question` 上传。
   *
   * 时长 `duration_ms` 只取**平台 `onStop` 的真实 duration**（不取本地计时），
   * 与 `duration_ms.maximum = 60000` 一并作为上传前预检。
   *
   * ⚠️ **在整个异步窗口内都必须复查在途资格**（F1-R2）：拿到产物之后立刻锁定
   * `epoch`（上传代次）与 `generation`（页面操作世代），此后**每一次**异步落点
   * （`readFileInfo` 的兑现/失败、`serverMode`、上传落定）之前都要用同一对值复查。
   * 否则离页/门禁失效恰好落在"已拿到产物、读摘要在途"这段窗口时，续跑会在复位**之后**
   * 再次把状态写成「上传中」（按钮永久禁用、文案谎称正在上传）或**把已被宣告作废的上传真的做完**
   * —— 同一路径两种互相矛盾的结果，且都由门禁时序而非"作废代次"决定。
   */
  stopAndUpload: async function () {
    if (this.data.guest || this._gone === true) return
    if (this.data.recording !== true || this._recPending === true) return
    const port = this._recorder
    if (port === null) return
    this._recPending = true
    this.clearRecTimer()
    this.setData({ recording: false, recordState: 'uploading', recordLabel: '正在处理录音…', recordStageNote: '正在停止录音并读取文件摘要…' })

    let result
    try {
      result = await port.stop()
    } catch (error) {
      result = { ok: false, code: error && error.code ? error.code : 'RECORD_FAILED' }
    }
    if (result.ok !== true) {
      if (this.uploadStillValid(this._generation, this._uploadEpoch || 0) !== true) return
      this._recPending = false
      this.setData({
        recordState: 'failed', recordLabel: '重新录音', recordStageNote: voiceApi.recordUploadMessageFor({ code: result.code }),
        uploadErrorCode: typeof result.code === 'string' ? result.code : 'RECORD_FAILED',
        uploadedMediaId: null, uploadedPurpose: ''
      })
      return
    }

    // 拿到产物 ⇒ **立刻**锁定本次上传的世代（此后所有异步落点都用这一对值复查）。
    const epoch = this._uploadEpoch || 0
    const generation = this.beginOperation()
    if (this.uploadStillValid(generation, epoch) !== true) return

    this.setData({
      recordDurationMs: result.durationMs,
      recordElapsedMs: result.durationMs,
      recordedMime: result.mime,
      hasRecording: true,
      recordStageNote: '录音完成（' + (result.durationMs / 1000).toFixed(1) + ' 秒 · ' + result.format + ' → ' + result.mime + '），正在读取文件摘要…'
    })

    // 上传前的**契约限额预检**：超限直接给可操作提示，**不发出** POST /media/uploads（服务端必拒）。
    if (result.durationMs > voiceApi.RECORD_MAX_DURATION_MS) {
      this._recPending = false
      this.setData({
        recordState: 'failed', recordLabel: '重新录音', uploadErrorCode: 'INVALID_INPUT',
        recordStageNote: '录音时长 ' + (result.durationMs / 1000).toFixed(1) + ' 秒，超过契约上限 '
          + (voiceApi.RECORD_MAX_DURATION_MS / 1000) + ' 秒：本条未上传任何音频，请重新录制。',
        uploadedMediaId: null, uploadedPurpose: ''
      })
      return
    }

    let info
    try {
      info = await readFileInfo(result.tempFilePath)
    } catch (error) {
      // 窗口内页面可能已被作废：作废就**不改 UI**（保留已写好的如实作废说明），也不谎称失败原因。
      if (this.uploadStillValid(generation, epoch) !== true) return
      this._recPending = false
      this.setData({
        recordState: 'failed', recordLabel: '重新录音', uploadErrorCode: 'MEDIA_CHANNEL_UNAVAILABLE',
        recordStageNote: '无法读取录音文件摘要：本条未上传任何音频（不伪造上传结果）。',
        uploadedMediaId: null, uploadedPurpose: ''
      })
      return
    }
    // **F1-R2 关键复查**：`readFileInfo` 是异步的 —— 离页/门禁失效/代次变化都必须在此收手。
    if (this.uploadStillValid(generation, epoch) !== true) return
    if (info.size > voiceApi.VOICE_MAX_BYTES) {
      this._recPending = false
      this.setData({
        recordState: 'failed', recordLabel: '重新录音', uploadErrorCode: 'MEDIA_TOO_LARGE',
        recordStageNote: '录音文件 ' + (info.size / 1048576).toFixed(1) + ' MiB，超过用途上限 '
          + (voiceApi.VOICE_MAX_BYTES / 1048576) + ' MiB：本条未上传任何音频，请缩短录制后重试。',
        uploadedMediaId: null, uploadedPurpose: ''
      })
      return
    }

    await this.uploadRecording(port, result, info, generation, epoch)
  },

  /**
   * 本次在途上传是否仍然有效（代次 + 门禁 + 页面世代）。
   *
   * `generation`/`epoch` 必须由调用方在**拿到产物时**捕获；若在异步窗口之后再捕获，
   * 离页已经把 `_uploadEpoch` 递增过 ⇒ 判据会恒等成立而**完全失效**（F1-R2 的根因之一）。
   */
  uploadStillValid: function (generation, epoch) {
    return this.isCurrent(generation) === true && (this._uploadEpoch || 0) === epoch
  },

  /**
   * 上传录音产物：用途 `voice_question`（契约既有成员）+ 真实 `duration_ms`。
   *
   * `generation`/`epoch` 由 `stopAndUpload` 在拿到产物时捕获并传入。
   * ⚠️ **守卫先于任何 UI 写入**：先复查再 `setData({recordState:'uploading'})`，
   * 否则离页复位之后又会被重新写成「上传中」，而该续跑随后静默 return ⇒ 无人再复位（F1-R2）。
   */
  uploadRecording: async function (port, result, info, generation, epoch) {
    if (this.uploadStillValid(generation, epoch) !== true) return
    this.setData({
      recordState: 'uploading', recordLabel: '正在上传…',
      recordStageNote: '按用途 voice_question 上传（' + (result.durationMs / 1000).toFixed(1) + ' 秒 · '
        + (info.size / 1024).toFixed(0) + ' KiB · ' + result.mime + '）…'
    })

    // 先如实读出服务端执行模式：stub / preset_demo 下没有真实媒体存储，**不得**让用户以为已送达。
    let mode = null
    try {
      mode = await identifyApi.serverMode()
    } catch (error) {
      mode = null
    }
    if (this.uploadStillValid(generation, epoch) !== true) return

    // 非 real 模式：不上传，明确标注为「待接线」（本页不伪造 media_id）。
    if (mode !== null && mode !== 'real') {
      this._recPending = false
      this.setData({
        recordState: 'stopped', recordLabel: '重新录音',
        recordStageNote: '执行模式 ' + mode + '（真实对象存储未接线）：录音已在本机完成，但本条没有上传，也没有 media_id。',
        uploadErrorCode: '', uploadedMediaId: null, uploadedPurpose: ''
      })
      return
    }

    try {
      const media = await identifyApi.uploadVoiceQuestion(result.tempFilePath, {
        mime: result.mime, bytes: info.size, sha256: info.digest, durationMs: result.durationMs
      })
      if (this.uploadStillValid(generation, epoch) !== true) return
      this._recPending = false
      this.setData({
        recordState: 'stopped', recordLabel: '重新录音', uploadErrorCode: '',
        uploadedMediaId: media.mediaId,
        uploadedPurpose: identifyApi.VOICE_MEDIA_PURPOSE,
        recordStageNote: '录音已按用途 voice_question 上传完成（media_id ' + media.mediaId
          + '，时长 ' + result.durationMs + ' ms）。本页只做到「已上传」：转写与问答结果不在本页，'
          + '也不显示任何「已回答」一类结论。'
      })
    } catch (error) {
      // 守卫先于任何状态写入：已作废的在途上传**不得**再改 UI（也不得谎称失败原因）。
      if (this.uploadStillValid(generation, epoch) !== true) return
      this._recPending = false
      if (isGateLoss(error)) { this.closePrivate(); return }
      this.setData({
        recordState: 'failed', recordLabel: '重新录音',
        uploadErrorCode: typeof error.code === 'string' ? error.code : 'UNAVAILABLE',
        uploadedMediaId: null, uploadedPurpose: '',
        recordStageNote: voiceApi.recordUploadMessageFor(error) + '（' + String(error && error.code) + '）'
      })
    }
  }
})

/** 把契约 `Job` 投影成页面用的最小视图（不推断、不美化）。 */
function describe(job) {
  const view = voiceApi.describeJob(job)
  return {
    id: job.id,
    revision: job.revision,
    state: view.state,
    terminal: view.terminal,
    label: view.label,
    errorCode: view.errorCode,
    mediaId: job.result === null ? null : job.result.media_id
  }
}

/** 会话/门禁失效类错误：必须关闭私有展示，而不是只提示。 */
function isGateLoss(error) {
  const code = error && error.code
  return code === 'SESSION_REQUIRED' || code === 'SESSION_CHANGED' || code === 'SESSION_EXPIRED'
}

/**
 * 读取录音文件的 sha256 与字节数（契约 `UploadInput` 的声明字段）。
 *
 * 与识草/标签 OCR 同一口径（`pages/identify/identify.js` 的同名辅助函数）：
 * 客户端只做**声明**，真实类型与时长仍由服务端按字节核验，本页不代替服务端判定。
 */
function readFileInfo(filePath) {
  return new Promise(function (resolve, reject) {
    wx.getFileInfo({
      filePath: filePath,
      digestAlgorithm: 'sha256',
      success: function (info) {
        if (!info || typeof info.digest !== 'string' || typeof info.size !== 'number') { reject(new Error('INVALID_INPUT')); return }
        resolve({ size: info.size, digest: info.digest })
      },
      fail: function () { const e = new Error('MEDIA_CHANNEL_UNAVAILABLE'); e.code = 'MEDIA_CHANNEL_UNAVAILABLE'; reject(e) }
    })
  })
}
