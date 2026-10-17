/**
 * GY-I26：五 Tab 骨架 + 统一失败态闭集 + 真机台账的**防回退**守卫
 * ---------------------------------------------------------------------------
 * 本片只补「可机检的防回退」与「如实登记」，不改产品结构与视觉：
 *   1) 五 Tab 四件套双向一致：`miniprogram/app.json` 的 `tabBar.list[*].pagePath`
 *      是唯一来源，每个 pagePath 必须有非空的 .js/.json/.wxml/.wxss；
 *      `custom-tab-bar/index.js` 的 `tabs` 必须与 tabBar 同序同集（五 Tab 的实际渲染者）。
 *   2) 失败态入口不绕过统一组件：五 Tab 页必须注册并使用 `components/state-view`；
 *      页面里任何 `status=` 渲染令牌都只能挂在该组件上，`status === '…'` 比较也必须
 *      出现在 `<state-view>` 标签内（现状复核：全仓仅 community/communitydetail/
 *      messages 三页有该比较，且都在 state-view 上）。
 *   3) 状态闭集：`state-view.js` 的 `PRESETS` 键集合必须与
 *      `docs/ui-state-inventory.md` §2 八态表的 key 列**集合相等**（不是包含），
 *      且所有页面实际使用的字面量取值必须是该闭集的真子集。
 *      —— 为什么对照物是这份文档而不是 `packages/contracts/states.json`：
 *         `states.json`（contract_version 1.0.0）只有 13 个**领域**闭集，没有页面级
 *         status 键；它是冻结契约（`docs/ui-state-inventory.md` §8 明写「不修改
 *         `packages/contracts/` 下任何冻结契约」），为其新增页面级枚举会直接推翻冻结
 *         基线。故闭集的成文权威取页面状态清单 §2，并在交接里如实说明这处口径。
 *   4) 真机台账：`docs/verification/gy-i26-demo-align-20261014.md` §12 的五条真机项
 *      只许登记「未取得」，必须写清缺什么条件，且不得同时出现在任何「已通过」表里。
 *
 * 能证明什么：仓库里的骨架接线、闭集一致性与台账措辞没有回退；注入闭集外的 status
 * 或删掉任意四件套之一都会让本文件变红（见「注入负控制」用例）。
 * 不能证明什么：本文件**不编译 WXML/WXSS、不启动微信开发者工具、不接触真机**，
 * 真机逐页渲染、真机字号与真机截图仍未取得，见证据文档 §12。
 *
 * Refs #28
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PAGES_DIR = join(ROOT, 'miniprogram', 'pages')
const EVIDENCE_DOC = 'docs/verification/gy-i26-demo-align-20261014.md'

/** 任务书与 `state-view.js` 头注释共同固定的八态（顺序取文档表）。 */
const EIGHT_STATES = ['guest', 'empty', 'loading', 'error', 'cancelled', 'invalid', 'stub', 'ready']

/** 五 Tab 的期望顺序：与 `docs/ui-demo` 移动端底部导航一致。 */
const EXPECTED_TAB_PATHS = [
  'pages/home/home',
  'pages/community/community',
  'pages/identify/identify',
  'pages/messages/messages',
  'pages/profile/profile'
]

/** 真机台账五条：项目名必须全文档唯一，状态只许「未取得」。 */
const DEVICE_ROWS = [
  '真机逐页走查（Android／iOS）',
  '真机 systemInfo 视口与字体倍率',
  '五 Tab 视觉截图（真机，与原 demo 并列）',
  'Android 真机安装与启动',
  'iOS 真机安装与启动'
]

function readText(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8')
}

function pageDirOf(pagePath) {
  // pages/home/home -> miniprogram/pages/home
  return join(PAGES_DIR, pagePath.split('/')[1])
}

/** 解析 `app.json`：五 Tab 是唯一来源。 */
function tabBarPaths(appJson) {
  return appJson.tabBar.list.map((item) => item.pagePath)
}

/** 四件套：.js/.json/.wxml/.wxss 均存在且非空。 */
function fourPieceReport(pagePath) {
  const dir = pageDirOf(pagePath)
  const name = pagePath.split('/').pop()
  const missing = []
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    const file = join(dir, `${name}.${ext}`)
    if (!existsSync(file)) missing.push(`${ext}:不存在`)
    else if (statSync(file).size === 0) missing.push(`${ext}:空文件`)
  }
  return missing
}

