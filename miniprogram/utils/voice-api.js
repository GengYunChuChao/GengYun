// GY-I13 合成（普通话 TTS）HTTP 消费层（原生小程序侧）。
//
// 契约面（packages/contracts/openapi.json 1.0.0，**只用既有 operation，不自造路径**）：
//   createSynthesis  POST /speech/synthesis  → 202 JobEnvelope（`Idempotency-Key` 必填 8..128）
//   getJob           GET  /jobs/{id}         → 200 JobEnvelope（读 JobState 的唯一契约面）
//
// 硬口径：
// 1) **客户端不说内容**：请求体只有 `checked_content_ref`（type/id/revision）与 `locale:'zh-CN'`，
//    与契约 `SynthesisInput` 的 `additionalProperties:false` 逐项一致；正文一律由服务端从
//    「已核对内容」读出，客户端**没有任何**把自由文本送去合成的入口。
// 2) **安全检查在前**：本层**不**自己放行任何内容——调用方必须先过 `utils/speech-text.js` 的
//    `assertSpeakable`（`check_state === 'passed'`）；本层只负责把 ref 发出去。
// 3) **无取消能力如实登记**：契约**没有**「取消合成任务」的语义（`tts/service.ts` 也没有取消入口）。
//    离页时本层只做**客户端侧**的在途请求失效与轮询停止，**绝不**谎称服务端任务已取消。
// 4) **不产生、不顶替音频**：`audioSourceForJob()` 只如实回答"现在有没有可播放的音频源"；
//    替身产物不是音频 ⇒ 一律 `SOURCE_UNAVAILABLE`，**不得**用别的音频顶替。
'use strict'

const auth = require('./auth')
const runtime = require('../config/runtime')
const debug = require('./debug')

const CONTRACT_VERSION = '1.0.0'
const EXECUTION_MODES = ['real', 'stub', 'preset_demo']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 契约 `SynthesisTarget.type` 闭集（逐项一致，不得扩展）。 */
const SYNTHESIS_TARGET_TYPES = ['answer', 'scheme', 'herbicide', 'species', 'static_region', 'dose_card']

/** 契约 `JobState` 闭集。 */
const JOB_STATES = ['queued', 'running', 'succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled']

/** 契约 `Job.required`（九键，`additionalProperties:false`）。 */
const JOB_KEYS = ['id', 'revision', 'kind', 'target_ref', 'state', 'deadline_at', 'created_at', 'error_code', 'result']

/** 契约 `Synthesis`（`JobResult` 的 `synthesis` 分支取值）。 */
const SYNTHESIS_KEYS = ['id', 'revision', 'checked_content_ref', 'media_id']

const LOCALE = 'zh-CN'
const TARGET_ID_MAX = 80
const IDEMPOTENCY_MIN = 8
const IDEMPOTENCY_MAX = 128

/**
 * **明确标注的替身样本**（仅本地替身工程可见，见 `substituteSamplesEnabled`）。
 *
 * 它们不是真实资料、不是任何真实核对结论，也不构成任何用药建议或用量结论；
 * 只用于离线核对「安全检查断路」与播报控件的分段/关键令牌复核。
 * `blocked` 那条是**反例样本**：安全检查未过时，页面必须既不合成也不播报。
 */
const SUBSTITUTE_SPEAK_SAMPLES = [
  {
    id: 'sample-i13-passed',
    label: '替身样本 · 已通过核对（正例）',
    checkState: 'passed',
    checkedText: '稗草苗后茎叶处理：每亩用 30 毫升，兑水 30 升常规喷雾。'
      + '不得在高温时段施药，不要与碱性药剂混用；安全间隔期 14 天。'
  },
  {
    id: 'sample-i13-blocked',
    label: '替身样本 · 安全检查阻断（反例）',
    checkState: 'blocked',
    checkedText: '该替身样本代表"已核对内容被判定为阻断"：安全检查未通过时不得合成、不得播报。'
  }
]

const SUBSTITUTE_NOTE = '替身样本：非真实资料、非真实核对结论、不是音频，也不构成任何用药建议；'
  + '只在本地替身工程里用于离线核对控件与安全检查断路，不得当作真实播报内容。'

