// GY-I15（#15）阶段 2 · 社区 HTTP 消费层（小程序侧）。
//
// 纪律（与 utils/knowledge-api.js 同口径）：
// 1. **不缓存内容、不做离线成功回落**：任何失败都如实抛出错误码，由页面收口到 state-view；
// 2. 只消费契约已声明的路径/字段；封套、实体形状、闭集、头部逐项核对，不符即 INVALID_RESPONSE；
// 3. 身份只来自服务端签发的会话令牌；客户端**不**声明 userId/作者/审核状态；
// 4. 写路径按契约带 `Idempotency-Key`，改/删/点赞带 `If-Match`（= 详情拿到的强 ETag 版本号）。
// 5. **401/403 归因不在本文件**：一律委托 `utils/auth.js` 的 `attribution()` / `failureFor()`
//    （单一事实源，码表由 `utils/states.js` 的 `CODE_KIND` 反推）。本文件只保留**本域措辞**
//    （`MESSAGES` 里的 403 三码文案）和两个委托判定 `sessionFailure()` / `forbidden()`；
//    403 不折叠成"登录失效"，也不清会话（`ACCOUNT_INACTIVE` 例外：码保留 + 清会话）。
//
// 未取得（如实标注）：正式微信身份/真机联调未做；`real` 模式服务端整域 503，
// 页面按"服务暂不可用"如实展示，绝不显示本地伪造帖子。
const auth = require('./auth')
const runtime = require('../config/runtime')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VISIBILITY = ['private', 'published', 'hidden', 'deleted']
const AUDIT_STATES = ['pending', 'approved', 'rejected', 'quarantined']
const AUTHOR_STATES = ['active', 'anonymized']
const REFERENCE_STATES = ['available', 'unavailable']
const REPORT_REASONS = ['dangerous', 'privacy', 'advertising', 'misleading', 'other']
const REPORT_STATES = ['received', 'isolated', 'closed']
const KNOWLEDGE_TYPES = ['species', 'herbicide', 'scheme']

const POST_FIELDS = ['id', 'revision', 'author', 'title', 'body', 'crop_id', 'region_code', 'media_ids',
  'visibility', 'audit_state', 'created_at', 'updated_at', 'media', 'linked_knowledge_ref', 'linked_knowledge']
const COMMENT_FIELDS = ['id', 'revision', 'post_id', 'author', 'body', 'visibility', 'audit_state', 'created_at']
const REPORT_FIELDS = ['id', 'revision', 'target_ref', 'state', 'reason_code']

function failure(code, extra) {
  const error = new Error(code)
  error.code = code
  if (extra) error.details = extra
  return error
}
function object(x) { return !!x && typeof x === 'object' && !Array.isArray(x) }
function text(x, max) { return typeof x === 'string' && x.length > 0 && x.length <= max }
function one(x, values) { return values.indexOf(x) !== -1 }
function uuid(x) { return typeof x === 'string' && UUID.test(x) }
function nullableText(x, max) { return x === null || text(x, max) }
function timestamp(value) {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 &&
    Number(m[3]) <= new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate() && Number.isFinite(Date.parse(value))
}
function keys(x, required, optional) {
  if (!object(x) || required.some(function (k) { return !Object.prototype.hasOwnProperty.call(x, k) }) ||
    Object.keys(x).some(function (k) { return required.concat(optional || []).indexOf(k) === -1 })) {
    throw failure('INVALID_RESPONSE')
  }
}
function responseMeta(meta) {
  keys(meta, ['request_id', 'contract_version', 'execution_mode'])
  if (!uuid(meta.request_id) || meta.contract_version !== '1.0.0' ||
    !one(meta.execution_mode, ['real', 'stub', 'preset_demo'])) throw failure('INVALID_RESPONSE')
  return meta
}
function binding() {
  const session = auth.getSession()
  return session && auth.isLoggedIn() ? { token: session.accessToken, epoch: auth.sessionEpoch() } : null
}
function current(b) {
  const now = binding()
  return !!b && !!now && b.token === now.token && b.epoch === now.epoch
}

