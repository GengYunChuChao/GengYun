import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FLAG_AUDIT_CURSOR_TTL_MINUTES,
  FLAG_AUDIT_PATH,
  FLAG_AUDIT_SCOPE,
  appendFlagAuditPage,
  buildFlagAuditUrl,
  canLoadMoreFlagAudit,
  describeFlagAudit,
  describeFlagAuditFailure,
  emptyFlagAuditCollection,
  fetchFlagAuditPage,
  flagAuditResultCounts,
  flagAuditRowView,
  flagAuditRows,
  flagKeyOf,
  initialFlagAuditState,
  reduceFlagAudit,
} from '../../apps/admin/src/lib/flag-audit.mjs'

// GY-R33 / #18 最小片 1：后台「开关变更留痕」读面（假 fetch 注入；不连真实服务、
// 不读真实令牌、不编造留痕行）。本片只读，不含任何写操作。

const TOKEN = 'test-token-not-a-real-secret'
const ACTOR = '11111111-2222-4333-8444-555555555555'
const ID_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const ID_B = 'bbbbbbbb-2222-4222-8222-222222222222'

/** 一行开关变更留痕（契约 `AuditEvent`：8 必填 + 4 可选可空）。 */
function event(overrides = {}) {
  return {
    id: ID_A,
    action: 'set_flag',
    scope: 'flags:write',
    target_ref: null,
    reason_code: 'flag_set',
    request_id: ACTOR,
    result: 'accepted',
    created_at: '2026-10-22T03:04:05.000Z',
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

function errorResponse(status, code, message = '') {
  return jsonResponse(status, { error: { code, message }, meta: { request_id: 'req-err' } })
}

function collectionOf(items, nextCursor = null) {
  return { ...emptyFlagAuditCollection(), items, nextCursor, seenIds: items.map((row) => row.id), pages: 1 }
}

function readyState(collection) {
  return { ...initialFlagAuditState(), signedIn: true, phase: 'ready', collection }
}

// ---------------------------------------------------------------------------
// 1. 请求路径与参数（负控靶点：把路径改回 /admin/audit-events ⇒ 本组必红）
// ---------------------------------------------------------------------------

test('开关留痕：路径常量就是契约里的 /admin/flag-audit-events，scope 是 flags:read', () => {
  assert.equal(FLAG_AUDIT_PATH, '/admin/flag-audit-events')
  assert.equal(FLAG_AUDIT_SCOPE, 'flags:read')
  // 首屏 URL：limit 总是显式带上，cursor 不带。
  assert.equal(buildFlagAuditUrl('/api/v1'), '/api/v1/admin/flag-audit-events?limit=20')
  // 基地址尾斜杠归一化后不出现双斜杠。
  assert.equal(buildFlagAuditUrl('/api/v1/'), '/api/v1/admin/flag-audit-events?limit=20')
})

test('开关留痕：limit 走契约边界 1..50（显式值原样、越界收进边界）', () => {
  assert.equal(buildFlagAuditUrl('/api/v1', { limit: 50 }), '/api/v1/admin/flag-audit-events?limit=50')
  assert.equal(buildFlagAuditUrl('/api/v1', { limit: 999 }), '/api/v1/admin/flag-audit-events?limit=50')
  assert.equal(buildFlagAuditUrl('/api/v1', { limit: 0 }), '/api/v1/admin/flag-audit-events?limit=1')
})

test('开关留痕：续页游标原样进 cursor 参数，本地不解析内容', () => {
  assert.equal(
    buildFlagAuditUrl('/api/v1', { cursor: 'abc|def' }),
    '/api/v1/admin/flag-audit-events?limit=20&cursor=abc%7Cdef',
  )
  // 空串游标不发请求（必然 400），超长游标也不发（契约 maxLength 2048）。
  assert.throws(() => buildFlagAuditUrl('/api/v1', { cursor: '' }), TypeError)
  assert.throws(() => buildFlagAuditUrl('/api/v1', { cursor: 'x'.repeat(2049) }), RangeError)
})

test('开关留痕：请求是 GET，只带 authorization/accept，令牌不进 URL', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse(200, envelope(pageOf([event()])))
  }
  const result = await fetchFlagAuditPage({ fetchImpl, baseUrl: '/api/v1', token: TOKEN })

  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/v1/admin/flag-audit-events?limit=20')
  assert.equal(calls[0].init.method, 'GET')
  assert.deepEqual(calls[0].init.headers, { authorization: `Bearer ${TOKEN}`, accept: 'application/json' })
  assert.equal(calls[0].init.credentials, 'omit')
  assert.equal(calls[0].init.body, undefined)
  assert.equal(calls[0].url.includes(TOKEN), false)
  assert.equal(result.requestUrl, '/api/v1/admin/flag-audit-events?limit=20')
})

