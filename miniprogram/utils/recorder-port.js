// GY-I11 **生产录音端口**：`wx.getRecorderManager` 的唯一出现处（原生小程序侧）。
//
// 为什么单独一个文件（与 `utils/inner-audio-port.js` 同一模式）：
//   (a) 页面只依赖**注入/可替换的端口**，因此录音生命周期可以在 Node 里用探针录音器单测
//       （不需要真机、不采集任何真实音频）；
//   (b) 平台能力只在这一个文件里被引用，便于审查「谁真的碰了麦克风」。
//
// 契约依据（packages/contracts/openapi.json 1.0.0 · UploadInput.duration_ms）：
//   单次录音最长 **60 秒**（`duration_ms.maximum = 60000`），与
//   `packages/media/constants.mjs` 的 `MEDIA_MAX_DURATION_MS` 同值；
//   用途限额（≤10 MiB / mp3·wav·aac）见 `packages/media/README.md` 的每用途限额表。
//
// 诚实边界（如实登记，不做任何真实能力声称）：
// - 本文件**不产生**任何音频、不上传任何字节、不猜测音频内容；它只把平台录音器的事件/错误
//   转成页面认识的语义。
// - 基础库缺能力（非小程序环境 / 无 `wx.getRecorderManager`）⇒ `support().ok === false`，
//   `start()` 一律返回 `{ ok:false, code:'RECORDER_UNAVAILABLE' }`，**绝不**假装在录。
// - 用户拒绝授权、录音失败、录音中断都**原样透传**平台错误文案（`RECORD_AUTH_DENIED` /
//   `RECORD_FAILED` / `RECORD_INTERRUPTED`），由页面如实呈现；本文件不自己编结论、不重试。
// - **所有失败都 resolve**（不 reject）成 `{ ok:false, code, errMsg }`：`start()` 是同步返回、
//   由 `onError` 异步报错的，两种失败必须同形，否则调用方容易在某一支里漏掉如实提示。
// - **录音容器**：默认 `wav` —— 转写档位**只收 WAV**（见下方 `RECORD_FORMAT` 的依据）。端口只
//   **如实回传**平台给的 `format`（`productOf`）：平台若回了别的容器，端口照实报出、**不谎报成
//   wav**；"拿到非 WAV 就不上传"是**页面**的收尾校验（`pages/voice/voice.js` 的 `stopAndUpload`），
//   端口不替它决定、也不裁剪/转码。
// - 真机录音权限弹窗与真实音频证据属 issue #23，本文件不构成任何真机验收。
'use strict'

/** 契约上限：单次录音最长 60 秒（UploadInput.duration_ms.maximum）。 */
const MAX_DURATION_MS = 60000

/**
 * 录音采样率 / 声道 / 容器：**逐项取自冻结的 ASR 档位**，本文件不另立一套数值。
 *
 * 事实源：`services/api/src/ai/asr-live-adapter.ts` 的 `LIVE_ASR_FROZEN_PROFILE`
 * （`voiceFormat: 'wav'`、`sampleRate: 16000`、`channels: 1`）＋ `tools/ai-config.mjs` 的 asr 剖面
 * 校验（`voiceFormat==='wav' && sampleRate===16000 && channels===1`），以及同一份档位的 WAV 头要求
 * （PCM / 单声道 / 16000Hz / **字节率 32000** / 块对齐 2 / 16bit，见 `requireLiveAsrWav()`）。
 * ⇒ 录 WAV 时码率不是"另设一个参数"：16kHz × 单声道 × 16bit 就等于 **32000 字节/秒**，
 *   与上面的校验同值；因此 WAV 会话**不传** `encodeBitRate`（见 `COMPRESSED_ENCODE_BIT_RATE`）。
 */
const SAMPLE_RATE = 16000

const NUMBER_OF_CHANNELS = 1

/** 录音容器：ASR 档位只有 WAV 一种载体（`LIVE_ASR_FROZEN_PROFILE.voiceFormat`）。 */
const RECORD_FORMAT = 'wav'

