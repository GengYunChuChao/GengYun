// Read-only account/model checks, never performs a chat completion or prints balances/secrets.
const fs = require('node:fs')
const path = require('node:path')
async function readEndpoint(endpoint, key, fetchImpl) {
  try {
    const response = await fetchImpl('https://api.deepseek.com' + endpoint, { method: 'GET', headers: { Authorization: 'Bearer ' + key }, redirect: 'manual', signal: AbortSignal.timeout(10000) })
    if (!response.ok) return { status: response.status }
    return { status: response.status, body: await response.json() }
  } catch (_) { return { state: 'NETWORK_OR_RESPONSE_ERROR' } }
}
async function verifyDeepSeek({ key, fetchImpl = globalThis.fetch } = {}) {
  const report = { authentication: { state: 'NOT_ATTEMPTED' }, models: { state: 'NOT_ATTEMPTED' }, controlledBadKey: { state: 'NOT_ATTEMPTED' }, inferenceRequests: 0, capabilityVerified: false }
  if (typeof key !== 'string' || !/^sk-[A-Za-z0-9_-]{20,200}$/.test(key)) { report.input = 'MISSING_OR_INVALID_KEY'; return report }
  const balance = await readEndpoint('/user/balance', key, fetchImpl)
  report.authentication = typeof balance.body?.is_available === 'boolean' && Array.isArray(balance.body?.balance_infos)
    ? { state: 'AUTHENTICATED', httpStatus: balance.status, apiBalanceAvailable: balance.body.is_available, responseFields: ['is_available', 'balance_infos'], amountsRecorded: false }
    : { state: balance.state || 'HTTP_OR_SCHEMA_ERROR', ...(balance.status ? { httpStatus: balance.status } : {}) }
  const models = await readEndpoint('/models', key, fetchImpl)
  report.models = Array.isArray(models.body?.data) && models.body.data.every(x => typeof x.id === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(x.id))
    ? { state: 'LISTED', httpStatus: models.status, modelIds: models.body.data.map(x => x.id) }
    : { state: models.state || 'HTTP_OR_SCHEMA_ERROR', ...(models.status ? { httpStatus: models.status } : {}) }
  const bad = await readEndpoint('/models', 'synthetic-invalid-api-key', fetchImpl)
  report.controlledBadKey = { state: [401, 403].includes(bad.status) ? 'REJECTED' : bad.state || 'UNEXPECTED_RESPONSE', ...(bad.status ? { httpStatus: bad.status } : {}) }
  return report
}
async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--credentials') throw new Error('usage')
  let credentials
  try { credentials = JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8')) } catch (_) {}
  const report = await verifyDeepSeek({ key: credentials?.deepseekApiKey })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.authentication.state === 'AUTHENTICATED' && report.models.state === 'LISTED' && report.controlledBadKey.state === 'REJECTED' ? 0 : 1
}
module.exports = { verifyDeepSeek }
if (require.main === module) main().catch(() => { console.error('DeepSeek verification failed without logging credentials or account details.'); process.exitCode = 1 })
