// R59 首页多态（公开预览 loading / ready / empty / error / disabled；诊断 loading / error；
// 游客 / 离线）现状钉。
//
// 2026-10-26 #648：首页新增公开预览区后，旧版「首页没有 loading/empty/error-code」的**全局**
// 缺失钉不再成立。本文件改为**分区**取证，不删除门禁、也不把新状态混进原诊断区的断言：
//   公开预览区：`home.js` 的 `loadPreviews()` → `utils/public-home-api.js` → `GET /public/home`，
//     `previewStatus` 五态 loading / ready / empty / error / disabled；合法空列表不伪造填充，
//     失败可读且可显式重试，游客无会话也走同一公开读面。
//   原有诊断区：仅 local 开发块，`busy` / `diagPassed` 的 loading / error / wx:else 单链保持不变，
//     仍没有重试入口、仍不消费错误码表。
//   首页正文（hero / 三张能力卡 / 底部资料入口）仍是写死静态内容；`home.js` 自身仍不直接
//     `wx.request`，公开读面请求集中在 `public-home-api.js`。
//
// 因此本文件的断言仍分两类，证据页 `docs/verification/r59-mp-home-states-20261026.md` 里逐条标明：
//   ① 存在性/文案精确值 —— 现状就该这样，改坏即红（负控制已验证）。
//   ② 缺失钉（absent pin）—— 钉住「现在没有」，等着被未来某片补齐时变红提醒更新证据，**不是期望**。
//
// #617 独立审查补的两处覆盖缺口（审查者自己的负控制证明它们原本真没被钉住）：
//   L3 —— 诊断 loading 分支的**门控**（`miniprogram/pages/home/home.wxml` 的 `wx:if="{{busy}}"`）：
//         原 L1 只钉 `status="loading"` 的存在与顺序，把门控改成恒真（`{{true}}` / `{{1}}`）、
//         删掉门控整行、或改成 `wx:elif` 时全绿 —— 「loading 会出现」被钉住了，「什么时候出现」没有。
//   X1 —— **互斥**：公开预览与诊断区各自必须是一条 if/elif(/else) 单链；把 elif 改成 if、
//         把状态值改坏、或让两条链混在一起都必须红。
//
// 取舍（已知会误红的等价写法，接受并在此说明）：L3 / X1 钉的是「元素 + 指令 + 属性名 + 属性值 + 块顺序」，
//   **行首缩进不算**（块内一律用 `\n\s+` 连接，重排缩进不红）；但同一块内属性**换序**、把属性拆并成不同行数、
//   把 `wx:else` 兜底从 `dev-status` 的 `view` 换成别的元素，以及语义等价但把「门控」写成「常量/恒等式」的
//   写法（`wx:if="{{busy === true}}"`、`{{!!busy}}`、`{{1}}`）都会红 —— 后者正是本片要堵的口子：
//   门控一旦退化成常量，loading 就会无条件出现，而这条断言不允许它悄悄退化。
//
// 只读源码字符串 + JSON.parse，不装载小程序运行时，不起 vm 夹具：首页模板与状态流可静态核对。
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

/** 从 start 截到 end（不含 end），用于把公开预览区与原有诊断区分开取证。 */
function section(text, start, end) {
  const from = text.indexOf(start)
  assert.ok(from >= 0, `缺少区段起点：${start}`)
  const to = end === null ? text.length : text.indexOf(end, from + start.length)
  assert.ok(to > from, `缺少区段终点：${end}`)
  return text.slice(from, to)
}

const previewSection = (wxml) =>
  section(wxml, '<view class="section home-preview">', '<view class="home-bottom">')

const diagnosticSection = (wxml) => {
  const start = '<view class="section" wx:if="{{local}}">'
  assert.equal(wxml.split(start).length - 1, 1, '本地诊断区必须恰好一处')
  return section(wxml, start, null)
}

const stateStatuses = (text) =>
  [...text.matchAll(/<state-view\b[^>]*?\bstatus="([^"]*)"/g)].map((match) => match[1])

// —— 1. loading 态 ———————————————————————————————————————————————————

