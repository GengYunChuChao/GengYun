/**
 * GY-I11 **客户端转写核对**回归（stub/preset_demo 局部实现）。
 *
 * 被测对象是**仓库里的真代码**（`miniprogram/utils/speech-transcript.js` 与
 * `miniprogram/pages/voice/voice.js`，经 vm 注入依赖加载），传输层是可完全观测的假 `wx.request`
 * （逐请求记录 method/path/header/body，可按路由脚本化响应，并可把某个响应扣在途）。
 *
 * 分层（每层都可单独指出）：
 *   A. 契约闭集校验：Transcription 七键 / Job 九键 / Ack / Conversation / TargetRef 的负例；
 *   B. 发送闸门（纯函数）：未确认／已取消／操作作废／记录缺失／版本不符／服务端未确认 ⇒ 不外发；
 *   C. 幂等键：同一尝试（同正文同 revision）的重试复用同一把键，改正文即换键；
 *   D. 页面·未确认不外发：记录就绪前／空草稿 ⇒ 零 PATCH、零轮次请求；
 *   E. 页面·确认后发送全链路：请求形状（If-Match、幂等键、两字段/四字段闭集体）逐项核对；
 *   F. 页面·重试身份：发送结果未知 ⇒ 同键重发、**零新增确认**（服务端 revision 不推进）；
 *      改正文/版本变化 ⇒ 新尝试（新确认键、新 revision、新发送键）；
 *   G. 页面·双击与在途取消：在途确认期间再点 ⇒ 一次请求；受理在途取消 ⇒ 迟到 202 零外发；
 *   H. 页面·版本冲突重读（确认与发送两条路径）：撞 409 ⇒ 按服务端最新记录刷新，
 *      "他人已确认"不得自动发送；转写侧已变 ⇒ 新尝试，会话侧冲突 ⇒ 同一把发送键可重试；
 *   I. 页面·取消与迟到回调不得外发：取消先关闸门再 DELETE；迟到响应不改状态、不触发发送；
 *   J. 页面·迟到轮询不冲掉已确认快照（revision 只进不退）；
 *   K. 页面·失败终态不得外发：截止时间内取不到记录 ⇒ 如实失败、零轮次请求；
 *   L. 页面·离页作废：离页后迟到响应零外发、不改 UI。
 *
 * 边界（如实标注）：
 * - **不触达任何真实服务**：全部响应由假 transport 脚本化；不发起外网请求、不连接数据库；
 * - **不产生、不声称任何 ASR 效果**：替身文本是夹具，不构成识别效果或准确率证据；
 * - 服务端同键回放语义由 `tests/integration/transcript-confirm-http.mjs` 对真实装配 app 断言，
 *   本文件只锁客户端形状与闸门。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const requireHere = createRequire(import.meta.url);
// GY-I04 登录链路盘点：转写链路把 401/403 归因委托给 `utils/auth.js`（单一事实源）。
// 这里注入**真实**归因实现（纯码表判定），不在测试里另写一份 403 码表。
const realAuth = requireHere(join(ROOT, 'miniprogram/utils/auth.js'));

/** 合成转写正文（夹具；与真实 ASR 无关）。 */
const RAW_TEXT = '替身示例·合成转写（非真实录音）：稻田稗草三到五叶期，请问题应该用什么药。'
const EDITED_TEXT = '稻田稗草三到五叶期，请问题应该用什么药？（用户已校对）'

// ============================================================ 夹具

function metaFixture(mode) {
  return { request_id: randomUUID(), contract_version: '1.0.0', execution_mode: mode || 'stub' }
}

/** 契约 `Job`（kind=transcription，九键）。 */
function transcriptionJobFixture(transcriptionId, deadlineAt) {
  return {
    id: randomUUID(),
    revision: 1,
    kind: 'transcription',
    target_ref: { type: 'transcription', id: transcriptionId, revision: 1 },
    state: 'queued',
    deadline_at: deadlineAt,
    created_at: new Date().toISOString(),
    error_code: null,
    result: null
  }
}

/** 契约 `Transcription`（七键）。 */
function recordFixture(transcriptionId, overrides) {
  const base = {
    id: transcriptionId,
    revision: 1,
    raw_text: RAW_TEXT,
    uncertain_spans: [
      { start: 0, end: 8, reason: '替身示例·开头为合成前缀，非真实语音内容' },
      { start: 24, end: 26, reason: '替身示例·生育期表述可能识别偏差' }
    ],
    confirmed_text: null,
    confirmed_at: null,
    model_version: 'stub-v1'
  }
  return Object.assign(base, overrides || {})
}

/** 契约 `Job`（kind=answer，九键；target_ref 指向轮次）。 */
function answerJobFixture(turnId) {
  return {
    id: randomUUID(),
    revision: 1,
    kind: 'answer',
    target_ref: { type: 'answer', id: turnId, revision: 1 },
    state: 'queued',
    deadline_at: new Date(Date.now() + 30000).toISOString(),
    created_at: new Date().toISOString(),
    error_code: null,
    result: null
  }
}

// ============================================================ 假传输层

/**
 * 可脚本化的假 `wx.request`：逐请求记录，按 (method, path) 路由响应；
 * 路由处理器可返回 `{status, data, headers}` 或一个**在途** Promise（由用例决定何时兑现）。
 */
function createHttp() {
  const calls = [];
  const routes = [];
  return {
    calls: calls,
    routes: routes,
    on: function (method, path, handler) { routes.push({ method: method, path: path, handler: handler }) },
    find: function (method, path) { return calls.filter((c) => c.method === method && c.path === path) },
    handle: function (call) {
      const route = routes.filter((r) => r.method === call.method && r.path === call.path)[0]
      if (route === undefined) return Promise.resolve({ status: 404, data: { error: { code: 'NOT_FOUND' } } })
      return Promise.resolve(route.handler(call))
    }
  }
}

function fakeWx(http, options) {
  const opts = options || {}
  return {
    request: function (o) {
      const call = { method: o.method, path: new URL(o.url).pathname, header: o.header, data: o.data, raw: o }
      http.calls.push(call)
      http.handle(call).then(function (res) {
        if (o.success) o.success({ statusCode: res.status, data: res.data, header: res.headers || {} })
      }).catch(function () { if (o.fail) o.fail({}) })
    },
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    showToast: () => {},
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getSetting: function (o) { if (o && o.success) o.success({ authSetting: { 'scope.record': true } }) },
    getRecorderManager: function () { return opts.recorder || { start: () => {}, stop: () => {}, onStop: () => {}, onError: () => {} } },
    getFileSystemManager: function () { return { readFile: function (o) { if (o && o.success) o.success({ data: 'SYNTHETIC' }) } } },
    getFileInfo: function (o) { if (o && o.success) o.success({ size: 4096, digest: 'a'.repeat(64) }) }
  }
}

// ============================================================ vm 加载器（真代码 + 注入依赖）

/**
 * 在受控环境里加载**真实**模块（页面与工具都是仓库里的真代码，依赖按名注入）。
 *
 * 与 `tests/unit/miniprogram-voice-playback.test.mjs` 同口径；本文件只注入转写链路需要的依赖，
 * 并让轮询节流可调（`pollIntervalMs`，只改等待时长、不改任何语义）。
 */
