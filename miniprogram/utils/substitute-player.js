// GY-I13 **明确标注的替身播放端口**（原生小程序侧，仅本地替身工程/离线回归使用）。
//
// 它**不产生任何声音**、不读取任何音频、不下载任何资源：只按真实播放器的**事件顺序**
// 发出 `play` → `ended`（或 `error`），用来在离线环境里走查/回归语音球与
// 播放/暂停/停止/重播的生命周期，以及失败文案与主动播放按钮。
//
// 两条硬红线（与 issue #13 的验收口径一致）：
// 1. `substitute: true` ⇒ `utils/audio-playback.js` **不会**置「已听取」，
//    页面必须显示「替身播放：非真实音频，不计入『已听取』」；
// 2. 本文件**不得**被当作真实播报证据：它没有音频、没有说话人、没有任何内容朗读。
'use strict'

const DEFAULT_SEGMENT_MS = 60

/**
 * @param {{segmentMs?: number, failFirst?: string|null}} [options]
 *   `segmentMs`：每段"播放"的时长（毫秒，仅用于让事件异步发生）；
 *   `failFirst`：若给出失败码，则**第一次**播放以该失败码报错（用于离线走查失败文案）。
 */
function createSubstitutePlayerPort(options) {
  const config = options || {}
  const segmentMs = typeof config.segmentMs === 'number' && config.segmentMs >= 0 ? config.segmentMs : DEFAULT_SEGMENT_MS
  let failed = false

  return {
    kind: 'substitute_player',
    substitute: true,
    note: '替身播放端口（非真实音频）：不产生声音、不朗读任何内容，只按真实事件顺序发出 play→ended，'
      + '用于离线走查语音球与播放生命周期；用它播出的内容**不计入「已听取」**。',
    create: function (src) {
      const listeners = {}
      let destroyed = false
      let timer = null
      let paused = false

      function emit(event, payload) {
        if (destroyed) return
        const bucket = listeners[event]
        if (!bucket) return
        for (const handler of bucket.slice()) {
          try { handler(payload) } catch (error) { /* 单个监听器失败不影响其它 */ }
        }
      }

      function clearTimer() { if (timer !== null) { clearTimeout(timer); timer = null } }

      const handle = {
        on: function (event, handler) {
          if (!listeners[event]) listeners[event] = []
          listeners[event].push(handler)
          return function () {
            if (!listeners[event]) return
            listeners[event] = listeners[event].filter(function (item) { return item !== handler })
          }
        },
        play: function () {
          if (destroyed || paused) return
          clearTimer()
          if (typeof config.failFirst === 'string' && !failed) {
            failed = true
            timer = setTimeout(function () { emit('error', { code: config.failFirst, errMsg: '替身播放端口按配置报错（非真实音频）' }) }, 0)
            return
          }
          emit('play')
          timer = setTimeout(function () { emit('ended') }, segmentMs)
        },
        pause: function () {
          if (destroyed) return
          clearTimer()
          paused = true
          emit('pause')
        },
        stop: function () {
          if (destroyed) return
          clearTimer()
          paused = false
        },
        destroy: function () {
          if (destroyed) return
          destroyed = true
          clearTimer()
          for (const key of Object.keys(listeners)) listeners[key] = []
        }
      }
      // `src` 只是分段标识（本端口不读取任何音频）；保留它是为了让"一段一个源"的
      // 分段播报形态与真实端口完全一致。
      handle.src = typeof src === 'string' ? src : ''
      return handle
    }
  }
}

module.exports = { createSubstitutePlayerPort: createSubstitutePlayerPort }
