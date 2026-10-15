// GY-I15（#15）阶段 2 · 社区投稿页。
//
// 对齐 docs/ui-demo/demo.html 的 compose 弹窗：标题／正文／作物（发布后先审后发）。
// 契约语义（逐条落实，不做本地"看起来成功"）：
//   - `title` 1..120、`body` 1..8000、`crop_id` 1..80、`region_code` ^33[0-9]{4}$；
//   - **图片帖本轮未取得**：契约允许 `media_ids` ≤3，但规则层对带媒体目标一律不判通过
//     （`packages/moderation/merge.mjs` 明确声明这是跨片依赖），因此页面**不提供**图片上传，
//     并如实说明原因，而不是让用户传完图再被服务端拒绝；
//   - 审核结果只以**服务端返回**为准：通过则 201；未通过则按契约错误码展示原因码，
//     页面不会显示"已提交成功"。
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
    errorText: ''
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

  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

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
    this.setData({ submitting: true, errorText: '' })
    api.createPost(input).then(function (result) {
      that.setData({ submitting: false })
      wx.showToast({ title: '已发布并通过先行审核', icon: 'success' })
      navigation.openTarget('/pages/communitydetail/communitydetail?id=' + encodeURIComponent(result.post.id), true, function () {})
    }).catch(function (error) {
      if (error && error.code === 'SESSION_REQUIRED') { that.setData({ submitting: false, guest: true }); return }
      that.setData({ submitting: false, errorText: api.message(error) })
    })
  }
})
