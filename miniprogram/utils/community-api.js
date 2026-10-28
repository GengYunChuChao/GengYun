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

// ===========================================================================
// 审核结论的用户可见文案（**全仓唯一一份**：三页 + 适配层都从这里取，不再各写一套）
//
// 要解决的问题（侦察 S3）：`audit_state` 是四值枚举
// （`pending` / `approved` / `rejected` / `quarantined`，见契约 `AuditState`），
// 但改前小程序只有三档措辞（「已通过先行审核」/「未公开／待审」/「已下架」），
// 于是「隔离待复核（`quarantined`）」与「明确驳回（`rejected`）」**对用户是同一句话**，
// 而且被驳回的内容还会被告知「待审」（等于说反了：不会再有人审它）。
//
// 口径（逐条可核对，不解释成服务端没说过的事）：
//   1. 两种结论**必须能区分**：隔离 ⇒ 已提交 + 等待人工复核 + 「稍后再看」的期待；
//      驳回 ⇒ 未通过 + 理由（理由码给到就翻成人话，没给就只说未通过，**不编**）。
//   2. 理由码**不透传成英文裸码**：已知码 ⇒ 人话（码：X）；未知码 ⇒ 「未知原因（码：X）」。
//   3. 未知 `audit_state` / 不认识的组合 **fail-closed 到「待审」**：绝不说成通过，也不说成系统错误。
//
// 为什么放在适配层而不是页面里：`community-api.js` 已经是本域**措辞**的单一所有者
// （`MESSAGES` / `modeNote`），三个页面 require 它拿数据，也就一并拿到同一份文案；
// 页面里不再出现第二张表，改口径只改这一处。
// ===========================================================================

/**
 * 审核结论 → 用户可见文案（`Object.freeze` 双层冻结：页面无法就地改文案）。
 *
 * `key` 是稳定标识（用例与页面逻辑可据此判断，不靠中文文案做条件）；
 * `title` 是标签（列表/详情的小 pill、投稿结果 toast 用同一句）；`desc` 是详情页的整句解释。
 */
const OUTCOMES = Object.freeze({
  approved: Object.freeze({
    key: 'approved',
    title: '已通过先行审核',
    desc: '这条内容已通过先行审核，公开可见。'
  }),
  pending: Object.freeze({
    key: 'pending',
    title: '待审／未公开',
    desc: '内容已提交，正在等待审核结论；出结论前只有你本人能看到这条内容。'
  }),
  // 隔离待复核：**不是**驳回。审核没有给出可放行的结论，也没有给出驳回结论。
  quarantined: Object.freeze({
    key: 'quarantined',
    title: '待人工复核（未公开）',
    desc: '内容已提交，但审核没有自动得出可放行的结论，正等待人工复核。'
      + '复核需要一些时间，请稍后再来看；出结论前这条内容不会公开，只有你本人能看到。'
  }),
  // 明确驳回：审核给出了「不通过」的结论。有理由码就翻成人话（见 `reasonLines`）。
  rejected: Object.freeze({
    key: 'rejected',
    title: '未通过审核（未公开）',
    desc: '这条内容没有通过审核，不会公开。'
  }),
  hidden: Object.freeze({
    key: 'hidden',
    title: '已下架（仅本人可见）',
    desc: '这条内容已被下架，不再公开，仅你本人可见。'
  }),
  draft: Object.freeze({
    key: 'draft',
    title: '未公开（仅本人可见）',
    desc: '这条内容尚未公开，只有你本人能看到。'
  })
})

/**
 * 审核结论判定（**单一实现**）：`visibility` + `audit_state` ⇒ 上面的一张文案。
 *
 * 优先级：`hidden`（下架是处置动作，优先于审核结论）⇒ `published ∧ approved`（真通过）
 * ⇒ 其余按 `audit_state` 如实取；`audit_state` 不认识时按 `pending`（fail-closed：
 * 宁可说「还在等」，也不说「通过」，更不说「系统错误」——后者会把审核结论说成故障）。
 */
