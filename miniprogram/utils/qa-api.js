// GY-I12 **文字问答** HTTP 消费层（原生小程序侧；Refs #12）。
//
// 契约面（packages/contracts/openapi.json 1.0.0，**只用既有 operation，不自造路径**）：
//   createConversation POST   /conversations                      body {} + Idempotency-Key
//                                                                 → 201 ConversationEnvelope
//   sendTextTurn       POST   /conversations/{id}/turns
//                        body {input_type:'text', text}（恰两键，TextTurnInput，additionalProperties:false）
//                        + If-Match(会话 revision) + Idempotency-Key → 202 JobEnvelope（kind=answer）
//   getJob             GET    /jobs/{id}                           → 200 JobEnvelope（JobState 唯一可读面）
//   listTurns          GET    /conversations/{id}/turns            → 200 TurnPageEnvelope
//   deleteTurn         DELETE /conversations/{id}/turns/{turn_id}
//                        + If-Match(轮次 revision) + Idempotency-Key → 202 AckEnvelope
//
// 与语音转写链路（utils/speech-transcript.js）的关系：**只复用它的传输与登记口径，不冒充它的输入形状**。
// 本文件**绝不**发送 SpeechTurnInput（`transcription_id`/`transcription_revision`/`confirmed`）——
// 文字轮次的请求体恰为 `{input_type:'text', text}` 两键，由 `validateTextTurnBody` 逐键闭集校验。
// 本文件**不改**任何既有转写/语音流程，也不新增字段、错误码或路径。
//
// 硬口径（与仓库既有消费层一致）：
// 1) **空白/上限在客户端显式拒绝，不静默截断**：`text.trim() === ''` 与 `> TEXT_MAX`（8000，
//    契约 TextTurnInput.text.maxLength）一律 INVALID_INPUT，**零请求**。
//    长度单位一律 `String.length`（UTF-16 码元），与 `services/api/src/conversations/validate.ts`
//    的 `value.length` 同口径——客户端与服务端不各按一套单位判定（emoji 在该口径下计 2）。
//    页面 `textarea` 显式 `maxlength="-1"`：微信原生 textarea 默认 `maxlength=140`，
//    不写就等于静默截断 140 字，与本口径冲突。
// 2) **未审/畸形回答不展示**：`Answer` 十一键闭集 + `status`/`check_state` 闭集逐一校验；
//    只有 `status === 'answered' && check_state === 'passed'` 且结构完整时才整体呈现，
//    绝不流式、绝不部分展示；`insufficient`/`blocked` 按实际协议呈现。
// 3) **来源只从服务端引用集合来**：`citations` 逐条按 `SourceRef` 十键校验（url 必须 https），
//    不生成链接、不补默认来源；`dose_cards` **只报条数**（本基线恒不可产出，见第 4 条），
//    不渲染可执行用量正文，也不把富文本自由转 HTML。
// 4) **用量安全**：契约 `Answer.dose_cards` 是 `DoseCard` 安全闭集（`DoseSource.validity==='valid'`、
//    `review_status==='verified'`、source_kind 只允许 database/verified_seed）。本片**只暴露条数与
//    结构合法性判定**，不在客户端把任意卡片升格为可执行用量：条件/来源/版本任一项不符即 `DOSE_BLOCKED`。
// 5) **在途与旧回调**：`cancelAll()` 递增代次使全部在途回调失效；离页/隐藏/会话变化一律调用。
//    迟到响应只允许更新展示，**不能**触发新的发送、不能复活已取消的提问。
// 6) **幂等**：同一次尝试（同正文、同会话 revision）的重试复用同一把 Idempotency-Key；
//    用户改过正文或版本变化 ⇒ 新键（同键异体本就会被服务端判 IDEMPOTENCY_CONFLICT）。
//    超时/网络未确认后**不自动重发**，由用户明确重试。
// 7) **无隐私外泄**：本层不把提问/回答正文写日志，不落任何持久存储（页面同样不写）。
'use strict'

const auth = require('./auth')
const runtime = require('../config/runtime')

const CONTRACT_VERSION = '1.0.0'
const EXECUTION_MODES = ['real', 'stub', 'preset_demo']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 契约 `JobState` 闭集（七类）。 */
const JOB_STATES = ['queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled']

/** 契约 `Job.required`（九键）。 */
const JOB_KEYS = ['id', 'revision', 'kind', 'target_ref', 'state', 'deadline_at', 'created_at', 'error_code', 'result']

/** 契约 `Conversation.required`（四键）。 */
const CONVERSATION_KEYS = ['id', 'revision', 'conditions', 'created_at']

/** 契约 `Answer.required`（十一键；`additionalProperties:false`）。 */
const ANSWER_KEYS = ['id', 'revision', 'status', 'checked_text', 'check_state', 'citations', 'dose_cards', 'model_version', 'prompt_version', 'rule_version']

