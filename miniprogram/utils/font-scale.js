/**
 * 字体缩放注入与档位设置（GY-I26）
 * ------------------------------------------------------------
 * 需求 4.1 要求「适配微信字体设置」。实测微信的字体设置不会自动放大 WXSS 中的 px，
 * 故由 app.js 计算缩放系数（见 utils/system-font.js 的字段语义与换算），页面根节点
 * 以内联 style 注入 CSS 变量 --font-scale，字号与触控区在 app.wxss 中用 calc()
 * 乘以该系数。
 *
 * 各页面在 data 中声明 fontScale 与 savedScale，并在 onLoad 调用
 * applyFontScale(this)，根节点写法：
 *   <view class="page" style="--font-scale: {{fontScale}}">
 *
 * 两个字段的分工：
 *   fontScale   实际生效的数值系数，用于注入 CSS 变量
 *   savedScale  用户显式选择的档位（null 表示「跟随系统」），**仅用于判断选中态**
 * 二者必须分开：微信特大时 fontScale 为 1.3，但 savedScale 仍是 null（跟随系统），
 * 若用 fontScale 判断选中会错误地高亮「特大」档。
 *
 * 本文件只负责应用内档位的读写与注入；微信侧字段读取在 utils/system-font.js。
 */

const systemFont = require('./system-font')

/** 缺省系数；与 app.wxss 的 --font-scale 默认值一致 */
const DEFAULT_FONT_SCALE = 1
/** 封顶倍数，与 system-font.js 保持一致 */
const MAX_FONT_SCALE = systemFont.MAX_FONT_SCALE
/** 应用内字号设置的存储键，与 app.js 保持一致 */
const FONT_SCALE_KEY = 'gengyun_font_scale'

/**
 * 可选档位：跟随系统／大／特大。
 * 「跟随系统」的 value 为 null —— 不写应用内存储，由 readSystemScale() 取微信设置。
 * 保留「特大」1.3 是因为微信设置即使调到最大也只到 1.3（本应用封顶），
 * 用户若想要一个明确的固定倍率仍需此项。
 */
const FONT_SCALE_CHOICES = [
  { value: null, label: '跟随系统' },
  { value: 1.15, label: '大' },
  { value: 1.3, label: '特大' }
]

/**
 * 读取应用内显式档位。
 * @returns {number|null} null 表示「跟随系统」或未设置过
 */
function savedScaleValue() {
  try {
    const v = wx.getStorageSync(FONT_SCALE_KEY)
    if (v === '' || v === null || v === undefined) return null
    return systemFont.clampScale(v)
  } catch (err) {
    return null
  }
}

/**
 * 把 app.globalData.fontScale 与当前档位写入页面 data。
 * 取不到系数时回落为 1，保证标准字号下界面与此前一致。
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
    page.setData({ fontScale: scale, savedScale: savedScaleValue() })
  }
  return scale
}

/**
 * 生成供渲染的档位列表。
 * 「跟随系统」没有固定倍率，以实际生效系数渲染，做到所见即所得；
 * 其余档位按自身 value 渲染，便于用户预览放大后的效果。
 */
function buildChoices(applied) {
  return FONT_SCALE_CHOICES.map((c) => ({
    value: c.value,
    label: c.label,
    render: c.value === null ? applied : c.value
  }))
}

/**
 * 写入应用内字号设置并立即生效。
 * 传 null（跟随系统）时清除存储并改用微信设置换算。
 * 返回实际生效的系数；未登录也可使用，不涉及任何账号数据。
 */
function setFontScale(page, value) {
  let scale
  if (value === null || value === undefined || value === '' || value === 'null') {
    try {
      wx.removeStorageSync(FONT_SCALE_KEY)
    } catch (err) {
      // 存储清理失败不阻断：仍按微信设置渲染，本次会话可用
    }
    scale = systemFont.readSystemScale()
  } else {
    scale = systemFont.clampScale(Number(value))
    try {
      wx.setStorageSync(FONT_SCALE_KEY, scale)
    } catch (err) {
      // 存储失败不阻断：本次会话仍可用，只是下次启动可能回到默认
    }
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
    page.setData({ fontScale: scale, savedScale: savedScaleValue() })
  }
  return scale
}

/** 读取当前生效的系数（onLaunch 已算好，含微信设置换算结果） */
function currentFontScale() {
  try {
    const app = getApp()
    const value = app && app.globalData && app.globalData.fontScale
    if (typeof value === 'number') return systemFont.clampScale(value)
  } catch (err) {
    // app 未就绪
  }
  return DEFAULT_FONT_SCALE
}

/** 取系数或档位对应的名称；null／未命中返回「跟随系统」 */
function labelOf(value) {
  if (value === null || value === undefined || value === '') return '跟随系统'
  const hit = FONT_SCALE_CHOICES.find((c) => c.value === systemFont.clampScale(value))
  return hit ? hit.label : '跟随系统'
}

module.exports = {
  DEFAULT_FONT_SCALE,
  MAX_FONT_SCALE,
  FONT_SCALE_KEY,
  FONT_SCALE_CHOICES,
  savedScaleValue,
  applyFontScale,
  buildChoices,
  setFontScale,
  currentFontScale,
  labelOf
}