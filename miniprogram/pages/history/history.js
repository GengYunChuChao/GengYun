// GY-I16 识别历史列表页（Demo 形态：styles/* 色板与卡片 + gy-ui-* 组件 + state-view 空/失败态）。
//
// 数据来源（**已合并**契约面，不新增路径）：
//   * 列表 / 删除：GET /history、DELETE /history/{id}（If-Match 用服务端给的 revision）
//   * 详情：无契约外路径 —— 只带历史行 id 跳到详情页，详情页再用实时读取 + 已合并的
//     GET /recognitions/{id}（#9）或 GET /ocr/{id}（#10）组合呈现。
//
// 硬口径：
//   - **失败状态真实可见**：`job_state` 七类逐类呈现，`failed`/`timed_out`/`cancelled`/`uncertain`
//     一律原样列出，绝不隐藏、不折叠成"成功"。
//   - `reference_state` 由服务端逐次派生：不可用时如实标注，且**不提供跳转**（避免旧链接复活）。
//   - 删除记录会**同时**触发服务端的关联删除流程；是否已接线由 `X-GY-Cascade`（非契约披露标记）如实回传。
//   - 识别/收藏**不等于**"已使用"：本页没有任何"标记已使用"的入口。
const fontScale = require('../../utils/font-scale')
const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const historyApi = require('../../utils/history-api')

const PAGE_SIZE = 20

Page({
  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    gatePassed: false,
    checking: true,
    networkOff: false,
    busy: false,
    loading: false,
    mode: '',
    message: '',
    errorText: '',
    /** 最近一次读取失败的契约错误码（交给 `components/state-view` 的 errorCode 决定 401/403/404 语气）。 */
    errorCode: '',
    items: [],
    nextCursor: null,
    failedCount: 0
  },

  onLoad: function () {
    fontScale.applyFontScale(this)
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    const self = this
    // 重新进入本页即丢弃上一轮的定位快照：门禁/读取还没返回时，旧行 id 不应继续可用。
    self._rawItems = []
    historyApi.clearSelection()
    self.setData({
      gatePassed: false, checking: true, items: [], nextCursor: null,
      errorText: '', errorCode: '', message: '', failedCount: 0
    })
    pageGate.start(this, function (ok) {
      self.setData({ checking: false })
      if (!ok) { self.setData({ gatePassed: false }); return }
      self.setData({ gatePassed: true, networkOff: !auth.networkEnabled() })
      if (auth.networkEnabled()) self.load()
    })
  },

  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

  load: function (cursor) {
    const self = this
    self.setData({ busy: true, loading: true, errorText: '', errorCode: '' })
    historyApi.listHistory(cursor || '', PAGE_SIZE).then(function (result) {
      const items = result.items.map(function (item) {
        const view = historyApi.historyItemView(item)
        return Object.assign({}, view, { cardTitle: view.kindLabel + ' · ' + view.createdText })
      })
      const merged = cursor ? self.data.items.concat(items) : items
      // 列表页写入**引用快照**：详情页只把它用于定位，不把它当状态来源。
      // 必须累积**已加载的每一页**原始行：`remember()` 每次整体替换快照，若只传当前页，
      // 翻到第 2 页后第 1 页的记录会从快照里消失；详情页的实时读取只覆盖第一页（limit=50），
      // 于是仍存在于列表里的记录会被误判成「不存在、已删除」。
      self._rawItems = (cursor ? (self._rawItems || []).concat(result.items) : result.items.slice())
      historyApi.remember(self._rawItems)
      self.setData({
        busy: false, loading: false, items: merged, nextCursor: result.nextCursor, mode: result.mode,
        failedCount: merged.filter(function (entry) { return entry.failed }).length,
        message: merged.length ? '' : '还没有识别记录。'
      })
    }).catch(function (error) {
      // 失败时不保留旧记录；错误码原样带出，401/403/404 分别由状态组件呈现，不折叠成空列表成功。
      self._rawItems = []
      self.setData({
        busy: false, loading: false, items: [], nextCursor: null, failedCount: 0,
        errorText: historyApi.messageFor(error), errorCode: (error && error.code) || ''
      })
    })
  },

  onMore: function () {
    if (this.data.busy || !this.data.nextCursor) return
    this.load(this.data.nextCursor)
  },

  onRefresh: function () {
    if (!this.data.gatePassed || this.data.networkOff) return
    historyApi.clearSelection()
    this.load()
  },

  openDetail: function (event) {
    const index = Number(event.currentTarget.dataset.index)
    const item = this.data.items[index]
    if (!item) return
    // 只带历史行 id；不把任何状态放进链接（状态一律由详情页实时读取）。
    wx.navigateTo({ url: '/pages/historydetail/historydetail?id=' + encodeURIComponent(item.id) })
  },

  onDelete: function (event) {
    const self = this
    if (self.data.busy) return
    const index = Number(event.currentTarget.dataset.index)
    const item = self.data.items[index]
    if (!item) return
    wx.showModal({
      title: '删除这条记录？',
      content: '将删除该识别记录，并触发关联的识别结果与媒体删除流程。删除后不可恢复。',
      confirmText: '删除',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return
        self.setData({ busy: true, message: '正在删除…' })
        historyApi.deleteHistory(item.id, item.revision).then(function (result) {
          // 级联是否已启动由服务端如实回传（非契约披露标记）。
          self.setData({ busy: false, message: '已删除记录。' + historyApi.cascadeNote(result.cascade) })
          self.load()
        }).catch(function (error) {
          self.setData({ busy: false, message: historyApi.messageFor(error) })
        })
      }
    })
  },

  // GY-I04 6-A：与 page-gate 同一登录口径（登记本页为返回目标 → reLaunch 登录页），
  // 登录成功后回到本页；门禁拦截语义不变（未登录仍被拦，按钮不放行任何数据）。
  // N1（对抗性审查 §4）：核实失败或在途时点按钮此前无可见反应。核实成功（ok）说明会话
  // 已获服务端确认 ⇒ 取消被本次核实取代的旧门禁周期，并按「重新进入本页」重跑门禁，
  // 让页面可见地放行；ok=false 时 requireLogin 已跳转登录页（可见）。两者都不放行数据。
  onLogin: function () {
    const self = this
    auth.requireLogin(function (ok) { if (ok) { pageGate.cancel(self); self.onShow() } })
  }
})
