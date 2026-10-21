import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AUDIT_EVENTS_PATH,
  AUDIT_SCOPE,
  actionOptions,
  appendAuditPage,
  auditRowView,
  buildAuditEventsUrl,
  canLoadMoreAudit,
  describeAudit,
  describeAuditFailure,
  emptyAuditCollection,
  errorCodeText,
  fetchAuditEventsPage,
  initialAuditState,
  reduceAudit,
  resultCounts,
  validateAuditEvent,
  validateAuditEventPage,
  visibleAuditRows,
} from '../../apps/admin/src/lib/audit-events.mjs'

// B5：审计事件读面（假 fetch 注入；不连真实服务、不读真实令牌、不编造事件）。

const TOKEN = 'test-token-not-a-real-secret'
const UUID = '11111111-2222-4333-8444-555555555555'

function event(overrides = {}) {
  return {
    id: UUID,
    action: 'flag.set',
    scope: 'flags:write',
    target_ref: null,
    reason_code: 'ADMIN_ACTION',
    request_id: UUID,
    result: 'accepted',
    created_at: '2026-10-14T03:04:05.000Z',
    ...overrides,
  }
}

function pageOf(items, nextCursor = null) {
  return { items, next_cursor: nextCursor }
}

function envelope(data, meta = { request_id: 'req-1' }) {
  return { data, meta }
}

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  }
}

function brokenJsonResponse(status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0')
    },
  }
}

function spy(factory) {
  const calls = []
  const impl = async (...args) => {
    calls.push(args)
    return factory(...args)
  }
  return { calls, impl }
}

function errorBody(code, message = '出错了') {
  return { error: { code, message } }
}

function signedInState(limit = 20) {
  const started = reduceAudit(initialAuditState(), { type: 'SIGNED_IN', scopes: ['audit:read'] })
  return limit === 20 ? started : reduceAudit(started, { type: 'SET_LIMIT', limit })
}

function readyState(items, overrides = {}) {
  const collection = { ...emptyAuditCollection(), items, pages: 1, seenIds: items.map((row) => row.id), ...overrides }
  return reduceAudit(signedInState(), { type: 'LOAD_OK', collection })
}

// ---------------------------------------------------------------------------
// 契约常量 / 行校验
// ---------------------------------------------------------------------------

test('audit events: 路径与 scope 与契约一致', () => {
  assert.equal(AUDIT_EVENTS_PATH, '/admin/audit-events')
  assert.equal(AUDIT_SCOPE, 'audit:read')
})

test('audit events: 合法行通过校验且无告警', () => {
  const result = validateAuditEvent(event())
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
})

test('audit events: target_ref 允许为 null（契约闭集不含 category/account/flag）', () => {
  const result = validateAuditEvent(event({ target_ref: null }))
  assert.equal(result.ok, true)
})

test('audit events: target_ref 非 null 时校验 type/id/revision', () => {
  const ok = validateAuditEvent(event({ target_ref: { type: 'post', id: 'p1', revision: 3 } }))
  assert.equal(ok.ok, true)

  const badRevision = validateAuditEvent(event({ target_ref: { type: 'post', id: 'p1', revision: 0 } }))
  assert.equal(badRevision.ok, false)
  assert.ok(badRevision.errors.some((item) => item.path === '$.target_ref.revision'))

  const badType = validateAuditEvent(event({ target_ref: { type: 'category', id: 'c1', revision: 1 } }))
  assert.equal(badType.ok, true, '闭集外的 type 只告警，不影响可读性')
  assert.ok(badType.warnings.some((item) => item.path === '$.target_ref.type'))
})

test('audit events: 缺字段判畸形（不渲染半行）', () => {
  for (const field of ['id', 'action', 'scope', 'reason_code', 'request_id', 'result', 'created_at']) {
    const broken = event()
    delete broken[field]
    const result = validateAuditEvent(broken)
    assert.equal(result.ok, false, `${field} 缺失时必须判畸形`)
    assert.ok(result.errors.some((item) => item.path === `$.${field}`), `${field} 应给出字段路径`)
  }
})

