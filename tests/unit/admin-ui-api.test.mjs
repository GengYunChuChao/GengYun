import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  appendPage,
  buildAccountsUrl,
  clampLimit,
  describeFailure,
  emptyCollection,
  fetchAccountsPage,
  isRetriable,
  normalizeBaseUrl,
} from '../../apps/admin/src/lib/admin-api.mjs'

// GY-I18：账号读面 HTTP 客户端（假 fetch 注入；不连真实服务、不读真实令牌）。

const TOKEN = 'test-token-not-a-real-secret'

function row(id, overrides = {}) {
  return { id, revision: 1, state: 'active', display_name: `账号 ${id.slice(0, 4)}`, ...overrides }
}

function envelope(data) {
  return { data, meta: { request_id: 'req-1' } }
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

test('buildAccountsUrl: 默认带 limit，续页带 cursor，基地址去尾斜杠', () => {
  assert.equal(buildAccountsUrl('/api/v1'), '/api/v1/admin/accounts?limit=20')
  assert.equal(buildAccountsUrl('/api/v1/', { limit: 50 }), '/api/v1/admin/accounts?limit=50')
  assert.equal(
    buildAccountsUrl('https://example.test/api/v1', { cursor: 'abc+/=', limit: 20 }),
    'https://example.test/api/v1/admin/accounts?limit=20&cursor=abc%2B%2F%3D',
  )
  assert.equal(normalizeBaseUrl('  /api/v1///  '), '/api/v1')
  assert.equal(normalizeBaseUrl(undefined), '')
})

test('clampLimit: 非整数回落默认，越界收到边界', () => {
  assert.equal(clampLimit(undefined), 20)
  assert.equal(clampLimit('abc'), 20)
  assert.equal(clampLimit(2.5), 20)
  assert.equal(clampLimit(0), 1)
  assert.equal(clampLimit(999), 50)
  assert.equal(clampLimit('30'), 30)
})

test('buildAccountsUrl: 游标超 2048 字符或空串不发请求（抛错）', () => {
  assert.throws(() => buildAccountsUrl('/api/v1', { cursor: 'c'.repeat(2049) }), RangeError)
  assert.throws(() => buildAccountsUrl('/api/v1', { cursor: '' }), TypeError)
})

test('fetchAccountsPage: 200 正常页 → ok，取回 items 与 next_cursor', async () => {
  const body = envelope({ items: [row('aaaaaaaa-0000-4000-8000-000000000001'), row('aaaaaaaa-0000-4000-8000-000000000002')], next_cursor: 'c2' })
  const fake = spy(() => jsonResponse(200, body))
  const result = await fetchAccountsPage({ fetchImpl: fake.impl, baseUrl: '/api/v1', token: TOKEN, limit: 20 })
  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
  assert.equal(result.page.items.length, 2)
  assert.equal(result.page.nextCursor, 'c2')
  // 请求头只带 Bearer 与 accept；不带 cookie
  assert.equal(fake.calls.length, 1)
  assert.equal(fake.calls[0].init.method, 'GET')
  assert.equal(fake.calls[0].init.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(fake.calls[0].init.credentials, 'omit')
  assert.match(fake.calls[0].url, /limit=20$/)
})

test('fetchAccountsPage: 200 空列表 → ok 且 nextCursor=null（不是错误）', async () => {
  const fake = spy(() => jsonResponse(200, envelope({ items: [], next_cursor: null })))
  const result = await fetchAccountsPage({ fetchImpl: fake.impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.ok, true)
  assert.deepEqual(result.page.items, [])
  assert.equal(result.page.nextCursor, null)
})

test('fetchAccountsPage: 401 → signed_out（不可重试，回登录）', async () => {
  const fake = spy(() => jsonResponse(401, { error: { code: 'SESSION_EXPIRED' }, meta: { request_id: 'r' } }))
  const result = await fetchAccountsPage({ fetchImpl: fake.impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'signed_out')
  assert.equal(result.retriable, false)
  assert.equal(describeFailure(result).action, 'sign_in')
})

test('fetchAccountsPage: 403 SCOPE_DENIED → forbidden（不重试、不降级成本地假数据）', async () => {
  const fake = spy(() => jsonResponse(403, { error: { code: 'SCOPE_DENIED', message: 'scope accounts:read required' }, meta: {} }))
  const result = await fetchAccountsPage({ fetchImpl: fake.impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.kind, 'forbidden')
  assert.equal(result.code, 'SCOPE_DENIED')
  assert.equal(result.inContract, true)
  assert.equal(result.retriable, false)
  assert.match(describeFailure(result).title, /accounts:read/)
})

test('fetchAccountsPage: 400 INVALID_CURSOR → invalid_cursor，需从第一页重读', async () => {
  const fake = spy(() => jsonResponse(400, { error: { code: 'INVALID_CURSOR' }, meta: {} }))
  const result = await fetchAccountsPage({ fetchImpl: fake.impl, baseUrl: '/api/v1', token: TOKEN, cursor: 'stale-cursor' })
  assert.equal(result.kind, 'invalid_cursor')
  assert.equal(result.retriable, false)
  assert.equal(describeFailure(result).action, 'restart')
})

test('fetchAccountsPage: 429 带 Retry-After → rate_limited 且带秒数', async () => {
  const fake = spy(() => jsonResponse(429, { error: { code: 'RATE_LIMITED' }, meta: {} }, { 'retry-after': '7' }))
  const result = await fetchAccountsPage({ fetchImpl: fake.impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.kind, 'rate_limited')
  assert.equal(result.retryAfterSeconds, 7)
  assert.equal(result.retriable, true)
})

test('fetchAccountsPage: 500/503/504 → unavailable（可重试）', async () => {
  for (const status of [500, 503, 504]) {
    const fake = spy(() => jsonResponse(status, {}))
    const result = await fetchAccountsPage({ fetchImpl: fake.impl, baseUrl: '/api/v1', token: TOKEN })
    assert.equal(result.kind, 'unavailable', `status ${status}`)
    assert.equal(result.retriable, true)
  }
})

test('fetchAccountsPage: 200 但 JSON 畸形 → invalid_response（不渲染任何行）', async () => {
  const fake = spy(() => brokenJsonResponse(200))
  const result = await fetchAccountsPage({ fetchImpl: fake.impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.kind, 'invalid_response')
  assert.equal(result.page, undefined)
})

test('fetchAccountsPage: 200 信封缺 meta / items 非数组 → invalid_response 且指出缺什么', async () => {
  const noMeta = spy(() => jsonResponse(200, { data: { items: [], next_cursor: null } }))
  const missing = await fetchAccountsPage({ fetchImpl: noMeta.impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(missing.kind, 'invalid_response')
  assert.match(missing.message, /data 或 meta/)

  const badItems = spy(() => jsonResponse(200, envelope({ items: 'nope', next_cursor: null })))
  const bad = await fetchAccountsPage({ fetchImpl: badItems.impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(bad.kind, 'invalid_response')
  assert.match(bad.message, /\$\.items/)
  assert.equal(bad.page, undefined)
})

test('describeFailure: invalid_response 不给重试入口（与 isRetriable 闭集一致）', async () => {
  const fake = spy(() => brokenJsonResponse(200))
  const result = await fetchAccountsPage({ fetchImpl: fake.impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.kind, 'invalid_response')
  const described = describeFailure(result)
  assert.equal(described.retriable, false)
  assert.equal(described.action, 'none')
  assert.equal(isRetriable(result.kind), false)
})

test('fetchAccountsPage: 403 但响应无 JSON 信封 → 仍判 forbidden（不信空 code）', async () => {
  const fake = spy(() => brokenJsonResponse(403))
  const result = await fetchAccountsPage({ fetchImpl: fake.impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'forbidden')
  assert.equal(result.code, null)
  assert.equal(result.inContract, false)
  assert.equal(result.retriable, false)
  assert.equal(describeFailure(result).action, 'none')
})

test('fetchAccountsPage: fetch 抛错 → network_error（可重试）', async () => {
  const fake = spy(() => {
    throw new TypeError('Failed to fetch')
  })
  const result = await fetchAccountsPage({ fetchImpl: fake.impl, baseUrl: '/api/v1', token: TOKEN })
  assert.equal(result.kind, 'network_error')
  assert.equal(result.retriable, true)
  assert.match(result.message, /Failed to fetch/)
})

test('fetchAccountsPage: 没有令牌时直接 signed_out，不发请求', async () => {
  let called = 0
  const result = await fetchAccountsPage({
    fetchImpl: async () => {
      called += 1
      return jsonResponse(200, envelope({ items: [], next_cursor: null }))
    },
    baseUrl: '/api/v1',
    token: '',
  })
  assert.equal(result.kind, 'signed_out')
  assert.equal(called, 0)
})

test('fetchAccountsPage: 结果对象不回显令牌', async () => {
  const cases = [
    jsonResponse(200, envelope({ items: [row('aaaaaaaa-0000-4000-8000-000000000001')], next_cursor: null })),
    jsonResponse(401, { error: { code: 'SESSION_REQUIRED' }, meta: {} }),
    jsonResponse(403, { error: { code: 'SCOPE_DENIED' }, meta: {} }),
    jsonResponse(500, {}),
  ]
  for (const response of cases) {
    const result = await fetchAccountsPage({ fetchImpl: async () => response, baseUrl: '/api/v1', token: TOKEN })
    assert.ok(!JSON.stringify(result).includes(TOKEN), `结果里出现了令牌：${JSON.stringify(result)}`)
  }
})

test('appendPage: 跨页按 id 去重并记账 duplicates', () => {
  const first = appendPage(emptyCollection(), {
    cursor: null,
    page: { items: [row('a'), row('b')], nextCursor: 'c2' },
  })
  assert.equal(first.collection.items.length, 2)
  assert.equal(first.collection.nextCursor, 'c2')
  assert.equal(first.collection.pages, 1)

  const second = appendPage(first.collection, {
    cursor: 'c2',
    page: { items: [row('b'), row('c')], nextCursor: null },
  })
  assert.deepEqual(second.added.map((item) => item.id), ['c'])
  assert.equal(second.collection.items.length, 3)
  assert.equal(second.collection.duplicates, 1)
  assert.equal(second.collection.pages, 2)
  assert.equal(second.collection.nextCursor, null)
})

test('appendPage: 服务端把请求游标原样返回来 → 标记 cycle 并停止续页', () => {
  const result = appendPage(emptyCollection(), {
    cursor: 'same-cursor',
    page: { items: [row('a')], nextCursor: 'same-cursor' },
  })
  assert.equal(result.collection.cycle, true)
  assert.equal(result.collection.nextCursor, null)
})

test('isRetriable: 只有 429/5xx/网络错误可重试', () => {
  assert.equal(isRetriable('rate_limited'), true)
  assert.equal(isRetriable('unavailable'), true)
  assert.equal(isRetriable('network_error'), true)
  for (const kind of ['signed_out', 'forbidden', 'invalid_cursor', 'invalid_response', 'http_error']) {
    assert.equal(isRetriable(kind), false, kind)
  }
})
