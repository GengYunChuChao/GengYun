const fontScale = require('../../utils/font-scale')
// GY-I07 科普／除草剂详情页。
//
// 展示：制剂（登记号/持有人/剂型/成分）、条件（作物/场所/防治对象）、风险（毒性/注意事项）、
//       原文来源（发布机构/期号/原始链接/采集日期）、来源版本与更新时间。
// 一致性与边界：
// - 详情与列表使用**同一个 source_version**（同一条记录的同一来源版本）。
// - 未采集字段如实列为「未采集」，**不以空白或模型补写填充**。
// - 不提供用量；不出现"权威认证/绝对安全"等禁用标签；模拟记录强标记。
// - 失效/下架记录：不进入有效查询（列表）；直接访问详情时明确说明不可用原因并支持返回继续查询。
// - GY-I08 / PR #82：用量卡片资格绑定当前适用判定；适用上下文来自**已确认档案**
//   （`utils/profile-api` → `/me/profile`），档案未确认/读取失败/身份变化时**不**默认
//   为空上下文放行具体用量（阻塞 C）。

const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const profileApi = require('../../utils/profile-api')
const reference = require('../../utils/reference')

// External links may contain malformed percent encoding. Reject before lookup,
// but always continue into the existing identity gate and empty state.
function detailId(options) {
  const raw = options && options.id
  if (typeof raw !== 'string' || raw.length > 512) return ''
  try {
    const id = decodeURIComponent(raw)
    return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : ''
  } catch (_) { return '' }
}

// 档案读取失败的中文说明（与 profile 页同一口径，不暴露内部细节）。
function profileFailureText(code) {
  const messages = {
    SESSION_REQUIRED: '登录状态已变化，请重新进入本页。',
    SESSION_CHANGED: '登录状态已变化，请重新进入本页。',
    NETWORK_UNCERTAIN: '档案读取未确认（网络中断），请重试。',
    INVALID_RESPONSE: '档案数据不可用，请重试。'
  }
  return messages[code] || '档案暂时无法读取，请重试。'
}

