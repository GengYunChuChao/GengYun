// GY-I07 D1 钉证据：小程序除草剂查询从「仅随包离线副本」切到服务端 `/herbicides`、`/herbicides/{id}`。
//
// 夹具在 vm 里装载**真实**页面（pages/reference、pages/referencedetail）与**真实**
// `miniprogram/utils/knowledge-api.js`；`wx.request` 只入队，由测试逐条显式回放（零真实网络、
// 零数据库）。全部身份、记录、来源均为合成数据，不代表真实资料或真实用药依据。
//
// 四组判据：
//   A 同源 source_version 一致性（列表行 / 详情 / 页面展示同一个 version）
//   B 非空 `dose_cards` ⇒ `UNSUPPORTED_DOSE_RESPONSE` 不可绕过（且不被闭集降级成 INVALID_RESPONSE）
//   C 404 ⇒ `NOT_FOUND`，文案取冻结闭集（含未知错误码与 5xx 的兜底）
//   D 离线回退可区分（`data_source: 'bundled-offline'` + `source_marker: '随包离线副本'`，绝不冒充服务端）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import vm from 'node:vm'

const root = resolve(import.meta.dirname, '../../miniprogram')
const BASE = 'http://127.0.0.1:9999/api/v1'
const RECORD_ID = '11111111-1111-4111-8111-111111111111'
const FORMULATION_ID = '22222222-2222-4222-8222-222222222222'
const SOURCE_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_ID = '44444444-4444-4444-8444-444444444444'
const VERSION = 'synthetic-herbicide-v1'
const UPDATED_AT = '2026-10-11T01:00:00Z'

// 冻结闭集文案（与 `miniprogram/utils/knowledge-api.js` 的 message() 逐字一致，测试独立复述以免同源漂移）。
const TEXT = {
  NOT_FOUND: '资料不存在、已失效或不符合查询条件，请返回列表重新查询。',
  INVALID_CURSOR: '查询已过期或资料已更新，请点击查询重新开始。',
  INVALID_INPUT: '查询条件格式不正确，请修改后重试。',
  INVALID_RESPONSE: '资料响应无法核对，已清空，请重试。',
  UNSUPPORTED_DOSE_RESPONSE: '该资料含本页尚未接入的用量卡，已停止展示。',
  SESSION_REQUIRED: '登录状态已失效，请重新登录。',
  SESSION_CHANGED: '会话已变化，请重新进入查询。',
  NETWORK_UNCERTAIN: '网络未能确认当前资料，已清空，请重试。'
}
const UNAVAILABLE = '资料服务暂不可用，已清空，请重试。'
const BUNDLED_NOT_FOUND = '该记录不存在，或已被下架、失效而不在有效资料中。'

const source = (patch = {}) => ({
  id: SOURCE_ID, version: VERSION, title: '合成来源（测试）', url: 'https://example.test/source',
  publisher: '测试发布方', source_kind: 'simulation', evidence_kind: 'research',
  validity: 'valid', review_status: 'unverified', updated_at: UPDATED_AT, ...patch
})
const herbicide = (patch = {}, formulation = {}, src = {}) => ({
  id: RECORD_ID, revision: 1,
  formulation: {
    id: FORMULATION_ID, registration_number: 'PD2026-SYN-0001', producer: '合成生产方',
    dosage_form: '悬浮剂', ingredients: [{ name: '合成成分甲', content_text: '20', unit_text: '克/升' }],
    ...formulation
  },
  source: source(src), risk_text: '合成风险说明，不作为用药依据。', reference_state: 'available', ...patch
})
const envelope = (data, mode = 'stub') => ({
  data, meta: { request_id: '55555555-5555-4555-8555-555555555555', contract_version: '1.0.0', execution_mode: mode }
})
const flush = () => new Promise((r) => setImmediate(r))
const settle = async () => { await flush(); await flush() }

/**
 * 夹具：真页面 + 真客户端，受控 HTTP 回放。
 * @param {string|null} name 页面名（`reference` / `referencedetail`）；null 表示只装载 utils。
 */
