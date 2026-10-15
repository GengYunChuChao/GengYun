'use strict'
// 耕云 · 本地真机/模拟器冒烟工具（只在本机手工运行，不提交依赖、不自动启动开发者工具）
// Local-tool only：本脚本**不在 CI 中执行**——CI 只对它做 `node --check` 语法校验
// （见 .github/workflows/local-wechat.yml），它也不在 npm `test:mini`／完整验收命令里。
// 它不等于真机业务、真实登录、AI、域名或比赛验收。
//
// 用法：
//   node tools/smoke-wechat.cjs <miniprogram-automator 模块目录> <local|release> [--expect-login-gate] [--timeout=<秒>]
//   node tools/smoke-wechat.cjs --dry-run          # 只回显从 app.json 读到的 Tab 期望，不连接任何目标
//   node tools/smoke-wechat.cjs --help
//
// 对齐口径（2026-10-15 的 5-Tab 自定义 tabBar + 登录门）：
//   1) Tab 期望**从 miniprogram/app.json 的 tabBar.list 读取**（顺序 + 用例说明），不硬编码。
//      app.json 里 tabBar.custom=true，底栏由 custom-tab-bar 组件渲染，页面中不存在与 Tab
//      文案一一对应的稳定元素 ⇒ 逐项 switchTab 后只断言 page.path 落回该 Tab 路由。
//      「Tab 文案断言」在自定义 tabBar 下不适用，本脚本有意不做（不为文案断言去猜选择器）。
//   2) **本脚本没有任何 `.title` 依赖**。就绪判据逐页取自页面的稳定类名（见 PAGE_MARKER）：
//      首页 hero 标题、社区页切换条、我的页档案头是各页独有且无条件渲染的；识别页与消息页的
//      专有内容块全部由 wx:if（guest／状态／数据）控制，没有「无条件且专有」的类名，退回全站
//      页头 .page-heading__title 作为「页面已渲染」判据，专有性由 page.path 相等断言承担。
//      （.title 在 reference／referenceseed／referenceseeddetail／referencedetail 也出现，
//      并非登录页专有——旧脚本把它当全局就绪判据时会把别的页面误判成「已就绪」。）
//   3) **先做 guest 预检，再进 Tab 循环**：Tab 循环之前先判定登录态；判定为未登录就立刻给
//      明确结论并以非零退出。被登录门接管一律**不记为 PASS**。只有显式传 --expect-login-gate
//      时才把「Tab 被导到登录页」当作预期结果记录（只验登录门本身的场景）。
//   4) **每一步 automator 调用都有超时**（默认 20 秒），报错带 BLOCKED_AT: <步骤名>；
//      另加整体总超时（默认 90 秒），总超时同样报出最后卡住的那一步。原因：
//      miniprogram-automator 的 `Connection.send` 自身**没有任何响应超时**（响应丢失时 Promise
//      永不 settle，只有 socket 关闭才会 reject），`MiniProgram.changeRoute` 又是
//      `callWxMethod(switchTab/reLaunch) + sleep(3000) + currentPage()` 这样多次无超时调用；
//      旧脚本没有单步/总超时，因此会在某一步无限挂起（曾 >9 分钟）。
//   5) 保留 {"platform":…,"SDKVersion":…} 输出，并按 platform 如实区分
//      真机（android/ios）与模拟器（devtools）；两者结论不可互相顶替。
//   6) 「本地替身诊断」两步检查（替身在线 ⇒ 成功；停掉替身 ⇒ 失败）只在**被走查副本的
//      apiBaseUrl = 本脚本临时启动的替身**时成立。真机走查常见拓扑是「副本基址 = 共享本地 API」
//      （如 http://10.205.195.4:3100/api/v1）：此时脚本既不能占用同一 host:port，也停不掉那台
//      服务，该步骤必然不成立。本脚本**不因此放宽断言**，只把原因说清楚，避免被误读成 Tab 失败。
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')

const ROOT = path.resolve(__dirname, '..')
const WS_ENDPOINT = 'ws://127.0.0.1:9420'
const WS_HOST = '127.0.0.1'
const WS_PORT = 9420
const LOGIN_ROUTE = 'pages/login/login'
const HOME_ROUTE = 'pages/home/home'
const APP_JSON = 'miniprogram/app.json'
const LOCAL_CONFIG = 'config/debug.local.json'
// 与 miniprogram/utils/auth.js 一致：requireLogin 的门是 `session === null || !networkEnabled()`，
// 会话缓存在这个 wx 存储键上（只读，不写入、不清理）。
const SESSION_KEY = 'gengyun.session'
const DEFAULT_TIMEOUT_MS = 90000
const STEP_TIMEOUT_MS = 20000
const CONNECT_STEP_MS = 15000
const READY_BUDGET_MS = 30000
const CONNECT_ATTEMPTS = 30
const ENDPOINT_PROBE_MS = 1500
const DIAGNOSE_BUTTON_TEXT = /检查本地替身连接/
// 登录门的落点由 miniprogram/utils/navigation.js 的 goLogin 决定：wx.reLaunch('/pages/login/login')。
const LOGIN_GATE_MECHANISM = 'utils/auth.requireLogin → utils/navigation.goLogin → wx.reLaunch("/' + LOGIN_ROUTE + '")'