function createLoader(wxApi, options) {
  const opts = options || {}
  const cache = new Map()
  const auth = {
    isLoggedIn: () => true,
    getSession: () => ({ accessToken: 'synthetic-token' }),
    sessionEpoch: () => 'epoch-1',
    networkEnabled: () => true,
    requireLogin: (callback) => callback(true),
    clearSession: () => {},
    // 401/403 归因用**真实**实现（`utils/auth.js` 的单一事实源），本文件不另写码表；
    // 清会话在 vm 内是空操作，本文件的用例不断言清会话次数。
    attribution: (statusCode, payload) => realAuth.attribution(statusCode, payload),
    failureFor: (makeFailure, statusCode, payload) => realAuth.failureFor(makeFailure, statusCode, payload)
  }
  const runtime = { mode: 'local', apiBaseUrl: 'http://127.0.0.1:3100/api/v1' }
  const debug = { localEnabled: (wxApi2) => runtime.mode === 'local' && !!wxApi2 && typeof wxApi2.getAccountInfoSync === 'function' }
  const pageGate = { start: (page, callback) => callback(true), cancel: () => {} }
  const fontScale = { applyFontScale: () => {}, currentFontScale: () => 1, DEFAULT_FONT_SCALE: 1 }
  const identifyApi = {
    VOICE_MEDIA_PURPOSE: 'voice_question',
    serverMode: () => Promise.resolve(opts.serverMode === undefined ? 'stub' : opts.serverMode),
    uploadVoiceQuestion: () => Promise.resolve({ mediaId: randomUUID(), mediaRevision: 1 })
  }

  function loadReal(file, resolveDep) {
    if (cache.has(file)) return cache.get(file)
    const source = readFileSync(file, 'utf8')
    const module = { exports: {} }
    cache.set(file, module.exports)
    const wrapper = vm.compileFunction(source, ['module', 'exports', 'require', '__filename', '__dirname'], { filename: file })
    wrapper(module, module.exports, resolveDep, file, dirname(file))
    cache.set(file, module.exports)
    return module.exports
  }

  const bySuffix = (suffix) => join(ROOT, 'miniprogram', 'utils', suffix)
  const resolveDep = (id) => {
    const base = id.split('/').pop()
    if (id === './auth' || id === '../config/runtime') return id === './auth' ? auth : runtime
    if (base === 'auth') return auth
    if (base === 'debug') return debug
    if (base === 'runtime') return runtime
    if (base === 'page-gate') return pageGate
    if (base === 'font-scale') return fontScale
    if (base === 'identify-api') return identifyApi
    if (base === 'speech-text') return loadReal(bySuffix('speech-text.js'), resolveDep)
    if (base === 'audio-playback') return loadReal(bySuffix('audio-playback.js'), resolveDep)
    if (base === 'inner-audio-port') return loadReal(bySuffix('inner-audio-port.js'), resolveDep)
    if (base === 'substitute-player') return loadReal(bySuffix('substitute-player.js'), resolveDep)
    if (base === 'voice-api') return loadReal(bySuffix('voice-api.js'), resolveDep)
    if (base === 'recorder-port') return loadReal(bySuffix('recorder-port.js'), resolveDep)
    if (base === 'speech-transcript') return loadReal(bySuffix('speech-transcript.js'), resolveDep)
    // R28-C6（#13）：播报页新增 `require('../../utils/speech-autoplay')`（自动播报策略：
    // 同页同版本只播一次 + 用户开关）。它是纯函数模块、无依赖，直接加载真实实现，
    // 这样本套用例仍然跑的是真实页面代码，而不是把新依赖桩掉。
    if (base === 'speech-autoplay') return loadReal(bySuffix('speech-autoplay.js'), resolveDep)
    throw new Error('unexpected require: ' + id)
  }
  return { loadReal: loadReal, resolveDep: resolveDep, auth: auth, runtime: runtime }
}

/** 只加载转写模块（模块级用例：不需要页面）。 */
function loadTranscriptModule() {
  const loader = createLoader(null, {})
  const module = loader.loadReal(join(ROOT, 'miniprogram/utils/speech-transcript.js'), loader.resolveDep)
  return module
}

