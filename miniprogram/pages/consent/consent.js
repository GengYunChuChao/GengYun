// GY-R70 · 授权清单页（**可授予、可撤回**）。
//
// 数据来源：契约 `GET /me/consents`（清单）、`POST /me/consents`（授予）、
// `DELETE /me/consents/{purpose}`（撤回），外加 `GET /me/privacy-policy`（授予体需要的政策版本与
// "当前哪些用途有生效政策"）。三条写读路径都经 `utils/consent-api.js`，本页不发裸请求。
//
// 硬口径（逐条对应证据页 docs/verification/gy-r70-consent-client-20261030.md）：
//   - **不做乐观更新**：服务端确认成功之前，界面不把开关翻过去。写成功后**重新读取**清单，
//     以服务端返回为唯一事实源；写失败保持原状态，并把服务端 `error.code` 原样写在该行上。
//   - **失败不折叠成空列表**：读取失败时清空 items，同时给出 errorText + errorCode，由 state-view
//     按 error / denied / guest 呈现。空态只在服务端**确实**返回 0 条时出现。
//   - **不可用就如实置灰**：政策读不到 / 服务端无已发布政策 / 该用途不在政策 `purposes` 里 /
//     服务端回 403 CONSENT_REQUIRED（无可用已核验政策）或 409 OBJECT_UNAVAILABLE（撤回消费者未接线）
//     时，该行按钮置灰并写明原因；⛔ 不假装可点、⛔ 不静默吞掉。
//   - **撤回必须二次确认，且按 purpose 说清代价**：`WITHDRAW_COST` 逐条对应服务端真实的判定点
//     （认领自 `packages/privacy/constants.mjs` 的必需用途集合与各路由的授权门），不是一句通用话。
//   - 用途名只来自契约枚举的短名映射（`consent-api.PURPOSE_LABELS`）并**同时显示原码**；
//     页面不写政策正文、不解释"某授权覆盖哪些数据"以外的政策内容。
//   - `policy_version` 原样展示，不判断是否最新版、不写"已同意最新版"。
const fontScale = require('../../utils/font-scale')
const auth = require('../../utils/auth')
const pageGate = require('../../utils/page-gate')
const consentApi = require('../../utils/consent-api')

const PAGE_SIZE = 20

/**
 * 撤回代价：**按用途分别写**，每一句都指得出服务端/隐私模块里的真实判定点。
 *
 * - `recording`：`voice_question` 的必需授权集合是 `['recording','media_processing','external_inference']`
 *   （`packages/privacy/constants.mjs`），所以撤回它 ⇒ 语音提问被 403 `CONSENT_REQUIRED` 拒；
 *   但**本机录音入口不受影响**（录音端口不查用途授权），所以只说"问不出去"，不说"按不了录音"。
 * - `media_processing`：媒体上传按 `media_processing` 判定（`routes/media.ts`），且四种媒体资料类型
 *   都要求 `media_processing` ⇒ 拍草识别 / 标签识别 / 语音提问 / 社区图片都传不了字节。
 * - `external_inference`：识别、OCR、语音问答、朗读合成四条外发各自按 `external_inference` 判定。
 *   撤回时若服务端**已接外发账本**（real 模式注入 `egressRevoker`），还会先撤销在途外发；
 *   未接线则服务端以 409 `OBJECT_UNAVAILABLE` **拒绝做只撤一半**（不以"已撤回"糊过去）。
 * - `public_posting`：发帖 / 评论 / 社区图片（`community_image` 还要求 `public_posting`）按
 *   `public_posting` 判定 ⇒ 立刻发不了帖、发不了评论。
 * 四种撤回都**不会删除已存在的内容**（撤回改的是授权状态，不是数据）。
 */
const WITHDRAW_COST = {
  recording: '撤回「录音」后：以语音提问（voice_question）发起的外发会立刻被 403 CONSENT_REQUIRED 拒绝——' +
    '这个资料类型的必需授权集合含 recording（packages/privacy/constants.mjs）。本机仍能按下录音键（录音端口不查用途授权），' +
    '但录下来的问题发不出去。已有的录音与识别记录不会被删除。',
  media_processing: '撤回「媒体处理」后：照片与录音的上传会立刻被 403 CONSENT_REQUIRED 拦下（媒体上传按 media_processing 判定），' +
    '拍草识别、标签识别、语音提问、社区图片都传不了图/音。已有的媒体与识别记录不会被删除。',
  external_inference: '撤回「外部推理」后：照片杂草识别、农药标签 OCR、语音问答、朗读合成外发会立刻全部被 403 CONSENT_REQUIRED 拒绝' +
    '（四条外发各自按 external_inference 判定）。若服务端已接外发账本（real 模式），撤回前还会撤销在途外发；' +
    '账本未接线时服务端会以 409 OBJECT_UNAVAILABLE 拒绝撤回（不做只撤一半）。已生成的结果不会被删除。',
  public_posting: '撤回「公开发布」后：发帖、评论、社区图片上传（community_image 也要求 public_posting）会立刻被 403 CONSENT_REQUIRED 拒绝，' +
    '发不了帖也发不了评论。已经发布的内容不会被删除。'
}