// ---------------------------------------------------------------------------
// 2. keyset 分页游标
// ---------------------------------------------------------------------------

test('开关留痕：首页不带 cursor，续页把 next_cursor 原样回传并累计页数', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    if (urls.length === 1) return jsonResponse(200, envelope(pageOf([event({ id: ID_A })], 'cursor-page-2')))
    return jsonResponse(200, envelope(pageOf([event({ id: ID_B })], null)))
  }

  const first = await fetchFlagAuditPage({ fetchImpl, baseUrl: '/api/v1', token: TOKEN, limit: 20 })
  assert.equal(first.ok, true)
  assert.equal(first.page.nextCursor, 'cursor-page-2')
  assert.equal(urls[0].includes('cursor='), false)

  const afterFirst = appendFlagAuditPage(emptyFlagAuditCollection(), { cursor: null, page: first.page })
  assert.equal(afterFirst.collection.pages, 1)
  assert.equal(afterFirst.collection.nextCursor, 'cursor-page-2')
  assert.equal(canLoadMoreFlagAudit(readyState(afterFirst.collection)), true)

  const second = await fetchFlagAuditPage({
    fetchImpl,
    baseUrl: '/api/v1',
    token: TOKEN,
    limit: 20,
    cursor: afterFirst.collection.nextCursor,
  })
  assert.equal(second.ok, true)
  assert.equal(urls[1], '/api/v1/admin/flag-audit-events?limit=20&cursor=cursor-page-2')

  const afterSecond = appendFlagAuditPage(afterFirst.collection, { cursor: 'cursor-page-2', page: second.page })
  assert.equal(afterSecond.collection.pages, 2)
  assert.equal(afterSecond.collection.nextCursor, null)
  assert.equal(afterSecond.collection.items.length, 2)
  // 末页（next_cursor=null）不再提供「加载下一页」。
  assert.equal(canLoadMoreFlagAudit(readyState(afterSecond.collection)), false)
})

test('开关留痕：续页按 id 去重；服务端原样返回请求游标时停止续页（不死循环）', () => {
  const base = collectionOf([event({ id: ID_A })], 'c-1')
  const { collection } = appendFlagAuditPage(base, {
    cursor: 'c-1',
    page: { items: [event({ id: ID_A }), event({ id: ID_B })], nextCursor: 'c-1' },
  })

  assert.equal(collection.duplicates, 1)
  assert.equal(collection.cycle, true)
  assert.equal(collection.nextCursor, null)
  assert.equal(collection.items.length, 2)
  assert.equal(canLoadMoreFlagAudit(readyState(collection)), false)
})

// ---------------------------------------------------------------------------
// 3. 空态
// ---------------------------------------------------------------------------

test('开关留痕空态：items 空 + next_cursor null 是合法空页，文案不得写成「没改过开关」', async () => {
  const result = await fetchFlagAuditPage({
    fetchImpl: async () => jsonResponse(200, envelope(pageOf([], null))),
    baseUrl: '/api/v1',
    token: TOKEN,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.page.items, [])
  assert.equal(result.page.nextCursor, null)

  const collection = appendFlagAuditPage(emptyFlagAuditCollection(), { cursor: null, page: result.page }).collection
  const view = describeFlagAudit(readyState(collection))

  assert.equal(view.tone, 'empty')
  assert.equal(view.title, '开关变更留痕为空')
  assert.match(view.detail, /空台账/)
  // 关键：空页只表示读到 0 条，不等于平台从未改过开关。
  assert.match(view.detail, /不等于「平台从未改过开关」/)
  assert.match(view.detail, /503/)
  assert.equal(view.total, 0)
  assert.equal(view.canRetry, false)
  assert.equal(view.errorCode, '')
  assert.deepEqual(flagAuditRows(readyState(collection)), [])
})

// ---------------------------------------------------------------------------
// 4. 失败态（文案逐条核：不许把失败说成空台账、不许写错 scope）
// ---------------------------------------------------------------------------

test('开关留痕失败态：503 未接线 ⇒ 服务暂不可用（可重试），绝不渲染成空台账', async () => {
  const result = await fetchFlagAuditPage({
    fetchImpl: async () => errorResponse(503, 'PROVIDER_UNAVAILABLE', '开关变更留痕读取尚未接线'),
    baseUrl: '/api/v1',
    token: TOKEN,
  })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'unavailable')
  assert.equal(result.status, 503)
  assert.equal(result.retriable, true)
  assert.equal(result.inContract, true)

  const failure = describeFlagAuditFailure(result)
  assert.equal(failure.title, '服务暂不可用')
  assert.match(failure.detail, /未接线/)
  assert.equal(failure.action, 'retry')

  const signedIn = { ...initialFlagAuditState(), signedIn: true, phase: 'loading' }
  const view = describeFlagAudit(reduceFlagAudit(signedIn, { type: 'LOAD_FAIL', failure: result }))
  assert.equal(view.tone, 'error')
  assert.equal(view.title, '服务暂不可用')
  assert.equal(view.canRetry, true)
  assert.equal(view.errorCode, 'PROVIDER_UNAVAILABLE（契约内错误码）')
  // 没有行 ⇒ 不得出现空态文案
  assert.equal(view.tone === 'empty', false)
})

