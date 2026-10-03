// Server-only minimal verification. Never log tokens, codes, OpenID or session keys.
const fs = require('node:fs')
const path = require('node:path')
const EXPECTED_APPID = 'wx4407a4b908a69a54'

async function requestJSON(url, options, fetchImpl) {
  try {
    const res = await fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(10000) })
    if (!res.ok) return { report: { state: 'HTTP_ERROR', httpStatus: res.status } }
    const body = await res.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) return { body, report: { httpStatus: res.status } }
    return { report: { state: 'INVALID_RESPONSE' } }
  } catch (_) { return { report: { state: 'NETWORK_OR_RESPONSE_ERROR' } } }
}

async function verifyAccount({ credentials, fetchImpl = globalThis.fetch, getLoginCode } = {}) {
  const report = { appidMatched: false, tokenAuthentication: { state: 'NOT_ATTEMPTED' }, controlledBadSecret: { state: 'NOT_ATTEMPTED' }, codeExchange: { state: 'NOT_ATTEMPTED' }, taskVerified: false }
  if (!credentials || credentials.appid !== EXPECTED_APPID || typeof credentials.appsecret !== 'string' || !credentials.appsecret.trim()) {
    report.input = 'MISSING_OR_MISMATCHED_CREDENTIALS'; return report
  }
  report.appidMatched = true
  const endpoint = 'https://api.weixin.qq.com/cgi-bin/stable_token'
  const options = secret => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credential', appid: EXPECTED_APPID, secret, force_refresh: false }) })
  const valid = await requestJSON(endpoint, options(credentials.appsecret), fetchImpl)
  const token = valid.body
  report.tokenAuthentication = typeof token?.access_token === 'string' && token.access_token && Number.isFinite(token.expires_in) && token.expires_in > 0
    ? { state: 'AUTHENTICATED', httpStatus: valid.report.httpStatus, responseFields: ['access_token', 'expires_in'], expiresInSeconds: token.expires_in }
    : { ...valid.report, state: valid.report.state || 'WECHAT_REJECTED', ...(Number.isInteger(token?.errcode) ? { errcode: token.errcode } : {}) }
  // One synthetic bad-secret request; not a real user's invalid login or media sample.
  const invalid = await requestJSON(endpoint, options('synthetic-invalid-secret-for-controlled-test'), fetchImpl)
  report.controlledBadSecret = Number.isInteger(invalid.body?.errcode) && invalid.body.errcode !== 0
    ? { state: 'REJECTED', httpStatus: invalid.report.httpStatus, errcode: invalid.body.errcode }
    : { ...invalid.report, state: invalid.report.state || 'UNEXPECTED_RESPONSE' }
  if (getLoginCode) {
    let code
    try { code = await getLoginCode() } catch (_) {}
    if (typeof code !== 'string' || !code) report.codeExchange = { state: 'LOGIN_CODE_UNAVAILABLE' }
    else {
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
      url.search = new URLSearchParams({ appid: EXPECTED_APPID, secret: credentials.appsecret, js_code: code, grant_type: 'authorization_code' }).toString()
      const exchange = await requestJSON(url, { method: 'GET' }, fetchImpl)
      const body = exchange.body
      report.codeExchange = typeof body?.openid === 'string' && body.openid && typeof body.session_key === 'string' && body.session_key
        ? { state: 'EXCHANGED', httpStatus: exchange.report.httpStatus, responseFields: ['openid', 'session_key'], unionidPresent: typeof body.unionid === 'string' }
        : { ...exchange.report, state: exchange.report.state || 'WECHAT_REJECTED', ...(Number.isInteger(body?.errcode) ? { errcode: body.errcode } : {}) }
    }
  }
  return report
}

async function main() {
  const args = process.argv.slice(2)
  if (![2, 4].includes(args.length) || args[0] !== '--credentials' || (args.length === 4 && args[2] !== '--sdk')) throw new Error('usage')
  let credentials
  try { credentials = JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8')) } catch (_) {}
  let mini
  try {
    let getLoginCode
    if (args.length === 4) {
      const automator = require(path.resolve(args[3]))
      mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' })
      const info = await mini.callWxMethod('getAccountInfoSync')
      if (info?.miniProgram?.appId !== EXPECTED_APPID) throw new Error('appid mismatch')
      getLoginCode = async () => {
        const result = await mini.callWxMethod('login', { timeout: 10000 })
        return result?.code
      }
    }
    const report = await verifyAccount({ credentials, getLoginCode })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.tokenAuthentication.state === 'AUTHENTICATED' && report.controlledBadSecret.state === 'REJECTED' && (!getLoginCode || report.codeExchange.state === 'EXCHANGED') ? 0 : 1
  } finally { if (mini) mini.disconnect() }
}
module.exports = { verifyAccount }
if (require.main === module) main().catch(() => { console.error('WeChat verification failed. No credentials or sensitive response was logged.'); process.exitCode = 1 })
