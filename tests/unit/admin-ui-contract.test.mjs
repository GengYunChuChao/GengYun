import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCOUNT_STATES,
  ACCOUNTS_PATH,
  ACCOUNTS_SCOPE,
  CURSOR_MAX_LENGTH,
  ERROR_CODES,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  LIMIT_MIN,
  readErrorEnvelope,
  readPageEnvelope,
  validateAccountPage,
  validateAccountView,
} from '../../apps/admin/src/lib/admin-contract.mjs'

// GY-I18：后台账号读面（GET /admin/accounts）的契约常量与形状校验。
// 只断言 packages/contracts/openapi.json 里写得明的东西；不镜像后端口径。

function validRow(overrides = {}) {
  return {
    id: '0f0e8f9e-6a5b-4c1d-9a2f-1b2c3d4e5f60',
    revision: 3,
    state: 'active',
    display_name: '示例账号',
    ...overrides,
  }
}

function validPage(overrides = {}) {
  return { items: [validRow()], next_cursor: null, ...overrides }
}

test('admin-contract: 契约常量与 openapi.json 一致（路径/scope/边界/enum 规模）', () => {
  assert.equal(ACCOUNTS_PATH, '/admin/accounts')
  assert.equal(ACCOUNTS_SCOPE, 'accounts:read')
  assert.equal(LIMIT_MIN, 1)
  assert.equal(LIMIT_MAX, 50)
  assert.equal(LIMIT_DEFAULT, 20)
  assert.equal(CURSOR_MAX_LENGTH, 2048)
  assert.deepEqual([...ACCOUNT_STATES], ['active', 'suspended', 'deletion_pending'])
  // ErrorCode enum 共 24 项（本文件按契约抄录，改动须同步契约）
  assert.equal(ERROR_CODES.length, 24)
  for (const code of ['INVALID_CURSOR', 'SESSION_REQUIRED', 'SESSION_EXPIRED', 'SCOPE_DENIED', 'RATE_LIMITED']) {
    assert.ok(ERROR_CODES.includes(code), `ERROR_CODES 缺少 ${code}`)
  }
})

test('validateAccountView: 契约形状的行通过校验', () => {
  const result = validateAccountView(validRow())
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
})

test('validateAccountView: 缺 display_name / state 越界 / revision 非法都是 error 而非 warning', () => {
  const missingName = validateAccountView(validRow({ display_name: '' }))
  assert.equal(missingName.ok, false)
  assert.deepEqual(missingName.errors.map((e) => e.path), ['$.display_name'])

  const badState = validateAccountView(validRow({ state: 'archived' }))
  assert.equal(badState.ok, false)
  assert.match(badState.errors[0].problem, /enum/)

  assert.equal(validateAccountView(validRow({ revision: 0 })).ok, false)
  assert.equal(validateAccountView(validRow({ revision: '3' })).ok, false)
  assert.equal(validateAccountView(validRow({ revision: 2.5 })).ok, false)
})

test('validateAccountView: 非对象/数组/null 直接判 error', () => {
  for (const value of [null, undefined, [], 'row', 42]) {
    const result = validateAccountView(value)
    assert.equal(result.ok, false)
    assert.equal(result.errors.length, 1)
  }
})

test('validateAccountView: 契约外字段与超长显示名只记 warning（仍可渲染）', () => {
  const extra = validateAccountView(validRow({ created_at: '2026-10-19T00:00:00Z' }))
  assert.equal(extra.ok, true)
  assert.equal(extra.warnings.length, 1)
  assert.match(extra.warnings[0].problem, /契约外字段/)

  const longName = validateAccountView(validRow({ display_name: 'x'.repeat(81) }))
  assert.equal(longName.ok, true)
  assert.match(longName.warnings[0].problem, /80/)

  const badUuid = validateAccountView(validRow({ id: 'not-a-uuid' }))
  assert.equal(badUuid.ok, true)
  assert.match(badUuid.warnings[0].problem, /uuid/)
})

