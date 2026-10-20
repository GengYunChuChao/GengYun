// GY-I12 **原生文字提问页**（Refs #12）。
//
// 链路（四段式，每段都如实呈现，绝不跳过前一段）：
//   ① 输入与显式发送：文字输入 → 空白/上限显式校验（**不静默截断**）→ 显式「发送」按钮；
//   ② 会话创建与复用：首次发送前 `POST /conversations`，本页缓存 `{id, revision}`；**发送中防重复**
//      （`busy` 守卫 + WXML disabled，双击零第二发）；
//   ③ 任务有界轮询：`POST /conversations/{id}/turns` 的 202 给出 `job_id` 与 `deadline_at`，
//      按 1s 一拍、30 拍上限轮询 `GET /jobs/{id}`；七类 `JobState` 与 `error_code` 逐类呈现，
//      到达 `deadline_at` 仍未终态 ⇒ 如实报「未在截止时间内取得回答」，**不自动重发**（重发=新的
//      付费/推理请求，必须由用户明确重试**并严格回放同一请求身份**）；
//   ④ 回答展示：**只有** `status==='answered'` 且 `check_state==='passed'` 且结构完整时**整体**展示
//      已检查回答与来源；`insufficient`/`blocked`/失败/超时/未接线按实际协议逐类呈现，
//      **不流式**、不部分展示、不把替身回答说成真实能力。
//
// 用药安全（不可绕过）：
//   - 回答来源**仅**从服务端 `citations` 引用集合逐字来，不生成链接、不补默认来源；
//   - `dose_cards` **只报条数**与来源资格判定，不渲染用量正文、不生成剂量换算或处方；
//     条件/来源/版本任一项不符 ⇒ 明确关闭并说明原因（见 `qaApi.doseCardsView`）；
//   - 本页**不**把回答正文当富文本转 HTML（一律 `text` 节点呈现）。
//
// 请求身份（返修 P1）：**202 受理之后不清尝试身份**。同一意图（同会话、同 revision、同正文）的
//   重试严格复用同一把 `Idempotency-Key`（服务端按同键回放同一任务，不会重复创建付费作业）；
//   只有用户**明确开始新的提问**（改正文并重新发送，或点「清空」重新开始）才换键。
//
// 隐私与生命周期：
//   - 不把私有提问/回答写普通日志或公共 storage；`wx.setStorageSync` 在本页一次都不调用；
//   - onHide/onUnload/身份 epoch 变化/门禁失效 ⇒ 停轮询 + `qaApi.cancelAll()` + 递增操作代次 +
//     **清空全部私有展示与会话缓存**（草稿、回答、来源、轮次、会话 id/revision、尝试身份）：
//     返回本页时先经 `pageGate` 重新核实身份，旧内容绝不留给新身份看到；
//   - 用途授权（403 `CONSENT_REQUIRED`）依现有守卫原样提示，**不在客户端假造同意**；
//   - 登录/当前身份版本沿用 `utils/auth` + `utils/page-gate`（只认经服务端核实的会话）。
const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const qaApi = require('../../utils/qa-api')

/**
 * 执行模式 → 用户能读懂的一句话（原始 `stub`/`preset_demo` 串不进主界面）。
 * 服务端当前基线均为演示数据；`real` 只在真正接上真实服务时才会出现。
 */
function modeLabelOf(mode) {
  if (mode === 'real') return '真实服务'
  if (mode === 'stub') return '演示数据'
  if (mode === 'preset_demo') return '演示数据'
  return ''
}