test('L1 首页不直接请求；公开预览与诊断区各自只有一处 loading', () => {
  const js = read('miniprogram/pages/home/home.js')
  const wxml = read('miniprogram/pages/home/home.wxml')
  // 首页自己仍不发请求；公开读面由独立模块负责。首页正文没有首屏 loading。
  assert.equal((js.match(/wx\.request/g) || []).length, 0, 'home.js 当前 0 处 wx.request')
  // 公开预览区：loading → error → empty → disabled，ready 用内容面板而不是 state-view。
  const preview = previewSection(wxml)
  assert.deepEqual(
    stateStatuses(preview),
    ['loading', 'error', 'empty', 'stub'],
    '公开预览的 state-view 顺序固定为 loading → error → empty → disabled'
  )
  // 原有诊断区仍只有 loading → error，且 loading 只能在 `wx:if="{{local}}"` 之内
  // （本地替身诊断，develop + mode=local 才可见）。
  const diagnostic = diagnosticSection(wxml)
  assert.deepEqual(stateStatuses(diagnostic), ['loading', 'error'], '诊断区仍只有 loading → error')
  const localBlock = diagnostic.indexOf('wx:if="{{local}}"')
  const loading = diagnostic.indexOf('status="loading"')
  assert.ok(localBlock >= 0, '必须找到本地工具块')
  assert.ok(loading > localBlock, '诊断 loading 不得出现在本地工具块之外')
  // 没有骨架屏/转圈：整个页面模板不含 skeleton / spinner 类。
  assert.equal(/skeleton|spinner/.test(wxml), false)
})

test('L2 诊断 loading 的触发方式与文案是精确值', () => {
  const diagnostic = diagnosticSection(read('miniprogram/pages/home/home.wxml'))
  // 按钮自己带 loading 与 disabled 双闸，同一 busy 布尔。
  assert.match(diagnostic, /bindtap="diagnose"\n\s+loading="\{\{busy\}\}"\n\s+disabled="\{\{busy\}\}"/)
  const loadingIndex = diagnostic.indexOf('status="loading"')
  const titleIndex = diagnostic.indexOf('title="正在检查本地替身连接"')
  const descIndex = diagnostic.indexOf('desc="正在读取本地诊断服务状态，请稍候。"')
  assert.ok(loadingIndex >= 0, '诊断 loading 态必须存在')
  assert.ok(titleIndex > loadingIndex, 'loading 标题必须紧跟 loading 状态属性')
  assert.ok(descIndex > titleIndex, 'loading 说明必须紧跟标题')
})

test('L3 诊断 loading 分支的门控是 wx:if="{{busy}}"：整块逐字，且位于诊断按钮之后、error 之前', () => {
  const wxml = read('miniprogram/pages/home/home.wxml')
  const diagnostic = diagnosticSection(wxml)
  // 门控行 + 整块（开标签、三个属性、收尾）逐字：
  // 改成 {{true}} / {{1}} / {{busy === true}}、删掉门控行、改成 wx:elif 都必须红。
  assert.match(
    diagnostic,
    /<state-view\n\s+wx:if="\{\{busy\}\}"\n\s+status="loading"\n\s+title="正在检查本地替身连接"\n\s+desc="正在读取本地诊断服务状态，请稍候。"\n\s+><\/state-view>/,
    '诊断 loading 的 state-view 必须整块逐字带着 wx:if="{{busy}}" 门控'
  )
  // 门控在诊断区恰好一处：删整行、换指令都变成 0 处。
  assert.equal((diagnostic.match(/wx:if="\{\{busy\}\}"/g) || []).length, 1, 'busy 门控在诊断区恰好一处')
  // 位置关系（同一块内的兄弟顺序）：local 块 → 诊断按钮 → busy 门控 → error 的 elif → wx:else 兜底。
  // 先钉每个锚点各恰好出现一次，indexOf 才不会被重复 token 骗过；再钉位置严格递增。
  const anchors = [
    'wx:if="{{local}}"',
    'bindtap="diagnose"',
    'wx:if="{{busy}}"',
    'wx:elif="{{diagPassed === false}}"',
    '<view class="dev-status" wx:else>'
  ]
  assert.deepEqual(
    anchors.map((token) => diagnostic.split(token).length - 1),
    [1, 1, 1, 1, 1],
    '五个位置锚点各恰好出现一次'
  )
  const positions = anchors.map((token) => diagnostic.indexOf(token))
  assert.deepEqual(
    positions,
    [...positions].sort((left, right) => left - right),
    '分支文本顺序必须是 local → 诊断按钮 → busy → elif → else'
  )
  // 三个分支确实在这个 local 块里收尾，没有漂到块外：dev-status 之后只剩 panel / section / page 三层收尾到文件末。
  assert.match(diagnostic, /<view class="dev-status" wx:else>\{\{status\}\}<\/view>\n\s+<\/view>\n\s+<\/view>\n<\/view>\n$/)
})

