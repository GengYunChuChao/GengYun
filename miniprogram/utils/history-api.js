// GY-I16 历史（可浏览的识别历史）HTTP 消费层与**纯视图模型**（原生小程序侧）。
//
// 契约面（packages/contracts/openapi.json 1.0.0）：
//   listHistory      GET    /history            → HistoryPageEnvelope
//   deleteHistory    DELETE /history/{id}       → AckEnvelope（If-Match + Idempotency-Key 必填）
//   （详情**没有**契约外路径：历史只给 `target_ref`，详情由已合并的
//     `GET /recognitions/{id}`（#9，经 utils/identify-api.js 复用）与
//     `GET /ocr/{id}`（#10）组合出来。）
//
// 硬口径：
// 1) **候选与人工选择分开**：模型候选（`candidates` + `model_score`）与用户的人工选择
//    （`selected_species_id`）是两个独立区块，绝不合并成一个"结论"；
//    `model_score` 只是模型自报分数，**不是**准确率或置信度承诺。
// 2) **失败状态真实可见**：`job_state` 七类逐类呈现（复用 identify-api 的 `describeJobState`），
//    `failed`/`timed_out`/`cancelled`/`uncertain` **不得**被折叠成"成功"或被隐藏。
// 3) **读取时重查**：列表每项都带服务端当次派生的 `reference_state`；不可用时如实标注，
//    **不**用本地缓存或"曾经可用"顶替。详情页所有状态**只来自实时读取**——旧链接里夹带的
//    状态字段一律忽略（见 `parseDetailQuery`）。
// 4) **识别/收藏 ≠ 已使用**：本层没有任何"标记为已使用"的接口，也没有用量事实。
// 5) 用药安全：详情页**不渲染**用量卡正文与登记用量数字，只报"存在 N 条"并提示以核验资料为准。
const auth = require('./auth')
const runtime = require('../config/runtime')
const identify = require('./identify-api')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTRACT_VERSION = '1.0.0'
const EXECUTION_MODES = ['real', 'stub', 'preset_demo']
const HISTORY_KINDS = ['recognition', 'ocr']
const HISTORY_KEYS = ['id', 'revision', 'kind', 'target_ref', 'job_state', 'reference_state', 'created_at']
const TARGET_REF_KEYS = ['type', 'id', 'revision']
const TARGET_REF_TYPES = ['species', 'herbicide', 'scheme', 'static_region', 'recognition', 'ocr', 'transcription',
  'answer', 'post', 'comment', 'conversation', 'dose_card', 'media', 'synthesis', 'job', 'source']
const REFERENCE_STATES = ['available', 'unavailable']
const MATCH_STATES = ['matched', 'no_match', 'ambiguous', 'conflict', 'insufficient', 'unavailable']
const PAGE_LIMIT_MAX = 50
const MAX_INGREDIENTS = 20
const MAX_DOSE_CARDS = 10
const MAX_FIELD_LIST = 20
// 详情页**只接受**这一个查询参数（历史行的 uuid）；其余（尤其任何状态类字段）一律忽略。
const DETAIL_QUERY_KEYS = ['id']
// 从列表页带入的**引用快照**：只用于"定位"，**绝不**用于展示状态（见 parseDetailQuery 注释）。
let snapshot = null

function failure(code) { const e = new Error(code); e.code = code; return e }
function object(x) { return !!x && typeof x === 'object' && !Array.isArray(x) }
function keys(x, required) {
  if (!object(x) || required.some(k => !Object.prototype.hasOwnProperty.call(x, k)) ||
      Object.keys(x).some(k => required.indexOf(k) === -1)) throw failure('INVALID_RESPONSE')
}
function text(x, max) { return typeof x === 'string' && x.length > 0 && x.length <= max }
function nullableText(x, max) { return x === null || text(x, max) }
function one(x, values) { return values.indexOf(x) !== -1 }
function integer(x, min) { return typeof x === 'number' && Number.isSafeInteger(x) && x >= min }
function timestamp(value) {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 &&
    Number(m[3]) <= new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate() && Number.isFinite(Date.parse(value))
}
function stringList(value, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length > maxItems) return false
  return value.every(function (item) { return text(item, maxLength) })
}

