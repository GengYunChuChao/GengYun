const runtime = require('../config/runtime')

function localEnabled(wxApi) {
  if (runtime.mode !== 'local') return false
  try { return wxApi.getAccountInfoSync().miniProgram.envVersion === 'develop' } catch (_) { return false }
}

function diagnose(wxApi, report) {
  if (!localEnabled(wxApi)) { report('当前工程未启用本地诊断。'); return }
  wxApi.request({
    url: runtime.apiBaseUrl + '/__local__/status',
    method: 'GET', timeout: 5000,
    success: function (res) {
      const body = res.data
      if (res.statusCode !== 200 || !body || body.execution_mode !== 'local_stub' || body.synthetic !== true || body.service !== 'gengyun-local-diagnostic') {
        report('响应不符合本地诊断格式，请检查地址。'); return
      }
      report('本地替身连接成功；登录、数据库、AI及业务均未接入。')
    },
    fail: function () { report('本地连接失败。请核对服务、地址、同网权限及个人域名设置后重试。') }
  })
}
module.exports = { localEnabled: localEnabled, diagnose: diagnose }
