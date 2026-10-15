// 识别页（GY-I09）：拍照/选图 → 私有媒体引用 → 创建识别任务 → 按 JobState 分七类呈现
// → Top3 候选 → 用户选择 → 关联科普查询 → 私有历史。
//
// 硬口径：
// - 门禁语义保留 page-gate（未登录/门禁拒绝时不动作、不伪造结果）；字号保留 font-scale。
// - 只有 succeeded 才算识别成功；uncertain 的候选必须经用户「人工核对」显式确认才允许记录选择，
//   failed / timed_out / cancelled 不显示任何候选、也不进入关联科普路径。
// - real 模式走契约私有上传链路；该链路不可用时**如实报不可用**，绝不用替身结果顶替。
// - stub / preset_demo 模式使用**明确标注的替身媒体引用**：照片不会上传，页面显著标注。
const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const identifyApi = require('../../utils/identify-api')
// 参考域查询模块按需加载（懒 require）：页面注册阶段不引入 data/** 依赖，
// 使页面在只打包必要依赖的场景下也能加载；白名单仍须包含 utils/reference.js。

/**
 * 私有历史：**只在进程内内存保存，不写入 wx storage**（监工 review 5487051759）。
 *
 * 为什么不能持久化归属：`ownerKey` 取自已核实会话的 `auth.sessionEpoch()`，而 auth 的
 * generation/intentEpoch 是**模块内计数器，应用重启后归零**；契约 `Session`/`SessionInfo`
 * 也没有任何主体标识（只有 access_token/token_type/expires_at/audience/revision/scopes），
 * 小程序内亦无可用哈希能力。因此**跨启动无法证明持久化条目的归属**：重启后不同主体会被映射到
 * 同一存储键与同一 ownerKey，逐条相等过滤随之失效（监工反例：启动 1 的 A 写 1 条 → 模拟重启 →
 * 装载 B 核实成功 ⇒ 仍读出 A 的 recordId）。
 *
 * 结论（fail-closed，不发明"本地随机 owner id"——那同样不能证明归属）：
 * - 历史**不再跨应用重启**持久化，只保留本次进程内；
 * - 装载前**清理**所有本地历史缓存键：旧全局键 `gengyun.identify.history` 与
 *   `gengyun.identify.history.v2.*`（含当前会话世代派生的键）。旧数据无法核实归属 ⇒ 清理，
 *   不做"沿用展示"；
 * - 同进程内的账号切换隔离保持：内存条目仍按已核实会话世代 `ownerKey` 逐条过滤。
 *
 * 代价（如实记录）：本机识别历史不再跨应用重启。当时服务端读取接口（`GET /history`，GY-I16 #16）
 * 已在契约与列表页里，但**没有任何写入点**，因此"跨启动可浏览"当时并不成立。
 *
 * GY-I16（#16）接线后的现状（本片交付）：服务端识别历史**已有写入点** —— 识别/OCR 任务终态提交
 * 成功后由服务端落一行（`services/api/src/app.ts` 的终态历史端口 → `history/service.ts#appendHistory`，
 * 确定性 `event_key` + 幂等去重）。页面因此给出一条到 `/pages/history/history` 的入口
 * （`onOpenServerHistory`）。本机索引的这一段 **fail-closed 论证不变**：它仍只在本次打开期间有效，
 * **不**持久化、**不**跨启动。
 */
const historyByOwner = new Map()
const HISTORY_KEY_LEGACY = 'gengyun.identify.history'
const HISTORY_KEY_PREFIX = 'gengyun.identify.history.v2.'
const HISTORY_MAX = 10
const POLL_INTERVAL_MS = 1000
const POLL_MAX_TICKS = 60
const UUID_HEX = '0123456789abcdef'

/** 替身媒体引用（本地生成的 uuid v4 形状）。仅用于 stub/preset_demo 联调，不代表真实上传。 */
function syntheticMediaId() {
  let out = ''
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) { out += '-'; continue }
    if (i === 14) { out += '4'; continue }
    if (i === 19) { out += UUID_HEX[(Math.random() * 4 | 0) + 8]; continue }
    out += UUID_HEX[Math.random() * 16 | 0]
  }
  return out
}

