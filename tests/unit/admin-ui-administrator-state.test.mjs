import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ADMINISTRATOR_STATE_MODES,
  ADMINISTRATOR_STATE_SCOPE,
  buildAdministratorStateUrl,
  canChangeAdministratorState,
  classifyAdministratorStateFailure,
  describeAdministratorStateFailure,
  newIdempotencyKey,
  setAdministratorState,
  validateAdministratorStateView,
} from '../../apps/admin/src/lib/administrator-state-api.mjs'

// R67-A05：管理员账号「停用／恢复」写面 HTTP 客户端 + 后台目录页入口。
// 假 fetch 注入：不连真实服务、不读真实令牌；视图侧只做源码钉子（本仓后台无 jsdom/vitest）。

const BASE = '/api/v1'
const TOKEN = 'test-token-not-a-real-secret'
const ADMIN_ID = 'bbbbbbbb-0000-4000-8000-000000000002'
const VIEW_URL = new URL('../../apps/admin/src/views/AdministratorsView.vue', import.meta.url)

function stateView(overrides = {}) {
  return {
    id: ADMIN_ID,
    revision: 4,
    state: 'suspended',
    auth_epoch: 2,
    revoked_sessions: 1,
    changed: true,
    ...overrides,
  }
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
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init })
      return factory(url, init)
    },
  }
}

function row(overrides = {}) {
  return { id: ADMIN_ID, revision: 4, state: 'active', ...overrides }
}

// ---------------------------------------------------------------- URL 构造

test('buildAdministratorStateUrl: 两种 mode 各自的路径，斜杠归一', () => {
  assert.equal(buildAdministratorStateUrl('/api/v1', ADMIN_ID, 'disable'), `/api/v1/admin/administrators/${ADMIN_ID}/disable`)
  assert.equal(buildAdministratorStateUrl('/api/v1', ADMIN_ID, 'enable'), `/api/v1/admin/administrators/${ADMIN_ID}/enable`)
  assert.equal(buildAdministratorStateUrl('/api/v1/', ADMIN_ID, 'disable'), `/api/v1/admin/administrators/${ADMIN_ID}/disable`)
  assert.equal(buildAdministratorStateUrl('', ADMIN_ID, 'enable'), `/admin/administrators/${ADMIN_ID}/enable`)
})

test('buildAdministratorStateUrl: 非法 mode／非法 id 一律返回 null（不抛异常）', () => {
  // 只认契约里的两个字面量：`suspend` 是**终端用户**停用，走的是另一条路径，不能拼到这里。
  for (const mode of ['suspend', 'DISABLE', 'Disable', '', 'disable ', 'enable/../disable', null, undefined, 0, {}]) {
    assert.equal(buildAdministratorStateUrl(BASE, ADMIN_ID, mode), null, `mode=${String(mode)} 必须返回 null`)
  }
  for (const id of ['legacy', '', null, undefined, 42, `${ADMIN_ID} `]) {
    assert.equal(buildAdministratorStateUrl(BASE, id, 'disable'), null, `id=${String(id)} 必须返回 null`)
  }
  assert.deepEqual(ADMINISTRATOR_STATE_MODES, ['disable', 'enable'])
  assert.equal(ADMINISTRATOR_STATE_SCOPE, 'scopes:write')
})

// ---------------------------------------------------------------- 幂等键

test('newIdempotencyKey: 落在契约 8..128，形状 administrator-<32 hex>，每次不同', () => {
  const first = newIdempotencyKey()
  const second = newIdempotencyKey()
  assert.match(first, /^administrator-[0-9a-f]{32}$/)
  assert.ok(first.length >= 8 && first.length <= 128, `长度 ${first.length} 必须在契约 IdempotencyKey 的 8..128 内`)
  assert.notEqual(first, second)
})

// ---------------------------------------------------------------- 可操作性（真值表）

