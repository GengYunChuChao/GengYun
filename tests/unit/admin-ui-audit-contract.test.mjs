import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { AUDIT_EVENTS_PATH, AUDIT_EVENT_FIELDS, AUDIT_RESULTS, AUDIT_SCOPE, AUDIT_LIMIT_OPTIONS } from '../../apps/admin/src/lib/audit-events.mjs'

// B5：审计事件页的契约守卫。前端一旦"顺手"加上后端没有的过滤参数、
// 或按不存在的字段（如主体 actor）渲染，这些断言会先红。

const spec = JSON.parse(readFileSync(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'))

const operation = spec.paths[AUDIT_EVENTS_PATH]?.get
const auditEvent = spec.components.schemas.AuditEvent
const auditEventPage = spec.components.schemas.AuditEventPage

test('audit contract: 路径与 operationId 与前端常量一致', () => {
  assert.ok(operation, `契约里没有又 GET ${AUDIT_EVENTS_PATH}`)
  assert.equal(operation.operationId, 'listAuditEvents')
  assert.equal(operation['x-scope'], AUDIT_SCOPE)
  assert.deepEqual(operation.security, [{ adminSession: [] }])
})

test('audit contract: 查询参数只有 cursor 与 limit（没有 event_type／主体／时间过滤）', () => {
  const names = operation.parameters.map((parameter) => spec.components.parameters[parameter.$ref.split('/').pop()].name)
  assert.deepEqual(names, ['cursor', 'limit'])
  const limit = spec.components.parameters.Limit.schema
  assert.equal(limit.minimum, 1)
  assert.equal(limit.maximum, 50)
  assert.equal(limit.default, 20)
  assert.deepEqual([...AUDIT_LIMIT_OPTIONS], [limit.default, limit.maximum])
  assert.equal(spec.components.parameters.Cursor.schema.maxLength, 2048)
})

test('audit contract: AuditEvent 恰好 8 个字段，且没有主体／actor', () => {
  assert.deepEqual([...AUDIT_EVENT_FIELDS], auditEvent.required)
  assert.deepEqual(Object.keys(auditEvent.properties), [...AUDIT_EVENT_FIELDS])
  assert.equal(auditEvent.additionalProperties, false)
  assert.equal(
    AUDIT_EVENT_FIELDS.some((field) => /actor|user|operator|reviewer/i.test(field)),
    false,
    '契约若新增主体字段，页面必须同步展示而不是继续声称"读面未提供主体"',
  )
})

test('audit contract: 信封是 data + meta，页面是 items + next_cursor', () => {
  assert.deepEqual(spec.components.schemas.AuditEventPageEnvelope.required, ['data', 'meta'])
  assert.deepEqual([...auditEventPage.required], ['items', 'next_cursor'])
  assert.equal(auditEventPage.properties.items.maxItems, 50)
  assert.equal(operation.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/AuditEventPageEnvelope')
})

test('audit contract: result 闭集与前端一致', () => {
  assert.deepEqual(auditEvent.properties.result.enum, [...AUDIT_RESULTS])
})

test('audit contract: 403 与 400 的错误码覆盖了页面的失败分支', () => {
  const forbidden = operation.responses['403']
  const resolved = forbidden.$ref === undefined ? forbidden : spec.components.responses[forbidden.$ref.split('/').pop()]
  assert.equal(resolved.content['application/json'].schema.$ref, '#/components/schemas/ErrorEnvelope')
  assert.ok(spec['x-error-status-map']['403'].includes('SCOPE_DENIED'))
  assert.ok(spec['x-error-status-map']['400'].includes('INVALID_CURSOR'))
  assert.ok(spec['x-error-status-map']['401'].includes('SESSION_EXPIRED'))
})