/** 把在途 promise 链推到底（`setImmediate` 之间微任务会被排干）。 */
async function flushMicrotasks(rounds) {
  for (let i = 0; i < (rounds || 10); i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** 等待轮询定时器落一拍（默认节流被压到 5ms，只等时长、不等语义）。 */
async function settle(ms) {
  await flushMicrotasks()
  await new Promise((resolve) => setTimeout(resolve, ms === undefined ? 40 : ms))
}

/**
 * **有界轮询等待**：条件成立才返回，超时抛错（错误里带等了多久、上限多少）。
 *
 * 为什么必需：本文件用「把 GET 响应扣在途」制造"记录未就绪"的窗口，而页面的第一拍 GET 是由
 * `setInterval(POLL_INTERVAL_MS)` 的**定时器宏任务**驱动——`miniprogram/pages/voice/voice.js`
 * `startTranscriptPoll` 里 `setInterval(...)` 登记回调，回调里才 `refreshTranscript` 发出 GET。
 * `flushMicrotasks`／`settle` 只排干微任务与 `setImmediate`，**不保证**该定时器已到期
 * （机器快时 2 拍 `setImmediate` 只跑 ~2ms，早于 5ms 的第一拍）⇒ 用固定拍数等待会读到 `null`。
 */
async function waitFor(predicate, options) {
  const opts = options || {}
  const timeoutMs = opts.timeoutMs === undefined ? 2000 : opts.timeoutMs
  const intervalMs = opts.intervalMs === undefined ? 2 : opts.intervalMs
  const started = Date.now()
  while (predicate() !== true) {
    const waited = Date.now() - started
    if (waited >= timeoutMs) {
      throw new Error((opts.message || '等待条件超时') + '：已等 ' + waited + 'ms（上限 ' + timeoutMs + 'ms）')
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * 起一个带假传输的播报页（真实页面代码）。
 *
 * 返回 `{ page, http, transcript, transcriptionId, paths }`；测试经 `page.onXxx` 驱动，
 * 经 `http.calls` 观测每一个真实发出的请求。
 */
function bootTranscriptPage(options) {
  const opts = options || {}
  const http = createHttp()
  const wx = fakeWx(http, opts)
  const loader = createLoader(wx, opts)
  const transcriptionId = randomUUID()
  const conversationId = randomUUID()
  const turnId = randomUUID()
  const paths = {
    create: '/api/v1/speech/transcriptions',
    record: '/api/v1/speech/transcriptions/' + transcriptionId,
    confirm: '/api/v1/speech/transcriptions/' + transcriptionId + '/confirmation',
    conversations: '/api/v1/conversations',
    turns: '/api/v1/conversations/' + conversationId + '/turns'
  }
  // 默认路由：全部 200/202 成功形状（用例可逐条覆盖）。
  const deadline = new Date(Date.now() + (opts.deadlineInMs === undefined ? 30000 : opts.deadlineInMs)).toISOString()
  // 存储层状态（与服务端同语义建模）：确认态 + 轮次态。
  // - PATCH 确认按 `confirmTranscription`：同键同体 ⇒ 回放首次结果（**不**推进 revision）；
  //   同键异体 ⇒ 409 `IDEMPOTENCY_CONFLICT`；新键 + If-Match 不符 ⇒ 409 `REVISION_CONFLICT`；
  //   新键 + If-Match 相符 ⇒ revision + 1（并把读面推进到确认态）。
  // - 读面如实反映存储层：确认后 GET 返回确认后的 revision / confirmed_text。
  // （早期夹具「PATCH 恒返 revision 2、GET 恒返未确认态」会把「重试时又确认一次」的真实后果
  //   掩盖掉：那会以新键推进 revision、连带换掉发送键——正是 GY-I11 P2。故此处必须同语义。）
  const confirmState = { revision: 1, latest: null, byKey: new Map() }
  http.on('POST', paths.create, () => ({ status: 202, data: { data: transcriptionJobFixture(transcriptionId, deadline), meta: metaFixture(opts.mode) }, headers: { ETag: '"1"' } }))
  http.on('GET', paths.record, () => {
    const projection = confirmState.latest === null ? (opts.recordOverrides || {}) : confirmState.latest
    return {
      status: 200,
      data: { data: recordFixture(transcriptionId, projection), meta: metaFixture(opts.mode) },
      headers: { ETag: '"' + (projection.revision === undefined ? 1 : projection.revision) + '"' }
    }
  })
  http.on('PATCH', paths.confirm, (call) => {
    const key = call.header['Idempotency-Key']
    const seen = confirmState.byKey.get(key)
    if (seen !== undefined) {
      if (seen.confirmed_text !== call.data.confirmed_text || seen.ifMatch !== call.header['If-Match']) {
        return { status: 409, data: { error: { code: 'IDEMPOTENCY_CONFLICT' } }, meta: metaFixture(opts.mode) }
      }
      return {
        status: 200,
        data: { data: recordFixture(transcriptionId, { revision: seen.revision, confirmed_text: seen.confirmed_text, confirmed_at: seen.confirmed_at }), meta: metaFixture(opts.mode) },
        headers: { ETag: '"' + seen.revision + '"' }
      }
    }
    if (call.header['If-Match'] !== '"' + confirmState.revision + '"') {
      return { status: 409, data: { error: { code: 'REVISION_CONFLICT' } }, meta: metaFixture(opts.mode) }
    }
    const applied = { revision: confirmState.revision + 1, confirmed_text: call.data.confirmed_text, confirmed_at: new Date().toISOString() }
    confirmState.revision = applied.revision
    confirmState.latest = applied
    confirmState.byKey.set(key, { revision: applied.revision, confirmed_text: applied.confirmed_text, confirmed_at: applied.confirmed_at, ifMatch: call.header['If-Match'] })
    return { status: 200, data: { data: recordFixture(transcriptionId, applied), meta: metaFixture(opts.mode) }, headers: { ETag: '"' + applied.revision + '"' } }
  })
  http.on('DELETE', paths.record, () => ({ status: 202, data: { data: { accepted: true }, meta: metaFixture(opts.mode) } }))
  http.on('POST', paths.conversations, () => ({ status: 201, data: { data: { id: conversationId, revision: 1, conditions: null, created_at: new Date().toISOString() }, meta: metaFixture(opts.mode) }, headers: { ETag: '"1"' } }))
  // 发送轮次：同一把键 ⇒ 回放同一任务（不建第二条轮次）；新键 ⇒ 新任务。
  const turnState = { byKey: new Map() }
  http.on('POST', paths.turns, (call) => {
    const key = call.header['Idempotency-Key']
    const seen = turnState.byKey.get(key)
    if (seen !== undefined) return { status: 202, data: { data: seen, meta: metaFixture(opts.mode) }, headers: { ETag: '"' + seen.revision + '"' } }
    const job = answerJobFixture(randomUUID())
    turnState.byKey.set(key, job)
    return { status: 202, data: { data: job, meta: metaFixture(opts.mode) }, headers: { ETag: '"1"' } }
  })

  const transcript = loader.loadReal(bySuffixOf('speech-transcript.js'), loader.resolveDep)
  // 轮询节流：只把 1s 压到 5ms（等待时长），语义（边界/守卫/迟到判定）不变。
  transcript.POLL_INTERVAL_MS = 5

  globalThis.wx = wx
  let definition = null
  globalThis.Page = (value) => { definition = value }
  try {
    loader.loadReal(join(ROOT, 'miniprogram/pages/voice/voice.js'), loader.resolveDep)
  } finally {
    delete globalThis.Page
  }
  assert.ok(definition, '播报页必须注册 Page')
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch) },
    route: 'pages/voice/voice'
  })
  page.onLoad()
  page.onShow()
  return { page: page, http: http, transcript: transcript, transcriptionId: transcriptionId, conversationId: conversationId, turnId: turnId, paths: paths }

  function bySuffixOf(name) { return join(ROOT, 'miniprogram/utils', name) }
}

/** 选替身样本 → 受理转写 → 等记录就绪（happy path 的公共前缀）。 */
async function readyTranscript(harness) {
  harness.page.onPickTranscriptSample({ currentTarget: { dataset: { id: 'sample-i11-normal' } } })
  await harness.page.onRequestTranscript()
  await settle()
  assert.equal(harness.page.data.transcriptStage, 'ready', '轮询后应进入 ready')
  return harness
}

// ============================================================ A. 契约闭集校验（负例）

test('契约·Transcription 七键闭集：缺键/多键/类型错/同生同灭被违反一律 INVALID_RESPONSE', () => {
  const m = loadTranscriptModule()
  const id = randomUUID()
  const good = recordFixture(id)
  assert.equal(m.validateTranscription(good).id, id, '合法记录必须通过')
  const bad = [
    ['缺一键', (() => { const r = Object.assign({}, good); delete r.model_version; return r })()],
    ['多一键', Object.assign({}, good, { extra: 1 })],
    ['revision 0', Object.assign({}, good, { revision: 0 })],
    ['raw_text 非字符串', Object.assign({}, good, { raw_text: 42 })],
    ['raw_text 超长', Object.assign({}, good, { raw_text: 'x'.repeat(8001) })],
    ['confirmed_text 空串', Object.assign({}, good, { confirmed_text: '' })],
    ['confirmed 同生同灭被违反', Object.assign({}, good, { confirmed_text: '有', confirmed_at: null })],
    ['span 多键', Object.assign({}, good, { uncertain_spans: [{ start: 0, end: 1, reason: 'r', extra: 1 }] })],
    ['span 区间负值', Object.assign({}, good, { uncertain_spans: [{ start: -1, end: 1, reason: 'r' }] })],
    ['model_version 空', Object.assign({}, good, { model_version: '' })]
  ]
  for (const [label, value] of bad) {
    assert.throws(() => m.validateTranscription(value), (e) => e.code === 'INVALID_RESPONSE', label + ' 必须被拒')
  }
})

test('契约·Job 九键闭集与 kind 绑定；TargetRef type 必须在闭集内', () => {
  const m = loadTranscriptModule()
  const id = randomUUID()
  const good = transcriptionJobFixture(id, new Date().toISOString())
  assert.equal(m.validateTranscriptionJob(good).kind, 'transcription')
  assert.throws(() => m.validateTranscriptionJob(Object.assign({}, good, { kind: 'answer' })), (e) => e.code === 'INVALID_RESPONSE', 'kind 不匹配必须被拒')
  assert.throws(() => m.validateTranscriptionJob(Object.assign({}, good, { state: 'weird' })), (e) => e.code === 'INVALID_RESPONSE', 'state 越界必须被拒')
  assert.throws(() => m.validateTranscriptionJob(Object.assign({}, good, { target_ref: { type: 'nope', id: id, revision: 1 } })), (e) => e.code === 'INVALID_RESPONSE', 'target_ref.type 越界必须被拒')
  const extra = Object.assign({}, good); extra.extra = 1
  assert.throws(() => m.validateTranscriptionJob(extra), (e) => e.code === 'INVALID_RESPONSE', '多键必须被拒')
  // 回答任务（target_ref.type='answer'）必须能过：发送链路的 202 就是它。
  assert.equal(m.validateAnswerJob(answerJobFixture(randomUUID())).kind, 'answer')
})

test('契约·Ack 与 Conversation 负例', () => {
  const m = loadTranscriptModule()
  assert.deepEqual(m.validateAck({ accepted: true }), { accepted: true })
  for (const value of [{ accepted: false }, {}, { accepted: true, extra: 1 }, { accepted: 'true' }]) {
    assert.throws(() => m.validateAck(value), (e) => e.code === 'INVALID_RESPONSE', JSON.stringify(value) + ' 必须被拒')
  }
  const good = { id: randomUUID(), revision: 1, conditions: null, created_at: new Date().toISOString() }
  assert.equal(m.validateConversation(good).id, good.id)
  assert.throws(() => m.validateConversation(Object.assign({}, good, { conditions: 'x' })), (e) => e.code === 'INVALID_RESPONSE', 'conditions 必须对象或 null')
  assert.throws(() => m.validateConversation(Object.assign({}, good, { revision: 0 })), (e) => e.code === 'INVALID_RESPONSE', 'revision 必须 >=1')
})

// ============================================================ B. 发送闸门（纯函数）

test('闸门·未确认/已取消/操作作废/记录缺失/版本不符/服务端未确认 ⇒ 一律不外发', () => {
  const m = loadTranscriptModule()
  const record = { revision: 2, confirmed_text: EDITED_TEXT, confirmed_at: '2026-10-16T00:00:00.000Z' }
  const confirmed = { text: EDITED_TEXT, revision: 2, at: '2026-10-16T00:00:00.000Z' }
  const cases = [
    ['已取消', { record: record, confirmed: confirmed, cancelled: true, current: true }, 'TRANSCRIPT_CANCELLED'],
    ['操作已作废', { record: record, confirmed: confirmed, cancelled: false, current: false }, 'CLIENT_CANCELLED'],
    ['尚未确认', { record: record, confirmed: null, cancelled: false, current: true }, 'NOT_CONFIRMED'],
    ['确认正文空白', { record: record, confirmed: { text: '   ', revision: 2 }, cancelled: false, current: true }, 'NOT_CONFIRMED'],
    ['记录缺失', { record: null, confirmed: confirmed, cancelled: false, current: true }, 'NOT_FOUND'],
    ['版本不符', { record: record, confirmed: { text: EDITED_TEXT, revision: 1 }, cancelled: false, current: true }, 'REVISION_CONFLICT'],
    ['服务端未确认', { record: { revision: 2, confirmed_text: null, confirmed_at: null }, confirmed: confirmed, cancelled: false, current: true }, 'NOT_CONFIRMED'],
    ['服务端正文不一致', { record: { revision: 2, confirmed_text: '别的', confirmed_at: 'x' }, confirmed: confirmed, cancelled: false, current: true }, 'REVISION_CONFLICT']
  ]
  for (const [label, input, code] of cases) {
    const gate = m.evaluateSendGate(input)
    assert.equal(gate.ok, false, label + ' 必须被拒')
    assert.equal(gate.code, code, label + ' 的码必须一致')
    assert.ok(typeof gate.message === 'string' && gate.message.length > 0, label + ' 必须给一句话')
  }
  assert.deepEqual(m.evaluateSendGate({ record: record, confirmed: confirmed, cancelled: false, current: true }), { ok: true })
})

// ============================================================ C. 幂等键

test('幂等·同一尝试复用同一把键；改正文/改版本即换键；越界长度换新键', () => {
  const m = loadTranscriptModule()
  const first = m.stableKey(null, 'confirm:a:1:正文甲', 'i11-confirm')
  assert.ok(first.length >= 8 && first.length <= 128, '键长必须在 8..128')
  assert.equal(m.stableKey({ descriptor: 'confirm:a:1:正文甲', key: first }, 'confirm:a:1:正文甲', 'i11-confirm'), first, '同尝试重试必须同键')
  assert.notEqual(m.stableKey({ descriptor: 'confirm:a:1:正文甲', key: first }, 'confirm:a:1:正文乙', 'i11-confirm'), first, '改正文必须换键')
  assert.notEqual(m.stableKey({ descriptor: 'confirm:a:1:正文甲', key: first }, 'confirm:a:2:正文甲', 'i11-confirm'), first, '改版本必须换键')
  assert.notEqual(m.stableKey({ descriptor: 'confirm:a:1:正文甲', key: 'short' }, 'confirm:a:1:正文甲', 'i11-confirm'), 'short', '非法长度的旧键不得沿用')
})

// ============================================================ D. 页面·未确认不外发

test('页面·记录就绪前与空草稿 ⇒ 零 PATCH、零轮次请求（未明确确认不外发）', async () => {
  const h = bootTranscriptPage()
  // 把记录响应扣在途：保证"就绪前"这个窗口真实存在（不让定时器抢先落地）。
  let releaseGet = null
  h.http.routes.filter((r) => r.method === 'GET' && r.path === h.paths.record)[0].handler = function () {
    return new Promise((resolve) => { releaseGet = resolve })
  }
  h.page.onPickTranscriptSample({ currentTarget: { dataset: { id: 'sample-i11-normal' } } })
  // 受理后、记录就绪前：点确认发送必须零请求。
  const pending = h.page.onRequestTranscript()
  // **必须等"GET 真的已发出"再进窗口**：第一拍 GET 由 `setInterval(POLL_INTERVAL_MS)` 的定时器
  // 宏任务驱动（`miniprogram/pages/voice/voice.js` 的 `startTranscriptPoll`），固定拍数的
  // `flushMicrotasks(2)` 只排干微任务/`setImmediate`，机器快时跑不满 5ms ⇒ 定时器还没落地、
  // `releaseGet` 仍是 `null`（CI 上的 `TypeError: releaseGet is not a function` 即此）。
  // 此处有界等待，超时即带上下文失败，不会把"没等到"当成"没请求"。
  await waitFor(() => releaseGet !== null, {
    timeoutMs: 2000,
    message: '记录 GET 应已发出并把响应扣在途（5ms 轮询拍未落地）'
  })
  assert.equal(h.page.data.transcriptStage, 'pending', '窗口正确：记录响应在途时应停在 pending')
  h.page.onConfirmAndSend()
  await flushMicrotasks(2)
  assert.equal(h.http.find('PATCH', h.paths.confirm).length, 0, '未取得记录不得确认')
  assert.equal(h.http.find('POST', h.paths.turns).length, 0, '未确认不得发送轮次')
  releaseGet({ status: 200, data: { data: recordFixture(h.transcriptionId), meta: metaFixture() }, headers: { ETag: '"1"' } })
  await pending
  await settle()
  assert.equal(h.page.data.transcriptStage, 'ready')

  // 空草稿：点确认发送仍然零请求，并如实说明。
  h.page.setData({ transcriptDraft: '   ' })
  h.page.onConfirmAndSend()
  await flushMicrotasks(2)
  assert.equal(h.http.find('PATCH', h.paths.confirm).length, 0, '空草稿不得确认')
  assert.equal(h.http.find('POST', h.paths.turns).length, 0, '空草稿不得发送')
  assert.match(h.page.data.transcriptNote, /不确认、不发送/)
  h.page.onUnload()
})

// ============================================================ E. 页面·确认后发送全链路

test('页面·核对并发送全链路：请求形状逐项核对（If-Match/幂等键/闭集体/确认后 revision）', async () => {
  const h = bootTranscriptPage()
  await readyTranscript(h)
  h.page.setData({ transcriptDraft: EDITED_TEXT })
  await h.page.onConfirmAndSend()

  // 第一段：PATCH 确认（两字段闭集体 + If-Match 取读面 revision + 幂等键）。
  const patches = h.http.find('PATCH', h.paths.confirm)
  assert.equal(patches.length, 1, '恰好一次确认请求')
  assert.deepEqual(Object.keys(patches[0].data).sort(), ['confirmation', 'confirmed_text'], '确认体必须恰是契约两字段')
  assert.equal(patches[0].data.confirmation, 'checked_and_sendable', 'confirmation 必须是契约常量')
  assert.equal(patches[0].data.confirmed_text, EDITED_TEXT, '确认的必须是用户编辑后的正文')
  assert.equal(patches[0].header['If-Match'], '"1"', 'If-Match 必须取自读面 revision')
  assert.ok(patches[0].header['Idempotency-Key'].length >= 8, '确认必须带幂等键')

  // 第二段：建会话 + 发轮次（四字段闭集体 + 会话 revision 的 If-Match + 确认后的 revision）。
  assert.equal(h.http.find('POST', h.paths.conversations).length, 1, '恰好一次建会话')
  const turns = h.http.find('POST', h.paths.turns)
  assert.equal(turns.length, 1, '恰好一次轮次请求')
  assert.deepEqual(Object.keys(turns[0].data).sort(), ['confirmed', 'input_type', 'transcription_id', 'transcription_revision'], '轮次体必须恰是契约四字段')
  assert.equal(turns[0].data.input_type, 'speech')
  assert.equal(turns[0].data.confirmed, true)
  assert.equal(turns[0].data.transcription_id, h.transcriptionId)
  assert.equal(turns[0].data.transcription_revision, 2, '必须发送确认成功后的 revision')
  assert.equal(turns[0].header['If-Match'], '"1"', 'If-Match 必须绑会话 revision')
  assert.ok(turns[0].header['Idempotency-Key'].length >= 8, '发送必须带幂等键')

  assert.equal(h.page.data.transcriptStage, 'sent')
  assert.equal(h.page.data.sendJobId, h.http.find('POST', h.paths.turns)[0] ? h.page.data.sendJobId : null)
  assert.ok(h.page.data.sendJobId.length > 0, '必须回报回答任务 id')
  assert.match(h.page.data.transcriptNote, /已发送/)
  h.page.onUnload()
})

// ============================================================ F. 页面·重试身份：网络未确认同键重发；改正文即新尝试

test('页面·发送结果未知后重试：零新增确认（revision 不推进）、同一把发送键、服务端零新轮次', async () => {
  const h = bootTranscriptPage()
  await readyTranscript(h)
  h.page.setData({ transcriptDraft: EDITED_TEXT })
  // 第一次发送走网络失败通道 ⇒ 结果未知（服务端可能已受理、也可能没有）。
  let failNextTurn = true
  const realTurn = h.http.routes.filter((r) => r.method === 'POST' && r.path === h.paths.turns)[0].handler
  h.http.routes.filter((r) => r.method === 'POST' && r.path === h.paths.turns)[0].handler = function (call) {
    if (failNextTurn) { failNextTurn = false; return new Promise((_resolve, reject) => reject(new Error('network down'))) }
    return realTurn(call)
  }
  await h.page.onConfirmAndSend()
  assert.equal(h.page.data.transcriptStage, 'ready', '发送结果未知必须回到 ready（不谎称已发送）')
  assert.equal(h.http.find('PATCH', h.paths.confirm).length, 1, '首次只应确认一次')
  const firstSendKey = h.http.find('POST', h.paths.turns)[0].header['Idempotency-Key']

  // 重试（正文与 revision 均未变）：**不得再确认**——再确认会以新键把服务端 revision 推到 3，
  // 发送描述符随之变化 ⇒ 换新发送键 ⇒ 服务端把重发当成另一笔（重复轮次）。GY-I11 P2 即此。
  await h.page.onConfirmAndSend()
  assert.equal(h.http.find('PATCH', h.paths.confirm).length, 1, '重试不得再次确认（不新增 revision）')
  const turns = h.http.find('POST', h.paths.turns)
  assert.equal(turns.length, 2)
  assert.equal(turns[1].header['Idempotency-Key'], firstSendKey, '重试必须复用同一把发送键')
  assert.equal(turns[1].data.transcription_revision, 2, '重试必须仍绑定已确认的 revision')
  assert.equal(h.page.data.transcriptStage, 'sent')
  // 服务端视角（经客户端读面）：确认态仍停在 revision 2，没有第二次写入。
  const reread = await h.transcript.getTranscription(h.transcriptionId)
  assert.equal(reread.record.revision, 2, '服务端记录 revision 必须仍为 2')
  assert.equal(reread.record.confirmed_text, EDITED_TEXT)
  h.page.onUnload()
})

test('页面·发送失败后改正文再重试 ⇒ 新尝试：新确认键、新 revision、新发送键', async () => {
  const h = bootTranscriptPage()
  await readyTranscript(h)
  h.page.setData({ transcriptDraft: EDITED_TEXT })
  let failNextTurn = true
  const realTurn = h.http.routes.filter((r) => r.method === 'POST' && r.path === h.paths.turns)[0].handler
  h.http.routes.filter((r) => r.method === 'POST' && r.path === h.paths.turns)[0].handler = function (call) {
    if (failNextTurn) { failNextTurn = false; return new Promise((_resolve, reject) => reject(new Error('network down'))) }
    return realTurn(call)
  }
  await h.page.onConfirmAndSend()
  assert.equal(h.page.data.transcriptStage, 'ready')
  const firstSendKey = h.http.find('POST', h.paths.turns)[0].header['Idempotency-Key']

  // 正文变化 ⇒ 新尝试：重新确认（新键、If-Match 基于已确认 revision）⇒ 新 revision ⇒ 新发送键。
  h.page.setData({ transcriptDraft: EDITED_TEXT + '（补充说明）' })
  await h.page.onConfirmAndSend()
  const patches = h.http.find('PATCH', h.paths.confirm)
  assert.equal(patches.length, 2, '改正文必须重新确认')
  assert.equal(patches[1].header['If-Match'], '"2"', '第二次确认必须基于已确认 revision')
  const turns = h.http.find('POST', h.paths.turns)
  assert.equal(turns.length, 2)
  assert.notEqual(turns[1].header['Idempotency-Key'], firstSendKey, '新尝试必须换新发送键')
  assert.equal(turns[1].data.transcription_revision, 3, '新尝试必须发送新 revision')
  assert.equal(h.page.data.transcriptStage, 'sent')
  h.page.onUnload()
})

test('页面·网络未能确认结果后重试：同一尝试复用同一把键（确认与发送各自）', async () => {
  const h = bootTranscriptPage()
  await readyTranscript(h)
  h.page.setData({ transcriptDraft: EDITED_TEXT })

  // 确认第一次走网络失败通道（wx.fail ⇒ NETWORK_UNCERTAIN）。
  let failNextPatch = true
  const realPatch = h.http.routes.filter((r) => r.method === 'PATCH' && r.path === h.paths.confirm)[0].handler
  h.http.routes.filter((r) => r.method === 'PATCH' && r.path === h.paths.confirm)[0].handler = function (call) {
    if (failNextPatch) { failNextPatch = false; return new Promise((_resolve, reject) => reject(new Error('network down'))) }
    return realPatch(call)
  }
  await h.page.onConfirmAndSend()
  assert.equal(h.page.data.transcriptStage, 'ready', '网络未确认必须停在 ready（不谎称已确认）')
  const firstKey = h.http.find('PATCH', h.paths.confirm)[0].header['Idempotency-Key']

  // 重试同一动作（正文/revision 未变）⇒ 同一把键。
  await h.page.onConfirmAndSend()
  const patches = h.http.find('PATCH', h.paths.confirm)
  assert.equal(patches.length, 2)
  assert.equal(patches[1].header['Idempotency-Key'], firstKey, '同尝试重试必须复用同一把键')
  assert.equal(h.page.data.transcriptStage, 'sent', '重试后应完成确认并发送')

  // 改正文再确认 ⇒ 新键（同键异体本就会被服务端判冲突）。
  h.page.setData({ transcriptStage: 'ready', transcriptDraft: EDITED_TEXT + '（再改）' })
  await h.page.onConfirmAndSend()
  const keys = h.http.find('PATCH', h.paths.confirm).map((c) => c.header['Idempotency-Key'])
  assert.notEqual(keys[keys.length - 1], firstKey, '改正文必须换新键')
  h.page.onUnload()
})

test('页面·发送网络未确认后重试：同一把发送键', async () => {
  const h = bootTranscriptPage()
  await readyTranscript(h)
  h.page.setData({ transcriptDraft: EDITED_TEXT })
  let failNextTurn = true
  const realTurn = h.http.routes.filter((r) => r.method === 'POST' && r.path === h.paths.turns)[0].handler
  h.http.routes.filter((r) => r.method === 'POST' && r.path === h.paths.turns)[0].handler = function (call) {
    if (failNextTurn) { failNextTurn = false; return new Promise((_resolve, reject) => reject(new Error('network down'))) }
    return realTurn(call)
  }
  await h.page.onConfirmAndSend()
  assert.equal(h.page.data.transcriptStage, 'ready', '发送未确认必须回到 ready（不谎称已发送）')
  const firstKey = h.http.find('POST', h.paths.turns)[0].header['Idempotency-Key']
  await h.page.onConfirmAndSend()
  const turns = h.http.find('POST', h.paths.turns)
  assert.equal(turns.length, 2)
  assert.equal(turns[1].header['Idempotency-Key'], firstKey, '同尝试重试必须复用同一把发送键')
  assert.equal(h.page.data.transcriptStage, 'sent')
  h.page.onUnload()
})

// ============================================================ G. 页面·双击守卫

test('页面·在途确认期间再次点击 ⇒ 仍然只有一次确认请求（双击被 busy 守卫挡下）', async () => {
  const h = bootTranscriptPage()
  await readyTranscript(h)
  h.page.setData({ transcriptDraft: EDITED_TEXT })
  let release = null
  h.http.routes.filter((r) => r.method === 'PATCH' && r.path === h.paths.confirm)[0].handler = function () {
    return new Promise((resolve) => { release = resolve })
  }
  const first = h.page.onConfirmAndSend()
  await flushMicrotasks(2)
  h.page.onConfirmAndSend() // 双击：在途中
  await flushMicrotasks(2)
  assert.equal(h.http.find('PATCH', h.paths.confirm).length, 1, '在途确认不得重复发起')
  assert.equal(h.http.find('POST', h.paths.turns).length, 0, '未确认不得发送')
  release({ status: 200, data: { data: recordFixture(h.transcriptionId, { revision: 2, confirmed_text: EDITED_TEXT, confirmed_at: new Date().toISOString() }), meta: metaFixture() }, headers: { ETag: '"2"' } })
  await first
  await flushMicrotasks(4)
  assert.equal(h.page.data.transcriptStage, 'sent')
  assert.equal(h.http.find('POST', h.paths.turns).length, 1, '全程只发送一次')
  h.page.onUnload()
})

// ============================================================ G. 页面·受理幂等与在途取消

test('页面·受理也按尝试固化幂等键：网络未确认后重试同一把键；落定后再转写是新尝试', async () => {
  const h = bootTranscriptPage()
  h.page.onPickTranscriptSample({ currentTarget: { dataset: { id: 'sample-i11-normal' } } })
  // 受理第一次走网络失败通道（响应丢失 ⇒ NETWORK_UNCERTAIN）。
  let failNextCreate = true
  const realCreate = h.http.routes.filter((r) => r.method === 'POST' && r.path === h.paths.create)[0].handler
  h.http.routes.filter((r) => r.method === 'POST' && r.path === h.paths.create)[0].handler = function (call) {
    if (failNextCreate) { failNextCreate = false; return new Promise((_resolve, reject) => reject(new Error('network down'))) }
    return realCreate(call)
  }
  await h.page.onRequestTranscript()
  assert.equal(h.page.data.transcriptStage, 'failed', '网络未确认必须停在 failed（不谎称已受理）')
  assert.match(h.page.data.transcriptNote, /网络未能确认结果/)

  // 重试同一动作 ⇒ 同一把受理键（服务端同键回放同一任务，不二次调用提供者）。
  await h.page.onRequestTranscript()
  const posts = h.http.find('POST', h.paths.create)
  assert.equal(posts.length, 2)
  assert.equal(posts[1].header['Idempotency-Key'], posts[0].header['Idempotency-Key'], '同尝试重试必须复用同一把受理键')
  await settle()
  assert.equal(h.page.data.transcriptStage, 'ready')

  // 已落定 ⇒ 尝试结束：再点一次是**新**尝试（新键、新任务），不与上次混用。
  await h.page.onRequestTranscript()
  const postsAfter = h.http.find('POST', h.paths.create)
  assert.equal(postsAfter.length, 3)
  assert.notEqual(postsAfter[2].header['Idempotency-Key'], posts[0].header['Idempotency-Key'], '新尝试必须换新键')
  h.page.onUnload()
})

test('页面·受理在途时取消：本地作废在途请求，迟到 202 不开始轮询、零外发', async () => {
  const h = bootTranscriptPage()
  let releaseCreate = null
  h.http.routes.filter((r) => r.method === 'POST' && r.path === h.paths.create)[0].handler = function () {
    return new Promise((resolve) => { releaseCreate = resolve })
  }
  h.page.onPickTranscriptSample({ currentTarget: { dataset: { id: 'sample-i11-normal' } } })
  const pending = h.page.onRequestTranscript()
  await flushMicrotasks(2)
  assert.equal(h.page.data.transcriptStage, 'requesting')

  await h.page.onCancelTranscript()
  assert.equal(h.page.data.transcriptStage, 'cancelled')
  assert.match(h.page.data.transcriptNote, /尚未产生转写任务/)
  assert.equal(h.http.find('GET', h.paths.record).length, 0, '未受理成功不得轮询')
  assert.equal(h.http.find('POST', h.paths.turns).length, 0, '取消受理不得外发')

  // 迟到的 202 此刻才兑现：代次已作废 ⇒ 不开始轮询、不改状态。
  releaseCreate({ status: 202, data: { data: transcriptionJobFixture(h.transcriptionId, new Date(Date.now() + 30000).toISOString()), meta: metaFixture() }, headers: { ETag: '"1"' } })
  await pending
  await settle(30)
  assert.equal(h.page.data.transcriptStage, 'cancelled', '迟到 202 不得复活已取消的受理')
  assert.equal(h.http.find('GET', h.paths.record).length, 0, '迟到 202 不得开始轮询')
  assert.equal(h.http.find('POST', h.paths.turns).length, 0, '迟到 202 不得外发')
  h.page.onUnload()
})

// ============================================================ H. 页面·版本冲突重读（确认与发送两条路径）

test('页面·发送撞版本冲突（转写侧已变）⇒ 重读刷新；须本机重新明确确认，不得自动放行', async () => {
  const h = bootTranscriptPage()
  await readyTranscript(h)
  h.page.setData({ transcriptDraft: EDITED_TEXT })
  // PATCH 按时间线建模：首次确认 ⇒ revision 2；此后别的会话把记录推到 revision 3；
  // 用户重读后重新确认（If-Match "3"）⇒ revision 4。
  let patchCount = 0
  h.http.routes.filter((r) => r.method === 'PATCH' && r.path === h.paths.confirm)[0].handler = function (call) {
    patchCount += 1
    const revision = patchCount === 1 ? 2 : 4
    return {
      status: 200,
      data: { data: recordFixture(h.transcriptionId, { revision, confirmed_text: call.data.confirmed_text, confirmed_at: new Date().toISOString() }), meta: metaFixture() },
      headers: { ETag: '"' + revision + '"' }
    }
  }
  // 发送第一次：409 版本冲突；此后放行。
  let turnCount = 0
  h.http.routes.filter((r) => r.method === 'POST' && r.path === h.paths.turns)[0].handler = function (call) {
    turnCount += 1
    if (turnCount === 1) return { status: 409, data: { error: { code: 'REVISION_CONFLICT' } }, meta: metaFixture() }
    return { status: 202, data: { data: answerJobFixture(randomUUID()), meta: metaFixture() }, headers: { ETag: '"1"' } }
  }
  // 冲突后重读：服务端记录已被他人改动（revision 3、他人确认的正文）。
  h.http.routes.filter((r) => r.method === 'GET' && r.path === h.paths.record)[0].handler = () => ({
    status: 200,
    data: { data: recordFixture(h.transcriptionId, { revision: 3, confirmed_text: '他人改后的正文', confirmed_at: '2026-10-18T00:00:00.000Z' }), meta: metaFixture() },
    headers: { ETag: '"3"' }
  })

  await h.page.onConfirmAndSend()
  assert.equal(h.page.data.transcriptStage, 'ready')
  assert.equal(h.page.data.transcriptRevision, 3, '必须按服务端最新 revision 刷新')
  assert.match(h.page.data.transcriptNote, /版本已变化/)
  assert.equal(h.http.find('POST', h.paths.turns).length, 1, '冲突后不得自动重发')

  // 用户重新明确确认后才发送，且发送的是新 revision（新尝试）。
  await h.page.onConfirmAndSend()
  const turns = h.http.find('POST', h.paths.turns)
  assert.equal(turns.length, 2)
  assert.equal(turns[1].data.transcription_revision, 4, '重新确认后必须发送新 revision')
  assert.equal(h.page.data.transcriptStage, 'sent')
  h.page.onUnload()
})

test('页面·发送撞版本冲突（会话侧）⇒ 重读确认转写身份未变 ⇒ 同一把发送键重试即成功', async () => {
  const h = bootTranscriptPage()
  await readyTranscript(h)
  h.page.setData({ transcriptDraft: EDITED_TEXT })
  // 发送第一次：409（会话侧版本冲突；转写记录未被改动 ⇒ 读面仍是已确认的 revision 2）。
  let turnCount = 0
  const realTurn = h.http.routes.filter((r) => r.method === 'POST' && r.path === h.paths.turns)[0].handler
  h.http.routes.filter((r) => r.method === 'POST' && r.path === h.paths.turns)[0].handler = function (call) {
    turnCount += 1
    if (turnCount === 1) return { status: 409, data: { error: { code: 'REVISION_CONFLICT' } }, meta: metaFixture() }
    return realTurn(call)
  }
  await h.page.onConfirmAndSend()
  assert.equal(h.page.data.transcriptStage, 'ready')
  assert.match(h.page.data.transcriptNote, /可重试/)
  assert.equal(h.http.find('PATCH', h.paths.confirm).length, 1, '转写身份未变 ⇒ 不得重新确认')
  const firstSendKey = h.http.find('POST', h.paths.turns)[0].header['Idempotency-Key']

  // 重试：同一把发送键（本地会话已丢弃，自动重建）。
  await h.page.onConfirmAndSend()
  const turns = h.http.find('POST', h.paths.turns)
  assert.equal(turns.length, 2)
  assert.equal(turns[1].header['Idempotency-Key'], firstSendKey, '身份未变必须复用同一把发送键')
  assert.equal(h.http.find('PATCH', h.paths.confirm).length, 1, '重试不得再次确认')
  assert.equal(h.page.data.transcriptStage, 'sent')
  h.page.onUnload()
})

test('页面·确认撞版本冲突后重读刷新；"他人已确认"不得自动发送，须本机重新明确确认', async () => {
  const h = bootTranscriptPage()
  await readyTranscript(h)
  h.page.setData({ transcriptDraft: EDITED_TEXT })
  // 第一次 PATCH：409 版本冲突（别的会话改动过记录）。
  let patchCount = 0
  h.http.routes.filter((r) => r.method === 'PATCH' && r.path === h.paths.confirm)[0].handler = function (call) {
    patchCount += 1
    if (patchCount === 1) return { status: 409, data: { error: { code: 'REVISION_CONFLICT' } } }
    return { status: 200, data: { data: recordFixture(h.transcriptionId, { revision: 3, confirmed_text: call.data.confirmed_text, confirmed_at: new Date().toISOString() }), meta: metaFixture() }, headers: { ETag: '"3"' } }
  }
  // 冲突后的重读：服务端最新记录是 revision 2 且**已被他人确认**。
  h.http.routes.filter((r) => r.method === 'GET' && r.path === h.paths.record)[0].handler = () => ({
    status: 200,
    data: { data: recordFixture(h.transcriptionId, { revision: 2, confirmed_text: '他人已确认的正文', confirmed_at: '2026-10-16T01:00:00.000Z' }), meta: metaFixture() },
    headers: { ETag: '"2"' }
  })

  await h.page.onConfirmAndSend()
  assert.equal(h.page.data.transcriptStage, 'ready')
  assert.equal(h.page.data.transcriptRevision, 2, '必须按服务端最新 revision 刷新')
  assert.match(h.page.data.transcriptNote, /版本已变化/)
  assert.equal(h.http.find('POST', h.paths.turns).length, 0, '他人确认过不得自动发送（闸门只认本机一次成功确认）')

  // 用户重新明确确认（新 If-Match、新尝试键）之后才发送。
  h.page.setData({ transcriptDraft: EDITED_TEXT })
  await h.page.onConfirmAndSend()
  const patches = h.http.find('PATCH', h.paths.confirm)
  assert.equal(patches.length, 2)
  assert.equal(patches[1].header['If-Match'], '"2"', '重读后必须使用新 revision')
  assert.notEqual(patches[1].header['Idempotency-Key'], patches[0].header['Idempotency-Key'], '冲突后必须是新尝试（新键）')
  const turns = h.http.find('POST', h.paths.turns)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].data.transcription_revision, 3, '必须发送重新确认后的 revision')
  assert.equal(h.page.data.transcriptStage, 'sent')
  h.page.onUnload()
})

