import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCancelUrl,
  buildJobsUrl,
  canCancelJob,
  canCancelNow,
  canLoadMoreJobs,
  cancelJob,
  describeFailure,
  describeJobs,
  etagForRevision,
  initialJobsState,
  isTerminalJobState,
  jobRowViews,
  listJobs,
  newIdempotencyKey,
  reasonProblem,
  reduceJobs,
  validateJob,
  validateJobPage,
} from '../../apps/admin/src/lib/jobs-api.mjs'

// GY-I18 / issue #18：后台「AI 作业台」读＋取消面（假 fetch 注入；不连真实服务、不读真实令牌）。
//
// 说明：`apps/admin` 目前没有组件级测试基建（无 vitest／@vue/test-utils／jsdom；仓内前端测试
// 一律是「直接 import src/lib/*.mjs 的纯函数测试」），故页面级无基建、本文件不测 SFC 渲染；
// 页面依赖的可测逻辑（URL 组装／If-Match／错误分派／状态机／行视图）都在 jobs-api.mjs 里覆盖。

const TOKEN = 'test-token-not-a-real-secret'
const JOB_ID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const BASE = '/api/v1'

function job(overrides = {}) {
  return {
    id: JOB_ID,
    revision: 3,
    kind: 'recognition',
    target_ref: { type: 'media', id: 'media-1' },
    state: 'running',
    deadline_at: '2026-10-20T12:00:00Z',
    created_at: '2026-10-20T11:58:00Z',
    error_code: null,
    result: null,
    ...overrides,
  }
}

function envelope(data) {
  return { data, meta: { request_id: 'req-jobs-1' } }
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
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init })
      return factory(url, init)
    },
  }
}

test('buildJobsUrl: 默认带 limit，续页带 cursor，基地址去尾斜杠', () => {
  assert.equal(buildJobsUrl('/api/v1'), '/api/v1/admin/jobs?limit=20')
  assert.equal(buildJobsUrl('/api/v1/', { limit: 50 }), '/api/v1/admin/jobs?limit=50')
  assert.equal(buildJobsUrl('https://example.test/api/v1', { cursor: 'abc+/=', limit: 20 }), 'https://example.test/api/v1/admin/jobs?limit=20&cursor=abc%2B%2F%3D')
})

test('buildJobsUrl: limit 夹到契约 1..50；空游标不算续页（本地拒绝）', () => {
  assert.equal(buildJobsUrl(BASE, { limit: 999 }), '/api/v1/admin/jobs?limit=50')
  assert.equal(buildJobsUrl(BASE, { limit: 0 }), '/api/v1/admin/jobs?limit=1')
  assert.throws(() => buildJobsUrl(BASE, { cursor: '' }), TypeError)
})

test('buildJobsUrl: 游标超契约上限或类型不对时在本地抛错（不发必然 400 的请求）', () => {
  assert.throws(() => buildJobsUrl(BASE, { cursor: 'x'.repeat(2049) }), RangeError)
  assert.throws(() => buildJobsUrl(BASE, { cursor: 42 }), TypeError)
})

test('buildCancelUrl: 路径带 id，非 uuid 直接拒绝', () => {
  assert.equal(buildCancelUrl('/api/v1/', JOB_ID), `/api/v1/admin/jobs/${JOB_ID}/cancel`)
  assert.throws(() => buildCancelUrl(BASE, 'not-a-uuid'), TypeError)
  assert.throws(() => buildCancelUrl(BASE, ''), TypeError)
})

test('etagForRevision: 强 ETag 口径 " <revision> "，revision 非法返回 null（不猜）', () => {
  assert.equal(etagForRevision(1), '"1"')
  assert.equal(etagForRevision(7), '"7"')
  assert.equal(etagForRevision(0), null)
  assert.equal(etagForRevision(-2), null)
  assert.equal(etagForRevision(1.5), null)
  assert.equal(etagForRevision('3'), null)
  assert.equal(etagForRevision(null), null)
})

test('newIdempotencyKey: 长度落在契约 8..128，形状 job-<32 hex>，每次不同', () => {
  const first = newIdempotencyKey()
  const second = newIdempotencyKey()
  assert.match(first, /^job-[0-9a-f]{32}$/)
  assert.ok(first.length >= 8 && first.length <= 128)
  assert.notEqual(first, second)
})