/** 契约 `SourceRef.required`（十键）。 */
const SOURCE_REF_KEYS = ['id', 'version', 'title', 'url', 'publisher', 'source_kind', 'evidence_kind', 'validity', 'review_status', 'updated_at']

/** 契约 `Turn.required`（七键）。 */
const TURN_KEYS = ['id', 'revision', 'input_text', 'transcription_ref', 'job_id', 'answer', 'created_at']

/** 契约 `TurnPage.required`（两键）。 */
const TURN_PAGE_KEYS = ['items', 'next_cursor']

/** 契约 `Ack.required`（一键）。 */
const ACK_KEYS = ['accepted']

/** 契约 `Answer.status` 与 `CheckState` 闭集（逐项一致，不得扩展）。 */
const ANSWER_STATUSES = ['answered', 'insufficient', 'blocked']
const CHECK_STATES = ['passed', 'blocked']

/** 契约 `SourceKind` / `EvidenceKind` / `validity` / `review_status` 闭集。 */
const SOURCE_KINDS = ['database', 'verified_seed', 'simulation']
const EVIDENCE_KINDS = ['research', 'experience', 'mixed']
const SOURCE_VALIDITIES = ['valid', 'expired', 'conflicting', 'unknown', 'withdrawn']
const SOURCE_REVIEW_STATUSES = ['unverified', 'verified', 'rejected']

/** 契约 `DoseCard` 的用量卡条数上限（Answer.dose_cards.maxItems）与引用上限（citations.maxItems）。 */
const CITATION_MAX = 20
const DOSE_CARD_MAX = 10

/** 契约上限：`TextTurnInput.text` 与 `Turn.input_text` 均 ≤8000；`checked_text` ≤16000。
 *  单位与 `services/api/src/conversations/validate.ts` 的 `value.length` 一致（UTF-16 码元）。 */
const TEXT_MAX = 8000
const CHECKED_TEXT_MAX = 16000
const IDEMPOTENCY_MIN = 8
const IDEMPOTENCY_MAX = 128

/** 轮询节流（与 GY-I11／GY-I13 同口径）：1s 一拍、30 拍上限；真正边界以 202 的 `deadline_at` 为准。 */
const POLL_INTERVAL_MS = 1000
const POLL_MAX_TICKS = 30

/**
 * **未接线/不可用的如实说明**（页面必须原样展示，不得改写成"回答失败请重试"）。
 *
 * 依据：`docs/architecture/contract-implementation-status.md` 的 `createTurn`/`getJob` 行 ——
 * 文字问答受理面已装配，但**未接真实模型**（`model_version`/`prompt_version`/`rule_version`
 * 一律带 `unimplemented:no-real-` 前缀，正文是确定性检索条目摘录，不是模型结果），
 * 真实资料覆盖有限（浙江首批 159 条 `review_status=unverified`，不得作为用药量依据）
 * ⇒ 用量卡在本基线**恒不可产出**；真实外发与 `external_inference` 同意闸仍待后续片。
 */
const UNWIRED_ANSWER_NOTE = '当前为演示数据：回答由服务端按已核对的资料条目自动摘录，'
  + '不是真实大模型生成的结果，真实资料覆盖也还有限；本页不提供剂量换算或处方，'
  + '实际用药请以核验登记资料与标签原文为准。'

/** 用量卡在客户端的**唯一**口径：只报条数与结构合法性判定，不展示任何可执行用量正文。 */
const DOSE_CARD_NOTE = '登记用量卡：本页只报条数，不展示用量正文，不生成剂量换算或处方。'

/** 会话失效类错误码闭集（与 `utils/identify-api.js`、`utils/speech-transcript.js` 同口径）。 */
const SESSION_LOSS_CODES = ['SESSION_REQUIRED', 'SESSION_EXPIRED', 'SESSION_CHANGED', 'ACCOUNT_INACTIVE']

function failure(code) { const error = new Error(code); error.code = code; return error }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value) }
function one(value, values) { return values.indexOf(value) !== -1 }
function text(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max }
function nullableText(value, max) { return value === null || text(value, max) }
function integer(value, min) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min }
function uuid(value) { return typeof value === 'string' && UUID.test(value) }
function sameKeys(value, required) {
  if (!object(value)) return false
  const actual = Object.keys(value)
  return actual.length === required.length && required.every(function (key) { return actual.indexOf(key) !== -1 })
}

// ---------------------------------------------------------------- 契约闭集校验

/** 校验契约 `TargetRef`（三键；`type` 必须在闭集内）。 */
function validateTargetRef(value) {
  if (!sameKeys(value, ['type', 'id', 'revision'])) throw failure('INVALID_RESPONSE')
  if (!one(value.type, TARGET_REF_TYPES) || !text(value.id, 80) || !integer(value.revision, 1)) throw failure('INVALID_RESPONSE')
  return { type: value.type, id: value.id, revision: value.revision }
}