test('canChangeAdministratorState: 真值表（state／uuid／revision 缺一个都 false）', () => {
  assert.equal(canChangeAdministratorState(row({ state: 'active' }), 'disable'), true)
  assert.equal(canChangeAdministratorState(row({ state: 'suspended' }), 'enable'), true)
  // 状态与 mode 不匹配：不该给按钮动作
  assert.equal(canChangeAdministratorState(row({ state: 'suspended' }), 'disable'), false)
  assert.equal(canChangeAdministratorState(row({ state: 'active' }), 'enable'), false)
  // 契约外的 state（闭集只有 active／suspended）
  assert.equal(canChangeAdministratorState(row({ state: 'deletion_pending' }), 'disable'), false)
  assert.equal(canChangeAdministratorState(row({ state: 'active' }), 'revoke'), false)
  // 坏 uuid
  assert.equal(canChangeAdministratorState(row({ id: 'legacy' }), 'disable'), false)
  assert.equal(canChangeAdministratorState(row({ id: '' }), 'disable'), false)
  assert.equal(canChangeAdministratorState(row({ id: null }), 'disable'), false)
  // 坏 revision（没有可用的 If-Match 来源）
  assert.equal(canChangeAdministratorState(row({ revision: 0 }), 'disable'), false)
  assert.equal(canChangeAdministratorState(row({ revision: -1 }), 'disable'), false)
  assert.equal(canChangeAdministratorState(row({ revision: 1.5 }), 'disable'), false)
  assert.equal(canChangeAdministratorState(row({ revision: '3' }), 'disable'), false)
  assert.equal(canChangeAdministratorState(row({ revision: Number.NaN }), 'disable'), false)
  assert.equal(canChangeAdministratorState(row({ revision: undefined }), 'disable'), false)
  // 非对象
  assert.equal(canChangeAdministratorState(null, 'disable'), false)
  assert.equal(canChangeAdministratorState(undefined, 'enable'), false)
})

// ---------------------------------------------------------------- 请求形状

test('setAdministratorState: POST 带 If-Match 与 Idempotency-Key，body 是契约 ReasonInput', async () => {
  const key = newIdempotencyKey()
  const fake = spy(() => jsonResponse(200, envelope(stateView()), { etag: '"4"' }))
  const result = await setAdministratorState({
    fetchImpl: fake.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: ADMIN_ID,
    revision: 4,
    mode: 'disable',
    reason: '违反管理员操作规范',
    idempotencyKey: key,
  })

  assert.equal(result.ok, true)
  assert.equal(fake.calls.length, 1)
  const [call] = fake.calls
  assert.equal(call.url, `/api/v1/admin/administrators/${ADMIN_ID}/disable`)
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(call.init.headers.accept, 'application/json')
  assert.equal(call.init.headers['content-type'], 'application/json')
  assert.equal(call.init.headers['if-match'], '"4"')
  assert.equal(call.init.headers['idempotency-key'], key)
  assert.equal(call.init.credentials, 'omit')
  assert.deepEqual(JSON.parse(call.init.body), { reason: '违反管理员操作规范' })
  assert.equal(result.changed, true)
  assert.equal(result.id, ADMIN_ID)
  assert.equal(result.state, 'suspended')
  assert.equal(result.revision, 4)
  assert.equal(result.authEpoch, 2)
  assert.equal(result.revokedSessions, 1)
  assert.equal(result.etag, '"4"')
  assert.equal(result.requestId, 'req-1')
})

test('setAdministratorState: enable 走 /enable，signal 透传', async () => {
  const controller = new AbortController()
  const fake = spy(() => jsonResponse(200, envelope(stateView({ state: 'active', revoked_sessions: 0 }))))
  const result = await setAdministratorState({
    fetchImpl: fake.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: ADMIN_ID,
    revision: 5,
    mode: 'enable',
    reason: '复核后恢复',
    idempotencyKey: newIdempotencyKey(),
    signal: controller.signal,
  })

  assert.equal(result.ok, true)
  assert.equal(fake.calls[0].url, `/api/v1/admin/administrators/${ADMIN_ID}/enable`)
  assert.equal(fake.calls[0].init.headers['if-match'], '"5"')
  assert.equal(fake.calls[0].init.signal, controller.signal)
  assert.equal(result.state, 'active')
})

