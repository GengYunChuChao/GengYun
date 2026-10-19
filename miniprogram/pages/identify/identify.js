// 识别页（GY-I09）：拍照/选图 → 私有媒体引用 → 创建识别任务 → 按 JobState 分七类呈现
// → Top3 候选 → 用户选择 → 关联科普查询 → 私有历史。
//
// GY-I10 标签 OCR（#10）本片追加：**标签识别**入口走与识草**同一套**私有媒体上传与**既有** OCR 路由
// （`POST /ocr` → `GET /jobs/{id}` 轮询七类 JobState → `GET /ocr/{id}` 读标签正文），
// **只读**展示原样文本 + 来源/状态标签；OCR 结果是**机器读数、不是权威判读**，且**永不展示任何用量数字**。
//
// 硬口径：
// - 门禁语义保留 page-gate（未登录/门禁拒绝时不动作、不伪造结果）；字号保留 font-scale。
// - 只有 succeeded 才算识别成功；uncertain 的候选必须经用户「人工核对」显式确认才允许记录选择，
//   failed / timed_out / cancelled 不显示任何候选、也不进入关联科普路径。
// - real 模式走契约私有上传链路；该链路不可用时**如实报不可用**，绝不用替身结果顶替。
// - stub / preset_demo 模式使用**明确标注的替身媒体引用**：照片不会上传，页面显著标注。
// - 失败一律按契约 `error.code` **如实归因**（含 OCR 域 503「未提供取消能力」与 404「作业不存在」的区分）。
const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const identifyApi = require('../../utils/identify-api')
// 标签正文读面（`GET /ocr/{id}`）的**既有**消费层（#10 + #16 已合并）：逐字段校验 + 原样文本/更正/核对
// 三分 + "不显示用量与配比"口径。本片**复用**它，不重造第二套 OCR 校验（避免两套口径漂移）。
const historyApi = require('../../utils/history-api')
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

/**
 * 识别图用途字节上限（契约 `MediaPurpose.weed_recognition` ≤2 MiB，见
 * `packages/media/constants.mjs` 的 `MEDIA_PURPOSE_MAX_BYTES`）。
 *
 * 这里是**上传前预检**：超限直接给可操作提示、**不发任何请求**。
 * 服务端仍会独立核验真实字节（客户端预检**不放宽**任何守卫，只是不做必然被拒的往返）。
 */
const RECOGNITION_MAX_BYTES = 2 * 1024 * 1024
const MIB = 1024 * 1024

/**
 * 标签图用途字节上限（契约 `MediaPurpose.label_ocr`，与识别图**同值** ≤2 MiB，见
 * `packages/media/constants.mjs` 的 `MEDIA_PURPOSE_MAX_BYTES`）。同样是**上传前预检**：
 * 超限直接给可操作提示、**不发任何请求**；服务端仍独立核验真实字节（不放宽任何守卫）。
 */