// ============================================================ I. 页面·取消与迟到不外发

test('页面·取消：先关闸门再 DELETE；取消后迟到响应与再次点击都零外发', async () => {
  const h = bootTranscriptPage()
  // 把 GET 扣在途：模拟"记录响应还在飞行中"时用户取消。
  let releaseGet = null
  h.http.routes.filter((r) => r.method === 'GET' && r.path === h.paths.record)[0].handler = function () {
    return new Promise((resolve) => { releaseGet = resolve })
  }
  h.page.onPickTranscriptSample({ currentTarget: { dataset: { id: 'sample-i11-normal' } } })
  await h.page.onRequestTranscript()
  await settle(20)
  assert.equal(h.page.data.transcriptStage, 'pending')
  assert.ok(releaseGet !== null, '应有一拍 GET 在途（记录响应被扣住）')

  await h.page.onCancelTranscript()
  const deletes = h.http.find('DELETE', h.paths.record)
  assert.equal(deletes.length, 0, '尚未取得记录（revision 未知）不得发明 If-Match 发删除')
  assert.equal(h.page.data.transcriptStage, 'cancelled')
  assert.match(h.page.data.transcriptNote, /不会发送任何问答/)

  // 迟到的记录响应此刻才兑现：不得改状态、不得触发任何发送。
  releaseGet({ status: 200, data: { data: recordFixture(h.transcriptionId), meta: metaFixture() }, headers: { ETag: '"1"' } })
  await settle()
  assert.equal(h.page.data.transcriptStage, 'cancelled', '迟到响应不得复活已取消的流')
  h.page.onConfirmAndSend()
  await flushMicrotasks(2)
  assert.equal(h.http.find('PATCH', h.paths.confirm).length, 0, '取消后不得确认')
  assert.equal(h.http.find('POST', h.paths.turns).length, 0, '取消后不得发送')
  h.page.onUnload()
})

