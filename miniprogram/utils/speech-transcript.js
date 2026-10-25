// GY-I11 **语音转写核对** HTTP 消费层（原生小程序侧，stub/preset_demo 局部实现）。
//
// 契约面（packages/contracts/openapi.json 1.0.0，**只用既有 operation，不自造路径**）：
//   createTranscription  POST   /speech/transcriptions               → 202 JobEnvelope（kind=transcription）
//   getTranscription     GET    /speech/transcriptions/{id}          → 200 TranscriptionEnvelope
//   confirmTranscription PATCH  /speech/transcriptions/{id}/confirmation
//                        body {confirmed_text, confirmation:'checked_and_sendable'}
//                        + If-Match + Idempotency-Key                → 200 TranscriptionEnvelope
//   deleteTranscription  DELETE /speech/transcriptions/{id} + If-Match + Idempotency-Key → 202 AckEnvelope
//   createConversation   POST   /conversations                       → 201 ConversationEnvelope
//   sendSpeechTurn       POST   /conversations/{id}/turns
//                        body {input_type:'speech', transcription_id, transcription_revision, confirmed:true}
//                        + If-Match(会话 revision) + Idempotency-Key → 202 JobEnvelope（kind=answer）
//
// 本片口径（派单：仅 stub/preset_demo 局部实现；禁止真实 ASR／付费调用／伪造真实请求号／关闭整项 issue）：
// 1) **可编辑 + 用户明确确认后才发送**：发送闸门 `evaluateSendGate` 是唯一放行出口——
//    未经本机一次成功的 PATCH 确认（confirmed_text 非空、revision 一致、服务端记录同样已确认）
//    一律不得 POST 轮次；未确认／已取消／记录缺失／版本不符／操作已作废，全部零请求。
// 2) **取消／失败／迟到回调不得外发**：`cancelAll()` 递增代次使在途回调整体失效；
//    用户取消（DELETE）后闸门永久关闭；迟到响应只允许更新展示，永远不能触发发送。
// 3) **确认与发送都幂等**：同一次尝试（同正文、同 revision）的重试复用同一 Idempotency-Key
//    （服务端同键回放，不重复写入）；双击由页面 busy 守卫挡下，本层用 `stableKey` 固化尝试身份。
// 4) **不改契约**：无新字段、无新错误码；`If-Match` 一律取服务端回传的 revision（不内联硬编码）。
// 5) **替身如实标注**：`SUBSTITUTE_RECORD_SAMPLES` 只在本地替身工程可见，是服务端替身媒体端口
//    （stub/preset_demo 接受任意合法 uuid 引用）对应的**明确标注替身引用**，不是真实上传、
//    不读取任何录音字节、不构成任何真实请求号；真实媒体引用只能来自真实上传产物。
// 6) **失败终态不产生记录**：服务端对 failed/timed_out/uncertain/cancelled 不写转写记录
//    （`GET` 如实 404）。本层按 202 响应里的 `deadline_at` 设定轮询边界：到达仍未取得记录
//    ⇒ 如实报「未产出可核对记录」，**不**编造文本、**不**发送。
'use strict'

const auth = require('./auth')
const runtime = require('../config/runtime')

const CONTRACT_VERSION = '1.0.0'
const EXECUTION_MODES = ['real', 'stub', 'preset_demo']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 契约 `JobState` 闭集（七类）。 */
const JOB_STATES = ['queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled']

/** 契约 `Transcription.required`（七键，`additionalProperties:false`）。 */
const TRANSCRIPTION_KEYS = ['id', 'revision', 'raw_text', 'uncertain_spans', 'confirmed_text', 'confirmed_at', 'model_version']

/** 契约 `Job.required`（九键）。 */
const JOB_KEYS = ['id', 'revision', 'kind', 'target_ref', 'state', 'deadline_at', 'created_at', 'error_code', 'result']

/** 契约 `Conversation.required`（四键）。 */
const CONVERSATION_KEYS = ['id', 'revision', 'conditions', 'created_at']

/** 契约 `Ack.required`（一键）。 */
const ACK_KEYS = ['accepted']

/** 契约 `ConfirmTranscriptionInput.confirmation` 常量（用户明确确认的字面值）。 */
const CONFIRMATION_VALUE = 'checked_and_sendable'

