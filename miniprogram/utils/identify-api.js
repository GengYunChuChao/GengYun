// GY-I09 识别任务 HTTP 消费层（原生小程序侧）。
//
// 契约面（packages/contracts/openapi.json 1.0.0）：
//   createRecognition  POST   /recognitions                     → 202 JobEnvelope
//   getRecognition     GET    /recognitions/{id}                → RecognitionEnvelope
//   selectSpecies      PATCH  /recognitions/{id}/selection      → RecognitionEnvelope
//   deleteRecognition  DELETE /recognitions/{id}                → 202 AckEnvelope
//   getJob             GET    /jobs/{id}                        → JobEnvelope（JobState 唯一可读面）
//   cancelJob          POST   /jobs/{id}/cancel                 → JobEnvelope
//   createUpload       POST   /media/uploads                    → 201 UploadGrantEnvelope（real 照片链路）
//
// GY-I10 标签 OCR（#10，本片追加；**只复用既有 operation，不新增契约**）：
//   createOcr          POST   /ocr                              → 202 JobEnvelope（kind=ocr）
//   getOcrJob          GET    /jobs/{id}                        → JobEnvelope（kind=ocr；七类 JobState 唯一可读面）
//   cancelOcrJob       POST   /jobs/{id}/cancel                 → JobEnvelope（**本基线 OCR 域无取消能力**
//                                                               ⇒ 服务端如实 503 PROVIDER_UNAVAILABLE(retryable)，
//                                                                 与「作业不存在」的 404 必须区分）
//   标签正文读面 `GET /ocr/{id}` 已由 `utils/history-api.js` 的 `getOcr`/`ocrDetailView` 消费（本片**复用**，
//   不重造第二套 OCR 校验，也不在该读面上渲染任何用量数字）。
//
// 硬口径：
// 1) **只有 succeeded 才算识别成功**。uncertain / failed / timed_out / cancelled 一律不得
//    被渲染成「识别成功」的 Top3，也不得自动进入关联科普查询路径（见 viewModelForJob）。
// 2) 无网络 / 未登录 / 门禁拒绝 / 响应形状异常 → 如实报不可用，**绝不**伪造识别结果或本地兜底。
// 3) 响应逐字段校验（先判 typeof 再判值）；undefined 不会被宽松放过。
const auth = require('./auth')
const runtime = require('../config/runtime')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTRACT_VERSION = '1.0.0'
const EXECUTION_MODES = ['real', 'stub', 'preset_demo']
const MAX_CANDIDATES = 3
const MEDIA_STATES = ['initiated', 'uploaded', 'processing', 'ready', 'rejected', 'deleting', 'deleted']
const MEDIA_PURPOSE = 'weed_recognition'

/** 会话失效类错误码（401/403 归因与页面门禁关闭共用同一闭集）。 */
const SESSION_LOSS_CODES = ['SESSION_REQUIRED', 'SESSION_CHANGED', 'SESSION_EXPIRED']

/** 本客户端允许经私有媒体链路上传的**图片**用途（契约 `MediaPurpose` 的图片成员）。 */
const IMAGE_MEDIA_PURPOSES = ['weed_recognition', 'label_ocr']

/** 标签 OCR 任务的媒体用途（#10）：与识别图**同限额**（≤2 MiB；仅 jpeg/png/webp）。 */
const OCR_MEDIA_PURPOSE = 'label_ocr'

/** 语音问答（#11）的媒体用途：契约 `MediaPurpose` 的**音频**成员，与图片用途同链路。 */
const VOICE_MEDIA_PURPOSE = 'voice_question'

/** 契约音频用途允许的真实编码（`UploadInput.mime` 的音频子集；不信扩展名）。 */
const AUDIO_MEDIA_MIMES = ['audio/mpeg', 'audio/wav', 'audio/aac']

/** 单次录音时长上限（`UploadInput.duration_ms.maximum = 60000`，与 `MEDIA_MAX_DURATION_MS` 同值）。 */
const MEDIA_MAX_DURATION_MS = 60000

/** 语音用途字节上限（契约 `voice_question` ≤10 MiB，= 全局上限 `UploadInput.bytes.maximum`）。 */
const VOICE_MAX_BYTES = 10 * 1048576

/** 语音用途的**唯一**文案（录音不符合用途限制时的如实提示）。 */
const VOICE_USE_LIMIT_TEXT = '录音不符合用途限制（语音问答 ≤10 MiB / ≤60 秒 / 仅 MP3·WAV·AAC），请重新录制。'

/**
 * 媒体上传链路上**服务端可能如实返回**的契约错误码闭集。
 *
 * 与 `packages/media/constants.mjs` 的 `ERROR_STATUS_MAP` 同源（HTTP 状态 ↔ 错误码一一对应），
 * 但不含「与 HTTP 状态一起表达」的会话类码（401/403 由上传链路先按会话失效处理）。
 * 闭集内的码**原样上抛**，由 `messageFor` 如实呈现；闭集外的取值一律折叠为
 * `MEDIA_CHANNEL_UNAVAILABLE`（不把未知码当契约事实透出，见 `uploadPrivatePhoto`）。
 */
const MEDIA_UPLOAD_ERROR_CODES = [
  // 400 / 413 / 415 / 428：照片声明或字节不符用途限制
  'INVALID_REQUEST', 'IDEMPOTENCY_KEY_REQUIRED', 'MEDIA_TOO_LARGE', 'MEDIA_TYPE_UNSUPPORTED', 'REVISION_REQUIRED',
  // 404 / 409：对象与版本
  'NOT_FOUND', 'OBJECT_UNAVAILABLE', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT',
  // 429 / 503 / 504：提供者与对象存储
  'PROVIDER_UNAVAILABLE', 'PROVIDER_QUOTA_EXCEEDED', 'PROVIDER_OUTCOME_UNKNOWN', 'PROVIDER_TIMEOUT',
  // 契约 `ErrorCode` 闭集内的「输入不确定」类（本链路未变更其语义，仅如实传递）
  'INPUT_UNCERTAIN'
]

/** 照片是否符合用途限制的**唯一**文案（识别图 ≤2 MiB / 仅 JPG·PNG·WebP）。 */
const MEDIA_USE_LIMIT_TEXT = '照片不符合用途限制（识别图 ≤2 MiB / 仅 JPG·PNG·WebP），请重新拍照或换一张。'

/**
 * 七类 JobState 的**逐类**呈现口径（契约 enum，一类一句，不得合并成一句「失败」）。
 * success=true 仅且仅当 state===succeeded；component 为 state-view 组件的状态名。
 */
const JOB_STATE_VIEWS = {
  queued: { state: 'queued', tone: 'pending', component: 'loading', title: '已受理，排队中', desc: '任务已建立，尚未开始识别。', terminal: false, success: false, retryable: false },
  running: { state: 'running', tone: 'pending', component: 'loading', title: '识别中', desc: '正在识别，请稍候。', terminal: false, success: false, retryable: false },
  succeeded: { state: 'succeeded', tone: 'success', component: 'ready', title: '识别完成', desc: '以下候选由识别模型给出，请自行核对后再选用。', terminal: true, success: true, retryable: false },
  uncertain: { state: 'uncertain', tone: 'warning', component: 'error', title: '结果不确定（不可信）', desc: '模型没有给出可信分数或自述不确定。候选仅供参考，需人工核对或重拍，不算识别成功。', terminal: true, success: false, retryable: true },
  failed: { state: 'failed', tone: 'error', component: 'error', title: '识别失败', desc: '识别服务未能完成任务。可重试或重拍；本页不会给出任何候选。', terminal: true, success: false, retryable: true },
  timed_out: { state: 'timed_out', tone: 'error', component: 'error', title: '识别超时', desc: '超过任务截止时间仍未完成。可重试或重拍；本页不会给出任何候选。', terminal: true, success: false, retryable: true },
  cancelled: { state: 'cancelled', tone: 'muted', component: 'cancelled', title: '已取消', desc: '任务已被取消，不会再有结果。', terminal: true, success: false, retryable: true }
}