function outcomeOf(record) {
  const visibility = record && record.visibility
  const auditState = record && record.audit_state
  if (visibility === 'hidden') return OUTCOMES.hidden
  if (auditState === 'rejected') return OUTCOMES.rejected
  if (auditState === 'quarantined') return OUTCOMES.quarantined
  if (visibility === 'published' && auditState === 'approved') return OUTCOMES.approved
  // 已通过但**没有公开**（私有/草稿版本）：不是「待审」，也不该重复说「已通过」。
  if (auditState === 'approved') return OUTCOMES.draft
  if (auditState === 'pending') return OUTCOMES.pending
  // 未知 audit_state（含字段缺失）：不猜结论，如实停在「待审」。
  return OUTCOMES.pending
}

/**
 * 理由码 → 人话（**全仓唯一一张表**）。
 *
 * 取值来自仓库既有闭集，不是自造：
 *   - 规则命中（明确驳回）：`packages/moderation/constants.mjs` 的 `RULE_REASON_CODES`；
 *   - 未结论/隔离：同文件 `FAIL_CLOSED_REASON_CODES`、`packages/moderation/model-reason-codes.mjs`
 *     的 `MODEL_REASON_CODES`，以及 `community/service.ts` 追加的
 *     `IMAGE_MODERATION_UNAVAILABLE` / `MEDIA_NOT_EVALUATED_BY_RULE_LAYER`、审核域读面的
 *     `RESCREEN_REQUIRED`。
 * 表里没有的码**一律**走 `未知原因（码：X）`（见 `reasonLabel`），不猜、不合并、不说成通过。
 */
const REASON_LABELS = Object.freeze({
  // ---- 规则命中：内容本身触犯了规则（服务端回 400 `INVALID_REQUEST`，属「明确驳回」）----
  DANGEROUS_MIX: '疑似危险混配（处方混配或超量用药）',
  DOSE_UNBOUNDED: '用药剂量没有给出边界',
  DOSE_NOT_BOUND_TO_LABEL: '剂量没有绑定登记标签与使用条件',
  PRIVACY_PII: '含可识别到个人的隐私信息',
  PRIVACY_COORDS: '含精确坐标（可能暴露住址或地块位置）',
  PROMPT_INJECTION: '含试图操纵审核的指令性文字',
  FALSE_AUTHORITY: '冒用权威机构或专家身份',
  ABSOLUTE_SAFETY_CLAIM: '对安全性作了无条件的保证性说法',
  COMMERCE_SOLICITATION: '含售卖或招揽内容',
  COMMERCE_LINK: '含导流链接',
  PROHIBITED_SALE: '涉及禁止销售的产品',
  // ---- 未结论：说明「为什么还没有结论」，不表示内容违规（服务端回 422，属「隔离待复核」）----
  MODEL_NOT_EVALUATED: '审核模型没有给出结论',
  MODEL_TIMEOUT: '审核模型超时，未取得结论',
  RULE_TIMEOUT: '规则审核超时，未取得结论',
  MODEL_RESPONSE_SHAPE_UNKNOWN: '审核返回的结论无法判读',
  MODEL_PORT_ERROR: '审核服务调用出错，未取得结论',
  MODEL_PAYLOAD_INVALID: '送审材料不完整，未取得结论',
  MODEL_MEDIA_UNSUPPORTED: '图片审核当前不支持这类媒体',
  MODEL_BIZTYPE_UNVERIFIED: '审核供应商的业务类型尚未核验',
  MODEL_BLOCKED: '审核模型判定不得公开',
  MEDIA_NOT_EVALUATED_BY_RULE_LAYER: '规则层不评估图片，图片需另行复核',
  IMAGE_MODERATION_UNAVAILABLE: '图片审核能力当前未就绪',
  RULE_NOT_EVALUATED: '规则层没有完成评估',
  RULE_SCAN_TRUNCATED: '规则扫描没有覆盖全文',
  RULE_ENGINE_ERROR: '规则引擎出错，未取得结论',
  RULE_VERSION_UNKNOWN: '无法确认审核规则版本',
  ENGINE_INVARIANT_VIOLATION: '审核引擎状态不一致，未取得结论',
  REVIEW_INPUT_INVALID: '送审输入不完整',
  TARGET_REVISION_CHANGED: '审核针对的是旧版本，需要重新审核',
  REASON_CODES_TRUNCATED: '原因码过多已被截断（列出的不是全部原因）',
  RESCREEN_REQUIRED: '内容版本已变化，需要重新审核',
  NOT_PUBLISHABLE: '没有取得可放行的结论'
})

