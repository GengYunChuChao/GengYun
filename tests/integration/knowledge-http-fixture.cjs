// SYNTHETIC ONLY: loopback fixture, no production API/store/provider credentials.
const http = require('node:http')
const ID = '11111111-1111-4111-8111-111111111111'
function item(version = 'synthetic-v1') { return { id: ID, revision: version === 'synthetic-v1' ? 1 : 2, type: 'herbicide', title: '合成科普资料（联调）', body: '这是明确标记的合成科普正文。没有登记用量或完整条件，不作为实际用药依据。',
 source: { id: '22222222-2222-4222-8222-222222222222', version, title: '合成测试来源', url: 'https://example.test/synthetic-source', publisher: '合成发布方', source_kind: 'simulation', evidence_kind: 'research', validity: 'valid', review_status: 'unverified', updated_at: '2026-10-11T01:00:00Z' }, conditions: null, reference_state: 'available', dose_cards: [] } }
function envelope(data) { return { data, meta: { request_id: '33333333-3333-4333-8333-333333333333', contract_version: '1.0.0', execution_mode: 'stub' } } }
function createFixture() {
 const state = { version: 'synthetic-v1', withdrawn: false }, requests = [], token = 'gy-knowledge-synthetic-session'
 const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1'); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store')
  const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)) }
  const error = (status, code) => send(status, { error: { code, message: 'Synthetic fixture response', retryable: status >= 500, details: [] }, meta: envelope(null).meta })
  // Diagnostics retain paths/filters only, never code, token or identity payloads.
  requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) })
  if (req.method === 'POST' && url.pathname === '/__fixture__/state') {
   let raw = ''; for await (const b of req) { raw += b; if (raw.length > 1024) { error(400, 'VALIDATION_FAILED'); return } }
   try { const next = JSON.parse(raw); if (!['synthetic-v1','synthetic-v2'].includes(next.version) || typeof next.withdrawn !== 'boolean') throw Error(); Object.assign(state, next); send(200, { synthetic: true }) } catch (_) { error(400, 'VALIDATION_FAILED') }; return
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/wechat') { send(200, envelope({ access_token: token, audience: 'user', expires_at: new Date(Date.now()+3600000).toISOString() })); return }
  if (req.headers.authorization !== 'Bearer ' + token) { error(401, 'SESSION_REQUIRED'); return }
  if (req.method === 'GET' && url.pathname === '/api/v1/auth/session') { send(200, envelope({ audience: 'user', expires_at: new Date(Date.now()+3600000).toISOString() })); return }
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/logout') { send(200, envelope({ accepted: true })); return }
  if (req.method !== 'GET') { error(404, 'NOT_FOUND'); return }
  if (url.pathname === '/api/v1/knowledge') {
   if (url.searchParams.get('q') === '服务失败') { error(503, 'PROVIDER_UNAVAILABLE'); return }
   const noResults = state.withdrawn || url.searchParams.get('q') === '无结果' || url.searchParams.has('growth_stage') || url.searchParams.has('planting_method') || url.searchParams.has('use_scene')
   let r = item(state.version); if (url.searchParams.has('cursor')) r = { ...r, id: '44444444-4444-4444-8444-444444444444' }
   send(200, envelope({ items: noResults ? [] : [r], next_cursor: !noResults && url.searchParams.get('q') === '分页' && !url.searchParams.has('cursor') ? 'synthetic-next' : null })); return
  }
  if (url.pathname === '/api/v1/knowledge/' + ID) {
   if (state.withdrawn || url.searchParams.has('growth_stage') || url.searchParams.has('planting_method') || url.searchParams.has('use_scene')) { error(404, 'NOT_FOUND'); return }
   send(200, envelope(item(state.version))); return
  }
  error(404, 'NOT_FOUND')
 })
 return { server, state, requests, token }
}
module.exports = { createFixture, item, ID, envelope }
if (require.main === module) {
 const port = Number(process.argv[2] || 3120); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid port')
 const f = createFixture(); f.server.listen(port, '127.0.0.1', () => console.log('SYNTHETIC Knowledge HTTP fixture on loopback port ' + port))
}
