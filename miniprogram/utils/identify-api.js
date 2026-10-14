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
    PROVIDER_UNAVAILABLE: '识别服务当前不可用（真实提供者未接入或缺少凭据），不会用替身结果顶替。',
    PROVIDER_TIMEOUT: '识别服务超时，请稍后重试。',
    PROVIDER_QUOTA_EXCEEDED: '识别服务配额已用尽，请稍后重试。',
    PROVIDER_OUTCOME_UNKNOWN: '识别结果状态未知，已停止显示，请重试。',
    OBJECT_UNAVAILABLE: '该照片当前不可用于识别（未就绪或不可用），请重新拍照上传。',
    // 权限拒绝分支（受理前拦截）：不得用任何替身或缓存结果顶替。
    CONSENT_REQUIRED: '尚未获得照片处理与外部识别的用途授权。请先在「我的」中完成授权，未授权时不会外发照片、也不会用替身结果顶替。',
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
