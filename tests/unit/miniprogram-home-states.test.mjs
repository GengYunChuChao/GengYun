// R59 首页多态（loading / 空 / 出错 / 游客 / 离线）现状钉。
//
// 钉的是**当前检出**的事实，不是期望形态。本片只取证、不修缺口：
//   首页 `pages/home/home.js` 一共只发两类请求——`auth.verifySession`（核实登录态，无 timeout）
//   与 `debug.diagnose`（本地替身自检，5000ms，仅 mode=local + envVersion=develop 可见）。
//   首页正文（hero / 三张能力卡 / 底部资料入口）是**写死的静态内容**，不取任何服务端数据，
//   因此没有「首屏加载中」，没有「空结果」，也没有「正文加载失败」。
//   服务端的数据面 `GET /public/home` 已建好（空 `previews: []` 与 503 可区分，
//   见 `tests/unit/public-home.test.mjs`），但端上**只手读它的 `meta` 判断执行模式**
//   （`miniprogram/utils/identify-api.js:776`），`data.previews` / `data.human_review_state`
//   在整个 `miniprogram/` 里 0 次引用。
//
// 因此本文件的断言分两类，证据页 `docs/verification/r59-mp-home-states-20261026.md` 里逐条标明：
//   ① 存在性/文案精确值 —— 现状就该这样，改坏即红（负控制已验证）。
//   ② 缺失钉（absent pin）—— 钉住「现在没有」，等着被未来某片补齐时变红提醒更新证据，**不是期望**。
//
// 只读源码字符串 + JSON.parse，不装载小程序运行时，不起 vm 夹具：首页没有可执行的数据流可跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '../..')
const read = (relative) => readFileSync(resolve(ROOT, relative), 'utf8')

/** 递归收集 miniprogram/ 下指定扩展名的文件（用于断言全仓范围的缺失）。 */
function miniprogramFiles(extension) {
  const collected = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.name.endsWith(extension)) collected.push(absolute)
    }
  }
  walk(resolve(ROOT, 'miniprogram'))
  return collected
}

// —— 1. loading 态 ———————————————————————————————————————————————————

test('L1 首页正文没有 loading 分支：全页只有一处 loading，且在 local 开发块内', () => {
  const js = read('miniprogram/pages/home/home.js')
  const wxml = read('miniprogram/pages/home/home.wxml')
  // 首页自己不发请求 ⇒ 不可能有首屏加载态。这不是遗漏，是当前实现的事实。
  assert.equal((js.match(/wx\.request/g) || []).length, 0, 'home.js 当前 0 处 wx.request')
  // 全页 status= 恰好三处，按出现顺序：stub（常驻说明）→ loading → error。
  assert.deepEqual(
    [...wxml.matchAll(/status="([^"]*)"/g)].map((match) => match[1]),
    ['stub', 'loading', 'error'],
    '首页的 state-view 位置与顺序是写死的三处'
  )
  // 唯一的 loading 只能在 `wx:if="{{local}}"` 之内（本地替身诊断，develop + mode=local 才可见）。
  const localBlock = wxml.indexOf('wx:if="{{local}}"')
  const loading = wxml.indexOf('status="loading"')
  assert.ok(localBlock > 0, '必须找到本地工具块')
  assert.ok(loading > localBlock, 'loading 不得出现在本地工具块之外')
  // 没有骨架屏/转圈：整个页面模板不含 skeleton / spinner 类。
  assert.equal(/skeleton|spinner/.test(wxml), false)
})