test('audit events: result 只接受契约 enum 三项', () => {
  for (const value of ['accepted', 'denied', 'failed']) {
    assert.equal(validateAuditEvent(event({ result: value })).ok, true)
  }
  const unknown = validateAuditEvent(event({ result: 'approved' }))
  assert.equal(unknown.ok, false)
  assert.ok(unknown.errors.some((item) => item.path === '$.result'))
})

test('audit events: 契约外字段只告警（不展示、不推断含义）', () => {
  const result = validateAuditEvent(event({ actor_id: 'u-1' }))
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some((item) => item.path === '$.actor_id'))
})

test('audit events: 空台账是合法页面（0 条 + next_cursor null）', () => {
  const result = validateAuditEventPage(pageOf([]))
  assert.equal(result.ok, true)
  assert.deepEqual(result.items, [])
  assert.equal(result.nextCursor, null)
})

test('audit events: 缺 next_cursor 判畸形（末页须显式 null）', () => {
  const result = validateAuditEventPage({ items: [] })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.path === '$.next_cursor'))
})

test('audit events: 行内错误带下标路径，整页不可信', () => {
  const result = validateAuditEventPage(pageOf([event(), event({ id: '' })]))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.path === '$.items[1].id'))
})

test('audit events: next_cursor 超长判畸形', () => {
  const result = validateAuditEventPage(pageOf([], 'x'.repeat(2049)))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.path === '$.next_cursor'))
})

// ---------------------------------------------------------------------------
// URL 构造
// ---------------------------------------------------------------------------

test('audit events: URL 只带契约允许的 limit/cursor', () => {
  assert.equal(buildAuditEventsUrl('/api/v1'), '/api/v1/admin/audit-events?limit=20')
  assert.equal(buildAuditEventsUrl('/api/v1/', { limit: 50 }), '/api/v1/admin/audit-events?limit=50')
  assert.equal(
    buildAuditEventsUrl('https://example.test/api/v1', { cursor: 'abc', limit: 20 }),
    'https://example.test/api/v1/admin/audit-events?limit=20&cursor=abc',
  )
})

test('audit events: limit 越界被夹到 1..50，非法游标在本地就拦下', () => {
  assert.match(buildAuditEventsUrl('/api/v1', { limit: 999 }), /limit=50$/)
  assert.match(buildAuditEventsUrl('/api/v1', { limit: 0 }), /limit=1$/)
  assert.throws(() => buildAuditEventsUrl('/api/v1', { cursor: '' }), TypeError)
  assert.throws(() => buildAuditEventsUrl('/api/v1', { cursor: 'x'.repeat(2049) }), RangeError)
})

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

test('audit events: 成功响应解析出条目与游标', async () => {
  const { calls, impl } = spy(async () => jsonResponse(200, envelope(pageOf([event()], 'next-1'))))
  const result = await fetchAuditEventsPage({ fetchImpl: impl, baseUrl: '/api/v1', token: TOKEN, limit: 50 })
  assert.equal(result.ok, true)
  assert.equal(result.page.items.length, 1)
  assert.equal(result.page.nextCursor, 'next-1')
  assert.equal(calls.length, 1)
  assert.match(calls[0][0], /\/admin\/audit-events\?limit=50$/)
  assert.equal(calls[0][1].method, 'GET')
  assert.equal(calls[0][1].headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(calls[0][1].credentials, 'omit')
})

test('audit events: 未登录不发明请求', async () => {
  const { calls, impl } = spy(async () => jsonResponse(200, envelope(pageOf([]))))
  const result = await fetchAuditEventsPage({ fetchImpl: impl, baseUrl: '/api/v1', token: '' })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'signed_out')
  assert.equal(calls.length, 0)
})