test('reasonProblem: 契约 ReasonInput.reason 1..500 字符', () => {
  assert.equal(reasonProblem('按运维确认取消'), null)
  assert.equal(reasonProblem('x'.repeat(500)), null)
  assert.equal(reasonProblem(''), '理由不能为空（契约 ReasonInput.reason 必填）')
  assert.match(reasonProblem('x'.repeat(501)), /最长 500 字符/)
  assert.equal(reasonProblem(undefined), '理由必须是字符串')
})

test('validateJob: 契约九字段齐全即通过，无 error_code 显式 null', () => {
  const result = validateJob(job())
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
})

test('validateJob: 契约里没有 completed —— 用它当 state 属于畸形响应', () => {
  const result = validateJob(job({ state: 'completed' }))
  assert.equal(result.ok, false)
  assert.match(result.errors[0].problem, /state 不在契约 enum：completed/)
})

test('validateJob: 缺 error_code／result 字段判畸形（required 必须显式给出）', () => {
  const missingErrorCode = validateJob({ ...job(), error_code: undefined })
  assert.equal(missingErrorCode.ok, false)
  assert.ok(missingErrorCode.errors.some((error) => error.path === '$.error_code'))

  const missingResult = job()
  delete missingResult.result
  assert.equal(validateJob(missingResult).ok, false)
})

test('validateJob: 契约外字段与非 uuid 只记 warning（行仍可渲染，不猜含义）', () => {
  const result = validateJob({ ...job({ id: 'legacy-id' }), progress: 40 })
  assert.equal(result.ok, true)
  assert.ok(result.warnings.some((warning) => warning.path === '$.id'))
  assert.ok(result.warnings.some((warning) => warning.path === '$.progress'))
})

test('validateJobPage: 空 items + null 游标是合法空态（不是错误）', () => {
  const page = validateJobPage({ items: [], next_cursor: null })
  assert.equal(page.ok, true)
  assert.deepEqual(page.items, [])
  assert.equal(page.nextCursor, null)
})

test('validateJobPage: 缺 next_cursor／空串游标判畸形；超 maxItems 记 warning', () => {
  assert.equal(validateJobPage({ items: [] }).ok, false)
  assert.equal(validateJobPage({ items: [], next_cursor: '' }).ok, false)

  const many = validateJobPage({ items: Array.from({ length: 51 }, () => job()), next_cursor: null })
  assert.equal(many.ok, true)
  assert.ok(many.warnings.some((warning) => warning.path === '$.items'))
})