const JOB_STATES = Object.keys(JOB_STATE_VIEWS)

// ---------------------------------------------------------------------------
// GY-I08 规则版本 / 条件口径 / 六类失败分支的**跨端镜像**
//
// 唯一事实来源是 `packages/reference`（规则版本与阻断类别）与
// `services/api/src/recognitions/{linkage,branches}.ts`（本片的选择后关联与六类分支闭集）。
// 小程序无法 import 服务端 TS 模块，因此按仓库既有做法（同 `reference.js` 镜像 GY-I08）
// 在这里镜像一份，并由 `tests/unit/miniprogram-identify.test.mjs` **逐项断言两端一致**
// —— 任何一端漂移都会让回归失败，而不是静默产生两套口径。
// ---------------------------------------------------------------------------

/** GY-I08 规则版本（与域库 `APPLICABILITY_RULE_VERSION` 同值）。 */
const APPLICABILITY_RULE_VERSION = 'gy-i08/1.2.0'

/** 契约 `DoseConditions` 的 6 个必填字段（顺序即契约字段顺序）。 */
const DOSE_CONDITION_FIELDS = ['crop_id', 'region_code', 'species_id', 'growth_stage', 'planting_method', 'use_scene']

/** 浙江地区码形状（契约 `Conditions.region_code` 的 pattern）。 */
const REGION_CODE_PATTERN = /^33[0-9]{4}$/

/**
 * 识别/选择路径的**恒定**用量阻断类别（GY-I08 闭集成员 `no_dose_source`）。
 * 与 `services/api/src/recognitions/linkage.ts` 的 `DOSE_PATH_BLOCK_CODE` 同值：
 * 这条路径**没有**经 GY-I08 授权的用量来源，因此任何条件下都不得展示用量。
 */
const DOSE_PATH_BLOCK_CODE = 'no_dose_source'

/**
 * 六类失败/边界分支（与 `branches.ts` 的 `FAILURE_BRANCHES` 同闭集、同顺序）。
 * 小程序侧只按契约可见信息（`state` / `error_code` / `uncertainty_reasons`）归类。
 */
const FAILURE_BRANCHES = ['uncertain', 'out_of_coverage_or_low_quality', 'permission_denied', 'no_result', 'timeout', 'reshoot_required']

/**
 * 六类分支的呈现与重试语义（镜像 `branches.ts` 的 `BRANCH_DESCRIPTORS`）。
 *
 * `jobState` 为 `null` = **受理前**拦截（权限拒绝），不存在任务；
 * `retryable` 为 false 时页面**不得**给出重试入口。
 */
const BRANCH_GUIDE = {
  uncertain: {
    branch: 'uncertain',
    label: '结果不确定：候选仅供参考，需人工核对',
    jobState: 'uncertain',
    errorCode: null,
    retryable: true,
    retryAction: 'new_task',
    reason: null
  },
  out_of_coverage_or_low_quality: {
    branch: 'out_of_coverage_or_low_quality',
    label: '该对象不在覆盖范围内，或照片质量不足无法判定',
    jobState: 'uncertain',
    errorCode: null,
    retryable: true,
    retryAction: 'reshoot',
    reason: '拍摄对象不在当前覆盖范围内'
  },
  permission_denied: {
    branch: 'permission_denied',
    label: '尚未获得该用途的授权，或会话已失效',
    jobState: null,
    errorCode: 'CONSENT_REQUIRED',
    retryable: true,
    retryAction: 'grant_consent',
    reason: null
  },
  no_result: {
    branch: 'no_result',
    label: '本次未取得任何候选',
    jobState: 'uncertain',
    errorCode: null,
    retryable: true,
    retryAction: 'reshoot',
    reason: null
  },
  timeout: {
    branch: 'timeout',
    label: '识别超时：超过任务截止时间仍未完成',
    jobState: 'timed_out',
    errorCode: 'PROVIDER_TIMEOUT',
    retryable: true,
    retryAction: 'new_task',
    reason: null
  },
  reshoot_required: {
    branch: 'reshoot_required',
    label: '需要重新拍摄后才能继续',
    jobState: 'uncertain',
    errorCode: null,
    retryable: true,
    retryAction: 'reshoot',
    reason: '拍摄条件不合格，建议重新拍摄'
  }
}

/** 覆盖外·低质量的两个细分如实原因（与 `branches.ts` 的 `COVERAGE_REASONS` 同文本）。 */
const COVERAGE_REASON_OUT_OF_SCOPE = '拍摄对象不在当前覆盖范围内'
const COVERAGE_REASON_LOW_QUALITY = '照片模糊/遮挡/光照不足，无法可靠判定'
const COVERAGE_REASON_RESHOOT = '拍摄条件不合格，建议重新拍摄'

/** 重试动作 → 页面按钮文案（页面只按动作渲染，不自己拼语义）。 */
const RETRY_ACTION_LABELS = {
  reshoot: '重新拍摄',
  new_task: '重新识别',
  grant_consent: '去授权',
  reauthenticate: '重新登录'
}

function failure(code) { const e = new Error(code); e.code = code; return e }
function object(x) { return !!x && typeof x === 'object' && !Array.isArray(x) }
function keys(x, required, optional) {
  if (!object(x) || required.some(k => !Object.prototype.hasOwnProperty.call(x, k)) ||
      Object.keys(x).some(k => required.concat(optional || []).indexOf(k) === -1)) throw failure('INVALID_RESPONSE')
}
function text(x, max) { return typeof x === 'string' && x.length > 0 && x.length <= max }
function one(x, values) { return values.indexOf(x) !== -1 }
function integer(x, min) { return typeof x === 'number' && Number.isInteger(x) && x >= min }
function timestamp(value) {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 &&
    Number(m[3]) <= new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate() && Number.isFinite(Date.parse(value))
}

/**
 * 非成功响应里**如实读出**契约封套 `error.code`（形状同 `services/api/src/errors.ts` 的 ErrorEnvelope）。
 *
 * 读不到、非字符串、或不在媒体域闭集内 ⇒ 返回 null（调用方据此回落到"通道不可用"这一如实表述），
 * **不发明**错误码、也不把未知字符串当契约事实透出给用户。
 */
function envelopeErrorCode(payload) {
  if (!object(payload) || !object(payload.error) || typeof payload.error.code !== 'string') return null
  return MEDIA_UPLOAD_ERROR_CODES.indexOf(payload.error.code) === -1 ? null : payload.error.code
}

/**
 * 由**非成功响应**构造上传失败错误：优先取契约封套的 `error.code` 如实归因；
 * 取不到（或非闭集）才回落到 `fallback`（"通道不可用"）。
 *
 * 这样 `POST /media/uploads` 的 503 PROVIDER_UNAVAILABLE（服务端真实对象存储未接线）
 * 与 400/413/415（照片不符合用途限制）不再被一律说成同一种原因。
 */