test('页面·记录就绪后取消：DELETE 带 If-Match 与幂等键；此后零外发', async () => {
  const h = bootTranscriptPage()
  await readyTranscript(h)
  await h.page.onCancelTranscript()
  const deletes = h.http.find('DELETE', h.paths.record)
  assert.equal(deletes.length, 1, '恰好一次删除请求')
  assert.equal(deletes[0].header['If-Match'], '"1"', '删除必须带读面 revision')
  assert.ok(deletes[0].header['Idempotency-Key'].length >= 8, '删除必须带幂等键')
  assert.equal(h.page.data.transcriptStage, 'cancelled')

  h.page.setData({ transcriptDraft: EDITED_TEXT })
  h.page.onConfirmAndSend()
  await flushMicrotasks(2)
  assert.equal(h.http.find('PATCH', h.paths.confirm).length, 0, '取消后不得确认')
  assert.equal(h.http.find('POST', h.paths.turns).length, 0, '取消后不得发送')
  h.page.onUnload()
})

test('页面·取消的删除失败也绝不重开发送资格（本地取消是最终决定）', async () => {
  const h = bootTranscriptPage()
  await readyTranscript(h)
  h.http.routes.filter((r) => r.method === 'DELETE' && r.path === h.paths.record)[0].handler = () => ({ status: 409, data: { error: { code: 'REVISION_CONFLICT' } } })
  await h.page.onCancelTranscript()
  assert.equal(h.page.data.transcriptStage, 'cancelled')
  assert.match(h.page.data.transcriptNote, /不会发送任何问答/)
  assert.match(h.page.data.transcriptNote, /服务端删除未成功/)
  h.page.onConfirmAndSend()
  await flushMicrotasks(2)
  assert.equal(h.http.find('POST', h.paths.turns).length, 0, '删除失败也不得外发')
  h.page.onUnload()
})