// —— 2. 出错态与重试 ————————————————————————————————————————————————

test('E1 诊断失败走 error 态，但诊断区没有重试入口（现状缺口，非期望）', () => {
  const diagnostic = diagnosticSection(read('miniprogram/pages/home/home.wxml'))
  assert.match(diagnostic, /wx:elif="\{\{diagPassed === false\}\}"/)
  assert.match(diagnostic, /status="error"/)
  assert.match(diagnostic, /title="本地诊断没有通过"/)
  // 失败原因由页面 data.status 原样透传，不在模板里改写。
  assert.match(diagnostic, /desc="\{\{status\}\}"/)
  // 缺失钉：state-view 的 error 预设 actionText 为空（state-view.js:52-57），
  // 诊断区也没传 action-text / bind:action ⇒ 诊断错误分支没有任何重试按钮。
  // 公开预览区的重试按钮属于另一条独立状态链，不能拿来冒充诊断区已有重试。
  assert.equal(diagnostic.includes('action-text='), false, '诊断区当前不传 action-text')
  assert.equal(diagnostic.includes('bind:action='), false, '诊断区当前不监听 state-view 的 action 事件')
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

test('S2 公开预览有独立空态：合法空列表不伪造填充，诊断区仍没有 empty', () => {
  const wxml = read('miniprogram/pages/home/home.wxml')
  const js = read('miniprogram/pages/home/home.js')
  const api = read('miniprogram/utils/public-home-api.js')
  const preview = previewSection(wxml)
  // 公开预览的空态是显式分支，且文案说明「服务端合法空列表」而不是本地兜底。
  assert.match(preview, /wx:elif="\{\{previewStatus === 'empty'\}\}"/)
  assert.match(preview, /status="empty"/)
  assert.match(preview, /title="暂时没有公开预览"/)
  assert.match(preview, /desc="服务端返回了合法空列表；没有使用本地内容填充。"/)
  // 页面只把服务端返回的 items 放进列表；空数组保持空，不伪造内容。
  assert.match(js, /previewStatus: result\.items\.length \? 'ready' : 'empty'/)
  assert.match(js, /previewItems: result\.items/)
  // 公开读面确实消费 previews / human_review_state，并对空列表保持合法响应。
  assert.match(api, /data\.previews/)
  assert.match(api, /data\.human_review_state/)
  // 原有诊断区没有空态；空态只属于公开预览，不混进诊断链。
  assert.equal(diagnosticSection(wxml).includes('status="empty"'), false, '诊断区仍没有空态')
})

// —— 4. 游客态与跳登录 ————————————————————————————————————————

test('G1 游客是首页默认态：guest 初值、徽标与登录按钮文案精确', () => {
  const js = read('miniprogram/pages/home/home.js')
  const wxml = read('miniprogram/pages/home/home.wxml')
  assert.match(
    js,
    /data: \{ fontScale: 1, guest: true, entries: entriesForMode\(null\), local: false, busy: false, loggedIn: false, diagPassed: null,/
  )
  // 公开预览的初值独立于诊断区：首帧 loading，列表为空，说明与错误码为空。
  assert.match(
    js,
    /previewStatus: 'loading', previewItems: \[\], previewNote: '', previewMessage: '', previewErrorCode: '',/
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
  // 原有五个受控入口全部走 openGated（hero 开始识别 + 三张能力卡共用 onEntryTap、资料库、识草查药、种子库），
  // 新增的公开预览只把 knowledge / community 两类标记转交给同一条门禁，不直接导航、不凭预览 ID 放行。
  assert.equal((js.match(/this\.openGated\(/g) || []).length, 7, '原有 5 条 + 预览 2 类入口，共 7 条')
  const previewTap = /onPreviewTap: function \(event\) \{[\s\S]*?\n  \},/.exec(js)
  assert.ok(previewTap, '必须能切出 onPreviewTap 函数体')
  assert.equal((previewTap[0].match(/this\.openGated\(/g) || []).length, 2, '预览点击只转交两类门禁入口')
  assert.doesNotMatch(previewTap[0], /navigateTo|switchTab|reLaunch/, '预览点击不得自行导航')
})

// —— 5. 离线 / 断网分支 ————————————————————————————————————————

test('O1 首页没有独立网络状态监听；公开预览失败进入 error，断网不冒充登录', () => {
  const js = read('miniprogram/pages/home/home.js')
  const api = read('miniprogram/utils/public-home-api.js')
  assert.equal(/wx\.request/.test(js), false, 'home.js 自身当前 0 处 wx.request')
  // 公开读面把网络失败映射成 NETWORK_UNCERTAIN，页面再落到公开预览 error，不伪造内容。
  assert.match(api, /wx\.request\(\{/)
  assert.match(api, /reject\(failure\('NETWORK_UNCERTAIN'\)\)/)
  assert.match(js, /previewStatus: 'error'/)
  assert.equal(/onNetworkStatusChange|getNetworkType/.test(js), false)
  // 全小程序范围内也不存在网络状态监听 ⇒ 断网不能被任何页面识别成独立全局态。
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

test('C2 诊断区不消费错误码表；公开预览错误码由 public-home-api 独立映射', () => {
  const js = read('miniprogram/pages/home/home.js')
  const wxml = read('miniprogram/pages/home/home.wxml')
  const diagnostic = diagnosticSection(wxml)
  assert.equal(js.includes('utils/states'), false)
  assert.equal(diagnostic.includes('error-code='), false, '诊断区仍不传 error-code')
  const diagnose = /diagnose: function \(\) \{[\s\S]*?\n  \}/.exec(js)
  assert.ok(diagnose, '必须能切出 diagnose 函数体')
  assert.equal(/errorCode|error-code/.test(diagnose[0]), false, '诊断处理不消费错误码')
  // 公开预览区有独立的 error-code 绑定，错误码来自 public-home-api，不混入诊断区。
  const preview = previewSection(wxml)
  assert.match(preview, /error-code="\{\{previewErrorCode\}\}"/)
  assert.match(js, /previewErrorCode: error && error\.code \? error\.code : 'UNAVAILABLE'/)
  // 首页 require 清单精确固定；新增依赖会改变这里，必须显式审查。
  assert.deepEqual(
    [...js.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]),
    [
      '../../utils/font-scale',
      '../../utils/auth',
      '../../utils/debug',
      '../../utils/navigation',
      '../../utils/public-home-api'
    ]
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

// —— 10. 状态互斥（公开预览与诊断区各自一条 if / elif(/else) 单链）———————

test('X1 公开预览与诊断区各自为单链，状态互斥', () => {
  const wxml = read('miniprogram/pages/home/home.wxml')
  const js = read('miniprogram/pages/home/home.js')
  const chain = (text) => {
    const at = text.indexOf('<state-view')
    assert.ok(at >= 0, '区段内必须找到 state-view 链起点')
    return [
      ...text
        .slice(at)
        .matchAll(/<(state-view|view)\b[^>]*?\swx:(if|elif|else)(?:="([^"]*)")?/g)
    ].map((match) => [match[1], `wx:${match[2]}`, match[3] === undefined ? null : match[3]])
  }

  const preview = previewSection(wxml)
  // ① 公开预览：loading → error → empty → disabled 四条 state-view 分支，最后 ready 用内容面板承接。
  assert.deepEqual(
    chain(preview),
    [
      ['state-view', 'wx:if', "{{previewStatus === 'loading'}}"],
      ['state-view', 'wx:elif', "{{previewStatus === 'error'}}"],
      ['state-view', 'wx:elif', "{{previewStatus === 'empty'}}"],
      ['state-view', 'wx:elif', "{{previewStatus === 'disabled'}}"],
      ['view', 'wx:elif', "{{previewStatus === 'ready'}}"]
    ],
    '公开预览的五条分支位置、元素与条件逐字固定'
  )
  // ② 诊断区：loading 用 wx:if({{busy}})、error 用 wx:elif({{diagPassed === false}})、
  //    兜底用 wx:else（元素是 dev-status 的 view，不是第四个 state-view）。
  const diagnostic = diagnosticSection(wxml)
  assert.deepEqual(
    chain(diagnostic),
    [
      ['state-view', 'wx:if', '{{busy}}'],
      ['state-view', 'wx:elif', '{{diagPassed === false}}'],
      ['view', 'wx:else', null]
    ],
    '诊断区 if / elif / else 三条分支的位置、元素与条件逐字固定'
  )

  // ③ 互斥的结构前提：每条链的分支必须是**相邻兄弟**（中间只允许空白）。
  assert.match(
    preview,
    /<\/state-view>\s+<state-view\n\s+wx:elif="\{\{previewStatus === 'error'\}\}"/,
    '预览 error 的 elif 必须紧邻 loading 分支'
  )
  assert.match(
    preview,
    /<\/state-view>\s+<state-view\n\s+wx:elif="\{\{previewStatus === 'empty'\}\}"/,
    '预览 empty 的 elif 必须紧邻 error 分支'
  )
  assert.match(
    preview,
    /<\/state-view>\s+<state-view\n\s+wx:elif="\{\{previewStatus === 'disabled'\}\}"/,
    '预览 disabled 的 elif 必须紧邻 empty 分支'
  )
  assert.match(
    preview,
    /<\/state-view>\s+<view wx:elif="\{\{previewStatus === 'ready'\}\}" class="panel preview-panel">/,
    '预览 ready 的 elif 必须紧邻 disabled 分支'
  )
  assert.match(
    diagnostic,
    /<\/state-view>\s+<state-view\n\s+wx:elif="\{\{diagPassed === false\}\}"/,
    '诊断 error 的 elif 必须紧邻 loading 分支'
  )
  assert.match(
    diagnostic,
    /<\/state-view>\s+<view class="dev-status" wx:else>\{\{status\}\}<\/view>/,
    '诊断兜底的 wx:else 必须紧邻 error 分支'
  )
  assert.deepEqual(
    [(preview.match(/wx:elif=/g) || []).length, (preview.match(/wx:else/g) || []).length],
    [4, 0],
    '公开预览恰有 4 条 elif、没有 else'
  )
  assert.deepEqual(
    [(diagnostic.match(/wx:elif=/g) || []).length, (diagnostic.match(/wx:else/g) || []).length],
    [1, 1],
    '诊断区 elif / else 各恰好一处'
  )
  assert.deepEqual(
    [(wxml.match(/wx:elif=/g) || []).length, (wxml.match(/wx:else/g) || []).length],
    [5, 1],
    '全页只有公开预览与诊断区两条链'
  )

  // ④ 数据前提：公开预览的 previewStatus 只会落到五个显式状态，不靠多个布尔同时为真。
  assert.match(js, /previewStatus: 'loading'/)
  assert.match(js, /previewStatus: 'disabled'/)
  assert.match(js, /previewStatus: result\.items\.length \? 'ready' : 'empty'/)
  assert.match(js, /previewStatus: 'error'/)
  // 诊断区：busy 与 diagPassed 只在这两处 setData 同时写 —— 置 busy 的同时把 diagPassed 清成 null
  // ⇒ `busy === true` 与 `diagPassed === false` 不可能同时成立；两者都假时才落进 wx:else 兜底。
  assert.deepEqual(
    [...js.matchAll(/this\.setData\(\{[^}]*\}\)/g)]
      .map((match) => match[0])
      .filter((call) => /busy|diagPassed/.test(call)),
    [
      "this.setData({ busy: true, diagPassed: null, status: '正在连接本地诊断服务…' })",
      'this.setData({ busy: false, status: status, diagPassed: passed === true })'
    ],
    'busy 与 diagPassed 只在诊断开始/结束两处同时写'
  )
  // diagPassed 在 home.js 恰好 3 处（data 初值 + 上面两处 setData）：多一处单独写它就破坏互斥前提。
  assert.equal((js.match(/diagPassed/g) || []).length, 3, 'diagPassed 在全文件恰好 3 处')
})
