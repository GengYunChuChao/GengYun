// GY-I15（#15）阶段 2 · 社区投稿页。
//
// 对齐 docs/ui-demo/demo.html 的 compose 弹窗：标题／正文／作物（发布后先审后发）。
// 契约语义（逐条落实，不做本地"看起来成功"）：
//   - `title` 1..120、`body` 1..8000、`crop_id` 1..80、`region_code` ^33[0-9]{4}$；
//   - **图片帖本轮未取得**：契约允许 `media_ids` ≤3，但规则层对带媒体目标一律不判通过
//     （`packages/moderation/merge.mjs` 明确声明这是跨片依赖），因此页面**不提供**图片上传，
//     并如实说明原因，而不是让用户传完图再被服务端拒绝；
//   - 审核结果只以**服务端返回**为准：未通过则按契约错误码展示原因码，页面不会显示"已提交成功"；
//     201 也只是"服务端已受理"，是否公开一律按返回的 `visibility`/`audit_state` 如实提示
//     （判据与措辞逐字取自详情页／列表页既有实现，见 onSubmit，本页不再自造第二套说法）。
const pageGate = require('../../utils/page-gate')
const fontScale = require('../../utils/font-scale')
const navigation = require('../../utils/navigation')
const api = require('../../utils/community-api')

const CROPS = require('../../data/crops').crops || []
const REGIONS = require('../../data/regions').regions || []
const CROP_NONE = { id: '', name: '暂不指定' }
const REGION_NONE = { code: '', name: '暂不指定' }