test('setAdministratorState: 本地先拦下 —— 坏 mode／坏 id／空理由／缺令牌都不发请求', async () => {
  const cases = [
    [{ mode: 'suspend' }, 'invalid_request'],
    [{ id: 'legacy' }, 'invalid_request'],
    [{ revision: 0 }, 'invalid_request'],
    [{ revision: 1.5 }, 'invalid_request'],
    [{ reason: '' }, 'invalid_request'],
    [{ reason: 'x'.repeat(501) }, 'invalid_request'],
    [{ token: '' }, 'signed_out'],
    [{ idempotencyKey: 'short' }, 'idempotency_key_required'],
    [{ idempotencyKey: 'k'.repeat(129) }, 'invalid_request'],
  ]
  for (const [override, kind] of cases) {
    const fake = spy(() => jsonResponse(200, envelope(stateView())))
    const result = await setAdministratorState({
      fetchImpl: fake.impl,
      baseUrl: BASE,
      token: TOKEN,
      id: ADMIN_ID,
      revision: 4,
      mode: 'disable',
      reason: '合规理由',
      idempotencyKey: newIdempotencyKey(),
      ...override,
    })
    assert.equal(result.ok, false, `${JSON.stringify(Object.keys(override))} 必须本地拦下`)
    assert.equal(result.kind, kind, `${JSON.stringify(override)} ⇒ ${kind}`)
    assert.equal(fake.calls.length, 0, '本地拦下的请求不得发出去')
  }
})

// R67-A05 审查阻塞 A：页面**从不**注入 `fetchImpl`（视图里根本没有这个参数），所以「没传 fetchImpl」
// 绝不等于「这个环境没有 fetch」——必须按 `account-suspend-api.mjs` 的既有写法回落到 `globalThis.fetch`，
// 只有两者都没有才报「当前环境没有可用的 fetch」。首版的用例把错误行为写成了期望，这里改回来。
test('setAdministratorState: 不传 fetchImpl ⇒ 回落到 globalThis.fetch，且真的打到停用端点', async () => {
  const fake = spy(() => jsonResponse(200, envelope(stateView()), { etag: '"4"' }))
  const original = globalThis.fetch
  globalThis.fetch = fake.impl
  try {
    const result = await setAdministratorState({
      baseUrl: BASE,
      token: TOKEN,
      id: ADMIN_ID,
      revision: 4,
      mode: 'disable',
      reason: '违反管理员操作规范',
      idempotencyKey: newIdempotencyKey(),
    })
    assert.equal(fake.calls.length, 1, 'globalThis.fetch 必须被调用一次（页面就是这样用的）')
    assert.equal(fake.calls[0].url, `/api/v1/admin/administrators/${ADMIN_ID}/disable`, '必须打到停用端点')
    assert.equal(fake.calls[0].init.method, 'POST')
    assert.equal(fake.calls[0].init.headers['if-match'], '"4"')
    assert.equal(result.ok, true, '回落发出去的请求成功时结果必须是成功')
    assert.equal(result.revision, 4)
    assert.equal(result.state, 'suspended')
  } finally {
    globalThis.fetch = original
  }
})

test('setAdministratorState: 只有 fetchImpl 与 globalThis.fetch 都没有才报「当前环境没有可用的 fetch」', async () => {
  const original = globalThis.fetch
  globalThis.fetch = undefined
  try {
    const result = await setAdministratorState({
      baseUrl: BASE,
      token: TOKEN,
      id: ADMIN_ID,
      revision: 4,
      mode: 'disable',
      reason: '合规理由',
      idempotencyKey: newIdempotencyKey(),
    })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'network_error')
    assert.equal(result.message, '当前环境没有可用的 fetch')
  } finally {
    globalThis.fetch = original
  }
})

// ---------------------------------------------------------------- 错误分类矩阵

