/**
 * 注销账号（GY-R73 / issue #19 的客户端入口）
 * ------------------------------------------------------------
 * 这一页把契约里那三个 operation 串成一条用户能走完的路：
 *   申请（POST /me/account/deletion，二次确认）→ 看回执（GET /account/deletions/{id}，
 *   回执 bearer）→ 取消（DELETE /me/account/deletion，二次确认；real 模式下受理事务已撤销该用户
 *   全部会话 ⇒ 这条路径 401/403 不可达，用户文案因此不承诺可撤回，见
 *   docs/verification/gy-r87-i19-cancel-ruling-20261107.md）。
 *
 * ## 九态（`docs/ui-state-inventory.md:33-41` 的闭集，一个不多一个不少）
 * | 状态      | 本页什么时候用它                                                        |
 * |-----------|-------------------------------------------------------------------------|
 * | guest     | 没登录、且本机也没有回执凭据 ⇒ 申请/取消都不可用，只能去登录              |
 * | loading   | 正在核实会话 / 正在读回执 / 正在提交申请 / 正在提交取消                  |
 * | empty     | 已登录、本机没有在途回执 ⇒ 「当前没有在途的注销申请」                     |
 * | ready     | 正常（有回执就展示回执，不渲染状态视图）                                 |
 * | error     | 失败且**没有**可保留的旧状态 ⇒ 给错误码 + 允许重试                       |
 * | cancelled | 取消成功后的落点（回到「未申请」的意思，但用一次性回执说明「这次取消了」） |
 * | invalid   | 回执凭据失效 / 服务端已无这条回执 ⇒ 不能查了，但**不等于**账号已注销      |
 * | stub      | `meta.execution_mode` 是 stub/preset_demo ⇒ 顶部标「替身数据」，回执照常展示 |
 * | denied    | 403 契约闭集（SCOPE_DENIED / CONSENT_REQUIRED / ACCOUNT_INACTIVE）        |
 *
 * ## 「失败保留原状态」是硬约束
 * 失败分支一律先看 `this.data.receipt`：只要已经读到过一条回执，主区就仍然留在
 * `ready`（继续显示上次读到的 id / 状态 / 到期时间），失败信息走**同区的行内提示** +
 * 重试按钮，绝不把回执从屏幕上抹掉。想改坏这条规则只需要把 `settleFailure` 里那句
 * `hasReceipt ? 'ready' : ...` 换成固定的 `'error'`，`tests/unit/miniprogram-account-deletion.test.mjs`
 * 的「网络失败保留原状态」那条会立刻变红（这是本片的负控制之一）。
 *
 * ## 确认意图绑定的是「发起确认时的身份」，不是「发请求时的会话」
 * `live(op)` 只认页面代数（`_op`），认不出**同一个页面代数里换了账号**：第一层确认挂着
 * 期间登录会话从 A 换成 B，`_op` 不变，两层回调都会通过；而 `utils/deletion-api.js` 的
 * `sessionCall` 是在发请求那一刻才取绑定，那时已经是 B —— A 的确认意图会落到 B 头上。
 * 注销不可逆，所以身份（令牌 + `auth.sessionEpoch()`）在**第一层确认打开时**捕获，
 * 之后在「第二层打开前 / 第二层回调里 / 真正发请求前」各核一次，不一致就 `settleIdentityChanged`
 * 中止并给可重试提示；申请与取消两面同构。负控制：把 `identityHeld` 换成恒 `true`，
 * `tests/unit/miniprogram-account-deletion.test.mjs` 的交叠用例会立刻红（提交次数变成 1）。
 *
 * ## 回执 bearer 的口径
 * 页面上写的限制与 `utils/deletion-api.js` 的文件头一致：本机保存、只查这一条、
 * 退出登录不删、换设备拿不到、丢了没有补发通道。页面唯一能做的是「如实说」。
 */

const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const states = require('../../utils/states')
const api = require('../../utils/deletion-api')

/** 结果不确定的码：这时候该去查回执，而不是再提交一次申请。 */
const UNCERTAIN_CODES = ['NETWORK_UNCERTAIN', 'PROVIDER_OUTCOME_UNKNOWN', 'PROVIDER_TIMEOUT', 'INPUT_UNCERTAIN']

/** 回执面「凭据没了」的码：查不到就是查不到，别顺手把登录态也当成没了。 */
const DEAD_RECEIPT_CODES = ['SESSION_REQUIRED', 'SESSION_EXPIRED', 'NOT_FOUND']