function failure(code) { const error = new Error(code); error.code = code; return error }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value) }
function one(value, values) { return values.indexOf(value) !== -1 }
function text(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max }
function integer(value, min) { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min }
function uuid(value) { return typeof value === 'string' && UUID.test(value) }
function sameKeys(value, required) {
  if (!object(value)) return false
  const actual = Object.keys(value)
  return actual.length === required.length && required.every(function (key) { return actual.indexOf(key) !== -1 })
}

/** 替身样本只在**本地替身工程**（runtime.mode==='local' 且 develop 版本）可见。 */
function substituteSamplesEnabled(wxApi) {
  return debug.localEnabled(wxApi || (typeof wx === 'undefined' ? null : wx))
}

/** 校验契约 `TargetRef`（合成目标只允许 `SynthesisTarget.type` 闭集）。 */
function validateCheckedContentRef(value) {
  if (!sameKeys(value, ['type', 'id', 'revision'])) throw failure('INVALID_RESPONSE')
  if (!one(value.type, SYNTHESIS_TARGET_TYPES)) throw failure('INVALID_RESPONSE')
  if (!text(value.id, TARGET_ID_MAX) || !integer(value.revision, 1)) throw failure('INVALID_RESPONSE')
  return { type: value.type, id: value.id, revision: value.revision }
}

