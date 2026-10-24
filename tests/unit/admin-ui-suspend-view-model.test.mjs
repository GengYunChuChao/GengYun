import { test } from 'node:test'
import assert from 'node:assert/strict'

import { etagForRevision } from '../../apps/admin/src/lib/account-suspend-api.mjs'
import {
  canOpenSuspendDialog,
  canSuspend,
  describe,
  describeSuspendFailure,
  initialState,
  reduce,
  suspendReasonProblem,
  suspendTargetView,
} from '../../apps/admin/src/lib/view-model.mjs'

// GY-I18：账号页「停用」写面状态机（纯函数；假状态注入，不发请求）。

function row(id, overrides = {}) {
  return { id, revision: 1, state: 'active', display_name: `账号 ${id}`, ...overrides }
}

const ROW_A = row('aaaaaaaa-0000-4000-8000-000000000001', { display_name: '张三' })
const ROW_B = row('bbbbbbbb-0000-4000-8000-000000000002', { display_name: '李四', state: 'suspended', revision: 4 })
const ROW_C = row('cccccccc-0000-4000-8000-000000000003', { display_name: '王五', state: 'deletion_pending' })

function collectionOf(items, nextCursor = null) {
  return { items: [...items], nextCursor, seenIds: items.map((item) => item.id), pages: 1, duplicates: 0, cycle: false }
}

function signedIn(scopes = ['session:read', 'accounts:read', 'accounts:suspend']) {
  return reduce(initialState(), { type: 'SIGNED_IN', scopes, scopesProvided: true })
}

function ready(items, nextCursor = null) {
  return reduce(signedIn(), { type: 'LOAD_OK', collection: collectionOf(items, nextCursor) })
}

test('initialState: 停用写面字段默认 idle、无目标、无失败', () => {
  const state = initialState()
  assert.equal(state.suspendStatus, 'idle')
  assert.equal(state.suspendTargetId, null)
  assert.equal(state.suspendFailure, null)
  assert.equal(state.suspendWrite, null)
  assert.equal(state.suspendReason, '')
  assert.equal(state.suspendScopeWarning, false)
})

test('SIGNED_IN: 会话 scope 缺 accounts:suspend 时置 suspendScopeWarning', () => {
  assert.equal(signedIn().suspendScopeWarning, false)
  const missing = reduce(initialState(), { type: 'SIGNED_IN', scopes: ['accounts:read'], scopesProvided: true })
  assert.equal(missing.suspendScopeWarning, true)
  assert.equal(missing.scopeWarning, false) // 读面 scope 仍在
})

test('SET_SUSPEND_REASON 与 suspendReasonProblem：理由 1..500 才可用', () => {
  const state = reduce(ready([ROW_A]), { type: 'SET_SUSPEND_REASON', value: '违规' })
  assert.equal(state.suspendReason, '违规')
  assert.equal(suspendReasonProblem(state), null)

  const empty = reduce(ready([ROW_A]), { type: 'SET_SUSPEND_REASON', value: '' })
  assert.match(suspendReasonProblem(empty), /理由不能为空/)
})

test('SUSPEND_BEGIN：只有 active 行能进确认态，其余原样丢弃', () => {
  const state = ready([ROW_A, ROW_B, ROW_C])
  assert.equal(reduce(state, { type: 'SUSPEND_BEGIN', id: ROW_A.id }).suspendStatus, 'confirming')
  assert.equal(reduce(state, { type: 'SUSPEND_BEGIN', id: ROW_A.id }).suspendTargetId, ROW_A.id)
  assert.equal(reduce(state, { type: 'SUSPEND_BEGIN', id: ROW_B.id }).suspendStatus, 'idle') // suspended
  assert.equal(reduce(state, { type: 'SUSPEND_BEGIN', id: ROW_C.id }).suspendStatus, 'idle') // deletion_pending
  assert.equal(reduce(state, { type: 'SUSPEND_BEGIN', id: 'nope' }).suspendStatus, 'idle')
  assert.equal(reduce(initialState(), { type: 'SUSPEND_BEGIN', id: ROW_A.id }).suspendStatus, 'idle') // 未登录
})

test('SUSPEND_CANCEL：退出确认态并清空挂起写意向', () => {
  const confirming = reduce(ready([ROW_A]), { type: 'SUSPEND_BEGIN', id: ROW_A.id })
  const cancelled = reduce(confirming, { type: 'SUSPEND_CANCEL' })
  assert.equal(cancelled.suspendStatus, 'idle')
  assert.equal(cancelled.suspendTargetId, null)
})