test('listJobs: GET 带 Bearer + accept，credentials=omit，URL 是 /admin/jobs', async () => {
  const fake = spy(() => jsonResponse(200, envelope({ items: [job()], next_cursor: null })))
  const result = await listJobs({ fetchImpl: fake.impl, baseUrl: BASE, token: TOKEN })

  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
  assert.equal(result.requestId, 'req-jobs-1')
  assert.equal(fake.calls.length, 1)
  const [call] = fake.calls
  assert.equal(call.url, '/api/v1/admin/jobs?limit=20')
  assert.equal(call.init.method, 'GET')
  assert.equal(call.init.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(call.init.headers.accept, 'application/json')
  assert.equal(call.init.headers['if-match'], undefined)
  assert.equal(call.init.credentials, 'omit')
  assert.equal(result.page.items.length, 1)
  assert.equal(result.page.nextCursor, null)
})

test('listJobs: 续页把 cursor 原样带上，nextCursor 透传', async () => {
  const fake = spy(() => jsonResponse(200, envelope({ items: [job()], next_cursor: 'next-cursor' })))
  const result = await listJobs({ fetchImpl: fake.impl, baseUrl: BASE, token: TOKEN, cursor: 'page-2', limit: 50 })

  assert.equal(fake.calls[0].url, '/api/v1/admin/jobs?limit=50&cursor=page-2')
  assert.equal(result.page.nextCursor, 'next-cursor')
})

test('listJobs: 无令牌不发请求，直接 signed_out', async () => {
  const fake = spy(() => jsonResponse(200, envelope({ items: [], next_cursor: null })))
  const result = await listJobs({ fetchImpl: fake.impl, baseUrl: BASE, token: '' })

  assert.equal(result.ok, false)
  assert.equal(result.kind, 'signed_out')
  assert.equal(result.retriable, false)
  assert.equal(fake.calls.length, 0)
})

test('listJobs: 错误分派 —— 401／403／428／503 各自成类，未知码标 inContract=false', async () => {
  const cases = [
    { status: 401, body: { error: { code: 'SESSION_EXPIRED', message: '会话已过期' } }, kind: 'signed_out' },
    { status: 403, body: { error: { code: 'SCOPE_DENIED', message: '缺少 jobs:read' } }, kind: 'forbidden' },
    { status: 400, body: { error: { code: 'INVALID_CURSOR', message: '游标无效' } }, kind: 'invalid_cursor' },
    { status: 503, body: { error: { code: 'PROVIDER_UNAVAILABLE', message: '上游不可用' } }, kind: 'unavailable' },
    { status: 418, body: { error: { code: 'TEAPOT_FROM_THE_FUTURE', message: '未知' } }, kind: 'http_error' },
  ]

  for (const item of cases) {
    const fake = spy(() => jsonResponse(item.status, item.body))
    const result = await listJobs({ fetchImpl: fake.impl, baseUrl: BASE, token: TOKEN })
    assert.equal(result.ok, false, `${item.status} 应为失败`)
    assert.equal(result.kind, item.kind, `${item.status} 应分派为 ${item.kind}`)
    assert.equal(result.status, item.status)
  }

  const unknown = await listJobs({
    fetchImpl: spy(() => jsonResponse(418, { error: { code: 'TEAPOT_FROM_THE_FUTURE', message: '未知' } })).impl,
    baseUrl: BASE,
    token: TOKEN,
  })
  assert.equal(unknown.inContract, false)
})

test('listJobs: 429 的 retry-after 转成秒数提示', async () => {
  const fake = spy(() => jsonResponse(429, { error: { code: 'RATE_LIMITED', message: '太频繁' } }, { 'retry-after': '30' }))
  const result = await listJobs({ fetchImpl: fake.impl, baseUrl: BASE, token: TOKEN })

  assert.equal(result.kind, 'rate_limited')
  assert.equal(result.retriable, true)
  assert.equal(result.retryAfterSeconds, 30)
  assert.equal(describeFailure(result).detail, '约 30 秒后重试')
})

test('listJobs: 畸形响应（缺 meta／非 JSON／state 越界）判 invalid_response 且不可重试', async () => {
  const withoutMeta = spy(() => jsonResponse(200, { data: { items: [], next_cursor: null } }))
  assert.equal((await listJobs({ fetchImpl: withoutMeta.impl, baseUrl: BASE, token: TOKEN })).kind, 'invalid_response')

  const brokenJson = spy(() => brokenJsonResponse(200))
  assert.equal((await listJobs({ fetchImpl: brokenJson.impl, baseUrl: BASE, token: TOKEN })).kind, 'invalid_response')

  const badState = spy(() => jsonResponse(200, envelope({ items: [job({ state: 'completed' })], next_cursor: null })))
  const result = await listJobs({ fetchImpl: badState.impl, baseUrl: BASE, token: TOKEN })
  assert.equal(result.kind, 'invalid_response')
  assert.equal(result.retriable, false)
  assert.match(result.message, /AdminJobPage/)
})

test('listJobs: 网络异常 → network_error（可重试）', async () => {
  const fake = spy(() => {
    throw new TypeError('Failed to fetch')
  })
  const result = await listJobs({ fetchImpl: fake.impl, baseUrl: BASE, token: TOKEN })

  assert.equal(result.ok, false)
  assert.equal(result.kind, 'network_error')
  assert.equal(result.retriable, true)
})

test('cancelJob: POST 带 If-Match 与 Idempotency-Key，body 是契约 ReasonInput', async () => {
  const cancelled = job({ state: 'cancelled', revision: 4 })
  const fake = spy(() => jsonResponse(200, envelope(cancelled), { etag: '"4"' }))
  const result = await cancelJob({
    fetchImpl: fake.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: JOB_ID,
    revision: 3,
    reason: '作业卡在排队',
    idempotencyKey: newIdempotencyKey(),
  })

  assert.equal(result.ok, true)
  const [call] = fake.calls
  assert.equal(call.url, `/api/v1/admin/jobs/${JOB_ID}/cancel`)
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers['if-match'], '"3"')
  assert.ok(call.init.headers['idempotency-key'].startsWith('job-'))
  assert.equal(call.init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(call.init.body), { reason: '作业卡在排队' })
  assert.equal(result.job.state, 'cancelled')
  assert.equal(result.etag, '"4"')
  assert.equal(result.sent['if-match'], '"3"')
  assert.equal(result.requestId, 'req-jobs-1')
})

