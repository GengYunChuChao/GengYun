// GY-I13 **生产播放端口**：`wx.createInnerAudioContext` 的唯一出现处（原生小程序侧）。
//
// 为什么单独一个文件：`utils/audio-playback.js` 的播放能力是**注入**的端口，因此
//   (a) 控制器可以在 Node 里直接用替身端口单测（不需要真机、不产生任何音频）；
//   (b) 平台能力只在这一个文件里被引用，便于审查「谁真的碰了系统音频」。
//
// 诚实边界（如实登记，不做任何真实能力声称）：
// - 本文件**不产生**任何音频、**不生成/不猜测/不顶替**音频内容；它只把平台播放器的事件/错误
//   转成控制器认识的语义。
// - **私有音频读面需要会话头**：服务端的音频读面 `GET /api/v1/speech/synthesis/{id}/audio`
//   （R74 operation `readSynthesisAudio`）要求 `Authorization`，而 `InnerAudioContext` **不能**
//   带自定义头。因此当调用方注入 `authorization`（且地址落在 `originPrefix` 之下）时，本文件先用
//   `wx.downloadFile({ header })` 把字节下到临时文件，再把 `tempFilePath` 交给播放器；**只对自家
//   API 域**附会话头（绝不把令牌发给第三方域）。没注入 `authorization`、或地址不在该域下 ⇒
//   保持原样直连 `context.src = src`（既有走查/替身路径逐字不变）。
// - 下载失败（HTTP 401/403/404/409/5xx、域名未加白、网络不可达）⇒ 如实 `error(...)`，文案写清
//   具体是哪一类，由 `audio-playback.js` 归类；**绝不**伪造 `ended`（那会假记「已听取」）。
// - 端口不可用（非小程序环境、基础库缺能力）⇒ `available:false`，`create()` 返回一个
//   只会 `error(SOURCE_UNAVAILABLE)` 的句柄；**绝不**伪造 `ended`（那会假记「已听取」）。
// - 蓝牙/静音/拒权在这里**只能**如实透传平台错误文案，由 `audio-playback.js`
//   `classifyPlaybackFailure` 归类成有文案与主动按钮的失败；本文件不自己编结论。
// - 真机音频与交互证据属 issue #23，本文件不构成任何真机验收。
'use strict'

/** 平台是否提供内部音频播放能力（在 Node/测试环境里恒为 false）。 */
function platformSupported() {
  return typeof wx !== 'undefined' && wx !== null && typeof wx.createInnerAudioContext === 'function'
}

/**
 * HTTP 状态码 → 控制器可展示的**具体**失败（不写"网络问题"糊过去）。
 * `code` 必须落在 `audio-playback.js` 的 `FAILURE_CODES` 闭集内。
 */
function errorForHttpStatus(status) {
  if (status === 401 || status === 403) {
    return { code: 'PERMISSION_DENIED', errMsg: '音频读面以 HTTP ' + status + ' 拒绝了当前会话：登录状态可能已失效，请重新登录后再播报。' }
  }
  if (status === 404) {
    return { code: 'SOURCE_UNAVAILABLE', errMsg: '音频读面返回 HTTP 404：合成记录不存在、不属于当前账号，或产物已被清理。' }
  }
  if (status === 409) {
    return { code: 'SOURCE_UNAVAILABLE', errMsg: '音频读面返回 HTTP 409（OBJECT_UNAVAILABLE）：这是替身/非音频产物，或产物存储未接线、产物已清理。' }
  }
  if (status === 429) {
    return { code: 'SOURCE_UNAVAILABLE', errMsg: '音频读面返回 HTTP 429：请求过于频繁，请稍后重试。' }
  }
  if (status >= 500) {
    return { code: 'SOURCE_UNAVAILABLE', errMsg: '音频读面返回 HTTP ' + status + '：服务端未就绪或对象存储读取失败。' }
  }
  return { code: 'SOURCE_UNAVAILABLE', errMsg: '音频读面返回 HTTP ' + status + '：取不到可播放字节。' }
}

/** 下载通道本身失败（拿不到 statusCode）⇒ 如实写清可能是域名未加白 / 网络不可达。 */
function errorForChannel(error) {
  const raw = error && (error.errMsg || error.message)
  const detail = typeof raw === 'string' && raw !== '' ? raw : '未知原因'
  return {
    code: 'SOURCE_UNAVAILABLE',
    errMsg: '音频下载失败（' + detail + '）：可能网络不可达，或小程序后台没把后端域名加入 downloadFile 合法域名。'
  }
}

/**
 * `wx.downloadFile`（回调式）→ Promise。HTTP 非 2xx 与通道失败都给出**具体**失败，
 * 绝不把"下不到"当成"播完了"。
 */
