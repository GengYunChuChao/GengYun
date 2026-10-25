/**
 * GY-I12 **原生文字提问页**回归（Refs #12；stub/preset_demo 局部实现）。
 *
 * 被测对象是**仓库里的真代码**（`miniprogram/utils/qa-api.js` 与
 * `miniprogram/pages/qa/qa.js`，经 vm 注入依赖加载），传输层是可完全观测的假 `wx.request`
 * （逐请求记录 method/path/header/body，可按路由脚本化响应，并可把某个响应扣在途）。
 *
 * 分层（每层都可单独指出）：
 *   A. 契约闭集校验：TextTurnInput 两键 / Answer 十一键 / SourceRef 十键 / Job 九键 /
 *      Conversation 四键 / Turn 七键 / TurnPage / Ack 的负例；
 *   B. **未审/畸形回答阻断**：check_state 非 passed / status 非 answered / 无引用 /
 *      缺键多键 / 类型错 ⇒ 一律不得进入展示（闸门 `evaluateAnswerGate` 纯函数）；
 *   C. **请求形状与版本/幂等头**：`{input_type:'text', text}` 恰两键、绝不夹带 SpeechTurnInput
 *      字段；`If-Match` 取服务端回传的会话 revision；`Idempotency-Key` 8..128 且同一尝试复用；
 *   D. **空白/上限**：空串、纯空白、>8000 码点 ⇒ 零请求（不静默截断）；
 *   E. **失败/超时/不确定**：failed / timed_out / uncertain / 未接线 503 ⇒ 逐类如实呈现，
 *      不把任何非成功态显示成"已有回答"；超时后**不自动重发**；
 *   F. **重复点击**：发送中再点 ⇒ 恰好一个轮次请求；
 *   G. **离页/身份切换旧回调不回填**：onHide/onUnload 后迟到响应零外发、不改 UI；
 *   H. 静态口径：页面不直接发请求、qa 页已注册路由、打包允许清单含 qa-api。
 *
 * 边界（如实标注）：
 * - **不触达任何真实服务**：全部响应由假 transport 脚本化；不发起外网请求、不连接数据库；
 * - **不产生、不声称任何真实问答能力**：回答正文是合成夹具；
 *   真实 LLM 供应商与 120 题评估（GY-I21）均未取得；
 * - **不渲染任何用量正文**：本测试同样只断言条数与资格判定，不断言可执行用量。
 */
import { test, after } from 'node:test';
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

/** 合成提问正文（夹具；与真实问答无关）。 */
const QUESTION = '稻田稗草三到五叶期， observations 请问题应该用什么药？'
const EDITED_QUESTION = '稻田稗草三到五叶期，防治稗草应该用什么药？（用户已校对）'

// ============================================================ 夹具

function metaFixture(mode) {
  return { request_id: randomUUID(), contract_version: '1.0.0', execution_mode: mode || 'stub' }
}

/** 契约 `SourceRef`（十键；url 必须 https）。 */
function sourceRefFixture(overrides) {
  const base = {
    id: randomUUID(),
    version: 'seed-2026-10',
    title: '替身来源条目（合成夹具，不是真实资料）',
    url: 'https://example.invalid/synthetic-source',
    publisher: '替身发布方',
    source_kind: 'verified_seed',
    evidence_kind: 'research',
    validity: 'valid',
    review_status: 'verified',
    updated_at: new Date().toISOString()
  }
  return Object.assign(base, overrides || {})
}

/** 契约 `Answer`（十一键）。 */
function answerFixture(overrides) {
  const base = {
    id: randomUUID(),
    revision: 1,
    status: 'answered',
    checked_text: '替身回答正文（合成夹具）：稗草苗后茎叶处理，请以核验登记资料为准。',
    check_state: 'passed',
    citations: [sourceRefFixture()],
    dose_cards: [],
    model_version: 'unimplemented:no-real-model',
    prompt_version: 'unimplemented:no-real-prompt',
    rule_version: 'unimplemented:no-real-rule'
  }
  return Object.assign(base, overrides || {})
}

/** 契约 `Job`（kind=answer，九键；`result.value` 是 Answer）。 */
function answerJobFixture(turnId, overrides) {
  const base = {
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
  return Object.assign(base, overrides || {})
}

/** 契约 `Conversation`（四键）。 */
function conversationFixture(overrides) {
  return Object.assign({
    id: randomUUID(), revision: 1, conditions: null, created_at: new Date().toISOString()
  }, overrides || {})
}

/** 契约 `Turn`（七键；answer 可空）。 */
function turnFixture(overrides) {
  const base = {
    id: randomUUID(),
    revision: 1,
    input_text: QUESTION,
    transcription_ref: null,
    job_id: randomUUID(),
    answer: null,
    created_at: new Date().toISOString()
  }
  return Object.assign(base, overrides || {})
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
    routeOf: function (method, path) {
      return routes.filter((r) => r.method === method && r.path === path)[0]
    },
    handle: function (call) {
      const route = routes.filter((r) => r.method === call.method && r.path === call.path)[0]
      if (route === undefined) return Promise.resolve({ status: 404, data: { error: { code: 'NOT_FOUND' } } })
      return Promise.resolve(route.handler(call))
    }
  }
}

/**
 * 假 `wx`：只提供 qa 页链路需要的面，并**刻意不提供** `wx.createInnerAudioContext` 与
 * `wx.getRecorderManager` —— 这两个面一旦出现在 `globalThis.wx` 上，会让同进程的
 * voice/inner-audio 测试把"本机没有该能力"误判成"有"（`--test-isolation=none` 下
 * `globalThis.wx` 是共享的）。qa 页与它们的链路无关，缺这两个面正好保持判据干净。
 */
function fakeWx(http) {
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
    showModal: () => {},
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getSetting: function (o) { if (o && o.success) o.success({ authSetting: { 'scope.record': true } }) }
  }
}

// ============================================================ vm 加载器（真代码 + 注入依赖）

function createLoader(wxApi) {
  const cache = new Map()
  // 账号/会话状态可变：回归需要真实模拟「页面隐藏后换成另一个账号再返回」。
  const identity = { token: 'synthetic-token', epoch: 'epoch-1', loggedIn: true }
  const auth = {
    isLoggedIn: () => identity.loggedIn,
    getSession: () => (identity.loggedIn ? { accessToken: identity.token } : null),
    sessionEpoch: () => identity.epoch,
    networkEnabled: () => true,
    clearSession: () => { identity.loggedIn = false }
  }
  const runtime = { mode: 'local', apiBaseUrl: 'http://127.0.0.1:3100/api/v1' }
  const fontScale = { applyFontScale: () => {}, currentFontScale: () => 1, DEFAULT_FONT_SCALE: 1 }
  const pageGate = { start: (page, callback) => callback(true), cancel: () => {} }

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

  const resolveDep = (id) => {
    const base = id.split('/').pop()
    if (base === 'auth') return auth
    if (base === 'runtime') return runtime
    if (base === 'font-scale') return fontScale
    if (base === 'page-gate') return pageGate
    if (base === 'qa-api') return loadReal(join(ROOT, 'miniprogram/utils/qa-api.js'), resolveDep)
    throw new Error('unexpected require: ' + id)
  }
  return { loadReal: loadReal, resolveDep: resolveDep, auth: auth, runtime: runtime, identity: identity }
}

