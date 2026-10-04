const session = require('../../utils/session')

Page({
  data: {
    guest: true
  },

  onShow: function () {
    this.setData({ guest: session.isGuest() })
  }
})
