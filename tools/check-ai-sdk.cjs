// Offline official SDK import/client construction; synthetic credentials, no API calls.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http'), https = require('node:https')
const specs = [
  ['ocr', '4.1.322', 'v20181119', 'GeneralAccurateOCR'],
  ['asr', '4.1.315', 'v20190614', 'SentenceRecognition'],
  ['tts', '4.1.237', 'v20190823', 'TextToVoice'],
  ['tms', '4.1.311', 'v20201229', 'TextModeration'],
  ['ims', '4.1.321', 'v20201229', 'ImageModeration']
]
function checkSdk(moduleDirectory) {
  const rows = []
  let networkAttempts = 0
  const originals = { httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get, fetch: globalThis.fetch }
  const blocked = () => { networkAttempts++; throw new Error('OFFLINE_NETWORK_FORBIDDEN') }
  http.request = http.get = https.request = https.get = globalThis.fetch = blocked
  try {
  for (const [service, version, api, action] of specs) {
    const item = { service, expectedVersion: version, action, mode: 'OFFLINE_SDK_ONLY', capabilityVerified: false }
    try {
      const root = path.resolve(moduleDirectory, 'tencentcloud-sdk-nodejs-' + service)
      const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
      if (metadata.version !== version) { rows.push({ ...item, state: 'VERSION_MISMATCH' }); continue }
      const Client = require(root)?.[service]?.[api]?.Client
      if (typeof Client !== 'function') { rows.push({ ...item, state: 'EXPORT_MISSING' }); continue }
      const client = new Client({ credential: { secretId: 'synthetic-id', secretKey: 'synthetic-key' }, region: 'ap-shanghai', profile: { httpProfile: { endpoint: service + '.tencentcloudapi.com', reqTimeout: 8 }, signMethod: 'TC3-HMAC-SHA256' } })
      rows.push({ ...item, state: typeof client[action] === 'function' ? 'IMPORT_AND_CONSTRUCTION_PASS' : 'ACTION_MISSING' })
    } catch (_) { rows.push({ ...item, state: 'IMPORT_OR_CONSTRUCTION_FAILED' }) }
  }
  return { nodeVersion: process.versions.node, networkAttempts, taskVerified: false, rows }
  } finally {
    http.request = originals.httpRequest; http.get = originals.httpGet; https.request = originals.httpsRequest; https.get = originals.httpsGet; globalThis.fetch = originals.fetch
  }
}
module.exports = { checkSdk }
if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--modules') { console.error('Usage: node tools/check-ai-sdk.cjs --modules <explicit ignored node_modules directory>'); process.exitCode = 1 }
  else { const report = checkSdk(args[1]); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.networkAttempts === 0 && report.rows.every(x => x.state === 'IMPORT_AND_CONSTRUCTION_PASS') ? 0 : 1 }
}