// 逐页就绪判据（全部读 miniprogram/pages/*/*.wxml 后确定；**无一处使用 .title**）。
//   home      .hero__title        — home.wxml:13，无条件渲染；全仓库仅此一处
//   community .community-switch   — community.wxml:10，无条件；仅此一处
//   profile   .profile-header     — profile.wxml:10，无条件；仅此一处
//   identify  .page-heading__title — 该页专有块（任务状态／候选／剂量守卫…）全部受 wx:if 控制，
//   messages  .page-heading__title   没有无条件专有类名 ⇒ 用全站页头（12 页共用）证明「已渲染」，
//                                    专有性由紧随其后的 page.path 相等断言承担
//   login     .status             — login.wxml:8，无条件；**刻意不用 .title**（并非登录页专有）
const PAGE_MARKER = {
  'pages/home/home': '.hero__title',
  'pages/community/community': '.community-switch',
  'pages/identify/identify': '.page-heading__title',
  'pages/messages/messages': '.page-heading__title',
  'pages/profile/profile': '.profile-header',
  [LOGIN_ROUTE]: '.status'
}

const USAGE = [
  '用法：node tools/smoke-wechat.cjs <miniprogram-automator 模块目录> <local|release> [选项]',
  '      node tools/smoke-wechat.cjs --dry-run',
  '选项：',
  '  --dry-run             只回显从 ' + APP_JSON + ' 读到的 Tab 期望（含就绪判据），不连接目标',
  '  --expect-login-gate   只验登录门：把「Tab 被导到 ' + LOGIN_ROUTE + '」当作预期结果记录',
  '  --timeout=<秒>        总超时，默认 ' + Math.round(DEFAULT_TIMEOUT_MS / 1000) + ' 秒（允许 10–600）；单步上限 ' + Math.round(STEP_TIMEOUT_MS / 1000) + ' 秒',
  '  --help                输出本说明'
].join('\n')

function fail(message) {
  const error = new Error(message)
  error.smokeFailure = true
  throw error
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

// 最近一次开始执行的步骤名：单步超时用它报 BLOCKED_AT，总超时也用它报「卡在哪一步」。
let currentStep = '（尚未开始任何 automator 调用）'

// 单步超时：把任意 automator 调用包成有上限的 Promise。
// 超时后主动放弃该步并以 BLOCKED_AT 报错——不再让脚本无限挂起。
function bounded(name, factory, ms) {
  currentStep = name
  let timer = null
  const run = Promise.resolve().then(factory)
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('BLOCKED_AT: ' + name + ' —— automator 调用 ' + ms + 'ms 内没有响应，已被本脚本主动终止（不再无限等待）。\n' +
        '  机制：miniprogram-automator 的 Connection.send 自身没有响应超时，响应丢失时 Promise 永不 settle；\n' +
        '  旧脚本没有单步/总超时，所以会在这一步挂死。\n' +
        '  常见原因：真机息屏或小程序被挂起、真机调试会话被顶掉、guest 登录门的 reLaunch 与当前调用交叠。\n' +
        '  请确认目标在线、小程序在前台后重跑。')
      error.smokeFailure = true
      reject(error)
    }, ms)
  })
  return Promise.race([run, guard]).finally(() => { if (timer) clearTimeout(timer) })
}

