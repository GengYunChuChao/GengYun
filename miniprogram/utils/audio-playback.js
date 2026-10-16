// GY-I13 **客户端播放生命周期**（原生小程序侧）：单一播放者、可复核的资源释放与失败分类。
//
// 设计边界（刻意的）：
// - 本模块**不引用 wx**：播放能力由注入的 `player` 端口提供（生产用 utils/inner-audio-port.js，
//   测试/离线用替身端口）。因此本模块可在 Node 里直接单测，不需要真机。
// - 本模块**不产生任何假音频**、不做任何"播过了就算听过"的默认推定：
//   `listened`（已听取）**只在整份播报计划自然播完后置位**；用户停止、失败、中断、离页释放
//   一律**不置位**（这是 issue #13 的硬负例：自动播放失败不得假记「已听取」）。
// - 失败一律给出**文案 + 主动播放按钮**所需的四要素（`title`/`hint`/`actionText`/`manualStart`），
//   静音、蓝牙/耳机路由、拒权、平台阻止自动播放各有独立文案（不得合并成一句"播放失败"）。
'use strict'

const speechText = require('./speech-text')

/** 播放生命周期状态闭集。 */
const PLAYBACK_STATES = ['idle', 'loading', 'playing', 'paused', 'stopped', 'failed']

/** 失败代码闭集（每一类都必须有文案与主动播放按钮）。 */
const FAILURE_CODES = [
  'AUTOPLAY_BLOCKED',     // 平台/系统阻止自动播放
  'MUTED',                // 静音或音量为 0
  'BLUETOOTH',            // 蓝牙/耳机路由（声音送去了别处或中途断开）
  'PERMISSION_DENIED',    // 拒权
  'SOURCE_UNAVAILABLE',   // 没有可播放的音频源（替身产物/未接线）
  'DECODE_FAILED',        // 解码/格式失败
  'PLAYBACK_INTERRUPTED', // 被系统事件中断
  'UNKNOWN'               // 其它，仍如实回报且不计已听取
]

/**
 * 失败原因 → 展示要素（文案 + 主动播放按钮）。**所有**失败都 `recordsListened: false`。
 * `actionText` 非空即表示必须渲染一个可点击的主动按钮（不得只弹一句提示就完事）。
 */
const FAILURE_PRESETS = {
  AUTOPLAY_BLOCKED: {
    title: '平台没有允许自动播放',
    hint: '系统或平台要求先由你主动操作才允许发声。本次没有开始播放，也没有记为「已听取」。',
    actionText: '点这里主动播放'
  },
  MUTED: {
    title: '当前是静音或音量是 0',
    hint: '设备处于静音、音量 0 或音频通道被静音，开了播放也听不到。请先调高音量，再主动播放。',
    actionText: '调好音量后主动播放'
  },
  BLUETOOTH: {
    title: '声音送到了蓝牙或耳机',
    hint: '当前音频输出是蓝牙/耳机（也可能是蓝牙中途断开）。本机听不到不代表没在播，也不代表你已听取；可改回本机扬声器后主动播放。',
    actionText: '改回本机扬声器后主动播放'
  },
  PERMISSION_DENIED: {
    title: '没有获得播放权限',
    hint: '系统或微信拒绝了播放所需权限。未获得许可时不会播放，也不会记为「已听取」。',
    actionText: '去开启权限后主动播放'
  },
  SOURCE_UNAVAILABLE: {
    title: '没有可播放的音频',
    hint: '本环境无可播放音频（契约无客户端音频出口）：替身产物是明确标注的**非音频**占位，'
      + '真实产物也没有可读字节的下载 operation。文字内容仍可阅读，本页不会用别的音频顶替、不会假装能播。',
    actionText: '再试一次主动播放'
  },
  DECODE_FAILED: {
    title: '音频无法解码播放',
    hint: '音频数据损坏或格式不受支持。本页不会拿其它音频顶替，也不会记为「已听取」。',
    actionText: '重新主动播放'
  },
  PLAYBACK_INTERRUPTED: {
    title: '播放被中断',
    hint: '系统事件（来电、其它音频、蓝牙切换）中断了播放。本次**不计入**「已听取」。',
    actionText: '重新主动播放'
  },
  UNKNOWN: {
    title: '播放没有完成',
    hint: '播放未能完成，原因未能识别。本次不计入「已听取」。',
    actionText: '重新主动播放'
  }
}