test('cancelJob: 响应没有 ETag 头时按 revision 推出（不猜）', async () => {
  const fake = spy(() => jsonResponse(200, envelope(job({ state: 'cancelled', revision: 9 }))))
  const result = await cancelJob({
    fetchImpl: fake.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: JOB_ID,
    revision: 3,
    reason: 'x',
    idempotencyKey: newIdempotencyKey(),
  })

  assert.equal(result.etag, '"9"')
})

test('cancelJob: 本地先拦下 —— 非 uuid／空理由／revision 0／缺幂等键都不发请求', async () => {
  const fake = spy(() => jsonResponse(200, envelope(job())))
  const base = { fetchImpl: fake.impl, baseUrl: BASE, token: TOKEN, id: JOB_ID, revision: 3, reason: 'ok', idempotencyKey: newIdempotencyKey() }

  const badId = await cancelJob({ ...base, id: 'nope' })
  assert.equal(badId.kind, 'invalid_request')

  const emptyReason = await cancelJob({ ...base, reason: '' })
  assert.equal(emptyReason.kind, 'invalid_request')
  assert.match(emptyReason.message, /理由不能为空/)

  const zeroRevision = await cancelJob({ ...base, revision: 0 })
  assert.equal(zeroRevision.kind, 'invalid_request')
  assert.match(zeroRevision.message, /revision/)

  const noKey = await cancelJob({ ...base, idempotencyKey: '' })
  assert.equal(noKey.kind, 'idempotency_key_required')

  assert.equal(fake.calls.length, 0)
})

test('cancelJob: 取消语义的错误分派 —— 428／409 修订冲突／409 幂等冲突／409 在飞', async () => {
  const base = { baseUrl: BASE, token: TOKEN, id: JOB_ID, revision: 3, reason: 'x', idempotencyKey: newIdempotencyKey() }

  const required = await cancelJob({
    ...base,
    fetchImpl: spy(() => jsonResponse(428, { error: { code: 'REVISION_REQUIRED', message: '缺 If-Match' } })).impl,
  })
  assert.equal(required.kind, 'revision_required')
  assert.equal(describeFailure(required).action, 'reload')

  const conflict = await cancelJob({
    ...base,
    fetchImpl: spy(() => jsonResponse(409, { error: { code: 'REVISION_CONFLICT', message: '版本不一致' } })).impl,
  })
  assert.equal(conflict.kind, 'revision_conflict')
  assert.equal(conflict.retriable, false)
  assert.equal(describeFailure(conflict).action, 'reload')

  const idempotency = await cancelJob({
    ...base,
    fetchImpl: spy(() => jsonResponse(409, { error: { code: 'IDEMPOTENCY_CONFLICT', message: '键与 body 不匹配' } })).impl,
  })
  assert.equal(idempotency.kind, 'idempotency_conflict')

  const inFlight = await cancelJob({
    ...base,
    fetchImpl: spy(() => jsonResponse(409, { error: { code: 'REQUEST_IN_PROGRESS', message: '同一键在飞' } })).impl,
  })
  assert.equal(inFlight.kind, 'in_progress')
  assert.equal(inFlight.retriable, true)
  assert.equal(describeFailure(inFlight).action, 'retry')
})

test('cancelJob: 结果不回显令牌（只留 If-Match／幂等键与请求 id）', async () => {
  const fake = spy(() => jsonResponse(200, envelope(job({ state: 'cancelled' }))))
  const result = await cancelJob({
    fetchImpl: fake.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: JOB_ID,
    revision: 3,
    reason: 'x',
    idempotencyKey: newIdempotencyKey(),
  })

  assert.equal(JSON.stringify(result).includes(TOKEN), false)
})

