/**
 * 样式走查页（GY-I26 demo 对齐，Refs #28）
 * ----------------------------------------------------------------------------
 * 用途：在没有微信开发者工具／真机的环境里，把 docs/ui-demo 的**组件形态**落到小程序
 * 运行时上可核对——包括本轮无法用真实数据渲染的社区帖子详情（demo `postDetail()`）、
 * 识别台（`.scan-stage`）与统一状态视图。
 *
 * 边界（重要）：
 *   1. 本页只在**本地替身工程**（tools/prepare-wechat.mjs local + develop 环境）可见；
 *      共享源码的 config/runtime.js 恒为 disabled，因此标准包打开本页只会看到
 *      「统一失败态」，这也是失败态走查入口。
 *   2. 页内所有文案都是**样式样张占位**，不是真实资料、识别结果、帖子或用药建议；
 *      按钮不触发任何业务行为，只提示「样式样张」。
 *   3. 本页不新增任何数据源、不调用任何接口。
 */
const fontScale = require('../../utils/font-scale')
const debug = require('../../utils/debug')

Page({
  data: {
    fontScale: 1,
    local: false,
    /** 末屏走查用：一段可滚动的长内容，用来核对 tabBar 是否遮挡末屏 */
    filler: [1, 2, 3, 4, 5, 6]
  },

  onLoad: function () {
    fontScale.applyFontScale(this)
    this.setData({ local: debug.localEnabled(wx) })
  },

  onShow: function () { fontScale.applyFontScale(this) },

  /** 样张按钮：不产生任何业务行为，避免被误当已交付功能 */
  onStub: function () {
    wx.showToast({ title: '样式样张，无业务行为', icon: 'none' })
  }
})
