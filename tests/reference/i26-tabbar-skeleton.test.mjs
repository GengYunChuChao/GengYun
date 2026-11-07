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
 *      `docs/ui-state-inventory.md` §2 九态表的 key 列**集合相等**（不是包含），
 *      且所有页面实际使用的字面量取值必须是该闭集的真子集。
 *      —— 为什么对照物是这份文档而不是 `packages/contracts/states.json`：
 *         `states.json`（contract_version 1.0.0）只有 13 个**领域**闭集，没有页面级
 *         status 键；它是冻结契约（`docs/ui-state-inventory.md` §8 明写「不修改
 *         `packages/contracts/` 下任何冻结契约」），为其新增页面级枚举会直接推翻冻结
 *         基线。故闭集的成文权威取页面状态清单 §2，并在交接里如实说明这处口径。
 *   4) 真机台账：`docs/verification/gy-i26-demo-align-20261014.md` §12 的五条真机项
 *      必须写清缺什么条件，且「未取得」项不得同时出现在任何「已通过」表里。
 *   5) 真机台账**形状闸门**（2026-11-07 补）：五条真机项长期恒为「未取得」而无人复核，
 *      光靠「状态写未取得」这一条挡不住空转——它既不允许真取得，也不检查欠账是否具体。
 *      故把两侧都写成可机检的形状：
 *        · 状态只许闭集 `未取得`／`已取得`；`已验`／`部分取得`／`进行中`／`未做` 一律红；
 *        · `未取得` ⇒ `缺什么条件` 必须是具体阻塞物（≥24 字、含阻塞词、非占位符），
 *          `复核入口` 必须是可执行动作（≥12 字、含动作词），且整行不得出现
 *          `已取得／已通过／已实测`、`证据见／截图见／已留存／已归档／已验／已见／
 *          截图显示／实测通过`、截图资产路径 —— 在册欠账不许顺手声称已有证据。
 *          后四个词是 2026-11-07 复查补的：只收「证据见」这类书面语时，
 *          「真机已验，截图显示五 Tab 全部正常」这种口语句式能整行绿着空转；
 *          `人工确认` 故意**不在**黑名单里 —— 它是合法阻塞物（「需人工确认三档字体倍率…」）。
 *        · `已取得` ⇒ 行内必须同时有**真实且不晚于今天（本地日期）**的日历日（`YYYY-MM-DD`；
 *          `2026-13-45` 因 UTC 往返不等而红、`2099-12-31` 因晚于今天而红；用
 *          `toISOString()` 取「今天」会在 HKT 00:00–07:59 把合法的今天判成未来，故取本地日期）、
 *          **落在 `docs/verification/assets/` 下的截图证据**（扩展名限 png/jpg/jpeg/webp，
 *          故指向 `docs/requirements.md` 或台账自身都不算证据）、该文件真实存在、是文件、
 *          且 ≥1024 字节（只防 0 字节占位，不是画质判据），以及**仍可执行的复核入口**
 *          —— 只验「路径存在」时，一行字没动就能靠 `docs/requirements.md` 变绿；
 *        · **逐行唯一**：同一条证据路径不得同时点亮多个设备行（`Set` 收已用路径，重复即红），
 *          否则拿到一张图就能一次「取得」五条设备项，台账上看不出哪一行对应哪张图；
 *        · 证据口径只作用于证据本身：`复核入口` 列里的 `node tools/verify-layout.mjs`
 *          这类复跑命令不算证据，只有截图扩展名或紧跟「证据／截图／留存／归档」的路径才算；
 *        · 表头之后必须紧跟 Markdown 分隔行，删掉它表格在渲染层就散架了。
 *      —— date/evidence 为什么不新开列：§12 表只有四列（项目/状态/缺什么条件/复核入口），
 *         加列会让现有五行立刻缺列、也等于改写台账内容；故两者以「行内必须出现的形状」
 *         表达，判据集中在 `deviceRowViolations()`，可脱离磁盘单独做负控制。
 *
 * 能证明什么：仓库里的骨架接线、闭集一致性、台账措辞与**台账形状**没有回退；注入闭集外
 * 的 status、删掉任意四件套之一、把某条伪装成「已取得」而证据不存在／不是截图／是 0 字节
 * 占位／指向文档或台账自身／用未来日期、或写出枚举外状态，都会让本文件变红
 * （见「注入负控制」与「台账闸门负控制」两个用例）。
 * 不能证明什么：本文件**不编译 WXML/WXSS、不启动微信开发者工具、不接触真机**，
 * 真机逐页渲染、真机字号与真机截图仍未取得，见证据文档 §12；形状闸门只证明「欠账登记
 * 完整／已取得的证据在资产目录里真实存在且非空、日期不晚于今天」，**不证明真机验收已发生**：
 * 它分不清一张 `docs/verification/assets/` 里的旧 jpg 是模拟器还是真机，也判断不了截图内容
 * 是否与五 Tab 有关——这两条仍只能人工复核。
 *
 * Refs #28
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PAGES_DIR = join(ROOT, 'miniprogram', 'pages')
const EVIDENCE_DOC = 'docs/verification/gy-i26-demo-align-20261014.md'

