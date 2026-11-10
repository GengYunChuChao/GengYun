// GY-I13 合成（普通话 TTS）HTTP 消费层（原生小程序侧）。
//
// 契约面（packages/contracts/openapi.json 1.0.0，**只用既有 operation，不自造路径**）：
//   createSynthesis    POST /speech/synthesis                 → 202 JobEnvelope（`Idempotency-Key` 必填 8..128）
//   getJob             GET  /jobs/{id}                        → 200 JobEnvelope（读 JobState 的唯一契约面）
//   readSynthesisAudio GET  /speech/synthesis/{id}/audio      → 200 二进制音频（R74 新增的私有读面）
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
// 4) **不产生、不顶替音频**：`audioSourceForJob()` 只如实回答"现在有没有可取的音频读面地址"；
//    替身产物不是音频、真实凭据/产物存储未接线时也没有字节 ⇒ `ok:false` 且带**具体**原因，
//    **不得**用别的音频顶替、**不得**假装能播；页面口径见 `NO_PLAYABLE_AUDIO_NOTE`。
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
 * **页面必须原样展示的如实口径**（服务端事实；既不是网络问题，也不是临时故障）。
 *
 * R74 起服务端已有面向客户端的**音频读面**：`GET /api/v1/speech/synthesis/{id}/audio`
 * （operation `readSynthesisAudio`，装配在 `services/api/src/routes/synthesis.ts`）——只读**本人**的
 * 合成产物，按产物**真实** `content-type` 原样下发音节。但「有读面」不等于「一定有声音」：
 *  - 替身执行模式（`stub`/`preset_demo`）的产物是明确标注的**非音频**占位
 *    （`application/x-gengyun-tts-substitute`，见 `services/api/src/tts/provider.ts`）⇒ 读面 409 拒绝，
 *    ⛔ 绝不把非音频字节标成 `audio/*`；
 *  - `real` 模式下若真实 TTS 凭据、产物存储批准（`--approve-real-media-wiring`）或对象键任一缺失，
 *    受理面就 503、或读面 409 —— 作业根本走不到「有声音」。
 * ⇒ 取不到可播源时页面必须给出**具体原因**，不得显示「播放中／已播放」、不得伪造音频、
 * 不得用别的音频顶替、不得记「已听取」。
 */
const NO_PLAYABLE_AUDIO_NOTE = '本环境暂无可播放音频（服务端没给出可取的音频字节）：'
  + '音频读面只回本人真实合成的产物——替身产物是明确标注的非音频占位，真实凭据/产物存储未接线或产物已清理时也没有字节；'
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