Page({
  data: {
    fontScale: 1,
    recordId: '',
    found: false,
    detail: null,
    labels: null,
    verifiedScope: [],
    notCollected: [],
    unavailableReason: '',
    queryable: true,
    modeNote: '',
    // GY-I08：标签原文用量卡片（DoseCard）与适用过滤结论。
    doseCardEnabled: true,
    doseCard: null,
    applicability: null,
    // G2：会话门禁状态（未通过服务端核实前恒 false）。
    gatePassed: false,
    // PR #82 阻塞 C：已确认档案上下文。confirmed=false 时**不得**据此放行具体用量。
    profileConfirmed: false,
    profileContext: null,
    profileLoading: false,
    profileError: ''
  },

  onLoad: function (options) {
    fontScale.applyFontScale(this)
    this._detailId = detailId(options)
    this.checkGate()
  },

  checkGate: function () {
    const recordId = this._detailId || ''
    const self = this
    pageGate.start(this, function (loggedIn) {
      if (!loggedIn) {
        self.setData({ gatePassed: false, recordId: '', found: false, detail: null, labels: null, verifiedScope: [], notCollected: [], unavailableReason: '', queryable: true, doseCard: null, applicability: null, profileConfirmed: false, profileContext: null, profileLoading: false, profileError: '' })
        return
      }
      self.setData({ gatePassed: true, recordId: recordId, modeNote: reference.modeNote() })
      // 阻塞 C：先读取**已确认档案**，再装载详情；档案未确认时不放行用量资格。
      self.loadProfileContext(recordId)
    })
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    // 重新进入本页生命周期必须重新核实（不能凭旧 gatePassed 跳过）。
    if (!auth.isLoggedIn()) this.checkGate()
    else if (!this.data.gatePassed) this.checkGate()
  },
  onHide: function () {
    pageGate.cancel(this)
    // 失效在途档案读取：旧回调不得再回填资料/用量状态。
    this._profileOperation = (this._profileOperation || 0) + 1
    this._profileActive = false
  },
  onUnload: function () {
    pageGate.cancel(this)
    this._profileOperation = (this._profileOperation || 0) + 1
    this._profileActive = false
  },

  /**
   * 阻塞 C：从服务端读取当前用户的已确认档案（/me/profile）。
   * 读取失败、身份变化或档案为空（crop_id/region_code 均未设置）→ `profileConfirmed=false`，
   * 适用上下文视为**未确认**，DoseCard 明确拒绝，绝不静默按空上下文放行。
   *
   * 回调保护（follow-up 2）：仅当「世代号未变 + 门禁仍活跃 + 会话绑定仍有效」时才落数据；
   * onHide/onUnload/重新进入/身份变更后返回的旧结果一律丢弃，不复活资料或用量状态。
   */
  loadProfileContext: function (recordId) {
    const self = this
    this._profileOperation = (this._profileOperation || 0) + 1
    const op = this._profileOperation
    this._profileActive = true
    const binding = profileApi.binding()
    this.setData({ profileLoading: true, profileError: '', profileConfirmed: false, profileContext: null })
    profileApi.read().then(function (profile) {
      // 晚回调守卫：世代/门禁/身份任一失效即丢弃。
      if (self._profileOperation !== op || self._profileActive !== true || self.data.gatePassed !== true || !profileApi.current(binding)) {
        self.onProfileFailure(op, 'SESSION_CHANGED')
        return
      }
      // 档案须**完整已确认**：作物与地区都已设置才算已确认（空档案不构成适用依据）。
      const complete = typeof profile.crop_id === 'string' && profile.crop_id !== '' && typeof profile.region_code === 'string' && profile.region_code !== ''
      // 已确认档案**绑定到本次身份绑定**：之后的每次消费都复核该绑定是否仍当前，
      // 身份一变立即作废（不读取/不使用旧档案）。
      self._profileBinding = complete ? binding : null
      self.setData({ profileLoading: false, profileConfirmed: complete, profileContext: complete ? profile : null })
      // 档案未确认/为空：仍装载**可查阅**的资料本体（「可以查阅」与「适用」分离）。
      self.load(recordId, complete ? null : '档案尚未设置作物或地区，无法确认当前条件是否适用。')
    }).catch(function (e) {
      self.onProfileFailure(op, e && e.code)
    })
  },

  onProfileFailure: function (op, code) {
    // 晚回调守卫：旧世代不得覆盖新一轮，也不得在页面已离开时回填。
    if (this._profileOperation !== op || this._profileActive !== true) return
    this._profileBinding = null
    this.setData({ profileLoading: false, profileConfirmed: false, profileContext: null, profileError: profileFailureText(code) })
    // 档案读取失败：不装载详情用量资格，但资料内容仍可查阅（与「适用」分离）。
    if (this._detailId) this.load(this._detailId)
  },

  /** 重试档案读取（页面入口）。 */
  retryProfile: function () {
    if (this.data.profileLoading || !this.data.gatePassed) return
    this.loadProfileContext(this._detailId || '')
  },

  /**
   * 复核已确认档案**仍绑定当前身份**。
   * 身份一旦变化（换账号/重新登录）：作废档案与全部资格，不读取也不使用旧档案。
   * @returns {boolean} true 表示档案仍属当前身份
   */
  profileBindingCurrent: function () {
    if (!this._profileBinding) return false
    if (!profileApi.current(this._profileBinding)) {
      this._profileBinding = null
      this.setData({ profileConfirmed: false, profileContext: null, profileError: '登录状态已变化，档案已失效，请重新进入本页。', doseCard: null, applicability: null })
      return false
    }
    return true
  },

  /**
   * 当前适用判定的**已确认**上下文。
   * 仅接受来自已确认档案的作物与地区，且该档案必须仍绑定当前身份；
   * 未确认/身份已变时返回 null（调用方据此拒绝具体用量）。
   */
  confirmedContext: function () {
    const p = this.data.profileContext
    if (!this.data.profileConfirmed || !p) return null
    if (!this.profileBindingCurrent()) return null
    const ctx = {}
    if (typeof p.crop_id === 'string' && p.crop_id !== '') ctx.crop_id = p.crop_id
    if (typeof p.region_code === 'string' && p.region_code !== '') ctx.region_code = p.region_code
    return ctx
  },

  /**
   * 装载资料详情。
   * @param {string} recordId 记录 id
   * @param {string|null} [profileNote] 档案未确认时的说明（仍装载资料，但不给用量资格）
   *
   * 「可以查阅」与「适用/可展示用量」分离：档案未确认/读取失败时仍走真实
   * `reference.detail(recordId)` 装载可查询资料；仅**用量资格**被拒绝。
   * 非法/未知 ID 继续原「未找到」语义（`found=false`）。
   */
  load: function (recordId, profileNote) {
    // G2：门禁未通过则**拒绝加载**——不依赖跳转是否成功。
    if (!this.data.gatePassed || !auth.isLoggedIn()) {
      this.setData({ gatePassed: false, found: false, detail: null, labels: null, verifiedScope: [], notCollected: [], unavailableReason: '', doseCard: null, applicability: null, profileConfirmed: false, profileContext: null })
      return
    }
    const detail = typeof recordId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(recordId) ? reference.detail(recordId) : null
    if (!detail) {
      this.setData({ found: false, detail: null, labels: null, verifiedScope: [], notCollected: [], unavailableReason: '', queryable: false, doseCard: null, applicability: null })
      return
    }
    const base = {
      found: true,
      detail: detail,
      labels: detail.labels,
      verifiedScope: detail.verified_scope || [],
      notCollected: detail.not_collected || [],
      unavailableReason: detail.unavailable_reason || '',
      queryable: detail.queryable === true,
    };
    // 阻塞 C：适用上下文必须来自已确认档案；未确认时**不**给用量资格（也不给适用结论）。
    const ctx = this.confirmedContext()
    if (ctx === null) {
      this.setData(Object.assign({}, base, { doseCard: null, applicability: null }, profileNote ? { profileError: profileNote } : {}))
      return
    }
    const applicability = reference.evaluateApplicability(detail, ctx)
    this.setData(Object.assign({}, base, {
      applicability: applicability,
      doseCard: reference.doseCardDescriptor(detail, { doseCardEnabled: this.data.doseCardEnabled, context: ctx })
    }))
  },

  // GY-I08：用量卡片功能关闭开关（满足规格「有功能关闭开关」）。
  // 注意：开关只是附加条件；关闭不能代替资格验证（PR #82）。
  toggleDoseCard: function (e) {
    const enabled = e && e.detail && typeof e.detail.value === 'boolean' ? e.detail.value : !this.data.doseCardEnabled;
    this.setData({ doseCardEnabled: enabled });
    if (this.data.detail) {
      const ctx = this.confirmedContext()
      if (ctx === null) { this.setData({ doseCard: null, applicability: null }); return }
      this.setData({
        doseCard: reference.doseCardDescriptor(this.data.detail, { doseCardEnabled: enabled, context: ctx }),
        applicability: reference.evaluateApplicability(this.data.detail, ctx)
      });
    }
  },

  backToList: function () {
    const self = this, operation = this._gateOperation
    wx.navigateBack({ delta: 1, fail: function () {
      if (self._gateActive !== true || self._gateOperation !== operation) return
      wx.redirectTo({ url: '/pages/reference/reference' })
    } })
  },

  copySource: function () {
    const d = this.data.detail
    if (!d || !d.source || !d.source.original_url) return
    wx.setClipboardData({ data: d.source.original_url })
  }
})
