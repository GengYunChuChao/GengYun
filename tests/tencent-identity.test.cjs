const { test } = require('node:test')
const assert = require('node:assert/strict')
const { verifyTencentIdentity, identityHeaders } = require('../tools/verify-tencent-identity.cjs')
const credentials = { tencentSecretId: 'synthetic-id', tencentSecretKey: 'synthetic-secret', tencentSessionToken: 'synthetic-session' }
test('identity query is fixed to STS, carries signed headers only in request, and redacts identity', async () => {
  let calls = 0
  assert.equal((await verifyTencentIdentity({ fetchImpl: async () => { calls++ } })).state, 'MISSING_CREDENTIALS')
  assert.equal(calls, 0)
  const report = await verifyTencentIdentity({ credentials, timestamp: 1551113065, fetchImpl: async (url, opts) => {
    calls++; assert.equal(url, 'https://sts.tencentcloudapi.com/'); assert.equal(opts.body, '{}'); assert.equal(opts.method, 'POST'); assert.equal(opts.redirect, 'manual')
    assert.equal(opts.headers['X-TC-Action'], 'GetCallerIdentity'); assert.equal(opts.headers['X-TC-Version'], '2018-08-13')
    assert.ok(opts.headers.Authorization.startsWith('TC3-HMAC-SHA256 Credential=')); assert.equal(opts.headers['X-TC-Token'], 'synthetic-session')
    return { ok: true, status: 200, json: async () => ({ Response: { Type: 'CAMUser', AccountId: 'sensitive-account', UserId: 'sensitive-user', PrincipalId: 'sensitive-principal', Arn: 'sensitive-arn', RequestId: 'synthetic-request' } }) }
  } })
  assert.equal(calls, 1); assert.equal(report.state, 'AUTHENTICATED'); assert.equal(report.quotaVerified, false); assert.equal(report.inferenceRequests, 0)
  for (const value of [...Object.values(credentials), 'sensitive-', 'synthetic-request']) assert.equal(JSON.stringify(report).includes(value), false)
})
test('restricted action does not claim invalid keys; raw errors and network messages stay hidden', async () => {
  const forbidden = await verifyTencentIdentity({ credentials, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ Response: { Error: { Code: 'UnauthorizedOperation', Message: 'sensitive-identity' } } }) }) })
  assert.equal(forbidden.state, 'IDENTITY_QUERY_FORBIDDEN'); assert.equal(JSON.stringify(forbidden).includes('sensitive'), false)
  const network = await verifyTencentIdentity({ credentials, fetchImpl: async () => { throw new Error('synthetic-secret') } })
  assert.equal(network.state, 'NETWORK_OR_RESPONSE_ERROR'); assert.equal(JSON.stringify(network).includes('synthetic-secret'), false)
  assert.equal(identityHeaders(credentials, 1551113065).Authorization.includes('/2019-02-25/sts/tc3_request'), true)
})

const { verifyTtsQuota } = require('../tools/verify-tencent-identity.cjs')
test('quota queries stay read-only and distinguish permission denial from invalid credentials', async () => {
  const calls = []
  const results = await verifyTtsQuota({ credentials, fetchImpl: async (url, opts) => {
    calls.push(opts.headers['X-TC-Action']); assert.equal(url, 'https://tts.tencentcloudapi.com/'); assert.equal(opts.body, '{}'); assert.equal(opts.redirect, 'manual')
    return { ok: true, status: 200, json: async () => ({ Response: { Error: { Code: 'AuthFailure.UnauthorizedOperation', Message: 'private-account' } } }) }
  } })
  assert.deepEqual(calls, ['DescribeOpenStatus', 'DescribePidOrders'])
  for (const result of results) { assert.equal(result.state, 'QUERY_FORBIDDEN'); assert.equal(result.quotaVerified, false); assert.equal(JSON.stringify(result).includes('private-account'), false) }
})
