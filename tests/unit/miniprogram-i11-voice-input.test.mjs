// GY-I11「语音输入」本片（D2）回归：录音**本机临时文件**的回收、上传作废/失败/超限/非 real 模式
// 的收尾、`transcriptMediaRef` 不拼伪引用，以及 `voice-api` 的 401/403 归因**不得折叠**。
//
// 被测对象是仓库里的**真代码**（`miniprogram/pages/voice/voice.js`、`miniprogram/utils/voice-api.js`）；
// 被替换的只有平台与其它域的边界：`wx`、门禁、鉴权、`identify-api`、录音端口。
// 因此这些用例证明的是**本页自己的收尾行为**，不冒充真机录音/真实对象存储/真实 ASR 的验收
// （那三件事的证据面分别是 issue #23、`services/api` 的存储接线与本文件的「不做」清单）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UTILS = join(ROOT, 'miniprogram', 'utils')
const VOICE_PAGE = join(ROOT, 'miniprogram', 'pages', 'voice', 'voice.js')
const JOB_ID = '00000000-0000-4000-8000-000000000000'
const MEDIA_ID = '00000000-0000-4000-8000-0000000000vv'

/** 在受控环境里加载仓库真模块（CommonJS 源码按文件编译，依赖由调用方注入）。 */
function loadModule(file, resolveDep, cache) {
  const store = cache || new Map()
  if (store.has(file)) return store.get(file)
  const module = { exports: {} }
  store.set(file, module.exports)
  const wrapper = vm.compileFunction(readFileSync(file, 'utf8'), ['module', 'exports', 'require', '__filename', '__dirname'], { filename: file })
  wrapper(module, module.exports, resolveDep, file, dirname(file))
  store.set(file, module.exports)
  return module.exports
}

/** 把在途 promise 链推到底。 */
async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

function makeAuth(cleared) {
  return {
    isLoggedIn: () => true,
    getSession: () => ({ accessToken: 'synthetic-token' }),
    sessionEpoch: () => 'epoch-1',
    networkEnabled: () => true,
    requireLogin: (callback) => callback(true),
    clearSession: () => { cleared.push(true) }
  }
}

// ------------------------------------------------------------------ voice-api：401/403 归因

/**
 * 真实 `miniprogram/utils/voice-api.js` + 探针 `wx.request`。
 * 只替换三个外部边界（`./auth`、`../config/runtime`、`./debug`）与平台 `wx`。
 */
function loadVoiceApi() {
  const cleared = []
  const requests = []
  const auth = makeAuth(cleared)
  const runtime = { mode: 'local', apiBaseUrl: 'http://127.0.0.1:3000' }
  const debug = { localEnabled: () => false }
  const wxApi = { request: (options) => { requests.push(options) } }
  globalThis.wx = wxApi
  const api = loadModule(join(UTILS, 'voice-api.js'), (id) => {
    const base = id.split('/').pop()
    if (base === 'auth') return auth
    if (base === 'runtime') return runtime
    if (base === 'debug') return debug
    throw new Error('unexpected require: ' + id)
  })
  return { api, requests, cleared: () => cleared.length, dispose: () => { delete globalThis.wx } }
}

/** 发出一个 GET /jobs/{id} 并让平台返回给定状态码/错误封套。 */
async function rejectWith(harness, statusCode, code) {
  const pending = harness.api.getJob(JOB_ID)
  await flush(2)
  assert.equal(harness.requests.length, 1, '应当只发出一个请求')
  assert.equal(harness.requests[0].url, 'http://127.0.0.1:3000/jobs/' + JOB_ID)
  harness.requests[0].success({ statusCode, data: { error: { code, message: '合成错误封套', retryable: false } } })
  return pending
}

