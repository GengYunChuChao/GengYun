// 定位只用于即时选择地区（F02／AC21）：坐标仅在内存中交给调用方注入的地区转换资源，
// 不写入存储、不进入任何请求体、不跨次复用，也不做持续跟踪（不调用 startLocationUpdate／onLocationChange）。
// 本模块**不内置任何坐标→行政区数据**：转换资源未接入时如实返回 unavailable，由页面回退手选。
// 转换资源契约：convert(latitude, longitude) 返回浙江行政区代码（^33[0-9]{4}$）；
// 返回其他值／null 表示不在首版覆盖的浙江省；抛错表示转换失败。两种情况都回退手选。

const EXPLAIN = '定位只用于即时选择所在地区（浙江市县），不会持续跟踪，也不会保存原始坐标。取得地区后仍由你确认并保存。'

// 兜底超时（AC21 的「超时」必须是一个**可达的显式状态**，而不是只靠平台 errMsg）：
// wx.getLocation 在系统授权弹窗被长时间挂起、或被某些 Android 机型吞掉回调时可能**永不回调**
// （success／fail 都不来）。没有兜底时 Promise 永不结算，页面停在「正在获取位置…」且定位入口
// 长期不可再点——那正是一种没有状态、没有出口的挂死，比报超时更糟。
// 因此这里加一道**墙钟兜底**：到点即结算 { status: 'timeout' }，页面按既有六档文案回落手选。
// 取值 15000ms 的理由：既要覆盖系统弹窗前的正常链路（通常 1–3s），又要给用户读弹窗后做决定
// 留出余量；真超出 15s 才报超时，且超时后手选仍可用、可再次点定位（权限已授予时立即返回）。
// 兜底不是「失败」：它不改端点、不新增错误码、不写存储、不重试、不上报，坐标仍只在内存里。
const LOCATE_TIMEOUT_MS = 15000

// 计时器只用于兜底，不参与坐标处理。测试可显式注入（settings.timer），传 null 表示「不设兜底」。
function defaultTimer() {
  if (typeof setTimeout !== 'function') return null
  return {
    setTimeout: function (fn, ms) { return setTimeout(fn, ms) },
    clearTimeout: typeof clearTimeout === 'function' ? function (id) { clearTimeout(id) } : null
  }
}

const MESSAGES = {
  denied: '未获得定位授权，可继续手选浙江市县。',
  cancelled: '已取消定位，可继续手选浙江市县。',
  timeout: '定位超时，可继续手选浙江市县。',
  failed: '定位不可用或平台不支持，可继续手选浙江市县。',
  out_of_coverage: '当前位置不在首版覆盖的浙江省内，请手选浙江市县。',
  unavailable: '地区转换资源尚未接入，请手选浙江市县。'
}
const AUTH_FAILURES = ['auth deny', 'auth denied', 'authorize', 'authorization', 'permission deny']
function classify(errMsg) {
  const text = typeof errMsg === 'string' ? errMsg.toLowerCase() : ''
  if (AUTH_FAILURES.some(function (item) { return text.indexOf(item) !== -1 })) return 'denied'
  if (text.indexOf('cancel') !== -1) return 'cancelled'
  if (text.indexOf('timeout') !== -1) return 'timeout'
  return 'failed'
}
function regionCode(value) { return typeof value === 'string' && /^33[0-9]{4}$/.test(value) ? value : null }
/**
 * 请求一次即时定位并转换地区。resolve 的结果只含 status 与可选 region_code：
 * 坐标既不出现在返回值里，也不由本模块保存。
 *
 * settings（可选，仅供测试与显式装配）：
 *   · timeoutMs —— 墙钟兜底毫秒数，缺省 LOCATE_TIMEOUT_MS；非正数／非有限值一律退回缺省。
 *   · timer     —— { setTimeout, clearTimeout } 计时器替身；传 null 表示本次不设兜底。
 * 结算语义（与改前一致，只多「超时」这一档来源）：
 *   · 一次 locate 只结算一次，首个到达的结算（平台回调或兜底超时）定结果，其后一律不改写；
 *   · 超时结算后平台迟到的 success **不会**把结果改成 ok（避免「先报超时又偷偷改成功」），
 *     也不会写存储／发请求；
 *   · 结算时清掉兜底计时器，不留悬挂计时器。
 */
function locate(wxApi, convert, settings) {
  const options = settings && typeof settings === 'object' ? settings : {}
  const timer = options.timer === null ? null : (options.timer || defaultTimer())
  const delay = typeof options.timeoutMs === 'number' && isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : LOCATE_TIMEOUT_MS
  return new Promise(function (resolve) {
    let settled = false
    let handle = null
    const stopTimer = function () {
      if (handle !== null && timer && typeof timer.clearTimeout === 'function') {
        try { timer.clearTimeout(handle) } catch (error) { /* 清理失败不影响结算 */ }
      }
      handle = null
    }
    const finish = function (value) { if (!settled) { settled = true; stopTimer(); resolve(value) } }
    // 先装兜底再发请求：平台同步回调也能被 settled 正确挡住，计时器随后被清掉。
    if (timer && typeof timer.setTimeout === 'function') {
      try {
        handle = timer.setTimeout(function () { handle = null; finish({ status: 'timeout' }) }, delay)
        if (handle !== null && typeof handle === 'object' && typeof handle.unref === 'function') handle.unref()
      } catch (error) { handle = null }
    }
    if (!wxApi || typeof wxApi.getLocation !== 'function') { finish({ status: 'failed' }); return }
    try {
      wxApi.getLocation({ type: 'wgs84', success: function (position) {
        if (typeof convert !== 'function') { finish({ status: 'unavailable' }); return }
        let code = null
        try { code = regionCode(convert(position && position.latitude, position && position.longitude)) }
        catch (error) { finish({ status: 'failed' }); return }
        finish(code ? { status: 'ok', region_code: code } : { status: 'out_of_coverage' })
      }, fail: function (error) { finish({ status: classify(error && error.errMsg) }) } })
    } catch (error) { finish({ status: 'failed' }) }
  })
}
module.exports = {
  EXPLAIN, MESSAGES, LOCATE_TIMEOUT_MS, classify, locate,
  message: function (status) { return MESSAGES[status] || MESSAGES.failed }
}