/**
 * 当前会话身份：（访问令牌, 会话世代）。
 *
 * 契约禁止客户端声明 `userId`（身份只来自服务端签发的令牌），所以页面能观测到的
 * 「这是哪个账号」只有这一对事实：`auth.getSession().accessToken` + `auth.sessionEpoch()`。
 * `utils/auth.js` 的 `setSession` 在**令牌变化**时递增 `generation`，而 `sessionEpoch()`
 * 就是 `generation:intentEpoch`，所以换账号必然让这一对变化；退出/清会话同理。
 * 取不到会话 ⇒ `null`（此时连确认都不该弹）。同构做法见 `pages/consent/consent.js:39-43`。
 */
function sessionIdentity() {
  const session = auth.getSession()
  if (!session || typeof session.accessToken !== 'string' || session.accessToken === '') return null
  return session.accessToken + '@' + auth.sessionEpoch()
}

/**
 * 确认意图失效的文案。两面各写一句，都必须出现「登录身份已变更，请重新发起」，
 * 并且点明**没有发出请求** —— 注销不可逆，用户不能靠猜「到底提交了没有」。
 */
const IDENTITY_CHANGED_TEXT = {
  apply: '登录身份已变更，请重新发起：这次确认属于切换之前的那个账号，已作废，没有向服务端提交注销申请。',
  cancel: '登录身份已变更，请重新发起：这次确认属于切换之前的那个账号，已作废，没有提交取消请求。'
}

