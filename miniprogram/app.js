/**
 * 应用入口（GY-I26）
 * ------------------------------------------------------------
 * 保留 main 的 GY-I04 登录会话与门禁；共享运行配置仍默认关闭联网。
 * 识别、OCR、语音与社区业务尚未接入，登录成功不代表这些能力完成。
 *
 * 字体适配（需求 4.1「适配微信字体设置」）：实测微信的字体设置不会自动放大
 * WXSS 中的 px，故这里主动读取缩放系数，由各页面根节点以 style 注入 CSS 变量
 * --font-scale，字号与触控区再用 calc() 乘以该系数。取值的字段语义、单位换算与
 * 回退顺序见 utils/system-font.js。
 *
 * 需求第 4.1 节未要求应用内字号开关，故**不设应用内档位、不读相关存储**，
 * 始终跟随微信「设置 → 通用 → 字体大小」。
 *
 * 启动与回到前台均读取微信设置；页面显示时再刷新并应用。
 */

const auth = require('./utils/auth')
const systemFont = require('./utils/system-font')

/** 缩放系数封顶倍数；标准值为 1 */
const MAX_FONT_SCALE = systemFont.MAX_FONT_SCALE
/** fontSizeSetting 的基准字号（px） */
const BASE_FONT_SIZE_PX = systemFont.BASE_FONT_SIZE_PX

/**
 * 计算生效的字号缩放系数，仅取微信系统设置。
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
  return systemFont.readSystemScale()
}

App({
  globalData: {
    /** 当前会话；null 表示游客 */
    session: null,
    /** 字体缩放系数，页面根节点以 style 注入 --font-scale */
    fontScale: 1
  },

  refreshFontScale() {
    this.globalData.fontScale = readFontScale()
    return this.globalData.fontScale
  },

  onShow() { this.refreshFontScale() },

  onLaunch() {
    this.globalData.session = auth.getSession()
    this.globalData.fontScale = readFontScale()
  }
})

module.exports = {
  MAX_FONT_SCALE,
  BASE_FONT_SIZE_PX,
  readFontScale
}