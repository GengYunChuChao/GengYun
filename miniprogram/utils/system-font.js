/**
 * 微信系统字体设置读取与换算（GY-I26）
 * ------------------------------------------------------------
 * 需求 4.1「适配微信字体设置」的取值层。app.js 负责决定优先级并把结果缓存到
 * globalData；「我的」页的「跟随系统」档位需要绕过应用内存储强制走本模块，
 * 故独立成模块，避免 UI 反向依赖 App 生命周期。
 *
 * 单位说明（微信官方类型定义，types/wx/lib.wx.api.d.ts）：
 *   fontSizeSetting      用户字体大小，**单位 px**，标准值 16
 *   fontSizeScaleFactor  用户字体大小的**缩放比例**，才是倍率字段
 *
 * 早期实现把 fontSizeSetting 的 px 值直接当倍率传入 clampScale，使 16/18/20
 * 三档全部被截断到 1.3（标准档被强制放大 30%）。现按官方语义处理。
 */

/** 缩放系数封顶倍数；标准值为 1 */
const MAX_FONT_SCALE = 1.3
/** 低于该值视为异常；本应用不做缩小，统一归 1 */
const MIN_FONT_SCALE = 1
/** fontSizeSetting 的基准字号（px） */
const BASE_FONT_SIZE_PX = 16

function clampScale(value) {
  if (typeof value !== 'number' || !isFinite(value)) return 1
  if (value < MIN_FONT_SCALE) return 1
  return Math.min(value, MAX_FONT_SCALE)
}

/** 取一个合法的正数；非法或缺失返回 null */
function readPositive(value) {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) return null
  return value
}

/** 首选 wx.getFontSizeManager()：官方同时给出 fontSizeSetting(px) 与 fontSizeScaleFactor */
function readFactorFromManager() {
  if (typeof wx.getFontSizeManager !== 'function') return null
  const manager = wx.getFontSizeManager()
  return manager ? readPositive(manager.fontSizeScaleFactor) : null
}

/** 次选 getSystemInfoSync().fontSizeScaleFactor（部分基础库版本直接挂在系统信息上） */
function readFactorFromSystemInfo(info) {
  return info ? readPositive(info.fontSizeScaleFactor) : null
}

/** 末选：把 px 字号按 BASE_FONT_SIZE_PX 换算为倍率（16px → 1，26px → 1.625） */
function readFactorFromPx(fontSizeSetting) {
  const px = readPositive(fontSizeSetting)
  return px === null ? null : px / BASE_FONT_SIZE_PX
}

/**
 * 只读微信系统设置并换算为系数，**不看应用内存储**。
 * 优先级：getFontSizeManager().fontSizeScaleFactor > getSystemInfoSync().fontSizeScaleFactor
 *        > fontSizeSetting / 16。
 * 比例 API 抛错时继续下探至 px 换算，全部不可用时回落 1。
 *
 * @returns {number} 1 ～ MAX_FONT_SCALE 之间的系数
 */
function readSystemScale() {
  let factor = null
  try {
    factor = readFactorFromManager()
  } catch (err) {
    factor = null
  }
  if (factor !== null) return clampScale(factor)

  let info = null
  try {
    info = wx.getSystemInfoSync()
  } catch (err) {
    return 1
  }

  factor = readFactorFromSystemInfo(info)
  if (factor !== null) return clampScale(factor)

  return clampScale(readFactorFromPx(info && info.fontSizeSetting))
}

module.exports = {
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  BASE_FONT_SIZE_PX,
  clampScale,
  readSystemScale
}