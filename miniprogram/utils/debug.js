const runtime = require('../config/runtime')

function localEnabled(wxApi) {
  if (runtime.mode !== 'local') return false
  try { return wxApi.getAccountInfoSync().miniProgram.envVersion === 'develop' } catch (_) { return false }
}

/**
 * 本地替身连接自检。
 *
 * B7：#28 要求失败/空态口径统一，但原先回调只回传一句文本，页面无法判断「这是失败」
 * 还是「这是结果说明」，只能把两种情况混成一行灰字。这里给回调加第二参数 `passed`
 * （true=自检通过，false=未通过），属**追加**而非改语义：既有只取第一个参数的调用方
 * （tests/local-debug.test.mjs 的 `text => { message = text }`）行为不变。
 */
function diagnose(wxApi, report) {
  if (!localEnabled(wxApi)) { report('当前工程未启用本地诊断。', false); return }
  wxApi.request({
    url: runtime.apiBaseUrl + '/__local__/status',
    method: 'GET', timeout: 5000,
    success: function (res) {
      const body = res.data
      if (res.statusCode !== 200 || !body || body.execution_mode !== 'local_stub' || body.synthetic !== true || body.service !== 'gengyun-local-diagnostic') {
        report('响应不符合本地诊断格式，请检查地址。', false); return
      }
      report('本地替身连接成功；登录、数据库、AI及业务均未接入。', true)
    },
    fail: function () { report('本地连接失败。请核对服务、地址、同网权限及个人域名设置后重试。', false) }
  })
}
module.exports = { localEnabled: localEnabled, diagnose: diagnose }