function fixture(name = null) {
  const requests = [], storage = new Map(), routes = [], clips = [], cache = new Map()
  const runtime = { mode: 'local', apiBaseUrl: BASE }
  let page = null
  const wx = {
    request: (o) => requests.push(o),
    login: (o) => o.success({ code: 'synthetic-code' }),
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    reLaunch: (o) => { routes.push(o.url); o.success && o.success() },
    navigateTo: (o) => { routes.push(o.url); o.success && o.success() },
    redirectTo: (o) => { routes.push(o.url); o.success && o.success() },
    navigateBack: (o) => { wx.back = o },
    setClipboardData: (o) => clips.push(o.data),
    getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, pixelRatio: 2, fontSizeSetting: 16, SDKVersion: '2.30.0' })
  }
  function load(file) {
    file = resolve(file)
    if (!file.endsWith('.js')) file += '.js'
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }
    cache.set(file, module)
    if (file === resolve(root, 'config/runtime.js')) { module.exports = runtime; return module.exports }
    vm.runInNewContext(readFileSync(file, 'utf8'), {
      module, wx, console, setTimeout, clearTimeout, setImmediate,
      require: (p) => load(resolve(dirname(file), p)),
      getApp: () => ({ globalData: { fontScale: 1 } }),
      getCurrentPages: () => (page ? [page] : []),
      Page: (definition) => {
        page = {
          ...definition,
          route: 'pages/' + name + '/' + name,
          options: {},
          data: structuredClone(definition.data),
          setData(patch) { Object.assign(this.data, patch) }
        }
      }
    }, { filename: file })
    return module.exports
  }
  const auth = load(resolve(root, 'utils/auth.js'))
  const api = load(resolve(root, 'utils/knowledge-api.js'))
  if (name) load(resolve(root, 'pages/' + name + '/' + name + '.js'))

  const pending = (path) => requests.filter((r) => !r._done && r.url.includes(path)).at(-1)
  const urls = () => requests.map((r) => r.url)
  const listCalls = () => urls().filter((u) => /\/herbicides(\?|$)/.test(u))
  const detailCalls = () => urls().filter((u) => /\/herbicides\/[^?]+$/.test(u))
  function answer(r, data, status = 200, mode = 'stub') {
    assert.ok(r, 'expected a pending request to answer')
    r._done = true
    r.success({ statusCode: status, data: envelope(data, mode) })
  }
  function answerProfile(patch = {}) {
    const r = pending('/me/profile')
    if (!r) return false
    answer(r, { crop_id: null, region_code: null, region_catalog_version: null, revision: 1, ...patch })
    return true
  }
  function login(token = 'synthetic-token') {
    auth.login(() => {})
    const r = pending('/auth/wechat')
    assert.ok(r, '登录桩应发出 /auth/wechat')
    answer(r, { access_token: token, audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() })
  }
  // 页面 gate：回放 /auth/session（及随包详情路径会读的 /me/profile），直到不再有新请求。
  async function show(options = {}) {
    page.options = options
    page.onLoad(options)
    page.onShow()
    for (let i = 0; i < 4; i += 1) {
      const session = pending('/auth/session')
      if (session) answer(session, { audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() })
      answerProfile()
      await settle()
    }
  }
  return { page, wx, auth, api, runtime, requests, routes, clips, urls, listCalls, detailCalls, pending, answer, answerProfile, login, show }
}

// ── A 同源 source_version 一致性 ────────────────────────────────────────────────

test('A1 客户端：列表行与详情对同一记录给出同一个 source_version，且不冒名登记名称', async () => {
  const f = fixture(null)
  f.login()

  const listPromise = f.api.listHerbicides({ limit: 5 })
  await settle()
  const listRequest = f.pending('/herbicides')
  assert.equal(listRequest.url, BASE + '/herbicides?limit=5', '列表请求只带契约允许的 q/registration_number/cursor/limit')
  f.answer(listRequest, { items: [herbicide()], next_cursor: null })
  const list = await listPromise
  const row = f.api.herbicideRow(list.items[0])
  assert.equal(row.source_version, VERSION)
  assert.equal(row.data_source, 'server')
  assert.equal(row.source_marker, '服务端接口 /herbicides')
  // 契约里没有登记名称/毒性/作物场所：必须留空，不得用成分名拼接冒名。
  assert.equal(row.registered_name, '')
  assert.equal(row.toxicity, '')
  assert.equal(row.use_scene, '')
  assert.equal(row.ingredients_text, '合成成分甲 20')

  const detailPromise = f.api.detailHerbicide(RECORD_ID)
  await settle()
  const detailRequest = f.pending('/herbicides/' + RECORD_ID)
  assert.equal(detailRequest.url, BASE + '/herbicides/' + RECORD_ID)
  assert.ok(!detailRequest.url.includes('?'), '/herbicides/{id} 不得携带查询串')
  f.answer(detailRequest, herbicide())
  const detail = await detailPromise
  assert.equal(f.api.herbicideRow(detail.item).source_version, row.source_version, '列表与详情必须同源同版本')
})

test('A2 页面：列表页展示的 sourceVersionNote 与详情页展示的 source_version 一致', async () => {
  const list = fixture('reference')
  list.login()
  await list.show()
  const listRequest = list.pending('/herbicides')
  assert.equal(listRequest.url, BASE + '/herbicides?limit=20')
  list.answer(listRequest, {
    items: [herbicide()],
    next_cursor: null,
    query_state: { match_state: 'matched', total: 1, reasons: [], unmatched_reasons: [], simulated_excluded: 0, matched_dimensions: [] }
  })
  await settle()
  assert.equal(list.page.data.dataSource, 'server')
  assert.equal(list.page.data.dataSourceLabel, '数据来源：服务端接口 /herbicides（真实读数，等待返回）。')
  assert.equal(list.page.data.items.length, 1)
  assert.equal(list.page.data.items[0].data_source, 'server')
  assert.equal(list.page.data.sourceVersionNote, VERSION)
  assert.equal(list.page.data.matchState, 'matched', '判定取服务端真值，不按 items.length 反推')
  assert.equal(list.page.data.matchLabel, '已找到符合条件的资料')
  assert.equal(list.page.data.countNote, '本页 1 条 / 共 1 条（总数为裁剪前领域判定）')
  assert.equal(list.page.data.queryError, '')

  const detail = fixture('referencedetail')
  detail.login()
  await detail.show({ id: RECORD_ID })
  const detailRequest = detail.pending('/herbicides/' + RECORD_ID)
  assert.ok(detailRequest, '详情页应请求 /herbicides/{id}')
  assert.ok(!detailRequest.url.includes('?'), '详情请求不得携带查询串')
  detail.answer(detailRequest, herbicide())
  await settle()
  assert.equal(detail.page.data.dataSource, 'server')
  assert.equal(detail.page.data.sourceMarker, '服务端接口 /herbicides/{id}')
  assert.equal(detail.page.data.found, true)
  assert.equal(detail.page.data.detail.record_id, RECORD_ID)
  assert.equal(detail.page.data.detail.source_version, list.page.data.sourceVersionNote, '列表与详情必须展示同一个 source_version')
  assert.equal(detail.page.data.sourceDateLabel, '来源更新时间')
  assert.equal(detail.page.data.doseCardNote, '本页经由服务端接口 /herbicides/{id} 读取：该接口不提供用量卡与适用性字段，本页不展示任何用量。')
  assert.equal(detail.page.data.doseCard, null)
  assert.equal(detail.page.data.applicability, null)
})