test('classifyAdministratorStateFailure: 矩阵（含两条自锁门与 412）', () => {
  const cases = [
    [401, null, 'signed_out'],
    [401, 'SESSION_EXPIRED', 'signed_out'],
    [403, 'ACCOUNT_INACTIVE', 'signed_out'],
    [403, 'SCOPE_DENIED', 'forbidden'],
    [403, 'SELF_DISABLE_DENIED', 'self_disable_denied'],
    [409, 'SELF_DISABLE_DENIED', 'self_disable_denied'],
    [403, 'LAST_SCOPE_MANAGER', 'last_scope_manager'],
    [409, 'LAST_SCOPE_MANAGER', 'last_scope_manager'],
    [428, 'REVISION_REQUIRED', 'revision_required'],
    [428, null, 'revision_required'],
    [409, 'REVISION_CONFLICT', 'revision_conflict'],
    [412, null, 'revision_conflict'],
    [412, 'REVISION_CONFLICT', 'revision_conflict'],
    [409, 'IDEMPOTENCY_CONFLICT', 'idempotency_conflict'],
    [409, 'REQUEST_IN_PROGRESS', 'in_progress'],
    [404, 'NOT_FOUND', 'not_found'],
    [404, null, 'not_found'],
    [429, null, 'rate_limited'],
    [503, 'PROVIDER_UNAVAILABLE', 'unavailable'],
    [504, null, 'unavailable'],
    [500, null, 'unavailable'],
    [503, 'PROVIDER_TIMEOUT', 'unavailable'],
    [422, 'PROVIDER_OUTCOME_UNKNOWN', 'unavailable'],
    [400, 'INVALID_REQUEST', 'invalid_request'],
    [409, 'SOMETHING_NEW', 'http_error'],
  ]
  for (const [status, code, kind] of cases) {
    assert.equal(classifyAdministratorStateFailure(status, code), kind, `${status}/${code} ⇒ ${kind}`)
  }
})

test('setAdministratorState: 错误分派（428／409×3／412／401／403／404／503）', async () => {
  const cases = [
    [428, 'REVISION_REQUIRED', 'revision_required', false],
    [409, 'REVISION_CONFLICT', 'revision_conflict', false],
    [412, null, 'revision_conflict', false],
    [409, 'SELF_DISABLE_DENIED', 'self_disable_denied', false],
    [409, 'LAST_SCOPE_MANAGER', 'last_scope_manager', false],
    [409, 'IDEMPOTENCY_CONFLICT', 'idempotency_conflict', false],
    [409, 'REQUEST_IN_PROGRESS', 'in_progress', true],
    [401, 'SESSION_EXPIRED', 'signed_out', false],
    [403, 'SCOPE_DENIED', 'forbidden', false],
    [404, 'NOT_FOUND', 'not_found', false],
    [503, 'PROVIDER_UNAVAILABLE', 'unavailable', true],
    [504, null, 'unavailable', true],
  ]
  for (const [status, code, kind, retriable] of cases) {
    const fake = spy(() => jsonResponse(status, { error: { code, message: '服务端说明', retryable: false }, meta: { request_id: 'req-2' } }))
    const result = await setAdministratorState({
      fetchImpl: fake.impl,
      baseUrl: BASE,
      token: TOKEN,
      id: ADMIN_ID,
      revision: 4,
      mode: 'disable',
      reason: '合规理由',
      idempotencyKey: newIdempotencyKey(),
    })
    assert.equal(result.ok, false, `${status}/${code} 必须失败`)
    assert.equal(result.kind, kind, `${status}/${code} ⇒ ${kind}`)
    assert.equal(result.status, status)
    assert.equal(result.code, code)
    assert.equal(result.inContract, code !== null, `${status}/${code} 的 inContract：有码在闭集内，无码为 false`)
    assert.equal(result.retriable, retriable, `${status}/${code} 的 retriable 由 kind 决定`)
    // 没有 code 的响应体不算契约错误信封（readErrorEnvelope 要求非空 code）⇒ 走 HTTP 兜底文案
    assert.equal(result.message, code === null ? `请求失败（HTTP ${status}）` : '服务端说明')
    assert.equal(result.requestUrl, `/api/v1/admin/administrators/${ADMIN_ID}/disable`)
  }
})

test('setAdministratorState: 未知 code 原样保留并标 inContract:false', async () => {
  const fake = spy(() => jsonResponse(409, { error: { code: 'SOMETHING_NEW', message: '新门', retryable: false } }))
  const result = await setAdministratorState({
    fetchImpl: fake.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: ADMIN_ID,
    revision: 4,
    mode: 'enable',
    reason: '合规理由',
    idempotencyKey: newIdempotencyKey(),
  })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'http_error')
  assert.equal(result.code, 'SOMETHING_NEW')
  assert.equal(result.inContract, false)
})