function binding() { const s = auth.getSession(); return s && auth.isLoggedIn() ? { token: s.accessToken, epoch: auth.sessionEpoch() } : null }
function current(b) { const now = binding(); return !!b && !!now && b.token === now.token && b.epoch === now.epoch }

function validateMeta(meta) {
  keys(meta, ['request_id', 'contract_version', 'execution_mode'])
  if (typeof meta.request_id !== 'string' || !UUID.test(meta.request_id) ||
      meta.contract_version !== CONTRACT_VERSION || !one(meta.execution_mode, EXECUTION_MODES)) throw failure('INVALID_RESPONSE')
  return meta.execution_mode
}

function validateTargetRef(value) {
  keys(value, TARGET_REF_KEYS)
  if (!one(value.type, TARGET_REF_TYPES) || !text(value.id, 80) || !integer(value.revision, 1)) throw failure('INVALID_RESPONSE')
  return { type: value.type, id: value.id, revision: value.revision }
}

function validateHistory(value) {
  keys(value, HISTORY_KEYS)
  if (typeof value.id !== 'string' || !UUID.test(value.id) || !integer(value.revision, 1)) throw failure('INVALID_RESPONSE')
  if (!one(value.kind, HISTORY_KINDS)) throw failure('INVALID_RESPONSE')
  if (!identify.JOB_STATES || identify.JOB_STATES.indexOf(value.job_state) === -1) throw failure('INVALID_RESPONSE')
  if (!one(value.reference_state, REFERENCE_STATES)) throw failure('INVALID_RESPONSE')
  if (!timestamp(value.created_at)) throw failure('INVALID_RESPONSE')
  return {
    id: value.id, revision: value.revision, kind: value.kind,
    target_ref: validateTargetRef(value.target_ref), job_state: value.job_state,
    reference_state: value.reference_state, created_at: value.created_at
  }
}

// ---- OCR（#10 已合并契约面；本层只读且**不渲染**用量内容）-------------------

function validateIngredient(value) {
  keys(value, ['name', 'content_text', 'unit_text'])
  if (!text(value.name, 80) || !text(value.content_text, 80) || !text(value.unit_text, 80)) throw failure('INVALID_RESPONSE')
  return { name: value.name, content_text: value.content_text, unit_text: value.unit_text }
}

function validateLabelFields(value) {
  keys(value, ['registration_number', 'name', 'ingredients', 'dosage_form'])
  if (!nullableText(value.registration_number, 80) || !nullableText(value.name, 80) || !nullableText(value.dosage_form, 80)) {
    throw failure('INVALID_RESPONSE')
  }
  if (!Array.isArray(value.ingredients) || value.ingredients.length > MAX_INGREDIENTS) throw failure('INVALID_RESPONSE')
  return {
    registration_number: value.registration_number, name: value.name,
    ingredients: value.ingredients.map(validateIngredient), dosage_form: value.dosage_form
  }
}

/**
 * `Verification` 校验：`match_state`／`conflict_fields`／`missing_fields` 逐项严格校验
 * （页面直接呈现）；`registration` 与 `dose_cards` **只校验类型与上限**——
 * 因为本页**不渲染**它们的内部字段（登记用量属用药安全边界，一律引导到已核验资料页）。
 */
function validateVerification(value) {
  keys(value, ['match_state', 'registration', 'conflict_fields', 'missing_fields', 'dose_cards'])
  if (!one(value.match_state, MATCH_STATES)) throw failure('INVALID_RESPONSE')
  if (!(value.registration === null || object(value.registration))) throw failure('INVALID_RESPONSE')
  if (!stringList(value.conflict_fields, MAX_FIELD_LIST, 80)) throw failure('INVALID_RESPONSE')
  if (!stringList(value.missing_fields, MAX_FIELD_LIST, 80)) throw failure('INVALID_RESPONSE')
  if (!Array.isArray(value.dose_cards) || value.dose_cards.length > MAX_DOSE_CARDS) throw failure('INVALID_RESPONSE')
  return {
    match_state: value.match_state,
    has_registration: value.registration !== null,
    conflict_fields: value.conflict_fields.slice(),
    missing_fields: value.missing_fields.slice(),
    dose_card_count: value.dose_cards.length
  }
}

