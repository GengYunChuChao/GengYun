/**
 * 应用入口（GY-I26）
 * ------------------------------------------------------------
 * 当前不接入任何业务服务：登录态固定为游客，识别、OCR、语音与社区
 * 均为未接入状态。真实登录会话由 GY-I04 服务端签发后接入。
 *
 * 字体适配（需求 4.1「适配微信字体设置」）：实测微信的字体设置不会自动放大
 * WXSS 中的 px，故这里主动读取缩放系数，由各页面根节点以 style 注入 CSS 变量
 * --font-scale，字号与触控区再用 calc() 乘以该系数。
 * 系数封顶 MAX_FONT_SCALE：字体放大后换行与容器宽度同步变化，不封顶会导致
 * 窄视口下布局破裂（显示大小最大档实测已出现换行增多）。
 */

const session = require('./utils/session')

/** 缩放系数封顶倍数；标准值为 1 */
const MAX_FONT_SCALE = 1.3
/** 低于该值视为异常，忽略并按 1 处理 */
const MIN_FONT_SCALE = 1
/**
 * fontSizeSetting 的基准字号（px）。
 * 微信官方类型定义：fontSizeSetting 为「用户字体大小（单位 px）」，标准值 16；
 * 比例字段是 fontSizeScaleFactor。故仅在比例字段不可用时才用 px 除以该基准换算。
 * @see https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts
 */
const BASE_FONT_SIZE_PX = 16
/** 应用内字号设置的存储键 */
const FONT_SCALE_KEY = 'gengyun_font_scale'

/** 应用内可选档位（标准／大／特大），与「我的」页面的选择项一一对应 */
const FONT_SCALE_CHOICES = [1, 1.15, 1.3]

function clampScale(value) {
  if (typeof value !== 'number' || !isFinite(value)) return 1
  if (value < MIN_FONT_SCALE) return 1
  return Math.min(value, MAX_FONT_SCALE)
}

/** 读取应用内显式设置；未设置过返回 null */
function readSavedScale() {
  try {
    const v = wx.getStorageSync(FONT_SCALE_KEY)
    return v === '' || v === null || v === undefined ? null : clampScale(v)
  } catch (err) {
    return null
  }
}

/**
 * 取一个合法的正数系数；非法或缺失返回 null。
 * 注意：0.9 这类「缩小」取值会被 clampScale 按 MIN_FONT_SCALE 归 1，
 * 属本应用的已知取舍（不因缩小字体而压缩版面），非字段读取错误。
 */
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

/** 末选：把 px 字号按 BASE_FONT_SIZE_PX 换算为倍率（16px → 1，20px → 1.25） */
function readFactorFromPx(fontSizeSetting) {
  const px = readPositive(fontSizeSetting)
  return px === null ? null : px / BASE_FONT_SIZE_PX
}

/**
 * 计算生效的字号缩放系数。
 * 优先级：应用内显式设置 > fontSizeScaleFactor（比例字段） > fontSizeSetting/16（px 换算） > 1。
 *
 * 单位说明：fontSizeSetting 是 px，不能直接当倍率——早期实现把它直接喂给
 * clampScale，导致 16/18/20 三档微信字号全部被截断到 1.3，标准档被强制放大 30%。
 * 现按官方语义优先取 fontSizeScaleFactor，仅在比例字段缺失时才用 px 换算。
 *
 * 已知限制：微信若提供小于 1 的缩放（用户选「较小」），本实现按 MIN_FONT_SCALE
 * 归 1，不做缩小。待真机确认微信是否允许该方向后再决定是否放开。
 */
function readFontScale() {
  const saved = readSavedScale()
  if (saved !== null) return saved

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

App({
  globalData: {
    /** 当前会话；null 表示游客 */
    session: null,
    /** 字体缩放系数，页面根节点以 style 注入 --font-scale */
    fontScale: 1
  },

  onLaunch() {
    this.globalData.session = session.read()
    this.globalData.fontScale = readFontScale()
  }
})

module.exports = {
  MAX_FONT_SCALE,
  BASE_FONT_SIZE_PX,
  FONT_SCALE_CHOICES,
  FONT_SCALE_KEY,
  readFontScale,
  readSavedScale
}