test('SUSPEND_START：本地校验不过（空理由/非法 revision/未登录）不进 saving', () => {
  const state = ready([ROW_A])

  const badReason = reduce(state, { type: 'SUSPEND_START', id: ROW_A.id, revision: ROW_A.revision, reason: '', idempotencyKey: 'account-12345678' })
  assert.equal(badReason.suspendStatus, 'idle')

  const badRevision = reduce(state, { type: 'SUSPEND_START', id: ROW_A.id, revision: 0, reason: 'x', idempotencyKey: 'account-12345678' })
  assert.equal(badRevision.suspendStatus, 'idle')

  const signedOut = reduce(initialState(), { type: 'SUSPEND_START', id: ROW_A.id, revision: 1, reason: 'x', idempotencyKey: 'account-12345678' })
  assert.equal(signedOut.suspendStatus, 'idle')

  const ok = reduce(state, { type: 'SUSPEND_START', id: ROW_A.id, revision: ROW_A.revision, reason: '违规', idempotencyKey: 'account-12345678' })
  assert.equal(ok.suspendStatus, 'saving')
  assert.deepEqual(ok.suspendWrite, { id: ROW_A.id, revision: ROW_A.revision, reason: '违规', idempotencyKey: 'account-12345678' })
})

test('SUSPEND_OK：用服务端返回替换该行并进入 saved，其它行不动', () => {
  const started = reduce(ready([ROW_A, ROW_B]), {
    type: 'SUSPEND_START',
    id: ROW_A.id,
    revision: ROW_A.revision,
    reason: '违规',
    idempotencyKey: 'account-12345678',
  })
  const done = reduce(started, { type: 'SUSPEND_OK', account: { ...ROW_A, state: 'suspended', revision: 2 } })
  assert.equal(done.suspendStatus, 'saved')
  assert.equal(done.suspendTargetId, null)
  assert.equal(done.suspendWrite, null)
  assert.equal(done.collection.items.find((r) => r.id === ROW_A.id).state, 'suspended')
  assert.equal(done.collection.items.find((r) => r.id === ROW_A.id).revision, 2)
  assert.equal(done.collection.items.find((r) => r.id === ROW_B.id).revision, 4)
})

test('SUSPEND_FAIL：可重试保留写意向，不可重试丢弃，signed_out 回未登录', () => {
  const started = reduce(ready([ROW_A]), {
    type: 'SUSPEND_START',
    id: ROW_A.id,
    revision: ROW_A.revision,
    reason: '违规',
    idempotencyKey: 'account-12345678',
  })

  const retriable = reduce(started, { type: 'SUSPEND_FAIL', failure: { ok: false, kind: 'network_error', retriable: true, status: null } })
  assert.equal(retriable.suspendStatus, 'failed')
  assert.notEqual(retriable.suspendWrite, null)
  assert.equal(retriable.stale, true)

  const conflict = reduce(started, {
    type: 'SUSPEND_FAIL',
    failure: { ok: false, kind: 'revision_conflict', retriable: false, status: 409, code: 'REVISION_CONFLICT' },
  })
  assert.equal(conflict.suspendStatus, 'failed')
  assert.equal(conflict.suspendWrite, null)

  const signedOut = reduce(started, { type: 'SUSPEND_FAIL', failure: { ok: false, kind: 'signed_out', retriable: false, status: 401 } })
  assert.equal(signedOut.signedIn, false)
  assert.deepEqual(signedOut.collection.items, [])
})

test('SUSPEND_CLEAR：清空写状态回 idle', () => {
  const started = reduce(ready([ROW_A]), {
    type: 'SUSPEND_START',
    id: ROW_A.id,
    revision: ROW_A.revision,
    reason: '违规',
    idempotencyKey: 'account-12345678',
  })
  const cleared = reduce(started, { type: 'SUSPEND_CLEAR' })
  assert.equal(cleared.suspendStatus, 'idle')
  assert.equal(cleared.suspendWrite, null)
  assert.equal(cleared.suspendFailure, null)
  assert.equal(cleared.suspendTargetId, null)
})

test('canSuspend：登录 + 就绪 + 有 scope + 理由合法才可停用', () => {
  assert.equal(canSuspend(initialState()), false) // 未登录
  assert.equal(canSuspend(signedIn()), false) // 仍在 loading
  assert.equal(canSuspend(ready([ROW_A])), false) // 理由为空

  const withReason = reduce(ready([ROW_A]), { type: 'SET_SUSPEND_REASON', value: '违规' })
  assert.equal(canSuspend(withReason), true)

  const state = reduce(initialState(), { type: 'SIGNED_IN', scopes: ['accounts:read'], scopesProvided: true })
  const readyNoScope = reduce(state, { type: 'LOAD_OK', collection: collectionOf([ROW_A]) })
  const noScopeWithReason = reduce(readyNoScope, { type: 'SET_SUSPEND_REASON', value: '违规' })
  assert.equal(canSuspend(noScopeWithReason), false) // 缺 accounts:suspend
})