Page({
  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    status: 'loading',
    loadingTitle: '正在核实登录状态与本机回执',
    errorCode: '',
    errorText: '',
    retryable: false,
    retryIntent: '',
    busy: false,
    message: '',
    guest: true,
    offline: false,
    stubNotice: false,
    executionMode: '',
    receipt: null,
    receiptExpiresAt: '',
    hasCredential: false,
    snapshotOnly: false
  },

  onLoad: function () {
    this._op = 0
    fontScale.applyFontScale(this)
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    this.restore()
  },

  // 离开页面就让在途回调失效：回来后 onShow 会重新核实，不拿旧响应覆盖新画面。
  onHide: function () {
    this._op = (this._op || 0) + 1
  },

  onUnload: function () {
    this._op = (this._op || 0) + 1
  },

  nextOp: function () {
    this._op = (this._op || 0) + 1
    return this._op
  },

  live: function (op) {
    return (this._op || 0) === op
  },

  /**
   * 确认意图的身份闸门。
   *
   * `live(op)` 只认页面代数，认不出「同一个页面代数里换了账号」：第一层确认打开期间
   * 登录会话从 A 变成 B，`_op` 一个数都没动，两层回调都会通过；而 `utils/deletion-api.js`
   * 的 `sessionCall` 是在**发请求那一刻**才取绑定的 —— 那时已经是 B，于是 A 的确认意图
   * 落到了 B 头上（注销不可逆，这条不能靠「请求期间 current(b)」兜）。
   *
   * 所以比的是**发起这次确认那一刻**的身份：不一致就当场作废并落可重试的中止态，
   * 调用方立刻 return，不发任何请求。
   */
  identityHeld: function (identity, intent) {
    if (identity && sessionIdentity() === identity) return true
    this.settleIdentityChanged(intent)
    return false
  },

  /**
   * 身份变了的中止态：与 `settleFailure` 同一套「有回执就留在 ready」的口径，
   * 但没有一条契约码能表达「确认作废」这件事 —— 码沿用 `SESSION_CHANGED`，
   * 文案用本页自己的，重试性显式判 true（这次中止什么都没做，重来一遍是安全的）。
   */
  settleIdentityChanged: function (intent) {
    const text = IDENTITY_CHANGED_TEXT[intent] || IDENTITY_CHANGED_TEXT.apply
    const hasReceipt = !!this.data.receipt
    const data = {
      status: hasReceipt ? 'ready' : 'error',
      busy: false,
      loadingTitle: '',
      errorCode: 'SESSION_CHANGED',
      errorText: text,
      retryable: true,
      retryIntent: intent,
      message: text,
      guest: !auth.isLoggedIn()
    }
    if (hasReceipt) data.snapshotOnly = true
    this.setData(data)
  },

  // ------------------------------------------------------------ 首屏

  /**
   * 首屏：先看本机有没有回执凭据（有就先按快照显示，满足「别清屏」），再尝试刷新。
   * 没有凭据时按登录态分 guest / empty —— 这两态的区别就是「能不能发起申请」。
   */
  restore: function () {
    const op = this.nextOp()
    const offline = !auth.networkEnabled()
    const stored = api.loadReceipt()
    const loggedIn = auth.isLoggedIn()
    const base = { guest: !loggedIn, offline: offline, busy: false }
    if (!stored) {
      this.setData(Object.assign(base, {
        status: loggedIn ? 'empty' : 'guest',
        loadingTitle: '',
        receipt: null,
        receiptExpiresAt: '',
        hasCredential: false,
        snapshotOnly: false,
        errorCode: '',
        errorText: '',
        retryable: false,
        retryIntent: '',
        message: ''
      }))
      return
    }
    const snapshot = stored.deletion ? api.describe(stored.deletion) : null
    this.setData(Object.assign(base, {
      status: snapshot ? 'ready' : 'loading',
      loadingTitle: '正在读取注销回执',
      receipt: snapshot,
      receiptExpiresAt: api.formatTime(stored.expiresAt),
      hasCredential: true,
      snapshotOnly: !!snapshot,
      errorCode: '',
      errorText: '',
      retryable: false,
      retryIntent: '',
      message: ''
    }))
    if (offline) {
      if (!snapshot) {
        this.setData({
          status: 'error',
          errorCode: 'UNAVAILABLE',
          errorText: '本机没有配置服务端地址，无法读取回执；也没有本机快照可显示。',
          retryable: false
        })
      } else {
        this.setData({ message: '当前未接服务端，下面是本机上次读到的回执快照。' })
      }
      return
    }
    this.loadReceipt(op)
  },

  /** 读回执（回执 bearer 面）。失败时由 settleFailure 决定是否保留原状态。 */
  loadReceipt: async function (op) {
    const stored = api.loadReceipt()
    if (!stored) {
      this.settleFailure({ code: 'SESSION_REQUIRED' }, 'read')
      return
    }
    if (!this.data.receipt) this.setData({ status: 'loading', loadingTitle: '正在读取注销回执', busy: true })
    else this.setData({ busy: true })
    try {
      const result = await api.readReceipt(stored.id)
      if (!this.live(op)) return
      // 快照跟着刷新：下次断网/失败时能显示「上次读到的」而不是白屏。
      api.saveReceipt({
        id: result.deletion.id,
        token: stored.token,
        expiresAt: stored.expiresAt,
        deletion: result.deletion
      })
      this.showReceipt(result.deletion, result.meta, { message: '回执已刷新。' })
    } catch (e) {
      if (!this.live(op)) return
      this.settleFailure(e, 'read')
    }
  },

  /** 「刷新回执」按钮：不改变已有回执，只是再读一次。 */
  refreshReceipt: function () {
    const op = this.nextOp()
    if (!auth.networkEnabled()) {
      this.setData({ busy: false, message: '本机没有配置服务端地址，无法读取回执。' })
      return
    }
    this.loadReceipt(op)
  },

  // ------------------------------------------------------------ 展示

  showReceipt: function (deletion, meta, extra) {
    const view = api.describe(deletion)
    const data = {
      status: 'ready',
      busy: false,
      guest: !auth.isLoggedIn(),
      loadingTitle: '',
      receipt: view,
      hasCredential: true,
      snapshotOnly: false,
      executionMode: meta && meta.execution_mode ? meta.execution_mode : '',
      stubNotice: !!(meta && states.isMockMode(meta.execution_mode)),
      errorCode: '',
      errorText: '',
      retryable: false,
      retryIntent: '',
      message: extra && extra.message ? extra.message : ''
    }
    if (extra && extra.expiresAt) data.receiptExpiresAt = api.formatTime(extra.expiresAt)
    this.setData(data)
  },

  /**
   * 失败落点。规则只有一条：**有回执就留在 ready**，其余按九态分派。
   * 回执面（intent==='read'）永远不判 guest：那条 401 说的是凭据，不是登录态。
   */
  settleFailure: function (error, intent) {
    const code = error && error.code ? error.code : 'UNAVAILABLE'
    const info = api.resolveCode(code)
    const text = api.messageFor(code, intent)
    const hasReceipt = !!this.data.receipt
    let status
    if (intent === 'read') {
      if (DEAD_RECEIPT_CODES.indexOf(code) !== -1) status = 'invalid'
      else status = hasReceipt ? 'ready' : 'error'
    } else if (hasReceipt) {
      status = 'ready'
    } else if (info.status === 'guest') {
      status = 'guest'
    } else if (info.status === 'denied') {
      status = 'denied'
    } else {
      status = 'error'
    }
    const data = {
      status: status,
      busy: false,
      loadingTitle: '',
      errorCode: code,
      errorText: text,
      retryable: info.retryable !== false,
      retryIntent: this.retryIntentFor(intent, code),
      message: text,
      guest: !auth.isLoggedIn()
    }
    if (status === 'invalid') {
      // 凭据确实死了才丢：留着它只会让下一次请求再吃一个 401。
      api.clearReceipt()
      data.receipt = null
      data.receiptExpiresAt = ''
      data.hasCredential = false
      data.snapshotOnly = false
    } else if (status === 'ready') {
      data.snapshotOnly = true
    }
    this.setData(data)
  },

  retryIntentFor: function (intent, code) {
    if (intent === 'apply' && UNCERTAIN_CODES.indexOf(code) !== -1) return 'read'
    return intent
  },

  // ------------------------------------------------------------ 申请

  canOperate: function () {
    if (this.data.busy) return false
    if (!auth.networkEnabled()) {
      this.setData({ message: '本机没有配置服务端地址，无法发起注销。' })
      return false
    }
    if (!auth.isLoggedIn()) {
      this.setData({
        message: '需要先登录：注销绑定当前登录账号。',
        guest: true,
        status: this.data.receipt ? this.data.status : 'guest'
      })
      return false
    }
    return true
  },

  /**
   * 申请入口。**两次**确认：
   *   1) 说清后果（数据不可恢复）与口径（冷静期/生效时间以服务端返回的 deletion 为准）；
   *   2) 再说一次「确认提交」。
   * 两步都要重新算一次 `live(op)`，第一次对话框期间用户切走/换账号，第二步就不再弹。
   * 「换账号」由 `identityHeld` 判：身份在**第一层确认打开时**捕获，第二层打开前、
   * 第二层回调里、真正发请求前各核一次 —— 换过账号的确认意图不许落到新账号头上。
   */
  requestDeletion: function () {
    const self = this
    if (!this.canOperate()) return
    const identity = sessionIdentity()
    if (!identity) {
      this.setData({ message: '登录状态已失效，请重新登录后再操作。', guest: true })
      return
    }
    const op = this.nextOp()
    this.setData({ busy: true })
    wx.showModal({
      title: '注销账号',
      content: '注销后账号数据不可恢复：档案、收藏、识别历史与社区内容都会按服务端流程清除。现在提交只是发起申请：生效时间与冷静期以服务端返回的 deletion 字段为准（申请后会显示在回执里），客户端不自己算天数。注意：服务端受理这个申请时会立即撤销这个账号的所有登录会话；该申请一旦受理就不能在客户端撤回。',
      confirmText: '继续',
      cancelText: '不注销',
      success: function (first) {
        if (!self.live(op)) return
        if (!first || !first.confirm) {
          self.setData({ busy: false, message: '已取消，没有提交注销申请。' })
          return
        }
        // 第一层确认挂着期间换了账号：第二层就不弹了，A 的意图不许借 B 的会话继续。
        if (!self.identityHeld(identity, 'apply')) return
        wx.showModal({
          title: '再次确认',
          content: '确认向服务端提交注销申请？提交后会返回一条回执，凭本机保存的回执凭据可以查询进度。受理后服务端会立即撤销这个账号的所有登录会话，该申请不能在客户端撤回。',
          confirmText: '确认注销',
          confirmColor: '#b3261e',
          cancelText: '返回',
          success: function (second) {
            if (!self.live(op)) return
            if (!second || !second.confirm) {
              self.setData({ busy: false, message: '已取消，没有提交注销申请。' })
              return
            }
            // 第二层弹窗挂着的期间同样可能换账号（用户切到后台换完再回来点确认）。
            if (!self.identityHeld(identity, 'apply')) return
            self.submitDeletion(op, identity)
          },
          fail: function () {
            if (self.live(op)) self.setData({ busy: false, message: '确认框没有打开，本次没有提交。' })
          }
        })
      },
      fail: function () {
        if (self.live(op)) self.setData({ busy: false, message: '确认框没有打开，本次没有提交。' })
      }
    })
  },

  submitDeletion: async function (op, identity) {
    if (!this.live(op)) return
    // 最后一道：真的要把请求发出去之前再核一次身份。上面两层都核过，但「第二层回调
    // 返回」到「这里发请求」之间仍可能换账号，而这一层之后 `sessionCall` 取的就是当前会话了。
    if (!this.identityHeld(identity, 'apply')) return
    const hadReceipt = !!this.data.receipt
    this.setData({ busy: true, message: '', loadingTitle: '正在提交注销申请' })
    if (!hadReceipt) this.setData({ status: 'loading' })
    try {
      const accepted = await api.requestAccountDeletion()
      if (!this.live(op)) return
      api.saveReceipt({
        id: accepted.deletion.id,
        token: accepted.receiptToken,
        expiresAt: accepted.receiptExpiresAt,
        deletion: accepted.deletion
      })
      this.setData({ receiptExpiresAt: api.formatTime(accepted.receiptExpiresAt) })
      this.showReceipt(accepted.deletion, accepted.meta, {
        message: '注销申请已受理：下面是服务端返回的回执。',
        expiresAt: accepted.receiptExpiresAt
      })
    } catch (e) {
      if (!this.live(op)) return
      this.settleFailure(e, 'apply')
    }
  },

  // ------------------------------------------------------------ 取消

  /** 取消入口，同样两次确认（取消会作废回执，算不可轻率的操作），身份闸门与申请同构。 */
  cancelDeletion: function () {
    const self = this
    if (!this.canOperate()) return
    const identity = sessionIdentity()
    if (!identity) {
      this.setData({ message: '登录状态已失效，请重新登录后再操作。', guest: true })
      return
    }
    if (!this.data.receipt) {
      this.setData({ message: '本机没有在途回执可取消：先刷新回执，或重新申请后再取消。' })
      return
    }
    const op = this.nextOp()
    this.setData({ busy: true })
    wx.showModal({
      title: '取消注销申请',
      content: '若取消成功：账号恢复为未申请注销、数据不会被删除、这条回执随即作废。注意：真实服务端受理注销时已撤销该账号的全部登录会话，这一步通常会被判会话失效而失败。确认取消这次申请？',
      confirmText: '继续',
      cancelText: '保留申请',
      success: function (first) {
        if (!self.live(op)) return
        if (!first || !first.confirm) {
          self.setData({ busy: false, message: '已保留这次注销申请。' })
          return
        }
        if (!self.identityHeld(identity, 'cancel')) return
        wx.showModal({
          title: '再次确认',
          content: '再确认一次：取消这次注销申请？取消结果以服务端返回的回执为准。',
          confirmText: '确认取消',
          cancelText: '返回',
          success: function (second) {
            if (!self.live(op)) return
            if (!second || !second.confirm) {
              self.setData({ busy: false, message: '已保留这次注销申请。' })
              return
            }
            if (!self.identityHeld(identity, 'cancel')) return
            self.submitCancel(op, identity)
          },
          fail: function () {
            if (self.live(op)) self.setData({ busy: false, message: '确认框没有打开，本次没有取消。' })
          }
        })
      },
      fail: function () {
        if (self.live(op)) self.setData({ busy: false, message: '确认框没有打开，本次没有取消。' })
      }
    })
  },

  submitCancel: async function (op, identity) {
    if (!this.live(op)) return
    // 同 `submitDeletion`：取消会把回执作废，也不能把 A 的取消意图交给 B 去发。
    if (!this.identityHeld(identity, 'cancel')) return
    this.setData({ busy: true, message: '', loadingTitle: '正在取消注销申请' })
    try {
      const result = await api.cancelDeletion()
      if (!this.live(op)) return
      // 取消成功后回执就作废了：留着凭据只会让用户以为还能查/还能取消。
      api.clearReceipt()
      const view = api.describe(result.deletion)
      this.setData({
        status: 'cancelled',
        busy: false,
        loadingTitle: '',
        receipt: null,
        receiptExpiresAt: '',
        hasCredential: false,
        snapshotOnly: false,
        errorCode: '',
        errorText: '',
        retryable: false,
        retryIntent: '',
        guest: !auth.isLoggedIn(),
        message: '已取消注销申请（服务端回执状态：' + (view ? view.stateLabel : '已取消') + '），账号没有被注销。'
      })
    } catch (e) {
      if (!this.live(op)) return
      // 取消失败不清回执：用户还得靠它再试一次或刷新。
      this.settleFailure(e, 'cancel')
    }
  },

  // ------------------------------------------------------------ 交互

  onApply: function () {
    this.requestDeletion()
  },

  onRefresh: function () {
    this.refreshReceipt()
  },

  onCancel: function () {
    this.cancelDeletion()
  },

  /** 重试按钮：按上次失败的意图重来；申请类重试会重新走两次确认，不静默重复提交。 */
  onRetry: function () {
    const intent = this.data.retryIntent
    if (intent === 'read') {
      this.refreshReceipt()
      return
    }
    if (intent === 'cancel') {
      this.cancelDeletion()
      return
    }
    this.requestDeletion()
  },

  onLogin: function () {
    const self = this
    auth.requireLogin(function (ok) {
      if (ok) self.onShow()
    })
  }
})