const STATE_LABELS = { granted: '已授权', withdrawn: '已撤回', none: '未授权' }

Page({
  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    gatePassed: false,
    checking: true,
    networkOff: false,
    busy: false,
    loading: false,
    mode: '',
    modeText: '',
    /** 最近一次读取失败的页面文案（与 errorCode 同时给出；两者都空才是"读取成功"）。 */
    errorText: '',
    /** 最近一次读取失败的契约错误码（交给 state-view 的 errorCode 决定 401/403 语气）。 */
    errorCode: '',
    items: [],
    nextCursor: null,
    /** 四个用途各一行（闭集顺序同契约 `ConsentPurpose`），行内含动作、可用性与真实原因。 */
    rows: [],
    /** 用途政策读面（授予体里的 `policy_version` 只能来自这里）。 */
    policyVersion: '',
    policyPurposes: [],
    policyPurposeText: '',
    policyLoaded: false,
    policyError: '',
    /** 最近一次写动作的结果说明（成功也写，且写的是服务端返回的 revision，不是"应该成功了"）。 */
    actionText: '',
    actionCode: ''
  },

  onLoad: function () {
    fontScale.applyFontScale(this)
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    const self = this
    // 世代标记：确认弹窗/在飞回调可能在离页、重进、重读之后才回来；旧回执一律丢弃。
    self._epoch = (self._epoch || 0) + 1
    self._grantKeys = {}
    self._blocked = {}
    self._rowNotes = {}
    self.setData({
      gatePassed: false, checking: true, items: [], nextCursor: null, rows: [],
      errorText: '', errorCode: '', mode: '', modeText: '',
      policyVersion: '', policyPurposes: [], policyPurposeText: '', policyLoaded: false, policyError: '',
      actionText: '', actionCode: ''
    })
    pageGate.start(this, function (ok) {
      self.setData({ checking: false })
      if (!ok) { self.setData({ gatePassed: false }); return }
      self.setData({ gatePassed: true, networkOff: !auth.networkEnabled() })
      if (auth.networkEnabled()) self.reload()
    })
  },

  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

  /** 同时重读清单与政策：两条都失败时**各自**如实报，不互相掩盖。 */
  reload: function () {
    this.load('')
    this.loadPolicy()
  },

  /** 读取一页清单：`cursor` 为空即重新读取第一页（并丢弃已有行）。失败一律清空，不保留旧列表冒充最新。 */
  load: function (cursor) {
    const self = this
    const epoch = self._epoch
    const first = !cursor
    self.setData({ busy: true, loading: true, errorText: '', errorCode: '' })
    consentApi.listConsents({ cursor: cursor, limit: PAGE_SIZE }).then(function (result) {
      if (epoch !== self._epoch) return
      const rows = result.items.map(function (item) { return consentApi.consentView(item) })
      self.setData({
        busy: false,
        loading: false,
        mode: result.mode,
        modeText: result.mode === 'real' ? '' : consentApi.modeNote(result.mode),
        items: first ? rows : self.data.items.concat(rows),
        nextCursor: result.nextCursor
      })
      self.buildRows()
    }).catch(function (error) {
      if (epoch !== self._epoch) return
      self.setData({
        busy: false, loading: false, items: [], nextCursor: null,
        errorText: consentApi.message(error),
        errorCode: (error && error.code) || '',
        mode: '', modeText: ''
      })
      self.buildRows()
    })
  },

  /** 读取用途政策：失败不清空政策以外的东西，但**所有开关**都会因为"没读到政策"而置灰并说明原因。 */
  loadPolicy: function () {
    const self = this
    const epoch = self._epoch
    consentApi.readPolicy().then(function (result) {
      if (epoch !== self._epoch) return
      const policy = result.policy
      const labels = policy.purposes.map(function (purpose) {
        return (consentApi.PURPOSE_LABELS[purpose] || purpose) + '（' + purpose + '）'
      })
      self.setData({
        policyLoaded: true,
        policyError: '',
        policyVersion: policy.version,
        policyPurposes: policy.purposes.slice(),
        policyPurposeText: labels.length ? labels.join('、') : '无（服务端当前没有任何生效政策）'
      })
      self.buildRows()
    }).catch(function (error) {
      if (epoch !== self._epoch) return
      self.setData({
        policyLoaded: false,
        policyVersion: '',
        policyPurposes: [],
        policyPurposeText: '',
        policyError: consentApi.message(error) + '（服务端码 ' + ((error && error.code) || '未知') + '）'
      })
      self.buildRows()
    })
  },

  /**
   * 把「清单记录 + 政策 + 本次会话里写失败带来的阻塞原因」合成四行开关。
   *
   * 状态只来自服务端清单：有记录取 `state`；没有记录就是 `none`（"未授权"），⛔ 不推断"应该已授权"。
   * 可用性只来自能证明的事实：政策读面 + 服务端刚刚给出的错误码。
   */
  buildRows: function () {
    const self = this
    const items = self.data.items || []
    const blocked = self._blocked || {}
    const policy = self.data.policyLoaded
      ? {
          version: self.data.policyVersion,
          published: self.data.policyVersion !== 'unpublished',
          purposes: (self.data.policyPurposes || []).slice()
        }
      : null
    const rows = consentApi.CONSENT_PURPOSES.map(function (purpose) {
      const record = items.filter(function (item) { return item.purpose === purpose })[0] || null
      const state = record ? record.state : 'none'
      const actionKind = state === 'granted' ? 'withdraw' : 'grant'
      const prior = (self._rowNotes || {})[purpose] || {}
      let available = true
      let reason = ''
      if (actionKind === 'grant') {
        const verdict = consentApi.grantAvailability(policy, purpose)
        available = verdict.grantable
        reason = verdict.reason
      }
      // 清单没读到 ⇒ 连"当前是什么状态"都不知道，此时**不许**给出任何动作（撤销/授予都可能打在错的前提上）。
      if (available && self.data.errorText) {
        available = false
        reason = '授权清单没有读到（服务端码 ' + (self.data.errorCode || '未知') +
          '），无法判断该用途的当前状态；请先「重新读取」再操作。'
      }
      if (available && blocked[purpose]) { available = false; reason = blocked[purpose] }
      return {
        purpose: purpose,
        label: consentApi.PURPOSE_LABELS[purpose] || purpose,
        state: state,
        stateLabel: STATE_LABELS[state] || state,
        revision: record ? record.revision : 0,
        policyVersion: record ? record.policyVersion : '',
        changedAt: record ? record.changedAt : '',
        actionKind: actionKind,
        actionLabel: actionKind === 'withdraw' ? '撤回' : '授予',
        actionDisabled: !available,
        actionReason: available ? '' : reason,
        cost: WITHDRAW_COST[purpose] || '',
        busy: prior.busy === true,
        errorText: prior.errorText || '',
        errorCode: prior.errorCode || ''
      }
    })
    self.setData({ rows: rows })
  },

  /** 行内备注（busy / 上次失败原因）按 purpose 存放；`buildRows` 每次重算时把它们贴回去。 */
  noteRow: function (purpose, patch) {
    const notes = this._rowNotes || {}
    notes[purpose] = Object.assign({}, notes[purpose] || {}, patch)
    this._rowNotes = notes
    this.buildRows()
  },

  /** 行内动作入口：按当前状态分派到授予 / 撤回（撤回先弹二次确认）。 */
  onRowAction: function (event) {
    const purpose = event && event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.purpose
      : ''
    const row = (this.data.rows || []).filter(function (item) { return item.purpose === purpose })[0]
    if (!row || row.actionDisabled || row.busy) return
    if (row.actionKind === 'withdraw') { this.onWithdraw(purpose); return }
    this.onGrant(purpose)
  },

  /**
   * 授予：**幂等键按"一次用户动作"复用** —— 同一个 purpose 的重试沿用 `this._grantKeys[purpose]`，
   * 成功后丢弃（下一次点击是一个新动作）。失败但可重试时保留，这样网络不确定的重试不会变成第二次意图。
   */
  onGrant: function (purpose) {
    const self = this
    if (!self.data.policyLoaded || !self.data.policyVersion) {
      self.noteRow(purpose, { busy: false, errorText: '用途政策尚未读取成功，未发出授予请求。', errorCode: '' })
      return
    }
    const epoch = self._epoch
    const keys = self._grantKeys || (self._grantKeys = {})
    if (!keys[purpose]) keys[purpose] = consentApi.newIdempotencyKey('consent-grant')
    const key = keys[purpose]
    self.noteRow(purpose, { busy: true, errorText: '', errorCode: '' })
    self.setData({ actionText: '', actionCode: '' })
    // 空 recipient_ids 是如实的最小值：录制/媒体处理/公开发布都不需要第三方接收方；
    // external_inference 在 `grantAvailability` 里已按"必须选已核验接收方"置灰，不会走到这里。
    consentApi.grant({
      purpose: purpose, policyVersion: self.data.policyVersion, recipientIds: [], idempotencyKey: key
    }).then(function (result) {
      if (epoch !== self._epoch) return
      delete keys[purpose]
      delete (self._blocked || {})[purpose]
      self.noteRow(purpose, { busy: false, errorText: '', errorCode: '' })
      self.setData({
        actionCode: '',
        actionText: '已授予「' + (consentApi.PURPOSE_LABELS[purpose] || purpose) + '」：服务端返回 revision ' +
          result.revision + '。正在按服务端记录重新读取清单…'
      })
      // ⛔ 不把 result 直接当成"界面已翻过去"：以重新读取到的服务端清单为准。
      self.load('')
    }).catch(function (error) {
      if (epoch !== self._epoch) return
      const blocking = consentApi.blockingReason(error, 'grant')
      if (blocking) {
        // 服务端说这件事在这个环境里做不成（例如 403 无可用已核验政策）⇒ 置灰 + 说明原因，
        // 并丢弃这次动作的幂等键（不会再重试同一个动作）。
        delete keys[purpose]
        self._blocked = self._blocked || {}
        self._blocked[purpose] = blocking
      }
      self.noteRow(purpose, {
        busy: false,
        errorText: consentApi.actionMessage(error, 'grant'),
        errorCode: (error && error.code) || ''
      })
      self.setData({ actionCode: (error && error.code) || '', actionText: '' })
    })
  },

  /** 撤回：二次确认里逐用途说清代价；确认后才发 DELETE（服务端未确认前界面不动）。 */
  onWithdraw: function (purpose) {
    const self = this
    const epoch = self._epoch
    const label = consentApi.PURPOSE_LABELS[purpose] || purpose
    wx.showModal({
      title: '撤回「' + label + '」用途授权？',
      content: WITHDRAW_COST[purpose] || '撤回后该用途的授权立即失效，依赖它的能力会被服务端拒绝。',
      confirmText: '确认撤回',
      cancelText: '再想想',
      success: function (res) {
        if (!res || !res.confirm) return
        // 晚到的确认（已离页/重进/重读）一律丢弃：不 setData，也不发 DELETE。
        if (epoch !== self._epoch) return
        self.noteRow(purpose, { busy: true, errorText: '', errorCode: '' })
        self.setData({ actionText: '', actionCode: '' })
        consentApi.withdraw({ purpose: purpose }).then(function (result) {
          if (epoch !== self._epoch) return
          delete (self._blocked || {})[purpose]
          self.noteRow(purpose, { busy: false, errorText: '', errorCode: '' })
          self.setData({
            actionCode: '',
            actionText: '已撤回「' + label + '」：服务端返回 revision ' + result.revision +
              (result.refetches ? '（428 后自动补取 ' + result.refetches + ' 次版本）' : '') +
              '。正在按服务端记录重新读取清单…'
          })
          self.load('')
        }).catch(function (error) {
          if (epoch !== self._epoch) return
          const blocking = consentApi.blockingReason(error, 'withdraw')
          if (blocking) {
            self._blocked = self._blocked || {}
            self._blocked[purpose] = blocking
          }
          self.noteRow(purpose, {
            busy: false,
            errorText: consentApi.actionMessage(error, 'withdraw'),
            errorCode: (error && error.code) || ''
          })
          self.setData({ actionCode: (error && error.code) || '', actionText: '' })
        })
      }
    })
  },

  // 与 favorites / history 同名同义（wxml 里「重新读取」按钮走 onRefresh）。
  onRefresh: function () {
    if (this.data.busy || !this.data.gatePassed) return
    if (this.data.networkOff) return
    // 重新读取 = 用服务端事实覆盖本地一切推测：清掉本次会话的阻塞原因与幂等键。
    this._blocked = {}
    this._grantKeys = {}
    this._rowNotes = {}
    this.setData({ actionText: '', actionCode: '' })
    this.reload()
  },

  onMore: function () {
    if (this.data.busy || !this.data.nextCursor) return
    this.load(this.data.nextCursor)
  },

  // 门禁动作与 favorites / history 同一口径：未登录时 requireLogin 已跳登录页（可见），
  // 已获服务端确认 ⇒ 取消被本次核实取代的旧门禁周期，并按"重新进入本页"重跑。
  onLogin: function () {
    const self = this
    auth.requireLogin(function (ok) { if (ok) { pageGate.cancel(self); self.onShow() } })
  }
})
