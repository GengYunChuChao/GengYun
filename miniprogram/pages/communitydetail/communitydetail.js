// GY-I15（#15）阶段 2 · 社区详情页（详情 + 评论 + 点赞 + 反馈 + 本人内容编辑/删除）。
//
// 形态对齐 docs/ui-demo/demo.html 的 postDetail()：帖子卡片 + 交流与讨论 + 评论输入。
//
// 契约边界（如实呈现，不用界面编造服务端没有的事实）：
//   - 契约 `Post`／`Comment` **没有**点赞计数字段，也没有"我是否点过赞"的读取口
//     ⇒ 页面不显示点赞数，只提供幂等的「点赞／取消点赞」动作与结果提示；
//   - 契约 `Author` 是**假名投影**（`display_id`），客户端无法据此判断归属
//     ⇒ 编辑/删除/评论管理收在「仅作者可用」区，越权一律由服务端返回 404，页面如实提示；
//   - 未通过审核／已下架的内容不会以公开状态展示：作者看到的是显式状态标签，
//     他人拿到的是 404（页面收口到 `state-view` 的失效态）。
const pageGate = require('../../utils/page-gate')
const auth = require('../../utils/auth')
const fontScale = require('../../utils/font-scale')
const navigation = require('../../utils/navigation')
const api = require('../../utils/community-api')

const REASON_LABELS = ['危险内容（混配／超量等）', '隐私信息', '广告导流', '误导信息', '其他问题']