/** 只加载 qa-api 模块（模块级用例：不需要页面）。 */
function loadQaModule() {
  const loader = createLoader(null)
  return loader.loadReal(join(ROOT, 'miniprogram/utils/qa-api.js'), loader.resolveDep)
}

/**
 * 收尾：清掉本文件注入的 `globalThis.wx`，避免 `--test-isolation=none` 下污染同进程的
 * 其他页面测试（voice/transcript 等文件各自会重新注入）。
 */
after(() => { delete globalThis.wx })

async function flushMicrotasks(rounds) {
  for (let i = 0; i < (rounds || 10); i += 1) await new Promise((r) => setImmediate(r))
}

async function settle(ms) {
  await flushMicrotasks()
  await new Promise((r) => setTimeout(r, ms === undefined ? 40 : ms))
}

/**
 * 有界轮询等待一个**可观测条件**成立（超时抛错并带上已等时长与上限）。
 *
 * 为什么不能只等固定墙钟：本测试把 `qaApi.POLL_INTERVAL_MS` 置为 5ms，页面的推进由
 * `setInterval(5ms)` 这一串**定时器宏任务**驱动（受理 → 第 N 拍读到终态 → `settle()`）。
 * 固定窗口（如 `settle(60)`）在满载/慢盘机器上遇到一次 >60ms 的同步停顿（GC、IO、OS 调度）时，
 * 恢复 CPU 后的那一个 timers 相位只给重复定时器补**一拍**，紧接着到期的 60ms 定时器就放行了断言
 * ⇒ 断言看到「只走了 1 拍」的中间态（空的门禁码、null 的回答）。改等条件后：机器慢只意味着等得久，
 * 被验证的语义一点不放松（条件本身比"时间到了"更严）。
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

/** 等页面的轮询链把任务读到终态（`settle()` 已落定、发送中已解除）。 */
async function waitSettled(page, message) {
  await waitFor(() => page.data.stage === 'settled' && page.data.busy === false, {
    message: message || '页面轮询链应把任务读到终态（stage=settled、busy=false；5ms 轮询拍未落地）'
  })
}

/** 等页面因越过 `deadline_at` / 拍数上限而落到「未产出、可重试」态。 */
async function waitNotProduced(page, message) {
  await waitFor(() => page.data.taskErrorCode === 'ANSWER_NOT_PRODUCED', {
    message: message || '轮询应越过 deadline_at 并落到 ANSWER_NOT_PRODUCED（5ms 轮询拍未落地）'
  })
}

/** 等累计发出 n 个轮次请求且页面已解除发送中（「重试/改正文/清空 ⇒ 恰好 N 个轮次」用）。 */
async function waitTurnCount(h, n, message) {
  await waitFor(() => h.http.find('POST', h.paths.turns).length >= n && h.page.data.busy === false, {
    message: message || ('应累计发出 ' + n + ' 个轮次请求且页面已解除发送中（5ms 轮询拍未落地）')
  })
}

/**
 * 起一个带假传输的文字提问页（真实页面代码）。
 *
 * 返回 `{ page, http, qa, conversationId, turnId, paths }`；测试经 `page.onXxx` 驱动，
 * 经 `http.calls` 观测每一个真实发出的请求。
 */
function bootQaPage(options) {
  const opts = options || {}
  const http = createHttp()
  const wx = fakeWx(http)
  const loader = createLoader(wx)
  const conversationId = randomUUID()
  const turnId = randomUUID()
  const paths = {
    conversations: '/api/v1/conversations',
    turns: '/api/v1/conversations/' + conversationId + '/turns',
    job: '/api/v1/jobs/' + randomUUID()
  }
  const deadline = new Date(Date.now() + (opts.deadlineInMs === undefined ? 30000 : opts.deadlineInMs)).toISOString()
  const job = answerJobFixture(turnId, { deadline_at: deadline })
  paths.job = '/api/v1/jobs/' + job.id

  // 会话创建：**固定**返回 conversationId（页面自己建会话，路径必须可预测），
  // 同一把键 ⇒ 回放同一会话（不重复创建）；新键 ⇒ 同一会话（本测试不需要第二种会话）。
  http.on('POST', paths.conversations, (call) => {
    assert.ok(call.header['Idempotency-Key'].length >= 8, '建会话必须带幂等键')
    return { status: 201, data: { data: conversationFixture({ id: conversationId }), meta: metaFixture(opts.mode) }, headers: { ETag: '"1"' } }
  })

  // 发送文字轮次：**固定**回传受理作业（页面按它轮询，GET 路径必须可预测）；
  // 同一把键 ⇒ 回放同一任务（不建第二条轮次）。
  http.on('POST', paths.turns, (call) => {
    const key = call.header['Idempotency-Key']
    assert.ok(key.length >= 8, '发送必须带幂等键')
    return { status: 202, data: { data: job, meta: metaFixture(opts.mode) }, headers: { ETag: '"1"' } }
  })

  // 作业读面：`jobState.answerAfterPolls` 次读面后转为 succeeded（默认 2 拍，模拟"先生成后落库"）；
  // 之后的读面一直给成功态 + `jobState.answer`。终态覆盖用 `jobState.value`（failed/timed_out/uncertain）。
  const jobState = {
    value: job,
    answer: opts.jobAnswer === undefined ? answerFixture() : opts.jobAnswer,
    answerAfterPolls: opts.answerAfterPolls === undefined ? 2 : opts.answerAfterPolls,
    polls: 0
  }
  http.on('GET', paths.job, () => {
    jobState.polls += 1
    if (jobState.value.state !== 'queued' && jobState.value.state !== 'running') return { status: 200, data: { data: jobState.value, meta: metaFixture(opts.mode) }, headers: { ETag: '"1"' } }
    const settled = jobState.polls >= jobState.answerAfterPolls
    const view = settled
      ? answerJobFixture(turnId, {
          id: job.id, state: 'succeeded', deadline_at: job.deadline_at,
          error_code: null, result: { kind: 'answer', value: jobState.answer }
        })
      : jobState.value
    return { status: 200, data: { data: view, meta: metaFixture(opts.mode) }, headers: { ETag: '"1"' } }
  })

  http.on('GET', paths.turns, () => ({
    status: 200,
    data: { data: { items: [turnFixture({ job_id: job.id, answer: jobState.answer })], next_cursor: null }, meta: metaFixture(opts.mode) }
  }))

  const qa = loader.loadReal(join(ROOT, 'miniprogram/utils/qa-api.js'), loader.resolveDep)
  qa.POLL_INTERVAL_MS = 5

  globalThis.wx = wx
  let definition = null
  globalThis.Page = (value) => { definition = value }
  try {
    loader.loadReal(join(ROOT, 'miniprogram/pages/qa/qa.js'), loader.resolveDep)
  } finally {
    delete globalThis.Page
  }
  assert.ok(definition, '文字提问页必须注册 Page')
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch) },
    route: 'pages/qa/qa'
  })
  page.onLoad()
  page.onShow()
  return { page: page, http: http, qa: qa, job: job, paths: paths, jobState: jobState, loader: loader, identity: loader.identity }
}

