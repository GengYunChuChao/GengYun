// C4（#7）：科普／除草剂「来源名称 + 来源标识 + 来源版本」在四页上如实展示的回归。
//
// 背景（本片核过的缺口）：`SourceRef` 的 `version` 四页本来就在展示，但
//   1) 除草剂服务端行映射 `knowledgeApi.herbicideRow()` 把 `source.id`／`publisher`／`title` 丢掉，
//      列表页因此**没有任何来源名称**可展示（只有一串 `source_version`）；
//   2) 详情页 `referencedetail.js` 的 `source` 槽位同样丢掉 `src.id`，列表与详情无法按来源标识对照；
//   3) 随包离线副本 `utils/reference.js` 的 `listItem()` 把来源压成一个 `source_version`，
//      登记表里**真实存在**的 publisher／title（`miniprogram/data/sources.js`）没被用上。
//
// 判据：只用契约／登记数据里的真实字段，缺项显示可解释占位「接口未提供」，**不补写、不推断**。
// 夹具在 vm 里装载真实页面与真实 `utils/knowledge-api.js`、真实 `utils/reference.js`；
// `wx.request` 只入队、由用例显式回放（零真实网络）。身份与来源均为合成数据。
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
const VERSION = 'synthetic-herbicide-v1'
const PUBLISHER = '测试发布方'
const SOURCE_TITLE = '合成来源（测试）'
const UPDATED_AT = '2026-10-11T01:00:00Z'

const source = (patch = {}) => ({
  id: SOURCE_ID, version: VERSION, title: SOURCE_TITLE, url: 'https://example.test/source',
  publisher: PUBLISHER, source_kind: 'simulation', evidence_kind: 'research',
  validity: 'valid', review_status: 'unverified', updated_at: UPDATED_AT, ...patch
})
const herbicide = (patch = {}) => ({
  id: RECORD_ID, revision: 1,
  formulation: {
    id: FORMULATION_ID, registration_number: 'PD2026-SYN-0001', producer: '合成生产方',
    dosage_form: '悬浮剂', ingredients: [{ name: '合成成分甲', content_text: '20', unit_text: '克/升' }]
  },
  source: source(), risk_text: '合成风险说明，不作为用药依据。', reference_state: 'available', ...patch
})
const envelope = (data, mode = 'stub') => ({
  data, meta: { request_id: '55555555-5555-4555-8555-555555555555', contract_version: '1.0.0', execution_mode: mode }
})
const flush = () => new Promise((r) => setImmediate(r))
const settle = async () => { await flush(); await flush() }
const read = (p) => readFileSync(resolve(root, p), 'utf8')