/** 由文件路径推断声明 MIME（客户端只做声明，服务端以魔数核验真实类型）。 */
function mimeOfPath(path) {
  const lower = typeof path === 'string' ? path.toLowerCase() : ''
  if (/\.jpe?g$/.test(lower)) return 'image/jpeg'
  if (/\.png$/.test(lower)) return 'image/png'
  if (/\.webp$/.test(lower)) return 'image/webp'
  return null
}

/** 门禁核实后的**归属键**（私有缓存的唯一归属证明）。未核实或取不到会话 → 空串。 */
function ownerKeyOf() {
  try {
    if (auth.isLoggedIn() !== true || auth.getSession() === null) return ''
    const epoch = auth.sessionEpoch()
    return typeof epoch === 'string' && epoch !== '' ? epoch : ''
  } catch (error) {
    return ''
  }
}

/** 历史缓存键名（把归属键收敛为安全字符集，避免键注入）；仅用于**清理**旧持久化键。 */
function historyKeyFor(ownerKey) {
  return HISTORY_KEY_PREFIX + String(ownerKey).replace(/[^0-9a-zA-Z:_-]/g, '_')
}

/**
 * 清理**所有本地持久化**的历史缓存键：旧全局键 `gengyun.identify.history` 与
 * `gengyun.identify.history.v2.*`。跨启动无法核实归属 ⇒ 一律清理，不做"沿用展示"。
 * 无论 `getStorageInfoSync` 是否可用，旧全局键都会被显式删除。
 */
function purgeHistoryCache() {
  try {
    let keys = []
    try {
      const info = typeof wx.getStorageInfoSync === 'function' ? wx.getStorageInfoSync() : null
      if (info && Array.isArray(info.keys)) keys = info.keys
    } catch (error) {
      keys = []
    }
    const targets = keys.filter(function (key) {
      return key === HISTORY_KEY_LEGACY || (typeof key === 'string' && key.indexOf(HISTORY_KEY_PREFIX) === 0)
    })
    if (targets.indexOf(HISTORY_KEY_LEGACY) === -1) targets.push(HISTORY_KEY_LEGACY)
    for (const key of targets) wx.removeStorageSync(key)
    return targets.length
  } catch (error) {
    return 0
  }
}

/**
 * 读取**当前归属**的进程内私有历史：无归属键 → 空；逐条校验 `ownerKey` 一致
 * （不读 wx storage：跨启动不可核实归属的缓存已在上游清理）。
 */
function readHistory(ownerKey) {
  if (typeof ownerKey !== 'string' || ownerKey === '') return []
  const value = historyByOwner.get(ownerKey)
  if (!Array.isArray(value)) return []
  return value.filter(function (item) {
    return !!item && typeof item.recordId === 'string' && item.ownerKey === ownerKey
  })
}

/** 写入**当前归属**的进程内私有历史；无归属键一律拒写（fail-closed）。 */
function writeHistory(ownerKey, items) {
  if (typeof ownerKey !== 'string' || ownerKey === '') return false
  historyByOwner.set(ownerKey, items)
  return true
}

