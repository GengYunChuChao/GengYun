// GY-I13 **自动播报策略**（原生小程序侧；判定是纯函数，存储是注入端口，不触碰 wx / 网络）。
//
// 为什么需要这一层（口径来源）：
// - `docs/architecture/state-contract.md:64`：「同一页同一版本自动播报一次，离页/隐藏停止」。
//   页面上原本是「合成落定就自动播」，同一 `checked_content_ref` 的**同一 revision** 被再次提交时
//   会二次出声 —— 这与「同一页同一版本自动播报一次」不符。本模块把「要不要自动出声」这一判定
//   从页面里抽出来，做成可单测、可复核、可关闭的策略。
// - 自动出声是**打扰性**副作用：用户必须能关掉它（`enabled` 开关），关掉后**文字与主动播放按钮
//   照常可用**（不是"关掉就等于没有播报能力"）。
//
// fail-closed 纪律（与 `speech-text.js` 的闸门同向）：
// 1. 偏好读不出来（存储抛错/形态不认识）⇒ **不自动播报**，并在文案里如实说明"读不到偏好，按不自动处理"，
//    而不是擅自出声、也不是静默。
// 2. 缺少版本化目标引用（`type/id/revision` 任一不可用）⇒ **无法判定**"同一版本是否已播报"⇒ 不自动播报。
// 3. 没有可播分段 ⇒ 不自动播报（由页面如实走失败出口，见 `pages/voice/voice.js` 的 `afterSynthesis`）。
// 4. 本模块**只决定"是否自动出声"**：它不合成、不造音频、不写「已听取」，也不放宽任何安全检查。
'use strict'

/** 偏好存储键（页面级偏好，只存一个布尔；不含任何内容/账号信息）。 */
const STORAGE_KEY = 'gengyun_speech_autoplay'

/** 默认**开启**：F12/AC06 要求"完成核对后自动播报"；关闭是用户显式选择。 */
const DEFAULT_ENABLED = true

/**
 * 决策码：**客户端本地**原因码（小写连字符命名）。
 *
 * 约定：它们**不是**契约 `ErrorCode`（契约闭集在 `packages/contracts`，本模块不新增、不扩展），
 * 也不出现在任何请求/响应里，只用于本页文案与测试断言。
 */
const CODES = Object.freeze({
  AUTO: 'auto-speak-enabled',
  USER_DISABLED: 'auto-speak-disabled',
  PREFERENCE_UNREADABLE: 'auto-speak-preference-unreadable',
  EMPTY_PLAN: 'auto-speak-empty-plan',
  MISSING_TARGET_REF: 'auto-speak-missing-target-ref',
  ALREADY_PLAYED: 'auto-speak-already-played'
})

/** 决策码 → 页面可展示的一行说明（只做措辞，不改变判定）。 */
const REASON_TEXT = Object.freeze({
  'auto-speak-enabled': '自动播报已开启：本次会自动播报已核对内容。',
  'auto-speak-disabled': '自动播报已关闭：本次不自动出声；文字内容照常显示，可用「播放」按钮主动播放。',
  'auto-speak-preference-unreadable': '读不到「自动播报」偏好（存储不可用）：已按「不自动播报」处理，'
    + '不会擅自出声；可用「播放」按钮主动播放。',
  'auto-speak-empty-plan': '没有可播报的音频源：本次不会自动播报（如实走失败出口，不伪造音频）。',
  'auto-speak-missing-target-ref': '缺少版本化内容引用（type/id/revision）：无法判定「同一页同一版本是否已播报」，'
    + '本次不自动播报；可用「播放」按钮主动播放。',
  'auto-speak-already-played': '同一页同一版本已自动播报过一次：不再重复出声；需要时可点「重播」。'
})

/**
 * 版本化目标键（`type:id:revision`）。
 *
 * 三个字段都必须取自契约值且形态成立，否则返回 `null`（调用方按「无法判定」处理，不猜）。
 * `revision` 必须为 ≥1 的整数：字符串 `'1'`、`1.5`、`0` 一律不认（避免把不同版本当成同一版本）。
 */
function targetKeyFor(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null
  const type = ref.type
  const id = ref.id
  const revision = ref.revision
  if (typeof type !== 'string' || type.trim() === '') return null
  if (typeof id !== 'string' || id.trim() === '') return null
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  return type + ':' + id + ':' + revision
}

function reasonTextOf(code) {
  return REASON_TEXT[code] || '自动播报状态未知：已按「不自动播报」处理，不会擅自出声。'
}

function manual(code, extra) {
  return Object.assign({ auto: false, code: code, reason: reasonTextOf(code) }, extra || {})
}

/**
 * 建一个**页面作用域**的自动播报策略。
 *
 * @param {{store?:{read:function():unknown, write?:function(unknown):void}}} [options]
 *   `store` 是**注入**的偏好存储端口（页面用 `createStorageStore()` 接到 wx 存储；
 *   测试用内存实现）。缺省（不传）＝只用默认值、不持久化。
 */