test('voice-api·403 CONSENT_REQUIRED 不得折叠成 401，且不得清本地会话', async () => {
  const harness = loadVoiceApi()
  try {
    const pending = rejectWith(harness, 403, 'CONSENT_REQUIRED')
    await assert.rejects(pending, (error) => error.code === 'CONSENT_REQUIRED' && error.status === 403)
    assert.equal(harness.cleared(), 0, '403 CONSENT_REQUIRED 指向「去授权」，清会话会让用户连授权入口都失去')
  } finally {
    harness.dispose()
  }
})

test('voice-api·403 SCOPE_DENIED 同样如实透传（不是「登录失效」）', async () => {
  const harness = loadVoiceApi()
  try {
    const pending = rejectWith(harness, 403, 'SCOPE_DENIED')
    await assert.rejects(pending, (error) => error.code === 'SCOPE_DENIED' && error.status === 403)
    assert.equal(harness.cleared(), 0)
  } finally {
    harness.dispose()
  }
})

test('voice-api·401 SESSION_EXPIRED 归到会话失效（这是唯一该清会话的一类）', async () => {
  const harness = loadVoiceApi()
  try {
    const pending = rejectWith(harness, 401, 'SESSION_EXPIRED')
    await assert.rejects(pending, (error) => error.code === 'SESSION_REQUIRED' && error.status === 401)
    assert.equal(harness.cleared(), 1, '会话失效类错误才允许清本地会话')
  } finally {
    harness.dispose()
  }
})

// ------------------------------------------------------------------ 语音页：临时文件回收

/**
 * 加载真实语音页。`options`：
 *   - `stopResult`：端口 `stop()` 交回的产物覆盖（默认一条 3.2 秒的 aac）；
 *   - `uploadError`：`uploadVoiceQuestion` 的失败码；
 *   - `serverMode`：`identifyApi.serverMode()` 的读数（默认 `real`）；
 *   - `noFs`：平台**不提供**文件系统能力（老基础库）；
 *   - `fileSize`：`wx.getFileInfo` 报出的字节数。
 */
