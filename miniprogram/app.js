const auth = require('./utils/auth')

App({
  globalData: { session: null },
  onLaunch: function () {
    this.globalData.session = auth.getSession()
  }
})
