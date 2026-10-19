import { test } from 'node:test'
import assert from 'node:assert/strict'

import { emptyCollection } from '../../apps/admin/src/lib/admin-api.mjs'
import {
  canLoadMore,
  describe,
  formatRow,
  initialState,
  reduce,
  summaryOf,
  visibleRowViews,
  visibleRows,
} from '../../apps/admin/src/lib/view-model.mjs'

// GY-I18：账号只读页状态机。重点是「不把旧数据／空列表／失败说成成功」。

function row(id, overrides = {}) {
  return { id, revision: 1, state: 'active', display_name: `账号 ${id}`, ...overrides }
}

const ROW_A = row('aaaaaaaa-0000-4000-8000-000000000001', { display_name: '张三' })
const ROW_B = row('bbbbbbbb-0000-4000-8000-000000000002', { display_name: '李四', state: 'suspended', revision: 4 })

function collectionOf(items, nextCursor = null) {
  return { items: [...items], nextCursor, seenIds: items.map((item) => item.id), pages: 1, duplicates: 0, cycle: false }
}

function signedIn() {
  return reduce(initialState(), { type: 'SIGNED_IN', scopes: ['session:read', 'accounts:read'], scopesProvided: true })
}

function ready(items, nextCursor = null) {
  return reduce(signedIn(), { type: 'LOAD_OK', collection: collectionOf(items, nextCursor) })
}

test('initialState: 未登录、无行、无失败', () => {
  const state = initialState()
  assert.equal(state.phase, 'signed_out')
  assert.deepEqual(state.collection.items, [])
  assert.equal(state.failure, null)
  const view = describe(state)
  assert.equal(view.tone, 'signed_out')
  assert.equal(view.action, 'sign_in')
})

test('未登录态收到 LOAD_OK 被丢弃：没有会话就不可能有行', () => {
  const state = reduce(initialState(), { type: 'LOAD_OK', collection: collectionOf([ROW_A]) })
  assert.deepEqual(state, initialState())
})

test('SIGNED_IN → loading；LOAD_OK → ready 并带行', () => {
  assert.equal(signedIn().phase, 'loading')
  const state = ready([ROW_A, ROW_B])
  assert.equal(state.phase, 'ready')
  assert.equal(visibleRows(state).length, 2)
  const view = describe(state)
  assert.equal(view.tone, 'ready')
  assert.equal(view.total, 2)
  assert.equal(view.visible, 2)
})

test('空列表与筛选后为空是两种空态，文案不混用', () => {
  const emptyView = describe(ready([]))
  assert.equal(emptyView.tone, 'empty')
  assert.match(emptyView.detail, /空列表/)
  assert.match(emptyView.title, /为空/)

  const filtered = reduce(ready([ROW_A, ROW_B]), { type: 'SET_FILTER', value: '不存在的人' })
  const filteredView = describe(filtered)
  assert.equal(filteredView.tone, 'empty_filtered')
  assert.equal(filteredView.filtered, true)
  assert.match(filteredView.detail, /已加载的 2 行/)
  assert.match(filteredView.detail, /后端无关键字参数/)
})

test('关键字筛选只在已加载行内匹配 display_name 与 id', () => {
  const state = ready([ROW_A, ROW_B])
  assert.deepEqual(visibleRows(reduce(state, { type: 'SET_FILTER', value: '张' })).map((r) => r.display_name), ['张三'])
  assert.deepEqual(visibleRows(reduce(state, { type: 'SET_FILTER', value: 'BBBB' })).map((r) => r.id), [ROW_B.id])
  assert.equal(visibleRows(reduce(state, { type: 'SET_FILTER', value: '   ' })).length, 2)
})

test('无行时失败 → error 态；可重试类型给出 canRetry', () => {
  const failed = reduce(signedIn(), { type: 'LOAD_FAIL', failure: { ok: false, kind: 'unavailable', retriable: true, status: 503 } })
  assert.equal(failed.phase, 'error')
  const view = describe(failed)
  assert.equal(view.tone, 'error')
  assert.equal(view.canRetry, true)
  assert.equal(view.action, 'retry')
  assert.deepEqual(failed.collection.items, [])
})

test('已有行时刷新失败 → 保留旧行但标 stale，不当最新数据', () => {
  const loaded = ready([ROW_A])
  const failed = reduce(loaded, { type: 'LOAD_FAIL', failure: { ok: false, kind: 'network_error', retriable: true } })
  assert.equal(failed.phase, 'ready')
  assert.equal(failed.stale, true)
  assert.equal(failed.collection.items.length, 1)
  const view = describe(failed)
  assert.equal(view.tone, 'stale')
  assert.match(view.title, /上次成功/)
  assert.match(view.detail, /刷新失败/)

  const recovered = reduce(failed, { type: 'LOAD_OK', collection: collectionOf([ROW_A]) })
  assert.equal(recovered.stale, false)
  assert.equal(describe(recovered).tone, 'ready')
})

