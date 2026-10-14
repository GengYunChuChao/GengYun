const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const navigation = require('../../utils/navigation')

Page({
  onLoad: function () {
    fontScale.applyFontScale(this)
  },

  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    guest: true
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    // 每次进入先关闭入口，服务端核实成功后才显示登录区。
    const that = this
    this.setData({ guest: true, fontScale: fontScale.currentFontScale() })
    pageGate.start(this, function (ok) {
      that.setData({ guest: !ok })
    })
  },

  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

  /** 发布入口占位：社区未接入，不写入任何数据 */
  onPublish: function () {
    wx.showToast({ title: '社区尚未开放', icon: 'none' })
  },

  /**
   * 「资料库」切换：demo 的 communitySwitch 把社区与资料库放在同一分段控件里。
   * 小程序无资料库 Tab，这里复用既有知识页（GY-I07）并沿用 utils/navigation 的
   * 路由与失败回落，不新建页面、不改知识页逻辑。
   */
  onOpenLibrary: function () {
    navigation.openTarget('/pages/knowledge/knowledge', false, function (error) {
      if (error) wx.showToast({ title: error, icon: 'none' })
    })
  }
})