/**
 * 401/403 归因：**不得把 403 折叠成 401**（本文件既有的措辞红线，此前传输层违反）。
 *
 * 为什么不能折叠：`CONSENT_REQUIRED` 指向「缺授权」、`SCOPE_DENIED` 指向「换账号/换能力」、
 * `ACCOUNT_INACTIVE` 指向「账号不可用」，而 `SESSION_REQUIRED` 指向「重新登录」——折叠成后者
 * 会把用户推进「反复登录却仍然失败」的死循环；更糟的是折叠时还会 `auth.clearSession()`，
 * 把仍然有效的会话一起清掉（403 并不代表会话失效）。
 *
 * 归因实现**不在本文件**：统一由 `miniprogram/utils/auth.js` 的 `attribution` / `failureFor` 决定
 * （`SESSION_LOSS_CODES` / `FORBIDDEN_CODES` 由 `utils/states.js` 的 `CODE_KIND` 反推）。
 * 合流前本文件、`identify-api`、`speech-transcript`、`favorites-api`/`history-api` 各有一份同形实现，
 * 口径互相漂移过，已全部删除。裁决口径见 `docs/verification/gy-i04-login-chain-20261021.md` §1.3。
 */

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
        if (response.statusCode === 401 || response.statusCode === 403) { reject(auth.failureFor(failure, response.statusCode, response.data)); return }
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
 * **如实回答"现在有没有可播源"**（不顶替、不猜测、不预先声称"一定有声"）。
 *
 * 只有**同时**成立才给 `{ok:true, url}`：
 *  - 任务 `succeeded` 且带 `result`（`id`/`media_id` 只在这里；`job.result` 在受理响应里恒 null；
 *  - 回执里的 `id`/`media_id` 是合法 uuid（不拿来路不明的值去拼地址）；
 *  - 服务端执行模式是 `real`（`meta.execution_mode`）：替身产物是明确标注的**非音频**占位
 *    （`application/x-gengyun-tts-substitute`），读面必然 409，本层就不该说它可播；
 *  - 运行时有 http(s) `apiBaseUrl`（否则连地址都拼不出来）。
 *
 * 服务端判定在**取字节那一刻**（`GET /api/v1/speech/synthesis/{id}/audio`，operation
 * `readSynthesisAudio`）：200 且 `content-type: audio/*` 才是真音频；非 `audio/*`/替身/已清理/
 * 存储未接线一律 409。因此本层给的是「有读面地址可试」，取回失败时由播放端口把服务端的具体
 * 拒绝原因交给页面（`miniprogram/utils/inner-audio-port.js` 的下载失败映射），**不伪造音频**、
 * 不记「已听取」、不用别的音频顶替。
 *
 * 每个 `ok:false` 都带**具体** `reason` 与分类 `code`（`JOB_NOT_SUCCEEDED`/`NO_ARTIFACT`/
 * `SUBSTITUTE_ARTIFACT`/`NO_ENDPOINT`/`INVALID_INPUT`），不再退回空泛的"无可播放音频"。
 */
function audioSourceForJob(job, mode) {
  if (!object(job) || !one(job.state, JOB_STATES)) {
    return { ok: false, code: 'INVALID_INPUT', reason: '任务对象形状无法核对（state 不在契约闭集）：不敢判断有没有产物。' }
  }
  if (job.state !== 'succeeded') {
    return { ok: false, code: 'JOB_NOT_SUCCEEDED', reason: '合成任务未成功完成（state=' + String(job.state) + '），没有产物可取。' }
  }
  if (!object(job.result)) {
    return { ok: false, code: 'NO_ARTIFACT', reason: '任务已成功但回执里没有产物（result 为空）：服务端没有登记可取回的合成记录与 media_id。' }
  }
  // `validateJob` 把契约 `result: {kind, value}` **归一化**成 `{id, revision, media_id}`
  // （见 `validateJob` 的返回式）；直接传原始契约回执的调用方则带 `result.value`。两种形状同源，
  // 这里都按同一判据取值，**不猜测**、不从别的字段拼 id。
  const value = object(job.result.value) ? job.result.value : job.result
  if (!uuid(value.id)) {
    return { ok: false, code: 'NO_ARTIFACT', reason: '回执里的合成记录 id 不是合法 uuid（' + String(value.id) + '）：拼不出音频读面地址。' }
  }
  if (!uuid(value.media_id)) {
    return { ok: false, code: 'NO_ARTIFACT', reason: '回执里的 media_id 不是合法 uuid（' + String(value.media_id) + '）：不拿它去取音频。' }
  }
  if (mode !== 'real') {
    return {
      ok: false,
      code: 'SUBSTITUTE_ARTIFACT',
      reason: '当前执行模式是 ' + String(mode) + '（不是 real）：替身产物是明确标注的**非音频**占位'
        + '（application/x-gengyun-tts-substitute），服务端读面会以 409 拒绝，本页不用别的音频顶替。'
    }
  }
  const base = audioOriginPrefix()
  if (!/^https?:\/\//.test(base)) {
    return {
      ok: false,
      code: 'NO_ENDPOINT',
      reason: '运行时没有配置后端地址（apiBaseUrl=' + (base === '' ? '空' : String(base)) + '）：拼不出音频读面地址。'
    }
  }
  return { ok: true, url: base + '/speech/synthesis/' + value.id + '/audio', label: '真实音频' }
}