test('终态判定：契约五个终态为 true，queued／running 为 false，completed 不是契约状态', () => {
  for (const state of ['succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled']) {
    assert.equal(isTerminalJobState(state), true, `${state} 应为终态`)
  }
  for (const state of ['queued', 'running', 'completed', 'weird']) {
    assert.equal(isTerminalJobState(state), false, `${state} 不应判为终态`)
  }
})

test('canCancelJob: 只有 queued／running 且 id／revision 合法时返回 true', () => {
  assert.equal(canCancelJob(job({ state: 'running' })), true)
  assert.equal(canCancelJob(job({ state: 'queued' })), true)
  assert.equal(canCancelJob(job({ state: 'succeeded' })), false)
  assert.equal(canCancelJob(job({ state: 'cancelled' })), false)
  assert.equal(canCancelJob(job({ revision: 0 })), false)
  assert.equal(canCancelJob(job({ id: 'legacy' })), false)
  assert.equal(canCancelJob(null), false)
})

test('状态机：SIGNED_IN → loading，LOAD_OK 去重合并并记住游标，LOAD_FAIL 进 error 态', () => {
  let state = initialJobsState()
  assert.equal(describeJobs(state).tone, 'empty')

  state = reduceJobs(state, { type: 'SIGNED_IN', scopes: ['jobs:read', 'jobs:cancel'], scopesProvided: true })
  assert.equal(state.signedIn, true)
  assert.equal(state.phase, 'loading')
  assert.equal(state.hasCancelScope, true)
  assert.equal(describeJobs(state).title, '正在读取作业…')

  state = reduceJobs(state, { type: 'LOAD_OK', jobs: [job()], nextCursor: 'cursor-2', reset: true })
  assert.equal(state.phase, 'ready')
  assert.equal(state.jobs.length, 1)
  assert.equal(state.nextCursor, 'cursor-2')
  assert.equal(canLoadMoreJobs(state), true)

  // 同一 id 的续页重复条目不会变成两行
  state = reduceJobs(state, { type: 'LOAD_OK', jobs: [job(), job({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })], nextCursor: null })
  assert.equal(state.jobs.length, 2)
  assert.equal(canLoadMoreJobs(state), false)

  const failed = reduceJobs(state, { type: 'LOAD_FAIL', failure: { ok: false, kind: 'forbidden', status: 403, retriable: false } })
  assert.equal(describeJobs(failed).tone, 'error')
  assert.equal(describeJobs(failed).title, '权限不足（scope 不足）')
})

test('状态机：空列表是合法空态（tone=empty，可重读，不是错误）', () => {
  let state = reduceJobs(initialJobsState(), { type: 'SIGNED_IN', scopes: [], scopesProvided: true })
  state = reduceJobs(state, { type: 'LOAD_OK', jobs: [], nextCursor: null, reset: true })

  const view = describeJobs(state)
  assert.equal(view.title, '暂无作业')
  assert.equal(view.tone, 'empty')
  assert.equal(view.canRetry, true)
  assert.equal(state.hasReadScope, false)
})

test('状态机：WRITE_OK 只替换该行（局部刷新，未改动的行保持同一对象，不整表重载）', () => {
  const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  let state = reduceJobs(initialJobsState(), { type: 'SIGNED_IN', scopes: ['jobs:read', 'jobs:cancel'], scopesProvided: true })
  state = reduceJobs(state, { type: 'LOAD_OK', jobs: [job(), job({ id: otherId, kind: 'ocr', state: 'queued' })], nextCursor: null, reset: true })

  const before = state.jobs
  const cancelled = job({ state: 'cancelled', revision: 4, error_code: 'CANCELLED_BY_ADMIN' })
  state = reduceJobs(state, { type: 'WRITE_OK', job: cancelled, receipt: { etag: '"4"', requestId: 'req-9' } })

  assert.notEqual(state.jobs, before)
  assert.equal(state.jobs[1], before[1])
  assert.equal(state.jobs[0].state, 'cancelled')
  assert.equal(state.jobs[0].revision, 4)
  assert.equal(state.jobs[0].error_code, 'CANCELLED_BY_ADMIN')
  assert.equal(state.writeStatus, 'saved')
  assert.equal(state.receipt.requestId, 'req-9')
  assert.equal(state.jobs.length, 2)

  const rows = jobRowViews(state)
  assert.equal(rows[0].terminal, true)
  assert.equal(rows[0].cancelable, false)
  assert.equal(rows[1].cancelable, true)
  assert.equal(rows[0].etag, '"4"')
})