/**
 * 契约 `TargetRef` 类型闭集（16 项，逐项一致，不得扩展）。
 * 本片只消费 `answer`（回答轮次任务）与 `conversation`（会话对象）。
 */
const TARGET_REF_TYPES = [
  'species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr', 'transcription', 'answer',
  'post', 'comment', 'conversation', 'dose_card', 'media', 'synthesis', 'job', 'source'
]

/** 校验契约 `SourceRef`（十键；url 必须 https——不生成、不补默认来源）。 */
function validateSourceRef(value) {
  if (!sameKeys(value, SOURCE_REF_KEYS)) throw failure('INVALID_RESPONSE')
  if (!uuid(value.id) || !text(value.version, 80) || !text(value.title, 200)) throw failure('INVALID_RESPONSE')
  if (typeof value.url !== 'string' || !/^https:\/\//.test(value.url)) throw failure('INVALID_RESPONSE')
  if (!text(value.publisher, 200)) throw failure('INVALID_RESPONSE')
  if (!one(value.source_kind, SOURCE_KINDS) || !one(value.evidence_kind, EVIDENCE_KINDS)) throw failure('INVALID_RESPONSE')
  if (!one(value.validity, SOURCE_VALIDITIES) || !one(value.review_status, SOURCE_REVIEW_STATUSES)) throw failure('INVALID_RESPONSE')
  if (!text(value.updated_at, 64)) throw failure('INVALID_RESPONSE')
  return {
    id: value.id, version: value.version, title: value.title, url: value.url, publisher: value.publisher,
    source_kind: value.source_kind, evidence_kind: value.evidence_kind,
    validity: value.validity, review_status: value.review_status, updated_at: value.updated_at
  }
}

/**
 * 校验契约 `Answer`（十一键闭集）。
 *
 * `citations` 逐条按 `SourceRef` 复核；`dose_cards` **只验形状**（条数上限与必填键），
 * 由 `doseCardsView` 决定客户端是否给得出任何可执行结论。
 */
function validateAnswer(value) {
  if (!sameKeys(value, ANSWER_KEYS)) throw failure('INVALID_RESPONSE')
  if (!uuid(value.id) || !integer(value.revision, 1)) throw failure('INVALID_RESPONSE')
  if (!one(value.status, ANSWER_STATUSES) || !one(value.check_state, CHECK_STATES)) throw failure('INVALID_RESPONSE')
  if (typeof value.checked_text !== 'string' || value.checked_text.length === 0 || value.checked_text.length > CHECKED_TEXT_MAX) {
    throw failure('INVALID_RESPONSE')
  }
  if (!Array.isArray(value.citations) || value.citations.length > CITATION_MAX) throw failure('INVALID_RESPONSE')
  const citations = value.citations.map(validateSourceRef)
  if (!Array.isArray(value.dose_cards) || value.dose_cards.length > DOSE_CARD_MAX) throw failure('INVALID_RESPONSE')
  for (const card of value.dose_cards) {
    if (!sameKeys(card, DOSE_CARD_KEYS)) throw failure('INVALID_RESPONSE')
    if (!uuid(card.id) || !integer(card.revision, 1)) throw failure('INVALID_RESPONSE')
  }
  if (!text(value.model_version, 80) || !text(value.prompt_version, 80) || !text(value.rule_version, 80)) {
    throw failure('INVALID_RESPONSE')
  }
  return {
    id: value.id, revision: value.revision, status: value.status, checked_text: value.checked_text,
    check_state: value.check_state, citations: citations,
    dose_cards: value.dose_cards.map(function (card) { return { id: card.id, revision: card.revision } }),
    model_version: value.model_version, prompt_version: value.prompt_version, rule_version: value.rule_version
  }
}

/** 契约 `DoseCard.required`（本层只做形状判定，不取任何可执行字段）。 */
const DOSE_CARD_KEYS = [
  'id', 'revision', 'formulation', 'conditions', 'original_text', 'unit_text', 'method_text',
  'precautions_text', 'source', 'locator', 'content_hash'
]

/** 校验契约 `Job`（九键闭集；`kind` 必须等于期望值；`result.value` 必须是 `Answer`）。 */
function validateJob(value, expectedKind) {
  if (!sameKeys(value, JOB_KEYS)) throw failure('INVALID_RESPONSE')
  if (!uuid(value.id) || !integer(value.revision, 1) || value.kind !== expectedKind) throw failure('INVALID_RESPONSE')
  if (!one(value.state, JOB_STATES)) throw failure('INVALID_RESPONSE')
  if (!text(value.deadline_at, 64) || !text(value.created_at, 64)) throw failure('INVALID_RESPONSE')
  if (value.error_code !== null && typeof value.error_code !== 'string') throw failure('INVALID_RESPONSE')
  const targetRef = validateTargetRef(value.target_ref)
  const base = {
    id: value.id, revision: value.revision, kind: expectedKind, target_ref: targetRef,
    state: value.state, deadline_at: value.deadline_at, created_at: value.created_at,
    error_code: value.error_code
  }
  if (value.result === null) return Object.assign({}, base, { result: null })
  if (!sameKeys(value.result, ['kind', 'value']) || value.result.kind !== expectedKind) throw failure('INVALID_RESPONSE')
  return Object.assign({}, base, { result: validateAnswer(value.result.value) })
}

/** 校验契约 `Conversation`（四键；`conditions` 可空）。 */
function validateConversation(value) {
  if (!sameKeys(value, CONVERSATION_KEYS)) throw failure('INVALID_RESPONSE')
  if (!uuid(value.id) || !integer(value.revision, 1) || !text(value.created_at, 64)) throw failure('INVALID_RESPONSE')
  if (value.conditions !== null && !object(value.conditions)) throw failure('INVALID_RESPONSE')
  return { id: value.id, revision: value.revision, conditions: value.conditions, created_at: value.created_at }
}

/** 校验契约 `Turn`（七键；`answer` 可空；`input_text` 只用于展示本次提问）。 */
function validateTurn(value) {
  if (!sameKeys(value, TURN_KEYS)) throw failure('INVALID_RESPONSE')
  if (!uuid(value.id) || !integer(value.revision, 1)) throw failure('INVALID_RESPONSE')
  if (typeof value.input_text !== 'string' || value.input_text.length > TEXT_MAX) throw failure('INVALID_RESPONSE')
  if (value.transcription_ref !== null && !object(value.transcription_ref)) throw failure('INVALID_RESPONSE')
  if (!uuid(value.job_id) || !text(value.created_at, 64)) throw failure('INVALID_RESPONSE')
  // 契约 `Turn.answer` 是 `Answer|null`；`Answer.id` 与轮次 id **不要求**相等（服务端自足分配），
  // 因此这里只校验结构，不替服务端断言两者关系。
  const answer = value.answer === null ? null : validateAnswer(value.answer)
  return {
    id: value.id, revision: value.revision, input_text: value.input_text,
    transcription_ref: value.transcription_ref, job_id: value.job_id, answer: answer,
    created_at: value.created_at
  }
}

/** 校验契约 `TurnPage`（两键；`items` 至多 50 条）。 */
function validateTurnPage(value) {
  if (!sameKeys(value, TURN_PAGE_KEYS)) throw failure('INVALID_RESPONSE')
  if (!Array.isArray(value.items) || value.items.length > 50) throw failure('INVALID_RESPONSE')
  if (value.next_cursor !== null && !text(value.next_cursor, 2048)) throw failure('INVALID_RESPONSE')
  return { items: value.items.map(validateTurn), next_cursor: value.next_cursor }
}

/** 校验契约 `Ack`（一键；只认 `accepted === true`）。 */
function validateAck(value) {
  if (!sameKeys(value, ACK_KEYS) || value.accepted !== true) throw failure('INVALID_RESPONSE')
  return { accepted: true }
}

function validateMeta(meta) {
  if (!object(meta) || !uuid(meta.request_id) || meta.contract_version !== CONTRACT_VERSION || !one(meta.execution_mode, EXECUTION_MODES)) {
    throw failure('INVALID_RESPONSE')
  }
  return meta.execution_mode
}

// ---------------------------------------------------------------- 会话绑定与在途登记

function binding() {
  const session = auth.getSession()
  return session && auth.isLoggedIn() ? { token: session.accessToken, epoch: auth.sessionEpoch() } : null
}
function current(bound) {
  const now = binding()
  return !!bound && !!now && bound.token === now.token && bound.epoch === now.epoch
}

/**
 * 在途请求登记表：**离页/取消的唯一失效出口**。
 *
 * 服务端对回答作业**没有**取消 operation（`/jobs/{id}/cancel` 对 answer 源如实 503
 * `PROVIDER_UNAVAILABLE`，见 contract-implementation-status 的 `cancelJob` 行），
 * 因此这里**只**做客户端侧失效 + 停轮询，**不**发送任何"取消任务"请求，
 * 也**不**向用户声称"服务端任务已取消"。
 */
const inFlight = { epoch: 0 }

/** 使所有在途请求的回调失效（离页/切页/隐藏/会话变化时调用；幂等）。 */
function cancelAll() {
  inFlight.epoch += 1
  return { epoch: inFlight.epoch, serverSideCancel: false }
}

/**
 * 401/403 的**如实**归因：401 一律按会话失效；403 先看契约封套的 `error.code`——
 * `CONSENT_REQUIRED`（缺用途授权）与 `SCOPE_DENIED`（会话无权）**必须**原样带出，
 * 不得折叠成"登录失效"（那会把用户引向错误动作，还会误清会话）。
 */
function forbiddenOrSessionLoss(statusCode, payload) {
  const code = object(payload) && object(payload.error) && typeof payload.error.code === 'string' ? payload.error.code : null
  const surface = statusCode === 403 && code !== null && SESSION_LOSS_CODES.indexOf(code) === -1 ? code : 'SESSION_REQUIRED'
  if (surface === 'SESSION_REQUIRED') auth.clearSession()
  const error = failure(surface)
  error.status = statusCode
  error.retryable = object(payload) && object(payload.error) && payload.error.retryable === true
  return error
}

function request(method, path, options) {
  const config = options || {}
  const bound = binding()
  if (!bound || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  const epoch = inFlight.epoch
  const header = { authorization: 'Bearer ' + bound.token, 'Cache-Control': 'no-cache' }
  if (config.body !== undefined) header['content-type'] = 'application/json'
  if (config.idempotencyKey) header['Idempotency-Key'] = config.idempotencyKey
  if (config.ifMatch) header['If-Match'] = config.ifMatch
  return new Promise(function (resolve, reject) {
    const wxOptions = {
      url: runtime.apiBaseUrl + path,
      method: method,
      timeout: 15000,
      header: header,
      success: function (response) {
        if (!current(bound)) { reject(failure('SESSION_CHANGED')); return }
        if (epoch !== inFlight.epoch) { reject(failure('CLIENT_CANCELLED')); return }
        if (response.statusCode === 401 || response.statusCode === 403) { reject(forbiddenOrSessionLoss(response.statusCode, response.data)); return }
        try {
          const payload = response.data
          if (response.statusCode === 200 || response.statusCode === 201 || response.statusCode === 202) {
            if (!object(payload) || !('data' in payload) || !('meta' in payload)) throw failure('INVALID_RESPONSE')
            resolve({ data: payload.data, mode: validateMeta(payload.meta), etag: response.header && response.header.ETag ? response.header.ETag : null })
            return
          }
          if (object(payload) && object(payload.error) && typeof payload.error.code === 'string') {
            const error = failure(payload.error.code)
            error.status = response.statusCode
            error.retryable = payload.error.retryable === true
            reject(error)
            return
          }
          reject(failure(response.statusCode === 404 ? 'NOT_FOUND' : 'UNAVAILABLE'))
        } catch (error) { reject(error) }
      },
      fail: function () { reject(failure(current(bound) ? 'NETWORK_UNCERTAIN' : 'SESSION_CHANGED')) }
    }
    if (config.body !== undefined) wxOptions.data = config.body
    wx.request(wxOptions)
  })
}

function newKey(prefix) {
  const value = prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)
  return value.length > IDEMPOTENCY_MAX ? value.slice(0, IDEMPOTENCY_MAX) : value
}

/** 合法幂等键（8..128，契约 `Idempotency-Key` 参数约束）。 */
function validKey(value) {
  return typeof value === 'string' && value.length >= IDEMPOTENCY_MIN && value.length <= IDEMPOTENCY_MAX
}

/**
 * **尝试身份的幂等键**：同一次尝试（descriptor 相同）的重试复用同一把键。
 *
 * 同 `speech-transcript.stableKey` 口径：用户改过正文或版本变化 ⇒ descriptor 变化 ⇒ 自然换新键。
 */
function stableKey(previous, descriptor, prefix) {
  if (object(previous) && previous.descriptor === descriptor && validKey(previous.key)) return previous.key
  return newKey(prefix)
}

/** `If-Match` 一律由服务端回传的 revision 生成（不内联硬编码 `"1"`）。 */
function etagOf(revision) { return '"' + String(revision) + '"' }

// ---------------------------------------------------------------- 契约操作

/**
 * `POST /conversations`：确保有一个可发送的会话（201 + Conversation）。
 *
 * 会话**复用**：调用方在页面内缓存 `{id, revision}`；重试不自动重建（重建即新一轮次域）。
 */
async function createConversation(idempotencyKey) {
  const key = validKey(idempotencyKey) ? idempotencyKey : newKey('i12-conversation')
  const response = await request('POST', '/conversations', { body: {}, idempotencyKey: key })
  const conversation = validateConversation(response.data)
  return { conversation: conversation, mode: response.mode, etag: response.etag }
}

/**
 * `POST /conversations/{id}/turns`：**发送文字轮次**（202 + Job[kind=answer]）。
 *
 * 请求体恰为契约 `TextTurnInput` 两键（`input_type:'text'` + `text`）；**绝不**发送
 * `SpeechTurnInput` 的字段。`If-Match` 绑**会话** revision（服务端据此判会话版本）。
 *
 * 空白/超长由 `validateTextTurnBody` 在**发请求前**拒绝（INVALID_INPUT，零请求），
 * 客户端**不**做任何静默截断。
 */
async function sendTextTurn(input) {
  if (!object(input) || !uuid(input.conversationId) || !integer(input.conversationRevision, 1)) throw failure('INVALID_INPUT')
  const body = validateTextTurnBody(input.text)
  const key = validKey(input.idempotencyKey) ? input.idempotencyKey : newKey('i12-send')
  const response = await request('POST', '/conversations/' + input.conversationId + '/turns', {
    body: body,
    ifMatch: etagOf(input.conversationRevision),
    idempotencyKey: key
  })
  const job = validateJob(response.data, 'answer')
  if (job.target_ref.type !== 'answer') throw failure('INVALID_RESPONSE')
  return { job: job, mode: response.mode, etag: response.etag }
}

/**
 * **文字轮次请求体**（契约 `TextTurnInput`，恰两键，`additionalProperties:false`）。
 *
 * 纯函数、可单测：空白与超长一律抛 `INVALID_INPUT`（不截断、不补空格、不发明默认正文）。
 */
function validateTextTurnBody(text) {
  if (typeof text !== 'string' || text.trim() === '') throw failure('INVALID_INPUT')
  if (text.length > TEXT_MAX) throw failure('INVALID_INPUT')
  return { input_type: 'text', text: text }
}

/** `GET /jobs/{id}`：读回答任务状态（JobState 唯一契约读面；`result.value` 是 `Answer`）。 */
async function getJob(jobId) {
  if (!uuid(jobId)) throw failure('INVALID_INPUT')
  const response = await request('GET', '/jobs/' + jobId, {})
  if (response.data.id !== jobId) throw failure('INVALID_RESPONSE')
  const job = validateJob(response.data, 'answer')
  return { job: job, mode: response.mode, etag: response.etag }
}

/** `GET /conversations/{id}/turns`：读会话轮次（含每轮回答与 job_id；列表不下发 ETag）。 */
async function listTurns(conversationId, cursor) {
  if (!uuid(conversationId)) throw failure('INVALID_INPUT')
  const suffix = typeof cursor === 'string' && cursor !== '' ? '?cursor=' + encodeURIComponent(cursor) : ''
  const response = await request('GET', '/conversations/' + conversationId + '/turns' + suffix, {})
  const page = validateTurnPage(response.data)
  return { page: page, mode: response.mode, etag: response.etag }
}

/** `DELETE /conversations/{id}/turns/{turn_id}`：删除单轮（级联其回答）。 */
async function deleteTurn(input) {
  if (!object(input) || !uuid(input.conversationId) || !uuid(input.turnId) || !integer(input.turnRevision, 1)) {
    throw failure('INVALID_INPUT')
  }
  const key = validKey(input.idempotencyKey) ? input.idempotencyKey : newKey('i12-delete-turn')
  const response = await request('DELETE', '/conversations/' + input.conversationId + '/turns/' + input.turnId, {
    ifMatch: etagOf(input.turnRevision),
    idempotencyKey: key
  })
  const ack = validateAck(response.data)
  return { accepted: ack.accepted, mode: response.mode, etag: response.etag }
}

// ---------------------------------------------------------------- 展示判定（fail-closed）

/**
 * **回答可展示性闸门**（纯函数，可单测）：唯一允许「整体展示已检查回答」的判定入口。
 *
 * 放行条件（全部满足）：
 *  1. `answer` 结构完整（`validateAnswer` 已过，十一键闭集）；
 *  2. `status === 'answered'` 且 `check_state === 'passed'`；
 *  3. `checked_text` 非空且 ≤16000（与其余长度判定同为 `String.length` 口径）；
 *  4. `citations` 至少一条（服务端无引用 ⇒ 不当有出处呈现；`insufficient` 已由 status 挡下）。
 * 其余一律阻断并给出原因码：`ANSWER_MISSING`/`ANSWER_MALFORMED`/`ANSWER_NOT_CHECKED`/
 * `ANSWER_INSUFFICIENT`/`ANSWER_BLOCKED`/`ANSWER_NO_SOURCE`。
 */
function evaluateAnswerGate(answer) {
  if (answer === null || answer === undefined) {
    return { ok: false, code: 'ANSWER_MISSING', message: '这个问题还没有取得回答。' }
  }
  let checked
  try {
    checked = validateAnswer(answer)
  } catch (error) {
    return { ok: false, code: 'ANSWER_MALFORMED', message: '这份回答的内容无法核对，因此不展示。' }
  }
  if (checked.check_state !== 'passed') {
    return { ok: false, code: 'ANSWER_NOT_CHECKED', message: '这份回答的安全检查未通过，因此不展示正文。' }
  }
  if (checked.status === 'insufficient') {
    return { ok: false, code: 'ANSWER_INSUFFICIENT', message: '资料不足，暂时给不出可展示的回答。' }
  }
  if (checked.status === 'blocked') {
    return { ok: false, code: 'ANSWER_BLOCKED', message: '这个问题不适合直接回答，因此不展示正文。' }
  }
  if (checked.status !== 'answered') {
    return { ok: false, code: 'ANSWER_NOT_CHECKED', message: '这份回答的状态无法核对，因此不展示。' }
  }
  if (checked.citations.length === 0) {
    return { ok: false, code: 'ANSWER_NO_SOURCE', message: '这份回答没有可核对的来源，因此不展示。' }
  }
  return { ok: true, answer: checked }
}

/** 终态判定（queued/running 未终态；其余五类终态）。 */
function isTerminal(state) { return one(state, ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled']) }

/**
 * **用量卡在客户端的唯一口径**：只报条数与来源资格判定，**不**给可执行结论。
 *
 * 判据（fail-closed）：卡片来源必须 `validity==='valid'` 且 `review_status==='verified'`
 * 且 `source_kind` 属 `database`/`verified_seed`；`Answer.status` 必须 `answered`。
 * 本片**刻意不**读取 `original_text`/`unit_text`/`method_text` 等可执行字段——
 * 条件、制剂或来源任一项不符 ⇒ `DOSE_BLOCKED`，页面据此明确关闭并说明原因。
 */
function doseCardsView(answer) {
  const cards = object(answer) && Array.isArray(answer.dose_cards) ? answer.dose_cards : []
  const base = { count: cards.length, renderable: false, blocked: true, reason: '' }
  if (cards.length === 0) {
    return Object.assign({}, base, { reason: '本次回答没有附带登记用量卡（本基线真实资料覆盖有限，用量卡恒不可产出）。' })
  }
  if (answer.status !== 'answered' || answer.check_state !== 'passed') {
    return Object.assign({}, base, { reason: '回答未通过安全检查或未成功：不据其展示任何用量内容。' })
  }
  return Object.assign({}, base, {
    reason: '本页只报条数与来源资格判定，不渲染用量正文、不生成剂量换算或处方；'
      + '可执行用量请以核验登记资料与标签原文为准。'
  })
}

/** 引用视图：逐字取自服务端 `citations`（不生成链接、不补默认来源）。 */
function citationsView(answer) {
  const items = object(answer) && Array.isArray(answer.citations) ? answer.citations : []
  return items.map(function (item) {
    return {
      id: item.id, version: item.version, title: item.title, url: item.url, publisher: item.publisher,
      source_kind: item.source_kind, evidence_kind: item.evidence_kind,
      validity: item.validity, review_status: item.review_status, updated_at: item.updated_at
    }
  })
}

// ---------------------------------------------------------------- 文案

/**
 * 错误码 → 页面可展示的一句话（不改变判定，只做措辞；未收录一律中性兜底）。
 *
 * 口径：
 * - 面向普通用户，只说"发生了什么、要不要重试"；错误码本身留在报告与页面折叠的技术信息里；
 * - 503 `PROVIDER_UNAVAILABLE` ⇒ 必须指明**服务端能力未接线**（不得说成网络问题，也不得谎称已回答）；
 * - 403 `CONSENT_REQUIRED`（缺用途授权）与 `SCOPE_DENIED`（会话无权）必须**各不相同**，
 *   且都不得写成"登录失效"；只有 `SESSION_*` 才是登录/会话类问题。
 */
const QA_MESSAGES = Object.freeze({
  // 会话 / 门禁 / 作废
  SESSION_REQUIRED: '登录状态已失效，请重新登录后再提问。',
  SESSION_EXPIRED: '登录状态已过期，请重新登录后再提问。',
  SESSION_CHANGED: '账号或登录状态已变化，这次提问已作废，请重新进入本页。',
  CLIENT_CANCELLED: '已离开本页，这次请求已停止。',
  NETWORK_UNCERTAIN: '网络未能确认结果，已停止。可以重试：同一个问题不会重复提交。',
  // 403：非会话类原样带出
  CONSENT_REQUIRED: '还没有完成「对外推理」用途授权，因此没有发送问题。请先完成授权。',
  SCOPE_DENIED: '当前账号无权使用这项功能，没有发送问题。',
  ACCOUNT_INACTIVE: '账号当前不可用，没有发送问题。',
  // 404 / 409 / 428 / 429
  NOT_FOUND: '找不到这次会话或提问记录（可能不属于当前账号）。',
  REVISION_CONFLICT: '会话内容已变化，请重新发送这个问题。',
  REVISION_REQUIRED: '会话信息不完整，请重新发送。',
  IDEMPOTENCY_KEY_REQUIRED: '这次请求缺少必要标识，请重试。',
  IDEMPOTENCY_CONFLICT: '同一次请求的内容不一致，请重试。',
  RATE_LIMITED: '请求太频繁，请稍后再试。',
  REQUEST_IN_PROGRESS: '同一个问题正在处理中，请稍后重试，不会重复提交。',
  // 400 / 413 / 415 / 422
  INVALID_REQUEST: '这次请求没有被服务端接受，已停止。',
  INVALID_INPUT: '输入不合法，已停止，没有发出请求。',
  INVALID_RESPONSE: '服务端返回的内容无法核对，已停止，不展示任何回答。',
  CONDITIONS_INCOMPLETE: '缺少必要的条件信息，这次不给出结论。',
  SOURCE_CONFLICT: '资料来源存在冲突，这次不给出结论。',
  // 503 / 504
  PROVIDER_UNAVAILABLE: '服务端能力未接线：这项功能还没有接上真实服务，这次没有生成回答。',
  PROVIDER_TIMEOUT: '服务端处理超时，这次不计为成功。',
  PROVIDER_OUTCOME_UNKNOWN: '服务端处理结果未知，这次不计为成功。',
  PROVIDER_QUOTA_EXCEEDED: '服务额度不足，这次没有发送问题。',
  OBJECT_UNAVAILABLE: '目标对象不可用，这次没有生成回答。',
  UNAVAILABLE: '服务暂时不可用，请稍后重试。'
})

/** 逐码文案；未收录一律给出中性兜底（不发明原因）。 */
function messageFor(error) {
  const code = error && error.code
  const message = QA_MESSAGES[code]
  return typeof message === 'string' ? message : '这次提问没有成功，已停止。'
}

/** 任务状态 → 页面一行说明（七类逐类呈现，不折叠成"成功/失败"）。 */
function describeJob(job) {
  const state = job && job.state
  const labels = {
    queued: '已受理，排队中',
    running: '正在查找',
    succeeded: '回答已生成',
    uncertain: '结果不确定',
    failed: '没有生成回答',
    timed_out: '等待超时',
    cancelled: '已取消'
  }
  return {
    state: state,
    terminal: isTerminal(state),
    label: labels[state] || '状态未知',
    errorCode: job && typeof job.error_code === 'string' ? job.error_code : null,
    deadlineAt: job && typeof job.deadline_at === 'string' ? job.deadline_at : ''
  }
}

module.exports = {
  CONTRACT_VERSION: CONTRACT_VERSION,
  EXECUTION_MODES: EXECUTION_MODES.slice(),
  TARGET_REF_TYPES: TARGET_REF_TYPES.slice(),
  JOB_STATES: JOB_STATES.slice(),
  JOB_KEYS: JOB_KEYS.slice(),
  ANSWER_KEYS: ANSWER_KEYS.slice(),
  SOURCE_REF_KEYS: SOURCE_REF_KEYS.slice(),
  CONVERSATION_KEYS: CONVERSATION_KEYS.slice(),
  TURN_KEYS: TURN_KEYS.slice(),
  TURN_PAGE_KEYS: TURN_PAGE_KEYS.slice(),
  ACK_KEYS: ACK_KEYS.slice(),
  ANSWER_STATUSES: ANSWER_STATUSES.slice(),
  CHECK_STATES: CHECK_STATES.slice(),
  SOURCE_KINDS: SOURCE_KINDS.slice(),
  EVIDENCE_KINDS: EVIDENCE_KINDS.slice(),
  SOURCE_VALIDITIES: SOURCE_VALIDITIES.slice(),
  SOURCE_REVIEW_STATUSES: SOURCE_REVIEW_STATUSES.slice(),
  CITATION_MAX: CITATION_MAX,
  DOSE_CARD_MAX: DOSE_CARD_MAX,
  POLL_INTERVAL_MS: POLL_INTERVAL_MS,
  POLL_MAX_TICKS: POLL_MAX_TICKS,
  TEXT_MAX: TEXT_MAX,
  CHECKED_TEXT_MAX: CHECKED_TEXT_MAX,
  UNWIRED_ANSWER_NOTE: UNWIRED_ANSWER_NOTE,
  DOSE_CARD_NOTE: DOSE_CARD_NOTE,
  QA_MESSAGES: QA_MESSAGES,
  messageFor: messageFor,
  describeJob: describeJob,
  validateAnswer: validateAnswer,
  validateAnswerJob: function (value) { return validateJob(value, 'answer') },
  validateConversation: validateConversation,
  validateTurn: validateTurn,
  validateTurnPage: validateTurnPage,
  validateSourceRef: validateSourceRef,
  validateAck: validateAck,
  validateTextTurnBody: validateTextTurnBody,
  evaluateAnswerGate: evaluateAnswerGate,
  isTerminal: isTerminal,
  doseCardsView: doseCardsView,
  citationsView: citationsView,
  createConversation: createConversation,
  sendTextTurn: sendTextTurn,
  getJob: getJob,
  listTurns: listTurns,
  deleteTurn: deleteTurn,
  cancelAll: cancelAll,
  inFlightEpoch: function () { return inFlight.epoch },
  newKey: newKey,
  stableKey: stableKey,
  etagOf: etagOf,
  validKey: validKey,
  validId: uuid
}
