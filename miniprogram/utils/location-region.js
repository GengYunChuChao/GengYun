// 定位只用于即时选择地区（F02／AC21）：坐标仅在内存中交给调用方注入的地区转换资源，
// 不写入存储、不进入任何请求体、不跨次复用，也不做持续跟踪（不调用 startLocationUpdate／onLocationChange）。
// 本模块**不内置任何坐标→行政区数据**：转换资源未接入时如实返回 unavailable，由页面回退手选。
// 转换资源契约：convert(latitude, longitude) 返回浙江行政区代码（^33[0-9]{4}$）；
// 返回其他值／null 表示不在首版覆盖的浙江省；抛错表示转换失败。两种情况都回退手选。

const EXPLAIN = '定位只用于即时选择所在地区（浙江市县），不会持续跟踪，也不会保存原始坐标。取得地区后仍由你确认并保存。'

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
 */
function locate(wxApi, convert) {
  return new Promise(function (resolve) {
    let settled = false
    const finish = function (value) { if (!settled) { settled = true; resolve(value) } }
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
  EXPLAIN, MESSAGES, classify, locate,
  message: function (status) { return MESSAGES[status] || MESSAGES.failed }
}