test('A3 页面：随包离线副本对同一记录同样只给一个 source_version（列表行 === 详情）', async () => {
  const BUNDLED_ID = 'gy-i03-hb-001' // 非 UUID ⇒ 随包记录 id
  const list = fixture('reference')
  list.login()
  // 门禁只认「已联网 + 服务端核实过的会话」（见 D1），所以先按联网状态过门禁，再关联网取随包列表。
  await list.show()
  const serverCalls = list.listCalls().length
  list.runtime.mode = 'disabled'
  list.runtime.apiBaseUrl = ''
  list.page.runQuery()
  await settle()
  assert.equal(list.listCalls().length, serverCalls, '随包路径不得发起 /herbicides')
  assert.equal(list.page.data.dataSource, 'bundled-offline')
  const row = list.page.data.items.find((item) => item.record_id === BUNDLED_ID)
  assert.ok(row, '随包列表应含 ' + BUNDLED_ID)
  assert.equal(row.data_source, 'bundled-offline')
  assert.equal(row.source_marker, '随包离线副本')
  assert.equal(typeof row.source_version, 'string')
  assert.notEqual(row.source_version.trim(), '', '随包行也必须带可判定的来源版本')

  const detail = fixture('referencedetail')
  detail.login()
  // 非 UUID 记录 id 在**联网**状态下同样走随包路径（见 D3），无需关联网。
  await detail.show({ id: BUNDLED_ID })
  assert.equal(detail.detailCalls().length, 0)
  assert.equal(detail.page.data.dataSource, 'bundled-offline')
  assert.equal(detail.page.data.sourceMarker, '随包离线副本')
  assert.ok(detail.page.data.detail, '随包详情应加载到记录')
  assert.equal(
    detail.page.data.detail.source_version,
    row.source_version,
    '随包列表与详情必须同源同版本'
  )
  assert.equal(detail.page.data.sourceDateLabel, '采集日期')
})

// ── B 非空 dose_cards ⇒ UNSUPPORTED_DOSE_RESPONSE，不可绕过 ─────────────────────
test('B1 客户端：非空 dose_cards 落 UNSUPPORTED_DOSE_RESPONSE，且不被 additionalProperties 闭集降级', async () => {
  const f = fixture(null)
  f.login()
  const tainted = Object.assign(herbicide(), { dose_cards: [{ id: OTHER_ID }], unknown_field: 'x' })

  const listPromise = f.api.listHerbicides({})
  await settle()
  f.answer(f.pending('/herbicides'), { items: [tainted], next_cursor: null })
  await assert.rejects(listPromise, (error) => {
    assert.equal(error.code, 'UNSUPPORTED_DOSE_RESPONSE', '必须先判用量卡（守卫在 keys() 之前）')
    assert.equal(f.api.message(error), TEXT.UNSUPPORTED_DOSE_RESPONSE)
    return true
  })

  const detailPromise = f.api.detailHerbicide(RECORD_ID)
  await settle()
  f.answer(f.pending('/herbicides/' + RECORD_ID), tainted)
  await assert.rejects(detailPromise, (error) => {
    assert.equal(error.code, 'UNSUPPORTED_DOSE_RESPONSE')
    assert.equal(f.api.message(error), TEXT.UNSUPPORTED_DOSE_RESPONSE)
    return true
  })

  // 对照：空 dose_cards 走闭集，未列字段 ⇒ INVALID_RESPONSE（说明守卫只针对**非空**用量卡）。
  const clean = f.api.listHerbicides({})
  await settle()
  f.answer(f.pending('/herbicides'), { items: [Object.assign(herbicide(), { dose_cards: [], unknown_field: 'x' })], next_cursor: null })
  await assert.rejects(clean, (error) => {
    assert.equal(error.code, 'INVALID_RESPONSE')
    return true
  })
})

test('B2 页面：带非空 dose_cards 的响应不得进入列表/详情，且文案为冻结闭集', async () => {
  const tainted = Object.assign(herbicide(), { dose_cards: [{ id: OTHER_ID }] })

  const list = fixture('reference')
  list.login()
  await list.show()
  list.answer(list.pending('/herbicides'), { items: [tainted], next_cursor: null })
  await settle()
  assert.equal(list.page.data.items.length, 0, '含未接入用量卡的资料不得展示')
  assert.equal(list.page.data.queryError, TEXT.UNSUPPORTED_DOSE_RESPONSE)
  assert.equal(list.page.data.sourceVersionNote, '')
  assert.equal(list.page.data.dataSource, 'server', '失败也不得改标为离线副本')

  const detail = fixture('referencedetail')
  detail.login()
  await detail.show({ id: RECORD_ID })
  detail.answer(detail.pending('/herbicides/' + RECORD_ID), tainted)
  await settle()
  assert.equal(detail.page.data.found, false)
  assert.equal(detail.page.data.detail, null)
  assert.equal(detail.page.data.doseCard, null)
  assert.equal(detail.page.data.doseCardNote, '')
  assert.equal(detail.page.data.notFoundText, TEXT.UNSUPPORTED_DOSE_RESPONSE)
  assert.equal(detail.page.data.dataSource, 'server')
})