// ============================================================ J. 页面·迟到轮询不冲掉已确认快照

test('页面·迟到轮询响应（旧 revision）不得冲掉已确认快照，发送仍用确认后 revision', async () => {
  const h = bootTranscriptPage()
  await readyTranscript(h)
  h.page.setData({ transcriptDraft: EDITED_TEXT })
  await h.page.onConfirmAndSend()
  assert.equal(h.page.data.transcriptStage, 'sent')
  assert.equal(h.page.data.transcriptRevision, 2, '确认后 revision 必须为 2')

  // 迟到的旧记录响应（revision 1、未确认）在确认之后才兑现：
  // 直接驱动轮询的落点（`refreshTranscript` 就是迟到响应的唯一入口），GET 路由仍返回旧记录。
  await h.page.refreshTranscript(h.page._generation)
  await flushMicrotasks(4)
  assert.equal(h.page.data.transcriptRevision, 2, '迟到旧 revision 不得覆盖已确认快照')
  assert.equal(h.page.data.transcriptConfirmedText, EDITED_TEXT, '已确认正文不得被迟到响应清掉')
  // 已确认快照没被冲掉 ⇒ 闸门仍然放行的是 revision 2（迟到响应没有制造第二次发送）。
  assert.equal(h.http.find('POST', h.paths.turns).length, 1, '迟到响应不得触发第二次发送')
  h.page.onUnload()
})