// ============================================================ A. 契约闭集校验（负例）

test('契约·TextTurnInput 请求体恰两键；空白/超长一律 INVALID_INPUT（不截断）', () => {
  const m = loadQaModule()
  assert.deepEqual(m.validateTextTurnBody('稻田稗草用什么药？'), { input_type: 'text', text: '稻田稗草用什么药？' })
  for (const bad of ['', '   ', '\n\t ', null, undefined, 42, 'x'.repeat(m.TEXT_MAX + 1)]) {
    assert.throws(() => m.validateTextTurnBody(bad), (e) => e.code === 'INVALID_INPUT', JSON.stringify(String(bad).slice(0, 12)) + ' 必须被拒')
  }
  // 边界：恰等于上限必须放行（不多截一个码点）。
  assert.equal(m.validateTextTurnBody('x'.repeat(m.TEXT_MAX)).text.length, m.TEXT_MAX)
  // 形状闭集：不得夹带 SpeechTurnInput 的任何字段。
  const body = m.validateTextTurnBody('问题')
  assert.deepEqual(Object.keys(body).sort(), ['input_type', 'text'])
  for (const key of ['transcription_id', 'transcription_revision', 'confirmed', 'conditions']) {
    assert.equal(key in body, false, `文字轮次体不得夹带 ${key}`)
  }
})

test('契约·Answer 十一键闭集；status/check_state/来源枚举越界一律 INVALID_RESPONSE', () => {
  const m = loadQaModule()
  const good = answerFixture()
  assert.equal(m.validateAnswer(good).status, 'answered')
  const bad = [
    ['缺一键', (() => { const r = Object.assign({}, good); delete r.rule_version; return r })()],
    ['多一键', Object.assign({}, good, { extra: 1 })],
    ['status 越界', Object.assign({}, good, { status: 'streaming' })],
    ['check_state 越界', Object.assign({}, good, { check_state: 'pending' })],
    ['checked_text 空串', Object.assign({}, good, { checked_text: '' })],
    ['checked_text 超长', Object.assign({}, good, { checked_text: 'x'.repeat(m.CHECKED_TEXT_MAX + 1) })],
    ['citations 非数组', Object.assign({}, good, { citations: {} })],
    ['citations 超上限', Object.assign({}, good, { citations: new Array(m.CITATION_MAX + 1).fill(sourceRefFixture()) })],
    ['引用缺键', Object.assign({}, good, { citations: [{ id: randomUUID() }] })],
    ['引用 url 非 https', Object.assign({}, good, { citations: [sourceRefFixture({ url: 'http://example.invalid/x' })] })],
    ['引用 source_kind 越界', Object.assign({}, good, { citations: [sourceRefFixture({ source_kind: 'blog' })] })],
    ['引用 validity 越界', Object.assign({}, good, { citations: [sourceRefFixture({ validity: 'maybe' })] })],
    ['dose_cards 超上限', Object.assign({}, good, { dose_cards: new Array(m.DOSE_CARD_MAX + 1).fill({ id: randomUUID(), revision: 1 }) })],
    ['model_version 空', Object.assign({}, good, { model_version: '' })],
    ['revision 0', Object.assign({}, good, { revision: 0 })]
  ]
  for (const [label, value] of bad) {
    assert.throws(() => m.validateAnswer(value), (e) => e.code === 'INVALID_RESPONSE', label + ' 必须被拒')
  }
})

test('契约·Job 九键闭集与 kind 绑定；Conversation/Turn/TurnPage/Ack 负例', () => {
  const m = loadQaModule()
  const id = randomUUID()
  const good = answerJobFixture(id)
  assert.equal(m.validateAnswerJob(good).kind, 'answer')
  assert.throws(() => m.validateAnswerJob(Object.assign({}, good, { kind: 'synthesis' })), (e) => e.code === 'INVALID_RESPONSE', 'kind 不匹配必须被拒')
  assert.throws(() => m.validateAnswerJob(Object.assign({}, good, { state: 'weird' })), (e) => e.code === 'INVALID_RESPONSE', 'state 越界必须被拒')
  const extra = Object.assign({}, good); extra.extra = 1
  assert.throws(() => m.validateAnswerJob(extra), (e) => e.code === 'INVALID_RESPONSE', '多键必须被拒')
  // 成功态必须带 `{kind,value}` 且 value 是合法 Answer。
  const succeeded = answerJobFixture(id, { state: 'succeeded', result: { kind: 'answer', value: answerFixture() } })
  assert.equal(m.validateAnswerJob(succeeded).result.status, 'answered')
  assert.throws(() => m.validateAnswerJob(answerJobFixture(id, { state: 'succeeded', result: { kind: 'synthesis', value: answerFixture() } })), (e) => e.code === 'INVALID_RESPONSE', 'result.kind 不匹配必须被拒')

  const convo = conversationFixture()
  assert.equal(m.validateConversation(convo).id, convo.id)
  assert.throws(() => m.validateConversation(Object.assign({}, convo, { revision: 0 })), (e) => e.code === 'INVALID_RESPONSE')

  const turn = turnFixture()
  assert.equal(m.validateTurn(turn).input_text, QUESTION)
  assert.throws(() => m.validateTurn(Object.assign({}, turn, { answer: { id: randomUUID() } })), (e) => e.code === 'INVALID_RESPONSE', 'answer 缺键必须被拒')

  const page = { items: [turnFixture()], next_cursor: null }
  assert.equal(m.validateTurnPage(page).items.length, 1)
  assert.throws(() => m.validateTurnPage({ items: [], next_cursor: 5 }), (e) => e.code === 'INVALID_RESPONSE')

  assert.deepEqual(m.validateAck({ accepted: true }), { accepted: true })
  assert.throws(() => m.validateAck({ accepted: false }), (e) => e.code === 'INVALID_RESPONSE')
})

// ============================================================ B. 未审/畸形回答阻断（闸门纯函数）