function validateOcr(value) {
  keys(value, ['id', 'revision', 'raw_fields', 'corrected_fields', 'verification', 'model_version'])
  if (typeof value.id !== 'string' || !UUID.test(value.id) || !integer(value.revision, 1)) throw failure('INVALID_RESPONSE')
  if (!text(value.model_version, 80)) throw failure('INVALID_RESPONSE')
  return {
    id: value.id, revision: value.revision,
    raw_fields: validateLabelFields(value.raw_fields),
    corrected_fields: validateLabelFields(value.corrected_fields),
    verification: validateVerification(value.verification),
    model_version: value.model_version
  }
}

// ---- 通用请求 ---------------------------------------------------------------

// 401/403 分流：口径统一由 `miniprogram/utils/auth.js` 的归因层决定（`attribution` / `failureFor`），
// 本文件**不再自持码表**。合并前这里与 `favorites-api.js` / `identify-api.js` /
// `speech-transcript.js` 各有一份同形实现（#393 引入的第三份），且对「403 无错误封套」与
// `ACCOUNT_INACTIVE` 的处理互相漂移；现全站只留 `auth.js` 一份：
//   401 ⇒ 会话失效并清会话；403 ⇒ 契约码原样带出，仅 `ACCOUNT_INACTIVE` 清会话；
//   403 无错误封套 ⇒ `SCOPE_DENIED` 且**不**清会话（见 `docs/verification/gy-i04-login-chain-20261021.md`）。

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
        if (r.statusCode === 401 || r.statusCode === 403) { reject(auth.failureFor(failure, r.statusCode, r.data)); return }
        try {
          const payload = r.data
          if (r.statusCode === 200) {
            keys(payload, ['data', 'meta'])
            resolve({
              data: payload.data, mode: validateMeta(payload.meta),
              etag: r.header && r.header.ETag ? r.header.ETag : null,
              cascade: r.header && r.header['X-GY-Cascade'] ? r.header['X-GY-Cascade'] : null
            })
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

/** `GET /history`：只列本人历史。 */
async function listHistory(cursor, limit) {
  const query = []
  if (cursor) query.push('cursor=' + encodeURIComponent(cursor))
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) throw failure('INVALID_INPUT')
    query.push('limit=' + limit)
  }
  const r = await request('GET', '/history' + (query.length ? '?' + query.join('&') : ''), {})
  keys(r.data, ['items', 'next_cursor'])
  if (!Array.isArray(r.data.items) || !(r.data.next_cursor === null || text(r.data.next_cursor, 2048))) throw failure('INVALID_RESPONSE')
  return { items: r.data.items.map(validateHistory), nextCursor: r.data.next_cursor, mode: r.mode }
}

/** `DELETE /history/{id}`：删除历史行；`X-GY-Cascade` 如实回传级联披露（**非契约**标记）。 */
async function deleteHistory(historyId, revision) {
  if (typeof historyId !== 'string' || !UUID.test(historyId) || !integer(revision, 1)) throw failure('INVALID_INPUT')
  const r = await request('DELETE', '/history/' + historyId, {
    ifMatch: '"' + revision + '"', idempotencyKey: newKey('his-delete')
  })
  keys(r.data, ['accepted'])
  if (r.data.accepted !== true) throw failure('INVALID_RESPONSE')
  return { accepted: true, mode: r.mode, cascade: r.cascade }
}