test('setAdministratorState: 非 JSON／无信封／字段缺失一律 invalid_response，不当成功', async () => {
  const bodies = [
    ['meta 缺失', { data: stateView() }],
    ['data 缺失', { meta: { request_id: 'req-3' } }],
    ['data 非对象', { data: 'nope', meta: { request_id: 'req-3' } }],
    ['meta 非对象', { data: stateView(), meta: 'nope' }],
    ['revision 缺失', { data: stateView({ revision: undefined }), meta: { request_id: 'req-3' } }],
    ['revision 0', { data: stateView({ revision: 0 }), meta: { request_id: 'req-3' } }],
    ['id 非 uuid', { data: stateView({ id: 'legacy' }), meta: { request_id: 'req-3' } }],
    ['state 越界', { data: stateView({ state: 'deleted' }), meta: { request_id: 'req-3' } }],
    ['auth_epoch 缺失', { data: stateView({ auth_epoch: undefined }), meta: { request_id: 'req-3' } }],
    ['auth_epoch 0', { data: stateView({ auth_epoch: 0 }), meta: { request_id: 'req-3' } }],
    ['revoked_sessions 非整数', { data: stateView({ revoked_sessions: 1.5 }), meta: { request_id: 'req-3' } }],
    ['changed 非布尔', { data: stateView({ changed: 'yes' }), meta: { request_id: 'req-3' } }],
  ]
  for (const [label, body] of bodies) {
    const fake = spy(() => jsonResponse(200, body))
    const result = await setAdministratorState({
      fetchImpl: fake.impl,
      baseUrl: BASE,
      token: TOKEN,
      id: ADMIN_ID,
      revision: 4,
      mode: 'disable',
      reason: '合规理由',
      idempotencyKey: newIdempotencyKey(),
    })
    assert.equal(result.ok, false, `${label} 必须判失败`)
    assert.equal(result.kind, 'invalid_response', `${label} ⇒ invalid_response`)
    assert.equal(result.retriable, false)
  }

  const broken = spy(() => brokenJsonResponse(200))
  const brokenResult = await setAdministratorState({
    fetchImpl: broken.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: ADMIN_ID,
    revision: 4,
    mode: 'disable',
    reason: '合规理由',
    idempotencyKey: newIdempotencyKey(),
  })
  assert.equal(brokenResult.ok, false)
  assert.equal(brokenResult.kind, 'invalid_response')
})

test('validateAdministratorStateView: 契约外字段只警告（additionalProperties:false 但不改判决）', () => {
  const checked = validateAdministratorStateView({ ...stateView(), extra: 1 })
  assert.equal(checked.ok, true)
  assert.ok(checked.warnings.some((warning) => warning.includes('extra')))
})

// ---------------------------------------------------------------- 幂等空操作分支

test('setAdministratorState: changed:false 的幂等空操作照样是成功（不写第二条审计、不推 revision）', async () => {
  const write = spy(() => jsonResponse(200, envelope(stateView({ state: 'active', revision: 4, revoked_sessions: 0, changed: false })), { etag: '"4"' }))
  const result = await setAdministratorState({
    fetchImpl: write.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: ADMIN_ID,
    revision: 4,
    mode: 'enable',
    reason: '重复提交',
    idempotencyKey: newIdempotencyKey(),
  })

  assert.equal(result.ok, true)
  assert.equal(result.changed, false)
  assert.equal(result.revision, 4)
  assert.equal(result.state, 'active')
})

test('setAdministratorState: 结果不回显令牌', async () => {
  const fake = spy(() => jsonResponse(200, envelope(stateView())))
  const result = await setAdministratorState({
    fetchImpl: fake.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: ADMIN_ID,
    revision: 4,
    mode: 'disable',
    reason: '合规理由',
    idempotencyKey: newIdempotencyKey(),
  })
  assert.ok(!JSON.stringify(result).includes(TOKEN))
  assert.ok(!JSON.stringify(result).includes('test-token'))
})

// ---------------------------------------------------------------- 失败说明（视图用的中文口径）