// ============================================================ K. 页面·失败终态不外发

test('页面·截止时间内取不到记录 ⇒ 如实失败（TRANSCRIPT_NOT_PRODUCED），零轮次请求', async () => {
  const h = bootTranscriptPage({ deadlineInMs: -1000 }) // 截止时间已过：第一拍即越界
  h.http.routes.filter((r) => r.method === 'GET' && r.path === h.paths.record)[0].handler = () => ({ status: 404, data: { error: { code: 'NOT_FOUND' } } })
  h.page.onPickTranscriptSample({ currentTarget: { dataset: { id: 'sample-i11-silent' } } })
  await h.page.onRequestTranscript()
  await settle(60)
  assert.equal(h.page.data.transcriptStage, 'failed')
  assert.equal(h.page.data.transcriptErrorCode, 'TRANSCRIPT_NOT_PRODUCED')
  assert.match(h.page.data.transcriptNote, /不编造文本、不发送任何问答/)
  h.page.onConfirmAndSend()
  await flushMicrotasks(2)
  assert.equal(h.http.find('PATCH', h.paths.confirm).length, 0, '失败终态不得确认')
  assert.equal(h.http.find('POST', h.paths.turns).length, 0, '失败终态不得发送')
  h.page.onUnload()
})

test('页面·转写受理失败（提供者未接线 503）⇒ 如实归因、零后续请求', async () => {
  const h = bootTranscriptPage()
  h.http.routes.filter((r) => r.method === 'POST' && r.path === h.paths.create)[0].handler = () => ({ status: 503, data: { error: { code: 'PROVIDER_UNAVAILABLE', retryable: false } } })
  h.page.onPickTranscriptSample({ currentTarget: { dataset: { id: 'sample-i11-normal' } } })
  await h.page.onRequestTranscript()
  assert.equal(h.page.data.transcriptStage, 'failed')
  assert.equal(h.page.data.transcriptErrorCode, 'PROVIDER_UNAVAILABLE')
  assert.match(h.page.data.transcriptNote, /真实 ASR 提供者未接线/)
  assert.equal(h.http.find('GET', h.paths.record).length, 0, '受理失败不得轮询')
  assert.equal(h.http.find('POST', h.paths.turns).length, 0, '受理失败不得发送')
  h.page.onUnload()
})

