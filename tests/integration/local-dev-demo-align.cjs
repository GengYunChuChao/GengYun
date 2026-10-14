// GY-I26 demo 样式对齐：实际开发者工具模拟器上的形态与「运行时行为」核对（Refs #28）
// ---------------------------------------------------------------------------
// 与 tools/demo-align.mjs 的分工：
//   - tools/demo-align.mjs 是**静态文本比对**（令牌值集合／类名存在性／图标几何／门槛）；
//   - 本脚本在**官方开发者工具 + 官方 miniprogram-automator** 里跑真实页面，核对静态比对
//     证明不了的运行时行为：
//       1. app.wxss 的 @import 是否内联到页面（量 tokens/components 层的计算值）；
//       2. page{} 上的 CSS 变量是否被页面节点继承（--tap-min／--paper／--green／--lime…）；
//       3. data URI 图标是否真的作为 background-image 生效；
//       4. styleIsolation:'apply-shared' 是否让 app.wxss 的 class 规则作用到自定义组件内部
//          （.btn 只在 app.wxss 定义，state-view.wxss 不含 .btn，故可判定）。
//     另核对：五 Tab 的页头/面板/主要按钮形态、样式走查页 pages/specimen 的
//     post／article／识别台／八态是否真实渲染、以及受控最大字号档下末屏是否被 Tab 遮挡
//     （用组件级 selectorQuery 量真实 tabBar 矩形，不用静态推算）。
//
// 已知工具限制（如实记录，不用其它数字替代）：
//   - 自定义 tabBar 的节点**不在 automator 的页面选择器范围内**（page.$$('.tab-bar') = 0），
//     故其矩形改由 `getTabBar().createSelectorQuery()` 在组件内测量；
//   - IDE 的 getStyles 不返回简写属性（border-radius／padding／gap 为 null），只返回长写
//     （border-top-left-radius／padding-top 等），脚本按长写属性取值。
//
// 边界：身份与数据都是合成替身（loopback fixture），不是真机、不是真实身份或生产资料；
//      受控字号是临时替换 wx.getAppBaseInfo，不是用户在系统里真的把字调到最大。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const [sdkDir, outDir, portArg = '9420'] = process.argv.slice(2)
if (!sdkDir || !outDir) throw Error('Usage: node tests/integration/local-dev-demo-align.cjs <SDK directory> <output directory> [automation port=9420]')
const port = Number(portArg)
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535)
const sdk = require(path.resolve(sdkDir))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let mini
let stage = 'connect'
const timer = setTimeout(() => { console.error('Timeout at ' + stage); mini?.disconnect(); process.exit(2) }, 180000)