function uploadFailureOf(statusCode, payload, fallback) {
  const code = envelopeErrorCode(payload)
  const e = failure(code === null ? fallback : code)
  e.status = statusCode
  return e
}

/**
 * 401/403 的**如实**归因。
 *
 * 401 一律按会话失效处理；403 则要看契约封套：它可能是 `SCOPE_DENIED` / `CONSENT_REQUIRED` /
 * `ACCOUNT_INACTIVE` 这类**与授权有关**的拒绝（会话本身可能仍然有效），把它们一律说成
 * "登录状态已失效，请重新登录"是把用户指向错误原因（且会误清会话，导致连"去授权"都做不了）。
 * 封套读不到、或给出会话类码 ⇒ 仍按 `SESSION_REQUIRED`（并清会话）——**不放宽**任何守卫。
 *
 * 非会话类码**原样带出**（由 `messageFor`/`ocrMessageFor` 的措辞表如实呈现，不发明文案）。
 */
function errorCodeOf(payload) {
  if (!object(payload) || !object(payload.error) || typeof payload.error.code !== 'string') return null
  return text(payload.error.code, 80) ? payload.error.code : null
}

function forbiddenOrSessionLoss(statusCode, payload) {
  const code = errorCodeOf(payload)
  const surface = statusCode === 403 && code !== null && SESSION_LOSS_CODES.indexOf(code) === -1 ? code : 'SESSION_REQUIRED'
  if (surface === 'SESSION_REQUIRED') auth.clearSession()
  const e = failure(surface)
  e.status = statusCode
  e.retryable = object(payload) && object(payload.error) && payload.error.retryable === true
  return e
}
function binding() { const s = auth.getSession(); return s && auth.isLoggedIn() ? { token: s.accessToken, epoch: auth.sessionEpoch() } : null }
function current(b) { const now = binding(); return !!b && !!now && b.token === now.token && b.epoch === now.epoch }

function validateMeta(meta) {
  keys(meta, ['request_id', 'contract_version', 'execution_mode'])
  if (typeof meta.request_id !== 'string' || !UUID.test(meta.request_id) ||
      meta.contract_version !== CONTRACT_VERSION || !one(meta.execution_mode, EXECUTION_MODES)) throw failure('INVALID_RESPONSE')
  return meta.execution_mode
}

function validateCandidate(candidate) {
  keys(candidate, ['species_id', 'rank', 'model_score'])
  if (!text(candidate.species_id, 80) || !integer(candidate.rank, 1) || candidate.rank > MAX_CANDIDATES) throw failure('INVALID_RESPONSE')
  if (candidate.model_score !== null &&
      (typeof candidate.model_score !== 'number' || !Number.isFinite(candidate.model_score) ||
       candidate.model_score < 0 || candidate.model_score > 1)) throw failure('INVALID_RESPONSE')
  return { species_id: candidate.species_id, rank: candidate.rank, model_score: candidate.model_score }
}

function validateRecognition(value) {
  keys(value, ['id', 'revision', 'candidates', 'uncertainty_reasons', 'selected_species_id', 'model_version'])
  if (typeof value.id !== 'string' || !UUID.test(value.id) || !integer(value.revision, 1)) throw failure('INVALID_RESPONSE')
  if (!Array.isArray(value.candidates) || value.candidates.length > MAX_CANDIDATES) throw failure('INVALID_RESPONSE')
  const ranked = value.candidates.map(validateCandidate)
  const ranks = ranked.map(function (c) { return c.rank }).sort(function (a, b) { return a - b })
  for (let i = 0; i < ranks.length; i += 1) if (ranks[i] !== i + 1) throw failure('INVALID_RESPONSE')
  if (!Array.isArray(value.uncertainty_reasons) || value.uncertainty_reasons.length > 10) throw failure('INVALID_RESPONSE')
  for (const reason of value.uncertainty_reasons) if (!text(reason, 80)) throw failure('INVALID_RESPONSE')
  if (!(value.selected_species_id === null || text(value.selected_species_id, 80))) throw failure('INVALID_RESPONSE')
  if (!text(value.model_version, 80)) throw failure('INVALID_RESPONSE')
  return { id: value.id, revision: value.revision, candidates: ranked,
    uncertainty_reasons: value.uncertainty_reasons.slice(), selected_species_id: value.selected_species_id, model_version: value.model_version }
}

function validateJob(job) {
  keys(job, ['id', 'revision', 'kind', 'target_ref', 'state', 'deadline_at', 'created_at', 'error_code', 'result'])
  if (typeof job.id !== 'string' || !UUID.test(job.id) || !integer(job.revision, 1)) throw failure('INVALID_RESPONSE')
  if (job.kind !== 'recognition') throw failure('INVALID_RESPONSE')
  keys(job.target_ref, ['type', 'id', 'revision'])
  if (job.target_ref.type !== 'recognition' || typeof job.target_ref.id !== 'string' || !UUID.test(job.target_ref.id) ||
      !integer(job.target_ref.revision, 1)) throw failure('INVALID_RESPONSE')
  if (!one(job.state, JOB_STATES)) throw failure('INVALID_RESPONSE')
  if (!timestamp(job.deadline_at) || !timestamp(job.created_at)) throw failure('INVALID_RESPONSE')
  if (!(job.error_code === null || typeof job.error_code === 'string')) throw failure('INVALID_RESPONSE')
  let value = null
  if (job.result !== null) {
    keys(job.result, ['kind', 'value'])
    if (job.result.kind !== 'recognition') throw failure('INVALID_RESPONSE')
    value = validateRecognition(job.result.value)
  }
  // 只有 succeeded / uncertain 允许带识别结果；failed / timed_out / cancelled 带结果即视为响应异常。
  if (value !== null && job.state !== 'succeeded' && job.state !== 'uncertain') throw failure('INVALID_RESPONSE')
  return { id: job.id, revision: job.revision, state: job.state,
    target_ref: { type: 'recognition', id: job.target_ref.id, revision: job.target_ref.revision },
    deadline_at: job.deadline_at, created_at: job.created_at, error_code: job.error_code, result: value }
}

/**
 * 校验标签 OCR（#10）的契约 `Job`（九键、`kind='ocr'`、`target_ref.type='ocr'`）。
 *
 * 与 `validateJob`（识别域）同形，差异只有 `kind`/`target_ref.type` 的闭集成员：
 * OCR 没有专属的任务状态端点 ⇒ `GET /jobs/{id}` 是读七类 `JobState` 与 `error_code` 的**唯一**契约面。
 *
 * `result.value`（标签正文 `LabelFields` + `Verification`）**不在这里深校验**：展示一律走
 * `GET /ocr/{id}`（`utils/history-api.js` 的 `getOcr` 逐字段校验后交给 `ocrDetailView`），
 * 本层只确认"结果存在且是对象"，既不重造第二套 OCR 校验，也不放宽任何字段。
 */
