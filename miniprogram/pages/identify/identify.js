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

const HISTORY_KEY = 'gengyun.identify.history'
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

Page({
  onLoad: function () {
    fontScale.applyFontScale(this)
    this.setData({ history: readHistory() })
  },

  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    modes: [
      { key: 'weed', icon: '🌿', title: '拍草识别', desc: '拍照片识别田里的杂草，给出至多 3 个候选', action: '拍照识别' },
      { key: 'ocr', icon: '🏷️', title: '标签识别', desc: '拍包装读出药名与成分（尚未接入）', action: '尚未接入' },
      { key: 'text', icon: '💬', title: '文字提问', desc: '打字提问（尚未接入）', action: '尚未接入' }
    ],
    guest: true,
    busy: false,
    errorText: '',
    modeNote: '',
    substituteNotice: '',
    job: null,
    stateView: null,
    candidates: [],
    candidatesTrusted: false,
    showTop3: false,
    uncertaintyReasons: [],
    recordId: null,
    recordRevision: 0,
    pendingManualId: null,
    selectedSpeciesId: null,
    relatedKnowledge: null,
    history: [],
    historyNote: '',
    candidateSource: 'job'
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    // 每次进入先关闭入口，服务端核实成功后才允许识别。
    const that = this
    this.setData({ guest: true, fontScale: fontScale.currentFontScale() })
    pageGate.start(this, function (ok) {
      that.setData({ guest: !ok })
    })
  },

  onHide: function () { pageGate.cancel(this); this.stopPoll() },
  onUnload: function () { pageGate.cancel(this); this.stopPoll() },

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

  onRecord: function () {
    if (this.data.guest) return
    wx.showToast({ title: '语音提问尚未接入', icon: 'none' })
  },

  choosePhoto: function () {
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
    this.setData({ busy: true, errorText: '', substituteNotice: '', stateView: null, job: null, candidates: [], showTop3: false, uncertaintyReasons: [], recordId: null, recordRevision: 0, pendingManualId: null, selectedSpeciesId: null, relatedKnowledge: null })
    let media
    try {
      const mode = await identifyApi.serverMode()
      this.setData({ modeNote: modeNoteFor(mode) })
      if (mode === 'real') {
        const mime = mimeOfPath(tempFilePath)
        if (mime === null) { this.setData({ busy: false, errorText: '无法确定照片类型，请改用 JPG / PNG / WebP。' }); return }
        const info = await readFileInfo(tempFilePath)
        media = await identifyApi.uploadPrivatePhoto(tempFilePath, { mime: mime, bytes: info.size, sha256: info.digest })
      } else {
        // 替身模式：照片**不上传**，使用本地生成的替身媒体引用（服务端 meta.execution_mode 已如实标注）。
        this.setData({ substituteNotice: '替身模式（' + mode + '）：照片不会上传，识别使用替身媒体引用，结果不代表真实识别。' })
        media = { mediaId: syntheticMediaId(), mediaRevision: 1 }
      }
    } catch (error) {
      this.setData({ busy: false, errorText: identifyApi.messageFor(error) })
      return
    }
    try {
      const created = await identifyApi.createRecognition(media.mediaId, media.mediaRevision)
      this.setData({ job: { id: created.job.id, revision: created.job.revision, state: created.job.state }, modeNote: modeNoteFor(created.mode) })
      this.applyJob(created.job)
      this.startPoll()
    } catch (error) {
      this.setData({ busy: false, errorText: identifyApi.messageFor(error) })
    }
  },

  // ------------------------------------------------------------------ 轮询

  startPoll: function () {
    const that = this
    this.stopPoll()
    let ticks = 0
    this._pollTimer = setInterval(function () {
      ticks += 1
      if (ticks > POLL_MAX_TICKS) {
        that.stopPoll()
        that.setData({ busy: false, errorText: '轮询已达上限，请重新查询任务状态。' })
        return
      }
      that.refreshJob()
    }, POLL_INTERVAL_MS)
  },

  stopPoll: function () {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null }
  },

  refreshJob: async function () {
    if (!this.data.job) return
    try {
      const r = await identifyApi.getJob(this.data.job.id)
      this.applyJob(r.job)
    } catch (error) {
      this.stopPoll()
      this.setData({ busy: false, errorText: identifyApi.messageFor(error) })
    }
  },

  /** 由**已校验**的 Job 决定页面显示；非 succeeded 绝不按识别成功渲染。 */
  applyJob: function (job) {
    const model = identifyApi.viewModelForJob(job)
    const record = job.result
    const patch = {
      busy: model.view.terminal !== true,
      job: { id: job.id, revision: job.revision, state: job.state },
      stateView: model.view,
      candidates: model.candidates,
      candidatesTrusted: model.candidatesTrusted,
      showTop3: model.showTop3,
      uncertaintyReasons: model.reasons,
      recordId: record === null ? null : record.id,
      recordRevision: record === null ? 0 : record.revision,
      pendingManualId: null,
      historyNote: '',
      candidateSource: 'job'
    }
    if (record !== null && record.selected_species_id !== null) patch.selectedSpeciesId = record.selected_species_id
    if (model.view.terminal === true) {
      this.stopPoll()
      if (record !== null) this.rememberHistory(job, record)
    }
    this.setData(patch)
  },

  // -------------------------------------------------------------- 用户动作

  onCancelJob: async function () {
    if (!this.data.job || this.data.busy !== true) return
    try {
      const r = await identifyApi.cancelJob(this.data.job.id, this.data.job.revision)
      this.applyJob(r.job)
    } catch (error) {
      this.setData({ busy: false, errorText: identifyApi.messageFor(error) })
    }
  },

  onRetry: function () {
    this.stopPoll()
    this.setData({ job: null, stateView: null, candidates: [], showTop3: false, uncertaintyReasons: [], errorText: '', substituteNotice: '', selectedSpeciesId: null, relatedKnowledge: null, pendingManualId: null, recordId: null, recordRevision: 0, busy: false, historyNote: '', candidateSource: 'job' })
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
    if (this.data.recordId === null || this.data.recordRevision < 1) return
    this.setData({ busy: true, errorText: '', pendingManualId: null })
    let recognition
    try {
      const r = await identifyApi.selectSpecies(this.data.recordId, this.data.recordRevision, speciesId)
      recognition = r.recognition
    } catch (error) {
      if (error && error.code === 'REVISION_CONFLICT') {
        try {
          const fresh = await identifyApi.getRecognition(this.data.recordId)
          recognition = fresh.recognition
        } catch (again) { this.setData({ busy: false, errorText: identifyApi.messageFor(again) }); return }
      } else {
        this.setData({ busy: false, errorText: identifyApi.messageFor(error) })
        return
      }
    }
    // selection 只写用户选择：模型原始候选/分数由服务端保持，客户端不重算、不覆盖。
    this.setData({ busy: false, selectedSpeciesId: speciesId, recordRevision: recognition.revision, candidates: recognition.candidates.map(function (c) {
      return { species_id: c.species_id, rank: c.rank, model_score: c.model_score, scoreText: c.model_score === null ? '无分数' : Math.round(c.model_score * 100) + '%' }
    }) })
    this.setData({ relatedKnowledge: queryRelatedKnowledge(speciesId) })
  },

  // ---------------------------------------------------------------- 私有历史

  rememberHistory: function (job, record) {
    const items = readHistory().filter(function (item) { return item.recordId !== record.id })
    items.unshift({
      jobId: job.id,
      recordId: record.id,
      state: job.state,
      stateTitle: identifyApi.describeJobState(job.state).title,
      selectedSpeciesId: record.selected_species_id,
      at: new Date().toISOString()
    })
    const trimmed = items.slice(0, HISTORY_MAX)
    try { wx.setStorageSync(HISTORY_KEY, trimmed) } catch (_) {}
    this.setData({ history: trimmed })
  },

  /** 历史项以服务端为权威重新核对（他人/已删除的记录会如实 404）。 */
  onOpenHistoryItem: async function (event) {
    const recordId = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.id : null
    if (typeof recordId !== 'string' || !identifyApi.validId(recordId)) return
    this.setData({ busy: true, errorText: '' })
    try {
      const r = await identifyApi.getRecognition(recordId)
      const candidates = r.recognition.candidates.map(function (c) {
        return { species_id: c.species_id, rank: c.rank, model_score: c.model_score, scoreText: c.model_score === null ? '无分数' : Math.round(c.model_score * 100) + '%' }
      })
      // 历史记录只展示服务端保存的模型原始候选；**不**据此推断任务状态（JobState 需要任务读面）。
      this.setData({ busy: false, recordId: r.recognition.id, recordRevision: r.recognition.revision,
        selectedSpeciesId: r.recognition.selected_species_id, candidates: candidates,
        candidatesTrusted: false, showTop3: r.recognition.candidates.length > 0, candidateSource: 'history',
        uncertaintyReasons: r.recognition.uncertainty_reasons,
        historyNote: '这是服务端保存的历史识别记录（第 ' + r.recognition.revision + ' 次修订）：候选为模型原始结果，请人工核对；本页不据此推断任务状态。',
        stateView: null,
        relatedKnowledge: r.recognition.selected_species_id === null ? null : queryRelatedKnowledge(r.recognition.selected_species_id) })
    } catch (error) {
      this.setData({ busy: false, errorText: identifyApi.messageFor(error) })
    }
  },

  onDeleteRecord: async function () {
    if (this.data.recordId === null || this.data.recordRevision < 1) return
    const that = this
    wx.showModal({
      title: '删除这条识别记录',
      content: '删除后无法恢复，关联的候选与选择一并移除。',
      success: async function (result) {
        if (!result.confirm) return
        try {
          await identifyApi.deleteRecognition(that.data.recordId, that.data.recordRevision)
          const items = readHistory().filter(function (item) { return item.recordId !== that.data.recordId })
          try { wx.setStorageSync(HISTORY_KEY, items) } catch (_) {}
          that.onRetry()
          that.setData({ history: items, errorText: '' })
        } catch (error) {
          that.setData({ errorText: identifyApi.messageFor(error) })
        }
      }
    })
  },

  onClearHistory: function () {
    try { wx.removeStorageSync(HISTORY_KEY) } catch (_) {}
    this.setData({ history: [] })
  }
})