/**
 * 带参数后缀的理由码**前缀族**（唯一一处例外，逐条有据）：
 * `services/api/src/moderation/service.ts:913` 产出 `NOT_SCREENED:<kind>`（如 `NOT_SCREENED:text`），
 * 是「这一版内容没有完成送审」，属未结论（隔离），不是内容违规。
 */
const REASON_LABEL_PREFIXES = Object.freeze([
  Object.freeze({ prefix: 'NOT_SCREENED', label: '这一版内容没有完成送审' })
])

/** 码的统一拼法（**唯一一处**）：`人话（码：X）`——保留原码便于对账，也不让码单独裸奔。 */
function withCode(label, key) {
  return label + '（码：' + key + '）'
}

/**
 * 单个理由码的中文句子。
 *
 * 已知码 ⇒ `人话（码：X）`（保留原码，便于用户与客服对账；**不是**裸码直传）；
 * 已知前缀族 ⇒ 同一拼法；
 * 其余未知码 ⇒ `未知原因（码：X）`——不编理由，也不说成「已通过」「系统错误」。
 */
function reasonLabel(code) {
  const key = typeof code === 'string' ? code : ''
  if (Object.prototype.hasOwnProperty.call(REASON_LABELS, key)) return withCode(REASON_LABELS[key], key)
  for (let i = 0; i < REASON_LABEL_PREFIXES.length; i += 1) {
    const family = REASON_LABEL_PREFIXES[i]
    if (key === family.prefix || key.indexOf(family.prefix + ':') === 0) return withCode(family.label, key)
  }
  return withCode('未知原因', key)
}

/** 把错误封套里的理由码翻成人话列表（去重、保序、最多 6 条，与 `reasonCodes` 同上限）。 */
function reasonLines(error) {
  const codes = reasonCodes(error)
  const lines = []
  for (let i = 0; i < codes.length; i += 1) {
    const line = reasonLabel(codes[i])
    if (lines.indexOf(line) === -1) lines.push(line)
  }
  return lines
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
  // 隔离待复核（422），**不是**驳回：改前这里把两件事写成一句「未完成（或未通过）」，
  // 用户无法判断"是不是被否了、还等不等得到结果"。
  // ⛔ 不得出现「稍后重试/重新提交」式暗示：同一份内容重提交注定同样结果（既有用例
  // `tests/unit/miniprogram-community-api.test.mjs` 的 /再试一次|重新提交/ 负向断言就是这条）。
  INPUT_UNCERTAIN: '内容已提交，但审核没有给出可放行的结论（隔离待复核）：本条不会公开，也不会出现在公开列表。',
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
  // 两条**结论不同**的失败路径各自说自己的事，且都按理由码表翻成人话（不直传英文裸码）：
  //   400 `INVALID_REQUEST` ⇒ 审核明确驳回；422 `INPUT_UNCERTAIN` ⇒ 隔离待复核（见 `MESSAGES`）。
  if (code === 'INVALID_REQUEST') {
    const reasons = reasonLines(error)
    return reasons.length
      ? '内容未通过先行审核（明确驳回）：' + reasons.join('；') + '。本条没有发布。'
      : '请求不符合契约要求，未提交。'
  }
  if (code === 'INPUT_UNCERTAIN') {
    const reasons = reasonLines(error)
    return reasons.length
      ? MESSAGES.INPUT_UNCERTAIN + '原因：' + reasons.join('；') + '。'
      : MESSAGES.INPUT_UNCERTAIN
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
  // 审核结论文案（单一来源）：页面据此区分「隔离待复核」与「明确驳回」，不各写一套。
  OUTCOMES: OUTCOMES,
  REASON_LABELS: REASON_LABELS,
  outcomeOf: outcomeOf,
  reasonLabel: reasonLabel,
  reasonLines: reasonLines,
  sessionFailure: sessionFailure,
  forbidden: forbidden,
  modeNote: modeNote,
  message: message
}