test('会话失效（signed_out）→ 回到未登录并清空行', () => {
  const loaded = ready([ROW_A])
  const expired = reduce(loaded, {
    type: 'LOAD_FAIL',
    failure: { ok: false, kind: 'signed_out', retriable: false, status: 401, code: 'SESSION_EXPIRED' },
  })
  assert.equal(expired.phase, 'signed_out')
  assert.deepEqual(expired.collection.items, [])
  assert.equal(expired.signedIn, false)
  assert.equal(describe(expired).action, 'sign_in')
})

test('续页只有拿到 next_cursor 才开放；加载中与死循环游标都关闭', () => {
  assert.equal(canLoadMore(ready([ROW_A], null)), false)
  assert.equal(canLoadMore(ready([ROW_A], 'c2')), true)

  const loading = reduce(ready([ROW_A], 'c2'), { type: 'LOAD_START', reset: false })
  assert.equal(loading.loadingMore, true)
  assert.equal(canLoadMore(loading), false)

  const cyclic = ready([ROW_A])
  cyclic.collection = { ...cyclic.collection, nextCursor: 'x', cycle: true }
  assert.equal(canLoadMore(cyclic), false)
})

test('选择行：合法才选中；重载丢行后自动清空选择', () => {
  const state = ready([ROW_A, ROW_B])
  const selected = reduce(state, { type: 'SELECT', id: ROW_B.id })
  assert.equal(selected.selectedId, ROW_B.id)
  assert.equal(reduce(selected, { type: 'SELECT', id: 'not-there' }).selectedId, ROW_B.id)
  assert.equal(reduce(selected, { type: 'CLOSE_SUMMARY' }).selectedId, null)

  const withoutB = reduce(selected, { type: 'LOAD_OK', collection: collectionOf([ROW_A]) })
  assert.equal(withoutB.selectedId, null)
})

test('详情摘要只有列表 4 字段，缺项显式列出（不填占位假值）', () => {
  const state = ready([ROW_A])
  const summary = summaryOf(state, ROW_A.id)
  assert.equal(summary.fields.length, 4)
  assert.deepEqual(summary.fields.map((f) => f.label), ['账号 ID', '显示名', '状态', 'revision'])
  assert.ok(summary.fields.every((f) => f.source === 'list'))
  assert.ok(summary.missing.includes('最近登录时间'))
  assert.match(summary.note, /未提供单账号只读详情接口/)
  assert.equal(summaryOf(state, 'missing'), null)
})

test('formatRow: 状态翻译与未知状态如实标注', () => {
  assert.equal(formatRow(ROW_A).stateLabel, '启用')
  assert.equal(formatRow(ROW_B).stateLabel, '已停用')
  assert.equal(formatRow(ROW_B).revisionLabel, 'r4')
  const unknown = formatRow({ ...ROW_A, state: 'archived' })
  assert.match(unknown.stateLabel, /未知状态\(archived\)/)
})

test('visibleRowViews: 行视图跟随筛选', () => {
  const state = reduce(ready([ROW_A, ROW_B]), { type: 'SET_FILTER', value: '李' })
  assert.deepEqual(visibleRowViews(state).map((r) => r.displayName), ['李四'])
})

test('scopeWarning: 会话缺少 accounts:read 时提前告知（仍由服务端最终裁决）', () => {
  const warned = reduce(initialState(), { type: 'SIGNED_IN', scopes: ['session:read'], scopesProvided: true })
  assert.equal(warned.scopeWarning, true)
  const ok = reduce(initialState(), { type: 'SIGNED_IN', scopes: ['accounts:read'], scopesProvided: true })
  assert.equal(ok.scopeWarning, false)
})

test('SIGN_OUT 复位到初始态；未知事件不改状态', () => {
  const loaded = ready([ROW_A])
  assert.deepEqual(reduce(loaded, { type: 'SIGN_OUT' }), initialState())
  assert.deepEqual(reduce(loaded, { type: 'WHAT' }), loaded)
  assert.deepEqual(reduce(loaded, undefined), loaded)
})

test('emptyCollection 与 view-model 的组合：翻页后 total 累加', () => {
  const first = reduce(signedIn(), { type: 'LOAD_OK', collection: emptyCollection() })
  assert.equal(describe(first).tone, 'empty')
  const second = reduce(first, { type: 'LOAD_OK', collection: collectionOf([ROW_A, ROW_B], 'c3') })
  const view = describe(second)
  assert.equal(view.total, 2)
  assert.equal(view.canLoadMore, true)
})