;(async () => {
  mini = await sdk.connect({ wsEndpoint: 'ws://127.0.0.1:' + port })
  const out = path.resolve(outDir)
  fs.mkdirSync(out, { recursive: true })
  const info = await mini.systemInfo()
  const report = {
    kind: 'actual WeChat devtools simulator + official miniprogram-automator; loopback synthetic fixture identity/data; controlled font substitution for the max-scale pass; NOT a device test',
    width: info.windowWidth, height: info.windowHeight, SDKVersion: info.SDKVersion,
    platform: info.platform, model: info.model, system: info.system, pixelRatio: info.pixelRatio,
    getAppBaseInfo: await mini.evaluate(() => {
      const b = typeof wx.getAppBaseInfo === 'function' ? wx.getAppBaseInfo() : {}
      return { basePx: b.fontSizeSetting, baseFactor: b.fontSizeScaleFactor, hasGetAppBaseInfo: typeof wx.getAppBaseInfo === 'function' }
    }),
    runtime: {}, guest: {}, session: null, tabBar: {}, specimen: {}, pages: [], maxFont: {}
  }

  async function route(name) {
    for (let i = 0; i < 100; i++) {
      const p = await mini.currentPage()
      if (p && p.path === 'pages/' + name + '/' + name) return p
      await sleep(100)
    }
    throw Error('Route timeout: ' + name)
  }
  const shot = (name) => mini.screenshot({ path: path.join(out, name + '.png') })
  async function style(p, sel, prop) {
    const el = await p.$(sel)
    return el ? el.style(prop) : null
  }
  async function count(p, sel) { return (await p.$$(sel)).length }
  async function buttonHeights(p) {
    const rows = []
    for (const b of await p.$$('button')) rows.push({ text: (await b.text()).slice(0, 20), height: await b.size().then((s) => s.height), font: await b.style('font-size') })
    return rows
  }
  /** 页面级 + 组件级（自定义 tabBar）真实矩形；boundingClientRect 为视口坐标，可直接判定遮挡 */
  async function rects(specs, withTabBar) {
    return mini.evaluate((specs, withTabBar) => new Promise((resolve) => {
      const pages = getCurrentPages(), p = pages[pages.length - 1]
      const bar = typeof p.getTabBar === 'function' ? p.getTabBar() : null
      const q = wx.createSelectorQuery().in(p)
      for (const s of specs) (s.all ? q.selectAll(s.selector) : q.select(s.selector)).boundingClientRect()
      q.exec((pageRects) => {
        const result = { pagePath: p.route, rects: {}, hasTabBar: !!bar }
        specs.forEach((s, i) => { result.rects[s.key] = s.all ? (pageRects[i] || []).slice(-1)[0] || null : pageRects[i] || null })
        if (!withTabBar || !bar) return resolve(result)
        const bq = bar.createSelectorQuery().in(bar)
        bq.select('.tab-bar').boundingClientRect()
        bq.select('.tab--identify').boundingClientRect()
        bq.select('.gy-icon--tab-home').boundingClientRect()
        bq.exec((barRects) => {
          result.tabBar = barRects[0] || null
          result.tabIdentify = barRects[1] || null
          result.tabIcon = barRects[2] || null
          result.tabBarData = { selected: bar.data.selected, fontScale: bar.data.fontScale, tabs: (bar.data.tabs || []).map((t) => ({ text: t.text, icon: t.icon, center: !!t.center })) }
          resolve(result)
        })
      })
    }), specs, !!withTabBar)
  }

  // ---- 1 未登录：门禁拦截（真实运行时行为） --------------------------------------
  // 社区／消息／我的未登录时由 pageGate → auth.requireLogin 实际重定向到登录页，
  // 因此「未登录」在真实运行时表现为跳登录页，而不是停在页内的空白状态。
  stage = 'guest-gate'
  await mini.callWxMethod('removeStorageSync', 'gengyun.session')
  await mini.reLaunch('/pages/home/home')
  const guestHome = await route('home')
  await guestHome.waitFor(async () => (await guestHome.data('guest')) === true)
  report.guest = {
    homeGuest: true,
    homeFont: await style(guestHome, '.page', 'font-size'),
    heroCtaBackground: await style(guestHome, '.btn--lime', 'background-color'),
    loginButtonPresent: !!(await guestHome.$('.btn--primary'))
  }
  await shot('guest-home-390')
  try { await mini.switchTab('/pages/community/community') } catch (_) { /* 期望被拦下 */ }
  const guestLogin = await route('login')
  report.guest.communityRedirectedToLogin = guestLogin.path === 'pages/login/login'
  assert.equal(report.guest.communityRedirectedToLogin, true, '未登录访问社区未被拦到登录页')
  await shot('guest-login-redirect')

  // ---- 2 实际 wx.login + loopback 合成身份 ---------------------------------------
  stage = 'login'
  await mini.reLaunch('/pages/login/login')
  const login = await route('login')
  await login.waitFor(async () => !(await login.data('busy')))
  let loginButton
  for (const b of await login.$$('button')) if ((await b.text()).includes('微信登录')) loginButton = b
  assert.ok(loginButton, '缺少微信登录按钮')
  await loginButton.tap()
  let session = null
  for (let i = 0; i < 100 && !session; i++) {
    session = await mini.evaluate(() => {
      const s = wx.getStorageSync('gengyun.session')
      return s && s.accessToken ? { audience: s.audience, executionMode: s.executionMode, hasAccessToken: typeof s.accessToken === 'string' } : null
    })
    if (!session) await sleep(200)
  }
  report.session = session
  assert.ok(report.session, '登录后未建立会话（wx.login → /auth/wechat → /auth/session）')
  assert.equal(report.session.audience, 'user')

  // ---- 3 首页：@import 内联 / page{} 变量 / data URI 图标 ------------------------
  stage = 'home-runtime'
  const home = await mini.switchTab('/pages/home/home')
  await home.waitFor(async () => !(await home.data('guest')))
  await home.waitFor(200)
  report.runtime = {
    pageFont: await style(home, '.page', 'font-size'),
    pageColor: await style(home, '.page', 'color'),
    btnMinHeight: await style(home, '.btn', 'min-height'),
    btnFont: await style(home, '.btn', 'font-size'),
    limeButtonBackground: await style(home, '.btn--lime', 'background-color'),
    badgeStubBackground: await style(home, '.badge--stub', 'background-color'),
    heroBackground: await style(home, '.hero', 'background-color'),
    featureCardRadius: await style(home, '.feature-card', 'border-top-left-radius'),
    featureCardBorderColor: await style(home, '.feature-card', 'border-top-color'),
    featureCardPaddingTop: await style(home, '.feature-card', 'padding-top'),
    featureCardMinHeight: await style(home, '.feature-card', 'min-height'),
    leafIconBackgroundImage: (await style(home, '.gy-icon--leaf', 'background-image') || '').slice(0, 48),
    // 首页自身的形态值必须在它仍是栈顶页时读完（换 Tab 后再读会报 page is not on top）
    headingFont: await style(home, '.page-heading__title', 'font-size'),
    headingColor: await style(home, '.page-heading__sub', 'color'),
    panels: await count(home, '.panel'),
    featureCards: await count(home, '.feature-card'),
    primaryButtons: await count(home, '.btn--primary'),
    limeButtons: await count(home, '.btn--lime')
  }
  assert.equal(report.runtime.pageFont, '18px', '正文未按 18px 渲染')
  assert.equal(report.runtime.btnMinHeight, '44px', 'page{} 上的 --tap-min 未被页面节点继承')
  assert.equal(report.runtime.btnFont, '18px', '.btn 字号未按 app.wxss 的 18px 渲染')
  assert.equal(report.runtime.pageColor, 'rgb(23, 53, 43)', 'demo --ink #17352b 未生效')
  assert.equal(report.runtime.limeButtonBackground, 'rgb(198, 241, 123)', 'demo --lime #c6f17b 未生效')
  assert.equal(report.runtime.badgeStubBackground, 'rgb(239, 234, 247)', '--tone-stub-bg #efeaf7 未生效')
  assert.equal(report.runtime.heroBackground, 'rgb(18, 62, 49)', 'demo .hero #123e31 未生效')
  assert.equal(report.runtime.featureCardRadius, '13px', 'demo .feature-card 圆角未生效')
  assert.equal(report.runtime.featureCardBorderColor, 'rgb(229, 235, 229)', 'demo --line #e5ebe5 未生效')
  assert.equal(report.runtime.featureCardPaddingTop, '18px', 'demo .feature-card 内距未生效')
  assert.ok(report.runtime.leafIconBackgroundImage.includes('data:image/svg+xml'), 'data URI 图标未作为 background-image 生效')
  await shot('runtime-home-top')

  // 自定义 tabBar：节点不在 page 选择器范围，改用组件级 selectorQuery
  stage = 'tabbar'
  const tabRects = await rects([
    { key: 'page', selector: '.page' },
    { key: 'lastPanel', selector: '.panel', all: true }
  ], true)
  report.tabBar = {
    pagePath: tabRects.pagePath,
    hasTabBar: tabRects.hasTabBar,
    rect: tabRects.tabBar,
    identifyRect: tabRects.tabIdentify,
    iconRect: tabRects.tabIcon,
    data: tabRects.tabBarData,
    pageRect: tabRects.rects.page,
    lastContentRect: tabRects.rects.lastPanel
  }
  assert.equal(report.tabBar.hasTabBar, true, '自定义 tabBar 未挂载')
  assert.equal(report.tabBar.data.tabs.length, 5, '底部 Tab 数量不为 5')
  assert.deepEqual(report.tabBar.data.tabs.map((t) => t.icon), ['home', 'users', 'scan', 'bell', 'person'], '底部五 Tab 的图标来源与 demo navs 不一致')
  assert.ok(report.tabBar.iconRect && report.tabBar.iconRect.width >= 21, '组件内 data URI 图标未渲染出尺寸（apply-shared 或组件 @import 问题）')
  assert.equal(report.tabBar.data.fontScale, 1, 'tabBar 未收到页面注入的 --font-scale')
  // 末屏：滚到最底后，最后一个内容块不得被 Tab 覆盖（两者都是视口坐标）
  await mini.pageScrollTo(10000); await home.waitFor(250)
  const bottomRects = await rects([
    { key: 'lastPanel', selector: '.panel', all: true },
    { key: 'page', selector: '.page' }
  ], true)
  report.tabBar.atScrollBottom = { lastContentRect: bottomRects.rects.lastPanel, tabBarRect: bottomRects.tabBar, pageRect: bottomRects.rects.page }
  assert.ok(bottomRects.rects.lastPanel && bottomRects.tabBar, '末屏或 Tab 矩形取不到')
  report.tabBar.lastScreenClearsTabBar = bottomRects.rects.lastPanel.bottom <= bottomRects.tabBar.top + 0.5
  assert.ok(report.tabBar.lastScreenClearsTabBar, '末屏内容被底部 Tab 遮挡（标准字号）')
  await shot('runtime-home-bottom')
  await mini.pageScrollTo(0)

  // ---- 4 其余四个 Tab 的页头/面板/主要按钮 --------------------------------------
  stage = 'tabs'
  for (const name of ['identify', 'community', 'messages', 'profile']) {
    const p = await mini.switchTab('/pages/' + name + '/' + name)
    await p.waitFor(async () => !(await p.data('guest')))
    await p.waitFor(200)
    report.pages.push({
      name,
      font: await style(p, '.page', 'font-size'),
      headingFont: await style(p, '.page-heading__title', 'font-size'),
      headingColor: await style(p, '.page-heading__sub', 'color'),
      panels: await count(p, '.panel'),
      pills: await count(p, '.pill'),
      primaryButtons: await count(p, '.btn--primary'),
      limeButtons: await count(p, '.btn--lime'),
      btnMinHeight: await style(p, '.btn', 'min-height')
    })
  }
  report.pages.unshift({
    name: 'home',
    font: report.runtime.pageFont,
    headingFont: report.runtime.headingFont,
    headingColor: report.runtime.headingColor,
    panels: report.runtime.panels,
    featureCards: report.runtime.featureCards,
    primaryButtons: report.runtime.primaryButtons,
    limeButtons: report.runtime.limeButtons,
    btnMinHeight: report.runtime.btnMinHeight
  })
  // 消息页当前没有任何已接入的动作（demo 的「全部已读」未实现），因此不放按钮占位——
  // 这是本片记录的取舍，不是缺主要按钮。其余四页都必须有明确的 .btn--primary/--lime 主操作。
  const needsMainAction = ['home', 'identify', 'community', 'profile']
  for (const row of report.pages) {
    assert.equal(row.font, '18px', row.name + ' 正文未按 18px 渲染')
    if (row.btnMinHeight !== null) assert.equal(row.btnMinHeight, '44px', row.name + ' 的 .btn 未继承 page{} 的 --tap-min')
    assert.equal(row.headingColor, 'rgb(123, 137, 131)', row.name + ' 页头副标题未用 demo --muted')
    if (needsMainAction.includes(row.name)) {
      assert.ok(row.primaryButtons + row.limeButtons >= 1, row.name + ' 缺少主要操作按钮（.btn--primary／.btn--lime）')
    }
  }
  report.pages.find((r) => r.name === 'messages').note = '无已接入动作，故不放按钮；主要按钮缺口不适用于本页（见证据页取舍表）'

  // ---- 5 样式走查页：post／article 详情形态 + 识别台 + 八态 + 统一状态组件 ---------
  stage = 'specimen'
  await mini.reLaunch('/pages/specimen/specimen')
  const sp = await route('specimen')
  await sp.waitFor(async () => (await sp.data('local')) === true)
  await sp.waitFor(300)
  report.specimen = {
    local: await sp.data('local'),
    posts: await count(sp, '.post'),
    postTexts: await count(sp, '.post-text'),
    postVisual: await count(sp, '.post-visual'),
    postActions: await count(sp, '.post-actions__item'),
    commentRows: await count(sp, '.comment-row'),
    articleCards: await count(sp, '.article-card'),
    articleArts: await count(sp, '.article-art'),
    proseTexts: await count(sp, '.prose__text'),
    statCells: await count(sp, '.stat'),
    scanStages: await count(sp, '.scan-stage'),
    scanFrames: await count(sp, '.scan-frame'),
    processPanels: await count(sp, '.process-panel'),
    progressTracks: await count(sp, '.progress-track'),
    stateViews: await count(sp, '.state'),
    endMarkers: await count(sp, '.specimen-end'),
    endMarkerBackground: await style(sp, '.specimen-end', 'background-color'),
    postRadius: await style(sp, '.post', 'border-top-left-radius'),
    articleArtMinHeight: await style(sp, '.article-art', 'min-height'),
    primaryButtonBackground: await style(sp, '.btn--primary', 'background-color'),
    amberPillBackground: await style(sp, '.pill--amber', 'background-color'),
    grayPillBackground: await style(sp, '.pill--gray', 'background-color'),
    // 统一状态视图（demo .empty 形态）在真实渲染中的样子
    stateBackground: await style(sp, '.state', 'background-color'),
    stateBorderTopStyle: await style(sp, '.state', 'border-top-style'),
    stateBorderColor: await style(sp, '.state', 'border-top-color'),
    stateTitleFont: await style(sp, '.state__title', 'font-size'),
    // 关键：.btn 只在 app.wxss 定义，state-view.wxss 不含 .btn。量到 44px 触控下限与
    // 18px 字号 ⇒ styleIsolation:'apply-shared' 确实让 app.wxss 的 class 规则作用到组件内部。
    componentButtonMinHeight: await style(sp, '.state__btn', 'min-height'),
    componentButtonFont: await style(sp, '.state__btn', 'font-size')
  }
  assert.equal(report.specimen.local, true, '样式走查页未在本地替身工程下渲染样张')
  assert.ok(report.specimen.posts >= 2 && report.specimen.postTexts >= 2 && report.specimen.postActions >= 3 && report.specimen.commentRows >= 1, '帖子详情形态未渲染')
  assert.ok(report.specimen.articleCards >= 1 && report.specimen.articleArts >= 1 && report.specimen.proseTexts >= 1, '文章详情形态未渲染')
  assert.ok(report.specimen.scanStages >= 1 && report.specimen.scanFrames >= 1 && report.specimen.processPanels >= 1 && report.specimen.progressTracks >= 1, '识别台形态未渲染')
  assert.equal(report.specimen.stateViews, 7, '统一状态视图未渲染七态')
  assert.equal(report.specimen.endMarkers, 1, '缺少末屏标记')
  assert.equal(report.specimen.endMarkerBackground, 'rgb(198, 241, 123)', '--lime #c6f17b 未生效')
  assert.equal(report.specimen.primaryButtonBackground, 'rgb(23, 107, 80)', 'demo --green #176b50 未生效')
  assert.equal(report.specimen.amberPillBackground, 'rgb(247, 241, 227)', '--tone-warn-bg #f7f1e3 未生效')
  assert.equal(report.specimen.grayPillBackground, 'rgb(242, 243, 238)', 'demo .pill.gray #f2f3ee 未生效')
  assert.equal(report.specimen.postRadius, '15px', 'demo .post 圆角 15px（--radius-lg）未生效')
  assert.equal(report.specimen.stateBorderTopStyle, 'dashed', '统一状态未采用 demo .empty 的虚线框')
  assert.equal(report.specimen.stateBorderColor, 'rgb(212, 223, 199)', 'demo .empty 虚线色 #d4dfc7 未生效')
  assert.equal(report.specimen.stateBackground, 'rgb(238, 243, 233)', '--green-soft #eef3e9（.state--guest 语气）未生效')
  assert.ok(parseFloat(report.specimen.componentButtonMinHeight) >= 44, 'app.wxss 的 .btn 未作用到组件内部（apply-shared 未生效）')
  assert.ok(Math.abs(parseFloat(report.specimen.componentButtonFont) - 18) < 0.1, '组件内按钮字号未按 app.wxss 的 18px 渲染')
  for (const [offset, name] of [[0, 'specimen-top'], [1200, 'specimen-article-post'], [3000, 'specimen-scan'], [4200, 'specimen-states']]) {
    await mini.pageScrollTo(offset); await sp.waitFor(150); await shot(name)
  }
  await mini.pageScrollTo(10000); await sp.waitFor(150); await shot('specimen-bottom')
  const spRects = await rects([{ key: 'page', selector: '.page' }, { key: 'end', selector: '.specimen-end' }], false)
  report.specimen.pageRect = spRects.rects.page
  report.specimen.endRect = spRects.rects.end
  report.specimen.bottomReservePx = Number((spRects.rects.page.height - spRects.rects.end.bottom).toFixed(1))
  // .page 底部预留（px，不随视口缩放）应覆盖底部 Tab 的最大字号档高度
  report.specimen.bottomReserveCoversTabBar = report.specimen.bottomReservePx >= report.tabBar.rect.height
  assert.ok(report.specimen.bottomReserveCoversTabBar, '末屏预留小于标准字号档 Tab 高度')

  // ---- 6 受控最大字号档：末屏 + 主要按钮 ----------------------------------------
  stage = 'maxfont'
  try {
    await mini.evaluate(() => {
      const app = getApp(), original = wx.getAppBaseInfo, b = original()
      app._demoAlignFontRestore = original
      wx.getAppBaseInfo = () => Object.assign({}, b, { fontSizeSetting: 26, fontSizeScaleFactor: 1.625 })
      getCurrentPages().slice(-1)[0].onShow()
    })
    const bigHome = await mini.switchTab('/pages/home/home')
    await bigHome.waitFor(async () => (await bigHome.data('fontScale')) === 1.3)
    await bigHome.waitFor(300)
    const bigButtons = await buttonHeights(bigHome)
    await mini.pageScrollTo(0); await bigHome.waitFor(150); await shot('maxfont-home-top')
    await mini.pageScrollTo(10000); await bigHome.waitFor(250)
    const bigRects = await rects([
      { key: 'lastPanel', selector: '.panel', all: true },
      { key: 'page', selector: '.page' }
    ], true)
    await shot('maxfont-home-bottom')
    report.maxFont = {
      kind: 'temporary substitution of wx.getAppBaseInfo (fontSizeScaleFactor 1.625 / fontSizeSetting 26); restored in finally; NOT the real system maximum font setting',
      pageScale: await bigHome.data('fontScale'),
      rootFontSize: await style(bigHome, '.page', 'font-size'),
      btnMinHeight: await style(bigHome, '.btn', 'min-height'),
      buttons: bigButtons,
      minButtonHeight: Math.min(...bigButtons.map((b) => parseFloat(b.height))),
      tabBarRect: bigRects.tabBar,
      tabBarData: bigRects.tabBarData,
      lastContentRect: bigRects.rects.lastPanel,
      pageRect: bigRects.rects.page,
      // 与静态核算分列：tools/verify-layout.mjs 在同档下按声明复算的 Tab 高度
      staticNavHeightPx: 87.3,
      staticBottomReservePx: 105
    }
    assert.equal(report.maxFont.pageScale, 1.3, '受控最大字号档未生效')
    assert.ok(Math.abs(parseFloat(report.maxFont.rootFontSize) - 23.4) < 0.1, '最大字号档正文未到 23.4px')
    assert.equal(report.maxFont.btnMinHeight, '57.2px', '最大字号档 --tap-min 未随之放大到 57.2px')
    assert.ok(report.maxFont.minButtonHeight >= 44, '最大字号档仍有按钮低于 44px 触控下限')
    assert.ok(bigRects.rects.lastPanel && bigRects.tabBar, '最大字号档矩形取不到')
    report.maxFont.lastScreenClearsTabBar = bigRects.rects.lastPanel.bottom <= bigRects.tabBar.top + 0.5
    assert.ok(report.maxFont.lastScreenClearsTabBar, '最大字号档末屏内容被底部 Tab 遮挡')
    await mini.pageScrollTo(0)
  } finally {
    await mini.evaluate(() => {
      const app = getApp()
      if (app._demoAlignFontRestore) { wx.getAppBaseInfo = app._demoAlignFontRestore; delete app._demoAlignFontRestore }
      const pages = getCurrentPages()
      if (pages.length) pages[pages.length - 1].onShow()
    })
    report.maxFont.restored = true
  }

  fs.writeFileSync(path.join(out, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
  await mini.reLaunch('/pages/home/home')
  console.log('PASS devtools simulator ' + info.windowWidth + 'x' + info.windowHeight + ' (SDK ' + info.SDKVersion + '): @import inlined, page{} tokens resolve, data URI icons render, apply-shared reaches components, five tabs + specimen forms render, last screen clears the real tab bar at both standard and max font scale.')
  console.log('BOUNDARY: synthetic loopback identity/data, controlled font substitution, devtools simulator only - not a device, real account or production-data test.')
})().catch((e) => { console.error(stage + ': ' + e.name + ' - ' + e.message); process.exitCode = 1 }).finally(async () => {
  clearTimeout(timer)
  if (mini) { try { await mini.evaluate(() => { const a = getApp(); if (a && a._demoAlignFontRestore) { wx.getAppBaseInfo = a._demoAlignFontRestore; delete a._demoAlignFontRestore } }) } catch (_) {} mini.disconnect() }
})