// ── C 404 ⇒ NOT_FOUND；文案为冻结闭集 ─────────────────────────────────────────

test('C1 文案闭集：message() 只取冻结字符串，未知错误码与 5xx 走同一兜底', () => {
  const f = fixture(null)
  const map = {
    NOT_FOUND: TEXT.NOT_FOUND,
    INVALID_CURSOR: TEXT.INVALID_CURSOR,
    INVALID_INPUT: TEXT.INVALID_INPUT,
    INVALID_RESPONSE: TEXT.INVALID_RESPONSE,
    UNSUPPORTED_DOSE_RESPONSE: TEXT.UNSUPPORTED_DOSE_RESPONSE,
    SESSION_REQUIRED: TEXT.SESSION_REQUIRED,
    SESSION_CHANGED: TEXT.SESSION_CHANGED,
    NETWORK_UNCERTAIN: TEXT.NETWORK_UNCERTAIN
  }
  const seen = new Set()
  Object.entries(map).forEach(([code, text]) => {
    const out = f.api.message({ code })
    assert.equal(out, text, code + ' 文案必须逐字冻结')
    seen.add(out)
  })
  assert.equal(f.api.message({ code: 'SOME_FUTURE_CODE' }), UNAVAILABLE)
  assert.equal(f.api.message(undefined), UNAVAILABLE)
  assert.equal(f.api.message(new Error('boom')), UNAVAILABLE)
  assert.equal(seen.has(UNAVAILABLE), false, '兜底文案不得与任何具体错误码文案重复')
  // 404 ⇒ NOT_FOUND 是 request() 的映射（见 C2/C3 的页面实测）。
})

test('C2 页面：服务端 404 ⇒ notFoundText 取 NOT_FOUND 文案，不回退随包副本', async () => {
  const detail = fixture('referencedetail')
  detail.login()
  await detail.show({ id: RECORD_ID })
  detail.answer(detail.pending('/herbicides/' + RECORD_ID), { error: { code: 'NOT_FOUND' } }, 404)
  await settle()
  assert.equal(detail.page.data.notFoundText, TEXT.NOT_FOUND)
  assert.notEqual(detail.page.data.notFoundText, BUNDLED_NOT_FOUND, '服务端 404 不得使用随包副本文案')
  assert.equal(detail.page.data.found, false)
  assert.equal(detail.page.data.detail, null)
  assert.equal(detail.page.data.queryable, false)
  assert.equal(detail.page.data.dataSource, 'server', '服务端 404 仍属服务端来源，不得改标离线')
  assert.equal(detail.page.data.sourceMarker, '服务端接口 /herbicides/{id}')
  assert.equal(detail.detailCalls().length, 1)
})

test('C3 页面：服务端 5xx ⇒ 兜底文案；列表失败绝不改用离线副本', async () => {
  const list = fixture('reference')
  list.login()
  await list.show()
  list.answer(list.pending('/herbicides'), {}, 503)
  await settle()
  assert.equal(list.page.data.queryError, UNAVAILABLE)
  assert.equal(list.page.data.items.length, 0)
  assert.equal(list.page.data.dataSource, 'server')
  assert.equal(list.page.data.dataSourceLabel, '数据来源：服务端接口 /herbicides（本次请求未完成，未改用离线副本）。')
  assert.equal(list.page.data.countNote, '')
  assert.equal(list.listCalls().length, 1, '失败后不得再打离线副本以外的请求')

  const detail = fixture('referencedetail')
  detail.login()
  await detail.show({ id: RECORD_ID })
  detail.answer(detail.pending('/herbicides/' + RECORD_ID), {}, 503)
  await settle()
  assert.equal(detail.page.data.notFoundText, UNAVAILABLE)
  assert.equal(detail.page.data.found, false)
})

// ── D 离线回退可区分 ──────────────────────────────────────────────────────────

// 未联网是本片最容易被写歪的状态：`miniprogram/utils/page-gate.js:4-16` 先 `callback(false)` 再
// `auth.requireLogin`，而 `miniprogram/utils/auth.js:349-360` 在 `session === null || !networkEnabled()`
// 时直接 `navigation.goLogin(op.id); done(false)`（`miniprogram/utils/auth.js:210-214` 的 login 同样
// 在未联网时直接返回）⇒ **未启用联网的构建里门禁永远不通过，列表页根本不渲染随包副本**。
// D1 钉这个真实可达状态（不冒充服务端、也不悄悄给随包、且跳登录）；D1b 才是纵深防御态。
test('D1 页面：运行未启用联网 ⇒ 不加载任何资料、不冒充服务端、跳登录，零 /herbicides 请求', async () => {
  const f = fixture('reference')
  f.runtime.mode = 'disabled' // runtime 是 utils/auth 与 utils/knowledge-api 共享的同一对象
  f.runtime.apiBaseUrl = ''
  await f.show()
  assert.equal(f.listCalls().length, 0, '未联网时不得请求 /herbicides')
  assert.equal(f.page.data.gatePassed, false, '未联网且无会话 ⇒ 门禁不通过')
  assert.equal(f.page.data.items.length, 0, '门禁不通过时不得展示任何记录')
  assert.equal(f.page.data.dataSource, '', '既不冒充服务端读数，也不悄悄给随包副本')
  assert.ok(f.routes.some((url) => url.indexOf('login') !== -1), '未联网且无会话 ⇒ 跳登录页')
})