function validateOcrJob(job) {
  keys(job, ['id', 'revision', 'kind', 'target_ref', 'state', 'deadline_at', 'created_at', 'error_code', 'result'])
  if (typeof job.id !== 'string' || !UUID.test(job.id) || !integer(job.revision, 1)) throw failure('INVALID_RESPONSE')
  if (job.kind !== 'ocr') throw failure('INVALID_RESPONSE')
  keys(job.target_ref, ['type', 'id', 'revision'])
  if (job.target_ref.type !== 'ocr' || typeof job.target_ref.id !== 'string' || !UUID.test(job.target_ref.id) ||
      !integer(job.target_ref.revision, 1)) throw failure('INVALID_RESPONSE')
  if (!one(job.state, JOB_STATES)) throw failure('INVALID_RESPONSE')
  if (!timestamp(job.deadline_at) || !timestamp(job.created_at)) throw failure('INVALID_RESPONSE')
  if (!(job.error_code === null || typeof job.error_code === 'string')) throw failure('INVALID_RESPONSE')
  let hasResult = false
  if (job.result !== null) {
    keys(job.result, ['kind', 'value'])
    if (job.result.kind !== 'ocr' || !object(job.result.value)) throw failure('INVALID_RESPONSE')
    hasResult = true
  }
  // 只有 succeeded / uncertain 允许带结果；failed / timed_out / cancelled 带结果即视为响应异常。
  if (hasResult && job.state !== 'succeeded' && job.state !== 'uncertain') throw failure('INVALID_RESPONSE')
  return { id: job.id, revision: job.revision, state: job.state,
    target_ref: { type: 'ocr', id: job.target_ref.id, revision: job.target_ref.revision },
    deadline_at: job.deadline_at, created_at: job.created_at, error_code: job.error_code, hasResult: hasResult }
}

function request(method, path, options) {
  const opts = options || {}
  const b = binding()
  if (!b || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  const header = { authorization: 'Bearer ' + b.token, 'Cache-Control': 'no-cache' }
  if (opts.body !== undefined) header['content-type'] = 'application/json'
  if (opts.idempotencyKey) header['Idempotency-Key'] = opts.idempotencyKey
  if (opts.ifMatch) header['If-Match'] = opts.ifMatch
  return new Promise(function (resolve, reject) {
    const wxOptions = {
      url: runtime.apiBaseUrl + path, method: method, timeout: 15000, header: header,
      success: function (r) {
        if (!current(b)) { reject(failure('SESSION_CHANGED')); return }
        if (r.statusCode === 401 || r.statusCode === 403) { reject(forbiddenOrSessionLoss(r.statusCode, r.data)); return }
        try {
          const payload = r.data
          if (r.statusCode === 202 || r.statusCode === 200) {
            keys(payload, ['data', 'meta'])
            resolve({ data: payload.data, mode: validateMeta(payload.meta), etag: r.header && r.header.ETag ? r.header.ETag : null })
            return
          }
          if (object(payload) && object(payload.error) && typeof payload.error.code === 'string') {
            const e = failure(payload.error.code); e.status = r.statusCode; e.retryable = payload.error.retryable === true
            reject(e); return
          }
          reject(failure(r.statusCode === 404 ? 'NOT_FOUND' : 'UNAVAILABLE'))
        } catch (e) { reject(e) }
      },
      fail: function () { reject(failure(current(b) ? 'NETWORK_UNCERTAIN' : 'SESSION_CHANGED')) }
    }
    if (opts.body !== undefined) wxOptions.data = opts.body
    wx.request(wxOptions)
  })
}

function newKey(prefix) { return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) }

/** 受理识别任务；body 恰为 MediaJobInput。 */
async function createRecognition(mediaId, mediaRevision) {
  if (typeof mediaId !== 'string' || !UUID.test(mediaId)) throw failure('INVALID_INPUT')
  if (!integer(mediaRevision, 1)) throw failure('INVALID_INPUT')
  const r = await request('POST', '/recognitions', { body: { media_id: mediaId, media_revision: mediaRevision }, idempotencyKey: newKey('identify-create') })
  return { job: validateJob(r.data), mode: r.mode }
}

async function getJob(jobId) {
  if (typeof jobId !== 'string' || !UUID.test(jobId)) throw failure('INVALID_INPUT')
  const r = await request('GET', '/jobs/' + jobId, {})
  return { job: validateJob(r.data), mode: r.mode }
}

async function cancelJob(jobId, revision) {
  if (typeof jobId !== 'string' || !UUID.test(jobId) || !integer(revision, 1)) throw failure('INVALID_INPUT')
  const r = await request('POST', '/jobs/' + jobId + '/cancel', { ifMatch: '"' + revision + '"', idempotencyKey: newKey('identify-cancel') })
  return { job: validateJob(r.data), mode: r.mode }
}

async function getRecognition(recognitionId) {
  if (typeof recognitionId !== 'string' || !UUID.test(recognitionId)) throw failure('INVALID_INPUT')
  const r = await request('GET', '/recognitions/' + recognitionId, {})
  return { recognition: validateRecognition(r.data), mode: r.mode }
}

async function selectSpecies(recognitionId, revision, speciesId) {
  if (typeof recognitionId !== 'string' || !UUID.test(recognitionId) || !integer(revision, 1)) throw failure('INVALID_INPUT')
  if (!text(speciesId, 80)) throw failure('INVALID_INPUT')
  const r = await request('PATCH', '/recognitions/' + recognitionId + '/selection', {
    body: { selected_species_id: speciesId }, ifMatch: '"' + revision + '"', idempotencyKey: newKey('identify-select')
  })
  return { recognition: validateRecognition(r.data), mode: r.mode }
}

async function deleteRecognition(recognitionId, revision) {
  if (typeof recognitionId !== 'string' || !UUID.test(recognitionId) || !integer(revision, 1)) throw failure('INVALID_INPUT')
  const r = await request('DELETE', '/recognitions/' + recognitionId, { ifMatch: '"' + revision + '"', idempotencyKey: newKey('identify-delete') })
  keys(r.data, ['accepted'])
  if (r.data.accepted !== true) throw failure('INVALID_RESPONSE')
  return { accepted: true, mode: r.mode }
}

// ---------------------------------------------------------------- 标签 OCR（#10）

/** 受理标签 OCR 任务；body 恰为 `MediaJobInput`（与识草同一形状，**不新增字段**）。 */
async function createOcr(mediaId, mediaRevision) {
  if (typeof mediaId !== 'string' || !UUID.test(mediaId)) throw failure('INVALID_INPUT')
  if (!integer(mediaRevision, 1)) throw failure('INVALID_INPUT')
  const r = await request('POST', '/ocr', { body: { media_id: mediaId, media_revision: mediaRevision }, idempotencyKey: newKey('ocr-create') })
  return { job: validateOcrJob(r.data), mode: r.mode }
}

/** 读标签 OCR 任务状态（七类 `JobState` + `error_code` 的唯一契约面）。 */
async function getOcrJob(jobId) {
  if (typeof jobId !== 'string' || !UUID.test(jobId)) throw failure('INVALID_INPUT')
  const r = await request('GET', '/jobs/' + jobId, {})
  return { job: validateOcrJob(r.data), mode: r.mode }
}

/**
 * 请求取消标签 OCR 任务。
 *
 * **本基线 OCR 域不提供取消能力**：服务端注册表先确认作业存在，再按契约返回
 * `503 PROVIDER_UNAVAILABLE`（`retryable: true`，语义="该作业所属能力尚未提供取消"），
 * **不伪造** `cancelled`、也**不用 404 谎称作业不存在**。错误码**原样保留**（不改成客户端私有码），
 * 由 `ocrMessageFor(e, 'cancel')` 给出专属文案，与 `NOT_FOUND`（"任务或识别记录不存在"）明确区分。
 */
