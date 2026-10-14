// GY-I13 **生产播放端口**：`wx.createInnerAudioContext` 的唯一出现处（原生小程序侧）。
//
// 为什么单独一个文件：`utils/audio-playback.js` 的播放能力是**注入**的端口，因此
//   (a) 控制器可以在 Node 里直接用替身端口单测（不需要真机、不产生任何音频）；
//   (b) 平台能力只在这一个文件里被引用，便于审查「谁真的碰了系统音频」。
//
// 诚实边界（如实登记，不做任何真实能力声称）：
// - 本文件**不产生**任何音频、不下载任何音频、不猜测音频内容；它只把平台播放器的
//   事件/错误转成控制器认识的语义。
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
 * 建生产播放端口。
 *
 * @returns {{
 *   kind: 'inner_audio'|'unavailable',
 *   note: string,
 *   available: boolean,
 *   create(src: string): object
 * }}
 */
function createInnerAudioPort() {
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

  return {
    kind: supported ? 'inner_audio' : 'unavailable',
    note: supported
      ? '内建音频播放端口（wx.createInnerAudioContext）：只播放调用方给出的音频源，不下载、不生成、不猜测内容。'
      : '内建音频播放端口不可用（当前环境没有 wx.createInnerAudioContext）：播放一律如实失败，不伪造播放完成。',
    available: supported,
    create: function (src) {
      if (typeof src !== 'string' || src === '') return unavailableHandle('播放源为空：没有可播放的音频。')
      if (!supported) return unavailableHandle('当前环境不提供内建音频播放能力。')
      bindInterruptionOnce()

      const context = wx.createInnerAudioContext()
      const listeners = {}
      let destroyed = false

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

      try { context.src = src } catch (error) { emit('error', { code: 'SOURCE_UNAVAILABLE', errMsg: '播放源不可用' }) }
      live.push(entry)
      return entry
    }
  }
}

module.exports = {
  createInnerAudioPort: createInnerAudioPort,
  platformSupported: platformSupported
}