test('闸门·只有 answered + passed + 结构完整 + 有引用才放行；其余一律阻断', () => {
  const m = loadQaModule()
  const good = answerFixture()
  assert.equal(m.evaluateAnswerGate(good).ok, true, '合法回答必须放行')
  const cases = [
    ['answer 缺失', null, 'ANSWER_MISSING'],
    ['check_state=blocked', answerFixture({ check_state: 'blocked' }), 'ANSWER_NOT_CHECKED'],
    ['status=insufficient', answerFixture({ status: 'insufficient' }), 'ANSWER_INSUFFICIENT'],
    ['status=blocked', answerFixture({ status: 'blocked' }), 'ANSWER_BLOCKED'],
    ['无引用', answerFixture({ citations: [] }), 'ANSWER_NO_SOURCE'],
    ['checked_text 空', answerFixture({ checked_text: '' }), 'ANSWER_MALFORMED'],
    ['缺键', (() => { const r = answerFixture(); delete r.prompt_version; return r })(), 'ANSWER_MALFORMED'],
    ['多键', Object.assign({}, good, { extra: 1 }), 'ANSWER_MALFORMED'],
    ['status 越界', answerFixture({ status: 'streaming' }), 'ANSWER_MALFORMED']
  ]
  for (const [label, value, code] of cases) {
    const gate = m.evaluateAnswerGate(value)
    assert.equal(gate.ok, false, label + ' 必须被拒')
    assert.equal(gate.code, code, label + ' 的码必须一致')
    assert.ok(typeof gate.message === 'string' && gate.message.length > 0, label + ' 必须给一句话')
    // fail-closed 纪律：拒绝结果**不得**携带可展示正文或引用。
    assert.equal(gate.answer, undefined, label + ' 不得给出可展示回答')
  }
  assert.equal(m.evaluateAnswerGate(good).answer.checked_text, good.checked_text)
})

test('闸门·用量卡只报条数与资格判定，绝不给出可执行结论', () => {
  const m = loadQaModule()
  const empty = m.doseCardsView(answerFixture())
  assert.equal(empty.count, 0)
  assert.equal(empty.renderable, false, '空集合也必须保持 renderable=false')
  assert.ok(empty.reason.length > 0, '必须给出原因')

  const withCards = m.doseCardsView(answerFixture({ dose_cards: [{ id: randomUUID(), revision: 1 }] }))
  assert.equal(withCards.count, 1, '必须如实报条数')
  assert.equal(withCards.renderable, false, '客户端不得把任何卡片升格为可执行用量')
  assert.match(withCards.reason, /不渲染用量正文/)

  const blocked = m.doseCardsView(answerFixture({ status: 'insufficient', dose_cards: [{ id: randomUUID(), revision: 1 }] }))
  assert.equal(blocked.renderable, false, '非 answered 不得给用量资格')
  assert.match(blocked.reason, /未通过安全检查或未成功/)

  // 视图只含 count/renderable/blocked/reason 四键：不得夹带任何可执行字段名。
  for (const view of [empty, withCards, blocked]) {
    assert.deepEqual(Object.keys(view).sort(), ['blocked', 'count', 'reason', 'renderable'])
  }
})

// ============================================================ C. 请求形状与版本/幂等头

test('页面·提问全链路：请求形状逐项核对（两键闭集体 / If-Match 会话 revision / 幂等键）', async () => {
  const h = bootQaPage()
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  await waitSettled(h.page)

  // 建会话：恰好一次，带幂等键，请求体为空对象（契约 ConversationInput.required 为空）。
  const convos = h.http.find('POST', h.paths.conversations)
  assert.equal(convos.length, 1, '恰好一次建会话')
  assert.ok(convos[0].header['Idempotency-Key'].length >= 8, '建会话必须带幂等键')

  // 文字轮次：恰两键、绝不夹带语音字段、If-Match 取服务端回传的会话 revision。
  const turns = h.http.find('POST', h.paths.turns)
  assert.equal(turns.length, 1, '恰好一次轮次请求')
  assert.deepEqual(Object.keys(turns[0].data).sort(), ['input_type', 'text'], '文字轮次体必须恰是契约两字段')
  assert.equal(turns[0].data.input_type, 'text')
  assert.equal(turns[0].data.text, QUESTION, '发送的必须是用户输入的正文')
  assert.equal(turns[0].header['If-Match'], '"1"', 'If-Match 必须取自服务端回传的会话 revision')
  assert.ok(turns[0].header['Idempotency-Key'].length >= 8, '发送必须带幂等键')
  assert.equal(turns[0].header['Cache-Control'], 'no-cache', '私有授权访问必须 no-cache')

  // 回答落定：succeeded + passed + 有引用 ⇒ 整体展示。
  assert.equal(h.page.data.answer !== null, true, '闸门放行后必须整体展示回答')
  assert.equal(h.page.data.answer.status, 'answered')
  assert.equal(h.page.data.answer.checkedText, h.jobState.answer.checked_text)
  assert.equal(h.page.data.citations.length, 1, '来源必须逐字来自服务端引用集合')
  assert.equal(h.page.data.citations[0].url, h.jobState.answer.citations[0].url)
  assert.equal(h.page.data.doseCards.count, 0)
  assert.equal(h.page.data.answerGateCode, '')
  h.page.onUnload()
})

test('页面·会话复用：第二次提问不再建会话，只发新轮次', async () => {
  const h = bootQaPage()
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  await waitSettled(h.page, '第一次提问应已落定（第二次发送前 busy 必须已解除）')
  assert.equal(h.page.data.stage, 'settled', '前提：第一次提问已落定，busy 守卫不会吞掉第二次发送')
  const firstKey = h.http.find('POST', h.paths.turns)[0].header['Idempotency-Key']

  h.page.setData({ draft: EDITED_QUESTION })
  await h.page.onSend()
  assert.equal(h.page.data.busy, true, '前提：第二次发送真的被受理（busy 已置位，未被守卫吞掉）')
  await waitSettled(h.page, '第二次提问也应被受理并落定（否则只发得出一个轮次）')

  assert.equal(h.http.find('POST', h.paths.conversations).length, 1, '会话必须复用，不得重复创建')
  const turns = h.http.find('POST', h.paths.turns)
  assert.equal(turns.length, 2, '第二次提问必须发新轮次')
  assert.notEqual(turns[1].header['Idempotency-Key'], firstKey, '新正文 ⇒ 新尝试 ⇒ 新键')
  assert.equal(turns[1].data.text, EDITED_QUESTION)
  assert.equal(turns[1].header['If-Match'], '"1"', 'If-Match 仍取服务端回传的会话 revision')
  h.page.onUnload()
})

// ============================================================ D. 空白/上限（零请求、不静默截断）

test('页面·空白与超长提问 ⇒ 零请求，并给出实际长度（不静默截断）', async () => {
  const h = bootQaPage()
  for (const draft of ['', '   ', '\n\t ']) {
    h.page.setData({ draft: draft, draftLength: draft.length })
    await h.page.onSend()
    await flushMicrotasks(4)
    assert.equal(h.http.calls.length, 0, `空白提问（${JSON.stringify(draft)}）不得发出任何请求`)
    assert.match(h.page.data.inputNote, /还没有输入问题/)
  }
  // 超长：给出实际码点数与上限，且**不**把正文截断后发出。
  const tooLong = 'x'.repeat(h.qa.TEXT_MAX + 1)
  h.page.setData({ draft: tooLong, draftLength: tooLong.length })
  await h.page.onSend()
  await flushMicrotasks(4)
  assert.equal(h.http.calls.length, 0, '超长提问不得发出任何请求')
  assert.match(h.page.data.inputNote, new RegExp('超过上限 ' + h.qa.TEXT_MAX))
  assert.match(h.page.data.inputNote, /不会自动截断/)
  h.page.onUnload()
})