async function cancelOcrJob(jobId, revision) {
  if (typeof jobId !== 'string' || !UUID.test(jobId) || !integer(revision, 1)) throw failure('INVALID_INPUT')
  const r = await request('POST', '/jobs/' + jobId + '/cancel', { ifMatch: '"' + revision + '"', idempotencyKey: newKey('ocr-cancel') })
  return { job: validateOcrJob(r.data), mode: r.mode }
}

function validateUploadGrant(data, expectedPurpose) {
  keys(data, ['media', 'upload'])
  const media = data.media
  const upload = data.upload
  keys(media, ['id', 'revision', 'purpose', 'mime', 'bytes', 'duration_ms', 'state', 'sha256', 'failure_code'])
  if (typeof media.id !== 'string' || !UUID.test(media.id) || !integer(media.revision, 1)) throw failure('INVALID_RESPONSE')
  // 用途必须**回显为本次请求的用途**（识别图 weed_recognition / 标签图 label_ocr）：不静默接受别的用途。
  if (media.purpose !== expectedPurpose || !one(media.state, MEDIA_STATES)) throw failure('INVALID_RESPONSE')
  if (!integer(media.bytes, 1) || typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(media.sha256)) throw failure('INVALID_RESPONSE')
  keys(upload, ['url', 'expires_at', 'method', 'access_token'])
  if (typeof upload.url !== 'string' || !/^https:\/\//.test(upload.url) || upload.method !== 'PUT') throw failure('INVALID_RESPONSE')
  if (!text(upload.access_token, 512) || !timestamp(upload.expires_at)) throw failure('INVALID_RESPONSE')
  return { media: media, upload: upload }
}

/**
 * real 模式：按契约走私有媒体上传链路（createUpload → PUT 句柄 URL → completeUpload）。
 * 任何一步失败都**如实抛出**，绝不回退替身、绝不伪造 media_id。
 *
 * `purposes` 是本次允许的契约用途闭集，`purpose` 为其中一项（缺省取第一项）：
 *   照片（识别图 / 标签图）传 `IMAGE_MEDIA_PURPOSES`；
 *   语音问答（#11）传 `[voice_question]` —— **同一落盘链路**，只是声明形状按契约音频分支不同。
 *
 * `POST /media/uploads` 非 201 时**读契约封套 `error.code`** 归因（见 `uploadFailureOf`）：
 *   503 PROVIDER_UNAVAILABLE ⇒ 服务端真实对象存储未接线；
 *   400/413/415（INVALID_REQUEST / MEDIA_TOO_LARGE / MEDIA_TYPE_UNSUPPORTED）⇒ 媒体不符合用途限制；
 * 封套读不到时才回落 `MEDIA_CHANNEL_UNAVAILABLE`（媒体路由**已挂载**，不得再断言"未挂载"）。
 */
function uploadPrivateMedia(tempFilePath, declaration, purposes, purpose) {
  const b = binding()
  if (!b || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  if (typeof tempFilePath !== 'string' || tempFilePath === '') return Promise.reject(failure('INVALID_INPUT'))
  const mediaPurpose = purpose === undefined ? purposes[0] : purpose
  if (purposes.indexOf(mediaPurpose) === -1) return Promise.reject(failure('INVALID_INPUT'))
  // 契约 `UploadInput.additionalProperties=false`：图片**不得**带 `duration_ms`，音频**必须**带。
  const wantsDuration = declaration !== null && typeof declaration === 'object' && declaration.durationMs !== undefined
  if (wantsDuration !== (mediaPurpose === VOICE_MEDIA_PURPOSE)) return Promise.reject(failure('INVALID_INPUT'))
  const keyPrefix = mediaPurpose === VOICE_MEDIA_PURPOSE ? 'voice-upload' : (mediaPurpose === OCR_MEDIA_PURPOSE ? 'ocr-upload' : 'identify-upload')
  const donePrefix = mediaPurpose === VOICE_MEDIA_PURPOSE ? 'voice-complete' : (mediaPurpose === OCR_MEDIA_PURPOSE ? 'ocr-complete' : 'identify-complete')
  const declared = wantsDuration
    ? { purpose: mediaPurpose, mime: declaration.mime, bytes: declaration.bytes, sha256: declaration.sha256, duration_ms: declaration.durationMs }
    : { purpose: mediaPurpose, mime: declaration.mime, bytes: declaration.bytes, sha256: declaration.sha256 }
  const header = { authorization: 'Bearer ' + b.token, 'content-type': 'application/json', 'Cache-Control': 'no-cache', 'Idempotency-Key': newKey(keyPrefix) }
  return new Promise(function (resolve, reject) {
    wx.request({
      url: runtime.apiBaseUrl + '/media/uploads', method: 'POST', timeout: 15000, header: header,
      data: declared,
      success: function (r) {
        if (!current(b)) { reject(failure('SESSION_CHANGED')); return }
        if (r.statusCode === 401 || r.statusCode === 403) { reject(forbiddenOrSessionLoss(r.statusCode, r.data)); return }
        let grant
        try {
          if (r.statusCode !== 201) { reject(uploadFailureOf(r.statusCode, r.data, 'MEDIA_CHANNEL_UNAVAILABLE')); return }
          keys(r.data, ['data', 'meta'])
          validateMeta(r.data.meta)
          grant = validateUploadGrant(r.data.data, mediaPurpose)
        } catch (e) { reject(e); return }
        wx.getFileSystemManager().readFile({
          filePath: tempFilePath,
          success: function (file) {
            wx.request({
              url: grant.upload.url, method: 'PUT', timeout: 30000, data: file.data,
              header: { authorization: 'Bearer ' + grant.upload.access_token, 'content-type': declaration.mime },
              success: function (put) {
                if (put.statusCode !== 200 && put.statusCode !== 201 && put.statusCode !== 204) { reject(failure('MEDIA_CHANNEL_UNAVAILABLE')); return }
                wx.request({
                  url: runtime.apiBaseUrl + '/media/uploads/' + grant.media.id + '/complete', method: 'POST', timeout: 30000,
                  header: { authorization: 'Bearer ' + b.token, 'content-type': 'application/json', 'If-Match': '"' + grant.media.revision + '"', 'Idempotency-Key': newKey(donePrefix) },
                  data: { sha256: declaration.sha256, bytes: declaration.bytes },
                  success: function (done) {
                    try {
                      if (done.statusCode !== 202) { reject(uploadFailureOf(done.statusCode, done.data, 'MEDIA_CHANNEL_UNAVAILABLE')); return }
                      keys(done.data, ['data', 'meta'])
                      validateMeta(done.data.meta)
                      const media = done.data.data
                      keys(media, ['id', 'revision', 'purpose', 'mime', 'bytes', 'duration_ms', 'state', 'sha256', 'failure_code'])
                      if (typeof media.id !== 'string' || !UUID.test(media.id) || media.state !== 'ready') { reject(failure('OBJECT_UNAVAILABLE')); return }
                      resolve({ mediaId: media.id, mediaRevision: media.revision })
                    } catch (e) { reject(e) }
                  },
                  fail: function () { reject(failure('MEDIA_CHANNEL_UNAVAILABLE')) }
                })
              },
              fail: function () { reject(failure('MEDIA_CHANNEL_UNAVAILABLE')) }
            })
          },
          fail: function () { reject(failure('MEDIA_CHANNEL_UNAVAILABLE')) }
        })
      },
      fail: function () { reject(failure('MEDIA_CHANNEL_UNAVAILABLE')) }
    })
  })
}

function uploadPrivatePhoto(tempFilePath, declaration, purpose) {
  return uploadPrivateMedia(tempFilePath, declaration, IMAGE_MEDIA_PURPOSES, purpose === undefined ? MEDIA_PURPOSE : purpose)
}

/**
 * 按**契约既有成员** `voice_question` 上传一次录音产物（**不新增用途、不新增字段**）。
 *
 * 与照片链路唯一的三处差异，且都由契约束定：
 *   1. 用途 = `voice_question`（`MediaPurpose` 音频成员）；
 *   2. 声明**必须**带 `duration_ms`（服务端 `validateUploadInput`：语音缺时长直接 400 INVALID_REQUEST）；
 *   3. 真实编码只接受 `audio/mpeg | audio/wav | audio/aac`（服务端按魔数核验，不信扩展名）。
 *
 * `declaration` 由调用方从**平台真实回调**取（`durationMs` 来自 `onStop` 的 `res.duration`，
 * `bytes`/`sha256` 来自 `wx.getFileInfo({ digestAlgorithm:'sha256' })`）；本函数**不**猜测时长。
 *
 * 失败归因：`uploadFailureOf` 原样带出契约封套的 `error.code`
 * （503 PROVIDER_UNAVAILABLE = 真实对象存储未接线；400/413/415 = 用途限制；
 *   403 CONSENT_REQUIRED / SCOPE_DENIED 由 `forbiddenOrSessionLoss` 原样带出，**不**折叠成"登录失效"）。
 *
 * @param {string} tempFilePath `wx.getRecorderManager().onStop` 给出的本地临时文件路径。
 * @param {{ mime:string, bytes:number, sha256:string, durationMs:number }} declaration
 * @returns {Promise<{ mediaId:string, mediaRevision:number }>}
 */
function uploadVoiceQuestion(tempFilePath, declaration) {
  if (declaration === null || typeof declaration !== 'object') return Promise.reject(failure('INVALID_INPUT'))
  if (typeof declaration.mime !== 'string' || AUDIO_MEDIA_MIMES.indexOf(declaration.mime) === -1) return Promise.reject(failure('INVALID_INPUT'))
  if (!integer(declaration.bytes, 1) || declaration.bytes > VOICE_MAX_BYTES) return Promise.reject(failure('INVALID_INPUT'))
  if (typeof declaration.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(declaration.sha256)) return Promise.reject(failure('INVALID_INPUT'))
  if (!integer(declaration.durationMs, 1) || declaration.durationMs > MEDIA_MAX_DURATION_MS) return Promise.reject(failure('INVALID_INPUT'))
  return uploadPrivateMedia(tempFilePath, declaration, [VOICE_MEDIA_PURPOSE], VOICE_MEDIA_PURPOSE)
}

/**
 * 读服务端执行模式（用公开读面 `GET /public/home` 的**契约封套 meta**，不发任何私有数据）。
 *
 * **为什么不能要求 200**（既有缺陷 1-D，本片附带修复）：`/public/home` 的**数据**只在
 * `real` + 已接库时才可用（`services/api/src/db/catalog.ts:15-16` 的 fail-closed，
 * `tests/unit/public-home.test.mjs` 对 real/stub/preset_demo 逐模式断言 503），
 * 真机实测该 503 已登记（`.pg17/handoff/device-fullchain-a4-2044.md:178`）。
 * 旧写法把"数据不可用（按设计）"当成"执行模式不可读" ⇒ `stub`/`preset_demo` 下识别入口
 * **在第一步就死掉**（页面显示"识别服务暂不可用"），与"替身模式明确标注"的既有设计矛盾。
 *
 * 契约事实：`Meta`（`request_id`/`contract_version`/`execution_mode`）在**成功与错误封套里都必填**
 * （`openapi.json` 的 `ErrorEnvelope.required = [error, meta]`）⇒ 非 200 时**仍可如实**读出执行模式。
 * 只有"封套里没有可核对的 meta"或网络失败才如实报不可用（不猜、不兜底）。
 *
 * 200 时**仍须**核对**成功封套键集**（契约实读：`HomeEnvelope` 恰为 `{data, meta}`，
 * `additionalProperties: false`、`required: [data, meta]` —— `packages/contracts/openapi.json:14789-14804`）：
 * 缺键／多键／非对象／`meta` 类型不符一律判 `INVALID_RESPONSE`（沿用既有错误码），
 * 与"数据不可用（503 等）"严格区分——畸形 200 若被当成"已读到执行模式"放行，
 * 入口就会按一个**未经核对**的模式继续跑（伪造模式比报错更危险）。
 */
function serverMode() {
  const b = binding()
  if (!b || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  return new Promise(function (resolve, reject) {
    wx.request({
      url: runtime.apiBaseUrl + '/public/home', method: 'GET', timeout: 15000, header: { 'Cache-Control': 'no-cache' },
      success: function (r) {
        if (!current(b)) { reject(failure('SESSION_CHANGED')); return }
        if (r.statusCode === 401 || r.statusCode === 403) { reject(forbiddenOrSessionLoss(r.statusCode, r.data)); return }
        try {
          if (r.statusCode === 200) {
            // 成功封套键集与契约一致才放行（缺键／多键／非对象／`meta` 类型不符 ⇒ INVALID_RESPONSE）。
            keys(r.data, ['data', 'meta'])
            resolve(validateMeta(r.data.meta))
            return
          }
          if (!object(r.data) || !object(r.data.meta)) { reject(failure('UNAVAILABLE')); return }
          resolve(validateMeta(r.data.meta))
        } catch (e) { reject(e) }
      },
      fail: function () { reject(failure('NETWORK_UNCERTAIN')) }
    })
  })
}

/** 七类状态呈现；未知状态按 INVALID_RESPONSE 抛出，不做兜底成功。 */
function describeJobState(state) {
  if (!one(state, JOB_STATES)) throw failure('INVALID_RESPONSE')
  const view = JOB_STATE_VIEWS[state]
  return { state: view.state, tone: view.tone, component: view.component, title: view.title, desc: view.desc,
    terminal: view.terminal, success: view.success, retryable: view.retryable }
}

/** 后续科普/用量路径的唯一放行判据：**只有 succeeded**。 */
function isSuccessState(state) { return state === 'succeeded' }
function isTerminalState(state) { return one(state, JOB_STATES) && JOB_STATE_VIEWS[state].terminal === true }
function terminalStates() { return JOB_STATES.filter(function (s) { return JOB_STATE_VIEWS[s].terminal === true }) }

// ---------------------------------------------------------------- 六类分支

/**
 * 由**契约可见信息**归类六类失败/边界分支；不属于六类时返回 null。
 *
 * 归类顺序是安全性的一部分（不得重排）：
 *   1. 权限拒绝（受理前拦截，`error_code=CONSENT_REQUIRED`）——优先，因为它根本没有任务；
 *   2. 超时（`timed_out` / `PROVIDER_TIMEOUT`）；
 *   3. `uncertain` 细分：覆盖外·低质量 / 重拍 / 无结果 / 一般不确定。
 *
 * 「按原因文本细分」是**契约形态**决定的：`Recognition` 没有分支字段，
 * 因此只能以服务端写入 `uncertainty_reasons` 的**闭集文本**为准；
 * 匹配不上时回落到一般 `uncertain`（更保守，绝不因此把结果当成成功）。
 * 文本来源与本文件上方镜像的闭集一致，漂移由回归测试拦住。
 */
function branchFor(state, errorCode, reasons) {
  const list = Array.isArray(reasons) ? reasons : []
  if (errorCode === 'CONSENT_REQUIRED') return 'permission_denied'
  if (state === 'timed_out' || errorCode === 'PROVIDER_TIMEOUT') return 'timeout'
  if (state !== 'uncertain') return null
  if (list.indexOf(COVERAGE_REASON_OUT_OF_SCOPE) !== -1 || list.indexOf(COVERAGE_REASON_LOW_QUALITY) !== -1) {
    return 'out_of_coverage_or_low_quality'
  }
  if (list.indexOf(COVERAGE_REASON_RESHOOT) !== -1) return 'reshoot_required'
  if (list.some(function (r) { return typeof r === 'string' && r.indexOf('未返回任何候选') !== -1 })) return 'no_result'
  return 'uncertain'
}

/** 分支指引（不可变副本；unknown 分支返回 null，页面不得据此给出重试入口）。 */
function describeBranch(branch) {
  if (!one(branch, FAILURE_BRANCHES)) return null
  const entry = BRANCH_GUIDE[branch]
  return {
    branch: entry.branch, label: entry.label, jobState: entry.jobState, errorCode: entry.errorCode,
    retryable: entry.retryable, retryAction: entry.retryAction,
    retryLabel: entry.retryAction === null ? '' : (RETRY_ACTION_LABELS[entry.retryAction] || '重试'),
    reason: entry.reason,
    createsJob: entry.jobState !== null
  }
}

/** 六类分支的完整指引（供证据/走查逐类核对；顺序与闭集一致）。 */
function branchGuide() { return FAILURE_BRANCHES.map(function (b) { return describeBranch(b) }) }

// -------------------------------------------------- 条件完整性 / 用量路径守卫

/** 缺项清单（逐项如实，不补默认值；`region_code` 另需满足契约形状）。 */
function missingDoseConditions(conditions) {
  const source = conditions && typeof conditions === 'object' ? conditions : {}
  const missing = []
  for (const field of DOSE_CONDITION_FIELDS) {
    const raw = source[field]
    const value = typeof raw === 'string' ? raw.trim() : ''
    if (value === '') { missing.push(field); continue }
    if (field === 'region_code' && !REGION_CODE_PATTERN.test(value)) missing.push(field)
  }
  return missing
}

/** 条件是否完整（契约 `DoseConditions` 口径）。 */
function isConditionsComplete(conditions) { return missingDoseConditions(conditions).length === 0 }

/** 条件字段的页面文案（缺项提示用；不出现"权威/绝对安全"等禁用表述）。 */
const DOSE_CONDITION_LABELS = {
  crop_id: '作物', region_code: '地区', species_id: '杂草对象',
  growth_stage: '生育期', planting_method: '种植方式', use_scene: '使用场景'
}

/** 缺项的可读清单（页面直接展示，避免页面自己拼字段名）。 */
function missingConditionLabels(conditions) {
  return missingDoseConditions(conditions).map(function (f) { return DOSE_CONDITION_LABELS[f] || f })
}

/**
 * 识别/选择路径的用量守卫结果（**恒定**不可用）。
 *
 * 与 `linkage.ts` 同语义：这条路径没有经 GY-I08 授权的用量来源，
 * 因此 `renderable` 恒 false、`card` 恒 null；条件是否完整只影响**原因**，
 * 不影响「这条路径能不能给用量」（永远不能）。
 */
function dosePathGuard(conditions) {
  const missing = missingDoseConditions(conditions)
  return {
    renderable: false,
    card: null,
    blockCode: DOSE_PATH_BLOCK_CODE,
    blockedByPath: 'recognition_selection',
    conditionsComplete: missing.length === 0,
    missingConditions: missing,
    missingConditionLabels: missingConditionLabels(conditions),
    ruleVersion: APPLICABILITY_RULE_VERSION
  }
}


/**
 * 纯函数视图模型：由**已校验**的 Job 决定页面能显示什么。
 * showTop3 仅在 succeeded / uncertain 为真；candidatesTrusted 与 allowReferenceQuery 仅 succeeded 为真
 * （uncertain 必须经用户显式「人工核对」确认后才允许记录选择与查询关联科普）。
 */
function viewModelForJob(job) {
  if (job === null || job === undefined) {
    return { view: null, state: null, branch: null, branchInfo: null, candidates: [], reasons: [], showTop3: false, candidatesTrusted: false, allowReferenceQuery: false, hasError: false, stateComponent: 'empty' }
  }
  const view = describeJobState(job.state)
  const value = job.result
  const candidates = value === null ? [] : value.candidates.map(function (c) {
    return { species_id: c.species_id, rank: c.rank, model_score: c.model_score,
      scoreText: c.model_score === null ? '无分数' : Math.round(c.model_score * 100) + '%' }
  })
  const reasons = value === null ? [] : value.uncertainty_reasons.slice()
  const branch = branchFor(job.state, job.error_code, reasons)
  return {
    view: view,
    state: job.state,
    candidates: candidates,
    reasons: reasons,
    showTop3: view.success === true || job.state === 'uncertain',
    candidatesTrusted: view.success === true,
    allowReferenceQuery: view.success === true,
    hasError: job.error_code !== null,
    /** 六类分支归类（不属于六类时为 null）。 */
    branch: branch,
    branchInfo: describeBranch(branch),
    /**
     * 失败/空态收口到 `state-view` 组件用的状态名：
     * 非终态 → loading；uncertain/failed/timed_out → error；cancelled → cancelled；
     * succeeded → ready（不渲染 state-view）。
     */
    stateComponent: view.component
  }
}

function messageFor(e) {
  const code = e && e.code
  return {
    SESSION_REQUIRED: '登录状态已失效，请重新登录后再识别。',
    SESSION_CHANGED: '会话已变化，请重新进入本页。',
    NETWORK_UNCERTAIN: '网络未能确认结果，已停止显示，请重试。',
    NOT_FOUND: '任务或识别记录不存在、或不属于当前账号。',
    INVALID_INPUT: '请求参数不合法，已停止。',
    INVALID_RESPONSE: '服务端响应无法核对，已停止显示，请重试。',
    // 提供者/对象存储：real 模式下服务端真实对象存储尚未接线（媒体域 fail-closed ⇒ 503）。
    PROVIDER_UNAVAILABLE: '服务端真实对象存储尚未接线（媒体域 fail-closed），照片未上传；real 模式下不会用替身结果顶替。',
    PROVIDER_TIMEOUT: '识别服务超时，请稍后重试。',
    PROVIDER_QUOTA_EXCEEDED: '识别服务配额已用尽，请稍后重试。',
    PROVIDER_OUTCOME_UNKNOWN: '识别结果状态未知，已停止显示，请重试。',
    // 用途限制（识别图 ≤2 MiB / 仅 JPG·PNG·WebP）：413 / 415 / 400 三条服务端分支同口径。
    MEDIA_TOO_LARGE: MEDIA_USE_LIMIT_TEXT,
    MEDIA_TYPE_UNSUPPORTED: MEDIA_USE_LIMIT_TEXT,
    INVALID_REQUEST: MEDIA_USE_LIMIT_TEXT,
    OBJECT_UNAVAILABLE: '该照片当前不可用于识别（未就绪或不可用），请重新拍照上传。',
    // 权限拒绝分支（受理前拦截）：不得用任何替身或缓存结果顶替。
    CONSENT_REQUIRED: '尚未获得照片处理与外部识别的用途授权。请先在「我的」中完成授权，未授权时不会外发照片、也不会用替身结果顶替。',
    MEDIA_CHANNEL_UNAVAILABLE: '照片上传未完成（私有媒体上传通道不可用），real 模式下不会用替身结果顶替，请稍后重试。',
    REVISION_CONFLICT: '记录已被更新，请刷新后重试。',
    REVISION_REQUIRED: '缺少版本信息，请刷新后重试。',
    IDEMPOTENCY_KEY_REQUIRED: '请求缺少幂等键，请重试。',
    IDEMPOTENCY_CONFLICT: '同一幂等键被复用于不同请求，请重试。',
    // 403 的**非会话类**契约码：会话仍有效，如实说明原因（不得说成"登录失效"）。
    SCOPE_DENIED: '当前会话无权执行该操作（权限范围不足），已停止；请改用有权限的账号或联系管理员。',
    ACCOUNT_INACTIVE: '账号已停用或受限，服务端拒绝该操作；请按停用/注销流程处理。',
    UNAVAILABLE: '识别服务暂不可用，已停止显示，请重试。'
  }[code] || '识别服务暂不可用，已停止显示，请重试。'
}

/**
 * 标签 OCR（#10）路径的**站点特定**归因（唯二两处；其余码一律走 `messageFor` 的**同一措辞表**）。
 *
 * 为什么必须按调用点区分（不合并成一句）：
 *   1. `PROVIDER_UNAVAILABLE`（503）在本仓库有**两个不同的未接线后端**——
 *      媒体域的真实**对象存储**（`POST /media/uploads`；切片 B `27aa07c` 的措辞指向它）与
 *      OCR 域的**真实 OCR 提供者**（`POST /ocr`）。本路径指向后者，指错就是把用户引向错误原因。
 *   2. `POST /jobs/{id}/cancel` 对 OCR 作业按契约返回 `503 PROVIDER_UNAVAILABLE`(`retryable`)，
 *      语义是"**该作业所属能力尚未提供取消**"（`jobs/registry.ts` 的注释与实现），
 *      **不是**"作业不存在"（`NOT_FOUND`）⇒ `site='cancel'` 时必须给专属文案，两者不得混用。
 *      判据是 `site`，**不再**是 `retryable`：能力未接线在四域统一为 `retryable=false`（口径原文见
 *      `services/api/src/errors.ts` 的 `ApiError` 注释），故不能再用该字段区分"取消未接线"与"受理面未接线"。
 *
 * `site` 省略 ⇒ 创建/读取 OCR 任务的站点。未知码一律回落到 `messageFor`（不发明文案）。
 */
function ocrMessageFor(e, site) {
  const code = e && e.code
  if (code === 'PROVIDER_UNAVAILABLE' && site === 'cancel') {
    return '服务端尚未提供标签识别任务的取消能力（该能力未接线）：本次没有取消，任务仍在服务端运行或已按截止时间落定。'
      + '这不是"任务不存在"，请稍后重读任务状态。'
  }
  if (code === 'PROVIDER_UNAVAILABLE') {
    return '标签识别服务当前不可用（服务端真实 OCR 提供者未接线或缺少凭据），本任务未创建/未完成；不会用替身结果顶替。'
  }
  if (code === 'OBJECT_UNAVAILABLE') {
    return '该照片当前不可用于标签识别（媒体引用未就绪，或服务端媒体端口未接线），请重新拍照上传。'
  }
  return messageFor(e)
}

module.exports = {
  JOB_STATES: JOB_STATES.slice(),
  CONTRACT_VERSION: CONTRACT_VERSION,
  createRecognition: createRecognition,
  getJob: getJob,
  cancelJob: cancelJob,
  getRecognition: getRecognition,
  selectSpecies: selectSpecies,
  deleteRecognition: deleteRecognition,
  uploadPrivatePhoto: uploadPrivatePhoto,
  // ---- GY-I11 语音问答（#11）：同一私有媒体链路上的音频用途（契约既有成员 voice_question） ----
  uploadVoiceQuestion: uploadVoiceQuestion,
  VOICE_MEDIA_PURPOSE: VOICE_MEDIA_PURPOSE,
  AUDIO_MEDIA_MIMES: AUDIO_MEDIA_MIMES.slice(),
  VOICE_MAX_BYTES: VOICE_MAX_BYTES,
  VOICE_USE_LIMIT_TEXT: VOICE_USE_LIMIT_TEXT,
  MEDIA_MAX_DURATION_MS: MEDIA_MAX_DURATION_MS,
  serverMode: serverMode,
  // ---- GY-I10 标签 OCR（#10）：创建/状态读/取消 + 站点特定归因（全部复用既有 operation） ----
  createOcr: createOcr,
  getOcrJob: getOcrJob,
  cancelOcrJob: cancelOcrJob,
  validateOcrJob: validateOcrJob,
  ocrMessageFor: ocrMessageFor,
  OCR_MEDIA_PURPOSE: OCR_MEDIA_PURPOSE,
  IMAGE_MEDIA_PURPOSES: IMAGE_MEDIA_PURPOSES.slice(),
  MEDIA_USE_LIMIT_TEXT: MEDIA_USE_LIMIT_TEXT,
  MEDIA_UPLOAD_ERROR_CODES: MEDIA_UPLOAD_ERROR_CODES.slice(),
  describeJobState: describeJobState,
  isSuccessState: isSuccessState,
  isTerminalState: isTerminalState,
  terminalStates: terminalStates,
  viewModelForJob: viewModelForJob,
  messageFor: messageFor,
  newKey: newKey,
  // ---- GY-I08 规则版本 / 条件口径 / 六类分支的跨端镜像（漂移由回归测试拦住） ----
  APPLICABILITY_RULE_VERSION: APPLICABILITY_RULE_VERSION,
  DOSE_CONDITION_FIELDS: DOSE_CONDITION_FIELDS.slice(),
  DOSE_PATH_BLOCK_CODE: DOSE_PATH_BLOCK_CODE,
  FAILURE_BRANCHES: FAILURE_BRANCHES.slice(),
  RETRY_ACTION_LABELS: Object.assign({}, RETRY_ACTION_LABELS),
  COVERAGE_REASONS: [COVERAGE_REASON_OUT_OF_SCOPE, COVERAGE_REASON_LOW_QUALITY, COVERAGE_REASON_RESHOOT],
  describeBranch: describeBranch,
  branchGuide: branchGuide,
  branchFor: branchFor,
  missingDoseConditions: missingDoseConditions,
  missingConditionLabels: missingConditionLabels,
  isConditionsComplete: isConditionsComplete,
  dosePathGuard: dosePathGuard,
  validId: function (id) { return typeof id === 'string' && UUID.test(id) }
}
