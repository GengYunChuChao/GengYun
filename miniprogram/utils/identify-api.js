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
        if (r.statusCode === 401 || r.statusCode === 403) { auth.clearSession(); reject(failure('SESSION_REQUIRED')); return }
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

function validateUploadGrant(data) {
  keys(data, ['media', 'upload'])
  const media = data.media
  const upload = data.upload
  keys(media, ['id', 'revision', 'purpose', 'mime', 'bytes', 'duration_ms', 'state', 'sha256', 'failure_code'])
  if (typeof media.id !== 'string' || !UUID.test(media.id) || !integer(media.revision, 1)) throw failure('INVALID_RESPONSE')
  if (media.purpose !== MEDIA_PURPOSE || !one(media.state, MEDIA_STATES)) throw failure('INVALID_RESPONSE')
  if (!integer(media.bytes, 1) || typeof media.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(media.sha256)) throw failure('INVALID_RESPONSE')
  keys(upload, ['url', 'expires_at', 'method', 'access_token'])
  if (typeof upload.url !== 'string' || !/^https:\/\//.test(upload.url) || upload.method !== 'PUT') throw failure('INVALID_RESPONSE')
  if (!text(upload.access_token, 512) || !timestamp(upload.expires_at)) throw failure('INVALID_RESPONSE')
  return { media: media, upload: upload }
}

/**
 * real 模式：按契约走私有媒体上传链路（createUpload → PUT 句柄 URL → completeUpload）。
 * 任何一步失败都**如实抛出**（映射为 MEDIA_CHANNEL_UNAVAILABLE 等），绝不回退替身、绝不伪造 media_id。
 */
function uploadPrivatePhoto(tempFilePath, declaration) {
  const b = binding()
  if (!b || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  if (typeof tempFilePath !== 'string' || tempFilePath === '') return Promise.reject(failure('INVALID_INPUT'))
  const header = { authorization: 'Bearer ' + b.token, 'content-type': 'application/json', 'Cache-Control': 'no-cache', 'Idempotency-Key': newKey('identify-upload') }
  return new Promise(function (resolve, reject) {
    wx.request({
      url: runtime.apiBaseUrl + '/media/uploads', method: 'POST', timeout: 15000, header: header,
      data: { purpose: MEDIA_PURPOSE, mime: declaration.mime, bytes: declaration.bytes, sha256: declaration.sha256 },
      success: function (r) {
        if (!current(b)) { reject(failure('SESSION_CHANGED')); return }
        if (r.statusCode === 401 || r.statusCode === 403) { auth.clearSession(); reject(failure('SESSION_REQUIRED')); return }
        let grant
        try {
          if (r.statusCode !== 201) { reject(failure('MEDIA_CHANNEL_UNAVAILABLE')); return }
          keys(r.data, ['data', 'meta'])
          validateMeta(r.data.meta)
          grant = validateUploadGrant(r.data.data)
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
                  header: { authorization: 'Bearer ' + b.token, 'content-type': 'application/json', 'If-Match': '"' + grant.media.revision + '"', 'Idempotency-Key': newKey('identify-complete') },
                  data: { sha256: declaration.sha256, bytes: declaration.bytes },
                  success: function (done) {
                    try {
                      if (done.statusCode !== 202) { reject(failure('MEDIA_CHANNEL_UNAVAILABLE')); return }
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

/** 读服务端执行模式（用公开主页 meta，不发任何私有数据）；失败如实抛出。 */
function serverMode() {
  const b = binding()
  if (!b || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  return new Promise(function (resolve, reject) {
    wx.request({
      url: runtime.apiBaseUrl + '/public/home', method: 'GET', timeout: 15000, header: { 'Cache-Control': 'no-cache' },
      success: function (r) {
        try {
          if (r.statusCode !== 200) { reject(failure('UNAVAILABLE')); return }
          keys(r.data, ['data', 'meta'])
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

/**
 * 纯函数视图模型：由**已校验**的 Job 决定页面能显示什么。
 * showTop3 仅在 succeeded / uncertain 为真；candidatesTrusted 与 allowReferenceQuery 仅 succeeded 为真
 * （uncertain 必须经用户显式「人工核对」确认后才允许记录选择与查询关联科普）。
 */
function viewModelForJob(job) {
  if (job === null || job === undefined) {
    return { view: null, state: null, candidates: [], reasons: [], showTop3: false, candidatesTrusted: false, allowReferenceQuery: false, hasError: false }
  }
  const view = describeJobState(job.state)
  const value = job.result
  const candidates = value === null ? [] : value.candidates.map(function (c) {
    return { species_id: c.species_id, rank: c.rank, model_score: c.model_score,
      scoreText: c.model_score === null ? '无分数' : Math.round(c.model_score * 100) + '%' }
  })
  const reasons = value === null ? [] : value.uncertainty_reasons.slice()
  return {
    view: view,
    state: job.state,
    candidates: candidates,
    reasons: reasons,
    showTop3: view.success === true || job.state === 'uncertain',
    candidatesTrusted: view.success === true,
    allowReferenceQuery: view.success === true,
    hasError: job.error_code !== null
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
    PROVIDER_UNAVAILABLE: '识别服务当前不可用（真实提供者未接入或缺少凭据），不会用替身结果顶替。',
    PROVIDER_TIMEOUT: '识别服务超时，请稍后重试。',
    PROVIDER_QUOTA_EXCEEDED: '识别服务配额已用尽，请稍后重试。',
    PROVIDER_OUTCOME_UNKNOWN: '识别结果状态未知，已停止显示，请重试。',
    OBJECT_UNAVAILABLE: '该照片当前不可用于识别（未就绪或不可用），请重新拍照上传。',
    MEDIA_CHANNEL_UNAVAILABLE: '私有媒体上传通道尚未接入服务端（/media 内容端点未挂载），real 模式下不会用替身结果顶替。',
    REVISION_CONFLICT: '记录已被更新，请刷新后重试。',
    REVISION_REQUIRED: '缺少版本信息，请刷新后重试。',
    IDEMPOTENCY_KEY_REQUIRED: '请求缺少幂等键，请重试。',
    IDEMPOTENCY_CONFLICT: '同一幂等键被复用于不同请求，请重试。',
    UNAVAILABLE: '识别服务暂不可用，已停止显示，请重试。'
  }[code] || '识别服务暂不可用，已停止显示，请重试。'
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
  serverMode: serverMode,
  describeJobState: describeJobState,
  isSuccessState: isSuccessState,
  isTerminalState: isTerminalState,
  terminalStates: terminalStates,
  viewModelForJob: viewModelForJob,
  messageFor: messageFor,
  newKey: newKey,
  validId: function (id) { return typeof id === 'string' && UUID.test(id) }
}