test('开关留痕失败态：403 ⇒ 文案必须写 flags:read，不得写成 audit:read', async () => {
  const result = await fetchFlagAuditPage({
    fetchImpl: async () => errorResponse(403, 'SCOPE_DENIED'),
    baseUrl: '/api/v1',
    token: TOKEN,
  })
  assert.equal(result.kind, 'forbidden')
  assert.equal(result.retriable, false)

  const failure = describeFlagAuditFailure(result)
  assert.equal(failure.title, `权限不足（缺少 ${FLAG_AUDIT_SCOPE}）`)
  assert.match(failure.detail, /flags:read/)
  // 这是另一条路径（/admin/audit-events）的 scope：本页不得借用它的文案。
  assert.equal(failure.detail.includes('audit:read'), false)
  assert.equal(failure.action, 'none')
})

test('开关留痕失败态：400 INVALID_CURSOR ⇒ 游标失效 + 从第一页重读（不复用旧游标）', async () => {
  const result = await fetchFlagAuditPage({
    fetchImpl: async () => errorResponse(400, 'INVALID_CURSOR'),
    baseUrl: '/api/v1',
    token: TOKEN,
    cursor: 'stale-cursor',
  })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'invalid_cursor')
  assert.equal(result.status, 400)

  const failure = describeFlagAuditFailure(result)
  assert.equal(failure.title, '游标已失效')
  assert.equal(failure.action, 'restart')
  assert.equal(failure.retriable, false)
  assert.match(failure.detail, /从第一页重读/)
  assert.match(failure.detail, new RegExp(`${FLAG_AUDIT_CURSOR_TTL_MINUTES} 分钟`))

  const signedIn = { ...initialFlagAuditState(), signedIn: true, phase: 'loading' }
  const view = describeFlagAudit(reduceFlagAudit(signedIn, { type: 'LOAD_FAIL', failure: result }))
  assert.equal(view.action, 'restart')
})

test('开关留痕失败态：网络异常 ⇒ 可重试，且失败对象保留 requestUrl 便于复现', async () => {
  const result = await fetchFlagAuditPage({
    fetchImpl: async () => {
      throw new Error('boom')
    },
    baseUrl: '/api/v1',
    token: TOKEN,
  })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'network_error')
  assert.equal(result.retriable, true)
  assert.equal(result.requestUrl, '/api/v1/admin/flag-audit-events?limit=20')

  const failure = describeFlagAuditFailure(result)
  assert.equal(failure.title, '网络请求失败')
  assert.equal(failure.action, 'retry')
})

test('开关留痕失败态：响应形状不符契约 ⇒ invalid_response，整页不渲染、不给假重试', async () => {
  const broken = event()
  delete broken.action // 违反 AuditEvent required ⇒ 整页不可信
  const result = await fetchFlagAuditPage({
    fetchImpl: async () => jsonResponse(200, envelope(pageOf([broken]))),
    baseUrl: '/api/v1',
    token: TOKEN,
  })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'invalid_response')
  assert.match(result.message, /AuditEventPage/)
  assert.match(result.message, /action/)

  const failure = describeFlagAuditFailure(result)
  assert.equal(failure.title, '响应不符合契约')
  assert.equal(failure.retriable, false)
  assert.equal(failure.action, 'none')
})

test('开关留痕失败态：未登录（无令牌）不发请求，直接判 signed_out', async () => {
  let called = 0
  const result = await fetchFlagAuditPage({
    fetchImpl: async () => {
      called += 1
      return jsonResponse(200, envelope(pageOf([])))
    },
    baseUrl: '/api/v1',
    token: '',
  })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'signed_out')
  assert.equal(called, 0)
})

// ---------------------------------------------------------------------------
// 5. 行视图与状态机
// ---------------------------------------------------------------------------