test('D1b 页面（纵深防御）：门禁通过后联网被关闭 ⇒ 随包副本路径，零新增 /herbicides，标记可判定', async () => {
  const f = fixture('reference')
  f.login()
  await f.show()
  const serverCalls = f.listCalls().length
  // 关掉联网开关（runtime 是 utils/auth 与 utils/knowledge-api 共享的同一对象）。
  f.runtime.mode = 'disabled'
  f.runtime.apiBaseUrl = ''
  f.page.runQuery()
  await settle()
  assert.equal(f.listCalls().length, serverCalls, '未联网时不得请求 /herbicides')
  assert.equal(f.page.data.dataSource, 'bundled-offline')
  assert.equal(f.page.data.dataSourceLabel, '数据来源：随包离线副本（bundled-offline）——当前运行未启用联网（runtime.mode 非 local），不冒充服务端读数。')
  assert.ok(f.page.data.items.every((row) => row.data_source === 'bundled-offline'), '随包行必须逐条标注离线来源')
  assert.ok(f.page.data.items.every((row) => row.source_marker === '随包离线副本'))
})

// D2 一族钉的是同一个缺陷的两半：
//   - 作物：服务端 `/herbicides` 真按记录的 `crop_ids` 收窄，页面却只要见到作物条件就回退离线、并在标签里对
//     用户说「服务端不支持作物／杂草／地区条件」⇒ 必须走服务端且 `crop_id` 真的带上（D2）。
//   - 地区：服务端 schema **接受** `region_code`，但仓内资料零条标注适用地区、响应又不回
//     `match_state`/`reasons` ⇒ 提交它只会把"未标注"显示成"不满足所选条件"，所以本版**不提交**、改走随包
//     副本并如实写"资料未标注适用地区"（D2e）。两者都不是"接口不支持地区"，标签里不许出现这种措辞。
//   - `species_id`／`dosage_form` 才是该接口根本没有的参数，回退时同样只写真实原因（D2b）。
// 服务端失败仍**不许**静默改走离线副本（`data_source` 停在 server，文案说明未改用离线）——见 D2c。
const firstCropId = (page) => {
  const crops = page.data.crops
  assert.ok(Array.isArray(crops) && crops.length > 0, '随包作物目录应可用')
  const id = typeof crops[0] === 'string' ? crops[0] : crops[0].id
  assert.equal(typeof id, 'string')
  return id
}
const firstRegionCode = (page) => {
  const regions = page.data.regions
  assert.ok(Array.isArray(regions) && regions.length > 0, '随包地区目录应可用')
  return regions[0].code
}

test('D2 页面：带作物条件 ⇒ 走服务端，且 crop_id 真的进了查询串', async () => {
  const f = fixture('reference')
  f.login()
  await f.show()
  const first = f.pending('/herbicides')
  assert.equal(new URL(first.url).search, '?limit=20', '无条件时只发 limit（既有口径不变）')
  f.answer(first, { items: [herbicide()], next_cursor: null })
  await settle()
  const serverCalls = f.listCalls().length

  const cropId = firstCropId(f.page)
  f.page.data.cropId = cropId
  f.page.runQuery()
  await settle()
  assert.equal(f.listCalls().length, serverCalls + 1, '作物是服务端接受的筛选维度 ⇒ 必须真打服务端，不得改走离线副本')
  const cropRequest = f.pending('/herbicides')
  assert.ok(cropRequest, '带作物条件应发出一条新的 /herbicides 请求')
  const cropUrl = new URL(cropRequest.url)
  assert.equal(cropUrl.pathname, '/api/v1/herbicides')
  assert.equal(cropUrl.searchParams.get('crop_id'), cropId, 'crop_id 必须真的随请求提交（丢掉它 = 页面显示已筛选、实际全量）')
  assert.equal(cropUrl.searchParams.get('limit'), '20')
  assert.equal(cropUrl.searchParams.get('region_code'), null, '地区本版不提交 ⇒ 没选地区时更不许带')
  assert.equal(cropUrl.searchParams.get('species_id'), null, '没选杂草就不许凭空带 species_id')
  assert.equal(f.page.data.dataSource, 'server', '带作物条件仍属服务端读数')
  assert.equal(f.page.data.dataSourceLabel, '数据来源：服务端接口 /herbicides（真实读数，等待返回）。')
  f.answer(cropRequest, { items: [herbicide()], next_cursor: null })
  await settle()
  assert.equal(f.page.data.matchedNote, '命中条件：作物（筛选条件未被放宽）', '命中条件只列本次真的提交过的维度')
  assert.equal(f.page.data.items.length, 1)
})

