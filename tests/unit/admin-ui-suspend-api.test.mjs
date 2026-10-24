import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCOUNTS_SUSPEND_SCOPE,
  buildSuspendUrl,
  canSuspendAccount,
  etagForRevision,
  newIdempotencyKey,
  reasonProblem,
  suspendAccount,
} from '../../apps/admin/src/lib/account-suspend-api.mjs'

// GY-I18：账号「停用」写面 HTTP 客户端（假 fetch 注入；不连真实服务、不读真实令牌）。

const BASE = '/api/v1'
const TOKEN = 'test-token-not-a-real-secret'
const ACCOUNT_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

function account(overrides = {}) {
  return { id: ACCOUNT_ID, revision: 1, state: 'active', display_name: '张三', ...overrides }
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

test('buildSuspendUrl: 拼接单账号停用路径，id 必须是 uuid', () => {
  assert.equal(buildSuspendUrl('/api/v1', ACCOUNT_ID), `/api/v1/admin/accounts/${ACCOUNT_ID}/suspend`)
  assert.equal(buildSuspendUrl('/api/v1/', ACCOUNT_ID), `/api/v1/admin/accounts/${ACCOUNT_ID}/suspend`)
  assert.throws(() => buildSuspendUrl('/api/v1', 'legacy'), TypeError)
  assert.throws(() => buildSuspendUrl('/api/v1', ''), TypeError)
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

test('newIdempotencyKey: 长度落在契约 8..128，形状 account-<32 hex>，每次不同', () => {
  const first = newIdempotencyKey()
  const second = newIdempotencyKey()
  assert.ok(first.startsWith('account-'))
  assert.equal(first.length, 40)
  assert.match(first, /^account-[0-9a-f]{32}$/)
  assert.notEqual(first, second)
})

test('reasonProblem: 契约 ReasonInput.reason 1..500 字符', () => {
  assert.equal(reasonProblem('按运营裁定停用'), null)
  assert.equal(reasonProblem('x'.repeat(500)), null)
  assert.equal(reasonProblem(''), '理由不能为空（契约 ReasonInput.reason 必填）')
  assert.match(reasonProblem('x'.repeat(501)), /最长 500 字符/)
  assert.equal(reasonProblem(undefined), '理由必须是字符串')
})

test('canSuspendAccount: 只有 active 且 id／revision 合法时返回 true', () => {
  assert.equal(canSuspendAccount(account({ state: 'active' })), true)
  assert.equal(canSuspendAccount(account({ state: 'suspended' })), false)
  assert.equal(canSuspendAccount(account({ state: 'deletion_pending' })), false)
  assert.equal(canSuspendAccount(account({ revision: 0 })), false)
  assert.equal(canSuspendAccount(account({ id: 'legacy' })), false)
  assert.equal(canSuspendAccount(null), false)
})

test('suspendAccount: POST 带 If-Match 与 Idempotency-Key，body 是契约 ReasonInput', async () => {
  const fake = spy(() => jsonResponse(200, envelope(account({ state: 'suspended', revision: 4 })), { etag: '"4"' }))
  const result = await suspendAccount({
    fetchImpl: fake.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: ACCOUNT_ID,
    revision: 3,
    reason: '违反社区规范',
    idempotencyKey: newIdempotencyKey(),
  })

  assert.equal(result.ok, true)
  const [call] = fake.calls
  assert.equal(call.url, `/api/v1/admin/accounts/${ACCOUNT_ID}/suspend`)
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(call.init.headers['if-match'], '"3"')
  assert.ok(call.init.headers['idempotency-key'].startsWith('account-'))
  assert.equal(call.init.headers['content-type'], 'application/json')
  assert.equal(call.init.credentials, 'omit')
  assert.deepEqual(JSON.parse(call.init.body), { reason: '违反社区规范' })
  assert.equal(result.account.state, 'suspended')
  assert.equal(result.account.revision, 4)
  assert.equal(result.etag, '"4"')
})

test('suspendAccount: 响应没有 ETag 头时按 revision 推出（不猜）', async () => {
  const fake = spy(() => jsonResponse(200, envelope(account({ state: 'suspended', revision: 9 }))))
  const result = await suspendAccount({
    fetchImpl: fake.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: ACCOUNT_ID,
    revision: 3,
    reason: 'x',
    idempotencyKey: newIdempotencyKey(),
  })

  assert.equal(result.etag, '"9"')
})

test('suspendAccount: 本地先拦下 —— 非 uuid／空理由／revision 0／缺幂等键都不发请求', async () => {
  const fake = spy(() => jsonResponse(200, envelope(account())))
  const base = {
    fetchImpl: fake.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: ACCOUNT_ID,
    revision: 3,
    reason: 'ok',
    idempotencyKey: newIdempotencyKey(),
  }

  const badId = await suspendAccount({ ...base, id: 'nope' })
  assert.equal(badId.kind, 'invalid_request')

  const emptyReason = await suspendAccount({ ...base, reason: '' })
  assert.equal(emptyReason.kind, 'invalid_request')
  assert.match(emptyReason.message, /理由不能为空/)

  const zeroRevision = await suspendAccount({ ...base, revision: 0 })
  assert.equal(zeroRevision.kind, 'invalid_request')
  assert.match(zeroRevision.message, /revision/)

  const noKey = await suspendAccount({ ...base, idempotencyKey: '' })
  assert.equal(noKey.kind, 'idempotency_key_required')

  const tooLongKey = await suspendAccount({ ...base, idempotencyKey: 'k'.repeat(129) })
  assert.equal(tooLongKey.kind, 'invalid_request')

  assert.equal(fake.calls.length, 0)
})

test('suspendAccount: 错误分派 —— 428／409 修订冲突／409 幂等冲突／409 在飞', async () => {
  const base = { baseUrl: BASE, token: TOKEN, id: ACCOUNT_ID, revision: 3, reason: 'x', idempotencyKey: newIdempotencyKey() }

  const required = await suspendAccount({
    ...base,
    fetchImpl: spy(() => jsonResponse(428, { error: { code: 'REVISION_REQUIRED', message: '缺 If-Match' } })).impl,
  })
  assert.equal(required.kind, 'revision_required')
  assert.equal(required.retriable, false)

  const conflict = await suspendAccount({
    ...base,
    fetchImpl: spy(() => jsonResponse(409, { error: { code: 'REVISION_CONFLICT', message: '版本不一致' } })).impl,
  })
  assert.equal(conflict.kind, 'revision_conflict')
  assert.equal(conflict.retriable, false)

  const idempotency = await suspendAccount({
    ...base,
    fetchImpl: spy(() => jsonResponse(409, { error: { code: 'IDEMPOTENCY_CONFLICT', message: '键与 body 不匹配' } })).impl,
  })
  assert.equal(idempotency.kind, 'idempotency_conflict')

  const inFlight = await suspendAccount({
    ...base,
    fetchImpl: spy(() => jsonResponse(409, { error: { code: 'REQUEST_IN_PROGRESS', message: '同一键在飞' } })).impl,
  })
  assert.equal(inFlight.kind, 'in_progress')
  assert.equal(inFlight.retriable, true)
})

test('suspendAccount: 其余错误分派 —— 401/403/404/429/503', async () => {
  const base = { baseUrl: BASE, token: TOKEN, id: ACCOUNT_ID, revision: 3, reason: 'x', idempotencyKey: newIdempotencyKey() }

  const signedOut = await suspendAccount({
    ...base,
    fetchImpl: spy(() => jsonResponse(401, { error: { code: 'SESSION_EXPIRED' } })).impl,
  })
  assert.equal(signedOut.kind, 'signed_out')

  const forbidden = await suspendAccount({
    ...base,
    fetchImpl: spy(() => jsonResponse(403, { error: { code: 'SCOPE_DENIED' } })).impl,
  })
  assert.equal(forbidden.kind, 'forbidden')

  const notFound = await suspendAccount({
    ...base,
    fetchImpl: spy(() => jsonResponse(404, { error: { code: 'NOT_FOUND' } })).impl,
  })
  assert.equal(notFound.kind, 'not_found')

  const rateLimited = await suspendAccount({
    ...base,
    fetchImpl: spy(() => jsonResponse(429, { error: { code: 'RATE_LIMITED' } }, { 'retry-after': '9' })).impl,
  })
  assert.equal(rateLimited.kind, 'rate_limited')
  assert.equal(rateLimited.retriable, true)
  assert.equal(rateLimited.retryAfterSeconds, 9)

  const unavailable = await suspendAccount({
    ...base,
    fetchImpl: spy(() => jsonResponse(503, { error: { code: 'PROVIDER_UNAVAILABLE' } })).impl,
  })
  assert.equal(unavailable.kind, 'unavailable')
  assert.equal(unavailable.retriable, true)
})

test('suspendAccount: 畸形响应（缺 meta／非 JSON／state 越界）判 invalid_response 且不可重试', async () => {
  const base = { baseUrl: BASE, token: TOKEN, id: ACCOUNT_ID, revision: 3, reason: 'x', idempotencyKey: newIdempotencyKey() }

  const withoutMeta = await suspendAccount({
    ...base,
    fetchImpl: spy(() => jsonResponse(200, { data: account({ state: 'suspended' }) })).impl,
  })
  assert.equal(withoutMeta.kind, 'invalid_response')

  const brokenJson = await suspendAccount({ ...base, fetchImpl: spy(() => brokenJsonResponse(200)).impl })
  assert.equal(brokenJson.kind, 'invalid_response')

  const badState = await suspendAccount({
    ...base,
    fetchImpl: spy(() => jsonResponse(200, envelope(account({ state: 'weird' })))).impl,
  })
  assert.equal(badState.kind, 'invalid_response')
  assert.equal(badState.retriable, false)
  assert.match(badState.message, /AdminAccountView/)
})

test('suspendAccount: 网络异常 → network_error（可重试）', async () => {
  const fake = spy(() => {
    throw new TypeError('Failed to fetch')
  })
  const result = await suspendAccount({
    fetchImpl: fake.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: ACCOUNT_ID,
    revision: 3,
    reason: 'x',
    idempotencyKey: newIdempotencyKey(),
  })

  assert.equal(result.ok, false)
  assert.equal(result.kind, 'network_error')
  assert.equal(result.retriable, true)
})

test('suspendAccount: 结果不回显令牌', async () => {
  const fake = spy(() => jsonResponse(200, envelope(account({ state: 'suspended' }))))
  const result = await suspendAccount({
    fetchImpl: fake.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: ACCOUNT_ID,
    revision: 3,
    reason: 'x',
    idempotencyKey: newIdempotencyKey(),
  })

  assert.equal(JSON.stringify(result).includes(TOKEN), false)
})

test('ACCOUNTS_SUSPEND_SCOPE: 契约写面 scope 为 accounts:suspend', () => {
  assert.equal(ACCOUNTS_SUSPEND_SCOPE, 'accounts:suspend')
})