test('L2 诊断 loading 的触发方式与文案是精确值', () => {
  const wxml = read('miniprogram/pages/home/home.wxml')
  // 按钮自己带 loading 与 disabled 双闸，同一 busy 布尔。
  assert.match(wxml, /bindtap="diagnose"\n\s+loading="\{\{busy\}\}"\n\s+disabled="\{\{busy\}\}"/)
  const loadingIndex = wxml.indexOf('status="loading"')
  const titleIndex = wxml.indexOf('title="正在检查本地替身连接"')
  const descIndex = wxml.indexOf('desc="正在读取本地诊断服务状态，请稍候。"')
  assert.ok(loadingIndex >= 0, 'loading 态必须存在')
  assert.ok(titleIndex > loadingIndex, 'loading 标题必须紧跟 loading 状态属性')
  assert.ok(descIndex > titleIndex, 'loading 说明必须紧跟标题')
})

// —— 2. 出错态与重试 ————————————————————————————————————————————————

test('E1 诊断失败走 error 态，但页面上没有重试入口（现状缺口，非期望）', () => {
  const wxml = read('miniprogram/pages/home/home.wxml')
  assert.match(wxml, /wx:elif="\{\{diagPassed === false\}\}"/)
  assert.match(wxml, /status="error"/)
  assert.match(wxml, /title="本地诊断没有通过"/)
  // 失败原因由页面 data.status 原样透传，不在模板里改写。
  assert.match(wxml, /desc="\{\{status\}\}"/)
  // 缺失钉：state-view 的 error 预设 actionText 为空（state-view.js:52-57），
  // 首页也没传 action-text / bind:action ⇒ 唯一的错误分支没有任何重试按钮。
  assert.equal(wxml.includes('action-text='), false, '首页当前不传 action-text')
  assert.equal(wxml.includes('bind:action='), false, '首页当前不监听 state-view 的 action 事件')
})

test('E2 失败与成功文案逐字来自 utils/debug.js，用户不需要猜', () => {
  const debug = read('miniprogram/utils/debug.js')
  // 四种结局四句话，互不重叠，全部 passed=false 除了成功那句。
  assert.match(debug, /report\('当前工程未启用本地诊断。', false\)/)
  assert.match(debug, /report\('响应不符合本地诊断格式，请检查地址。', false\)/)
  assert.match(
    debug,
    /report\('本地连接失败。请核对服务、地址、同网权限及个人域名设置后重试。', false\)/
  )
  assert.match(debug, /report\('本地替身连接成功；登录、数据库、AI及业务均未接入。', true\)/)
  // 「失败」判定走严格 true：`passed === true`，其它任何回传都进 error/灰字分支。
  assert.match(read('miniprogram/pages/home/home.js'), /diagPassed: passed === true/)
})

// —— 3. 空态与错误态是否可区分 ———————————————————————————————

test('S1 统一状态组件里空态与错误态的图标与标题都不同（不会混成一句）', () => {
  const stateView = read('miniprogram/components/state-view/state-view.js')
  const preset = (status) => {
    const matched = new RegExp(
      `${status}:\\s*\\{\\s*icon: '([^']*)',\\s*title: '([^']*)',\\s*desc: '([^']*)'`
    ).exec(stateView)
    assert.ok(matched, `缺少 ${status} 预设`)
    return { icon: matched[1], title: matched[2], desc: matched[3] }
  }
  const empty = preset('empty')
  const error = preset('error')
  const loading = preset('loading')
  assert.equal(empty.icon, '📭')
  assert.equal(empty.title, '没有找到相关资料')
  assert.equal(error.icon, '⚠️')
  assert.equal(error.title, '操作没有成功')
  assert.equal(loading.icon, '⏳')
  assert.equal(loading.title, '正在处理')
  assert.notEqual(empty.title, error.title)
  assert.notEqual(empty.icon, error.icon)
  assert.notEqual(empty.desc, error.desc)
  // error 预设自身不带按钮：想要重试必须页面显式传 actionText。
  const errorBlock = /error:\s*\{[\s\S]*?\n {2}\}/.exec(stateView)
  assert.ok(errorBlock, '必须能切出 error 预设块')
  assert.match(errorBlock[0], /actionText: ''/)
})