test('D2e 页面：选了地区 ⇒ 走随包副本，查询串里没有 region_code，离线原因点名"资料未标注适用地区"', async () => {
  const f = fixture('reference')
  f.login()
  await f.show()
  f.answer(f.pending('/herbicides'), { items: [herbicide()], next_cursor: null })
  await settle()
  const serverCalls = f.listCalls().length

  const regionCode = firstRegionCode(f.page)
  f.page.data.regionCode = regionCode
  f.page.runQuery()
  await settle()

  assert.equal(f.listCalls().length, serverCalls, '地区本版不提交 ⇒ 不得发出 /herbicides 请求（提交只会把"未标注"显示成"不满足"）')
  assert.equal(
    f.listCalls().every((url) => new URL(url).searchParams.get('region_code') === null),
    true,
    '任何一条 /herbicides 请求都不许带 region_code',
  )
  const label = f.page.data.dataSourceLabel
  assert.equal(f.page.data.dataSource, 'bundled-offline')
  assert.ok(label.includes('region_code') && label.includes('地区'), `离线原因必须点名地区（当前：${label}）`)
  assert.ok(label.includes('未标注'), `离线原因必须写真实原因"资料未标注适用地区"（当前：${label}）`)
  assert.equal(/不支持/u.test(label), false, `"服务端接受该参数、只是资料未标注"≠"不支持"，不得再写不支持（当前：${label}）`)
  assert.equal(/不满足/u.test(label), false, `不得把"未标注"说成"不满足所选条件"（当前：${label}）`)
  assert.ok(f.page.data.items.every((row) => row.data_source === 'bundled-offline'), '随包行必须逐条标注离线来源')
  assert.ok(f.page.data.items.every((row) => row.source_marker === '随包离线副本'))
})

test('D2b 页面：带杂草条件（服务端不接受 species_id）⇒ 离线副本，来源标记如实且原因只写真实原因', async () => {
  const f = fixture('reference')
  f.login()
  await f.show()
  f.answer(f.pending('/herbicides'), { items: [herbicide()], next_cursor: null })
  await settle()
  const serverCalls = f.listCalls().length

  const species = f.page.data.species
  assert.ok(Array.isArray(species) && species.length > 0, '随包杂草目录应可用')
  f.page.data.speciesId = typeof species[0] === 'string' ? species[0] : species[0].id
  f.page.runQuery()
  await settle()

  assert.equal(f.listCalls().length, serverCalls, 'species_id 不被该接口接受 ⇒ 不得发请求（发了只会 400），也不许把条件悄悄丢掉后仍打服务端')
  assert.equal(f.page.data.dataSource, 'bundled-offline')
  const label = f.page.data.dataSourceLabel
  assert.ok(label.includes('species_id') && label.includes('杂草'), `离线原因必须点名真正不被接受的维度（当前：${label}）`)
  // 这一句是本次缺陷的核心假话：作物／地区**恰恰**是服务端接受的维度，不得再出现在"不接受"的语境里。
  assert.equal(/不支持/u.test(label), false, `离线标签不得再写"不支持"这种笼统措辞（当前：${label}）`)
  assert.equal(/作物/u.test(label), false, `作物条件是可表达的，不得在离线原因里出现（当前：${label}）`)
  assert.equal(/地区/u.test(label), false, `地区条件是可表达的，不得在离线原因里出现（当前：${label}）`)
  assert.ok(f.page.data.items.every((row) => row.data_source === 'bundled-offline'), '随包行必须逐条标注离线来源')
  assert.ok(f.page.data.items.every((row) => row.source_marker === '随包离线副本'))
})

test('D2c 页面：带作物条件时服务端报错 ⇒ 如实报错、不静默改走离线副本', async () => {
  const f = fixture('reference')
  f.login()
  await f.show()
  f.answer(f.pending('/herbicides'), { items: [herbicide()], next_cursor: null })
  await settle()
  const serverCalls = f.listCalls().length

  f.page.data.cropId = firstCropId(f.page)
  f.page.runQuery()
  await settle()
  const failing = f.pending('/herbicides')
  assert.ok(failing && failing.url.includes('crop_id='), '失败态用例的前提：请求确实带上了 crop_id')
  f.answer(failing, {}, 503)
  await settle()

  assert.equal(f.page.data.queryError, UNAVAILABLE)
  assert.equal(f.page.data.dataSource, 'server', '服务端失败不得改标离线来源')
  assert.equal(f.page.data.dataSourceLabel, '数据来源：服务端接口 /herbicides（本次请求未完成，未改用离线副本）。')
  assert.equal(f.page.data.items.length, 0, '失败态不得塞入随包副本记录冒充结果')
  assert.equal(f.listCalls().length, serverCalls + 1, '失败后不得再补打任何列表请求（尤其不得改走离线）')
})