function validAuthor(author) {
  keys(author, ['display_name', 'display_id', 'state', 'avatar_media_id', 'revision', 'avatar_media'])
  if (!text(author.display_name, 80) || !text(author.display_id, 80) || !one(author.state, AUTHOR_STATES) ||
    !Number.isSafeInteger(author.revision) || author.revision < 1) throw failure('INVALID_RESPONSE')
  if (author.avatar_media_id !== null && !uuid(author.avatar_media_id)) throw failure('INVALID_RESPONSE')
  if (author.avatar_media !== null) mediaRef(author.avatar_media)
}

/** 注销作者默认头像字（与 `community/authors.ts::anonymize` 的 `display_name='已注销用户'` 对齐；固定值，不取原头像）。 */
const ANONYMIZED_AVATAR = '已'

/**
 * 作者展示投影（**单一实现**，列表页/详情页/评论共用）：把契约 `Author` 投影成展示字段，
 * 与已合服务端（`community/authors.ts::anonymize` / `community/personal-info.ts`）对齐：
 *   - `name`：前台显示名。注销作者的服务端投影就是「已注销用户」，这里**原样透传**，
 *     不另造第二套文案、不覆盖 `display_name`；
 *   - `anonymized`：`state === 'anonymized'`（页面据此渲染默认头像与「已注销」标记）；
 *   - `avatar`：默认头像字。契约 `avatar_media` 未接线／已注销时一律回落默认头像，
 *     **不取原头像坐标**；注销作者用固定「已」，活跃假名作者取显示名首字（demo 同形态）。
 */
function authorView(author) {
  const anonymized = author.state === 'anonymized'
  return {
    name: author.display_name,
    anonymized: anonymized,
    avatar: anonymized ? ANONYMIZED_AVATAR : author.display_name.slice(0, 1)
  }
}

function mediaRef(ref) {
  keys(ref, ['media_id', 'media_revision'])
  if (!uuid(ref.media_id) || !Number.isSafeInteger(ref.media_revision) || ref.media_revision < 1) {
    throw failure('INVALID_RESPONSE')
  }
}
function knowledgeTarget(target) {
  keys(target, ['type', 'id', 'revision'])
  if (!one(target.type, KNOWLEDGE_TYPES) || !text(target.id, 80) ||
    !Number.isSafeInteger(target.revision) || target.revision < 1) throw failure('INVALID_RESPONSE')
}
function linkedKnowledge(link) {
  if (link === null) return
  keys(link, ['target_ref', 'reference_state', 'unavailable_reason', 'summary'])
  knowledgeTarget(link.target_ref)
  if (!one(link.reference_state, REFERENCE_STATES)) throw failure('INVALID_RESPONSE')
  if (link.unavailable_reason !== null && link.unavailable_reason !== 'TARGET_UNAVAILABLE') throw failure('INVALID_RESPONSE')
  if (link.summary === null) {
    if (link.reference_state === 'available') throw failure('INVALID_RESPONSE')
    return
  }
  keys(link.summary, ['title'])
  if (!text(link.summary.title, 200)) throw failure('INVALID_RESPONSE')
}
function validPost(post) {
  keys(post, POST_FIELDS)
  if (!uuid(post.id) || !Number.isSafeInteger(post.revision) || post.revision < 1 ||
    !text(post.title, 120) || !text(post.body, 8000) || !one(post.visibility, VISIBILITY) ||
    !one(post.audit_state, AUDIT_STATES) || !timestamp(post.created_at) || !timestamp(post.updated_at) ||
    !Array.isArray(post.media_ids) || post.media_ids.length > 3 || !Array.isArray(post.media) || post.media.length > 3) {
    throw failure('INVALID_RESPONSE')
  }
  validAuthor(post.author)
  post.media_ids.forEach(function (id) { if (!uuid(id)) throw failure('INVALID_RESPONSE') })
  post.media.forEach(mediaRef)
  if (!nullableText(post.crop_id, 80)) throw failure('INVALID_RESPONSE')
  if (post.region_code !== null && !/^33[0-9]{4}$/.test(post.region_code)) throw failure('INVALID_RESPONSE')
  if (post.linked_knowledge_ref !== null) knowledgeTarget(post.linked_knowledge_ref)
  linkedKnowledge(post.linked_knowledge)
  if ((post.linked_knowledge_ref === null) !== (post.linked_knowledge === null)) throw failure('INVALID_RESPONSE')
  return post
}
function validComment(comment) {
  keys(comment, COMMENT_FIELDS)
  if (!uuid(comment.id) || !Number.isSafeInteger(comment.revision) || comment.revision < 1 || !uuid(comment.post_id) ||
    !text(comment.body, 4000) || !one(comment.visibility, VISIBILITY) || !one(comment.audit_state, AUDIT_STATES) ||
    !timestamp(comment.created_at)) throw failure('INVALID_RESPONSE')
  validAuthor(comment.author)
  return comment
}
function validReport(report) {
  keys(report, REPORT_FIELDS)
  if (!uuid(report.id) || !Number.isSafeInteger(report.revision) || report.revision < 1 ||
    !one(report.state, REPORT_STATES) || !text(report.reason_code, 80)) throw failure('INVALID_RESPONSE')
  keys(report.target_ref, ['type', 'id', 'revision'])
  if (!one(report.target_ref.type, ['post', 'comment']) || !text(report.target_ref.id, 80) ||
    !Number.isSafeInteger(report.target_ref.revision) || report.target_ref.revision < 1) throw failure('INVALID_RESPONSE')
  return report
}
function page(data, validate, limit) {
  keys(data, ['items', 'next_cursor'])
  if (!Array.isArray(data.items) || data.items.length > (limit || 20) || data.items.length > 50 ||
    !(data.next_cursor === null || text(data.next_cursor, 2048))) throw failure('INVALID_RESPONSE')
  const seen = []
  data.items.forEach(function (item) {
    validate(item)
    if (seen.indexOf(item.id) !== -1) throw failure('INVALID_RESPONSE')
    seen.push(item.id)
  })
  return { items: data.items, nextCursor: data.next_cursor }
}
function query(params) {
  const keysIn = Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== null })
  return keysIn.sort().map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]) }).join('&')
}