function createAutoSpeakPolicy(options) {
  const store = options && options.store ? options.store : null
  /** 本页已自动播报过的版本键（**页面作用域**：页面重建即清空，正是「同一页同一版本一次」）。 */
  const played = []
  let cached = null
  let unreadable = false

  function readPreference() {
    if (cached !== null) return cached
    let enabled = DEFAULT_ENABLED
    if (store !== null && typeof store.read === 'function') {
      try {
        const raw = store.read()
        if (raw === true || raw === false) enabled = raw
        else if (raw && typeof raw === 'object' && typeof raw.enabled === 'boolean') enabled = raw.enabled
        // 其它任何形态（空串、缺字段、被别的东西占用的键）⇒ 视为**未设置**，用默认值；
        // 这是"没有偏好"而不是"读不到偏好"，不需要 fail-closed 到关闭。
      } catch (error) {
        unreadable = true
        enabled = false // 读不到 ⇒ 不擅自出声（fail-closed），文案如实说明
      }
    }
    cached = { enabled: enabled }
    return cached
  }

  return {
    storageKey: STORAGE_KEY,

    /** 当前是否允许自动播报（读不到偏好时为 false）。 */
    isEnabled: function () {
      return readPreference().enabled === true
    },

    /** 偏好读取是否失败过（页面据此写出"读不到偏好"的如实说明）。 */
    isPreferenceUnreadable: function () {
      readPreference()
      return unreadable === true
    },

    /**
     * 写入用户选择。返回 `{enabled, persisted}`：`persisted===false` 表示**没有保存成功**
     * （存储不可用），此时只在当前页面生效 —— 页面必须如实说明，不得声称"已记住"。
     */
    setEnabled: function (next) {
      const enabled = next === true
      cached = { enabled: enabled }
      unreadable = false
      // 没有存储端口 ⇒ 没什么可"保存"：如实返回 persisted:false（不声称已记住）。
      let persisted = false
      if (store !== null && typeof store.write === 'function') {
        try {
          store.write({ enabled: enabled })
          persisted = true
        } catch (error) {
          persisted = false
        }
      }
      return { enabled: enabled, persisted: persisted }
    },

    /**
     * 判定这一次"合成落定"要不要自动出声。
     *
     * @param {{targetRef?:object, targetKey?:string, planSize?:number}} [input]
     * @returns {{auto:boolean, code:string, reason:string, targetKey:(string|null)}}
     */
    decide: function (input) {
      const request = input || {}
      const preference = readPreference()
      const planSize = typeof request.planSize === 'number' && request.planSize > 0 ? request.planSize : 0
      const key = typeof request.targetKey === 'string' && request.targetKey !== ''
        ? request.targetKey
        : targetKeyFor(request.targetRef)
      if (planSize === 0) return manual(CODES.EMPTY_PLAN, { targetKey: key })
      if (unreadable === true) return manual(CODES.PREFERENCE_UNREADABLE, { targetKey: key })
      if (preference.enabled !== true) return manual(CODES.USER_DISABLED, { targetKey: key })
      if (key === null || key === '') return manual(CODES.MISSING_TARGET_REF, { targetKey: null })
      if (played.indexOf(key) !== -1) return manual(CODES.ALREADY_PLAYED, { targetKey: key })
      return { auto: true, code: CODES.AUTO, reason: reasonTextOf(CODES.AUTO), targetKey: key }
    },

    /**
     * 记下"这个版本已经自动播报过"（幂等）。
     *
     * 调用纪律：**只在真的发起了自动播报之后**调用；被拒绝/失败/未发起时不得预先记账，
     * 否则会出现"页面说播过了、其实一次都没出声"。
     */
    markAutoPlayed: function (key) {
      if (typeof key !== 'string' || key === '') return this.playedKeys()
      if (played.indexOf(key) === -1) played.push(key)
      return this.playedKeys()
    },

    playedKeys: function () {
      return played.slice()
    },

    /** 清空本页的"已自动播报"记录（换内容源/重进页面时用；不改变用户偏好）。 */
    reset: function () {
      played.length = 0
      return this.playedKeys()
    }
  }
}

/**
 * 平台存储端口（唯一引用 wx 存储的地方，页面只经本函数拿端口）。
 *
 * 平台对象在**调用时**读取（模块加载期可能还没有 `wx`）；平台缺失/抛错一律向上抛，
 * 由策略的 try/catch 落成"读不到偏好 ⇒ 不自动播报"，而不是静默当成默认值。
 */
function createStorageStore(platform) {
  const host = platform || (typeof wx !== 'undefined' ? wx : null)
  return {
    read: function () {
      if (host === null || typeof host.getStorageSync !== 'function') throw new Error('storage-unavailable')
      return host.getStorageSync(STORAGE_KEY)
    },
    write: function (value) {
      if (host === null || typeof host.setStorageSync !== 'function') throw new Error('storage-unavailable')
      host.setStorageSync(STORAGE_KEY, value)
    }
  }
}

module.exports = {
  STORAGE_KEY: STORAGE_KEY,
  DEFAULT_ENABLED: DEFAULT_ENABLED,
  CODES: CODES,
  REASON_TEXT: REASON_TEXT,
  targetKeyFor: targetKeyFor,
  reasonTextOf: reasonTextOf,
  createAutoSpeakPolicy: createAutoSpeakPolicy,
  createStorageStore: createStorageStore
}