/**
 * 编码格式 → 契约 `UploadInput.mime`。
 *
 * `aac` 在小程序侧落地的容器是 m4a/ISO-BMFF，服务端按魔数识别为 `audio/aac`
 * （`packages/media/detect.mjs` 的 ISO BMFF 分支）⇒ 声明 `audio/aac` 与真实编码一致。
 * 这里**只**返回契约枚举内的值：不在枚举内的取值一律返回 `null`（由调用方如实拒绝上传）。
 */
const FORMAT_MIME = Object.freeze({
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  'audio/mpeg': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/aac': 'audio/aac'
})

/** 契约允许的音频用途编码（与 `MEDIA_PURPOSE_MIME.voice_question` 同集）。 */
const ALLOWED_FORMATS = Object.freeze(['mp3', 'wav', 'aac'])

/** 录音相关的如实错误码（页面按码取文案，不在此处编用户话术）。 */
const CODES = Object.freeze({
  UNAVAILABLE: 'RECORDER_UNAVAILABLE',
  AUTH_DENIED: 'RECORD_AUTH_DENIED',
  DENIED: 'RECORD_PERMISSION_DENIED',
  FAILED: 'RECORD_FAILED',
  INTERRUPTED: 'RECORD_INTERRUPTED',
  NOT_RECORDING: 'RECORD_NOT_STARTED',
  BUSY: 'RECORD_ALREADY_RUNNING',
  INVALID_INPUT: 'INVALID_INPUT'
})

/** 默认录音选项：严格由契约上限与冻结 ASR 档位推导，页面不得放宽。 */
const DEFAULT_OPTIONS = Object.freeze({
  duration: MAX_DURATION_MS,
  sampleRate: SAMPLE_RATE,
  numberOfChannels: NUMBER_OF_CHANNELS,
  format: RECORD_FORMAT
})

/**
 * 压缩编码（mp3/aac）的码率参数：**只**对压缩编码有意义。
 *
 * WAV 是未压缩 PCM：实际字节率被 `sampleRate × numberOfChannels × 16bit` 钉死为 32000 B/s，
 * 传 `encodeBitRate` 既改不了产物，又会让人误以为档位另有一套"码率"口径 ⇒ WAV 会话一律不传。
 * （平台是否对 WAV 忽略该参数属**外部文档、本仓未实测**，登记在证据页的"未取得"里。）
 */
const COMPRESSED_ENCODE_BIT_RATE = 48000

/**
 * 失败出参：**一律 resolve**（不 reject），页面与内部兑现器只需传递同一种形状。
 *
 * 为什么不让端口 reject：`wx.getRecorderManager().start()` 是同步返回、由 `onError` 异步报错的，
 * 「同步抛错」与「回调报错」必须给出**同一种**出参形状，否则调用方要为同一类失败写两套分支，
 * 很容易在其中一套里漏掉如实提示（那就会变成"静默失败"）。
 */
function failure(code, errMsg) {
  const out = { ok: false, code: code }
  if (typeof errMsg === 'string' && errMsg !== '') out.errMsg = errMsg
  return out
}

/** 编码格式 → 契约 mime；不在契约枚举内返回 null（不发明类型）。 */
function mimeForFormat(format) {
  const mime = FORMAT_MIME[format]
  return typeof mime === 'string' ? mime : null
}

/** 平台是否提供录音能力（在 Node/测试环境里恒为 false）。 */
function platformSupported() {
  return typeof wx !== 'undefined' && wx !== null && typeof wx.getRecorderManager === 'function'
}

/**
 * 录音授权状态（**只读取，不发起任何录音**）。
 *
 * `wx.getSetting` 不可用或读不到 `scope.record` ⇒ `unknown`（**不**当作已授权、也**不**当作拒绝），
 * 由 `start()` 按平台真实返回归因。
 *
 * @returns {Promise<{ state:'granted'|'denied'|'unknown'|'unsupported' }>}
 */