function loadVoicePage(options = {}) {
  const requests = []
  const toasts = []
  const sets = []
  const unlinks = []
  const portCalls = []
  const uploads = []
  const cleared = []

  const auth = makeAuth(cleared)
  const runtime = { mode: 'local', apiBaseUrl: 'http://127.0.0.1:3000' }
  const debug = { localEnabled: () => false }
  const pageGate = { start: (page, callback) => callback(true), cancel: () => {} }
  const fontScale = { applyFontScale: () => {}, currentFontScale: () => 1, DEFAULT_FONT_SCALE: 1 }

  const product = Object.assign(
    { ok: true, tempFilePath: 'wxfile://tmp/record-1.aac', durationMs: 3200, mime: 'audio/mp4', format: 'aac' },
    options.stopResult || {}
  )
  const recorderPort = {
    support: () => ({ ok: true, note: '录音能力可用（端口探针）', maxDurationMs: 60000 }),
    createRecorderPort: () => ({
      available: true,
      start: (startOptions) => { portCalls.push({ api: 'start', options: startOptions }); return Promise.resolve({ ok: true }) },
      stop: () => { portCalls.push({ api: 'stop' }); return Promise.resolve(product) },
      release: () => { portCalls.push({ api: 'release' }) }
    })
  }
  const identifyApi = {
    VOICE_MEDIA_PURPOSE: 'voice_question',
    serverMode: () => Promise.resolve(options.serverMode === undefined ? 'real' : options.serverMode),
    uploadVoiceQuestion: (tempFilePath, declaration) => {
      uploads.push({ tempFilePath, declaration: Object.assign({}, declaration) })
      if (options.uploadError) {
        const error = new Error(options.uploadError)
        error.code = options.uploadError
        error.status = 503
        return Promise.reject(error)
      }
      return Promise.resolve({ mediaId: MEDIA_ID, mediaRevision: 1 })
    }
  }

  const wxApi = {
    request: (requestOptions) => { requests.push(requestOptions) },
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop' } }),
    showToast: (toast) => { toasts.push(toast) },
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    getSetting: (settingOptions) => {
      if (settingOptions && settingOptions.success) settingOptions.success({ authSetting: { 'scope.record': true } })
    },
    getRecorderManager: () => { throw new Error('本套用例不触达 wx.getRecorderManager（端口已替身）') },
    getFileSystemManager: options.noFs === true
      ? undefined
      : () => ({ unlink: (unlinkOptions) => { unlinks.push(unlinkOptions.filePath) } }),
    getFileInfo: (infoOptions) => {
      if (infoOptions && infoOptions.success) {
        infoOptions.success({ size: options.fileSize === undefined ? 4096 : options.fileSize, digest: 'a'.repeat(64) })
      }
    }
  }

  const cache = new Map()
  const resolveDep = (id) => {
    const base = id.split('/').pop()
    if (base === 'page-gate') return pageGate
    if (base === 'font-scale') return fontScale
    if (base === 'auth') return auth
    if (base === 'debug') return debug
    if (base === 'runtime') return runtime
    if (base === 'identify-api') return identifyApi
    if (base === 'recorder-port') return recorderPort
    // `speech-autoplay`（#394 / R28-C6 引入的自动播报策略）同样是真实模块；
    // 它在本片基点还不存在，合流 main 后语音页会 require 它，故一并按真实实现加载。
    if (['speech-text', 'audio-playback', 'inner-audio-port', 'substitute-player', 'voice-api', 'speech-transcript', 'speech-autoplay'].includes(base)) {
      return loadModule(join(UTILS, base + '.js'), resolveDep, cache)
    }
    throw new Error('unexpected require: ' + id)
  }

  globalThis.wx = wxApi
  let definition = null
  globalThis.Page = (value) => { definition = value }
  try {
    loadModule(VOICE_PAGE, resolveDep, cache)
  } finally {
    delete globalThis.Page
  }
  assert.ok(definition, '语音页必须注册 Page')

  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); sets.push(patch) },
    route: 'pages/voice/voice'
  })

  return {
    page, requests, toasts, sets, unlinks, portCalls, uploads, wx: wxApi,
    boot: async () => { page.onLoad(); page.onShow(); await flush(4) },
    unload: () => { page.onUnload(); delete globalThis.wx }
  }
}

test('上传成功 ⇒ 本机临时录音被回收（正文只在服务端，用 media_id 引用）', async () => {
  const harness = loadVoicePage()
  try {
    await harness.boot()
    await harness.page.startRecording()
    await harness.page.stopAndUpload()
    await flush()

    assert.equal(harness.uploads.length, 1)
    assert.equal(harness.uploads[0].declaration.durationMs, 3200)
    assert.equal(harness.page.data.uploadedMediaId, MEDIA_ID)
    assert.equal(harness.page.data.uploadedMediaRevision, 1)
    assert.deepEqual(harness.unlinks, ['wxfile://tmp/record-1.aac'], '上传成功后本机副本必须被删掉')
    assert.equal(harness.page._recTempFilePath, '', '登记的临时路径必须一并清空（否则会重复删/泄漏）')
  } finally {
    harness.unload()
  }
})

test('上传失败 ⇒ 仍须回收本机临时录音，并如实给出错误码', async () => {
  const harness = loadVoicePage({ uploadError: 'PROVIDER_UNAVAILABLE' })
  try {
    await harness.boot()
    await harness.page.startRecording()
    await harness.page.stopAndUpload()
    await flush()

    assert.equal(harness.uploads.length, 1)
    assert.equal(harness.page.data.recordState, 'failed')
    assert.equal(harness.page.data.uploadErrorCode, 'PROVIDER_UNAVAILABLE')
    assert.deepEqual(harness.unlinks, ['wxfile://tmp/record-1.aac'], '失败路径同样不许留临时文件')
    assert.equal(harness.page.data.uploadedMediaId, null)
    assert.equal(harness.page.data.uploadedMediaRevision, 0, '失败后 revision 不得残留（会拼出伪引用）')
  } finally {
    harness.unload()
  }
})