test('canOpenSuspendDialog：入口可达只与 scope/phase/saving 相关，与理由无关', () => {
  assert.equal(canOpenSuspendDialog(initialState()), false) // 未登录
  assert.equal(canOpenSuspendDialog(signedIn()), false) // 仍在 loading

  const state = reduce(initialState(), { type: 'SIGNED_IN', scopes: ['accounts:read'], scopesProvided: true })
  const readyNoScope = reduce(state, { type: 'LOAD_OK', collection: collectionOf([ROW_A]) })
  assert.equal(canOpenSuspendDialog(readyNoScope), false) // 缺 accounts:suspend

  // 理由为空时入口仍可开——这是本次修复的核心：入口不能再被理由判成死锁。
  assert.equal(canOpenSuspendDialog(ready([ROW_A])), true)

  // saving 态入口不可开（避免并发打开第二张确认框）。
  const saving = reduce(ready([ROW_A]), {
    type: 'SUSPEND_START',
    id: ROW_A.id,
    revision: ROW_A.revision,
    reason: '违规',
    idempotencyKey: 'account-12345678',
  })
  assert.equal(canOpenSuspendDialog(saving), false)
})

test('入口可开、确认需理由：理由为空时入口可达但确认仍被拦（反例）', () => {
  const state = ready([ROW_A])
  assert.equal(canOpenSuspendDialog(state), true) // 入口可达
  assert.notEqual(suspendReasonProblem(state), null) // 确认仍需理由
  assert.equal(canSuspend(state), false) // 含理由的整页 gate 仍拦（确认路径语义保留）
})

test('suspendTargetView：确认态返回目标行视图（含 ETag），否则 null', () => {
  const state = ready([ROW_A])
  assert.equal(suspendTargetView(state), null)

  const confirming = reduce(state, { type: 'SUSPEND_BEGIN', id: ROW_A.id })
  const target = suspendTargetView(confirming)
  assert.equal(target.id, ROW_A.id)
  assert.equal(target.displayName, '张三')
  assert.equal(target.revision, 1)
  assert.equal(target.etag, etagForRevision(1))
})

test('describeSuspendFailure：428/409 修订冲突/在飞/503/403 的分派', () => {
  const required = describeSuspendFailure({ ok: false, kind: 'revision_required', status: 428, code: 'REVISION_REQUIRED', retriable: false })
  assert.equal(required.action, 'reload')
  assert.equal(required.retriable, false)
  assert.match(required.title, /If-Match/)

  const conflict = describeSuspendFailure({ ok: false, kind: 'revision_conflict', status: 409, code: 'REVISION_CONFLICT', retriable: false })
  assert.equal(conflict.action, 'reload')
  assert.equal(conflict.retriable, false)

  const inFlight = describeSuspendFailure({ ok: false, kind: 'in_progress', status: 409, code: 'REQUEST_IN_PROGRESS', retriable: true })
  assert.equal(inFlight.action, 'retry')
  assert.equal(inFlight.retriable, true)

  const unavailable = describeSuspendFailure({ ok: false, kind: 'unavailable', status: 503, code: 'PROVIDER_UNAVAILABLE', retriable: true })
  assert.equal(unavailable.retriable, true)

  const forbidden = describeSuspendFailure({ ok: false, kind: 'forbidden', status: 403, code: 'SCOPE_DENIED', retriable: false })
  assert.match(forbidden.title, /accounts:suspend/)

  const signedOut = describeSuspendFailure({ ok: false, kind: 'signed_out', status: 401, code: 'SESSION_EXPIRED', retriable: false })
  assert.equal(signedOut.action, 'sign_in')

  assert.equal(describeSuspendFailure(null), null)
  assert.equal(describeSuspendFailure({ ok: true }), null)
})

test('既有读面不受停用写面影响：describe 仍区分空/筛选空/就绪', () => {
  assert.equal(describe(ready([])).tone, 'empty')
  const filtered = reduce(ready([ROW_A, ROW_B]), { type: 'SET_FILTER', value: '不存在' })
  assert.equal(describe(filtered).tone, 'empty_filtered')
  assert.equal(describe(ready([ROW_A])).tone, 'ready')
})