test('describeAdministratorStateFailure: 四类硬门与版本门各有如实中文说明', () => {
  const selfDisable = describeAdministratorStateFailure({ ok: false, kind: 'self_disable_denied', status: 409, code: 'SELF_DISABLE_DENIED' })
  assert.equal(selfDisable.title, '不能停用自己（自锁门拒绝）')
  assert.equal(selfDisable.canRetry, false)

  const lastManager = describeAdministratorStateFailure({ ok: false, kind: 'last_scope_manager', status: 409, code: 'LAST_SCOPE_MANAGER' })
  assert.equal(lastManager.title, '会使有效持有 scopes:write 的管理员归零，需先给他人授权')
  assert.equal(lastManager.canRetry, false)

  const conflict = describeAdministratorStateFailure({ ok: false, kind: 'revision_conflict', status: 409, code: 'REVISION_CONFLICT' })
  assert.equal(conflict.title, '该行已被别处改过，重新加载后再试')
  assert.equal(conflict.canReload, true)

  const required = describeAdministratorStateFailure({ ok: false, kind: 'revision_required', status: 428, code: 'REVISION_REQUIRED' })
  assert.equal(required.title, '这次请求缺少版本号（不应发生，属缺陷）')

  // 未知 kind 也要给一句中文（不吞错误码）
  const unknown = describeAdministratorStateFailure({ ok: false, kind: 'http_error', status: 418, code: 'TEAPOT' })
  assert.match(unknown.title, /失败/)
  assert.match(unknown.detail, /TEAPOT/)
})

// R67-A05 审查非阻塞 1：可重试性必须**服务端声明优先**（与 admin-api.mjs 的 `serverAllowsRetry`
// 同一口径：`false` 就是 `false`）。后端每条 503 都显式 `retryable:false`，此时页面上那个「重试」
// 必然换回同样的 503 —— 承诺可重试就是在骗用户。
test('describeAdministratorStateFailure: 可重试与否按服务端声明（与 admin-api.mjs serverAllowsRetry 同序）', () => {
  const declaredNo = describeAdministratorStateFailure({
    ok: false,
    kind: 'unavailable',
    status: 503,
    code: 'PROVIDER_UNAVAILABLE',
    retriable: true,
    serverRetryable: false,
  })
  assert.equal(declaredNo.canRetry, false, '服务端显式 retryable:false ⇒ 不给「重试」')

  const declaredYes = describeAdministratorStateFailure({
    ok: false,
    kind: 'unavailable',
    status: 503,
    code: 'PROVIDER_UNAVAILABLE',
    retriable: false,
    serverRetryable: true,
  })
  assert.equal(declaredYes.canRetry, true, '服务端显式 retryable:true ⇒ 可重试（声明优先于本地闭集）')

  // 没有服务端响应（本地/网络失败）时回落到本地闭集；network_error 重放同一幂等键是安全的。
  assert.equal(
    describeAdministratorStateFailure({ ok: false, kind: 'network_error', retriable: true }).canRetry,
    true,
  )
  assert.equal(
    describeAdministratorStateFailure({ ok: false, kind: 'in_progress', status: 409, code: 'REQUEST_IN_PROGRESS', retriable: true }).canRetry,
    true,
    '写面带幂等键：同一幂等键重放不会二次生效',
  )
  // 老形状（只带 retriable）继续按本地闭集解释，不因缺 serverRetryable 就一律不可重试。
  assert.equal(describeAdministratorStateFailure({ ok: false, kind: 'rate_limited', status: 429, retriable: true }).canRetry, true)
})

test('setAdministratorState: 503 且服务端显式 retryable:false ⇒ 结果带 serverRetryable:false 且页面不给重试', async () => {
  const fake = spy(() =>
    jsonResponse(503, {
      error: { code: 'PROVIDER_UNAVAILABLE', message: '发送通道未接线', retryable: false },
      meta: { request_id: 'req-503' },
    }),
  )
  const result = await setAdministratorState({
    fetchImpl: fake.impl,
    baseUrl: BASE,
    token: TOKEN,
    id: ADMIN_ID,
    revision: 4,
    mode: 'disable',
    reason: '违反管理员操作规范',
    idempotencyKey: newIdempotencyKey(),
  })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'unavailable')
  assert.equal(result.serverRetryable, false, '服务端声明必须原样带出来')
  assert.equal(describeAdministratorStateFailure(result).canRetry, false, '必然无效的「重试」不能给')
})