// ============================================================ E. 失败/超时/不确定/未接线

test('页面·failed / timed_out / uncertain 三类终态逐类呈现，均不得显示"已有回答"', async () => {
  const cases = [
    ['failed', '这次没有生成回答'],
    ['timed_out', '等待超时'],
    ['uncertain', '没有拿到确定的结果']
  ]
  for (const [state, phrase] of cases) {
    const h = bootQaPage({ jobAnswer: answerFixture() })
    h.jobState.value = answerJobFixture(h.job.target_ref.id, {
      id: h.job.id, state: state, deadline_at: h.job.deadline_at,
      error_code: state === 'failed' ? 'PROVIDER_UNAVAILABLE' : null
    })
    h.page.setData({ draft: QUESTION })
    await h.page.onSend()
    await waitSettled(h.page, state + ' 终态应已落定（5ms 轮询拍未落地）')
    assert.equal(h.page.data.answer, null, `${state} 不得展示任何回答正文`)
    assert.equal(h.page.data.answerGateCode, 'ANSWER_NOT_PRODUCED', `${state} 的闸门码必须一致`)
    assert.match(h.page.data.answerGateMessage, new RegExp(phrase))
    assert.equal(h.page.data.citations.length, 0, `${state} 不得展示来源`)
    // 面向用户的正文里不得出现状态机/错误码内部值。
    assert.equal(/state=|error_code|timed_out|uncertain/.test(h.page.data.answerGateMessage), false, `${state} 的展示文案不得暴露内部状态码`)
    h.page.onUnload()
  }
})

test('页面·queued/running → failed：进行中提示随终态结束，成功路径不受影响', async () => {
  // 回归（本地渲染证据 gy-i12-qa-render-20261021 第 4 节）：任务已终态 failed 时，
  // ② 区仍残留「问题已发送，正在查找答案…」，与「没有生成回答」并列，语义自相矛盾。
  // 本用例锁定：进行中提示只在 queued/running 期间存在，终态一律撤掉。
  const h = bootQaPage()
  let failNow = false
  h.http.routeOf('GET', h.paths.job).handler = () => {
    const state = failNow ? 'failed' : 'running'
    const view = answerJobFixture(h.job.target_ref.id, {
      id: h.job.id, state: state, deadline_at: h.job.deadline_at,
      error_code: state === 'failed' ? 'PROVIDER_UNAVAILABLE' : null
    })
    return { status: 200, data: { data: view, meta: metaFixture() }, headers: { ETag: '"1"' } }
  }
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  // 202 受理为 queued：此刻进行中提示**应该**在场（修复不是把提示整个删掉）。
  assert.equal(h.page.data.taskNote, '问题已发送，正在查找答案…', 'queued 受理后必须显示进行中提示')

  await waitFor(() => h.page.data.job.state === 'running', {
    message: '中途应读到 running 拍（5ms 轮询拍未落地）'
  })
  assert.equal(h.page.data.job.state, 'running', '前提：中途读到 running')
  assert.equal(h.page.data.stage, 'pending', 'running 仍是进行中')
  assert.equal(h.page.data.taskNote, '问题已发送，正在查找答案…', 'running 期间进行中提示必须保留')

  // 任务转入 failed 终态。
  failNow = true
  await waitFor(() => h.page.data.job.state === 'failed', {
    message: '任务应进入 failed 终态（5ms 轮询拍未落地）'
  })
  assert.equal(h.page.data.job.state, 'failed', '前提：任务已进入 failed 终态')
  assert.equal(h.page.data.stage, 'settled', 'failed 必须落到终态')
  assert.equal(h.page.data.busy, false, '终态必须解除发送中状态')
  assert.equal(h.page.data.taskNote, '', 'failed 终态不得残留「正在查找答案…」进行中提示')
  assert.equal(JSON.stringify(h.page.data).includes('正在查找答案'), false, '终态页面数据里不得出现进行中提示')
  // 失败门禁与文案保持原样：回答不展示，原因仍是「没有生成回答」，且不凭空给可重试错误码。
  assert.equal(h.page.data.answer, null, 'failed 不得展示任何回答')
  assert.equal(h.page.data.citations.length, 0, 'failed 不得展示来源')
  assert.equal(h.page.data.answerGateCode, 'ANSWER_NOT_PRODUCED', '失败门禁码不得改变')
  assert.match(h.page.data.answerGateMessage, /这次没有生成回答/)
  assert.equal(h.page.data.taskErrorCode, '', '终态失败不是发送异常：不得凭空给出可重试错误码')
  h.page.onUnload()

  // 对照：既有成功路径不受影响——同样经过 queued/running，最终 succeeded 展示回答且无进行中提示。
  const ok = bootQaPage()
  ok.page.setData({ draft: QUESTION })
  await ok.page.onSend()
  await waitSettled(ok.page, '成功路径应落到 succeeded 终态（5ms 轮询拍未落地）')
  assert.equal(ok.page.data.job.state, 'succeeded', '前提：成功路径仍落到 succeeded')
  assert.equal(ok.page.data.taskNote, '', '成功终态同样不得残留进行中提示')
  assert.equal(ok.page.data.answer !== null, true, '成功路径仍整体展示回答')
  assert.equal(ok.page.data.answer.checkedText, ok.jobState.answer.checked_text, '成功路径的回答正文不得改变')
  assert.equal(ok.page.data.answerGateCode, '', '成功路径闸门仍放行')
  ok.page.onUnload()
})

test('页面·succeeded 但 check_state=blocked ⇒ 不展示正文，只给真实原因', async () => {
  const h = bootQaPage({ jobAnswer: answerFixture({ check_state: 'blocked' }) })
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  await waitSettled(h.page)
  assert.equal(h.page.data.answer, null, '安全检查未过不得展示回答正文')
  assert.equal(h.page.data.answerGateCode, 'ANSWER_NOT_CHECKED')
  assert.match(h.page.data.answerGateMessage, /安全检查未通过/)
  // 用户可见文案不得再暴露内部 check_state 取值。
  assert.equal(/check_state/.test(h.page.data.answerGateMessage), false, '展示文案不得暴露 check_state 内部值')
  h.page.onUnload()
})

test('页面·succeeded 但无引用 ⇒ ANSWER_NO_SOURCE（不把无出处正文当有出处回答）', async () => {
  const h = bootQaPage({ jobAnswer: answerFixture({ citations: [] }) })
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  await waitSettled(h.page, '无引用终态应已落定（5ms 轮询拍未落地）')
  // 窗口：闸门码是按**读到的终态**算出来的，必须先真的走完 ≥2 拍读面（默认第 2 拍才 succeeded）。
  assert.equal(h.http.find('GET', h.paths.job).length >= 2, true, '前提：轮询至少走过两拍读面')
  assert.equal(h.page.data.answer, null)
  assert.equal(h.page.data.answerGateCode, 'ANSWER_NO_SOURCE')
  h.page.onUnload()
})