// ============================================================ L. 页面·离页作废

test('页面·离页（onHide）后迟到响应零外发、不改 UI', async () => {
  const h = bootTranscriptPage()
  let releaseGet = null
  h.http.routes.filter((r) => r.method === 'GET' && r.path === h.paths.record)[0].handler = function () {
    return new Promise((resolve) => { releaseGet = resolve })
  }
  h.page.onPickTranscriptSample({ currentTarget: { dataset: { id: 'sample-i11-normal' } } })
  await h.page.onRequestTranscript()
  await settle(20)
  assert.ok(releaseGet !== null, '应有一拍 GET 在途')
  h.page.onHide()
  const stageAtLeave = h.page.data.transcriptStage
  releaseGet({ status: 200, data: { data: recordFixture(h.transcriptionId), meta: metaFixture() }, headers: { ETag: '"1"' } })
  await settle()
  assert.equal(h.page.data.transcriptStage, stageAtLeave, '离页后迟到响应不得改 UI')
  assert.equal(h.http.find('POST', h.paths.turns).length, 0, '离页后零外发')
  h.page.onUnload()
})

// ============================================================ M. 静态口径

test('静态·页面不得直接调用平台能力；替身引用与闸门口径落在工具模块', () => {
  const pageSource = read('miniprogram/pages/voice/voice.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/wx\.request\s*\(/.test(pageSource), false, '页面不得直接发请求（只能经 speech-transcript/voice-api 等消费层）')
  const util = read('miniprogram/utils/speech-transcript.js')
  assert.ok(util.includes('evaluateSendGate'), '闸门必须存在于工具模块')
  assert.ok(util.includes('checked_and_sendable'), '确认常量必须来自契约')
  const wxml = read('miniprogram/pages/voice/voice.wxml')
  assert.ok(/bindtap="onConfirmAndSend"/.test(wxml), '确认发送入口必须存在')
  assert.ok(/bindtap="onCancelTranscript"/.test(wxml), '取消入口必须存在')
  const prepare = read('tools/prepare-wechat.mjs')
  assert.ok(prepare.includes("'utils/speech-transcript.js'"), '打包允许清单必须包含转写消费层')
})