Page({
  data: {
    fontScale: fontScale.DEFAULT_FONT_SCALE,
    guest: true,
    status: 'loading',
    errorText: '',
    // B7：契约错误码透传给 `state-view` 的 `error-code`，由 `utils/states.js` 统一判定
    // 「哪类问题 + 能否重试」；403 系列（SCOPE_DENIED／CONSENT_REQUIRED／ACCOUNT_INACTIVE）
    // 会被升级成 denied 语气，而不是继续显示「这条内容当前不可见」。
    // 改前本页**没有** `errorCode`，wxml 又把错误态写死成 `status="invalid"` 且不传 `error-code`
    // ⇒ 详情页的 403 只能显示成「内容不可见」，B7 的 denied 分支在本页**不可达**。
    errorCode: '',
    stateStatus: 'invalid',
    stateTitle: '',
    modeNote: '',
    post: null,
    comments: [],
    // 评论区自己的取数状态（`idle` / `loading` / `ready` / `empty` / `error`）：
    // 评论失败只影响评论区，不把整页说成「内容不可见」，也**不**折叠成「还没有评论」空态。
    commentsStatus: 'idle',
    commentsError: '',
    nextCursor: null,
    commentText: '',
    submitting: false,
    editingPost: false,
    editTitle: '',
    editBody: '',
    editingCommentId: '',
    editCommentText: ''
  },

  onLoad: function (query) {
    fontScale.applyFontScale(this)
    this._epoch = 0
    this._id = query && typeof query.id === 'string' ? decodeURIComponent(query.id) : ''
  },

  onShow: function () {
    fontScale.applyFontScale(this)
    const that = this
    this.setData({ guest: true, fontScale: fontScale.currentFontScale() })
    pageGate.start(this, function (ok) {
      that.setData({ guest: !ok })
      if (ok) that.load()
    })
  },

  onHide: function () { pageGate.cancel(this) },
  onUnload: function () { pageGate.cancel(this) },

  load: function () {
    if (!api.validId(this._id)) {
      this.setData({
        status: 'error',
        errorCode: '',
        stateStatus: 'invalid',
        stateTitle: '这条内容当前不可见',
        errorText: '链接里的内容标识不正确，请返回社区重新进入。'
      })
      return
    }
    const epoch = ++this._epoch
    const that = this
    this.setData({
      status: 'loading', errorText: '', errorCode: '', stateStatus: 'invalid', stateTitle: '',
      commentsStatus: 'idle', commentsError: ''
    })
    api.getPost(this._id).then(function (result) {
      if (epoch !== that._epoch) return
      // 帖子读到了就**先渲染**：评论是同一页里的第二段取数，它失败不该把已读到的内容一起抹掉。
      that.setData({
        status: 'ready',
        post: that._decoratePost(result.post),
        modeNote: api.modeNote(result.mode)
      })
      that.loadComments(epoch)
    }).catch(function (error) {
      if (epoch !== that._epoch) return
      that._fail(error)
    })
  },

  /** 评论段单独取数：失败落在评论区（可重试），不折叠成空态、也不影响已读到的帖子。 */
  loadComments: function (epoch) {
    const that = this
    const seq = epoch === undefined ? this._epoch : epoch
    this.setData({ commentsStatus: 'loading', commentsError: '', nextCursor: null })
    api.listComments(this._id, { limit: 20 }).then(function (page) {
      if (seq !== that._epoch) return
      that.setData({
        comments: that._decorateComments(page.items),
        nextCursor: page.nextCursor,
        commentsStatus: page.items.length ? 'ready' : 'empty'
      })
    }).catch(function (error) {
      if (seq !== that._epoch) return
      // 会话失效 / 403：取数前提没了 ⇒ 整页收口（与本页读路径同一口径）。
      if (api.sessionFailure(error) || api.forbidden(error)) { that._fail(error); return }
      that.setData({ comments: [], commentsStatus: 'error', commentsError: api.message(error) })
    })
  },

  /**
   * 读路径失败收口（单一实现）：
   *   - 会话类（`SESSION_REQUIRED` / `SESSION_CHANGED`）⇒ 回登录门禁；
   *   - 403 三码 ⇒ `stateStatus='error'` + `errorCode`（`state-view` 升级成 denied），
   *     标题如实说「没有权限」，不再说「内容不存在或不给你看」；
   *   - 404 ⇒ 既有的 `invalid` 语气（内容确实可能已下架/未过审）；
   *   - 其余 ⇒ `error` 语气。
   */
  _fail: function (error) {
    if (api.sessionFailure(error)) { this.setData({ guest: true, status: 'idle' }); return }
    const notFound = !!error && error.code === 'NOT_FOUND'
    this.setData({
      status: 'error',
      errorCode: (error && error.code) || '',
      stateStatus: notFound ? 'invalid' : 'error',
      stateTitle: api.forbidden(error)
        ? '没有权限查看这条内容'
        : (notFound ? '这条内容当前不可见' : '这条内容没有取到'),
      errorText: notFound ? '内容不存在、已下架或当前不可见（可能未通过审核）。' : api.message(error),
      commentsStatus: 'idle',
      commentsError: ''
    })
  },

  /**
   * 写路径（点赞／评论／反馈／编辑／删除）失败收口：
   * 403 系不是「这一次操作没成功」而是一句 toast 就过去了 —— 这条内容对当前账号已不可操作，
   * 因此与读路径同样**整页**落 denied；其余错误仍按既有的如实提示（各调用点自己的特殊码优先）。
   */
  _writeFail: function (error) {
    if (api.sessionFailure(error)) { this.setData({ guest: true, status: 'idle' }); return }
    if (api.forbidden(error)) { this._fail(error); return }
    wx.showToast({ title: api.message(error), icon: 'none' })
  },

  _decoratePost: function (post) {
    return {
      id: post.id,
      revision: post.revision,
      title: post.title,
      body: post.body,
      author: post.author.display_name,
      authorState: post.author.state,
      time: post.created_at,
      updated: post.updated_at,
      crop_id: post.crop_id,
      region_code: post.region_code,
      visibility: post.visibility,
      audit_state: post.audit_state,
      publicLabel: post.visibility === 'published' && post.audit_state === 'approved' ? '已通过先行审核' : '未公开／待审',
      stateLabel: post.visibility === 'hidden'
        ? '已下架（仅本人可见）'
        : (post.visibility === 'published' && post.audit_state === 'approved' ? '' : '待审／未公开'),
      linkTitle: post.linked_knowledge && post.linked_knowledge.summary ? post.linked_knowledge.summary.title : '',
      linkState: post.linked_knowledge ? post.linked_knowledge.reference_state : ''
    }
  },

  _decorateComments: function (items) {
    return items.map(function (comment) {
      return {
        id: comment.id,
        revision: comment.revision,
        author: comment.author.display_name,
        body: comment.body,
        time: comment.created_at,
        stateLabel: comment.visibility === 'hidden' ? '已隐藏（仅本人可见）' : ''
      }
    })
  },

  onLogin: function () {
    const self = this
    auth.requireLogin(function (ok) { if (ok) { pageGate.cancel(self); self.onShow() } })
  },
  onBack: function () { navigation.openTarget('/pages/community/community', true, function () {}) },

  // ---------------------------------------------------------------- 点赞（幂等）
  onLikePost: function () { this._like('post', this.data.post, true) },
  onUnlikePost: function () { this._like('post', this.data.post, false) },
  onLikeComment: function (event) {
    const row = this._comment(event.currentTarget.dataset.id)
    this._like('comment', row, true)
  },
  onUnlikeComment: function (event) {
    const row = this._comment(event.currentTarget.dataset.id)
    this._like('comment', row, false)
  },
  _comment: function (id) {
    const found = this.data.comments.filter(function (c) { return c.id === id })
    return found.length ? found[0] : null
  },
  _like: function (kind, row, on) {
    if (!row) return
    const that = this
    const run = kind === 'post'
      ? (on ? api.likePost(row.id, row.revision) : api.unlikePost(row.id, row.revision))
      : (on ? api.likeComment(row.id, row.revision) : api.unlikeComment(row.id, row.revision))
    run.then(function () {
      wx.showToast({ title: on ? '已点赞（重复点赞不会重复计数）' : '已取消点赞', icon: 'none' })
      that.load()
    }).catch(function (error) { that._writeFail(error) })
  },

  // ---------------------------------------------------------------- 评论
  onCommentInput: function (event) { this.setData({ commentText: event.detail.value }) },
  onSubmitComment: function () {
    const body = String(this.data.commentText || '').trim()
    if (body.length < 1 || body.length > 4000) {
      wx.showToast({ title: '评论需要 1..4000 个字符', icon: 'none' })
      return
    }
    const that = this
    this.setData({ submitting: true })
    api.createComment(this.data.post.id, body, this.data.post.revision).then(function () {
      that.setData({ submitting: false, commentText: '' })
      wx.showToast({ title: '评论已发布', icon: 'success' })
      that.load()
    }).catch(function (error) {
      that.setData({ submitting: false })
      that._writeFail(error)
    })
  },
  onLoadMoreComments: function () {
    const that = this
    if (!this.data.nextCursor) return
    api.listComments(this._id, { cursor: this.data.nextCursor, limit: 20 }).then(function (page) {
      that.setData({
        comments: that.data.comments.concat(that._decorateComments(page.items)),
        nextCursor: page.nextCursor
      })
    }).catch(function (error) {
      if (api.sessionFailure(error) || api.forbidden(error)) { that._fail(error); return }
      // 失效游标：服务端已声明它永不成功 ⇒ 先清游标再重取第一页，否则「加载更多」永远报同一句错。
      if (error && error.code === 'INVALID_CURSOR') {
        that.setData({ nextCursor: null })
        wx.showToast({ title: '评论列表已过期，已重新载入', icon: 'none' })
        that.loadComments()
        return
      }
      wx.showToast({ title: api.message(error), icon: 'none' })
    })
  },

  // -------------------------------------------- 反馈（举报）与处理状态
  onReportPost: function () { this._report('post', this.data.post.id, this.data.post.revision) },
  onReportComment: function (event) {
    const row = this._comment(event.currentTarget.dataset.id)
    if (row) this._report('comment', row.id, row.revision)
  },
  _report: function (type, id, revision) {
    const that = this
    wx.showActionSheet({
      itemList: REASON_LABELS,
      success: function (picked) {
        api.createReport({ type: type, id: id, revision: revision }, api.reportReasons[picked.tapIndex], '').then(function (result) {
          wx.showToast({ title: '已提交反馈（状态：' + result.report.state + '）', icon: 'none' })
        }).catch(function (error) {
          if (error && error.code === 'REVISION_CONFLICT') {
            wx.showToast({ title: '内容已更新，请刷新后重新反馈', icon: 'none' })
            that.load()
            return
          }
          that._writeFail(error)
        })
      },
      fail: function () {}
    })
  },

  // ---------------------------------------------------------------- 本人内容
  onToggleEditPost: function () {
    const post = this.data.post
    this.setData({
      editingPost: !this.data.editingPost,
      editTitle: post ? post.title : '',
      editBody: post ? post.body : ''
    })
  },
  onEditTitle: function (event) { this.setData({ editTitle: event.detail.value }) },
  onEditBody: function (event) { this.setData({ editBody: event.detail.value }) },
  onSavePost: function () {
    const title = String(this.data.editTitle || '').trim()
    const body = String(this.data.editBody || '').trim()
    if (title.length < 1 || title.length > 120 || body.length < 1 || body.length > 8000) {
      wx.showToast({ title: '标题 1..120、正文 1..8000', icon: 'none' })
      return
    }
    const that = this
    // 契约：编辑**遗漏** `linked_knowledge_ref` 保留旧值，因此这里刻意不传该字段。
    api.editPost(this.data.post.id, { title: title, body: body, media_ids: [] }, this.data.post.revision)
      .then(function (result) {
        wx.showToast({ title: '已保存，新版本已重新审核', icon: 'success' })
        that.setData({ editingPost: false })
        if (result.post.id) that.load()
      }).catch(function (error) {
        if (error && error.code === 'REVISION_CONFLICT') {
          wx.showToast({ title: '内容已更新，请刷新后重试', icon: 'none' })
          that.load()
          return
        }
        that._writeFail(error)
      })
  },
  onDeletePost: function () {
    const that = this
    wx.showModal({
      title: '删除这条内容？',
      content: '删除后列表与详情都不再展示（保留审计记录，不可恢复）。',
      confirmText: '删除',
      success: function (result) {
        if (!result.confirm) return
        api.deletePost(that.data.post.id, that.data.post.revision).then(function () {
          wx.showToast({ title: '已删除', icon: 'success' })
          navigation.openTarget('/pages/community/community', true, function () {})
        }).catch(function (error) {
          if (error && error.code === 'REVISION_CONFLICT') {
            wx.showToast({ title: '内容已更新，请刷新后重试', icon: 'none' })
            that.load()
            return
          }
          if (error && error.code === 'NOT_FOUND') {
            wx.showToast({ title: '该内容不属于当前账号或已不存在', icon: 'none' })
            return
          }
          that._writeFail(error)
        })
      }
    })
  },
  onToggleEditComment: function (event) {
    const id = event.currentTarget.dataset.id
    const row = this._comment(id)
    if (!row) return
    this.setData({ editingCommentId: this.data.editingCommentId === id ? '' : id, editCommentText: row.body })
  },
  onEditCommentInput: function (event) { this.setData({ editCommentText: event.detail.value }) },
  onSaveComment: function () {
    const row = this._comment(this.data.editingCommentId)
    const body = String(this.data.editCommentText || '').trim()
    if (!row) return
    if (body.length < 1 || body.length > 4000) {
      wx.showToast({ title: '评论需要 1..4000 个字符', icon: 'none' })
      return
    }
    const that = this
    api.editComment(row.id, body, row.revision).then(function () {
      wx.showToast({ title: '评论已保存并重新审核', icon: 'success' })
      that.setData({ editingCommentId: '' })
      that.load()
    }).catch(function (error) { that._writeFail(error) })
  },
  onDeleteComment: function (event) {
    const row = this._comment(event.currentTarget.dataset.id)
    if (!row) return
    const that = this
    api.deleteComment(row.id, row.revision).then(function () {
      wx.showToast({ title: '评论已删除', icon: 'success' })
      that.load()
    }).catch(function (error) {
      if (error && error.code === 'NOT_FOUND') {
        wx.showToast({ title: '该评论不属于当前账号或已不存在', icon: 'none' })
        return
      }
      that._writeFail(error)
    })
  },

  onRetry: function () { this.load() },
  onRetryComments: function () { this.loadComments() }
})