/** `GET /ocr/{id}`（#10 的面；本层复用同一请求纪律）。 */
async function getOcr(ocrId) {
  if (typeof ocrId !== 'string' || !UUID.test(ocrId)) throw failure('INVALID_INPUT')
  const r = await request('GET', '/ocr/' + ocrId, {})
  const ocr = validateOcr(r.data)
  if (ocr.id !== ocrId) throw failure('INVALID_RESPONSE')
  return { ocr: ocr, mode: r.mode }
}

// ---- 纯视图模型（可单测；不触碰 wx / 网络） --------------------------------

/**
 * 解析详情页查询参数。
 *
 * **只接受** `id`（历史行的 uuid）：任何随链接夹带的状态字段（`job_state`／`reference_state`／
 * `created_at` 等）都被**忽略**并如实回报，因此"旧链接 + 缓存状态"不可能让页面显示一个
 * 与服务端实时读取不一致的状态（issue #16 的针对性负例）。
 * 记录本身**没有**契约 `GET /history/{id}`，所以详情的任务状态与可见性一律由
 * `locateHistory()` 的**实时列表读取**给出，不由链接承载。
 */
function parseDetailQuery(options) {
  const q = options || {}
  const ignored = Object.keys(q).filter(function (key) { return DETAIL_QUERY_KEYS.indexOf(key) === -1 })
  const id = typeof q.id === 'string' && UUID.test(q.id) ? q.id : null
  return { id: id, ignored: ignored, valid: id !== null }
}

/** 列表页写入**引用快照**（仅含定位所需的最小字段，不含任何"当时的状态"以外的判定依据）。 */
function remember(items) {
  const map = {}
  ;(items || []).forEach(function (item) {
    map[item.id] = {
      id: item.id,
      revision: item.revision,
      kind: item.kind,
      targetId: item.target_ref.id,
      targetType: item.target_ref.type
    }
  })
  snapshot = map
}

/** 读取引用快照（**只用于定位**；调用方不得把它当作状态来源）。 */
function expected(id) {
  return snapshot && snapshot[id] ? Object.assign({}, snapshot[id]) : null
}

function clearSelection() { snapshot = null }

/**
 * 定位一条历史记录：
 *   1. 先做**实时读取**（`GET /history` 第一页）：命中即返回实时状态（`locatedBy: 'live'`）；
 *   2. 实时读不到（例如记录在第 2 页之后）时，退回列表页带入的**引用快照**，
 *      但**不携带任何状态**（`jobState`/`referenceState` 为 null）——页面必须如实说明
 *      "状态未从实时读取取得"，而不是展示过期状态（`locatedBy: 'snapshot'`）；
 *   3. 都没有 ⇒ `null`（页面显示"不存在/已删除/不属于当前账号"）。
 */
async function locateHistory(id, limit) {
  if (typeof id !== 'string' || !UUID.test(id)) throw failure('INVALID_INPUT')
  const page = await listHistory('', limit || PAGE_LIMIT_MAX)
  const live = page.items.filter(function (item) { return item.id === id })[0]
  if (live) {
    return { locatedBy: 'live', kind: live.kind, targetId: live.target_ref.id, targetType: live.target_ref.type,
      historyRevision: live.revision, jobState: live.job_state, referenceState: live.reference_state,
      createdAt: live.created_at, mode: page.mode }
  }
  const remembered = expected(id)
  if (remembered) {
    return { locatedBy: 'snapshot', kind: remembered.kind, targetId: remembered.targetId, targetType: remembered.targetType,
      historyRevision: remembered.revision, jobState: null, referenceState: null, createdAt: null, mode: page.mode }
  }
  return null
}

/** 历史列表项的呈现口径（时间／任务类型／状态／可见性）。 */
function historyItemView(item) {
  const stateView = identify.describeJobState(item.job_state)
  return {
    id: item.id,
    revision: item.revision,
    kind: item.kind,
    kindLabel: item.kind === 'recognition' ? '识草' : '标签识别',
    targetId: item.target_ref.id,
    targetType: item.target_ref.type,
    createdAt: item.created_at,
    createdText: item.created_at.replace('T', ' ').replace(/\.\d+/, '').replace(/Z$/, ' UTC'),
    state: item.job_state,
    stateLabel: stateView.title,
    stateDesc: stateView.desc,
    tone: stateView.tone,
    failed: stateView.success !== true,
    referenceState: item.reference_state,
    referenceLabel: item.reference_state === 'available' ? '目标当前可读' : '目标当前不可用',
    // 不可用时**不**给出目标正文（服务端也没有给），只说明"不可用"。
    navigable: item.reference_state === 'available'
  }
}