test('D2d 客户端：参数面逐条对齐服务端 schema —— 不接受的键抛 INVALID_INPUT（不静默丢弃）', async () => {
  const f = fixture(null)
  f.login()
  const rejects = async (input, why) => {
    const before = f.requests.length
    await assert.rejects(f.api.listHerbicides(input), (error) => error && error.code === 'INVALID_INPUT', why)
    assert.equal(f.requests.length, before, `${why}：非法输入不得发出任何请求`)
  }
  // 服务端 schema 里没有的键 ⇒ 客户端当场拒绝，**不许**悄悄丢掉后仍打服务端（那会把条件变成"已筛选"的假象）。
  await rejects({ species_id: 'synthetic_weed' }, 'species_id 不在 /herbicides 参数面内')
  await rejects({ growth_stage: 'seedling' }, 'growth_stage 不在 /herbicides 参数面内')
  await rejects({ planting_method: 'transplant' }, 'planting_method 不在 /herbicides 参数面内')
  await rejects({ use_scene: 'field' }, 'use_scene 不在 /herbicides 参数面内')
  await rejects({ dosage_form: '悬浮剂' }, 'dosage_form 是页面侧条件，服务端没有这个键')
  await rejects({ synthetic_unknown: 'x' }, '未知键必须拒绝而不是丢弃')
  // region_code：服务端 schema 接受它（并已回 `query_state`），但本片**不改筛选面**——资料仍零条标注
  // 适用地区，接上只会把"未标注"刷成"未命中"；接线是单独一片的事。所以客户端这一层仍不许把它
  // 悄悄发出去，连合法值也拒。
  await rejects({ region_code: '330102' }, 'region_code 本片仍不提交（资料零标注，接线留下一片）')
  await rejects({ region_code: '110101' }, 'region_code 本片仍不提交，脏值更不许发')
  // 取值校验照服务端约束：text = 非空且 ≤80。
  await rejects({ crop_id: '' }, 'crop_id 非空')
  await rejects({ crop_id: 'x'.repeat(81) }, 'crop_id ≤80')
  // 反向：三个可表达的键必须真的被接受并进查询串（否则"白名单"只是摆设）。
  const accepted = f.api.listHerbicides({ crop_id: 'crop_rice', q: '稻', registration_number: 'PD20161371' })
  const request = f.pending('/herbicides')
  assert.ok(request, '合规参数必须真的发出请求')
  const url = new URL(request.url)
  assert.equal(url.searchParams.get('crop_id'), 'crop_rice')
  assert.equal(url.searchParams.get('q'), '稻')
  assert.equal(url.searchParams.get('registration_number'), 'PD20161371')
  assert.equal(url.searchParams.get('region_code'), null, '没传的条件不得凭空出现')
  assert.equal(url.searchParams.get('species_id'), null, '没传的条件不得凭空出现')
  f.answer(request, { items: [herbicide()], next_cursor: null })
  await accepted
})

test('E1 页面：判定与理由一律照抄服务端 query_state —— insufficient 说「无法确认」，绝不说成「不满足」', async () => {
  const f = fixture('reference')
  f.login()
  await f.show()
  // 说明：本片页面只提交 crop_id/q，服务端 `insufficient` 当前**只可能**由 region_code 触发，而页面
  // 不提交它 ⇒ 下面这份响应在生产路径暂不可达。用例钉的是「拿到什么就如实转述什么」的渲染契约，
  // 不是"生产已达"；可达性缺口写进交付报告的「本片没有解决什么」。
  f.answer(f.pending('/herbicides'), {
    items: [],
    next_cursor: null,
    query_state: {
      match_state: 'insufficient',
      total: 0,
      reasons: ['部分条件在资料中未标注，无法确认适用性'],
      unmatched_reasons: [
        { record_id: 'gy-i03-hb-001', reasons: ['记录未标注适用地区，无法确认是否适用该地区'] },
        { record_id: 'gy-i03-hb-002', reasons: ['记录未标注适用地区，无法确认是否适用该地区'] }
      ],
      simulated_excluded: 2,
      matched_dimensions: ['region_code']
    }
  })
  await settle()
  assert.equal(f.page.data.matchState, 'insufficient', '判定取服务端真值，不按 items.length 反推')
  assert.equal(f.page.data.matchLabel, '条件在资料中未标注，无法确认')
  assert.equal(/不满足/u.test(f.page.data.matchLabel), false, `未标注不得说成「不满足」（当前：${f.page.data.matchLabel}）`)
  assert.deepEqual(f.page.data.reasons, ['部分条件在资料中未标注，无法确认适用性'])
  // 页面在 vm 里跑，数组/对象的原型跨 realm ⇒ 用 JSON 往返比较值，避免 deepStrictEqual 因原型差异误报。
  assert.deepEqual(
    JSON.parse(JSON.stringify(f.page.data.unmatchedReasons)),
    [
      { record_id: 'gy-i03-hb-001', reasons: ['记录未标注适用地区，无法确认是否适用该地区'] },
      { record_id: 'gy-i03-hb-002', reasons: ['记录未标注适用地区，无法确认是否适用该地区'] }
    ]
  )
  assert.equal(f.page.data.simulatedExcluded, 2, '模拟数据被排除的条数必须透出，不吞掉')
  assert.equal(f.page.data.matchedNote, '命中条件：地区（筛选条件未被放宽）', '命中维度取服务端 matched_dimensions')
  assert.equal(f.page.data.total, 0)
  assert.equal(f.page.data.countNote, '')
  assert.equal(f.page.data.items.length, 0)
  assert.equal(f.page.data.queryError, '')
})