/**
 * 取音频时用的 `Authorization` 头（音频读面是私有资源，必须带会话）。
 *
 * 为什么单独导出：`wx.createInnerAudioContext` **不能**带自定义头，真实播放要先
 * `wx.downloadFile({ header })` 把字节下到临时文件再交给播放器（见
 * `miniprogram/utils/inner-audio-port.js`）。这里只回当前会话的令牌，未登录 ⇒ `null`。
 */
function audioAuthorizationHeader() {
  const bound = binding()
  return bound ? 'Bearer ' + bound.token : null
}

/**
 * 音频读面所在的后端域前缀（`runtime.apiBaseUrl`，形如 `https://api.example.com/api/v1`）。
 *
 * 播放端口用它做**域校验**：只有前缀匹配的地址才附 `Authorization` 去下载——绝不把会话令牌
 * 发给第三方域。未配置时返回空串（端口据此直连，不附头）。
 */
function audioOriginPrefix() {
  return typeof runtime.apiBaseUrl === 'string' ? runtime.apiBaseUrl : ''
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
 * ASR 档位要求的录音容器（**唯一事实源**：`services/api/src/ai/asr-live-adapter.ts` 的
 * `LIVE_ASR_FROZEN_PROFILE` 与 `tools/ai-config.mjs` 的 asr 剖面 —— `voiceFormat:'wav'`、
 * 16000Hz、单声道、16bit PCM、≤60s、base64 后 ≤3145728 字节）。
 *
 * 客户端**只上传这一种容器**：平台若不按请求回 WAV，就在客户端**就地如实失败**（不上传）。
 * 为什么必须在这一层拦住：转写档位非 WAV 会在**服务端本地**被拒（零发包），作业落 `failed`
 * 且**不写**转写行 ⇒ `GET /speech/transcriptions/{id}` 只会 404，用户永远看不到"请上传 WAV"。
 */
const ASR_RECORD_FORMAT = 'wav'
const ASR_RECORD_MIME = 'audio/wav'

/**
 * 端口回报的录音产物是否**就是** ASR 档位要求的那一种容器。
 *
 * `format` 与 `mime` 都必须对上：`format` 缺失/空串（平台没回传）、或 mime 与容器不一致，
 * 一律判"不是"（宁可如实失败，也不把非 WAV 说成 WAV 上传）。
 */
function isAsrWavRecording(product) {
  if (product === null || typeof product !== 'object') return false
  return product.format === ASR_RECORD_FORMAT && product.mime === ASR_RECORD_MIME
}

/** 非 WAV 产物的如实说明：先写**实际拿到的是什么**（format/mime 之一缺失也照实说），再接按码文案。 */
function recordFormatMessageFor(product) {
  const raw = product !== null && typeof product === 'object' ? product : {}
  const said = (value) => (typeof value === 'string' && value !== '' ? value : '（平台未回传）')
  return '本次录音的类型是 ' + said(raw.format) + ' / ' + said(raw.mime) + '，'
    + RECORD_UPLOAD_MESSAGES.RECORD_FORMAT_NOT_WAV
}

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
  // 本地收尾校验：容器必须与冻结 ASR 档位一致（非 WAV 一律不上传）
  RECORD_FORMAT_NOT_WAV: '录音编码不是 ASR 要求的 WAV（16kHz / 单声道 / 16bit PCM WAV，服务端只收这一种容器）：'
    + '本条没有上传任何音频（不裁剪、不转码，也不把非 WAV 谎报成 WAV），请重新录制。',
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
  NO_PLAYABLE_AUDIO_NOTE: NO_PLAYABLE_AUDIO_NOTE,
  EXIT_CANCELLATION_NOTE: EXIT_CANCELLATION_NOTE,
  RECORD_MAX_DURATION_MS: RECORD_MAX_DURATION_MS,
  VOICE_MAX_BYTES: VOICE_MAX_BYTES,
  ASR_RECORD_FORMAT: ASR_RECORD_FORMAT,
  ASR_RECORD_MIME: ASR_RECORD_MIME,
  isAsrWavRecording: isAsrWavRecording,
  recordFormatMessageFor: recordFormatMessageFor,
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
  audioAuthorizationHeader: audioAuthorizationHeader,
  audioOriginPrefix: audioOriginPrefix,
  describeJob: describeJob,
  cancelAll: cancelAll,
  inFlightEpoch: function () { return inFlight.epoch },
  newKey: newKey,
  messageFor: messageFor,
  validId: uuid
}