const OCR_MAX_BYTES = 2 * 1024 * 1024

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
      { key: 'ocr', iconClass: 'gy-icon--tag', title: '标签识别', desc: '拍农药包装读出标签文字（机器读数，非权威判读）', action: '拍照识别' },
      { key: 'text', iconClass: 'gy-icon--chat', title: '文字提问', desc: '打字提问入口尚未接入（本页此处不发起）', action: '尚未接入' }
    ],
    guest: true,
    busy: false,
    errorText: '',
    modeNote: '',
    substituteNotice: '',
    job: null,
    stateView: null,
    /**
     * 标签 OCR（#10）区块的展示状态；未发起过标签识别时为 `null`。
     * 与识别域字段**完全分开**：`state`/`stateTitle`/`stateDesc`/`tone`/`terminal`/`success`/`errorCode`
     * 逐项来自 `describeJobState`（七类）与契约 `Job.error_code`；`record` 是 `GET /ocr/{id}` 的只读视图。
     */
    ocr: null,
    /**
     * 人工校正面板（#10 AC①）：未打开时为 `null`；打开后**整对象重建**（不用 setData 路径写法，
     * 便于纯 JS 单测与替身 `setData` 直接断言）。
     *
     * 键：`open`／`submitting`／`revision`（If-Match 基准）／`fields`（三个可空文本）／
     * `ingredients`（成分行，逐行三项）／`errorText`（校验或提交失败）／`conflictText`
     * （`REVISION_CONFLICT` 后"已重读、请再确认"）／`successText`／`confirmed`（是否已显式核对包装）
     * ＋ `blockedNote`（ambiguous/conflict 的用量阻断说明）。
     */
    labelCorrection: null,
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
      recordId: null, recordRevision: 0, job: null, stateView: null, ocr: null, labelCorrection: null, historyNote: '', candidateSource: 'job',
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
    if (key === 'weed') { this.choosePhoto(); return }
    // GY-I10：标签识别入口已接入（走既有 `POST /ocr` + `GET /jobs/{id}` + `GET /ocr/{id}`）。
    if (key === 'ocr') { this.chooseOcrPhoto(); return }
    // 文字提问入口未接入：不指向语音页（该页无任何文字输入控件、也不接受查询参数），不新增跳转。
    wx.showToast({ title: '文字提问入口尚未接入；本页此处不发起', icon: 'none' })
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
    this.setData({ busy: true, errorText: '', substituteNotice: '', stateView: null, job: null, ocr: null, candidates: [], showTop3: false, uncertaintyReasons: [], recordId: null, recordRevision: 0, pendingManualId: null, selectedSpeciesId: null, relatedKnowledge: null })
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
        // 上传前尺寸预检：超限直接给可操作提示，**不发出** POST /media/uploads（服务端必拒）。
        if (info.size > RECOGNITION_MAX_BYTES) {
          this.setData({
            busy: false,
            errorText: '照片过大（' + (info.size / MIB).toFixed(1) + ' MiB）：识别图上限 ' + (RECOGNITION_MAX_BYTES / MIB) +
              ' MiB，请重新拍摄或压缩后再试；本条未上传任何照片。'
          })
          return
        }
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

  // -------------------------------------------------------------- 标签 OCR（#10）

  /** 标签识别入口的选图（与识草同一 `wx.chooseMedia` 口径：单张、相机/相册、压缩图）。 */
  chooseOcrPhoto: function () {
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
        that.prepareOcrMedia(file.tempFilePath)
      },
      fail: function () { that.setData({ errorText: '未选择照片，已取消。' }) }
    })
  },

  /**
   * 取得标签 OCR 任务的媒体引用并受理任务：
   * real ⇒ 走**与识草同一套**私有媒体上传（用途 `label_ocr`，契约既有成员）；
   * stub / preset_demo ⇒ 明确标注的替身媒体引用（照片不上传）。
   * 随后 `POST /ocr` 受理，成功后进入**与识草同一套**的轮询（间隔/上限/停止条件一致）。
   */
  prepareOcrMedia: async function (tempFilePath) {
    if (this.data.guest) return
    const gen = this.beginOperation()
    this.stopPoll()
    this.setData({ busy: true, errorText: '', substituteNotice: '', ocr: null, stateView: null, job: null, branch: null, branchInfo: null, candidates: [], showTop3: false, uncertaintyReasons: [], recordId: null, recordRevision: 0, pendingManualId: null, selectedSpeciesId: null, relatedKnowledge: null })
    let media
    try {
      const mode = await identifyApi.serverMode()
      if (!this.isCurrentOperation(gen)) return
      this.setData({ modeNote: modeNoteFor(mode, 'ocr') })
      if (mode === 'real') {
        const mime = mimeOfPath(tempFilePath)
        if (mime === null) { this.setData({ busy: false, errorText: '无法确定照片类型，请改用 JPG / PNG / WebP。' }); return }
        const info = await readFileInfo(tempFilePath)
        if (!this.isCurrentOperation(gen)) return
        // 上传前尺寸预检（与识草同一口径）：超限直接给可操作提示，**不发出** POST /media/uploads（服务端必拒）。
        if (info.size > OCR_MAX_BYTES) {
          this.setData({
            busy: false,
            errorText: '照片过大（' + (info.size / MIB).toFixed(1) + ' MiB）：标签图上限 ' + (OCR_MAX_BYTES / MIB) +
              ' MiB，请重新拍摄或压缩后再试；本条未上传任何照片。'
          })
          return
        }
        // 用途声明为契约既有成员 `label_ocr`（与识别图同限额：≤2 MiB、jpeg/png/webp）。
        media = await identifyApi.uploadPrivatePhoto(tempFilePath, { mime: mime, bytes: info.size, sha256: info.digest }, identifyApi.OCR_MEDIA_PURPOSE)
      } else {
        this.setData({ substituteNotice: '替身模式（' + mode + '）：照片不会上传，标签识别使用替身媒体引用，结果不代表真实识别。' })
        media = { mediaId: syntheticMediaId(), mediaRevision: 1 }
      }
      if (!this.isCurrentOperation(gen)) return
    } catch (error) {
      if (!this.isCurrentOperation(gen)) return
      // 本段失败发生在**媒体/模式**这一侧（读模式、读文件、私有媒体上传）⇒ 用**媒体站点**的
      // 措辞表（与识草同一句）：例如上传 503 指向"真实对象存储未接线"，**不得**说成 OCR 提供者。
      if (isGateLossError(error)) { this.closePrivate(identifyApi.messageFor(error)); return }
      this.setData({ busy: false, errorText: identifyApi.messageFor(error) })
      return
    }
    try {
      const created = await identifyApi.createOcr(media.mediaId, media.mediaRevision)
      if (!this.isCurrentOperation(gen)) return
      this.setData({ modeNote: modeNoteFor(created.mode, 'ocr') })
      this.applyOcrJob(created.job, gen)
      this.startOcrPoll(gen)
    } catch (error) {
      if (!this.isCurrentOperation(gen)) return
      if (isGateLossError(error)) { this.closePrivate(identifyApi.ocrMessageFor(error)); return }
      this.setData({ busy: false, errorText: identifyApi.ocrMessageFor(error) })
    }
  },

  /** 与识草 `startPoll` **同一口径**（1000 ms × 60 次、代次与对象双约束、上限即停并如实提示）。 */
  startOcrPoll: function (gen) {
    const that = this
    const generation = gen === undefined ? this._generation : gen
    this.stopPoll()
    let ticks = 0
    this._ocrPollTimer = setInterval(function () {
      ticks += 1
      if (!that.isCurrentOperation(generation) || !that.data.ocr || that.data.ocr.terminal === true) { that.stopPoll(); return }
      if (ticks > POLL_MAX_TICKS) {
        that.stopPoll()
        that.setData({ busy: false, errorText: '轮询已达上限，请重新查询任务状态。' })
        return
      }
      that.refreshOcrJob(generation)
    }, POLL_INTERVAL_MS)
  },

  refreshOcrJob: async function (gen) {
    if (!this.data.ocr || this.data.ocr.terminal === true) return
    const generation = gen === undefined ? this._generation : gen
    const jobId = this.data.ocr.jobId
    try {
      const r = await identifyApi.getOcrJob(jobId)
      if (!this.isCurrentOperation(generation)) return
      if (!this.data.ocr || this.data.ocr.jobId !== jobId) return
      await this.applyOcrJob(r.job, generation)
    } catch (error) {
      if (!this.isCurrentOperation(generation)) return
      this.stopPoll()
      if (isGateLossError(error)) { this.closePrivate(identifyApi.ocrMessageFor(error)); return }
      this.setData({ busy: false, errorText: identifyApi.ocrMessageFor(error) })
    }
  },

  /**
   * 由**已校验**的 OCR 任务决定标签识别区的展示：七类 JobState 逐类呈现（复用 `describeJobState`），
   * `error_code` 原样带出。**只有** succeeded 才去读标签正文；uncertain 的正文标注"不可信"后如实展示。
   */
  applyOcrJob: function (job, gen) {
    if (gen !== undefined && !this.isCurrentOperation(gen)) return undefined
    const view = identifyApi.describeJobState(job.state)
    const previous = this.data.ocr
    const patch = {
      busy: view.terminal !== true,
      ocr: {
        jobId: job.id,
        revision: job.revision,
        ocrId: job.target_ref.id,
        state: job.state,
        stateTitle: view.title,
        stateDesc: view.desc,
        tone: view.tone,
        terminal: view.terminal,
        success: view.success,
        errorCode: job.error_code,
        hasResult: job.hasResult === true,
        cancelled: job.state === 'cancelled',
        record: previous && previous.jobId === job.id ? previous.record : null,
        recordNote: '',
        cancelNote: ''
      }
    }
    if (view.terminal === true) this.stopPoll()
    this.setData(patch)
    if (view.terminal === true && job.hasResult === true) return this.loadOcrRecord(job, gen)
    return undefined
  },

  /** 读标签正文（`GET /ocr/{id}`，经既有 `history-api` 消费层逐字段校验）；读不到时**如实说明**，不顶替。 */
  loadOcrRecord: async function (job, gen) {
    const generation = gen === undefined ? this._generation : gen
    try {
      const r = await historyApi.getOcr(job.target_ref.id)
      if (!this.isCurrentOperation(generation)) return
      if (!this.data.ocr || this.data.ocr.jobId !== job.id) return
      this.setData({ ocr: Object.assign({}, this.data.ocr, { record: ocrResultView(r.ocr, job, r.mode), recordNote: '' }) })
    } catch (error) {
      if (!this.isCurrentOperation(generation)) return
      if (isGateLossError(error)) { this.closePrivate(identifyApi.ocrMessageFor(error)); return }
      // 任务已落定但正文读不到：如实说明"未取得正文"，**不用**任何缓存/替身正文顶替。
      this.setData({ ocr: Object.assign({}, this.data.ocr, { record: null, recordNote: '任务已落定，但未取得标签正文：' + identifyApi.ocrMessageFor(error) }) })
    }
  },

  /**
   * 取消标签 OCR 任务：走**既有**契约面 `POST /jobs/{id}/cancel`。
   * 本基线 OCR 域**没有**取消能力 ⇒ 服务端如实 503（`retryable`）；页面必须把它与
   * 「作业不存在（404）」区分开（专属文案见 `identify-api.ocrMessageFor(e, 'cancel')`），**不得**伪称已取消。
   */
  onCancelOcrJob: async function () {
    const ocr = this.data.ocr
    if (!ocr || ocr.terminal === true || this.data.busy !== true) return
    const gen = this._generation
    const jobId = ocr.jobId
    try {
      const r = await identifyApi.cancelOcrJob(jobId, ocr.revision)
      if (!this.isCurrentOperation(gen)) return
      if (!this.data.ocr || this.data.ocr.jobId !== jobId) return
      await this.applyOcrJob(r.job, gen)
    } catch (error) {
      if (!this.isCurrentOperation(gen)) return
      if (isGateLossError(error)) { this.closePrivate(identifyApi.ocrMessageFor(error)); return }
      this.setData({ ocr: Object.assign({}, this.data.ocr, { cancelNote: '未取消：' + identifyApi.ocrMessageFor(error, 'cancel') }) })
    }
  },

  /** 重新拍摄标签（只清空本区块并重开选图；不动识别域的任何状态）。 */
  onOcrRetry: function () {
    this.stopPoll()
    if (this.data.guest === true) return
    this.setData({ ocr: null, labelCorrection: null, errorText: '' })
    this.chooseOcrPhoto()
  },

  // ------------------------------------------------- 人工校正（#10 AC①）

  /**
   * 打开校正面板：草稿基线取**当前生效的** `corrected_fields`（未经校正时即机器读数）。
   *
   * 为什么草稿只预填"当前字段"而不是机器读数：用户要改的是**已生效**的那一份；把 raw 再填一遍
   * 会让第二次提交把第一次的人工更正**静默回退**成机器读数。
   */
  onStartCorrection: function () {
    const record = this.data.ocr && this.data.ocr.record
    if (!record || record.canCorrect !== true) return
    this.setData({
      labelCorrection: {
        open: true,
        submitting: false,
        revision: record.revision,
        fields: correctionFieldRows(record.fields),
        ingredients: correctionIngredientRows(record.fields),
        errorText: '',
        conflictText: '',
        successText: '',
        confirmed: record.needsExplicitReview !== true,
        blockedNote: record.needsExplicitReview === true ? record.doseBlockReason : ''
      }
    })
  },

  /** 单个可空文本输入：**原样**存草稿（不裁剪、不 trim；超长由提交前的统一校验拒绝）。 */
  onCorrectionFieldInput: function (event) {
    const lc = this.data.labelCorrection
    if (!lc) return
    const index = Number(event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.index : NaN)
    if (!Number.isInteger(index) || index < 0 || index >= lc.fields.length) return
    const value = event.detail && typeof event.detail.value === 'string' ? event.detail.value : ''
    const fields = lc.fields.slice()
    fields[index] = Object.assign({}, fields[index], { value: value })
    this.setData({ labelCorrection: Object.assign({}, lc, { fields: fields, errorText: '', successText: '' }) })
  },

  /** 成分行局部输入：`data-index` + `data-part`（name／content_text／unit_text）。 */
  onCorrectionIngredientInput: function (event) {
    const lc = this.data.labelCorrection
    if (!lc) return
    const dataset = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset : {}
    const index = Number(dataset.index)
    const part = dataset.part
    if (!Number.isInteger(index) || index < 0 || index >= lc.ingredients.length) return
    if (['name', 'content_text', 'unit_text'].indexOf(part) === -1) return
    const value = event.detail && typeof event.detail.value === 'string' ? event.detail.value : ''
    const ingredients = lc.ingredients.slice()
    const row = Object.assign({}, ingredients[index])
    row[part] = value
    ingredients[index] = row
    this.setData({ labelCorrection: Object.assign({}, lc, { ingredients: ingredients, errorText: '', successText: '' }) })
  },

  /** 增加一行成分：到契约 20 条上限即停（**不截断已填行**，只拒绝再加）。 */
  onCorrectionAddIngredient: function () {
    const lc = this.data.labelCorrection
    if (!lc || lc.ingredients.length >= identifyApi.LABEL_MAX_INGREDIENTS) return
    const ingredients = lc.ingredients.concat([{ name: '', content_text: '', unit_text: '' }])
    this.setData({ labelCorrection: Object.assign({}, lc, { ingredients: ingredients, errorText: '', successText: '' }) })
  },

  /** 删除一行成分（下标非合法整数一律忽略，不做隐式末行删除）。 */
  onCorrectionRemoveIngredient: function (event) {
    const lc = this.data.labelCorrection
    if (!lc) return
    const index = Number(event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.index : NaN)
    if (!Number.isInteger(index) || index < 0 || index >= lc.ingredients.length) return
    const ingredients = lc.ingredients.slice()
    ingredients.splice(index, 1)
    this.setData({ labelCorrection: Object.assign({}, lc, { ingredients: ingredients, errorText: '', successText: '' }) })
  },

  /**
   * 显式核对开关：`ambiguous` / `conflict`（含同名不同制剂这类"多条可能匹配"）下**必须**先勾选
   * 「我已对照包装核对」才允许提交 —— 不静默匹配、不替用户挑一条。`REVISION_CONFLICT` 重读后
   * 也会把 `confirmed` 置回 false 强制再确认。
   */
  onCorrectionToggleConfirm: function () {
    const lc = this.data.labelCorrection
    if (!lc) return
    this.setData({ labelCorrection: Object.assign({}, lc, { confirmed: lc.confirmed !== true, errorText: '' }) })
  },

  /** 关闭校正面板（不提交、不动已展示的记录）。 */
  onCorrectionCancel: function () {
    if (!this.data.labelCorrection) return
    this.setData({ labelCorrection: null })
  },

  /**
   * 提交人工校正：`PATCH /ocr/{id}/correction`（**恰好一次**，不重试）。
   *
   * 顺序是刻意的：
   *   1. 未显式核对 ⇒ 零请求，先让用户确认（ambiguous/conflict 的用量阻断说明同时在场）；
   *   2. `buildCorrectionInput` **发请求前**就做字段校验：超长/半空成分一律拒绝（不裁剪），
   *      因此非法输入**不会**产生任何 PATCH；
   *   3. 成功 ⇒ 用响应里的新记录重建 `ocr.record`（raw 与 corrected 同时呈现、差异标记随之更新）；
   *   4. `REVISION_CONFLICT` ⇒ 交给 `reloadAfterCorrectionConflict`（重读 + 请再确认，**不**自动重发）。
   */
  onCorrectionSubmit: async function () {
    const lc = this.data.labelCorrection
    const ocr = this.data.ocr
    if (!lc || lc.submitting === true || !ocr || !ocr.record) return
    if (lc.confirmed !== true) {
      this.setData({
        labelCorrection: Object.assign({}, lc, {
          errorText: '请先对照农药包装实物逐项核对，并勾选「我已对照包装核对」后再提交：本页不会替你静默匹配，也不会自动重发更正。'
        })
      })
      return
    }
    const draft = {
      registration_number: lc.fields[0].value,
      name: lc.fields[1].value,
      dosage_form: lc.fields[2].value,
      ingredients: lc.ingredients
    }
    let corrected
    try {
      corrected = identifyApi.buildCorrectionInput(draft)
    } catch (error) {
      this.setData({ labelCorrection: Object.assign({}, lc, { errorText: correctionMessageFor(error) }) })
      return
    }
    const gen = this._generation
    const ocrId = ocr.ocrId
    const revision = lc.revision
    this.setData({ labelCorrection: Object.assign({}, lc, { submitting: true, errorText: '', conflictText: '', successText: '' }) })
    let result
    try {
      result = await identifyApi.correctOcrLabel(ocrId, revision, corrected)
    } catch (error) {
      if (!this.isCurrentOperation(gen)) return
      if (isGateLossError(error)) { this.closePrivate(identifyApi.messageFor(error)); return }
      if (error.code === 'REVISION_CONFLICT' || error.code === 'REVISION_REQUIRED') {
        await this.reloadAfterCorrectionConflict(error)
        return
      }
      this.setData({
        labelCorrection: Object.assign({}, this.data.labelCorrection || lc, {
          submitting: false, errorText: '未提交更正：' + identifyApi.ocrMessageFor(error)
        })
      })
      return
    }
    if (!this.isCurrentOperation(gen)) return
    if (!this.data.ocr || this.data.ocr.ocrId !== ocrId) return
    const job = { state: this.data.ocr.state, error_code: this.data.ocr.errorCode }
    const record = ocrResultView(result.ocr, job, result.mode)
    this.setData({
      ocr: Object.assign({}, this.data.ocr, { record: record }),
      labelCorrection: Object.assign({}, this.data.labelCorrection || lc, {
        submitting: false,
        revision: record.revision,
        fields: correctionFieldRows(record.fields),
        ingredients: correctionIngredientRows(record.fields),
        successText: '已提交更正（记录版本 ' + record.revision + '）：机器原始读数原样保留，核对结论已按更正后的字段重算；仍以包装实物与官方登记为准，不代表识别准确。',
        blockedNote: record.needsExplicitReview === true ? record.doseBlockReason : ''
      })
    })
  },

  /**
   * `REVISION_CONFLICT` / `REVISION_REQUIRED` 的**唯一**处置：重新 `GET /ocr/{id}` 拿最新 revision，
   * 把草稿重置到最新字段，并请用户**再确认**。
   *
   * ⛔ 不静默重试：本方法只发一次 GET，绝不重发 PATCH。理由：重发会把用户"看着旧版本改出来的"
   * 更正悄悄写到新版本上，用户无法知道自己改的到底是哪一版；正确做法把新版本摆回界面再让用户确认。
   */
  reloadAfterCorrectionConflict: async function (error) {
    const ocr = this.data.ocr
    if (!ocr) return
    const ocrId = ocr.ocrId
    const gen = this._generation
    const because = error && error.code === 'REVISION_REQUIRED'
      ? '提交缺少版本信息'
      : '记录已被更新（可能由其他客户端更正过）'
    try {
      const fresh = await historyApi.getOcr(ocrId)
      if (!this.isCurrentOperation(gen)) return
      if (!this.data.ocr || this.data.ocr.ocrId !== ocrId) return
      const job = { state: this.data.ocr.state, error_code: this.data.ocr.errorCode }
      const record = ocrResultView(fresh.ocr, job, fresh.mode)
      this.setData({
        ocr: Object.assign({}, this.data.ocr, { record: record }),
        labelCorrection: {
          open: true,
          submitting: false,
          revision: record.revision,
          fields: correctionFieldRows(record.fields),
          ingredients: correctionIngredientRows(record.fields),
          errorText: '',
          conflictText: because + '：已重新读取最新内容（记录版本 ' + record.revision + '），请逐项重新核对后再确认提交；本页不会自动重发更正。',
          successText: '',
          confirmed: false,
          blockedNote: record.needsExplicitReview === true ? record.doseBlockReason : ''
        }
      })
    } catch (reloadError) {
      if (!this.isCurrentOperation(gen)) return
      if (isGateLossError(reloadError)) { this.closePrivate(identifyApi.messageFor(reloadError)); return }
      this.setData({
        labelCorrection: Object.assign({}, this.data.labelCorrection || {}, {
          submitting: false,
          errorText: because + '；且未能重新读取最新内容：' + identifyApi.ocrMessageFor(reloadError) + '。本页不会自动重发更正。'
        })
      })
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
    if (this._ocrPollTimer) { clearInterval(this._ocrPollTimer); this._ocrPollTimer = null }
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
    this.setData({ job: null, stateView: null, ocr: null, branch: null, branchInfo: null, doseGuard: null, candidates: [], showTop3: false, uncertaintyReasons: [], errorText: '', substituteNotice: '', selectedSpeciesId: null, relatedKnowledge: null, pendingManualId: null, recordId: null, recordRevision: 0, busy: false, historyNote: '', candidateSource: 'job' })
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

  /**
   * 关联科普条目 → 资料详情（GY-I07 页面）。
   *
   * id 口径与 `pages/referencedetail/referencedetail.js` 的 `detailId`（该文件里同名函数的**定义处**）校验一致
   * （`[A-Za-z0-9_-]{1,128}`；条目 id 取自参考域 `record_id`）；
   * 形状不符即**不跳转**（不把任意字符串拼进查询串），跳法与 `pages/reference/reference.js` 里 `goDetail`
   * 方法的**定义处**相同。此处不写死任何行号：目标文件在本片内自身即有改动，裸行号必然随下次编辑
   * 漂移，定位一律按上述符号名检索；
   * 本页不在跳转处做任何权限判定：详情页自己走门禁与档案核对（档案未确认时仍不给用量）。
   */
  onOpenKnowledgeDetail: function (event) {
    const recordId = event && event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.id : null
    if (typeof recordId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(recordId)) return
    wx.navigateTo({ url: '/pages/referencedetail/referencedetail?id=' + encodeURIComponent(recordId) })
  },

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
 * 识别对象（`species_id`）→ 可用的**名称文本**：只取目录里的品种**组名**。
 *
 * 为什么按名称查（而不是结构化 `species_id`）：
 *   本地资料层 `reference.query` 对 `species_id` 的结构化判定是「记录未结构化标注杂草对象，
 *   无法按所选杂草确认」（`utils/reference.js:218`）⇒ 本地记录**永远不可能**按 `species_id` 命中，
 *   该字段只能如实反映"本地没有这层标注"，不能作为查询条件。名称文本匹配（`keyword`）才是
 *   本地真实存在的关联依据（`utils/reference.js:228-231`，命中面含防治对象 `target_original`）。
 *   这里**只取组名**（不并入学名/别名）：不扩大匹配面，页面如实标注本次口径。
 */
function speciesNameText(speciesId) {
  if (typeof speciesId !== 'string' || speciesId === '') return ''
  try {
    const reference = require('../../utils/reference')
    const entry = (reference.species || []).filter(function (s) { return s && s.id === speciesId })[0]
    return entry && typeof entry.group_name === 'string' ? entry.group_name : ''
  } catch (error) {
    return ''
  }
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
 *      **逐条归因必须与页面同一口径**（"识别/选择路径恒不给用量"），不得写成
 *      "功能开关已关闭"——那是开关级原因，会被误读为本路径"本可给用量"；
 *   4. 规则版本与 GY-I08 一致（`APPLICABILITY_RULE_VERSION`），不一致由回归测试拦住。
 *
 * 查询口径（如实化）：按**识别对象名称文本**查（`keyword`），因为本地资料未结构化标注杂草对象；
 * 本函数返回的 `matchNote` 必须原样呈现给用户。
 *
 * 取不到名称文本时（所选对象不在本地杂草目录，例如 stub 替身候选 `synthetic_weed_a/b/c`）
 * **不得**下发"无条件查询"：本地层的"无条件"语义是**全量命中**（`match_state='matched'`），
 * 会被页面渲染成"已找到符合条件的资料"＋若干与该对象无关的资料（假关联 / 错误指导）。
 * 该分支 fail-closed：`items: []`、`matchState: 'unavailable'`（沿用既有语义，不新造状态）。
 *
 * 资料条目为种子整理稿，呈现时必须标注「待核实 · 非权威」。
 */
function queryRelatedKnowledge(speciesId, conditions) {
  const guard = identifyApi.dosePathGuard(conditions)
  const speciesName = speciesNameText(speciesId)
  const base = {
    speciesId: speciesId,
    speciesName: speciesName,
    ruleVersion: guard.ruleVersion,
    dose: guard,
    conditionsComplete: guard.conditionsComplete,
    missingConditions: guard.missingConditions,
    missingConditionLabels: guard.missingConditionLabels
  }
  // 取不到名称文本 ⇒ 本次**没有任何匹配依据**：不下发查询，如实说明（不是"查询未取得结果"）。
  if (speciesName === '') {
    return Object.assign({}, base, {
      matchState: 'unavailable',
      matchStateLabel: '本次未进行资料匹配',
      matchSpeciesName: '',
      matchNote: '所选对象不在本地杂草目录，未取得名称文本 ⇒ 本次不进行资料匹配。',
      reasons: ['所选对象不在本地杂草目录，未取得可用的名称文本；本地资料未结构化标注杂草对象，本次不展示任何资料。'],
      items: [],
      note: '未取得名称文本时不下发"无条件查询"（那会变成全量命中），也不会给出任何用量。'
    })
  }
  try {
    const reference = require('../../utils/reference')
    // 结构化 `species_id` **不进**参考域查询：本地层无该标注，带上它只会让每条记录
    // 都落"未结构化标注杂草对象"⇒ 恒 0 条（且不能靠放宽 eligibility 来"有结果"）。
    const queryParams = { limit: 5 }
    queryParams.keyword = speciesName
    // 只把**非空**条件交给查询：空串不得被当成"已采集"（与域库 matchConditions 同口径）。
    for (const field of identifyApi.DOSE_CONDITION_FIELDS) {
      if (field === 'species_id') continue
      const value = conditions && typeof conditions[field] === 'string' ? conditions[field].trim() : ''
      if (value !== '') queryParams[field] = value
    }
    const result = reference.query(queryParams)
    const items = (result && result.items ? result.items : []).map(function (item) {
      // 逐条跑 GY-I08 用量描述符：**只用于如实说明为什么不能给用量**，
      // 其结果不会被本页用来渲染任何剂量数字。
      // 注意：描述符的 `reason` 是**开关级**原因（"用量卡片已关闭（功能开关）"），
      // 与页面口径（本路径恒不给用量）不同源 ⇒ 页面不渲染它（见 identify.wxml 的用量行）。
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
        // 页面口径的归因（与顶部用量守卫同一句），不再逐条引用开关原因。
        doseReason: '识别/选择路径恒不给用量',
        doseBlockCode: identifyApi.DOSE_PATH_BLOCK_CODE,
        doseRuleVersion: descriptor.rule_version
      }
    })
    return Object.assign({}, base, {
      matchState: result.match_state,
      matchStateLabel: reference.matchStateLabel(result.match_state),
      matchSpeciesName: speciesName,
      // 如实标注本次查询口径（本地资料没有杂草对象的结构化标注）。
      matchNote: speciesName === ''
        ? '本地资料未结构化标注杂草对象：未取得所选对象的名称文本，本次未按名称文本匹配。'
        : '本地资料未结构化标注杂草对象，本次按名称文本匹配（品种组名「' + speciesName + '」）。',
      reasons: result.reasons.concat(result.simulated_excluded > 0 ? ['已排除 ' + result.simulated_excluded + ' 条模拟资料'] : []),
      items: items,
      note: '资料为种子整理稿（' + reference.catalogVersionText() + '），须以官方登记信息核对；本页不提供用量（识别路径恒不可给用量）。'
    })
  } catch (error) {
    return Object.assign({}, base, {
      matchState: 'unavailable',
      matchStateLabel: '查询未取得结果',
      matchSpeciesName: speciesName,
      // F3：本分支在**无名称文本**时也可能被触达（名称非空但条件非法等），
      // 措辞不得声称"按名称文本匹配未能完成"。
      matchNote: speciesName === ''
        ? '所选对象不在本地杂草目录，未取得名称文本 ⇒ 本次未进行名称文本匹配。'
        : '本地资料未结构化标注杂草对象；本次按名称文本匹配未能完成。',
      reasons: ['关联科普查询未取得结果：' + (error && error.message ? error.message : '未知原因')],
      items: [],
      note: '未取得结果时不会用本地缓存顶替，也不会给出任何用量。'
    })
  }
}

/**
 * 标签 OCR（#10）的**只读**结果视图：原样文本 + 来源/状态标签。
 *
 * 硬口径（与 `utils/history-api.js` 的 `ocrDetailView` 同一口径，不另造一套）：
 *   1. **原样文本**：`raw_fields` 逐字段照录（缺项如实写"（未读出）"，不补造、不改写、不做任何换算）；
 *   2. **来源/状态标签**：`model_version`（来源版本）+ `revision` + 契约 `Job.state`/`error_code`
 *      + 核对 `verification.match_state` / `has_registration` / `conflict_fields` / `missing_fields`；
 *   3. **不是权威判读**：页面必须显著标注（机器读数，须与包装实物核对；登记信息以官方登记为准）；
 *   4. **不得出现任何剂量数字**：`verification.dose_cards` **只计条数**、绝不渲染正文
 *      （沿用 `history-api.js:385` 的 `doseSafetyNote` 口径）；
 *   5. **只读**：本页不提供编辑标签文本、也不提交人工核对（能力未接入，**不发明**编辑动作）。
 */
function ocrResultView(ocr, job, mode) {
  const detail = historyApi.ocrDetailView(ocr)
  const rows = function (fields) {
    return [
      { label: '登记证号', value: fields.registration_number === null ? '（未读出）' : fields.registration_number },
      { label: '药名', value: fields.name === null ? '（未读出）' : fields.name },
      { label: '剂型', value: fields.dosage_form === null ? '（未读出）' : fields.dosage_form },
      { label: '有效成分', value: fields.ingredients.length === 0 ? '（未读出）' : fields.ingredients.join('；') }
    ]
  }
  const rawRows = rows(detail.raw)
  const correctedRows = rows(detail.corrected)
  /*
   * 逐字段对照：**机器原样**与**人工更正**并排，`changed` 标出被改过的字段。
   * 两者恒同时给出（不是"有更正才显示"），否则用户无法判断"哪一格还是机器读数"。
   */
  const diffRows = rawRows.map(function (row, index) {
    const fixed = correctedRows[index]
    return { label: row.label, raw: row.value, corrected: fixed.value, changed: row.value !== fixed.value }
  })
  // 可编辑副本取自**已生效**的 corrected_fields（结构化四字段，不是拼接后的展示文本）。
  const current = ocr.corrected_fields
  const fields = {
    registration_number: current.registration_number,
    name: current.name,
    dosage_form: current.dosage_form,
    ingredients: current.ingredients.map(function (item) {
      return { name: item.name, content_text: item.content_text, unit_text: item.unit_text }
    })
  }
  // `ambiguous`（含同名不同制剂这类"多条可能匹配"）/ `conflict` ⇒ 用量展示阻断 + 必须显式核对。
  const explicit = detail.verification.matchState === 'ambiguous' || detail.verification.matchState === 'conflict'
  return {
    readRows: rawRows,
    correctedRows: correctedRows,
    diffRows: diffRows,
    correctedDiffers: detail.correctedDiffers,
    fields: fields,
    // 只有 succeeded / uncertain 才可能带着正文 ⇒ 也只有这两类允许提交更正。
    canCorrect: job.state === 'succeeded' || job.state === 'uncertain',
    needsExplicitReview: explicit,
    matchState: detail.verification.matchState,
    matchLabel: detail.verification.matchLabel,
    hasRegistration: detail.verification.hasRegistration,
    conflictFields: detail.verification.conflictFields,
    // 同一组冲突字段的中文标签（`source.validity` 这类 token 不能直接给用户看）。
    conflictLabels: detail.verification.conflictLabels,
    missingFields: detail.verification.missingFields,
    // 用药安全：只给"存在 N 条用量卡"的**条数**，正文一律不渲染（该数字不是剂量值）。
    doseCardCount: detail.verification.doseCardCount,
    sourceVersion: detail.sourceVersion,
    revision: detail.revision,
    jobState: job.state,
    jobErrorCode: job.error_code,
    mode: mode,
    // 如实标注：机器读数、非权威判读（与页面顶部 pill 同一句）。
    authorityNote: '标签识别是机器读数，不是权威判读：请与农药包装实物逐项核对；登记信息以官方登记为准。',
    // 用量**恒**不展示；ambiguous/conflict 额外说明"已阻断 + 需显式确认"（不静默取一条）。
    doseBlocked: true,
    doseBlockReason: explicit
      ? '登记核对为「' + detail.verification.matchLabel +
        '」：用量展示已阻断（同名不同制剂/多条可能匹配一律不静默取一条；登记记录已失效或被拒绝核对时也不作为核对通过），' +
        '请先对照包装实物逐项确认字段。' + detail.doseSafetyNote
      : detail.doseSafetyNote,
    // 只读的边界说清楚：raw_fields 不接受编辑，可写面只有 corrected_fields。
    readOnlyNote: '机器原始读数（raw_fields）只读：本页不提供编辑原始读数的动作，它原样保留以便复核；' +
      '人工更正只写入 corrected_fields，且校正不计入模型准确率。',
    correctionNote: '可人工核对并更正字段：提交只写 corrected_fields，机器原始读数不被改写；' +
      '更正后仍是机器读数与人工输入的混合，不代表识别准确，也不构成本页面给出的用药依据。',
    // 用量口径取自既有 `history-api`（不显示用量与配比），本条不含任何剂量数字。
    doseNote: detail.doseSafetyNote
  }
}

/** 校正面板的三个可空文本行（顺序即 `onCorrectionSubmit` 取草稿的顺序）。 */
function correctionFieldRows(fields) {
  return [
    { key: 'registration_number', label: '登记证号', value: fields.registration_number === null ? '' : fields.registration_number, maxLength: identifyApi.LABEL_TEXT_MAX },
    { key: 'name', label: '药名', value: fields.name === null ? '' : fields.name, maxLength: identifyApi.LABEL_TEXT_MAX },
    { key: 'dosage_form', label: '剂型', value: fields.dosage_form === null ? '' : fields.dosage_form, maxLength: identifyApi.LABEL_TEXT_MAX }
  ]
}

/** 校正面板的成分行（每行三项；空白行由用户在界面上删掉或留空——留空行在提交时被丢弃）。 */
function correctionIngredientRows(fields) {
  return fields.ingredients.map(function (item) {
    return { name: item.name, content_text: item.content_text, unit_text: item.unit_text }
  })
}

/** 校正输入被拒时的人话：指出**哪一格**、为什么（超长给出实际长度，绝不悄悄截断）。 */
function correctionMessageFor(error) {
  const field = error && typeof error.field === 'string' ? error.field : ''
  const reason = error && error.reason
  const at = function (name) { return field === name ? '（' + field + '）' : '' }
  if (reason === 'TOO_LONG') {
    return '有字段超长（上限 ' + identifyApi.LABEL_TEXT_MAX + ' 字' +
      (typeof error.length === 'number' ? '，当前 ' + error.length + ' 字' : '') +
      '）：' + (field || '未知字段') + '。请自行删减到上限内，本页不会替你截断后提交。'
  }
  if (reason === 'EMPTY') {
    return '有效成分第 ' + (Number(error.index) + 1) + ' 行的「' + (error.part || '') + '」为空：' +
      '请补齐这一行的三项，或先把该行删掉再提交（本页不补造缺失内容）。'
  }
  if (reason === 'TOO_MANY') {
    return '有效成分超过 ' + identifyApi.LABEL_MAX_INGREDIENTS + ' 条上限（当前 ' +
      (typeof error.length === 'number' ? error.length : '未知') + ' 条）：请自行合并或删减，本页不会截断后提交。'
  }
  if (reason === 'NOT_ARRAY' || reason === 'NOT_OBJECT' || reason === 'NOT_TEXT') {
    return '更正内容格式不合法' + at(field) + '：已停止提交，未发出任何请求。'
  }
  return '更正内容未通过本地校验' + (field ? '（' + field + '）' : '') + '：已停止提交，未发出任何请求。'
}

function modeNoteFor(mode, kind) {
  const noun = kind === 'ocr' ? '标签识别' : '识别'
  if (mode === 'real') return '服务端为 real 模式：照片经私有媒体链路处理，' + noun + '由真实提供者完成（当前真实提供者未接入时如实报不可用）。'
  if (mode === 'preset_demo') return '服务端为 preset_demo（预设演示）模式：结果明显标注为演示，不代表真实' + noun + '。'
  if (mode === 'stub') return '服务端为 stub（替身）模式：结果来自替身，仅供联调，不代表真实' + noun + '。'
  return '未取得服务端执行模式，' + noun + '结果状态未确认。'
}
