/**
 * 应用入口（GY-I26）
 * ------------------------------------------------------------
 * 当前不接入任何业务服务：登录态固定为游客，识别、OCR、语音与社区
 * 均为未接入状态。真实登录会话由 GY-I04 服务端签发后接入。
 *
 * 字体适配（需求 4.1「适配微信字体设置」）：实测微信的字体设置不会自动放大
 * WXSS 中的 px，故这里主动读取缩放系数，由各页面根节点以 style 注入 CSS 变量
 * --font-scale，字号与触控区再用 calc() 乘以该系数。取值的字段语义、单位换算与
 * 回退顺序见 utils/system-font.js。
 *
 * 优先级：应用内显式档位 > 微信系统设置 > 1。
 * 「跟随系统」档位不写应用内存储，readSavedScale() 返回 null 时即落到微信设置。
 *
 * 已知限制：系数只在 onLaunch 计算一次，用户改动微信字体设置后回到小程序不会
 * 自动重算，需重新进入才生效；profile 页文案已注明该前提。
 */

const session = require('./utils/session')
const systemFont = require('./utils/system-font')

/** 缩放系数封顶倍数；标准值为 1 */
const MAX_FONT_SCALE = systemFont.MAX_FONT_SCALE
/** fontSizeSetting 的基准字号（px） */
const BASE_FONT_SIZE_PX = systemFont.BASE_FONT_SIZE_PX
/** 应用内字号设置的存储键 */
const FONT_SCALE_KEY = 'gengyun_font_scale'

/**
 * 应用内可选档位（value 为 null 表示「跟随系统」，不写存储）。
 * 与「我的」页面的选择项一一对应，见 utils/font-scale.js 的 FONT_SCALE_CHOICES。
 */
const FONT_SCALE_CHOICES = [null, 1.15, 1.3]

function clampScale(value) {
  return systemFont.clampScale(value)
}

/** 读取应用内显式设置；未设置过（含「跟随系统」）返回 null */
function readSavedScale() {
  try {
    const v = wx.getStorageSync(FONT_SCALE_KEY)
    return v === '' || v === null || v === undefined ? null : clampScale(v)
  } catch (err) {
    return null
  }
}

/**
 * 计算生效的字号缩放系数。
 * 优先级：应用内显式设置 > 微信系统设置 > 1。
 *
 * 单位说明：fontSizeSetting 是 px，不能直接当倍率——早期实现把它直接喂给
 * clampScale，导致 16/18/20 三档微信字号全部被截断到 1.3，标准档被强制放大 30%。
 * 现按官方语义由 utils/system-font.js 处理，优先取 fontSizeScaleFactor 比例字段，
 * 仅在比例字段缺失时才用 px 除以基准换算。
 *
 * 已知限制：微信若提供小于 1 的缩放（用户选「较小」），本实现按 MIN_FONT_SCALE
 * 归 1，不做缩小。待真机确认微信是否有该方向后再决定是否放开。
 */
function readFontScale() {
  const saved = readSavedScale()
  if (saved !== null) return saved
  return systemFont.readSystemScale()
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