Page({
  onLoad: function () {
    // 门禁核实**之前**不得读取/应用任何全局私有数据（历史只在核实通过后装载）。
    fontScale.applyFontScale(this)
    // 启动即清理无法跨启动核实归属的本地历史缓存（旧全局键 + v2.* 命名空间键）。
    purgeHistoryCache()
  },

  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    modes: [
      { key: 'weed', iconClass: 'gy-icon--leaf', title: '拍草识别', desc: '拍照片识别田里的杂草，给出至多 3 个候选', action: '拍照识别' },
      { key: 'ocr', iconClass: 'gy-icon--tag', title: '标签识别', desc: '拍包装读出药名与成分（尚未接入）', action: '尚未接入' },
      { key: 'text', iconClass: 'gy-icon--chat', title: '文字提问', desc: '打字提问（尚未接入）', action: '尚未接入' }
    ],
    guest: true,
    busy: false,
    errorText: '',
    modeNote: '',
    substituteNotice: '',
    job: null,
    stateView: null,
    /** 六类失败/边界分支归类（不属于六类时为 null）与其指引（落点 + 可重试语义）。 */
    branch: null,
    branchInfo: null,
    candidates: [],
    candidatesTrusted: false,
    showTop3: false,
    uncertaintyReasons: [],
    /**
     * 关联科普/用量判定所用的**条件**（契约 `DoseConditions` 的 6 个必填项）。
     *
     * 本页只掌握「杂草对象」一项：作物/地区/生育期/种植方式/使用场景需要用户档案或选择，
     * 因此默认 `null` ⇒ 条件不完整 ⇒ 用量查询被**阻断**并如实列出缺项（不使用默认值凑齐）。
     */
    recognitionConditions: null,
    /** 用量路径守卫结果（恒不可用；恒不展示用量）。 */
    doseGuard: null,
    recordId: null,
    recordRevision: 0,
    pendingManualId: null,
    selectedSpeciesId: null,
    relatedKnowledge: null,
    history: [],
    /** 当前已核实主体标识；为空表示门禁未通过，历史/候选区一律不展示。 */
    historyOwner: '',
    historyNote: '',
    candidateSource: 'job',
    /** 语音入口的既有按钮状态（独立录音/播放按钮，播放需先有录音）。 */
    recording: false,
    hasRecording: false
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    const that = this
    this.setData({ fontScale: fontScale.currentFontScale() })
    // 门禁核实前先关闭私有展示（清空候选/记录/历史并递增代次），核实通过后才装载。
    this.closePrivate()
    pageGate.start(this, function (ok) {
      if (ok === true && auth.isLoggedIn()) {
        // 归属键只能来自**已核实会话**；取不到归属键一律按未核实处理（fail-closed）。
        const ownerKey = ownerKeyOf()
        if (ownerKey === '') { that.closePrivate(); return }
        that._ownerKey = ownerKey
        that.setData({ guest: false, historyOwner: ownerKey, history: readHistory(ownerKey) })
        return
      }
      that.closePrivate()
    })
  },

  onHide: function () { pageGate.cancel(this); this.closePrivate() },
  onUnload: function () { pageGate.cancel(this); this.closePrivate() },

  // -------------------------------------------------- 私有展示的关闭与代次

  /**
   * 操作代次：门禁关闭、离页、重试、切换对象时递增；在途异步结果只有在代次未变、
   * 门禁仍通过、且对象版本一致时才允许落回展示（监工 5485989704 [C]）。
   */
  beginOperation: function () {
    this._generation = (this._generation || 0) + 1
    return this._generation
  },

  isCurrentOperation: function (gen) {
    return this._generation === gen && this.data.guest !== true
  },

  /** 关闭私有展示：清空候选/任务/记录/历史，并递增代次使在途回调失效。 */
  closePrivate: function (message) {
    this.stopPoll()
    this.beginOperation()
    // 归属键失效：此后任何写入/读取都必须重新经门禁核实取得归属。
    this._ownerKey = ''
    // 无法跨启动核实归属的本地历史缓存一律清理（fail-closed），不做"沿用展示"。
    purgeHistoryCache()
    const patch = {
      guest: true, historyOwner: '', history: [], candidates: [], showTop3: false, candidatesTrusted: false,
      uncertaintyReasons: [], pendingManualId: null, selectedSpeciesId: null, relatedKnowledge: null,
      recordId: null, recordRevision: 0, job: null, stateView: null, historyNote: '', candidateSource: 'job',
      branch: null, branchInfo: null, doseGuard: null,
      busy: false, substituteNotice: ''
    }
    if (typeof message === 'string' && message !== '') patch.errorText = message
    this.setData(patch)
  },

  // ------------------------------------------------------------------ 入口

  onShoot: function (event) {
    if (this.data.guest || this.data.busy) return
    const key = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.mode : null
    if (key !== 'weed') {
      wx.showToast({ title: '该入口尚未接入', icon: 'none' })
      return
    }
    this.choosePhoto()
  },

  /** 录音入口：**尚未接入真实录音**，只切换按钮文案；不调用任何录音能力、不采集、不上传。 */
  onRecord: function () {
    if (this.data.guest) return
    this.setData({ recording: !this.data.recording })
  },

  /** 播放入口（独立按钮，无录音时禁用）：未接入真实播放能力，如实提示，不播放、不上传。 */
  onPlay: function () {
    if (this.data.guest || !this.data.hasRecording) return
    wx.showToast({ title: '播放能力尚未接入', icon: 'none' })
  },

  choosePhoto: function () {
    if (this.data.guest) return
    const that = this
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      success: function (result) {
        const file = result && result.tempFiles && result.tempFiles[0]
        if (!file || typeof file.tempFilePath !== 'string') { that.setData({ errorText: '未取得照片，请重试。' }); return }
        that.prepareMedia(file.tempFilePath)
      },
      fail: function () { that.setData({ errorText: '未选择照片，已取消。' }) }
    })
  },

  /** 取得可用于识别的媒体引用：real 走真实上传链路，替身模式用明确标注的替身引用。 */
  prepareMedia: async function (tempFilePath) {
    if (this.data.guest) return
    const gen = this.beginOperation()
    this.setData({ busy: true, errorText: '', substituteNotice: '', stateView: null, job: null, candidates: [], showTop3: false, uncertaintyReasons: [], recordId: null, recordRevision: 0, pendingManualId: null, selectedSpeciesId: null, relatedKnowledge: null })
    let media
    try {
      const mode = await identifyApi.serverMode()
      if (!this.isCurrentOperation(gen)) return
      this.setData({ modeNote: modeNoteFor(mode) })
      if (mode === 'real') {
        const mime = mimeOfPath(tempFilePath)
        if (mime === null) { this.setData({ busy: false, errorText: '无法确定照片类型，请改用 JPG / PNG / WebP。' }); return }
        const info = await readFileInfo(tempFilePath)
        if (!this.isCurrentOperation(gen)) return
        media = await identifyApi.uploadPrivatePhoto(tempFilePath, { mime: mime, bytes: info.size, sha256: info.digest })
      } else {
        // 替身模式：照片**不上传**，使用本地生成的替身媒体引用（服务端 meta.execution_mode 已如实标注）。
        this.setData({ substituteNotice: '替身模式（' + mode + '）：照片不会上传，识别使用替身媒体引用，结果不代表真实识别。' })
        media = { mediaId: syntheticMediaId(), mediaRevision: 1 }
      }
      if (!this.isCurrentOperation(gen)) return
    } catch (error) {
      if (!this.isCurrentOperation(gen)) return
      if (isGateLossError(error)) { this.closePrivate(identifyApi.messageFor(error)); return }
      this.setData({ busy: false, errorText: identifyApi.messageFor(error) })
      return
    }
    try {
      const created = await identifyApi.createRecognition(media.mediaId, media.mediaRevision)
      if (!this.isCurrentOperation(gen)) return
      this.setData({ job: { id: created.job.id, revision: created.job.revision, state: created.job.state }, modeNote: modeNoteFor(created.mode) })
      this.applyJob(created.job, gen)
      this.startPoll(gen)
    } catch (error) {
      if (!this.isCurrentOperation(gen)) return
      if (isGateLossError(error)) { this.closePrivate(identifyApi.messageFor(error)); return }
      this.setData({ busy: false, errorText: identifyApi.messageFor(error) })
    }
  },

  // ------------------------------------------------------------------ 轮询

  startPoll: function (gen) {
    const that = this
    const generation = gen === undefined ? this._generation : gen
    this.stopPoll()
    let ticks = 0
    this._pollTimer = setInterval(function () {
      ticks += 1
      if (!that.isCurrentOperation(generation) || !that.data.job) { that.stopPoll(); return }
      if (ticks > POLL_MAX_TICKS) {
        that.stopPoll()
        that.setData({ busy: false, errorText: '轮询已达上限，请重新查询任务状态。' })
        return
      }
      that.refreshJob(generation)
    }, POLL_INTERVAL_MS)
  },

  stopPoll: function () {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null }
  },

  refreshJob: async function (gen) {
    if (!this.data.job) return
    const generation = gen === undefined ? this._generation : gen
    const jobId = this.data.job.id
    try {
      const r = await identifyApi.getJob(jobId)
      // 双重约束：操作代次未变（未离页/未重试/未切对象）且门禁仍通过、对象仍是同一任务。
      if (!this.isCurrentOperation(generation)) return
      if (!this.data.job || this.data.job.id !== jobId) return
      this.applyJob(r.job, generation)
    } catch (error) {
      if (!this.isCurrentOperation(generation)) return
      this.stopPoll()
      if (isGateLossError(error)) { this.closePrivate(identifyApi.messageFor(error)); return }
      this.setData({ busy: false, errorText: identifyApi.messageFor(error) })
    }
  },

  /** 由**已校验**的 Job 决定页面显示；非 succeeded 绝不按识别成功渲染。 */
  applyJob: function (job, gen) {
    // 迟到的合法成功响应若已离页/重试/切对象，不得恢复展示，也不得写历史。
    if (gen !== undefined && !this.isCurrentOperation(gen)) return
    const model = identifyApi.viewModelForJob(job)
    const record = job.result
    const patch = {
      busy: model.view.terminal !== true,
      job: { id: job.id, revision: job.revision, state: job.state },
      stateView: model.view,
      // 六类失败/边界分支：页面据此给出**唯一**重试动作（不可重试时不给入口）。
      branch: model.branch,
      branchInfo: model.branchInfo,
      candidates: model.candidates,
      candidatesTrusted: model.candidatesTrusted,
      showTop3: model.showTop3,
      uncertaintyReasons: model.reasons,
      recordId: record === null ? null : record.id,
      recordRevision: record === null ? 0 : record.revision,
      pendingManualId: null,
      historyNote: '',
      candidateSource: 'job',
      // 用量守卫：无论任务状态如何，本页恒不展示用量（如实带出阻断与缺项）。
      doseGuard: identifyApi.dosePathGuard(this.data.recognitionConditions)
    }
    if (record !== null && record.selected_species_id !== null) patch.selectedSpeciesId = record.selected_species_id
    else patch.selectedSpeciesId = null
    if (model.view.terminal === true) {
      this.stopPoll()
      if (record !== null) this.rememberHistory(job, record, gen)
    }
    this.setData(patch)
  },

  // -------------------------------------------------------------- 用户动作

  onCancelJob: async function () {
    if (!this.data.job || this.data.busy !== true) return
    const gen = this._generation
    const jobId = this.data.job.id
    const revision = this.data.job.revision
    try {
      const r = await identifyApi.cancelJob(jobId, revision)
      if (!this.isCurrentOperation(gen)) return
      if (!this.data.job || this.data.job.id !== jobId) return
      this.applyJob(r.job, gen)
    } catch (error) {
      if (!this.isCurrentOperation(gen)) return
      if (isGateLossError(error)) { this.closePrivate(identifyApi.messageFor(error)); return }
      this.setData({ busy: false, errorText: identifyApi.messageFor(error) })
    }
  },

  onRetry: function () {
    this.stopPoll()
    this.beginOperation()
    this.setData({ job: null, stateView: null, branch: null, branchInfo: null, doseGuard: null, candidates: [], showTop3: false, uncertaintyReasons: [], errorText: '', substituteNotice: '', selectedSpeciesId: null, relatedKnowledge: null, pendingManualId: null, recordId: null, recordRevision: 0, busy: false, historyNote: '', candidateSource: 'job' })
  },

  /** 点候选：succeeded 直接记录选择；uncertain 必须先显式「人工核对」确认。 */
  onTapCandidate: function (event) {
    const speciesId = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.id : null
    if (typeof speciesId !== 'string' || speciesId === '') return
    if (this.data.candidatesTrusted === true) { this.recordSelection(speciesId); return }
    this.setData({ pendingManualId: speciesId })
  },

  onConfirmManual: function () {
    if (typeof this.data.pendingManualId !== 'string' || this.data.pendingManualId === '') return
    this.recordSelection(this.data.pendingManualId)
  },

  onCancelManual: function () { this.setData({ pendingManualId: null }) },

  /** 记录用户选择（独立于模型原始候选），随后才查询关联科普。 */
  recordSelection: async function (speciesId) {
    if (this.data.guest === true || this.data.recordId === null || this.data.recordRevision < 1) return
    const gen = this._generation
    const recordId = this.data.recordId
    const revision = this.data.recordRevision
    this.setData({ busy: true, errorText: '', pendingManualId: null })
    let recognition
    try {
      const r = await identifyApi.selectSpecies(recordId, revision, speciesId)
      recognition = r.recognition
    } catch (error) {
      if (!this.isCurrentOperation(gen)) return
      if (error && error.code === 'REVISION_CONFLICT') {
        try {
          const fresh = await identifyApi.getRecognition(recordId)
          recognition = fresh.recognition
        } catch (again) {
          if (!this.isCurrentOperation(gen)) return
          if (isGateLossError(again)) { this.closePrivate(identifyApi.messageFor(again)); return }
          this.setData({ busy: false, errorText: identifyApi.messageFor(again) }); return
        }
      } else {
        if (isGateLossError(error)) { this.closePrivate(identifyApi.messageFor(error)); return }
        this.setData({ busy: false, errorText: identifyApi.messageFor(error) })
        return
      }
    }
    if (!this.isCurrentOperation(gen)) return
    if (this.data.recordId !== recordId) return
    // selection 只写用户选择：模型原始候选/分数由服务端保持，客户端不重算、不覆盖。
    this.setData({ busy: false, selectedSpeciesId: speciesId, recordRevision: recognition.revision, candidates: recognition.candidates.map(function (c) {
      return { species_id: c.species_id, rank: c.rank, model_score: c.model_score, scoreText: c.model_score === null ? '无分数' : Math.round(c.model_score * 100) + '%' }
    }) })
    // 关联科普与条件：条件不完整即阻断用量查询（页面如实列出缺项）。
    this.setData({ relatedKnowledge: queryRelatedKnowledge(speciesId, this.data.recognitionConditions) })
  },

  // ---------------------------------------------------------------- 私有历史

  rememberHistory: function (job, record, gen) {
    // 门禁未通过、无**归属键**、或代次已失效时**不得**写全局私有数据。
    const ownerKey = this._ownerKey
    if (this.data.guest === true || typeof ownerKey !== 'string' || ownerKey === '') return
    if (gen !== undefined && !this.isCurrentOperation(gen)) return
    const items = readHistory(ownerKey).filter(function (item) { return item.recordId !== record.id })
    items.unshift({
      // 逐条归属：装载时据此过滤，缺归属字段的旧条目一律不展示。
      ownerKey: ownerKey,
      jobId: job.id,
      recordId: record.id,
      state: job.state,
      stateTitle: identifyApi.describeJobState(job.state).title,
      selectedSpeciesId: record.selected_species_id,
      at: new Date().toISOString()
    })
    const trimmed = items.slice(0, HISTORY_MAX)
    if (writeHistory(ownerKey, trimmed) !== true) return
    this.setData({ history: trimmed })
  },

  /** 历史项以服务端为权威重新核对（他人/已删除的记录会如实 404）。 */
  onOpenHistoryItem: async function (event) {
    const recordId = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.id : null
    if (typeof recordId !== 'string' || !identifyApi.validId(recordId)) return
    if (this.data.guest === true || this.data.historyOwner === '') return
    const gen = this.beginOperation()
    const previousRecordId = this.data.recordId
    this.setData({ busy: true, errorText: '' })
    try {
      const r = await identifyApi.getRecognition(recordId)
      // 代次 + 对象版本双约束：离页/重试/切换对象后的旧响应不得恢复展示。
      if (!this.isCurrentOperation(gen)) return
      if (this.data.recordId !== previousRecordId) return
      const candidates = r.recognition.candidates.map(function (c) {
        return { species_id: c.species_id, rank: c.rank, model_score: c.model_score, scoreText: c.model_score === null ? '无分数' : Math.round(c.model_score * 100) + '%' }
      })
      // 历史记录只展示服务端保存的模型原始候选；**不**据此推断任务状态（JobState 需要任务读面），
      // 因此也不给「分支 + 重试动作」（那是任务读面的结论）。
      this.setData({ busy: false, recordId: r.recognition.id, recordRevision: r.recognition.revision,
        selectedSpeciesId: r.recognition.selected_species_id, candidates: candidates,
        candidatesTrusted: false, showTop3: r.recognition.candidates.length > 0, candidateSource: 'history',
        uncertaintyReasons: r.recognition.uncertainty_reasons,
        historyNote: '这是服务端保存的历史识别记录（第 ' + r.recognition.revision + ' 次修订）：候选为模型原始结果，请人工核对；本页不据此推断任务状态。',
        stateView: null,
        branch: null,
        branchInfo: null,
        doseGuard: identifyApi.dosePathGuard(this.data.recognitionConditions),
        relatedKnowledge: r.recognition.selected_species_id === null ? null : queryRelatedKnowledge(r.recognition.selected_species_id, this.data.recognitionConditions) })
    } catch (error) {
      if (!this.isCurrentOperation(gen)) return
      if (isGateLossError(error)) { this.closePrivate(identifyApi.messageFor(error)); return }
      this.setData({ busy: false, errorText: identifyApi.messageFor(error) })
    }
  },

  onDeleteRecord: async function () {
    if (this.data.guest === true || this.data.recordId === null || this.data.recordRevision < 1) return
    const that = this
    const recordId = this.data.recordId
    const revision = this.data.recordRevision
    const ownerKey = this._ownerKey
    if (typeof ownerKey !== 'string' || ownerKey === '') return
    wx.showModal({
      title: '删除这条识别记录',
      content: '删除后无法恢复，关联的候选与选择一并移除。',
      success: async function (result) {
        if (!result.confirm) return
        const gen = that.beginOperation()
        try {
          await identifyApi.deleteRecognition(recordId, revision)
          if (!that.isCurrentOperation(gen) || that._ownerKey !== ownerKey) return
          const items = readHistory(ownerKey).filter(function (item) { return item.recordId !== recordId })
          writeHistory(ownerKey, items)
          that.onRetry()
          that.setData({ history: items, errorText: '' })
        } catch (error) {
          if (!that.isCurrentOperation(gen)) return
          if (isGateLossError(error)) { that.closePrivate(identifyApi.messageFor(error)); return }
          that.setData({ errorText: identifyApi.messageFor(error) })
        }
      }
    })
  },

  onClearHistory: function () {
    const ownerKey = this._ownerKey
    if (this.data.guest === true || typeof ownerKey !== 'string' || ownerKey === '') return
    historyByOwner.delete(ownerKey)
    // 旧持久化键（若有残留）一并清理，避免下次启动出现无法核实归属的数据。
    try { wx.removeStorageSync(historyKeyFor(ownerKey)) } catch (_) {}
    this.setData({ history: [] })
  },

  /**
   * 打开服务端识别历史（`GET /history`，见 `pages/history`）。
   *
   * 与「我的 → 识别历史」是**同一个**入口页（`profile.js` 的 `openHistory` 同 URL），
   * 不另造第二套历史面。服务端历史行由识别/OCR 任务终态写入（GY-I16 #16 接线）。
   */
  onOpenServerHistory: function () {
    if (this.data.guest === true) return
    wx.navigateTo({ url: '/pages/history/history' })
  }
})

