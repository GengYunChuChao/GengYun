/**
 * 字体缩放注入辅助（GY-I26）
 * ------------------------------------------------------------
 * 需求 4.1 要求「适配微信字体设置」。实测微信的字体设置不会自动放大 WXSS 中的 px，
 * 故由 app.js 读取缩放系数（优先官方 fontSizeScaleFactor 比例字段，缺失时才用
 * fontSizeSetting 的 px 值除以 16 换算；封顶 1.3），页面根节点以内联 style 注入
 * CSS 变量 --font-scale，字号与触控区在 app.wxss 中用 calc() 乘以该系数。
 *
 * 本文件只负责应用内档位的读写与注入；微信侧字段的读取与单位换算在 app.js。
 *
 * 各页面在 data 中声明 fontScale，并在 onLoad 调用 applyFontScale(this)，
 * 根节点写法：<view class="page" style="--font-scale: {{fontScale}}">
 */

/** 缺省系数；与 app.wxss 的 --font-scale 默认值一致 */
const DEFAULT_FONT_SCALE = 1
/** 封顶倍数，与 app.js 保持一致 */
const MAX_FONT_SCALE = 1.3
/** 应用内字号设置的存储键，与 app.js 保持一致 */
const FONT_SCALE_KEY = 'gengyun_font_scale'

/** 可选档位：标准／大／特大 */
const FONT_SCALE_CHOICES = [
  { value: 1, label: '标准' },
  { value: 1.15, label: '大' },
  { value: 1.3, label: '特大' }
]

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

function clamp(value) {
  if (typeof value !== 'number' || !isFinite(value)) return DEFAULT_FONT_SCALE
  if (value < DEFAULT_FONT_SCALE) return DEFAULT_FONT_SCALE
  return Math.min(value, MAX_FONT_SCALE)
}

/**
 * 写入应用内字号设置并立即生效。
 * 这是微信字体设置之外的独立可控途径（应用内不依赖系统字段，恒可用）。
 * 返回实际生效的系数；未登录也可使用，不涉及任何账号数据。
 */
function setFontScale(page, value) {
  const scale = clamp(value)
  try {
    wx.setStorageSync(FONT_SCALE_KEY, scale)
  } catch (err) {
    // 存储失败不阻断：本次会话仍可用，只是下次启动可能回到默认
  }
  try {
    const app = getApp()
    if (app && app.globalData) {
      app.globalData.fontScale = scale
    }
  } catch (err) {
    // app 未就绪时忽略
  }
  if (page && typeof page.setData === 'function') {
    page.setData({ fontScale: scale })
  }
  return scale
}

/** 读取当前生效的系数（应用内设置优先，其次微信设置） */
function currentFontScale() {
  try {
    const saved = wx.getStorageSync(FONT_SCALE_KEY)
    if (saved !== '' && saved !== null && saved !== undefined) {
      return clamp(saved)
    }
  } catch (err) {
    // 读不到则回落
  }
  try {
    const app = getApp()
    const value = app && app.globalData && app.globalData.fontScale
    if (typeof value === 'number') return clamp(value)
  } catch (err) {
    // app 未就绪
  }
  return DEFAULT_FONT_SCALE
}

/** 取系数对应的档位名称；非档位值返回「标准」 */
function labelOf(value) {
  const hit = FONT_SCALE_CHOICES.find((c) => c.value === clamp(value))
  return hit ? hit.label : '标准'
}

module.exports = {
  DEFAULT_FONT_SCALE,
  MAX_FONT_SCALE,
  FONT_SCALE_KEY,
  FONT_SCALE_CHOICES,
  applyFontScale,
  setFontScale,
  currentFontScale,
  labelOf
}