function downloadViaPlatform(downloadFile, url, header) {
  return new Promise(function (resolve) {
    try {
      downloadFile({
        url: url,
        header: { authorization: header },
        success: function (response) {
          const status = response && typeof response.statusCode === 'number' ? response.statusCode : 0
          const tempFilePath = response && typeof response.tempFilePath === 'string' ? response.tempFilePath : ''
          if (status >= 200 && status < 300 && tempFilePath !== '') {
            resolve({ ok: true, tempFilePath: tempFilePath })
            return
          }
          resolve({ ok: false, statusCode: status, error: errorForHttpStatus(status) })
        },
        fail: function (error) { resolve({ ok: false, statusCode: 0, error: errorForChannel(error) }) }
      })
    } catch (error) {
      resolve({ ok: false, statusCode: 0, error: errorForChannel(error) })
    }
  })
}

/**
 * 建生产播放端口。
 *
 * @param {{
 *   authorization?: (() => (string|null))|null,
 *   originPrefix?: string,
 *   downloadFile?: ((input: {url: string, header: object}) => Promise<{ok: boolean, tempFilePath?: string, statusCode?: number, error?: object}>) | null
 * }} [options]
 *   `authorization`：返回当前会话的 `Authorization` 头值（如 `voiceApi.audioAuthorizationHeader`）；
 *     **只**对 `originPrefix` 前缀之下的地址附这个头（私有读面），否则直连播放（不泄露令牌）。
 *   `downloadFile`：测试注入用；缺省用 `wx.downloadFile`（回调式，内部包成 Promise）。
 * @returns {{
 *   kind: 'inner_audio'|'unavailable',
 *   note: string,
 *   available: boolean,
 *   create(src: string): object
 * }}
 */