/** 会话/门禁失效类错误：必须关闭私有展示，而不是只提示。 */
function isGateLossError(error) {
  const code = error && error.code
  return code === 'SESSION_REQUIRED' || code === 'SESSION_CHANGED' || code === 'SESSION_EXPIRED'
}

/** 读取文件 sha256 与字节数（用于契约 UploadInput 的声明；服务端仍以真实字节核验）。 */
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

/**
 * 关联科普查询（本地参考域查询组件 + **GY-I08 用量守卫**）。
 *
 * 硬规则（与 `services/api/src/recognitions/linkage.ts` 同口径）：
 *   1. 只取**有效、可访问、非模拟**的资料（由 `reference.query` 的资格判定保证，
 *      模拟来源数量如实带出 `simulated_excluded`）；
 *   2. 条件按契约 `DoseConditions` 的 6 个必填项判定，**不完整即阻断**，
 *      并逐项列出缺什么（不静默放宽、不补默认值）；
 *   3. **禁止经识别绕过用量守卫**：本路径恒不展示用量
 *      （`dose.renderable === false`、`dose.card === null`、恒定阻断 `no_dose_source`），
 *      即便条件完整也一样；具体用量必须走 GY-I08 授权的资料/详情消费面；
 *   4. 规则版本与 GY-I08 一致（`APPLICABILITY_RULE_VERSION`），不一致由回归测试拦住。
 *
 * 资料条目为种子整理稿，呈现时必须标注「待核实 · 非权威」。
 */
