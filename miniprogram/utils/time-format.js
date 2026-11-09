/**
 * 展示层时间格式化（GY-R92）
 * ------------------------------------------------------------
 * 服务端回传的时间一律是 ISO-8601 UTC（如 `2026-11-09T09:00:35.053Z`）。此前多个页面把它
 * 原样印在卡片标题行里：既不可读，又因为 24 个字符的定宽串把 `· 未读`／`· 作物编号` 挤到下一行。
 * 本模块把 ISO 串转成本地时间的中文说法，页面只调用这里的函数，不再各写一套 replace。
 *
 * 口径（任务书）：
 *   1 分钟内        → 刚刚
 *   1 小时内        → N 分钟前
 *   当天            → 今天 HH:mm
 *   昨天            → 昨天 HH:mm
 *   同年            → MM-DD
 *   跨年            → YYYY-MM-DD
 * 记录类时间（识别历史、收藏时间）用 `formatDateTime`，多带一个时刻：今天/昨天 HH:mm、MM-DD HH:mm。
 *
 * 边界：
 *   - 解析不了的值**原样返回**（不吞数据、不编造时间），空值返回空串；
 *   - 服务端时钟略快时差值为负，按「刚刚」处理，不渲染出「-3 分钟前」；
 *   - 一律用设备本地时区（`Date` 的 get* 系列），与用户看到的微信时钟一致。
 */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function toDate (value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null
  if (typeof value === 'number') {
    const stamp = new Date(value)
    return Number.isFinite(stamp.getTime()) ? stamp : null
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  const stamp = Date.parse(text)
  return Number.isFinite(stamp) ? new Date(stamp) : null
}

function pad2 (value) {
  return value < 10 ? '0' + value : String(value)
}

function clock (date) {
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/** 「HH:mm:ss」（本地）——同一分钟内会连出多行的时间线（识别进度、本机索引）用 */
function formatClock (value) { const date = toDate(value); return date ? clock(date) + ':' + pad2(date.getSeconds()) : fallback(value) }

function dayStart (date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 与 now 相差几个自然日（按本地零点计算，跨夏令时也成立）。 */
function dayGap (date, now) {
  return Math.round((dayStart(now) - dayStart(date)) / DAY)
}

function fallback (value) {
  return typeof value === 'string' ? value : ''
}

/** 「刚刚 / N 分钟前 / 今天 HH:mm / 昨天 HH:mm / MM-DD / YYYY-MM-DD」 */
function formatRelative (value, now) {
  const date = toDate(value)
  if (!date) return fallback(value)
  const base = toDate(now) || new Date()
  const diff = base.getTime() - date.getTime()
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return Math.floor(diff / MINUTE) + ' 分钟前'
  const gap = dayGap(date, base)
  if (gap <= 0) return '今天 ' + clock(date)
  if (gap === 1) return '昨天 ' + clock(date)
  if (date.getFullYear() === base.getFullYear()) return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

/** 「今天 HH:mm / 昨天 HH:mm / MM-DD HH:mm / YYYY-MM-DD HH:mm」——用于记录、收藏时间 */
function formatDateTime (value, now) {
  const date = toDate(value)
  if (!date) return fallback(value)
  const base = toDate(now) || new Date()
  const gap = dayGap(date, base)
  if (gap === 0) return '今天 ' + clock(date)
  if (gap === 1) return '昨天 ' + clock(date)
  if (date.getFullYear() === base.getFullYear()) return pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + clock(date)
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + clock(date)
}

/** 「YYYY-MM-DD」（本地）——用于「来源取得时间」这类只需要日期的位置 */
function formatDate (value) {
  const date = toDate(value)
  if (!date) return fallback(value)
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

module.exports = {
  formatRelative: formatRelative,
  formatDateTime: formatDateTime,
  formatDate: formatDate,
  formatClock: formatClock
}