/** 原始错误特征 → 失败代码（只做分类，不改写原始信息）。 */
const FAILURE_HINTS = [
  { code: 'PERMISSION_DENIED', pattern: /permission|authorize|auth deny|not authorized|拒绝|未授权|权限/i },
  { code: 'BLUETOOTH', pattern: /bluetooth|headset|a2dp|hfp|蓝牙|耳机|扬声器切换/i },
  { code: 'MUTED', pattern: /mute|muted|volume|静音|音量|无声/i },
  { code: 'AUTOPLAY_BLOCKED', pattern: /autoplay|auto play|user gesture|not allowed|play\(\)\s*failed|interrupted by system|需要用户|自动播放|被系统阻止/i },
  { code: 'SOURCE_UNAVAILABLE', pattern: /no source|invalid src|src is empty|404|not found|无可用|没有音频|未接线|替身/i },
  { code: 'DECODE_FAILED', pattern: /decode|demux|format|unsupported|invalid data|解码|格式/i },
  { code: 'PLAYBACK_INTERRUPTED', pattern: /interrupt|中断|被其它音频/i }
]

function failureOf(code, reason) {
  const preset = FAILURE_PRESETS[code] || FAILURE_PRESETS.UNKNOWN
  return {
    code: code,
    title: preset.title,
    hint: preset.hint,
    actionText: preset.actionText,
    // 必须有主动播放按钮；且**一律不记已听取**。
    manualStart: true,
    recordsListened: false,
    reason: typeof reason === 'string' && reason !== '' ? reason : null
  }
}

/**
 * 失败分类（纯函数）。接受 `{code}` / `{code, errMsg}` / `{errMsg}` / Error / 字符串。
 * 已属 `FAILURE_CODES` 的直接采用；否则按特征归类；仍认不出 ⇒ `UNKNOWN`（**不**吞掉原因）。
 */
function classifyPlaybackFailure(input) {
  if (input !== null && typeof input === 'object' && typeof input.code === 'string' && FAILURE_CODES.indexOf(input.code) !== -1) {
    return failureOf(input.code, input.reason || input.errMsg || input.message)
  }
  const raw = typeof input === 'string'
    ? input
    : (input && typeof input === 'object'
        ? String(input.errMsg || input.message || (input.code === undefined ? '' : input.code))
        : '')
  for (const entry of FAILURE_HINTS) {
    if (entry.pattern.test(raw)) return failureOf(entry.code, raw)
  }
  return failureOf('UNKNOWN', raw)
}

/** 播放计划规格化：接受 `'src'`、`{src,label}`、数组。空/非法一律丢弃（不造占位源）。 */
function normalizeSources(value) {
  const list = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of list) {
    if (typeof item === 'string' && item !== '') { out.push({ src: item, label: null }); continue }
    if (item !== null && typeof item === 'object' && typeof item.src === 'string' && item.src !== '') {
      out.push({ src: item.src, label: typeof item.label === 'string' ? item.label : null })
    }
  }
  return out
}

function samePlan(a, b) {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) if (a[index].src !== b[index].src) return false
  return true
}

/**
 * 建播放生命周期控制器。
 *
 * `player` 端口（必须提供）：
 * ```js
 * { create(src: string) -> {
 *     play(): void, pause(): void, stop(): void, destroy(): void,
 *     on(event: 'play'|'pause'|'stop'|'ended'|'error'|'interrupt', handler): () => void  // 返回退订函数
 *   } }
 * ```
 * `on(event, handler)` **必须返回退订函数**——释放的可复核判据（`listenerCount() === 0`）依赖它。
 *
 * 生命周期硬保证（每条都有负例单测）：
 * 1. **单一播放者**：同一时刻最多一个活动句柄；对同一计划重复 `play()` **不新建句柄、不重复出声**；
 * 2. **换计划先停旧**：切换计划时旧句柄必先 `stop()` 并 `destroy()`；
 * 3. **`listened` 只在整份计划自然播完后为真**；`stop()`/失败/中断/`release()` 都不置位；
 * 4. **`release()` 幂等且彻底**：退订全部监听、销毁句柄、清空计划；此后迟到的
 *    `ended`/`error`/`interrupt` 回调**一律不生效**（代次守卫），也不会创建新句柄；
 *    **段级守卫**：只接受当前段句柄的事件——上一段/已作废段（及同一事件重复投递）的迟到
 *    回调一律丢弃：不推进段号、不跳过下一段、不置「已听取」、不把已完成会话翻成失败；
 * 5. 失败必带可展示四要素且 `recordsListened: false`；
 * 6. **替身播放端口不得假记「已听取」**：端口声明 `substitute: true` 时，整份计划播完
 *    只置 `substituteCompleted`（页面据此显示「替身播放：非真实音频，不计入『已听取』」），
 *    `listened` 恒为假、`onListened` 永不触发——替身没有声音，不能算作"听过"。
 */