test('非 real 执行模式 ⇒ 不上传、不发明 media_id，且丢弃本机临时录音', async () => {
  const harness = loadVoicePage({ serverMode: 'stub' })
  try {
    await harness.boot()
    await harness.page.startRecording()
    await harness.page.stopAndUpload()
    await flush()

    assert.equal(harness.uploads.length, 0, 'stub 模式下没有真实对象存储，不得假装上传')
    assert.equal(harness.page.data.uploadedMediaId, null)
    assert.equal(harness.page.data.recordStageNote.includes('未接线'), true)
    assert.deepEqual(harness.unlinks, ['wxfile://tmp/record-1.aac'])
  } finally {
    harness.unload()
  }
})

test('时长超过契约上限 ⇒ 零上传请求且丢弃本机临时录音', async () => {
  const harness = loadVoicePage({ stopResult: { durationMs: 61000 } })
  try {
    await harness.boot()
    await harness.page.startRecording()
    await harness.page.stopAndUpload()
    await flush()

    assert.equal(harness.uploads.length, 0, '超限录音不得发出 POST /media/uploads')
    assert.equal(harness.page.data.uploadErrorCode, 'INVALID_INPUT')
    assert.deepEqual(harness.unlinks, ['wxfile://tmp/record-1.aac'])
  } finally {
    harness.unload()
  }
})

test('录音中离页 ⇒ 释放录音端口、复位上传号、丢弃已登记的临时文件', async () => {
  const harness = loadVoicePage()
  try {
    await harness.boot()
    await harness.page.startRecording()
    // 「已拿到产物、上传尚未落定」的中间态：临时文件此刻已经由本页负责。
    harness.page._recTempFilePath = 'wxfile://tmp/record-mid.aac'
    harness.page.data.uploadedMediaId = MEDIA_ID
    harness.page.data.uploadedMediaRevision = 4
    harness.page.onUnload()

    assert.equal(harness.portCalls.some((call) => call.api === 'release'), true, '离页必须释放麦克风')
    assert.deepEqual(harness.unlinks, ['wxfile://tmp/record-mid.aac'])
    assert.equal(harness.page.data.uploadedMediaRevision, 0, '上传号必须成对复位（id + revision）')
    assert.equal(harness.page.data.recordState, 'idle')
  } finally {
    delete globalThis.wx
  }
})

test('平台不提供文件系统能力 ⇒ 丢弃动作静默跳过：不抛、不谎称已删除', async () => {
  const harness = loadVoicePage({ noFs: true })
  try {
    await harness.boot()
    harness.page._recTempFilePath = 'wxfile://tmp/record-2.aac'
    let result
    assert.doesNotThrow(() => { result = harness.page.discardRecordFile() })
    assert.equal(result, false)
    assert.equal(harness.page._recTempFilePath, '', '路径仍要清掉，避免每帧重复尝试')
    assert.deepEqual(harness.unlinks, [])
  } finally {
    harness.unload()
  }
})

// ------------------------------------------------------------------ 转写引用：不得拼伪引用

test('transcriptMediaRef·上传号被复位后不得拼出 media_id:null 的伪引用', async () => {
  const harness = loadVoicePage()
  try {
    await harness.boot()
    harness.page.data.selectedTranscriptSampleId = ''
    // 旧缺陷现场：离页把 uploadedMediaId 复位成 null，但 revision 残留 ⇒ `null !== ''` 恒真。
    harness.page.data.uploadedMediaId = null
    harness.page.data.uploadedMediaRevision = 3
    assert.equal(harness.page.transcriptMediaRef(), null, '取不到真实上传号时必须返回 null（不发转写）')

    harness.page.data.uploadedMediaId = MEDIA_ID
    harness.page.data.uploadedMediaRevision = 2
    assert.deepEqual(harness.page.transcriptMediaRef(), { media_id: MEDIA_ID, media_revision: 2 })
  } finally {
    harness.unload()
  }
})
