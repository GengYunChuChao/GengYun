import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

test('admin-contract: 路径/scope/分页边界/state enum 逐字钉住契约口径（手抄镜像，改契约须同步这里）', () => {
  assert.equal(ACCOUNTS_PATH, '/admin/accounts')
  assert.equal(ACCOUNTS_SCOPE, 'accounts:read')
  assert.equal(LIMIT_MIN, 1)
  assert.equal(LIMIT_MAX, 50)
  assert.equal(LIMIT_DEFAULT, 20)
  assert.equal(CURSOR_MAX_LENGTH, 2048)
  assert.deepEqual([...ACCOUNT_STATES], ['active', 'suspended', 'deletion_pending'])
})

// GY-R67-B01：`ERROR_CODES` 是**手写镜像**，一致性只能靠读契约逐项对拍证明。
// 改动前这里写的是 `assert.equal(ERROR_CODES.length, 27)` + 8 个码的点检——条数对上就绿：
// 把镜像里的 `INPUT_UNCERTAIN` 换成任一契约外码（条数仍是 27，不在点检名单内），
// 用例照样 ✔，契约新增/改名一个码它也不会红。那是**永久绿**：它从没读过 openapi.json。

/** 契约真值：`components.schemas.ErrorCode.enum`（唯一事实来源，不在测试里手抄）。 */
const CONTRACT_ERROR_CODES = JSON.parse(
  readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'),
).components.schemas.ErrorCode.enum

/**
 * 镜像 ↔ 契约逐项对拍，**顺序不敏感**，返回差异清单而不是布尔。
 *
 * 只比条数是假绿（见上）；这里按集合比两项：契约有而镜像没有（missing）、镜像有而契约没有（extra）。
 * 差异非空时由 `assertErrorCodesMirror` 把差异码原样打进断言消息，日志里直接看到差哪个码。
 */
function diffErrorCodes(mirror, contractEnum) {
  const mirrorSet = new Set(mirror)
  const contractEnumSet = new Set(contractEnum)
  return {
    missing: contractEnum.filter((code) => !mirrorSet.has(code)),
    extra: mirror.filter((code) => !contractEnumSet.has(code)),
  }
}

/** 真断言：差异非空即红，消息里点名缺项/多项。 */
function assertErrorCodesMirror(mirror, contractEnum) {
  const { missing, extra } = diffErrorCodes(mirror, contractEnum)
  const detail = `缺项=${missing.length === 0 ? '（无）' : missing.join('、')}；多项=${extra.length === 0 ? '（无）' : extra.join('、')}`
  assert.deepEqual(missing, [], `镜像缺少契约 ErrorCode 里的码：${detail}`)
  assert.deepEqual(extra, [], `镜像多出契约 ErrorCode 里没有的码：${detail}`)
}

test('admin-contract: ERROR_CODES 与 components.schemas.ErrorCode 逐项相等（顺序不敏感）', () => {
  assert.ok(
    Array.isArray(CONTRACT_ERROR_CODES) && CONTRACT_ERROR_CODES.length > 0,
    'packages/contracts/openapi.json 里必须能读到 components.schemas.ErrorCode.enum',
  )
  // 先跑差异对拍（红时消息里点名缺项/多项），再做整体排序 deepEqual 兜底。
  assertErrorCodesMirror(ERROR_CODES, CONTRACT_ERROR_CODES)
  // 契约 enum 的书写顺序不是本模块的约束：两边都排序后比，集合相等即可。
  assert.deepEqual([...ERROR_CODES].sort(), [...CONTRACT_ERROR_CODES].sort())
})

test('判别力自证①：镜像少一项（契约新增码而镜像没跟）⇒ 真断言会红并点名缺哪个码', () => {
  const mirror = CONTRACT_ERROR_CODES.filter((code) => code !== 'RATE_LIMITED')
  const diff = diffErrorCodes(mirror, CONTRACT_ERROR_CODES)
  assert.deepEqual(diff.missing, ['RATE_LIMITED'])
  assert.deepEqual(diff.extra, [])
  assert.throws(() => assertErrorCodesMirror(mirror, CONTRACT_ERROR_CODES), /RATE_LIMITED/)
})

test('判别力自证②：镜像多一项（镜像手抄进契约外码）⇒ 真断言会红并点名多哪个码', () => {
  const mirror = [...CONTRACT_ERROR_CODES, 'CONTRACT_DRIFT_PROBE']
  const diff = diffErrorCodes(mirror, CONTRACT_ERROR_CODES)
  assert.deepEqual(diff.extra, ['CONTRACT_DRIFT_PROBE'])
  assert.deepEqual(diff.missing, [])
  assert.throws(() => assertErrorCodesMirror(mirror, CONTRACT_ERROR_CODES), /CONTRACT_DRIFT_PROBE/)
})

test('判别力自证③：一缺一多、条数不变（正是改动前那类漂移）⇒ 真断言仍会红', () => {
  // 镜像把最后一个码换成契约外码：`length` 与改动前一致，旧用例的条数断言对此无感。
  const swapped = [...CONTRACT_ERROR_CODES.slice(0, -1), 'INPUT_UNCERTAINTY']
  assert.equal(swapped.length, CONTRACT_ERROR_CODES.length)
  assert.throws(() => assertErrorCodesMirror(swapped, CONTRACT_ERROR_CODES), /INPUT_UNCERTAIN/)
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

test('readErrorEnvelope: 契约内 code 标 inContract，未知 code 如实保留，retryable 只认服务端声明', () => {
  const known = readErrorEnvelope({ error: { code: 'SCOPE_DENIED', message: 'no scope', retryable: false }, meta: {} })
  assert.deepEqual(known, { code: 'SCOPE_DENIED', inContract: true, message: 'no scope', retryable: false })

  // retryable 是契约 ErrorBody 的必填 boolean；缺失 ⇒ false（不替服务端许诺可重试）
  assert.equal(readErrorEnvelope({ error: { code: 'PROVIDER_UNAVAILABLE', message: '尚未接线' } }).retryable, false)
  assert.equal(readErrorEnvelope({ error: { code: 'PROVIDER_UNAVAILABLE', message: '尚未接线', retryable: true } }).retryable, true)
  assert.equal(readErrorEnvelope({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'x', retryable: 'yes' } }).retryable, false)

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