test('开关留痕行视图：flag:<key> 提取、前后值人读文本、结果标签', () => {
  const row = flagAuditRowView(
    event({
      actor: ACTOR,
      target_hint: 'flag:ai_enabled',
      before_value: { enabled: true, revision: 3 },
      after_value: { enabled: false, revision: 4 },
    }),
  )

  assert.equal(row.flagKey, 'ai_enabled')
  assert.equal(row.flagKeyLabel, 'ai_enabled')
  assert.equal(row.actor, ACTOR)
  assert.equal(row.actorLabel, ACTOR)
  assert.equal(row.shortActor, ACTOR.slice(0, 8))
  assert.equal(row.changeLabel, '开 → 关（r4）')
  // 关掉业务开关是「收紧」⇒ ok 语气（与审计事件页同一口径）。
  assert.equal(row.changeTone, 'ok')
  assert.equal(row.resultLabel, '已接受')
  assert.equal(row.resultTone, 'ok')
  // target_ref 在开关行常为 null：不编造目标。
  assert.equal(row.targetLabel, null)

  assert.equal(flagKeyOf('flag:submissions_enabled'), 'submissions_enabled')
  assert.equal(flagKeyOf('flag:bad-key'), null)
  assert.equal(flagKeyOf('ai_enabled'), null)
  assert.equal(flagKeyOf(null), null)
})

test('开关留痕行视图：历史行缺 actor/target_hint/前后值时如实标注，不从 request_id 反推', () => {
  const row = flagAuditRowView(event())

  assert.equal(row.actor, null)
  assert.equal(row.actorLabel, '未提供（历史行/服务端未记主体）')
  assert.equal(row.flagKey, null)
  assert.equal(row.flagKeyLabel, '未提供（target_hint = null）')
  assert.equal(row.changeLabel, null)
  assert.equal(row.changeTone, 'muted')
  assert.equal(row.beforeValue, null)
  assert.equal(row.afterValue, null)
})

test('开关留痕：结果分布只统计已加载行，并给出「加载下一页」的判定', () => {
  const state = readyState(
    collectionOf(
      [
        event({ id: ID_A, result: 'accepted' }),
        event({ id: ID_B, result: 'denied' }),
        event({ id: ACTOR, result: 'failed' }),
      ],
      'c-next',
    ),
  )
  assert.deepEqual(flagAuditResultCounts(state), { accepted: 1, denied: 1, failed: 1 })
  assert.equal(flagAuditRows(state).length, 3)
  assert.equal(canLoadMoreFlagAudit(state), true)
  assert.equal(canLoadMoreFlagAudit({ ...state, loadingMore: true }), false)
})

test('开关留痕 reducer：未登录丢弃成功回调；失败保留旧行并标 stale；signed_out 清回未登录', () => {
  const anon = initialFlagAuditState()
  const ignored = reduceFlagAudit(anon, { type: 'LOAD_OK', collection: collectionOf([event()]) })
  assert.equal(ignored.collection.items.length, 0)
  assert.equal(ignored.phase, 'signed_out')

  const signedIn = { ...initialFlagAuditState(), signedIn: true, phase: 'ready' }
  const withRows = reduceFlagAudit(signedIn, { type: 'LOAD_OK', collection: collectionOf([event()]) })
  assert.equal(withRows.collection.items.length, 1)

  const stale = reduceFlagAudit(withRows, {
    type: 'LOAD_FAIL',
    failure: { ok: false, kind: 'unavailable', status: 503, retriable: true },
  })
  assert.equal(stale.phase, 'ready')
  assert.equal(stale.stale, true)
  assert.equal(stale.collection.items.length, 1)
  const staleView = describeFlagAudit(stale)
  assert.equal(staleView.tone, 'stale')
  assert.match(staleView.title, /上次成功读取/)
  assert.equal(staleView.canRetry, true)

  const signedOut = reduceFlagAudit(withRows, {
    type: 'LOAD_FAIL',
    failure: { ok: false, kind: 'signed_out', status: 401, retriable: false },
  })
  assert.equal(signedOut.signedIn, false)
  assert.equal(signedOut.phase, 'signed_out')
})

test('开关留痕：加载中文案写明真实路径与键集游标；limit 变更收进契约边界', () => {
  const loading = describeFlagAudit({ ...initialFlagAuditState(), signedIn: true, phase: 'loading', limit: 50 })
  assert.equal(loading.tone, 'loading')
  assert.equal(loading.detail.includes(FLAG_AUDIT_PATH), true)
  assert.match(loading.detail, /limit=50/)
  assert.match(loading.detail, /created_at DESC, id DESC/)

  assert.equal(reduceFlagAudit(initialFlagAuditState(), { type: 'SET_LIMIT', limit: 999 }).limit, 50)
  assert.equal(reduceFlagAudit(initialFlagAuditState(), { type: 'SET_LIMIT', limit: Number.NaN }).limit, 20)

  // 未登录态文案不得暗示"台账为空"。
  const signedOut = describeFlagAudit({ ...initialFlagAuditState(), phase: 'signed_out' })
  assert.equal(signedOut.title, '未登录')
  assert.equal(signedOut.action, 'sign_in')
})
