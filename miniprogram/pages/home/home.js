const debug = require('../../utils/debug')
Page({
  data: { local: false, busy: false, status: '开发准备工程：业务尚未接入。' },
  onLoad: function () { this.setData({ local: debug.localEnabled(wx) }) },
  diagnose: function () {
    if (this.data.busy) return
    this.setData({ busy: true, status: '正在连接本地诊断服务…' })
    debug.diagnose(wx, (status) => { this.setData({ busy: false, status: status }) })
  }
})
