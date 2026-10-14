// GY-I13 **播报页**：语音球 + 等效播放控件 + 完整安全检查在前 + 离页取消/释放。
//
// 三段式（每一段都如实呈现，绝不跳过前一段）：
//   ① 安全检查：`utils/speech-text.js` 的 `assertSpeakable`（只有 `check_state === 'passed'`
//      才放行）。**未通过 ⇒ 不发起任何合成请求、不创建播放器**（可复核：请求数为 0）；
//   ② 合成：`POST /speech/synthesis`（带 `Idempotency-Key`）→ 轮询 `GET /jobs/{id}` 到终态，
//      七类 `JobState` 与 `error_code` 逐类如实显示，不折叠成"成功/失败"；
//   ③ 播放：只有"任务成功 **且** 有可播放的音频源"才自动播放；否则**自动播放失败** ⇒
//      文案 + 主动播放按钮，并且**不记「已听取」**。
//
// 离页口径（返回 / 切页 / 隐藏三条路径共用同一个出口）：
//   取消本机在途请求与轮询 + `controller.release()`（退订全部监听、销毁音频句柄）；
//   合成任务**没有服务端取消能力**，因此**不谎称**服务端任务已取消（文案见
//   `utils/voice-api.js` 的 `EXIT_CANCELLATION_NOTE`）。
//
// 替身边界（本地替身工程专用，默认关闭）：本页在 `debug.localEnabled` 为真时才提供
// **明确标注的替身样本**与**替身播放端口**走查开关；替身播放不产生任何声音、**不计入「已听取」**。
const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const speechText = require('../../utils/speech-text')
const audioPlayback = require('../../utils/audio-playback')
const innerAudioPort = require('../../utils/inner-audio-port')
const substitutePlayer = require('../../utils/substitute-player')
const voiceApi = require('../../utils/voice-api')

const POLL_INTERVAL_MS = 1000
const POLL_MAX_TICKS = 30
const SUBSTITUTE_SOURCE_PREFIX = 'substitute://segment/'
const RECORD_NOTE = '录音能力尚未接线：本页不调用麦克风、不采集、不上传任何音频。'
  + '录音控件与播报控件是两个独立控件，互不复用；播报的内容一律来自服务端已核对正文。'

Page({
  onLoad: function () {
    fontScale.applyFontScale(this)
    this._generation = 0
    this._controller = null
    this._plan = []
    this._substituteSegments = []
    this._failFirst = null
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    this.setData({ fontScale: fontScale.currentFontScale() })
    const that = this
    pageGate.start(this, function (ok) {
      const loggedIn = ok === true && auth.isLoggedIn()
      const localEnabled = loggedIn ? voiceApi.substituteSamplesEnabled() : false
      that.setData({
        guest: loggedIn !== true,
        localEnabled: localEnabled,
        samples: localEnabled ? voiceApi.SUBSTITUTE_SPEAK_SAMPLES : [],
        substituteNote: localEnabled ? voiceApi.SUBSTITUTE_NOTE : ''
      })
      if (loggedIn !== true) that.closePrivate()
    })
  },

  // 返回 / 切页 / 隐藏：三条路径都走同一个释放出口。
  onHide: function () { pageGate.cancel(this); this.releaseAll('hide') },
  onUnload: function () { pageGate.cancel(this); this.releaseAll('unload') },

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
    substituteWalkthrough: true,
    failureProbe: '',
    probing: false,
    // 录音控件（独立，未接线）
    recording: false,
    hasRecording: false,
    recordNote: RECORD_NOTE,
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

  /** 关闭私有展示（未登录/门禁失效/离页）：停轮询、作废在途请求、释放播放器。 */
  closePrivate: function () {
    this.releaseAll('gate')
    this.beginOperation()
    this.setData({
      selectedSampleId: '', checkState: '', checkPassed: false, checkMessage: '',
      checkedText: '', segmentCount: 0, segmentPreview: '',
      stage: 'check', busy: false, mode: '', job: null, synthesisNote: ''
    })
  },

  /**
   * 统一的释放出口：停轮询 → 作废本机在途请求 → 释放控制器（退订 + 销毁句柄）。
   * 幂等；`release()` 之后迟到的播放回调一律失效（后台残留的负例判据）。
   */
  releaseAll: function (reason) {
    this.stopPoll()
    voiceApi.cancelAll()
    this.beginOperation()
    this._plan = []
    if (this._controller !== null) {
      this._controller.release()
      this._controller = null
    }
    this.setData({
      playbackState: 'idle', listened: false, substituteCompleted: false, failure: null,
      busy: false, exitReason: typeof reason === 'string' ? reason : ''
    })
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
    const generation = this.beginOperation()
    this.setData({ busy: true, stage: 'synthesis', synthesisNote: '', job: null, failure: null, listened: false, substituteCompleted: false, playbackState: 'idle' })
    try {
      const created = await voiceApi.createSynthesis({ type: 'answer', id: sample.id, revision: 1 })
      if (!this.isCurrent(generation)) return
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

  /** 合成落定后进入播放段：先判可播源，再决定自动播报或如实走失败出口。 */
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
    if (segments.length === 0) {
      // 自动播放失败：**文案 + 主动播放按钮**，并且不记「已听取」。
      this.ensureController().play([], { auto: true })
      return
    }
    this.applyModeNotice(source)
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

  applyModeNotice: function (source) {
    if (source.ok === true) return
    this.setData({
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
    this.setData({ substituteWalkthrough: next, playbackState: 'idle', listened: false, substituteCompleted: false, failure: null, ballHint: '' })
  },

  onPickFailureProbe: function (event) {
    if (this.data.localEnabled !== true) return
    const code = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.code : ''
    this._failFirst = typeof code === 'string' && code !== '' ? code : null
    if (this._controller !== null) { this._controller.release(); this._controller = null }
    this.setData({ failureProbe: this._failFirst || '', probing: this._failFirst !== null, failure: null, playbackState: 'idle', listened: false })
  },

  // ---------------------------------------------------------------- 录音控件（独立、未接线）

  /** 录音入口：**尚未接线**，只切换文案；不调用任何录音能力、不采集、不上传（与播报控件分离）。 */
  onRecord: function () {
    if (this.data.guest) return
    this.setData({ recording: !this.data.recording })
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
