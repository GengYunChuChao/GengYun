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
// 1b) **revision 不硬编码**：目标引用一律经 `checkedContentRefForSample()` 取契约值，
//    且**优先**用服务端回传的 revision（`rememberServerRevision`）；样本未声明 `targetRef` ⇒ 返回 null，
//    调用方据此**不发起**合成（绝不内联拼一个 `revision: 1`）。
// 2) **安全检查在前**：本层**不**自己放行任何内容——调用方必须先过 `utils/speech-text.js` 的
//    `assertSpeakable`（`check_state === 'passed'`）；本层只负责把 ref 发出去。
// 3) **无取消能力如实登记**：契约**没有**「取消合成任务」的语义（`tts/service.ts` 也没有取消入口）。
//    离页时本层只做**客户端侧**的在途请求失效与轮询停止，**绝不**谎称服务端任务已取消。
// 4) **不产生、不顶替音频**：`audioSourceForJob()` 只如实回答"现在有没有可播放的音频源"；
//    替身产物不是音频、契约也没有面向客户端的音频出口 ⇒ 一律 `SOURCE_UNAVAILABLE`，
//    **不得**用别的音频顶替、**不得**假装能播；页面口径见 `NO_CLIENT_AUDIO_EGRESS_NOTE`。
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
 *
 * `targetRef` ＝ 契约 `SynthesisTarget`（`type`/`id`/`revision` 三键，逐项一致）：
 * 页面**不得**内联拼 `revision: 1`，一律经 `checkedContentRefForSample()` 取契约值
 * （并且**优先**采用服务端回传的 revision，见 `rememberServerRevision`）。
 * 正例样本的 `targetRef` 必须与服务端装配层注入的替身核对条目
 * （`services/api/src/app.ts` 的 `SYNTHESIS_SUBSTITUTE_CHECKED_CONTENT`）逐项一致、正文逐字一致，
 * 该配对由回归用例直接比对锁定；`blocked` 反例刻意**不声明** `targetRef`：
 * 安全检查不通过 ⇒ 页面永不发起合成，它也就不该有可合成的契约目标引用。
 */