/** 任务书与 `state-view.js` 头注释共同固定的九态（顺序取文档表）。
 *  B7（Refs #28，2026-10-21）增补 `denied`：与 `guest`（401「还没登录」）分开，
 *  `denied` 是「登录了但这件东西不给你」（403 `SCOPE_DENIED`／`CONSENT_REQUIRED`／
 *  `ACCOUNT_INACTIVE`）。折叠成同一句会让用户反复登录仍不明白原因。 */
const STATE_KEYS = ['guest', 'empty', 'loading', 'error', 'cancelled', 'invalid', 'stub', 'denied', 'ready']

/** 五 Tab 的期望顺序：与 `docs/ui-demo` 移动端底部导航一致。 */
const EXPECTED_TAB_PATHS = [
  'pages/home/home',
  'pages/community/community',
  'pages/identify/identify',
  'pages/messages/messages',
  'pages/profile/profile'
]

/** 真机台账五条：项目名必须全文档唯一，状态取值受下方闭集约束。 */
const DEVICE_ROWS = [
  '真机逐页走查（Android／iOS）',
  '真机 systemInfo 视口与字体倍率',
  '五 Tab 视觉截图（真机，与原 demo 并列）',
  'Android 真机安装与启动',
  'iOS 真机安装与启动'
]

/** §12 表的列契约：列名/列数一变就必须同步改本文件，否则闸门先红（防静默加列/改名）。 */
const DEVICE_TABLE_HEADER = ['项目', '状态', '缺什么条件', '复核入口']

/** 真机项状态闭集：只有「在册欠账」与「已取得且可核」两种，没有第三态。
 *  `已验`／`部分取得`／`进行中`／`未做` 等含糊写法一律判红——台账长期空转正是靠含糊词活着。 */
const DEVICE_STATUS_ENUM = ['未取得', '已取得']

/** 占位符：整格就是这些词的，不算「写清了缺什么」。 */
const LEDGER_PLACEHOLDER = /^(?:—+|-+|无|暂无|不适用|待定|未知|tbd|n\/a|同上|见上|略)$/i
/** 阻塞词：`缺什么条件` 里必须出现，否则那句话只是在复读状态。 */
const LEDGER_BLOCKER_WORDS = /需|缺|待|无法|不可|没有|无可用|依赖|等待|受阻/
/** 动作词：`复核入口` 里必须出现，否则那条入口不可执行（点不开、跑不了、没法复核）。 */
const LEDGER_ACTION_WORDS = /→|打开|记录|读取|截图|截一张|复跑|核对|对照|复验|扫码|打印|对账|补入|检查|归档|登记|测量|采集/
/** 「未取得」行不得出现的已取得措辞。 */
const LEDGER_ACQUIRED_WORDS = /已取得|已通过|已实测/
/** 「未取得」行不得出现的证据声称（不收「工具内计算样式证据」这类历史表述）。
 *  2026-11-07 复查补 `已验|已见|截图显示|实测通过`：断言「一律红」就得真的盖住口语说法——
 *  否则「真机已验，截图显示五 Tab 全部正常，逐页记录异常」整行绿着空转。
 *  **不含 `人工确认`**：它是合法的阻塞物（如「需人工确认三档字体倍率是否达标」），
 *  收进黑名单会把正常的欠账登记误判成「声称已有证据」。 */
const LEDGER_EVIDENCE_CLAIM = /证据见|截图见|已留存|已归档|已验|已见|截图显示|实测通过/
/** 已取得项的证据必须落在截图资产目录下。只验「路径存在」时，指向 `docs/requirements.md`
 *  这类受保护文档也能整行变绿——台账一个字没改，真机项却「取得」了。锁目录 + 锁扩展名
 *  同时排除了台账自身（台账是 `.md`，被扩展名挡掉）。 */