function createInnerAudioPort(options) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const supported = platformSupported()
  /** 活动句柄集合：仅用于把平台的全局中断事件转发给正在播的句柄。 */
  const live = []
  let interruptionBound = false

  function broadcastInterruption(payload) {
    for (const entry of live.slice()) {
      try { entry.raise('interrupt', payload) } catch (error) { /* 单个句柄失败不影响其它 */ }
    }
  }

  function bindInterruptionOnce() {
    if (interruptionBound || !supported) return
    interruptionBound = true
    // 全局音频中断（来电、其它 App 抢占、蓝牙切换）：如实转发，由控制器归类为
    // PLAYBACK_INTERRUPTED 并**不记已听取**。
    try {
      if (typeof wx.onAudioInterruptionBegin === 'function') {
        wx.onAudioInterruptionBegin(function () { broadcastInterruption({ code: 'PLAYBACK_INTERRUPTED', errMsg: 'audio interruption begin' }) })
      }
    } catch (error) { /* 基础库不支持则跳过 */ }
  }

  function unavailableHandle(reason) {
    const listeners = {}
    return {
      on: function (event, handler) {
        // 立刻以异步方式如实报错：**不**发 ended、不假装播过。
        if (event === 'error') {
          if (!listeners[event]) listeners[event] = []
          listeners[event].push(handler)
          setTimeout(function () {
            for (const item of listeners[event].slice()) item({ code: 'SOURCE_UNAVAILABLE', errMsg: reason })
          }, 0)
        }
        return function () {
          if (!listeners[event]) return
          listeners[event] = listeners[event].filter(function (item) { return item !== handler })
        }
      },
      play: function () {},
      pause: function () {},
      stop: function () {},
      destroy: function () { for (const key of Object.keys(listeners)) listeners[key] = [] }
    }
  }

  /**
   * 这个 `src` 要不要走"带会话头下载"？
   *
   * - `null` ⇒ 直连播放（没注入会话头 / 地址不在自家 API 域下）——既有行为逐字不变，
   *   且**绝不**把会话令牌发给第三方域；
   * - `{kind:'blocked', reason}` ⇒ 认得出是自家私有读面却没法下载（无令牌 / 无 `wx.downloadFile`）
   *   ⇒ 如实失败，**不**退回静默直连假装能播；
   * - `{kind:'remote', download}` ⇒ 先下载到临时文件再交给播放器。
   */
  function remoteSourcePlan(src) {
    if (typeof settings.authorization !== 'function') return null
    const prefix = typeof settings.originPrefix === 'string' ? settings.originPrefix : ''
    if (prefix === '' || src.indexOf(prefix) !== 0) return null
    let header = null
    try { header = settings.authorization() } catch (error) { header = null }
    if (typeof header !== 'string' || header === '') {
      return { kind: 'blocked', reason: '音频读面需要登录会话：当前没有可用的会话令牌，取不到私有音频字节。' }
    }
    const injected = typeof settings.downloadFile === 'function' ? settings.downloadFile : null
    const platform = typeof wx !== 'undefined' && wx !== null && typeof wx.downloadFile === 'function' ? wx.downloadFile : null
    if (injected === null && platform === null) {
      return { kind: 'blocked', reason: '当前基础库没有 wx.downloadFile：带会话头的音频下不到本地（InnerAudioContext 不能带自定义头）。' }
    }
    return {
      kind: 'remote',
      download: function () {
        if (injected !== null) {
          return Promise.resolve().then(function () { return injected({ url: src, header: { authorization: header } }) })
        }
        return downloadViaPlatform(platform, src, header)
      }
    }
  }

  return {
    kind: supported ? 'inner_audio' : 'unavailable',
    note: supported
      ? '内建音频播放端口（wx.createInnerAudioContext）：只播放调用方给出的音频源，不生成、不猜测、不顶替内容；'
        + '自家私有读面（注入会话头 + originPrefix 之内）先带 Authorization 用 wx.downloadFile 下到临时文件再播。'
      : '内建音频播放端口不可用（当前环境没有 wx.createInnerAudioContext）：播放一律如实失败，不伪造播放完成。',
    available: supported,
    create: function (src) {
      if (typeof src !== 'string' || src === '') return unavailableHandle('播放源为空：没有可播放的音频。')
      if (!supported) return unavailableHandle('当前环境不提供内建音频播放能力。')
      bindInterruptionOnce()

      const context = wx.createInnerAudioContext()
      const listeners = {}
      let destroyed = false
      /** 播放源是否已经交给播放器（远程下载完成前为 false）。 */
      let ready = true
      /** 下载完成前收到的 play 请求：就绪后补发一次。 */
      let pendingPlay = false

      const entry = {
        raise: function (event, payload) { emit(event, payload) },
        on: function (event, handler) {
          if (!listeners[event]) listeners[event] = []
          listeners[event].push(handler)
          return function () {
            if (!listeners[event]) return
            listeners[event] = listeners[event].filter(function (item) { return item !== handler })
          }
        },
        play: function () {
          if (destroyed) return
          // 远程私有读面要先下载：字节就绪前不发 play，等 src 设好再补发（**不**假装播过）。
          if (!ready) { pendingPlay = true; return }
          try { context.play() } catch (error) { emit('error', error) }
        },
        pause: function () { if (!destroyed) { try { context.pause() } catch (error) { /* 如实忽略 */ } } },
        stop: function () { if (!destroyed) { try { context.stop() } catch (error) { /* 如实忽略 */ } } },
        destroy: function () {
          if (destroyed) return
          destroyed = true
          const at = live.indexOf(entry)
          if (at !== -1) live.splice(at, 1)
          for (const key of Object.keys(listeners)) listeners[key] = []
          try { context.offPlay && context.offPlay() } catch (error) { /* 审计：旧基础库可能无 off* */ }
          try { context.offPause && context.offPause() } catch (error) { /* 同上 */ }
          try { context.offStop && context.offStop() } catch (error) { /* 同上 */ }
          try { context.offEnded && context.offEnded() } catch (error) { /* 同上 */ }
          try { context.offError && context.offError() } catch (error) { /* 同上 */ }
          try { context.destroy() } catch (error) { /* 已销毁 */ }
        }
      }

      function emit(event, payload) {
        if (destroyed) return
        const bucket = listeners[event]
        if (!bucket) return
        for (const handler of bucket.slice()) {
          try { handler(payload) } catch (error) { /* 单个监听器失败不影响其它 */ }
        }
      }

      // 平台事件 → 控制器语义（一一对应，不做任何"成功"推定）。
      try {
        context.onPlay(function () { emit('play') })
        context.onPause(function () { emit('pause') })
        context.onStop(function () { emit('stop') })
        context.onEnded(function () { emit('ended') })
        context.onError(function (error) { emit('error', error || {}) })
        if (typeof context.onWaiting === 'function') context.onWaiting(function () { emit('waiting') })
      } catch (error) {
        emit('error', { code: 'DECODE_FAILED', errMsg: '播放器事件绑定失败' })
      }

      const remote = remoteSourcePlan(src)
      if (remote === null) {
        // 直连路径（既有行为逐字不变）：没注入会话头，或地址不在自家 API 域下。
        try { context.src = src } catch (error) { emit('error', { code: 'SOURCE_UNAVAILABLE', errMsg: '播放源不可用' }) }
        live.push(entry)
        return entry
      }
      if (remote.kind === 'blocked') {
        // 认得出是自家私有读面，却没有下载能力/会话 ⇒ 如实失败（**不**静默直连假装能播）。
        setTimeout(function () { emit('error', { code: 'SOURCE_UNAVAILABLE', errMsg: remote.reason }) }, 0)
        live.push(entry)
        return entry
      }
      // 私有读面：先带 Authorization 下到临时文件，再把 tempFilePath 交给播放器。
      // 下载期间 `play()` 只记意图，字节就绪后补发一次（不假装播过、不伪造 ended）。
      ready = false
      live.push(entry)
      remote.download().then(function (result) {
        if (destroyed) return
        if (!result || result.ok !== true || typeof result.tempFilePath !== 'string' || result.tempFilePath === '') {
          ready = true
          emit('error', (result && result.error) || errorForChannel(null))
          return
        }
        try {
          context.src = result.tempFilePath
        } catch (error) {
          ready = true
          emit('error', { code: 'SOURCE_UNAVAILABLE', errMsg: '下载到的音频无法交给播放器。' })
          return
        }
        ready = true
        if (pendingPlay) {
          pendingPlay = false
          try { context.play() } catch (error) { emit('error', error) }
        }
      }, function (error) {
        if (destroyed) return
        ready = true
        emit('error', errorForChannel(error))
      })
      return entry
    }
  }
}

module.exports = {
  createInnerAudioPort: createInnerAudioPort,
  platformSupported: platformSupported
}