/** 契约上限：`confirmed_text` / `raw_text` 均 ≤8000 码点。 */
const TEXT_MAX = 8000
const IDEMPOTENCY_MIN = 8
const IDEMPOTENCY_MAX = 128

/** 轮询节流（与 GY-I13 播报页同口径）：1s 一拍、30 拍上限；真正边界以 202 的 `deadline_at` 为准。 */
const POLL_INTERVAL_MS = 1000
const POLL_MAX_TICKS = 30

/**
 * **明确标注的替身录音引用**（仅本地替身工程可见；`media_revision` 恒为 1）。
 *
 * 它们不是真实上传、不指向任何真实录音字节，也不构成真实请求号；服务端在 stub/preset_demo 下
 * 经替身媒体端口接受任意合法 uuid 引用（见 `services/api/src/speech/media.ts`），因此这两个
 * 固定 uuid 只是**走通链路**的夹具。分桶语义与服务端替身提供者一致（sha256(media_id) 首字节 %6）：
 *   - `sample-i11-normal`  → 正常转写（带 2 个不确定区间）；
 *   - `sample-i11-silent`  → 空转写：服务端落 `uncertain` 终态且**不产生记录**（`GET` 404），
 *                            用于核对「失败终态不得外发」这一负例。
 * `preset_demo` 模式下提供者返回固定演示句，与分桶无关。
 */
const SUBSTITUTE_RECORD_SAMPLES = Object.freeze([
  {
    id: 'sample-i11-normal',
    label: '替身录音样本 · 正常转写（含不确定区间）',
    mediaRef: { media_id: 'dbe4aece-5042-48dc-a63d-fbdd6a2ada57', media_revision: 1 }
  },
  {
    id: 'sample-i11-silent',
    label: '替身录音样本 · 空转写（不产生记录，负例）',
    mediaRef: { media_id: 'e21a643a-ff6c-4fee-8000-f3ee3ea12808', media_revision: 1 }
  }
])

const SUBSTITUTE_RECORD_NOTE = '替身录音引用（本地替身工程专用）：不是真实上传、不读取任何录音字节、'
  + '也不是真实请求号；只用于在 stub/preset_demo 下走通「转写 → 编辑 → 确认 → 发送」链路。'
  + '转写文本是明确标注的替身产物，不构成任何识别效果或准确率证据。'

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

/** 契约 `UncertainSpan`（三键；区间只校验形状，服务端已做区间合法性归一）。 */
function validateSpan(value) {
  if (!sameKeys(value, ['start', 'end', 'reason'])) throw failure('INVALID_RESPONSE')
  if (!integer(value.start, 0) || !integer(value.end, 0) || !text(value.reason, 200)) throw failure('INVALID_RESPONSE')
  return { start: value.start, end: value.end, reason: value.reason }
}

/** 校验契约 `Transcription`（七键闭集；`confirmed_*` 必须同生同灭）。 */
function validateTranscription(value) {
  if (!sameKeys(value, TRANSCRIPTION_KEYS)) throw failure('INVALID_RESPONSE')
  if (!uuid(value.id) || !integer(value.revision, 1)) throw failure('INVALID_RESPONSE')
  if (typeof value.raw_text !== 'string' || value.raw_text.length > TEXT_MAX) throw failure('INVALID_RESPONSE')
  if (!Array.isArray(value.uncertain_spans) || value.uncertain_spans.length > 100) throw failure('INVALID_RESPONSE')
  const spans = value.uncertain_spans.map(validateSpan)
  if (!nullableText(value.confirmed_text, TEXT_MAX) || !nullableText(value.confirmed_at, 64)) throw failure('INVALID_RESPONSE')
  if ((value.confirmed_text === null) !== (value.confirmed_at === null)) throw failure('INVALID_RESPONSE')
  if (!text(value.model_version, 80)) throw failure('INVALID_RESPONSE')
  return {
    id: value.id,
    revision: value.revision,
    raw_text: value.raw_text,
    uncertain_spans: spans,
    confirmed_text: value.confirmed_text,
    confirmed_at: value.confirmed_at,
    model_version: value.model_version
  }
}

/**
 * 契约 `TargetRef` 类型闭集（16 项，逐项一致，不得扩展）。
 *
 * 本片只消费两类：转写任务 `transcription`（`POST /speech/transcriptions` 的 202）与
 * 回答任务 `answer`（`POST /conversations/{id}/turns` 的 202，`target_ref.id` 是轮次 id）。
 */