/** 夹具：真页面 + 真客户端，受控 HTTP 回放（与 miniprogram-herbicides-client.test.mjs 同形）。 */
function fixture(name) {
  const requests = [], storage = new Map(), cache = new Map()
  const runtime = { mode: 'local', apiBaseUrl: BASE }
  let page = null
  const wx = {
    request: (o) => requests.push(o),
    login: (o) => o.success({ code: 'synthetic-code' }),
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.delete(k),
    reLaunch: (o) => { o.success && o.success() },
    navigateTo: (o) => { o.success && o.success() },
    redirectTo: (o) => { o.success && o.success() },
    navigateBack: () => {},
    setClipboardData: () => {},
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
  const referenceUtils = load(resolve(root, 'utils/reference.js'))
  if (name) load(resolve(root, 'pages/' + name + '/' + name + '.js'))

  const pending = (path) => requests.filter((r) => !r._done && r.url.includes(path)).at(-1)
  function answer(r, data, status = 200, mode = 'stub') {
    assert.ok(r, 'expected a pending request to answer')
    r._done = true
    r.success({ statusCode: status, data: envelope(data, mode) })
  }
  function login() {
    auth.login(() => {})
    const r = pending('/auth/wechat')
    assert.ok(r, '登录桩应发出 /auth/wechat')
    answer(r, { access_token: 'synthetic-token', audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() })
  }
  async function show(options = {}) {
    page.options = options
    page.onLoad(options)
    page.onShow()
    for (let i = 0; i < 4; i += 1) {
      const session = pending('/auth/session')
      if (session) answer(session, { audience: 'user', expires_at: new Date(Date.now() + 3600000).toISOString() })
      const profile = pending('/me/profile')
      if (profile) answer(profile, { crop_id: null, region_code: null, region_catalog_version: null, revision: 1 })
      await settle()
    }
    return page
  }
  return { page: () => page, wx, auth, api, referenceUtils, runtime, requests, pending, answer, login, show, load }
}

// ── A 服务端路径：SourceRef 的 id／publisher／title 原样透传并上屏 ─────────────────

test('A1 服务端行：来源 id／发布机构／标题原样透传，展示串只由这两段真实字段拼接', () => {
  const f = fixture(null)
  const row = f.api.herbicideRow(herbicide())
  assert.equal(row.source_id, SOURCE_ID, '来源标识必须取 SourceRef.id，不得留空或另造')
  assert.equal(row.source_publisher, PUBLISHER)
  assert.equal(row.source_title, SOURCE_TITLE)
  assert.equal(row.source_name, PUBLISHER + ' · ' + SOURCE_TITLE, '展示串必须是 publisher · title，不加入任何推断内容')
  assert.equal(row.source_version, VERSION, '既有 source_version 语义不变')
})

test('A2 页面：列表页与详情页展示同一个来源标识、来源名称与来源版本', async () => {
  const list = fixture('reference')
  list.login()
  await list.show()
  const listRequest = list.pending('/herbicides')
  assert.ok(listRequest, '列表页应请求 /herbicides')
  list.answer(listRequest, { items: [herbicide()], next_cursor: null })
  await settle()
  const row = list.page().data.items[0]
  assert.equal(row.source_id, SOURCE_ID)
  assert.equal(row.source_name, PUBLISHER + ' · ' + SOURCE_TITLE)
  assert.equal(row.source_version, VERSION)
  // 既有口径不回归：列表页顶部「来源版本」提示仍取首行 source_version。
  assert.equal(list.page().data.sourceVersionNote, VERSION)

  const detail = fixture('referencedetail')
  detail.login()
  await detail.show({ id: RECORD_ID })
  const detailRequest = detail.pending('/herbicides/' + RECORD_ID)
  assert.ok(detailRequest, '详情页应请求 /herbicides/{id}')
  detail.answer(detailRequest, herbicide())
  await settle()
  const d = detail.page().data.detail
  assert.equal(d.source.id, SOURCE_ID, '详情页必须能展示来源标识（此前 src.id 被丢弃）')
  assert.equal(d.source.name, PUBLISHER + ' · ' + SOURCE_TITLE)
  assert.equal(d.source.publisher, PUBLISHER)
  assert.equal(d.source.title, SOURCE_TITLE, 'SourceRef.title 原样保留（不等于期号）')
  assert.equal(d.source_version, row.source_version, '列表与详情必须展示同一个 source_version')
})

// ── B 随包离线路径：来源名称取自登记表，列表 = 详情 ────────────────────────────────

test('B1 随包行：来源名称/标识来自登记表，逐条与登记数据一致（不编造）', () => {
  const f = fixture(null)
  const sources = new Map(f.load(resolve(root, 'data/sources.js')).sources.map((s) => [s.id, s]))
  const byId = new Map(f.load(resolve(root, 'data/records-2026.js')).records.map((r) => [r.record_id, r]))
  const listed = f.referenceUtils.query({ limit: 20 }).items
  assert.ok(listed.length > 0, '随包副本应至少有一条可查询记录')
  for (const row of listed) {
    const record = byId.get(row.record_id)
    const reg = sources.get(record.source.source_id)
    assert.equal(row.source_id, record.source.source_id, `${row.record_id} 来源标识必须取记录登记 id`)
    assert.equal(row.source_publisher, record.source.publisher, `${row.record_id} 发布机构必须取记录里的真实值`)
    assert.equal(row.source_title, reg.title, `${row.record_id} 来源标题必须取登记表 title，不得留空或另造`)
    assert.equal(row.source_name, record.source.publisher + ' · ' + reg.title)
    assert.notEqual(row.source_version.trim(), '', '来源版本仍必须可判定')
  }
})

test('B2 随包详情：source.id／title 与列表行同源，可对照追溯', () => {
  const f = fixture(null)
  for (const row of f.referenceUtils.query({ limit: 20 }).items) {
    const d = f.referenceUtils.detail(row.record_id)
    assert.equal(d.source.id, row.source_id, `${row.record_id} 详情来源标识必须与列表行一致`)
    assert.equal(d.source.title, row.source_title, `${row.record_id} 详情来源名称必须与列表行一致`)
    assert.equal(d.source.name, row.source_name)
    assert.equal(d.source_version, row.source_version)
    // 「期号／文件」与「来源标题」是两件事，不得互相顶替。
    assert.notEqual(d.source.issue, undefined)
  }
})

// ── C 缺项：留空 + 页面占位，绝不补写 ────────────────────────────────────────────

test('C1 缺项：未登记来源 / 无字段时返回空串，由页面显示「接口未提供」占位', () => {
  const f = fixture(null)
  const unnamed = f.referenceUtils.sourceName({ source_id: 'src_not_registered', publisher: '某未登记登记机构' })
  assert.equal(unnamed, '某未登记登记机构', '只有发布机构时不得编造来源标题')
  assert.equal(f.referenceUtils.sourceName({}), '', '两段都缺失必须返回空串（交给页面占位）')
  assert.equal(f.referenceUtils.sourceField({}, 'title'), '')
  assert.equal(f.referenceUtils.sourceField({}, 'publisher'), '')
  assert.equal(f.referenceUtils.sourceField({ source_id: 'src_not_registered' }, 'title'), '')
})

// ── D WXML：四处展示点仍渲染来源名称／标识／版本，缺项占位在位 ────────────────────

test('D1 科普四页：来源名称／标识／版本与占位文案都在 WXML 里（结构回退守卫）', () => {
  const knowledgeList = read('pages/knowledge/knowledge.wxml')
  assert.ok(knowledgeList.includes('来源：{{item.item.source.publisher}} · {{item.item.source.title}}'), '科普列表必须展示来源名称')
  assert.ok(knowledgeList.includes('来源版本：{{item.item.source.version}}'), '科普列表必须展示来源版本')

  const knowledgeDetail = read('pages/knowledgedetail/knowledgedetail.wxml')
  assert.ok(knowledgeDetail.includes('{{item.source.publisher}} · {{item.source.title}}'), '科普详情必须展示来源名称')
  assert.ok(knowledgeDetail.includes('来源版本</view><view class="stat-value">{{item.source.version}}'), '科普详情必须展示来源版本')
  assert.ok(knowledgeDetail.includes('来源标识：{{item.source.id || \'契约未提供\'}}'), '科普详情必须展示来源标识并带占位')

  const referenceList = read('pages/reference/reference.wxml')
  assert.ok(referenceList.includes('来源：{{item.source_name || \'接口未提供\'}}'), '除草剂列表必须展示来源名称并带占位')
  assert.ok(referenceList.includes('来源标识：{{item.source_id || \'接口未提供\'}}'), '除草剂列表必须展示来源标识并带占位')
  assert.ok(referenceList.includes('来源版本：{{item.source_version || \'接口未提供\'}}'), '除草剂列表必须展示来源版本并带占位')

  const referenceDetail = read('pages/referencedetail/referencedetail.wxml')
  assert.ok(referenceDetail.includes('来源名称</text><text class="v">{{detail.source.name || \'接口未提供\'}}'), '除草剂详情必须展示来源名称并带占位')
  assert.ok(referenceDetail.includes('来源标识</text><text class="v mono">{{detail.source.id || \'接口未提供\'}}'), '除草剂详情必须展示来源标识并带占位')
  assert.ok(referenceDetail.includes('来源版本</text><text class="v mono">{{detail.source_version}}'), '除草剂详情必须展示来源版本')
})