function permissionState() {
  if (!platformSupported()) return Promise.resolve({ state: 'unsupported' })
  return new Promise(function (resolve) {
    try {
      wx.getSetting({
        success: function (res) {
          const setting = res && res.authSetting
          const value = setting ? setting['scope.record'] : undefined
          if (value === true) { resolve({ state: 'granted' }); return }
          if (value === false) { resolve({ state: 'denied' }); return }
          resolve({ state: 'unknown' })
        },
        fail: function () { resolve({ state: 'unknown' }) }
      })
    } catch (error) {
      resolve({ state: 'unknown' })
    }
  })
}

/** 能力自述：可供页面如实渲染「能不能录」这一态，不触发任何授权弹窗。 */
function support() {
  const ok = platformSupported()
  return {
    ok: ok,
    code: ok ? null : CODES.UNAVAILABLE,
    maxDurationMs: MAX_DURATION_MS,
    formats: ALLOWED_FORMATS.slice(),
    note: ok
      ? '录音端口可用（wx.getRecorderManager）：录音一律需要用户授权，拒绝即如实提示，不假装在录。'
      : '当前环境不提供录音能力（没有 wx.getRecorderManager）：不会采集、不会上传，也不假装在录。'
  }
}

/** 授权被拒的判定：平台各不相同，这里只认**明确**的拒绝语义。 */
function isAuthDenial(errMsg) {
  const text = typeof errMsg === 'string' ? errMsg.toLowerCase() : ''
  return text.indexOf('auth') !== -1 || text.indexOf('authorize') !== -1 ||
    text.indexOf('permission') !== -1 || text.indexOf('deny') !== -1 || text.indexOf('denied') !== -1
}

/** 录音中断（来电/抢占/系统回收）：如实透传，不当作正常停止、不给时长。 */
function isInterruption(errMsg) {
  const text = typeof errMsg === 'string' ? errMsg.toLowerCase() : ''
  return text.indexOf('interrupt') !== -1 || text.indexOf('background') !== -1
}

/**
 * 建生产录音端口。
 *
 * 生命周期（页面只经此接口操作麦克风，**不直接**引用任何平台录音 API）：
 *   `start()` → `stop()`（拿产物 → 交给上传链路）｜`cancel()`（丢弃产物）｜`release()`（离页释放）
 * 任一时刻只有一个在途会话；`start()` 在录制中返回 `RECORD_ALREADY_RUNNING`，
 * `stop()`/`cancel()` 在未录制时返回 `RECORD_NOT_STARTED`（**幂等安全**，不抛异常）。
 *
 * @returns {{
 *   kind: 'recorder'|'unavailable',
 *   note: string,
 *   available: boolean,
 *   maxDurationMs: number,
 *   start(options?: object): Promise<{ ok:true, maxDurationMs:number }|{ ok:false, code:string, errMsg?:string }>,
 *   stop(): Promise<{ ok:true, tempFilePath:string, durationMs:number, format:string, mime:string }|{ ok:false, code:string, errMsg?:string }>,
 *   cancel(): Promise<{ ok:boolean, code?: string }>,
 *   release(): void,
 *   isRecording(): boolean
 * }}
 */