const TARGET_REF_TYPES = [
  'species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr', 'transcription', 'answer',
  'post', 'comment', 'conversation', 'conversation_turn', 'dose_card', 'media', 'synthesis', 'job', 'source'
]

/** 校验契约 `TargetRef`（三键闭集；`type` 必须在闭集内）。 */
function validateTargetRef(value) {
  if (!sameKeys(value, ['type', 'id', 'revision'])) throw failure('INVALID_RESPONSE')
  if (!one(value.type, TARGET_REF_TYPES) || !text(value.id, 80) || !integer(value.revision, 1)) throw failure('INVALID_RESPONSE')
  return { type: value.type, id: value.id, revision: value.revision }
}

/**
 * 校验契约 `Job`（九键闭集；`kind` 必须等于期望值）。
 *
 * `result` 只认 `{kind,value}` 两键且 `kind` 与任务一致；转写任务的 `result.value`
 * 是 `TranscriptionProjection`（与 `Transcription` 同构），按同一校验器复核。
 */
function validateJob(value, expectedKind) {
  if (!sameKeys(value, JOB_KEYS)) throw failure('INVALID_RESPONSE')
  if (!uuid(value.id) || !integer(value.revision, 1) || value.kind !== expectedKind) throw failure('INVALID_RESPONSE')
  if (!one(value.state, JOB_STATES)) throw failure('INVALID_RESPONSE')
  if (!text(value.deadline_at, 64) || !text(value.created_at, 64)) throw failure('INVALID_RESPONSE')
  if (value.error_code !== null && typeof value.error_code !== 'string') throw failure('INVALID_RESPONSE')
  const targetRef = validateTargetRef(value.target_ref)
  // 投影**保留** deadline_at / created_at：轮询边界以 202 回传的截止时间为准（页面不得内联猜时长）。
  const base = {
    id: value.id, revision: value.revision, kind: expectedKind, target_ref: targetRef,
    state: value.state, deadline_at: value.deadline_at, created_at: value.created_at,
    error_code: value.error_code
  }
  if (value.result === null) return Object.assign({}, base, { result: null })
  if (!sameKeys(value.result, ['kind', 'value']) || value.result.kind !== expectedKind) throw failure('INVALID_RESPONSE')
  // 转写任务的 result.value 是 TranscriptionProjection（与 Transcription 同构）⇒ 同一校验器复核；
  // 回答任务的 result.value 属问答域（本片不呈现回答内容）⇒ 只校验是非空对象，不越界深查。
  if (expectedKind === 'transcription') {
    return Object.assign({}, base, { result: validateTranscription(value.result.value) })
  }
  if (!object(value.result.value)) throw failure('INVALID_RESPONSE')
  return Object.assign({}, base, { result: value.result.value })
}