test('页面·受理失败（服务端未接线 503）⇒ 如实归因、零轮询、零展示', async () => {
  const h = bootQaPage()
  h.http.routeOf('POST', h.paths.turns).handler = () => ({ status: 503, data: { error: { code: 'PROVIDER_UNAVAILABLE', retryable: false } } })
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  await settle(40)
  assert.equal(h.http.find('GET', h.paths.job).length, 0, '受理失败不得轮询')
  assert.equal(h.page.data.answer, null, '受理失败不得展示任何回答')
  assert.match(h.page.data.taskNote, /服务端能力未接线/)
  assert.equal(h.page.data.taskErrorCode, 'PROVIDER_UNAVAILABLE')
  h.page.onUnload()
})

test('页面·轮询越过 deadline_at ⇒ ANSWER_NOT_PRODUCED，且不自动重发', async () => {
  const h = bootQaPage({ deadlineInMs: -1000 }) // 截止时间已过：第一拍即越界
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  await waitNotProduced(h.page)
  assert.equal(h.page.data.answer, null, '超边界不得展示回答')
  assert.equal(h.page.data.taskErrorCode, 'ANSWER_NOT_PRODUCED')
  assert.match(h.page.data.taskNote, /不会自动重发/)
  // 关键反例：超时后**不得**自动再发一个轮次（那是一次新的推理请求）。
  assert.equal(h.http.find('POST', h.paths.turns).length, 1, '超时后不得自动重发轮次')
  h.page.onUnload()
})

test('页面·202 受理后轮询超时，点「重试」严格回放同一请求身份（不创建新任务）', async () => {
  // 受理成功但 deadline 已过 ⇒ 轮询第一拍即越界，页面进入"可重试"态。
  const h = bootQaPage({ deadlineInMs: -1000 })
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  await waitNotProduced(h.page, '受理成功但 deadline 已过：第一拍就应越界（5ms 轮询拍未落地）')
  const firstTurnCalls = h.http.find('POST', h.paths.turns)
  assert.equal(firstTurnCalls.length, 1, '首次发送恰好一个轮次请求')
  assert.equal(h.page.data.taskErrorCode, 'ANSWER_NOT_PRODUCED', '超时必须落到可重试态')
  const firstKey = firstTurnCalls[0].header['Idempotency-Key']

  // 用户明确点「重试」：**同一个问题**，必须复用同一把 Idempotency-Key。
  h.page.onRetry()
  await waitTurnCount(h, 2, '重试应发出第 2 个轮次请求并落回可重试态（5ms 轮询拍未落地）')
  const turns = h.http.find('POST', h.paths.turns)
  assert.equal(turns.length, 2, '重试仍应发出一次（服务端同键回放）请求')
  assert.equal(turns[1].header['Idempotency-Key'], firstKey, '202 受理后的重试必须严格回放原键，不得产生新的任务身份')
  assert.equal(turns[1].data.text, QUESTION, '重试的正文必须与原提问一致')
  assert.equal(h.page.data.answer, null, '重试后仍应按真实读取结果决定是否展示')

  // 连续第二次重试同样不得换键。
  h.page.onRetry()
  await waitTurnCount(h, 3, '第二次重试应发出第 3 个轮次请求（5ms 轮询拍未落地）')
  const third = h.http.find('POST', h.paths.turns)
  assert.equal(third[2].header['Idempotency-Key'], firstKey, '多次重试都不得换键')
  h.page.onUnload()
})

test('页面·明确改正文后再发送 ⇒ 换新键（新意图才换身份）', async () => {
  const h = bootQaPage({ deadlineInMs: -1000 })
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  await waitNotProduced(h.page)
  const firstKey = h.http.find('POST', h.paths.turns)[0].header['Idempotency-Key']

  // 用户改了正文并重新发送：这才是一次新的提问。
  h.page.onDraftInput({ detail: { value: EDITED_QUESTION } })
  await h.page.onSend()
  await waitTurnCount(h, 2, '改了正文重新发送应发出第 2 个轮次请求（5ms 轮询拍未落地）')
  const turns = h.http.find('POST', h.paths.turns)
  assert.notEqual(turns[1].header['Idempotency-Key'], firstKey, '改了正文就是新提问，必须换新键')
  assert.equal(turns[1].data.text, EDITED_QUESTION)
  h.page.onUnload()
})

test('页面·点「清空」重新开始同一句话 ⇒ 换新键（用户明确开始新提问）', async () => {
  const h = bootQaPage({ deadlineInMs: -1000 })
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  await waitNotProduced(h.page)
  const firstKey = h.http.find('POST', h.paths.turns)[0].header['Idempotency-Key']

  h.page.onClearDraft()
  assert.equal(h.page._sendAttempt, null, '清空必须丢弃本次尝试身份')
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  await waitTurnCount(h, 2, '清空后重新提问应发出第 2 个轮次请求（5ms 轮询拍未落地）')
  const turns = h.http.find('POST', h.paths.turns)
  assert.notEqual(turns[1].header['Idempotency-Key'], firstKey, '明确重新开始才是新提问，必须换新键')
  h.page.onUnload()
})

// ============================================================ F. 重复点击与重试身份

test('页面·发送中重复点击 ⇒ 恰好一个轮次请求（防重复）', async () => {
  const h = bootQaPage()
  // 把轮次响应扣在途：让"发送中"这个窗口真实存在。
  let release = null
  h.http.routeOf('POST', h.paths.turns).handler = () => new Promise((r) => { release = r })
  h.page.setData({ draft: QUESTION })
  const first = h.page.onSend()
  await flushMicrotasks(2)
  assert.equal(h.page.data.busy, true, '发送中必须置 busy')
  h.page.onSend() // 第一次点击还在途：必须被 busy 守卫挡下
  await flushMicrotasks(2)
  assert.equal(h.http.find('POST', h.paths.turns).length, 1, '重复点击不得产生第二个轮次请求')
  release({ status: 202, data: { data: answerJobFixture(h.job.target_ref.id, { deadline_at: h.job.deadline_at }), meta: metaFixture() }, headers: { ETag: '"1"' } })
  await first
  // 页面收到 202 后一定先置 busy：以「发送中已解除」为本次受理流程走完的条件。
  // （本用例的假 202 回的是另一份 job，其轮询路径不在本测试的路由里，页面会如实落 NOT_FOUND。）
  await waitFor(() => h.page.data.busy === false, {
    message: '放行 202 后页面应把本次受理流程走完并解除发送中（5ms 轮询拍未落地）'
  })
  assert.equal(h.http.find('POST', h.paths.turns).length, 1, '整个窗口仍只有一个轮次请求')
  h.page.onUnload()
})