// 只读探测自动化端口：用来把「连不上」区分为「工具没运行/没开服务端口」与「端口在但不接受连接」。
function probeEndpoint(host, port, ms) {
  return new Promise(resolve => {
    let settled = false
    const socket = net.connect({ host: host, port: port })
    const finish = ok => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch (_) {}
      resolve(ok)
    }
    socket.setTimeout(ms, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function parseArgs(argv) {
  const positional = []
  const options = { expectLoginGate: false, dryRun: false, timeoutMs: DEFAULT_TIMEOUT_MS, help: false }
  for (const arg of argv) {
    if (arg === '--expect-login-gate') options.expectLoginGate = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--timeout=')) {
      const seconds = Number(arg.slice('--timeout='.length))
      if (!Number.isFinite(seconds) || seconds < 10 || seconds > 600) fail('--timeout 必须是 10–600 之间的秒数（当前：' + arg + '）。\n' + USAGE)
      options.timeoutMs = Math.round(seconds * 1000)
    } else if (arg.startsWith('-')) fail('未知参数：' + arg + '\n' + USAGE)
    else positional.push(arg)
  }
  return { positional, options }
}

// Tab 期望完全来自 app.json：顺序与用例说明都不在本脚本里重复维护。
function readTabExpectation() {
  const file = path.join(ROOT, APP_JSON)
  let app
  try { app = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { fail('无法读取并解析 ' + APP_JSON + '：' + error.message) }
  const tabBar = app && app.tabBar
  const list = tabBar && tabBar.list
  if (!Array.isArray(list) || list.length === 0) fail(APP_JSON + ' 的 tabBar.list 缺失或为空，无法得到 Tab 期望。')
  const tabs = list.map((entry, index) => {
    if (!entry || typeof entry.pagePath !== 'string' || entry.pagePath === '') fail('tabBar.list[' + index + '] 缺少 pagePath。')
    if (typeof entry.text !== 'string' || entry.text === '') fail('tabBar.list[' + index + ']（' + entry.pagePath + '）缺少 text。')
    if (!PAGE_MARKER[entry.pagePath]) {
      fail('tabBar.list[' + index + '] 的页面 ' + entry.pagePath + ' 未在本脚本登记就绪判据。\n' +
        '  这是新增/改名的 Tab 页：请先读 miniprogram/' + entry.pagePath + '.wxml 选定一个稳定、专有的选择器，\n' +
        '  再把它加进本脚本的 PAGE_MARKER 后重跑（不要退回用 .title）。')
    }
    return { pagePath: entry.pagePath, text: entry.text }
  })
  return { tabs, custom: tabBar.custom === true }
}

// 如实判定当前连的是真机还是模拟器：只看 automator 返回的 platform。
function describeTarget(info) {
  const platform = info && info.platform
  const kind = platform === 'devtools' ? '模拟器' : (platform === 'android' || platform === 'ios' ? '真机' : '未知目标')
  const details = []
  if (info && info.model) details.push('model=' + info.model)
  if (info && info.system) details.push('system=' + info.system)
  if (info && info.version) details.push('微信版本=' + info.version)
  if (info && info.SDKVersion) details.push('基础库=' + info.SDKVersion)
  return {
    platform: platform,
    kind: kind,
    label: kind + '（platform=' + String(platform) + (details.length ? '，' + details.join('，') : '') + '）',
    isDevice: platform === 'android' || platform === 'ios'
  }
}

async function currentRoute(mini) {
  try {
    const page = await bounded('currentPage()', () => mini.currentPage(), STEP_TIMEOUT_MS)
    return page && typeof page.path === 'string' ? page.path : null
  } catch (error) {
    if (error && error.smokeFailure) throw error
    return null
  }
}

async function readElementText(page, selector) {
  if (!page) return null
  try {
    const element = await bounded('$("' + selector + '")', () => page.$(selector), STEP_TIMEOUT_MS)
    if (!element) return null
    return await bounded('element("' + selector + '").text()', () => element.text(), STEP_TIMEOUT_MS)
  } catch (error) {
    if (error && error.smokeFailure) throw error
    return null
  }
}

// 只读会话探测：不写入、不清理，也不依赖 app 内部模块。
async function readSession(mini) {
  return bounded('callWxMethod("getStorageSync", "' + SESSION_KEY + '")', () => mini.callWxMethod('getStorageSync', SESSION_KEY), STEP_TIMEOUT_MS)
}

function isSessionAbsent(value) {
  if (value === null || value === undefined || value === '') return true
  if (typeof value === 'object' && typeof value.accessToken !== 'string') return true
  return false
}

// 就绪门：等到当前页是已知路由且其判据已渲染。判据与后续断言同一套，不使用 .title。
async function waitForReadyPage(mini, target) {
  const started = Date.now()
  let lastRoute = '(尚未读到当前页)'
  let lastError = ''
  for (;;) {
    let page = null
    try { page = await bounded('currentPage()', () => mini.currentPage(), STEP_TIMEOUT_MS) } catch (error) {
      if (error && error.smokeFailure && /BLOCKED_AT/.test(error.message)) throw error
      lastError = error && error.message ? error.message : String(error)
    }
    if (page && typeof page.path === 'string') {
      lastRoute = page.path
      const marker = PAGE_MARKER[page.path]
      if (marker) {
        try { if (await bounded('$("' + marker + '")', () => page.$(marker), STEP_TIMEOUT_MS)) return page } catch (error) {
          if (error && error.smokeFailure && /BLOCKED_AT/.test(error.message)) throw error
        }
      }
    }
    if (Date.now() - started >= READY_BUDGET_MS) {
      fail('就绪门超时：' + Math.round(READY_BUDGET_MS / 1000) + ' 秒内没有看到任何一个已渲染的已知页面。\n' +
        '  当前目标：' + target.label + '\n' +
        '  最后观察到的路由：' + lastRoute + '\n' +
        '  判据：' + HOME_ROUTE + ' = ' + PAGE_MARKER[HOME_ROUTE] + '，登录页 = ' + PAGE_MARKER[LOGIN_ROUTE] + '（不使用 .title）\n' +
        (lastError ? '  最后一次读取当前页失败：' + lastError + '\n' : '') +
        '  请确认开发者工具已打开本工程，且已连上该' + target.kind + '后重跑。')
    }
    await delay(1000)
  }
}

// guest 预检：在进入 Tab 循环**之前**判定登录态，避免逐 Tab 切换把登录门的 reLaunch 与
// automator 调用交叠（那是真机挂死与误导性失败的主要来源）。
async function detectGuestState(mini) {
  const route = await currentRoute(mini)
  if (route === LOGIN_ROUTE) {
    return { guest: true, reason: '当前顶层页已经是 ' + LOGIN_ROUTE + '（只有登录门/退出会 reLaunch 到该页）' }
  }
  let session
  try {
    session = await readSession(mini)
  } catch (error) {
    if (error && error.smokeFailure && /BLOCKED_AT/.test(error.message)) throw error
    return { guest: null, reason: '无法读取本地会话（' + (error && error.message ? error.message : String(error)) + '），本步判定不确定' }
  }
  if (isSessionAbsent(session)) {
    return { guest: true, reason: '读不到本地会话（wx.getStorageSync("' + SESSION_KEY + '") 为空），requireLogin 会立即把受保护 Tab 导到登录页' }
  }
  return { guest: false, reason: '本地存在会话（是否通过服务端核实，由后续 Tab 循环与登录门共同体现）' }
}

async function findButtonByText(page, pattern) {
  let nodes = []
  try { nodes = await bounded('$$("button")', () => page.$$('button'), STEP_TIMEOUT_MS) } catch (error) {
    if (error && error.smokeFailure) throw error
    return null
  }
  if (!Array.isArray(nodes)) return null
  for (const node of nodes) {
    let text = ''
    try { text = await bounded('button.text()', () => node.text(), STEP_TIMEOUT_MS) } catch (error) {
      if (error && error.smokeFailure) throw error
      continue
    }
    if (pattern.test(String(text))) return node
  }
  return null
}

async function waitForHomeStatus(page, predicate, timeoutMs, description) {
  const started = Date.now()
  let last = null
  for (;;) {
    try { last = await bounded('page.data()', () => page.data(), STEP_TIMEOUT_MS) } catch (error) {
      if (error && error.smokeFailure && /BLOCKED_AT/.test(error.message)) throw error
      last = null
    }
    if (last && predicate(last)) return last
    if (Date.now() - started >= timeoutMs) {
      fail('等待超时（' + Math.round(timeoutMs / 1000) + ' 秒）：' + description + '\n' +
        '  最后观察到的 data.status = ' + JSON.stringify(last ? last.status : null) +
        '，data.busy = ' + JSON.stringify(last ? last.busy : null))
    }
    await delay(500)
  }
}

async function waitForServerReady(child, timeoutMs) {
  let timer = null
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => { throw new Error('本地诊断服务在就绪前退出') }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('本地诊断服务 ' + timeoutMs + 'ms 内未就绪')), timeoutMs) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function saveScreenshot(mini, name, note) {
  const file = path.join(ROOT, '.local', name)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    await bounded('screenshot(' + name + ')', () => mini.screenshot({ path: file }), STEP_TIMEOUT_MS)
    console.log('截图：' + path.relative(ROOT, file))
  } catch (error) {
    console.warn('NOTICE: 截图失败（' + note + '），不影响其它结论：' + (error && error.message ? error.message : String(error)))
  }
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2))
  if (options.help) { console.log(USAGE); return }

  const expectation = readTabExpectation()

  if (options.dryRun) {
    if (positional.length !== 0) fail('--dry-run 不接受 <SDK 模块目录> 与 <local|release> 参数。\n' + USAGE)
    console.log('DRY RUN（不连接任何目标）：Tab 期望来自 ' + APP_JSON + '，tabBar.custom=' + expectation.custom + '，共 ' + expectation.tabs.length + ' 项')
    expectation.tabs.forEach((tab, index) => {
      console.log('  [' + (index + 1) + '] ' + tab.pagePath + '  用例说明「' + tab.text + '」  就绪判据 ' + PAGE_MARKER[tab.pagePath])
    })
    if (expectation.custom) {
      console.log('  说明：tabBar.custom=true ⇒ 底栏由 custom-tab-bar 组件渲染，页面里没有与 Tab 文案一一对应的稳定元素，')
      console.log('        故本脚本只断言 page.path（＋页面就绪判据），不做 Tab 文案断言。')
    }
    return
  }

  if (positional.length !== 2) fail('参数数量不对（需要 <SDK 模块目录> 与 <local|release>）。\n' + USAGE)
  const [sdkDirectory, mode] = positional
  if (!['local', 'release'].includes(mode)) fail('第二个参数必须是 local 或 release（当前：' + mode + '）。\n' + USAGE)

  const automator = require(path.resolve(sdkDirectory))

  let mini = null
  let server = null
  let target = { label: '尚未取得 systemInfo 的目标', kind: '未知目标', platform: undefined, isDevice: false }

  function cleanup() {
    if (server && !server.killed) { try { server.kill() } catch (_) {} }
    server = null
    if (mini) {
      const connected = mini
      mini = null
      try { const result = connected.disconnect(); if (result && typeof result.catch === 'function') result.catch(() => {}) } catch (_) {}
    }
  }

  // 总超时：任何阶段（连接／就绪／切换／断言／本地服务）挂起都会被强制结束并明确报错。
  const deadline = setTimeout(() => {
    console.error('FAIL: 总超时——' + Math.round(options.timeoutMs / 1000) + ' 秒内未跑完。')
    console.error('  卡在哪一步：BLOCKED_AT: ' + currentStep)
    console.error('  当前目标：' + target.label)
    console.error('  连接端点：' + WS_ENDPOINT)
    console.error('  机制：' + LOGIN_GATE_MECHANISM + ' 之类的页面跳转与在途 automator 调用交叠时，')
    console.error('        miniprogram-automator 的响应可能永远不回来（Connection.send 无超时）；本脚本的单步上限 ' +
      Math.round(STEP_TIMEOUT_MS / 1000) + 's 与总超时 ' + Math.round(options.timeoutMs / 1000) + 's 是兜底。')
    cleanup()
    process.exitCode = 1
    // 已挂起的调用不会自己结束（守卫计时器最多还有 STEP_TIMEOUT_MS），给出短暂冲刷窗口后强制退出。
    setTimeout(() => process.exit(1), 500)
  }, options.timeoutMs)

  try {
    const listening = await probeEndpoint(WS_HOST, WS_PORT, ENDPOINT_PROBE_MS)
    if (!listening) {
      console.warn('NOTICE: ' + WS_ENDPOINT + ' 当前没有进程在监听——开发者工具可能没运行，或没在')
      console.warn('        「设置 → 安全」开启服务端口，或还没开始真机调试。本脚本仍会重试 ' + CONNECT_ATTEMPTS + ' 次。')
    }
    for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
      try {
        mini = await bounded('connect(' + WS_ENDPOINT + ')', () => automator.connect({ wsEndpoint: WS_ENDPOINT }), CONNECT_STEP_MS)
        break
      } catch (error) {
        if (attempt === CONNECT_ATTEMPTS) {
          const nowListening = await probeEndpoint(WS_HOST, WS_PORT, ENDPOINT_PROBE_MS)
          fail('连接 ' + WS_ENDPOINT + ' 失败（已尝试 ' + CONNECT_ATTEMPTS + ' 次）。\n' +
            '  端口现状：' + (nowListening
              ? '端口在监听，但仍未完成自动化握手（可能正要重启调试会话）。'
              : '端口上没有监听进程 ⇒ 微信开发者工具没有运行，或没开启服务端口，或没有处于调试/真机调试状态。') + '\n' +
            '  真机（platform=android/ios）与模拟器（platform=devtools）都需要开发者工具在运行并已开始调试；\n' +
            '  真机还要求手机端小程序停在调试会话里。两者结论不可互相顶替。\n' +
            '  最后一次错误：' + (error && error.message ? error.message : String(error)))
        }
        await delay(1000)
      }
    }
    if (!mini) fail('未能建立自动化连接（' + WS_ENDPOINT + '）。')

    // systemInfo() 是「通道是否真的活着」的最小探针：握手成功但这一步失败，说明小程序侧不响应，
    // 而不是 Tab 期望有问题——必须把这一点写清楚，且此时 platform 未知、不得硬说是真机或模拟器。
    let info
    try {
      info = await bounded('systemInfo()', () => mini.systemInfo(), STEP_TIMEOUT_MS)
    } catch (error) {
      fail('自动化通道已建立，但目标不响应：systemInfo() 失败 —— ' + (error && error.message ? error.message : String(error)) + '\n' +
        '  端点：' + WS_ENDPOINT + '（端口可连接，握手成功）\n' +
        '  当前目标：**尚未取得 platform ⇒ 无法判定是真机还是模拟器**（真机 android/ios 与模拟器 devtools 的结论不可互相顶替）\n' +
        '  含义：WebSocket 通、开发者工具也在，但小程序侧没有回应最基础的 automator 调用（systemInfo／currentPage 都不回应）。\n' +
        '  常见原因：真机息屏或小程序被挂起/切到后台、真机调试会话已断开或被另一个自动化会话顶掉、调试会话刚结束需要重新「真机调试」。\n' +
        '  处理：把小程序切到前台并保持屏幕常亮后重跑。**这条与 Tab 期望无关，不要据此改本脚本的 PAGE_MARKER 或 app.json。**')
    }
    target = describeTarget(info)
    console.log(JSON.stringify({ platform: info && info.platform, SDKVersion: info && info.SDKVersion }))
    console.log('目标：' + target.label)
    if (!target.isDevice) {
      console.warn('NOTICE: platform=' + String(target.platform) + ' 表示当前连的是模拟器；真机验证需要 platform=android 或 ios，两者结论不可互相顶替。')
    }

    await waitForReadyPage(mini, target)

    // --- guest 预检（在 Tab 循环之前）---
    const guest = await detectGuestState(mini)
    if (guest.guest === true && !options.expectLoginGate) {
      console.error('GUEST_STATE: 未登录（游客）态 — ' + guest.reason + '；Tab 会被导到 ' + LOGIN_ROUTE + '，请在' +
        target.kind + '登录后重跑。')
      console.error('  当前目标：' + target.label)
      console.error('  依据：' + LOGIN_GATE_MECHANISM)
      console.error('  结论：Tab 循环未执行（guest 时每个受保护 Tab 都会被登录门顶掉，automator 调用还可能丢响应）。')
      await saveScreenshot(mini, 'wechat-' + mode + '-guest-gate.png', 'guest 登录门证据')
      fail('GUEST_STATE: 当前连接的' + target.label + '处于未登录（游客）态，未取得任何 Tab 迭代结果。\n' +
        '  这不是本脚本的通过条件。请在' + target.kind + '的微信里完成登录后重跑；\n' +
        '  如果本次只想验证登录门本身（不要求 Tab 渲染），请显式加 --expect-login-gate。')
    }
    if (guest.guest === true) {
      console.log('NOTICE (--expect-login-gate)：已确认未登录态 — ' + guest.reason + '；下面逐 Tab 记录登录门行为。')
    } else if (guest.guest === null) {
      console.warn('NOTICE: guest 预检不确定（' + guest.reason + '）；继续逐 Tab 核对，由落点自行体现。')
    } else {
      console.log('guest 预检：' + guest.reason)
    }

    // --- Tab 期望逐项核对（顺序与用例说明来自 app.json）---
    const gated = []
    const rendered = []
    // 被登录门接管：默认只登记，循环结束后统一按 GUEST_STATE 处理；--expect-login-gate 时才记 PASS。
    const noteGated = async (tab) => {
      const titleText = await readElementText(await bounded('currentPage()', () => mini.currentPage(), STEP_TIMEOUT_MS), PAGE_MARKER[LOGIN_ROUTE])
      gated.push({ tab: tab, titleText: titleText })
      if (options.expectLoginGate) {
        console.log('PASS (--expect-login-gate) tab ' + tab.pagePath + '（app.json 用例说明「' + tab.text + '」）在未登录时被导到 ' +
          LOGIN_ROUTE + '（' + PAGE_MARKER[LOGIN_ROUTE] + '="' + String(titleText) + '"）')
      }
    }
    for (const tab of expectation.tabs) {
      // switchTab 返回的是切换后（automator 内部固定 3 秒）的当前页；丢响应会报 BLOCKED_AT。
      let page = null
      try {
        page = await bounded('switchTab("/' + tab.pagePath + '")', () => mini.switchTab('/' + tab.pagePath), STEP_TIMEOUT_MS)
      } catch (error) {
        if (error && error.smokeFailure && /BLOCKED_AT/.test(error.message)) throw error
        fail('switchTab("/' + tab.pagePath + '") 失败（app.json 用例说明「' + tab.text + '」）。\n' +
          '  当前目标：' + target.label + '\n' +
          '  错误：' + (error && error.message ? error.message : String(error)))
      }
      const route = page && typeof page.path === 'string' ? page.path : await currentRoute(mini)
      if (route === LOGIN_ROUTE) { await noteGated(tab); continue }
      if (route !== tab.pagePath) {
        fail('Tab 落点不符：switchTab("/' + tab.pagePath + '")（app.json 用例说明「' + tab.text + '」）之后当前页是 ' + String(route) + '。\n' +
          '  当前目标：' + target.label + '\n' +
          '  期望落点：' + tab.pagePath + '（未登录时也可能是 ' + LOGIN_ROUTE + '，但那会按 GUEST_STATE 处理）')
      }
      const marker = PAGE_MARKER[tab.pagePath]
      if (!page) page = await bounded('currentPage()', () => mini.currentPage(), STEP_TIMEOUT_MS)
      if (!(await bounded('$("' + marker + '")', () => page.$(marker), STEP_TIMEOUT_MS))) {
        fail('Tab 页未渲染就绪判据 ' + marker + '：' + tab.pagePath + '（app.json 用例说明「' + tab.text + '」）。\n' +
          '  当前目标：' + target.label + '\n' +
          '  说明：本脚本不使用 .title 判断 Tab 页；若该页改用别的稳定类名，请同步更新本脚本的 PAGE_MARKER。')
      }
      // 断言之后再取一次：避免登录门在就绪判据之后才 reLaunch 走。
      if (await currentRoute(mini) === LOGIN_ROUTE) { await noteGated(tab); continue }
      rendered.push(tab)
      console.log('PASS rendered tab: ' + tab.pagePath + '（app.json 用例说明「' + tab.text + '」，就绪判据 ' + marker + '）')
    }

    if (gated.length > 0 && !options.expectLoginGate) {
      for (const hit of gated) {
        console.error('GUEST_STATE: tab ' + hit.tab.pagePath + '（app.json 用例说明「' + hit.tab.text + '」）被导到 ' + LOGIN_ROUTE +
          '（' + PAGE_MARKER[LOGIN_ROUTE] + '="' + String(hit.titleText) + '"），未取得该 Tab 的渲染结果，不计 PASS。')
      }
      await saveScreenshot(mini, 'wechat-' + mode + '-guest-gate.png', 'guest 登录门证据')
      fail('GUEST_STATE: 当前连接的' + target.label + '处于未登录（游客）态：' + gated.length + '/' + expectation.tabs.length +
        ' 个 Tab 被 ' + LOGIN_ROUTE + ' 的登录门接管（另有 ' + rendered.length + ' 个 Tab 正常渲染）。\n' +
        '  这不是本脚本的通过条件。请在' + target.kind + '的微信里完成登录后重跑；\n' +
        '  如果本次只想验证登录门本身（不要求 Tab 渲染），请显式加 --expect-login-gate。')
    }
    if (gated.length > 0 && options.expectLoginGate) {
      console.log('PASS --expect-login-gate：' + gated.length + ' 个 Tab 在未登录时被 ' + LOGIN_ROUTE + ' 接管，' + rendered.length + ' 个 Tab 正常渲染。')
    }

    // --- 首页与本地替身诊断（沿用原有语义，只把选择器与失败原因改成随当前工程可定位的写法）---
    let home = null
    try {
      home = await bounded('switchTab("/' + HOME_ROUTE + '")', () => mini.switchTab('/' + HOME_ROUTE), STEP_TIMEOUT_MS)
    } catch (error) {
      if (error && error.smokeFailure && /BLOCKED_AT/.test(error.message)) throw error
      fail('无法回到首页 ' + HOME_ROUTE + '（未登录时首页是唯一可预览的 Tab）。\n' +
        '  当前目标：' + target.label + '\n  错误：' + (error && error.message ? error.message : String(error)))
    }
    if ((home && home.path) !== HOME_ROUTE) home = await bounded('currentPage()', () => mini.currentPage(), STEP_TIMEOUT_MS)
    if (!home || home.path !== HOME_ROUTE) {
      fail('无法回到首页 ' + HOME_ROUTE + '（未登录时首页是唯一可预览的 Tab）。\n' +
        '  当前目标：' + target.label + '，当前路由：' + String(home && home.path))
    }
    const homeMarker = PAGE_MARKER[HOME_ROUTE]
    if (!(await bounded('$("' + homeMarker + '")', () => home.$(homeMarker), STEP_TIMEOUT_MS))) {
      fail('首页未渲染就绪判据 ' + homeMarker + '。\n  当前目标：' + target.label)
    }
    const local = await bounded('home.data("local")', () => home.data('local'), STEP_TIMEOUT_MS)
    if (local !== (mode === 'local')) {
      fail('工程准备模式不符：首页 data.local=' + JSON.stringify(local) + '，但脚本以 ' + mode + ' 模式运行。\n' +
        '  当前目标：' + target.label + '\n' +
        '  说明：data.local=true 仅当 miniprogram/config/runtime.js 的 mode=local 且 envVersion=develop。\n' +
        '  请先 node tools/prepare-wechat.mjs ' + mode + (mode === 'local' ? ' --config <已生成配置>' : '') +
        '，再在开发者工具里打开生成的 import root 重跑（不要在共享源码上跑 ' + mode + ' 模式）。')
    }

    if (mode === 'local') {
      // 无 wx mock：走真实请求与失败/重试状态。
      // 拓扑前提：被走查副本的 apiBaseUrl 必须等于本脚本临时启动的替身地址，两段式检查才成立。
      const localConfigFile = path.join(ROOT, LOCAL_CONFIG)
      const topologyNote = '  拓扑：本步骤要求「被走查副本的 apiBaseUrl = 本脚本临时替身」，而 `' + LOCAL_CONFIG + '` 决定替身绑定的地址。\n' +
        '  真机走查常见拓扑是「副本基址 = 共享本地 API」（如 http://10.205.195.4:3100/api/v1）：此时脚本既不能占用同一 host:port，\n' +
        '  也停不掉那台服务，两段式检查必然不成立。这不是 Tab 对齐失败——Tab 结果见上面的 PASS／GUEST_STATE 行。\n'
      if (!fs.existsSync(localConfigFile)) {
        console.warn('NOTICE: 缺少 ' + LOCAL_CONFIG + '（本机尚未生成被忽略的本地替身配置），下面的本地替身诊断预计无法成立。')
      }
      server = spawn(process.execPath, ['tools/local-debug-server.mjs', '--config', LOCAL_CONFIG],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
      try {
        await waitForServerReady(server, 5000)
      } catch (error) {
        fail('本地替身诊断无法进行：' + (error && error.message ? error.message : String(error)) + '\n' +
          '  当前目标：' + target.label + '\n' + topologyNote +
          '  提示：' + LOCAL_CONFIG + ' 缺失或该 host:port 已被共享本地 API 占用时，请改用与走查副本一致的拓扑复核该诊断。')
      }
      const button = await findButtonByText(home, DIAGNOSE_BUTTON_TEXT)
      if (!button) {
        fail('本地替身工程首页没有「检查本地替身连接」按钮，无法验证本地诊断。\n' +
          '  当前目标：' + target.label + '\n' +
          '  该按钮由首页 wx:if="{{local}}" 的「开发工具」区渲染；请确认打开的是 .local/wechat-local 准备包。')
      }
      await bounded('button("检查本地替身连接").tap()', () => button.tap(), STEP_TIMEOUT_MS)
      const success = await waitForHomeStatus(home,
        data => !data.busy && /连接成功|连接失败|不符合/.test(String(data.status)), 10000,
        '点击「检查本地替身连接」后应出现终态 status')
      if (!/本地替身连接成功/.test(String(success.status))) {
        fail('本地替身诊断未成功：data.status = ' + JSON.stringify(success.status) + '\n' +
          '  当前目标：' + target.label + '\n' + topologyNote)
      }
      console.log('PASS 本地替身 HTTP 实际请求成功，且已明确标注为替身（synthetic）')
      const exited = once(server, 'exit')
      server.kill()
      await exited
      server = null
      await bounded('button("检查本地替身连接").tap() (服务已停止)', () => button.tap(), STEP_TIMEOUT_MS)
      const failed = await waitForHomeStatus(home, data => /连接失败/.test(String(data.status)), 10000,
        '停掉本地服务后点击同一按钮应回到失败态')
      console.log('PASS 本地服务停止后的失败态与按钮可复用：data.status = ' + JSON.stringify(failed.status))
    } else {
      if (await findButtonByText(home, DIAGNOSE_BUTTON_TEXT)) {
        fail('release 模式的首页不应出现「检查本地替身连接」按钮。\n  当前目标：' + target.label)
      }
      console.log('PASS release 准备包没有本地诊断按钮')
    }

    await saveScreenshot(mini, 'wechat-' + mode + '-smoke.png', '冒烟完成证据')
    console.log('PASS 本地冒烟完成：目标 ' + target.label + '（Tab 用例来自 ' + APP_JSON + '，' + expectation.tabs.length + ' 项，自定义 tabBar=' + expectation.custom + '）')
    console.log('PASS 免责：仅本机自动化走查，不构成真机业务、真实登录、AI、域名或比赛验收。')
  } finally {
    clearTimeout(deadline)
    cleanup()
  }
}

main().catch(error => {
  if (error && error.smokeFailure) console.error('FAIL: ' + error.message)
  else console.error('FAIL: 未预期的错误：' + (error && error.stack ? error.stack : String(error)))
  process.exitCode = 1
})