/**
 * 识别详情呈现：**模型候选**与**人工选择**两个独立区块。
 *
 * - `modelCandidates`：模型给出的 Top3（含自报分数），标注"未人工确认"；
 * - `manualSelection`：用户确认的物种（`selected_species_id`），可为"未选择"；
 * - `sourceVersion`：`model_version`（来源版本）；
 * - 纯函数；`recognized` 只在 `job_state === 'succeeded'` 时为真（沿用 identify-api 口径）。
 */
function recognitionDetailView(recognition, jobState) {
  const recognized = identify.isSuccessState(jobState)
  const candidates = recognition.candidates.map(function (candidate) {
    return {
      rank: candidate.rank,
      species_id: candidate.species_id,
      model_score: candidate.model_score,
      scoreText: candidate.model_score === null ? '无分数' : Math.round(candidate.model_score * 100) + '%'
    }
  }).sort(function (a, b) { return a.rank - b.rank })
  const selected = recognition.selected_species_id
  return {
    recognized: recognized,
    modelCandidates: candidates,
    modelCandidateNote: recognized
      ? '以下为模型候选与其自报分数，未人工确认；分数不是准确率。'
      : '任务未成功完成，本页不把任何候选当作结果。',
    manualSelection: {
      selected: selected,
      present: selected !== null,
      label: selected === null ? '未人工选择' : '已人工选择',
      note: '人工选择是用户自己的确认动作，与上方模型候选分开记录；'
        + '收藏或识别都不会自动变成"已使用"。'
    },
    candidateSelectionSeparated: true,
    uncertaintyReasons: recognition.uncertainty_reasons.slice(),
    sourceVersion: recognition.model_version,
    revision: recognition.revision
  }
}

/**
 * 冲突字段 token → 人话标签。**只用于页面显示**：`conflictFields` 原值照录不动
 * （token 原样保留，便于复核与后续映射），这里只补一层中文。
 *
 * `source.validity` / `source.review_status` 不是某一格读错，而是这条登记记录**自身**
 * 已失效/被拒（服务端在 `conflict_fields` 里用 `source.<字段>` 表达，见
 * `services/api/src/ocr/state.ts` 的 `registrationStateConflicts`）。
 * 未知 token **原样返回**：不猜、不改写成看起来更确定的说法。
 */
var CONFLICT_FIELD_LABELS = {
  registration_number: '登记证号',
  dosage_form: '剂型',
  ingredients: '有效成分',
  'source.validity': '登记记录已失效或撤销',
  'source.review_status': '登记记录已被拒绝核对'
}

function conflictFieldLabels(list) {
  return list.map(function (token) {
    return Object.prototype.hasOwnProperty.call(CONFLICT_FIELD_LABELS, token) ? CONFLICT_FIELD_LABELS[token] : token
  })
}

