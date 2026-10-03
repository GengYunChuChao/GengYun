// Identity only: no inference, billing, activation, policy changes or deployment.
// TC3 signing follows Tencent Cloud API v3; signatures and identity values never logged.
const crypto = require('node:crypto')
const fs = require('node:fs')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const hmac = (key, value, encoding) => crypto.createHmac('sha256', key).update(value).digest(encoding)
function identityHeaders(credentials, timestamp, query = { service: 'sts', action: 'GetCallerIdentity', version: '2018-08-13' }) {
  const service = query.service, host = service + '.tencentcloudapi.com', body = '{}'
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const signed = 'content-type;host'
  const canonical = 'POST\n/\n\ncontent-type:application/json\nhost:' + host + '\n\n' + signed + '\n' + hash(body)
  const scope = date + '/' + service + '/tc3_request'
  const stringToSign = 'TC3-HMAC-SHA256\n' + timestamp + '\n' + scope + '\n' + hash(canonical)
  const dateKey = hmac('TC3' + credentials.tencentSecretKey, date)
  const serviceKey = hmac(dateKey, service)
  const signature = hmac(hmac(serviceKey, 'tc3_request'), stringToSign, 'hex')
  return { 'Content-Type': 'application/json', Host: host,
    Authorization: 'TC3-HMAC-SHA256 Credential=' + credentials.tencentSecretId + '/' + scope + ', SignedHeaders=' + signed + ', Signature=' + signature,
    'X-TC-Action': query.action, 'X-TC-Version': query.version, 'X-TC-Region': 'ap-shanghai', 'X-TC-Timestamp': String(timestamp),
    ...(credentials.tencentSessionToken ? { 'X-TC-Token': credentials.tencentSessionToken } : {}) }
}
async function verifyTencentIdentity({ credentials, fetchImpl = globalThis.fetch, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const report = { state: 'NOT_ATTEMPTED', action: 'sts:GetCallerIdentity', inferenceRequests: 0, capabilityVerified: false, quotaVerified: false }
  if (!credentials || !['tencentSecretId', 'tencentSecretKey'].every(k => typeof credentials[k] === 'string' && credentials[k].trim())) return { ...report, state: 'MISSING_CREDENTIALS' }
  try {
    const res = await fetchImpl('https://sts.tencentcloudapi.com/', { method: 'POST', headers: identityHeaders(credentials, timestamp), body: '{}', redirect: 'manual', signal: AbortSignal.timeout(10000) })
    report.httpStatus = res.status
    if (!res.ok) return { ...report, state: 'HTTP_ERROR' }
    const body = (await res.json())?.Response
    const code = body?.Error?.Code
    if (typeof code === 'string' && /^[A-Za-z0-9.]{1,100}$/.test(code)) {
      const state = code.includes('UnauthorizedOperation') ? 'IDENTITY_QUERY_FORBIDDEN' : code.startsWith('AuthFailure') ? 'AUTHENTICATION_ERROR' : 'API_ERROR'
      return { ...report, state, errorCode: code }
    }
    if (typeof body?.Type !== 'string' || !['AccountId', 'UserId', 'PrincipalId', 'Arn'].every(k => typeof body[k] === 'string' && body[k])) return { ...report, state: 'SCHEMA_ERROR' }
    return { ...report, state: 'AUTHENTICATED', responseFields: ['Type', 'AccountId', 'UserId', 'PrincipalId', 'Arn', 'RequestId'], identityValuesRecorded: false }
  } catch (_) { return { ...report, state: 'NETWORK_OR_RESPONSE_ERROR' } }
}
async function verifyTtsQuota({ credentials, fetchImpl = globalThis.fetch } = {}) {
  if (!credentials || !['tencentSecretId', 'tencentSecretKey'].every(k => typeof credentials[k] === 'string' && credentials[k].trim())) return []
  const reports = []
  // Fixed read-only console queries from official TTS action/permission documentation.
  for (const action of ['DescribeOpenStatus', 'DescribePidOrders']) {
    const report = { action: 'tts:' + action, quotaVerified: false, capabilityVerified: false }
    try {
      const res = await fetchImpl('https://tts.tencentcloudapi.com/', { method: 'POST', body: '{}', headers: identityHeaders(credentials, Math.floor(Date.now() / 1000), { service: 'tts', action, version: '2019-08-23' }), redirect: 'manual', signal: AbortSignal.timeout(10000) })
      report.httpStatus = res.status
      if (!res.ok) { reports.push({ ...report, state: 'HTTP_ERROR' }); continue }
      const body = (await res.json())?.Response
      const code = body?.Error?.Code
      if (typeof code === 'string' && /^[A-Za-z0-9.]{1,100}$/.test(code)) reports.push({ ...report, state: code.includes('UnauthorizedOperation') ? 'QUERY_FORBIDDEN' : 'API_ERROR', errorCode: code })
      else reports.push({ ...report, state: body && typeof body === 'object' ? 'RESPONSE_REQUIRES_QUOTA_REVIEW' : 'SCHEMA_ERROR' })
    } catch (_) { reports.push({ ...report, state: 'NETWORK_OR_RESPONSE_ERROR' }) }
  }
  return reports
}
module.exports = { verifyTencentIdentity, identityHeaders, verifyTtsQuota }
async function main() {
  const args = process.argv.slice(2)
  if (![2, 3].includes(args.length) || args[0] !== '--credentials' || (args.length === 3 && args[2] !== '--tts-quota')) throw new Error('usage')
  let credentials
  try { credentials = JSON.parse(fs.readFileSync(args[1], 'utf8')) } catch (_) {}
  const report = await verifyTencentIdentity({ credentials })
  if (args[2] === '--tts-quota' && report.state === 'AUTHENTICATED') report.ttsQueries = await verifyTtsQuota({ credentials })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.state === 'AUTHENTICATED' ? 0 : 1
}
if (require.main === module) main().catch(() => { console.error('Identity verification failed; credentials and responses suppressed.'); process.exitCode = 1 })