const LEDGER_EVIDENCE_DIR = 'docs/verification/assets/'
const LEDGER_EVIDENCE_EXT = /\.(?:png|jpe?g|webp)$/i
/** 证据文件下限：只防 0 字节/占位文件，**不是画质判据**（清晰度、是否真机仍靠人看）。 */
const LEDGER_MIN_EVIDENCE_BYTES = 1024
/** 截图资产路径：欠账行出现它等于声称「截图已经拿到了」。
 *  字符类必须放宽到「非空白非分隔符」——中文文件名（如 `不存在的文件.png`）不在 `\w`
 *  里，收窄会把「证据不存在」误报成「没有证据」。 */
const LEDGER_ASSET_PATH = /[^\s|`'「」（）(),，;；、]*\.(?:png|jpe?g|webp|gif)\b/gi
/** 仓库内相对路径（证据材料）：带扩展名且挂在仓库目录下（同上，允许中文文件名）。 */
const LEDGER_REPO_PATH = /\b(?:docs|tests|tools|miniprogram|services|apps|packages)\/[^\s|`'「」（）(),，;；、]+\.(?:md|png|jpe?g|webp|gif|json|txt|mjs|js|yml|yaml)\b/gi
/** 日期令牌：`已取得` 行必须能解析出一个真实日历日。 */
const LEDGER_DATE_TOKEN = /\b\d{4}-\d{2}-\d{2}\b/g
/** 证据引导词：`复核入口` 列里只有紧跟这些词的仓库路径才算「证据」。
 *  「复核入口」列天然会写复跑命令（`node tools/verify-layout.mjs`），把执行入口当成证据
 *  会让合法的已取得行误红；故该列只在「截图扩展名」或「紧跟在证据引导词后」时才算证据。 */
const LEDGER_EVIDENCE_MARKER = /证据|截图|留存|归档/

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

/** 解析 §12 真机台账：返回 `{ section, header, separator, rows }`
 *  （rows 为数据行，已剔表头与分隔行；separator 保留原始分隔行以便断言「表还得是表」）。 */
function parseDeviceLedger(markdown) {
  const heading = '## 12. 真机项台账'
  const start = markdown.indexOf(heading)
  assert.notEqual(start, -1, `证据文档缺少「${heading}」小节`)
  const section = markdown.slice(start)
  const tableLines = section.split(/\r?\n/).filter((line) => line.trim().startsWith('|'))
  const toCells = (line) =>
    line
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell, index, all) => index > 0 && index < all.length - 1)
  const isSeparator = (line) => /^\|[\s:|-]+\|$/.test(line.trim()) && line.includes('---')
  const header = toCells(tableLines[0] || '')
  const secondLine = tableLines[1] || ''
  const separator = isSeparator(secondLine) ? secondLine.trim() : null
  const rows = tableLines
    .slice(1)
    .filter((line) => !isSeparator(line))
    .map(toCells)
    .filter((cells) => cells.length >= 3 && !cells.every((cell) => /^-{2,}$/.test(cell) || cell === ''))
  return { section, header, separator, rows }
}

/** `YYYY-MM-DD` → 真实日历日（UTC 往返必须三项全等，故 `2026-13-45` 为假）。 */
function isRealCalendarDate(text) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!matched) return false
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  )
}

