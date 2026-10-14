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
    kitQuery: '',
    kitSelected: '全部',
    kitStatus: 'ready',
    /** 末屏走查用：一段可滚动的长内容，用来核对 tabBar 是否遮挡末屏 */
    filler: [1, 2, 3, 4, 5, 6],
    /** 走查探针输出（见 probeStates）：正常浏览不写入，页面模板不引用 */
    __probeStates: null
  },

  onLoad: function () {
    fontScale.applyFontScale(this)
    this.setData({ local: debug.localEnabled(wx) })
  },

  onShow: function () { fontScale.applyFontScale(this) },

  /** 样张按钮：不产生任何业务行为，避免被误当已交付功能 */
  onStub: function () {
    wx.showToast({ title: '样式样张，无业务行为', icon: 'none' })
  },
  // #142（codex/demo-ui-kit-20261014）：gy-ui 可复用组件样张的受控输入与状态处理器。
  onKitInput: function (event) { this.setData({ kitQuery: event.detail.value }) },
  onKitClear: function () { this.setData({ kitQuery: '' }) },
  onKitConfirm: function (event) { this.setData({ kitQuery: event.detail.value, kitStatus: 'loading' }) },
  onKitSelect: function (event) { this.setData({ kitSelected: event.detail.value }) },
  onKitRetry: function () { this.setData({ kitStatus: 'loading' }) },
  onKitState: function (event) { this.setData({ kitStatus: event.currentTarget.dataset.value }) },

  /**
   * 统一状态视图的样式走查探针（只读；正常交互不会触发，供自动化或人工复核显式调用）
   * ----------------------------------------------------------------------------
   * 为什么需要它：官方 miniprogram-automator 0.12.1 的页面级选择器取不到本页
   * <state-view> 自定义组件的宿主节点与内部节点（实测 page.$/$$ 的 `.gy-state`、
   * `state-view` 标签名，以及 page.selectComponent('/#id/class/标签名') 全部为空），
   * 而本片要核对的两件事只存在于组件内部：
   *   1. demo .empty 的八态形态是否真的落在组件内（.state 的虚线框与语气底色）；
   *   2. `options.styleIsolation:'apply-shared'` 是否让 app.wxss 的 `.btn`
   *      （含 page{} 上的 --tap-min 变量）作用到组件内部的 .state__btn。
   * 因此改在**页面自身的 JS 上下文**里取组件实例，再用组件级 selectorQuery 量计算样式。
   * 本方法只读、不改 data、不发请求、不触发任何业务行为。
   */
  probeStates: function () {
    const self = this
    const byClass = this.selectAllComponents('.gy-state')
    const byTag = this.selectAllComponents('state-view')
    const components = byClass.length ? byClass : byTag
    const rows = components.map(function (component) {
      return new Promise(function (resolve) {
        const query = wx.createSelectorQuery().in(component)
        query.select('.state').fields({
          size: true, rect: true, scrollOffset: true,
          computedStyle: ['backgroundColor', 'borderTopStyle', 'borderTopColor', 'borderTopLeftRadius', 'paddingTop', 'display']
        })
        query.select('.state__title').fields({ computedStyle: ['fontSize', 'color', 'fontWeight'] })
        query.select('.state__btn').fields({
          size: true,
          computedStyle: ['fontSize', 'minHeight', 'backgroundColor', 'borderTopLeftRadius', 'borderTopStyle']
        })
        query.exec(function (result) {
          resolve({
            status: component.data.status,
            state: result[0] || null,
            title: result[1] || null,
            button: result[2] || null
          })
        })
      })
    })
    return Promise.all(rows).then(function (list) {
      const result = { byClass: byClass.length, byTag: byTag.length, count: list.length, rows: list }
      // 结果同时落到 data，供自动化用 page.data('__probeStates') 读取：
      // miniprogram-automator 的 callMethod 不等待返回的 Promise（实测返回 {}）。
      self.setData({ __probeStates: result })
      return result
    })
  }
})