/** 解析自定义 tabBar 的 `const tabs = [...]`（只扫声明块，避免注释干扰）。 */
function customTabPaths(source) {
  const start = source.indexOf('const tabs = [')
  assert.notEqual(start, -1, 'custom-tab-bar/index.js 里找不到 `const tabs = [`')
  const end = source.indexOf(']', start)
  assert.notEqual(end, -1, 'custom-tab-bar/index.js 的 tabs 数组没有闭合')
  const block = source.slice(start, end)
  return [...block.matchAll(/pagePath:\s*'([^']+)'/g)].map((m) => m[1])
}

/** 解析 `state-view.js` 的 `PRESETS` 键（组件自己的判定表，未知值会回落 empty）。 */
function presetKeys(source) {
  const start = source.indexOf('const PRESETS = {')
  assert.notEqual(start, -1, 'state-view.js 里找不到 `const PRESETS = {`')
  const end = source.indexOf('\n};', start)
  assert.notEqual(end, -1, 'state-view.js 的 PRESETS 没有闭合')
  const block = source.slice(start, end)
  // 只认顶层键：两空格缩进 + `键: {`，四条预设字段是四空格缩进，不会被误收。
  return [...block.matchAll(/\n {2}([a-z_]+):\s*\{/g)].map((m) => m[1])
}

/** 解析 `docs/ui-state-inventory.md` §2 八态表的 key 列（第二列反引号内容）。 */
function documentedStateKeys(markdown) {
  const lines = markdown.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => /\|\s*状态\s*\|\s*key\s*\|/.test(line))
  assert.notEqual(headerIndex, -1, 'ui-state-inventory.md 里找不到 §2 八态表表头（| 状态 | key |）')

  const keys = []
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.startsWith('## ')) break // 表结束，避免误收后文表格
    const cells = line.split('|').map((cell) => cell.trim())
    if (cells.length < 4) continue
    const match = cells[2].match(/^`([a-z_]+)`$/)
    if (match) keys.push(match[1])
  }
  return keys
}

/**
 * 从 WXML 里取「渲染令牌」：`status="…"` 的属性值 + `status === '…'` 的比较值。
 * - `{{…}}` 动态绑定里的字面量也收（identify/profile 的既有写法）；
 * - 注释里的示例不算（先剥 `<!-- -->`）。
 */
function renderTokens(wxmlSource) {
  const source = wxmlSource.replace(/<!--[\s\S]*?-->/g, '')
  const tokens = []
  for (const match of source.matchAll(/(?<![\w-])status="([^"]*)"/g)) {
    const value = match[1]
    if (value.includes('{{')) {
      for (const literal of value.matchAll(/'([a-z_]+)'/g)) tokens.push(literal[1])
    } else if (value !== '') {
      tokens.push(value)
    }
  }
  for (const match of source.matchAll(/(?<![\w-])status\s*===\s*'([a-z_]+)'/g)) tokens.push(match[1])
  return tokens
}