function readHistory() {
  try {
    const value = wx.getStorageSync(HISTORY_KEY)
    if (Array.isArray(value)) return value.filter(function (item) { return item && typeof item.recordId === 'string' })
  } catch (_) {}
  return []
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

/** 关联科普查询：本地参考域查询组件（种子资料，明显标注「待核实·非权威」；不展示任何用量）。 */
function queryRelatedKnowledge(speciesId) {
  try {
    const reference = require('../../utils/reference')
    const result = reference.query({ species_id: speciesId, limit: 5 })
    const items = (result && result.items ? result.items : []).map(function (item) {
      return { recordId: item.record_id, registrationNumber: item.registration_number, name: item.registered_name,
        dosageForm: item.dosage_form, useScene: item.use_scene, labels: item.labels }
    })
    return {
      speciesId: speciesId,
      matchState: result.match_state,
      matchStateLabel: reference.matchStateLabel(result.match_state),
      reasons: result.reasons.concat(result.simulated_excluded > 0 ? ['已排除 ' + result.simulated_excluded + ' 条模拟资料'] : []),
      items: items,
      note: '资料为种子整理稿（' + reference.catalogVersionText() + '），须以官方登记信息核对；本页不提供用量。'
    }
  } catch (error) {
    return { speciesId: speciesId, matchState: 'unavailable', matchStateLabel: '查询未取得结果',
      reasons: ['关联科普查询未取得结果：' + (error && error.message ? error.message : '未知原因')], items: [], note: '未取得结果时不会用本地缓存顶替。' }
  }
}

function modeNoteFor(mode) {
  if (mode === 'real') return '服务端为 real 模式：照片经私有媒体链路处理，识别由真实提供者完成（当前真实提供者未接入时如实报不可用）。'
  if (mode === 'preset_demo') return '服务端为 preset_demo（预设演示）模式：结果明显标注为演示，不代表真实识别。'
  if (mode === 'stub') return '服务端为 stub（替身）模式：结果来自替身，仅供联调，不代表真实识别。'
  return '未取得服务端执行模式，识别结果状态未确认。'
}