Page({
  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    guest: true,
    title: '',
    body: '',
    cropLabels: [CROP_NONE.name].concat(CROPS.map(function (c) { return c.name })),
    cropIds: [CROP_NONE.id].concat(CROPS.map(function (c) { return c.id })),
    cropIndex: 0,
    regionLabels: [REGION_NONE.name].concat(REGIONS.map(function (r) { return r.name })),
    regionCodes: [REGION_NONE.code].concat(REGIONS.map(function (r) { return r.code })),
    regionIndex: 0,
    submitting: false,
    errorText: '',
    // B7：失败时把契约错误码透传给 `state-view` 的 `error-code`。改前本页只有一个红色
    // 提示条（`errorText`），403 三码会被当成普通「请求不符合契约要求」——同一件事在列表页
    // 显示成「没有权限」、在投稿页显示成「失败」，两套语气。现在 403 系与列表/详情同口径：
    // 整页 denied（表单收起，因为当前会话本来就不能发布），其余仍留在表单上如实说明。
    errorCode: '',
    denied: false
  },

  onLoad: function () {
    fontScale.applyFontScale(this)
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    const that = this
    this.setData({ guest: true, fontScale: fontScale.currentFontScale() })
    pageGate.start(this, function (ok) { that.setData({ guest: !ok }) })
  },

  // 提交回调的页面可见周期身份（Refs #15／#28）：`createPost` 在飞时同一账号会话
  // `onHide`／`onUnload`／重进，旧响应仍会 `setData`／`toast`／`navigation`；旧失败还会写
  // `guest`／`errorCode`／`denied`／`errorText`，覆盖新页面或新一次提交。离页即换代，
  // 旧回调据此提前返回。**不取消**服务端已受理的投稿，也不改后端／幂等／审核语义。
  onHide: function () {
    pageGate.cancel(this)
    this.invalidateSubmitCycle()
    // 只释放「本次可见周期」的忙碌态，避免回来后被上一次请求一直占着 submitting。
    // 表单文本（title/body）与既有错误态都不在这里清空。
    if (this.data.submitting) this.setData({ submitting: false })
  },
  onUnload: function () {
    pageGate.cancel(this)
    this.invalidateSubmitCycle()
  },

  onTitle: function (event) { this.setData({ title: event.detail.value, errorText: '' }) },
  onBody: function (event) { this.setData({ body: event.detail.value, errorText: '' }) },
  onCropChange: function (event) { this.setData({ cropIndex: Number(event.detail.value) }) },
  onRegionChange: function (event) { this.setData({ regionIndex: Number(event.detail.value) }) },

  // GY-I04 6-A：游客态的「去登录」按钮必须真的去登录（此前绑到 onBack：只回社区列表，
  // 与文案不符）。与 page-gate / communitydetail 同一口径：登记本页为返回目标 → reLaunch 登录页，
  // 登录成功后回本页；门禁拦截语义不变（未登录仍被拦，不放行任何提交）。
  // N1（对抗性审查 §4）：核实成功（ok）说明会话已获服务端确认 ⇒ 取消被本次核实取代的旧
  // 门禁周期，并按「重新进入本页」重跑门禁，让页面可见地放行（改前此处无任何可见反应）。
  onLogin: function () {
    const self = this
    require('../../utils/auth').requireLogin(function (ok) { if (ok) { pageGate.cancel(self); self.onShow() } })
  },

  onBack: function () {
    navigation.openTarget('/pages/community/community', true, function () {})
  },

  /** 离页换代：此后旧提交回调的周期身份不再等于当前周期。 */
  invalidateSubmitCycle: function () {
    this._submitCycle = (this._submitCycle || 0) + 1
  },

  /** 提交回调是否仍属于当前页面可见周期（离页／重进后的旧回调为 false）。 */
  submitCallbackAlive: function (cycle) {
    return (this._submitCycle || 0) === cycle
  },

  onSubmit: function () {
    const title = String(this.data.title || '').trim()
    const body = String(this.data.body || '').trim()
    if (title.length < 1 || title.length > 120) {
      this.setData({ errorText: '标题需要 1..120 个字符。' })
      return
    }
    if (body.length < 1 || body.length > 8000) {
      this.setData({ errorText: '正文需要 1..8000 个字符。' })
      return
    }
    const input = { title: title, body: body, media_ids: [] }
    const cropId = this.data.cropIds[this.data.cropIndex]
    const regionCode = this.data.regionCodes[this.data.regionIndex]
    if (cropId) input.crop_id = cropId
    if (regionCode) input.region_code = regionCode

    const that = this
    const cycle = this._submitCycle || 0
    this.setData({ submitting: true, errorText: '' })
    api.createPost(input).then(function (result) {
      if (!that.submitCallbackAlive(cycle)) return
      that.setData({ submitting: false })
      // 审核结论只以**服务端返回**为准，措辞取适配层 `api.outcomeOf`（详情页/列表页同一张表）：
      // 201 只是「服务端已受理」，是否公开一律按返回的 `visibility`/`audit_state` 如实提示。
      // 改前这里把 `pending`/`quarantined`/`rejected` 一律说成「待审／未公开」——
      // 对「隔离待复核」尚可，对「明确驳回」是说反了（不会再有人审它）。
      const outcome = api.outcomeOf(result.post)
      const approved = outcome.key === 'approved'
      wx.showToast({ title: outcome.title, icon: approved ? 'success' : 'none' })
      navigation.openTarget('/pages/communitydetail/communitydetail?id=' + encodeURIComponent(result.post.id), true, function () {})
    }).catch(function (error) {
      if (!that.submitCallbackAlive(cycle)) return
      // 会话类（含 `SESSION_CHANGED`）⇒ 回登录门禁；403 三码 ⇒ 整页 denied（`errorCode` 驱动）。
      if (api.sessionFailure(error)) {
        that.setData({ submitting: false, guest: true, errorText: '', errorCode: '', denied: false })
        return
      }
      // `api.message()` 已按结论分流：400 明确驳回 / 422 隔离待复核，各带理由码人话；
      // 未知码落在「未知原因（码：X）」，不会说成通过、也不会说成系统错误。
      that.setData({
        submitting: false,
        errorText: api.message(error),
        errorCode: (error && error.code) || '',
        denied: api.forbidden(error)
      })
    })
  },

  /** denied 态的「重新填写」入口：权限问题解除后不必重进页面（表单会重新出现，不放宽任何校验）。 */
  onDismissDenied: function () { this.setData({ errorCode: '', errorText: '', denied: false }) }
})
