const { test } = require('node:test')
const assert = require('node:assert/strict')
const { verifyAccount } = require('../tools/verify-wechat-account.cjs')
const credentials = { appid: 'wx4407a4b908a69a54', appsecret: 'synthetic-secret' }
test('absent or mismatched credentials make zero requests', async () => {
  let calls = 0
  for (const input of [undefined, {}, { ...credentials, appid: 'wx0000000000000000' }]) {
    const report = await verifyAccount({ credentials: input, fetchImpl: async () => { calls++ } })
    assert.equal(report.input, 'MISSING_OR_MISMATCHED_CREDENTIALS')
  }
  assert.equal(calls, 0)
})
test('reports only authentication outcomes and schema; never echoes secret identity/code/token', async () => {
  let calls = 0
  const bodies = [ { access_token: 'synthetic-token', expires_in: 7200 }, { errcode: 40125, errmsg: 'synthetic-private-error' }, { openid: 'synthetic-openid', session_key: 'synthetic-session-key' } ]
  const report = await verifyAccount({ credentials, getLoginCode: async () => 'synthetic-login-code', fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'manual')
    if (calls < 2) assert.equal(JSON.parse(options.body).force_refresh, false)
    const body = bodies[calls++]; return { ok: true, status: 200, json: async () => body }
  } })
  assert.equal(calls, 3)
  assert.equal(report.tokenAuthentication.state, 'AUTHENTICATED')
  assert.equal(report.controlledBadSecret.state, 'REJECTED')
  assert.equal(report.codeExchange.state, 'EXCHANGED')
  assert.equal(report.taskVerified, false)
  for (const sensitive of ['synthetic-secret', 'synthetic-token', 'synthetic-openid', 'synthetic-session-key', 'synthetic-login-code', 'synthetic-private-error']) assert.equal(JSON.stringify(report).includes(sensitive), false)
})
test('network failures do not leak exception URLs or imply successful authentication', async () => {
  const report = await verifyAccount({ credentials, fetchImpl: async () => { throw new Error('synthetic-secret-in-url') } })
  assert.equal(report.tokenAuthentication.state, 'NETWORK_OR_RESPONSE_ERROR')
  assert.equal(JSON.stringify(report).includes('synthetic-secret'), false)
})