/** 标签（OCR）详情呈现：**模型原始字段**与**人工更正字段**、核对结果三者分开。 */
function ocrDetailView(ocr) {
  function fieldView(fields) {
    return {
      registration_number: fields.registration_number,
      name: fields.name,
      dosage_form: fields.dosage_form,
      ingredients: fields.ingredients.map(function (item) {
        return item.name + ' ' + item.content_text + item.unit_text
      })
    }
  }
  const verification = ocr.verification
  return {
    raw: fieldView(ocr.raw_fields),
    corrected: fieldView(ocr.corrected_fields),
    correctedDiffers: JSON.stringify(fieldView(ocr.raw_fields)) !== JSON.stringify(fieldView(ocr.corrected_fields)),
    verification: {
      matchState: verification.match_state,
      matchLabel: {
        matched: '已匹配到登记资料', no_match: '未匹配到登记资料', ambiguous: '存在多条可能匹配',
        conflict: '与登记资料冲突', insufficient: '信息不足', unavailable: '核对服务不可用'
      }[verification.match_state] || '状态未知',
      hasRegistration: verification.has_registration,
      conflictFields: verification.conflict_fields.slice(),
      conflictLabels: conflictFieldLabels(verification.conflict_fields),
      missingFields: verification.missing_fields.slice(),
      doseCardCount: verification.dose_card_count
    },
    sourceVersion: ocr.model_version,
    revision: ocr.revision,
    // 用药安全：本页不渲染用量卡正文与登记用量数字。
    doseSafetyNote: '本页不显示用量与配比；登记用量以核验资料页为准，本页不构成用药建议。'
  }
}

function messageFor(e) {
  const code = e && e.code
  return {
    SESSION_REQUIRED: '登录状态已失效，请重新登录后再查看历史。',
    SESSION_CHANGED: '会话已变化，请重新进入本页。',
    NETWORK_UNCERTAIN: '网络未能确认结果，已停止显示，请重试。',
    NOT_FOUND: '该记录不存在、已删除、或不属于当前账号。',
    INVALID_INPUT: '请求参数不合法，已停止。',
    INVALID_RESPONSE: '服务端响应无法核对，已停止显示，请重试。',
    REVISION_CONFLICT: '记录已被更新，请刷新后重试。',
    REVISION_REQUIRED: '缺少版本信息，请刷新后重试。',
    IDEMPOTENCY_KEY_REQUIRED: '请求缺少幂等键，请重试。',
    IDEMPOTENCY_CONFLICT: '同一幂等键被复用于不同请求，请重试。',
    SCOPE_DENIED: '当前会话无权读取该记录。',
    CONSENT_REQUIRED: '缺少必要的授权同意，无法读取或删除识别历史。',
    ACCOUNT_INACTIVE: '账号当前不可用（已停用或已注销），无法读取或删除识别历史。',
    PROVIDER_UNAVAILABLE: '历史服务当前不可用（真实持久存储未接入），不会用本地数据顶替。',
    INVALID_CURSOR: '翻页位置已失效，请重新读取第一页。',
    UNAVAILABLE: '历史服务暂不可用，已停止显示，请重试。'
  }[code] || '历史服务暂不可用，已停止显示，请重试。'
}

/** 级联删除披露（**非契约**标记）对应的人话说明。 */
function cascadeNote(cascade) {
  return {
    initiated: '已同时启动关联识别/OCR 私有结果、媒体与外发删除的删除流程（不等于已完成）。',
    unwired: '关联识别/OCR 私有结果、媒体与外发删除的流程尚未接线：本次只删除了历史记录本身。',
    failed: '关联删除流程启动失败：本次只删除了历史记录本身。',
    null: '未取得级联状态。'
  }[cascade === undefined ? null : cascade] || '未取得级联状态。'
}

module.exports = {
  HISTORY_KINDS: HISTORY_KINDS.slice(),
  HISTORY_KEYS: HISTORY_KEYS.slice(),
  DETAIL_QUERY_KEYS: DETAIL_QUERY_KEYS.slice(),
  PAGE_LIMIT_MAX: PAGE_LIMIT_MAX,
  CONTRACT_VERSION: CONTRACT_VERSION,
  listHistory: listHistory,
  deleteHistory: deleteHistory,
  getOcr: getOcr,
  parseDetailQuery: parseDetailQuery,
  remember: remember,
  expected: expected,
  clearSelection: clearSelection,
  locateHistory: locateHistory,
  historyItemView: historyItemView,
  recognitionDetailView: recognitionDetailView,
  ocrDetailView: ocrDetailView,
  conflictFieldLabels: conflictFieldLabels,
  cascadeNote: cascadeNote,
  messageFor: messageFor,
  newKey: newKey,
  validId: function (id) { return typeof id === 'string' && UUID.test(id) }
}
