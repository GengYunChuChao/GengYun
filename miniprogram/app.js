/**
 * 应用入口（GY-I26）
 * ------------------------------------------------------------
 * 当前不接入任何业务服务：登录态固定为游客，识别、OCR、语音与社区
 * 均为未接入状态。真实登录会话由 GY-I04 服务端签发后接入。
 *
 * 字体适配（需求 4.1「适配微信字体设置」）：实测微信的 fontSizeSetting 不会
 * 自动放大 WXSS 中的 px，故这里主动读取该值并换算为缩放系数，由各页面根节点
 * 以 style 注入 CSS 变量 --font-scale，字号与触控区再用 calc() 乘以该系数。
 * 系数封顶 MAX_FONT_SCALE：字体放大后换行与容器宽度同步变化，不封顶会导致
 * 窄视口下布局破裂（显示大小最大档实测已出现换行增多）。
 */

const session = require('./utils/session')

/** fontSizeSetting 封顶倍数；标准值为 1 */
const MAX_FONT_SCALE = 1.3
/** 低于该值视为异常，忽略并按 1 处理 */
const MIN_FONT_SCALE = 1
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
 * 计算生效的字号缩放系数。
 * 优先级：应用内显式设置 > 微信 fontSizeSetting > 1。
 *
 * 微信的「设置→通用→字体大小」不会反映到 fontSizeSetting（真机实测恒为 1，
 * 模拟器才有调试项），因此真机上唯一可控途径是应用内设置。
 */
function readFontScale() {
  const saved = readSavedScale()
  if (saved !== null) return saved
  let setting = null
  try {
    const info = wx.getSystemInfoSync()
    setting = info && info.fontSizeSetting
  } catch (err) {
    return 1
  }
  return clampScale(setting)
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

module.exports = { MAX_FONT_SCALE, FONT_SCALE_CHOICES, FONT_SCALE_KEY, readFontScale, readSavedScale }