function queryRelatedKnowledge(speciesId, conditions) {
  const guard = identifyApi.dosePathGuard(conditions)
  const base = {
    speciesId: speciesId,
    ruleVersion: guard.ruleVersion,
    dose: guard,
    conditionsComplete: guard.conditionsComplete,
    missingConditions: guard.missingConditions,
    missingConditionLabels: guard.missingConditionLabels
  }
  try {
    const reference = require('../../utils/reference')
    const queryParams = { species_id: speciesId, limit: 5 }
    // 只把**非空**条件交给查询：空串不得被当成"已采集"（与域库 matchConditions 同口径）。
    for (const field of identifyApi.DOSE_CONDITION_FIELDS) {
      const value = conditions && typeof conditions[field] === 'string' ? conditions[field].trim() : ''
      if (value !== '') queryParams[field] = value
    }
    const result = reference.query(queryParams)
    const items = (result && result.items ? result.items : []).map(function (item) {
      // 逐条跑 GY-I08 用量描述符：**只用于如实说明为什么不能给用量**，
      // 其结果不会被本页用来渲染任何剂量数字。
      const descriptor = reference.doseCardDescriptor(item, {
        doseCardEnabled: false,
        context: queryParams
      })
      return {
        recordId: item.record_id,
        registrationNumber: item.registration_number,
        name: item.registered_name,
        dosageForm: item.dosage_form,
        useScene: item.use_scene,
        labels: item.labels,
        doseRenderable: descriptor.renderable === true,
        doseReason: descriptor.reason,
        doseRuleVersion: descriptor.rule_version
      }
    })
    return Object.assign({}, base, {
      matchState: result.match_state,
      matchStateLabel: reference.matchStateLabel(result.match_state),
      reasons: result.reasons.concat(result.simulated_excluded > 0 ? ['已排除 ' + result.simulated_excluded + ' 条模拟资料'] : []),
      items: items,
      note: '资料为种子整理稿（' + reference.catalogVersionText() + '），须以官方登记信息核对；本页不提供用量（识别路径恒不可给用量）。'
    })
  } catch (error) {
    return Object.assign({}, base, {
      matchState: 'unavailable',
      matchStateLabel: '查询未取得结果',
      reasons: ['关联科普查询未取得结果：' + (error && error.message ? error.message : '未知原因')],
      items: [],
      note: '未取得结果时不会用本地缓存顶替，也不会给出任何用量。'
    })
  }
}

function modeNoteFor(mode) {
  if (mode === 'real') return '服务端为 real 模式：照片经私有媒体链路处理，识别由真实提供者完成（当前真实提供者未接入时如实报不可用）。'
  if (mode === 'preset_demo') return '服务端为 preset_demo（预设演示）模式：结果明显标注为演示，不代表真实识别。'
  if (mode === 'stub') return '服务端为 stub（替身）模式：结果来自替身，仅供联调，不代表真实识别。'
  return '未取得服务端执行模式，识别结果状态未确认。'
}