test('audit events: 403 归类为 forbidden 且文案指向 audit:read', async () => {
  const { impl } = spy(async () => jsonResponse(403, errorBody('SCOPE_DENIED')))
  const result = await fetchAuditEventsPage({ fetchImpl: impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'forbidden')
  const described = describeAuditFailure(result)
  assert.equal(described.retriable, false)
  assert.match(described.title, /audit:read/)
  assert.match(described.detail, /audit:read/)
})

test('audit events: 401 归类为 signed_out', async () => {
  const { impl } = spy(async () => jsonResponse(401, errorBody('SESSION_EXPIRED')))
  const result = await fetchAuditEventsPage({ fetchImpl: impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.kind, 'signed_out')
})

test('audit events: 400 INVALID_CURSOR 归类为 invalid_cursor 且不提供重试同游标', async () => {
  const { impl } = spy(async () => jsonResponse(400, errorBody('INVALID_CURSOR', '审计台账已变化，请重新开始分页')))
  const result = await fetchAuditEventsPage({ fetchImpl: impl, baseUrl: '/api/v1', token: TOKEN, cursor: 'old' })
  assert.equal(result.kind, 'invalid_cursor')
  assert.equal(result.message, '审计台账已变化，请重新开始分页')
  assert.equal(result.inContract, true)
  const described = describeAuditFailure(result)
  assert.equal(described.retriable, false)
  assert.equal(described.action, 'restart')
})

test('audit events: 429 取回 retry-after 秒数', async () => {
  const { impl } = spy(async () => jsonResponse(429, errorBody('RATE_LIMITED'), { 'retry-after': '12' }))
  const result = await fetchAuditEventsPage({ fetchImpl: impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.kind, 'rate_limited')
  assert.equal(result.retryAfterSeconds, 12)
  assert.equal(describeAuditFailure(result).retriable, true)
})

test('audit events: 5xx 归类为 unavailable（可重试）', async () => {
  for (const status of [500, 503, 504]) {
    const { impl } = spy(async () => jsonResponse(status, errorBody('INTERNAL')))
    const result = await fetchAuditEventsPage({ fetchImpl: impl, baseUrl: '/api/v1', token: TOKEN })
    assert.equal(result.kind, 'unavailable')
    assert.equal(result.retriable, true)
  }
})

test('audit events: 网络异常不吞掉，归类为 network_error', async () => {
  const { impl } = spy(async () => {
    throw new TypeError('Failed to fetch')
  })
  const result = await fetchAuditEventsPage({ fetchImpl: impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.kind, 'network_error')
  assert.equal(result.retriable, true)
  assert.match(result.message, /Failed to fetch/)
})

test('audit events: 非 JSON 响应判 invalid_response（不可重试）', async () => {
  const { impl } = spy(async () => brokenJsonResponse(200))
  const result = await fetchAuditEventsPage({ fetchImpl: impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.kind, 'invalid_response')
  assert.equal(describeAuditFailure(result).retriable, false)
})

test('audit events: 缺 meta 信封判 invalid_response', async () => {
  const { impl } = spy(async () => jsonResponse(200, { data: pageOf([]) }))
  const result = await fetchAuditEventsPage({ fetchImpl: impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.kind, 'invalid_response')
})

test('audit events: 形状不符契约时列出字段路径，且整页不返回', async () => {
  const { impl } = spy(async () => jsonResponse(200, envelope(pageOf([{ id: UUID }]))))
  const result = await fetchAuditEventsPage({ fetchImpl: impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'invalid_response')
  assert.match(result.message, /\$\.items\[0\]\.action/)
  assert.equal(result.page, undefined)
})

test('audit events: 契约外错误码原样保留并标 inContract false', async () => {
  const { impl } = spy(async () => jsonResponse(409, errorBody('SOMETHING_NEW')))
  const result = await fetchAuditEventsPage({ fetchImpl: impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.kind, 'http_error')
  assert.equal(result.code, 'SOMETHING_NEW')
  assert.equal(result.inContract, false)
  assert.equal(errorCodeText(result), 'SOMETHING_NEW（契约外错误码）')
})

// ---------------------------------------------------------------------------
// 集合记账
// ---------------------------------------------------------------------------

test('audit events: 分页去重并防游标回环', () => {
  const first = appendAuditPage(emptyAuditCollection(), {
    cursor: null,
    page: { items: [event()], nextCursor: 'c1', warnings: [] },
  })
  assert.equal(first.collection.items.length, 1)
  assert.equal(first.collection.pages, 1)

  const second = appendAuditPage(first.collection, {
    cursor: 'c1',
    page: { items: [event({ id: UUID }), event({ id: '22222222-2222-4333-8444-555555555555' })], nextCursor: 'c2', warnings: [] },
  })
  assert.equal(second.collection.items.length, 2, '重复 id 不重复入列')
  assert.equal(second.collection.duplicates, 1)

  const cycle = appendAuditPage(second.collection, {
    cursor: 'c2',
    page: { items: [], nextCursor: 'c2', warnings: [] },
  })
  assert.equal(cycle.collection.cycle, true)
  assert.equal(cycle.collection.nextCursor, null)
})

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

test('audit events: 未登录时丢弃成功回调（不显示任何行）', () => {
  const state = reduceAudit(initialAuditState(), { type: 'LOAD_OK', collection: { ...emptyAuditCollection(), items: [event()] } })
  assert.equal(state.phase, 'signed_out')
  assert.equal(state.collection.items.length, 0)
})

test('audit events: 登录 → 读取 → 就绪', () => {
  const state = readyState([event()])
  assert.equal(state.phase, 'ready')
  assert.equal(state.signedIn, true)
  assert.equal(visibleAuditRows(state).length, 1)
  assert.equal(describeAudit(state).tone, 'ready')
})

test('audit events: 有旧行时刷新失败保留旧行并标 stale', () => {
  const ready = readyState([event()])
  const failed = reduceAudit(ready, {
    type: 'LOAD_FAIL',
    failure: { ok: false, kind: 'unavailable', retriable: true, status: 503, code: null, inContract: false, message: '' },
  })
  assert.equal(failed.phase, 'ready')
  assert.equal(failed.stale, true)
  assert.equal(failed.collection.items.length, 1, '旧行保留')
  const described = describeAudit(failed)
  assert.equal(described.tone, 'stale')
  assert.equal(described.canRetry, true)
})

test('audit events: 无旧行时失败进入 error 并带错误码', () => {
  const state = reduceAudit(signedInState(), {
    type: 'LOAD_FAIL',
    failure: { ok: false, kind: 'unavailable', retriable: true, status: 503, code: 'INTERNAL', inContract: true, message: '' },
  })
  assert.equal(state.phase, 'error')
  const described = describeAudit(state)
  assert.equal(described.errorCode, 'INTERNAL（契约内错误码）')
  assert.equal(described.canRetry, true)
})

test('audit events: LOAD_FAIL(signed_out) 直接回到未登录', () => {
  const ready = readyState([event()])
  const state = reduceAudit(ready, {
    type: 'LOAD_FAIL',
    failure: { ok: false, kind: 'signed_out', retriable: false, status: 401, code: 'SESSION_EXPIRED', inContract: true, message: '' },
  })
  assert.equal(state.phase, 'signed_out')
  assert.equal(state.signedIn, false)
  assert.equal(state.collection.items.length, 0)
})

test('audit events: 只有登录后 SIGNED_IN 才允许读取，SET_LIMIT 夹在 1..50', () => {
  const state = reduceAudit(initialAuditState(), { type: 'SIGNED_IN', scopes: ['accounts:read'] })
  assert.equal(state.signedIn, true)
  assert.equal(state.scopeWarning, true, '会话 scope 不含 audit:read 时给提示')
  assert.equal(reduceAudit(state, { type: 'SET_LIMIT', limit: 999 }).limit, 50)
  assert.equal(reduceAudit(state, { type: 'SET_LIMIT', limit: 0 }).limit, 1)
})

test('audit events: 会话带 audit:read 时不告警', () => {
  const state = reduceAudit(initialAuditState(), { type: 'SIGNED_IN', scopes: ['audit:read'] })
  assert.equal(state.scopeWarning, false)
})

test('audit events: 筛选只在已加载行内生效，未知动作得到空集', () => {
  const state = readyState([event({ id: UUID, action: 'flag.set' }), event({ id: '22222222-2222-4333-8444-555555555555', action: 'user.suspend' })])
  const filtered = reduceAudit(state, { type: 'SET_ACTION_FILTER', value: 'user.suspend' })
  const rows = visibleAuditRows(filtered)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].action, 'user.suspend')

  const none = reduceAudit(state, { type: 'SET_ACTION_FILTER', value: 'post.hide' })
  assert.equal(visibleAuditRows(none).length, 0)
  assert.equal(describeAudit(none).tone, 'empty_filtered')
})

test('audit events: 动作下拉带出现次数，并含"全部"项', () => {
  const state = readyState([
    event({ id: UUID, action: 'flag.set' }),
    event({ id: '22222222-2222-4333-8444-555555555555', action: 'flag.set' }),
    event({ id: '33333333-2222-4333-8444-555555555555', action: 'user.suspend' }),
  ])
  const options = actionOptions(state)
  assert.equal(options[0].value, 'all')
  assert.equal(options[0].label, '全部动作（3）')
  assert.deepEqual(options.slice(1).map((item) => item.value), ['flag.set', 'user.suspend'])
  assert.equal(options[1].label, 'flag.set（2）')
})

test('audit events: 空台账文案明确"不是错误"', () => {
  const state = readyState([])
  const described = describeAudit(state)
  assert.equal(described.tone, 'empty')
  assert.match(described.detail, /不是错误/)
})

test('audit events: 展开行只在行仍存在时保留', () => {
  const state = readyState([event()])
  const opened = reduceAudit(state, { type: 'TOGGLE_ROW', id: UUID })
  assert.equal(opened.expandedId, UUID)
  const closed = reduceAudit(opened, { type: 'TOGGLE_ROW', id: UUID })
  assert.equal(closed.expandedId, null)

  const missing = reduceAudit(state, { type: 'TOGGLE_ROW', id: 'nope' })
  assert.equal(missing.expandedId, null, '不存在的行不能展开')

  const refreshed = reduceAudit(opened, { type: 'LOAD_OK', collection: { ...emptyAuditCollection(), items: [], pages: 1 } })
  assert.equal(refreshed.expandedId, null, '行消失后展开态清除')
})

test('audit events: 结果分布只统计已加载行', () => {
  const state = readyState([
    event({ id: UUID, result: 'accepted' }),
    event({ id: '22222222-2222-4333-8444-555555555555', result: 'denied' }),
    event({ id: '33333333-2222-4333-8444-555555555555', result: 'denied' }),
  ])
  assert.deepEqual(resultCounts(state), { accepted: 1, denied: 2, failed: 0 })
})

test('audit events: 只有有下一页才允许继续加载', () => {
  assert.equal(canLoadMoreAudit(readyState([event()], { nextCursor: 'c1' })), true)
  assert.equal(canLoadMoreAudit(readyState([event()])), false, '末页不给续页入口')
  assert.equal(canLoadMoreAudit(readyState([event()], { nextCursor: 'c1', cycle: true })), false, '游标回环时停手')
  assert.equal(canLoadMoreAudit(initialAuditState()), false)
})

test('audit events: 行视图只做展示映射，不虚构主体字段', () => {
  const row = auditRowView(event({ target_ref: { type: 'post', id: 'p1', revision: 2 } }))
  assert.equal(row.resultLabel, '已接受')
  assert.equal(row.resultTone, 'ok')
  assert.equal(row.targetLabel, 'post:p1 · r2')
  assert.equal(row.shortId, UUID.slice(0, 8))
  assert.equal('actor' in row, false, '契约没有主体字段，展示层也不许造')
  assert.equal(auditRowView(event()).targetLabel, '无目标（target_ref = null）')
})

test('audit events: 未知 result 不冒充成功', () => {
  const row = auditRowView(event({ result: 'accepted' }))
  assert.equal(row.resultTone, 'ok')
  const weird = {
    ...event(),
    result: 'pending',
  }
  const view = auditRowView(weird)
  assert.match(view.resultLabel, /未知结果/)
  assert.equal(view.resultTone, 'warn')
})