Page({
  onLoad: function () {
    fontScale.applyFontScale(this)
    this._generation = 0
    this._gone = false
    this._pollTimer = null
    /** 本页会话缓存（`{id, revision}`）；仅在已核实会话的本次进程内有效。 */
    this._conversation = null
    /** 会话创建的尝试身份（幂等键固化：同一次会话创建的重试复用同一把键）。 */
    this._conversationAttempt = null
    /**
     * 本次提问的尝试身份（幂等键固化）：**202 受理之后仍然保留**，
     * 直到用户改正文后重新发送、或明确点「清空」重新开始、或离开本页/身份变化。
     * 保留它 = 保留"已受理任务"的请求身份：重试严格回放同一把键，服务端按同键回放同一任务。
     */
    this._sendAttempt = null
    /** 已受理作业对应的尝试键（仅用于判断"这次重试还是不是同一个问题"，不参与展示）。 */
    this._acceptedAttemptKey = ''
    /** 当前在途轮询对应的 job 与截止时间（有界轮询的唯一边界来源）。 */
    this._poll = null
    /** 当前已核实身份的服务端 epoch（`auth.sessionEpoch()`）；变化即视为换人。 */
    this._epoch = auth.sessionEpoch()
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    const that = this
    // 上一轮的"已离开本页"说明只在离开时才有意义；重新进入本页即清掉，不留旧状态。
    this.setData({ fontScale: fontScale.currentFontScale(), exitReason: '' })
    this._gateFirst = true
    pageGate.start(this, function (ok) {
      // `pageGate.start` 会先同步回调一次 `false`（"门禁核实开始"），再用核实结果回调第二次。
      // 第一次回调只代表"还没核实完"，**不能**据此通报登录失效、更不能把已清空的页面再写一遍。
      const provisional = that._gateFirst === true
      that._gateFirst = false
      const epoch = auth.sessionEpoch()
      // 换账号/重新登录（epoch 变化）⇒ 先同步清除旧身份的私有内容，再谈展示。
      if (epoch !== that._epoch) {
        that._epoch = epoch
        that.closePrivate('账号或登录状态已变化：已清除本页原来的提问与回答。')
      }
      const loggedIn = ok === true && auth.isLoggedIn()
      that.setData({
        guest: loggedIn !== true,
        networkOff: loggedIn === true && !auth.networkEnabled()
      })
      if (provisional && ok !== true) return
      if (loggedIn !== true) that.closePrivate('登录状态不可用：本页内容已清除，未发送任何内容。')
    })
  },

  // 返回 / 切页 / 隐藏：三条路径都走同一个释放出口（并清空私有内容）。
  onHide: function () {
    pageGate.cancel(this)
    this.releaseAll('hide')
  },
  onUnload: function () {
    // 卸载后本页不会再有 `onShow`：标记为"已消失"，杜绝任何入口在卸载后续跑。
    this._gone = true
    pageGate.cancel(this)
    this.releaseAll('unload')
  },

  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    guest: true,
    networkOff: false,
    // 契约上限（`TextTurnInput.text.maxLength`）原样带到模板，供长度计数与提示使用。
    textMax: qaApi.TEXT_MAX,
    // ① 输入
    draft: '',
    draftLength: 0,
    inputNote: '',
    // ② 会话与任务（`conversationId`/`conversationRevision` 只做内部状态，不上主界面）
    conversationId: '',
    conversationRevision: 0,
    busy: false,
    stage: 'idle',
    mode: '',
    modeLabel: '',
    job: null,
    taskNote: '',
    taskErrorCode: '',
    // ③ 回答（只有闸门放行才整体展示）
    answer: null,
    answerGateCode: '',
    answerGateMessage: '',
    citations: [],
    doseCards: null,
    answerNote: '',
    // 轮次历史（本次会话内；只展示服务端真实返回）
    turns: [],
    turnsNote: '',
    exitReason: '',
    unwiredNote: qaApi.UNWIRED_ANSWER_NOTE
  },

  // ---------------------------------------------------------------- 操作代次与释放

  beginOperation: function () {
    this._generation = (this._generation || 0) + 1
    return this._generation
  },

  /**
   * 操作是否仍然有效：代次一致、页面未卸载、已登录、且**身份 epoch 未变**。
   *
   * epoch 判据保证：切账号/重新登录后，旧身份的在途回调不会把私有正文写回页面。
   */
  isCurrent: function (generation) {
    return this._generation === generation
      && this._gone !== true
      && this.data.guest !== true
      && this._epoch === auth.sessionEpoch()
  },

  /** 关闭私有展示（未登录/门禁失效/离页）：停轮询、作废在途请求、清空会话缓存与全部私有内容。 */
  closePrivate: function (note) {
    this.releaseAll('gate')
    if (typeof note === 'string' && note !== '') this.setData({ taskNote: note })
  },

  /**
   * 统一的释放出口：停轮询 → 作废在途请求 → 递增代次 → **清空所有私有显示与会话缓存**。
   *
   * 幂等；`cancelAll()` 之后迟到的回调一律失效（不回填私有正文、不触发新的发送）。
   * 之所以连 `_conversation`/`_sendAttempt` 一并清掉：页面隐藏后可能被**另一个账号**返回并复用，
   * 只在请求层做 token/epoch 绑定不足以清掉已经 `setData` 到页面上的旧内容。
   */
  releaseAll: function (reason) {
    this.stopPoll()
    qaApi.cancelAll()
    this.beginOperation()
    this._poll = null
    this._conversation = null
    this._conversationAttempt = null
    this._sendAttempt = null
    this._acceptedAttemptKey = ''
    this.setData({
      draft: '', draftLength: 0, inputNote: '',
      conversationId: '', conversationRevision: 0,
      busy: false, stage: 'idle', mode: '', modeLabel: '', job: null,
      taskNote: '', taskErrorCode: '',
      answer: null, answerGateCode: '', answerGateMessage: '', citations: [], doseCards: null, answerNote: '',
      turns: [], turnsNote: '',
      // 只有"用户主动离页"才留一句离页说明；门禁失效/换账号由各自的 taskNote 说明。
      exitReason: reason === 'hide' || reason === 'unload' ? reason : ''
    })
  },

  stopPoll: function () {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null }
  },

  // ---------------------------------------------------------------- ① 输入

  onDraftInput: function (event) {
    const value = event && event.detail ? event.detail.value : ''
    const text = typeof value === 'string' ? value : ''
    // 只更新草稿与长度计数：**不**做任何 maxlength 裁剪（模板 `maxlength="-1"` 已关闭原生 140 上限；
    // 超限在发送前被显式拒绝）。
    this.setData({ draft: text, draftLength: text.length, inputNote: '' })
    // 正文变了 ⇒ 这是另一个提问意图：下一次发送自然换新键（descriptor 不同，`stableKey` 自会换）。
  },

  /** 明确重新开始：清空草稿并丢弃本次尝试身份（同文再问才算新提问、新键）。 */
  onClearDraft: function () {
    this._sendAttempt = null
    this._acceptedAttemptKey = ''
    this.setData({
      draft: '', draftLength: 0, inputNote: '', taskNote: '', taskErrorCode: '',
      job: null, stage: 'idle', mode: '', modeLabel: ''
    })
  },

  /**
   * 本地前置校验（发请求前；零请求）。
   *
   * 空白与超长（>8000，契约 `TextTurnInput.text.maxLength`）一律显式拒绝并给出实际长度，
   * **绝不静默截断**（截断会把用户没问过的问题发出去）。
   *
   * 计数单位：`String.length`（UTF-16 码元），与 `services/api/src/conversations/validate.ts`
   * 的 `value.length` 完全同口径——客户端与服务端不会各按一套单位互相打架；
   * 一个 emoji 在这种口径下计 2，界面上统一称「字」并注明该口径，不宣称"码点"。
   */
  localGate: function () {
    const text = this.data.draft
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, code: 'EMPTY_TEXT', message: '还没有输入问题：请输入后再发送（未发出任何请求）。' }
    }
    if (text.length > qaApi.TEXT_MAX) {
      return {
        ok: false,
        code: 'TEXT_TOO_LONG',
        message: '已输入 ' + text.length + ' 字，超过上限 ' + qaApi.TEXT_MAX
          + '：本页不会自动截断，请缩短后再发送（未发出任何请求）。'
      }
    }
    return { ok: true }
  },

  // ---------------------------------------------------------------- ② 发送与轮询

  /**
   * 显式发送：创建/复用会话 → POST 文字轮次 → 有界轮询 → 回答闸门。
   *
   * 防重复：`busy` 为真或 `_gone`/`guest` 一律直接返回（WXML 的 disabled 同步表达）。
   *
   * **请求身份**：`_sendAttempt` 在 202 受理后依然保留；同一意图的重试因此严格回放同一把
   * `Idempotency-Key`（服务端同键回放同一任务，不重复创建付费作业）。
   */
  onSend: async function () {
    if (this._gone === true || this.data.guest || this.data.busy) return
    const local = this.localGate()
    if (local.ok !== true) {
      // 主流程只说人话：内部校验码（EMPTY_TEXT/TEXT_TOO_LONG）留在 `localGate` 的返回值与报告里。
      this.setData({ inputNote: local.message, stage: 'idle', job: null, taskNote: '', taskErrorCode: '' })
      return
    }
    const generation = this.beginOperation()
    this.stopPoll()
    qaApi.cancelAll()
    this._poll = null
    this.setData({
      busy: true, stage: 'sending', taskNote: '', taskErrorCode: '', job: null,
      answer: null, answerGateCode: '', answerGateMessage: '', citations: [], doseCards: null, answerNote: ''
    })
    const text = this.data.draft
    try {
      // 会话创建与复用：本页缓存；不存在或已失效才新建（新建也带幂等键）。
      if (this._conversation === null) {
        const conversationKey = qaApi.stableKey(this._conversationAttempt, 'i12-conversation', 'i12-conversation')
        this._conversationAttempt = { descriptor: 'i12-conversation', key: conversationKey }
        const created = await qaApi.createConversation(conversationKey)
        if (!this.isCurrent(generation)) return
        this._conversation = { id: created.conversation.id, revision: created.conversation.revision }
        this.setData({
          conversationId: created.conversation.id,
          conversationRevision: created.conversation.revision,
          mode: created.mode,
          modeLabel: modeLabelOf(created.mode)
        })
      }
      if (!this.isCurrent(generation)) return
      const conversation = this._conversation
      // 尝试身份：同正文、同会话 revision ⇒ 同一把键（**202 受理之后也保持**）。
      const descriptor = 'send:' + conversation.id + ':' + conversation.revision + ':' + text
      const sendKey = qaApi.stableKey(this._sendAttempt, descriptor, 'i12-send')
      this._sendAttempt = { descriptor: descriptor, key: sendKey }
      const sameAttempt = typeof this._acceptedAttemptKey === 'string' && this._acceptedAttemptKey !== ''
        && this._acceptedAttemptKey === sendKey
      // 已受理且同一意图 ⇒ 重试**严格回放原键**（服务端按同键回放同一任务，零新任务身份）。
      if (sameAttempt) this.setData({ taskNote: '正在恢复同一个问题的结果…', stage: 'pending' })
      const sent = await qaApi.sendTextTurn({
        conversationId: conversation.id,
        conversationRevision: conversation.revision,
        text: text,
        idempotencyKey: sendKey
      })
      if (!this.isCurrent(generation)) return
      // 受理已落定：**保留**本次尝试身份，后续"重试"仍是同一个请求（同键回放，不新建任务）。
      this._acceptedAttemptKey = sendKey
      this.setData({
        mode: sent.mode,
        modeLabel: modeLabelOf(sent.mode),
        job: qaApi.describeJob(sent.job),
        taskNote: sent.job.state === 'queued' || sent.job.state === 'running' ? '问题已发送，正在查找答案…' : '',
        stage: qaApi.isTerminal(sent.job.state) ? 'settled' : 'pending'
      })
      if (qaApi.isTerminal(sent.job.state)) { this.settle(sent.job, generation); return }
      this.startPoll(sent.job.id, generation)
    } catch (error) {
      if (!this.isCurrent(generation)) return
      if (isGateLoss(error)) { this.closePrivate(qaApi.messageFor(error)); return }
      if (error.code === 'REVISION_CONFLICT' || error.code === 'NOT_FOUND') {
        // 会话侧版本变化/丢失：丢弃本地会话缓存，让用户重试（同一把发送键不会重复写入）。
        this._conversation = null
        this.setData({
          conversationId: '', conversationRevision: 0, busy: false, stage: 'ready',
          taskErrorCode: typeof error.code === 'string' ? error.code : 'UNAVAILABLE',
          taskNote: qaApi.messageFor(error) + '：会话已失效，请重试（同一个问题不会重复提交）。'
        })
        return
      }
      this.setData({
        busy: false, stage: 'ready',
        taskErrorCode: typeof error.code === 'string' ? error.code : 'UNAVAILABLE',
        taskNote: qaApi.messageFor(error) + '：发送未确认，可以重试（同一个问题不会重复提交）。'
      })
    }
  },

  /** 有界轮询：1s 一拍、30 拍上限，且以 202 回传的 `deadline_at` 为真正边界。 */
  startPoll: function (jobId, generation) {
    const that = this
    this.stopPoll()
    const deadlineMs = this._pollDeadlineMs()
    this._poll = { jobId: jobId, generation: generation }
    let ticks = 0
    this._pollTimer = setInterval(function () {
      ticks += 1
      if (!that.isCurrent(generation)) { that.stopPoll(); return }
      const live = that._poll
      if (live === null || live.jobId !== jobId) { that.stopPoll(); return }
      if (ticks > qaApi.POLL_MAX_TICKS || (deadlineMs > 0 && Date.now() >= deadlineMs)) {
        that.stopPoll()
        that._poll = null
        that.setData({
          busy: false, stage: 'ready', taskErrorCode: 'ANSWER_NOT_PRODUCED',
          taskNote: '等待超时，暂时没有拿到回答。本页不会自动重发；点「重试」会接着看同一个问题的结果，不会重复提交。'
        })
        return
      }
      that.refreshJob(jobId, generation)
    }, qaApi.POLL_INTERVAL_MS)
  },

  /** 由当前 job 投影的 `deadline_at` 换算轮询边界（页面不内联猜时长）。 */
  _pollDeadlineMs: function () {
    const job = this.data.job
    const deadline = job && job.deadlineAt ? job.deadlineAt : ''
    const ms = Date.parse(deadline)
    return Number.isFinite(ms) ? ms + qaApi.POLL_INTERVAL_MS : 0
  },

  refreshJob: async function (jobId, generation) {
    try {
      const read = await qaApi.getJob(jobId)
      if (!this.isCurrent(generation)) return
      if (this._poll === null || this._poll.jobId !== jobId) return
      this.setData({
        mode: read.mode,
        modeLabel: modeLabelOf(read.mode),
        job: qaApi.describeJob(read.job),
        stage: qaApi.isTerminal(read.job.state) ? 'settled' : 'pending'
      })
      if (qaApi.isTerminal(read.job.state)) {
        this.stopPoll()
        this._poll = null
        this.settle(read.job, generation)
      }
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.stopPoll()
      this._poll = null
      if (isGateLoss(error)) { this.closePrivate(qaApi.messageFor(error)); return }
      this.setData({
        busy: false, stage: 'ready',
        taskErrorCode: typeof error.code === 'string' ? error.code : 'UNAVAILABLE',
        taskNote: qaApi.messageFor(error) + '：已停止等待，可以重试（同一个问题不会重复提交）。'
      })
    }
  },

  /**
   * 终态落定：先按任务状态分类说明，再过**回答可展示性闸门**。
   *
   * `succeeded` 也可能给不出可展示回答（未过安全检查/资料不足/无引用/结构畸形）——
   * 一律如实呈现，**不**把"没有可展示回答"写成"回答成功"。
   */
  settle: function (job, generation) {
    if (!this.isCurrent(generation)) return
    this.stopPoll()
    this._poll = null
    this.setData({ busy: false, stage: 'settled' })
    if (job.state !== 'succeeded') {
      const note = job.state === 'uncertain'
        ? '这次没有拿到确定的结果，暂不展示回答。'
        : (job.state === 'timed_out'
          ? '等待超时，暂不展示回答。'
          : (job.state === 'failed'
            ? '这次没有生成回答。'
            : '这次提问已取消，暂不展示回答。'))
      this.setData({
        answer: null, citations: [], doseCards: null,
        answerGateCode: 'ANSWER_NOT_PRODUCED',
        answerGateMessage: note
      })
      return
    }
    const answer = job.result === null ? null : job.result
    const gate = qaApi.evaluateAnswerGate(answer)
    if (gate.ok !== true) {
      this.setData({
        answer: null, citations: [], doseCards: null,
        answerGateCode: gate.code, answerGateMessage: gate.message
      })
      return
    }
    this.setData({
      answer: {
        id: gate.answer.id,
        revision: gate.answer.revision,
        status: gate.answer.status,
        checkedText: gate.answer.checked_text,
        modelVersion: gate.answer.model_version,
        promptVersion: gate.answer.prompt_version,
        ruleVersion: gate.answer.rule_version
      },
      citations: qaApi.citationsView(gate.answer),
      doseCards: qaApi.doseCardsView(gate.answer),
      answerGateCode: '',
      answerGateMessage: ''
    })
  },

  // ---------------------------------------------------------------- 轮次历史

  /** 读取本会话轮次（含每轮回答与 job_id）；只展示服务端真实返回，不推断状态。 */
  onRefreshTurns: async function () {
    if (this._gone === true || this.data.guest || this.data.busy) return
    const conversation = this._conversation
    if (conversation === null) {
      this.setData({ turns: [], turnsNote: '还没有本次会话的记录：先发送一个问题，再来读取。' })
      return
    }
    const generation = this.beginOperation()
    this.setData({ turns: [], turnsNote: '正在读取…' })
    try {
      const read = await qaApi.listTurns(conversation.id)
      if (!this.isCurrent(generation)) return
      this.setData({ turns: read.page.items.map(turnView), turnsNote: '' })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      if (isGateLoss(error)) { this.closePrivate(qaApi.messageFor(error)); return }
      this.setData({ turns: [], turnsNote: qaApi.messageFor(error) })
    }
  },

  /** 重试：同一个问题（同正文、同会话）严格回放同一请求身份；不会创建新任务。 */
  onRetry: function () {
    if (this._gone === true || this.data.guest || this.data.busy) return
    this.onSend()
  }
})