/** 契约封套 + 错误封套的统一解析（成功只认 200/201，其余按错误码抛出）。 */
function send(method, path, options) {
  const b = binding()
  if (!b || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  const opts = options || {}
  const header = { authorization: 'Bearer ' + b.token, 'Cache-Control': 'no-cache' }
  if (opts.body !== undefined) header['content-type'] = 'application/json'
  if (opts.idempotencyKey !== undefined) header['Idempotency-Key'] = opts.idempotencyKey
  if (opts.ifMatch !== undefined) header['If-Match'] = '"' + opts.ifMatch + '"'
  return new Promise(function (resolve, reject) {
    const request = {
      url: runtime.apiBaseUrl + path, method: method, timeout: 15000, header: header,
      success: function (response) {
        if (!current(b)) { reject(failure('SESSION_CHANGED')); return }
        if (response.statusCode === 401 || response.statusCode === 403) {
          reject(auth.failureFor(failure, response.statusCode, response.data))
          return
        }
        let body = response.data
        try {
          keys(body, ['data', 'meta'])
          const meta = responseMeta(body.meta)
          if (response.statusCode === 200 || response.statusCode === 201) {
            resolve({ data: body.data, mode: meta.execution_mode, status: response.statusCode })
            return
          }
          reject(failure('UNEXPECTED_STATUS'))
        } catch (parseError) {
          // 错误封套：{ error: { code, message, retryable, details }, meta }
          try {
            keys(body, ['error', 'meta'])
            responseMeta(body.meta)
            keys(body.error, ['code', 'message', 'retryable', 'details'])
            if (typeof body.error.code !== 'string' || typeof body.error.message !== 'string' ||
              typeof body.error.retryable !== 'boolean' || !Array.isArray(body.error.details)) {
              throw failure('INVALID_RESPONSE')
            }
            const codes = body.error.details
              .filter(function (d) { return object(d) && typeof d.code === 'string' })
              .map(function (d) { return d.code })
            reject(failure(body.error.code, codes))
          } catch (ignored) {
            reject(parseError && parseError.code ? parseError : failure('INVALID_RESPONSE'))
          }
        }
      },
      fail: function () { reject(failure(current(b) ? 'NETWORK_UNCERTAIN' : 'SESSION_CHANGED')) }
    }
    if (opts.body !== undefined) request.data = opts.body
    wx.request(request)
  })
}

/** 幂等键（契约要求 8..128 字符）。 */
function newIdempotencyKey() {
  return 'gyc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

function listPosts(input) {
  const params = input || {}
  const q = query({
    cursor: params.cursor, limit: params.limit,
    crop_id: params.crop_id, region_code: params.region_code,
    mine: params.mine === true ? 'true' : undefined
  })
  return send('GET', '/posts' + (q ? '?' + q : '')).then(function (r) {
    const data = page(r.data, validPost, params.limit)
    return { items: data.items, nextCursor: data.nextCursor, mode: r.mode }
  })
}

function createPost(input) {
  return send('POST', '/posts', { body: input, idempotencyKey: newIdempotencyKey() })
    .then(function (r) { return { post: validPost(r.data), mode: r.mode } })
}

function getPost(id) {
  if (!uuid(id)) return Promise.reject(failure('INVALID_INPUT'))
  return send('GET', '/posts/' + encodeURIComponent(id))
    .then(function (r) { return { post: validPost(r.data), mode: r.mode } })
}

/**
 * 读取单条评论（契约 `GET /comments/{id}`，服务端 `routes/community.ts` 已实现）。
 *
 * 为什么需要它：消息的 `target_ref` 可能指向**评论**（`like_created` 赞了评论、评论的审核结果），
 * 而此时只有评论 id；社区详情页只接**帖子** uuid（`pages/communitydetail/communitydetail.js`
 * 把 `?id=` 当帖子 id 用），所以要按契约取回 `comment.post_id` 再跳转，不把评论 id 当帖子 id。
 * 作者可读自己的评论（含待审），他人仅可读公开版本 —— 服务端 `readableComment` 判定，本模块不猜。
 * 只读、不缓存、不落盘。
 */
function getComment(id) {
  if (!uuid(id)) return Promise.reject(failure('INVALID_INPUT'))
  return send('GET', '/comments/' + encodeURIComponent(id))
    .then(function (r) { return { comment: validComment(r.data), mode: r.mode } })
}

function editPost(id, input, revision) {
  if (!uuid(id) || !Number.isSafeInteger(revision) || revision < 1) return Promise.reject(failure('INVALID_INPUT'))
  return send('PATCH', '/posts/' + encodeURIComponent(id), {
    body: input, idempotencyKey: newIdempotencyKey(), ifMatch: revision
  }).then(function (r) { return { post: validPost(r.data), mode: r.mode } })
}

function deletePost(id, revision) {
  if (!uuid(id) || !Number.isSafeInteger(revision) || revision < 1) return Promise.reject(failure('INVALID_INPUT'))
  return send('DELETE', '/posts/' + encodeURIComponent(id), {
    idempotencyKey: newIdempotencyKey(), ifMatch: revision
  }).then(function (r) {
    keys(r.data, ['accepted'])
    if (r.data.accepted !== true) throw failure('INVALID_RESPONSE')
    return { accepted: true, mode: r.mode }
  })
}

function listComments(postId, input) {
  if (!uuid(postId)) return Promise.reject(failure('INVALID_INPUT'))
  const params = input || {}
  const q = query({ cursor: params.cursor, limit: params.limit })
  return send('GET', '/posts/' + encodeURIComponent(postId) + '/comments' + (q ? '?' + q : ''))
    .then(function (r) {
      const data = page(r.data, validComment, params.limit)
      return { items: data.items, nextCursor: data.nextCursor, mode: r.mode }
    })
}

function createComment(postId, body, parentRevision) {
  if (!uuid(postId) || typeof body !== 'string' || body.length < 1 || body.length > 4000 ||
    !Number.isSafeInteger(parentRevision) || parentRevision < 1) return Promise.reject(failure('INVALID_INPUT'))
  return send('POST', '/posts/' + encodeURIComponent(postId) + '/comments', {
    body: { body: body }, idempotencyKey: newIdempotencyKey(), ifMatch: parentRevision
  }).then(function (r) { return { comment: validComment(r.data), mode: r.mode } })
}

function editComment(id, body, revision) {
  if (!uuid(id) || typeof body !== 'string' || body.length < 1 || body.length > 4000 ||
    !Number.isSafeInteger(revision) || revision < 1) return Promise.reject(failure('INVALID_INPUT'))
  return send('PATCH', '/comments/' + encodeURIComponent(id), {
    body: { body: body }, idempotencyKey: newIdempotencyKey(), ifMatch: revision
  }).then(function (r) { return { comment: validComment(r.data), mode: r.mode } })
}

function deleteComment(id, revision) {
  if (!uuid(id) || !Number.isSafeInteger(revision) || revision < 1) return Promise.reject(failure('INVALID_INPUT'))
  return send('DELETE', '/comments/' + encodeURIComponent(id), {
    idempotencyKey: newIdempotencyKey(), ifMatch: revision
  }).then(function (r) {
    keys(r.data, ['accepted'])
    if (r.data.accepted !== true) throw failure('INVALID_RESPONSE')
    return { accepted: true, mode: r.mode }
  })
}

function like(kind, id, revision, on) {
  if (!uuid(id) || !Number.isSafeInteger(revision) || revision < 1) return Promise.reject(failure('INVALID_INPUT'))
  const base = kind === 'post' ? '/posts/' : '/comments/'
  return send(on ? 'PUT' : 'DELETE', base + encodeURIComponent(id) + '/like', {
    idempotencyKey: newIdempotencyKey(), ifMatch: revision
  }).then(function (r) {
    keys(r.data, ['accepted'])
    if (r.data.accepted !== true) throw failure('INVALID_RESPONSE')
    return { accepted: true, mode: r.mode }
  })
}

function createReport(targetRef, reasonCode, detail) {
  if (!object(targetRef) || !one(targetRef.type, ['post', 'comment']) || !text(targetRef.id, 80) ||
    !Number.isSafeInteger(targetRef.revision) || targetRef.revision < 1 ||
    !one(reasonCode, REPORT_REASONS)) return Promise.reject(failure('INVALID_INPUT'))
  const body = { target_ref: targetRef, reason_code: reasonCode }
  if (detail !== undefined && detail !== null && detail !== '') body.detail = detail
  return send('POST', '/reports', { body: body, idempotencyKey: newIdempotencyKey() })
    .then(function (r) { return { report: validReport(r.data), mode: r.mode } })
}

function getOwnReport(id) {
  if (!uuid(id)) return Promise.reject(failure('INVALID_INPUT'))
  return send('GET', '/reports/' + encodeURIComponent(id))
    .then(function (r) { return { report: validReport(r.data), mode: r.mode } })
}

/** 审核未通过时服务端回传的规则层原因码（供页面如实展示，不解释成"已通过"）。 */
function reasonCodes(error) {
  return error && Array.isArray(error.details) ? error.details.slice(0, 6) : []
}

/**
 * 页面收口用的两个**委托**判定（本文件不自持码表）：
 *
 * - `sessionFailure(error)`：这是不是「会话没建立/已失效」类错误 ⇒ 页面应回到登录门禁（`guest`）。
 *   闭集来自 `utils/auth.js` 的 `SESSION_LOSS_CODES`（由 B7 的 `states.CODE_KIND` 反推），
 *   所以除契约 401 的 `SESSION_REQUIRED` 外，客户端自造码 `SESSION_CHANGED`（在途响应晚于
 *   会话变化／切账号）同样归此类 —— 改前页面只比 `=== 'SESSION_REQUIRED'`，`SESSION_CHANGED`
 *   会被当成普通失败停在错误页，用户既没被告知要重登、也拿不到正确的门禁态。
 * - `forbidden(error)`：这是不是契约 403 闭集（`SCOPE_DENIED` / `CONSENT_REQUIRED` /
 *   `ACCOUNT_INACTIVE`）⇒ 页面把**整页**收到 denied 语气，而不是一句「失败了，请重试」。
 *   `ACCOUNT_INACTIVE` 的统一层口径是「码保留 + 清会话」（令牌永久不可用），页面据此仍按
 *   denied 呈现，不谎称「登录过期」。
 *
 * 两个函数都只读 `error.code`，不解析封套、不改会话；归因本身只有一个实现（`auth.attribution`）。
 */
function sessionFailure(error) {
  return !!error && auth.isSessionLossCode(error.code)
}
function forbidden(error) {
  return !!error && auth.isForbiddenCode(error.code)
}

function modeNote(mode) {
  if (mode === 'real') return '服务端真实模式；本机未接真实审核供应商时不会返回成功。'
  if (mode === 'preset_demo') return '预设演示数据，不代表真实审核结果。'
  if (mode === 'stub') return '替身服务数据，仅供联调，不代表真实社区内容或审核结论。'
  return '社区内容需重新查询，失败时不会改用本地数据。'
}

const MESSAGES = {
  SESSION_REQUIRED: '登录状态已失效，请重新登录。',
  SESSION_CHANGED: '会话已变化，请重新进入社区。',
  NETWORK_UNCERTAIN: '网络未能确认当前内容，已清空，请重试。',
  NOT_FOUND: '内容不存在、已下架或当前不可见。',
  REVISION_CONFLICT: '内容已更新，请刷新后重试。',
  OBJECT_UNAVAILABLE: '关联资料或目标当前不可用，操作未生效。',
  INPUT_UNCERTAIN: '内容筛查未完成（或未通过），本条不会公开。',
  IDEMPOTENCY_KEY_REQUIRED: '请求缺少幂等键，请重试。',
  REVISION_REQUIRED: '缺少版本信息，请刷新后重试。',
  INVALID_CURSOR: '列表已过期，请重新进入社区。',
  PROVIDER_UNAVAILABLE: '社区服务暂不可用（服务端未接线真实存储），请稍后再试。',
  SCOPE_DENIED: '当前会话无权访问社区。',
  CONSENT_REQUIRED: '缺少用途授权（403 CONSENT_REQUIRED）：社区公开发布需要「公开发布」用途授权，未授权时不会发布。',
  ACCOUNT_INACTIVE: '账号当前不可用（403 ACCOUNT_INACTIVE）：请重新登录后再试。',
  INVALID_RESPONSE: '服务端响应无法核对，已清空，请重试。',
  UNEXPECTED_STATUS: '服务端返回了未预期的状态，已清空，请重试。'
}
function message(error) {
  const code = error && error.code
  if (code === 'INVALID_REQUEST') {
    const codes = reasonCodes(error)
    return codes.length
      ? '内容未通过先行审核（原因码：' + codes.join('、') + '），未发布。'
      : '请求不符合契约要求，未提交。'
  }
  return MESSAGES[code] || '社区服务暂不可用，已清空，请重试。'
}

module.exports = {
  newIdempotencyKey: newIdempotencyKey,
  binding: binding,
  current: current,
  validId: uuid,
  authorView: authorView,
  listPosts: listPosts,
  createPost: createPost,
  getPost: getPost,
  getComment: getComment,
  editPost: editPost,
  deletePost: deletePost,
  listComments: listComments,
  createComment: createComment,
  editComment: editComment,
  deleteComment: deleteComment,
  likePost: function (id, revision) { return like('post', id, revision, true) },
  unlikePost: function (id, revision) { return like('post', id, revision, false) },
  likeComment: function (id, revision) { return like('comment', id, revision, true) },
  unlikeComment: function (id, revision) { return like('comment', id, revision, false) },
  createReport: createReport,
  getOwnReport: getOwnReport,
  reportReasons: REPORT_REASONS,
  reasonCodes: reasonCodes,
  sessionFailure: sessionFailure,
  forbidden: forbidden,
  modeNote: modeNote,
  message: message
}