function createRecorderPort() {
  const supported = platformSupported()
  let manager = null
  let bound = false

  let recording = false
  let released = false
  /**
   * 在途 `start()` 的兑现器：**兑现即清空**（见 `finish`）。
   *
   * 为什么必须清空：平台会在**达到 `duration` 上限时自行 `onStop`**（不经调用方 `stop()`）。
   * 若 `start()` 兑现后槽位仍留着那个已兑现的兑现器，平台的自动停止就会落进一个**空操作**
   * ⇒ 产物（tempFilePath/duration/format）被静默吞掉，页面随后只能拿到 `RECORD_NOT_STARTED`
   * （界面上表现为"当前没有正在进行的录音"，而实际已录满上限）。
   */
  let pendingStart = null
  /** 在途 `stop()` 的兑现器：**只在 `stop()` 等待平台落定期间存在**。 */
  let pendingStop = null
  /**
   * 平台已产出、但调用方尚未取走的**产物或错误**。
   *
   * 平台**自行**停止（录满时长上限／系统回收）或自行报错时没有在途 `stop()` 可交付
   * ⇒ 结果落进本槽，由**下一次 `stop()` 如实交出**；**绝不丢弃**。
   */
  let lastProduct = null
  /** 本次会话请求的时长上限（`start()` 兑现时如实回填）。 */
  let requestedDuration = MAX_DURATION_MS
  /** `cancel()` 之后的下一次平台结果一律丢弃（用户已取消，产物不得再交给任何调用方）。 */
  let discardNext = false

  function managerOf() {
    if (!supported || released) return null
    if (manager === null) {
      try { manager = wx.getRecorderManager() } catch (error) { manager = null }
    }
    return manager
  }

  /**
   * 平台事件 → 统一分发（在途 `stop()` 优先；否则存产物槽；`start()` 在途则一并如实兑现）。
   *
   * @param {object} out 统一出参：`{ ok:true, tempFilePath, durationMs, format, mime }` 或 `{ ok:false, code, errMsg }`
   * @param {boolean} isProduct 结果是否为**产物**（true）而非错误（false）
   */
  function deliver(out, isProduct) {
    const startDone = pendingStart
    pendingStart = null
    const stopDone = pendingStop
    pendingStop = null
    if (discardNext === true) {
      // `cancel()` 已声明丢弃：结果不得交给任何人，也不得留槽。
      discardNext = false
      lastProduct = null
      if (startDone !== null) startDone(failure(CODES.FAILED, '录音已取消'))
      if (stopDone !== null) stopDone(failure(CODES.FAILED, '录音已取消'))
      return
    }
    // `start()` 若仍在途（极快停止／立刻报错）：录音确实开始过 ⇒ 产物按 `ok:true` 兑现，错误如实兑现。
    const startOutcome = isProduct === true ? { ok: true, maxDurationMs: requestedDuration } : out
    if (stopDone === null) {
      // 平台**自行**停止／报错：没有在途 `stop()` ⇒ 存槽，由下一次 `stop()` 如实交出。
      lastProduct = out
      if (startDone !== null) startDone(startOutcome)
      return
    }
    if (startDone !== null) startDone(startOutcome)
    stopDone(out)
  }

  /** 把平台 `onStop` 的回传解析成统一产物出参（三要素缺一不可 ⇒ 如实失败，绝不编造）。 */
  function productOf(res) {
    const tempFilePath = res && typeof res.tempFilePath === 'string' ? res.tempFilePath : ''
    const durationMs = res && Number.isFinite(res.duration) ? Math.round(res.duration) : NaN
    const format = res && typeof res.format === 'string' ? res.format : ''
    const mime = mimeForFormat(format)
    if (tempFilePath === '') return failure(CODES.FAILED, '录音未返回文件')
    if (!Number.isFinite(durationMs) || durationMs < 1) return failure(CODES.FAILED, '录音未返回有效时长')
    if (mime === null) return failure(CODES.FAILED, '录音编码不在契约允许范围（mp3/wav/aac）')
    return { ok: true, tempFilePath: tempFilePath, durationMs: durationMs, format: format, mime: mime }
  }

  /** 只绑定一次：平台录音器是单例，重复 `onXxx` 会覆盖监听。 */
  function bindOnce(instance) {
    if (bound || instance === null) return
    bound = true

    const onStop = function (res) {
      recording = false
      deliver(productOf(res), true)
    }

    const onError = function (error) {
      recording = false
      const errMsg = error && typeof error.errMsg === 'string' ? error.errMsg : ''
      deliver(failure(isAuthDenial(errMsg) ? CODES.AUTH_DENIED : CODES.FAILED, errMsg), false)
    }

    const onInterruptionBegin = function (error) {
      recording = false
      deliver(failure(CODES.INTERRUPTED, error && typeof error.errMsg === 'string' ? error.errMsg : ''), false)
    }

    try {
      instance.onStop(onStop)
      instance.onError(onError)
      if (typeof instance.onInterruptionBegin === 'function') instance.onInterruptionBegin(onInterruptionBegin)
    } catch (error) {
      // 事件绑定失败：如实降级为「能力不可用」，不留下会假装在录的端口。
      bound = false
    }
  }

  return {
    kind: supported ? 'recorder' : 'unavailable',
    note: supported
      ? '生产录音端口（wx.getRecorderManager）：只录调用方要求的时长上限，产物交给私有媒体上传链路。'
      : '生产录音端口不可用（当前环境没有 wx.getRecorderManager）：录音一律如实失败，不假装在录。',
    available: supported,
    maxDurationMs: MAX_DURATION_MS,

    /**
     * 开始录音。**先读授权状态**：已明确被拒 ⇒ 不调用 `start()`，直接如实报 `RECORD_AUTH_DENIED`
     * （避免无意义的平台调用与弹窗），由页面引导到设置页。
     */
    start: function (options) {
      if (released) return Promise.resolve(failure(CODES.UNAVAILABLE, '录音端口已释放'))
      if (!supported) return Promise.resolve(failure(CODES.UNAVAILABLE, '当前环境不提供录音能力'))
      if (recording) return Promise.resolve(failure(CODES.BUSY))

      const wanted = options && typeof options === 'object' ? options : {}
      const format = typeof wanted.format === 'string' ? wanted.format : DEFAULT_OPTIONS.format
      if (ALLOWED_FORMATS.indexOf(format) === -1) return Promise.resolve(failure(CODES.INVALID_INPUT, '录音编码不在契约允许范围'))

      // 时长**只**由契约上限收口：调用方可以更短，但不得更长（不接受任何放宽）。
      const requested = Number.isFinite(wanted.duration) ? Math.floor(wanted.duration) : MAX_DURATION_MS
      if (requested < 1) return Promise.resolve(failure(CODES.INVALID_INPUT, '录音时长上限必须为正整数'))
      const duration = Math.min(requested, MAX_DURATION_MS)

      // 新会话：清掉上一次未被取走的产物/错误与取消标记，避免把旧结果当成这一次的结果（不串台）。
      lastProduct = null
      discardNext = false
      requestedDuration = duration

      return permissionState().then(function (permission) {
        if (permission.state === 'denied') return failure(CODES.AUTH_DENIED, 'scope.record=false')
        const instance = managerOf()
        if (instance === null) return failure(CODES.UNAVAILABLE, '当前环境不提供录音能力')
        bindOnce(instance)
        if (bound !== true) return failure(CODES.UNAVAILABLE, '录音事件绑定失败')

        return new Promise(function (resolve) {
          let settled = false
          /** 兑现器：**兑现即把 `pendingStart` 清空** —— 否则平台的自动 `onStop` 会落进空操作（见字段注释）。 */
          const finish = function (value) {
            if (settled) return
            settled = true
            if (pendingStart === finish) pendingStart = null
            resolve(value)
          }
          pendingStart = finish
          recording = true
          try {
            // 采样率/声道/容器一律取自冻结 ASR 档位；调用方只能选编码格式，不能改这三项。
            const startOptions = {
              duration: duration,
              sampleRate: SAMPLE_RATE,
              numberOfChannels: NUMBER_OF_CHANNELS,
              format: format
            }
            // 只有压缩编码才带码率；WAV（默认容器）不带 —— 理由见 `COMPRESSED_ENCODE_BIT_RATE`。
            if (format !== RECORD_FORMAT) startOptions.encodeBitRate = COMPRESSED_ENCODE_BIT_RATE
            instance.start(startOptions)
          } catch (error) {
            recording = false
            finish(failure(CODES.FAILED, error && error.message ? error.message : '录音启动异常'))
            return
          }
          // `start()` 是同步返回的：平台若立刻拒绝（授权/占用），`onError` 会把 `pendingStart` 收走。
          // 这里在下一个微任务确认「仍未被 onError 抢走」才认为已开始。
          Promise.resolve().then(function () {
            if (settled) return
            if (recording !== true) { finish(failure(CODES.FAILED, '录音未能开始')); return }
            finish({ ok: true, maxDurationMs: duration })
          })
        })
      })
    },

    /**
     * 停止并取回产物（时长/编码都来自平台真实回调，不由调用方声明）。
     *
     * **平台已自行停止**（录满 `duration` 上限／系统回收）时，端口里已有产物
     * ⇒ 直接如实交出，**不得**报 `RECORD_NOT_STARTED`（那会把"已录满"说成"没在录"，并丢掉产物）。
     */
    stop: function () {
      if (released) return Promise.resolve(failure(CODES.NOT_RECORDING))
      if (recording !== true) {
        if (lastProduct !== null) {
          const product = lastProduct
          lastProduct = null
          return Promise.resolve(product)
        }
        return Promise.resolve(failure(CODES.NOT_RECORDING))
      }
      const instance = managerOf()
      if (instance === null) { recording = false; return Promise.resolve(failure(CODES.UNAVAILABLE)) }
      return new Promise(function (resolve) {
        let settled = false
        const finish = function (value) {
          if (settled) return
          settled = true
          if (pendingStop === finish) pendingStop = null
          resolve(value)
        }
        pendingStop = finish
        try {
          instance.stop()
        } catch (error) {
          recording = false
          finish(failure(CODES.FAILED, error && error.message ? error.message : '停止录音异常'))
        }
      })
    },

    /** 取消：停止录音并**丢弃**产物（用户取消 / 会话变化），不留挂起状态。 */
    cancel: function () {
      if (recording !== true) return Promise.resolve({ ok: true, code: CODES.NOT_RECORDING })
      const instance = managerOf()
      recording = false
      // 用户已取消：在途 stop() 如实失败，平台随后回传的产物一并丢弃（`discardNext`）。
      const stopDone = pendingStop
      pendingStop = null
      if (stopDone !== null) stopDone(failure(CODES.FAILED, '录音已取消'))
      lastProduct = null
      discardNext = true
      if (instance === null) return Promise.resolve({ ok: true, code: CODES.UNAVAILABLE })
      try { instance.stop() } catch (error) { discardNext = false }
      return Promise.resolve({ ok: true, code: null })
    },

    /** 离页释放：停止录音 → 摘掉在途兑现器与产物槽 → 清掉平台监听（不留挂起定时器/监听）。 */
    release: function () {
      if (released) return
      const instance = manager
      const wasRecording = recording
      recording = false
      released = true
      const startDone = pendingStart
      pendingStart = null
      const stopDone = pendingStop
      pendingStop = null
      lastProduct = null
      discardNext = false
      if (startDone !== null) startDone(failure(CODES.FAILED, '录音端口已释放'))
      if (stopDone !== null) stopDone(failure(CODES.FAILED, '录音端口已释放'))
      if (instance !== null) {
        if (wasRecording) { try { instance.stop() } catch (error) { /* 已停止 */ } }
        for (const off of ['offStop', 'offError', 'offInterruptionBegin']) {
          try { if (typeof instance[off] === 'function') instance[off]() } catch (error) { /* 旧基础库可能无 off* */ }
        }
      }
      manager = null
      bound = false
    },

    isRecording: function () { return recording === true }
  }
}

module.exports = {
  MAX_DURATION_MS: MAX_DURATION_MS,
  SAMPLE_RATE: SAMPLE_RATE,
  NUMBER_OF_CHANNELS: NUMBER_OF_CHANNELS,
  RECORD_FORMAT: RECORD_FORMAT,
  ALLOWED_FORMATS: ALLOWED_FORMATS.slice(),
  CODES: CODES,
  mimeForFormat: mimeForFormat,
  platformSupported: platformSupported,
  permissionState: permissionState,
  support: support,
  createRecorderPort: createRecorderPort
}