/** 会话/门禁失效类错误：必须关闭私有展示，而不是只提示。 */
function isGateLoss(error) {
  const code = error && error.code
  return code === 'SESSION_REQUIRED' || code === 'SESSION_CHANGED' || code === 'SESSION_EXPIRED'
}

/**
 * 轮次 → 页面最小视图（只取服务端真实字段，不推断、不美化）。
 *
 * 回答部分**复用同一道闸门**：只有 `answered` + `passed` + 结构完整才给 `showAnswer`，
 * 否则只给原因码——避免历史列表把"失败/未审"显示成"已有回答"。
 */
function turnView(turn) {
  const gate = qaApi.evaluateAnswerGate(turn.answer)
  return {
    id: turn.id,
    revision: turn.revision,
    inputText: turn.input_text,
    createdAt: turn.created_at,
    jobId: turn.job_id,
    speech: turn.transcription_ref !== null,
    hasAnswer: turn.answer !== null,
    answerStatus: turn.answer === null ? '' : turn.answer.status,
    answerCheckState: turn.answer === null ? '' : turn.answer.check_state,
    showAnswer: gate.ok === true,
    answerText: gate.ok === true ? gate.answer.checked_text : '',
    answerBlockedReason: gate.ok === true ? '' : gate.message,
    citationCount: gate.ok === true ? gate.answer.citations.length : 0,
    doseCardCount: turn.answer === null || !Array.isArray(turn.answer.dose_cards) ? 0 : turn.answer.dose_cards.length
  }
}