test('页面·发送结果未知后重试 ⇒ 同一把键（服务端同键回放，不重复提问）', async () => {
  const h = bootQaPage()
  let failNext = true
  const real = h.http.routeOf('POST', h.paths.turns).handler
  h.http.routeOf('POST', h.paths.turns).handler = (call) => {
    if (failNext) { failNext = false; return new Promise((_r, reject) => reject(new Error('network down'))) }
    return real(call)
  }
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  assert.match(h.page.data.taskNote, /可以重试/)
  const firstKey = h.http.find('POST', h.paths.turns)[0].header['Idempotency-Key']

  // 同一正文重试：复用同一把键 ⇒ 服务端按同键回放同一任务（不建第二条轮次）。
  await h.page.onSend()
  const turns = h.http.find('POST', h.paths.turns)
  assert.equal(turns.length, 2)
  assert.equal(turns[1].header['Idempotency-Key'], firstKey, '同一尝试的重试必须复用同一把键')
  h.page.onUnload()
})

// ============================================================ G. 离页/身份切换旧回调不回填

test('页面·离页（onHide）后迟到响应零外发、不改 UI', async () => {
  const h = bootQaPage()
  let release = null
  h.http.routeOf('POST', h.paths.turns).handler = () => new Promise((r) => { release = r })
  h.page.setData({ draft: QUESTION })
  const pending = h.page.onSend()
  await flushMicrotasks(2)
  h.page.onHide()
  const stageAtLeave = h.page.data.stage
  const answerAtLeave = h.page.data.answer
  release({ status: 202, data: { data: answerJobFixture(h.job.target_ref.id, { deadline_at: h.job.deadline_at }), meta: metaFixture() }, headers: { ETag: '"1"' } })
  await pending
  await settle(60)
  assert.equal(h.page.data.stage, stageAtLeave, '离页后迟到响应不得改 UI')
  assert.equal(h.page.data.answer, answerAtLeave, '离页后迟到回答不得回填私有正文')
  assert.equal(h.page.data.busy, false, '离页必须解除 busy')
  assert.equal(h.http.find('GET', h.paths.job).length, 0, '离页后不得开始轮询')
  assert.match(h.page.data.exitReason, /hide/, '离页原因必须如实记录')
  h.page.onUnload()
})

test('页面·onUnload 后任何入口都不得再发送', async () => {
  const h = bootQaPage()
  h.page.setData({ draft: QUESTION })
  h.page.onUnload()
  await h.page.onSend()
  await flushMicrotasks(4)
  assert.equal(h.http.calls.length, 0, '卸载后不得发出任何请求')
  h.page.onUnload()
})

test('页面·门禁失效（游客）⇒ 关闭私有展示并丢弃会话缓存', async () => {
  const h = bootQaPage()
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  await waitSettled(h.page)
  assert.ok(h.page._conversation !== null, '发送成功后本页应缓存会话')
  h.page.closePrivate('会话／门禁已失效：本次提问已作废，未发送任何内容。')
  assert.equal(h.page._conversation, null, '门禁失效必须丢弃会话缓存')
  assert.equal(h.page.data.answer, null, '门禁失效必须清空回答')
  assert.equal(h.page.data.citations.length, 0, '门禁失效必须清空来源')
  await h.page.onSend()
  await flushMicrotasks(4)
  assert.equal(h.http.find('POST', h.paths.turns).length, 1, '门禁失效后不得再发送')
  h.page.onUnload()
})

test('页面·onHide 立刻清空全部私有显示与会话缓存（不等下一次请求）', async () => {
  const h = bootQaPage()
  h.page.onDraftInput({ detail: { value: QUESTION } })
  await h.page.onSend()
  await waitSettled(h.page)
  assert.ok(h.page.data.answer !== null, '前提：先展示出一份回答')
  assert.ok(h.page.data.citations.length > 0, '前提：先展示出来源')
  assert.ok(h.page._conversation !== null, '前提：本页已缓存会话')
  assert.ok(h.page._sendAttempt !== null, '前提：本页保留了本次请求身份')

  h.page.onHide()
  assert.equal(h.page.data.answer, null, '隐藏后不得保留回答正文')
  assert.equal(h.page.data.citations.length, 0, '隐藏后不得保留来源')
  assert.equal(h.page.data.turns.length, 0, '隐藏后不得保留轮次正文')
  assert.equal(h.page.data.draft, '', '隐藏后不得保留草稿')
  assert.equal(h.page.data.conversationId, '', '隐藏后不得保留会话 id')
  assert.equal(h.page._conversation, null, '隐藏后必须丢弃会话缓存')
  assert.equal(h.page._sendAttempt, null, '隐藏后必须丢弃请求身份')
  assert.equal(h.page._acceptedAttemptKey, '', '隐藏后必须丢弃已受理尝试键')
  h.page.onUnload()
})

test('页面·隐藏后换成另一个账号返回：重新核实成功也不得显示上一个账号的内容', async () => {
  const h = bootQaPage()
  h.page.onDraftInput({ detail: { value: QUESTION } })
  await h.page.onSend()
  await waitSettled(h.page)
  const leakedAnswer = h.page.data.answer.checkedText
  assert.ok(leakedAnswer.length > 0, '前提：账号 A 已取得一份私有回答')

  // 账号 A 离开页面（onHide）后，在其他页面登出并登录账号 B。
  h.page.onHide()
  h.identity.token = 'synthetic-token-b'
  h.identity.epoch = 'epoch-2'

  // 回到本页：门禁重新核实**成功**（账号 B 是合法登录态）。
  h.page.onShow()
  await flushMicrotasks(4)

  assert.equal(h.page.data.guest, false, '前提：账号 B 的门禁核实成功')
  assert.equal(h.page.data.answer, null, '账号 B 绝不得看到账号 A 的回答')
  assert.equal(h.page.data.citations.length, 0, '账号 B 绝不得看到账号 A 的来源')
  assert.equal(h.page.data.turns.length, 0, '账号 B 绝不得看到账号 A 的轮次')
  assert.equal(h.page._conversation, null, '账号 B 不得继承账号 A 的会话缓存')
  assert.equal(h.page._sendAttempt, null, '账号 B 不得继承账号 A 的请求身份')
  // 兜底：整屏私有数据里不得出现账号 A 的回答正文。
  assert.equal(JSON.stringify(h.page.data).includes(leakedAnswer), false, '页面数据里不得残留账号 A 的回答正文')
  h.page.onUnload()
})

test('页面·未 onHide 但身份 epoch 变化后返回：同样清空旧账号内容', async () => {
  const h = bootQaPage()
  h.page.onDraftInput({ detail: { value: QUESTION } })
  await h.page.onSend()
  await waitSettled(h.page)
  const leakedAnswer = h.page.data.answer.checkedText

  // 只有"另一页切了账号"这层变化（这里不调 onHide，直接模拟返回时的 epoch 变化）。
  h.identity.token = 'synthetic-token-b'
  h.identity.epoch = 'epoch-2'
  h.page.onShow()
  await flushMicrotasks(4)

  assert.equal(h.page.data.answer, null, 'epoch 变化后必须清空回答')
  assert.equal(JSON.stringify(h.page.data).includes(leakedAnswer), false, 'epoch 变化后不得残留旧回答正文')
  assert.equal(h.page._conversation, null, 'epoch 变化后不得保留旧会话缓存')
  h.page.onUnload()
})