test('S2 首页没有空态：/public/home 的空结果数据面在端上无人消费（现状缺口）', () => {
  const wxml = read('miniprogram/pages/home/home.wxml')
  assert.equal(wxml.includes('status="empty"'), false, '首页当前没有空态')
  // 服务端空态是有字段的（previews: []），而端上三个相关文件一次都没读过它。
  for (const file of [
    'miniprogram/pages/home/home.js',
    'miniprogram/pages/home/home.wxml',
    'miniprogram/utils/identify-api.js'
  ]) {
    const text = read(file)
    assert.equal(text.includes('previews'), false, `${file} 当前不得消费 previews`)
    assert.equal(text.includes('human_review_state'), false, `${file} 当前不得消费 human_review_state`)
  }
  // 唯一碰 /public/home 的地方只读封套 meta（执行模式），超时 15000。
  assert.match(
    read('miniprogram/utils/identify-api.js'),
    /url: runtime\.apiBaseUrl \+ '\/public\/home', method: 'GET', timeout: 15000/
  )
})

// —— 4. 游客态与跳登录 ————————————————————————————————————————

test('G1 游客是首页默认态：guest 初值、徽标与登录按钮文案精确', () => {
  const js = read('miniprogram/pages/home/home.js')
  const wxml = read('miniprogram/pages/home/home.wxml')
  assert.match(
    js,
    /data: \{ fontScale: 1, guest: true, entries: entriesForMode\(null\), local: false, busy: false, loggedIn: false, diagPassed: null, status: /
  )
  assert.match(wxml, /<view class="hero__badge" wx:if="\{\{guest\}\}">游客仅可预览首页<\/view>/)
  assert.match(
    wxml,
    /<button wx:if="\{\{guest\}\}" class="btn btn--primary btn--block home-login" bindtap="goLogin">微信登录<\/button>/
  )
  // onShow 先无条件按游客渲染，再由 verifySession 异步覆盖成真实态 ⇒ 首帧永远不闪「已登录」。
  assert.match(js, /this\.setData\(\{ loggedIn: false, guest: true, entries: entriesForMode\(null\) \}\)/)
  assert.match(
    js,
    /this\.setData\(\{ loggedIn: verified, guest: !verified, entries: entriesForMode\(verifiedMode\(verified\)\) \}\)/
  )
})

test('G2 未登录点任何受控入口都弹同一句委派登录，文案逐字固定', () => {
  const js = read('miniprogram/pages/home/home.js')
  assert.match(
    js,
    /wx\.showModal\(\{ title: '需要登录', content: '该功能需要微信登录后使用，现在去登录吗？',/
  )
  assert.match(js, /confirmText: '去登录', cancelText: '暂不',/)
  // 取消 / 弹窗失败都必须清掉 returnTo，不留悬空意图。
  assert.match(js, /else navigation\.clearReturnTo\(op\.id\)/)
  assert.match(js, /fail: \(\) => \{ if \(current\(\)\) navigation\.clearReturnTo\(op\.id\) \}/)
  // 五个受控入口全部走 openGated（hero 开始识别 + 三张能力卡共用 onEntryTap、资料库、识草查药、种子库）。
  assert.equal((js.match(/this\.openGated\(/g) || []).length, 5, '受控入口当前恰好 5 条')
})

// —— 5. 离线 / 断网分支 ————————————————————————————————————————

test('O1 断网在首页不可见：首页不发请求，且全仓没有任何网络状态监听', () => {
  const js = read('miniprogram/pages/home/home.js')
  assert.equal(/wx\.request/.test(js), false, 'home.js 当前 0 处 wx.request')
  assert.equal(/onNetworkStatusChange|getNetworkType/.test(js), false)
  // 全小程序范围内也不存在网络状态监听 ⇒ 断网无法被任何页面识别成独立态。
  const watchers = miniprogramFiles('.js').filter((file) =>
    /onNetworkStatusChange|getNetworkType/.test(readFileSync(file, 'utf8'))
  )
  assert.deepEqual(watchers.map((file) => file.slice(ROOT.length + 1)), [], '当前 0 处网络状态监听')
  // 因此「断网」只能落进 auth.verifySession 的 fail 分支，与「没登录」共用同一个 false。
  const auth = read('miniprogram/utils/auth.js')
  assert.match(
    auth,
    /\/\/ 网络失败：不能核实，也不谎称已登录（门禁保持关闭）。\n\s+serverVerified = false\n\s+done\(false\)/
  )
})

test('O2 5xx/429 与断网都不会清掉本地会话，只保持「未核实」', () => {
  const auth = read('miniprogram/utils/auth.js')
  // 非 200 且非 401/403/200 的分支：只写 serverVerified=false，不 clearSession。
  assert.match(auth, /serverVerified = false\n\s+done\(false\)\n\s+\},\n\s+fail: function \(\) \{/)
  // 只看 verifySession 自己的函数体（顶格 `}` 收尾，内部闭合都有缩进）。
  const body = /function verifySession\(callback\) \{[\s\S]*?\n\}/.exec(auth)
  assert.ok(body, '必须能切出 verifySession 函数体')
  // 只有「服务端明确判死」（401/403）与「200 但契约自相矛盾」两处清会话，均在函数体内。
  assert.equal((body[0].match(/clearSession\(\)/g) || []).length, 2, 'verifySession 里 clearSession 恰好 2 处')
  assert.match(body[0], /if \(status === 401 \|\| status === 403\) \{/)
  assert.match(body[0], /if \(status === 200\) \{/)
  assert.match(body[0], /\/\/ 其它（408 \/ 429 \/ 5xx \/ 未知状态）：服务端\*\*没有\*\*判定会话失效/)
})

// —— 6. 超时值 ————————————————————————————————————————————————

test('T1 超时值：本地诊断 5000；登录态核验根本没有 timeout（现状缺口）', () => {
  assert.match(read('miniprogram/utils/debug.js'), /method: 'GET', timeout: 5000,/)
  const auth = read('miniprogram/utils/auth.js')
  const request = /wx\.request\(\{\n\s+url: runtime\.apiBaseUrl \+ '\/auth\/session',\n\s+method: 'GET',\n\s+header: \{ authorization: 'Bearer ' \+ session\.accessToken \},\n/.exec(
    auth
  )
  assert.ok(request, '必须以精确形态找到 /auth/session 的请求选项块')
  assert.equal(
    request[0].includes('timeout'),
    false,
    '/auth/session 当前没有 timeout：请求挂住时首页会一直停在未核实'
  )
})

// —— 7. 重复点击与竞态 ————————————————————————————————————————

test('R1 首页用自增 _action + _active 丢弃迟到回调（onShow 与 openGated 各一处）', () => {
  const js = read('miniprogram/pages/home/home.js')
  assert.match(js, /const action = this\._action = \(this\._action \|\| 0\) \+ 1/)
  assert.match(js, /if \(this\._active && this\._action === action\) \{/)
  assert.match(js, /const current = \(\) => this\._active !== false && this\._action === action/)
  assert.match(js, /if \(!current\(\) \|\| stale\) return/)
  // onHide 让在途回调失效，并清掉 handoff 之外留下的 returnTo。
  assert.match(js, /this\._active = false\n\s+this\._action = \(this\._action \|\| 0\) \+ 1/)
})

test('R2 重复点击防护：诊断入口用 busy 提前返回，且先清上一次结论', () => {
  const js = read('miniprogram/pages/home/home.js')
  assert.match(
    js,
    /diagnose: function \(\) \{\n\s+if \(this\.data\.busy\) return\n\s+this\.setData\(\{ busy: true, diagPassed: null, status: '正在连接本地诊断服务…' \}\)/
  )
  // 首页没有下拉刷新（home.json 不开 enablePullDownRefresh），所以不存在刷新与首屏的竞态。
  assert.equal(JSON.parse(read('miniprogram/pages/home/home.json')).enablePullDownRefresh, undefined)
  assert.equal(/onPullDownRefresh/.test(js), false)
})

test('R3 会话核验自身绑四重世代：迟到响应不得复活旧会话', () => {
  const auth = read('miniprogram/utils/auth.js')
  assert.match(
    auth,
    /const stale = function \(\) \{\n\s+return generation !== requestGeneration \|\| currentToken\(\) !== requestToken \|\|\n\s+intentEpoch !== requestIntent \|\| !navigation\.isCurrent\(requestNavigation\)/
  )
  assert.match(auth, /if \(stale\(\)\) \{\n\s+\/\/ 会话在请求期间被撤销\/清除或已切换账号：迟到的成功响应不得复活旧会话。/)
})

// —— 8. 错误码映射表 ————————————————————————————————————————

test('C1 错误码映射表存在且取值精确：SESSION_REQUIRED→session、PROVIDER_UNAVAILABLE→unavailable', () => {
  const states = read('miniprogram/utils/states.js')
  assert.match(states, /SESSION_REQUIRED: 'session'/)
  assert.match(states, /SESSION_EXPIRED: 'session'/)
  assert.match(states, /PROVIDER_UNAVAILABLE: 'unavailable'/)
  assert.match(states, /PROVIDER_TIMEOUT: 'unavailable'/)
  assert.match(states, /SCOPE_DENIED: 'denied'/)
  // 可重试性表：session 不可重试、unavailable 可重试。
  assert.match(states, /session: false, \/\/ 需要重新登录，不是重试/)
  assert.match(states, /unavailable: true/)
  // 契约与端上都没有 AUTH_REQUIRED；真实码是 SESSION_REQUIRED（派单里举例的码在仓里不存在）。
  assert.equal(/AUTH_REQUIRED/.test(states), false)
  const contract = read('packages/contracts/openapi.json')
  assert.equal(contract.includes('AUTH_REQUIRED'), false)
  assert.equal(contract.includes('SESSION_REQUIRED'), true)
  assert.equal(contract.includes('PROVIDER_UNAVAILABLE'), true)
})

test('C2 首页不消费这张表：不 require states.js、不传 error-code（现状缺口）', () => {
  const js = read('miniprogram/pages/home/home.js')
  const wxml = read('miniprogram/pages/home/home.wxml')
  assert.equal(js.includes('utils/states'), false)
  assert.equal(js.includes('errorCode'), false)
  assert.equal(wxml.includes('error-code='), false)
  // 首页只 require 这四个模块，新增依赖会改变这里的精确清单。
  assert.deepEqual(
    [...js.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]),
    ['../../utils/font-scale', '../../utils/auth', '../../utils/debug', '../../utils/navigation']
  )
})

// —— 9. 常驻标注不能被顺手改掉 ————————————————————————————————

test('M1 home.json 声明 state-view；「当前状态」的替身标注逐字未改', () => {
  assert.equal(
    JSON.parse(read('miniprogram/pages/home/home.json')).usingComponents['state-view'],
    '/components/state-view/state-view'
  )
  const wxml = read('miniprogram/pages/home/home.wxml')
  assert.match(wxml, /status="stub"\n\s+title="演示与走查状态"/)
  assert.match(
    wxml,
    /desc="拍草识别、标签识别、语音合成播报与社区已接服务端（录音转写尚未接线）；真实提供者、真实数据与真机验收未完成，本页所列内容不能作为用药依据。"/
  )
  // 能力卡徽标只在明确替身环境下写「演示」，其余一律「未核实」。
  assert.match(
    read('miniprogram/pages/home/home.js'),
    /const badge = mode === 'stub' \|\| mode === 'preset_demo' \? '演示' : '未核实'/
  )
})