/** 校验契约 `Conversation`（四键；`conditions` 可空）。 */
function validateConversation(value) {
  if (!sameKeys(value, CONVERSATION_KEYS)) throw failure('INVALID_RESPONSE')
  if (!uuid(value.id) || !integer(value.revision, 1) || !text(value.created_at, 64)) throw failure('INVALID_RESPONSE')
  if (value.conditions !== null && !object(value.conditions)) throw failure('INVALID_RESPONSE')
  return { id: value.id, revision: value.revision, conditions: value.conditions, created_at: value.created_at }
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
 * 只做客户端侧的事——把在途回调标记为失效（`cancelAll()` 递增代次）。服务端转写任务
 * **没有**取消 operation（`DELETE /speech/transcriptions/{id}` 删的是记录，不是任务），
 * 因此这里**不**发送任何"取消任务"请求，也不向用户声称"服务端任务已取消"。
 */
const inFlight = { epoch: 0 }

/** 使所有在途请求的回调失效（离页/切页/隐藏/取消时调用；幂等）。 */
function cancelAll() {
  inFlight.epoch += 1
  return { epoch: inFlight.epoch, serverSideCancel: false }
}

/**
 * 401/403 的**如实**归因：401 一律按会话失效；403 先看契约封套的 `error.code`——
 * `CONSENT_REQUIRED`（缺用途授权）与 `SCOPE_DENIED`（会话无权）**必须**原样带出，
 * 不得折叠成"登录失效"（那会把用户引向错误动作，还会误清会话）。
 *
 * 归因口径**收敛**到 `utils/auth.js`（单一事实源）：改前本文件与 `utils/identify-api.js`
 * 各持一份 `SESSION_LOSS_CODES`，且对 `ACCOUNT_INACTIVE` 的处理**相反**（此处按登录失效折叠、
 * 彼处原样带出）。现在两处都委托 `auth.failureFor`：403 码原样带出，仅 `ACCOUNT_INACTIVE`
 * 清会话（令牌已永久失效，但码不谎称"登录过期"）。
 */
function forbiddenOrSessionLoss(statusCode, payload) {
  return auth.failureFor(failure, statusCode, payload)
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

/**
 * **尝试身份的幂等键**：同一次尝试（descriptor 相同）的重试复用同一把键。
 *
 * 为什么需要它：网络未能确认结果（`NETWORK_UNCERTAIN`）时用户会重试同一动作；若每次都换键，
 * 服务端会把重试当成新请求（确认写两次／轮次建两条）。descriptor 由调用方按
 * 「动作 + 资源 + revision + 正文」拼成：用户**改过正文**或**版本变化** ⇒ descriptor 变化
 * ⇒ 自然换新键（同键异体本就会被服务端判 `IDEMPOTENCY_CONFLICT`）。
 */
function stableKey(previous, descriptor, prefix) {
  if (object(previous) && previous.descriptor === descriptor && typeof previous.key === 'string' && previous.key.length >= IDEMPOTENCY_MIN) {
    return previous.key
  }
  return newKey(prefix)
}

/** `If-Match` 一律由服务端回传的 revision 生成（不内联硬编码 `"1"`）。 */
function etagOf(revision) { return '"' + String(revision) + '"' }

// ---------------------------------------------------------------- 契约操作

/**
 * `POST /speech/transcriptions`：受理一次转写（202 + Job[queued]）。
 *
 * `mediaRef` 必须是 `{media_id, media_revision}`：真实上传产物（real 模式）或**明确标注的
 * 替身引用**（stub/preset_demo 本地走查）。本层不发明媒体引用；调用方给不出引用时不得调用。
 */
async function createTranscription(mediaRef, idempotencyKey) {
  if (!object(mediaRef) || !uuid(mediaRef.media_id) || !integer(mediaRef.media_revision, 1)) throw failure('INVALID_INPUT')
  const key = typeof idempotencyKey === 'string' && idempotencyKey.length >= IDEMPOTENCY_MIN && idempotencyKey.length <= IDEMPOTENCY_MAX
    ? idempotencyKey
    : newKey('i11-transcribe')
  const response = await request('POST', '/speech/transcriptions', {
    body: { media_id: mediaRef.media_id, media_revision: mediaRef.media_revision },
    idempotencyKey: key
  })
  const job = validateJob(response.data, 'transcription')
  if (job.target_ref.type !== 'transcription') throw failure('INVALID_RESPONSE')
  return { job: job, transcriptionId: job.target_ref.id, mode: response.mode, etag: response.etag }
}

/**
 * `GET /speech/transcriptions/{id}`：读转写记录。
 *
 * **404 是正常中间态**：服务端对 queued/running 与失败终态（failed/timed_out/uncertain/cancelled）
 * 都不产生记录，一律 404。调用方按 `deadline_at` 决定何时停止轮询并如实报「未产出可核对记录」，
 * 不得把 404 当成"待重试的暂时故障"无限轮，也不得编造文本。
 */
async function getTranscription(transcriptionId) {
  if (!uuid(transcriptionId)) throw failure('INVALID_INPUT')
  const response = await request('GET', '/speech/transcriptions/' + transcriptionId, {})
  const record = validateTranscription(response.data)
  if (record.id !== transcriptionId) throw failure('INVALID_RESPONSE')
  return { record: record, mode: response.mode, etag: response.etag }
}

/**
 * `PATCH /speech/transcriptions/{id}/confirmation`：**用户明确确认**（唯一写 `confirmed_text` 的入口）。
 *
 * `If-Match` 取调用方从读面取得的当前 revision；同键重放由服务端收敛（不重复写入）。
 * 本层**不**代替用户判断：`confirmedText` 必须来自用户编辑后的正文。
 */
async function confirmTranscription(input) {
  if (!object(input) || !uuid(input.transcriptionId) || !integer(input.revision, 1)) throw failure('INVALID_INPUT')
  if (typeof input.confirmedText !== 'string' || input.confirmedText.trim() === '' || input.confirmedText.length > TEXT_MAX) {
    throw failure('INVALID_INPUT')
  }
  const key = typeof input.idempotencyKey === 'string' && input.idempotencyKey.length >= IDEMPOTENCY_MIN && input.idempotencyKey.length <= IDEMPOTENCY_MAX
    ? input.idempotencyKey
    : newKey('i11-confirm')
  const response = await request('PATCH', '/speech/transcriptions/' + input.transcriptionId + '/confirmation', {
    body: { confirmed_text: input.confirmedText, confirmation: CONFIRMATION_VALUE },
    ifMatch: etagOf(input.revision),
    idempotencyKey: key
  })
  const record = validateTranscription(response.data)
  if (record.id !== input.transcriptionId) throw failure('INVALID_RESPONSE')
  if (record.confirmed_text !== input.confirmedText || record.confirmed_at === null) throw failure('INVALID_RESPONSE')
  return { record: record, mode: response.mode, etag: response.etag }
}

/**
 * `DELETE /speech/transcriptions/{id}`：**取消**（归属者软删除记录）。
 *
 * 取消是用户动作，不是服务端任务取消（转写任务没有取消 operation）：删除后
 * ① 闸门永久关闭（`cancelled` 后任何路径都不得外发轮次）；
 * ② 迟到响应只更新展示，不得复活任何发送资格。
 */
async function deleteTranscription(input) {
  if (!object(input) || !uuid(input.transcriptionId) || !integer(input.revision, 1)) throw failure('INVALID_INPUT')
  const key = typeof input.idempotencyKey === 'string' && input.idempotencyKey.length >= IDEMPOTENCY_MIN && input.idempotencyKey.length <= IDEMPOTENCY_MAX
    ? input.idempotencyKey
    : newKey('i11-cancel')
  const response = await request('DELETE', '/speech/transcriptions/' + input.transcriptionId, {
    ifMatch: etagOf(input.revision),
    idempotencyKey: key
  })
  const ack = validateAck(response.data)
  return { accepted: ack.accepted, mode: response.mode, etag: response.etag }
}

/** `POST /conversations`：确保有一个可发送的会话（201 + Conversation）。 */
async function createConversation(idempotencyKey) {
  const key = typeof idempotencyKey === 'string' && idempotencyKey.length >= IDEMPOTENCY_MIN && idempotencyKey.length <= IDEMPOTENCY_MAX
    ? idempotencyKey
    : newKey('i11-conversation')
  const response = await request('POST', '/conversations', { body: {}, idempotencyKey: key })
  const conversation = validateConversation(response.data)
  return { conversation: conversation, mode: response.mode, etag: response.etag }
}

/**
 * `POST /conversations/{id}/turns`：**发送**已确认的语音轮次（202 + Job[kind=answer]）。
 *
 * 前置条件由 `evaluateSendGate` 在调用方侧把关；本层只按契约形状发送：
 * `If-Match` 绑**会话** revision（服务端据此判会话版本），`transcription_revision`
 * 必须是确认成功后的记录 revision（服务端核对同 owner + revision + `confirmed_text` 非空）。
 *
 * 回答任务是异步作业：本片只回报受理事实（job id/state），不呈现回答内容（问答页另行交付）。
 */
async function sendSpeechTurn(input) {
  if (!object(input) || !uuid(input.conversationId) || !integer(input.conversationRevision, 1)) throw failure('INVALID_INPUT')
  if (!uuid(input.transcriptionId) || !integer(input.transcriptionRevision, 1)) throw failure('INVALID_INPUT')
  const key = typeof input.idempotencyKey === 'string' && input.idempotencyKey.length >= IDEMPOTENCY_MIN && input.idempotencyKey.length <= IDEMPOTENCY_MAX
    ? input.idempotencyKey
    : newKey('i11-send')
  const response = await request('POST', '/conversations/' + input.conversationId + '/turns', {
    body: {
      input_type: 'speech',
      transcription_id: input.transcriptionId,
      transcription_revision: input.transcriptionRevision,
      confirmed: true
    },
    ifMatch: etagOf(input.conversationRevision),
    idempotencyKey: key
  })
  const job = validateJob(response.data, 'answer')
  if (job.target_ref.type !== 'answer') throw failure('INVALID_RESPONSE')
  return { job: job, mode: response.mode, etag: response.etag }
}

// ---------------------------------------------------------------- 发送闸门（fail-closed）

/**
 * **发送闸门**：唯一允许「外发轮次」的判定入口（纯函数，可单测）。
 *
 * 判据（全部满足才放行；任何一条不满足都零请求）：
 *  1. `cancelled !== true`：用户取消后永久关闭（取消不外发后续问答）；
 *  2. `current === true`：操作未因离页／新一代次而作废（迟到回调不得借旧操作外发）；
 *  3. `confirmed` 存在且正文非空白：本机**成功**完成过一次 PATCH 确认（用户明确确认）；
 *  4. `record` 存在且 `record.revision === confirmed.revision`：服务端记录与确认时点一致；
 *  5. `record.confirmed_text`／`confirmed_at` 非空且与 `confirmed.text` 逐字一致：
 *     服务端同样处于已确认状态，且确认的就是用户编辑过的那份正文。
 *
 * 输入形状：
 * ```js
 * { record: Transcription|null, confirmed: {text,revision,at}|null, cancelled: boolean, current: boolean }
 * ```
 */
function evaluateSendGate(input) {
  const state = object(input) ? input : {}
  const cancelled = state.cancelled === true
  const current_ = state.current === true
  const confirmed = object(state.confirmed) ? state.confirmed : null
  const record = object(state.record) ? state.record : null

  if (cancelled === true) {
    return { ok: false, code: 'TRANSCRIPT_CANCELLED', message: '本次转写已取消：取消后不会外发任何问答，也不会再发送。' }
  }
  if (current_ !== true) {
    return { ok: false, code: 'CLIENT_CANCELLED', message: '操作已作废（已离页或已开始新操作）：在途结果不外发。' }
  }
  if (confirmed === null || typeof confirmed.text !== 'string' || confirmed.text.trim() === '') {
    return { ok: false, code: 'NOT_CONFIRMED', message: '尚未经用户明确确认：编辑正文并点击「核对并发送」之前，不会发送任何问答。' }
  }
  if (record === null) {
    return { ok: false, code: 'NOT_FOUND', message: '转写记录不存在（未产出／已删除）：不发送。' }
  }
  if (!integer(confirmed.revision, 1) || record.revision !== confirmed.revision) {
    return { ok: false, code: 'REVISION_CONFLICT', message: '转写版本与确认时点不一致：请刷新后重新核对，不发送。' }
  }
  if (record.confirmed_text === null || record.confirmed_at === null) {
    return { ok: false, code: 'NOT_CONFIRMED', message: '服务端记录尚未处于已确认状态：不发送。' }
  }
  if (record.confirmed_text !== confirmed.text) {
    return { ok: false, code: 'REVISION_CONFLICT', message: '服务端确认正文与本次核对不一致：不发送。' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------- 文案

/**
 * 错误码 → 页面可展示的一句话（不改变判定，只做措辞；未收录一律中性兜底）。
 *
 * 红线（与仓库既有口径一致）：
 * - 503 `PROVIDER_UNAVAILABLE` ⇒ 指向**真实 ASR 未接线**，不得说成网络问题；
 * - 403 `CONSENT_REQUIRED`（缺用途授权）与 `SCOPE_DENIED`（会话无权）必须**各不相同**，
 *   且都不得写成"登录失效"；只有 `SESSION_*` 才是登录/会话类问题。
 */
const TRANSCRIPT_MESSAGES = Object.freeze({
  // 会话 / 门禁 / 作废
  SESSION_REQUIRED: '登录状态已失效，请重新登录后再转写。',
  SESSION_EXPIRED: '登录状态已过期，请重新登录后再转写。',
  SESSION_CHANGED: '会话已变化：本次转写已作废，请重新进入本页。',
  CLIENT_CANCELLED: '已离开本页或已取消：在途请求已作废，不外发任何内容。',
  NETWORK_UNCERTAIN: '网络未能确认结果：已停止，请重试（同一尝试会复用同一幂等键，不会重复确认）。',
  // 403：非会话类原样带出
  CONSENT_REQUIRED: '缺少用途授权（403 CONSENT_REQUIRED）：语音转写需要「录音 / 媒体处理 / 对外推理」授权，未授权时不会转写、不会外发。',
  SCOPE_DENIED: '当前会话无权使用该能力（403 SCOPE_DENIED）：未转写、未外发。',
  ACCOUNT_INACTIVE: '账号当前不可用（403 ACCOUNT_INACTIVE）：未转写、未外发。',
  // 404 / 409 / 428 / 429
  NOT_FOUND: '转写记录不存在或不可见（可能不属于当前账号，或失败终态本就不产生记录）。',
  REVISION_CONFLICT: '版本已变化：请重新读取转写记录后再核对，不发送。',
  REVISION_REQUIRED: '缺少版本信息：请刷新后重试。',
  RATE_LIMITED: '请求过于频繁，请稍后重试。',
  REQUEST_IN_PROGRESS: '同一请求正在处理中：请稍后重试，不会重复执行。',
  // 400 / 413 / 422
  INVALID_REQUEST: '服务端按契约拒绝该请求（参数不符）：已停止。',
  INVALID_INPUT: '本地参数不合法：已停止，未发出请求。',
  INVALID_RESPONSE: '服务端响应无法核对：已停止，不伪造转写结果、不外发。',
  // 转写域终态
  INPUT_UNCERTAIN: '转写未能判定出可用文本（无有效语音／置信不足）：不产生记录、不编造文本、不发送。',
  // 503 / 504：**真实 ASR 未接线**（不得说成网络问题）
  PROVIDER_UNAVAILABLE: '真实 ASR 提供者未接线（503 PROVIDER_UNAVAILABLE）：受理前即被拒绝，不落任务、不外发。',
  PROVIDER_TIMEOUT: '提供者超时（504 PROVIDER_TIMEOUT）：任务落超时，不记为成功、不发送。',
  PROVIDER_QUOTA_EXCEEDED: '提供者配额不足：本次未转写。',
  PROVIDER_OUTCOME_UNKNOWN: '提供者结果未知：已如实落失败，不记为成功、不发送。',
  OBJECT_UNAVAILABLE: '录音引用不可用：已如实拒绝，不伪造媒体引用、不外发。',
  UNAVAILABLE: '转写服务暂不可用：已停止，请重试。'
})

/** 逐码文案；未收录一律给出中性兜底（不发明原因）。 */
function messageFor(error) {
  const code = error && error.code
  const message = TRANSCRIPT_MESSAGES[code]
  return typeof message === 'string' ? message : '转写未成功（未收录的错误码：' + String(code) + '）：已停止，不记为成功、不外发。'
}

module.exports = {
  CONTRACT_VERSION: CONTRACT_VERSION,
  EXECUTION_MODES: EXECUTION_MODES.slice(),
  TARGET_REF_TYPES: TARGET_REF_TYPES.slice(),
  JOB_STATES: JOB_STATES.slice(),
  JOB_KEYS: JOB_KEYS.slice(),
  TRANSCRIPTION_KEYS: TRANSCRIPTION_KEYS.slice(),
  CONVERSATION_KEYS: CONVERSATION_KEYS.slice(),
  ACK_KEYS: ACK_KEYS.slice(),
  CONFIRMATION_VALUE: CONFIRMATION_VALUE,
  POLL_INTERVAL_MS: POLL_INTERVAL_MS,
  POLL_MAX_TICKS: POLL_MAX_TICKS,
  TEXT_MAX: TEXT_MAX,
  SUBSTITUTE_RECORD_SAMPLES: SUBSTITUTE_RECORD_SAMPLES,
  SUBSTITUTE_RECORD_NOTE: SUBSTITUTE_RECORD_NOTE,
  TRANSCRIPT_MESSAGES: TRANSCRIPT_MESSAGES,
  messageFor: messageFor,
  validateTranscription: validateTranscription,
  validateTranscriptionJob: function (value) { return validateJob(value, 'transcription') },
  validateAnswerJob: function (value) { return validateJob(value, 'answer') },
  validateConversation: validateConversation,
  validateAck: validateAck,
  evaluateSendGate: evaluateSendGate,
  createTranscription: createTranscription,
  getTranscription: getTranscription,
  confirmTranscription: confirmTranscription,
  deleteTranscription: deleteTranscription,
  createConversation: createConversation,
  sendSpeechTurn: sendSpeechTurn,
  cancelAll: cancelAll,
  inFlightEpoch: function () { return inFlight.epoch },
  newKey: newKey,
  stableKey: stableKey,
  etagOf: etagOf,
  validId: uuid
}