test('页面·旧账号在途响应在换人后不得回填（epoch 绑定）', async () => {
  const h = bootQaPage()
  let release = null
  h.http.routeOf('GET', h.paths.job).handler = () => new Promise((r) => { release = r })
  h.page.setData({ draft: QUESTION })
  await h.page.onSend()
  await waitFor(() => typeof release === 'function', {
    message: '轮询请求应已发出并扣在途（5ms 轮询拍未落地）'
  })
  assert.equal(typeof release, 'function', '前提：轮询请求已发出并扣在途')
  // 换账号（另一个页面完成登录）后再兑现旧响应。
  h.identity.token = 'synthetic-token-b'
  h.identity.epoch = 'epoch-2'
  release({ status: 200, data: { data: h.job, meta: metaFixture() }, headers: { ETag: '"1"' } })
  await waitFor(() => h.page._pollTimer === null, {
    message: '换人后的那一拍应被 epoch 判定拦下并停掉轮询（5ms 轮询拍未落地）'
  })
  assert.equal(h.page.data.answer, null, '换人后旧回调不得回填私有内容')
  assert.equal(h.page.data.citations.length, 0, '换人后旧回调不得回填来源')
  h.page.onUnload()
})

// ============================================================ H. 静态口径

test('静态·qa 页不直接发请求；路由/打包/导航白名单三处一致', () => {
  const pageSource = read('miniprogram/pages/qa/qa.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(/wx\.request\s*\(/.test(pageSource), false, '页面不得直接发请求（只能经 utils/qa-api.js）')
  assert.equal(/setStorageSync\s*\(/.test(pageSource), false, '页面不得把私有提问/回答写本地存储')
  assert.equal(/console\.(log|info|warn|error)\s*\(/.test(pageSource), false, '页面不得把私有提问/回答写日志')

  const app = JSON.parse(read('miniprogram/app.json'))
  assert.equal(app.pages.includes('pages/qa/qa'), true, 'qa 页必须注册在 app.json')
  const nav = requireHere('../../miniprogram/utils/navigation.js')
  assert.equal(nav.PAGES.includes('pages/qa/qa'), true, 'qa 页必须在导航白名单内')
  assert.equal(nav.TAB_PAGES.includes('pages/qa/qa'), false, 'qa 页不是底部 Tab')

  const prepare = read('tools/prepare-wechat.mjs')
  assert.ok(prepare.includes("'utils/qa-api.js'"), '打包允许清单必须包含 qa-api 消费层')
  assert.ok(prepare.includes("'pages/qa/qa'"), '打包允许清单必须包含 qa 页')

  // 识别页入口：文字提问卡必须真的进 qa 页，而不是 toast"尚未接入"。
  const identify = read('miniprogram/pages/identify/identify.js')
  assert.ok(/openQa/.test(identify), '识别页必须有 qa 入口方法')
  assert.equal(/文字提问入口尚未接入/.test(identify), false, '不得再保留"尚未接入"的旧口径')
})

test('静态·qa 模板与样式：发送在前、回答在后，不出现可执行用量字段与富文本渲染', () => {
  const wxml = read('miniprogram/pages/qa/qa.wxml')
  const css = read('miniprogram/pages/qa/qa.wxss').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(/bindtap="onSend"/.test(wxml), '必须有显式发送入口')
  assert.ok(/bindinput="onDraftInput"/.test(wxml), '必须有文字输入入口')
  // 文档流顺序：发送按钮必须出现在回答区块之前（控件不互相遮挡）。
  assert.ok(wxml.indexOf('bindtap="onSend"') < wxml.indexOf('③ 回答'), '发送按钮必须在回答区块之前')
  // 用药安全：模板不得引用任何可执行用量字段，只允许条数。
  for (const key of ['original_text', 'unit_text', 'method_text', 'precautions_text', 'formulation', 'content_hash']) {
    assert.equal(wxml.includes(key), false, `模板不得引用可执行用量字段 ${key}`)
  }
  assert.ok(/doseCards\.count/.test(wxml), '用量只允许报条数')
  // 不使用 rich-text：回答正文一律纯文本呈现。
  assert.equal(/rich-text/.test(wxml), false, '不得用 rich-text 渲染回答正文')
  // 样式不得使用 fixed/absolute（不遮挡发送按钮）。
  assert.equal(/position:\s*(fixed|absolute)/.test(css), false, '页面样式不得使用 fixed/absolute')
  // 触控下限必须用 px 令牌。
  assert.ok(/var\(--tap-min, 44px\)/.test(css), '触控下限必须沿用全局 px 令牌')
})

test('静态·textarea 显式 maxlength="-1"：微信原生默认 140 字，不写就等于静默截断', () => {
  const wxml = read('miniprogram/pages/qa/qa.wxml')
  const tags = wxml.match(/<textarea\b[\s\S]*?>/g) || []
  assert.equal(tags.length, 1, '本页应恰有一个 textarea')
  const tag = tags[0]
  // 原生组件默认 maxlength=140（微信官方组件文档）。必须显式写 -1 才是"不限"，否则用户输入会在 140 字被静默截断。
  assert.match(tag, /maxlength="-1"/, 'textarea 必须显式 maxlength="-1"，不能靠"不写"当无限输入')
  // 证据口径修正：不得再出现"不设 maxlength 才正确"的错误断言来源。
  assert.equal(/不设\s*maxlength/.test(wxml), false, '模板不得再宣称"不设 maxlength"就是对的')
  // 发送前仍按契约 8000 上限校验。
  const pageSource = read('miniprogram/pages/qa/qa.js')
  assert.ok(/> qaApi\.TEXT_MAX/.test(pageSource), '发送前必须仍按契约上限拒绝超长输入')
})

test('静态·面向用户的文案不暴露契约名/路径/状态机/幂等键/版本串', () => {
  const wxml = read('miniprogram/pages/qa/qa.wxml')
  const visible = wxml.replace(/<!--[\s\S]*?-->/g, '')
  const forbidden = [
    'TextTurnInput', 'SpeechTurnInput', 'GET /', 'POST /', '/conversations',
    'JobState', 'Idempotency-Key', '幂等键', 'check_state', 'status=',
    'unimplemented:no-real-', 'partial', 'no-real', 'revision', 'error_code'
  ]
  for (const token of forbidden) {
    assert.equal(visible.includes(token), false, `模板可见文案不得出现技术细节「${token}」`)
  }
  // 必要风险提示与"演示数据"标记必须保留。
  const api = read('miniprogram/utils/qa-api.js')
  assert.ok(/当前为演示数据/.test(api), '必须保留"当前为演示数据"的明确标记')
  assert.ok(/\{\{unwiredNote\}\}/.test(visible), '模板必须常驻展示演示数据/未接线说明')
  assert.ok(/不构成用药建议/.test(visible), '必须保留用药风险提示')
  assert.ok(/服务端能力未接线|还(没|没有)有接上真实服务/.test(api), '服务未接线必须如实说明')
  // 面向用户的错误/闸门文案同样不得暴露内部状态值。
  assert.equal(/check_state=' \+|status=' \+/.test(api), false, '闸门文案不得拼接内部状态值')
})