/* ---------------------------------------------------------------- 可播报资料 */

/**
 * **「可播报资料」**：本地演示形态下把**真实、可合成**的短资料列出来。
 *
 * 与 `SUBSTITUTE_SPEAK_SAMPLES`（替身样本）是**两类东西**：页面上分组、命名都不混用 sample。
 *
 * 为什么需要它（实测，不是猜测）：替身样本的 `targetRef.id` 是夹具名（`sample-i13-passed`），
 * 不是 uuid；而本地演示栈是 `execution_mode=real`，服务端已核对内容端口按 uuid 读库
 * （`services/api/src/ai/checked-content-live-adapter.ts` 的 `readCheckedContent`：非 uuid 直接
 * 返回 null），因此点「合成」必然 `TARGET_NOT_FOUND` —— 真人一步也走不到真实语音。
 *
 * 数据源刻意**只用既有公开读面**（`GET /api/v1/knowledge`，既有 operation）：不新增端点、
 * 不改服务端。返回条目正好带 `SynthesisTarget` 要的三键（uuid 的 `id`、`type`、服务端给的
 * `revision`），正文也正好是服务端核对同一行时拼的 `title.trim() + '\n' + body`
 * （`knowledgeTextFromRow`）——不是页面自己编的第二份正文。
 *
 * 上限与供应商同值：`services/api/src/tts/provider.ts:253` 的 `maxTextCharacters: 100`（按码点）。
 * 超上限的条目不列出、**不截断**（服务端 `requireLiveTtsText` 同样 fail-closed 不截断）：
 * 列出来只会让人点到一个必然失败的按钮。
 */
const BROADCAST_TEXT_MAX_CODE_POINTS = 100
const BROADCAST_LIST_LIMIT = 50
const BROADCAST_GROUP = 'knowledge'
const BROADCAST_LABEL_PREFIX = '可播报资料'
const BROADCAST_ID_PREFIX = 'knowledge:'

function broadcastCodePointLength(value) {
  return [...String(value)].length
}

/** 服务端核对同一行时用的正文（`title.trim() + '\n' + body`）；页面不得另行改写。 */
function broadcastTextOf(item) {
  return String(item.title).trim() + '\n' + String(item.body)
}

/** 形状核对：只认能被 `SynthesisTarget` 三键接住的条目；不对就跳过（不猜、不补）。 */
function isBroadcastableItem(item) {
  return object(item) &&
    uuid(item.id) &&
    one(item.type, SYNTHESIS_TARGET_TYPES) &&
    integer(item.revision, 1) &&
    typeof item.title === 'string' && item.title.length > 0 &&
    typeof item.body === 'string' && item.body.length > 0
}

/** 读面条目 → 页面条目（字段名与替身样本一致，因此复用同一条核对/合成链路）。 */
function broadcastTargetOf(item) {
  const body = broadcastTextOf(item)
  return {
    id: BROADCAST_ID_PREFIX + item.id,
    group: BROADCAST_GROUP,
    label: BROADCAST_LABEL_PREFIX + ' · ' + item.title + '（' + broadcastCodePointLength(body) + ' 码点）',
    checkState: 'passed',
    checkedText: body,
    targetRef: { type: item.type, id: item.id, revision: item.revision }
  }
}

/**
 * 读「可播报资料」（`GET /knowledge?limit=50`；既有只读读面，`guards.requireUser`）。
 *
 * 失败**不吞**：`request` 把 401/403 交给 `auth.failureFor`（保留 `SCOPE_DENIED` / `CONSENT_REQUIRED` /
 * `ACCOUNT_INACTIVE` 各自的原因）、其它非 200 保留服务端 `error.code` 与 HTTP 状态，由页面
 * `broadcastFailureNote` 原样透出；响应形状不合契约则 `INVALID_RESPONSE`（不伪造列表）。
 */
