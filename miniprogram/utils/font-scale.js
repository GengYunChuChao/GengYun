/**
 * 字体缩放注入辅助（GY-I26）
 * ------------------------------------------------------------
 * 需求 4.1 要求「适配微信字体设置」。实测微信的 fontSizeSetting 不会自动放大
 * WXSS 中的 px，故由 app.js 读取该值换算为系数（封顶 1.3），页面根节点以
 * 内联 style 注入 CSS 变量 --font-scale，字号与触控区在 app.wxss 中用 calc()
 * 乘以该系数。
 *
 * 各页面在 data 中声明 fontScale，并在 onLoad 调用 applyFontScale(this)，
 * 根节点写法：<view class="page" style="--font-scale: {{fontScale}}">
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
    const value = app && app.globalData && app.globalData.fontScale
    if (typeof value === 'number' && value >= 1) {
      scale = value
    }
  } catch (err) {
    scale = DEFAULT_FONT_SCALE
  }
  if (page && typeof page.setData === 'function') {
    page.setData({ fontScale: scale })
  }
  return scale
}

module.exports = { DEFAULT_FONT_SCALE, applyFontScale }