/** 标签级扫描：返回 `{ name, attributes }`，属性值里的 `>` 不会截断标签。 */
function tagsOf(wxmlSource) {
  const source = wxmlSource.replace(/<!--[\s\S]*?-->/g, '')
  const tags = []
  for (const match of source.matchAll(/<\s*([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    tags.push({ name: match[1], attributes: match[2] })
  }
  return tags
}

/**
 * 闭集校验器（纯函数，供注入负控制复用）：
 * 返回违规清单，空数组表示全部落在闭集内。
 */
function statusViolations(tokens, closedSet) {
  const violations = []
  for (const token of tokens) {
    if (!closedSet.includes(token)) violations.push(token)
  }
  return violations
}

test('app.json 的 tabBar 是五 Tab 的唯一来源，四件套齐全', () => {
  const appJson = JSON.parse(readText('miniprogram/app.json'))
  assert.equal(appJson.tabBar.custom, true, '五 Tab 必须走 custom-tab-bar')

  const paths = tabBarPaths(appJson)
  assert.deepEqual(paths, EXPECTED_TAB_PATHS, 'tabBar.list 的 pagePath 顺序/集合变了')
  assert.equal(appJson.tabBar.list.length, 5, '五 Tab 不得增减')

  for (const item of appJson.tabBar.list) {
    assert.ok(item.text && item.text.trim().length > 0, `${item.pagePath} 缺少 tabBar 文案`)
    assert.ok(appJson.pages.includes(item.pagePath), `${item.pagePath} 未在 app.json pages 中注册`)
    const missing = fourPieceReport(item.pagePath)
    assert.deepEqual(missing, [], `${item.pagePath} 四件套缺失：${missing.join('、')}`)
  }
})

test('custom-tab-bar 与 app.json 同序同集，且只对已登记路径 switchTab', () => {
  const appJson = JSON.parse(readText('miniprogram/app.json'))
  const source = readText('miniprogram/custom-tab-bar/index.js')

  assert.deepEqual(customTabPaths(source), tabBarPaths(appJson), '自定义 tabBar 与 app.json 不同序或不同集')

  const block = source.slice(source.indexOf('const tabs = ['), source.indexOf(']', source.indexOf('const tabs = [')))
  const texts = block.match(/text:\s*'[^']+'/g)
  assert.ok(texts && texts.length === 5, '自定义 tabBar 的五条 text 不完整')

  assert.match(
    source,
    /if \(!tabs\.some\(tab => tab\.pagePath === path\)\) return/,
    'switchTab 的路径守卫被删：非 Tab 页会被 switchTab 调用'
  )
})

test('状态闭集三方一致：PRESETS ＝ 文档八态表 ＝ 任务书八态（集合相等）', () => {
  const presets = presetKeys(readText('miniprogram/components/state-view/state-view.js'))
  const documented = documentedStateKeys(readText('docs/ui-state-inventory.md'))

  assert.deepEqual([...presets].sort(), [...EIGHT_STATES].sort(), 'state-view 的 PRESETS 键与八态不一致')
  assert.deepEqual([...documented].sort(), [...EIGHT_STATES].sort(), '文档 §2 八态表的 key 列与八态不一致')
  assert.equal(new Set(presets).size, presets.length, 'PRESETS 存在重复键')

  // ready 的语义是「正常内容、不渲染本组件」，四字段必须为空，否则会抢走真实内容位。
  const readyBlock = readText('miniprogram/components/state-view/state-view.js').match(/ready:\s*\{[\s\S]*?\n {2}\}/)
  assert.ok(readyBlock, 'state-view.js 缺少 ready 预设')
  for (const field of ['icon', 'title', 'desc', 'actionText']) {
    assert.match(readyBlock[0], new RegExp(`${field}:\\s*''`), `ready 的 ${field} 必须为空串（不渲染）`)
  }
})

test('所有使用 state-view 的页面：渲染令牌 ⊆ 闭集，status 只挂在该组件上', () => {
  const closedSet = presetKeys(readText('miniprogram/components/state-view/state-view.js'))
  const pages = readdirSync(PAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const users = []
  for (const name of pages) {
    const jsonPath = join(PAGES_DIR, name, `${name}.json`)
    if (!existsSync(jsonPath)) continue
    const config = JSON.parse(readFileSync(jsonPath, 'utf8'))
    const registered = config.usingComponents && config.usingComponents['state-view']
    if (registered === undefined) continue
    assert.equal(registered, '/components/state-view/state-view', `${name} 注册了非统一组件的 state-view`)
    users.push(name)
  }
  assert.ok(users.length >= 13, `注册 state-view 的页面数异常：${users.length}`)

  const observed = new Set()
  for (const name of users) {
    const wxml = readFileSync(join(PAGES_DIR, name, `${name}.wxml`), 'utf8')

    for (const tag of tagsOf(wxml)) {
      if (/(?<![\w-])status=/.test(tag.attributes)) {
        assert.equal(
          tag.name,
          'state-view',
          `${name}.wxml 把 status 挂在了 <${tag.name}> 上，绕过了统一失败态组件`
        )
      }
    }

    const tokens = renderTokens(wxml)
    for (const token of tokens) observed.add(token)
    assert.deepEqual(
      statusViolations(tokens, closedSet),
      [],
      `${name}.wxml 出现闭集外状态：${statusViolations(tokens, closedSet).join('、')}`
    )
  }

  // 反向：页面真的用到了闭集里的取值（不是只在 json 里注册）。
  assert.ok(observed.size >= 4, `页面实际使用的状态过少：${[...observed].join('、')}`)
  for (const token of observed) assert.ok(closedSet.includes(token), `观测到闭集外取值 ${token}`)
})

test('五 Tab 页的失败态入口必须走 state-view，不得自写状态块', () => {
  const closedSet = presetKeys(readText('miniprogram/components/state-view/state-view.js'))
  const failureTokens = ['loading', 'error', 'empty']

  for (const name of ['home', 'community', 'identify', 'messages', 'profile']) {
    const json = JSON.parse(readText(`miniprogram/pages/${name}/${name}.json`))
    assert.equal(
      json.usingComponents && json.usingComponents['state-view'],
      '/components/state-view/state-view',
      `${name}.json 未注册统一失败态组件`
    )

    const wxml = readText(`miniprogram/pages/${name}/${name}.wxml`)
    assert.match(wxml, /<state-view/, `${name}.wxml 没有使用 <state-view>`)

    // status === '…' 的比较只允许出现在 <state-view> 标签内部。
    for (const tag of tagsOf(wxml)) {
      const comparisons = [...tag.attributes.matchAll(/status\s*===\s*'([a-z_]+)'/g)].map((m) => m[1])
      if (comparisons.length === 0) continue
      assert.equal(
        tag.name,
        'state-view',
        `${name}.wxml 用 <${tag.name}> 上的 status 比较自写状态分支，绕过统一组件`
      )
    }

    // 页面 JS 置的失败/加载/空态，必须在 WXML 里有对应 state-view 渲染令牌。
    const js = readText(`miniprogram/pages/${name}/${name}.js`)
    const jsTokens = [...js.matchAll(/status:\s*'([a-z_]+)'/g)].map((m) => m[1])
    const tokens = new Set(renderTokens(wxml))
    for (const token of jsTokens) {
      if (!failureTokens.includes(token)) continue // 'ready'/'idle' 等不是失败态令牌
      assert.ok(
        tokens.has(token),
        `${name}.js 会置 status='${token}'，但 WXML 没有对应的 state-view 渲染令牌`
      )
    }
  }
})

test('注入负控制：闭集外的 status 必须被判红（合成片段，不改源文件）', () => {
  const closedSet = presetKeys(readText('miniprogram/components/state-view/state-view.js'))

  // 1) 闭集外取值 —— 必须报出来
  const injected = '<state-view wx:if="{{status === \'mystery\'}}" status="mystery" />'
  assert.deepEqual(statusViolations(renderTokens(injected), closedSet).sort(), ['mystery', 'mystery'])

  // 2) 干净片段 —— 必须零违规
  assert.deepEqual(statusViolations(renderTokens('<state-view status="error" />'), closedSet), [])

  // 3) 动态绑定里的字面量同样受检
  const dynamic = '<state-view status="{{guest ? \'guest\' : \'ready\'}}" />'
  assert.deepEqual(statusViolations(renderTokens(dynamic), closedSet), [])

  // 4) 非 state-view 标签消费 status —— 必须报出来
  const bypass = '<view class="box" status="loading">加载中</view>'
  const bypassTags = tagsOf(bypass)
  assert.equal(bypassTags.length, 1)
  assert.notEqual(bypassTags[0].name, 'state-view', '绕过守卫必须能被识别')

  // 5) 闭集漏掉 ready —— 与文档集合相等必须失败
  const missingReady = closedSet.filter((key) => key !== 'ready')
  assert.notDeepEqual([...missingReady].sort(), [...EIGHT_STATES].sort(), '闭集少一个键也必须判红')
})

test('真机台账：五条只登记「未取得」，不写成通过，且写明不构成条款 2 通过', () => {
  const markdown = readText(EVIDENCE_DOC)
  const heading = '## 12. 真机项台账'
  const start = markdown.indexOf(heading)
  assert.notEqual(start, -1, `证据文档缺少「${heading}」小节`)
  const section = markdown.slice(start)

  const rows = section
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.split('|').map((cell) => cell.trim()).filter((cell, index, all) => index > 0 && index < all.length - 1))
    .filter((cells) => cells.length >= 3 && !cells.every((cell) => /^-{2,}$/.test(cell) || cell === ''))

  for (const label of DEVICE_ROWS) {
    const matching = rows.filter((cells) => cells[0] === label)
    assert.equal(matching.length, 1, `台账里「${label}」必须且只能出现一行（实际 ${matching.length} 行）`)
    const [, status, condition] = matching[0]
    assert.match(status, /^\**未取得\**$/, `「${label}」的状态必须如实写「未取得」，实得「${status}」`)
    assert.ok(condition && condition.length >= 8, `「${label}」必须写清缺什么条件`)
  }

  // 未取得行不得同时出现在任何「已通过／已取得」表里（全文档逐行核对）。
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    for (const label of DEVICE_ROWS) {
      if (!line.includes(label)) continue
      assert.doesNotMatch(line, /已通过|已取得|已实测/, `「${label}」同时出现在通过型表述里：${line.trim()}`)
    }
  }

  assert.match(
    section,
    /以上均为未取得项，不构成条款 2 通过/,
    '台账末尾必须写明「以上均为未取得项，不构成条款 2 通过」'
  )
})
