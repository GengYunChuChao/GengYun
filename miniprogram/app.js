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

function readFontScale() {
  let setting = null
  try {
    const info = wx.getSystemInfoSync()
    setting = info && info.fontSizeSetting
  } catch (err) {
    return 1
  }
  if (typeof setting !== 'number' || !isFinite(setting)) return 1
  if (setting < MIN_FONT_SCALE) return 1
  return Math.min(setting, MAX_FONT_SCALE)
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