test('E2 页面：权限裁剪后本页比 total 少也不得说成 no_match —— countNote 把「本页/共」分开说', async () => {
  const f = fixture('reference')
  f.login()
  await f.show()
  f.answer(f.pending('/herbicides'), {
    items: [herbicide(), herbicide({ id: OTHER_ID })],
    next_cursor: null,
    query_state: { match_state: 'matched', total: 6, reasons: [], unmatched_reasons: [], simulated_excluded: 0, matched_dimensions: [] }
  })
  await settle()
  // `items` 是权限裁剪后的可见集，`total`/`match_state` 是裁剪前领域判定（口径写在
  // services/api/src/routes/knowledge.ts 与 miniprogram/pages/reference/reference.js 的注释里）。
  assert.equal(f.page.data.queryError, '')
  assert.equal(f.page.data.matchState, 'matched', '有记录被权限滤掉 ≠ 没有资料')
  assert.equal(f.page.data.total, 6)
  assert.equal(f.page.data.items.length, 2)
  assert.equal(f.page.data.countNote, '本页 2 条 / 共 6 条（总数为裁剪前领域判定）')
})

test('E3 页面：响应缺 query_state ⇒ 不猜判定（不写 matched / 不写 no_match），如实说「未提供」', async () => {
  const f = fixture('reference')
  f.login()
  await f.show()
  f.answer(f.pending('/herbicides'), { items: [herbicide()], next_cursor: null })
  await settle()
  assert.equal(f.page.data.items.length, 1, '兼容性前提：老响应仍能出列表')
  assert.notEqual(f.page.data.matchState, 'no_match', '没拿到判定就不许断言"没有匹配"')
  assert.notEqual(f.page.data.matchState, 'matched', '没拿到判定也不许断言"已匹配"')
  assert.equal(f.page.data.matchState, '')
  assert.equal(f.page.data.matchLabel, '服务端未提供匹配判定')
  assert.equal(f.page.data.total, 0)
  assert.equal(f.page.data.countNote, '本页 1 条（服务端未提供匹配判定）')
  assert.equal(f.page.data.queryError, '')
})

test('E4 客户端：query_state 形状越界 ⇒ INVALID_RESPONSE（不猜、不截断、不丢弃）', async () => {
  const f = fixture(null)
  f.login()
  const good = { match_state: 'matched', total: 1, reasons: [], unmatched_reasons: [], simulated_excluded: 0, matched_dimensions: [] }
  const rejects = async (queryState, why) => {
    const pending = f.api.listHerbicides({})
    f.answer(f.pending('/herbicides'), { items: [], next_cursor: null, query_state: queryState })
    await assert.rejects(pending, (error) => error && error.code === 'INVALID_RESPONSE', why)
  }
  await rejects({ ...good, match_state: 'partial' }, 'match_state 不在闭集内')
  await rejects({ ...good, match_state: 'ambiguous' }, 'MatchState 六值里的 ambiguous 不是列表判定取值')
  await rejects({ ...good, total: -1 }, 'total 不得为负')
  await rejects({ ...good, total: 1.5 }, 'total 必须是整数')
  await rejects({ ...good, simulated_excluded: -2 }, 'simulated_excluded 不得为负')
  await rejects({ match_state: 'matched', total: 1, reasons: [], unmatched_reasons: [], simulated_excluded: 0 }, '缺 matched_dimensions 不得默认成空数组')
  await rejects({ ...good, extra_field: 'x' }, '多余字段不得静默忽略')
  await rejects({ ...good, reasons: [1] }, 'reasons 元素必须是字符串')
  await rejects({ ...good, unmatched_reasons: [{ record_id: 'gy-i03-hb-001' }] }, 'unmatched_reasons 元素缺 reasons')
  await rejects({ ...good, unmatched_reasons: Array.from({ length: 11 }, (_v, i) => ({ record_id: 'gy-i03-hb-0' + (i % 10), reasons: ['x'] })) }, 'unmatched_reasons 至多 10 条')
})

test('D3 页面：非 UUID 记录 id ⇒ 走随包副本，零 /herbicides/{id} 请求', async () => {
  const f = fixture('referencedetail')
  f.login()
  await f.show({ id: 'gy-i07-hb-001' })
  assert.equal(f.detailCalls().length, 0, '非 UUID id 不得请求服务端详情')
  assert.equal(f.page.data.dataSource, 'bundled-offline')
  assert.equal(f.page.data.sourceMarker, '随包离线副本')
  if (f.page.data.notFoundText) assert.equal(f.page.data.notFoundText, BUNDLED_NOT_FOUND)
  if (f.page.data.detail) assert.notEqual(f.page.data.detail.source_version, VERSION)
})

test('D4 页面：服务端路径按 source.updated_at 如实标注「来源更新时间」，不冒称采集日期；且不读 /me/profile', async () => {
  const server = fixture('referencedetail')
  server.login()
  await server.show({ id: RECORD_ID })
  server.answer(server.pending('/herbicides/' + RECORD_ID), herbicide())
  await settle()
  assert.equal(server.urls().filter((u) => u.includes('/me/profile')).length, 0, '服务端路径不读随包档案')
  assert.equal(server.page.data.sourceDateLabel, '来源更新时间', 'updated_at 必须按「来源更新时间」呈现')
  assert.equal(server.page.data.detail.source.retrieved_at, UPDATED_AT)
  assert.equal(server.page.data.detail.source.issue, '合成来源（测试）')
  assert.equal(server.page.data.detail.source.original_url, 'https://example.test/source')

  const bundled = fixture('referencedetail')
  bundled.login()
  await bundled.show({ id: 'gy-i07-hb-001' })
  assert.equal(bundled.page.data.sourceDateLabel, '采集日期', '随包路径保留原标签，两来源不得混用标签')
  assert.equal(bundled.page.data.dataSource, 'bundled-offline')
  assert.equal(bundled.detailCalls().length, 0)
})