/** 校验契约 `Job`（九键；kind 必须是 synthesis；状态闭集）。 */
function validateJob(value) {
  if (!sameKeys(value, JOB_KEYS)) throw failure('INVALID_RESPONSE')
  if (!uuid(value.id) || !integer(value.revision, 1)) throw failure('INVALID_RESPONSE')
  if (value.kind !== 'synthesis') throw failure('INVALID_RESPONSE')
  if (!one(value.state, JOB_STATES)) throw failure('INVALID_RESPONSE')
  if (!text(value.deadline_at, 64) || !text(value.created_at, 64)) throw failure('INVALID_RESPONSE')
  if (value.error_code !== null && typeof value.error_code !== 'string') throw failure('INVALID_RESPONSE')
  const result = value.result
  if (result === null) {
    return { id: value.id, revision: value.revision, kind: 'synthesis', target_ref: validateCheckedContentRef(value.target_ref), state: value.state, error_code: value.error_code, result: null }
  }
  if (!sameKeys(result, ['kind', 'value']) || result.kind !== 'synthesis') throw failure('INVALID_RESPONSE')
  if (!sameKeys(result.value, SYNTHESIS_KEYS) || !uuid(result.value.id) || !integer(result.value.revision, 1) || !uuid(result.value.media_id)) {
    throw failure('INVALID_RESPONSE')
  }
  const targetRef = validateCheckedContentRef(value.target_ref)
  const resultRef = validateCheckedContentRef(result.value.checked_content_ref)
  if (targetRef.type !== resultRef.type || targetRef.id !== resultRef.id || targetRef.revision !== resultRef.revision) {
    // 结果必须绑定同一个已核对目标与 revision；不一致一律按不可核对处理（不猜测、不修正）。
    throw failure('INVALID_RESPONSE')
  }
  return { id: value.id, revision: value.revision, kind: 'synthesis', target_ref: targetRef, state: value.state, error_code: value.error_code, result: { id: result.value.id, revision: result.value.revision, media_id: result.value.media_id } }
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
 * 在途请求登记表：**离页的唯一取消出口**。
 *
 * 只做客户端侧的事——把在途回调标记为失效（`cancelAll()` 递增代次），并停止页面轮询。
 * 服务端**没有**合成任务取消接口（见文件头 3），因此这里**不**发送任何"取消"请求，
 * 也不向用户声称"服务端任务已取消"。
 */
const inFlight = { epoch: 0 }

/** 使所有在途请求的回调失效（离页/切页/隐藏时调用；幂等）。 */
function cancelAll() {
  inFlight.epoch += 1
  return { epoch: inFlight.epoch, serverSideCancel: false }
}

/** 离页取消口径的**如实**文案（页面必须原样展示，不得改写成"已取消服务端任务"）。 */
const EXIT_CANCELLATION_NOTE = '合成任务没有服务端取消能力（契约只提供受理与读取），'
  + '因此离开本页只会取消本机在途请求、停止轮询并释放播放器与监听；不会谎称服务端任务已取消。'

function request(method, path, options) {
  const config = options || {}
  const bound = binding()
  if (!bound || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  const epoch = inFlight.epoch
  const header = { authorization: 'Bearer ' + bound.token, 'Cache-Control': 'no-cache' }
  if (config.body !== undefined) header['content-type'] = 'application/json'
  if (config.idempotencyKey) header['Idempotency-Key'] = config.idempotencyKey
  return new Promise(function (resolve, reject) {
    const wxOptions = {
      url: runtime.apiBaseUrl + path,
      method: method,
      timeout: 15000,
      header: header,
      success: function (response) {
        if (!current(bound)) { reject(failure('SESSION_CHANGED')); return }
        if (epoch !== inFlight.epoch) { reject(failure('CLIENT_CANCELLED')); return }
        if (response.statusCode === 401 || response.statusCode === 403) { auth.clearSession(); reject(failure('SESSION_REQUIRED')); return }
        try {
          const payload = response.data
          if (response.statusCode === 200 || response.statusCode === 202) {
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
 * `POST /speech/synthesis`：受理一次合成。
 * 调用方**必须**先过安全检查闸门（`speech-text.assertSpeakable`）；本层不代替闸门。
 */
async function createSynthesis(checkedContentRef, idempotencyKey) {
  const ref = validateCheckedContentRef(checkedContentRef)
  const key = typeof idempotencyKey === 'string' && idempotencyKey.length >= IDEMPOTENCY_MIN && idempotencyKey.length <= IDEMPOTENCY_MAX
    ? idempotencyKey
    : newKey('i13-syn')
  const response = await request('POST', '/speech/synthesis', {
    body: { checked_content_ref: { type: ref.type, id: ref.id, revision: ref.revision }, locale: LOCALE },
    idempotencyKey: key
  })
  return { job: validateJob(response.data), mode: response.mode, etag: response.etag }
}

/** `GET /jobs/{id}`：读合成任务状态（读 JobState 的唯一契约面）。 */
async function getJob(jobId) {
  if (!uuid(jobId)) throw failure('INVALID_INPUT')
  const response = await request('GET', '/jobs/' + jobId, {})
  if (response.data.id !== jobId) throw failure('INVALID_RESPONSE')
  return { job: validateJob(response.data), mode: response.mode, etag: response.etag }
}

/** 终态判定（queued/running 未终态；其余五类终态）。 */
function isTerminal(state) {
  return one(state, ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'])
}

/**
 * **如实回答"现在有没有可播放的音频源"**（不顶替、不猜测）。
 *
 * 逐项 fail-closed：
 *  - 任务不是 `succeeded` ⇒ 没有产物；
 *  - `stub`/`preset_demo` 的替身产物**不是音频**（服务端 `tts/provider.ts` 的标注产物）⇒ 不可播放；
 *  - `real` 模式下契约**没有**面向客户端的音频下载端点，`media_id` 需要走已合并的媒体访问授权链，
 *    本片**未接** ⇒ 不可播放。
 *
 * 因此本片在离线/替身环境下**恒**得到 `SOURCE_UNAVAILABLE`，页面据此给出文案与主动播放按钮，
 * 并且**不得**记「已听取」。可播放路径由注入的替身播放端口在离线走查/回归里覆盖。
 */
function audioSourceForJob(job, mode) {
  if (!object(job) || !one(job.state, JOB_STATES)) return { ok: false, code: 'SOURCE_UNAVAILABLE', reason: '任务状态无法核对。' }
  if (job.state !== 'succeeded' || job.result === null) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', reason: '合成任务未成功完成（state=' + job.state + '），没有可播放的产物。' }
  }
  if (mode !== 'real') {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', reason: '当前为替身执行模式（' + String(mode) + '）：替身产物不是音频，不可播放；本页不用别的音频顶替。' }
  }
  return { ok: false, code: 'SOURCE_UNAVAILABLE', reason: '真实合成产物的下载链路（媒体访问授权）尚未接线：本页如实报不可播放。' }
}

/** 任务状态 → 页面一行说明（七类逐类呈现，不折叠成"成功/失败"）。 */
function describeJob(job) {
  const state = job && job.state
  const labels = {
    queued: '已受理，排队中',
    running: '合成中',
    succeeded: '合成成功（产物可用性另行判定）',
    uncertain: '结果不确定',
    failed: '合成失败',
    timed_out: '合成超时',
    cancelled: '已取消'
  }
  return {
    state: state,
    terminal: isTerminal(state),
    label: labels[state] || '状态未知',
    errorCode: job && typeof job.error_code === 'string' ? job.error_code : null
  }
}

/** 错误码 → 页面可展示的一句话（不改变判定，只做措辞；未收录一律给出中性兜底）。 */
function messageFor(error) {
  const code = error && error.code
  return {
    SESSION_REQUIRED: '登录状态已失效，请重新登录后再播报。',
    SESSION_CHANGED: '会话已变化，请重新进入本页。',
    NETWORK_UNCERTAIN: '网络未能确认结果，已停止，请重试。',
    CLIENT_CANCELLED: '已离开本页，在途请求已作废（服务端任务未被取消）。',
    NOT_FOUND: '该已核对内容不存在、不可见，或不属于当前账号。',
    REVISION_CONFLICT: '内容已修订，旧音频视为过期：请重新核对后再播报。',
    INPUT_UNCERTAIN: '内容尚未通过核对：不得合成、不得播报。',
    CONDITIONS_INCOMPLETE: '条件不完整：本次不合成、不播报。',
    SOURCE_CONFLICT: '来源存在冲突：本次不合成、不播报。',
    OBJECT_UNAVAILABLE: '取不到核对状态或产物存储未接线：已拒绝（不当作已核对、不产生假音频）。',
    PROVIDER_UNAVAILABLE: '真实 TTS 提供者未接线：已拒绝受理（不落任务、不产生假音频）。',
    PROVIDER_OUTCOME_UNKNOWN: '提供者结果未知：已如实落失败，不记为成功。',
    PROVIDER_TIMEOUT: '提供者超时：任务落超时，不记为成功。',
    PROVIDER_QUOTA_EXCEEDED: '提供者配额不足：本次未合成。',
    RATE_LIMITED: '请求过于频繁，请稍后重试。',
    SCOPE_DENIED: '当前会话无权使用该能力。',
    CONSENT_REQUIRED: '缺少用途授权：未获得授权时不会合成。',
    ACCOUNT_INACTIVE: '账号当前不可用。',
    INVALID_REQUEST: '请求参数不合法，已停止。',
    IDEMPOTENCY_KEY_REQUIRED: '请求缺少幂等键，请重试。',
    IDEMPOTENCY_CONFLICT: '同一幂等键被复用于不同请求，请重试。',
    REVISION_REQUIRED: '缺少版本信息，请刷新后重试。',
    INVALID_INPUT: '本地参数不合法，已停止。',
    INVALID_RESPONSE: '服务端响应无法核对，已停止，请重试。',
    UNAVAILABLE: '合成服务暂不可用，已停止，请重试。'
  }[code] || '合成服务暂不可用，已停止，请重试。'
}

module.exports = {
  CONTRACT_VERSION: CONTRACT_VERSION,
  LOCALE: LOCALE,
  UUID: UUID,
  SYNTHESIS_TARGET_TYPES: SYNTHESIS_TARGET_TYPES.slice(),
  JOB_STATES: JOB_STATES.slice(),
  JOB_KEYS: JOB_KEYS.slice(),
  SYNTHESIS_KEYS: SYNTHESIS_KEYS.slice(),
  SUBSTITUTE_SPEAK_SAMPLES: SUBSTITUTE_SPEAK_SAMPLES,
  SUBSTITUTE_NOTE: SUBSTITUTE_NOTE,
  EXIT_CANCELLATION_NOTE: EXIT_CANCELLATION_NOTE,
  substituteSamplesEnabled: substituteSamplesEnabled,
  validateCheckedContentRef: validateCheckedContentRef,
  validateJob: validateJob,
  createSynthesis: createSynthesis,
  getJob: getJob,
  isTerminal: isTerminal,
  audioSourceForJob: audioSourceForJob,
  describeJob: describeJob,
  cancelAll: cancelAll,
  inFlightEpoch: function () { return inFlight.epoch },
  newKey: newKey,
  messageFor: messageFor,
  validId: uuid
}
