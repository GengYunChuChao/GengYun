/**
 * 字体缩放注入辅助（GY-I26）
 * ------------------------------------------------------------
 * 需求第 4.1 节只要求「适配微信字体设置」，**未要求应用内字号开关**，故本模块
 * 不提供任何档位 UI 或本地存储，始终跟随微信设置。
 *
 * 取值链路：app.js 在 onLaunch 调用 utils/system-font.js 的 readSystemScale()
 * 读出微信「设置 → 通用 → 字体大小」并换算为系数（fontSizeSetting 的 px 值 ÷16，
 * 封顶 1.3），存入 globalData.fontScale；各页面根节点以
 *   <view class="page" style="--font-scale: {{fontScale}}">
 * 注入 CSS 变量，app.wxss 中字号与触控区再用 calc() 乘以该系数。
 *
 * 页面显示时调用 App.refreshFontScale() 重新读取实际微信接口。
 *
 * 各页面在 onLoad 调用 applyFontScale(this)。
 */

/** 缺省系数；与 app.wxss 的 --font-scale 默认值一致 */
const DEFAULT_FONT_SCALE = 1

/**
 * 把 app.globalData.fontScale 写入页面 data。
 * 取不到时回落为 1，保证标准字号下界面与此前一致。
 */
function applyFontScale(page) {
  let scale = DEFAULT_FONT_SCALE
  try {
    const app = getApp()
    if (app && typeof app.refreshFontScale === 'function') app.refreshFontScale()
    const value = app && app.globalData && app.globalData.fontScale
    if (typeof value === 'number' && value >= 1) {
      scale = value
    }
  } catch (err) {
    scale = DEFAULT_FONT_SCALE
  }
  if (page && typeof page.setData === 'function') {
    page.setData({ fontScale: scale })
    const bar = typeof page.getTabBar === 'function' ? page.getTabBar() : null
    if (bar) bar.setData({ selected: page.route, fontScale: scale })
  }
  return scale
}

/** 读取当前生效的系数（onLaunch 已按微信设置算好） */
function currentFontScale() {
  try {
    const app = getApp()
    if (app && typeof app.refreshFontScale === 'function') app.refreshFontScale()
    const value = app && app.globalData && app.globalData.fontScale
    if (typeof value === 'number' && value >= 1) return value
  } catch (err) {
    // app 未就绪
  }
  return DEFAULT_FONT_SCALE
}

module.exports = {
  DEFAULT_FONT_SCALE,
  applyFontScale,
  currentFontScale
}