test('状态机：WRITE_FAIL 记住失败与挂起意向，重试复用同一幂等键', () => {
  let state = reduceJobs(initialJobsState(), { type: 'SIGNED_IN', scopes: ['jobs:read', 'jobs:cancel'], scopesProvided: true })
  state = reduceJobs(state, { type: 'LOAD_OK', jobs: [job()], nextCursor: null, reset: true })
  state = reduceJobs(state, { type: 'SET_REASON', value: '卡在排队' })
  state = reduceJobs(state, { type: 'WRITE_START', id: JOB_ID, revision: 3, reason: '卡在排队', idempotencyKey: 'job-fixed-key' })

  assert.equal(state.writeStatus, 'writing')
  assert.equal(state.cancelingId, JOB_ID)
  assert.equal(jobRowViews(state)[0].writing, true)

  const failure = { ok: false, kind: 'unavailable', status: 503, retriable: true }
  state = reduceJobs(state, { type: 'WRITE_FAIL', failure })

  assert.equal(state.writeStatus, 'failed')
  assert.equal(state.cancelingId, null)
  assert.equal(state.write.idempotencyKey, 'job-fixed-key')
  assert.equal(state.write.revision, 3)
  assert.equal(describeFailure(state.writeFailure).retriable, true)
})

test('canCancelNow: 需要理由合法、有 jobs:cancel、且没有在飞的取消', () => {
  let state = reduceJobs(initialJobsState(), { type: 'SIGNED_IN', scopes: ['jobs:read', 'jobs:cancel'], scopesProvided: true })
  assert.equal(canCancelNow(state), false) // 理由为空
  state = reduceJobs(state, { type: 'SET_REASON', value: '按运维确认取消' })
  assert.equal(canCancelNow(state), true)

  const noScope = reduceJobs(state, { type: 'SIGNED_IN', scopes: ['jobs:read'], scopesProvided: true })
  assert.equal(noScope.hasCancelScope, false)
  assert.equal(canCancelNow({ ...state, hasCancelScope: false }), false)
  assert.equal(canCancelNow({ ...state, writeStatus: 'writing' }), false)
  assert.equal(canCancelNow({ ...state, signedIn: false }), false)
})

test('jobRowViews: state 徽标色调与终态禁用原因对齐既有 pill 闭集', () => {
  let state = reduceJobs(initialJobsState(), { type: 'SIGNED_IN', scopes: ['jobs:read', 'jobs:cancel'], scopesProvided: true })
  state = reduceJobs(state, {
    type: 'LOAD_OK',
    reset: true,
    nextCursor: null,
    jobs: [
      job({ id: '11111111-1111-4111-8111-111111111111', state: 'queued' }),
      job({ id: '22222222-2222-4222-8222-222222222222', state: 'running' }),
      job({ id: '33333333-3333-4333-8333-333333333333', state: 'succeeded' }),
      job({ id: '44444444-4444-4444-8444-444444444444', state: 'uncertain', error_code: 'PROVIDER_OUTCOME_UNKNOWN' }),
      job({ id: '55555555-5555-4555-8555-555555555555', state: 'failed', error_code: 'PROVIDER_TIMEOUT' }),
    ],
  })

  const rows = jobRowViews(state)
  assert.deepEqual(rows.map((row) => row.tone), ['off', 'pending', 'ok', 'warn', 'danger'])
  assert.deepEqual(rows.map((row) => row.cancelable), [true, true, false, false, false])
  assert.match(rows[2].cancelBlockedReason, /已是终态 succeeded/)
  assert.equal(rows[3].errorCode, 'PROVIDER_OUTCOME_UNKNOWN')
  assert.equal(rows[0].errorCode, '—')
  assert.equal(rows[0].createdAt, '2026-10-20T11:58:00Z') // 原样展示，不重排时区
  assert.equal(rows[0].deadlineAt, '2026-10-20T12:00:00Z')
})