const SUBSTITUTE_SPEAK_SAMPLES = [
  {
    id: 'sample-i13-passed',
    label: '替身样本 · 已通过核对（正例）',
    checkState: 'passed',
    checkedText: '稗草苗后茎叶处理：每亩用 30 毫升，兑水 30 升常规喷雾。'
      + '不得在高温时段施药，不要与碱性药剂混用；安全间隔期 14 天。',
    targetRef: { type: 'answer', id: 'sample-i13-passed', revision: 1 }
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

/**
 * **页面必须原样展示的如实口径**（契约层面的结构性事实；既不是网络问题，也不是临时故障）。
 *
 * 依据（实读证据：`.pg17/handoff/slice451-synthesis-playback-b619e62.md`）：
 * 冻结契约 85 条路径里**没有**面向客户端的音频出口 —— `POST /media/{id}/access` 只回句柄
 * （`AccessGrant` 无字节），其 `url` 是部署期访问网关占位域，`GET /media/{id}/content` 不存在，
 * 唯一返回媒体字节的 `GET /community/media/{grant_id}/content` 硬要求社区图片上下文。
 * ⇒ 合成成功后**也**取不到可播放来源：页面不得显示「播放中／已播放」、不得伪造音频、
 * 不得用别的音频顶替；真实可播放来源需先放开契约（属监制/用户裁定）。
 */
const NO_CLIENT_AUDIO_EGRESS_NOTE = '本环境无可播放音频（契约无客户端音频出口）：'
  + '契约只提供合成受理与任务读取，没有面向客户端的音频下载 operation，合成成功也取不到可播放来源；'
  + '本页不伪造音频、不用别的音频顶替、不记「已听取」。'

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
 * **服务端已回传的 revision**（按 `type\u0000id` 记，进程内；不落盘、不上报）。
 *
 * 为什么需要它：契约里**没有**「读某个已核对目标当前 revision」的 operation
 * （TTS 域只有 `POST /speech/synthesis`），因此客户端唯一能拿到的**权威** revision
 * 就是服务端在响应里回传的那个（`Job.target_ref.revision`，与 `Synthesis.checked_content_ref.revision`
 * 由 `validateJob` 校验为同一个）。页面**不得**内联硬编码 `revision: 1`。
 */
const serverRevisions = {}

function targetKeyOf(ref) {
  return String(ref.type) + '\u0000' + String(ref.id)
}

/**
 * 记下服务端回传的 revision（受理响应与 `GET /jobs/{id}` 读面都调用）。
 *
 * 只认形状合法的 `target_ref`（三键、type 在闭集内、id 1..80、revision ≥1 整数）；
 * 按 `(type,id)` 归位 ⇒ **不会**把别的目标的 revision 张冠李戴到本样本上。
 * 不合法一律**不记**（返回 null），由调用方继续用先前值，绝不猜。
 */
function rememberServerRevision(job) {
  const ref = object(job) ? job.target_ref : null
  if (!object(ref) || !sameKeys({ type: ref.type, id: ref.id, revision: ref.revision }, ['type', 'id', 'revision'])) return null
  if (!one(ref.type, SYNTHESIS_TARGET_TYPES) || !text(ref.id, TARGET_ID_MAX) || !integer(ref.revision, 1)) return null
  serverRevisions[targetKeyOf(ref)] = ref.revision
  return ref.revision
}

/** 清空本机记住的服务端 revision（离页/切账号时调用；幂等）。 */
function forgetServerRevisions() {
  for (const key of Object.keys(serverRevisions)) delete serverRevisions[key]
}

/**
 * 取某个样本的**契约目标引用**（`SynthesisTarget` 三键）。
 *
 * 优先级刻意如此：
 *  1. **服务端回传的 revision**（`rememberServerRevision` 记下的；这是唯一权威值）；
 *  2. 否则用样本**声明的** `targetRef`（替身夹具；与装配层替身条目配对，由回归用例锁定）。
 * 样本没有声明 `targetRef`（如安全检查反例样本）⇒ 返回 `null`：调用方**不得**发明引用、
 * 不得发起合成（页面据此如实提示，而不是拼一个 `revision: 1` 出来）。
 */
function checkedContentRefForSample(sample) {
  const declared = object(sample) ? sample.targetRef : null
  if (!object(declared)) return null
  let ref
  try {
    ref = validateCheckedContentRef({ type: declared.type, id: declared.id, revision: declared.revision })
  } catch (error) {
    return null
  }
  const remembered = serverRevisions[targetKeyOf(ref)]
  return { type: ref.type, id: ref.id, revision: integer(remembered, 1) ? remembered : ref.revision }
}

/**
 * `POST /speech/synthesis`：受理一次合成。
 * 调用方**必须**先过安全检查闸门（`speech-text.assertSpeakable`）；本层不代替闸门。
 * 受理成功后调用方应把响应交给 `rememberServerRevision`（采纳服务端回传的 revision）。
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
 * **如实回答"现在有没有可播放的音频源"**（不顶替、不猜测、不假装能播）。
 *
 * 逐项 fail-closed：
 *  - 任务不是 `succeeded` ⇒ 没有产物；
 *  - `stub`/`preset_demo` 的替身产物**不是音频**（服务端 `tts/provider.ts` 的明文标注占位
 *    `application/x-gengyun-tts-substitute`，替身端口与产物校验都拒绝 `audio/*`）⇒ 不可播放；
 *  - `real` 模式下契约**没有**面向客户端的音频出口（`POST /media/{id}/access` 只回句柄、
 *    `AccessGrant.url` 是部署期网关占位域、没有 owner 私有媒体字节读取 operation）
 *    ⇒ 同样取不到可播放来源。
 *
 * 因此本片在离线/替身与 real 未接线两种情形下**恒**得到 `SOURCE_UNAVAILABLE`；页面据此展示
 * `NO_CLIENT_AUDIO_EGRESS_NOTE`（如实说明契约缺口）与主动播放按钮，**不得**显示「播放中／已播放」、
 * **不得**伪造音频、**不得**记「已听取」。可播放路径的真实接线需先放开契约（属监制/用户裁定）。
 */
function audioSourceForJob(job, mode) {
  if (!object(job) || !one(job.state, JOB_STATES)) return { ok: false, code: 'SOURCE_UNAVAILABLE', reason: '任务状态无法核对。' }
  if (job.state !== 'succeeded' || job.result === null) {
    return { ok: false, code: 'SOURCE_UNAVAILABLE', reason: '合成任务未成功完成（state=' + job.state + '），没有可播放的产物。' }
  }
  if (mode !== 'real') {
    return {
      ok: false,
      code: 'SOURCE_UNAVAILABLE',
      reason: '当前为替身执行模式（' + String(mode) + '）：替身产物是明确标注的**非音频**占位，'
        + '不可播放；本页不用别的音频顶替、不假装能播。'
    }
  }
  return {
    ok: false,
    code: 'SOURCE_UNAVAILABLE',
    reason: '契约没有面向客户端的音频出口（没有私有媒体字节读取 operation，'
      + '`AccessGrant.url` 是部署期网关占位域）：真实合成产物也取不到可播放来源，本页如实报不可播。'
  }
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

/** 单次录音最长 60 秒 / 语音用途上限 10 MiB（契约 `UploadInput.duration_ms.maximum`、`voice_question` 限额）。 */
const RECORD_MAX_DURATION_MS = 60000
const VOICE_MAX_BYTES = 10 * 1048576

/**
 * 录音上传失败的**如实归因**文案（按契约错误码逐码给词，**不**把不同的 403 折叠成同一句话）。
 *
 * 红线（与仓库既有口径一致，见 `utils/identify-api.js` 的 `forbiddenOrSessionLoss` 注释）：
 *   - `503 PROVIDER_UNAVAILABLE` ⇒ 指向**真实对象存储未接线**，**不得**说成网络问题；
 *   - `403 CONSENT_REQUIRED`（缺用途授权）与 `403 SCOPE_DENIED`（会话无权）必须**各不相同**，
 *     且都**不得**写成"登录失效"（那会把用户指向错误原因，还会误清会话导致连"去授权"都做不了）；
 *   - 只有 `SESSION_REQUIRED` / `SESSION_EXPIRED` / `SESSION_CHANGED` 才是登录/会话类问题。
 */
const RECORD_UPLOAD_MESSAGES = Object.freeze({
  // 本地前置校验（未发出任何请求）
  INVALID_INPUT: '录音参数不合法（时长/编码/摘要缺失或超限）：本次未上传任何音频。',
  RECORDER_UNAVAILABLE: '当前环境不提供录音能力：不会采集、不会上传，也不假装在录。',
  RECORD_AUTH_DENIED: '麦克风授权被拒绝：本页没有开始录音，也没有上传任何音频。请在微信设置里授权「录音」后重试。',
  RECORD_PERMISSION_DENIED: '麦克风授权不可用：本页没有开始录音，也没有上传任何音频。',
  RECORD_FAILED: '录音未能完成（平台未返回可用产物）：本次未上传任何音频。',
  RECORD_INTERRUPTED: '录音被中断（来电／其它应用抢占／系统回收）：本次未上传任何音频，请重新录制。',
  RECORD_NOT_STARTED: '当前没有正在进行的录音。',
  RECORD_ALREADY_RUNNING: '已在录音中，请先停止再开始下一次。',
  // 会话 / 门禁
  SESSION_REQUIRED: '登录状态已失效，请重新登录后再录音上传。',
  SESSION_EXPIRED: '登录状态已过期，请重新登录后再录音上传。',
  SESSION_CHANGED: '会话已变化：本次上传已作废，请重新进入本页。',
  // 403：三类拒绝**各不相同**（不得都写成"登录失效"）
  SCOPE_DENIED: '当前会话无权使用该能力（403 SCOPE_DENIED）：本次未上传，请在具备该能力的账号下重试。',
  CONSENT_REQUIRED: '缺少用途授权（403 CONSENT_REQUIRED）：语音问答需要「录音 / 媒体处理 / 对外推理」授权，未授权时不会上传。',
  ACCOUNT_INACTIVE: '账号当前不可用（403 ACCOUNT_INACTIVE）：本次未上传。',
  // 400 / 413 / 415：用途与限制
  MEDIA_TOO_LARGE: '录音过大（语音问答单次 ≤10 MiB）：本次未上传，请缩短录制后重试。',
  MEDIA_TYPE_UNSUPPORTED: '录音编码不在契约允许范围（仅 MP3 / WAV / AAC）：本次未上传。',
  INVALID_REQUEST: '服务端按契约拒绝该录音（用途/时长/大小/类型不符）：本次未上传。',
  // 404 / 409 / 428 / 429
  NOT_FOUND: '媒体对象不存在或不可见（可能不属于当前账号）。',
  OBJECT_UNAVAILABLE: '媒体对象不可用：已如实拒绝，不伪造上传结果。',
  REVISION_CONFLICT: '媒体版本已变化：请重新录制后再上传。',
  REVISION_REQUIRED: '缺少媒体版本信息：请刷新后重试。',
  IDEMPOTENCY_KEY_REQUIRED: '请求缺少幂等键，请重试。',
  IDEMPOTENCY_CONFLICT: '同一幂等键被复用于不同请求，请重试。',
  RATE_LIMITED: '请求过于频繁，请稍后重试。',
  PROVIDER_QUOTA_EXCEEDED: '提供者配额不足：本次未上传。',
  // 503 / 504：**真实对象存储未接线**（不得说成网络问题）
  PROVIDER_UNAVAILABLE: '真实对象存储未接线（503 PROVIDER_UNAVAILABLE）：录音已录到本机，但服务端没有可写入的对象存储，本次未上传成功。',
  PROVIDER_OUTCOME_UNKNOWN: '提供者结果未知（503 PROVIDER_OUTCOME_UNKNOWN）：上传结果无法确认，已如实停止，不记为成功。',
  PROVIDER_TIMEOUT: '提供者超时（504 PROVIDER_TIMEOUT）：上传未完成，不记为成功。',
  // 通道与响应
  MEDIA_CHANNEL_UNAVAILABLE: '私有媒体上传通道不可用（未取到契约封套的 error.code）：本次未上传成功，也不伪造 media_id。',
  INVALID_RESPONSE: '服务端响应无法核对：已停止，不伪造上传结果。',
  NETWORK_UNCERTAIN: '网络未能确认结果：已停止，请重试。',
  UNAVAILABLE: '媒体上传暂不可用：已停止，请重试。'
})

/** 录音上传失败的逐码文案；未收录一律给中性兜底（不发明原因）。 */
function recordUploadMessageFor(error) {
  const code = error && error.code
  const text = RECORD_UPLOAD_MESSAGES[code]
  return typeof text === 'string' ? text : '录音上传未成功（未收录的错误码：' + String(code) + '）：已停止，不记为成功。'
}

/**
 * 错误码 → 页面可展示的一句话（不改变判定，只做措辞；未收录一律给出中性兜底）。
 */
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
  NO_CLIENT_AUDIO_EGRESS_NOTE: NO_CLIENT_AUDIO_EGRESS_NOTE,
  EXIT_CANCELLATION_NOTE: EXIT_CANCELLATION_NOTE,
  RECORD_MAX_DURATION_MS: RECORD_MAX_DURATION_MS,
  VOICE_MAX_BYTES: VOICE_MAX_BYTES,
  RECORD_UPLOAD_MESSAGES: RECORD_UPLOAD_MESSAGES,
  recordUploadMessageFor: recordUploadMessageFor,
  substituteSamplesEnabled: substituteSamplesEnabled,
  validateCheckedContentRef: validateCheckedContentRef,
  validateJob: validateJob,
  checkedContentRefForSample: checkedContentRefForSample,
  rememberServerRevision: rememberServerRevision,
  forgetServerRevisions: forgetServerRevisions,
  serverRevisionFor: function (ref) {
    const remembered = object(ref) ? serverRevisions[targetKeyOf(ref)] : undefined
    return integer(remembered, 1) ? remembered : null
  },
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