// ---------------------------------------------------------------- 视图钉子（源码片段，不写死行号）

test('AdministratorsView: 行内按钮按状态条件渲染，可用性来自 canChangeAdministratorState', () => {
  const source = readFileSync(VIEW_URL, 'utf8')
  assert.match(source, /v-if="row\.state === 'active'"/, 'active 行才挂「停用」按钮')
  assert.match(source, /v-if="row\.state === 'suspended'"/, 'suspended 行才挂「恢复」按钮')
  assert.match(source, /canChange\(row, 'disable'\)/, '停用按钮可用性走 canChange → canChangeAdministratorState')
  assert.match(source, /canChange\(row, 'enable'\)/, '恢复按钮可用性走 canChange → canChangeAdministratorState')
  assert.match(source, /canChangeAdministratorState/, '视图必须复用 lib 的判据，不在模板里散写')
  assert.match(source, /data-testid="administrator-disable"/)
  assert.match(source, /data-testid="administrator-enable"/)
})

test('AdministratorsView: 确认框带 role/aria-modal/aria-labelledby，焦点搬运复用 dialog-focus', () => {
  const source = readFileSync(VIEW_URL, 'utf8')
  assert.match(source, /role="dialog"/)
  assert.match(source, /aria-modal="true"/)
  assert.match(source, /aria-labelledby="administrator-state-title"/)
  assert.match(source, /id="administrator-state-title"/)
  assert.match(source, /@keydown="onStateKeydown"/)
  assert.match(source, /FOCUSABLE_SELECTOR/, 'Tab 循环枚举复用 lib/dialog-focus.mjs')
  assert.match(source, /nextFocusIndex\(/, 'Tab 循环下标算法复用 lib/dialog-focus.mjs')
  assert.match(source, /from '\.\.\/lib\/dialog-focus\.mjs'/)
  assert.match(source, /Escape[\s\S]{0,80}changeSaving\.value\)\s*return/, 'Esc 在提交中不关框')
  assert.match(source, /tabindex="-1"/, '框容器与标题可编程聚焦')
})

test('AdministratorsView: 理由输入与既有 reasonProblem 同口径，提交中禁用并给可见进度', () => {
  const source = readFileSync(VIEW_URL, 'utf8')
  assert.match(source, /reasonProblem/, '复用 account-suspend-api.mjs 导出的 reasonProblem')
  assert.match(source, /from '\.\.\/lib\/account-suspend-api\.mjs'/)
  assert.match(source, /maxlength="500"/)
  assert.match(source, /:disabled="[^"]*changeSaving/)
  assert.match(source, /中…/, '提交中有可见进度文案')
})

test('AdministratorsView: 失败回执来自 WriteReceipt（role 由组件按 failed 决定，视图不再造 alert）', () => {
  const source = readFileSync(VIEW_URL, 'utf8')
  assert.match(source, /from '\.\/WriteReceipt\.vue'/)
  assert.match(source, /<WriteReceipt/)
  assert.match(source, /:write="changeReceipt\.write"/)
  assert.match(source, /:changed="changeReceipt\.verdict"/)
  // 新加的失败说明只是普通文本节点：没有自己的 role，播报交给 WriteReceipt（失败时它才给 alert）。
  assert.match(source, /data-testid="administrator-state-failure"/)
  assert.doesNotMatch(source, /data-testid="administrator-state-failure"[^>]*role=/, '失败说明不得自带 role')
})

test('AdministratorsView: 成功后刷新目录，且不伪造「会话已恢复」', () => {
  const source = readFileSync(VIEW_URL, 'utf8')
  assert.match(source, /result\.ok[\s\S]{0,600}refresh\(\)/, '成功后重新拉第一页（revision 已前进）')
  assert.match(source, /不会恢复被撤销的会话/, '恢复文案必须如实：不复活已撤销会话')
  assert.match(source, /不会恢复被撤销的 scope/, '恢复文案必须如实：不恢复已撤销的 scope')
  assert.doesNotMatch(source, /已恢复会话/)
  assert.doesNotMatch(source, /已恢复权限/)
})
