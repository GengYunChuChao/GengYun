// Server-owned profile/catalog; no identity fields, coordinates or persisted drafts.
const auth = require('./auth')
const runtime = require('../config/runtime')
function failure(code) { const e = new Error(code); e.code = code; return e }
function binding() {
  const s = auth.getSession()
  return s && auth.isLoggedIn() ? { token: s.accessToken, epoch: auth.sessionEpoch() } : null
}
function current(b) {
  const now = binding()
  return !!b && !!now && b.token === now.token && b.epoch === now.epoch
}
function request(path, method, data, headers) {
  const b = binding()
  if (!b || !auth.networkEnabled()) return Promise.reject(failure('SESSION_REQUIRED'))
  return new Promise(function (resolve, reject) {
    wx.request({ url: runtime.apiBaseUrl + path, method: method || 'GET', timeout: 15000,
      header: Object.assign({ 'content-type': 'application/json', authorization: 'Bearer ' + b.token }, headers || {}),
      ...(data === undefined ? {} : { data: data }),
      success: function (response) {
        if (!current(b)) { reject(failure('SESSION_CHANGED')); return }
        if (response.statusCode === 401 || response.statusCode === 403) {
          auth.clearSession(); reject(failure('SESSION_REQUIRED')); return
        }
        if (response.statusCode !== 200 || !response.data || !response.data.data) {
          reject(failure(response.data && response.data.error && response.data.error.code || 'UNAVAILABLE')); return
        }
        resolve(response.data.data)
      },
      fail: function () { reject(failure(current(b) ? 'NETWORK_UNCERTAIN' : 'SESSION_CHANGED')) }
    })
  })
}
function validProfile(p) {
  const empty = p && p.crop_id === null && p.region_code === null && p.region_catalog_version === null
  const full = p && typeof p.crop_id === 'string' && p.crop_id.length > 0 && /^33[0-9]{4}$/.test(p.region_code) && typeof p.region_catalog_version === 'string' && p.region_catalog_version.length > 0
  if (!p || !Number.isSafeInteger(p.revision) || p.revision < 1 || (!empty && !full)) throw failure('INVALID_RESPONSE')
  return { crop_id: p.crop_id, region_code: p.region_code, region_catalog_version: p.region_catalog_version, revision: p.revision }
}
async function list(kind) {
  let cursor = null, items = [], seen = [], keys = []
  do {
    const page = await request('/catalog/' + kind + '?limit=20' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))
    if (!Array.isArray(page.items) || !(page.next_cursor === null || typeof page.next_cursor === 'string' && page.next_cursor.length > 0)) throw failure('INVALID_RESPONSE')
    page.items.forEach(function (item) {
      const key = kind === 'crops' ? item.id : item.code
      if (typeof key !== 'string' || !key || typeof item.name !== 'string' || !item.name || keys.indexOf(key) !== -1) throw failure('INVALID_RESPONSE')
      if (kind === 'regions' && (!/^33[0-9]{4}$/.test(key) || !(item.parent_code === null || /^33[0-9]{4}$/.test(item.parent_code)) || typeof item.catalog_version !== 'string' || !item.catalog_version)) throw failure('INVALID_RESPONSE')
      keys.push(key); items.push(item)
    })
    cursor = page.next_cursor
    if (cursor && (seen.indexOf(cursor) !== -1 || seen.length >= 100)) throw failure('INVALID_RESPONSE')
    if (cursor) seen.push(cursor)
  } while (cursor)
  return items
}
module.exports = { binding, current,
  read: function () { return request('/me/profile').then(validProfile) },
  crops: function () { return list('crops') }, regions: function () { return list('regions') },
  save: function (frozen) { return request('/me/profile', 'PUT', frozen.body,
    { 'Idempotency-Key': frozen.key, 'If-Match': '"' + frozen.revision + '"' }).then(validProfile) }
}