function createPlaybackController(options) {
  const config = options || {}
  const player = config.player
  if (player === null || typeof player !== 'object' || typeof player.create !== 'function') {
    throw new Error('播放控制器需要一个提供 create(src) 的播放端口')
  }
  const substitute = player.substitute === true
  const onStateChange = typeof config.onStateChange === 'function' ? config.onStateChange : function () {}
  const onListened = typeof config.onListened === 'function' ? config.onListened : function () {}
  const onFailure = typeof config.onFailure === 'function' ? config.onFailure : function () {}

  let released = false
  let generation = 0
  let state = 'idle'
  let plan = []
  let index = 0
  let handle = null
  let unsubscribes = []
  let listened = false
  let substituteCompleted = false
  let autoInitiated = false
  let failure = null
  let createdHandles = 0
  let destroyedHandles = 0

  function snapshot() {
    return {
      state: state,
      index: index,
      total: plan.length,
      listened: listened,
      /** 替身播放端口下"整份计划播完"的如实标记：**不是**「已听取」。 */
      substitute: substitute,
      substituteCompleted: substituteCompleted,
      auto: autoInitiated,
      failure: failure,
      released: released,
      hasHandle: handle !== null,
      listenerCount: unsubscribes.length,
      createdHandles: createdHandles,
      destroyedHandles: destroyedHandles
    }
  }

  function publish() { onStateChange(snapshot()) }

  function setState(next) {
    if (state === next) return
    state = next
    publish()
  }

  /** 退订全部监听（释放的可复核判据之一）。 */
  function detachAll() {
    const pending = unsubscribes
    unsubscribes = []
    for (const unsubscribe of pending) {
      try { unsubscribe() } catch (error) { /* 退订失败不得影响释放流程 */ }
    }
  }

  function destroyHandle() {
    const current = handle
    handle = null
    detachAll()
    if (current === null) return
    try { current.stop() } catch (error) { /* 已结束/已销毁 */ }
    try { current.destroy() } catch (error) { /* 端口可能不支持 destroy */ }
    destroyedHandles += 1
  }

  function attach(target, token) {
    const bind = function (event, handler) {
      const unsubscribe = target.on(event, function (payload) {
        // 代次守卫：release()/换计划之后（含换计划的旧句柄），迟到的回调一律不生效。
        if (released || token !== generation) return
        // 段级守卫：只接受**当前段**句柄的事件。上一段/已作废段的迟到或重复回调（平台在途
        // 投递、同一事件重复触发）一律丢弃——否则一个迟到的 `ended` 会推进段号、跳过下一段，
        // 甚至把并未播完的计划记成「已听取」。`handle === null` 表示本段已结束并已销毁，
        // 同样丢弃（末段播完后迟到的 ended/error 不得再次置位或把状态翻成失败）。
        if (target !== handle) return
        handler(payload)
      })
      if (typeof unsubscribe === 'function') unsubscribes.push(unsubscribe)
    }
    bind('play', function () { setState('playing') })
    bind('pause', function () { setState('paused') })
    bind('stop', function () { if (state !== 'failed') setState('stopped') })
    bind('ended', function () { onSegmentEnded(token) })
    bind('interrupt', function (payload) { fail(classifyPlaybackFailure(payload || { code: 'PLAYBACK_INTERRUPTED' })) })
    bind('error', function (payload) { fail(classifyPlaybackFailure(payload)) })
  }

  /** 一段播完：还有下一段就继续，否则整份计划完成 ⇒ **真实端口**这时才允许置「已听取」。 */
  function onSegmentEnded(token) {
    if (released || token !== generation) return
    if (index + 1 < plan.length) {
      index += 1
      destroyHandle()
      startSegment()
      return
    }
    destroyHandle()
    if (substitute) {
      // 替身端口没有声音：只如实标记"替身播放已走完"，**绝不**置「已听取」。
      substituteCompleted = true
      setState('stopped')
      return
    }
    listened = true
    setState('stopped')
    onListened(snapshot())
  }

  function fail(info) {
    failure = Object.assign({}, info, { auto: autoInitiated })
    destroyHandle()
    setState('failed')
    onFailure(failure, snapshot())
  }

  function startSegment() {
    if (released) return
    const token = generation
    const current = plan[index]
    if (current === undefined) return
    setState('loading')
    let target
    try {
      target = player.create(current.src)
    } catch (error) {
      fail(classifyPlaybackFailure(error))
      return
    }
    if (target === null || typeof target !== 'object' || typeof target.play !== 'function') {
      fail(classifyPlaybackFailure({ code: 'SOURCE_UNAVAILABLE', reason: '播放端口未给出可用句柄' }))
      return
    }
    if (released || token !== generation) {
      // release()/换计划发生在 create 与 attach 之间（同步可插入）：立刻销毁，绝不留后台播放。
      try { target.stop() } catch (error) { /* 忽略 */ }
      try { target.destroy() } catch (error) { /* 忽略 */ }
      destroyedHandles += 1
      return
    }
    handle = target
    createdHandles += 1
    attach(target, token)
    try {
      target.play()
    } catch (error) {
      fail(classifyPlaybackFailure(error))
    }
  }

  /**
   * 开始播放一份计划。
   * @param {string|object|Array} sources 音频源（分段则给数组）
   * @param {{auto?:boolean}} [playOptions] `auto:true` 表示这次是**自动发起**的播放
   * @returns {{ok:boolean, code?:string}}
   */
  function play(sources, playOptions) {
    if (released) return { ok: false, code: 'RELEASED' }
    const next = normalizeSources(sources)
    if (next.length === 0) {
      autoInitiated = !!(playOptions && playOptions.auto)
      fail(classifyPlaybackFailure({ code: 'SOURCE_UNAVAILABLE', reason: '没有可播放的音频源' }))
      return { ok: false, code: 'SOURCE_UNAVAILABLE' }
    }
    if ((state === 'playing' || state === 'loading') && samePlan(plan, next)) {
      // 单一播放者：同一计划重复请求**不重复出声**（可复核判据：createdHandles 不变）。
      return { ok: false, code: 'ALREADY_PLAYING' }
    }
    generation += 1
    teardown(false)
    plan = next
    index = 0
    listened = false
    failure = null
    autoInitiated = !!(playOptions && playOptions.auto)
    startSegment()
    return { ok: true }
  }

  /**
   * 拆掉当前播放会话的内部状态：销毁句柄、退订监听、段号归零、「已听取」归零。
   * **不发布状态、不清空计划**（计划是纯字符串数组，保留它才能「重播」）；
   * 代次由调用方递增，因此拆掉之后任何迟到回调都不会生效。
   */
  function teardown(clearPlan) {
    destroyHandle()
    index = 0
    listened = false
    substituteCompleted = false
    if (clearPlan === true) plan = []
  }

  /** 暂停（不置「已听取」）。 */
  function pause() {
    if (released || handle === null) return { ok: false, code: 'NOT_PLAYING' }
    try { handle.pause() } catch (error) { /* 端口可能不支持 */ }
    if (state === 'playing') setState('paused')
    return { ok: true }
  }

  /** 继续（不置「已听取」）。 */
  function resume() {
    if (released || handle === null) return { ok: false, code: 'NOT_PLAYING' }
    try { handle.play() } catch (error) { /* 端口可能不支持 */ }
    return { ok: true }
  }

  /**
   * 用户主动停止：**不得**记为「已听取」（用户中断不是听取）。
   * 保留播报计划（纯字符串），因此停止后仍可「重播」；句柄与监听立即释放。
   */
  function stop() {
    if (released) return { ok: false, code: 'RELEASED' }
    if (handle === null && state !== 'loading' && state !== 'playing' && state !== 'paused') {
      return { ok: false, code: 'NOT_PLAYING' }
    }
    generation += 1
    teardown(false)
    failure = null
    setState('stopped')
    return { ok: true }
  }

  /** 重播：把同一份计划从头再播一次（先彻底停掉当前播放，避免叠音）。 */
  function replay() {
    if (released) return { ok: false, code: 'RELEASED' }
    if (plan.length === 0) return { ok: false, code: 'NOTHING_TO_REPLAY' }
    return play(plan.slice(), { auto: false })
  }

  /**
   * 释放：**离页/切页/隐藏的统一出口**。
   * 幂等；退订全部监听、销毁句柄、清空计划与失败态；此后任何迟到回调都不生效，
   * `play()` 也不会再创建句柄（后台残留的负例判据）。
   */
  function release() {
    if (released) return { ok: true, alreadyReleased: true }
    released = true
    generation += 1
    destroyHandle()
    plan = []
    index = 0
    listened = false
    substituteCompleted = false
    failure = null
    autoInitiated = false
    setState('idle')
    return { ok: true, listenerCount: unsubscribes.length, destroyedHandles: destroyedHandles }
  }

  return {
    play: play,
    pause: pause,
    resume: resume,
    stop: stop,
    replay: replay,
    release: release,
    snapshot: snapshot,
    isListened: function () { return listened === true },
    isReleased: function () { return released === true },
    listenerCount: function () { return unsubscribes.length },
    /** 供页面/回归核对：把播报计划分段（复用 speech-text 的无损分段）。 */
    segmentsFor: function (text, maxCodePoints) { return speechText.splitForSpeech(text, maxCodePoints) }
  }
}

module.exports = {
  PLAYBACK_STATES: PLAYBACK_STATES.slice(),
  FAILURE_CODES: FAILURE_CODES.slice(),
  classifyPlaybackFailure: classifyPlaybackFailure,
  createPlaybackController: createPlaybackController
}
