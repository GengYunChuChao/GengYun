const { test } = require('node:test')
const assert = require('node:assert/strict')
const { verifyDeepSeek } = require('../tools/verify-deepseek.cjs')
test('missing key does not request; valid check remains read-only and redacted', async () => {
  let calls = 0
  const missing = await verifyDeepSeek({ fetchImpl: async () => { calls++ } })
  assert.equal(calls, 0); assert.equal(missing.input, 'MISSING_OR_INVALID_KEY')
  const key = 'sk-' + 'a'.repeat(32)
  const report = await verifyDeepSeek({ key, fetchImpl: async (url, options) => {
    calls++
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual')
    assert.doesNotMatch(url, /completions/)
    if (calls === 1) return { ok: true, status: 200, json: async () => ({ is_available: true, balance_infos: [{ total_balance: 'synthetic-private-amount' }] }) }
    if (calls === 2) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'synthetic-model' }] }) }
    return { ok: false, status: 401 }
  } })
  assert.equal(calls, 3); assert.equal(report.authentication.state, 'AUTHENTICATED')
  assert.equal(report.controlledBadKey.state, 'REJECTED')
  assert.equal(report.inferenceRequests, 0); assert.equal(report.capabilityVerified, false)
  assert.equal(JSON.stringify(report).includes(key), false)
  assert.equal(JSON.stringify(report).includes('synthetic-private-amount'), false)
})
test('network/error bodies never leak exceptions or credentials', async () => {
  const report = await verifyDeepSeek({ key: 'sk-' + 'b'.repeat(32), fetchImpl: async () => { throw new Error('synthetic-secret') } })
  assert.equal(report.authentication.state, 'NETWORK_OR_RESPONSE_ERROR')
  assert.equal(JSON.stringify(report).includes('synthetic-secret'), false)
})