/** 仓库内相对路径 → 真实存在的**文件**；绝对路径与 `..` 逃逸一律判不可核。 */
function isRepoFileOnDisk(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return false
  if (/^[A-Za-z]:[\\/]/.test(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) return false
  if (relPath.split(/[\\/]/).includes('..')) return false
  const absolute = join(ROOT, relPath)
  return existsSync(absolute) && statSync(absolute).isFile()
}

/** 证据文件字节数；不存在/不是文件返回 -1（与真实的 0 字节占位区分开，便于读断言）。 */
function evidenceBytesOf(relPath) {
  try {
    return statSync(join(ROOT, relPath)).size
  } catch {
    return -1
  }
}

/**
 * 一行里「算作证据」的仓库相对路径。四列台账没有独立证据列，故按列分口径：
 * · `缺什么条件` 列（第 3 列）在已取得行里只该写日期与证据 ⇒ 出现的仓库路径一律当证据；
 * · `复核入口` 列（第 4 列）是执行入口 ⇒ 只有截图扩展名、或紧跟「证据/截图/留存/归档」的路径才算证据，
 *   `node tools/verify-layout.mjs` 这种复跑命令不算（否则合法的已取得行会被误判成「证据指向文档」）。
 */
function evidencePathsOf(cells) {
  const [, , blockedBy = '', recheck = ''] = cells
  const paths = new Set()
  for (const matched of blockedBy.matchAll(LEDGER_REPO_PATH)) paths.add(matched[0])
  for (const matched of recheck.matchAll(LEDGER_REPO_PATH)) {
    const before = recheck.slice(Math.max(0, matched.index - 6), matched.index)
    if (LEDGER_EVIDENCE_EXT.test(matched[0]) || LEDGER_EVIDENCE_MARKER.test(before)) {
      paths.add(matched[0])
    }
  }
  return [...paths]
}

/**
 * 单行形状校验（纯函数，`isRepoFile`／`bytesOf` 可注入 ⇒ 负控制不依赖新增或伪造文件）。
 * 返回违规描述数组，空数组表示这一行符合对应分支的形状契约。
 */
function deviceRowViolations(cells, isRepoFile = isRepoFileOnDisk, bytesOf = evidenceBytesOf) {
  const [label, rawStatus = '', blockedBy = '', recheck = ''] = cells
  // 有意规范化：台账里 `**未取得**` 的粗体星号、全角空格与 NBSP 都先抹平成等值再比对，
  // 免得「写法不同」被当成「取值不同」——这不是漏网，判据比的是状态语义，不是 Markdown 装饰。
  const status = rawStatus.replace(/\*/g, '').trim()
  const rowText = cells.join(' | ')
  const violations = []

  if (!DEVICE_STATUS_ENUM.includes(status)) {
    violations.push(
      `「${label}」的状态「${rawStatus}」不在闭集内（只允许 ${DEVICE_STATUS_ENUM.join(' / ')}）`
    )
    return violations // 状态认不出，分臂判据无意义
  }

  if (status === '未取得') {
    if (blockedBy.length < 24 || LEDGER_PLACEHOLDER.test(blockedBy)) {
      violations.push(
        `「${label}」状态为未取得，但「缺什么条件」不足 24 字或是占位符：${blockedBy || '(空)'}`
      )
    }
    if (!LEDGER_BLOCKER_WORDS.test(blockedBy)) {
      violations.push(
        `「${label}」的「缺什么条件」没写缺的是什么（须含 需/缺/待/无法/依赖 一类阻塞词）：${blockedBy}`
      )
    }
    if (recheck.length < 12 || LEDGER_PLACEHOLDER.test(recheck)) {
      violations.push(
        `「${label}」状态为未取得，但「复核入口」不足 12 字或是占位符：${recheck || '(空)'}`
      )
    }
    if (!LEDGER_ACTION_WORDS.test(recheck)) {
      violations.push(
        `「${label}」的「复核入口」不是可执行动作（须含 打开/记录/读取/截图/核对 一类动作词）：${recheck}`
      )
    }
    const acquired = rowText.match(LEDGER_ACQUIRED_WORDS)
    if (acquired) {
      violations.push(
        `「${label}」状态为未取得，却含已取得类措辞「${acquired[0]}」：欠账行不得声称已有证据`
      )
    }
    const claim = rowText.match(LEDGER_EVIDENCE_CLAIM)
    if (claim) {
      violations.push(
        `「${label}」状态为未取得，却含证据声称「${claim[0]}」：欠账行不得声称已有证据`
      )
    }
    const assets = [...rowText.matchAll(LEDGER_ASSET_PATH)]
    if (assets.length > 0) {
      violations.push(
        `「${label}」状态为未取得，却带截图资产路径「${assets[0][0]}」：欠账行不得携带已取得的证据`
      )
    }
    return violations
  }

  // status === '已取得'：日期要真实且不晚于今天；证据必须是 assets/ 下的非空截图；
  // 而且「已取得」不等于可以不复核 —— 复核入口仍要可执行。
  const dates = [...rowText.matchAll(LEDGER_DATE_TOKEN)].map((matched) => matched[0])
  if (dates.length === 0) {
    violations.push(`「${label}」状态为已取得，但没有日期（须写 YYYY-MM-DD）`)
  }
  // 本地日期，不用 toISOString()：UTC 口径在 HKT 00:00–07:59 窗口会把合法的「今天」判成未来。
  const now = new Date()
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-')
  for (const date of dates) {
    if (!isRealCalendarDate(date)) {
      violations.push(`「${label}」的日期「${date}」不是真实日历日`)
    } else if (date > today) {
      violations.push(`「${label}」的日期「${date}」晚于今天（${today}）：不得用未来日期登记已取得`)
    }
  }
  if (recheck.length < 12 || LEDGER_PLACEHOLDER.test(recheck)) {
    violations.push(
      `「${label}」状态为已取得，但「复核入口」不足 12 字或是占位符：${recheck || '(空)'}`
    )
  }
  if (!LEDGER_ACTION_WORDS.test(recheck)) {
    violations.push(
      `「${label}」的「复核入口」不可执行（已取得项也要能复验，须含 打开/核对/复跑 一类动作词）：${recheck}`
    )
  }
  const paths = evidencePathsOf(cells)
  if (paths.length === 0) {
    violations.push(`「${label}」状态为已取得，但没有仓库内相对路径证据`)
  }
  for (const repoPath of paths) {
    if (!repoPath.startsWith(LEDGER_EVIDENCE_DIR)) {
      violations.push(
        `「${label}」的证据必须落在 ${LEDGER_EVIDENCE_DIR} 下（不得指向文档或台账自身）：${repoPath}`
      )
      continue
    }
    if (!LEDGER_EVIDENCE_EXT.test(repoPath)) {
      violations.push(`「${label}」的证据必须是截图（.png/.jpg/.jpeg/.webp）：${repoPath}`)
      continue
    }
    if (!isRepoFile(repoPath)) {
      violations.push(`「${label}」的证据路径不可核（不存在／不是文件／不在仓库内）：${repoPath}`)
      continue
    }
    const bytes = bytesOf(repoPath)
    if (bytes < LEDGER_MIN_EVIDENCE_BYTES) {
      violations.push(
        `「${label}」的证据文件只有 ${bytes} 字节（< ${LEDGER_MIN_EVIDENCE_BYTES}，防 0 字节占位）：${repoPath}`
      )
    }
  }
  return violations
}

/** 整表校验：列契约、行集合与逐行形状。返回违规描述数组。 */
function deviceLedgerViolations(header, rows, isRepoFile = isRepoFileOnDisk, bytesOf = evidenceBytesOf) {
  const violations = []
  if (JSON.stringify(header) !== JSON.stringify(DEVICE_TABLE_HEADER)) {
    violations.push(
      `§12 表头列契约变了：实得「${(header || []).join(' / ')}」，应为「${DEVICE_TABLE_HEADER.join(' / ')}」`
    )
  }
  const labels = rows.map((cells) => cells[0])
  for (const label of DEVICE_ROWS) {
    if (!labels.includes(label)) violations.push(`§12 缺行：「${label}」不在台账里`)
  }
  for (const label of labels) {
    if (!DEVICE_ROWS.includes(label)) {
      violations.push(`§12 出现未登记的真机项「${label}」（新增真机项须同步本文件 DEVICE_ROWS）`)
    }
  }
  for (const cells of rows) {
    if (cells.length !== DEVICE_TABLE_HEADER.length) {
      violations.push(`§12 行「${cells[0]}」列数为 ${cells.length}，应为 ${DEVICE_TABLE_HEADER.length}`)
      continue
    }
    violations.push(...deviceRowViolations(cells, isRepoFile, bytesOf))
  }
  // 逐行唯一性：同一条证据不得跨行复用。否则「拿到一张图」就能一次点亮五条设备行，
  // 而台账上看不出哪一行对应哪张图 —— 与「长期空转」同类；比较键先归一化，否则 `/./`、`//`、大小写各算一条新证据。
  const evidenceOwners = new Map()
  for (const cells of rows) {
    const status = (cells[1] || '').replace(/\*/g, '').trim()
    if (status !== '已取得') continue
    for (const repoPath of evidencePathsOf(cells)) {
      const key = normalizeEvidencePath(repoPath)
      const owners = evidenceOwners.get(key) || []
      if (!owners.some((owner) => owner.label === cells[0])) owners.push({ label: cells[0], raw: repoPath })
      evidenceOwners.set(key, owners)
    }
  }
  for (const [key, owners] of evidenceOwners) {
    if (owners.length > 1) {
      const rowSpellings = owners.map((owner) => `${owner.label}→${owner.raw}`).join('、')
      violations.push(`同一条证据不得同时点亮多个设备行（哪一行是哪张图必须能对上）：${key}（${rowSpellings}）`)
    }
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

test('状态闭集三方一致：PRESETS ＝ 文档九态表 ＝ 任务书九态（集合相等）', () => {
  const presets = presetKeys(readText('miniprogram/components/state-view/state-view.js'))
  const documented = documentedStateKeys(readText('docs/ui-state-inventory.md'))

  assert.deepEqual([...presets].sort(), [...STATE_KEYS].sort(), 'state-view 的 PRESETS 键与九态不一致')
  assert.deepEqual([...documented].sort(), [...STATE_KEYS].sort(), '文档 §2 九态表的 key 列与九态不一致')
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

    // 覆盖面声明（本文件只做静态结构校验，勿读成运行期验证）：
    //   · 全文件只断言仓库里的**静态文本与文件结构**：五 Tab 四件套（js/json/wxml/wxss）
    //     的存在性与 `pagePath` 一致性、`state-view` 九态闭集三方相等（§2 文档表＝
    //     `PRESETS` 键＝本文件常量）、以及真机台账的措辞。不编译 WXML/WXSS、不启动
    //     微信开发者工具、不触真机 ⇒ 不证明真机渲染、不证明 TabBar 图标视觉、
    //     不证明开发者工具内编译通过（真机五项仍为「未取得」，见证据文档 §12）。
    //   · 下面这段只把页面 JS 的 `status: '…'` 字面量与 WXML 的 state-view 渲染令牌
    //     对表，且**仅对 loading/error/empty 三类失败态**要求「WXML 有对应令牌」：
    //     不判该字面量是否属于九态闭集，也不推断运行期实际取值 ⇒ 闭集外的
    //     `status: 'idle'`（messages.js 既有）不会被报出。闭集归属只对
    //     「渲染令牌」那一侧生效（见上一个断言块）。
    //   · `{{…}}` 内没有字面量的计算态不产生任何令牌（如 identify.wxml 的
    //     `status="{{stateView.component}}"`），故不参与本用例的断言。
    //   · 未在自身 json 里注册 state-view 的页面不在本用例范围（与「引用 state-view
    //     的页面」这一口径一致）；这类页面即便新增 status 也不会被判红。
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
  assert.notDeepEqual([...missingReady].sort(), [...STATE_KEYS].sort(), '闭集少一个键也必须判红')
})

test('真机台账：状态只许闭集取值；未取得必带可核欠账，已取得必带真实日期与 assets/ 下的非空截图', () => {
  const markdown = readText(EVIDENCE_DOC)
  const { section, header, separator, rows } = parseDeviceLedger(markdown)

  // 1) 表头列契约：静默加列/改名会让下面的分臂判据失效，故先钉死。
  assert.deepEqual(header, DEVICE_TABLE_HEADER, `§12 表头列变了：${(header || []).join(' / ')}`)

  // 1b) 表头之后必须紧跟 Markdown 分隔行：删掉它，表格在渲染层就不再是表格，
  //     读者看到的将是一段竖线文本——形状闸门要先保证「表还在」。
  assert.ok(
    separator !== null && separator.includes('---'),
    '§12 表头之后必须紧跟分隔行（| --- | --- | --- | --- |）'
  )

  // 2) 五条真机项各一行、状态在闭集内、写清缺什么条件（原有断言）。
  for (const label of DEVICE_ROWS) {
    const matching = rows.filter((cells) => cells[0] === label)
    assert.equal(matching.length, 1, `台账里「${label}」必须且只能出现一行（实际 ${matching.length} 行）`)
    const [, status, condition] = matching[0]
    assert.ok(
      DEVICE_STATUS_ENUM.includes(status.replace(/\*/g, '').trim()),
      `「${label}」的状态「${status}」不在闭集内（只允许 ${DEVICE_STATUS_ENUM.join(' / ')}）`
    )
    assert.ok(condition && condition.length >= 8, `「${label}」必须写清缺什么条件`)
  }

  // 3) 已登记「未取得」的条目不得同时出现在任何「已通过／已取得」表里（全文档逐行核对；
  //    已取得行不受此限——它本来就该在正文里给出证据）。
  const statusOf = new Map(rows.map((cells) => [cells[0], cells[1].replace(/\*/g, '').trim()]))
  const acquiredCount = [...statusOf.values()].filter((status) => status === '已取得').length
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    for (const label of DEVICE_ROWS) {
      if (!line.includes(label)) continue
      if (statusOf.get(label) === '已取得') continue
      assert.doesNotMatch(line, /已通过|已取得|已实测/, `「${label}」同时出现在通过型表述里：${line.trim()}`)
    }
  }

  // 3b) 收尾声明必须与台账自洽：还有未取得项就必须写「以上均为未取得项…」；五条全转
  //     「已取得」后仍这么写，就是「台账 + 结论」互相打架，判红（防用一句旧结论盖住新状态）。
  if (acquiredCount < rows.length) {
    assert.match(
      section,
      /以上均为未取得项，不构成条款 2 通过/,
      '台账末尾必须写明「以上均为未取得项，不构成条款 2 通过」'
    )
  } else {
    assert.doesNotMatch(
      section,
      /以上均为未取得项/,
      '五条已全部转「已取得」，收尾却仍写「以上均为未取得项」：台账与结论自相矛盾'
    )
  }

  // 4) 形状闸门：欠账登记是否具体、已取得的日期与证据是否可核。
  const violations = deviceLedgerViolations(header, rows)
  assert.deepEqual(violations, [], `§12 真机台账形状不合规：\n${violations.join('\n')}`)
})

test('真机台账闸门负控制：合成行必须逐条咬红，合法行必须零违规（不改源文档）', () => {
  const label = '真机逐页走查（Android／iOS）'
  const blockedBy = '需一台可扫码的 Android 真机与一台 iOS 真机，且 automator 端口稳定'
  const recheck = '真机调试 → 五 Tab 逐页打开并记录异常与首屏耗时'
  // 只认仓库里真实存在的一条证据 + 一条合成 0 字节占位；其余路径一律判不可核
  // ⇒ 负控制不需要新增或伪造任何文件（0 字节那条只走纯函数的字节探针）。
  const realEvidence = 'docs/verification/assets/gui-adaptive-250c4d4/01-home.jpg'
  const zeroByteEvidence = 'docs/verification/assets/_probe-0byte.png'
  const fakeRepoFile = (relPath) => relPath === realEvidence || relPath === zeroByteEvidence
  const fakeBytes = (relPath) => (relPath === zeroByteEvidence ? 0 : 612672)
  const violationsOf = (cells) => deviceRowViolations(cells, fakeRepoFile, fakeBytes).join('\n')

  // 0) 合法欠账行：零违规（闸门不是「一律红」）
  assert.equal(violationsOf([label, '未取得', blockedBy, recheck]), '')

  // 1) 枚举外状态
  assert.match(violationsOf([label, '已验', blockedBy, recheck]), /不在闭集内/)
  // 2) 欠账登记退化成占位符
  assert.match(violationsOf([label, '未取得', '—', recheck]), /缺什么条件/)
  // 3) 阻塞物只写三个字——长度不够也红
  assert.match(violationsOf([label, '未取得', '需补充', recheck]), /缺什么条件/)
  // 4) 未取得却顺手声称已取得
  assert.match(violationsOf([label, '未取得', `${blockedBy}（已取得）`, recheck]), /不得声称已有证据/)
  // 5) 未取得却携带截图资产路径
  assert.match(
    violationsOf([label, '未取得', blockedBy, `${recheck}，截图见 ${realEvidence}`]),
    /截图资产路径/
  )
  // 6) 已取得但没有日期
  assert.match(
    violationsOf([label, '已取得', `证据 ${realEvidence}`, recheck]),
    /没有日期/
  )
  // 7) 日期不是真实日历日
  assert.match(
    violationsOf([label, '已取得', `2026-13-45 证据 ${realEvidence}`, recheck]),
    /不是真实日历日/
  )
  // 8) 日期合法但证据指向不存在的文件
  assert.match(
    violationsOf([
      label,
      '已取得',
      '2026-11-07 证据 docs/verification/assets/不存在的文件.png',
      recheck
    ]),
    /证据路径不可核/
  )
  // 9) 日期与真实存在的证据齐备 —— 已取得分支必须可满足，否则等于把「已取得」判成永假
  assert.equal(violationsOf([label, '已取得', `2026-11-07 证据 ${realEvidence}`, recheck]), '')
  // 10) 已取得但证据指向文档而非截图资产（只验存在性时这里会整行绿）
  assert.match(
    violationsOf([label, '已取得', '2026-11-07 证据 docs/requirements.md', recheck]),
    /证据必须落在 docs\/verification\/assets\//
  )
  // 11) 已取得但证据是 0 字节占位
  assert.match(
    violationsOf([label, '已取得', `2026-11-07 证据 ${zeroByteEvidence}`, recheck]),
    /0 字节/
  )
  // 12) 已取得但日期在未来
  assert.match(
    violationsOf([label, '已取得', `2099-12-31 证据 ${realEvidence}`, recheck]),
    /晚于今天/
  )
  // 13) 已取得但复核入口是占位符 —— 取得之后仍要能复验
  assert.match(violationsOf([label, '已取得', `2026-11-07 证据 ${realEvidence}`, '—']), /复核入口/)
  // 14) 未取得却用口语句式声称已验（审查反例原句）
  assert.match(
    violationsOf([label, '未取得', '真机已验，截图显示五 Tab 全部正常，逐页记录异常', recheck]),
    /却含证据声称/
  )
  // 15) 表头之后删掉分隔行 ⇒ 解析器必须认不出这张表（正例见主用例 1b）
  const noSeparator = parseDeviceLedger(
    '## 12. 真机项台账\n\n| 项目 | 状态 | 缺什么条件 | 复核入口 |\n' +
      `| ${label} | 未取得 | ${blockedBy} | ${recheck} |\n`
  )
  assert.equal(noSeparator.separator, null, '删掉分隔行后 separator 必须为 null')

  // 16) 本地「今天」必须绿：UTC 口径会在 HKT 00:00–07:59 窗口把合法的「今天」判成未来
  const localNow = new Date()
  const localToday = [
    localNow.getFullYear(),
    String(localNow.getMonth() + 1).padStart(2, '0'),
    String(localNow.getDate()).padStart(2, '0')
  ].join('-')
  assert.equal(violationsOf([label, '已取得', `${localToday} 证据 ${realEvidence}`, recheck]), '')
  // 17) 复核入口里写复跑命令（`tools/*.mjs`）不算证据 —— 收窄后不该误红
  assert.equal(
    violationsOf([
      label,
      '已取得',
      `2026-11-07 证据 ${realEvidence}`,
      `${recheck} → node tools/verify-layout.mjs 对照计算样式`
    ]),
    ''
  )
  // 17b) 但把脚本当证据（「证据 tools/verify-layout.mjs」）仍须红：收窄的是口径，不是漏洞
  assert.match(
    violationsOf([label, '已取得', '2026-11-07', '证据 tools/verify-layout.mjs → 打开核对计算样式']),
    /证据必须落在 docs\/verification\/assets\//
  )
  // 18) 合法的阻塞物可以写「人工确认」（不该被当成证据声称）
  assert.equal(
    violationsOf([
      label,
      '未取得',
      '需人工确认三档字体倍率与首屏耗时是否达标，缺真机复跑与对照截图',
      recheck
    ]),
    ''
  )
  // 18b) 但「已验」仍属声称
  assert.match(
    violationsOf([label, '未取得', '已验通过，需补齐三档字体倍率人工比对与首屏耗时复跑记录', recheck]),
    /却含证据声称/
  )
  // 19) 同一张图点亮五行 ⇒ 必须红（审查 R6 反例）
  const fiveAcquired = DEVICE_ROWS.map((rowLabel) => [
    rowLabel,
    '已取得',
    `2026-11-07 证据 ${realEvidence}`,
    recheck
  ])
  const dupViolations = deviceLedgerViolations(DEVICE_TABLE_HEADER, fiveAcquired, fakeRepoFile, fakeBytes)
  assert.ok(
    dupViolations.some((line) => line.includes('同一条证据不得同时点亮多个设备行')),
    `同一证据跨行复用必须被咬住：\n${dupViolations.join('\n')}`
  )
  // 20) 只有一行已取得、其余是合法欠账 ⇒ 零违规（逐行唯一性不是「永远红」）
  const oneAcquired = DEVICE_ROWS.map((rowLabel, index) =>
    index === 0
      ? [rowLabel, '已取得', `2026-11-07 证据 ${realEvidence}`, recheck]
      : [rowLabel, '未取得', blockedBy, recheck]
  )
  assert.deepEqual(deviceLedgerViolations(DEVICE_TABLE_HEADER, oneAcquired, fakeRepoFile, fakeBytes), [])
})

/**
 * 证据路径的**比较键**：只回答「两行写的是不是同一张图」，断言文案仍保留台账里的原始写法，
 * 便于按行定位。同一张图可以写成 `01-home.jpg` / `./01-home.jpg` / `/./01-home.jpg` /
 * `//01-home.jpg` / `01-HOME.jpg`，文件系统上是同一个文件；裸字符串比较会给每种写法各发一个
 * 键，于是「逐行唯一」让给了排版——五张图的台账用四种写法就能点亮五行。
 * · `\` → `/`：台账是人手写的，Windows 与 POSIX 分隔符混用（`join`/`existsSync` 两种都认）；
 * · `posix.normalize`：消掉 `./`、`/./`、`//`、`a/../a` 这类不改变目标的写法（`..` 逃逸另由
 *   `isRepoFileOnDisk` 拦，不靠这里）；
 * · `trim`：单元格两侧空白不该造出第二个键；
 * · `toLowerCase`：大小写不敏感文件系统上 `01-HOME.jpg` 与 `01-home.jpg` 是同一张图。代价是
 *   大小写敏感文件系统上两个仅大小写不同的文件会被判成同一条证据——本台账问的是「哪一行是
 *   哪张图」，只差大小写的两张图本身就说不清，宁可判红让人改写法，也不放它点亮两行。
 *
 * 追加在文件末尾：函数声明会提升，位置不影响调用，而既有行号一行不动（本文件被 docs/** 多处
 * 以纯路径文字引用，中段插行会让行号整体位移）。
 */
function normalizeEvidencePath(repoPath) {
  return posix.normalize(String(repoPath).replace(/\\/g, '/').trim()).toLowerCase()
}