async function listBroadcastTargets() {
  const response = await request('GET', '/knowledge?limit=' + BROADCAST_LIST_LIMIT, {})
  if (!object(response.data) || !Array.isArray(response.data.items)) throw failure('INVALID_RESPONSE')
  const items = response.data.items
  const targets = []
  let tooLong = 0
  for (const item of items) {
    if (!isBroadcastableItem(item)) continue
    if (broadcastCodePointLength(broadcastTextOf(item)) > BROADCAST_TEXT_MAX_CODE_POINTS) { tooLong += 1; continue }
    targets.push(broadcastTargetOf(item))
  }
  return { mode: response.mode, targets: targets, read: items.length, tooLong: tooLong }
}

/** 列表口径的**如实**说明（来源、条数、上限；没有短资料时直说没有）。 */
function broadcastNoteFor(result) {
  const targets = object(result) && Array.isArray(result.targets) ? result.targets : []
  const read = object(result) && integer(result.read, 0) ? result.read : targets.length
  const tooLong = object(result) && integer(result.tooLong, 0) ? result.tooLong : 0
  if (targets.length === 0) {
    return '可播报资料（真实资料，不是替身样本）：读面返回 ' + String(read) + ' 条，其中 '
      + String(tooLong) + ' 条超过 ' + String(BROADCAST_TEXT_MAX_CODE_POINTS)
      + ' 码点上限（服务端不截断，故不列出）；当前没有可播报的短资料。'
  }
  return '可播报资料（真实资料，不是替身样本）：取自本机演示后端的公开读面 GET /api/v1/knowledge，'
    + '服务端已审核发布、且正文 ≤ ' + String(BROADCAST_TEXT_MAX_CODE_POINTS) + ' 码点的共 '
    + String(targets.length) + ' 条'
    + (tooLong > 0 ? '；另有 ' + String(tooLong) + ' 条超上限未列出（服务端 fail-closed 不截断）' : '')
    + '。选中后点「合成」走本页既有的核对与合成链路。'
}

const BROADCAST_READ_MESSAGES = {
  SESSION_REQUIRED: '登录状态已失效：请重新登录后再打开可播报资料。',
  SESSION_CHANGED: '会话已变化：请重新进入本页。',
  SCOPE_DENIED: '当前会话无权读取资料（403 SCOPE_DENIED）',
  CONSENT_REQUIRED: '缺少用途授权（403 CONSENT_REQUIRED）',
  ACCOUNT_INACTIVE: '账号当前不可用（403 ACCOUNT_INACTIVE）',
  RATE_LIMITED: '请求过于频繁（429 RATE_LIMITED）',
  NOT_FOUND: '资料读面不存在或不可见（404）',
  UNAVAILABLE: '资料读面暂不可用（服务端非 200）',
  NETWORK_UNCERTAIN: '网络未能确认结果',
  INVALID_RESPONSE: '服务端响应无法核对',
  CLIENT_CANCELLED: '已离开本页，在途请求已作废'
}

/** 读取失败 → 页面可展示的一行（保留服务端 `error.code` 与 HTTP 状态，不吞、不改写）。 */
function broadcastFailureNote(error) {
  const code = error && error.code
  const sentence = BROADCAST_READ_MESSAGES[code] || ('资料读面返回未收录的错误（' + String(code) + '）')
  const status = error && integer(error.status, 100) ? '，HTTP ' + String(error.status) : ''
  return '可播报资料读取失败：' + sentence + '（' + String(code) + status + '）。'
}

// 文件尾追加（不插行）：新增读面的入口挂在既有导出上。
module.exports.BROADCAST_TEXT_MAX_CODE_POINTS = BROADCAST_TEXT_MAX_CODE_POINTS
module.exports.BROADCAST_GROUP = BROADCAST_GROUP
module.exports.listBroadcastTargets = listBroadcastTargets
module.exports.broadcastNoteFor = broadcastNoteFor
module.exports.broadcastFailureNote = broadcastFailureNote