test('validateAccountPage: 空列表 + next_cursor=null 是合法空态（不是错误）', () => {
  const result = validateAccountPage({ items: [], next_cursor: null })
  assert.equal(result.ok, true)
  assert.deepEqual(result.items, [])
  assert.equal(result.nextCursor, null)
})

test('validateAccountPage: next_cursor 缺失 / 空串 / 超长都是 error', () => {
  const missing = validateAccountPage({ items: [] })
  assert.equal(missing.ok, false)
  assert.equal(missing.errors[0].path, '$.next_cursor')

  const empty = validateAccountPage({ items: [], next_cursor: '' })
  assert.equal(empty.ok, false)

  const tooLong = validateAccountPage({ items: [], next_cursor: 'c'.repeat(CURSOR_MAX_LENGTH + 1) })
  assert.equal(tooLong.ok, false)
})

test('validateAccountPage: items 非数组是 error；坏行带下标定位', () => {
  const notArray = validateAccountPage({ items: {}, next_cursor: null })
  assert.equal(notArray.ok, false)
  assert.equal(notArray.errors[0].path, '$.items')

  const badRow = validateAccountPage({ items: [validRow(), validRow({ state: 'nope' })], next_cursor: null })
  assert.equal(badRow.ok, false)
  assert.deepEqual(badRow.errors.map((e) => e.path), ['$.items[1].state'])
  // 校验失败不抛：坏行仍被返回，由调用方整体判畸形、不渲染
  assert.equal(badRow.items.length, 2)
})

test('validateAccountPage: 页级多余键（如 total）记 warning，页仍可渲染', () => {
  const result = validateAccountPage({ items: [validRow()], next_cursor: null, total: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.items.length, 1)
  assert.deepEqual(result.warnings.map((warning) => warning.path), ['$.total'])
  assert.match(result.warnings[0].problem, /契约外字段/)
  // 页级多余键只是 warning，不会让整页判畸形、也不会丢行
  assert.equal(result.nextCursor, null)
})

test('validateAccountPage: 续页游标原样取回，超出 maxItems 只记 warning', () => {
  const ok = validateAccountPage(validPage({ next_cursor: 'cursor-2' }))
  assert.equal(ok.ok, true)
  assert.equal(ok.nextCursor, 'cursor-2')

  const items = Array.from({ length: 51 }, (_, index) =>
    validRow({ id: `0f0e8f9e-6a5b-4c1d-9a2f-1b2c3d4e5f${String(index).padStart(2, '0')}` }),
  )
  const over = validateAccountPage({ items, next_cursor: null })
  assert.equal(over.ok, true)
  assert.match(over.warnings[0].problem, /maxItems/)
})

test('readErrorEnvelope: 契约内 code 标 inContract，未知 code 如实保留', () => {
  const known = readErrorEnvelope({ error: { code: 'SCOPE_DENIED', message: 'no scope' }, meta: {} })
  assert.deepEqual(known, { code: 'SCOPE_DENIED', inContract: true, message: 'no scope' })

  const unknown = readErrorEnvelope({ error: { code: 'WAT', message: '' } })
  assert.equal(unknown.code, 'WAT')
  assert.equal(unknown.inContract, false)

  assert.equal(readErrorEnvelope({ error: {} }), null)
  assert.equal(readErrorEnvelope({ error: { code: 42 } }), null)
  assert.equal(readErrorEnvelope(null), null)
  assert.equal(readErrorEnvelope({ data: {} }), null)
})

test('readPageEnvelope: 只认 { data, meta } 双全的信封', () => {
  const body = { data: { items: [], next_cursor: null }, meta: { request_id: 'r-1' } }
  assert.deepEqual(readPageEnvelope(body), { items: [], next_cursor: null })

  assert.equal(readPageEnvelope({ data: { items: [] } }), null)
  assert.equal(readPageEnvelope({ meta: {} }), null)
  assert.equal(readPageEnvelope({ data: [], meta: {} }), null)
  assert.equal(readPageEnvelope([body]), null)
})
